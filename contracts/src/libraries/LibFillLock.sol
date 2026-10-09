// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  LibFillLock
 * @notice The fill-state lock (#1566 slice 3). The 1inch LOP pre-hook of a Vaipakam order opens it,
 *         that order's post-hook closes it, and the Diamond's entry point ({VaipakamDiamond}'s
 *         fallback) enforces it: while it is held, only the Diamond's own self-calls and the
 *         post-hook may enter the Diamond.
 *
 * @dev    Why a lock that spans the two hooks, not `nonReentrant` on each. Slice 3 takes the intent
 *         lot out of the borrower's vault only inside the fill: the pre-hook lowers its lien and
 *         records the outflow, the LOP moves it from the vault (the order's maker, since S3e) to the
 *         taker, and the post-hook settles. Between the two hooks the LOP runs third-party code: the
 *         maker-to-taker transfer (a token hook), the taker interaction, the taker-to-maker transfer
 *         and the unwrapped native payout. A function-scoped guard is released when the pre-hook
 *         returns, so any of those could enter a Diamond function while the loan is half-settled. The design says the lock is "set
 *         before the pull and cleared by postInteraction"; the post-hook "must reenter during the LOP
 *         transfer", which is why it, alone, is admitted.
 *
 *         Transient storage (EIP-1153): the lock lives for one transaction, so a fill that reverts, or
 *         a transaction that ends between the hooks, can never leave it set. The stored value is the
 *         order hash, so a post-hook can close only the lock its own pre-hook opened, and a second
 *         Vaipakam fill nested inside the first is refused. The recorded trade-off: the lock covers
 *         both order kinds (O3), so a resolver cannot settle one Vaipakam order -- a swap-to-repay or
 *         a treasury buyback -- inside another's fill. Fills one after another in the same
 *         transaction are unaffected: each releases the lock before the next opens it.
 */
library LibFillLock {
    /// @dev `keccak256("vaipakam.transient.fillLock") - 1`: a transient slot, outside every storage
    ///      layout (transient and persistent storage are separate spaces in any case).
    bytes32 internal constant SLOT = bytes32(uint256(keccak256("vaipakam.transient.fillLock")) - 1);

    /// @notice A call entered the Diamond while the fill of order `heldBy` held the lock, or a second
    ///         fill tried to open it.
    error FillInProgress(bytes32 heldBy);
    /// @notice A post-hook for `orderHash` tried to close a lock it did not open.
    error FillLockMismatch(bytes32 orderHash, bytes32 heldBy);

    /// @dev Opens the lock for `orderHash`; refuses if any fill already holds it.
    function acquire(bytes32 orderHash) internal {
        bytes32 held = heldBy();
        if (held != bytes32(0)) revert FillInProgress(held);
        bytes32 slot = SLOT;
        assembly ("memory-safe") {
            tstore(slot, orderHash)
        }
    }

    /// @dev Closes the lock `orderHash` opened; refuses any other value, including no lock at all.
    function release(bytes32 orderHash) internal {
        bytes32 held = heldBy();
        if (held != orderHash) revert FillLockMismatch(orderHash, held);
        bytes32 slot = SLOT;
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }

    /// @dev The order hash whose fill holds the lock, or zero.
    function heldBy() internal view returns (bytes32 held) {
        bytes32 slot = SLOT;
        assembly ("memory-safe") {
            held := tload(slot)
        }
    }
}
