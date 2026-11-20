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
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibServiceCapacity} from "../libraries/LibServiceCapacity.sol";
import {LibInterestLedger} from "../libraries/LibInterestLedger.sol";
import {LibLoan} from "../libraries/LibLoan.sol";
import {LibIntentFill} from "../libraries/LibIntentFill.sol";
import {LibIntentTerms} from "../libraries/LibIntentTerms.sol";
import {LibLoanClock} from "../libraries/LibLoanClock.sol";
import {LibCompliance} from "../libraries/LibCompliance.sol";
import {LibNewLoanRisk} from "../libraries/LibNewLoanRisk.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
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
        _takeover(msg.sender, loanId, incoming, slot);
    }

    /**
     * @notice #3760 — the takeover run by the Diamond for `caller`, as one
     *         source of `LenderCashOutFacet.sellNow` (and its preview).
     * @dev    `address(this)`-gated: only the cash-out door reaches it, after
     *         taking the Diamond's reentrancy guard. `caller` is the door's
     *         caller and is authorised exactly as on {takeoverInstant} (the
     *         holder, or a keeper holding the holder's mandate). The body is
     *         the one takeover, with every check.
     */
    function takeoverInstantFor(address caller, uint256 loanId, address incoming, uint8 slot)
        external
        whenNotPaused
    {
        if (msg.sender != address(this)) revert IVaipakamErrors.UnauthorizedCrossFacetCall();
        _takeover(caller, loanId, incoming, slot);
    }

    /**
     * @notice Whether loan `loanId` can be taken over by any slot at all: the
     *         instant market on, an instant-market loan with interest by
     *         time, and nothing held for the lender position. Returns the
     *         ABI-encoded refusal the takeover would raise, or empty.
     * @dev    The ONE position-level rule: the takeover's admission
     *         ({_requireAdmissible}, so the takeover and {previewTakeover})
     *         reverts with it, and `LenderCashOutFacet.cashOptions` reads it
     *         for a keeper, whose only "sell now" source is a takeover slot,
     *         so the read and the execution cannot disagree.
     */
    function takeoverPositionRefusal(uint256 loanId) public view returns (bytes memory) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.instantCfg.enabled) {
            return abi.encodeWithSelector(InstantMarketFacet.InstantMarketDisabled.selector);
        }
        if (!s.loanLentRecord[loanId].instant || s.loans[loanId].useFullTermInterest) {
            return abi.encodeWithSelector(InstantLoanNotEligible.selector, loanId);
        }
        uint256 held = s.heldForLender[loanId];
        if (held != 0) return abi.encodeWithSelector(InstantTakeoverHeld.selector, loanId, held);
        return "";
    }

    /// @dev The takeover body. `caller` is who started it.
    function _takeover(address caller, uint256 loanId, address incoming, uint8 slot) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        (address holder, , bool byKeeper) = _requireAdmissible(s, loan, loanId, caller, incoming, slot);
        if (byKeeper) LibServiceCapacity.chargeKeeper(); // one keeper action (#1219)
        // The position-move gate's own call also clears a stale sanctions
        // registry entry on a clean read, which the shared view only reads.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(ProfileFacet.enforcePositionMoveNotSanctioned.selector, holder, incoming),
            bytes4(0)
        );

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

    /// @notice #3761 — whether {takeoverInstant} would accept handing
    ///         `loanId` to `incoming`'s slot `slot` if `caller` sent it now,
    ///         and what the outgoing holder would receive.
    /// @dev    Runs the same admission the takeover runs ({_requireAdmissible}),
    ///         so the two cannot disagree. A refusal is returned as the custom
    ///         error the takeover would raise. What it does not cover: the
    ///         transaction deadline, the pause, and the keeper's capacity
    ///         charge when `caller` is a keeper.
    /// @return accepted      Whether the takeover would be accepted.
    /// @return refusal       The ABI-encoded error it would revert with, or
    ///                       empty when accepted.
    /// @return principalPaid The principal outstanding the incoming slot pays
    ///                       into the outgoing holder's vault. A token that
    ///                       charges on transfer delivers less; the takeover
    ///                       measures what arrives. The holder's earned
    ///                       interest is not in it: it stays a seller claim on
    ///                       the loan, paid as the borrower pays interest.
    function previewTakeover(uint256 loanId, address caller, address incoming, uint8 slot)
        external
        view
        returns (bool accepted, bytes memory refusal, uint256 principalPaid)
    {
        try this.requireTakeoverAdmissible(loanId, caller, incoming, slot) returns (uint256 principal) {
            return (true, "", principal);
        } catch (bytes memory reason) {
            return (false, reason, 0);
        }
    }

    /// @notice Reverts with the first reason {takeoverInstant} would refuse
    ///         the takeover for `caller`; otherwise returns the principal the
    ///         incoming slot would pay. The revert form of {previewTakeover}.
    function requireTakeoverAdmissible(uint256 loanId, address caller, address incoming, uint8 slot)
        external
        view
        returns (uint256 principal)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        _requireAdmissible(s, loan, loanId, caller, incoming, slot);
        return loan.principal;
    }

    /// @dev The one admission rule for a takeover sent by `caller`: the
    ///      market switch, the loan's eligibility, who may start it (the
    ///      holder, or a keeper with the holder's early-withdrawal mandate,
    ///      screened itself), the direct-sale exit for the holder, nothing
    ///      held, the parties, the incoming slot's admission and the incoming
    ///      lender's screens. Read-only; the takeover adds the keeper charge
    ///      and the mutating half of the position-move gate.
    function _requireAdmissible(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        address caller,
        address incoming,
        uint8 slot
    ) private view returns (address holder, address borrowerNow, bool byKeeper) {
        {
            bytes memory refusal = takeoverPositionRefusal(loanId);
            if (refusal.length != 0) {
                assembly ("memory-safe") {
                    revert(add(refusal, 0x20), mload(refusal))
                }
            }
        }
        holder = LibPositionNFT.ownerOf(loan.lenderTokenId);
        {
            // The holder starts it, or a keeper holding the holder's
            // early-withdrawal mandate for this loan (InstantMarketDesign §7).
            // The proceeds always reach the holder's vault, so the direct-sale
            // exit rule is read for the holder; the keeper is screened itself.
            address actor = caller;
            if (
                actor != holder &&
                LibAuth.keeperMayActFor(actor, LibVaipakam.KEEPER_ACTION_INIT_EARLY_WITHDRAW, loanId, holder)
            ) {
                LibVaipakam._assertNotSanctioned(actor);
                byKeeper = true;
                actor = holder;
            }
            SaleExitVerdictFacet(address(this)).requireSaleExitOpen(
                loanId, actor, SaleExitVerdictFacet.SaleRoute.Direct
            );
        }
        borrowerNow = LibPositionNFT.ownerOf(loan.borrowerTokenId);
        if (incoming == holder || incoming == borrowerNow) revert InstantTakeoverSameParty(incoming);
        _admitTakeover(s, loan, incoming, slot);
        _screenIncoming(s, loan, holder, incoming, borrowerNow);
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
        // A paused asset opens no new exposure, as on every other slot fill.
        LibFacet.requireAssetNotPaused(loan.principalAsset);
        LibFacet.requireAssetNotPaused(loan.collateralAsset);
        {
            LibVaipakam.InstantSlot memory consent =
                s.instantSlot[incoming][loan.principalAsset][loan.collateralAsset][slot];
            if (!consent.takeover) revert InstantTakeoverNotOffered();
            LibTiming.requireIntentAged(incoming, consent.setAt);
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
            // #3635 A — the slot's effective floor for the term the loan has
            // left, as if it were opened now: a linked slot reads its linked
            // rate, and refuses by name while the link cannot be used.
            uint256 left = maturity > block.timestamp ? maturity - block.timestamp : 0;
            uint256 floorBps = LibIntentFill.slotFloor(intent, loan.principalAsset, (left + 1 days - 1) / 1 days);
            if (loan.interestRateBps < floorBps) revert InstantTakeoverRateBelowSlot(loan.interestRateBps, floorBps);
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
        {
            // The slot pays the principal out of its funded capital, which an
            // active slot can lack (never funded, or withdrawn).
            uint256 funded = s.lenderIntentCapital[incoming][loan.principalAsset][loan.collateralAsset][slot];
            if (loan.principal > funded) {
                revert LibEncumbrance.IntentCapitalInsufficient(
                    incoming, loan.principalAsset, loan.collateralAsset, slot, loan.principal, funded
                );
            }
        }
        uint256 ltv = RiskFacet(address(this)).calculateLTV(loan.id);
        if (ltv > intent.maxInitLtvBps) revert InstantTakeoverLtvAboveSlot(ltv, intent.maxInitLtvBps);
        // The incoming lender takes the loan on as new: the one new-loan
        // check (live cap and admission floor, branch-aware) the accept runs.
        LibNewLoanRisk.requireAdmissible(loan.id, loan.collateralAsset);
    }

    /// @dev The incoming lender is screened as a standing participant:
    ///      sanctions, the position-move screen (its read-only half: the
    ///      takeover's own call to the gate refuses exactly these and may also
    ///      clear a stale registry entry), country and KYC against the
    ///      borrower, and risk access for the pair.
    function _screenIncoming(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        address holder,
        address incoming,
        address borrowerNow
    ) private view {
        LibVaipakam._assertNotSanctioned(incoming);
        if (LibVaipakam.positionMovePartyBlocked(holder)) revert LibVaipakam.SanctionedAddress(holder);
        if (LibVaipakam.positionMovePartyBlocked(incoming)) revert LibVaipakam.SanctionedAddress(incoming);
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
