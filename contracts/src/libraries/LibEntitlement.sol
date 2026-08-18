// src/libraries/LibEntitlement.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title LibEntitlement
 * @notice Centralizes the accrued-interest and fee-split arithmetic reused
 *         across Repay, Preclose, Refinance, PartialWithdrawal, Risk, and
 *         Defaulted facets.
 * @dev Pure / view helpers only — callers are responsible for state writes
 *      (transfers, vault routing, claim bookkeeping). Keeping the math in
 *      one place means one rounding model, one off-by-one surface, and one
 *      place to audit when the interest / fee policy changes.
 */
library LibEntitlement {
    /// @notice Full-term interest: `principal * rateBps * durationDays / (DAYS_PER_YEAR * BASIS_POINTS)`.
    /// @dev Used when the loan is repaid-early-but-owes-full-term (README: lender
    ///      is made whole on duration) or at refinance when alice owes the old
    ///      lender the full promised coupon.
    function fullTermInterest(
        uint256 principal,
        uint256 rateBps,
        uint256 durationDays
    ) internal pure returns (uint256) {
        return
            (principal * rateBps * durationDays) /
            (LibVaipakam.DAYS_PER_YEAR * LibVaipakam.BASIS_POINTS);
    }

    /// @notice Seconds-precise pro-rata interest: `principal * rateBps *
    ///         elapsedSeconds / (SECONDS_PER_YEAR * BASIS_POINTS)`.
    /// @dev    The seconds-granularity twin of {proRataInterest}. Shared by the
    ///         preclose obligation-transfer (Option 2) + offset (Option 3)
    ///         settlement math so the identical formula isn't inlined six times
    ///         in `PrecloseFacet` (which sits right at the EIP-170 ceiling).
    function proRataInterestSeconds(
        uint256 principal,
        uint256 rateBps,
        uint256 elapsedSeconds
    ) internal pure returns (uint256) {
        return
            (principal * rateBps * elapsedSeconds) /
            (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
    }

    /// @notice Pro-rata interest over `elapsedDays` (integer days).
    function proRataInterest(
        uint256 principal,
        uint256 rateBps,
        uint256 elapsedDays
    ) internal pure returns (uint256) {
        return
            (principal * rateBps * elapsedDays) /
            (LibVaipakam.DAYS_PER_YEAR * LibVaipakam.BASIS_POINTS);
    }

    /// @notice #641 — a loan's interest-accrual origin: the dedicated
    ///         `interestAccrualStart` clock (re-stamped by partials WITHOUT
    ///         moving the term/maturity), falling back to `startTime` for loans
    ///         that predate the field. `interestAccrualStart` is set to a real
    ///         timestamp at origination, so `!= 0` cleanly distinguishes a
    ///         post-#641 loan (use the clock, even if `interestRemainingDays`
    ///         legitimately reached 0) from a legacy one.
    function _accrualStart(LibVaipakam.Loan storage loan) private view returns (uint256) {
        return loan.interestAccrualStart != 0
            ? uint256(loan.interestAccrualStart)
            : uint256(loan.startTime);
    }

    /// @notice #641 — a loan's remaining interest term in days: the dedicated
    ///         `interestRemainingDays` (re-stamped by partials), falling back to
    ///         the live `durationDays` for pre-field loans. Gated on
    ///         `interestAccrualStart` (NOT `interestRemainingDays != 0`) so a
    ///         post-#641 loan whose remaining term has reached 0 isn't mistaken
    ///         for a legacy loan.
    function _remainingTermDays(LibVaipakam.Loan storage loan) private view returns (uint256) {
        return loan.interestAccrualStart != 0
            ? uint256(loan.interestRemainingDays)
            : loan.durationDays;
    }

    /// @notice Pro-rata interest accrued on an ERC-20 loan from its interest-
    ///         accrual clock to `nowTime`, rounded down to whole days.
    function accruedInterestToTime(
        LibVaipakam.Loan storage loan,
        uint256 nowTime
    ) internal view returns (uint256) {
        uint256 accrualStart = _accrualStart(loan);
        if (nowTime <= accrualStart) return 0;
        uint256 elapsedDays = (nowTime - accrualStart) / LibVaipakam.ONE_DAY;
        return proRataInterest(loan.principal, loan.interestRateBps, elapsedDays);
    }

    /// @notice Seconds-precise current borrow balance — `principal +
    ///         continuously-accrued interest` from `loan.startTime` to now.
    /// @dev    DISTINCT from {accruedInterestToTime}: the HF / liquidation
    ///         paths accrue interest by the *second* (`elapsed /
    ///         SECONDS_PER_YEAR`) so a loan's debt — and therefore its
    ///         liquidation proceeds split — is exact at the block of
    ///         liquidation, whereas settlement-time math rounds down to
    ///         whole days (borrower-favourable). Do not substitute one for
    ///         the other: it would shift the liquidation debt by up to a
    ///         day's interest. Rounds DOWN (borrower-favourable by <=1 wei),
    ///         multiplying first to preserve numerator precision. Shared by
    ///         {RiskFacet} (HF / single-route + partial liquidation) and
    ///         {RiskMatchLiquidationFacet} (split-route liquidation) since
    ///         the #66 facet split — one accrual model, one audit surface.
    function currentBorrowBalance(
        LibVaipakam.Loan memory loan
    ) internal view returns (uint256) {
        // #641 — accrue from the interest clock (see `_accrualStart`); inlined
        // here because this overload takes `Loan memory`, not storage.
        uint256 accrualStart = loan.interestAccrualStart != 0
            ? uint256(loan.interestAccrualStart)
            : uint256(loan.startTime);
        uint256 elapsed = block.timestamp > accrualStart
            ? block.timestamp - accrualStart
            : 0;
        uint256 accruedInterest = (loan.principal *
            loan.interestRateBps *
            elapsed) / (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
        // #915 (M7) — credit interest already forwarded to the lender via
        // periodic auto-liquidation (`loan.interestSettled`, saturating at 0)
        // so the HF / forced-close debt does not double-count it. The accrual
        // clock is NOT reset by periodic settlement, so the raw `accruedInterest`
        // still spans the settled periods; subtracting the settled portion here
        // gives every HF read + single/split liquidation the same net-of-settled
        // debt the proper-close paths already use via `settlementInterestNet`.
        uint256 settled = uint256(loan.interestSettled);
        uint256 netInterest = accruedInterest > settled ? accruedInterest - settled : 0;
        return loan.principal + netInterest;
    }

    /// @notice #408/#410/#413 (2026-06-12) — Gross interest owed on an
    ///         ERC-20 loan at settlement time, per the full-term FLOOR
    ///         model:
    ///
    ///         ```
    ///         floorDays     = useFullTermInterest ? durationDays : 0
    ///         effectiveDays = max(elapsedDays, floorDays)
    ///         gross         = proRataInterest(P, rate, effectiveDays)
    ///         ```
    ///
    ///         Callers (`LibSettlement.computePreclose` /
    ///         `computeRepayment`) subtract `loan.interestSettled`
    ///         (saturating at 0) before splitting treasury/lender so
    ///         interest already paid via partial-repay or periodic
    ///         settlement is credited exactly once.
    ///
    ///         Branches:
    ///         - Early repay (elapsed < duration, flag on) → effective
    ///           = duration → full-term floor. Lender made whole at
    ///           the original commitment ceiling.
    ///         - At maturity → identical to full-term.
    ///         - In grace (elapsed > duration) → effective = elapsed →
    ///           interest keeps accruing past full-term. (Late fee +
    ///           treasury split stay additive on top, unchanged.)
    ///         - Lender opt-out (`useFullTermInterest = false`) →
    ///           floorDays = 0 → pure pro-rata-elapsed. Both branches
    ///           still accrue through grace.
    ///
    ///         Pre-#408 the `true` branch returned `fullTermInterest`
    ///         directly, capping interest at the duration — blocked
    ///         grace accrual + over-charged on preclose after partial
    ///         (ignored `interestSettled`). The floor + accumulator-
    ///         credit pair fixes both.
    ///
    ///         Partial-repay accounting (Option A): #641 moved the
    ///         remaining-term counter off `durationDays` onto the dedicated
    ///         `interestRemainingDays` (decremented in `RepayFacet.repayPartial`
    ///         / partial liquidation / swap-to-repay by elapsed-since-last-
    ///         segment) so `floorDays` here reflects the borrower's REMAINING
    ///         commitment WITHOUT shrinking the term tuple that defines
    ///         maturity + grace. Read via `_remainingTermDays`.
    function settlementInterest(
        LibVaipakam.Loan storage loan,
        uint256 nowTime
    ) internal view returns (uint256) {
        uint256 accrualStart = _accrualStart(loan);
        uint256 elapsedDays = nowTime > accrualStart
            ? (nowTime - accrualStart) / LibVaipakam.ONE_DAY
            : 0;
        uint256 floorDays = loan.useFullTermInterest ? _remainingTermDays(loan) : 0;
        uint256 effectiveDays = elapsedDays > floorDays ? elapsedDays : floorDays;
        return proRataInterest(loan.principal, loan.interestRateBps, effectiveDays);
    }

    /// @notice #408/#410/#413 — convenience wrapper that subtracts
    ///         `loan.interestSettled` (saturating at 0) from the gross
    ///         floor returned by `settlementInterest`. Use this from
    ///         `LibSettlement.compute*` + `RepayFacet.calculateRepaymentAmount`
    ///         so the split-treasury math operates on the NET amount.
    function settlementInterestNet(
        LibVaipakam.Loan storage loan,
        uint256 nowTime
    ) internal view returns (uint256) {
        return creditSettledInterest(loan, settlementInterest(loan, nowTime));
    }

    /// @notice #915 (M7) — credit `loan.interestSettled` against an
    ///         already-computed gross interest figure (saturating at 0).
    /// @dev    Periodic auto-liquidation forwards interest to the lender
    ///         (`loan.interestSettled += ...`) WITHOUT resetting the accrual
    ///         clock, so any raw pro-rata / full-term interest figure still
    ///         spans the settled periods. Every non-proper-close ERC-20
    ///         settlement (obligation-transfer Option 2, offset Option 3,
    ///         time-default, HF liquidation) routes its gross interest through
    ///         here so the already-paid portion is credited exactly once —
    ///         the same credit the proper-close paths get via
    ///         {settlementInterestNet}. Kept as a one-expression helper so
    ///         stack-tight callers (e.g. `PrecloseFacet.transferObligationViaOffer`
    ///         under viaIR) don't add a local for `settled`.
    function creditSettledInterest(
        LibVaipakam.Loan storage loan,
        uint256 grossInterest
    ) internal view returns (uint256) {
        uint256 settled = uint256(loan.interestSettled);
        return grossInterest > settled ? grossInterest - settled : 0;
    }

    /// @notice When the seller's forfeitable interest starts accruing — the
    ///         point through which this lender has already been PAID (or the
    ///         loan's interest-accrual origin, for a lender never paid at all).
    /// @dev    #1503 item 28. Only the lender-position SALE routes want this.
    ///
    ///         A sale forfeits the interest accrued during the seller's tenure,
    ///         because the borrower has not paid it yet. On a periodic loan that
    ///         premise is partly false: periodic auto-liquidation forwards
    ///         interest to the lender WITHOUT moving the accrual clock, so the
    ///         raw clock still spans periods already settled and the seller is
    ///         charged for interest they received.
    ///
    ///         Expressed as a start TIME, not as an amount to subtract. The
    ///         forfeiture figure is scoped to the current accrual SEGMENT, and
    ///         `repayPartial` / `swapToRepay` restart that segment; a lifetime
    ///         amount would then be measuring a different window than the one it
    ///         is deducted from (Codex #1801 r3 P1).
    ///
    ///         Round 3 took the LATER of the two marks; round 4 showed that is
    ///         wrong, because the obligation clock re-bases on events that pay
    ///         nobody — a partial repayment whose lender share is frozen being
    ///         the case that matters. Only actual payment may move the mark, so
    ///         every path that genuinely pays the lender must advance it.
    /// @param loanId       The loan being sold. The mark is keyed per loan rather
    ///                     than held on the struct, because it is appended
    ///                     storage.
    /// @param accrualStart The loan's live interest-accrual origin
    ///                     ({LibVaipakam.interestAccrualStartOf}).
    /// @return from The timestamp the seller's forfeiture window opens at. Equal
    ///              to `accrualStart` on a loan with no delivered periodic
    ///              interest — including every loan predating this upgrade,
    ///              whose mark is zero.
    function forfeitureAccrualStart(
        uint256 loanId,
        uint256 accrualStart
    ) internal view returns (uint256 from) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 paidThrough = s.lenderInterestDeliveredThroughAt[loanId];
        // The mark OUTRANKS the accrual clock where it applies; the clock is only
        // the seed for a loan that has never paid its lender (Codex #1801 r4 P1).
        // Where it applies is the second half of this function — an earlier
        // revision said "authoritative once it exists" full stop, and rounds 5/6
        // showed that is one condition short.
        //
        // An earlier revision took the LATER of the two, which reads as the safe
        // choice and is not. The accrual clock resets whenever the borrower's
        // obligation is re-based — and one of those resets happens on a partial
        // repayment whose lender share was FROZEN rather than delivered. Taking
        // the max let that reset act as the credit: the seller's window closed
        // over interest that went into `heldForLender`, migrates to the buyer,
        // and never reached the seller at all.
        //
        // The two clocks answer different questions. "When did the borrower's
        // obligation restart" is not "when was this lender last paid", and only
        // the second bounds a forfeiture.
        // The window can never open before THIS lender's tenure did (Codex
        // #1801 r13, two P1s that are one missing idea). Everything below picks
        // between two points, and neither is anchored to the party being
        // charged: a first-ever payment that freezes leaves no recorded
        // delivery to fall back to, and a buyer's fallback is the loan's
        // original clock, which predates them. Both are the window escaping the
        // tenure it belongs to.
        uint256 tenureFrom = s.lenderTenureStart[loanId];
        if (paidThrough == 0) {
            // Never paid. The clock is the only evidence — but a freeze may
            // have voided the mark and re-based that clock in the same
            // transaction, so the tenure floor is what keeps the unpaid stretch
            // inside the window.
            if (s.lenderMarkVoided[loanId] && tenureFrom > 0 && tenureFrom < accrualStart) {
                return tenureFrom;
            }
            return accrualStart;
        }
        // ...but a scalar mark can only be honoured while it still DESCRIBES the
        // position (Codex #1801 r5/r6, five P1s). Those findings are one finding:
        // a timestamp carries no amount, so it cannot price a window whose
        // principal moved inside it, and cannot express a delivery that is not
        // contiguous. Rather than teach it to — that is the checkpointed
        // accumulator, tracked separately — the mark is honoured ONLY while the
        // position is provably unchanged since it was stamped, and otherwise
        // discarded in favour of the full-accrual charge this PR inherited.
        //
        // Both disqualifiers are read off STATE, not reported by the sites that
        // cause them, so neither depends on a call site remembering to
        // cooperate. The seller loses a credit they arguably earned; they never
        // gain one they did not.
        // A disqualified mark still bounds the window from BELOW (Codex #1801
        // r12 P1). "Discard the credit and charge the full accrual" was written
        // as "fall back to the accrual clock", and those are not the same
        // sentence: the clock MOVES. A partial repayment whose lender share is
        // frozen does both at once — it parks the share, which disqualifies the
        // mark, and re-bases `interestAccrualStart` to now. Falling back to the
        // clock therefore returned a window of roughly zero and omitted the very
        // frozen stretch the disqualification exists to keep charging for, while
        // that parked balance migrates to the buyer.
        //
        // That is round 4's finding arriving by the opposite door. Round 4
        // refused `max(mark, clock)` because the clock re-bases on events that
        // pay nobody; taking the clock ALONE once the mark is disqualified is
        // the same mistake with the mark deleted first.
        //
        // So a disqualification means "no CREDIT", never "reset the window": the
        // earlier of the two is the honest start, since neither the recorded
        // delivery point nor the obligation clock can be later than the point
        // this lender was genuinely paid through. `voidInterestDeliveredMark`
        // keeps the timestamp for exactly this reason and zeroes only the
        // principal companion, which is what keeps later stamps void.
        if (
            s.lenderMarkVoided[loanId] ||
            s.lenderMarkPrincipalAt[loanId] != s.loans[loanId].principal
        ) {
            uint256 from = paidThrough < accrualStart ? paidThrough : accrualStart;
            // ...but never before this lender bought in. The accrual clock can
            // predate a BUYER by the whole of the seller's tenure, and that
            // stretch was already settled by the sale that handed them the
            // position — charging it again would consume the resale proceeds
            // for interest this lender neither received nor owed.
            return from < tenureFrom ? tenureFrom : from;
        }
        return paidThrough;
    }

    /// @notice Records that this loan's lender has been paid interest through
    ///         `at`, together with the principal that window was priced at.
    /// @dev    The ONLY writer of the pair. Keeping the two in one function is
    ///         the whole guarantee: a mark without its principal would be
    ///         honoured against whatever principal happened to be current, which
    ///         is the leak {forfeitureAccrualStart} exists to refuse.
    ///
    ///         Callers must have DELIVERED the interest — not frozen it, not
    ///         re-based the borrower's obligation clock. A freeze goes to
    ///         {voidInterestDeliveredMark} instead.
    /// @param s      The Diamond storage slot.
    /// @param loanId The loan whose lender was paid.
    /// @param at     The timestamp delivery is paid through.
    function stampInterestDelivered(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        uint256 at
    ) internal {
        uint256 live = s.loans[loanId].principal;
        uint256 recorded = s.lenderMarkPrincipalAt[loanId];
        // A stamp whose window would SPAN a principal change voids the mark for
        // good (Codex #1801 r8 P1). Overwriting the recorded principal here
        // erased the only evidence that the change happened: an Active internal
        // match decrements principal without resetting the interest window, the
        // next periodic settlement stamps a later boundary off the now-lower
        // principal, and the mark reads valid again — while the excluded stretch
        // still contains interest that accrued on the LARGER principal and was
        // never covered by that settlement.
        //
        // This is the freeze argument applied to the other disqualifier, which I
        // had made sticky there and not here. Same shape: a later clean stamp
        // cannot repair a window that is already discontinuous, so nothing on
        // this position is trustworthy again until a sale opens a fresh one.
        //
        // Detected AT THE STAMP rather than reported by the eight decrement
        // sites: `recorded` was the live principal when it was written, so a
        // difference now is proof a change happened in between. Still no
        // cooperation required from any mutation site.
        if (recorded == 0) {
            // NO BASELINE, so no claim can EVER be made for this lender (Codex
            // #1801 r9 P1, corrected r10 P1). A loan whose principal moved
            // before its first post-upgrade settlement has nothing to compare
            // against, and — this is what r9 got wrong — recording a baseline
            // now does not make LATER stamps safe either. The next settlement
            // matches the freshly recorded principal and installs a mark whose
            // window still begins after the unreconciled interval, so the sale
            // excludes history that was never settled, at treasury's expense.
            //
            // The safe boundary is unknowable here, so the position is voided
            // for the rest of this lender's tenure: full accrual, exactly what
            // a grandfathered loan already had. A sale clears it, because the
            // buyer's window opens at the purchase and carries none of it.
            //
            // Loans opened after this change are baselined at initiation and
            // never reach this branch.
            voidInterestDeliveredMark(s, loanId);
            return;
        }
        if (recorded != live) {
            voidInterestDeliveredMark(s, loanId);
            return;
        }
        // A PARK since the last stamp disqualifies the mark too (Codex #1801 r11
        // P1). Parked interest is interest the lender did not receive, so it
        // breaks delivery exactly as a freeze does — but a park is not a freeze,
        // and only the freeze path was voiding. `transferObligationViaOffer`
        // parks the lender's accrued share on a CONTINUING loan; the next clean
        // settlement then stamped straight over that stretch, and the sale
        // excluded it from the seller's charge while the parked balance migrated
        // to the buyer.
        //
        // Detected the same way the principal change is — by comparing state
        // against what was recorded, not by asking seven park sites across four
        // facets to remember a rule. One of them remembered; that is the
        // argument against call-site cooperation, not for it.
        uint256 heldNow = s.heldForLender[loanId];
        if (s.lenderMarkHeldAt[loanId] != heldNow) {
            voidInterestDeliveredMark(s, loanId);
            return;
        }
        s.lenderInterestDeliveredThroughAt[loanId] = at;
        s.lenderMarkPrincipalAt[loanId] = live;
        s.lenderMarkHeldAt[loanId] = heldNow;
    }

    /// @notice Records the position a new loan starts at, with no mark.
    /// @dev    The baseline {stampInterestDelivered} compares against (Codex
    ///         #1801 r9 P1, widened r11 P1). Without it the first delivery stamp
    ///         has nothing to detect an earlier change with, and a principal
    ///         change or a park between origination and the first settlement
    ///         would be invisible.
    ///
    ///         The held baseline is written explicitly rather than left at its
    ///         zero default even though a new loan holds nothing: the pair is
    ///         what makes "recorded != live" mean "something happened since",
    ///         and splitting responsibility for the two fields is how the
    ///         principal half went missing in the first place.
    ///
    ///         Deliberately does NOT set the mark: a loan that has paid its
    ///         lender nothing forfeits from the accrual origin, which is what a
    ///         zero mark already means.
    /// @param s      The Diamond storage slot.
    /// @param loanId The loan being opened.
    function baselineMark(
        LibVaipakam.Storage storage s,
        uint256 loanId
    ) internal {
        s.lenderMarkPrincipalAt[loanId] = s.loans[loanId].principal;
        s.lenderMarkHeldAt[loanId] = s.heldForLender[loanId];
        // The originating lender's tenure starts here (Codex #1801 r13).
        s.lenderTenureStart[loanId] = block.timestamp;
    }

    /// @notice Opens a FRESH mark for an incoming lender on a completed sale.
    /// @dev    A sale settles the outstanding forfeiture — to treasury, or into
    ///         the buyer's rate compensation — before the position changes hands,
    ///         so the buyer's window starts at the sale carrying nothing of the
    ///         seller's tenure. That includes the seller's freeze history: the
    ///         void is sticky for a lender, not for a loan.
    ///
    ///         Separate from {stampInterestDelivered} because clearing the void
    ///         is only ever correct here, and kept in this library rather than at
    ///         the call site so all three fields have one owner — a later sale
    ///         path cannot stamp the mark and forget the flag.
    /// @param s      The Diamond storage slot.
    /// @param loanId The loan whose lender position was sold.
    /// @param at     The sale timestamp the buyer's window opens at.
    function stampInterestDeliveredForNewLender(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        uint256 at
    ) internal {
        // Written DIRECTLY, not through {stampInterestDelivered} (Codex #1801 r8
        // P1 follow-on): that function now refuses to advance across a pending
        // principal change, which is right for the seller and wrong here. None
        // of the seller's history — a freeze, an unreconciled principal move —
        // is the buyer's, and their window opens at this sale on this principal
        // whatever happened before it. Delegating would have left the buyer with
        // no mark at all, quietly re-opening their window at the accrual origin.
        s.lenderInterestDeliveredThroughAt[loanId] = at;
        s.lenderMarkPrincipalAt[loanId] = s.loans[loanId].principal;
        s.lenderMarkHeldAt[loanId] = s.heldForLender[loanId];
        s.lenderMarkVoided[loanId] = false;
        // The BUYER's tenure starts at the sale (Codex #1801 r13 P1). Without
        // it, a later disqualification would fall back to the loan's original
        // accrual clock and charge them for the seller's whole tenure — which
        // this very sale settled.
        s.lenderTenureStart[loanId] = at;
    }

    /// @notice Permanently disqualifies this loan's mark, because a lender share
    ///         was frozen rather than delivered.
    /// @dev    Clearing the timestamp alone would not hold: a later clean
    ///         delivery re-stamps it, and the window back to the previous mark
    ///         then spans the frozen stretch. Once delivery is non-contiguous no
    ///         scalar stamp on this position is trustworthy again, so the flag
    ///         is sticky for the rest of the lender's tenure — and cleared only
    ///         by a SALE, where the incoming lender's window starts fresh.
    /// @param s      The Diamond storage slot.
    /// @param loanId The loan whose lender share was frozen.
    function voidInterestDeliveredMark(
        LibVaipakam.Storage storage s,
        uint256 loanId
    ) internal {
        // The timestamp is KEPT (Codex #1801 r12 P1). Zeroing it made
        // {forfeitureAccrualStart} take its no-mark branch and open the window
        // at the accrual clock — and the clock had just moved, because the same
        // partial repayment that froze the share re-bases it. The frozen stretch
        // then fell outside the seller's charge entirely, which is the leak the
        // void exists to prevent, not a side effect of it.
        //
        // A void means the mark grants no CREDIT. It does not mean the mark is
        // unknown: the recorded point is still a real lower bound on the window,
        // and the reader now takes the earlier of it and the clock. Only the
        // principal companion is cleared, which is what keeps every later stamp
        // void for the rest of this lender's tenure.
        s.lenderMarkPrincipalAt[loanId] = 0;
        s.lenderMarkHeldAt[loanId] = 0;
        s.lenderMarkVoided[loanId] = true;
    }

    /// @notice Applies the treasury cut to an interest-like amount, using the
    ///         fee BPS the loan was ORIGINATED under.
    /// @param loan           The loan whose treasury cut is being settled — its
    ///                       `treasuryFeeBpsAtInit` snapshot (via
    ///                       {LibVaipakam.effectiveTreasuryFeeBps}) sets the rate.
    /// @param interestAmount The interest-like amount to split.
    /// @return treasuryShare treasury's cut.
    /// @return lenderShare   the remainder the lender keeps.
    /// @dev #957 (#921 item 6): reads the per-loan snapshot, NOT the live
    ///      `cfgTreasuryFeeBps()`, so a mid-loan governance retune never
    ///      changes an open loan's settlement economics vs. the signed
    ///      receipt. `view`, not `pure`: the snapshot resolver touches
    ///      storage. A `0` snapshot (pre-#957 loan) resolves to the FROZEN
    ///      `LEGACY_TREASURY_FEE_BPS`, NOT the live knob — see
    ///      {LibVaipakam.effectiveTreasuryFeeBps}, which explains why:
    ///      falling through to the live knob would have repriced every
    ///      pre-#957 open loan when #1352 bumped the default, which is the
    ///      retroactive change the snapshot exists to prevent. (This line
    ///      said "falls back to the live knob" until #1614; it described
    ///      the opposite of the code, on the one path where the difference
    ///      is a grandfathered loan's economics.)
    function splitTreasury(
        LibVaipakam.Loan storage loan,
        uint256 interestAmount
    ) internal view returns (uint256 treasuryShare, uint256 lenderShare) {
        treasuryShare =
            (interestAmount * LibVaipakam.effectiveTreasuryFeeBps(loan)) /
            LibVaipakam.BASIS_POINTS;
        lenderShare = interestAmount - treasuryShare;
    }

    /// @notice Dynamic liquidator incentive in bps — `cfgMaxLiquidationSlippageBps`
    ///         (6%) minus realized slippage, capped at `cfgMaxLiquidatorIncentiveBps`
    ///         (3%) and any per-asset `liqBonusBps` ceiling.
    /// @dev    #1010 (L-h): shared by the single-route / split-route HF
    ///         liquidation paths AND the time-based-default swap path so all
    ///         three pay the SAME keeper incentive. Returns bps only; the caller
    ///         multiplies by `proceeds`. Kept as an `internal view` helper (one
    ///         audit surface for the incentive curve) — the surrounding
    ///         waterfall stays inline in each facet to respect the EIP-170
    ///         ceiling (a memory-struct-returning distributor inflates each
    ///         god-facet past 24,576 B).
    /// @param collateralAsset  Loan collateral asset (for the per-asset cap).
    /// @param proceeds         Actual swap proceeds.
    /// @param expectedProceeds Oracle-derived expected proceeds.
    function liquidatorIncentiveBps(
        address collateralAsset,
        uint256 proceeds,
        uint256 expectedProceeds
    ) internal view returns (uint256 incentiveBps) {
        uint256 maxSlippageBps = LibVaipakam.cfgMaxLiquidationSlippageBps();
        uint256 realizedSlippageBps;
        if (proceeds < expectedProceeds && expectedProceeds != 0) {
            realizedSlippageBps =
                ((expectedProceeds - proceeds) * LibVaipakam.BASIS_POINTS) / expectedProceeds;
            if (realizedSlippageBps > maxSlippageBps) realizedSlippageBps = maxSlippageBps;
        }
        incentiveBps = maxSlippageBps - realizedSlippageBps;
        uint256 maxIncentiveBps = LibVaipakam.cfgMaxLiquidatorIncentiveBps();
        if (incentiveBps > maxIncentiveBps) incentiveBps = maxIncentiveBps;
        uint256 assetCapBps =
            LibVaipakam.storageSlot().assetRiskParams[collateralAsset].liqBonusBps;
        if (assetCapBps != 0 && incentiveBps > assetCapBps) incentiveBps = assetCapBps;
    }
}
