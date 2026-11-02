// src/facets/ProtectedAccountFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibProtectedAccount} from "../libraries/LibProtectedAccount.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";

/// @dev The one vault-resolution route, reached by self-call so enabling
///      the mode always leaves the owner with a vault.
interface IVaultResolver {
    function getOrCreateUserVault(address user) external returns (address proxy);
}

/**
 * @title ProtectedAccountFacet
 * @author Vaipakam Developer Team
 * @notice The settings of protected account mode: switching it on and off,
 *         the delay, NFT protection, the co-sign requirement, the allowlist
 *         of payout destinations, the secondary signers, the lock and the
 *         replacement of a lost or stolen primary wallet.
 * @dev    The rule this facet applies to every setting: a change that can
 *         only REDUCE what a thief holding the primary key could take is
 *         immediate (switching on, locking, raising the delay, removing a
 *         destination, turning NFT protection or co-signing on, cancelling);
 *         a change that could INCREASE it waits the account's delay and can
 *         be cancelled by the owner or any secondary signer in the meantime
 *         (switching off, lowering the delay, adding a destination or a
 *         signer, removing a signer, turning a protection off, unlocking).
 *
 *         A new primary installed by a replacement spends one full delay in
 *         a cool-down during which every loosening change is refused, so the
 *         honest signers keep a window to react if the replacement itself
 *         was hostile.
 *
 *         Locking and cancelling work during a pause (they move nothing);
 *         everything else needs the Diamond live. Writes go through
 *         `LibProtectedAccount` storage only; the payout and position rows
 *         live in `VaultPayoutFacet` and `VaipakamNFTFacet`.
 */
contract ProtectedAccountFacet is DiamondReentrancyGuard, DiamondPausable {
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @notice Pending setting kinds, for {cancelSettingChange}.
    uint8 internal constant CHANGE_DISABLE = 1;
    uint8 internal constant CHANGE_LOWER_DELAY = 2;
    uint8 internal constant CHANGE_NFT_OFF = 3;
    uint8 internal constant CHANGE_COSIGN_OFF = 4;
    uint8 internal constant CHANGE_UNLOCK = 5;
    uint8 internal constant CHANGE_UNPIN = 6;

    // ─── Events ──────────────────────────────────────────────────────────

    /// @custom:event-category state-change/vault-mutation
    event ProtectedModeEnabled(address indexed account, uint32 delaySeconds, bool protectNfts);
    /// @custom:event-category state-change/vault-mutation
    event ProtectedModeDisabled(address indexed account);
    /// @notice A loosening change was requested; it takes effect at
    ///         `effectiveAt` unless cancelled. `value` carries the new delay
    ///         for a lower-delay request, zero otherwise.
    /// @custom:event-category state-change/vault-mutation
    event SettingChangeRequested(address indexed account, uint8 indexed kind, uint256 value, uint256 effectiveAt);
    /// @custom:event-category state-change/vault-mutation
    event SettingChangeCancelled(address indexed account, uint8 indexed kind, address by);
    /// @custom:event-category state-change/vault-mutation
    event SettingChangeApplied(address indexed account, uint8 indexed kind);
    /// @custom:event-category state-change/vault-mutation
    event ProtectedDelaySet(address indexed account, uint32 oldDelay, uint32 newDelay);
    /// @custom:event-category state-change/vault-mutation
    event ProtectNftsSet(address indexed account, bool on);
    /// @custom:event-category state-change/vault-mutation
    event CosignRequirementSet(address indexed account, bool on);
    /// @custom:event-category state-change/vault-mutation
    event AllowlistAddRequested(address indexed account, address indexed destination, uint256 effectiveAt);
    /// @custom:event-category state-change/vault-mutation
    event AllowlistAddCancelled(address indexed account, address indexed destination, address by);
    /// @custom:event-category state-change/vault-mutation
    event AllowlistAdded(address indexed account, address indexed destination);
    /// @custom:event-category state-change/vault-mutation
    event AllowlistRemoved(address indexed account, address indexed destination, address by);
    /// @custom:event-category state-change/vault-mutation
    event SignerAddRequested(address indexed account, address indexed signer, uint256 effectiveAt);
    /// @custom:event-category state-change/vault-mutation
    event SignerAccepted(address indexed account, address indexed signer);
    /// @custom:event-category state-change/vault-mutation
    event SignerAddCancelled(address indexed account, address indexed signer, address by);
    /// @custom:event-category state-change/vault-mutation
    event SignerAdded(address indexed account, address indexed signer);
    /// @custom:event-category state-change/vault-mutation
    event SignerRemoveRequested(address indexed account, address indexed signer, uint256 effectiveAt);
    /// @custom:event-category state-change/vault-mutation
    event SignerRemoveCancelled(address indexed account, address indexed signer, address by);
    /// @custom:event-category state-change/vault-mutation
    event SignerRemoved(address indexed account, address indexed signer);
    /// @custom:event-category state-change/vault-mutation
    event VaultLocked(address indexed account, address indexed by);
    /// @custom:event-category state-change/vault-mutation
    event VaultUnlocked(address indexed account);
    /// @custom:event-category state-change/vault-mutation
    event ReplacementProposed(address indexed account, address indexed nominee, address indexed by, uint32 round);
    /// @custom:event-category state-change/vault-mutation
    event ReplacementApproved(
        address indexed account, address indexed nominee, address indexed signer, uint256 approvals, uint256 threshold
    );
    /// @custom:event-category state-change/vault-mutation
    event ReplacementScheduled(address indexed account, address indexed nominee, uint256 readyAt);
    /// @custom:event-category state-change/vault-mutation
    event ReplacementCancelled(address indexed account, address indexed nominee, address by);
    /// @notice `account` was retired; `controller` now manages it and every
    ///         payout it makes goes to `controller`, through the delay.
    /// @custom:event-category state-change/vault-mutation
    event PrimaryReplaced(address indexed account, address indexed controller, uint256 cooldownUntil);

    // ─── Internal guards ─────────────────────────────────────────────────

    function _acct(address account) private view returns (LibVaipakam.ProtectedAccount storage a) {
        a = LibVaipakam.storageSlot().protectedAccount[account];
        if (!a.enabled) revert LibProtectedAccount.ProtectedModeOff(account);
    }

    /// @dev The caller must be `account`'s manager.
    function _requireManager(address account) private view returns (LibVaipakam.ProtectedAccount storage a) {
        a = _acct(account);
        if (msg.sender != (a.retired ? a.controller : account)) {
            revert LibProtectedAccount.NotAccountManager(account, msg.sender);
        }
    }

    /// @dev The caller must be `account`'s manager or an active signer.
    function _requireManagerOrSigner(address account) private view returns (LibVaipakam.ProtectedAccount storage a) {
        a = _acct(account);
        if (
            msg.sender != (a.retired ? a.controller : account)
                && !LibVaipakam.storageSlot().protectedSigners[account].contains(msg.sender)
        ) revert LibProtectedAccount.NotManagerOrSigner(account, msg.sender);
    }

    /// @dev A loosening change: refused during a new primary's cool-down.
    function _requireNoCooldown(LibVaipakam.ProtectedAccount storage a) private view {
        if (block.timestamp < a.cooldownUntil) revert LibProtectedAccount.PrimaryInCooldown(a.cooldownUntil);
    }

    /// @dev A loosening change other than an unlock: refused during the
    ///      cool-down and while the account is locked (a lock is an
    ///      emergency; the only way out of it is the delayed unlock).
    function _requireLoosenable(address account, LibVaipakam.ProtectedAccount storage a) private view {
        _requireNoCooldown(a);
        if (a.locked) revert LibProtectedAccount.ProtectedVaultLocked(account);
    }

    function _matured(uint64 at) private view {
        if (at == 0) revert LibProtectedAccount.ChangeNotRequested();
        if (block.timestamp < at) revert LibProtectedAccount.ChangeNotMatured(at);
    }

    function _later(LibVaipakam.ProtectedAccount storage a) private view returns (uint64) {
        return uint64(block.timestamp) + a.delaySeconds;
    }

    /// @dev `account`'s change epoch. A lock, a primary replacement and a
    ///      switch-off advance it, voiding every allowlist and signer change
    ///      requested before.
    function _epoch(address account) private view returns (uint64) {
        return LibVaipakam.storageSlot().protectedChangeEpoch[account];
    }

    /// @dev Void every pending allowlist addition and signer change of
    ///      `account` at once (they are mappings, so they are voided by
    ///      epoch, not swept).
    function _voidPendingChanges(address account) private {
        ++LibVaipakam.storageSlot().protectedChangeEpoch[account];
    }

    /// @dev Drop every pending change on `account`: the allowlist additions
    ///      and signer changes (voided by epoch) and every setting change.
    ///      The one rule a lock and a primary replacement share, so a change
    ///      a thief or an outgoing key requested cannot mature through
    ///      either.
    function _dropPendingChanges(address account, LibVaipakam.ProtectedAccount storage a) private {
        _voidPendingChanges(account);
        a.pendingUnlockAt = 0;
        a.pendingDisableAt = 0;
        a.pendingDelay = 0;
        a.pendingDelayAt = 0;
        a.pendingNftOffAt = 0;
        a.pendingCosignOffAt = 0;
        a.pendingUnpinAt = 0;
    }

    /// @dev `at` if the change was requested in the current epoch, else 0
    ///      (a voided change reads as none).
    function _live(address account, uint64 at, uint64 epoch) private view returns (uint64) {
        return epoch == _epoch(account) ? at : 0;
    }

    /// @dev Refuse a matured change once its finalize window, one further
    ///      delay, has passed. Every delayed change that a nominee or anyone
    ///      finalizes has the same window, so a stale addition cannot be
    ///      activated long after the account last looked at it.
    function _withinWindow(LibVaipakam.ProtectedAccount storage a, uint64 at) private view {
        if (block.timestamp > uint256(at) + a.delaySeconds) {
            revert LibProtectedAccount.ChangeExpired(uint256(at) + a.delaySeconds);
        }
    }

    function _checkDelay(uint32 delay) private pure {
        if (delay < LibProtectedAccount.MIN_DELAY || delay > LibProtectedAccount.MAX_DELAY) {
            revert LibProtectedAccount.DelayOutOfBounds(LibProtectedAccount.MIN_DELAY, LibProtectedAccount.MAX_DELAY);
        }
    }

    // ─── On and off ──────────────────────────────────────────────────────

    /**
     * @notice Switch protected account mode on for the caller's account.
     *         Immediate: it can only reduce what a thief could take.
     * @dev    Creates the caller's vault if missing (the mode's payouts and
     *         credits need one). Tier-1: a sanctioned wallet is refused by the
     *         vault resolution. The owner wallet is always an allowed payout
     *         destination; the allowlist starts empty besides.
     * @param delaySeconds How long every payout and loosening change waits,
     *        within `MIN_DELAY`..`MAX_DELAY`.
     * @param protectNfts  Whether the account's position NFTs move only
     *        through a queued transfer.
     */
    function enableProtectedMode(uint32 delaySeconds, bool protectNfts) external nonReentrant whenNotPaused {
        LibVaipakam.ProtectedAccount storage a = LibVaipakam.storageSlot().protectedAccount[msg.sender];
        if (a.enabled) revert LibProtectedAccount.ProtectedModeAlreadyOn(msg.sender);
        _checkDelay(delaySeconds);
        IVaultResolver(address(this)).getOrCreateUserVault(msg.sender);
        a.enabled = true;
        a.delaySeconds = delaySeconds;
        a.protectNfts = protectNfts;
        emit ProtectedModeEnabled(msg.sender, delaySeconds, protectNfts);
    }

    /**
     * @notice Ask to switch the mode off. Takes effect after the delay, by
     *         anyone's {finalizeSettingChanges}, unless cancelled; and only
     *         once no payout or transfer is still queued.
     */
    function requestDisableProtectedMode() external nonReentrant whenNotPaused {
        LibVaipakam.ProtectedAccount storage a = _requireManager(msg.sender);
        if (a.retired) revert LibProtectedAccount.AccountRetired(msg.sender);
        _requireLoosenable(msg.sender, a);
        a.pendingDisableAt = _later(a);
        emit SettingChangeRequested(msg.sender, CHANGE_DISABLE, 0, a.pendingDisableAt);
    }

    // ─── Delay, NFT protection, co-sign ──────────────────────────────────

    /**
     * @notice Set the account's delay. Raising it is immediate and clears any
     *         pending lower; lowering it waits the CURRENT delay.
     */
    function setProtectedDelay(address account, uint32 delaySeconds) external nonReentrant whenNotPaused {
        LibVaipakam.ProtectedAccount storage a = _requireManager(account);
        _checkDelay(delaySeconds);
        uint32 old = a.delaySeconds;
        if (delaySeconds >= old) {
            a.delaySeconds = delaySeconds;
            a.pendingDelay = 0;
            a.pendingDelayAt = 0;
            emit ProtectedDelaySet(account, old, delaySeconds);
            return;
        }
        _requireLoosenable(account, a);
        a.pendingDelay = delaySeconds;
        a.pendingDelayAt = _later(a);
        emit SettingChangeRequested(account, CHANGE_LOWER_DELAY, delaySeconds, a.pendingDelayAt);
    }

    /// @notice Turn NFT protection on (immediate) or off (waits the delay).
    function setProtectNfts(address account, bool on) external nonReentrant whenNotPaused {
        LibVaipakam.ProtectedAccount storage a = _requireManager(account);
        if (on) {
            a.protectNfts = true;
            a.pendingNftOffAt = 0;
            emit ProtectNftsSet(account, true);
            return;
        }
        _requireLoosenable(account, a);
        a.pendingNftOffAt = _later(a);
        emit SettingChangeRequested(account, CHANGE_NFT_OFF, 0, a.pendingNftOffAt);
    }

    /// @notice Require a secondary signer's co-sign on every release (on is
    ///         immediate and needs at least one signer; off waits the delay).
    function setRequireCosign(address account, bool on) external nonReentrant whenNotPaused {
        LibVaipakam.ProtectedAccount storage a = _requireManager(account);
        if (on) {
            uint256 n = LibVaipakam.storageSlot().protectedSigners[account].length();
            if (n == 0) revert LibProtectedAccount.NotEnoughSigners(0, 1);
            a.requireCosign = true;
            a.pendingCosignOffAt = 0;
            emit CosignRequirementSet(account, true);
            return;
        }
        _requireLoosenable(account, a);
        a.pendingCosignOffAt = _later(a);
        emit SettingChangeRequested(account, CHANGE_COSIGN_OFF, 0, a.pendingCosignOffAt);
    }

    /**
     * @notice Cancel a pending loosening change of `kind` (see the CHANGE_*
     *         constants). Works during a pause.
     * @dev    Caller: the manager or any secondary signer.
     */
    function cancelSettingChange(address account, uint8 kind) external nonReentrant {
        LibVaipakam.ProtectedAccount storage a = _requireManagerOrSigner(account);
        if (kind == CHANGE_DISABLE) a.pendingDisableAt = 0;
        else if (kind == CHANGE_LOWER_DELAY) {
            a.pendingDelay = 0;
            a.pendingDelayAt = 0;
        } else if (kind == CHANGE_NFT_OFF) a.pendingNftOffAt = 0;
        else if (kind == CHANGE_COSIGN_OFF) a.pendingCosignOffAt = 0;
        else if (kind == CHANGE_UNLOCK) a.pendingUnlockAt = 0;
        else if (kind == CHANGE_UNPIN) a.pendingUnpinAt = 0;
        else revert LibProtectedAccount.ChangeNotRequested();
        emit SettingChangeCancelled(account, kind, msg.sender);
    }

    /**
     * @notice Apply every pending loosening change of `account` whose delay
     *         has passed. Permissionless (the keeper backs it); applies
     *         nothing that is not due.
     * @dev    A due switch-off waits while any row is still queued, without
     *         holding back the other due changes (an unlock included); it
     *         reverts only when it was the one change due. Switching off
     *         clears the whole account (signers and allowlist included) and
     *         voids every pending allowlist and signer change.
     */
    function finalizeSettingChanges(address account) external nonReentrant whenNotPaused {
        LibVaipakam.ProtectedAccount storage a = _acct(account);
        uint256 nowTs = block.timestamp;
        bool applied;
        if (a.pendingDelayAt != 0 && nowTs >= a.pendingDelayAt) {
            applied = true;
            emit ProtectedDelaySet(account, a.delaySeconds, a.pendingDelay);
            a.delaySeconds = a.pendingDelay;
            a.pendingDelay = 0;
            a.pendingDelayAt = 0;
            emit SettingChangeApplied(account, CHANGE_LOWER_DELAY);
        }
        if (a.pendingNftOffAt != 0 && nowTs >= a.pendingNftOffAt) {
            applied = true;
            a.protectNfts = false;
            a.pendingNftOffAt = 0;
            emit ProtectNftsSet(account, false);
            emit SettingChangeApplied(account, CHANGE_NFT_OFF);
        }
        if (a.pendingCosignOffAt != 0 && nowTs >= a.pendingCosignOffAt) {
            applied = true;
            a.requireCosign = false;
            a.pendingCosignOffAt = 0;
            emit CosignRequirementSet(account, false);
            emit SettingChangeApplied(account, CHANGE_COSIGN_OFF);
        }
        if (a.pendingUnlockAt != 0 && nowTs >= a.pendingUnlockAt) {
            applied = true;
            a.locked = false;
            a.lockedBy = address(0);
            a.lockedAt = 0;
            a.pendingUnlockAt = 0;
            emit VaultUnlocked(account);
            emit SettingChangeApplied(account, CHANGE_UNLOCK);
        }
        if (a.pendingUnpinAt != 0 && nowTs >= a.pendingUnpinAt) {
            applied = true;
            a.pendingUnpinAt = 0;
            delete LibVaipakam.storageSlot().vaultPinnedImplementation[account];
            emit SettingChangeApplied(account, CHANGE_UNPIN);
        }
        if (a.pendingDisableAt != 0 && nowTs >= a.pendingDisableAt) {
            if (LibProtectedAccount.openRows(account) == 0) {
                _clearAccount(account);
                emit ProtectedModeDisabled(account);
            } else if (!applied) {
                // The switch-off was the only change due, and it waits for
                // the open rows: say so rather than succeed doing nothing.
                revert LibProtectedAccount.PendingRowsExist();
            }
        }
    }

    /// @dev Remove every trace of `account`'s protected mode.
    function _clearAccount(address account) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        EnumerableSet.AddressSet storage signers = s.protectedSigners[account];
        while (signers.length() != 0) {
            address sg = signers.at(signers.length() - 1);
            delete s.protectedSignerChange[account][sg];
            signers.remove(sg);
        }
        EnumerableSet.AddressSet storage allow = s.protectedAllowlist[account];
        while (allow.length() != 0) allow.remove(allow.at(allow.length() - 1));
        // Pending allowlist additions and the changes of nominees who are not
        // signers live in mappings the sweeps above cannot reach: void them,
        // so a later re-enable starts with nothing matured.
        _voidPendingChanges(account);
        // The proposal ROUND survives the reset: approvals are keyed by round,
        // and those of a cancelled round stay recorded, so restarting the
        // count at zero would let a later proposal reuse an old round and
        // count approvals given to a different nominee. Every other field of
        // the proposal is cleared.
        LibVaipakam.ReplacementProposal storage p = s.replacementProposal[account];
        p.nominee = address(0);
        p.proposedBy = address(0);
        p.readyAt = 0;
        p.approvals = 0;
        delete s.protectedAccount[account];
    }

    // ─── Allowlist ───────────────────────────────────────────────────────

    /// @notice Ask to allow payouts to `destination`; active after the delay
    ///         (by anyone's {finalizeAddAllowlisted}) unless cancelled.
    function addAllowlisted(address account, address destination) external nonReentrant whenNotPaused {
        LibVaipakam.ProtectedAccount storage a = _requireManager(account);
        if (a.retired) revert LibProtectedAccount.AccountRetired(account);
        _requireLoosenable(account, a);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (destination == address(0) || destination == account || s.protectedAllowlist[account].contains(destination)) {
            revert LibProtectedAccount.RecipientNotAllowlisted(account, destination);
        }
        if (s.protectedAllowlist[account].length() >= LibProtectedAccount.MAX_ALLOWLIST) {
            revert LibProtectedAccount.TooManyAllowlisted();
        }
        LibVaipakam._assertNotSanctioned(destination);
        uint64 epoch = _epoch(account);
        EnumerableSet.AddressSet storage pending = s.protectedPendingAllowlist[account][epoch];
        if (!pending.contains(destination) && pending.length() >= LibProtectedAccount.MAX_ALLOWLIST) {
            revert LibProtectedAccount.TooManyAllowlisted();
        }
        pending.add(destination);
        uint64 at = _later(a);
        s.protectedAllowlistChange[account][destination] = LibVaipakam.ProtectedAllowlistChange({at: at, epoch: epoch});
        emit AllowlistAddRequested(account, destination, at);
    }

    /// @notice Cancel a pending allowlist addition. Works during a pause.
    function cancelAddAllowlisted(address account, address destination) external nonReentrant {
        _requireManagerOrSigner(account);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ProtectedAllowlistChange storage c = s.protectedAllowlistChange[account][destination];
        if (_live(account, c.at, c.epoch) == 0) revert LibProtectedAccount.ChangeNotRequested();
        delete s.protectedAllowlistChange[account][destination];
        s.protectedPendingAllowlist[account][_epoch(account)].remove(destination);
        emit AllowlistAddCancelled(account, destination, msg.sender);
    }

    /// @notice Activate a matured allowlist addition. Permissionless.
    ///         Only within one further delay after it matures (then it
    ///         expires, as a signer addition does), and only if no lock or
    ///         switch-off came after it was requested.
    function finalizeAddAllowlisted(address account, address destination) external nonReentrant whenNotPaused {
        LibVaipakam.ProtectedAccount storage a = _acct(account);
        if (a.locked) revert LibProtectedAccount.ProtectedVaultLocked(account);
        if (a.retired) revert LibProtectedAccount.AccountRetired(account);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ProtectedAllowlistChange storage c = s.protectedAllowlistChange[account][destination];
        uint64 at = _live(account, c.at, c.epoch);
        _matured(at);
        _withinWindow(a, at);
        if (s.protectedAllowlist[account].length() >= LibProtectedAccount.MAX_ALLOWLIST) {
            revert LibProtectedAccount.TooManyAllowlisted();
        }
        delete s.protectedAllowlistChange[account][destination];
        s.protectedPendingAllowlist[account][_epoch(account)].remove(destination);
        s.protectedAllowlist[account].add(destination);
        emit AllowlistAdded(account, destination);
    }

    /// @notice Remove `destination` at once, cancelling every payout queued
    ///         to it. Caller: the manager or any secondary signer.
    function removeAllowlisted(address account, address destination) external nonReentrant {
        _requireManagerOrSigner(account);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.protectedAllowlist[account].remove(destination)) {
            revert LibProtectedAccount.RecipientNotAllowlisted(account, destination);
        }
        LibProtectedAccount.cancelRowsTo(account, destination, msg.sender);
        emit AllowlistRemoved(account, destination, msg.sender);
    }

    // ─── Secondary signers ───────────────────────────────────────────────

    /**
     * @notice Nominate `signer` as a secondary signer. It becomes active after
     *         the delay, by anyone's {finalizeAddSigner}, only once `signer`
     *         has accepted from its own key ({acceptSignerRole}), and only
     *         within one further delay (then it expires).
     */
    function addSigner(address account, address signer) external nonReentrant whenNotPaused {
        LibVaipakam.ProtectedAccount storage a = _requireManager(account);
        _requireLoosenable(account, a);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ProtectedSignerChange storage c = s.protectedSignerChange[account][signer];
        if (
            signer == address(0) || signer == account || signer == a.controller
                || s.protectedSigners[account].contains(signer) || _live(account, c.addAt, c.epoch) != 0
        ) revert LibProtectedAccount.InvalidSigner(signer);
        if (s.protectedSigners[account].length() >= LibProtectedAccount.MAX_SIGNERS) {
            revert LibProtectedAccount.TooManySigners();
        }
        uint64 epoch = _epoch(account);
        EnumerableSet.AddressSet storage pending = s.protectedPendingSigners[account][epoch];
        if (pending.length() >= LibProtectedAccount.MAX_SIGNERS) revert LibProtectedAccount.TooManySigners();
        pending.add(signer);
        c.addAt = _later(a);
        c.accepted = false;
        c.removeAt = 0;
        c.epoch = epoch;
        emit SignerAddRequested(account, signer, c.addAt);
    }

    /// @notice The nominee accepts the signer role for `account`, from its own key.
    function acceptSignerRole(address account) external nonReentrant whenNotPaused {
        _acct(account);
        LibVaipakam.ProtectedSignerChange storage c =
            LibVaipakam.storageSlot().protectedSignerChange[account][msg.sender];
        if (_live(account, c.addAt, c.epoch) == 0) revert LibProtectedAccount.ChangeNotRequested();
        c.accepted = true;
        emit SignerAccepted(account, msg.sender);
    }

    /// @notice Cancel a pending signer addition. Caller: the manager, any
    ///         active signer, or the nominee itself. Works during a pause.
    function cancelAddSigner(address account, address signer) external nonReentrant {
        if (msg.sender != signer) _requireManagerOrSigner(account);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ProtectedSignerChange storage c = s.protectedSignerChange[account][signer];
        if (_live(account, c.addAt, c.epoch) == 0) revert LibProtectedAccount.ChangeNotRequested();
        c.addAt = 0;
        c.accepted = false;
        s.protectedPendingSigners[account][_epoch(account)].remove(signer);
        emit SignerAddCancelled(account, signer, msg.sender);
    }

    /// @notice Activate a matured, accepted signer addition. Permissionless.
    function finalizeAddSigner(address account, address signer) external nonReentrant whenNotPaused {
        LibVaipakam.ProtectedAccount storage a = _acct(account);
        if (a.locked) revert LibProtectedAccount.ProtectedVaultLocked(account);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ProtectedSignerChange storage c = s.protectedSignerChange[account][signer];
        uint64 at = _live(account, c.addAt, c.epoch);
        _matured(at);
        _withinWindow(a, at);
        if (!c.accepted) revert LibProtectedAccount.SignerNotAccepted(signer);
        if (s.protectedSigners[account].length() >= LibProtectedAccount.MAX_SIGNERS) {
            revert LibProtectedAccount.TooManySigners();
        }
        c.addAt = 0;
        c.accepted = false;
        s.protectedPendingSigners[account][_epoch(account)].remove(signer);
        s.protectedSigners[account].add(signer);
        emit SignerAdded(account, signer);
    }

    /// @notice Ask to remove active signer `signer`; takes effect after the
    ///         delay unless the manager or another signer cancels it.
    function requestRemoveSigner(address account, address signer) external nonReentrant whenNotPaused {
        LibVaipakam.ProtectedAccount storage a = _requireManager(account);
        _requireLoosenable(account, a);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.protectedSigners[account].contains(signer)) revert LibProtectedAccount.NotSigner(account, signer);
        LibVaipakam.ProtectedSignerChange storage c = s.protectedSignerChange[account][signer];
        c.removeAt = _later(a);
        c.epoch = _epoch(account);
        emit SignerRemoveRequested(account, signer, c.removeAt);
    }

    /// @notice Cancel a pending signer removal. Caller: the manager or any
    ///         signer except the one being removed. Works during a pause.
    function cancelRemoveSigner(address account, address signer) external nonReentrant {
        _requireManagerOrSigner(account);
        if (msg.sender == signer) revert LibProtectedAccount.NotManagerOrSigner(account, msg.sender);
        LibVaipakam.ProtectedSignerChange storage c = LibVaipakam.storageSlot().protectedSignerChange[account][signer];
        if (_live(account, c.removeAt, c.epoch) == 0) revert LibProtectedAccount.ChangeNotRequested();
        c.removeAt = 0;
        emit SignerRemoveCancelled(account, signer, msg.sender);
    }

    /// @notice Apply a matured signer removal. Permissionless. Turns the
    ///         co-sign requirement off if no signer is left to co-sign.
    function finalizeRemoveSigner(address account, address signer) external nonReentrant whenNotPaused {
        LibVaipakam.ProtectedAccount storage a = _acct(account);
        if (a.locked) revert LibProtectedAccount.ProtectedVaultLocked(account);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ProtectedSignerChange storage c = s.protectedSignerChange[account][signer];
        _matured(_live(account, c.removeAt, c.epoch));
        delete s.protectedSignerChange[account][signer];
        s.protectedSigners[account].remove(signer);
        emit SignerRemoved(account, signer);
        if (a.requireCosign && s.protectedSigners[account].length() == 0) {
            a.requireCosign = false;
            a.pendingCosignOffAt = 0;
            emit CosignRequirementSet(account, false);
        }
    }

    // ─── Lock ────────────────────────────────────────────────────────────

    /**
     * @notice Lock `account` at once: every queued payout and position
     *         transfer is cancelled, no new one can be queued, and the account
     *         opens no new position. Works during a pause.
     * @dev    Caller: the manager or any secondary signer. A lock placed by a
     *         signer records it, which stops the owner from cancelling a
     *         replacement while it holds.
     */
    function lockVault(address account) external nonReentrant {
        _requireManagerOrSigner(account);
        _lock(account, msg.sender);
    }

    /**
     * @notice A keeper the owner granted `KEEPER_ACTION_LOCK_VAULT` locks the
     *         owner's account (for a LOCK command from the owner's linked
     *         chat). The lock counts as the owner's own. Works during a pause.
     */
    function lockVaultFor(address account) external nonReentrant {
        _acct(account);
        LibAuth.requireKeeperForPrincipal(LibVaipakam.KEEPER_ACTION_LOCK_VAULT, account);
        _lock(account, account);
    }

    function _lock(address account, address by) private {
        LibVaipakam.ProtectedAccount storage a = LibVaipakam.storageSlot().protectedAccount[account];
        bool wasLocked = a.locked;
        if (!wasLocked) {
            a.locked = true;
            a.lockedAt = uint64(block.timestamp);
        }
        // A lock a secondary signer holds keeps its signer origin when the
        // manager (or its keeper) locks again: that origin is what bars the
        // manager from cancelling or redirecting a replacement, so a repeat
        // lock by a compromised primary must not be able to wash it out. A
        // signer locking over the manager's lock does take the origin.
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!wasLocked || !s.protectedSigners[account].contains(a.lockedBy)) {
            a.lockedBy = by;
        }
        // A lock is an emergency: it also drops every pending change, which
        // can be requested again only after an unlock.
        _dropPendingChanges(account, a);
        LibProtectedAccount.cancelAllRows(account, by);
        emit VaultLocked(account, by);
    }

    /// @notice Ask to unlock; takes effect after the delay (by anyone's
    ///         {finalizeSettingChanges}) unless the manager or a signer
    ///         cancels it. No keeper may unlock.
    function requestUnlock(address account) external nonReentrant whenNotPaused {
        LibVaipakam.ProtectedAccount storage a = _requireManager(account);
        if (!a.locked) revert LibProtectedAccount.ProtectedVaultNotLocked(account);
        _requireNoCooldown(a);
        a.pendingUnlockAt = _later(a);
        emit SettingChangeRequested(account, CHANGE_UNLOCK, 0, a.pendingUnlockAt);
    }

    // ─── Replacement of the primary ──────────────────────────────────────

    /// @dev Approvals of the current round by ACTIVE signers, and the majority.
    function _tally(address account) private view returns (uint256 approvals, uint256 threshold) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        EnumerableSet.AddressSet storage signers = s.protectedSigners[account];
        uint32 round = s.replacementProposal[account].round;
        uint256 n = signers.length();
        for (uint256 i; i < n; ++i) {
            if (s.replacementApproved[account][round][signers.at(i)]) ++approvals;
        }
        threshold = n / 2 + 1;
    }

    /**
     * @notice Propose `nominee` as the wallet that takes over `account`.
     * @dev    By the manager: ready after the delay. By a secondary signer:
     *         needs at least `MIN_RECOVERY_SIGNERS` active signers and a
     *         majority of them approving; the delay starts when the majority
     *         is reached. A new proposal replaces the open one and restarts
     *         its approvals.
     */
    function proposeReplacement(address account, address nominee) external nonReentrant whenNotPaused {
        LibVaipakam.ProtectedAccount storage a = _acct(account);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address mgr = a.retired ? a.controller : account;
        bool bySigner = msg.sender != mgr;
        if (!bySigner && a.locked && s.protectedSigners[account].contains(a.lockedBy)) {
            revert LibProtectedAccount.OwnerCannotCancelWhileSignerLock();
        }
        if (bySigner) {
            if (!s.protectedSigners[account].contains(msg.sender)) {
                revert LibProtectedAccount.NotManagerOrSigner(account, msg.sender);
            }
            uint256 n = s.protectedSigners[account].length();
            if (n < LibProtectedAccount.MIN_RECOVERY_SIGNERS) {
                revert LibProtectedAccount.NotEnoughSigners(n, LibProtectedAccount.MIN_RECOVERY_SIGNERS);
            }
        }
        if (
            nominee == address(0) || nominee == account || nominee == mgr
                || s.protectedRetiredAccountOf[nominee] != address(0)
        ) revert LibProtectedAccount.InvalidNominee(nominee);
        LibVaipakam.ReplacementProposal storage p = s.replacementProposal[account];
        p.nominee = nominee;
        p.proposedBy = msg.sender;
        p.round += 1;
        p.readyAt = 0;
        emit ReplacementProposed(account, nominee, msg.sender, p.round);
        if (!bySigner) {
            p.readyAt = _later(a);
            emit ReplacementScheduled(account, nominee, p.readyAt);
            return;
        }
        _approve(account, a, p);
    }

    /// @notice A secondary signer approves the open replacement proposal.
    function approveReplacement(address account) external nonReentrant whenNotPaused {
        LibVaipakam.ProtectedAccount storage a = _acct(account);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.protectedSigners[account].contains(msg.sender)) revert LibProtectedAccount.NotSigner(account, msg.sender);
        LibVaipakam.ReplacementProposal storage p = s.replacementProposal[account];
        if (p.nominee == address(0)) revert LibProtectedAccount.NoReplacementProposed();
        _approve(account, a, p);
    }

    function _approve(
        address account,
        LibVaipakam.ProtectedAccount storage a,
        LibVaipakam.ReplacementProposal storage p
    ) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.replacementApproved[account][p.round][msg.sender]) revert LibProtectedAccount.AlreadyApproved();
        s.replacementApproved[account][p.round][msg.sender] = true;
        (uint256 approvals, uint256 threshold) = _tally(account);
        p.approvals = uint8(approvals);
        emit ReplacementApproved(account, p.nominee, msg.sender, approvals, threshold);
        if (p.readyAt == 0 && approvals >= threshold) {
            p.readyAt = _later(a);
            emit ReplacementScheduled(account, p.nominee, p.readyAt);
        }
    }

    /**
     * @notice Cancel the open replacement proposal. Works during a pause.
     * @dev    Any secondary signer may; the manager may only while the account
     *         is not under a lock a signer placed.
     */
    function cancelReplacement(address account) external nonReentrant {
        LibVaipakam.ProtectedAccount storage a = _requireManagerOrSigner(account);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.protectedSigners[account].contains(msg.sender)) {
            if (a.locked && s.protectedSigners[account].contains(a.lockedBy)) {
                revert LibProtectedAccount.OwnerCannotCancelWhileSignerLock();
            }
        }
        LibVaipakam.ReplacementProposal storage p = s.replacementProposal[account];
        if (p.nominee == address(0)) revert LibProtectedAccount.NoReplacementProposed();
        address nominee = p.nominee;
        p.nominee = address(0);
        p.proposedBy = address(0);
        p.readyAt = 0;
        emit ReplacementCancelled(account, nominee, msg.sender);
    }

    /**
     * @notice Carry out a replacement whose delay has passed. Permissionless.
     * @dev    Retires the account and makes the nominee its controller: the
     *         old wallet loses every right over it, every queued row is
     *         cancelled, the lock and the extra destinations are cleared, the
     *         account opens nothing new from now on, and every payout it makes
     *         goes to the controller through the delay. A signer-led proposal
     *         still needs its majority among the signers active now. The
     *         controller starts a cool-down of one delay.
     */
    function finalizeReplacement(address account) external nonReentrant whenNotPaused {
        LibVaipakam.ProtectedAccount storage a = _acct(account);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ReplacementProposal storage p = s.replacementProposal[account];
        if (p.nominee == address(0)) revert LibProtectedAccount.NoReplacementProposed();
        if (p.readyAt == 0 || block.timestamp < p.readyAt) revert LibProtectedAccount.ReplacementNotReady();
        address mgr = a.retired ? a.controller : account;
        if (p.proposedBy != mgr) {
            (uint256 approvals, uint256 threshold) = _tally(account);
            uint256 n = s.protectedSigners[account].length();
            if (n < LibProtectedAccount.MIN_RECOVERY_SIGNERS || approvals < threshold) {
                revert LibProtectedAccount.ReplacementNotReady();
            }
        }
        address nominee = p.nominee;
        if (s.protectedRetiredAccountOf[nominee] != address(0)) revert LibProtectedAccount.InvalidNominee(nominee);
        LibProtectedAccount.cancelAllRows(account, address(this));
        if (a.controller != address(0)) delete s.protectedRetiredAccountOf[a.controller];
        s.protectedRetiredAccountOf[nominee] = account;
        a.retired = true;
        a.controller = nominee;
        a.locked = false;
        a.lockedBy = address(0);
        a.lockedAt = 0;
        // Every change the outgoing key requested dies with its authority:
        // none may mature during the new controller's cool-down.
        _dropPendingChanges(account, a);
        a.cooldownUntil = _later(a);
        EnumerableSet.AddressSet storage allow = s.protectedAllowlist[account];
        while (allow.length() != 0) allow.remove(allow.at(allow.length() - 1));
        p.nominee = address(0);
        p.proposedBy = address(0);
        p.readyAt = 0;
        emit PrimaryReplaced(account, nominee, a.cooldownUntil);
    }

    // ─── Views ───────────────────────────────────────────────────────────

    /// @notice `account`'s settings, lock and pending changes.
    function getProtectedAccount(address account) external view returns (LibVaipakam.ProtectedAccount memory) {
        return LibVaipakam.storageSlot().protectedAccount[account];
    }

    /// @notice `account`'s active secondary signers.
    function getProtectedSigners(address account) external view returns (address[] memory) {
        return LibVaipakam.storageSlot().protectedSigners[account].values();
    }

    /// @notice A pending addition or removal of `signer` on `account`.
    function getSignerChange(address account, address signer)
        external
        view
        returns (LibVaipakam.ProtectedSignerChange memory c)
    {
        // A change voided by a later lock, replacement or switch-off reads
        // as none.
        c = LibVaipakam.storageSlot().protectedSignerChange[account][signer];
        if (c.epoch != _epoch(account)) c = LibVaipakam.ProtectedSignerChange(0, false, 0, 0);
    }

    /// @notice `account`'s active extra payout destinations (its manager
    ///         wallet is always allowed besides).
    function getAllowlist(address account) external view returns (address[] memory) {
        return LibVaipakam.storageSlot().protectedAllowlist[account].values();
    }

    /// @notice When a pending addition of `destination` matures; zero if
    ///         none (one voided by a later lock or switch-off reads as none).
    ///         It can be activated until one further delay after that.
    function getAllowlistPendingAt(address account, address destination) external view returns (uint256) {
        LibVaipakam.ProtectedAllowlistChange storage c =
            LibVaipakam.storageSlot().protectedAllowlistChange[account][destination];
        return _live(account, c.at, c.epoch);
    }

    /// @notice Every pending allowlist addition of `account` in the current
    ///         change epoch, with when each matures. A matured addition not
    ///         applied within one further delay has expired and is listed
    ///         until cancelled or asked for again; a voided one is not listed.
    function getPendingAllowlistAdditions(address account)
        external
        view
        returns (address[] memory destinations, uint256[] memory maturesAt)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        destinations = s.protectedPendingAllowlist[account][_epoch(account)].values();
        maturesAt = new uint256[](destinations.length);
        for (uint256 i; i < destinations.length; ++i) {
            maturesAt[i] = s.protectedAllowlistChange[account][destinations[i]].at;
        }
    }

    /// @notice Every pending signer addition of `account` in the current
    ///         change epoch: the nominee, when it matures, and whether the
    ///         nominee has accepted. Listed like {getPendingAllowlistAdditions}.
    function getPendingSignerAdditions(address account)
        external
        view
        returns (address[] memory nominees, uint256[] memory maturesAt, bool[] memory accepted)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        nominees = s.protectedPendingSigners[account][_epoch(account)].values();
        maturesAt = new uint256[](nominees.length);
        accepted = new bool[](nominees.length);
        for (uint256 i; i < nominees.length; ++i) {
            LibVaipakam.ProtectedSignerChange storage c = s.protectedSignerChange[account][nominees[i]];
            maturesAt[i] = c.addAt;
            accepted[i] = c.accepted;
        }
    }

    /// @notice The open replacement proposal, its approvals by active
    ///         signers now, and the majority it needs.
    function getReplacement(address account)
        external
        view
        returns (LibVaipakam.ReplacementProposal memory proposal, uint256 approvals, uint256 threshold)
    {
        proposal = LibVaipakam.storageSlot().replacementProposal[account];
        (approvals, threshold) = _tally(account);
    }

    /// @notice Whether a listing `seller` authored may pay `recipient`
    ///         directly at fill ({LibProtectedAccount.listingLegAllowed}).
    ///         The collateral-listing executor reads it at every fill, for
    ///         each fee leg and for the seller itself (`recipient == seller`
    ///         answers whether a locked or retired account is selling).
    function isListingLegAllowed(address seller, address recipient) external view returns (bool) {
        return LibProtectedAccount.listingLegAllowed(seller, recipient);
    }

    /// @notice The retired account `controller` manages; zero if none.
    function getRetiredAccountOf(address controller) external view returns (address) {
        return LibVaipakam.storageSlot().protectedRetiredAccountOf[controller];
    }

    /// @notice The bounds of the delay, in seconds.
    function getProtectedDelayBounds() external pure returns (uint256 minDelay, uint256 maxDelay) {
        return (LibProtectedAccount.MIN_DELAY, LibProtectedAccount.MAX_DELAY);
    }
}
