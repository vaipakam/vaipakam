// src/libraries/LibReentrancyGuard.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibTierRecord} from "./LibTierRecord.sol";

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

    /// @dev #3710 — transient slot holding the caller of the guarded action in
    ///      progress (its outer `msg.sender`), for the position-token wait:
    ///      a value-out paid to the caller's own position is the holder's own
    ///      move. keccak256("vaipakam.transient.ReentrancyGuard.actor").
    bytes32 private constant ACTOR_SLOT = 0xf8496088446cacb3980d684e6d5f00cd30dd33f4373c79847f5a3545acad0fb5;

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
        bytes32 slot = ACTOR_SLOT;
        assembly ("memory-safe") {
            tstore(slot, caller())
        }
    }

    /// @dev Ends the guarded action. Users whose VPFI tier record changed
    ///      during it were queued by {LibTierRecord}; their tier is pushed to
    ///      the mirrors here, once each, while the guard is still held, so
    ///      no cross-chain call ever runs with the guard down (#1820).
    function _exit() internal {
        LibTierRecord.flushIfPending();
        _storage().status = NOT_ENTERED;
        bytes32 slot = ACTOR_SLOT;
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }

    /// @dev #3710 — the caller of the guarded action in progress, or 0 when
    ///      none is (an unguarded entry, such as a permissionless executor).
    function actor() internal view returns (address a) {
        bytes32 slot = ACTOR_SLOT;
        assembly ("memory-safe") {
            a := tload(slot)
        }
    }

    /// @dev Whether a guarded action is in progress.
    function entered() internal view returns (bool) {
        return _storage().status == ENTERED;
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
