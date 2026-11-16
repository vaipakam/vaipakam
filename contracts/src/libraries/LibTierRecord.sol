// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  LibTierRecord
 * @notice The one seam through which a user's VPFI fee-discount tier record is
 *         refreshed, and the per-transaction queue of users whose tier is
 *         pushed to the mirrors when the action ends (#1820, #2849).
 *
 * @dev    The tier balance (tracked vault VPFI less VPFI frozen for a
 *         transferred position's holder) has exactly two writers:
 *         `LibVaipakam.recordVaultDeposit` / `recordVaultWithdraw` and the
 *         frozen-owed writes in `LibTierExclusion` / `LibCloseoutFreeze`.
 *         Each calls {refresh} after it writes, so the record on Base is
 *         current the moment the balance changes, on every path.
 *         `pokeMyTier` and the loan-start snapshots call it with no balance
 *         change, because time alone can change a tier.
 *
 *         {refresh} reaches `VPFIDiscountAccumulatorFacet.syncTierRecord`
 *         through a self-call, so the heavy ring-buffer code stays in one
 *         facet. That entry updates the record at once and, while an action
 *         holds the Diamond's reentrancy guard or a fill holds the fill
 *         lock, {enqueue}s the user instead of pushing. The guard's release
 *         ({LibReentrancyGuard._exit}) calls {flushIfPending}, which pushes
 *         each queued user's tier once, through
 *         `ProtocolBroadcastFacet.flushTierPushes`, before the guard is
 *         released. So a settlement that moves one user's VPFI several times
 *         commits one push, carrying the final tier.
 *
 *         This library is a leaf (it imports nothing), so the base storage
 *         library and the guard can both call it. The selectors are fixed by
 *         signature; `TierRecordSeamTest` pins them to the facets.
 *
 *         The queue lives in transient storage (EIP-1153): a reverted action
 *         discards it, and it never outlives the transaction.
 *
 *         DEFERRAL. A step that runs a balance move under a fixed gas
 *         allowance (a settlement leg attempt, #3669) brackets it with
 *         {beginDeferral} / {endDeferral}. In between, `syncTierRecord`
 *         only notes the user ({defer}), so the move's cost does not depend
 *         on how long ago a user's record was last rolled up (up to 30 day
 *         slots). {endDeferral} returns the noted users once the outermost
 *         bracket closes, and the caller refreshes each from the balance then
 *         in storage, in its own frame. A noted user whose move reverted is
 *         dropped with the move, because the note is transient storage
 *         written inside the reverted call.
 */
library LibTierRecord {
    /// @dev `VPFIDiscountAccumulatorFacet.syncTierRecord(address)`.
    bytes4 internal constant SYNC_SELECTOR = bytes4(keccak256("syncTierRecord(address)"));
    /// @dev `ProtocolBroadcastFacet.flushTierPushes()`.
    bytes4 internal constant FLUSH_SELECTOR = bytes4(keccak256("flushTierPushes()"));

    /// @dev Transient slot holding the queue length; entry `i` sits at
    ///      `QUEUE_SLOT + 1 + i`. `keccak256("vaipakam.transient.tierPushQueue") - 1`.
    bytes32 private constant QUEUE_SLOT = bytes32(uint256(keccak256("vaipakam.transient.tierPushQueue")) - 1);
    /// @dev Transient set of users whose refresh is deferred, laid out like
    ///      the push queue. `keccak256("vaipakam.transient.tierDeferred") - 1`.
    bytes32 private constant DEFERRED_SLOT = bytes32(uint256(keccak256("vaipakam.transient.tierDeferred")) - 1);
    /// @dev Transient bracket depth of {beginDeferral}.
    ///      `keccak256("vaipakam.transient.tierDeferDepth") - 1`.
    bytes32 private constant DEFER_DEPTH_SLOT = bytes32(uint256(keccak256("vaipakam.transient.tierDeferDepth")) - 1);

    /// @dev `FunctionDoesNotExist()`, the Diamond fallback's revert for an
    ///      unrouted selector.
    bytes4 private constant FUNCTION_DOES_NOT_EXIST = bytes4(keccak256("FunctionDoesNotExist()"));

    /// @notice Refresh `user`'s tier record from the balance now in storage,
    ///         and push or queue their tier. Reverts with whatever the
    ///         refresh reverts with, except that a Diamond with no tier
    ///         accumulator routed records nothing.
    /// @dev    That exception keeps the unit-test Diamonds that cut only the
    ///         facets under test (and so no accumulator) working; every
    ///         deploy and refresh script cuts it, which the deploy-sanity
    ///         suite checks. It cannot hide a missing push host: the
    ///         accumulator reports that as its own error.
    ///         Written in assembly because it is inlined at every tracked
    ///         balance write, including inside settlement frames already at
    ///         the stack budget: the call borrows only scratch memory past
    ///         the free-memory pointer, which it never moves, and holds no
    ///         Solidity temporaries.
    function refresh(address user) internal {
        bytes4 sel = SYNC_SELECTOR;
        bytes4 missing = FUNCTION_DOES_NOT_EXIST;
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, and(sel, shl(224, 0xffffffff)))
            mstore(add(p, 4), and(user, 0xffffffffffffffffffffffffffffffffffffffff))
            if iszero(call(gas(), address(), 0, p, 0x24, 0, 0)) {
                let n := returndatasize()
                returndatacopy(p, 0, n)
                if iszero(and(eq(n, 4), eq(and(mload(p), shl(224, 0xffffffff)), and(missing, shl(224, 0xffffffff))))) {
                    revert(p, n)
                }
            }
        }
    }

    /// @notice Queue `user` for the push at the end of the action; a user
    ///         already queued is not added twice.
    function enqueue(address user) internal {
        _add(QUEUE_SLOT, user);
    }

    /// @notice How many users are queued.
    function pending() internal view returns (uint256) {
        return _len(QUEUE_SLOT);
    }

    /// @notice Return every queued user and empty the queue.
    function drain() internal returns (address[] memory) {
        return _drain(QUEUE_SLOT);
    }

    // ─── Deferral ────────────────────────────────────────────────────────

    /// @notice Open a deferral bracket (brackets nest).
    function beginDeferral() internal {
        bytes32 d = DEFER_DEPTH_SLOT;
        assembly ("memory-safe") {
            tstore(d, add(tload(d), 1))
        }
    }

    /// @notice Whether a deferral bracket is open.
    function deferring() internal view returns (bool open) {
        bytes32 d = DEFER_DEPTH_SLOT;
        assembly ("memory-safe") {
            open := iszero(iszero(tload(d)))
        }
    }

    /// @notice Note `user` for a refresh when the bracket closes.
    function defer(address user) internal {
        _add(DEFERRED_SLOT, user);
    }

    /// @notice Close a deferral bracket. The outermost close returns every
    ///         noted user and empties the set; an inner close returns none,
    ///         so the notes reach the frame that opened the bracket.
    function endDeferral() internal returns (address[] memory users) {
        bytes32 d = DEFER_DEPTH_SLOT;
        uint256 depth;
        assembly ("memory-safe") {
            depth := sub(tload(d), 1)
            tstore(d, depth)
        }
        if (depth != 0) return users;
        return _drain(DEFERRED_SLOT);
    }

    // ─── Transient sets ──────────────────────────────────────────────────

    function _add(bytes32 base, address user) private {
        bytes32 mark = _markSlot(base, user);
        assembly ("memory-safe") {
            if iszero(tload(mark)) {
                tstore(mark, 1)
                let len := tload(base)
                tstore(add(add(base, 1), len), user)
                tstore(base, add(len, 1))
            }
        }
    }

    function _len(bytes32 base) private view returns (uint256 len) {
        assembly ("memory-safe") {
            len := tload(base)
        }
    }

    function _drain(bytes32 base) private returns (address[] memory users) {
        uint256 len = _len(base);
        users = new address[](len);
        for (uint256 i; i < len; ++i) {
            address user;
            assembly ("memory-safe") {
                let at := add(add(base, 1), i)
                user := tload(at)
                tstore(at, 0)
            }
            users[i] = user;
            bytes32 mark = _markSlot(base, user);
            assembly ("memory-safe") {
                tstore(mark, 0)
            }
        }
        assembly ("memory-safe") {
            tstore(base, 0)
        }
    }

    /// @notice Push every queued user's tier, if any is queued. Called by the
    ///         guard's release, while the guard is still held.
    function flushIfPending() internal {
        if (pending() == 0) return;
        bytes4 sel = FLUSH_SELECTOR;
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, and(sel, shl(224, 0xffffffff)))
            if iszero(call(gas(), address(), 0, p, 4, 0, 0)) {
                let n := returndatasize()
                returndatacopy(p, 0, n)
                revert(p, n)
            }
        }
    }

    function _markSlot(bytes32 base, address user) private pure returns (bytes32) {
        return keccak256(abi.encode(user, base));
    }

}
