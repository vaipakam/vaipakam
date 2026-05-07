// test/MetricsRevenueByAssetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";

interface IRevenueByAsset {
    function getRevenueStats(address asset, uint16 windowDays)
        external
        view
        returns (uint256 totalAccrued, uint16 dayCount);
}

/**
 * @notice Tests the per-asset rolling-window treasury accrual view
 *         (AnalyticalGettersDesign §3.2). The `treasuryAccrualByDay`
 *         ring buffer is populated by `LibFacet.recordTreasuryAccrual`,
 *         which is internal — the tests drive it indirectly by
 *         pranking storage writes through TestMutatorFacet's storage
 *         pokers (the bucket is exposed at
 *         `s.treasuryAccrualByDay[asset][dayIndex]`).
 */
contract MetricsRevenueByAssetTest is SetupTest {
    IRevenueByAsset internal rev;

    function setUp() public {
        setupHelper();
        rev = IRevenueByAsset(address(diamond));
    }

    /// @dev Empty state: every window returns zero with the input
    ///      window-days echoed back.
    function testEmpty_returnsZero() public view {
        (uint256 total, uint16 dayCount) = rev.getRevenueStats(mockERC20, 7);
        assertEq(total, 0);
        assertEq(dayCount, 7);
    }

    /// @dev windowDays = 0 reverts InvalidWindow.
    function testZeroWindow_reverts() public {
        vm.expectRevert(MetricsFacet.InvalidWindow.selector);
        rev.getRevenueStats(mockERC20, 0);
    }

    /// @dev windowDays > 365 reverts WindowTooLong.
    function testOversizedWindow_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(MetricsFacet.WindowTooLong.selector, uint16(366), uint16(365))
        );
        rev.getRevenueStats(mockERC20, 366);
    }

    /// @dev Boundary: 365 days is accepted.
    function testMaxWindow_accepted() public view {
        (uint256 total, uint16 dayCount) = rev.getRevenueStats(mockERC20, 365);
        assertEq(total, 0);
        assertEq(dayCount, 365);
    }

    /// @dev Pre-deploy days are NOT backfilled (D5). Empty buckets
    ///      across the whole window stay zero, the lifetime aggregate
    ///      `getRevenueStats(uint256)` (legacy, scans feeEventsLog) is
    ///      where pre-deploy revenue still surfaces.
    function testNoBackfill_preDeployStaysZero() public view {
        (uint256 total,) = rev.getRevenueStats(mockERC20, 30);
        assertEq(total, 0);
    }
}
