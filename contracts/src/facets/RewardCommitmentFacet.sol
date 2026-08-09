// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {LibCommitmentReport} from "../libraries/LibCommitmentReport.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {IRewardMessenger} from "../interfaces/IRewardMessenger.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title RewardCommitmentFacet — #1222 M3 B2-c commitment-GATE plumbing.
 *
 * @notice The two ends of the reward-mesh commitment REPORT: the MIRROR-side
 *         surface (keeper-fed batch accumulation + the once-per-day dispatch
 *         to Base) and the Base-side operator surface (reconciliation of a
 *         zeroed chain's remit-eligibility + the read views over the
 *         per-(day, chain) state). The Base ingress that accepts the report
 *         lives in {RewardAggregatorFacet.onCommitmentReportReceived}; the
 *         remit gate + clamp that consume it land in B2-d2
 *         ({RewardRemittanceFacet}).
 *
 * @dev    B2-d1 report timing (supersedes the B2-c finalization-readiness
 *         gate): a mirror's day-`D` liability is priced from the day-`D`
 *         per-side caps + funding stamp, which exist only once Base's
 *         `finalizeDay(D)` computes them and `broadcastGlobal(D)` delivers
 *         them — so the report always lands AFTER finalize, and what waits
 *         for it is the per-(day, chain) ShareOfPool REMITTANCE (delays,
 *         never zeroes). `remitIneligible` marks the one case remittance
 *         must not auto-proceed: an armed-day finalize that ZEROED the
 *         chain's interest contribution (its slice was sized without its
 *         real demand) — the operator reconciles and remits manually. The
 *         earlier B2-c paged commitment report was withdrawn after review
 *         (Codex #1422) showed a paged, permissionless, active-loan-list
 *         report is the wrong mechanism for day-`D` claimable liabilities —
 *         see the release note.
 */
contract RewardCommitmentFacet is DiamondAccessControl, IVaipakamErrors {
    /// @notice Emitted when an operator clears a chain's remit-ineligible flag
    ///         after off-chain reconciliation (its ShareOfPool remittance may
    ///         proceed again).
    /// @custom:event-category informational/reward-governor
    event CommitmentRemitEligibilityReconciled(
        uint256 indexed dayId,
        uint32 indexed chainId
    );

    /// @notice #1222 M3 B2-d1 — this mirror dispatched its day-`D` commitment
    ///         report (per-side claimable-liability aggregate) to Base.
    /// @custom:event-category informational/reward-governor
    event CommitmentReported(
        uint256 indexed dayId,
        bytes32 indexed messageId,
        uint256 liabilityLender18,
        uint256 liabilityBorrower18
    );

    // ─── Mirror-side commitment REPORT (B2-d1) ───────────────────────────────

    /// @notice Accumulate one keeper-fed batch of day-covering reward entries
    ///         for `(dayId, side)` — the mirror recomputes each entry's
    ///         contribution from its OWN storage, so the keeper cannot inflate
    ///         or distort the reported liability, only delay it.
    /// @dev MIRROR-only, KEEPER_ROLE-gated. The role is anti-grief, not trust:
    ///      the strictly-ascending entry-id cursor consumes each id slot at
    ///      most once, so a permissionless submission that skipped ids (e.g.
    ///      submitting a high id first) would leave lower covering entries
    ///      unreachable, demand conservation permanently short, and the day's
    ///      report wedged (a cheap per-day DoS on the remit flow). The numeric
    ///      figures stay mirror-computed regardless of caller; a keeper
    ///      MIS-submission is recoverable via {resetCommitmentAccumulation}.
    ///      `side` is 0 (Lender) / 1 (Borrower). `entryIds` MUST be strictly
    ///      ascending (and above the stored cursor). Completeness is proven by
    ///      demand conservation, so a partial submission simply leaves the day
    ///      incomplete (delays, never zeroes). See {LibCommitmentReport}.
    function submitCommitmentBatch(
        uint256 dayId,
        uint8 side,
        uint256[] calldata entryIds
    ) external onlyRole(LibAccessControl.KEEPER_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        _assertMirror(s);
        // Enum bounds-check reverts a side outside {0,1}.
        LibCommitmentReport.accumulateBatch(
            s, dayId, LibVaipakam.RewardSide(side), entryIds
        );
    }

    /// @notice #1222 M3 B2-d1 — a `(dayId, side)` accumulation was wiped so it
    ///         can be resubmitted from scratch.
    /// @custom:event-category informational/reward-governor
    event CommitmentAccumulationReset(uint256 indexed dayId, uint8 indexed side);

    /// @notice Wipe `(dayId, side)`'s commitment accumulation (cursor + both
    ///         accumulators) so the keeper can resubmit from scratch.
    /// @dev ADMIN-only, MIRROR-only, and only while the day's report has not
    ///      been sent. The recovery valve for a keeper MIS-submission (e.g. a
    ///      covering entry id skipped below an already-consumed cursor,
    ///      permanently blocking demand conservation): reset, then resubmit
    ///      the full ascending set.
    function resetCommitmentAccumulation(
        uint256 dayId,
        uint8 side
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        _assertMirror(s);
        if (s.commitmentReportSent[dayId]) {
            revert CommitmentReportAlreadySent(dayId);
        }
        // Enum bounds-check reverts a side outside {0,1}.
        uint8 sideKey = uint8(LibVaipakam.RewardSide(side));
        s.commitmentEntryCursor[dayId][sideKey] = 0;
        s.commitmentLiabilityAccum18[dayId][sideKey] = 0;
        s.commitmentConservationAccum18[dayId][sideKey] = 0;
        emit CommitmentAccumulationReset(dayId, sideKey);
    }

    /// @notice Dispatch this mirror's day-`D` commitment report to Base once
    ///         both sides are complete, lighting the Base remit gate for this
    ///         chain-day.
    /// @dev MIRROR-only, payable (covers the CCIP fee — quote via
    ///      {IRewardMessenger.quoteSendCommitmentReport}). ARMED days only —
    ///      an unarmed day has no Base gate to light, and a quiet unarmed day
    ///      is trivially "complete", so without the gate every pre-arming day
    ///      would be sendable (see {LibCommitmentReport.isDayArmed}). Whole-day
    ///      idempotent (`commitmentReportSent`). CEI: the sent flag is set
    ///      before the external dispatch, so a failed send rolls back and
    ///      stays retryable.
    function sendCommitmentReport(
        uint256 dayId
    ) external payable returns (bytes32 messageId) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        _assertMirror(s);
        if (!LibCommitmentReport.isDayArmed(s, dayId)) {
            revert CommitmentDayNotArmed(dayId);
        }
        // Pricing precondition: the day's funding stamp must have arrived.
        if (!LibCommitmentReport.hasFundingStamp(s, dayId)) {
            revert CommitmentStampNotArrived(dayId);
        }
        // Race guard (Codex #1425 r1): the stamp does NOT prove this mirror's
        // own interest close ran — a Base grace/force-finalize stamps the
        // mirror even when `closeDay(dayId)` never fired here, and pre-close
        // the day LOOKS quiet (totals 0 ⇒ trivially "complete"), so the
        // once-only report could ship an irreversible (0, 0). Require the
        // local close explicitly.
        if (!LibCommitmentReport.hasLocalInterestClose(s, dayId)) {
            revert CommitmentDayNotLocallyClosed(dayId);
        }
        if (s.commitmentReportSent[dayId]) {
            revert CommitmentReportAlreadySent(dayId);
        }
        if (!LibCommitmentReport.isDayComplete(s, dayId)) {
            revert CommitmentDayNotComplete(dayId);
        }
        address messenger = s.rewardMessenger;
        if (messenger == address(0)) revert RewardMessengerNotSet();
        if (s.baseChainId == 0) revert BaseChainIdNotSet();

        uint256 liabilityLender18 = LibCommitmentReport.sideLiability(
            s, dayId, LibVaipakam.RewardSide.Lender
        );
        uint256 liabilityBorrower18 = LibCommitmentReport.sideLiability(
            s, dayId, LibVaipakam.RewardSide.Borrower
        );

        s.commitmentReportSent[dayId] = true;

        messageId = IRewardMessenger(messenger).sendCommitmentReport{
            value: msg.value
        }(dayId, liabilityLender18, liabilityBorrower18, payable(msg.sender));

        emit CommitmentReported(
            dayId, messageId, liabilityLender18, liabilityBorrower18
        );
    }

    /// @notice True iff this chain can dispatch `dayId`'s report right now:
    ///         mirror + messenger wiring present, day armed, funding stamp
    ///         arrived, local interest close ran, per-side commitments
    ///         complete, report not yet sent — the keeper's send trigger.
    ///         Never true for a day {sendCommitmentReport} would revert on
    ///         (Codex #1425 r1: the earlier form was true on the canonical
    ///         chain and on un-wired mirrors, where the send always reverts).
    function isDayCommitmentReady(
        uint256 dayId
    ) external view returns (bool) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return
            LibVaipakam.isMirrorRewardChain(s) &&
            s.rewardMessenger != address(0) &&
            LibCommitmentReport.isDayArmed(s, dayId) &&
            LibCommitmentReport.hasFundingStamp(s, dayId) &&
            LibCommitmentReport.hasLocalInterestClose(s, dayId) &&
            !s.commitmentReportSent[dayId] &&
            LibCommitmentReport.isDayComplete(s, dayId);
    }

    /// @notice True iff this mirror already dispatched `dayId`'s commitment
    ///         report to Base.
    /// @dev The explicit dispatch signal (Codex #1425 r3): "complete but not
    ///      ready" is NOT proof of dispatch — readiness also folds in the
    ///      messenger wiring, so an un-wired mirror's complete-unsent day
    ///      would read identically. Keeper resolution keys on THIS.
    function isCommitmentReportSent(
        uint256 dayId
    ) external view returns (bool) {
        return LibVaipakam.storageSlot().commitmentReportSent[dayId];
    }

    /// @notice The `(dayId, side)` accumulation state: the last-accumulated
    ///         entry-id cursor (0 = none yet; the keeper resumes with ids
    ///         strictly above it) and the two running sums.
    /// @dev The keeper's resumability view — batches are cheap but the cursor
    ///      is strictly ascending, so a restarted keeper must know where the
    ///      prior tick stopped rather than re-submit from the start.
    function getCommitmentAccumulation(
        uint256 dayId,
        uint8 side
    )
        external
        view
        returns (
            uint256 cursor,
            uint256 liabilityAccum18,
            uint256 conservationAccum18
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint8 sideKey = uint8(LibVaipakam.RewardSide(side));
        return (
            s.commitmentEntryCursor[dayId][sideKey],
            s.commitmentLiabilityAccum18[dayId][sideKey],
            s.commitmentConservationAccum18[dayId][sideKey]
        );
    }

    /// @notice Quote the native CCIP fee {sendCommitmentReport} would pay for
    ///         `dayId` right now, from the currently-accumulated liabilities.
    /// @dev MIRROR-only; the Diamond-side wrapper so the keeper needs neither
    ///      the messenger address nor the liability reads (symmetric with
    ///      {RewardRemittanceFacet.quoteRemittanceFee}). Same wiring guards as
    ///      the send.
    function quoteCommitmentReportFee(
        uint256 dayId
    ) external view returns (uint256 nativeFee) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        _assertMirror(s);
        address messenger = s.rewardMessenger;
        if (messenger == address(0)) revert RewardMessengerNotSet();
        if (s.baseChainId == 0) revert BaseChainIdNotSet();
        return IRewardMessenger(messenger).quoteSendCommitmentReport(
            dayId,
            LibCommitmentReport.sideLiability(
                s, dayId, LibVaipakam.RewardSide.Lender
            ),
            LibCommitmentReport.sideLiability(
                s, dayId, LibVaipakam.RewardSide.Borrower
            )
        );
    }

    /// @dev The commitment REPORT surface is mirror-only: a mirror computes its
    ///      OWN day-`D` liability and ships it to Base. Reverts on the canonical
    ///      (Base) chain and on a single-chain deploy (no `baseChainId`).
    function _assertMirror(LibVaipakam.Storage storage s) private view {
        if (!LibVaipakam.isMirrorRewardChain(s)) {
            revert CommitmentReportOnlyMirror();
        }
    }

    /**
     * @notice Clear a chain's `remitIneligible` flag for `dayId` after an
     *         off-chain commitment reconciliation, so its ShareOfPool
     *         remittance may proceed again.
     * @dev ADMIN-only. The flag is set by any armed-day finalize (grace
     *      backstop or admin force) that ZEROED this chain's interest
     *      contribution out of the denominator — its ShareOfPool slice was
     *      sized without its real demand, so automatic remittance must not
     *      proceed (B2-d1 retarget; a merely LATE commitment report is not
     *      flagged — the remit gate just waits for it). The operator
     *      reconciles the true liability OFF-CHAIN from the mirror's locally
     *      readable state (day totals + entry set): the zeroed chain's own
     *      funding stamp deliberately carries zero halves, so its on-chain
     *      report — still accepted post-finalize — prices at Δ = 0 and is NOT
     *      a sizing basis (Codex #1425 r1). After the evidenced
     *      reconciliation the operator clears the flag here. NOTE (Codex
     *      #1425 r2): clearing the flag is the OBLIGATION-side half only — a
     *      zeroed chain has no slice in the finalized denominator
     *      (`chainRewardBudgetSplitForDay` returns zero for a non-included
     *      chain), so `RewardRemittanceFacet.remitRewardBudget` cannot fund
     *      the reconciled day. The funding VEHICLE is the B2-d2 evidenced
     *      manual-budget path, designed WITH the delivered-backing ledger —
     *      a manual send that bypassed the pendingRemitted reservation + ack
     *      would be exactly the unbacked-remit class that ledger exists to
     *      prevent. Until d2 lands, a zeroed chain-day's compensation stays
     *      the pre-mesh out-of-band governance posture
     *      ({RewardAggregatorFacet.forceFinalizeDay}'s documented recovery).
     *      With the B2-d1 report in place, an armed day whose chains all
     *      deliver their interest reports never reaches this path — only a
     *      chain zeroed out of the denominator does.
     */
    function reconcileCommitmentRemitEligibility(
        uint256 dayId,
        uint32 chainId
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Canonical-only, matching {RewardAggregatorFacet.finalizeDay} /
        // {RewardRemittanceFacet}: the remit-ineligible flag is authoritative
        // on Base. This facet is cut on mirror Diamonds too, so without the
        // guard a mirror-chain admin's wrong-chain call would clear only the
        // mirror's unused local mapping and emit the event while the Base flag
        // (the one that actually blocks remittance) stayed set — a recovery
        // transaction that looks successful but does nothing (Codex #1422 r4).
        if (!s.isCanonicalRewardChain) revert NotCanonicalRewardChain();
        s.chainDayCommitments[dayId][chainId].remitIneligible = false;
        emit CommitmentRemitEligibilityReconciled(dayId, chainId);
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    /// @notice The Base-side commitment-gate state for `(dayId, chainId)`.
    function getChainDayCommitments(
        uint256 dayId,
        uint32 chainId
    ) external view returns (LibVaipakam.ChainDayCommitments memory) {
        return LibVaipakam.storageSlot().chainDayCommitments[dayId][chainId];
    }

    /// @notice True iff `chainId`'s commitments for `dayId` are complete
    ///         (populated by the B2-d mirror→Base report; false until then).
    function isChainDayCommitmentsComplete(
        uint256 dayId,
        uint32 chainId
    ) external view returns (bool) {
        return LibVaipakam.storageSlot()
            .chainDayCommitments[dayId][chainId].complete;
    }

    // ─── #1434 P2-w1 (R5) — the versioned lapse schedule + day clock ─────────
    //
    // Hosted HERE rather than in {RewardAggregatorFacet} (which writes the
    // per-day freeze at finalization and reads it back at broadcast): the
    // aggregator sits within ~500 bytes of the EIP-170 ceiling, while this
    // facet has ~20KB of headroom — and it already owns the day-scoped
    // operator surface ({reconcileCommitmentRemitEligibility}) whose live
    // flag the frozen `dayZeroedForDest` copy exists to be compared
    // against.

    /// @notice Hard bounds on the lapse window (design §7). The window must
    ///         exceed the reward grace period + lane latency + cross-chain
    ///         clock skew by a wide margin; 7 days is the proposed default.
    uint64 internal constant LAPSE_WINDOW_MIN = 3 days;
    uint64 internal constant LAPSE_WINDOW_MAX = 30 days;
    /// @notice Hard bounds on the R3 dispatch-cutoff gap (design §7).
    uint64 internal constant DISPATCH_CUTOFF_GAP_MIN = 6 hours;
    uint64 internal constant DISPATCH_CUTOFF_GAP_MAX = 7 days;
    /// @notice The dispatch-opportunity margin: `lapseWindowSeconds >=
    ///         dispatchCutoffGap + 48 hours`, or the version would place the
    ///         cutoff at/before finalization and unrepairably forbid every
    ///         compensation for every day frozen under it (Codex #1600 r1).
    uint64 internal constant LAPSE_DISPATCH_MARGIN = 48 hours;

    /// @notice #1434 P2-w1 (R5) — emitted once per new lapse-schedule
    ///         version.
    /// @custom:event-category informational/reward-governor
    event LapseScheduleVersionSet(
        uint32 indexed version,
        uint64 lapseWindowSeconds,
        uint64 dispatchCutoffGap
    );

    /// @notice Create the NEXT lapse-schedule version (R5). Versions are
    ///         append-only — a parameter change is a new version, never an
    ///         edit in place, because a finalized day evaluates its clocks
    ///         under the version frozen at its finalization forever (a later
    ///         change must not retroactively move an already-finalized
    ///         day's expiry). Days finalized from this call onward freeze
    ///         the new version.
    /// @dev    ADMIN + canonical-only (the schedule is authoritative on
    ///         Base and rides the V3 broadcast to mirrors — a mirror-local
    ///         version would be exactly the unauthenticated schedule §2h
    ///         constraint 13 forbids). Both values are range-bounded and
    ///         relationally bounded (the `VpfiPoolRateGovernor` refused-
    ///         never-stored pattern): an out-of-bounds version is refused,
    ///         so no frozen day can ever carry unrepairable parameters.
    function setLapseSchedule(
        uint64 lapseWindowSeconds,
        uint64 dispatchCutoffGap
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.isCanonicalRewardChain) revert NotCanonicalRewardChain();
        if (
            lapseWindowSeconds < LAPSE_WINDOW_MIN
                || lapseWindowSeconds > LAPSE_WINDOW_MAX
        ) {
            revert LapseWindowOutOfBounds(lapseWindowSeconds);
        }
        if (
            dispatchCutoffGap < DISPATCH_CUTOFF_GAP_MIN
                || dispatchCutoffGap > DISPATCH_CUTOFF_GAP_MAX
        ) {
            revert DispatchCutoffGapOutOfBounds(dispatchCutoffGap);
        }
        if (lapseWindowSeconds < dispatchCutoffGap + LAPSE_DISPATCH_MARGIN) {
            revert LapseScheduleMarginViolated(
                lapseWindowSeconds, dispatchCutoffGap
            );
        }
        uint32 version = s.lapseScheduleCurrentVersion + 1;
        s.lapseScheduleCurrentVersion = version;
        s.lapseSchedules[version] = LibVaipakam.LapseScheduleParams({
            lapseWindowSeconds: lapseWindowSeconds,
            dispatchCutoffGap: dispatchCutoffGap
        });
        emit LapseScheduleVersionSet(
            version, lapseWindowSeconds, dispatchCutoffGap
        );
    }

    /// @notice The current lapse-schedule version (0 = never set).
    function getCurrentLapseScheduleVersion() external view returns (uint32) {
        return LibVaipakam.storageSlot().lapseScheduleCurrentVersion;
    }

    /// @notice One stored lapse-schedule version's parameter pair (both
    ///         zero for a version that was never created).
    function getLapseSchedule(uint32 version)
        external
        view
        returns (uint64 lapseWindowSeconds, uint64 dispatchCutoffGap)
    {
        LibVaipakam.LapseScheduleParams storage p =
            LibVaipakam.storageSlot().lapseSchedules[version];
        return (p.lapseWindowSeconds, p.dispatchCutoffGap);
    }

    /// @notice #1434 P2-w1 — the day's frozen lapse clock. On Base, written
    ///         at finalization; on a mirror, installed from an authenticated
    ///         V3 broadcast. `finalizedAt == 0` ⇒ no clock (the day is
    ///         neither lapse-eligible nor priceable as a zeroed day).
    function getDayLapseClock(uint256 dayId)
        external
        view
        returns (
            uint64 finalizedAt,
            uint32 scheduleVersion,
            uint64 lapseWindowSeconds,
            uint64 dispatchCutoffGap
        )
    {
        LibVaipakam.DayLapseClock storage c =
            LibVaipakam.storageSlot().dayLapseClock[dayId];
        return (
            c.finalizedAt,
            c.scheduleVersion,
            c.lapseWindowSeconds,
            c.dispatchCutoffGap
        );
    }

    /// @notice #1434 P2-w1 — the FROZEN per-(day, destination) R1 zeroed
    ///         marker (what the V3 wire carries; the live `remitIneligible`
    ///         is operator-clearable and may differ after reconciliation).
    function getDayZeroedForDest(
        uint256 dayId,
        uint32 destChainId
    ) external view returns (bool) {
        return LibVaipakam.storageSlot().dayZeroedForDest[dayId][destChainId];
    }

    // ─── #1434 P2-w3 — the zeroed-day compensation QUOTE (§1.4) ──────────────

    /// @notice #1434 P2-w3 — one quote-accumulation batch landed.
    /// @custom:event-category informational/reward-compensation
    event CompQuoteBatchAccumulated(
        uint256 indexed dayId,
        uint8 indexed side,
        uint256 accumulated18,
        uint256 conservation18
    );

    /// @notice #1434 P2-w3 — the day's quote was dispatched toward Base.
    ///         `resolvedZero` marks the both-sides-zero terminal (§2.3): the
    ///         day was marked resolved MIRROR-LOCALLY before dispatch, so
    ///         the suppression gate releases it regardless of delivery.
    /// @custom:event-category informational/reward-compensation
    event CompQuoteDispatched(
        uint256 indexed dayId,
        uint256 quotedLender18,
        uint256 quotedBorrower18,
        bool resolvedZero,
        bytes32 messageId
    );

    /// @notice #1434 P2-w3 — Base stored (or refreshed) a chain-day quote.
    /// @custom:event-category informational/reward-compensation
    event CompQuoteStored(
        uint256 indexed dayId,
        uint32 indexed sourceChainId,
        uint256 quotedLender18,
        uint256 quotedBorrower18
    );

    /// @notice #1434 P2-w3 (§2.3) — a (0,0) quote resolved the chain-day:
    ///         remit-ineligibility cleared, funding bounded to zero.
    /// @custom:event-category informational/reward-compensation
    event CompQuoteResolvedZero(uint256 indexed dayId, uint32 indexed chainId);

    /// @dev The shared quote-surface preconditions (§1.4 + R1d §2.3).
    function _assertQuotableDay(
        LibVaipakam.Storage storage s,
        uint256 dayId
    ) private view {
        if (!s.dayDeliberatelyZeroed[dayId]) {
            revert CompQuoteDayNotZeroed(dayId);
        }
        // R1d — "this day's local interest close HAS RUN": zero totals
        // alone are ambiguous (unfolded vs genuinely zero); the close
        // stamp is not.
        if (s.chainReportSentAt[dayId] == 0) {
            revert CompQuoteLocalCloseMissing(dayId);
        }
        // #1636 r1 P1 — Δq's numerator is the day's frozen pool stamp
        // (the broadcast installs it together with the zeroed marker, so
        // an honest flow always has it). Pricing without it would quote
        // (0,0) and wrongly resolve a demand-carrying day to zero — fail
        // closed instead.
        if (!s.dayPoolStamp[dayId].stamped) {
            revert CompQuoteDayPoolStampMissing(dayId);
        }
        if (s.dayLapsed[dayId] || s.dayShortLapsed[dayId]) {
            revert CompQuoteDayLapsed(dayId);
        }
    }

    /**
     * @notice #1434 P2-w3 — accumulate one bounded batch of this day's
     *         quote (§1.4's checkpointed accumulator — a busy day's single
     *         scan could exceed block gas and make compensation
     *         unreachable). PERMISSIONLESS: anyone advances the cursor;
     *         the quote dispatches when {quoteZeroedDayCompensation} finds
     *         the accumulation complete.
     * @dev    The `LibCommitmentReport.accumulateBatch` template, priced at
     *         Δq instead of Δ_d: strictly-ascending entry ids (each entry
     *         at most once, duplicate-free by construction), per-entry
     *         side/coverage validation, `min(perDay × Δq_s / 1e18, C_side)`
     *         with the day's stamped per-side ceiling, and a conservation
     *         sum whose equality with the folded side total is the
     *         completeness proof. Accumulation closes at dispatch — the
     *         quote is deterministic from frozen inputs, so there is
     *         nothing to re-accumulate.
     */
    function accumulateCompQuoteBatch(
        uint256 dayId,
        LibVaipakam.RewardSide side,
        uint256[] calldata entryIds
    ) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        _assertQuotableDay(s, dayId);
        if (s.compQuoteSentAt[dayId] != 0) {
            revert CompQuoteAlreadyDispatched(dayId);
        }

        // §1.4 — Δq from THE shared implementation
        // ({LibInteractionRewards.compQuoteDelta}): the pricing ladder and
        // the payment path read the same function, so the quoted figure and
        // the priced figure cannot diverge.
        uint256 delta = LibInteractionRewards.compQuoteDelta(s, side, dayId);
        uint8 sideKey = uint8(side);
        uint256 cursor = s.compQuoteEntryCursor[dayId][sideKey];

        uint256 quoteAdd;
        uint256 conservationAdd;
        uint256 n = entryIds.length;
        for (uint256 i; i < n; ) {
            uint256 id = entryIds[i];
            if (id <= cursor) {
                revert CommitmentEntriesNotAscending(id);
            }
            cursor = id;

            LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
            uint256 start = e.startDay == 0 ? 1 : e.startDay;
            if (e.side != side || dayId < start || dayId >= e.endDay) {
                revert CommitmentEntryMismatch(id);
            }

            // #1636 r1 P1 — the quote is the UNCAPPED fair-share sum
            // (per-entry `perDay × Δq`, no per-entry ceiling). It must
            // UPPER-BOUND every settlement path the fold's funding gate
            // protects, and the bulk paths are deliberately cap-free
            // where the walk is not: a forfeited entry's window prices
            // uncapped by design (#1353 — the ceiling bounds reward paid
            // to a user, never a forfeit), and bulk window pricing skips
            // the per-(user,day) ceiling entirely. A capped quote would
            // open the gate below that liability and let a forfeit sweep
            // absorb undelivered value. Caps still apply at PAYMENT time
            // per each path's own rules; the delivered-minus-paid residue
            // on cap-binding days is delivered fresh awaiting its entry's
            // settlement (a later forfeit absorbs it in full).
            uint256 perDay = e.perDayNumeraire18;
            conservationAdd += perDay;
            quoteAdd += (perDay * delta) / 1e18;
            unchecked {
                ++i;
            }
        }

        s.compQuoteEntryCursor[dayId][sideKey] = cursor;
        s.compQuoteAccum18[dayId][sideKey] += quoteAdd;
        s.compQuoteConservation18[dayId][sideKey] += conservationAdd;
        emit CompQuoteBatchAccumulated(
            dayId,
            sideKey,
            s.compQuoteAccum18[dayId][sideKey],
            s.compQuoteConservation18[dayId][sideKey]
        );
    }

    /// @notice #1434 P2-w3 (#1636 r1) — a `(dayId, side)` quote
    ///         accumulation was wiped so it can be resubmitted from
    ///         scratch.
    /// @custom:event-category informational/reward-compensation
    event CompQuoteAccumulationReset(
        uint256 indexed dayId,
        uint8 indexed side
    );

    /// @notice Wipe `(dayId, side)`'s quote accumulation (cursor + both
    ///         accumulators) so the full ascending set can be resubmitted.
    /// @dev ADMIN-only and only while the quote has not been dispatched —
    ///      the same recovery valve {resetCommitmentAccumulation} gives
    ///      the commitment accumulator (#1636 r1 P1: the accumulator is
    ///      PERMISSIONLESS, so any caller could submit one high-id entry
    ///      and park the cursor past the covering set; without a reset the
    ///      conservation proof could never complete and the day's
    ///      compensation would be permanently wedged).
    function resetCompQuoteAccumulation(
        uint256 dayId,
        uint8 side
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.compQuoteSentAt[dayId] != 0) {
            revert CompQuoteAlreadyDispatched(dayId);
        }
        // Enum bounds-check reverts a side outside {0,1}.
        uint8 sideKey = uint8(LibVaipakam.RewardSide(side));
        s.compQuoteEntryCursor[dayId][sideKey] = 0;
        s.compQuoteAccum18[dayId][sideKey] = 0;
        s.compQuoteConservation18[dayId][sideKey] = 0;
        emit CompQuoteAccumulationReset(dayId, sideKey);
    }

    /**
     * @notice #1434 P2-w3 — FINALIZE + dispatch this day's compensation
     *         quote toward Base (§1.4). PERMISSIONLESS and RE-SENDABLE:
     *         the figures are deterministic from frozen inputs, so a
     *         re-send carries the identical quote (the lost-message retry
     *         lever, like day reports); the caller pays the CCIP fee.
     * @dev    Completeness proof per side: the conservation sum over
     *         accumulated entries must equal the day's folded side total —
     *         a zero side is trivially complete with no batches (L_s == 0
     *         ⇒ conservation 0 == 0). BOTH sides zero is the resolved-zero
     *         terminal (§2.3): `dayResolvedZero` is set MIRROR-LOCALLY
     *         BEFORE dispatch (Base clearing its flag changes nothing
     *         here), the suppression gate releases the day, and it prices
     *         zero through the ordinary walk — correctly, since no entry
     *         accrued that day.
     */
    function quoteZeroedDayCompensation(
        uint256 dayId,
        address payable refundAddress
    ) external payable returns (bytes32 messageId) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        _assertQuotableDay(s, dayId);

        uint256 lTotal = s.totalLenderInterestNumeraire18[dayId];
        uint256 bTotal = s.totalBorrowerInterestNumeraire18[dayId];
        uint8 lKey = uint8(LibVaipakam.RewardSide.Lender);
        uint8 bKey = uint8(LibVaipakam.RewardSide.Borrower);
        if (s.compQuoteConservation18[dayId][lKey] != lTotal) {
            revert CompQuoteIncomplete(
                dayId, lKey, s.compQuoteConservation18[dayId][lKey], lTotal
            );
        }
        if (s.compQuoteConservation18[dayId][bKey] != bTotal) {
            revert CompQuoteIncomplete(
                dayId, bKey, s.compQuoteConservation18[dayId][bKey], bTotal
            );
        }

        uint256 quotedL = s.compQuoteAccum18[dayId][lKey];
        uint256 quotedB = s.compQuoteAccum18[dayId][bKey];
        bool resolvedZero = quotedL == 0 && quotedB == 0;
        if (resolvedZero && !s.dayResolvedZero[dayId]) {
            // §2.3 — terminal on the MIRROR, before dispatch.
            s.dayResolvedZero[dayId] = true;
        }
        if (s.compQuoteSentAt[dayId] == 0) {
            s.compQuoteSentAt[dayId] = uint64(block.timestamp);
        }

        address messenger = s.rewardMessenger;
        if (messenger == address(0)) revert RewardMessengerNotSet();
        messageId = IRewardMessenger(messenger).sendCompQuote{
            value: msg.value
        }(dayId, quotedL, quotedB, refundAddress);

        emit CompQuoteDispatched(
            dayId, quotedL, quotedB, resolvedZero, messageId
        );
    }

    /**
     * @notice #1434 P2-w3 — Base-side trusted ingress for a mirror's
     *         compensation quote. Stores EVIDENCE, never funding: the
     *         manual compensation dispatch is bounded per side by the
     *         standing quote. A (0,0) quote is the resolved-zero signal —
     *         it clears the chain-day's remit-ineligibility (§2.3; nothing
     *         to compensate) and bounds funding to zero.
     * @dev    Messenger-gated + canonical-only. A re-delivered or re-sent
     *         quote OVERWRITES while the day is unfunded (idempotent for
     *         identical figures — the honest case, since the mirror's
     *         inputs are frozen) and is REJECTED once funded: the funded
     *         amount was bounded by the quote standing at dispatch, which
     *         is the receipt-bound obligation the w4 supplemental tops up
     *         against.
     */
    function onCompQuoteReceived(
        uint32 sourceChainId,
        uint256 dayId,
        uint256 quotedLender18,
        uint256 quotedBorrower18,
        address sourceEra
    ) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.rewardMessenger || s.rewardMessenger == address(0))
        {
            revert NotAuthorizedRewardMessenger();
        }
        if (!s.isCanonicalRewardChain) revert NotCanonicalRewardChain();
        if (!s.dailyGlobalFinalized[dayId]) {
            revert CompQuoteDayNotFinalized(dayId);
        }
        LibVaipakam.CompQuote storage q = s.compQuote[dayId][sourceChainId];
        // Only a chain-day zeroed out of the denominator has anything to
        // quote; an existing record admits re-delivery after the (0,0)
        // path cleared the live flag.
        if (
            !s.chainDayCommitments[dayId][sourceChainId].remitIneligible
                && q.receivedAt == 0
        ) {
            revert CompQuoteDayNotIneligible(dayId, sourceChainId);
        }
        if (s.dayClosedByRemitId[sourceChainId][dayId] != 0) {
            revert CompQuoteDayAlreadyFunded(dayId, sourceChainId);
        }
        // #1636 r1+r2 — two-layer era authentication, mirroring the V3
        // broadcast's own gate family. LAYER 1 (r2, the ground truth):
        // the CONFIGURED current mirror Diamond for this chain — the
        // reciprocal of the mirror-side `baseRewardDeployment` — checked
        // on EVERY arrival including the first, fail-closed while unset.
        // Without it, a delayed retired-era wire arriving FIRST (or first
        // after a {clearCompQuote}) would bind unchallenged, and a stale
        // (0,0) would clear the day's manual-funding anchor permanently.
        // LAYER 2 (r1, the standing-evidence record): the era the quote
        // was bound to at storage — protects a standing quote across a
        // registry rotation (new-era wires diverge from the old record
        // until the operator clears it deliberately via {clearCompQuote}).
        // Same-era re-delivery refreshes (the honest lost-message retry).
        {
            address expected = s.mirrorRewardDeployment[sourceChainId];
            if (expected == address(0)) {
                revert CompQuoteMirrorEraUnset(sourceChainId);
            }
            if (sourceEra != expected) {
                revert CompQuoteEraMismatch(
                    dayId, sourceChainId, expected, sourceEra
                );
            }
        }
        if (q.receivedAt != 0 && q.era != sourceEra) {
            revert CompQuoteEraMismatch(
                dayId, sourceChainId, q.era, sourceEra
            );
        }

        q.lender18 = quotedLender18;
        q.borrower18 = quotedBorrower18;
        q.receivedAt = uint64(block.timestamp);
        q.era = sourceEra;
        emit CompQuoteStored(
            dayId, sourceChainId, quotedLender18, quotedBorrower18
        );

        if (
            quotedLender18 == 0 && quotedBorrower18 == 0
                && s.chainDayCommitments[dayId][sourceChainId].remitIneligible
        ) {
            // §2.3 — the genuinely-zero day: nothing to compensate, the
            // flag's manual-funding anchor is retired. Same clearing the
            // operator reconcile performs, driven by authenticated mirror
            // evidence instead.
            s.chainDayCommitments[dayId][sourceChainId].remitIneligible =
                false;
            emit CompQuoteResolvedZero(dayId, sourceChainId);
        }
    }

    /// @notice #1434 P2-w3 (#1636 r2) — the operator registered (or
    ///         rotated) a chain's current mirror Diamond — the quote
    ///         ingress's era ground truth.
    /// @custom:event-category informational/reward-compensation
    event MirrorRewardDeploymentSet(
        uint32 indexed chainId,
        address indexed deployment
    );

    /// @notice Register the CURRENT mirror Diamond for `chainId` — the
    ///         fail-closed ground truth the quote ingress authenticates
    ///         every arrival's era word against (#1636 r2; the reciprocal
    ///         of the mirror-side `setBaseRewardDeployment`).
    /// @dev ADMIN-only. Part of the mirror-rotation ceremony: update this,
    ///      then {clearCompQuote} any quote standing under the retired era.
    function setMirrorRewardDeployment(
        uint32 chainId,
        address deployment
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.storageSlot().mirrorRewardDeployment[chainId] =
            deployment;
        emit MirrorRewardDeploymentSet(chainId, deployment);
    }

    /// @notice #1434 P2-w3 (#1636 r2) — the configured current mirror
    ///         Diamond for `chainId` (zero = quote ingress fail-closed).
    function getMirrorRewardDeployment(
        uint32 chainId
    ) external view returns (address) {
        return LibVaipakam.storageSlot().mirrorRewardDeployment[chainId];
    }

    /// @notice #1434 P2-w3 (#1636 r1) — an operator cleared a chain-day's
    ///         standing quote (mirror era rotated; the new era re-quotes).
    /// @custom:event-category informational/reward-compensation
    event CompQuoteCleared(uint256 indexed dayId, uint32 indexed chainId);

    /// @notice Clear a chain-day's standing quote so a rotated mirror era
    ///         can quote afresh.
    /// @dev ADMIN-only, and only while the day is UNFUNDED — once funded,
    ///      the quote that stood at dispatch is the receipt-bound
    ///      obligation and must stay on record. This is the operator
    ///      escape for the era binding above: without it, a mirror
    ///      redeploy would wedge the day behind a stale-era quote that
    ///      every honest re-delivery diverges from. Clearing does NOT
    ///      restore a `remitIneligible` flag a stale (0,0) may have
    ///      cleared — the first-arrival window is the accepted residual,
    ///      exactly the w2 provisional-credit posture.
    function clearCompQuote(
        uint256 dayId,
        uint32 chainId
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.dayClosedByRemitId[chainId][dayId] != 0) {
            revert CompQuoteDayAlreadyFunded(dayId, chainId);
        }
        LibVaipakam.CompQuote storage q = s.compQuote[dayId][chainId];
        // #1636 r4 — a RESOLVED-ZERO record is terminal, not clearable:
        // its (0,0) ingress already retired `remitIneligible`, so a
        // deleted record leaves `receivedAt == 0 && !remitIneligible` —
        // outside every admission path, with no production route back.
        // Nothing is lost by refusing: the quote is deterministic from
        // frozen inputs, so a re-quote under ANY era is (0,0) again —
        // the day is genuinely zero, and this record is its receipt.
        if (
            q.receivedAt != 0 && q.lender18 == 0 && q.borrower18 == 0
                && !s.chainDayCommitments[dayId][chainId].remitIneligible
        ) {
            revert CompQuoteResolvedZeroFinal(dayId, chainId);
        }
        delete s.compQuote[dayId][chainId];
        emit CompQuoteCleared(dayId, chainId);
    }

    /// @notice #1434 P2-w3 — a chain-day's standing quote on Base.
    function getCompQuote(
        uint256 dayId,
        uint32 chainId
    ) external view returns (LibVaipakam.CompQuote memory) {
        return LibVaipakam.storageSlot().compQuote[dayId][chainId];
    }

    /// @notice #1434 P2-w3 — the mirror-side quote accumulation state.
    function getCompQuoteAccum(uint256 dayId)
        external
        view
        returns (
            uint256 cursorLender,
            uint256 cursorBorrower,
            uint256 accumLender18,
            uint256 accumBorrower18,
            uint256 conservationLender18,
            uint256 conservationBorrower18,
            uint64 sentAt
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint8 lKey = uint8(LibVaipakam.RewardSide.Lender);
        uint8 bKey = uint8(LibVaipakam.RewardSide.Borrower);
        return (
            s.compQuoteEntryCursor[dayId][lKey],
            s.compQuoteEntryCursor[dayId][bKey],
            s.compQuoteAccum18[dayId][lKey],
            s.compQuoteAccum18[dayId][bKey],
            s.compQuoteConservation18[dayId][lKey],
            s.compQuoteConservation18[dayId][bKey],
            s.compQuoteSentAt[dayId]
        );
    }

    /// @notice #1434 P2-w3 — whether this day is resolved-zero on this
    ///         mirror (§2.3: quoted zero on both sides; prices zero through
    ///         the ordinary walk).
    function getDayResolvedZero(uint256 dayId) external view returns (bool) {
        return LibVaipakam.storageSlot().dayResolvedZero[dayId];
    }
}
