// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {LibCommitmentReport} from "../libraries/LibCommitmentReport.sol";
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
}
