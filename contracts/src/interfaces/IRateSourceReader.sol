// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  IRateSourceReader
 * @author Vaipakam Developer Team
 * @notice A small fixed contract that reads one kind of outside lending
 *         market's current variable BORROWING rate for an asset, for the rate
 *         reference (#3337 part 1, `RateReferenceDesign.md` section 3).
 * @dev    A reader has no owner and no settings. It converts whatever the
 *         market reports (a per-second rate, a per-block rate, a scaled
 *         yearly figure) to the one convention the rate reference compares:
 *         a SIMPLE annual rate, 1e18-scaled (1e18 = 100% a year), over a
 *         365-day year. A read the market cannot answer returns `ok = false`
 *         rather than reverting where the reader can tell; the rate reference
 *         also treats a revert as a failed read.
 */
interface IRateSourceReader {
    /// @notice The market's current variable borrowing rate for `asset`.
    /// @param asset         The lending asset the rate is for.
    /// @param market        The market contract the binding names.
    /// @param marketAssetId The market's own identifier for the asset, where
    ///                      the market needs one beside the asset's address
    ///                      (zero where it does not).
    /// @return ok       False when the market gave no usable answer.
    /// @return rate1e18 The simple annual rate, 1e18-scaled.
    function readRate(address asset, address market, bytes32 marketAssetId)
        external
        view
        returns (bool ok, uint256 rate1e18);
}
