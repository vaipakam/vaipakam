// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibPositionNFT} from "../libraries/LibPositionNFT.sol";
import {LibDepositoryLedger} from "../libraries/LibDepositoryLedger.sol";
import {LibTiming} from "../libraries/LibTiming.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {SaleExitVerdictFacet} from "./SaleExitVerdictFacet.sol";
import {EarlyWithdrawalDirectFacet} from "./EarlyWithdrawalDirectFacet.sol";
import {InstantTakeoverFacet} from "./InstantTakeoverFacet.sol";
import {LenderAdvanceFacet} from "./LenderAdvanceFacet.sol";
import {LibAdvance} from "../libraries/LibAdvance.sol";

/**
 * @title  LenderCashOutFacet
 * @author Vaipakam Developer Team
 * @notice #3760 — one door for a lender who wants cash from a loan they hold
 *         (LenderCashOutDesign §2–§4). {cashOptions} answers, for one lender
 *         position token, whether each of the three choices is open: Sell now,
 *         Sell at my price (the listing) and Borrow against it (the advance,
 *         `LenderAdvanceFacet`), with every refusal as the error the entry
 *         itself raises. {sellNow} sells the position to the first source, in
 *         the caller's order, that takes it, and reverts only when the seller
 *         would receive less than their stated least.
 * @dev    The routes stay as they are. Each fill runs through its route's own
 *         entry, by a Diamond-only self-call (`sellLoanViaBuyOfferFor`,
 *         `takeoverInstantFor`) that carries every check, price rule and
 *         seller-claim rule of the public entry. A source that refuses is
 *         unwound alone and reported with the error its route raised.
 *
 *         What the seller receives is MEASURED: the rise of the holder's free
 *         vault balance in the lending asset across the fill, which is where
 *         every sale route pays a seller (the payout rule). The least is held
 *         against that figure, never against a route's own report.
 *
 *         {previewSellNow} runs the same fills and unwinds each one, so the
 *         preview and the fill are one computation: the amounts it reports
 *         are what {sellNow} would move in the same block.
 *
 *         Until the lender side can be divided (#3674), a position is sold
 *         whole: the sources are tried in order until one takes all of it,
 *         and the rest are not tried.
 */
contract LenderCashOutFacet is DiamondReentrancyGuard, DiamondPausable {
    /// @notice The kinds of buyer "Sell now" draws on.
    /// @dev    APPEND-ONLY. `BuyingSlot` (an Auto-lend slot that buys at a
    ///         price, #3667 Part B) is defined now so the entry, the app and
    ///         the keeper do not change shape when it lands; until then a
    ///         source of that kind is skipped with {SourceKindNotAvailable}.
    enum SourceKind {
        TakeoverSlot,
        BuyOffer,
        BuyingSlot
    }

    /// @notice One buyer the caller found off chain.
    /// @param kind      The kind of buyer.
    /// @param slotOwner A slot's owner (TakeoverSlot, BuyingSlot).
    /// @param slot      The slot index (TakeoverSlot, BuyingSlot).
    /// @param offerId   The standing buy offer (BuyOffer).
    struct CashSource {
        SourceKind kind;
        address slotOwner;
        uint8 slot;
        uint256 offerId;
    }

    /// @notice What one source would do, or did.
    /// @param filled   The source took the position.
    /// @param received What reached the seller's vault from this source.
    /// @param reason   The source's refusal, ABI-encoded as the error its
    ///                 route raised (empty when it filled, or was not tried).
    struct SourceOutcome {
        bool filled;
        uint256 received;
        bytes reason;
    }

    /// @notice The route that already stands on a position and excludes the
    ///         others (§3: one open route per position).
    enum OpenRoute {
        None,
        Listing,
        Offset,
        Advance
    }

    /// @notice One choice's answer.
    /// @param open      The choice is open for this caller now.
    /// @param refusals  Every refusal, as the verdict reports them.
    struct ChoiceVerdict {
        bool open;
        SaleExitVerdictFacet.SaleRefusal[] refusals;
    }

    /// @notice The door's whole answer for one position.
    /// @param loanId          The loan the position belongs to.
    /// @param holder          The position's holder now.
    /// @param sellNow         The "Sell now" choice.
    /// @param sellAtMyPrice   The "Sell at my price" choice (the listing).
    /// @param borrowAgainstIt The "Borrow against it" choice (the advance).
    /// @param openRoute       The route already standing on the position.
    /// @param sourceKinds     The source kinds `caller` may name here: a
    ///                        standing buy offer for the holder alone, a
    ///                        takeover slot where the instant market runs.
    /// @param maxSellPrincipal The largest part that may be sold: the whole
    ///                        outstanding principal until the part sale exists.
    /// @param advanceCeiling  The largest advance the rules allow before any
    ///                        slot is chosen: 85% of the outstanding principal.
    ///                        A slot's own share and rate lower it; read
    ///                        `previewAdvance` for a figure a slot would pay.
    struct CashOptions {
        uint256 loanId;
        address holder;
        ChoiceVerdict sellNow;
        ChoiceVerdict sellAtMyPrice;
        ChoiceVerdict borrowAgainstIt;
        OpenRoute openRoute;
        SourceKind[] sourceKinds;
        uint256 maxSellPrincipal;
        uint256 advanceCeiling;
    }

    /// @notice At most this many sources per call (§4).
    uint256 public constant MAX_SELL_NOW_SOURCES = 8;

    /// @notice The token is not a live loan's lender position.
    error NotLenderPosition(uint256 tokenId);
    /// @notice Too many sources, or none.
    error SellNowSourceCount(uint256 count);
    /// @notice The fills reached less than the seller's stated least.
    error SellNowBelowLeast(uint256 received, uint256 least);
    /// @notice A part of a position cannot be sold until the part sale exists.
    error PartSaleNotAvailable(uint256 asked, uint256 principal);
    /// @notice The source kind does not exist on this deployment yet.
    error SourceKindNotAvailable(SourceKind kind);
    /// @notice Only the holder may sell into a standing buy offer; a keeper
    ///         acting for the holder may only use a takeover slot.
    error SourceNeedsHolder(SourceKind kind);
    /// @dev The preview's simulated fill: carries what the fill moved.
    error SellNowSimulated(uint256 received);

    /// @notice A source was tried and refused; the next was tried.
    event SellNowSourceSkipped(
        uint256 indexed tokenId, uint256 indexed loanId, uint256 index, SourceKind kind, bytes reason
    );
    /// @notice "Sell now" sold the position.
    /// @param received What reached the seller's vault, measured.
    /// @param index    The source that took it.
    event SellNowFilled(
        uint256 indexed tokenId,
        uint256 indexed loanId,
        address indexed seller,
        SourceKind kind,
        uint256 index,
        uint256 received,
        uint256 least
    );

    // ─── The one read ───────────────────────────────────────────────────

    /**
     * @notice The three choices for lender position `tokenId` and `caller`.
     * @param  tokenId The lender position token (never the loan alone: one
     *                 wallet may hold several positions of one loan, #3674).
     * @param  caller  Who would act: the holder, or a keeper for it.
     * @param  amount  Cash wanted: 0 for "all of it" (sell) or "as much as
     *                 the rules allow" (advance). A part sale is refused by
     *                 name until it exists.
     */
    function cashOptions(uint256 tokenId, address caller, uint256 amount)
        external
        view
        returns (CashOptions memory o)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 loanId = _loanOf(s, tokenId);
        LibVaipakam.Loan storage loan = s.loans[loanId];
        o.loanId = loanId;
        o.holder = LibPositionNFT.holderOrZero(tokenId);

        (SaleExitVerdictFacet.SaleRefusal[] memory direct, SaleExitVerdictFacet.SaleRefusal[] memory listing) =
            SaleExitVerdictFacet(address(this)).saleExitVerdict(loanId, caller);
        // A keeper acting under the holder's early-withdrawal mandate sells
        // through a takeover slot only, and the takeover judges the sale as
        // the holder: so is "sell now" here, with the takeover's own
        // position-level rule added (the instant market on, an instant-market
        // loan with interest by time, nothing held), read from the one copy
        // the takeover itself reverts with.
        bool keeperFor = o.holder != address(0) && caller != o.holder
            && LibAuth.keeperMayActFor(caller, LibVaipakam.KEEPER_ACTION_INIT_EARLY_WITHDRAW, loanId, o.holder);
        if (keeperFor) {
            (direct,) = SaleExitVerdictFacet(address(this)).saleExitVerdict(loanId, o.holder);
            bytes memory takeover = InstantTakeoverFacet(address(this)).takeoverPositionRefusal(loanId);
            if (takeover.length != 0) {
                direct = _append(direct, abi.encodeWithSelector(SourceNeedsHolder.selector, SourceKind.BuyOffer));
                direct = _append(direct, takeover);
            }
        }
        if (amount != 0 && amount != loan.principal) {
            bytes memory part = abi.encodeWithSelector(PartSaleNotAvailable.selector, amount, loan.principal);
            direct = _append(direct, part);
            listing = _append(listing, part);
        }
        o.sellNow = ChoiceVerdict(direct.length == 0, direct);
        o.sellAtMyPrice = ChoiceVerdict(listing.length == 0, listing);
        SaleExitVerdictFacet.SaleRefusal[] memory adv =
            LenderAdvanceFacet(address(this)).advanceRefusals(loanId, caller, amount);
        o.borrowAgainstIt = ChoiceVerdict(adv.length == 0, adv);

        if (LibAdvance.locked(s, loanId)) o.openRoute = OpenRoute.Advance;
        else if (s.loanToSaleOfferId[loanId] != 0) o.openRoute = OpenRoute.Listing;
        else if (s.loanToOffsetOfferId[loanId] != 0) o.openRoute = OpenRoute.Offset;

        // The kinds of source this caller may name: a standing buy offer for
        // the holder alone, a takeover slot where the instant market runs.
        uint256 kinds = (keeperFor ? 0 : 1) + (s.instantCfg.enabled ? 1 : 0);
        o.sourceKinds = new SourceKind[](kinds);
        if (!keeperFor) o.sourceKinds[0] = SourceKind.BuyOffer;
        if (s.instantCfg.enabled) o.sourceKinds[kinds - 1] = SourceKind.TakeoverSlot;
        o.maxSellPrincipal = loan.principal;
        o.advanceCeiling = (loan.principal * LenderAdvanceFacet(address(this)).ADVANCE_MAX_SHARE_BPS()) / 10_000;
    }

    // ─── Sell now ───────────────────────────────────────────────────────

    /**
     * @notice Sell lender position `tokenId` to the first of `sources` that
     *         takes it, receiving at least `least` in the lending asset.
     * @param  tokenId The lender position token.
     * @param  sources Buyers found off chain, best first (1 to 8).
     * @param  least   The least the seller will receive, in all.
     * @param  maxHeld The most held balance that may go with the position.
     * @param  validUntil The transaction deadline.
     * @return received What reached the seller's vault, measured.
     * @return outcomes One outcome per source, in order.
     */
    function sellNow(
        uint256 tokenId,
        CashSource[] calldata sources,
        uint256 least,
        uint256 maxHeld,
        uint64 validUntil
    ) external nonReentrant whenNotPaused returns (uint256 received, SourceOutcome[] memory outcomes) {
        LibTiming.requireDeadline(validUntil);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 loanId = _loanOf(s, tokenId);
        address seller = LibPositionNFT.ownerOf(tokenId);
        outcomes = _run(s, tokenId, loanId, seller, msg.sender, sources, least, maxHeld, false);
        uint256 index = type(uint256).max;
        for (uint256 i; i < outcomes.length; ++i) {
            if (outcomes[i].filled) {
                received = outcomes[i].received;
                index = i;
            } else if (outcomes[i].reason.length != 0) {
                emit SellNowSourceSkipped(tokenId, loanId, i, sources[i].kind, outcomes[i].reason);
            }
        }
        if (received < least || index == type(uint256).max) revert SellNowBelowLeast(received, least);
        emit SellNowFilled(tokenId, loanId, seller, sources[index].kind, index, received, least);
    }

    /**
     * @notice What {sellNow} would do now for `caller`, source by source.
     * @dev    Runs each fill exactly as {sellNow} does and unwinds it, so the
     *         figures are the fill's own. Not a view (the fills write before
     *         they unwind); call it with `eth_call`. Nothing it does remains.
     */
    function previewSellNow(uint256 tokenId, address caller, CashSource[] calldata sources, uint256 maxHeld)
        external
        nonReentrant
        returns (SourceOutcome[] memory outcomes)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 loanId = _loanOf(s, tokenId);
        outcomes =
            _run(s, tokenId, loanId, LibPositionNFT.ownerOf(tokenId), caller, sources, 0, maxHeld, true);
    }

    /**
     * @notice One fill, run and unwound for {previewSellNow}.
     * @dev    `address(this)`-gated, and always reverts: with
     *         {SellNowSimulated} carrying what reached the seller, or with the
     *         route's own refusal.
     */
    function simulateSellNowFill(
        uint256 loanId,
        address seller,
        address caller,
        CashSource calldata src,
        uint256 least,
        uint256 maxHeld
    ) external {
        if (msg.sender != address(this)) revert IVaipakamErrors.UnauthorizedCrossFacetCall();
        uint256 got = _fillOnce(loanId, seller, caller, src, least, maxHeld);
        revert SellNowSimulated(got);
    }

    /**
     * @notice One fill for {sellNow}, as its own call frame so a refusal
     *         unwinds that source alone.
     * @dev    `address(this)`-gated.
     * @return got What reached the seller's vault, measured.
     */
    function sellNowFill(
        uint256 loanId,
        address seller,
        address caller,
        CashSource calldata src,
        uint256 least,
        uint256 maxHeld
    ) external returns (uint256 got) {
        if (msg.sender != address(this)) revert IVaipakamErrors.UnauthorizedCrossFacetCall();
        got = _fillOnce(loanId, seller, caller, src, least, maxHeld);
    }

    // ─── Internals ──────────────────────────────────────────────────────

    function _run(
        LibVaipakam.Storage storage s,
        uint256 tokenId,
        uint256 loanId,
        address seller,
        address caller,
        CashSource[] calldata sources,
        uint256 least,
        uint256 maxHeld,
        bool simulate
    ) private returns (SourceOutcome[] memory outcomes) {
        if (sources.length == 0 || sources.length > MAX_SELL_NOW_SOURCES) {
            revert SellNowSourceCount(sources.length);
        }
        tokenId; // the position is named by the token; the loan is its record
        outcomes = new SourceOutcome[](sources.length);
        for (uint256 i; i < sources.length; ++i) {
            bytes memory reason = _precheck(s, loanId, seller, caller, sources[i]);
            if (reason.length != 0) {
                outcomes[i].reason = reason;
                continue;
            }
            (bool ok, bytes memory ret) = address(this).call(
                abi.encodeWithSelector(
                    simulate ? this.simulateSellNowFill.selector : this.sellNowFill.selector,
                    loanId, seller, caller, sources[i], least, maxHeld
                )
            );
            if (simulate) {
                if (ret.length == 36 && bytes4(ret) == SellNowSimulated.selector) {
                    outcomes[i].filled = true;
                    outcomes[i].received = abi.decode(_tail(ret), (uint256));
                } else {
                    outcomes[i].reason = ret;
                }
                // The preview reports every source on its own: each fill is
                // unwound, so a later source is judged on the same position.
                continue;
            }
            if (ok) {
                outcomes[i].filled = true;
                outcomes[i].received = abi.decode(ret, (uint256));
                break; // sold whole: the rest are not tried
            }
            outcomes[i].reason = ret;
        }
    }

    /// @dev The refusals the door itself raises before a source is tried.
    function _precheck(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        address seller,
        address caller,
        CashSource calldata src
    ) private view returns (bytes memory) {
        if (src.kind == SourceKind.BuyingSlot) {
            return abi.encodeWithSelector(SourceKindNotAvailable.selector, src.kind);
        }
        if (src.kind == SourceKind.BuyOffer && caller != seller) {
            return abi.encodeWithSelector(SourceNeedsHolder.selector, src.kind);
        }
        if (src.kind == SourceKind.TakeoverSlot && caller != seller) {
            // A keeper sells only under the holder's early-withdrawal
            // mandate, as on the takeover's own entry.
            if (!LibAuth.keeperMayActFor(caller, LibVaipakam.KEEPER_ACTION_INIT_EARLY_WITHDRAW, loanId, seller)) {
                return abi.encodeWithSelector(IVaipakamErrors.KeeperAccessRequired.selector);
            }
        }
        s;
        return "";
    }

    /// @dev Runs one source and measures what reached the seller's vault.
    function _fillOnce(
        uint256 loanId,
        address seller,
        address caller,
        CashSource calldata src,
        uint256 least,
        uint256 maxHeld
    ) private returns (uint256 got) {
        address asset = LibVaipakam.storageSlot().loans[loanId].principalAsset;
        uint256 before = LibDepositoryLedger.holding(seller, asset, 0);
        if (src.kind == SourceKind.BuyOffer) {
            EarlyWithdrawalDirectFacet(address(this)).sellLoanViaBuyOfferFor(
                seller, loanId, src.offerId, least, maxHeld
            );
        } else {
            InstantTakeoverFacet(address(this)).takeoverInstantFor(caller, loanId, src.slotOwner, src.slot);
        }
        got = LibDepositoryLedger.holding(seller, asset, 0) - before;
        if (got < least) revert SellNowBelowLeast(got, least);
    }

    function _loanOf(LibVaipakam.Storage storage s, uint256 tokenId) private view returns (uint256 loanId) {
        loanId = LibPositionNFT._storage().loanIds[tokenId];
        if (loanId == 0 || s.loans[loanId].lenderTokenId != tokenId) revert NotLenderPosition(tokenId);
    }

    function _append(SaleExitVerdictFacet.SaleRefusal[] memory a, bytes memory reason)
        private
        pure
        returns (SaleExitVerdictFacet.SaleRefusal[] memory out)
    {
        out = new SaleExitVerdictFacet.SaleRefusal[](a.length + 1);
        for (uint256 i; i < a.length; ++i) out[i] = a[i];
        out[a.length] = SaleExitVerdictFacet.SaleRefusal(reason, 0);
    }

    function _tail(bytes memory ret) private pure returns (bytes memory out) {
        out = new bytes(ret.length - 4);
        for (uint256 i; i < out.length; ++i) out[i] = ret[i + 4];
    }
}
