// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibIntentTerms} from "./LibIntentTerms.sol";

/**
 * @title  LibMarketLedger
 * @notice The common ledger of the instant market (InstantMarketDesign §8).
 *
 *         **Declared**, per lending asset and per (lending asset, collateral
 *         asset) pair: the sum of `maxExposure` over every active Auto-lend
 *         slot that can still be filled. A paused or cancelled slot declares
 *         nothing. A slot with a lend-until time stops declaring at the end of
 *         the UTC day in which its window closes (the last moment a one-day
 *         loan still fits, {LibIntentTerms.windowOpen}); the totals are
 *         therefore exact "as of the start of today (UTC)".
 *
 *         **Lent**, per lending asset and per pair, two figures:
 *         - `all`: the open principal of every ERC-20 loan in the metrics
 *           active set (`Active` or `FallbackPending`), from any route. The
 *           lender-sale vehicle is never in that set, so it never counts.
 *         - `fromSlots`: the part of `all` opened by an Auto-lend slot fill.
 *           Lent from slots divided by Declared is how full the market is.
 *
 * @dev    Every total is kept by RECONCILING one record per source rather
 *         than by adding and subtracting at each writer: a slot records what
 *         it last added to Declared (and in which expiry bucket), a loan what
 *         it last added to Lent (and whether a slot opened it). A sync
 *         computes what the source should add now, takes the old record out
 *         and puts the new one in. So no writer can add twice or forget to
 *         subtract, and calling a sync again changes nothing.
 *
 *         Expiry without a transaction: each Declared counter keeps, per UTC
 *         day, the exposure of the slots whose window closes that day, and a
 *         `nextDay` marker. A day's bucket leaves the total once the
 *         day has fully passed — on the next write that touches the counter
 *         ({roll}), and in every read immediately ({declaredOf}). A slot
 *         whose day is before the marker is already out of the total,
 *         so editing or cancelling it later takes nothing out again.
 *
 *         Where each sync runs:
 *         - {syncIntent} from `MarketLedgerFacet.syncDeclared`, which
 *           `LenderIntentFacet.setLenderIntent` and `cancelLenderIntent`
 *           self-call: they are the only writers of the three fields a
 *           slot's declared figure reads (`active`, `maxExposure`,
 *           `lendUntil`). A new writer of any of them must call it too.
 *         - {syncLoan} from `LibMetricsHooks` (a loan entering or leaving the
 *           active set) and `LibInterestLedger` (the one writer of
 *           `loan.principal` after origination).
 *         - {markFromSlot} once, where `matchIntent` records the loan's
 *           intent origin. A loan's source is fixed at opening: a sale,
 *           takeover or the later clearing of the origin moves nothing.
 */
library LibMarketLedger {
    /// @dev The most days one write rolls forward. A counter left untouched
    ///      for longer is rolled by `MarketLedgerFacet.rollDeclaredLedger`,
    ///      or simply by later writes; reads are exact either way.
    uint256 internal constant MAX_ROLL_DAYS = 31;

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

    // ─── Declared ──────────────────────────────────────────────────────────

    /// @dev Reconcile one slot's contribution to Declared.
    function syncIntent(
        LibVaipakam.Storage storage s,
        LibVaipakam.LenderIntent storage intent,
        address lendingAsset,
        address collateralAsset,
        bytes32 ik
    ) internal {
        LibVaipakam.DeclaredRecord storage rec = s.intentDeclaredRecord[ik];
        uint256 amount;
        uint64 day;
        if (intent.active) {
            day = closingDay(intent.lendUntil);
            // A slot that can no longer be filled declares nothing.
            if (day == 0 || day >= _today()) amount = intent.maxExposure;
            else day = 0;
        }
        if (amount == rec.amount && day == rec.day) return;
        LibVaipakam.DeclaredCounter storage a = s.declaredByAsset[lendingAsset];
        LibVaipakam.DeclaredCounter storage p = s.declaredByPair[lendingAsset][collateralAsset];
        roll(a, MAX_ROLL_DAYS);
        roll(p, MAX_ROLL_DAYS);
        if (rec.amount != 0) {
            _take(a, rec.amount, rec.day);
            _take(p, rec.amount, rec.day);
        }
        if (amount != 0) {
            _put(a, amount, day);
            _put(p, amount, day);
        }
        rec.amount = amount;
        rec.day = day;
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
            total -= c.expiring[next];
            ++next;
        }
        c.total = total;
        c.nextDay = next;
    }

    /// @dev Remove a recorded contribution. One whose day has been rolled is
    ///      already out of the total.
    function _take(LibVaipakam.DeclaredCounter storage c, uint256 amount, uint64 day) private {
        if (day != 0 && day < c.nextDay) return;
        c.total -= amount;
        if (day != 0) c.expiring[day] -= amount;
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
            total -= c.expiring[next];
        }
    }

    // ─── Lent ──────────────────────────────────────────────────────────────

    /// @dev Reconcile one loan's contribution to Lent. A loan counts while it
    ///      is an ERC-20 loan in the metrics active set, at its current
    ///      principal, in `all`, and in `fromSlots` too when a slot opened it.
    function syncLoan(LibVaipakam.Storage storage s, LibVaipakam.Loan storage loan) internal {
        LibVaipakam.LentRecord storage rec = s.loanLentRecord[loan.id];
        uint256 amount = loan.assetType == LibVaipakam.AssetType.ERC20
            && s.activeLoanIdsListPos[loan.id] != 0 ? loan.principal : 0;
        if (amount == rec.amount) return;
        _moveLent(s, loan, rec, rec.amount, amount);
        rec.amount = amount;
    }

    /// @dev The loan was opened by an Auto-lend slot fill. Called once, where
    ///      the fill records the loan's intent origin; its current
    ///      contribution moves into the slot figure as well.
    function markFromSlot(LibVaipakam.Storage storage s, LibVaipakam.Loan storage loan) internal {
        LibVaipakam.LentRecord storage rec = s.loanLentRecord[loan.id];
        if (rec.fromSlot) return;
        rec.fromSlot = true;
        uint256 amount = rec.amount;
        if (amount == 0) return;
        s.lentByAsset[loan.principalAsset].fromSlots += amount;
        s.lentByPair[loan.principalAsset][loan.collateralAsset].fromSlots += amount;
    }

    function _moveLent(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        LibVaipakam.LentRecord storage rec,
        uint256 from,
        uint256 to
    ) private {
        bool fromSlot = rec.fromSlot;
        _shift(s.lentByAsset[loan.principalAsset], from, to, fromSlot);
        _shift(s.lentByPair[loan.principalAsset][loan.collateralAsset], from, to, fromSlot);
    }

    function _shift(LibVaipakam.LentTotals storage t, uint256 from, uint256 to, bool fromSlot) private {
        t.all = t.all - from + to;
        if (fromSlot) t.fromSlots = t.fromSlots - from + to;
    }
}
