// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";

/// @dev The switch {VaultWithdrawTestHook} reads. No facet routes it, so a
///      call reverts `FunctionDoesNotExist` until a test mocks it on the
///      Diamond.
interface IVaultWithdrawTestSwitch {
    function vaultWithdrawDeliversAll() external view returns (bool);
}

/**
 * @title  VaultWithdrawTestHook
 * @notice Test-only stand-in for the Diamond's `vaultWithdrawERC20` route,
 *         installed by {MockVaultWithdraw.deliversAll}.
 *
 * @dev    Transparent by default: it delegates to the real VaultFactoryFacet.
 *         While a test has mocked {IVaultWithdrawTestSwitch.vaultWithdrawDeliversAll}
 *         on the Diamond to return true, it instead moves nothing and answers
 *         that the recipient received all of `amount`.
 *
 *         Why it exists (#2440): `vaultWithdrawERC20` now returns what the
 *         recipient received, and the protocol books that figure. Unit suites
 *         used to stub the route with a selector-wide
 *         `vm.mockCall(diamond, vaultWithdrawERC20.selector, abi.encode(true))`,
 *         meaning "the vault paid". Read as a delivery, that mock says one wei
 *         arrived, so a voluntary flow refuses `TokenDeliveryShort` and a forced
 *         one books one wei. `vm.mockCall` cannot echo an argument, and
 *         `vm.mockFunction` (which can) outranks `vm.mockCall` /
 *         `vm.mockCallRevert`, survives `vm.clearMockedCalls()` and hides the
 *         call from `vm.expectCall`, all of which those suites rely on.
 *
 *         Keeping the switch itself a `vm.mockCall` preserves every one of
 *         those behaviours: `vm.clearMockedCalls()` turns stub mode off, a later
 *         `vm.mockCall` / `vm.mockCallRevert` on `vaultWithdrawERC20` still wins
 *         (it intercepts at the Diamond before any code runs), and the call
 *         still reaches the Diamond for `vm.expectCall`.
 *
 *         Two limits. In stub mode the route skips the lien guard and the
 *         tracked-balance debit, exactly as the selector-wide mock it replaces
 *         did, so a test that needs either must leave stub mode off. And the
 *         hook is installed by rewriting the route's facet address in storage
 *         without touching the loupe's per-facet selector lists, so a test
 *         must not also `diamondCut` the `vaultWithdrawERC20` selector.
 */
contract VaultWithdrawTestHook {
    /// @notice The VaultFactoryFacet the route pointed at before the hook.
    address public immutable REAL;

    constructor(address real) {
        REAL = real;
    }

    /// @notice Identifies an installed hook, so installation is idempotent.
    function isVaultWithdrawTestHook() external pure returns (bool) {
        return true;
    }

    /// @notice Runs AS the Diamond (delegatecalled by its fallback).
    function vaultWithdrawERC20(address, address, address, uint256 amount)
        external
        returns (uint256)
    {
        (bool on, bytes memory r) = address(this).staticcall(
            abi.encodeWithSelector(IVaultWithdrawTestSwitch.vaultWithdrawDeliversAll.selector)
        );
        if (on && r.length == 32 && abi.decode(r, (bool))) return amount;

        (bool ok, bytes memory out) = REAL.delegatecall(msg.data);
        assembly ("memory-safe") {
            if iszero(ok) { revert(add(out, 0x20), mload(out)) }
            return(add(out, 0x20), mload(out))
        }
    }
}

/**
 * @title  MockVaultWithdraw
 * @notice One helper for unit suites that stub the vault withdrawal: "the
 *         vault delivered everything asked of it, and moved nothing".
 * @dev    Replaces the selector-wide `abi.encode(true)` mock (see
 *         {VaultWithdrawTestHook} for why that no longer means what it did).
 *         The route is rewritten with `vm.store` rather than a `diamondCut`,
 *         so a call made under an active `vm.startPrank` installs it too. The
 *         loupe then reports the hook as `vaultWithdrawERC20`'s facet; the
 *         facet's own selector list is left as it was.
 */
library MockVaultWithdraw {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev diamond-3's `LibDiamond.DIAMOND_STORAGE_POSITION`;
    ///      `selectorToFacetAndPosition` is the first member.
    bytes32 private constant DIAMOND_STORAGE_POSITION =
        keccak256("diamond.standard.diamond.storage");

    uint256 private constant ADDRESS_MASK = type(uint160).max;

    /// @notice Stub `vaultWithdrawERC20` on `diamond` until the next
    ///         `vm.clearMockedCalls()`: every call answers that all of the
    ///         requested amount arrived, and no tokens move.
    function deliversAll(address diamond) internal {
        _install(diamond);
        vm.mockCall(
            diamond,
            abi.encodeWithSelector(IVaultWithdrawTestSwitch.vaultWithdrawDeliversAll.selector),
            abi.encode(true)
        );
    }

    function _install(address diamond) private {
        bytes32 slot = keccak256(
            abi.encode(VaultFactoryFacet.vaultWithdrawERC20.selector, DIAMOND_STORAGE_POSITION)
        );
        uint256 word = uint256(vm.load(diamond, slot));
        address current = address(uint160(word & ADDRESS_MASK));
        require(current != address(0), "MockVaultWithdraw: route not cut");
        if (_isHook(current)) return;

        address hook = address(new VaultWithdrawTestHook(current));
        vm.store(diamond, slot, bytes32((word & ~ADDRESS_MASK) | uint256(uint160(hook))));
    }

    function _isHook(address facet) private view returns (bool) {
        (bool ok, bytes memory r) = facet.staticcall(
            abi.encodeWithSelector(VaultWithdrawTestHook.isVaultWithdrawTestHook.selector)
        );
        return ok && r.length == 32 && abi.decode(r, (bool));
    }
}
