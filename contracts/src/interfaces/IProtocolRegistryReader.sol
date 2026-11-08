// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  IProtocolRegistryReader
 * @author Vaipakam Developer Team
 * @notice The read surface of the Timelock-owned protocol registry: pointers
 *         keyed by `bytes32`, and membership sets. Pointers and sets are
 *         separate mappings; each key is used for one kind only.
 */
interface IProtocolRegistryReader {
    /// @notice `requirePointer` was asked for a key that holds no address.
    error PointerUnset(bytes32 key);

    /// @notice The address under `key`, or zero when unset. Never reverts.
    function pointer(bytes32 key) external view returns (address);

    /// @notice The address under `key`; reverts {PointerUnset} when unset.
    function requirePointer(bytes32 key) external view returns (address value);

    /// @notice Whether `member` belongs to the set under `set`.
    function isMember(bytes32 set, address member) external view returns (bool);

    /// @notice Every member of the set under `set`.
    function members(bytes32 set) external view returns (address[] memory);

    /// @notice How many members the set under `set` has.
    function memberCount(bytes32 set) external view returns (uint256);
}
