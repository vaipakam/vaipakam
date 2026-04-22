// src/libraries/LibSettlement.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibEntitlement} from "./LibEntitlement.sol";

/**
 * @title LibSettlement
 * @notice Two-phase settlement helper. Separates the "what is owed" math
 *         (phase 1 — pure) from the "move the assets" transfer logic
 *         (phase 2 — facet body).
 * @dev Facets call `computeRepayment` / `computePreclose` to build an
 *      immutable in-memory plan, then feed the plan values into transfers,
 *      claim writes, and events. The plan is the single source of truth for
 *      a settlement: if it says treasury = X and lender = Y, every downstream
 *      side-effect must consume exactly those numbers. This rules out the
 *      class of bug where the event logs one split and the transfer executes
 *      a different one.
 *
 *      Every field here is derived from LibEntitlement primitives, so the
 *      rounding model is identical across settlement paths.
 */
library LibSettlement {
    /// @notice Complete breakdown for an ERC-20 loan being settled
    ///         (full repayment or preclose).
    /// @dev `treasuryShare + lenderShare == interest + lateFee` (exact).
    ///      `lenderDue == principal + lenderShare` (convenience, avoids a
    ///      re-add at the call site).
    struct ERC20Settlement {
        uint256 principal;      // loan.principal at settlement time
        uint256 interest;       // pre-split interest (full-term or pro-rata)
        uint256 lateFee;        // lateness penalty, applied before split
        uint256 treasuryShare;  // treasury cut of interest + lateFee
        uint256 lenderShare;    // lender cut of interest + lateFee
        uint256 lenderDue;      // principal + lenderShare (sent to lender escrow)
    }

    /**
     * @notice Builds the settlement plan for an ERC-20 loan being fully repaid.
     * @param loan Storage pointer to the loan being settled.
     * @param lateFee Late fee in principal-asset units (0 if within term).
     * @param nowTime Reference timestamp for pro-rata accrual
     *                (typically `block.timestamp`).
     */
    function computeRepayment(
        LibVaipakam.Loan storage loan,
        uint256 lateFee,
        uint256 nowTime
    ) internal view returns (ERC20Settlement memory plan) {
        uint256 principal = loan.principal;
        uint256 interest = LibEntitlement.settlementInterest(loan, nowTime);
        (uint256 treasuryShare, uint256 lenderShare) = LibEntitlement.splitTreasury(interest + lateFee);
        plan = ERC20Settlement({
            principal: principal,
            interest: interest,
            lateFee: lateFee,
            treasuryShare: treasuryShare,
            lenderShare: lenderShare,
            lenderDue: principal + lenderShare
        });
    }

    /**
     * @notice Builds the settlement plan for an ERC-20 loan being preclosed
     *         (borrower pays full-term interest early, per README §8 Option 1).
     * @dev No late fee in the preclose path — preclose is strictly pre-maturity.
     */
    function computePreclose(
        LibVaipakam.Loan storage loan
    ) internal view returns (ERC20Settlement memory plan) {
        uint256 principal = loan.principal;
        uint256 interest = LibEntitlement.fullTermInterest(
            principal,
            loan.interestRateBps,
            loan.durationDays
        );
        (uint256 treasuryShare, uint256 lenderShare) = LibEntitlement.splitTreasury(interest);
        plan = ERC20Settlement({
            principal: principal,
            interest: interest,
            lateFee: 0,
            treasuryShare: treasuryShare,
            lenderShare: lenderShare,
            lenderDue: principal + lenderShare
        });
    }
}
