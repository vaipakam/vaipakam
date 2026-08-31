// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibVpfiRecycle} from "./LibVpfiRecycle.sol";
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
 *         MIRROR LOCAL FUNDING IS ON (B2-d3). This header used to say the
 *         opposite — "DEFERRED to B2-d … Base funds the WHOLE mesh budget
 *         (`avail = 0` on every mirror) … `recycleConsume` rides the wire
 *         as 0" — and the body has contradicted it since B2-d3 landed:
 *         `resolveAndStampDayFunding` routes every non-Base chain through
 *         `_mirrorAvailable` (see the B2-d3 comment beside it) and writes
 *         `recycleConsume: commitLocal`. Reading the header instead of the
 *         body would tell you a mirror never funds its own slice, which is
 *         no longer true and is load-bearing for the two-pass split.
 *
 *         Why the deferral existed, kept because it is the reason the
 *         current shape is safe rather than merely permitted: a mirror
 *         funding its slice from its own bucket BEFORE the backing
 *         remittance arrived would let pre-remittance claims cannibalise
 *         other reward ledgers and report phantom availability to Base.
 *         What made it safe is the legs BELOW — deliberately not given a
 *         count. This sentence has said "two", then "THREE things, not
 *         two", and each number was wrong within a round; a total is a
 *         claim about completeness that nobody has been able to keep true,
 *         while the list itself stays useful without one. A mirror's
 *         availability is Base's model of its committable bucket,
 *         `reported` less the net INSTRUCTION draw and less the net
 *         repatriation draw, never an unbacked optimism. "Claim draw" until
 *         #1349, which was wrong on timing and on meaning: `_stampOne`
 *         increments `chainConsumedRecycled` at FINALIZATION, when Base
 *         instructs the mirror, and `mirrorAvailRecycled` nets it
 *         immediately — long before any mirror claim, of which Base has no
 *         authenticated view at all. An auditor reading "claim" would
 *         expect availability to stay reusable until a user claims:
 *
 *           - d1's commitment report;
 *           - d2's delivered-backing ledger;
 *           - C2's repatriation draw. {RepatriationFacet.authorizeRepatriation}
 *             advances `chainRepatriationDebited` BEFORE dispatch and
 *             {mirrorAvailRecycled} subtracts it as a SEPARATE term from
 *             the instruction draw, so custody pending return to Base
 *             cannot also be offered to day finalization — without it the
 *             same tokens could be authorized for return and recommitted.
 *             The paragraph above already named "the net repatriation
 *             draw" and the list then omitted it, which is how a
 *             self-contradicting count survives a correction.
 *           - d5's custody-relocation exclusion. {creditCustodyRelocated}
 *             raises `recycleBucket` without adding the relocated amount to
 *             `recycleCreditedCumulative`, advancing
 *             `recycleCustodyRelocatedCumulative` instead, which
 *             {LibVpfiRecycle.creditedCumulative} subtracts. It is "not by
 *             the relocated amount", not "never": on an in-place-upgraded
 *             Diamond whose slot is still 0, it SEEDS
 *             `recycleCreditedCumulative` from the derived floor first
 *             (#1448 r3), read before the bucket write so the relocation
 *             itself cannot land in the seed. That write is what preserves
 *             the invariant on an upgrade, so a reader told the counter is
 *             never touched here would mis-audit exactly that case. Drop that
 *             subtraction and Base's own remitted top-up re-enters
 *             `reported` and `_mirrorAvailable` offers it for commitment a
 *             second time — Base reading its own top-up back as the
 *             mirror's absorption. d1 and d2 alone do not close that.
 *
 *         Naming only d1 and d2 here would send someone auditing the
 *         no-phantom-availability property to a SUBSET of the places it
 *         actually lives — and this sentence said "two of the three
 *         places" until #1349, reinstating three paragraphs down the very
 *         count the paragraph above had just removed.
 *
 *         What B2-b made live: each chain gets its own funded per-day
 *         stamp (per-side fresh floors + global-equivalent recycled halves),
 *         Base prices its OWN claims + remittances from its stamp (never the
 *         aggregate), and the per-destination V2 broadcast ships every
 *         mirror its stamp + cap family. That last clause used to end "so
 *         the shape is READY for B2-d to arm mirror consumption against",
 *         which survived the correction above and re-asserted, four
 *         paragraphs later, the pending state the header had just retired.
 *         B2-d3 armed it: mirrors consume against that stamp today.
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
     *         aggregator stamps and reserves. Mirrors DO fund locally since
     *         B2-d3, so `reservedBase` is the BASE-funded remainder rather
     *         than the whole commit, and each mirror's own share rides the
     *         wire as `recycleConsume`. (This paragraph previously described
     *         the B2-b re-slice, where every mirror funded 0 locally and
     *         `reservedBase == Σ commit`; that stopped being true when
     *         B2-d3 landed.)
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
        // NB: `ChainWork memory c = work[i]` ALIASES the array element — a
        // memory struct is a reference type in Solidity, so `c.field = …`
        // writes THROUGH to `work[i]`; pass 2 and `_stampAndArm` read the
        // same mutated elements. (Verified by the two-pass funding tests,
        // which read back non-zero funded figures from the resulting
        // stamps; not a copy.)
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

            // #1222 M3 B2-d3 — mirror LOCAL funding is now ON (the B2-b
            // re-slice deferred it to here, where d1's commitment report,
            // d2's delivered-backing ledger, C2's repatriation draw AND
            // d5's custody-relocation exclusion together make it safe —
            // see this library's header for what each leg contributes and
            // for why no total is given. This comment said d1+d2 until
            // #1349 and then d1+d2+d5, omitting C2's draw even while the
            // sentence below names it. A mirror's
            // availability is Base's model of its committable bucket:
            // `reported` less the net INSTRUCTION draw `sat(consumed −
            // released)` and less the net repatriation draw, the HARD
            // backstop the B1 ledger
            // defines — reported only ever advances on the chain's own
            // authenticated day-close report, and consumed is the cumulative
            // Base has INSTRUCTED it to fund locally. Netting by the
            // instruction is what keeps a chain from being committed twice
            // for the same tokens across days, and makes the §7 invariant
            // `sat(consumed − released) ≤ reported` bind (this cap is its
            // only enforcement point). Base itself keeps its commitment- and
            // keeper-netted
            // `fundable`.
            c.avail = c.chainId == baseId
                ? availBase
                : _mirrorAvailable(s, c.chainId);

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

    /// @dev #1222 M3 B2-d3 — Base's model of a mirror's committable recycle
    ///      bucket. B3 moved the formula into {LibVpfiRecycle} (which owns
    ///      the per-chain ledger) so this funding pass and the
    ///      operator-facing `getChainRecycledLedger` view cannot drift, and
    ///      added the release term: a commitment the mirror FORFEITS or
    ///      EXPIRES un-spent leaves its tokens in the bucket, so it must
    ///      return to availability instead of being lost from Base's model
    ///      forever.
    function _mirrorAvailable(
        LibVaipakam.Storage storage s,
        uint32 chainId
    ) private view returns (uint256) {
        return LibVpfiRecycle.mirrorAvailRecycled(s, chainId);
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

        // #1222 M3 B2-d3 — split the capped commit by FUNDING SOURCE, so
        // §5's "one bucket, one ledger" holds by construction: the share the
        // chain funded from its OWN bucket books into the per-chain ledgers
        // and rides the wire as the `recycleConsume` instruction; Base's
        // top-up books into the GLOBAL `outstandingCommitRecycled` (the
        // aggregator reserves the returned sum). Never both. The split is
        // pro-rata on the funded totals because `commit` is the #1008-capped
        // figure — on armed days the cap is disabled so it tracks `funded`
        // exactly, and on any capped day both sources trim together.
        uint256 commitLocal;
        // Base is NEVER a "local" funder in this split: its own slice is
        // drawn from the same bucket the global ledger already governs, so
        // the whole Base commit is `reservedBase` and Base books no
        // per-chain instruction (§5 — the per-chain books exist to track
        // what a MIRROR holds, and Base double-booking itself would both
        // corrupt the global reservation and net its own bucket twice).
        if (c.chainId != ctx.baseId) {
            uint256 fundedTotal = c.fundedLender + c.fundedBorrower;
            uint256 localTotal = c.localLender + c.localBorrower;
            if (localTotal != 0 && fundedTotal != 0) {
                commitLocal = localTotal >= fundedTotal
                    ? commit
                    : Math.mulDiv(commit, localTotal, fundedTotal);
            }
        }
        reservedBase = commit - commitLocal;
        // #1569 — the Base-authorized keeper instruction rides the SAME local
        // commit, so it exists only where that does. Computed before the
        // ledger writes because the instruction cumulative must count it:
        // Base has told the chain to spend it, and the backstop that stops a
        // chain being committed twice for the same tokens nets against that
        // cumulative.
        uint256 keeperAlloc;
        if (commitLocal != 0) {
            keeperAlloc =
                (commitLocal * s.chainKeeperAllocateBps[c.chainId]) / 10_000;
            // The INSTRUCTION cumulative (B1's definition) — the binding
            // availability backstop `_mirrorAvailable` nets against, so a
            // chain can never be committed twice for the same tokens.
            //
            // ONLY `commitLocal`. The keeper earmark is charged to its own
            // draw slot below, NOT here (Codex #2031 r2): this counter is one
            // half of the `outstanding + retired == consumed` identity, and
            // only `commitLocal` enters the outstanding/retirement lifecycle
            // — a mirror can retire at most what it was committed. Adding the
            // earmark here broke the identity on the first non-zero
            // allocation and left the difference as phantom consumption that
            // permanently suppressed the chain's availability. The storage
            // doc for `chainConsumedRecycled` names exactly this trap for the
            // C2 repatriation draw; the keeper earmark is the same class of
            // non-claim draw, and the first version of this code walked into
            // it while quoting the half of that doc which lists
            // `keeperAllocate` — a definition written while the field was
            // dead, so the identity held vacuously.
            s.chainConsumedRecycled[c.chainId] += commitLocal;
            // The SEPARATE draw term, the sibling of
            // `chainRepatriationDebited`. Availability nets it, so the
            // backstop property the wrong placement was reaching for is
            // preserved: Base still cannot instruct the same tokens twice.
            s.chainKeeperAllocDebited[c.chainId] += keeperAlloc;
            // §5's per-chain reservation ledger, the sibling of the global
            // `outstandingCommitRecycled`. Monotonic in d3: Base has no
            // authenticated view of mirror claims, so B3's source-scoped
            // netting is what retires it. Availability nets by the
            // instruction above ONLY — never by both, or the same commit
            // would be subtracted twice.
            s.chainOutstandingRecycledCommit[c.chainId] += commitLocal;
        }

        s.chainDayRecycledFunding[dayId][c.chainId] = LibVaipakam
            .ChainDayFunding({
            fundedLender: c.fundedLender,
            fundedBorrower: c.fundedBorrower,
            lenderHalfEquiv: equivL,
            borrowerHalfEquiv: equivB,
            // B2-d3 — the locally-funded capped commit: the mirror reserves
            // exactly this at broadcast arrival (same figure, both ledgers),
            // and the remit path nets it out so Base sends only its top-up.
            recycleConsume: commitLocal,
            // #1569 — carved from the chain's OWN local commit, so it is
            // value that chain already holds and Base is telling it how to
            // label — never an extra draw on the mirror.
            keeperAllocate: keeperAlloc,
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
            commitLocal,
            commitLocal,
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
