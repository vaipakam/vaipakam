// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

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
                _processEntry(s, ids[i], /* mutate */ true);
            toUser.total += u.total;
            toUser.recycled += u.recycled;
            toUser.armedFresh += u.armedFresh;
            toTreasury.total += t.total;
            toTreasury.recycled += t.recycled;
            toTreasury.armedFresh += t.armedFresh;
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
            (, EntrySplit memory t) = _processEntry(s, lenderId, true);
            _foldSplit(toTreasury, t);
        }
        uint256 borrowerId = s.loanBorrowerEntryId[loanId];
        if (borrowerId != 0 && _isForfeited(s, s.rewardEntries[borrowerId])) {
            (, EntrySplit memory t) = _processEntry(s, borrowerId, true);
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
                (, EntrySplit memory t) = _processEntry(s, orphaned[i], true);
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
        uint256 cappedFresh =
            freshShare < freshHeadroom ? freshShare : freshHeadroom;
        // Claim-EXECUTABLE gate: the accumulator only ever advances while a
        // claim would actually succeed right now. Three ways it can't:
        //   1. the POST-CAP payable is zero (a claim truncates its fresh
        //      component to remaining pool capacity — the face value is the
        //      wrong bar — and a wholly-uncreditable fresh entry pays
        //      nothing),
        //   2. the local VPFI balance can't cover it (mirror mid-
        //      remittance-outage — the claim's terminal transfer reverts),
        //   3. the owner is sanctioned — the claim path rejects them via
        //      `_assertNotSanctioned` (frozen, not seized: a delist re-opens
        //      the clock).
        uint256 payableNow = cappedFresh + split_.recycled;
        bool executable = payableNow != 0 &&
            !LibVaipakam.isSanctionedAddress(e.user) &&
            IERC20Metadata(s.vpfiToken).balanceOf(address(this)) >= payableNow;

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
        // to trust as continuous; anything else is dropped.
        if (!s.rewardEntryObsBlocked[id]) {
            uint256 gap = block.timestamp - uint256(lastObs);
            if (
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

        // Never terminalise an entry whose FRESH share cannot be credited
        // at all: with the batch's fresh headroom exhausted an all-fresh
        // entry would be processed with ZERO bucket credit — value
        // silently burned. Defer instead (entry stays live). A PARTIAL
        // cap still processes (one bounded boundary entry per batch,
        // identical to the claim path's truncation).
        if (freshShare > 0 && cappedFresh == 0) {
            return (expired, 0);
        }
        expired = split_;
        freshCredited = cappedFresh;
        e.processed = true;
        emit RewardEntryExpired(id, e.user, expired.total, expired.recycled);
    }

    /// @notice RL-3 — UX view: the entry's horizon state for the
    ///         claim-center countdown.
    /// @return firstClaimableAt Accumulator start (0 = not started).
    /// @return expiresAt        The earliest instant the entry could be
    ///                          terminally removed ASSUMING it stays
    ///                          continuously claim-executable from now (0 =
    ///                          dark, unstarted, OR already processed —
    ///                          claimed/expired entries carry no countdown).
    ///                          Because removal is gated on EXECUTABLE-
    ///                          elapsed time — which only advances while a
    ///                          claim would succeed and keepers observe it —
    ///                          this is a forward estimate, not a fixed
    ///                          deadline: a funding outage or sanction pauses
    ///                          it (the pending heartbeat interval is only
    ///                          folded in when the entry is executable now).
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
            // A sweep now would reconcile the reconfiguration: cap and
            // re-baseline, crediting nothing this interval.
            if (elapsed > hSec) elapsed = hSec;
        } else if (
            !s.rewardEntryObsBlocked[id] &&
            !LibVaipakam.isSanctionedAddress(e.user)
        ) {
            // Fold in the pending interval a sweep-now would credit — but
            // ONLY if the entry is plausibly claim-executable at this block.
            // A sanctioned owner can't claim, so a sweep credits nothing and
            // neither does the countdown (it stays paused). Funding is not
            // re-checked here: on the canonical chain the balance is the
            // whole reward pool (never blocks), and the mirror partial-
            // underfunding view-pause is the deferred #1332 aggregate-
            // funding domain (Codex #1317 r11).
            uint256 gap =
                block.timestamp - uint256(s.rewardEntryExecObsAt[id]);
            if (
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
    function _processEntry(
        LibVaipakam.Storage storage s,
        uint256 id,
        bool mutate
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

        if (mutate) e.processed = true;
        // #1061 P2 — route to treasury on an explicit forfeit OR a terminal
        // forfeit derived from an unclosed liquidation/default (so a liquidated
        // borrower can't collect via the {_entryClaimable} loan-terminal
        // fallback).
        if (e.forfeited || _entryTerminalForfeit(s, e)) {
            toTreasury = split;
        } else {
            toUser = split;
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
        uint256 cumEnd;
        uint256 cumStart;
        if (e.side == LibVaipakam.RewardSide.Lender) {
            if (s.cumLenderCursor < need) return 0;
            cumEnd = s.cumMinLenderRpn18[e.endDay - 1];
            cumStart = e.startDay == 0 ? 0 : s.cumMinLenderRpn18[e.startDay - 1];
        } else {
            if (s.cumBorrowerCursor < need) return 0;
            cumEnd = s.cumMinBorrowerRpn18[e.endDay - 1];
            cumStart = e.startDay == 0 ? 0 : s.cumMinBorrowerRpn18[e.startDay - 1];
        }
        if (cumEnd <= cumStart) return 0;
        reward = (e.perDayNumeraire18 * (cumEnd - cumStart)) / 1e18;
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
        t = _computeDayCapThreshold18();
        LibVaipakam.storageSlot().dayCapThreshold18[dayId] = t;
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
