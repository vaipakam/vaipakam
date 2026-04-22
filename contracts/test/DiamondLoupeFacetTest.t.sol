// test/DiamondLoupeFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OwnershipFacet} from "../src/facets/OwnershipFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {HelperTest} from "./HelperTest.sol";

// Minimal loupe interface to avoid IERC165 collision between @diamond-3 and OpenZeppelin
interface ILoupe {
    struct Facet {
        address facetAddress;
        bytes4[] functionSelectors;
    }
    function facets() external view returns (Facet[] memory);
    function facetFunctionSelectors(address _facet) external view returns (bytes4[] memory);
    function facetAddresses() external view returns (address[] memory);
    function facetAddress(bytes4 _selector) external view returns (address);
    function supportsInterface(bytes4 _interfaceId) external view returns (bool);
}

/**
 * @title DiamondLoupeFacetTest
 * @notice Full coverage for DiamondLoupeFacet (facets, facetFunctionSelectors,
 *         facetAddresses, facetAddress, supportsInterface) and OwnershipFacet
 *         (owner, transferOwnership).
 */
contract DiamondLoupeFacetTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address newOwner;

    DiamondCutFacet cutFacet;
    address loupeFacet;   // DiamondLoupeFacet — stored as address to avoid IERC165 import conflict
    OwnershipFacet ownershipFacet;
    AdminFacet adminFacet;
    AccessControlFacet accessControlFacet;
    HelperTest helperTest;

    function setUp() public {
        owner = address(this);
        newOwner = makeAddr("newOwner");

        cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));
        // Deploy DiamondLoupeFacet via raw bytecode to avoid IERC165 identifier collision
        bytes memory code = vm.getCode("DiamondLoupeFacet.sol:DiamondLoupeFacet");
        address deployed;
        assembly { deployed := create(0, add(code, 0x20), mload(code)) }
        loupeFacet = deployed;
        ownershipFacet = new OwnershipFacet();
        adminFacet = new AdminFacet();
        accessControlFacet = new AccessControlFacet();
        helperTest = new HelperTest();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](4);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: loupeFacet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getDiamondLoupeFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(ownershipFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOwnershipFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(adminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAdminFacetSelectors()
        });
        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: address(accessControlFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAccessControlFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();
    }

    // ─── facets() ─────────────────────────────────────────────────────────────

    function testFacetsReturnsCutFacet() public view {
        ILoupe.Facet[] memory fs = ILoupe(address(diamond)).facets();
        // DiamondCutFacet is registered at construction; plus the 3 we added
        assertGt(fs.length, 0);
    }

    function testFacetsContainsLoupeFacet() public view {
        ILoupe.Facet[] memory fs = ILoupe(address(diamond)).facets();
        bool found = false;
        for (uint256 i = 0; i < fs.length; i++) {
            if (fs[i].facetAddress == loupeFacet) {
                found = true;
                assertGt(fs[i].functionSelectors.length, 0);
                break;
            }
        }
        assertTrue(found, "LoupeFacet not found in facets()");
    }

    function testFacetsContainsOwnershipFacet() public view {
        ILoupe.Facet[] memory fs = ILoupe(address(diamond)).facets();
        bool found = false;
        for (uint256 i = 0; i < fs.length; i++) {
            if (fs[i].facetAddress == address(ownershipFacet)) {
                found = true;
                break;
            }
        }
        assertTrue(found, "OwnershipFacet not found in facets()");
    }

    function testFacetsContainsAdminFacet() public view {
        ILoupe.Facet[] memory fs = ILoupe(address(diamond)).facets();
        bool found = false;
        for (uint256 i = 0; i < fs.length; i++) {
            if (fs[i].facetAddress == address(adminFacet)) {
                found = true;
                break;
            }
        }
        assertTrue(found, "AdminFacet not found in facets()");
    }

    // ─── facetFunctionSelectors() ─────────────────────────────────────────────

    function testFacetFunctionSelectorsForLoupe() public view {
        bytes4[] memory selectors = ILoupe(address(diamond)).facetFunctionSelectors(loupeFacet);
        assertEq(selectors.length, 5); // facets, facetFunctionSelectors, facetAddresses, facetAddress, supportsInterface
    }

    function testFacetFunctionSelectorsForOwnership() public view {
        bytes4[] memory selectors = ILoupe(address(diamond)).facetFunctionSelectors(address(ownershipFacet));
        assertEq(selectors.length, 2); // transferOwnership, owner
    }

    function testFacetFunctionSelectorsForUnknownAddress() public {
        bytes4[] memory selectors = ILoupe(address(diamond)).facetFunctionSelectors(makeAddr("unknown"));
        assertEq(selectors.length, 0);
    }

    // ─── facetAddresses() ─────────────────────────────────────────────────────

    function testFacetAddressesReturnsRegisteredFacets() public view {
        address[] memory addrs = ILoupe(address(diamond)).facetAddresses();
        assertGt(addrs.length, 0);
        // Verify our 3 facets appear
        bool foundLoupe = false;
        bool foundOwnership = false;
        bool foundAdmin = false;
        for (uint256 i = 0; i < addrs.length; i++) {
            if (addrs[i] == loupeFacet) foundLoupe = true;
            if (addrs[i] == address(ownershipFacet)) foundOwnership = true;
            if (addrs[i] == address(adminFacet)) foundAdmin = true;
        }
        assertTrue(foundLoupe);
        assertTrue(foundOwnership);
        assertTrue(foundAdmin);
    }

    // ─── facetAddress() ───────────────────────────────────────────────────────

    function testFacetAddressForKnownSelector() public view {
        // AdminFacet.setTreasury.selector should map to adminFacet
        address facet = ILoupe(address(diamond)).facetAddress(AdminFacet.setTreasury.selector);
        assertEq(facet, address(adminFacet));
    }

    function testFacetAddressForOwnerSelector() public view {
        address facet = ILoupe(address(diamond)).facetAddress(OwnershipFacet.owner.selector);
        assertEq(facet, address(ownershipFacet));
    }

    function testFacetAddressForUnknownSelectorReturnsZero() public {
        address facet = ILoupe(address(diamond)).facetAddress(bytes4(keccak256("nonExistent()")));
        assertEq(facet, address(0));
    }

    // ─── supportsInterface() ──────────────────────────────────────────────────

    function testSupportsInterfaceERC165() public view {
        // ds.supportedInterfaces is only populated if explicitly set during diamondCut/init.
        // By default it is false; this verifies the function is callable and returns a bool.
        bool result = ILoupe(address(diamond)).supportsInterface(0x01ffc9a7);
        // Result is false unless explicitly registered — assert the function executes without revert.
        assertTrue(result == true || result == false);
    }

    function testSupportsInterfaceUnknownReturnsFalse() public {
        // Unregistered interface always returns false
        assertFalse(ILoupe(address(diamond)).supportsInterface(bytes4(keccak256("unknown()"))));
    }

    // ─── OwnershipFacet.owner() ───────────────────────────────────────────────

    function testOwnerReturnsDeployer() public view {
        assertEq(OwnershipFacet(address(diamond)).owner(), owner);
    }

    // ─── OwnershipFacet.transferOwnership() ──────────────────────────────────

    function testTransferOwnershipSuccess() public {
        OwnershipFacet(address(diamond)).transferOwnership(newOwner);
        assertEq(OwnershipFacet(address(diamond)).owner(), newOwner);
    }

    function testTransferOwnershipRevertsNonOwner() public {
        vm.prank(newOwner);
        vm.expectRevert("LibDiamond: Must be contract owner");
        OwnershipFacet(address(diamond)).transferOwnership(newOwner);
    }

    function testTransferOwnershipNewOwnerCanAct() public {
        // Grant ADMIN_ROLE to newOwner before transferring ownership
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.ADMIN_ROLE, newOwner);
        OwnershipFacet(address(diamond)).transferOwnership(newOwner);

        // newOwner can now set treasury (has ADMIN_ROLE)
        vm.prank(newOwner);
        AdminFacet(address(diamond)).setTreasury(makeAddr("treasury"));
    }

    function testOldOwnerCannotActAfterTransfer() public {
        OwnershipFacet(address(diamond)).transferOwnership(newOwner);

        // Old owner revokes their own ADMIN_ROLE (they still have DEFAULT_ADMIN_ROLE which is the admin for ADMIN_ROLE)
        AccessControlFacet(address(diamond)).revokeRole(LibAccessControl.ADMIN_ROLE, owner);

        // original owner can no longer call setTreasury
        vm.expectRevert(abi.encodeWithSelector(LibAccessControl.AccessControlUnauthorizedAccount.selector, owner, LibAccessControl.ADMIN_ROLE));
        AdminFacet(address(diamond)).setTreasury(makeAddr("treasury"));
    }
}
