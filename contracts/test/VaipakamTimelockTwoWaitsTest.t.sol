// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {VaipakamTimelock} from "../src/governance/VaipakamTimelock.sol";

/// @dev A stand-in for anything the timelock governs.
contract TwoWaitsTarget {
    uint256 public calls;

    function unpause() external {
        ++calls;
    }

    function unpauseAsset(address) external {
        ++calls;
    }

    function unpauseIfPauseEpoch(uint64) external {
        ++calls;
    }

    function setFee(uint256) external {
        ++calls;
    }
}

/**
 * @notice The timelock's two waits (owner decision 2026-11-19, option A):
 *         every operation waits the standard delay, except one whose every
 *         call is on the fixed restart list, or one whose exact id the urgent
 *         approver (the pause multisig) approved before it was scheduled.
 */
contract VaipakamTimelockTwoWaitsTest is Test {
    VaipakamTimelock internal tl;
    TwoWaitsTarget internal target;
    address internal proposer = makeAddr("governanceSafe");
    address internal pauser = makeAddr("pauserSafe");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant RESTART = 48 hours;
    uint256 internal constant STANDARD = 7 days;

    function setUp() public {
        target = new TwoWaitsTarget();
        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](1); // address(0): anyone executes
        address[] memory pausers = new address[](1);
        pausers[0] = pauser;
        tl = new VaipakamTimelock(RESTART, STANDARD, address(target), proposers, executors, pausers, pausers);
    }

    // ─── helpers ─────────────────────────────────────────────────────────

    function _setFee() internal pure returns (bytes memory) {
        return abi.encodeCall(TwoWaitsTarget.setFee, (1));
    }

    function _unpause() internal pure returns (bytes memory) {
        return abi.encodeCall(TwoWaitsTarget.unpause, ());
    }

    function _schedule(bytes memory data, uint256 delay) internal {
        vm.prank(proposer);
        tl.schedule(address(target), 0, data, bytes32(0), bytes32(0), delay);
    }

    function _id(bytes memory data) internal view returns (bytes32) {
        return tl.hashOperation(address(target), 0, data, bytes32(0), bytes32(0));
    }

    // ─── the waits ───────────────────────────────────────────────────────

    function testReadsReportBothWaits() public view {
        assertEq(tl.getMinDelay(), RESTART);
        assertEq(tl.standardDelay(), STANDARD);
        assertEq(tl.MIN_DELAY_FLOOR(), RESTART);
        assertEq(tl.STANDARD_DELAY_FLOOR(), STANDARD);
    }

    function testOrdinaryChangeBelowStandardIsRefused() public {
        bytes memory data = _setFee();
        bytes32 id = _id(data);
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(VaipakamTimelock.DelayBelowRequired.selector, id, RESTART, STANDARD));
        tl.schedule(address(target), 0, data, bytes32(0), bytes32(0), RESTART);
    }

    function testOrdinaryChangeAtStandardRunsAfterSevenDays() public {
        bytes memory data = _setFee();
        _schedule(data, STANDARD);
        vm.warp(block.timestamp + STANDARD - 1);
        vm.expectRevert();
        tl.execute(address(target), 0, data, bytes32(0), bytes32(0));
        vm.warp(block.timestamp + 1);
        tl.execute(address(target), 0, data, bytes32(0), bytes32(0));
        assertEq(target.calls(), 1);
    }

    function testEachRestartCallWaitsOnlyTheRestartDelay() public {
        bytes[3] memory calls = [
            _unpause(),
            abi.encodeCall(TwoWaitsTarget.unpauseAsset, (address(0xBEEF))),
            abi.encodeCall(TwoWaitsTarget.unpauseIfPauseEpoch, (uint64(3)))
        ];
        for (uint256 i; i < calls.length; ++i) {
            assertTrue(tl.isRestartCall(address(target), 0, calls[i]));
            _schedule(calls[i], RESTART);
        }
        vm.warp(block.timestamp + RESTART);
        for (uint256 i; i < calls.length; ++i) {
            tl.execute(address(target), 0, calls[i], bytes32(0), bytes32(0));
        }
        assertEq(target.calls(), 3);
    }

    function testPaddedOrValueCarryingRestartIsNotARestart() public view {
        assertFalse(tl.isRestartCall(address(target), 0, abi.encodePacked(_unpause(), uint256(0))));
        assertFalse(tl.isRestartCall(address(target), 1, _unpause()));
        assertFalse(tl.isRestartCall(address(target), 0, _setFee()));
        assertFalse(tl.isRestartCall(address(target), 0, ""));
    }

    function testBatchIsARestartOnlyWhenEveryCallIs() public {
        address[] memory targets = new address[](2);
        targets[0] = address(target);
        targets[1] = address(target);
        uint256[] memory values = new uint256[](2);
        bytes[] memory payloads = new bytes[](2);
        payloads[0] = _unpause();
        payloads[1] = _setFee();
        bytes32 id = tl.hashOperationBatch(targets, values, payloads, bytes32(0), bytes32(0));

        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(VaipakamTimelock.DelayBelowRequired.selector, id, RESTART, STANDARD));
        tl.scheduleBatch(targets, values, payloads, bytes32(0), bytes32(0), RESTART);

        payloads[1] = abi.encodeCall(TwoWaitsTarget.unpauseAsset, (address(1)));
        vm.prank(proposer);
        tl.scheduleBatch(targets, values, payloads, bytes32(0), bytes32(0), RESTART);
    }

    // ─── urgent fixes ────────────────────────────────────────────────────

    function testUrgentFixNeedsThePausersApprovalOfThatExactOperation() public {
        bytes memory data = _setFee();
        bytes32 id = _id(data);

        vm.prank(pauser);
        tl.approveUrgent(id);
        assertTrue(tl.isUrgentApproved(id));

        _schedule(data, RESTART);
        assertFalse(tl.isUrgentApproved(id), "scheduling spends the approval");
        vm.warp(block.timestamp + RESTART);
        tl.execute(address(target), 0, data, bytes32(0), bytes32(0));
        assertEq(target.calls(), 1);
    }

    function testApprovalOfOneOperationDoesNotShortenAnother() public {
        bytes32 approved = _id(_setFee());
        vm.prank(pauser);
        tl.approveUrgent(approved);

        bytes memory other = abi.encodeCall(TwoWaitsTarget.setFee, (2));
        bytes32 otherId = _id(other);
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(VaipakamTimelock.DelayBelowRequired.selector, otherId, RESTART, STANDARD));
        tl.schedule(address(target), 0, other, bytes32(0), bytes32(0), RESTART);
    }

    function testOnlyAnUrgentApproverMayApprove() public {
        bytes32 id = _id(_setFee());
        bytes32 role = tl.URGENT_APPROVER_ROLE();
        for (uint256 i; i < 2; ++i) {
            address who = i == 0 ? proposer : stranger;
            vm.prank(who);
            vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, who, role));
            tl.approveUrgent(id);
        }
    }

    function testApprovalCannotShortenAnAlreadyScheduledOperation() public {
        bytes memory data = _setFee();
        _schedule(data, STANDARD);
        bytes32 id = _id(data);
        vm.prank(pauser);
        vm.expectRevert(abi.encodeWithSelector(VaipakamTimelock.UrgentApprovalForScheduledOperation.selector, id));
        tl.approveUrgent(id);
    }

    function testWithdrawnApprovalNoLongerShortens() public {
        bytes memory data = _setFee();
        bytes32 id = _id(data);
        vm.startPrank(pauser);
        tl.approveUrgent(id);
        tl.withdrawUrgentApproval(id);
        vm.expectRevert(abi.encodeWithSelector(VaipakamTimelock.UrgentApprovalNotPending.selector, id));
        tl.withdrawUrgentApproval(id);
        vm.stopPrank();

        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(VaipakamTimelock.DelayBelowRequired.selector, id, RESTART, STANDARD));
        tl.schedule(address(target), 0, data, bytes32(0), bytes32(0), RESTART);
    }

    function testRequiredDelayView() public {
        bytes memory fee = _setFee();
        address[] memory targets = new address[](1);
        targets[0] = address(target);
        uint256[] memory values = new uint256[](1);
        bytes[] memory payloads = new bytes[](1);
        payloads[0] = fee;
        bytes32 id = tl.hashOperationBatch(targets, values, payloads, bytes32(0), bytes32(0));
        assertEq(tl.requiredDelay(id, targets, values, payloads), STANDARD);
        vm.prank(pauser);
        tl.approveUrgent(id);
        assertEq(tl.requiredDelay(id, targets, values, payloads), RESTART);
        payloads[0] = _unpause();
        bytes32 id2 = tl.hashOperationBatch(targets, values, payloads, bytes32(0), bytes32(0));
        assertEq(tl.requiredDelay(id2, targets, values, payloads), RESTART);
    }

    // ─── keeping the two parties apart ──────────────────────────────────

    function testProposerCanNeverBecomeAnUrgentApprover() public {
        bytes memory grant = abi.encodeCall(IAccessControl.grantRole, (tl.URGENT_APPROVER_ROLE(), proposer));
        vm.prank(proposer);
        tl.schedule(address(tl), 0, grant, bytes32(0), bytes32(0), STANDARD);
        vm.warp(block.timestamp + STANDARD);
        vm.expectRevert(abi.encodeWithSelector(VaipakamTimelock.ProposerCannotApproveUrgent.selector, proposer));
        tl.execute(address(tl), 0, grant, bytes32(0), bytes32(0));
    }

    function testUrgentApproverCanNeverBecomeAProposer() public {
        bytes memory grant = abi.encodeCall(IAccessControl.grantRole, (tl.PROPOSER_ROLE(), pauser));
        vm.prank(proposer);
        tl.schedule(address(tl), 0, grant, bytes32(0), bytes32(0), STANDARD);
        vm.warp(block.timestamp + STANDARD);
        vm.expectRevert(abi.encodeWithSelector(VaipakamTimelock.ProposerCannotApproveUrgent.selector, pauser));
        tl.execute(address(tl), 0, grant, bytes32(0), bytes32(0));
    }

    function testConstructorRefusesAnApproverWhoProposes() public {
        address[] memory both = new address[](1);
        both[0] = proposer;
        vm.expectRevert(abi.encodeWithSelector(VaipakamTimelock.ProposerCannotApproveUrgent.selector, proposer));
        new VaipakamTimelock(RESTART, STANDARD, address(0), both, new address[](1), new address[](0), both);
    }

    // ─── the floors ──────────────────────────────────────────────────────

    function testStandardDelayCanRiseButNeverFallBelowItsFloor() public {
        bytes memory raise = abi.encodeCall(VaipakamTimelock.updateStandardDelay, (10 days));
        vm.prank(proposer);
        tl.schedule(address(tl), 0, raise, bytes32(0), bytes32(0), STANDARD);
        vm.warp(block.timestamp + STANDARD);
        tl.execute(address(tl), 0, raise, bytes32(0), bytes32(0));
        assertEq(tl.standardDelay(), 10 days);

        bytes memory lower = abi.encodeCall(VaipakamTimelock.updateStandardDelay, (STANDARD - 1));
        vm.prank(proposer);
        tl.schedule(address(tl), 0, lower, bytes32(0), bytes32(0), 10 days);
        vm.warp(block.timestamp + 10 days);
        vm.expectRevert(abi.encodeWithSelector(VaipakamTimelock.StandardDelayOutOfRange.selector, STANDARD - 1, STANDARD));
        tl.execute(address(tl), 0, lower, bytes32(0), bytes32(0));
    }

    function testOnlyTheTimelockMayChangeTheStandardDelay() public {
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(TimelockController.TimelockUnauthorizedCaller.selector, proposer));
        tl.updateStandardDelay(10 days);
    }

    function testRestartDelayNeverRisesAboveTheStandard() public {
        bytes memory raise = abi.encodeCall(TimelockController.updateDelay, (STANDARD + 1));
        vm.prank(proposer);
        tl.schedule(address(tl), 0, raise, bytes32(0), bytes32(0), STANDARD);
        vm.warp(block.timestamp + STANDARD);
        vm.expectRevert(abi.encodeWithSelector(VaipakamTimelock.RestartDelayAboveStandard.selector, STANDARD + 1, STANDARD));
        tl.execute(address(tl), 0, raise, bytes32(0), bytes32(0));
    }

    function testConstructorRefusesAStandardBelowTheRestart() public {
        vm.expectRevert(abi.encodeWithSelector(VaipakamTimelock.StandardDelayOutOfRange.selector, RESTART - 1, RESTART));
        new VaipakamTimelock(RESTART, RESTART - 1, address(0), new address[](0), new address[](0), new address[](0), new address[](0));
    }

    // ─── the restart list is (target, selector) pairs ────────────────────

    function testRestartListIsFixedSelectorsOnTheOneTarget() public view {
        assertEq(tl.RESTART_TARGET(), address(target));
        bytes4[] memory sels = tl.restartSelectors();
        assertEq(sels.length, 3);
        assertEq(sels[0], bytes4(keccak256("unpause()")));
        assertEq(sels[1], bytes4(keccak256("unpauseAsset(address)")));
        assertEq(sels[2], bytes4(keccak256("unpauseIfPauseEpoch(uint64)")));
    }

    /// @dev The same unpause on any other contract waits the standard delay:
    ///      only the Diamond named at deploy has a 48-hour route.
    function testRestartSelectorOnAnotherTargetIsNotARestart() public {
        TwoWaitsTarget other = new TwoWaitsTarget();
        bytes memory data = _unpause();
        assertTrue(tl.isRestartCall(address(target), 0, data));
        assertFalse(tl.isRestartCall(address(other), 0, data));
        bytes32 id = tl.hashOperation(address(other), 0, data, bytes32(0), bytes32(0));
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(VaipakamTimelock.DelayBelowRequired.selector, id, RESTART, STANDARD));
        tl.schedule(address(other), 0, data, bytes32(0), bytes32(0), RESTART);
    }

    /// @dev With no restart target, nothing is a restart.
    function testNoTargetMeansAnEmptyRestartList() public {
        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        VaipakamTimelock bare =
            new VaipakamTimelock(RESTART, STANDARD, address(0), proposers, new address[](1), new address[](0), new address[](0));
        assertFalse(bare.isRestartCall(address(0), 0, _unpause()));
        assertFalse(bare.isRestartCall(address(target), 0, _unpause()));
    }

    // ─── an approval is bound to its approver and to a window ────────────

    function testApprovalRecordsItsApproverAndTime() public {
        bytes32 id = _id(_setFee());
        vm.prank(pauser);
        tl.approveUrgent(id);
        (address approver, uint64 at) = tl.urgentApproval(id);
        assertEq(approver, pauser);
        assertEq(at, uint64(block.timestamp));
    }

    /// @dev Revoking a rotated or compromised approver voids every approval
    ///      it left behind: the operation waits the standard delay again.
    function testRevokingTheApproverVoidsItsApprovals() public {
        bytes memory data = _setFee();
        bytes32 id = _id(data);
        vm.prank(pauser);
        tl.approveUrgent(id);
        bytes32 role = tl.URGENT_APPROVER_ROLE();
        vm.prank(address(tl));
        tl.revokeRole(role, pauser);
        assertFalse(tl.isUrgentApproved(id));

        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(VaipakamTimelock.DelayBelowRequired.selector, id, RESTART, STANDARD));
        tl.schedule(address(target), 0, data, bytes32(0), bytes32(0), RESTART);
    }

    /// @dev An approval lapses after the window; until then it holds.
    function testApprovalLapsesAfterItsWindow() public {
        bytes memory data = _setFee();
        bytes32 id = _id(data);
        vm.prank(pauser);
        tl.approveUrgent(id);
        uint256 window = tl.URGENT_APPROVAL_WINDOW();

        uint256 t0 = block.timestamp;
        vm.warp(t0 + window);
        assertTrue(tl.isUrgentApproved(id), "still inside the window");
        vm.warp(t0 + window + 1);
        assertFalse(tl.isUrgentApproved(id), "lapsed");

        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(VaipakamTimelock.DelayBelowRequired.selector, id, RESTART, STANDARD));
        tl.schedule(address(target), 0, data, bytes32(0), bytes32(0), RESTART);

        // Approving again opens a fresh window.
        vm.prank(pauser);
        tl.approveUrgent(id);
        _schedule(data, RESTART);
    }

    /// @dev A lapsed approval does not block an ordinary schedule, and is
    ///      cleared by it.
    function testLapsedApprovalIsClearedByAStandardSchedule() public {
        bytes memory data = _setFee();
        bytes32 id = _id(data);
        vm.prank(pauser);
        tl.approveUrgent(id);
        vm.warp(block.timestamp + tl.URGENT_APPROVAL_WINDOW() + 1);
        _schedule(data, STANDARD);
        (address approver,) = tl.urgentApproval(id);
        assertEq(approver, address(0));
    }

    // ─── the standard delay is capped ────────────────────────────────────

    function testStandardDelayCannotRiseAboveTheCap() public {
        uint256 cap = tl.MAX_STANDARD_DELAY();
        uint256 t0 = block.timestamp;
        bytes memory tooHigh = abi.encodeCall(VaipakamTimelock.updateStandardDelay, (cap + 1));
        vm.prank(proposer);
        tl.schedule(address(tl), 0, tooHigh, bytes32(0), bytes32(0), STANDARD);
        vm.warp(t0 + STANDARD);
        vm.expectRevert(abi.encodeWithSelector(VaipakamTimelock.StandardDelayAboveMax.selector, cap + 1, cap));
        tl.execute(address(tl), 0, tooHigh, bytes32(0), bytes32(0));

        bytes memory atCap = abi.encodeCall(VaipakamTimelock.updateStandardDelay, (cap));
        vm.prank(proposer);
        tl.schedule(address(tl), 0, atCap, bytes32(0), bytes32("cap"), STANDARD);
        vm.warp(t0 + 2 * STANDARD);
        tl.execute(address(tl), 0, atCap, bytes32(0), bytes32("cap"));
        assertEq(tl.standardDelay(), cap);
    }

    function testConstructorRefusesAStandardAboveTheCap() public {
        uint256 cap = 30 days;
        vm.expectRevert(abi.encodeWithSelector(VaipakamTimelock.StandardDelayAboveMax.selector, cap + 1, cap));
        new VaipakamTimelock(
            RESTART, cap + 1, address(0), new address[](0), new address[](0), new address[](0), new address[](0)
        );
    }
}
