// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title LibStakingRewards
 * @author Vaipakam Developer Team
 * @notice Reward-per-token time-weighted accrual bookkeeping for the
 *         Phase-1 VPFI staking rewards pool (docs/TokenomicsTechSpec.md
 *         §7). Escrow-held VPFI is implicitly "staked" — there is no
 *         separate stake/unstake entrypoint. Whenever a user's escrow
 *         VPFI balance changes (deposit, fee-discount deduction,
 *         withdrawal) the caller MUST invoke {updateUser} BEFORE the
 *         balance mutation so the checkpoint captures the OLD balance
 *         for the period it was active.
 *
 * @dev Accrual formula for an "APR-on-balance" model collapses to a
 *      standard reward-per-token form because each unit of staked VPFI
 *      earns at the same rate regardless of totalStaked:
 *
 *        rewardPerToken  = rewardPerTokenStored
 *                        + (APR_BPS * 1e18 * dt)
 *                          / (BASIS_POINTS * SECONDS_PER_YEAR)
 *
 *        userPending    += userStakedOld
 *                        * (rewardPerToken - userRewardPerTokenPaid)
 *                        / 1e18
 *
 *      When totalStakedVPFI == 0 we intentionally freeze the
 *      rewardPerToken counter so that periods with no stakers do not
 *      credit whoever stakes first with retroactive yield.
 *
 *      The pool cap (`VPFI_STAKING_POOL_CAP`) is enforced at claim time
 *      via a monotone `stakingPoolPaidOut` counter. Unrealized pending
 *      beyond the cap is truncated silently at claim — the library does
 *      NOT cap accrual itself so the math stays linear.
 */
library LibStakingRewards {
    /// @dev Returns the rewardPerToken counter advanced to `block.timestamp`
    ///      without writing state. Used by the pending-reward view path.
    /// @return The live rewardPerToken value (scaled by 1e18), not persisted.
    function currentRewardPerToken() internal view returns (uint256) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.totalStakedVPFI == 0) return s.stakingRewardPerTokenStored;
        uint256 dt = block.timestamp - s.stakingLastUpdateTime;
        if (dt == 0) return s.stakingRewardPerTokenStored;
        uint256 increment = (LibVaipakam.cfgVpfiStakingAprBps() *
            1e18 *
            dt) /
            (LibVaipakam.BASIS_POINTS * LibVaipakam.SECONDS_PER_YEAR);
        return s.stakingRewardPerTokenStored + increment;
    }

    /// @dev Advances `rewardPerTokenStored` and `lastUpdateTime` to now.
    function _checkpointGlobal() private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.stakingRewardPerTokenStored = currentRewardPerToken();
        s.stakingLastUpdateTime = block.timestamp;
    }

    /**
     * @notice Reconcile `user`'s accrual against the new balance. Call
     *         BEFORE mutating the underlying escrow VPFI balance.
     * @param user             The user whose stake is changing.
     * @param newStakedBalance The user's NEW escrow VPFI balance after
     *                         the pending mutation.
     */
    function updateUser(address user, uint256 newStakedBalance) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        _checkpointGlobal();
        uint256 oldStaked = s.userStakedVPFI[user];
        uint256 rpt = s.stakingRewardPerTokenStored;
        // Fold any newly-accrued pending for the user at the OLD balance.
        uint256 paid = s.userStakingRewardPerTokenPaid[user];
        if (rpt > paid && oldStaked > 0) {
            s.userStakingPendingReward[user] +=
                (oldStaked * (rpt - paid)) /
                1e18;
        }
        s.userStakingRewardPerTokenPaid[user] = rpt;
        // Apply the new balance to the global total.
        if (newStakedBalance > oldStaked) {
            s.totalStakedVPFI += (newStakedBalance - oldStaked);
        } else if (newStakedBalance < oldStaked) {
            s.totalStakedVPFI -= (oldStaked - newStakedBalance);
        }
        s.userStakedVPFI[user] = newStakedBalance;
    }

    /// @notice Pending VPFI for `user` accrued up to `block.timestamp`.
    /// @dev Pure-view computation; does not fold accrual into storage.
    /// @param user Staker to inspect.
    /// @return     VPFI wei owed to `user` at the current block timestamp
    ///             (before the pool-cap truncation that `debitClaim`
    ///             applies on actual payout).
    function pendingOf(address user) internal view returns (uint256) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 rpt = currentRewardPerToken();
        uint256 staked = s.userStakedVPFI[user];
        uint256 paid = s.userStakingRewardPerTokenPaid[user];
        uint256 accrued;
        if (rpt > paid && staked > 0) {
            accrued = (staked * (rpt - paid)) / 1e18;
        }
        return s.userStakingPendingReward[user] + accrued;
    }

    /**
     * @notice Finalize `user`'s accrual, debit their pending bucket by
     *         the payable amount (capped at pool remaining), and return
     *         the VPFI amount the caller must transfer. The caller is
     *         responsible for the actual `SafeERC20.safeTransfer`.
     * @param user     Claimer whose pending bucket is being debited.
     * @return payable_ VPFI wei to transfer to `user`. Zero if the pool
     *                  is exhausted or the user has no pending.
     */
    function debitClaim(address user) internal returns (uint256 payable_) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Refresh pending at current time using the user's current stake.
        updateUser(user, s.userStakedVPFI[user]);
        uint256 pending = s.userStakingPendingReward[user];
        if (pending == 0) return 0;
        uint256 paidOut = s.stakingPoolPaidOut;
        uint256 remaining = LibVaipakam.VPFI_STAKING_POOL_CAP > paidOut
            ? LibVaipakam.VPFI_STAKING_POOL_CAP - paidOut
            : 0;
        if (remaining == 0) return 0;
        payable_ = pending > remaining ? remaining : pending;
        s.userStakingPendingReward[user] = pending - payable_;
        s.stakingPoolPaidOut = paidOut + payable_;
    }

    /// @notice Remaining VPFI reservable from the staking pool.
    /// @return Remaining VPFI wei the pool can still pay out (`cap - paidOut`).
    function poolRemaining() internal view returns (uint256) {
        uint256 paidOut = LibVaipakam.storageSlot().stakingPoolPaidOut;
        return
            LibVaipakam.VPFI_STAKING_POOL_CAP > paidOut
                ? LibVaipakam.VPFI_STAKING_POOL_CAP - paidOut
                : 0;
    }
}
