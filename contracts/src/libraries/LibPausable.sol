// src/libraries/LibPausable.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title LibPausable
 * @notice Diamond-safe pausable mechanism using ERC-7201 namespaced storage.
 * @dev Replaces OpenZeppelin's Pausable inheritance which uses regular storage
 *      slots that collide across facets in a diamond proxy.
 */
library LibPausable {
    /// @dev ERC-7201 namespaced storage slot.
    ///      keccak256(abi.encode(uint256(keccak256("vaipakam.storage.Pausable")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant PAUSABLE_STORAGE_POSITION =
        0x2160e84a745d8897ad2778886d40d3563c8bc30c059c5f2173e21e9d47057400;

    /// @dev APPEND-ONLY POST-LAUNCH. New fields go at the end; never reorder,
    ///      rename, or change types of existing fields on live diamonds.
    struct PausableStorage {
        bool paused;
    }

    event Paused(address account);
    event Unpaused(address account);

    error EnforcedPause();
    error ExpectedPause();

    function _storage() private pure returns (PausableStorage storage ps) {
        bytes32 position = PAUSABLE_STORAGE_POSITION;
        assembly {
            ps.slot := position
        }
    }

    function paused() internal view returns (bool) {
        return _storage().paused;
    }

    function requireNotPaused() internal view {
        if (_storage().paused) revert EnforcedPause();
    }

    function requirePaused() internal view {
        if (!_storage().paused) revert ExpectedPause();
    }

    function pause() internal {
        _storage().paused = true;
        emit Paused(msg.sender);
    }

    function unpause() internal {
        _storage().paused = false;
        emit Unpaused(msg.sender);
    }
}

/**
 * @dev Thin abstract contract providing whenNotPaused/whenPaused modifiers
 *      backed by LibPausable's namespaced storage. Has zero state variables,
 *      so it's safe to inherit in diamond facets without storage collisions.
 */
abstract contract DiamondPausable {
    modifier whenNotPaused() {
        LibPausable.requireNotPaused();
        _;
    }

    modifier whenPaused() {
        LibPausable.requirePaused();
        _;
    }
}
