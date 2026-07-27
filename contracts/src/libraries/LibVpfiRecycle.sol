// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibInteractionRewards} from "./LibInteractionRewards.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title  LibVpfiRecycle
 * @author Vaipakam Developer Team
 * @notice Governor PR-3a (#1217 / #1222,
 *         `docs/DesignsAndPlans/VpfiRecyclingBalanceGovernorDesign.md` §5) —
 *         the recycle-bucket ledger's single credit chokepoint.
 *
 *         The bucket is a protocol-owned **ledger slice of the Diamond's own
 *         VPFI balance** — crediting it never moves tokens; it re-labels
 *         VPFI that has just terminated in Diamond custody (a recyclable
 *         receipt class) as recycled reward runway. Nothing is burned: every
 *         credited token extends the reward program's life via the
 *         governor's absorption-coupled budget (PR-3b sizes
 *         `recycledBudget[D]` from the trailing average of
 *         `recycledCreditedByDay`).
 *
 * @dev    Every credit MUST route through {credit} — it is the one place the
 *         bucket, the day-bucketed `credited[D]` feed, and the
 *         {VpfiRecycled} observability event stay in lockstep. The caller is
 *         responsible for the custody precondition: the `amount` must
 *         already sit (and remain) on the Diamond — never credit for VPFI
 *         that was transferred out.
 *
 *         Separation invariant (governor §5), preserved by construction at
 *         this chokepoint: `diamondVpfiBalance ≥ userLifCustody +
 *         unclaimedRewardBudget + recycleBucket` — a credit always
 *         corresponds to value LEAVING one of the other two custody classes
 *         (e.g. a forfeited reward leaves the unclaimed reward budget) or
 *         arriving fresh from a user (e.g. a tariff), so the right-hand side
 *         never grows past the balance.
 *
 *         Source-split note (governor §4): pre-PR-3c every distributed
 *         reward is FRESH-funded (the coupled budget doesn't exist yet), so
 *         a forfeit's full amount is genuine absorption and credits here.
 *         PR-3c's dual fresh/recycled accumulator adds the recycled-funded
 *         share's commitment-release path (which must NEVER credit —
 *         releasing a recycled commitment absorbs nothing).
 */
library LibVpfiRecycle {
    /// @notice Recyclable VPFI receipt classes (governor §4). Stable ABI
    ///         ordering — append only. `ExpiredReward` is reserved for the
    ///         RL-3 claim-horizon sweep (#1305).
    enum RecycleSource {
        ForfeitedReward,
        NotificationFee,
        FullTariff,
        BorrowerLifForfeit,
        BorrowerLifTreasuryShare,
        YieldFeeVpfiShare,
        MatcherRemainder,
        ServiceBondSlash,
        ExpiredReward,
        // #1222 M3 B2-d2 — release-only class (append-only enum): the
        // pre-clamp recycled share of a terminally-closed remit day that the
        // Σcommitments clamp did NOT send (the mirror's reported liability is
        // below the uncapped slice). Never a CREDIT class — it tags
        // {RewardCommitmentReleased} so the residual's outstanding-commitment
        // retirement is distinguishable from forfeit/expiry releases.
        RemitClampResidual,
        // #1222 M3 B2-d5 — CUSTODY-RELOCATION class (append-only enum): the
        // RECYCLED share of a Base-funded remit arriving on a mirror. The
        // tokens are physically delivered, so they credit `recycleBucket` and
        // give the mirror's claim path real backing — but they are NOT new
        // absorption. They were already Ā-counted once on Base when first
        // absorbed there, so this class is excluded from the day-bucketed
        // `credited[d]` feed AND from the cumulative a mirror reports to Base
        // (see {creditCustodyRelocated} and design record §2f).
        RemittedCustodyRelocation
    }

    /// @notice Emitted once per recycle-bucket credit — the on-chain feed
    ///         for the #1218 transparency metrics (selfFundingRatio) and the
    ///         RL-2 loop-closure ratio's absorption term.
    /// @param source Receipt class (see {RecycleSource}).
    /// @param refId  Class-specific reference (loanId for per-loan classes;
    ///               0 for aggregate credits such as a claim-path forfeit
    ///               batch spanning several entries).
    /// @param amount VPFI wei credited to the bucket.
    /// @param dayId  Interaction-reward schedule day the credit landed in
    ///               (0 pre-launch — aged out of the trailing window once
    ///               emissions start).
    /// @custom:event-category state-change/treasury-mutation
    event VpfiRecycled(
        uint8 indexed source,
        uint256 indexed refId,
        uint256 amount,
        uint256 dayId
    );

    /// @notice The Diamond's live VPFI balance cannot back the post-credit
    ///         bucket — crediting would mint an UNBACKED ledger slice.
    ///         (Codex #1312 P1: the pre-PR-3a treasury `safeTransfer` doubled
    ///         as a solvency check that rolled the whole forfeit back on an
    ///         underfunded Diamond; this restores that revert-on-underfunded
    ///         behaviour, strictly stronger.)
    error InsufficientRecycleBacking(uint256 needed, uint256 available);

    /**
     * @notice Credit `amount` of Diamond-custody VPFI to the recycle bucket.
     * @dev    No-op on zero. Reverts {InsufficientRecycleBacking} when the
     *         Diamond's live VPFI balance cannot cover the post-credit
     *         bucket — the ledger-slice property is enforced HERE, not
     *         assumed, so a caller that marked value as absorbed without the
     *         tokens actually sitting on the Diamond rolls back entirely
     *         (processed flags, pool accounting and all). See the library
     *         natspec for the full separation invariant.
     * @param  source Receipt class being absorbed.
     * @param  refId  Class-specific reference id (0 when aggregate).
     * @param  amount VPFI wei to credit.
     */
    function credit(
        RecycleSource source,
        uint256 refId,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 bal = IERC20(s.vpfiToken).balanceOf(address(this));
        uint256 needed = s.recycleBucket + amount;
        if (bal < needed) revert InsufficientRecycleBacking(needed, bal);
        (uint256 dayId, bool active) = LibInteractionRewards.currentDayOrZero();
        if (!active) dayId = 0;
        // #1222 M3 B1 — monotonic cumulative of every credit on this chain,
        // reported mirror→Base on each day-close so Base's per-chain
        // availability ledger self-heals across missed reports. Counts
        // inflow, never the live balance, so it never decrements on consume.
        // Reading through {creditedCumulative} folds in the pre-upgrade
        // floor, so the first post-refresh credit self-heals the counter —
        // and MUST be read BEFORE the bucket write below, or this credit
        // would be double-counted through the floor.
        uint256 cumulativeBefore = creditedCumulative(s);
        s.recycleBucket = needed;
        s.recycledCreditedByDay[dayId] += amount;
        s.recycleCreditedCumulative = cumulativeBefore + amount;
        emit VpfiRecycled(uint8(source), refId, amount, dayId);
    }

    /**
     * @notice #1222 M3 B1 (Codex #1413 r5) — this chain's lifetime recycled
     *         credit total, with the in-place-refresh seed folded in. The
     *         stored counter starts at zero on a diamond refreshed over live
     *         pre-#1222 state, but the true lifetime total is derivable:
     *         `credit` only ever adds to the bucket and `consume` only ever
     *         moves bucket → `paidOutRecycled`, so `recycleBucket +
     *         paidOutRecycled` IS the historical Σ of credits (exact up to
     *         the consume path's documented wei-scale cap-trim dust, which
     *         can only overstate). Flooring the stored counter on that sum
     *         means the first report after an upgrade already carries the
     *         pre-upgrade absorption — B2/B3 funding never permanently
     *         ignores VPFI absorbed before the cut, with no migration or
     *         admin seeding step.
     */
    function creditedCumulative(LibVaipakam.Storage storage s)
        internal
        view
        returns (uint256)
    {
        uint256 stored = s.recycleCreditedCumulative;
        // #1222 M3 B2-d5 — net RELOCATED CUSTODY out of the derived floor.
        // {creditCustodyRelocated} raises `recycleBucket` without advancing
        // `recycleCreditedCumulative`, so without this subtraction those
        // tokens would re-enter the reported figure through the floor and
        // Base would read its own remit top-up back as the mirror's own
        // absorption (design record §2f.3). Structurally cannot underflow —
        // every custody credit adds to the bucket and `consume` only moves
        // bucket → `paidOutRecycled` — but saturate anyway so a future path
        // that decremented the bucket without this counter degrades to a
        // conservative under-report instead of reverting every day-close.
        uint256 gross = s.recycleBucket + s.paidOutRecycled;
        uint256 relocated = s.recycleCustodyRelocatedCumulative;
        uint256 preUpgradeFloor = gross > relocated ? gross - relocated : 0;
        return stored >= preUpgradeFloor ? stored : preUpgradeFloor;
    }

    /**
     * @notice #1222 M3 B2-d5 — credit the RECYCLED share of an arriving
     *         Base-funded remit into this mirror's bucket as RELOCATED
     *         CUSTODY: real backing for the claim path, but not new
     *         absorption.
     * @dev    Differs from {credit} in exactly two ways, both deliberate:
     *
     *         1. It does NOT touch `recycledCreditedByDay` — the day-bucketed
     *            `credited[d]` feed that sizes `Ā`. Re-crediting would let one
     *            protocol receipt cycle bucket → budget → expiry → bucket and
     *            manufacture repeat reward budget with no new user activity
     *            behind it (plan §M3's geometric-inflation hazard).
     *         2. It does NOT advance `recycleCreditedCumulative`; instead it
     *            advances `recycleCustodyRelocatedCumulative`, which
     *            {creditedCumulative} subtracts. That keeps the tokens out of
     *            the cumulative a mirror reports to Base, which after B2-d3
     *            drives BOTH `_mirrorAvailable` (`reported − consumed`) and
     *            the `Ā` attribution headroom in {recordChainRecycled}.
     *
     *         It shares {credit}'s backing assertion: the tokens must
     *         physically be on the Diamond, so a caller that credited without
     *         delivery rolls the whole arrival back.
     *
     *         There is exactly ONE bucket (design record §5) — this only
     *         records how much of it is relocated custody rather than
     *         first-time absorption.
     * @param  refId  Class-specific reference id (the remit id at arrival).
     * @param  amount VPFI wei of RECYCLED backing delivered.
     */
    function creditCustodyRelocated(uint256 refId, uint256 amount) internal {
        if (amount == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 bal = IERC20(s.vpfiToken).balanceOf(address(this));
        uint256 needed = s.recycleBucket + amount;
        if (bal < needed) revert InsufficientRecycleBacking(needed, bal);
        (uint256 dayId, bool active) = LibInteractionRewards.currentDayOrZero();
        if (!active) dayId = 0;
        s.recycleBucket = needed;
        s.recycleCustodyRelocatedCumulative += amount;
        emit VpfiCustodyRelocated(
            uint8(RecycleSource.RemittedCustodyRelocation), refId, amount, dayId
        );
    }

    /**
     * @notice #1222 M3 B2-d5 — emitted when RELOCATED CUSTODY credits the
     *         bucket: recycled VPFI that arrived as a Base-funded remit
     *         top-up. The bucket grows, but this is NOT absorption.
     * @dev    A SIBLING event rather than a `source` discriminator on
     *         {VpfiRecycled}, which plan §M3 offers as the alternative. The
     *         reason is the failure mode, not taste: every existing
     *         `VpfiRecycled` consumer treats the event as an absorption
     *         credit with no source filter — `apps/indexer`'s
     *         `rewardLoopLedger` tests bare membership in its HANDLED set and
     *         credits `absorbed[D]` + `cum_absorbed`, which feeds #1218's
     *         self-funding ratio. Overloading the existing event would
     *         manufacture absorption OFF-chain in exactly the way the
     *         on-chain Ā exclusion prevents, and would do so silently in any
     *         consumer that was not updated in lockstep. A distinct event
     *         name makes such a consumer under-count (visible, conservative)
     *         instead of over-count, and every consumer that wants the full
     *         bucket picture opts in explicitly.
     *
     *         The balance still goes labelled — the class is carried on the
     *         shared {RecycleSource} vocabulary, just on its own channel.
     * @custom:event-category state-change/treasury-mutation
     */
    event VpfiCustodyRelocated(
        uint8 indexed source,
        uint256 indexed refId,
        uint256 amount,
        uint256 dayId
    );

    /// @notice PR-3c — emitted when a recycled payout leaves the bucket
    ///         (a claim or remittance paid its recycled component). The
    ///         governor §3.2 rule: the recycled budget is a sizing
    ///         reservation, debited pro-rata at claim/remit time — never a
    ///         finalize-time transfer.
    /// @custom:event-category state-change/treasury-mutation
    event VpfiRecycleConsumed(uint256 amount, uint256 dayId);

    /// @notice PR-3c — emitted when a RECYCLED-funded commitment is
    ///         released without consumption (a recycled-funded reward was
    ///         forfeited, or RL-3's horizon sweep expired it). ZERO new
    ///         absorption: the tokens never physically left the bucket, so
    ///         this must NEVER feed `credited[D]` / Ā (governor §4 —
    ///         otherwise dormant recycled rewards would inflate future
    ///         budgets on every forfeit, absorbing nothing).
    /// @param  source Same class vocabulary as {VpfiRecycled}.
    /// @custom:event-category informational/reward-governor
    event RewardCommitmentReleased(
        uint8 indexed source,
        uint256 indexed refId,
        uint256 amount
    );

    /**
     * @notice PR-3c — consume `amount` from the bucket for a recycled
     *         payout (claim / remittance). Ledger decrement paralleling the
     *         caller's actual token transfer; also retires the matching
     *         outstanding recycled commitment and advances the
     *         `paidOutRecycled` transparency counter.
     * @dev    Floors both the bucket and the outstanding sum at zero
     *         instead of reverting: bounded cap-trim dust can make a day's
     *         consumption exceed its recorded commitment by wei-scale
     *         amounts (redesign ceil-dust rule), and a payout that the
     *         claim math authorized must not brick on ledger dust.
     */
    function consume(uint256 amount) internal {
        if (amount == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 bucket = s.recycleBucket;
        s.recycleBucket = bucket > amount ? bucket - amount : 0;
        uint256 outstanding = s.outstandingCommitRecycled;
        // #1222 M3 B3 — record the ACTUAL decrement, not `amount`: the floor
        // below is load-bearing (cap-trim dust can make a day's consumption
        // exceed its recorded commitment), so counting the request would
        // over-report retirement to Base on a chain whose outstanding is
        // already exhausted.
        uint256 retired = outstanding > amount ? amount : outstanding;
        s.outstandingCommitRecycled = outstanding - retired;
        s.recycleCommitRetiredCumulative += retired;
        s.paidOutRecycled += amount;
        (uint256 dayId, bool active) = LibInteractionRewards.currentDayOrZero();
        if (!active) dayId = 0;
        emit VpfiRecycleConsumed(amount, dayId);
    }


    /**
     * @notice PR-3c — release a RECYCLED-funded commitment without
     *         consumption (forfeit / RL-3 expiry of a recycled-funded
     *         reward). Restores bucket availability (`fundable` reads
     *         `recycleBucket − outstandingCommitRecycled`) with ZERO new
     *         credit — never touches `recycledCreditedByDay`.
     */
    function releaseCommitment(
        RecycleSource source,
        uint256 refId,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 outstanding = s.outstandingCommitRecycled;
        // #1222 M3 B3 — the actual decrement counts twice: into the shared
        // retirement cumulative AND into the release-only subset, because a
        // release leaves the tokens in the bucket. The release cumulative is
        // what restores this chain's availability on Base (`avail_c =
        // reported_c + released_c − consumed_c`); the `consume` half is
        // genuinely spent and restores nothing.
        uint256 retired = outstanding > amount ? amount : outstanding;
        s.outstandingCommitRecycled = outstanding - retired;
        s.recycleCommitRetiredCumulative += retired;
        s.recycleCommitReleasedCumulative += retired;
        emit RewardCommitmentReleased(uint8(source), refId, amount);
    }

    /// @notice #1222 M3 B2-d3 — emitted when a mirror RESERVES the recycled
    ///         commit Base instructed it to fund locally for an armed day
    ///         (broadcast arrival). Plan §M3: the broadcast *commits*; the
    ///         bucket itself is debited pro-rata later, at claim/remit. ZERO
    ///         absorption and ZERO payout — this only encumbers availability,
    ///         mirroring the `chainConsumedRecycled[c]` mark Base booked at
    ///         finalization (same figure, both ledgers).
    /// @custom:event-category informational/reward-governor
    event MirrorRecycleCommitReserved(uint256 indexed dayId, uint256 amount);

    /**
     * @notice #1222 M3 B2-d3 — mirror-side arrival RESERVATION: encumber
     *         `amount` of this chain's recycle bucket for the armed day's
     *         locally-funded reward payouts.
     * @dev    Deliberately NOT a bucket debit (plan §M3 "broadcast commits;
     *         bucket debited pro-rata at claim/remit"): `consume` already
     *         runs at every claim on every chain, so debiting here too would
     *         charge the same tokens twice — draining the bucket ledger to
     *         its floor and double-counting `paidOutRecycled`, which inflates
     *         the derived `creditedCumulative` and over-states this chain's
     *         availability to Base (see the design record §2e.1). Reserving
     *         instead gives the mirror the identical reserve → consume →
     *         release lifecycle Base already runs, with no new primitives:
     *         claims retire it via {consume}, forfeits/expiries via
     *         {releaseCommitment}.
     */
    function reserveMirrorCommit(uint256 dayId, uint256 amount) internal {
        if (amount == 0) return;
        LibVaipakam.storageSlot().outstandingCommitRecycled += amount;
        emit MirrorRecycleCommitReserved(dayId, amount);
    }

    /**
     * @notice #1222 M3 B2-d2 — reverse a released remit reservation's
     *         recycled-side ledger effects so a later re-remit of the
     *         re-opened days pairs off exactly: restores the outstanding
     *         commitment for the PRE-clamp recycled total (`consume` +
     *         `releaseCommitment` both retired it at send) and reverses the
     *         `paidOutRecycled` transparency counter for the CLAMPED share
     *         actually sent (it was never paid to anyone).
     * @dev    Deliberately NEVER re-credits `recycleBucket`: the sent tokens
     *         sit locked in the CCIP token pool — genuinely outside Diamond
     *         custody — so the bucket ledger is already correct. Re-crediting
     *         here would un-back the bucket; physical recovery re-enters via
     *         B2-d5's Ā-excluded custody-credit class once the tokens
     *         actually return. Restoring the outstanding commitment WITHOUT
     *         the bucket shrinks `fundable` (bucket − outstanding) — the
     *         conservative direction while the re-opened days await
     *         re-funding.
     */
    function restoreReleasedRemit(
        uint256 recycledFull,
        uint256 recycledSent
    ) internal {
        if (recycledFull == 0 && recycledSent == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.outstandingCommitRecycled += recycledFull;
        // Codex #1426 r5 — on an in-place-upgraded Diamond whose
        // `recycleCreditedCumulative` is still unseeded, the cumulative is
        // DERIVED as `bucket + paidOutRecycled`; reversing paidOut below
        // would shrink that supposedly-monotonic figure and a later seed
        // would lock the under-report in. Snapshot the derived value into
        // the stored slot first, so the reversal is invisible to the
        // cumulative ledger.
        if (s.recycleCreditedCumulative == 0) {
            uint256 cumulative = creditedCumulative(s);
            if (cumulative != 0) s.recycleCreditedCumulative = cumulative;
        }
        uint256 paid = s.paidOutRecycled;
        s.paidOutRecycled = paid > recycledSent ? paid - recycledSent : 0;
    }

    // ─── #1222 M3 B1 — Base's per-chain recycled ledger ─────────────────────

    /// @notice Base's per-chain recycled ledger advanced for `sourceChainId`
    ///         (a mirror day-close report, or Base's own local close).
    /// @param  sourceChainId       Reporting chain.
    /// @param  dayId               Schedule day the report closes.
    /// @param  cumulative          The chain's reported monotonic cumulative
    ///                             recycle-bucket credits (availability).
    /// @param  forDayReported      The chain's claimed credit total for
    ///                             `dayId` (its `recycledCreditedByDay`).
    /// @param  dayCreditAccepted   The clamped credit actually attributed to
    ///                             `dayId` (0 when clamped away or when the
    ///                             attribution baseline was unavailable —
    ///                             availability still self-heals via
    ///                             `cumulative`).
    /// @custom:event-category informational/reward-transport
    event ChainRecycledReported(
        uint32 indexed sourceChainId,
        uint256 indexed dayId,
        uint256 cumulative,
        uint256 forDayReported,
        uint256 dayCreditAccepted
    );

    /**
     * @notice #1222 M3 B1 — record a chain's day-close recycled report into
     *         Base's per-chain ledger: the AVAILABILITY cumulative and the
     *         clamped per-day `Ā` attribution. Called by the reporter (Base's
     *         own local close) and the aggregator ingress (a mirror report),
     *         so both paths write identically.
     * @dev    Two ledgers per report:
     *
     *         AVAILABILITY — `chainReportedRecycled[c]` only ever advances
     *         (a late/reordered report carrying a stale cumulative can never
     *         walk it backwards), and a missed report self-heals on the next
     *         one because the value is a cumulative, not a delta.
     *
     *         DAY ATTRIBUTION — the consistency clamp, aggregate form
     *         (Codex #1413 r2): the clamp baseline is the running sum of
     *         ACCEPTED day credits (`chainAttributedRecycled[c]`), never the
     *         reported cumulative, so a day's accepted credit is
     *         `min(forDayReported, reported − attributed)`. This enforces
     *         the intended invariant directly — total attributed `Ā` credit
     *         never exceeds the availability the chain reported — and is
     *         ORDER-INDEPENDENT: delayed days, gap-jumping days, a delayed
     *         day 0, and a late close of a quiet day (whose report carries
     *         the LIVE lifetime cumulative next to a small old-day bucket)
     *         all attribute exactly for an honest chain, because credit not
     *         yet claimed by its own day simply stays in the headroom. A
     *         per-report-delta clamp (the plan's sketch) fails that last
     *         case — ratcheting the baseline to the live cumulative on a
     *         quiet-day close would zero the headroom of the days whose
     *         credit that cumulative already includes. Trade-off, accepted:
     *         a buggy/malicious mirror can shift credit BETWEEN its own
     *         days within the aggregate bound (never exceed it); `Ā` only
     *         sizes budgets, and B2's `min(target, availRecycled)` funding
     *         re-bounds everything against the availability ledger.
     *
     *         Truly-late days never reach here at all — the ingress rejects
     *         reports for finalized days. Idempotent per `(dayId, chain)`
     *         via the acceptance marker — upstream duplicate guards make a
     *         second call unreachable today, but the marker keeps the
     *         ledger safe under any future re-delivery path.
     */
    function recordChainRecycled(
        LibVaipakam.Storage storage s,
        uint32 sourceChainId,
        uint256 dayId,
        uint256 cumulative,
        uint256 forDayReported
    ) internal {
        // AVAILABILITY — monotonic self-healing ratchet.
        uint256 reported = s.chainReportedRecycled[sourceChainId];
        if (cumulative > reported) {
            reported = cumulative;
            s.chainReportedRecycled[sourceChainId] = cumulative;
        }

        // DAY ATTRIBUTION — once per (day, chain).
        if (s.chainRecycledDayAccepted[dayId][sourceChainId]) return;

        uint256 attributed = s.chainAttributedRecycled[sourceChainId];
        uint256 accepted;
        if (reported > attributed) {
            uint256 headroom = reported - attributed;
            accepted = forDayReported < headroom ? forDayReported : headroom;
        }

        s.chainRecycledDayAccepted[dayId][sourceChainId] = true;
        if (accepted != 0) {
            s.chainDailyRecycledCredit[dayId][sourceChainId] = accepted;
            s.chainAttributedRecycled[sourceChainId] = attributed + accepted;
            // Ā's mirror half, accumulated at acceptance so the trailing
            // fold never re-reads history through a mutable chain list
            // (Codex #1414 r1). Base's own day credit stays out — it lives
            // in the local `recycledCreditedByDay` series.
            if (sourceChainId != uint32(block.chainid)) {
                s.dayMirrorRecycledCredit[dayId] += accepted;
            }
        }

        emit ChainRecycledReported(
            sourceChainId, dayId, cumulative, forDayReported, accepted
        );
    }

    // ─── #1222 M3 B3 — commitment retirement + availability ────────────────

    /// @notice #1222 M3 B3 — Base accepted a chain's commitment-retirement
    ///         cumulatives, closing the per-chain reservation ledger and (for
    ///         the released half) restoring that chain's availability.
    /// @param  sourceChainId  Reporting chain.
    /// @param  retiredAccepted  The clamped retirement cumulative now on
    ///                          record (monotonic).
    /// @param  releasedAccepted The clamped RELEASE cumulative now on record
    ///                          (monotonic; `≤ retiredAccepted`).
    /// @param  outstanding      The chain's reservation ledger after the
    ///                          retirement was applied.
    /// @custom:event-category informational/reward-transport
    event ChainCommitRetirementReported(
        uint32 indexed sourceChainId,
        uint256 retiredAccepted,
        uint256 releasedAccepted,
        uint256 outstanding
    );

    /**
     * @notice #1222 M3 B3 — fold a chain's reported commitment-retirement
     *         cumulatives into Base's per-chain books.
     * @dev    Base trusts a mirror for TIMING only, never for magnitude.
     *         Both figures ratchet monotonically (a stale or reordered
     *         delivery can never walk them back) and both are CLAMPED against
     *         Base-local state before they are believed:
     *
     *           retired  ≤ chainConsumedRecycled[c]   (Base's instructions)
     *           released ≤ retired
     *
     *         The second clamp chained onto the first is what forces
     *         `released_c ≤ consumed_c`, hence `avail_c ≤
     *         chainReportedRecycled[c]` in {mirrorAvailRecycled} — the bound
     *         that keeps d5's exclusion intact (Base can never be induced to
     *         re-commit against its own already-remitted custody).
     *
     *         The reservation ledger is decremented by the retirement DELTA,
     *         preserving `chainOutstandingRecycledCommit[c] ==
     *         chainConsumedRecycled[c] − chainRetiredRecycledCommit[c]` at
     *         every instant, in-flight broadcasts included (design record
     *         §2.2: the "applied" term cancels).
     *
     *         No-op for a report carrying zeros — the legacy/pre-B3 report
     *         shapes forward zeros, which advance nothing.
     */
    function recordChainCommitRetirement(
        LibVaipakam.Storage storage s,
        uint32 sourceChainId,
        uint256 retiredCumulative,
        uint256 releasedCumulative
    ) internal {
        if (retiredCumulative == 0 && releasedCumulative == 0) return;
        uint256 instructed = s.chainConsumedRecycled[sourceChainId];

        uint256 retired = s.chainRetiredRecycledCommit[sourceChainId];
        uint256 nextRetired =
            retiredCumulative > instructed ? instructed : retiredCumulative;
        if (nextRetired > retired) {
            uint256 delta = nextRetired - retired;
            retired = nextRetired;
            s.chainRetiredRecycledCommit[sourceChainId] = nextRetired;
            uint256 outstanding =
                s.chainOutstandingRecycledCommit[sourceChainId];
            s.chainOutstandingRecycledCommit[sourceChainId] =
                outstanding > delta ? outstanding - delta : 0;
        }

        uint256 released = s.chainReleasedRecycledCommit[sourceChainId];
        uint256 nextReleased =
            releasedCumulative > retired ? retired : releasedCumulative;
        if (nextReleased > released) {
            released = nextReleased;
            s.chainReleasedRecycledCommit[sourceChainId] = nextReleased;
        }

        emit ChainCommitRetirementReported(
            sourceChainId,
            retired,
            released,
            s.chainOutstandingRecycledCommit[sourceChainId]
        );
    }

    /**
     * @notice #1222 M3 B3 — Base's model of a MIRROR's committable recycle
     *         bucket: everything the chain reported crediting, PLUS the
     *         commitments it released un-spent, LESS everything Base has
     *         instructed it to fund locally.
     * @dev    The release term is B3's whole point. A mirror retires a
     *         reservation either by paying a claim (`consume` — the tokens
     *         leave) or by forfeiting/expiring it (`releaseCommitment` — the
     *         tokens stay in the bucket and are committable again). Without
     *         the second term Base's model drifts down by Σreleased forever,
     *         and a chain with ordinary forfeit rates eventually reads as
     *         having zero availability while its bucket is full — at which
     *         point Base silently funds the whole mesh again.
     *
     *         The ingest clamps in {recordChainCommitRetirement} guarantee
     *         `released ≤ consumed`, so this can never exceed
     *         `chainReportedRecycled[c]`.
     *
     *         ARRANGED AS `reported − (consumed − released)`, NOT
     *         `(reported + released) − consumed` (Codex #1435 r1 P1). The two
     *         are mathematically identical under the clamp, but the addition
     *         form can OVERFLOW: `chainReportedRecycled[c]` is ratcheted to
     *         whatever cumulative a chain reports and is deliberately
     *         unbounded (B1 — it is that chain's own lifetime absorption), so
     *         a faulty or compromised mirror reporting a near-`type(uint256)
     *         .max` cumulative alongside any nonzero release would make this
     *         read REVERT. That is not a contained failure: this function is
     *         on the `finalizeDay` path via the mesh funding pass, and the
     *         ratchets cannot be walked back — one such report would wedge
     *         day finalization for the WHOLE mesh, permanently. The
     *         subtraction form cannot overflow, and it makes the
     *         `avail ≤ reported` ceiling structural rather than derived.
     *
     *         Both subtractions are floored even though the clamp chain and
     *         `chainConsumedRecycled`'s single monotonic writer make
     *         `released ≤ consumed` hold: an availability read must never be
     *         able to revert, whatever state the ledger is in, precisely
     *         because of the blast radius above.
     *
     *         SINGLE SOURCE OF TRUTH: the mesh funding pass and the
     *         operator-facing `getChainRecycledLedger` view both call this —
     *         two independent copies of the formula would drift the moment
     *         one of them was updated.
     *
     *         Base's own chain id is inert here (and never routed through it
     *         by the funding pass, which uses its live fundable balance):
     *         Base never instructs itself, so `chainConsumedRecycled[Base]`
     *         is 0 and both clamps pin its copies to 0.
     */
    function mirrorAvailRecycled(
        LibVaipakam.Storage storage s,
        uint32 chainId
    ) internal view returns (uint256) {
        uint256 reported = s.chainReportedRecycled[chainId];
        uint256 consumed = s.chainConsumedRecycled[chainId];
        uint256 released = s.chainReleasedRecycledCommit[chainId];
        uint256 netConsumed = consumed > released ? consumed - released : 0;
        return reported > netConsumed ? reported - netConsumed : 0;
    }
}
