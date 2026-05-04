// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {LibVaipakam} from "./LibVaipakam.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";

/**
 * @title LibRiskMath
 * @notice Pure math helpers for the system-derived collateral floor /
 *         lending ceiling validated at `OfferFacet.createOffer` time
 *         under Range Orders Phase 1 (docs/RangeOffersDesign.md §3).
 *
 *         Both helpers solve `HF = (collateralUSD × liqThresholdBps /
 *         BASIS_POINTS) / debtUSD` for the unknown side at
 *         `HF == MIN_HEALTH_FACTOR` (1.5e18). The concrete USD values
 *         use the same Chainlink-feed conversion as
 *         `RiskFacet._computeUsdValues` (asset_amount × price /
 *         10**feedDec / 10**tokenDec) so the create-time bound matches
 *         the runtime HF gate semantics 1:1.
 *
 *         No storage. Reads from `OracleFacet.getAssetPrice` (oracle
 *         layer) and `s.assetRiskParams[collateralAsset].liqThresholdBps`
 *         (storage). Each call is two oracle reads + two `decimals()`
 *         reads + one storage read.
 *
 *         Returns 0 (skip-the-bound) when the collateral asset has no
 *         registered risk params (`liqThresholdBps == 0`) — treats
 *         missing-params as "illiquid, no HF gate at create-time, fall
 *         through to whatever the runtime HF gate decides at match."
 *         Same shape as `RiskFacet.calculateHealthFactor` which doesn't
 *         enforce HF on illiquid pairs.
 */
library LibRiskMath {
    /// @notice Smallest collateral amount (in collateral-asset native
    ///         units, NOT USD) that satisfies HF >= 1.5 against the
    ///         given lending amount. Lender-side gate at offer create.
    /// @dev    Returns 0 when oracle price is missing on either leg or
    ///         when the collateral asset has no registered risk params
    ///         — caller treats 0 as "no bound enforced" (fall through to
    ///         the runtime gate at match time).
    /// @param amountMax        The lender's `amountMax` (worst-case
    ///                         lending size used for the bound).
    /// @param principalAsset   ERC-20 the lender is offering.
    /// @param collateralAsset  ERC-20 the borrower will post.
    /// @return floor           Minimum collateral wei the lender may
    ///                         require on this offer.
    function minCollateralForLending(
        uint256 amountMax,
        address principalAsset,
        address collateralAsset
    ) internal view returns (uint256 floor) {
        if (amountMax == 0) return 0;

        LibVaipakam.RiskParams storage rp =
            LibVaipakam.storageSlot().assetRiskParams[collateralAsset];
        uint256 liqThresholdBps = rp.liqThresholdBps;
        if (liqThresholdBps == 0) {
            // Collateral asset has no risk params registered — treat as
            // "no create-time bound", fall through to runtime HF gate.
            return 0;
        }

        (uint256 principalUSD, uint256 priceCollateral, uint256 collateralScale) =
            _gatherUsd(amountMax, principalAsset, collateralAsset);
        if (principalUSD == 0 || priceCollateral == 0) return 0;

        // Solve for collateralUSD where HF == MIN_HEALTH_FACTOR (1.5e18):
        //   collateralUSD × liqThresholdBps / BASIS_POINTS
        //     == principalUSD × MIN_HEALTH_FACTOR / HF_SCALE
        //   collateralUSD
        //     == (principalUSD × MIN_HEALTH_FACTOR × BASIS_POINTS)
        //        / (HF_SCALE × liqThresholdBps)
        // BPS multiplications fit comfortably under uint256 since
        // principalUSD here is the (price-scaled but token-unscaled) raw
        // numerator of the USD figure RiskFacet uses; see _gatherUsd
        // below — it intentionally returns the un-divided-by-1e18 form
        // so the rest of the math stays in integers.
        uint256 collateralUSD =
            (principalUSD * LibVaipakam.MIN_HEALTH_FACTOR * LibVaipakam.BASIS_POINTS)
            / (LibVaipakam.HF_SCALE * liqThresholdBps);

        // Convert collateralUSD back to collateral-asset native units.
        // `collateralScale` already encodes the (10^feedDec × 10^tokenDec)
        // factor, so `collateral_native = collateralUSD × collateralScale
        // / collateralPrice` recovers the right number.
        floor = (collateralUSD * collateralScale) / priceCollateral;
        // Round up by 1 wei when there's any remainder so the caller
        // satisfies the >= relation strictly under integer truncation.
        if ((collateralUSD * collateralScale) % priceCollateral != 0) {
            floor += 1;
        }
    }

    /// @notice Largest lending amount (principal-asset wei) the borrower
    ///         can accept on the offer such that HF >= 1.5 with the
    ///         already-posted collateral. Borrower-side gate at offer
    ///         create.
    /// @dev    Returns `type(uint256).max` (no ceiling) when oracle
    ///         price is missing on either leg or when the collateral
    ///         asset has no registered risk params — fall through to the
    ///         runtime gate.
    /// @param collateralAmount The borrower's posted collateral, native units.
    /// @param principalAsset   ERC-20 the borrower wants to receive.
    /// @param collateralAsset  ERC-20 the borrower is posting.
    /// @return ceiling         Max lending wei the borrower may accept.
    function maxLendingForCollateral(
        uint256 collateralAmount,
        address principalAsset,
        address collateralAsset
    ) internal view returns (uint256 ceiling) {
        if (collateralAmount == 0) return 0;

        LibVaipakam.RiskParams storage rp =
            LibVaipakam.storageSlot().assetRiskParams[collateralAsset];
        uint256 liqThresholdBps = rp.liqThresholdBps;
        if (liqThresholdBps == 0) {
            return type(uint256).max;
        }

        (uint256 collateralUSD, uint256 pricePrincipal, uint256 principalScale) =
            _gatherUsd(collateralAmount, collateralAsset, principalAsset);
        if (collateralUSD == 0 || pricePrincipal == 0) {
            return type(uint256).max;
        }

        // Solve for principalUSD where HF == MIN_HEALTH_FACTOR:
        //   principalUSD
        //     == (collateralUSD × liqThresholdBps × HF_SCALE)
        //        / (BASIS_POINTS × MIN_HEALTH_FACTOR)
        uint256 principalUSD =
            (collateralUSD * liqThresholdBps * LibVaipakam.HF_SCALE)
            / (LibVaipakam.BASIS_POINTS * LibVaipakam.MIN_HEALTH_FACTOR);

        // Truncating division here is borrower-friendly: the returned
        // ceiling is the largest amount that can definitely satisfy
        // HF >= 1.5 — any larger amount might fail the runtime gate.
        ceiling = (principalUSD * principalScale) / pricePrincipal;
    }

    /// @dev Internal: returns (subjectUSD_raw, priceOther, scaleOther)
    ///      for the math above. `subjectUSD_raw` is `subjectAmount ×
    ///      subjectPrice / subjectScale`, where `subjectScale =
    ///      10**subjectFeedDecimals × 10**subjectTokenDecimals`. The
    ///      "raw" suffix is a reminder that this isn't a 1e18-scaled USD
    ///      figure — it shares the scaling convention of
    ///      `RiskFacet._computeUsdValues`.
    function _gatherUsd(
        uint256 subjectAmount,
        address subjectAsset,
        address otherAsset
    ) private view returns (
        uint256 subjectUSD,
        uint256 priceOther,
        uint256 scaleOther
    ) {
        OracleFacet oracle = OracleFacet(address(this));

        (uint256 priceSubject, uint8 feedDecSubject) =
            oracle.getAssetPrice(subjectAsset);
        if (priceSubject == 0) {
            return (0, 0, 0);
        }
        uint8 tokenDecSubject = IERC20Metadata(subjectAsset).decimals();
        subjectUSD = (subjectAmount * priceSubject)
            / (10 ** feedDecSubject)
            / (10 ** tokenDecSubject);

        (uint256 priceO, uint8 feedDecOther) = oracle.getAssetPrice(otherAsset);
        if (priceO == 0) {
            return (subjectUSD, 0, 0);
        }
        uint8 tokenDecOther = IERC20Metadata(otherAsset).decimals();
        priceOther = priceO;
        // scaleOther packs the inverse-conversion factor for the caller:
        // `otherAsset_native = otherUSD × scaleOther / priceOther`.
        scaleOther = (10 ** feedDecOther) * (10 ** tokenDecOther);
    }
}
