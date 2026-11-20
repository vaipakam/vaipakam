// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibMarketLedger} from "../libraries/LibMarketLedger.sol";
import {LibBackstopDailyLimit} from "../libraries/LibBackstopDailyLimit.sol";

/**
 * @title  MarketLedgerFacet
 * @author Vaipakam Developer Team
 * @notice The instant market's common ledger (InstantMarketDesign §8, amended
 *         by TermAverageAndLinkGuardsDesign §7, #3714): Declared (the limit
 *         lenders set), Available (what the slots can lend now from their
 *         reserved capital) and the Lent figures, per lending asset and per
 *         pair; the one host of every Auto-lend slot's share of them and of
 *         each slot's live principal; and the roll that moves the stored
 *         totals past expired days.
 * @dev    Its own facet because `LenderIntentFacet` has no EIP-170 room for
 *         the ledger. Every writer of a field a slot's figures read self-calls
 *         it, in the same step:
 *         - {syncSlot}: `LenderIntentFacet` set, cancel, fund, withdraw and
 *           recommit (the terms and the reserved capital), and
 *           `BackstopFacet.seedBackstopOrigination` (the backstop's capital);
 *         - {onSlotFilled}: `LibIntentFill.recordSlotLoan`, inlined in
 *           `OfferMatchIntentFacet`, `InstantFillFacet` and
 *           `InstantTakeoverFacet` (a fill or a takeover into a slot);
 *         - {onSlotReleased}: `LenderIntentFacet.releaseIntentExposure` and
 *           `rollIntentLoan` (a loan leaves its slot);
 *         - {onSlotLoanPrincipal}: `LibMarketLedger.syncLoan`, inlined in every
 *           facet that moves a loan's principal or its place in the active
 *           set (a held loan's outstanding principal moved).
 *         So a slot's live principal is always exactly the outstanding
 *         principal of the loans it holds. The same two seams keep the
 *         backstop's daily lending limit (#3849, `LibBackstopDailyLimit`):
 *         the sync keeps its per-asset capital and {onSlotFilled} counts and
 *         checks each loan its capital opens. Refreshed together with all of
 *         those callers: one refreshed onto a Diamond that does not route
 *         these entries reverts (a hard revert, never a stale figure).
 *
 *         **Bookkeeping never blocks a close-out.** {onSlotLoanPrincipal}
 *         (repayment, default, write-off, liquidation) and {onSlotReleased}
 *         (claim, sale, consolidation, takeover out, roll) treat a loan with
 *         no origin as held by no slot, and every subtraction they reach
 *         stops at zero instead of reverting, so no ledger inconsistency can
 *         refuse a repayment or a claim. Only the opening path
 *         ({onSlotFilled}) refuses.
 */
contract MarketLedgerFacet {
    /// @notice A Diamond-internal entry was called from outside the Diamond.
    error OnlyDiamondInternal();
    /// @notice A fill's loan has no slot origin recorded. Never expected: the
    ///         origin is written just before. Raised on the opening path only,
    ///         rather than guessing a slot; the close-out paths never raise it.
    error SlotOriginMissing(uint256 loanId);

    // ─── Diamond-internal writers ─────────────────────────────────────────

    /// @notice Reconcile one Auto-lend slot's share of Declared and Available
    ///         with its terms, reserved capital and live principal now.
    /// @dev    Diamond-internal. Idempotent.
    function syncSlot(address owner, address lendingAsset, address collateralAsset, uint8 slot) external {
        _onlyDiamond();
        _sync(LibVaipakam.storageSlot(), owner, lendingAsset, collateralAsset, slot);
    }

    /// @notice `loanId` joined the slot its origin names (a fill opened it or
    ///         a takeover moved it in): its outstanding principal joins the
    ///         slot's live principal and the lent-from-slots figure, and the
    ///         slot's figures follow (the fill also drew its capital).
    /// @dev    Diamond-internal: `LibIntentFill.recordSlotLoan`, after it
    ///         records the origin.
    function onSlotFilled(uint256 loanId) external {
        _onlyDiamond();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.IntentOrigin storage io = _origin(s, loanId);
        uint256 amount = LibMarketLedger.markFromSlot(s, s.loans[loanId]);
        s.lenderIntentLivePrincipal[io.owner][io.lendingAsset][io.collateralAsset][io.slot] += amount;
        _sync(s, io.owner, io.lendingAsset, io.collateralAsset, io.slot);
        // #3849 — the backstop's daily limit. Every loan its capital opens
        // (an intent match, an instant fill, a takeover into its slot) passes
        // here, so this is the one place the day's total is counted and
        // checked. Checked after the sync: the fill moved capital from waiting
        // to out, which leaves the capital, and so the limit, unchanged.
        if (io.owner == s.backstopVault && io.slot == LibVaipakam.PROTOCOL_INTENT_SLOT) {
            LibBackstopDailyLimit.consume(s, io.lendingAsset, s.loans[loanId].principal);
        }
    }

    /// @notice `loanId` is leaving the slot its origin names (its exposure is
    ///         released): whatever of its principal is still outstanding
    ///         leaves the slot's live principal and the lent-from-slots
    ///         figure, and the slot's figures follow.
    /// @dev    Diamond-internal: `LenderIntentFacet.releaseIntentExposure` and
    ///         `rollIntentLoan`, before they delete the origin.
    function onSlotReleased(uint256 loanId) external {
        _onlyDiamond();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.IntentOrigin storage io = s.intentOrigin[loanId];
        uint256 amount = LibMarketLedger.unmarkFromSlot(s, s.loans[loanId]);
        if (io.owner == address(0)) return; // held by no slot: nothing more to move
        mapping(uint8 => uint256) storage live =
            s.lenderIntentLivePrincipal[io.owner][io.lendingAsset][io.collateralAsset];
        uint256 l = live[io.slot];
        live[io.slot] = l > amount ? l - amount : 0;
        _sync(s, io.owner, io.lendingAsset, io.collateralAsset, io.slot);
    }

    /// @notice The outstanding principal a slot's loan counts for moved from
    ///         `from` to `to` (a repayment, a write-off, the loan leaving or
    ///         re-entering the active set): the slot's live principal moves by
    ///         the same amount, and the slot's figures follow. A loan with no
    ///         origin recorded is held by no slot, so nothing moves.
    /// @dev    Diamond-internal: `LibMarketLedger.syncLoan`, for a loan a slot
    ///         holds.
    function onSlotLoanPrincipal(uint256 loanId, uint256 from, uint256 to) external {
        _onlyDiamond();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.IntentOrigin storage io = s.intentOrigin[loanId];
        // A loan with no origin is held by no slot: a no-op, never a revert,
        // because this runs inside repayments and defaults.
        if (io.owner == address(0)) return;
        mapping(uint8 => uint256) storage live =
            s.lenderIntentLivePrincipal[io.owner][io.lendingAsset][io.collateralAsset];
        uint256 l = live[io.slot];
        live[io.slot] = (l > from ? l - from : 0) + to;
        _sync(s, io.owner, io.lendingAsset, io.collateralAsset, io.slot);
    }

    // ─── Permissionless housekeeping ──────────────────────────────────────

    /// @notice Move the stored Declared and Available totals for a lending
    ///         asset and one of its pairs forward over up to `maxDays` passed
    ///         days, taking out the slots whose fill window has closed. Anyone
    ///         may call it.
    /// @dev    No figure depends on it: the views subtract the days not yet
    ///         rolled themselves, and every slot write rolls its own asset and
    ///         pair first (at most `LibMarketLedger.MAX_ROLL_DAYS` days). It
    ///         exists so a write after a long quiet gap stays cheap. Moves no
    ///         funds.
    function rollMarketLedger(address lendingAsset, address collateralAsset, uint256 maxDays) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibMarketLedger.roll(s.declaredByAsset[lendingAsset], maxDays);
        LibMarketLedger.roll(s.declaredByPair[lendingAsset][collateralAsset], maxDays);
        LibMarketLedger.roll(s.availableByAsset[lendingAsset], maxDays);
        LibMarketLedger.roll(s.availableByPair[lendingAsset][collateralAsset], maxDays);
    }

    // ─── Views ────────────────────────────────────────────────────────────

    /// @notice The common ledger for one lending asset, across every
    ///         collateral asset. Every figure is stated as of the start of
    ///         today (UTC): a slot with an end date leaves Declared and
    ///         Available through its closing day's bucket, so a slot whose fill
    ///         window closes today still counts until the day ends.
    /// @return declared The limit lenders set: the sum of `maxExposure` over
    ///         every active Auto-lend slot lending `lendingAsset` whose fill
    ///         window is still open. It is not what can be lent now.
    /// @return available What the slots can lend now: the sum over the same
    ///         slots of each slot's fillable amount, the lesser of its reserved
    ///         capital and its unused exposure (`maxExposure` less the
    ///         principal it has out), counted as zero when that is below the
    ///         slot's smallest fill. A cancelled slot, or one whose window has
    ///         closed, counts zero while its open loans still count in
    ///         `lentFromSlots`. It is a ledger figure of LIENED capital, not a
    ///         reading of vault balances: a fill that finds the vault short
    ///         refuses and never lends more than is there. A slot counts from
    ///         the moment its terms are set; the minimum age before a fill
    ///         (`ConfigFacet.getMinTermsAgeSec`, at most 60 seconds, #3443) is
    ///         left out. The borrow preview, which runs every fill check, is
    ///         the binding answer to what one borrow would get.
    /// @return lent The open principal of every ERC-20 loan in
    ///         `lendingAsset` that is `Active` or `FallbackPending`, from any
    ///         route.
    /// @return lentFromSlots The part of `lent` held from Auto-lend slots now:
    ///         exactly the sum of their live principal. "How full" is
    ///         `lentFromSlots / (lentFromSlots + available)`, on the same
    ///         start-of-day basis.
    /// @return lentInstant The part of `lent` opened through the instant
    ///         market (#3656), fixed when each loan opens.
    function getMarketLedger(address lendingAsset)
        external
        view
        returns (uint256 declared, uint256 available, uint256 lent, uint256 lentFromSlots, uint256 lentInstant)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.LentTotals storage t = s.lentByAsset[lendingAsset];
        return (
            LibMarketLedger.declaredOf(s.declaredByAsset[lendingAsset]),
            LibMarketLedger.declaredOf(s.availableByAsset[lendingAsset]),
            t.all,
            t.fromSlots,
            t.instant
        );
    }

    /// @notice The same five figures for one (lending asset, collateral
    ///         asset) pair, on the same basis. See {getMarketLedger}.
    function getPairLedger(address lendingAsset, address collateralAsset)
        external
        view
        returns (uint256 declared, uint256 available, uint256 lent, uint256 lentFromSlots, uint256 lentInstant)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.LentTotals storage t = s.lentByPair[lendingAsset][collateralAsset];
        return (
            LibMarketLedger.declaredOf(s.declaredByPair[lendingAsset][collateralAsset]),
            LibMarketLedger.declaredOf(s.availableByPair[lendingAsset][collateralAsset]),
            t.all,
            t.fromSlots,
            t.instant
        );
    }

    /// @notice One slot's share of the ledger now, on the same basis as
    ///         {getMarketLedger}.
    /// @return declared  Its largest exposure while active and in its window.
    /// @return fillable  Its fillable amount, its share of Available.
    /// @return live      The outstanding principal of the loans it holds.
    /// @return capital   Its reserved capital.
    function getSlotLedger(address owner, address lendingAsset, address collateralAsset, uint8 slot)
        external
        view
        returns (uint256 declared, uint256 fillable, uint256 live, uint256 capital)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        live = s.lenderIntentLivePrincipal[owner][lendingAsset][collateralAsset][slot];
        capital = s.lenderIntentCapital[owner][lendingAsset][collateralAsset][slot];
        (declared, fillable,) = LibMarketLedger.slotFigures(
            s.lenderIntent[owner][lendingAsset][collateralAsset][slot], capital, live
        );
    }

    // ─── Internals ────────────────────────────────────────────────────────

    function _onlyDiamond() private view {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
    }

    function _origin(LibVaipakam.Storage storage s, uint256 loanId)
        private
        view
        returns (LibVaipakam.IntentOrigin storage io)
    {
        io = s.intentOrigin[loanId];
        if (io.owner == address(0)) revert SlotOriginMissing(loanId);
    }

    function _sync(
        LibVaipakam.Storage storage s,
        address owner,
        address lendingAsset,
        address collateralAsset,
        uint8 slot
    ) private {
        uint256 capital = s.lenderIntentCapital[owner][lendingAsset][collateralAsset][slot];
        uint256 live = s.lenderIntentLivePrincipal[owner][lendingAsset][collateralAsset][slot];
        LibMarketLedger.syncIntent(
            s,
            s.lenderIntent[owner][lendingAsset][collateralAsset][slot],
            lendingAsset,
            collateralAsset,
            LibVaipakam.intentKeyHash(owner, lendingAsset, collateralAsset, slot),
            capital,
            live
        );
        // #3849 — every writer of a slot's capital or live principal reaches
        // this sync, so the backstop's per-asset lending capital (waiting plus
        // out, the base of its daily limit) is kept here, for its slot only.
        LibBackstopDailyLimit.syncPair(s, owner, lendingAsset, collateralAsset, slot, capital + live);
    }
}
