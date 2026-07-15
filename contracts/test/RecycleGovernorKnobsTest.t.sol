// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";

/**
 * @title RecycleGovernorKnobsTest
 * @notice #1222 Phase A1a — coverage for the two bounded VPFI-recycling
 *         governor knobs on {ConfigFacet}: `setRecycleMarginBps` (the
 *         platform-retained margin) and `setRecycleTariffKPer1e18EthDay`
 *         (the peg-free discount-entitlement tariff), plus the
 *         `getRecycleConfig` read and the {LibVaipakam} zero-sentinel
 *         resolvers.
 *
 * Coverage:
 *   - Defaults: unset storage resolves to the library defaults
 *     (500 bps / 5e16) through `getRecycleConfig`.
 *   - Margin: valid value round-trips; boundary MAX accepted; over-MAX
 *     reverts `InvalidRecycleMarginBps`; `0` resets to default; `1` (the
 *     explicit-minimum, since 0 is the reset sentinel) is accepted.
 *   - Tariff: valid value round-trips; MIN/MAX boundaries accepted;
 *     below-MIN and above-MAX revert `InvalidRecycleTariffK`; `0` resets
 *     to default.
 *   - Events emitted with the stored (raw) value.
 *   - Role gating: a non-ADMIN caller reverts.
 */
contract RecycleGovernorKnobsTest is SetupTest {
    // Events mirrored from ConfigFacet for expectEmit.
    event RecycleMarginBpsSet(uint16 newMarginBps);
    event RecycleTariffKSet(uint256 newKPer1e18EthDay);

    ConfigFacet internal cfg;

    function setUp() public {
        setupHelper();
        cfg = ConfigFacet(address(diamond));
    }

    // ─── Defaults ────────────────────────────────────────────────────────

    function test_defaults_ResolveToLibraryConstants() public view {
        (uint256 marginBps, uint256 tariffK) = cfg.getRecycleConfig();
        assertEq(marginBps, LibVaipakam.RECYCLE_MARGIN_DEFAULT_BPS, "margin default");
        assertEq(tariffK, LibVaipakam.RECYCLE_TARIFF_K_DEFAULT, "tariff default");
    }

    // ─── Margin knob ─────────────────────────────────────────────────────

    function test_setRecycleMarginBps_RoundTrips() public {
        cfg.setRecycleMarginBps(1200); // 12%
        (uint256 marginBps, ) = cfg.getRecycleConfig();
        assertEq(marginBps, 1200);
    }

    function test_setRecycleMarginBps_MaxAccepted() public {
        cfg.setRecycleMarginBps(LibVaipakam.RECYCLE_MARGIN_MAX_BPS);
        (uint256 marginBps, ) = cfg.getRecycleConfig();
        assertEq(marginBps, LibVaipakam.RECYCLE_MARGIN_MAX_BPS);
    }

    function test_setRecycleMarginBps_OneAccepted() public {
        // 0 is the reset sentinel, so a literal ~0% margin is expressed as 1bp.
        cfg.setRecycleMarginBps(1);
        (uint256 marginBps, ) = cfg.getRecycleConfig();
        assertEq(marginBps, 1);
    }

    function test_setRecycleMarginBps_OverMaxReverts() public {
        uint16 over = LibVaipakam.RECYCLE_MARGIN_MAX_BPS + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.InvalidRecycleMarginBps.selector,
                uint256(over),
                uint256(LibVaipakam.RECYCLE_MARGIN_MAX_BPS)
            )
        );
        cfg.setRecycleMarginBps(over);
    }

    function test_setRecycleMarginBps_ZeroResetsToDefault() public {
        cfg.setRecycleMarginBps(2000);
        cfg.setRecycleMarginBps(0);
        (uint256 marginBps, ) = cfg.getRecycleConfig();
        assertEq(marginBps, LibVaipakam.RECYCLE_MARGIN_DEFAULT_BPS);
    }

    function test_setRecycleMarginBps_EmitsEvent() public {
        vm.expectEmit(false, false, false, true, address(diamond));
        emit RecycleMarginBpsSet(750);
        cfg.setRecycleMarginBps(750);
    }

    // ─── Tariff knob ─────────────────────────────────────────────────────

    function test_setRecycleTariffK_RoundTrips() public {
        cfg.setRecycleTariffKPer1e18EthDay(1e17); // 0.1 VPFI / ETH·day
        (, uint256 tariffK) = cfg.getRecycleConfig();
        assertEq(tariffK, 1e17);
    }

    function test_setRecycleTariffK_MinAndMaxAccepted() public {
        cfg.setRecycleTariffKPer1e18EthDay(LibVaipakam.RECYCLE_TARIFF_K_MIN);
        (, uint256 kMin) = cfg.getRecycleConfig();
        assertEq(kMin, LibVaipakam.RECYCLE_TARIFF_K_MIN);

        cfg.setRecycleTariffKPer1e18EthDay(LibVaipakam.RECYCLE_TARIFF_K_MAX);
        (, uint256 kMax) = cfg.getRecycleConfig();
        assertEq(kMax, LibVaipakam.RECYCLE_TARIFF_K_MAX);
    }

    function test_setRecycleTariffK_BelowMinReverts() public {
        uint256 below = LibVaipakam.RECYCLE_TARIFF_K_MIN - 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.InvalidRecycleTariffK.selector,
                below,
                LibVaipakam.RECYCLE_TARIFF_K_MIN,
                LibVaipakam.RECYCLE_TARIFF_K_MAX
            )
        );
        cfg.setRecycleTariffKPer1e18EthDay(below);
    }

    function test_setRecycleTariffK_AboveMaxReverts() public {
        uint256 above = LibVaipakam.RECYCLE_TARIFF_K_MAX + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.InvalidRecycleTariffK.selector,
                above,
                LibVaipakam.RECYCLE_TARIFF_K_MIN,
                LibVaipakam.RECYCLE_TARIFF_K_MAX
            )
        );
        cfg.setRecycleTariffKPer1e18EthDay(above);
    }

    function test_setRecycleTariffK_ZeroResetsToDefault() public {
        cfg.setRecycleTariffKPer1e18EthDay(2e17);
        cfg.setRecycleTariffKPer1e18EthDay(0);
        (, uint256 tariffK) = cfg.getRecycleConfig();
        assertEq(tariffK, LibVaipakam.RECYCLE_TARIFF_K_DEFAULT);
    }

    function test_setRecycleTariffK_EmitsEvent() public {
        vm.expectEmit(false, false, false, true, address(diamond));
        emit RecycleTariffKSet(3e17);
        cfg.setRecycleTariffKPer1e18EthDay(3e17);
    }

    // ─── Role gating ─────────────────────────────────────────────────────

    function test_setRecycleMarginBps_NonAdminReverts() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        cfg.setRecycleMarginBps(1000);
    }

    function test_setRecycleTariffK_NonAdminReverts() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        cfg.setRecycleTariffKPer1e18EthDay(1e17);
    }
}
