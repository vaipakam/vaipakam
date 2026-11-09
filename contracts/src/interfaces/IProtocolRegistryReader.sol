// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  IProtocolRegistryReader
 * @author Vaipakam Developer Team
 * @notice The read surface of {ProtocolRegistry} (#3272): what the Diamond's
 *         facets and every vault import to resolve a pointer or test set
 *         membership. Governance's write surface stays on the contract itself.
 * @dev    Pointers and sets live in separate storage namespaces, but a
 *         {RegistryKeys} name is only ever used for one of them.
 */
interface IProtocolRegistryReader {
    /// @notice `requirePointer` found pointer `key` never set.
    error PointerUnset(bytes32 key);

    /// @notice The value of pointer `key`, or `address(0)` when it was never set.
    function pointer(bytes32 key) external view returns (address);

    /// @notice The value of pointer `key`; reverts {PointerUnset} when unset.
    function requirePointer(bytes32 key) external view returns (address value);

    /// @notice Whether `member` is in set `set`.
    function isMember(bytes32 set, address member) external view returns (bool);

    /// @notice Every member of set `set`, in no particular order.
    function members(bytes32 set) external view returns (address[] memory);

    /// @notice How many members set `set` has.
    function memberCount(bytes32 set) external view returns (uint256);
}
