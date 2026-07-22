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
    function chainRewardBudgetSplitForDay(
        LibVaipakam.Storage storage s,
        uint32 chainId,
        uint256 dayId
    ) internal view returns (uint256 budgetFresh, uint256 budgetRecycled) {
        uint256 half;
        uint256 recycledHalf;
        {
            uint256 armedFrom = s.governorCommitArmedFromDay;
            if (armedFrom != 0 && dayId >= armedFrom) {
                LibVaipakam.DayPoolStamp storage p = s.dayPoolStamp[dayId];
                // Fail-closed: an armed day without a stamp funds nothing
                // yet (finalization/broadcast pending) — same wait the
                // claim-side accumulators apply.
                if (!p.stamped) return (0, 0);
                half = uint256(p.scheduleFloor) / 2;
                recycledHalf = uint256(p.recycledBudget) / 2;
            } else {
                half = halfPoolForDay(dayId);
            }
        }
        if (half == 0 && recycledHalf == 0) return (0, 0);
        // #776 — only chains whose numerator was folded into `dayId`'s finalized
        // denominator get a slice; a reported-but-then-de-listed chain is out.
        if (!s.chainDailyIncluded[dayId][chainId]) return (0, 0);
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
            (uint256 f, uint256 r) = _sideBudgetSplit(
                half,
                recycledHalf,
                gLender,
                t,
                s.chainDailyLenderInterestNumeraire18[dayId][chainId]
            );
            budgetFresh += f;
            budgetRecycled += r;
        }
        uint256 gBorrower = s.dailyGlobalBorrowerInterestNumeraire18[dayId];
        if (gBorrower != 0) {
            (uint256 f, uint256 r) = _sideBudgetSplit(
                half,
                recycledHalf,
                gBorrower,
                t,
                s.chainDailyBorrowerInterestNumeraire18[dayId][chainId]
            );
            budgetFresh += f;
            budgetRecycled += r;
        }
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

    /// @dev Governor PR-3c (#1217 §3.1) — resolve day `d`'s per-side pool
    ///      halves for the accumulator build.
    ///
    ///      Pre-cutover days keep the legacy schedule (`halfPoolForDay`,
    ///      fresh-only). Post-cutover days (`armedFrom != 0 && d >=
    ///      armedFrom` — NEVER `>=` alone, per the redesign's D* rule) read
    ///      the finalize-stamped {LibVaipakam.DayPoolStamp} halves: the
    ///      fresh component from `scheduleFloor` and the recycled component
    ///      from `recycledBudget`, each split 50/50 per side. A post-cutover
    ///      day whose stamp hasn't landed yet (mirror waiting on the
    ///      composition broadcast) HALTS the cursor — the same fail-closed
    ///      wait the `knownGlobalSet` gate already applies, so a claim can
    ///      never price an armed day from the wrong pool.
    /// @return freshHalf    Per-side fresh pool for day `d`.
    /// @return recycledHalf Per-side recycled pool (0 pre-cutover).
    /// @return halt         True ⇒ armed day without a stamp: stop advancing.
function _dayPoolHalves(
        LibVaipakam.Storage storage s,
        uint256 d
    )
        private
        view
        returns (uint256 freshHalf, uint256 recycledHalf, bool halt)
    {
        if (_isArmedDay(s, d)) {
            LibVaipakam.DayPoolStamp storage p = s.dayPoolStamp[d];
            if (!p.stamped) return (0, 0, true);
            return (uint256(p.scheduleFloor) / 2, uint256(p.recycledBudget) / 2, false);
        }
        return (halfPoolForDay(d), 0, false);
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
            (uint256 freshHalf, uint256 recycledHalf, bool halt) =
                _dayPoolHalves(s, d);
            if (halt) break;
            uint256 globalTotal = s.knownGlobalLenderInterestNumeraire18[d];
            uint256 freshDaily;
            uint256 recycledDaily;
            if (globalTotal != 0) {
                if (freshHalf != 0) {
                    freshDaily = (freshHalf * 1e18) / globalTotal;
                }
                if (recycledHalf != 0) {
                    recycledDaily = (recycledHalf * 1e18) / globalTotal;
                }
            }
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
            (uint256 freshHalf, uint256 recycledHalf, bool halt) =
                _dayPoolHalves(s, d);
            if (halt) break;
            uint256 globalTotal = s.knownGlobalBorrowerInterestNumeraire18[d];
            uint256 freshDaily;
            uint256 recycledDaily;
            if (globalTotal != 0) {
                if (freshHalf != 0) {
                    freshDaily = (freshHalf * 1e18) / globalTotal;
                }
                if (recycledHalf != 0) {
                    recycledDaily = (recycledHalf * 1e18) / globalTotal;
                }
            }
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
    function claimForUserEntries(address user)
        internal
        returns (EntrySplit memory toUser, EntrySplit memory toTreasury)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage ids = s.userRewardEntryIds[user];
        uint256 len = ids.length;

        // #1008 (S13) — the §4 cap is baked into `cumMin*Rpn18` at finalization,
        // so the claim no longer reads the ETH feed / cap ratio here.
        for (uint256 i = 0; i < len; ) {
            (EntrySplit memory u, EntrySplit memory t) =
                _processEntry(s, ids[i], /* mutate */ true, /* deferArmed */ true);
            toUser.total += u.total;
            toUser.recycled += u.recycled;
            toUser.armedFresh += u.armedFresh;
            toTreasury.total += t.total;
            toTreasury.recycled += t.recycled;
            toTreasury.armedFresh += t.armedFresh;
            unchecked { ++i; }
        }

        // #1351 slice 2c — the loop above paid every entry's pre-`D*` portion
        // O(1); the armed days are priced per-day against the D1 ceiling here.
        (EntrySplit memory wu, EntrySplit memory wt) =
            _walkShareOfPoolDays(s, user);
        _foldSplit(toUser, wu);
        _foldSplit(toTreasury, wt);
    }

    /// @dev #1351 (M2 PR-2, slice 2c) — the ShareOfPool day walk.
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
        address user
    ) private returns (EntrySplit memory toUser, EntrySplit memory toTreasury) {
        if (s.governorCommitArmedFromDay == 0) return (toUser, toTreasury);
        PoolBudget memory pool =
            PoolBudget({fresh: poolRemaining(), recycled: s.recycleBucket});

        for (uint8 sideIdx; sideIdx < 2; ) {
            LibVaipakam.RewardSide side = sideIdx == 0
                ? LibVaipakam.RewardSide.Lender
                : LibVaipakam.RewardSide.Borrower;
            uint256[] memory work = _shareOfPoolWorklist(s, user, side);
            if (work.length != 0) {
                _walkSideDays(s, user, side, work, pool, toUser, toTreasury);
            }
            unchecked { ++sideIdx; }
        }
    }

    /// @dev Entries of `user` on `side` that still owe ShareOfPool days.
    function _shareOfPoolWorklist(
        LibVaipakam.Storage storage s,
        address user,
        LibVaipakam.RewardSide side
    ) private view returns (uint256[] memory work) {
        uint256[] storage ids = s.userRewardEntryIds[user];
        uint256 len = ids.length;
        uint256[] memory buf = new uint256[](len);
        uint256 n;
        for (uint256 i; i < len; ) {
            uint256 id = ids[i];
            LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
            if (
                !e.processed &&
                e.side == side &&
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
        PoolBudget memory pool,
        EntrySplit memory toUser,
        EntrySplit memory toTreasury
    ) private {
        uint256 daysUsed;
        while (daysUsed < LibVaipakam.MAX_INTERACTION_CLAIM_DAYS) {
            uint256 d = _lowestPendingDay(s, work);
            if (d == type(uint256).max) break;
            uint256[] memory set = _entriesAtDay(s, work, d);
            if (set.length == 0) break;

            (DayCharge memory charge, DaySlice[] memory slices) =
                processUserSideDay(user, d, set, pool);
            // Not advanced ⇒ pool shortage or an unready RPN row. Nothing was
            // charged, so STOP rather than spin: the day stays retryable.
            if (!charge.advanced) break;

            _persistDay(s, user, side, d, set, slices);
            pool.fresh -= charge.toUser.armedFresh + charge.toTreasury.armedFresh;
            pool.recycled -= charge.toUser.recycled;
            _foldSplit(toUser, charge.toUser);
            _foldSplit(toTreasury, charge.toTreasury);
            // `cappedOff` moves no tokens but MUST reach the facet so the
            // commitments retire — fold its fresh into the user leg's
            // `armedFresh` (which is exactly what `consumeArmedFresh` consumes)
            // and its recycled into the treasury leg (a pure release).
            toUser.armedFresh += charge.cappedOff.armedFresh;
            toTreasury.recycled += charge.cappedOff.recycled;

            unchecked { ++daysUsed; }
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
        pending = previewForUserEntries(user);
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
    ///      {previewForUserEntries} / {_entryWindowSplit} reads the exact
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
    ///      forfeit-credit path would absorb into the recycle bucket. Assumes
    ///      the caller has already advanced the cursors (see
    ///      {_advanceUserCursors}) so each {_entryWindowSplit} is exact.
    function _userForfeitFresh(
        LibVaipakam.Storage storage s,
        address user
    ) private view returns (uint256 fresh) {
        uint256[] storage ids = s.userRewardEntryIds[user];
        uint256 len = ids.length;
        for (uint256 i; i < len; ) {
            LibVaipakam.RewardEntry storage e = s.rewardEntries[ids[i]];
            if (
                !e.processed &&
                (e.forfeited || _entryTerminalForfeit(s, e))
            ) {
                EntrySplit memory sp = _entryWindowSplit(s, e);
                fresh += sp.total - sp.recycled;
            }
            unchecked { ++i; }
        }
    }

    /// @notice View-only preview of {claimForUserEntries}.
    function previewForUserEntries(address user)
        internal
        view
        returns (uint256 userTotal)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage ids = s.userRewardEntryIds[user];
        uint256 len = ids.length;

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
                userTotal += _previewEntryReward(s, e);
            }
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
            (, EntrySplit memory t) =
                _processEntry(s, lenderId, true, /* deferArmed */ false);
            _foldSplit(toTreasury, t);
        }
        uint256 borrowerId = s.loanBorrowerEntryId[loanId];
        if (borrowerId != 0 && _isForfeited(s, s.rewardEntries[borrowerId])) {
            (, EntrySplit memory t) =
                _processEntry(s, borrowerId, true, /* deferArmed */ false);
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
                (, EntrySplit memory t) =
                    _processEntry(s, orphaned[i], true, /* deferArmed */ false);
                _foldSplit(toTreasury, t);
            }
            unchecked { ++i; }
        }
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
    function sweepExpiredEntry(uint256 id, uint256 freshHeadroom)
        internal
        returns (EntrySplit memory expired, uint256 freshCredited)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint32 horizonDays = s.rewardClaimHorizonDays;
        if (horizonDays == 0) return (expired, 0);
        LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
        if (e.processed || e.user == address(0)) return (expired, 0);
        if (e.forfeited || _entryTerminalForfeit(s, e)) return (expired, 0);
        if (!_entryClaimable(s, e)) return (expired, 0);
        if (e.startDay >= e.endDay) return (expired, 0);

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
            if (cursor < need) return (expired, 0);
        }

        EntrySplit memory split_ = _entryWindowSplit(s, e);
        uint256 freshShare = split_.total - split_.recycled;
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
        uint256 poolReserved =
            s.interactionPoolPaidOut + s.rewardBudgetRemittedGlobal;
        uint256 poolRoom = LibVaipakam.VPFI_INTERACTION_POOL_CAP > poolReserved
            ? LibVaipakam.VPFI_INTERACTION_POOL_CAP - poolReserved
            : 0;
        uint256 entryPayable =
            (freshShare < poolRoom ? freshShare : poolRoom) + split_.recycled;
        bool executable = entryPayable != 0 &&
            !LibVaipakam.isSanctionedAddress(e.user) &&
            !LibPausable.paused() &&
            IERC20Metadata(s.vpfiToken).balanceOf(address(this)) >=
            userClaimFundingNeed(s, e.user);

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
            return (expired, 0);
        }

        uint256 hSec = uint256(horizonDays) * 1 days;

        if (lastObs == 0) {
            // First claim-executable observation — start the accumulator.
            // The stamp event is the notification pipeline's schedule signal.
            s.rewardEntryFirstClaimableAt[id] = uint64(block.timestamp);
            s.rewardEntryExecObsAt[id] = uint64(block.timestamp);
            s.rewardEntryHorizonEpoch[id] = s.rewardHorizonActivatedAt;
            emit RewardEntryHorizonStamped(id, e.user, uint64(block.timestamp));
            return (expired, 0);
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
            return (expired, 0);
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
            return (expired, 0);
        }

        // ALL-OR-NOTHING expiry (Codex #1317): terminalise ONLY if the
        // entry's FULL fresh share fits the batch's remaining creditable
        // headroom (`freshHeadroom` = the 69M pool cap AND the recycle-bucket
        // backing room, minimised per entry by the caller). A PARTIAL credit
        // would reap the claimant while silently dropping the uncreditable
        // fresh remainder — so defer the whole entry instead, and RECORD the
        // block so the countdown pauses and the next touch re-baselines from
        // a creditable state (never a fresh accrual — the claimant already
        // served the full window; the defer is a protocol-side crediting
        // constraint, and the claim path stays open to them throughout).
        if (freshShare > freshHeadroom) {
            s.rewardEntryObsBlocked[id] = true;
            return (expired, 0);
        }
        // #1353 (M2 PR-5c) — NO loan-side cap here: an expired reward recycles
        // to the bucket (it is not emitted to the side), so like a forfeit it is
        // uncapped — the cap bounds reward PAID TO A USER only (Codex #1371 r2).
        // Recycling the full amount back into the pool is not over-reward.
        expired = split_;
        freshCredited = freshShare;
        e.processed = true;
        emit RewardEntryExpired(id, e.user, expired.total, expired.recycled);
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
            !s.rewardEntryObsBlocked[id] && _entryExecutableNow(s, e)
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
        LibVaipakam.RewardEntry storage e
    ) private view returns (bool) {
        if (LibVaipakam.isSanctionedAddress(e.user)) return false;
        if (LibPausable.paused()) return false; // every claim reverts paused
        EntrySplit memory split_ = _entryWindowSplit(s, e);
        uint256 freshShare = split_.total - split_.recycled;
        uint256 poolReserved =
            s.interactionPoolPaidOut + s.rewardBudgetRemittedGlobal;
        uint256 poolRoom = LibVaipakam.VPFI_INTERACTION_POOL_CAP > poolReserved
            ? LibVaipakam.VPFI_INTERACTION_POOL_CAP - poolReserved
            : 0;
        uint256 entryPayable =
            (freshShare < poolRoom ? freshShare : poolRoom) + split_.recycled;
        if (entryPayable == 0) return false; // nothing a claim could pay for it
        return
            IERC20Metadata(s.vpfiToken).balanceOf(address(this)) >=
            _userClaimFundingNeedView(s, e.user);
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

    /// @dev Process (or preview) a single reward entry. When `mutate`,
    ///      flips `processed = true` and returns the routed amounts;
    ///      otherwise returns the pending amount for the user side only
    ///      (treasury never "previews").
    /// @param deferArmed True ⇒ pay only the pre-`D*` portion and leave the
    ///        entry UNPROCESSED, because the caller will price its armed days
    ///        per-day against the D1 ceiling ({_walkShareOfPoolDays}). Only the
    ///        CLAIM path passes true today; the forfeit sweep keeps the whole-
    ///        window payout until slice 2d gives it a day walk of its own.
    ///        Scoping the deferral to the caller that can actually finish the
    ///        job is what stops a swept forfeit from stranding its armed
    ///        portion with no walk to collect it.
    function _processEntry(
        LibVaipakam.Storage storage s,
        uint256 id,
        bool mutate,
        bool deferArmed
    )
        private
        returns (EntrySplit memory toUser, EntrySplit memory toTreasury)
    {
        LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
        if (e.processed) return (toUser, toTreasury);
        // #1002 (S4) — an entry is claimable/sweepable ONLY once the loan is
        // actually over, not merely because the calendar passed maturity. See
        // {_entryClaimable}: either the entry was explicitly closed (window
        // finalized by closeLoan / lender-sale) OR its loan has reached a
        // terminal status. `endDay` is purely the accrual bound now.
        if (!_entryClaimable(s, e)) return (toUser, toTreasury);
        if (e.startDay >= e.endDay) {
            if (mutate) e.processed = true;
            return (toUser, toTreasury);
        }

        // Need cumRPN populated through endDay - 1 for the matching side.
        uint256 need = e.endDay - 1;
        uint256 cursor;
        if (e.side == LibVaipakam.RewardSide.Lender) {
            cursor = s.cumLenderCursor;
            if (cursor < need) {
                // Try to extend; may not be possible if globals not finalized.
                cursor = advanceCumLenderThrough(need);
            }
            if (cursor < need) return (toUser, toTreasury);
        } else {
            cursor = s.cumBorrowerCursor;
            if (cursor < need) {
                cursor = advanceCumBorrowerThrough(need);
            }
            if (cursor < need) return (toUser, toTreasury);
        }

        // #1008 (S13, Option B) — read the CAPPED cumulative so the §4 daily
        // cap is applied per day (baked at finalization) while the claim stays
        // O(1). `cumMin*Rpn18` == `cum*Rpn18` on days the cap was disabled.
        // PR-3c — the RECYCLED capped component rides the same window
        // delta; mixed pre/post-cutover windows slice correctly by
        // construction (pre-arming days contribute 0 to the recycled
        // cumulative), satisfying the redesign's D* day-slicing rule
        // without a per-day loop.
        EntrySplit memory split = _entryWindowSplit(s, e);
        if (split.total == 0) {
            if (mutate) e.processed = true;
            return (toUser, toTreasury);
        }

        // #1351 (M2 PR-2, slice 2c) — HYBRID regime split. `_entryWindowSplit`
        // is regime-separated by construction: pre-arming days contribute 0 to
        // BOTH the armed and recycled cumulatives, so `armedFresh + recycled`
        // is exactly the post-`D*` portion and the remainder is exactly the
        // pre-`D*` (legacy) fresh.
        //
        // The legacy portion keeps today's O(1) window payout. The armed
        // portion CANNOT be paid from a window product — the D1 ceiling is
        // per-`(user, side, day)` ACROSS entries and depends on how much of
        // that day the user has already drawn, so a product would OVERSTATE
        // (overpay). It is handed to {_walkShareOfPoolDays} instead, and the
        // entry deliberately stays UNPROCESSED until that walk reaches
        // `endDay`.
        uint256 armedPortion = split.armedFresh + split.recycled;
        if (mutate && deferArmed && armedPortion != 0) {
            EntrySplit memory legacyOnly;
            legacyOnly.total = split.total - armedPortion; // pre-`D*` fresh only
            // Loan-side cap and forfeit-day accrual are the WALK's job here —
            // applying them now would double-count against the per-day path.
            if (legacyOnly.total != 0) {
                if (_isForfeited(s, e)) {
                    toTreasury = legacyOnly;
                } else {
                    toUser = legacyOnly;
                }
            }
            return (toUser, toTreasury);
        }

        if (mutate) e.processed = true;
        // #1061 P2 — route to treasury on an explicit forfeit OR a terminal
        // forfeit derived from an unclosed liquidation/default (so a liquidated
        // borrower can't collect via the {_entryClaimable} loan-terminal
        // fallback).
        if (e.forfeited || _entryTerminalForfeit(s, e)) {
            // #1353 (M2 PR-5c) — the loan-side cap bounds reward PAID TO A USER,
            // never a forfeit: a forfeited reward recycles to the bucket (it is
            // NOT emitted to the side), so it is not trimmed here (Codex #1371
            // r2). But its armed days STILL count toward the per-(loanId, side)
            // day union, so a mid-loan lender sale (whose outgoing slice is
            // forfeited by `transferLenderEntry`) does not understate the
            // incoming lender's cap proration (rev-15 union rule; Codex #1371 r7).
            if (mutate) _accrueForfeitArmedDays(s, e, split);
            toTreasury = split;
        } else {
            // #1353 (M2 PR-5c) — bound the WHOLE armed (post-`D*`) reward
            // (`armedFresh + recycled`) to the per-(loanId, side) lifetime
            // budget. `armedFresh` is left whole for full commitment retirement
            // (payout shrinks like a pool-truncated fresh share); the capped-off
            // recycled is routed to the treasury channel as a pure commitment
            // RELEASE. A solo fully-capped entry leaves the facet a commitment to
            // retire (no revert — Codex #1371 r6/r7). DARK until `D*`.
            if (mutate) {
                (toUser, toTreasury) = _applyLoanSideCap(s, e, split);
            } else {
                toUser = split;
            }
        }
    }

    /// @dev PR-3c — compute an entry window's capped reward decomposition
    ///      from the three cumulative series. Mixed pre/post-cutover
    ///      windows slice correctly by construction: pre-arming days
    ///      contribute 0 to both the recycled and armed cumulatives
    ///      (the redesign's D* day-slicing rule with no per-day loop).
    function _entryWindowSplit(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardEntry storage e
    ) private view returns (EntrySplit memory split) {
        uint256 cumEnd;
        uint256 cumStart;
        uint256 cumRecEnd;
        uint256 cumRecStart;
        uint256 cumArmEnd;
        uint256 cumArmStart;
        uint256 endD = e.endDay - 1;
        bool hasStart = e.startDay != 0;
        if (e.side == LibVaipakam.RewardSide.Lender) {
            cumEnd = s.cumMinLenderRpn18[endD];
            cumStart = hasStart ? s.cumMinLenderRpn18[e.startDay - 1] : 0;
            cumRecEnd = s.cumMinRecycledLenderRpn18[endD];
            cumRecStart =
                hasStart ? s.cumMinRecycledLenderRpn18[e.startDay - 1] : 0;
            cumArmEnd = s.cumMinArmedLenderRpn18[endD];
            cumArmStart =
                hasStart ? s.cumMinArmedLenderRpn18[e.startDay - 1] : 0;
        } else {
            cumEnd = s.cumMinBorrowerRpn18[endD];
            cumStart = hasStart ? s.cumMinBorrowerRpn18[e.startDay - 1] : 0;
            cumRecEnd = s.cumMinRecycledBorrowerRpn18[endD];
            cumRecStart =
                hasStart ? s.cumMinRecycledBorrowerRpn18[e.startDay - 1] : 0;
            cumArmEnd = s.cumMinArmedBorrowerRpn18[endD];
            cumArmStart =
                hasStart ? s.cumMinArmedBorrowerRpn18[e.startDay - 1] : 0;
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

    /// @dev View-only variant of the entry processing path (no advance).
    ///      #1008 (S13) — reads the CAPPED cumulative (`cumMin*Rpn18`), so it is
    ///      exactly the claim value once the cursor has reached `endDay-1`. As a
    ///      view it cannot advance the cursor, so on a not-yet-advanced finalized
    ///      day it returns 0 (under-reports, never over-reports — Codex #1147 r8 L3).
    function _previewEntryReward(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardEntry storage e
    ) private view returns (uint256 reward) {
        // #1002 (S4) — preview mirrors the claim gate: no reward until the loan
        // is actually over (matches {_processEntry} / {_entryClaimable}).
        if (!_entryClaimable(s, e)) return 0;
        if (e.startDay >= e.endDay) return 0;
        uint256 need = e.endDay - 1;
        if (
            e.side == LibVaipakam.RewardSide.Lender
                ? s.cumLenderCursor < need
                : s.cumBorrowerCursor < need
        ) return 0;
        // #1353 (M2 PR-5c) — preview the CLAIM value EXACTLY: build the same
        // {EntrySplit} the mutating path routes and apply the identical
        // armed-fresh trim (read-only). Matching the claim is load-bearing — the
        // expiry funding gate reads this via {userClaimFundingNeed}, and a
        // preview that diverged from the claim (e.g. an over-trim on a spanning
        // entry) could advance the expiry clock on a reward the claim would not
        // actually pay (Codex #1371 r2). DARK until `D*` is armed.
        EntrySplit memory split = _entryWindowSplit(s, e);
        if (split.total == 0) return 0;
        return _loanSideCapPreviewTotal(s, e, split);
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

    /// @dev #1353 (M2 PR-5c) — accrue a FORFEITED entry's armed days into the
    ///      per-(loanId, side) day union (a forfeit is not paid to the side and
    ///      never consumes the paid budget, but its window is part of the loan's
    ///      rewarded age — so the incoming lender's proration after a mid-loan
    ///      sale reflects old + new windows, not just its residual days; Codex
    ///      #1371 r7). Same STAMP/armed guards as {_applyLoanSideCap}.
    function _accrueForfeitArmedDays(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardEntry storage e,
        EntrySplit memory split
    ) private {
        if (split.armedFresh + split.recycled == 0) return; // no armed reward
        uint256 loanId = e.loanId;
        if (s.feeEntitlementByLoanId[loanId].openDays == 0) return; // unstamped
        uint8 side = uint8(e.side);
        s.loanSideRewardedDays[loanId][side] += _entryArmedDays(s, e);
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

    /// @dev MUTATING loan-side cap — bounds an entry's WHOLE post-`D*` armed
    ///      reward (`armedFresh + recycled`) to the remaining per-(loanId, side)
    ///      lifetime budget and persists the paid / armed-day accumulators. The
    ///      ceiling `½ × C* × (1 − m)` bounds the total post-cutover per-side
    ///      payout, so the RECYCLED portion is capped too, not just the fresh one
    ///      (Codex #1371 r7). The capped-off amount is PARTITIONED:
    ///        • capped-off fresh — `armedFresh` is left WHOLE on `userSplit` so
    ///          the facet retires the full fresh commitment (`consumeArmedFresh`)
    ///          while the payout `total` shrinks (retired-not-paid, like a
    ///          pool-truncated fresh share);
    ///        • capped-off recycled — routed out via the returned `recycleRelease`
    ///          split so the facet RELEASES its commitment
    ///          (`LibVpfiRecycle.releaseCommitment`) — no payout AND no bucket
    ///          credit (no `Ā` inflation, so no expiry-funding-gate ripple).
    ///      Both are empty of a cap effect (DARK) when the entry has no armed
    ///      reward or the loan is UNSTAMPED (`openDays == 0`), so an unstamped
    ///      loan is never zeroed. Fresh is paid before recycled.
    function _applyLoanSideCap(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardEntry storage e,
        EntrySplit memory split
    ) private returns (EntrySplit memory userSplit, EntrySplit memory recycleRelease) {
        userSplit = split;
        uint256 armedReward = split.armedFresh + split.recycled; // post-`D*` reward
        if (armedReward == 0) return (userSplit, recycleRelease); // pre-cutover only ⇒ dark
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
            return (userSplit, recycleRelease);
        }
        uint8 side = uint8(e.side);
        uint256 daysIncl =
            s.loanSideRewardedDays[loanId][side] + _entryArmedDays(s, e);
        // The armed-day union grows monotonically whether or not the split trims.
        s.loanSideRewardedDays[loanId][side] = daysIncl;
        uint256 capEff = _loanSideRewardCapEff(s, loanId, daysIncl);
        uint256 paid = s.loanSideRewardPaidVpfi[loanId][side];
        uint256 remaining = capEff > paid ? capEff - paid : 0;
        if (armedReward <= remaining) {
            s.loanSideRewardPaidVpfi[loanId][side] = paid + armedReward;
            return (userSplit, recycleRelease); // nothing capped
        }
        s.loanSideRewardPaidVpfi[loanId][side] = paid + remaining;
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

    /// @dev READ-ONLY loan-side cap for the preview path — returns the CLAIM's
    ///      trimmed user `total` for `split` without persisting, so the preview
    ///      exactly matches what the mutating claim would pay (load-bearing for
    ///      the expiry funding gate). Bounds the WHOLE armed reward
    ///      (`armedFresh + recycled`) like the claim. Skips unstamped loans and
    ///      entries with no armed reward, matching the claim's dark behaviour.
    function _loanSideCapPreviewTotal(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardEntry storage e,
        EntrySplit memory split
    ) private view returns (uint256) {
        uint256 armedReward = split.armedFresh + split.recycled;
        if (armedReward == 0) return split.total;
        uint256 loanId = e.loanId;
        // Unstamped marker is `openDays == 0` (see {_applyLoanSideCap}); a
        // stamped zero-`C*` dust loan is capped, not skipped (Codex #1371 r5).
        if (s.feeEntitlementByLoanId[loanId].openDays == 0) return split.total;
        uint8 side = uint8(e.side);
        uint256 daysIncl =
            s.loanSideRewardedDays[loanId][side] + _entryArmedDays(s, e);
        uint256 capEff = _loanSideRewardCapEff(s, loanId, daysIncl);
        uint256 paid = s.loanSideRewardPaidVpfi[loanId][side];
        uint256 remaining = capEff > paid ? capEff - paid : 0;
        return armedReward > remaining
            ? split.total - (armedReward - remaining)
            : split.total;
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
    ///         Prices off the finalized stamp, never a live re-derivation, so
    ///         the ceiling can't be computed from a different pool than the
    ///         rewards it bounds.
    function snapshotDayUserSideShareCap(uint256 dayId) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!_isArmedDay(s, dayId)) return;
        (uint256 freshHalf, uint256 recycledHalf, bool halt) =
            _dayPoolHalves(s, dayId);
        if (halt) return; // stamp not landed yet — leave C at 0 (pays nothing)
        // May legitimately be 0 on a dust / zero-emission day — which is exactly
        // why the MODE stamp, not this value, is the D1/legacy switch.
        s.dayUserSideCapVpfi18[dayId] =
            ((freshHalf + recycledHalf) *
                LibVaipakam.cfgUserSideShareCapBps()) /
            LibVaipakam.BASIS_POINTS;
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
        uint256 global = e.side == LibVaipakam.RewardSide.Lender
            ? s.knownGlobalLenderInterestNumeraire18[d]
            : s.knownGlobalBorrowerInterestNumeraire18[d];
        if (global == 0) return 0;
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
        uint256 rewardedDaysIncl
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
        uint256 paid = s.loanSideRewardPaidVpfi[loanId][uint8(side)];
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
        (uint256 freshHalf, uint256 recycledHalf, bool h) = _dayPoolHalves(s, d);
        if (h) return (0, 0, true);
        uint256 globalTotal = side == LibVaipakam.RewardSide.Lender
            ? s.knownGlobalLenderInterestNumeraire18[d]
            : s.knownGlobalBorrowerInterestNumeraire18[d];
        if (globalTotal == 0) return (0, 0, false);
        if (freshHalf != 0) {
            freshDaily = (freshHalf * 1e18) / globalTotal;
        }
        if (recycledHalf != 0) {
            recycledDaily = (recycledHalf * 1e18) / globalTotal;
        }
    }

    /// @dev Attribute one leg's VPFI total to its funding sources using the
    ///      day's composition. A ShareOfPool day is ARMED by construction (2a
    ///      only stamps the mode under {_isArmedDay}), so there is NO pre-`D*`
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
    struct DayCharge {
        EntrySplit toUser;
        EntrySplit toTreasury;
        EntrySplit cappedOff;
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

    /// @dev Where an entry's ShareOfPool day walk starts.
    ///
    ///      An UNSET cursor resolves to `max(startDay, D*)`, not `startDay`:
    ///      under the #1351 2c hybrid the pre-`D*` portion of a spanning entry
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
        uint256 recycledDaily
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
            bool isForfeit = _isForfeited(s, e);
            slices[i].loanSideChargeable = !isForfeit;
            if (isForfeit) {
                cEff[i] = v;
                freshCap[i] = vs.armedFresh;
            } else {
                uint256 lsr = _loanSideRemaining(
                    s,
                    e.loanId,
                    side,
                    s.loanSideRewardedDays[e.loanId][uint8(side)] + 1
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
    function _attributeLegs(
        DaySlice[] memory slices,
        uint256[] memory amounts,
        uint256[] memory freshCap,
        uint256[] memory cEff
    ) private pure returns (EntrySplit memory user_, EntrySplit memory treas_) {
        uint256 n = slices.length;
        for (uint256 i; i < n; ) {
            uint256 amt = amounts[i];
            // Fresh-first applies to the LOAN-SIDE trim only — it is already
            // baked into `freshCap`. The further pro-rata reduction here comes
            // from the D1 ceiling / pool, which is not a loan-side decision, so
            // it must preserve the composition of what SURVIVED that trim
            // rather than re-prioritising fresh. Scaling fresh-first here would
            // zero the recycled draw on any day whose ceiling binds hard, and
            // the day's recycled budget would then never be consumed at all.
            // RECYCLED floors, fresh takes the dust — the same direction as
            // {_splitDayAmount} and {_entryWindowSplit} (Codex #1399 r8 P2).
            // Flooring fresh instead would hand the rounding wei to recycled:
            // a 2-fresh/1-recycled survivor scaled to a 1-wei slice would
            // report 0 fresh / 1 recycled, overdrawing the bucket for a wei
            // that should never have left it — and potentially blocking on a
            // phantom recycled shortage.
            uint256 r = cEff[i] == 0
                ? 0
                : ((cEff[i] - freshCap[i]) * amt) / cEff[i];
            uint256 f = amt - r;
            // `loanSideChargeable` is stamped from the SHARED {_isForfeited} —
            // the same predicate `_processEntry` routes on. A borrower entry
            // that became claimable only via a Defaulted / InternalMatched
            // terminal keeps `e.forfeited == false`, so routing on that flag
            // alone would pay the BORROWER what the forfeit rules send to
            // treasury.
            if (slices[i].loanSideChargeable) {
                user_.total += amt;
                user_.armedFresh += f;
                user_.recycled += r;
            } else {
                treas_.total += amt;
                treas_.armedFresh += f;
                treas_.recycled += r;
            }
            unchecked { ++i; }
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
    ///                      `D*` CUTOVER (#1351 slice 2c, superseding the
    ///                      #1399 r5 note): an entry opened BEFORE `D*` and
    ///                      still open after it starts its ShareOfPool walk at
    ///                      `max(startDay, D*)` — resolved HERE by
    ///                      {_shareOfPoolCursorDay}, never pre-seeded into
    ///                      storage by a caller. Its pre-`D*` days are NOT
    ///                      skipped: they are paid by the O(1) window product,
    ///                      which is regime-separated by construction (pre-arm
    ///                      days contribute 0 to the armed/recycled
    ///                      cumulatives). Resolving the start in the primitive
    ///                      rather than trusting a stored value is what keeps
    ///                      the cursor check a real double-pay guard — a caller
    ///                      cannot hand it a jumped cursor.
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
    /// 1. `consumeArmedFresh` takes THREE terms. `_applyLoanSideCap` keeps
    ///    `armedFresh` WHOLE on its user split so the full commitment retires;
    ///    this primitive instead reports the trimmed part separately as
    ///    {DayCharge.cappedOff}. The sum is identical — but a caller that adds
    ///    only the two paid legs leaks a fresh commitment on every trimmed
    ///    entry, silently depressing later days' availability.
    /// 2. The facet derives fresh as `total − recycled` while this returns
    ///    `armedFresh` explicitly. They coincide ONLY because a ShareOfPool day
    ///    is armed by construction, so there is no pre-`D*` component. Do not
    ///    port this table to a legacy day.
    function processUserSideDay(
        address user,
        uint256 d,
        uint256[] memory entryIds,
        PoolBudget memory pool
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
            if (_shareOfPoolCursorDay(s, entryIds[i], v) != d) {
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

        uint256 c = s.dayUserSideCapVpfi18[d];
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
            s, entryIds, slices, side, d, freshDaily, recycledDaily
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
        (EntrySplit memory user_, EntrySplit memory treas_) =
            _attributeLegs(slices, amounts, freshCap, cEff);

        // ALL-OR-NOTHING vs the pool — do NOT advance, so this day is retried
        // once the pool refills.
        //
        // Checked PER SOURCE, because fresh and recycled reward come from
        // physically different places: a mixed day that fits the combined
        // remainder can still be short of one alone.
        //
        // Codex #1399 r6 P2 — and checked against the EXACT leg totals, not
        // against a split of `budget`. Each leg floors its recycled share
        // independently, and fresh is the subtraction remainder, so a set
        // holding BOTH payable and forfeited entries can draw a wei or two more
        // fresh than a single split of `budget` predicts. `consumeArmedFresh`
        // floors at zero and would absorb that silently — which is exactly why
        // it must not be relied on here: the pool is a real balance, and
        // "off by a wei, absorbed downstream" is how a drift becomes
        // unattributable. Compute the legs first, then check what will
        // ACTUALLY be drawn.
        //
        // `cappedOff` is deliberately absent: it moves no tokens (it only
        // retires commitments), so it draws nothing from the pool.
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
        if (
            pool.fresh < user_.armedFresh + treas_.armedFresh ||
            pool.recycled < user_.recycled
        ) {
            return (charge, slices);
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
