// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibPausable} from "./LibPausable.sol";
import {LibPriceGuard} from "./LibPriceGuard.sol";
import {IPriceGuard} from "../interfaces/IPriceGuard.sol";
import {LoanClockFacet} from "../facets/LoanClockFacet.sol";

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
 *
 *         #3410 (owner decision 2026-11-09) — an L2 sequencer outage is
 *         handled here too, without a recorded log: the price guard reads
 *         the latest outage and its recovery window from the sequencer
 *         uptime feed ({IPriceGuard.sequencerOutageWindow}). A grace end
 *         that falls inside that window moves to the window's end, the
 *         same post-recovery grace liquidations wait out, so a borrower who
 *         could not send a repayment during the outage can repay in the
 *         recovery window and is not defaulted the moment it ends. The late
 *         fee does not run for time inside the window. Only the LATEST
 *         outage is known (the feed keeps no history the Diamond reads), so
 *         an earlier outage's time is not excluded from a late fee charged
 *         after a later one. The due date ({maturity}) does not move: an
 *         outage changes when a deadline may be ENFORCED, not the loan's
 *         term or its interest.
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

    /// @notice The end of the loan's interest term as of `at`: the original
    ///         maturity moved by the paused time since the loan's start. The
    ///         term a rate shortfall at a sale or an early close is priced
    ///         over.
    /// @dev    #3169 — derived from the term tuple, to the second. A partial
    ///         re-stamps only the interest clock's start, never the term, so
    ///         the term's end needs no counter of its own: it was the clock's
    ///         start plus a whole-day remaining-term counter, which lost the
    ///         part day at every partial. This is exactly what that sum was
    ///         meant to be. At `at = block.timestamp` it is {maturity}.
    function interestTermEnd(LibVaipakam.Loan storage loan, uint256 at)
        internal
        view
        returns (uint256)
    {
        return originalMaturity(loan) + LibPausable.pausedSecondsBetween(loan.startTime, at);
    }

    /// @notice #3169 — the seconds of interest a full-term loan owes at least,
    ///         for its current accrual segment: from the interest clock's start
    ///         to the term's end as it stood at that start.
    /// @dev    The term's end is read at the SEGMENT START, not now, so a pause
    ///         inside the segment does not raise the minimum: accrual already
    ///         counts the paused seconds by elapsed time, and the pause only
    ///         moves the deadline. A pause before the segment moved the term,
    ///         and a partial at that point owes the moved remainder. On a loan
    ///         never re-stamped the segment starts at `startTime`, and this is
    ///         exactly `durationDays` of interest, as before.
    function minimumInterestSeconds(LibVaipakam.Loan storage loan)
        internal
        view
        returns (uint256)
    {
        uint256 start = LibVaipakam.interestAccrualStartOf(loan);
        uint256 end = interestTermEnd(loan, start);
        return end > start ? end - start : 0;
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

    /// @notice The loan's effective grace end: past it the loan may be
    ///         defaulted and may no longer be repaid. A grace end inside a
    ///         sequencer outage or its recovery window moves to the window's
    ///         end (#3410).
    function graceEnd(LibVaipakam.Loan storage loan) internal view returns (uint256) {
        return outageMoved(maturity(loan) + LibVaipakam.gracePeriod(loan.durationDays));
    }

    /// @notice #3410 — the time the late fee starts counting from, for a fee
    ///         priced at `asOf`: the effective {maturity}, moved later by the
    ///         part of the latest sequencer outage window that falls between
    ///         the maturity and `asOf`. No late fee runs for time a borrower
    ///         could not act in.
    function lateFeeStart(LibVaipakam.Loan storage loan, uint256 asOf)
        internal
        view
        returns (uint256 start)
    {
        start = maturity(loan);
        (uint256 downAt, uint256 windowEnd) = outageWindow();
        uint256 lo = downAt > start ? downAt : start;
        uint256 hi = windowEnd < asOf ? windowEnd : asOf;
        if (hi > lo) start += hi - lo;
    }

    /// @notice #3410 — `deadline`, moved to the end of the latest sequencer
    ///         outage window when it falls inside that window; unchanged
    ///         otherwise, and always unchanged where no sequencer feed is set.
    function outageMoved(uint256 deadline) internal view returns (uint256) {
        (uint256 downAt, uint256 windowEnd) = outageWindow();
        return (deadline >= downAt && deadline < windowEnd) ? windowEnd : deadline;
    }

    /// @notice #3410 — true while the sequencer is down or inside its
    ///         recovery window. A deadline-driven action that is not
    ///         already refused on a price read (a grace-period listing)
    ///         waits it out.
    function inOutageWindow() internal view returns (bool) {
        (, uint256 windowEnd) = outageWindow();
        return block.timestamp < windowEnd;
    }

    /// @notice #3410 — the latest sequencer outage and its recovery window,
    ///         as {LoanClockFacet.getSequencerOutageWindow} reports it; `(0, 0)`
    ///         where it cannot be read.
    /// @dev    Read by a self-call to the one host of the guard read, so the
    ///         many facets that price a deadline carry a single call rather
    ///         than the registry and guard lookups each (#3410 put five of
    ///         them over EIP-170 inline). Best-effort by design: repayment and
    ///         every other deadline reader must never fail because the outage
    ///         could not be read, so a failed or short answer moves nothing,
    ///         exactly as a network with no sequencer feed. A time-based
    ///         default does not rely on this: it separately refuses while the
    ///         sequencer is unhealthy, reading the guard fail-closed.
    function outageWindow() internal view returns (uint256 downAt, uint256 windowEnd) {
        bytes4 sel = LoanClockFacet.getSequencerOutageWindow.selector;
        // Memory-safe: the call's 4-byte input and its two-word answer use
        // only the scratch space (0x00-0x3f), which inline assembly may use
        // freely; nothing past it is read or written and no pointer leaves
        // the block. A failed call or a short answer leaves both at zero.
        // The call is bound first: Yul evaluates arguments right to left, so
        // a `returndatasize()` beside the call would read the size before it.
        assembly ("memory-safe") {
            mstore(0x00, sel)
            let ok := staticcall(gas(), address(), 0x00, 0x04, 0x00, 0x40)
            if and(ok, iszero(lt(returndatasize(), 0x40))) {
                downAt := mload(0x00)
                windowEnd := mload(0x20)
            }
        }
    }

    /// @notice #3410 — the latest sequencer outage and its recovery window
    ///         read from the price guard; `(0, 0)` where the Diamond reaches
    ///         no guard or the guard has no sequencer feed (an L1). Only
    ///         {LoanClockFacet} calls this; every other reader goes through
    ///         {outageWindow}.
    /// @dev    Best-effort: an unreadable guard moves nothing. The guard
    ///         itself reads an unreadable FEED as down.
    function guardOutageWindow() internal view returns (uint256 downAt, uint256 windowEnd) {
        (bool ok, IPriceGuard g) = LibPriceGuard.tryGuard();
        if (!ok) return (0, 0);
        try g.sequencerOutageWindow() returns (uint256 d, uint256 e) {
            return (d, e);
        } catch {
            return (0, 0);
        }
    }
}
