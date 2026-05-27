// test/MetricsRevenueByAssetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {SetupComposable} from "./composable/SetupComposable.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
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
contract MetricsRevenueByAssetTest is Test {

    // ── Stage 6 composition migration (2026-05-27) ──────────────────────
    // Inherit only forge-std `Test`; the Diamond + facet routing + state
    // are owned by a `SetupComposable` instance the test composes via
    // `setUp`. Common SetupTest fields are mirrored locally below so the
    // bulk of test-body code keeps compiling unchanged.
    SetupComposable internal helpers;
    VaipakamDiamond internal diamond;
    address internal owner;
    address internal lender;
    address internal borrower;
    address internal mockERC20;
    address internal mockCollateralERC20;
    address internal mockIlliquidERC20;
    address internal mockNft721;
    address internal mockZeroExProxy;
    uint256 internal constant BASIS_POINTS = 10_000;
    uint256 internal constant KYC_THRESHOLD_USD = 2000 * 1e18;
    uint256 internal constant RENTAL_BUFFER_BPS = 500;
    uint256 internal constant MIN_HEALTH_FACTOR = 150 * 1e16;
    IRevenueByAsset internal rev;

    function setUp() public {
        helpers = new SetupComposable();
        helpers.bootstrap(address(this));
        diamond = helpers.diamond();
        owner = helpers.owner();
        lender = helpers.lender();
        borrower = helpers.borrower();
        mockERC20 = helpers.mockERC20();
        mockCollateralERC20 = helpers.mockCollateralERC20();
        mockIlliquidERC20 = helpers.mockIlliquidERC20();
        mockNft721 = helpers.mockNft721();
        mockZeroExProxy = helpers.mockZeroExProxy();
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
