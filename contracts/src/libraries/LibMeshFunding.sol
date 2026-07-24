// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title  LibMeshFunding
 * @author Vaipakam Developer Team
 * @notice #1222 M3 B2-a — the governor §3.1 Phase B′ two-pass per-chain
 *         recycled funding resolution, run at ARMED-day finalization on the
 *         canonical chain.
 *
 *         Global `Ā` sizes the day's coupled TARGET; per-chain availability
 *         (the B1 recycled ledger) bounds the REALITY:
 *
 *           1. `targetSide_c = p_c,side × coupledTarget/2` — chain `c`'s
 *              share of each side's half at its finalized demand weight.
 *           2. `localFunded_c = min(target_c, avail_c)` — every chain funds
 *              from its OWN bucket first (Base included). When short, the
 *              shared availability is split at ONE allocation point,
 *              pro-rata to the two side targets (floor) — computing the
 *              sides independently against the same availability would
 *              spend it twice.
 *           3. Base tops up still-unfunded portions pro-rata from its
 *              REMAINING availability only (`availBase − localFunded_Base`)
 *              — topping up from total Base availability would double-commit
 *              the same bucket whenever Base has local demand and mirrors
 *              have shortfalls.
 *           4. `recycledBudget[D] = Σ_c funded_c` — the global stamp is the
 *              Σ of funded slices (a metric; each chain's claimable figure
 *              is its OWN stamp, never the aggregate). On a single-chain
 *              deploy this equals the Phase-A′ `min(fundable, coupled)`
 *              exactly.
 *
 *         SIDE-SPECIFIC global-equivalent halves: the claim accumulators
 *         consume a recycled numerator over the GLOBAL side denominators,
 *         and the two sides have separate denominators — so each chain gets
 *         `sideHalfEquiv_c = fundedSide_c × globalSide / chainSide_c`
 *         (floor, zero-guarded), which makes the existing per-side math
 *         yield exactly that side's funded budget on that chain, with the
 *         funded budgets remaining the binding caps (scaling dust can never
 *         over-pay).
 *
 *         B2-b RE-SLICE (Codex #1417 r6): mirror LOCAL funding + the
 *         consume-on-arrival symmetry are DEFERRED to B2-d, where the
 *         delivered-backing ledger (a mirror's surrendered slice + received
 *         remittances) makes mirror-side consumption safe. A mirror funding
 *         its slice from its own bucket before the backing remittance has
 *         arrived would let pre-remittance claims cannibalise other reward
 *         ledgers and report phantom availability to Base — so until B2-d,
 *         Base funds the WHOLE mesh budget (`avail = 0` on every mirror).
 *         The two passes therefore degenerate to "Base funds all": the
 *         whole capped commit is Base-funded and reserves into the GLOBAL
 *         `outstandingCommitRecycled` (consumed at Base claims + remit), so
 *         the live `recycledBudget` stamp and the global reservation stay
 *         numerically identical to the pre-mesh single-pool
 *         `min(fundable, coupled)`. `recycleConsume` rides the wire as 0.
 *
 *         What B2-b DOES make live: each chain gets its own funded per-day
 *         stamp (per-side fresh floors + global-equivalent recycled halves),
 *         Base prices its OWN claims + remittances from its stamp (never the
 *         aggregate), and the per-destination V2 broadcast ships every
 *         mirror its stamp + cap family so the shape is ready for B2-d to
 *         arm mirror consumption against.
 */
library LibMeshFunding {
    /// @notice Emitted once per (armed day, chain) with the funded stamp.
    /// @param  reservedLocal Capped commit reserved against the chain's own
    ///         availability (`chainOutstandingRecycledCommit`; 0 for Base —
    ///         Base's whole commit is `reservedBase`).
    /// @param  reservedBase  Capped commit reserved against Base's global
    ///         `outstandingCommitRecycled` (top-ups; everything for Base).
    /// @custom:event-category informational/reward-governor
    event ChainDayFundingStamped(
        uint256 indexed dayId,
        uint32 indexed chainId,
        uint256 fundedLender,
        uint256 fundedBorrower,
        uint256 recycleConsume,
        uint256 reservedLocal,
        uint256 reservedBase
    );

    /// @notice B2-b — the resolution's global outputs, consumed by the
    ///         aggregator's finalize path.
    /// @dev `funded` = Σ_c fundedLender_c + fundedBorrower_c (the day's
    ///      live `recycledBudget` stamp); the per-side sums feed the
    ///      per-side D1 ceilings; `reservedBase` = Σ_c of every
    ///      Base-funded capped commit (Base's own slice + all top-ups) —
    ///      what finalization adds to the GLOBAL
    ///      `outstandingCommitRecycled`.
    struct FundingTotals {
        uint256 funded;
        uint256 fundedLender;
        uint256 fundedBorrower;
        uint256 reservedBase;
    }

    /// @dev Per-chain working state for the two passes (memory).
    struct ChainWork {
        uint32 chainId;
        bool included;
        uint256 chainLender;
        uint256 chainBorrower;
        uint256 targetLender;
        uint256 targetBorrower;
        uint256 localLender;
        uint256 localBorrower;
        uint256 avail;
        uint256 fundedLender;
        uint256 fundedBorrower;
    }

    /**
     * @notice Resolve + stamp the armed day's per-chain funding: writes the
     *         per-(day,chain) stamps and returns the global totals the
     *         aggregator stamps and reserves. In the B2-b re-slice every
     *         mirror funds 0 locally (see the library header), so the whole
     *         commit is Base-funded and `reservedBase == Σ commit` — the
     *         aggregator's global reservation therefore stays numerically
     *         identical to the pre-mesh `min(fundable, coupled)` while each
     *         chain still gets its own claimable stamp. B2-d turns on mirror
     *         local funding + the consume-on-arrival symmetry together.
     * @param  dayId         Day being finalized (denominators final).
     * @param  coupledTarget The absorption-coupled target `Ā × (1 − m)` —
     *                       NOT pre-capped by Base's fundable balance; the
     *                       per-chain availabilities are the funding bound.
     * @param  freshHalf     The day's per-side fresh floor (for the #1008
     *                       combined-cap in the committable computation;
     *                       also stamped as every chain's per-side fresh
     *                       halves — no per-chain fresh trim exists yet).
     * @param  availBase     Base's commitment- and keeper-netted fundable
     *                       balance, captured BEFORE the day's own
     *                       reservation (the resolution funds the day, so
     *                       the day's own commit must not net itself out).
     */
    function resolveAndStampDayFunding(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        uint256 coupledTarget,
        uint256 freshHalf,
        uint256 availBase
    ) internal returns (FundingTotals memory totals) {
        uint256 gLender = s.dailyGlobalLenderInterestNumeraire18[dayId];
        uint256 gBorrower = s.dailyGlobalBorrowerInterestNumeraire18[dayId];
        if (coupledTarget == 0 || (gLender == 0 && gBorrower == 0)) {
            return totals;
        }

        uint32[] storage expected = s.expectedSourceChainIds;
        uint256 n = expected.length;
        if (n == 0) return totals;
        ChainWork[] memory work = new ChainWork[](n);

        uint32 baseId = uint32(block.chainid);
        uint256 targetHalf = coupledTarget / 2;

        // ── Pass 1: per-chain targets + own-bucket funding ────────────────
        uint256 totalShortfall;
        uint256 baseLocalTotal;
        for (uint256 i; i < n; ++i) {
            ChainWork memory c = work[i];
            c.chainId = expected[i];
            c.chainLender =
                s.chainDailyLenderInterestNumeraire18[dayId][c.chainId];
            c.chainBorrower =
                s.chainDailyBorrowerInterestNumeraire18[dayId][c.chainId];
            // Demand weights only count chains folded into the finalized
            // denominator — a zeroed/missing chain gets no slice.
            c.included = s.chainDailyIncluded[dayId][c.chainId];
            if (c.included) {
                c.targetLender = gLender == 0
                    ? 0
                    : Math.mulDiv(targetHalf, c.chainLender, gLender);
                c.targetBorrower = gBorrower == 0
                    ? 0
                    : Math.mulDiv(targetHalf, c.chainBorrower, gBorrower);
            }
            uint256 targetTotal = c.targetLender + c.targetBorrower;

            // #1222 M3 B2-b (re-slice, Codex #1417 r6): mirror LOCAL funding
            // + consumption is deferred to B2-d, where the delivered-backing
            // ledger (surrender + received remits) makes it safe. Until then
            // Base funds the WHOLE mesh budget (mirrors contribute zero local
            // availability), so nothing instructs a mirror to consume its own
            // bucket before the backing remittance has arrived. This
            // degenerates the two pass funding to "Base funds all": the live
            // `recycledBudget` and the global reservation stay numerically
            // identical to the pre-mesh single-pool `min(fundable, coupled)`,
            // while each chain still gets its own funded stamp for pricing.
            c.avail = c.chainId == baseId ? availBase : 0;

            if (targetTotal <= c.avail) {
                c.localLender = c.targetLender;
                c.localBorrower = c.targetBorrower;
            } else if (targetTotal != 0) {
                // ONE allocation point: the shared availability is split
                // pro-rata to the two side targets (floor) — never computed
                // per side against the same balance.
                c.localLender =
                    Math.mulDiv(c.avail, c.targetLender, targetTotal);
                c.localBorrower =
                    Math.mulDiv(c.avail, c.targetBorrower, targetTotal);
            }
            totalShortfall += (c.targetLender - c.localLender)
                + (c.targetBorrower - c.localBorrower);
            if (c.chainId == baseId) {
                baseLocalTotal = c.localLender + c.localBorrower;
            }
        }

        // ── Pass 2: Base top-ups from its REMAINING availability ──────────
        uint256 topUpPool = availBase > baseLocalTotal
            ? availBase - baseLocalTotal
            : 0;
        bool fullTopUp = topUpPool >= totalShortfall;
        for (uint256 i; i < n; ++i) {
            ChainWork memory c = work[i];
            uint256 shortL = c.targetLender - c.localLender;
            uint256 shortB = c.targetBorrower - c.localBorrower;
            uint256 topL;
            uint256 topB;
            if (totalShortfall != 0 && topUpPool != 0) {
                topL = fullTopUp
                    ? shortL
                    : Math.mulDiv(topUpPool, shortL, totalShortfall);
                topB = fullTopUp
                    ? shortB
                    : Math.mulDiv(topUpPool, shortB, totalShortfall);
            }
            c.fundedLender = c.localLender + topL;
            c.fundedBorrower = c.localBorrower + topB;
            totals.fundedLender += c.fundedLender;
            totals.fundedBorrower += c.fundedBorrower;
        }
        totals.funded = totals.fundedLender + totals.fundedBorrower;

        totals.reservedBase =
            _stampAndArm(s, dayId, work, baseId, freshHalf, gLender, gBorrower);
    }

    /// @dev Shared read-only context for the per-chain stamp step (one
    ///      memory struct instead of five stack slots — viaIR headroom).
    struct StampCtx {
        uint32 baseId;
        uint256 freshHalf;
        uint256 gLender;
        uint256 gBorrower;
        uint256 t;
    }

    /// @dev Stamp every chain's funding record and ARM its ledger side
    ///      (separated from the resolution passes for stack headroom under
    ///      viaIR; the per-chain body lives in its own frame for the same
    ///      reason). Returns Σ reservedBase for the aggregator's global
    ///      reservation.
    function _stampAndArm(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        ChainWork[] memory work,
        uint32 baseId,
        uint256 freshHalf,
        uint256 gLender,
        uint256 gBorrower
    ) private returns (uint256 reservedBaseTotal) {
        StampCtx memory ctx = StampCtx({
            baseId: baseId,
            freshHalf: freshHalf,
            gLender: gLender,
            gBorrower: gBorrower,
            t: s.dayCapThreshold18[dayId]
        });
        for (uint256 i; i < work.length; ++i) {
            reservedBaseTotal += _stampOne(s, dayId, work[i], ctx);
        }
    }

    /// @dev One chain's stamp + ledger arming + event. Returns the chain's
    ///      Base-funded capped commit (its contribution to the global
    ///      reservation).
    function _stampOne(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        ChainWork memory c,
        StampCtx memory ctx
    ) private returns (uint256) {
        uint256 reservedBase;
        uint256 equivL = c.chainLender == 0
            ? 0
            : Math.mulDiv(c.fundedLender, ctx.gLender, c.chainLender);
        uint256 equivB = c.chainBorrower == 0
            ? 0
            : Math.mulDiv(c.fundedBorrower, ctx.gBorrower, c.chainBorrower);

        // The #1008-capped COMMITTABLE amount for this chain: cap the
        // combined per-day value first, then take the recycled share
        // pro-rata — mirroring the claim-side split exactly.
        uint256 commit = _cappedCommit(
            ctx.freshHalf, equivL, ctx.gLender, c.chainLender, ctx.t
        )
            + _cappedCommit(
                ctx.freshHalf, equivB, ctx.gBorrower, c.chainBorrower, ctx.t
            );

        // #1222 M3 B2-b (re-slice): with mirror local availability deferred
        // to B2-d, `localLender/localBorrower` are 0 on every mirror, so the
        // whole capped commit is Base-funded and reserves into the GLOBAL
        // ledger — no per-chain `chainConsumedRecycled` booking and no
        // `recycleConsume` instruction is enacted yet. The wire field
        // `recycleConsume` therefore rides as 0 in B2-b; B2-d turns on local
        // funding + the consume-on-arrival symmetry together.
        reservedBase = commit;

        s.chainDayRecycledFunding[dayId][c.chainId] = LibVaipakam
            .ChainDayFunding({
            fundedLender: c.fundedLender,
            fundedBorrower: c.fundedBorrower,
            lenderHalfEquiv: equivL,
            borrowerHalfEquiv: equivB,
            // 0 until B2-d enacts mirror-local funding (see above).
            recycleConsume: 0,
            keeperAllocate: 0,
            stamped: true,
            // Per-side fresh floors: the global value on both sides until a
            // per-chain fresh trim mechanism exists (plan §M3) — but ZERO
            // for a chain excluded from the finalized denominator (Codex
            // #1417 r2 P1): its numerators are not in the globals, so a
            // fresh half would let its users accrue against a denominator
            // that excludes them while the remit sizing (which gates on
            // inclusion) funds them nothing.
            freshLenderHalf: c.included ? ctx.freshHalf : 0,
            freshBorrowerHalf: c.included ? ctx.freshHalf : 0
        });
        emit ChainDayFundingStamped(
            dayId,
            c.chainId,
            c.fundedLender,
            c.fundedBorrower,
            // recycleConsume + reservedLocal are 0 until B2-d; the whole
            // capped commit is Base-funded.
            0,
            0,
            reservedBase
        );
        return reservedBase;
    }

    /// @dev One side's #1008-capped recycled COMMIT for one chain, from its
    ///      global-equivalent half: `dR = equiv×1e18/globalSide` combined
    ///      with the fresh daily under the cap, recycled share pro-rata,
    ///      CEIL back to chain scale (funding may never fall below the
    ///      once-floored claim).
    function _cappedCommit(
        uint256 freshHalf,
        uint256 equivHalf,
        uint256 globalSide,
        uint256 chainSide,
        uint256 t
    ) private pure returns (uint256) {
        if (globalSide == 0 || chainSide == 0 || equivHalf == 0) return 0;
        uint256 dF = freshHalf == 0 ? 0 : (freshHalf * 1e18) / globalSide;
        uint256 dR = Math.mulDiv(equivHalf, 1e18, globalSide);
        uint256 d = dF + dR;
        uint256 mR = d <= t ? dR : Math.mulDiv(t, dR, d);
        return Math.ceilDiv(mR * chainSide, 1e18);
    }
}
