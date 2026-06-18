// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {AggregatorAdapterFactoryFacet} from "../src/facets/AggregatorAdapterFactoryFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";

/**
 * @title  AdminKillSwitchTest
 * @notice #633 — admin/governance kill-switches over currently-ON features.
 *         Verifies the PAUSE semantics (default false = active, so no behaviour
 *         change), the gates, and admin-only authorization. The global keeper
 *         pause's effect on the KEEPER_ROLE backstop path is covered in
 *         BackstopAbsorbTest (`test_absorb_keepersPaused_reverts`).
 */
contract AdminKillSwitchTest is SetupTest {
    function setUp() public {
        setupHelper();
    }

    address internal constant STRANGER = address(0xBEEF);

    // ─── Flag 1: aggregator adapters ────────────────────────────────────────

    function test_aggregatorAdaptersPaused_blocksCreate() public {
        vm.prank(owner);
        AdminFacet(address(diamond)).setAggregatorAdaptersPaused(true);
        // The pause gate runs BEFORE the template check, so this reverts with the
        // pause error even though no template is set.
        vm.prank(owner);
        vm.expectRevert(AggregatorAdapterFactoryFacet.AggregatorAdaptersPaused.selector);
        AggregatorAdapterFactoryFacet(address(diamond)).createAggregatorAdapter(
            STRANGER, mockERC20, mockCollateralERC20, 100, STRANGER,
            "n", "s", 1e18, 500, 5000, 30, 1e18
        );
    }

    function test_aggregatorAdaptersUnpaused_gateCleared() public {
        // Unpaused (default) ⇒ the pause gate is cleared, so create reaches the
        // template check and reverts with AdapterTemplateNotSet instead — proving
        // the pause gate is no longer the blocker.
        vm.prank(owner);
        vm.expectRevert(AggregatorAdapterFactoryFacet.AdapterTemplateNotSet.selector);
        AggregatorAdapterFactoryFacet(address(diamond)).createAggregatorAdapter(
            STRANGER, mockERC20, mockCollateralERC20, 100, STRANGER,
            "n", "s", 1e18, 500, 5000, 30, 1e18
        );
    }

    // ─── Flag 3: swap-venue pause ───────────────────────────────────────────

    function test_swapAdapterDisabled_roundTrip() public {
        address venue = makeAddr("venue");
        // Must be a REGISTERED adapter (the setter rejects unknown addresses).
        vm.prank(owner);
        AdminFacet(address(diamond)).addSwapAdapter(venue);
        assertFalse(AdminFacet(address(diamond)).isSwapAdapterDisabled(venue), "default active");
        vm.prank(owner);
        AdminFacet(address(diamond)).setSwapAdapterDisabled(venue, true);
        assertTrue(AdminFacet(address(diamond)).isSwapAdapterDisabled(venue), "paused");
        vm.prank(owner);
        AdminFacet(address(diamond)).setSwapAdapterDisabled(venue, false);
        assertFalse(AdminFacet(address(diamond)).isSwapAdapterDisabled(venue), "re-activated");
    }

    // ─── Flag 4: peer-LTV reads ─────────────────────────────────────────────

    function test_peerLtvReadsPaused_blocksRefresh() public {
        vm.prank(owner);
        AdminFacet(address(diamond)).setPeerLtvReadsPaused(true);
        vm.expectRevert(OracleFacet.PeerLtvReadsPaused.selector);
        OracleFacet(address(diamond)).refreshTierLtvCache();
    }

    function test_peerLtvReadsUnpaused_refreshRuns() public {
        // Default (unpaused) ⇒ refreshTierLtvCache runs without the pause revert
        // (it emits per-tier rejections when no reference assets are configured,
        // but does not revert PeerLtvReadsPaused).
        OracleFacet(address(diamond)).refreshTierLtvCache();
    }

    // ─── Admin-only authorization ───────────────────────────────────────────

    function test_setters_adminOnly() public {
        vm.startPrank(STRANGER);
        vm.expectRevert();
        AdminFacet(address(diamond)).setAggregatorAdaptersPaused(true);
        vm.expectRevert();
        AdminFacet(address(diamond)).setKeepersPaused(true);
        vm.expectRevert();
        AdminFacet(address(diamond)).setPeerLtvReadsPaused(true);
        vm.expectRevert();
        AdminFacet(address(diamond)).setSwapAdapterDisabled(STRANGER, true);
        vm.stopPrank();
    }
}
