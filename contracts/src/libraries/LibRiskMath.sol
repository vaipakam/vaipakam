// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LibVaipakam} from "./LibVaipakam.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";
import {NumeraireValueFacet} from "../facets/NumeraireValueFacet.sol";

/**
 * @title LibRiskMath
 * @notice Pure math helpers for the system-derived collateral floor /
 *         lending ceiling validated at `OfferFacet.createOffer` time
 *         under Range Orders Phase 1 (docs/RangeOffersDesign.md §3).
 *
 *         The HF helpers solve `HF = (collateralValue × liqThresholdBps /
 *         BASIS_POINTS) × HF_SCALE / debtValue` for the unknown side at
 *         the create-time admission floor; the LTV-cap helpers solve
 *         `LTV = debtValue × BASIS_POINTS / collateralValue` at the cap.
 *         Every value is a 1e18-scaled numeraire figure from
 *         `NumeraireValueFacet` — the rule `RiskFacet._computeNumeraireValues`
 *         applies at runtime (#2419) — and every bound is rounded so that
 *         the runtime gate, with ITS rounding (debt up, collateral down, each
 *         ratio's divisions down), accepts the bound itself. The HF bounds
 *         are exact: a floor is the smallest collateral the gate admits, a
 *         ceiling the largest debt. The LTV-cap bounds hold the unrounded
 *         ratio to the cap (`debtValue × BASIS_POINTS ≤ capBps ×
 *         collateralValue`), so they can be stricter than the gate's floored
 *         LTV read by under one basis point, never looser: the lender keeps
 *         that margin.
 *
 *         No storage beyond the tier / cap knobs. Each call is two
 *         valuation reads through the Diamond (each a price read and a
 *         `decimals()` read). A missing, stale, distrusted or zero price
 *         reverts, as it does in `OracleFacet.getAssetPrice`; it is never
 *         read as "no bound".
 *
 *         Returns the no-bound sentinel (0 for a floor, `type(uint256).max`
 *         for a ceiling) for a genuinely ILLIQUID collateral (tier 0 that
 *         does not classify Liquid) — "no HF gate at create-time, fall
 *         through to whatever the runtime gate decides at match." Same
 *         shape as `RiskFacet.calculateHealthFactor`, which doesn't enforce
 *         HF on illiquid pairs.
 */
library LibRiskMath {
    /// @notice Smallest collateral amount (in collateral-asset native
    ///         units, NOT USD) that satisfies HF >= 1.5 against the
    ///         given lending amount. Lender-side gate at offer create.
    /// @dev    Returns 0 when the collateral is genuinely illiquid —
    ///         caller treats 0 as "no bound enforced" (fall through to the
    ///         runtime gate at match time). Reverts when either leg has no
    ///         usable price (#2419).
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
        // look up the per-tier liquidation LTV.
        //
        // #1007 (S11) — tier 0 is no longer synonymous with illiquid, and the
        // two tier-0 cases need OPPOSITE treatment:
        //   • LIQUID + tier 0 (thin-but-liquid: clears the $5k floor, not the
        //     $50k probe) — must get a real HF bound, priced at the conservative
        //     tier-0 liquidation threshold (`cfgTierLiquidationLtvBps(0)` = the
        //     Tier-1 value post-#999).
        //   • ILLIQUID + tier 0 (no pool / fails the liquidity floor, possibly
        //     with a live price feed) — must keep the no-bound sentinel: not
        //     every caller gates on liquidity (`_previewMatchCore` calls this in
        //     the non-tiered match path, LibOfferMatch.sol:672), and `LoanFacet`
        //     INTENTIONALLY lets mutually-consented illiquid matches skip the
        //     HF/LTV gate (LoanFacet non-both-liquid + mutual-consent branch).
        //     Enforcing an HF floor here would block a match loan-init allows
        //     (Codex #1053 r2).
        // So distinguish the two via an explicit liquidity check on the tier-0
        // path (getEffectiveLiquidityTier collapses both to 0). The runtime
        // loan-init HF/LTV gate remains the authoritative enforcement.
        uint8 tier = OracleFacet(address(this)).getEffectiveLiquidityTier(collateralAsset);
        // `checkLiquidity` reverts on address(0), so short-circuit it — a zero
        // collateral asset is trivially not liquid and takes the sentinel path.
        if (
            tier == 0 &&
            (collateralAsset == address(0) ||
                OracleFacet(address(this)).checkLiquidity(collateralAsset)
                    != LibVaipakam.LiquidityStatus.Liquid)
        ) {
            return 0; // genuinely illiquid — no on-chain floor (mutual-consent path stays exempt)
        }
        uint256 liqThresholdBps = LibVaipakam.cfgTierLiquidationLtvBps(tier);

        // Debt leg rounded UP, as the runtime gate values it (#2419).
        uint256 principalValue = _value(principalAsset, amountMax, true);

        // Solve for the collateral value where HF == the create-time
        // admission floor.
        // BRANCH-AWARE (#394 Lever A, Codex #647 P2): in the depth-tiered
        // regime the admission floor is the fixed `HF_LIQUIDATION_THRESHOLD`
        // (1e18) — the LTV tier cap is the binding constraint there — so the
        // tunable `minHealthFactor()` must NOT leak into tiered offer-creation
        // (raising it to 1.8 would wrongly tighten tiered range offers the
        // tiered admission path would accept). Only the non-tiered floor is
        // the tunable knob.
        //
        // The runtime gate computes HF = ⌊⌊C·liq/BPS⌋·HF_SCALE / D⌋, so
        // HF ≥ hfFloor ⟺ ⌊C·liq/BPS⌋ ≥ R with R = ⌈D·hfFloor / HF_SCALE⌉
        // ⟸ C ≥ ⌈R·BPS / liq⌉. Both ceilings are exact: the smallest C the
        // gate admits.
        uint256 hfFloor = LibVaipakam.cfgDepthTieredLtvEnabled()
            ? LibVaipakam.HF_LIQUIDATION_THRESHOLD
            : LibVaipakam.minHealthFactor();
        uint256 riskAdjustedNeeded =
            Math.mulDiv(principalValue, hfFloor, LibVaipakam.HF_SCALE, Math.Rounding.Ceil);
        uint256 collateralValue = Math.mulDiv(
            riskAdjustedNeeded,
            LibVaipakam.BASIS_POINTS,
            liqThresholdBps,
            Math.Rounding.Ceil
        );

        // Back to collateral-asset native units, rounded UP: the smallest
        // amount whose value (rounded down, as the gate values collateral)
        // reaches `collateralValue`.
        floor = _amount(collateralAsset, collateralValue, true);

        // #394 Lever A (Codex #647 round-3 P2) — the HF-derived floor can fall
        // BELOW the per-asset init-LTV cap once the (non-tiered) admission floor
        // is lowered (e.g. cap 50%, liq-LTV 80%, floor 1.2). A range offer sized
        // to the HF floor would then exceed the LTV cap and revert later at
        // `_checkInitialLtvAndHf` with `LTVExceeded`. Clamp the create-time floor
        // UP to the init-LTV-cap floor so it never under-sizes vs the binding
        // admission gate. (`capBps == 0` ⇒ no per-asset cap configured ⇒ skip.)
        // #394 Lever A (Codex #647 round-3 + round-4) — the binding init-LTV cap
        // is `min(per-asset cap, tier cap)` in the depth-tiered regime (the same
        // `min` `_checkInitialLtvAndHf` applies), else the per-asset cap. Using
        // only the per-asset cap would still under-size a tiered range offer
        // that the tier gate later rejects with `InitLtvAboveTier`. In the
        // depth-tiered regime a tier-0 (thin-but-liquid, #1007) asset resolves
        // `effectiveTierMaxInitLtvBps(0) == 0`, so `capBps` collapses to 0 and
        // the clamp is skipped — the floor stays at the HF-derived value, which
        // is still finite and positive (tighter than the old `return 0`); the
        // runtime init-LTV gate blocks the tier-0 borrow itself.
        uint256 capBps = LibVaipakam
            .storageSlot()
            .assetRiskParams[collateralAsset]
            .loanInitMaxLtvBps;
        if (LibVaipakam.cfgDepthTieredLtvEnabled()) {
            uint256 tierCap = uint256(LibVaipakam.effectiveTierMaxInitLtvBps(tier));
            if (tierCap < capBps) capBps = tierCap;
        }
        if (capBps != 0) {
            uint256 ltvFloor = _amount(
                collateralAsset,
                _collateralValueForLtvCap(principalValue, capBps),
                true
            );
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
    /// @dev    `LTV = ⌊debtValue × BASIS_POINTS / collateralValue⌋` (the loan-level
    ///         `RiskFacet.calculateLTV(loanId)` formula, which values each
    ///         leg via `RiskFacet._computeNumeraireValues` at 1e18
    ///         precision, debt up and collateral down), so `LTV ≤ capBps`
    ///         ⟸ `collateralValue ≥ ⌈debtValue × BASIS_POINTS / capBps⌉` (a
    ///         sufficient condition, up to one basis point stricter than
    ///         the gate, see the library header). Doesn't
    ///         involve `liqThresholdBps` (the LTV cap is on the *borrow*
    ///         ratio, not the liquidation trigger; and since the invariant
    ///         `capBps ≤ loanInitMaxLtvBps ≤ liqThresholdBps` holds, this floor
    ///         dominates the `HF ≥ 1e18` floor `_checkInitialLtvAndHf`
    ///         also keeps). The pair-level `OracleFacet.calculateLTV`
    ///         preview prices in the same units but floors only the final
    ///         ratio, so it is NOT a substitute for this binding rounding;
    ///         the two differ by at most one 1e-18 unit per leg (#2419).
    ///         Returns `type(uint256).max` when `capBps == 0`
    ///         (a Tier-0 / no-borrow collateral — no positive amount
    ///         satisfies it, caller must reject). Reverts when either leg
    ///         has no usable price. Same 1e18 values + round-up-to-satisfy
    ///         convention as {minCollateralForLending}.
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

        uint256 principalValue = _value(principalAsset, amountMax, true);
        floor = _amount(
            collateralAsset,
            _collateralValueForLtvCap(principalValue, capBps),
            true // round up — satisfy `>=` strictly
        );
    }

    /// @notice Largest lending amount (principal-asset wei) the borrower
    ///         can accept on the offer such that HF >= 1.5 with the
    ///         already-posted collateral. Borrower-side gate at offer
    ///         create.
    /// @dev    Returns `type(uint256).max` (no ceiling) when the
    ///         collateral is genuinely illiquid — fall through to the
    ///         runtime gate. Reverts when either leg has no usable price
    ///         (#2419).
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
        // #1007 (S11) — distinguish LIQUID tier-0 (thin-but-liquid: price at the
        // conservative tier-0 threshold + clamp) from ILLIQUID tier-0 (keep the
        // no-ceiling sentinel so the mutually-consented illiquid match path,
        // which loan-init exempts from HF/LTV, is not blocked here — Codex #1053
        // r2). See the sibling helper's note for the full rationale.
        uint8 tier = OracleFacet(address(this)).getEffectiveLiquidityTier(collateralAsset);
        // `checkLiquidity` reverts on address(0); short-circuit to the sentinel.
        if (
            tier == 0 &&
            (collateralAsset == address(0) ||
                OracleFacet(address(this)).checkLiquidity(collateralAsset)
                    != LibVaipakam.LiquidityStatus.Liquid)
        ) {
            return type(uint256).max; // genuinely illiquid — no on-chain ceiling
        }
        uint256 liqThresholdBps = LibVaipakam.cfgTierLiquidationLtvBps(tier);

        // Collateral leg rounded DOWN, as the runtime gate values it. A
        // collateral worth nothing at 1e18 precision supports no debt.
        uint256 collateralValue = _value(collateralAsset, collateralAmount, false);

        // Solve for the debt value where HF == the create-time admission
        // floor.
        // BRANCH-AWARE (#394 Lever A, Codex #647 P2): tiered regime uses the
        // fixed `HF_LIQUIDATION_THRESHOLD` (1e18); only the non-tiered floor is
        // the tunable `minHealthFactor()` knob — so the knob never leaks into
        // tiered offer-creation bounds.
        //
        // The runtime gate computes HF = ⌊A·HF_SCALE / D⌋ with
        // A = ⌊C·liq/BPS⌋, so HF ≥ hfFloor ⟸ D ≤ ⌊A·HF_SCALE / hfFloor⌋:
        // the largest debt value the gate admits, computed in the gate's
        // own two steps.
        uint256 hfFloor = LibVaipakam.cfgDepthTieredLtvEnabled()
            ? LibVaipakam.HF_LIQUIDATION_THRESHOLD
            : LibVaipakam.minHealthFactor();
        uint256 riskAdjusted =
            Math.mulDiv(collateralValue, liqThresholdBps, LibVaipakam.BASIS_POINTS);
        uint256 principalValue =
            Math.mulDiv(riskAdjusted, LibVaipakam.HF_SCALE, hfFloor);

        // Back to principal-asset native units, rounded DOWN: the largest
        // amount whose value (rounded up, as the gate values debt) stays
        // within `principalValue` — any larger amount might fail the
        // runtime gate. Borrower-friendly in the safe sense.
        ceiling = _amount(principalAsset, principalValue, false);

        // #394 Lever A (Codex #647 round-3 P2) — symmetric to the
        // `minCollateralForLending` clamp: a lowered (non-tiered) admission
        // floor raises this HF-derived ceiling above what the per-asset
        // init-LTV cap permits, so the borrower could accept a lending amount
        // the admission gate then rejects with `LTVExceeded`. Clamp the ceiling
        // DOWN to the init-LTV-cap ceiling (`LTV = debt/coll ≤ cap ⟸
        // debtValue ≤ ⌊collateralValue × cap / BASIS_POINTS⌋`, at most one
        // basis point stricter than the gate, see the library header).
        // #394 Lever A (Codex #647 round-3 + round-4) — `min(per-asset cap,
        // tier cap)` in the depth-tiered regime (mirrors `_checkInitialLtvAndHf`).
        // #1007 — for a tier-0 (thin-but-liquid) asset in the depth-tiered
        // regime `effectiveTierMaxInitLtvBps(0) == 0` collapses `capBps` to 0 and
        // the LTV clamp is skipped, leaving the finite HF-derived ceiling (still
        // far tighter than the old `return type(uint256).max`); the runtime gate
        // blocks the tier-0 borrow itself.
        uint256 capBps = LibVaipakam
            .storageSlot()
            .assetRiskParams[collateralAsset]
            .loanInitMaxLtvBps;
        if (LibVaipakam.cfgDepthTieredLtvEnabled()) {
            uint256 tierCap = uint256(LibVaipakam.effectiveTierMaxInitLtvBps(tier));
            if (tierCap < capBps) capBps = tierCap;
        }
        if (capBps != 0) {
            uint256 ltvCeiling = _amount(
                principalAsset,
                Math.mulDiv(collateralValue, capBps, LibVaipakam.BASIS_POINTS),
                false
            );
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
    ///         - otherwise: the largest principal amount whose value
    ///           (rounded up) is at most `⌊collateralValue × capBps /
    ///           BASIS_POINTS⌋`, with the collateral valued rounded down —
    ///           the largest amount that can definitely satisfy
    ///           `LTV ≤ capBps`; any larger amount might fail the
    ///           runtime gate.
    ///         Reverts when either leg has no usable price (#2419).
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

        uint256 collateralValue = _value(collateralAsset, collateralAmount, false);

        // Solve for the debt value at LTV == capBps:
        //   debtValue ≤ ⌊collateralValue × capBps / BASIS_POINTS⌋
        //   ⟹ ⌊debtValue × BASIS_POINTS / collateralValue⌋ ≤ capBps.
        uint256 principalValue =
            Math.mulDiv(collateralValue, capBps, LibVaipakam.BASIS_POINTS);

        // Back to principal-asset wei, rounded down per the docstring.
        ceiling = _amount(principalAsset, principalValue, false);
    }

    /// @dev The smallest collateral value at which the UNROUNDED LTV,
    ///      debtValue × BASIS_POINTS / collateralValue, is at most `capBps`:
    ///      ⌈debtValue × BASIS_POINTS / capBps⌉. The runtime gate floors that
    ///      ratio, so it also admits this value, and can admit a slightly
    ///      smaller one (under one basis point of LTV); the bound keeps that
    ///      margin for the lender. `capBps` nonzero.
    function _collateralValueForLtvCap(uint256 debtValue, uint256 capBps)
        private
        pure
        returns (uint256)
    {
        return Math.mulDiv(debtValue, LibVaipakam.BASIS_POINTS, capBps, Math.Rounding.Ceil);
    }

    /// @dev 1e18-scaled numeraire value of `amount` of `asset`, through the
    ///      shared rule (`NumeraireValueFacet`, #2419).
    function _value(address asset, uint256 amount, bool roundUp)
        private
        view
        returns (uint256)
    {
        return NumeraireValueFacet(address(this)).getNumeraireValue(asset, amount, roundUp);
    }

    /// @dev Amount of `asset` worth `value` (1e18 numeraire) — the inverse
    ///      of {_value}; see `NumeraireValueFacet.getAmountForNumeraireValue`
    ///      for what each rounding guarantees.
    function _amount(address asset, uint256 value, bool roundUp)
        private
        view
        returns (uint256)
    {
        return NumeraireValueFacet(address(this)).getAmountForNumeraireValue(asset, value, roundUp);
    }
}
