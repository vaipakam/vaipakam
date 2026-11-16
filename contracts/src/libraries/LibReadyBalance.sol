// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibProtectedAccount, IVaultProtectionRead} from "./LibProtectedAccount.sol";
import {LibEncumbrance} from "./LibEncumbrance.sol";

/**
 * @title LibReadyBalance
 * @notice #3344 — a protected account's Ready balance: the part of its free
 *         ERC-20 vault balance its own actions may spend on a protocol step
 *         at once. The rest of its vault is the Protected balance, which
 *         reaches a protocol step only after a top-up into Ready, and a top-up
 *         waits the account's delay. See
 *         `docs/DesignsAndPlans/ReadyBalanceDesign.md`.
 * @dev    Ready is a TAG on free balance, never a lien: what counts is
 *         `min(stored + matured pending, free)`, and it counts as zero when
 *         the account is not protected, is locked or retired, the vault's
 *         protection epoch has moved since it was set, or the idle expiry has
 *         passed. Every rule is read lazily; nothing depends on a call being
 *         made at a deadline. The write side runs in `ReadyBalanceFacet`; the
 *         spend sites reach it through {spend}, a self-call, so no facet near
 *         EIP-170 carries a copy.
 */
library LibReadyBalance {
    /// @notice The largest idle period, and the furthest ahead "ready
    ///         until" may be extended.
    uint32 internal constant MAX_IDLE = 30 days;
    /// @notice The shortest idle period when one is set.
    uint32 internal constant MIN_IDLE = 1 days;

    /// @notice Why Ready counts as zero ({status}); `Counts` when it counts.
    enum Status {
        Counts,
        NotProtected,
        Locked,
        Retired,
        Voided,
        Expired
    }

    /// @notice A spend of existing vault balance by a protected account
    ///         asked for more than its Ready balance holds.
    error ReadyBalanceShort(address account, address asset, uint256 ready, uint256 needed);
    /// @notice The idle period is outside 1–30 days (and not zero).
    error ReadyIdleOutOfRange(uint256 idle);
    /// @notice "Ready until" may be extended to at most 30 days from now,
    ///         and only forward.
    error ReadyUntilOutOfRange(uint256 until);
    /// @notice Only `address(this)` may call the spend host.
    error ReadyHostInternalOnly();

    function _s() private view returns (LibVaipakam.Storage storage) {
        return LibVaipakam.storageSlot();
    }

    // ─── Reads ───────────────────────────────────────────────────────────

    /// @notice The protection state Ready depends on, read once.
    struct State {
        LibProtectedAccount.Core core;
        uint64 epoch;
    }

    function state(address account) internal view returns (State memory st) {
        st.core = LibProtectedAccount.core(account);
        if (st.core.vault != address(0)) st.epoch = IVaultProtectionRead(st.core.vault).protectionEpoch();
    }

    /// @notice Whether the account's Ready in `asset` can count at all, and
    ///         why not.
    function assetStatus(address account, address asset, State memory st) internal view returns (Status) {
        if (st.core.retired) return Status.Retired;
        if (!st.core.enabled) return Status.NotProtected;
        if (st.core.locked) return Status.Locked;
        if (storedNow(account, asset, st.epoch) != 0) return Status.Counts;
        LibVaipakam.ReadyAsset storage x = _s().readyAsset[account][asset];
        if (_rawStored(x, st.epoch) != 0) return Status.Expired;
        bool pendingLive = x.pending != 0 && x.pendingEpoch == st.epoch;
        bool stale = (x.amount != 0 && x.epoch != st.epoch) || (x.pending != 0 && x.pendingEpoch != st.epoch);
        if (stale && !pendingLive) return Status.Voided;
        return Status.Counts;
    }

    /// @notice The idle period in force: a matured lengthening or switch-off
    ///         asked in the current epoch replaces the stored one.
    function idleNow(LibVaipakam.ReadyAccount storage a, uint64 epoch) internal view returns (uint32) {
        if (a.pendingIdleSet && a.pendingEpoch == epoch && block.timestamp >= a.pendingIdleAt) return a.pendingIdle;
        return a.idle;
    }

    function _idle(address account, uint64 epoch) private view returns (uint32) {
        return idleNow(_s().readyAccount[account], epoch);
    }

    /// @dev Stored plus matured pending in the current epoch, before expiry.
    function _rawStored(LibVaipakam.ReadyAsset storage x, uint64 epoch) private view returns (uint256 r) {
        if (x.epoch == epoch) r = x.amount;
        if (x.pending != 0 && x.pendingEpoch == epoch && block.timestamp >= x.pendingAt) r += x.pending;
    }

    /// @dev Until when the stored amount counts (0 = no expiry).
    function _amountUntil(LibVaipakam.ReadyAsset storage x, uint32 idle) private view returns (uint64) {
        if (idle == 0) return 0;
        uint64 u = x.touched + idle;
        return x.extendedUntil > u ? x.extendedUntil : u;
    }

    /// @notice Stored Ready plus a matured pending top-up, both from the
    ///         current epoch and neither past its idle expiry; zero
    ///         otherwise. Not capped by free balance.
    function storedNow(address account, address asset, uint64 epoch) internal view returns (uint256 r) {
        LibVaipakam.ReadyAsset storage x = _s().readyAsset[account][asset];
        uint32 idle = _idle(account, epoch);
        if (x.epoch == epoch && (idle == 0 || block.timestamp <= _amountUntil(x, idle))) r = x.amount;
        if (
            x.pending != 0 && x.pendingEpoch == epoch && block.timestamp >= x.pendingAt
                && (idle == 0 || block.timestamp <= uint256(x.pendingAt) + idle)
        ) r += x.pending;
    }

    /// @notice When `account`'s Ready in `asset` stops counting (0 = no
    ///         expiry, or nothing stored).
    function untilOf(address account, address asset) internal view returns (uint64 u) {
        State memory st = state(account);
        LibVaipakam.ReadyAsset storage x = _s().readyAsset[account][asset];
        uint32 idle = _idle(account, st.epoch);
        if (idle == 0) return 0;
        if (x.epoch == st.epoch && x.amount != 0) u = _amountUntil(x, idle);
        if (x.pending != 0 && x.pendingEpoch == st.epoch && block.timestamp >= x.pendingAt) {
            uint64 p = x.pendingAt + idle;
            if (p > u) u = p;
        }
    }

    /// @notice The account's free ERC-20 balance of `asset` in its vault.
    function free(address account, address asset) internal view returns (uint256) {
        return LibEncumbrance.vaultFree(account, true, asset, 0);
    }

    /// @notice What of `asset` the account may spend at once from its vault
    ///         on a protocol step: all free balance when the account is not
    ///         protected, else its effective Ready balance.
    function spendable(address account, address asset, uint256 freeBal) internal view returns (uint256) {
        State memory st = state(account);
        if (!LibProtectedAccount.governs(st.core)) return freeBal;
        return effective(account, asset, freeBal, st);
    }

    /// @notice The Ready balance that counts now, capped by `freeBal`.
    function effective(address account, address asset, uint256 freeBal, State memory st)
        internal
        view
        returns (uint256)
    {
        if (st.core.retired || !st.core.enabled || st.core.locked) return 0;
        uint256 r = storedNow(account, asset, st.epoch);
        return r < freeBal ? r : freeBal;
    }

    // ─── Writes (run in ReadyBalanceFacet) ───────────────────────────────

    /// @notice Bring the stored record up to date: a stale epoch or an
    ///         expired amount is zeroed, a matured idle change applied, and a
    ///         matured pending top-up folded in (dropped if already expired).
    ///         Returns what was folded and the time it began to count.
    function settle(address account, address asset, uint64 epoch) internal returns (uint256 folded, uint64 at) {
        settleIdle(account, epoch);
        LibVaipakam.ReadyAsset storage x = _s().readyAsset[account][asset];
        uint32 idle = _s().readyAccount[account].idle;
        if (x.epoch != epoch) {
            x.amount = 0;
            x.extendedUntil = 0;
            x.epoch = epoch;
        } else if (x.amount != 0 && idle != 0 && block.timestamp > _amountUntil(x, idle)) {
            x.amount = 0;
        }
        if (x.pending == 0) return (0, 0);
        if (x.pendingEpoch != epoch) {
            x.pending = 0;
            x.pendingAt = 0;
            return (0, 0);
        }
        if (block.timestamp < x.pendingAt) return (0, 0);
        at = x.pendingAt;
        uint256 p = x.pending;
        x.pending = 0;
        x.pendingAt = 0;
        if (idle != 0 && block.timestamp > uint256(at) + idle) return (0, 0);
        folded = p;
        x.amount += p;
        if (at > x.touched) x.touched = at;
    }

    function settleIdle(address account, uint64 epoch) internal {
        LibVaipakam.ReadyAccount storage a = _s().readyAccount[account];
        if (!a.pendingIdleSet) return;
        if (a.pendingEpoch != epoch) {
            a.pendingIdleSet = false;
        } else if (block.timestamp >= a.pendingIdleAt) {
            a.idle = a.pendingIdle;
            a.pendingIdleSet = false;
        }
    }

    // ─── The spend sites' entry ──────────────────────────────────────────

    /// @notice Spend `amount` of `account`'s existing vault balance of
    ///         `asset` on a protocol step: a self-call to
    ///         `ReadyBalanceFacet.spendReady`, which is a no-op for an account
    ///         not in protected mode and otherwise draws its Ready balance.
    ///         Bubbles the host's revert.
    function spendViaHost(address account, address asset, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory ret) =
            address(this).call(abi.encodeWithSignature("spendReady(address,address,uint256)", account, asset, amount));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    /// @notice What `account` may spend at once in `asset` (a self-call to
    ///         `ReadyBalanceFacet.readySpendable`).
    function spendableViaHost(address account, address asset) internal view returns (uint256) {
        (bool ok, bytes memory ret) =
            address(this).staticcall(abi.encodeWithSignature("readySpendable(address,address)", account, asset));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return abi.decode(ret, (uint256));
    }
}
