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
        ExpiredReward
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
        uint256 preUpgradeFloor = s.recycleBucket + s.paidOutRecycled;
        return stored >= preUpgradeFloor ? stored : preUpgradeFloor;
    }

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
        s.outstandingCommitRecycled =
            outstanding > amount ? outstanding - amount : 0;
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
        s.outstandingCommitRecycled =
            outstanding > amount ? outstanding - amount : 0;
        emit RewardCommitmentReleased(uint8(source), refId, amount);
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
}
