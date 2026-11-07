// src/facets/OfferBookFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {LibRiskMath} from "../libraries/LibRiskMath.sol";
import {LibOfferAdmission} from "../libraries/LibOfferAdmission.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {OfferCreateFacet} from "./OfferCreateFacet.sol";

/**
 * @title OfferBookFacet
 * @author Vaipakam Developer Team
 * @notice The step where a new offer enters the offer book (#3242), and the
 *         one runtime copy of the book bounds in {LibOfferAdmission}.
 *
 *         Every offer creation ends with a self-call to {openOfferOnBook},
 *         once the offer's row is written, its assets are in the creator's
 *         vault and its position NFT is minted. It applies the two book
 *         bounds (the value floor and the per-wallet open-offer cap), records
 *         the offer in the active index the bounds and the book views read,
 *         and announces it: `OfferCreated`, then `OfferCreatedDetails`. Both
 *         events are `OfferCreateFacet`'s own declarations, emitted from here
 *         by name, so their signatures and topic hashes are unchanged.
 *
 *         An offer whose amount changes is re-checked against the same floor
 *         through {requireOfferValueAdmitted}, and {getOfferBookBounds} states
 *         the bounds in effect for a wallet before it signs.
 * @dev Split out of `OfferCreateFacet`, which had about 100 bytes of EIP-170
 *      headroom: this is the tail of its creation, moved whole. Refreshed
 *      together with `OfferCreateFacet` and `OfferMutateFacet`: a creator
 *      refreshed without this host reverts `FunctionDoesNotExist` on every
 *      create (a hard revert, never an offer missing from the index).
 */
contract OfferBookFacet is IVaipakamErrors {
    /**
     * @notice Admits offer `offerId`, just written by a creation through
     *         `route`, to the offer book: reverts with the first book bound
     *         it breaks, otherwise records it as open and emits
     *         `OfferCreated` and `OfferCreatedDetails`.
     * @dev Diamond-internal: only `OfferCreateFacet`'s creation paths reach
     *      it, through a self-call, inside their own reentrancy guard.
     * @param offerId The offer just created.
     * @param route   How the creation reached `OfferCreateFacet`; it decides
     *                which bounds apply (see {LibOfferAdmission.enforceBounds}).
     */
    function openOfferOnBook(uint256 offerId, LibOfferAdmission.Route route) external {
        if (msg.sender != address(this)) revert UnauthorizedCrossFacetCall();
        LibVaipakam.Offer storage offer = LibVaipakam.storageSlot().offers[offerId];
        LibOfferAdmission.enforceBounds(offer, route);
        LibMetricsHooks.onOfferCreated(offer);
        emit OfferCreateFacet.OfferCreated(offerId, offer.creator, offer.offerType);
        _emitOfferCreatedDetails(offerId, offer);
    }

    /**
     * @notice #3242 — reverts `OfferBelowMinimumValue` when an ERC-20
     *         principal of `amount` can be priced and is worth less than the
     *         offer floor; returns otherwise. `OfferMutateFacet` calls it when
     *         an offer's amount changes.
     * @param lendingAsset The offer's principal asset.
     * @param assetType    The principal's asset type; only an ERC-20 is
     *                     valued.
     * @param amount       The proposed amount, in base units.
     */
    function requireOfferValueAdmitted(
        address lendingAsset,
        LibVaipakam.AssetType assetType,
        uint256 amount
    ) external view {
        LibOfferAdmission.enforceValue(lendingAsset, assetType, amount);
    }

    /**
     * @notice #3242 — the offer-book bounds in effect, and where `wallet`
     *         stands against the cap.
     * @param wallet The wallet asked about.
     * @return minOfferValueNumeraire The value floor on a priced principal,
     *         1e18 numeraire units.
     * @return maxOpenOffers The most offers one wallet may have open.
     * @return openOffers How many `wallet` has open now (an expired offer
     *         counts until it is cancelled).
     */
    function getOfferBookBounds(address wallet)
        external
        view
        returns (uint256 minOfferValueNumeraire, uint256 maxOpenOffers, uint256 openOffers)
    {
        return (
            LibVaipakam.cfgMinOfferValueNumeraire(),
            LibVaipakam.cfgMaxOpenOffersPerWallet(),
            LibVaipakam.storageSlot().openOfferCount[wallet]
        );
    }

    /**
     * @notice #3242 — the smallest amount of ERC-20 `lendingAsset` the value
     *         floor admits as an offer's `amount` (a lender offer's smallest
     *         fill), so a form can size it before the offer is posted.
     * @param lendingAsset The principal asset.
     * @return binds  False when the floor does not apply to this token (not
     *                liquid, or no price now); any amount is admitted then.
     * @return amount The smallest admitted amount in base units, when
     *                `binds`; 0 otherwise.
     */
    function getMinOfferAmount(address lendingAsset) external view returns (bool binds, uint256 amount) {
        return LibOfferAdmission.minAdmittedAmount(lendingAsset);
    }

    /// @dev Emits `OfferCreatedDetails`. Moved verbatim from
    ///      `OfferCreateFacet` (#3242); populated field by field on a memory
    ///      struct to stay clear of viaIR's stack limit at the emit site.
    function _emitOfferCreatedDetails(uint256 offerId, LibVaipakam.Offer storage offer) private {
        OfferCreateFacet.OfferCreatedFields memory f;
        f.offerType = offer.offerType;
        f.assetType = offer.assetType;
        f.collateralAssetType = offer.collateralAssetType;
        f.amount = offer.amount;
        f.tokenId = offer.tokenId;
        f.collateralAsset = offer.collateralAsset;
        f.collateralAmount = offer.collateralAmount;
        f.interestRateBps = offer.interestRateBps;
        f.durationDays = offer.durationDays;
        // Issue #102 / ADR-0010 §3 — indexers see the LOGICAL borrower
        // amount ceiling, never the storage default. The GTC default ships
        // `amountMax = 0` on borrower offers and derives the effective
        // ceiling at match time from `collateralAmountMax × effective
        // init-LTV cap`. Apply the same collapse here so the event payload
        // mirrors what `previewMatch` sees. Lender offers always have
        // `amountMax > 0`, so the conditional is a no-op for them.
        if (offer.amountMax == 0 && offer.offerType == LibVaipakam.OfferType.Borrower) {
            uint8 effTier = OracleFacet(address(this)).getEffectiveLiquidityTier(offer.collateralAsset);
            uint256 maxLtv = LibVaipakam.assetInitLtvCeilingBps(offer.collateralAsset);
            uint256 tierCap = uint256(LibVaipakam.effectiveTierMaxInitLtvBps(effTier));
            uint256 cap = maxLtv < tierCap ? maxLtv : tierCap;
            uint256 borrowerCollMax = offer.collateralAmountMax == 0
                ? offer.collateralAmount
                : offer.collateralAmountMax;
            f.amountMax = LibRiskMath.maxLendingForLtvCap(
                borrowerCollMax,
                offer.lendingAsset,
                offer.collateralAsset,
                cap
            );
        } else {
            f.amountMax = offer.amountMax;
        }
        f.interestRateBpsMax = offer.interestRateBpsMax;
        // Issue #169 — indexers see the LOGICAL upper bound, never the
        // storage default: a single-value offer leaves `collateralAmountMax`
        // at 0, which every read site collapses to `collateralAmount`.
        f.collateralAmountMax = offer.collateralAmountMax == 0
            ? offer.collateralAmount
            : offer.collateralAmountMax;
        f.creatorRiskAndTermsConsent = offer.creatorRiskAndTermsConsent;
        f.allowsPartialRepay = offer.allowsPartialRepay;
        f.periodicInterestCadence = offer.periodicInterestCadence;
        f.expiresAt = offer.expiresAt;
        f.fillMode = offer.fillMode;
        // T-086 step 4 — the lender's prepay-listing consent.
        f.allowsPrepayListing = offer.allowsPrepayListing;
        // T-092 Phase 2b — the refinance target, so indexers can tell a
        // refinance-tagged borrower offer from a standard one.
        f.refinanceTargetLoanId = offer.refinanceTargetLoanId;

        emit OfferCreateFacet.OfferCreatedDetails(offerId, offer.creator, offer.lendingAsset, f);
    }
}
