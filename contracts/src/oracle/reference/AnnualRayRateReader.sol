// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IRateSourceReader} from "../../interfaces/IRateSourceReader.sol";

/**
 * @title  AnnualRayRateReader
 * @author Vaipakam Developer Team
 * @notice Reader shape 1 for the rate reference (#3337 part 1,
 *         `RateReferenceDesign.md` section 3): a market that reports, per
 *         asset, its current variable borrowing rate as a simple annual rate
 *         scaled by 1e27, in the fifth word of the reserve record its
 *         `getReserveData(address)` returns. No owner, no settings.
 * @dev    The record is read as raw words, so a market whose record carries
 *         more fields after the fifth reads the same. The asset is the
 *         market's identifier, so `marketAssetId` must be zero. A short or
 *         reverting answer, or a zero rate, reads as failed.
 */
contract AnnualRayRateReader is IRateSourceReader {
    /// @notice The word of the reserve record holding the borrowing rate.
    uint256 public constant RATE_WORD = 4;

    /// @inheritdoc IRateSourceReader
    function readRate(address asset, address market, bytes32 marketAssetId)
        external
        view
        returns (bool ok, uint256 rate1e18)
    {
        if (marketAssetId != bytes32(0) || market.code.length == 0) return (false, 0);
        (bool success, bytes memory data) =
            market.staticcall(abi.encodeWithSignature("getReserveData(address)", asset));
        if (!success || data.length < (RATE_WORD + 1) * 32) return (false, 0);
        uint256 ray;
        // Read word RATE_WORD of the returned record.
        assembly ("memory-safe") {
            ray := mload(add(data, mul(add(RATE_WORD, 1), 32)))
        }
        if (ray == 0) return (false, 0);
        return (true, ray / 1e9);
    }
}
