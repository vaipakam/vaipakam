// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IRewardMessenger} from "../interfaces/IRewardMessenger.sol";

/**
 * @title RewardAggregatorFacet
 * @author Vaipakam Developer Team
 * @notice Base-only half of the cross-chain reward accounting mesh
 *         described in docs/TokenomicsTechSpec.md §4a. Owns the trusted
 *         ingress for mirror chain reports, the per-day finalization
 *         step that builds `dailyGlobal*InterestNumeraire18`, and the
 *         broadcast trigger that ships the finalized pair back to every
 *         mirror.
 *
 * @dev Every external mutating method reverts `NotCanonicalRewardChain`
 *      unless `isCanonicalRewardChain == true`. This keeps the facet
 *      safe to diamondCut onto mirror Diamonds — admin only flips the
 *      canonical bit on Base.
 *
 *      Message lifecycle for day `D`:
 *        1. Mirror Diamonds call {RewardReporterFacet.closeDay} on day
 *           `D+1` onward, forwarding `(lenderNumeraire18, borrowerNumeraire18)` via
 *           Chainlink CCIP.
 *        2. On arrival, the Base messenger calls {onChainReportReceived}
 *           which records the pair under the source chainId, increments
 *           `chainDailyReportCount[D]`, and stamps `dailyFirstReportAt[D]`.
 *        3. Once every expected chainId has reported OR
 *           `rewardGraceSeconds` has elapsed since `dailyFirstReportAt[D]`,
 *           anyone may call {finalizeDay}. The finalizer sums reported
 *           chainIds, writes the `dailyGlobal*InterestNumeraire18[D]` pair,
 *           mirrors the pair into `knownGlobal*InterestNumeraire18[D]` for
 *           Base's own claim consumers, flips `dailyGlobalFinalized[D]`,
 *           and emits {DailyGlobalInterestFinalized}.
 *        4. {broadcastGlobal} is a separate permissionless payable
 *           call that ships the finalized pair to every mirror via the
 *           messenger. Split out so finalization stays cheap and broadcast
 *           fees can be replayed if a cross-chain leg fails.
 *
 *      Late reports (same `D`, landing after finalization) are rejected
 *      with `ReportAfterFinalization` so downstream claim math cannot
 *      shift under finalized consumers. Governance may credit the
 *      missed chain out of the Insurance pool but must not reopen `D`.
 */
contract RewardAggregatorFacet is
    DiamondAccessControl,
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    /// @notice Default grace window — kept in sync with the reporter so
    ///         `finalizeDay` and `onRewardBroadcastReceived` agree.
    ///         4 hours for Phase 1; admin may tune via the reporter's
    ///         `setRewardGraceSeconds`.
    uint64 internal constant DEFAULT_REWARD_GRACE_SECONDS = 4 hours;

    /// @notice Emitted when a mirror's day-`D` report lands on the Base
    ///         aggregator. Useful for monitoring (per-chain coverage)
    ///         and for replaying missed broadcasts after a LZ outage.
    /// @param dayId                 Day being reported.
    /// @param sourceChainId             chainId of the mirror that reported.
    /// @param lenderNumeraire18           Reported lender USD-18 for that chain.
    /// @param borrowerNumeraire18         Reported borrower USD-18 for that chain.
    /// @param reportCount           Running count of expected chainIds
    ///                              reported for `dayId` (incl. this one).
    /// @custom:event-category informational/reward-transport
    event ChainReportAggregated(
        uint256 indexed dayId,
        uint32 indexed sourceChainId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        uint32 reportCount
    );

    /// @notice Emitted when the Base aggregator finalizes day `D`. Every
    ///         downstream mirror must be able to trust that the pair is
    ///         immutable after this event fires.
    /// @param dayId                 Day being finalized.
    /// @param globalLenderNumeraire18     Sum-across-chainIds lender USD-18.
    /// @param globalBorrowerNumeraire18   Sum-across-chainIds borrower USD-18.
    /// @param participatingChainCount Number of chainIds that contributed.
    /// @custom:event-category informational/reward-transport
    event DailyGlobalInterestFinalized(
        uint256 indexed dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18,
        uint32 participatingChainCount
    );

    /// @notice Emitted for every expected mirror whose daily report was
    ///         counted as zero during finalization — i.e. either the
    ///         grace window elapsed before the chain reported, or
    ///         {forceFinalizeDay} was used to close the day early. Ops
    ///         / governance can use this to reconcile out-of-band.
    /// @param dayId     Day that finalized.
    /// @param sourceChainId Mirror chainId whose contribution was zeroed.
    /// @param forced    True iff the zero came from {forceFinalizeDay}
    ///                  rather than the grace-window path.
    /// @custom:event-category informational/reward-transport
    event ChainContributionZeroed(
        uint256 indexed dayId,
        uint32 indexed sourceChainId,
        bool forced
    );

    /// @notice Emitted when ops force-close a day via {forceFinalizeDay},
    ///         bypassing both coverage and grace checks. Present as a
    ///         distinct event so ops dashboards can flag admin overrides
    ///         separately from the grace-window path.
    /// @param dayId                 Day that was force-finalized.
    /// @param globalLenderNumeraire18     Lender denominator at force-finalize time.
    /// @param globalBorrowerNumeraire18   Borrower denominator at force-finalize time.
    /// @param participatingChainCount Number of chainIds that contributed.
    /// @param missingChainCount       Number of chainIds zeroed by the override.
    /// @custom:event-category informational/reward-transport
    event DayForceFinalized(
        uint256 indexed dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18,
        uint32 participatingChainCount,
        uint32 missingChainCount
    );

    /// @notice Emitted when ops mutate the Base-side expected-source list.
    /// @custom:event-category informational/config
    event ExpectedSourceChainIdsUpdated(uint32[] chainIds);

    /// @notice #776 — emitted when {backfillDayInclusion} re-derives the
    ///         participation flags for a pre-gate finalized day.
    /// @custom:event-category informational/config
    event DayInclusionBackfilled(uint256 indexed dayId);

    // ─── Modifiers ──────────────────────────────────────────────────────────

    /// @dev Extracted modifier bodies — the modifiers themselves stay thin
    ///      wrappers so each call site inlines one function call instead of
    ///      the full check, deduping bytecode.
    function _checkCanonical() private view {
        if (!LibVaipakam.storageSlot().isCanonicalRewardChain) {
            revert NotCanonicalRewardChain();
        }
    }

    function _checkRewardMessenger() private view {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.rewardMessenger || s.rewardMessenger == address(0)) {
            revert NotAuthorizedRewardMessenger();
        }
    }

    /// @dev All mutating methods are Base-only.
    modifier onlyCanonical() {
        _checkCanonical();
        _;
    }

    /// @dev Ingress handlers trust only the registered messenger — never
    ///      accept reports from random contracts.
    modifier onlyRewardMessenger() {
        _checkRewardMessenger();
        _;
    }

    // ─── Trusted ingress: mirror → Base ─────────────────────────────────────

    /**
     * @notice Record a mirror's day-`D` `(lender, borrower)` USD-18 pair
     *         under `sourceChainId`.
     * @dev Only callable by `rewardMessenger`. Rejects duplicates via
     *      `chainDailyReported[dayId][sourceChainId]`. Rejects late reports
     *      once `dailyGlobalFinalized[dayId] == true`. Rejects unknown
     *      source chainIds not in `expectedSourceChainIds`.
     *
     *      Also serves as Base's own write path when {RewardReporterFacet.closeDay}
     *      runs on the canonical chain — that facet writes directly via
     *      shared storage, so it does NOT go through this method.
     * @param sourceChainId      chainId of the reporting mirror.
     * @param dayId          Day being reported.
     * @param lenderNumeraire18    Mirror's local lender USD-18 for `dayId`.
     * @param borrowerNumeraire18  Mirror's local borrower USD-18 for `dayId`.
     */
    function onChainReportReceived(
        uint32 sourceChainId,
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18
    ) external onlyRewardMessenger onlyCanonical {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        if (!_isExpectedChainId(s, sourceChainId)) revert SourceChainIdNotExpected();
        if (s.dailyGlobalFinalized[dayId]) revert ReportAfterFinalization();
        if (s.chainDailyReported[dayId][sourceChainId]) {
            revert ChainDayAlreadyReported();
        }

        s.chainDailyLenderInterestNumeraire18[dayId][sourceChainId] = lenderNumeraire18;
        s.chainDailyBorrowerInterestNumeraire18[dayId][sourceChainId] = borrowerNumeraire18;
        s.chainDailyReported[dayId][sourceChainId] = true;
        uint32 count;
        unchecked {
            count = s.chainDailyReportCount[dayId] + 1;
        }
        s.chainDailyReportCount[dayId] = count;
        if (s.dailyFirstReportAt[dayId] == 0) {
            s.dailyFirstReportAt[dayId] = uint64(block.timestamp);
        }

        emit ChainReportAggregated(
            dayId,
            sourceChainId,
            lenderNumeraire18,
            borrowerNumeraire18,
            count
        );
    }

    // ─── Permissionless finalize ────────────────────────────────────────────

    /**
     * @notice Finalize the global denominators for day `D` once coverage
     *         or grace conditions are met.
     * @dev Permissionless — anyone may call once:
     *        - every entry in `expectedSourceChainIds` has a report for `D`, OR
     *        - `block.timestamp >= dailyFirstReportAt[D] + graceSeconds`
     *          (with at least one report on file).
     *
     *      Sums reported `chainDaily*InterestNumeraire18` across all expected
     *      chainIds (missing chainIds contribute zero and emit
     *      {ChainContributionZeroed}), writes the
     *      `dailyGlobal*InterestNumeraire18` pair, mirrors the pair into
     *      `knownGlobal*InterestNumeraire18` so Base-side claim flows see the
     *      same number as every broadcast mirror, and flips
     *      `dailyGlobalFinalized[D]`.
     *
     *      Reverts:
     *        - `DayAlreadyFinalized` on replay.
     *        - `DayNotReadyToFinalize` if neither condition is met.
     * @param dayId Day to finalize.
     */
    function finalizeDay(
        uint256 dayId
    ) external nonReentrant whenNotPaused onlyCanonical {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.dailyGlobalFinalized[dayId]) revert DayAlreadyFinalized();

        uint256 nExpected = s.expectedSourceChainIds.length;
        uint32 reportCount = s.chainDailyReportCount[dayId];

        bool fullCoverage = reportCount >= nExpected && nExpected != 0;
        bool graceElapsed;
        uint64 firstAt = s.dailyFirstReportAt[dayId];
        if (firstAt != 0) {
            uint64 grace = s.rewardGraceSeconds == 0
                ? DEFAULT_REWARD_GRACE_SECONDS
                : s.rewardGraceSeconds;
            graceElapsed = block.timestamp >= uint256(firstAt) + uint256(grace);
        }
        if (!(fullCoverage || graceElapsed)) revert DayNotReadyToFinalize();

        _finalizeAndWrite(s, dayId, /* forced */ false);
    }

    /**
     * @notice Admin override: force-finalize day `D` even if coverage
     *         is incomplete AND the grace window has not elapsed.
     * @dev ADMIN_ROLE-gated. Exists so a single permanently offline
     *      chain (LZ outage, endpoint migration, operator downtime)
     *      cannot brick global finalization forever. Every missing chainId
     *      contributes zero to the denominator — governance should
     *      reconcile affected users out of band (e.g. Insurance pool).
     *
     *      Emits {DayForceFinalized} on top of {DailyGlobalInterestFinalized}
     *      so ops dashboards can distinguish admin overrides from
     *      normal grace-window closes. Every zeroed chainId fires
     *      {ChainContributionZeroed} with `forced = true`.
     *
     *      Reverts `DayAlreadyFinalized` on replay. Does NOT require
     *      any reports — the aggregator may close a day with zero
     *      contributions (extreme failure case — produces a zero
     *      denominator, which `LibInteractionRewards` treats as "no
     *      emission this day" and still prevents division-by-zero).
     * @param dayId Day to force-close.
     */
    function forceFinalizeDay(
        uint256 dayId
    )
        external
        nonReentrant
        whenNotPaused
        onlyRole(LibAccessControl.ADMIN_ROLE)
        onlyCanonical
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.dailyGlobalFinalized[dayId]) revert DayAlreadyFinalized();

        _finalizeAndWrite(s, dayId, /* forced */ true);
    }

    /// @dev Shared sum-expected-chainIds / write-globals / emit path used
    ///      by both {finalizeDay} (grace/coverage path) and
    ///      {forceFinalizeDay} (admin override). Separated only to
    ///      keep the two public entry points each responsible for
    ///      their own preconditions.
    function _finalizeAndWrite(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        bool forced
    ) internal {
        uint32[] storage expected = s.expectedSourceChainIds;
        uint256 nExpected = expected.length;

        uint256 globalLender;
        uint256 globalBorrower;
        uint32 participating;
        uint32 missing;

        for (uint256 i; i < nExpected; ) {
            uint32 chainId = expected[i];
            if (s.chainDailyReported[dayId][chainId]) {
                globalLender += s.chainDailyLenderInterestNumeraire18[dayId][chainId];
                globalBorrower += s.chainDailyBorrowerInterestNumeraire18[dayId][chainId];
                // #776 — snapshot that this chain's numerator IS part of the
                // finalized denominator, so its reward-budget slice is coherent.
                s.chainDailyIncluded[dayId][chainId] = true;
                unchecked {
                    ++participating;
                }
            } else {
                emit ChainContributionZeroed(dayId, chainId, forced);
                unchecked {
                    ++missing;
                }
            }
            unchecked {
                ++i;
            }
        }

        s.dailyGlobalLenderInterestNumeraire18[dayId] = globalLender;
        s.dailyGlobalBorrowerInterestNumeraire18[dayId] = globalBorrower;
        s.dailyGlobalFinalized[dayId] = true;

        // Base is also a consumer — mirror the finalized pair into the
        // local `knownGlobal*` slots so InteractionRewardsFacet claims on
        // Base use the same denominator as every broadcast mirror.
        s.knownGlobalLenderInterestNumeraire18[dayId] = globalLender;
        s.knownGlobalBorrowerInterestNumeraire18[dayId] = globalBorrower;
        s.knownGlobalSet[dayId] = true;

        // #1008 (S13, Option B) — snapshot the §4 daily-cap threshold at
        // finalization from Base's ETH feed + the effective cap ratio. This is
        // the CANONICAL threshold: `broadcastGlobal` ships it to every mirror
        // (see {RewardReporterFacet.onRewardBroadcastReceived}) so Base and all
        // mirrors cap identically and the per-chain remittance identity holds.
        LibInteractionRewards.snapshotDayCapThreshold(dayId);

        // Governor PR-3b (#1217 §3.1) — stamp the day's pool composition
        // (schedule floor + absorption-coupled recycled budget) at the same
        // snapshot point. Records-only until the PR-3c cutover arms
        // commitment reservation (see {LibVaipakam.Storage
        // .governorCommitArmedFromDay}); the live claim math stays
        // schedule-based until that cutover, so nothing pays from the
        // recycled term yet — absorption without distribution coupling is
        // the accepted launch posture.
        _stampGovernorDayPool(s, dayId);

        emit DailyGlobalInterestFinalized(
            dayId,
            globalLender,
            globalBorrower,
            participating
        );
        if (forced) {
            emit DayForceFinalized(
                dayId,
                globalLender,
                globalBorrower,
                participating,
                missing
            );
        }
    }

    /// @notice Governor PR-3b (#1217 §3.1) — emitted once per finalized day
    ///         with the stamped pool composition. `dailyPool` is
    ///         `scheduleFloor + recycledBudget`; `aBar` is the trailing
    ///         absorption average the recycled term was sized from.
    /// @custom:event-category informational/reward-governor
    event GovernorDayPoolStamped(
        uint256 indexed dayId,
        uint256 scheduleFloor,
        uint256 recycledBudget,
        uint256 aBar,
        uint256 marginBps
    );

    /// @dev Governor PR-3b (#1217 §3.1) — compute + stamp the day's pool
    ///      composition at finalization (write-once; the finalize entry
    ///      points already guard replay via `dailyGlobalFinalized`):
    ///
    ///        Ā[D]           = Σ_{d∈(D−W..D]} credited[d] / W   (W = 7,
    ///                         zero-padded — NEVER ÷ elapsed days)
    ///        scheduleFloor  = min(schedule[D], freshAvailable)
    ///        recycledBudget = schedule==0 ? 0
    ///                         : min(fundable, Ā×(10000−m)/10000)
    ///
    ///      `schedule[D] = halfPoolForDay × 2`, zeroed on day 0 (the
    ///      first 24h stay reward-excluded; the coupled term is gated off
    ///      with it — recycling must not make day-0 activity rewardable).
    ///      `freshAvailable` nets the pool cap against paid-out +
    ///      remitted-to-mirror + ARMED outstanding fresh commitments;
    ///      `fundable` nets the recycle bucket against ARMED outstanding
    ///      recycled commitments. While `governorCommitArmedFromDay` is 0
    ///      the outstanding sums stay untouched (records-only — see the
    ///      storage natspec for why reservation must arm atomically with
    ///      PR-3c's consume-at-claim).
    function _stampGovernorDayPool(
        LibVaipakam.Storage storage s,
        uint256 dayId
    ) internal {
        uint256 w = LibVaipakam.RECYCLE_TRAILING_WINDOW_DAYS;
        uint256 credited;
        for (uint256 i; i < w; ) {
            if (dayId >= i) {
                credited += s.recycledCreditedByDay[dayId - i];
            }
            unchecked {
                ++i;
            }
        }
        uint256 aBar = credited / w;

        uint256 schedule = dayId == 0
            ? 0
            : LibInteractionRewards.halfPoolForDay(dayId) * 2;

        uint256 reserved = s.interactionPoolPaidOut
            + s.rewardBudgetRemittedGlobal
            + s.outstandingCommitFresh;
        uint256 freshAvailable = LibVaipakam.VPFI_INTERACTION_POOL_CAP > reserved
            ? LibVaipakam.VPFI_INTERACTION_POOL_CAP - reserved
            : 0;
        uint256 scheduleFloor = schedule < freshAvailable
            ? schedule
            : freshAvailable;

        uint256 marginBps = LibVaipakam.cfgRecycleMarginBps();
        uint256 fundable = s.recycleBucket > s.outstandingCommitRecycled
            ? s.recycleBucket - s.outstandingCommitRecycled
            : 0;
        uint256 coupled = (aBar * (10_000 - marginBps)) / 10_000;
        uint256 recycledBudget = schedule == 0
            ? 0
            : (fundable < coupled ? fundable : coupled);

        s.dayPoolStamp[dayId] = LibVaipakam.DayPoolStamp({
            scheduleFloor: uint128(scheduleFloor),
            recycledBudget: uint128(recycledBudget),
            aBarAtFinalize: uint128(aBar),
            marginBpsAtFinalize: uint16(marginBps),
            stamped: true
        });

        // Commitment reservation — armed only from the PR-3c cutover day.
        // Codex #1315 P1: reserve the CAPPED committable amounts, not the
        // raw stamp — claims/remits can only ever consume the #1008-capped
        // per-side budgets, and a zero-denominator side consumes nothing;
        // reserving the raw halves would strand the unclaimable remainder
        // in `outstandingCommit*` and shrink every later day's
        // availability for value no user can draw.
        uint256 armedFrom = s.governorCommitArmedFromDay;
        if (armedFrom != 0 && dayId >= armedFrom) {
            (uint256 commitFresh, uint256 commitRecycled) =
                LibInteractionRewards.committableForDay(
                    s,
                    dayId,
                    scheduleFloor / 2,
                    recycledBudget / 2
                );
            s.outstandingCommitFresh += commitFresh;
            s.outstandingCommitRecycled += commitRecycled;
        }

        emit GovernorDayPoolStamped(
            dayId,
            scheduleFloor,
            recycledBudget,
            aBar,
            marginBps
        );

        _applyRecycleRegister(s, dayId, aBar, marginBps);
    }

    /// @notice RL-4 (#1306, ratified §10.3) — emitted when the allocation
    ///         register splits a day's residual (non-dormant weights only).
    /// @custom:event-category state-change/treasury-mutation
    event RecycleRegisterSplit(
        uint256 indexed dayId,
        uint256 splittable,
        uint256 keeperShare
    );

    /// @dev RL-4 — the recycled-stream allocation register, applied at the
    ///      SAME finalization snapshot as the day-pool stamp (weights read
    ///      once, deterministic — no per-epoch discretion). Defined over
    ///      the RESIDUAL only, claims-first by construction:
    ///
    ///        splittable = min( marginRealized,                    // Ā×m
    ///                          max(0, fundable − RESERVE_N × Ā) )
    ///
    ///      where `fundable` is the bucket net of ALL outstanding recycled
    ///      commitments (this day's included — claims were funded first,
    ///      structurally), and the forward reserve keeps at least one
    ///      trailing week of coupled budget in the bucket for future days.
    ///      The keeper share moves bucket → keeper-budget ledger; the
    ///      reserve share stays in the bucket (no movement). Dormant
    ///      (`keeperBps == 0`, the deploy default) this is a no-op —
    ///      exactly today's ratified behaviour.
    function _applyRecycleRegister(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        uint256 aBar,
        uint256 marginBps
    ) internal {
        uint16 keeperBps = s.recycleRegisterKeeperBps;
        if (keeperBps == 0 || aBar == 0) return;

        uint256 marginRealized = (aBar * marginBps) / 10_000;
        uint256 bucket = s.recycleBucket;
        uint256 outstanding = s.outstandingCommitRecycled;
        uint256 fundable = bucket > outstanding ? bucket - outstanding : 0;
        uint256 forwardReserve =
            LibVaipakam.RECYCLE_FORWARD_RESERVE_DAYS * aBar;
        uint256 aboveReserve =
            fundable > forwardReserve ? fundable - forwardReserve : 0;
        uint256 splittable =
            marginRealized < aboveReserve ? marginRealized : aboveReserve;
        if (splittable == 0) return;

        uint256 keeperShare = (splittable * keeperBps) / 10_000;
        if (keeperShare == 0) return;
        // Bucket → keeper-budget ledger (both are Diamond-custody slices;
        // no token movement). The reserve share never moves.
        s.recycleBucket = bucket - keeperShare;
        s.recycleKeeperBudget += keeperShare;
        emit RecycleRegisterSplit(dayId, splittable, keeperShare);
    }

    /// @notice Governor PR-3b — read a finalized day's stamped pool
    ///         composition (transparency + #1218 metrics + PR-3c claim
    ///         math source).
    /// @param  dayId Day to read.
    /// @return stamped        True once the day finalized (stamp exists).
    /// @return scheduleFloor  Fresh (pre-fund) half of the day's pool.
    /// @return recycledBudget Absorption-coupled recycled half.
    /// @return aBar           Trailing absorption average at finalize.
    /// @return marginBps      Retained-margin bps stamped at finalize.
    function getDayPoolStamp(uint256 dayId)
        external
        view
        returns (
            bool stamped,
            uint256 scheduleFloor,
            uint256 recycledBudget,
            uint256 aBar,
            uint256 marginBps
        )
    {
        LibVaipakam.DayPoolStamp storage p =
            LibVaipakam.storageSlot().dayPoolStamp[dayId];
        return (
            p.stamped,
            p.scheduleFloor,
            p.recycledBudget,
            p.aBarAtFinalize,
            p.marginBpsAtFinalize
        );
    }

    /// @notice Governor PR-3b — the outstanding (armed) commitment sums and
    ///         arming day. All zero until the PR-3c cutover arms
    ///         reservation.
    /// @return armedFromDay        First day whose stamp reserves (0 = unarmed).
    /// @return outstandingFresh    Σ armed fresh commitments not yet consumed.
    /// @return outstandingRecycled Σ armed recycled commitments not yet consumed.
    function getGovernorCommitState()
        external
        view
        returns (
            uint256 armedFromDay,
            uint256 outstandingFresh,
            uint256 outstandingRecycled,
            uint256 paidOutRecycled
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.governorCommitArmedFromDay,
            s.outstandingCommitFresh,
            s.outstandingCommitRecycled,
            s.paidOutRecycled
        );
    }

    // ─── Broadcast trigger ─────────────────────────────────────────────────

    /**
     * @notice Ship the finalized `(globalLender, globalBorrower)` pair
     *         for `dayId` to every mirror via the registered messenger.
     * @dev Payable, permissionless. `msg.value` must cover the sum of
     *      per-destination CCIP native fees — quote first via
     *      {IRewardMessenger.quoteBroadcastGlobal}. Leftover refunds to the
     *      caller.
     *
     *      Separated from {finalizeDay} so finalization stays cheap and
     *      a LZ outage on one destination can be retried independently
     *      from another via a follow-up call.
     * @param dayId Day whose finalized pair to broadcast.
     */
    function broadcastGlobal(
        uint256 dayId
    ) external payable nonReentrant whenNotPaused onlyCanonical {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.dailyGlobalFinalized[dayId]) revert DayNotReadyToFinalize();
        address messenger = s.rewardMessenger;
        if (messenger == address(0)) revert RewardMessengerNotSet();

        LibVaipakam.DayPoolStamp storage stamp = s.dayPoolStamp[dayId];
        IRewardMessenger(messenger).broadcastGlobal{value: msg.value}(
            dayId,
            s.dailyGlobalLenderInterestNumeraire18[dayId],
            s.dailyGlobalBorrowerInterestNumeraire18[dayId],
            // #1008 (S13) — ship the finalize-snapshotted canonical §4 cap
            // threshold so every mirror caps identically.
            s.dayCapThreshold18[dayId],
            // Governor PR-3c (#1217 §6/§8) — ship the finalize-stamped
            // day-pool composition (per-side halves) + the arming day so
            // every mirror prices the identical dailyPool and arms on the
            // same D* with zero operator drift.
            uint256(stamp.scheduleFloor) / 2,
            uint256(stamp.recycledBudget) / 2,
            s.governorCommitArmedFromDay,
            payable(msg.sender)
        );
    }

    /// @notice Governor PR-3c (#1217) — arm commitment reservation +
    ///         consume-at-claim from `dayId` forward (the D* cutover).
    ///         One-shot and future-only: arming must never rewrite already
    ///         -finalized days (their stamps were records, not
    ///         reservations), and un-arming would strand outstanding
    ///         commitments. Mirrors receive D* in-band with every
    ///         subsequent broadcast — no per-chain admin step.
    /// @dev    ADMIN_ROLE + canonical-only. Requires a FUTURE day so no
    ///         already-stamped day flips semantics retroactively.
    function setGovernorCommitArmedFromDay(uint256 dayId)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
        onlyCanonical
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.governorCommitArmedFromDay != 0) {
            revert GovernorAlreadyArmed(s.governorCommitArmedFromDay);
        }
        (uint256 today, ) = LibInteractionRewards.currentDayOrZero();
        if (dayId == 0 || dayId <= today) {
            revert GovernorArmingDayNotFuture(dayId, today);
        }
        s.governorCommitArmedFromDay = dayId;
        emit GovernorCommitArmed(dayId);
    }

    /// @notice PR-3c — arming is one-shot; a second call reverts.
    error GovernorAlreadyArmed(uint256 armedFromDay);
    /// @notice PR-3c — the arming day must be strictly in the future.
    error GovernorArmingDayNotFuture(uint256 dayId, uint256 today);
    /// @notice PR-3c — emitted once when the D* cutover is armed.
    /// @custom:event-category informational/reward-governor
    event GovernorCommitArmed(uint256 dayId);

    // ─── Admin ──────────────────────────────────────────────────────────────

    /// @notice Set the full list of EVM chain ids the Base aggregator
    ///         expects to receive daily reports from. Include Base's own
    ///         `block.chainid` (because Base is a source too) + every
    ///         mirror chain id.
    /// @dev Overwrites the previous list. Admin must keep it in sync
    ///      with the mirror deployments; dropping a chain id for a given
    ///      day mid-flight causes that day to finalize with a lower
    ///      denominator.
    /// @param chainIds Full replacement list of expected source chain ids.
    function setExpectedSourceChainIds(
        uint32[] calldata chainIds
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) onlyCanonical {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 len = s.expectedSourceChainIds.length;
        // Pop existing, then push new — `delete s.expectedSourceChainIds`
        // does not recursively clear dynamic arrays in Diamond storage
        // across facets without an explicit loop.
        for (uint256 i; i < len; ) {
            s.expectedSourceChainIds.pop();
            unchecked {
                ++i;
            }
        }
        for (uint256 i; i < chainIds.length; ) {
            s.expectedSourceChainIds.push(chainIds[i]);
            unchecked {
                ++i;
            }
        }
        emit ExpectedSourceChainIdsUpdated(chainIds);
    }

    /**
     * @notice #776 — one-time backfill of the per-day `chainDailyIncluded`
     *         participation flags for a day that was FINALIZED before the
     *         inclusion gate shipped, so its reward-budget slices become
     *         remittable again.
     * @dev    On a genesis deploy this is NEVER needed — {finalizeDay} sets the
     *         flags from day 1, so no pre-gate finalized day exists. It exists
     *         only to migrate a deployment that already had finalized days when
     *         this facet was upgraded in (Codex #776 review): without it,
     *         `chainRewardBudgetForDay` would return 0 for every pre-upgrade
     *         `(chain, day)` and the historical mirror-claim backlog would be
     *         unfundable. Idempotent (re-setting a true flag is a no-op).
     *
     *         Re-derives inclusion from the SAME predicate {finalizeDay} used:
     *         a chain counts iff it is in the CURRENT `expectedSourceChainIds`
     *         AND reported for `dayId` (`chainDailyReported`). The operator must
     *         therefore run this while the expected set still matches the set
     *         that was live when `dayId` finalized — the natural case right
     *         after the upgrade, before any `setExpectedSourceChainIds` edit.
     * @param dayId A finalized day to backfill.
     */
    function backfillDayInclusion(
        uint256 dayId
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) onlyCanonical {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.dailyGlobalFinalized[dayId]) revert DayNotReadyToFinalize();
        uint32[] storage expected = s.expectedSourceChainIds;
        uint256 n = expected.length;
        for (uint256 i; i < n; ) {
            uint32 chainId = expected[i];
            if (s.chainDailyReported[dayId][chainId]) {
                s.chainDailyIncluded[dayId][chainId] = true;
            }
            unchecked {
                ++i;
            }
        }
        emit DayInclusionBackfilled(dayId);
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    /// @notice Whether `sourceChainId` has reported for `dayId`.
    function isChainReported(
        uint256 dayId,
        uint32 sourceChainId
    ) external view returns (bool) {
        return
            LibVaipakam.storageSlot().chainDailyReported[dayId][sourceChainId];
    }

    /// @notice Mirror-specific `(lender, borrower)` pair for `dayId`.
    function getChainReport(
        uint256 dayId,
        uint32 sourceChainId
    ) external view returns (uint256 lenderNumeraire18, uint256 borrowerNumeraire18) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.chainDailyLenderInterestNumeraire18[dayId][sourceChainId],
            s.chainDailyBorrowerInterestNumeraire18[dayId][sourceChainId]
        );
    }

    /// @notice Running count of expected chainIds that have reported for `dayId`.
    function getChainDailyReportCount(
        uint256 dayId
    ) external view returns (uint32) {
        return LibVaipakam.storageSlot().chainDailyReportCount[dayId];
    }

    /// @notice `block.timestamp` of the first ingress for `dayId` (0 ⇒ none).
    function getDailyFirstReportAt(
        uint256 dayId
    ) external view returns (uint64) {
        return LibVaipakam.storageSlot().dailyFirstReportAt[dayId];
    }

    /// @notice Finalization status + pair for `dayId`.
    /// @return finalized            True iff {finalizeDay} has run for `dayId`.
    /// @return globalLenderNumeraire18    Sum-across-chainIds lender USD-18.
    /// @return globalBorrowerNumeraire18  Sum-across-chainIds borrower USD-18.
    function getDailyGlobalInterest(
        uint256 dayId
    )
        external
        view
        returns (
            bool finalized,
            uint256 globalLenderNumeraire18,
            uint256 globalBorrowerNumeraire18
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.dailyGlobalFinalized[dayId],
            s.dailyGlobalLenderInterestNumeraire18[dayId],
            s.dailyGlobalBorrowerInterestNumeraire18[dayId]
        );
    }

    /// @notice Full list of chainIds the aggregator expects to hear from.
    function getExpectedSourceChainIds() external view returns (uint32[] memory) {
        return LibVaipakam.storageSlot().expectedSourceChainIds;
    }

    /// @notice Whether `finalizeDay(dayId)` can be called now.
    /// @return ready     True iff coverage or grace condition is met AND
    ///                   the day is not already finalized.
    /// @return reason    Zero when `ready`; otherwise an encoded status:
    ///                   1 = already finalized,
    ///                   2 = no reports yet,
    ///                   3 = waiting for more reports or grace.
    function isDayReadyToFinalize(
        uint256 dayId
    ) external view returns (bool ready, uint8 reason) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.dailyGlobalFinalized[dayId]) return (false, 1);

        uint32 nExpected = uint32(s.expectedSourceChainIds.length);
        uint32 count = s.chainDailyReportCount[dayId];
        uint64 firstAt = s.dailyFirstReportAt[dayId];

        if (count == 0) return (false, 2);
        if (count >= nExpected && nExpected != 0) return (true, 0);

        uint64 grace = s.rewardGraceSeconds == 0
            ? DEFAULT_REWARD_GRACE_SECONDS
            : s.rewardGraceSeconds;
        if (block.timestamp >= uint256(firstAt) + uint256(grace)) {
            return (true, 0);
        }
        return (false, 3);
    }

    // ─── Internals ──────────────────────────────────────────────────────────

    /// @dev Linear scan over `expectedSourceChainIds` — the list is tiny
    ///      (≤ ~5 Phase-1 chains), and a set-style bitmap would burn
    ///      storage slots for a membership we only check on ingress.
    function _isExpectedChainId(
        LibVaipakam.Storage storage s,
        uint32 chainId
    ) internal view returns (bool) {
        uint32[] storage list = s.expectedSourceChainIds;
        for (uint256 i; i < list.length; ) {
            if (list[i] == chainId) return true;
            unchecked {
                ++i;
            }
        }
        return false;
    }
}
