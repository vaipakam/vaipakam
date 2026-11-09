// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IProtocolRegistryReader} from "../../src/interfaces/IProtocolRegistryReader.sol";
import {RegistryKeys} from "../../src/governance/RegistryKeys.sol";

interface ITreasuryRead {
    function getTreasury() external view returns (address);
    function getBackstopVault() external view returns (address);
    function getSwapAdapters() external view returns (address[] memory);
}

/// @title  MockProtocolRegistry
/// @notice TEST CONVENIENCE ONLY — it must never back a deploy. It mirrors
///         the Diamond's own configuration (the treasury, the backstop, the
///         order protocol and swap adapters), so it agrees with the Diamond
///         by construction and cannot show the property the real registry
///         exists for: the vault refusing a spender the Diamond configured
///         but the registry does not list. That property is tested against a
///         real ProtocolRegistry (VaultOutflowPolicyTest, LaunchTest).
///         Originally: #3205 part 2 — a stand-in for the Timelock-owned protocol registry
///         the vault reads (`IProtocolRegistryReader`), until that contract
///         lands. Anyone may set it: tests only. `requirePointer` reverts for
///         an unset key, as the real registry does, except TREASURY: unset,
///         it answers with `diamond`'s own configured treasury, so a suite that
///         sets the treasury on the Diamond needs no second write here (on a
///         real chain both are written by the same Timelock change).
contract MockProtocolRegistry is IProtocolRegistryReader {
    address public immutable diamond;

    constructor(address diamond_) {
        diamond = diamond_;
    }

    mapping(bytes32 => address) private _pointer;
    mapping(bytes32 => address[]) private _members;
    mapping(bytes32 => mapping(address => bool)) private _isMember;

    function setPointer(bytes32 key, address value) external {
        _pointer[key] = value;
    }

    function setMember(bytes32 setKey, address who, bool on) external {
        if (on == _isMember[setKey][who]) return;
        _isMember[setKey][who] = on;
        address[] storage list = _members[setKey];
        if (on) {
            list.push(who);
            return;
        }
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == who) {
                list[i] = list[list.length - 1];
                list.pop();
                return;
            }
        }
    }

    function pointer(bytes32 key) public view returns (address a) {
        a = _pointer[key];
        if (a == address(0) && key == RegistryKeys.TREASURY && diamond != address(0)) {
            // A hand-built suite Diamond may not route `getTreasury` (it sets
            // the treasury through TestMutatorFacet); every such suite makes
            // the Diamond its own treasury, so that is the answer then. A
            // suite whose treasury is elsewhere sets the pointer here.
            try ITreasuryRead(diamond).getTreasury() returns (address t) {
                a = t;
            } catch {
                a = diamond;
            }
        }
        // BACKSTOP likewise answers with the Diamond's configured backstop
        // account when unset (on a real chain the same change writes both).
        if (a == address(0) && key == RegistryKeys.BACKSTOP && diamond != address(0)) {
            try ITreasuryRead(diamond).getBackstopVault() returns (address b) {
                a = b;
            } catch {}
        }
    }

    function requirePointer(bytes32 key) external view returns (address) {
        address a = pointer(key);
        if (a == address(0)) revert PointerUnset(key);
        return a;
    }

    function isMember(bytes32 setKey, address who) external view returns (bool) {
        if (_isMember[setKey][who]) return true;
        // SWAP_ADAPTERS also answers from the Diamond's own swap adapters (on
        // a real chain the same change writes both; #3391 seeds them at
        // construction). Not the 1inch order protocol: its grant is opened
        // inside a fill, under the Diamond's fill lock, where this read back
        // into the Diamond is refused, so a suite registers it with
        // {setMember} where it configures it.
        if (setKey == RegistryKeys.SWAP_ADAPTERS && diamond != address(0) && who != address(0)) {
            try ITreasuryRead(diamond).getSwapAdapters() returns (address[] memory list) {
                for (uint256 i; i < list.length; ++i) {
                    if (list[i] == who) return true;
                }
            } catch {}
        }
        return false;
    }

    function members(bytes32 setKey) external view returns (address[] memory) {
        return _members[setKey];
    }

    function memberCount(bytes32 setKey) external view returns (uint256) {
        return _members[setKey].length;
    }
}
