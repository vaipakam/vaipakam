// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibPausable} from "../src/libraries/LibPausable.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";

/// @title AutoPauseCooldownTest
/// @notice #2744 — a watcher key cannot chain auto-pause windows back to back.
///         A window that freezes a live protocol may open only a cooldown
///         (default 24 hours, Timelock-tunable inside [1 hour, 7 days]) after
///         the end of the last such window. Under the manual pause a window
///         is still recorded, and neither waits for nor starts a cooldown.
contract AutoPauseCooldownTest is SetupTest {
    AdminFacet internal admin;
    address internal watcher;

    function setUp() public {
        setupHelper();
        admin = AdminFacet(address(diamond));
        watcher = makeAddr("watcher");
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.WATCHER_ROLE, watcher);
    }

    function _autoPause() internal {
        vm.prank(watcher);
        admin.autoPause("anomaly");
    }

    function test_noCooldownBeforeTheFirstWindow() public view {
        assertEq(admin.autoPauseAvailableAt(), 0, "nothing has frozen the protocol yet");
        assertEq(admin.autoPauseCooldownSeconds(), LibPausable.AUTO_PAUSE_COOLDOWN_DEFAULT);
        assertEq(LibPausable.AUTO_PAUSE_COOLDOWN_DEFAULT, 24 hours);
    }

    /// @dev The finding: the window lapses and the same key opens the next at
    ///      once. It now waits out the cooldown, counted from the window's end.
    function test_windowsCannotBeChainedBackToBack() public {
        _autoPause();
        uint256 until = admin.pausedUntil();
        uint64 availableAt = uint64(until + 24 hours);
        assertEq(admin.autoPauseAvailableAt(), availableAt);

        vm.warp(until);
        assertFalse(admin.paused(), "the window lapsed");
        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(LibPausable.AutoPauseCoolingDown.selector, availableAt));
        admin.autoPause("again");

        vm.warp(availableAt - 1);
        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(LibPausable.AutoPauseCoolingDown.selector, availableAt));
        admin.autoPause("again");
        assertFalse(admin.paused(), "a refused call pauses nothing");

        vm.warp(availableAt);
        _autoPause();
        assertTrue(admin.paused(), "allowed once the cooldown has run");
        assertEq(admin.autoPauseAvailableAt(), admin.pausedUntil() + 24 hours, "and it starts the next one");
    }

    /// @dev Bound on what a watcher key alone can do: one window per window +
    ///      cooldown. Over ten cycles at the longest window the paused share
    ///      is 2 hours in 26.
    function test_pausedShareIsBoundedOverManyCycles() public {
        // The longest window the duration setter accepts.
        ConfigFacet(address(diamond)).setAutoPauseDurationSeconds(uint32(LibVaipakam.MAX_AUTO_PAUSE_SECONDS));
        uint256 t0 = vm.getBlockTimestamp();
        uint256 before = admin.pausedSecondsAt(t0);
        for (uint256 i; i < 10; ++i) {
            _autoPause();
            vm.warp(admin.autoPauseAvailableAt());
        }
        uint256 elapsed = vm.getBlockTimestamp() - t0;
        uint256 pausedTime = admin.pausedSecondsAt(vm.getBlockTimestamp()) - before;
        assertEq(pausedTime, 10 * 2 hours);
        assertEq(elapsed, 10 * 26 hours);
    }

    /// @dev An unpause that cuts a window short (a false positive) leaves the
    ///      cooldown running from the window's scheduled end.
    function test_unpauseDoesNotResetTheCooldown() public {
        _autoPause();
        uint256 until = admin.pausedUntil();
        vm.warp(vm.getBlockTimestamp() + 5 minutes);
        admin.unpause();
        assertFalse(admin.paused());
        assertEq(admin.autoPauseAvailableAt(), until + 24 hours);
        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(LibPausable.AutoPauseCoolingDown.selector, uint64(until + 24 hours)));
        admin.autoPause("again");
    }

    /// @dev Under the manual pause a window freezes nothing more: it is still
    ///      recorded (the pause epoch moves), but it neither waits for a
    ///      cooldown nor starts one.
    function test_windowUnderTheManualPauseNeitherWaitsNorStartsACooldown() public {
        _autoPause();
        uint256 availableAt = admin.autoPauseAvailableAt();
        vm.warp(admin.pausedUntil());
        admin.pause();
        uint64 epoch = _epoch();
        _autoPause(); // inside the cooldown, but the protocol is already frozen
        assertEq(_epoch(), epoch + 1, "recorded as a transition");
        assertEq(admin.autoPauseAvailableAt(), availableAt, "no new cooldown started");
        admin.unpause();
    }

    function _epoch() internal view returns (uint64 transitions) {
        (,,, transitions) =
            LibPausable.decodePausableSlot(vm.load(address(diamond), LibPausable.PAUSABLE_STORAGE_POSITION));
    }

    function test_firstWindowUnderManualPauseLeavesNoCooldown() public {
        admin.pause();
        _autoPause();
        admin.unpause();
        assertEq(admin.autoPauseAvailableAt(), 0, "nothing froze a live protocol");
        _autoPause();
        assertTrue(admin.paused(), "the watcher may still fire on a live protocol");
    }

    /// @dev An active window is still never extended, and the call stays a
    ///      quiet no-op rather than a cooldown revert.
    function test_activeWindowIsStillANoOp() public {
        _autoPause();
        uint256 until = admin.pausedUntil();
        vm.warp(vm.getBlockTimestamp() + 1 minutes);
        _autoPause();
        assertEq(admin.pausedUntil(), until);
    }

    // ─── The setter ─────────────────────────────────────────────────────────

    function test_setter_isAdminOnly() public {
        vm.prank(watcher);
        vm.expectRevert();
        admin.setAutoPauseCooldownSeconds(2 hours);
    }

    function test_setter_enforcesBounds() public {
        uint32 low = uint32(LibPausable.MIN_AUTO_PAUSE_COOLDOWN - 1);
        uint32 high = uint32(LibPausable.MAX_AUTO_PAUSE_COOLDOWN + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibPausable.InvalidAutoPauseCooldown.selector,
                low,
                LibPausable.MIN_AUTO_PAUSE_COOLDOWN,
                LibPausable.MAX_AUTO_PAUSE_COOLDOWN
            )
        );
        admin.setAutoPauseCooldownSeconds(low);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibPausable.InvalidAutoPauseCooldown.selector,
                high,
                LibPausable.MIN_AUTO_PAUSE_COOLDOWN,
                LibPausable.MAX_AUTO_PAUSE_COOLDOWN
            )
        );
        admin.setAutoPauseCooldownSeconds(high);
        assertEq(LibPausable.MIN_AUTO_PAUSE_COOLDOWN, 1 hours);
        assertEq(LibPausable.MAX_AUTO_PAUSE_COOLDOWN, 7 days);
    }

    function test_setter_emitsAndZeroRestoresTheDefault() public {
        vm.expectEmit(address(diamond));
        emit LibPausable.AutoPauseCooldownSet(2 hours);
        admin.setAutoPauseCooldownSeconds(2 hours);
        assertEq(admin.autoPauseCooldownSeconds(), 2 hours);
        admin.setAutoPauseCooldownSeconds(0);
        assertEq(admin.autoPauseCooldownSeconds(), 24 hours);
    }

    /// @dev Governance shortening the cooldown applies to the one already
    ///      running: availability is read with the cooldown as set now.
    function test_setter_appliesToTheRunningCooldown() public {
        _autoPause();
        uint256 until = admin.pausedUntil();
        admin.setAutoPauseCooldownSeconds(1 hours);
        assertEq(admin.autoPauseAvailableAt(), until + 1 hours);
        vm.warp(until + 1 hours);
        _autoPause();
        assertTrue(admin.paused());
    }
}
