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
        // Auto-pause time window (Phase 1 follow-up). When non-zero,
        // the protocol is paused until `block.timestamp >=
        // pausedUntilTimestamp` regardless of the manual `paused` bool.
        // Zero ⇒ no auto-pause active. Set by
        // `AdminFacet.autoPause(...)` (WATCHER_ROLE-gated). Cleared
        // by:
        //   - normal expiry (block.timestamp catches up — handled in
        //     `requireNotPaused` so no unpause tx is needed)
        //   - admin's `unpause()` (short-circuit when verified
        //     false-positive)
        uint64 pausedUntilTimestamp;
    }

    event Paused(address account);
    event Unpaused(address account);
    /// @dev Emitted when the watcher fires an auto-pause. `until` is the
    ///      block-timestamp at which the auto-pause window expires;
    ///      indexers + alerting use this to render countdown + correlate
    ///      with the off-chain anomaly that triggered.
    event AutoPaused(address indexed watcher, string reason, uint64 until);

    error EnforcedPause();
    error ExpectedPause();

    function _storage() private pure returns (PausableStorage storage ps) {
        bytes32 position = PAUSABLE_STORAGE_POSITION;
        assembly {
            ps.slot := position
        }
    }

    /// @dev True iff the protocol is currently paused — either via the
    ///      manual `paused` bool (admin pause, indefinite) OR via an
    ///      active auto-pause window (`pausedUntilTimestamp > now`).
    ///      Auto-pause windows that have elapsed return false here so
    ///      no explicit unpause tx is needed once the window expires.
    function paused() internal view returns (bool) {
        PausableStorage storage ps = _storage();
        if (ps.paused) return true;
        return ps.pausedUntilTimestamp > block.timestamp;
    }

    function requireNotPaused() internal view {
        PausableStorage storage ps = _storage();
        if (ps.paused) revert EnforcedPause();
        if (ps.pausedUntilTimestamp > block.timestamp) revert EnforcedPause();
    }

    function requirePaused() internal view {
        if (!paused()) revert ExpectedPause();
    }

    function pause() internal {
        _storage().paused = true;
        emit Paused(msg.sender);
    }

    function unpause() internal {
        // Clear both manual + auto-pause — admin can short-circuit a
        // false-positive auto-pause without waiting for the window
        // to elapse.
        PausableStorage storage ps = _storage();
        ps.paused = false;
        ps.pausedUntilTimestamp = 0;
        emit Unpaused(msg.sender);
    }

    /// @dev Phase 1 follow-up — auto-pause primitive. Sets a time-
    ///      bounded pause window. No-op if the protocol is already
    ///      paused (manual or auto), so a compromised watcher can't
    ///      chain repeated calls into an indefinite freeze; the most
    ///      it can do is set the window once, which auto-clears at
    ///      `now + duration`.
    function autoPause(uint256 duration, string memory reason) internal {
        PausableStorage storage ps = _storage();
        // Already paused (manual or active auto-pause): no-op. Quietly
        // returning rather than reverting so a watcher firing into a
        // race-condition with admin's manual pause doesn't surface as
        // a confusing revert in the watcher's logs.
        if (ps.paused) return;
        if (ps.pausedUntilTimestamp > block.timestamp) return;
        uint64 until = uint64(block.timestamp + duration);
        ps.pausedUntilTimestamp = until;
        emit AutoPaused(msg.sender, reason, until);
    }

    /// @dev Block-timestamp at which an active auto-pause window
    ///      expires. Zero when no auto-pause is set OR when the
    ///      window has already elapsed. Frontends use this to render
    ///      a countdown without a separate isAutoPaused check.
    function pausedUntil() internal view returns (uint256) {
        uint64 t = _storage().pausedUntilTimestamp;
        return uint256(t) > block.timestamp ? uint256(t) : 0;
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
