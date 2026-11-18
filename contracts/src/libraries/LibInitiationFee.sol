// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LibVaipakam} from "./LibVaipakam.sol";
import {LibPausable} from "./LibPausable.sol";

/**
 * @title  LibInitiationFee
 * @author Vaipakam Developer Team
 * @notice #3649 — the one rule for the loan initiation fee by term
 *         (`docs/DesignsAndPlans/FeeLevelsDesign.md` §3). Every charger,
 *         preview and cap check reads it, so the amount shown is the amount
 *         charged.
 *
 *         With base rate `B` (bps), base term `T0`, yearly rate `Y` (bps) and
 *         one-year point `D` (days), a loan of agreed term `t` days pays:
 *         - `t <= T0`:      `B`
 *         - `T0 < t <= D`:  `(B·(D − t) + Y·(t − T0)) / (D − T0)`, a straight
 *                           line from `B` at `T0` to `Y` at `D`;
 *         - `t > D`:        `Y · t / D`, the yearly rate in proportion to
 *                           the term.
 *         The rate has no step at `T0` or `D`. The amount is
 *         `principal × rate / 10_000`, computed as one full-width fraction
 *         and rounded down, as the flat rate was.
 * @dev    The settings are bounded at their setter so that `T0 < D` and
 *         `B <= Y`, which keeps the rate non-decreasing in the term; the fee
 *         at the longest term the platform admits stays under the fee
 *         ceiling (`FeeLevelsFacet`).
 */
library LibInitiationFee {
    /// @notice The four settings in force: base rate, base term, yearly rate
    ///         and one-year point, defaults resolved.
    function terms()
        internal
        view
        returns (uint256 baseBps, uint256 baseTermDays, uint256 yearlyBps, uint256 yearDays)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        baseBps = LibVaipakam.cfgLoanInitiationFeeBps();
        LibVaipakam.LifTermConfig storage c = s.lifTermCfg;
        baseTermDays = c.baseTermDays == 0 ? LibVaipakam.LIF_BASE_TERM_DAYS_DEFAULT : c.baseTermDays;
        yearlyBps = c.yearlyBps == 0 ? LibVaipakam.LIF_YEARLY_BPS_DEFAULT : c.yearlyBps;
        yearDays = c.yearDays == 0 ? LibVaipakam.LIF_YEAR_DAYS_DEFAULT : c.yearDays;
    }

    /// @notice The rate for an agreed term of `termDays`, as the fraction
    ///         `num / den` of one basis point.
    function rateFraction(
        uint256 termDays,
        uint256 baseBps,
        uint256 baseTermDays,
        uint256 yearlyBps,
        uint256 yearDays
    ) internal pure returns (uint256 num, uint256 den) {
        if (termDays <= baseTermDays) return (baseBps, 1);
        if (termDays <= yearDays) {
            return (
                baseBps * (yearDays - termDays) + yearlyBps * (termDays - baseTermDays),
                yearDays - baseTermDays
            );
        }
        return (yearlyBps * termDays, yearDays);
    }

    /// @notice The initiation fee on `principal` for an agreed term of
    ///         `termDays`, before any discount.
    function feeOf(uint256 principal, uint256 termDays) internal view returns (uint256) {
        (uint256 b, uint256 t0, uint256 y, uint256 d) = terms();
        return feeWith(principal, termDays, b, t0, y, d);
    }

    /// @notice {feeOf} under the given settings.
    function feeWith(
        uint256 principal,
        uint256 termDays,
        uint256 baseBps,
        uint256 baseTermDays,
        uint256 yearlyBps,
        uint256 yearDays
    ) internal pure returns (uint256) {
        (uint256 num, uint256 den) = rateFraction(termDays, baseBps, baseTermDays, yearlyBps, yearDays);
        return Math.mulDiv(principal, num, den * LibVaipakam.BASIS_POINTS);
    }

    /// @notice The rate for `termDays` in whole basis points, rounded up.
    ///         A maker's fee cap is compared against this, so a cap of `c`
    ///         admits only terms whose rate is at most `c`.
    function rateBpsUp(uint256 termDays) internal view returns (uint256) {
        (uint256 b, uint256 t0, uint256 y, uint256 d) = terms();
        (uint256 num, uint256 den) = rateFraction(termDays, b, t0, y, d);
        return Math.ceilDiv(num, den);
    }

    /// @notice The rate for `termDays` in whole basis points, rounded down
    ///         (the loan record's stamp; the charged amount is exact).
    function rateBpsDown(uint256 termDays) internal view returns (uint256) {
        (uint256 b, uint256 t0, uint256 y, uint256 d) = terms();
        (uint256 num, uint256 den) = rateFraction(termDays, b, t0, y, d);
        return num / den;
    }

    /**
     * @notice What extending `loan` now to end at `newEndTime` adds to the
     *         initiation fee, before any discount.
     * @dev    The fee depends only on the loan's total term, so an extension
     *         pays the fee at the new total term less the fee at the term
     *         already paid for, on the principal outstanding, under the
     *         settings in force now. The total term is counted from the
     *         origination start in whole days, rounded up, excluding paused
     *         time (the new term starts now and carries no pause credit, as
     *         the extension's own deadline does). Any sequence of extensions
     *         therefore pays, in sum, what one loan of the same total term
     *         pays on the same principal (each difference of rounded-down
     *         fees telescopes). A loan that paid no initiation fee
     *         (`lifTermOrigin == 0`) adds none.
     * @return fee           The added fee; 0 when the total term does not grow.
     * @return paidDays      The term paid for before the extension.
     * @return newPaidDays   The term paid for after it (never less than
     *                       `paidDays`).
     */
    function extensionFee(LibVaipakam.Loan storage loan, uint256 newEndTime)
        internal
        view
        returns (uint256 fee, uint256 paidDays, uint256 newPaidDays)
    {
        paidDays = loan.lifPaidDays;
        newPaidDays = paidDays;
        uint256 origin = loan.lifTermOrigin;
        if (origin == 0 || newEndTime <= origin) return (0, paidDays, paidDays);
        uint256 paused = LibPausable.pausedSecondsBetween(origin, block.timestamp);
        uint256 span = newEndTime - origin;
        uint256 runSecs = span > paused ? span - paused : 0;
        uint256 totalDays = Math.ceilDiv(runSecs, LibVaipakam.ONE_DAY);
        if (totalDays <= paidDays) return (0, paidDays, paidDays);
        newPaidDays = totalDays;
        (uint256 b, uint256 t0, uint256 y, uint256 d) = terms();
        uint256 p = loan.principal;
        fee = feeWith(p, totalDays, b, t0, y, d) - feeWith(p, paidDays, b, t0, y, d);
    }
}
