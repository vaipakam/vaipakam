// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibLoanClock} from "./LibLoanClock.sol";

/**
 * @title  LibFallbackEnd
 * @author Vaipakam Developer Team
 * @notice #3865 — the one rule for the dated end of a loan left in the
 *         fallback state (card #3865, owner decision 2026-11-20): after a
 *         governed wait from the moment the loan entered the fallback state,
 *         anyone may finish it in kind
 *         (`FallbackCustodyFacet.finishFallbackInKind`).
 * @dev    Inlined in `FallbackCustodyFacet` only: the entry records the date,
 *         the finishing step and the view read it. What this library states:
 *         - The wait is recorded on the loan at ENTRY, so a later change of
 *           the setting never moves a date already running.
 *         - The date is counted on the loan clock: paused time since entry
 *           does not run, and a date inside the latest sequencer outage
 *           window moves to the window's end ({LibLoanClock.fallbackEnd}).
 *         - Nothing but an entry writes the record. A part internal match and
 *           a top-up that does not cure leave it where it was; a cure ends
 *           the count (the loan is no longer FallbackPending) and a later
 *           entry overwrites the record with a new date.
 *         - A record is read only while the loan is FallbackPending under a
 *           live snapshot, so a record a cured episode left behind is never
 *           read as current.
 */
library LibFallbackEnd {
    /// @notice The wait, in days, when governance has set none (the owner's
    ///         figure, 2026-11-20).
    uint16 internal constant DEFAULT_WAIT_DAYS = 30;
    /// @notice The shortest wait the setting may take.
    uint16 internal constant MIN_WAIT_DAYS = 14;
    /// @notice The longest wait the setting may take.
    uint16 internal constant MAX_WAIT_DAYS = 90;

    /// @notice The wait in force for a new entry, in days: the governed value,
    ///         or {DEFAULT_WAIT_DAYS} when none was set. Never zero.
    function waitDays(LibVaipakam.Storage storage s) internal view returns (uint16 d) {
        d = s.fallbackEndWaitDays;
        if (d == 0) d = DEFAULT_WAIT_DAYS;
    }

    /// @notice Records `loanId`'s entry into the fallback state now, with the
    ///         wait in force now. Overwrites a record a previous episode left.
    /// @return waitSeconds The wait recorded.
    function record(LibVaipakam.Storage storage s, uint256 loanId) internal returns (uint256 waitSeconds) {
        waitSeconds = uint256(waitDays(s)) * 1 days;
        s.fallbackEnd[loanId] = LibVaipakam.FallbackEndRecord({
            enteredAt: uint64(block.timestamp),
            waitSeconds: uint32(waitSeconds)
        });
    }

    /// @notice `loanId`'s dated end, or 0 when it has none: the loan is not
    ///         FallbackPending, its snapshot is no longer live, or no entry
    ///         was recorded for it.
    /// @return enteredAt   The entry time of the current episode (0 = none).
    /// @return waitSeconds The wait recorded at that entry (0 = none).
    /// @return endAt       The date after which the step may run (0 = none).
    function dateOf(LibVaipakam.Storage storage s, uint256 loanId)
        internal
        view
        returns (uint256 enteredAt, uint256 waitSeconds, uint256 endAt)
    {
        if (
            s.loans[loanId].status != LibVaipakam.LoanStatus.FallbackPending ||
            !s.fallbackSnapshot[loanId].active
        ) return (0, 0, 0);
        LibVaipakam.FallbackEndRecord memory r = s.fallbackEnd[loanId];
        if (r.enteredAt == 0) return (0, 0, 0);
        enteredAt = r.enteredAt;
        waitSeconds = r.waitSeconds;
        endAt = LibLoanClock.fallbackEnd(enteredAt, waitSeconds);
    }
}
