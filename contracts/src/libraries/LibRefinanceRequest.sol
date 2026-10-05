// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibERC721} from "./LibERC721.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

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
 *         WHAT IS LIVE. The index stores at most one request per loan, and a
 *         stored request counts only while ALL of the following hold — the
 *         same conditions under which the request could still be accepted:
 *           - it still exists and is not accepted (a cancel either deletes
 *             the offer or marks it accepted);
 *           - it still targets this loan;
 *           - it has not expired (create clamps its expiry to the loan's
 *             grace deadline, so it lapses no later than that);
 *           - the loan is still Active;
 *           - its creator still holds the loan's borrower position (accept
 *             re-checks this, so a request orphaned by a position transfer
 *             cannot fill — and must not block the new holder).
 *         Because liveness is read, never stored, a request that lapses for
 *         any of those reasons stops blocking with no write anywhere, and no
 *         path that ends a request has to remember to clear the slot.
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
library LibRefinanceRequest {
    /// @notice The live refinance request targeting `loanId`, or 0.
    function live(uint256 loanId) internal view returns (uint256 offerId) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        offerId = s.refinanceRequestOfLoan[loanId];
        if (offerId != 0 && !isLive(s, loanId, offerId)) offerId = 0;
    }

    /// @notice Whether `offerId` is a live refinance request for `loanId`
    ///         (see the library notes for the conditions).
    function isLive(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        uint256 offerId
    ) internal view returns (bool) {
        LibVaipakam.Offer storage o = s.offers[offerId];
        // `accepted` is defensive today: every route that marks a request
        // accepted (direct accept, matcher fill, a partial match's dust-close)
        // chains the refinance in the same transaction, so the loan is already
        // no longer Active by the time it reads true — and a cancel of an
        // all-or-nothing request deletes it. It keeps a future non-atomic
        // completion route (the spec permits a fresh-pledge standalone one)
        // from leaving a taken request blocking the loan.
        if (o.creator == address(0) || o.accepted) return false;
        if (o.refinanceTargetLoanId != loanId) return false;
        if (LibVaipakam.isOfferExpired(o)) return false;
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) return false;
        // Non-reverting read: a missing token simply means "not live".
        return LibERC721._ownerOfRaw(loan.borrowerTokenId) == o.creator;
    }

    /// @notice Revert {IVaipakamErrors.RefinanceRequestOpen} while a live
    ///         request targets `loanId`.
    function assertNone(uint256 loanId) internal view {
        uint256 offerId = live(loanId);
        if (offerId != 0) revert IVaipakamErrors.RefinanceRequestOpen(loanId, offerId);
    }

    /// @notice Record `offerId` as `loanId`'s request — one per loan: refused
    ///         while another request for the loan is live.
    function record(uint256 loanId, uint256 offerId) internal {
        assertNone(loanId);
        LibVaipakam.storageSlot().refinanceRequestOfLoan[loanId] = offerId;
    }
}
