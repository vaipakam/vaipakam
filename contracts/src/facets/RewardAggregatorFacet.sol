// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibVpfiRecycle} from "../libraries/LibVpfiRecycle.sol";
import {LibMeshFunding} from "../libraries/LibMeshFunding.sol";
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

    /// @notice #1222 M3 B2-c — emitted when a force-finalize closes an armed
    ///         day without a chain's COMPLETE commitments, blocking its
    ///         ShareOfPool remittance until an operator reconciles the true
    ///         headroom (`RewardCommitmentFacet.reconcileCommitmentRemitEligibility`).
    /// @custom:event-category informational/reward-governor
    event CommitmentRemitIneligible(
        uint256 indexed dayId,
        uint32 indexed chainId
    );

    /// @notice #1222 M3 B2-d1 — a mirror's day-`D` commitment report was
    ///         accepted: its per-side claimable-liability aggregate is stored
    ///         and the finalization gate for `(dayId, chainId)` is now complete.
    /// @custom:event-category informational/reward-governor
    event CommitmentReportAccepted(
        uint256 indexed dayId,
        uint32 indexed chainId,
        uint256 liabilityLender18,
        uint256 liabilityBorrower18
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
     * @param recycledCumulative18 Mirror's monotonic cumulative recycle-bucket
     *                             credits (#1222 B1 availability ledger; zero
     *                             on a legacy four-word report).
     * @param recycledForDay18     Mirror's claimed recycle credit total for
     *                             `dayId` (#1222 B1 `Ā` attribution; clamped
     *                             against the cumulative increase on write).
     */
    function onChainReportReceived(
        uint32 sourceChainId,
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        uint256 recycledCumulative18,
        uint256 recycledForDay18
    ) external onlyRewardMessenger onlyCanonical {
        _ingestChainReport(
            sourceChainId,
            dayId,
            lenderNumeraire18,
            borrowerNumeraire18,
            recycledCumulative18,
            recycledForDay18,
            0,
            0
        );
    }

    /**
     * @notice #1222 M3 B3 — the CURRENT ingress: the B1 figures plus the
     *         reporting chain's commitment-RETIREMENT cumulatives.
     * @dev Messenger-authenticated + canonical-only, like every other
     *      overload. The two additions close the loop the B2-d3 books left
     *      open — Base could instruct a mirror to fund a slice locally but
     *      had no authenticated view of what the mirror then did with the
     *      reservation, so `chainOutstandingRecycledCommit[c]` only ever grew
     *      and a commitment RELEASED un-spent (forfeit / RL-3 expiry, tokens
     *      never left that chain's bucket) was lost from Base's availability
     *      model permanently.
     *
     *      Both figures are monotonic cumulatives and are CLAMPED on ingest
     *      against Base's own instruction ledger, so a mirror is trusted for
     *      timing only, never for magnitude (see
     *      {LibVpfiRecycle-recordChainCommitRetirement}).
     * @param commitRetiredCumulative18  Σ of every actual decrement of that
     *        chain's outstanding recycled commitments (claims + releases).
     * @param commitReleasedCumulative18 The release-only subset — the half
     *        that restores availability.
     */
    function onChainReportReceived(
        uint32 sourceChainId,
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        uint256 recycledCumulative18,
        uint256 recycledForDay18,
        uint256 commitRetiredCumulative18,
        uint256 commitReleasedCumulative18
    ) external onlyRewardMessenger onlyCanonical {
        _ingestChainReport(
            sourceChainId,
            dayId,
            lenderNumeraire18,
            borrowerNumeraire18,
            recycledCumulative18,
            recycledForDay18,
            commitRetiredCumulative18,
            commitReleasedCumulative18
        );
    }

    /// @notice LEGACY ingress overload (pre-#1222 four-argument shape),
    ///         kept so Base's diamond cut and its messenger's proxy upgrade
    ///         need not land in one atomic batch (Codex #1413 r2): an
    ///         already-deployed messenger delivering in-flight legacy
    ///         reports keeps hitting a live selector through the rollout
    ///         window instead of reverting — a reverted delivery could let
    ///         the grace clock finalize that chain's day as zero. Forwards
    ///         zero recycled figures, which advance nothing in the ledger.
    function onChainReportReceived(
        uint32 sourceChainId,
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18
    ) external onlyRewardMessenger onlyCanonical {
        _ingestChainReport(
            sourceChainId,
            dayId,
            lenderNumeraire18,
            borrowerNumeraire18,
            0,
            0,
            0,
            0
        );
    }

    /// @notice #1222 M3 B2-d1 — accept a mirror's day-`D` commitment REPORT
    ///         (its per-side claimable-liability aggregate) for
    ///         `(dayId, sourceChainId)`.
    /// @dev Messenger-authenticated + canonical-only, mirroring
    ///      {onChainReportReceived}. Sets `chainDayCommitments[..].complete`
    ///      and stores the per-side liabilities the B2-d2 remittance gate +
    ///      clamp read. Arriving AFTER `finalizeDay(dayId)` is the NORMAL
    ///      sequence — the mirror can only price its liability from the day's
    ///      caps + funding stamp, which that finalize computes and
    ///      {broadcastGlobal} delivers — so there is deliberately no
    ///      finalization-ordering guard here (contrast
    ///      {_ingestChainReport}'s `ReportAfterFinalization`, whose interest
    ///      figures feed the denominator that finalize fixes). A report for a
    ///      day whose interest contribution was zeroed is also accepted and
    ///      stored — though note it prices at that chain's deliberately-zero
    ///      funding stamp, so the operator reconciliation for a zeroed chain
    ///      sizes from the mirror's locally-readable state, not from this
    ///      figure (Codex #1425 r1). Idempotent on CCIP re-delivery (the
    ///      mirror sends once — `commitmentReportSent`).
    function onCommitmentReportReceived(
        uint32 sourceChainId,
        uint256 dayId,
        uint256 liabilityLender18,
        uint256 liabilityBorrower18
    ) external onlyRewardMessenger onlyCanonical {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ChainDayCommitments storage c =
            s.chainDayCommitments[dayId][sourceChainId];
        // Membership is checked against the DAY's topology evidence, not only
        // the mutable current list (Codex #1425 r1): a chain removed from
        // `expectedSourceChainIds` after day `dayId` finalized must still be
        // able to land its historical report — `chainDailyIncluded` proves it
        // participated in the finalized denominator, and `remitIneligible`
        // proves it was expected-and-zeroed at an armed finalize.
        if (
            !_isExpectedChainId(s, sourceChainId)
                && !s.chainDailyIncluded[dayId][sourceChainId]
                && !c.remitIneligible
        ) {
            revert SourceChainIdNotExpected();
        }
        // Idempotent: a re-delivered copy of an already-accepted report no-ops
        // (never reverts — a benign CCIP re-execution must not fail).
        if (c.complete) return;
        c.complete = true;
        c.liabilityLender18 = liabilityLender18;
        c.liabilityBorrower18 = liabilityBorrower18;
        emit CommitmentReportAccepted(
            dayId, sourceChainId, liabilityLender18, liabilityBorrower18
        );
    }

    /// @dev Shared body of the three ingress overloads — gates run in the
    ///      external wrappers, the write path is identical. Older generations
    ///      forward zeros for the figures their wire shape cannot carry, and
    ///      every ledger below treats a zero as "nothing to advance".
    function _ingestChainReport(
        uint32 sourceChainId,
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        uint256 recycledCumulative18,
        uint256 recycledForDay18,
        uint256 commitRetiredCumulative18,
        uint256 commitReleasedCumulative18
    ) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        if (!_isExpectedChainId(s, sourceChainId)) revert SourceChainIdNotExpected();
        if (s.dailyGlobalFinalized[dayId]) revert ReportAfterFinalization();
        if (s.chainDailyReported[dayId][sourceChainId]) {
            revert ChainDayAlreadyReported();
        }

        s.chainDailyLenderInterestNumeraire18[dayId][sourceChainId] = lenderNumeraire18;
        s.chainDailyBorrowerInterestNumeraire18[dayId][sourceChainId] = borrowerNumeraire18;
        // #1222 M3 B1 — advance Base's per-chain recycled ledger (monotonic
        // availability + clamped day attribution) from the mirror's report.
        LibVpfiRecycle.recordChainRecycled(
            s, sourceChainId, dayId, recycledCumulative18, recycledForDay18
        );
        // #1222 M3 B3 — and the retirement half of the same report: retire
        // this chain's reservation ledger by what it has actually spent or
        // released, and give back availability for the released share (those
        // tokens never left its bucket). Clamped against Base's own
        // instruction cumulative inside the helper.
        LibVpfiRecycle.recordChainCommitRetirement(
            s,
            sourceChainId,
            commitRetiredCumulative18,
            commitReleasedCumulative18
        );
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
        // #1222 M3 B2-d1 — finalization does NOT wait for mirror commitment
        // reports (supersedes the B2-c readiness input). A mirror's day-`D`
        // liability is priced from the day-`D` per-side caps + funding stamp,
        // which exist only once THIS finalize computes them and
        // {broadcastGlobal} delivers them — a readiness gate on the report
        // would deadlock every armed day into the grace backstop. The plan's
        // "never remit from a partial set" rule is enforced where it is
        // causally possible instead: ShareOfPool remittance for a
        // `(day, chain)` waits for that chain's COMPLETE report
        // (`ChainDayCommitments.complete` — the B2-d2 remit gate; a late
        // report delays, never zeroes), and a chain whose INTEREST report was
        // zeroed out of the denominator is marked
        // remit-ineligible-pending-reconciliation in {_finalizeAndWrite}.
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
        // #1222 M3 B2-d1 (retargets the B2-c marking) — an armed-day finalize
        // that ZEROES a mirror's interest contribution (grace backstop or the
        // admin override closing over a missing report) marks that chain
        // remit-ineligible-pending-reconciliation: its ShareOfPool slice was
        // sized without its real demand, so its remittance for the day must
        // come from the operator path (evidenced, manual), never the
        // automatic one. Cleared via
        // {RewardCommitmentFacet.reconcileCommitmentRemitEligibility} — the
        // chain's late commitment report is still ACCEPTED post-finalize
        // ({onCommitmentReportReceived}), though it prices at the zeroed
        // chain's deliberately-zero funding stamp, so the operator sizes the
        // manual remit from the mirror's locally-readable state instead
        // (Codex #1425 r1). Chains whose
        // interest DID report are not marked: their commitment report simply
        // arrives after this finalize broadcasts the day's caps + stamp, and
        // the B2-d2 remit gate waits for it (delays, never zeroes). The
        // canonical chain is exempt (it is never remitted to).
        bool markIneligible = s.governorCommitArmedFromDay != 0
            && dayId >= s.governorCommitArmedFromDay;
        uint32 selfId = uint32(block.chainid);

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
                if (markIneligible && chainId != selfId) {
                    s.chainDayCommitments[dayId][chainId].remitIneligible = true;
                    // #1434 P2-w1 — FREEZE the R1 zeroed marker for the V3
                    // broadcast. The live `remitIneligible` flag is operator-
                    // clearable (reconciliation), so the wire reads this
                    // frozen copy instead: a reconcile between two sends of
                    // the same day must not change what the broadcast says
                    // (R2a re-broadcast determinism).
                    s.dayZeroedForDest[dayId][chainId] = true;
                    emit CommitmentRemitIneligible(dayId, chainId);
                }
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

        // #1434 P2-w1 — freeze the day's lapse clock ONCE, here, under the
        // schedule version current at this moment. Every V3 broadcast of
        // this day reads these frozen words back (never live state), so two
        // sends of the same finalized day are byte-identical by construction
        // (R2a). Version 0 (no schedule ever set) freezes a zero-parameter
        // clock: the day carries an authentic `finalizedAt` but is NOT
        // lapse-eligible — the w4 terminals gate on a nonzero frozen
        // version, so a zero window can never read as "lapse immediately".
        uint32 lapseVer = s.lapseScheduleCurrentVersion;
        LibVaipakam.LapseScheduleParams storage lapseParams =
            s.lapseSchedules[lapseVer];
        s.dayLapseClock[dayId] = LibVaipakam.DayLapseClock({
            finalizedAt: uint64(block.timestamp),
            scheduleVersion: lapseVer,
            lapseWindowSeconds: lapseParams.lapseWindowSeconds,
            dispatchCutoffGap: lapseParams.dispatchCutoffGap
        });

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
    /// @param freshDrawdown #1218 M5 — `netEmission[D]`: the schedule floor
    ///        actually drawn fresh, i.e. how much of the budgeted floor real
    ///        activity earned a claim on. Equal to what
    ///        {InteractionRewardsLensFacet.getRecycleDayMetrics} returns for
    ///        this day AT THE MOMENT OF EMISSION — same call, same inputs,
    ///        same block — and a test binds the two so a code change cannot
    ///        silently separate them.
    ///
    ///        It is NOT guaranteed equal to that getter forever, and an
    ///        earlier revision claimed "identical by construction", which was
    ///        too strong (Codex #1496 r1 P2). The getter RECOMPUTES from
    ///        `dayCapThreshold18`, and {setBroadcastDayCapThreshold} is a
    ///        second writer of that slot: a Diamond DEMOTED from the
    ///        canonical role which then receives its first V2 broadcast for a
    ///        day it had already finalized will have the threshold
    ///        overwritten while `dailyGlobalFinalized` stays true, so the
    ///        recomputation can move while this value cannot.
    ///
    ///        That asymmetry is a reason to prefer this field, not a caveat
    ///        against it: the event is the IMMUTABLE record of what the day
    ///        actually committed, and the recomputation is the thing that can
    ///        be perturbed afterwards. Where they disagree, this is the one
    ///        that was true when the day closed.
    ///
    ///        Subject to the five bounds documented on that getter: it is the
    ///        day's COMMITMENT, not its settled payout — **and only on an
    ///        ARMED day**. Read `armed` before using it.
    /// @param armed Whether this day RESERVED the figure above (Codex #1496
    ///        r2 P2). Before arming the calculation still runs and is still
    ///        published, but nothing commits it and legacy claims price from
    ///        the uncapped `halfPoolForDay` instead — so on an unarmed day
    ///        `freshDrawdown` is an ESTIMATE of what the day would have
    ///        committed, not a record of what it did.
    ///
    ///        Carried as a field rather than left to consumers to derive by
    ///        comparing `dayId` against the arming day, because deriving it
    ///        needs a second read and the whole point of this field set is
    ///        that a reader following the notices needs nothing else. An
    ///        event-only consumer that could not tell the two apart would
    ///        record estimates as immutable history — the exact
    ///        plausible-looking wrong number this surface exists to avoid.
    event GovernorDayPoolStamped(
        uint256 indexed dayId,
        uint256 scheduleFloor,
        uint256 recycledBudget,
        uint256 aBar,
        uint256 marginBps,
        uint256 freshDrawdown,
        bool armed
    );

    /// @notice #1222 M3 B2-a — a chain's funded recycled stamp for an armed
    ///         day (zeroes with `stamped == false` pre-cutover or for a
    ///         never-funded chain). `keeperAllocate` is always 0 — B2-b
    ///         landed and it is STILL always 0, because the per-chain
    ///         keeper allocation it reserves space for is #1569, which is
    ///         undecided. Both producers hard-zero it (`LibMeshFunding` and
    ///         this facet's own stamp). The old wording ("until B2-b")
    ///         implied the field would populate at a milestone that has
    ///         since passed.
    ///
    ///         It is READ, though — do not mistake "always 0" for "inert".
    ///         `_perDestFields` puts it in every V2/V3 per-destination
    ///         payload, {VaipakamRewardMessenger} forwards it, and
    ///         {RewardReporterFacet} stores it and REPLAY-COMPARES it: a
    ///         re-broadcast carrying a value that differs from the stored
    ///         one reverts `KnownGlobalAlreadySet()`. So whoever arms #1569
    ///         is changing a wire field under an equality check, not filling
    ///         in an unused slot. What is true is narrower than "unread":
    ///         no accounting or allocation logic acts on the value.
    function getChainDayRecycledFunding(uint256 dayId, uint32 chainId)
        external
        view
        returns (LibVaipakam.ChainDayFunding memory)
    {
        return LibVaipakam.storageSlot().chainDayRecycledFunding[dayId][chainId];
    }

    /// @notice #1222 M3 B2-a — a mirror chain's outstanding recycled
    ///         commitments (mirror-locally-funded slices reserved at
    ///         armed-day finalization). B3 made this RETIRE: it now equals
    ///         `instructed − retired` at every instant, in-flight broadcasts
    ///         included, instead of growing monotonically. Always 0 for Base
    ///         — its funded shares reserve into the global outstanding
    ///         ledger.
    function getChainOutstandingRecycledCommit(uint32 chainId)
        external
        view
        returns (uint256)
    {
        return LibVaipakam.storageSlot().chainOutstandingRecycledCommit[chainId];
    }

    /// @notice #1222 M3 B1 — Base's per-chain recycled ledger for `chainId`
    ///         (Base's own figures live under its chain id). Zeros on
    ///         mirrors and for never-reported chains.
    /// @dev    MOVED here from {ConfigFacet} in #1222 M3 B3: B3 gave
    ///         `availRecycled` a third input, which tipped that facet over
    ///         EIP-170, and this is where the rest of the per-chain mesh
    ///         ledger already reads from.
    /// @return reportedCumulative   Highest cumulative accepted from the
    ///                              chain (availability, monotonic).
    /// @return consumedCumulative   Cumulative Base has instructed the chain
    ///                              to consume (written from B2 on).
    /// @return availRecycled        What mesh funding/netting may draw
    ///                              against: `reported`, less the net claim
    ///                              draw `sat(consumed − released)`, less the
    ///                              MAINTAINED net repatriation slot — that
    ///                              one is decremented by a cancellation ACK,
    ///                              never derived from two gross cumulatives
    ///                              (§7 #6's operand note). Every subtraction
    ///                              SATURATES.
    /// formula-check:allow the addition form is named here only to forbid it.
    ///                              Never computed as
    ///                              `reported + released − consumed` (#1577):
    ///                              a reported cumulative is unbounded, so
    ///                              that addition overflows on a hostile
    ///                              report.
    ///                              #1222 M3 B3 added the release term (a
    ///                              commitment the chain forfeited/expired
    ///                              un-spent left its tokens in that chain's
    ///                              bucket) and routed this view and the
    ///                              funding pass through ONE helper, so the
    ///                              operator figure and the figure Base
    ///                              actually funds from cannot drift.
    /// @return attributedCumulative Σ of accepted per-day credits — the
    ///                              attribution clamp baseline; always
    ///                              `≤ reportedCumulative`.
    function getChainRecycledLedger(uint32 chainId)
        external
        view
        returns (
            uint256 reportedCumulative,
            uint256 consumedCumulative,
            uint256 availRecycled,
            uint256 attributedCumulative
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        reportedCumulative = s.chainReportedRecycled[chainId];
        consumedCumulative = s.chainConsumedRecycled[chainId];
        availRecycled = LibVpfiRecycle.mirrorAvailRecycled(s, chainId);
        attributedCumulative = s.chainAttributedRecycled[chainId];
    }

    /// @notice #1222 M4 C1 (#1567) — the surplus multiple `N` changed.
    ///         `0` means the flag is dark.
    event RecycleSurplusMultipleSet(uint16 multiple);

    /// @notice #1567 — `N` is bounded above so a fat-fingered value cannot
    ///         silently make the flag unreachable.
    error InvalidRecycleSurplusMultiple(uint16 multiple, uint16 maxAllowed);

    /// @notice #1567 — the surplus flag is a MIRROR concept; asking it about
    ///         the canonical chain is rejected rather than answered wrongly.
    error SurplusFlagNotForCanonicalChain(uint32 chainId);

    /**
     * @notice #1222 M4 C1 (#1567) — set the surplus-flag multiple `N`: a
     *         chain is flagged operator-visible once its recycled
     *         availability exceeds `N ×` its trailing average daily recycled
     *         budget.
     * @dev    ADMIN_ROLE-only (behind the 48h timelock like every bounded
     *         knob). Bounded `[0, RECYCLE_SURPLUS_MULTIPLE_MAX]`.
     *
     *         **`0` is DARK, not reset-to-default** — the deploy default and
     *         the `rewardClaimHorizonDays` sentinel shape, deliberately not
     *         the `setRecycleMarginBps` reset-to-default one. There is no
     *         safe universal `N`, and a flag that fires before an operator
     *         has chosen a threshold is noise that teaches people to ignore
     *         it.
     *
     *         Flagging only — **this moves nothing**. Disposition of a
     *         flagged surplus is C2 (#1568), where §3.6a requires it to be a
     *         deliberate, bounded, protocol-controlled disposal.
     *
     *         **`onlyCanonical` as well as ADMIN_ROLE** (Codex #1579 r2 P2).
     *         This facet's header states that every mutating method is
     *         Base-only, and the flag it configures reads a Base-side ledger.
     *         Without the gate an admin on a MIRROR deployment would get a
     *         successful call and a `RecycleSurplusMultipleSet` event while
     *         nothing observable changed — a false confirmation to governance
     *         or automation that the live flag had been configured, which is
     *         worse than a revert.
     *
     *         Lives here rather than in `ConfigFacet` for two reasons:
     *         `ConfigFacet` has ~557 bytes of EIP-170 headroom and this would
     *         risk it, and the house pattern already keeps a domain knob with
     *         its domain facet (`setInteractionCapVpfiPerEth` is in
     *         `InteractionRewardsFacet`, not `ConfigFacet`).
     * @param  newMultiple New `N`; `0` turns the flag off.
     */
    function setRecycleSurplusMultiple(uint16 newMultiple)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
        onlyCanonical
    {
        if (newMultiple > LibVaipakam.RECYCLE_SURPLUS_MULTIPLE_MAX) {
            revert InvalidRecycleSurplusMultiple(
                newMultiple,
                LibVaipakam.RECYCLE_SURPLUS_MULTIPLE_MAX
            );
        }
        LibVaipakam.storageSlot().recycleSurplusMultiple = newMultiple;
        emit RecycleSurplusMultipleSet(newMultiple);
    }

    /**
     * @notice #1222 M4 C1 (#1567) — a chain's surplus position over the
     *         trailing {LibVaipakam.RECYCLE_SURPLUS_WINDOW_DAYS}-day window
     *         ending at `throughDay`. Read-only; nothing moves.
     * @dev    Per chain, never global — a global figure would hide exactly
     *         the asymmetry this knob exists to surface (a quiet chain
     *         accumulating while a busy one runs lean).
     *
     *         `multiple` is returned so **DARK is directly readable**:
     *         `threshold == 0` alone cannot distinguish "the flag is off"
     *         from "this chain budgeted nothing across the whole window",
     *         which are opposite situations. `multiple == 0` is dark, full
     *         stop — and it saves a second call to learn the knob's value.
     *
     *         **The CANONICAL chain is REJECTED, not answered** (Codex #1579
     *         r1 P2). Two independent reasons, either sufficient:
     *
     *         - The number would be WRONG. `mirrorAvailRecycled` states in
     *           its own contract that Base is inert there — Base never
     *           instructs itself, so `chainConsumedRecycled[Base]` stays 0
     *           and the helper returns the LIFETIME `chainReportedRecycled`
     *           cumulative rather than live availability. Once Base has paid
     *           or reserved recycled rewards that overstates what it holds,
     *           and would keep the flag raised for funds already spent.
     *           Base's real position is its live fundable bucket net of
     *           global commitments and keeper earmarks — a different
     *           computation entirely.
     *         - The flag would be ACTIONLESS. It exists to surface
     *           repatriation candidates, and repatriation (C2/#1568) runs
     *           mirror→Base. Base cannot repatriate to itself, so a Base
     *           "surplus" names no possible disposition.
     *
     *         Base's own position is available through
     *         `getRecycleCompositionPosition` and the backing reads, which
     *         compute it correctly for the canonical chain.
     *
     *         **The guard reads `block.chainid`, NOT `s.baseChainId`** (Codex
     *         #1579 r2 P2 — the r1 fix used the latter and did not work).
     *         The reason recorded here was that `setBaseChainId` documented
     *         itself as **"Zero on Base"**, so `s.baseChainId` would never
     *         match the real chain id on the canonical Diamond. That
     *         justification was WRONG: both deploy scripts export
     *         `BASE_CHAIN_ID` unconditionally, so the canonical Diamond
     *         stores Base's own chain id and `s.baseChainId` WOULD match
     *         (#1641). The guard is right anyway, for the general reason
     *         `RewardReporterFacet` states: *"a chain's own identity is
     *         `block.chainid`, read directly."* Reading a
     *         governance-settable field to answer "am I Base?" is the wrong
     *         question whichever value it happens to hold — an admin write
     *         could then turn the guard off. "Is this me?" is exactly the
     *         question the guard needs to ask, and only `block.chainid`
     *         answers it unconditionally.
     *
     *         **`onlyCanonical` is a SECOND, different guard** (#1706). The
     *         `block.chainid` check above only refuses to report on the
     *         chain this Diamond is running on; it says nothing about
     *         whether this Diamond is the canonical one. The selector is cut
     *         into every deployment, so before #1706 a mirror could call
     *         this and read its own unpopulated copy of a ledger only Base
     *         writes — returning a well-formed position indistinguishable
     *         from a genuine zero, with no signal that it was meaningless. A
     *         silent wrong number is worse than a revert for anything
     *         reading this to make a decision, so a mirror now reverts
     *         {NotCanonicalRewardChain}.
     *
     *         The two guards are not redundant and neither subsumes the
     *         other: `onlyCanonical` answers "should this deployment be
     *         answering at all?", the `block.chainid` check answers "is the
     *         chain being asked about a mirror?". A caller needs both to be
     *         wrong in different ways before it gets a wrong answer.
     * @param  chainId    The MIRROR chain to inspect.
     * @param  throughDay Inclusive last day of the trailing window.
     */
    function getChainSurplusPosition(uint32 chainId, uint256 throughDay)
        external
        view
        onlyCanonical
        returns (
            uint256 availRecycled,
            uint256 avgDailyBudget,
            uint256 threshold,
            uint16 multiple,
            bool flagged
        )
    {
        if (chainId == block.chainid) {
            revert SurplusFlagNotForCanonicalChain(chainId);
        }
        return LibVpfiRecycle.chainSurplusPosition(
            LibVaipakam.storageSlot(),
            chainId,
            throughDay
        );
    }

    /// @notice #1222 M3 B1 — the accepted (clamped) recycled credit Base has
    ///         attributed to `(dayId, chainId)` — the mesh half of the
    ///         `credited[D]` feed that B2 folds into `Ā`. Moved here from
    ///         {ConfigFacet} alongside {getChainRecycledLedger}.
    /// @return credit   VPFI wei attributed (0 when unaccepted or clamped
    ///                  away).
    /// @return accepted True once the chain's report for the day was
    ///                  processed (distinguishes a genuine zero credit from
    ///                  "no report yet").
    function getChainDailyRecycledCredit(uint256 dayId, uint32 chainId)
        external
        view
        returns (uint256 credit, bool accepted)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        credit = s.chainDailyRecycledCredit[dayId][chainId];
        accepted = s.chainRecycledDayAccepted[dayId][chainId];
    }

    /// @notice #1222 M3 B3 — the commitment-retirement cumulatives Base has
    ///         accepted (and clamped) from `chainId`'s day-close reports.
    /// @return retiredCumulative  Everything that chain has retired from its
    ///                            outstanding recycled commitments — claims
    ///                            and releases together. Retires
    ///                            {getChainOutstandingRecycledCommit}.
    /// @return releasedCumulative The release-only subset (forfeit / RL-3
    ///                            expiry — the tokens stayed in that chain's
    ///                            bucket), which is added back to its
    ///                            availability. Always
    ///                            `≤ retiredCumulative`, and both are
    ///                            `≤ chainConsumedRecycled[chainId]`.
    function getChainRecycledCommitRetirement(uint32 chainId)
        external
        view
        returns (uint256 retiredCumulative, uint256 releasedCumulative)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        retiredCumulative = s.chainRetiredRecycledCommit[chainId];
        releasedCumulative = s.chainReleasedRecycledCommit[chainId];
    }

    /// @notice #1222 M3 B3 — THIS chain's own commitment-retirement
    ///         cumulatives, the pair its day-close report ships to Base.
    ///         Live on every chain (canonical and mirror); the operator
    ///         readback that proves a mirror's report matches its local
    ///         ledger.
    function getLocalRecycledCommitRetirement()
        external
        view
        returns (uint256 retiredCumulative, uint256 releasedCumulative)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        retiredCumulative = s.recycleCommitRetiredCumulative;
        releasedCumulative = s.recycleCommitReleasedCumulative;
    }

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
        // #1222 M3 B2-a — Ā's feed under the mesh: Base's own raw local
        // series (first-party, unclamped — exactly the pre-mesh feed) PLUS
        // the per-day MIRROR credit accumulator, which is written once at
        // report ACCEPTANCE (clamped, Base excluded) so the fold is O(1)
        // per day and a later `expectedSourceChainIds` edit can never
        // rewrite an already-accepted day (Codex #1414 r1).
        for (uint256 i; i < w; ) {
            if (dayId >= i) {
                uint256 d = dayId - i;
                credited += s.recycledCreditedByDay[d]
                    + s.dayMirrorRecycledCredit[d];
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
        // Net of outstanding recycled commitments AND the keeper earmark, so a
        // carved keeper share is never re-sized into a reward budget (#1344).
        uint256 fundable = _recycleFundable(s);
        uint256 coupled = (aBar * (10_000 - marginBps)) / 10_000;

        uint256 armedFrom = s.governorCommitArmedFromDay;
        bool armed = armedFrom != 0 && dayId >= armedFrom;

        // #1222 M3 B2-b — the Phase B′ two-pass funding resolution is LIVE
        // on armed days: global Ā sizes the TARGET, each chain's B1-ledger
        // availability bounds the reality, Base's own slice funds before
        // top-ups draw from its remaining fundable balance, and the day's
        // recycled budget is the funded Σ (identical to the Phase-A′
        // `min(fundable, coupled)` on a single-chain deploy). The resolver
        // stamps every chain's per-(day,chain) funding record and books
        // each mirror's locally-funded capped commit into
        // `chainConsumedRecycled[c]`; Base-funded shares are reserved into
        // the global ledger below. Pre-cutover days keep the Phase-A′
        // records-only stamp.
        uint256 recycledBudget;
        LibMeshFunding.FundingTotals memory totals;
        if (armed) {
            if (schedule != 0) {
                totals = LibMeshFunding.resolveAndStampDayFunding(
                    s, dayId, coupled, scheduleFloor / 2, fundable
                );
            }
            recycledBudget = totals.funded;
            // The mesh resolver legitimately skips its stamps when the day
            // has no coupled target / no demand / no configured chains —
            // but the flipped armed-day consumers HALT on an unstamped
            // own-chain record, so Base must guarantee its own stamp on
            // EVERY armed day (fresh floors only; recycled zeroes).
            _ensureBaseDayFundingStamp(s, dayId, scheduleFloor / 2);
        } else {
            recycledBudget = schedule == 0
                ? 0
                : (fundable < coupled ? fundable : coupled);
        }

        s.dayPoolStamp[dayId] = LibVaipakam.DayPoolStamp({
            scheduleFloor: uint128(scheduleFloor),
            recycledBudget: uint128(recycledBudget),
            aBarAtFinalize: uint128(aBar),
            marginBpsAtFinalize: uint16(marginBps),
            stamped: true
        });

        // #1351 (M2 PR-2, slice 2a → B2-b per-side) — stamp the armed day's
        // D1 per-(user,side) ceilings now that the funded composition is
        // known. Per-SIDE from B2-b: under per-chain funding the global
        // per-side pools genuinely differ, so each side's C prices against
        // its own pool (fresh floor half + that side's funded Σ). No-op
        // pre-cutover.
        LibInteractionRewards.snapshotDayUserSideShareCaps(
            dayId,
            scheduleFloor / 2,
            totals.fundedLender,
            totals.fundedBorrower
        );

        // Commitment reservation — armed only from the PR-3c cutover day.
        // Codex #1315 P1: reserve the CAPPED committable amounts, not the
        // raw stamp. B2-b splits the recycled reservation by FUNDING
        // SOURCE: the global ledger takes only the Base-funded shares
        // (Base's own slice + every top-up — Σ reservedBase from the
        // resolver, consumed at Base claims and at remit); each mirror's
        // locally-funded share was booked into `chainConsumedRecycled[c]`
        // by the resolver above. The fresh reservation is unchanged
        // (recycledHalf = 0 cannot alter commitFresh: armed days carry
        // `t = max`, so no combined-cap trim couples the sides).
        // #1218 M5 — computed UNCONDITIONALLY so the stamp event can carry
        // it. Hoisting it out of the `if (armed)` guard is behaviour-neutral:
        // `committableForDay` is a pure view, and the guard below still gates
        // the only state writes. The cost is one view call on an unarmed
        // day's once-daily finalize.
        //
        // Why it belongs in the EVENT rather than being read back later: six
        // of the seven §9 transparency figures are already derivable from the
        // event stream (`VpfiRecycled` carries `dayId`, `ChainRecycledReported`
        // carries the per-(chain,day) accepted credit), and this was the only
        // one that was not — while also being the headline figure,
        // `netEmission[D]`. Leaving it out forced the indexer either to make a
        // contract read during ingest, which would end its property of being a
        // pure function of the event stream, or to fan out reads at query
        // time. Two fields remove both — `freshDrawdown` and the `armed`
        // flag that says whether it is a commitment or an estimate.
        //
        // Scoped precisely: this makes the per-DAY series event-derivable.
        // `platformRetained` is a cumulative position read from
        // {InteractionRewardsLensFacet.getRecycleBackingSnapshot}, not a
        // per-day flow, and no event carries it.
        //
        // CUTOVER, stated because the obvious claim is too strong (Codex
        // #1496 r1 P2): widening the event changes its topic, so days
        // finalized BEFORE this upgrade were announced under the old
        // signature and cannot supply this field. The event stream therefore
        // carries the series from the upgrade FORWARD, not for all history.
        // Pre-cutover days are covered by
        // {InteractionRewardsLensFacet.getRecycleDayMetrics}, which
        // recomputes them on demand — the two surfaces are complementary by
        // design, and a one-time backfill (if a deployment ever wants the
        // older days in its series) is a read over that getter, needing no
        // event at all.
        (uint256 commitFresh, ) = LibInteractionRewards.committableForDay(
            s, dayId, scheduleFloor / 2, 0
        );
        if (armed) {
            s.outstandingCommitFresh += commitFresh;
            s.outstandingCommitRecycled += totals.reservedBase;
        }

        emit GovernorDayPoolStamped(
            dayId,
            scheduleFloor,
            recycledBudget,
            aBar,
            marginBps,
            commitFresh,
            armed
        );

        _applyRecycleRegister(s, dayId, aBar, marginBps);
    }

    /// @dev #1222 M3 B2-b — Base's own per-(day,chain) funding stamp must
    ///      exist on EVERY armed day: the flipped armed-day consumers
    ///      (`_dayPoolHalves`) fail closed on an unstamped own-chain
    ///      record, and the mesh resolver legitimately skips stamping on
    ///      days with no coupled target / no demand / no configured
    ///      chains. Idempotent — a resolver-written stamp is left intact.
    function _ensureBaseDayFundingStamp(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        uint256 freshHalf
    ) private {
        uint32 baseId = uint32(block.chainid);
        LibVaipakam.ChainDayFunding storage f =
            s.chainDayRecycledFunding[dayId][baseId];
        if (f.stamped) return;
        f.stamped = true;
        // Codex #1417 r2 P1 — inclusion gate applies to Base's own stamp
        // too: a grace/force-finalized day that zeroed Base's report must
        // not let Base-side claims accrue fresh halves either.
        if (s.chainDailyIncluded[dayId][baseId]) {
            f.freshLenderHalf = freshHalf;
            f.freshBorrowerHalf = freshHalf;
        }
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
    ///      structurally) AND the standing keeper earmark, and the forward
    ///      reserve keeps at least one trailing week of coupled budget in the
    ///      bucket for future days. The keeper share is EARMARKED within the
    ///      bucket (`recycleKeeperBudget`), not moved out of it: `recycleBucket`
    ///      stays the full Diamond-custody total so the audited backing
    ///      invariant (`balance >= recycleBucket`) keeps the keeper budget
    ///      backed. The enforcement points are worth naming exactly, because
    ///      this comment previously credited "the RL-3 claim gate" and that
    ///      was an OVERCLAIM (#1460): RL-3's cap is the expiry SWEEP's, and
    ///      the CLAIM path had no backing cap at all until #1460 added one.
    ///      The three real points are {LibVpfiRecycle.credit} /
    ///      {LibVpfiRecycle.creditCustodyRelocated} on inflow,
    ///      {InteractionRewardsFacet}'s `backingRoom` cap on the RL-3 expiry
    ///      sweep, and {RewardClaimFacet}'s fresh-component cap at claim
    ///      time — the earmark only removes it from `fundable` so it
    ///      can't be re-lent to reward budgets, and the later spend stage
    ///      decrements both ledgers on transfer-out (Codex #1344 P1). Dormant
    ///      (`keeperBps == 0`, the deploy default) this is a no-op — exactly
    ///      today's ratified behaviour.
    function _applyRecycleRegister(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        uint256 aBar,
        uint256 marginBps
    ) internal {
        uint16 keeperBps = s.recycleRegisterKeeperBps;
        if (keeperBps == 0 || aBar == 0) return;

        uint256 marginRealized = (aBar * marginBps) / 10_000;
        uint256 fundable = _recycleFundable(s);
        uint256 forwardReserve =
            LibVaipakam.RECYCLE_FORWARD_RESERVE_DAYS * aBar;
        uint256 aboveReserve =
            fundable > forwardReserve ? fundable - forwardReserve : 0;
        uint256 splittable =
            marginRealized < aboveReserve ? marginRealized : aboveReserve;
        if (splittable == 0) return;

        uint256 keeperShare = (splittable * keeperBps) / 10_000;
        if (keeperShare == 0) return;
        // Earmark within the bucket — `recycleBucket` is unchanged (it stays
        // the full custody total that the backing checks reserve), only the
        // keeper-budget earmark grows. The reserve share never moves either.
        s.recycleKeeperBudget += keeperShare;
        emit RecycleRegisterSplit(dayId, splittable, keeperShare);
    }

    /// @dev RL-4 — recycled VPFI genuinely AVAILABLE for new recycled reward
    ///      budgets: the bucket net of outstanding recycled commitments AND
    ///      the standing keeper earmark. `recycleBucket` itself remains the
    ///      full Diamond-custody total (so `LibVpfiRecycle.credit` and the RL-3
    ///      claim gate keep the keeper budget backed); the earmark is netted
    ///      out HERE so a carved keeper share can never be re-lent to a reward
    ///      budget (Codex #1344 P1). Floored at zero.
    function _recycleFundable(
        LibVaipakam.Storage storage s
    ) internal view returns (uint256) {
        uint256 reserved =
            s.outstandingCommitRecycled + s.recycleKeeperBudget;
        return s.recycleBucket > reserved ? s.recycleBucket - reserved : 0;
    }

    /// @notice Governor PR-3b — read a finalized day's stamped pool
    ///         composition (transparency + #1218 metrics + PR-3c claim
    ///         math source).
    /// @param  dayId Day to read.
    /// @return stamped        True once the day finalized (stamp exists).
    /// @return scheduleFloor  Fresh half of the day's pool: the SCHEDULED
    ///                          figure, itself capped by the remaining 69M
    ///                          allowance (which is a spending ceiling, not a
    ///                          balance created at deploy). This is not the
    ///                          amount charged against that allowance — where
    ///                          activity earns less than the schedule, the
    ///                          charge is smaller, and may be zero. This
    ///                          getter does NOT expose the charge: read it as
    ///                          `freshDrawdown` from
    ///                          {InteractionRewardsLensFacet.getRecycleDayMetrics},
    ///                          or from the {GovernorDayPoolStamped} event.
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

    /**
     * @notice #1222 M3 B2-d5 — this chain's relocated-custody position: how
     *         much of the recycle bucket is Base-funded remit backing rather
     *         than first-time absorption, and the cumulative this chain
     *         actually REPORTS to Base with that netted out.
     * @dev    Operator/observability read for the invariant that matters:
     *         `reportedCumulative` must never include relocated custody, or
     *         Base's `_mirrorAvailable` (`reported` net of the claim and
     *         repatriation draws) would re-offer
     *         its own already-spent top-up as this mirror's local funding and
     *         the Ā attribution headroom would widen (design record §2f.2).
     *         On Base itself `custodyRelocated` stays 0 — nothing remits to
     *         the canonical chain.
     * @return custodyRelocated   Lifetime Σ of relocated-custody credits.
     * @return bucket             Live recycle-bucket balance (includes it).
     * @return reportedCumulative What the day-close reports (excludes it).
     */
    function getRecycleCustodyPosition()
        external
        view
        returns (
            uint256 custodyRelocated,
            uint256 bucket,
            uint256 reportedCumulative
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.recycleCustodyRelocatedCumulative,
            s.recycleBucket,
            LibVpfiRecycle.creditedCumulative(s)
        );
    }

    /**
     * @notice #1444 / #1446 — the two raw counters plus the two live flags an
     *         EXTERNAL checker needs
     *         to verify this chain's recycle-bucket accounting without
     *         trusting the accounting itself.
     * @dev    Every other recycled read exposes a value the library DERIVES.
     *         That is fine for reporting and useless for verification: if
     *         {LibVpfiRecycle.creditedCumulative} stopped netting relocated
     *         custody out, the reported figure and Base's accepted copy would
     *         inflate together and stay equal, so no comparison between them
     *         could see it (#1446). These three are stored slots, so a checker
     *         can RE-DERIVE the published figures and disagree.
     *
     *         Two invariants become checkable from view calls alone, both
     *         read at one pinned block alongside {getRecycleCustodyPosition}
     *         and {getGovernorCommitState}:
     *
     *         1. COMPOSITION — `creditedRaw + custodyRelocated <= bucket +
     *            paidOutRecycled + releasedRemitStranded`. Every credit lands in
     *            the bucket exactly once; a counter that advanced without one
     *            breaks it. Inequality, not equality: `consume` floors the
     *            bucket for bounded cap-trim dust, which only widens the
     *            right side. Checked in BOTH directions: the reverse
     *            (`bucket + paidOut + stranded <= claimed + slack`) is what
     *            catches an arrival crediting the bucket WITHOUT advancing
     *            the relocated cumulative, which makes the forward bound
     *            looser and leaves the derivation check agreeing with the
     *            chain. `accountingSeeded` distinguishes the one state where
     *            the reverse direction is legitimately unverifiable.
     *         2. DERIVATION — `reportedCumulative == max(creditedRaw,
     *            bucket + paidOutRecycled − custodyRelocated)`, i.e. the
     *            pre-upgrade floor with the B2-d5 exclusion applied. Catches
     *            the subtraction being dropped from the floor branch.
     *
     *         Also completes BUCKET COVERAGE (#1444): `bucket +
     *         releasedRemitStranded >= outstandingCommitRecycled` is a hard
     *         relation, where plain `bucket >= outstanding` had a legitimate
     *         canonical failure path.
     * @return creditedRaw           Stored `recycleCreditedCumulative` BEFORE
     *                               the derived pre-upgrade floor is applied.
     *                               Zero on a Diamond refreshed over live
     *                               pre-#1222 state until its first credit —
     *                               exactly the case the floor exists for, and
     *                               the reason the derived figure cannot serve
     *                               here.
     * @return releasedRemitStranded Σ VPFI a released remittance took out of
     *                               the bucket and did not return (the
     *                               `paidOutRecycled` reversal). NOT the
     *                               pre-clamp commitment restored — that
     *                               figure's residual never left the bucket.
     * @return accountingSeeded   Whether recycled accounting has ever run on
     *                           this chain. DERIVED, not the raw slot: the
     *                           flag is appended storage, so a Diamond
     *                           refreshed over state that ALREADY has
     *                           post-#1222 credits would read false forever
     *                           (no historical credit replays the setter) and
     *                           an under-credited composition there would be
     *                           downgraded to an advisory until the next
     *                           credit happened to run (#1448 r5). A non-zero
     *                           `recycleCreditedCumulative` proves the chain
     *                           was already seeded, so that is folded in.
     *
     *                           Deliberately NOT `custodyRelocated != 0`
     *                           (#1448 r6). A mirror with a pre-#1222 bucket
     *                           that took a relocation credit BEFORE this
     *                           change has a non-zero relocated cumulative
     *                           and a still-zero raw counter, because the old
     *                           `creditCustodyRelocated` advanced only the
     *                           former and never snapshotted the historical
     *                           floor. Treating that as proof of seeding
     *                           would turn the correct un-seeded advisory
     *                           into a false CRITICAL on valid upgrade state
     *                           — the opposite error to the one r5 fixed. Disambiguates `creditedRaw == 0`:
     *                           false means a Diamond refreshed over live
     *                           pre-#1222 state, where composition is
     *                           genuinely unverifiable; true means a chain
     *                           that has simply absorbed nothing, where a
     *                           bucket with no counter behind it IS a fault
     *                           (#1448 r4).
     * @return isCanonicalRewardChain Whether this Diamond currently acts as
     *                               the canonical reward chain. Published
     *                               with the figures because
     *                               `releaseRemitReservation` is
     *                               `onlyCanonical` but the role is a MUTABLE
     *                               admin setting: a Diamond can accrue the
     *                               stranded total as canonical and later be
     *                               switched to mirror mode without it being
     *                               cleared (Codex #1448 r1). A checker must
     *                               therefore apply the allowance only while
     *                               the role still holds, rather than assuming
     *                               a mirror's total is structurally zero.
     * @return releasedRemitResolved #1662 r2 — Σ of the LOCALLY-stranded
     *                               RECYCLED-provenance value that is no
     *                               longer in transit: returned to bucket
     *                               custody by a recovery settlement, OR
     *                               recorded as terminally LOST. The
     *                               stranded figure above deliberately does
     *                               NOT retire on either: it is monotone
     *                               history, and the composition relation
     *                               needs it un-netted as a destination
     *                               term. So a checker's coverage ALLOWANCE
     *                               — and only the allowance — must net
     *                               this out (`stranded - resolved`), or
     *                               the same VPFI backs reservations twice
     *                               forever, and terminally lost tokens go
     *                               on backing live reservations after
     *                               there is nothing left. Bounded on-chain
     *                               by the stranded figure. Excludes
     *                               IMPORTED old-era settlements, whose
     *                               stranding was never in this
     *                               deployment's cumulative.
     */
    function getRecycleCompositionPosition()
        external
        view
        returns (
            uint256 creditedRaw,
            uint256 releasedRemitStranded,
            bool accountingSeeded,
            bool isCanonicalRewardChain,
            uint256 releasedRemitResolved
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.recycleCreditedCumulative,
            s.recycleReleasedRemitStrandedCumulative,
            s.recycleAccountingSeeded || s.recycleCreditedCumulative != 0,
            s.isCanonicalRewardChain,
            // #1662 r3 — capped HERE, not at the write site: the stored
            // cumulative accrues uncapped so resolutions recorded before
            // the one-time stranded seed completes are not silently
            // discarded against a floor that does not exist yet.
            s.recycleReleasedRemitResolvedCumulative
                > s.recycleReleasedRemitStrandedCumulative
                ? s.recycleReleasedRemitStrandedCumulative
                : s.recycleReleasedRemitResolvedCumulative
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

        // #1434 P2-w1 — three-step send ladder: V3 (kind-10, the frozen
        // day-clock facts) → V2 (kind-5) → legacy (kind-2). Each step falls
        // through ONLY on an empty revert (= missing selector on an older
        // messenger proxy — the established capability probe); a reasoned
        // revert is a real failure and bubbles. A day finalized BEFORE this
        // upgrade has no frozen clock (`dayLapseClock[dayId].finalizedAt ==
        // 0`) and is broadcast on the V2 wire permanently: there is no
        // authentic finalization timestamp to send, and a zero-clock V3
        // would fail closed at the mirror ingress as a PERMANENTLY failed
        // CCIP message — the V2 fallback is what keeps pre-upgrade days
        // broadcastable at all.
        _broadcastDayV3(
            s,
            dayId,
            messenger,
            IRewardMessenger(messenger).getBroadcastDestinations()
        );
    }

    /// @notice B2-b (Codex #1417 r1) — quote the fee the PERMISSIONLESS
    ///         {broadcastGlobal} trigger will actually pay: assembles the
    ///         SAME per-destination V2 payloads as the send and quotes them
    ///         through the messenger, falling back to the legacy quote when
    ///         the messenger predates V2 (empty revert = missing selector)
    ///         — the exact mirror of the send-side shim, so the unchanged
    ///         public entry point stays quotable across the rollout window.
    function quoteBroadcastGlobal(uint256 dayId)
        external
        view
        returns (uint256 nativeFee)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.dailyGlobalFinalized[dayId]) revert DayNotReadyToFinalize();
        address messenger = s.rewardMessenger;
        if (messenger == address(0)) revert RewardMessengerNotSet();

        (
            IRewardMessenger.BroadcastV2Shared memory shared,
            IRewardMessenger.BroadcastV2PerDest[] memory perDest
        ) = _assembleDayV2(
            s, dayId, IRewardMessenger(messenger).getBroadcastDestinations()
        );
        // #1434 P2-w1 — quote the V3 shape iff the send path would send it:
        // the day carries a frozen clock AND the messenger has the V3
        // selector. The exact mirror of the send-side ladder, so the
        // permissionless trigger's quote can never price a different wire
        // generation than the send dispatches.
        if (s.dayLapseClock[dayId].finalizedAt != 0) {
            try IRewardMessenger(messenger).quoteBroadcastDayV3(
                shared, _dayExtras(s, dayId), _toV3PerDest(s, dayId, perDest)
            ) returns (uint256 f3) {
                return f3;
            } catch (bytes memory reason) {
                if (reason.length != 0) {
                    assembly ("memory-safe") {
                        revert(add(reason, 0x20), mload(reason))
                    }
                }
            }
        }
        try IRewardMessenger(messenger).quoteBroadcastDayV2(shared, perDest)
        returns (uint256 f) {
            return f;
        } catch (bytes memory reason) {
            if (reason.length != 0) {
                assembly ("memory-safe") {
                    revert(add(reason, 0x20), mload(reason))
                }
            }
        }
        // Pre-B2-b messenger: the send path will fall back to the legacy
        // kind-2 broadcast, so quote that shape.
        return IRewardMessenger(messenger).quoteBroadcastGlobal(
            dayId,
            s.dailyGlobalLenderInterestNumeraire18[dayId],
            s.dailyGlobalBorrowerInterestNumeraire18[dayId]
        );
    }

    /// @notice #1434 P2-w1 — the single-destination V3 heal: re-deliver day
    ///         `dayId`'s frozen clock facts (plus the full V2 figures) to
    ///         ONE destination. Permissionless and repeatable, exactly like
    ///         {broadcastGlobal} — the payload is assembled from the same
    ///         frozen state, so a re-send is byte-identical and the mirror
    ///         ingress is idempotent.
    /// @dev    Exists because {broadcastGlobal} enumerates the messenger's
    ///         CURRENT destination list: a mirror removed from that list
    ///         after its kind-5 apply could otherwise never receive its V3
    ///         clock backfill (design §1.1). Admission is day-scoped
    ///         historical standing — included in the day's finalized
    ///         denominator, or holding any chain-day commitments record
    ///         (complete report, remit-ineligible marking, or a reported
    ///         liability) — NOT current-list membership. A chain with
    ///         neither has no stake in the day and cannot be used to spray
    ///         arbitrary lanes. If the LANE itself is torn down, the
    ///         underlying CCIP messenger reverts — the operator
    ///         decommissioning boundary stated in the design.
    /// @param dayId       The finalized day to heal.
    /// @param destChainId The destination chain (uint32-bounded).
    function broadcastGlobalTo(
        uint256 dayId,
        uint256 destChainId
    ) external payable nonReentrant whenNotPaused onlyCanonical {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.dailyGlobalFinalized[dayId]) revert DayNotReadyToFinalize();
        address messenger = s.rewardMessenger;
        if (messenger == address(0)) revert RewardMessengerNotSet();
        if (s.dayLapseClock[dayId].finalizedAt == 0) {
            revert DayHasNoLapseClock(dayId);
        }
        _assertDayStanding(s, dayId, destChainId);

        uint256[] memory one = new uint256[](1);
        one[0] = destChainId;
        (
            IRewardMessenger.BroadcastV2Shared memory shared,
            IRewardMessenger.BroadcastV2PerDest[] memory perDest
        ) = _assembleDayV2(s, dayId, one);

        try IRewardMessenger(messenger).broadcastDayV3Single{
            value: msg.value
        }(
            shared,
            _dayExtras(s, dayId),
            _toV3PerDest(s, dayId, perDest)[0],
            payable(msg.sender)
        ) returns (bytes32) {} catch (bytes memory reason) {
            if (reason.length != 0) {
                assembly ("memory-safe") {
                    revert(add(reason, 0x20), mload(reason))
                }
            }
            revert MessengerPredatesV3();
        }
    }

    /// @notice #1434 P2-w1 — quote the fee {broadcastGlobalTo} will pay.
    ///         Same admission checks as the send, so quoting a
    ///         non-admissible heal fails the same way the send would.
    function quoteBroadcastGlobalTo(
        uint256 dayId,
        uint256 destChainId
    ) external view returns (uint256 nativeFee) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.dailyGlobalFinalized[dayId]) revert DayNotReadyToFinalize();
        address messenger = s.rewardMessenger;
        if (messenger == address(0)) revert RewardMessengerNotSet();
        if (s.dayLapseClock[dayId].finalizedAt == 0) {
            revert DayHasNoLapseClock(dayId);
        }
        _assertDayStanding(s, dayId, destChainId);

        uint256[] memory one = new uint256[](1);
        one[0] = destChainId;
        (
            IRewardMessenger.BroadcastV2Shared memory shared,
            IRewardMessenger.BroadcastV2PerDest[] memory perDest
        ) = _assembleDayV2(s, dayId, one);

        try IRewardMessenger(messenger).quoteBroadcastDayV3Single(
            shared, _dayExtras(s, dayId), _toV3PerDest(s, dayId, perDest)[0]
        ) returns (uint256 f) {
            return f;
        } catch (bytes memory reason) {
            if (reason.length != 0) {
                assembly ("memory-safe") {
                    revert(add(reason, 0x20), mload(reason))
                }
            }
            revert MessengerPredatesV3();
        }
    }

    /// @dev #1434 P2-w1 — the heal's admission gate: day-scoped historical
    ///      standing. A destination wider than uint32 can hold no standing
    ///      (every per-chain ledger is keyed uint32), so it fails here too.
    ///      Own frame for viaIR stack headroom.
    function _assertDayStanding(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        uint256 destChainId
    ) private view {
        if (destChainId <= type(uint32).max && destChainId != block.chainid) {
            uint32 dest = uint32(destChainId);
            LibVaipakam.ChainDayCommitments storage c =
                s.chainDayCommitments[dayId][dest];
            // Codex #1632 r3 P1 — the FROZEN zeroed marker is part of the
            // standing predicate: `remitIneligible` is operator-clearable
            // (reconciliation), so a zeroed destination that was reconciled
            // and then removed from the destination list would otherwise
            // lose its heal eligibility — the exact chain the heal exists
            // for. The frozen copy never clears, so standing survives.
            if (
                s.chainDailyIncluded[dayId][dest] || c.complete
                    || c.remitIneligible || c.liabilityLender18 != 0
                    || c.liabilityBorrower18 != 0
                    || s.dayZeroedForDest[dayId][dest]
            ) {
                return;
            }
        }
        revert DestinationHasNoDayStanding(dayId, destChainId);
    }

    // #1434 P2-w1 — the versioned lapse-schedule setter and the day-clock
    // read views live in {RewardCommitmentFacet}, NOT here: this facet sits
    // ~500 bytes under the EIP-170 ceiling and the commitment facet (which
    // already owns the day-scoped reconciliation surface the frozen zeroed
    // marker exists to be compared against) has ~20KB of headroom.

    /// @dev B2-b — assemble the kind-5 per-destination broadcast: the
    ///      day-shared consensus fields once, each destination's OWN funded
    ///      figures from its finalize-time stamp. A destination the mesh
    ///      resolver skipped (unarmed day / no coupled target) gets the
    ///      global fresh floor halves and zeroed recycled fields — exactly
    ///      what the remit sizing assumes for it. Shared by the send AND
    ///      the facet-level quote so the two can never price different
    ///      payloads (Codex #1417 r1).
    function _assembleDayV2(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        uint256[] memory dests
    )
        private
        view
        returns (
            IRewardMessenger.BroadcastV2Shared memory shared,
            IRewardMessenger.BroadcastV2PerDest[] memory perDest
        )
    {
        uint256 armedFrom = s.governorCommitArmedFromDay;
        bool armed = armedFrom != 0 && dayId >= armedFrom;
        shared = IRewardMessenger.BroadcastV2Shared({
            dayId: dayId,
            globalLenderNumeraire18: s.dailyGlobalLenderInterestNumeraire18[
                dayId
            ],
            globalBorrowerNumeraire18: s
                .dailyGlobalBorrowerInterestNumeraire18[dayId],
            capMode: armed
                ? uint8(LibVaipakam.CapMode.ShareOfPool)
                : uint8(LibVaipakam.CapMode.LegacyEthRatio),
            // ShareOfPool: the per-SIDE D1 ceilings (global figures, Base-
            // computed). Legacy: the §4 threshold rides the lender slot.
            capPayloadLender: armed
                ? s.dayUserSideCapLenderVpfi18[dayId]
                : s.dayCapThreshold18[dayId],
            capPayloadBorrower: armed
                ? s.dayUserSideCapBorrowerVpfi18[dayId]
                : 0,
            armedFromDay: armedFrom
        });

        uint256 n = dests.length;
        perDest = new IRewardMessenger.BroadcastV2PerDest[](n);
        uint256 floorHalf = uint256(s.dayPoolStamp[dayId].scheduleFloor) / 2;
        for (uint256 i; i < n; ++i) {
            perDest[i] = _perDestFields(s, dayId, dests[i], floorHalf);
        }
    }

    /// @dev B2-b — build + send the kind-5 per-destination broadcast.
    function _broadcastDayV2(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        address messenger,
        uint256[] memory dests
    ) private {
        (
            IRewardMessenger.BroadcastV2Shared memory shared,
            IRewardMessenger.BroadcastV2PerDest[] memory perDest
        ) = _assembleDayV2(s, dayId, dests);

        try IRewardMessenger(messenger).broadcastDayV2{value: msg.value}(
            shared, perDest, payable(msg.sender)
        ) {} catch (bytes memory reason) {
            // Empty revert = missing selector on a pre-B2-b messenger
            // proxy → legacy kind-2 fallback (the failed call returned
            // the full msg.value, so the legacy send re-forwards it).
            // Reasoned reverts (fee shortfall, destination-set mismatch)
            // are real failures and bubble.
            if (reason.length != 0) {
                assembly ("memory-safe") {
                    revert(add(reason, 0x20), mload(reason))
                }
            }
            _broadcastLegacy(s, dayId, messenger);
        }
    }

    /// @dev #1434 P2-w1 — the V3 ladder head: assemble the SAME V2 fields
    ///      the kind-5 wire would carry, append the day's frozen clock facts,
    ///      and try the kind-10 send; fall through to {_broadcastDayV2} on
    ///      an empty revert (pre-V3 messenger proxy — the established
    ///      missing-selector probe; the failed call returned the full
    ///      msg.value, so the V2 send re-forwards it) or when the day has no
    ///      frozen clock (finalized before this upgrade — see
    ///      {broadcastGlobal}). Reasoned reverts bubble.
    function _broadcastDayV3(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        address messenger,
        uint256[] memory dests
    ) private {
        if (s.dayLapseClock[dayId].finalizedAt == 0) {
            _broadcastDayV2(s, dayId, messenger, dests);
            return;
        }
        (
            IRewardMessenger.BroadcastV2Shared memory shared,
            IRewardMessenger.BroadcastV2PerDest[] memory perDest
        ) = _assembleDayV2(s, dayId, dests);

        try IRewardMessenger(messenger).broadcastDayV3{value: msg.value}(
            shared,
            _dayExtras(s, dayId),
            _toV3PerDest(s, dayId, perDest),
            payable(msg.sender)
        ) {} catch (bytes memory reason) {
            if (reason.length != 0) {
                assembly ("memory-safe") {
                    revert(add(reason, 0x20), mload(reason))
                }
            }
            _broadcastDayV2(s, dayId, messenger, dests);
        }
    }

    /// @dev #1434 P2-w1 — the day's frozen clock facts, read back verbatim
    ///      from the finalization-time freeze (never recomputed — R2a).
    ///      #1636 r2 — plus the day-level funded pool halves from the same
    ///      freeze (`dayPoolStamp`, written by finalize): the Δq quote
    ///      numerator, which a zeroed destination cannot derive from its
    ///      own deliberately-zero slice.
    function _dayExtras(
        LibVaipakam.Storage storage s,
        uint256 dayId
    ) private view returns (IRewardMessenger.BroadcastV3Extras memory) {
        LibVaipakam.DayLapseClock storage c = s.dayLapseClock[dayId];
        LibVaipakam.DayPoolStamp storage p = s.dayPoolStamp[dayId];
        return IRewardMessenger.BroadcastV3Extras({
            finalizedAt: c.finalizedAt,
            lapseScheduleVersion: c.scheduleVersion,
            lapseWindowSeconds: c.lapseWindowSeconds,
            dispatchCutoffGap: c.dispatchCutoffGap,
            dayScheduleFloorHalf: uint256(p.scheduleFloor) / 2,
            dayRecycledBudgetHalf: uint256(p.recycledBudget) / 2
        });
    }

    /// @dev #1434 P2-w1 — wrap the assembled V2 per-destination entries with
    ///      each destination's FROZEN zeroed marker (never the live
    ///      `remitIneligible`, which reconciliation can clear between two
    ///      sends of the same day).
    function _toV3PerDest(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        IRewardMessenger.BroadcastV2PerDest[] memory perDest
    ) private view returns (IRewardMessenger.BroadcastV3PerDest[] memory) {
        uint256 n = perDest.length;
        IRewardMessenger.BroadcastV3PerDest[] memory v3 =
            new IRewardMessenger.BroadcastV3PerDest[](n);
        for (uint256 i; i < n; ++i) {
            v3[i] = IRewardMessenger.BroadcastV3PerDest({
                base: perDest[i],
                zeroedForDest: s.dayZeroedForDest[dayId][
                    uint32(perDest[i].destChainId)
                ]
            });
        }
        return v3;
    }

    /// @dev One destination's V2 fields (own frame — viaIR stack headroom).
    function _perDestFields(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        uint256 destChainId,
        uint256 floorHalf
    ) private view returns (IRewardMessenger.BroadcastV2PerDest memory) {
        LibVaipakam.ChainDayFunding storage f =
            s.chainDayRecycledFunding[dayId][uint32(destChainId)];
        if (f.stamped) {
            return IRewardMessenger.BroadcastV2PerDest({
                destChainId: destChainId,
                freshLenderHalf: f.freshLenderHalf,
                freshBorrowerHalf: f.freshBorrowerHalf,
                recycledLenderHalfEquiv: f.lenderHalfEquiv,
                recycledBorrowerHalfEquiv: f.borrowerHalfEquiv,
                recycleConsume: f.recycleConsume,
                keeperAllocate: f.keeperAllocate
            });
        }
        // Codex #1417 r2 P1 — a destination excluded from the finalized
        // denominator (grace/force-finalized without its report) gets ZERO
        // halves: its numerators are not in the globals, so any nonzero
        // half would let its users accrue unremittable rewards.
        if (!s.chainDailyIncluded[dayId][uint32(destChainId)]) {
            floorHalf = 0;
        }
        return IRewardMessenger.BroadcastV2PerDest({
            destChainId: destChainId,
            freshLenderHalf: floorHalf,
            freshBorrowerHalf: floorHalf,
            recycledLenderHalfEquiv: 0,
            recycledBorrowerHalfEquiv: 0,
            recycleConsume: 0,
            keeperAllocate: 0
        });
    }

    /// @dev B2-b — the pre-V2 kind-2 send, kept as the fallback for a
    ///      not-yet-upgraded messenger proxy (rollout shim; remove with
    ///      the legacy wire).
    function _broadcastLegacy(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        address messenger
    ) private {
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

    /// @notice #1222 M3 B2-b — the armed day's per-SIDE D1 ceilings
    ///         (stamped at finalization from the GLOBAL funded figures,
    ///         broadcast verbatim to mirrors). Both zero pre-cutover.
    function getDayUserSideCaps(uint256 dayId)
        external
        view
        returns (uint256 lenderCap, uint256 borrowerCap)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.dayUserSideCapLenderVpfi18[dayId],
            s.dayUserSideCapBorrowerVpfi18[dayId]
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
            // #1222 M3 B2-d3 (Codex #1430 r1) — reject DUPLICATES. The
            // per-chain funding resolution reads each entry's demand
            // numerators and its `reported`-net-of-draws availability
            // independently, so a repeated id would double-count that
            // chain's target, self-fund its availability twice (booking
            // `2 × commitLocal` into the per-chain ledgers and breaking
            // SS7 #6's `sat(consumed − released) ≤ reported`), and clobber
            // the shared
            // `(day, chain)` funding stamp so the broadcast instructs only
            // one of the two reservations. There is no legitimate use for a
            // repeated source chain, so it is rejected at the only writer.
            for (uint256 j; j < i; ) {
                if (chainIds[j] == chainIds[i]) {
                    revert DuplicateExpectedChainId(chainIds[i]);
                }
                unchecked {
                    ++j;
                }
            }
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

        // #1222 M3 B2-d1 — readiness mirrors {finalizeDay} exactly, which has
        // NO commitment input (the day-`D` report is only computable from the
        // caps + stamp this finalize produces — see the comment there).
        bool fullCoverage = count >= nExpected && nExpected != 0;
        if (fullCoverage) return (true, 0);

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
