// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ConfigureCcip} from "../../script/ConfigureCcip.s.sol";
import {LibInteractionRewards} from "../../src/libraries/LibInteractionRewards.sol";
import {VpfiPoolRateBounds} from "../../src/crosschain/VpfiPoolRateBounds.sol";

/// @title  ConfigureCcipLanePreflightTest — #918's blocking lane pre-flight.
/// @notice `ConfigureCcip` refuses, before any broadcast, a per-lane rate
///         capacity below the largest fresh reward day slice. A smaller lane
///         would still work (a day goes in parts), so this is the owner's
///         chosen operational floor, not a correctness bound — which is why
///         the same comparison is only advisory in launch readiness.
contract ConfigureCcipLanePreflightTest is Test {
    ConfigureCcip internal script;

    function setUp() public {
        script = new ConfigureCcip();
    }

    function test_TheSlice_IsBothHalvesOfDayOne() public pure {
        uint256 slice = LibInteractionRewards.maxFreshDaySlice();
        assertEq(slice, 2 * LibInteractionRewards.halfPoolForDay(1), "both halves of the highest-rate day");
        for (uint256 d = 2; d < 3000; d += 97) {
            assertLe(2 * LibInteractionRewards.halfPoolForDay(d), slice, "no later day carries more");
        }
        // About 20,164 VPFI: inside the governor's bounds and under the 50k default.
        assertGt(slice, 20_000 ether);
        assertLt(slice, 20_200 ether);
        assertGe(slice, VpfiPoolRateBounds.MIN_CAPACITY, "the floor is reachable within the governor's bounds");
        assertLe(slice, 50_000 ether, "the script's default capacity passes");
    }

    function test_ACapacityBelowTheSlice_IsRefused() public {
        uint256 slice = LibInteractionRewards.maxFreshDaySlice();
        script.requireLaneFitsFreshDaySlice(slice);
        script.requireLaneFitsFreshDaySlice(50_000 ether);
        vm.expectRevert();
        script.requireLaneFitsFreshDaySlice(slice - 1);
        vm.expectRevert();
        script.requireLaneFitsFreshDaySlice(VpfiPoolRateBounds.MIN_CAPACITY);
    }

    /// @dev The refusal must run before the first broadcast, as the guardian
    ///      check does: a refusal after it would leave a half-wired stack.
    ///      Read from the script's own source, because the property is about
    ///      the order of statements in `run()`, which no call can observe.
    function test_ThePreflight_RunsBeforeAnyBroadcast() public view {
        string memory src = vm.readFile("script/ConfigureCcip.s.sol");
        uint256 check = _indexOf(src, "requireLaneFitsFreshDaySlice(c.rateCapacity);");
        uint256 broadcast = _indexOf(src, "vm.startBroadcast(");
        assertTrue(check != type(uint256).max, "run() calls the pre-flight");
        assertTrue(broadcast != type(uint256).max, "fixture: the script broadcasts");
        assertLt(check, broadcast, "the pre-flight precedes the first broadcast");
    }

    function _indexOf(string memory hay, string memory needle) private pure returns (uint256) {
        bytes memory h = bytes(hay);
        bytes memory n = bytes(needle);
        if (n.length > h.length) return type(uint256).max;
        for (uint256 i; i + n.length <= h.length; ++i) {
            bool ok = true;
            for (uint256 j; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return i;
        }
        return type(uint256).max;
    }
}
