// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibLoanClock} from "./LibLoanClock.sol";
import {LibEntitlement} from "./LibEntitlement.sol";
import {LibPausable} from "./LibPausable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title LibPeriodicInterest — period-arithmetic helpers (T-034 PR2).
 *
 * Pure / view helpers used by RepayFacet's settle entry + previewPeriodicSettle
 * view + the inline checkpoint advance in repayPartial. Kept here (not
 * inlined) so the same math runs at every read point — drift between the
 * preview view and the settle path would surface as "I previewed $0 shortfall
 * but my tx reverted with $X" which is the worst possible UX.
 *
 * See docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md §4.1, §4.3, §4.5.
 */
library LibPeriodicInterest {
    /// @notice A mid-period interest payment (partial repay, partial
    ///         swap-to-repay or partial liquidation) crossed a period
    ///         boundary AND left nothing short at it, so the
    ///         checkpoint advanced inline. Off-chain consumers correlate it
    ///         with the payment's own event in the same transaction. Same
    ///         signature (and topic) as when each paying facet declared it.
    /// @custom:event-category state-change/loan-mutation
    event RepayPartialPeriodAdvanced(
        uint256 indexed loanId,
        uint256 periodEndAt,
        uint256 expected,
        address indexed advancedBy
    );

    /// @notice A period checkpoint advanced with no collateral sold: the
    ///         interest paid during the period covered it. Same signature
    ///         (and topic) as `RepayPeriodicFacet.PeriodicInterestSettled`.
    /// @param periodEndAt The boundary that closed (before the advance).
    /// @param expected The interest owed through the boundary
    ///        ({periodOwed}).
    /// @param paidByBorrower The settled interest toward it (all of it: a
    ///        period closes here only when nothing is short).
    /// @param settler `msg.sender` of the call that advanced it.
    /// @custom:event-category state-change/loan-mutation
    event PeriodicInterestSettled(
        uint256 indexed loanId,
        uint256 periodEndAt,
        uint256 expected,
        uint256 paidByBorrower,
        address indexed settler
    );

    /// @notice #3779 — close, one by one, every period that is over and has
    ///         nothing short ({periodShortfall} is zero at its boundary).
    ///         Emits {PeriodicInterestSettled} for each (and
    ///         {RepayPartialPeriodAdvanced} when a payment closed it,
    ///         `byPayment`). The settler is `msg.sender`. Bounded by the
    ///         periods elapsed since the checkpoint; a no-op for a loan with no
    ///         cadence.
    /// @dev    The ONE close rule for every path that pays interest without a
    ///         forced sale (part repayment, part swap-to-repay, part
    ///         liquidation, the reserve instruction, a wallet interest payment,
    ///         the just-stamp settlement). Nothing is counted per period: the
    ///         loan's settled interest against the accrual so far is the whole
    ///         record, so a payment that covers more than one period closes
    ///         each, and a part day paid ahead counts toward the next
    ///         boundary without being carried.
    /// @return closed How many periods closed.
    function closeCoveredPeriods(LibVaipakam.Loan storage loan, uint256 loanId, bool byPayment)
        internal
        returns (uint256 closed)
    {
        while (canAdvanceCheckpointInline(loan)) {
            uint256 boundary = periodEndAt(loan);
            uint256 owed = periodOwed(loan, boundary);
            advanceCheckpoint(loan);
            if (byPayment) emit RepayPartialPeriodAdvanced(loanId, boundary, owed, msg.sender);
            // Nothing is short, so the interest paid toward the boundary is
            // all of what was owed through it.
            emit PeriodicInterestSettled(loanId, boundary, owed, owed, msg.sender);
            ++closed;
        }
    }

    /// @notice #3779 — the interest the current accrual segment owes through
    ///         `boundary`: what accrues from the segment's start to the
    ///         boundary, at the loan's principal and rate. Zero when the
    ///         segment started at or after the boundary (the restart that
    ///         began it charged everything before). A pause does not stop the
    ///         accrual, and the boundary already carries the pause credit
    ///         ({periodEndAt}), so a period owes for its real length.
    function periodOwed(LibVaipakam.Loan storage loan, uint256 boundary)
        internal
        view
        returns (uint256)
    {
        return LibEntitlement.accruedInterestToTime(loan, boundary);
    }

    /// @notice #3779 — the ONE reader of what a period is short at
    ///         `boundary`: {periodOwed} less the interest already settled on
    ///         the segment, saturating at zero. Every preview, the forced
    ///         sale's sizing, the reserve instruction and the close rule read
    ///         it, so they cannot disagree.
    function periodShortfall(LibVaipakam.Loan storage loan, uint256 boundary)
        internal
        view
        returns (uint256)
    {
        return LibEntitlement.creditSettledInterest(loan, periodOwed(loan, boundary));
    }

    /// @notice #3779 — the current period's own figures, for display: what
    ///         the period itself accrues, what has been paid toward it, and
    ///         what is owed by its boundary.
    /// @dev    The accrual segment can span several periods, so
    ///         {periodOwed} and the settled credit are cumulative over the
    ///         segment. The period's own interest is the segment's accrual
    ///         through `boundary` less its accrual through the previous
    ///         boundary (`prevBoundary`, {periodStartAt}; zero before the segment began). What
    ///         was paid toward it is the settled credit beyond what the
    ///         earlier periods of the segment accrued, at most `expected`.
    ///         `shortfall` is {periodShortfall}: normally `expected - paid`,
    ///         and more only when an earlier period of the segment is still
    ///         short, because that arrear is owed by this boundary too.
    function periodFigures(LibVaipakam.Loan storage loan, uint256 prevBoundary, uint256 boundary)
        internal
        view
        returns (uint256 expected, uint256 paid, uint256 shortfall)
    {
        uint256 owedBefore = periodOwed(loan, prevBoundary);
        expected = periodOwed(loan, boundary) - owedBefore;
        uint256 settled = uint256(loan.interestSettled);
        paid = settled > owedBefore ? settled - owedBefore : 0;
        if (paid > expected) paid = expected;
        shortfall = periodShortfall(loan, boundary);
    }

    /// @notice #3779 — where the current period opened: the previous
    ///         boundary, moved only by the paused time BEFORE it.
    /// @dev    {periodEndAt} moves the current boundary by every pause since
    ///         the loan began, including one inside the current period; the
    ///         opening boundary must not move with a pause that came after
    ///         it, or the period's opening days read as an earlier period's.
    ///         The paused time before the opening depends on where the
    ///         opening lands, so it is found by stepping from the stamped
    ///         checkpoint until it stops moving (a few steps at most: each
    ///         step only adds pauses it newly reaches).
    function periodStartAt(LibVaipakam.Loan storage loan) internal view returns (uint256 at) {
        uint256 last = uint256(loan.lastPeriodicInterestSettledAt);
        uint256 start = uint256(loan.startTime);
        at = last;
        for (uint256 i = 0; i < 8; ++i) {
            uint256 next = last + LibPausable.pausedSecondsBetween(start, at);
            if (next == at) break;
            at = next;
        }
    }

    /// @dev Period boundary timestamp — `lastPeriodicInterestSettledAt +
    ///      intervalDays`, moved by the loan's pause credit
    ///      ({LibLoanClock.pauseCredit}, #668 / #935) like every other loan
    ///      deadline. Returns 0 when cadence is None. The checkpoint itself
    ///      ({advanceCheckpoint}) still steps by whole intervals from the
    ///      original anchor; the credit is applied where a boundary is read,
    ///      so the loan's whole schedule moves together.
    function periodEndAt(
        LibVaipakam.Loan storage loan
    ) internal view returns (uint256) {
        uint256 days_ = LibVaipakam.intervalDays(loan.periodicInterestCadence);
        if (days_ == 0) return 0;
        return uint256(loan.lastPeriodicInterestSettledAt) + days_ * LibVaipakam.ONE_DAY
            + LibLoanClock.pauseCredit(loan);
    }

    /// @dev Earliest timestamp at which a permissionless settler call is
    ///      allowed — period boundary + duration-tiered grace. Returns 0
    ///      when cadence is None. Reuses the existing T-044 grace
    ///      schedule indexed by `intervalDays - 1` per design doc §4.2
    ///      mapping (Monthly→slot 1, Quarterly→slot 2, SemiAnnual→slot 3,
    ///      Annual→slot 4) — since `gracePeriod(d)` returns the grace
    ///      for the first bucket whose `maxDurationDays > d`, we shift
    ///      by one so that e.g. a 30-day Monthly cadence lands in
    ///      slot 1 (maxDays=30, default 1 day) and not slot 2.
    function settleAllowedFromAt(
        LibVaipakam.Loan storage loan
    ) internal view returns (uint256) {
        uint256 days_ = LibVaipakam.intervalDays(loan.periodicInterestCadence);
        if (days_ == 0) return 0;
        // The boundary carries the pause credit ({periodEndAt}).
        uint256 boundary = periodEndAt(loan);
        // Grace looks up by `intervalDays - 1` so a Monthly cadence
        // (30d interval) hits slot 1 (< 30d → 1 day default) rather
        // than slot 2 (< 90d → 3 days). Slot 4 (≥ 365d → 30 days,
        // governs post-maturity) is reserved for post-maturity grace
        // and does NOT govern any cadence checkpoint.
        return boundary + LibVaipakam.gracePeriod(days_ - 1);
    }

    /// @dev The current period's shortfall: {periodShortfall} at the next
    ///      boundary ({periodEndAt}). Zero for a loan with no cadence.
    function currentShortfall(
        LibVaipakam.Loan storage loan
    ) internal view returns (uint256) {
        uint256 boundary = periodEndAt(loan);
        if (boundary == 0) return 0;
        return periodShortfall(loan, boundary);
    }

    /// @dev The shortfall a periodic settlement would sell for if it ran
    ///      now: {currentShortfall} when a settlement is allowed (periodic
    ///      interest enabled, the loan Active on a cadence, the period's grace
    ///      over), zero otherwise. The same preconditions
    ///      `RepayPeriodicFacet.settlePeriodicInterest` refuses on, read as a
    ///      zero rather than a revert so a preview can say "no sale is due".
    function settleableShortfall(
        LibVaipakam.Loan storage loan
    ) internal view returns (uint256) {
        if (!LibVaipakam.storageSlot().protocolCfg.periodicInterestEnabled) return 0;
        if (loan.status != LibVaipakam.LoanStatus.Active) return 0;
        if (loan.periodicInterestCadence == LibVaipakam.PeriodicInterestCadence.None) return 0;
        if (block.timestamp < settleAllowedFromAt(loan)) return 0;
        return currentShortfall(loan);
    }

    /// @dev True when the current period's boundary has passed and nothing
    ///      is short at it ({periodShortfall}). The test {closeCoveredPeriods}
    ///      loops on.
    function canAdvanceCheckpointInline(
        LibVaipakam.Loan storage loan
    ) internal view returns (bool) {
        uint256 days_ = LibVaipakam.intervalDays(loan.periodicInterestCadence);
        if (days_ == 0) return false;
        // The boundary carries the pause credit ({periodEndAt}).
        uint256 boundary = periodEndAt(loan);
        if (block.timestamp < boundary) return false;
        return periodShortfall(loan, boundary) == 0;
    }

    /// @dev Advance the checkpoint by exactly one period. Nothing else moves:
    ///      a period that closes short (a forced sale recovers less than the
    ///      shortfall) leaves the difference unsettled on the loan, where the
    ///      next boundary's {periodShortfall} reads it again. Caller is
    ///      responsible for emitting `PeriodicInterestSettled` /
    ///      `PeriodicInterestAutoLiquidated` AT THE CALL SITE (those events
    ///      have different shapes).
    function advanceCheckpoint(
        LibVaipakam.Loan storage loan
    ) internal {
        uint256 days_ = LibVaipakam.intervalDays(loan.periodicInterestCadence);
        if (days_ == 0) return;
        loan.lastPeriodicInterestSettledAt =
            SafeCast.toUint64(uint256(loan.lastPeriodicInterestSettledAt) + days_ * LibVaipakam.ONE_DAY);
    }
}
