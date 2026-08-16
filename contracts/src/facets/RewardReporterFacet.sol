// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {
    IRewardMessenger,
    RewardBroadcastV2,
    RewardBroadcastV3
} from "../interfaces/IRewardMessenger.sol";

/// @dev #1434 P2-w2 — the remittance facet's compensation hook, reached
///      through the Diamond's own fallback (standard cross-facet call).
interface ICompensationDayHook {
    function onCompensationDayBroadcastArrived(
        uint256 dayId,
        address baseDeployment,
        bool zeroedForDest
    ) external;
}
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibVpfiRecycle} from "../libraries/LibVpfiRecycle.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @notice #1222 M3 B1 (Codex #1413 r3) — the pre-widening sender shape, the
///         `closeDay` fallback target when the bound messenger has not been
///         upgraded to the six-argument surface yet. Both messenger
///         generations expose it (the pre-#1222 build natively, the widened
///         build via its legacy overload).
interface IRewardMessengerLegacySend {
    function sendChainReport(
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        address payable refundAddress
    ) external payable;
}

/// @dev #1222 M3 B1 six-argument sender — the shape that preceded B3's
///      eight-word report. Declared separately (rather than reached through
///      {IRewardMessenger}, which now carries both) so the rollout shim in
///      {RewardReporterFacet-closeDay} can name each generation explicitly:
///      8 → 6 → 4, one fallback per messenger generation.
interface IRewardMessengerB1Send {
    function sendChainReport(
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        uint256 recycledCumulative18,
        uint256 recycledForDay18,
        address payable refundAddress
    ) external payable;
}

/**
 * @title RewardReporterFacet
 * @author Vaipakam Developer Team
 * @notice Every-chain half of the cross-chain reward accounting mesh
 *         described in docs/TokenomicsTechSpec.md §4a. Owns the mirror-
 *         side day-close emission AND the broadcast ingress that lets
 *         mirrors know the finalized global denominator for each day.
 *
 * @dev Runs on BOTH canonical (Base) and mirror Diamonds. Behaviour forks
 *      by `isCanonicalRewardChain`:
 *        - Base:   {closeDay} writes the local chain's `(lender, borrower)`
 *                  Numeraire18 pair directly into the aggregator sub-storage
 *                  keyed by `block.chainid`; no cross-chain message is
 *                  needed because Base is its own aggregator.
 *        - Mirror: {closeDay} forwards the pair via `IRewardMessenger.sendChainReport`
 *                  to the Base-side reward messenger, paying the CCIP
 *                  native fee out of `msg.value`. The messenger delivers
 *                  into `RewardAggregatorFacet.onChainReportReceived` on Base.
 *
 *      {onRewardBroadcastReceived} is the mirror-side trusted ingress
 *      handler: when Base finalizes day `D`, its messenger broadcasts the
 *      pair back and the mirror's messenger invokes this method, which
 *      populates `knownGlobal*InterestNumeraire18[D]` used by the §4 formula.
 *      Gated to `rewardMessenger` — no other address may write these values.
 *
 *      Admin surface configures the cross-chain wiring (messenger address,
 *      canonical Base chain id, canonical flag, grace window) under
 *      `ADMIN_ROLE`. Each setter is one-shot + replaceable.
 */
contract RewardReporterFacet is
    DiamondAccessControl,
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    /// @notice Default grace window applied when the admin has not set
    ///         `rewardGraceSeconds` — 4 hours for Phase 1. Admin may
    ///         widen or tighten per spec §4a via {setRewardGraceSeconds}.
    uint64 internal constant DEFAULT_REWARD_GRACE_SECONDS = 4 hours;

    /// @dev #1222 M3 B3 — the six figures one day-close report carries,
    ///      gathered once and threaded through the canonical write and the
    ///      mirror send as a memory struct rather than six stack slots
    ///      (viaIR headroom: {closeDay} also holds the day cursor, the
    ///      messenger address and the rollout shim's frames).
    ///
    ///      `lender` / `borrower` — this chain's day-`D` interest
    ///      numerators. `recycledCumulative18` / `recycledForDay18` — B1's
    ///      availability cumulative and `Ā` day-attribution pair.
    ///      `commitRetiredCumulative18` / `commitReleasedCumulative18` — B3's
    ///      commitment-retirement pair (see the design record).
    struct ReportFigures {
        uint256 lender;
        uint256 borrower;
        uint256 recycledCumulative18;
        uint256 recycledForDay18;
        uint256 commitRetiredCumulative18;
        uint256 commitReleasedCumulative18;
    }

    /// @notice Emitted when the local chain reports its day-`D` interest
    ///         totals — directly to aggregator storage on Base, or via
    ///         the messenger on a mirror.
    /// @param dayId                 Interaction day being reported.
    /// @param sourceChainId         EVM chain id of the source (local) chain.
    /// @param lenderNumeraire18           Local lender USD-18 interest on `dayId`.
    /// @param borrowerNumeraire18         Local borrower USD-18 interest on `dayId`.
    /// @param viaMessenger               False iff recorded directly (Base path).
    /// @custom:event-category informational/reward-transport
    event ChainInterestReported(
        uint256 indexed dayId,
        uint32 indexed sourceChainId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        bool viaMessenger
    );

    /// @notice Emitted when the mirror-side ingress writes the finalized
    ///         global denominator for `dayId`. On Base this event also
    ///         fires during {RewardAggregatorFacet.finalizeDay} via the
    ///         shared write path.
    /// @param dayId                 Day whose denominator landed.
    /// @param globalLenderNumeraire18     Finalized global lender denominator.
    /// @param globalBorrowerNumeraire18   Finalized global borrower denominator.
    /// @custom:event-category informational/reward-transport
    event KnownGlobalInterestSet(
        uint256 indexed dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18
    );

    /// @notice Emitted on any admin setter touching the cross-chain wiring.
    /// @custom:event-category informational/config
    event RewardReporterConfigUpdated(
        bytes32 indexed key,
        bytes32 oldValue,
        bytes32 newValue
    );

    // ─── Day-close emission (public, permissionless) ────────────────────────

    /**
     * @notice Snapshot this chain's local `(lender, borrower)` Numeraire18
     *         interest totals for `dayId` and publish them to the
     *         canonical aggregator.
     * @dev Permissionless — any address may close a day once it is fully
     *      elapsed. Idempotent per `dayId` via `chainReportSentAt`.
     *
     *      Behaviour by chain kind:
     *        - Canonical (Base): writes the pair directly into
     *          `chainDaily{Lender,Borrower}InterestNumeraire18[dayId][block.chainid]`
     *          and increments `chainDailyReportCount[dayId]`. No
     *          cross-chain fee required; any `msg.value` is refunded.
     *        - Mirror: forwards the pair via
     *          {IRewardMessenger.sendChainReport}. `msg.value` MUST cover the
     *          CCIP native fee; the messenger refunds leftover to the caller.
     *
     *      Reverts:
     *        - `RewardDayNotElapsed` if `dayId` ≥ `currentDay`.
     *        - `ChainDayAlreadyReported` if the local report already fired.
     *        - `RewardMessengerNotSet` / `BaseChainIdNotSet` on mirror chains that
     *          have not been wired yet.
     *
     *      Whenever the write is recorded into aggregator storage on the
     *      Base path, this facet updates `dailyFirstReportAt[dayId]` so
     *      the grace-window clock starts ticking.
     * @param dayId Day index (spec §4 emission schedule) to close.
     */
    function closeDay(
        uint256 dayId
    ) external payable nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        (uint256 today, bool active) = LibInteractionRewards.currentDayOrZero();
        // Only CLOSED (strictly past) days may be reported — the current
        // day is still accruing, reporting it would be lossy.
        if (!active || dayId >= today) revert RewardDayNotElapsed();
        if (s.chainReportSentAt[dayId] != 0) revert ChainDayAlreadyReported();
        // #1195 E3 (Pass-2) — reject a late self-report AFTER the day has been
        // finalized, matching the mirror ingress guard in `RewardAggregatorFacet`
        // (`onChainReportReceived`). Storing a post-finalization report is
        // payout-benign but poisons the `backfillDayInclusion` predicate and the
        // audit trail; the Base path must fail-loud like the mirror path.
        if (s.dailyGlobalFinalized[dayId]) revert ReportAfterFinalization();

        // Fold entry-driven deltas into `totalLenderInterestNumeraire18[dayId]` /
        // `totalBorrowerInterestNumeraire18[dayId]` before snapshotting so the
        // cross-chain numerator reflects every accrued loan-day, not just
        // the legacy per-day counters.
        LibInteractionRewards.advanceLenderThrough(dayId);
        LibInteractionRewards.advanceBorrowerThrough(dayId);

        uint256 lenderNumeraire18 = s.totalLenderInterestNumeraire18[dayId];
        uint256 borrowerNumeraire18 = s.totalBorrowerInterestNumeraire18[dayId];
        // #1222 M3 B1 — this chain's recycled figures ride the same day-close:
        // the MONOTONIC cumulative (Base's availability ledger self-heals from
        // it across missed reports) and the day-bucketed credit total for the
        // closing day (`Ā`'s per-day attribution). `dayId` is strictly past,
        // so its `recycledCreditedByDay` bucket is complete. Read through the
        // library helper so a diamond refreshed over live pre-#1222 state
        // reports its pre-upgrade absorption too (Codex #1413 r5).
        // #1222 M3 B3 — and this chain's commitment-RETIREMENT cumulatives
        // ride the same day-close, so Base can close its per-chain
        // reservation ledger and give back availability for commitments this
        // chain released un-spent (forfeit / RL-3 expiry leave the tokens in
        // the bucket). Both are monotonic; Base ratchets and clamps them.
        ReportFigures memory f = ReportFigures({
            lender: lenderNumeraire18,
            borrower: borrowerNumeraire18,
            recycledCumulative18: LibVpfiRecycle.creditedCumulative(s),
            recycledForDay18: s.recycledCreditedByDay[dayId],
            commitRetiredCumulative18: s.recycleCommitRetiredCumulative,
            commitReleasedCumulative18: s.recycleCommitReleasedCumulative
        });

        s.chainReportSentAt[dayId] = uint64(block.timestamp);

        if (s.isCanonicalRewardChain) {
            // Base writes directly — no cross-chain hop for its own numbers.
            uint32 chainId = uint32(block.chainid);
            _recordChainReportLocal(s, dayId, chainId, f);
            emit ChainInterestReported(
                dayId,
                chainId,
                lenderNumeraire18,
                borrowerNumeraire18,
                /* viaMessenger */ false
            );

            // Refund any stray msg.value — canonical path is fee-free.
            if (msg.value != 0) {
                (bool ok, ) = msg.sender.call{value: msg.value}("");
                require(ok, "refund failed");
            }
        } else {
            address messenger = s.rewardMessenger;
            if (messenger == address(0)) revert RewardMessengerNotSet();
            if (s.baseChainId == 0) revert BaseChainIdNotSet();

            emit ChainInterestReported(
                dayId,
                uint32(block.chainid),
                lenderNumeraire18,
                borrowerNumeraire18,
                /* viaMessenger */ true
            );

            // Forward full msg.value; messenger refunds the caller directly.
            _dispatchChainReport(messenger, dayId, f);
        }
    }

    /**
     * @dev Mirror-side send with the generation-fallback rollout shim.
     *
     *      Codex #1413 r3 — an upgraded mirror diamond in front of a
     *      not-yet-upgraded messenger falls back a generation at a time
     *      (#1222 M3 B3: 8-word → 6-word → legacy 4-word), so the
     *      permissionless day-close never reverts through an upgrade window;
     *      the fields the older messenger cannot carry simply don't travel,
     *      and Base's ledger treats their absence as "nothing to advance".
     *
     *      Codex r4 P1 — a fallback fires ONLY on the missing-selector shape
     *      (an older messenger has no receive path for the unknown selector
     *      and reverts with EMPTY data). Every reasoned failure — paused,
     *      InsufficientFee from a caller who quoted an older shape — bubbles
     *      unchanged, because downgrading a current messenger's real failure
     *      would permanently strip that day's extra fields
     *      (`chainReportSentAt` blocks a resend).
     */
    function _dispatchChainReport(
        address messenger,
        uint256 dayId,
        ReportFigures memory f
    ) private {
        try IRewardMessenger(messenger).sendChainReport{value: msg.value}(
            dayId,
            f.lender,
            f.borrower,
            f.recycledCumulative18,
            f.recycledForDay18,
            f.commitRetiredCumulative18,
            f.commitReleasedCumulative18,
            payable(msg.sender)
        ) {} catch (bytes memory reason) {
            _bubbleUnlessMissingSelector(reason);
            // A failed attempt returned its full value; the fallback
            // re-forwards it.
            try IRewardMessengerB1Send(messenger).sendChainReport{
                value: msg.value
            }(
                dayId,
                f.lender,
                f.borrower,
                f.recycledCumulative18,
                f.recycledForDay18,
                payable(msg.sender)
            ) {} catch (bytes memory b1Reason) {
                _bubbleUnlessMissingSelector(b1Reason);
                IRewardMessengerLegacySend(messenger).sendChainReport{
                    value: msg.value
                }(dayId, f.lender, f.borrower, payable(msg.sender));
            }
        }
    }

    /// @dev Re-throws `reason` verbatim unless it is the empty revert an
    ///      older messenger returns for an unknown selector — the ONLY shape
    ///      that may downgrade a generation (see {_dispatchChainReport}).
    function _bubbleUnlessMissingSelector(bytes memory reason) private pure {
        if (reason.length != 0) {
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
    }

    /// @dev Shared write path for Base-side "my own chain's report"
    ///      and for the aggregator's cross-chain-ingress record hook.
    ///      NOT public — the aggregator calls it through its own trusted
    ///      path. Left `internal` so RewardAggregatorFacet's sibling code
    ///      (same Diamond, same storage) can reuse it by re-implementing
    ///      the body — every facet compiles separately.
    function _recordChainReportLocal(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        uint32 sourceChainId,
        ReportFigures memory f
    ) internal {
        s.chainDailyLenderInterestNumeraire18[dayId][sourceChainId] = f.lender;
        s.chainDailyBorrowerInterestNumeraire18[dayId][sourceChainId] =
            f.borrower;
        // #1222 M3 B1 — Base records its OWN chain in the per-chain recycled
        // ledger through the same helper the mirror ingress uses, so both
        // paths write identically and B2/B3's netting sees one uniform ledger.
        LibVpfiRecycle.recordChainRecycled(
            s, sourceChainId, dayId, f.recycledCumulative18, f.recycledForDay18
        );
        // #1222 M3 B3 — and the retirement half of the same report, which
        // closes `chainOutstandingRecycledCommit[c]` and restores
        // availability for released commitments. Inert for Base's own chain
        // id (Base never instructs itself, so both clamps pin it to zero) —
        // recorded through the identical path purely so the two report
        // sources cannot diverge.
        LibVpfiRecycle.recordChainCommitRetirement(
            s,
            sourceChainId,
            f.commitRetiredCumulative18,
            f.commitReleasedCumulative18
        );
        if (!s.chainDailyReported[dayId][sourceChainId]) {
            s.chainDailyReported[dayId][sourceChainId] = true;
            unchecked {
                s.chainDailyReportCount[dayId] += 1;
            }
        }
        if (s.dailyFirstReportAt[dayId] == 0) {
            s.dailyFirstReportAt[dayId] = uint64(block.timestamp);
        }
    }

    // ─── Mirror-side trusted broadcast ingress ──────────────────────────────

    /**
     * @notice Trusted ingress: the messenger delivers Base's finalized global
     *         denominator for `dayId` and this function stamps it into
     *         `knownGlobal{Lender,Borrower}InterestNumeraire18` so local
     *         {LibInteractionRewards.claimForUserWindow} can use it.
     * @dev Gated to the Diamond's registered `rewardMessenger`. First call for
     *      `dayId` writes the pair; repeat calls must carry the SAME
     *      numbers (idempotent on match, revert `KnownGlobalAlreadySet`
     *      on divergence).
     *
     *      Works on Base too: {RewardAggregatorFacet.finalizeDay} funnels
     *      Base's own finalization through the same storage slot (via a
     *      direct write, not this function), so Base-side claims read
     *      the identical denominator without needing a CCIP message.
     * @param dayId                 Day being broadcast.
     * @param globalLenderNumeraire18     Finalized global lender denominator.
     * @param globalBorrowerNumeraire18   Finalized global borrower denominator.
     */
    function onRewardBroadcastReceived(
        uint256 dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18,
        uint256 capThreshold18,
        uint256 scheduleFloorHalf,
        uint256 recycledHalf,
        uint256 armedFromDay
    ) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.rewardMessenger || s.rewardMessenger == address(0)) {
            revert NotAuthorizedRewardMessenger();
        }

        if (s.knownGlobalSet[dayId]) {
            // Idempotent re-delivery is fine — CCIP retries can
            // duplicate a packet. Divergent values must never overwrite.
            // #1008 (S13) — `capThreshold18` is part of the broadcast's
            // consensus value, so a divergent-threshold replay reverts too
            // (Codex #1147 r7 K6). PR-3c — the composition halves join the
            // consensus tuple for the same reason.
            LibVaipakam.DayPoolStamp storage prior = s.dayPoolStamp[dayId];
            if (
                s.knownGlobalLenderInterestNumeraire18[dayId] != globalLenderNumeraire18 ||
                s.knownGlobalBorrowerInterestNumeraire18[dayId] != globalBorrowerNumeraire18 ||
                s.dayCapThreshold18[dayId] != capThreshold18 ||
                (prior.stamped &&
                    (uint256(prior.scheduleFloor) != scheduleFloorHalf * 2 ||
                        uint256(prior.recycledBudget) != recycledHalf * 2))
            ) {
                revert KnownGlobalAlreadySet();
            }
            return;
        }

        // #1632 r2 — same rotation retirement as the kind-5 wire: a fresh
        // kind-2 write after an era rotation could install a retired era's
        // consensus pair, which would then wedge the day against the new
        // era's V3 (mixed-generation comparison). Replays above stay
        // idempotent.
        if (s.rewardEraRotated) revert LegacyBroadcastRetired(dayId);

        s.knownGlobalLenderInterestNumeraire18[dayId] = globalLenderNumeraire18;
        s.knownGlobalBorrowerInterestNumeraire18[dayId] = globalBorrowerNumeraire18;
        // #1008 (S13) — store the CANONICAL threshold from Base; mirrors never
        // recompute locally, so Base + every mirror cap identically.
        LibInteractionRewards.setBroadcastDayCapThreshold(dayId, capThreshold18);
        // Governor PR-3c (#1217 §6/§8) — store the Base-stamped day-pool
        // composition verbatim so the mirror's dual accumulators price the
        // IDENTICAL dailyPool (never recomputed locally; margin/Ā stay 0 —
        // they are Base-side transparency fields). The arming day travels
        // in-band too, so mirrors arm on the same D* with zero operator
        // drift (a mirror only ever moves it forward from unset).
        s.dayPoolStamp[dayId] = LibVaipakam.DayPoolStamp({
            scheduleFloor: SafeCast.toUint128(scheduleFloorHalf * 2),
            recycledBudget: SafeCast.toUint128(recycledHalf * 2),
            aBarAtFinalize: 0,
            marginBpsAtFinalize: 0,
            stamped: true
        });
        if (armedFromDay != 0 && s.governorCommitArmedFromDay == 0) {
            s.governorCommitArmedFromDay = armedFromDay;
        }
        s.knownGlobalSet[dayId] = true;

        emit KnownGlobalInterestSet(
            dayId,
            globalLenderNumeraire18,
            globalBorrowerNumeraire18
        );
    }

    /// @notice #1222 M3 B2-b — a V2 broadcast was applied on this mirror:
    ///         the consensus pair + cap family landed, the chain's own
    ///         funded stamp was written, and the local recycle bucket
    ///         surrendered its instructed slice (consume-on-arrival).
    /// @custom:event-category informational/reward-governor
    event RewardBroadcastV2Applied(
        uint256 indexed dayId,
        uint256 recycleConsume
    );

    /**
     * @notice #1222 M3 B2-b — trusted ingress for the per-destination V2
     *         broadcast: Base's finalized consensus fields plus THIS
     *         chain's own funded figures for `dayId`.
     * @dev Messenger-gated. Applies, in order:
     *
     *      1. Replay-stable binding — the packet's embedded `destChainId`
     *         must equal `block.chainid` (a delayed delivery after a
     *         destination-list edit or a governance replay must never
     *         apply another chain's figures here).
     *      2. Whole-day idempotency — the first application sets
     *         `broadcastV2Applied[dayId]`; a re-delivered packet must
     *         match EVERY applied field (revert on divergence) and is
     *         otherwise a no-op, so the consume-on-arrival debit can
     *         never run twice.
     *      3. Consensus pair — written, or verified against a value a
     *         legacy kind-2 delivery already set (mixed-generation days).
     *      4. Cap family, atomic with the mode (#1351 2a pairing):
     *         ShareOfPool ⇒ legacy threshold disabled (max) + the
     *         per-side D1 ceilings, verbatim from Base; Legacy ⇒ the §4
     *         threshold verbatim.
     *      5. The chain's own `ChainDayFunding` stamp — what the armed-day
     *         accumulators price with. (`fundedLender`/`fundedBorrower`
     *         stay 0 here: they are Base-side records; the equivalent
     *         halves already encode the funded budgets exactly.)
     *      6. `armedFromDay` — forward-only, as in the legacy ingress.
     *      7. Consume-on-arrival — the local bucket surrenders
     *         `recycleConsume` exactly once, mirroring the
     *         `chainConsumedRecycled[c]` mark Base booked at finalization
     *         (same figure, both ledgers).
     */
    /// @dev #1222 M3 B2-d3 — reserve this day's instructed local recycled
    ///      commit AT MOST ONCE, tracked on its own flag
    ///      (`mirrorRecycleCommitReserved`) rather than on
    ///      `broadcastV2Applied`, so a day whose broadcast was applied by a
    ///      pre-d3 implementation can still have its reservation completed
    ///      by a later replay (Codex #1430 r4).
    function _reserveMirrorCommitOnce(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        uint256 amount
    ) private {
        if (amount == 0) return;
        if (s.mirrorRecycleCommitReserved[dayId]) return;
        s.mirrorRecycleCommitReserved[dayId] = true;
        LibVpfiRecycle.reserveMirrorCommit(dayId, amount);
    }

    function onRewardBroadcastV2Received(RewardBroadcastV2 calldata b)
        external
    {
        LibVaipakam.Storage storage s = _broadcastIngressGates(b.destChainId);
        _applyBroadcastV2Core(s, b, /* legacyWire */ true);
    }

    /// @dev #1434 P2-w1 — the trust + destination-binding gates shared by
    ///      the kind-5 and kind-10 ingresses (messenger-gated; the packet's
    ///      embedded `destChainId` must equal `block.chainid`).
    function _broadcastIngressGates(uint256 destChainId)
        private
        view
        returns (LibVaipakam.Storage storage s)
    {
        s = LibVaipakam.storageSlot();
        if (msg.sender != s.rewardMessenger || s.rewardMessenger == address(0))
        {
            revert NotAuthorizedRewardMessenger();
        }
        if (destChainId != block.chainid) {
            revert BroadcastDestinationMismatch(destChainId);
        }
    }

    /// @dev The ONE V2 apply/replay implementation (#1434 P2-w1 refactor —
    ///      body unchanged). The V3 ingress hands its nested `v2` struct
    ///      here verbatim, so the two wire generations can never apply the
    ///      shared fields differently. Takes `memory` because the V3 path
    ///      passes a struct member; the V2 external path pays one
    ///      calldata→memory copy for the privilege of there being exactly
    ///      one implementation.
    function _applyBroadcastV2Core(
        LibVaipakam.Storage storage s,
        RewardBroadcastV2 memory b,
        bool legacyWire
    ) private {
        uint32 selfId = uint32(block.chainid);
        if (s.broadcastV2Applied[b.dayId]) {
            // Codex #1430 r4 — complete a reservation a PRE-d3 application of
            // this same day missed (Base-first / non-atomic rollout: the old
            // receiver stored the stamp and set the applied flag without
            // reserving). Guarded by its own flag, so it can never
            // double-reserve on an ordinary replay.
            _reserveMirrorCommitOnce(s, b.dayId, b.recycleConsume);
            LibVaipakam.ChainDayFunding storage prior =
                s.chainDayRecycledFunding[b.dayId][selfId];
            if (
                s.knownGlobalLenderInterestNumeraire18[b.dayId]
                    != b.globalLenderNumeraire18
                    || s.knownGlobalBorrowerInterestNumeraire18[b.dayId]
                        != b.globalBorrowerNumeraire18
                    || !_capFamilyMatches(s, b)
                    || prior.freshLenderHalf != b.freshLenderHalf
                    || prior.freshBorrowerHalf != b.freshBorrowerHalf
                    || prior.lenderHalfEquiv != b.recycledLenderHalfEquiv
                    || prior.borrowerHalfEquiv != b.recycledBorrowerHalfEquiv
                    || prior.recycleConsume != b.recycleConsume
                    || prior.keeperAllocate != b.keeperAllocate
            ) {
                revert KnownGlobalAlreadySet();
            }
            return;
        }

        // #1632 r2 — after an era ROTATION, the identity-less kind-5 wire
        // refuses FRESH applies (see {LegacyBroadcastRetired}). Placed
        // AFTER the replay branch above, so already-applied days replay
        // idempotently forever. The V3 caller passes `legacyWire = false`:
        // it reaches this core only having authenticated its era against
        // the configured ground truth.
        if (legacyWire && s.rewardEraRotated) {
            revert LegacyBroadcastRetired(b.dayId);
        }

        // Mixed-generation same-day: a legacy kind-2 delivery may already
        // have set the consensus pair — this packet must agree, then its
        // V2-only records layer on top.
        if (s.knownGlobalSet[b.dayId]) {
            if (
                s.knownGlobalLenderInterestNumeraire18[b.dayId]
                    != b.globalLenderNumeraire18
                    || s.knownGlobalBorrowerInterestNumeraire18[b.dayId]
                        != b.globalBorrowerNumeraire18
            ) {
                revert KnownGlobalAlreadySet();
            }
        } else {
            s.knownGlobalLenderInterestNumeraire18[b.dayId] =
                b.globalLenderNumeraire18;
            s.knownGlobalBorrowerInterestNumeraire18[b.dayId] =
                b.globalBorrowerNumeraire18;
            s.knownGlobalSet[b.dayId] = true;
        }

        if (b.capMode == uint8(LibVaipakam.CapMode.ShareOfPool)) {
            LibInteractionRewards.setBroadcastDayCapThreshold(
                b.dayId, type(uint256).max
            );
            s.dayCapMode[b.dayId] = LibVaipakam.CapMode.ShareOfPool;
            s.dayUserSideCapLenderVpfi18[b.dayId] = b.capPayloadLender;
            s.dayUserSideCapBorrowerVpfi18[b.dayId] = b.capPayloadBorrower;
        } else {
            LibInteractionRewards.setBroadcastDayCapThreshold(
                b.dayId, b.capPayloadLender
            );
        }

        s.chainDayRecycledFunding[b.dayId][selfId] = LibVaipakam
            .ChainDayFunding({
            fundedLender: 0,
            fundedBorrower: 0,
            lenderHalfEquiv: b.recycledLenderHalfEquiv,
            borrowerHalfEquiv: b.recycledBorrowerHalfEquiv,
            recycleConsume: b.recycleConsume,
            keeperAllocate: b.keeperAllocate,
            stamped: true,
            freshLenderHalf: b.freshLenderHalf,
            freshBorrowerHalf: b.freshBorrowerHalf
        });

        if (b.armedFromDay != 0 && s.governorCommitArmedFromDay == 0) {
            s.governorCommitArmedFromDay = b.armedFromDay;
        }

        // #1222 M3 B2-d3 — arrival COMMITS (plan §M3: "broadcast *commits*;
        // bucket debited pro-rata at claim/remit"). The mirror encumbers the
        // recycled commit Base instructed it to fund from its own bucket —
        // the same figure Base booked into `chainConsumedRecycled[c]` at
        // finalization. Deliberately NOT a bucket debit: `consume` already
        // runs at every claim on this chain, so debiting here too would
        // charge the same tokens twice (design record §2e.1). Claims retire
        // this reservation, forfeits/expiries release it — the identical
        // lifecycle Base runs for its own commits. Runs exactly once per day
        // under the whole-day idempotency guard above.
        _reserveMirrorCommitOnce(s, b.dayId, b.recycleConsume);

        s.broadcastV2Applied[b.dayId] = true;

        // #1632 r2 — PROVENANCE: an ARMED mirror stamps the era it is
        // configured for at apply time, so a later V3 for this day can
        // only backfill or verify against the era that actually delivered
        // its figures (the identity-less kind-5 wire cannot carry this
        // itself; the ceremony rule that arming precedes any rotation is
        // what makes the stamp truthful, and the rotation gate above
        // closes the wire once that stops holding). On the V3 path this
        // pre-stamp is overwritten by {_installDayClock} with the packet's
        // own — already-authenticated — identity, the same value.
        if (
            s.baseRewardDeployment != address(0)
                && s.dayClockEra[b.dayId] == address(0)
        ) {
            s.dayClockEra[b.dayId] = s.baseRewardDeployment;
        }

        emit RewardBroadcastV2Applied(b.dayId, b.recycleConsume);
        emit KnownGlobalInterestSet(
            b.dayId,
            b.globalLenderNumeraire18,
            b.globalBorrowerNumeraire18
        );
    }

    /// @dev Idempotent-re-delivery comparison for the cap family (mode-
    ///      dependent fields).
    function _capFamilyMatches(
        LibVaipakam.Storage storage s,
        RewardBroadcastV2 memory b
    ) private view returns (bool) {
        if (b.capMode == uint8(LibVaipakam.CapMode.ShareOfPool)) {
            return s.dayCapMode[b.dayId] == LibVaipakam.CapMode.ShareOfPool
                && s.dayUserSideCapLenderVpfi18[b.dayId] == b.capPayloadLender
                && s.dayUserSideCapBorrowerVpfi18[b.dayId]
                    == b.capPayloadBorrower;
        }
        return s.dayCapThreshold18[b.dayId] == b.capPayloadLender;
    }

    // ─── #1434 P2-w1 — V3 (kind-10) ingress: the frozen day clock ───────────

    /// @notice #1434 P2-w1 — this day's frozen lapse clock was installed
    ///         from an authenticated V3 broadcast. `backfilled` marks the
    ///         migration branch (clock added to a day whose figures were
    ///         applied via kind-5 before the upgrade) — the inventory signal
    ///         design §1.1's 12b gate asks for.
    /// @custom:event-category informational/reward-clock
    event DayClockInstalled(
        uint256 indexed dayId,
        uint64 finalizedAt,
        uint32 scheduleVersion,
        bool deliberatelyZeroed,
        address indexed era,
        bool backfilled
    );

    /**
     * @notice #1434 P2-w1 — trusted ingress for the per-destination V3
     *         broadcast: the full kind-5 semantics plus the day's FROZEN
     *         lapse-clock facts. Applies, in order:
     *
     *      1. The shared trust + destination-binding gates (as kind-5).
     *      2. Fail-closed clock presence — a zero `finalizedAt` is rejected
     *         (an honest Base broadcasts clockless pre-upgrade days on the
     *         V2 wire instead), so the packet stays a failed, re-executable
     *         CCIP message rather than installing a meaningless clock.
     *      3. Era binding (§2h constraint 20), TWO layers (Codex #1632 r1):
     *         the packet's `baseDeployment` must equal the mirror's
     *         CONFIGURED current Base deployment ({setBaseRewardDeployment}
     *         — the explicit ground truth; fail-closed while unset, since
     *         the per-day record cannot defend a day's FIRST install), and
     *         must match the day's recorded era where one exists: a delayed
     *         broadcast from a retired Base deployment must never install
     *         its clock, schedule or zeroed marker into the new era, where
     *         a new-era compensation could combine with it.
     *      4. CLOCK BACKFILL (the 12b migration branch) — an already-applied
     *         day with no clock verifies day identity, destination, era and
     *         the immutable global pair ONLY, then writes ONLY the V3
     *         fields. It deliberately does NOT compare the halves or
     *         inclusion-derived fields (`backfillDayInclusion` legitimately
     *         mutates a destination's halves after the first send, so a full
     *         V2-field comparison would make the one supported migration
     *         sequence unhealable) and never re-applies them — adding the
     *         clock is the branch's only write.
     *      5. Otherwise the shared V2 core runs (fresh apply, or the full
     *         replay-divergence check), then the clock is installed
     *         first-time or verified: a re-delivered packet must match every
     *         frozen clock fact (finalizedAt, schedule version, inline
     *         parameters, zeroed marker). `armedFromDay` stays OUTSIDE the
     *         comparison, exactly as on the V2 path (first-apply-only).
     */
    function onRewardBroadcastV3Received(RewardBroadcastV3 calldata b)
        external
    {
        LibVaipakam.Storage storage s =
            _broadcastIngressGates(b.v2.destChainId);
        uint256 dayId = b.v2.dayId;
        if (b.finalizedAt == 0) revert BroadcastClockMissing(dayId);
        // Codex #1632 r1 P1 — the era ground truth is the CONFIGURED
        // current Base deployment, not the packet: the per-day record
        // below cannot defend the FIRST install (nothing is recorded
        // yet, and the CCIP lane authenticates the shared remote
        // messenger, not the Diamond generation behind it), so without
        // this gate a retired deployment's in-flight packet after a Base
        // rotation would win the race and poison the day's era
        // permanently. Fail-closed while unarmed: a V3 to a mirror whose
        // operator has not set {setBaseRewardDeployment} stays a failed,
        // re-executable CCIP message.
        address expectedEra = s.baseRewardDeployment;
        if (expectedEra == address(0) || b.baseDeployment != expectedEra) {
            revert BroadcastEraUnauthenticated(
                dayId, expectedEra, b.baseDeployment
            );
        }
        // The per-day RECORD still binds a day to the era that installed
        // its clock: after a rotation bumps the config, a day recorded
        // under the previous era rejects new-era re-deliveries (the
        // drain/heal ceremony owns cross-era days, not silent overwrite).
        address era = s.dayClockEra[dayId];
        if (era != address(0) && era != b.baseDeployment) {
            revert BroadcastEraMismatch(dayId, era, b.baseDeployment);
        }
        // Codex #1632 r3 P1 — a ROTATED mirror refuses to attach V3 clock
        // facts to any day with PRIOR state but UNKNOWN era provenance
        // (`dayClockEra == 0`): days applied before arming (kind-5) or
        // seeded by a pre-arming kind-2 pair predate the provenance stamp,
        // and after a rotation the mirror can no longer tell WHICH era
        // supplied their figures — stamping the new era onto them is the
        // cross-era combination this whole gate family exists to prevent.
        // On a NEVER-rotated mirror the same days heal freely: with a
        // single era in the mirror's entire history there is nothing to
        // confuse them with (the live-migration case). Rotated-away
        // era-unknown days belong to the drain/heal ceremony — heal them
        // BEFORE rotating (CcipCutoverRunbook §8).
        if (
            s.rewardEraRotated && era == address(0)
                && (s.broadcastV2Applied[dayId] || s.knownGlobalSet[dayId])
        ) {
            revert BroadcastEraMismatch(dayId, address(0), b.baseDeployment);
        }

        if (
            s.broadcastV2Applied[dayId]
                && s.dayLapseClock[dayId].finalizedAt == 0
        ) {
            // Clock backfill — immutable pair only (see natspec item 4).
            if (
                !s.knownGlobalSet[dayId]
                    || s.knownGlobalLenderInterestNumeraire18[dayId]
                        != b.v2.globalLenderNumeraire18
                    || s.knownGlobalBorrowerInterestNumeraire18[dayId]
                        != b.v2.globalBorrowerNumeraire18
            ) {
                revert KnownGlobalAlreadySet();
            }
            // Codex #1632 r1 P1 — the pre-d3 reservation repair the V2
            // replay path performs must survive this branch: a day applied
            // by a PRE-d3 receiver has `broadcastV2Applied` set without its
            // reservation, and returning early here would leave the heal
            // looking complete while the mirror stays under-reserved
            // against the local share Base already booked and netted.
            // Idempotent (its own flag), and it reserves the STORED applied
            // figure — never the packet's halves, which this branch
            // deliberately does not trust (`backfillDayInclusion` may have
            // mutated them on Base after the original send).
            _reserveMirrorCommitOnce(
                s,
                dayId,
                s.chainDayRecycledFunding[dayId][uint32(block.chainid)]
                    .recycleConsume
            );
            // #1636 r2 — the day-pool stamp backfills alongside the clock
            // (a pre-r2 V3 day has neither; both are finalize-frozen facts
            // healed by the same re-send).
            _installDayPoolStampV3(s, b);
            _installDayClock(s, b, /* backfilled */ true);
            _notifyCompensationHook(b);
            return;
        }

        _applyBroadcastV2Core(s, b.v2, /* legacyWire */ false);
        // #1636 r2 — install (or verify) the day-level funded pool stamp
        // from the V3 packet. The V2 core deliberately does not write it
        // (the V2 wire never carried the day-level figure — only per-chain
        // slices, which are ZERO for a zeroed dest), yet Δq's numerator
        // and the quote surface's stamp gate both need it mirror-side; the
        // legacy kind-2 ingress that used to install it retires at
        // rotation. Runs on replays too, so any pre-r2 V3 day heals by a
        // permissionless re-send.
        _installDayPoolStampV3(s, b);

        LibVaipakam.DayLapseClock storage c = s.dayLapseClock[dayId];
        if (c.finalizedAt == 0) {
            _installDayClock(s, b, /* backfilled */ false);
        } else if (
            c.finalizedAt != b.finalizedAt
                || c.scheduleVersion != b.lapseScheduleVersion
                || c.lapseWindowSeconds != b.lapseWindowSeconds
                || c.dispatchCutoffGap != b.dispatchCutoffGap
                || s.dayDeliberatelyZeroed[dayId] != b.zeroedForDest
        ) {
            revert BroadcastClockDivergence(dayId);
        }
        _notifyCompensationHook(b);
    }

    /// @dev #1434 P2-w2 — every ACCEPTED clock-bearing broadcast settles
    ///      any PROVISIONAL compensation the day holds (§2.2 case b): the
    ///      packet's authenticated era + zeroed marker are exactly the two
    ///      facts the provisional credit assumed. Routed through the
    ///      Diamond's own fallback (the standard cross-facet path) to the
    ///      remittance facet's self-gated hook; a no-op for days without a
    ///      provisional credit.
    function _notifyCompensationHook(RewardBroadcastV3 calldata b) private {
        ICompensationDayHook(address(this)).onCompensationDayBroadcastArrived(
            b.v2.dayId, b.baseDeployment, b.zeroedForDest
        );
    }

    /// @dev #1636 r2 — install (first V3 for the day) or VERIFY (replay /
    ///      mixed-generation) the day-level funded pool stamp from the V3
    ///      packet's day-pool words. Divergence joins the broadcast
    ///      consensus family (`KnownGlobalAlreadySet`), matching the
    ///      legacy kind-2 ingress's own stamp-divergence rule. Stored
    ///      doubled, read halved — byte-compatible with every existing
    ///      `dayPoolStamp` consumer (the kind-2 write at
    ///      {onRewardBroadcastReceived} uses the identical convention).
    function _installDayPoolStampV3(
        LibVaipakam.Storage storage s,
        RewardBroadcastV3 calldata b
    ) private {
        LibVaipakam.DayPoolStamp storage p = s.dayPoolStamp[b.v2.dayId];
        if (p.stamped) {
            if (
                uint256(p.scheduleFloor) != b.dayScheduleFloorHalf * 2
                    || uint256(p.recycledBudget) != b.dayRecycledBudgetHalf * 2
            ) {
                revert KnownGlobalAlreadySet();
            }
            return;
        }
        s.dayPoolStamp[b.v2.dayId] = LibVaipakam.DayPoolStamp({
            scheduleFloor: SafeCast.toUint128(b.dayScheduleFloorHalf * 2),
            recycledBudget: SafeCast.toUint128(b.dayRecycledBudgetHalf * 2),
            aBarAtFinalize: 0,
            marginBpsAtFinalize: 0,
            stamped: true
        });
    }

    /// @dev The V3 fields' writer: the packed clock, the era record, and
    ///      this destination's zeroed marker — atomically, so a day can
    ///      never hold a clock without its era (the compensation ingress
    ///      that w2 adds keys its remitter check on the era). One other
    ///      site touches `dayClockEra` alone: the shared apply core's
    ///      provenance PRE-stamp on an armed mirror (#1632 r2), which this
    ///      function overwrites with the packet's own authenticated
    ///      identity — the same value by construction (the configured-era
    ///      gate admitted the packet).
    function _installDayClock(
        LibVaipakam.Storage storage s,
        RewardBroadcastV3 calldata b,
        bool backfilled
    ) private {
        uint256 dayId = b.v2.dayId;
        s.dayLapseClock[dayId] = LibVaipakam.DayLapseClock({
            finalizedAt: b.finalizedAt,
            scheduleVersion: b.lapseScheduleVersion,
            lapseWindowSeconds: b.lapseWindowSeconds,
            dispatchCutoffGap: b.dispatchCutoffGap
        });
        s.dayClockEra[dayId] = b.baseDeployment;
        s.dayDeliberatelyZeroed[dayId] = b.zeroedForDest;
        emit DayClockInstalled(
            dayId,
            b.finalizedAt,
            b.lapseScheduleVersion,
            b.zeroedForDest,
            b.baseDeployment,
            backfilled
        );
    }

    /// @notice #1434 P2-w1 — the Base deployment that installed this day's
    ///         clock on this mirror (zero = no clock installed yet).
    function getDayClockEra(uint256 dayId) external view returns (address) {
        return LibVaipakam.storageSlot().dayClockEra[dayId];
    }

    /// @notice #1434 P2-w1 — whether the V3 broadcast marked this day
    ///         deliberately zeroed for THIS chain (R1: the chain's interest
    ///         was zeroed out of the day's finalized denominator).
    function getDayDeliberatelyZeroed(uint256 dayId)
        external
        view
        returns (bool)
    {
        return LibVaipakam.storageSlot().dayDeliberatelyZeroed[dayId];
    }

    /// @notice #1632 r1 — emitted when the mirror's era ground truth is
    ///         set or rotated.
    /// @custom:event-category informational/reward-clock
    event BaseRewardDeploymentSet(address baseDeployment);

    /// @notice Set (or rotate) the CURRENT Base deployment this mirror
    ///         accepts V3 clock facts from — the explicit era ground truth
    ///         (Codex #1632 r1: the per-day era record cannot defend the
    ///         FIRST install, and the CCIP lane authenticates the shared
    ///         messenger, not the Diamond generation behind it).
    /// @dev    ADMIN. Zero disables the V3 ingress entirely (fail-closed —
    ///         packets stay failed, re-executable CCIP messages until
    ///         re-armed). Rotation belongs to the same ceremony that
    ///         rotates the Base deployment; days whose clocks were
    ///         installed under the PREVIOUS era keep rejecting new-era
    ///         re-deliveries via their per-day record (drain/heal owns
    ///         cross-era days).
    function setBaseRewardDeployment(address baseDeployment)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (baseDeployment != address(0)) {
            // #1632 r2 — rotation detection against the last NONZERO era
            // (never the live config, so disarm/re-arm cannot smuggle a
            // rotation past it). A true rotation permanently retires the
            // LEGACY broadcast wires' fresh-apply paths: kind-5/kind-2
            // packets carry no deployment identity, so post-rotation a
            // retired era's delayed or re-executed delivery cannot be
            // told apart from a legitimate one — and the new era only
            // ever speaks V3.
            address last = s.rewardEraLastNonzero;
            if (last != address(0) && baseDeployment != last) {
                s.rewardEraRotated = true;
            }
            s.rewardEraLastNonzero = baseDeployment;
        }
        s.baseRewardDeployment = baseDeployment;
        emit BaseRewardDeploymentSet(baseDeployment);
    }

    /// @notice The configured era ground truth (0 = V3 ingress dark).
    function getBaseRewardDeployment() external view returns (address) {
        return LibVaipakam.storageSlot().baseRewardDeployment;
    }

    // ─── Admin ──────────────────────────────────────────────────────────────

    /// @notice Register (or rotate) the cross-chain messenger authorized to
    ///         deliver cross-chain reward messages on this Diamond.
    /// @dev ADMIN_ROLE-gated. Passing `address(0)` disables the messenger
    ///      ingress until a new one is wired.
    /// @param messenger VaipakamRewardMessenger proxy address on this chain.
    function setRewardMessenger(
        address messenger
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address old = s.rewardMessenger;
        s.rewardMessenger = messenger;
        emit RewardReporterConfigUpdated(
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes32("rewardMessenger"),
            bytes32(uint256(uint160(old))),
            bytes32(uint256(uint160(messenger)))
        );
    }

    // NOTE: there is no `setLocalChainId` — a chain's own identity is
    // `block.chainid`, read directly. T-068 dropped the old settable
    // `localEid`; its storage slot is retained as
    // `localEidLegacyDoNotUse` for layout stability.

    /// @notice Set the canonical (Base) reward chain's EVM chain id —
    ///         the destination for mirror-side chain reports. Zero on Base.
    /// @param chainId EVM chain id of the canonical reward chain.
    function setBaseChainId(
        uint32 chainId
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint32 old = s.baseChainId;
        s.baseChainId = chainId;
        emit RewardReporterConfigUpdated(
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes32("baseChainId"),
            bytes32(uint256(old)),
            bytes32(uint256(chainId))
        );
    }

    /// @notice Flip this Diamond's canonical-reward-chain flag.
    ///         Must be `true` on exactly one Diamond in the mesh (Base).
    /// @param on Canonical flag value.
    function setIsCanonicalRewardChain(
        bool on
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        bool old = s.isCanonicalRewardChain;
        s.isCanonicalRewardChain = on;
        // #1662 r9 — a FRESH canonical deployment uses per-receipt
        // attribution from inception, so mark it armed at watermark ZERO
        // (constraining nothing: receipt ids start at 1). Without this it
        // is indistinguishable from a legacy Diamond, and the maintained
        // full-facet refresh would later snapshot the THEN-current nonce —
        // permanently retiring every legitimate receipt created since
        // deployment. Gated on there being no receipts yet, so an existing
        // legacy Diamond re-asserting its canonical role is untouched and
        // still needs the refresh's explicit migration arming.
        if (on && !s.recoveryAttributionArmed && s.remitReservationNonce == 0)
        {
            s.recoveryAttributionArmed = true;
        }
        // Codex #1699 r9 P1 — RETIRE the delivered residual at every role
        // transition, in BOTH directions.
        //
        // This flag is mutable both ways, and the delivered-fresh bound is
        // mirror-scoped: `received - paid`. Scoping only at PAYOUT time leaves
        // the residual sitting in storage across a role change. A mirror with
        // 10 delivered and 4 paid carries 6; promoted to canonical, armed
        // claims ignore the bound AND deliberately skip the paid-ledger write,
        // so they can consume the very tokens that 6 was backing. Demote
        // again and the untouched counters offer the SAME 6 a second time —
        // unrelated custody funding a duplicate spend.
        //
        // Retiring by levelling paid up to received makes the residual zero
        // without falsifying either total's era meaning, and it is the safe
        // direction: a chain resumes with NO delivered headroom and earns it
        // back from the next remittance. Erring the other way would hand it
        // free allowance. Only on an ACTUAL transition, so a redundant
        // same-value call changes nothing.
        if (old != on) {
            uint256 received = s.rewardBudgetArmedFreshReceived;
            if (s.rewardBudgetArmedFreshPaid < received) {
                s.rewardBudgetArmedFreshPaid = received;
            }
        }
        emit RewardReporterConfigUpdated(
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes32("isCanonicalRewardChain"),
            bytes32(uint256(old ? 1 : 0)),
            bytes32(uint256(on ? 1 : 0))
        );
    }

    /// @notice #1434 P1-b (Codex #1699 r2) — the pre-P1-b paid-side history
    ///         was seeded on this mirror, arming the delivered-fresh bound
    ///         against funding that was already spent before the upgrade.
    /// @custom:event-category state-change/reward-compensation
    event ArmedFreshPaidSeeded(uint256 amount);

    /**
     * @notice #1434 P1-b (Codex #1699 r2) — ONE-SHOT migration seed for the
     *         delivered-fresh bound's PAID side on an in-place-upgraded
     *         mirror.
     * @dev    Why a seed and not a derivation. The bound is
     *         `received - paid`. On upgrade the received counter already
     *         holds deliveries for compensated and short-lapsed days — those
     *         states deliberately BYPASSED the old blanket mirror halt and
     *         were payable in the parent implementation — while the newly
     *         appended paid counter starts at zero. Unseeded, that
     *         already-spent funding reads as available and can be spent
     *         again.
     *
     *         An exact ON-CHAIN derivation does not exist, which is the
     *         deciding fact rather than a matter of taste.
     *         `DayCompensation.armedFreshCounted` records what a day ADDED TO
     *         THE RECEIVED side, not what was paid out of it; the paid figure
     *         lives in `userSideDayPaidVpfi[user][side][day]`, which cannot be
     *         summed on-chain over an unbounded user set. So the operator
     *         computes it off-chain from the indexed payout events and seeds
     *         it here, once.
     *
     *         Direction of error matters and is stated so an operator can
     *         choose deliberately: seeding LOW re-opens the double-spend this
     *         exists to close; seeding HIGH strands legitimate funding until
     *         further deliveries arrive (recoverable, and the conservative
     *         side). Prefer the high estimate when uncertain.
     *
     *         Fresh deploys need no seed — both counters start at zero — so
     *         this is only for chains carrying pre-P1-b history.
     * @param  amount Armed fresh already paid out before this upgrade.
     */
    function seedArmedFreshPaid(uint256 amount)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.armedFreshPaidSeeded) revert ArmedFreshPaidAlreadySeeded();
        s.armedFreshPaidSeeded = true;
        s.rewardBudgetArmedFreshPaid += amount;
        emit ArmedFreshPaidSeeded(amount);
    }

    /// @notice Adjust the grace window after the first chain report for
    ///         day `D` within which `finalizeDay(D)` may be called even
    ///         if not every expected mirror has reported.
    /// @param secondsValue Grace duration in seconds (default 4h when
    ///                     zero — see {DEFAULT_REWARD_GRACE_SECONDS}).
    function setRewardGraceSeconds(
        uint64 secondsValue
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        // Setter-range audit (2026-05-02): added bounds. Without
        // them, a compromised admin could set `secondsValue=0`
        // (collapsing grace to instant) or `type(uint64).max`
        // (effectively infinite grace, defeating the purpose).
        // Zero is rejected — operators wanting "library default"
        // can pass {LibVaipakam.REWARD_GRACE_MIN_SECONDS} explicitly.
        if (
            secondsValue < LibVaipakam.REWARD_GRACE_MIN_SECONDS ||
            secondsValue > LibVaipakam.REWARD_GRACE_MAX_SECONDS
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "rewardGraceSeconds",
                uint256(secondsValue),
                uint256(LibVaipakam.REWARD_GRACE_MIN_SECONDS),
                uint256(LibVaipakam.REWARD_GRACE_MAX_SECONDS)
            );
        }
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint64 old = s.rewardGraceSeconds;
        s.rewardGraceSeconds = secondsValue;
        emit RewardReporterConfigUpdated(
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes32("rewardGraceSeconds"),
            bytes32(uint256(old)),
            bytes32(uint256(secondsValue))
        );
    }

    /// @notice Single-field getter for the reward grace seconds. Added
    ///         for the protocol-console knob schema (per-knob single-
    ///         value getters).
    function getRewardGraceSeconds() external view returns (uint64) {
        return LibVaipakam.storageSlot().rewardGraceSeconds;
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    /// @notice Returns the local (this chain's) unreported totals on `dayId`.
    /// @param dayId Day being queried.
    /// @return lenderNumeraire18   Local lender USD-18 on `dayId`.
    /// @return borrowerNumeraire18 Local borrower USD-18 on `dayId`.
    function getLocalChainInterestNumeraire18(
        uint256 dayId
    ) external view returns (uint256 lenderNumeraire18, uint256 borrowerNumeraire18) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.totalLenderInterestNumeraire18[dayId],
            s.totalBorrowerInterestNumeraire18[dayId]
        );
    }

    /// @notice `block.timestamp` at which {closeDay} succeeded for `dayId`
    ///         on this chain (0 ⇒ not yet closed).
    function getChainReportSentAt(
        uint256 dayId
    ) external view returns (uint64) {
        return LibVaipakam.storageSlot().chainReportSentAt[dayId];
    }

    /// @notice Finalized global denominator pair known on this chain for
    ///         `dayId` (zero pair ⇒ not yet broadcast here).
    /// @return globalLenderNumeraire18   Finalized lender denominator on `dayId`.
    /// @return globalBorrowerNumeraire18 Finalized borrower denominator on `dayId`.
    /// @return isSet               True iff the pair was populated for `dayId`.
    function getKnownGlobalInterestNumeraire18(
        uint256 dayId
    )
        external
        view
        returns (
            uint256 globalLenderNumeraire18,
            uint256 globalBorrowerNumeraire18,
            bool isSet
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.knownGlobalLenderInterestNumeraire18[dayId],
            s.knownGlobalBorrowerInterestNumeraire18[dayId],
            s.knownGlobalSet[dayId]
        );
    }

    /// @notice Snapshot the cross-chain reward wiring in one call — for
    ///         deploy / ops dashboards.
    /// @return rewardMessenger              Registered reward messenger address.
    /// @return localChainId           This chain's EVM chain id.
    /// @return baseChainId            Canonical reward chain's EVM chain id.
    /// @return isCanonicalRewardChain  Canonical flag.
    /// @return rewardGraceSeconds      Grace window (0 ⇒ default 4h).
    function getRewardReporterConfig()
        external
        view
        returns (
            address rewardMessenger,
            uint32 localChainId,
            uint32 baseChainId,
            bool isCanonicalRewardChain,
            uint64 rewardGraceSeconds
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.rewardMessenger,
            uint32(block.chainid),
            s.baseChainId,
            s.isCanonicalRewardChain,
            s.rewardGraceSeconds == 0
                ? DEFAULT_REWARD_GRACE_SECONDS
                : s.rewardGraceSeconds
        );
    }
}
