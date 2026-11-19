// src/facets/InstantFillFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibTiming} from "../libraries/LibTiming.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibDepositoryLedger} from "../libraries/LibDepositoryLedger.sol";
import {LibReadyBalance} from "../libraries/LibReadyBalance.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibMarketLedger} from "../libraries/LibMarketLedger.sol";
import {LibIntentFill} from "../libraries/LibIntentFill.sol";
import {LibOfferMatchExecute} from "../libraries/LibOfferMatchExecute.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";

/**
 * @title  InstantFillFacet
 * @author Vaipakam Developer Team
 * @notice Instant market (#3656, design §4) — ONE fill of a borrower's instant
 *         borrow: one source (an Auto-lend slot with the instant-market
 *         consent, or a standing lender offer), one loan.
 *         `InstantMarketFacet.borrowInstant` calls {fillInstant} once per
 *         source, through the Diamond, and reads a refusal as "skip and
 *         report"; a fill that reverts changes nothing.
 * @dev    Each fill materializes a transient borrower slice (the borrower's
 *         request, at the source's own price) and runs the shared match core
 *         (`LibOfferMatchExecute`), so every origination check runs for it:
 *         health factor, loan-to-value against the slot's or offer's limit,
 *         risk access, sanctions, self-trade, the ageing rule (#3443), the
 *         maker's price-move guard, expiry and the level rules. The match
 *         names no matcher, so no match share is paid: the borrower is never
 *         paid out of their own fee. Principal arrives in the borrower's
 *         vault as free balance, less the fee, as every loan's principal does.
 *         A slot fill draws from the slot's capital lien and runs the one
 *         slot rule (`LibIntentFill`) the solver route runs.
 *
 *         Its own facet: the match core is most of its size, and the
 *         borrower entry, settings and views (`InstantMarketFacet`) do not
 *         fit beside it under EIP-170. Refreshed together with
 *         InstantMarketFacet, which calls it.
 */
contract InstantFillFacet {
    /// @notice Only the Diamond itself may call {fillInstant}.
    error OnlyDiamondInternal();
    /// @notice The slot has not given the instant-market consent to fills
    ///         from a borrower's direct request, or gave it too recently.
    error InstantSlotNotOffered();
    /// @notice The source's price is above the borrower's highest accepted
    ///         rate.
    error InstantRateAboveLimit(uint256 rateBps, uint256 maxRateBps);
    /// @notice The offer is not a source for this request: not an ERC-20
    ///         lender offer on this pair, or its interest is owed for the full
    ///         term (an instant-market loan carries interest by time).
    error InstantOfferNotSource(uint256 offerId);
    /// @notice The source has nothing this request can take: an
    ///         all-or-nothing offer larger than what is still wanted, or no
    ///         room left.
    error InstantNothingToFill();

    /// @notice Where one fill comes from.
    /// @dev `kind` 0 = an Auto-lend slot (`owner`, `slot`); 1 = a standing
    ///      lender offer (`offerId`).
    struct InstantSource {
        uint8 kind;
        address owner;
        uint8 slot;
        uint256 offerId;
    }

    /// @notice One fill's request, as `borrowInstant` sizes it.
    struct FillRequest {
        address borrower;
        address lendingAsset;
        address collateralAsset;
        uint32 termDays;
        uint256 maxRateBps;
        bool allowsPartialRepay;
        InstantSource source;
        uint256 remaining; // principal still wanted
        uint256 collRemaining; // collateral still offered
        uint256 amountWanted; // the request's whole amount
        uint256 collateralOffered; // the request's whole collateral
    }

    /// @notice What one fill opened.
    struct FillResult {
        uint256 loanId;
        uint256 amount;
        uint256 rateBps;
        uint256 collateral;
        uint256 fromWallet; // collateral deposited from the wallet for this fill
    }

    /// @notice Open one loan from one source. Diamond-only.
    /// @dev The price is the source's own: a slot's minimum rate, an offer's
    ///      rate. The borrower slice asks exactly that rate, so the match
    ///      core's rate overlap is that one point. Collateral is the fill's
    ///      share of what the borrower offered, in proportion to principal;
    ///      the fill that completes the request takes the remainder. It comes
    ///      from the borrower's free vault balance first, then from the wallet.
    function fillInstant(FillRequest calldata r) external returns (FillResult memory res) {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        bool isSlot = r.source.kind == 0;
        uint256 lenderOfferId;
        uint256 reqColl;
        (res.amount, res.rateBps, res.collateral, reqColl) = _size(s, r);
        if (isSlot) {
            lenderOfferId = LibIntentFill.drawAndMaterialize(
                r.source.owner, r.lendingAsset, r.collateralAsset, r.source.slot, res.amount, reqColl,
                res.rateBps, r.termDays, false, r.allowsPartialRepay
            );
        } else {
            lenderOfferId = r.source.offerId;
        }
        res.fromWallet = _fundCollateral(r.borrower, r.collateralAsset, res.collateral);
        uint256 borrowerSlice = LibIntentFill.materialize(_borrowerSlice(r, res), r.borrower);
        // The borrower slice's collateral is the floor for this match, so the
        // match locks exactly the share drawn above.
        res.loanId = LibOfferMatchExecute.executeMatchFor(
            lenderOfferId, borrowerSlice, res.collateral, address(0)
        );
        if (isSlot) {
            LibIntentFill.recordSlotLoan(
                s, res.loanId, r.source.owner, r.lendingAsset, r.collateralAsset,
                r.source.slot, res.amount
            );
            LibIntentFill.retireLenderSlice(s, lenderOfferId);
        }
        LibMarketLedger.markInstant(s, s.loans[res.loanId]);
    }

    /// @notice #3761 — what one source would give this request now: the
    ///         principal, the source's price and the collateral share, sized
    ///         by the same rule {fillInstant} sizes by. Reverts with the
    ///         source-level refusal {fillInstant} would raise.
    /// @dev    Covers the source only. The loan checks the match core runs
    ///         when the fill opens the loan (health factor, loan-to-value,
    ///         risk access, sanctions, the ageing and price-move rules) and
    ///         the collateral funding are not in it; `borrowInstant` reports
    ///         a fill they refuse as a skipped source.
    function quoteFill(FillRequest calldata r)
        external
        view
        returns (uint256 amount, uint256 rateBps, uint256 collateral)
    {
        (amount, rateBps, collateral, ) = _size(LibVaipakam.storageSlot(), r);
    }

    /// @dev The one sizing rule for a fill: the source's amount and price,
    ///      then the fill's share of the borrower's collateral, in proportion
    ///      to principal, the fill that completes the request taking the
    ///      remainder. `reqColl` is a slot's collateral requirement (zero for
    ///      an offer source).
    function _size(LibVaipakam.Storage storage s, FillRequest calldata r)
        private
        view
        returns (uint256 amount, uint256 rateBps, uint256 collateral, uint256 reqColl)
    {
        if (r.source.kind == 0) {
            (amount, rateBps, reqColl) = _sizeSlot(s, r);
        } else {
            (amount, rateBps) = _sizeOffer(s, r);
        }
        collateral = amount == r.remaining
            ? r.collRemaining
            : (amount * r.collateralOffered) / r.amountWanted;
    }

    /// @dev A slot source: the instant-market consent (aged like the slot's
    ///      terms), the price limit, then the one slot rule. The draw is the
    ///      fill's.
    function _sizeSlot(LibVaipakam.Storage storage s, FillRequest calldata r)
        private
        view
        returns (uint256 amount, uint256 rateBps, uint256 reqColl)
    {
        address owner = r.source.owner;
        uint8 slot = r.source.slot;
        LibVaipakam.LenderIntent memory intent =
            s.lenderIntent[owner][r.lendingAsset][r.collateralAsset][slot];
        LibIntentFill.requireSlotLive(intent, owner);
        LibVaipakam.InstantSlot memory consent =
            s.instantSlot[owner][r.lendingAsset][r.collateralAsset][slot];
        if (!consent.fills) revert InstantSlotNotOffered();
        LibTiming.requireIntentAged(owner, consent.setAt);
        rateBps = intent.minRateBps;
        if (rateBps > r.maxRateBps) revert InstantRateAboveLimit(rateBps, r.maxRateBps);
        amount = _slotRoom(s, intent, owner, r);
        reqColl = LibIntentFill.admitFill(
            s, intent, owner, r.lendingAsset, r.collateralAsset, slot,
            r.termDays, false, r.allowsPartialRepay, amount
        );
    }

    /// @dev The most this slot can lend now: what is still wanted, capped at
    ///      the slot's exposure room and its funded capital. A result below
    ///      the slot's smallest fill is refused by the slot rule.
    function _slotRoom(
        LibVaipakam.Storage storage s,
        LibVaipakam.LenderIntent memory intent,
        address owner,
        FillRequest calldata r
    ) private view returns (uint256 amount) {
        uint8 slot = r.source.slot;
        uint256 live = s.lenderIntentLivePrincipal[owner][r.lendingAsset][r.collateralAsset][slot];
        amount = r.remaining;
        uint256 room = intent.maxExposure > live ? intent.maxExposure - live : 0;
        if (room < amount) amount = room;
        uint256 capital = s.lenderIntentCapital[owner][r.lendingAsset][r.collateralAsset][slot];
        if (capital < amount) amount = capital;
    }

    /// @dev An offer source: an ERC-20 lender offer on this pair with
    ///      interest by time, at or under the borrower's rate limit. A partial
    ///      offer gives what is still wanted up to its remaining amount; an
    ///      all-or-nothing offer gives its whole amount or nothing. Every
    ///      other condition (open, unexpired, aged, guarded, lifecycle terms
    ///      and term agreeing, its collateral requirement) is the match
    ///      core's.
    function _sizeOffer(LibVaipakam.Storage storage s, FillRequest calldata r)
        private
        view
        returns (uint256 amount, uint256 rateBps)
    {
        uint256 offerId = r.source.offerId;
        LibVaipakam.Offer storage o = s.offers[offerId];
        if (
            o.offerType != LibVaipakam.OfferType.Lender
                || o.assetType != LibVaipakam.AssetType.ERC20
                || o.lendingAsset != r.lendingAsset
                || o.collateralAsset != r.collateralAsset
                || o.useFullTermInterest
        ) revert InstantOfferNotSource(offerId);
        rateBps = o.interestRateBps;
        if (rateBps > r.maxRateBps) revert InstantRateAboveLimit(rateBps, r.maxRateBps);
        if (o.fillMode == LibVaipakam.FillMode.Aon) {
            amount = o.amount;
            if (amount > r.remaining) revert InstantNothingToFill();
        } else {
            uint256 cap = o.amountMax == 0 ? o.amount : o.amountMax;
            uint256 left = cap > o.amountFilled ? cap - o.amountFilled : 0;
            amount = left < r.remaining ? left : r.remaining;
            if (amount == 0) revert InstantNothingToFill();
        }
    }

    /// @dev Make `need` of collateral free in the borrower's vault: free vault
    ///      balance first, then one deposit of the rest from the wallet (the
    ///      borrower approved the Diamond for it). Returns the deposit.
    function _fundCollateral(address borrower, address collateralAsset, uint256 need)
        private
        returns (uint256 fromWallet)
    {
        // #3344 — only what the borrower may spend at once from the vault
        // counts: all free balance, or a protected account's Ready balance.
        // That part is drawn here (depository ledger first, then Ready); the
        // slice is then materialized as committed collateral, so neither is
        // drawn twice, and the wallet part is never counted as owner balance.
        uint256 free = LibEncumbrance.freeBalance(
            borrower, collateralAsset, 0, LibVaipakam.trackedHolding(borrower, collateralAsset, 0)
        );
        uint256 usable = LibReadyBalance.spendableViaHost(borrower, collateralAsset);
        if (usable > free) usable = free;
        uint256 fromVault = usable >= need ? need : usable;
        LibDepositoryLedger.spend(borrower, collateralAsset, 0, fromVault);
        LibReadyBalance.spendViaHost(borrower, collateralAsset, fromVault);
        if (fromVault == need) return 0;
        fromWallet = need - fromVault;
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultDepositERC20.selector, borrower, collateralAsset, fromWallet
            ),
            IVaipakamErrors.VaultDepositFailed.selector
        );
    }

    /// @dev The transient borrower slice: the borrower's request for exactly
    ///      this fill, at exactly the source's price, with interest by time
    ///      and the borrower's repayment shape. It is matched and closed in
    ///      this same call; it adds nothing to the open-offer count.
    function _borrowerSlice(FillRequest calldata r, FillResult memory res)
        private
        pure
        returns (LibVaipakam.CreateOfferParams memory p)
    {
        p.offerType = LibVaipakam.OfferType.Borrower;
        p.lendingAsset = r.lendingAsset;
        p.amount = res.amount;
        p.amountMax = res.amount;
        p.interestRateBps = res.rateBps;
        p.interestRateBpsMax = res.rateBps;
        p.collateralAsset = r.collateralAsset;
        p.collateralAmount = res.collateral;
        p.collateralAmountMax = res.collateral;
        p.durationDays = r.termDays;
        p.assetType = LibVaipakam.AssetType.ERC20;
        p.collateralAssetType = LibVaipakam.AssetType.ERC20;
        p.prepayAsset = r.lendingAsset; // unused for an ERC-20 loan; non-zero placeholder
        p.creatorRiskAndTermsConsent = true; // given on `borrowInstant`
        p.fillMode = LibVaipakam.FillMode.Partial;
        p.periodicInterestCadence = LibVaipakam.PeriodicInterestCadence.None;
        p.useFullTermInterest = false; // every instant-market loan carries interest by time
        p.allowsPartialRepay = r.allowsPartialRepay;
    }
}
