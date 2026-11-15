// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibTiming} from "./LibTiming.sol";
import {LibPositionNFT} from "./LibPositionNFT.sol";

/**
 * @title  LibIntentTerms
 * @author Vaipakam Developer Team
 * @notice #3618 / #3619 — the ONE rule for which borrower requests a standing
 *         lender intent may fill, and whether a repaid intent loan may still be
 *         rolled back behind it. Every consumer reads this library, so the live
 *         fill (`OfferMatchIntentFacet.matchIntent`), its preview
 *         (`LibOfferMatch.previewIntent`), the roll
 *         (`LenderIntentFacet.rollIntentLoan`) and the roll-discovery feed
 *         cannot disagree.
 *
 *         Two lender choices are read here:
 *         - `lendUntil` (unix seconds, 0 = none): no loan is agreed whose
 *           maturity at origination falls after it, and a repaid loan is rolled
 *           only while at least one further day-long loan still fits. It bounds
 *           AGREED maturity only. Late repayment in grace, a default or
 *           liquidation, and a protocol pause (which extends every open loan's
 *           deadlines, {LibLoanClock}) can all end a loan after it.
 *           The same time also caps an automatic extension of a loan the
 *           intent made, while the intent's owner still holds the lender
 *           position ({extensionBound}).
 *         - `acceptsProRata` (default false): off, the intent fills full-term,
 *           full-repay requests only (the committed-interest deal). On, it also
 *           fills pro-rata requests, including ones that allow partial
 *           repayment. A full-term request that allows partial repayment is
 *           refused either way.
 *
 * @dev    Moves no funds and writes no state. A refusal here only refuses a
 *         fill or a roll; a refused roll leaves the proceeds on the normal
 *         lender-claim route.
 */
library LibIntentTerms {
    /// @notice The lifecycle verdict of {lifecycleVerdict}. The order is the
    ///         order `matchIntent` checks and reverts in.
    enum Lifecycle {
        Ok,
        FullTermRequired,      // pro-rata request, intent not opted in
        PartialRepayNotAllowed // partial repay on a full-term request, or intent not opted in
    }

    /// @notice A lend-until time must be at least this far ahead when set, and
    ///         a roll is admitted only while this much of the window is left:
    ///         the shortest term an offer may carry.
    uint256 internal constant MIN_LEND_WINDOW = 1 days;

    /// @notice The agreed maturity of a loan of `durationDays` that starts
    ///         now. The same formula as {LibLoanClock.originalMaturity} with
    ///         the loan's start = this block; at origination no pause credit
    ///         has accrued, so it is also that loan's effective maturity.
    function agreedMaturity(uint256 durationDays) internal view returns (uint256) {
        return block.timestamp + durationDays * 1 days;
    }

    /// @notice Whether a loan of `durationDays` starting now fits inside the
    ///         intent's lend-until time. Always true when none is set.
    /// @return fits     The loan's agreed maturity is at or before `lendUntil`.
    /// @return maturity That agreed maturity (for the refusal's report).
    function fitsLendUntil(LibVaipakam.LenderIntent memory intent, uint256 durationDays)
        internal
        view
        returns (bool fits, uint256 maturity)
    {
        maturity = agreedMaturity(durationDays);
        fits = intent.lendUntil == 0 || maturity <= intent.lendUntil;
    }

    /// @notice Whether the intent's lend-until time still leaves room for a
    ///         new loan: true with no lend-until time, otherwise only while the
    ///         shortest loan (one day) could still be agreed inside it. Read by
    ///         the roll (a repaid loan rolls back behind the intent only while
    ///         this holds), the roll feed and the fill feed (an intent whose
    ///         window is closed can fill nothing, so neither feed lists it).
    function windowOpen(LibVaipakam.LenderIntent storage intent) internal view returns (bool) {
        uint64 until = intent.lendUntil;
        return until == 0 || block.timestamp + MIN_LEND_WINDOW <= until;
    }

    /// @notice Whether a lend-until time is acceptable when the intent is set
    ///         now: none (0), or late enough that a one-day loan still fits
    ///         once the new terms may be filled. Every set restarts the terms
    ///         age (`LibTiming.minTermsAgeSec`), so the window is measured from
    ///         the moment the terms become fillable, not from now; otherwise a
    ///         minimal window set under a long terms age could never fill.
    function validLendUntil(uint64 lendUntil) internal view returns (bool) {
        return lendUntil == 0
            || uint256(lendUntil) >= LibTiming.termsReadyAt(uint64(block.timestamp)) + MIN_LEND_WINDOW;
    }

    /// @notice The latest new end an extension may give `loan`, set by the
    ///         lend-until time of the intent that made it; 0 = no bound.
    /// @dev    Bound only while all three hold: the loan was made by an intent
    ///         (`intentOrigin` set), that intent (read live, so the owner's
    ///         latest choice counts) has a lend-until time, and the intent's
    ///         owner still holds the lender position (both `loan.lender` and
    ///         the position NFT, the pair `rollIntentLoan` checks). A lender
    ///         who sold the position is no longer the intent's owner, and the
    ///         buyer agreed to no lend-until time, so a sold loan is unbound.
    ///         A sale through an intent owner's own buy offer keeps the origin
    ///         and the owner, so it stays bound.
    function extensionBound(LibVaipakam.Loan storage loan) internal view returns (uint64) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.IntentOrigin storage io = s.intentOrigin[loan.id];
        address owner = io.owner;
        if (owner == address(0) || loan.lender != owner) return 0;
        if (LibPositionNFT.ownerOf(loan.lenderTokenId) != owner) return 0;
        return s.lenderIntent[owner][io.lendingAsset][io.collateralAsset].lendUntil;
    }

    /// @notice Whether the intent admits the borrower request's interest mode
    ///         and repayment shape.
    /// @param acceptsProRata     The intent's opt-in.
    /// @param useFullTermInterest The request's interest mode (true = full term).
    /// @param allowsPartialRepay The request allows partial repayment.
    function lifecycleVerdict(bool acceptsProRata, bool useFullTermInterest, bool allowsPartialRepay)
        internal
        pure
        returns (Lifecycle)
    {
        if (!useFullTermInterest && !acceptsProRata) return Lifecycle.FullTermRequired;
        // Past the line above a pro-rata request means the intent opted in, so
        // refusing partial repay on a full-term request admits it exactly for
        // an opted-in pro-rata request.
        if (allowsPartialRepay && useFullTermInterest) return Lifecycle.PartialRepayNotAllowed;
        return Lifecycle.Ok;
    }
}
