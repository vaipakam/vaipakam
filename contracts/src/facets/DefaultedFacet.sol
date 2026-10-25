// src/facets/DefaultedFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLoanClock} from "../libraries/LibLoanClock.sol";
import {LibConsolidation} from "../libraries/LibConsolidation.sol";
import {SwapToRepayIntentFacet} from "./SwapToRepayIntentFacet.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibLenderYieldFeeHost} from "../libraries/LibLenderYieldFeeHost.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {ProfileFacet} from "./ProfileFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "./RiskMatchLiquidationFacet.sol";
import {ConsolidationFacet} from "./ConsolidationFacet.sol";
import {FallbackCustodyFacet} from "./FallbackCustodyFacet.sol";
import {ForcedSaleFacet} from "./ForcedSaleFacet.sol";
import {NumeraireValueFacet} from "./NumeraireValueFacet.sol";
import {LibSwap} from "../libraries/LibSwap.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {LibDefaultRoute} from "../libraries/LibDefaultRoute.sol";

/**
 * @title DefaultedFacet
 * @author Vaipakam Developer Team
 * @notice Time-based loan default (grace period expired) for the Vaipakam
 *         P2P lending platform.
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded, pausable.
 *      Separated from HF-based liquidation ({RiskFacet.triggerLiquidation}).
 *
 *      {triggerDefault} is permissionless — any caller may invoke it once the
 *      loan is past `endTime + gracePeriod(durationDays)`. Asset-handling
 *      branches:
 *        - **Liquid ERC-20 collateral**: the one forced-sale rule on
 *          {ForcedSaleFacet} (#2796) sells only the collateral the debt
 *          needs (slippage ≤ the liquidation cap) and leaves the rest and
 *          the extra proceeds to the borrower's claim; when every route
 *          fails it falls back to {FallbackCustodyFacet.enterFallback}
 *          (claim-time retry in ClaimFacet, also through
 *          {FallbackCustodyFacet}).
 *          High-volatility check (#1192): only a genuine LTV > 110% value
 *          collapse routes directly to the full-collateral in-kind branch;
 *          an HF < 1 loan whose collateral still covers the debt (LTV ≤ 110%)
 *          goes through the swap/split waterfall so the lender is capped at
 *          their entitlement and the borrower keeps the recoverable surplus.
 *        - **Illiquid ERC-20**: full collateral transfer to lender (both
 *          parties already consented at offer time).
 *        - **NFT rental**: remaining prepay to lender (minus treasury fee),
 *          buffer to treasury, renter reset to address(0).
 *        - **NFT/ERC-1155 collateral**: direct NFT transfer to lender.
 *
 *      Refresh together (#2796): {ForcedSaleFacet}, RiskFacet,
 *      RiskSplitLiquidationFacet, DefaultedFacet and RepayPeriodicFacet — the
 *      liquid sale is a self-call into {ForcedSaleFacet.sellToNeed}.
 *
 *      Refresh together (#1566 slice 2): {FallbackCustodyFacet}, RiskFacet,
 *      DefaultedFacet, ClaimFacet, AddCollateralFacet, RepayFacet and
 *      RiskMatchLiquidationFacet. The swap-failure fallback entry is a
 *      self-call into {FallbackCustodyFacet.enterFallback}; refreshing this
 *      facet without cutting that one leaves the selector unrouted, and
 *      every swap-failure default reverts `FunctionDoesNotExist`.
 */
contract DefaultedFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {

    /// @notice Emitted when a time-based default's swap-path fallback fires
    ///         and the loan transitions `Active → FallbackPending`. Distinct
    ///         from {LoanDefaulted} (terminal): the loan is still curable
    ///         via {RepayFacet.repayLoan} or
    ///         {AddCollateralFacet.addCollateral} until the lender claims.
    /// @dev    Mutates `s.loans[loanId].status` to `FallbackPending` via
    ///         {FallbackCustodyFacet.enterFallback} → {EncumbranceMutateFacet.terminalize}.
    ///         Emit-site MUST match the storage transition one-to-one
    ///         (EventSourcingAudit §1.5 rule 1).
    /// @param loanId The fallback-pending loan ID.
    /// @param lender Lender address (indexed for filterable subscriptions).
    /// @param riskAndTermsConsentFromBoth Mirrors {Loan.riskAndTermsConsentFromBoth}
    ///        — informational, not a routing signal.
    /// @param newStatus Post-transition `LoanStatus` (always
    ///        `FallbackPending` for this event); included so cache-merge
    ///        consumers can update the row directly from the payload.
    /// @custom:event-category state-change/loan-mutation
    event LoanFallbackPending(
        uint256 indexed loanId,
        address indexed lender,
        bool riskAndTermsConsentFromBoth,
        LibVaipakam.LoanStatus newStatus
    );

    /// @notice Emitted when a loan reaches the terminal `Defaulted` status.
    /// @dev    Mutates `s.loans[loanId].status` to `Defaulted`. Sibling
    ///         {LoanFallbackPending} captures the swap-failure path's
    ///         intermediate `FallbackPending` transition; this event is
    ///         strictly the terminal `→ Defaulted` flip.
    /// @param loanId The ID of the defaulted loan.
    /// @param riskAndTermsConsentFromBoth Mirrors {Loan.riskAndTermsConsentFromBoth}
    ///        latched at initiation — the combined abnormal-market +
    ///        illiquid-assets fallback consent from both counterparties
    ///        (docs/WebsiteReadme.md §"Offer and acceptance risk warnings",
    ///        README.md §"Liquidity & Asset Classification"). Since the
    ///        docs mandate this consent on every offer create/accept, the
    ///        flag is informational only — it records what was acknowledged,
    ///        not the settlement route. The actual liquid-vs-fallback routing
    ///        is decided by live liquidity/collapse state and swap success,
    ///        not by this flag; a liquid-collateral loan with flag=true will
    ///        still DEX-liquidate when conditions allow.
    /// @param newStatus Post-transition `LoanStatus` (always `Defaulted`
    ///        for this event).
    /// @custom:event-category state-change/loan-mutation
    event LoanDefaulted(
        uint256 indexed loanId,
        bool riskAndTermsConsentFromBoth,
        LibVaipakam.LoanStatus newStatus
    );

    /// @notice Emitted when a liquidation is triggered for liquid collateral.
    /// @dev    Mutates `s.loans[loanId].status` to `Defaulted` (downstream
    ///         of the swap-success path). Treated as a `loan-mutation` for
    ///         the cache-merge contract — the row's terminal label flips
    ///         from `Active` to `LoanLiquidated` on the NFT side.
    /// @param loanId The ID of the liquidated loan.
    /// @param proceeds The amount recovered from liquidation.
    /// @param treasuryFee The treasury fee deducted (if any).
    /// @custom:event-category state-change/loan-mutation
    event LoanLiquidated(
        uint256 indexed loanId,
        uint256 proceeds,
        uint256 treasuryFee
    );

    // Facet-specific errors (shared errors inherited from IVaipakamErrors)
    error NotDefaultedYet();
    /// @notice l2 sequencer is offline or still in its 1h recovery grace
    ///         window; default processing is blocked so the caller can
    ///         retry once prices are trustworthy again.
    error SequencerUnhealthy();

    // MAX_LIQUIDATION_SLIPPAGE_BPS consolidated in LibVaipakam

    // #1566 S2a: the three fallback-entry events below are emitted by
    // {FallbackCustodyFacet.enterFallback}, which re-declares them with
    // byte-identical signatures (same topic hashes). They stay declared here
    // so this facet's ABI, and every consumer decoding against it, keeps them.
    /// @notice Emitted alongside {LoanFallbackPending} when a time-based
    ///         default falls back to full-collateral disposition because
    ///         the DEX swap reverted or exceeded the 6% slippage ceiling
    ///         (README §7).
    /// @dev    Informational — the storage transition is captured by
    ///         {LoanFallbackPending}; lender + collateral amount are
    ///         recoverable from `s.loans[loanId].lender` and
    ///         `s.fallbackSnapshot[loanId]` respectively.
    ///         EventSourcingAudit §1.4 + §1.5 — primary-key-only payload.
    /// @param loanId The defaulted loan ID.
    /// @custom:event-category informational/liquidation
    event LiquidationFallback(uint256 indexed loanId);

    /// @notice Emitted when the time-based default fallback ran without
    ///         an oracle-quorum price — neither leg of the collateral /
    ///         principal pair had a fresh Phase-7b 2-of-N reading
    ///         available. The fallback degenerates to "full collateral
    ///         to lender claim, treasury + borrower zero". Mirrors the
    ///         same-named event on {RiskFacet}; downstream indexers can
    ///         distinguish "oracle worked, lender claim exceeded
    ///         collateral" from "oracle quorum stale" via this signal.
    /// @dev    Phase 2 of AutonomousLtvAndOracleFallback.md design — the
    ///         pre-Phase-2 behaviour reverted the whole default action
    ///         when oracle was stale; the new path lets a stale oracle
    ///         pair settle the loan (lender absorbs) rather than pinning
    ///         it in Active state.
    /// @custom:event-category informational/liquidation
    event LiquidationFallbackOracleUnavailable(uint256 indexed loanId);

    /// @notice Emitted alongside {LiquidationFallback} with the README §7
    ///         three-way split.
    /// @dev    Informational — the lender / treasury / borrower allocation
    ///         is stored verbatim in `s.fallbackSnapshot[loanId]`.
    ///         EventSourcingAudit §1.4 + §1.5 — primary-key-only payload.
    /// @param loanId The defaulted loan ID.
    /// @custom:event-category informational/liquidation
    event LiquidationFallbackSplit(uint256 indexed loanId);

    /**
     * @notice Triggers default for a loan past grace period (permissionless).
     * @dev If liquid collateral: sells only the collateral the debt needs
     *      through the shared forced-sale rule ({ForcedSaleFacet.sellToNeed},
     *      #2796); the unsold collateral and the extra proceeds wait for the
     *      borrower's claim.
     *      If illiquid (or its value collapsed): transfers full collateral to lender.
     *      Enhanced for NFTs: Transfers prepay (amount * durationDays) to lender, buffer (5%) to treasury from borrower vault.
     *      Revokes this rental's renter via vaultSetRentalUser(loanId, address(0), 0).
     *      Updates loan to Defaulted, burns NFTs.
     *      Emits LoanDefaulted.
     * @param loanId The loan ID to default.
     * @param sellAmount The collateral amount the try-list's quotes were built
     *        for, read only on the liquid sale route. Must lie between
     *        `previewForcedSale(loanId, TimeBasedDefault)`'s `sell` and
     *        `maxSell` at the settling block, else the call reverts
     *        `ForcedSaleQuoteOutOfRange` and nothing moves (quote again).
     * @param adapterCalls Keeper-ranked swap try-list for the liquid sale route.
     */
    function triggerDefault(
        uint256 loanId,
        uint256 sellAmount,
        LibSwap.AdapterCall[] calldata adapterCalls
    ) external whenNotPaused nonReentrant {
        // T-090 v1.1 (#389) §5.8 — if a v1.1 intent commit is live
        // AND the loan is past `endTime + gracePeriod`, force-cancel
        // it (return collateral + clear state + emit
        // `SwapToRepayIntentForceCancelled(TimeDefaultDue)`) then
        // proceed with the default flow. Pre-grace commits keep
        // their window — `IntentPending` revert (Codex round-5 P1 #8).
        if (LibVaipakam.storageSlot().intentCommits[loanId].orderHash != bytes32(0)) {
            SwapToRepayIntentFacet(address(this)).forceCancelIntentIfPastDefaultOrRevert(loanId);
        }
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert InvalidLoanStatus();

        // T-086 step 10 — default-flow lock-bypass. If a prepay-
        // listing is live on this loan, clear it FIRST so the
        // borrower-position NFT is unlocked + the diamond / vault /
        // executor bookkeeping is consistent before this facet
        // starts moving collateral. Idempotent no-op when no
        // listing is live. See design doc §5.4 — without this,
        // the strict `LibERC721._lock` overwrite-protection
        // (step 6 round 2) would block any subsequent flow that
        // needs to re-lock the same token, and stale orderHash
        // bindings on the executor / vault would let a previously-
        // signed Seaport order continue to be (futilely) submitted.
        s; // suppress unused-storage warning; the library reads it.
        LibPrepayCleanup.clearActiveListing(loan, loanId);

        // Tiered KYC check on loan value for the lender. Both branches
        // (ERC20 loan / NFT rental) value the same way — we only differ in
        // which asset + amount to value. #2419 — through the one shared rule
        // ({NumeraireValueFacet.getLiquidNumeraireValue}, rounded down).
        // Illiquid assets have no oracle feed, so valued at 0 per README — KYC always passes.
        {
            address valueAsset;
            uint256 valueAmount;
            if (loan.assetType == LibVaipakam.AssetType.ERC20) {
                valueAsset = loan.principalAsset;
                valueAmount = loan.principal;
            } else {
                // NFT rental: principalAsset is the NFT contract; price the prepay.
                valueAsset = loan.prepayAsset;
                valueAmount = loan.prepayAmount;
            }

            uint256 valueNumeraire = NumeraireValueFacet(address(this))
                .getLiquidNumeraireValue(valueAsset, valueAmount);
            if (
                valueNumeraire != 0 &&
                !ProfileFacet(address(this)).meetsKYCRequirement(loan.lender, valueNumeraire)
            ) {
                revert KYCRequired();
            }
            // Illiquid asset: valued at 0, KYC always passes.
        }

        uint256 endTime = LibLoanClock.maturity(loan);
        uint256 graceEnd = endTime + LibVaipakam.gracePeriod(loan.durationDays);
        if (block.timestamp <= graceEnd) revert NotDefaultedYet();

        // l2 circuit breaker: block the default trigger entirely while the
        // sequencer is down or in its 1h recovery grace window. Chainlink
        // prices and AMM pools are unreliable under those conditions,
        // so a DEX swap would cross heavy slippage. Sequencer outages are
        // typically short — the caller can simply retry once it recovers,
        // which is safer than locking the loan into an irreversible full-
        // collateral-transfer fallback based on a transient state.
        if (!OracleFacet(address(this)).sequencerHealthy()) {
            revert SequencerUnhealthy();
        }

        // #594 — time-based default is a BOTH-SIDE close-out: liquidation
        // proceeds / illiquid-collateral transfers route to the stored borrower
        // AND lender anchors. Consolidate each side whose NFT may have moved so
        // a position that reaches default before any consolidating event routes
        // to the current holders. Tier-2 (skip-not-block; a sanctioned holder
        // can't block the close-out). Placed here — after the prepay-listing
        // teardown (so the borrower side isn't `_isExcludedLive`-skipped; Codex
        // #659 r2) and AFTER the lender-KYC gate above (Codex #659 r3: an
        // un-KYC'd transferee must NOT brick a permissionless default — the KYC
        // gate evaluates the original `loan.lender`, and receipt is gated later
        // at claim), but BEFORE the internal-match dispatch + every settlement
        // branch below, which all pay/return to the consolidated anchors.
        LibConsolidation.consolidateToHolder(loanId, false, LibConsolidation.Ctx.Tier2CloseOut);
        LibConsolidation.consolidateToHolder(loanId, true, LibConsolidation.Ctx.Tier2CloseOut);

        // EC-003 Phase 3 — internal-match auto-dispatch. Before falling
        // through to the external-aggregator swap path below, check
        // whether an opposing-direction internal-match candidate exists.
        // If yes, settle at oracle price (no DEX slippage), pay the 1%
        // matcher bonus to `msg.sender`, and return. Time-based defaults
        // are the same as HF-based: any caller who triggers default
        // when an internal match exists is the de-facto matcher and
        // earns the same incentive.
        if (RiskMatchLiquidationFacet(address(this)).attemptInternalMatchAutoDispatch(loanId, msg.sender)) {
            return;
        }

        // #569 §4.4 / #2796 — the collateral lien is released only on the
        // routes that move the WHOLE collateral (the unpriced fallback, the
        // in-kind transfer, an NFT rental), each just before its move. The
        // liquid sale route keeps it live: the forced-sale host lowers it by
        // exactly what it sells, so the collateral the sale leaves stays
        // protected in the borrower's vault until their claim. An internal
        // match above owned its own lien adjustment (Codex #571 P1: an early
        // release would strand a partial match's residual unprotected).

        // Terminal NFT status for this default — README §7: "Loan Defaulted" or
        // "Loan Liquidated". Each branch below sets the appropriate label.
        LibVaipakam.LoanPositionStatus terminalStatus =
            LibVaipakam.LoanPositionStatus.LoanDefaulted;

        if (loan.assetType == LibVaipakam.AssetType.ERC20) {
            // Execution routing (README §1) — #2796: the route is decided by
            // the one rule {LibDefaultRoute.erc20Route}, which
            // `ForcedSaleFacet.previewForcedSale` reads too, so the published
            // sale plan exists exactly when this default sells. In short:
            //  - #2419: what the loan WAS at origination decides first. Only a
            //    loan liquid on both legs at origination can sell, and its
            //    PAIR must be priced (the sale floor values both legs). When a
            //    leg has no usable price the default skips the LTV read and
            //    the swap and enters the fallback directly, exactly as a
            //    failed swap would: a sale with no oracle floor is not
            //    attempted, the default still completes (lender first), and
            //    the fallback's unpriced split gives the lender the
            //    collateral while the loan stays curable. A DISTRUSTED price
            //    reverts the whole default instead (#666: refuse and retry
            //    once the feeds agree).
            //  - #1192 (Pass-2 C1): a priced pair on collateral the live check
            //    still finds liquid sells, and moves in kind only on a genuine
            //    LTV>110% value collapse, never on plain HF<1, so an
            //    HF<1-but-covered loan keeps the borrower's recoverable
            //    surplus (spec §774/§790/§1373).
            //  - A loan consented as illiquid (or whose collateral the live
            //    check finds illiquid) moves in kind when both parties
            //    consented, and is refused otherwise.
            LibDefaultRoute.Route route = LibDefaultRoute.erc20Route(loan);

            if (route == LibDefaultRoute.Route.UnpricedFallback) {
                // #2419 — see the route note above: no price, no sale. The
                // whole collateral goes to the Diamond (#821: move-out exempt,
                // so a borrower flagged after init never bricks the default;
                // #2440: the loan's collateral becomes what arrived) and the
                // loan enters the fallback exactly as a failed swap would.
                _releaseLienAtDefault(loanId);
                loan.collateralAmount = LibSanctionedLock.pullToDiamond(
                    s,
                    loan.borrower,
                    loan.collateralAsset,
                    loan.collateralAmount
                );
                _enterFallback(loanId);
                emit LoanFallbackPending(
                    loanId,
                    loan.lender,
                    loan.riskAndTermsConsentFromBoth,
                    loan.status
                );
                return;
            }

            if (route == LibDefaultRoute.Route.Sale) {
                // Time-based default with liquid collateral: sell without an
                // HF check — the README treats non-repayment after grace as a
                // separate default trigger regardless of collateral health.
                //
                // #2796 — the forced-sale host sells only what the debt needs
                // (the least collateral whose proceeds at the slippage cap
                // cover the debt plus the largest charges, at the keeper's
                // quoted `sellAmount`), and divides the proceeds: keeper bonus
                // (the same curve as the HF paths, L-h #1010), the lender's
                // debt in full, the 2% handling fee on the debt subordinated
                // to the lender, and the rest held for the borrower beside
                // the collateral the sale did not take.
                //
                // Sanctions posture — this is a Tier-2 close-out: the TRIGGER
                // stays permissionless and never reverts on a sanctioned
                // caller (README sanctions policy), but the host withholds
                // the bonus from one (it stays in the waterfall). The bonus
                // is intentionally NOT KYC-gated: KYC is off on retail and
                // this Tier-2 path must not add a gating revert.
                //
                // #1005 (S9) — an empty or all-disabled try-list reverts
                // `NoEnabledSwapRoute` inside the host, so a permissionless
                // caller can't push an eligible loan into the fallback with
                // zero DEX attempts. When every route fails the host returns
                // with the whole collateral on the Diamond and the loan
                // enters the fallback.
                if (!_sellToNeed(loanId, sellAmount, adapterCalls)) {
                    _enterFallback(loanId);
                    // §3.8 — FallbackCustodyFacet.enterFallback transitioned the
                    // loan to FallbackPending; emit the matching state-change
                    // event (NOT LoanDefaulted — the loan is still curable).
                    emit LoanFallbackPending(
                        loanId,
                        loan.lender,
                        loan.riskAndTermsConsentFromBoth,
                        loan.status
                    );
                    return;
                }
                // Liquid-collateral DEX liquidation succeeded → "Loan Liquidated".
                terminalStatus = LibVaipakam.LoanPositionStatus.LoanLiquidated;
            } else if (route == LibDefaultRoute.Route.InKind) {
                // Illiquid or value collapsed: Move collateral from borrower's vault to lender's vault
                // so ClaimFacet.claimAsLender can withdraw from lender's vault consistently.
                // The whole collateral moves, so the lien goes first (it
                // would otherwise block the vault withdrawal below).
                _releaseLienAtDefault(loanId);
                // #821 — vault-lock the in-kind collateral into a flagged stored
                // lender's vault rather than bricking the default. #832 r7 P3 —
                // report the real parked payload in the lock event: ERC-1155
                // carries its amount in `collateralQuantity` (`collateralAmount`
                // is structurally zero for non-ERC-20 collateral), so pass the
                // quantity for ERC-1155 to keep the reconciliation trail accurate.
                address lenderVault = LibSanctionedLock.getOrCreateVaultLocked(
                    s,
                    loan.lender,
                    loanId,
                    loan.collateralAsset,
                    loan.collateralAssetType == LibVaipakam.AssetType.ERC1155
                        ? loan.collateralQuantity
                        : loan.collateralAmount
                );
                // #998 S10 (#1006 / #1132) — both holders' fail-closed markers are
                // recorded centrally at the `Defaulted` transition (terminalizeFromAny).

                // #821 (Codex #832 r2 P1) — the in-kind move WITHDRAWS the
                // collateral from the borrower's vault, which resolves through the
                // Tier-1-gated `getOrCreateUserVault`. Arm the from-side move-out
                // exemption so a borrower flagged after init doesn't brick the
                // default (the collateral is pushed OUT to the lender's vault).
                LibSanctionedLock.beginMoveOut(s, loan.borrower);
                if (loan.collateralAssetType == LibVaipakam.AssetType.ERC20) {
                    // #2440 — vault to vault, and a forced close-out acts on
                    // what arrived: the lender's vault is credited with, and
                    // the lender's claim below names, what it received. The
                    // loan's collateral becomes that figure (one transfer, so
                    // a token that charges on transfer charges once).
                    loan.collateralAmount = LibFacet.vaultWithdrawDelivered(
                        loan.borrower,
                        loan.collateralAsset,
                        lenderVault,
                        loan.collateralAmount,
                        VaultWithdrawFailed.selector
                    );
                    // T-051 — the credit to the lender's vault ticks the
                    // protocolTrackedVaultBalance counter.
                    LibVaipakam.recordVaultDeposit(loan.lender, loan.collateralAsset, loan.collateralAmount);
                } else if (loan.collateralAssetType == LibVaipakam.AssetType.ERC721) {
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            VaultFactoryFacet.vaultWithdrawERC721.selector,
                            loan.borrower,
                            loan.collateralAsset,
                            loan.collateralTokenId,
                            lenderVault
                        ),
                        VaultWithdrawFailed.selector
                    );
                } else if (loan.collateralAssetType == LibVaipakam.AssetType.ERC1155) {
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            VaultFactoryFacet.vaultWithdrawERC1155.selector,
                            loan.borrower,
                            loan.collateralAsset,
                            loan.collateralTokenId,
                            loan.collateralQuantity,
                            lenderVault
                        ),
                        VaultWithdrawFailed.selector
                    );
                }
                LibSanctionedLock.endMoveOut(s);

                // Record collateral claim for the lender
                s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
                    asset: loan.collateralAsset,
                    amount: loan.collateralAmount,
                    assetType: loan.collateralAssetType,
                    tokenId: loan.collateralTokenId,
                    quantity: loan.collateralQuantity,
                    claimed: false
                });
                // #592 (ReservationV2 §4.1) — in-kind/illiquid default: the
                // lender claim asset is the COLLATERAL, not the principal. VPFI
                // is collateral-eligible, so when the (ERC-20) collateral that
                // just landed in the stored lender's vault IS VPFI, reserve it
                // against the unstake path — keyed on the collateral asset, the
                // same asset ClaimFacet releases on (`claim.asset`). NFT
                // collateral can't be VPFI and has no fungible unstake door.
                if (
                    loan.collateralAssetType == LibVaipakam.AssetType.ERC20 &&
                    loan.collateralAsset == s.vpfiToken
                ) {
                    LibEncumbrance.encumberLenderProceeds(
                        loanId, loan.lender, loan.collateralAsset, loan.collateralAmount
                    );
                }

                // Any heldForLender from prior preclose top-ups are handled by
                // ClaimFacet.claimAsLender, which withdraws them in the correct
                // payment asset via the NFT-gated claim model.
                // No borrower claim on default (lender takes full collateral)

                // #1566 S2c: the VPFI re-stamp of the borrower after the
                // in-kind transfer. The sale route's host re-stamps after its
                // own movements, and the fallback entry after its own. See
                // {_restampCollateralVpfi}.
                _restampCollateralVpfi(loanId);
            } else {
                revert LiquidationFailed();
            }
        }

        // NFT-specific handling (if lendingAsset is NFT)
        if (loan.assetType != LibVaipakam.AssetType.ERC20) {
            // An NFT rental carries no collateral lien (D-1); the release is
            // the idempotent no-op it always was here, kept so every whole-
            // collateral route releases before it moves anything.
            _releaseLienAtDefault(loanId);
            // Reset renter
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultSetRentalUser.selector,
                    loan.id,
                    address(0),
                    0
                ),
                NFTRenterUpdateFailed.selector
            );

            // NFT stays in vault — returned to lender via ClaimFacet.claimAsLender
            // (NFT-gated: lender must own the Vaipakam position NFT to claim).

            // #821 (Codex #832 r3 P1) — both prepay withdrawals below pull from
            // the borrower's vault on the NFT-rental default. Arm the move-out
            // exemption so a borrower flagged after init doesn't brick the default
            // (the prepay is pushed OUT to the already-screened treasury / lender).
            LibSanctionedLock.beginMoveOut(s, loan.borrower);
            // Buffer to treasury immediately (no claim needed for treasury).
            // #2440 — through the one treasury fee leg, so the forfeited buffer
            // is accrued as it arrived like every other treasury inflow (it
            // was sent unaccrued before, which on a Diamond-as-treasury
            // deployment left it outside `treasuryBalances`).
            LibFacet.vaultFeeToTreasury(loan.borrower, loan.prepayAsset, loan.bufferAmount);

            // Lender's prepay share: rental fees minus treasury fee (buffer already sent to treasury)
            (uint256 treasuryFee, uint256 prepayToLender) = LibEntitlement.splitTreasury(
                loan,
                loan.prepayAmount
            );
            // #1383 — the rental prepay leg of the SAME entry point. A rental
            // can never carry the paid Full stamp (the tariff rides an ERC-20
            // origination's LIF and a rental pays none), so `d_tariff` is always
            // zero here — but the consent-gated HOLD discount is independent of
            // Full and does apply, exactly as it does on the landed
            // preclose-rental legs. Unlike the ERC-20 leg above, `prepayToLender`
            // is returned by `splitTreasury` rather than derived as a residual,
            // so BOTH terms have to be folded in.
            {
                (uint256 rentLenderExtra, uint256 rentNewTreasury) =
                    LibLenderYieldFeeHost.resolve(
                        loanId,
                        LibERC721.ownerOf(loan.lenderTokenId),
                        loan.prepayAmount,
                        treasuryFee
                    );
                prepayToLender += rentLenderExtra;
                treasuryFee = rentNewTreasury;
            }

            // Withdraw full prepay from borrower vault. #2440 — a forced
            // close-out acts on what arrived: a short delivery comes out of the
            // treasury fee first and the lender's share only after (lender
            // first), and is never made up from the Diamond's other balance.
            {
                uint256 shortfall = loan.prepayAmount - LibFacet.vaultWithdrawDelivered(
                    loan.borrower,
                    loan.prepayAsset,
                    address(this),
                    loan.prepayAmount,
                    VaultWithdrawFailed.selector
                );
                if (shortfall > treasuryFee) {
                    prepayToLender -= shortfall - treasuryFee;
                    treasuryFee = 0;
                } else {
                    treasuryFee -= shortfall;
                }
            }
            LibSanctionedLock.endMoveOut(s);

            // Treasury fee from rental portion
            // #2440 — measured, accrued as it arrived (TreasuryFeeFacet).
            LibFacet.transferToTreasury(loan.prepayAsset, treasuryFee);

            // Lender gets remainder. #821 — vault-lock for a flagged stored lender
            // (T-051 — the Diamond-side transfer ticks protocolTrackedVaultBalance).
            // #2440 — the claim names what the vault received.
            prepayToLender = LibSanctionedLock.depositLocked(
                s, loan.lender, loanId, loan.prepayAsset, prepayToLender
            );
            // #998 S10 (#1006 / #1132) — both holders' fail-closed markers are
            // recorded centrally at the `Defaulted` transition (terminalizeFromAny).

            // Record lender's claimable prepay fees. heldForLender handled by ClaimFacet.
            s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
                asset: loan.prepayAsset,
                amount: prepayToLender,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                claimed: false
            });
            // No borrower claim on NFT rental default
        }

        if (loan.status != LibVaipakam.LoanStatus.Defaulted) {
            // Either Active (direct default of illiquid loan) or
            // FallbackPending (retry succeeded) transitions here.
            // #1132 (S10 central enforcement) — route through the
            // `EncumbranceMutateFacet.terminalizeFromAny` host so the validated
            // transition AND both holders' fail-closed frozen-claimant markers
            // are recorded in one place (the per-branch standalone registers
            // above were folded into this call).
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EncumbranceMutateFacet.terminalizeFromAny.selector,
                    loanId,
                    LibVaipakam.LoanStatus.Defaulted
                ),
                bytes4(0)
            );
            // #407 PR 4 (T-407-B, 2026-06-12) — collateral lien release
            // moved to the START of `triggerDefault` (line ~207) so
            // the {VaultFactoryFacet.vaultWithdrawERC20} guard clears
            // for every mid-flow withdraw. See the explanatory
            // comment at the new call site.

            // Phase 5 / §5.2b — default is NOT a proper close, so the
            // borrower forfeits any up-front VPFI paid for the LIF. The
            // Diamond flushes the full held amount to treasury; no
            // rebate is credited. No-op on loans that paid LIF in the
            // lending asset (vpfiHeld == 0).
            LibVPFIDiscount.forfeitBorrowerLif(loan);

            // Terminal NFT status ("Loan Defaulted" or "Loan Liquidated" per README §7).
            // Burns happen in ClaimFacet after the lender/borrower claims.
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaipakamNFTFacet.updateNFTStatus.selector,
                    loan.lenderTokenId,
                    loanId,
                    terminalStatus
                ),
                NFTStatusUpdateFailed.selector
            );
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaipakamNFTFacet.updateNFTStatus.selector,
                    loan.borrowerTokenId,
                    loanId,
                    terminalStatus
                ),
                NFTStatusUpdateFailed.selector
            );

            // Default → borrower loses interaction rewards, lender keeps hers.
            LibInteractionRewards.closeLoan(loanId, /* borrowerClean */ false, /* lenderForfeit */ false);
        }
        emit LoanDefaulted(loanId, loan.riskAndTermsConsentFromBoth, loan.status);
    }

    /**
     * @notice View function to check if a loan is defaultable (past grace period).
     * @dev Enhanced: For off-chain monitoring or UI.
     * @param loanId The loan ID.
     * @return isDefaultable True if past grace period.
     */
    function isLoanDefaultable(
        uint256 loanId
    ) external view returns (bool isDefaultable) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) return false;

        uint256 endTime = LibLoanClock.maturity(loan);
        uint256 graceEnd = endTime + LibVaipakam.gracePeriod(loan.durationDays);
        return block.timestamp > graceEnd;
    }

    /// @dev #1566 S2a: the swap failed, so enter FallbackPending through the
    ///      one fallback-custody host, {FallbackCustodyFacet.enterFallback}.
    ///      It replaced this facet's `_fullCollateralTransferFallback`, whose
    ///      code was identical to RiskFacet's copy. The entry reads no caller
    ///      context (only `loanId`, storage and the Diamond's own address),
    ///      so the self-call is behaviour-identical; its non-empty revert
    ///      bytes bubble verbatim (an empty one surfaces as `bytes4(0)`). A
    ///      private helper so the call's encoding stays out of
    ///      `triggerDefault`'s near-ceiling viaIR frame.
    function _enterFallback(uint256 loanId) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                FallbackCustodyFacet.enterFallback.selector,
                loanId
            ),
            bytes4(0)
        );
    }

    /// @dev #1566 S2c (finding S1-11 of the slices 2-3 review). Both ERC-20
    ///      collateral routes of `triggerDefault` (the liquid swap and the
    ///      in-kind transfer to the lender) move the collateral OUT of
    ///      `loan.borrower`'s vault, and the vault withdraw primitive never
    ///      touches the VPFI fee tier. When the collateral is VPFI, the
    ///      borrower's cached tier and staking checkpoint would keep counting
    ///      VPFI that has left the vault until some unrelated later mutation
    ///      corrected it: the terminal tier sync that follows restamps only a
    ///      vault owner whose exclusion CHANGED, and on an ordinary default
    ///      nothing changes. So re-stamp at the post-withdrawal balance, once,
    ///      after the branch (the rule: every protocol action that moves VPFI
    ///      through a vault refreshes that user's tier at the post-movement
    ///      balance). If the terminal sync later does install an exclusion,
    ///      it restamps that owner itself, so this stamp is never the stale one.
    ///
    ///      Broadcast-FREE on purpose: `triggerDefault` is a permissionless
    ///      Tier-2 close-out that must not brick, and the broadcasting restamp
    ///      can revert on the cross-chain tier-push budget. The mirror-chain
    ///      tier catches up at the borrower's next broadcasting mutation, the
    ///      same contract `vaultCreditFromDiamondERC20` documents. RiskFacet's
    ///      post-withdraw restamp still broadcasts; that inconsistency is a
    ///      recorded open item (FunctionalSpecs/_CodeVsDocsAudit.md), left
    ///      alone here.
    ///
    ///      The swap-failure fallback never reaches this point: it returns
    ///      early, and {FallbackCustodyFacet} restamps on its own custody
    ///      moves. A non-VPFI collateral (NFTs included) is a no-op. Private,
    ///      reading storage itself, so `triggerDefault`'s near-ceiling viaIR
    ///      frame gains no locals.
    function _restampCollateralVpfi(uint256 loanId) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.collateralAsset != s.vpfiToken) return;
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                ConsolidationFacet.restampUserVpfiLocalInternal.selector,
                loan.borrower
            ),
            bytes4(0)
        );
    }

    /// @dev #2796 — the liquid time-based default's sale, sized to need, on
    ///      the one forced-sale host ({ForcedSaleFacet.sellToNeed}). Its own
    ///      frame keeps the outcome decode off `triggerDefault`'s stack, which
    ///      sits near solc's ceiling.
    /// @return sold False when every route failed: the whole collateral is
    ///         on the Diamond with the lien released, for the fallback entry.
    function _sellToNeed(
        uint256 loanId,
        uint256 sellAmount,
        LibSwap.AdapterCall[] calldata adapterCalls
    ) private returns (bool sold) {
        ForcedSaleFacet.ForcedSaleOutcome memory out = abi.decode(
            LibFacet.crossFacetCallReturn(
                abi.encodeCall(
                    ForcedSaleFacet.sellToNeed,
                    (
                        loanId,
                        ForcedSaleFacet.ForcedSaleKind.TimeBasedDefault,
                        sellAmount,
                        adapterCalls,
                        new LibSwap.SplitCall[](0),
                        msg.sender
                    )
                ),
                bytes4(0)
            ),
            (ForcedSaleFacet.ForcedSaleOutcome)
        );
        return out.sold;
    }

    /// @dev #407 PR 4 (T-407-B, 2026-06-12) — extracted from
    ///      `triggerDefault` so the lien-release lives in its own
    ///      scope. The inline call form (`LibEncumbrance.releaseCollateralLien(loanId)`
    ///      directly inside `triggerDefault`) tripped viaIR's
    ///      "Variable size 1 too deep" — `triggerDefault` already sits
    ///      near solc's stack ceiling (KYC value block + adapterCalls
    ///      calldata + swap math locals). Wrapping the release in a
    ///      private function gives it a fresh stack frame that
    ///      doesn't compete with the caller's locals.
    function _releaseLienAtDefault(uint256 loanId) private {
        // #998 S10 (fresh-round) — routed through the EXISTING releaseCollateralLien
        // host (no new selector) to reclaim EIP-170 headroom: the Class B storage +
        // LibEncumbrance additions this session tipped this edge facet over the
        // limit, and hosting this substantial lib call is the cheapest reclaim.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.releaseCollateralLien.selector,
                loanId
            ),
            bytes4(0)
        );
    }
}
