// test/AdminFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {HelperTest} from "./HelperTest.sol";

/**
 * @title AdminFacetTest
 * @notice Tests AdminFacet: setTreasury, setZeroExProxy, setallowanceTarget, getTreasury.
 *         Covers access control (owner-only) and zero-address validation.
 */
contract AdminFacetTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address nonOwner;
    address treasury;
    address zeroExProxy;
    address allowanceTarget;

    DiamondCutFacet cutFacet;
    AdminFacet adminFacet;
    AccessControlFacet accessControlFacet;
    HelperTest helperTest;

    function setUp() public {
        owner = address(this);
        nonOwner = makeAddr("nonOwner");
        treasury = makeAddr("treasury");
        zeroExProxy = makeAddr("zeroExProxy");
        allowanceTarget = makeAddr("allowanceTarget");

        cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));
        adminFacet = new AdminFacet();
        accessControlFacet = new AccessControlFacet();
        helperTest = new HelperTest();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(adminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAdminFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(accessControlFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAccessControlFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();
    }

    // ─── setTreasury ──────────────────────────────────────────────────────────

    function testSetTreasurySuccess() public {
        vm.expectEmit(true, false, false, false);
        emit AdminFacet.TreasurySet(treasury);
        AdminFacet(address(diamond)).setTreasury(treasury);
        assertEq(AdminFacet(address(diamond)).getTreasury(), treasury);
    }

    function testSetTreasuryRevertsZeroAddress() public {
        vm.expectRevert(IVaipakamErrors.InvalidAddress.selector);
        AdminFacet(address(diamond)).setTreasury(address(0));
    }

    function testSetTreasuryRevertsNonOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert(abi.encodeWithSelector(LibAccessControl.AccessControlUnauthorizedAccount.selector, nonOwner, LibAccessControl.ADMIN_ROLE));
        AdminFacet(address(diamond)).setTreasury(treasury);
    }

    function testSetTreasuryUpdatesValue() public {
        AdminFacet(address(diamond)).setTreasury(treasury);
        address newTreasury = makeAddr("newTreasury");
        AdminFacet(address(diamond)).setTreasury(newTreasury);
        assertEq(AdminFacet(address(diamond)).getTreasury(), newTreasury);
    }

    // ─── getTreasury ──────────────────────────────────────────────────────────

    function testGetTreasuryReturnsZeroBeforeSet() public view {
        assertEq(AdminFacet(address(diamond)).getTreasury(), address(0));
    }

    function testGetTreasuryReturnsSetValue() public {
        AdminFacet(address(diamond)).setTreasury(treasury);
        assertEq(AdminFacet(address(diamond)).getTreasury(), treasury);
    }

    // ─── setZeroExProxy ───────────────────────────────────────────────────────

    function testSetZeroExProxySuccess() public {
        vm.expectEmit(true, false, false, false);
        emit AdminFacet.ZeroExProxySet(zeroExProxy);
        AdminFacet(address(diamond)).setZeroExProxy(zeroExProxy);
    }

    function testSetZeroExProxyRevertsZeroAddress() public {
        vm.expectRevert(IVaipakamErrors.InvalidAddress.selector);
        AdminFacet(address(diamond)).setZeroExProxy(address(0));
    }

    function testSetZeroExProxyRevertsNonOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert(abi.encodeWithSelector(LibAccessControl.AccessControlUnauthorizedAccount.selector, nonOwner, LibAccessControl.ADMIN_ROLE));
        AdminFacet(address(diamond)).setZeroExProxy(zeroExProxy);
    }

    // ─── setallowanceTarget ───────────────────────────────────────────────────

    function testSetAllowanceTargetSuccess() public {
        vm.expectEmit(true, false, false, false);
        emit AdminFacet.AllowanceTargetSet(allowanceTarget);
        AdminFacet(address(diamond)).setallowanceTarget(allowanceTarget);
    }

    function testSetAllowanceTargetRevertsZeroAddress() public {
        vm.expectRevert(IVaipakamErrors.InvalidAddress.selector);
        AdminFacet(address(diamond)).setallowanceTarget(address(0));
    }

    function testSetAllowanceTargetRevertsNonOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert(abi.encodeWithSelector(LibAccessControl.AccessControlUnauthorizedAccount.selector, nonOwner, LibAccessControl.ADMIN_ROLE));
        AdminFacet(address(diamond)).setallowanceTarget(allowanceTarget);
    }

    // ─── pause / unpause ─────────────────────────────────────────────────────

    function testPauseSuccess() public {
        AdminFacet(address(diamond)).pause();
        assertTrue(AdminFacet(address(diamond)).paused());
    }

    function testUnpauseSuccess() public {
        AdminFacet(address(diamond)).pause();
        assertTrue(AdminFacet(address(diamond)).paused());
        AdminFacet(address(diamond)).unpause();
        assertFalse(AdminFacet(address(diamond)).paused());
    }

    function testPauseRevertsNonPauser() public {
        vm.prank(nonOwner);
        vm.expectRevert(abi.encodeWithSelector(LibAccessControl.AccessControlUnauthorizedAccount.selector, nonOwner, LibAccessControl.PAUSER_ROLE));
        AdminFacet(address(diamond)).pause();
    }

    function testUnpauseRevertsNonPauser() public {
        AdminFacet(address(diamond)).pause();
        vm.prank(nonOwner);
        vm.expectRevert(abi.encodeWithSelector(LibAccessControl.AccessControlUnauthorizedAccount.selector, nonOwner, LibAccessControl.PAUSER_ROLE));
        AdminFacet(address(diamond)).unpause();
    }

    function testPausedReturnsFalseByDefault() public view {
        assertFalse(AdminFacet(address(diamond)).paused());
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    function testFuzzSetTreasuryNonZero(address addr) public {
        vm.assume(addr != address(0));
        AdminFacet(address(diamond)).setTreasury(addr);
        assertEq(AdminFacet(address(diamond)).getTreasury(), addr);
    }
}
