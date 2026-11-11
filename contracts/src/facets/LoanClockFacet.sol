// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLoanClock} from "../libraries/LibLoanClock.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title LoanClockFacet
 * @author Vaipakam Developer Team
 * @notice The loan clock's disclosure: the deadlines an open loan is held to
 *         now, and what moved them. Every deadline is computed in
 *         {LibLoanClock}; this facet only reports it, so no reader has to
 *         recompute a deadline a pause or a sequencer outage has moved.
 * @dev    Split out of `LoanFacet` in #3410. `LoanFacet` hosts loan
 *         initiation, which fills it to the EIP-170 limit, and the outage
 *         read #3410 adds to the grace end did not fit beside it. It is
 *         also the ONE host of that read: every facet that checks a grace
 *         end or prices a late fee self-calls {getSequencerOutageWindow}
 *         rather than inlining the price-guard read. A Diamond that does
 *         not route it reads no outage (deadlines unmoved, never a revert),
 *         so a reader refreshed without this facet keeps working with the
 *         pre-#3410 deadlines. Read-only; never paused.
 */
contract LoanClockFacet is IVaipakamErrors {
    /**
     * @notice The deadlines an ACTIVE loan is held to now, with the global
     *         pause credit applied (#668 / #935, owner decision D2) and the
     *         latest L2 sequencer outage taken into account (#3410).
     * @dev    The protocol's paused time since the loan started is added to
     *         its due date and grace end ({LibLoanClock}), so a deadline a
     *         pause has moved is read here, never recomputed from
     *         `startTime + durationDays`. The `dueTimestamp` in
     *         `LoanInitiatedDetails` is the ORIGINAL due date and goes stale
     *         after a pause. A loan that is not Active is refused: its
     *         deadlines no longer govern anything, and the credit would keep
     *         growing with every later pause.
     * @param loanId The loan ID.
     * @return originalMaturity `startTime + durationDays` days, before credit.
     * @return pauseCredit Paused time between the loan's start and now.
     * @return maturity The effective due date; the late fee runs past it,
     *         except for time inside a sequencer outage and its recovery
     *         window ({getSequencerOutageWindow}).
     * @return graceEnd The effective grace end; past it the loan may be
     *         defaulted and may no longer be repaid. One that fell inside the
     *         latest sequencer outage or its recovery window reads as the
     *         window's end, so it is not always `maturity` plus the grace
     *         period.
     */
    function getLoanDeadlines(uint256 loanId)
        external
        view
        returns (uint256 originalMaturity, uint256 pauseCredit, uint256 maturity, uint256 graceEnd)
    {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        if (loan.startTime == 0 || loan.status != LibVaipakam.LoanStatus.Active) {
            revert InvalidLoanStatus();
        }
        originalMaturity = LibLoanClock.originalMaturity(loan);
        pauseCredit = LibLoanClock.pauseCredit(loan);
        maturity = originalMaturity + pauseCredit;
        graceEnd = LibLoanClock.graceEnd(loan);
    }

    /**
     * @notice #3410 — the latest L2 sequencer outage the loan clock takes
     *         into account, so a reader can say why a grace end moved.
     * @dev    Read from the sequencer uptime feed the price guard holds,
     *         without a recorded history. A loan deadline inside
     *         `[downAt, windowEnd)` moves to `windowEnd`, and no late fee
     *         runs for time inside it. `windowEnd` is in the future while the
     *         sequencer is down or recovering. Both are zero where the
     *         network has no sequencer feed (an L1) or the guard cannot be
     *         read; then no deadline is moved. The one host of the guard
     *         read: every deadline reader reaches it by self-call
     *         ({LibLoanClock.outageWindow}).
     * @return downAt When the latest outage began (the recovery time when the
     *         feed holds no earlier round).
     * @return windowEnd The end of its recovery window.
     */
    function getSequencerOutageWindow() external view returns (uint256 downAt, uint256 windowEnd) {
        return LibLoanClock.guardOutageWindow();
    }
}
