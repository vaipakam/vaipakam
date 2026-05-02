// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/**
 * @title LibInteractionRewards
 * @author Vaipakam Developer Team
 * @notice Phase-2 platform-interaction reward accounting
 *         (docs/TokenomicsTechSpec.md §4 per-day accrual). Replaces the
 *         Phase-1 "lump-sum-at-settlement" model with a delta-driven
 *         daily accrual:
 *
 *           - registerLoan (LoanFacet.initiateLoan) snapshots the loan's
 *             `perDayUSD18` and applies +Δ at startDay, −Δ at endDay.
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
 *        reward = perDayUSD18 × (cumRPU[endDay-1] − cumRPU[startDay-1]) / 1e18
 *      where cumRPU[d] = Σ_{d'≤d} halfPool[d'] × 1e18 / globalTotalUSD18[d']
 *      and the global denominator comes from the cross-chain finalized
 *      broadcast (`knownGlobal*InterestUSD18[d]`).
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
 *      Legacy per-day counter API (userLenderInterestUSD18 /
 *      totalLenderInterestUSD18 etc.) is retained for the cross-chain
 *      reporter and for test harnesses that seed per-day state directly
 *      via {TestMutatorFacet.setDailyLenderInterest}. The legacy claim
 *      path ({claimForUserWindow}) coexists with the new entry claim
 *      path ({claimForUserEntries}); the facet sums both.
 */
library LibInteractionRewards {
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
        uint256 usd = _interestToUSD18(feeAsset, interestAmount);
        if (usd == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.userLenderInterestUSD18[day][lender] += usd;
        s.totalLenderInterestUSD18[day] += usd;
    }

    /// @notice [LEGACY] Mirror of {recordLenderInterest} for borrower side.
    function recordBorrowerInterest(
        address borrower,
        address feeAsset,
        uint256 interestAmount
    ) internal {
        (uint256 day, bool active) = currentDayOrZero();
        if (!active) return;
        uint256 usd = _interestToUSD18(feeAsset, interestAmount);
        if (usd == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.userBorrowerInterestUSD18[day][borrower] += usd;
        s.totalBorrowerInterestUSD18[day] += usd;
    }

    // ─── Phase-2 reward entry registration / close / transfer ───────────────

    /**
     * @notice Register a newly-initiated loan with the Phase-2 per-day
     *         accrual machinery. Silent no-op when:
     *           - emissions haven't been seeded (launch timestamp zero);
     *           - the principal asset has no Chainlink feed / malformed
     *             decimals (perDayUSD18 rounds to zero);
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

        uint256 perDayUSD18 = _perDayInterestUSD18(
            principalAsset,
            principal,
            interestRateBps
        );
        if (perDayUSD18 == 0) return;

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
            perDayUSD18
        );
        s.loanActiveLenderEntryId[loanId] = lenderId;

        uint256 borrowerId = _allocEntry(
            s,
            borrower,
            loanId,
            startDay,
            endDay,
            LibVaipakam.RewardSide.Borrower,
            perDayUSD18
        );
        s.loanBorrowerEntryId[loanId] = borrowerId;

        // Only apply deltas that lie in the future relative to the
        // reporter frontier. Past deltas can't retroactively change an
        // already-shipped day's total.
        _applyDelta(s.lenderPerDayDeltaUSD18, s.lenderFrontierDay, startDay, int256(perDayUSD18));
        _applyDelta(s.lenderPerDayDeltaUSD18, s.lenderFrontierDay, endDay, -int256(perDayUSD18));
        _applyDelta(s.borrowerPerDayDeltaUSD18, s.borrowerFrontierDay, startDay, int256(perDayUSD18));
        _applyDelta(s.borrowerPerDayDeltaUSD18, s.borrowerFrontierDay, endDay, -int256(perDayUSD18));
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

        uint256 lenderId = s.loanActiveLenderEntryId[loanId];
        if (lenderId != 0) {
            _closeEntry(
                s,
                lenderId,
                today,
                /* forfeited */ lenderForfeit,
                s.lenderPerDayDeltaUSD18,
                s.lenderFrontierDay
            );
            s.loanActiveLenderEntryId[loanId] = 0;
        }
        uint256 borrowerId = s.loanBorrowerEntryId[loanId];
        if (borrowerId != 0) {
            _closeEntry(
                s,
                borrowerId,
                today,
                /* forfeited */ !borrowerClean,
                s.borrowerPerDayDeltaUSD18,
                s.borrowerFrontierDay
            );
            // Leave s.loanBorrowerEntryId set so {sweepForfeitedByLoanId}
            // can still locate it after close.
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
        uint256 perDay = oldEntry.perDayUSD18;

        // Shrink the old entry at today+1 (or earlier if already closed).
        _closeEntry(
            s,
            oldId,
            today,
            /* forfeited */ true,
            s.lenderPerDayDeltaUSD18,
            s.lenderFrontierDay
        );

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
        // Deltas already account for the full original window: the old
        // entry's close reverses the end-delta at originalEnd and stamps
        // a fresh end-delta at newStart; we now RE-apply matching deltas
        // for the new entry so the net denominator contribution is
        // preserved across the transfer.
        _applyDelta(s.lenderPerDayDeltaUSD18, s.lenderFrontierDay, newStart, int256(perDay));
        _applyDelta(s.lenderPerDayDeltaUSD18, s.lenderFrontierDay, originalEnd, -int256(perDay));
    }

    // ─── Frontier advance (local totals + cum-per-USD) ──────────────────────

    /**
     * @notice Advance the lender side's per-day local-total frontier
     *         through `through`. Applies each pending delta and writes
     *         `totalLenderInterestUSD18[d] += openPerDayUSD18` for every
     *         advanced day. ADDITIVE so legacy test mutators that seed
     *         `totalLenderInterestUSD18[d]` directly aren't overwritten.
     *
     *         Called by the cross-chain reporter before shipping a day's
     *         local total, and by claim/preview paths that need the
     *         local totals to be in sync before computing cumRPU.
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

        uint256 open = s.lenderOpenPerDayUSD18;
        for (uint256 d = frontier + 1; d <= through; ) {
            int256 delta = s.lenderPerDayDeltaUSD18[d];
            if (delta != 0) {
                open = uint256(int256(open) + delta);
            }
            s.totalLenderInterestUSD18[d] += open;
            unchecked { ++d; }
        }
        s.lenderOpenPerDayUSD18 = open;
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

        uint256 open = s.borrowerOpenPerDayUSD18;
        for (uint256 d = frontier + 1; d <= through; ) {
            int256 delta = s.borrowerPerDayDeltaUSD18[d];
            if (delta != 0) {
                open = uint256(int256(open) + delta);
            }
            s.totalBorrowerInterestUSD18[d] += open;
            unchecked { ++d; }
        }
        s.borrowerOpenPerDayUSD18 = open;
        s.borrowerFrontierDay = through;
    }

    /**
     * @notice Advance the lender-side cumulative-reward-per-USD cursor
     *         through `through`. Uses the GLOBAL finalized denominator
     *         (`knownGlobalLenderInterestUSD18[d]`) so cross-chain
     *         correctness is preserved. Halts at the first day without
     *         `knownGlobalSet[d]`. Bounded at {MAX_CUM_ADVANCE_DAYS}.
     *
     * @param through Day index to advance through (inclusive).
     * @return reached Highest day actually reached (may be < `through`
     *                 if the finalization gate or per-call cap intervened).
     */
    function advanceCumLenderThrough(uint256 through)
        internal
        returns (uint256 reached)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 cursor = s.cumLenderCursor;
        if (through <= cursor) return cursor;
        uint256 cap = cursor + MAX_CUM_ADVANCE_DAYS;
        if (through > cap) through = cap;

        uint256 prev = cursor == 0 ? 0 : s.cumLenderRPU18[cursor];
        for (uint256 d = cursor + 1; d <= through; ) {
            if (!s.knownGlobalSet[d]) break;
            uint256 globalTotal = s.knownGlobalLenderInterestUSD18[d];
            uint256 half = halfPoolForDay(d);
            uint256 next;
            if (globalTotal == 0 || half == 0) {
                next = prev; // no contribution on day d
            } else {
                next = prev + (half * 1e18) / globalTotal;
            }
            s.cumLenderRPU18[d] = next;
            prev = next;
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

        uint256 prev = cursor == 0 ? 0 : s.cumBorrowerRPU18[cursor];
        for (uint256 d = cursor + 1; d <= through; ) {
            if (!s.knownGlobalSet[d]) break;
            uint256 globalTotal = s.knownGlobalBorrowerInterestUSD18[d];
            uint256 half = halfPoolForDay(d);
            uint256 next;
            if (globalTotal == 0 || half == 0) {
                next = prev;
            } else {
                next = prev + (half * 1e18) / globalTotal;
            }
            s.cumBorrowerRPU18[d] = next;
            prev = next;
            cursor = d;
            unchecked { ++d; }
        }
        s.cumBorrowerCursor = cursor;
        return cursor;
    }

    // ─── Claim / preview (entry path + legacy window path) ──────────────────

    /**
     * @notice Walk `user`'s reward entries and route each CLOSED entry
     *         whose endDay is finalized in the cumRPU cursor. Processed
     *         entries are flagged so follow-up claims don't re-credit.
     *         Forfeited entries accumulate in `treasuryTotal` (payout is
     *         made separately by the facet wrapping this helper).
     *
     * @param user User being claimed for.
     * @return userTotal     VPFI wei accruing to `user`.
     * @return treasuryTotal VPFI wei routed to treasury (forfeits).
     */
    function claimForUserEntries(address user)
        internal
        returns (uint256 userTotal, uint256 treasuryTotal)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage ids = s.userRewardEntryIds[user];
        uint256 len = ids.length;

        uint256 capRatio = LibVaipakam.getInteractionCapVpfiPerEth();
        (uint256 ethPriceRaw, uint8 ethPriceDec) = _ethUsdPriceRawAndDec();

        for (uint256 i = 0; i < len; ) {
            uint256 id = ids[i];
            (uint256 toUser, uint256 toTreasury) = _processEntry(
                s,
                id,
                capRatio,
                ethPriceRaw,
                ethPriceDec,
                /* mutate */ true
            );
            userTotal += toUser;
            treasuryTotal += toTreasury;
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

        uint256 capRatio = LibVaipakam.getInteractionCapVpfiPerEth();
        (uint256 ethPriceRaw, uint8 ethPriceDec) = _ethUsdPriceRawAndDec();

        for (uint256 i = 0; i < len; ) {
            uint256 id = ids[i];
            LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
            if (!e.processed && e.endDay != 0 && !e.forfeited) {
                uint256 reward = _previewEntryReward(
                    s,
                    e,
                    capRatio,
                    ethPriceRaw,
                    ethPriceDec
                );
                userTotal += reward;
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
     * @return treasuryTotal VPFI wei routed to treasury by this sweep.
     */
    function sweepForfeitedByLoanId(uint256 loanId)
        internal
        returns (uint256 treasuryTotal)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 capRatio = LibVaipakam.getInteractionCapVpfiPerEth();
        (uint256 ethPriceRaw, uint8 ethPriceDec) = _ethUsdPriceRawAndDec();

        uint256 lenderId = s.loanActiveLenderEntryId[loanId];
        if (lenderId != 0) {
            (, uint256 t) = _processEntry(
                s,
                lenderId,
                capRatio,
                ethPriceRaw,
                ethPriceDec,
                /* mutate */ true
            );
            treasuryTotal += t;
        }
        uint256 borrowerId = s.loanBorrowerEntryId[loanId];
        if (borrowerId != 0) {
            (, uint256 t) = _processEntry(
                s,
                borrowerId,
                capRatio,
                ethPriceRaw,
                ethPriceDec,
                /* mutate */ true
            );
            treasuryTotal += t;
        }
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
                uint256 myL = s.userLenderInterestUSD18[d][user];
                if (myL > 0 && totalL > 0) {
                    uint256 raw = (half * myL) / totalL;
                    uint256 cap = _capVPFIForInterestUSD(
                        myL,
                        ethPriceRaw,
                        ethPriceDec,
                        capRatio
                    );
                    total += raw < cap ? raw : cap;
                    delete s.userLenderInterestUSD18[d][user];
                }
                uint256 myB = s.userBorrowerInterestUSD18[d][user];
                if (myB > 0 && totalB > 0) {
                    uint256 raw = (half * myB) / totalB;
                    uint256 cap = _capVPFIForInterestUSD(
                        myB,
                        ethPriceRaw,
                        ethPriceDec,
                        capRatio
                    );
                    total += raw < cap ? raw : cap;
                    delete s.userBorrowerInterestUSD18[d][user];
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
                uint256 myL = s.userLenderInterestUSD18[d][user];
                if (myL > 0 && totalL > 0) {
                    uint256 raw = (half * myL) / totalL;
                    uint256 cap = _capVPFIForInterestUSD(
                        myL,
                        ethPriceRaw,
                        ethPriceDec,
                        capRatio
                    );
                    total += raw < cap ? raw : cap;
                }
                uint256 myB = s.userBorrowerInterestUSD18[d][user];
                if (myB > 0 && totalB > 0) {
                    uint256 raw = (half * myB) / totalB;
                    uint256 cap = _capVPFIForInterestUSD(
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
            s.knownGlobalLenderInterestUSD18[d],
            s.knownGlobalBorrowerInterestUSD18[d]
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
    function poolRemaining() internal view returns (uint256) {
        uint256 paidOut = LibVaipakam.storageSlot().interactionPoolPaidOut;
        return
            LibVaipakam.VPFI_INTERACTION_POOL_CAP > paidOut
                ? LibVaipakam.VPFI_INTERACTION_POOL_CAP - paidOut
                : 0;
    }

    // ─── Internals ───────────────────────────────────────────────────────────

    /// @dev Process (or preview) a single reward entry. When `mutate`,
    ///      flips `processed = true` and returns the routed amounts;
    ///      otherwise returns the pending amount for the user side only
    ///      (treasury never "previews").
    function _processEntry(
        LibVaipakam.Storage storage s,
        uint256 id,
        uint256 capRatio,
        uint256 ethPriceRaw,
        uint8 ethPriceDec,
        bool mutate
    ) private returns (uint256 toUser, uint256 toTreasury) {
        LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
        if (e.processed) return (0, 0);
        if (e.endDay == 0) return (0, 0); // still open
        if (e.startDay >= e.endDay) {
            if (mutate) e.processed = true;
            return (0, 0);
        }

        // Need cumRPU populated through endDay - 1 for the matching side.
        uint256 need = e.endDay - 1;
        uint256 cursor;
        if (e.side == LibVaipakam.RewardSide.Lender) {
            cursor = s.cumLenderCursor;
            if (cursor < need) {
                // Try to extend; may not be possible if globals not finalized.
                cursor = advanceCumLenderThrough(need);
            }
            if (cursor < need) return (0, 0);
        } else {
            cursor = s.cumBorrowerCursor;
            if (cursor < need) {
                cursor = advanceCumBorrowerThrough(need);
            }
            if (cursor < need) return (0, 0);
        }

        uint256 cumEnd;
        uint256 cumStart;
        if (e.side == LibVaipakam.RewardSide.Lender) {
            cumEnd = s.cumLenderRPU18[e.endDay - 1];
            cumStart = e.startDay == 0 ? 0 : s.cumLenderRPU18[e.startDay - 1];
        } else {
            cumEnd = s.cumBorrowerRPU18[e.endDay - 1];
            cumStart = e.startDay == 0 ? 0 : s.cumBorrowerRPU18[e.startDay - 1];
        }
        if (cumEnd <= cumStart) {
            if (mutate) e.processed = true;
            return (0, 0);
        }

        uint256 reward = (e.perDayUSD18 * (cumEnd - cumStart)) / 1e18;

        // Apply the §4 per-user daily cap, scaled to the entry window:
        // cap = daysInWindow * capVPFIForPerDayUSD(perDayUSD18).
        uint256 daysInWindow = e.endDay - e.startDay;
        uint256 perDayCap = _capVPFIForInterestUSD(
            e.perDayUSD18,
            ethPriceRaw,
            ethPriceDec,
            capRatio
        );
        if (perDayCap != type(uint256).max) {
            uint256 windowCap = perDayCap * daysInWindow;
            if (reward > windowCap) reward = windowCap;
        }

        if (mutate) e.processed = true;
        if (e.forfeited) {
            toTreasury = reward;
        } else {
            toUser = reward;
        }
    }

    /// @dev View-only variant of the entry processing path (no advance).
    function _previewEntryReward(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardEntry storage e,
        uint256 capRatio,
        uint256 ethPriceRaw,
        uint8 ethPriceDec
    ) private view returns (uint256 reward) {
        if (e.startDay >= e.endDay) return 0;
        uint256 need = e.endDay - 1;
        uint256 cumEnd;
        uint256 cumStart;
        if (e.side == LibVaipakam.RewardSide.Lender) {
            if (s.cumLenderCursor < need) return 0;
            cumEnd = s.cumLenderRPU18[e.endDay - 1];
            cumStart = e.startDay == 0 ? 0 : s.cumLenderRPU18[e.startDay - 1];
        } else {
            if (s.cumBorrowerCursor < need) return 0;
            cumEnd = s.cumBorrowerRPU18[e.endDay - 1];
            cumStart = e.startDay == 0 ? 0 : s.cumBorrowerRPU18[e.startDay - 1];
        }
        if (cumEnd <= cumStart) return 0;
        reward = (e.perDayUSD18 * (cumEnd - cumStart)) / 1e18;

        uint256 perDayCap = _capVPFIForInterestUSD(
            e.perDayUSD18,
            ethPriceRaw,
            ethPriceDec,
            capRatio
        );
        if (perDayCap != type(uint256).max) {
            uint256 daysInWindow = e.endDay - e.startDay;
            uint256 windowCap = perDayCap * daysInWindow;
            if (reward > windowCap) reward = windowCap;
        }
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
        uint256 perDayUSD18
    ) private returns (uint256 id) {
        id = ++s.nextRewardEntryId;
        LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
        e.user = user;
        e.loanId = uint64(loanId);
        e.startDay = uint32(startDay);
        e.endDay = uint32(endDay);
        e.side = side;
        e.perDayUSD18 = perDayUSD18;
        // processed/forfeited default to false
        s.userRewardEntryIds[user].push(id);
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
        if (e.endDay == 0) return; // already closed somehow; no-op
        uint256 originalEnd = e.endDay;
        uint256 newEnd = today + 1;
        if (newEnd >= originalEnd) newEnd = originalEnd; // natural close or late
        if (newEnd < e.startDay) newEnd = e.startDay;    // closed before accrual began

        if (newEnd != originalEnd) {
            uint256 perDay = e.perDayUSD18;
            _applyDelta(deltas, frontier, originalEnd, int256(perDay));
            _applyDelta(deltas, frontier, newEnd, -int256(perDay));
            e.endDay = uint32(newEnd);
        }
        if (forfeited) e.forfeited = true;
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

    /// @dev Compute per-day USD18 interest for a loan at register time.
    ///      Annualized bps divided by 365; principal converted at
    ///      Chainlink spot. Returns 0 on any oracle / decimals failure
    ///      so {registerLoan} silently skips.
    function _perDayInterestUSD18(
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

        // principalUSD18 = principal * price * 1e18 / (10^feedDec * 10^tokenDec)
        uint256 principalUSD18 =
            (principal * price * 1e18) /
            (10 ** feedDec) /
            (10 ** tokenDec);
        // perDayUSD18 = principalUSD18 * bps / BASIS_POINTS / 365
        return
            (principalUSD18 * interestRateBps) /
            LibVaipakam.BASIS_POINTS /
            365;
    }

    /// @dev Best-effort USD conversion at Chainlink spot (legacy).
    function _interestToUSD18(address feeAsset, uint256 interestAmount)
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
        return (uint256(answer), dec);
    }

    /// @dev VPFI-wei ceiling for a single (user, side, day) branch per
    ///      docs/TokenomicsTechSpec.md §4. Returns `type(uint256).max`
    ///      when the cap is disabled (ETH feed unavailable or admin
    ///      override == max sentinel).
    function _capVPFIForInterestUSD(
        uint256 interestUSD18,
        uint256 ethPriceRaw,
        uint8 feedDec,
        uint256 capRatio
    ) private pure returns (uint256 cap) {
        if (ethPriceRaw == 0 || capRatio == type(uint256).max) {
            return type(uint256).max;
        }
        return (interestUSD18 * (10 ** feedDec) * capRatio) / ethPriceRaw;
    }
}
