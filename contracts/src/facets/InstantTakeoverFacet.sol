// src/facets/InstantTakeoverFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibTiming} from "../libraries/LibTiming.sol";
import {LibRiskAccess} from "../libraries/LibRiskAccess.sol";
import {LibPositionNFT} from "../libraries/LibPositionNFT.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibVaultOutflow} from "../libraries/LibVaultOutflow.sol";
import {OutflowReason} from "../vault/VaultOutflowTypes.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibInterestLedger} from "../libraries/LibInterestLedger.sol";
import {LibLoan} from "../libraries/LibLoan.sol";
import {LibIntentFill} from "../libraries/LibIntentFill.sol";
import {LibIntentTerms} from "../libraries/LibIntentTerms.sol";
import {LibLoanClock} from "../libraries/LibLoanClock.sol";
import {LibCompliance} from "../libraries/LibCompliance.sol";
import {LibNewLoanRisk} from "../libraries/LibNewLoanRisk.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {SaleExitVerdictFacet} from "./SaleExitVerdictFacet.sol";
import {LenderIntentFacet} from "./LenderIntentFacet.sol";
import {InteractionRewardsFacet} from "./InteractionRewardsFacet.sol";
import {ProfileFacet} from "./ProfileFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {OfferPriceGuardFacet} from "./OfferPriceGuardFacet.sol";
import {InstantMarketFacet} from "./InstantMarketFacet.sol";

/**
 * @title  InstantTakeoverFacet
 * @author Vaipakam Developer Team
 * @notice Instant market (#3656, design §7) — a lender leaves an
 *         instant-market loan by handing it to another lender's Auto-lend
 *         slot at face value: the slot pays exactly the principal
 *         outstanding, the position moves on the same loan record, and the
 *         outgoing lender's earned interest stays theirs as a seller claim.
 *         The borrower signs nothing and none of the loan's terms change.
 * @dev    A lender exit, so its opening checks are the direct sale's
 *         (`SaleExitVerdictFacet.requireSaleExitOpen`, route Direct). Its own
 *         facet, beside the borrower entry (`InstantMarketFacet`): the
 *         position move reaches libraries whose inline assembly withholds the
 *         compiler's memory guard, which the borrow loop's frame needs.
 *         Refreshed together with SaleExitVerdictFacet, LenderIntentFacet and
 *         InstantMarketFacet (the switch and the consent it reads).
 */
contract InstantTakeoverFacet is DiamondReentrancyGuard, DiamondPausable {
    /// @notice A lender left an instant-market loan: another lender's slot
    ///         took it over for exactly the principal outstanding.
    /// @custom:event-category state-change/loan-mutation
    /// @param interestLeftAsSellerClaim The interest the outgoing lender had
    ///        earned and not been paid; it is paid to them first out of the
    ///        borrower's next interest payment (a seller claim).
    event InstantTakenOver(
        uint256 indexed loanId,
        address indexed outgoingLender,
        address indexed incomingLender,
        uint8 slot,
        uint256 principalPaid,
        uint256 interestLeftAsSellerClaim
    );

    /// @notice The loan is not an instant-market loan with interest by time.
    error InstantLoanNotEligible(uint256 loanId);
    /// @notice Something is held for the lender position (`held`); the
    ///         outgoing holder claims it first.
    error InstantTakeoverHeld(uint256 loanId, uint256 held);
    /// @notice The incoming slot has not given the takeover consent, or gave
    ///         it too recently.
    error InstantTakeoverNotOffered();
    /// @notice The incoming lender is the current holder or the borrower.
    error InstantTakeoverSameParty(address incoming);
    /// @notice The loan's rate is below the incoming slot's minimum rate.
    error InstantTakeoverRateBelowSlot(uint256 rateBps, uint256 minRateBps);
    /// @notice The loan's loan-to-value now is above the incoming slot's
    ///         largest initial loan-to-value.
    error InstantTakeoverLtvAboveSlot(uint256 ltvBps, uint256 maxInitLtvBps);
    /// @notice The loan's remaining term is longer than the incoming slot's
    ///         longest term, or its due date is past the slot's lend-until.
    error InstantTakeoverTermPastSlot(uint256 maturity);

    /// @notice Hand an instant-market loan to another lender's slot at face
    ///         value (design §7).
    /// @dev    Started by the lender position's holder (or a keeper holding
    ///         their direct-sale mandate). The loan must be an instant-market
    ///         loan with interest by time, and the direct-sale exit open for
    ///         the caller (`SaleExitVerdictFacet`: active, before maturity,
    ///         outside the claim cooldown, no other sale route open). Nothing
    ///         may be held for the position. The incoming slot must have the
    ///         takeover consent and admit the loan as if it were opened now:
    ///         the loan's rate at or above its minimum rate, its lifecycle
    ///         terms admitted, its loan-to-value now at or below the slot's
    ///         largest initial loan-to-value, its health factor at or above
    ///         the minimum for a new loan, its due date inside the slot's
    ///         longest term and lend-until time, and room in the slot's
    ///         exposure. The incoming slot's capital pays the outstanding
    ///         principal into the outgoing holder's vault; the position moves
    ///         on the same loan record; the outgoing holder's earned interest
    ///         stays a seller claim. The borrower signs nothing and none of
    ///         the loan's terms change. No fee is charged: no loan is opened.
    /// @param loanId   The loan.
    /// @param incoming The incoming slot's owner.
    /// @param slot     The incoming slot.
    /// @param validUntil The transaction deadline.
    function takeoverInstant(uint256 loanId, address incoming, uint8 slot, uint64 validUntil)
        external
        nonReentrant
        whenNotPaused
    {
        LibTiming.requireDeadline(validUntil);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.instantCfg.enabled) revert InstantMarketFacet.InstantMarketDisabled();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (!s.loanLentRecord[loanId].instant || loan.useFullTermInterest) {
            revert InstantLoanNotEligible(loanId);
        }
        SaleExitVerdictFacet(address(this)).requireSaleExitOpen(
            loanId, msg.sender, SaleExitVerdictFacet.SaleRoute.Direct
        );
        {
            uint256 held = s.heldForLender[loanId];
            if (held != 0) revert InstantTakeoverHeld(loanId, held);
        }
        address holder = LibPositionNFT.ownerOf(loan.lenderTokenId);
        address borrowerNow = LibPositionNFT.ownerOf(loan.borrowerTokenId);
        if (incoming == holder || incoming == borrowerNow) revert InstantTakeoverSameParty(incoming);
        _admitTakeover(s, loan, incoming, slot);
        _screenIncoming(s, loan, holder, incoming, borrowerNow);

        // The incoming slot's capital pays the principal outstanding into the
        // outgoing holder's vault, measured on arrival.
        uint256 principal = loan.principal;
        LibEncumbrance.unlienIntentCapital(incoming, loan.principalAsset, loan.collateralAsset, slot, principal);
        LibVaipakam.syncIntentRegistry(incoming, loan.principalAsset, loan.collateralAsset, slot);
        LibVaultOutflow.toDiamondExact(incoming, loan.principalAsset, principal, loanId, OutflowReason.SALE);
        uint256 paid = LibFacet.creditOwnVault(loan.principalAsset, holder, principal);

        // Any reservation on the outgoing holder's proceeds and the loan's
        // active-held reservation move as on a direct sale.
        LibEncumbrance.releaseLenderProceeds(loanId, loan.lender);
        LibEncumbrance.migrateActiveHeld(loanId, incoming);

        // The outgoing slot's exposure is released (it leaves the slot figure
        // with its origin); the position moves, the outgoing holder's earned
        // interest becoming a seller claim; the incoming slot's exposure and
        // origin are recorded.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(LenderIntentFacet.releaseIntentExposure.selector, loanId), bytes4(0)
        );
        LibInterestLedger.touch(s, loan);
        uint256 earned = s.interestLedger[loanId].holderEarnedGross;
        LibLoan.migrateLenderPosition(loanId, incoming, holder);
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(InteractionRewardsFacet.transferLenderRewardEntry.selector, loanId, incoming),
            bytes4(0)
        );
        LibIntentFill.recordSlotLoan(
            s, loanId, incoming, loan.principalAsset, loan.collateralAsset, slot, principal
        );
        emit InstantTakenOver(loanId, holder, incoming, slot, paid, earned);
    }

    /// @dev The incoming slot admits the loan as if it were opened now.
    function _admitTakeover(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        address incoming,
        uint8 slot
    ) private view {
        LibVaipakam.LenderIntent memory intent =
            s.lenderIntent[incoming][loan.principalAsset][loan.collateralAsset][slot];
        LibIntentFill.requireSlotLive(intent, incoming);
        {
            LibVaipakam.InstantSlot memory consent =
                s.instantSlot[incoming][loan.principalAsset][loan.collateralAsset][slot];
            if (!consent.takeover) revert InstantTakeoverNotOffered();
            LibTiming.requireIntentAged(incoming, consent.setAt);
        }
        if (loan.interestRateBps < intent.minRateBps) {
            revert InstantTakeoverRateBelowSlot(loan.interestRateBps, intent.minRateBps);
        }
        LibIntentTerms.Lifecycle verdict =
            LibIntentTerms.lifecycleVerdict(intent.acceptsProRata, false, loan.allowsPartialRepay);
        if (verdict == LibIntentTerms.Lifecycle.FullTermRequired) revert LibIntentFill.LenderIntentFullTermRequired();
        if (verdict == LibIntentTerms.Lifecycle.PartialRepayNotAllowed) {
            revert LibIntentFill.LenderIntentPartialRepayNotAllowed();
        }
        {
            uint256 maturity = LibLoanClock.maturity(loan);
            if (
                maturity > block.timestamp + uint256(intent.maxDurationDays) * 1 days
                    || (intent.lendUntil != 0 && maturity > intent.lendUntil)
            ) revert InstantTakeoverTermPastSlot(maturity);
        }
        // The same calm-price check every other fill of a lender intent slot
        // runs (on unless the slot's owner switched it off).
        OfferPriceGuardFacet(address(this)).requireIntentPairCalm(
            incoming, loan.principalAsset, loan.collateralAsset, slot
        );
        if (loan.principal < intent.minFillAmount) revert LibIntentFill.LenderIntentFillBelowMin();
        if (
            s.lenderIntentLivePrincipal[incoming][loan.principalAsset][loan.collateralAsset][slot] + loan.principal
                > intent.maxExposure
        ) revert LibIntentFill.LenderIntentExposureExceeded();
        uint256 ltv = RiskFacet(address(this)).calculateLTV(loan.id);
        if (ltv > intent.maxInitLtvBps) revert InstantTakeoverLtvAboveSlot(ltv, intent.maxInitLtvBps);
        // The incoming lender takes the loan on as new: the one new-loan
        // check (live cap and admission floor, branch-aware) the accept runs.
        LibNewLoanRisk.requireAdmissible(loan.id, loan.collateralAsset);
    }

    /// @dev The incoming lender is screened as a standing participant:
    ///      sanctions, the position-move screen, country and KYC against the
    ///      borrower, and risk access for the pair.
    function _screenIncoming(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        address holder,
        address incoming,
        address borrowerNow
    ) private {
        LibVaipakam._assertNotSanctioned(incoming);
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(ProfileFacet.enforcePositionMoveNotSanctioned.selector, holder, incoming),
            bytes4(0)
        );
        LibCompliance.enforceCountryAndKyc(
            address(this), incoming, borrowerNow, loan.principalAsset, loan.principal,
            loan.collateralAsset, loan.collateralAmount
        );
        if (LibVaipakam.cfgRiskAccessGateEnabled()) {
            LibRiskAccess.assertActorMayTransact(
                s,
                incoming,
                LibRiskAccess.PairId({
                    lendAsset: loan.principalAsset,
                    lendType: loan.assetType,
                    lendTokenId: loan.tokenId,
                    collAsset: loan.collateralAsset,
                    collType: loan.collateralAssetType,
                    collTokenId: loan.collateralTokenId,
                    prepayAsset: loan.prepayAsset
                })
            );
        }
    }
}
