// src/libraries/LibIntentFill.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibTiming} from "./LibTiming.sol";
import {LibProtectedAccount} from "./LibProtectedAccount.sol";
import {LibRiskMath} from "./LibRiskMath.sol";
import {LibEncumbrance} from "./LibEncumbrance.sol";
import {LibFacet} from "./LibFacet.sol";
import {LibMetricsHooks} from "./LibMetricsHooks.sol";
import {LibIntentTerms} from "./LibIntentTerms.sol";
import {LibSignedOffer} from "./LibSignedOffer.sol";
import {LibOfferMatchExecute} from "./LibOfferMatchExecute.sol";
import {OfferMaterializeFacet} from "../facets/OfferMaterializeFacet.sol";
import {VaipakamNFTFacet} from "../facets/VaipakamNFTFacet.sol";
import {MarketLedgerFacet} from "../facets/MarketLedgerFacet.sol";
import {OfferPriceGuardFacet} from "../facets/OfferPriceGuardFacet.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title  LibIntentFill
 * @author Vaipakam Developer Team
 * @notice The one rule for filling an Auto-lend slot (a lender's standing
 *         intent), shared by every route that fills one: a solver's
 *         `OfferMatchIntentFacet.matchIntent` and a borrower's own instant
 *         borrow (`InstantFillFacet`, #3656). Both run the same admission
 *         (the slot is active and its terms aged, the fill is within its
 *         smallest fill, its exposure, its longest term and its lend-until
 *         time, its lifecycle terms admitted, the pair calm unless the slot's
 *         owner switched that check off, its loan-to-value limit
 *         resolvable), draw the fill from the slot's capital lien the same
 *         way, materialize the lender slice the same way, and record the
 *         loan's slot origin the same way. A route adds only what is its own:
 *         the solver route its keeper-authorization check and service-capacity
 *         charge, the instant route its instant-market consent.
 * @dev    Inlined into each host; every check reverts with the error the
 *         solver route has always raised, so the two routes refuse a slot
 *         with the same reason.
 */
library LibIntentFill {
    /// @notice No active standing intent for `(lender, lendingAsset, collateralAsset, slot)`.
    error LenderIntentInactive();
    /// @notice `fillAmount` is below the intent's `minFillAmount`, or zero.
    error LenderIntentFillBelowMin();
    /// @notice This fill would push the intent's live principal past `maxExposure`.
    error LenderIntentExposureExceeded();
    /// @notice The loan's term exceeds the intent's `maxDurationDays`.
    error LenderIntentDurationTooLong();
    /// @notice #3618 — the loan would be agreed to mature after the intent's
    ///         lend-until time. `maturity` is the loan's agreed maturity (now +
    ///         the term); `lendUntil` is the intent's bound.
    error LenderIntentPastLendUntil(uint256 maturity, uint256 lendUntil);
    /// @notice The request is pro-rata (`useFullTermInterest == false`) and
    ///         the intent has not opted in (`acceptsProRata`, #3619).
    error LenderIntentFullTermRequired();
    /// @notice The request allows partial repayment on terms the intent does
    ///         not admit ({LibIntentTerms.lifecycleVerdict}).
    error LenderIntentPartialRepayNotAllowed();
    /// @notice The init-LTV-cap collateral floor is unresolvable (missing oracle
    ///         price / illiquid collateral), so the intent's LTV ceiling can't be
    ///         enforced — refuse rather than open a loan blind to the bound.
    error LenderIntentCollateralUnresolvable();

    /// @dev The slot exists and its terms have stood the minimum age (#3443).
    function requireSlotLive(LibVaipakam.LenderIntent memory intent, address lender) internal view {
        // The standing-intent fill switch stops every route that draws a
        // slot's capital (a match, an instant borrow, a takeover), here, once.
        if (!LibVaipakam.storageSlot().protocolCfg.lenderIntentEnabled) {
            revert LibOfferMatchExecute.FunctionDisabled(4);
        }
        if (!intent.active) revert LenderIntentInactive();
        LibTiming.requireIntentAged(lender, intent.termsSetAt);
        // A slot's capital becomes a new loan commitment of its owner, so an
        // owner who may not open one (a locked, retired or recovered
        // account) has no live slot, on every route that draws one.
        LibProtectedAccount.requireCanOpen(lender);
    }

    /// @dev The fill-level admission: smallest fill, exposure, longest term,
    ///      lend-until, lifecycle terms, the calm-price check, and the
    ///      collateral the slot's LTV limit requires for `fillAmount`.
    /// @return reqColl The collateral the slot's init-LTV ceiling requires.
    function admitFill(
        LibVaipakam.Storage storage s,
        LibVaipakam.LenderIntent memory intent,
        address lender,
        address lendingAsset,
        address collateralAsset,
        uint8 slot,
        uint256 durationDays,
        bool useFullTermInterest,
        bool allowsPartialRepay,
        uint256 fillAmount
    ) internal view returns (uint256 reqColl) {
        if (fillAmount == 0 || fillAmount < intent.minFillAmount) revert LenderIntentFillBelowMin();
        // The slot's live principal is the outstanding principal of the loans
        // it holds (#3714), so the exposure cap bounds what is out now.
        if (
            s.lenderIntentLivePrincipal[lender][lendingAsset][collateralAsset][slot] + fillAmount
                > intent.maxExposure
        ) revert LenderIntentExposureExceeded();
        if (durationDays > intent.maxDurationDays) revert LenderIntentDurationTooLong();
        {
            (bool fits, uint256 maturity) = LibIntentTerms.fitsLendUntil(intent, durationDays);
            if (!fits) revert LenderIntentPastLendUntil(maturity, intent.lendUntil);
        }
        LibIntentTerms.Lifecycle verdict = LibIntentTerms.lifecycleVerdict(
            intent.acceptsProRata, useFullTermInterest, allowsPartialRepay
        );
        if (verdict == LibIntentTerms.Lifecycle.FullTermRequired) revert LenderIntentFullTermRequired();
        if (verdict == LibIntentTerms.Lifecycle.PartialRepayNotAllowed) {
            revert LenderIntentPartialRepayNotAllowed();
        }
        // The calm-price check (on unless the slot's owner switched it off):
        // no fill while the pair moved past the calm bound in the last two
        // hours, a checkpoint is missing, or a price cannot be read.
        OfferPriceGuardFacet(address(this)).requireIntentPairCalm(lender, lendingAsset, collateralAsset, slot);
        reqColl = LibRiskMath.minCollateralForLtvCap(
            fillAmount, lendingAsset, collateralAsset, intent.maxInitLtvBps
        );
        if (reqColl == 0 || reqColl == type(uint256).max) revert LenderIntentCollateralUnresolvable();
    }

    /// @dev Draw the fill from the slot's capital lien (reverts
    ///      `IntentCapitalInsufficient` past the funded capital), re-sync the
    ///      discovery registry, and materialize the single-fill lender slice
    ///      (creator = lender) at the slot's minimum rate.
    function drawAndMaterialize(
        address lender,
        address lendingAsset,
        address collateralAsset,
        uint8 slot,
        uint256 fillAmount,
        uint256 reqColl,
        uint256 minRateBps,
        uint256 durationDays,
        bool useFullTermInterest,
        bool allowsPartialRepay
    ) internal returns (uint256 sliceOfferId) {
        LibEncumbrance.unlienIntentCapital(lender, lendingAsset, collateralAsset, slot, fillAmount);
        LibVaipakam.syncIntentRegistry(lender, lendingAsset, collateralAsset, slot);
        LibVaipakam.CreateOfferParams memory p;
        p.offerType = LibVaipakam.OfferType.Lender;
        p.lendingAsset = lendingAsset;
        p.amount = fillAmount;
        p.amountMax = fillAmount; // single-fill slice
        p.interestRateBps = minRateBps; // the lender's floor
        p.interestRateBpsMax = LibVaipakam.MAX_INTEREST_BPS; // accept any rate ≥ floor
        p.collateralAsset = collateralAsset;
        p.collateralAmount = reqColl; // init-LTV-cap requirement
        p.collateralAmountMax = reqColl;
        p.durationDays = durationDays;
        p.assetType = LibVaipakam.AssetType.ERC20;
        p.collateralAssetType = LibVaipakam.AssetType.ERC20;
        p.prepayAsset = lendingAsset; // unused for ERC20 lend; non-zero placeholder
        p.creatorRiskAndTermsConsent = true; // consent captured when the slot was set
        p.fillMode = LibVaipakam.FillMode.Partial;
        p.periodicInterestCadence = LibVaipakam.PeriodicInterestCadence.None;
        // #2727 / #3619 — the slice carries the request's interest mode and
        // repayment shape, already checked against the slot in {admitFill}.
        p.useFullTermInterest = useFullTermInterest;
        p.allowsPartialRepay = allowsPartialRepay;
        sliceOfferId = materialize(p, lender);
    }

    /// @dev Record the loan's slot origin after the match: the origin key (so
    ///      the release survives a lender-position sale), the roll-discovery
    ///      entry, and, on the ledger's one host
    ///      (`MarketLedgerFacet.onSlotFilled`), the slot's live principal, the
    ///      lent-from-slots figure and the slot's Declared and Available
    ///      shares (#3714). `amount` is the loan's principal as it joins the
    ///      slot; the live principal follows the outstanding principal from
    ///      then on.
    function recordSlotLoan(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        address lender,
        address lendingAsset,
        address collateralAsset,
        uint8 slot,
        uint256 amount
    ) internal {
        s.intentOrigin[loanId] = LibVaipakam.IntentOrigin({
            owner: lender,
            lendingAsset: lendingAsset,
            collateralAsset: collateralAsset,
            amount: amount,
            slot: slot
        });
        LibVaipakam.addIntentLoan(loanId);
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(MarketLedgerFacet.onSlotFilled.selector, loanId),
            IVaipakamErrors.CrossFacetCallFailed.selector
        );
    }

    /// @dev The lender slice is the match ACCEPTOR, so its own OfferCreated
    ///      NFT and reverse-map entry are orphaned: burn and unmap them so it
    ///      is not a phantom open offer.
    function retireLenderSlice(LibVaipakam.Storage storage s, uint256 sliceOfferId) internal {
        LibMetricsHooks.onOfferAccepted(sliceOfferId);
        uint256 slicePosToken = s.offers[sliceOfferId].positionTokenId;
        delete s.offerIdByPositionTokenId[slicePosToken];
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(VaipakamNFTFacet.retirePosition.selector, slicePosToken),
            LibOfferMatchExecute.NFTBurnFailed.selector
        );
    }

    /// @dev Materialize a single-fill slice as an on-chain offer with
    ///      `creator` through the self-gated committed-capital entry (checks
    ///      and liens free vault balance; draws neither the depository ledger
    ///      nor the Ready balance, #3344). Bubbles the inner revert.
    function materialize(LibVaipakam.CreateOfferParams memory params, address creator)
        internal
        returns (uint256 sliceOfferId)
    {
        // slither-disable-next-line low-level-calls
        (bool ok, bytes memory res) = address(this).call(
            abi.encodeWithSelector(
                OfferMaterializeFacet.createCommittedSliceVault.selector, creator, params,
                LibSignedOffer.MakerFull(false, 0, false) // #1949 — a slice carries no maker Full
            )
        );
        if (!ok) {
            if (res.length > 0) {
                assembly {
                    revert(add(res, 0x20), mload(res))
                }
            }
            revert LibOfferMatchExecute.SignedOfferMaterializeFailed();
        }
        sliceOfferId = abi.decode(res, (uint256));
    }
}
