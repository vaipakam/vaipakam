// src/facets/RepayFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibConsolidation} from "../libraries/LibConsolidation.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibSettlement} from "../libraries/LibSettlement.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibPeriodicInterest} from "../libraries/LibPeriodicInterest.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {VPFIDiscountFacet} from "./VPFIDiscountFacet.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";


/**
 * @title RepayFacet
 * @author Vaipakam Developer Team
 * @notice Loan repayment, partial repayment, and NFT auto-deduction for the
 *         Vaipakam P2P lending platform.
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded, pausable.
 *
 *      Three entry points:
 *        {repayLoan}        — full repayment closing the loan.
 *        {repayPartial}     — reduces outstanding principal (ERC-20) or
 *                             remaining rental days (NFT).
 *        {autoDeductDaily}  — permissionless daily deduction for NFT
 *                             rentals (deducts one day's fee from the
 *                             borrower's vaulted prepay).
 *
 *      Interest model (per-loan flag `useFullTermInterest`):
 *        true  → full-term interest regardless of elapsed time.
 *        false → pro-rata interest based on actual elapsed days.
 *      Late fees: 1% first overdue day + 0.5%/day, capped at 5% of
 *      principal (see {LibVaipakam.calculateLateFee}).
 *      Fee distribution: {LibEntitlement.splitTreasury} routes
 *      `TREASURY_FEE_BPS` (1%) to treasury; remainder to the lender.
 *      For ERC-20 loans the settlement math is computed atomically by
 *      {LibSettlement.computeRepayment}.
 *
 *      Grace-period enforcement: repay is allowed up to `endTime +
 *      gracePeriod(durationDays)`; after that, {DefaultedFacet} is the
 *      only resolution path.
 *
 *      FallbackPending cure: {repayLoan} accepts the FallbackPending
 *      status, pushes the diamond-held collateral back into the
 *      borrower's vault, and transitions to Repaid.
 */
contract RepayFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    using SafeERC20 for IERC20;

    /// @notice Emitted when a loan is successfully repaid.
    /// @param loanId The ID of the repaid loan.
    /// @param repayer The address that submitted the repayment (may differ from borrower).
    /// @param interestPaid The interest paid (full-term or pro-rata based on per-loan config).
    /// @param lateFeePaid The late fee paid (if applicable).
    /// @param outstandingPrincipal Post-repay `loan.principal`. Always 0
    ///        on a successful full repay (the loan transitions to
    ///        `Repaid` / `Settled` here).
    /// @param accruedInterest Interest accrued AT EMIT TIME against the
    ///        post-repay principal. Per D15, emitted as the as-of-emit
    ///        snapshot; consumers must recompute on display freshness.
    ///        Always 0 on full repay (no remaining principal to accrue).
    /// @param newStatus Post-repay `LoanStatus` — `Repaid` for the
    ///        deferred-claim path, otherwise per the lifecycle library.
    /// @custom:event-category state-change/loan-mutation
    event LoanRepaid(
        uint256 indexed loanId,
        address indexed repayer,
        uint256 interestPaid,
        uint256 lateFeePaid,
        uint256 outstandingPrincipal,
        uint256 accruedInterest,
        LibVaipakam.LoanStatus newStatus
    );

    /// @notice Full settlement breakdown for an ERC-20 loan being closed
    ///         (repayLoan or precloseDirect). Emitted in addition to the
    ///         status-specific event so indexers can reconstruct the exact
    ///         amounts routed to treasury vs. lender without re-reading storage.
    /// @dev Invariant: `treasuryShare + lenderShare == interest + lateFee`.
    ///      `principal` is the amount returned to the lender's vault as claimable.
    /// @custom:event-category informational/settlement
    event LoanSettlementBreakdown(
        uint256 indexed loanId,
        uint256 principal,
        uint256 interest,
        uint256 lateFee,
        uint256 treasuryShare,
        uint256 lenderShare
    );

    /// @notice Emitted when a partial repayment is made.
    /// @param loanId The ID of the loan.
    /// @param amountRepaid The partial amount repaid (principal or days' fees).
    /// @param newPrincipal The updated principal (for ERC20) or duration (for NFT).
    /// @param accruedInterest Interest accrued at emit time against the
    ///        new (post-repay) principal. The accrual clock is reset
    ///        inside the partial-repay path right before this emit, so
    ///        this value is 0 in the same-block — a confirmation that
    ///        the clock was reset rather than rolled forward.
    ///        EventSourcingAudit §3.10.
    /// @custom:event-category state-change/loan-mutation
    event PartialRepaid(
        uint256 indexed loanId,
        uint256 amountRepaid,
        uint256 newPrincipal,
        uint256 accruedInterest
    );

    // ─── T-034 Periodic Interest Payment events ───────────────────────────

    /// @notice Emitted when a period checkpoint advances cleanly — either
    ///         the borrower's voluntary repayments covered the period's
    ///         interest in full (just-stamp) or
    ///         {settlePeriodicInterest} was called with no shortfall.
    ///         No collateral was sold; no settler bonus was paid.
    /// @param loanId The loan whose checkpoint advanced.
    /// @param periodEndAt Timestamp of the period boundary that closed
    ///        (`lastPeriodicInterestSettledAt` BEFORE the advance).
    /// @param expected The period's expected interest, snapshotted at
    ///        the moment of the advance.
    /// @param paidByBorrower Cumulative interest the borrower paid
    ///        during the period, drawn from `interestPaidSinceLastPeriod`
    ///        before reset.
    /// @param settler `msg.sender` of the call that triggered the
    ///        advance — borrower (via `repayPartial` fold), permissionless
    ///        bot (via `settlePeriodicInterest`), or anyone else.
    /// @custom:event-category state-change/loan-mutation
    event PeriodicInterestSettled(
        uint256 indexed loanId,
        uint256 periodEndAt,
        uint256 expected,
        uint256 paidByBorrower,
        address indexed settler
    );

    /// @notice Emitted when {repayPartial} folds the period checkpoint
    ///         advance inline — i.e. the borrower's payment crossed a
    ///         period boundary AND covered the period's expected
    ///         interest in full. Off-chain consumers correlate this
    ///         with the standard {PartialRepaid} fired in the same tx.
    /// @custom:event-category state-change/loan-mutation
    event RepayPartialPeriodAdvanced(
        uint256 indexed loanId,
        uint256 periodEndAt,
        uint256 expected,
        address indexed advancedBy
    );

    // Facet-specific errors (shared errors inherited from IVaipakamErrors)
    error RepaymentPastGracePeriod();
    error InsufficientPrepay();
    error InsufficientPartialAmount();
    /// @notice Reverted when {repayPartial} is asked to retire the full
    ///         remaining ERC-20 principal (`partialAmount >= loan.principal`).
    ///         #921 item 3 — the partial path only decrements principal; it does
    ///         NOT run settlement, collateral release, or NFT burns, so accepting
    ///         a full-principal "partial" left the loan Active at principal 0 (a
    ///         zombie) with close-out stranded behind a separate {repayLoan}.
    ///         Callers retiring the whole principal must use {repayLoan}. Mirrors
    ///         `SwapToRepayFacet.PartialWouldRetireFullPrincipal`.
    error PartialWouldRetireFullPrincipal();
    /// @notice Reverted when {repayPartial} is called on a loan whose
    ///         `allowsPartialRepay` flag is false. The flag is
    ///         lender-controlled — set on the offer at create-time
    ///         (lender offers) or carried from the source offer at
    ///         loan init (borrower offers, where the lender's accept
    ///         is consent to the borrower's create-time request).
    ///         Default-false: every loan must opt in explicitly.
    error PartialRepayNotAllowed();
    /// @notice Pass-2 A2 (#1190) — reverted when a partial repayment would
    ///         LOWER the loan's health factor. A partial reduces principal and
    ///         resets accrued interest with collateral still liened, so HF
    ///         strictly improves in practice; this is a defensive monotonicity
    ///         guard replacing the old (inverted) `HF >= 1.5 admission floor`
    ///         gate, which blocked exactly the deleveraging the lender wants.
    error PartialRepayWorsensHealthFactor(uint256 hfBefore, uint256 hfAfter);

    /**
     * @notice Repays an active loan in full.
     * @dev Caller must approve totalDue (from calculateRepaymentAmount).
     *      Handles ERC20/NFT differently: For ERC20, pays principal + interest/late.
     *      For NFT, deducts accrued rental from prepay, refunds unused + buffer.
     *      Distributes fees: 99% lender, 1% treasury.
     *      Releases collateral/resets renter, burns NFTs, sets status Repaid.
     *      Reverts if past grace. For NFT rentals, reverts if not borrower
     *      (rental fees are deducted from borrower's vaulted prepayment).
     *      For ERC-20 loans, any address may repay on the borrower's behalf
     *      EXCEPT the loan's lender or the current owner of the lender-side
     *      Vaipakam NFT — repaying your own loan is economically degenerate
     *      (you pay yourself principal+interest minus the 1% treasury cut)
     *      and is almost certainly a misclick. Reverts
     *      {LenderCannotRepayOwnLoan} in that case. Collateral claim rights
     *      remain tied to the borrower's Vaipakam NFT.
     *      Emits LoanRepaid.
     * @param loanId The loan ID to repay.
     */
    function repayLoan(uint256 loanId) external nonReentrant whenNotPaused {
        // T-090 v1.1 (#389) §5.8 — block voluntary close while an
        // intent-based swap-to-repay commit is live (custody has
        // already moved out of `loan.borrower`'s vault).
        LibVaipakam.assertNoLiveIntentCommit(loanId);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // #594 — full repay is a BOTH-SIDE close-out: it deposits lender
        // proceeds to `loan.lender`, reads yield-fee VPFI consent from it, and
        // closes lender rewards on it, while the borrower's collateral returns
        // to `loan.borrower`. Consolidate each side whose NFT may have moved so
        // proceeds/collateral route to the current holders. Skip-not-block; a
        // FallbackPending loan is excluded on both sides (cured below).
        LibConsolidation.consolidateToHolder(loanId, false, LibConsolidation.Ctx.Tier2CloseOut);
        LibConsolidation.consolidateToHolder(loanId, true, LibConsolidation.Ctx.Tier2CloseOut);
        // FallbackPending is accepted: a full repay cures the failed
        // liquidation, clears the snapshot, and returns diamond-held collateral
        // to the borrower vault before the normal Repaid flow runs.
        if (
            loan.status != LibVaipakam.LoanStatus.Active &&
            loan.status != LibVaipakam.LoanStatus.FallbackPending
        ) revert InvalidLoanStatus();
        bool curingFallback = loan.status == LibVaipakam.LoanStatus.FallbackPending;
        // #998 S10 (#1006) — a cure supersedes the abandoned fallback-ENTRY freeze,
        // so clear the entry markers up front and let the fresh terminal re-stamp
        // below be authoritative (a stale flagged marker must not fail-close a
        // now-clean holder's claim during an oracle outage). No-op for a normal
        // Active repay that never had a marker.
        //
        // Codex r2 P1 — but PRESERVE a LENDER marker that still backs
        // partial-internal-match proceeds: `heldForLender > 0` means an earlier
        // Active partial match parked a leg's proceeds under a legitimately-set
        // frozen claimant unrelated to this fallback episode. Clearing it would let
        // those prior held proceeds release with no fail-closed marker. The borrower
        // side has no such cross-episode accumulator, so it always clears.
        if (curingFallback) {
            if (s.heldForLender[loanId] == 0) {
                LibSanctionedLock.clearFrozenClaimant(s, loanId, true);
            }
            LibSanctionedLock.clearFrozenClaimant(s, loanId, false);
        }

        // Block lender-side self-repayment. Two checks because `loan.lender`
        // and `ownerOf(lenderTokenId)` can diverge after a free-form ERC-721
        // transfer (the storage field is updated by `sellLoanViaBuyOffer`
        // and the loan-sale completion path, but a plain `transferFrom`
        // mid-loan moves NFT custody without touching `loan.lender`). The
        // canonical authority is NFT ownership, but we additionally guard
        // the storage field for defence-in-depth. Skipped for NFT rentals,
        // which intentionally require borrower (= renter) repayment to
        // settle the rental period — the lender-side check has no meaning
        // there since rental fees are deducted from a borrower-funded
        // prepay vault regardless of caller.
        if (loan.assetType == LibVaipakam.AssetType.ERC20) {
            if (msg.sender == loan.lender) revert LenderCannotRepayOwnLoan();
            if (
                IERC721(address(this)).ownerOf(loan.lenderTokenId) == msg.sender
            ) revert LenderCannotRepayOwnLoan();
        }

        uint256 endTime = loan.startTime +
            loan.durationDays *
            LibVaipakam.ONE_DAY;
        uint256 graceEnd = endTime + LibVaipakam.gracePeriod(loan.durationDays);
        // #1000 (S2) — the grace gate blocks an ORDINARY (Active) repayment past
        // graceEnd (that loan must go through DefaultedFacet). But a
        // FallbackPending CURE only exists past graceEnd (a time-based default
        // fires there), and the spec twice promises the borrower may still fully
        // repay to cancel the fallback before the lender claim executes. So a
        // cure is exempt: it fully compensates the lender (principal + interest
        // incl. grace accrual + late fees), so there is no lender-side harm.
        if (!curingFallback && block.timestamp > graceEnd) {
            revert RepaymentPastGracePeriod();
        }

        uint256 interest; // Or rental fee
        uint256 lateFee = LibVaipakam.calculateLateFee(loanId, endTime);
        address treasury = LibFacet.getTreasury();

        // #569 Codex #572 round-4 P2 — the collateral-lien release is NO
        // LONGER done here. On the ERC20-loan path the borrower's
        // collateral STAYS in their vault as a `borrowerClaims` row and
        // is withdrawn later by `ClaimFacet.claimAsBorrower`; releasing
        // the lien at this terminal would let the stored borrower drain
        // that collateral (via `withdrawVPFIFromVault`) before a
        // transferee claimant claims it. The release is now done
        // atomically inside `claimAsBorrower`, immediately before the
        // claim withdrawal. The NFT-rental branch below never had a lien
        // to release (D-1: rentals are not liened — its `prepayAsset`
        // withdrawals see `encumbered == 0` at the guard), so dropping
        // the pre-branch release is a no-op for rentals.

        if (loan.assetType == LibVaipakam.AssetType.ERC20) {
            // ERC20 loan: Interest + late fee. Build the immutable settlement
            // plan first (phase 1, pure math); all downstream transfers and
            // claim writes consume the plan verbatim (phase 2).
            LibSettlement.ERC20Settlement memory plan = LibSettlement.computeRepayment(
                loan,
                lateFee,
                block.timestamp
            );
            interest = plan.interest;

            // Lender Yield Fee discount (Tokenomics §6): when the lender has
            // platform-level VPFI-discount consent AND holds >= the required
            // VPFI in vault, the 1% treasury cut is paid in VPFI from the
            // lender's vault and the lender keeps 100% of interest+lateFee
            // in the lending asset. tryApplyYieldFee returns (false, 0) on
            // any precondition failure — we then fall through to the normal
            // ERC-20 split.
            // #1354 §F2 / #1383 — eligibility is `consent OR lenderMode ==
            // Full`; the resolve host runs the whole VPFI-payment-then-direct-
            // reduction delivery and emits the analytics passthrough itself.
            // Keyed on the CURRENT lender-NFT holder (not `loan.lender`): the
            // terminal consolidation is skip-not-block, so keying on the live
            // `ownerOf(lenderTokenId)` resolves the discount + any VPFI debit for
            // the right party even when consolidation was skipped (Codex #1387
            // P1). Routing through the host (rather than inlining
            // `LibVPFIDiscount.resolveLenderYieldFee`) keeps the delivery
            // bytecode off this at-EIP-170 facet — headroom the repayPartial
            // secondary path below also needs (#1383).
            (uint256 lenderExtra, uint256 newTreasury) = _hostResolveLenderYieldFee(
                loan.id,
                IERC721(address(this)).ownerOf(loan.lenderTokenId),
                plan.interest + plan.lateFee,
                plan.treasuryShare
            );
            if (lenderExtra > 0) {
                plan.lenderShare += lenderExtra;
                plan.lenderDue = plan.principal + plan.lenderShare;
                plan.treasuryShare = newTreasury;
            }

            // Treasury share transferred immediately (no claim needed).
            // Skipped entirely when the VPFI discount path satisfied it.
            if (plan.treasuryShare > 0) {
                IERC20(loan.principalAsset).safeTransferFrom(
                    msg.sender,
                    treasury,
                    plan.treasuryShare
                );
                LibFacet.recordTreasuryAccrual(loan.principalAsset, plan.treasuryShare);
            }

            // T-037 — Lender's due: borrower → lender's vault in ONE
            // transfer. The Diamond carries the borrower's allowance
            // (granted by the prior `approve()`) so the chokepoint's
            // cross-payer variant pushes the asset from the borrower's
            // wallet into the lender's vault without ever residing
            // on the Diamond. Routing through `vaultDepositERC20From`
            // ensures the protocolTrackedVaultBalance counter ticks
            // up under the LENDER (the owner of the receiving vault,
            // not the borrower who's the payer).
            // #821 — vault-lock: a flagged stored lender would otherwise brick
            // this deposit (the receiving-vault screen reverts). Pin the
            // receive-side exemption to `loan.lender` so the close-out completes
            // and the borrower's debt clears; the proceeds land in the lender's
            // OWN (protocol-tracked) vault, frozen behind the Tier-1 claim gate
            // (the `claimAsLender` stored-owner screen) until the flag clears.
            LibSanctionedLock.begin(s, loan.lender);
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultDepositERC20From.selector,
                    msg.sender,        // payer — borrower
                    loan.lender,       // user — lender, owns the receiving vault
                    loan.principalAsset,
                    plan.lenderDue
                ),
                VaultDepositFailed.selector
            );
            LibSanctionedLock.end(
                s, loan.lender, loanId, loan.principalAsset, plan.lenderDue
            );
            // #998 S10 (#1006 / #1132) — both holders' fail-closed markers are
            // recorded centrally at the `Repaid` transition (terminalizeFromAny).

            // Record lender's claimable (principal + interest). heldForLender handled by ClaimFacet.
            s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
                asset: loan.principalAsset,
                amount: plan.lenderDue,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                claimed: false
            });
            // #592 — the lender proceeds were just deposited into the
            // (possibly transferred-away) stored lender's vault and are owed to
            // the CURRENT lender-position holder via the claim above. VPFI is
            // the one principal asset with a user-facing tracked-balance exit
            // (`withdrawVPFIFromVault`), so reserve the proceeds against that
            // unstake path until the holder claims (released path-agnostically
            // in `ClaimFacet._claimAsLenderImpl`). No-op for non-VPFI principal.
            if (loan.principalAsset == s.vpfiToken) {
                LibEncumbrance.encumberLenderProceeds(
                    loanId, loan.lender, loan.principalAsset, plan.lenderDue
                );
            }

            // Record borrower's claimable (collateral stays in borrower's vault)
            s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
                asset: loan.collateralAsset,
                amount: loan.collateralAmount,
                assetType: loan.collateralAssetType,
                tokenId: loan.collateralTokenId,
                quantity: loan.collateralQuantity,
                claimed: false
            });
            // #998 S10 (#1006 / #1132) — the returned collateral is claim-gated
            // (`claimAsBorrower`); repay is a Tier-2 close-out that completes even
            // for a flagged borrower holder. The fail-closed borrower marker is
            // recorded centrally at the `Repaid` transition (terminalizeFromAny).

            emit LoanSettlementBreakdown(
                loanId,
                plan.principal,
                plan.interest,
                plan.lateFee,
                plan.treasuryShare,
                plan.lenderShare
            );

            // #1383 — the yield-fee VPFI-discount analytics event is now emitted
            // by the resolve host (`_hostResolveLenderYieldFee`), so no separate
            // passthrough is needed here.

            // Phase-2 reward accrual close (docs/TokenomicsTechSpec.md §4).
            // Borrower side is CLEAN only on in-grace full repayment; a
            // FallbackPending cure is a post-grace recovery, not a clean
            // term. Lender never forfeits via the repay path — the
            // early-withdrawal sale path is the only lender-forfeit route.
            LibInteractionRewards.closeLoan(
                loanId,
                /* borrowerClean */ !curingFallback,
                /* lenderForfeit */ false
            );
        } else {
            // NFT rental: only borrower can repay (fees come from borrower's vaulted prepayment)
            LibAuth.requireBorrower(loan);
            // Deduct accrued from prepay, excluding days already
            // deducted by autoDeductDaily. lastDeductTime advances by ONE_DAY
            // per auto-deduction, so (lastDeductTime - startTime) / ONE_DAY
            // gives the count of already-paid days.
            if (loan.prepayAmount == 0) revert InsufficientPrepay();

            // Pass-2 D1 (#1188) — guarded consumed-days derivation (safe even
            // if a legacy/imported rental still has lastDeductTime == 0).
            uint256 alreadyDeductedDays = LibVaipakam.consumedRentalDays(loan);
            if (loan.useFullTermInterest) {
                // Pass-2 D1 (#1188) — `durationDays` is now the IMMUTABLE
                // origination term; the REMAINING (unpaid) full-term days is
                // `remainingRentalDays` (term − days already consumed via
                // `lastDeductTime`). Using `durationDays` here would re-charge
                // the already-deducted days.
                interest = loan.principal * LibVaipakam.remainingRentalDays(loan);
            } else {
                uint256 elapsedDays = (block.timestamp - loan.startTime) /
                    LibVaipakam.ONE_DAY;
                uint256 undeductedDays = elapsedDays > alreadyDeductedDays
                    ? elapsedDays - alreadyDeductedDays
                    : 0;
                interest = loan.principal * undeductedDays;
            }

            // #998 S8 (#1004) — the rental late fee is based on the REMAINING
            // owed rental (`principal × durationDays`, capped at the pre-funded
            // buffer bps), NOT the one-day `loan.principal` base that the shared
            // `calculateLateFee` (computed at the top of this fn for the ERC-20
            // path) uses. Override it here for the rental branch.
            lateFee = LibVaipakam.calculateRentalLateFee(loanId, endTime);

            // The late fee is funded from the pre-funded 5% `bufferAmount`
            // (swept at resolution), not from `prepayAmount`. A full-term late
            // rental has `interest == prepayAmount`, so any positive late fee
            // would revert `InsufficientPrepay` if the buffer weren't in the
            // budget. The rental-fee cap ≤ buffer bps guarantees the buffer
            // covers it; the refund below returns the unused prepay + buffer.
            uint256 totalDue = interest + lateFee;
            if (totalDue > loan.prepayAmount + loan.bufferAmount) {
                revert InsufficientPrepay();
            }

            (uint256 treasuryShare, uint256 lenderShare) = LibEntitlement.splitTreasury(
                loan,
                totalDue
            );

            // #821 (Codex #832 r3 P1) — both withdrawals below pull the prepay
            // from the repayer's (`msg.sender`) own vault. Arm the move-out
            // exemption so a borrower flagged after init can still settle the
            // rental repayment (Tier-2 stays open) — the prepay is pushed OUT to
            // the already-screened treasury / lender, the payer loses custody.
            LibSanctionedLock.beginMoveOut(s, msg.sender);
            // Treasury share: immediate from borrower's vault
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC20.selector,
                    msg.sender,
                    loan.prepayAsset,
                    treasury,
                    treasuryShare
                ),
                TreasuryTransferFailed.selector
            );
            LibFacet.recordTreasuryAccrual(loan.prepayAsset, treasuryShare);

            // Lender's rental share: withdraw from borrower's vault → Diamond → lender's vault
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC20.selector,
                    msg.sender,
                    loan.prepayAsset,
                    address(this),
                    lenderShare
                ),
                VaultWithdrawFailed.selector
            );
            LibSanctionedLock.endMoveOut(s);
            // #821 (Codex #832 r2 P1) — vault-lock the lender's rental share so a
            // flagged stored lender doesn't brick the rental repayment; the share
            // lands in the lender's OWN vault, frozen behind the claim gate
            // (T-051 — the Diamond-side transfer ticks protocolTrackedVaultBalance
            // so the subsequent claim's vaultWithdrawERC20 doesn't underflow).
            LibSanctionedLock.depositLocked(
                s, loan.lender, loanId, loan.prepayAsset, lenderShare
            );
            // #998 S10 (#1006 / #1132) — both holders' fail-closed markers are
            // recorded centrally at the `Repaid` transition (terminalizeFromAny).

            // Record lender's claimable rental fees. heldForLender handled by ClaimFacet.
            s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
                asset: loan.prepayAsset,
                amount: lenderShare,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                claimed: false
            });

            // Borrower's refund (unused prepay + buffer) stays in their vault.
            // Order the subtraction as (prepay + buffer) − totalDue so it can't
            // underflow when the late fee draws on the buffer (totalDue may now
            // exceed prepayAmount alone). Guard above ensures totalDue ≤ pool.
            uint256 refund = (loan.prepayAmount + loan.bufferAmount) - totalDue;
            s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
                asset: loan.prepayAsset,
                amount: refund,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                claimed: false
            });
            // #998 S10 (#1006 / #1132) — the rental refund is a borrower claim too;
            // the fail-closed borrower marker is recorded centrally at the `Repaid`
            // transition (terminalizeFromAny) — matching the ERC-20 repay/preclose paths.

            // Reset renter immediately (operational — rental is over)
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultSetNFTUser.selector,
                    loan.lender,
                    loan.principalAsset,
                    loan.tokenId,
                    address(0),
                    0
                ),
                NFTRenterUpdateFailed.selector
            );
            // Note: the rented NFT (ERC-721 or ERC-1155) was vault-escrowed in
            // the lender's vault at rental creation (the vault-custody model —
            // NOT left in the lender's wallet). At repay only the ERC-4907
            // `user` is reset to address(0); the NFT itself needs no movement.

            // Phase-2 reward accrual close (docs/TokenomicsTechSpec.md §4).
            // NFT rentals have no fallback/cure path; reaching repayLoan
            // successfully means the rental closed cleanly.
            LibInteractionRewards.closeLoan(
                loanId,
                /* borrowerClean */ true,
                /* lenderForfeit */ false
            );
        }

        // Update NFT status to Loan Repaid — burns happen in ClaimFacet after claim
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

        // T-086 follow-up to step 14 — atomically clear any active prepay
        // listing for this loan BEFORE flipping the status. This:
        //   • revokes the vault's ERC-1271 binding for the listing's
        //     orderHash (any subsequent `Seaport.fulfillOrder` reverts)
        //   • releases the borrower-position-NFT lock
        //   • clears the diamond / executor / vault bookkeeping
        // Idempotent no-op when no listing is live. Closes the
        // acknowledged tech-debt comment in
        // {NFTPrepayListingFacet.cancelPrepayListing}: terminals
        // previously left stale listing bookkeeping that only the
        // borrower-side cancel-anytime escape could mop up. Placement
        // is after every safeTransferFrom has committed, so we know
        // the lender is paid before declaring the listing dead.
        LibPrepayCleanup.clearActiveListing(loan, loanId);

        // Active or FallbackPending both legally transition to Repaid here
        // (normal close or cure-by-repay). LibLifecycle validates the edge.
        // #1132 (S10 central enforcement) — route through `terminalizeFromAny`
        // so the validated transition AND both holders' fail-closed markers land
        // in one place (the per-branch standalone registers were folded here).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.terminalizeFromAny.selector,
                loanId,
                LibVaipakam.LoanStatus.Repaid
            ),
            bytes4(0)
        );
        // #407 PR 4 (T-407-B, 2026-06-12) — collateral lien release
        // moved to BEFORE the asset-type branch above (line ~296) so
        // the NFT-rental path's mid-flow vault withdraws clear the
        // {VaultFactoryFacet.vaultWithdrawERC20} guard. See the
        // explanatory comment at the new call site.

        // Phase 5 / §5.2b — proper-close settlement for the borrower LIF
        // VPFI path. Splits any Diamond-held VPFI between the borrower's
        // claimable rebate (scaled by time-weighted avg discount BPS) and
        // the treasury share. No-op on loans that took the lending-asset
        // fee path at init (vpfiHeld == 0).
        LibVPFIDiscount.settleBorrowerLifProper(loan);

        // Fallback cure: collateral was moved to the Diamond during the failed
        // swap attempt. Push it into the borrower vault so the borrowerClaim
        // record written above (points at borrower vault) is satisfiable,
        // then wipe the snapshot so the lender cannot double-dip.
        if (curingFallback) {
            LibVaipakam.FallbackSnapshot storage snap = s.fallbackSnapshot[loanId];
            uint256 held = snap.lenderCollateral +
                snap.treasuryCollateral +
                snap.borrowerCollateral;
            if (held > 0) {
                // #821 (Codex #832 r2 P1) — vault-lock the restored collateral so
                // a flagged stored borrower doesn't brick the fallback cure; it
                // lands in the borrower's OWN vault, frozen behind the claim gate
                // (T-051 — the Diamond-side transfer ticks protocolTrackedVaultBalance).
                LibSanctionedLock.depositLocked(
                    s, loan.borrower, loanId, loan.collateralAsset, held
                );
                // #998 S10 (#1006 / #1132) — the borrower-side fail-closed marker
                // is recorded centrally at the `Repaid` transition above
                // (terminalizeFromAny); the restored collateral just satisfies the
                // borrower claim recorded earlier.
                // #569 Codex #572 round-5 P1 — RE-LIEN the restored
                // collateral. The lien was released at default-entry
                // (when the loan went FallbackPending), so the snapshot
                // collateral just pushed back into the borrower vault is
                // currently UNencumbered while it sits as the borrower
                // claim recorded above. Re-create the lien for `held`
                // (create-if-absent on the released row) so it stays
                // protected through the Repaid→claim gap and is released
                // atomically inside `ClaimFacet.claimAsBorrower`. Without
                // this, the stored borrower could drain the restored
                // collateral (VPFI via `withdrawVPFIFromVault`) before a
                // transferee claimant claims it. ERC20-only (D-1).
                _callEncumb2(
                    EncumbranceMutateFacet.incrementCollateralLien.selector,
                    loanId,
                    held
                );
            }
            delete s.fallbackSnapshot[loanId];
            // #630 — drop any Role-B cash-exit opt-in on cure; a later fallback
            // must be re-authorized by the then-current lender-NFT owner.
            delete s.lenderBackstopOptIn[loanId];
        }

        // §3.7 — full repay terminates the loan: outstandingPrincipal &
        // accruedInterest are both 0; newStatus is whatever the lifecycle
        // library just transitioned to (typically `Repaid`).
        emit LoanRepaid(
            loanId,
            msg.sender,
            interest,
            lateFee,
            /* outstandingPrincipal */ 0,
            /* accruedInterest */ 0,
            loan.status
        );
    }

    /**
     * @notice Makes a partial repayment on an active loan.
     * @dev For ERC20: Repays specified principal amount + accrued interest to date. Updates loan.principal.
     *      For NFT: Repays for specified days (deducts days * amount from prepay), reduces durationDays and prepayAmount.
     *      Distributes accrued fees. No late fees in partial (handled on full).
     *      Checks post-HF >= min. Reverts if insufficient or past grace.
     *      Emits PartialRepaid.
     *      Callable only by borrower.
     * @param loanId The loan ID.
     * @param partialAmount The partial principal (ERC20) or days (NFT) to repay.
     */
    function repayPartial(
        uint256 loanId,
        uint256 partialAmount
    ) external nonReentrant whenNotPaused {
        // T-090 v1.1 (#389) §5.8 — partial repay still pulls from
        // `loan.borrower`'s vault; block while a v1.1 commit is live.
        LibVaipakam.assertNoLiveIntentCommit(loanId);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // #594 — repayPartial is BOTH-SIDE: the ERC-20 partial path pays
        // `partialAmount + lenderShare` directly to `loan.lender`, so a
        // transferred lender NFT mis-routes unless the lender side also
        // consolidates. Run before `requireBorrower` (stored-anchor auth) so it
        // sees the consolidated holder. Skip-not-block.
        LibConsolidation.consolidateToHolder(loanId, false, LibConsolidation.Ctx.Tier2CloseOut);
        LibConsolidation.consolidateToHolder(loanId, true, LibConsolidation.Ctx.Tier2CloseOut);
        LibAuth.requireBorrower(loan);
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert InvalidLoanStatus();
        // Lender-opt-in gate. The flag was snapshotted onto the loan
        // at init from `Offer.allowsPartialRepay` — see
        // {LibVaipakam.Offer.allowsPartialRepay} for the consent
        // mechanism on each offer side. Default-false: a loan with
        // no explicit opt-in cannot be partial-repaid.
        if (!loan.allowsPartialRepay) revert PartialRepayNotAllowed();
        if (partialAmount == 0) revert InsufficientPartialAmount();
        // #956 (Codex #978) — the asset-level minimum-partial floor is denominated
        // in ERC-20 principal units (`loan.principal * bps`). For an NFT rental
        // `partialAmount` is a DAY count while `loan.principal` is the daily fee in
        // token base units, so applying the floor there would compare days against
        // token units and wrongly revert legitimate rental-day reductions. Scope
        // the floor to ERC-20 loans; the NFT-rental path below has its own
        // day-based validation. (SwapToRepayFacet needs no such guard — its
        // `partialPrincipal` is always a swapped token amount.)
        if (loan.assetType == LibVaipakam.AssetType.ERC20) {
            uint256 minPartial = (loan.principal *
                s.assetRiskParams[loan.principalAsset].minPartialBps) /
                LibVaipakam.BASIS_POINTS;
            if (partialAmount < minPartial) revert InsufficientPartialAmount();
        }

        uint256 endTime = loan.startTime +
            loan.durationDays *
            LibVaipakam.ONE_DAY;
        uint256 graceEnd = endTime + LibVaipakam.gracePeriod(loan.durationDays);
        if (block.timestamp > graceEnd) revert RepaymentPastGracePeriod();
        address treasury = LibFacet.getTreasury();

        // Pass-2 A2 (#1190) — capture the PRE-partial health factor for the
        // monotonicity gate at the end. Only liquid-on-both-legs loans carry an
        // HF (illiquid/NFT-rental legs have none), matching the post-repay gate.
        bool hfGated = loan.collateralLiquidity == LibVaipakam.LiquidityStatus.Liquid &&
            loan.principalLiquidity == LibVaipakam.LiquidityStatus.Liquid;
        uint256 hfBefore;
        if (hfGated) {
            hfBefore = abi.decode(
                LibFacet.crossFacetStaticCall(
                    abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
                    HealthFactorCalculationFailed.selector
                ),
                (uint256)
            );
        }

        uint256 accrued;
        if (loan.assetType == LibVaipakam.AssetType.ERC20) {
            // ERC20: Accrued to now + partial principal.
            // Pass-2 A3 (#1191) — CREDIT any periodic-settled interest so the
            // partial charges only the UNSETTLED accrual. On a periodic-cadence
            // loan an auto-liquidated period credits `interestSettled` while the
            // accrual clock keeps running from the segment start, so the raw
            // `accruedInterestToTime` gross would RE-charge the already-settled
            // days (the audit's M1). `creditSettledInterest` nets it out; the
            // stale `interestSettled` is then zeroed at the clock reset below
            // (mirrors PrecloseFacet / RiskFacet's #915 credit+zero).
            uint256 grossAccrued = LibEntitlement.accruedInterestToTime(loan, block.timestamp);
            uint256 priorSettled = uint256(loan.interestSettled);
            accrued = LibEntitlement.creditSettledInterest(loan, grossAccrued);
            (uint256 treasuryShare, uint256 lenderShare) = LibEntitlement.splitTreasury(
                loan,
                accrued
            );

            // #1383 — honor the lender Full/hold discount (§F2 / #1354) for the
            // CURRENT lender-NFT holder (this partial path does NOT reliably
            // consolidate `loan.lender`). The shift is treasury→lender; the
            // lender payout below reads the increased `lenderShare` and the
            // treasury transfer the reduced `treasuryShare`. Dark until cut-over.
            {
                (uint256 lenderExtra, uint256 newTreasury) = _hostResolveLenderYieldFee(
                    loan.id,
                    IERC721(address(this)).ownerOf(loan.lenderTokenId),
                    accrued,
                    treasuryShare
                );
                if (lenderExtra > 0) {
                    lenderShare += lenderExtra;
                    treasuryShare = newTreasury;
                }
            }

            // #921 item 3 — reject a "partial" that would retire the FULL
            // remaining principal (`>=`, not just overshoot). This path only
            // decrements `loan.principal`; it runs no settlement / collateral
            // release / NFT burn, so `partialAmount == loan.principal` would
            // leave the loan Active at principal 0 (a zombie) until a separate
            // `repayLoan`. Force full retirement through `repayLoan`.
            if (partialAmount >= loan.principal)
                revert PartialWouldRetireFullPrincipal();

            // Pay accrued + partial to the CURRENT lender-position holder.
            //
            // Codex #659 P2 — the both-side consolidation hook above re-anchors
            // `loan.lender` to `ownerOf(lenderTokenId)` in the common case, but
            // it is deliberately SKIPPED when the lender side carries unreserved
            // `heldForLender` VPFI (`_isExcludedLive`, #597 dependency). In that
            // narrow case `loan.lender` can still be stale, and unlike the full
            // repay path (vault deposit + claim + #592 encumbrance) this partial
            // pays the lender DIRECTLY, so a stale anchor would hand the departed
            // lender the principal+interest while the current NFT holder's owed
            // principal is reduced. Resolve the recipient from NFT ownership —
            // the canonical authority (see the self-repay guard's rationale in
            // `repayLoan`) — so the payout is correct regardless of whether the
            // consolidation ran or was skipped. The loan is Active here, so the
            // lender NFT is live (never burned pre-terminal) and `ownerOf` holds.
            // #998 S10 (#1006) Class B — this is a DIRECT inline payout (no
            // vault+claim deferral like full repay). Pay the CURRENT lender-position
            // holder inline when clean, or FREEZE fail-closed (park payer → stored
            // lender vault + `heldForLender` + encumber + marker) when the holder is
            // registry-flagged. Replaces the prior fail-open `_assertNotSanctioned`,
            // which would pay a previously-confirmed-flagged holder during an oracle
            // outage. Hosted on `EncumbranceMutateFacet`: the host resolves
            // `ownerOf(lenderTokenId)` and, on the clean path, pays the combined
            // principal-repayment + interest share via `safeTransferFrom(msg.sender)`
            // exactly as before.
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EncumbranceMutateFacet.freezeOrPayActiveLenderFromPayer.selector,
                    loan.id,
                    msg.sender,
                    loan.principalAsset,
                    partialAmount + lenderShare
                ),
                bytes4(0)
            );
            // #1383 — guard the transfer: the yield-fee discount can drive the
            // treasury share to 0 (VPFI-payment path), which was impossible when
            // this transfer was unconditional.
            if (treasuryShare > 0) {
                IERC20(loan.principalAsset).safeTransferFrom(
                    msg.sender,
                    treasury,
                    treasuryShare
                );
                LibFacet.recordTreasuryAccrual(loan.principalAsset, treasuryShare);
            }

            unchecked {
                loan.principal -= partialAmount;
            }
            // #408 / #410 / #413 (2026-06-12) — Option A: track
            // remaining committed term. The accrual clock reset
            // below (`interestAccrualStart = now`) measures `elapsedDays`
            // from the most recent partial. To keep the floor in
            // `LibEntitlement.settlementInterest` reflecting the
            // borrower's REMAINING commitment (not the original),
            // decrement `interestRemainingDays` by the elapsed days since
            // the segment's start. After this, `max(elapsed, remaining)`
            // in the floor uses the post-partial remaining term as the
            // lower bound.
            //
            // #641 — the re-stamp now lands on the dedicated INTEREST clock
            // (`interestAccrualStart` / `interestRemainingDays`); the term
            // tuple (`startTime` + `durationDays`) is LEFT UNTOUCHED so the
            // loan's maturity + grace window are preserved. (Pre-#641 this
            // reset `startTime` and shrank `durationDays`, which silently
            // pulled the default deadline earlier and — fatally — let a tiny
            // post-maturity partial reset the grace clock and roll the
            // lender's recovery deadline.)
            //
            // Codex round-1 P1 (PR #559): DO NOT ACCUMULATE into
            // `loan.interestSettled` here. The combined state reset
            // (`principal -=`, `interestRemainingDays -=`,
            // `interestAccrualStart =`) makes the next settlement FUTURE-ONLY:
            // `gross = proRataInterest(remainingPrincipal, rate, remainingDays)`.
            // Adding the partial's paid interest to the accumulator AND
            // subtracting it from a future-only gross would double-count.
            //
            // Pass-2 A3 (#1191): but a PRE-EXISTING `interestSettled` (credited
            // by a periodic auto-liquidation BEFORE this partial) is now stale
            // — it was already netted from the partial's charge via
            // `creditSettledInterest` above, and leaving it non-zero would let
            // `settlementInterestNet`/`currentBorrowBalance` subtract it a
            // SECOND time from the future-only window (understating HF, delaying
            // liquidation, underpaying the lender at final settle). So ZERO it
            // at the reset below — the #915 credit+zero pattern
            // (PrecloseFacet:886 / RiskFacet).
            //
            // #641 — seed the interest clock from the term for any loan that
            // predates the fields, so the elapsed math below doesn't compute
            // from timestamp 0 and zero out the remaining term.
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
            // T-034 — interestAccrualStart downsized to uint64; explicit cast.
            loan.interestAccrualStart = uint64(block.timestamp); // Reset accrual start
            // Pass-2 A3 (#1191) — consume ONLY the portion of the settled credit
            // that this partial's charge just netted (`grossAccrued`), and
            // PRESERVE any excess. A periodic auto-liquidation can OVERDELIVER
            // (it credits actual slippage-buffered `lenderProceeds`, which may
            // exceed the interest accrued by the time this partial runs), so a
            // partial before enough future interest accrues would otherwise
            // forfeit the borrower's already-paid excess and later OVERSTATE the
            // debt (Codex #1229). The clock is reset above, so the surviving
            // `interestSettled - grossAccrued` correctly credits future accrual.
            loan.interestSettled = priorSettled > grossAccrued
                ? priorSettled - grossAccrued
                : 0;

            // §3.10 — accrual clock reset right above (loan.interestAccrualStart
            // = block.timestamp), so accruedInterest at emit is 0.
            emit PartialRepaid(loanId, partialAmount, loan.principal, /* accruedInterest */ 0);

            // T-034 §4.5 — track the interest portion that just settled
            // against the period accumulator, and advance the checkpoint
            // inline if the borrower's payment crossed the boundary AND
            // covered the period's expected interest. The lender already
            // received `lenderShare` (the full accrued interest from
            // `loan.startTime`-was to now) in the safeTransferFrom above,
            // so the period accumulator must record that as settled
            // interest. Capped at uint128.max defensively — the field is
            // sized to hold ~3.4×10^38 wei, well above any realistic
            // single-period interest amount.
            if (loan.periodicInterestCadence !=
                LibVaipakam.PeriodicInterestCadence.None) {
                // Pass-2 A3 (#1191, Codex #1229) — credit the NETTED `accrued`
                // (interest CHARGED in cash this partial), NOT the gross.
                // `grossAccrued` accrues from `interestAccrualStart`, which the
                // periodic auto-liquidation does NOT reset when it advances a
                // checkpoint (only `interestPaidSinceLastPeriod` is zeroed), so
                // `grossAccrued` still spans the already-settled period(s). Adding
                // it here would let a post-auto-settle partial credit old interest
                // into the NEW period, mark it paid without a current-period
                // payment, and skip a required auto-liquidation — underpaying the
                // lender (Codex #1229 round 3, P1). The netted `accrued` never
                // over-credits. The exact CURRENT-period attribution (which would
                // also carry a prior over-delivery's excess forward, Codex #1229
                // round 2) needs the accrual clock reconciled against
                // `lastPeriodicInterestSettledAt` — deferred to #1230.
                uint256 newPaid = uint256(loan.interestPaidSinceLastPeriod) +
                    accrued;
                if (newPaid > type(uint128).max) {
                    newPaid = type(uint128).max;
                }
                loan.interestPaidSinceLastPeriod = SafeCast.toUint128(newPaid);
                if (LibPeriodicInterest.canAdvanceCheckpointInline(loan)) {
                    uint256 boundary = LibPeriodicInterest.periodEndAt(loan);
                    uint256 expected =
                        LibPeriodicInterest.expectedInterestForPeriod(loan);
                    LibPeriodicInterest.advanceCheckpoint(loan);
                    emit RepayPartialPeriodAdvanced(
                        loanId,
                        boundary,
                        expected,
                        msg.sender
                    );
                    emit PeriodicInterestSettled(
                        loanId,
                        boundary,
                        expected,
                        newPaid,
                        msg.sender
                    );
                }
            }
        } else {
            // NFT: Deduct for partialDays (partialAmount = days)
            // Pass-2 D1 (#1188) — bound by REMAINING days, not the (now
            // immutable) `durationDays` term. `durationDays` is the fixed
            // maturity; remaining = term − days already consumed (tracked by
            // `lastDeductTime`).
            if (partialAmount > LibVaipakam.remainingRentalDays(loan))
                revert InsufficientPartialAmount();

            accrued = loan.principal * partialAmount; // Daily fee * days

            if (accrued > loan.prepayAmount) revert InsufficientPrepay();

            (uint256 treasuryShare, uint256 lenderShare) = LibEntitlement.splitTreasury(
                loan,
                accrued
            );

            // #1383 — honor the lender Full/hold discount for the CURRENT
            // lender-NFT holder (rentals skip the eager consolidation, so
            // `loan.lender` can be stale). Shift is treasury→lender.
            {
                (uint256 lenderExtra, uint256 newTreasury) = _hostResolveLenderYieldFee(
                    loan.id,
                    IERC721(address(this)).ownerOf(loan.lenderTokenId),
                    accrued,
                    treasuryShare
                );
                if (lenderExtra > 0) {
                    lenderShare += lenderExtra;
                    treasuryShare = newTreasury;
                }
            }

            // #569 D-1 (2026-06-13) — NFT rentals carry no collateral
            // lien (the prepay pool is drained by this very mechanism,
            // not protected by a lien), so no decrement here.

            // #998 S10 (#1006) Class B — the lender's prepay share is pulled from
            // the payer's (`msg.sender`) own rental prepay vault. NFT-rental loans
            // skip the eager consolidation at this function's start, so `loan.lender`
            // can be stale; the host resolves the LIVE `ownerOf(lenderTokenId)`.
            // Pay that current holder inline when clean, or FREEZE fail-closed (park
            // payer-vault → stored-lender vault + `heldForLender` + encumber +
            // marker) when they are registry-flagged, replacing the fail-open
            // `_assertNotSanctioned`. The host arms the from-side move-out exemption
            // around the withdraw so a borrower flagged after init can still service
            // the partial rental (Tier-2 stays open) — the payer loses custody.
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EncumbranceMutateFacet.freezeOrPayActiveLenderFromVault.selector,
                    loan.id,
                    msg.sender,
                    loan.prepayAsset,
                    lenderShare
                ),
                bytes4(0)
            );

            // #821 (Codex #832 r3 P1) — the treasury deduction also pulls the
            // prepay from the payer's own vault; arm the move-out exemption so a
            // borrower flagged after init can still service the partial rental.
            // #1383 — guarded: the yield-fee discount can drive the share to 0.
            if (treasuryShare > 0) {
                LibSanctionedLock.beginMoveOut(LibVaipakam.storageSlot(), msg.sender);
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultWithdrawERC20.selector,
                        msg.sender,
                        loan.prepayAsset,
                        treasury,
                        treasuryShare
                    ),
                    TreasuryTransferFailed.selector
                );
                LibSanctionedLock.endMoveOut(LibVaipakam.storageSlot());
            }
            LibFacet.recordTreasuryAccrual(loan.prepayAsset, treasuryShare);

            // Pass-2 D1 (#1188) — keep `durationDays` immutable (fixed
            // maturity); advance `lastDeductTime` by the days paid so
            // `remainingRentalDays` and consumed-days derivations stay exact,
            // mirroring `autoDeductDaily`'s per-day advance.
            unchecked {
                loan.prepayAmount -= accrued;
                loan.lastDeductTime += uint64(partialAmount * LibVaipakam.ONE_DAY);
            }

            // Update renter expires. With `durationDays` immutable this is the
            // FIXED origination maturity (no longer shrinks) — the #893 join.
            uint64 newExpires = uint64(
                loan.startTime + loan.durationDays * LibVaipakam.ONE_DAY
            );
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultSetNFTUser.selector,
                    loan.lender,
                    loan.principalAsset,
                    loan.tokenId,
                    msg.sender, // Still renter
                    newExpires
                ),
                NFTRenterUpdateFailed.selector
            );

            // NFT-rental partial repay: the third slot reuses `newPrincipal`
            // to carry the remaining duration in days (no ERC-20 principal
            // exists here). accruedInterest is N/A for rentals — emitted as 0.
            // Pass-2 D1 (#1188) — `durationDays` is now the immutable term, so
            // report the DERIVED remaining rental days as the post-partial
            // "newPrincipal" value (event consumers mirror this for remaining
            // duration; the immutable term would mislead them).
            emit PartialRepaid(
                loanId,
                partialAmount,
                LibVaipakam.remainingRentalDays(loan),
                /* accruedInterest */ 0
            );
        }

        if (hfGated) {
            // Pass-2 A2 (#1190) — MONOTONICITY gate, not an admission floor. The
            // old check reverted unless post-repay HF >= the 1.5 ADMISSION floor,
            // which was INVERTED: a partial reduces principal + resets accrued
            // interest with collateral still liened, so HF strictly improves —
            // the floor could only bind when the loan was already sub-1.5 and the
            // partial didn't fully restore it, blocking exactly the deleveraging
            // the lender most wants (HF 1.2 → a partial lifting it to 1.4 would
            // revert). Spec §1161-1164 grants partial repayment with no
            // post-payment HF condition; §1362's directional rule is "strictly
            // improve HF", never re-admit at 1.5. So assert only that the partial
            // does not WORSEN HF (defensive; it never should in practice).
            uint256 hfAfter = abi.decode(
                LibFacet.crossFacetStaticCall(
                    abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
                    HealthFactorCalculationFailed.selector
                ),
                (uint256)
            );
            if (hfAfter < hfBefore) revert PartialRepayWorsensHealthFactor(hfBefore, hfAfter);
        }
    }

    /**
     * @notice View function to calculate the repayment amount for a loan.
     * @dev Includes principal, configured interest (per-loan flag), and late fees (if applicable).
     *      Enhanced for NFTs: Returns prepay due (accrued rental + late) + refunds unused.
     *      But for repay call, borrower approves total principal (unused refunded internally).
     * @param loanId The loan ID.
     * @return totalDue The total repayment amount (principal + interest + lateFee for ERC20; 0 for NFT as from prepay).
     */
    function calculateRepaymentAmount(
        uint256 loanId
    ) external view returns (uint256 totalDue) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // #1000 (S2, Codex #1069) — a FallbackPending loan is now curable by full
        // repayment (past grace), so the quote view must price it too; frontends
        // and keepers set the borrower's approval/amount from this view, and a
        // 0 quote would under-approve and brick the cure. The settlement math
        // below (settlementInterestNet + late fee) is identical for the cure.
        if (
            loan.status != LibVaipakam.LoanStatus.Active &&
            loan.status != LibVaipakam.LoanStatus.FallbackPending
        ) return 0;

        uint256 endTime = loan.startTime +
            loan.durationDays *
            LibVaipakam.ONE_DAY;

        // Interest/Rental based on per-loan flag
        uint256 interest;
        uint256 elapsed = block.timestamp - loan.startTime;
        uint256 elapsedDays = elapsed / LibVaipakam.ONE_DAY;
        if (loan.assetType == LibVaipakam.AssetType.ERC20) {
            // #408 / #410 / #413 (2026-06-12) — route through the
            // unified `settlementInterestNet` so this view matches
            // what `LibSettlement.computeRepayment` charges at
            // actual settlement. Pre-fix this branch used the bare
            // `fullTermInterest` (capped at duration → blocked grace
            // accrual) AND ignored `interestSettled` (over-charged
            // after partial-repay / periodic). Both bugs collapse
            // here too — the view must agree with the settler.
            interest = LibEntitlement.settlementInterestNet(
                loan,
                block.timestamp
            );
            totalDue = loan.principal + interest;
        } else {
            // NFT: Accrued rental (excluding already-deducted days)
            // Pass-2 D1 (#1188) — guarded consumed-days derivation (safe even
            // if a legacy/imported rental still has lastDeductTime == 0).
            uint256 alreadyDeductedDays = LibVaipakam.consumedRentalDays(loan);
            if (loan.useFullTermInterest) {
                // Pass-2 D1 (#1188) — remaining owed days, not the immutable
                // `durationDays` term (mirrors the settler at repayLoan so the
                // preview matches settlement).
                interest = loan.principal * LibVaipakam.remainingRentalDays(loan);
            } else {
                uint256 undeductedDays = elapsedDays > alreadyDeductedDays
                    ? elapsedDays - alreadyDeductedDays
                    : 0;
                interest = loan.principal * undeductedDays;
            }
            totalDue = 0; // From prepay; borrower approves principal for safety, but internal deduct
        }

        // Late fee if past endTime. #998 S8 (#1004) — the rental branch quotes
        // the remaining-rental-based fee so this preview matches what
        // `repayLoan` charges at settlement (else a late-rental preview would
        // under-quote the fee).
        uint256 lateFee = 0;
        if (block.timestamp > endTime) {
            lateFee = loan.assetType == LibVaipakam.AssetType.ERC20
                ? LibVaipakam.calculateLateFee(loanId, endTime)
                : LibVaipakam.calculateRentalLateFee(loanId, endTime);
        }

        totalDue += lateFee;
    }

    /// @dev #407 PR 4 (T-407-B, 2026-06-12) — extracted from
    ///      `repayLoan` so the cross-facet release-call's transient
    ///      locals (`abi.encodeWithSelector` payload + selector) live
    ///      in their own stack frame. The inline form inside
    ///      `repayLoan` tripped viaIR's "Variable size 1 too deep" —
    ///      that function carries the asset-type branch + settlement
    ///      plan + Tier-1 / Tier-2 transfer scaffolding, so it's
    ///      perpetually close to solc's stack ceiling.
    /// @dev #407 PR 4 round-1 (2026-06-12) — consolidated cross-facet
    ///      lien helpers. One per arg-shape; each call site picks the
    ///      selector. Replaces the per-selector helpers that grew
    ///      bytecode without saving anything material (#568 tracks the
    ///      structural fix).
    function _callEncumb2(bytes4 selector, uint256 loanId, uint256 arg2) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(selector, loanId, arg2),
            bytes4(0)
        );
    }

    /// @dev #1383 — resolve the lender yield-fee discount for `settlingLender`
    ///      via the `VPFIDiscountFacet` host (delivery bytecode stays off this
    ///      at-EIP-170 facet). `repayPartial` does NOT reliably consolidate
    ///      `loan.lender` (the #597 `heldForLender` exclusion), so its call
    ///      sites pass the CURRENT `ownerOf(lenderTokenId)`. Returns the deltas
    ///      to fold in (`lenderShare += lenderExtra; treasuryShare = newTreasury`).
    function _hostResolveLenderYieldFee(
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
            bytes4(0)
        );
        (lenderExtra, newTreasury, ) = abi.decode(ret, (uint256, uint256, uint256));
    }
}
