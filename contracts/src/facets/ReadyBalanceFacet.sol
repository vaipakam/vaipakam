// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibProtectedAccount} from "../libraries/LibProtectedAccount.sol";
import {LibReadyBalance} from "../libraries/LibReadyBalance.sol";
import {LibDepositoryLedger} from "../libraries/LibDepositoryLedger.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";

/// @dev The deposit route on VaultFactoryFacet (a self-call).
interface IReadyDepositRoute {
    function vaultDepositERC20(address user, address token, uint256 amount) external;
}

/**
 * @title ReadyBalanceFacet
 * @notice #3344 — a protected account's Ready balance: the part of its free
 *         ERC-20 vault balance its own actions may spend on a protocol step
 *         at once (a vault-backed signed offer, an instant-market borrow's
 *         collateral, an auto-extension charge beyond the loan's reserve).
 *         The rest of the vault is the Protected balance. Moving Protected
 *         into Ready waits the account's delay and the account or any signer
 *         may cancel it; Ready back to Protected is instant; a deposit from
 *         the wallet straight into Ready is instant. Ready never pays a
 *         wallet: the depository withdraw does not reach it.
 * @dev    The rules live in `LibReadyBalance`; this facet holds the entries,
 *         the views and the spend host {spendReady}, which every spend site
 *         reaches through a self-call. Design:
 *         `docs/DesignsAndPlans/ReadyBalanceDesign.md`. Refreshed together
 *         with OfferMaterializeFacet, InstantFillFacet, AutoLifecycleFacet,
 *         VaultDepositoryFacet and the vault template.
 */
contract ReadyBalanceFacet is DiamondReentrancyGuard, DiamondPausable {
    /// @notice How a Ready move went. `ProtectedToReady` is reported when a
    ///         matured top-up is folded in, and carries the time it counted
    ///         from in {ReadyMoved}'s `at`.
    enum Direction {
        WalletToReady,
        ProtectedToReady,
        ReadyToProtected,
        Spent
    }

    /// @notice Ready moved for `account` in `asset`. `at` is when the move
    ///         took effect (for a folded top-up, the time it began to count).
    event ReadyMoved(
        address indexed account, address indexed asset, Direction direction, uint256 amount, uint64 at
    );
    /// @notice A Protected → Ready top-up was asked for; it counts from
    ///         `liveAt` unless cancelled or voided by a lock, a switch-off or
    ///         a replacement first. Replaces any pending top-up of `asset`.
    event ReadyTopUpRequested(address indexed account, address indexed asset, uint256 amount, uint64 liveAt);
    /// @notice A pending top-up was cancelled by `by` (the account or a
    ///         signer).
    event ReadyTopUpCancelled(address indexed account, address indexed asset, uint256 amount, address by);
    /// @notice The idle period now in force (0 = no expiry).
    event ReadyIdlePeriodSet(address indexed account, uint32 idle);
    /// @notice A lengthening or switch-off of the idle period was asked; it
    ///         applies at `liveAt`.
    event ReadyIdlePeriodChangeRequested(address indexed account, uint32 idle, uint64 liveAt);
    /// @notice `asset`'s Ready counts until `until` while an idle period is
    ///         set (a top-up, a spend or an owner extension set it).
    event ReadyUntilSet(address indexed account, address indexed asset, uint64 until);

    error ReadyAmountZero();
    error ReadyExceedsFree(uint256 requested, uint256 available);
    error ReadyNoPendingTopUp();
    error ReadyNotOwner(address account, address caller);
    error ReadyNotOwnerOrSigner(address account, address caller);

    /// @notice One asset's Ready, as the app shows it.
    struct ReadyView {
        uint256 effective; // what counts now (capped by free balance)
        uint256 stored; // the stored amount, before the cap and the rules
        uint256 pending; // a top-up waiting (or matured, not yet folded)
        uint64 pendingAt; // when it counts
        uint64 readyUntil; // when Ready stops counting (0 = no expiry)
        uint256 free; // the account's free balance of the asset
        LibReadyBalance.Status status; // why it counts as zero, if it does
    }

    // ─── The account's own entries ───────────────────────────────────────

    /// @notice Deposit `amount` of `asset` from your wallet straight into
    ///         your Ready balance. Instant: it is new money. Credited to the
    ///         vault and to the depository ledger like any deposit.
    function depositToReady(address asset, uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ReadyAmountZero();
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibReadyBalance.State memory st = _requireOwnerOpen(msg.sender);
        IReadyDepositRoute(address(this)).vaultDepositERC20(msg.sender, asset, amount);
        LibDepositoryLedger.credit(msg.sender, asset, 0, amount);
        _fold(msg.sender, asset, st.epoch);
        LibVaipakam.ReadyAsset storage x = LibVaipakam.storageSlot().readyAsset[msg.sender][asset];
        x.amount += amount;
        emit ReadyMoved(msg.sender, asset, Direction.WalletToReady, amount, uint64(block.timestamp));
        _touch(msg.sender, asset);
    }

    /// @notice Ask to move `amount` of your Protected balance in `asset`
    ///         into Ready. It counts after your protected delay. Replaces any
    ///         pending top-up of `asset`. Bounded by your free balance less
    ///         what is already Ready.
    function requestReadyTopUp(address asset, uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ReadyAmountZero();
        LibReadyBalance.State memory st = _requireOwnerOpen(msg.sender);
        _fold(msg.sender, asset, st.epoch);
        LibVaipakam.ReadyAsset storage x = LibVaipakam.storageSlot().readyAsset[msg.sender][asset];
        uint256 freeBal = LibReadyBalance.free(msg.sender, asset);
        uint256 room = freeBal > x.amount ? freeBal - x.amount : 0;
        if (amount > room) revert ReadyExceedsFree(amount, room);
        if (x.pending != 0) emit ReadyTopUpCancelled(msg.sender, asset, x.pending, msg.sender);
        uint64 liveAt = uint64(block.timestamp) + st.core.delay;
        x.pending = amount;
        x.pendingAt = liveAt;
        x.pendingEpoch = st.epoch;
        emit ReadyTopUpRequested(msg.sender, asset, amount, liveAt);
    }

    /// @notice Cancel `account`'s pending top-up of `asset`, before it
    ///         counts. The account or any of its active signers.
    function cancelReadyTopUp(address account, address asset) external nonReentrant {
        _requireOwnerOrSigner(account);
        LibVaipakam.ReadyAsset storage x = LibVaipakam.storageSlot().readyAsset[account][asset];
        if (x.pending == 0 || block.timestamp >= x.pendingAt) revert ReadyNoPendingTopUp();
        uint256 amount = x.pending;
        x.pending = 0;
        x.pendingAt = 0;
        emit ReadyTopUpCancelled(account, asset, amount, msg.sender);
    }

    /// @notice Move `amount` of `account`'s Ready in `asset` back to its
    ///         Protected balance at once (`type(uint256).max` for all of it).
    ///         The account or any of its active signers: it only tightens.
    function releaseReady(address account, address asset, uint256 amount) external nonReentrant {
        _requireOwnerOrSigner(account);
        LibReadyBalance.State memory st = LibReadyBalance.state(account);
        _fold(account, asset, st.epoch);
        LibVaipakam.ReadyAsset storage x = LibVaipakam.storageSlot().readyAsset[account][asset];
        if (amount > x.amount) amount = x.amount;
        if (amount == 0) revert ReadyAmountZero();
        x.amount -= amount;
        emit ReadyMoved(account, asset, Direction.ReadyToProtected, amount, uint64(block.timestamp));
    }

    /// @notice Set your idle period: 0 for no expiry, else 1–30 days. Turning
    ///         it on or shortening it applies at once; lengthening it or
    ///         turning it off waits your protected delay.
    function setReadyIdlePeriod(uint32 idle) external nonReentrant whenNotPaused {
        if (idle != 0 && (idle < LibReadyBalance.MIN_IDLE || idle > LibReadyBalance.MAX_IDLE)) {
            revert LibReadyBalance.ReadyIdleOutOfRange(idle);
        }
        LibReadyBalance.State memory st = _requireOwnerOpen(msg.sender);
        LibReadyBalance.settleIdle(msg.sender, st.epoch);
        LibVaipakam.ReadyAccount storage a = LibVaipakam.storageSlot().readyAccount[msg.sender];
        uint32 cur = a.idle;
        if (idle != 0 && (cur == 0 || idle <= cur)) {
            a.idle = idle;
            a.pendingIdleSet = false;
            emit ReadyIdlePeriodSet(msg.sender, idle);
            return;
        }
        uint64 liveAt = uint64(block.timestamp) + st.core.delay;
        a.pendingIdle = idle;
        a.pendingIdleAt = liveAt;
        a.pendingEpoch = st.epoch;
        a.pendingIdleSet = true;
        emit ReadyIdlePeriodChangeRequested(msg.sender, idle, liveAt);
    }

    /// @notice Keep your Ready in `asset` counting until `until`, at most 30
    ///         days from now. Only moves the deadline forward; it does not
    ///         revive Ready that has already expired.
    function extendReadyUntil(address asset, uint64 until) external nonReentrant whenNotPaused {
        if (until <= block.timestamp || until > block.timestamp + LibReadyBalance.MAX_IDLE) {
            revert LibReadyBalance.ReadyUntilOutOfRange(until);
        }
        LibReadyBalance.State memory st = _requireOwnerOpen(msg.sender);
        if (LibReadyBalance.assetStatus(msg.sender, asset, st) != LibReadyBalance.Status.Counts) {
            revert LibReadyBalance.ReadyUntilOutOfRange(until);
        }
        _fold(msg.sender, asset, st.epoch);
        LibVaipakam.ReadyAsset storage x = LibVaipakam.storageSlot().readyAsset[msg.sender][asset];
        if (until > x.extendedUntil) x.extendedUntil = until;
        emit ReadyUntilSet(msg.sender, asset, LibReadyBalance.untilOf(msg.sender, asset));
    }

    // ─── The spend host ──────────────────────────────────────────────────

    /// @notice Spend `amount` of `account`'s existing vault balance of
    ///         `asset` on a protocol step: a no-op for an account not in
    ///         protected mode; otherwise refused (`ReadyBalanceShort`) past
    ///         its effective Ready balance, which it then reduces.
    /// @dev    `address(this)` only: the spend sites reach it through
    ///         `LibReadyBalance.spendViaHost`. Runs inside the caller's guard.
    function spendReady(address account, address asset, uint256 amount) external {
        if (msg.sender != address(this)) revert LibReadyBalance.ReadyHostInternalOnly();
        if (amount == 0) return;
        LibReadyBalance.State memory st = LibReadyBalance.state(account);
        if (!LibProtectedAccount.governs(st.core)) return;
        uint256 ready = LibReadyBalance.effective(account, asset, LibReadyBalance.free(account, asset), st);
        if (ready < amount) revert LibReadyBalance.ReadyBalanceShort(account, asset, ready, amount);
        _fold(account, asset, st.epoch);
        LibVaipakam.storageSlot().readyAsset[account][asset].amount -= amount;
        emit ReadyMoved(account, asset, Direction.Spent, amount, uint64(block.timestamp));
        _touch(account, asset);
    }

    // ─── Views ───────────────────────────────────────────────────────────

    /// @notice What `account` may spend at once from its vault in `asset`
    ///         on a protocol step: all its free balance when not protected,
    ///         else its effective Ready balance.
    function readySpendable(address account, address asset) external view returns (uint256) {
        return LibReadyBalance.spendable(account, asset, LibReadyBalance.free(account, asset));
    }

    /// @notice `account`'s Ready in `asset`, with any pending top-up and the
    ///         reason it counts as zero if it does.
    function getReadyBalance(address account, address asset) external view returns (ReadyView memory v) {
        LibReadyBalance.State memory st = LibReadyBalance.state(account);
        LibVaipakam.ReadyAsset storage x = LibVaipakam.storageSlot().readyAsset[account][asset];
        v.free = LibReadyBalance.free(account, asset);
        v.stored = x.epoch == st.epoch ? x.amount : 0;
        if (x.pending != 0 && x.pendingEpoch == st.epoch) {
            v.pending = x.pending;
            v.pendingAt = x.pendingAt;
        }
        v.status = LibReadyBalance.assetStatus(account, asset, st);
        v.effective = LibReadyBalance.effective(account, asset, v.free, st);
        v.readyUntil = LibReadyBalance.untilOf(account, asset);
    }

    /// @notice `account`'s idle period in force, and any pending change.
    function getReadySettings(address account)
        external
        view
        returns (uint32 idle, uint32 pendingIdle, uint64 pendingIdleAt, bool pendingIdleSet)
    {
        LibReadyBalance.State memory st = LibReadyBalance.state(account);
        LibVaipakam.ReadyAccount storage a = LibVaipakam.storageSlot().readyAccount[account];
        idle = LibReadyBalance.idleNow(a, st.epoch);
        if (a.pendingIdleSet && a.pendingEpoch == st.epoch && block.timestamp < a.pendingIdleAt) {
            pendingIdle = a.pendingIdle;
            pendingIdleAt = a.pendingIdleAt;
            pendingIdleSet = true;
        }
    }

    /// @notice The idle period's bounds, in seconds.
    function getReadyIdleBounds() external pure returns (uint32 minIdle, uint32 maxIdle) {
        return (LibReadyBalance.MIN_IDLE, LibReadyBalance.MAX_IDLE);
    }

    // ─── Internals ───────────────────────────────────────────────────────

    /// @dev Fold a matured top-up (reported as a move) and re-stamp.
    function _fold(address account, address asset, uint64 epoch) private {
        (uint256 folded, uint64 at) = LibReadyBalance.settle(account, asset, epoch);
        if (folded != 0) emit ReadyMoved(account, asset, Direction.ProtectedToReady, folded, at);
    }

    /// @dev A top-up or a spend restarts the idle clock.
    function _touch(address account, address asset) private {
        LibVaipakam.storageSlot().readyAsset[account][asset].touched = uint64(block.timestamp);
        uint64 until = LibReadyBalance.untilOf(account, asset);
        if (until != 0) emit ReadyUntilSet(account, asset, until);
    }

    /// @dev The account itself, protected, its own manager, open (not
    ///      locked, not retired).
    function _requireOwnerOpen(address account) private view returns (LibReadyBalance.State memory st) {
        st = LibReadyBalance.state(account);
        if (st.core.retired) revert LibProtectedAccount.AccountRetired(account);
        if (!st.core.enabled) revert LibProtectedAccount.ProtectedModeOff(account);
        if (st.core.manager != account) revert ReadyNotOwner(account, account);
        if (st.core.locked) revert LibProtectedAccount.ProtectedVaultLocked(account);
    }

    function _requireOwnerOrSigner(address account) private view {
        LibProtectedAccount.Core memory c = LibProtectedAccount.core(account);
        if (!c.enabled) revert LibProtectedAccount.ProtectedModeOff(account);
        if (msg.sender != account && !LibProtectedAccount.isSigner(account, msg.sender)) {
            revert ReadyNotOwnerOrSigner(account, msg.sender);
        }
    }
}
