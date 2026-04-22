// test/AccessControlFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {HelperTest} from "./HelperTest.sol";

contract AccessControlFacetTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address user1;
    address user2;

    DiamondCutFacet cutFacet;
    AccessControlFacet accessControlFacet;
    HelperTest helperTest;

    function setUp() public {
        owner = address(this);
        user1 = makeAddr("user1");
        user2 = makeAddr("user2");

        cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));
        accessControlFacet = new AccessControlFacet();
        helperTest = new HelperTest();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(accessControlFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAccessControlFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();
    }

    // ─── initializeAccessControl ─────────────────────────────────────────

    function testInitializeAccessControlGrantsAllRoles() public view {
        assertTrue(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.DEFAULT_ADMIN_ROLE, owner));
        assertTrue(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.ADMIN_ROLE, owner));
        assertTrue(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.PAUSER_ROLE, owner));
        assertTrue(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.KYC_ADMIN_ROLE, owner));
        assertTrue(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.ORACLE_ADMIN_ROLE, owner));
        assertTrue(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.RISK_ADMIN_ROLE, owner));
    }

    function testInitializeAccessControlRevertsNonOwner() public {
        vm.prank(user1);
        vm.expectRevert("LibDiamond: Must be contract owner");
        AccessControlFacet(address(diamond)).initializeAccessControl();
    }

    // ─── grantRole ───────────────────────────────────────────────────────

    function testGrantRoleSuccess() public {
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.ADMIN_ROLE, user1);
        assertTrue(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.ADMIN_ROLE, user1));
    }

    function testGrantRoleRevertsUnauthorized() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibAccessControl.AccessControlUnauthorizedAccount.selector,
                user1,
                LibAccessControl.DEFAULT_ADMIN_ROLE
            )
        );
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.ADMIN_ROLE, user2);
    }

    function testGrantRoleAlreadyGrantedNoOp() public {
        // Grant twice — second should be a no-op (no event)
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.ADMIN_ROLE, user1);
        assertTrue(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.ADMIN_ROLE, user1));

        // Grant again — should not revert
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.ADMIN_ROLE, user1);
        assertTrue(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.ADMIN_ROLE, user1));
    }

    // ─── revokeRole ──────────────────────────────────────────────────────

    function testRevokeRoleSuccess() public {
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.ADMIN_ROLE, user1);
        assertTrue(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.ADMIN_ROLE, user1));

        AccessControlFacet(address(diamond)).revokeRole(LibAccessControl.ADMIN_ROLE, user1);
        assertFalse(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.ADMIN_ROLE, user1));
    }

    function testRevokeRoleRevertsUnauthorized() public {
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.ADMIN_ROLE, user1);

        vm.prank(user2);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibAccessControl.AccessControlUnauthorizedAccount.selector,
                user2,
                LibAccessControl.DEFAULT_ADMIN_ROLE
            )
        );
        AccessControlFacet(address(diamond)).revokeRole(LibAccessControl.ADMIN_ROLE, user1);
    }

    function testRevokeRoleNoOpIfNotGranted() public {
        // Revoke a role the user doesn't have — should be no-op
        assertFalse(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.ADMIN_ROLE, user1));
        AccessControlFacet(address(diamond)).revokeRole(LibAccessControl.ADMIN_ROLE, user1);
        assertFalse(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.ADMIN_ROLE, user1));
    }

    // ─── renounceRole ────────────────────────────────────────────────────

    function testRenounceRoleSuccess() public {
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.ADMIN_ROLE, user1);

        vm.prank(user1);
        AccessControlFacet(address(diamond)).renounceRole(LibAccessControl.ADMIN_ROLE, user1);
        assertFalse(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.ADMIN_ROLE, user1));
    }

    function testRenounceRoleRevertsBadConfirmation() public {
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.ADMIN_ROLE, user1);

        vm.prank(user1);
        vm.expectRevert(LibAccessControl.AccessControlBadConfirmation.selector);
        AccessControlFacet(address(diamond)).renounceRole(LibAccessControl.ADMIN_ROLE, user2);
    }

    function testRenounceRoleNoOpIfNotHolder() public {
        // Renounce a role not held — no-op, no revert
        vm.prank(user1);
        AccessControlFacet(address(diamond)).renounceRole(LibAccessControl.ADMIN_ROLE, user1);
        assertFalse(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.ADMIN_ROLE, user1));
    }

    // ─── hasRole ─────────────────────────────────────────────────────────

    function testHasRoleReturnsFalseByDefault() public view {
        assertFalse(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.ADMIN_ROLE, user1));
    }

    function testHasRoleReturnsTrueAfterGrant() public {
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.PAUSER_ROLE, user1);
        assertTrue(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.PAUSER_ROLE, user1));
    }

    // ─── getRoleAdmin ────────────────────────────────────────────────────

    function testGetRoleAdminReturnsDefaultAdmin() public view {
        assertEq(
            AccessControlFacet(address(diamond)).getRoleAdmin(LibAccessControl.ADMIN_ROLE),
            LibAccessControl.DEFAULT_ADMIN_ROLE
        );
        assertEq(
            AccessControlFacet(address(diamond)).getRoleAdmin(LibAccessControl.PAUSER_ROLE),
            LibAccessControl.DEFAULT_ADMIN_ROLE
        );
    }

    // ─── Role Constants ──────────────────────────────────────────────────

    function testRoleConstantsAreCorrect() public view {
        assertEq(AccessControlFacet(address(diamond)).DEFAULT_ADMIN_ROLE(), LibAccessControl.DEFAULT_ADMIN_ROLE);
        assertEq(AccessControlFacet(address(diamond)).ADMIN_ROLE(), LibAccessControl.ADMIN_ROLE);
        assertEq(AccessControlFacet(address(diamond)).PAUSER_ROLE(), LibAccessControl.PAUSER_ROLE);
        assertEq(AccessControlFacet(address(diamond)).KYC_ADMIN_ROLE(), LibAccessControl.KYC_ADMIN_ROLE);
        assertEq(AccessControlFacet(address(diamond)).ORACLE_ADMIN_ROLE(), LibAccessControl.ORACLE_ADMIN_ROLE);
        assertEq(AccessControlFacet(address(diamond)).RISK_ADMIN_ROLE(), LibAccessControl.RISK_ADMIN_ROLE);
    }

    // Note: ESCROW_ADMIN_ROLE selector is not cut into the diamond via getAccessControlFacetSelectors

    // ─── Multi-role scenarios ────────────────────────────────────────────

    function testGrantMultipleRolesToSameUser() public {
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.ADMIN_ROLE, user1);
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.PAUSER_ROLE, user1);
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.KYC_ADMIN_ROLE, user1);

        assertTrue(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.ADMIN_ROLE, user1));
        assertTrue(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.PAUSER_ROLE, user1));
        assertTrue(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.KYC_ADMIN_ROLE, user1));
    }

    function testRevokeOneRoleKeepsOthers() public {
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.ADMIN_ROLE, user1);
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.PAUSER_ROLE, user1);

        AccessControlFacet(address(diamond)).revokeRole(LibAccessControl.ADMIN_ROLE, user1);

        assertFalse(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.ADMIN_ROLE, user1));
        assertTrue(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.PAUSER_ROLE, user1));
    }
}
