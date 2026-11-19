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
    // ─── #3756 — the recovery claim's constants (here, not in the shared
    //     base, so {VaultProtection} carries none of their getters) ───────

    /// @notice #3756 — the owner sets the recovery claim (12); the recovery
    ///         address asks for the account and runs a matured claim (13).
    ///         A cancel of either uses the cancel lane ({PURPOSE_ALLOWLIST_CANCEL}).
    uint8 public constant PURPOSE_RECOVERY_CLAIM_SETTING = 12;
    uint8 public constant PURPOSE_RECOVERY_CLAIM = 13;

    /// @notice #3756 — the bounds of the claim's wait, the window in which a
    ///         matured claim may run before it lapses, and the pause on a new
    ///         request after a claim was cancelled or dropped
    ///         (`RecoveryClaimDesign.md` 4.1, 4.4, 4.5).
    uint32 public constant CLAIM_MIN_WAIT = 30 days;
    uint32 public constant CLAIM_MAX_WAIT = 365 days;
    uint32 public constant CLAIM_RUN_WINDOW = 30 days;
    /// @notice #3756 — the recovery address ran a matured recovery claim.
    uint8 public constant TRIGGER_RECOVERY_CLAIM = 3;

    /// @notice #3756 — the owner switches the recovery claim on or off, or
    ///         sets its wait.
    bytes32 public constant RECOVERY_CLAIM_SETTING_TYPEHASH =
        keccak256("RecoveryClaimSetting(bool allowed,uint32 wait,uint256 nonce,uint64 expiry)");
    /// @notice The owner or a signer cancels the pending claim setting that
    ///         comes into force `at`.
    bytes32 public constant RECOVERY_CLAIM_SETTING_CANCEL_TYPEHASH =
        keccak256("RecoveryClaimSettingCancel(uint64 at,uint256 nonce,uint64 expiry)");
    /// @notice The recovery address asks for the account. It names the account
    ///         and the Diamond and, through the domain, the chain and vault.
    bytes32 public constant RECOVERY_CLAIM_REQUEST_TYPEHASH =
        keccak256("RecoveryClaimRequest(address account,address diamond,uint256 nonce,uint64 expiry)");
    /// @notice The owner or a signer cancels the open claim asked at
    ///         `requestedAt`, so a cancel signed for another claim ends nothing.
    bytes32 public constant RECOVERY_CLAIM_CANCEL_TYPEHASH =
        keccak256("RecoveryClaimCancel(uint64 requestedAt,uint256 nonce,uint64 expiry)");
    /// @notice The recovery address runs the claim asked at `requestedAt`;
    ///         `assets` is keccak256(abi.encode(the ClawbackAsset list)).
    bytes32 public constant RECOVERY_CLAIM_RUN_TYPEHASH =
        keccak256("RecoveryClaimRun(bytes32 assets,uint64 requestedAt,uint256 nonce,uint64 expiry)");

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

    // ─── #3246 part 2 — a replaced account's positions ──────────────────

    /**
     * @notice Ask to move this replaced account's position tokens to the
     *         wallet that replaced it (owner decision 2026-11-18: the move
     *         waits the delay and a lock stops it). Only that wallet, the
     *         account's owner record, asks (a direct call or its signature),
     *         and only once the replacement is complete. The tokens may move
     *         from one delay later until one further delay after that, by
     *         `PositionNFT.recover`, which anyone may call; the destination is
     *         always the owner record at that moment. A new request replaces a
     *         pending one.
     * @dev    A loosening change like the others: refused while the account
     *         is locked or in its cool-down, and dropped by a lock, a further
     *         replacement or a clawback (the epoch). A recovered account's
     *         positions never leave it, so it is refused there for good.
     *         Until the move applies nothing changes: the replacing wallet
     *         manages the account and its payouts follow the account's rules.
     */
    function requestPositionMove(Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = P.layout();
        if (!l.retired) revert NotReplaced();
        if (l.recovered) revert RecoveredAccount();
        _loosenable(l);
        address to = _asOwner(
            auth,
            PURPOSE_POSITION_MOVE,
            keccak256(
                abi.encode(POSITION_MOVE_TYPEHASH, _owner(), _nonce(auth.key, PURPOSE_POSITION_MOVE), auth.expiry)
            )
        );
        uint64 at = _later(l);
        l.positionMoveAt = at;
        l.positionMoveEpoch = l.epoch;
        emit PositionMoveRequested(_account(), to, at, auth.key);
    }

    /// @notice Cancel the pending position move (the owner or any signer, on
    ///         the cancel lane), matured or not.
    function cancelPositionMove(Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = P.layout();
        uint64 at = P.positionMovePending(l);
        _asOwnerOrSigner(
            auth,
            PURPOSE_ALLOWLIST_CANCEL,
            keccak256(
                abi.encode(POSITION_MOVE_CANCEL_TYPEHASH, at, _nonce(auth.key, PURPOSE_ALLOWLIST_CANCEL), auth.expiry)
            )
        );
        if (at == 0) revert NotRequested();
        l.positionMoveAt = 0;
        emit PositionMoveCancelled(_account(), at, auth.key);
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
     *         assets. The recovery address triggers it only by running a
     *         matured claim the owner allowed ({runRecoveryClaim}), and
     *         no trigger chooses where it pays.
     */
    function clawback(VaultOutflowTypes.ClawbackAsset[] calldata assets, Auth calldata auth)
        external
        onlyDelegateCall
    {
        P.Layout storage l = _enabled();
        _asOwnerOrSigner(
            auth,
            PURPOSE_CLAWBACK,
            keccak256(
                abi.encode(
                    CLAWBACK_TYPEHASH, keccak256(abi.encode(assets)), _nonce(auth.key, PURPOSE_CLAWBACK), auth.expiry
                )
            )
        );
        uint8 role = auth.key == _owner() ? TRIGGER_OWNER : TRIGGER_SIGNER;
        _settleRecovery(l);
        _clawback(l, auth.key, role, assets);
    }

    /// @dev THE clawback, whoever triggered it (the owner, a signer, or the
    ///      recovery address running a matured claim): what moves and the
    ///      state it leaves are the same for every trigger; only `role`
    ///      differs, and the Diamond's half reads it.
    function _clawback(
        P.Layout storage l,
        address key,
        uint8 role,
        VaultOutflowTypes.ClawbackAsset[] calldata assets
    ) private {
        address recovery = l.recovery;
        if (recovery == address(0)) revert RecoveryRequired();
        if (!l.recovered) {
            l.recovered = true;
            l.recoveredAt = uint64(block.timestamp);
            if (!l.locked) {
                l.locked = true;
                l.lockedAt = uint64(block.timestamp);
                l.lockedBy = key;
            }
            l.pendingUnlockAt = 0;
            l.lockCount += 1;
            _dropPending(l, key, CLAIM_END_CLAWBACK);
            if (l.nominee != address(0) && l.proposedBy == _owner()) {
                emit ReplacementCancelled(_account(), l.nominee, key);
                emit ProtectionRoleChanged(_account(), ROLE_RECOVERY_NOMINEE, l.nominee, address(0));
                _clearProposal(l);
            }
            emit VaultLocked(_account(), key);
            emit AccountRecovered(_account(), recovery, key, role);
            _applyPlatform();
        }
        IProtectedVaultSelf self = IProtectedVaultSelf(address(this));
        IRecoveryClawbackApply(self.vaultDiamond()).applyClawback(self.vaultCreationOwner(), key, role, assets);
    }

    // ─── #3756 — the recovery claim ─────────────────────────────────────
    //
    // `docs/DesignsAndPlans/RecoveryClaimDesign.md`: where the owner allowed
    // it, the recovery address may ask for the account, and run the clawback
    // itself once the owner's wait has passed with nobody cancelling. Nothing
    // on the account is restricted while a claim is open.

    /**
     * @notice Set the recovery claim (the owner): `allowed` with a `wait` of
     *         30 to 365 days between a request and its earliest run, or off
     *         (`allowed` false, `wait` 0).
     * @dev    Switching it off and lengthening the wait tighten, so they apply
     *         at once, also on a locked account; switching off ends an open
     *         claim and drops a pending change. Switching it on and shortening
     *         the wait loosen: each waits the account's delay, is refused
     *         while locked or in a cool-down, may be cancelled by the owner or
     *         any signer, and dies with a lock, a replacement or a clawback;
     *         the setting in force applies until then. Needs protected mode
     *         on and a recovery address set (pending or in force). A recovered
     *         account's setting never changes.
     */
    function setRecoveryClaim(bool allowed, uint32 wait, Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        if (l.recovered) revert RecoveredAccount();
        _settleRecovery(l);
        _settleClaimSetting(l);
        bytes32 h = keccak256(
            abi.encode(
                RECOVERY_CLAIM_SETTING_TYPEHASH,
                allowed,
                wait,
                _nonce(auth.key, PURPOSE_RECOVERY_CLAIM_SETTING),
                auth.expiry
            )
        );
        if (!allowed) {
            if (wait != 0) revert BadClaimWait(wait);
            if (!l.claimAllowed && l.pendingClaimWait == 0) revert ClaimSettingUnchanged();
            // Ended here, before the authorization, so a signed switch-off
            // ends the claim too and the event names the switch-off.
            _endClaim(l, auth.key, CLAIM_END_SWITCHED_OFF);
            _asOwner(auth, PURPOSE_RECOVERY_CLAIM_SETTING, h);
            l.claimAllowed = false;
            l.claimWait = 0;
            _clearPendingClaimSetting(l);
            emit RecoveryClaimSettingChanged(_account(), false, 0);
            return;
        }
        if (wait < CLAIM_MIN_WAIT || wait > CLAIM_MAX_WAIT) revert BadClaimWait(wait);
        if (!_hasRecovery(l)) revert RecoveryRequired();
        _asOwner(auth, PURPOSE_RECOVERY_CLAIM_SETTING, h);
        if (l.claimAllowed && wait >= l.claimWait) {
            if (wait == l.claimWait && l.pendingClaimWait == 0) revert ClaimSettingUnchanged();
            l.claimWait = wait;
            _clearPendingClaimSetting(l);
            emit RecoveryClaimSettingChanged(_account(), true, wait);
            return;
        }
        _loosenable(l);
        uint64 at = _later(l);
        l.pendingClaimWait = wait;
        l.pendingClaimAt = at;
        l.pendingClaimEpoch = l.epoch;
        emit RecoveryClaimSettingRequested(_account(), wait, at, auth.key);
    }

    /// @notice Cancel the pending switch-on or shortening of the claim (the
    ///         owner or any signer, on the cancel lane). A signed cancel names
    ///         the change's time, so it cannot cancel a later one.
    function cancelRecoveryClaimSetting(Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = P.layout();
        _settleClaimSetting(l);
        (, uint64 at) = P.claimSettingPending(l);
        _asOwnerOrSigner(
            auth,
            PURPOSE_ALLOWLIST_CANCEL,
            keccak256(
                abi.encode(
                    RECOVERY_CLAIM_SETTING_CANCEL_TYPEHASH, at, _nonce(auth.key, PURPOSE_ALLOWLIST_CANCEL), auth.expiry
                )
            )
        );
        if (at == 0) revert NotRequested();
        _clearPendingClaimSetting(l);
        emit RecoveryClaimSettingCancelled(_account(), at, auth.key);
    }

    /**
     * @notice The recovery address in force asks for the account (a direct
     *         call or its signature, naming the account and the Diamond). The
     *         claim may run from the request plus the wait in force until
     *         {CLAIM_RUN_WINDOW} later; neither date moves.
     * @dev    Refused unless the claim is allowed, while a change of recovery
     *         address is pending, while a claim is open, during the pause after
     *         a cancellation or drop, and on a recovered account. Accepted on
     *         a locked account: the clawback is the exit from one.
     */
    function requestRecoveryClaim(Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        if (l.recovered) revert RecoveredAccount();
        _settleRecovery(l);
        _settleClaimSetting(l);
        if (!l.claimAllowed) revert ClaimNotAllowed();
        if (P.recoveryPending(l) != address(0)) revert RecoveryChangePending();
        address recovery = l.recovery;
        if (recovery == address(0) || auth.key != recovery) revert NotRecovery(auth.key);
        if (P.claimOpen(l) != 0) revert ClaimOpen();
        if (block.timestamp < l.claimPauseUntil) revert ClaimPaused(l.claimPauseUntil);
        IProtectedVaultSelf self = IProtectedVaultSelf(address(this));
        _authorize(
            auth,
            PURPOSE_RECOVERY_CLAIM,
            keccak256(
                abi.encode(
                    RECOVERY_CLAIM_REQUEST_TYPEHASH,
                    self.vaultCreationOwner(),
                    self.vaultDiamond(),
                    _nonce(recovery, PURPOSE_RECOVERY_CLAIM),
                    auth.expiry
                )
            )
        );
        uint64 runnableAt = uint64(block.timestamp) + l.claimWait;
        uint64 lapsesAt = runnableAt + CLAIM_RUN_WINDOW;
        l.claimBy = recovery;
        l.claimRequestedAt = uint64(block.timestamp);
        l.claimRunnableAt = runnableAt;
        l.claimLapsesAt = lapsesAt;
        l.claimEpoch = l.epoch;
        emit RecoveryClaimRequested(_account(), recovery, uint64(block.timestamp), runnableAt, lapsesAt);
    }

    /// @notice Cancel the open claim (the owner or any signer, a direct call
    ///         or a signature naming the claim's request time, on the cancel
    ///         lane). Works on a locked account and at any time up to the run.
    ///         Starts the 30-day pause on a new request.
    function cancelRecoveryClaim(Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = P.layout();
        uint64 at = P.claimOpen(l);
        bytes32 h = keccak256(
            abi.encode(RECOVERY_CLAIM_CANCEL_TYPEHASH, at, _nonce(auth.key, PURPOSE_ALLOWLIST_CANCEL), auth.expiry)
        );
        if (at == 0) revert NoClaim();
        // Ended before the authorization so the owner's direct call is
        // reported as the cancel it is.
        _endClaim(l, auth.key, CLAIM_END_CANCEL);
        _asOwnerOrSigner(auth, PURPOSE_ALLOWLIST_CANCEL, h);
    }

    /**
     * @notice Run the open claim (the recovery address in force, a direct call
     *         or its signature naming the claim and the asset list): the
     *         clawback of {clawback}, recorded with {TRIGGER_RECOVERY_CLAIM}.
     * @dev    From the claim's earliest run until it lapses, while its epoch is
     *         the record's current one, and refused while a change of recovery
     *         address is pending. The Diamond's half also refuses it while the
     *         platform is paused and until 24 hours after a sequencer outage.
     */
    function runRecoveryClaim(VaultOutflowTypes.ClawbackAsset[] calldata assets, Auth calldata auth)
        external
        onlyDelegateCall
    {
        P.Layout storage l = _enabled();
        _settleRecovery(l);
        if (P.recoveryPending(l) != address(0)) revert RecoveryChangePending();
        address recovery = l.recovery;
        if (recovery == address(0) || auth.key != recovery) revert NotRecovery(auth.key);
        uint64 at = P.claimOpen(l);
        if (at == 0) revert NoClaim();
        if (block.timestamp < l.claimRunnableAt) revert NotReady(l.claimRunnableAt);
        _authorize(
            auth,
            PURPOSE_RECOVERY_CLAIM,
            keccak256(
                abi.encode(
                    RECOVERY_CLAIM_RUN_TYPEHASH,
                    keccak256(abi.encode(assets)),
                    at,
                    _nonce(recovery, PURPOSE_RECOVERY_CLAIM),
                    auth.expiry
                )
            )
        );
        _clearClaim(l);
        _clawback(l, recovery, TRIGGER_RECOVERY_CLAIM, assets);
    }
}
