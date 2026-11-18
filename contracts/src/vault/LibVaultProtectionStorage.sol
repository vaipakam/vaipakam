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
        /// @dev Codex #3489 r11 — this finalization's generation (a fresh
        ///      value from `allowGen` each time the entry becomes active).
        ///      Appended — a mapping value may grow.
        uint64 gen;
        /// @dev Codex #3489 r16 — the addition request this entry stands
        ///      for (a fresh value from `allowRequests` at each request). A
        ///      destination's signed verification names it, so a signature
        ///      given for one request never verifies another. Appended.
        uint64 request;
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
        /// @dev Codex #3489 r4 — set by the first finalized replacement and
        ///      NEVER cleared: the account is retired for good, whatever its
        ///      owner record later says. The Diamond's protected-mode rules
        ///      read this, not a comparison of the owner record.
        bool retired;
        /// @dev Codex #3489 r5 — how many locks this record has taken (each
        ///      `lock` / `lockByPlatform` call, repeat locks included). The
        ///      Diamond applies a lock's platform effects once per count, so
        ///      a lock taken after an unlock the Diamond never saw still
        ///      cancels the rows and changes queued since.
        uint64 lockCount;
        /// @dev Codex #3489 r11 — the last destination generation handed out;
        ///      every finalized allowlist addition takes the next one.
        ///      Appended.
        uint64 allowGen;
        /// @dev Codex #3489 r14 — how many times the signer set has gone
        ///      from non-empty to empty. The Diamond's co-sign requirement
        ///      binds only under the number it was set at, so removing the
        ///      last signer clears it for good, even before the platform
        ///      applies the removal: a signer added later never revives it.
        ///      Appended.
        uint64 signersEmptied;
        /// @dev Codex #3489 r16 — the last allowlist request number handed
        ///      out; every `addAllowlisted` takes the next one. Appended.
        uint64 allowRequests;
        // ─── #3246 part 2 — the recovery address and the clawback ───────
        /// @dev The recovery address in force (0 = none). Written only when a
        ///      pending setting matures into it ({VaultProtection}), or by a
        ///      clear while protected mode is off. A pending setting whose wait
        ///      has passed also counts as in force before it is written here
        ///      ({recoveryInForce} below). Appended.
        address recovery;
        /// @dev A pending first setting or change, the time it comes into
        ///      force, and the epoch it was asked in: a lock, a replacement, a
        ///      switch-off and a clawback advance the epoch, which drops it.
        ///      Appended.
        address pendingRecovery;
        uint64 pendingRecoveryAt;
        uint64 pendingRecoveryEpoch;
        /// @dev Set by the first clawback and never cleared: the account stays
        ///      locked, opens nothing and its positions cannot leave it.
        ///      Appended.
        bool recovered;
        uint64 recoveredAt;
    }

    /// @notice #3246 part 2 — THE rule for the recovery address in force:
    ///         a pending setting or change counts once its wait has passed,
    ///         but only while the epoch it was asked in is still current (a
    ///         lock, a replacement, a switch-off or a clawback advance the
    ///         epoch, which drops it), else the written address. 0 = none.
    ///         The protection code, the vault's own destination check and
    ///         every Diamond read use this one function.
    function recoveryInForce(Layout storage l) internal view returns (address) {
        address p = l.pendingRecovery;
        if (p != address(0) && l.pendingRecoveryEpoch == l.epoch && block.timestamp >= l.pendingRecoveryAt) {
            return p;
        }
        return l.recovery;
    }

    /// @notice The pending setting or change still alive (its epoch is the
    ///         current one and its wait has not passed), or 0.
    function recoveryPending(Layout storage l) internal view returns (address) {
        address p = l.pendingRecovery;
        if (p != address(0) && l.pendingRecoveryEpoch == l.epoch && block.timestamp < l.pendingRecoveryAt) {
            return p;
        }
        return address(0);
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 slot = SLOT;
        assembly {
            l.slot := slot
        }
    }
}
