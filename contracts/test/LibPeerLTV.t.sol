// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {LibPeerLTV} from "../src/libraries/LibPeerLTV.sol";
import {IAavePoolDataProvider} from "../src/interfaces/IAavePoolDataProvider.sol";
import {IComet} from "../src/interfaces/IComet.sol";

/// @dev Thin wrapper that surfaces the internal-library helpers as
///      external functions the test can `vm.mockCall` against and
///      assert on. Each helper passes straight through.
contract LibPeerLTVHarness {
    function readAaveLtv(address provider, address asset)
        external
        view
        returns (bool ok, uint16 ltvBps, uint16 liqThresholdBps)
    {
        return LibPeerLTV.readAaveLtv(provider, asset);
    }

    function readCometLtv(address comet, address asset)
        external
        view
        returns (bool ok, uint16 ltvBps, uint16 liqThresholdBps)
    {
        return LibPeerLTV.readCometLtv(comet, asset);
    }

    function aggregateTierLtv(
        address aave,
        address comet,
        address[] memory refAssets,
        uint16 divergenceToleranceBps,
        uint8 minPeerReadings,
        uint8 minAssetReadings
    )
        external
        view
        returns (bool ok, uint16 tierMedianBps, uint8 assetsContributing)
    {
        return LibPeerLTV.aggregateTierLtv(
            aave, comet, refAssets,
            divergenceToleranceBps, minPeerReadings, minAssetReadings
        );
    }
}

/**
 * @title LibPeerLTVTest
 * @notice Phase 3 of AutonomousLtvAndOracleFallback.md — unit coverage
 *         for the peer-LTV read primitives. All cases mock the peer
 *         contract's response via `vm.mockCall`; no diamond / facet
 *         fixture needed.
 *
 *         Cases covered:
 *           - Aave V3 happy path (active, unfrozen, in-band LTVs).
 *           - Aave V3 inactive reserve ⇒ ok=false.
 *           - Aave V3 frozen reserve ⇒ ok=false.
 *           - Aave V3 LTV at the upper bound ⇒ ok=true at 9_900.
 *           - Aave V3 LTV out of band (too high) ⇒ ok=false.
 *           - Aave V3 zero LTV (asset unlisted) ⇒ ok=false.
 *           - Aave V3 zero provider address ⇒ ok=false.
 *           - Aave V3 staticcall reverts ⇒ ok=false (no propagation).
 *           - Compound V3 happy path (1e18-scaled CF → BPS normalised).
 *           - Compound V3 unlisted asset (call reverts) ⇒ ok=false.
 *           - Compound V3 returned struct's asset mismatches query ⇒ ok=false.
 *           - Compound V3 CF out of band ⇒ ok=false.
 *           - Compound V3 zero Comet address ⇒ ok=false.
 */
contract LibPeerLTVTest is Test {
    LibPeerLTVHarness internal harness;
    address internal aaveProvider = makeAddr("aaveProvider");
    address internal comet = makeAddr("cometV3");
    address internal asset = makeAddr("wbtc");

    function setUp() public {
        harness = new LibPeerLTVHarness();
    }

    // ─── Aave V3 ────────────────────────────────────────────────────────

    /// @dev Encodes a synthetic `getReserveConfigurationData` return
    ///      for the mock. Layout matches the Aave V3 interface — all
    ///      uint256 / bool fields, ABI-padded to one 32-byte slot each
    ///      (10 fields × 32 bytes = 320 bytes total).
    function _encodeAaveConfig(
        uint256 ltv,
        uint256 liquidationThreshold,
        bool isActive,
        bool isFrozen
    ) internal pure returns (bytes memory) {
        return abi.encode(
            uint256(18),                   // decimals
            ltv,
            liquidationThreshold,
            uint256(11_000),               // liquidationBonus (irrelevant)
            uint256(1_000),                // reserveFactor (irrelevant)
            true,                          // usageAsCollateralEnabled
            true,                          // borrowingEnabled
            false,                         // stableBorrowRateEnabled
            isActive,
            isFrozen
        );
    }

    function testAave_HappyPath() public {
        vm.mockCall(
            aaveProvider,
            abi.encodeWithSelector(
                IAavePoolDataProvider.getReserveConfigurationData.selector,
                asset
            ),
            _encodeAaveConfig(7_300, 7_800, true, false)
        );
        (bool ok, uint16 ltv, uint16 liq) = harness.readAaveLtv(aaveProvider, asset);
        assertTrue(ok, "happy path must return ok");
        assertEq(ltv, 7_300);
        assertEq(liq, 7_800);
    }

    function testAave_InactiveReserveRejected() public {
        vm.mockCall(
            aaveProvider,
            abi.encodeWithSelector(
                IAavePoolDataProvider.getReserveConfigurationData.selector,
                asset
            ),
            _encodeAaveConfig(7_300, 7_800, false, false)
        );
        (bool ok, , ) = harness.readAaveLtv(aaveProvider, asset);
        assertFalse(ok, "inactive reserve must be rejected");
    }

    function testAave_FrozenReserveRejected() public {
        vm.mockCall(
            aaveProvider,
            abi.encodeWithSelector(
                IAavePoolDataProvider.getReserveConfigurationData.selector,
                asset
            ),
            _encodeAaveConfig(7_300, 7_800, true, true)
        );
        (bool ok, , ) = harness.readAaveLtv(aaveProvider, asset);
        assertFalse(ok, "frozen reserve must be rejected");
    }

    function testAave_AtUpperBoundAccepted() public {
        vm.mockCall(
            aaveProvider,
            abi.encodeWithSelector(
                IAavePoolDataProvider.getReserveConfigurationData.selector,
                asset
            ),
            _encodeAaveConfig(9_900, 9_900, true, false)
        );
        (bool ok, uint16 ltv, ) = harness.readAaveLtv(aaveProvider, asset);
        assertTrue(ok, "exact upper-bound LTV must be accepted");
        assertEq(ltv, 9_900);
    }

    function testAave_OutOfBandRejected() public {
        // LTV above MAX_PLAUSIBLE (9_900) ⇒ rejected.
        vm.mockCall(
            aaveProvider,
            abi.encodeWithSelector(
                IAavePoolDataProvider.getReserveConfigurationData.selector,
                asset
            ),
            _encodeAaveConfig(9_901, 9_950, true, false)
        );
        (bool ok, , ) = harness.readAaveLtv(aaveProvider, asset);
        assertFalse(ok, "above-band LTV must be rejected");
    }

    function testAave_ZeroLtvRejected() public {
        // LTV == 0 ⇒ asset unlisted on this Aave (Aave returns zeros).
        vm.mockCall(
            aaveProvider,
            abi.encodeWithSelector(
                IAavePoolDataProvider.getReserveConfigurationData.selector,
                asset
            ),
            _encodeAaveConfig(0, 0, false, false)
        );
        (bool ok, , ) = harness.readAaveLtv(aaveProvider, asset);
        assertFalse(ok, "zero LTV (unlisted) must be rejected");
    }

    function testAave_ZeroProviderAddressRejected() public view {
        (bool ok, , ) = harness.readAaveLtv(address(0), asset);
        assertFalse(ok, "zero provider must short-circuit ok=false");
    }

    function testAave_StaticcallRevertNoPropagation() public {
        vm.mockCallRevert(
            aaveProvider,
            abi.encodeWithSelector(
                IAavePoolDataProvider.getReserveConfigurationData.selector,
                asset
            ),
            "boom"
        );
        // The staticcall returns success=false; the library returns
        // ok=false WITHOUT propagating the revert.
        (bool ok, , ) = harness.readAaveLtv(aaveProvider, asset);
        assertFalse(ok, "staticcall revert must NOT propagate");
    }

    // ─── Compound V3 ────────────────────────────────────────────────────

    function _encodeCometAssetInfo(
        address infoAsset,
        uint64 borrowCf,
        uint64 liquidateCf
    ) internal pure returns (bytes memory) {
        IComet.AssetInfo memory info = IComet.AssetInfo({
            offset: 0,
            asset: infoAsset,
            priceFeed: address(0),
            scale: uint64(1e8),
            borrowCollateralFactor: borrowCf,
            liquidateCollateralFactor: liquidateCf,
            liquidationFactor: uint64(0.93e18),
            supplyCap: type(uint128).max
        });
        return abi.encode(info);
    }

    function testCompound_HappyPath() public {
        // borrowCf = 0.75e18 → 7500 BPS; liquidateCf = 0.80e18 → 8000 BPS.
        vm.mockCall(
            comet,
            abi.encodeWithSelector(IComet.getAssetInfoByAddress.selector, asset),
            _encodeCometAssetInfo(asset, uint64(0.75e18), uint64(0.80e18))
        );
        (bool ok, uint16 ltv, uint16 liq) = harness.readCometLtv(comet, asset);
        assertTrue(ok, "happy path must return ok");
        assertEq(ltv, 7_500, "borrowCf -> 7500 BPS");
        assertEq(liq, 8_000, "liquidateCf -> 8000 BPS");
    }

    function testCompound_UnlistedAssetReverts_OkFalse() public {
        // Compound REVERTS on unlisted asset; staticcall+success-check
        // catches it without bubbling.
        vm.mockCallRevert(
            comet,
            abi.encodeWithSelector(IComet.getAssetInfoByAddress.selector, asset),
            "bad asset"
        );
        (bool ok, , ) = harness.readCometLtv(comet, asset);
        assertFalse(ok, "unlisted-asset revert must NOT propagate");
    }

    function testCompound_AssetMismatchRejected() public {
        // Returned struct's `asset` field doesn't match the query —
        // pathological peer state; library rejects.
        address otherAsset = makeAddr("other");
        vm.mockCall(
            comet,
            abi.encodeWithSelector(IComet.getAssetInfoByAddress.selector, asset),
            _encodeCometAssetInfo(otherAsset, uint64(0.75e18), uint64(0.80e18))
        );
        (bool ok, , ) = harness.readCometLtv(comet, asset);
        assertFalse(ok, "asset-field mismatch must reject");
    }

    function testCompound_OutOfBandRejected() public {
        // borrowCf at 1.01e18 → 10_100 BPS — implausibly above 100%.
        vm.mockCall(
            comet,
            abi.encodeWithSelector(IComet.getAssetInfoByAddress.selector, asset),
            _encodeCometAssetInfo(asset, uint64(1.01e18), uint64(1.01e18))
        );
        (bool ok, , ) = harness.readCometLtv(comet, asset);
        assertFalse(ok, "out-of-band CF must be rejected");
    }

    function testCompound_ZeroCometAddressRejected() public view {
        (bool ok, , ) = harness.readCometLtv(address(0), asset);
        assertFalse(ok, "zero comet must short-circuit ok=false");
    }

    // ─── Aggregator (per-tier consensus across reference assets) ────────

    /// @dev Set up Aave + Compound peer mocks for an asset returning
    ///      the given borrowable LTV (BPS) on each side. Helper keeps
    ///      the aggregator tests readable.
    function _mockPeers(address a, uint16 aaveLtv, uint16 cometLtv) internal {
        if (aaveLtv > 0) {
            vm.mockCall(
                aaveProvider,
                abi.encodeWithSelector(
                    IAavePoolDataProvider.getReserveConfigurationData.selector,
                    a
                ),
                _encodeAaveConfig(uint256(aaveLtv), uint256(aaveLtv) + 500, true, false)
            );
        }
        if (cometLtv > 0) {
            // 1e18-scaled CF from BPS: bps × 1e14 = 1e18-scaled fraction.
            uint64 cf = uint64(uint256(cometLtv) * 1e14);
            vm.mockCall(
                comet,
                abi.encodeWithSelector(IComet.getAssetInfoByAddress.selector, a),
                _encodeCometAssetInfo(a, cf, uint64(uint256(cometLtv + 500) * 1e14))
            );
        }
    }

    /// @dev Three reference assets, each peer reports identical LTVs
    ///      ⇒ per-asset median = peer LTV, tier median = median across
    ///      the three reference assets.
    function testAggregate_HappyPath_ThreeAssetsAgree() public {
        address[] memory refs = new address[](3);
        refs[0] = makeAddr("ref0");
        refs[1] = makeAddr("ref1");
        refs[2] = makeAddr("ref2");

        _mockPeers(refs[0], 7_300, 7_300);   // asset 0: median 7300
        _mockPeers(refs[1], 7_500, 7_500);   // asset 1: median 7500
        _mockPeers(refs[2], 7_700, 7_700);   // asset 2: median 7700

        (bool ok, uint16 median, uint8 n) = harness.aggregateTierLtv(
            aaveProvider, comet, refs, 1_500, 2, 2
        );
        assertTrue(ok);
        // Tier median of [7300, 7500, 7700] = 7500.
        assertEq(median, 7_500);
        assertEq(n, 3);
    }

    /// @dev Two reference assets, each peer agrees within tolerance ⇒
    ///      tier median = average of the two asset-medians.
    function testAggregate_TwoAssetsTierMedianIsAverage() public {
        address[] memory refs = new address[](2);
        refs[0] = makeAddr("ref0");
        refs[1] = makeAddr("ref1");
        _mockPeers(refs[0], 7_000, 7_400);   // asset 0: median (7000+7400)/2 = 7200
        _mockPeers(refs[1], 6_800, 7_200);   // asset 1: median 7000

        (bool ok, uint16 median, uint8 n) = harness.aggregateTierLtv(
            aaveProvider, comet, refs, 1_500, 2, 2
        );
        assertTrue(ok);
        // Tier median of [7200, 7000] = (7200+7000)/2 = 7100.
        assertEq(median, 7_100);
        assertEq(n, 2);
    }

    /// @dev Per-asset peer divergence above tolerance ⇒ that asset
    ///      drops out of the tier aggregation.
    function testAggregate_AssetWithDivergentPeersExcluded() public {
        address[] memory refs = new address[](3);
        refs[0] = makeAddr("ref0");
        refs[1] = makeAddr("ref1");
        refs[2] = makeAddr("ref2");
        _mockPeers(refs[0], 7_000, 7_300);                       // diff 300, within tolerance 1500
        _mockPeers(refs[1], 5_000, 8_500);                       // diff 3500, ABOVE tolerance → excluded
        _mockPeers(refs[2], 7_500, 7_600);                       // diff 100, within tolerance

        (bool ok, uint16 median, uint8 n) = harness.aggregateTierLtv(
            aaveProvider, comet, refs, 1_500, 2, 2
        );
        assertTrue(ok);
        assertEq(n, 2, "asset[1] must be excluded as divergent");
        // Tier median of [7150, 7550] = 7350.
        assertEq(median, 7_350);
    }

    /// @dev Below `minAssetReadings` ⇒ tier rejected.
    function testAggregate_InsufficientAssetsRejected() public {
        address[] memory refs = new address[](2);
        refs[0] = makeAddr("ref0");
        refs[1] = makeAddr("ref1");
        // asset[0]: divergent → drops out
        _mockPeers(refs[0], 5_000, 8_500);
        // asset[1]: only Aave reports (no Compound) → 1 peer < 2 minPeer → drops out
        vm.mockCall(
            aaveProvider,
            abi.encodeWithSelector(
                IAavePoolDataProvider.getReserveConfigurationData.selector,
                refs[1]
            ),
            _encodeAaveConfig(7_200, 7_500, true, false)
        );
        // Compound REVERTS on the asset (not listed).
        vm.mockCallRevert(
            comet,
            abi.encodeWithSelector(IComet.getAssetInfoByAddress.selector, refs[1]),
            "not listed"
        );

        (bool ok, , uint8 n) = harness.aggregateTierLtv(
            aaveProvider, comet, refs, 1_500, 2, 2
        );
        assertFalse(ok, "0 contributing assets must reject the tier");
        assertEq(n, 0);
    }

    /// @dev Empty reference list ⇒ tier rejected.
    function testAggregate_EmptyRefListRejected() public view {
        address[] memory refs = new address[](0);
        (bool ok, uint16 median, uint8 n) = harness.aggregateTierLtv(
            aaveProvider, comet, refs, 1_500, 2, 2
        );
        assertFalse(ok);
        assertEq(median, 0);
        assertEq(n, 0);
    }
}
