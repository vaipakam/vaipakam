// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {VaultOutflowFacet} from "../../src/facets/VaultOutflowFacet.sol";
import {VaultOutflowTypes} from "../../src/vault/VaultOutflowTypes.sol";

/// @dev The switch {VaultWithdrawTestHook} reads. No facet routes it, so a
///      call reverts `FunctionDoesNotExist` until a test mocks it on the
///      Diamond.
interface IVaultWithdrawTestSwitch {
    function vaultWithdrawDeliversAll() external view returns (bool);
    /// @dev #3205 part 2 — per asset kind: 0 off, 1 stub (answer the amount,
    ///      move nothing), 2 revert with {VaultOutflowStubFailure}.
    function vaultOutflowStubMode(uint8 kind) external view returns (uint8);
    /// @dev Per outflow class: true = revert with {VaultOutflowStubFailure}.
    function vaultOutflowClassFails(uint8 class_) external view returns (bool);
}

/// @dev The revert a {MockVaultWithdraw.fails} stub raises.
error VaultOutflowStubFailure(uint8 kind);

/**
 * @title  VaultWithdrawTestHook
 * @notice Test-only stand-in for the Diamond's vault outflow route
 *         (`VaultOutflowFacet.vaultOutflow`, which replaced `vaultWithdrawERC20`
 *         in #3205 part 2), installed by {MockVaultWithdraw.deliversAll}.
 *
 * @dev    Transparent by default: it delegates to the real VaultOutflowFacet.
 *         While a test has mocked {IVaultWithdrawTestSwitch.vaultWithdrawDeliversAll}
 *         on the Diamond to return true, an ERC-20 outflow instead moves
 *         nothing and answers that the recipient received all of `amount`
 *         (NFT outflows still run, as before: the old stub covered only the
 *         ERC-20 route).
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

    /// @notice The compact Owner-class entry, stubbed by the same switches.
    function vaultOutflowToOwner(address, uint8 kind, address, uint256, uint256 amount, uint8)
        external
        returns (uint256)
    {
        if (_stubbed(VaultOutflowTypes.AssetKind(kind), VaultOutflowTypes.OutflowClass.Owner)) return amount;
        (bool ok, bytes memory out) = REAL.delegatecall(msg.data);
        assembly ("memory-safe") {
            if iszero(ok) { revert(add(out, 0x20), mload(out)) }
            return(add(out, 0x20), mload(out))
        }
    }

    /// @dev Whether the switches stub an outflow of `kind` / `class_` (true),
    ///      revert it, or let it run (false).
    function _stubbed(VaultOutflowTypes.AssetKind kind, VaultOutflowTypes.OutflowClass class_) private view returns (bool) {
        (bool on, bytes memory r) = address(this).staticcall(
            abi.encodeWithSelector(IVaultWithdrawTestSwitch.vaultWithdrawDeliversAll.selector)
        );
        if (on && r.length == 32 && abi.decode(r, (bool)) && kind == VaultOutflowTypes.AssetKind.ERC20) return true;
        (bool has, bytes memory m) = address(this).staticcall(
            abi.encodeWithSelector(IVaultWithdrawTestSwitch.vaultOutflowStubMode.selector, uint8(kind))
        );
        if (has && m.length == 32) {
            uint8 mode = abi.decode(m, (uint8));
            if (mode == 1) return true;
            if (mode == 2) revert VaultOutflowStubFailure(uint8(kind));
        }
        (bool hasC, bytes memory c) = address(this).staticcall(
            abi.encodeWithSelector(IVaultWithdrawTestSwitch.vaultOutflowClassFails.selector, uint8(class_))
        );
        if (hasC && c.length == 32 && abi.decode(c, (bool))) revert VaultOutflowStubFailure(uint8(kind));
        return false;
    }

    /// @notice The scalar entry, stubbed by the same switches.
    function vaultOutflowArgs(
        address,
        uint8 kind,
        address,
        uint256,
        uint256 amount,
        address,
        uint8 class_,
        uint256,
        uint256,
        uint8
    ) external returns (uint256) {
        if (_stubbed(VaultOutflowTypes.AssetKind(kind), VaultOutflowTypes.OutflowClass(class_))) return amount;
        return _real();
    }

    /// @notice The compact Diamond-transient ERC-20 entry, stubbed likewise.
    function vaultOutflowToDiamondERC20(address, address, uint256 amount, uint256, uint8) external returns (uint256) {
        if (_stubbed(VaultOutflowTypes.AssetKind.ERC20, VaultOutflowTypes.OutflowClass.DiamondTransient)) return amount;
        return _real();
    }

    /// @dev Forward the call unchanged to the real policy host.
    function _real() private returns (uint256) {
        (bool ok, bytes memory out) = REAL.delegatecall(msg.data);
        assembly ("memory-safe") {
            if iszero(ok) { revert(add(out, 0x20), mload(out)) }
            return(add(out, 0x20), mload(out))
        }
    }

    /// @notice Runs AS the Diamond (delegatecalled by its fallback).
    function vaultOutflow(address, VaultOutflowTypes.Outflow calldata o) external returns (uint256) {
        if (_stubbed(o.kind, o.class_)) return o.amount;
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

    /// @notice Stub the vault outflow route (ERC-20) on `diamond` until the next
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

    /// @notice Stub every outflow of asset `kind` on `diamond`: it answers the
    ///         amount and moves nothing (the old selector-wide mock of one
    ///         `vaultWithdrawERC*` route). Off at the next `vm.clearMockedCalls()`.
    function stubs(address diamond, VaultOutflowTypes.AssetKind kind) internal {
        _install(diamond);
        vm.mockCall(
            diamond,
            abi.encodeWithSelector(IVaultWithdrawTestSwitch.vaultOutflowStubMode.selector, uint8(kind)),
            abi.encode(uint8(1))
        );
    }

    /// @notice Make every outflow of asset `kind` on `diamond` revert
    ///         {VaultOutflowStubFailure} (the old selector-wide
    ///         `vm.mockCallRevert` of one route).
    function fails(address diamond, VaultOutflowTypes.AssetKind kind) internal {
        _install(diamond);
        vm.mockCall(
            diamond,
            abi.encodeWithSelector(IVaultWithdrawTestSwitch.vaultOutflowStubMode.selector, uint8(kind)),
            abi.encode(uint8(2))
        );
    }

    /// @notice Make every outflow of class `class_` on `diamond` revert
    ///         {VaultOutflowStubFailure} (the old recipient-matched revert: a
    ///         derived class's recipient is resolved inside the policy, so a
    ///         test selects the leg by class).
    function failsClass(address diamond, VaultOutflowTypes.OutflowClass class_) internal {
        _install(diamond);
        vm.mockCall(
            diamond,
            abi.encodeWithSelector(IVaultWithdrawTestSwitch.vaultOutflowClassFails.selector, uint8(class_)),
            abi.encode(true)
        );
    }

    /// @notice The calldata prefix of a vault outflow from `user`'s vault of
    ///         `kind` / `asset` (for `vm.expectCall` and argument-matched
    ///         mocks: the Outflow struct is static, so its fields encode in
    ///         place and a prefix matches the leading ones).
    function prefix(address user, VaultOutflowTypes.AssetKind kind, address asset) internal pure returns (bytes memory) {
        return abi.encodePacked(VaultOutflowFacet.vaultOutflow.selector, abi.encode(user, kind, asset));
    }

    function _install(address diamond) private {
        _installFor(diamond, VaultOutflowFacet.vaultOutflowToOwner.selector);
        _installFor(diamond, VaultOutflowFacet.vaultOutflow.selector);
        _installFor(diamond, VaultOutflowFacet.vaultOutflowArgs.selector);
        _installFor(diamond, VaultOutflowFacet.vaultOutflowToDiamondERC20.selector);
    }

    function _installFor(address diamond, bytes4 selector) private {
        bytes32 slot = keccak256(
            abi.encode(selector, DIAMOND_STORAGE_POSITION)
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
