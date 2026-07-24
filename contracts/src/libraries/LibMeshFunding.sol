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
 *         RESERVATION IDENTITY (one bucket, one ledger, never both):
 *         mirror-locally-funded slices reserve into that chain's
 *         `chainOutstandingRecycledCommit[c]`; Base-funded shares (Base's
 *         own slice + every top-up) reserve into the GLOBAL
 *         `outstandingCommitRecycled` — both at the #1008-capped
 *         COMMITTABLE amounts (Codex #1315 P1: reserving raw stamps strands
 *         unclaimable remainders), with the ceil-dust trimmed against the
 *         availability actually backing it (reservations can never exceed
 *         what exists).
 *
 *         B2-a is RECORDS-ONLY: nothing broadcasts or consumes these stamps
 *         yet — B2-b ships each destination its own figures and arms the
 *         mirror-side consumption; B3 nets remittances against them.
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

    /// @dev Per-chain working state for the two passes (memory).
    struct ChainWork {
        uint32 chainId;
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
     * @notice Resolve + stamp the armed day's per-chain funding PROJECTION.
     *         B2-a records-only: no ledger is written besides the per-day
     *         stamps — the live day-pool stamp, both outstanding-commitment
     *         ledgers, and every claim/remit consumer keep the Phase-A′
     *         global figures until B2-b flips them to these records (Codex
     *         #1414 r1). Returns the projected funded global total.
     * @param  dayId         Day being finalized (denominators final).
     * @param  coupledTarget The absorption-coupled target `Ā × (1 − m)` —
     *                       NOT pre-capped by Base's fundable balance; the
     *                       per-chain availabilities are the funding bound.
     * @param  freshHalf     The day's per-side fresh floor (for the #1008
     *                       combined-cap in the committable computation).
     * @param  availBase     Base's commitment- and keeper-netted fundable
     *                       balance, captured BEFORE the day's own Phase-A′
     *                       reservation (the projection models funding the
     *                       day, so the day's own commit must not net
     *                       itself out).
     */
    function resolveAndStampDayFunding(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        uint256 coupledTarget,
        uint256 freshHalf,
        uint256 availBase
    ) internal returns (uint256 fundedGlobal) {
        uint256 gLender = s.dailyGlobalLenderInterestNumeraire18[dayId];
        uint256 gBorrower = s.dailyGlobalBorrowerInterestNumeraire18[dayId];
        if (coupledTarget == 0 || (gLender == 0 && gBorrower == 0)) {
            return 0;
        }

        uint32[] storage expected = s.expectedSourceChainIds;
        uint256 n = expected.length;
        if (n == 0) return 0;
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
            if (s.chainDailyIncluded[dayId][c.chainId]) {
                c.targetLender = gLender == 0
                    ? 0
                    : Math.mulDiv(targetHalf, c.chainLender, gLender);
                c.targetBorrower = gBorrower == 0
                    ? 0
                    : Math.mulDiv(targetHalf, c.chainBorrower, gBorrower);
            }
            uint256 targetTotal = c.targetLender + c.targetBorrower;

            c.avail = c.chainId == baseId
                ? availBase
                : _availMirror(s, c.chainId);

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
            fundedGlobal += c.fundedLender + c.fundedBorrower;
        }

        _stampProjection(s, dayId, work, baseId, freshHalf, gLender, gBorrower);
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

    /// @dev Stamp every chain's funding record with its projected
    ///      reservation split (separated from the resolution passes for
    ///      stack headroom under viaIR; the per-chain body lives in its own
    ///      frame for the same reason).
    function _stampProjection(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        ChainWork[] memory work,
        uint32 baseId,
        uint256 freshHalf,
        uint256 gLender,
        uint256 gBorrower
    ) private {
        StampCtx memory ctx = StampCtx({
            baseId: baseId,
            freshHalf: freshHalf,
            gLender: gLender,
            gBorrower: gBorrower,
            t: s.dayCapThreshold18[dayId]
        });
        for (uint256 i; i < work.length; ++i) {
            _stampOne(s, dayId, work[i], ctx);
        }
    }

    /// @dev One chain's projection stamp + event.
    function _stampOne(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        ChainWork memory c,
        StampCtx memory ctx
    ) private {
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

        uint256 localTotal = c.localLender + c.localBorrower;
        uint256 reservedLocal;
        if (c.chainId == ctx.baseId) {
            // Everything Base-funded — one ledger.
            reservedBase = commit;
        } else if (c.fundedLender + c.fundedBorrower != 0) {
            // PROJECTED reservation split (B2-a records-only — the event
            // carries it; the actual ledger writes arm in B2-b): the
            // capped commit attributed pro-rata local-vs-top-up, the
            // local share's ceil-dust trimmed against the availability
            // that actually backs it.
            reservedLocal = Math.mulDiv(
                commit, localTotal, c.fundedLender + c.fundedBorrower
            );
            if (reservedLocal > c.avail) reservedLocal = c.avail;
            reservedBase = commit - reservedLocal;
        }

        s.chainDayRecycledFunding[dayId][c.chainId] = LibVaipakam
            .ChainDayFunding({
            fundedLender: c.fundedLender,
            fundedBorrower: c.fundedBorrower,
            lenderHalfEquiv: equivL,
            borrowerHalfEquiv: equivB,
            recycleConsume: localTotal,
            keeperAllocate: 0,
            stamped: true
        });
        emit ChainDayFundingStamped(
            dayId,
            c.chainId,
            c.fundedLender,
            c.fundedBorrower,
            localTotal,
            reservedLocal,
            reservedBase
        );
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

    /// @dev A mirror's availability from the B1 ledger, net of what Base has
    ///      already instructed it to consume and its own outstanding
    ///      mirror-local reservations.
    function _availMirror(LibVaipakam.Storage storage s, uint32 chainId)
        private
        view
        returns (uint256)
    {
        uint256 reported = s.chainReportedRecycled[chainId];
        uint256 netted = s.chainConsumedRecycled[chainId]
            + s.chainOutstandingRecycledCommit[chainId];
        return reported > netted ? reported - netted : 0;
    }
}
