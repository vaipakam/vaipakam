// test/VaipakamTimelockTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamTimelock} from "../src/governance/VaipakamTimelock.sol";

/**
 * @notice Tests the on-chain pending-proposal index that
 *         {VaipakamTimelock} adds on top of OZ TimelockController.
 *         AnalyticalGettersDesign §3.3.
 */
contract VaipakamTimelockTest is Test {
    VaipakamTimelock internal timelock;
    address internal proposer = makeAddr("proposer");
    address internal executor = makeAddr("executor");
    address internal admin = makeAddr("admin");
    address internal target = makeAddr("target");
    uint256 internal constant DELAY = 60;

    function setUp() public {
        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](1);
        executors[0] = executor;
        timelock = new VaipakamTimelock(DELAY, proposers, executors, admin);
    }

    function _schedule(uint256 salt) internal returns (bytes32 id) {
        bytes memory data = abi.encodeWithSignature("foo()");
        vm.prank(proposer);
        timelock.schedule(target, 0, data, bytes32(0), bytes32(salt), DELAY);
        id = timelock.hashOperation(target, 0, data, bytes32(0), bytes32(salt));
    }

    function _execute(uint256 salt) internal {
        bytes memory data = abi.encodeWithSignature("foo()");
        vm.warp(block.timestamp + DELAY + 1);
        // Mock the target to make execute succeed.
        vm.mockCall(target, data, "");
        vm.prank(executor);
        timelock.execute(target, 0, data, bytes32(0), bytes32(salt));
    }

    function _cancel(bytes32 id) internal {
        vm.prank(proposer);
        timelock.cancel(id);
    }

    function testEmpty_returnsZero() public view {
        assertEq(timelock.getPendingProposalsCount(), 0);
        VaipakamTimelock.PendingProposal[] memory page =
            timelock.getPendingProposals(0, 10);
        assertEq(page.length, 0);
    }

    function testSchedule_appearsInPending() public {
        bytes32 id = _schedule(1);
        assertEq(timelock.getPendingProposalsCount(), 1);
        VaipakamTimelock.PendingProposal[] memory page =
            timelock.getPendingProposals(0, 10);
        assertEq(page.length, 1);
        assertEq(page[0].id, id);
        assertGt(page[0].eta, block.timestamp);
        assertFalse(page[0].ready); // delay hasn't elapsed
    }

    function testReady_flipsTrueAfterDelay() public {
        _schedule(2);
        vm.warp(block.timestamp + DELAY + 1);
        VaipakamTimelock.PendingProposal[] memory page =
            timelock.getPendingProposals(0, 10);
        assertTrue(page[0].ready);
    }

    function testCancel_removesFromPending() public {
        bytes32 id = _schedule(3);
        _cancel(id);
        assertEq(timelock.getPendingProposalsCount(), 0);
    }

    function testExecute_removesFromPending() public {
        _schedule(4);
        _execute(4);
        assertEq(timelock.getPendingProposalsCount(), 0);
    }

    function testThreeProposals_swapPopOrderIsConsistent() public {
        bytes32 a = _schedule(10);
        bytes32 b = _schedule(11);
        bytes32 c = _schedule(12);
        // Cancel the middle one — `b` swaps with the tail (`c`); the
        // resulting order is [a, c].
        _cancel(b);
        VaipakamTimelock.PendingProposal[] memory page =
            timelock.getPendingProposals(0, 10);
        assertEq(page.length, 2);
        assertEq(page[0].id, a);
        assertEq(page[1].id, c);
    }

    function testPagination_offsetAndLimit() public {
        _schedule(20);
        _schedule(21);
        _schedule(22);

        VaipakamTimelock.PendingProposal[] memory page1 =
            timelock.getPendingProposals(0, 2);
        VaipakamTimelock.PendingProposal[] memory page2 =
            timelock.getPendingProposals(2, 2);
        assertEq(page1.length, 2);
        assertEq(page2.length, 1);
    }

    function testLimit_revertsWhenTooLarge() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamTimelock.LimitTooLarge.selector, uint256(101), uint256(100)
            )
        );
        timelock.getPendingProposals(0, 101);
    }
}
