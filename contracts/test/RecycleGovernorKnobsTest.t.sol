// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";

/**
 * @title RecycleGovernorKnobsTest
 * @notice #1222 Phase A1a — coverage for the bounded VPFI-recycling governor
 *         margin on {ConfigFacet} (`setRecycleMarginBps`), the
 *         `getRecycleConfig` read and the {LibVaipakam} zero-sentinel
 *         resolver. The ETH·day tariff knob it also covered was never wired
 *         and is removed (#1956); the absorption coefficient is the LIF·year K.
 *
 * Coverage:
 *   - Default: unset storage resolves to the library default (500 bps)
 *     through `getRecycleConfig`.
 *   - Margin: valid value round-trips; boundary MAX accepted; over-MAX
 *     reverts `InvalidRecycleMarginBps`; `0` resets to default; `1` (the
 *     explicit-minimum, since 0 is the reset sentinel) is accepted.
 *   - Events emitted with the stored (raw) value.
 *   - Role gating: a non-ADMIN caller reverts.
 */
contract RecycleGovernorKnobsTest is SetupTest {
    // Events mirrored from ConfigFacet for expectEmit.
    event RecycleMarginBpsSet(uint16 newMarginBps);

    ConfigFacet internal cfg;

    function setUp() public {
        setupHelper();
        cfg = ConfigFacet(address(diamond));
    }

    // ─── Defaults ────────────────────────────────────────────────────────

    function test_defaults_ResolveToLibraryConstants() public view {
        assertEq(cfg.getRecycleConfig(), LibVaipakam.RECYCLE_MARGIN_DEFAULT_BPS, "margin default");
    }

    // ─── Margin knob ─────────────────────────────────────────────────────

    function test_setRecycleMarginBps_RoundTrips() public {
        cfg.setRecycleMarginBps(1200); // 12%
        uint256 marginBps = cfg.getRecycleConfig();
        assertEq(marginBps, 1200);
    }

    function test_setRecycleMarginBps_MaxAccepted() public {
        cfg.setRecycleMarginBps(LibVaipakam.RECYCLE_MARGIN_MAX_BPS);
        uint256 marginBps = cfg.getRecycleConfig();
        assertEq(marginBps, LibVaipakam.RECYCLE_MARGIN_MAX_BPS);
    }

    function test_setRecycleMarginBps_OneAccepted() public {
        // 0 is the reset sentinel, so a literal ~0% margin is expressed as 1bp.
        cfg.setRecycleMarginBps(1);
        uint256 marginBps = cfg.getRecycleConfig();
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
        uint256 marginBps = cfg.getRecycleConfig();
        assertEq(marginBps, LibVaipakam.RECYCLE_MARGIN_DEFAULT_BPS);
    }

    function test_setRecycleMarginBps_EmitsEvent() public {
        vm.expectEmit(false, false, false, true, address(diamond));
        emit RecycleMarginBpsSet(750);
        cfg.setRecycleMarginBps(750);
    }

    /// @dev #1956 — the ETH·day tariff knob is gone: its setter is no longer
    ///      routed. This contract holds the admin role, so a routed setter WOULD
    ///      succeed here — the call failing is the selector's absence.
    function test_TheEthDayTariffSetter_IsRetired() public {
        (bool ok, ) = address(diamond).call(abi.encodeWithSignature("setRecycleTariffKPer1e18EthDay(uint256)", 1e17));
        assertFalse(ok, "the retired setter is not routed");
        cfg.setRecycleMarginBps(1200); // fixture-live: this caller passes the admin gate
        assertEq(cfg.getRecycleConfig(), 1200);
    }

    // ─── Role gating ─────────────────────────────────────────────────────

    function test_setRecycleMarginBps_NonAdminReverts() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        cfg.setRecycleMarginBps(1000);
    }
}
