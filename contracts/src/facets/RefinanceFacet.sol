// src/facets/RefinanceFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibOfferMatch} from "../libraries/LibOfferMatch.sol";
import {LibPeriodicInterest} from "../libraries/LibPeriodicInterest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {EscrowFactoryFacet} from "./EscrowFactoryFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {VPFIDiscountFacet} from "./VPFIDiscountFacet.sol";

/**
 * @title RefinanceFacet
 * @author Vaipakam Developer Team
 * @notice Borrower refinancing — close an existing loan and switch to a new
 *         lender with better terms.
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded, pausable.
 *      ERC-20 loans only (NFT rental refinance not supported — would require
 *      NFT custody transfer between escrows).
 *
 *      Two-step flow:
 *        1. Borrower creates a Borrower Offer; a new lender accepts it
 *           (creating a new loan). Principal from the new lender flows to
 *           the borrower.
 *        2. Borrower calls {refinanceLoan}: repays the old lender
 *           (principal + full-term interest + any shortfall — early
 *           repayment economics per README), releases old collateral,
 *           verifies post-refinance HF ≥ 1.5 and LTV ≤ maxLtvBps on the new
 *           loan, and transitions the old loan to Repaid.
 */
contract RefinanceFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    using SafeERC20 for IERC20;

    /// @notice Emitted when a loan is refinanced to a new lender.
    /// @param oldLoanId The ID of the original loan.
    /// @param newLoanId The ID of the new refinanced loan.
    /// @param borrower The borrower's address.
    /// @param oldLender The original lender's address.
    /// @param newLender The new lender's address.
    /// @param shortfallPaid Any shortfall amount paid by borrower.
    event LoanRefinanced(
        uint256 indexed oldLoanId,
        uint256 indexed newLoanId,
        address indexed borrower,
        address oldLender,
        address newLender,
        uint256 shortfallPaid
    );

    // Facet-specific errors (shared errors inherited from IVaipakamErrors)
    error InvalidRefinanceOffer();
    error OfferNotAccepted();

    /**
     * @notice Completes refinancing after Alice's Borrower Offer has been accepted by Lender B.
     * @dev Per README Section "Allow Borrower to Choose New Lender with Better Offer":
     *      1. Alice creates a Borrower Offer (separate tx via OfferFacet.createOffer).
     *      2. Lender B accepts Alice's offer (separate tx via OfferFacet.acceptOffer),
     *         creating a new loan. Principal from Lender B is sent to Alice.
     *      3. Alice calls this function to close the old loan:
     *         - Verifies the Borrower Offer was accepted and a new loan exists.
     *         - Repays old lender (principal + full-term interest + shortfall;
     *           see LibEntitlement.fullTermInterest — matches README early
     *           repayment economics).
     *         - Releases old collateral back to Alice.
     *         - Checks post-refinance HF and LTV on new loan.
     *         - Updates old loan NFTs and marks old loan Repaid.
     * @param oldLoanId The current loan ID to refinance.
     * @param borrowerOfferId The Borrower Offer ID that Alice created and Lender B accepted.
     */
    function refinanceLoan(
        uint256 oldLoanId,
        uint256 borrowerOfferId
    ) external nonReentrant whenNotPaused {
        // Tier-1 sanctions gate — refinance routes funds + creates
        // new loan state for msg.sender; sanctioned wallet blocked.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage oldLoan = s.loans[oldLoanId];
        // Phase 6: borrower-entitled strategic flow. Authority binds to the
        // current borrower-NFT owner OR a keeper with the Refinance action
        // bit.
        LibAuth.requireKeeperFor(
            LibVaipakam.KEEPER_ACTION_REFINANCE,
            oldLoan,
            /* lenderSide */ false
        );
        if (oldLoan.status != LibVaipakam.LoanStatus.Active)
            revert LoanNotActive();
        // NFT rental refinance not supported in Phase 1 (requires NFT custody transfer)
        if (oldLoan.assetType != LibVaipakam.AssetType.ERC20)
            revert InvalidRefinanceOffer();

        // T-034 §4.6 — settle-first guard. If the old loan has a
        // Periodic Interest Payment cadence AND the current period is
        // overdue past its grace window, the original lender is owed
        // interest right now. Refinance must NOT overwrite the loan's
        // state until that obligation is settled — otherwise the new
        // lender's terms (different rate / cadence / start time)
        // would silently extinguish the original lender's claim.
        // Caller resolves by running `settlePeriodicInterest` on the
        // old loan first; that path either just-stamps (no shortfall)
        // or auto-liquidates (covers the shortfall to the lender),
        // and refinance can then proceed cleanly.
        if (
            oldLoan.periodicInterestCadence !=
            LibVaipakam.PeriodicInterestCadence.None
        ) {
            uint256 graceEndsAt = LibPeriodicInterest.settleAllowedFromAt(oldLoan);
            if (block.timestamp >= graceEndsAt) {
                revert IVaipakamErrors.RefinanceRequiresPeriodSettle(
                    oldLoanId,
                    graceEndsAt
                );
            }
        }

        // Validate: must be a Borrower offer created by Alice, already accepted
        LibVaipakam.Offer storage offer = s.offers[borrowerOfferId];
        if (
            offer.offerType != LibVaipakam.OfferType.Borrower ||
            offer.creator != msg.sender
        ) revert InvalidRefinanceOffer();
        if (!offer.accepted) revert OfferNotAccepted();
        // Range-aware amount check: legacy single-value offers satisfy
        // `amount == amountMax`; range offers satisfy
        // `amount <= oldLoan.principal <= amountMax` (the borrower's
        // range must accommodate the existing loan's principal). With
        // auto-collapse (`amountMax == 0` → treated as `amount`),
        // legacy single-value offers fall through to the original
        // `offer.amount >= oldLoan.principal` check unchanged.
        uint256 effAmountMax = offer.amountMax == 0
            ? offer.amount
            : offer.amountMax;
        if (offer.amount > oldLoan.principal || oldLoan.principal > effAmountMax)
            revert InvalidRefinanceOffer();
        // Range Orders Phase 1 — single source of truth for the per-
        // asset invariants (lendingAsset / collateralAsset /
        // collateralAssetType / prepayAsset). README: same lending,
        // collateral, and prepay asset types as original loan.
        if (!LibOfferMatch.assertAssetContinuity(oldLoan, offer))
            revert InvalidRefinanceOffer();

        // Find the new loan created when Lender B accepted Alice's offer
        uint256 newLoanId = s.offerIdToLoanId[borrowerOfferId];
        if (newLoanId == 0) revert InvalidRefinanceOffer();
        LibVaipakam.Loan storage newLoan = s.loans[newLoanId];
        address newLender = newLoan.lender;

        // ── Repay old lender ──────────────────────────────────────────────
        // Alice already received new principal from Lender B (via acceptOffer).
        // README: repay old lender with principal + full-term interest (early repayment rules).
        uint256 oldInterest = LibEntitlement.fullTermInterest(
            oldLoan.principal,
            oldLoan.interestRateBps,
            oldLoan.durationDays
        );

        // Shortfall: if new offer yields less interest than old loan expected
        uint256 newExpectedInterest = LibEntitlement.fullTermInterest(
            offer.amount,
            offer.interestRateBps,
            offer.durationDays
        );
        uint256 shortfall = 0;
        if (newExpectedInterest < oldInterest) {
            shortfall = oldInterest - newExpectedInterest;
        }

        // Treasury fee on interest portion (1% of interest + shortfall).
        // Lender Yield Fee discount (Tokenomics §6): when the old lender has
        // platform-level VPFI-discount consent AND holds >= the required VPFI
        // in escrow, the treasury cut is paid in VPFI from the old lender's
        // escrow and the old lender keeps 100% of interestPortion in the
        // lending asset. tryApplyYieldFee silently falls back on any
        // precondition failure.
        uint256 interestPortion = oldInterest + shortfall;
        (uint256 treasuryFee, uint256 lenderInterest) = LibEntitlement.splitTreasury(
            interestPortion
        );
        uint256 yieldVpfiDeducted;
        if (s.vpfiDiscountConsent[oldLoan.lender] && treasuryFee > 0) {
            bool yieldApplied;
            (yieldApplied, yieldVpfiDeducted) = LibVPFIDiscount.tryApplyYieldFee(
                oldLoan,
                interestPortion
            );
            if (yieldApplied) {
                lenderInterest = interestPortion;
                treasuryFee = 0;
            }
        }
        uint256 lenderDue = oldLoan.principal + lenderInterest;

        // T-037 — pay each party directly from the borrower without
        // the Diamond holding the asset between transfers. The
        // borrower's prior `approve()` to the Diamond covers the
        // total; two `safeTransferFrom` calls (one to treasury, one
        // to the old lender's escrow) replace the prior pull-and-
        // split pattern. Treasury share skipped entirely if the
        // VPFI-discount path satisfied it.
        if (treasuryFee > 0) {
            IERC20(oldLoan.principalAsset).safeTransferFrom(
                msg.sender,
                LibFacet.getTreasury(),
                treasuryFee
            );
            LibFacet.recordTreasuryAccrual(oldLoan.principalAsset, treasuryFee);
        }

        // Route lender's share to old lender's escrow via the cross-
        // payer chokepoint so the protocolTrackedEscrowBalance
        // counter ticks under the old lender (the escrow owner)
        // while the borrower remains the payer.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EscrowFactoryFacet.escrowDepositERC20From.selector,
                msg.sender,         // payer — borrower
                oldLoan.lender,     // user — old lender's escrow
                oldLoan.principalAsset,
                lenderDue
            ),
            EscrowDepositFailed.selector
        );

        // Record lender's claimable. heldForLender handled by ClaimFacet.
        s.lenderClaims[oldLoanId] = LibVaipakam.ClaimInfo({
            asset: oldLoan.principalAsset,
            amount: lenderDue,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });

        // ── Release old collateral ────────────────────────────────────────
        // The borrower's escrow currently holds the old collateral deposited
        // when the original loan was opened. We must refund it back to the borrower.
        if (oldLoan.collateralAssetType == LibVaipakam.AssetType.ERC20) {
            uint256 oldCol = oldLoan.collateralAmount;
            if (oldCol > 0) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EscrowFactoryFacet.escrowWithdrawERC20.selector,
                        msg.sender,
                        oldLoan.collateralAsset,
                        msg.sender,
                        oldCol
                    ),
                    EscrowWithdrawFailed.selector
                );
            }
        } else if (oldLoan.collateralAssetType == LibVaipakam.AssetType.ERC721) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowWithdrawERC721.selector,
                    msg.sender,
                    oldLoan.collateralAsset,
                    oldLoan.collateralTokenId,
                    msg.sender
                ),
                EscrowWithdrawFailed.selector
            );
        } else if (oldLoan.collateralAssetType == LibVaipakam.AssetType.ERC1155) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowWithdrawERC1155.selector,
                    msg.sender,
                    oldLoan.collateralAsset,
                    oldLoan.collateralTokenId,
                    oldLoan.collateralQuantity,
                    msg.sender
                ),
                EscrowWithdrawFailed.selector
            );
        }

        // Check post-refinance HF >= min on the new loan
        bytes memory hfResult = LibFacet.crossFacetStaticCall(
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                newLoanId
            ),
            HealthFactorCalculationFailed.selector
        );
        uint256 newHF = abi.decode(hfResult, (uint256));
        if (newHF < LibVaipakam.MIN_HEALTH_FACTOR) revert HealthFactorTooLow();

        // Check post-refinance LTV <= maxLtvBps
        bytes memory ltvResult = LibFacet.crossFacetStaticCall(
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector, newLoanId),
            LTVCalculationFailed.selector
        );
        uint256 newLTV = abi.decode(ltvResult, (uint256));
        uint256 maxLtvBps = s
            .assetRiskParams[oldLoan.collateralAsset]
            .maxLtvBps;
        if (newLTV > maxLtvBps) revert LTVExceeded();

        // Update old loan NFTs: mark lender NFT as Loan Repaid
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                oldLoan.lenderTokenId,
                oldLoanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            NFTStatusUpdateFailed.selector
        );
        // Preserve old borrower NFT as a LoanRepaid-status receipt so the
        // borrower retains a redeemable claim on the original position even
        // after refinancing into a new loan.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                oldLoan.borrowerTokenId,
                oldLoanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            NFTStatusUpdateFailed.selector
        );

        // Mark old loan closed — refinance only operates on Active loans.
        LibLifecycle.transition(
            oldLoan,
            LibVaipakam.LoanStatus.Active,
            LibVaipakam.LoanStatus.Repaid
        );

        // Phase 5 / §5.2b — proper-close settlement for the OLD loan's
        // borrower LIF VPFI path. The borrower earned the rebate over
        // the old loan's live period; the new loan gets a fresh anchor
        // via _snapshotBorrowerDiscount inside its own initiateLoan path
        // (and, if the new loan also takes the VPFI fee path, that will
        // register its own vpfiHeld against the new loan id).
        LibVPFIDiscount.settleBorrowerLifProper(oldLoan);

        emit LoanRefinanced(
            oldLoanId,
            newLoanId,
            msg.sender,
            oldLoan.lender,
            newLender,
            shortfall
        );

        // Passthrough event for lender yield-fee VPFI discount so indexers
        // subscribe to a single facet for all VPFI-discount analytics.
        if (yieldVpfiDeducted > 0) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VPFIDiscountFacet.emitYieldFeeDiscountApplied.selector,
                    oldLoanId,
                    oldLoan.lender,
                    oldLoan.principalAsset,
                    yieldVpfiDeducted
                ),
                TreasuryTransferFailed.selector
            );
        }
    }
}
