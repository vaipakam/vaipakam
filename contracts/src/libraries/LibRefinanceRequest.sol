// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibERC721} from "./LibERC721.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {LibAutoRefinanceCheck} from "./LibAutoRefinanceCheck.sol";
import {LibPeriodicInterest} from "./LibPeriodicInterest.sol";

/**
 * @title  LibRefinanceRequest
 * @notice #2407 — a loan's standing refinance request (a refinance-tagged
 *         borrower offer, `Offer.refinanceTargetLoanId`), and the guard that
 *         keeps the loan from changing underneath it.
 * @dev    WHY. A refinance request is priced against the loan as it stands:
 *         its amount range must cover the loan's principal, and a carry-over
 *         request must match the loan's collateral exactly. A partial
 *         repayment, an early close, an obligation handover, an offset or a
 *         collateral withdrawal while the request stands leaves it unfillable
 *         — and the app's own pre-action check cannot close the window
 *         between its last read and the transaction being mined. So the
 *         protocol refuses those actions while a LIVE request targets the
 *         loan; the borrower cancels the request first.
 *
 *         WHAT IS LIVE — a request holds the loan while it STANDS. The
 *         record stores at most one request per loan, and it stands while
 *         ALL of the following hold:
 *           - it still exists and is not accepted (a cancel either deletes
 *             the offer or marks it accepted);
 *           - it still targets this loan;
 *           - it has not expired (create clamps its expiry to the loan's
 *             grace deadline, so it lapses no later than that);
 *           - the loan is still Active;
 *           - its creator still holds the loan's borrower position (accept
 *             re-checks this, so a request orphaned by a position transfer
 *             cannot fill — and must not block the new holder).
 *         Whether a lender could fill it at this moment is DELIBERATELY not
 *         part of the rule: the holder's refinance caps, the payoff approval
 *         and balance, an overdue period, a collateral top-up and the market
 *         can each make acceptance fail, and every one of them can change
 *         back. A rule that tried to track them grew an edge per review round
 *         and still lagged acceptance itself, so this one is bounded instead:
 *         a standing request holds the loan, and the borrower's remedy — to
 *         cancel their own request — is always available.
 *         `RefinanceFacet.checkRefinanceRequest` answers the other question
 *         ("could it be accepted right now, and if not, why"), for display.
 *         Because standing is read, never stored, a request that stops
 *         standing for any of those reasons stops blocking with no write
 *         anywhere, and no path that ends a request has to remember to clear
 *         the slot.
 *
 *         THE RECORD IS AUTHORITATIVE. Liveness is not one-way — a position
 *         that leaves its creator can come back — so a request the record no
 *         longer points to could otherwise revive unguarded. An acceptance
 *         therefore completes a tagged request ONLY if it is the loan's
 *         recorded request ({assertTakeable}, on the atomic accept / match
 *         routes): a displaced or never-recorded request can never be taken,
 *         so the request the guard watches is always the only one that can.
 *         The standalone completion of an ALREADY-accepted request is not
 *         gated: the replacement loan exists by then, and refusing would
 *         strand both loans.
 *
 *         NO LOST REQUESTS. The record is how a request is found from its
 *         loan, and a fresh-pledge request holds its collateral until it is
 *         cancelled. So a new request may not displace an OUTSTANDING one —
 *         never accepted, never cancelled, and posted by the current holder —
 *         even once it has expired: that holder cancels it first
 *         ({assertReplaceable}). A request posted by a FORMER holder may be
 *         displaced; the new holder could not cancel it, and its creator still
 *         finds it among their own offers.
 *
 *         NOT GUARDED, deliberately: a full repayment settles the loan, which
 *         ends the request with it; every ENFORCEMENT action (default,
 *         liquidation in full or in part, the periodic-interest
 *         auto-liquidation) must stay reachable, or a borrower could post a
 *         request to shield the loan from it — a partial one may leave the
 *         request unfillable, and that is accepted; and adding collateral is
 *         a safety action that must stay available under pressure, even
 *         though it makes a carry-over request (exact collateral match)
 *         unfillable.
 */
/// @dev The one liveness rule, served by `RefinanceFacet` through the Diamond.
interface IRefinanceRequestView {
    function getRefinanceRequest(uint256 loanId) external view returns (uint256 offerId, bool live);
}

library LibRefinanceRequest {
    /// @notice The standing refinance request targeting `loanId`, or 0.
    /// @dev    Asks `RefinanceFacet.getRefinanceRequest` through the Diamond
    ///         rather than inlining {stands}, so the size-tight guard facets
    ///         carry only this call. A failed call (a Diamond without the
    ///         view) reads as "none": the guard protects a request from the
    ///         borrower's own actions, and must not be able to brick repayment
    ///         on a misconfigured Diamond.
    function live(uint256 loanId) internal view returns (uint256 offerId) {
        (bool ok, bytes memory ret) = address(this).staticcall(
            abi.encodeCall(IRefinanceRequestView.getRefinanceRequest, (loanId))
        );
        if (!ok || ret.length < 64) return 0;
        (uint256 id, bool isLive_) = abi.decode(ret, (uint256, bool));
        return isLive_ ? id : 0;
    }

    /// @notice Whether `offerId` stands as `loanId`'s refinance request — the
    ///         rule the guard enforces (see the library notes).
    function stands(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        uint256 offerId
    ) internal view returns (bool) {
        LibVaipakam.Offer storage o = s.offers[offerId];
        // `accepted` is defensive today: every route that marks a request
        // accepted (direct accept, matcher fill, a partial match's dust-close)
        // chains the refinance in the same transaction, so the loan is already
        // no longer Active by the time it reads true — and a cancel of an
        // all-or-nothing request deletes it.
        if (o.creator == address(0) || o.accepted) return false;
        if (o.refinanceTargetLoanId != loanId) return false;
        if (LibVaipakam.isOfferExpired(o)) return false;
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) return false;
        // Non-reverting read: a missing token simply means "not standing".
        return LibERC721._ownerOfRaw(loan.borrowerTokenId) == o.creator;
    }

    /// @notice Revert with the reason `offerId` could not be accepted as
    ///         `loanId`'s refinance request right now; return if it could.
    ///         This is NOT the guard's rule ({stands} is): it is the
    ///         informational answer `RefinanceFacet.checkRefinanceRequest`
    ///         serves. It checks the request's own state (it exists, is not
    ///         taken, still targets the loan, has not expired), then the very
    ///         check acceptance re-runs — the loan is Active and not past
    ///         grace, its creator holds the borrower position, the assets and
    ///         principal still fit, and the holder's refinance caps still admit
    ///         it — then the further prerequisites of completing the refinance
    ///         that depend on the LOAN's or the REQUEST's own state: no offset
    ///         open on the loan, no swap-to-repay intent committed against it,
    ///         no periodic interest overdue past its grace, and, for a
    ///         carry-over request, the old collateral still matching it exactly
    ///         under a live lien. It does not model the payoff funding (the
    ///         holder's approval and balance of the principal asset) or the
    ///         MARKET (the replacement loan's health factor and LTV at the
    ///         moment of acceptance); a request can pass and still be refused
    ///         on those.
    function assertAcceptable(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        uint256 offerId
    ) internal view {
        LibVaipakam.Offer storage o = s.offers[offerId];
        // `accepted` is defensive today: every route that marks a request
        // accepted (direct accept, matcher fill, a partial match's dust-close)
        // chains the refinance in the same transaction, so the loan is already
        // no longer Active by the time it reads true — and a cancel of an
        // all-or-nothing request deletes it.
        if (
            o.creator == address(0) ||
            o.accepted ||
            o.refinanceTargetLoanId != loanId ||
            LibVaipakam.isOfferExpired(o)
        ) revert IVaipakamErrors.RefinanceRequestNotLive(loanId, offerId);
        LibAutoRefinanceCheck.validate(
            s,
            loanId,
            o.creator,
            o.interestRateBpsMax == 0 ? o.interestRateBps : o.interestRateBpsMax,
            o.durationDays,
            o.lendingAsset,
            o.collateralAsset,
            o.assetType,
            o.collateralAssetType,
            o.prepayAsset,
            o.amount,
            o.amountMax == 0 ? o.amount : o.amountMax
        );
        uint256 offsetOfferId = s.loanToOffsetOfferId[loanId];
        if (offsetOfferId != 0) {
            revert IVaipakamErrors.RefinanceBlockedByOffset(loanId, offsetOfferId);
        }
        LibVaipakam.assertNoLiveIntentCommit(loanId);
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.periodicInterestCadence != LibVaipakam.PeriodicInterestCadence.None) {
            uint256 graceEndsAt = LibPeriodicInterest.settleAllowedFromAt(loan);
            if (block.timestamp >= graceEndsAt) {
                revert IVaipakamErrors.RefinanceRequiresPeriodSettle(loanId, graceEndsAt);
            }
        }
        if (
            o.refinanceCarryOver &&
            !LibAutoRefinanceCheck.isCarryOver(
                s,
                loanId,
                o.creator,
                o.collateralAmount,
                o.collateralAmountMax,
                o.collateralTokenId,
                o.collateralQuantity
            )
        ) revert IVaipakamErrors.RefinanceRequestNotLive(loanId, offerId);
    }

    /// @notice Revert {IVaipakamErrors.RefinanceRequestOpen} while a request
    ///         stands against `loanId`.
    function assertNone(uint256 loanId) internal view {
        uint256 offerId = live(loanId);
        if (offerId != 0) revert IVaipakamErrors.RefinanceRequestOpen(loanId, offerId);
    }

    /// @notice Revert unless `loanId`'s recorded request may be replaced: a
    ///         standing one reverts {IVaipakamErrors.RefinanceRequestOpen}; an
    ///         outstanding one of the current holder's that no longer stands
    ///         (in practice, expired) reverts
    ///         {IVaipakamErrors.RefinanceRequestNotCancelled}.
    function assertReplaceable(uint256 loanId) internal view {
        (uint256 prior, bool isLiveNow) = blockingRecord(loanId);
        if (prior == 0) return;
        if (isLiveNow) revert IVaipakamErrors.RefinanceRequestOpen(loanId, prior);
        revert IVaipakamErrors.RefinanceRequestNotCancelled(loanId, prior);
    }

    /// @notice The recorded request that a new one may not displace, or 0:
    ///         a standing one (`isLiveNow`), or an outstanding one — never
    ///         accepted, never cancelled — posted by the current holder.
    function blockingRecord(
        uint256 loanId
    ) internal view returns (uint256 prior, bool isLiveNow) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        prior = s.refinanceRequestOfLoan[loanId];
        if (prior == 0) return (0, false);
        if (live(loanId) == prior) return (prior, true);
        LibVaipakam.Offer storage o = s.offers[prior];
        if (
            o.creator == address(0) ||
            o.accepted ||
            LibERC721._ownerOfRaw(s.loans[loanId].borrowerTokenId) != o.creator
        ) return (0, false);
        return (prior, false);
    }

    /// @notice Record `offerId` as `loanId`'s request — one per loan, never
    ///         displacing one its holder has not cancelled
    ///         ({assertReplaceable}), and never while an offset is live on the
    ///         loan (completing the offset would close the loan underneath the
    ///         request; the offset is refused in the other order too).
    function record(uint256 loanId, uint256 offerId) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 offsetOfferId = s.loanToOffsetOfferId[loanId];
        if (offsetOfferId != 0) {
            revert IVaipakamErrors.RefinanceBlockedByOffset(loanId, offsetOfferId);
        }
        assertReplaceable(loanId);
        s.refinanceRequestOfLoan[loanId] = offerId;
    }

    /// @notice Revert unless `offerId`, if refinance-tagged, may be TAKEN now
    ///         as `loanId`'s refinance: it must be the loan's recorded request
    ///         ({IVaipakamErrors.RefinanceRequestNotRecorded}) and no offset may
    ///         be open on the loan ({IVaipakamErrors.RefinanceBlockedByOffset})
    ///         — the two flows each close the loan, so whichever settled second
    ///         would find it closed underneath it. The offset half is defence
    ///         in depth: a request cannot be recorded beside an offset, an
    ///         offset cannot be opened beside a standing request, and an open
    ///         offset locks the position, so the one way back to standing (the
    ///         position returning to the request's creator) is closed while it
    ///         is open. An untagged offer passes: it
    ///         is not a refinance request, and the routes that accept one gate
    ///         it themselves.
    function assertTakeable(uint256 loanId, uint256 offerId) internal view {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.offers[offerId].refinanceTargetLoanId == 0) return;
        if (s.refinanceRequestOfLoan[loanId] != offerId) {
            revert IVaipakamErrors.RefinanceRequestNotRecorded(loanId, offerId);
        }
        uint256 offsetOfferId = s.loanToOffsetOfferId[loanId];
        if (offsetOfferId != 0) {
            revert IVaipakamErrors.RefinanceBlockedByOffset(loanId, offsetOfferId);
        }
    }

    /// @notice Whether a refinance-tagged `offerId` passes {assertTakeable} —
    ///         the non-reverting form the previews use.
    function isTakeable(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        uint256 offerId
    ) internal view returns (bool) {
        return s.refinanceRequestOfLoan[loanId] == offerId && s.loanToOffsetOfferId[loanId] == 0;
    }
}
