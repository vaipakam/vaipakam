// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ProtocolRegistry} from "../src/governance/ProtocolRegistry.sol";
import {RegistryKeys} from "../src/governance/RegistryKeys.sol";
import {IProtocolRegistryReader} from "../src/interfaces/IProtocolRegistryReader.sol";

/**
 * @title  ProtocolRegistryTest
 * @notice #3272 — the delayed registry the Diamond and the vaults share:
 *         pointers, membership sets, the delay and the roles; and #3540 —
 *         the price-guard pointer waits at least the guard's own minimum.
 */
contract ProtocolRegistryTest is Test {
    ProtocolRegistry internal reg;

    address internal constant OWNER = address(0xA11CE);
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant STRANGER = address(0xBAD);
    address internal constant GUARD_V1 = address(0x1001);
    address internal constant GUARD_V2 = address(0x1002);
    address internal constant ADAPTER = address(0x2001);

    /// @dev A pointer with no minimum of its own, so it waits the registry
    ///      delay. The price guard's own minimum is tested on its own below.
    bytes32 internal constant KEY = RegistryKeys.TREASURY;
    bytes32 internal constant SET = keccak256("vaipakam.registry.test.adapters");

    uint256 internal constant DELAY = 3 days;

    function setUp() public {
        vm.warp(1_000_000);
        bytes32[] memory keys = new bytes32[](1);
        address[] memory values = new address[](1);
        keys[0] = KEY;
        values[0] = GUARD_V1;
        reg = new ProtocolRegistry(OWNER, GUARDIAN, DELAY, keys, values, new bytes32[](0), new address[](0));
    }

    // ── Construction ──────────────────────────────────────────────────

    function test_Constructor_SetsPointersAtOnceAndChecksInputs() public {
        assertEq(reg.pointer(KEY), GUARD_V1);
        assertEq(reg.requirePointer(KEY), GUARD_V1);
        assertEq(reg.owner(), OWNER);
        assertEq(reg.guardian(), GUARDIAN);
        assertEq(reg.delay(), DELAY);

        bytes32[] memory keys = new bytes32[](1);
        address[] memory values = new address[](0);
        vm.expectRevert(ProtocolRegistry.LengthMismatch.selector);
        new ProtocolRegistry(OWNER, GUARDIAN, DELAY, keys, values, new bytes32[](0), new address[](0));

        values = new address[](1);
        vm.expectRevert(ProtocolRegistry.ZeroAddress.selector);
        new ProtocolRegistry(OWNER, GUARDIAN, DELAY, keys, values, new bytes32[](0), new address[](0));

        vm.expectRevert(
            abi.encodeWithSelector(ProtocolRegistry.DelayOutOfRange.selector, 1 days, 3 days, 30 days)
        );
        new ProtocolRegistry(OWNER, GUARDIAN, 1 days, new bytes32[](0), new address[](0), new bytes32[](0), new address[](0));

        vm.expectRevert(ProtocolRegistry.ZeroAddress.selector);
        new ProtocolRegistry(OWNER, address(0), DELAY, new bytes32[](0), new address[](0), new bytes32[](0), new address[](0));
    }

    function test_Constructor_SeedsSetMembersAtOnceAndChecksInputs() public {
        bytes32[] memory sets = new bytes32[](2);
        address[] memory mems = new address[](2);
        sets[0] = SET;
        sets[1] = SET;
        mems[0] = ADAPTER;
        mems[1] = GUARD_V2;
        vm.expectEmit(true, true, false, false);
        emit ProtocolRegistry.MemberAdded(SET, ADAPTER);
        ProtocolRegistry seeded =
            new ProtocolRegistry(OWNER, GUARDIAN, DELAY, new bytes32[](0), new address[](0), sets, mems);
        assertEq(seeded.memberCount(SET), 2);
        assertTrue(seeded.isMember(SET, ADAPTER));
        assertTrue(seeded.isMember(SET, GUARD_V2));

        mems[1] = ADAPTER;
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistry.AlreadyMember.selector, SET, ADAPTER));
        new ProtocolRegistry(OWNER, GUARDIAN, DELAY, new bytes32[](0), new address[](0), sets, mems);

        mems[1] = address(0);
        vm.expectRevert(ProtocolRegistry.ZeroAddress.selector);
        new ProtocolRegistry(OWNER, GUARDIAN, DELAY, new bytes32[](0), new address[](0), sets, mems);

        vm.expectRevert(ProtocolRegistry.LengthMismatch.selector);
        new ProtocolRegistry(OWNER, GUARDIAN, DELAY, new bytes32[](0), new address[](0), sets, new address[](1));
    }

    function test_RequirePointer_RefusesAnUnsetKey() public {
        bytes32 unset = keccak256("unset");
        assertEq(reg.pointer(unset), address(0));
        vm.expectRevert(abi.encodeWithSelector(IProtocolRegistryReader.PointerUnset.selector, unset));
        reg.requirePointer(unset);
    }

    // ── Pointers ──────────────────────────────────────────────────────

    function test_Pointer_WaitsTheDelayThenAnyoneExecutes() public {
        vm.prank(OWNER);
        reg.proposePointer(KEY, GUARD_V2);
        (address next, uint256 at) = reg.pendingPointer(KEY);
        assertEq(next, GUARD_V2);
        assertEq(at, block.timestamp + DELAY);

        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistry.TooEarly.selector, at));
        reg.executePointer(KEY);
        assertEq(reg.pointer(KEY), GUARD_V1, "unchanged before the delay");

        vm.warp(at);
        vm.prank(STRANGER);
        reg.executePointer(KEY);
        assertEq(reg.pointer(KEY), GUARD_V2);
        (, at) = reg.pendingPointer(KEY);
        assertEq(at, 0, "pending cleared");
    }

    function test_Pointer_OnlyOwnerProposes_NoZero_NoSame_OnePending() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, STRANGER));
        reg.proposePointer(KEY, GUARD_V2);

        vm.prank(GUARDIAN);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, GUARDIAN));
        reg.proposePointer(KEY, GUARD_V2);

        vm.startPrank(OWNER);
        vm.expectRevert(ProtocolRegistry.ZeroAddress.selector);
        reg.proposePointer(KEY, address(0));
        vm.expectRevert(ProtocolRegistry.NoChange.selector);
        reg.proposePointer(KEY, GUARD_V1);
        reg.proposePointer(KEY, GUARD_V2);
        vm.expectRevert(ProtocolRegistry.ChangePending.selector);
        reg.proposePointer(KEY, address(0x1003));
        vm.stopPrank();
    }

    function test_Pointer_GuardianOrOwnerCancels_StrangerCannot() public {
        vm.prank(OWNER);
        reg.proposePointer(KEY, GUARD_V2);

        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistry.NotOwnerOrGuardian.selector, STRANGER));
        reg.cancelPointer(KEY);

        vm.prank(GUARDIAN);
        reg.cancelPointer(KEY);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(ProtocolRegistry.NothingPending.selector);
        reg.executePointer(KEY);
        assertEq(reg.pointer(KEY), GUARD_V1);

        vm.prank(OWNER);
        reg.proposePointer(KEY, GUARD_V2);
        vm.prank(OWNER);
        reg.cancelPointer(KEY);
        vm.expectRevert(ProtocolRegistry.NothingPending.selector);
        vm.prank(OWNER);
        reg.cancelPointer(KEY);
    }

    // ── Sets ──────────────────────────────────────────────────────────

    function test_Set_AddWaitsTheDelay_RemoveIsInstant() public {
        vm.prank(OWNER);
        reg.proposeAdd(SET, ADAPTER);
        uint256 at = reg.pendingAdd(SET, ADAPTER);
        assertEq(at, block.timestamp + DELAY);
        assertFalse(reg.isMember(SET, ADAPTER));

        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistry.TooEarly.selector, at));
        reg.executeAdd(SET, ADAPTER);

        vm.warp(at);
        vm.prank(STRANGER);
        reg.executeAdd(SET, ADAPTER);
        assertTrue(reg.isMember(SET, ADAPTER));
        assertEq(reg.memberCount(SET), 1);
        assertEq(reg.members(SET)[0], ADAPTER);

        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistry.AlreadyMember.selector, SET, ADAPTER));
        reg.proposeAdd(SET, ADAPTER);

        vm.prank(GUARDIAN);
        vm.expectEmit(true, true, true, true, address(reg));
        emit ProtocolRegistry.MemberRemoved(SET, ADAPTER, GUARDIAN);
        reg.remove(SET, ADAPTER);
        assertFalse(reg.isMember(SET, ADAPTER));
        assertEq(reg.memberCount(SET), 0);

        vm.prank(GUARDIAN);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistry.NotMember.selector, SET, ADAPTER));
        reg.remove(SET, ADAPTER);
    }

    function test_Set_RemoveCancelsAPendingAdd() public {
        vm.prank(OWNER);
        reg.proposeAdd(SET, ADAPTER);

        vm.prank(GUARDIAN);
        vm.expectEmit(true, true, true, true, address(reg));
        emit ProtocolRegistry.MemberAddCancelled(SET, ADAPTER, GUARDIAN);
        reg.remove(SET, ADAPTER);
        assertEq(reg.pendingAdd(SET, ADAPTER), 0);

        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(ProtocolRegistry.NothingPending.selector);
        reg.executeAdd(SET, ADAPTER);
    }

    function test_Set_RolesAndOnePendingPerMember() public {
        vm.prank(GUARDIAN);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, GUARDIAN));
        reg.proposeAdd(SET, ADAPTER);

        vm.startPrank(OWNER);
        vm.expectRevert(ProtocolRegistry.ZeroAddress.selector);
        reg.proposeAdd(SET, address(0));
        reg.proposeAdd(SET, ADAPTER);
        vm.expectRevert(ProtocolRegistry.ChangePending.selector);
        reg.proposeAdd(SET, ADAPTER);
        vm.stopPrank();

        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistry.NotOwnerOrGuardian.selector, STRANGER));
        reg.cancelAdd(SET, ADAPTER);
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistry.NotOwnerOrGuardian.selector, STRANGER));
        reg.remove(SET, ADAPTER);

        vm.prank(GUARDIAN);
        reg.cancelAdd(SET, ADAPTER);
        assertEq(reg.pendingAdd(SET, ADAPTER), 0);
    }

    // ── The delay ─────────────────────────────────────────────────────

    function test_Delay_RaiseIsInstant_LowerWaitsTheCurrentDelay() public {
        vm.prank(OWNER);
        reg.proposeDelay(7 days);
        assertEq(reg.delay(), 7 days, "a raise applies at once");

        vm.prank(OWNER);
        reg.proposeDelay(4 days);
        (uint256 newDelay, uint256 at) = reg.pendingDelay();
        assertEq(newDelay, 4 days);
        assertEq(at, block.timestamp + 7 days, "a lowering waits the current delay");
        assertEq(reg.delay(), 7 days);

        vm.prank(OWNER);
        vm.expectRevert(ProtocolRegistry.ChangePending.selector);
        reg.proposeDelay(5 days);

        vm.warp(at);
        reg.executeDelay();
        assertEq(reg.delay(), 4 days);
    }

    function test_Delay_RaiseWithdrawsAPendingLowering() public {
        vm.prank(OWNER);
        reg.proposeDelay(10 days);
        vm.prank(OWNER);
        reg.proposeDelay(5 days);
        vm.prank(OWNER);
        reg.proposeDelay(12 days);
        (, uint256 at) = reg.pendingDelay();
        assertEq(at, 0, "the older lowering cannot undo the later raise");
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(ProtocolRegistry.NothingPending.selector);
        reg.executeDelay();
        assertEq(reg.delay(), 12 days);
    }

    function test_Delay_BoundsAndRoles() public {
        vm.startPrank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistry.DelayOutOfRange.selector, 2 days, 3 days, 30 days));
        reg.proposeDelay(2 days);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistry.DelayOutOfRange.selector, 31 days, 3 days, 30 days));
        reg.proposeDelay(31 days);
        vm.expectRevert(ProtocolRegistry.NoChange.selector);
        reg.proposeDelay(DELAY);
        vm.stopPrank();

        vm.prank(GUARDIAN);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, GUARDIAN));
        reg.proposeDelay(5 days);

        vm.prank(OWNER);
        reg.proposeDelay(10 days);
        vm.prank(OWNER);
        reg.proposeDelay(5 days);
        vm.prank(GUARDIAN);
        reg.cancelDelay();
        vm.warp(block.timestamp + 10 days);
        vm.expectRevert(ProtocolRegistry.NothingPending.selector);
        reg.executeDelay();
        assertEq(reg.delay(), 10 days);
    }

    /// @notice A pending change keeps the time it was proposed with, whichever
    ///         way the delay later moves.
    function test_Delay_ChangeNeverMovesAPendingExecutionTime() public {
        vm.startPrank(OWNER);
        reg.proposePointer(KEY, GUARD_V2);
        reg.proposeAdd(SET, ADAPTER);
        vm.stopPrank();
        uint256 pointerAt = block.timestamp + DELAY;

        // A raise does not push the pending changes back...
        vm.prank(OWNER);
        reg.proposeDelay(20 days);
        (, uint256 at) = reg.pendingPointer(KEY);
        assertEq(at, pointerAt);
        assertEq(reg.pendingAdd(SET, ADAPTER), pointerAt);
        vm.warp(pointerAt);
        reg.executePointer(KEY);
        reg.executeAdd(SET, ADAPTER);
        assertEq(reg.pointer(KEY), GUARD_V2);

        // ...and a lowering, once applied, does not pull a pending one forward.
        vm.prank(OWNER);
        reg.proposeDelay(3 days);
        (, uint256 lowerAt) = reg.pendingDelay();
        vm.warp(block.timestamp + 1 days);
        vm.prank(OWNER);
        reg.proposePointer(KEY, GUARD_V1);
        (, uint256 longAt) = reg.pendingPointer(KEY);
        assertEq(longAt, block.timestamp + 20 days);
        vm.warp(lowerAt);
        reg.executeDelay();
        assertEq(reg.delay(), 3 days);
        (, at) = reg.pendingPointer(KEY);
        assertEq(at, longAt, "the eta is the one it was proposed with");
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistry.TooEarly.selector, longAt));
        reg.executePointer(KEY);
    }

    // ── Roles ─────────────────────────────────────────────────────────

    // ── Per-key minimum (#3540) ───────────────────────────────────────

    /// @dev `PriceGuardConfigTest` keeps the 7 days equal to the guard's own floor.
    function test_MinDelayFor_PriceGuardIsSevenDays_OthersTheRegistryFloor() public view {
        assertEq(reg.PRICE_GUARD_MIN_DELAY(), 7 days);
        assertEq(reg.minDelayFor(RegistryKeys.PRICE_GUARD), reg.PRICE_GUARD_MIN_DELAY());
        assertEq(reg.minDelayFor(RegistryKeys.TREASURY), reg.MIN_DELAY());
        assertEq(reg.minDelayFor(RegistryKeys.BACKSTOP), reg.MIN_DELAY());
        assertEq(reg.minDelayFor(RegistryKeys.SWAP_ADAPTERS), reg.MIN_DELAY());
        assertEq(reg.minDelayFor(RegistryKeys.CONDUITS), reg.MIN_DELAY());
        assertEq(reg.waitFor(RegistryKeys.PRICE_GUARD), 7 days);
        assertEq(reg.waitFor(RegistryKeys.TREASURY), DELAY);
    }

    function test_PriceGuardPointer_CannotExecuteBeforeSevenDays() public {
        bytes32 pg = RegistryKeys.PRICE_GUARD;
        address v1 = address(0x1101);
        address v2 = address(0x1102);
        bytes32[] memory keys = new bytes32[](1);
        address[] memory values = new address[](1);
        keys[0] = pg;
        values[0] = v1;
        ProtocolRegistry r =
            new ProtocolRegistry(OWNER, GUARDIAN, DELAY, keys, values, new bytes32[](0), new address[](0));

        vm.prank(OWNER);
        r.proposePointer(pg, v2);
        (, uint256 at) = r.pendingPointer(pg);
        assertEq(at, block.timestamp + 7 days, "the guard's minimum, not the 3-day delay");

        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistry.TooEarly.selector, at));
        r.executePointer(pg);
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(ProtocolRegistry.TooEarly.selector, at));
        r.executePointer(pg);
        assertEq(r.pointer(pg), v1, "unchanged before seven days");

        vm.warp(at);
        r.executePointer(pg);
        assertEq(r.pointer(pg), v2);
    }

    function test_PriceGuardPointer_WaitsTheDelayWhenItIsLonger() public {
        bytes32 pg = RegistryKeys.PRICE_GUARD;
        bytes32[] memory keys = new bytes32[](1);
        address[] memory values = new address[](1);
        keys[0] = pg;
        values[0] = address(0x1101);
        ProtocolRegistry r =
            new ProtocolRegistry(OWNER, GUARDIAN, 10 days, keys, values, new bytes32[](0), new address[](0));
        vm.prank(OWNER);
        r.proposePointer(pg, address(0x1102));
        (, uint256 at) = r.pendingPointer(pg);
        assertEq(at, block.timestamp + 10 days);
    }

    function test_Roles_GuardianSetByOwner_RenounceDisabled() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, STRANGER));
        reg.setGuardian(STRANGER);

        vm.prank(OWNER);
        vm.expectRevert(ProtocolRegistry.ZeroAddress.selector);
        reg.setGuardian(address(0));

        vm.prank(OWNER);
        reg.setGuardian(address(0x5AFE));
        assertEq(reg.guardian(), address(0x5AFE));

        vm.prank(OWNER);
        vm.expectRevert(ProtocolRegistry.RenounceDisabled.selector);
        reg.renounceOwnership();
        assertEq(reg.owner(), OWNER);

        vm.prank(OWNER);
        reg.transferOwnership(address(0x7117));
        assertEq(reg.owner(), OWNER, "two-step: not moved until accepted");
        vm.prank(address(0x7117));
        reg.acceptOwnership();
        assertEq(reg.owner(), address(0x7117));
    }
}
