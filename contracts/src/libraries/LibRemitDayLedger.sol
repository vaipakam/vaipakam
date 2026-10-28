// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibInteractionRewards} from "./LibInteractionRewards.sol";
import {LibVpfiRecycle} from "./LibVpfiRecycle.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title  LibRemitDayLedger — #918 a remit day sent in PARTS (Base side)
 * @author Vaipakam Developer Team
 * @notice The ONE per-day remit rule on Base: what a (destination, day) owes
 *         in all (its WHOLE slice, per component), how much of it one send
 *         moves (a PART, no larger than the caller's part cap), what that part
 *         retires of the day's finalize-time commitments, and how a part is
 *         applied and released.
 *
 *         Before #918 a day's slice had to go in ONE send, and a day whose
 *         slice exceeded the CCIP lane's rate-limit capacity could never be
 *         sent (owner decision 2026-10-27, "Send in parts"). Now a day may go
 *         in several sends. Each part is its own reservation; the day-close
 *         markers stand only once the WHOLE slice has gone, and the mirror
 *         opens the day (the #1944 delivery gate) only once the whole slice
 *         has landed there, summed per component. The whole travels on every
 *         part's wire (d7), so the mirror needs no count of parts.
 *
 * @dev    The whole is LOCKED at the day's first part and never changed after,
 *         not even by a release: it is the record the wire's whole figure
 *         comes from, so every part of a day carries the same one. The inputs
 *         it is computed from are fixed by then (the day is finalized and its
 *         commitment report is write-once), and the lock makes that a stated
 *         fact rather than an assumption about other writers.
 *
 *         THE GATES ADMIT A PART ON THE DAY'S REMAINING OWED, never on the
 *         part alone: the fresh-headroom gate and the net recycled-backing
 *         gate each test what sending the day's whole remaining owed now would
 *         need ({DayPlan}'s gate figures), while the part moves only what the
 *         cap allows. So a part is admitted exactly when a whole-in-one send
 *         of the rest would be, on an armed day and an unarmed one alike, so
 *         no day starts on a margin its whole does not fit; the pool hold
 *         below keeps that margin for the day until its last part. Testing
 *         the part alone would admit an unarmed day's early parts against a
 *         margin its whole exceeds, and stall it half sent once the margin
 *         ran out.
 *
 *         THE POOL HOLD (Codex #2959 r1, r3). Passing the gate is not enough
 *         on its own: between two parts, another mirror's send or a Base
 *         claim could take the margin the rest of the day needs, and the
 *         mirror, waiting for the whole, would never open the day. So EVERY
 *         day, armed or not, holds its own unsent fresh from its first part
 *         on: that part RESERVES the day's whole fresh in
 *         `remitDayFreshReserved`, which the one pool-headroom definition
 *         ({LibInteractionRewards.poolRemaining}) counts as used, so every
 *         spender of the pool sees it (claims, sweeps, staging, day sizing,
 *         sends). Each part then moves its own fresh from the hold into
 *         `rewardBudgetRemittedGlobal`, so a day sent in parts holds the pool
 *         exactly as a send of its whole in one would. A released part's
 *         fresh is uncovered again (its first charge stays spent) and the
 *         next part re-reserves it against the headroom.
 *
 *         An ARMED day's finalize-time commitment (`outstandingCommitFresh`)
 *         is not that hold, and r3 is why: only day sizing and sends net the
 *         commitments out of the pool, while a Base claim or sweep for an
 *         unarmed day reads `poolRemaining` alone, so a commitment left
 *         standing for the unsent rest could be spent from under the day.
 *         The first part therefore CONVERTS the day's whole fresh commitment
 *         into the hold: it retires all of it (the clamp residual included)
 *         and reserves the clamped whole. The pool is unchanged for everyone
 *         else except the residual, which is never sent and is freed exactly
 *         as before. The conversion is permanent: the whole is locked, so a
 *         release never restores the fresh commitment; the released fresh is
 *         uncovered, as on an unarmed day. The RECYCLED commitments are
 *         unchanged: a part retires its own, and a release restores them.
 *
 *         THE CLAMP RESIDUAL — what an armed day committed and will never send
 *         (`armedWhole* − whole*`) — is retired by the FIRST live part (the
 *         part that finds `residualRemitId == 0`), not by the last, so the
 *         margin a later part is tested against already carries it. The fresh
 *         residual goes with the conversion above, once. The recycled
 *         residual is the part's to retire: a release of the part that
 *         retired it clears `residualRemitId`, and the next part re-retires
 *         it — exactly once per live set of parts.
 *
 *         A whole-in-one send is the case where the part cap is at least the
 *         day's remaining owed: one part that both retires and completes.
 *
 *         Inlined into `RewardRemittanceFacet` (plan + apply) and
 *         `RewardCompensationDispatchFacet` (release); one body, so the send,
 *         every quote and the release read one rule.
 */
library LibRemitDayLedger {
    using EnumerableSet for EnumerableSet.UintSet;

    /// @notice Why a day of a remittance plan does or does not move this batch,
    ///         one value per input day (#2760, #918). Read with
    ///         `RewardRemittanceFacet.quoteRemitDayStatuses`.
    /// @dev    Produced by {planDay} (and the batch walk's backing gate), so a
    ///         status is the send's own verdict, not a reconstruction.
    ///         Settled: `Remitted`, `Closed` (the whole slice has gone).
    ///         Nothing owed: `NothingOwed`. Still owed: `Ineligible` (funded by
    ///         the manual-budget path), `AwaitingCommitment` (an armed day with
    ///         a budget for this mirror whose commitment report is not
    ///         complete), `Unbacked` (its recycled part fails the net backing
    ///         gate in THIS batch, after the days listed before it). Not judged:
    ///         `NotFinalized`, `Repeated` (a later copy of an earlier entry).
    ///         `Closeable`: this batch would complete the day, possibly moving
    ///         zero. `Partial` (#918, appended): this batch moves a part of the
    ///         day under the caller's part cap and the day stays OPEN, owing the
    ///         rest. `Abandoned` (#2963, appended): the destination was taken
    ///         off Base's expected-source list after this day, so the day is
    ///         never sent to it again; settled, as lost. The zero value is not
    ///         `Closeable`, so a status left unset can never read as one.
    enum RemitDayStatus {
        NotFinalized,
        Repeated,
        Remitted,
        Closed,
        NothingOwed,
        Ineligible,
        AwaitingCommitment,
        Unbacked,
        Closeable,
        Partial,
        Abandoned
    }

    /// @notice One day's plan for one send: the day's whole, and the part this
    ///         send moves of it.
    /// @dev    `act` marks a day this send applies a part to (all filters
    ///         passed). The part figures are what the send charges for the day:
    ///         `fresh` / `recycled` move, `armedFresh` / `recycledFull` are the
    ///         commitments retired (the part's own amounts, plus the clamp
    ///         residual when `retires`), `residual` the recycled clamp residual
    ///         released without consumption. `completes` marks the part that
    ///         makes the day whole.
    struct DayPlan {
        RemitDayStatus status;
        bool act;
        bool completes;
        bool retires;
        bool armed;
        uint256 fresh;
        uint256 recycled;
        uint256 armedFresh;
        uint256 recycledFull;
        uint256 residual;
        uint256 wholeFresh;
        uint256 wholeRecycled;
        uint256 armedWholeFresh;
        uint256 armedWholeRecycled;
        // #918 — the GATE figures: what the day still owes before this part,
        // and what sending all of it now would retire. Every gate admits a
        // part on these, so a part passes exactly when sending the day's
        // whole remaining owed in one send would (see {_part}).
        uint256 owedFresh;
        uint256 owedRecycled;
        uint256 gateArmedFresh;
        uint256 gateRecycledFull;
        // #918 (Codex #2959 r1, r3) — the POOL HOLD. `gateFresh` is the fresh
        // this send must find NEW room for in the 69M pool, and `cover` what
        // the day reserves now (`remitDayFreshReserved`): both are the day's
        // owed fresh not yet held — its whole at the first part, a released
        // part's fresh after that, otherwise nothing. An armed day's first part
        // finds that room net of the commitment it converts (`gateArmedFresh`).
        uint256 gateFresh;
        uint256 cover;
    }

    /// @notice #918 — one part of a day's slice was sent to `dstChainId`.
    /// @param fresh / recycled          This part.
    /// @param sentFresh / sentRecycled  The day's live parts after this one.
    /// @param wholeFresh / wholeRecycled The day's whole slice (locked).
    /// @param whole                     The day is now whole: its close markers
    ///                                  stand, naming this reservation.
    /// @custom:event-category informational/reward-transport
    event RemitDayPartSent(
        uint32 indexed dstChainId,
        uint256 indexed dayId,
        uint256 indexed remitId,
        uint256 fresh,
        uint256 recycled,
        uint256 sentFresh,
        uint256 sentRecycled,
        uint256 wholeFresh,
        uint256 wholeRecycled,
        bool whole
    );

    /// @notice #918 — a released reservation's part was taken off its day: the
    ///         day owes it again, and is no longer whole.
    /// @custom:event-category informational/reward-transport
    event RemitDayPartReleased(
        uint32 indexed dstChainId,
        uint256 indexed dayId,
        uint256 indexed remitId,
        uint256 fresh,
        uint256 recycled,
        uint256 sentFresh,
        uint256 sentRecycled
    );

    /// @notice #2963 — `dstChainId` was taken off Base's expected-source list:
    ///         every day of it before `abandonedBefore` is abandoned (never
    ///         sent to it again), and the release walk below frees what Base
    ///         held for those days. The walk has released every day before
    ///         `releaseCursor`.
    /// @custom:event-category informational/reward-transport
    event RemitDestinationRemoved(
        uint32 indexed dstChainId,
        uint256 abandonedBefore,
        uint256 releaseCursor
    );

    /// @notice #2963 — one abandoned day's hold toward `dstChainId` released.
    ///         The day is never sent, so the destination's users lose it.
    /// @param locked         A part of the day had been sent (the day carries a
    ///                       ledger); otherwise no part ever went.
    /// @param heldFresh      The day's unsent fresh, freed from the pool hold
    ///                       (`remitDayFreshReserved`); a locked day only.
    /// @param commitFresh    The armed fresh commitment freed
    ///                       (`outstandingCommitFresh`); an unlocked day only
    ///                       (a locked day's became its hold at its first part).
    /// @param commitRecycled The armed recycled commitment freed
    ///                       (`outstandingCommitRecycled`): the unsent rest,
    ///                       with the clamp residual when no live part retired it.
    /// @custom:event-category informational/reward-transport
    event RemitAbandonedDayReleased(
        uint32 indexed dstChainId,
        uint256 indexed dayId,
        bool locked,
        uint256 heldFresh,
        uint256 commitFresh,
        uint256 commitRecycled
    );

    /// @notice #2963 — one run of the release walk toward `dstChainId`: it
    ///         has released every day before `releaseCursor`, and the release
    ///         is done once that reaches `abandonedBefore`.
    /// @custom:event-category informational/reward-transport
    event RemitDestinationReleaseWalked(
        uint32 indexed dstChainId,
        uint256 releaseCursor,
        uint256 abandonedBefore
    );

    /// @notice #2963 — a released part belonged to a day the walk had already
    ///         released: the recycled commitment the part retired at its send
    ///         is NOT restored, because the day is never sent and nothing
    ///         would ever retire it again.
    /// @custom:event-category informational/reward-transport
    event RemitAbandonedPartReleased(
        uint32 indexed dstChainId,
        uint256 indexed dayId,
        uint256 indexed remitId,
        uint256 recycledNotRestored
    );

    // ─── Plan ────────────────────────────────────────────────────────────

    /**
     * @notice The per-day eligibility + gate + clamp + part computation behind
     *         every remit site (the send and every quote).
     * @dev    #1222 M3 B2-d2 / #918. Acts on nothing (zeros, `act` false) when
     *         the day is already whole, remit-ineligible, gated (an armed day
     *         whose commitment report is not `.complete` — §M3's "delays,
     *         never zeroes"), or owes nothing. On an armed gate-passing day the
     *         Σcommitments clamp bounds the whole by the reported per-side
     *         liability total — safe because the per-entry report is the
     *         SUPREMUM of the mirror's eventual capped claims (design record
     *         §2c) — apportioned per side ({_sideLegs}). Pre-cutover days pass
     *         through unclamped.
     *
     *         A day whose ledger is LOCKED (a part was sent) reads its whole
     *         from the ledger and skips the eligibility tests: it passed them
     *         at the lock, `remitIneligible` is set only at finalization (before
     *         any remit) and the commitment report is write-once, so none can
     *         have turned against it since.
     *
     *         LOCKSTEP (#1944): the mirror's delivery gate
     *         (`LibRewardCustody.dayAwaitsFreshDelivery`) mirrors which days
     *         this plan sends fresh value for, and `dayDeliveryLanded` waits for
     *         exactly the whole slice this plan locks. A change to either rule
     *         changes the other in the same diff.
     * @param partCap The most VPFI this send moves for the day; the caller
     *                validates it (zero would plan a part of nothing).
     */
    function planDay(
        LibVaipakam.Storage storage s,
        uint32 dstChainId,
        uint256 dayId,
        uint256 armedFrom,
        uint256 partCap
    ) internal view returns (DayPlan memory p) {
        if (s.rewardBudgetRemitted[dstChainId][dayId] != 0) {
            p.status = RemitDayStatus.Remitted;
            return p;
        }
        if (s.dayClosedByRemitId[dstChainId][dayId] != 0) {
            p.status = RemitDayStatus.Closed;
            return p;
        }
        // #2963 — a day of a destination Base has taken off its list is never
        // sent to it again, locked or not; what it held is released by
        // {walkAbandoned}. This is the one deliberate break of the LOCKSTEP
        // below: the mirror's gate keeps holding such a day, waiting for a
        // whole that never comes, because the chain's users lose those days
        // (owner decision 2026-10-27, "On removal").
        if (isAbandoned(s, dstChainId, dayId)) {
            p.status = RemitDayStatus.Abandoned;
            return p;
        }
        LibVaipakam.RemitDayLedger storage l = s.remitDayLedger[dstChainId][dayId];
        if (l.locked) {
            p.armed = l.armed;
            p.wholeFresh = l.wholeFresh;
            p.wholeRecycled = l.wholeRecycled;
            p.armedWholeFresh = l.armedWholeFresh;
            p.armedWholeRecycled = l.armedWholeRecycled;
            _part(
                p, l.sentFresh, l.sentRecycled, l.freshUncovered,
                l.residualRemitId == 0, false, partCap
            );
            return p;
        }
        LibVaipakam.ChainDayCommitments storage c =
            s.chainDayCommitments[dayId][dstChainId];
        // #1222 M3 B2-c — never remit a (chain, day) a force-finalize marked
        // remit-ineligible-pending-reconciliation: its ShareOfPool budget was
        // sized without the chain's real demand. The funding vehicle is the
        // manual-budget path, never this slice.
        if (c.remitIneligible) {
            p.status = RemitDayStatus.Ineligible;
            return p;
        }
        (
            LibInteractionRewards.ChainDayBudget memory b,
            uint256 sliceFresh,
            uint256 sliceRecycled,
            uint256 localBacking
        ) = _slice(s, dstChainId, dayId);
        if (sliceFresh + sliceRecycled == 0 && localBacking == 0) {
            p.status = RemitDayStatus.NothingOwed;
            return p;
        }
        // The commitment gate runs AFTER the zero-budget test (#2760 r1): a
        // finalized day's budget is fixed, and the report can only clamp it
        // down, so a day that gave this mirror nothing owes nothing whether or
        // not its report has arrived.
        bool armed = armedFrom != 0 && dayId >= armedFrom;
        if (armed && !c.complete) {
            p.status = RemitDayStatus.AwaitingCommitment;
            return p;
        }
        p.armed = armed;
        if (armed) {
            p.armedWholeFresh = sliceFresh;
            p.armedWholeRecycled = sliceRecycled;
            // #1222 M3 B2-d3 (Codex #1430 r1→r2→r3) — the clamp is applied PER
            // SIDE: the mirror reports the liability per side, the two sides
            // carry different fresh:recycled compositions, and local RECYCLED
            // backing can only cover a recycled leg. The local backing is ONE
            // fungible pool on the mirror, so only the LEG SPLIT is per side;
            // the netting is aggregate.
            (uint256 freshLegL, uint256 recycledLegL) = _sideLegs(
                b.freshLender, b.recycledLender, c.liabilityLender18
            );
            (uint256 freshLegB, uint256 recycledLegB) = _sideLegs(
                b.freshBorrower, b.recycledBorrower, c.liabilityBorrower18
            );
            uint256 recycledLegs = recycledLegL + recycledLegB;
            p.wholeFresh = freshLegL + freshLegB;
            p.wholeRecycled = recycledLegs > localBacking
                ? recycledLegs - localBacking
                : 0;
        } else {
            p.wholeFresh = sliceFresh;
            p.wholeRecycled = sliceRecycled;
        }
        // Unlocked: nothing of the day is held yet, so all of it is uncovered,
        // and this part is the one that locks the day.
        _part(p, 0, 0, p.wholeFresh, true, true, partCap);
    }

    /// @dev The day's slice toward `dstChainId` before any clamp: the fresh, the
    ///      recycled net of the chain's own local backing, and that backing.
    ///      On an armed day the two slices are what the day COMMITTED toward
    ///      this chain at finalization (a whole send retires exactly them), so
    ///      {planDay} and the abandoned-day release read one figure.
    function _slice(
        LibVaipakam.Storage storage s,
        uint32 dstChainId,
        uint256 dayId
    )
        private
        view
        returns (
            LibInteractionRewards.ChainDayBudget memory b,
            uint256 sliceFresh,
            uint256 sliceRecycled,
            uint256 localBacking
        )
    {
        b = LibInteractionRewards.chainRewardBudgetSideSplitForDay(s, dstChainId, dayId);
        uint256 grossRecycled = b.recycledLender + b.recycledBorrower;
        localBacking = s.chainDayRecycledFunding[dayId][dstChainId].recycleConsume;
        if (localBacking > grossRecycled) localBacking = grossRecycled;
        sliceFresh = b.freshLender + b.freshBorrower;
        sliceRecycled = grossRecycled - localBacking;
    }

    /// @dev The part of `p`'s whole one send moves, given what the day's live
    ///      parts have already sent. Fresh first: the fresh component is what
    ///      the mirror's delivery gate waits on, so it is sent ahead of the
    ///      recycled one. `retires` is whether this part retires the day's
    ///      recycled clamp residual (no live part has). `uncovered` is the
    ///      day's owed fresh not yet held in the pool. `locking` is whether
    ///      this is the day's first part, which converts an armed day's fresh
    ///      commitment into the hold.
    function _part(
        DayPlan memory p,
        uint256 sentFresh,
        uint256 sentRecycled,
        uint256 uncovered,
        bool retires,
        bool locking,
        uint256 partCap
    ) private pure {
        uint256 owedFresh = p.wholeFresh - sentFresh;
        uint256 owedRecycled = p.wholeRecycled - sentRecycled;
        uint256 amount = owedFresh + owedRecycled;
        if (amount > partCap) amount = partCap;
        p.fresh = owedFresh < amount ? owedFresh : amount;
        p.recycled = amount - p.fresh;
        p.completes = p.fresh == owedFresh && p.recycled == owedRecycled;
        p.retires = retires;
        p.owedFresh = owedFresh;
        p.owedRecycled = owedRecycled;
        if (p.armed) {
            // RECYCLED keeps the commitment regime: a part retires its own
            // amount, and the retiring part the clamp residual as well.
            // FRESH: the first part retires the day's whole fresh commitment,
            // residual included, because the hold takes its place (see THE
            // POOL HOLD); no later part retires any. The armed whole is never
            // below the clamped whole (the clamp only lowers it), so the
            // residual cannot underflow.
            uint256 recycledResidual = retires ? p.armedWholeRecycled - p.wholeRecycled : 0;
            p.recycledFull = p.recycled + recycledResidual;
            p.residual = recycledResidual;
            p.gateRecycledFull = owedRecycled + recycledResidual;
            if (locking) {
                p.armedFresh = p.armedWholeFresh;
                p.gateArmedFresh = p.armedWholeFresh;
            }
        }
        // The day holds its own unsent fresh: the part reserves everything
        // uncovered, and only that needs new room. The rest is already held.
        p.gateFresh = uncovered;
        p.cover = uncovered;
        p.act = true;
        p.status = p.completes ? RemitDayStatus.Closeable : RemitDayStatus.Partial;
    }

    /**
     * @dev #1222 M3 B2-d3 (Codex #1430 r3) — split ONE reward side's claim
     *      exposure into its fresh and recycled LEGS, using that side's OWN
     *      pool composition and its OWN reported liability. Netting the
     *      chain's local backing is deliberately NOT done here: that backing is
     *      one fungible pool across both sides, so the caller nets it against
     *      the SUMMED recycled legs.
     *      Codex #1430 r4 — the CLAIM PATH's rounding convention: the recycled
     *      share is floored and fresh takes the remainder, so the fresh leg is
     *      never under-remitted.
     */
    function _sideLegs(
        uint256 sideFresh,
        uint256 sideRecycled,
        uint256 liability
    ) private pure returns (uint256 freshLeg, uint256 recycledLeg) {
        uint256 gross = sideFresh + sideRecycled;
        if (gross == 0) return (0, 0);
        if (liability >= gross) return (sideFresh, sideRecycled);
        recycledLeg = (liability * sideRecycled) / gross;
        freshLeg = liability - recycledLeg;
    }

    // ─── Apply ───────────────────────────────────────────────────────────

    /**
     * @notice Apply one planned part to its day under reservation `remitId`:
     *         lock the whole on the day's first part, add the part to the
     *         day's live sums, retire the clamp residual when this part does,
     *         and stand the day-close markers once the day is whole.
     * @dev    The caller has already decided every refusal on the plan; this
     *         writes only the day's own cells (and the residual's release), so
     *         applying the parts of one batch in any order gives one result.
     */
    function applyPart(
        LibVaipakam.Storage storage s,
        uint32 dstChainId,
        uint256 dayId,
        uint256 remitId,
        DayPlan memory p
    ) internal {
        LibVaipakam.RemitDayLedger storage l = s.remitDayLedger[dstChainId][dayId];
        if (!l.locked) {
            l.locked = true;
            l.armed = p.armed;
            l.wholeFresh = SafeCast.toUint128(p.wholeFresh);
            l.wholeRecycled = SafeCast.toUint128(p.wholeRecycled);
            l.armedWholeFresh = SafeCast.toUint128(p.armedWholeFresh);
            l.armedWholeRecycled = SafeCast.toUint128(p.armedWholeRecycled);
        }
        // Bounded by the whole (the plan never sends more than is owed), so
        // the narrowing cannot truncate.
        uint256 sentFresh = uint256(l.sentFresh) + p.fresh;
        uint256 sentRecycled = uint256(l.sentRecycled) + p.recycled;
        l.sentFresh = uint128(sentFresh);
        l.sentRecycled = uint128(sentRecycled);
        unchecked {
            ++l.partsSent;
            ++l.partsLive;
        }
        // The POOL HOLD (Codex #2959 r1, r3), armed day or not: reserve what
        // was uncovered, then move this part's fresh out of the hold — the
        // caller charges it to `rewardBudgetRemittedGlobal`. The hold already
        // carries the rest of the day (owed − uncovered), so it covers this
        // part and the subtraction cannot underflow. Afterwards the day holds
        // exactly what it still owes.
        s.remitDayFreshReserved = s.remitDayFreshReserved + p.cover - p.fresh;
        l.freshUncovered = 0;
        if (p.retires) {
            l.residualRemitId = remitId;
            if (p.residual > 0) {
                LibVpfiRecycle.releaseCommitment(
                    LibVpfiRecycle.RecycleSource.RemitClampResidual,
                    dayId,
                    p.residual
                );
            }
        }
        bool whole = _isWhole(l, sentFresh, sentRecycled);
        if (whole) {
            s.dayClosedByRemitId[dstChainId][dayId] = remitId;
            uint256 slice = uint256(l.wholeFresh) + l.wholeRecycled;
            if (slice > 0) s.rewardBudgetRemitted[dstChainId][dayId] = slice;
            s.remitOpenDays[dstChainId].remove(dayId);
        } else {
            // #2960 — a part that leaves the day owing: the day stays on the
            // destination's open list until its last part (or the walk).
            s.remitOpenDays[dstChainId].add(dayId);
        }
        emit RemitDayPartSent(
            dstChainId,
            dayId,
            remitId,
            p.fresh,
            p.recycled,
            sentFresh,
            sentRecycled,
            l.wholeFresh,
            l.wholeRecycled,
            whole
        );
    }

    // ─── Release ─────────────────────────────────────────────────────────

    /// @notice Whether day `dayId` carries an ordinary remit ledger toward
    ///         `dstChainId` (a part of it was ever sent). A release then takes
    ///         its part off through {releasePart}; a compensation (manual) day
    ///         has none and keeps the single-reservation ownership rule.
    function hasLedger(
        LibVaipakam.Storage storage s,
        uint32 dstChainId,
        uint256 dayId
    ) internal view returns (bool) {
        return s.remitDayLedger[dstChainId][dayId].locked;
    }

    /**
     * @notice Take a RELEASED reservation's part off day `dayId`: the live sums
     *         drop by exactly the part, the clamp residual is re-opened when
     *         this part retired it, and the day-close markers are deleted
     *         whenever the day is no longer whole — whichever part set them.
     * @dev    The lock stays: the next send plans exactly the released amount
     *         against the same whole (and re-retires the recycled residual
     *         only if it was this part's), and the mirror's whole is
     *         untouched. The released fresh becomes UNCOVERED, armed day or
     *         not: its first charge stays spent (`rewardBudgetRemittedGlobal`
     *         is append-only), so the next part must find room for it again,
     *         as a re-send of a released whole-day reservation always has. The
     *         caller restores the part's RECYCLED commitment retirement
     *         (`restoreReleasedRemit`) from the reservation. It restores no
     *         fresh commitment: an armed day's was converted into the hold at
     *         its first part, for good.
     *
     *         #2963 — on a day the abandoned-day walk has already released,
     *         the caller must restore none of THIS day's recycled commitment
     *         either: the walk freed what the day still held, the day is never
     *         sent again, so a restored commitment would hold pool room that
     *         nothing ever retires. `notRestored` is that amount: the part's
     *         own recycled, plus the clamp residual when this part retired it
     *         — exactly what the send retired for this day under this
     *         reservation (zero on an unarmed day, which retires none). A day
     *         the walk has not reached yet restores as usual; the walk then
     *         counts it.
     * @param fresh / recycled This reservation's part of THIS day (zero for a
     *                         close-only day that rode along).
     * @return notRestored The recycled commitment of this day the caller must
     *                     leave retired.
     */
    function releasePart(
        LibVaipakam.Storage storage s,
        uint32 dstChainId,
        uint256 dayId,
        uint256 remitId,
        uint256 fresh,
        uint256 recycled
    ) internal returns (uint256 notRestored) {
        LibVaipakam.RemitDayLedger storage l = s.remitDayLedger[dstChainId][dayId];
        if (l.armed && dayId < s.remitReleaseCursor[dstChainId]) {
            notRestored = recycled;
            if (l.residualRemitId == remitId) {
                notRestored += uint256(l.armedWholeRecycled) - l.wholeRecycled;
            }
            if (notRestored != 0) {
                emit RemitAbandonedPartReleased(dstChainId, dayId, remitId, notRestored);
            }
        }
        uint256 sentFresh = uint256(l.sentFresh) - fresh;
        uint256 sentRecycled = uint256(l.sentRecycled) - recycled;
        l.sentFresh = uint128(sentFresh);
        l.sentRecycled = uint128(sentRecycled);
        // Bounded by the whole (a part never sends more than the day owes).
        l.freshUncovered = uint128(uint256(l.freshUncovered) + fresh);
        unchecked {
            --l.partsLive;
        }
        if (l.residualRemitId == remitId) l.residualRemitId = 0;
        if (!_isWhole(l, sentFresh, sentRecycled)) {
            delete s.rewardBudgetRemitted[dstChainId][dayId];
            delete s.dayClosedByRemitId[dstChainId][dayId];
            // #2960 — the release reopens the day, so it owes a part again,
            // unless it is abandoned: an abandoned day is never sent again
            // (the walk takes it off the list, or will).
            if (!isAbandoned(s, dstChainId, dayId)) s.remitOpenDays[dstChainId].add(dayId);
        }
        emit RemitDayPartReleased(
            dstChainId, dayId, remitId, fresh, recycled, sentFresh, sentRecycled
        );
    }

    /// @notice Which of `dayIds` a reservation FUNDED, as a single index: the
    ///         day its `fresh` / `recycled` part belongs to.
    /// @dev    The send funds at most `TRANSPORT_DAY_FANOUT_CAP` (one) day per
    ///         reservation, so its part is that day's; a reservation naming more
    ///         funded days is refused by name rather than guessed at, because
    ///         its per-day split was never recorded. A reservation without the
    ///         bitmap (a compensation dispatch writes none) funds no ledger day.
    /// @return funded Whether any day is funded.
    /// @return index  The funded day's position in `dayIds`.
    function fundedDayIndex(
        uint256 remitId,
        uint256 dayCount,
        uint256[] storage fundedDayBits
    ) internal view returns (bool funded, uint256 index) {
        uint256 count;
        uint256 words = fundedDayBits.length;
        for (uint256 i; i < dayCount && (i >> 8) < words; ) {
            if ((fundedDayBits[i >> 8] >> (i & 255)) & 1 != 0) {
                index = i;
                unchecked {
                    ++count;
                }
            }
            unchecked {
                ++i;
            }
        }
        if (count > 1) revert IVaipakamErrors.RemitReleaseFanoutUnsupported(remitId, count);
        funded = count == 1;
    }

    // ─── Abandon (#2963) ─────────────────────────────────────────────────

    /// @notice Whether day `dayId` of `dstChainId` is abandoned: below the
    ///         bound the destination's last removal set. Never sent again.
    function isAbandoned(
        LibVaipakam.Storage storage s,
        uint32 dstChainId,
        uint256 dayId
    ) internal view returns (bool) {
        return dayId < s.remitAbandonedBefore[dstChainId];
    }

    /// @notice Whether `dstChainId`'s release is unfinished: some abandoned
    ///         day has not been walked yet. The chain cannot be re-listed
    ///         meanwhile, because an abandoned day finalizing with the chain
    ///         listed would book a commitment toward it that nothing retires.
    function releasePending(
        LibVaipakam.Storage storage s,
        uint32 dstChainId
    ) internal view returns (bool) {
        return s.remitReleaseCursor[dstChainId] < s.remitAbandonedBefore[dstChainId];
    }

    /**
     * @notice `dstChainId` has just been taken off Base's expected-source
     *         list: abandon every day of it up to and including today.
     * @dev    Owner decision 2026-10-27 ("On removal", #2963): removing a chain
     *         releases the pool room Base holds for its unsent remit days, in
     *         the same write, and the chain's users lose those days. Today is
     *         included because it finalizes after the removal, without the
     *         chain, so it would owe the chain nothing anyway; a later day is
     *         not abandoned, so a chain listed again is paid from then on. The
     *         bound only rises. Before the reward schedule starts there are no
     *         days, and nothing is abandoned.
     */
    function abandonDestination(LibVaipakam.Storage storage s, uint32 dstChainId) internal {
        (uint256 today, bool active) = LibInteractionRewards.currentDayOrZero();
        uint256 bound = s.remitAbandonedBefore[dstChainId];
        if (active && today + 1 > bound) {
            bound = today + 1;
            s.remitAbandonedBefore[dstChainId] = bound;
        }
        emit RemitDestinationRemoved(dstChainId, bound, s.remitReleaseCursor[dstChainId]);
    }

    /**
     * @notice Release, day by day from the cursor, what Base still holds for
     *         `dstChainId`'s abandoned days, walking at most `maxDays` days.
     * @dev    Stops at the bound and at the first unfinalized day: an
     *         unfinalized day's figures do not exist yet (it finalizes later,
     *         and with the chain off the list it gives the chain nothing).
     *         Each walked day releases exactly what a whole send of the rest
     *         would have retired, without sending ({_releaseDay}); days that
     *         are settled or held nothing release nothing. A day once walked
     *         is never walked again (the cursor only rises), and a release of
     *         a part on a walked day restores none of its commitment
     *         ({releasePart}), so nothing is released twice.
     * @return cursor The first day not yet released.
     * @return bound  The abandoned bound.
     */
    function walkAbandoned(
        LibVaipakam.Storage storage s,
        uint32 dstChainId,
        uint256 maxDays
    ) internal returns (uint256 cursor, uint256 bound) {
        bound = s.remitAbandonedBefore[dstChainId];
        cursor = s.remitReleaseCursor[dstChainId];
        if (cursor >= bound) return (cursor, bound);
        uint256 end = bound - cursor > maxDays ? cursor + maxDays : bound;
        uint256 armedFrom = s.governorCommitArmedFromDay;
        while (cursor < end && s.dailyGlobalFinalized[cursor]) {
            _releaseDay(s, dstChainId, cursor, armedFrom);
            unchecked {
                ++cursor;
            }
        }
        s.remitReleaseCursor[dstChainId] = cursor;
        emit RemitDestinationReleaseWalked(dstChainId, cursor, bound);
    }

    /**
     * @dev Release one finalized abandoned day. What Base holds for it toward
     *      `dstChainId`, by the day's state:
     *        - whole or closed: nothing.
     *        - locked (a part went): its unsent fresh in the pool hold
     *          (owed less what is uncovered), and on an armed day its
     *          outstanding recycled commitment: the unsent rest, plus the clamp
     *          residual when no live part retired it. The day's
     *          `freshUncovered` is set to what it still owes, so the ledger
     *          reads as holding nothing.
     *        - unlocked and armed: the commitment finalization booked toward
     *          the chain, {_slice}'s fresh and recycled, which a whole send
     *          would have retired at its first part. A remit-ineligible day
     *          booked none (the chain was out of the denominator).
     *        - unlocked and unarmed: nothing (an unarmed day holds nothing
     *          until its first part).
     *      Fresh commitments retire floored, as every retirement does.
     */
    function _releaseDay(
        LibVaipakam.Storage storage s,
        uint32 dstChainId,
        uint256 dayId,
        uint256 armedFrom
    ) private {
        if (
            s.rewardBudgetRemitted[dstChainId][dayId] != 0
                || s.dayClosedByRemitId[dstChainId][dayId] != 0
        ) return;
        LibVaipakam.RemitDayLedger storage l = s.remitDayLedger[dstChainId][dayId];
        bool locked = l.locked;
        uint256 heldFresh;
        uint256 commitFresh;
        uint256 commitRecycled;
        if (locked) {
            // #2960 — never sent again, so no longer owed a part.
            s.remitOpenDays[dstChainId].remove(dayId);
            uint256 owedFresh = uint256(l.wholeFresh) - l.sentFresh;
            heldFresh = owedFresh - l.freshUncovered;
            if (heldFresh != 0) {
                s.remitDayFreshReserved -= heldFresh;
                // Bounded by the whole, so the narrowing cannot truncate.
                l.freshUncovered = uint128(owedFresh);
            }
            if (l.armed) {
                commitRecycled = uint256(l.wholeRecycled) - l.sentRecycled;
                if (l.residualRemitId == 0) {
                    commitRecycled += uint256(l.armedWholeRecycled) - l.wholeRecycled;
                }
            }
        } else {
            if (armedFrom == 0 || dayId < armedFrom) return;
            if (s.chainDayCommitments[dayId][dstChainId].remitIneligible) return;
            (, commitFresh, commitRecycled, ) = _slice(s, dstChainId, dayId);
            LibInteractionRewards.consumeArmedFresh(commitFresh);
        }
        if (commitRecycled != 0) {
            LibVpfiRecycle.releaseCommitment(
                LibVpfiRecycle.RecycleSource.RemitDestinationRemoved, dayId, commitRecycled
            );
        }
        if (heldFresh != 0 || commitFresh != 0 || commitRecycled != 0) {
            emit RemitAbandonedDayReleased(
                dstChainId, dayId, locked, heldFresh, commitFresh, commitRecycled
            );
        }
    }

    /// @dev The day is whole: every component sent, and the clamp residual
    ///      retired by a live part.
    function _isWhole(
        LibVaipakam.RemitDayLedger storage l,
        uint256 sentFresh,
        uint256 sentRecycled
    ) private view returns (bool) {
        return sentFresh == l.wholeFresh
            && sentRecycled == l.wholeRecycled
            && l.residualRemitId != 0;
    }
}
