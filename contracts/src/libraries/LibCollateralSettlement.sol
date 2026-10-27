// src/libraries/LibCollateralSettlement.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibSettlement} from "./LibSettlement.sol";

/**
 * @title LibCollateralSettlement
 * @notice The lender and treasury legs a collateral-sale close-out owes:
 *         a T-086 prepay or parallel collateral listing (a Seaport sale of
 *         the borrower's locked collateral while the loan is live) and a
 *         swap-to-repay intent fill.
 *
 *         A sale that closes the loan is a proper close, so it owes what a
 *         full repayment owes at the same instant and splits it the same
 *         way. The legs are therefore read from {LibSettlement.computeRepayment},
 *         the plan `RepayFacet.repayLoan` settles with, and never computed
 *         here:
 *
 *         ```
 *         lenderLeg   = principal + lender share of (interest + late fee)
 *         treasuryLeg = treasury share of (interest + late fee)
 *         liveFloor   = lenderLeg + treasuryLeg
 *                     = principal + interest + late fee
 *         ```
 *
 *         where `interest` is {LibEntitlement.settlementInterestNet} (the
 *         full-term coupon on a full-term loan, the accrual otherwise, net
 *         of interest already paid) and the treasury share is a cut OF that
 *         amount at the loan's snapshotted rate, not a charge on top of it.
 *
 *         | helper       | maps to                                          |
 *         |--------------|--------------------------------------------------|
 *         | {saleLegs}   | what the lender and the treasury are paid        |
 *         | {liveFloor}  | their sum: the least the sale must deliver       |
 *
 *         A listing pays its whole proceeds to the Diamond (#2876), which
 *         splits them at the fill: the borrower position's holder receives
 *         whatever the sale raised above {liveFloor}.
 *
 *         Not applied here: the lender's VPFI yield-fee discount, which
 *         the sale settlement resolves when it pays out (#2876), exactly as
 *         repayment does, by shifting value from the treasury leg to the
 *         lender leg. It never changes {liveFloor}. {salePlan} carries the
 *         interest and late fee that resolution is quoted against.
 *
 * @dev    View library; no state writes, no events.
 */
library LibCollateralSettlement {
    /// @notice The lender and treasury legs of a sale that closes `loanId`
    ///         at `asOfTimestamp`: the repayment plan's `lenderDue` and
    ///         `treasuryShare` at that instant, with the late fee the loan
    ///         would owe then.
    /// @dev    Monotonic non-decreasing in `asOfTimestamp` for a fixed loan
    ///         (interest and the late fee only grow), which is what lets a
    ///         Dutch listing fix its legs at the auction's end and still
    ///         cover every earlier fill.
    function saleLegs(uint256 loanId, uint256 asOfTimestamp)
        internal
        view
        returns (uint256 lenderLeg, uint256 treasuryLeg)
    {
        LibSettlement.ERC20Settlement memory plan = salePlan(loanId, asOfTimestamp);
        return (plan.lenderDue, plan.treasuryShare);
    }

    /// @notice The whole repayment plan a sale closing `loanId` at
    ///         `asOfTimestamp` settles with: {saleLegs} plus the interest
    ///         and late fee the treasury share was cut from, which the
    ///         lender's yield-fee discount is quoted against.
    function salePlan(uint256 loanId, uint256 asOfTimestamp)
        internal
        view
        returns (LibSettlement.ERC20Settlement memory plan)
    {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        plan = LibSettlement.computeRepayment(
            loan,
            LibVaipakam.calculateLateFeeAt(loanId, asOfTimestamp),
            asOfTimestamp
        );
    }

    /// @notice The least a sale closing `loanId` at `asOfTimestamp` must
    ///         deliver: `lenderLeg + treasuryLeg`, which is principal plus
    ///         interest plus the late fee. Any listing below it is refused
    ///         at sign time and again at fill time.
    function liveFloor(uint256 loanId, uint256 asOfTimestamp)
        internal
        view
        returns (uint256)
    {
        (uint256 lenderLeg, uint256 treasuryLeg) = saleLegs(loanId, asOfTimestamp);
        return lenderLeg + treasuryLeg;
    }
}
