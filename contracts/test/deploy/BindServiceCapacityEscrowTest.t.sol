// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {DeployDiamond} from "../../script/DeployDiamond.s.sol";
import {BindServiceCapacityEscrow} from "../../script/BindServiceCapacityEscrow.s.sol";
import {ServiceCapacityFacet} from "../../src/facets/ServiceCapacityFacet.sol";

/// @notice #2583 — the bind-and-record script binds an unbound escrow once, and on
///         a bound chain sends nothing and reports the bound holder.
contract BindServiceCapacityEscrowTest is Test {
    uint256 internal constant DEPLOYER_KEY = 1;
    address internal diamond;

    function setUp() public {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("DEPLOY_SKIP_ARTIFACTS", "true");
        DeployDiamond deployScript = new DeployDiamond();
        deployScript.runWith(vm.addr(DEPLOYER_KEY), address(0xBEEF), DEPLOYER_KEY);
        diamond = deployScript.diamond();
    }

    function _escrow() internal view returns (address e) {
        (e,,) = ServiceCapacityFacet(diamond).getServiceCapacityEscrow();
    }

    function test_BindsOnce_ThenRecordsTheBoundHolderWithoutSending() public {
        assertEq(_escrow(), address(0), "fixture-live: a fresh deploy leaves the escrow unbound");
        BindServiceCapacityEscrow script = new BindServiceCapacityEscrow();
        address bound = script.runWith(diamond, DEPLOYER_KEY);
        assertTrue(bound != address(0), "the escrow was bound");
        assertEq(_escrow(), bound, "the script reports the address the Diamond reports");
        assertGt(bound.code.length, 0, "the bound holder is a deployed contract");

        // Bound: no key needed, nothing sent, the same holder reported.
        vm.recordLogs();
        address again = script.runWith(diamond, 0);
        assertEq(again, bound, "a second run reports the same holder");
        assertEq(vm.getRecordedLogs().length, 0, "a second run sends nothing");
    }

    function test_UnboundWithoutAKey_Refuses() public {
        BindServiceCapacityEscrow script = new BindServiceCapacityEscrow();
        vm.expectRevert(bytes("BindServiceCapacityEscrow: a bind is due and no admin key was given"));
        script.runWith(diamond, 0);
    }
}
