// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ConfigureCcip} from "../../script/ConfigureCcip.s.sol";
import {LibInteractionRewards} from "../../src/libraries/LibInteractionRewards.sol";
import {VpfiPoolRateBounds} from "../../src/crosschain/VpfiPoolRateBounds.sol";
import {TokenPool} from "@chainlink/contracts-ccip/contracts/pools/TokenPool.sol";
import {RateLimiter} from "@chainlink/contracts-ccip/contracts/libraries/RateLimiter.sol";

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

    /// @dev #3539 — a lane is ADDED with both buckets on, at the run's
    ///      figures, so it is never observable unlimited.
    function test_LaneAdd_CreatesTheLaneLimitedBothWays() public view {
        address remotePool = address(0xB00C);
        address remoteToken = address(0x70C3);
        TokenPool.ChainUpdate[] memory adds =
            script.laneAdd(42, remotePool, remoteToken, 50_000 ether, 5.8 ether);
        assertEq(adds.length, 1, "one lane");
        assertEq(adds[0].remoteChainSelector, 42, "selector");
        assertEq(adds[0].remotePoolAddresses.length, 1, "one remote pool");
        assertEq(adds[0].remotePoolAddresses[0], abi.encode(remotePool), "remote pool");
        assertEq(adds[0].remoteTokenAddress, abi.encode(remoteToken), "remote token");
        _assertOn(adds[0].outboundRateLimiterConfig, 50_000 ether, 5.8 ether);
        _assertOn(adds[0].inboundRateLimiterConfig, 50_000 ether, 5.8 ether);
    }

    /// @dev The figures the lane is created with must be ones the governor
    ///      accepts, so its later calls only retune them. Checked in `run()`
    ///      before any broadcast, and again where the lane is built.
    function test_LaneRateLimit_RefusesFiguresOutsideTheGovernorBounds() public {
        script.laneRateLimit(VpfiPoolRateBounds.MIN_CAPACITY, VpfiPoolRateBounds.MIN_RATE);
        script.laneRateLimit(VpfiPoolRateBounds.MAX_CAPACITY, VpfiPoolRateBounds.MAX_RATE);

        vm.expectRevert();
        script.laneRateLimit(VpfiPoolRateBounds.MIN_CAPACITY - 1, 5.8 ether);
        vm.expectRevert();
        script.laneRateLimit(VpfiPoolRateBounds.MAX_CAPACITY + 1, 5.8 ether);
        vm.expectRevert();
        script.laneRateLimit(50_000 ether, VpfiPoolRateBounds.MIN_RATE - 1);
        vm.expectRevert();
        script.laneRateLimit(50_000 ether, VpfiPoolRateBounds.MAX_RATE + 1);
        vm.expectRevert();
        script.laneAdd(42, address(1), address(2), 0, 0);
    }

    function test_TheLaneBoundsCheck_RunsBeforeAnyBroadcast() public view {
        string memory src = vm.readFile("script/ConfigureCcip.s.sol");
        uint256 check = _indexOf(src, "laneRateLimit(c.rateCapacity, c.rateRefill);");
        uint256 broadcast = _indexOf(src, "vm.startBroadcast(");
        assertTrue(check != type(uint256).max, "run() checks the lane figures");
        assertLt(check, broadcast, "the check precedes the first broadcast");
    }

    function _assertOn(RateLimiter.Config memory c, uint128 capacity, uint128 rate) private pure {
        assertTrue(c.isEnabled, "bucket enabled");
        assertEq(c.capacity, capacity, "capacity");
        assertEq(c.rate, rate, "rate");
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
