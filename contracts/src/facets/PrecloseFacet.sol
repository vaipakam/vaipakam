// src/facets/PrecloseFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibSettlement} from "../libraries/LibSettlement.sol";
import {LibCompliance} from "../libraries/LibCompliance.sol";
import {LibLoan} from "../libraries/LibLoan.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibOfferMatch} from "../libraries/LibOfferMatch.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {EscrowFactoryFacet} from "./EscrowFactoryFacet.sol";
import {OfferFacet} from "./OfferFacet.sol";
import {VPFIDiscountFacet} from "./VPFIDiscountFacet.sol";

/**
 * @title PrecloseFacet
 * @author Vaipakam Developer Team
 * @notice Handles early repayment (preclose) for borrowers via three options:
 *      - Option 1: Direct preclose with full term interest.
 *      - Option 2: Transfer loan obligation to a new borrower
 *        (via an existing Borrower Offer).
 *      - Option 3: Offset by creating a new lender offer (two-step:
 *        create + complete after acceptance).
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded, pausable.
 *      All three options support both ERC-20 loans and NFT rentals.
 *      Settlement math for ERC-20 uses {LibSettlement.computePreclose}
 *      (full-term interest, `TREASURY_FEE_BPS` split); NFT path uses
 *      `principal × durationDays` as full rental and
 *      {LibEntitlement.splitTreasury} for the fee split.
 *      Options 2 and 3 enforce sanctions/KYC via {LibCompliance} and
 *      lender-favorability constraints (collateral ≥ original,
 *      duration ≤ remaining, principal = original).
 */
contract PrecloseFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    using SafeERC20 for IERC20;

    // ─── Events ────────────────────────────────────��────────────────────────

    event LoanPreclosedDirect(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 interestPaid
    );

    /// @notice Full settlement breakdown for an ERC-20 preclose.
    /// @dev Mirrors RepayFacet.LoanSettlementBreakdown so indexers can use a
    ///      single subscriber across both closing paths. Invariant:
    ///      `treasuryShare + lenderShare == interest + lateFee` (lateFee is
    ///      always 0 for preclose, which is strictly pre-maturity).
    event LoanSettlementBreakdown(
        uint256 indexed loanId,
        uint256 principal,
        uint256 interest,
        uint256 lateFee,
        uint256 treasuryShare,
        uint256 lenderShare
    );

    event LoanObligationTransferred(
        uint256 indexed loanId,
        address indexed originalBorrower,
        address indexed newBorrower,
        uint256 shortfallPaid
    );

    event OffsetOfferCreated(
        uint256 indexed originalLoanId,
        uint256 indexed newOfferId,
        address indexed borrower,
        uint256 shortfallPaid
    );

    event OffsetCompleted(
        uint256 indexed originalLoanId,
        uint256 indexed newOfferId,
        address indexed borrower
    );

    // ─── Errors ──────────────────────���─────────────────────────────────��────

    // Facet-specific errors (shared errors inherited from IVaipakamErrors)
    error InvalidNewBorrower();
    error InvalidOfferTerms();
    error InsufficientCollateral();
    error OffsetNotLinked();
    error OffsetOfferNotAccepted();

    // ─── Option 1: Direct Preclose ────────────────────────────────��─────────

    /**
     * @notice Directly precloses an active loan (Option 1).
     * @dev Borrower pays principal + full term interest. 99% to lender, 1% to treasury.
     *      Releases collateral, resets NFT renter if applicable.
     *      Updates loan status to Repaid, NFTs to Claimable.
     * @param loanId The active loan ID to preclose.
     */
    function precloseDirect(
        uint256 loanId
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // Phase 6: borrower-entitled strategic flow. Authority follows the
        // current borrower-NFT owner OR a keeper with the InitPreclose
        // action bit.
        LibAuth.requireKeeperFor(
            LibVaipakam.KEEPER_ACTION_INIT_PRECLOSE,
            loan,
            /* lenderSide */ false
        );
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert LoanNotActive();

        if (loan.assetType == LibVaipakam.AssetType.ERC20) {
            // ── ERC20 loan preclose ─────────────────────────────────────────
            // Build immutable plan first (phase 1), then execute transfers &
            // claim writes off the same numbers (phase 2). Per README §8
            // Option 1: borrower owes full-term interest on preclose.
            LibSettlement.ERC20Settlement memory plan = LibSettlement.computePreclose(loan);

            // Lender Yield Fee discount (Tokenomics §6): when the lender has
            // platform-level VPFI-discount consent AND holds >= the required
            // VPFI in escrow, the 1% treasury cut is paid in VPFI from the
            // lender's escrow and the lender keeps 100% of interest in the
            // lending asset. tryApplyYieldFee is a silent fallback.
            uint256 yieldVpfiDeducted;
            if (s.vpfiDiscountConsent[loan.lender] && plan.treasuryShare > 0) {
                bool yieldApplied;
                (yieldApplied, yieldVpfiDeducted) = LibVPFIDiscount
                    .tryApplyYieldFee(
                        loan,
                        plan.interest
                    );
                if (yieldApplied) {
                    plan.lenderShare = plan.interest;
                    plan.lenderDue = plan.principal + plan.lenderShare;
                    plan.treasuryShare = 0;
                }
            }

            // Treasury fee transferred immediately (skipped when satisfied in VPFI).
            if (plan.treasuryShare > 0) {
                IERC20(loan.principalAsset).safeTransferFrom(
                    msg.sender,
                    LibFacet.getTreasury(),
                    plan.treasuryShare
                );
                LibFacet.recordTreasuryAccrual(loan.principalAsset, plan.treasuryShare);
            }

            // Lender's due: borrower -> Diamond -> lender's escrow for claim
            IERC20(loan.principalAsset).safeTransferFrom(
                msg.sender,
                address(this),
                plan.lenderDue
            );
            address lenderEscrow = LibFacet.getOrCreateEscrow(loan.lender);
            IERC20(loan.principalAsset).safeTransfer(lenderEscrow, plan.lenderDue);

            // Record lender's claimable (principal + interest)
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

            _setLoanClaimable(loan, loanId);
            LibLifecycle.transition(
                loan,
                LibVaipakam.LoanStatus.Active,
                LibVaipakam.LoanStatus.Repaid
            );

            // Phase 5 / §5.2b — proper-close settlement for borrower LIF
            // VPFI path. Splits Diamond-held VPFI into borrower rebate +
            // treasury share based on time-weighted avg discount BPS.
            // No-op on loans that paid LIF in the lending asset.
            LibVPFIDiscount.settleBorrowerLifProper(loan);

            emit LoanPreclosedDirect(loanId, msg.sender, plan.interest);
            emit LoanSettlementBreakdown(
                loanId,
                plan.principal,
                plan.interest,
                plan.lateFee,
                plan.treasuryShare,
                plan.lenderShare
            );

            // Passthrough event for lender yield-fee VPFI discount so indexers
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
                    IVaipakamErrors.TreasuryTransferFailed.selector
                );
            }
        } else {
            // ── NFT rental preclose ─────────────────────────────────────────
            // For NFT rentals, payments use loan.prepayAsset (ERC20), not principalAsset (NFT).
            // Full-term rental = daily fee * durationDays. Borrower pre-paid (rental + buffer).
            // Lender gets full-term rental fees minus treasury fee.
            // Borrower gets unused prepay + buffer refund.
            uint256 fullRental = loan.principal * loan.durationDays; // principal = daily fee for NFTs
            (uint256 treasuryFee, uint256 lenderShare) = LibEntitlement.splitTreasury(
                fullRental
            );

            // Deduct from borrower's prepay escrow: treasury fee
            if (treasuryFee > 0) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EscrowFactoryFacet.escrowWithdrawERC20.selector,
                        msg.sender,
                        loan.prepayAsset,
                        LibFacet.getTreasury(),
                        treasuryFee
                    ),
                    IVaipakamErrors.TreasuryTransferFailed.selector
                );
                LibFacet.recordTreasuryAccrual(loan.prepayAsset, treasuryFee);
            }

            // Deduct from borrower's prepay escrow: lender share
            address lenderEscrow = LibFacet.getOrCreateEscrow(loan.lender);
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowWithdrawERC20.selector,
                    msg.sender,
                    loan.prepayAsset,
                    address(this),
                    lenderShare
                ),
                IVaipakamErrors.EscrowWithdrawFailed.selector
            );
            IERC20(loan.prepayAsset).safeTransfer(lenderEscrow, lenderShare);

            // Record lender's claimable (rental fees in prepayAsset)
            s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
                asset: loan.prepayAsset,
                amount: lenderShare,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                claimed: false
            });

            // Refund unused prepay + buffer to borrower (stays in borrower's escrow)
            uint256 refund = loan.prepayAmount - fullRental + loan.bufferAmount;
            s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
                asset: loan.prepayAsset,
                amount: refund,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                claimed: false
            });

            // Reset NFT renter
            _resetNFTRenter(loan);

            _setLoanClaimable(loan, loanId);
            LibLifecycle.transition(
                loan,
                LibVaipakam.LoanStatus.Active,
                LibVaipakam.LoanStatus.Repaid
            );

            emit LoanPreclosedDirect(loanId, msg.sender, fullRental);
        }
    }

    // ─── Option 2: Transfer Obligation ──────────────────────────────────────

    // NOTE: transferObligation (direct-parameter path) removed per README update.
    // Option 2 is now handled exclusively via transferObligationViaOffer.

    // ─── Option 2b: Transfer Obligation via Existing Borrower Offer ────────

    /**
     * @notice Transfers loan obligation by accepting an existing Borrower Offer (Option 2).
     * @dev Per README Section 8, Option 2:
     *      Alice accepts Ben's existing Borrower Offer. The offer must use the same
     *      lending/collateral asset types and favor Liam (collateral >= original,
     *      duration <= remaining, amount >= principal). Ben's collateral is already
     *      locked in his escrow from offer creation. Alice pays accrued interest +
     *      shortfall. The live loan is updated to reflect Ben as borrower.
     * @param loanId The loan ID to transfer.
     * @param borrowerOfferId The existing Borrower Offer from Ben.
     */
    function transferObligationViaOffer(
        uint256 loanId,
        uint256 borrowerOfferId
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // Phase 6: borrower-entitled strategic flow (Preclose Option 2).
        // Authority binds to the current borrower-NFT owner OR a keeper
        // with the InitPreclose action bit.
        LibAuth.requireKeeperFor(
            LibVaipakam.KEEPER_ACTION_INIT_PRECLOSE,
            loan,
            /* lenderSide */ false
        );
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert LoanNotActive();

        LibVaipakam.Offer storage offer = s.offers[borrowerOfferId];
        if (offer.offerType != LibVaipakam.OfferType.Borrower || offer.accepted)
            revert InvalidOfferTerms();
        // Range Orders Phase 1 — single source of truth for the per-
        // asset invariants (lendingAsset / collateralAsset /
        // collateralAssetType / prepayAsset). The amount / duration /
        // collateral-amount checks below stay flow-specific because
        // their semantics differ between Preclose (exact principal +
        // strict collateral floor) and Refinance (allows overage).
        if (!LibOfferMatch.assertAssetContinuity(loan, offer))
            revert InvalidOfferTerms();

        // Lender-favorability: replacement terms must not reduce Liam's protection
        uint256 remainingDays = _remainingDays(loan);
        if (offer.durationDays > remainingDays) revert InvalidOfferTerms();
        if (offer.collateralAmount < loan.collateralAmount)
            revert InsufficientCollateral();
        // Range-aware amount check: legacy single-value offers satisfy
        // `amount == amountMax`; range offers satisfy `amount <=
        // loan.principal <= amountMax`. The borrower's range must
        // accommodate the existing loan's exact principal — preclose
        // is a transfer-of-obligation, not a fresh fill, so principal
        // doesn't get re-derived as a midpoint. With auto-collapse
        // (`amountMax == 0` → treated as `amount`) legacy offers fall
        // through unchanged.
        uint256 effAmountMax = offer.amountMax == 0
            ? offer.amount
            : offer.amountMax;
        if (offer.amount > loan.principal || loan.principal > effAmountMax)
            revert InvalidOfferTerms();

        address newBorrower = offer.creator;
        if (newBorrower == address(0) || newBorrower == msg.sender)
            revert InvalidNewBorrower();

        // ── Sanctions & KYC: new borrower must pass normal initiation checks ─
        LibCompliance.enforceCountryAndKYC(
            address(this),
            newBorrower,
            loan.lender,
            loan.principalAsset,
            loan.principal,
            loan.collateralAsset,
            loan.collateralAmount
        );

        // ── 1. Calculate what Alice owes ────────────────────────────────────
        // Seconds-based math across accrued, original-remaining, and
        // new-expected to keep rounding symmetric (README §8/§9).
        uint256 elapsed = block.timestamp - loan.startTime;
        uint256 totalSecs = loan.durationDays * 1 days;
        uint256 remainingSecs = totalSecs > elapsed ? totalSecs - elapsed : 0;
        uint256 newSecs = offer.durationDays * 1 days;
        uint256 accruedInterest = (loan.principal *
            loan.interestRateBps *
            elapsed) /
            (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);

        uint256 originalExpectedRemaining = (loan.principal *
            loan.interestRateBps *
            remainingSecs) /
            (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
        uint256 newExpectedRemaining = (loan.principal *
            offer.interestRateBps *
            newSecs) /
            (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
        uint256 shortfall = originalExpectedRemaining > newExpectedRemaining
            ? originalExpectedRemaining - newExpectedRemaining
            : 0;

        // ── 2. Alice pays accrued + shortfall ───────────────────────────────
        (uint256 treasuryFee, ) = LibEntitlement.splitTreasury(accruedInterest);
        uint256 lenderShare = accruedInterest - treasuryFee + shortfall;

        address payAsset = _paymentAsset(loan);
        if (treasuryFee > 0) {
            IERC20(payAsset).safeTransferFrom(
                msg.sender,
                LibFacet.getTreasury(),
                treasuryFee
            );
            LibFacet.recordTreasuryAccrual(payAsset, treasuryFee);
        }
        if (lenderShare > 0) {
            IERC20(payAsset).safeTransferFrom(
                msg.sender,
                address(this),
                lenderShare
            );
            address lenderEscrow = LibFacet.getOrCreateEscrow(loan.lender);
            IERC20(payAsset).safeTransfer(lenderEscrow, lenderShare);
            s.heldForLender[loanId] += lenderShare;
        }

        // ── 3. Release Alice's collateral ───────────────────────────────────
        if (loan.collateralAssetType == LibVaipakam.AssetType.ERC20) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowWithdrawERC20.selector,
                    msg.sender,
                    loan.collateralAsset,
                    msg.sender,
                    loan.collateralAmount
                ),
                IVaipakamErrors.EscrowWithdrawFailed.selector
            );
        } else if (loan.collateralAssetType == LibVaipakam.AssetType.ERC721) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowWithdrawERC721.selector,
                    msg.sender,
                    loan.collateralAsset,
                    loan.collateralTokenId,
                    msg.sender
                ),
                IVaipakamErrors.EscrowWithdrawFailed.selector
            );
        } else if (loan.collateralAssetType == LibVaipakam.AssetType.ERC1155) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowWithdrawERC1155.selector,
                    msg.sender,
                    loan.collateralAsset,
                    loan.collateralTokenId,
                    loan.collateralQuantity,
                    msg.sender
                ),
                IVaipakamErrors.EscrowWithdrawFailed.selector
            );
        }

        // ── 4. Ben's collateral already locked in his escrow at offer creation

        // ── 5. Update loan to reflect Ben as borrower ───────────────────────
        loan.borrower = newBorrower;
        loan.collateralAmount = offer.collateralAmount;
        loan.durationDays = offer.durationDays;
        loan.startTime = block.timestamp;
        loan.interestRateBps = offer.interestRateBps;

        // ── 5b. NFT rental: reset prepay accounting and reassign user rights ─
        if (loan.assetType != LibVaipakam.AssetType.ERC20) {
            // Reset prepay accounting to Ben's offer terms (initialized like LoanFacet.initiateLoan)
            uint256 newPrepay = offer.amount * offer.durationDays;
            uint256 newBuffer = (newPrepay * LibVaipakam.cfgRentalBufferBps()) /
                LibVaipakam.BASIS_POINTS;
            loan.prepayAmount = newPrepay;
            loan.bufferAmount = newBuffer;
            loan.lastDeductTime = block.timestamp;
            // Revoke Alice's user right
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowSetNFTUser.selector,
                    loan.lender,
                    loan.principalAsset,
                    loan.tokenId,
                    address(0),
                    0
                ),
                IVaipakamErrors.NFTRenterUpdateFailed.selector
            );
            // Assign Ben as new user for remaining duration
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowSetNFTUser.selector,
                    loan.lender,
                    loan.principalAsset,
                    loan.tokenId,
                    newBorrower,
                    uint64(block.timestamp + loan.durationDays * 1 days)
                ),
                IVaipakamErrors.NFTRenterUpdateFailed.selector
            );
        }

        // ── 6. Mark offer accepted ──────────────────────────────────────────
        offer.accepted = true;
        LibMetricsHooks.onOfferAccepted(offer.id);

        // ── 7. NFT updates ──────────────────────────────────────────────────
        // Migrate borrower position in one shot (burn Alice's + mint Ben's NFT,
        // keep loan.borrower/borrowerTokenId in lockstep with NFT state).
        LibLoan.migrateBorrowerPosition(loanId, newBorrower);

        // Burn Ben's offer position NFT (offer is consumed)
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.burnNFT.selector,
                offer.positionTokenId
            ),
            IVaipakamErrors.NFTBurnFailed.selector
        );

        // Update Liam's Lender NFT to reflect new borrower
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.lenderTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanInitiated
            ),
            IVaipakamErrors.NFTStatusUpdateFailed.selector
        );

        emit LoanObligationTransferred(
            loanId,
            msg.sender,
            newBorrower,
            accruedInterest + shortfall
        );
    }

    // ─── Option 3: Offset with New Lender Offer (two-step) ─────────────────

    /**
     * @notice Step 1: Creates a lender offer to offset the original loan (Option 3).
     * @dev WARNING — front-ends MUST surface this to the caller before they
     *      sign: the borrower-side position NFT for `loanId` is NATIVELY
     *      LOCKED against transfer/approve from the moment this call
     *      succeeds. The lock persists until either {completeOffset}
     *      (successful completion) or {OfferFacet.cancelOffer} (initiator
     *      cancels the linked offset offer) releases it. During that
     *      window the holder cannot list, sell, transfer, or approve the
     *      NFT on any marketplace. See LibERC721.LockReason.PrecloseOffset.
     *
     *      Per README Section 8, Option 3:
     *      - Alice deposits principal and creates a Lender Offer via OfferFacet.
     *      - Alice pays accrued interest (treasury fee + lender share) to lender's escrow.
     *      - Shortfall (expected interest difference) is pre-paid to lender's escrow.
     *      - The new offer is linked to the original loan via offsetOfferToLoanId.
     *      - When a new borrower (Charlie) accepts the offer normally, call completeOffset()
     *        to release Alice's collateral and close the original loan.
     * @param loanId The original loan ID to offset.
     * @param interestRateBps The interest rate for Alice's new lender offer.
     * @param durationDays The duration for the new offer (<= remaining).
     * @param collateralAsset The collateral asset for the new offer (can match original).
     * @param collateralAmount The collateral amount required from the new borrower.
     * @param creatorFallbackConsent Consent for illiquid assets in new offer.
     * @param prepayAsset Prepay asset for NFT loans (address(0) for ERC20).
     * @return newOfferId The ID of the newly created offset lender offer.
     */
    function offsetWithNewOffer(
        uint256 loanId,
        uint256 interestRateBps,
        uint256 durationDays,
        address collateralAsset,
        uint256 collateralAmount,
        bool creatorFallbackConsent,
        address prepayAsset
    ) external nonReentrant whenNotPaused returns (uint256 newOfferId) {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        _validateOffsetRequest(
            loan,
            durationDays,
            collateralAsset,
            collateralAmount,
            prepayAsset
        );

        // ── 1. Alice pays accrued interest + shortfall ──────────────────────
        // All payment-flow locals are consumed inside _settleOffsetPayments so
        // the outer frame only carries accruedShortfallSum (needed by emit).
        uint256 accruedShortfallSum = _settleOffsetPayments(
            loan,
            loanId,
            interestRateBps,
            durationDays
        );

        // ── 2. Create lender offer via cross-facet call ─────────────────────
        // Alice deposits principal into her escrow (handled by createOffer).
        // Alice must have approved principalAsset to the diamond before calling.
        newOfferId = _submitOffsetOffer(
            loan,
            interestRateBps,
            durationDays,
            collateralAsset,
            collateralAmount,
            creatorFallbackConsent,
            prepayAsset
        );

        // ── 3+4. Link, lock, emit ─ all moved to a helper so the outer frame
        // has room for the storage-write / lock / emit triplet under
        // --ir-minimum. See _finalizeOffsetLink for details.
        _finalizeOffsetLink(loan, loanId, newOfferId, accruedShortfallSum);
    }

    /**
     * @dev Common guard clauses for {offsetWithNewOffer}. Extracted so the
     *      outer function has fewer locals in scope when it reaches the
     *      storage-link + lock tail (stack-too-deep under --ir-minimum).
     */
    function _validateOffsetRequest(
        LibVaipakam.Loan storage loan,
        uint256 durationDays,
        address collateralAsset,
        uint256 collateralAmount,
        address prepayAsset
    ) private view {
        // Phase 6: borrower-entitled strategic flow (Preclose Option 3).
        // Authority binds to current borrower-NFT owner OR a keeper with
        // the InitPreclose action bit.
        LibAuth.requireKeeperFor(
            LibVaipakam.KEEPER_ACTION_INIT_PRECLOSE,
            loan,
            /* lenderSide */ false
        );
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert LoanNotActive();
        // NFT rentals cannot use the offset path: the NFT is in the lender's
        // escrow, not the borrower's, so createOffer would fail trying to
        // transfer it from Alice.
        if (loan.assetType != LibVaipakam.AssetType.ERC20)
            revert InvalidOfferTerms();
        // Enforce same asset types as original loan (README General Rules)
        if (collateralAsset != loan.collateralAsset) revert InvalidOfferTerms();
        if (prepayAsset != loan.prepayAsset) revert InvalidOfferTerms();
        if (durationDays > _remainingDays(loan)) revert InvalidOfferTerms();
        // Lender-favorability: collateral from new borrower must not be less than original
        if (collateralAmount < loan.collateralAmount)
            revert InsufficientCollateral();
    }

    /**
     * @dev Writes the offer↔loan link mappings, native-locks the borrower-
     *      side position NFT, and emits {OffsetOfferCreated}. Runs in its
     *      own frame so the caller's stack stays shallow enough for
     *      `forge coverage --ir-minimum`.
     */
    function _finalizeOffsetLink(
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        uint256 newOfferId,
        uint256 accruedShortfallSum
    ) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.offsetOfferToLoanId[newOfferId] = loanId;
        s.loanToOffsetOfferId[loanId] = newOfferId;
        // The NFT stays with the initiator, but ERC-721 transfer/approve is
        // blocked at the library level for the duration of the offset flow.
        // Lock is cleared in completeOffset (success) or OfferFacet.cancelOffer
        // (cancel). See LibERC721.LockReason.
        LibERC721._lock(loan.borrowerTokenId, LibERC721.LockReason.PrecloseOffset);
        emit OffsetOfferCreated(
            loanId,
            newOfferId,
            msg.sender,
            accruedShortfallSum
        );
    }

    /**
     * @dev Settles Alice's accrued-interest + shortfall payments for an
     *      offset. Returns accruedShortfallSum so the caller can emit it.
     *      Extracted so all payment-side locals (treasuryFee, payAsset,
     *      lenderTotal, lenderEscrow, etc.) stay in their own frame —
     *      otherwise `forge coverage --ir-minimum` runs out of stack slots
     *      when the outer function continues with the offer-creation path.
     */
    function _settleOffsetPayments(
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        uint256 interestRateBps,
        uint256 durationDays
    ) private returns (uint256 accruedShortfallSum) {
        uint256 treasuryFee;
        uint256 interestToLender;
        {
            uint256 elapsed = block.timestamp - loan.startTime;
            uint256 totalSecs = loan.durationDays * 1 days;
            uint256 remainingSecs = totalSecs > elapsed ? totalSecs - elapsed : 0;
            uint256 accruedInterest = (loan.principal *
                loan.interestRateBps *
                elapsed) /
                (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
            uint256 originalExpectedRemaining = (loan.principal *
                loan.interestRateBps *
                remainingSecs) /
                (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
            uint256 newExpectedEarning = (loan.principal *
                interestRateBps *
                (durationDays * 1 days)) /
                (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
            uint256 shortfall = originalExpectedRemaining > newExpectedEarning
                ? originalExpectedRemaining - newExpectedEarning
                : 0;

            (treasuryFee, ) = LibEntitlement.splitTreasury(accruedInterest);
            interestToLender = accruedInterest - treasuryFee + shortfall;
            accruedShortfallSum = accruedInterest + shortfall;
        }

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address payAssetOffset = _paymentAsset(loan);
        if (treasuryFee > 0) {
            IERC20(payAssetOffset).safeTransferFrom(
                msg.sender,
                LibFacet.getTreasury(),
                treasuryFee
            );
            LibFacet.recordTreasuryAccrual(payAssetOffset, treasuryFee);
        }

        // Repay original principal + interest/shortfall to lender's escrow.
        // Alice must return Liam's principal; the new offer deposit is
        // separate capital Alice puts up to become the new lender.
        uint256 lenderTotal = loan.principal + interestToLender;
        IERC20(payAssetOffset).safeTransferFrom(
            msg.sender,
            address(this),
            lenderTotal
        );
        address lenderEscrow = LibFacet.getOrCreateEscrow(loan.lender);
        IERC20(payAssetOffset).safeTransfer(lenderEscrow, lenderTotal);
        s.heldForLender[loanId] += lenderTotal;
    }

    /**
     * @dev Builds the 16-field `CreateOfferParams` struct in its own frame
     *      and fires the cross-facet call. Extracted from
     *      {offsetWithNewOffer} so `forge coverage --ir-minimum` doesn't pile
     *      every `loan.X` SLOAD onto the caller's stack.
     */
    function _submitOffsetOffer(
        LibVaipakam.Loan storage loan,
        uint256 interestRateBps,
        uint256 durationDays,
        address collateralAsset,
        uint256 collateralAmount,
        bool creatorFallbackConsent,
        address prepayAsset
    ) private returns (uint256 newOfferId) {
        LibVaipakam.CreateOfferParams memory params = _buildOffsetParams(
            loan,
            interestRateBps,
            durationDays,
            collateralAsset,
            collateralAmount,
            creatorFallbackConsent,
            prepayAsset
        );
        (bool success, bytes memory result) = address(this).call(
            abi.encodeWithSelector(OfferFacet.createOffer.selector, params)
        );
        if (!success) revert OfferCreationFailed();
        newOfferId = abi.decode(result, (uint256));
    }

    function _buildOffsetParams(
        LibVaipakam.Loan storage loan,
        uint256 interestRateBps,
        uint256 durationDays,
        address collateralAsset,
        uint256 collateralAmount,
        bool creatorFallbackConsent,
        address prepayAsset
    ) private view returns (LibVaipakam.CreateOfferParams memory params) {
        params.offerType = LibVaipakam.OfferType.Lender;
        params.lendingAsset = loan.principalAsset;
        params.amount = loan.principal;
        params.interestRateBps = interestRateBps;
        params.collateralAsset = collateralAsset;
        params.collateralAmount = collateralAmount;
        params.durationDays = durationDays;
        params.assetType = loan.assetType;
        params.tokenId = loan.tokenId;
        params.quantity = loan.quantity;
        params.creatorFallbackConsent = creatorFallbackConsent;
        params.prepayAsset = prepayAsset;
        params.collateralAssetType = loan.collateralAssetType;
        params.collateralTokenId = loan.collateralTokenId;
        params.collateralQuantity = loan.collateralQuantity;
        // Phase 6: keeper enables are per-keeper via
        // `offerKeeperEnabled[offerId][keeper]`. The borrower (offset-offer
        // creator) can enable specific keepers on this offset offer via
        // `ProfileFacet.setOfferKeeperEnabled` after creation.
    }

    /**
     * @notice Step 2: Completes an offset after the replacement offer has been accepted.
     * @dev Normally invoked atomically from {OfferFacet.acceptOffer} in the
     *      same transaction as acceptance — users do NOT click a separate
     *      "Complete Offset" button under the happy path. This entry point is
     *      retained as a manual recovery hook (e.g., to rescue a loan that
     *      was accepted before auto-completion was introduced, or to be
     *      driven by a keeper if needed). Callable by the current
     *      borrower-NFT holder OR a keeper with the COMPLETE_OFFSET
     *      action bit and the per-loan enable for this loan (borrower-
     *      entitled action).
     *      Verifies the linked offer was accepted, then:
     *      - Releases Alice's original collateral from escrow.
     *      - Closes Alice's original loan with Liam (status = Repaid).
     *      - Updates NFTs to Claimable.
     * @param originalLoanId The original loan ID that was offset.
     */
    function completeOffset(
        uint256 originalLoanId
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[originalLoanId];
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert LoanNotActive();

        // Find the linked offset offer via the dedicated offset mapping
        uint256 newOfferId = s.loanToOffsetOfferId[originalLoanId];
        if (newOfferId == 0) revert OffsetNotLinked();

        // Verify the offer was accepted
        LibVaipakam.Offer storage offer = s.offers[newOfferId];
        if (!offer.accepted) revert OffsetOfferNotAccepted();

        // Phase 6: borrower-entitled action. Authority resolves against
        // the current borrower-NFT holder OR a keeper with the
        // CompleteOffset action bit.
        LibAuth.requireKeeperFor(
            LibVaipakam.KEEPER_ACTION_COMPLETE_OFFSET,
            loan,
            /* lenderSide */ false
        );

        // Record borrower's claimable (collateral stays in borrower's escrow)
        s.borrowerClaims[originalLoanId] = LibVaipakam.ClaimInfo({
            asset: loan.collateralAsset,
            amount: loan.collateralAmount,
            assetType: loan.collateralAssetType,
            tokenId: loan.collateralTokenId,
            quantity: loan.collateralQuantity,
            claimed: false
        });

        // heldForLender funds (from offsetWithNewOffer step 1) are already in the
        // lender's escrow. They are withdrawn via ClaimFacet.claimAsLender, which
        // checks s.heldForLender[loanId] and uses the correct payment asset.
        // Do NOT record them in lenderClaims to avoid double-counting.

        // If NFT lending: Reset renter
        if (loan.assetType != LibVaipakam.AssetType.ERC20) {
            _resetNFTRenter(loan);
        }

        // Close original loan — offset completion transitions Active -> Repaid.
        _setLoanClaimable(loan, originalLoanId);
        LibLifecycle.transition(
            loan,
            LibVaipakam.LoanStatus.Active,
            LibVaipakam.LoanStatus.Repaid
        );

        // Phase 5 / §5.2b — proper-close settlement on the offset path.
        // The original borrower held VPFI (if applicable) across the old
        // loan's lifetime and now settles; rebate is credited for the
        // time-weighted period they actually held.
        LibVPFIDiscount.settleBorrowerLifProper(loan);

        // Release the native transfer lock on the borrower-side NFT. The
        // original loan is now Repaid; the initiator retains the NFT to
        // later claim back the original collateral via ClaimFacet.
        LibERC721._unlock(loan.borrowerTokenId);

        // Clear offset link mappings on both sides now that the flow
        // has fully settled (prevents stale offset references).
        delete s.offsetOfferToLoanId[newOfferId];
        delete s.loanToOffsetOfferId[originalLoanId];

        emit OffsetCompleted(originalLoanId, newOfferId, loan.borrower);
    }

    // ─── Internal Helpers ─────────────────────────��─────────────────────────

    /// @dev Returns the correct ERC20 payment asset for a loan (prepayAsset for NFT rentals, principalAsset for ERC20 loans).
    function _paymentAsset(
        LibVaipakam.Loan storage loan
    ) internal view returns (address) {
        return
            loan.assetType == LibVaipakam.AssetType.ERC20
                ? loan.principalAsset
                : loan.prepayAsset;
    }

    function _remainingDays(
        LibVaipakam.Loan storage loan
    ) internal view returns (uint256) {
        uint256 elapsedDays = (block.timestamp - loan.startTime) / 1 days;
        return
            loan.durationDays > elapsedDays
                ? loan.durationDays - elapsedDays
                : 0;
    }

    function _resetNFTRenter(LibVaipakam.Loan storage loan) internal {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EscrowFactoryFacet.escrowSetNFTUser.selector,
                loan.lender,
                loan.principalAsset,
                loan.tokenId,
                address(0),
                0
            ),
            IVaipakamErrors.NFTRenterUpdateFailed.selector
        );
    }

    function _setLoanClaimable(
        LibVaipakam.Loan storage loan,
        uint256 loanId
    ) internal {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.lenderTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            IVaipakamErrors.NFTStatusUpdateFailed.selector
        );
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.borrowerTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            IVaipakamErrors.NFTStatusUpdateFailed.selector
        );
    }
}
