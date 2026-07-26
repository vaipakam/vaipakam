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
 *         The liability, per side, is the residual capped sum
 *
 *           liability_side(D) = Σ_users min( rawPay_user , C_side − paid )
 *             rawPay_user = Σ (user's active entries) perDayNumeraire18 × Δ_D / 1e18
 *             C_side      = dayUserSideCap{Lender,Borrower}Vpfi18[D]  (broadcast verbatim)
 *             paid        = userSideDayPaidVpfi[user][side][D]        (≈0 at report time —
 *                           a mirror holds no VPFI until Base remits)
 *
 *         On a mirror the per-LOAN reward cap is inert (mirror loans are
 *         unstamped — {LibInteractionRewards} openDays==0), so the D1
 *         `(user,side,day)` share cap `C_side` is the sole binding constraint;
 *         the commitment "unit" is therefore a USER, not a loan (per-loan on
 *         Base). This is NOT the "aggregate-only headroom" the tokenomics
 *         redesign forbids — every unit's contribution is recomputed from the
 *         mirror's OWN storage, so the keeper that feeds the batches cannot
 *         inflate the figure.
 *
 *         Completeness — a busy day's report must never omit a user (that would
 *         UNDER-state the liability and permanently under-fund the mirror), yet
 *         there is no per-day active-user index. It is proven by DEMAND
 *         CONSERVATION, an EXACT integer identity with no maintained count:
 *
 *           Σ_submitted-entries perDayNumeraire18  ==  totalSideInterestNumeraire18[D]
 *
 *         because {LibInteractionRewards} folds exactly the same per-entry
 *         `perDayNumeraire18` into `totalSideInterestNumeraire18[D]` (via the
 *         difference-array `+perDay at start / -perDay at end`), and reward-INELIGIBLE
 *         (feed-fail) loans create no entry and no fold — so they are in NEITHER
 *         sum. An omitted user drops `conservation` below the total and the day
 *         never completes (delays, never zeroes); the frontier need not have
 *         reached `D` yet (the total is 0 until it does, so completeness simply
 *         waits for the interest close). Double-counting is barred by a
 *         STRICTLY-INCREASING user-address cursor (each user accumulated once)
 *         plus a within-batch duplicate-entry guard.
 *
 * @dev    Mirror-only + read-only against the reward ledger: it stamps only its
 *         own accumulators, never pays out and never touches the recycle
 *         bucket, so it is safe to run while mirror armed-day CLAIM pricing is
 *         still halted (B2-d4 lifts that). Δ_D comes from
 *         {LibInteractionRewards.dailyDeltaForCommitment} (the halt-independent
 *         stamp read), so it never advances the halted cumulative cursor.
 */
library LibCommitmentReport {
    uint256 private constant ONE = 1e18;

    /**
     * @notice Accumulate one keeper-fed batch of per-user commitment units into
     *         the `(dayId, side)` accumulators.
     * @dev    `users` MUST be strictly ascending by address (the per-day dedup),
     *         and `users[i]`'s full set of day-`dayId` entries is `entryIds[i]`
     *         — a user's cap is applied to their WHOLE `rawPay`, so a user may
     *         not be split across batches (the cursor forbids re-submission).
     *         Reverts if the day is unarmed, its stamp has not arrived, the
     *         report was already sent, ordering breaks, or an entry does not
     *         belong to `(user, side)` / cover the day.
     */
    function accumulateBatch(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        LibVaipakam.RewardSide side,
        address[] calldata users,
        uint256[][] calldata entryIds
    ) internal {
        if (s.commitmentReportSent[dayId]) {
            revert IVaipakamErrors.CommitmentReportAlreadySent(dayId);
        }
        if (users.length != entryIds.length) {
            revert IVaipakamErrors.CommitmentEntryMismatch(0);
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
        uint256 cursor = s.commitmentUserCursor[dayId][sideKey];

        uint256 liabilityAdd;
        uint256 conservationAdd;
        uint256 n = users.length;
        for (uint256 i; i < n; ) {
            address user = users[i];
            uint256 key = uint256(uint160(user));
            // Strictly increasing ⇒ each user accumulated at most once.
            if (key <= cursor) {
                revert IVaipakamErrors.CommitmentUsersNotAscending(user);
            }
            cursor = key;

            (uint256 rawPay, uint256 perDaySum) =
                _userRawPay(s, dayId, side, delta, user, entryIds[i]);

            uint256 paid = s.userSideDayPaidVpfi[user][sideKey][dayId];
            uint256 remaining = cap > paid ? cap - paid : 0;
            liabilityAdd += rawPay < remaining ? rawPay : remaining;
            conservationAdd += perDaySum;
            unchecked {
                ++i;
            }
        }

        s.commitmentUserCursor[dayId][sideKey] = cursor;
        s.commitmentLiabilityAccum18[dayId][sideKey] += liabilityAdd;
        s.commitmentConservationAccum18[dayId][sideKey] += conservationAdd;
    }

    /// @dev One user's uncapped `rawPay` for `dayId` (Σ entry contributions) and
    ///      the `perDayNumeraire18` sum (the conservation term). Every entry is
    ///      recomputed from storage and validated to belong to `(user, side)`
    ///      and cover the day — the mirror is the authority on its own state, so
    ///      the keeper cannot inflate either figure. Entries covering the day
    ///      are included REGARDLESS of processed/forfeited/closed status: the
    ///      liability is FORWARD-LOOKING (what Base must fund so the day can pay
    ///      out on close), and it must match the conservation total, which also
    ///      counts every covering entry until its `endDay`.
    function _userRawPay(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        LibVaipakam.RewardSide side,
        uint256 delta,
        address user,
        uint256[] calldata entryIds
    ) private view returns (uint256 rawPay, uint256 perDaySum) {
        uint256 n = entryIds.length;
        for (uint256 i; i < n; ) {
            uint256 id = entryIds[i];
            LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
            uint256 start = e.startDay == 0 ? 1 : e.startDay;
            if (
                e.user != user ||
                e.side != side ||
                dayId < start ||
                dayId >= e.endDay
            ) {
                revert IVaipakamErrors.CommitmentEntryMismatch(id);
            }
            // Within-batch duplicate would double-count both sums.
            for (uint256 j; j < i; ) {
                if (entryIds[j] == id) {
                    revert IVaipakamErrors.CommitmentEntryMismatch(id);
                }
                unchecked {
                    ++j;
                }
            }
            uint256 perDay = e.perDayNumeraire18;
            perDaySum += perDay;
            // Same floored form as the claim path
            // ({LibInteractionRewards._contribFor}: perDay × Δ_D / 1e18).
            rawPay += (perDay * delta) / ONE;
            unchecked {
                ++i;
            }
        }
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
    ///         (Base finalized the day and its broadcast landed here).
    /// @dev The send-side race guard: demand conservation is only meaningful
    ///      once this mirror's day-`dayId` interest totals are FINAL, i.e. its
    ///      own interest close folded them. The stamp proves that transitively
    ///      — Base can only finalize (and so broadcast the stamp) once this
    ///      chain's interest report was included (or the chain was zeroed, in
    ///      which case it is already remit-ineligible-pending-reconciliation).
    ///      Without this guard a keeper could report a quiet-LOOKING day
    ///      (totals still 0 pre-close ⇒ trivially "complete") as `(0, 0)`,
    ///      permanently understating the liability (the send is once-per-day).
    function hasFundingStamp(
        LibVaipakam.Storage storage s,
        uint256 dayId
    ) internal view returns (bool) {
        return s.chainDayRecycledFunding[dayId][uint32(block.chainid)].stamped;
    }

    /// @notice True iff `(dayId, side)`'s reported units EXHAUST the day's
    ///         interest demand — the demand-conservation completeness proof.
    /// @dev    A side with zero interest (`total == 0`) is trivially complete
    ///         with zero liability and needs no batch.
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
