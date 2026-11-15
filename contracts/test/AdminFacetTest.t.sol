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
import {ArtifactDeploy} from "../script/lib/ArtifactDeploy.sol";

/**
 * @title AdminFacetTest
 * @notice Tests AdminFacet: setZeroExProxy, setallowanceTarget, getTreasury (the vault
 *         code's since #3569; the retired setter is not routed).
 *         Covers access control (owner-only) and zero-address validation.
 */
contract AdminFacetTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address nonOwner;
    address zeroExProxy;
    address allowanceTarget;

    DiamondCutFacet cutFacet;
    AdminFacet adminFacet;
    AccessControlFacet accessControlFacet;
    HelperTest helperTest;

    function setUp() public {
        owner = address(this);
        nonOwner = makeAddr("nonOwner");
        zeroExProxy = makeAddr("zeroExProxy");
        allowanceTarget = makeAddr("allowanceTarget");

        cutFacet = DiamondCutFacet(ArtifactDeploy.deploy(type(DiamondCutFacet).name));
        diamond = new VaipakamDiamond(owner, address(cutFacet));
        adminFacet = AdminFacet(ArtifactDeploy.deploy(type(AdminFacet).name));
        accessControlFacet = AccessControlFacet(ArtifactDeploy.deploy(type(AccessControlFacet).name));
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
        AdminFacet(address(diamond)).unpause();
    }

    // ─── Treasury (#3569) ─────────────────────────────────────────────────────

    /// @notice The treasury is the vault code's: with no vault beacon the
    ///         Diamond has none to report.
    function testGetTreasuryIsZeroWithoutVaultCode() public view {
        assertEq(AdminFacet(address(diamond)).getTreasury(), address(0));
    }

    /// @notice The retired setter is gone from the Diamond's routes.
    function testRetiredSetTreasuryIsNotRouted() public {
        (bool ok, bytes memory ret) =
            address(diamond).call(abi.encodeWithSignature("setTreasury(address)", makeAddr("treasury")));
        assertFalse(ok);
        assertEq(bytes4(ret), VaipakamDiamond.FunctionDoesNotExist.selector);
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

    /// @dev Asymmetric pause split (asymmetric pause pattern): unpause()
    ///      now requires UNPAUSER_ROLE, not PAUSER_ROLE. The test
    ///      name is kept for git-blame continuity; the expected
    ///      revert role updates accordingly.
    function testUnpauseRevertsNonPauser() public {
        AdminFacet(address(diamond)).pause();
        vm.prank(nonOwner);
        vm.expectRevert(abi.encodeWithSelector(LibAccessControl.AccessControlUnauthorizedAccount.selector, nonOwner, LibAccessControl.UNPAUSER_ROLE));
        AdminFacet(address(diamond)).unpause();
    }

    function testPausedReturnsFalseByDefault() public view {
        assertFalse(AdminFacet(address(diamond)).paused());
    }

    // ─── #1637 kill-switch getters ────────────────────────────────────────────

    /// @notice Each kill switch reads back what its setter just wrote.
    function testKillSwitchGettersReadBackTheirSetters() public {
        AdminFacet a = AdminFacet(address(diamond));
        assertFalse(a.aggregatorAdaptersPaused());
        assertFalse(a.peerLtvReadsPaused());

        a.setAggregatorAdaptersPaused(true);
        a.setPeerLtvReadsPaused(true);
        assertTrue(a.aggregatorAdaptersPaused());
        assertTrue(a.peerLtvReadsPaused());

        a.setAggregatorAdaptersPaused(false);
        assertFalse(a.aggregatorAdaptersPaused());
        assertTrue(a.peerLtvReadsPaused(), "the two switches are independent");
    }
}
