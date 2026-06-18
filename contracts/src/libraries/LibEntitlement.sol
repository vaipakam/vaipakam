// src/libraries/LibEntitlement.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title LibEntitlement
 * @notice Centralizes the accrued-interest and fee-split arithmetic reused
 *         across Repay, Preclose, Refinance, PartialWithdrawal, Risk, and
 *         Defaulted facets.
 * @dev Pure / view helpers only — callers are responsible for state writes
 *      (transfers, vault routing, claim bookkeeping). Keeping the math in
 *      one place means one rounding model, one off-by-one surface, and one
 *      place to audit when the interest / fee policy changes.
 */
library LibEntitlement {
    /// @notice Full-term interest: `principal * rateBps * durationDays / (DAYS_PER_YEAR * BASIS_POINTS)`.
    /// @dev Used when the loan is repaid-early-but-owes-full-term (README: lender
    ///      is made whole on duration) or at refinance when alice owes the old
    ///      lender the full promised coupon.
    function fullTermInterest(
        uint256 principal,
        uint256 rateBps,
        uint256 durationDays
    ) internal pure returns (uint256) {
        return
            (principal * rateBps * durationDays) /
            (LibVaipakam.DAYS_PER_YEAR * LibVaipakam.BASIS_POINTS);
    }

    /// @notice Pro-rata interest over `elapsedDays` (integer days).
    function proRataInterest(
        uint256 principal,
        uint256 rateBps,
        uint256 elapsedDays
    ) internal pure returns (uint256) {
        return
            (principal * rateBps * elapsedDays) /
            (LibVaipakam.DAYS_PER_YEAR * LibVaipakam.BASIS_POINTS);
    }

    /// @notice Pro-rata interest accrued on an ERC-20 loan from `loan.startTime`
    ///         to `nowTime`, rounded down to whole days.
    function accruedInterestToTime(
        LibVaipakam.Loan storage loan,
        uint256 nowTime
    ) internal view returns (uint256) {
        if (nowTime <= loan.startTime) return 0;
        uint256 elapsedDays = (nowTime - loan.startTime) / LibVaipakam.ONE_DAY;
        return proRataInterest(loan.principal, loan.interestRateBps, elapsedDays);
    }

    /// @notice Seconds-precise current borrow balance — `principal +
    ///         continuously-accrued interest` from `loan.startTime` to now.
    /// @dev    DISTINCT from {accruedInterestToTime}: the HF / liquidation
    ///         paths accrue interest by the *second* (`elapsed /
    ///         SECONDS_PER_YEAR`) so a loan's debt — and therefore its
    ///         liquidation proceeds split — is exact at the block of
    ///         liquidation, whereas settlement-time math rounds down to
    ///         whole days (borrower-favourable). Do not substitute one for
    ///         the other: it would shift the liquidation debt by up to a
    ///         day's interest. Rounds DOWN (borrower-favourable by <=1 wei),
    ///         multiplying first to preserve numerator precision. Shared by
    ///         {RiskFacet} (HF / single-route + partial liquidation) and
    ///         {RiskMatchLiquidationFacet} (split-route liquidation) since
    ///         the #66 facet split — one accrual model, one audit surface.
    function currentBorrowBalance(
        LibVaipakam.Loan memory loan
    ) internal view returns (uint256) {
        uint256 elapsed = block.timestamp - loan.startTime;
        uint256 accruedInterest = (loan.principal *
            loan.interestRateBps *
            elapsed) / (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
        return loan.principal + accruedInterest;
    }

    /// @notice #408/#410/#413 (2026-06-12) — Gross interest owed on an
    ///         ERC-20 loan at settlement time, per the full-term FLOOR
    ///         model:
    ///
    ///         ```
    ///         floorDays     = useFullTermInterest ? durationDays : 0
    ///         effectiveDays = max(elapsedDays, floorDays)
    ///         gross         = proRataInterest(P, rate, effectiveDays)
    ///         ```
    ///
    ///         Callers (`LibSettlement.computePreclose` /
    ///         `computeRepayment`) subtract `loan.interestSettled`
    ///         (saturating at 0) before splitting treasury/lender so
    ///         interest already paid via partial-repay or periodic
    ///         settlement is credited exactly once.
    ///
    ///         Branches:
    ///         - Early repay (elapsed < duration, flag on) → effective
    ///           = duration → full-term floor. Lender made whole at
    ///           the original commitment ceiling.
    ///         - At maturity → identical to full-term.
    ///         - In grace (elapsed > duration) → effective = elapsed →
    ///           interest keeps accruing past full-term. (Late fee +
    ///           treasury split stay additive on top, unchanged.)
    ///         - Lender opt-out (`useFullTermInterest = false`) →
    ///           floorDays = 0 → pure pro-rata-elapsed. Both branches
    ///           still accrue through grace.
    ///
    ///         Pre-#408 the `true` branch returned `fullTermInterest`
    ///         directly, capping interest at the duration — blocked
    ///         grace accrual + over-charged on preclose after partial
    ///         (ignored `interestSettled`). The floor + accumulator-
    ///         credit pair fixes both.
    ///
    ///         Partial-repay accounting (Option A): `durationDays` is
    ///         decremented in `RepayFacet.repayPartial` by elapsed-
    ///         since-last-segment, so `floorDays` here always reflects
    ///         the borrower's REMAINING commitment, not the original.
    function settlementInterest(
        LibVaipakam.Loan storage loan,
        uint256 nowTime
    ) internal view returns (uint256) {
        uint256 elapsedDays = nowTime > loan.startTime
            ? (nowTime - loan.startTime) / LibVaipakam.ONE_DAY
            : 0;
        uint256 floorDays = loan.useFullTermInterest ? loan.durationDays : 0;
        uint256 effectiveDays = elapsedDays > floorDays ? elapsedDays : floorDays;
        return proRataInterest(loan.principal, loan.interestRateBps, effectiveDays);
    }

    /// @notice #408/#410/#413 — convenience wrapper that subtracts
    ///         `loan.interestSettled` (saturating at 0) from the gross
    ///         floor returned by `settlementInterest`. Use this from
    ///         `LibSettlement.compute*` + `RepayFacet.calculateRepaymentAmount`
    ///         so the split-treasury math operates on the NET amount.
    function settlementInterestNet(
        LibVaipakam.Loan storage loan,
        uint256 nowTime
    ) internal view returns (uint256) {
        uint256 gross = settlementInterest(loan, nowTime);
        uint256 settled = uint256(loan.interestSettled);
        return gross > settled ? gross - settled : 0;
    }

    /// @notice Applies the treasury cut to an interest-like amount.
    /// @return treasuryShare treasury's cut (cfgTreasuryFeeBps of input).
    /// @return lenderShare the remainder the lender keeps.
    /// @dev `view`, not `pure`: the treasury fee BPS is now admin-configurable
    ///      via {ConfigFacet} and resolved through
    ///      {LibVaipakam.cfgTreasuryFeeBps}. A stored zero falls back to
    ///      the original `TREASURY_FEE_BPS` constant so Phase-1 deployments
    ///      keep a 1% cut until governance changes it.
    function splitTreasury(
        uint256 interestAmount
    ) internal view returns (uint256 treasuryShare, uint256 lenderShare) {
        treasuryShare =
            (interestAmount * LibVaipakam.cfgTreasuryFeeBps()) /
            LibVaipakam.BASIS_POINTS;
        lenderShare = interestAmount - treasuryShare;
    }
}
