// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {VaultProtection} from "../../src/vault/VaultProtection.sol";
import {VaultProtectionBase} from "../../src/vault/VaultProtectionBase.sol";
import {VaultRecovery} from "../../src/vault/VaultRecovery.sol";
import {VaipakamVaultImplementation} from "../../src/VaipakamVaultImplementation.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {ProtectedAccountFacet} from "../../src/facets/ProtectedAccountFacet.sol";

/**
 * @title  LibTestProtection
 * @notice #3379 B2 — drive a vault's protected mode the way a key holder does:
 *         a DIRECT call from the key to `vault.protect(...)` (no signature),
 *         then the platform side applied (`applyProtection`, permissionless).
 *         Signed and relayed forms are exercised in `VaultProtectionTest`.
 *         The helpers are `public`: forge links the library once instead of
 *         inlining it into every test contract, which kept large SetupTest
 *         suites under solc's assembly tag limit.
 */
library LibTestProtection {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function vaultOf(address diamond, address account) public returns (VaipakamVaultImplementation) {
        return VaipakamVaultImplementation(VaultFactoryFacet(diamond).getOrCreateUserVault(account));
    }

    function direct(address key) internal pure returns (VaultProtectionBase.Auth memory a) {
        a.key = key;
    }

    /// @dev `key` calls the protection code of `account`'s vault with `data`.
    function call(address diamond, address account, address key, bytes memory data) public returns (bytes memory) {
        VaipakamVaultImplementation v = vaultOf(diamond, account);
        vm.prank(key);
        return v.protect(data);
    }

    /// @dev Apply the platform side; tolerates "nothing changed".
    function apply_(address diamond, address account) public {
        try ProtectedAccountFacet(diamond).applyProtection(account) {} catch {}
    }

    /// @dev The default recovery address's key for `account` (#3246 part 2):
    ///      protected mode needs one before it switches on.
    function recoveryKey(address account) public pure returns (uint256) {
        return uint256(keccak256(abi.encode("vaipakam.test.recovery", account))) % (2 ** 255) + 1;
    }

    function recoveryOf(address account) public pure returns (address) {
        return vm.addr(recoveryKey(account));
    }

    /// @dev The owner asks for `vm.addr(pk)` as the recovery address (a direct
    ///      call); the address proves control by its signature.
    function requestRecovery(address diamond, address account, address owner, uint256 pk) public {
        VaipakamVaultImplementation v = vaultOf(diamond, account);
        address r = vm.addr(pk);
        VaultProtection code = VaultProtection(v.PROTECTION());
        uint64 expiry = uint64(vm.getBlockTimestamp() + 1 hours);
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Vaipakam Vault"),
                keccak256("1"),
                block.chainid,
                address(v)
            )
        );
        bytes32 h = keccak256(
            abi.encode(
                code.RECOVERY_PROOF_TYPEHASH(),
                v.vaultCreationOwner(),
                diamond,
                v.protectionNonce(r, code.PURPOSE_RECOVERY_PROOF()),
                expiry
            )
        );
        (uint8 sv, bytes32 sr, bytes32 ss) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domain, h)));
        VaultProtectionBase.Auth memory proof = VaultProtectionBase.Auth({key: r, expiry: expiry, sig: abi.encodePacked(sr, ss, sv)});
        vm.prank(owner);
        v.protect(abi.encodeCall(VaultRecovery.requestRecoveryAddress, (r, direct(owner), proof)));
    }

    /// @dev Switch protected mode on. Sets the default recovery address first
    ///      when none is set (pending is enough to switch on; {addSigner}
    ///      waits for it to come into force).
    function enable(address diamond, address account, uint32 delay) public {
        (address inForce, address pending,,,) = vaultOf(diamond, account).protectionRecovery();
        if (inForce == address(0) && pending == address(0)) {
            requestRecovery(diamond, account, account, recoveryKey(account));
        }
        call(diamond, account, account, abi.encodeCall(VaultProtection.enable, (delay, direct(account))));
        apply_(diamond, account);
    }

    /// @dev Enable, and put the account's position NFTs under the holder lock.
    function enableWithNfts(address diamond, address account, uint32 delay) public {
        enable(diamond, account, delay);
        vm.prank(account);
        ProtectedAccountFacet(diamond).lockPositionNfts(account);
    }

    function lock(address diamond, address account, address key) public {
        call(diamond, account, key, abi.encodeCall(VaultProtection.lock, (direct(key))));
        apply_(diamond, account);
    }

    function requestUnlock(address diamond, address account, address owner) public {
        call(diamond, account, owner, abi.encodeCall(VaultProtection.requestUnlock, (direct(owner))));
    }

    function requestDisable(address diamond, address account, address owner) public {
        call(diamond, account, owner, abi.encodeCall(VaultProtection.requestDisable, (direct(owner))));
    }

    function finalizeSettings(address diamond, address account) public {
        VaipakamVaultImplementation v = vaultOf(diamond, account);
        v.protect(abi.encodeCall(VaultProtection.finalizeSettings, ()));
        apply_(diamond, account);
    }

    /// @dev Ask, wait the delay, finalize: `destination` becomes allowlisted.
    function allow(address diamond, address account, address owner, address destination, uint32 delay) public {
        call(diamond, account, owner, abi.encodeCall(VaultProtection.addAllowlisted, (destination, direct(owner))));
        vm.warp(vm.getBlockTimestamp() + delay);
        vaultOf(diamond, account).protect(abi.encodeCall(VaultProtection.finalizeAllowlisted, (destination)));
    }

    function removeAllowed(address diamond, address account, address key, address destination) public {
        call(diamond, account, key, abi.encodeCall(VaultProtection.removeAllowlisted, (destination, direct(key))));
    }

    /// @dev `destination` verifies itself (#3415) by a direct call.
    function verify(address diamond, address account, address destination) public {
        call(
            diamond,
            account,
            destination,
            abi.encodeCall(VaultProtection.verifyDestination, (account, diamond, direct(destination)))
        );
    }

    /// @dev Owner adds, signer accepts, wait, finalize.
    function addSigner(address diamond, address account, address owner, address signer, uint32 delay) public {
        uint8 add = 1; // SIGNER_ADD
        uint8 accept = 2; // SIGNER_ACCEPT
        call(diamond, account, owner, abi.encodeCall(VaultProtection.signerChange, (add, signer, direct(owner))));
        call(diamond, account, signer, abi.encodeCall(VaultProtection.signerChange, (accept, signer, direct(signer))));
        vm.warp(vm.getBlockTimestamp() + delay);
        // A signer is finalized only while a recovery address is in force.
        (address inForce,, uint64 pendingAt,,) = vaultOf(diamond, account).protectionRecovery();
        if (inForce == address(0) && pendingAt > vm.getBlockTimestamp()) vm.warp(pendingAt);
        vaultOf(diamond, account).protect(abi.encodeCall(VaultProtection.finalizeSigner, (signer)));
    }

    function propose(address diamond, address account, address key, address nominee) public {
        call(diamond, account, key, abi.encodeCall(VaultProtection.replacement, (uint8(1), nominee, direct(key))));
    }

    function approve(address diamond, address account, address signer, address nominee) public {
        call(diamond, account, signer, abi.encodeCall(VaultProtection.replacement, (uint8(2), nominee, direct(signer))));
    }

    function finalizeReplacement(address diamond, address account) public {
        vaultOf(diamond, account).protect(abi.encodeCall(VaultProtection.finalizeReplacement, ()));
        apply_(diamond, account);
    }
}
