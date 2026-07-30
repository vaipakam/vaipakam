// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibVpfiRecycle} from "../libraries/LibVpfiRecycle.sol";

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

    /// @notice #1222 M3 B2-d1 — a page of the GLOBAL reward-entry sequence:
    ///         entries `fromId .. fromId+count-1` (ids are allocated
    ///         sequentially from 1 by `_allocEntry`). Ids past
    ///         `nextRewardEntryId` return zeroed structs (`user == 0`).
    /// @dev    The commitment-report keeper's enumeration primitive: it walks
    ///         this sequence from the on-chain entry cursor, filters
    ///         day-covering entries locally, and feeds
    ///         {RewardCommitmentFacet.submitCommitmentBatch}. Entry ids are
    ///         creation-ordered, so `startDay` is non-decreasing along the
    ///         walk and a scan for day `D` can stop at the first entry with
    ///         `startDay > D`. `count` is clamped to 500 per call (RPC-node
    ///         friendliness — callers page).
    /// @param  fromId First entry id to return (1-based).
    /// @param  count  Page size (clamped to 500).
    /// @return entries Full {RewardEntry} structs, `entries[i]` = id
    ///         `fromId + i`.
    function getRewardEntriesRange(uint256 fromId, uint256 count)
        external
        view
        returns (LibVaipakam.RewardEntry[] memory entries)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (count > 500) count = 500;
        entries = new LibVaipakam.RewardEntry[](count);
        for (uint256 i = 0; i < count; ++i) {
            entries[i] = s.rewardEntries[fromId + i];
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

    // ─── #1218 M5 — recycling transparency series ────────────────────────────

    /// @notice {getRecycleDayMetrics} answers for the GLOBAL day pool, which
    ///         only the canonical reward chain computes. Declared on this
    ///         facet rather than in the shared errors interface so the ABI
    ///         churn stays confined to the one facet that can raise it.
    error RecycleDayMetricsCanonicalChainOnly();
    //
    // The seven figures the governor design §9 ratified for the public
    // dashboard are all derivable from state the protocol ALREADY persists —
    // this slice adds no storage and no new event. Five were reachable
    // before it (`scheduleFloor`/`recycledBudget` via `getDayPoolStamp`,
    // `selfFundingRatio` and `runwayExtensionDays` derived from that series,
    // `platformRetained` from `getRecycleBucket` + `getGovernorCommitState`).
    // The two below close what was missing.

    /**
     * @notice #1218 M5 — day `dayId`'s pool composition and what was actually
     *         drawn against it, for the transparency dashboard's per-day
     *         series (governor design §9).
     * @dev    Adds the two figures the pre-existing reads could not supply.
     *
     *         **`absorbedMirror`** had no AGGREGATE getter, and its absence was
     *         the failure that would have shipped a WRONG number rather than
     *         a missing one. Global absorption is the SUM of the local and
     *         mirror terms — {RewardAggregatorFacet._stampGovernorDayPool}
     *         sums both when it sizes `Ā`. A dashboard built on the one
     *         exposed getter (`getRecycledCreditedByDay`) would have
     *         published Base-only absorption while labelling it global, and
     *         it would have looked entirely plausible. Both terms are
     *         returned separately rather than pre-summed: the split is
     *         itself informative, and a caller that wants the total performs
     *         an addition it cannot get wrong.
     *
     *         **`freshDrawdown`** is `netEmission[D]` under the governor.
     *         It is NOT reconstructible from the claim side — the fresh
     *         counter (`interactionPoolPaidOut`) has no day dimension, the
     *         claim event spans a day RANGE with one fresh-plus-recycled
     *         total, and a whole-claim cap truncation rescales the fresh
     *         shares after the per-day walk. It IS reconstructible from the
     *         finalize side, which is what this does: {committableForDay} is
     *         a pure view over per-day aggregates finalization already
     *         persists, so day D's fresh commitment is recomputable by
     *         anyone, at any later time, from the same inputs — and this
     *         call is the exact one finalization makes to size its own
     *         reservation.
     *
     *         Read against `scheduleFloor` it is "budgeted ceiling versus
     *         what real activity actually earned a claim on"; the remainder
     *         is never minted. That pairing is only meaningful with both
     *         terms on the SAME day index, which is also why attributing
     *         drawdown to the CLAIM day would be wrong even though it would
     *         be cheaper — a claim spanning days D-30…D would be scored
     *         against day D's floor alone.
     *
     *         FIVE bounds, stated here so a consumer cannot mistake the
     *         figure for something stronger than it is. (This header read
     *         "Three" for one revision after the fourth landed, and "FOUR"
     *         after the fifth — the
     *         same prose-count-versus-list drift this very PR corrects in
     *         `DeployDiamond.s.sol`. Nothing mechanical checks either one;
     *         if a fifth is added, this word is part of the edit.)
     *
     *         1. EXACT for the armed-day global reservation — same call,
     *            same inputs.
     *         2. An APPROXIMATION before arming: unarmed claim pricing reads
     *            {halfPoolForDay} directly (the UNCAPPED half), while the
     *            stamp records `min(schedule, freshAvailable)`. The two
     *            coincide except near pool exhaustion.
     *         3. Above actual near the 69M cap, where claim-level truncation
     *            pays out less than was committed.
     *         4. BELOW actual on a day whose chain contribution was zeroed.
     *            {RewardRemittanceFacet.remitManualBudget} can later send an
     *            operator-sized, fresh-only amount for that same day; it
     *            advances `rewardBudgetRemittedGlobal` but retires no
     *            finalize-time commitment, because none existed (that
     *            function's own natspec records it). The drawdown is real and
     *            this recomputation cannot see it.
     *
     *         5. BELOW the POOL's view of the day on a released-then-re-sent
     *            remittance. `releaseRemitReservation` restores the day's
     *            fresh commitment but deliberately leaves
     *            `rewardBudgetRemittedGlobal` charged, and the re-send
     *            charges it again — two real fresh outflows against the 69M
     *            cap for one finalize-time commitment. This recomputation
     *            reports the commitment, so the published series and the
     *            allocation counter legitimately disagree by the re-sent
     *            amount (Codex #1487 r2 P2).
     *
     *            Both readings are defensible and they answer different
     *            questions: the first outflow is stranded in transport and
     *            reaches no user, so the day's EMISSION is the commitment,
     *            while the day's POOL CONSUMPTION is the larger figure.
     *            Anyone reconciling this series against
     *            `rewardBudgetRemittedGlobal` must expect the gap rather
     *            than treat it as corruption.
     *
     *         So it is NOT a pure upper bound — 3 pushes one way and 4/5 the
     *         other. An earlier revision of this comment claimed an upper
     *         bound outright (Codex #1487 r1 P2), which held only until the
     *         zeroed-chain manual path is used.
     *
     *         Which regime a given day is in is NOT readable from this call —
     *         compare `dayId` against `armedFromDay` from
     *         {RewardAggregatorFacet.getGovernorCommitState}, one global read
     *         a dashboard makes once for the whole series.
     *
     *         The recomputation is stable over time only because every input
     *         is day-scoped and written ONCE at finalization: the day's cap
     *         threshold (set by {snapshotDayCapThreshold}, or broadcast to
     *         mirrors from Base's snapshot), the finalized global denominators,
     *         and the stamp's `scheduleFloor`. That is a real dependency, not
     *         an incidental one — making any of them mutable after finalize
     *         would let this published figure drift away from the reservation
     *         it claims to report, silently and retroactively.
     *
     *         Forfeits are deliberately not netted out. A forfeited entry's
     *         fresh share WAS emitted and then absorbed, so it belongs in
     *         `freshDrawdown` and reappears in the absorbed terms — the two
     *         are complementary, and subtracting here would double-count in
     *         the opposite direction.
     * @param  dayId Interaction-reward schedule day index.
     * @return stamped        True once the day finalized. While false the
     *         three POOL figures are zero and must not be read as real
     *         zeros — an unfinalized day has no pool, not an empty one.
     *
     *         The two ABSORBED figures are still returned while `stamped` is
     *         false, but they are NOT equally live and an earlier revision of
     *         this comment wrongly said they were. `absorbedLocal` genuinely
     *         is: a credit lands on the day it happens, so gating it on the
     *         stamp would hide real absorption on the day in progress.
     *         `absorbedMirror` LAGS — it advances only when a mirror's report
     *         for that day is accepted, and a mirror cannot close day D until
     *         its own clock has passed D. So mid-day-D the mirror term is
     *         STRUCTURALLY zero however much those chains absorbed. Summing
     *         the pair on an unfinalized day therefore understates global
     *         absorption, by an amount that is not bounded by anything
     *         readable here. Read the sum as global only for a FINALIZED day;
     *         before that, read `absorbedLocal` as this chain's own figure and
     *         do not present the total as global.
     * @return scheduleFloor  Fresh (pre-fund) half of the day's pool.
     * @return recycledBudget Absorption-coupled recycled half. With
     *         `scheduleFloor` this gives `dailyPool` and hence
     *         `selfFundingRatio[D]`.
     * @return freshDrawdown  `netEmission[D]` — the schedule floor actually
     *         drawn fresh, subject to the five bounds above.
     * @return absorbedLocal  This chain's own day-`dayId` recycle credits.
     *
     *         **Day 0 is a catch-all, not a normal day.**
     *         {LibVpfiRecycle.credit} maps every credit taken while the
     *         emission schedule is inactive to day 0, and genuine day-0
     *         credits land in the same slot — so `getRecycleDayMetrics(0)`
     *         reports pre-launch absorption and the first schedule day added
     *         together, with no way to separate them, and mirror reports
     *         propagate the same conflation (Codex #1487 r3 P2). Separating
     *         them would need a new storage slot, which this slice
     *         deliberately does not add; a consumer plotting a day series
     *         should either exclude day 0 or label it as the pre-launch
     *         bucket rather than as the programme's first day.
     * @return absorbedMirror Day-`dayId` credits accepted from mirror
     *         chains' reports. `absorbedLocal + absorbedMirror` is the
     *         global `absorbed[D]`.
     *
     *         A LOWER bound once the day is finalized, and it is stated here
     *         because the sibling `freshDrawdown` carries five stated bounds
     *         and this one carried none. The ingress rejects reports for a
     *         finalized day, so a mirror whose report arrives late
     *         contributes nothing to this figure — ever. The absorption was
     *         real and is counted in that chain's own cumulative; only its
     *         attribution to THIS day is lost. Treat a rising series as
     *         evidence of absorption and never a flat one as evidence of its
     *         absence.
     */
    function getRecycleDayMetrics(uint256 dayId)
        external
        view
        returns (
            bool stamped,
            uint256 scheduleFloor,
            uint256 recycledBudget,
            uint256 freshDrawdown,
            uint256 absorbedLocal,
            uint256 absorbedMirror
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // #1218 M5 (Codex #1487 r1 P2) — these are GLOBAL figures and only
        // the canonical chain computes them. A mirror is not merely missing
        // data, it answers WRONGLY in two different ways: under the V2
        // broadcast it never receives `dayPoolStamp` at all, so a globally
        // finalized day reads `stamped == false`; under the legacy broadcast
        // it DOES get a stamp, but `dailyGlobal*InterestNumeraire18` is
        // written only by Base's `finalizeDay`, so `committableForDay` reads
        // unset denominators and returns a `freshDrawdown` of zero next to a
        // real floor. The second is the dangerous shape — a plausible number
        // rather than an obviously absent one, which is precisely the failure
        // this PR fixes for `absorbed[D]`.
        //
        // Failing loudly is the right answer and costs a mirror nothing: its
        // own local absorption is already readable through
        // {ConfigFacet.getRecycledCreditedByDay}, and the per-chain mesh
        // ledger through {RewardAggregatorFacet}. Nothing here is the only
        // route to anything a mirror legitimately holds.
        // Gated on "IS canonical", not on "is a mirror". `isMirrorRewardChain`
        // is `!isCanonical && baseChainId != 0`, so an UNWIRED Diamond
        // (baseChainId still 0) is neither, and a mirror-shaped guard would
        // wave it through. Nothing is lost by refusing there — the only
        // writers of the state below are `onlyCanonical` — and failing closed
        // means a half-configured deployment cannot serve a global figure it
        // has no way to compute.
        if (!s.isCanonicalRewardChain) {
            revert RecycleDayMetricsCanonicalChainOnly();
        }
        LibVaipakam.DayPoolStamp storage p = s.dayPoolStamp[dayId];
        absorbedLocal = s.recycledCreditedByDay[dayId];
        absorbedMirror = s.dayMirrorRecycledCredit[dayId];
        // Per-DAY provenance, not just the chain's CURRENT role (Codex #1487
        // r3 P2). `setIsCanonicalRewardChain` is a mutable admin setter that
        // flips either way and neither clears nor tags historical state, so a
        // Diamond promoted from mirror to canonical passes the role check
        // above while still holding broadcast-written `dayPoolStamp` entries
        // from its mirror era — days for which it never wrote the canonical
        // `dailyGlobal*` denominators. Trusting `p.stamped` there would
        // resurrect exactly the false-global reading the role gate exists to
        // prevent.
        //
        // `dailyGlobalFinalized[dayId]` is the right marker because it has a
        // single writer, `_finalizeAndWrite`, in the same block as the
        // denominators and the stamp itself — so it is true only for days
        // THIS Diamond finalized as the canonical chain, and it cannot be
        // false for a day whose denominators exist.
        if (!s.dailyGlobalFinalized[dayId] || !p.stamped) {
            return (false, 0, 0, 0, absorbedLocal, absorbedMirror);
        }
        stamped = true;
        scheduleFloor = p.scheduleFloor;
        recycledBudget = p.recycledBudget;
        // `scheduleFloor / 2` — the per-side half, matching the finalize
        // call EXACTLY (integer division included). A divergence here would
        // publish a figure the protocol never reserved.
        (freshDrawdown, ) = LibInteractionRewards.committableForDay(
            s,
            dayId,
            scheduleFloor / 2,
            0
        );
    }

    /**
     * @notice #1218 M5 — the recycle bucket's cumulative position and, with
     *         it, whether the tokens behind the published reserve actually
     *         exist.
     * @dev    `platformRetained` (governor design §9) is
     *         `bucket − outstandingRecycled − keeperBudget`, floored at zero.
     *
     *         The keeper term is NOT decorative. Once
     *         `recycleRegisterKeeperBps` is non-zero, `_applyRecycleRegister`
     *         earmarks part of each day's realized margin into
     *         `recycleKeeperBudget` — carved from INSIDE the bucket, so
     *         `recycleBucket` does not move — and the governor's own
     *         `_recycleFundable` nets it right alongside
     *         `outstandingCommitRecycled`. A consumer following a two-term
     *         formula therefore counts the entire keeper earmark as platform
     *         reserve, overstating it by exactly that amount for as long as
     *         the register is active. It is returned here rather than left to
     *         a second call against
     *         {ConfigFacet.getRecycleRegisterState} precisely because a
     *         second call is the kind of thing a dashboard omits and nobody
     *         notices — the register is dark today, so the error would appear
     *         only when it is switched on. It is returned
     *         as its two RAW terms rather than pre-computed, following the
     *         #1448 posture: the contracts publish the counters, consumers
     *         derive, and an independent re-derivation is what catches a
     *         relabelled figure. The netting is not optional — raw bucket
     *         growth overstates the reserve by counting committed-but-
     *         unclaimed user liabilities as retained margin.
     *
     *         That justification covers only the OVERSTATING direction, and
     *         the error runs the other way too: `platformRetained` can read a
     *         FALSE ZERO on the canonical chain. When a wedged recycled
     *         remittance is released, {LibVpfiRecycle.restoreReleasedRemit}
     *         adds the full amount back to `outstandingCommitRecycled` while
     *         deliberately NOT re-crediting `recycleBucket` — those tokens
     *         are locked in transport, so re-crediting would mint unbacked
     *         ledger. The subtraction then goes negative and floors at zero,
     *         reporting no retained reserve where value genuinely remains.
     *         The gap is not lost: it is what moved into
     *         `recycleReleasedRemitStrandedCumulative`, readable through
     *         {RewardAggregatorFacet.getRecycleCompositionPosition}. Read
     *         that beside this, or a stranded remittance renders as a
     *         depleted platform reserve.
     *
     *         `vpfiBalance` / `unearmarked` are NOT in §9. They are here
     *         because every other figure on this surface is computed from
     *         stored COUNTERS, and counters cannot notice that the tokens
     *         behind them have left. #1460 is exactly that: a fresh-only
     *         claim can spend VPFI backing the recycle bucket, after which
     *         `platformRetained` keeps reporting reserve that is no longer
     *         there. Publishing a dashboard figure that is silently wrong is
     *         a worse outcome than publishing one alongside the balance that
     *         can falsify it.
     *
     *         This MEASURES #1460, it does not fix it — the defect remains a
     *         hard prerequisite for arming (completion plan §M7 step 0).
     *         `unearmarked < scheduled payout` is its third condition, the
     *         one that decides whether a deployment satisfying the other two
     *         is actually corrupted or merely eligible.
     * @return vpfiBalance         Diamond's live VPFI balance, all labels.
     * @return bucket              VPFI wei labelled as recycled runway.
     * @return unearmarked         `vpfiBalance − bucket`, floored at zero.
     *         A zero here is ambiguous by construction — fully consumed and
     *         in breach look identical. Compare `vpfiBalance` against
     *         `bucket` to separate them.
     *
     *         **Scoped to #1460, and NOT a general solvency figure.** It nets
     *         ONE custody class. {LibVpfiRecycle}'s separation invariant names
     *         THREE — `userLifCustody + unclaimedRewardBudget + recycleBucket`
     *         — and the Diamond really does hold the first: borrower LIF paid
     *         in at `acceptOffer` and held until settlement
     *         (`borrowerLifRebate[loanId].vpfiHeld`). That VPFI sits INSIDE
     *         this figure. Matching #1460's third condition is deliberate:
     *         the completion plan §M7 step 0 defines it as exactly
     *         `balanceOf − recycleBucket`, and for detecting a scheduled
     *         payout eating recycle backing that is the correct subtraction.
     *         But a payout consuming LIF custody is a DIFFERENT defect, and
     *         this number cannot see it. Do not read a healthy value here as
     *         "the Diamond is solvent across all custody classes".
     * @return outstandingRecycled Σ armed recycled commitments not yet
     *         consumed — the subtrahend of `platformRetained`.
     * @return paidOutRecycled     The bucket's LIVE net consumed figure —
     *         NOT a monotonic cumulative and NOT lifetime outflow (Codex
     *         #1487 r1 P2 corrected this label, which claimed both).
     *         {LibVpfiRecycle.consume} advances it when a recycled
     *         remittance is SENT, before any delivery acknowledgement, and
     *         {LibVpfiRecycle.restoreReleasedRemit} DECREMENTS it when that
     *         remittance is released. So during an in-flight send it counts
     *         tokens nobody has been paid, and after a release it omits
     *         tokens that physically left the Diamond and are stranded in
     *         transport. The released amount is not lost to accounting —
     *         it moves to `recycleReleasedRemitStrandedCumulative`, readable
     *         via {RewardAggregatorFacet.getRecycleCompositionPosition};
     *         read the two together to reconstruct gross outflow.
     */
    function getRecycleBackingSnapshot()
        external
        view
        returns (
            uint256 vpfiBalance,
            uint256 bucket,
            uint256 unearmarked,
            uint256 outstandingRecycled,
            uint256 paidOutRecycled,
            uint256 keeperBudget
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        (vpfiBalance, bucket, unearmarked) = LibVpfiRecycle.backingPosition(s);
        outstandingRecycled = s.outstandingCommitRecycled;
        paidOutRecycled = s.paidOutRecycled;
        keeperBudget = s.recycleKeeperBudget;
    }
}
