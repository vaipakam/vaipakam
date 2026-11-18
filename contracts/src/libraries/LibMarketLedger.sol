// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibIntentTerms} from "./LibIntentTerms.sol";
import {LibFacet} from "./LibFacet.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title  LibMarketLedger
 * @notice The common ledger of the instant market (InstantMarketDesign §8,
 *         amended by TermAverageAndLinkGuardsDesign §7, #3714).
 *
 *         **Declared**, per lending asset and per (lending asset, collateral
 *         asset) pair: the limit lenders set, the sum of `maxExposure` over
 *         every active Auto-lend slot that can still be filled. A paused or
 *         cancelled slot declares nothing. A slot with a lend-until time stops
 *         declaring at the end of the UTC day in which its window closes (the
 *         last moment a one-day loan still fits, {LibIntentTerms.windowOpen});
 *         the totals are therefore exact "as of the start of today (UTC)".
 *
 *         **Available** (#3714), per lending asset and per pair: the sum of
 *         every such slot's fillable amount, the lesser of its reserved
 *         capital (`lenderIntentCapital`, liened in the owner's vault) and its
 *         unused exposure (`maxExposure` less its live principal), and zero
 *         when that is below the slot's smallest fill. It leaves through the
 *         same day buckets as Declared.
 *
 *         **Lent**, per lending asset and per pair, three figures:
 *         - `all`: the open principal of every ERC-20 loan in the metrics
 *           active set (`Active` or `FallbackPending`), from any route. The
 *           lender-sale vehicle is never in that set, so it never counts.
 *         - `fromSlots`: the part of `all` held from an Auto-lend slot now.
 *           It equals the sum of every slot's live principal, so "how full"
 *           is `fromSlots / (fromSlots + available)`.
 *         - `instant`: the part opened through the instant market.
 *
 * @dev    Every total is kept by RECONCILING one record per source rather
 *         than by adding and subtracting at each writer: a slot records what
 *         it last added to Declared and Available (and in which expiry
 *         bucket), a loan what it last added to Lent (and whether a slot holds
 *         it). A sync computes what the source should add now, takes the old
 *         record out and puts the new one in. So no writer can add twice or
 *         forget to subtract, and calling a sync again changes nothing.
 *
 *         A slot's live principal (`lenderIntentLivePrincipal`) is the sum of
 *         the Lent records of the loans it holds: it moves only where a held
 *         loan's record moves ({syncLoan} through
 *         `MarketLedgerFacet.onSlotLoanPrincipal`) or a loan joins or leaves
 *         the slot (`onSlotFilled` / `onSlotReleased`), always by that
 *         record's amount.
 *
 *         Expiry without a transaction: each counter keeps, per UTC day, the
 *         amount of the slots whose window closes that day, and a `nextDay`
 *         marker. A day's bucket leaves the total once the day has fully
 *         passed — on the next write that touches the counter ({roll}), and in
 *         every read immediately ({declaredOf}). A slot whose day is before the
 *         marker is already out of the total, so editing or cancelling it
 *         later takes nothing out again.
 *
 *         Where each sync runs: {syncIntent} only on `MarketLedgerFacet`, the
 *         one host of the slot-side writes, which every writer of a field it
 *         reads self-calls (`active`, `maxExposure`, `lendUntil`,
 *         `minFillAmount`, the reserved capital and the live principal). {syncLoan} from
 *         `LibMetricsHooks` (a loan entering or leaving the active set) and
 *         `LibInterestLedger` (the one writer of `loan.principal` after
 *         origination).
 */
library LibMarketLedger {
    /// @dev The most days one write rolls forward. A counter left untouched
    ///      for longer is rolled by `MarketLedgerFacet.rollDeclaredLedger`,
    ///      or simply by later writes; reads are exact either way.
    uint256 internal constant MAX_ROLL_DAYS = 31;

    /// @dev `MarketLedgerFacet.onSlotLoanPrincipal(uint256,uint256,uint256)`.
    ///      A literal, not the facet's `.selector`, so this library (inlined
    ///      in every loan-transition facet) does not import the facet;
    ///      `MarketLedgerTest` pins it to the facet's selector.
    bytes4 internal constant ON_SLOT_LOAN_PRINCIPAL =
        bytes4(keccak256("onSlotLoanPrincipal(uint256,uint256,uint256)"));

    /// @dev Days are numbered from 1 (day 1 = 1970-01-01 UTC), so 0 can mean
    ///      "no lend-until time" in a record and "never touched" in a counter.
    function _today() private view returns (uint64) {
        return uint64(block.timestamp / 1 days) + 1;
    }

    /// @dev The day a slot with lend-until time `lendUntil` stops being
    ///      fillable (the window closes `MIN_LEND_WINDOW` before it), or 0 for
    ///      a slot with none.
    function closingDay(uint64 lendUntil) internal pure returns (uint64) {
        if (lendUntil == 0) return 0;
        uint256 closes = uint256(lendUntil) > LibIntentTerms.MIN_LEND_WINDOW
            ? uint256(lendUntil) - LibIntentTerms.MIN_LEND_WINDOW
            : 0;
        return uint64(closes / 1 days) + 1;
    }

    // ─── Declared and Available ────────────────────────────────────────────

    /// @dev What a slot should add now: `declared` its largest exposure,
    ///      `available` its fillable amount (the lesser of its reserved capital
    ///      and its unused exposure, zero below its smallest fill), both zero
    ///      once inactive or past its fill window. `day` is the UTC day its
    ///      window closes (0 = none).
    function slotFigures(LibVaipakam.LenderIntent storage intent, uint256 capital, uint256 live)
        internal
        view
        returns (uint256 declared, uint256 available, uint64 day)
    {
        if (!intent.active) return (0, 0, 0);
        day = closingDay(intent.lendUntil);
        // A slot that can no longer be filled counts for nothing.
        if (day != 0 && day < _today()) return (0, 0, 0);
        declared = intent.maxExposure;
        available = declared > live ? declared - live : 0;
        if (capital < available) available = capital;
        if (available < intent.minFillAmount) available = 0;
    }

    /// @dev Reconcile one slot's contribution to Declared and Available.
    function syncIntent(
        LibVaipakam.Storage storage s,
        LibVaipakam.LenderIntent storage intent,
        address lendingAsset,
        address collateralAsset,
        bytes32 ik,
        uint256 capital,
        uint256 live
    ) internal {
        LibVaipakam.DeclaredRecord storage rec = s.intentDeclaredRecord[ik];
        (uint256 declared, uint256 available, uint64 day) = slotFigures(intent, capital, live);
        if (declared == rec.amount && available == rec.available && day == rec.day) return;
        _move(s.declaredByAsset[lendingAsset], rec.amount, declared, rec.day, day);
        _move(s.declaredByPair[lendingAsset][collateralAsset], rec.amount, declared, rec.day, day);
        _move(s.availableByAsset[lendingAsset], rec.available, available, rec.day, day);
        _move(s.availableByPair[lendingAsset][collateralAsset], rec.available, available, rec.day, day);
        rec.amount = declared;
        rec.available = available;
        rec.day = day;
    }

    /// @dev Roll `c`, then replace a recorded `(from, fromDay)` with
    ///      `(to, toDay)`.
    function _move(LibVaipakam.DeclaredCounter storage c, uint256 from, uint256 to, uint64 fromDay, uint64 toDay)
        private
    {
        roll(c, MAX_ROLL_DAYS);
        if (from != 0) _take(c, from, fromDay);
        if (to != 0) _put(c, to, toDay);
    }

    /// @dev Move `c`'s marker forward over at most `maxDays` fully passed
    ///      days, taking each day's bucket out of the total. `nextDay` is the
    ///      first day whose bucket is still in the total.
    function roll(LibVaipakam.DeclaredCounter storage c, uint256 maxDays) internal {
        uint64 today = _today();
        uint64 next = c.nextDay;
        if (next == 0) {
            // First touch: no bucket exists yet, since every bucket is added
            // after a roll and is for today or later.
            c.nextDay = today;
            return;
        }
        if (next >= today) return;
        uint256 total = c.total;
        for (uint256 n; next < today && n < maxDays; ++n) {
            total = _less(total, c.expiring[next]);
            ++next;
        }
        c.total = total;
        c.nextDay = next;
    }

    /// @dev Remove a recorded contribution. One whose day has been rolled is
    ///      already out of the total.
    function _take(LibVaipakam.DeclaredCounter storage c, uint256 amount, uint64 day) private {
        if (day != 0 && day < c.nextDay) return;
        c.total = _less(c.total, amount);
        if (day != 0) c.expiring[day] = _less(c.expiring[day], amount);
    }

    /// @dev `a - b`, stopping at zero. Every ledger subtraction a close-out
    ///      reaches uses it, so bookkeeping can never refuse a repayment, a
    ///      default or a claim; by construction the operands never cross.
    function _less(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : 0;
    }

    function _put(LibVaipakam.DeclaredCounter storage c, uint256 amount, uint64 day) private {
        c.total += amount;
        if (day != 0) c.expiring[day] += amount;
    }

    /// @dev The counter's total as of the start of today (UTC): the stored
    ///      total less the buckets of every fully passed day not yet rolled.
    ///      The loop runs over the days since the counter was last written.
    function declaredOf(LibVaipakam.DeclaredCounter storage c) internal view returns (uint256 total) {
        total = c.total;
        uint64 next = c.nextDay;
        if (next == 0) return total;
        for (uint64 today = _today(); next < today; ++next) {
            total = _less(total, c.expiring[next]);
        }
    }

    // ─── Lent ──────────────────────────────────────────────────────────────

    /// @dev Reconcile one loan's contribution to Lent. A loan counts while it
    ///      is an ERC-20 loan in the metrics active set, at its current
    ///      principal, in `all`, and in `fromSlots` too while a slot holds it.
    ///      A held loan's move also moves its slot's live principal and
    ///      figures, on the ledger's host (`MarketLedgerFacet`), in this step.
    function syncLoan(LibVaipakam.Storage storage s, LibVaipakam.Loan storage loan) internal {
        LibVaipakam.LentRecord storage rec = s.loanLentRecord[loan.id];
        uint256 amount = loan.assetType == LibVaipakam.AssetType.ERC20
            && s.activeLoanIdsListPos[loan.id] != 0 ? loan.principal : 0;
        uint256 from = rec.amount;
        if (amount == from) return;
        _moveLent(s, loan, rec, from, amount);
        rec.amount = amount;
        if (rec.fromSlot) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(ON_SLOT_LOAN_PRINCIPAL, loan.id, from, amount),
                IVaipakamErrors.CrossFacetCallFailed.selector
            );
        }
    }

    /// @dev The loan joins its slot (a fill opened it, or a takeover moved it
    ///      in): its current contribution moves into the slot figure, and the
    ///      returned amount into the slot's live principal.
    function markFromSlot(LibVaipakam.Storage storage s, LibVaipakam.Loan storage loan)
        internal
        returns (uint256 amount)
    {
        LibVaipakam.LentRecord storage rec = s.loanLentRecord[loan.id];
        if (rec.fromSlot) return 0;
        rec.fromSlot = true;
        amount = rec.amount;
        if (amount == 0) return 0;
        s.lentByAsset[loan.principalAsset].fromSlots += amount;
        s.lentByPair[loan.principalAsset][loan.collateralAsset].fromSlots += amount;
    }

    /// @dev The loan leaves its slot (the slot's exposure for it is released:
    ///      a claim, a sale, a consolidation, a takeover out, a roll). Its
    ///      contribution leaves the slot figure, and the returned amount
    ///      leaves the slot's live principal. A later takeover into a slot
    ///      ({markFromSlot}) brings it back in.
    function unmarkFromSlot(LibVaipakam.Storage storage s, LibVaipakam.Loan storage loan)
        internal
        returns (uint256 amount)
    {
        LibVaipakam.LentRecord storage rec = s.loanLentRecord[loan.id];
        if (!rec.fromSlot) return 0;
        rec.fromSlot = false;
        amount = rec.amount;
        if (amount == 0) return 0;
        LibVaipakam.LentTotals storage a = s.lentByAsset[loan.principalAsset];
        LibVaipakam.LentTotals storage p = s.lentByPair[loan.principalAsset][loan.collateralAsset];
        a.fromSlots = _less(a.fromSlots, amount);
        p.fromSlots = _less(p.fromSlots, amount);
    }

    /// @dev The loan was opened through the instant market (#3656). Called
    ///      once, at opening; its current contribution moves into the instant
    ///      figure as well.
    function markInstant(LibVaipakam.Storage storage s, LibVaipakam.Loan storage loan) internal {
        LibVaipakam.LentRecord storage rec = s.loanLentRecord[loan.id];
        if (rec.instant) return;
        rec.instant = true;
        uint256 amount = rec.amount;
        if (amount == 0) return;
        s.lentByAsset[loan.principalAsset].instant += amount;
        s.lentByPair[loan.principalAsset][loan.collateralAsset].instant += amount;
    }

    function _moveLent(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        LibVaipakam.LentRecord storage rec,
        uint256 from,
        uint256 to
    ) private {
        bool fromSlot = rec.fromSlot;
        bool instant = rec.instant;
        _shift(s.lentByAsset[loan.principalAsset], from, to, fromSlot, instant);
        _shift(s.lentByPair[loan.principalAsset][loan.collateralAsset], from, to, fromSlot, instant);
    }

    function _shift(LibVaipakam.LentTotals storage t, uint256 from, uint256 to, bool fromSlot, bool instant)
        private
    {
        t.all = _less(t.all, from) + to;
        if (fromSlot) t.fromSlots = _less(t.fromSlots, from) + to;
        if (instant) t.instant = _less(t.instant, from) + to;
    }
}
