// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

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
    /// @dev Expected interest for ONE full period at the loan's current
    ///      principal and rate. Computed on-demand using `loan.principal`
    ///      so a borrower who repays principal mid-period sees their
    ///      "expected for the rest of this period" drop accordingly.
    ///      Returns 0 when cadence is None (degenerate).
    function expectedInterestForPeriod(
        LibVaipakam.Loan storage loan
    ) internal view returns (uint256) {
        uint256 days_ = LibVaipakam.intervalDays(loan.periodicInterestCadence);
        if (days_ == 0) return 0;
        return
            (loan.principal * loan.interestRateBps * days_) /
            (LibVaipakam.BASIS_POINTS * 365);
    }

    /// @dev Period boundary timestamp — `lastPeriodicInterestSettledAt +
    ///      intervalDays`. Returns 0 when cadence is None.
    function periodEndAt(
        LibVaipakam.Loan storage loan
    ) internal view returns (uint256) {
        uint256 days_ = LibVaipakam.intervalDays(loan.periodicInterestCadence);
        if (days_ == 0) return 0;
        return uint256(loan.lastPeriodicInterestSettledAt) + days_ * LibVaipakam.ONE_DAY;
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
        uint256 boundary = uint256(loan.lastPeriodicInterestSettledAt) +
            days_ * LibVaipakam.ONE_DAY;
        // Grace looks up by `intervalDays - 1` so a Monthly cadence
        // (30d interval) hits slot 1 (< 30d → 1 day default) rather
        // than slot 2 (< 90d → 3 days). Slot 4 (≥ 365d → 30 days,
        // governs post-maturity) is reserved for post-maturity grace
        // and does NOT govern any cadence checkpoint.
        return boundary + LibVaipakam.gracePeriod(days_ - 1);
    }

    /// @dev Shortfall = `expectedInterestForPeriod - interestPaidSinceLastPeriod`,
    ///      saturating at zero. The clamp matters because a borrower can
    ///      voluntarily over-pay interest within a period (the on-demand
    ///      expected drops as principal decreases mid-period, so paid
    ///      can exceed expected near the boundary).
    function currentShortfall(
        LibVaipakam.Loan storage loan
    ) internal view returns (uint256) {
        uint256 expected = expectedInterestForPeriod(loan);
        uint256 paid = uint256(loan.interestPaidSinceLastPeriod);
        if (paid >= expected) return 0;
        return expected - paid;
    }

    /// @dev True when the current period's boundary has passed AND the
    ///      borrower has fully covered the period's expected interest.
    ///      Used by the inline `_maybeAdvancePeriodCheckpoint` in
    ///      `RepayFacet.repayPartial` (PR2 §4.5) — a borrower whose
    ///      partial-repay paid in enough interest just before / at
    ///      / after the boundary advances the checkpoint without a
    ///      separate settler call.
    function canAdvanceCheckpointInline(
        LibVaipakam.Loan storage loan
    ) internal view returns (bool) {
        uint256 days_ = LibVaipakam.intervalDays(loan.periodicInterestCadence);
        if (days_ == 0) return false;
        uint256 boundary = uint256(loan.lastPeriodicInterestSettledAt) +
            days_ * LibVaipakam.ONE_DAY;
        if (block.timestamp < boundary) return false;
        return uint256(loan.interestPaidSinceLastPeriod) >= expectedInterestForPeriod(loan);
    }

    /// @dev Advance the checkpoint by exactly one period. Reset the
    ///      cumulative-paid counter. Caller is responsible for emitting
    ///      `PeriodicInterestSettled` / `PeriodicInterestAutoLiquidated`
    ///      AT THE CALL SITE (those events have different shapes).
    function advanceCheckpoint(
        LibVaipakam.Loan storage loan
    ) internal {
        uint256 days_ = LibVaipakam.intervalDays(loan.periodicInterestCadence);
        if (days_ == 0) return;
        loan.lastPeriodicInterestSettledAt =
            uint64(uint256(loan.lastPeriodicInterestSettledAt) + days_ * LibVaipakam.ONE_DAY);
        loan.interestPaidSinceLastPeriod = 0;
    }
}
