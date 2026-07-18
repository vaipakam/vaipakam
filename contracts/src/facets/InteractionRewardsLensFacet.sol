// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";

/**
 * @title InteractionRewardsLensFacet
 * @author Vaipakam Developer Team
 * @notice Read-only lens for {InteractionRewardsFacet}
 *         (docs/TokenomicsTechSpec.md §4). Hosts every external
 *         view/pure getter of the platform-interaction reward surface —
 *         launch timestamp, per-day counters, pool-cap snapshot, claim
 *         previews, claimability inspection, and the per-user reward
 *         entry enumeration.
 *
 * @dev These getters were EXTRACTED verbatim from
 *      {InteractionRewardsFacet} to reclaim EIP-170 runtime-bytecode
 *      headroom on that facet: its mutating claim/sweep/admin surface plus
 *      the diamond-internal reward-lifecycle hooks had grown the facet
 *      toward the 24,576-byte limit. Both facets share the same
 *      `LibVaipakam` storage, so routing these selectors to a sibling
 *      lens facet is behaviour-neutral — the Diamond dispatches by
 *      selector regardless of which facet owns the code.
 *
 *      Every function here reads only library functions + shared storage;
 *      there are no cross-facet calls, no access control, no reentrancy /
 *      pausable guards, and no token movement.
 */
contract InteractionRewardsLensFacet {
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
    /// @return userLenderNumeraire18    USD-18 lender interest credited to `user` on `day`.
    /// @return userBorrowerNumeraire18  USD-18 borrower interest credited to `user` on `day`.
    /// @return totalLenderNumeraire18   USD-18 lender total for `day` across all users.
    /// @return totalBorrowerNumeraire18 USD-18 borrower total for `day` across all users.
    function getInteractionDayEntry(uint256 day, address user)
        external
        view
        returns (
            uint256 userLenderNumeraire18,
            uint256 userBorrowerNumeraire18,
            uint256 totalLenderNumeraire18,
            uint256 totalBorrowerNumeraire18
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.userLenderInterestNumeraire18[day][user],
            s.userBorrowerInterestNumeraire18[day][user],
            s.totalLenderInterestNumeraire18[day],
            s.totalBorrowerInterestNumeraire18[day]
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
     *         {RewardReporterFacet.getKnownGlobalInterestNumeraire18}.
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
    /// @return remaining  Reservable pool: `cap − paidOut −
    ///                    rewardBudgetRemittedGlobal` (#776 — matches
    ///                    {getInteractionPoolRemaining} and the live claim cap,
    ///                    so the three never disagree).
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
        remaining = LibInteractionRewards.poolRemaining();
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

    /// @notice RL-3 (#1305) — the storage ids backing {getUserRewardEntries},
    ///         same length and registration order, so keepers and the Claim
    ///         Center can address {getRewardEntryExpiry} /
    ///         {InteractionRewardsFacet.sweepExpiredInteractionRewards} (both
    ///         id-keyed) without reconstructing internal storage off-chain.
    /// @param  user Address whose entry ids to enumerate.
    /// @return ids Entry ids in registration order.
    function getUserRewardEntryIds(address user)
        external
        view
        returns (uint256[] memory ids)
    {
        return LibVaipakam.storageSlot().userRewardEntryIds[user];
    }

    /// @notice RL-3 — claim-center countdown view: the horizon state of a
    ///         reward entry.
    /// @param  entryId Entry to inspect.
    /// @return firstClaimableAt Accumulator start (0 = not started / dark).
    /// @return expiresAt        Earliest terminal-removal instant ASSUMING
    ///         the entry stays continuously claim-executable and observed
    ///         from now (0 = dark or unstarted). A forward estimate, not a
    ///         fixed deadline: a funding outage or sanction pauses accrual.
    function getRewardEntryExpiry(uint256 entryId)
        external
        view
        returns (uint64 firstClaimableAt, uint64 expiresAt)
    {
        return LibInteractionRewards.rewardEntryExpiry(entryId);
    }
}
