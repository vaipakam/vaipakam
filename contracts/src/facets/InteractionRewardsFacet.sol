// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title InteractionRewardsFacet
 * @author Vaipakam Developer Team
 * @notice Phase-1 platform-interaction rewards claim surface
 *         (docs/TokenomicsTechSpec.md §4). Emissions are driven by the
 *         8-band schedule in {LibInteractionRewards}; per-day per-user
 *         USD interest counters are credited from RepayFacet's clean
 *         settlement hook.
 *
 * @dev Claim walks `[lastClaimedDay+1 .. min(today-1, lastClaimedDay + MAX)]`
 *      — only FINALIZED days are claimable so the per-day totals are
 *      stable. `MAX = LibVaipakam.MAX_INTERACTION_CLAIM_DAYS` bounds the
 *      gas cost; long-dormant users can reclaim in follow-up txs until
 *      caught up.
 *
 *      Pool-cap enforcement is at claim time: the diamond pays VPFI from
 *      its own balance, up to `VPFI_INTERACTION_POOL_CAP - paidOut`.
 *      Residual pending beyond the cap is truncated.
 *
 *      Emissions don't auto-start — admin sets the launch timestamp
 *      once via {setInteractionLaunchTimestamp}. Before that, record
 *      hooks no-op and claims revert `InteractionEmissionsNotStarted`.
 */
contract InteractionRewardsFacet is
    DiamondAccessControl,
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    using SafeERC20 for IERC20;

    /// @notice Emitted when a user claims interaction rewards.
    /// @param user     Claimer.
    /// @param fromDay  First day included in the legacy-window walk (inclusive).
    /// @param toDay    Last day included in the legacy-window walk (inclusive).
    /// @param amount   Total VPFI wei transferred to the user (entry + window).
    event InteractionRewardsClaimed(
        address indexed user,
        uint256 fromDay,
        uint256 toDay,
        uint256 amount
    );

    /// @notice Emitted when forfeited reward accruals are routed to treasury
    ///         — either as a side effect of a claim or a permissionless sweep.
    /// @param amount VPFI wei routed to the treasury from forfeited entries.
    event InteractionForfeitedToTreasury(uint256 amount);

    /// @notice Emitted when admin seeds the launch timestamp (once).
    /// @param timestamp UNIX epoch seconds at which day 0 begins.
    event InteractionLaunchTimestampSet(uint256 timestamp);

    /// @notice Emitted when admin updates the per-user daily VPFI cap
    ///         (docs/TokenomicsTechSpec.md §4). `value` is "whole VPFI per
    ///         1 ETH of eligible interest". Zero resets to the default
    ///         (500 → 0.5 VPFI / 0.001 ETH); `type(uint256).max` disables
    ///         the cap entirely.
    /// @param value New ratio value (whole VPFI per ETH); zero = default.
    event InteractionCapVpfiPerEthSet(uint256 value);

    // ─── User entry point ────────────────────────────────────────────────────

    /**
     * @notice Claim accrued interaction rewards across finalized days
     *         since the caller's last claim. Windowed by
     *         `MAX_INTERACTION_CLAIM_DAYS`; repeat the call to catch up
     *         beyond one window.
     *
     *      Reverts `InteractionEmissionsNotStarted` before launch,
     *      `VPFITokenNotSet` when VPFI isn't registered,
     *      `NoInteractionRewardsToClaim` when no finalized unclaimed
     *      day exists, and `InteractionPoolExhausted` when the 69M cap
     *      has been fully paid out.
     *
     *      Pausable + reentrancy-guarded. Emits {InteractionRewardsClaimed}.
     * @return paid    VPFI wei transferred to the caller.
     * @return fromDay First day walked (inclusive).
     * @return toDay   Last day walked (inclusive).
     */
    function claimInteractionRewards()
        external
        nonReentrant
        whenNotPaused
        returns (uint256 paid, uint256 fromDay, uint256 toDay)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.interactionLaunchTimestamp == 0) {
            revert InteractionEmissionsNotStarted();
        }
        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert VPFITokenNotSet();

        (uint256 today, bool active) = LibInteractionRewards.currentDayOrZero();
        if (!active || today == 0) revert NoInteractionRewardsToClaim();

        // Fold new entry-path rewards first. Forfeited entries route to
        // treasury via the returned `treasuryDelta`.
        (uint256 entryReward, uint256 treasuryDelta) =
            LibInteractionRewards.claimForUserEntries(msg.sender);

        uint256 last = s.interactionLastClaimedDay[msg.sender];
        uint256 lastFinalized = today - 1;

        uint256 windowReward;
        bool walkedWindow;
        if (last < lastFinalized) {
            fromDay = last + 1;
            uint256 windowLast = fromDay + LibVaipakam.MAX_INTERACTION_CLAIM_DAYS - 1;
            toDay = windowLast < lastFinalized ? windowLast : lastFinalized;

            // Spec §4a: only walk the contiguous finalized prefix. If
            // `fromDay` itself is unfinalized, skip the legacy walk but
            // still honour entry-path rewards accrued so far.
            (uint256 effectiveTo, bool any) = LibInteractionRewards.clampToFinalized(
                fromDay,
                toDay
            );
            if (any) {
                toDay = effectiveTo;
                windowReward = LibInteractionRewards.claimForUserWindow(
                    msg.sender,
                    fromDay,
                    toDay
                );
                s.interactionLastClaimedDay[msg.sender] = toDay;
                walkedWindow = true;
            }
        }

        uint256 pending = entryReward + windowReward;
        if (pending == 0 && treasuryDelta == 0) {
            // No legacy claim possible AND nothing to sweep — surface the
            // same waiting / empty states the prior API used.
            if (!walkedWindow) {
                if (last >= lastFinalized) revert NoInteractionRewardsToClaim();
                revert InteractionDayGlobalNotFinalized(last + 1);
            }
            revert NoInteractionRewardsToClaim();
        }

        uint256 paidOut = s.interactionPoolPaidOut;
        uint256 remaining = LibVaipakam.VPFI_INTERACTION_POOL_CAP > paidOut
            ? LibVaipakam.VPFI_INTERACTION_POOL_CAP - paidOut
            : 0;

        uint256 grossSpend = pending + treasuryDelta;
        if (grossSpend > remaining) {
            // Truncate proportionally when the pool can't cover both
            // payouts — treasury sweep is part of the same pool.
            if (remaining == 0) revert InteractionPoolExhausted();
            if (grossSpend > 0) {
                uint256 scaledPending = (pending * remaining) / grossSpend;
                treasuryDelta = remaining - scaledPending;
                pending = scaledPending;
            }
        }

        paid = pending;
        s.interactionPoolPaidOut = paidOut + paid + treasuryDelta;

        if (paid > 0) {
            IERC20(vpfi).safeTransfer(msg.sender, paid);
        }
        if (treasuryDelta > 0) {
            address treasury = s.treasury;
            if (treasury != address(0)) {
                IERC20(vpfi).safeTransfer(treasury, treasuryDelta);
            }
            emit InteractionForfeitedToTreasury(treasuryDelta);
        }
        emit InteractionRewardsClaimed(msg.sender, fromDay, toDay, paid);
    }

    /**
     * @notice Permissionless sweep of a specific loan's forfeited reward
     *         entries into the treasury. Covers defaulted/liquidated loans
     *         whose borrower never comes back to call
     *         {claimInteractionRewards}.
     * @param loanId Loan id whose forfeited accruals to sweep.
     * @return swept VPFI wei routed to treasury by this call.
     */
    function sweepForfeitedInteractionRewards(uint256 loanId)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 swept)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.interactionLaunchTimestamp == 0) {
            revert InteractionEmissionsNotStarted();
        }
        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert VPFITokenNotSet();

        uint256 treasuryDelta = LibInteractionRewards.sweepForfeitedByLoanId(loanId);
        if (treasuryDelta == 0) return 0;

        uint256 paidOut = s.interactionPoolPaidOut;
        uint256 remaining = LibVaipakam.VPFI_INTERACTION_POOL_CAP > paidOut
            ? LibVaipakam.VPFI_INTERACTION_POOL_CAP - paidOut
            : 0;
        if (remaining == 0) revert InteractionPoolExhausted();

        swept = treasuryDelta > remaining ? remaining : treasuryDelta;
        s.interactionPoolPaidOut = paidOut + swept;

        address treasury = s.treasury;
        if (treasury != address(0)) {
            IERC20(vpfi).safeTransfer(treasury, swept);
        }
        emit InteractionForfeitedToTreasury(swept);
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    /**
     * @notice One-shot admin configuration that opens the emissions
     *         window. Subsequent calls revert once a non-zero timestamp
     *         has been recorded — the schedule is committed at deploy
     *         time and the per-day counters reference this value.
     * @dev ADMIN_ROLE-gated. Setting a value in the past effectively
     *      skips forward into the schedule (useful for testnets); set
     *      `block.timestamp` for a clean launch.
     * @param timestamp UNIX epoch seconds at which day 0 begins.
     */
    function setInteractionLaunchTimestamp(uint256 timestamp)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        require(
            s.interactionLaunchTimestamp == 0,
            "launch already set"
        );
        require(timestamp > 0, "zero timestamp");
        s.interactionLaunchTimestamp = timestamp;
        emit InteractionLaunchTimestampSet(timestamp);
    }

    /**
     * @notice Update the per-user daily VPFI payout cap used by the
     *         interaction reward claim + preview math
     *         (docs/TokenomicsTechSpec.md §4).
     * @dev ADMIN_ROLE-gated. `value` is "whole VPFI per 1 ETH of eligible
     *      interest". The spec default is 500 (0.5 VPFI per 0.001 ETH);
     *      passing `0` resets to that default. Passing
     *      `type(uint256).max` disables the cap entirely (emergency knob
     *      — reverts back to the uncapped proportional share). The new
     *      value applies at the NEXT claim; already-accrued per-day
     *      USD counters are unaffected.
     * @param value Whole VPFI per ETH ratio, or the sentinel values above.
     */
    function setInteractionCapVpfiPerEth(uint256 value)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        // Setter-range audit (2026-05-02): bound the in-range
        // regime to `[INTERACTION_CAP_VPFI_PER_ETH_MIN,
        // INTERACTION_CAP_VPFI_PER_ETH_MAX]`. The two documented
        // sentinels are preserved: `value == 0` resets to the
        // library default at read time, `value == type(uint256).max`
        // is the emergency "disable cap" knob.
        if (
            value != 0 &&
            value != type(uint256).max &&
            (
                value < LibVaipakam.INTERACTION_CAP_VPFI_PER_ETH_MIN ||
                value > LibVaipakam.INTERACTION_CAP_VPFI_PER_ETH_MAX
            )
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "interactionCapVpfiPerEth",
                value,
                LibVaipakam.INTERACTION_CAP_VPFI_PER_ETH_MIN,
                LibVaipakam.INTERACTION_CAP_VPFI_PER_ETH_MAX
            );
        }
        LibVaipakam.storageSlot().interactionCapVpfiPerEth = value;
        emit InteractionCapVpfiPerEthSet(value);
    }

    // ─── Public views ────────────────────────────────────────────────────────

    /// @notice UNIX seconds at which day 0 of the emission schedule
    ///         begins. Zero means admin has not seeded emissions yet.
    /// @return UNIX seconds of the emissions launch; zero if unseeded.
    function getInteractionLaunchTimestamp()
        external
        view
        returns (uint256)
    {
        return LibVaipakam.storageSlot().interactionLaunchTimestamp;
    }

    /// @notice Effective per-user daily VPFI cap (whole VPFI per 1 ETH of
    ///         eligible interest). Reflects the admin override when set,
    ///         otherwise {LibVaipakam.INTERACTION_CAP_DEFAULT_VPFI_PER_ETH}.
    /// @return The ratio currently applied in claim + preview math.
    function getInteractionCapVpfiPerEth() external view returns (uint256) {
        return LibVaipakam.getInteractionCapVpfiPerEth();
    }

    /// @notice Raw (unresolved) admin override for the cap. Zero means
    ///         "use default"; otherwise matches the last value passed to
    ///         {setInteractionCapVpfiPerEth}.
    /// @return The stored override value (0 when unset).
    function getInteractionCapVpfiPerEthRaw() external view returns (uint256) {
        return LibVaipakam.storageSlot().interactionCapVpfiPerEth;
    }

    /// @notice Current day index and active flag.
    /// @return day    Zero-based index of today relative to the launch timestamp.
    /// @return active True iff emissions have been seeded and day is in-schedule.
    function getInteractionCurrentDay()
        external
        view
        returns (uint256 day, bool active)
    {
        return LibInteractionRewards.currentDayOrZero();
    }

    /// @notice Annual emission rate (bps) applied on `day` of the schedule.
    /// @param day Zero-based day index.
    /// @return    Annual rate (basis points) for that day's band.
    function getInteractionAnnualRateBps(uint256 day)
        external
        pure
        returns (uint256)
    {
        return LibInteractionRewards.annualRateBpsForDay(day);
    }

    /// @notice VPFI split on either the lender or borrower side for `day`.
    /// @param day Zero-based day index.
    /// @return    Half-pool VPFI wei reserved per side for that day.
    function getInteractionHalfPoolForDay(uint256 day)
        external
        pure
        returns (uint256)
    {
        return LibInteractionRewards.halfPoolForDay(day);
    }

    /// @notice Last day the caller has fully claimed. Zero means they've
    ///         never claimed.
    /// @param user User to query.
    /// @return    Highest day index already claimed by `user`.
    function getInteractionLastClaimedDay(address user)
        external
        view
        returns (uint256)
    {
        return LibVaipakam.storageSlot().interactionLastClaimedDay[user];
    }

    /// @notice `user`'s raw per-day USD counters and the day totals — for
    ///         transparency + frontend reconciliation.
    /// @param day  Zero-based day index to inspect.
    /// @param user User whose per-day contribution is returned.
    /// @return userLenderUSD18    USD-18 lender interest credited to `user` on `day`.
    /// @return userBorrowerUSD18  USD-18 borrower interest credited to `user` on `day`.
    /// @return totalLenderUSD18   USD-18 lender total for `day` across all users.
    /// @return totalBorrowerUSD18 USD-18 borrower total for `day` across all users.
    function getInteractionDayEntry(uint256 day, address user)
        external
        view
        returns (
            uint256 userLenderUSD18,
            uint256 userBorrowerUSD18,
            uint256 totalLenderUSD18,
            uint256 totalBorrowerUSD18
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.userLenderInterestUSD18[day][user],
            s.userBorrowerInterestUSD18[day][user],
            s.totalLenderInterestUSD18[day],
            s.totalBorrowerInterestUSD18[day]
        );
    }

    /**
     * @notice Preview the caller's claimable reward across the next
     *         claim window WITHOUT mutating state. Walks the same
     *         `[lastClaimedDay+1 .. min(today-1, lastClaimedDay + MAX)]`
     *         range the live claim would use.
     * @param user    User whose next-window claim is previewed.
     * @return amount  VPFI wei the user would receive now
     *                 (before pool-cap truncation at live claim).
     * @return fromDay First day index the preview walks (inclusive).
     * @return toDay   Last day index the preview walks (inclusive).
     */
    function previewInteractionRewards(address user)
        external
        view
        returns (uint256 amount, uint256 fromDay, uint256 toDay)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.interactionLaunchTimestamp == 0) return (0, 0, 0);
        (uint256 today, bool active) = LibInteractionRewards.currentDayOrZero();
        if (!active || today == 0) return (0, 0, 0);

        // Entry-path reward always contributes to the preview regardless
        // of the legacy-window state.
        amount = LibInteractionRewards.previewForUserEntries(user);

        uint256 last = s.interactionLastClaimedDay[user];
        uint256 lastFinalized = today - 1;
        if (last >= lastFinalized) return (amount, 0, 0);

        fromDay = last + 1;
        uint256 windowLast = fromDay + LibVaipakam.MAX_INTERACTION_CLAIM_DAYS - 1;
        toDay = windowLast < lastFinalized ? windowLast : lastFinalized;

        // Mirror the live claim path's §4a gate: only walk the contiguous
        // finalized prefix for the legacy window.
        (uint256 effectiveTo, bool any) = LibInteractionRewards.clampToFinalized(
            fromDay,
            toDay
        );
        if (!any) {
            fromDay = 0;
            toDay = 0;
            return (amount, 0, 0);
        }
        toDay = effectiveTo;
        amount += LibInteractionRewards.previewForUserWindow(user, fromDay, toDay);
    }

    /**
     * @notice Inspect the §4a finalization gate for `user`'s next claim
     *         window. Lets frontends distinguish "nothing to claim yet"
     *         from "claim blocked waiting for the cross-chain global
     *         denominator to be broadcast" without a round-trip through
     *         {RewardReporterFacet.getKnownGlobalInterestUSD18}.
     * @param user    User whose next-window status is inspected.
     * @return fromDay           First day the next claim would walk
     *                           (inclusive); 0 when nothing is claimable.
     * @return windowToDay       Last day the uncropped window would walk
     *                           (inclusive); 0 when nothing is claimable.
     * @return effectiveTo       Last day inside the contiguous finalized
     *                           prefix; equals `fromDay - 1` when
     *                           `fromDay` itself is not yet finalized.
     * @return finalizedPrefix  True iff `fromDay` has its global broadcast
     *                           — i.e. at least one day is claimable now.
     * @return waitingForDay    When `finalizedPrefix == false`, the day
     *                           the claim is waiting on; zero otherwise.
     */
    function getInteractionClaimability(address user)
        external
        view
        returns (
            uint256 fromDay,
            uint256 windowToDay,
            uint256 effectiveTo,
            bool finalizedPrefix,
            uint256 waitingForDay
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.interactionLaunchTimestamp == 0) return (0, 0, 0, false, 0);
        (uint256 today, bool active) = LibInteractionRewards.currentDayOrZero();
        if (!active || today == 0) return (0, 0, 0, false, 0);
        uint256 last = s.interactionLastClaimedDay[user];
        uint256 lastFinalized = today - 1;
        if (last >= lastFinalized) return (0, 0, 0, false, 0);

        fromDay = last + 1;
        uint256 windowLast = fromDay + LibVaipakam.MAX_INTERACTION_CLAIM_DAYS - 1;
        windowToDay = windowLast < lastFinalized ? windowLast : lastFinalized;
        (uint256 eTo, bool any) = LibInteractionRewards.clampToFinalized(
            fromDay,
            windowToDay
        );
        if (!any) {
            return (fromDay, windowToDay, 0, false, fromDay);
        }
        return (fromDay, windowToDay, eTo, true, 0);
    }

    /// @notice Remaining VPFI reservable from the 69M interaction pool.
    /// @return Remaining VPFI wei (`cap - paidOut`) the pool can still pay out.
    function getInteractionPoolRemaining() external view returns (uint256) {
        return LibInteractionRewards.poolRemaining();
    }

    /// @notice Cumulative VPFI already paid out from the interaction pool.
    /// @return Cumulative VPFI wei paid to claimers so far.
    function getInteractionPoolPaidOut() external view returns (uint256) {
        return LibVaipakam.storageSlot().interactionPoolPaidOut;
    }

    /// @notice Interaction pool transparency snapshot.
    /// @return cap        69M VPFI hard cap.
    /// @return paidOut    Cumulative VPFI claimed so far.
    /// @return remaining  `cap - paidOut`.
    /// @return launch     Launch timestamp (0 if not started).
    /// @return today      Current day index (0 if not started).
    /// @return aprBps     Annual rate for today (from schedule).
    function getInteractionSnapshot()
        external
        view
        returns (
            uint256 cap,
            uint256 paidOut,
            uint256 remaining,
            uint256 launch,
            uint256 today,
            uint256 aprBps
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        cap = LibVaipakam.VPFI_INTERACTION_POOL_CAP;
        paidOut = s.interactionPoolPaidOut;
        remaining = cap > paidOut ? cap - paidOut : 0;
        launch = s.interactionLaunchTimestamp;
        (uint256 d, bool active) = LibInteractionRewards.currentDayOrZero();
        if (active) {
            today = d;
            aprBps = LibInteractionRewards.annualRateBpsForDay(d);
        }
    }

    /// @notice Enumerate every reward entry registered for `user` —
    ///         lender-side and borrower-side rows for each loan they
    ///         participated in. Frontends use this to render a
    ///         "contributing loans" breakdown alongside the
    ///         {previewInteractionRewards} headline so users can see
    ///         which loans drove their daily share of the pool.
    /// @dev    Storage is sequential (`userRewardEntryIds[user]` →
    ///         `rewardEntries[id]`); this view materialises both in one
    ///         call. A loan that involved the user on both sides has
    ///         two entries — one per side. Closed entries (`endDay > 0`)
    ///         are still surfaced so the breakdown reads as a lifetime
    ///         participation list, not just an open-now snapshot. The
    ///         array length is bounded by the user's loan-participation
    ///         count, so unbounded growth isn't a concern in practice.
    /// @param  user Address whose entries to enumerate.
    /// @return entries Full {RewardEntry} struct array in registration order.
    function getUserRewardEntries(address user)
        external
        view
        returns (LibVaipakam.RewardEntry[] memory entries)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage ids = s.userRewardEntryIds[user];
        entries = new LibVaipakam.RewardEntry[](ids.length);
        for (uint256 i = 0; i < ids.length; ++i) {
            entries[i] = s.rewardEntries[ids[i]];
        }
    }
}
