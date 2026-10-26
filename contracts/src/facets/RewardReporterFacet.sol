// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable, LibPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {
    IRewardMessenger,
    RewardBroadcastV2,
    RewardBroadcastV3,
    ChainDayReport
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
import {LibRewardCustody} from "../libraries/LibRewardCustody.sol";
import {LibRewardDayReport} from "../libraries/LibRewardDayReport.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

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
 *      {onRewardBroadcastV3Received} is the mirror-side trusted ingress
 *      handler: when Base finalizes day `D`, its messenger broadcasts the
 *      day back and the mirror's messenger invokes this method, which
 *      populates `knownGlobal*InterestNumeraire18[D]` used by the §4 formula,
 *      the chain's own funded figures and the day's frozen clock. Gated to
 *      `rewardMessenger` — no other address may write these values.
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
    /// @notice The interest fold was advanced through `through` (or as far as one
    ///         call reaches): the two per-side frontiers after the call (#2277).
    event InterestFrontiersAdvanced(uint256 through, uint256 lenderFrontier, uint256 borrowerFrontier);

    /// @notice `closeDay(dayId)` refused: the interest fold has not reached the
    ///         day on at least one side, so its totals are not yet final. Catch
    ///         the fold up with {advanceInterestFrontiers} and retry (#2277).
    error ChainReportFrontierShort(uint256 dayId, uint256 lenderFrontier, uint256 borrowerFrontier);

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
     *      the grace-window clock starts ticking — when Base is on its own
     *      expected-source list, as it must be (`LibRewardDayReport`).
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
        // payout-benign but poisons the audit trail; the Base path must
        // fail-loud like the mirror path.
        if (s.dailyGlobalFinalized[dayId]) revert ReportAfterFinalization();

        // Fold entry-driven deltas into `totalLenderInterestNumeraire18[dayId]` /
        // `totalBorrowerInterestNumeraire18[dayId]` before snapshotting so the
        // cross-chain numerator reflects every accrued loan-day, not just
        // the legacy per-day counters.
        LibInteractionRewards.advanceLenderThrough(dayId);
        LibInteractionRewards.advanceBorrowerThrough(dayId);
        // #2277 — the fold must have REACHED the day before its totals are read.
        // Each advance is clamped at MAX_FRONTIER_ADVANCE_DAYS per call, so after
        // a gap wider than that the two slots below are still zero or partial;
        // stamping would ship a false report ONCE and the stamp would make it
        // irreversible. Refuse by name instead — the advance above rolls back
        // with the revert, and {advanceInterestFrontiers} catches the fold up
        // in bounded, permissionless calls until this passes.
        if (s.lenderFrontierDay < dayId || s.borrowerFrontierDay < dayId) {
            revert ChainReportFrontierShort(dayId, s.lenderFrontierDay, s.borrowerFrontierDay);
        }

        uint256 lenderNumeraire18 = s.totalLenderInterestNumeraire18[dayId];
        uint256 borrowerNumeraire18 = s.totalBorrowerInterestNumeraire18[dayId];
        // #1222 M3 B1 — this chain's recycled figures ride the same day-close:
        // the MONOTONIC cumulative (Base's availability ledger self-heals from
        // it across missed reports) and the day-bucketed credit total for the
        // closing day (`Ā`'s per-day attribution). `dayId` is strictly past,
        // so its `recycledCreditedByDay` bucket is complete.
        // #1222 M3 B3 — and this chain's commitment-RETIREMENT cumulatives
        // ride the same day-close, so Base can close its per-chain
        // reservation ledger and give back availability for commitments this
        // chain released un-spent (forfeit / RL-3 expiry leave the tokens in
        // the bucket). Both are monotonic; Base ratchets and clamps them.
        // #2620 — and the clock its day numbers count from, so Base can tell
        // whether this chain's day `dayId` is Base's day `dayId`.
        ChainDayReport memory report = ChainDayReport({
            dayId: dayId,
            lenderNumeraire18: lenderNumeraire18,
            borrowerNumeraire18: borrowerNumeraire18,
            recycledCumulative18: s.recycleCreditedCumulative,
            recycledForDay18: s.recycledCreditedByDay[dayId],
            commitRetiredCumulative18: s.recycleCommitRetiredCumulative,
            commitReleasedCumulative18: s.recycleCommitReleasedCumulative,
            custodyEra: s.custodyEraCurrent,
            rewardLaunchTimestamp: s.interactionLaunchTimestamp
        });

        s.chainReportSentAt[dayId] = uint64(block.timestamp);

        if (s.isCanonicalRewardChain) {
            // Base writes directly — no cross-chain hop for its own numbers.
            uint32 chainId = uint32(block.chainid);
            _recordChainReportLocal(s, chainId, report);
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

            // #2621 — ONE report shape, sent through whatever messenger the
            // Diamond holds as this transaction runs, to the Base this Diamond
            // names. The messenger refuses any other route, and a messenger
            // without this send reverts; either way the whole close reverts
            // with its day stamp, so a report is stamped sent only once it has
            // left for this Diamond's Base. The messenger refunds the caller.
            IRewardMessenger(messenger).sendChainReport{value: msg.value}(
                s.baseChainId, report, payable(msg.sender)
            );
        }
    }

    /// @notice Catch the interest fold up through a strictly-past day — permissionless
    ///         and resumable (#2277; the 3b-ii closure proof's frontier condition
    ///         relies on it too). Each call advances each side's frontier by at
    ///         most `MAX_FRONTIER_ADVANCE_DAYS`; repeat until both frontiers reach
    ///         `through`, after which {closeDay} passes for every day up to it.
    ///         Bounded to days that have elapsed, exactly as {closeDay} is: a
    ///         frontier run ahead of the clock would make the delta writer drop
    ///         the start and end of every loan registered afterwards — false
    ///         totals, false reports, false closure proofs.
    /// @return lenderFrontier   The lender-side frontier after this call.
    /// @return borrowerFrontier The borrower-side frontier after this call.
    function advanceInterestFrontiers(uint256 through)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 lenderFrontier, uint256 borrowerFrontier)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        (uint256 today, bool active) = LibInteractionRewards.currentDayOrZero();
        if (!active || through >= today) revert RewardDayNotElapsed();
        LibInteractionRewards.advanceLenderThrough(through);
        LibInteractionRewards.advanceBorrowerThrough(through);
        lenderFrontier = s.lenderFrontierDay;
        borrowerFrontier = s.borrowerFrontierDay;
        emit InterestFrontiersAdvanced(through, lenderFrontier, borrowerFrontier);
    }

    /// @notice The interest fold's two per-side frontiers: the last day whose
    ///         per-side total is final (#2277).
    function getInterestFrontiers() external view returns (uint256 lenderFrontier, uint256 borrowerFrontier) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (s.lenderFrontierDay, s.borrowerFrontierDay);
    }

    /// @dev Shared write path for Base-side "my own chain's report"
    ///      and for the aggregator's cross-chain-ingress record hook.
    ///      NOT public — the aggregator calls it through its own trusted
    ///      path. Left `internal` so RewardAggregatorFacet's sibling code
    ///      (same Diamond, same storage) can reuse it by re-implementing
    ///      the body — every facet compiles separately.
    function _recordChainReportLocal(
        LibVaipakam.Storage storage s,
        uint32 sourceChainId,
        ChainDayReport memory r
    ) internal {
        uint256 dayId = r.dayId;
        s.chainDailyLenderInterestNumeraire18[dayId][sourceChainId] = r.lenderNumeraire18;
        s.chainDailyBorrowerInterestNumeraire18[dayId][sourceChainId] =
            r.borrowerNumeraire18;
        // #1222 M3 B1 — Base records its OWN chain in the per-chain recycled
        // ledger through the same helper the mirror ingress uses, so both
        // paths write identically and B2/B3's netting sees one uniform ledger.
        LibVpfiRecycle.recordChainRecycled(
            s, sourceChainId, dayId, r.recycledCumulative18, r.recycledForDay18
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
            r.commitRetiredCumulative18,
            r.commitReleasedCumulative18
        );
        // The same bookkeeping a mirror's report gets: only a listed chain
        // starts the grace window (#2618 / #2613).
        LibRewardDayReport.markReported(s, dayId, sourceChainId);
    }

    // ─── Mirror-side trusted broadcast ingress ──────────────────────────────

    /// @notice #1222 M3 B2-b — a day's broadcast was applied on this mirror:
    ///         the consensus pair + cap family landed, the chain's own
    ///         funded stamp was written, the keeper earmark was applied and
    ///         the local recycle bucket RESERVED its instructed slice.
    ///         Arrival encumbers the slice, it does not spend it — `consume`
    ///         debits at claim/remit. Emitted once per day, in the same
    ///         transaction as the reservation (#1944: no older wire is left
    ///         that could apply a day without it).
    /// @custom:event-category informational/reward-governor
    event RewardBroadcastV2Applied(
        uint256 indexed dayId,
        uint256 recycleConsume
    );

    /// @dev #1434 P2-w1 — the broadcast ingress's trust + destination-binding
    ///      gates (messenger-gated; the packet's embedded `destChainId` must
    ///      equal `block.chainid`, so a delayed delivery after a
    ///      destination-list edit can never apply another chain's figures
    ///      here), plus the role gate (#1944: Mirror or Detached only).
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
        // #1944 — the day delivery gate binds by ROLE, from a mirror's first
        // day, with no arming latch to refuse a first day below the folds. So
        // a stamp may land only where the gate already binds (Mirror) or can
        // pay nothing fresh (Detached: zero delivered bound). An Unconfigured
        // chain prices unbounded and the canonical chain funds itself; a day
        // stamped there could be folded unproven and then re-held on becoming
        // a mirror, which the walk's re-derivation would halt on.
        LibVaipakam.RewardRole role = LibVaipakam.rewardRole(s);
        if (role == LibVaipakam.RewardRole.Unconfigured || role == LibVaipakam.RewardRole.Canonical) {
            revert BroadcastRoleRefused(uint8(role));
        }
    }

    /// @dev The apply/replay of the broadcast's nested V2 fields. Takes
    ///      `memory` because the caller passes a struct member.
    ///
    ///      Applies, in order:
    ///
    ///      1. Whole-day idempotency — the first application sets
    ///         `broadcastV2Applied[dayId]`; a re-delivered packet must match
    ///         EVERY applied field (revert on divergence) and is otherwise a
    ///         no-op, so the arrival-time RESERVATION can never run twice.
    ///      2. Consensus pair — written.
    ///      3. Cap family, atomic with the mode (#1351 2a pairing):
    ///         ShareOfPool ⇒ legacy threshold disabled (max) + the per-side
    ///         D1 ceilings, verbatim from Base; LegacyEthRatio ⇒ the §4
    ///         threshold verbatim.
    ///      4. The chain's own `ChainDayFunding` stamp — what the armed-day
    ///         accumulators price with. (`fundedLender`/`fundedBorrower`
    ///         stay 0 here: they are Base-side records; the equivalent
    ///         halves already encode the funded budgets exactly.)
    ///      5. The Base-authorized keeper earmark.
    ///      6. `armedFromDay` — forward-only from unset.
    ///      7. Reserve-on-arrival — the local bucket ENCUMBERS
    ///         `recycleConsume`, mirroring the `chainConsumedRecycled[c]`
    ///         mark Base booked at finalization (same figure, both ledgers).
    ///         Not a debit: the debit happens later, at claim/remit, and
    ///         doing both would charge the slice twice.
    function _applyBroadcastV2Core(
        LibVaipakam.Storage storage s,
        RewardBroadcastV2 memory b
    ) private {
        uint32 selfId = uint32(block.chainid);
        if (s.broadcastV2Applied[b.dayId]) {
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
            // #1944 — INSTALL `D*` ON REPLAY when this mirror has none.
            //
            // `broadcastGlobal` is permissionless (`onlyCanonical` tests the
            // CHAIN, not the caller), so a third party can apply a day here
            // while Base is still unarmed. `governorCommitArmedFromDay` is
            // ONE-SHOT, so if the replay returned before this install, the
            // post-arm rebroadcast of that same day would exit idempotently
            // and the mirror could not be armed through this path at all.
            // That is not a race a ceremony can close: every mitigation
            // depends on an unapplied day still existing when it is needed,
            // and a third party decides that.
            //
            // Safe HERE precisely because the divergence check above has
            // already passed: every frozen fact of this day matches what was
            // applied, so this is the same day rather than a conflicting one.
            // `armedFromDay` deliberately stays OUT of that comparison — an
            // unarmed-then-armed rebroadcast differs in exactly this field
            // and must not read as divergence — which is the property
            // `testV3ReplayArmedFromDayStaysOutsideComparison` pins.
            //
            // Still one-shot: the zero check means an already-armed mirror
            // ignores a later, different `D*`, so a replay can fill the hole
            // but can never re-choose the era. The caller has authenticated
            // the packet's era before reaching here. No event, matching the
            // main-path install below.
            if (b.armedFromDay != 0 && s.governorCommitArmedFromDay == 0) {
                s.governorCommitArmedFromDay = b.armedFromDay;
            }
            return;
        }
        // One writer per own-chain funding record (Codex #2879). On a mirror
        // only this apply stamps it; a record already stamped with no
        // broadcast applied was written by `finalizeDay` while this chain was
        // canonical, and that day was funded here. Overwriting it would price
        // the day twice and reserve its recycled commit a second time, and
        // would make the delivery gate hold a day a fold may already have
        // passed. Refused by name: the packet stays a failed, re-executable
        // message.
        if (s.chainDayRecycledFunding[b.dayId][selfId].stamped) {
            revert DayFundedLocally(b.dayId);
        }

        s.knownGlobalLenderInterestNumeraire18[b.dayId] =
            b.globalLenderNumeraire18;
        s.knownGlobalBorrowerInterestNumeraire18[b.dayId] =
            b.globalBorrowerNumeraire18;
        s.knownGlobalSet[b.dayId] = true;

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

        // #1569 M4 C3 — apply the Base-authorized keeper instruction.
        //
        // The earmark comes from INSIDE this chain's bucket — bounded on
        // Base by the headroom the day's commit left in this chain's
        // availability — exactly as the local register is on Base:
        // `recycleBucket` is unchanged and no tokens move. What changes is
        // how much of the bucket is available to fund reward budgets, since
        // `recycleKeeperBudget` is netted out of the fundable figure and out
        // of repatriation's draw.
        //
        // Base sized this from the chain's REPORTED DAY INFLOW and charged
        // it BESIDE the local commit reserved below, bounded by the headroom
        // that commit leaves in the chain's availability — so it is value
        // this chain already holds and Base is telling it how to label,
        // never an instruction to find more. The commit is the CAP, not the
        // base it is a share of (Codex #2031 r13). The commit stays whole
        // and the earmark is a second, separately-bounded draw: the mirror
        // reserves BOTH figures, and neither contains the other.
        s.recycleKeeperBudget += b.keeperAllocate;

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
        if (b.recycleConsume != 0) {
            LibVpfiRecycle.reserveMirrorCommit(b.dayId, b.recycleConsume);
        }

        s.broadcastV2Applied[b.dayId] = true;

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
    ///         from an authenticated V3 broadcast, in the same transaction
    ///         that applied the day's figures.
    /// @custom:event-category informational/reward-clock
    event DayClockInstalled(
        uint256 indexed dayId,
        uint64 finalizedAt,
        uint32 scheduleVersion,
        bool deliberatelyZeroed,
        address indexed era
    );

    /**
     * @notice #1434 P2-w1 — trusted ingress for the per-destination
     *         broadcast, the ONE broadcast shape (#1944): Base's finalized
     *         consensus fields, THIS chain's own funded figures for the day,
     *         and the day's FROZEN lapse-clock facts. Applies, in order:
     *
     *      1. The trust + destination-binding gates.
     *      2. Fail-closed clock presence — a zero `finalizedAt` is rejected.
     *         Base freezes the clock in the same call that finalizes the
     *         day, and only a finalized day is broadcast, so a zero clock is
     *         a malformed packet; it stays a failed, re-executable CCIP
     *         message rather than installing a meaningless clock.
     *      3. Era binding (§2h constraint 20), TWO layers (Codex #1632 r1):
     *         the packet's `baseDeployment` must equal the mirror's
     *         CONFIGURED current Base deployment ({setBaseRewardDeployment}
     *         — the explicit ground truth; fail-closed while unset, since
     *         the per-day record cannot defend a day's FIRST install), and
     *         must match the day's recorded era where one exists: a delayed
     *         broadcast from a retired Base deployment must never install
     *         its clock, schedule or zeroed marker into the new era, where
     *         a new-era compensation could combine with it.
     *      4. The V2 fields' apply core (fresh apply, or the full
     *         replay-divergence check), then the day-pool stamp and the
     *         clock, installed first-time or verified: a re-delivered packet
     *         must match every frozen clock fact (finalizedAt, schedule
     *         version, inline parameters, zeroed marker). `armedFromDay`
     *         stays OUTSIDE the comparison (first-apply-only, plus the
     *         replay install the core documents).
     *
     *      Every applied day carries its era from the transaction that
     *      applied it: the figures, the clock and `dayClockEra` are written
     *      together, and no other wire can apply a day (#1944 retired kinds
     *      2 and 5), so there is no day with figures but no recorded era.
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
        // rebind would win the race and poison the day's era
        // permanently. Fail-closed while unarmed: a broadcast to a mirror
        // whose operator has not set {setBaseRewardDeployment} stays a
        // failed, re-executable CCIP message.
        address expectedEra = s.baseRewardDeployment;
        if (expectedEra == address(0) || b.baseDeployment != expectedEra) {
            revert BroadcastEraUnauthenticated(
                dayId, expectedEra, b.baseDeployment
            );
        }
        // The per-day RECORD still binds a day to the era that installed
        // its clock: after a rebind moves the config, a day recorded
        // under the previous era rejects new-era re-deliveries (the
        // drain/heal ceremony owns cross-era days, not silent overwrite).
        address era = s.dayClockEra[dayId];
        if (era != address(0) && era != b.baseDeployment) {
            revert BroadcastEraMismatch(dayId, era, b.baseDeployment);
        }

        _applyBroadcastV2Core(s, b.v2);
        // #1636 r2 — install (or verify) the day-level funded pool stamp:
        // Δq's numerator and the quote surface's stamp gate both need it
        // mirror-side, and the per-chain slices cannot supply it (they are
        // ZERO for a zeroed destination).
        _installDayPoolStampV3(s, b);

        LibVaipakam.DayLapseClock storage c = s.dayLapseClock[dayId];
        if (c.finalizedAt == 0) {
            _installDayClock(s, b);
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

    /// @dev #1636 r2 — install (first broadcast for the day) or VERIFY
    ///      (replay) the day-level funded pool stamp from the packet's
    ///      day-pool words. Divergence joins the broadcast consensus family
    ///      (`KnownGlobalAlreadySet`). Stored doubled, read halved — the
    ///      convention every `dayPoolStamp` consumer reads (Base stamps the
    ///      whole figures at finalization).
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
    ///      that w2 adds keys its remitter check on the era). The only
    ///      writer of `dayClockEra`.
    function _installDayClock(
        LibVaipakam.Storage storage s,
        RewardBroadcastV3 calldata b
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
            b.baseDeployment
        );
    }

    /// @notice #1434 P2-w1 — the Base deployment that installed this day's
    ///         clock on this mirror (zero = no clock installed yet).
    function getDayClockEra(uint256 dayId) external view returns (address) {
        return LibVaipakam.storageSlot().dayClockEra[dayId];
    }

    /// @notice #1944 — whether THIS chain has already applied the broadcast
    ///         for `dayId`.
    /// @dev    Written for the M7 arming ceremony, which had to know per
    ///         mirror whether a candidate propagation day was still
    ///         unapplied. Answering it by scanning for
    ///         `RewardBroadcastV2Applied` logs depends on provider retention
    ///         and range limits, and a missed page reads as "not applied".
    ///         A rebroadcast of an applied day fills an empty `D*` (never
    ///         re-chooses a set one), so the readback is informational: it
    ///         does not mean the day is burnt for propagation.
    function getBroadcastV2Applied(uint256 dayId) external view returns (bool) {
        return LibVaipakam.storageSlot().broadcastV2Applied[dayId];
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

    /// @notice Set (or rebind) the CURRENT Base deployment this mirror
    ///         accepts broadcasts from — the explicit era ground truth
    ///         (Codex #1632 r1: the per-day era record cannot defend the
    ///         FIRST install, and the CCIP lane authenticates the shared
    ///         messenger, not the Diamond generation behind it).
    /// @dev    ADMIN. Zero disables the broadcast ingress entirely
    ///         (fail-closed — packets stay failed, re-executable CCIP
    ///         messages until re-armed). A rebind belongs to the same
    ///         ceremony that rotates the Base deployment; days whose clocks were
    ///         installed under the PREVIOUS era keep rejecting new-era
    ///         re-deliveries via their per-day record (drain/heal owns
    ///         cross-era days).
    function setBaseRewardDeployment(address baseDeployment)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // #1566 slice 4 PR B (design §5c/§5d) — a MIRROR's funding identity
        // is never rebound directly to a different retained source: the
        // change must pass through `Detached`. Judged against the last
        // NONZERO era, never the live config, so disarm-then-rearm cannot
        // smuggle a rebinding past it. Permanent, not only during the
        // freeze.
        if (
            baseDeployment != address(0)
                && s.rewardEraLastNonzero != address(0)
                && baseDeployment != s.rewardEraLastNonzero
                && LibVaipakam.rewardRole(s) == LibVaipakam.RewardRole.Mirror
        ) {
            revert IVaipakamErrors.RewardBaseDeploymentRebindRequiresDetach(
                s.rewardEraLastNonzero, baseDeployment
            );
        }
        // The last NONZERO era — the yardstick the rebind check above
        // reads.
        if (baseDeployment != address(0)) {
            s.rewardEraLastNonzero = baseDeployment;
        }
        s.baseRewardDeployment = baseDeployment;
        emit BaseRewardDeploymentSet(baseDeployment);
    }

    /// @notice The configured era ground truth (0 = broadcast ingress dark).
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
    ///         the destination for mirror-side chain reports.
    /// @dev    Written on EVERY chain, canonical included: both deploy
    ///         scripts export `BASE_CHAIN_ID` unconditionally (mainnet
    ///         always 8453; testnet uses this chain's own id when it IS
    ///         the canonical) and `ConfigureRewardReporter` writes it. So
    ///         a configuration audit should expect Base's chain id here
    ///         even on Base. This used to say "Zero on Base", which made
    ///         a correct deployment read as drift (#1641) — and
    ///         {RewardAggregatorFacet.getChainSurplusPosition} cited that
    ///         wording as its reason for reading `block.chainid`. Its
    ///         choice is still right, for the general reason
    ///         `RewardReporterFacet` states above: a chain's own identity
    ///         is `block.chainid`, read directly, not a governance-settable
    ///         field.
    ///
    ///         What this field is NOT is the canonical marker — that is
    ///         `isCanonicalRewardChain`, set explicitly. But it is not
    ///         inert either, and an earlier draft of this comment
    ///         overcorrected by saying canonical-vs-mirror is decided
    ///         "never by this field being zero" (Codex #1653 r2 P2).
    ///         Since #1566 closure 3 the role is resolved by
    ///         {LibVaipakam.rewardRole} over FOUR states, and zero here
    ///         means two different things depending on whether it was ever
    ///         WRITTEN:
    ///           - a zero that was never written (nobody configured this
    ///             deployment) resolves `Unconfigured` and keeps canonical /
    ///             single-chain semantics — the reward paths run unbounded
    ///             from the schedule;
    ///           - an EXPLICIT `setBaseChainId(0)` stamps
    ///             `rewardRoleConfigured` and, on a MIRROR, resolves
    ///             `Detached`: the delivered-fresh bound is ZERO, so payouts
    ///             funded from delivered-fresh budget stop — and only those
    ///             (Codex #2070 r22): schedule rewards paid before arming are
    ///             not consulted against the bound, and recycled-funded legs
    ///             still settle. It is not a payout kill-switch; pausing the
    ///             reward facets is. That is the mirror's detach procedure;
    ///             it also retires the delivered residual on the way out.
    ///           - on a CANONICAL chain zero here does NOT detach on its own:
    ///             {LibVaipakam.rewardRole} resolves `Canonical` whenever the
    ///             canonical flag is set, whatever the base. Detaching a
    ///             canonical chain takes both writes, in this order: zero
    ///             the base HERE first (still `Canonical` — no mirror window
    ///             opens), then {setIsCanonicalRewardChain}(false), which
    ///             resolves `Detached` with the base already zero. The
    ///             reverse order resolves `Mirror` in between and leaves
    ///             delivered-fresh payouts enabled (Codex #2070 r23).
    ///         So zero is a real configuration state with consequences,
    ///         not an absence — and calling this with zero to "reset" a
    ///         mirror stops its delivered-fresh-funded payouts.
    ///         `ConfigureRewardReporter` refuses a zero base on a mirror for
    ///         this reason. Read the resolved role back with
    ///         {getRewardRole}; these two raw fields cannot distinguish the
    ///         cases.
    /// @param chainId EVM chain id of the canonical reward chain.
    function setBaseChainId(
        uint32 chainId
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint32 old = s.baseChainId;
        bool wasMirror = LibVaipakam.isMirrorRewardChain(s);
        LibVaipakam.RewardRole before = LibVaipakam.rewardRole(s); // PR C-1: the carry-forward keys on the four-state role
        // #1566 slice 4 PR B (design §5c/§5d) — a mirror's authenticated
        // source is never rebound DIRECTLY to a different one: the old
        // residual must retire and delayed packets from the old source must
        // not be attributed to the new one, which only a pass through
        // `Detached` guarantees. Permanent, not only during the freeze. A
        // CANONICAL chain's base chain id is not a funding source (it
        // receives no remittances), so its rewrite is not a rebinding.
        if (wasMirror && old != 0 && chainId != 0 && chainId != old) {
            revert IVaipakamErrors.RewardBaseChainRebindRequiresDetach(old, chainId);
        }
        // The role freeze: refuse an EFFECTIVE role change while holder
        // allocations exist or custody is activated (see
        // {_requireRoleChangeAllowed}). Computed on the would-be role BEFORE
        // the write, so a refused call leaves nothing half-written.
        _requireRoleChangeAllowed(
            s,
            s.isCanonicalRewardChain
                ? LibVaipakam.RewardRole.Canonical
                : chainId != 0 ? LibVaipakam.RewardRole.Mirror : LibVaipakam.RewardRole.Detached
        );
        s.baseChainId = chainId;
        // #1566 closure 3 — stamp the role as CONFIGURED. This is what makes
        // `setBaseChainId(0)` resolve to `Detached` (fail-closed) rather than
        // `Unconfigured` (canonical / single-chain semantics), which is the
        // whole point of the flag: the two states share these field values.
        // Stamped unconditionally, including for `chainId == 0`, because
        // detaching IS a configuration act — and stamped by BOTH setters, so
        // the role can never reach `Detached` without the bit being written.
        s.rewardRoleConfigured = true;
        // Pre-merge adversarial review (2026-08-17) P2 — mirror-ness has TWO
        // inputs (`!isCanonicalRewardChain && baseChainId != 0`), and the r9
        // residual retirement guarded only the canonical knob. Detaching a
        // mirror the natural way — `setBaseChainId(0)` — flipped it into the
        // unbounded "neither" state with the residual intact: armed pricing
        // kept running off persisted stamps with no delivered bound and no
        // paid-ledger writes, and re-attaching re-offered the same residual
        // whose backing was already spent. One helper, called on the
        // EFFECTIVE role predicate, so a third role input can never repeat
        // this by construction.
        _retireDeliveredResidualOnRoleChange(s, before);
        emit RewardReporterConfigUpdated(
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes32("baseChainId"),
            bytes32(uint256(old)),
            bytes32(uint256(chainId))
        );
    }

    /// @dev The posture gate on an EFFECTIVE role change, on the RESOLVED role so
    ///      a third role input inherits it. Slice 4 PR B froze every change until
    ///      PR C (a transition would have orphaned funded custody); with PR C's
    ///      carry-forward in place a change carries the custody into the retiring
    ///      era, so the freeze is gone (#1566 PR C revision) — nothing waits on
    ///      a manual step. The staging gate below stands.
    function _requireRoleChangeAllowed(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardRole next
    ) private view {
        LibVaipakam.RewardRole current = LibVaipakam.rewardRole(s);
        if (next == current) return; // not a change at all
        // A role change moves the DELIVERED ALLOWANCE a reserved record's
        // payout charges — `Unconfigured` is unbounded, a configured role is
        // not — so it may not straddle a staging reservation (3b-ii-A2; Codex
        // #2308 r13). The same counter the custody activation reads: one
        // posture rule, every posture gate. Settle or unwind first; both are
        // permissionless.
        if (s.stagingEncumberedCount != 0) {
            revert IVaipakamErrors.RewardRoleChangeBlockedByStagedRecords(s.stagingEncumberedCount);
        }
    }

    /// @dev Retire the delivered-fresh residual (`received - paid`) whenever
    ///      the EFFECTIVE mirror role — `LibVaipakam.isMirrorRewardChain`,
    ///      not any single knob — changed across a config write. Levelling
    ///      `paid` up to `received` errs safe: the chain resumes with no
    ///      delivered headroom and earns it back from the next remittance.
    ///      #1566 closure 2 — RETAINED on purpose: this is an administrative
    ///      state transition, not an outflow, so it does not move to the
    ///      chokepoints that now charge the paid ledger by what leaves. Delete
    ///      it and an old delivered residual becomes reusable after a role
    ///      transition and re-attachment.
    ///      Shared by every setter that feeds the role predicate, so the
    ///      check IS the operation and a new role input inherits it.
    ///
    ///      Slice 4 PR C-1 (#1566) — the retirement is now the ERA CARRY-FORWARD
    ///      ({LibRewardCustody.retireCustodyEraOnRoleChange}) and it runs on
    ///      every effective change of the four-state role, not only of the
    ///      mirror predicate: Canonical→Detached and Detached→Canonical change
    ///      the bound as much as a mirror transition does. A first
    ///      configuration (Unconfigured → anything) opens and retires no era —
    ///      there is none to close — but it still LEVELS the delivered residual
    ///      (#1566 PR 1 review), as every role change before PR C did. The live-fresh custody is carried into the
    ///      retiring era's row rather than left behind a levelled counter, so
    ///      what the old era delivered stays consumable by the obligations it
    ///      accrued (PR C-2) and reaches live headroom only through the era's
    ///      terminal release.
    function _retireDeliveredResidualOnRoleChange(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardRole before
    ) private {
        LibVaipakam.RewardRole current = LibVaipakam.rewardRole(s);
        if (before == current) return;
        if (before == LibVaipakam.RewardRole.Unconfigured) {
            LibRewardCustody.levelDeliveredResidual(s);
            return;
        }
        (uint256 today, ) = LibInteractionRewards.currentDayOrZero();
        LibRewardCustody.retireCustodyEraOnRoleChange(s, SafeCast.toUint64(today));
    }

    /// @notice Flip this Diamond's canonical-reward-chain flag.
    ///         Must be `true` on exactly one Diamond in the mesh (Base).
    /// @param on Canonical flag value.
    function setIsCanonicalRewardChain(
        bool on
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        bool old = s.isCanonicalRewardChain;
        LibVaipakam.RewardRole before = LibVaipakam.rewardRole(s); // PR C-1: the carry-forward keys on the four-state role
        // #1566 slice 4 PR B — the role freeze, on the would-be role (a
        // false→false write on a never-configured deployment resolves
        // `Unconfigured` again and is not a change).
        _requireRoleChangeAllowed(
            s,
            on
                ? LibVaipakam.RewardRole.Canonical
                : s.baseChainId != 0
                    ? LibVaipakam.RewardRole.Mirror
                    : (s.rewardRoleConfigured || old)
                        ? LibVaipakam.RewardRole.Detached
                        : LibVaipakam.RewardRole.Unconfigured
        );
        s.isCanonicalRewardChain = on;
        // #1566 closure 3 — see the twin stamp in {setBaseChainId}. Demoting a
        // canonical chain that has no `baseChainId` lands on the same two
        // field values a fresh deploy has; this bit is the only thing that
        // distinguishes the two, so it must be written here as well — but
        // ONLY on a real transition (Codex #2070 r20 P2): enabling the flag,
        // or demoting a chain that WAS canonical. A false→false write on a
        // never-configured deployment is an idempotent no-op, and stamping it
        // would silently move the resolved role from `Unconfigured` to
        // `Detached` — the zero delivered-fresh bound, on a live chain, from
        // an admin call whose emitted config update reads as false→false.
        if (on || old) {
            s.rewardRoleConfigured = true;
        }
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
        // free allowance.
        //
        // Pre-merge adversarial review (2026-08-17) P2 — the retirement now
        // keys on the EFFECTIVE role predicate through the shared helper,
        // because mirror-ness has two inputs and `setBaseChainId` mutates
        // the other one. Guarding each knob's own delta re-created the
        // one-fix-two-sites defect r2 already catalogued.
        _retireDeliveredResidualOnRoleChange(s, before);
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

    /// @notice #1699 r18 P2 — whether the one-shot paid-history seed has run.
    ///         Exists so the maintained refresh can SKIP the migration block
    ///         on an already-seeded Diamond instead of demanding obsolete
    ///         migration inputs mid-refresh, paused. (The earlier position —
    ///         "the one-shot revert IS the signal" — required reaching the
    ///         seed call at all; the input-validation require sat in front of
    ///         it and wedged every rerun.)
    function armedFreshPaidSeeded() external view returns (bool) {
        return LibVaipakam.storageSlot().armedFreshPaidSeeded;
    }

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
     *
     *         #1566 closure 2 — the counter this seeds now means fresh reward
     *         value paid out of delivered funding WHATEVER the day's vintage
     *         (charged at the claim's delivery and at the reward-absorption
     *         credit), so a seed must cover legacy payouts too. This one-shot
     *         writer is retained as the paid-side starting point; the
     *         migration-capable writers the design specifies for a chain
     *         mid-flight (received-side import, `paid = max(existing,
     *         reconciled)`) arrive with the second closure-2 PR.
     * @param  amount     Fresh reward value already paid out of delivered
     *                    funding before this upgrade, any vintage.
     * @param  pauseEpoch The pause epoch — the pause library's transition
     *                    count — at which the caller established `amount`
     *                    under the MANUAL pause (#1566 slice 4 PR A, Codex
     *                    #2158 r29 P1). The seed is as irreversible as the
     *                    rebase and is bound to its pause the same way: it
     *                    requires the manual pause and refuses a stated epoch
     *                    that is no longer the live one, so a figure a payout
     *                    may have overtaken can never be sealed.
     */
    function seedArmedFreshPaid(uint256 amount, uint64 pauseEpoch)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.armedFreshPaidSeeded) revert ArmedFreshPaidAlreadySeeded();
        LibPausable.requireManuallyPaused();
        uint64 liveEpoch = LibPausable.pauseTransitions();
        if (pauseEpoch != liveEpoch) {
            revert IVaipakamErrors.ArmedFreshSeedStalePauseEpoch(pauseEpoch, liveEpoch);
        }
        // #1566 slice 4 PR A (Codex #2158 r13 P1) — bounded to the pool cap,
        // as the rebase is: this is the one writer that could install an
        // impossible paid figure ahead of it.
        uint256 resulting = s.rewardBudgetArmedFreshPaid + amount;
        if (resulting > LibVaipakam.VPFI_INTERACTION_POOL_CAP) {
            revert IVaipakamErrors.ArmedFreshSeedExceedsCap(resulting, LibVaipakam.VPFI_INTERACTION_POOL_CAP);
        }
        s.armedFreshPaidSeeded = true;
        s.rewardBudgetArmedFreshPaid = resulting;
        emit ArmedFreshPaidSeeded(amount);
    }

    /// @notice Adjust the grace window after the first chain report for
    ///         day `D` within which `finalizeDay(D)` may be called even
    ///         if not every expected mirror has reported.
    /// @param secondsValue Grace duration in seconds (default 4h when
    ///                     zero — see {LibRewardDayReport.DEFAULT_REWARD_GRACE_SECONDS}).
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
                ? LibRewardDayReport.DEFAULT_REWARD_GRACE_SECONDS
                : s.rewardGraceSeconds
        );
    }

    /// @notice #1566 closure 3 — this Diamond's resolved reward-mesh role.
    /// @dev    {getRewardReporterConfig} returns the two raw role fields, and
    ///         they are NOT sufficient to determine the role: a detached chain
    ///         and a never-configured one both report
    ///         `baseChainId == 0, isCanonicalRewardChain == false` while
    ///         behaving oppositely. Reading those two fields off a live
    ///         deployment and inferring the role is exactly the mistake this
    ///         view exists to prevent — the operator cannot see the deciding
    ///         bit, and neither could the fourteen call sites before
    ///         {LibVaipakam.rewardRole}.
    ///
    ///         Returned as `uint8` rather than the enum so an off-chain
    ///         consumer decodes a stable width if the enum ever grows.
    /// @return role `LibVaipakam.RewardRole` — 0 Canonical, 1 Mirror,
    ///         2 Unconfigured, 3 Detached.
    function getRewardRole() external view returns (uint8 role) {
        return uint8(LibVaipakam.rewardRole(LibVaipakam.storageSlot()));
    }
}
