// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AdminControl} from "../../script/lib/AdminControl.sol";

/// @dev A bare two-step-owned contract.
contract AdminControlTwoStep is Ownable2Step {
    constructor(address owner_) Ownable(owner_) {}
}

/// @dev Owned in one step: it has no `pendingOwner()` to read.
contract AdminControlOneStep is Ownable {
    constructor(address owner_) Ownable(owner_) {}
}

/// @dev Exposes the library to `expect`-free calls from the test.
contract AdminControlHarness {
    function aloneControls(address target, address admin) external view returns (bool) {
        return AdminControl.aloneControls(target, admin);
    }
}

/**
 * @title  AdminControlTest
 * @notice #2443 — the reuse rule every sanctions deploy/configure script
 *         applies to a recorded contract: the admin owns it and no transfer
 *         is pending, and any read that fails is a no.
 */
contract AdminControlTest is Test {
    address internal admin = makeAddr("admin");
    address internal other = makeAddr("other");
    AdminControlHarness internal h;

    function setUp() public {
        h = new AdminControlHarness();
    }

    function test_TheAdminsOwnContractWithNothingPending() public {
        AdminControlTwoStep c = new AdminControlTwoStep(admin);
        assertTrue(h.aloneControls(address(c), admin));
        assertFalse(h.aloneControls(address(c), other), "never for an account that does not own it");
    }

    function test_NotWhileATransferIsPendingNorAfterIt() public {
        AdminControlTwoStep c = new AdminControlTwoStep(admin);
        vm.prank(admin);
        c.transferOwnership(other);
        assertFalse(h.aloneControls(address(c), admin), "the pending owner can accept at any time");

        vm.prank(admin);
        c.transferOwnership(address(0));
        assertTrue(h.aloneControls(address(c), admin), "a cancelled transfer restores it");

        vm.prank(admin);
        c.transferOwnership(other);
        vm.prank(other);
        c.acceptOwnership();
        assertFalse(h.aloneControls(address(c), admin));
    }

    function test_AnythingThatCannotAnswerIsANo() public {
        assertFalse(h.aloneControls(makeAddr("no code"), admin), "no contract there");
        assertFalse(h.aloneControls(address(h), admin), "no owner()");
        AdminControlOneStep one = new AdminControlOneStep(admin);
        assertFalse(h.aloneControls(address(one), admin), "no pendingOwner() to rule a transfer out");
    }
}
