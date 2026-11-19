// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IRateSourceReader} from "../../interfaces/IRateSourceReader.sol";

/// @dev The read surface of a single-asset market that prices borrowing by
///      its utilisation.
interface IUtilisationMarket {
    function baseToken() external view returns (address);
    function getUtilization() external view returns (uint256);
    function getBorrowRate(uint256 utilization) external view returns (uint64);
}

/**
 * @title  PerSecondUtilisationRateReader
 * @author Vaipakam Developer Team
 * @notice Reader shape 2 for the rate reference (#3337 part 1,
 *         `RateReferenceDesign.md` section 3): a single-asset market that
 *         reports a borrowing rate per second, 1e18-scaled, at its current
 *         utilisation. The reader multiplies by a 365-day year to give the
 *         simple annual rate. No owner, no settings.
 * @dev    The market lends one asset, its `baseToken`; a binding whose asset
 *         is not that token reads as failed, as does `marketAssetId` other
 *         than zero, a revert or a zero rate.
 */
contract PerSecondUtilisationRateReader is IRateSourceReader {
    /// @inheritdoc IRateSourceReader
    function readRate(address asset, address market, bytes32 marketAssetId)
        external
        view
        returns (bool ok, uint256 rate1e18)
    {
        if (marketAssetId != bytes32(0) || market.code.length == 0) return (false, 0);
        try IUtilisationMarket(market).baseToken() returns (address base) {
            if (base != asset) return (false, 0);
        } catch {
            return (false, 0);
        }
        uint256 u;
        try IUtilisationMarket(market).getUtilization() returns (uint256 x) {
            u = x;
        } catch {
            return (false, 0);
        }
        try IUtilisationMarket(market).getBorrowRate(u) returns (uint64 perSecond) {
            if (perSecond == 0) return (false, 0);
            return (true, uint256(perSecond) * 365 days);
        } catch {
            return (false, 0);
        }
    }
}
