// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibPausable} from "./LibPausable.sol";

/**
 * @title LibLoanClock — the ONE place a loan's deadlines are computed
 * @notice #668 / #935 (owner decision D2, 2026-10-20): the time the
 *         protocol spends paused is added to every open loan's due date
 *         and grace period, so no loan defaults, pays a late fee or is
 *         liquidated because of a pause. Every deadline a loan has — its
 *         maturity, its grace end, its periodic-interest checkpoints — is
 *         read through this library, and the credit is applied here once.
 * @dev    The credit is the paused time between the loan's `startTime` and
 *         now, read from the pause-interval log in {LibPausable}. It moves
 *         the loan's whole schedule, so a pause during the grace period
 *         extends the grace period, and a pause after the loan became
 *         defaultable puts it back inside its grace window for as long as
 *         the pause lasted. Interest ACCRUAL is NOT moved: it accrues by
 *         elapsed time, and repay stays open during a pause. The interest
 *         TERM is: the remaining term a sale or an early close prices a rate
 *         shortfall over ends at the moved maturity ({interestTermEnd}). Nor
 *         is a rental's paid use: rent, like interest, is charged by elapsed
 *         day, so the renter's use ends when the prepaid days do, and the
 *         credit moves only the late-fee and default deadlines. A loan whose
 *         `startTime` is reset (an in-place extension, an obligation
 *         handover) is credited only the pauses after its new start. See
 *         docs/DesignsAndPlans/GlobalPauseD2Design.md.
 */
library LibLoanClock {
    /// @notice Paused time between the loan's start and now.
    function pauseCredit(LibVaipakam.Loan storage loan) internal view returns (uint256) {
        return LibPausable.pausedSecondsBetween(loan.startTime, block.timestamp);
    }

    /// @notice The maturity the loan was originated with, before any credit.
    function originalMaturity(LibVaipakam.Loan storage loan) internal view returns (uint256) {
        return uint256(loan.startTime) + uint256(loan.durationDays) * 1 days;
    }

    /// @notice The loan's effective maturity: the original one plus the
    ///         pause credit. Past it the loan is due and the late fee runs.
    function maturity(LibVaipakam.Loan storage loan) internal view returns (uint256) {
        return originalMaturity(loan) + pauseCredit(loan);
    }

    /// @notice Whole days left until the effective maturity, counting a
    ///         part day as a day; zero once the loan has reached it. The
    ///         remaining term a listing of the loan carries.
    function remainingTermDays(LibVaipakam.Loan storage loan) internal view returns (uint256) {
        uint256 m = maturity(loan);
        if (block.timestamp >= m) return 0;
        return (m - block.timestamp + 1 days - 1) / 1 days;
    }

    /// @notice The end of the loan's interest term as of `at`: the interest
    ///         clock's start plus its remaining days (#641), moved by the
    ///         paused time since that start. The term a rate shortfall at a
    ///         sale or an early close is priced over.
    /// @dev    The interest clock counts only unpaused days (a partial that
    ///         re-stamps it consumes no paused day, see
    ///         {unpausedDaysSinceInterestStart}), so the pause credit is added
    ///         here from the clock's own start, not from the loan's. On a loan
    ///         that has never been re-stamped the two starts coincide and this
    ///         is {maturity}.
    function interestTermEnd(LibVaipakam.Loan storage loan, uint256 at)
        internal
        view
        returns (uint256)
    {
        uint256 start = LibVaipakam.interestAccrualStartOf(loan);
        return start + LibVaipakam.interestRemainingDaysOf(loan) * 1 days
            + LibPausable.pausedSecondsBetween(start, at);
    }

    /// @notice Seconds of interest term left at `at`; zero past the end.
    function remainingInterestSeconds(LibVaipakam.Loan storage loan, uint256 at)
        internal
        view
        returns (uint256)
    {
        uint256 end = interestTermEnd(loan, at);
        return end > at ? end - at : 0;
    }

    /// @notice Whole unpaused days since the interest clock's start: the
    ///         days a partial that re-stamps the clock consumes from its
    ///         remaining term. A paused day is not consumed, because the
    ///         pause moved the term's end by that day.
    function unpausedDaysSinceInterestStart(LibVaipakam.Loan storage loan)
        internal
        view
        returns (uint256)
    {
        uint256 start = LibVaipakam.interestAccrualStartOf(loan);
        if (block.timestamp <= start) return 0;
        return (block.timestamp - start - LibPausable.pausedSecondsBetween(start, block.timestamp))
            / 1 days;
    }

    /// @notice The loan's effective grace end: past it the loan may be
    ///         defaulted and may no longer be repaid.
    function graceEnd(LibVaipakam.Loan storage loan) internal view returns (uint256) {
        return maturity(loan) + LibVaipakam.gracePeriod(loan.durationDays);
    }
}
