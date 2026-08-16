// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibPausable} from "./LibPausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title LibInteractionRewards
 * @author Vaipakam Developer Team
 * @notice Phase-2 platform-interaction reward accounting
 *         (docs/TokenomicsTechSpec.md §4 per-day accrual). Replaces the
 *         Phase-1 "lump-sum-at-settlement" model with a delta-driven
 *         daily accrual:
 *
 *           - registerLoan (LoanFacet.initiateLoan) snapshots the loan's
 *             `perDayNumeraire18` and applies +Δ at startDay, −Δ at endDay.
 *           - closeLoan (RepayFacet / DefaultedFacet / RiskFacet) shrinks
 *             the window to `closeDay+1` and sets the CLEAN / FORFEIT
 *             flag on each side's RewardEntry.
 *           - transferLenderEntry (EarlyWithdrawalFacet.completeLoanSale)
 *             closes the old lender entry with forfeit=true and opens a
 *             fresh one for the new lender. The denominator does NOT
 *             change on transfer — only the per-user reward attribution.
 *
 *      Daily pool split 50/50 between lenders (by daily interest earned)
 *      and borrowers (by daily interest paid on CLEAN repayments; late /
 *      defaulted / liquidated / post-grace-cured loans are counted in
 *      the denominator but forfeit their borrower share to treasury).
 *
 *      Claim math per entry:
 *        reward = perDayNumeraire18 × (cumRPN[endDay-1] − cumRPN[startDay-1]) / 1e18
 *      where cumRPN[d] = Σ_{d'≤d} halfPool[d'] × 1e18 / globalTotalNumeraire18[d']
 *      and the global denominator comes from the cross-chain finalized
 *      broadcast (`knownGlobal*InterestNumeraire18[d]`).
 *
 *      Decay schedule (unchanged from Phase 1):
 *        days   0..182   → 32% (3200 bps)   day 0 excluded
 *        days 183..547   → 29% (2900)
 *        days 548..912   → 24% (2400)
 *        days 913..1277  → 20% (2000)
 *        days 1278..1642 → 15% (1500)
 *        days 1643..2007 → 10% (1000)
 *        days 2008..2372 →  5% ( 500)
 *        days     2373+  →  5% ( 500)   // until pool cap
 *
 *      Legacy per-day counter API (userLenderInterestNumeraire18 /
 *      totalLenderInterestNumeraire18 etc.) is retained for the cross-chain
 *      reporter and for test harnesses that seed per-day state directly
 *      via {TestMutatorFacet.setDailyLenderInterest}. The legacy claim
 *      path ({claimForUserWindow}) coexists with the new entry claim
 *      path ({claimForUserEntries}); the facet sums both.
 */
library LibInteractionRewards {
    /// @notice PR-3c — the source decomposition of a processed reward
    ///         entry's value (governor §3.1 dual accumulator).
    /// @param total      Combined capped reward (what actually pays/forfeits).
    /// @param recycled   RECYCLED component (armed days only by construction).
    /// @param armedFresh FRESH component of ARMED days only (`armedCombined
    ///                   − recycled`) — the exact fresh-commitment
    ///                   consumption; pre-arming days never reserved.
    struct EntrySplit {
        uint256 total;
        uint256 recycled;
        uint256 armedFresh;
    }

    /// @notice RL-3 (#1305) — the horizon clock started for `entryId`: the
    ///         sweep observed the entry claim-executable for the first time,
    ///         so the executable-elapsed accumulator has begun. This is the
    ///         notification pipeline's schedule signal.
    /// @dev    Deliberately carries NO expiry timestamp: expiry is driven by
    ///         *executable-elapsed* time (it advances only while the entry
    ///         is provably claimable and keepers observe it), so no fixed
    ///         removal time exists at stamp time — {rewardEntryExpiry} is
    ///         the authoritative, continuously-recomputed countdown.
    /// @custom:event-category state-change/reward-claim
    event RewardEntryHorizonStamped(
        uint256 indexed entryId,
        address indexed user,
        uint64 firstClaimableAt
    );

    /// @notice RL-3 — `entryId` accrued its full horizon of executable time
    ///         and entered the final-notice window: it now needs a further
    ///         `notice` days of provably-executable time before it can be
    ///         swept. This is the notification pipeline's LAST-CALL signal.
    /// @custom:event-category state-change/reward-claim
    event RewardEntryExpiryArmed(
        uint256 indexed entryId,
        address indexed user,
        uint64 finalNoticeFrom
    );

    /// @notice RL-3 — `entryId` expired past its claim horizon and was
    ///         swept into the recycle bucket (`total` split into the
    ///         fresh absorption credit and the `recycled` release).
    /// @dev    FACE-VALUE decomposition, deliberately non-accounting: in
    ///         the pool-cap boundary case the batch's fresh credit is
    ///         truncated AFTER this emits, so the authoritative
    ///         absorbed/released amounts are the `VpfiRecycled` /
    ///         `RewardCommitmentReleased` events (both post-truncation) —
    ///         the designated accounting feeds. Reconcile from those,
    ///         never from this event.
    /// @custom:event-category state-change/reward-claim
    event RewardEntryExpired(
        uint256 indexed entryId,
        address indexed user,
        uint256 total,
        uint256 recycled
    );

    /// @notice #1434 (Codex #1699 r8 P1) — the expiry sweep has begun moving
    ///         this entry's value; it is no longer claimable by its owner.
    ///         This is the REMOVAL POINT. `RewardEntryExpired` still follows at
    ///         terminalization carrying the whole-entry accounting.
    ///
    ///         Emitted once per entry, on the FIRST chunk that credits. A
    ///         deferred sweep credits nothing and emits nothing — the entry
    ///         stays claimable, which is why "a claim before removal wins"
    ///         remains true.
    /// @param entryId Reward entry.
    /// @param user    Entry owner.
    /// @custom:event-category state-change/reward-claim
    event RewardEntryExpiryBegun(uint256 indexed entryId, address indexed user);

    // ─── Schedule helpers ────────────────────────────────────────────────────

    uint256 private constant CUTOFF_0 = 182;
    uint256 private constant CUTOFF_1 = 547;
    uint256 private constant CUTOFF_2 = 912;
    uint256 private constant CUTOFF_3 = 1277;
    uint256 private constant CUTOFF_4 = 1642;
    uint256 private constant CUTOFF_5 = 2007;
    uint256 private constant CUTOFF_6 = 2372;

    /// @dev Per-call ceiling on how many days the cumulative-reward-per-USD
    ///      cursor may advance in a single tx. Claim walks may need several
    ///      follow-up txs to catch up after a long quiet period.
    uint256 internal constant MAX_CUM_ADVANCE_DAYS = 730;

    /// @dev Per-call ceiling on how many days the local total-interest
    ///      frontier may advance in a single tx. Reporter / closeLoan
    ///      apply a small number of days at a time so gas stays bounded.
    uint256 internal constant MAX_FRONTIER_ADVANCE_DAYS = 730;

    /// @notice Returns the annual emission rate in BPS that applied on
    ///         `day` (day-index relative to interactionLaunchTimestamp).
    function annualRateBpsForDay(uint256 day) internal pure returns (uint256) {
        if (day <= CUTOFF_0) return 3200;
        if (day <= CUTOFF_1) return 2900;
        if (day <= CUTOFF_2) return 2400;
        if (day <= CUTOFF_3) return 2000;
        if (day <= CUTOFF_4) return 1500;
        if (day <= CUTOFF_5) return 1000;
        if (day <= CUTOFF_6) return 500;
        return 500;
    }

    /// @notice Half of the day's VPFI emission (goes either to lenders or
    ///         to borrowers). Zero on day 0 (spec §4 excludes the first 24
    ///         hours of the emissions window).
    function halfPoolForDay(uint256 day) internal pure returns (uint256) {
        if (day == 0) return 0;
        uint256 bps = annualRateBpsForDay(day);
        return
            (bps * LibVaipakam.VPFI_INITIAL_MINT) /
            (LibVaipakam.BASIS_POINTS * 365 * 2);
    }

    /// @notice #1222 M3 B2-d3 — a chain's day budget, per SIDE and per
    ///         funding source, GROSS of that chain's own local commitment.
    struct ChainDayBudget {
        uint256 freshLender;
        uint256 recycledLender;
        uint256 freshBorrower;
        uint256 recycledBorrower;
    }

    /// @notice #776 — the aggregate VPFI a chain's users collectively accrue
    ///         for day `dayId`, i.e. that chain's finalized reward *slice*.
    /// @dev    Telescopes the per-user accrual: Σ_users(userNum × half/global)
    ///         = chainNum × half/global, evaluated for each of the lender and
    ///         borrower halves. Uses the FINALIZED global denominators
    ///         (`dailyGlobal*InterestNumeraire18[dayId]`), so callers MUST gate
    ///         on `s.dailyGlobalFinalized[dayId]` first. Integer division
    ///         floors each half; the ≤1-wei-per-half dust stays on Base (a
    ///         consumer chain), matching how the claim path already floors, so
    ///         the remittances can never exceed the day's emission. Returns 0
    ///         when the day pre-dates emissions (`half == 0`), a global
    ///         denominator is zero (no interest on that side that day), or
    ///         `chainId` was NOT part of `dayId`'s finalized denominator
    ///         (`s.chainDailyIncluded[dayId][chainId]` is false). That last gate
    ///         closes the "expected-set changed between report and finalize"
    ///         hole: a chain removed from `expectedSourceChainIds` after it
    ///         reported is excluded from `dailyGlobal*`, but its stale
    ///         `chainDaily*` would otherwise divide by the smaller denominator
    ///         and over-send — so a non-participating chain yields a zero slice.
    ///
    ///         #776 over-fund note: this is the UNCAPPED slice. The live claim
    ///         path also applies the §4 per-user VPFI cap
    ///         (`_capVpfiForInterestUsd`), which can make a mirror's users
    ///         collectively claim LESS than the slice remitted here. Under-funding
    ///         is the only unsafe direction (it would brick a claim); this path
    ///         can only over-fund, which is safe because the surplus VPFI is NOT
    ///         earmarked per-day — it stays in the mirror Diamond's balance and
    ///         the claim path draws from that balance, so it simply pre-funds
    ///         subsequent days' claims on the same mirror. Any true terminal
    ///         excess (a mirror that winds down with unclaimed surplus) is
    ///         recoverable only by governance/upgrade — there is NO Diamond-
    ///         balance ERC20 rescue today (`recoverStuckERC20` withdraws a USER's
    ///         vault proxy, not the Diamond's own VPFI), so this does NOT rely on
    ///         a permissionless sweep. Capping the slice exactly here is
    ///         infeasible: the per-user cap binds per reward-ENTRY over that
    ///         entry's multi-day window, whereas Base holds only the per-DAY
    ///         per-chain aggregate numerators — it cannot reconstruct how the
    ///         windowed cap lands on each mirror user. So bounded-over-fund is the
    ///         deliberate tradeoff.
    /// @param s       Diamond storage.
    /// @param chainId Mirror whose slice to compute.
    /// @param dayId   Finalized day.
    /// @return budget VPFI owed to `chainId` for `dayId` (18-dec).
    function chainRewardBudgetForDay(
        LibVaipakam.Storage storage s,
        uint32 chainId,
        uint256 dayId
    ) internal view returns (uint256 budget) {
        (uint256 budgetFresh, uint256 budgetRecycled) =
            chainRewardBudgetSplitForDay(s, chainId, dayId);
        return budgetFresh + budgetRecycled;
    }

    /// @notice Governor PR-3c (#1217) — the per-chain remittance budget,
    ///         decomposed into its FRESH and RECYCLED funding sources so
    ///         the remit path can account each correctly (fresh reserves
    ///         against the 69M cap; recycled debits the bucket at remit —
    ///         the doc-flagged `chainRewardBudgetForDay` underfunding site).
    ///         Pre-cutover days are fresh-only (legacy schedule).
    /// @notice #1222 M3 B2-d3 (Codex #1430 r3) — the per-chain day budget
    ///         split BY SIDE and by funding source, GROSS of the chain's own
    ///         local commitment.
    /// @dev    The two sides genuinely carry different fresh:recycled
    ///         compositions (that is why B2-b introduced per-side equivalent
    ///         halves), and the mirror reports its liability per side too —
    ///         so any clamp or source-netting that collapses the sides first
    ///         misprices whichever leg the liability actually concentrates
    ///         on. Callers that only need the aggregate use
    ///         {chainRewardBudgetSplitForDay}, which sums these and applies
    ///         the local netting.
    function chainRewardBudgetSideSplitForDay(
        LibVaipakam.Storage storage s,
        uint32 chainId,
        uint256 dayId
    ) internal view returns (ChainDayBudget memory b) {
        // #1222 M3 B2-b — armed days price from the DESTINATION chain's own
        // funding stamp (per-side fresh halves + recycled global-equivalent
        // numerators), never the global aggregate: the aggregate is a
        // metric, and slicing it pro-rata would fund a chain against
        // another chain's reserved slice. Per-side values genuinely differ,
        // so the two sides carry their own halves through the split.
        uint256 lenderFreshHalf;
        uint256 borrowerFreshHalf;
        uint256 lenderRecycledHalf;
        uint256 borrowerRecycledHalf;
        {
            uint256 armedFrom = s.governorCommitArmedFromDay;
            if (armedFrom != 0 && dayId >= armedFrom) {
                LibVaipakam.DayPoolStamp storage p = s.dayPoolStamp[dayId];
                // Fail-closed: an armed day without a stamp funds nothing
                // yet (finalization/broadcast pending) — same wait the
                // claim-side accumulators apply.
                if (!p.stamped) return b;
                LibVaipakam.ChainDayFunding storage f =
                    s.chainDayRecycledFunding[dayId][chainId];
                if (f.stamped) {
                    lenderFreshHalf = f.freshLenderHalf;
                    borrowerFreshHalf = f.freshBorrowerHalf;
                    lenderRecycledHalf = f.lenderHalfEquiv;
                    borrowerRecycledHalf = f.borrowerHalfEquiv;
                } else {
                    // Mesh-skipped armed day (no coupled target / no
                    // demand): the broadcast shipped this destination the
                    // global fresh floor halves + zero recycled — fund it
                    // the same way.
                    lenderFreshHalf = uint256(p.scheduleFloor) / 2;
                    borrowerFreshHalf = lenderFreshHalf;
                }
            } else {
                lenderFreshHalf = halfPoolForDay(dayId);
                borrowerFreshHalf = lenderFreshHalf;
            }
        }
        if (
            lenderFreshHalf == 0 && borrowerFreshHalf == 0
                && lenderRecycledHalf == 0 && borrowerRecycledHalf == 0
        ) {
            return b;
        }
        // #776 — only chains whose numerator was folded into `dayId`'s finalized
        // denominator get a slice; a reported-but-then-de-listed chain is out.
        if (!s.chainDailyIncluded[dayId][chainId]) return b;
        // #1008 (S13) — cap the per-chain remittance with the SAME finalize-
        // snapshotted threshold the per-user claims use. Because the §4 threshold
        // is ENTRY-INDEPENDENT, `min(Δ_d, T_d)` factors out of the per-user sum, so
        // the capped chain budget per side is `min(Δ_d, T_d) · chainNumeraire / 1e18`
        // — using the SAME floored `Δ_d = half·1e18/global` the claim's `cumMin`
        // uses. CEIL (not floor) per side so `Σ_days ceil ≥` the once-floored claim
        // over ANY window: a mirror is never underfunded (Codex #1147 r5 I1 / r6 J5).
        // `t == max` (cap disabled that day) ⇒ `min == Δ_d` ⇒ uncapped.
        // PR-3c — the cap applies to the COMBINED per-day Δ first, then the
        // capped value is apportioned pro-rata across the two sources —
        // mirroring the claim-side accumulators exactly so per-chain funding
        // and per-user claims can never diverge on the split.
        uint256 t = s.dayCapThreshold18[dayId];
        uint256 gLender = s.dailyGlobalLenderInterestNumeraire18[dayId];
        if (gLender != 0) {
            (b.freshLender, b.recycledLender) = _sideBudgetSplit(
                lenderFreshHalf,
                lenderRecycledHalf,
                gLender,
                t,
                s.chainDailyLenderInterestNumeraire18[dayId][chainId]
            );
        }
        uint256 gBorrower = s.dailyGlobalBorrowerInterestNumeraire18[dayId];
        if (gBorrower != 0) {
            (b.freshBorrower, b.recycledBorrower) = _sideBudgetSplit(
                borrowerFreshHalf,
                borrowerRecycledHalf,
                gBorrower,
                t,
                s.chainDailyBorrowerInterestNumeraire18[dayId][chainId]
            );
        }
    }

    /// @notice The chain's day budget as an AGGREGATE (fresh, recycled) pair,
    ///         with the chain's own local commitment netted out of the
    ///         recycled side.
    /// @dev    #1222 M3 B2-d3 TWO-SIDED NETTING: the chain funded
    ///         `recycleConsume` of this day's recycled budget from its OWN
    ///         bucket (reserved at broadcast arrival, drawn down by its own
    ///         claims), so Base remits only the TOP-UP it actually funded —
    ///         locally-committed + Base-remitted = the funded recycled slice.
    ///         Remitting the whole slice would double-fund the local share
    ///         and cannibalise Base's bucket for tokens the mirror already
    ///         holds. Floored: the stamped instruction is the #1008-capped
    ///         commit while this budget is the CEIL-per-side slice, so
    ///         wei-scale rounding can leave the instruction marginally the
    ///         larger figure. Fresh is untouched — Base funds all fresh.
    ///
    ///         NOTE (Codex #1430 r3): the armed-day remit CLAMP must NOT use
    ///         this aggregate — it nets and clamps per SIDE, because the two
    ///         sides carry different fresh:recycled compositions and the
    ///         mirror reports its liability per side. See
    ///         {chainRewardBudgetSideSplitForDay} and `_planDay`.
    function chainRewardBudgetSplitForDay(
        LibVaipakam.Storage storage s,
        uint32 chainId,
        uint256 dayId
    ) internal view returns (uint256 budgetFresh, uint256 budgetRecycled) {
        ChainDayBudget memory b =
            chainRewardBudgetSideSplitForDay(s, chainId, dayId);
        budgetFresh = b.freshLender + b.freshBorrower;
        uint256 gross = b.recycledLender + b.recycledBorrower;
        uint256 localCommit =
            s.chainDayRecycledFunding[dayId][chainId].recycleConsume;
        budgetRecycled = gross > localCommit ? gross - localCommit : 0;
    }

    /// @dev One side's capped per-chain budget, split fresh/recycled with
    ///      the combined-first + pro-rata trim rule. CEIL per side so the
    ///      remitted funding can never fall below the once-floored claim
    ///      (Codex #1147 r5 I1 — unchanged from the single-source math).
    function _sideBudgetSplit(
        uint256 freshHalf,
        uint256 recycledHalf,
        uint256 globalTotal,
        uint256 t,
        uint256 chainNumeraire
    ) private pure returns (uint256 f, uint256 r) {
        uint256 dF = freshHalf == 0 ? 0 : (freshHalf * 1e18) / globalTotal;
        uint256 dR =
            recycledHalf == 0 ? 0 : (recycledHalf * 1e18) / globalTotal;
        uint256 d = dF + dR;
        if (d == 0) return (0, 0);
        // Codex #1315 P2 — no-trim fast path (also overflow-proof: the
        // pro-rata product only runs when a trim actually happened, and
        // then via 512-bit mulDiv so a tiny denominator's huge RPN values
        // can't revert the cursor and block the day's claims).
        uint256 mF;
        uint256 mR;
        if (d <= t) {
            mF = dF;
            mR = dR;
        } else {
            mR = Math.mulDiv(t, dR, d); // pro-rata recycled share of the cap
            mF = t - mR;
        }
        f = _ceilDiv(mF * chainNumeraire, 1e18);
        r = _ceilDiv(mR * chainNumeraire, 1e18);
    }

    /// @notice Governor PR-3c (Codex #1315 P1) — the day's truly
    ///         COMMITTABLE budget per source: the #1008-capped,
    ///         pro-rata-split, per-side totals against the finalized
    ///         global denominators (a zero-denominator side commits
    ///         nothing). This is what finalization reserves — reserving
    ///         the raw stamp would strand unclaimable remainders in the
    ///         outstanding sums forever.
    function committableForDay(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        uint256 freshHalf,
        uint256 recycledHalf
    ) internal view returns (uint256 commitFresh, uint256 commitRecycled) {
        uint256 t = s.dayCapThreshold18[dayId];
        uint256 gLender = s.dailyGlobalLenderInterestNumeraire18[dayId];
        if (gLender != 0) {
            (uint256 f, uint256 r) =
                _sideBudgetSplit(freshHalf, recycledHalf, gLender, t, gLender);
            commitFresh += f;
            commitRecycled += r;
        }
        uint256 gBorrower = s.dailyGlobalBorrowerInterestNumeraire18[dayId];
        if (gBorrower != 0) {
            (uint256 f, uint256 r) =
                _sideBudgetSplit(freshHalf, recycledHalf, gBorrower, t, gBorrower);
            commitFresh += f;
            commitRecycled += r;
        }
    }

    /// @dev Ceiling division `⌈a / b⌉` (b != 0). Used by the per-chain remittance
    ///      so the per-day-floored budget can never fall below the once-floored
    ///      multi-day claim (Codex #1147 r5 I1).
    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    /// @notice Current day index (days since launch). Reverts when the
    ///         launch timestamp is unset or in the future.
    function currentDay() internal view returns (uint256) {
        uint256 launch = LibVaipakam.storageSlot().interactionLaunchTimestamp;
        require(launch != 0 && block.timestamp >= launch, "emissions idle");
        return (block.timestamp - launch) / 1 days;
    }

    /// @notice Non-reverting variant of {currentDay} — returns 0 when the
    ///         emissions window has not started.
    function currentDayOrZero() internal view returns (uint256 day, bool active) {
        uint256 launch = LibVaipakam.storageSlot().interactionLaunchTimestamp;
        if (launch == 0 || block.timestamp < launch) return (0, false);
        return ((block.timestamp - launch) / 1 days, true);
    }

    // ─── Legacy Phase-1 hooks (still used by test mutators + reporter) ──────

    /// @notice [LEGACY] Credit lender side for settlement-day interest.
    ///         Retained so pre-existing tests that build reward state via
    ///         {TestMutatorFacet.setDailyLenderInterest} continue to work;
    ///         real loans use {registerLoan}/{closeLoan} instead.
    function recordLenderInterest(
        address lender,
        address feeAsset,
        uint256 interestAmount
    ) internal {
        (uint256 day, bool active) = currentDayOrZero();
        if (!active) return;
        uint256 usd = _interestToNumeraire18(feeAsset, interestAmount);
        if (usd == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.userLenderInterestNumeraire18[day][lender] += usd;
        s.totalLenderInterestNumeraire18[day] += usd;
    }

    /// @notice [LEGACY] Mirror of {recordLenderInterest} for borrower side.
    function recordBorrowerInterest(
        address borrower,
        address feeAsset,
        uint256 interestAmount
    ) internal {
        (uint256 day, bool active) = currentDayOrZero();
        if (!active) return;
        uint256 usd = _interestToNumeraire18(feeAsset, interestAmount);
        if (usd == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.userBorrowerInterestNumeraire18[day][borrower] += usd;
        s.totalBorrowerInterestNumeraire18[day] += usd;
    }

    // ─── Phase-2 reward entry registration / close / transfer ───────────────

    /**
     * @notice Register a newly-initiated loan with the Phase-2 per-day
     *         accrual machinery. Silent no-op when:
     *           - emissions haven't been seeded (launch timestamp zero);
     *           - the principal asset has no Chainlink feed / malformed
     *             decimals (perDayNumeraire18 rounds to zero);
     *           - principal × bps rounds to zero.
     *
     *         `startDay` is always `currentDay + 1` so a sub-24h-old loan
     *         never competes for today's emission pool (spec §4 day-0
     *         exclusion also applies to the very first day of each loan).
     *
     * @param loanId          Loan id being registered.
     * @param lender          Lender address; receives a lender-side entry.
     * @param borrower        Borrower address; receives a borrower-side entry.
     * @param principalAsset  Asset in which interest is denominated.
     * @param principal       Principal in `principalAsset` wei.
     * @param interestRateBps Annualized rate in basis points.
     * @param durationDays    Contracted loan duration.
     */
    function registerLoan(
        uint256 loanId,
        address lender,
        address borrower,
        address principalAsset,
        uint256 principal,
        uint256 interestRateBps,
        uint256 durationDays
    ) internal {
        (uint256 today, bool active) = currentDayOrZero();
        if (!active) return;
        if (principal == 0 || interestRateBps == 0 || durationDays == 0) return;

        uint256 perDayNumeraire18 = _perDayInterestNumeraire18(
            principalAsset,
            principal,
            interestRateBps
        );
        if (perDayNumeraire18 == 0) return;

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 startDay = today + 1;
        uint256 endDay = startDay + durationDays;

        uint256 lenderId = _allocEntry(
            s,
            lender,
            loanId,
            startDay,
            endDay,
            LibVaipakam.RewardSide.Lender,
            perDayNumeraire18
        );
        s.loanActiveLenderEntryId[loanId] = lenderId;

        uint256 borrowerId = _allocEntry(
            s,
            borrower,
            loanId,
            startDay,
            endDay,
            LibVaipakam.RewardSide.Borrower,
            perDayNumeraire18
        );
        s.loanBorrowerEntryId[loanId] = borrowerId;

        _applyDelta(s.lenderPerDayDeltaNumeraire18, s.lenderFrontierDay, startDay, SafeCast.toInt256(perDayNumeraire18));
        _applyDelta(s.lenderPerDayDeltaNumeraire18, s.lenderFrontierDay, endDay, -SafeCast.toInt256(perDayNumeraire18));
        _applyDelta(s.borrowerPerDayDeltaNumeraire18, s.borrowerFrontierDay, startDay, SafeCast.toInt256(perDayNumeraire18));
        _applyDelta(s.borrowerPerDayDeltaNumeraire18, s.borrowerFrontierDay, endDay, -SafeCast.toInt256(perDayNumeraire18));
    }

    /**
     * @notice Close both sides of a loan's reward entries at `today`.
     *         The lender and borrower entries are shrunk from their
     *         contracted endDay to `min(originalEndDay, today+1)` and
     *         flagged according to the close reason.
     *
     *         Forfeit routing (user directive):
     *           - `lenderForfeit = true` on the lender entry → the
     *             entry's reward routes to treasury on claim/sweep.
     *             Set by the early-withdrawal path when completing a
     *             sale, and by Preclose when the initiator is the
     *             lender (wired at the call site, not here).
     *           - `!borrowerClean` on the borrower entry ⇒ forfeited.
     *             Defaults, liquidations, post-grace cures and preclose-
     *             by-borrower all end here.
     *
     * @param loanId         Loan id being closed.
     * @param borrowerClean  True only for in-grace full repayment by
     *                       the borrower (not fallback cure, not any
     *                       forced close).
     * @param lenderForfeit  True iff the lender forfeits their reward
     *                       (early-withdrawal sale initiator).
     */
    function closeLoan(
        uint256 loanId,
        bool borrowerClean,
        bool lenderForfeit
    ) internal {
        (uint256 today, bool active) = currentDayOrZero();
        if (!active) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // #1067 (S13 Part 2) — CENTRALIZED holder re-anchor: before closing an
        // OPEN entry, re-point it to the live position-NFT holder so the reward
        // closes to the same party the funds go to (every close path routes
        // through here, so repay / default / HF-liquidation / preclose all
        // inherit it — Codex #1147 r2 F6). Skips already-closed entries so a
        // frozen slice is never moved to a later holder (F8).
        LibVaipakam.Loan storage l = s.loans[loanId];

        uint256 lenderId = s.loanActiveLenderEntryId[loanId];
        if (lenderId != 0) {
            _reanchorOpenSide(s, loanId, lenderId, l.lenderTokenId, true);
            _closeEntry(
                s,
                lenderId,
                today,
                /* forfeited */ lenderForfeit,
                s.lenderPerDayDeltaNumeraire18,
                s.lenderFrontierDay
            );
            s.loanActiveLenderEntryId[loanId] = 0;
        }
        uint256 borrowerId = s.loanBorrowerEntryId[loanId];
        if (borrowerId != 0) {
            _reanchorOpenSide(s, loanId, borrowerId, l.borrowerTokenId, false);
            _closeEntry(
                s,
                borrowerId,
                today,
                /* forfeited */ !borrowerClean,
                s.borrowerPerDayDeltaNumeraire18,
                s.borrowerFrontierDay
            );
            // Leave s.loanBorrowerEntryId set so {sweepForfeitedByLoanId}
            // can still locate it after close.
        }
    }

    /// @dev #1067 — re-point an OPEN entry to the current position-NFT holder
    ///      before it is closed. Reads `ownerOf(tokenId)` in the diamond context
    ///      (`address(this)` routes to {VaipakamNFTFacet}). Never re-anchors an
    ///      already-closed entry (its reward is earned + frozen — moving it would
    ///      hand a prior holder's slice to a later one). Tolerates a burned/absent
    ///      token via try/catch. `repointRewardEntry` is O(1) (see
    ///      {rewardEntryUserIdx}), so this is safe on the fund-critical close path.
    function _reanchorOpenSide(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        uint256 entryId,
        uint256 tokenId,
        bool isLenderSide
    ) private {
        if (entryId == 0) return;
        if (s.rewardEntries[entryId].closed) return;
        try IERC721(address(this)).ownerOf(tokenId) returns (address holder) {
            if (holder != address(0)) {
                repointRewardEntry(loanId, holder, isLenderSide);
            }
        } catch {
            // Token burned / absent — nothing to re-anchor.
        }
    }

    /**
     * @notice Swap the lender-side entry for `loanId`: close the current
     *         lender entry with forfeit=true (old lender forfeits their
     *         accrual to treasury per user directive), and open a fresh
     *         entry for `newLender` covering the remainder of the
     *         contracted window. The denominator is unchanged.
     *
     * @param loanId    Loan id whose lender position transfers.
     * @param newLender Incoming lender address.
     */
    function transferLenderEntry(uint256 loanId, address newLender) internal {
        (uint256 today, bool active) = currentDayOrZero();
        if (!active) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        uint256 oldId = s.loanActiveLenderEntryId[loanId];
        if (oldId == 0) return;

        LibVaipakam.RewardEntry storage oldEntry = s.rewardEntries[oldId];
        uint256 originalEnd = oldEntry.endDay; // snapshot before close mutates it
        uint256 perDay = oldEntry.perDayNumeraire18;

        // Shrink the old entry at today+1 (or earlier if already closed).
        _closeEntry(
            s,
            oldId,
            today,
            /* forfeited */ true,
            s.lenderPerDayDeltaNumeraire18,
            s.lenderFrontierDay
        );

        // #953 (Codex) — the pointer below is about to move off `oldId`, orphaning
        // this now-forfeited entry from `sweepForfeitedByLoanId`. Record it so the
        // permissionless sweep can still route its forfeit to treasury even if the
        // exiting holder is later sanctioned (and thus blocked from claiming).
        s.loanForfeitedLenderEntryIds[loanId].push(oldId);

        uint256 newStart = today + 1;
        if (newStart >= originalEnd) {
            // No residual window for the new lender — clear the pointer.
            s.loanActiveLenderEntryId[loanId] = 0;
            return;
        }

        uint256 newId = _allocEntry(
            s,
            newLender,
            loanId,
            newStart,
            originalEnd,
            LibVaipakam.RewardSide.Lender,
            perDay
        );
        s.loanActiveLenderEntryId[loanId] = newId;
        _applyDelta(s.lenderPerDayDeltaNumeraire18, s.lenderFrontierDay, newStart, SafeCast.toInt256(perDay));
        _applyDelta(s.lenderPerDayDeltaNumeraire18, s.lenderFrontierDay, originalEnd, -SafeCast.toInt256(perDay));
    }

    /**
     * @notice #594 — **re-point** a loan's active reward entry (lender or
     *         borrower side) to the current position-NFT holder when a
     *         transferred position is consolidated into their vault.
     * @dev    Consolidation is NOT a sale: the holder already owns the position
     *         (the NFT moved), so the reward entry transfers to them **intact**
     *         — re-pointed, not forfeit+reopened like {transferLenderEntry}
     *         (which is the *sale* path). Re-pointing is also the correct fix
     *         for the sweep-discoverability gap a forfeit+reopen would open
     *         (Codex #655 Msn): the per-loan pointer
     *         (`loanActiveLenderEntryId` / `loanBorrowerEntryId`) keeps pointing
     *         at the SAME entry id, so `sweepForfeitedByLoanId` still locates it.
     *
     *         The entry's day-window and `perDayNumeraire18` are unchanged — only
     *         `RewardEntry.user` and the per-user index membership move — so the
     *         global per-day deltas need NO adjustment.
     *
     * @param loanId       Loan whose position transferred.
     * @param newUser      Incoming current NFT holder.
     * @param isLenderSide true = lender entry, false = borrower entry.
     */
    function repointRewardEntry(
        uint256 loanId,
        address newUser,
        bool isLenderSide
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 id = isLenderSide
            ? s.loanActiveLenderEntryId[loanId]
            : s.loanBorrowerEntryId[loanId];
        if (id == 0) return;

        LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
        address oldUser = e.user;
        if (oldUser == newUser) return;

        _removeUserEntry(s, oldUser, id);
        s.userRewardEntryIds[newUser].push(id);
        // #1067 — maintain the O(1) membership index on the newUser push.
        s.rewardEntryUserIdx[id] = s.userRewardEntryIds[newUser].length;
        e.user = newUser;
        // Per-loan pointer already references `id`; sweep + per-user claim now
        // resolve to `newUser`.
    }

    /// @dev Swap-pop `id` out of `userRewardEntryIds[user]` in O(1) via the
    ///      {rewardEntryUserIdx} index (#1067). No-op if absent. Rewrites the
    ///      moved tail entry's index and clears `id`'s.
    function _removeUserEntry(
        LibVaipakam.Storage storage s,
        address user,
        uint256 id
    ) private {
        uint256 idxPlus1 = s.rewardEntryUserIdx[id];
        if (idxPlus1 == 0) return; // not indexed / already removed
        uint256[] storage ids = s.userRewardEntryIds[user];
        uint256 i = idxPlus1 - 1;
        uint256 n = ids.length;
        // Defensive: the index must point at `id` in THIS user's array.
        if (i >= n || ids[i] != id) return;
        uint256 lastIdx = n - 1;
        if (i != lastIdx) {
            uint256 moved = ids[lastIdx];
            ids[i] = moved;
            s.rewardEntryUserIdx[moved] = i + 1; // rewrite the moved entry's index
        }
        ids.pop();
        s.rewardEntryUserIdx[id] = 0;
    }

    // ─── Frontier advance (local totals + cum-per-USD) ──────────────────────

    /**
     * @notice Advance the lender side's per-day local-total frontier
     *         through `through`. Applies each pending delta and writes
     *         `totalLenderInterestNumeraire18[d] += openPerDayNumeraire18` for every
     *         advanced day. ADDITIVE so legacy test mutators that seed
     *         `totalLenderInterestNumeraire18[d]` directly aren't overwritten.
     *
     *         Called by the cross-chain reporter before shipping a day's
     *         local total, and by claim/preview paths that need the
     *         local totals to be in sync before computing cumRPN.
     *
     *         Bounded at {MAX_FRONTIER_ADVANCE_DAYS}; extra calls are
     *         required to catch up beyond the per-tx cap.
     *
     * @param through Day index to advance through (inclusive).
     */
    function advanceLenderThrough(uint256 through) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 frontier = s.lenderFrontierDay;
        if (through <= frontier) return;
        uint256 cap = frontier + MAX_FRONTIER_ADVANCE_DAYS;
        if (through > cap) through = cap;

        uint256 open = s.lenderOpenPerDayNumeraire18;
        for (uint256 d = frontier + 1; d <= through; ) {
            int256 delta = s.lenderPerDayDeltaNumeraire18[d];
            if (delta != 0) {
                // safe: `open` is uint256, `delta` is int256; signed
                // arithmetic on the delta requires the int256 cast, and
                // the result is guaranteed non-negative by the invariant
                // that lifetime deltas can never drive `open` below 0
                // (any unwind decrements past the open balance is gated
                // earlier in the call sites). Both casts are required.
                // forge-lint: disable-next-line(unsafe-typecast)
                open = uint256(int256(open) + delta);
            }
            s.totalLenderInterestNumeraire18[d] += open;
            unchecked { ++d; }
        }
        s.lenderOpenPerDayNumeraire18 = open;
        s.lenderFrontierDay = through;
    }

    /// @notice Mirror of {advanceLenderThrough} for the borrower side.
    /// @param through Day index to advance through (inclusive).
    function advanceBorrowerThrough(uint256 through) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 frontier = s.borrowerFrontierDay;
        if (through <= frontier) return;
        uint256 cap = frontier + MAX_FRONTIER_ADVANCE_DAYS;
        if (through > cap) through = cap;

        uint256 open = s.borrowerOpenPerDayNumeraire18;
        for (uint256 d = frontier + 1; d <= through; ) {
            int256 delta = s.borrowerPerDayDeltaNumeraire18[d];
            if (delta != 0) {
                // safe: `open` is uint256, `delta` is int256; signed
                // arithmetic on the delta requires the int256 cast, and
                // the result is guaranteed non-negative by the invariant
                // that lifetime deltas can never drive `open` below 0
                // (any unwind decrements past the open balance is gated
                // earlier in the call sites). Both casts are required.
                // forge-lint: disable-next-line(unsafe-typecast)
                open = uint256(int256(open) + delta);
            }
            s.totalBorrowerInterestNumeraire18[d] += open;
            unchecked { ++d; }
        }
        s.borrowerOpenPerDayNumeraire18 = open;
        s.borrowerFrontierDay = through;
    }

    /**
     * @notice Advance the lender-side cumulative-reward-per-USD cursor
     *         through `through`. Uses the GLOBAL finalized denominator
     *         (`knownGlobalLenderInterestNumeraire18[d]`) so cross-chain
     *         correctness is preserved. Halts at the first day without
     *         `knownGlobalSet[d]`. Bounded at {MAX_CUM_ADVANCE_DAYS}.
     *
     * @param through Day index to advance through (inclusive).
     * @return reached Highest day actually reached (may be < `through`
     *                 if the finalization gate or per-call cap intervened).
     */
    /// @dev PR-3c — the redesign's D* predicate: `armed != 0 && d >= armed`
    ///      (NEVER `>=` alone — default 0 would make every day post-cutover).
    function _isArmedDay(
        LibVaipakam.Storage storage s,
        uint256 d
    ) private view returns (bool) {
        uint256 armedFrom = s.governorCommitArmedFromDay;
        return armedFrom != 0 && d >= armedFrom;
    }

    /// @dev Governor PR-3c (#1217 §3.1) — resolve day `d`'s pool halves for
    ///      the accumulator build, for ONE side.
    ///
    ///      Pre-cutover days keep the legacy schedule (`halfPoolForDay`,
    ///      fresh-only). Post-cutover days (`armedFrom != 0 && d >=
    ///      armedFrom` — NEVER `>=` alone, per the redesign's D* rule) read
    ///      THIS CHAIN'S OWN per-(day,chain) funding stamp (#1222 M3 B2-b —
    ///      never the global day-pool stamp: under per-chain funding a
    ///      chain's claimable figures are its own funded per-side fresh
    ///      halves and recycled global-equivalent numerators, written at
    ///      finalization on Base and at broadcast-V2 arrival on mirrors;
    ///      pricing from the global aggregate would compute ≈ p_chain × Σ
    ///      funded instead of the chain's reserved slice). The two sides
    ///      genuinely differ, so the caller names its side. A post-cutover
    ///      day whose stamp hasn't landed yet (mirror waiting on the V2
    ///      broadcast) HALTS the cursor — the same fail-closed wait the
    ///      `knownGlobalSet` gate already applies, so a claim can never
    ///      price an armed day from the wrong pool.
    ///
    ///      #1222 M3 B2-b (re-slice, Codex #1417 r7) — per-chain pricing was
    ///      CANONICAL-ONLY, with an armed day on a MIRROR halting outright:
    ///      the mirror's recycled funding arrived by remittance, which never
    ///      credited the local recycle bucket, so pricing the stamp's recycled
    ///      equivalents and then debiting that bucket at claim would either
    ///      brick a correctly-remitted claim or cannibalise the mirror's own
    ///      local recycled balance.
    ///
    ///      **B2-d4 attempted to lift this halt and the attempt was
    ///      WITHDRAWN — the halt STAYS. Do not remove it without the two
    ///      prerequisites below** (design record §2g; follow-up card filed off
    ///      #1433 r2). B2-d5 discharged the ONE precondition named above (the
    ///      arriving recycled share now credits the mirror's bucket as
    ///      relocated custody), and the recycled leg is separately safe because
    ///      the ShareOfPool walk budgets it against the live bucket and DEFERS
    ///      a day it cannot cover. But review found the halt is load-bearing
    ///      for two further things d5 never addressed — **both since
    ///      DISCHARGED, which is why the halt is gone (#1434 P1-b)**:
    ///
    ///        1. **The FRESH side had no delivered-funding bound on a mirror.**
    ///           All fresh funding is Base-funded and arrives with the remit,
    ///           yet the walk bounded fresh only by `poolRemaining()` — on a
    ///           mirror that is the GLOBAL 69M cap less LOCAL payouts, not
    ///           what has been received. Pricing fresh before the remit landed
    ///           would pay out of VPFI the Diamond holds for other obligations
    ///           (LIF custody, earlier days' unclaimed budget). DISCHARGED by
    ///           `PoolBudget.deliveredFresh` — but NOT, as this note once
    ///           proposed, by giving `PoolBudget.fresh` the delivered budget:
    ///           that supplies the VALUE bound while inheriting the fresh
    ///           path's TERMINAL truncate-and-consume, which is wrong for a
    ///           budget that grows. The bound is carried as its own term and
    ///           its shortfall DEFERS. See {PoolBudget} and the per-leg
    ///           asymmetry note in {processUserSideDay}.
    ///        2. **Deliberately-zeroed days would retire entries for zero.**
    ///           A grace/force finalization that excludes a mirror's interest
    ///           report broadcasts an all-zero stamp and marks the day
    ///           `remitIneligible` for later operator-sized funding. With the
    ///           halt gone the mirror advances its cursor at zero delta,
    ///           `processUserSideDay` treats `rawPay == 0` as terminal
    ///           progress and persists the cursor — so the entries are retired
    ///           before `remitManualBudget` can compensate them.
    ///
    ///      Also withdrawn (Codex #1433 r1): gating pricing on a per-day remit
    ///      ARRIVAL marker. A day Base never remits — one funded entirely from
    ///      the mirror's own balance, or one whose liability clamps to zero —
    ///      would never be marked, and because the cumulative cursor `break`s
    ///      on the first halted day it would wedge every later claim forever.
    ///
    ///      **Standing constraint: key a funding wait on the AMOUNT present,
    ///      never on the ARRIVAL of a message.** Both stop at the offending day
    ///      (a pool-budget shortfall makes `processUserSideDay` return
    ///      `advanced == false`, `_walkSideDays` breaks, and `_lowestPendingDay`
    ///      re-selects that same day next attempt — later days do wait). The
    ///      difference is whether the wait can ever END: a budget shortfall
    ///      clears when the funding lands, and for a funded day it always does;
    ///      a wait on a message that is never sent is permanent.
    /// @return freshHalf    This side's fresh pool for day `d`.
    /// @return recycledHalf This side's recycled global-equivalent numerator
    ///                      (0 pre-cutover).
    /// @return halt         True ⇒ armed day not priceable here: stop
    ///                      advancing. Since #1434 P1-b this means ONE thing —
    ///                      no funding stamp yet. The blanket mirror arm is
    ///                      gone; a mirror that is merely under-funded now
    ///                      defers through the delivered bound instead, which
    ///                      is a per-day, self-clearing wait rather than a
    ///                      chain-wide stop.
    function _dayPoolHalves(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardSide side,
        uint256 d
    )
        private
        view
        returns (uint256 freshHalf, uint256 recycledHalf, bool halt)
    {
        if (_isArmedDay(s, d)) {
            // #1434 P1-b — the blanket mirror halt that stood here is GONE.
            // Both prerequisites are now discharged: prerequisite 2 by w3's
            // `_p2DayDeltas` ladder (consulted before this function and
            // itself the per-day §2.1 gate), and prerequisite 1 by the
            // delivered-fresh bound this slice adds — which supplies the
            // missing VALUE bound AND, crucially, the DEFERRAL semantics
            // that bound needs (see {PoolBudget.deliveredFresh}). B2-d4's
            // removal of this line was withdrawn precisely because it
            // shipped neither.
            //
            // A mirror now prices its armed days from its own stamped
            // funding exactly as Base does; what stops it overpaying is no
            // longer a blanket halt but a bound that can actually clear.
            LibVaipakam.ChainDayFunding storage f =
                s.chainDayRecycledFunding[d][uint32(block.chainid)];
            if (!f.stamped) return (0, 0, true);
            // #1434 P1-b — NOTE FOR ANYONE TEMPTED TO GATE HERE. An earlier
            // revision of this slice halted an armed MIRROR day whose
            // `deliveredFreshBound` did not cover this side's stamped fresh
            // half, reasoning that the fold must be gated so one check covers
            // the walk AND the bulk entry path. It is WRONG and the suite
            // proves it: the stamped half is the day's CAPACITY, not its
            // liability — what actually pays is bounded by the D1 ceiling and
            // by which claimants exist, typically far less — so requiring
            // full coverage halts days the chain can comfortably fund.
            //
            // The w3 compensated-day gate looks like a precedent and is not:
            // it compares delivered funding against the side's QUOTED SUM,
            // and a quote IS that day's liability, so full coverage is the
            // right test there. Same shape, different quantity.
            //
            // PRICING IS NOT PAYMENT. This function advances a counterfactual
            // entitlement cursor; the delivered bound belongs on every
            // PAYMENT route (the walk, and the bulk entry pricing), where the
            // spend is actually known.
            return side == LibVaipakam.RewardSide.Lender
                ? (f.freshLenderHalf, f.lenderHalfEquiv, false)
                : (f.freshBorrowerHalf, f.borrowerHalfEquiv, false);
        }
        return (halfPoolForDay(d), 0, false);
    }

    /// @notice #1434 P2-w3 (§1.4) — Δq for side `s` on day `d`: the
    ///         counterfactual fair-share delta `halfPool_s × 1e18 /
    ///         (G_s + L_s)`, from FROZEN inputs only.
    /// @dev    The numerator is the DAY-level finalize-snapshotted funded
    ///         half — `dayPoolStamp[d].scheduleFloor / 2`, the broadcast's
    ///         floor-half stored by the mirror's apply — NOT this chain's
    ///         per-(day,chain) funding slice (#1636 r1 P1: a deliberately
    ///         zeroed destination's slice is stamped ZERO by
    ///         `_perDestFields`, so reading it here would quote (0,0) for
    ///         a demand-carrying day and wrongly resolve it to zero; and
    ///         not the raw schedule half either, which overstates what
    ///         finalization funded near 69M exhaustion). `G_s` is the
    ///         frozen global denominator that EXCLUDES this chain; `L_s`
    ///         is the mirror's own folded side total. NOT the day's Δ_d,
    ///         whose excluded denominator is zero on the constraint-17
    ///         side. `G_s + L_s == 0` (or an unstamped/zero pool) ⇒ zero —
    ///         the genuinely-zero side (the quote surface separately
    ///         REFUSES an unstamped day, so the zero here cannot be a
    ///         missing-stamp artifact on the quoted path). The ONE Δq
    ///         implementation: the quote accumulator, the pricing ladder
    ///         and the payment path all read it, so the quoted figure and
    ///         the priced figure can never diverge.
    function compQuoteDelta(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardSide side,
        uint256 d
    ) internal view returns (uint256) {
        LibVaipakam.DayPoolStamp storage p = s.dayPoolStamp[d];
        if (!p.stamped) return 0;
        uint256 halfPool = uint256(p.scheduleFloor) / 2;
        (uint256 g, uint256 l) = side == LibVaipakam.RewardSide.Lender
            ? (
                s.knownGlobalLenderInterestNumeraire18[d],
                s.totalLenderInterestNumeraire18[d]
            )
            : (
                s.knownGlobalBorrowerInterestNumeraire18[d],
                s.totalBorrowerInterestNumeraire18[d]
            );
        uint256 denom = g + l;
        if (denom == 0 || halfPool == 0) return 0;
        return (halfPool * 1e18) / denom;
    }

    /**
     * @dev #1434 P2-w3 — the per-day P2 STATE LADDER + delta derivation
     *      (§2.1 precedence, §1.5 pricing): the ONE implementation every
     *      per-day-delta site consumes — both cumulative folds, the
     *      commitment twin, and the payment path — so the ladder can never
     *      diverge between pricing, reporting and paying.
     *
     *      The ladder governs only DELIBERATELY-ZEROED days (the marker
     *      exists only on armed mirror days), and its states BYPASS the
     *      blanket armed-mirror halt in {_dayPoolHalves} deliberately:
     *      they are the per-day replacements §2.1 defines, and each is
     *      individually safe against the halt's two standing
     *      prerequisites. Prerequisite 1 (no delivered-funding bound on
     *      mirror fresh) is satisfied by the FUNDING GATE below: the
     *      compensated arm crosses only once the side's delivered pool
     *      covers the side's own quoted sum, keyed on the AMOUNT present
     *      (the standing constraint in {_dayPoolHalves}'s natspec), never
     *      on a message arrival. Prerequisite 2 (zero-retirement of
     *      compensable entries) is exactly what the defer arm prevents,
     *      while the w4 lapse terminal is the deliberate reopening.
     *      Unflagged armed mirror days kept the blanket halt until
     *      #1434 P1-b, which lifted it: they now price from the same
     *      stamp as any other armed day, bounded by
     *      `PoolBudget.deliveredFresh` and DEFERRING (never truncating)
     *      when that bound is short. This ladder is unaffected — it still
     *      governs deliberately-zeroed days only, and its funding gate
     *      remains keyed on the AMOUNT present, the same standing
     *      constraint P1-b's bound satisfies.
     *
     *      Crossing is LOAD-BEARING for both payment paths at once: the
     *      cum fold writes this day's row, and `_rpnReady` (walk) plus the
     *      cursor gate in {_entryPriceCore} (bulk window pricing of
     *      spanning entries) both key on the cursor having crossed. So the
     *      gate here is THE delivered-value bound for the day — by the
     *      time any entry can price a compensated day, its side pool
     *      covers that side's entire quoted liability, and no per-day
     *      debit is needed downstream. The pools in {DayCompensation} are
     *      therefore a funding RECORD, not a draining remainder.
     *
     *      States (precedence order):
     *        - lapsed            → (0, 0) no halt: the day retires at zero
     *                              through the ordinary machinery — the
     *                              loss was recorded at the lapse (w4).
     *        - shortLapsed       → (Δq × pool/quoted, 0) no halt,
     *                              `compensated = true`: the §2.5 bounded
     *                              terminal for a funded-below-quote day —
     *                              POOL-SCALED pricing so every settlement
     *                              path stays within delivered funding
     *                              with no per-payment truncation (see the
     *                              arm's own comment; ordered before the
     *                              compensated arm, whose funding gate
     *                              would otherwise defer the day forever).
     *        - compensated       → funded ⇒ (Δq, 0) no halt,
     *                              `compensated = true`: §1.5's
     *                              local-denominator pricing, funded by
     *                              the delivered pool. Underfunded ⇒
     *                              DEFER until the w4 supplemental remit
     *                              tops the pool to quote or
     *                              {lapseShortCompensatedDay}'s bounded
     *                              deadline fires — the gate mis-prices
     *                              nothing in the interim. A crossed day
     *                              can never un-fund (`_creditCompensation`
     *                              only adds, and a confirmed credit no
     *                              longer demotes). A PROVISIONAL credit
     *                              does not price — the day defers until
     *                              its V3 broadcast settles which era
     *                              governs.
     *        - resolvedZero      → (0, 0) no halt: the genuinely-zero day
     *                              prices zero — no entry accrued.
     *        - zeroed-and-open   → DEFER (halt): compensation is still
     *                              possible; the cursor waits before the
     *                              day (the anti-zero-retirement gate).
     *
     *      A compensated day's Δq deliberately flows into ALL FOUR
     *      cumulative series exactly like an ordinary armed day's delta —
     *      including `cumMinArmed*`. Its only consumer is
     *      {_entryWindowSplitFrom}'s decomposition, where excluding Δq
     *      would misclassify the value as pre-`D*` legacy fresh: paid
     *      outside the loan-side `C*` cap and without `consumeArmedFresh`
     *      retirement, while `_creditCompensation` already counted the
     *      delivered value into `rewardBudgetArmedFreshReceived` —
     *      consumption must mirror that counting.
     */
    function _p2DayDeltas(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardSide side,
        uint256 d
    )
        private
        view
        returns (
            bool governed,
            uint256 freshDaily,
            uint256 recycledDaily,
            bool halt,
            bool compensated
        )
    {
        if (!s.dayDeliberatelyZeroed[d]) {
            return (false, 0, 0, false, false);
        }
        if (s.dayLapsed[d]) return (true, 0, 0, false, false);
        LibVaipakam.DayCompensation storage dc = s.dayCompensation[d];
        // #1434 P2-w4 (§2.5) — the SHORT-COMPENSATED terminal: a funded-
        // below-quote day whose bounded deadline passed. Prices at the
        // POOL-SCALED delta `Δq × pool_s / quoted_s` per side — §2.5's
        // "truncate-at-remaining" landed as pro-rata scaling AT THE
        // CROSSING (the w3 lesson verbatim: bulk window pricing has no
        // payment-path budget, so the bound must live in the fold; scaling
        // is order-independent, and Σ floored payments ≤ pool_s by
        // construction). Both factors are frozen once the terminal is set
        // (post-terminal supplements quarantine — §2.2's lapsed branch),
        // so the recomputation is deterministic. Ordered BEFORE the
        // compensated arm: a short-lapsed day IS compensated, and the
        // funding gate below would defer it forever — the terminal is the
        // deliberate exit from that deferral. The quote-dispatch evidence
        // holds by construction (compensated ⇒ quoted, r5), and a zero
        // quoted side scales to zero.
        if (s.dayShortLapsed[d]) {
            uint256 dq = compQuoteDelta(s, side, d);
            uint8 sideKey = uint8(side);
            uint256 quoted = s.compQuoteAccum18[d][sideKey];
            if (dq == 0 || quoted == 0) return (true, 0, 0, false, true);
            uint256 pool = side == LibVaipakam.RewardSide.Lender
                ? uint256(s.dayCompensation[d].lenderPool18)
                : uint256(s.dayCompensation[d].borrowerPool18);
            if (pool >= quoted) {
                // Fully funded by the terminal's own precondition failing
                // only later credits (impossible — quarantined) — price
                // the plain Δq; kept as a closed-form fallback rather
                // than an assumed-unreachable revert. Rounding-safe
                // without a shave: each entry's window-floored marginal
                // is ≤ its ceiled quote share, so Σ marginals ≤ quoted
                // ≤ pool.
                return (true, dq, 0, false, true);
            }
            // #1656 r11 — shave the covering-entry count off the pool
            // before scaling: `_entryWindowSplitFrom` floors once over
            // each entry's WHOLE window, so the lapsed day's marginal
            // can round UP by ≤1 wei per covering entry (difference of
            // floors), and plain `Δq × pool / quoted` preserves those
            // rounded-up marginals — aggregate settlement could exceed
            // the delivered pool and consume unrelated fresh custody.
            // With Δq' = ⌊Δq × (pool − n) / quoted⌋:
            //   Σ marginals ≤ Σ share·Δq'/Δq + n ≤ (pool − n) + n = pool.
            // The count is maintained from the accumulator's genesis
            // (no deployment ever ran w3 without it), so count == 0 ⟺
            // quoted == 0 and the subtraction is never against an
            // unwalked accumulation. A pool at or under n wei prices
            // zero — the dust joins the delivered-minus-paid residue.
            uint256 nCnt = s.compQuoteEntryCount[d][sideKey];
            if (pool <= nCnt) return (true, 0, 0, false, true);
            return (
                true, Math.mulDiv(dq, pool - nCnt, quoted), 0, false, true
            );
        }
        if (dc.compensated && !dc.provisional) {
            // #1636 r5 — the quoted sums are trustworthy ONLY once the
            // quote DISPATCHED: dispatch is where the conservation proof
            // runs, so an undispatched `compQuoteAccum18` is either a
            // partial sum (mid-accumulation — comparing against it would
            // open the gate below the real liability) or zero (a pre-w3
            // compensated day, where a zero quote would declare ANY w2
            // operator-sized remit "fully funded" and let settlement
            // consume unrelated custody). Defer until the day's quote
            // evidence is complete — permissionlessly healable on a
            // pre-w3 day by running the accumulator + dispatch (the
            // wire's Base-side fate is irrelevant to mirror pricing).
            if (s.compQuoteSentAt[d] == 0) return (true, 0, 0, true, false);
            // The funding gate: this side's delivered pool must cover this
            // side's own quoted sum (the accumulator's capped Σ rawPay,
            // complete by the dispatch-time conservation proof). Base's
            // remit is quote-bounded above, so an exact-quote remit crosses
            // exactly; a partial remit defers (w4's supplemental remit or
            // short-lapse terminal resolves it — no supplement path exists
            // before then, the manual remit being once-per-day).
            (uint256 sidePool, uint256 sideQuoted) =
                side == LibVaipakam.RewardSide.Lender
                    ? (
                        uint256(dc.lenderPool18),
                        s.compQuoteAccum18[d][
                            uint8(LibVaipakam.RewardSide.Lender)
                        ]
                    )
                    : (
                        uint256(dc.borrowerPool18),
                        s.compQuoteAccum18[d][
                            uint8(LibVaipakam.RewardSide.Borrower)
                        ]
                    );
            if (sidePool < sideQuoted) return (true, 0, 0, true, false);
            return (true, compQuoteDelta(s, side, d), 0, false, true);
        }
        if (s.dayResolvedZero[d]) return (true, 0, 0, false, false);
        return (true, 0, 0, true, false);
    }

    /// @dev The per-day DAILY DELTAS, P2-ladder-aware — the shared
    ///      derivation behind the folds, the commitment twin and the
    ///      payment path. Ordinary days derive from {_dayPoolHalves} over
    ///      the frozen global exactly as before; ladder-governed days
    ///      return their state's deltas directly (Δq never goes through
    ///      the halves/global shape: G_s is zero in exactly the
    ///      constraint-17 case).
    function _dayDeltas(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardSide side,
        uint256 d
    )
        private
        view
        returns (
            uint256 freshDaily,
            uint256 recycledDaily,
            bool halt,
            bool compensated
        )
    {
        {
            (bool governed, uint256 fD, uint256 rD, bool h, bool comp) =
                _p2DayDeltas(s, side, d);
            if (governed) return (fD, rD, h, comp);
        }
        (uint256 freshHalf, uint256 recycledHalf, bool h2) =
            _dayPoolHalves(s, side, d);
        if (h2) return (0, 0, true, false);
        uint256 globalTotal = side == LibVaipakam.RewardSide.Lender
            ? s.knownGlobalLenderInterestNumeraire18[d]
            : s.knownGlobalBorrowerInterestNumeraire18[d];
        if (globalTotal == 0) return (0, 0, false, false);
        if (freshHalf != 0) {
            freshDaily = (freshHalf * 1e18) / globalTotal;
        }
        if (recycledHalf != 0) {
            recycledDaily = (recycledHalf * 1e18) / globalTotal;
        }
    }

    /// @notice #1222 M3 B2-d1 — the day-`d` per-side RPN delta Δ_d computed
    ///         HALT-INDEPENDENTLY from this chain's OWN funding stamp, for the
    ///         mirror→Base commitment REPORT.
    /// @dev    The report is a READ-ONLY liability estimate. It was written
    ///         while mirror armed-day CLAIM pricing was blanket-halted (the
    ///         `isMirrorRewardChain` arm in {_dayPoolHalves}, which B2-d4
    ///         attempted to remove and did not; #1434 P1-b has since removed
    ///         it behind a delivered-fresh bound). It STILL reads the stamp
    ///         DIRECTLY and never touches the cumulative cursor, and that is
    ///         still load-bearing rather than vestigial — though NOT for the
    ///         reason an earlier revision of this note gave (Codex #1699 r4).
    ///         That revision claimed the cursor advances only as far as
    ///         delivered funding allows; it does not. Neither
    ///         {advanceCumLenderThrough} nor {_dayPoolHalves} reads the
    ///         delivered bound — the bound is applied later, at PAYMENT, by
    ///         {processUserSideDay}. The real distinction is STAMP-READINESS:
    ///         the cursor lags any finalized day the user has not yet had
    ///         processed, so a report derived from it would understate the
    ///         liability simply because nobody has claimed recently — while
    ///         the whole purpose of the report is to state what this chain
    ///         owes regardless of claim activity. The per-day math MIRRORS
    ///         {advanceCumLenderThrough} exactly — stamp halves → per-side
    ///         daily (floored) → summed — so the commitment's `rawPay`
    ///         (`perDayNumeraire18 × Δ_d / 1e18`) equals what the claim path
    ///         will pay if and when the halt is lifted. Keep the two in lockstep:
    ///         any change to {_dayPoolHalves}'s halves or to
    ///         {advanceCumLenderThrough}'s per-day math must land here too.
    ///         `priceable == false` ⇒ the day is unarmed or this chain's stamp
    ///         has not arrived yet (broadcast pending) — the report must wait.
    function dailyDeltaForCommitment(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardSide side,
        uint256 d
    ) internal view returns (uint256 delta, bool priceable) {
        if (!_isArmedDay(s, d)) return (0, false);
        // #1434 P2-w3 lockstep — a ladder-governed (deliberately-zeroed)
        // day reports its RESOLVED state's delta, matching what the claim
        // path will pay: lapsed / resolved-zero report 0, a funded
        // compensated day reports Δq, and an unresolved day is NOT
        // priceable (a 0 report for a day later compensated at Δq would
        // under-commit — the report must wait like the cursor does).
        {
            (bool governed, uint256 fD, uint256 rD, bool halted, ) =
                _p2DayDeltas(s, side, d);
            if (governed) return halted ? (0, false) : (fD + rD, true);
        }
        LibVaipakam.ChainDayFunding storage f =
            s.chainDayRecycledFunding[d][uint32(block.chainid)];
        if (!f.stamped) return (0, false);
        uint256 global = side == LibVaipakam.RewardSide.Lender
            ? s.knownGlobalLenderInterestNumeraire18[d]
            : s.knownGlobalBorrowerInterestNumeraire18[d];
        // Priceable but a zero global-interest day yields a zero pool ⇒ Δ_d = 0
        // (the same zero-denominator convention advanceCum uses).
        if (global == 0) return (0, true);
        (uint256 freshHalf, uint256 recycledHalf) =
            side == LibVaipakam.RewardSide.Lender
                ? (f.freshLenderHalf, f.lenderHalfEquiv)
                : (f.freshBorrowerHalf, f.borrowerHalfEquiv);
        uint256 freshDaily = freshHalf == 0 ? 0 : (freshHalf * 1e18) / global;
        uint256 recycledDaily =
            recycledHalf == 0 ? 0 : (recycledHalf * 1e18) / global;
        return (freshDaily + recycledDaily, true);
    }

    function advanceCumLenderThrough(uint256 through)
        internal
        returns (uint256 reached)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 cursor = s.cumLenderCursor;
        if (through <= cursor) return cursor;
        uint256 cap = cursor + MAX_CUM_ADVANCE_DAYS;
        if (through > cap) through = cap;

        uint256 prev = cursor == 0 ? 0 : s.cumLenderRpn18[cursor];
        // #1008 (S13) — the capped cumulative rides the SAME cursor.
        uint256 prevMin = cursor == 0 ? 0 : s.cumMinLenderRpn18[cursor];
        // PR-3c — the capped RECYCLED component rides it too (fresh is
        // derived by subtraction, never stored).
        uint256 prevMinRec =
            cursor == 0 ? 0 : s.cumMinRecycledLenderRpn18[cursor];
        uint256 prevMinArmed =
            cursor == 0 ? 0 : s.cumMinArmedLenderRpn18[cursor];
        for (uint256 d = cursor + 1; d <= through; ) {
            if (!s.knownGlobalSet[d]) break;
            // #1434 P2-w3 — the per-day deltas come from the shared
            // {_dayDeltas} ladder: ordinary days derive from the halves +
            // frozen global exactly as before; ladder-governed
            // (deliberately-zeroed) days price their resolved state
            // directly, and an unresolved one halts here — which parks the
            // cursor BEFORE the day, keeping `_rpnReady` and the
            // {_entryPriceCore} cursor gate closed over it (the
            // anti-zero-retirement gate).
            (uint256 freshDaily, uint256 recycledDaily, bool halt, ) =
                _dayDeltas(s, LibVaipakam.RewardSide.Lender, d);
            if (halt) break;
            uint256 daily = freshDaily + recycledDaily; // Δ_d in RPN units
            uint256 next = prev + daily;
            s.cumLenderRpn18[d] = next;
            // #1008 (S13) — capped cumulative: Σ min(Δ_d, T_d) using the
            // finalize-snapshotted threshold (broadcast-canonical). t == max
            // (cap disabled that day) ⇒ min == daily ⇒ cumMin tracks cumRpn.
            // PR-3c (governor §3.1 / Codex r7): the cap applies to the
            // COMBINED Δ first; the trim is then apportioned pro-rata
            // across the two sources so capping never changes the total.
            uint256 t = s.dayCapThreshold18[d];
            uint256 capped = daily < t ? daily : t;
            // No-trim fast path + 512-bit pro-rata (Codex #1315 P2).
            uint256 cappedRecycled = daily <= t
                ? recycledDaily
                : Math.mulDiv(capped, recycledDaily, daily);
            uint256 nextMin = prevMin + capped;
            s.cumMinLenderRpn18[d] = nextMin;
            uint256 nextMinRec = prevMinRec + cappedRecycled;
            s.cumMinRecycledLenderRpn18[d] = nextMinRec;
            // Armed-day combined cumulative (consumption accounting): a
            // pre-arming day contributes 0 here.
            prevMinArmed += _isArmedDay(s, d) ? capped : 0;
            s.cumMinArmedLenderRpn18[d] = prevMinArmed;
            prev = next;
            prevMin = nextMin;
            prevMinRec = nextMinRec;
            cursor = d;
            unchecked { ++d; }
        }
        s.cumLenderCursor = cursor;
        return cursor;
    }

    /// @notice Mirror of {advanceCumLenderThrough} for the borrower side.
    function advanceCumBorrowerThrough(uint256 through)
        internal
        returns (uint256 reached)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 cursor = s.cumBorrowerCursor;
        if (through <= cursor) return cursor;
        uint256 cap = cursor + MAX_CUM_ADVANCE_DAYS;
        if (through > cap) through = cap;

        uint256 prev = cursor == 0 ? 0 : s.cumBorrowerRpn18[cursor];
        uint256 prevMin = cursor == 0 ? 0 : s.cumMinBorrowerRpn18[cursor];
        uint256 prevMinRec =
            cursor == 0 ? 0 : s.cumMinRecycledBorrowerRpn18[cursor];
        uint256 prevMinArmed =
            cursor == 0 ? 0 : s.cumMinArmedBorrowerRpn18[cursor];
        for (uint256 d = cursor + 1; d <= through; ) {
            if (!s.knownGlobalSet[d]) break;
            // #1434 P2-w3 — shared {_dayDeltas} ladder; see the lender fold.
            (uint256 freshDaily, uint256 recycledDaily, bool halt, ) =
                _dayDeltas(s, LibVaipakam.RewardSide.Borrower, d);
            if (halt) break;
            uint256 daily = freshDaily + recycledDaily;
            uint256 next = prev + daily;
            s.cumBorrowerRpn18[d] = next;
            uint256 t = s.dayCapThreshold18[d];
            uint256 capped = daily < t ? daily : t;
            uint256 cappedRecycled = daily <= t
                ? recycledDaily
                : Math.mulDiv(capped, recycledDaily, daily);
            uint256 nextMin = prevMin + capped;
            s.cumMinBorrowerRpn18[d] = nextMin;
            uint256 nextMinRec = prevMinRec + cappedRecycled;
            s.cumMinRecycledBorrowerRpn18[d] = nextMinRec;
            prevMinArmed += _isArmedDay(s, d) ? capped : 0;
            s.cumMinArmedBorrowerRpn18[d] = prevMinArmed;
            prev = next;
            prevMin = nextMin;
            prevMinRec = nextMinRec;
            cursor = d;
            unchecked { ++d; }
        }
        s.cumBorrowerCursor = cursor;
        return cursor;
    }

    // ─── Claim / preview (entry path + legacy window path) ──────────────────

    /**
     * @notice Walk `user`'s reward entries and route each CLOSED entry
     *         whose endDay is finalized in the cumRPN cursor. Processed
     *         entries are flagged so follow-up claims don't re-credit.
     *         Forfeited entries accumulate in `treasuryTotal` (payout is
     *         made separately by the facet wrapping this helper).
     *
     * @param user User being claimed for.
     * @return toUser     Aggregated decomposition of what accrues to `user`
     *                    (PR-3c {EntrySplit}: total / recycled / armedFresh).
     * @return toTreasury Aggregated decomposition of the forfeits (the facet
     *                    routes the fresh share to the recycle bucket and
     *                    releases the recycled share's commitment).
     */
    /// @return toUser     Aggregate reward routed to the claimant.
    /// @return toTreasury Aggregate reward routed to the treasury channel.
    /// @return advancedAnyDay True ⇒ the ShareOfPool walk advanced at least one
    ///         day. Codex #1404 P2: a walk can legitimately advance ZERO-PAY
    ///         days (a `C == 0` dust day, or a ceiling already consumed by an
    ///         earlier entry). That is real, persisted progress, so the facet's
    ///         "nothing to claim" revert must not roll it back — otherwise the
    ///         claimant retries the same zero-pay day forever and can never
    ///         reach the payable days behind it.
    /// @param freshBudget The fresh headroom this claim may still spend, net of
    ///        every leg that has ALREADY committed in this tx (today: the legacy
    ///        window leg). REQUIRED rather than derived internally — a leg that
    ///        priced itself against the raw `poolRemaining()` while a sibling
    ///        leg had already spoken for part of it is how the same bug
    ///        surfaced twice in the #1404 review.
    function claimForUserEntries(address user, uint256 freshBudget)
        internal
        returns (
            EntrySplit memory toUser,
            EntrySplit memory toTreasury,
            bool advancedAnyDay
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage ids = s.userRewardEntryIds[user];
        uint256 len = ids.length;

        // #1008 (S13) — the §4 cap is baked into `cumMin*Rpn18` at finalization,
        // so the claim no longer reads the ETH feed / cap ratio here.
        for (uint256 i = 0; i < len; ) {
            (EntrySplit memory u, EntrySplit memory t) =
                _processEntry(s, ids[i]);
            toUser.total += u.total;
            toUser.recycled += u.recycled;
            toUser.armedFresh += u.armedFresh;
            toTreasury.total += t.total;
            toTreasury.recycled += t.recycled;
            toTreasury.armedFresh += t.armedFresh;
            unchecked { ++i; }
        }

        // #1351 (re-land of 2c on the 2d-0 core) — the loop above paid every
        // entry's pre-`D*` slice O(1); the armed days are priced per-day
        // against the D1 ceiling here.
        //
        // Codex #1404 P2 — the walk's FRESH budget is net of the legacy fresh
        // this claim has ALREADY committed above. Both draw on the same 69M
        // pool, and the facet scales the aggregate down if it overruns; without
        // this the walk would price days against a budget the legacy leg has
        // already spoken for, then persist cursors and D1 charges for value the
        // scaler never actually transfers — retiring the commitment while
        // dropping the payout.
        uint256 legacyFresh =
            (toUser.total - toUser.recycled) +
            (toTreasury.total - toTreasury.recycled);
        (EntrySplit memory wu, EntrySplit memory wt, bool walked) =
            _walkShareOfPoolDays(s, user, freshBudget, legacyFresh);
        _foldSplit(toUser, wu);
        _foldSplit(toTreasury, wt);
        advancedAnyDay = walked;
    }

    /// @dev #1351 (M2 PR-2) — the ShareOfPool day walk.
    ///
    ///      Owns the ARMED (post-`D*`) portion of every entry; the pre-`D*`
    ///      portion was already paid O(1) by {_processEntry}. Chunked at
    ///      `MAX_INTERACTION_CLAIM_DAYS` — a long window simply needs another
    ///      `claimInteractionRewards` call, exactly as the cum-cursor catch-up
    ///      already does.
    ///
    ///      Every day that is priced is PAID and PERSISTED in this same tx
    ///      (cursor, `userSideDayPaidVpfi`, `loanSideRewardPaidVpfi`,
    ///      `loanSideRewardedDays`). Accumulating in memory across txs and
    ///      paying once at the end is explicitly forbidden by §F8 — it
    ///      double-pays.
    function _walkShareOfPoolDays(
        LibVaipakam.Storage storage s,
        address user,
        uint256 freshBudget,
        uint256 legacyFreshReserved
    )
        private
        returns (
            EntrySplit memory toUser,
            EntrySplit memory toTreasury,
            bool advancedAnyDay
        )
    {
        if (s.governorCommitArmedFromDay == 0) {
            return (toUser, toTreasury, false);
        }
        // The walk spends what is left of the caller-supplied budget after
        // this claim's OWN entry-path legacy slice. It never re-reads
        // `poolRemaining()` — that is precisely the read that let two legs
        // believe they each owned the same headroom.
        uint256 freshLeft = freshBudget > legacyFreshReserved
            ? freshBudget - legacyFreshReserved
            : 0;
        WalkCtx memory ctx = WalkCtx({
            pool: PoolBudget({
                fresh: freshLeft,
                recycled: s.recycleBucket,
                deliveredFresh: deliveredFreshBound(s)
            }),
            advanced: false,
            daysLeft: LibVaipakam.MAX_INTERACTION_CLAIM_DAYS
        });

        for (uint8 sideIdx; sideIdx < 2; ) {
            LibVaipakam.RewardSide side = sideIdx == 0
                ? LibVaipakam.RewardSide.Lender
                : LibVaipakam.RewardSide.Borrower;
            uint256[] memory work =
                _shareOfPoolWorklist(s, user, side, false);
            if (work.length != 0) {
                _walkSideDays(s, user, side, work, ctx, toUser, toTreasury);
            }
            unchecked { ++sideIdx; }
        }
        advancedAnyDay = ctx.advanced;
    }

    /// @dev Entries of `user` on `side` that still owe ShareOfPool days.
    ///
    ///      Eligibility is a PURE FUNCTION of `rewardEntryClaimNextDay`, the
    ///      entry's own window, and `D*` — deliberately no second marker
    ///      (#1351 2d-0 Deliverable 2; the parked 2c's `rewardEntryLegacySettled`
    ///      marker is exactly what made its round-6 livelock representable).
    ///      The walk must never run ahead of the legacy settlement: an entry
    ///      whose `_processEntry` bailed at the cum-cursor gate has an unpaid
    ///      pre-`D*` slice, and walking it would advance its cursor past that
    ///      slice permanently. The cursor's FIRST write happens only when the
    ///      legacy slice settles (or the walk starts on an entry with no legacy
    ///      slice at all), so `cursor != 0 || startDay >= D*` is exactly
    ///      "the pre-`D*` slice is settled or empty" — the two facts cannot
    ///      disagree because they are one fact.
    /// @param includeSettleableLegacy DryRun only (#1351 slice 2e). The
    ///        settling claim runs its entry loop FIRST, so by the time it
    ///        builds this worklist every spanning entry whose legacy slice
    ///        could settle has its cursor stamped and is admitted by the
    ///        cursor rule. A view preview cannot run that loop, so it admits
    ///        the same population by predicate instead: an unsettled spanning
    ///        entry whose side cumulative already covers `endDay - 1` is one
    ///        the claim WOULD settle-and-stamp this tx. Settling callers pass
    ///        false — for them the predicate would admit an entry whose
    ///        legacy slice has NOT yet been paid, exactly the stranding the
    ///        cursor rule exists to prevent.
    function _shareOfPoolWorklist(
        LibVaipakam.Storage storage s,
        address user,
        LibVaipakam.RewardSide side,
        bool includeSettleableLegacy
    ) private view returns (uint256[] memory work) {
        uint256 armedFrom = s.governorCommitArmedFromDay;
        uint256 cum = side == LibVaipakam.RewardSide.Lender
            ? s.cumLenderCursor
            : s.cumBorrowerCursor;
        uint256[] storage ids = s.userRewardEntryIds[user];
        uint256 len = ids.length;
        uint256[] memory buf = new uint256[](len);
        uint256 n;
        for (uint256 i; i < len; ) {
            uint256 id = ids[i];
            LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
            if (
                !e.processed &&
                // #1434 (Codex #1699 r8 P1) — the sweep owns it past the
                // removal point; the walk must not pay its remaining days.
                !e.expiryBegun &&
                e.side == side &&
                (
                    s.rewardEntryClaimNextDay[id] != 0 ||
                    e.startDay >= armedFrom ||
                    (
                        includeSettleableLegacy &&
                        e.endDay != 0 &&
                        cum >= e.endDay - 1 &&
                        // Codex #1410 r1 P2 — mirror the claim's empty-window
                        // retire: a spanning entry whose whole remaining
                        // window prices to zero is marked processed by
                        // {_processEntry} WITHOUT entering the walk, so the
                        // preview must not spend simulated day allowance on
                        // it (that would crowd out later entries and
                        // under-report).
                        _entryPricesNonEmpty(s, id, e)
                    )
                ) &&
                _entryClaimable(s, e) &&
                _shareOfPoolCursorDay(s, id, e) < e.endDay
            ) {
                buf[n] = id;
                unchecked { ++n; }
            }
            unchecked { ++i; }
        }
        work = new uint256[](n);
        for (uint256 i; i < n; ) {
            work[i] = buf[i];
            unchecked { ++i; }
        }
    }

    /// @dev Walk one side's days, oldest first, up to the chunk budget.
    function _walkSideDays(
        LibVaipakam.Storage storage s,
        address user,
        LibVaipakam.RewardSide side,
        uint256[] memory work,
        WalkCtx memory ctx,
        EntrySplit memory toUser,
        EntrySplit memory toTreasury
    ) private {
        while (ctx.daysLeft != 0) {
            uint256 d = _lowestPendingDay(s, work);
            if (d == type(uint256).max) break;
            uint256[] memory set = _entriesAtDay(s, work, d);
            if (set.length == 0) break;

            (DayCharge memory charge, DaySlice[] memory slices) =
                processUserSideDay(user, d, set, ctx.pool, _noDryRun());
            // Not advanced ⇒ a recycled-bucket shortfall, an unready RPN row,
            // or (#1434 P1-b) a MIRROR's DELIVERED-fresh shortfall — all
            // legitimately transient (#1351 2d-0: the bucket refills; the row
            // finalizes; the next remittance lands). Nothing was charged, so
            // STOP rather than spin: the day stays retryable.
            //
            // P1-b corrects what stood here. It read "A FRESH shortfall never
            // lands here — the day primitive settles it terminally
            // (truncate-and-consume) and still advances", which is true of a
            // CAP-bound shortfall on any chain and was true of every fresh
            // shortfall while the mirror halt stood. It is no longer true of a
            // mirror's delivered bound, whose budget GROWS with each
            // remittance, so truncating there would permanently underpay a day
            // whose funding was merely in flight. A cap-bound trim still
            // settles terminally and still advances.
            if (!charge.advanced) break;

            _persistDay(s, user, side, d, set, slices);
            uint256 freshSpent =
                charge.toUser.armedFresh + charge.toTreasury.armedFresh;
            ctx.pool.fresh -= freshSpent;
            // #1434 P1-b — charge the delivered-fresh bound with EXACTLY what
            // the pool just spent, on ARMED days only.
            //
            // The `_isArmedDay` filter is REDUNDANT here, and a mutation run
            // is what settled it — the opposite of what an earlier revision of
            // this comment asserted. This walk cannot be handed an unarmed
            // day at all, by two independent constructions:
            //
            //   • {_walkShareOfPoolDays} returns immediately when
            //     `governorCommitArmedFromDay == 0`, so with no arming set
            //     there is no walk to filter; and
            //   • when it IS set, {_shareOfPoolCursorDay} floors every entry's
            //     cursor at `armedFrom`, so a day BELOW it is never selected
            //     by {_lowestPendingDay} and never reaches
            //     {processUserSideDay}.
            //
            // Deleting the filter therefore changes neither behaviour nor gas
            // (measured: byte-identical gas). It is an equivalent mutant; no
            // test can kill it and none should be written claiming to.
            //
            // KEPT as defence-in-depth. Broadcast ingress genuinely can stamp
            // ShareOfPool `capMode` on a day this chain's arming does not
            // cover — that part of the concern is real — but the CURSOR, not
            // this filter, is what keeps such a day out of the walk. Should
            // that floor ever be relaxed, this line becomes load-bearing
            // exactly as written.
            //
            // This quantity, and not `consumeArmedFresh`'s argument, is the
            // paid side. That function retires COMMITMENTS: its amount
            // deliberately includes `cappedOff.armedFresh`, which moves no
            // tokens at all, and on Base it is also called when a remittance
            // is SENT. Charging either against delivered fresh would repeat
            // the mistake `interactionPoolPaidOut` was rejected for —
            // counting value the chain never paid out of a delivery, and so
            // deferring later days that are in fact fully funded.
            //
            // Both legs are counted because both genuinely spend fresh: the
            // user leg pays out, and the forfeit leg's fresh share is real
            // absorption that credits the recycle bucket. That is the same
            // pairing the pool decrement above uses, which is the point —
            // the bound tracks the spend, so the two can never drift.
            // Codex #1699 r3 P2 — MIRROR-scoped, matching the forfeit and
            // expiry writers.
            //
            // This write was unconditional while the other two guarded on
            // `isMirrorRewardChain`. Three writers of one counter, and I had
            // checked each against its own intent rather than against each
            // other. The consequence is a real one: a CANONICAL Diamond pays
            // armed days from the 69M cap with no delivered receipts behind
            // them, so if it is later demoted those payouts sit in a
            // mirror-only ledger and `deliveredFreshBound` floors at zero
            // until fresh deliveries exceed the entire canonical history —
            // the chain cannot pay anything in the meantime.
            //
            // Scoping to mirrors is the rebaseline: the counter means "armed
            // fresh this chain paid out of DELIVERED funding", and a canonical
            // chain has none by construction. A demotion therefore starts the
            // paid side from whatever mirror-era spending exists (zero, or the
            // operator's `seedArmedFreshPaid` figure), which is the only
            // reading under which received and paid describe the same era.
            if (
                freshSpent != 0
                    && _isArmedDay(s, d)
                    && LibVaipakam.isMirrorRewardChain(s)
            ) {
                s.rewardBudgetArmedFreshPaid += freshSpent;
                // Codex #1699 r1 P1 — deplete the IN-MEMORY bound too, not
                // just the storage counter.
                //
                // `deliveredFreshBound` is read ONCE when the walk builds its
                // `PoolBudget`, so without this every day in the same claim
                // sees the original allowance. Two 0.4 days against 0.5
                // delivered would each pass their own check and transfer 0.8
                // before storage ever caught up — drawing the excess from
                // custody held for other obligations.
                //
                // This is the SAME defect the note above `_walkShareOfPoolDays`
                // records for the 69M pool ("a leg that priced itself against
                // the raw `poolRemaining()` while a sibling leg had already
                // spoken for part of it"). `ctx.pool.fresh` is threaded for
                // exactly that reason; the delivered bound now is too.
                // Saturating because the two are decremented independently and
                // a rounding wei must never underflow the walk.
                uint256 db = ctx.pool.deliveredFresh;
                ctx.pool.deliveredFresh =
                    db > freshSpent ? db - freshSpent : 0;
            }
            ctx.pool.recycled -= charge.toUser.recycled;
            _foldSplit(toUser, charge.toUser);
            _foldSplit(toTreasury, charge.toTreasury);
            // `cappedOff` moves no tokens but MUST reach the facet so the
            // commitments retire. Fold it EXACTLY as the loan-side cap shapes
            // its own two legs, because the facet's arithmetic depends on that
            // shape:
            //   • fresh  -> `toUser.armedFresh` ONLY, never `total`. That
            //     mirrors the user split keeping `armedFresh` whole while
            //     `total` sheds the capped-off fresh, and it is what feeds
            //     `consumeArmedFresh` the full commitment (pool-terminal
            //     trims ride here too — same caller treatment).
            //   • recycled -> BOTH `toTreasury.total` and `.recycled`, mirroring
            //     `recycleRelease` where the two are equal. Folding it into
            //     `.recycled` alone underflows the facet's
            //     `freshTreasury = treasuryDelta - forfeitRecycled`.
            toUser.armedFresh += charge.cappedOff.armedFresh;
            toTreasury.total += charge.cappedOff.recycled;
            toTreasury.recycled += charge.cappedOff.recycled;

            ctx.advanced = true;
            unchecked { --ctx.daysLeft; }
        }
    }

    /// @dev Lowest day any live entry in `work` still owes; `max` when none do.
    function _lowestPendingDay(
        LibVaipakam.Storage storage s,
        uint256[] memory work
    ) private view returns (uint256 lowest) {
        lowest = type(uint256).max;
        for (uint256 i; i < work.length; ) {
            LibVaipakam.RewardEntry storage e = s.rewardEntries[work[i]];
            if (!e.processed) {
                uint256 nd = _shareOfPoolCursorDay(s, work[i], e);
                if (nd < e.endDay && nd < lowest) lowest = nd;
            }
            unchecked { ++i; }
        }
    }

    /// @dev The entries sitting exactly on day `d` — the joint transfer set.
    function _entriesAtDay(
        LibVaipakam.Storage storage s,
        uint256[] memory work,
        uint256 d
    ) private view returns (uint256[] memory set) {
        uint256[] memory buf = new uint256[](work.length);
        uint256 n;
        for (uint256 i; i < work.length; ) {
            LibVaipakam.RewardEntry storage e = s.rewardEntries[work[i]];
            if (!e.processed && _shareOfPoolCursorDay(s, work[i], e) == d) {
                buf[n] = work[i];
                unchecked { ++n; }
            }
            unchecked { ++i; }
        }
        set = new uint256[](n);
        for (uint256 i; i < n; ) {
            set[i] = buf[i];
            unchecked { ++i; }
        }
    }

    /// @dev Persist everything {processUserSideDay} priced but could not write
    ///      (it is a `view`). Skipping any of these hands the user an unbounded
    ///      daily budget — see that function's caller contract.
    function _persistDay(
        LibVaipakam.Storage storage s,
        address user,
        LibVaipakam.RewardSide side,
        uint256 d,
        uint256[] memory set,
        DaySlice[] memory slices
    ) private {
        uint8 sideKey = uint8(side);
        uint256 charged;
        for (uint256 i; i < set.length; ) {
            uint256 id = set[i];
            LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
            charged += slices[i].amount;
            // Forfeits consume the D1 ceiling but are EXEMPT from the loan-side
            // ledger (they are never emitted to the side).
            if (slices[i].loanSideChargeable) {
                s.loanSideRewardPaidVpfi[e.loanId][sideKey] += slices[i].amount;
            }
            // The armed-day union grows for forfeits too (rev-15 union rule).
            s.loanSideRewardedDays[e.loanId][sideKey] += 1;
            uint256 next = d + 1;
            s.rewardEntryClaimNextDay[id] = SafeCast.toUint64(next);
            if (next >= e.endDay) e.processed = true;
            unchecked { ++i; }
        }
        s.userSideDayPaidVpfi[user][sideKey][d] += charged;
    }

    /// @dev The FULL uncapped VPFI a claim by `user` would transfer right now
    ///      — the entry-path aggregate PLUS the finalized legacy window,
    ///      exactly what `claimInteractionRewardsTo` sums into one atomic
    ///      transfer before it pool-truncates the fresh part. The live claim's
    ///      actual `paid` is this figure truncated DOWN to the remaining 69M
    ///      pool, so this is an UPPER BOUND: `balance >= this` guarantees the
    ///      claimant's whole aggregate claim is funded. The claim-horizon
    ///      accumulator gates on it so the clock advances only when the
    ///      claimant had a working claim path for ALL their entries at once —
    ///      never per-entry, which would let a partly-funded balance reap one
    ///      entry while the real (aggregate) claim reverts (Codex #1317 P1).
    ///      Bounded: the window walk is capped at MAX_INTERACTION_CLAIM_DAYS.
    function userClaimPendingUncapped(
        LibVaipakam.Storage storage s,
        address user
    ) internal view returns (uint256 pending) {
        (pending, ) = _userEntriesUpperBound(s, user);
        (uint256 today, bool active) = currentDayOrZero();
        if (!active || today == 0) return pending;
        uint256 last = s.interactionLastClaimedDay[user];
        uint256 lastFinalized = today - 1;
        if (last >= lastFinalized) return pending;
        uint256 fromDay = last + 1;
        uint256 windowLast =
            fromDay + LibVaipakam.MAX_INTERACTION_CLAIM_DAYS - 1;
        uint256 toDay = windowLast < lastFinalized ? windowLast : lastFinalized;
        (uint256 effectiveTo, bool any) = clampToFinalized(fromDay, toDay);
        if (!any) return pending;
        pending += previewForUserWindow(user, fromDay, effectiveTo);
    }

    /// @dev The SUFFICIENT VPFI balance the user's atomic claim needs to NOT
    ///      revert — used by the horizon sweep's claim-executable gate. Unlike
    ///      the pure {userClaimPendingUncapped}, this MUTATES: it advances
    ///      every one of the user's side cursors first so the aggregate is
    ///      exact even for entries no keeper has swept yet (a behind cursor
    ///      makes {previewForUserEntries} read 0 for that entry — Codex #1317
    ///      r2 xkk). It then adds, only when the user has forfeited entries,
    ///      the headroom the claim's forfeit-credit path requires: that path
    ///      calls {LibVpfiRecycle.credit}, which reverts unless the POST-payout
    ///      balance still backs `recycleBucket + freshTreasury` — so the whole
    ///      claim needs `payout + recycleBucket + forfeitFresh` (Codex #1317 r2
    ///      xkq). A conservative sufficient bound (payout >= the pool-truncated
    ///      transfer), so the gate never reaps unfairly. The window walk is
    ///      capped at MAX_INTERACTION_CLAIM_DAYS and the entry scans are bounded
    ///      by the user's entry count — acceptable for the dark, keeper-run
    ///      reaper.
    function userClaimFundingNeed(
        LibVaipakam.Storage storage s,
        address user
    ) internal returns (uint256 need) {
        // Advance every side cursor so the funding formula reads the EXACT
        // value for each entry (a behind cursor would understate it — xkk),
        // then apply the shared formula (payout + the forfeit-credit backing).
        _advanceUserCursors(s, user);
        need = _userClaimFundingNeedView(s, user);
    }

    /// @dev Advance BOTH of the user's side cursors to the latest `endDay - 1`
    ///      across their unprocessed entries, so a subsequent
    ///      {previewForUserEntries} / {_entryPriceCore} reads the exact
    ///      finalized value for every entry (the cumulative-min arrays are
    ///      built lazily by the cursor, so an un-advanced day reads behind).
    ///      Idempotent and monotonic — advancing past the swept entry only
    ///      does the finalized-day work a later claim would do anyway.
    function _advanceUserCursors(
        LibVaipakam.Storage storage s,
        address user
    ) private {
        uint256[] storage ids = s.userRewardEntryIds[user];
        uint256 len = ids.length;
        uint256 maxLender;
        uint256 maxBorrower;
        for (uint256 i; i < len; ) {
            LibVaipakam.RewardEntry storage e = s.rewardEntries[ids[i]];
            if (!e.processed && e.endDay != 0) {
                uint256 needD = e.endDay - 1;
                if (e.side == LibVaipakam.RewardSide.Lender) {
                    if (needD > maxLender) maxLender = needD;
                } else {
                    if (needD > maxBorrower) maxBorrower = needD;
                }
            }
            unchecked { ++i; }
        }
        if (maxLender != 0 && s.cumLenderCursor < maxLender) {
            advanceCumLenderThrough(maxLender);
        }
        if (maxBorrower != 0 && s.cumBorrowerCursor < maxBorrower) {
            advanceCumBorrowerThrough(maxBorrower);
        }
    }

    /// @dev Sum the FRESH (non-recycled) face value of the user's unprocessed
    ///      FORFEITED entries — exactly the `freshTreasury` the claim's
    ///      forfeit-credit path would absorb into the recycle bucket. Priced by
    ///      {_entryPriceCore} — the same routing the claim runs — so this
    ///      counts precisely what the claim would absorb RIGHT NOW: an entry
    ///      the core cannot price yet (cursor behind an unfinalized day)
    ///      contributes 0, because the claim would absorb 0 for it too. A
    ///      settling caller advances the cursors first (see
    ///      {_advanceUserCursors}) so every price is exact; the view mirror
    ///      stays behind on exactly the axis a view cannot resolve.
    function _userForfeitFresh(
        LibVaipakam.Storage storage s,
        address user
    ) private view returns (uint256 fresh) {
        uint256[] storage ids = s.userRewardEntryIds[user];
        uint256 len = ids.length;
        for (uint256 i; i < len; ) {
            LibVaipakam.RewardEntry storage e = s.rewardEntries[ids[i]];
            // Cheap pre-filter only — the forfeit ROUTING decision itself is
            // the core's (`st.forfeit`), not re-derived here.
            if (
                !e.processed &&
                (e.forfeited || _entryTerminalForfeit(s, e))
            ) {
                (
                    ,
                    EntrySplit memory toTreasury,
                    ,
                    EntryPriceState memory st
                ) = _entryPriceCore(s, ids[i], e);
                if (st.forfeit) {
                    // The core prices the REMAINING window (slice 2d), so
                    // this is EXACT for a part-claimed entry: a settled
                    // legacy slice or already-walked days no longer count,
                    // closing the Codex #1404 r6 overstatement outright
                    // rather than by an upper bound.
                    fresh += toTreasury.total - toTreasury.recycled;
                }
            }
            unchecked { ++i; }
        }
    }

    /// @dev #1434 P1-b (Codex #1699 r3 P1) — the user's AGGREGATE armed-fresh
    ///      requirement across every unprocessed entry, both payable and
    ///      forfeited.
    ///
    ///      The delivered bound is a per-CLAIM-GROUP constraint, not a
    ///      per-entry one: `processUserSideDay` groups a user's entries per
    ///      (side, day) and defers the WHOLE group when the allowance is
    ///      short. Testing one entry's own `armedFresh` therefore answers a
    ///      question the claim never asks — two 0.4 entries against 0.5
    ///      delivered each look payable while the real claim pays neither, so
    ///      an expiry clock reading per-entry would accrue executable time the
    ///      claimant never had.
    ///
    ///      Modelled on {_userClaimFundingNeedView}, which already aggregates
    ///      the BALANCE requirement for exactly this reason — the delivered
    ///      requirement is the same shape and belongs beside it. Forfeited
    ///      legs are included because they spend armed fresh too (the forfeit
    ///      share is absorption that credits the bucket).
    /// @notice #1434 P1-b (Codex #1699 r4) — the INTERNAL entry point the lens
    ///         view calls. Only the facet that exposes this pays the dry-run
    ///         engine's bytecode; every other caller reaches it by staticcall
    ///         through the Diamond (see {_userArmedFreshNeed}).
    function userArmedFreshNeedView(
        address user
    ) internal view returns (uint256 armed) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        (, armed) = _dryRunShareOfPoolDays(s, user, type(uint256).max);
    }

    function _userArmedFreshNeed(
        LibVaipakam.Storage storage s,
        address user
    ) private view returns (uint256 armed) {
        // Codex #1699 r4 P2 — read the CLAIM'S OWN grouped, capped figure.
        //
        // The first version summed `_entryPriceCore` outputs per entry, which
        // overstates any `(user, side, day)` group sharing a D1 ceiling: two
        // 0.4 entries capped collectively to 0.5 reported 0.8, so the clock
        // waited forever on 0.3 that no remittance owes. Aggregating was right;
        // aggregating at the pre-cap STAGE was not.
        //
        // `type(uint256).max` for the delivered cap is load-bearing: this
        // measures what the group NEEDS, and clamping that by the allowance it
        // is about to be compared against would make every user look exactly
        // affordable.
        //
        // Codex #1699 r4 — reached by CROSS-FACET STATICCALL, not a direct
        // call, and that is an EIP-170 requirement rather than a style choice.
        // Calling `_dryRunShareOfPoolDays` from here inlines the whole
        // dry-run engine (side loop → `processUserSideDay` → worklist and
        // cursor machinery) into EVERY facet that transitively reaches this
        // helper; doing so pushed `InteractionRewardsFacet` to 29,613 bytes,
        // 5,037 over the limit. In a Diamond, sharing an internal helper is
        // free at the call site and paid for in each facet's bytecode.
        //
        // The staticcall keeps ONE implementation — re-deriving the capped
        // group figure here is the second-computation trap that caused the
        // finding this fix answers — while the engine itself lives only in
        // the lens facet, which already hosts the preview that uses it.
        // A staticcall to a view cannot trip the caller's `nonReentrant`
        // guard, so it is safe from the sweep path (same pattern as
        // `AddCollateralFacet` / `MetricsDashboardFacet`).
        (bool ok, bytes memory ret) = address(this).staticcall(
            abi.encodeWithSelector(
                bytes4(keccak256("getUserArmedFreshNeed(address)")),
                user
            )
        );
        // Fail CLOSED on an unrouted selector (a partially-refreshed Diamond):
        // a zero need would read as "nothing required" and let an entry expire
        // while unpayable, which is the defect this gate exists to prevent.
        require(ok && ret.length == 32, "armed-need view unavailable");
        armed = abi.decode(ret, (uint256));
    }

    /// @dev #1351 slice 2e — the CHEAP per-entry sum: each entry's
    ///      remaining-window core price, independently. A guaranteed UPPER
    ///      BOUND on what a claim transfers (the D1 shared-day ceiling, the
    ///      per-call day chunk, and the pool truncation only ever reduce it),
    ///      which is precisely the contract the funding gates need
    ///      ({userClaimPendingUncapped}: `balance >= bound` ⇒ the aggregate
    ///      claim is funded, the sweep never reaps unfairly). Deliberately a
    ///      DIFFERENT quantity from {previewForUserEntries} — the walk-exact
    ///      preview inlines the whole DryRun walk, which would push the
    ///      sweep-hosting facet over EIP-170 for a gate that only needs a
    ///      sufficient bound.
    /// @return userTotal     Upper bound on the aggregate user payout.
    /// @return recycledTotal  The RAW (pre-loan-side-cap) recycled share —
    ///                        the quantity the drought gate compares to the
    ///                        live bucket. AGGREGATE (Codex #1410 r6: joint
    ///                        same-day sets defer on the combined draw) and
    ///                        RAW (Codex #1410 r8: the cap is fresh-first
    ///                        over the aggregate window, so the CAPPED
    ///                        recycled can read 0 while the per-day walk
    ///                        still draws from the bucket on its first day).
    ///                        Raw >= any actual cumulative walk draw, so the
    ///                        gate can never fail open; over-detection only
    ///                        pauses, the documented safe direction.
    ///                        Forfeited entries stay excluded — their
    ///                        recycled leg is a pure commitment release that
    ///                        never draws the bucket (the r9 asymmetry).
    function _userEntriesUpperBound(
        LibVaipakam.Storage storage s,
        address user
    ) private view returns (uint256 userTotal, uint256 recycledTotal) {
        uint256[] storage ids = s.userRewardEntryIds[user];
        uint256 len = ids.length;
        for (uint256 i = 0; i < len; ) {
            uint256 id = ids[i];
            LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
            if (
                !e.processed
                && !e.forfeited
                && !_entryTerminalForfeit(s, e)
                && _entryClaimable(s, e)
            ) {
                (
                    EntrySplit memory toUser,
                    ,
                    ,
                    EntryPriceState memory st
                ) = _entryPriceCore(s, id, e);
                userTotal += toUser.total;
                recycledTotal += st.rawSplit.recycled;
            }
            unchecked { ++i; }
        }
    }

    /// @notice View-only preview of {claimForUserEntries}.
    /// @dev #1351 slice 2e — decomposed EXACTLY as the claim is: the entry
    ///      path's pre-`D*` legacy legs (O(1) per entry), plus a DryRun of
    ///      the ShareOfPool day walk for the armed days
    ///      ({_dryRunShareOfPoolDays}). Before this, each armed entry
    ///      previewed its own capped value independently, which ignored the
    ///      D1 `(user, side, day)` ceiling SHARED across entries and the
    ///      per-call day-chunk bound — two entries on one day previewed
    ///      2×C-ish while the claim would pay ≤ C. Identical on every
    ///      current deploy (`D*` unarmed ⇒ the walk leg is empty and the
    ///      whole window is the legacy leg).
    ///
    ///      The DryRun honours the LIVE recycled bucket (a day the walk
    ///      would defer for a short bucket is not previewed — Codex #1410
    ///      r2); it stays deliberately uncapped ONLY by the 69M lifetime
    ///      headroom, the payment-time truncation axis on which the preview
    ///      remains an upper bound ({userClaimPendingUncapped}).
    function previewForUserEntries(address user)
        internal
        view
        returns (uint256 userTotal)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage ids = s.userRewardEntryIds[user];
        uint256 len = ids.length;
        uint256 armedFrom = s.governorCommitArmedFromDay;

        for (uint256 i = 0; i < len; ) {
            uint256 id = ids[i];
            LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
            // #1002 (S4) / #1061 P2 — only claimable (closed or loan-terminal),
            // non-forfeited (explicit OR terminal-derived) entries preview to the
            // user (was the dead `endDay != 0`).
            if (
                !e.processed
                && !e.forfeited
                && !_entryTerminalForfeit(s, e)
                && _entryClaimable(s, e)
            ) {
                // #1008 (S13) — cap is baked into cumMin; no feed read here.
                userTotal += _previewEntryLeg(s, id, e, armedFrom);
            }
            unchecked { ++i; }
        }
        (uint256 dryTotal, ) =
            _dryRunShareOfPoolDays(s, user, deliveredFreshBound(s));
        userTotal += dryTotal;
    }

    /// @dev The ENTRY-PATH leg of one entry's preview — what {_processEntry}
    ///      itself would pay, excluding anything the day walk owns:
    ///      - no armed tail (or unarmed deploy): the whole remaining window;
    ///      - unsettled spanning entry: the pre-`D*` legacy slice, by the
    ///        same regime identity the settle uses;
    ///      - cursor stamped or all-armed: 0 — the walk owns what remains,
    ///        and {_dryRunShareOfPoolDays} prices it.
    function _previewEntryLeg(
        LibVaipakam.Storage storage s,
        uint256 id,
        LibVaipakam.RewardEntry storage e,
        uint256 armedFrom
    ) private view returns (uint256) {
        if (armedFrom == 0 || e.endDay <= armedFrom) {
            return _previewEntryReward(s, id, e);
        }
        if (s.rewardEntryClaimNextDay[id] != 0 || e.startDay >= armedFrom) {
            return 0; // the walk owns everything that remains
        }
        (, , , EntryPriceState memory st) = _entryPriceCore(s, id, e);
        if (!st.priced) return 0;
        return
            st.rawSplit.total - st.rawSplit.recycled - st.rawSplit.armedFresh;
    }

    /// @dev #1351 slice 2e — a VIEW DryRun of {_walkShareOfPoolDays}: same
    ///      worklist, same per-day pricing ({processUserSideDay}), same
    ///      shared day-chunk allowance — but cursors advance in MEMORY and
    ///      each day's loan-side charge folds into a {LoanSideCarry} overlay
    ///      instead of storage. One pricing implementation; the preview
    ///      cannot promise what the walk would not pay.
    ///
    ///      Walks with an UNBOUNDED pool on purpose — see
    ///      {previewForUserEntries}. A day the walk would defer for a
    ///      transient reason (unfinalized RPN row) stops the side here
    ///      exactly as it stops the real walk.
    /// @param deliveredCap The delivered-fresh allowance this run should
    ///        respect. The PREVIEW passes the live bound, so a quote cannot
    ///        promise what a claim would defer. A NEED measurement passes
    ///        `type(uint256).max` — bounding the need by the very allowance it
    ///        will then be compared against is circular, and would report every
    ///        user as exactly affordable (Codex #1699 r4 P2).
    /// @return userTotal   Capped payable total across the walked days.
    /// @return armedTotal  Capped ARMED-FRESH sum across those same days —
    ///         grouped and D1-capped exactly as the claim computes it, because
    ///         it IS the claim's computation. Summing per-entry prices instead
    ///         overstates any `(user, side, day)` group that shares a ceiling.
    function _dryRunShareOfPoolDays(
        LibVaipakam.Storage storage s,
        address user,
        uint256 deliveredCap
    ) private view returns (uint256 userTotal, uint256 armedTotal) {
        if (s.governorCommitArmedFromDay == 0) return (0, 0);
        uint256 daysLeft = LibVaipakam.MAX_INTERACTION_CLAIM_DAYS;
        // Codex #1410 r2 — the RECYCLED budget is the REAL bucket, shared
        // across both sides and depleted per day exactly as the live walk's
        // ctx.pool is: a recycled shortfall DEFERS a day and stops the side
        // (walk behaviour the preview must mirror). FRESH stays unbounded on
        // purpose — the 69M truncation is payment-time behaviour (the facet
        // scaler / the terminal trim), the one documented axis on which the
        // preview stays an upper bound.
        //
        // #1434 P1-b — the MIRROR delivered-fresh bound is NOT a second such
        // axis: it is BOUND here, exactly as in the walk. The cap's
        // truncation only ever shaves a payout the claimant still receives,
        // which is why overstating it is tolerable. A delivered shortfall
        // DEFERS instead — the day pays NOTHING and the claim reverts
        // `NoInteractionRewardsToClaim` — so leaving it unbounded would
        // quote a mirror claimant the full amount against a claim that
        // cannot succeed. That is not a loose upper bound, it is a wrong
        // answer, and it would be a REGRESSION from the halt this slice
        // removes: the halt lived inside {_dayPoolHalves}, which this
        // preview also calls, so preview and claim always agreed about an
        // unpayable mirror day. Binding here preserves that agreement.
        PoolBudget memory pool = PoolBudget({
            fresh: type(uint256).max,
            recycled: s.recycleBucket,
            deliveredFresh: deliveredCap
        });
        for (uint8 sideIdx; sideIdx < 2; ) {
            LibVaipakam.RewardSide side = sideIdx == 0
                ? LibVaipakam.RewardSide.Lender
                : LibVaipakam.RewardSide.Borrower;
            uint256[] memory work =
                _shareOfPoolWorklist(s, user, side, true);
            if (work.length != 0) {
                (uint256 paid, uint256 spent, uint256 armed) =
                    _dryRunSideDays(s, user, work, daysLeft, pool);
                userTotal += paid;
                daysLeft -= spent;
                armedTotal += armed;
            }
            unchecked { ++sideIdx; }
        }
    }

    /// @dev One side of the DryRun: simulate the day loop over `work` with
    ///      memory cursors + the loan-side carry. Returns what the walk
    ///      would pay the user and how many days of the shared allowance it
    ///      would consume.
    function _dryRunSideDays(
        LibVaipakam.Storage storage s,
        address user,
        uint256[] memory work,
        uint256 daysLeft,
        PoolBudget memory pool
    )
        private
        view
        returns (uint256 userTotal, uint256 daysSpent, uint256 armedTotal)
    {
        uint256[] memory cur = new uint256[](work.length);
        for (uint256 i; i < work.length; ) {
            cur[i] = _shareOfPoolCursorDay(s, work[i], s.rewardEntries[work[i]]);
            unchecked { ++i; }
        }
        DryRunState memory dry;
        dry.active = true;
        dry.loanSide = new LoanSideCarry[](work.length);

        while (daysSpent < daysLeft) {
            uint256 d = _dryLowestDay(s, work, cur);
            if (d == type(uint256).max) break;

            (uint256[] memory set, uint256[] memory setCur) =
                _dryEntriesAtDay(s, work, cur, d);
            dry.setCursors = setCur;

            (DayCharge memory charge, DaySlice[] memory slices) =
                processUserSideDay(user, d, set, pool, dry);
            if (!charge.advanced) break;

            pool.recycled -= charge.toUser.recycled;
            // Codex #1699 r1 P1 — mirror the WALK's delivered-bound depletion.
            //
            // `pool.fresh` is deliberately unbounded here (the 69M truncation
            // is payment-time behaviour), but `deliveredFresh` is NOT: this
            // preview binds it so a quote cannot promise what a claim would
            // defer. A bound that is read once and never depleted would let
            // every day in a multi-day window be measured against the same
            // untouched allowance — the same defect the finding raised
            // against the walk, and quoting it here would re-open the
            // preview-versus-claim divergence this slice already closed.
            if (_isArmedDay(s, d)) {
                uint256 spent =
                    charge.toUser.armedFresh + charge.toTreasury.armedFresh;
                // The grouped, D1-capped armed figure — the claim's own number.
                armedTotal += spent;
                uint256 db = pool.deliveredFresh;
                pool.deliveredFresh = db > spent ? db - spent : 0;
            }
            userTotal += charge.toUser.total;
            _dryFoldDay(s, dry.loanSide, set, slices);
            // Advance the simulated cursors of the set members.
            for (uint256 i; i < work.length; ) {
                if (cur[i] == d) cur[i] = d + 1;
                unchecked { ++i; }
            }
            unchecked { ++daysSpent; }
        }
    }

    /// @dev Lowest simulated pending day; `max` when the side is done.
    function _dryLowestDay(
        LibVaipakam.Storage storage s,
        uint256[] memory work,
        uint256[] memory cur
    ) private view returns (uint256 d) {
        d = type(uint256).max;
        for (uint256 i; i < work.length; ) {
            if (cur[i] < s.rewardEntries[work[i]].endDay && cur[i] < d) {
                d = cur[i];
            }
            unchecked { ++i; }
        }
    }

    /// @dev The joint set at simulated day `d`, with its aligned cursors.
    ///      A COMPLETED simulated entry (`cur == its endDay`) is excluded
    ///      (Codex #1410 r1 P2): memory cursors have no `processed` flag, so
    ///      when a longer sibling later reaches the shorter entry's endDay,
    ///      the equality alone would re-admit the finished entry and the
    ///      primitive's window check would revert the whole preview. The
    ///      settling walk is immune — {_persistDay} flips `processed` and
    ///      {_entriesAtDay} filters on it.
    function _dryEntriesAtDay(
        LibVaipakam.Storage storage s,
        uint256[] memory work,
        uint256[] memory cur,
        uint256 d
    )
        private
        view
        returns (uint256[] memory set, uint256[] memory setCur)
    {
        uint256 m;
        for (uint256 i; i < work.length; ) {
            if (cur[i] == d && d < s.rewardEntries[work[i]].endDay) {
                unchecked { ++m; }
            }
            unchecked { ++i; }
        }
        set = new uint256[](m);
        setCur = new uint256[](m);
        uint256 k;
        for (uint256 i; i < work.length; ) {
            if (cur[i] == d && d < s.rewardEntries[work[i]].endDay) {
                set[k] = work[i];
                setCur[k] = cur[i];
                unchecked { ++k; }
            }
            unchecked { ++i; }
        }
    }

    /// @dev Fold one previewed day into the carry exactly as {_persistDay}
    ///      would have written it: paid deltas for chargeable slices, +1
    ///      armed day per entry's loan either way (the rev-15 union rule).
    function _dryFoldDay(
        LibVaipakam.Storage storage s,
        LoanSideCarry[] memory carry,
        uint256[] memory set,
        DaySlice[] memory slices
    ) private view {
        for (uint256 i; i < set.length; ) {
            _carryCharge(
                carry,
                s.rewardEntries[set[i]].loanId,
                slices[i].loanSideChargeable ? slices[i].amount : 0,
                1
            );
            unchecked { ++i; }
        }
    }

    /**
     * @notice Sweep forfeited entries belonging to `loanId` into the
     *         treasury payout channel — permissionless. Exists so that
     *         defaulted/liquidated loans whose borrower never returns to
     *         claim still get their forfeited VPFI routed to treasury.
     *
     * @param loanId Loan id whose closed+forfeited entries to sweep.
     * @return toTreasury Aggregated {EntrySplit} of the forfeits (the facet
     *                    splits fresh-credit vs recycled-release — PR-3c).
     */
    function sweepForfeitedByLoanId(uint256 loanId)
        internal
        returns (EntrySplit memory toTreasury)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // #1061 P1 — the sweep DISCARDS `_processEntry`'s `toUser`, so it must
        // only ever process FORFEITED entries. Otherwise a payable entry made
        // claimable by the loan-terminal fallback ({_entryClaimable}) would be
        // marked `processed` with nothing transferred, destroying the user's
        // reward. Skip any entry that isn't forfeited (explicit or terminal-
        // derived) — a permissionless sweep can never touch a payable entry.
        uint256 lenderId = s.loanActiveLenderEntryId[loanId];
        if (lenderId != 0 && _isForfeited(s, s.rewardEntries[lenderId])) {
            (, EntrySplit memory t) = _processEntryWhole(s, lenderId);
            _foldSplit(toTreasury, t);
        }
        uint256 borrowerId = s.loanBorrowerEntryId[loanId];
        if (borrowerId != 0 && _isForfeited(s, s.rewardEntries[borrowerId])) {
            (, EntrySplit memory t) = _processEntryWhole(s, borrowerId);
            _foldSplit(toTreasury, t);
        }

        // #953 (Codex) — also drain lender entries that a position sale orphaned
        // from the active pointer (see `transferLenderEntry`). Each is forfeited,
        // so `_processEntry` routes it to treasury; it is idempotent, so an entry
        // already processed by a prior sweep or a later un-flagged claim adds 0.
        uint256[] storage orphaned = s.loanForfeitedLenderEntryIds[loanId];
        uint256 olen = orphaned.length;
        for (uint256 i = 0; i < olen; ) {
            if (_isForfeited(s, s.rewardEntries[orphaned[i]])) {
                (, EntrySplit memory t) = _processEntryWhole(s, orphaned[i]);
                _foldSplit(toTreasury, t);
            }
            unchecked { ++i; }
        }
    }


    /// @dev #1434 (Codex #1699 r8 P1) — mark the REMOVAL POINT on the first
    ///      chunk that actually credits, and announce it.
    ///
    ///      Called from every crediting expiry path (the legacy bootstrap and
    ///      each armed chunk) rather than only the first, because which one
    ///      runs first depends on the entry's shape. Idempotent by the flag.
    function _beginExpiry(
        LibVaipakam.Storage storage s,
        uint256 id,
        LibVaipakam.RewardEntry storage e
    ) private {
        if (e.expiryBegun) return;
        e.expiryBegun = true;
        emit RewardEntryExpiryBegun(id, e.user);
    }

    /**
     * @notice RL-3 (#1305, Codex #1317 r7) — advance an entry's
     *         EXECUTABLE-ELAPSED claim-horizon accumulator and, once it has
     *         accrued a full `H + notice` of provably-claimable time,
     *         process it into the EXPIRED channel.
     *
     *         Expiry is driven by executable time, never wall-clock: an
     *         interval between two sweep observations is credited toward the
     *         threshold ONLY if the entry was claim-executable at both ends
     *         AND the gap is ≤ `REWARD_CLAIM_NOTICE_MAX_OBS_GAP_DAYS` (short
     *         enough to trust as continuous). A longer gap — or any observed
     *         non-executable state (unfunded / zero-payable / sanctioned) —
     *         is never counted, so an unobserved outage can never let the
     *         clock run past a window the claimant could not actually claim.
     *
     *         State machine per call (permissionless, keeper-class):
     *           - feature dark (`rewardClaimHorizonDays == 0`)        → no-op
     *           - processed / not claimable (finalization) / forfeited → no-op
     *           - not claim-EXECUTABLE now (zero post-cap payable, local
     *             VPFI can't cover it, or owner sanctioned) → no-op, and do
     *             NOT advance the observation stamp (the outage interval
     *             will exceed the gap bound and stay uncredited)
     *           - executable, first observation → STAMP + start accumulator
     *           - executable, gap ≤ bound → CREDIT the interval; emit the
     *             final-notice signal on crossing `H`; a horizon
     *             reconfiguration since the last accrual first caps the
     *             accumulator back to `H` so the notice is re-earned
     *           - executable, `execElapsed ≥ H + notice` → EXPIRE: process
     *             the entry and return its {EntrySplit} for source-split
     *             routing.
     *
     *         Forfeited entries are excluded — {sweepForfeitedByLoanId}
     *         owns those; this sweep only ever expires PAYABLE value whose
     *         owner never came back.
     * @param  freshHeadroom Remaining fresh-pool capacity the CALLER's
     *                       batch may still consume — the fresh share is
     *                       capped to it per entry, so a batch can never
     *                       terminalise several fresh entries against one
     *                       capacity sliver.
     * @return expired The expired FACE-VALUE decomposition (all zeros
     *                 unless the entry expired on this call).
     * @return freshCredited The post-cap fresh amount actually creditable
     *                       for this entry — the caller decrements its
     *                       headroom and credits the bucket with this.
     */
    /// @param deliveredAllowance Remaining MIRROR delivered-fresh allowance for
    ///        this batch. Threaded and depleted by the caller exactly like
    ///        `freshHeadroom` (Codex #1699 r2 P1): reading the storage figure
    ///        per entry let several entries in one batch each measure against
    ///        the same untouched allowance and collectively over-credit.
    ///        `type(uint256).max` off-mirror, where the bound does not apply.
    function sweepExpiredEntry(
        uint256 id,
        uint256 freshHeadroom,
        uint256 deliveredAllowance
    )
        internal
        returns (
            EntrySplit memory expired,
            uint256 freshCredited,
            uint256 armedDelivered
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint32 horizonDays = s.rewardClaimHorizonDays;
        if (horizonDays == 0) return (expired, 0, 0);
        LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
        if (e.processed || e.user == address(0)) return (expired, 0, 0);
        if (e.forfeited || _entryTerminalForfeit(s, e)) return (expired, 0, 0);
        if (!_entryClaimable(s, e)) return (expired, 0, 0);
        if (e.startDay >= e.endDay) return (expired, 0, 0);

        // The cursor must actually cover the window — a claim blocked on
        // finalization keeps the clock frozen (never stamps, never accrues).
        uint256 need = e.endDay - 1;
        uint256 cursor = e.side == LibVaipakam.RewardSide.Lender
            ? s.cumLenderCursor
            : s.cumBorrowerCursor;
        if (cursor < need) {
            cursor = e.side == LibVaipakam.RewardSide.Lender
                ? advanceCumLenderThrough(need)
                : advanceCumBorrowerThrough(need);
            if (cursor < need) return (expired, 0, 0);
        }

        (
            EntrySplit memory toUser,
            ,
            ,
            EntryPriceState memory st
        ) = _entryPriceCore(s, id, e);
        // A zero-value window prices nothing, pays nothing, and — once the
        // cursor covers it — can never grow: there is no clock to run for it.
        if (!st.priced) return (expired, 0, 0);
        // #1434 — this core call now serves the CLOCK only, not the credit.
        // It answers "could the claimant claim right now", which is what the
        // executable accumulator gates on: `_poolCappedPayable(toUser)` is
        // what a claim would actually pay. The settlement quantities come from
        // the day primitive at the end of this function, so the raw split is
        // no longer read here — an expiry no longer prices itself.
        // Claim-EXECUTABLE gate: the accumulator only advances while the
        // CLAIMANT could actually claim right now. The claim is ATOMIC-
        // AGGREGATE — `claimInteractionRewardsTo` processes ALL of the user's
        // entries (payable AND forfeited) plus the finalized legacy window in
        // ONE call and reverts if any part is underfunded — so the funding
        // check is against the user's whole claim, never this one entry: a
        // per-entry balance check would let a partly-funded balance reap one
        // entry while the real (aggregate) claim reverts (Codex #1317 P1).
        // `userClaimFundingNeed` ADVANCES every one of the user's side cursors
        // first, so the aggregate is exact even for entries a keeper hasn't
        // swept yet (their cursors would otherwise read behind and understate
        // the need — Codex #1317 r2 xkk), and it folds in the recycle-bucket
        // backing the forfeit-credit path needs (Codex #1317 r2 xkq). The
        // per-entry backing room is NOT checked here — it gates the all-or-
        // nothing EXPIRY credit below, not the claimant's clock. Blocked when:
        //   1. this entry's pool-capped payable is zero (a reap of it would
        //      recycle nothing — nothing a claim could pay for it),
        //   2. the owner is sanctioned (the claim path rejects them),
        //   3. the protocol is paused (every claim reverts under the pause),
        //   4. the balance can't cover the user's whole aggregate claim.
        // Codex #1410 r7 P1 — advance ALL the user's cursors BEFORE the
        // aggregate drought test. A sibling entry whose `endDay - 1` still
        // lies beyond the cumulative cursor prices 0 in the upper bound, so
        // on the first sweep touch after its days finalize the drought gate
        // would miss its recycled draw and credit an interval the real claim
        // (which advances first, then defers the joint day) could not serve.
        // The funding-need call performs exactly that advance, so it is
        // hoisted ahead of the gate rather than left to short-circuit order.
        // (The read-only countdown mirror cannot advance and keeps its
        // documented optimistic-estimate caveat; this sweep is the
        // authority.)
        uint256 fundingNeed = userClaimFundingNeed(s, e.user);
        // Codex #1699 r2 P1 — the MIRROR delivered bound belongs in this
        // predicate, not only at the terminal.
        //
        // The horizon clock measures time during which the claimant COULD
        // have claimed. If delivered funding cannot cover this entry's armed
        // share, their own walk defers and they cannot be paid — so time
        // spent in that state is not executable time. Checking it only at the
        // terminal let an entry bank its full horizon+notice while unpayable
        // and then expire the instant funding arrived, without the claimant
        // ever getting the configured window.
        //
        // This is the w4 rule applied to a new clock: a bounded remediation
        // window must not run while the remedy path is structurally
        // unreachable. Reads the STORAGE bound deliberately — the batch-local
        // allowance is about how much one sweep may spend, whereas this asks
        // whether the entry is payable AT ALL.
        // Codex #1699 r3 P1 — the AGGREGATE requirement, not this entry's own.
        // The claim groups a user's entries and defers the whole group, so a
        // per-entry test would keep the clock running through exactly the
        // state in which the claimant cannot be paid.
        uint256 armedNeed = _userArmedFreshNeed(s, e.user);
        bool deliveredPayable = armedNeed == 0
            || !LibVaipakam.isMirrorRewardChain(s)
            || armedNeed <= deliveredFreshBound(s);
        bool executable = !_recycledDrought(s, e.user) &&
            _poolCappedPayable(toUser) != 0 &&
            deliveredPayable &&
            !LibVaipakam.isSanctionedAddress(e.user) &&
            !LibPausable.paused() &&
            IERC20Metadata(s.vpfiToken).balanceOf(address(this)) >=
            fundingNeed;

        uint64 lastObs = s.rewardEntryExecObsAt[id];

        if (!executable) {
            // Observed non-executable. Before the first executable
            // observation there is no clock to break (stay unstarted).
            // Afterwards, record the block and advance the stamp so the
            // interval spanning this OBSERVED outage — however short — is
            // never credited on recovery (Codex #1317 r8).
            if (lastObs != 0) {
                s.rewardEntryObsBlocked[id] = true;
                s.rewardEntryExecObsAt[id] = uint64(block.timestamp);
            }
            return (expired, 0, 0);
        }

        uint256 hSec = uint256(horizonDays) * 1 days;

        if (lastObs == 0) {
            // First claim-executable observation — start the accumulator.
            // The stamp event is the notification pipeline's schedule signal.
            s.rewardEntryFirstClaimableAt[id] = uint64(block.timestamp);
            s.rewardEntryExecObsAt[id] = uint64(block.timestamp);
            s.rewardEntryHorizonEpoch[id] = s.rewardHorizonActivatedAt;
            emit RewardEntryHorizonStamped(id, e.user, uint64(block.timestamp));
            return (expired, 0, 0);
        }

        uint256 elapsed = s.rewardEntryExecElapsed[id];
        // A horizon (re)configuration since this entry last accrued re-opens
        // a fresh executable final notice: cap the accrual back to the
        // horizon threshold so the full `notice` must be re-earned under the
        // new configuration (the ratified re-notice-on-reconfiguration rule).
        // The interval spanning the reconfiguration is NOT credited toward
        // the fresh notice — re-baseline the observation and wait for the
        // next touch (Codex #1317 r8).
        if (s.rewardEntryHorizonEpoch[id] != s.rewardHorizonActivatedAt) {
            if (elapsed >= hSec) {
                elapsed = hSec;
                s.rewardEntryExecElapsed[id] = uint64(elapsed);
                // Entering the fresh final notice now — last-call signal.
                emit RewardEntryExpiryArmed(id, e.user, uint64(block.timestamp));
            }
            s.rewardEntryHorizonEpoch[id] = s.rewardHorizonActivatedAt;
            s.rewardEntryExecObsAt[id] = uint64(block.timestamp);
            s.rewardEntryObsBlocked[id] = false;
            return (expired, 0, 0);
        }

        // Credit this interval only if the entry was executable at BOTH ends
        // (the prior observation was not a block) AND the gap is short enough
        // to trust as continuous AND the gap did not straddle a pause window;
        // anything else is dropped (re-baselined below). An interval whose
        // prior sample predates the last pause boundary spanned a pause during
        // which every claim would have reverted, so it must not count as
        // executable time (Codex #1317 P2 — the sweep itself is `whenNotPaused`,
        // so it cannot observe DURING a pause; the boundary marker is how a
        // post-unpause sweep discovers the gap it slept through).
        // `<=`, not `<`: a pause boundary stored in the SAME block as the
        // prior observation is ambiguous in ordering, so treat an equal
        // timestamp as spanning the pause too — conservatively drop it rather
        // than credit a possibly-paused interval (Codex #1317 r2 xkm).
        bool spannedPause =
            uint256(lastObs) <= uint256(LibPausable.lastPauseBoundaryAt());
        if (!s.rewardEntryObsBlocked[id]) {
            uint256 gap = block.timestamp - uint256(lastObs);
            if (
                !spannedPause &&
                gap <=
                uint256(LibVaipakam.REWARD_CLAIM_NOTICE_MAX_OBS_GAP_DAYS) * 1 days
            ) {
                uint256 credited = elapsed + gap;
                if (elapsed < hSec && credited >= hSec) {
                    // Crossed into the final-notice window. Emit the TRUE
                    // crossing instant (the overshoot accrued before now),
                    // so the notice pipeline schedules from when the notice
                    // actually began, not this sweep's timestamp.
                    emit RewardEntryExpiryArmed(
                        id, e.user, uint64(block.timestamp - (credited - hSec))
                    );
                }
                elapsed = credited;
                s.rewardEntryExecElapsed[id] = uint64(elapsed);
            }
        } else {
            // Recovery from an observed block — re-baseline without
            // crediting the blocked interval.
            s.rewardEntryObsBlocked[id] = false;
        }
        s.rewardEntryExecObsAt[id] = uint64(block.timestamp);

        uint256 required =
            hSec + uint256(LibVaipakam.REWARD_CLAIM_HORIZON_NOTICE_DAYS) * 1 days;
        if (elapsed < required) {
            return (expired, 0, 0);
        }

        // #1434 — EXPIRY SETTLES THROUGH THE DAY PRIMITIVE.
        //
        // Everything below used to be computed here: the D1-capped
        // obligation, the delivered gate, the headroom decision, the credit.
        // Three review rounds produced three different wrong quantities for
        // the SAME number (raw; a split that leaves unstamped mirror loans
        // untrimmed; a claim-path aggregate that is per-USER, chunk-bounded
        // and loan-side capped). The defect was never the arithmetic — it was
        // owning a second implementation of settlement.
        //
        // `processUserSideDay` already allocates each entry's share WITHIN the
        // shared D1 ceiling, applies `deliveredCapForDay`, and distinguishes
        // the two fresh bounds correctly: a 69M shortfall TRUNCATES and
        // advances (monotone — deferring would livelock), while a DELIVERED
        // shortfall DEFERS (it grows with every remittance — truncating would
        // permanently underpay funding merely in flight). `_persistDay` then
        // records the D1 consumption, so a sibling expiry sees the reduced
        // headroom instead of being handed the same aggregate.
        //
        // `recycleSettlement` states the one way expiry differs from a claim:
        // the reward recycles to the bucket rather than paying a side, so the
        // loan-side cap must not bind it (#1371 r2) — the identical rule, and
        // the identical mechanism, forfeits already use.
        // #1434 (Codex r7 P1) — a SPANNING entry settles its PRE-CUTOVER leg
        // first, exactly as `_processEntry` does for a claim.
        //
        // `_shareOfPoolCursorDay` jumps an untouched spanning entry straight to
        // `armedFrom`, but `processUserSideDay` resolves an UNSET cursor to
        // `startDay` when it validates the set — so handing it that armed day
        // reverts `RewardEntrySetMismatch`. The consequence is worse than a
        // stuck entry: this sweep is a permissionless BATCH, so one abandoned
        // spanning entry would poison the whole keeper call, and the very
        // entries expiry exists to reap could never be reaped at all.
        //
        // The earlier revision handled the WHOLLY pre-cutover case and stopped
        // there. "Mirror the claim composition" means both legs: the claim
        // settles the legacy slice, stamps the cursor to `armedFrom`, and
        // leaves the armed tail owed. So does this now — the armed days reap on
        // the following sweeps, which is exactly the per-chunk shape the rest
        // of this path already has.
        uint256 armedFrom = s.governorCommitArmedFromDay;
        // #1434 (Codex #1699 r8 P1) — dispatch EXACTLY as `_processEntry` does,
        // and dispatch BEFORE reading the cursor.
        //
        // `_shareOfPoolCursorDay` answers "which armed day is next", so for a
        // wholly pre-cutover entry it returns `armedFrom` — a day PAST the
        // entry's own window. Reading it first made expiry bail at
        // `d >= endDay` and such an entry could never be reaped at all. The
        // wholly-legacy case has no armed day to ask about; it settles its
        // whole window and terminalises, exactly as the claim path does.
        if (armedFrom == 0 || e.endDay <= armedFrom) {
            EntrySplit memory whole = st.rawSplit;
            uint256 wholeFresh = whole.total - whole.recycled;
            if (wholeFresh > freshHeadroom) {
                s.rewardEntryObsBlocked[id] = true;
                return (expired, 0, 0);
            }
            _beginExpiry(s, id, e);
            expired = whole;
            freshCredited = wholeFresh;
            e.processed = true;
            s.rewardEntryExpiredAccum[id] += whole.total;
            s.rewardEntryExpiredRecycledAccum[id] += whole.recycled;
            emit RewardEntryExpired(
                id,
                e.user,
                s.rewardEntryExpiredAccum[id],
                s.rewardEntryExpiredRecycledAccum[id]
            );
            return (expired, freshCredited, 0);
        }
        if (
            armedFrom != 0
                && e.startDay < armedFrom
                // Codex #1699 r8 P1 — SPANS the cutover, not merely starts
                // before it. Without this an entry whose whole window is
                // pre-cutover also matched: it credited its full legacy value,
                // stamped the cursor to `armedFrom`, and never terminalised,
                // so every later sweep no-ops at `d >= endDay` while a claim
                // still routes through the whole-window branch and can PAY THE
                // SAME ENTRY AGAIN. A wholly pre-cutover entry belongs to the
                // terminal branch below, which marks it processed.
                && armedFrom < e.endDay
                && s.rewardEntryClaimNextDay[id] == 0
        ) {
            // ALL fresh by the regime identity — pre-`D*` days contribute no
            // recycled — and exempt from the delivered bound for the same
            // reason a pre-arming forfeit is: no remittance ever funded it.
            uint256 legacyFresh = st.rawSplit.total
                - st.rawSplit.recycled
                - st.rawSplit.armedFresh;
            if (legacyFresh > freshHeadroom) {
                s.rewardEntryObsBlocked[id] = true;
                return (expired, 0, 0);
            }
            _beginExpiry(s, id, e);
            s.rewardEntryClaimNextDay[id] = SafeCast.toUint64(armedFrom);
            s.rewardEntryExpiredAccum[id] += legacyFresh;
            expired.total = legacyFresh;
            freshCredited = legacyFresh;
            return (expired, freshCredited, 0);
        }

        uint256 d = _shareOfPoolCursorDay(s, id, e);
        if (d >= e.endDay) return (expired, 0, 0);

        // #1434 — EXPIRY MIRRORS THE CLAIM'S TWO LEGS, not just its walk.
        //
        // `claimInteractionRewardsTo` settles an entry-path LEGACY leg plus
        // the ShareOfPool walk, because the cursor does not represent
        // pre-cutover days at all: `_shareOfPoolCursorDay` jumps straight to
        // `armedFrom` for a spanning entry, and with no arming it returns
        // `startDay` on a day the primitive refuses outright
        // (`DayCapModeUnsetPostCutover`, deliberately behind the readiness
        // gate). Routing ALL of expiry through the primitive therefore handled
        // the armed leg and dropped the legacy one — the primitive owns armed
        // days, and that domain is narrower than expiry's input.
        //
        // A wholly pre-cutover entry carries no armed value, so no D1 group,
        // no delivered bound and no loan-side question arise: it settles as a
        // whole, exactly as it always did.
        // An ARMED day whose ShareOfPool stamp has not landed yet DEFERS.
        //
        // What stood here terminalised the entry and credited `st.rawSplit`,
        // which was right while this branch also caught wholly pre-cutover
        // entries. It no longer does — the dispatch above owns that case — so
        // the ONLY state that still reaches here is an armed day awaiting its
        // stamp (a mirror between broadcasts). Terminalising THAT would pay an
        // armed day's value with neither the D1 ceiling nor the delivered
        // bound applied, and destroy the rest of the entry on the way out.
        //
        // The `!_isArmedDay(s, d)` arm that used to guard this is dead here and
        // was removed rather than left to imply a reachability it does not
        // have: every path to this line has `d >= armedFrom` — a stamped
        // cursor comes from `_persistDay` (`d + 1`, `d >= armedFrom`) or the
        // legacy-leg stamp (`= armedFrom`), and an unset cursor floors at
        // `armedFrom`.
        //
        // A missing stamp is transient, so this is a DEFER, not a refusal: the
        // wait clears when the broadcast arrives, and the entry stays fully
        // claimable meanwhile because nothing was credited.
        if (s.dayCapMode[d] != LibVaipakam.CapMode.ShareOfPool) {
            s.rewardEntryObsBlocked[id] = true;
            return (expired, 0, 0);
        }

        uint256[] memory set = new uint256[](1);
        set[0] = id;
        DryRunState memory ctx = _noDryRun();
        ctx.recycleSettlement = true;
        (DayCharge memory charge, DaySlice[] memory slices) = processUserSideDay(
            e.user,
            d,
            set,
            PoolBudget({
                fresh: freshHeadroom,
                recycled: s.recycleBucket,
                deliveredFresh: deliveredAllowance
            }),
            ctx
        );
        // A deferred day (delivered shortfall, recycled drought, unready row)
        // credits nothing and keeps the entry live. RECORD the block so the
        // countdown pauses and the next touch re-baselines from a creditable
        // state — the claimant already served the full window, so this is a
        // protocol-side crediting constraint, never a fresh accrual.
        if (!charge.advanced) {
            s.rewardEntryObsBlocked[id] = true;
            return (expired, 0, 0);
        }
        // #1434 — ALL-OR-NOTHING SURVIVES, scoped to the DAY.
        //
        // Chunking fixes the ACROSS-days case: unpriced days keep their value
        // because the cursor advances only over days actually settled. It does
        // NOT fix the WITHIN-day case. A 69M shortfall deliberately TRUNCATES
        // and advances (the pool is monotone, so deferring would livelock a
        // claimant), routing the remainder to `cappedOff` — commitment retired,
        // no value credited. For a CLAIM that is right: the claimant is paid
        // what exists and the trimmed tail was never drawable anyway.
        //
        // For an EXPIRY it is not. Expiry is not the claimant's own claim; it
        // REAPS them. Truncating here would destroy the remainder on someone
        // who never asked to be settled, and unlike a claim there is no
        // livelock to avoid — the claim path stays open to them throughout, so
        // deferring costs nothing but a later sweep. That is the rule this
        // path has always had (`testExpirySweepDefersAtFullFreshExhaustion`,
        // `testExpiryIsAllOrNothingAtNearExhaustion`), and the unification
        // keeps it rather than quietly widening what a sweep may discard.
        // Codex #1699 r9 P1 — all-or-nothing applies BEFORE the removal point;
        // after it, the terminal cap policy does.
        //
        // These two rules looked independent and are not. Deferring on a fresh
        // shortfall protects an owner who is still claimable from being reaped
        // with part of their value discarded. But the 69M headroom is MONOTONE
        // non-increasing, so once removal has begun a deferral can never clear:
        // the first chunk credits, the pool draw shrinks the headroom, the next
        // chunk defers forever, `_processEntry` now skips the entry, and the
        // claimant permanently loses the tail with no `RewardEntryExpired` ever
        // emitted. The guard against silent loss became the cause of it.
        //
        // Sequencing them by the removal point resolves it. Before removal the
        // owner is still whole and still claimable, so DEFER. After removal
        // they have already been reaped — the "never reap someone mid-claim"
        // rationale is spent — and what remains is protocol bookkeeping that
        // must TERMINATE. So the day truncates and advances exactly as a claim
        // does against the same monotone budget, with `cappedOff` carrying the
        // remainder's commitment for retirement.
        if (charge.freshShortfall != 0 && !e.expiryBegun) {
            s.rewardEntryObsBlocked[id] = true;
            return (expired, 0, 0);
        }
        // Advances the cursor and sets `processed` at the window's end, so a
        // long entry reaps ACROSS SWEEPS instead of terminalising on a
        // 30-day chunk and discarding the rest. All-or-nothing is now
        // per-priced-chunk, which is what removes that value loss.
        _beginExpiry(s, id, e);
        _persistDay(s, e.user, e.side, d, set, slices);

        // A recycle settlement routes through the TREASURY leg (that is what
        // `loanSideChargeable == false` selects in `_attributeLegs`); expiry
        // credits the BUCKET rather than treasury, which is the caller's job.
        //
        // COMMITMENT RETIREMENT STAYS RAW: `cappedOff.armedFresh` is the
        // 69M-truncated remainder that moved no tokens, and its commitment
        // must still retire or the difference leaks and permanently depresses
        // every later day's availability. So `armedFresh` (what was OWED,
        // retired by `consumeArmedFresh`) and `freshCredited` / `armedDelivered`
        // (what actually MOVED) deliberately differ.
        expired.recycled = charge.toTreasury.recycled;
        expired.armedFresh =
            charge.toTreasury.armedFresh + charge.cappedOff.armedFresh;
        expired.total = charge.toTreasury.total + charge.cappedOff.armedFresh;
        freshCredited = charge.toTreasury.armedFresh;
        // Codex #1699 r7 P2 — the TERMINAL event must still describe the WHOLE
        // entry. Chunked settlement made `expired` the current day's slice, so
        // emitting it at terminalization would silently redefine
        // `RewardEntryExpired.total/recycled` from the entry's decomposition to
        // an unexplained final chunk — and every indexer and notification
        // consumer reading that face value would under-report. Accumulate here
        // and emit the sum below; the event's documented meaning is unchanged.
        s.rewardEntryExpiredAccum[id] += expired.total;
        s.rewardEntryExpiredRecycledAccum[id] += expired.recycled;
        // Only an ARMED day draws on delivered funding — the same filter the
        // walk's paid-side write applies, for the same reason.
        armedDelivered = _isArmedDay(s, d) ? freshCredited : 0;
        if (e.processed) {
            emit RewardEntryExpired(
                id,
                e.user,
                s.rewardEntryExpiredAccum[id],
                s.rewardEntryExpiredRecycledAccum[id]
            );
        }
    }

    /// @notice RL-3 — UX view: the entry's horizon state for the
    ///         claim-center countdown.
    /// @return firstClaimableAt Accumulator start (0 = not started).
    /// @return expiresAt        A CONSERVATIVE forward estimate of the
    ///                          earliest instant the entry could be reaped,
    ///                          assuming it stays continuously claim-executable
    ///                          from now (0 = dark, unstarted, OR already
    ///                          processed). The on-chain sweep is
    ///                          authoritative; this view only estimates.
    ///                          Removal is gated on claim-EXECUTABLE-elapsed
    ///                          time, so a funding outage or sanction pauses
    ///                          the countdown (the pending heartbeat interval
    ///                          is folded in only while the entry is
    ///                          claim-executable now). The estimate errs
    ///                          OPTIMISTIC (never later than the true reap):
    ///                          once the window is fully accrued it reports
    ///                          `now` even if the actual reap is deferred a
    ///                          little longer by a recycle-bucket backing
    ///                          shortfall — which is safe UX, since it only
    ///                          urges the claimant to claim sooner, and they
    ///                          can claim right up until the reap.
    function rewardEntryExpiry(uint256 id)
        internal
        view
        returns (uint64 firstClaimableAt, uint64 expiresAt)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        firstClaimableAt = s.rewardEntryFirstClaimableAt[id];
        uint32 horizonDays = s.rewardClaimHorizonDays;
        if (firstClaimableAt == 0 || horizonDays == 0) return (firstClaimableAt, 0);
        LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
        // A processed entry (claimed or already expired) can never be swept,
        // so it has no live countdown (Codex #1317 r11).
        if (e.processed) return (firstClaimableAt, 0);

        uint256 hSec = uint256(horizonDays) * 1 days;
        uint256 elapsed = s.rewardEntryExecElapsed[id];
        if (s.rewardEntryHorizonEpoch[id] != s.rewardHorizonActivatedAt) {
            // A sweep would reconcile the reconfiguration: cap to the horizon
            // so the notice re-accrues, crediting nothing this interval. The
            // cap never understates remaining, so it is applied regardless of
            // executability; the re-accrual's own claim-executable gating is
            // covered by the conservative-estimate caveat above (Codex #1317).
            if (elapsed > hSec) elapsed = hSec;
        } else if (
            !s.rewardEntryObsBlocked[id] && _entryExecutableNow(s, id, e)
        ) {
            // Fold in the pending interval a sweep-now would credit — but
            // ONLY while the entry is claim-executable at this block (owner
            // unsanctioned, pool-capped payable non-zero, balance covers it),
            // mirroring the sweep's accrual gate. A blocked claimant's
            // countdown pauses here instead of ticking down through the block.
            // An interval that straddled a pause boundary is dropped, matching
            // the sweep — else a paused-then-unpaused entry would show
            // `expiresAt == now` while a sweep-now would only re-baseline
            // (Codex #1317 r2 xkn).
            uint256 lastObs = uint256(s.rewardEntryExecObsAt[id]);
            uint256 gap = block.timestamp - lastObs;
            if (
                lastObs > uint256(LibPausable.lastPauseBoundaryAt()) &&
                gap <=
                uint256(LibVaipakam.REWARD_CLAIM_NOTICE_MAX_OBS_GAP_DAYS) *
                    1 days
            ) {
                elapsed += gap;
            }
        }
        uint256 required = hSec +
            uint256(LibVaipakam.REWARD_CLAIM_HORIZON_NOTICE_DAYS) * 1 days;
        uint256 remaining = required > elapsed ? required - elapsed : 0;
        expiresAt = uint64(block.timestamp + remaining);
    }

    /// @dev RL-3 — a view-side mirror of the sweep's CLAIM-executable gate,
    ///      used only by {rewardEntryExpiry} to decide whether a sweep-now
    ///      would credit the pending heartbeat interval. Mirrors
    ///      {sweepExpiredEntry}'s accrual gate exactly: the accumulator
    ///      advances only while the CLAIMANT could claim the entry now —
    ///      mirroring the sweep gate exactly: the entry's own pool-capped share
    ///      is payable, the owner is unsanctioned, the protocol is unpaused,
    ///      and the local balance covers the user's FULL aggregate claim (the
    ///      claim is atomic across all their entries + the legacy window).
    ///      Backing room is deliberately NOT checked here: it gates the
    ///      all-or-nothing EXPIRY credit, not the claimant's clock (a claim
    ///      never touches the bucket), so a backing shortfall does not pause
    ///      accrual — it only defers the final reap, which the view reflects
    ///      as the estimate caveat documented on {rewardEntryExpiry}.
    function _entryExecutableNow(
        LibVaipakam.Storage storage s,
        uint256 id,
        LibVaipakam.RewardEntry storage e
    ) private view returns (bool) {
        if (LibVaipakam.isSanctionedAddress(e.user)) return false;
        if (LibPausable.paused()) return false; // every claim reverts paused
        if (_recycledDrought(s, e.user)) return false; // clock pauses (r6)
        (EntrySplit memory toUser, , , ) = _entryPriceCore(s, id, e);
        if (_poolCappedPayable(toUser) == 0) return false; // nothing to pay
        // Codex #1699 r3 P2 — the SAME delivered predicate the sweep applies.
        //
        // This view mirrors the authoritative clock, so when the two disagree
        // the countdown lies: with balance, bucket and pool cap all ample it
        // would fold the pending interval and report an imminent expiry that a
        // sweep in the same block discards as non-executable. That is the
        // preview-versus-claim divergence this slice already closed once, in
        // its countdown form.
        //
        // Deliberately the AGGREGATE need (`_userArmedFreshNeed`), matching
        // the sweep exactly — a per-entry figure here would re-open the very
        // gap the sweep's fix closed, one abstraction layer away.
        if (LibVaipakam.isMirrorRewardChain(s)) {
            uint256 armedNeed = _userArmedFreshNeed(s, e.user);
            if (armedNeed != 0 && armedNeed > deliveredFreshBound(s)) {
                return false;
            }
        }
        return
            IERC20Metadata(s.vpfiToken).balanceOf(address(this)) >=
            _userClaimFundingNeedView(s, e.user);
    }

    /// @dev #1351 slice 2d-0 — the ONE computation of an entry's claim-payable
    ///      right now: the core-priced USER split with its fresh share
    ///      truncated to the remaining 69M pool headroom ({poolRemaining});
    ///      the recycled share passes through untruncated because the bucket
    ///      is a real held balance, not schedule headroom. Shared by the
    ///      expiry accrual gate ({sweepExpiredEntry}) and its view mirror
    ///      ({_entryExecutableNow}) so the two cannot drift. Feeding it the
    ///      core's `toUser` (post-loan-side-cap) rather than the raw window
    ///      split means the gate tests what a claim would ACTUALLY pay — a
    ///      capped-off share must not keep an expiry clock running on value
    ///      no claim will ever move (dark until `D*` arms; identical to the
    ///      raw split on every current deploy).
    /// @dev Codex #1410 r4+r6 — the recycled-bucket DROUGHT gate, AGGREGATE
    ///      by construction: the walk's recycled check is all-or-nothing per
    ///      day against the user's JOINT set, so per-entry bucket checks pass
    ///      individually while the combined draw still defers the day and the
    ///      claim reverts. When the user's aggregate remaining recycled
    ///      exceeds the live bucket, at least one of their days will defer
    ///      and an O(1) gate cannot tell which value survives — so the expiry
    ///      clock pauses outright. Over-pausing only DELAYS the reap
    ///      (claimant-protective; the claim path stays open and each partial
    ///      collection shrinks the aggregate until the gate unpauses).
    function _recycledDrought(
        LibVaipakam.Storage storage s,
        address user
    ) private view returns (bool) {
        (, uint256 recycledTotal) = _userEntriesUpperBound(s, user);
        return recycledTotal > s.recycleBucket;
    }

    function _poolCappedPayable(
        EntrySplit memory toUser
    ) private view returns (uint256) {
        uint256 freshShare = toUser.total - toUser.recycled;
        uint256 room = poolRemaining();
        return (freshShare < room ? freshShare : room) + toUser.recycled;
    }

    /// @dev View mirror of {userClaimFundingNeed}'s funding formula, WITHOUT
    ///      the cursor advance a view can't perform. Used by the countdown
    ///      estimate so it applies the SAME forfeit-credit backing the sweep
    ///      does (`payout + recycleBucket + forfeitFresh` when the user has
    ///      forfeited entries) — otherwise the view would show an imminent
    ///      expiry for an unbacked-forfeit user whose claim actually reverts
    ///      and whom the sweep will not accrue (Codex #1317 r4). It stays
    ///      optimistic ONLY on the axis a view genuinely cannot resolve: an
    ///      unadvanced entry reads behind (0), matching the documented
    ///      conservative-estimate caveat on {rewardEntryExpiry}.
    ///
    ///      KNOWN DIVERGENCE from the #1460 claim-time backing gate, tracked
    ///      as #1499 and NOT patched here. The claim now refuses a
    ///      payout whose fresh part exceeds `balance - recycleBucket`, while
    ///      this predicate tests the balance without netting off the
    ///      earmark — so on a thin deployment the horizon can call an entry
    ///      executable that the claim refuses. It is INERT today: the sweep
    ///      returns early while `rewardClaimHorizonDays == 0` (the deploy
    ///      default — RL-3 shipped dark), so no clock accrues and nothing
    ///      expires. Aligning the two is a shared-derivation change plus a
    ///      property-test matrix over the fresh / recycled / loan-side-cap /
    ///      forfeit combinations, because THREE sites re-derive this split
    ///      by hand and three successive attempts to hand-align them inside
    ///      #1497 were each subtly wrong (raw-vs-post-cap recycled, and
    ///      double-counting the bucket against the recycled payout). It is
    ///      therefore a precondition on ARMING the RL-3 horizon, not a
    ///      prerequisite of the claim-time gate.
    function _userClaimFundingNeedView(
        LibVaipakam.Storage storage s,
        address user
    ) private view returns (uint256 need) {
        uint256 payout = userClaimPendingUncapped(s, user);
        uint256 forfeitFresh = _userForfeitFresh(s, user);
        need = forfeitFresh == 0
            ? payout
            : payout + s.recycleBucket + forfeitFresh;
    }

    /// @dev PR-3c — accumulate `part` into `acc` (memory fold helper).
    function _foldSplit(
        EntrySplit memory acc,
        EntrySplit memory part
    ) private pure {
        acc.total += part.total;
        acc.recycled += part.recycled;
        acc.armedFresh += part.armedFresh;
    }

    /// @notice PR-3c — retire armed FRESH commitments consumed by a
    ///         claim/forfeit/remit (floored at zero: bounded ceil-dust can
    ///         make consumption exceed the recorded commitment by wei).
    function consumeArmedFresh(uint256 amount) internal {
        if (amount == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 outstanding = s.outstandingCommitFresh;
        s.outstandingCommitFresh =
            outstanding > amount ? outstanding - amount : 0;
    }

    /// @notice #1222 M3 B2-d2 — re-add armed FRESH commitments a released
    ///         remit reservation had retired at send: the reservation's days
    ///         re-open for funding, so their obligation exists again and the
    ///         re-remit's {consumeArmedFresh} must have something to retire —
    ///         otherwise the floored decrement silently under-states
    ///         `outstandingCommitFresh` after a release/re-remit cycle.
    function restoreArmedFresh(uint256 amount) internal {
        if (amount == 0) return;
        LibVaipakam.storageSlot().outstandingCommitFresh += amount;
    }

    /// @dev #1061 P1 — an entry destined for treasury: an explicit forfeit set
    ///      by `_closeEntry`, OR a terminal-derived liquidation/default forfeit.
    function _isForfeited(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardEntry storage e
    ) private view returns (bool) {
        return e.forfeited || _entryTerminalForfeit(s, e);
    }

    // ─── Legacy window claim (used by test mutators) ────────────────────────

    /**
     * @notice [LEGACY] Walk finalized days in `[fromDay .. toDayInclusive]`
     *         and accumulate `user`'s VPFI reward from the per-day
     *         counter API. Deletes per-user per-day counters as it goes
     *         so the claim is idempotent. Coexists with the new entry
     *         claim path — the facet sums both.
     */
    function claimForUserWindow(
        address user,
        uint256 fromDay,
        uint256 toDayInclusive
    ) internal returns (uint256 total) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 capRatio = LibVaipakam.getInteractionCapVpfiPerEth();
        (uint256 ethPriceRaw, uint8 ethPriceDec) = _ethUsdPriceRawAndDec();
        for (uint256 d = fromDay; d <= toDayInclusive; ) {
            // #1353 (M2 PR-5c) — an armed (post-`D*`) day pays via the ShareOfPool
            // ENTRY path only; the legacy per-day window must NEVER pay on an
            // armed day — it would double-pay atop the entry path, and #1008 is
            // retired there ({snapshotDayCapThreshold}). Clear any residual /
            // fabricated legacy counter without crediting (Codex #1371 r4).
            if (_isArmedDay(s, d)) {
                delete s.userLenderInterestNumeraire18[d][user];
                delete s.userBorrowerInterestNumeraire18[d][user];
                unchecked { ++d; }
                continue;
            }
            uint256 half = halfPoolForDay(d);
            if (half > 0) {
                (uint256 totalL, uint256 totalB) = _denominatorsForDay(s, d);
                uint256 myL = s.userLenderInterestNumeraire18[d][user];
                if (myL > 0 && totalL > 0) {
                    uint256 raw = (half * myL) / totalL;
                    uint256 cap = _capVpfiForInterestUsd(
                        myL,
                        ethPriceRaw,
                        ethPriceDec,
                        capRatio
                    );
                    total += raw < cap ? raw : cap;
                    delete s.userLenderInterestNumeraire18[d][user];
                }
                uint256 myB = s.userBorrowerInterestNumeraire18[d][user];
                if (myB > 0 && totalB > 0) {
                    uint256 raw = (half * myB) / totalB;
                    uint256 cap = _capVpfiForInterestUsd(
                        myB,
                        ethPriceRaw,
                        ethPriceDec,
                        capRatio
                    );
                    total += raw < cap ? raw : cap;
                    delete s.userBorrowerInterestNumeraire18[d][user];
                }
            }
            unchecked { ++d; }
        }
    }

    /// @notice [LEGACY] View-only preview of {claimForUserWindow}.
    function previewForUserWindow(
        address user,
        uint256 fromDay,
        uint256 toDayInclusive
    ) internal view returns (uint256 total) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 capRatio = LibVaipakam.getInteractionCapVpfiPerEth();
        (uint256 ethPriceRaw, uint8 ethPriceDec) = _ethUsdPriceRawAndDec();
        for (uint256 d = fromDay; d <= toDayInclusive; ) {
            // #1353 (M2 PR-5c) — mirror {claimForUserWindow}: an armed (post-`D*`)
            // day never pays via the legacy window (ShareOfPool entry path only),
            // so the preview must not credit it either (Codex #1371 r4).
            if (_isArmedDay(s, d)) { unchecked { ++d; } continue; }
            uint256 half = halfPoolForDay(d);
            if (half > 0) {
                (uint256 totalL, uint256 totalB) = _denominatorsForDay(s, d);
                uint256 myL = s.userLenderInterestNumeraire18[d][user];
                if (myL > 0 && totalL > 0) {
                    uint256 raw = (half * myL) / totalL;
                    uint256 cap = _capVpfiForInterestUsd(
                        myL,
                        ethPriceRaw,
                        ethPriceDec,
                        capRatio
                    );
                    total += raw < cap ? raw : cap;
                }
                uint256 myB = s.userBorrowerInterestNumeraire18[d][user];
                if (myB > 0 && totalB > 0) {
                    uint256 raw = (half * myB) / totalB;
                    uint256 cap = _capVpfiForInterestUsd(
                        myB,
                        ethPriceRaw,
                        ethPriceDec,
                        capRatio
                    );
                    total += raw < cap ? raw : cap;
                }
            }
            unchecked { ++d; }
        }
    }

    function _denominatorsForDay(
        LibVaipakam.Storage storage s,
        uint256 d
    ) private view returns (uint256 totalL, uint256 totalB) {
        return (
            s.knownGlobalLenderInterestNumeraire18[d],
            s.knownGlobalBorrowerInterestNumeraire18[d]
        );
    }

    /// @notice Truncate `[fromDay .. toDayInclusive]` to the longest
    ///         CONTIGUOUS prefix starting at `fromDay` for which the
    ///         cross-chain global denominator has landed here.
    function clampToFinalized(
        uint256 fromDay,
        uint256 toDayInclusive
    ) internal view returns (uint256 effectiveTo, bool any) {
        if (fromDay > toDayInclusive) return (0, false);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.knownGlobalSet[fromDay]) return (0, false);
        effectiveTo = fromDay;
        any = true;
        for (uint256 d = fromDay + 1; d <= toDayInclusive; ) {
            if (!s.knownGlobalSet[d]) break;
            effectiveTo = d;
            unchecked { ++d; }
        }
    }

    /// @notice Remaining VPFI reservable from the 69M interaction pool.
    /// @dev    #776 — reserves BOTH what Base has paid out locally
    ///         (`interactionPoolPaidOut`) AND what it has already remitted to
    ///         mirrors (`rewardBudgetRemittedGlobal`). The remitted VPFI is
    ///         earmarked for mirror-chain claims, so it must not be re-lent to
    ///         Base's own claimants — otherwise the two counters could jointly
    ///         over-issue past the global 69M cap. `rewardBudgetRemittedGlobal`
    ///         is Base-only (remittance is `onlyCanonical`), so on a mirror it
    ///         is 0 and this collapses to the plain `CAP − paidOut` bound.
    function poolRemaining() internal view returns (uint256) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 reserved = s.interactionPoolPaidOut + s.rewardBudgetRemittedGlobal;
        return
            LibVaipakam.VPFI_INTERACTION_POOL_CAP > reserved
                ? LibVaipakam.VPFI_INTERACTION_POOL_CAP - reserved
                : 0;
    }

    /// @notice #1434 P1-b — the MIRROR delivered-fresh bound: armed fresh
    ///         this chain has actually RECEIVED, less armed fresh it has
    ///         already PAID.
    /// @dev    Unbounded (`type(uint256).max`) on anything that is not a
    ///         mirror reward chain. Base funds its own armed days from the
    ///         69M cap directly — it receives no remittances, so an
    ///         unconditional bound here would read zero and BRICK Base
    ///         entirely. That scope control is what
    ///         `test_D4_CanonicalArmedDayPricesNormally` exists to hold.
    ///
    ///         SATURATING in both directions, and that is load-bearing
    ///         rather than defensive. The received side is NOT monotone:
    ///         it carries a saturating unwind for a released or
    ///         reclassified delivery, so `paid` can legitimately exceed
    ///         `received` after an unwind of value that was already paid
    ///         out. Reverting there would wedge the walk for every later
    ///         day — the failure mode the withdrawn B2-d4 attempt was
    ///         rejected for — so the bound floors at zero and the day
    ///         simply defers until fresh delivery restores headroom.
    function deliveredFreshBound(
        LibVaipakam.Storage storage s
    ) internal view returns (uint256) {
        if (!LibVaipakam.isMirrorRewardChain(s)) return type(uint256).max;
        uint256 received = s.rewardBudgetArmedFreshReceived;
        uint256 paid = s.rewardBudgetArmedFreshPaid;
        return received > paid ? received - paid : 0;
    }

    // ─── Internals ───────────────────────────────────────────────────────────

    /// @dev #1002 (S4) + Codex #1061 P1 — an entry may be routed (claimed or
    ///      swept) only once the loan is genuinely over. TWO independent
    ///      triggers, so no terminal path can strand a reward:
    ///        1. `e.closed` — the entry's window was explicitly finalized by
    ///           `closeLoan` (loan terminal) or `transferLenderEntry` (lender
    ///           sold — the loan may still be Active, but THIS entry is done).
    ///        2. the loan reached a TERMINAL status — covers terminal flows that
    ///           don't route through `closeLoan` (e.g. prepay-sale finalize), so
    ///           their rewards unlock on close instead of being frozen forever.
    ///      An Active / FallbackPending loan whose entry isn't closed pays
    ///      nothing (the S4 claim-while-open bug).
    function _entryClaimable(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardEntry storage e
    ) private view returns (bool) {
        if (e.closed) return true;
        LibVaipakam.LoanStatus st = s.loans[e.loanId].status;
        return st != LibVaipakam.LoanStatus.Active
            && st != LibVaipakam.LoanStatus.FallbackPending;
    }

    /// @dev #1061 P2 — for an entry made claimable by the loan-terminal fallback
    ///      (NOT explicitly closed), derive the forfeit from the terminal reason:
    ///      a Defaulted / InternalMatched (liquidation) loan forfeits the
    ///      BORROWER side (the loser), routing its reward to treasury; a clean
    ///      terminal (Repaid / Settled) and the lender side pay out. An
    ///      explicitly-closed entry already carries its `forfeited` decision from
    ///      `_closeEntry`, so this returns false for it (the caller ORs the two).
    function _entryTerminalForfeit(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardEntry storage e
    ) private view returns (bool) {
        if (e.closed) return false;
        LibVaipakam.LoanStatus st = s.loans[e.loanId].status;
        return (st == LibVaipakam.LoanStatus.Defaulted
            || st == LibVaipakam.LoanStatus.InternalMatched)
            && e.side == LibVaipakam.RewardSide.Borrower;
    }

    /// @dev The CLAIM-path entry settle. For an entry with no armed tail this
    ///      is the whole-window settle ({_processEntryWhole}); for a `D*`-
    ///      spanning entry it settles ONLY the pre-`D*` (legacy) slice —
    ///      derived O(1) from the regime-separation identity
    ///      `legacy = total − recycled − armedFresh` (pre-`D*` days contribute
    ///      0 to both the recycled and armed cumulatives) — and stamps
    ///      `rewardEntryClaimNextDay = D*` as the settlement record. The
    ///      ShareOfPool walk owns the armed days per-day from there and flips
    ///      `processed` when its cursor reaches `endDay`.
    ///
    ///      This split is DEFINITIONAL, not a caller-chosen mode (the parked
    ///      2c's `deferArmed` flag is deliberately not re-landed): the entry
    ///      path never pays an armed day, so the D1 `(user, side, day)` charge
    ///      and the loan-side cap — both armed-scoped — are entirely the
    ///      walk's business here. No cap stamp, no forfeit armed-day accrual:
    ///      {_persistDay} grows the day union per walked day.
    ///
    ///      The first cursor write happens ONLY here (legacy settled) or in
    ///      the walk of an entry with no legacy slice — which is why
    ///      {_shareOfPoolWorklist}'s `cursor != 0 || startDay >= D*`
    ///      eligibility is exact with no second marker.
    function _processEntry(
        LibVaipakam.Storage storage s,
        uint256 id
    )
        private
        returns (EntrySplit memory toUser, EntrySplit memory toTreasury)
    {
        LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
        if (e.processed) return (toUser, toTreasury);
        // #1434 (Codex #1699 r8 P1) — past the REMOVAL POINT. The expiry sweep
        // has already moved value from this entry into the recycle bucket, and
        // that is irreversible; paying the claimant from here would either
        // double-spend what was recycled or hand them a silently reduced
        // amount. `_beginExpiry` announced the removal, so this is the
        // documented "claim before removal wins" boundary, not a silent loss.
        if (e.expiryBegun) return (toUser, toTreasury);

        uint256 armedFrom = s.governorCommitArmedFromDay;
        if (armedFrom == 0 || e.endDay <= armedFrom) {
            // No armed tail — the whole window IS the legacy slice.
            return _processEntryWhole(s, id);
        }

        // Extend the cumulative RPN so pricing can see the window — BEFORE
        // any walk-ownership early return, because the day walk consumes the
        // rows this advance materializes: an entry the walk owns outright
        // still needs its days' RPN rows built here, exactly as the parked
        // 2c's defer path did. The whole-window `endDay - 1` need is
        // deliberately kept (not clipped to `D* - 1`): it reuses the ONE
        // pricing gate unchanged, and costs only the finalization lag of the
        // armed tail — the walk could not run before those days finalize
        // anyway. May not reach `need` if the globals are not finalized yet —
        // the core then prices 0 and the entry stays retryable, unstamped,
        // and walk-ineligible.
        if (_entryClaimable(s, e) && e.startDay < e.endDay) {
            uint256 need = e.endDay - 1;
            if (e.side == LibVaipakam.RewardSide.Lender) {
                if (s.cumLenderCursor < need) advanceCumLenderThrough(need);
            } else {
                if (s.cumBorrowerCursor < need) advanceCumBorrowerThrough(need);
            }
        }

        if (s.rewardEntryClaimNextDay[id] != 0 || e.startDay >= armedFrom) {
            // Legacy slice already settled (cursor written), or the entry has
            // no legacy slice at all — the walk owns everything that remains.
            return (toUser, toTreasury);
        }

        EntryPriceState memory st;
        (, , , st) = _entryPriceCore(s, id, e);
        if (!st.priced) {
            // A zero-value window will never pay on either regime — retire it.
            if (st.emptyWindow) e.processed = true;
            return (toUser, toTreasury);
        }

        // The legacy slice is ALL fresh by the regime identity.
        uint256 legacy =
            st.rawSplit.total - st.rawSplit.recycled - st.rawSplit.armedFresh;
        if (st.forfeit) {
            toTreasury.total = legacy;
        } else {
            toUser.total = legacy;
        }
        // Settlement record: the walk starts at `D*`. NOT `processed` — the
        // armed tail is still owed.
        s.rewardEntryClaimNextDay[id] = SafeCast.toUint64(armedFrom);
    }

    /// @dev The WHOLE-WINDOW entry settle: flips `processed = true` and
    ///      returns the routed amounts. Used directly by the loan-close
    ///      forfeit sweeps ({closeLoanEntries} / the orphaned-forfeit sweep),
    ///      which settle a forfeited entry's full window O(1) at terminal —
    ///      deferring a defaulted counterparty's armed days to a claim walk
    ///      they will never run would strand them. The armed forfeit
    ///      deliberately bypasses the D1 day charge here: it is a treasury
    ///      reclaim, not user extraction, so skipping the charge only leaves
    ///      the user MORE of their own daily ceiling — leniency, not a
    ///      bypass.
    function _processEntryWhole(
        LibVaipakam.Storage storage s,
        uint256 id
    )
        private
        returns (EntrySplit memory toUser, EntrySplit memory toTreasury)
    {
        LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
        if (e.processed) return (toUser, toTreasury);

        // The ONE write a view caller cannot make, and the only reason this is
        // a wrapper rather than a mode flag on {_entryPriceCore}: extend the
        // cumulative RPN so the core can price the whole window. May not reach
        // `need` if the globals are not finalized yet — the core then prices 0
        // and the entry stays retryable.
        if (_entryClaimable(s, e) && e.startDay < e.endDay) {
            uint256 need = e.endDay - 1;
            if (e.side == LibVaipakam.RewardSide.Lender) {
                if (s.cumLenderCursor < need) advanceCumLenderThrough(need);
            } else {
                if (s.cumBorrowerCursor < need) advanceCumBorrowerThrough(need);
            }
        }

        LoanSideCapCharge memory c;
        EntryPriceState memory st;
        (toUser, toTreasury, c, st) = _entryPriceCore(s, id, e);

        if (!st.priced) {
            // An empty or zero-value window will never pay — retire it so it
            // stops being rescanned. A cursor-behind entry is NOT retired: it
            // can still pay once the globals finalize.
            if (st.emptyWindow) e.processed = true;
            return (toUser, toTreasury);
        }

        e.processed = true;
        if (st.forfeit) {
            _accrueForfeitArmedDays(s, id, e, st.rawSplit);
            return (toUser, toTreasury);
        }
        if (c.stamped) {
            uint8 sideW = uint8(e.side);
            s.loanSideRewardedDays[e.loanId][sideW] = c.daysIncl;
            s.loanSideRewardPaidVpfi[e.loanId][sideW] = c.newPaid;
        }
    }

    /// @dev PR-3c — compute an entry window's capped reward decomposition
    ///      from the three cumulative series. Mixed pre/post-cutover
    ///      windows slice correctly by construction: pre-arming days
    ///      contribute 0 to both the recycled and armed cumulatives
    ///      (the redesign's D* day-slicing rule with no per-day loop).
    function _entryWindowSplitFrom(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardEntry storage e,
        uint256 fromDay
    ) private view returns (EntrySplit memory split) {
        uint256 cumEnd;
        uint256 cumStart;
        uint256 cumRecEnd;
        uint256 cumRecStart;
        uint256 cumArmEnd;
        uint256 cumArmStart;
        uint256 endD = e.endDay - 1;
        bool hasStart = fromDay != 0;
        if (e.side == LibVaipakam.RewardSide.Lender) {
            cumEnd = s.cumMinLenderRpn18[endD];
            cumStart = hasStart ? s.cumMinLenderRpn18[fromDay - 1] : 0;
            cumRecEnd = s.cumMinRecycledLenderRpn18[endD];
            cumRecStart =
                hasStart ? s.cumMinRecycledLenderRpn18[fromDay - 1] : 0;
            cumArmEnd = s.cumMinArmedLenderRpn18[endD];
            cumArmStart =
                hasStart ? s.cumMinArmedLenderRpn18[fromDay - 1] : 0;
        } else {
            cumEnd = s.cumMinBorrowerRpn18[endD];
            cumStart = hasStart ? s.cumMinBorrowerRpn18[fromDay - 1] : 0;
            cumRecEnd = s.cumMinRecycledBorrowerRpn18[endD];
            cumRecStart =
                hasStart ? s.cumMinRecycledBorrowerRpn18[fromDay - 1] : 0;
            cumArmEnd = s.cumMinArmedBorrowerRpn18[endD];
            cumArmStart =
                hasStart ? s.cumMinArmedBorrowerRpn18[fromDay - 1] : 0;
        }
        if (cumEnd <= cumStart) return split;

        split.total = (e.perDayNumeraire18 * (cumEnd - cumStart)) / 1e18;
        uint256 recycled = cumRecEnd > cumRecStart
            ? (e.perDayNumeraire18 * (cumRecEnd - cumRecStart)) / 1e18
            : 0;
        uint256 armedCombined = cumArmEnd > cumArmStart
            ? (e.perDayNumeraire18 * (cumArmEnd - cumArmStart)) / 1e18
            : 0;
        // Rounding safety chain: recycled ≤ armedCombined ≤ total holds in
        // exact arithmetic; clamp against 1-wei division dust so the
        // subtraction-derived fresh shares can never underflow.
        if (armedCombined > split.total) armedCombined = split.total;
        if (recycled > armedCombined) recycled = armedCombined;
        split.recycled = recycled;
        split.armedFresh = armedCombined - recycled;
    }

    /// @dev #1351 slice 2d-0 — THE entry pricing arithmetic AND its routing.
    ///      One implementation, read by both the settling claim
    ///      ({_processEntry}) and the read-only preview ({_previewEntryReward}).
    ///
    ///      Deliberately NOT "one function with a DryRun/Settle flag": the two
    ///      callers differ in something a runtime flag cannot express — the
    ///      claim ADVANCES the cumulative cursor to reach `endDay - 1`, and a
    ///      `view` preview is forbidden from writing at all. So the split is
    ///      view-core + settle-wrapper: the wrapper advances the cursor and
    ///      persists, the core computes and routes. Everything downstream of
    ///      the cursor — the claimability gate, the window split, the forfeit
    ///      routing, the loan-side cap — is shared, so a preview cannot promise
    ///      what a claim will not pay.
    ///
    ///      The cursor difference stays visible and intended: on a finalized day
    ///      the claim has not advanced through yet, the core prices 0 for a view
    ///      caller. It UNDER-reports, never over-reports (#1147 r8 L3).
    /// @return toUser      What the user is owed (0 for a forfeit).
    /// @return toTreasury  The forfeit's whole split, or the capped-off recycled
    ///                     of a capped user split — both routed to treasury.
    /// @return c           What a settling caller persists for the loan-side
    ///                     cap. `stamped == false` ⇒ nothing to persist.
    /// @return st          Which settle-only side effects apply.
    struct EntryPriceState {
        bool priced;         // a split was produced
        bool emptyWindow;    // settle marks `processed`: nothing will ever pay
        bool forfeit;        // routed to treasury, and NOT loan-side capped
        EntrySplit rawSplit; // pre-cap split, needed by the forfeit day accrual
    }

    function _entryPriceCore(
        LibVaipakam.Storage storage s,
        uint256 id,
        LibVaipakam.RewardEntry storage e
    )
        private
        view
        returns (
            EntrySplit memory toUser,
            EntrySplit memory toTreasury,
            LoanSideCapCharge memory c,
            EntryPriceState memory st
        )
    {
        // #1002 (S4) — claimable only once the loan is actually over, not
        // merely because the calendar passed maturity.
        if (!_entryClaimable(s, e)) return (toUser, toTreasury, c, st);
        if (e.startDay >= e.endDay) {
            st.emptyWindow = true;
            return (toUser, toTreasury, c, st);
        }
        // The cumulative RPN must be populated through `endDay - 1`. A settling
        // caller advances it first; a view caller cannot, and prices 0.
        uint256 need = e.endDay - 1;
        if (
            e.side == LibVaipakam.RewardSide.Lender
                ? s.cumLenderCursor < need
                : s.cumBorrowerCursor < need
        ) return (toUser, toTreasury, c, st);

        // #1351 slice 2d — the core prices the REMAINING window. A stamped
        // claim cursor means everything before it has been settled — the
        // legacy slice by the entry path, walked armed days by the day walk —
        // so pricing from the cursor makes every consumer (sweep, close-path
        // settle, preview, funding need) exact for a part-claimed entry with
        // no per-entry paid ledger and no second marker. With the cursor
        // unset this is the whole window, byte-identical to the pre-2d
        // behaviour (and to every current deploy — nothing writes the cursor
        // while `D*` is unarmed).
        //
        // #1008 (S13, Option B) — the CAPPED cumulative, so the §4 daily cap is
        // applied per day (baked at finalization) while this stays O(1).
        // PR-3c — mixed pre/post-cutover windows slice by construction:
        // pre-arming days contribute 0 to the recycled + armed cumulatives.
        uint256 from = s.rewardEntryClaimNextDay[id];
        if (from == 0) from = e.startDay;
        EntrySplit memory split = _entryWindowSplitFrom(s, e, from);
        if (split.total == 0) {
            st.emptyWindow = true;
            return (toUser, toTreasury, c, st);
        }
        st.priced = true;
        st.rawSplit = split;

        // #1061 P2 — route to treasury on an explicit forfeit OR a terminal
        // forfeit derived from an unclosed liquidation/default, so a liquidated
        // borrower cannot collect via the loan-terminal claimability fallback.
        if (e.forfeited || _entryTerminalForfeit(s, e)) {
            // #1353 (M2 PR-5c) — the loan-side cap bounds reward PAID TO A USER,
            // never a forfeit: a forfeit recycles to the bucket rather than being
            // emitted to the side, so it is not trimmed (Codex #1371 r2). Its
            // armed days still join the per-(loanId, side) union — the settle
            // wrapper accrues them.
            st.forfeit = true;
            toTreasury = split;
            return (toUser, toTreasury, c, st);
        }
        (toUser, toTreasury, c) = _loanSideCapCompute(s, id, e, split);
    }

    /// @dev Read-only entry pricing — {_entryPriceCore} with no writes at all.
    ///      As a view it cannot advance the cursor, so on a finalized day the
    ///      claim has not yet advanced through it returns 0: it UNDER-reports,
    ///      never over-reports (#1147 r8 L3).
    ///
    ///      Matching the claim is load-bearing — the expiry funding gate reads
    ///      this via {userClaimFundingNeed}, and a preview that diverged could
    ///      advance the expiry clock on a reward the claim would not actually
    ///      pay (Codex #1371 r2). It now matches BY CONSTRUCTION rather than by
    ///      keeping a second implementation in step.
    function _previewEntryReward(
        LibVaipakam.Storage storage s,
        uint256 id,
        LibVaipakam.RewardEntry storage e
    ) private view returns (uint256 reward) {
        (EntrySplit memory toUser, , , ) = _entryPriceCore(s, id, e);
        return toUser.total;
    }

    // ─── #1353 (M2 PR-5c) — loan-side interaction-reward cap ─────────────────
    //
    // Replaces the #1008 per-entry ETH-ratio cap on POST-cutover reward days.
    // The ceiling is a per-(loanId, side) LIFETIME budget derived from the Full
    // tariff's notional `C*` stamped at open:
    //
    //     loanSideRewardCapOpen = ½ × C* × (BPS − m_reward) / BPS   (at open)
    //     loanSideRewardCapEff  = loanSideRewardCapOpen
    //                             × min(cumulativeRewardedDays, openDays)
    //                             / openDays                        (at claim)
    //
    // and `Σ paid ≤ loanSideRewardCapEff` per side. The proration makes an
    // early-closed loan (few rewarded days) earn proportionally less; a lender
    // sale splits the entry but the day union / paid budget are SHARED across
    // both halves (rev 15 §F6b). ALL of this is gated on `_isArmedDay` (the
    // ShareOfPool arming = D*), unarmed on every current deploy ⇒ DARK.
    //
    // The cap governs an entry's WHOLE ARMED (post-`D*`) reward —
    // `armedFresh + recycled`, both of which accrue solely on armed days
    // (`cumMinArmed` / `cumMinRecycled` are 0 on pre-arming days) — because the
    // ceiling `½ × C* × (1 − m)` bounds the TOTAL post-cutover per-side payout,
    // not just its fresh half (Codex #1371 r7). It deliberately does NOT touch:
    //   • the PRE-`D*` fresh reward (`total − recycled − armedFresh`) — that
    //     slice stays under the #1008 regime (Codex #1371 r1: spanning entries).
    // The capped-off amount is PARTITIONED by funding source so each commitment
    // is retired exactly once and nothing is double-paid or leaked:
    //   • capped-off FRESH — `armedFresh` stays WHOLE on the user split so the
    //     facet retires the full fresh commitment (`consumeArmedFresh`) while the
    //     payout shrinks; the remainder is "gone for good" like a pool-truncated
    //     fresh share (retired, not paid);
    //   • capped-off RECYCLED — routed out as a `recycleRelease` split so the
    //     facet RELEASES its commitment (`releaseCommitment`): no payout AND no
    //     bucket credit / `Ā` inflation, hence no expiry-funding-gate ripple.
    // The cap applies to reward PAID TO A USER only — never a forfeit or an
    // expiry credit, which recycle to the bucket rather than emit to the side
    // (a forfeit's armed days still count toward the day union — Codex #1371 r7).
    // An UNSTAMPED loan (`openDays == 0` — a mirror-chain, dark-era, or
    // pre-cutover loan) is NOT reward-ineligible here: the cap does not apply so
    // it earns normally (Codex #1371 r1 P1 ×2). A STAMPED loan (the stamp always
    // writes `openDays >= 1`) whose `cStarOpen` / `loanSideRewardCapOpen` merely
    // round to 0 (a genuinely-priced dust `C*`) IS capped — to ~0 — since the
    // stamp is present (Codex #1371 r2/r5 P1/P2). TRUE reward-ineligibility (a
    // canonical feed-fail origination) is enforced UPSTREAM by not creating
    // reward entries at all (rev 15 §F6b), never here.

    /// @dev Armed (post-`D*`) rewarded-day count an entry contributes to its
    ///      loanId+side union — `[max(startDay, D*), endDay-1]`. Only these days
    ///      carry loan-side-capped reward; the pre-`D*` slice stays on #1008.
    ///      Entries for a loanId+side are adjacent + non-overlapping (a sale
    ///      split ends the old window where the new one begins), so the armed
    ///      union is the sum of armed sub-window lengths.
    function _entryArmedDays(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardEntry storage e
    ) private view returns (uint256) {
        uint256 armedFrom = s.governorCommitArmedFromDay; // D*; 0 ⇒ unarmed
        uint256 start = e.startDay == 0 ? 1 : e.startDay;
        uint256 firstArmed = start > armedFrom ? start : armedFrom;
        return e.endDay > firstArmed ? e.endDay - firstArmed : 0;
    }

    /// @dev Slice 2d — {_entryArmedDays} for the entry's REMAINING window: the
    ///      armed days at or past the claim cursor. Equal to the whole count
    ///      while the cursor is unset.
    function _entryArmedDaysFrom(
        LibVaipakam.Storage storage s,
        uint256 id,
        LibVaipakam.RewardEntry storage e
    ) private view returns (uint256) {
        uint256 armedFrom = s.governorCommitArmedFromDay; // D*; 0 ⇒ unarmed
        uint256 cursor = s.rewardEntryClaimNextDay[id];
        uint256 start = cursor != 0
            ? cursor
            : (e.startDay == 0 ? 1 : e.startDay);
        uint256 firstArmed = start > armedFrom ? start : armedFrom;
        return e.endDay > firstArmed ? e.endDay - firstArmed : 0;
    }

    /// @dev #1353 (M2 PR-5c) — accrue a FORFEITED entry's armed days into the
    ///      per-(loanId, side) day union (a forfeit is not paid to the side and
    ///      never consumes the paid budget, but its window is part of the loan's
    ///      rewarded age — so the incoming lender's proration after a mid-loan
    ///      sale reflects old + new windows, not just its residual days; Codex
    ///      #1371 r7). Same STAMP/armed guards as {_applyLoanSideCap}.
    function _accrueForfeitArmedDays(
        LibVaipakam.Storage storage s,
        uint256 id,
        LibVaipakam.RewardEntry storage e,
        EntrySplit memory split
    ) private {
        if (split.armedFresh + split.recycled == 0) return; // no armed reward
        uint256 loanId = e.loanId;
        if (s.feeEntitlementByLoanId[loanId].openDays == 0) return; // unstamped
        uint8 side = uint8(e.side);
        // Slice 2d — only the REMAINING armed days: each day the walk already
        // settled grew the union by 1 in {_persistDay}, so accruing the whole
        // window here would double-count them in the proration denominator.
        s.loanSideRewardedDays[loanId][side] += _entryArmedDaysFrom(s, id, e);
    }

    /// @dev Effective per-side lifetime reward ceiling for `loanId` once
    ///      `rewardedDaysIncl` armed reward-eligible days have been credited.
    ///      Reads the at-open cache (`loanSideRewardCapOpen` / `openDays`), never
    ///      the live cfg. A `capOpen == 0` on a STAMPED loan (dust `C*`) yields a
    ///      0 ceiling here — the intended near-zero cap, distinct from the
    ///      unstamped skip the callers gate on `openDays == 0`.
    function _loanSideRewardCapEff(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        uint256 rewardedDaysIncl
    ) private view returns (uint256) {
        LibVaipakam.FeeEntitlement storage fe = s.feeEntitlementByLoanId[loanId];
        uint256 capOpen = fe.loanSideRewardCapOpen;
        if (capOpen == 0 && fe.cStarOpen != 0) {
            // #1353 (M2 PR-5c) — LAZY BACKFILL: a record STAMPED before the cap
            // cache existed (an in-place upgrade from #1347, where
            // `loanSideRewardCapOpen` was an appended slot reading 0) still has a
            // real `cStarOpen`. Derive the ceiling from it (rev-15 "recompute
            // only as a consistency check") so the legacy loan is capped at its
            // true fee-linked ceiling rather than treated as a real zero (Codex
            // #1371 r6). A genuine dust record (`cStarOpen == 0`) keeps a 0
            // ceiling (capped to ~0).
            // A legacy record also predates `rewardHaircutBpsAtOpen`, so that
            // field reads 0 even though no party selected a literal 0% haircut;
            // fall back to the {REWARD_HAIRCUT_DEFAULT_BPS} default (matching
            // {cfgRewardHaircutBps}'s zero-sentinel) so the derived ceiling is
            // `½ × C* × (1 − default)`, not the too-generous `½ × C*` (Codex
            // #1371 r7).
            uint256 haircut = fe.rewardHaircutBpsAtOpen;
            if (haircut == 0) haircut = LibVaipakam.REWARD_HAIRCUT_DEFAULT_BPS;
            // `Math.mulDiv` so an extreme `cStarOpen` can't overflow the
            // intermediate product (Codex #1371 r10), matching the stamp site.
            capOpen =
                Math.mulDiv(
                    fe.cStarOpen,
                    LibVaipakam.BASIS_POINTS - haircut,
                    LibVaipakam.BASIS_POINTS
                ) / 2;
        }
        if (capOpen == 0) return 0;
        uint256 openDays = fe.openDays;
        if (openDays == 0) return capOpen; // defensive; stamp guarantees ≥ 1
        uint256 daysCounted =
            rewardedDaysIncl < openDays ? rewardedDaysIncl : openDays;
        return (capOpen * daysCounted) / openDays;
    }

    /// @dev #1351 slice 2d-0 — the loan-side cap's ARITHMETIC, with no writes.
    ///      {_applyLoanSideCap} is this plus its two stores, and the preview
    ///      path reads it directly. One implementation, so a preview cannot
    ///      promise what a claim will not pay: the guarantee the preview's
    ///      natspec calls load-bearing now holds by construction rather than by
    ///      keeping a hand-mirrored copy in step.
    /// @return userSplit      What the user is paid, trimmed to the cap.
    /// @return recycleRelease Capped-off recycled, routed out as a pure
    ///                        commitment RELEASE (no payout, no bucket credit).
    /// @return c              What {_applyLoanSideCap} would persist.
    function _loanSideCapCompute(
        LibVaipakam.Storage storage s,
        uint256 id,
        LibVaipakam.RewardEntry storage e,
        EntrySplit memory split
    )
        private
        view
        returns (
            EntrySplit memory userSplit,
            EntrySplit memory recycleRelease,
            LoanSideCapCharge memory c
        )
    {
        // An explicit COPY, never `userSplit = split` — that would ALIAS the
        // caller's memory, and the trim below would silently rewrite the raw
        // split every consumer downstream of the core reads
        // ({EntryPriceState.rawSplit}). Latent while only the forfeit branch
        // (which never runs the cap) consumed the raw split; the legacy-slice
        // derivation in {_processEntry} reads it on the PAYABLE branch and
        // was shorted by exactly the capped-off amount.
        userSplit = EntrySplit({
            total: split.total,
            recycled: split.recycled,
            armedFresh: split.armedFresh
        });
        uint256 armedReward = split.armedFresh + split.recycled; // post-`D*` reward
        if (armedReward == 0) return (userSplit, recycleRelease, c); // pre-cutover ⇒ dark
        uint256 loanId = e.loanId;
        // The STAMP marker is `openDays != 0` — the stamp always writes
        // `openDays >= 1`, whereas a genuinely-priced dust loan can have BOTH
        // `cStarOpen` and `loanSideRewardCapOpen` round to 0, so keying the skip
        // on `cStarOpen == 0` would wrongly exempt such a stamped loan from the
        // cap (Codex #1371 r5). A stamped zero-`C*` loan therefore falls through
        // and is capped to ~0; only a truly missing stamp skips.
        if (s.feeEntitlementByLoanId[loanId].openDays == 0) {
            // Unstamped (mirror / dark-era / pre-cutover) ⇒ no loan-side cap here
            // (never zeroed — Codex #1371 r1). ARMING PRECONDITION (`cStar`
            // backfill gate): `D*` must not be armed while any reward-eligible
            // CANONICAL loan is unstamped, because #1008 also retires on armed
            // days ({snapshotDayCapThreshold}) and this skip would then leave it
            // uncapped (Codex #1371 r3). On a fresh (pre-live) deploy that holds
            // from genesis; a post-launch cutover backfills open loans first.
            // MIRROR-chain loans (never stamped) are bounded by the D1
            // (user, side, day) share cap on their local claim, not here. The
            // arming-time enforcement is a deploy-assert (PR-9 #1356) coupled
            // with the joint cutover.
            return (userSplit, recycleRelease, c);
        }
        uint8 side = uint8(e.side);
        // Slice 2d (Codex #1409 r1 P1) — the REMAINING armed days, matching
        // the remaining split being capped: each day the walk already settled
        // grew `loanSideRewardedDays` by 1 in {_persistDay}, so adding the
        // WHOLE armed window here would double-count the walked days in the
        // proration while the rewarded window is still below `openDays` —
        // inflating the effective ceiling the preview/expiry gates see (and,
        // via the whole-settle's absolute stamp, the persisted union).
        uint256 daysIncl =
            s.loanSideRewardedDays[loanId][side] + _entryArmedDaysFrom(s, id, e);
        // The armed-day union grows monotonically whether or not the split trims.
        c.stamped = true;
        c.daysIncl = daysIncl;
        uint256 capEff = _loanSideRewardCapEff(s, loanId, daysIncl);
        uint256 paid = s.loanSideRewardPaidVpfi[loanId][side];
        uint256 remaining = capEff > paid ? capEff - paid : 0;
        if (armedReward <= remaining) {
            c.newPaid = paid + armedReward;
            return (userSplit, recycleRelease, c); // nothing capped
        }
        c.newPaid = paid + remaining;
        // Pay fresh first, then recycled, up to `remaining`.
        uint256 paidArmedFresh =
            split.armedFresh <= remaining ? split.armedFresh : remaining;
        uint256 cappedRecycled = split.recycled - (remaining - paidArmedFresh);
        // userSplit keeps `armedFresh` WHOLE (full fresh-commitment retirement)
        // but pays only `paidArmedFresh` of it; `recycled` drops to the paid
        // amount; `total` sheds the capped-off fresh + recycled.
        userSplit.total =
            split.total - (split.armedFresh - paidArmedFresh) - cappedRecycled;
        userSplit.recycled = split.recycled - cappedRecycled;
        // The capped-off recycled routes to the treasury channel as a pure
        // RELEASE (recycled == total ⇒ the facet's `freshTreasury` is 0, so it
        // only releases the commitment and credits nothing).
        recycleRelease.total = cappedRecycled;
        recycleRelease.recycled = cappedRecycled;
    }

    /// @dev Allocate a fresh RewardEntry and push it into the user's
    ///      index. ids are 1-based so 0 can be used as "unset".
    function _allocEntry(
        LibVaipakam.Storage storage s,
        address user,
        uint256 loanId,
        uint256 startDay,
        uint256 endDay,
        LibVaipakam.RewardSide side,
        uint256 perDayNumeraire18
    ) private returns (uint256 id) {
        id = ++s.nextRewardEntryId;
        LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
        e.user = user;
        e.loanId = SafeCast.toUint64(loanId);
        e.startDay = SafeCast.toUint32(startDay);
        e.endDay = SafeCast.toUint32(endDay);
        e.side = side;
        e.perDayNumeraire18 = perDayNumeraire18;
        // processed/forfeited default to false
        s.userRewardEntryIds[user].push(id);
        // #1067 — O(1) membership index (1-based; 0 = absent).
        s.rewardEntryUserIdx[id] = s.userRewardEntryIds[user].length;
    }

    /// @dev Shrink `entry` to `[startDay, min(originalEnd, today+1))`,
    ///      un-stamping the original end-delta and stamping the shrunk
    ///      end-delta (only for future days — already-frontier-consumed
    ///      days cannot be retroactively changed).
    function _closeEntry(
        LibVaipakam.Storage storage /* s */,
        uint256 id,
        uint256 today,
        bool forfeited,
        mapping(uint256 => int256) storage deltas,
        uint256 frontier
    ) private {
        LibVaipakam.Storage storage s_ = LibVaipakam.storageSlot();
        LibVaipakam.RewardEntry storage e = s_.rewardEntries[id];
        // #1002 (S4) — idempotency guard: re-closing an already-closed entry
        // would double-apply the end-delta. (Replaces the dead `endDay == 0`
        // guard — `endDay` is never 0 in practice.)
        if (e.closed) return;
        uint256 originalEnd = e.endDay;
        uint256 newEnd = today + 1;
        if (newEnd >= originalEnd) newEnd = originalEnd; // natural close or late
        if (newEnd < e.startDay) newEnd = e.startDay;    // closed before accrual began

        if (newEnd != originalEnd) {
            uint256 perDay = e.perDayNumeraire18;
            _applyDelta(deltas, frontier, originalEnd, SafeCast.toInt256(perDay));
            _applyDelta(deltas, frontier, newEnd, -SafeCast.toInt256(perDay));
            e.endDay = SafeCast.toUint32(newEnd);
        }
        if (forfeited) e.forfeited = true;
        // #1002 (S4) — mark the entry terminally settled. This is the single
        // choke point for both {closeLoan} (loan terminal) and
        // {transferLenderEntry} (lender sold, loan continues — the OLD entry
        // closes here while a fresh open entry is allocated for the buyer), so
        // the `closed` gate in {_processEntry}/{_previewEntryReward} opens
        // exactly when the entry's window is done. {repointRewardEntry}
        // deliberately does NOT route through here — a re-pointed entry keeps
        // accruing (its loan is still open), so it stays `closed == false`.
        e.closed = true;
    }

    /// @dev Apply a signed delta to `deltas[day]` only when `day > frontier`.
    ///      Writing to a day that has already been consumed by the frontier
    ///      would not affect past totals; we drop the write in that case.
    ///      The loss in accuracy is bounded to retroactive closes, which
    ///      are rare (most closes happen at or before natural maturity,
    ///      which is always in the future of the reporter frontier).
    function _applyDelta(
        mapping(uint256 => int256) storage deltas,
        uint256 frontier,
        uint256 day,
        int256 change
    ) private {
        if (day <= frontier) return;
        deltas[day] += change;
    }

    /// @dev Compute per-day Numeraire18 interest for a loan at register time.
    ///      Annualized bps divided by 365; principal converted at
    ///      Chainlink spot. Returns 0 on any oracle / decimals failure
    ///      so {registerLoan} silently skips.
    function _perDayInterestNumeraire18(
        address asset,
        uint256 principal,
        uint256 interestRateBps
    ) private view returns (uint256) {
        if (asset == address(0) || principal == 0) return 0;

        uint256 price;
        uint8 feedDec;
        try OracleFacet(address(this)).getAssetPrice(asset) returns (
            uint256 p,
            uint8 d
        ) {
            price = p;
            feedDec = d;
        } catch {
            return 0;
        }
        if (price == 0) return 0;

        uint8 tokenDec;
        try IERC20Metadata(asset).decimals() returns (uint8 d) {
            tokenDec = d;
        } catch {
            return 0;
        }
        if (tokenDec == 0) return 0;

        // principalNumeraire18 = principal * price * 1e18 / (10^feedDec * 10^tokenDec)
        uint256 principalNumeraire18 =
            (principal * price * 1e18) /
            (10 ** feedDec) /
            (10 ** tokenDec);
        // perDayNumeraire18 = principalNumeraire18 * bps / BASIS_POINTS / 365
        return
            (principalNumeraire18 * interestRateBps) /
            LibVaipakam.BASIS_POINTS /
            365;
    }

    /// @dev Best-effort USD conversion at Chainlink spot (legacy).
    function _interestToNumeraire18(address feeAsset, uint256 interestAmount)
        private
        view
        returns (uint256)
    {
        if (feeAsset == address(0) || interestAmount == 0) return 0;

        uint256 price;
        uint8 feedDec;
        try OracleFacet(address(this)).getAssetPrice(feeAsset) returns (
            uint256 p,
            uint8 d
        ) {
            price = p;
            feedDec = d;
        } catch {
            return 0;
        }
        if (price == 0) return 0;

        uint8 tokenDec;
        try IERC20Metadata(feeAsset).decimals() returns (uint8 d) {
            tokenDec = d;
        } catch {
            return 0;
        }
        if (tokenDec == 0) return 0;

        return
            (interestAmount * price * 1e18) /
            (10 ** feedDec) /
            (10 ** tokenDec);
    }

    /// @dev Best-effort ETH/USD spot read used by the §4 per-user cap.
    function _ethUsdPriceRawAndDec()
        private
        view
        returns (uint256 price, uint8 feedDec)
    {
        address feed = LibVaipakam.storageSlot().ethNumeraireFeed;
        if (feed == address(0)) return (0, 0);

        int256 answer;
        try AggregatorV3Interface(feed).latestRoundData() returns (
            uint80,
            int256 a,
            uint256,
            uint256,
            uint80
        ) {
            answer = a;
        } catch {
            return (0, 0);
        }
        if (answer <= 0) return (0, 0);

        uint8 dec;
        try AggregatorV3Interface(feed).decimals() returns (uint8 d) {
            dec = d;
        } catch {
            return (0, 0);
        }
        // safe: `answer` is validated > 0 by the local `if (answer <= 0)
        // return (0, 0);` guard which runs immediately after the
        // `latestRoundData` try/catch — i.e. BEFORE the `decimals()`
        // try/catch — in `_ethUsdPriceRawAndDec` above this return.
        // forge-lint: disable-next-line(unsafe-typecast)
        return (uint256(answer), dec);
    }

    /// @dev VPFI-wei ceiling for a single (user, side, day) branch per
    ///      docs/TokenomicsTechSpec.md §4. Returns `type(uint256).max`
    ///      when the cap is disabled (ETH feed unavailable or admin
    ///      override == max sentinel).
    function _capVpfiForInterestUsd(
        uint256 interestNumeraire18,
        uint256 ethPriceRaw,
        uint8 feedDec,
        uint256 capRatio
    ) private pure returns (uint256 cap) {
        if (ethPriceRaw == 0 || capRatio == type(uint256).max) {
            return type(uint256).max;
        }
        return (interestNumeraire18 * (10 ** feedDec) * capRatio) / ethPriceRaw;
    }

    // ─── #1008 (S13, Option B) — finalize-time §4 cap threshold ─────────────

    /// @notice Snapshot + store the §4 daily-cap threshold for `dayId` at
    ///         finalization (Base). The value is broadcast so every mirror caps
    ///         identically — see {setBroadcastDayCapThreshold}. Because the §4
    ///         threshold is ENTRY-INDEPENDENT, one per-day value serves every
    ///         entry's claim AND the per-chain remittance.
    /// @return t The stored threshold (`type(uint256).max` = cap disabled).
    function snapshotDayCapThreshold(uint256 dayId) internal returns (uint256 t) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // #1353 (M2 PR-5c) — retire #1008 on ARMED (post-`D*`) days automatically:
        // an armed day is priced under the loan-side + D1 caps, so its legacy
        // ETH-ratio threshold is DISABLED (max) rather than left baked into
        // `cumMin`, which would stack the old cap under the new one and underpay
        // (Codex #1371 r1 P2). This is finalize-time on Base and broadcast to
        // mirrors, so every chain retires #1008 on the same days with no
        // operator step. Pre-arming days keep the computed #1008 threshold ⇒ dark.
        bool armed = _isArmedDay(s, dayId);
        t = armed ? type(uint256).max : _computeDayCapThreshold18();
        s.dayCapThreshold18[dayId] = t;

        // #1351 (M2 PR-2, slice 2a) — stamp the day's cap FAMILY in the SAME
        // write as the threshold. The atomicity is load-bearing: setting
        // `dayCapThreshold18 = max` (legacy cap disabled) without also marking
        // the day ShareOfPool would leave an armed day priced by NEITHER cap —
        // an uncapped hole. Claim/sweep fail closed on an armed day with no
        // mode, so the two must never be able to drift apart.
        //
        // Pre-arming days are left untouched: `CapMode.LegacyEthRatio` is the
        // zero value, so every historical day keeps its existing meaning with
        // no migration.
        // NOTE (#1351 slice 2a — BASE-ONLY so far): this stamp lands on the
        // CANONICAL finalize path only. The day broadcast still carries just the
        // legacy threshold + pool halves + `armedFromDay`, so a MIRROR has no
        // `dayCapMode` / `dayUserSideCapVpfi18` for post-`D*` days and would
        // fail closed (or miss the cap) once claim/sweep land there.
        //
        // Closing that is slice 2g (messenger `MSG_TYPE_BROADCAST_V2 = 5`
        // carrying `capMode` + `capPayload`, mirrors-decode-FIRST). Harmless
        // today because the whole stack is dark until `D*` is armed — but
        // `D*` MUST NOT be armed until 2g has shipped and every mirror decodes
        // the widened broadcast, or mirror-side reward days become unpriceable.
        // PR-9 (#1356) deploy-asserts are the enforcement point for that gate.
        if (armed) {
            s.dayCapMode[dayId] = LibVaipakam.CapMode.ShareOfPool;
        }
    }

    /// @notice #1351 (M2 PR-2, slice 2a) — stamp the armed day's D1 ceiling
    ///         `C[d] = sideHalf[d] × userSideShareCapBps / BPS` (VPFI 1e18).
    /// @dev    Split from {snapshotDayCapThreshold} on purpose. `sideHalf` is
    ///         only knowable once the day's {LibVaipakam.DayPoolStamp} has been
    ///         written, which happens LATER in `finalizeDay` — computing `C`
    ///         alongside the threshold would read an unstamped pool and
    ///         silently stamp `C = 0` (i.e. a day that pays nothing).
    ///
    ///         The atomicity the design actually requires is
    ///         **mode ↔ max-threshold**: disabling the legacy cap without
    ///         marking the day ShareOfPool would leave it priced by neither.
    ///         Those two stay together in {snapshotDayCapThreshold}; `C` lands
    ///         later in the SAME finalize transaction, and a missing/zero `C`
    ///         is the safe direction anyway (it pays nothing) rather than an
    ///         uncapped hole.
    ///
    ///         No-op on unarmed days — pre-cutover days carry no D1 ceiling.
    ///         Prices off the finalize-resolved figures the caller passes,
    ///         never a live re-derivation, so the ceiling can't be computed
    ///         from a different pool than the rewards it bounds.
    ///
    ///         #1222 M3 B2-b — per SIDE, from the GLOBAL figures: under
    ///         per-chain funding the global per-side pools genuinely differ
    ///         (Σ fundedLender_c ≠ Σ fundedBorrower_c when demand weights
    ///         force different funding), so each side's C prices against
    ///         its own pool (the shared fresh floor half + that side's
    ///         funded Σ). Computed on Base only and broadcast verbatim —
    ///         the per-chain equivalent numerators are the WRONG feed here
    ///         (a thin chain's equivs legitimately dwarf the actual pool).
    function snapshotDayUserSideShareCaps(
        uint256 dayId,
        uint256 freshHalf,
        uint256 fundedLender,
        uint256 fundedBorrower
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!_isArmedDay(s, dayId)) return;
        // May legitimately be 0 on a dust / zero-emission day — which is exactly
        // why the MODE stamp, not this value, is the D1/legacy switch.
        uint256 capBps = LibVaipakam.cfgUserSideShareCapBps();
        s.dayUserSideCapLenderVpfi18[dayId] =
            ((freshHalf + fundedLender) * capBps) / LibVaipakam.BASIS_POINTS;
        s.dayUserSideCapBorrowerVpfi18[dayId] =
            ((freshHalf + fundedBorrower) * capBps) / LibVaipakam.BASIS_POINTS;
    }

    // ─── #1351 (M2 PR-2, slice 2b) — the shared D1 day primitive ────────────
    //
    // `processUserSideDay` is the ONE place a ShareOfPool day is priced and
    // charged. Both the user claim and the forfeit sweep must route through it:
    // the whole point of the `(user, side, day)` domain is a SINGLE absolute
    // ceiling, and two independent code paths spending against it would
    // reintroduce exactly the double-pay this cap exists to stop.

    /// @dev The RPN row for `d` is materialized only up to the side's cursor.
    ///      Reading `cumRpn[d]` past it would either underflow or read an unset
    ///      slot as a false 0, so every Δ computation is gated on this.
    function _rpnReady(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardSide side,
        uint256 d
    ) private view returns (bool) {
        return
            (side == LibVaipakam.RewardSide.Lender
                ? s.cumLenderCursor
                : s.cumBorrowerCursor) >= d;
    }

    /// @dev Day `d`'s UNCAPPED per-RPN-unit rate, `cumRpn[d] - cumRpn[d-1]`.
    ///      Deliberately reads `cumRpn`, never `cumMin`: under D1 the legacy
    ///      ETH-ratio tightening is retired (finalize stamps
    ///      `dayCapThreshold18 = max`), so stacking it under the new ceiling
    ///      would underpay. Caller MUST have checked {_rpnReady}.
    function _uncappedDelta(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardSide side,
        uint256 d
    ) private view returns (uint256) {
        if (d == 0) return 0; // day 0 is excluded from rewards by convention
        if (side == LibVaipakam.RewardSide.Lender) {
            return s.cumLenderRpn18[d] - s.cumLenderRpn18[d - 1];
        }
        return s.cumBorrowerRpn18[d] - s.cumBorrowerRpn18[d - 1];
    }

    /// @dev One entry's raw contribution for day `d`, before any clamp.
    ///      A day with no global interest on that side pays nothing (and would
    ///      otherwise divide by zero upstream).
    function _contribFor(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardEntry storage e,
        uint256 d
    ) private view returns (uint256) {
        // #1636 r1 P1 — price from the STORED row alone; no global-zero
        // short-circuit. On an ordinary zero-global day the fold already
        // wrote Δ_d = 0, so the row is zero and the old guard was
        // redundant; on a compensated constraint-17 day (global == 0, row
        // = Δq) the guard DISCARDED the materialized delta — the walk
        // priced 0, `rawPay == 0` advanced terminally, and the entries
        // retired unpaid while bulk window pricing could still pay from
        // the same row. One row, one truth, both paths.
        return (e.perDayNumeraire18 * _uncappedDelta(s, e.side, d)) / 1e18;
    }

    /// @dev Remaining loan-side headroom for `(loanId, side)` — the #1353
    ///      PR-5c lifetime cap, prorated, minus what this loan-side has already
    ///      been paid. Composes with the D1 ceiling as a `min`, so the tighter
    ///      of the two always binds.
    function _loanSideRemaining(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.RewardSide side,
        uint256 rewardedDaysIncl,
        uint256 paidExtra
    ) private view returns (uint256) {
        // #1351 (Codex #1399 P2) — an UNSTAMPED loan carries NO loan-side cap;
        // it is NOT a zero cap. This mirrors `_applyLoanSideCap`, which returns
        // the untrimmed split on `openDays == 0`. Treating unstamped as 0 would
        // clamp `cEff` to 0, make `rawPay == 0`, and advance the day as if the
        // budget were exhausted — permanently losing that day's reward for a
        // cutover/backfill miss. Unbounded here defers to the D1 ceiling, which
        // still binds.
        if (s.feeEntitlementByLoanId[loanId].openDays == 0) {
            return type(uint256).max;
        }
        uint256 capEff = _loanSideRewardCapEff(s, loanId, rewardedDaysIncl);
        // `paidExtra` is the DryRun carry — what earlier previewed days of
        // this call would already have paid this loan-side (0 when settling).
        uint256 paid =
            s.loanSideRewardPaidVpfi[loanId][uint8(side)] + paidExtra;
        return capEff > paid ? capEff - paid : 0;
    }

    /// @dev Apportion `budget` across `cEff` weights: floor pro-rata, then push
    ///      the rounding remainder largest-first but ONLY into each entry's
    ///      residual capacity (`cEff[e] - floor_e`).
    ///
    ///      `Σ slices <= budget` is required; `Σ slices == budget` is NOT — when
    ///      residual capacity is exhausted the remainder is left UNALLOCATED
    ///      rather than pushed past somebody's `cEff`. Overshooting a single
    ///      entry's `cEff` would break the loan-side cap that produced it, so
    ///      leaving dust unassigned is the correct trade (it simply stays in the
    ///      pool, the same way today's unused remainder does). Dust is never
    ///      redistributed to another user or carried to a later day.
    ///      Ties break to the lowest ENTRY ID, not the lowest array index
    ///      (Codex #1399 r6 P3). Index order is whatever the caller happened to
    ///      build, and 2e's preview is specified as an exact view-twin of the
    ///      claim — two independently-built worklists over the SAME entries must
    ///      land the dust identically or preview and claim disagree by a wei.
    ///      Entry id is a property of the entry, so the split is a function of
    ///      the SET rather than of its ordering.
    function _proRataFloorWithCapacityBoundedDust(
        uint256 budget,
        uint256[] memory cEff,
        uint256 rawPay,
        uint256[] memory entryIds
    ) private pure returns (uint256[] memory slices) {
        uint256 n = cEff.length;
        slices = new uint256[](n);
        if (budget == 0 || rawPay == 0) return slices;

        uint256 assigned;
        for (uint256 i; i < n; ) {
            // Floor division: the sum can only undershoot `budget`.
            uint256 fl = (budget * cEff[i]) / rawPay;
            slices[i] = fl;
            assigned += fl;
            unchecked { ++i; }
        }

        uint256 dust = budget - assigned; // >= 0 by floor construction
        while (dust != 0) {
            // Largest residual capacity first; ties -> lowest ENTRY ID.
            uint256 bestI = type(uint256).max;
            uint256 bestCap;
            for (uint256 i; i < n; ) {
                uint256 residual = cEff[i] - slices[i];
                if (
                    residual > bestCap ||
                    (residual == bestCap &&
                        residual != 0 &&
                        bestI != type(uint256).max &&
                        entryIds[i] < entryIds[bestI])
                ) {
                    bestCap = residual;
                    bestI = i;
                }
                unchecked { ++i; }
            }
            if (bestI == type(uint256).max || bestCap == 0) break; // capacity gone -> leave dust
            uint256 give = bestCap < dust ? bestCap : dust;
            slices[bestI] += give;
            dust -= give;
        }
    }

    /// @dev The day's FRESH / RECYCLED per-side RPN composition, recomputed with
    ///      the EXACT formula the cumulative accumulator uses (see
    ///      {advanceCumLenderThrough}), so `freshDaily + recycledDaily` equals
    ///      the stored `Δ_d` that {_uncappedDelta} reads back — the two must not
    ///      drift, or a slice would be sized by one decomposition and attributed
    ///      by another.
    /// @return freshDaily    Fresh-funded component of `Δ_d` (RPN units).
    /// @return recycledDaily Recycled-funded component of `Δ_d`.
    /// @return halt True ⇒ armed day whose pool stamp hasn't landed (mirror
    ///         waiting on the composition broadcast). Unreachable behind
    ///         {_rpnReady} (the cursor halts on the same condition), kept as a
    ///         fail-closed backstop rather than a comment.
    function _dayFreshRecycledDaily(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardSide side,
        uint256 d
    )
        private
        view
        returns (uint256 freshDaily, uint256 recycledDaily, bool halt)
    {
        // #1434 P2-w3 — one derivation with the cumulative accumulator BY
        // CONSTRUCTION now: both read {_dayDeltas}, so a ladder-governed
        // (compensated) day decomposes here exactly as the fold stored it —
        // Δq as fresh, zero recycled. The `compensated` flag is discarded
        // deliberately: past the fold's funding gate the day pays through
        // the ordinary armed-fresh machinery with no special-casing.
        (freshDaily, recycledDaily, halt, ) = _dayDeltas(s, side, d);
    }

    /// @dev Attribute one leg's VPFI total to its funding sources using the
    ///      day's composition. A ShareOfPool day is ARMED by construction on
    ///      the CANONICAL chain (2a stamps the mode only under {_isArmedDay}),
    ///      so there is NO pre-`D*`
    ///      component and `total == armedFresh + recycled` exactly.
    ///
    ///      `recycled` FLOORS and fresh takes the rounding dust — the same
    ///      derive-fresh-by-subtraction convention as {_entryWindowSplit}, and
    ///      the safe direction on both ends: it can never overdraw the recycle
    ///      bucket (the wei stays in the bucket), while the extra wei of fresh
    ///      consumption is absorbed by {consumeArmedFresh}'s floor-at-zero.
    function _splitDayAmount(
        uint256 amount,
        uint256 freshDaily,
        uint256 recycledDaily
    ) private pure returns (EntrySplit memory split) {
        if (amount == 0) return split;
        split.total = amount;
        uint256 denom = freshDaily + recycledDaily;
        if (denom == 0) {
            // Unreachable: a zero-Δ day pays nothing (`rawPay == 0` returns
            // earlier). Guarded anyway — never divide by a derived zero.
            split.armedFresh = amount;
            return split;
        }
        split.recycled = (amount * recycledDaily) / denom;
        split.armedFresh = amount - split.recycled;
    }

    /// @notice Result of pricing one ShareOfPool `(user, side, day)`.
    /// @param toUser     VPFI owed to the user (clean entries), decomposed by
    ///                   funding source.
    /// @param toTreasury VPFI owed to treasury (forfeited entries), decomposed
    ///                   by funding source.
    /// @param cappedOff  Reward the LOAN-SIDE lifetime cap refused. Moves no
    ///                   tokens, but the caller MUST retire its commitments —
    ///                   `consumeArmedFresh(cappedOff.armedFresh)` and
    ///                   `releaseCommitment(cappedOff.recycled)` — exactly as
    ///                   `_applyLoanSideCap` does. The day advances regardless,
    ///                   so nobody can ever draw this value; leaving its
    ///                   commitment outstanding permanently depresses every
    ///                   later day's availability for reward that cannot exist.
    ///                   Deliberately EXCLUDES the D1-ceiling residue: that
    ///                   stays in the shared pool for other users, and retiring
    ///                   it would destroy live value.
    /// @param advanced   True ⇒ the caller MUST, in the SAME transaction:
    ///                   (a) advance `rewardEntryClaimNextDay` to `d + 1` for
    ///                   every entry in the set, (b) add `Σ slices` to
    ///                   `userSideDayPaidVpfi[user][side][d]` — ALL slices,
    ///                   forfeits included, so a forfeit cannot open a second
    ///                   budget, (c) add each slice to
    ///                   `loanSideRewardPaidVpfi[loanId][side]` **only where
    ///                   `loanSideChargeable`** (see {DaySlice}), and
    ///                   (d) increment `loanSideRewardedDays[loanId][side]` by
    ///                   the day just priced (this function reads
    ///                   `stored + 1` and cannot persist it).
    ///                   Charging (b) is NOT optional — this function is `view`
    ///                   and cannot do it, so a caller that transfers without
    ///                   charging hands the user an UNLIMITED daily budget.
    ///                   False ⇒ nothing was charged and the day stays
    ///                   RETRYABLE (pool shortage) — see the 0-slice policy.
    /// @dev Codex #1399 P2 — the legs are {EntrySplit}, not plain totals.
    ///      Collapsing fresh and recycled into one number would strand every
    ///      caller: the live reward paths need the source split to retire the
    ///      right commitment (`consumeArmedFresh`), debit the recycle bucket
    ///      (`LibVpfiRecycle.consume`), and — on the treasury leg — tell genuine
    ///      absorption (`credit`) apart from a pure commitment RELEASE
    ///      (`releaseCommitment`) for value that never physically left the
    ///      bucket. Crediting a recycled forfeit as absorption inflates Ā while
    ///      absorbing nothing.
    ///
    ///      NOT this primitive's job: retiring the day's UNCLAIMED residual
    ///      commitment. Finalize reserves the whole day's committable amount,
    ///      while a D1 day can close under-claimed; only a day-level view can
    ///      see that residue, so it belongs to the 2d sweep.
    /// @dev #1351 slice 2d-0 — what a SETTLING caller persists for the
    ///      loan-side cap, returned by the view-mode {_loanSideCapCompute} so
    ///      the settle path stores it without recomputing, and so the whole
    ///      write set is visible in one place. `stamped == false` is a loan
    ///      carrying no fee-entitlement stamp: the cap does not apply and
    ///      nothing is written.
    struct LoanSideCapCharge {
        bool stamped;
        uint256 daysIncl;
        uint256 newPaid;
    }

    /// @dev `freshShortfall` (#1351 slice 2d-0) is INFORMATIONAL ONLY: the
    ///      fresh value this day priced but could not draw because the 69M
    ///      headroom ran out (the terminal truncate-and-consume rule). It is
    ///      ALREADY folded into `cappedOff.armedFresh`, so the caller-
    ///      consumption table on {processUserSideDay} keeps its exact
    ///      three-term `consumeArmedFresh` shape — never feed this field into
    ///      any accounting call; it exists so events and tests can tell a
    ///      pool-terminal trim apart from a loan-side-cap trim.
    struct DayCharge {
        EntrySplit toUser;
        EntrySplit toTreasury;
        EntrySplit cappedOff;
        uint256 freshShortfall;
        /// @dev #1434 P1-b — how much of `freshShortfall` a MIRROR's
        ///      DELIVERED bound caused, as opposed to the monotone cap.
        ///      Non-zero ⇒ the day DEFERS instead of retiring the remainder,
        ///      because that shortfall clears when the next remittance lands.
        ///
        ///      Carried on this struct rather than returned alongside
        ///      `freshTrimmed`: a fourth return value from {_attributeLegs}
        ///      put `processUserSideDay` one slot over the viaIR stack
        ///      ceiling. Writing into a memory struct the caller already
        ///      holds costs no extra stack slot.
        uint256 freshShortfallDelivered;
        /// @dev #1434 P1-b (Codex #1699 r4 P1) — the delivered allowance THIS
        ///      day may draw, set by the caller which knows whether the day is
        ///      armed. `type(uint256).max` on an UNARMED day.
        ///
        ///      NOT load-bearing today — defence-in-depth. The walk cannot be
        ///      handed an unarmed day (it returns early with no arming set,
        ///      and the entry cursor is floored at `armedFrom` otherwise), so
        ///      the unarmed arm is unreachable and the exemption is an
        ///      equivalent mutant — measured, not argued. It encodes a rule
        ///      worth keeping: bounding a day no remittance was made against
        ///      would stall the walk on a shortfall that can never clear,
        ///      since the delivered bound never grows for such a day. A wait
        ///      must stay satisfiable, which is the whole premise of
        ///      deferring rather than truncating.
        ///
        ///      Carried on this struct rather than passed as a parameter for
        ///      the same reason `freshShortfallDelivered` is: `_attributeLegs`
        ///      is one argument from the viaIR stack ceiling.
        uint256 deliveredCapForDay;
        bool advanced;
    }

    /// @notice The caller's REMAINING pool, per funding source.
    /// @dev Codex #1399 r4 P2 — two budgets, not one. Fresh reward and recycled
    ///      reward are drawn from physically different places (the fresh
    ///      schedule vs the recycle bucket), so a single combined number can
    ///      report "enough" on a mixed day while one source is actually short,
    ///      and the transfer would then overdraw it. Each source is checked
    ///      against its own remainder.
    struct PoolBudget {
        uint256 fresh;
        uint256 recycled;
        /// @dev #1434 P1-b — the MIRROR delivered-fresh bound, carried as
        ///      its OWN term rather than folded into `fresh`. On Base (and
        ///      on any chain with no delivered constraint) this is
        ///      `type(uint256).max` and never binds.
        ///
        ///      Folding it into `fresh` is the obvious implementation and
        ///      is WRONG — it is the one §2g literally suggests, and it is
        ///      the mutant this slice exists to avoid. `fresh` is bounded
        ///      by the 69M cap and the D1 ceiling, whose shortfalls are
        ///      TERMINAL (monotone non-increasing ⇒ the remainder can
        ///      never be funded, so it is trimmed and retired). A
        ///      delivered shortfall is the opposite: it clears the moment
        ///      the next remittance lands. Sharing one term makes the two
        ///      indistinguishable at the trim site, so the delivered case
        ///      would inherit truncate-and-consume and permanently underpay
        ///      a day whose funding was merely in flight.
        ///
        ///      Kept separate, "which bound actually bound?" is answerable,
        ///      and the day can defer for the satisfiable reason while
        ///      still truncating for the unsatisfiable one.
        uint256 deliveredFresh;
    }

    /// @dev Per-claim walk state, threaded by reference through both side
    ///      walks.
    /// @param daysLeft Days this CALL may still process, shared across both
    ///        side walks. `MAX_INTERACTION_CLAIM_DAYS` bounds the per-call gas
    ///        envelope, so it has to be a per-call budget: a counter local to
    ///        {_walkSideDays} would let a claimant with both lender- and
    ///        borrower-side entries process the full allowance TWICE in one
    ///        transaction, doubling the envelope the constant exists to cap
    ///        (Codex #1404 r3). Threaded by reference for the same reason the
    ///        pool budget is — a shared allowance cannot be a local.
    struct WalkCtx {
        PoolBudget pool;
        bool advanced;
        uint256 daysLeft;
    }

    /// @notice #1351 slice 2e — one loan's in-memory loan-side deltas during
    ///         a VIEW (DryRun) walk: what earlier previewed days of THIS call
    ///         would have written to `loanSideRewardPaidVpfi` /
    ///         `loanSideRewardedDays` had they settled. Without it, a
    ///         multi-day preview prices every day against pre-walk storage
    ///         and the loan-side proration/budget drifts from what the real
    ///         walk would charge.
    struct LoanSideCarry {
        uint256 loanId;
        uint256 paidDelta;
        uint256 daysDelta;
        bool used;
    }

    /// @notice #1351 slice 2e — the DryRun overlay a VIEW walk threads
    ///         through {processUserSideDay}. Settling callers pass
    ///         {_noDryRun}: `active == false` makes every lookup fall through
    ///         to storage, so the settle path is bit-identical with or
    ///         without this parameter.
    /// @param loanSide   Per-loan deltas accumulated by earlier previewed days.
    /// @param setCursors The simulated claim cursor of each entry in the
    ///                   CURRENT call's `entryIds`, index-aligned. Storage
    ///                   cursors go stale the moment a DryRun advances past
    ///                   its first day, so the double-pay equality guard must
    ///                   check the simulated position instead.
    struct DryRunState {
        bool active;
        LoanSideCarry[] loanSide;
        uint256[] setCursors;
        /// @dev #1434 — this settlement RECYCLES to the bucket rather than
        ///      paying the side, so the loan-side cap must not bind it.
        ///
        ///      Not a dry-run concern despite living here: carried on this
        ///      struct because it is already the per-call settlement context
        ///      every pricing site threads, and a field costs no viaIR stack
        ///      slot where a sixth parameter to {processUserSideDay} would.
        ///
        ///      Forfeits already set this implicitly via {_isForfeited}. An
        ///      EXPIRY is the same case for the same reason (#1371 r2): the
        ///      reward recycles rather than being emitted to a side, so it is
        ///      bounded by the D1 `(user, side, day)` ceiling ALONE. Expiry
        ///      cannot reuse the forfeit predicate itself — a forfeit routes
        ///      to treasury while an expiry credits the bucket — so it states
        ///      the shared property directly.
        bool recycleSettlement;
    }

    /// @dev The inert overlay settling callers pass. Internal so the test
    ///      mutator's raw wrapper can construct it too.
    function _noDryRun() internal pure returns (DryRunState memory d) {
        d.loanSide = new LoanSideCarry[](0);
        d.setCursors = new uint256[](0);
    }

    /// @dev Find `loanId`'s carry slot; `type(uint256).max` when absent.
    function _carryIdx(
        LoanSideCarry[] memory carry,
        uint256 loanId
    ) private pure returns (uint256) {
        for (uint256 i; i < carry.length; ) {
            if (carry[i].used && carry[i].loanId == loanId) return i;
            unchecked { ++i; }
        }
        return type(uint256).max;
    }

    function _carryPaid(
        LoanSideCarry[] memory carry,
        uint256 loanId
    ) private pure returns (uint256) {
        uint256 i = _carryIdx(carry, loanId);
        return i == type(uint256).max ? 0 : carry[i].paidDelta;
    }

    function _carryDays(
        LoanSideCarry[] memory carry,
        uint256 loanId
    ) private pure returns (uint256) {
        uint256 i = _carryIdx(carry, loanId);
        return i == type(uint256).max ? 0 : carry[i].daysDelta;
    }

    /// @dev Accumulate one previewed day's charge for `loanId` (find-or-claim
    ///      a slot; the array is pre-sized to the worklist length, so a slot
    ///      always exists).
    function _carryCharge(
        LoanSideCarry[] memory carry,
        uint256 loanId,
        uint256 paidDelta,
        uint256 daysDelta
    ) private pure {
        uint256 i = _carryIdx(carry, loanId);
        if (i == type(uint256).max) {
            for (i = 0; i < carry.length; ) {
                if (!carry[i].used) break;
                unchecked { ++i; }
            }
            carry[i].used = true;
            carry[i].loanId = loanId;
        }
        carry[i].paidDelta += paidDelta;
        carry[i].daysDelta += daysDelta;
    }

    /// @notice One entry's share of a priced day.
    /// @param amount             VPFI attributed to this entry.
    /// @param loanSideChargeable True  ⇒ the caller MUST add `amount` to
    ///                           `loanSideRewardPaidVpfi[loanId][side]`.
    ///                           False ⇒ this is a FORFEIT: it consumes the D1
    ///                           `(user, side, day)` ceiling but is deliberately
    ///                           exempt from the loan-side lifetime cap, exactly
    ///                           as `_processEntry` treats it. Charging it would
    ///                           shrink the cap for the loan's OWN later reward
    ///                           using value that was never emitted to the side.
    ///                           The day itself still counts toward
    ///                           `loanSideRewardedDays` either way (the rev-15
    ///                           day-union rule).
    struct DaySlice {
        uint256 amount;
        bool loanSideChargeable;
    }

    /// @dev Whether the core prices the entry's remaining window at a
    ///      nonzero value — the DryRun admission mirror of the claim's
    ///      empty-window retire (see {_shareOfPoolWorklist}).
    function _entryPricesNonEmpty(
        LibVaipakam.Storage storage s,
        uint256 id,
        LibVaipakam.RewardEntry storage e
    ) private view returns (bool) {
        (, , , EntryPriceState memory st) = _entryPriceCore(s, id, e);
        return st.priced;
    }

    /// @dev Where an entry's ShareOfPool day walk starts.
    ///
    ///      An UNSET cursor resolves to `max(startDay, D*)`, not `startDay`:
    ///      under the #1351 hybrid the pre-`D*` portion of a spanning entry
    ///      is paid by the O(1) window product, so the day walk owns only the
    ///      armed days. Resolving it here — rather than letting a caller
    ///      pre-seed storage — keeps the equality check in
    ///      {processUserSideDay} a genuine double-pay guard.
    ///
    ///      With `D*` unarmed (`armedFrom == 0`) this is just `startDay`; no
    ///      day is ShareOfPool then, so the primitive is unreachable anyway.
    function _shareOfPoolCursorDay(
        LibVaipakam.Storage storage s,
        uint256 entryId,
        LibVaipakam.RewardEntry storage e
    ) private view returns (uint256) {
        uint256 nd = s.rewardEntryClaimNextDay[entryId];
        if (nd != 0) return nd;
        uint256 armedFrom = s.governorCommitArmedFromDay;
        uint256 start = e.startDay;
        if (armedFrom == 0 || armedFrom <= start) return start;
        return armedFrom;
    }

    /// @dev Price every entry in the set against the loan-side cap for day `d`.
    ///      Extracted from {processUserSideDay} purely to stay under the viaIR
    ///      stack ceiling — no behaviour of its own.
    /// @return cEff     Per-entry ceiling after the loan-side trim.
    /// @return freshCap Fresh available within each `cEff`, fresh-first.
    /// @return rawPay   `Σ cEff`.
    /// @return capped   What the loan-side cap refused, by source.
    function _priceEntriesForDay(
        LibVaipakam.Storage storage s,
        uint256[] memory entryIds,
        DaySlice[] memory slices,
        LibVaipakam.RewardSide side,
        uint256 d,
        uint256 freshDaily,
        uint256 recycledDaily,
        DryRunState memory dry
    )
        private
        view
        returns (
            uint256[] memory cEff,
            uint256[] memory freshCap,
            uint256 rawPay,
            EntrySplit memory capped
        )
    {
        uint256 n = entryIds.length;
        cEff = new uint256[](n);
        freshCap = new uint256[](n);
        for (uint256 i; i < n; ) {
            LibVaipakam.RewardEntry storage e = s.rewardEntries[entryIds[i]];
            uint256 v = _contribFor(s, e, d);
            // The loan-side lifetime cap composes as a `min`, so whichever of
            // the two ceilings is tighter binds.
            // `_loanSideRewardCapEff` prorates by `min(daysIncl, openDays) /
            // openDays`, so `daysIncl` must INCLUDE the day being priced — the
            // same convention the #1353 call sites use
            // (`storedDays + _entryArmedDays(e)`). Passing the stale stored
            // count instead makes a loan's FIRST day compute `capEff = 0`, so
            // `cEff` clamps to 0 and the primitive pays nothing, forever.
            // Since this prices exactly ONE day, that is `stored + 1`.
            //
            // Safe to add 1 per entry: entries for a given (loanId, side) are
            // adjacent and non-overlapping (a sale split ends the old window
            // where the new one begins), so at most one entry of a loan-side
            // can cover any single day.
            //
            // This function is `view` — the CALLER must persist the matching
            // `loanSideRewardedDays` increment alongside the paid maps.
            //
            // Codex #1399 r3 P2 — the loan-side cap bounds reward PAID TO A
            // USER, never a FORFEIT. `_processEntry` routes a forfeit's split
            // to treasury UNTRIMMED (#1371 r2) because a forfeit recycles to
            // the bucket rather than being emitted to the side; it only accrues
            // the armed days to the union. Clamping a forfeit here would let an
            // exhausted loan-side cap zero it out, and since the day then
            // ADVANCES that reclaimable VPFI is never credited or released —
            // gone, with its commitment left outstanding. Forfeits are bounded
            // by the D1 `(user, side, day)` ceiling alone.
            EntrySplit memory vs = _splitDayAmount(v, freshDaily, recycledDaily);
            // #1434 — an EXPIRY recycles to the bucket exactly as a forfeit
            // does, so it takes the same treatment for the same stated reason:
            // the loan-side cap bounds reward PAID TO A USER, and neither is.
            // Before this, expiry priced itself outside this function and
            // re-derived the D1 obligation by hand — three rounds of review,
            // three different wrong quantities. It now asks the one component
            // that owns the concept.
            bool isForfeit = _isForfeited(s, e) || dry.recycleSettlement;
            slices[i].loanSideChargeable = !isForfeit;
            if (isForfeit) {
                cEff[i] = v;
                freshCap[i] = vs.armedFresh;
            } else {
                uint256 lsr = _loanSideRemaining(
                    s,
                    e.loanId,
                    side,
                    s.loanSideRewardedDays[e.loanId][uint8(side)] +
                        _carryDays(dry.loanSide, e.loanId) +
                        1,
                    _carryPaid(dry.loanSide, e.loanId)
                );
                if (v <= lsr) {
                    cEff[i] = v;
                    freshCap[i] = vs.armedFresh;
                } else {
                // Codex #1399 r7 P2 — the loan-side trim is FRESH-FIRST, not
                // pro-rata by the day's composition. `_applyLoanSideCap` fills
                // the headroom from fresh and only then from recycled
                // ("Pay fresh first, then recycled, up to `remaining`"), so a
                // composition-proportional trim here would report a recycled
                // draw the live path never makes — debiting the recycle bucket
                // for reward that should have come out of fresh, and
                // under-releasing the recycled commitment by the same amount.
                uint256 paidFresh =
                    vs.armedFresh <= lsr ? vs.armedFresh : lsr;
                cEff[i] = lsr;
                freshCap[i] = paidFresh;
                capped.armedFresh += vs.armedFresh - paidFresh;
                capped.recycled += vs.recycled - (lsr - paidFresh);
                }
            }
            rawPay += cEff[i];
            unchecked { ++i; }
        }
    }

    /// @dev Attribute each entry's slice to the user or treasury leg,
    ///      FRESH-FIRST within that entry's own post-trim composition
    ///      (Codex #1399 r7 P2). Uniform with `_applyLoanSideCap`'s rule, and
    ///      it reduces to the plain composition split when nothing was trimmed
    ///      (`freshCap[i]` is then the entry's whole fresh share).
    ///
    ///      This CANNOT be done by splitting the aggregate: once one entry's
    ///      headroom has been filled fresh-first, the set no longer has a
    ///      single composition ratio to split by.
    ///
    ///      Extracted from {processUserSideDay} to keep that function under the
    ///      viaIR stack ceiling.
    ///      #1351 slice 2d-0 — `pool.fresh` is the caller's remaining 69M
    ///      headroom, and this function applies the TERMINAL truncate-and-
    ///      consume rule to it: each slice keeps its recycled component whole
    ///      and its fresh component is trimmed to what the budget still holds.
    ///
    ///      #1434 P1-b — that terminal rule now applies to the 69M headroom
    ///      ONLY. `pool.deliveredFresh` is a SECOND fresh bound with the
    ///      opposite settlement: what it trims is reported separately in
    ///      `charge.freshShortfallDelivered` and DEFERS the day rather than
    ///      retiring the remainder, because a delivered shortfall clears when
    ///      the next remittance lands while an exhausted cap never does.
    ///      The trimmed-off fresh is returned as `freshTrimmed`; MUTATED
    ///      `amounts[i]` reflect what is actually transferred. With ample
    ///      budget nothing trims and this is the plain composition split.
    ///
    ///      Allocation order is CLAIMANT-PRIORITY, two passes: the user leg
    ///      draws fresh first (real value owed to a person), the forfeit /
    ///      treasury leg absorbs from what remains (its fresh is an internal
    ///      recycle-bucket credit — at terminal exhaustion the bucket only
    ///      loses potential refill). Within a pass, worklist index order —
    ///      deterministic because the caller's transfer set is.
    function _attributeLegs(
        DaySlice[] memory slices,
        uint256[] memory amounts,
        uint256[] memory freshCap,
        uint256[] memory cEff,
        PoolBudget memory pool,
        DayCharge memory charge
    )
        private
        pure
        returns (
            EntrySplit memory user_,
            EntrySplit memory treas_,
            uint256 freshTrimmed
        )
    {
        // Copied to locals: the running decrements below are this function's
        // own bookkeeping, and the caller's `pool` must not be mutated (it
        // still has to decrement by the SETTLED spend after a defer decision,
        // and a defer discards this frame entirely). Taking the struct rather
        // than two scalars also costs one stack slot instead of two, which is
        // what keeps `processUserSideDay` under the viaIR ceiling.
        uint256 freshBudget = pool.fresh;
        // Codex #1699 r4 P1 — the caller's PER-DAY cap, not the running pool
        // figure: an unarmed day is exempt (see {DayCharge.deliveredCapForDay}).
        uint256 deliveredBudget = charge.deliveredCapForDay;
        uint256 n = slices.length;
        for (uint256 pass; pass < 2; ) {
            bool userPass = pass == 0;
            for (uint256 i; i < n; ) {
                // `loanSideChargeable` is stamped from the SHARED
                // {_isForfeited} — the same predicate `_processEntry` routes
                // on. A borrower entry that became claimable only via a
                // Defaulted / InternalMatched terminal keeps
                // `e.forfeited == false`, so routing on that flag alone would
                // pay the BORROWER what the forfeit rules send to treasury.
                if (slices[i].loanSideChargeable != userPass) {
                    unchecked { ++i; }
                    continue;
                }
                uint256 amt = amounts[i];
                // Fresh-first applies to the LOAN-SIDE trim only — it is
                // already baked into `freshCap`. The further pro-rata
                // reduction here comes from the D1 ceiling / pool, which is
                // not a loan-side decision, so it must preserve the
                // composition of what SURVIVED that trim rather than
                // re-prioritising fresh. Scaling fresh-first here would zero
                // the recycled draw on any day whose ceiling binds hard, and
                // the day's recycled budget would then never be consumed at
                // all. RECYCLED floors, fresh takes the dust — the same
                // direction as {_splitDayAmount} and {_entryWindowSplit}
                // (Codex #1399 r8 P2). Flooring fresh instead would hand the
                // rounding wei to recycled: a 2-fresh/1-recycled survivor
                // scaled to a 1-wei slice would report 0 fresh / 1 recycled,
                // overdrawing the bucket for a wei that should never have
                // left it — and potentially blocking on a phantom recycled
                // shortage.
                uint256 r = cEff[i] == 0
                    ? 0
                    : ((cEff[i] - freshCap[i]) * amt) / cEff[i];
                uint256 f = amt - r;
                // Fresh trim: pay what the binding bound allows. #1434 P1-b
                // splits what used to be one decision, because the two
                // bounds differ in whether their shortfall can EVER clear:
                //
                //   • `freshBudget` (69M headroom / D1 ceiling) is MONOTONE
                //     NON-INCREASING, so a remainder it trims can never be
                //     funded by any future state. That one is trimmed here
                //     and retired terminally by the caller — the original
                //     behaviour, unchanged, and still correct on Base.
                //   • `deliveredBudget` (a MIRROR's delivered-fresh bound)
                //     GROWS with every remittance, so a remainder it trims
                //     is merely not-yet-funded. The caller DEFERS the whole
                //     day on this one instead of retiring it.
                //
                // Attribution on a tie goes to the CAP, and that is
                // principled rather than merely conservative: if the cap
                // binds at or below the delivered bound, the day cannot be
                // paid in full no matter how much later funding arrives, so
                // truncating is the correct settlement. Reversing the tie
                // would defer a day that can never clear — wedging the
                // cursor for every later day, which is precisely why the
                // B2-d4 attempt was withdrawn.
                uint256 bound =
                    freshBudget < deliveredBudget ? freshBudget : deliveredBudget;
                uint256 fKept = f < bound ? f : bound;
                freshBudget -= fKept;
                deliveredBudget -= fKept;
                uint256 shortfall = f - fKept;
                freshTrimmed += shortfall;
                if (shortfall != 0 && deliveredBudget < freshBudget) {
                    charge.freshShortfallDelivered += shortfall;
                }
                amounts[i] = r + fKept;
                if (userPass) {
                    user_.total += r + fKept;
                    user_.armedFresh += fKept;
                    user_.recycled += r;
                } else {
                    treas_.total += r + fKept;
                    treas_.armedFresh += fKept;
                    treas_.recycled += r;
                }
                unchecked { ++i; }
            }
            unchecked { ++pass; }
        }
    }

    /// @notice The shared D1 day primitive — price + charge ONE
    ///         `(user, side, day)` against its absolute ceiling `C`.
    /// @dev    Both the user claim and the forfeit sweep MUST route through
    ///         this. The `(user, side, day)` domain exists precisely so there is
    ///         ONE ceiling; two paths spending against it independently would
    ///         reintroduce the double-pay the cap prevents.
    ///
    ///         `userSideDayPaidVpfi` is charged for what is ACTUALLY transferred
    ///         this call, and counts user payouts AND treasury forfeit slices —
    ///         a forfeit must not open a second budget. That durability is what
    ///         makes staggered loan closes safe: whichever of a user's loans
    ///         settles first consumes budget the later one then cannot re-spend,
    ///         so `Σ paid ≤ C` holds regardless of ORDER. Exact simultaneous
    ///         pro-rata across loans that close at different times is explicitly
    ///         NOT promised — only the ceiling is.
    ///
    ///         Pool shortage is ALL-OR-NOTHING, and is judged PER SOURCE: if
    ///         either the fresh or the recycled remainder cannot cover its share
    ///         of the day's budget, nothing is charged and `advanced` is false
    ///         so the caller retries later. Paying a fraction and advancing
    ///         would silently forfeit the remainder, since v1 keeps no
    ///         partial-day accounting.
    ///
    /// @param user          The claimant/forfeiter.
    /// @param d             The reward day.
    /// @param entryIds      Entries of `user` on one side covering `d` that are
    ///                      ready to transfer NOW for this call. Each MUST be
    ///                      sitting exactly on day `d` (`rewardEntryClaimNextDay`,
    ///                      or `startDay` while unset) — see the cursor check.
    ///
    ///                      CALLER OBLIGATION at the `D*` cutover (Codex #1399
    ///                      r5): an entry that opened BEFORE `D*` and is still
    ///                      open after it must have its cursor WALKED to `D*`
    ///                      through the legacy day branch, which advances the
    ///                      same cursor — never jumped, and never pre-seeded to
    ///                      `D*` in bulk. Jumping would skip the entry's
    ///                      pre-cutover days entirely; this primitive cannot
    ///                      tell a jumped cursor from an honest one, so it
    ///                      rejects anything not sitting on `d` and the
    ///                      spanning-entry bootstrap is the day walk's job.
    /// @param pool          Budget left in the caller's pool this tx, per
    ///                      funding source. (Named `pool` to avoid shadowing
    ///                      the {poolRemaining} accessor.)
    /// @return charge       Amounts + whether cursors may advance.
    /// @return slices       Per-entry slice, index-aligned with `entryIds`.
    ///
    /// CALLER CONSUMPTION CONTRACT — derived line-by-line from
    /// `InteractionRewardsFacet`'s claim path, and the single place it is
    /// written down. Nine separate rules were established across the #1399
    /// review; scattered across resolved threads they would be rediscovered one
    /// bug at a time by 2c/2d.
    ///
    /// | Facet operation                    | Feed with |
    /// | ---------------------------------- | --------- |
    /// | `interactionPoolPaidOut +=`        | `toUser.armedFresh + toTreasury.armedFresh` |
    /// | `LibVpfiRecycle.consume(...)`      | `toUser.recycled` ONLY |
    /// | `consumeArmedFresh(...)`           | `toUser.armedFresh + toTreasury.armedFresh + cappedOff.armedFresh` |
    /// | `LibVpfiRecycle.credit(Forfeited…)`| `toTreasury.armedFresh` |
    /// | `releaseCommitment(Forfeited…)`    | `toTreasury.recycled + cappedOff.recycled` |
    ///
    /// Two traps in that table:
    ///
    /// 1. `consumeArmedFresh` takes THREE terms. The loan-side cap trim keeps
    ///    `armedFresh` WHOLE on the legacy path's user split so the full
    ///    commitment retires; this primitive instead reports the trimmed part
    ///    separately as {DayCharge.cappedOff} — which since #1351 slice 2d-0
    ///    ALSO carries the pool-terminal fresh trim (the truncate-and-consume
    ///    rule at 69M exhaustion; see {DayCharge.freshShortfall}). The sum is
    ///    identical — but a caller that adds only the two paid legs leaks a
    ///    fresh commitment on every trimmed entry, silently depressing later
    ///    days' availability.
    /// 2. The facet derives fresh as `total − recycled` while this returns
    ///    `armedFresh` explicitly. They coincide ONLY because a ShareOfPool day
    ///    is armed by construction, so there is no pre-`D*` component. Do not
    ///    port this table to a legacy day.
    function processUserSideDay(
        address user,
        uint256 d,
        uint256[] memory entryIds,
        PoolBudget memory pool,
        DryRunState memory dry
    ) internal view returns (DayCharge memory charge, DaySlice[] memory slices) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 n = entryIds.length;
        slices = new DaySlice[](n);
        if (n == 0) return (charge, slices);

        LibVaipakam.RewardSide side = s.rewardEntries[entryIds[0]].side;

        // Validate the transfer set BEFORE any early return. A malformed set is
        // a CALLER BUG and must always surface as a revert — if this sat after
        // the readiness gate, the same bad set would silently no-op whenever the
        // RPN row happened to be behind, hiding the defect until the day it
        // isn't.
        for (uint256 i; i < n; ) {
            LibVaipakam.RewardEntry storage v = s.rewardEntries[entryIds[i]];
            // `side` is taken from entry[0] and then drives BOTH the loan-side
            // clamp and the `userSideDayPaidVpfi` key, so a mixed-side or
            // foreign-user set would charge the wrong budget and pay slices for
            // entries the claimant doesn't own. Two independent callers build
            // this set (2c claim, 2d sweep), so an unchecked precondition in a
            // fund-moving primitive is exactly the kind of assumption that
            // silently rots — make it a revert, not a comment.
            //
            // Paying a day the entry doesn't cover would also mint reward from
            // nothing (`perDayNumeraire18 × Δ` is computed regardless).
            if (
                v.user != user ||
                v.side != side ||
                d < v.startDay ||
                d >= v.endDay
            ) {
                revert IVaipakamErrors.RewardEntrySetMismatch(entryIds[i]);
            }
            // Codex #1399 P2 — the entry must be AT day `d` on its own cursor.
            // Covering `d` is not enough: a stale worklist could re-present an
            // entry that already advanced past `d` and get it priced a SECOND
            // time out of any unsaturated `C`, and the loan-side proration
            // (recomputed from `stored + 1`) would not catch it.
            // #1351 slice 2e — a DryRun's storage cursors go stale the
            // moment it advances past its first simulated day, so the guard
            // checks the caller's SIMULATED cursor instead (index-aligned,
            // always resolved). Settling callers keep the storage read.
            uint256 nd = dry.active
                ? dry.setCursors[i]
                : s.rewardEntryClaimNextDay[entryIds[i]];
            if ((nd == 0 ? uint256(v.startDay) : nd) != d) {
                revert IVaipakamErrors.RewardEntrySetMismatch(entryIds[i]);
            }
            // Codex #1399 r1/r2 P2 — an entry is payable only once CLAIMABLE
            // and not yet processed. The legacy `_processEntry` applies exactly
            // this gate before pricing, and a shared fund-moving primitive must
            // not depend on the outer worklist remembering to.
            //
            // {_entryClaimable}, NOT `closed`: an entry made claimable by the
            // LOAN-TERMINAL fallback is never `closed` (`_closeEntry` didn't
            // run), and that is precisely the population {_entryTerminalForfeit}
            // exists to route below. Gating on `closed` would revert those
            // entries before the routing branch could ever see them — the
            // branch would be dead code, and a defaulted borrower's forfeit
            // would strand, never advancing its cursor. Active /
            // FallbackPending loans are still rejected, which is the part that
            // actually protects funds.
            if (!_entryClaimable(s, v) || v.processed) {
                revert IVaipakamErrors.RewardEntrySetMismatch(entryIds[i]);
            }
            // Codex #1399 P2 — a duplicated id would read the SAME unchanged
            // loan-side remaining twice, count the entry twice in `rawPay`, and
            // let the caller persist both slices past the loan-side cap.
            for (uint256 j; j < i; ) {
                if (entryIds[j] == entryIds[i]) {
                    revert IVaipakamErrors.RewardEntrySetMismatch(entryIds[i]);
                }
                unchecked { ++j; }
            }
            unchecked { ++i; }
        }

        // `_rpnReady` also subsumes the `knownGlobalSet[d]` gate: the cursor
        // advance halts at the first day without a known global set, so
        // `cursor >= d` implies day `d` was finalized. Do NOT "optimise" this
        // check away — without it an unfinalized day reads an unset RPN row as
        // a false 0 and would advance past itself, losing that day forever.
        if (!_rpnReady(s, side, d)) return (charge, slices);

        // Fail CLOSED — but only for a day that HAS finalized. An armed day
        // that never got its mode stamp is not a legacy day; treating it as one
        // would price it with the retired ETH-ratio cap (disabled at finalize ⇒
        // effectively uncapped).
        //
        // Codex #1399 r4 P2 — this MUST sit behind the readiness gate. Finalize
        // writes the mode stamp and the globals/RPN row together, so a day that
        // simply hasn't finalized yet has no stamp either. Checking first turned
        // "not ready, retry later" into a hard revert that would brick the whole
        // claim for a not-yet-finalized day. Unlike a malformed transfer set
        // (always a caller bug ⇒ always revert), an unfinalized day is a normal
        // transient state.
        if (s.dayCapMode[d] != LibVaipakam.CapMode.ShareOfPool) {
            revert IVaipakamErrors.DayCapModeUnsetPostCutover(d);
        }

        // Resolve the day's funding composition BEFORE anything is priced: on
        // the (unreachable-behind-`_rpnReady`) stamp-missing case the day must
        // stay retryable, and bailing out after `slices` were computed would
        // hand the caller a populated array with `advanced == false`.
        (uint256 freshDaily, uint256 recycledDaily, bool halt) =
            _dayFreshRecycledDaily(s, side, d);
        if (halt) return (charge, slices);

        // #1222 M3 B2-b — per-SIDE ceilings (the pre-B2-b single
        // `dayUserSideCapVpfi18` slot is retired; no armed day can predate
        // the flip, so there is no mixed history to bridge).
        uint256 c = side == LibVaipakam.RewardSide.Lender
            ? s.dayUserSideCapLenderVpfi18[d]
            : s.dayUserSideCapBorrowerVpfi18[d];
        uint256 paid = s.userSideDayPaidVpfi[user][uint8(side)][d];
        // Exhausted (including a legitimate `C == 0` dust day) — advance with a
        // 0 slice so the walk makes progress instead of spinning on this day.
        if (paid >= c) {
            charge.advanced = true;
            return (charge, slices);
        }

        (
            uint256[] memory cEff,
            uint256[] memory freshCap,
            uint256 rawPay,
            EntrySplit memory capped
        ) = _priceEntriesForDay(
            s, entryIds, slices, side, d, freshDaily, recycledDaily, dry
        );

        // Legitimately nothing to pay (zero weights / loan-side exhausted):
        // advance so the walk progresses. This is NOT the pool-shortage case.
        if (rawPay == 0) {
            capped.total = capped.armedFresh + capped.recycled;
            charge.cappedOff = capped;
            charge.advanced = true;
            return (charge, slices);
        }

        uint256 remainingD1 = c - paid;
        uint256 budget = rawPay < remainingD1 ? rawPay : remainingD1;

        uint256[] memory amounts =
            _proRataFloorWithCapacityBoundedDust(budget, cEff, rawPay, entryIds);
        // Codex #1699 r4 P1 — EXEMPT unarmed days from the delivered bound.
        //
        // ACCEPTED AS DEFENCE-IN-DEPTH, NOT AS A BUG FIX. The reported wedge
        // cannot occur: an unarmed day never reaches this function.
        // {_walkShareOfPoolDays} returns early when
        // `governorCommitArmedFromDay == 0`, and when it is set
        // {_shareOfPoolCursorDay} floors every cursor at `armedFrom`, so no
        // day below it is ever selected. `_isArmedDay(s, d)` is true here by
        // construction and this ternary always takes the first arm.
        //
        // Measured, not argued: forcing it to `pool.deliveredFresh`
        // unconditionally, with the delivered bound at ZERO, changes nothing
        // — an equivalent mutant. Do not write a test claiming to kill it.
        //
        // Kept because the rule it encodes is sound and free: bounding a day
        // no remittance was made against would stall the walk on a shortfall
        // that can never clear, inverting this slice's premise that a wait
        // must always be satisfiable. If the cursor floor is ever relaxed —
        // letting broadcast-stamped ShareOfPool days below `armedFrom` into
        // the walk — this becomes load-bearing.
        charge.deliveredCapForDay = _isArmedDay(s, d)
            ? pool.deliveredFresh
            : type(uint256).max;
        (
            EntrySplit memory user_,
            EntrySplit memory treas_,
            uint256 freshTrimmed
        ) = _attributeLegs(
            slices,
            amounts,
            freshCap,
            cEff,
            pool,
            charge
        );

        // ─── Per-leg pool boundary (#1351 slice 2d-0) ────────────────────────
        //
        // The two funding sources get DIFFERENT shortfall semantics, because
        // they behave differently over time:
        //
        //   • RECYCLED shortfall → DEFER. The recycle bucket is a real held
        //     balance that REFILLS (`LibVpfiRecycle.credit` on every forfeit,
        //     expiry, and absorption), so leaving the day unpaid and retryable
        //     is both safe and correct — a later claim finds a fuller bucket.
        //     All-or-nothing here, and checked against the EXACT leg total
        //     (Codex #1399 r6 P2): each leg floors its recycled share
        //     independently, and fresh is the subtraction remainder, so a set
        //     holding BOTH payable and forfeited entries can draw a wei or two
        //     more than a single split of `budget` predicts; a real balance
        //     must never be overdrawn by "off by a wei, absorbed downstream".
        //
        //   • FRESH shortfall → TERMINAL truncate-and-consume, applied inside
        //     {_attributeLegs}. The 69M headroom is MONOTONE NON-INCREASING —
        //     `interactionPoolPaidOut` and `rewardBudgetRemittedGlobal` are
        //     both append-only — so a fresh shortfall can never be funded
        //     later, and deferring it is a PERMANENT livelock: the claimant
        //     retries forever into a budget that cannot grow, with the cursor
        //     parked and commitments unretired. Instead the day pays what
        //     headroom allows (claimant-priority), ADVANCES, and the trimmed
        //     remainder joins `cappedOff.armedFresh` so its commitment is
        //     retired by the caller's normal three-term `consumeArmedFresh`.
        //     This is the same rule the legacy per-entry path has always
        //     applied (`min(freshShare, poolRoom)`), extended to the armed
        //     tail rather than a second invented one.
        //
        //   • DELIVERED-FRESH shortfall (#1434 P1-b, MIRRORS only) → DEFER,
        //     like recycled and unlike the cap. Read the fresh bullet above
        //     and note precisely WHY it truncates: the 69M headroom is
        //     monotone non-increasing, so its shortfall "can never be funded
        //     later" and deferring would livelock. A mirror's delivered
        //     budget has the opposite dynamics — it GROWS with every
        //     remittance — so for it the reasoning inverts: truncating would
        //     permanently underpay a day whose funding was merely in flight,
        //     and deferring is the settlement that can actually clear.
        //
        //     This is why the two fresh bounds are carried as SEPARATE terms
        //     (`pool.fresh` vs `pool.deliveredFresh`) rather than minimised
        //     into one. Sharing a term would make the binding bound
        //     unidentifiable at the trim, and the delivered case would
        //     silently inherit truncate-and-consume — which is exactly the
        //     shape the withdrawn B2-d4 attempt shipped. `_attributeLegs`
        //     therefore reports the delivered-caused portion separately in
        //     `charge.freshShortfallDelivered`, and a TIE is attributed to
        //     the cap: if the cap binds at or below the delivered bound, no
        //     future remittance can complete the day, so truncating is the
        //     correct settlement and deferring would park the cursor on a
        //     condition that can never be satisfied.
        //
        // Ordering: the recycled check runs on the post-trim legs, which is
        // exact — trimming touches only fresh components, so `user_.recycled`
        // is identical either way. On a defer nothing is persisted, so the
        // trimmed `amounts` are discarded with the rest of the frame.
        //
        // `cappedOff` draws nothing from the pool: it moves no tokens (it only
        // retires commitments).
        //
        // Codex #1399 r9 P2 — the two sources are ASYMMETRIC across the legs,
        // matching what the facet actually does with each:
        //   • FRESH — both legs spend it. The user leg pays out; the forfeit
        //     leg's fresh share is genuine absorption that `credit`s the
        //     recycle bucket. `interactionPoolPaidOut` counts both.
        //   • RECYCLED — only the USER leg consumes it (`LibVpfiRecycle
        //     .consume`). The forfeit leg's recycled share never physically
        //     left the bucket, so it is a pure `releaseCommitment` — zero
        //     tokens move. Requiring recycled liquidity for it would strand a
        //     recycled-funded forfeit (and its commitment) behind unrelated
        //     payout budget that the release does not need.
        if (pool.recycled < user_.recycled) {
            return (charge, slices);
        }
        // #1434 P1-b — the FRESH leg gains the same treatment, but ONLY for
        // the part of the trim a DELIVERED bound caused. `charge.advanced`
        // is still false here, so returning leaves nothing persisted, the
        // cursor unmoved and the day retryable — identical to the recycled
        // defer above, and for the identical reason: the bound that stopped
        // it is one the next remittance can satisfy.
        //
        // Note what this deliberately does NOT do: defer on any fresh trim.
        // A cap-bound trim falls through to the terminal retirement below,
        // because no future remittance can clear it and a day parked on an
        // unsatisfiable condition would wedge the cursor for every later
        // day. "Can the condition that stopped it always be satisfied" is
        // the distinguishing test, and it is answerable here only because
        // `deliveredFresh` is carried as its own bound.
        if (charge.freshShortfallDelivered != 0) {
            return (charge, slices);
        }
        if (freshTrimmed != 0) {
            charge.freshShortfall = freshTrimmed;
            capped.armedFresh += freshTrimmed;
        }

        for (uint256 i; i < n; ) {
            slices[i].amount = amounts[i];
            unchecked { ++i; }
        }
        charge.toUser = user_;
        charge.toTreasury = treas_;
        capped.total = capped.armedFresh + capped.recycled;
        charge.cappedOff = capped;
        charge.advanced = true;
    }

    /// @notice Store a broadcast-canonical threshold on a mirror (from Base's
    ///         finalize snapshot). Mirrors NEVER recompute locally, so Base and
    ///         every mirror cap identically and the per-chain remittance identity
    ///         holds (Codex #1147 r4 H1).
    function setBroadcastDayCapThreshold(uint256 dayId, uint256 t) internal {
        LibVaipakam.storageSlot().dayCapThreshold18[dayId] = t;
    }

    /// @dev `T_d = (10^feedDec · effectiveCapRatio · 1e18) / ethPriceRaw`, the
    ///      entry-independent §4 cap threshold in RPN units. Returns
    ///      `type(uint256).max` (cap DISABLED for the day) when: the cap is off
    ///      (`capRatio` == max sentinel), the ETH feed is unavailable, OR the
    ///      feed reports an out-of-range `decimals()` — the last guards the
    ///      `10**feedDec` overflow that would otherwise revert finalization
    ///      (Codex #1147 r8 L5). Uses the EFFECTIVE
    ///      `getInteractionCapVpfiPerEth()` so a stored `0` maps to the default
    ///      ratio rather than a zero cap (Codex #1147 r4 H5).
    function _computeDayCapThreshold18() private view returns (uint256) {
        uint256 capRatio = LibVaipakam.getInteractionCapVpfiPerEth();
        if (capRatio == type(uint256).max) return type(uint256).max;
        (uint256 ethPriceRaw, uint8 feedDec) = _ethUsdPriceRawAndDec();
        if (ethPriceRaw == 0) return type(uint256).max;
        if (feedDec > 36) return type(uint256).max; // guard 10**feedDec overflow
        return ((10 ** feedDec) * capRatio * 1e18) / ethPriceRaw;
    }
}
