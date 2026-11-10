// src/facets/ProtectedAccountFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {VaultBeacon} from "../VaultBeacon.sol";
import {LibProtectedAccount, IVaultProtectionRead} from "../libraries/LibProtectedAccount.sol";
import {LibPositionNFT, IPositionNFTCore} from "../libraries/LibPositionNFT.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";

/// @dev The one vault-resolution route, reached by self-call so enabling
///      the mode always leaves the owner with a vault.
interface IVaultResolver {
    function getOrCreateUserVault(address user) external returns (address proxy);
}

/// @dev #3379 B2 — the one vault write the Diamond makes to a protected
///      record: a lock (tightening only), through the vault's protection code.
interface IVaultProtect {
    function protect(bytes calldata data) external returns (bytes memory);
}

interface IVaultProtectionLock {
    function lockByPlatform(address by) external;
}

/**
 * @title ProtectedAccountFacet
 * @author Vaipakam Developer Team
 * @notice #3379 Stage B2 — protected account mode is held by each vault
 *         (`VaultProtection`, run by the vault on its own record): switching it
 *         on and off, the delay, the allowlist (each destination with its
 *         #3415 "verified" flag), the secondary signers, the lock and the
 *         replacement of a lost or stolen primary wallet are written there,
 *         by the owner's or a signer's own call or signature. The Diamond only
 *         reads that record.
 *
 *         What stays here is what only the platform can do, applied FROM the
 *         vault's record and only ever tightening:
 *         - {applyProtection}: permissionless. On a switch-on, a lock or a
 *           replacement it voids every change pending at the VaultBeacon and
 *           the PositionNFT core, raises their delays toward the account's,
 *           holds the account's position NFTs (on a lock or a replacement) and
 *           cancels every queued payout row.
 *         - the co-sign requirement (on at once; off waits the vault's delay)
 *           and putting the position NFTs under the core's holder lock;
 *         - {lockVaultFor}: a keeper the owner granted locks the vault (a LOCK
 *           from the owner's linked chat);
 *         - the views, read from the vault.
 * @dev    `LibVaipakam.protectedAccount` keeps only the platform-side state:
 *         the posture last applied (so {applyProtection} acts once per change)
 *         and the co-sign setting. Its other fields, the signer and allowlist
 *         sets and the replacement proposal in Diamond storage are RETIRED by
 *         B2 and no longer written or read.
 */
contract ProtectedAccountFacet is DiamondReentrancyGuard, DiamondPausable {
    /// @notice Pending setting kinds, for {cancelSettingChange}.
    uint8 internal constant CHANGE_COSIGN_OFF = 4;
    /// @dev #3204 — a pending pin change held by the VaultBeacon. Cancelling it
    ///      here cancels it at the beacon; it is applied there, not here.
    uint8 internal constant CHANGE_UNPIN = 6;

    // ─── Events ──────────────────────────────────────────────────────────

    /// @notice The platform applied a protected posture it read from the
    ///         vault: `enabled`, `locked`, `retired` as the vault now holds them.
    /// @custom:event-category state-change/vault-mutation
    event ProtectionApplied(address indexed account, bool enabled, bool locked, bool retired, uint32 delaySeconds);
    /// @custom:event-category state-change/vault-mutation
    event SettingChangeRequested(address indexed account, uint8 indexed kind, uint256 value, uint256 effectiveAt);
    /// @custom:event-category state-change/vault-mutation
    event SettingChangeCancelled(address indexed account, uint8 indexed kind, address by);
    /// @custom:event-category state-change/vault-mutation
    event SettingChangeApplied(address indexed account, uint8 indexed kind);
    /// @custom:event-category state-change/vault-mutation
    event ProtectNftsSet(address indexed account, bool on);
    /// @custom:event-category state-change/vault-mutation
    event CosignRequirementSet(address indexed account, bool on);

    // ─── Applying the vault's posture ────────────────────────────────────

    /**
     * @notice Apply, on the platform side, the protected posture `account`'s
     *         vault holds now. Permissionless and idempotent; it only
     *         tightens, so it also runs during a pause.
     * @dev    Acts once per change of posture (recorded as the posture last
     *         applied): a switch-on voids every pending change at the beacon
     *         and the PositionNFT core and raises both delays toward the
     *         account's; a lock and a replacement also hold the position NFTs
     *         and cancel every queued payout row; a raised delay is carried to
     *         the beacon and the core. A replacement also records which
     *         account the new owner manages.
     */
    function applyProtection(address account) external nonReentrant {
        if (!_apply(account)) revert LibProtectedAccount.ChangeNotRequested();
    }

    /// @dev Apply `account`'s vault posture; false when nothing changed.
    function _apply(address account) private returns (bool changed) {
        LibProtectedAccount.Core memory c = LibProtectedAccount.core(account);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ProtectedAccount storage a = s.protectedAccount[account];
        if (c.enabled && !a.enabled) {
            _voidBeaconPending(account);
            _voidCoreLockPending(account);
            changed = true;
        }
        if (c.enabled && c.delay > a.delaySeconds) {
            _raiseBeaconPinDelay(account, c.delay);
            _raiseCoreLockDelay(account, c.delay);
            changed = true;
        }
        if ((c.locked && !a.locked) || (c.retired && !a.retired)) {
            _voidBeaconPending(account);
            _voidCoreLockPending(account);
            _lockPositionNfts(account);
            LibProtectedAccount.cancelAllRows(account, address(this));
            a.pendingCosignOffAt = 0;
            changed = true;
        }
        if (c.retired && a.controller != c.manager) {
            if (a.controller != address(0)) delete s.protectedRetiredAccountOf[a.controller];
            s.protectedRetiredAccountOf[c.manager] = account;
            a.controller = c.manager;
            changed = true;
        }
        if (!c.enabled && a.enabled) {
            _voidBeaconPending(account);
            _voidCoreLockPending(account);
            a.requireCosign = false;
            a.pendingCosignOffAt = 0;
            changed = true;
        }
        if (c.locked != a.locked || c.enabled != a.enabled || c.retired != a.retired) changed = true;
        a.enabled = c.enabled;
        a.locked = c.locked;
        a.retired = c.retired;
        a.delaySeconds = c.enabled ? c.delay : 0;
        if (changed) emit ProtectionApplied(account, c.enabled, c.locked, c.retired, c.delay);
    }

    /**
     * @notice A keeper the owner granted `KEEPER_ACTION_LOCK_VAULT` locks the
     *         owner's vault (a LOCK command from the owner's linked chat), and
     *         the lock is applied here at once. The lock counts as the
     *         owner's own. Works during a pause.
     */
    function lockVaultFor(address account) external nonReentrant {
        LibAuth.requireKeeperForPrincipal(LibVaipakam.KEEPER_ACTION_LOCK_VAULT, account);
        address vault = LibVaipakam.storageSlot().userVaipakamVaults[account];
        if (vault == address(0) || !LibProtectedAccount.isEnabled(account)) {
            revert LibProtectedAccount.ProtectedModeOff(account);
        }
        IVaultProtect(vault).protect(abi.encodeCall(IVaultProtectionLock.lockByPlatform, (account)));
        _apply(account);
    }

    // ─── NFT protection, co-sign ─────────────────────────────────────────

    /// @notice Put `account`'s position NFTs under the PositionNFT core's
    ///         holder lock now (#3205), with the lock delay raised toward the
    ///         account's delay. Turning it off is the holder's own unlock at
    ///         the core, which waits the lock's delay; the Diamond cannot.
    function lockPositionNfts(address account) external nonReentrant whenNotPaused {
        LibProtectedAccount.Core memory c = _requireManager(account);
        _raiseCoreLockDelay(account, c.delay);
        _lockPositionNfts(account);
        emit ProtectNftsSet(account, true);
    }

    /// @notice Require a secondary signer's co-sign on every release (on is
    ///         immediate and needs at least one signer; off waits the vault's
    ///         delay). #3415 — a payout to an unverified destination needs a
    ///         co-sign whenever the account has signers, whatever this says.
    function setRequireCosign(address account, bool on) external nonReentrant whenNotPaused {
        LibProtectedAccount.Core memory c = _requireManager(account);
        LibVaipakam.ProtectedAccount storage a = LibVaipakam.storageSlot().protectedAccount[account];
        if (on) {
            (,,,,, address[] memory signers,) = IVaultProtectionRead(c.vault).protectionState();
            if (signers.length == 0) revert LibProtectedAccount.NotEnoughSigners(0, 1);
            a.requireCosign = true;
            a.pendingCosignOffAt = 0;
            emit CosignRequirementSet(account, true);
            return;
        }
        if (c.locked) revert LibProtectedAccount.ProtectedVaultLocked(account);
        a.pendingCosignOffAt = uint64(block.timestamp) + c.delay;
        emit SettingChangeRequested(account, CHANGE_COSIGN_OFF, 0, a.pendingCosignOffAt);
    }

    /**
     * @notice Cancel a pending co-sign switch-off or a pending pin change at
     *         the beacon. Works during a pause.
     * @dev    Caller: the manager or any secondary signer.
     */
    function cancelSettingChange(address account, uint8 kind) external nonReentrant {
        _requireManagerOrSigner(account);
        LibVaipakam.ProtectedAccount storage a = LibVaipakam.storageSlot().protectedAccount[account];
        if (kind == CHANGE_COSIGN_OFF) {
            if (a.pendingCosignOffAt == 0) revert LibProtectedAccount.ChangeNotRequested();
            a.pendingCosignOffAt = 0;
        } else if (kind == CHANGE_UNPIN) {
            if (!_cancelBeaconPin(account)) revert LibProtectedAccount.ChangeNotRequested();
        } else {
            revert LibProtectedAccount.ChangeNotRequested();
        }
        emit SettingChangeCancelled(account, kind, msg.sender);
    }

    /// @notice Apply a matured co-sign switch-off. Permissionless.
    function finalizeSettingChanges(address account) external nonReentrant whenNotPaused {
        LibVaipakam.ProtectedAccount storage a = LibVaipakam.storageSlot().protectedAccount[account];
        if (a.pendingCosignOffAt == 0) revert LibProtectedAccount.ChangeNotRequested();
        if (block.timestamp < a.pendingCosignOffAt) revert LibProtectedAccount.ChangeNotMatured(a.pendingCosignOffAt);
        if (LibProtectedAccount.core(account).locked) revert LibProtectedAccount.ProtectedVaultLocked(account);
        a.requireCosign = false;
        a.pendingCosignOffAt = 0;
        emit CosignRequirementSet(account, false);
        emit SettingChangeApplied(account, CHANGE_COSIGN_OFF);
    }

    // ─── Views ───────────────────────────────────────────────────────────

    /// @notice `account`'s vault (where its protected record lives), and the
    ///         platform-side co-sign setting.
    function getProtection(address account)
        external
        view
        returns (address vault, bool requireCosign, uint64 pendingCosignOffAt)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ProtectedAccount storage a = s.protectedAccount[account];
        return (s.userVaipakamVaults[account], a.requireCosign, a.pendingCosignOffAt);
    }

    /// @notice Whether a listing `seller` authored may pay `recipient`
    ///         directly at fill ({LibProtectedAccount.listingLegAllowed}).
    ///         The collateral-listing executor reads it at every fill, for
    ///         each fee leg and for the seller itself (`recipient == seller`
    ///         answers whether a locked or retired account is selling).
    function isListingLegAllowed(address seller, address recipient) external view returns (bool) {
        return LibProtectedAccount.listingLegAllowed(seller, recipient);
    }

    /// @notice The replaced account `controller` now manages; zero if none.
    ///         Recorded when the replacement is applied ({applyProtection}).
    function getRetiredAccountOf(address controller) external view returns (address) {
        return LibVaipakam.storageSlot().protectedRetiredAccountOf[controller];
    }

    /// @notice #3379 B2 — the hosts of the protected-mode reads every rule
    ///         self-calls (`LibProtectedAccount.isEnabled`, `manager`,
    ///         `requireCanOpen`), so the vault read is compiled here only.
    function isProtectionOn(address account) external view returns (bool) {
        return LibProtectedAccount.core(account).enabled;
    }

    /// @notice The wallet that manages `account`: its vault's owner record.
    function protectionManagerOf(address account) external view returns (address) {
        return LibProtectedAccount.core(account).manager;
    }

    /// @notice Refuse a NEW position for a locked or retired account.
    function requireCanOpenFor(address account) external view {
        LibProtectedAccount.requireCanOpenLocal(account);
    }

    /// @notice The bounds of the delay, in seconds.
    function getProtectedDelayBounds() external pure returns (uint256 minDelay, uint256 maxDelay) {
        return (LibProtectedAccount.MIN_DELAY, LibProtectedAccount.MAX_DELAY);
    }

    // ─── Internals ───────────────────────────────────────────────────────

    function _requireManager(address account) private view returns (LibProtectedAccount.Core memory c) {
        c = LibProtectedAccount.core(account);
        if (!c.enabled) revert LibProtectedAccount.ProtectedModeOff(account);
        if (msg.sender != c.manager) revert LibProtectedAccount.NotAccountManager(account, msg.sender);
    }

    function _requireManagerOrSigner(address account) private view {
        LibProtectedAccount.Core memory c = LibProtectedAccount.core(account);
        if (!c.enabled) revert LibProtectedAccount.ProtectedModeOff(account);
        if (msg.sender != c.manager && !LibProtectedAccount.isSigner(account, msg.sender)) {
            revert LibProtectedAccount.NotManagerOrSigner(account, msg.sender);
        }
    }

    /// @dev #3205 — the PositionNFT core, or 0 before it is set.
    function _positionCore() private view returns (IPositionNFTCore) {
        return IPositionNFTCore(LibPositionNFT._storage().core);
    }

    function _voidCoreLockPending(address account) private {
        IPositionNFTCore c = _positionCore();
        if (address(c) == address(0)) return;
        c.voidPending(account);
    }

    function _lockPositionNfts(address account) private {
        IPositionNFTCore c = _positionCore();
        if (address(c) == address(0)) return;
        c.lockFor(account);
    }

    function _raiseCoreLockDelay(address account, uint256 delaySeconds) private {
        IPositionNFTCore c = _positionCore();
        if (address(c) == address(0)) return;
        uint256 cap = c.MAX_DIAMOND_LOCK_DELAY();
        uint256 d = delaySeconds > cap ? cap : delaySeconds;
        (, uint256 current,,,) = c.lockOf(account);
        if (d > current) c.raiseLockDelay(account, d);
    }

    function _beaconAndVault(address account) private view returns (VaultBeacon beacon, address vault) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        beacon = VaultBeacon(s.vaultBeacon);
        vault = s.userVaipakamVaults[account];
    }

    function _voidBeaconPending(address account) private {
        (VaultBeacon beacon, address vault) = _beaconAndVault(account);
        if (vault == address(0) || address(beacon) == address(0)) return;
        beacon.voidPending(vault);
    }

    function _cancelBeaconPin(address account) private returns (bool) {
        (VaultBeacon beacon, address vault) = _beaconAndVault(account);
        if (vault == address(0) || address(beacon) == address(0)) return false;
        (, uint256 at) = beacon.pendingPinOf(vault);
        if (at == 0) return false;
        beacon.cancelPin(vault, "");
        return true;
    }

    function _raiseBeaconPinDelay(address account, uint256 delaySeconds) private {
        (VaultBeacon beacon, address vault) = _beaconAndVault(account);
        if (vault == address(0) || address(beacon) == address(0)) return;
        uint256 cap = beacon.MAX_DIAMOND_PIN_DELAY();
        uint256 d = delaySeconds > cap ? cap : delaySeconds;
        if (d > beacon.pinDelay(vault)) beacon.raisePinDelay(vault, d);
    }
}
