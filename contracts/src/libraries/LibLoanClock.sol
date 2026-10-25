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
 *         the pause lasted. Interest is NOT moved: it accrues by elapsed
 *         time, and repay stays open during a pause. A loan whose
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

    /// @notice The loan's effective grace end: past it the loan may be
    ///         defaulted and may no longer be repaid.
    function graceEnd(LibVaipakam.Loan storage loan) internal view returns (uint256) {
        return maturity(loan) + LibVaipakam.gracePeriod(loan.durationDays);
    }
}
