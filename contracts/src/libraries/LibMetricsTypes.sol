// src/libraries/LibMetricsTypes.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title LibMetricsTypes
 * @notice Lean FLAT projections of {LibVaipakam.Loan}/{Offer} for the
 *         paginated dashboard array-views, plus shared storage->DTO
 *         converters. Returning an array of the FULL struct inflates the
 *         viaIR ABI-coder's peak stack; a flat ~18-field projection keeps
 *         the array coder shallow. Lossy vs the full struct on purpose
 *         (rental/periodic/listing/snapshot fields omitted) — consumers
 *         needing those call the single-struct getLoanDetails/getOffer* views.
 */
library LibMetricsTypes {
    struct OfferSummary {
        uint256 id;
        LibVaipakam.OfferType offerType;
        bool accepted;
        uint64 createdAt;
        uint64 expiresAt;
        address lendingAsset;
        LibVaipakam.AssetType assetType;
        uint256 amount;
        uint256 amountMax;
        uint256 interestRateBps;
        uint256 interestRateBpsMax;
        uint256 durationDays;
        uint256 tokenId;
        uint256 amountFilled;
        address collateralAsset;
        LibVaipakam.AssetType collateralAssetType;
        uint256 collateralAmount;
        uint256 collateralTokenId;
        uint256 collateralQuantity;
    }

    struct LoanSummary {
        uint256 id;
        uint256 offerId;
        uint256 principal;
        address principalAsset;
        LibVaipakam.AssetType assetType;
        uint256 tokenId;
        uint256 interestRateBps;
        uint256 durationDays;
        uint64 startTime;
        LibVaipakam.LoanStatus status;
        address collateralAsset;
        uint256 collateralAmount;
        LibVaipakam.AssetType collateralAssetType;
        uint256 collateralTokenId;
        uint256 lenderTokenId;
        uint256 borrowerTokenId;
        bool allowsPartialRepay;
        uint16 liquidationLtvBpsAtInit;
    }

    function toOfferSummary(LibVaipakam.Offer storage o)
        internal view returns (OfferSummary memory s)
    {
        s = OfferSummary({
            id: o.id, offerType: o.offerType, accepted: o.accepted,
            createdAt: o.createdAt, expiresAt: o.expiresAt,
            lendingAsset: o.lendingAsset, assetType: o.assetType,
            amount: o.amount, amountMax: o.amountMax,
            interestRateBps: o.interestRateBps, interestRateBpsMax: o.interestRateBpsMax,
            durationDays: o.durationDays, tokenId: o.tokenId, amountFilled: o.amountFilled,
            collateralAsset: o.collateralAsset, collateralAssetType: o.collateralAssetType,
            collateralAmount: o.collateralAmount, collateralTokenId: o.collateralTokenId,
            collateralQuantity: o.collateralQuantity
        });
    }

    function toLoanSummary(LibVaipakam.Loan storage l)
        internal view returns (LoanSummary memory s)
    {
        s = LoanSummary({
            id: l.id, offerId: l.offerId, principal: l.principal,
            principalAsset: l.principalAsset, assetType: l.assetType, tokenId: l.tokenId,
            interestRateBps: l.interestRateBps, durationDays: l.durationDays,
            startTime: l.startTime, status: l.status,
            collateralAsset: l.collateralAsset, collateralAmount: l.collateralAmount,
            collateralAssetType: l.collateralAssetType, collateralTokenId: l.collateralTokenId,
            lenderTokenId: l.lenderTokenId, borrowerTokenId: l.borrowerTokenId,
            allowsPartialRepay: l.allowsPartialRepay,
            liquidationLtvBpsAtInit: l.liquidationLtvBpsAtInit
        });
    }
}
