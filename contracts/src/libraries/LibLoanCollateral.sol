// src/libraries/LibLoanCollateral.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibPositionNFT} from "./LibPositionNFT.sol";

/**
 * @title  LibLoanCollateral
 * @author Vaipakam Developer Team
 * @notice The ONE writer of a stored loan's `collateralAmount` after
 *         origination (#3710, `PositionSaleStateGuardDesign.md` §3.2).
 * @dev    A reduction is value leaving the loan's positions, so every
 *         reduction marks the loan here ({LibPositionNFT.markLoanValueOut}):
 *         its tokens cool down, its state number goes up and both tokens'
 *         metadata is flagged for refresh. An increase only refreshes the
 *         metadata: collateral added makes the position worth more to a buyer
 *         and does not invalidate a price agreed for it.
 *
 *         `contracts/script/check-loan-collateral-writer.mjs` (pre-deploy step
 *         1d) refuses an assignment to a stored loan's `collateralAmount`
 *         anywhere else in src/, origination aside, so a new route cannot
 *         lower a loan's collateral without the mark.
 */
library LibLoanCollateral {
    /// @notice Lower `loan`'s collateral by `amount` and mark the loan.
    function reduce(LibVaipakam.Loan storage loan, uint256 amount) internal {
        loan.collateralAmount -= amount;
        LibPositionNFT.markLoanValueOut(loan.id);
    }

    /// @notice Raise `loan`'s collateral by `amount` and refresh its tokens'
    ///         metadata. No mark: nothing left the position.
    function add(LibVaipakam.Loan storage loan, uint256 amount) internal {
        loan.collateralAmount += amount;
        LibPositionNFT.refreshLoan(loan.id);
    }

    /// @notice Set `loan`'s collateral to `amount`: marked when that is lower
    ///         than it was, refreshed otherwise.
    function set(LibVaipakam.Loan storage loan, uint256 amount) internal {
        uint256 old = loan.collateralAmount;
        loan.collateralAmount = amount;
        if (amount < old) LibPositionNFT.markLoanValueOut(loan.id);
        else if (amount != old) LibPositionNFT.refreshLoan(loan.id);
    }
}
