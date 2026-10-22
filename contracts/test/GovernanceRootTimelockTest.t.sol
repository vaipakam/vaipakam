// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {OwnershipFacet} from "../src/facets/OwnershipFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {VaipakamTimelock} from "../src/governance/VaipakamTimelock.sol";
import {HelperTest} from "./HelperTest.sol";

/**
 * @title GovernanceRootTimelockTest
 * @notice #934 (owner decision D1, 2026-10-16). After handover the role
 *         root (`DEFAULT_ADMIN_ROLE`) and ERC-173 ownership sit on the
 *         Timelock, and the governance Safe holds ONLY
 *         `EMERGENCY_REVOKER_ROLE`. This suite drives the handover
 *         `Handover.s.sol` performs against a real {VaipakamTimelock} and
 *         pins the property the audit found missing: the Safe cannot move
 *         any authority in one transaction — every grant, every
 *         `transferAdmin`, every ownership move waits out the delay — while
 *         it can still strip a compromised hot key immediately.
 */
contract GovernanceRootTimelockTest is Test {
    uint256 internal constant DELAY = 2 days;

    VaipakamDiamond internal diamond;
    VaipakamTimelock internal timelock;
    AccessControlFacet internal ac;

    address internal admin; // the handover signer (ADMIN_ADDRESS)
    address internal governanceSafe = makeAddr("governance-safe");
    address internal pauserSafe = makeAddr("pauser-safe");
    address internal keeperBot = makeAddr("keeper-bot");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        admin = address(this);
        DiamondCutFacet cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(admin, address(cutFacet));
        HelperTest helper = new HelperTest();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(new AccessControlFacet()),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getAccessControlFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(new OwnershipFacet()),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getOwnershipFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        ac = AccessControlFacet(address(diamond));
        ac.initializeAccessControl();

        // The production timelock shape: the Safe proposes, anyone executes,
        // the Pauser Safe is the independent canceller (#938).
        address[] memory proposers = new address[](1);
        proposers[0] = governanceSafe;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        address[] memory cancellers = new address[](1);
        cancellers[0] = pauserSafe;
        timelock = new VaipakamTimelock(DELAY, proposers, executors, cancellers);

        _handover();
    }

    /// @dev Mirrors `Handover.s.sol` step 3: root admin to the Timelock
    ///      first, the revoker to the Safe, the delayed roles to the
    ///      Timelock, PAUSER to the Pauser Safe, ownership to the Timelock,
    ///      then ADMIN renounces — DEFAULT_ADMIN_ROLE last.
    function _handover() internal {
        ac.grantRole(LibAccessControl.DEFAULT_ADMIN_ROLE, address(timelock));
        ac.grantRole(LibAccessControl.EMERGENCY_REVOKER_ROLE, governanceSafe);
        bytes32[6] memory tlRoles = [
            LibAccessControl.ADMIN_ROLE,
            LibAccessControl.UNPAUSER_ROLE,
            LibAccessControl.KYC_ADMIN_ROLE,
            LibAccessControl.ORACLE_ADMIN_ROLE,
            LibAccessControl.RISK_ADMIN_ROLE,
            LibAccessControl.VAULT_ADMIN_ROLE
        ];
        for (uint256 i; i < tlRoles.length; ++i) ac.grantRole(tlRoles[i], address(timelock));
        ac.grantRole(LibAccessControl.PAUSER_ROLE, pauserSafe);
        ac.grantRole(LibAccessControl.KEEPER_ROLE, keeperBot);
        OwnershipFacet(address(diamond)).transferOwnership(address(timelock));

        ac.renounceRole(LibAccessControl.PAUSER_ROLE, admin);
        ac.renounceRole(LibAccessControl.EMERGENCY_REVOKER_ROLE, admin);
        for (uint256 i = tlRoles.length; i > 0; --i) ac.renounceRole(tlRoles[i - 1], admin);
        ac.renounceRole(LibAccessControl.KEEPER_ROLE, admin);
        ac.renounceRole(LibAccessControl.WATCHER_ROLE, admin);
        ac.renounceRole(LibAccessControl.NOTIF_BILLER_ROLE, admin);
        ac.renounceRole(LibAccessControl.DEFAULT_ADMIN_ROLE, admin);
    }

    // ─── topology ───────────────────────────────────────────────────────

    function test_Topology_RootAndOwnershipOnTimelock_SafeHoldsOnlyRevoker() public view {
        assertEq(OwnershipFacet(address(diamond)).owner(), address(timelock));
        assertTrue(ac.hasRole(LibAccessControl.DEFAULT_ADMIN_ROLE, address(timelock)));
        assertTrue(ac.hasRole(LibAccessControl.EMERGENCY_REVOKER_ROLE, governanceSafe));

        bytes32[] memory roles = LibAccessControl.grantableRoles();
        for (uint256 i; i < roles.length; ++i) {
            if (roles[i] == LibAccessControl.EMERGENCY_REVOKER_ROLE) continue;
            assertFalse(ac.hasRole(roles[i], governanceSafe), "Safe holds a role beyond the revoker");
            assertFalse(ac.hasRole(roles[i], admin), "handover signer kept a role");
        }
    }

    // ─── #934: the Safe has no zero-delay path to authority ─────────────

    function test_Safe_CannotGrantAnyRole() public {
        vm.prank(governanceSafe);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibAccessControl.AccessControlUnauthorizedAccount.selector,
                governanceSafe,
                LibAccessControl.DEFAULT_ADMIN_ROLE
            )
        );
        ac.grantRole(LibAccessControl.VAULT_ADMIN_ROLE, attacker);
    }

    function test_Safe_CannotTransferAdmin() public {
        vm.prank(governanceSafe);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibAccessControl.AccessControlUnauthorizedAccount.selector,
                governanceSafe,
                LibAccessControl.DEFAULT_ADMIN_ROLE
            )
        );
        ac.transferAdmin(attacker);
    }

    function test_Safe_CannotTransferOwnership() public {
        vm.prank(governanceSafe);
        vm.expectRevert("LibDiamond: Must be contract owner");
        OwnershipFacet(address(diamond)).transferOwnership(attacker);
    }

    /// The same grant the Safe cannot make directly lands only after the
    /// Timelock delay — and the independent canceller can stop it first.
    function test_GrantThroughTimelock_WaitsOutDelay_AndIsCancellable() public {
        bytes memory data = abi.encodeCall(
            AccessControlFacet.grantRole, (LibAccessControl.VAULT_ADMIN_ROLE, attacker)
        );
        vm.prank(governanceSafe);
        timelock.schedule(address(diamond), 0, data, bytes32(0), bytes32("a"), DELAY);

        vm.expectRevert(); // not ready
        timelock.execute(address(diamond), 0, data, bytes32(0), bytes32("a"));

        // The Pauser Safe vetoes during the window.
        bytes32 id = timelock.hashOperation(address(diamond), 0, data, bytes32(0), bytes32("a"));
        vm.prank(pauserSafe);
        timelock.cancel(id);
        // vm.getBlockTimestamp, not block.timestamp: viaIR may reuse an
        // earlier read of the timestamp across warps in one test.
        vm.warp(vm.getBlockTimestamp() + DELAY + 1);
        vm.expectRevert();
        timelock.execute(address(diamond), 0, data, bytes32(0), bytes32("a"));
        assertFalse(ac.hasRole(LibAccessControl.VAULT_ADMIN_ROLE, attacker));

        // Re-queued and left alone, it executes after the delay.
        vm.prank(governanceSafe);
        timelock.schedule(address(diamond), 0, data, bytes32(0), bytes32("b"), DELAY);
        vm.warp(vm.getBlockTimestamp() + DELAY + 1);
        timelock.execute(address(diamond), 0, data, bytes32(0), bytes32("b"));
        assertTrue(ac.hasRole(LibAccessControl.VAULT_ADMIN_ROLE, attacker));
    }

    // ─── the emergency revoker ──────────────────────────────────────────

    function test_Revoker_StripsHotKeyImmediately() public {
        vm.prank(governanceSafe);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit AccessControlFacet.EmergencyRoleRevoked(
            LibAccessControl.KEEPER_ROLE, keeperBot, governanceSafe, "keeper key leaked"
        );
        ac.emergencyRevokeRole(LibAccessControl.KEEPER_ROLE, keeperBot, "keeper key leaked");
        assertFalse(ac.hasRole(LibAccessControl.KEEPER_ROLE, keeperBot));

        vm.prank(governanceSafe);
        ac.emergencyRevokeRole(LibAccessControl.PAUSER_ROLE, pauserSafe, "pauser key leaked");
        assertFalse(ac.hasRole(LibAccessControl.PAUSER_ROLE, pauserSafe));
    }

    function test_Revoker_CannotRevokeRootAdmin() public {
        vm.prank(governanceSafe);
        vm.expectRevert(AccessControlFacet.CannotEmergencyRevokeRootAdmin.selector);
        ac.emergencyRevokeRole(LibAccessControl.DEFAULT_ADMIN_ROLE, address(timelock), "x");
    }

    /// A compromised revoker must not be able to disarm governance by
    /// stripping the Timelock's delayed roles one by one.
    function test_Revoker_CannotRevokeFromOwner() public {
        vm.prank(governanceSafe);
        vm.expectRevert(
            abi.encodeWithSelector(
                AccessControlFacet.CannotEmergencyRevokeFromOwner.selector, address(timelock)
            )
        );
        ac.emergencyRevokeRole(LibAccessControl.VAULT_ADMIN_ROLE, address(timelock), "x");
        assertTrue(ac.hasRole(LibAccessControl.VAULT_ADMIN_ROLE, address(timelock)));
    }

    function test_EmergencyRevoke_RequiresRevokerRole() public {
        // Not even the Timelock — the root admin — may use the zero-delay
        // path; it has the ordinary `revokeRole` through its own queue.
        vm.prank(address(timelock));
        vm.expectRevert(
            abi.encodeWithSelector(
                LibAccessControl.AccessControlUnauthorizedAccount.selector,
                address(timelock),
                LibAccessControl.EMERGENCY_REVOKER_ROLE
            )
        );
        ac.emergencyRevokeRole(LibAccessControl.KEEPER_ROLE, keeperBot, "x");

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibAccessControl.AccessControlUnauthorizedAccount.selector,
                attacker,
                LibAccessControl.EMERGENCY_REVOKER_ROLE
            )
        );
        ac.emergencyRevokeRole(LibAccessControl.KEEPER_ROLE, keeperBot, "x");
    }

    /// The Timelock (root admin) can take the revoker role away through its
    /// own queue — the Safe's lever is itself governed.
    function test_Timelock_CanRemoveRevoker() public {
        bytes memory data = abi.encodeCall(
            AccessControlFacet.revokeRole, (LibAccessControl.EMERGENCY_REVOKER_ROLE, governanceSafe)
        );
        vm.prank(governanceSafe);
        timelock.schedule(address(diamond), 0, data, bytes32(0), bytes32(0), DELAY);
        vm.warp(block.timestamp + DELAY + 1);
        timelock.execute(address(diamond), 0, data, bytes32(0), bytes32(0));
        assertFalse(ac.hasRole(LibAccessControl.EMERGENCY_REVOKER_ROLE, governanceSafe));
    }

    // ─── #906 on the live topology ──────────────────────────────────────

    /// The Timelock is owner, so even a queued self-renounce of the root is
    /// refused: the Diamond cannot be left with an owner outside the role
    /// root.
    function test_Timelock_CannotOrphanRoot() public {
        bytes memory data = abi.encodeCall(
            AccessControlFacet.renounceRole, (LibAccessControl.DEFAULT_ADMIN_ROLE, address(timelock))
        );
        vm.prank(governanceSafe);
        timelock.schedule(address(diamond), 0, data, bytes32(0), bytes32(0), DELAY);
        vm.warp(block.timestamp + DELAY + 1);
        vm.expectRevert(); // CannotRemoveOwnerRootAdmin, wrapped by the timelock
        timelock.execute(address(diamond), 0, data, bytes32(0), bytes32(0));
        assertTrue(ac.hasRole(LibAccessControl.DEFAULT_ADMIN_ROLE, address(timelock)));
    }
}
