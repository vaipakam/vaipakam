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
 *         Both helpers solve `HF = (collateralUsd × liqThresholdBps /
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

        // PR2 of internal-match work (2026-05-14): per-asset
        // `liqThresholdBps` was retired in favour of per-tier values.
        // Resolve the collateral asset's effective tier via the
        // cross-facet helper (same pattern as `LibOfferMatch`), then
        // look up the per-tier liquidation LTV. Tier 0 (illiquid)
        // returns the conservative Tier-3 default — but callers should
        // reject illiquid before reaching here, so this is fail-safe.
        uint8 tier = OracleFacet(address(this)).getEffectiveLiquidityTier(collateralAsset);
        if (tier == 0) {
            // Illiquid asset — no on-chain bound enforceable; fall through
            // to the runtime gate (which will revert the loan anyway).
            return 0;
        }
        uint256 liqThresholdBps = LibVaipakam.cfgTierLiquidationLtvBps(tier);

        (uint256 principalUsd, uint256 priceCollateral, uint256 collateralScale) =
            _gatherUsd(amountMax, principalAsset, collateralAsset);
        if (principalUsd == 0 || priceCollateral == 0) return 0;

        // Solve for collateralUsd where HF == the create-time admission floor.
        // BRANCH-AWARE (#394 Lever A, Codex #647 P2): in the depth-tiered
        // regime the admission floor is the fixed `HF_LIQUIDATION_THRESHOLD`
        // (1e18) — the LTV tier cap is the binding constraint there — so the
        // tunable `minHealthFactor()` must NOT leak into tiered offer-creation
        // (raising it to 1.8 would wrongly tighten tiered range offers the
        // tiered admission path would accept). Only the non-tiered floor is
        // the tunable knob.
        //   collateralUsd × liqThresholdBps / BASIS_POINTS
        //     == principalUsd × hfFloor / HF_SCALE
        //   collateralUsd
        //     == (principalUsd × hfFloor × BASIS_POINTS)
        //        / (HF_SCALE × liqThresholdBps)
        // BPS multiplications fit comfortably under uint256 since
        // principalUsd here is the (price-scaled but token-unscaled) raw
        // numerator of the USD figure RiskFacet uses; see _gatherUsd
        // below — it intentionally returns the un-divided-by-1e18 form
        // so the rest of the math stays in integers.
        uint256 hfFloor = LibVaipakam.cfgDepthTieredLtvEnabled()
            ? LibVaipakam.HF_LIQUIDATION_THRESHOLD
            : LibVaipakam.minHealthFactor();
        uint256 collateralUsd =
            (principalUsd * hfFloor * LibVaipakam.BASIS_POINTS)
            / (LibVaipakam.HF_SCALE * liqThresholdBps);

        // Convert collateralUsd back to collateral-asset native units.
        // `collateralScale` already encodes the (10^feedDec × 10^tokenDec)
        // factor, so `collateral_native = collateralUsd × collateralScale
        // / collateralPrice` recovers the right number.
        floor = (collateralUsd * collateralScale) / priceCollateral;
        // Round up by 1 wei when there's any remainder so the caller
        // satisfies the >= relation strictly under integer truncation.
        if ((collateralUsd * collateralScale) % priceCollateral != 0) {
            floor += 1;
        }

        // #394 Lever A (Codex #647 round-3 P2) — the HF-derived floor can fall
        // BELOW the per-asset init-LTV cap once the (non-tiered) admission floor
        // is lowered (e.g. cap 50%, liq-LTV 80%, floor 1.2). A range offer sized
        // to the HF floor would then exceed the LTV cap and revert later at
        // `_checkInitialLtvAndHf` with `LTVExceeded`. Clamp the create-time floor
        // UP to the init-LTV-cap floor so it never under-sizes vs the binding
        // admission gate. (`capBps == 0` ⇒ no per-asset cap configured ⇒ skip.)
        uint256 capBps = LibVaipakam
            .storageSlot()
            .assetRiskParams[collateralAsset]
            .loanInitMaxLtvBps;
        if (capBps != 0) {
            uint256 ltvNum = principalUsd * LibVaipakam.BASIS_POINTS;
            uint256 ltvCollateralUsd = ltvNum / capBps;
            if (ltvNum % capBps != 0) ltvCollateralUsd += 1;
            uint256 ltvNum2 = ltvCollateralUsd * collateralScale;
            uint256 ltvFloor = ltvNum2 / priceCollateral;
            if (ltvNum2 % priceCollateral != 0) ltvFloor += 1;
            if (ltvFloor > floor) floor = ltvFloor;
        }
    }

    /// @notice Smallest collateral amount (collateral-asset native units)
    ///         that keeps init-LTV at or below `capBps` against the given
    ///         lending amount — the depth-tiered-LTV analog of
    ///         {minCollateralForLending}, used by `LibOfferMatch.previewMatch`
    ///         when `depthTieredLtvEnabled` so a bot's preview matches the
    ///         binding `LoanFacet._checkInitialLtvAndHf` gate. `capBps` is
    ///         the effective cap = `min(assetRiskParams.loanInitMaxLtvBps,
    ///         cfgTierMaxInitLtvBps(effectiveTier(collateral)))`.
    /// @dev    `LTV = debtUSD × BASIS_POINTS / collateralUsd` (mirrors
    ///         `OracleFacet.calculateLTV`), so `LTV ≤ capBps` ⟺
    ///         `collateralUsd ≥ debtUSD × BASIS_POINTS / capBps`. Doesn't
    ///         involve `liqThresholdBps` (the LTV cap is on the *borrow*
    ///         ratio, not the liquidation trigger; and since the invariant
    ///         `capBps ≤ loanInitMaxLtvBps ≤ liqThresholdBps` holds, this floor
    ///         dominates the `HF ≥ 1e18` floor `_checkInitialLtvAndHf`
    ///         also keeps). Returns `type(uint256).max` when `capBps == 0`
    ///         (a Tier-0 / no-borrow collateral — no positive amount
    ///         satisfies it, caller must reject); returns `0` when oracle
    ///         price is missing on either leg (no create-time bound, fall
    ///         through to the runtime gate). Same un-divided-by-1e18 USD
    ///         convention + round-up-on-remainder as {minCollateralForLending}.
    /// @param amountMax        The lender's `amountMax` (worst-case lending size).
    /// @param principalAsset   ERC-20 the lender is offering.
    /// @param collateralAsset  ERC-20 the borrower will post.
    /// @param capBps           Effective init-LTV cap (basis points).
    /// @return floor           Minimum collateral wei to satisfy `LTV ≤ capBps`.
    function minCollateralForLtvCap(
        uint256 amountMax,
        address principalAsset,
        address collateralAsset,
        uint256 capBps
    ) internal view returns (uint256 floor) {
        if (amountMax == 0) return 0;
        if (capBps == 0) return type(uint256).max; // no-borrow collateral

        (uint256 principalUsd, uint256 priceCollateral, uint256 collateralScale) =
            _gatherUsd(amountMax, principalAsset, collateralAsset);
        if (principalUsd == 0 || priceCollateral == 0) return 0;

        uint256 num = principalUsd * LibVaipakam.BASIS_POINTS;
        uint256 collateralUsd = num / capBps;
        if (num % capBps != 0) collateralUsd += 1; // round up

        uint256 collNum = collateralUsd * collateralScale;
        floor = collNum / priceCollateral;
        if (collNum % priceCollateral != 0) floor += 1; // round up — satisfy `>=` strictly
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

        // PR2 of internal-match work: read per-tier liquidation LTV
        // (same pattern as `minCollateralForLending` above).
        uint8 tier = OracleFacet(address(this)).getEffectiveLiquidityTier(collateralAsset);
        if (tier == 0) {
            return type(uint256).max;
        }
        uint256 liqThresholdBps = LibVaipakam.cfgTierLiquidationLtvBps(tier);

        (uint256 collateralUsd, uint256 pricePrincipal, uint256 principalScale) =
            _gatherUsd(collateralAmount, collateralAsset, principalAsset);
        if (collateralUsd == 0 || pricePrincipal == 0) {
            return type(uint256).max;
        }

        // Solve for principalUsd where HF == the create-time admission floor.
        // BRANCH-AWARE (#394 Lever A, Codex #647 P2): tiered regime uses the
        // fixed `HF_LIQUIDATION_THRESHOLD` (1e18); only the non-tiered floor is
        // the tunable `minHealthFactor()` knob — so the knob never leaks into
        // tiered offer-creation bounds.
        //   principalUsd
        //     == (collateralUsd × liqThresholdBps × HF_SCALE)
        //        / (BASIS_POINTS × hfFloor)
        uint256 hfFloor = LibVaipakam.cfgDepthTieredLtvEnabled()
            ? LibVaipakam.HF_LIQUIDATION_THRESHOLD
            : LibVaipakam.minHealthFactor();
        uint256 principalUsd =
            (collateralUsd * liqThresholdBps * LibVaipakam.HF_SCALE)
            / (LibVaipakam.BASIS_POINTS * hfFloor);

        // Truncating division here is borrower-friendly: the returned
        // ceiling is the largest amount that can definitely satisfy
        // HF >= 1.5 — any larger amount might fail the runtime gate.
        ceiling = (principalUsd * principalScale) / pricePrincipal;

        // #394 Lever A (Codex #647 round-3 P2) — symmetric to the
        // `minCollateralForLending` clamp: a lowered (non-tiered) admission
        // floor raises this HF-derived ceiling above what the per-asset
        // init-LTV cap permits, so the borrower could accept a lending amount
        // the admission gate then rejects with `LTVExceeded`. Clamp the ceiling
        // DOWN to the init-LTV-cap ceiling (`LTV = debt/coll ≤ cap ⟺
        // debtUSD ≤ collateralUsd × cap / BASIS_POINTS`).
        uint256 capBps = LibVaipakam
            .storageSlot()
            .assetRiskParams[collateralAsset]
            .loanInitMaxLtvBps;
        if (capBps != 0) {
            uint256 ltvPrincipalUsd =
                (collateralUsd * capBps) / LibVaipakam.BASIS_POINTS;
            uint256 ltvCeiling = (ltvPrincipalUsd * principalScale) / pricePrincipal;
            if (ltvCeiling < ceiling) ceiling = ltvCeiling;
        }
    }

    /// @notice Largest lending amount (principal-asset wei) the borrower
    ///         can accept on the offer such that the LTV at the posted
    ///         collateral stays AT OR BELOW the provided `capBps`. Sibling
    ///         of `minCollateralForLtvCap` (same caller, opposite direction
    ///         of the LTV constraint); ADR-0010 §3 added this helper so
    ///         the canonical-limit-order GTC default can derive the
    ///         borrower's effective `amountMax` at match-time using the
    ///         SAME init-LTV cap admission consults at
    ///         `LoanFacet._checkInitialLtvAndHf`.
    /// @dev    Distinct from `maxLendingForCollateral` (which uses tier
    ///         LIQUIDATION LTV — the post-creation safety threshold ~80% —
    ///         and solves for HF >= 1.5). This helper takes the INIT-LTV
    ///         cap explicitly (`min(asset loanInitMaxLtvBps,
    ///         effectiveTierMaxInitLtvBps(tier))` per ADR-0010 §3) so
    ///         callers can apply the cap that admission actually enforces
    ///         rather than the looser liquidation threshold. Reusing
    ///         `maxLendingForCollateral` for the GTC derivation would
    ///         advertise borrower capacity ABOVE what admission allows —
    ///         exactly the failure mode Codex round-1 on PR #171 caught.
    ///
    ///         Returns:
    ///         - `0` if `collateralAmount == 0`
    ///         - `0` if `capBps == 0` — collateral is tagged no-borrow
    ///           (the dual of `minCollateralForLtvCap` returning
    ///           `type(uint256).max` for the same condition)
    ///         - `0` if oracle price is missing on either leg — fall
    ///           through to the runtime gate. Borrower-friendly: an
    ///           offer derived with `amountMax = 0` because of a missing
    ///           feed simply won't match until the feed comes back,
    ///           rather than advertising a stale ceiling.
    ///         - otherwise: `floor((collateralUsd × capBps × principalScale)
    ///                            / (BASIS_POINTS × pricePrincipal))`.
    ///           Truncating is borrower-friendly: the returned ceiling
    ///           is the largest amount that can definitely satisfy
    ///           `LTV ≤ capBps`; any larger amount might fail the
    ///           runtime gate.
    /// @param collateralAmount The borrower's posted collateral, native units.
    /// @param principalAsset   ERC-20 the borrower wants to receive.
    /// @param collateralAsset  ERC-20 the borrower is posting.
    /// @param capBps           Effective init-LTV cap (basis points). Caller
    ///                         is expected to pass `min(asset
    ///                         loanInitMaxLtvBps,
    ///                         effectiveTierMaxInitLtvBps(tier))` to match
    ///                         `_checkInitialLtvAndHf`.
    /// @return ceiling         Max lending wei the borrower may accept at
    ///                         the given cap.
    function maxLendingForLtvCap(
        uint256 collateralAmount,
        address principalAsset,
        address collateralAsset,
        uint256 capBps
    ) internal view returns (uint256 ceiling) {
        if (collateralAmount == 0) return 0;
        // Symmetric with `minCollateralForLtvCap`'s `capBps == 0 ⇒
        // type(uint256).max` branch (no-borrow collateral). On the
        // max-lending side, no-borrow means the borrower can accept
        // at most 0 — i.e., no match is feasible. Returning 0 keeps
        // the downstream `previewMatch` overlap check (`hi >= lo`)
        // honest: `lo = max(L.amount, B.amount) > 0`, so an offer
        // against no-borrow collateral never matches via the GTC
        // derivation path.
        if (capBps == 0) return 0;

        (uint256 collateralUsd, uint256 pricePrincipal, uint256 principalScale) =
            _gatherUsd(collateralAmount, collateralAsset, principalAsset);
        if (collateralUsd == 0 || pricePrincipal == 0) return 0;

        // Solve for principalUsd at LTV == capBps:
        //   principalUsd == collateralUsd × capBps / BASIS_POINTS
        uint256 principalUsd =
            (collateralUsd * capBps) / LibVaipakam.BASIS_POINTS;

        // Convert back to principal-asset wei. Truncating division is
        // borrower-friendly per the docstring.
        ceiling = (principalUsd * principalScale) / pricePrincipal;
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
        uint256 subjectUsd,
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
        subjectUsd = (subjectAmount * priceSubject)
            / (10 ** feedDecSubject)
            / (10 ** tokenDecSubject);

        (uint256 priceO, uint8 feedDecOther) = oracle.getAssetPrice(otherAsset);
        if (priceO == 0) {
            return (subjectUsd, 0, 0);
        }
        uint8 tokenDecOther = IERC20Metadata(otherAsset).decimals();
        priceOther = priceO;
        // scaleOther packs the inverse-conversion factor for the caller:
        // `otherAsset_native = otherUSD × scaleOther / priceOther`.
        scaleOther = (10 ** feedDecOther) * (10 ** tokenDecOther);
    }
}
