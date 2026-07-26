// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibInteractionRewards} from "./LibInteractionRewards.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title  LibCommitmentReport
 * @author Vaipakam Developer Team
 * @notice #1222 M3 B2-d1 — a MIRROR computes its day-`D` per-side claimable
 *         LIABILITY and reports it to the canonical (Base) reward chain, which
 *         marks the chain-day report-complete (`ChainDayCommitments.complete`
 *         — the B2-d2 REMIT gate: ShareOfPool remittance for the chain-day
 *         waits for it) and, in B2-d2, clamps that remittance to
 *         `min(uncappedSlice, liability − remitted − pending)`. The report is
 *         computable only AFTER Base finalizes + broadcasts day `D` (the caps
 *         + funding stamp it prices from are finalize outputs), so it never
 *         gates finalization itself.
 *
 *         The liability, per side, is the per-ENTRY capped sum
 *
 *           liability_side(D) = Σ_covering-entries min( rawPay_e , C_side )
 *             rawPay_e = perDayNumeraire18_e × Δ_D / 1e18
 *             C_side   = dayUserSideCap{Lender,Borrower}Vpfi18[D]  (broadcast verbatim)
 *
 *         The unit is the reward ENTRY, deliberately NOT the user (Codex
 *         #1425 r1): `repointRewardEntry` rewrites `RewardEntry.user` on
 *         position transfers, so any per-user grouping fixed at report time
 *         can be regrouped before the entries become claimable — a report
 *         capped on the report-time grouping could then UNDER-state the true
 *         liability and the remit clamp would underfund the mirror. The
 *         per-entry figure is transfer-invariant, and because
 *         `min(a+b, C) ≤ min(a, C) + min(b, C)` it is the exact supremum of
 *         the per-user capped sum over every possible regrouping — it can
 *         never under-state, and any over-reservation (a user holding several
 *         cap-binding entries) is bounded and swept back by the B2-d3
 *         netting. No `paid` term is subtracted: mirror payouts for an armed
 *         day are clamped by `remittedRemaining` (rev-15), remittance waits
 *         for THIS report, and the report precedes any remit — so
 *         `userSideDayPaidVpfi` is structurally zero at report time, and
 *         including it would re-introduce user-keyed (transfer-variant)
 *         state.
 *
 *         Completeness — a busy day's report must never omit an entry (that
 *         would UNDER-state the liability and permanently under-fund the
 *         mirror), yet there is no per-day entry index. It is proven by
 *         DEMAND CONSERVATION, an EXACT integer identity with no maintained
 *         count:
 *
 *           Σ_submitted-entries perDayNumeraire18  ==  totalSideInterestNumeraire18[D]
 *
 *         because {LibInteractionRewards} folds exactly the same per-entry
 *         `perDayNumeraire18` into `totalSideInterestNumeraire18[D]` (via the
 *         difference-array `+perDay at start / -perDay at end`), and
 *         reward-INELIGIBLE (feed-fail) loans create no entry and no fold —
 *         so they are in NEITHER sum. An omitted entry keeps `conservation`
 *         below the total and the day never completes (delays, never
 *         zeroes). Double-counting is barred by a STRICTLY-INCREASING
 *         per-(day, side) entry-id cursor — which also makes each batch
 *         internally ascending, so duplicate detection is O(1) per entry
 *         (Codex #1425 r1: the former per-user scheme needed an O(n²)
 *         within-batch scan and an unbounded whole-set-per-user rule).
 *         Entries covering the day are included REGARDLESS of
 *         processed/forfeited/closed status: the liability is
 *         FORWARD-LOOKING and must match the conservation total, which also
 *         counts every covering entry until its `endDay`.
 *
 * @dev    Mirror-only + read-only against the reward ledger: it stamps only
 *         its own accumulators, never pays out and never touches the recycle
 *         bucket, so it is safe to run while mirror armed-day CLAIM pricing
 *         is still halted (B2-d4 lifts that). Δ_D comes from
 *         {LibInteractionRewards.dailyDeltaForCommitment} (the
 *         halt-independent stamp read), so it never advances the halted
 *         cumulative cursor. Day-`D` coverage of an entry is IMMUTABLE by
 *         accumulation time: batches require the day's funding stamp, which
 *         Base only broadcasts after `D` has elapsed, and a post-`D` early
 *         close sets `endDay` to the (later) current day — so `startDay ≤ D
 *         < endDay` cannot change under the cursor.
 */
library LibCommitmentReport {
    uint256 private constant ONE = 1e18;

    /**
     * @notice Accumulate one keeper-fed batch of day-covering reward entries
     *         into the `(dayId, side)` accumulators.
     * @dev    `entryIds` MUST be strictly ascending and strictly above the
     *         stored cursor (the dedup). Every entry is recomputed from
     *         storage and validated to be on `side` and cover the day — the
     *         mirror is the authority on its own state, so the keeper cannot
     *         inflate or distort either figure; it can only delay. Reverts if
     *         the day is unarmed, its stamp has not arrived, the report was
     *         already sent, ordering breaks, or an entry does not match.
     */
    function accumulateBatch(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        LibVaipakam.RewardSide side,
        uint256[] calldata entryIds
    ) internal {
        if (s.commitmentReportSent[dayId]) {
            revert IVaipakamErrors.CommitmentReportAlreadySent(dayId);
        }
        // Δ_D from THIS chain's own stamp — halt-independent. `priceable` false
        // ⇒ either unarmed (nothing to report) or the broadcast has not landed.
        (uint256 delta, bool priceable) =
            LibInteractionRewards.dailyDeltaForCommitment(s, side, dayId);
        if (!priceable) {
            if (!isDayArmed(s, dayId)) {
                revert IVaipakamErrors.CommitmentDayNotArmed(dayId);
            }
            revert IVaipakamErrors.CommitmentStampNotArrived(dayId);
        }

        uint8 sideKey = uint8(side);
        uint256 cap = side == LibVaipakam.RewardSide.Lender
            ? s.dayUserSideCapLenderVpfi18[dayId]
            : s.dayUserSideCapBorrowerVpfi18[dayId];
        uint256 cursor = s.commitmentEntryCursor[dayId][sideKey];

        uint256 liabilityAdd;
        uint256 conservationAdd;
        uint256 n = entryIds.length;
        for (uint256 i; i < n; ) {
            uint256 id = entryIds[i];
            // Strictly increasing ⇒ each entry accumulated at most once, and
            // the batch is internally duplicate-free by construction.
            if (id <= cursor) {
                revert IVaipakamErrors.CommitmentEntriesNotAscending(id);
            }
            cursor = id;

            LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
            uint256 start = e.startDay == 0 ? 1 : e.startDay;
            if (e.side != side || dayId < start || dayId >= e.endDay) {
                revert IVaipakamErrors.CommitmentEntryMismatch(id);
            }

            uint256 perDay = e.perDayNumeraire18;
            conservationAdd += perDay;
            // Same floored form as the claim path
            // ({LibInteractionRewards._contribFor}: perDay × Δ_D / 1e18).
            uint256 rawPay = (perDay * delta) / ONE;
            liabilityAdd += rawPay < cap ? rawPay : cap;
            unchecked {
                ++i;
            }
        }

        s.commitmentEntryCursor[dayId][sideKey] = cursor;
        s.commitmentLiabilityAccum18[dayId][sideKey] += liabilityAdd;
        s.commitmentConservationAccum18[dayId][sideKey] += conservationAdd;
    }

    /// @notice True iff `dayId` is inside the governor's commitment-armed
    ///         window. Unarmed days have no gate on Base and MUST NOT be
    ///         reported: a zero-interest unarmed day is trivially "complete"
    ///         (0 == 0 conservation), so without this guard the keeper's
    ///         readiness trigger would see every quiet pre-arming day as
    ///         sendable and burn CCIP fees on reports Base never consults.
    function isDayArmed(
        LibVaipakam.Storage storage s,
        uint256 dayId
    ) internal view returns (bool) {
        uint256 armedFrom = s.governorCommitArmedFromDay;
        return armedFrom != 0 && dayId >= armedFrom;
    }

    /// @notice True iff this chain's day-`dayId` funding stamp has arrived
    ///         (Base finalized the day and its broadcast landed here) — the
    ///         pricing precondition for every batch.
    function hasFundingStamp(
        LibVaipakam.Storage storage s,
        uint256 dayId
    ) internal view returns (bool) {
        return s.chainDayRecycledFunding[dayId][uint32(block.chainid)].stamped;
    }

    /// @notice True iff this mirror's OWN day-`dayId` interest close ran
    ///         (`RewardReporterFacet.closeDay` — `chainReportSentAt` is
    ///         stamped right after the fold that finalizes
    ///         `totalSideInterestNumeraire18[dayId]`).
    /// @dev    The send-side race guard (Codex #1425 r1): a Base grace/force
    ///         finalize stamps this mirror even when its own close never ran,
    ///         so stamp arrival alone does NOT prove the totals demand
    ///         conservation is checked against are final. Before the local
    ///         close a busy day LOOKS quiet (totals still 0 ⇒ trivially
    ///         "complete") and the once-only report could ship an
    ///         irreversible `(0, 0)`.
    function hasLocalInterestClose(
        LibVaipakam.Storage storage s,
        uint256 dayId
    ) internal view returns (bool) {
        return s.chainReportSentAt[dayId] != 0;
    }

    /// @notice True iff `(dayId, side)`'s reported entries EXHAUST the day's
    ///         interest demand — the demand-conservation completeness proof.
    /// @dev    A side with zero interest (`total == 0`) is trivially complete
    ///         with zero liability and needs no batch. Only meaningful once
    ///         {hasLocalInterestClose} — callers on the send path gate on it.
    function isSideComplete(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        LibVaipakam.RewardSide side
    ) internal view returns (bool) {
        uint256 total = side == LibVaipakam.RewardSide.Lender
            ? s.totalLenderInterestNumeraire18[dayId]
            : s.totalBorrowerInterestNumeraire18[dayId];
        return s.commitmentConservationAccum18[dayId][uint8(side)] == total;
    }

    /// @notice True iff BOTH sides' commitments are complete for `dayId`.
    function isDayComplete(
        LibVaipakam.Storage storage s,
        uint256 dayId
    ) internal view returns (bool) {
        return
            isSideComplete(s, dayId, LibVaipakam.RewardSide.Lender) &&
            isSideComplete(s, dayId, LibVaipakam.RewardSide.Borrower);
    }

    /// @notice The accumulated per-side liability for `dayId` (the figure the
    ///         report ships once the day is complete).
    function sideLiability(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        LibVaipakam.RewardSide side
    ) internal view returns (uint256) {
        return s.commitmentLiabilityAccum18[dayId][uint8(side)];
    }
}
