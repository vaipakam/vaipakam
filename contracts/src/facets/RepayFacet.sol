// src/facets/RepayFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibSettlement} from "../libraries/LibSettlement.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibPeriodicInterest} from "../libraries/LibPeriodicInterest.sol";
import {LibSwap} from "../libraries/LibSwap.sol";
import {LibFallback} from "../libraries/LibFallback.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {EscrowFactoryFacet} from "./EscrowFactoryFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {VPFIDiscountFacet} from "./VPFIDiscountFacet.sol";


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
 *                             borrower's escrowed prepay).
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
 *      borrower's escrow, and transitions to Repaid.
 */
contract RepayFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    using SafeERC20 for IERC20;

    /// @notice Emitted when a loan is successfully repaid.
    /// @param loanId The ID of the repaid loan.
    /// @param repayer The address that submitted the repayment (may differ from borrower).
    /// @param interestPaid The interest paid (full-term or pro-rata based on per-loan config).
    /// @param lateFeePaid The late fee paid (if applicable).
    event LoanRepaid(
        uint256 indexed loanId,
        address indexed repayer,
        uint256 interestPaid,
        uint256 lateFeePaid
    );

    /// @notice Full settlement breakdown for an ERC-20 loan being closed
    ///         (repayLoan or precloseDirect). Emitted in addition to the
    ///         status-specific event so indexers can reconstruct the exact
    ///         amounts routed to treasury vs. lender without re-reading storage.
    /// @dev Invariant: `treasuryShare + lenderShare == interest + lateFee`.
    ///      `principal` is the amount returned to the lender's escrow as claimable.
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
    event PartialRepaid(
        uint256 indexed loanId,
        uint256 amountRepaid,
        uint256 newPrincipal
    );

    /// @notice Emitted when auto daily deduct is triggered for an NFT rental.
    /// @param loanId The ID of the loan.
    /// @param dayFeeDeducted The daily fee deducted.
    event AutoDailyDeducted(uint256 indexed loanId, uint256 dayFeeDeducted);

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
    event PeriodicInterestSettled(
        uint256 indexed loanId,
        uint256 periodEndAt,
        uint256 expected,
        uint256 paidByBorrower,
        address indexed settler
    );

    /// @notice Emitted when {settlePeriodicInterest} sold collateral to
    ///         cover a period's shortfall. Mirrors the existing HF-
    ///         liquidation split (slippage-driven liquidator bonus,
    ///         flat 2% treasury handling fee, lender gets the rest)
    ///         per docs/FunctionalSpecs/ProjectDetailsREADME.md
    ///         §"Equivalent Collateral Transfer for Liquid Asset
    ///         during Abnormal Periods".
    /// @param loanId The loan whose collateral was partially sold.
    /// @param periodEndAt Timestamp of the period boundary that closed.
    /// @param shortfall The interest shortfall that triggered the sale.
    /// @param collateralSold Amount of collateral asset withdrawn from
    ///        the borrower's escrow and offered to the swap try-list.
    /// @param lenderProceeds Principal-asset amount credited to the
    ///        lender's escrow as the period's interest payment.
    /// @param settlerBonus Principal-asset amount paid to `msg.sender`
    ///        as the slippage-driven incentive.
    /// @param treasuryShare Principal-asset amount paid to treasury as
    ///        the 2% liquidation handling fee.
    /// @param settler `msg.sender` of the settle call.
    event PeriodicInterestAutoLiquidated(
        uint256 indexed loanId,
        uint256 periodEndAt,
        uint256 shortfall,
        uint256 collateralSold,
        uint256 lenderProceeds,
        uint256 settlerBonus,
        uint256 treasuryShare,
        address indexed settler
    );

    /// @notice Informational. Emitted alongside
    ///         {PeriodicInterestAutoLiquidated} when the realized swap
    ///         output came in BELOW the shortfall after the standard
    ///         3% bonus + 2% handling fee — i.e. lender got less than
    ///         the interest they were owed despite the swap clearing
    ///         the slippage gate. Off-chain monitors may aggregate
    ///         this to spot DEX-side regression.
    event PeriodicSlippageOverBuffer(
        uint256 indexed loanId,
        uint256 expectedShortfall,
        uint256 actualLenderProceeds
    );

    /// @notice Emitted when {repayPartial} folds the period checkpoint
    ///         advance inline — i.e. the borrower's payment crossed a
    ///         period boundary AND covered the period's expected
    ///         interest in full. Off-chain consumers correlate this
    ///         with the standard {PartialRepaid} fired in the same tx.
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
    error NotDailyYet();
    error NotNFTRental();
    /// @notice Reverted when {repayPartial} is called on a loan whose
    ///         `allowsPartialRepay` flag is false. The flag is
    ///         lender-controlled — set on the offer at create-time
    ///         (lender offers) or carried from the source offer at
    ///         loan init (borrower offers, where the lender's accept
    ///         is consent to the borrower's create-time request).
    ///         Default-false: every loan must opt in explicitly.
    error PartialRepayNotAllowed();

    /**
     * @notice Repays an active loan in full.
     * @dev Caller must approve totalDue (from calculateRepaymentAmount).
     *      Handles ERC20/NFT differently: For ERC20, pays principal + interest/late.
     *      For NFT, deducts accrued rental from prepay, refunds unused + buffer.
     *      Distributes fees: 99% lender, 1% treasury.
     *      Releases collateral/resets renter, burns NFTs, sets status Repaid.
     *      Reverts if past grace. For NFT rentals, reverts if not borrower
     *      (rental fees are deducted from borrower's escrowed prepayment).
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
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // FallbackPending is accepted: a full repay cures the failed
        // liquidation, clears the snapshot, and returns diamond-held collateral
        // to the borrower escrow before the normal Repaid flow runs.
        if (
            loan.status != LibVaipakam.LoanStatus.Active &&
            loan.status != LibVaipakam.LoanStatus.FallbackPending
        ) revert InvalidLoanStatus();
        bool curingFallback = loan.status == LibVaipakam.LoanStatus.FallbackPending;

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
        // prepay escrow regardless of caller.
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
        if (block.timestamp > graceEnd) revert RepaymentPastGracePeriod();

        uint256 interest; // Or rental fee
        uint256 lateFee = LibVaipakam.calculateLateFee(loanId, endTime);
        address treasury = LibFacet.getTreasury();

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
            // VPFI in escrow, the 1% treasury cut is paid in VPFI from the
            // lender's escrow and the lender keeps 100% of interest+lateFee
            // in the lending asset. tryApplyYieldFee returns (false, 0) on
            // any precondition failure — we then fall through to the normal
            // ERC-20 split.
            uint256 yieldVpfiDeducted;
            if (s.vpfiDiscountConsent[loan.lender] && plan.treasuryShare > 0) {
                bool yieldApplied;
                (yieldApplied, yieldVpfiDeducted) = LibVPFIDiscount
                    .tryApplyYieldFee(
                        loan,
                        plan.interest + plan.lateFee
                    );
                if (yieldApplied) {
                    plan.lenderShare = plan.interest + plan.lateFee;
                    plan.lenderDue = plan.principal + plan.lenderShare;
                    plan.treasuryShare = 0;
                }
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

            // T-037 — Lender's due: borrower → lender's escrow in ONE
            // transfer. The Diamond carries the borrower's allowance
            // (granted by the prior `approve()`) so a direct
            // `safeTransferFrom` pushes the asset from the borrower's
            // wallet into the lender's escrow without ever residing on
            // the Diamond. Order matters: deploy the escrow first via
            // `getOrCreateEscrow` so the destination contract exists
            // when the ERC20 transferFrom lands. Saves one storage-
            // touching transfer and removes a transient
            // Diamond-balance-of(principalAsset) state.
            address lenderEscrow = LibFacet.getOrCreateEscrow(loan.lender);
            IERC20(loan.principalAsset).safeTransferFrom(
                msg.sender,
                lenderEscrow,
                plan.lenderDue
            );

            // Record lender's claimable (principal + interest). heldForLender handled by ClaimFacet.
            s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
                asset: loan.principalAsset,
                amount: plan.lenderDue,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                claimed: false
            });

            // Record borrower's claimable (collateral stays in borrower's escrow)
            s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
                asset: loan.collateralAsset,
                amount: loan.collateralAmount,
                assetType: loan.collateralAssetType,
                tokenId: loan.collateralTokenId,
                quantity: loan.collateralQuantity,
                claimed: false
            });

            emit LoanSettlementBreakdown(
                loanId,
                plan.principal,
                plan.interest,
                plan.lateFee,
                plan.treasuryShare,
                plan.lenderShare
            );

            // Passthrough-event for the yield fee VPFI discount, so indexers
            // subscribe to a single facet for all VPFI-discount analytics.
            if (yieldVpfiDeducted > 0) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VPFIDiscountFacet.emitYieldFeeDiscountApplied.selector,
                        loanId,
                        loan.lender,
                        loan.principalAsset,
                        yieldVpfiDeducted
                    ),
                    TreasuryTransferFailed.selector
                );
            }

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
            // NFT rental: only borrower can repay (fees come from borrower's escrowed prepayment)
            LibAuth.requireBorrower(loan);
            // Deduct accrued from prepay, excluding days already
            // deducted by autoDeductDaily. lastDeductTime advances by ONE_DAY
            // per auto-deduction, so (lastDeductTime - startTime) / ONE_DAY
            // gives the count of already-paid days.
            if (loan.prepayAmount == 0) revert InsufficientPrepay();

            uint256 alreadyDeductedDays = (loan.lastDeductTime - loan.startTime) /
                LibVaipakam.ONE_DAY;
            if (loan.useFullTermInterest) {
                // durationDays is already reduced by autoDeductDaily, so it
                // represents the remaining (unpaid) full-term days.
                interest = loan.principal * loan.durationDays;
            } else {
                uint256 elapsedDays = (block.timestamp - loan.startTime) /
                    LibVaipakam.ONE_DAY;
                uint256 undeductedDays = elapsedDays > alreadyDeductedDays
                    ? elapsedDays - alreadyDeductedDays
                    : 0;
                interest = loan.principal * undeductedDays;
            }

            uint256 totalDue = interest + lateFee;
            if (totalDue > loan.prepayAmount) revert InsufficientPrepay();

            (uint256 treasuryShare, uint256 lenderShare) = LibEntitlement.splitTreasury(
                totalDue
            );

            // Treasury share: immediate from borrower's escrow
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowWithdrawERC20.selector,
                    msg.sender,
                    loan.prepayAsset,
                    treasury,
                    treasuryShare
                ),
                TreasuryTransferFailed.selector
            );
            LibFacet.recordTreasuryAccrual(loan.prepayAsset, treasuryShare);

            // Lender's rental share: withdraw from borrower's escrow → Diamond → lender's escrow
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowWithdrawERC20.selector,
                    msg.sender,
                    loan.prepayAsset,
                    address(this),
                    lenderShare
                ),
                EscrowWithdrawFailed.selector
            );
            address lenderEscrow = LibFacet.getOrCreateEscrow(loan.lender);
            IERC20(loan.prepayAsset).safeTransfer(lenderEscrow, lenderShare);

            // Record lender's claimable rental fees. heldForLender handled by ClaimFacet.
            s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
                asset: loan.prepayAsset,
                amount: lenderShare,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                claimed: false
            });

            // Borrower's refund (unused prepay + buffer) stays in their escrow
            uint256 refund = loan.prepayAmount - totalDue + loan.bufferAmount;
            s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
                asset: loan.prepayAsset,
                amount: refund,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                claimed: false
            });

            // Reset renter immediately (operational — rental is over)
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowSetNFTUser.selector,
                    loan.lender,
                    loan.principalAsset,
                    loan.tokenId,
                    address(0),
                    0
                ),
                NFTRenterUpdateFailed.selector
            );
            // Note: ERC721 stays in lender's wallet; ERC1155 stays in lender's escrow.
            // No NFT movement needed at repay time.

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

        // Active or FallbackPending both legally transition to Repaid here
        // (normal close or cure-by-repay). LibLifecycle validates the edge.
        LibLifecycle.transitionFromAny(loan, LibVaipakam.LoanStatus.Repaid);

        // Phase 5 / §5.2b — proper-close settlement for the borrower LIF
        // VPFI path. Splits any Diamond-held VPFI between the borrower's
        // claimable rebate (scaled by time-weighted avg discount BPS) and
        // the treasury share. No-op on loans that took the lending-asset
        // fee path at init (vpfiHeld == 0).
        LibVPFIDiscount.settleBorrowerLifProper(loan);

        // Fallback cure: collateral was moved to the Diamond during the failed
        // swap attempt. Push it into the borrower escrow so the borrowerClaim
        // record written above (points at borrower escrow) is satisfiable,
        // then wipe the snapshot so the lender cannot double-dip.
        if (curingFallback) {
            LibVaipakam.FallbackSnapshot storage snap = s.fallbackSnapshot[loanId];
            uint256 held = snap.lenderCollateral +
                snap.treasuryCollateral +
                snap.borrowerCollateral;
            if (held > 0) {
                address borrowerEscrow = LibFacet.getOrCreateEscrow(loan.borrower);
                IERC20(loan.collateralAsset).safeTransfer(borrowerEscrow, held);
            }
            delete s.fallbackSnapshot[loanId];
        }

        emit LoanRepaid(loanId, msg.sender, interest, lateFee);
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
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
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
        uint256 minPartial = (loan.principal *
            s.assetRiskParams[loan.principalAsset].minPartialBps) /
            LibVaipakam.BASIS_POINTS;
        if (partialAmount < minPartial) revert InsufficientPartialAmount();

        uint256 endTime = loan.startTime +
            loan.durationDays *
            LibVaipakam.ONE_DAY;
        uint256 graceEnd = endTime + LibVaipakam.gracePeriod(loan.durationDays);
        if (block.timestamp > graceEnd) revert RepaymentPastGracePeriod();
        address treasury = LibFacet.getTreasury();

        uint256 accrued;
        if (loan.assetType == LibVaipakam.AssetType.ERC20) {
            // ERC20: Accrued to now + partial principal
            accrued = LibEntitlement.accruedInterestToTime(loan, block.timestamp);
            (uint256 treasuryShare, uint256 lenderShare) = LibEntitlement.splitTreasury(
                accrued
            );

            if (partialAmount > loan.principal)
                revert InsufficientPartialAmount();

            // Pay accrued + partial
            IERC20(loan.principalAsset).safeTransferFrom(
                msg.sender,
                loan.lender,
                partialAmount + lenderShare
            );
            IERC20(loan.principalAsset).safeTransferFrom(
                msg.sender,
                treasury,
                treasuryShare
            );
            LibFacet.recordTreasuryAccrual(loan.principalAsset, treasuryShare);

            unchecked {
                loan.principal -= partialAmount;
            }
            // T-034 — startTime downsized to uint64; explicit cast.
            loan.startTime = uint64(block.timestamp); // Reset accrual start

            emit PartialRepaid(loanId, partialAmount, loan.principal);

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
                uint256 newPaid = uint256(loan.interestPaidSinceLastPeriod) +
                    accrued;
                if (newPaid > type(uint128).max) {
                    newPaid = type(uint128).max;
                }
                loan.interestPaidSinceLastPeriod = uint128(newPaid);
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
            if (partialAmount > loan.durationDays)
                revert InsufficientPartialAmount();

            accrued = loan.principal * partialAmount; // Daily fee * days

            if (accrued > loan.prepayAmount) revert InsufficientPrepay();

            (uint256 treasuryShare, uint256 lenderShare) = LibEntitlement.splitTreasury(
                accrued
            );

            // Deduct from prepay (prepayAsset, not collateralAsset)
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowWithdrawERC20.selector,
                    msg.sender,
                    loan.prepayAsset,
                    loan.lender,
                    lenderShare
                ),
                EscrowWithdrawFailed.selector
            );

            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowWithdrawERC20.selector,
                    msg.sender,
                    loan.prepayAsset,
                    treasury,
                    treasuryShare
                ),
                TreasuryTransferFailed.selector
            );
            LibFacet.recordTreasuryAccrual(loan.prepayAsset, treasuryShare);

            unchecked {
                loan.prepayAmount -= accrued;
                loan.durationDays -= partialAmount;
            }

            // Update renter expires if reduced
            uint64 newExpires = uint64(
                loan.startTime + loan.durationDays * LibVaipakam.ONE_DAY
            );
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowSetNFTUser.selector,
                    loan.lender,
                    loan.principalAsset,
                    loan.tokenId,
                    msg.sender, // Still renter
                    newExpires
                ),
                NFTRenterUpdateFailed.selector
            );

            emit PartialRepaid(loanId, partialAmount, loan.durationDays);
        }

        if (loan.collateralLiquidity == LibVaipakam.LiquidityStatus.Liquid &&
            loan.principalLiquidity == LibVaipakam.LiquidityStatus.Liquid) {
            // Post-repay HF check
            bytes memory result = LibFacet.crossFacetStaticCall(
                abi.encodeWithSelector(
                    RiskFacet.calculateHealthFactor.selector,
                    loanId
                ),
                HealthFactorCalculationFailed.selector
            );
            uint256 hf = abi.decode(result, (uint256));
            if (hf < LibVaipakam.MIN_HEALTH_FACTOR) revert HealthFactorTooLow();
        }
    }

    /**
     * @notice Permissionless auto deduct for NFT rental daily fee.
     * @dev Callable by anyone after each day (checks lastDeductTime + 1 day <= now).
     *      Deducts one day's fee from prepay to lender (99%) and treasury (1%).
     *      Updates lastDeductTime, reduces prepayAmount and durationDays by 1.
     *      If insufficient prepay, reverts (default via DefaultedFacet).
     *      No incentive yet (Phase 2: Small bounty from treasury).
     *      Reverts if not NFT or not daily yet.
     *      Emits AutoDailyDeducted.
     * @param loanId The NFT rental loan ID.
     */
    function autoDeductDaily(uint256 loanId) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert InvalidLoanStatus();
        if (loan.assetType == LibVaipakam.AssetType.ERC20) revert NotNFTRental();

        if (block.timestamp < loan.lastDeductTime + LibVaipakam.ONE_DAY)
            revert NotDailyYet();

        uint256 dayFee = loan.principal; // Daily rental fee
        if (dayFee > loan.prepayAmount) revert InsufficientPrepay();

        (uint256 treasuryShare, uint256 lenderShare) = LibEntitlement.splitTreasury(
            dayFee
        );
        address treasury = LibFacet.getTreasury();

        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EscrowFactoryFacet.escrowWithdrawERC20.selector,
                loan.borrower,
                loan.prepayAsset,
                loan.lender,
                lenderShare
            ),
            EscrowWithdrawFailed.selector
        );

        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EscrowFactoryFacet.escrowWithdrawERC20.selector,
                loan.borrower,
                loan.prepayAsset,
                treasury,
                treasuryShare
            ),
            TreasuryTransferFailed.selector
        );
        LibFacet.recordTreasuryAccrual(loan.prepayAsset, treasuryShare);

        unchecked {
            loan.prepayAmount -= dayFee;
            loan.durationDays -= 1;
            loan.lastDeductTime += LibVaipakam.ONE_DAY;
        }

        // Update renter expires
        uint64 newExpires = uint64(
            loan.startTime + loan.durationDays * LibVaipakam.ONE_DAY
        );
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EscrowFactoryFacet.escrowSetNFTUser.selector,
                loan.lender,
                loan.principalAsset,
                loan.tokenId,
                loan.borrower,
                newExpires
            ),
            NFTRenterUpdateFailed.selector
        );

        // If duration 0, close the rental properly with claims and NFT updates
        if (loan.durationDays == 0) {
            // All rental fees have been deducted. Remaining prepay is just the buffer.
            // Lender gets the full rental (already deducted daily via this function).
            // The lender's claim for accumulated daily deductions is already in escrow.
            // Record a zero-amount lender claim so ClaimFacet can still return the NFT.
            s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
                asset: loan.prepayAsset,
                amount: 0,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                claimed: false
            });

            // Borrower gets buffer refund (stays in borrower's escrow)
            s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
                asset: loan.prepayAsset,
                amount: loan.bufferAmount,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                claimed: false
            });

            // Reset renter (non-critical — renter may have already expired)
            (bool ok, ) = address(this).call(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowSetNFTUser.selector,
                    loan.lender,
                    loan.principalAsset,
                    loan.tokenId,
                    address(0),
                    0
                )
            );
            ok; // discard

            // Update NFTs to Loan Repaid (non-critical)
            (ok, ) = address(this).call(
                abi.encodeWithSelector(
                    VaipakamNFTFacet.updateNFTStatus.selector,
                    loan.lenderTokenId,
                    loanId,
                    LibVaipakam.LoanPositionStatus.LoanRepaid
                )
            );
            (ok, ) = address(this).call(
                abi.encodeWithSelector(
                    VaipakamNFTFacet.updateNFTStatus.selector,
                    loan.borrowerTokenId,
                    loanId,
                    LibVaipakam.LoanPositionStatus.LoanRepaid
                )
            );
            ok; // silence unused warning

            LibLifecycle.transition(
                loan,
                LibVaipakam.LoanStatus.Active,
                LibVaipakam.LoanStatus.Repaid
            );
        }

        emit AutoDailyDeducted(loanId, dayFee);
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
        if (loan.status != LibVaipakam.LoanStatus.Active) return 0;

        uint256 endTime = loan.startTime +
            loan.durationDays *
            LibVaipakam.ONE_DAY;

        // Interest/Rental based on per-loan flag
        uint256 interest;
        uint256 elapsed = block.timestamp - loan.startTime;
        uint256 elapsedDays = elapsed / LibVaipakam.ONE_DAY;
        if (loan.assetType == LibVaipakam.AssetType.ERC20) {
            interest = loan.useFullTermInterest
                ? LibEntitlement.fullTermInterest(
                    loan.principal,
                    loan.interestRateBps,
                    loan.durationDays
                )
                : LibEntitlement.proRataInterest(
                    loan.principal,
                    loan.interestRateBps,
                    elapsedDays
                );
            totalDue = loan.principal + interest;
        } else {
            // NFT: Accrued rental (excluding already-deducted days)
            uint256 alreadyDeductedDays = (loan.lastDeductTime - loan.startTime) /
                LibVaipakam.ONE_DAY;
            if (loan.useFullTermInterest) {
                interest = loan.principal * loan.durationDays;
            } else {
                uint256 undeductedDays = elapsedDays > alreadyDeductedDays
                    ? elapsedDays - alreadyDeductedDays
                    : 0;
                interest = loan.principal * undeductedDays;
            }
            totalDue = 0; // From prepay; borrower approves principal for safety, but internal deduct
        }

        // Late fee if past endTime
        uint256 lateFee = 0;
        if (block.timestamp > endTime) {
            lateFee = LibVaipakam.calculateLateFee(loanId, endTime);
        }

        totalDue += lateFee;
    }

    // ─── T-034 — Periodic Interest Payment views ──────────────────────────

    /// @notice Preview the result of `settlePeriodicInterest(loanId)` at
    ///         the current block. Used by the loan-detail "Next interest
    ///         checkpoint" countdown card and by settler bots before
    ///         submitting a tx. Pure read; no state changes.
    /// @param loanId The loan to inspect.
    /// @return cadence The on-chain cadence enum value (0 = None).
    /// @return periodEndAt Timestamp of the next/current period boundary
    ///         (`lastPeriodicInterestSettledAt + intervalDays * 1 days`).
    ///         Zero when cadence is None.
    /// @return graceEndsAt `periodEndAt + gracePeriod(intervalDays)` —
    ///         the earliest moment a permissionless settler call is
    ///         allowed. Zero when cadence is None.
    /// @return expected Interest expected for the FULL period at the
    ///         current `loan.principal` and `loan.interestRateBps`.
    /// @return paidByBorrower Cumulative interest paid this period
    ///         (drawn from `loan.interestPaidSinceLastPeriod`).
    /// @return shortfall Saturating-non-negative `expected - paid`.
    /// @return canSettleNow True iff `block.timestamp >= graceEndsAt`
    ///         AND the loan is `Active` AND cadence is non-None — i.e.
    ///         a permissionless settler call would clear the
    ///         {PeriodicSettleNotDue} guard right now.
    function previewPeriodicSettle(uint256 loanId)
        external
        view
        returns (
            uint8 cadence,
            uint256 periodEndAt,
            uint256 graceEndsAt,
            uint256 expected,
            uint256 paidByBorrower,
            uint256 shortfall,
            bool canSettleNow
        )
    {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        cadence = uint8(loan.periodicInterestCadence);
        if (cadence == 0) {
            return (0, 0, 0, 0, 0, 0, false);
        }
        periodEndAt = LibPeriodicInterest.periodEndAt(loan);
        graceEndsAt = LibPeriodicInterest.settleAllowedFromAt(loan);
        expected = LibPeriodicInterest.expectedInterestForPeriod(loan);
        paidByBorrower = uint256(loan.interestPaidSinceLastPeriod);
        shortfall = LibPeriodicInterest.currentShortfall(loan);
        canSettleNow =
            loan.status == LibVaipakam.LoanStatus.Active &&
            block.timestamp >= graceEndsAt;
    }

    /// @notice Convenience view returning ONLY the upcoming-checkpoint
    ///         timestamp. Returns zero when the loan has no cadence.
    function nextPeriodCheckpoint(uint256 loanId)
        external
        view
        returns (uint256)
    {
        return LibPeriodicInterest.periodEndAt(
            LibVaipakam.storageSlot().loans[loanId]
        );
    }

    // ─── T-034 — settlePeriodicInterest entry point ───────────────────────

    /// @notice Permissionless settler. Closes the loan's current
    ///         periodic-interest period, advancing
    ///         `lastPeriodicInterestSettledAt` by exactly one cadence
    ///         interval. Two paths:
    ///
    ///         **Just-stamp** (shortfall == 0): borrower's voluntary
    ///         repayments already covered the period's expected
    ///         interest. Caller pays gas only — no settler bonus, no
    ///         collateral sale. Anyone may call; in practice the
    ///         borrower self-calls or the watcher batches it.
    ///
    ///         **Auto-liquidate** (shortfall > 0): caller-supplied swap
    ///         try-list sells just enough collateral to cover the
    ///         shortfall. Mirrors the existing HF-liquidation split:
    ///         settler bonus = `max(0, slippageCap - realizedSlippage)`,
    ///         capped at 3%; treasury 2% handling fee; lender gets the
    ///         rest. See docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md
    ///         §4.3.
    ///
    ///         Reverts {PeriodicSettleNotDue} before the period boundary
    ///         + grace window. Reverts {PeriodicInterestDisabled} when
    ///         the master kill-switch is off. Reverts
    ///         {PeriodicSettleSwapPathRequired} when shortfall > 0 but
    ///         caller passed empty `adapterCalls`. Reverts
    ///         {PeriodicSettleSwapFailed} when every swap adapter
    ///         reverts (settler retries with fresh quote).
    /// @param loanId Loan whose period is closing.
    /// @param adapterCalls Caller-ranked swap try-list. Ignored on the
    ///        just-stamp path; required (non-empty) on auto-liquidate.
    function settlePeriodicInterest(
        uint256 loanId,
        LibSwap.AdapterCall[] calldata adapterCalls
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ProtocolConfig storage cfg = s.protocolCfg;
        if (!cfg.periodicInterestEnabled) {
            revert IVaipakamErrors.PeriodicInterestDisabled();
        }
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert IVaipakamErrors.PeriodicSettleNotApplicable(loanId);
        if (loan.periodicInterestCadence == LibVaipakam.PeriodicInterestCadence.None)
            revert IVaipakamErrors.PeriodicSettleNotApplicable(loanId);
        uint256 graceEndsAt = LibPeriodicInterest.settleAllowedFromAt(loan);
        if (block.timestamp < graceEndsAt) {
            revert IVaipakamErrors.PeriodicSettleNotDue(
                loanId,
                LibPeriodicInterest.periodEndAt(loan),
                graceEndsAt
            );
        }
        // Tier-1 sanctions gate. Settler may receive a value bonus on
        // the auto-liquidate path; mirror the {triggerLiquidation}
        // policy.
        LibVaipakam._assertNotSanctioned(msg.sender);

        uint256 expected = LibPeriodicInterest.expectedInterestForPeriod(loan);
        uint256 paid = uint256(loan.interestPaidSinceLastPeriod);
        uint256 shortfall = paid >= expected ? 0 : expected - paid;
        uint256 boundary = LibPeriodicInterest.periodEndAt(loan);

        if (shortfall == 0) {
            // ── Just-stamp path ────────────────────────────────────────────
            LibPeriodicInterest.advanceCheckpoint(loan);
            emit PeriodicInterestSettled(
                loanId,
                boundary,
                expected,
                paid,
                msg.sender
            );
            return;
        }

        // ── Auto-liquidate path ───────────────────────────────────────────
        if (adapterCalls.length == 0) {
            revert IVaipakamErrors.PeriodicSettleSwapPathRequired(loanId, shortfall);
        }
        _autoLiquidatePeriodShortfall(loan, loanId, expected, paid, shortfall, boundary, adapterCalls);
    }

    /// @dev Auto-liquidate path body, factored out to keep the public
    ///      entry under the IR-stack budget. See `settlePeriodicInterest`
    ///      for the surrounding contract.
    function _autoLiquidatePeriodShortfall(
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        uint256 expected,
        uint256 paid,
        uint256 shortfall,
        uint256 boundary,
        LibSwap.AdapterCall[] calldata adapterCalls
    ) private {
        // Sell-amount sizing: aim for `shortfall × (1 + slippageCap)` of
        // collateral so the swap clears even in the worst-case slippage
        // scenario. If the loan's remaining collateral is smaller, sell
        // the entire collateral balance — the lender absorbs the
        // slippage on top. Settler still gets paid the slippage-driven
        // bonus on whatever proceeds came in.
        uint256 maxSlippageBps = LibVaipakam.cfgMaxLiquidationSlippageBps();
        uint256 collateralEquivalent = LibFallback.collateralEquivalent(
            address(this),
            shortfall,
            loan.collateralAsset,
            loan.principalAsset
        );
        // Add the slippage cap as an over-sell buffer (e.g. 6% extra
        // collateral so net proceeds clear `shortfall` after worst-
        // case slippage). Numeric over-flow safe — collateral amounts
        // are bounded.
        uint256 toSell = (collateralEquivalent *
            (LibVaipakam.BASIS_POINTS + maxSlippageBps)) /
            LibVaipakam.BASIS_POINTS;
        if (toSell > loan.collateralAmount) {
            toSell = loan.collateralAmount;
        }

        // Withdraw collateral to Diamond for swap (mirrors the HF-
        // liquidation withdraw shape).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EscrowFactoryFacet.escrowWithdrawERC20.selector,
                loan.borrower,
                loan.collateralAsset,
                address(this),
                toSell
            ),
            EscrowWithdrawFailed.selector
        );

        uint256 expectedProceeds = LibFallback.expectedSwapOutput(
            address(this),
            loan.collateralAsset,
            loan.principalAsset,
            toSell
        );
        uint256 minOutput = (expectedProceeds *
            (LibVaipakam.BASIS_POINTS - maxSlippageBps)) /
            LibVaipakam.BASIS_POINTS;

        (bool ok, uint256 proceeds, ) = LibSwap.swapWithFailover(
            loanId,
            loan.collateralAsset,
            loan.principalAsset,
            toSell,
            minOutput,
            address(this),
            adapterCalls
        );
        if (!ok) {
            revert IVaipakamErrors.PeriodicSettleSwapFailed(loanId);
        }

        // Slippage-driven settler bonus mirrors RiskFacet.triggerLiquidation:
        //   incentiveBps = max(0, slippageCap - realizedSlippageBps), capped
        //   at maxLiquidatorIncentiveBps (3%).
        uint256 realizedSlippageBps;
        if (proceeds < expectedProceeds) {
            realizedSlippageBps = ((expectedProceeds - proceeds) *
                LibVaipakam.BASIS_POINTS) / expectedProceeds;
            if (realizedSlippageBps > maxSlippageBps) {
                realizedSlippageBps = maxSlippageBps;
            }
        }
        uint256 maxIncentiveBps = LibVaipakam.cfgMaxLiquidatorIncentiveBps();
        uint256 incentiveBps = maxSlippageBps - realizedSlippageBps;
        if (incentiveBps > maxIncentiveBps) {
            incentiveBps = maxIncentiveBps;
        }
        uint256 bonus = (proceeds * incentiveBps) / LibVaipakam.BASIS_POINTS;
        // Treasury 2% handling fee — same constant as HF-liquidation.
        uint256 handlingFee = (proceeds *
            LibVaipakam.cfgLiquidationHandlingFeeBps()) /
            LibVaipakam.BASIS_POINTS;
        if (bonus + handlingFee > proceeds) {
            handlingFee = proceeds - bonus;
        }
        uint256 lenderProceeds = proceeds - bonus - handlingFee;

        // Pay out: settler bonus → msg.sender, treasury → treasury,
        // lender → lender's escrow (bookkeeping mirrors PartialRepaid
        // accounting on the lender side).
        if (bonus > 0) {
            IERC20(loan.principalAsset).safeTransfer(msg.sender, bonus);
        }
        if (handlingFee > 0) {
            address treasury = LibFacet.getTreasury();
            IERC20(loan.principalAsset).safeTransfer(treasury, handlingFee);
            LibFacet.recordTreasuryAccrual(loan.principalAsset, handlingFee);
        }
        if (lenderProceeds > 0) {
            IERC20(loan.principalAsset).safeTransfer(loan.lender, lenderProceeds);
        }

        unchecked {
            loan.collateralAmount -= toSell;
        }
        // Even if `lenderProceeds < shortfall` (rare — DEX cleared the
        // slippage gate but lender absorbed the bonus + handling
        // hit), advance the checkpoint anyway. The auto-liquidate
        // event records the actual amounts so off-chain reconcilers
        // can spot lender shortfalls.
        if (lenderProceeds < shortfall) {
            emit PeriodicSlippageOverBuffer(loanId, shortfall, lenderProceeds);
        }
        LibPeriodicInterest.advanceCheckpoint(loan);
        emit PeriodicInterestAutoLiquidated(
            loanId,
            boundary,
            shortfall,
            toSell,
            lenderProceeds,
            bonus,
            handlingFee,
            msg.sender
        );
        // `expected` and `paid` are unused in the event — captured for
        // future-proofing the function signature without changing the
        // event ABI. Suppressed via the assignment below to silence
        // the unused-warning lint without inflating gas.
        expected; paid;
    }
}
