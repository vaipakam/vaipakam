// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {IAavePoolDataProvider} from "../src/interfaces/IAavePoolDataProvider.sol";
import {IComet} from "../src/interfaces/IComet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/// @title TierLtvRuleTest
/// @notice #3547 (owner decision 2026-11-11) — each tier has a DEFAULT
///         init-LTV (50 / 60 / 65%) and a GOVERNANCE CEILING (55 / 69 / 82%).
///         A usable peer reading (fresh, peer reads not paused) replaces the
///         default, lower or higher, and the result is never above the
///         ceiling. A reading above the ceiling is clipped at the read; one
///         below the old box floor is honoured. Replaces the #2736 box test,
///         whose "out of box ⇒ fall back" rule this decision retired.
contract TierLtvRuleTest is SetupTest {
    uint16 internal constant T1_DEFAULT = 5_000;
    uint16 internal constant T3_DEFAULT = 6_500;
    uint16 internal constant T1_CEIL = 5_500;
    uint16 internal constant T3_CEIL = 8_200;

    address internal aave = makeAddr("aaveDataProvider");
    address internal comet = makeAddr("comet");

    function setUp() public {
        setupHelper();
    }

    function _effective(uint8 tier) internal view returns (uint16) {
        return OracleFacet(address(diamond)).getEffectiveTierMaxInitLtvBps(tier);
    }

    function _seed(uint8 tier, uint16 ltvBps) internal {
        TestMutatorFacet(address(diamond)).setTierLtvCacheRaw(tier, ltvBps, uint64(block.timestamp));
    }

    function _setCeilings(uint16 c1, uint16 c2, uint16 c3) internal {
        ConfigFacet(address(diamond)).setTierLtvParams(c1, 0, c2, 0, c3, 500);
    }

    // ─── The read rule ─────────────────────────────────────────────────

    function test_noReading_usesDefault() public view {
        assertEq(_effective(1), T1_DEFAULT, "tier 1 default");
        assertEq(_effective(2), 6_000, "tier 2 default");
        assertEq(_effective(3), T3_DEFAULT, "tier 3 default");
    }

    function test_readingAboveDefault_belowCeiling_isUsed() public {
        _seed(3, 7_800);
        assertEq(_effective(3), 7_800, "a peer reading may raise the default");
    }

    function test_readingBelowDefault_isUsed() public {
        _seed(3, 6_000);
        assertEq(_effective(3), 6_000, "a peer reading may lower the default");
    }

    function test_readingBelowOldFloor_isHonoured() public {
        // The retired Tier-1 box started at 37%; Tier-3's at 69%.
        _seed(1, 3_000);
        _seed(3, 5_000);
        assertEq(_effective(1), 3_000, "below the old tier-1 floor is used");
        assertEq(_effective(3), 5_000, "below the old tier-3 floor is used");
    }

    function test_readingAboveCeiling_isClippedToCeiling() public {
        _seed(1, 7_000);
        _seed(3, 9_000);
        assertEq(_effective(1), T1_CEIL, "clipped to the tier-1 ceiling");
        assertEq(_effective(3), T3_CEIL, "clipped to the tier-3 ceiling");
    }

    function test_ceilingLowered_bindsAtOnce() public {
        _seed(3, 8_000);
        _setCeilings(5_500, 6_900, 7_500);
        assertEq(_effective(3), 7_500, "a lowered ceiling binds the next read");
    }

    function test_ceilingRaised_admitsStoredReadingUpToIt() public {
        _seed(3, 8_100);
        _setCeilings(5_500, 6_900, 7_500);
        assertEq(_effective(3), 7_500);
        _setCeilings(5_500, 6_900, 8_200);
        assertEq(_effective(3), 8_100, "the read follows the ceiling as it stands now");
    }

    function test_staleReading_fallsBackToDefault() public {
        _seed(3, 8_000);
        vm.warp(block.timestamp + 14 days + 1);
        assertEq(_effective(3), T3_DEFAULT, "a hard-stale reading is not used");
    }

    function test_freshAtHardTtl_isStillUsed() public {
        _seed(3, 8_000);
        vm.warp(block.timestamp + 14 days);
        assertEq(_effective(3), 8_000, "14 days exactly is still fresh");
    }

    function test_peerReadsPaused_fallsBackToDefault() public {
        _seed(3, 8_000);
        AdminFacet(address(diamond)).setPeerLtvReadsPaused(true);
        assertEq(_effective(3), T3_DEFAULT, "paused peer reads skip the reading");
    }

    function test_setDefault_usedWithoutReading() public {
        ConfigFacet(address(diamond)).setTierMaxInitLtvBps(0, 0, 7_000);
        assertEq(_effective(3), 7_000, "a set default applies with no reading");
    }

    function test_setDefault_doesNotBindReading() public {
        // The default is replaced by a usable reading in both directions.
        ConfigFacet(address(diamond)).setTierMaxInitLtvBps(0, 0, 7_500);
        _seed(3, 7_000);
        assertEq(_effective(3), 7_000, "a reading below the default stands");
        ConfigFacet(address(diamond)).setTierMaxInitLtvBps(0, 0, 6_000);
        _seed(3, 7_800);
        assertEq(_effective(3), 7_800, "a reading above the default stands");
    }

    function test_defaultAboveCeiling_readsAsCeiling() public {
        ConfigFacet(address(diamond)).setTierMaxInitLtvBps(6_000, 6_500, 7_000);
        assertEq(_effective(1), T1_CEIL, "a default above the ceiling reads as the ceiling");
        assertEq(_effective(2), 6_500, "a default under the ceiling is unchanged");
    }

    function test_invalidTier_isZero() public view {
        assertEq(_effective(0), 0);
        assertEq(_effective(4), 0);
    }

    // ─── The refresh stores what peers report ──────────────────────────

    function _mockPeers(address a, uint16 ltv) internal {
        vm.mockCall(
            aave,
            abi.encodeWithSelector(IAavePoolDataProvider.getReserveConfigurationData.selector, a),
            abi.encode(
                uint256(18), uint256(ltv), uint256(ltv) + 500, uint256(11_000), uint256(1_000),
                true, true, false, true, false
            )
        );
        IComet.AssetInfo memory info = IComet.AssetInfo({
            offset: 0,
            asset: a,
            priceFeed: address(0),
            scale: uint64(1e8),
            borrowCollateralFactor: uint64(uint256(ltv) * 1e14),
            liquidateCollateralFactor: uint64(uint256(ltv + 500) * 1e14),
            liquidationFactor: uint64(0.93e18),
            supplyCap: type(uint128).max
        });
        vm.mockCall(comet, abi.encodeWithSelector(IComet.getAssetInfoByAddress.selector, a), abi.encode(info));
    }

    /// @dev Two tier-3 reference assets both reporting `ltv` on both peers.
    function _configureTier3(uint16 ltv) internal {
        OracleAdminFacet(address(diamond)).setPeerProtocolAddresses(aave, comet, address(0));
        address[] memory refs = new address[](2);
        refs[0] = makeAddr("ref0");
        refs[1] = makeAddr("ref1");
        _mockPeers(refs[0], ltv);
        _mockPeers(refs[1], ltv);
        OracleAdminFacet(address(diamond)).setTierReferenceAssets(3, refs);
    }

    function test_refresh_storesReadingAboveCeiling_clippedAtRead() public {
        _configureTier3(9_000); // tier-3 haircut 5pp ⇒ 8_500, above 82%
        vm.expectEmit(true, false, false, true, address(diamond));
        emit OracleFacet.TierLtvCacheUpdated(3, 8_500, 0, 2);
        OracleFacet(address(diamond)).refreshTierLtvCache();
        (uint16 cached, uint64 at) = OracleFacet(address(diamond)).getTierLtvCacheEntry(3);
        assertEq(cached, 8_500, "stored unclipped");
        assertEq(at, uint64(block.timestamp));
        assertEq(_effective(3), T3_CEIL, "clipped to the ceiling at the read");
    }

    function test_refresh_storesReadingBelowOldFloor() public {
        _configureTier3(6_000); // haircut ⇒ 5_500, below the old 69% floor
        OracleFacet(address(diamond)).refreshTierLtvCache();
        (uint16 cached, ) = OracleFacet(address(diamond)).getTierLtvCacheEntry(3);
        assertEq(cached, 5_500, "stored, not rejected");
        assertEq(_effective(3), 5_500, "and used");
    }
}
