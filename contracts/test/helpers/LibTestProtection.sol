// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {VaultProtection} from "../../src/vault/VaultProtection.sol";
import {VaipakamVaultImplementation} from "../../src/VaipakamVaultImplementation.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {ProtectedAccountFacet} from "../../src/facets/ProtectedAccountFacet.sol";

/**
 * @title  LibTestProtection
 * @notice #3379 B2 — drive a vault's protected mode the way a key holder does:
 *         a DIRECT call from the key to `vault.protect(...)` (no signature),
 *         then the platform side applied (`applyProtection`, permissionless).
 *         Signed and relayed forms are exercised in `VaultProtectionTest`.
 */
library LibTestProtection {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function vaultOf(address diamond, address account) internal returns (VaipakamVaultImplementation) {
        return VaipakamVaultImplementation(VaultFactoryFacet(diamond).getOrCreateUserVault(account));
    }

    function direct(address key) internal pure returns (VaultProtection.Auth memory a) {
        a.key = key;
    }

    /// @dev `key` calls the protection code of `account`'s vault with `data`.
    function call(address diamond, address account, address key, bytes memory data) internal returns (bytes memory) {
        VaipakamVaultImplementation v = vaultOf(diamond, account);
        vm.prank(key);
        return v.protect(data);
    }

    /// @dev Apply the platform side; tolerates "nothing changed".
    function apply_(address diamond, address account) internal {
        try ProtectedAccountFacet(diamond).applyProtection(account) {} catch {}
    }

    function enable(address diamond, address account, uint32 delay) internal {
        call(diamond, account, account, abi.encodeCall(VaultProtection.enable, (delay, direct(account))));
        apply_(diamond, account);
    }

    /// @dev Enable, and put the account's position NFTs under the holder lock.
    function enableWithNfts(address diamond, address account, uint32 delay) internal {
        enable(diamond, account, delay);
        vm.prank(account);
        ProtectedAccountFacet(diamond).lockPositionNfts(account);
    }

    function lock(address diamond, address account, address key) internal {
        call(diamond, account, key, abi.encodeCall(VaultProtection.lock, (direct(key))));
        apply_(diamond, account);
    }

    function requestUnlock(address diamond, address account, address owner) internal {
        call(diamond, account, owner, abi.encodeCall(VaultProtection.requestUnlock, (direct(owner))));
    }

    function requestDisable(address diamond, address account, address owner) internal {
        call(diamond, account, owner, abi.encodeCall(VaultProtection.requestDisable, (direct(owner))));
    }

    function finalizeSettings(address diamond, address account) internal {
        VaipakamVaultImplementation v = vaultOf(diamond, account);
        v.protect(abi.encodeCall(VaultProtection.finalizeSettings, ()));
        apply_(diamond, account);
    }

    /// @dev Ask, wait the delay, finalize: `destination` becomes allowlisted.
    function allow(address diamond, address account, address owner, address destination, uint32 delay) internal {
        call(diamond, account, owner, abi.encodeCall(VaultProtection.addAllowlisted, (destination, direct(owner))));
        vm.warp(block.timestamp + delay);
        vaultOf(diamond, account).protect(abi.encodeCall(VaultProtection.finalizeAllowlisted, (destination)));
    }

    function removeAllowed(address diamond, address account, address key, address destination) internal {
        call(diamond, account, key, abi.encodeCall(VaultProtection.removeAllowlisted, (destination, direct(key))));
    }

    /// @dev `destination` verifies itself (#3415) by a direct call.
    function verify(address diamond, address account, address destination) internal {
        call(
            diamond,
            account,
            destination,
            abi.encodeCall(VaultProtection.verifyDestination, (account, diamond, direct(destination)))
        );
    }

    /// @dev Owner adds, signer accepts, wait, finalize.
    function addSigner(address diamond, address account, address owner, address signer, uint32 delay) internal {
        uint8 add = 1; // SIGNER_ADD
        uint8 accept = 2; // SIGNER_ACCEPT
        call(diamond, account, owner, abi.encodeCall(VaultProtection.signerChange, (add, signer, direct(owner))));
        call(diamond, account, signer, abi.encodeCall(VaultProtection.signerChange, (accept, signer, direct(signer))));
        vm.warp(block.timestamp + delay);
        vaultOf(diamond, account).protect(abi.encodeCall(VaultProtection.finalizeSigner, (signer)));
    }

    function propose(address diamond, address account, address key, address nominee) internal {
        call(diamond, account, key, abi.encodeCall(VaultProtection.replacement, (uint8(1), nominee, direct(key))));
    }

    function approve(address diamond, address account, address signer, address nominee) internal {
        call(diamond, account, signer, abi.encodeCall(VaultProtection.replacement, (uint8(2), nominee, direct(signer))));
    }

    function finalizeReplacement(address diamond, address account) internal {
        vaultOf(diamond, account).protect(abi.encodeCall(VaultProtection.finalizeReplacement, ()));
        apply_(diamond, account);
    }
}
