// test/OracleHistoricalPriceTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
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
contract OracleHistoricalPriceTest is SetupTest {
    OracleFacet internal oracle;

    function setUp() public {
        setupHelper();
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
