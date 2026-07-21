// src/facets/SwapToRepayFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibConsolidation} from "../libraries/LibConsolidation.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibSettlement} from "../libraries/LibSettlement.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibPeriodicInterest} from "../libraries/LibPeriodicInterest.sol";
import {LibSwap} from "../libraries/LibSwap.sol";
import {LibFallback} from "../libraries/LibFallback.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {VPFIDiscountFacet} from "./VPFIDiscountFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title SwapToRepayFacet
 * @author Vaipakam Developer Team
 * @notice T-090 — Borrower-initiated swap-to-repay surface. Lets the
 *         borrower swap their collateral asset into the loan's principal
 *         asset and apply the proceeds to settlement in a single
 *         transaction, instead of the 4-step withdraw → external swap →
 *         re-deposit → repay flow.
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded,
 *      pausable. ERC20-on-ERC20 loans only in v1; NFT collateral has no
 *      swap path at repay time today (T-086's prepay-listing surface is
 *      gated to the pre-grace window).
 *
 *      Two entry points:
 *        {swapToRepayFull}    — close-out via swap. Respects
 *                               `loan.useFullTermInterest`.
 *        {swapToRepayPartial} — partial principal reduction via swap,
 *                               gated on `loan.allowsPartialRepay`.
 *
 *      Slippage cap: `cfgMaxSwapToRepaySlippageBps()` (default 300 bps =
 *      3% — tighter than the liquidation cap because the borrower picks
 *      the moment and can wait for better price action).
 *
 *      Auth: both entry points require `LibAuth.requireBorrower(loan)` —
 *      no third-party "swap-on-behalf-of". The borrower's collateral is
 *      at risk during the swap; consent must be the borrower's own.
 *      Third parties can still use `RepayFacet.repayLoan` to repay on
 *      the borrower's behalf with their own principal asset.
 *
 *      Surplus principal (when a tight quote delivers more than the
 *      loan requires) routes to the borrower's vault — they took the
 *      slippage risk, they get the symmetric upside.
 *
 *      Total swap failure (every adapter reverted) reverts the whole
 *      tx — no soft-fallback in v1. Borrower can retry with better
 *      routing.
 *
 *      Yield-fee VPFI discount (§F2 / #1354): honored on BOTH entry points
 *      via the `VPFIDiscountFacet.resolveLenderYieldFeeFor` host (#1383) —
 *      `swapToRepayFull` keys it on the consolidated `loan.lender`,
 *      `swapToRepayPartial` on the current lender-NFT holder. Dark until the
 *      M2 `feeEntitlementEnabled` cut-over.
 */
contract SwapToRepayFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    using SafeERC20 for IERC20;

    /// @notice Emitted on a successful full swap-to-repay close-out.
    /// @param loanId The loan being settled.
    /// @param borrower The borrower (== msg.sender — caller authority).
    /// @param collateralIn The collateral consumed by the swap.
    /// @param principalOut The principal asset received from the swap.
    /// @param adapterUsed The `LibSwap` adapter index that succeeded.
    /// @custom:event-category state-change/loan-mutation
    event SwapToRepayExecuted(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 collateralIn,
        uint256 principalOut,
        uint256 adapterUsed
    );

    /// @notice Emitted on a successful partial swap-to-repay (principal
    ///         reduced; loan continues in Active).
    /// @param loanId The loan being partially repaid.
    /// @param borrower The borrower (== msg.sender).
    /// @param collateralIn The collateral consumed by the swap.
    /// @param principalOut The principal asset received from the swap.
    /// @param partialPrincipal The principal amount retired.
    /// @param adapterUsed The `LibSwap` adapter index that succeeded.
    /// @custom:event-category state-change/loan-mutation
    event SwapToRepayPartialExecuted(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 collateralIn,
        uint256 principalOut,
        uint256 partialPrincipal,
        uint256 adapterUsed
    );

    /// @notice Mirror of `RepayFacet.RepayPartialPeriodAdvanced` so the
    ///         T-034 periodic-interest checkpoint-advance signal is
    ///         observable on the swap-to-repay path too. Identical
    ///         topic hash — indexers subscribing by topic catch both.
    ///         (Codex round-1 PR #390 P2 #2.)
    /// @custom:event-category state-change/loan-mutation
    event RepayPartialPeriodAdvanced(
        uint256 indexed loanId,
        uint256 periodEndAt,
        uint256 expected,
        address indexed advancedBy
    );

    /// @notice Mirror of `RepayFacet.PeriodicInterestSettled`. Topic
    ///         match — see {RepayPartialPeriodAdvanced}.
    ///         (Codex round-1 PR #390 P2 #2.)
    /// @custom:event-category state-change/loan-mutation
    event PeriodicInterestSettled(
        uint256 indexed loanId,
        uint256 periodEndAt,
        uint256 expected,
        uint256 paidByBorrower,
        address indexed settler
    );

    /// @notice Pre-flight check failed: the slippage floor would not
    ///         cover the loan's required principal payoff. Borrower
    ///         must raise `maxCollateralIn` or wait for better price
    ///         action.
    /// @notice #1383 — the lender yield-fee resolve host cross-facet call
    ///         reverted (should be unreachable; the host is a diamond-internal
    ///         resolve + optional VPFI vault debit).
    error LenderYieldFeeResolveFailed();

    error SwapBoundsInsufficient();

    /// @notice `LibSwap.swapWithFailover` returned `(success=false)` —
    ///         every adapter in the caller's try-list reverted.
    error SwapAllAdaptersFailed();

    /// @notice The loan isn't ERC20-on-ERC20 — NFT collateral / NFT
    ///         rental / illiquid-asset loans are out of scope for the
    ///         swap-to-repay surface in v1.
    error UnsupportedLoanShape();

    /// @notice Partial swap-to-repay proceeds would retire the full
    ///         loan principal. To avoid leaving an Active zero-principal
    ///         loan, the borrower must use `swapToRepayFull` instead —
    ///         which carries the close-out side-effects (Repaid status,
    ///         position-NFT lifecycle, reward close).
    error PartialWouldRetireFullPrincipal();

    /// @notice Repayment attempted past the loan's grace period —
    ///         beyond that point only `DefaultedFacet` can resolve.
    ///         Mirrored from `RepayFacet`.
    error RepaymentPastGracePeriod();

    /// @notice The offer was not opted into partial repay at creation;
    ///         the partial swap-to-repay path requires the lender's
    ///         pre-consent via `Offer.allowsPartialRepay`. Mirrored
    ///         from `RepayFacet`.
    error PartialRepayNotAllowed();

    /// @notice Partial swap-to-repay proceeds resolved to less than
    ///         the asset-level `minPartialBps` floor (`loan.principal *
    ///         minPartialBps / BASIS_POINTS`). Mirrored from `RepayFacet`.
    error InsufficientPartialAmount();

    /// @notice Pass-2 A2 (#1190, Codex #1229) — reverted when a swap-to-repay
    ///         partial would LOWER the loan's health factor. Unlike a direct
    ///         partial (collateral untouched → HF always improves), a swap sells
    ///         collateral AND repays principal, so a bad swap CAN worsen HF —
    ///         this monotonicity guard (replacing the old inverted 1.5 admission
    ///         floor) is the meaningful protection here, alongside the LTV cap.
    error PartialSwapWorsensHealthFactor(uint256 hfBefore, uint256 hfAfter);

    /// @notice Full swap-to-repay: swap the borrower's collateral asset
    ///         for the loan's principal asset and close the loan in
    ///         one transaction.
    /// @dev    Only `Active` loans (FallbackPending cure intentionally
    ///         out-of-scope in v1 to keep the slippage surface narrow).
    ///         ERC20-on-ERC20 loans only.
    ///
    ///         Slippage floor computed from
    ///         `LibFallback.expectedSwapOutput` × (BPS - cap) / BPS and
    ///         passed to `LibSwap` as `minOutput`. The settlement-debt
    ///         requirement is a SEPARATE post-swap assertion — passing
    ///         `requiredPrincipal` to LibSwap directly would let a
    ///         too-generous `maxCollateralIn` get consumed at arbitrarily
    ///         bad pricing (Codex round-1 P1 #1).
    ///
    ///         Lender / treasury / borrower distribution mirrors
    ///         `RepayFacet.repayLoan` for diamond-held proceeds:
    ///         direct `safeTransfer` to each destination + matching
    ///         `recordVaultDeposit` / `recordTreasuryAccrual` —
    ///         NOT `vaultDepositERC20From` (would need a self-allowance
    ///         the diamond never sets; Codex round-1 P1 #3).
    ///
    /// @param loanId           The loan to settle.
    /// @param adapterCalls     Keeper-ranked 4-DEX try-list
    ///                          (`LibSwap.AdapterCall[]`).
    /// @param maxCollateralIn  Upper bound on collateral the caller
    ///                          permits the diamond to withdraw + swap.
    ///                          Must be ≤ `loan.collateralAmount`.
    function swapToRepayFull(
        uint256 loanId,
        LibSwap.AdapterCall[] calldata adapterCalls,
        uint256 maxCollateralIn
    ) external nonReentrant whenNotPaused {
        // T-090 v1.1 (#389) §5.8 — borrower can't run the v1 atomic
        // close path while their v1.1 intent commit is live; the
        // intent surface already pulled the collateral into custody.
        LibVaipakam.assertNoLiveIntentCommit(loanId);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // ── Pre-flight gates ─────────────────────────────────────────
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert InvalidLoanStatus();
        // Codex round-1 PR #390 P2 #4 — both PRINCIPAL and COLLATERAL
        // must be ERC20. The v0 design checked `loan.assetType` (which
        // is the principal asset type) but not `collateralAssetType` —
        // letting an ERC20-loan with NFT collateral through the gate
        // would have proceeded into ERC20 metadata calls + ERC20
        // vault withdraw against the NFT contract, with unpredictable
        // downstream reverts.
        if (
            loan.assetType != LibVaipakam.AssetType.ERC20 ||
            loan.collateralAssetType != LibVaipakam.AssetType.ERC20
        ) revert UnsupportedLoanShape();
        if (
            loan.collateralLiquidity != LibVaipakam.LiquidityStatus.Liquid ||
            loan.principalLiquidity != LibVaipakam.LiquidityStatus.Liquid
        ) revert UnsupportedLoanShape();
        // Codex round-1 PR #390 P1 #3 — borrower NFT ownership (not the
        // latched `loan.borrower` field) is the authority root. Claim
        // rights travel with the position NFT, so the current NFT
        // holder must be the only caller able to spend pledged collateral.
        LibAuth.requireBorrowerNftOwner(loan);

        // Block lender-side self-repay (mirrors RepayFacet:273-278).
        if (msg.sender == loan.lender) revert LenderCannotRepayOwnLoan();
        if (
            IERC721(address(this)).ownerOf(loan.lenderTokenId) == msg.sender
        ) revert LenderCannotRepayOwnLoan();

        if (maxCollateralIn == 0 || maxCollateralIn > loan.collateralAmount)
            revert InvalidAmount();

        uint256 endTime = loan.startTime + loan.durationDays * LibVaipakam.ONE_DAY;
        uint256 graceEnd = endTime + LibVaipakam.gracePeriod(loan.durationDays);
        if (block.timestamp > graceEnd) revert RepaymentPastGracePeriod();

        // #658 PR-B — swap-to-repay-full is a both-side close-out: it pays the
        // lender and returns the borrower surplus. Consolidate each transferred
        // side to its current NFT holder while the loan is still Active (the
        // primitive no-ops on a terminal loan), so the collateral lien, reward
        // entry, and VPFI fee-tier checkpoint follow the holder before the swap
        // withdrawal + payouts route below — mirroring the liquidation family
        // (RiskFacet) and RepayFacet. Tier2 skip-not-block: a sanctioned/excluded
        // holder must never brick a close-out. (The borrower surplus is already
        // routed to `ownerOf(borrowerTokenId)` and lender proceeds reserved via
        // #592; this adds the POSITION consolidation those don't cover.)
        LibConsolidation.consolidateToHolder(
            loanId, false, LibConsolidation.Ctx.Tier2CloseOut
        );
        LibConsolidation.consolidateToHolder(
            loanId, true, LibConsolidation.Ctx.Tier2CloseOut
        );

        // ── Build the settlement plan + required-principal target ────
        uint256 lateFee = LibVaipakam.calculateLateFee(loanId, endTime);
        LibSettlement.ERC20Settlement memory plan = LibSettlement.computeRepayment(
            loan,
            lateFee,
            block.timestamp
        );
        uint256 requiredPrincipal = plan.lenderDue + plan.treasuryShare;

        // ── Slippage floor pre-flight (Codex round-1 P1 #1) ──────────
        // Pass the slippage-floor to LibSwap, not requiredPrincipal —
        // the latter would let any maxCollateralIn slip through at
        // arbitrarily bad pricing as long as the debt closed.
        uint256 expectedProceeds = LibFallback.expectedSwapOutput(
            address(this),
            loan.collateralAsset,
            loan.principalAsset,
            maxCollateralIn
        );
        uint256 minPrincipalOut = (expectedProceeds *
            (LibVaipakam.BASIS_POINTS - LibVaipakam.cfgMaxSwapToRepaySlippageBps())) /
            LibVaipakam.BASIS_POINTS;
        if (minPrincipalOut < requiredPrincipal) revert SwapBoundsInsufficient();

        // ── Withdraw collateral to diamond + execute swap ────────────
        // Codex round-3 P1 #2 — aggregator adapters can partial-fill
        // and return UNSPENT input to `msg.sender` (the diamond).
        // Snapshot the collateral balance before to compute actual
        // consumption after, refunding any residual to the current
        // borrower-NFT holder's vault. Treating maxCollateralIn as
        // fully consumed would leave dust stuck on the diamond.
        uint256 collateralBalanceBefore =
            IERC20(loan.collateralAsset).balanceOf(address(this));

        // #569 Codex #572 round-4 P2 — DECREMENT the lien by exactly
        // the collateral being withdrawn for the swap (`maxCollateralIn`),
        // rather than fully releasing it. That clears the chokepoint
        // guard for this withdraw while keeping the never-withdrawn
        // residual (`collateralAmount - maxCollateralIn`) liened. The
        // partial-fill leftover refunded back to the vault below is
        // re-liened, so the borrower's `unconsumedCollateral` stays
        // protected until `ClaimFacet.claimAsBorrower` releases it
        // atomically with the claim withdrawal. A full release here
        // would expose that residual to a `withdrawVPFIFromVault` drain
        // by the stored borrower between this terminal and the claim
        // (when the borrower-position NFT has been transferred to a
        // different claimant). `maxCollateralIn <= collateralAmount`
        // (the withdraw below would revert otherwise), so the decrement
        // can't underflow the lien. Safe under revert: a downstream
        // revert rolls back the storage write.
        _callEncumb2(
            EncumbranceMutateFacet.decrementCollateralLien.selector,
            loanId,
            maxCollateralIn
        );
        // #954 (§1.2) — pull the collateral OUT of loan.borrower's vault behind
        // the from-side move-out exemption so a borrower flagged AFTER init (and
        // holding their own position NFT, so consolidation Skipped) doesn't
        // brick this must-complete Tier-2 close-out when `getOrCreateUserVault`
        // screens the vault owner. Custody is LEAVING loan.borrower (to the
        // Diamond for the swap). The window is NARROW — closed inside the
        // helper BEFORE `swapWithFailover` runs, so the receive-side exemption
        // is never open across the untrusted adapter call (Codex #986 r3).
        LibSanctionedLock.vaultWithdrawERC20MoveOut(
            s,
            loan.borrower,
            loan.collateralAsset,
            address(this),
            maxCollateralIn
        );

        (bool success, uint256 outputAmount, uint256 adapterUsed) = LibSwap.swapWithFailover(
            loanId,
            loan.collateralAsset,
            loan.principalAsset,
            maxCollateralIn,
            minPrincipalOut,
            address(this),
            adapterCalls
        );
        if (!success) revert SwapAllAdaptersFailed();
        // Slippage floor cleared the loan; the debt-cover bound is a
        // separate post-swap assertion (Codex round-1 P2 #2).
        if (outputAmount < requiredPrincipal) revert InsufficientProceeds();

        // Refund partial-fill leftover collateral (Codex round-3 P1 #2).
        uint256 actualCollateralConsumed = maxCollateralIn -
            (IERC20(loan.collateralAsset).balanceOf(address(this)) -
                collateralBalanceBefore);

        // ── Lender Yield Fee discount (§F2 / #1354 / #1383) ──────────
        // Key on the CURRENT lender-NFT holder, not `loan.lender`. The lender
        // consolidation above is a `Tier2CloseOut` skip-NOT-block: a sanctioned
        // holder (or the #597 `heldForLender` exclusion) leaves `loan.lender`
        // stale, so keying on it could resolve the discount — and any VPFI vault
        // debit — for the wrong party (Codex #1387 P1). `ownerOf(lenderTokenId)`
        // is the canonical current holder (the loan is pre-terminal here, so the
        // lender NFT is live). The sum `lenderDue + treasuryShare` is invariant
        // under the shift, so `requiredPrincipal` (above) and the borrower
        // surplus (below) are unchanged.
        {
            (uint256 lenderExtra, uint256 newTreasury) = _resolveLenderYieldFee(
                loanId,
                IERC721(address(this)).ownerOf(loan.lenderTokenId),
                plan.interest + plan.lateFee,
                plan.treasuryShare
            );
            if (lenderExtra > 0) {
                plan.lenderShare += lenderExtra;
                plan.lenderDue = plan.principal + plan.lenderShare;
                plan.treasuryShare = newTreasury;
            }
        }

        // ── Settlement waterfall — diamond-held proceeds pattern
        //    (Codex round-1 P1 #3 — mirrors RiskFacet:702-712) ────────
        address treasury = LibFacet.getTreasury();
        if (plan.treasuryShare > 0) {
            IERC20(loan.principalAsset).safeTransfer(treasury, plan.treasuryShare);
            LibFacet.recordTreasuryAccrual(loan.principalAsset, plan.treasuryShare);
        }

        // #954 (§1.1) — deposit the lender proceeds behind the receive-side
        // sanctions exemption (so a lender flagged after init doesn't brick the
        // close-out), write the lender claim row, reserve the proceeds against
        // the stored lender's spend paths for EVERY ERC20, and tier-exclude a
        // transferred-and-sanctioned holder's VPFI. Routed through
        // `EncumbranceMutateFacet` (which calls the shared `LibCloseoutFreeze`)
        // via crossFacetCall so this facet stays under EIP-170 after the #959
        // merge — the Fusion intent path inlines the same helper directly.
        _callEncumb2(
            EncumbranceMutateFacet.freezeLenderProceeds.selector,
            loanId,
            plan.lenderDue
        );

        // Surplus principal → CURRENT borrower-position NFT holder's
        // EOA directly (Codex round-4 P1 #2). Routing to the vault
        // with `recordVaultDeposit` leaves the surplus unclaimable:
        // `ClaimFacet.claimAsBorrower` releases ONLY the collateral
        // asset recorded in `borrowerClaims[loanId]` (the principal
        // asset is a different asset), and `vaultWithdrawERC20` is
        // `onlyDiamondInternal`. Direct EOA transfer is the only
        // path the holder can actually realize the surplus on.
        // Resolved via `ownerOf(borrowerTokenId)` so the surplus
        // follows the NFT, not the stale `loan.borrower` field
        // (Codex round-2 P1 #1).
        uint256 surplusPrincipal = outputAmount - requiredPrincipal;
        address currentBorrowerHolder = IERC721(address(this))
            .ownerOf(loan.borrowerTokenId);
        // #954 (§2.1) — swap-to-repay is a Tier-2 close-out that MUST complete,
        // so the surplus is never a blocking revert. A clean holder is paid
        // directly; a SANCTIONED holder's surplus is frozen into loan.borrower's
        // vault (records a `borrowerSurplusClaims` row, reserves it against the
        // stored borrower's signed-offer spend for EVERY ERC20, and tier-excludes
        // a transferred holder's VPFI). Routed through `EncumbranceMutateFacet`
        // (shared `LibCloseoutFreeze`) for the EIP-170 reason noted above.
        _callFreezeSurplus(loanId, currentBorrowerHolder, surplusPrincipal);

        // ── Claim slots ──────────────────────────────────────────────
        // The lender claim row + lender-proceeds reservation are written inside
        // `freezeLenderProceeds` above (§1.1), so no separate write here.

        // Codex round-1 P1 #2 — record the residual pledged collateral
        // (never withdrawn from the borrower vault) + the partial-
        // fill residual the aggregator returned to the diamond
        // (Codex round-3 P1 #2). The borrower keeps everything that
        // wasn't actually consumed by the swap.
        // #569 Codex #572 round-4 P2 — `ClaimFacet.claimAsBorrower` now
        // releases the lien on this residual atomically with the claim
        // withdrawal (no longer at the Repaid transition).
        // Codex round-2 P1 #2 — `claimed: false` regardless of amount
        // so `settleBorrowerLifProper` below can credit
        // `borrowerLifRebate` for later claim.
        uint256 unconsumedCollateral = loan.collateralAmount - actualCollateralConsumed;
        // Push the partial-fill leftover (= maxCollateralIn -
        // actualCollateralConsumed) back into the borrower vault
        // immediately. The "never withdrawn" portion (loan.collateralAmount
        // - maxCollateralIn) is already in the vault; the diamond holds
        // the unspent input from the swap, so refund it now.
        uint256 partialFillRefund = maxCollateralIn - actualCollateralConsumed;
        if (partialFillRefund > 0) {
            // #954 (§1.2) — resolving loan.borrower's vault to return their OWN
            // residual collateral must not brick when the borrower was flagged
            // after init. Its OWN narrow move-out window — separate from the
            // pre-swap collateral pull, never spanning the untrusted swap
            // (Codex #986 r3). This returns the borrower's residual (no locked-
            // share semantics), so the move-out exemption — which emits no
            // `SanctionedProceedsLocked` — is the right one.
            LibSanctionedLock.beginMoveOut(s, loan.borrower);
            IERC20(loan.collateralAsset).safeTransfer(
                LibFacet.getOrCreateVault(loan.borrower),
                partialFillRefund
            );
            LibSanctionedLock.endMoveOut(s);
            LibVaipakam.recordVaultDeposit(
                loan.borrower,
                loan.collateralAsset,
                partialFillRefund
            );
            // #569 Codex #572 round-4 P2 — RE-LIEN the refunded leftover.
            // It was decremented out of the lien before the swap-withdraw
            // above; now that it's back in the borrower's vault as part
            // of `unconsumedCollateral`, it must be re-encumbered so the
            // whole residual stays protected until the claim. Net lien
            // after this = `(collateralAmount - maxCollateralIn) +
            // partialFillRefund` = `unconsumedCollateral`.
            _callEncumb2(
                EncumbranceMutateFacet.incrementCollateralLien.selector,
                loanId,
                partialFillRefund
            );
        }
        // #658 PR-B — re-stamp the holder's VPFI tier/staking after the net
        // collateral movement above (the consumed slice left the holder's vault;
        // the unconsumed residual was re-liened back). No-op for non-VPFI
        // collateral. Mirrors the swapToRepayPartial restamp + the liquidation
        // family.
        if (loan.collateralAsset == s.vpfiToken) {
            LibConsolidation.restampUserVpfi(loan.borrower);
        }
        s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.collateralAsset,
            amount: unconsumedCollateral,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });
        // #998 S10 (#1006 / #1132) — the residual collateral claim is claim-gated
        // (`claimAsBorrower`). Both holders' fail-closed frozen-claimant markers
        // are recorded centrally at the `Repaid` transition below (via
        // `EncumbranceMutateFacet.terminalize`), which covers the borrower side for the
        // residual collateral case whether or not a sanctioned principal surplus
        // was present. The `freezeOrPayBorrowerSurplus` self-register (above) and
        // this central register are idempotent + first-write-wins.

        // ── Position-NFT status flip → LoanRepaid ────────────────────
        // Codex round-1 PR #390 P2 #3 — without this, marketplaces +
        // dashboards reading the NFT metadata keep showing the loan
        // as active during the claim window. Mirror RepayFacet:516-535.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.borrowerTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            NFTStatusUpdateFailed.selector
        );
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.lenderTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            NFTStatusUpdateFailed.selector
        );

        // ── Active prepay listing cleanup ────────────────────────────
        // Codex round-1 PR #390 P2 #1 — atomically revoke the vault's
        // ERC-1271 binding for any live prepay listing on this loan,
        // release the borrower-position-NFT lock, and clear the
        // diamond / executor / vault bookkeeping. Idempotent on loans
        // without a live listing. Placement mirrors RepayFacet:550:
        // after every safeTransfer has committed, before the status
        // flip declares the listing dead.
        LibPrepayCleanup.clearActiveListing(loan, loanId);

        // ── Transition + LIF VPFI settlement ─────────────────────────
        // #1132 (S10 central enforcement) — route through the
        // `EncumbranceMutateFacet.terminalize` host so the validated Active→Repaid
        // transition AND both holders' fail-closed frozen-claimant markers land
        // in one place (the standalone borrower register above was folded here).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.terminalize.selector,
                loanId,
                LibVaipakam.LoanStatus.Active,
                LibVaipakam.LoanStatus.Repaid
            ),
            bytes4(0)
        );

        // Codex round-1 PR #390 P1 #2 — Phase 5 / §5.2b proper-close
        // settlement for the borrower LIF VPFI path. Splits any
        // diamond-held VPFI between the borrower's claimable rebate
        // (scaled by time-weighted avg discount BPS) and the
        // treasury share. No-op on loans that took the lending-asset
        // fee path at init (vpfiHeld == 0). Mirror RepayFacet:561.
        LibVPFIDiscount.settleBorrowerLifProper(loan);

        // ── Phase-2 reward accrual close ─────────────────────────────
        LibInteractionRewards.closeLoan(
            loanId,
            /* borrowerClean */ true,
            /* lenderForfeit */ false
        );

        // Codex round-3 P2 #1 — emit the caller (current borrower-NFT
        // owner), not the latched `loan.borrower` field.
        // Codex round-4 P2 #1 — emit `actualCollateralConsumed`, not
        // `maxCollateralIn`. The unspent leftover was refunded to the
        // borrower vault above; emitting the requested amount would
        // overstate the protocol-level sell volume and understate the
        // borrower's residual position on indexer / dashboard surfaces.
        emit SwapToRepayExecuted(
            loanId,
            msg.sender,
            actualCollateralConsumed,
            outputAmount,
            adapterUsed
        );
    }

    /// @notice Partial swap-to-repay: swap a portion of the borrower's
    ///         collateral for the principal asset and apply the proceeds
    ///         to a partial principal reduction. Resets the accrual
    ///         clock per `repayPartial` semantics.
    /// @dev    Gated on `loan.allowsPartialRepay` (snapshotted from
    ///         `Offer.allowsPartialRepay` at init). Post-swap HF check
    ///         per `repayPartial:771-783`.
    /// @param loanId               The loan to partially repay.
    /// @param collateralSwapAmount The collateral input to swap.
    /// @param adapterCalls         Keeper-ranked try-list.
    function swapToRepayPartial(
        uint256 loanId,
        uint256 collateralSwapAmount,
        LibSwap.AdapterCall[] calldata adapterCalls
    ) external nonReentrant whenNotPaused {
        // T-090 v1.1 (#389) §5.8 — same custody-conflict rationale
        // as `swapToRepayFull`; block partial-atomic while the
        // intent surface holds the collateral.
        LibVaipakam.assertNoLiveIntentCommit(loanId);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // #594 — consolidate a transferred borrower position into the current
        // holder's vault before the partial swap operates on it (borrower side,
        // skip-not-block). A partial repay keeps the loan Active and pays NO
        // proceeds to the lender (it reduces principal in place), so only the
        // borrower side consolidates here. The FULL swap-to-repay is the
        // both-side close-out (lender paid + borrower surplus), wired in #658
        // PR-B above.
        LibConsolidation.consolidateToHolder(
            loanId, false, LibConsolidation.Ctx.Tier2CloseOut
        );

        // ── Pre-flight gates ─────────────────────────────────────────
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert InvalidLoanStatus();
        // Codex round-1 PR #390 P2 #4 (same fix as `swapToRepayFull`).
        if (
            loan.assetType != LibVaipakam.AssetType.ERC20 ||
            loan.collateralAssetType != LibVaipakam.AssetType.ERC20
        ) revert UnsupportedLoanShape();
        if (
            loan.collateralLiquidity != LibVaipakam.LiquidityStatus.Liquid ||
            loan.principalLiquidity != LibVaipakam.LiquidityStatus.Liquid
        ) revert UnsupportedLoanShape();
        // Codex round-1 PR #390 P1 #3 (same fix as `swapToRepayFull`).
        LibAuth.requireBorrowerNftOwner(loan);

        // Codex round-2 PR #390 P2 #1 — block lender self-repay on
        // the partial path too. The full path had this guard from
        // round-0; without the mirror, a lender who has acquired the
        // borrower-side position NFT could consume claim-bearing
        // collateral and route the partial principal + interest into
        // their own lender vault while keeping the loan Active.
        if (msg.sender == loan.lender) revert LenderCannotRepayOwnLoan();
        if (
            IERC721(address(this)).ownerOf(loan.lenderTokenId) == msg.sender
        ) revert LenderCannotRepayOwnLoan();

        if (!loan.allowsPartialRepay) revert PartialRepayNotAllowed();

        if (collateralSwapAmount == 0 || collateralSwapAmount > loan.collateralAmount)
            revert InvalidAmount();

        uint256 endTime = loan.startTime + loan.durationDays * LibVaipakam.ONE_DAY;
        uint256 graceEnd = endTime + LibVaipakam.gracePeriod(loan.durationDays);
        if (block.timestamp > graceEnd) revert RepaymentPastGracePeriod();

        // Pass-2 A2 (#1190, Codex #1229) — capture PRE-swap HF for the
        // monotonicity gate. This loan is ERC-20-on-both-legs + liquid (asserted
        // above), so it always carries an HF. Unlike a direct partial, a swap
        // sells collateral AND repays principal, so HF is not guaranteed to
        // improve — the gate below asserts the swap does not worsen it.
        uint256 hfBefore = abi.decode(
            LibFacet.crossFacetStaticCall(
                abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
                HealthFactorCalculationFailed.selector
            ),
            (uint256)
        );

        // ── Slippage floor pre-flight ────────────────────────────────
        uint256 expectedProceeds = LibFallback.expectedSwapOutput(
            address(this),
            loan.collateralAsset,
            loan.principalAsset,
            collateralSwapAmount
        );
        uint256 minPrincipalOut = (expectedProceeds *
            (LibVaipakam.BASIS_POINTS - LibVaipakam.cfgMaxSwapToRepaySlippageBps())) /
            LibVaipakam.BASIS_POINTS;

        // ── Withdraw + swap ──────────────────────────────────────────
        // Codex round-3 P1 #2 — same partial-fill refund pattern
        // as `swapToRepayFull`.
        uint256 collateralBalanceBefore =
            IERC20(loan.collateralAsset).balanceOf(address(this));

        // #407 PR 4 round-1 Codex P1 #3 (2026-06-12) — decrement the
        // lien by the slice we're moving out. The loan stays ACTIVE
        // here so a full release would leave the residual collateral
        // unprotected from other ERC20 withdraw surfaces.
        _decrementLienAtSwapToRepayPartial(loanId, collateralSwapAmount);
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector,
                loan.borrower,
                loan.collateralAsset,
                address(this),
                collateralSwapAmount
            ),
            VaultWithdrawFailed.selector
        );

        (bool success, uint256 outputAmount, uint256 adapterUsed) = LibSwap.swapWithFailover(
            loanId,
            loan.collateralAsset,
            loan.principalAsset,
            collateralSwapAmount,
            minPrincipalOut,
            address(this),
            adapterCalls
        );
        if (!success) revert SwapAllAdaptersFailed();

        // Refund partial-fill leftover collateral to borrower vault.
        uint256 actualCollateralConsumed = collateralSwapAmount -
            (IERC20(loan.collateralAsset).balanceOf(address(this)) -
                collateralBalanceBefore);
        uint256 partialFillRefund = collateralSwapAmount - actualCollateralConsumed;
        if (partialFillRefund > 0) {
            IERC20(loan.collateralAsset).safeTransfer(
                LibFacet.getOrCreateVault(loan.borrower),
                partialFillRefund
            );
            LibVaipakam.recordVaultDeposit(
                loan.borrower,
                loan.collateralAsset,
                partialFillRefund
            );
            // #407 PR 4 round-1 — restore the lien for the dust that
            // landed back in the borrower vault; the loan stays Active
            // and that collateral still backs it.
            _incrementLienAtSwapToRepayPartial(loanId, partialFillRefund);
        }

        // #594 Codex #657 round-4 — the eager consolidation above checkpointed
        // the holder's VPFI tier/staking at the FULL pre-swap balance; the swap
        // just consumed the net (swap-amount minus any partial-fill refund) out
        // of their vault. Re-stamp at the post-swap balance so the holder
        // doesn't keep fee-tier/staking credit on VPFI that was swapped away.
        // No-op for non-VPFI collateral.
        if (loan.collateralAsset == s.vpfiToken) {
            LibConsolidation.restampUserVpfi(loan.borrower);
        }

        // ── Accrued-interest split + partial bound ───────────────────
        // Pass-2 A3 (#1191) — CREDIT any periodic-settled interest so the swap
        // partial charges only the UNSETTLED accrual (else it re-charges the
        // periodic auto-liquidation's already-settled days — the audit's M1 /
        // its SwapToRepay twin). Netted here; the stale `interestSettled` is
        // zeroed at the accrual-clock reset below (the #915 credit+zero pattern).
        uint256 grossAccrued = LibEntitlement.accruedInterestToTime(loan, block.timestamp);
        uint256 priorSettled = uint256(loan.interestSettled);
        uint256 accrued = LibEntitlement.creditSettledInterest(loan, grossAccrued);
        (uint256 treasuryShare, uint256 lenderShare) = LibEntitlement.splitTreasury(loan, accrued);

        // Must at least cover the accrued interest.
        if (outputAmount < lenderShare + treasuryShare) revert InsufficientProceeds();
        uint256 partialPrincipal = outputAmount - lenderShare - treasuryShare;
        if (partialPrincipal == 0) revert InsufficientProceeds();

        // Codex round-1 P2 #3 — reject swaps that would retire the
        // full principal; borrower must use `swapToRepayFull` for
        // close-out side-effects.
        if (partialPrincipal >= loan.principal)
            revert PartialWouldRetireFullPrincipal();

        uint256 minPartial = (loan.principal *
            s.assetRiskParams[loan.principalAsset].minPartialBps) /
            LibVaipakam.BASIS_POINTS;
        if (partialPrincipal < minPartial) revert InsufficientPartialAmount();

        // ── Lender Yield Fee discount (§F2 / #1354 / #1383) ──────────
        // swap-to-repay-partial does NOT consolidate `loan.lender` — the lender
        // payout below resolves the CURRENT lender-NFT holder — so the discount
        // is keyed on that holder, not the (possibly stale) `loan.lender`. The
        // shift is treasury→lender, so `partialPrincipal` (already computed) and
        // the borrower surplus (below) are invariant.
        {
            address settlingLender = IERC721(address(this)).ownerOf(loan.lenderTokenId);
            (uint256 lenderExtra, uint256 newTreasury) = _resolveLenderYieldFee(
                loanId,
                settlingLender,
                accrued,
                treasuryShare
            );
            if (lenderExtra > 0) {
                lenderShare += lenderExtra;
                treasuryShare = newTreasury;
            }
        }

        // ── Settle waterfall — diamond-held pattern ──────────────────
        address treasury = LibFacet.getTreasury();
        if (treasuryShare > 0) {
            IERC20(loan.principalAsset).safeTransfer(treasury, treasuryShare);
            LibFacet.recordTreasuryAccrual(loan.principalAsset, treasuryShare);
        }

        // Codex round-3 P1 #1 + round-4 P1 #3 — pay the lender directly
        // on the partial path, but route to the CURRENT lender-side NFT
        // owner (not the stale `loan.lender` field). Lender rights
        // travel with the NFT just like borrower rights; without this
        // resolution, a plain ERC-721 transfer of the lender NFT
        // would leave the borrower's partial payment routing to the
        // original lender (who no longer owns the loan). The loan
        // stays Active so the lender has no claim slot, and
        // `vaultWithdrawERC20` is `onlyDiamondInternal` — direct EOA
        // transfer is the only path to actually realize the funds.
        address currentLenderHolder = IERC721(address(this))
            .ownerOf(loan.lenderTokenId);
        // #954 (§1.3) — `swapToRepayPartial` is a DISCRETIONARY, loan-stays-
        // Active path (the analogue of `repayPartial`), so it hard-SCREENS the
        // direct EOA payee rather than freezing: a flagged party's must-complete
        // escape hatch is `swapToRepayFull` (which freezes). Mirror
        // `repayPartial`'s Tier-1 screen on the discretionary payout.
        LibVaipakam._assertNotSanctioned(currentLenderHolder);
        uint256 lenderTotal = lenderShare + partialPrincipal;
        IERC20(loan.principalAsset).safeTransfer(currentLenderHolder, lenderTotal);

        // Any leftover principal (above accrued + partialPrincipal) →
        // current borrower-NFT holder's EOA directly (Codex round-4
        // P1 #2 / round-2 P1 #1). Same rationale as the full-path
        // surplus: Active partial-repay loans have no claim slot for
        // principal and vault withdraw is internal-only.
        uint256 surplus = outputAmount - treasuryShare - lenderTotal;
        if (surplus > 0) {
            address currentBorrowerHolder = IERC721(address(this))
                .ownerOf(loan.borrowerTokenId);
            // #954 (§1.3) — same Tier-1 discretionary screen on the borrower
            // surplus payee; the must-complete escape is `swapToRepayFull`.
            LibVaipakam._assertNotSanctioned(currentBorrowerHolder);
            IERC20(loan.principalAsset).safeTransfer(
                currentBorrowerHolder,
                surplus
            );
        }

        // ── Loan state updates ───────────────────────────────────────
        unchecked {
            loan.principal -= partialPrincipal;
            // Codex round-1 P1 #4 — reduce collateralAmount so HF /
            // default / claim logic reflects true post-swap backing.
            // Codex round-4 P1 #1 — use `actualCollateralConsumed`,
            // not `collateralSwapAmount`. On an aggregator partial-fill
            // the unspent input was already refunded to the vault
            // (above); subtracting the FULL `collateralSwapAmount`
            // here would double-count the loss and understate the
            // remaining backing for HF / default math.
            loan.collateralAmount -= actualCollateralConsumed;
        }
        // #408 / #410 / #413 (2026-06-12), Codex PR #559 round-1
        // P1: mirror `RepayFacet.repayPartial`'s Option A remaining-
        // committed-term tracking on this partial-repay entry point
        // too. Without it, a full-term loan partially repaid via
        // collateral swap would compute the floor on the reduced
        // principal but over the ORIGINAL term, drifting out of sync
        // with the formula `RepayFacet.repayPartial` uses on the same
        // loan state shape.
        //
        // #641 — the re-stamp lands on the dedicated INTEREST clock
        // (`interestAccrualStart` / `interestRemainingDays`); the term tuple
        // (`startTime` + `durationDays` → maturity + grace) is LEFT UNTOUCHED,
        // mirroring `RepayFacet.repayPartial`. Seed the clock from the term for
        // any loan that predates the fields before reading elapsed.
        LibVaipakam.seedInterestClockIfUnset(loan);
        uint256 elapsedSinceSegmentStart;
        unchecked {
            elapsedSinceSegmentStart =
                (block.timestamp - loan.interestAccrualStart) / LibVaipakam.ONE_DAY;
        }
        if (elapsedSinceSegmentStart >= loan.interestRemainingDays) {
            loan.interestRemainingDays = 0;
        } else {
            unchecked {
                loan.interestRemainingDays = uint16(
                    uint256(loan.interestRemainingDays) - elapsedSinceSegmentStart
                );
            }
        }
        loan.interestAccrualStart = uint64(block.timestamp); // reset accrual clock
        // Pass-2 A3 (#1191) — consume ONLY the settled portion this partial's
        // charge just netted (`grossAccrued`) and PRESERVE any excess: a periodic
        // auto-liquidation can OVERDELIVER (credits slippage-buffered proceeds >
        // interest accrued so far), so zeroing all of it would forfeit the
        // borrower's already-paid excess and later overstate the debt (Codex
        // #1229). The clock is reset above, so the surviving
        // `interestSettled - grossAccrued` credits future accrual.
        loan.interestSettled = priorSettled > grossAccrued
            ? priorSettled - grossAccrued
            : 0;

        // ── T-034 §4.5 — periodic-interest checkpoint advance
        //    (mirror RepayFacet:679-706) ────────────────────────────
        if (loan.periodicInterestCadence != LibVaipakam.PeriodicInterestCadence.None) {
            // Pass-2 A3 (#1191, Codex #1229) — credit the NETTED `accrued`, NOT
            // `grossAccrued`: the latter spans already-settled periods (the
            // accrual clock is not reset by periodic auto-liquidation), so adding
            // it would credit old interest into the new period and skip a
            // required auto-liquidation, underpaying the lender (Codex #1229
            // round 3, P1). Exact current-period attribution deferred to #1230.
            // Mirrors RepayFacet.
            uint256 newPaid = uint256(loan.interestPaidSinceLastPeriod) + accrued;
            if (newPaid > type(uint128).max) newPaid = type(uint128).max;
            loan.interestPaidSinceLastPeriod = SafeCast.toUint128(newPaid);
            if (LibPeriodicInterest.canAdvanceCheckpointInline(loan)) {
                // Codex round-1 PR #390 P2 #2 — emit the
                // `RepayPartialPeriodAdvanced` + `PeriodicInterestSettled`
                // events that off-chain accounting subscribes to. Both
                // are topic-matched to the RepayFacet declarations so
                // existing indexer / dashboard handlers fire here too.
                uint256 boundary = LibPeriodicInterest.periodEndAt(loan);
                uint256 expected = LibPeriodicInterest.expectedInterestForPeriod(loan);
                LibPeriodicInterest.advanceCheckpoint(loan);
                emit RepayPartialPeriodAdvanced(loanId, boundary, expected, msg.sender);
                emit PeriodicInterestSettled(
                    loanId,
                    boundary,
                    expected,
                    newPaid,
                    msg.sender
                );
            }
        }

        // ── Post-repay HF guard ──────────────────────────────────────
        // Pass-2 A2 (#1190, Codex #1229) — MONOTONICITY, not the old inverted
        // 1.5 admission floor (which blocked a sub-floor borrower from
        // deleveraging via a swap that improves HF but doesn't fully restore
        // 1.5 — the same bug A2 fixes on `repayPartial`). Assert the swap does
        // not WORSEN HF; the tier-LTV cap below is the separate over-consumption
        // guard (#394).
        uint256 hfAfter = abi.decode(
            LibFacet.crossFacetStaticCall(
                abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
                HealthFactorCalculationFailed.selector
            ),
            (uint256)
        );
        if (hfAfter < hfBefore) revert PartialSwapWorsensHealthFactor(hfBefore, hfAfter);

        // #394 Lever A (Codex #647 round-6) — also re-check post-swap LTV against
        // THIS loan's snapshotted admission init-LTV cap. For a depth-tiered
        // loan the HF snapshot is 1e18, so the HF check alone wouldn't stop a
        // partial swap-to-repay (under a permissive slippage) from consuming
        // collateral + repaying too little and ending ABOVE the tier-cap buffer
        // the lender accepted — same guard the partial-withdrawal / fallback-cure
        // paths enforce.
        bytes memory ltvResult = LibFacet.crossFacetStaticCall(
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector, loanId),
            LTVCalculationFailed.selector
        );
        uint256 ltv = abi.decode(ltvResult, (uint256));
        if (
            ltv >
            LibVaipakam.effectiveLoanInitLtvCapBps(
                loan.initLtvCapBpsAtInit,
                LibVaipakam.storageSlot().assetRiskParams[loan.collateralAsset].loanInitMaxLtvBps
            )
        ) revert LTVExceeded();

        // Codex round-3 P2 #1 + round-4 P2 #1 — emit `msg.sender`
        // (current borrower-NFT owner, not stale `loan.borrower`)
        // and `actualCollateralConsumed` (not the requested amount).
        emit SwapToRepayPartialExecuted(
            loanId,
            msg.sender,
            actualCollateralConsumed,
            outputAmount,
            partialPrincipal,
            adapterUsed
        );
    }

    /// @dev #407 PR 4 round-1 Codex P1 #3 (2026-06-12) — consolidated
    ///      cross-facet helpers. One per arg-shape; each call site
    ///      picks the selector.
    function _callEncumb2(bytes4 selector, uint256 loanId, uint256 arg2) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(selector, loanId, arg2),
            bytes4(0)
        );
    }

    /// @dev #1383 — resolve the lender yield-fee discount for `settlingLender`
    ///      via the `VPFIDiscountFacet` host, so the try-VPFI-then-direct-
    ///      reduction delivery bytecode stays off this at-EIP-170 facet. Returns
    ///      the deltas to fold into the settlement (`lenderShare += lenderExtra;
    ///      treasuryShare = newTreasury`). The host emits the analytics
    ///      passthrough on the VPFI-payment path, so the caller drops
    ///      `vpfiDeducted`. `settlingLender` is `loan.lender` on the consolidated
    ///      full close-out, or the current `ownerOf(lenderTokenId)` on the
    ///      non-consolidated partial path.
    function _resolveLenderYieldFee(
        uint256 loanId,
        address settlingLender,
        uint256 interestForQuote,
        uint256 treasuryShare
    ) private returns (uint256 lenderExtra, uint256 newTreasury) {
        bytes memory ret = LibFacet.crossFacetCallReturn(
            abi.encodeWithSelector(
                VPFIDiscountFacet.resolveLenderYieldFeeFor.selector,
                loanId,
                settlingLender,
                interestForQuote,
                treasuryShare
            ),
            LenderYieldFeeResolveFailed.selector
        );
        (lenderExtra, newTreasury, ) = abi.decode(ret, (uint256, uint256, uint256));
    }

    function _decrementLienAtSwapToRepayPartial(uint256 loanId, uint256 consumed) private {
        _callEncumb2(EncumbranceMutateFacet.decrementCollateralLien.selector, loanId, consumed);
    }

    function _incrementLienAtSwapToRepayPartial(uint256 loanId, uint256 added) private {
        _callEncumb2(EncumbranceMutateFacet.incrementCollateralLien.selector, loanId, added);
    }

    /// @dev #954 — crossFacetCall stub for the borrower-surplus freeze/pay
    ///      (3-arg shape). Keeps the freeze bytecode in `EncumbranceMutateFacet`
    ///      so `swapToRepayFull` stays under the EIP-170 ceiling.
    function _callFreezeSurplus(uint256 loanId, address holder, uint256 surplus) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.freezeOrPayBorrowerSurplus.selector,
                loanId,
                holder,
                surplus
            ),
            bytes4(0)
        );
    }
}
