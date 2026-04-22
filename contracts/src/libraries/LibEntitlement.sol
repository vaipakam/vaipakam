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
 *      (transfers, escrow routing, claim bookkeeping). Keeping the math in
 *      one place means one rounding model, one off-by-one surface, and one
 *      place to audit when the interest / fee policy changes.
 */
library LibEntitlement {
    /// @notice Full-term interest: `principal * rateBps * durationDays / (DAYS_PER_YEAR * BASIS_POINTS)`.
    /// @dev Used when the loan is repaid-early-but-owes-full-term (README: lender
    ///      is made whole on duration) or at refinance when Alice owes the old
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

    /// @notice Interest owed on an ERC-20 loan at settlement time: either the
    ///         promised full-term amount (if `useFullTermInterest`) or pro-rata
    ///         accrual up to `nowTime`.
    function settlementInterest(
        LibVaipakam.Loan storage loan,
        uint256 nowTime
    ) internal view returns (uint256) {
        if (loan.useFullTermInterest) {
            return fullTermInterest(loan.principal, loan.interestRateBps, loan.durationDays);
        }
        return accruedInterestToTime(loan, nowTime);
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
