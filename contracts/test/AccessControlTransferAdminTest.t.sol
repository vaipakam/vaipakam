// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IERC173} from "@diamond-3/interfaces/IERC173.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {OwnershipFacet} from "../src/facets/OwnershipFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {HelperTest} from "./HelperTest.sol";

/**
 * @title AccessControlTransferAdminTest
 * @notice Pins {AccessControlFacet.transferAdmin} — Item 3 of the
 *         post-rehearsal contract follow-ups
 *         ([docs/internal/ContractFollowupsFromRehearsal-2026-05-06.md]).
 *
 *         The legacy 23-tx role handover (11 grants + 1 ownership
 *         transfer + 11 renounces) is replaced by a single atomic
 *         function that:
 *           1. grants every role from {LibAccessControl.grantableRoles}
 *              to `newAdmin`,
 *           2. transfers ERC-173 ownership of the Diamond, and
 *           3. revokes every role from the caller — DEFAULT_ADMIN_ROLE
 *              last so a future intermediate revert leaves the caller
 *              recoverable.
 *
 *         Tests pin both the happy-path end state and the three
 *         revert paths (zero address, self-transfer, non-admin caller).
 */
contract AccessControlTransferAdminTest is Test {
    VaipakamDiamond internal diamond;
    HelperTest internal helper;

    address internal CALLER;
    address internal newAdmin = address(0xA11CE);
    address internal nonAdmin = address(0xBEEF);

    function setUp() public {
        CALLER = address(this);
        DiamondCutFacet cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(CALLER, address(cutFacet));
        helper = new HelperTest();

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

        AccessControlFacet(address(diamond)).initializeAccessControl();
    }

    // ─── happy path ─────────────────────────────────────────────────────

    /// @notice After {transferAdmin}, the new address holds every role
    ///         in {LibAccessControl.grantableRoles}, the Diamond's
    ///         ERC-173 owner is the new address, and the previous
    ///         caller holds zero roles.
    function test_transferAdmin_HandsOverEveryRole() public {
        bytes32[] memory roles = LibAccessControl.grantableRoles();

        // Sanity preconditions
        for (uint256 i = 0; i < roles.length; i++) {
            assertTrue(
                AccessControlFacet(address(diamond)).hasRole(roles[i], CALLER),
                "caller must hold every role pre-transfer"
            );
            assertFalse(
                AccessControlFacet(address(diamond)).hasRole(roles[i], newAdmin),
                "newAdmin must hold no roles pre-transfer"
            );
        }
        assertEq(IERC173(address(diamond)).owner(), CALLER);

        // Atomic handover.
        AccessControlFacet(address(diamond)).transferAdmin(newAdmin);

        // Post-conditions: newAdmin has all roles, caller has none,
        // ownership is on newAdmin.
        for (uint256 i = 0; i < roles.length; i++) {
            assertTrue(
                AccessControlFacet(address(diamond)).hasRole(roles[i], newAdmin),
                "newAdmin must hold every role post-transfer"
            );
            assertFalse(
                AccessControlFacet(address(diamond)).hasRole(roles[i], CALLER),
                "caller must hold no roles post-transfer"
            );
        }
        assertEq(IERC173(address(diamond)).owner(), newAdmin);
    }

    /// @notice Emits a single {AdminTransferred} event with the prev /
    ///         new admin pair. The per-role grant + revoke logs from
    ///         LibAccessControl are also emitted by the same tx, but
    ///         this top-level event is the cheap pivot indexers rely on.
    function test_transferAdmin_EmitsAdminTransferred() public {
        vm.expectEmit(true, true, false, false, address(diamond));
        emit AccessControlFacet.AdminTransferred(CALLER, newAdmin);
        AccessControlFacet(address(diamond)).transferAdmin(newAdmin);
    }

    /// @notice After {transferAdmin}, attempting any role-gated action
    ///         from the previous admin reverts. Confirms revoke landed.
    function test_transferAdmin_FormerAdminLockedOut() public {
        AccessControlFacet(address(diamond)).transferAdmin(newAdmin);

        vm.expectRevert(); // AccessControlUnauthorizedAccount
        AccessControlFacet(address(diamond)).grantRole(
            LibAccessControl.ADMIN_ROLE,
            address(0xCAFE)
        );
    }

    /// @notice After {transferAdmin}, only the new admin can call
    ///         role-gated functions. Confirms grant landed.
    function test_transferAdmin_NewAdminCanWield() public {
        AccessControlFacet(address(diamond)).transferAdmin(newAdmin);

        vm.prank(newAdmin);
        AccessControlFacet(address(diamond)).grantRole(
            LibAccessControl.ADMIN_ROLE,
            address(0xCAFE)
        );
        assertTrue(
            AccessControlFacet(address(diamond)).hasRole(
                LibAccessControl.ADMIN_ROLE,
                address(0xCAFE)
            )
        );
    }

    // ─── revert paths ───────────────────────────────────────────────────

    function test_transferAdmin_RevertsOnZeroAddress() public {
        vm.expectRevert(AccessControlFacet.TransferAdminToZero.selector);
        AccessControlFacet(address(diamond)).transferAdmin(address(0));
    }

    function test_transferAdmin_RevertsOnSelf() public {
        vm.expectRevert(AccessControlFacet.TransferAdminToSelf.selector);
        AccessControlFacet(address(diamond)).transferAdmin(CALLER);
    }

    function test_transferAdmin_RevertsWhenCallerNotDefaultAdmin() public {
        vm.prank(nonAdmin);
        vm.expectRevert(); // AccessControlUnauthorizedAccount(nonAdmin, DEFAULT_ADMIN_ROLE)
        AccessControlFacet(address(diamond)).transferAdmin(newAdmin);
    }

    /// @notice State must not partially mutate when the function reverts
    ///         on the pre-flight check. Verifies caller still holds every
    ///         role + ownership after a self-transfer revert.
    function test_transferAdmin_NoPartialMutationOnRevert() public {
        bytes32[] memory roles = LibAccessControl.grantableRoles();

        try AccessControlFacet(address(diamond)).transferAdmin(CALLER) {
            revert("self-transfer should have reverted");
        } catch {}

        for (uint256 i = 0; i < roles.length; i++) {
            assertTrue(
                AccessControlFacet(address(diamond)).hasRole(roles[i], CALLER),
                "caller must still hold every role after revert"
            );
        }
        assertEq(IERC173(address(diamond)).owner(), CALLER);
    }
}
