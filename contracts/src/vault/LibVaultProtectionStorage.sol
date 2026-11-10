// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  LibVaultProtectionStorage
 * @author Vaipakam Developer Team
 * @notice #3379 Stage B2 — a vault's own protected-mode record: its delay,
 *         lock, secondary signers, allowlist (each entry with its "verified"
 *         flag, #3415), the open primary-replacement proposal and the
 *         per-key, per-purpose signature nonces.
 * @dev    Lives in each vault's OWN storage (a BeaconProxy), at an ERC-7201
 *         namespace, so the vault's sequential layout is untouched. It is
 *         written ONLY by `VaultProtection`, the code every vault delegatecalls
 *         for protected-mode writes; the vault and the Diamond read it. No
 *         platform code can write it: the Diamond reaches a vault only through
 *         the vault's own entries, and none of them writes this record.
 *         APPEND-ONLY, like every layout that survives a code change.
 */
library LibVaultProtectionStorage {
    /// @dev keccak256(abi.encode(uint256(keccak256("vaipakam.vault.protection.v1")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant SLOT = 0x41a947aa841e2e7064188a7fe6de99c3832fc4d4ec61a78beb8352f3b0d4c600;

    /// @notice One secondary signer: pending until accepted by its own key
    ///         and matured, active after; `removeAt` set while a removal waits.
    struct Signer {
        uint64 addAt;
        uint64 removeAt;
        uint64 epoch;
        bool accepted;
        bool active;
    }

    /// @notice One allowlisted destination. `readyAt` is when a pending
    ///         addition may be finalized (it expires one further delay later);
    ///         `active` once finalized. `verified` (#3415) is set only by the
    ///         destination's own authorization.
    struct Entry {
        uint64 readyAt;
        uint64 epoch;
        bool active;
        bool verified;
    }

    struct Layout {
        // Settings and lock.
        bool enabled;
        bool locked;
        uint32 delay;
        uint32 pendingDelay;
        uint64 pendingDelayAt;
        uint64 pendingUnlockAt;
        uint64 pendingDisableAt;
        uint64 lockedAt;
        uint64 cooldownUntil;
        /// @dev Bumped by a lock, a replacement and a switch-off: every pending
        ///      change carries the epoch it was asked in and dies with it.
        uint64 epoch;
        address lockedBy;
        // Secondary signers.
        address[] signers;
        mapping(address => Signer) signer;
        // Allowlist.
        address[] allowlist;
        mapping(address => Entry) allow;
        // The open replacement proposal.
        address nominee;
        address proposedBy;
        uint64 readyAt;
        uint32 round;
        mapping(uint32 => mapping(address => bool)) approved;
        // Signature nonces: key => purpose => next nonce.
        mapping(address => mapping(uint8 => uint256)) nonces;
        // Pending additions per epoch (listed, and at most five of each wait).
        mapping(uint64 => address[]) pendingAllow;
        mapping(uint64 => address[]) pendingSigners;
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 slot = SLOT;
        assembly {
            l.slot := slot
        }
    }
}
