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
        // #394 Lever A (Codex #647 round-6) — the loan's snapshotted admission
        // HF floor (1e18-scaled). Carried in the dashboard projection so the HF
        // gauge colours each open loan against the floor IT was admitted under
        // (not a stale 1.5) after a governance retune. uint64 holds ≫ 2e18.
        uint64 minHealthFactorAtInit;
    }

    /// @dev #625 WI-2a — one row of `MetricsFacet.getActiveLenderIntents`: the lender's
    ///      standing bounds plus the two figures a keeper needs to size a fill —
    ///      `livePrincipal` (exposure already out) and `availableCapital` (un-lent, liened
    ///      capital the fill draws from; a fill exceeding it reverts
    ///      `IntentCapitalInsufficient`). `requiresKeeperAuth` lets the keeper skip an
    ///      intent it isn't delegated to fill.
    struct LenderIntentSummary {
        address owner;
        address lendingAsset;
        address collateralAsset;
        uint256 maxExposure;
        uint256 minRateBps;
        uint16 maxInitLtvBps;
        uint32 maxDurationDays;
        uint256 minFillAmount;
        bool requiresKeeperAuth;
        uint256 livePrincipal;
        uint256 availableCapital;
    }

    function toLenderIntentSummary(
        LibVaipakam.IntentKey memory key,
        LibVaipakam.LenderIntent storage i,
        uint256 livePrincipal,
        uint256 availableCapital
    ) internal view returns (LenderIntentSummary memory s) {
        s = LenderIntentSummary({
            owner: key.owner,
            lendingAsset: key.lendingAsset,
            collateralAsset: key.collateralAsset,
            maxExposure: i.maxExposure,
            minRateBps: i.minRateBps,
            maxInitLtvBps: i.maxInitLtvBps,
            maxDurationDays: i.maxDurationDays,
            minFillAmount: i.minFillAmount,
            requiresKeeperAuth: i.requiresKeeperAuth,
            livePrincipal: livePrincipal,
            availableCapital: availableCapital
        });
    }

    /// @dev #625 WI-2c — one row of `MetricsFacet.getRollableIntentLoans`: a
    ///      fully-repaid intent-originated loan a keeper can AUTO-ROLL via
    ///      `LenderIntentFacet.rollIntentLoan(loanId)`. `owner` /
    ///      `lendingAsset` / `collateralAsset` come from the per-loan
    ///      `intentOrigin` (NOT the live `loan.lender`, which a position sale
    ///      mutates — a sold position is reported but `rollIntentLoan` rejects
    ///      it, so the keeper still keys auth off `owner`). `amount` is the
    ///      original fill that would be re-liened as intent capital.
    struct RollableIntentLoan {
        uint256 loanId;
        address owner;
        address lendingAsset;
        address collateralAsset;
        uint256 amount;
    }

    function toRollableIntentLoan(
        uint256 loanId,
        LibVaipakam.IntentOrigin memory io
    ) internal pure returns (RollableIntentLoan memory r) {
        r = RollableIntentLoan({
            loanId: loanId,
            owner: io.owner,
            lendingAsset: io.lendingAsset,
            collateralAsset: io.collateralAsset,
            amount: io.amount
        });
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
            liquidationLtvBpsAtInit: l.liquidationLtvBpsAtInit,
            minHealthFactorAtInit: l.minHealthFactorAtInit
        });
    }
}
