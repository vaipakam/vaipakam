// src/libraries/LibCollateralSettlement.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibEntitlement} from "./LibEntitlement.sol";

/**
 * @title LibCollateralSettlement
 * @notice Closed-form math for the live debt + settlement waterfall on a
 *         T-086 prepay collateral listing (Seaport-mediated sale of the
 *         borrower's locked collateral NFT while the loan is still active).
 *
 *         Formula (per
 *         `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md` §5.2):
 *
 *         ```
 *         liveFloor(loanId, asOfTimestamp)
 *             = principal + accruedInterest(asOfTimestamp)
 *             + (treasuryFeeBps + precloseFeeBps) × accruedInterest(asOfTimestamp) / 10000
 *         ```
 *
 *         The three exposed helpers correspond to the three Seaport
 *         consideration items the listing executor will construct + the
 *         zone callback will re-verify at fill time:
 *
 *         | helper                            | maps to                              |
 *         |-----------------------------------|--------------------------------------|
 *         | {principalPlusAccruedInterest}    | `consideration[0]` (lender amount)   |
 *         | {treasuryAndPrecloseFee}          | `consideration[1]` (treasury amount) |
 *         | {liveFloor}                       | sum (minimum aggregate floor price)  |
 *
 *         The borrower's residual (`consideration[2]`) is whatever the
 *         signed `askPrice` is above `liveFloor`; the executor computes
 *         that directly from the order, not via this library.
 *
 * @dev    Pure-math view library. No state writes; no events. The library
 *         reads the loan record + the protocol's treasury-fee config via
 *         {LibVaipakam} and the canonical pro-rata interest helper via
 *         {LibEntitlement.accruedInterestToTime} — same accrual model the
 *         RepayFacet / PrecloseFacet flows use today, so the floor math
 *         can never disagree with what those facets credit.
 *
 *         The preclose-fee summand defaults to `0` while
 *         `cfgPrecloseFeeBps` is not yet wired to {LibVaipakam}; the
 *         executor PR (design doc §13 step 5) adds the config slot +
 *         setter, at which point {treasuryAndPrecloseFee} starts
 *         summing it in without an API change here. The formula
 *         structure matches §5.2 today; only the fee summand widens
 *         later.
 */
library LibCollateralSettlement {
    /// @notice Lender's settlement entitlement at `asOfTimestamp`:
    ///         `loan.principal + accruedInterest(asOfTimestamp)`.
    /// @dev    The accrued-interest helper rounds elapsed time DOWN to whole
    ///         days, matching the canonical RepayFacet / PrecloseFacet
    ///         model. Same rounding model = no off-by-one drift between
    ///         the floor we sign and the floor the loan facets credit on
    ///         a parallel proper-close.
    function principalPlusAccruedInterest(uint256 loanId, uint256 asOfTimestamp)
        internal
        view
        returns (uint256)
    {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        return loan.principal + LibEntitlement.accruedInterestToTime(loan, asOfTimestamp);
    }

    /// @notice Treasury + preclose fee entitlement at `asOfTimestamp`:
    ///         `accruedInterest × (treasuryFeeBps + precloseFeeBps) / 10000`.
    /// @dev    `precloseFeeBps` is currently treated as `0`; the
    ///         {NFTPrepayListingFacet} / {CollateralListingExecutor} PR
    ///         (design doc §13 step 5) adds `cfgPrecloseFeeBps()` to
    ///         {LibVaipakam} and threads it into the sum here. The
    ///         structure of the formula matches §5.2 of the design doc.
    ///
    ///         Returns `0` when the loan has no accrued interest yet
    ///         (e.g. `asOfTimestamp <= loan.startTime` or
    ///         `nowTime - startTime < 1 day`) — the per-day rounding model
    ///         flows through unchanged.
    function treasuryAndPrecloseFee(uint256 loanId, uint256 asOfTimestamp)
        internal
        view
        returns (uint256)
    {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        uint256 accrued = LibEntitlement.accruedInterestToTime(loan, asOfTimestamp);
        if (accrued == 0) return 0;

        // Precloseclose fee summand kept explicit at 0 here so that:
        //  (a) the formula structure exactly mirrors design doc §5.2;
        //  (b) the §13 step-5 PR can drop in a single `cfgPrecloseFeeBps()`
        //      read with a one-line diff, no surrounding shape changes.
        uint256 precloseFeeBps = 0;
        uint256 feeBpsSum = LibVaipakam.cfgTreasuryFeeBps() + precloseFeeBps;

        return (accrued * feeBpsSum) / LibVaipakam.BASIS_POINTS;
    }

    /// @notice The minimum aggregate sale price for a Seaport prepay
    ///         listing at `asOfTimestamp`. Equals
    ///         `principalPlusAccruedInterest + treasuryAndPrecloseFee`.
    ///         Any signed listing whose total of `consideration[0..2]` is
    ///         below this floor MUST be rejected by the ERC-1271 delegate
    ///         (sign-time) and by the zone `validateOrder` callback
    ///         (fill-time, defence against `Seaport.validate()`
    ///         pre-registration per design doc §5.7).
    /// @dev    The function is monotonic non-decreasing in `asOfTimestamp`
    ///         for a fixed loan (interest only accrues, never reverses) —
    ///         a Seaport order signed at `t0` and filled at `t1 > t0` will
    ///         see an equal-or-higher floor at fill time. The 2% buffer
    ///         documented in the design doc (§5.2 closing paragraph) is
    ///         the borrower-side workaround for that drift; this library
    ///         neither imposes nor relaxes the buffer — it just reports
    ///         the exact floor at the queried timestamp.
    function liveFloor(uint256 loanId, uint256 asOfTimestamp)
        internal
        view
        returns (uint256)
    {
        return
            principalPlusAccruedInterest(loanId, asOfTimestamp) +
            treasuryAndPrecloseFee(loanId, asOfTimestamp);
    }
}
