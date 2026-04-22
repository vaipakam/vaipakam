// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IRewardOApp} from "../interfaces/IRewardOApp.sol";

/**
 * @title RewardAggregatorFacet
 * @author Vaipakam Developer Team
 * @notice Base-only half of the cross-chain reward accounting mesh
 *         described in docs/TokenomicsTechSpec.md §4a. Owns the trusted
 *         ingress for mirror chain reports, the per-day finalization
 *         step that builds `dailyGlobal*InterestUSD18`, and the
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
 *           `D+1` onward, forwarding `(lenderUSD18, borrowerUSD18)` via
 *           LayerZero.
 *        2. On arrival, the Base OApp calls {onChainReportReceived}
 *           which records the pair under the source eid, increments
 *           `chainDailyReportCount[D]`, and stamps `dailyFirstReportAt[D]`.
 *        3. Once every expected eid has reported OR
 *           `rewardGraceSeconds` has elapsed since `dailyFirstReportAt[D]`,
 *           anyone may call {finalizeDay}. The finalizer sums reported
 *           eids, writes the `dailyGlobal*InterestUSD18[D]` pair,
 *           mirrors the pair into `knownGlobal*InterestUSD18[D]` for
 *           Base's own claim consumers, flips `dailyGlobalFinalized[D]`,
 *           and emits {DailyGlobalInterestFinalized}.
 *        4. {broadcastGlobal} is a separate permissionless payable
 *           call that ships the finalized pair to every mirror via the
 *           OApp. Split out so finalization stays cheap and broadcast
 *           fees can be replayed if a LayerZero leg fails.
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
    /// @param sourceEid             LayerZero eid of the mirror that reported.
    /// @param lenderUSD18           Reported lender USD-18 for that chain.
    /// @param borrowerUSD18         Reported borrower USD-18 for that chain.
    /// @param reportCount           Running count of expected eids
    ///                              reported for `dayId` (incl. this one).
    event ChainReportAggregated(
        uint256 indexed dayId,
        uint32 indexed sourceEid,
        uint256 lenderUSD18,
        uint256 borrowerUSD18,
        uint32 reportCount
    );

    /// @notice Emitted when the Base aggregator finalizes day `D`. Every
    ///         downstream mirror must be able to trust that the pair is
    ///         immutable after this event fires.
    /// @param dayId                 Day being finalized.
    /// @param globalLenderUSD18     Sum-across-eids lender USD-18.
    /// @param globalBorrowerUSD18   Sum-across-eids borrower USD-18.
    /// @param participatingEidCount Number of eids that contributed.
    event DailyGlobalInterestFinalized(
        uint256 indexed dayId,
        uint256 globalLenderUSD18,
        uint256 globalBorrowerUSD18,
        uint32 participatingEidCount
    );

    /// @notice Emitted for every expected mirror whose daily report was
    ///         counted as zero during finalization — i.e. either the
    ///         grace window elapsed before the chain reported, or
    ///         {forceFinalizeDay} was used to close the day early. Ops
    ///         / governance can use this to reconcile out-of-band.
    /// @param dayId     Day that finalized.
    /// @param sourceEid Mirror eid whose contribution was zeroed.
    /// @param forced    True iff the zero came from {forceFinalizeDay}
    ///                  rather than the grace-window path.
    event ChainContributionZeroed(
        uint256 indexed dayId,
        uint32 indexed sourceEid,
        bool forced
    );

    /// @notice Emitted when ops force-close a day via {forceFinalizeDay},
    ///         bypassing both coverage and grace checks. Present as a
    ///         distinct event so ops dashboards can flag admin overrides
    ///         separately from the grace-window path.
    /// @param dayId                 Day that was force-finalized.
    /// @param globalLenderUSD18     Lender denominator at force-finalize time.
    /// @param globalBorrowerUSD18   Borrower denominator at force-finalize time.
    /// @param participatingEidCount Number of eids that contributed.
    /// @param missingEidCount       Number of eids zeroed by the override.
    event DayForceFinalized(
        uint256 indexed dayId,
        uint256 globalLenderUSD18,
        uint256 globalBorrowerUSD18,
        uint32 participatingEidCount,
        uint32 missingEidCount
    );

    /// @notice Emitted when ops mutate the Base-side expected-source list.
    event ExpectedSourceEidsUpdated(uint32[] eids);

    // ─── Modifiers ──────────────────────────────────────────────────────────

    /// @dev All mutating methods are Base-only.
    modifier onlyCanonical() {
        if (!LibVaipakam.storageSlot().isCanonicalRewardChain) {
            revert NotCanonicalRewardChain();
        }
        _;
    }

    /// @dev Ingress handlers trust only the registered OApp — never
    ///      accept reports from random contracts.
    modifier onlyRewardOApp() {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.rewardOApp || s.rewardOApp == address(0)) {
            revert NotAuthorizedRewardOApp();
        }
        _;
    }

    // ─── Trusted ingress: mirror → Base ─────────────────────────────────────

    /**
     * @notice Record a mirror's day-`D` `(lender, borrower)` USD-18 pair
     *         under `sourceEid`.
     * @dev Only callable by `rewardOApp`. Rejects duplicates via
     *      `chainDailyReported[dayId][sourceEid]`. Rejects late reports
     *      once `dailyGlobalFinalized[dayId] == true`. Rejects unknown
     *      source eids not in `expectedSourceEids`.
     *
     *      Also serves as Base's own write path when {RewardReporterFacet.closeDay}
     *      runs on the canonical chain — that facet writes directly via
     *      shared storage, so it does NOT go through this method.
     * @param sourceEid      LayerZero eid of the reporting mirror.
     * @param dayId          Day being reported.
     * @param lenderUSD18    Mirror's local lender USD-18 for `dayId`.
     * @param borrowerUSD18  Mirror's local borrower USD-18 for `dayId`.
     */
    function onChainReportReceived(
        uint32 sourceEid,
        uint256 dayId,
        uint256 lenderUSD18,
        uint256 borrowerUSD18
    ) external onlyRewardOApp onlyCanonical {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        if (!_isExpectedEid(s, sourceEid)) revert SourceEidNotExpected();
        if (s.dailyGlobalFinalized[dayId]) revert ReportAfterFinalization();
        if (s.chainDailyReported[dayId][sourceEid]) {
            revert ChainDayAlreadyReported();
        }

        s.chainDailyLenderInterestUSD18[dayId][sourceEid] = lenderUSD18;
        s.chainDailyBorrowerInterestUSD18[dayId][sourceEid] = borrowerUSD18;
        s.chainDailyReported[dayId][sourceEid] = true;
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
            sourceEid,
            lenderUSD18,
            borrowerUSD18,
            count
        );
    }

    // ─── Permissionless finalize ────────────────────────────────────────────

    /**
     * @notice Finalize the global denominators for day `D` once coverage
     *         or grace conditions are met.
     * @dev Permissionless — anyone may call once:
     *        - every entry in `expectedSourceEids` has a report for `D`, OR
     *        - `block.timestamp >= dailyFirstReportAt[D] + graceSeconds`
     *          (with at least one report on file).
     *
     *      Sums reported `chainDaily*InterestUSD18` across all expected
     *      eids (missing eids contribute zero and emit
     *      {ChainContributionZeroed}), writes the
     *      `dailyGlobal*InterestUSD18` pair, mirrors the pair into
     *      `knownGlobal*InterestUSD18` so Base-side claim flows see the
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

        uint256 nExpected = s.expectedSourceEids.length;
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
     *      cannot brick global finalization forever. Every missing eid
     *      contributes zero to the denominator — governance should
     *      reconcile affected users out of band (e.g. Insurance pool).
     *
     *      Emits {DayForceFinalized} on top of {DailyGlobalInterestFinalized}
     *      so ops dashboards can distinguish admin overrides from
     *      normal grace-window closes. Every zeroed eid fires
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

    /// @dev Shared sum-expected-eids / write-globals / emit path used
    ///      by both {finalizeDay} (grace/coverage path) and
    ///      {forceFinalizeDay} (admin override). Separated only to
    ///      keep the two public entry points each responsible for
    ///      their own preconditions.
    function _finalizeAndWrite(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        bool forced
    ) internal {
        uint32[] storage expected = s.expectedSourceEids;
        uint256 nExpected = expected.length;

        uint256 globalLender;
        uint256 globalBorrower;
        uint32 participating;
        uint32 missing;

        for (uint256 i; i < nExpected; ) {
            uint32 eid = expected[i];
            if (s.chainDailyReported[dayId][eid]) {
                globalLender += s.chainDailyLenderInterestUSD18[dayId][eid];
                globalBorrower += s.chainDailyBorrowerInterestUSD18[dayId][eid];
                unchecked {
                    ++participating;
                }
            } else {
                emit ChainContributionZeroed(dayId, eid, forced);
                unchecked {
                    ++missing;
                }
            }
            unchecked {
                ++i;
            }
        }

        s.dailyGlobalLenderInterestUSD18[dayId] = globalLender;
        s.dailyGlobalBorrowerInterestUSD18[dayId] = globalBorrower;
        s.dailyGlobalFinalized[dayId] = true;

        // Base is also a consumer — mirror the finalized pair into the
        // local `knownGlobal*` slots so InteractionRewardsFacet claims on
        // Base use the same denominator as every broadcast mirror.
        s.knownGlobalLenderInterestUSD18[dayId] = globalLender;
        s.knownGlobalBorrowerInterestUSD18[dayId] = globalBorrower;
        s.knownGlobalSet[dayId] = true;

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

    // ─── Broadcast trigger ─────────────────────────────────────────────────

    /**
     * @notice Ship the finalized `(globalLender, globalBorrower)` pair
     *         for `dayId` to every mirror via the registered OApp.
     * @dev Payable, permissionless. `msg.value` must cover the sum of
     *      per-destination LZ native fees — quote first via
     *      {IRewardOApp.quoteBroadcastGlobal}. Leftover refunds to the
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
        address oApp = s.rewardOApp;
        if (oApp == address(0)) revert RewardOAppNotSet();

        IRewardOApp(oApp).broadcastGlobal{value: msg.value}(
            dayId,
            s.dailyGlobalLenderInterestUSD18[dayId],
            s.dailyGlobalBorrowerInterestUSD18[dayId],
            payable(msg.sender)
        );
    }

    // ─── Admin ──────────────────────────────────────────────────────────────

    /// @notice Set the full list of eids the Base aggregator expects to
    ///         receive daily reports from. Include Base's own `localEid`
    ///         (because Base is a source too) + every mirror eid.
    /// @dev Overwrites the previous list. Admin must keep it in sync
    ///      with the mirror deployments; dropping an eid for a given
    ///      day mid-flight causes that day to finalize with a lower
    ///      denominator.
    /// @param eids Full replacement list of expected source eids.
    function setExpectedSourceEids(
        uint32[] calldata eids
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) onlyCanonical {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 len = s.expectedSourceEids.length;
        // Pop existing, then push new — `delete s.expectedSourceEids`
        // does not recursively clear dynamic arrays in Diamond storage
        // across facets without an explicit loop.
        for (uint256 i; i < len; ) {
            s.expectedSourceEids.pop();
            unchecked {
                ++i;
            }
        }
        for (uint256 i; i < eids.length; ) {
            s.expectedSourceEids.push(eids[i]);
            unchecked {
                ++i;
            }
        }
        emit ExpectedSourceEidsUpdated(eids);
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    /// @notice Whether `sourceEid` has reported for `dayId`.
    function isChainReported(
        uint256 dayId,
        uint32 sourceEid
    ) external view returns (bool) {
        return
            LibVaipakam.storageSlot().chainDailyReported[dayId][sourceEid];
    }

    /// @notice Mirror-specific `(lender, borrower)` pair for `dayId`.
    function getChainReport(
        uint256 dayId,
        uint32 sourceEid
    ) external view returns (uint256 lenderUSD18, uint256 borrowerUSD18) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.chainDailyLenderInterestUSD18[dayId][sourceEid],
            s.chainDailyBorrowerInterestUSD18[dayId][sourceEid]
        );
    }

    /// @notice Running count of expected eids that have reported for `dayId`.
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
    /// @return globalLenderUSD18    Sum-across-eids lender USD-18.
    /// @return globalBorrowerUSD18  Sum-across-eids borrower USD-18.
    function getDailyGlobalInterest(
        uint256 dayId
    )
        external
        view
        returns (
            bool finalized,
            uint256 globalLenderUSD18,
            uint256 globalBorrowerUSD18
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.dailyGlobalFinalized[dayId],
            s.dailyGlobalLenderInterestUSD18[dayId],
            s.dailyGlobalBorrowerInterestUSD18[dayId]
        );
    }

    /// @notice Full list of eids the aggregator expects to hear from.
    function getExpectedSourceEids() external view returns (uint32[] memory) {
        return LibVaipakam.storageSlot().expectedSourceEids;
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

        uint32 nExpected = uint32(s.expectedSourceEids.length);
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

    /// @dev Linear scan over `expectedSourceEids` — the list is tiny
    ///      (≤ ~5 Phase-1 chains), and a set-style bitmap would burn
    ///      storage slots for a membership we only check on ingress.
    function _isExpectedEid(
        LibVaipakam.Storage storage s,
        uint32 eid
    ) internal view returns (bool) {
        uint32[] storage list = s.expectedSourceEids;
        for (uint256 i; i < list.length; ) {
            if (list[i] == eid) return true;
            unchecked {
                ++i;
            }
        }
        return false;
    }
}
