// src/seaport/IVaipakamListingLegView.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  IVaipakamListingLegView
 * @author Vaipakam Developer Team
 * @notice Call shape of the Diamond's protected-account listing rule
 *         (`ProtectedAccountFacet.isListingLegAllowed`), read by
 *         `CollateralListingExecutor` at every fill.
 * @dev    A marketplace fee leg is paid straight from the sale, outside the
 *         Diamond's payout queue, so the zone asks the Diamond whether the
 *         seller's protection settings allow it: protected mode off, or the
 *         account neither locked nor retired and the recipient its own wallet
 *         or an allowlisted destination. Standalone so no facet has to
 *         inherit it.
 */
interface IVaipakamListingLegView {
    /// @notice Whether a listing `seller` authored may pay `recipient`
    ///         directly at fill. `recipient == seller` answers whether the
    ///         seller may sell at all (false while locked or retired).
    function isListingLegAllowed(address seller, address recipient) external view returns (bool);
}
