// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaultBeacon} from "../../src/VaultBeacon.sol";

/// @dev Halmos's symbolic-value cheatcodes (selectors from halmos 0.3).
interface ISvm {
    function createUint256(string calldata name) external returns (uint256);
    function createAddress(string calldata name) external returns (address);
    function createBool(string calldata name) external returns (bool);
    function createCalldata(string calldata contractName) external returns (bytes memory);
}

contract FormalBeaconImpl {
    function vaultLayoutId() external pure returns (bytes32) {
        return keccak256("vaipakam.vault.layout.v1");
    }
}

contract FormalBeaconDiamond {
    bool public paused;

    function setPaused(bool p) external {
        paused = p;
    }
}

contract FormalBeaconVault {
    address public immutable vaultOwner;

    constructor(address o) {
        vaultOwner = o;
    }
}

/**
 * @title  VaultBeaconHalmos
 * @notice Symbolic proofs of the #3436 VaultBeacon properties, run by Halmos
 *         (`bash contracts/script/halmos-beacon.sh`; see
 *         `docs/DesignsAndPlans/VaultBeaconVerification.md`). Each `check_`
 *         takes ONE arbitrary call to the beacon (any function, any arguments,
 *         any sender, any time after setUp) from a state chosen to make the
 *         property bite, and proves the property for every such call. Forge
 *         skips `check_` functions; the stateful fuzz suite in
 *         `test/invariants/VaultBeacon.invariant.t.sol` covers sequences.
 *         The file is not named `.t.sol`: forge never runs it, and
 *         `contracts/script/halmos-beacon.sh` builds it in a small project of
 *         its own.
 */
contract VaultBeaconHalmos is Test {
    ISvm internal constant svm = ISvm(address(uint160(uint256(keccak256("svm cheat code")))));

    VaultBeacon internal beacon;
    FormalBeaconDiamond internal diamond;
    FormalBeaconVault internal vault;
    address internal constant OWNER = address(0x7111);
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant VAULT_OWNER = address(0xA11CE);
    uint256 internal constant T0 = 1_000_000;

    function setUp() public {
        vm.warp(T0);
        diamond = new FormalBeaconDiamond();
        beacon = new VaultBeacon(OWNER, address(diamond), GUARDIAN, address(new FormalBeaconImpl()));
        vault = new FormalBeaconVault(VAULT_OWNER);
        vm.startPrank(OWNER);
        beacon.registerVersion(address(new FormalBeaconImpl())); // 2
        beacon.registerVersion(address(new FormalBeaconImpl())); // 3
        vm.stopPrank();
    }

    /// One arbitrary call: any sender, any calldata, any later time, paused or not.
    function _anyCall() internal {
        uint256 dt = svm.createUint256("dt");
        vm.assume(dt <= 365 days);
        vm.warp(block.timestamp + dt);
        diamond.setPaused(svm.createBool("paused"));
        address sender = svm.createAddress("sender");
        // No transaction has address(0) as its sender. Without this, Halmos
        // reports OZ's acceptOwnership by the empty pending owner, which no
        // real call can make.
        vm.assume(sender != address(0));
        bytes memory data = svm.createCalldata("VaultBeacon");
        vm.prank(sender);
        (bool ok,) = address(beacon).call(data);
        vm.assume(ok); // a reverted call changes nothing
    }

    /// 1. No version becomes current before a code delay after registration,
    ///    on any route, from a state where the guardian can act at once.
    function check_1_noFreshCodeBecomesCurrent() public {
        _anyCall();
        uint256 cur = beacon.currentVersionId();
        if (cur != 1) assert(block.timestamp >= beacon.versionUsableAt(cur));
    }

    /// 1b. The same from a state with a matured proposal waiting.
    function check_1b_noFreshCodeBecomesCurrent_afterAProposal() public {
        vm.prank(OWNER);
        beacon.proposeCurrentVersion(3);
        _anyCall();
        uint256 cur = beacon.currentVersionId();
        if (cur != 1) assert(block.timestamp >= beacon.versionUsableAt(cur));
    }

    /// 2. The current version is always live.
    function check_2_currentIsLive() public {
        _anyCall();
        (, VaultBeacon.VersionStatus st) = beacon.versionOf(beacon.currentVersionId());
        assert(st == VaultBeacon.VersionStatus.Registered);
    }

    /// 3. A vault's pin, pin delay and nonce move only through a call that
    ///    consumed exactly one nonce (an owner signature), or a matured
    ///    request the owner signed earlier (none is pending here).
    function check_3_pinMovesOnlyWithTheOwnerSignature() public {
        uint256 pinBefore = beacon.pinnedVersion(address(vault));
        uint256 delayBefore = beacon.pinDelay(address(vault));
        uint256 nonceBefore = beacon.nonces(address(vault));
        address sender = svm.createAddress("sender");
        // No transaction has address(0) as its sender. Without this, Halmos
        // reports OZ's acceptOwnership by the empty pending owner, which no
        // real call can make.
        vm.assume(sender != address(0));
        bytes memory data = svm.createCalldata("VaultBeacon");
        vm.prank(sender);
        (bool ok,) = address(beacon).call(data);
        vm.assume(ok);
        uint256 nonceAfter = beacon.nonces(address(vault));
        assert(nonceAfter == nonceBefore || nonceAfter == nonceBefore + 1);
        if (beacon.pinnedVersion(address(vault)) != pinBefore) assert(nonceAfter == nonceBefore + 1);
        // The Diamond's raise is the one signature-free change, and it is capped.
        if (beacon.pinDelay(address(vault)) != delayBefore && nonceAfter == nonceBefore) {
            assert(sender == address(diamond));
            assert(beacon.pinDelay(address(vault)) <= beacon.MAX_DIAMOND_PIN_DELAY());
        }
    }

    /// 4. A pin requested with a code proposal always executes first.
    function check_4_diamondCapBelowCodeDelay() public view {
        assert(beacon.MAX_DIAMOND_PIN_DELAY() < beacon.MIN_CODE_DELAY());
    }

    /// 5. Neither the Diamond nor a non-privileged sender moves the current version.
    function check_5_onlyOwnerPathsMoveCurrent() public {
        vm.prank(OWNER);
        beacon.proposeCurrentVersion(3);
        address sender = svm.createAddress("sender");
        // No transaction has address(0) as its sender. Without this, Halmos
        // reports OZ's acceptOwnership by the empty pending owner, which no
        // real call can make.
        vm.assume(sender != address(0));
        vm.assume(sender != GUARDIAN);
        uint256 dt = svm.createUint256("dt");
        vm.assume(dt <= 365 days);
        vm.warp(block.timestamp + dt);
        bytes memory data = svm.createCalldata("VaultBeacon");
        vm.prank(sender);
        (bool ok,) = address(beacon).call(data);
        vm.assume(ok);
        // Only the matured proposal the owner made may move it.
        uint256 cur = beacon.currentVersionId();
        assert(cur == 1 || (cur == 3 && block.timestamp >= T0 + beacon.MIN_CODE_DELAY()));
    }

    /// 6. Revocation is final, and ownership is never renounced.
    function check_6_revokeFinal_ownerKept() public {
        diamond.setPaused(true);
        vm.warp(T0 + 7 days);
        vm.prank(GUARDIAN);
        beacon.guardianRevokeVersion(2, 0);
        _anyCall();
        (, VaultBeacon.VersionStatus st) = beacon.versionOf(2);
        assert(st == VaultBeacon.VersionStatus.Revoked);
        assert(beacon.owner() != address(0));
    }
}
