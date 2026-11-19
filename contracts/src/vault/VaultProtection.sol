// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaultProtectionStorage as P} from "./LibVaultProtectionStorage.sol";
import {VaultProtectionBase, IProtectedVaultSelf, IPayoutRowsView} from "./VaultProtectionBase.sol";
import {VaultRecovery} from "./VaultRecovery.sol";

/**
 * @title  VaultProtection
 * @author Vaipakam Developer Team
 * @notice #3379 Stage B2 — the protected-mode rules of every Vaipakam vault,
 *         run by the vault itself (it delegatecalls this code) on the record in
 *         its own storage (`LibVaultProtectionStorage`). The vault is the only
 *         writer of that record; the Diamond reads it.
 * @dev    Stateless and not upgradeable. Its address is fixed in the vault
 *         code like the vault's other endpoints, so changing these rules is
 *         new vault code through the VaultBeacon's delay. Every write refuses a
 *         direct call ({onlyDelegateCall}).
 *
 *         **Who may act.** Each write names the key it acts for: the vault's
 *         owner, a secondary signer, or (for a verification) a destination.
 *         The key authorizes it in one of two forms:
 *         - a direct call from the key itself (an EOA or a contract wallet);
 *         - an EIP-712 signature by the key, submitted by anyone, checked
 *           through ERC-1271 for a contract wallet. Each purpose has its own
 *           typehash; every signature is bound to the chain and the vault (the
 *           domain), to the key's next nonce for that purpose, and to an
 *           expiry. A used nonce is spent; a key may burn its next nonce to
 *           void a signature it gave out.
 *
 *         **What it carries over unchanged from today's protected mode.** A
 *         2–5 day delay; at most five signers and five allowlisted
 *         destinations; a loosening change waits the delay and expires one
 *         further delay after it matures; any signer may cancel a pending
 *         change; a lock (by the owner or a signer, also signed and relayed)
 *         drops every pending change, and unlocking waits the delay; a
 *         replacement waits the delay from the owner's own proposal or from
 *         the moment a majority of at least three signers is reached.
 *
 *         **One event per record write**, named for what it changed.
 *
 *         **The recovery address and the clawback** (#3246 part 2) live in
 *         {VaultRecovery}, fixed in this code as {RECOVERY}: a selector this
 *         contract does not carry is delegatecalled there, still inside the
 *         vault, so the vault keeps one entry (`protect`) and one record.
 */
contract VaultProtection is VaultProtectionBase {
    /// @notice The recovery-address and clawback code (#3246 part 2), fixed
    ///         here like every other endpoint of the vault code.
    address public immutable RECOVERY;

    /// @notice The recovery code address holds no code.
    error RecoveryCodeMissing();

    /// @notice A selector neither this code nor {VaultRecovery}'s listed
    ///         endpoints carry. Refused here, by name, before anything runs.
    error UnknownProtectionSelector(bytes4 selector);

    constructor(address recovery) {
        if (recovery.code.length == 0) revert RecoveryCodeMissing();
        RECOVERY = recovery;
    }

    /// @dev {VaultRecovery}'s endpoints run in {RECOVERY}, still inside
    ///      the vault (a nested delegatecall keeps its storage and caller).
    ///      Any other selector is refused by name, so a selector added to
    ///      {VaultRecovery} reaches nothing until it is listed here too.
    ///      Refused on this contract's own storage.
    fallback() external {
        if (address(this) == SELF) revert NotDelegateCall();
        bytes4 sel = msg.sig;
        if (
            sel != VaultRecovery.requestRecoveryAddress.selector
                && sel != VaultRecovery.cancelRecoveryAddress.selector
                && sel != VaultRecovery.clearRecoveryAddress.selector
                && sel != VaultRecovery.settleRecoveryAddress.selector
                && sel != VaultRecovery.clawback.selector
                && sel != VaultRecovery.requestPositionMove.selector
                && sel != VaultRecovery.cancelPositionMove.selector
                && sel != VaultRecovery.setRecoveryClaim.selector
                && sel != VaultRecovery.cancelRecoveryClaimSetting.selector
                && sel != VaultRecovery.requestRecoveryClaim.selector
                && sel != VaultRecovery.cancelRecoveryClaim.selector
                && sel != VaultRecovery.runRecoveryClaim.selector
        ) revert UnknownProtectionSelector(sel);
        (bool ok, bytes memory ret) = RECOVERY.delegatecall(msg.data);
        // `ret` is a memory bytes this function already holds; both blocks
        // read only inside it and end the call.
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        assembly ("memory-safe") {
            return(add(ret, 0x20), mload(ret))
        }
    }

    // ─── Settings ───────────────────────────────────────────────────────

    /// @notice Turn protected mode on with `delay` (the owner).
    function enable(uint32 delay, Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = P.layout();
        if (l.enabled) revert AlreadyEnabled();
        _checkDelay(delay);
        // #3246 part 2 — protected mode needs its exit first: a recovery
        // address set, pending or in force (3.5).
        if (!_hasRecovery(l)) revert RecoveryRequired();
        _asOwner(auth, PURPOSE_SETTINGS, keccak256(abi.encode(SETTINGS_TYPEHASH, SETTINGS_ENABLE, uint256(delay), _nonce(auth.key, PURPOSE_SETTINGS), auth.expiry)));
        l.enabled = true;
        l.delay = delay;
        emit ProtectionEnabled(_account(), delay, auth.key);
        // Codex #3489 r16 / #3679 — the switch-on lands with its platform
        // side, like every other change of posture ({_applyPlatform}).
        _applyPlatform();
    }

    /// @notice Change the delay (the owner): a raise applies at once, a
    ///         lowering waits the current delay.
    function setDelay(uint32 delay, Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        _checkDelay(delay);
        _asOwner(auth, PURPOSE_SETTINGS, keccak256(abi.encode(SETTINGS_TYPEHASH, SETTINGS_DELAY, uint256(delay), _nonce(auth.key, PURPOSE_SETTINGS), auth.expiry)));
        if (delay >= l.delay) {
            l.delay = delay;
            l.pendingDelayAt = 0;
            emit ProtectionSettingApplied(_account(), SETTINGS_DELAY, delay);
            // Codex #3489 r16 / #3679 — a raise lifts the code-pin and NFT-lock
            // delays with it, in the same transaction; a platform whose
            // delays are already as long has nothing to apply.
            _applyPlatform();
            return;
        }
        _loosenable(l);
        l.pendingDelay = delay;
        l.pendingDelayAt = _later(l);
        emit ProtectionSettingRequested(_account(), SETTINGS_DELAY, delay, l.pendingDelayAt, auth.key);
    }

    /// @notice Ask to switch protected mode off (the owner); waits the delay.
    function requestDisable(Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        // Codex #3489 r5 — a replaced account stays protected for good: its
        // payouts keep their vault routing AND their delay (spec,
        // REPLACEMENT), so its protection cannot be switched off.
        if (l.retired) revert RetiredAccount();
        // #3246 part 2 — and a recovered one, whose recovered state never
        // clears (4.4).
        if (l.recovered) revert RecoveredAccount();
        _loosenable(l);
        _asOwner(auth, PURPOSE_SETTINGS, keccak256(abi.encode(SETTINGS_TYPEHASH, SETTINGS_DISABLE, uint256(0), _nonce(auth.key, PURPOSE_SETTINGS), auth.expiry)));
        l.pendingDisableAt = _later(l);
        emit ProtectionSettingRequested(_account(), SETTINGS_DISABLE, 0, l.pendingDisableAt, auth.key);
    }

    /// @notice Ask to unlock (the owner); waits the delay.
    function requestUnlock(Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        if (!l.locked) revert NotLocked();
        // #3246 part 2 — a recovered account's lock never lifts (4.4).
        if (l.recovered) revert RecoveredAccount();
        _noCooldown(l);
        _asOwner(auth, PURPOSE_SETTINGS, keccak256(abi.encode(SETTINGS_TYPEHASH, SETTINGS_UNLOCK, uint256(0), _nonce(auth.key, PURPOSE_SETTINGS), auth.expiry)));
        l.pendingUnlockAt = _later(l);
        emit ProtectionSettingRequested(_account(), SETTINGS_UNLOCK, 0, l.pendingUnlockAt, auth.key);
    }

    /// @notice Cancel a pending delay lowering, unlock or switch-off (the owner
    ///         or any signer, as an allowlist cancel).
    function cancelSetting(uint8 action, Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        _asOwnerOrSigner(auth, PURPOSE_ALLOWLIST_CANCEL, keccak256(abi.encode(SETTING_CANCEL_TYPEHASH, action, _nonce(auth.key, PURPOSE_ALLOWLIST_CANCEL), auth.expiry)));
        if (action == SETTINGS_DELAY) l.pendingDelayAt = 0;
        else if (action == SETTINGS_UNLOCK) l.pendingUnlockAt = 0;
        else if (action == SETTINGS_DISABLE) l.pendingDisableAt = 0;
        else revert NotRequested();
        emit ProtectionSettingCancelled(_account(), action, auth.key);
    }

    /// @notice Apply every matured setting change. Permissionless.
    function finalizeSettings() external onlyDelegateCall {
        P.Layout storage l = _enabled();
        uint64 nowTs = uint64(block.timestamp);
        bool applied;
        bool disabled;
        if (l.pendingDelayAt != 0 && nowTs >= l.pendingDelayAt) {
            applied = true;
            l.delay = l.pendingDelay;
            l.pendingDelayAt = 0;
            emit ProtectionSettingApplied(_account(), SETTINGS_DELAY, l.delay);
        }
        bool unlocked;
        if (l.pendingUnlockAt != 0 && nowTs >= l.pendingUnlockAt) {
            applied = true;
            unlocked = true;
            l.locked = false;
            l.lockedBy = address(0);
            l.lockedAt = 0;
            l.pendingUnlockAt = 0;
            emit ProtectionSettingApplied(_account(), SETTINGS_UNLOCK, 0);
        }
        if (l.pendingDisableAt != 0 && nowTs >= l.pendingDisableAt && !l.locked) {
            // A switch-off waits while any payout row is still queued (it
            // never holds back another due change); it reverts only when it
            // was the one change due. An unreadable count reads as rows open,
            // so a platform fault can only make the switch-off wait.
            if (_noOpenRows()) {
                _clear(l);
                emit ProtectionDisabled(_account());
                applied = true;
                disabled = true;
            } else if (!applied) {
                revert PendingRowsExist();
            }
        }
        // Codex #3489 r12 and the owner's security review — an unlock or a
        // switch-off applies its platform side in its own transaction, and
        // lands only with it ({_applyPlatform}). An unlock's application
        // also settles any lock the platform had not applied (the rows and
        // switch-off from before it cancelled) before a request after the
        // unlock can exist.
        if (unlocked || disabled) _applyPlatform();
    }

    function _noOpenRows() private view returns (bool) {
        IProtectedVaultSelf self = IProtectedVaultSelf(address(this));
        try IPayoutRowsView(self.vaultDiamond()).getPendingPayoutIds(self.vaultCreationOwner()) returns (
            uint256[] memory ids
        ) {
            return ids.length == 0;
        } catch {
            return false;
        }
    }

    // ─── Allowlist ──────────────────────────────────────────────────────

    /// @notice Ask to allow payouts to `destination` (the owner); it can be
    ///         finalized after the delay, within one further delay.
    function addAllowlisted(address destination, Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        // Codex #3489 r6 — a replaced account pays only its manager: it takes
        // no payout destination at all (its list was cleared at replacement).
        if (l.retired) revert RetiredAccount();
        _loosenable(l);
        _asOwner(auth, PURPOSE_ALLOWLIST_ADD, keccak256(abi.encode(ALLOWLIST_ADD_TYPEHASH, destination, _nonce(auth.key, PURPOSE_ALLOWLIST_ADD), auth.expiry)));
        P.Entry storage e = l.allow[destination];
        if (
            destination == address(0) || _isAccountWallet(destination) || destination == address(this) || e.active
                || _isRecovery(l, destination)
        ) {
            revert BadDestination(destination);
        }
        if (l.allowlist.length >= MAX_ALLOWLIST) revert TooMany();
        if (e.readyAt == 0 || e.epoch != l.epoch) {
            address[] storage pending = l.pendingAllow[l.epoch];
            if (pending.length >= MAX_ALLOWLIST) revert TooMany();
            pending.push(destination);
        }
        e.readyAt = _later(l);
        e.epoch = l.epoch;
        // A new request is confirmed afresh (owner review of #3489): a mark
        // left from an earlier, cancelled or voided request does not carry,
        // and neither does a signature given for one (Codex #3489 r16: the
        // verification names the request number).
        e.verified = false;
        e.request = ++l.allowRequests;
        emit AllowlistAddRequested(_account(), destination, e.readyAt, auth.key);
    }

    /// @notice Cancel a pending addition (the owner or any signer).
    function cancelAllowlisted(address destination, Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        _asOwnerOrSigner(auth, PURPOSE_ALLOWLIST_CANCEL, keccak256(abi.encode(ALLOWLIST_CANCEL_TYPEHASH, destination, _nonce(auth.key, PURPOSE_ALLOWLIST_CANCEL), auth.expiry)));
        P.Entry storage e = l.allow[destination];
        if (e.active || e.readyAt == 0 || e.epoch != l.epoch) revert NotRequested();
        e.readyAt = 0;
        e.verified = false;
        _remove(l.pendingAllow[l.epoch], destination);
        emit AllowlistAddCancelled(_account(), destination, auth.key);
    }

    /// @notice Activate a matured addition. Permissionless; only in its window
    ///         and only if no lock or switch-off came after it was asked.
    function finalizeAllowlisted(address destination) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        if (l.locked) revert Locked();
        P.Entry storage e = l.allow[destination];
        if (e.active || e.readyAt == 0 || e.epoch != l.epoch) revert NotRequested();
        // #3246 part 2 — checked again at finalization (3.1).
        if (_isRecovery(l, destination)) revert BadDestination(destination);
        _inWindow(l, e.readyAt);
        if (l.allowlist.length >= MAX_ALLOWLIST) revert TooMany();
        e.active = true;
        e.readyAt = 0;
        // A fresh generation each time: a payout queued to an earlier
        // activation of this address never pays this one (Codex #3489 r11).
        e.gen = ++l.allowGen;
        _remove(l.pendingAllow[l.epoch], destination);
        l.allowlist.push(destination);
        emit AllowlistAdded(_account(), destination);
    }

    /// @notice Remove `destination` at once (the owner or any signer).
    function removeAllowlisted(address destination, Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        _asOwnerOrSigner(auth, PURPOSE_ALLOWLIST_CANCEL, keccak256(abi.encode(ALLOWLIST_REMOVE_TYPEHASH, destination, _nonce(auth.key, PURPOSE_ALLOWLIST_CANCEL), auth.expiry)));
        if (!l.allow[destination].active) revert BadDestination(destination);
        _dropAllow(l, destination);
        emit AllowlistRemoved(_account(), destination, auth.key);
    }

    /// @notice #3415 — the destination itself confirms it is a destination of
    ///         this account: a direct call from it, or its own signature naming
    ///         the account, the Diamond, the chain and the vault. Sets the
    ///         entry's `verified` flag (pending or active entry).
    function verifyDestination(address account, address diamond, Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        // The destination confirms THIS account on THIS platform: both named
        // fields must be the vault's own (its creation owner and Diamond).
        IProtectedVaultSelf self = IProtectedVaultSelf(address(this));
        if (account != self.vaultCreationOwner() || diamond != self.vaultDiamond()) revert BadDestination(auth.key);
        address destination = auth.key;
        P.Entry storage e = l.allow[destination];
        // An active entry, or an addition pending in the current epoch (a
        // cancelled one, or one a lock, a replacement or a switch-off voided,
        // cannot be verified).
        if (!e.active && (e.readyAt == 0 || e.epoch != l.epoch)) revert BadDestination(destination);
        _authorize(
            auth,
            PURPOSE_VERIFY,
            keccak256(abi.encode(VERIFY_TYPEHASH, account, diamond, e.request, _nonce(destination, PURPOSE_VERIFY), auth.expiry))
        );
        e.verified = true;
        emit DestinationVerified(_account(), destination);
    }

    // ─── Secondary signers ──────────────────────────────────────────────

    /// @notice Signer changes: the owner adds, the nominee accepts with its own
    ///         key, the owner asks a removal, the owner or any signer cancels a
    ///         pending one. Each addition or removal matures after the delay
    ///         and is applied by {finalizeSigner}.
    function signerChange(uint8 action, address who, Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        bytes32 h = keccak256(abi.encode(SIGNER_CHANGE_TYPEHASH, action, who, _nonce(auth.key, PURPOSE_SIGNER_CHANGE), auth.expiry));
        P.Signer storage sg = l.signer[who];
        if (action == SIGNER_ADD) {
            _loosenable(l);
            _asOwner(auth, PURPOSE_SIGNER_CHANGE, h);
            // Neither of the account's own wallets may become its signer: the
            // original (retired) wallet has lost every right, the current one
            // manages it (Codex #3489 r7).
            if (_isAccountWallet(who)) revert NomineeIsAccountWallet(who);
            if (who == address(0) || sg.active || l.allow[who].active) revert BadNominee(who);
            // #3246 part 2 — a signer needs the exit first (3.5), and is
            // never the recovery address (3.1).
            if (!_hasRecovery(l)) revert RecoveryRequired();
            if (_isRecovery(l, who)) revert BadNominee(who);
            if (l.signers.length >= MAX_SIGNERS) revert TooMany();
            if (sg.addAt == 0 || sg.epoch != l.epoch) {
                address[] storage pending = l.pendingSigners[l.epoch];
                if (pending.length >= MAX_SIGNERS) revert TooMany();
                pending.push(who);
            }
            sg.addAt = _later(l);
            sg.epoch = l.epoch;
            sg.accepted = false;
            emit SignerAddRequested(_account(), who, sg.addAt, auth.key);
        } else if (action == SIGNER_ACCEPT) {
            if (auth.key != who || sg.addAt == 0 || sg.epoch != l.epoch) revert NotRequested();
            _authorize(auth, PURPOSE_SIGNER_CHANGE, h);
            sg.accepted = true;
            emit SignerAccepted(_account(), who);
        } else if (action == SIGNER_REMOVE) {
            _loosenable(l);
            _asOwner(auth, PURPOSE_SIGNER_CHANGE, h);
            if (!sg.active) revert NotSigner(who);
            sg.removeAt = _later(l);
            sg.epoch = l.epoch;
            emit SignerRemoveRequested(_account(), who, sg.removeAt, auth.key);
        } else if (action == SIGNER_CANCEL) {
            // The nominee may withdraw its own pending nomination; anyone else
            // must be the owner or an active signer. A signer may never cancel
            // its OWN removal (Codex #3489 r6): that would let the signer being
            // revoked veto the owner's decision.
            if (auth.key == who) {
                if (sg.addAt == 0) revert CannotCancelOwnRemoval(who);
                _authorize(auth, PURPOSE_SIGNER_CHANGE, h);
            } else {
                _asOwnerOrSigner(auth, PURPOSE_SIGNER_CHANGE, h);
            }
            if ((sg.addAt == 0 && sg.removeAt == 0) || sg.epoch != l.epoch) revert NotRequested();
            if (sg.addAt != 0) _remove(l.pendingSigners[l.epoch], who);
            sg.addAt = 0;
            sg.removeAt = 0;
            sg.accepted = false;
            emit SignerChangeCancelled(_account(), who, auth.key);
        } else {
            revert NotRequested();
        }
    }

    /// @notice Apply a matured, accepted addition or a matured removal.
    ///         Permissionless; within the window and the epoch it was asked in.
    function finalizeSigner(address who) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        P.Signer storage sg = l.signer[who];
        if (sg.epoch != l.epoch) revert NotRequested();
        if (sg.addAt != 0) {
            if (l.locked) revert Locked();
            if (!sg.accepted) revert NotRequested();
            // Re-checked here: a replacement between the request and now may
            // have made the nominee one of the account's own wallets.
            if (_isAccountWallet(who)) revert NomineeIsAccountWallet(who);
            // #3246 part 2 — finalizing a signer needs a recovery address IN
            // FORCE; without one the addition stays pending until it expires
            // (3.5). And the signer is never the recovery address (3.1).
            if (P.recoveryInForce(l) == address(0)) revert RecoveryRequired();
            if (_isRecovery(l, who)) revert BadNominee(who);
            _inWindow(l, sg.addAt);
            if (l.signers.length >= MAX_SIGNERS) revert TooMany();
            sg.addAt = 0;
            sg.active = true;
            _remove(l.pendingSigners[l.epoch], who);
            l.signers.push(who);
            emit SignerAdded(_account(), who);
            emit ProtectionRoleChanged(_account(), ROLE_SIGNER, address(0), who);
        } else if (sg.removeAt != 0) {
            // The expiry window is for ADDITIONS only (spec; Codex #3489 r5):
            // a matured removal stays executable until it is applied or
            // cancelled, so an owner who returns late need not start over.
            if (block.timestamp < sg.removeAt) revert NotReady(sg.removeAt);
            sg.removeAt = 0;
            sg.active = false;
            sg.accepted = false;
            _dropSigner(l, who);
            emit SignerRemoved(_account(), who);
            emit ProtectionRoleChanged(_account(), ROLE_SIGNER, who, address(0));
        } else {
            revert NotRequested();
        }
    }

    // ─── Lock ───────────────────────────────────────────────────────────

    /// @notice Lock the vault (the owner or any signer; a signed lock may be
    ///         submitted by anyone, #3423). Drops every pending change and the
    ///         owner's own replacement proposal; a signer-majority proposal is
    ///         the recovery itself and survives. Unlocking waits the delay.
    function lock(Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        _asOwnerOrSigner(auth, PURPOSE_LOCK, keccak256(abi.encode(LOCK_TYPEHASH, _nonce(auth.key, PURPOSE_LOCK), auth.expiry)));
        bool was = l.locked;
        if (!was) {
            l.locked = true;
            l.lockedAt = uint64(block.timestamp);
        }
        // A lock a signer holds keeps its signer origin against a repeat lock
        // by the owner: that origin bars the owner from redirecting a recovery.
        if (!was || !l.signer[l.lockedBy].active) l.lockedBy = auth.key;
        l.pendingUnlockAt = 0;
        l.lockCount += 1;
        _dropPending(l, auth.key, CLAIM_END_LOCK);
        if (l.nominee != address(0) && l.proposedBy == _owner()) {
            emit ReplacementCancelled(_account(), l.nominee, auth.key);
            emit ProtectionRoleChanged(_account(), ROLE_RECOVERY_NOMINEE, l.nominee, address(0));
            _clearProposal(l);
        }
        emit VaultLocked(_account(), auth.key);
        // Codex #3489 r9 — the lock's platform side lands with it: the Diamond's
        // permissionless application cancels the queued payouts and the
        // platform-held pending changes and holds the position NFTs. Strict
        // (owner security review): a lock never lands without it. Every queued
        // row and pending switch-off also carries the lock count it predates.
        _applyPlatform();
    }

    /// @notice The platform locks the vault (its keeper relaying a LOCK the
    ///         owner sent from a linked chat, under the owner's keeper grant,
    ///         which the Diamond checks). Only the Diamond may call it, and
    ///         only to lock: a lock only stops value leaving, and only the
    ///         owner may unlock, after the delay. Same effects as {lock}.
    function lockByPlatform(address by) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        if (msg.sender != IProtectedVaultSelf(address(this)).vaultDiamond()) revert NotOwnerOrSigner(msg.sender);
        bool was = l.locked;
        if (!was) {
            l.locked = true;
            l.lockedAt = uint64(block.timestamp);
            l.lockedBy = by;
        }
        l.pendingUnlockAt = 0;
        l.lockCount += 1;
        _dropPending(l, by, CLAIM_END_LOCK);
        if (l.nominee != address(0) && l.proposedBy == _owner()) {
            emit ReplacementCancelled(_account(), l.nominee, by);
            emit ProtectionRoleChanged(_account(), ROLE_RECOVERY_NOMINEE, l.nominee, address(0));
            _clearProposal(l);
        }
        emit VaultLocked(_account(), by);
    }

    // ─── Replacement of the primary ─────────────────────────────────────

    /// @notice Propose, approve or cancel a replacement of the owner wallet.
    ///         The owner's own proposal is ready after the delay. A signer's
    ///         needs at least three active signers and a majority approving;
    ///         the delay starts when the majority is reached. Any signer may
    ///         cancel; the owner may not while a lock a signer placed holds.
    function replacement(uint8 action, address nominee, Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        bytes32 h = keccak256(
            abi.encode(REPLACEMENT_TYPEHASH, action, nominee, l.round, _nonce(auth.key, PURPOSE_REPLACEMENT), auth.expiry)
        );
        address owner = _owner();
        bool bySigner = auth.key != owner;
        if (bySigner) {
            if (!l.signer[auth.key].active) revert NotOwnerOrSigner(auth.key);
        } else if (l.locked && l.signer[l.lockedBy].active) {
            revert OwnerBlockedBySignerLock();
        }
        _authorize(auth, PURPOSE_REPLACEMENT, h);
        if (action == REPLACE_PROPOSE) {
            if (bySigner && l.signers.length < MIN_RECOVERY_SIGNERS) {
                revert NotEnoughSigners(l.signers.length, MIN_RECOVERY_SIGNERS);
            }
            if (_isAccountWallet(nominee)) revert NomineeIsAccountWallet(nominee);
            if (nominee == address(0) || nominee == address(this) || l.signer[nominee].active || _isRecovery(l, nominee)) {
                revert BadNominee(nominee);
            }
            emit ProtectionRoleChanged(_account(), ROLE_RECOVERY_NOMINEE, l.nominee, nominee);
            l.nominee = nominee;
            l.proposedBy = auth.key;
            l.round += 1;
            l.readyAt = 0;
            emit ReplacementProposed(_account(), nominee, auth.key, l.round);
            if (!bySigner) {
                l.readyAt = _later(l);
                emit ReplacementScheduled(_account(), nominee, l.readyAt);
            } else {
                _approve(l, auth.key);
            }
        } else if (action == REPLACE_APPROVE) {
            if (!bySigner) revert NotSigner(auth.key);
            if (l.nominee == address(0) || l.nominee != nominee) revert NoProposal();
            _approve(l, auth.key);
        } else if (action == REPLACE_CANCEL) {
            // A cancel acts only on the proposal it names (Codex #3489 r2):
            // the nominee is checked here, the round is in the signed hash.
            if (l.nominee == address(0) || l.nominee != nominee) revert NoProposal();
            emit ReplacementCancelled(_account(), l.nominee, auth.key);
            emit ProtectionRoleChanged(_account(), ROLE_RECOVERY_NOMINEE, l.nominee, address(0));
            _clearProposal(l);
        } else {
            revert NoProposal();
        }
    }

    /// @notice Carry out a replacement whose delay has passed. Permissionless.
    ///         The nominee becomes the vault's owner record (the payee of the
    ///         owner class and the signer of every later owner authorization);
    ///         the old wallet loses both at once. The lock, every pending
    ///         change and the allowlist are cleared, and the new owner starts a
    ///         cool-down of one delay.
    function finalizeReplacement() external onlyDelegateCall {
        P.Layout storage l = _enabled();
        address nominee = l.nominee;
        if (nominee == address(0)) revert NoProposal();
        if (l.readyAt == 0 || block.timestamp < l.readyAt) revert NotReady(l.readyAt);
        address previous = _owner();
        if (l.proposedBy != previous) {
            (uint256 approvals, uint256 threshold) = _tally(l);
            if (l.signers.length < MIN_RECOVERY_SIGNERS || approvals < threshold) revert NotReady(l.readyAt);
        }
        if (l.signer[nominee].active || _isRecovery(l, nominee)) revert BadNominee(nominee);
        _clearProposal(l);
        // #3246 part 2 — a recovered account stays locked through a
        // replacement (4.4, 4.5); any other replacement lifts the lock.
        if (!l.recovered) {
            l.locked = false;
            l.lockedBy = address(0);
            l.lockedAt = 0;
        }
        l.pendingUnlockAt = 0;
        _dropPending(l, address(0), CLAIM_END_REPLACEMENT);
        while (l.allowlist.length != 0) _dropAllow(l, l.allowlist[l.allowlist.length - 1]);
        l.cooldownUntil = _later(l);
        l.retired = true; // one-way (Codex #3489 r4)
        IProtectedVaultSelf(address(this)).setOwnerFromProtection(nominee);
        emit PrimaryReplaced(_account(), previous, nominee, l.cooldownUntil);
        emit ProtectionRoleChanged(_account(), ROLE_OWNER, previous, nominee);
        emit ProtectionRoleChanged(_account(), ROLE_RECOVERY_NOMINEE, nominee, address(0));
        // Codex #3489 r10 — the platform side lands WITH the replacement, or
        // the replacement does not land: the retired wallet's positions are
        // held and its rows cancelled in this transaction, so there is no
        // window in which it can move them. (A finalizer anyone may retry.)
        _applyPlatform();
    }

    // ─── Nonces ─────────────────────────────────────────────────────────

    /// @notice Burn the caller's next nonce for `purpose`, voiding any
    ///         signature it gave out with it. Direct call only. A burn the
    ///         owner's key sends itself is a direct write to the protected
    ///         record, so it ends an open recovery claim (#3756 4.4), as
    ///         `_authorize` does for every other direct owner write; another
    ///         key's burn ends nothing.
    function burnNonce(uint8 purpose) external onlyDelegateCall {
        P.Layout storage l = P.layout();
        uint256 n = l.nonces[msg.sender][purpose]++;
        emit NonceBurned(_account(), msg.sender, purpose, n);
        if (l.claimRequestedAt != 0 && msg.sender == _owner()) _endClaim(l, msg.sender, CLAIM_END_OWNER_CALL);
    }
}
