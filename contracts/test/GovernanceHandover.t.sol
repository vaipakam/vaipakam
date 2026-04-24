// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC173} from "@diamond-3/interfaces/IERC173.sol";

import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {OwnershipFacet} from "../src/facets/OwnershipFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {HelperTest} from "./HelperTest.sol";

import {LZGuardianPausable} from "../src/token/LZGuardianPausable.sol";
import {GuardianHarness} from "./LZGuardian.t.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";

/**
 * @title GovernanceHandoverTest
 * @notice End-to-end integration test for the Safe + Timelock + Guardian
 *         handover. Simulates the logical steps the deploy scripts take
 *         (GrantOpsRoles → TransferAdminToTimelock → MigrateOAppGovernance
 *         → Safe-scheduled acceptOwnership) against a self-contained
 *         minimal Diamond + OApp harness, then asserts every invariant
 *         listed in `docs/GovernanceRunbook.md`'s readback verification
 *         section.
 *
 *         Intended to run as a pre-mainnet CI gate alongside
 *         `LZConfig.t.sol`. Catches any drift in the migration scripts
 *         OR in the facets' role / ownership surface that would leave
 *         residual EOA authority after handover.
 */
contract GovernanceHandoverTest is Test {
    // ─── Actors ─────────────────────────────────────────────────────────────
    address internal deployer = makeAddr("deployer");
    address internal governanceSafe = makeAddr("governanceSafe");
    address internal guardianSafe = makeAddr("guardianSafe");
    address internal kycOpsSafe = makeAddr("kycOpsSafe");
    address internal attacker = makeAddr("attacker");

    // ─── Contracts ──────────────────────────────────────────────────────────
    VaipakamDiamond internal diamond;
    TimelockController internal timelock;
    GuardianHarness internal oappA; // stand-in for VPFIOFTAdapter / RewardOApp
    GuardianHarness internal oappB; // stand-in for a second OApp on the chain
    OwnableERC20Stub internal vpfiToken; // stand-in for VPFIToken (Ownable2Step)

    // ─── Setup ──────────────────────────────────────────────────────────────

    function setUp() public {
        vm.startPrank(deployer);

        // Minimal Diamond — AccessControl + Ownership + Admin is enough
        // for the role + owner surface we care about. Other facets are
        // exercised by their own test suites.
        diamond = _deployMinDiamond();

        // Initialize AccessControl so DEFAULT_ADMIN + ADMIN + PAUSER +
        // ORACLE_ADMIN + RISK_ADMIN + KYC_ADMIN + ESCROW_ADMIN all land
        // on the deployer initially (matching the real deploy flow).
        AccessControlFacet(address(diamond)).initializeAccessControl();

        // Ownable2Step stand-ins for the LZ OApps + VPFIToken. Real
        // OApps would inherit LZGuardianPausable via OAppUpgradeable;
        // GuardianHarness isolates the guardian-pause surface.
        oappA = _deployOappHarness(deployer);
        oappB = _deployOappHarness(deployer);
        vpfiToken = new OwnableERC20Stub(deployer);

        // Timelock with Safe as proposer + executor. Minimum delay 1h
        // compressed from the 48h production default so the test doesn't
        // waste wall-clock — the invariant we're validating is the same
        // shape, just faster.
        address[] memory proposers = new address[](1);
        proposers[0] = governanceSafe;
        address[] memory executors = new address[](1);
        executors[0] = governanceSafe;
        timelock = new TimelockController(
            1 hours,
            proposers,
            executors,
            address(0) // self-administered
        );

        vm.stopPrank();
    }

    // ─── Migration simulation (mirrors the three deploy scripts) ────────────

    function _runGrantOpsRoles() internal {
        vm.startPrank(deployer);
        AccessControlFacet ac = AccessControlFacet(address(diamond));
        if (!ac.hasRole(LibAccessControl.PAUSER_ROLE, guardianSafe)) {
            ac.grantRole(LibAccessControl.PAUSER_ROLE, guardianSafe);
        }
        if (!ac.hasRole(LibAccessControl.KYC_ADMIN_ROLE, kycOpsSafe)) {
            ac.grantRole(LibAccessControl.KYC_ADMIN_ROLE, kycOpsSafe);
        }
        vm.stopPrank();
    }

    function _runTransferAdminToTimelock() internal {
        vm.startPrank(deployer);
        AccessControlFacet ac = AccessControlFacet(address(diamond));

        // Timelock-gated roles: slow governance surfaces that move TO the
        // timelock. Mirrors the list in TransferAdminToTimelock.s.sol.
        bytes32[5] memory timelockRoles = [
            LibAccessControl.DEFAULT_ADMIN_ROLE,
            LibAccessControl.ADMIN_ROLE,
            LibAccessControl.ORACLE_ADMIN_ROLE,
            LibAccessControl.RISK_ADMIN_ROLE,
            LibAccessControl.ESCROW_ADMIN_ROLE
        ];
        for (uint256 i; i < timelockRoles.length; ++i) {
            if (!ac.hasRole(timelockRoles[i], address(timelock))) {
                ac.grantRole(timelockRoles[i], address(timelock));
            }
        }

        IERC173(address(diamond)).transferOwnership(address(timelock));

        // Ops roles: don't migrate to timelock, but MUST still be renounced
        // off the deployer EOA — otherwise a hot deploy wallet retains
        // PAUSER + KYC_ADMIN post-handover. Relies on _runGrantOpsRoles
        // having already seeded guardian / kycOps as holders so the
        // renounce doesn't strand the role.
        bytes32[2] memory opsRoles = [
            LibAccessControl.PAUSER_ROLE,
            LibAccessControl.KYC_ADMIN_ROLE
        ];
        for (uint256 i; i < opsRoles.length; ++i) {
            if (ac.hasRole(opsRoles[i], deployer)) {
                ac.renounceRole(opsRoles[i], deployer);
            }
        }

        // Then timelock-role renounces, DEFAULT_ADMIN last so any revert
        // above leaves the deployer able to retry.
        for (uint256 i = timelockRoles.length; i > 0; --i) {
            bytes32 role = timelockRoles[i - 1];
            if (ac.hasRole(role, deployer)) {
                ac.renounceRole(role, deployer);
            }
        }
        vm.stopPrank();
    }

    function _runMigrateOAppGovernance() internal {
        vm.startPrank(deployer);
        oappA.setGuardian(guardianSafe);
        oappA.transferOwnership(address(timelock));
        oappB.setGuardian(guardianSafe);
        oappB.transferOwnership(address(timelock));
        vpfiToken.transferOwnership(address(timelock));
        vm.stopPrank();
    }

    function _runSafeScheduledAcceptOwnership(address target) internal {
        bytes memory data = abi.encodeWithSignature("acceptOwnership()");
        bytes32 salt = keccak256(abi.encode(target, block.number));

        vm.startPrank(governanceSafe);
        timelock.schedule(target, 0, data, bytes32(0), salt, 1 hours);
        vm.stopPrank();

        // Wait past the delay.
        vm.warp(block.timestamp + 1 hours + 1);

        vm.startPrank(governanceSafe);
        timelock.execute(target, 0, data, bytes32(0), salt);
        vm.stopPrank();
    }

    function _runFullHandover() internal {
        _runGrantOpsRoles();
        _runTransferAdminToTimelock();
        _runMigrateOAppGovernance();
        _runSafeScheduledAcceptOwnership(address(oappA));
        _runSafeScheduledAcceptOwnership(address(oappB));
        _runSafeScheduledAcceptOwnership(address(vpfiToken));
    }

    // ─── Readback invariants (match GovernanceRunbook.md step 6) ────────────

    function test_Diamond_OwnerIsTimelock() public {
        _runFullHandover();
        assertEq(IERC173(address(diamond)).owner(), address(timelock));
    }

    function test_Diamond_TimelockHoldsAllAdminRoles() public {
        _runFullHandover();
        AccessControlFacet ac = AccessControlFacet(address(diamond));
        assertTrue(ac.hasRole(LibAccessControl.DEFAULT_ADMIN_ROLE, address(timelock)));
        assertTrue(ac.hasRole(LibAccessControl.ADMIN_ROLE, address(timelock)));
        assertTrue(ac.hasRole(LibAccessControl.ORACLE_ADMIN_ROLE, address(timelock)));
        assertTrue(ac.hasRole(LibAccessControl.RISK_ADMIN_ROLE, address(timelock)));
        assertTrue(ac.hasRole(LibAccessControl.ESCROW_ADMIN_ROLE, address(timelock)));
    }

    function test_Diamond_DeployerHasNoResidualAdminRole() public {
        _runFullHandover();
        AccessControlFacet ac = AccessControlFacet(address(diamond));
        assertFalse(ac.hasRole(LibAccessControl.DEFAULT_ADMIN_ROLE, deployer));
        assertFalse(ac.hasRole(LibAccessControl.ADMIN_ROLE, deployer));
        assertFalse(ac.hasRole(LibAccessControl.ORACLE_ADMIN_ROLE, deployer));
        assertFalse(ac.hasRole(LibAccessControl.RISK_ADMIN_ROLE, deployer));
        assertFalse(ac.hasRole(LibAccessControl.ESCROW_ADMIN_ROLE, deployer));
        assertFalse(ac.hasRole(LibAccessControl.PAUSER_ROLE, deployer));
        assertFalse(ac.hasRole(LibAccessControl.KYC_ADMIN_ROLE, deployer));
    }

    function test_Diamond_GuardianHoldsPauserRole() public {
        _runFullHandover();
        AccessControlFacet ac = AccessControlFacet(address(diamond));
        assertTrue(ac.hasRole(LibAccessControl.PAUSER_ROLE, guardianSafe));
        // Guardian must NOT hold the broader admin keys.
        assertFalse(ac.hasRole(LibAccessControl.DEFAULT_ADMIN_ROLE, guardianSafe));
        assertFalse(ac.hasRole(LibAccessControl.ADMIN_ROLE, guardianSafe));
    }

    function test_Diamond_KycOpsHoldsKycAdminRole() public {
        _runFullHandover();
        AccessControlFacet ac = AccessControlFacet(address(diamond));
        assertTrue(ac.hasRole(LibAccessControl.KYC_ADMIN_ROLE, kycOpsSafe));
    }

    function test_OApp_OwnerIsTimelock() public {
        _runFullHandover();
        assertEq(oappA.owner(), address(timelock));
        assertEq(oappB.owner(), address(timelock));
    }

    function test_OApp_GuardianIsGuardianSafe() public {
        _runFullHandover();
        assertEq(oappA.guardian(), guardianSafe);
        assertEq(oappB.guardian(), guardianSafe);
    }

    function test_VPFIToken_OwnerIsTimelock() public {
        _runFullHandover();
        assertEq(vpfiToken.owner(), address(timelock));
    }

    // ─── Authority rejection — the other side of "access was transferred" ──

    function test_DeployerEOA_CannotCallAdminFunction() public {
        _runFullHandover();
        // pause() is PAUSER_ROLE-gated. After handover, the deployer has
        // no role on the Diamond; any admin call must revert.
        vm.prank(deployer);
        vm.expectRevert();
        AdminFacet(address(diamond)).pause();
    }

    function test_DeployerEOA_CannotTransferOwnership() public {
        _runFullHandover();
        vm.prank(deployer);
        vm.expectRevert();
        IERC173(address(diamond)).transferOwnership(attacker);
    }

    function test_Guardian_CanPauseEachOApp_WithoutTimelock() public {
        _runFullHandover();
        // Guardian pauses both OApps without waiting 1h — the whole point
        // of the separate guardian surface.
        vm.prank(guardianSafe);
        oappA.pause();
        assertTrue(oappA.paused());

        vm.prank(guardianSafe);
        oappB.pause();
        assertTrue(oappB.paused());
    }

    function test_Guardian_CannotUnpauseOApp() public {
        _runFullHandover();
        vm.prank(guardianSafe);
        oappA.pause();

        // Only the owner (timelock, via 48h-gated schedule) can unpause.
        vm.prank(guardianSafe);
        vm.expectRevert();
        oappA.unpause();
        assertTrue(oappA.paused());
    }

    function test_Attacker_CannotAnyAdminSurface() public {
        _runFullHandover();

        vm.startPrank(attacker);
        vm.expectRevert();
        AdminFacet(address(diamond)).pause();

        vm.expectRevert();
        IERC173(address(diamond)).transferOwnership(attacker);

        vm.expectRevert();
        oappA.setGuardian(attacker);

        vm.expectRevert();
        oappA.pause();

        vm.expectRevert();
        vpfiToken.transferOwnership(attacker);
        vm.stopPrank();
    }

    // ─── Idempotency — running scripts twice must not break state ──────────

    function test_Idempotent_GrantOpsRoles() public {
        _runGrantOpsRoles();
        _runGrantOpsRoles();
        AccessControlFacet ac = AccessControlFacet(address(diamond));
        assertTrue(ac.hasRole(LibAccessControl.PAUSER_ROLE, guardianSafe));
        assertTrue(ac.hasRole(LibAccessControl.KYC_ADMIN_ROLE, kycOpsSafe));
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    function _deployMinDiamond() internal returns (VaipakamDiamond d) {
        DiamondCutFacet cutFacet = new DiamondCutFacet();
        d = new VaipakamDiamond(deployer, address(cutFacet));

        HelperTest h = new HelperTest();
        OwnershipFacet ownershipFacet = new OwnershipFacet();
        AccessControlFacet acFacet = new AccessControlFacet();
        AdminFacet adminFacet = new AdminFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](3);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(ownershipFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: h.getOwnershipFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(acFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: h.getAccessControlFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(adminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: h.getAdminFacetSelectors()
        });
        IDiamondCut(address(d)).diamondCut(cuts, address(0), "");
    }

    function _deployOappHarness(address owner_) internal returns (GuardianHarness proxy) {
        GuardianHarness impl = new GuardianHarness();
        bytes memory initData = abi.encodeWithSelector(
            GuardianHarness.initialize.selector,
            owner_
        );
        ERC1967Proxy p = new ERC1967Proxy(address(impl), initData);
        return GuardianHarness(address(p));
    }
}

/**
 * @dev Minimal Ownable2Step contract used as a VPFIToken stand-in for the
 *      handover test. Exposes the same two-step ownership surface the real
 *      token uses, without pulling in the full ERC20 / OFT / UUPS stack.
 */
contract OwnableERC20Stub is Ownable2StepUpgradeable {
    constructor(address owner_) {
        // Direct storage init — we're not behind a proxy, so the
        // upgradeable initializers are overkill. The Ownable2Step
        // transfer/accept semantics still work against this direct-
        // initialized owner.
        _transferOwnership(owner_);
    }
}
