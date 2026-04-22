// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {HelperTest} from "./HelperTest.sol";

/// @title DeployerZeroRolesTest
/// @notice Enforces the post-deploy key-rotation invariant from
///         `docs/ops/DeploymentRunbook.md` §6: after the deployer hands
///         every role to the governance multisig / admin timelock /
///         pauser multisig, the deployer must hold **zero** roles on
///         the Diamond. A runbook that is not enforced by CI is a
///         runbook that drifts — this test is that enforcement.
///
/// @dev Modeled on the canonical launch-check pattern: once the bootstrap
///      key has walked through its grants+renounces, the test asserts
///      (a) deployer holds nothing, (b) every role is held by the
///      intended production principal, and (c) a fuzzed arbitrary
///      address holds nothing.
contract DeployerZeroRolesTest is Test {
    VaipakamDiamond internal diamond;
    DiamondCutFacet internal cutFacet;
    AccessControlFacet internal accessControlFacet;
    HelperTest internal helperTest;

    address internal deployer; // the hot key used to broadcast deploy

    // Production role recipients per DeploymentRunbook.md §6 topology.
    address internal governanceMultisig;
    address internal adminTimelock;
    address internal pauserMultisig;

    bytes32[] internal ALL_ROLES;

    function setUp() public {
        deployer = address(this);
        governanceMultisig = makeAddr("governance-multisig");
        adminTimelock = makeAddr("admin-timelock");
        pauserMultisig = makeAddr("pauser-multisig");

        cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(deployer, address(cutFacet));
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

        ALL_ROLES.push(LibAccessControl.DEFAULT_ADMIN_ROLE);
        ALL_ROLES.push(LibAccessControl.ADMIN_ROLE);
        ALL_ROLES.push(LibAccessControl.PAUSER_ROLE);
        ALL_ROLES.push(LibAccessControl.KYC_ADMIN_ROLE);
        ALL_ROLES.push(LibAccessControl.ORACLE_ADMIN_ROLE);
        ALL_ROLES.push(LibAccessControl.RISK_ADMIN_ROLE);
        ALL_ROLES.push(LibAccessControl.ESCROW_ADMIN_ROLE);
    }

    // ─── 1. Initial state (pre-rotation) ──────────────────────────────────

    function testDeployerHoldsEveryRoleAtBootstrap() public view {
        AccessControlFacet ac = AccessControlFacet(address(diamond));
        for (uint256 i = 0; i < ALL_ROLES.length; i++) {
            assertTrue(
                ac.hasRole(ALL_ROLES[i], deployer),
                "deployer must start with every role (runbook premise)"
            );
        }
    }

    function testNoOtherPrincipalHoldsAnyRoleAtBootstrap() public view {
        AccessControlFacet ac = AccessControlFacet(address(diamond));
        for (uint256 i = 0; i < ALL_ROLES.length; i++) {
            assertFalse(ac.hasRole(ALL_ROLES[i], governanceMultisig));
            assertFalse(ac.hasRole(ALL_ROLES[i], adminTimelock));
            assertFalse(ac.hasRole(ALL_ROLES[i], pauserMultisig));
        }
    }

    // ─── 2. Rotation dance (runbook §6) ───────────────────────────────────

    /// @dev Replays DeploymentRunbook §6 end-to-end. DEFAULT_ADMIN is
    ///      renounced last so a mid-sequence slip (e.g., typo in grant)
    ///      can be recovered while the deployer still has authority.
    function _rotateRolesToProduction() internal {
        AccessControlFacet ac = AccessControlFacet(address(diamond));

        ac.grantRole(LibAccessControl.DEFAULT_ADMIN_ROLE, governanceMultisig);
        ac.grantRole(LibAccessControl.ADMIN_ROLE, adminTimelock);
        ac.grantRole(LibAccessControl.PAUSER_ROLE, pauserMultisig);
        ac.grantRole(LibAccessControl.KYC_ADMIN_ROLE, adminTimelock);
        ac.grantRole(LibAccessControl.ORACLE_ADMIN_ROLE, adminTimelock);
        ac.grantRole(LibAccessControl.RISK_ADMIN_ROLE, adminTimelock);
        ac.grantRole(LibAccessControl.ESCROW_ADMIN_ROLE, adminTimelock);

        ac.renounceRole(LibAccessControl.ESCROW_ADMIN_ROLE, deployer);
        ac.renounceRole(LibAccessControl.RISK_ADMIN_ROLE, deployer);
        ac.renounceRole(LibAccessControl.ORACLE_ADMIN_ROLE, deployer);
        ac.renounceRole(LibAccessControl.KYC_ADMIN_ROLE, deployer);
        ac.renounceRole(LibAccessControl.PAUSER_ROLE, deployer);
        ac.renounceRole(LibAccessControl.ADMIN_ROLE, deployer);
        ac.renounceRole(LibAccessControl.DEFAULT_ADMIN_ROLE, deployer);
    }

    // ─── 3. Post-rotation invariants ──────────────────────────────────────

    /// @notice **The main invariant.** After rotation, the deployer EOA
    ///         must hold zero roles. A failure here means the runbook
    ///         is incomplete or the rotation procedure regressed.
    function testDeployerHoldsNoRolesAfterRotation() public {
        _rotateRolesToProduction();

        AccessControlFacet ac = AccessControlFacet(address(diamond));
        for (uint256 i = 0; i < ALL_ROLES.length; i++) {
            assertFalse(
                ac.hasRole(ALL_ROLES[i], deployer),
                "deployer must hold zero roles post-rotation"
            );
        }
    }

    /// @notice Each role lands at the intended principal. Prevents a
    ///         regression where rotation renounces but forgets to grant.
    function testEveryRoleLandsAtIntendedPrincipal() public {
        _rotateRolesToProduction();

        AccessControlFacet ac = AccessControlFacet(address(diamond));
        assertTrue(ac.hasRole(LibAccessControl.DEFAULT_ADMIN_ROLE, governanceMultisig));
        assertTrue(ac.hasRole(LibAccessControl.ADMIN_ROLE, adminTimelock));
        assertTrue(ac.hasRole(LibAccessControl.PAUSER_ROLE, pauserMultisig));
        assertTrue(ac.hasRole(LibAccessControl.KYC_ADMIN_ROLE, adminTimelock));
        assertTrue(ac.hasRole(LibAccessControl.ORACLE_ADMIN_ROLE, adminTimelock));
        assertTrue(ac.hasRole(LibAccessControl.RISK_ADMIN_ROLE, adminTimelock));
        assertTrue(ac.hasRole(LibAccessControl.ESCROW_ADMIN_ROLE, adminTimelock));
    }

    /// @notice Pauser signer isolated from admin surface. A compromised
    ///         pauser must not be able to upgrade or grant roles.
    function testPauserSignerIsolatedFromAdmin() public {
        _rotateRolesToProduction();

        AccessControlFacet ac = AccessControlFacet(address(diamond));
        assertFalse(ac.hasRole(LibAccessControl.DEFAULT_ADMIN_ROLE, pauserMultisig));
        assertFalse(ac.hasRole(LibAccessControl.ADMIN_ROLE, pauserMultisig));
        assertFalse(ac.hasRole(LibAccessControl.ESCROW_ADMIN_ROLE, pauserMultisig));
    }

    /// @notice Timelock must NOT hold DEFAULT_ADMIN — only governance
    ///         multisig does. Keeps "grant/revoke any role" behind the
    ///         multisig rather than automatable via timelock.
    function testTimelockDoesNotHoldDefaultAdmin() public {
        _rotateRolesToProduction();

        AccessControlFacet ac = AccessControlFacet(address(diamond));
        assertFalse(ac.hasRole(LibAccessControl.DEFAULT_ADMIN_ROLE, adminTimelock));
    }

    // ─── 4. Post-rotation unreachability ──────────────────────────────────

    /// @notice After renouncing DEFAULT_ADMIN, the deployer cannot grant
    ///         itself any role back. Proves the renounce is effective.
    function testDeployerCannotRegrantRolesAfterRotation() public {
        _rotateRolesToProduction();

        AccessControlFacet ac = AccessControlFacet(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(
                LibAccessControl.AccessControlUnauthorizedAccount.selector,
                deployer,
                LibAccessControl.DEFAULT_ADMIN_ROLE
            )
        );
        ac.grantRole(LibAccessControl.ADMIN_ROLE, deployer);
    }

    /// @notice Fuzz: an arbitrary address not wired in the rotation
    ///         must hold no role. Catches accidental grant to a
    ///         placeholder address in a future runbook edit.
    function testFuzzArbitraryAddressHoldsNoRoles(address rando) public {
        vm.assume(rando != governanceMultisig);
        vm.assume(rando != adminTimelock);
        vm.assume(rando != pauserMultisig);

        _rotateRolesToProduction();

        AccessControlFacet ac = AccessControlFacet(address(diamond));
        for (uint256 i = 0; i < ALL_ROLES.length; i++) {
            assertFalse(
                ac.hasRole(ALL_ROLES[i], rando),
                "no stray role grants to arbitrary addresses"
            );
        }
    }
}
