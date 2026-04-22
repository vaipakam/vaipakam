// src/libraries/LibReentrancyGuard.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title LibReentrancyGuard
 * @notice Diamond-safe reentrancy guard using ERC-7201 namespaced storage.
 * @dev Replaces OpenZeppelin's ReentrancyGuard inheritance which stores `_status`
 *      in ordinary slot 0, causing storage collisions across facets in a diamond proxy.
 *      Storage position is derived from keccak256("vaipakam.storage.ReentrancyGuard").
 */
library LibReentrancyGuard {
    /// @dev ERC-7201 namespaced storage slot.
    ///      keccak256(abi.encode(uint256(keccak256("vaipakam.storage.ReentrancyGuard")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant REENTRANCY_GUARD_STORAGE_POSITION =
        0x04ba3822bc69a2ad3e1ccb8944f5c7cebff98e1206031ba7be7244e7e3f82700;

    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    /// @dev APPEND-ONLY POST-LAUNCH. New fields go at the end; never reorder,
    ///      rename, or change types of existing fields on live diamonds.
    struct ReentrancyGuardStorage {
        uint256 status;
    }

    error ReentrancyGuardReentrantCall();

    function _storage() private pure returns (ReentrancyGuardStorage storage rs) {
        bytes32 position = REENTRANCY_GUARD_STORAGE_POSITION;
        assembly {
            rs.slot := position
        }
    }

    function _enter() internal {
        ReentrancyGuardStorage storage rs = _storage();
        // On first access, status is 0 (uninitialized). Treat 0 as NOT_ENTERED.
        if (rs.status == ENTERED) revert ReentrancyGuardReentrantCall();
        rs.status = ENTERED;
    }

    function _exit() internal {
        _storage().status = NOT_ENTERED;
    }
}

/**
 * @dev Thin abstract contract providing the nonReentrant modifier
 *      backed by LibReentrancyGuard's namespaced storage. Has zero state
 *      variables, so it's safe to inherit in diamond facets without
 *      storage collisions.
 */
abstract contract DiamondReentrancyGuard {
    modifier nonReentrant() {
        LibReentrancyGuard._enter();
        _;
        LibReentrancyGuard._exit();
    }
}
