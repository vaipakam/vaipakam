// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IRateModel} from "../interfaces/IRateModel.sol";

/**
 * @title ILiquidityTierSource — the slice of the Vaipakam Diamond this model reads
 * @dev   Minimal interface so the model needs no facet concrete type. The
 *        Diamond's `OracleFacet.getEffectiveLiquidityTier(asset)` returns the
 *        collateral's effective liquidity tier (0 = illiquid/untierable …
 *        3 = deepest), fail-closed to `0` — the same signal the depth-tiered
 *        LTV gate consumes, so the premium is anchored to the protocol's own
 *        risk classification rather than an independent curve.
 */
interface ILiquidityTierSource {
    function getEffectiveLiquidityTier(address asset) external view returns (uint8 tier);
}

/**
 * @title  RiskPremiumRateModel — #394 Lever B: dual-factor risk premium on the RATE
 * @author Vaipakam Developer Team
 *
 * @notice A concrete, deployable {IRateModel} (the #400 substrate) that quotes
 *         `reference + collateral-risk premium + tenor premium`. It is the
 *         "risk content" half of #394 — #400 shipped the E2-safe *mechanism*
 *         (a pluggable quote-time model, deviation-clamped at the resolver);
 *         this contract supplies *what* the premium should be.
 *
 *         **Dual-factor** — the premium is the sum of two independent risk
 *         dimensions, each governance-tunable within hard bounds:
 *           1. **Collateral risk** — keyed on the collateral asset's effective
 *              liquidity tier (read live from the Diamond). Thinner liquidity ⇒
 *              higher premium. Tier 0 (illiquid / unreadable) gets the most
 *              conservative (highest) premium, so an unknown or oracle-stale
 *              collateral fails *expensive*, never cheap.
 *           2. **Tenor** — a per-year premium applied pro-rata to the loan's
 *              `durationDays`, capped. Longer credit ⇒ higher premium.
 *
 * @dev    **E2 / market-discovery safety is inherited, not re-implemented here.**
 *         This model only ever ADDS to the caller-supplied `referenceRateBps`
 *         (the live cleared-market rate the automated caller anchors to, per
 *         {IRateModel}). The #400 resolver (`OfferCreateFacet.quoteOfferRateBps`)
 *         then CLAMPS the result to the governance deviation band `[ref-δ, ref+δ]`
 *         and the `MAX_INTEREST_BPS` ceiling. Consequences worth stating:
 *           • the deviation cap (δ, default 5%) is the REAL binding limit on how
 *             much premium can take effect — a 20%-tier premium is clamped to
 *             `ref + δ`. Governance widens δ (≤ 25%) to let larger premiums bite.
 *           • a misconfigured or adversarial premium can therefore never push an
 *             automated offer off-market — it fails CLOSED at the substrate.
 *         Because premiums are additive (quote ≥ ref), the lower clamp never
 *         binds; only the upper (`ref + δ`) does.
 *
 *         **Holds no funds (E1).** Pure `view` quote. Non-upgradeable on
 *         purpose: a model is *swapped* by deploying a new one and
 *         re-registering it via `AdminFacet.setRateModel`, never mutated in
 *         place — immutable code is the simplest audit surface, and #400's
 *         `disableRateModel()` fast-path can revert to identity instantly in an
 *         incident regardless of which model is live.
 *
 *         **Manual offers are untouched.** Like every {IRateModel}, this is
 *         consulted only on the AUTOMATED / delegated path (#393 auto-lend /
 *         keeper-AMM); a human who types a rate still posts at exactly that
 *         rate. Market price-discovery — Vaipakam's differentiator — is preserved.
 */
contract RiskPremiumRateModel is IRateModel, Ownable2Step {
    // ── Hard bounds (defense-in-depth; the resolver deviation-clamp is the
    //    outer guard, these keep the model itself from being set absurdly) ──

    /// @dev Highest collateral-tier premium any tier may be set to (20%).
    uint16 internal constant MAX_TIER_PREMIUM_BPS = 2_000;
    /// @dev Highest per-year tenor premium (10%/yr).
    uint16 internal constant MAX_TENOR_PREMIUM_PER_YEAR_BPS = 1_000;
    /// @dev Hard ceiling for the tenor-premium cap setter (20%).
    uint16 internal constant MAX_TENOR_PREMIUM_CAP_BPS = 2_000;
    /// @dev Tiers are 0..3 (see {ILiquidityTierSource}).
    uint8 internal constant MAX_TIER = 3;
    uint256 internal constant DAYS_PER_YEAR = 365;

    // ── Immutable wiring ──

    /// @notice The Vaipakam Diamond the tier read is routed to.
    ILiquidityTierSource public immutable DIAMOND;

    // ── Governance-tunable premium config ──

    /// @notice Per-tier collateral-risk premium in BPS, indexed by tier 0..3.
    ///         Convention: index 0 (illiquid/unreadable) is the highest, index
    ///         3 (deepest liquidity) the lowest — but the setter does NOT
    ///         enforce monotonicity, leaving governance free to model any
    ///         curve. Each entry is bounded `≤ MAX_TIER_PREMIUM_BPS`.
    uint16[4] public tierPremiumBps;

    /// @notice Per-year tenor premium in BPS, applied pro-rata to durationDays.
    uint16 public tenorPremiumPerYearBps;

    /// @notice Cap on the pro-rata tenor premium, so a very long tenor can't
    ///         dominate the quote even before the resolver clamp.
    uint16 public maxTenorPremiumBps;

    // ── Events ──

    event TierPremiumSet(uint8 indexed tier, uint16 premiumBps);
    event TenorPremiumSet(uint16 perYearBps, uint16 capBps);

    // ── Errors ──

    error ZeroDiamond();
    error TierOutOfRange(uint8 tier);
    error PremiumOutOfRange(uint16 value, uint16 max);

    /**
     * @param initialOwner   The model owner (the admin multisig → governance
     *                        timelock); the only address that can retune premiums.
     * @param diamond_       The Vaipakam Diamond (tier-read target). Immutable.
     * @param tierPremiums_  Initial per-tier premiums (index 0..3), each
     *                        `≤ MAX_TIER_PREMIUM_BPS`.
     * @param perYearBps_    Initial tenor premium per year, `≤ MAX_TENOR_PREMIUM_PER_YEAR_BPS`.
     * @param tenorCapBps_   Initial tenor-premium cap, `≤ MAX_TENOR_PREMIUM_CAP_BPS`.
     */
    constructor(
        address initialOwner,
        address diamond_,
        uint16[4] memory tierPremiums_,
        uint16 perYearBps_,
        uint16 tenorCapBps_
    ) Ownable(initialOwner) {
        if (diamond_ == address(0)) revert ZeroDiamond();
        DIAMOND = ILiquidityTierSource(diamond_);
        for (uint8 t = 0; t <= MAX_TIER; ++t) {
            _assertPremiumInRange(tierPremiums_[t], MAX_TIER_PREMIUM_BPS);
            tierPremiumBps[t] = tierPremiums_[t];
            emit TierPremiumSet(t, tierPremiums_[t]);
        }
        _setTenorPremium(perYearBps_, tenorCapBps_);
    }

    // ── IRateModel ──

    /// @inheritdoc IRateModel
    /// @dev Pure additive quote: `reference + tierPremium + tenorPremium`. The
    ///      tier read is defensive — a revert/stale Diamond resolves to tier 0
    ///      (the most conservative, highest premium), so the model fails
    ///      expensive, never cheap. The #400 resolver re-clamps to the
    ///      deviation band + `MAX_INTEREST_BPS`, so no ceiling check is needed here.
    function quoteRateBps(
        RateModelInput calldata input
    ) external view returns (uint256 rateBps) {
        uint8 tier = _readTier(input.collateralAsset);
        uint256 tierP = uint256(tierPremiumBps[tier]);

        // Pro-rata tenor premium, capped. `durationDays * perYearBps` is tiny
        // (days ≪ 2^32, bps ≤ 1000), so no overflow concern under uint256.
        uint256 tenorP =
            (input.durationDays * uint256(tenorPremiumPerYearBps)) / DAYS_PER_YEAR;
        uint256 cap = uint256(maxTenorPremiumBps);
        if (tenorP > cap) tenorP = cap;

        return input.referenceRateBps + tierP + tenorP;
    }

    // ── Governance setters (owner-only, hard-bounded) ──

    /**
     * @notice Retune the collateral-risk premium for one liquidity tier.
     * @param tier       Tier index 0..3.
     * @param premiumBps New premium, `≤ MAX_TIER_PREMIUM_BPS`.
     */
    function setTierPremiumBps(uint8 tier, uint16 premiumBps) external onlyOwner {
        if (tier > MAX_TIER) revert TierOutOfRange(tier);
        _assertPremiumInRange(premiumBps, MAX_TIER_PREMIUM_BPS);
        tierPremiumBps[tier] = premiumBps;
        emit TierPremiumSet(tier, premiumBps);
    }

    /**
     * @notice Retune the tenor premium (per-year rate + absolute cap).
     * @param perYearBps New per-year premium, `≤ MAX_TENOR_PREMIUM_PER_YEAR_BPS`.
     * @param capBps     New absolute cap, `≤ MAX_TENOR_PREMIUM_CAP_BPS`.
     */
    function setTenorPremium(uint16 perYearBps, uint16 capBps) external onlyOwner {
        _setTenorPremium(perYearBps, capBps);
    }

    // ── Views ──

    /// @notice The current per-tier premium table (index 0..3).
    function getTierPremiums() external view returns (uint16[4] memory) {
        return tierPremiumBps;
    }

    // ── Internal ──

    function _setTenorPremium(uint16 perYearBps, uint16 capBps) private {
        _assertPremiumInRange(perYearBps, MAX_TENOR_PREMIUM_PER_YEAR_BPS);
        _assertPremiumInRange(capBps, MAX_TENOR_PREMIUM_CAP_BPS);
        tenorPremiumPerYearBps = perYearBps;
        maxTenorPremiumBps = capBps;
        emit TenorPremiumSet(perYearBps, capBps);
    }

    function _assertPremiumInRange(uint16 value, uint16 max) private pure {
        if (value > max) revert PremiumOutOfRange(value, max);
    }

    /// @dev Defensive tier read: any failure (revert, OOG-bubbling aside,
    ///      missing selector, or an out-of-range tier byte) resolves to tier 0
    ///      — the most conservative premium. `getEffectiveLiquidityTier` is
    ///      itself fail-closed to 0, so this is belt-and-braces.
    function _readTier(address collateralAsset) private view returns (uint8) {
        try DIAMOND.getEffectiveLiquidityTier(collateralAsset) returns (uint8 t) {
            return t > MAX_TIER ? 0 : t;
        } catch {
            return 0;
        }
    }
}
