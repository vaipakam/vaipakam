// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaultProtectionStorage as P} from "./LibVaultProtectionStorage.sol";
import {VaultOutflowTypes} from "./VaultOutflowTypes.sol";
import {VaultProtectionBase, IProtectedVaultSelf, IRecoveryClawbackApply} from "./VaultProtectionBase.sol";

/**
 * @title  VaultRecovery
 * @author Vaipakam Developer Team
 * @notice #3246 part 2 — the recovery address and the clawback, the one exit
 *         from a locked protected account
 *         (`docs/DesignsAndPlans/RecoveryAddressClawbackDesign.md`). Reached
 *         only through {VaultProtection}, which delegatecalls it for these
 *         selectors while running in a vault, so it writes the same record
 *         under the same authorization rules ({VaultProtectionBase}).
 * @dev    Stateless and not upgradeable; fixed in {VaultProtection}.
 */
contract VaultRecovery is VaultProtectionBase {
    // ─── #3246 part 2 — the recovery address ────────────────────────────

    /**
     * @notice Ask for `recovery` as the account's recovery address: the only
     *         place a clawback pays. The owner asks (`auth`), and the address
     *         itself proves control (`proof`: a direct call from it, or its
     *         signature naming this account and the Diamond). A first setting
     *         comes into force after twice the account's delay (twice
     *         {MIN_DELAY} while protected mode is off); a change after
     *         {RECOVERY_CHANGE_WAIT}, the current address staying in force
     *         until then. A new request replaces a pending one.
     * @dev    Works whether protected mode is on or off (switching it on needs
     *         an address set first). Refused while the account is locked or
     *         in a cool-down, like every loosening change, except on a
     *         recovered account, whose lock never lifts: there a change still
     *         waits the 30 days and the owner or any signer may cancel it
     *         (Default, ruling 2026-11-18).
     */
    function requestRecoveryAddress(address recovery, Auth calldata auth, Auth calldata proof)
        external
        onlyDelegateCall
    {
        P.Layout storage l = P.layout();
        _settleRecovery(l);
        if (l.recovered) _noCooldown(l);
        else _loosenable(l);
        _asOwner(
            auth,
            PURPOSE_RECOVERY,
            keccak256(abi.encode(RECOVERY_SET_TYPEHASH, recovery, _nonce(auth.key, PURPOSE_RECOVERY), auth.expiry))
        );
        _checkRecoveryIdentity(l, recovery);
        if (proof.key != recovery) revert BadRecovery(recovery);
        IProtectedVaultSelf self = IProtectedVaultSelf(address(this));
        _authorize(
            proof,
            PURPOSE_RECOVERY_PROOF,
            keccak256(
                abi.encode(
                    RECOVERY_PROOF_TYPEHASH,
                    self.vaultCreationOwner(),
                    self.vaultDiamond(),
                    _nonce(recovery, PURPOSE_RECOVERY_PROOF),
                    proof.expiry
                )
            )
        );
        address current = l.recovery;
        address replaced = l.pendingRecovery;
        uint64 at = uint64(block.timestamp)
            + (current == address(0) ? 2 * (l.enabled ? l.delay : MIN_DELAY) : RECOVERY_CHANGE_WAIT);
        l.pendingRecovery = recovery;
        l.pendingRecoveryAt = at;
        l.pendingRecoveryEpoch = l.epoch;
        emit RecoveryAddressRequested(_account(), recovery, at, auth.key);
        emit ProtectionRoleChanged(
            _account(), ROLE_RECOVERY_ADDRESS, replaced != address(0) ? replaced : current, recovery
        );
    }

    /// @notice Cancel the pending recovery address (the owner or any signer,
    ///         on the cancel lane). One that has already come into force is
    ///         not pending any more and cannot be cancelled.
    function cancelRecoveryAddress(Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = P.layout();
        _settleRecovery(l);
        address pending = l.pendingRecovery;
        _asOwnerOrSigner(
            auth,
            PURPOSE_ALLOWLIST_CANCEL,
            keccak256(
                abi.encode(RECOVERY_CANCEL_TYPEHASH, pending, _nonce(auth.key, PURPOSE_ALLOWLIST_CANCEL), auth.expiry)
            )
        );
        if (pending == address(0)) revert NotRequested();
        _clearPendingRecovery(l);
        emit RecoveryAddressCancelled(_account(), pending, auth.key);
        emit ProtectionRoleChanged(_account(), ROLE_RECOVERY_ADDRESS, pending, l.recovery);
    }

    /// @notice Clear the recovery address and any pending one (the owner),
    ///         only while protected mode is off (3.4; a switched-off account
    ///         has no signers). Switching protected mode off keeps it.
    function clearRecoveryAddress(Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = P.layout();
        if (l.enabled) revert RecoveryInUse();
        _settleRecovery(l);
        _asOwner(auth, PURPOSE_RECOVERY, keccak256(abi.encode(RECOVERY_CLEAR_TYPEHASH, _nonce(auth.key, PURPOSE_RECOVERY), auth.expiry)));
        address old = l.recovery != address(0) ? l.recovery : l.pendingRecovery;
        if (old == address(0)) revert NotRequested();
        l.recovery = address(0);
        _clearPendingRecovery(l);
        emit RecoveryAddressCleared(_account(), old, auth.key);
        emit ProtectionRoleChanged(_account(), ROLE_RECOVERY_ADDRESS, old, address(0));
    }

    /// @notice Write a pending recovery address that has come into force into
    ///         the record. Permissionless; nothing depends on it (the address
    ///         counts from its time on), it only tidies the record.
    function settleRecoveryAddress() external onlyDelegateCall {
        _settleRecovery(P.layout());
    }

    // ─── #3246 part 2 — the clawback ────────────────────────────────────

    /**
     * @notice Claw the account back to its recovery address in force: the
     *         free balance of every asset in `assets` moves there now, by the
     *         Diamond's {IRecoveryClawbackApply.applyClawback}. The owner or
     *         any signer (a direct call, or a signature anyone submits); it
     *         runs while the account is locked, whoever locked it.
     * @dev    The first clawback locks the account and marks it recovered
     *         for good: the lock's platform side lands with it (queued
     *         payouts cancelled back into the vault, so they are free and
     *         move too), every pending change dies with the epoch, and the
     *         recovered state never clears. A later call moves further
     *         assets. The recovery address itself may not trigger it, and no
     *         trigger chooses where it pays.
     */
    function clawback(VaultOutflowTypes.ClawbackAsset[] calldata assets, Auth calldata auth)
        external
        onlyDelegateCall
    {
        P.Layout storage l = _enabled();
        address owner = _owner();
        _asOwnerOrSigner(
            auth,
            PURPOSE_CLAWBACK,
            keccak256(
                abi.encode(
                    CLAWBACK_TYPEHASH, keccak256(abi.encode(assets)), _nonce(auth.key, PURPOSE_CLAWBACK), auth.expiry
                )
            )
        );
        uint8 role = auth.key == owner ? TRIGGER_OWNER : TRIGGER_SIGNER;
        _settleRecovery(l);
        address recovery = l.recovery;
        if (recovery == address(0)) revert RecoveryRequired();
        if (!l.recovered) {
            l.recovered = true;
            l.recoveredAt = uint64(block.timestamp);
            bool was = l.locked;
            if (!was) {
                l.locked = true;
                l.lockedAt = uint64(block.timestamp);
                l.lockedBy = auth.key;
            }
            l.pendingUnlockAt = 0;
            l.lockCount += 1;
            _dropPending(l);
            if (l.nominee != address(0) && l.proposedBy == owner) {
                emit ReplacementCancelled(_account(), l.nominee, auth.key);
                emit ProtectionRoleChanged(_account(), ROLE_RECOVERY_NOMINEE, l.nominee, address(0));
                _clearProposal(l);
            }
            emit VaultLocked(_account(), auth.key);
            emit AccountRecovered(_account(), recovery, auth.key, role);
            _applyPlatform();
        }
        IProtectedVaultSelf self = IProtectedVaultSelf(address(this));
        IRecoveryClawbackApply(self.vaultDiamond()).applyClawback(self.vaultCreationOwner(), auth.key, role, assets);
    }
}
