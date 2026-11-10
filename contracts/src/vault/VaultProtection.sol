// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {LibVaultProtectionStorage as P} from "./LibVaultProtectionStorage.sol";

/// @dev The vault entries the protection code reaches through the vault
///      itself (a call to `address(this)` while running in the vault).
interface IProtectedVaultSelf {
    function vaultOwner() external view returns (address);
    function vaultDiamond() external view returns (address);
    function vaultCreationOwner() external view returns (address);
    function setOwnerFromProtection(address newOwner) external;
}

/// @dev The one platform read the protection code makes: the account's queued
///      payout rows, which a switch-off waits for (they move into the vault
///      with the liens in Stage B3).
interface IPayoutRowsView {
    function getPendingPayoutIds(address account) external view returns (uint256[] memory);
}

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
 */
contract VaultProtection {
    // ─── Bounds (owner decisions, as today) ─────────────────────────────

    uint32 public constant MIN_DELAY = 2 days;
    uint32 public constant MAX_DELAY = 5 days;
    uint256 public constant MAX_SIGNERS = 5;
    uint256 public constant MIN_RECOVERY_SIGNERS = 3;
    uint256 public constant MAX_ALLOWLIST = 5;

    // ─── Purposes (nonce lanes, one typehash each) ──────────────────────

    uint8 public constant PURPOSE_SETTINGS = 1;
    uint8 public constant PURPOSE_ALLOWLIST_ADD = 2;
    uint8 public constant PURPOSE_ALLOWLIST_CANCEL = 3;
    uint8 public constant PURPOSE_SIGNER_CHANGE = 4;
    uint8 public constant PURPOSE_REPLACEMENT = 5;
    uint8 public constant PURPOSE_LOCK = 6;
    uint8 public constant PURPOSE_VERIFY = 7;

    // Actions inside a purpose.
    uint8 public constant SETTINGS_ENABLE = 1;
    uint8 public constant SETTINGS_DELAY = 2;
    uint8 public constant SETTINGS_DISABLE = 3;
    uint8 public constant SETTINGS_UNLOCK = 4;
    uint8 public constant SIGNER_ADD = 1;
    uint8 public constant SIGNER_ACCEPT = 2;
    uint8 public constant SIGNER_REMOVE = 3;
    uint8 public constant SIGNER_CANCEL = 4;
    uint8 public constant REPLACE_PROPOSE = 1;
    uint8 public constant REPLACE_APPROVE = 2;
    uint8 public constant REPLACE_CANCEL = 3;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Vaipakam Vault");
    bytes32 private constant VERSION_HASH = keccak256("1");

    bytes32 public constant SETTINGS_TYPEHASH =
        keccak256("Settings(uint8 action,uint256 value,uint256 nonce,uint64 expiry)");
    bytes32 public constant ALLOWLIST_ADD_TYPEHASH =
        keccak256("AllowlistAdd(address destination,uint256 nonce,uint64 expiry)");
    bytes32 public constant ALLOWLIST_CANCEL_TYPEHASH =
        keccak256("AllowlistCancel(address destination,uint256 nonce,uint64 expiry)");
    bytes32 public constant SIGNER_CHANGE_TYPEHASH =
        keccak256("SignerChange(uint8 action,address signer,uint256 nonce,uint64 expiry)");
    bytes32 public constant REPLACEMENT_TYPEHASH =
        keccak256("Replacement(uint8 action,address nominee,uint256 nonce,uint64 expiry)");
    bytes32 public constant LOCK_TYPEHASH = keccak256("Lock(uint256 nonce,uint64 expiry)");
    /// @dev #3415 — the destination names the account (the vault's creation
    ///      owner), the Diamond and, through the domain, the chain and vault.
    bytes32 public constant VERIFY_TYPEHASH =
        keccak256("VerifyDestination(address account,address diamond,uint256 nonce,uint64 expiry)");

    /// @notice How a key authorizes one write: `sig` empty means a direct call
    ///         from `key`; otherwise its EIP-712 / ERC-1271 signature.
    struct Auth {
        address key;
        uint64 expiry;
        bytes sig;
    }

    address private immutable SELF;

    // ─── Events (one per record write) ──────────────────────────────────

    event ProtectionEnabled(uint32 delay, address by);
    event ProtectionSettingRequested(uint8 indexed action, uint256 value, uint64 at, address by);
    event ProtectionSettingApplied(uint8 indexed action, uint256 value);
    event ProtectionSettingCancelled(uint8 indexed action, address by);
    event ProtectionDisabled();
    event AllowlistAddRequested(address indexed destination, uint64 readyAt, address by);
    event AllowlistAddCancelled(address indexed destination, address by);
    event AllowlistAdded(address indexed destination);
    event AllowlistRemoved(address indexed destination, address by);
    event DestinationVerified(address indexed destination);
    event SignerAddRequested(address indexed signer, uint64 readyAt, address by);
    event SignerAccepted(address indexed signer);
    event SignerAdded(address indexed signer);
    event SignerRemoveRequested(address indexed signer, uint64 readyAt, address by);
    event SignerChangeCancelled(address indexed signer, address by);
    event SignerRemoved(address indexed signer);
    event VaultLocked(address indexed by);
    event ReplacementProposed(address indexed nominee, address indexed by, uint32 round);
    event ReplacementApproved(address indexed nominee, address indexed signer, uint256 approvals, uint256 threshold);
    event ReplacementScheduled(address indexed nominee, uint64 readyAt);
    event ReplacementCancelled(address indexed nominee, address by);
    event PrimaryReplaced(address indexed previousOwner, address indexed newOwner, uint64 cooldownUntil);
    event NonceBurned(address indexed key, uint8 indexed purpose, uint256 nonce);

    // ─── Errors ─────────────────────────────────────────────────────────

    error NotDelegateCall();
    error NotEnabled();
    error AlreadyEnabled();
    error Locked();
    error NotLocked();
    error InCooldown(uint64 until);
    error BadDelay(uint32 delay);
    error NotOwner(address key);
    error NotOwnerOrSigner(address key);
    error NotSigner(address key);
    error BadSignature(address key);
    error SignatureExpired(uint64 expiry);
    error BadDestination(address destination);
    error TooMany();
    error NotRequested();
    error NotReady(uint64 readyAt);
    error Expired(uint64 expiredAt);
    error BadNominee(address nominee);
    error NotEnoughSigners(uint256 have, uint256 need);
    error AlreadyApproved();
    error NoProposal();
    error OwnerBlockedBySignerLock();
    error PendingRowsExist();

    constructor() {
        SELF = address(this);
    }

    /// @dev Every write runs only inside a vault (a delegatecall), never on
    ///      this contract's own storage.
    modifier onlyDelegateCall() {
        if (address(this) == SELF) revert NotDelegateCall();
        _;
    }

    // ─── Settings ───────────────────────────────────────────────────────

    /// @notice Turn protected mode on with `delay` (the owner).
    function enable(uint32 delay, Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = P.layout();
        if (l.enabled) revert AlreadyEnabled();
        _checkDelay(delay);
        _asOwner(auth, PURPOSE_SETTINGS, keccak256(abi.encode(SETTINGS_TYPEHASH, SETTINGS_ENABLE, uint256(delay), _nonce(auth.key, PURPOSE_SETTINGS), auth.expiry)));
        l.enabled = true;
        l.delay = delay;
        emit ProtectionEnabled(delay, auth.key);
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
            emit ProtectionSettingApplied(SETTINGS_DELAY, delay);
            return;
        }
        _loosenable(l);
        l.pendingDelay = delay;
        l.pendingDelayAt = _later(l);
        emit ProtectionSettingRequested(SETTINGS_DELAY, delay, l.pendingDelayAt, auth.key);
    }

    /// @notice Ask to switch protected mode off (the owner); waits the delay.
    function requestDisable(Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        _loosenable(l);
        _asOwner(auth, PURPOSE_SETTINGS, keccak256(abi.encode(SETTINGS_TYPEHASH, SETTINGS_DISABLE, uint256(0), _nonce(auth.key, PURPOSE_SETTINGS), auth.expiry)));
        l.pendingDisableAt = _later(l);
        emit ProtectionSettingRequested(SETTINGS_DISABLE, 0, l.pendingDisableAt, auth.key);
    }

    /// @notice Ask to unlock (the owner); waits the delay.
    function requestUnlock(Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        if (!l.locked) revert NotLocked();
        _noCooldown(l);
        _asOwner(auth, PURPOSE_SETTINGS, keccak256(abi.encode(SETTINGS_TYPEHASH, SETTINGS_UNLOCK, uint256(0), _nonce(auth.key, PURPOSE_SETTINGS), auth.expiry)));
        l.pendingUnlockAt = _later(l);
        emit ProtectionSettingRequested(SETTINGS_UNLOCK, 0, l.pendingUnlockAt, auth.key);
    }

    /// @notice Cancel a pending delay lowering, unlock or switch-off (the owner
    ///         or any signer, as an allowlist cancel).
    function cancelSetting(uint8 action, Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        _asOwnerOrSigner(auth, PURPOSE_ALLOWLIST_CANCEL, keccak256(abi.encode(SETTINGS_TYPEHASH, action, uint256(0), _nonce(auth.key, PURPOSE_ALLOWLIST_CANCEL), auth.expiry)));
        if (action == SETTINGS_DELAY) l.pendingDelayAt = 0;
        else if (action == SETTINGS_UNLOCK) l.pendingUnlockAt = 0;
        else if (action == SETTINGS_DISABLE) l.pendingDisableAt = 0;
        else revert NotRequested();
        emit ProtectionSettingCancelled(action, auth.key);
    }

    /// @notice Apply every matured setting change. Permissionless.
    function finalizeSettings() external onlyDelegateCall {
        P.Layout storage l = _enabled();
        uint64 nowTs = uint64(block.timestamp);
        bool applied;
        if (l.pendingDelayAt != 0 && nowTs >= l.pendingDelayAt) {
            applied = true;
            l.delay = l.pendingDelay;
            l.pendingDelayAt = 0;
            emit ProtectionSettingApplied(SETTINGS_DELAY, l.delay);
        }
        if (l.pendingUnlockAt != 0 && nowTs >= l.pendingUnlockAt) {
            applied = true;
            l.locked = false;
            l.lockedBy = address(0);
            l.lockedAt = 0;
            l.pendingUnlockAt = 0;
            emit ProtectionSettingApplied(SETTINGS_UNLOCK, 0);
        }
        if (l.pendingDisableAt != 0 && nowTs >= l.pendingDisableAt && !l.locked) {
            // A switch-off waits while any payout row is still queued (it
            // never holds back another due change); it reverts only when it
            // was the one change due. An unreadable count reads as rows open,
            // so a platform fault can only make the switch-off wait.
            if (_noOpenRows()) {
                _clear(l);
                emit ProtectionDisabled();
                applied = true;
            } else if (!applied) {
                revert PendingRowsExist();
            }
        }
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
        _loosenable(l);
        address owner = _asOwner(auth, PURPOSE_ALLOWLIST_ADD, keccak256(abi.encode(ALLOWLIST_ADD_TYPEHASH, destination, _nonce(auth.key, PURPOSE_ALLOWLIST_ADD), auth.expiry)));
        P.Entry storage e = l.allow[destination];
        if (destination == address(0) || destination == owner || destination == address(this) || e.active) {
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
        emit AllowlistAddRequested(destination, e.readyAt, auth.key);
    }

    /// @notice Cancel a pending addition (the owner or any signer).
    function cancelAllowlisted(address destination, Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        _asOwnerOrSigner(auth, PURPOSE_ALLOWLIST_CANCEL, keccak256(abi.encode(ALLOWLIST_CANCEL_TYPEHASH, destination, _nonce(auth.key, PURPOSE_ALLOWLIST_CANCEL), auth.expiry)));
        P.Entry storage e = l.allow[destination];
        if (e.active || e.readyAt == 0 || e.epoch != l.epoch) revert NotRequested();
        e.readyAt = 0;
        _remove(l.pendingAllow[l.epoch], destination);
        emit AllowlistAddCancelled(destination, auth.key);
    }

    /// @notice Activate a matured addition. Permissionless; only in its window
    ///         and only if no lock or switch-off came after it was asked.
    function finalizeAllowlisted(address destination) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        if (l.locked) revert Locked();
        P.Entry storage e = l.allow[destination];
        if (e.active || e.readyAt == 0 || e.epoch != l.epoch) revert NotRequested();
        _inWindow(l, e.readyAt);
        if (l.allowlist.length >= MAX_ALLOWLIST) revert TooMany();
        e.active = true;
        e.readyAt = 0;
        _remove(l.pendingAllow[l.epoch], destination);
        l.allowlist.push(destination);
        emit AllowlistAdded(destination);
    }

    /// @notice Remove `destination` at once (the owner or any signer).
    function removeAllowlisted(address destination, Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        _asOwnerOrSigner(auth, PURPOSE_ALLOWLIST_CANCEL, keccak256(abi.encode(ALLOWLIST_CANCEL_TYPEHASH, destination, _nonce(auth.key, PURPOSE_ALLOWLIST_CANCEL), auth.expiry)));
        if (!l.allow[destination].active) revert BadDestination(destination);
        _dropAllow(l, destination);
        emit AllowlistRemoved(destination, auth.key);
    }

    /// @notice #3415 — the destination itself confirms it is a destination of
    ///         this account: a direct call from it, or its own signature naming
    ///         the account, the Diamond, the chain and the vault. Sets the
    ///         entry's `verified` flag (pending or active entry).
    function verifyDestination(address account, address diamond, Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        address destination = auth.key;
        P.Entry storage e = l.allow[destination];
        if (!e.active && e.readyAt == 0) revert BadDestination(destination);
        _authorize(auth, PURPOSE_VERIFY, keccak256(abi.encode(VERIFY_TYPEHASH, account, diamond, _nonce(destination, PURPOSE_VERIFY), auth.expiry)));
        e.verified = true;
        emit DestinationVerified(destination);
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
            address owner = _asOwner(auth, PURPOSE_SIGNER_CHANGE, h);
            if (who == address(0) || who == owner || sg.active || l.allow[who].active) revert BadNominee(who);
            if (l.signers.length >= MAX_SIGNERS) revert TooMany();
            if (sg.addAt == 0 || sg.epoch != l.epoch) {
                address[] storage pending = l.pendingSigners[l.epoch];
                if (pending.length >= MAX_SIGNERS) revert TooMany();
                pending.push(who);
            }
            sg.addAt = _later(l);
            sg.epoch = l.epoch;
            sg.accepted = false;
            emit SignerAddRequested(who, sg.addAt, auth.key);
        } else if (action == SIGNER_ACCEPT) {
            if (auth.key != who || sg.addAt == 0 || sg.epoch != l.epoch) revert NotRequested();
            _authorize(auth, PURPOSE_SIGNER_CHANGE, h);
            sg.accepted = true;
            emit SignerAccepted(who);
        } else if (action == SIGNER_REMOVE) {
            _loosenable(l);
            _asOwner(auth, PURPOSE_SIGNER_CHANGE, h);
            if (!sg.active) revert NotSigner(who);
            sg.removeAt = _later(l);
            sg.epoch = l.epoch;
            emit SignerRemoveRequested(who, sg.removeAt, auth.key);
        } else if (action == SIGNER_CANCEL) {
            _asOwnerOrSigner(auth, PURPOSE_SIGNER_CHANGE, h);
            if ((sg.addAt == 0 && sg.removeAt == 0) || sg.epoch != l.epoch) revert NotRequested();
            if (sg.addAt != 0) _remove(l.pendingSigners[l.epoch], who);
            sg.addAt = 0;
            sg.removeAt = 0;
            sg.accepted = false;
            emit SignerChangeCancelled(who, auth.key);
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
            _inWindow(l, sg.addAt);
            if (l.signers.length >= MAX_SIGNERS) revert TooMany();
            sg.addAt = 0;
            sg.active = true;
            _remove(l.pendingSigners[l.epoch], who);
            l.signers.push(who);
            emit SignerAdded(who);
        } else if (sg.removeAt != 0) {
            _inWindow(l, sg.removeAt);
            sg.removeAt = 0;
            sg.active = false;
            sg.accepted = false;
            _dropSigner(l, who);
            emit SignerRemoved(who);
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
        _dropPending(l);
        if (l.nominee != address(0) && l.proposedBy == _owner()) {
            emit ReplacementCancelled(l.nominee, auth.key);
            _clearProposal(l);
        }
        emit VaultLocked(auth.key);
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
        _dropPending(l);
        if (l.nominee != address(0) && l.proposedBy == _owner()) {
            emit ReplacementCancelled(l.nominee, by);
            _clearProposal(l);
        }
        emit VaultLocked(by);
    }

    // ─── Replacement of the primary ─────────────────────────────────────

    /// @notice Propose, approve or cancel a replacement of the owner wallet.
    ///         The owner's own proposal is ready after the delay. A signer's
    ///         needs at least three active signers and a majority approving;
    ///         the delay starts when the majority is reached. Any signer may
    ///         cancel; the owner may not while a lock a signer placed holds.
    function replacement(uint8 action, address nominee, Auth calldata auth) external onlyDelegateCall {
        P.Layout storage l = _enabled();
        bytes32 h = keccak256(abi.encode(REPLACEMENT_TYPEHASH, action, nominee, _nonce(auth.key, PURPOSE_REPLACEMENT), auth.expiry));
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
            if (nominee == address(0) || nominee == owner || nominee == address(this) || l.signer[nominee].active) {
                revert BadNominee(nominee);
            }
            l.nominee = nominee;
            l.proposedBy = auth.key;
            l.round += 1;
            l.readyAt = 0;
            emit ReplacementProposed(nominee, auth.key, l.round);
            if (!bySigner) {
                l.readyAt = _later(l);
                emit ReplacementScheduled(nominee, l.readyAt);
            } else {
                _approve(l, auth.key);
            }
        } else if (action == REPLACE_APPROVE) {
            if (!bySigner) revert NotSigner(auth.key);
            if (l.nominee == address(0) || l.nominee != nominee) revert NoProposal();
            _approve(l, auth.key);
        } else if (action == REPLACE_CANCEL) {
            if (l.nominee == address(0)) revert NoProposal();
            emit ReplacementCancelled(l.nominee, auth.key);
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
        if (l.signer[nominee].active) revert BadNominee(nominee);
        _clearProposal(l);
        l.locked = false;
        l.lockedBy = address(0);
        l.lockedAt = 0;
        l.pendingUnlockAt = 0;
        _dropPending(l);
        while (l.allowlist.length != 0) _dropAllow(l, l.allowlist[l.allowlist.length - 1]);
        l.cooldownUntil = _later(l);
        IProtectedVaultSelf(address(this)).setOwnerFromProtection(nominee);
        emit PrimaryReplaced(previous, nominee, l.cooldownUntil);
    }

    // ─── Nonces ─────────────────────────────────────────────────────────

    /// @notice Burn the caller's next nonce for `purpose`, voiding any
    ///         signature it gave out with it. Direct call only.
    function burnNonce(uint8 purpose) external onlyDelegateCall {
        uint256 n = P.layout().nonces[msg.sender][purpose]++;
        emit NonceBurned(msg.sender, purpose, n);
    }

    // ─── Internals ──────────────────────────────────────────────────────

    function _owner() private view returns (address) {
        return IProtectedVaultSelf(address(this)).vaultOwner();
    }

    function _nonce(address key, uint8 purpose) private view returns (uint256) {
        return P.layout().nonces[key][purpose];
    }

    /// @dev Authorizes `auth` as the owner; returns the owner.
    function _asOwner(Auth calldata auth, uint8 purpose, bytes32 structHash) private returns (address owner) {
        owner = _owner();
        if (auth.key != owner) revert NotOwner(auth.key);
        _authorize(auth, purpose, structHash);
    }

    function _asOwnerOrSigner(Auth calldata auth, uint8 purpose, bytes32 structHash) private {
        if (auth.key != _owner() && !P.layout().signer[auth.key].active) revert NotOwnerOrSigner(auth.key);
        _authorize(auth, purpose, structHash);
    }

    /// @dev THE authorization rule: a direct call from the key, or the key's
    ///      EIP-712 signature (ERC-1271 for a contract) over `structHash`,
    ///      unexpired, spending its nonce for `purpose`.
    function _authorize(Auth calldata auth, uint8 purpose, bytes32 structHash) private {
        if (auth.sig.length == 0) {
            if (msg.sender != auth.key) revert BadSignature(auth.key);
            return;
        }
        if (block.timestamp > auth.expiry) revert SignatureExpired(auth.expiry);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
        if (!SignatureChecker.isValidSignatureNow(auth.key, digest, auth.sig)) revert BadSignature(auth.key);
        P.layout().nonces[auth.key][purpose]++;
    }

    /// @notice The EIP-712 domain of the vault this code runs in.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function _enabled() private view returns (P.Layout storage l) {
        l = P.layout();
        if (!l.enabled) revert NotEnabled();
    }

    function _checkDelay(uint32 delay) private pure {
        if (delay < MIN_DELAY || delay > MAX_DELAY) revert BadDelay(delay);
    }

    /// @dev A loosening change is refused while locked or in a cool-down.
    function _loosenable(P.Layout storage l) private view {
        if (l.locked) revert Locked();
        _noCooldown(l);
    }

    function _noCooldown(P.Layout storage l) private view {
        if (block.timestamp < l.cooldownUntil) revert InCooldown(l.cooldownUntil);
    }

    function _later(P.Layout storage l) private view returns (uint64) {
        return uint64(block.timestamp) + l.delay;
    }

    /// @dev Matured, and not past one further delay (then it expired).
    function _inWindow(P.Layout storage l, uint64 readyAt) private view {
        if (block.timestamp < readyAt) revert NotReady(readyAt);
        uint64 expiresAt = readyAt + l.delay;
        if (block.timestamp > expiresAt) revert Expired(expiresAt);
    }

    /// @dev Every pending change dies: a new epoch, and the setting requests
    ///      that loosen (a pending lowering, a switch-off) are cleared.
    function _dropPending(P.Layout storage l) private {
        l.epoch += 1;
        l.pendingDelayAt = 0;
        l.pendingDisableAt = 0;
    }

    function _approve(P.Layout storage l, address signerKey) private {
        if (l.approved[l.round][signerKey]) revert AlreadyApproved();
        l.approved[l.round][signerKey] = true;
        (uint256 approvals, uint256 threshold) = _tally(l);
        emit ReplacementApproved(l.nominee, signerKey, approvals, threshold);
        if (l.readyAt == 0 && approvals >= threshold) {
            l.readyAt = _later(l);
            emit ReplacementScheduled(l.nominee, l.readyAt);
        }
    }

    /// @dev Approvals of the current round by ACTIVE signers, and the majority.
    function _tally(P.Layout storage l) private view returns (uint256 approvals, uint256 threshold) {
        uint256 n = l.signers.length;
        for (uint256 i; i < n; ++i) {
            if (l.approved[l.round][l.signers[i]]) ++approvals;
        }
        threshold = n / 2 + 1;
    }

    function _clearProposal(P.Layout storage l) private {
        l.nominee = address(0);
        l.proposedBy = address(0);
        l.readyAt = 0;
    }

    function _dropAllow(P.Layout storage l, address destination) private {
        delete l.allow[destination];
        uint256 n = l.allowlist.length;
        for (uint256 i; i < n; ++i) {
            if (l.allowlist[i] == destination) {
                l.allowlist[i] = l.allowlist[n - 1];
                l.allowlist.pop();
                return;
            }
        }
    }

    /// @dev Remove `who` from a pending list (at most five long).
    function _remove(address[] storage list, address who) private {
        uint256 n = list.length;
        for (uint256 i; i < n; ++i) {
            if (list[i] == who) {
                list[i] = list[n - 1];
                list.pop();
                return;
            }
        }
    }

    function _dropSigner(P.Layout storage l, address who) private {
        uint256 n = l.signers.length;
        for (uint256 i; i < n; ++i) {
            if (l.signers[i] == who) {
                l.signers[i] = l.signers[n - 1];
                l.signers.pop();
                return;
            }
        }
    }

    /// @dev Switch-off: the record returns to empty; nonces are kept, so no
    ///      signature given before can be replayed after a re-enable.
    function _clear(P.Layout storage l) private {
        while (l.allowlist.length != 0) _dropAllow(l, l.allowlist[l.allowlist.length - 1]);
        while (l.signers.length != 0) {
            address s = l.signers[l.signers.length - 1];
            delete l.signer[s];
            l.signers.pop();
        }
        _clearProposal(l);
        l.enabled = false;
        l.locked = false;
        l.lockedBy = address(0);
        l.lockedAt = 0;
        l.delay = 0;
        l.pendingDelayAt = 0;
        l.pendingUnlockAt = 0;
        l.pendingDisableAt = 0;
        l.epoch += 1;
    }
}
