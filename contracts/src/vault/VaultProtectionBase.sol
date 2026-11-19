// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {LibVaultProtectionStorage as P} from "./LibVaultProtectionStorage.sol";
import {VaultOutflowTypes} from "./VaultOutflowTypes.sol";

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
/// @dev The Diamond's permissionless application of a vault's protected
///      posture ({ProtectedAccountFacet.applyProtection}).
interface IProtectionApply {
    function applyProtection(address account) external;
}

/// @dev #3246 part 2 — the Diamond's half of a clawback
///      ({RecoveryClawbackFacet.applyClawback}): moves the named assets' free
///      balance to the recovery address in force, which it reads from this
///      vault. Callable only by the account's own vault.
interface IRecoveryClawbackApply {
    function applyClawback(address account, address by, uint8 role, VaultOutflowTypes.ClawbackAsset[] calldata assets)
        external;
}

interface IPayoutRowsView {
    function getPendingPayoutIds(address account) external view returns (uint256[] memory);
}

/**
 * @title  VaultProtectionBase
 * @author Vaipakam Developer Team
 * @notice The shared part of a vault's protected-mode code: its bounds,
 *         nonce lanes and typehashes, its events and errors, and the
 *         authorization, epoch and platform-apply rules both code contracts
 *         use. {VaultProtection} carries the settings, allowlist, signers,
 *         lock and replacement; {VaultRecovery} carries the recovery address
 *         and the clawback (#3246 part 2), split off because the two together
 *         passed the contract size limit. Both run only inside a vault
 *         (a delegatecall), on the one record in `LibVaultProtectionStorage`.
 */
abstract contract VaultProtectionBase {
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
    /// @dev #3246 part 2 — the owner sets, changes or clears the recovery
    ///      address; the recovery address proves control of itself; the owner
    ///      or a signer triggers a clawback. Each its own nonce lane.
    uint8 public constant PURPOSE_RECOVERY = 8;
    uint8 public constant PURPOSE_RECOVERY_PROOF = 9;
    uint8 public constant PURPOSE_CLAWBACK = 10;
    /// @notice #3246 part 2 — a replaced account's request to move its
    ///         position tokens to the wallet that replaced it.
    uint8 public constant PURPOSE_POSITION_MOVE = 11;


    /// @notice #3756 — why an open claim ended, as {RecoveryClaimEnded}
    ///         reports it (internal, to keep {VaultProtection} small; the
    ///         values are stated here and in the event's notes).
    uint8 internal constant CLAIM_END_CANCEL = 0;
    uint8 internal constant CLAIM_END_OWNER_CALL = 1;
    uint8 internal constant CLAIM_END_SWITCHED_OFF = 2;
    uint8 internal constant CLAIM_END_LOCK = 3;
    uint8 internal constant CLAIM_END_REPLACEMENT = 4;
    uint8 internal constant CLAIM_END_CLAWBACK = 5;
    uint8 internal constant CLAIM_END_PROTECTION_OFF = 6;
    /// @notice #3756 — no new request for this long after a claim was
    ///         cancelled or dropped (internal, like the end reasons).
    uint32 internal constant CLAIM_PAUSE = 30 days;

    /// @notice #3246 part 2 — how long a CHANGE of the recovery address waits
    ///         (owner decision 2026-11-06). A first setting waits twice the
    ///         account's delay instead (twice {MIN_DELAY} while protected mode
    ///         is off).
    uint32 public constant RECOVERY_CHANGE_WAIT = 30 days;

    /// @notice Who triggered a clawback, as {AccountRecovered} and the
    ///         Diamond's clawback event report it. 2 is reserved for the
    ///         keeper acting on the owner's linked chat, which needs its own
    ///         keeper grant and is not built yet.
    uint8 public constant TRIGGER_OWNER = 0;
    uint8 public constant TRIGGER_SIGNER = 1;

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

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant NAME_HASH = keccak256("Vaipakam Vault");
    bytes32 internal constant VERSION_HASH = keccak256("1");

    bytes32 public constant SETTINGS_TYPEHASH =
        keccak256("Settings(uint8 action,uint256 value,uint256 nonce,uint64 expiry)");
    bytes32 public constant ALLOWLIST_ADD_TYPEHASH =
        keccak256("AllowlistAdd(address destination,uint256 nonce,uint64 expiry)");
    bytes32 public constant ALLOWLIST_CANCEL_TYPEHASH =
        keccak256("AllowlistCancel(address destination,uint256 nonce,uint64 expiry)");
    /// @dev Codex #3489 r1 — every operation has its OWN typehash, so a
    ///      signature for one can never be replayed as another (a protective
    ///      cancel as a loosening request) even where two nonce lanes meet.
    bytes32 public constant ALLOWLIST_REMOVE_TYPEHASH =
        keccak256("AllowlistRemove(address destination,uint256 nonce,uint64 expiry)");
    bytes32 public constant SETTING_CANCEL_TYPEHASH =
        keccak256("SettingCancel(uint8 action,uint256 nonce,uint64 expiry)");
    bytes32 public constant SIGNER_CHANGE_TYPEHASH =
        keccak256("SignerChange(uint8 action,address signer,uint256 nonce,uint64 expiry)");
    /// @dev Codex #3489 r2/r3 — ONE signed shape for every replacement
    ///      action (propose, approve, cancel), bound to the proposal ROUND in
    ///      force when it is submitted, so no action's signature outlives the
    ///      proposal it was given for: a cancel or an approval held from an
    ///      earlier round is refused after a re-proposal, even of the same
    ///      nominee. A proposal signs the round it replaces (0 for none).
    bytes32 public constant REPLACEMENT_TYPEHASH =
        keccak256("Replacement(uint8 action,address nominee,uint32 round,uint256 nonce,uint64 expiry)");
    bytes32 public constant LOCK_TYPEHASH = keccak256("Lock(uint256 nonce,uint64 expiry)");
    /// @dev #3415 — the destination names the account (the vault's creation
    ///      owner), the Diamond and, through the domain, the chain and vault.
    bytes32 public constant VERIFY_TYPEHASH =
        keccak256("VerifyDestination(address account,address diamond,uint64 request,uint256 nonce,uint64 expiry)");
    /// @dev #3246 part 2 — the owner asks for `recovery` as the recovery
    ///      address (a first setting or a change).
    bytes32 public constant RECOVERY_SET_TYPEHASH =
        keccak256("RecoverySet(address recovery,uint256 nonce,uint64 expiry)");
    /// @dev The recovery address's own proof of control: it names the account
    ///      and the Diamond and, through the domain, the chain and the vault.
    bytes32 public constant RECOVERY_PROOF_TYPEHASH =
        keccak256("RecoveryProof(address account,address diamond,uint256 nonce,uint64 expiry)");
    /// @dev The owner or a signer cancels the pending setting it names.
    bytes32 public constant RECOVERY_CANCEL_TYPEHASH =
        keccak256("RecoveryCancel(address recovery,uint256 nonce,uint64 expiry)");
    /// @dev The owner clears the recovery address (protected mode off only).
    bytes32 public constant RECOVERY_CLEAR_TYPEHASH = keccak256("RecoveryClear(uint256 nonce,uint64 expiry)");
    /// @dev The owner or a signer claws back; `assets` is
    ///      keccak256(abi.encode(the ClawbackAsset list)).
    bytes32 public constant CLAWBACK_TYPEHASH = keccak256("Clawback(bytes32 assets,uint256 nonce,uint64 expiry)");
    /// @notice #3246 part 2 — the replacing wallet asks to move the replaced
    ///         account's position tokens to itself (`to`, the owner record).
    bytes32 public constant POSITION_MOVE_TYPEHASH =
        keccak256("PositionMove(address to,uint256 nonce,uint64 expiry)");
    /// @notice The owner or a signer cancels the pending move maturing `at`.
    bytes32 public constant POSITION_MOVE_CANCEL_TYPEHASH =
        keccak256("PositionMoveCancel(uint64 at,uint256 nonce,uint64 expiry)");


    /// @notice How a key authorizes one write: `sig` empty means a direct call
    ///         from `key`; otherwise its EIP-712 / ERC-1271 signature.
    struct Auth {
        address key;
        uint64 expiry;
        bytes sig;
    }

    address internal immutable SELF;

    // ─── Events (one per record write) ──────────────────────────────────
    //
    // #3719 — every event names the ACCOUNT (the vault's creation owner, the
    // account's stable identity across a primary replacement) as its first,
    // indexed field, so an alert service can filter one account's events
    // without first mapping vault addresses to accounts.

    event ProtectionEnabled(address indexed account, uint32 delay, address by);
    event ProtectionSettingRequested(address indexed account, uint8 indexed action, uint256 value, uint64 at, address by);
    event ProtectionSettingApplied(address indexed account, uint8 indexed action, uint256 value);
    event ProtectionSettingCancelled(address indexed account, uint8 indexed action, address by);
    event ProtectionDisabled(address indexed account);
    event AllowlistAddRequested(address indexed account, address indexed destination, uint64 readyAt, address by);
    event AllowlistAddCancelled(address indexed account, address indexed destination, address by);
    event AllowlistAdded(address indexed account, address indexed destination);
    event AllowlistRemoved(address indexed account, address indexed destination, address by);
    event DestinationVerified(address indexed account, address indexed destination);
    event SignerAddRequested(address indexed account, address indexed signer, uint64 readyAt, address by);
    event SignerAccepted(address indexed account, address indexed signer);
    event SignerAdded(address indexed account, address indexed signer);
    event SignerRemoveRequested(address indexed account, address indexed signer, uint64 readyAt, address by);
    event SignerChangeCancelled(address indexed account, address indexed signer, address by);
    event SignerRemoved(address indexed account, address indexed signer);
    event VaultLocked(address indexed account, address indexed by);
    event ReplacementProposed(address indexed account, address indexed nominee, address indexed by, uint32 round);
    event ReplacementApproved(address indexed account, address indexed nominee, address indexed signer, uint256 approvals, uint256 threshold);
    event ReplacementScheduled(address indexed account, address indexed nominee, uint64 readyAt);
    event ReplacementCancelled(address indexed account, address indexed nominee, address by);
    event PrimaryReplaced(address indexed account, address indexed previousOwner, address indexed newOwner, uint64 cooldownUntil);
    event NonceBurned(address indexed account, address indexed key, uint8 indexed purpose, uint256 nonce);
    /// @notice #3246 part 2 — the owner asked for `recovery` as the account's
    ///         recovery address; it comes into force at `at` unless it is
    ///         cancelled or dropped first.
    event RecoveryAddressRequested(address indexed account, address indexed recovery, uint64 at, address by);
    /// @notice A pending recovery address that had come into force was
    ///         written into the record (it counted from `at` on already).
    event RecoveryAddressSet(address indexed account, address indexed previous, address indexed recovery);
    /// @notice The owner or a signer cancelled the pending recovery address.
    event RecoveryAddressCancelled(address indexed account, address indexed recovery, address by);
    /// @notice A lock, a replacement, a switch-off or a clawback dropped the
    ///         pending recovery address before it came into force.
    event RecoveryAddressDropped(address indexed account, address indexed recovery);
    /// @notice The owner cleared the recovery address (protected mode off).
    event RecoveryAddressCleared(address indexed account, address indexed recovery, address by);
    /// @notice The account was clawed back for the first time: it is locked
    ///         and recovered for good, and its free balance pays `recovery`.
    ///         The Diamond's `AccountClawedBack` lists what moved.
    event AccountRecovered(address indexed account, address indexed recovery, address indexed by, uint8 role);
    /// @notice #3246 part 2 — the wallet that replaced `account` asked to move
    ///         the account's position tokens to itself (`to`). They may move
    ///         from `readyAt` until one further delay later, unless the
    ///         request is cancelled or dropped first. An alert reports it as
    ///         it reports a proposed replacement.
    event PositionMoveRequested(address indexed account, address indexed to, uint64 readyAt, address by);
    /// @notice The owner or a signer cancelled the pending position move.
    event PositionMoveCancelled(address indexed account, uint64 readyAt, address by);
    /// @notice A lock, a further replacement or a clawback dropped the pending
    ///         position move.
    event PositionMoveDropped(address indexed account, uint64 readyAt);

    /// @notice #3756 — the owner asked to switch the recovery claim on, or to
    ///         shorten its wait; it comes into force at `at` unless it is
    ///         cancelled or dropped first.
    event RecoveryClaimSettingRequested(address indexed account, uint32 wait, uint64 at, address by);
    /// @notice The recovery-claim setting in the record changed: a switch-off
    ///         or a lengthening (at once), a pending change written once in
    ///         force, or protected mode switched off (off).
    event RecoveryClaimSettingChanged(address indexed account, bool allowed, uint32 wait);
    /// @notice The owner or a signer cancelled the pending claim setting.
    event RecoveryClaimSettingCancelled(address indexed account, uint64 at, address by);
    /// @notice The recovery address asked for the account. The claim may run
    ///         from `runnableAt` until `lapsesAt`; neither date ever moves.
    event RecoveryClaimRequested(
        address indexed account, address indexed recovery, uint64 requestedAt, uint64 runnableAt, uint64 lapsesAt
    );
    /// @notice The open claim asked at `requestedAt` ended without running:
    ///         cancelled, or dropped (`reason`, a CLAIM_END_* value). `by` is
    ///         the key that acted, 0 where the step names none. No new request
    ///         is accepted before `newRequestAt`.
    event RecoveryClaimEnded(
        address indexed account, uint64 requestedAt, address by, uint8 reason, uint64 newRequestAt
    );

    /// @notice #3719 — a role on the account changed: the owner (primary
    ///         wallet), a secondary signer, or the recovery nominee (a
    ///         replacement proposed, then cleared by its cancellation or
    ///         completion). `oldAddr` 0 = the role was added; `newAddr` 0 =
    ///         removed. Emitted beside the specific event, so one filter on
    ///         this topic catches every change an alert must report.
    event ProtectionRoleChanged(address indexed account, uint8 indexed role, address oldAddr, address newAddr);

    /// @notice {ProtectionRoleChanged} roles.
    uint8 public constant ROLE_OWNER = 0;
    uint8 public constant ROLE_SIGNER = 1;
    uint8 public constant ROLE_RECOVERY_NOMINEE = 2;
    /// @notice #3246 part 2 — the recovery address. A request names the
    ///         address the account is heading to (`newAddr`); a cancellation
    ///         or a drop names the one that stays; a clear names 0.
    uint8 public constant ROLE_RECOVERY_ADDRESS = 3;

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
    /// @dev Codex #3489 r4 — a replacement may not name the account's own
    ///      wallet: neither its creation owner (which would undo the
    ///      retirement) nor the wallet that holds it now.
    error NomineeIsAccountWallet(address nominee);
    error NotEnoughSigners(uint256 have, uint256 need);
    error AlreadyApproved();
    error NoProposal();
    error OwnerBlockedBySignerLock();
    error PendingRowsExist();
    /// @dev Codex #3489 r5 — a replaced account's protection is permanent.
    error RetiredAccount();
    error CannotCancelOwnRemoval(address signer);
    /// @notice The platform application ran out of gas: the transaction was
    ///         sent with too little gas for it, so the vault's change is
    ///         refused rather than landing without its platform side.
    error PlatformApplyOutOfGas();
    /// @notice #3246 part 2 — the step needs a recovery address (set, or in
    ///         force where stated).
    error RecoveryRequired();
    /// @notice The address may not be the recovery address (3.1).
    error BadRecovery(address recovery);
    /// @notice The recovery address can be cleared only while protected mode
    ///         is off.
    error RecoveryInUse();
    /// @notice A recovered account stays locked and protected for good.
    error RecoveredAccount();
    /// @notice #3246 part 2 — moving positions to a replacing wallet needs a
    ///         completed replacement.
    error NotReplaced();
    /// @notice #3756 — the claim's wait is outside 30 to 365 days.
    error BadClaimWait(uint32 wait);
    /// @notice The account does not allow a recovery claim.
    error ClaimNotAllowed();
    /// @notice A claim is already open.
    error ClaimOpen();
    /// @notice No claim is open.
    error NoClaim();
    /// @notice A new request waits until `until` after a cancellation or drop.
    error ClaimPaused(uint64 until);
    /// @notice Refused while a change of recovery address is pending.
    error RecoveryChangePending();
    /// @notice The key is not the recovery address in force.
    error NotRecovery(address key);
    /// @notice The setting asked for is the one already in force.
    error ClaimSettingUnchanged();

    constructor() {
        SELF = address(this);
    }

    /// @dev Every write runs only inside a vault (a delegatecall), never on
    ///      this contract's own storage.
    modifier onlyDelegateCall() {
        if (address(this) == SELF) revert NotDelegateCall();
        _;
    }

    // ─── Internals ──────────────────────────────────────────────────────

    /// @dev The Diamond's refusal when its record already matches the vault
    ///      (`LibProtectedAccount.ChangeNotRequested()`): nothing to apply.
    bytes4 internal constant CHANGE_NOT_REQUESTED = bytes4(keccak256("ChangeNotRequested()"));

    /// @dev Apply this vault's posture on the platform side, through the
    ///      Diamond's permissionless `applyProtection` (the queued payouts
    ///      cancelled, the platform-held pending changes voided, the position
    ///      NFTs held), in the same transaction as the vault's own change. It
    ///      is STRICT (owner security review of #3489): a lock, an unlock, a
    ///      switch-off and a replacement each change the posture the platform
    ///      applies, so any refusal reverts the vault's change with it (the
    ///      Diamond's reentrancy guard included); an out-of-gas failure, which
    ///      carries no data, reverts as {PlatformApplyOutOfGas} so a gas
    ///      estimate funds the application. The one tolerated answer is
    ///      "nothing to apply" (the platform already matches the vault, as for
    ///      a switch-off the platform never saw switched on).
    function _applyPlatform() internal {
        IProtectedVaultSelf self = IProtectedVaultSelf(address(this));
        IProtectionApply diamondApply = IProtectionApply(self.vaultDiamond());
        try diamondApply.applyProtection(self.vaultCreationOwner()) {}
        catch (bytes memory reason) {
            if (reason.length == 0) revert PlatformApplyOutOfGas();
            if (reason.length == 4 && bytes4(reason) == CHANGE_NOT_REQUESTED) return;
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
    }

    // ─── #3246 part 2 internals ──────────────────────────────────────────

    /// @dev Whether the account has a recovery address set: in force, or a
    ///      live pending one (3.5: switching on and requesting a signer).
    function _hasRecovery(P.Layout storage l) internal view returns (bool) {
        return P.recoveryInForce(l) != address(0) || P.recoveryPending(l) != address(0);
    }

    /// @dev Whether `a` is the recovery address: the written one, the one in
    ///      force, or a live pending one. Refused as a signer, a nominee or a
    ///      destination, at the request and at finalization (3.1).
    function _isRecovery(P.Layout storage l, address a) internal view returns (bool) {
        if (a == address(0)) return false;
        return a == l.recovery || a == P.recoveryInForce(l) || a == P.recoveryPending(l);
    }

    /// @dev 3.1 — what the recovery address may not be: zero, this vault, the
    ///      Diamond, either of the account's own wallets, the address already
    ///      in force, a signer (active or pending), the open nominee, or an
    ///      allowlisted destination (active or pending).
    function _checkRecoveryIdentity(P.Layout storage l, address a) internal view {
        if (
            a == address(0) || a == address(this) || a == IProtectedVaultSelf(address(this)).vaultDiamond()
                || _isAccountWallet(a) || a == l.recovery || a == l.nominee
        ) revert BadRecovery(a);
        P.Signer storage sg = l.signer[a];
        if (sg.active || (sg.addAt != 0 && sg.epoch == l.epoch)) revert BadRecovery(a);
        P.Entry storage e = l.allow[a];
        if (e.active || (e.readyAt != 0 && e.epoch == l.epoch)) revert BadRecovery(a);
    }

    /// @dev Write a pending address whose wait has passed into the record (it
    ///      already counted). A pending one from an earlier epoch was dropped
    ///      when the epoch moved ({_advanceEpoch}); cleared here defensively.
    function _settleRecovery(P.Layout storage l) internal {
        address p = l.pendingRecovery;
        if (p == address(0)) return;
        if (l.pendingRecoveryEpoch != l.epoch) {
            _clearPendingRecovery(l);
            return;
        }
        if (block.timestamp < l.pendingRecoveryAt) return;
        address previous = l.recovery;
        l.recovery = p;
        _clearPendingRecovery(l);
        emit RecoveryAddressSet(_account(), previous, p);
    }

    function _clearPendingRecovery(P.Layout storage l) internal {
        l.pendingRecovery = address(0);
        l.pendingRecoveryAt = 0;
        l.pendingRecoveryEpoch = 0;
    }

    // ─── #3756 internals — the recovery claim ───────────────────────────

    /// @dev Write a pending claim setting that has come into force into the
    ///      record; clear one from an earlier epoch (dropped).
    function _settleClaimSetting(P.Layout storage l) internal {
        uint32 w = l.pendingClaimWait;
        if (w == 0) return;
        if (l.pendingClaimEpoch != l.epoch) {
            _clearPendingClaimSetting(l);
            return;
        }
        if (block.timestamp < l.pendingClaimAt) return;
        l.claimAllowed = true;
        l.claimWait = w;
        _clearPendingClaimSetting(l);
        emit RecoveryClaimSettingChanged(_account(), true, w);
    }

    function _clearPendingClaimSetting(P.Layout storage l) internal {
        l.pendingClaimWait = 0;
        l.pendingClaimAt = 0;
        l.pendingClaimEpoch = 0;
    }

    function _clearClaim(P.Layout storage l) internal {
        l.claimBy = address(0);
        l.claimRequestedAt = 0;
        l.claimRunnableAt = 0;
        l.claimLapsesAt = 0;
        l.claimEpoch = 0;
    }

    /// @dev THE one way an open claim ends without running (4.4): a cancel,
    ///      an owner's direct call, switching the claim off, an epoch advance
    ///      (lock, replacement, clawback) and switching protected mode off.
    ///      A live claim is cleared, the 30-day pause starts and the event is
    ///      emitted; a lapsed or stale one is only cleared (a lapse starts no
    ///      pause).
    function _endClaim(P.Layout storage l, address by, uint8 reason) internal {
        uint64 at = l.claimRequestedAt;
        if (at == 0) return;
        bool live = P.claimOpen(l) != 0;
        _clearClaim(l);
        if (!live) return;
        uint64 until = uint64(block.timestamp) + CLAIM_PAUSE;
        l.claimPauseUntil = until;
        emit RecoveryClaimEnded(_account(), at, by, reason, until);
    }

    /// @dev THE epoch advance (a lock, a replacement, a switch-off, a
    ///      clawback). A matured recovery address is never dropped (3.2): it
    ///      is written first; only a still-waiting one dies with the epoch.
    function _advanceEpoch(P.Layout storage l, address by, uint8 reason) internal {
        _settleRecovery(l);
        // #3756 — a matured claim setting is written first, like the recovery
        // address; a still-waiting one dies with the epoch. An open claim ends
        // through the one helper, so the pause starts and the event names it.
        _settleClaimSetting(l);
        _endClaim(l, by, reason);
        address p = l.pendingRecovery;
        if (p != address(0)) {
            _clearPendingRecovery(l);
            emit RecoveryAddressDropped(_account(), p);
            emit ProtectionRoleChanged(_account(), ROLE_RECOVERY_ADDRESS, p, l.recovery);
        }
        uint64 move = P.positionMovePending(l);
        if (move != 0) {
            l.positionMoveAt = 0;
            emit PositionMoveDropped(_account(), move);
        }
        l.epoch += 1;
    }

    /// @dev The ONE rule for "the account's own wallets" (Codex #3489 r7):
    ///      its creation owner (the original wallet, retired for good once a
    ///      replacement moved the owner record) and the wallet that holds it
    ///      now. Neither may be named as a signer, a replacement nominee or a
    ///      payout destination.
    function _isAccountWallet(address a) internal view returns (bool) {
        return a == _owner() || a == IProtectedVaultSelf(address(this)).vaultCreationOwner();
    }

    /// @dev #3719 — the account every event names: the vault's creation
    ///      owner, which a primary replacement does not change.
    function _account() internal view returns (address) {
        return IProtectedVaultSelf(address(this)).vaultCreationOwner();
    }

    function _owner() internal view returns (address) {
        return IProtectedVaultSelf(address(this)).vaultOwner();
    }

    function _nonce(address key, uint8 purpose) internal view returns (uint256) {
        return P.layout().nonces[key][purpose];
    }

    /// @dev Authorizes `auth` as the owner; returns the owner.
    function _asOwner(Auth calldata auth, uint8 purpose, bytes32 structHash) internal returns (address owner) {
        owner = _owner();
        if (auth.key != owner) revert NotOwner(auth.key);
        _authorize(auth, purpose, structHash);
    }

    function _asOwnerOrSigner(Auth calldata auth, uint8 purpose, bytes32 structHash) internal {
        if (auth.key != _owner() && !P.layout().signer[auth.key].active) revert NotOwnerOrSigner(auth.key);
        _authorize(auth, purpose, structHash);
    }

    /// @dev THE authorization rule: a direct call from the key, or the key's
    ///      EIP-712 signature (ERC-1271 for a contract) over `structHash`,
    ///      unexpired, spending its nonce for `purpose`.
    function _authorize(Auth calldata auth, uint8 purpose, bytes32 structHash) internal {
        if (auth.sig.length == 0) {
            if (msg.sender != auth.key) revert BadSignature(auth.key);
            // #3756 4.4 — a write the owner's key sends itself shows the key is
            // held now, which an open claim asserts is no longer true: it ends
            // the claim. A signature someone else submits never does (it shows
            // only that the key was held when it was signed).
            P.Layout storage l = P.layout();
            if (l.claimRequestedAt != 0 && auth.key == _owner()) _endClaim(l, auth.key, CLAIM_END_OWNER_CALL);
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

    function _enabled() internal view returns (P.Layout storage l) {
        l = P.layout();
        if (!l.enabled) revert NotEnabled();
    }

    function _checkDelay(uint32 delay) internal pure {
        if (delay < MIN_DELAY || delay > MAX_DELAY) revert BadDelay(delay);
    }

    /// @dev A loosening change is refused while locked or in a cool-down.
    function _loosenable(P.Layout storage l) internal view {
        if (l.locked) revert Locked();
        _noCooldown(l);
    }

    function _noCooldown(P.Layout storage l) internal view {
        if (block.timestamp < l.cooldownUntil) revert InCooldown(l.cooldownUntil);
    }

    function _later(P.Layout storage l) internal view returns (uint64) {
        return uint64(block.timestamp) + l.delay;
    }

    /// @dev Matured, and not past one further delay (then it expired).
    function _inWindow(P.Layout storage l, uint64 readyAt) internal view {
        if (block.timestamp < readyAt) revert NotReady(readyAt);
        uint64 expiresAt = readyAt + l.delay;
        if (block.timestamp > expiresAt) revert Expired(expiresAt);
    }

    /// @dev Every pending change dies: a new epoch, and the setting requests
    ///      that loosen (a pending lowering, a switch-off) are cleared.
    function _dropPending(P.Layout storage l, address by, uint8 reason) internal {
        _advanceEpoch(l, by, reason);
        l.pendingDelayAt = 0;
        l.pendingDisableAt = 0;
    }

    function _approve(P.Layout storage l, address signerKey) internal {
        if (l.approved[l.round][signerKey]) revert AlreadyApproved();
        l.approved[l.round][signerKey] = true;
        (uint256 approvals, uint256 threshold) = _tally(l);
        emit ReplacementApproved(_account(), l.nominee, signerKey, approvals, threshold);
        if (l.readyAt == 0 && approvals >= threshold) {
            l.readyAt = _later(l);
            emit ReplacementScheduled(_account(), l.nominee, l.readyAt);
        }
    }

    /// @dev Approvals of the current round by ACTIVE signers, and the majority.
    function _tally(P.Layout storage l) internal view returns (uint256 approvals, uint256 threshold) {
        uint256 n = l.signers.length;
        for (uint256 i; i < n; ++i) {
            if (l.approved[l.round][l.signers[i]]) ++approvals;
        }
        threshold = n / 2 + 1;
    }

    function _clearProposal(P.Layout storage l) internal {
        l.nominee = address(0);
        l.proposedBy = address(0);
        l.readyAt = 0;
    }

    function _dropAllow(P.Layout storage l, address destination) internal {
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
    function _remove(address[] storage list, address who) internal {
        uint256 n = list.length;
        for (uint256 i; i < n; ++i) {
            if (list[i] == who) {
                list[i] = list[n - 1];
                list.pop();
                return;
            }
        }
    }

    function _dropSigner(P.Layout storage l, address who) internal {
        uint256 n = l.signers.length;
        for (uint256 i; i < n; ++i) {
            if (l.signers[i] == who) {
                l.signers[i] = l.signers[n - 1];
                l.signers.pop();
                if (n == 1) ++l.signersEmptied;
                return;
            }
        }
    }

    /// @dev Switch-off: the record returns to empty; nonces are kept, so no
    ///      signature given before can be replayed after a re-enable.
    function _clear(P.Layout storage l) internal {
        while (l.allowlist.length != 0) _dropAllow(l, l.allowlist[l.allowlist.length - 1]);
        if (l.signers.length != 0) ++l.signersEmptied;
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
        // #3756 4.1 — switching protected mode off switches the claim off and
        // ends an open one; switching it on again leaves it off.
        _endClaim(l, address(0), CLAIM_END_PROTECTION_OFF);
        bool claimWasOn = l.claimAllowed || l.pendingClaimWait != 0;
        l.claimAllowed = false;
        l.claimWait = 0;
        _clearPendingClaimSetting(l);
        if (claimWasOn) emit RecoveryClaimSettingChanged(_account(), false, 0);
        // #3246 part 2 — the recovery address in force is kept (ruling 7,
        // 2026-11-18); a pending one is dropped with every other change.
        _advanceEpoch(l, address(0), CLAIM_END_PROTECTION_OFF);
    }
}
