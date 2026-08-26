// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
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

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {GuardianPausable} from "../src/crosschain/GuardianPausable.sol";

/**
 * @title GovernanceHandoverTest
 * @notice End-to-end integration test for the Safe + Timelock + Guardian
 *         handover. Simulates the logical steps the deploy scripts take
 *         (grant ops roles → transfer admin to the timelock → hand the
 *         cross-chain contracts to the timelock → Safe-scheduled
 *         acceptOwnership) against a self-contained minimal Diamond +
 *         cross-chain-contract harness, then asserts every invariant in
 *         `docs/GovernanceRunbook.md`'s readback verification section.
 *
 *         Intended as a pre-mainnet CI gate. Catches any drift in the
 *         migration scripts OR in the facets' role / ownership surface
 *         that would leave residual EOA authority after handover.
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
    CrossChainGuardianHarness internal oappA; // stand-in for a cross-chain contract
    CrossChainGuardianHarness internal oappB; // stand-in for a 2nd cross-chain contract
    OwnableERC20Stub internal vpfiToken; // stand-in for VPFIToken (Ownable2Step)
    // The three authority shapes the runbook's step-6 readbacks must cover and
    // this harness did not (Codex #1941 r4-r6): a target with no guardian, a
    // target whose pending owner CANNOT be read, and the CCT administrator —
    // a separate two-step transfer on a different contract.
    PlainOwnable2StepHarness internal rateGovernor;
    ChainlinkStyleOwnable2StepHarness internal tokenPool;
    TokenAdminRegistryStub internal cctRegistry;

    // ─── Setup ──────────────────────────────────────────────────────────────

    function setUp() public {
        vm.startPrank(deployer);

        // Minimal Diamond — AccessControl + Ownership + Admin is enough
        // for the role + owner surface we care about. Other facets are
        // exercised by their own test suites.
        diamond = _deployMinDiamond();

        // Initialize AccessControl so DEFAULT_ADMIN + ADMIN + PAUSER +
        // ORACLE_ADMIN + RISK_ADMIN + KYC_ADMIN + VAULT_ADMIN all land
        // on the deployer initially (matching the real deploy flow).
        AccessControlFacet(address(diamond)).initializeAccessControl();
        AdminFacet(address(diamond)).unpause();

        // Stand-ins for the cross-chain contracts (CcipMessenger,
        // VaipakamRewardMessenger) — they inherit
        // {GuardianPausable}; the harness isolates that guardian + owner
        // surface — plus an Ownable2Step VPFIToken stand-in.
        oappA = _deployOappHarness(deployer);
        oappB = _deployOappHarness(deployer);
        vpfiToken = new OwnableERC20Stub(deployer);
        rateGovernor = new PlainOwnable2StepHarness(deployer);
        tokenPool = new ChainlinkStyleOwnable2StepHarness(deployer);
        cctRegistry = new TokenAdminRegistryStub();
        cctRegistry.seed(address(vpfiToken), deployer);

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
        // timelock. Includes UNPAUSER_ROLE per the asymmetric
        // pause split — pause stays on the fast-key Pauser Safe, unpause
        // goes to the Timelock so a compromised Pauser cannot un-do its
        // own mistaken pause without the review-window delay.
        bytes32[6] memory timelockRoles = [
            LibAccessControl.DEFAULT_ADMIN_ROLE,
            LibAccessControl.ADMIN_ROLE,
            LibAccessControl.UNPAUSER_ROLE,
            LibAccessControl.ORACLE_ADMIN_ROLE,
            LibAccessControl.RISK_ADMIN_ROLE,
            LibAccessControl.VAULT_ADMIN_ROLE
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
        rateGovernor.transferOwnership(address(timelock));
        tokenPool.transferOwnership(address(timelock));
        cctRegistry.transferAdminRole(address(vpfiToken), address(timelock));
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

    /// @dev The CCT administrator's second leg is `acceptAdminRole(token)` on
    ///      the REGISTRY — a different target and a different selector from
    ///      every `acceptOwnership()` above. Scheduling only the ownership
    ///      accepts leaves the deployer administrator and still able to call
    ///      `setPool` on the live token, which is what the runbook's step 5
    ///      omitted until #1941 r6.
    function _runSafeScheduledAcceptAdminRole(address token) internal {
        bytes memory data = abi.encodeWithSignature("acceptAdminRole(address)", token);
        bytes32 salt = keccak256(abi.encode(address(cctRegistry), token, block.number));

        vm.startPrank(governanceSafe);
        timelock.schedule(address(cctRegistry), 0, data, bytes32(0), salt, 1 hours);
        vm.stopPrank();

        vm.warp(block.timestamp + 1 hours + 1);

        vm.startPrank(governanceSafe);
        timelock.execute(address(cctRegistry), 0, data, bytes32(0), salt);
        vm.stopPrank();
    }

    function _runFullHandover() internal {
        _runGrantOpsRoles();
        _runTransferAdminToTimelock();
        _runMigrateOAppGovernance();
        _runSafeScheduledAcceptOwnership(address(oappA));
        _runSafeScheduledAcceptOwnership(address(oappB));
        _runSafeScheduledAcceptOwnership(address(vpfiToken));
        _runSafeScheduledAcceptOwnership(address(rateGovernor));
        _runSafeScheduledAcceptOwnership(address(tokenPool));
        _runSafeScheduledAcceptAdminRole(address(vpfiToken));
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
        assertTrue(ac.hasRole(LibAccessControl.VAULT_ADMIN_ROLE, address(timelock)));
    }

    function test_Diamond_DeployerHasNoResidualAdminRole() public {
        _runFullHandover();
        AccessControlFacet ac = AccessControlFacet(address(diamond));
        assertFalse(ac.hasRole(LibAccessControl.DEFAULT_ADMIN_ROLE, deployer));
        assertFalse(ac.hasRole(LibAccessControl.ADMIN_ROLE, deployer));
        assertFalse(ac.hasRole(LibAccessControl.ORACLE_ADMIN_ROLE, deployer));
        assertFalse(ac.hasRole(LibAccessControl.RISK_ADMIN_ROLE, deployer));
        assertFalse(ac.hasRole(LibAccessControl.VAULT_ADMIN_ROLE, deployer));
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

    /// @notice Step 6 requires `pendingOwner() == address(0)` on every OZ
    ///         two-step target, not just `owner() == timelock`. A completed
    ///         transfer clears the pending owner, so a NON-ZERO one means a
    ///         handover is still open and that address can `acceptOwnership()`
    ///         at any later moment — holding every setter and the UUPS upgrade
    ///         authority. `owner() == timelock` is true of that state too, which
    ///         is why the owner check alone cannot catch it (Codex #1941 r3).
    function test_EveryOZTarget_HasNoPendingOwner() public {
        _runFullHandover();
        assertEq(oappA.pendingOwner(), address(0), "oappA pending");
        assertEq(oappB.pendingOwner(), address(0), "oappB pending");
        assertEq(vpfiToken.pendingOwner(), address(0), "vpfiToken pending");
        assertEq(rateGovernor.pendingOwner(), address(0), "rateGovernor pending");
    }

    /// @notice The non-guardian target is covered by the SAME assertions. It
    ///         exists because scoping them to "the GuardianPausable contracts"
    ///         exempted the one contract whose owner sets every lane's rate
    ///         limits and authorizes UUPS upgrades (Codex #1941 r4).
    function test_NonGuardianTarget_IsFullyHandedOver() public {
        _runFullHandover();
        assertEq(rateGovernor.owner(), address(timelock), "rateGovernor owner");
        assertEq(rateGovernor.pendingOwner(), address(0), "rateGovernor pending");
    }

    /// @notice A dangling first leg must be VISIBLE. Reverting the accept for
    ///         one target leaves `owner() == timelock` false and the pending
    ///         owner set — the state the gate has to reject rather than accept.
    ///         Without this the pendingOwner assertions above could pass
    ///         vacuously on a harness that never creates a pending owner at all.
    function test_PendingOwner_IsNonZeroBeforeAccept() public {
        _runGrantOpsRoles();
        _runTransferAdminToTimelock();
        _runMigrateOAppGovernance();
        // Deliberately NOT running the accepts.
        assertEq(rateGovernor.pendingOwner(), address(timelock), "pending must be set");
        assertEq(rateGovernor.owner(), deployer, "owner must still be deployer");
    }

    /// @notice The Chainlink-shaped pool has NO `pendingOwner()` getter — its
    ///         `s_pendingOwner` is private — so step 6 establishes its state
    ///         from `owner()` plus the ownership event log instead. Pinning the
    ///         shape here means the gate fails if the runbook is ever
    ///         "simplified" back to a blanket `pendingOwner()` call, which
    ///         reverts on this target (Codex #1941 r5).
    function test_ChainlinkStylePool_HasNoPendingOwnerGetter() public {
        _runFullHandover();
        assertEq(tokenPool.owner(), address(timelock), "pool owner");
        (bool ok, ) = address(tokenPool).staticcall(abi.encodeWithSignature("pendingOwner()"));
        assertFalse(ok, "pool must NOT expose pendingOwner() - the runbook's log path exists for this");
    }

    // ─── The pool's event-log readback (runbook step 6, pool exception) ──────
    //
    // Asserting only that `pendingOwner()` is absent proves the SHAPE and none
    // of the property: `owner() == timelock` with a later transfer pending
    // satisfies both of the assertions above, which is exactly the dangling
    // takeover the log rule exists to reject (Codex #1941 r7). These three
    // exercise the rule itself over its completed, outstanding and cancelled
    // cases.

    bytes32 private constant REQUESTED_TOPIC =
        keccak256("OwnershipTransferRequested(address,address)");
    bytes32 private constant TRANSFERRED_TOPIC =
        keccak256("OwnershipTransferred(address,address)");

    /// @dev The runbook's rule, implemented against recorded logs: take the LAST
    ///      Requested for the pool; it is settled when `to == address(0)` (a
    ///      cancellation, which can never be followed by a Transferred) or when
    ///      a LATER Transferred names the same `to`.
    function _poolHandoverSettled() internal returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 lastRequested = type(uint256).max;
        address pendingTo;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(tokenPool)) continue;
            if (logs[i].topics[0] == REQUESTED_TOPIC) {
                lastRequested = i;
                pendingTo = address(uint160(uint256(logs[i].topics[2])));
            }
        }
        if (lastRequested == type(uint256).max) return true; // never transferred
        if (pendingTo == address(0)) return true; // cancelled — terminal
        for (uint256 i = lastRequested + 1; i < logs.length; i++) {
            if (logs[i].emitter != address(tokenPool)) continue;
            if (
                logs[i].topics[0] == TRANSFERRED_TOPIC
                    && address(uint160(uint256(logs[i].topics[2]))) == pendingTo
            ) return true;
        }
        return false;
    }

    function test_PoolLogRule_CompletedHandoverIsSettled() public {
        vm.recordLogs();
        _runFullHandover();
        assertTrue(_poolHandoverSettled(), "completed handover must read as settled");
    }

    function test_PoolLogRule_OutstandingRequestIsNotSettled() public {
        vm.recordLogs();
        _runFullHandover();
        // The Timelock owns the pool and then proposes it away again. `owner()`
        // is still the timelock and `pendingOwner()` is still unreadable, so
        // every other assertion in this file passes over this state.
        vm.prank(address(timelock));
        tokenPool.transferOwnership(attacker);
        assertEq(tokenPool.owner(), address(timelock), "owner unchanged - why the getter checks miss this");
        assertFalse(_poolHandoverSettled(), "a pending takeover must NOT read as settled");
    }

    /// @notice The ordering half of the rule, which the outstanding-request case
    ///         above does NOT pin: there, no `Transferred` to the pending address
    ///         exists anywhere, so a rule that ignored ordering would still say
    ///         "not settled" and look correct. Mutating the scan to start at
    ///         index 0 survived until this fixture existed.
    ///
    ///         Here ownership genuinely COMPLETED to `attacker` once, came back,
    ///         and is then re-proposed to `attacker` and left pending — so an
    ///         earlier matching `Transferred` exists and must not be read as
    ///         discharging the later request. A re-run handover that proposes to
    ///         an address it previously transferred to is the realistic shape.
    function test_PoolLogRule_EarlierTransferDoesNotSettleALaterRequest() public {
        vm.recordLogs();
        _runFullHandover();

        vm.prank(address(timelock));
        tokenPool.transferOwnership(attacker);
        vm.prank(attacker);
        tokenPool.acceptOwnership(); // Transferred(-> attacker) is now in the log

        vm.prank(attacker);
        tokenPool.transferOwnership(address(timelock));
        vm.prank(address(timelock));
        tokenPool.acceptOwnership();

        // Re-proposed to the SAME address that has a completed transfer earlier.
        vm.prank(address(timelock));
        tokenPool.transferOwnership(attacker);

        assertEq(tokenPool.owner(), address(timelock), "owner still timelock");
        assertFalse(
            _poolHandoverSettled(),
            "an earlier completed transfer to the same address must not settle a later request"
        );
    }

    function test_PoolLogRule_ZeroAddressRequestIsCancellation() public {
        vm.recordLogs();
        _runFullHandover();
        vm.prank(address(timelock));
        tokenPool.transferOwnership(attacker); // dangling
        vm.prank(address(timelock));
        tokenPool.transferOwnership(address(0)); // cancelled
        assertTrue(
            _poolHandoverSettled(),
            "a cancellation is terminal - requiring a matching Transferred would fail a safe state"
        );
    }

    /// @notice The CCT administrator is a SEPARATE two-step transfer on a
    ///         different contract with a different accept selector. Miss its
    ///         second leg and the deployer stays administrator and can still
    ///         call `setPool` on the live token, while every ownership readback
    ///         passes (Codex #1941 r5/r6).
    function test_CctAdministrator_IsTimelockWithNothingPending() public {
        _runFullHandover();
        TokenAdminRegistryStub.TokenConfig memory cfg = cctRegistry.getTokenConfig(address(vpfiToken));
        assertEq(cfg.administrator, address(timelock), "cct administrator");
        assertEq(cfg.pendingAdministrator, address(0), "cct pending administrator");
    }

    /// @notice And the same state before the accept, so the assertion above is
    ///         known to be capable of failing rather than passing on a registry
    ///         that was never transferred.
    function test_CctAdministrator_IsPendingBeforeAccept() public {
        _runGrantOpsRoles();
        _runTransferAdminToTimelock();
        _runMigrateOAppGovernance();
        TokenAdminRegistryStub.TokenConfig memory cfg = cctRegistry.getTokenConfig(address(vpfiToken));
        assertEq(cfg.administrator, deployer, "administrator still deployer");
        assertEq(cfg.pendingAdministrator, address(timelock), "timelock pending");
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

    function _deployOappHarness(
        address owner_
    ) internal returns (CrossChainGuardianHarness proxy) {
        CrossChainGuardianHarness impl = new CrossChainGuardianHarness();
        ERC1967Proxy p = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(CrossChainGuardianHarness.initialize, (owner_))
        );
        return CrossChainGuardianHarness(address(p));
    }
}

/**
 * @dev Minimal UUPS contract that mixes in {GuardianPausable} — the same
 *      guardian + Ownable2Step surface every Vaipakam cross-chain contract
 *      (CcipMessenger, VaipakamRewardMessenger) carries. Used as their stand-in for the
 *      handover invariant checks.
 */
contract CrossChainGuardianHarness is
    Initializable,
    Ownable2StepUpgradeable,
    GuardianPausable,
    UUPSUpgradeable
{
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        __Ownable_init(owner_);
        __Ownable2Step_init();
        _guardianPausableInit();
    }

    function pause() external onlyGuardianOrOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function transferOwnership(
        address newOwner
    ) public override(OwnableUpgradeable, Ownable2StepUpgradeable) onlyOwner {
        Ownable2StepUpgradeable.transferOwnership(newOwner);
    }

    function _transferOwnership(
        address newOwner
    ) internal override(OwnableUpgradeable, Ownable2StepUpgradeable) {
        Ownable2StepUpgradeable._transferOwnership(newOwner);
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

/**
 * @dev A handover target with NO guardian — `VpfiPoolRateGovernor`'s shape.
 *      It exists because scoping the ownership assertions to "the
 *      GuardianPausable contracts" silently exempted the one contract whose
 *      owner sets every lane's rate limits and authorizes UUPS upgrades
 *      (Codex #1941 r4). Without a non-guardian target in this harness, that
 *      scoping bug passes the gate.
 */
contract PlainOwnable2StepHarness is Ownable2StepUpgradeable {
    constructor(address owner_) {
        _transferOwnership(owner_);
    }
}

/**
 * @dev CHAINLINK's two-step ownership shape, which the CCIP `TokenPool` uses
 *      via `Ownable2StepMsgSender`: the pending owner is PRIVATE and there is
 *      no `pendingOwner()` getter, so an OZ-style readback REVERTS on it and
 *      the state is only observable from the events (Codex #1941 r5).
 *
 *      Deliberately a re-implementation rather than an import: the point is to
 *      pin the SHAPE the runbook must cope with — a target whose pending owner
 *      cannot be read — so the gate fails if someone "simplifies" the runbook
 *      back to a blanket `pendingOwner()` call.
 */
contract ChainlinkStyleOwnable2StepHarness {
    address private s_owner;
    address private s_pendingOwner;

    event OwnershipTransferRequested(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error MustBeProposedOwner();
    error OnlyCallableByOwner();
    error CannotTransferToSelf();

    constructor(address owner_) {
        s_owner = owner_;
    }

    function owner() external view returns (address) {
        return s_owner;
    }

    function transferOwnership(address to) external {
        if (msg.sender != s_owner) revert OnlyCallableByOwner();
        if (to == msg.sender) revert CannotTransferToSelf();
        // NOTE: zero is PERMITTED — that is how an outstanding transfer is
        // cancelled, and it emits a Requested event that can never be
        // followed by a Transferred.
        s_pendingOwner = to;
        emit OwnershipTransferRequested(s_owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != s_pendingOwner) revert MustBeProposedOwner();
        address old = s_owner;
        s_owner = msg.sender;
        s_pendingOwner = address(0);
        emit OwnershipTransferred(old, msg.sender);
    }
}

/**
 * @dev The CCIP `TokenAdminRegistry` administrator surface. A SEPARATE
 *      two-step transfer from any ownership handover, with its own accept
 *      function on a different contract — which is exactly why it was missed
 *      (Codex #1941 r5/r6).
 */
contract TokenAdminRegistryStub {
    struct TokenConfig {
        address administrator;
        address pendingAdministrator;
    }

    mapping(address => TokenConfig) private configs;

    error OnlyAdministrator();
    error OnlyPendingAdministrator();

    function seed(address token, address administrator_) external {
        configs[token].administrator = administrator_;
    }

    function getTokenConfig(address token) external view returns (TokenConfig memory) {
        return configs[token];
    }

    function transferAdminRole(address token, address to) external {
        if (msg.sender != configs[token].administrator) revert OnlyAdministrator();
        configs[token].pendingAdministrator = to;
    }

    function acceptAdminRole(address token) external {
        if (msg.sender != configs[token].pendingAdministrator) revert OnlyPendingAdministrator();
        configs[token].administrator = msg.sender;
        configs[token].pendingAdministrator = address(0);
    }
}
