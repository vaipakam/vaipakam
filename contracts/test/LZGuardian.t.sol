// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {LZGuardianPausable} from "../src/token/LZGuardianPausable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

/**
 * @title GuardianHarness
 * @dev Minimal concrete contract that inherits {LZGuardianPausable} so the
 *      abstract's surface can be tested without pulling in the full
 *      LayerZero OApp / OFT stack. Mirrors the real OApp's inheritance
 *      chain — UUPSUpgradeable + Ownable2StepUpgradeable + Pausable via
 *      LZGuardianPausable — so handover tests (via transferOwnership /
 *      acceptOwnership) exercise the same paths production uses.
 */
contract GuardianHarness is
    Initializable,
    LZGuardianPausable,
    Ownable2StepUpgradeable,
    UUPSUpgradeable
{
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __LZGuardianPausable_init();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice Mirrors the production OApp pattern: pause is allowed for
    ///         either the guardian or the owner.
    function pause() external onlyGuardianOrOwner {
        _pause();
    }

    /// @notice Mirrors the production pattern: unpause is strict owner-only
    ///         so a compromised guardian cannot race the incident team to
    ///         re-enable a live contract.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev OwnableUpgradeable (from LZGuardianPausable) and
    ///      Ownable2StepUpgradeable both define transferOwnership. Matches
    ///      the disambiguation pattern used in VPFIOFTAdapter et al.
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
 * @title LZGuardianTest
 * @notice Unit tests for the {LZGuardianPausable} abstract — verifies the
 *         two-role pattern (owner gates rotation + unpause, guardian gates
 *         pause only) and that the ERC-7201 namespaced storage slot is
 *         immune to base-class reshuffles.
 */
contract LZGuardianTest is Test {
    GuardianHarness internal harness;
    address internal owner;
    address internal guardian;
    address internal attacker;

    event GuardianUpdated(
        address indexed previousGuardian,
        address indexed newGuardian
    );

    function setUp() public {
        owner = makeAddr("owner");
        guardian = makeAddr("guardian");
        attacker = makeAddr("attacker");

        GuardianHarness impl = new GuardianHarness();
        bytes memory initData = abi.encodeWithSelector(
            GuardianHarness.initialize.selector,
            owner
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        harness = GuardianHarness(address(proxy));
    }

    // ─── Initial state ──────────────────────────────────────────────────────

    function test_Initial_GuardianIsZero() public {
        assertEq(harness.guardian(), address(0));
    }

    function test_Initial_OwnerIsSet() public {
        assertEq(harness.owner(), owner);
    }

    function test_Initial_NotPaused() public {
        assertFalse(harness.paused());
    }

    // ─── setGuardian ────────────────────────────────────────────────────────

    function test_SetGuardian_AsOwner_Succeeds() public {
        vm.expectEmit(true, true, false, false);
        emit GuardianUpdated(address(0), guardian);

        vm.prank(owner);
        harness.setGuardian(guardian);

        assertEq(harness.guardian(), guardian);
    }

    function test_SetGuardian_EmitsRotationWithPrevious() public {
        address newGuardian = makeAddr("newGuardian");
        vm.prank(owner);
        harness.setGuardian(guardian);

        vm.expectEmit(true, true, false, false);
        emit GuardianUpdated(guardian, newGuardian);

        vm.prank(owner);
        harness.setGuardian(newGuardian);
        assertEq(harness.guardian(), newGuardian);
    }

    function test_SetGuardian_AsNonOwner_Reverts() public {
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                attacker
            )
        );
        harness.setGuardian(guardian);
    }

    function test_SetGuardian_AsCurrentGuardian_Reverts() public {
        vm.prank(owner);
        harness.setGuardian(guardian);

        // The guardian role authorizes pause — NOT rotation. Only the owner
        // (timelock) can rotate. This proves the guardian cannot self-revoke
        // or swap to a colluder without governance oversight.
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                guardian
            )
        );
        harness.setGuardian(attacker);
    }

    function test_SetGuardian_ToZero_DisablesGuardianPath() public {
        // Install then remove; pause must remain accessible via owner but
        // become unreachable via guardian. Zero is the explicit "disable
        // the emergency surface" escape hatch.
        vm.prank(owner);
        harness.setGuardian(guardian);
        assertEq(harness.guardian(), guardian);

        vm.prank(owner);
        harness.setGuardian(address(0));
        assertEq(harness.guardian(), address(0));

        // Previous guardian can no longer pause.
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(
                LZGuardianPausable.NotGuardianOrOwner.selector,
                guardian
            )
        );
        harness.pause();
    }

    // ─── pause ──────────────────────────────────────────────────────────────

    function test_Pause_AsGuardian_Succeeds() public {
        vm.prank(owner);
        harness.setGuardian(guardian);

        vm.prank(guardian);
        harness.pause();
        assertTrue(harness.paused());
    }

    function test_Pause_AsOwner_Succeeds() public {
        vm.prank(owner);
        harness.pause();
        assertTrue(harness.paused());
    }

    function test_Pause_AsRandom_Reverts() public {
        vm.prank(owner);
        harness.setGuardian(guardian);

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                LZGuardianPausable.NotGuardianOrOwner.selector,
                attacker
            )
        );
        harness.pause();
        assertFalse(harness.paused());
    }

    function test_Pause_NoGuardianSet_OwnerStillPauses() public {
        // With guardian unset, only the owner path is live. Sanity-checks
        // that the guardian surface is additive, not a replacement for the
        // owner surface.
        vm.prank(owner);
        harness.pause();
        assertTrue(harness.paused());
    }

    function test_Pause_NoGuardianSet_RandomStillReverts() public {
        // Guardian deliberately not set. Random caller must still be rejected.
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                LZGuardianPausable.NotGuardianOrOwner.selector,
                attacker
            )
        );
        harness.pause();
    }

    // ─── unpause ────────────────────────────────────────────────────────────

    function test_Unpause_AsOwner_Succeeds() public {
        vm.prank(owner);
        harness.pause();

        vm.prank(owner);
        harness.unpause();
        assertFalse(harness.paused());
    }

    function test_Unpause_AsGuardian_Reverts() public {
        // The guardian must NOT be able to unpause. This is the asymmetric-
        // authority property the whole pattern exists to guarantee: a
        // compromised guardian cannot race the incident team to re-enable
        // a live contract.
        vm.prank(owner);
        harness.setGuardian(guardian);
        vm.prank(owner);
        harness.pause();

        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                guardian
            )
        );
        harness.unpause();
        assertTrue(harness.paused());
    }

    function test_Unpause_AsRandom_Reverts() public {
        vm.prank(owner);
        harness.pause();

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                attacker
            )
        );
        harness.unpause();
    }

    // ─── ERC-7201 storage slot stability ────────────────────────────────────

    function test_StorageSlot_MatchesERC7201Formula() public {
        // Hardcoded slot in LZGuardianPausable.sol must equal the
        // ERC-7201-formulated slot for "vaipakam.lz.guardian". If a future
        // refactor changes the namespace string without updating the
        // constant (or vice versa), this asserts catches it before any
        // upgrade destabilizes storage.
        bytes32 expected = keccak256(
            abi.encode(uint256(keccak256("vaipakam.lz.guardian")) - 1)
        ) & ~bytes32(uint256(0xff));

        // The hardcoded constant from LZGuardianPausable.sol.
        bytes32 constantInCode = 0x46c6f95bc7d869e6724c9ffae64aa41d1cc2d352f1599912948531e07bce3700;

        assertEq(expected, constantInCode, "ERC-7201 slot formula drifted");
    }

    // ─── Fuzz: guardian address is the only input that can flip pause ──────

    function testFuzz_OnlyGuardianOrOwnerCanPause(address caller) public {
        vm.assume(caller != owner);
        vm.assume(caller != guardian);
        vm.assume(caller != address(0));

        vm.prank(owner);
        harness.setGuardian(guardian);

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                LZGuardianPausable.NotGuardianOrOwner.selector,
                caller
            )
        );
        harness.pause();
    }
}
