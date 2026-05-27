// test/OracleHistoricalPriceTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {SetupComposable} from "./composable/SetupComposable.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";

/**
 * @notice Tests the daily price-snapshot ring buffer
 *         (AnalyticalGettersDesign §3.4 — Bucket-C → Bucket-A move
 *         for historical TVL reconstruction).
 *
 *         The on-chain side: `captureDailyPriceSnapshot` is
 *         permissionless (D10) and idempotent within a UTC day —
 *         the first caller wins, subsequent calls in the same day
 *         silently skip already-captured assets.
 */
contract OracleHistoricalPriceTest is Test {

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
    OracleFacet internal oracle;

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
        oracle = OracleFacet(address(diamond));
    }

    /// @dev Empty state: every (asset, day) returns the zero struct.
    function testReadEmpty_returnsZeroStruct() public view {
        LibVaipakam.AssetPriceSnapshot memory snap =
            oracle.getHistoricalAssetPrice(mockERC20, 0);
        assertEq(snap.price, 0);
        assertEq(snap.feedDecimals, 0);
        assertEq(snap.capturedAt, 0);
    }

    /// @dev Capture writes the slot for today; the read echoes
    ///      price + feedDecimals + capturedAt.
    function testCapture_writesTodaySlot() public {
        address[] memory assets = new address[](1);
        assets[0] = mockERC20;
        oracle.captureDailyPriceSnapshot(assets);

        uint32 today = uint32(block.timestamp / 1 days);
        LibVaipakam.AssetPriceSnapshot memory snap =
            oracle.getHistoricalAssetPrice(mockERC20, today);
        assertGt(snap.price, 0);
        assertEq(snap.feedDecimals, 8); // mock feed default
        assertEq(snap.capturedAt, uint64(block.timestamp));
    }

    /// @dev Same-day double-capture is idempotent — the second
    ///      call doesn't overwrite (silent-skip on already-captured).
    function testCapture_sameDayIdempotent() public {
        address[] memory assets = new address[](1);
        assets[0] = mockERC20;

        oracle.captureDailyPriceSnapshot(assets);
        uint32 today = uint32(block.timestamp / 1 days);
        uint64 firstCapturedAt =
            oracle.getHistoricalAssetPrice(mockERC20, today).capturedAt;

        // Move clock forward but stay inside the same UTC day.
        vm.warp(block.timestamp + 100);
        oracle.captureDailyPriceSnapshot(assets);

        LibVaipakam.AssetPriceSnapshot memory snap =
            oracle.getHistoricalAssetPrice(mockERC20, today);
        // capturedAt stays at the first call's timestamp because the
        // second call silently skipped.
        assertEq(snap.capturedAt, firstCapturedAt);
    }

    /// @dev Batch capture writes every asset in one tx.
    function testCapture_batchMultipleAssets() public {
        address[] memory assets = new address[](2);
        assets[0] = mockERC20;
        assets[1] = mockCollateralERC20;

        oracle.captureDailyPriceSnapshot(assets);
        uint32 today = uint32(block.timestamp / 1 days);
        assertGt(oracle.getHistoricalAssetPrice(mockERC20, today).capturedAt, 0);
        assertGt(
            oracle.getHistoricalAssetPrice(mockCollateralERC20, today).capturedAt,
            0
        );
    }

    /// @dev Permissionless — anyone can fire the capture.
    function testCapture_anyCallerCanFire() public {
        address[] memory assets = new address[](1);
        assets[0] = mockERC20;
        address randomCaller = makeAddr("randomCaller");

        vm.prank(randomCaller);
        oracle.captureDailyPriceSnapshot(assets);

        uint32 today = uint32(block.timestamp / 1 days);
        assertGt(oracle.getHistoricalAssetPrice(mockERC20, today).capturedAt, 0);
    }
}
