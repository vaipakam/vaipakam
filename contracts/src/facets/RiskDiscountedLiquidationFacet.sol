// src/facets/RiskDiscountedLiquidationFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {LibDelivery} from "../libraries/LibDelivery.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibLenderYieldFeeHost} from "../libraries/LibLenderYieldFeeHost.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {LibDiscountedLiquidation} from "../libraries/LibDiscountedLiquidation.sol";
import {LibInternalMatchPriority} from "../libraries/LibInternalMatchPriority.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {SwapToRepayIntentFacet} from "./SwapToRepayIntentFacet.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {ConsolidationFacet} from "./ConsolidationFacet.sol";

/**
 * @title RiskDiscountedLiquidationFacet
 * @author Vaipakam Developer Team
 * @notice The **discounted** HF liquidation route — the liquidator pays the
 *         whole debt and receives the collateral at a per-tier discount
 *         (`docs/DesignsAndPlans/FlashLoanLiquidationPath.md`). Sibling of
 *         {RiskFacet.triggerLiquidation} (single-route sale),
 *         {RiskFacet.triggerPartialLiquidation} (partial sale) and
 *         {RiskSplitLiquidationFacet.triggerLiquidationSplit} (split sale).
 * @dev    Part of the Diamond Standard (EIP-2535). Reentrancy-guarded,
 *         pausable. Carved out of {RiskFacet} as a structural move: RiskFacet
 *         sat about 350 bytes under the EIP-170 24,576-byte runtime limit,
 *         with queued changes that would push it over. The discounted route
 *         was already a self-contained entry point (its own pre-checks, its
 *         own settlement leg, its own event and errors), so it moved whole —
 *         behaviour, storage reads and writes, events and revert data are
 *         unchanged, and so is the selector (it is derived from the
 *         signature, not from the host facet).
 *
 *         What it shares with RiskFacet goes through the Diamond, exactly as
 *         before the move: the Health Factor is a self-call into
 *         {RiskFacet.calculateHealthFactor}, the eager consolidation a
 *         self-call into {ConsolidationFacet.eagerConsolidateBothSides}, and
 *         the lien decrement a self-call into
 *         {EncumbranceMutateFacet.decrementCollateralLien}. The figures (debt,
 *         seizure, tier discount) are the one rule in
 *         {LibDiscountedLiquidation}, which the preview reads too.
 *
 *         Refresh together with {RiskFacet}: the two were one contract, so a
 *         refresh of one alone leaves the other's routes on the other build.
 *         All facets share Diamond storage via {LibVaipakam}.
 */
contract RiskDiscountedLiquidationFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    // These three errors mirror {RiskFacet}'s declarations one-for-one (same
    // selectors), because the discounted route raises them as well as the
    // routes that stayed on RiskFacet. `NFTStatusUpdateFailed` is inherited
    // from {IVaipakamErrors}.
    /// @notice Loan isn't in a liquidatable state (must be `Active`).
    error InvalidLoan();
    /// @notice HF is at or above `1e18` — the loan is healthy, not liquidatable.
    error HealthFactorNotLow();
    /// @notice l2 sequencer is offline or still in its recovery grace window;
    ///         HF-based liquidation is blocked to avoid pricing on stale data.
    error SequencerUnhealthy();

    // ─── FlashLoanLiquidationPath.md — discount-path declarations ─────
    // Moved here from {RiskFacet} with the route (byte-identical, so the
    // event topic and the error selectors are unchanged); only this route
    // raises them.

    /// @notice Emitted at the end of every successful
    ///         {triggerLiquidationDiscounted} call. The keeper bot +
    ///         off-chain monitoring listen on this so a discount-path
    ///         settlement is publicly observable. The (tier, discountBps)
    ///         pair plus the (totalDebt, collateralSeized) pair fully
    ///         reconstruct the trade's oracle-priced economics. The
    ///         `borrowerSurplus` is collateral-asset units, NOT principal.
    /// @custom:event-category state-change/loan-mutation
    event LiquidationDiscounted(
        uint256 indexed loanId,
        address indexed liquidator,
        address indexed recipient,
        uint8 tier,
        uint16 discountBps,
        uint256 totalDebt,
        uint256 collateralSeized,
        uint256 borrowerSurplus
    );

    /// @notice The discount-path master kill-switch
    ///         (`ProtocolConfig.discountPathEnabled`) is `false`. A
    ///         fresh deploy ships this off; governance flips it on
    ///         per chain after audit sign-off. Independent of the
    ///         depth-tiered-LTV kill-switch.
    error DiscountPathDisabled();

    /// @notice The collateral recipient is the zero address. The
    ///         discount path must hand the seized collateral to a
    ///         non-zero address so a typo can't burn the funds.
    error ZeroRecipient();

    /// @notice The loan's collateral asset isn't tier-classified
    ///         (effective tier == 0 — neither the on-chain depth probe
    ///         nor the keeper-relayed tier qualifies it). The discount
    ///         math is per-tier; an unclassified collateral can't be
    ///         priced under this path. Use {RiskFacet.triggerLiquidation} for
    ///         Liquid-but-unclassified assets, or wait for time-based
    ///         default for Illiquid ones.
    error UntierableCollateral(address asset);

    /// @notice Oracle quorum unavailable for one or both legs at
    ///         settlement time — `LibFallback.collateralEquivalent`
    ///         reported the pair unpriced, meaning there is no price for
    ///         the principal or collateral asset. (A distrusted price
    ///         refuses by its own read's divergence error,
    ///         `OraclePriceDivergence` or `OracleCrossCheckDivergence`,
    ///         #666.) The discount math
    ///         requires both legs priced. The liquidator can retry
    ///         once the oracle clears, or fall back to
    ///         {RiskFacet.triggerLiquidation} which has its own oracle-stale
    ///         fallback to a claim-time settlement.
    error OracleStaleForDiscount(address principalAsset, address collateralAsset);

    /**
     * @notice Liquidator-buys-at-discount path — Phase 8 of
     *         `docs/DesignsAndPlans/FlashLoanLiquidationPath.md`.
     *         Optional, governance-gated alternative to the existing
     *         atomic-swap paths ({RiskFacet.triggerLiquidation},
     *         {RiskSplitLiquidationFacet.triggerLiquidationSplit}). The caller pays the full
     *         outstanding debt in the principal asset (typically funded
     *         via a same-tx flash-loan from Aave V3 or Balancer V2);
     *         the protocol seizes the borrower's collateral at a
     *         per-tier discount and delivers it to `recipient`. The
     *         liquidator sells the seized collateral on their own
     *         schedule (DEX of choice, MEV strategy of choice) to
     *         repay the flash-loan and capture the residual profit.
     *
     * @dev    Same pre-check shape as {RiskFacet.triggerLiquidation}:
     *         - Tier-1 sanctions gate on `msg.sender` — the seized
     *           collateral flows to `recipient` (not necessarily
     *           `msg.sender`) but the caller still authored the trade
     *           and value-receipt-by-sanctioned-relayer is blocked.
     *         - Master kill-switch (`discountPathEnabled`). Default
     *           false; flipped on per chain by ADMIN_ROLE /
     *           TimelockController after audit sign-off.
     *         - l2 sequencer circuit-breaker.
     *         - HF < 1e18.
     *
     *         Settlement math (oracle-priced, both legs required):
     *           `totalDebt   = currentBorrow + lateFee`
     *           `collForDebt = collateralEquivalent(totalDebt)`
     *           `collSeize   = collForDebt × (10000 + discountBps) / 10000`
     *           `collSeize   = min(collSeize, loan.collateralAmount)`
     *           `surplus     = loan.collateralAmount - collSeize`
     *
     *         If the loan is underwater (collForDebt × discount
     *         multiplier > collateralAmount) the seizure caps at the
     *         available collateral and the surplus is zero. The
     *         liquidator absorbs the loss on the under-coverage —
     *         which means rational liquidators won't call this path
     *         on underwater loans; the keeper bot falls back to
     *         {RiskFacet.triggerLiquidation} (atomic) in those cases.
     *
     *         Asset flow:
     *           - msg.sender → diamond: `totalDebt` principal-asset
     *             (must have pre-approved the diamond, OR funds just
     *             arrived via a flash-loan callback).
     *           - diamond → treasury: `splitTreasury(interestPortion)`
     *             cut — same treasury-on-interest split as the atomic
     *             path. NO `liquidationHandlingFee` (the discount IS
     *             the liquidator's payment; no protocol-side bonus
     *             needed).
     *           - diamond → lender vault: principal + remaining
     *             interest + late fee (full lender entitlement).
     *           - borrower vault → recipient: `collateralSeized`
     *             collateral-asset.
     *           - borrower vault keeps: `borrowerSurplus`
     *             collateral-asset (never withdrawn — already in their
     *             vault, available via standard vault withdrawal).
     *
     *         Loan transitions Active → Defaulted. VPFI LIF forfeits
     *         (HF liquidation is not a proper close).
     *         Interaction-rewards close marks the borrower as forfeit.
     *         Both NFTs flip to `LoanLiquidated`.
     *
     *         Tier resolution:
     *           `tier = OracleFacet.getEffectiveLiquidityTier(asset)`
     *           Requires `tier ∈ {1, 2, 3}` — Tier 0 (unclassified)
     *           reverts `UntierableCollateral`. For Liquid-but-
     *           unclassified assets the right tool is
     *           {RiskFacet.triggerLiquidation} (atomic swap); for Illiquid
     *           collateral the right tool is the time-based default
     *           path.
     *
     *         Why no liquidator-side KYC gate (vs the atomic path):
     *           the discount-path liquidator's payment IS receiving
     *           collateral, which carries chain-of-custody from the
     *           borrower — and on the principal-asset side they're
     *           SPENDING, not receiving. The atomic-path KYC gate
     *           specifically fires on the dynamic bonus's
     *           numeraire-value (a payment from the diamond to
     *           msg.sender); that doesn't exist here. The recipient
     *           is the liquidator's choice and the protocol's
     *           responsibility ends at `safeTransfer`.
     *
     * @param  loanId    The loan to liquidate. Must be `Active` with
     *                   `HF < 1e18`, collateral tier-classified.
     * @param  recipient Where the seized collateral lands. Usually
     *                   `msg.sender`; passing a different address
     *                   enables relay / MEV-bot patterns (bot calls
     *                   from a hot wallet, routes seizure elsewhere).
     *                   Must be non-zero.
     *
     *         Note on the third `bytes` parameter: reserved for a
     *         future post-seizure callback (named `extraData` in the
     *         design doc). Ignored in v1; callers using flash-loans
     *         should structure the unwind around the
     *         `triggerLiquidationDiscounted` call (e.g. inside their
     *         `executeOperation` flash-loan callback) rather than
     *         relying on a protocol-side callback.
     */
    function triggerLiquidationDiscounted(
        uint256 loanId,
        address recipient,
        bytes calldata /* extraData reserved for v2 */
    ) external nonReentrant whenNotPaused {
        // T-090 v1.1 (#389) §5.8 layer 2 — see `RiskFacet.triggerLiquidation`.
        // Inline storage pre-check so this entry point stays callable on
        // diamonds that haven't cut `SwapToRepayIntentFacet` (the
        // scenario suite + other diamond test harnesses that select
        // facets a la carte). When no v1.1 intent commit is live for
        // this loan, the cross-facet call is skipped entirely and we
        // proceed straight to the standard liquidation flow.
        if (LibVaipakam.storageSlot().intentCommits[loanId].orderHash != bytes32(0)) {
            SwapToRepayIntentFacet(address(this)).forceCancelIntentFor(
                loanId, SwapToRepayIntentFacet.ForceCancelReason.HFBelowLiquidationThreshold
            );
        }
        // Tier-1 sanctions gate — `msg.sender` authored the trade and
        // earns the discount-net-of-execution-cost profit.
        LibVaipakam._assertNotSanctioned(msg.sender);

        // Master kill-switch — discount path off by default.
        if (!LibVaipakam.cfgDiscountPathEnabled()) revert DiscountPathDisabled();

        // Recipient sanity — zero would burn the collateral.
        if (recipient == address(0)) revert ZeroRecipient();

        // #816 Tier-1 sanctions gate on the SEIZED-COLLATERAL recipient. The
        // discounted path delivers the bought collateral to `recipient` (a
        // caller-chosen address, not necessarily `msg.sender`), so screening
        // only the caller would let a clean liquidator route fresh value to a
        // flagged wallet. No fresh value may reach a sanctioned recipient.
        LibVaipakam._assertNotSanctioned(recipient);

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) revert InvalidLoan();
        s; // suppress unused-storage warning; the library reads it.
        // T-086 step 10 — see {RiskFacet.triggerLiquidation}'s sibling block.
        LibPrepayCleanup.clearActiveListing(loan, loanId);
        // #569 Codex #572 round-5 P2 — UNLIKE the full-seizure atomic
        // paths ({RiskFacet.triggerLiquidation}/{RiskSplitLiquidationFacet.triggerLiquidationSplit}, which
        // withdraw ALL collateral and so fully release here), the
        // discounted path seizes only `collateralSeized` and leaves
        // `borrowerSurplus` COLLATERAL in `loan.borrower`'s vault as a
        // `borrowerClaims` row. So the lien must NOT be fully released
        // here; it is decremented by exactly `collateralSeized` inside
        // `_settleDiscountedLiquidation` (just before the seizure
        // withdraw), leaving the surplus encumbered until
        // `ClaimFacet.claimAsBorrower` releases it atomically. A full
        // release here would let the stored borrower drain the surplus
        // (via `withdrawVPFIFromVault`) before a transferee claimant
        // claims it.

        // l2 circuit-breaker — same as atomic path. While the
        // sequencer is unhealthy, oracle reads may be stale and the
        // discount-priced seizure could mis-price.
        if (!OracleFacet(address(this)).sequencerHealthy()) {
            revert SequencerUnhealthy();
        }

        // HF gate — identical to atomic path. Discount-path doesn't
        // relax the threshold; it changes WHO bears swap risk, not
        // WHEN liquidation becomes available.
        uint256 hf = RiskFacet(address(this)).calculateHealthFactor(loanId);
        if (hf >= LibVaipakam.HF_SCALE) revert HealthFactorNotLow();

        // #2734 — the discounted route seizes collateral for an outside
        // liquidator, so it defers to an internal match inside the priority
        // window like every other external route. It does not auto-dispatch.
        LibInternalMatchPriority.requireOutside(loanId, loan);

        // #658 — discounted liquidation is a both-side close-out (lender debt +
        // borrower surplus); consolidate transferred sides to current holders
        // before settlement.
        _eagerConsolidateBothSides(loanId);

        // Resolve per-tier discount. `getEffectiveLiquidityTier`
        // returns 0 for unclassified assets — the discount math
        // requires a classified tier so we reject up-front. The
        // atomic-path is the alternative for Liquid-but-unclassified
        // assets; time-based default for Illiquid.
        // #2697 — one rule with the preview ({LibDiscountedLiquidation}).
        (uint8 tier, uint16 discountBps) =
            LibDiscountedLiquidation.discountFor(loan.collateralAsset);
        if (tier == 0) revert UntierableCollateral(loan.collateralAsset);

        _settleDiscountedLiquidation(loanId, loan, recipient, tier, discountBps);
    }

    /**
     * @dev Settlement leg of {triggerLiquidationDiscounted}, split out
     *      to keep the entry-point under the local-variable limit
     *      under viaIR. Computes debt, pulls principal from
     *      msg.sender, computes the per-tier seizure size, routes
     *      principal to lender + treasury, withdraws seized collateral
     *      to `recipient`, transitions the loan, and emits the
     *      terminal event. Reverts if oracle quorum is unavailable for
     *      either leg.
     */
    function _settleDiscountedLiquidation(
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address recipient,
        uint8 tier,
        uint16 discountBps
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // Debt — same shape as atomic path, by the rule the preview reads
        // ({LibDiscountedLiquidation.debt}, #2697).
        uint256 totalDebt = LibDiscountedLiquidation.debt(loan);
        uint256 interestPortion = totalDebt - loan.principal;
        // #1832 — terminal seam of the lifetime interest counter.
        LibMetricsHooks.onInterestPaid(loan, interestPortion);

        // Pull `totalDebt` of principal-asset from msg.sender. The
        // liquidator must have approved the diamond — either by
        // explicit `approve` before this call, or because they just
        // received the funds inside a flash-loan callback that wraps
        // this entry-point. `nonReentrant` on the outer entry-point
        // prevents a malicious-token transferFrom from re-entering the
        // discount path.
        // #2440 — the debt is forwarded to the lender at `totalDebt`, so it must
        // have arrived in full; a short arrival is refused by name rather than
        // made up from tokens the Diamond holds for others.
        LibDelivery.pullExact(loan.principalAsset, msg.sender, address(this), totalDebt);

        // Seizure at oracle-priced debt-plus-discount value, by the rule the
        // preview reads ({LibDiscountedLiquidation.seizure}, #2697). A missing
        // price is reported as unpriced (no revert on stale) so this fails
        // with a precise `OracleStaleForDiscount` rather than a generic
        // oracle-feed error; a distrusted price reverts with its read's own
        // divergence error inside it (#666). Availability is its `priced`
        // flag, never a zero result (#1281 item 027).
        (bool priced, uint256 collateralSeized) =
            LibDiscountedLiquidation.seizure(loan, totalDebt, discountBps);
        if (!priced) {
            revert OracleStaleForDiscount(loan.principalAsset, loan.collateralAsset);
        }
        uint256 borrowerSurplus = loan.collateralAmount - collateralSeized;

        // Treasury cut on the interest portion of the debt — identical
        // share as the atomic path. NO handling fee — the discount IS
        // the liquidator's compensation, paid in collateral, not a
        // separate principal-asset bonus.
        (uint256 treasuryInterestFee, ) = LibEntitlement.splitTreasury(loan, interestPortion);
        // #1383 — same rule as the atomic path. Separately gated entry, easy to
        // miss because it sits beside the ordinary one.
        (, treasuryInterestFee) = LibLenderYieldFeeHost.resolve(
            loanId,
            LibERC721.ownerOf(loan.lenderTokenId),
            interestPortion,
            treasuryInterestFee
        );
        uint256 lenderProceeds = totalDebt - treasuryInterestFee;

        // #2440 — measured, accrued as it arrived (TreasuryFeeFacet).
        LibFacet.transferToTreasury(loan.principalAsset, treasuryInterestFee);

        // Lender's proceeds to their vault. #821 — vault-lock for a flagged lender.
        // #2440 — the claim names what the vault received.
        lenderProceeds = LibSanctionedLock.depositLocked(
            s, loan.lender, loanId, loan.principalAsset, lenderProceeds
        );
        // #998 S10 (#1006 / #1132) — both holders' fail-closed markers are
        // recorded centrally at the `Defaulted` transition (terminalize).

        // Record lender claim metadata for NFT-state tracking.
        s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.principalAsset,
            amount: lenderProceeds,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });
        // #592 — reserve VPFI lender proceeds against the unstake path until
        // the current holder claims; ClaimFacet releases. No-op for non-VPFI.
        if (loan.principalAsset == s.vpfiToken) {
            LibEncumbrance.encumberLenderProceeds(
                loanId, loan.lender, loan.principalAsset, lenderProceeds
            );
        }

        // #569 Codex #572 round-5 P2 — decrement the lien by exactly
        // `collateralSeized` (what leaves the vault for the liquidator).
        // The full lien was retained through `triggerLiquidationDiscounted`
        // (the early full release was removed); this decrement clears the
        // guard for the seizure withdraw below while leaving
        // `borrowerSurplus` encumbered. The surplus stays liened in
        // `loan.borrower`'s vault until `ClaimFacet.claimAsBorrower`
        // releases it atomically with the claim withdrawal — closing the
        // transferred-position drain. No-op when `collateralSeized == 0`
        // (the full collateral becomes the surplus claim).
        _decrementCollateralLien(loanId, collateralSeized);

        // Withdraw `collateralSeized` from borrower vault directly to
        // `recipient`. The remaining `borrowerSurplus` stays ENCUMBERED
        // in the borrower's vault and is retrieved by the current
        // borrower-position NFT holder via `ClaimFacet.claimAsBorrower`
        // (which releases the residual lien atomically with the payout).
        if (collateralSeized > 0) {
            // #821 (Codex #832 r3 P1) — move-out-exempt so a borrower flagged
            // after init doesn't brick the discounted liquidation; the seized
            // collateral is pushed OUT to the already-screened `recipient`.
            LibSanctionedLock.vaultWithdrawERC20MoveOut(
                LibVaipakam.storageSlot(),
                loan.borrower,
                loan.collateralAsset,
                recipient,
                collateralSeized
            );
        }
        // Record borrower claim metadata — the surplus is in COLLATERAL
        // units (not principal), sits ENCUMBERED in the borrower's vault,
        // and is withdrawn by the borrower-position NFT holder through
        // `claimAsBorrower`. `claimed` is set true when the surplus is
        // zero (nothing to claim).
        s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.collateralAsset,
            amount: borrowerSurplus,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: borrowerSurplus == 0
        });
        // #998 S10 (#1006 / #1132) — the surplus stays ENCUMBERED in the borrower's
        // own vault (no fresh park) but is claim-gated. Both holders' fail-closed
        // frozen-claimant markers are recorded centrally at the `Defaulted`
        // transition below (via `EncumbranceMutateFacet.terminalize`).

        // Lifecycle: Active → Defaulted. Same terminal as atomic-path
        // liquidations.
        // #1132 (S10 central enforcement) — route through the
        // `EncumbranceMutateFacet.terminalize` host so the validated Active→Defaulted
        // transition AND both holders' fail-closed frozen-claimant markers land
        // in one place (the standalone registers above were folded here).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.terminalize.selector,
                loanId,
                LibVaipakam.LoanStatus.Active,
                LibVaipakam.LoanStatus.Defaulted
            ),
            bytes4(0)
        );

        // Interaction-rewards close — borrower forfeits, lender does
        // not (`borrowerClean=false, lenderForfeit=false`), identical
        // to the atomic path's HF-liquidation terminal.
        LibInteractionRewards.closeLoan(loanId, false, false);

        // NFT status flips — burns happen in {ClaimFacet} after
        // claims settle. Mirrors atomic-path terminal.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.lenderTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanLiquidated
            ),
            NFTStatusUpdateFailed.selector
        );
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.borrowerTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanLiquidated
            ),
            NFTStatusUpdateFailed.selector
        );

        emit LiquidationDiscounted(
            loanId,
            msg.sender,
            recipient,
            tier,
            discountBps,
            totalDebt,
            collateralSeized,
            borrowerSurplus
        );
    }

    /// @dev #658 — the eager consolidation of both sides to their current
    ///      holders, through the one cross-facet host
    ///      ({ConsolidationFacet.eagerConsolidateBothSides}, Tier2
    ///      skip-not-block, internal-only). Twin of
    ///      `RiskFacet._eagerConsolidateBothSides`: an encoder only, the rule
    ///      lives in the host. `bytes4(0)` bubbles a genuine move revert raw.
    function _eagerConsolidateBothSides(uint256 loanId) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                ConsolidationFacet.eagerConsolidateBothSides.selector,
                loanId
            ),
            bytes4(0)
        );
    }

    /// @dev #569 — lower the loan's collateral lien by `consumed`, through
    ///      the one cross-facet host
    ///      ({EncumbranceMutateFacet.decrementCollateralLien}). Twin of
    ///      `RiskFacet._decrementLienAtPartialLiq`: an encoder only, the rule
    ///      lives in {LibEncumbrance.decrementCollateralLien}. Its own frame
    ///      keeps the encoding off the settlement leg's stack.
    function _decrementCollateralLien(uint256 loanId, uint256 consumed) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.decrementCollateralLien.selector,
                loanId,
                consumed
            ),
            bytes4(0)
        );
    }
}
