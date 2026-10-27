// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title LibOfferShape
 * @author Vaipakam Developer Team
 * @notice The ONE definition of what a well-formed offer looks like: the
 *         principal range, the rate range and the collateral range, each
 *         checked against the offer's asset types, side and fill mode.
 *
 *         `OfferCreateFacet` (create, signed-offer materialization and the
 *         protocol's internal creates) and `OfferMutateFacet` (every in-place
 *         edit) both run their values through these checks, so an offer a
 *         mutation produces satisfies exactly the rules a create would have
 *         applied to it (#2749). Before this, each facet carried its own copy
 *         and the mutate copy lagged: it never read `fillMode`, so an
 *         all-or-nothing offer could be edited into a range its matcher reads
 *         as a one-unit "full fill".
 *
 *         Rules that only make sense for one surface stay on that surface:
 *         mutate's floors under the already-filled portion and its per-shape
 *         freezes, create's expiry and IOC window. Everything that describes
 *         the offer's own shape is here.
 *
 *         The error declarations moved here from `OfferCreateFacet` unchanged.
 *         An error's selector is its name and parameter types, not the
 *         contract that declares it, so every revert keeps the selector it had.
 */
library LibOfferShape {
    /// @notice `amount == 0`. Every offer must have a positive minimum.
    error AmountMustBePositive();
    /// @notice `amountMax == 0`. Every offer carries an explicit ceiling.
    error AmountMaxMustBePositive();
    /// @notice Range invariant: `amount > amountMax`.
    error InvalidAmountRange();
    /// @notice #1281 item 021 — an NFT-rental offer (`assetType` ERC721 /
    ///         ERC1155) must stay single-value on amount. A rental's `amount`
    ///         is its DAILY FEE, and every rental path prices the prepayment
    ///         from it, so a range would leave the prepayment short.
    error RentalAmountRangeNotAllowed();
    /// @notice #125 — an all-or-nothing offer (`fillMode == Aon`) must stay
    ///         single-value on amount: only the full fill is reachable, and
    ///         the match-time gate compares the fill against `amount`.
    error AonRequiresSingleValueAmount();
    /// @notice Range invariant: `interestRateBps > interestRateBpsMax`.
    error InvalidRateRange();
    /// @notice Range invariant: `interestRateBpsMax > MAX_INTEREST_BPS`.
    error InterestRateAboveCeiling();
    /// @notice `collateralAmount == 0` on an ERC-20 loan against ERC-20
    ///         collateral that is not the protocol's lender-sale vehicle.
    error CollateralMustBePositive();
    /// @notice `collateralAmountMax == 0` on the same shape.
    error CollateralAmountMaxMustBePositive();
    /// @notice #164 — `collateralAmount > collateralAmountMax`.
    error InvalidCollateralAmountRange();
    /// @notice #164 — a lender offer is single-value on collateral: its
    ///         `collateralAmount` is the requirement at `amountMax`, and a
    ///         separate maximum would carry no meaning.
    error LenderCollateralRangeNotAllowed();
    /// @notice #2949 — an NFT-rental offer (`assetType` ERC721 / ERC1155)
    ///         named a collateral asset, asset type, amount, token id or
    ///         quantity. A rental carries no collateral: its commitment is the
    ///         prepaid fee, and the rented NFT never leaves the vault, so any
    ///         collateral field it named would move nothing yet still be read
    ///         (an acknowledgement asked of the renter, a risk-access pair, the
    ///         loan record).
    error RentalCollateralNotAllowed();

    /**
     * @notice Revert unless the principal range is well-formed for the
     *         offer's asset type and fill mode.
     * @param assetType  The lending leg's asset type.
     * @param fillMode   The offer's fill mode.
     * @param amount     The range floor (the daily fee for a rental).
     * @param amountMax  The range ceiling.
     */
    function assertAmount(
        LibVaipakam.AssetType assetType,
        LibVaipakam.FillMode fillMode,
        uint256 amount,
        uint256 amountMax
    ) internal pure {
        if (amount == 0) revert AmountMustBePositive();
        if (amountMax == 0) revert AmountMaxMustBePositive();
        if (amountMax < amount) revert InvalidAmountRange();
        if (amountMax != amount) {
            if (assetType != LibVaipakam.AssetType.ERC20) {
                revert RentalAmountRangeNotAllowed();
            }
            if (fillMode == LibVaipakam.FillMode.Aon) {
                revert AonRequiresSingleValueAmount();
            }
        }
    }

    /**
     * @notice Revert unless the rate range is well-formed. A zero rate on
     *         both ends is a legitimate shape (an NFT rental carries no APR,
     *         and a no-interest ERC-20 loan is a real offer), so only the
     *         ordering and the protocol ceiling are checked.
     * @param rateBps     The range floor.
     * @param rateBpsMax  The range ceiling.
     */
    function assertRate(uint256 rateBps, uint256 rateBpsMax) internal pure {
        if (rateBpsMax < rateBps) revert InvalidRateRange();
        if (rateBpsMax > LibVaipakam.MAX_INTEREST_BPS) {
            revert InterestRateAboveCeiling();
        }
    }

    /**
     * @notice Revert unless the collateral range is well-formed for the
     *         offer's side and asset types.
     * @dev    An ERC-20 loan against ERC-20 collateral must post a positive
     *         collateral floor and ceiling. The single exception is the
     *         lender-sale vehicle (`saleVehicle`), which posts none because
     *         the collateral already securing the linked live loan continues
     *         to back it (spec: ProjectDetailsREADME, lender early
     *         withdrawal). Before #2729 the exception was keyed on the
     *         offer's SHAPE (both values zero) rather than on who was
     *         creating it, so any creator could post a zero-collateral offer;
     *         against illiquid collateral, which is valued at zero and
     *         admitted on mutual consent, nothing else refused it, and a
     *         lender could fund a loan backed by nothing. NFT collateral is
     *         locked by token id / quantity rather than an amount, and an NFT
     *         rental carries no collateral at all (#2949, spec:
     *         ProjectDetailsREADME, NFT renting): its commitment is its
     *         prepaid fee, so every collateral field must be empty — no asset,
     *         the zero asset type, and a zero amount, ceiling, token id and
     *         quantity. The same rule binds at create and at every edit, so a
     *         rental can never come to name collateral.
     * @param offerType            Lender or borrower side.
     * @param assetType            The lending leg's asset type.
     * @param collateralAsset      The collateral leg's asset.
     * @param collateralAssetType  The collateral leg's asset type.
     * @param collateralAmount     The range floor.
     * @param collateralAmountMax  The range ceiling.
     * @param collateralTokenId    The collateral NFT's token id.
     * @param collateralQuantity   The collateral ERC-1155 quantity.
     * @param saleVehicle          True only inside the protocol's own
     *                             lender-sale-vehicle create
     *                             (`Storage.saleVehicleCreate`).
     */
    function assertCollateral(
        LibVaipakam.OfferType offerType,
        LibVaipakam.AssetType assetType,
        address collateralAsset,
        LibVaipakam.AssetType collateralAssetType,
        uint256 collateralAmount,
        uint256 collateralAmountMax,
        uint256 collateralTokenId,
        uint256 collateralQuantity,
        bool saleVehicle
    ) internal pure {
        if (assetType != LibVaipakam.AssetType.ERC20) {
            if (
                collateralAsset != address(0)
                || collateralAssetType != LibVaipakam.AssetType.ERC20
                || (collateralAmount | collateralAmountMax | collateralTokenId | collateralQuantity) != 0
            ) revert RentalCollateralNotAllowed();
            return;
        }
        if (
            collateralAssetType == LibVaipakam.AssetType.ERC20
            && !(saleVehicle && collateralAmount == 0 && collateralAmountMax == 0)
        ) {
            if (collateralAmount == 0) revert CollateralMustBePositive();
            if (collateralAmountMax == 0) revert CollateralAmountMaxMustBePositive();
        }
        if (collateralAmountMax < collateralAmount) {
            revert InvalidCollateralAmountRange();
        }
        if (
            offerType == LibVaipakam.OfferType.Lender
            && collateralAmountMax != collateralAmount
        ) {
            revert LenderCollateralRangeNotAllowed();
        }
    }
}
