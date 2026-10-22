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
    address internal canceller = makeAddr("canceller");
    address internal target = makeAddr("target");
    uint256 internal constant DELAY = 60;

    function setUp() public {
        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](1);
        executors[0] = executor;
        address[] memory cancellers = new address[](1);
        cancellers[0] = canceller;
        timelock = new VaipakamTimelock(DELAY, proposers, executors, cancellers);
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

    // ─── #938 hardening ─────────────────────────────────────────────────

    /// @dev Runs `updateDelay(newDelay)` the only way OZ allows — as an
    ///      operation the timelock schedules on itself.
    function _queueUpdateDelay(uint256 newDelay, bytes32 salt) internal returns (bytes memory data) {
        data = abi.encodeCall(timelock.updateDelay, (newDelay));
        vm.prank(proposer);
        timelock.schedule(address(timelock), 0, data, bytes32(0), salt, DELAY);
        vm.warp(block.timestamp + DELAY + 1);
    }

    function testFloor_isDeployDelay() public view {
        assertEq(timelock.MIN_DELAY_FLOOR(), DELAY);
    }

    /// One queued operation must not be able to turn the timelock into a
    /// pass-through (#938 item 2).
    function testUpdateDelay_belowFloorRefused() public {
        bytes memory data = _queueUpdateDelay(0, bytes32("zero"));
        vm.prank(executor);
        vm.expectRevert(); // DelayBelowFloor, bubbled through execute
        timelock.execute(address(timelock), 0, data, bytes32(0), bytes32("zero"));
        assertEq(timelock.getMinDelay(), DELAY);
    }

    function testUpdateDelay_directCallBelowFloorRefused() public {
        vm.prank(address(timelock));
        vm.expectRevert(
            abi.encodeWithSelector(VaipakamTimelock.DelayBelowFloor.selector, DELAY - 1, DELAY)
        );
        timelock.updateDelay(DELAY - 1);
    }

    function testUpdateDelay_raiseThenLowerToFloorAllowed() public {
        bytes memory up = _queueUpdateDelay(DELAY * 2, bytes32("up"));
        vm.prank(executor);
        timelock.execute(address(timelock), 0, up, bytes32(0), bytes32("up"));
        assertEq(timelock.getMinDelay(), DELAY * 2);

        bytes memory down = abi.encodeCall(timelock.updateDelay, (DELAY));
        vm.prank(proposer);
        timelock.schedule(address(timelock), 0, down, bytes32(0), bytes32("down"), DELAY * 2);
        vm.warp(block.timestamp + DELAY * 2 + 1);
        vm.prank(executor);
        timelock.execute(address(timelock), 0, down, bytes32(0), bytes32("down"));
        assertEq(timelock.getMinDelay(), DELAY);
    }

    function testUpdateDelay_stillOnlySelf() public {
        vm.prank(proposer);
        vm.expectRevert();
        timelock.updateDelay(DELAY * 2);
    }

    /// The independent canceller can veto but cannot propose (#938 item 3).
    function testIndependentCanceller_canCancelNotPropose() public {
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), canceller));
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), canceller));

        bytes32 id = _schedule(31);
        vm.prank(canceller);
        timelock.cancel(id);
        assertEq(timelock.getPendingProposalsCount(), 0);

        vm.prank(canceller);
        vm.expectRevert();
        timelock.schedule(target, 0, "", bytes32(0), bytes32(uint256(32)), DELAY);
    }

    function testSelfAdministered_noExternalAdmin() public view {
        bytes32 adminRole = timelock.DEFAULT_ADMIN_ROLE();
        assertTrue(timelock.hasRole(adminRole, address(timelock)));
        assertFalse(timelock.hasRole(adminRole, proposer));
        assertFalse(timelock.hasRole(adminRole, canceller));
        assertFalse(timelock.hasRole(adminRole, address(this)));
    }

    function testZeroCanceller_refused() public {
        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](1);
        executors[0] = executor;
        address[] memory cancellers = new address[](1);
        vm.expectRevert(VaipakamTimelock.ZeroCanceller.selector);
        new VaipakamTimelock(DELAY, proposers, executors, cancellers);
    }

    // ─── Canceller removal is not vetoable by a canceller ────────────────

    function _scheduleCancellerRemoval(address who, bytes32 salt) internal returns (bytes memory data, bytes32 id) {
        data = abi.encodeCall(timelock.revokeRole, (timelock.CANCELLER_ROLE(), who));
        vm.prank(proposer);
        timelock.schedule(address(timelock), 0, data, bytes32(0), salt, DELAY);
        id = timelock.hashOperation(address(timelock), 0, data, bytes32(0), salt);
    }

    /// A captured independent canceller cannot cancel its own removal, so it
    /// cannot freeze the timelock; once the removal runs, it has no veto left.
    function testCancellerCannotCancelItsOwnRemoval() public {
        (bytes memory data, bytes32 id) = _scheduleCancellerRemoval(canceller, bytes32(uint256(41)));
        assertTrue(timelock.isCancellerRemoval(id));

        vm.prank(canceller);
        vm.expectRevert(abi.encodeWithSelector(VaipakamTimelock.CancellerRemovalNotCancellable.selector, id));
        timelock.cancel(id);

        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(executor);
        timelock.execute(address(timelock), 0, data, bytes32(0), bytes32(uint256(41)));
        assertFalse(timelock.hasRole(timelock.CANCELLER_ROLE(), canceller));
        assertFalse(timelock.isCancellerRemoval(id));
        assertEq(timelock.getPendingProposalsCount(), 0);
    }

    /// A proposer can still cancel a canceller removal it queued by mistake.
    function testProposerCanCancelCancellerRemoval() public {
        (, bytes32 id) = _scheduleCancellerRemoval(canceller, bytes32(uint256(42)));
        _cancel(id);
        assertFalse(timelock.isOperation(id));
        assertFalse(timelock.isCancellerRemoval(id));
        assertEq(timelock.getPendingProposalsCount(), 0);
    }

    /// Every other operation stays vetoable by the canceller, including a
    /// revoke of a different role and a batch that removes a canceller.
    function testOtherOperationsStayCancellable() public {
        bytes memory other = abi.encodeCall(timelock.revokeRole, (timelock.PROPOSER_ROLE(), proposer));
        vm.prank(proposer);
        timelock.schedule(address(timelock), 0, other, bytes32(0), bytes32(uint256(43)), DELAY);
        bytes32 otherId = timelock.hashOperation(address(timelock), 0, other, bytes32(0), bytes32(uint256(43)));
        assertFalse(timelock.isCancellerRemoval(otherId));
        vm.prank(canceller);
        timelock.cancel(otherId);

        address[] memory targets = new address[](1);
        targets[0] = address(timelock);
        uint256[] memory values = new uint256[](1);
        bytes[] memory payloads = new bytes[](1);
        payloads[0] = abi.encodeCall(timelock.revokeRole, (timelock.CANCELLER_ROLE(), canceller));
        vm.prank(proposer);
        timelock.scheduleBatch(targets, values, payloads, bytes32(0), bytes32(uint256(44)), DELAY);
        bytes32 batchId = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), bytes32(uint256(44)));
        assertFalse(timelock.isCancellerRemoval(batchId));
        vm.prank(canceller);
        timelock.cancel(batchId);
        assertEq(timelock.getPendingProposalsCount(), 0);
    }

    /// Calling revokeRole on some other contract is not a canceller removal.
    function testRevokeOnOtherTargetIsNotMarked() public {
        bytes memory data = abi.encodeCall(timelock.revokeRole, (timelock.CANCELLER_ROLE(), canceller));
        vm.prank(proposer);
        timelock.schedule(target, 0, data, bytes32(0), bytes32(uint256(45)), DELAY);
        bytes32 id = timelock.hashOperation(target, 0, data, bytes32(0), bytes32(uint256(45)));
        assertFalse(timelock.isCancellerRemoval(id));
        vm.prank(canceller);
        timelock.cancel(id);
    }
}
