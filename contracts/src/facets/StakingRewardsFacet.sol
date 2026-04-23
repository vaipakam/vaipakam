// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibStakingRewards} from "../libraries/LibStakingRewards.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title StakingRewardsFacet
 * @author Vaipakam Developer Team
 * @notice Phase-1 VPFI staking rewards (docs/TokenomicsTechSpec.md §7).
 *         Escrow-held VPFI is implicitly staked: any VPFI sitting in a
 *         user's personal escrow earns 5% APR from the 55.2M pool with
 *         no separate stake/unstake tx. The bookkeeping is a
 *         reward-per-token time-weighted accrual in {LibStakingRewards}; this
 *         facet exposes the claim entrypoint and the transparency views.
 *
 * @dev Accrual hooks are wired into every VPFI-escrow balance mutation:
 *        - {VPFIDiscountFacet.depositVPFIToEscrow}
 *        - {VPFIDiscountFacet.withdrawVPFIFromEscrow}
 *        - {LibVPFIDiscount.tryApply} (borrower fee discount deduction)
 *        - {LibVPFIDiscount.tryApplyYieldFee} (lender fee discount)
 *
 *      The pool cap is enforced at claim time by a monotone
 *      `stakingPoolPaidOut` counter; pending amounts beyond the cap are
 *      silently truncated so the library's linear accrual math does not
 *      need to track the cap itself.
 *
 *      Claim pays VPFI out of the diamond's own balance. Ops must fund
 *      the diamond with the 55.2M allocation during canonical deploy
 *      (via TreasuryFacet.mintVPFI), same pattern as the fixed-rate buy
 *      reserve.
 */
contract StakingRewardsFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    using SafeERC20 for IERC20;

    /// @notice Emitted when a staker claims accrued VPFI rewards.
    /// @param user   The claimer and escrow owner.
    /// @param amount VPFI wei transferred from diamond to user's wallet.
    event StakingRewardsClaimed(address indexed user, uint256 amount);

    // ─── User entry point ────────────────────────────────────────────────────

    /**
     * @notice Claim all accrued VPFI staking rewards to the caller's wallet.
     * @dev Refreshes the caller's accrual at current time, debits the
     *      pending bucket (capped at remaining pool), and transfers VPFI
     *      from the diamond. Reverts `NoStakingRewardsToClaim` when the
     *      caller has zero pending; reverts `StakingPoolExhausted` only
     *      when the pool is empty AND the caller still has pending that
     *      cannot be paid.
     *
     *      Pausable + reentrancy-guarded.
     * @return paid VPFI wei transferred to the caller.
     */
    function claimStakingRewards()
        external
        nonReentrant
        whenNotPaused
        returns (uint256 paid)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert VPFITokenNotSet();

        uint256 pendingBefore = LibStakingRewards.pendingOf(msg.sender);
        if (pendingBefore == 0) revert NoStakingRewardsToClaim();

        paid = LibStakingRewards.debitClaim(msg.sender);
        if (paid == 0) revert StakingPoolExhausted();

        IERC20(vpfi).safeTransfer(msg.sender, paid);
        emit StakingRewardsClaimed(msg.sender, paid);
    }

    // ─── Public views ────────────────────────────────────────────────────────

    /// @notice Pending VPFI reward for `user` at the current timestamp.
    /// @dev Accrual is computed on-the-fly — does not mutate storage.
    /// @param user Staker to preview.
    /// @return     Pending VPFI wei claimable right now (before pool-cap truncation).
    function previewStakingRewards(address user)
        external
        view
        returns (uint256)
    {
        return LibStakingRewards.pendingOf(user);
    }

    /// @notice `user`'s current staked (escrow-held) VPFI as tracked by the
    ///         accrual bookkeeping. Mirrors the escrow balance after every
    ///         deposit / discount deduction / withdrawal hook.
    /// @param user Staker to query.
    /// @return     VPFI wei currently held in `user`'s escrow and earning rewards.
    function getUserStakedVPFI(address user) external view returns (uint256) {
        return LibVaipakam.storageSlot().userStakedVPFI[user];
    }

    /// @notice Sum of staked VPFI across all users.
    /// @return Total escrow-held VPFI wei earning staking rewards.
    function getTotalStakedVPFI() external view returns (uint256) {
        return LibVaipakam.storageSlot().totalStakedVPFI;
    }

    /// @notice Remaining VPFI reservable from the 55.2M staking pool.
    /// @return Remaining VPFI wei in the staking pool (`cap - paidOut`).
    function getStakingPoolRemaining() external view returns (uint256) {
        return LibStakingRewards.poolRemaining();
    }

    /// @notice Cumulative VPFI already paid out from the staking pool.
    /// @return Cumulative VPFI wei paid to claimers.
    function getStakingPoolPaidOut() external view returns (uint256) {
        return LibVaipakam.storageSlot().stakingPoolPaidOut;
    }

    /// @notice Annual percentage rate (bps) paid on escrow-held VPFI.
    /// @dev Reflects the admin override in effect — see
    ///      {ConfigFacet.setStakingApr}. Defaults to 500 (5%) when unset.
    /// @return APR in basis points (500 = 5.00%).
    function getStakingAPRBps() external view returns (uint256) {
        return LibVaipakam.cfgVpfiStakingAprBps();
    }

    /// @notice Monotone reward-per-token accumulator, scaled
    ///         by 1e18. Advances every time a user's escrow VPFI balance
    ///         mutates (deposit / discount / withdraw) via the
    ///         {LibStakingRewards.updateUser} checkpoint. Pure transparency —
    ///         exposes the internal counter so integrators and invariant
    ///         suites can verify that it never decreases over the lifetime
    ///         of the protocol.
    /// @return The latest persisted `rewardPerTokenStored` value (1e18-scaled).
    function getStakingRewardPerTokenStored() external view returns (uint256) {
        return LibVaipakam.storageSlot().stakingRewardPerTokenStored;
    }

    /// @notice Staking-pool transparency snapshot.
    /// @return cap         55.2M VPFI hard cap.
    /// @return paidOut     Cumulative VPFI claimed so far.
    /// @return remaining   `cap - paidOut`.
    /// @return totalStaked Current total escrow-held VPFI across all users.
    /// @return aprBps      Annual reward rate in basis points (500 = 5%).
    function getStakingSnapshot()
        external
        view
        returns (
            uint256 cap,
            uint256 paidOut,
            uint256 remaining,
            uint256 totalStaked,
            uint256 aprBps
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        cap = LibVaipakam.VPFI_STAKING_POOL_CAP;
        paidOut = s.stakingPoolPaidOut;
        remaining = cap > paidOut ? cap - paidOut : 0;
        totalStaked = s.totalStakedVPFI;
        aprBps = LibVaipakam.cfgVpfiStakingAprBps();
    }
}
