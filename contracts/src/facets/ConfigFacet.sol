// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {LibStakingRewards} from "../libraries/LibStakingRewards.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title ConfigFacet
 * @author Vaipakam Developer Team
 * @notice Admin-configurable protocol parameters: fees, VPFI discount
 *         tier table, liquidation-path risk knobs, rental prepay buffer,
 *         and staking APR.
 * @dev Every setter is ADMIN_ROLE-gated (routed through the 48h
 *      Timelock post-handover) and writes into
 *      {LibVaipakam.Storage.protocolCfg}. A stored zero means "use the
 *      corresponding `LibVaipakam` constant default" — existing
 *      deployments therefore keep their original semantics until a
 *      setter is called. Getters resolve the effective value (override
 *      or default) so the frontend can surface the same numbers it
 *      renders in hints / tooltips.
 *
 *      Deliberately out of scope (not tunable): tokenomics supply caps
 *      (`VPFI_*_CAP`, `VPFI_INITIAL_MINT`), `MIN_HEALTH_FACTOR`, and
 *      the fallback 3%/2% settlement split. Those carry strong invariants
 *      in the settlement math and would require a coordinated migration
 *      to change safely.
 */
contract ConfigFacet is DiamondAccessControl {
    /// ─── Errors ─────────────────────────────────────────────────────
    error InvalidFeeBps(uint256 bps, uint256 maxAllowed);
    error InvalidSlippageBps(uint256 bps, uint256 maxAllowed);
    error InvalidIncentiveBps(uint256 bps, uint256 maxAllowed);
    error InvalidVolatilityLtvBps(uint256 bps);
    error InvalidRentalBufferBps(uint256 bps);
    error InvalidStakingAprBps(uint256 bps);
    error NonMonotoneTierThresholds(uint256 t1, uint256 t2, uint256 t3, uint256 t4);
    error NonMonotoneTierDiscounts(uint256 t1, uint256 t2, uint256 t3, uint256 t4);
    error DiscountBpsTooHigh(uint256 bps, uint256 maxAllowed);
    error FallbackSplitTooHigh(uint256 lenderBonusBps, uint256 treasuryBps, uint256 maxPerPartyBps);
    error FallbackSplitCombinedTooHigh(uint256 combinedBps, uint256 maxCombinedBps);
    // ── Depth-tiered LTV (Piece B) ──────────────────────────────────────
    error NonMonotoneTierSizes(uint256 floorPad, uint256 t1Pad, uint256 t2Pad, uint256 t3Pad);
    error TierSizeTooSmall(uint256 provided, uint256 minPad);
    error NonMonotoneTierLtvBps(uint256 t1, uint256 t2, uint256 t3);
    error TierLtvBpsTooHigh(uint256 provided, uint256 maxAllowed);
    error InvalidLiquidityTier(uint8 provided);
    error PaaListInvalid(string reason);

    /// ─── Events ─────────────────────────────────────────────────────
    /// @custom:event-category informational/config
    event FeesConfigSet(uint16 treasuryFeeBps, uint16 loanInitiationFeeBps);
    /// @custom:event-category informational/config
    event LiquidationConfigSet(
        uint16 handlingFeeBps,
        uint16 maxSlippageBps,
        uint16 maxIncentiveBps
    );
    /// @custom:event-category informational/config
    event RiskConfigSet(uint16 volatilityLtvThresholdBps, uint16 rentalBufferBps);
    /// @custom:event-category informational/config
    event StakingAprSet(uint16 aprBps);
    /// @custom:event-category informational/config
    event VpfiTierThresholdsSet(uint256 t1, uint256 t2, uint256 t3, uint256 t4);
    /// @custom:event-category informational/config
    event VpfiTierDiscountsSet(uint16 t1, uint16 t2, uint16 t3, uint16 t4);
    /// @custom:event-category informational/config
    event FallbackSplitSet(uint16 lenderBonusBps, uint16 treasuryBps);
    // ── Range Orders Phase 1 master-flag setter events ──────────────────
    /// @custom:event-category informational/config
    event RangeAmountEnabledSet(bool enabled);
    /// @custom:event-category informational/config
    event RangeRateEnabledSet(bool enabled);
    /// @custom:event-category informational/config
    event PartialFillEnabledSet(bool enabled);

    // ── T-044 — admin-configurable loan-default grace schedule ──────────
    /// @custom:event-category informational/config
    event GraceBucketsUpdated(uint256 bucketCount);

    /// @notice Reverts when {setGraceBuckets} is called with an invalid
    ///         shape (empty / over-cap / non-monotonic / missing
    ///         catch-all marker / out-of-range values).
    /// @param reason Human-readable hint about which validation failed.
    error GraceBucketsInvalid(string reason);

    // Upper bounds (sanity caps). Deliberately loose — production values
    // will sit far below these, but admin has headroom for emergency knobs.
    //
    // ─── Operator reference (read in CHANGELOG / runbook before tuning) ───
    //   MAX_FEE_BPS       = 5_000 (50%) — ceiling for treasuryFeeBps,
    //                        loanInitiationFeeBps, liquidationHandlingFeeBps,
    //                        and rentalBufferBps. Any value above this
    //                        reverts InvalidFeeBps / InvalidRentalBufferBps.
    //   MAX_SLIPPAGE_BPS  = 2_500 (25%) — ceiling for maxLiquidationSlippageBps
    //                        (default 600 = 6%). Raising this beyond its cap
    //                        would silently admit MEV-grade slippage on 0x
    //                        swaps; the cap is the hard stop.
    //   MAX_INCENTIVE_BPS = 2_000 (20%) — ceiling for maxLiquidatorIncentiveBps
    //                        (default 300 = 3%). Values above this would
    //                        over-reward keepers relative to the collateral
    //                        value; 20% is the absolute incident-response
    //                        maximum and even that should never be used
    //                        casually.
    //   MAX_DISCOUNT_BPS  = 9_000 (90%) — per-tier ceiling for the VPFI
    //                        discount BPS (T1..T4). Effective discounts
    //                        must stay monotone non-decreasing; see
    //                        {setVpfiTierDiscountBps}.
    // ──────────────────────────────────────────────────────────────────────
    uint16 private constant MAX_FEE_BPS = 5_000;            // 50%
    uint16 private constant MAX_SLIPPAGE_BPS = 2_500;       // 25%
    uint16 private constant MAX_INCENTIVE_BPS = 2_000;      // 20%
    uint16 private constant MAX_DISCOUNT_BPS = 9_000;       // 90%
    // Gap #4 from the 2026-05-14 bounds audit
    // (`docs/internal/ConfigKnobBoundsAudit-2026-05-14.md`):
    // tightened from the shared `MAX_FEE_BPS` (50%) ceiling to a
    // dedicated 20% ceiling for the NFT-rental prepay buffer.
    // Default is 500 bps (5%); 20% gives realistic upward governance
    // flex (4× the default) without permitting a 10× spike that
    // would economically punish renters.
    uint16 private constant MAX_RENTAL_BUFFER_BPS = 2_000;  // 20%
    // Fallback-split bounds: each party capped at 10% of principal, combined
    // (lender bonus + treasury) at 15%. These keep the borrower's remainder
    // meaningful even under the most adverse governance setting — a
    // theoretical abuse where a vote set both to 50% each would wipe out
    // the borrower's collateral recovery right, which is exactly the kind
    // of hostile-governance scenario the timelock + cap combo is for.
    uint16 private constant MAX_FALLBACK_BPS = 1_000;       // 10% per party
    uint16 private constant MAX_FALLBACK_COMBINED_BPS = 1_500; // 15% combined
    // Cap on the PAA list length — every entry adds a `getPool` probe ×
    // the ≤0.3% fee tiers to the depth-tier route search's hot path, so
    // keep it small (2–4 in practice). 8 is generous headroom.
    uint256 private constant MAX_PAA_ASSETS = 8;

    /// ─── Setters ────────────────────────────────────────────────────

    /**
     * @notice Update the two protocol fees in one atomic call.
     * @param treasuryFeeBps       Fee on lender interest (defaults to 100 ≡ 1%).
     * @param loanInitiationFeeBps Fee on ERC-20 principal at initiation (defaults to 10 ≡ 0.1%).
     * @dev ADMIN_ROLE-only. Pass `0` for either field to reset it to the
     *      library default. Both values are capped at {MAX_FEE_BPS}.
     */
    function setFeesConfig(uint16 treasuryFeeBps, uint16 loanInitiationFeeBps)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (treasuryFeeBps > MAX_FEE_BPS) revert InvalidFeeBps(treasuryFeeBps, MAX_FEE_BPS);
        if (loanInitiationFeeBps > MAX_FEE_BPS) revert InvalidFeeBps(loanInitiationFeeBps, MAX_FEE_BPS);
        LibVaipakam.ProtocolConfig storage c = LibVaipakam.storageSlot().protocolCfg;
        c.treasuryFeeBps = treasuryFeeBps;
        c.loanInitiationFeeBps = loanInitiationFeeBps;
        emit FeesConfigSet(treasuryFeeBps, loanInitiationFeeBps);
    }

    /// @notice Emitted when the matcher's slice of the LIF kickback is
    ///         rotated. Default 100 BPS (1%); the design allows up to
    ///         5–10% if community bot operators need a stronger
    ///         incentive.
    /// @custom:event-category informational/config
    event LifMatcherFeeBpsSet(uint16 newBps);

    /**
     * @notice Update the Range Orders matcher's BPS slice of any LIF
     *         that flows to treasury. Tunable so governance can dial
     *         the kickback up to attract more third-party matchers
     *         (or down to redirect more of the LIF to treasury).
     * @dev ADMIN_ROLE-only. Pass `0` to reset to the library default
     *      (`LIF_MATCHER_FEE_BPS = 100` ≡ 1%). Capped at
     *      {MAX_FEE_BPS} (50%) so a misfire can't starve treasury.
     *      The kickback applies on both the lender-asset path
     *      (synchronous, paid at match) and the VPFI path (deferred
     *      to terminal via `LibVPFIDiscount`).
     * @param newBps New matcher BPS, 0–MAX_FEE_BPS. Stored on
     *               `ProtocolConfig.lifMatcherFeeBps` and consumed
     *               by `LibVaipakam.cfgLifMatcherFeeBps()`.
     */
    function setLifMatcherFeeBps(uint16 newBps)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (newBps > MAX_FEE_BPS) revert InvalidFeeBps(newBps, MAX_FEE_BPS);
        LibVaipakam.storageSlot().protocolCfg.lifMatcherFeeBps = newBps;
        emit LifMatcherFeeBpsSet(newBps);
    }

    /// @notice Emitted on every change to the partial-liquidation close-factor cap.
    /// @custom:event-category informational/config
    event MaxPartialLiquidationCloseFactorBpsSet(uint16 newBps);

    /// @notice Partial-liquidation close-factor cap was set above 100%.
    /// @dev A fraction > 10_000 BPS has no semantic meaning — partial
    ///      liquidation can never swap more than the loan's remaining
    ///      collateral. Hard-rejected at the setter so the storage value
    ///      can be trusted unconditionally at
    ///      `RiskFacet.triggerPartialLiquidation`.
    error InvalidPartialLiqCloseFactorBps(uint256 bps);

    /**
     * @notice Set the per-call close-factor ceiling for partial liquidations.
     * @dev    ADMIN_ROLE-only. Used by `RiskFacet.triggerPartialLiquidation`
     *         to bound how aggressive a single partial swap may be.
     *
     *         Pass `0` to reset to the library default
     *         (`MAX_PARTIAL_LIQUIDATION_CLOSE_FACTOR_BPS_DEFAULT` = 10_000 =
     *         100%, i.e. no governance-imposed cap; the keeper still
     *         picks the smallest fraction that restores HF≥1). Pass any
     *         value in `(0, 10_000]` to tighten — e.g. 5_000 for Aave-
     *         style "max 50% per call". Values > 10_000 are rejected
     *         (a partial above 100% of remaining collateral is not a
     *         partial).
     * @param  newBps New close-factor cap in BPS (0 = reset to default).
     */
    function setMaxPartialLiquidationCloseFactorBps(uint16 newBps)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (newBps > uint16(LibVaipakam.BASIS_POINTS)) {
            revert InvalidPartialLiqCloseFactorBps(newBps);
        }
        LibVaipakam.storageSlot().protocolCfg.maxPartialLiquidationCloseFactorBps = newBps;
        emit MaxPartialLiquidationCloseFactorBpsSet(newBps);
    }

    /// @notice Emitted whenever the per-tier LTV safety-box parameters
    ///         (floor / ceiling / haircut) are updated via
    ///         `setTierLtvParams`. Off-chain monitoring watches this
    ///         so a governance change is publicly observable.
    /// @custom:event-category informational/config
    event TierLtvParamsSet(
        uint16 tier1FloorBps, uint16 tier1CeilBps, uint16 tier1HaircutBps,
        uint16 tier2FloorBps, uint16 tier2CeilBps, uint16 tier2HaircutBps,
        uint16 tier3FloorBps, uint16 tier3CeilBps, uint16 tier3HaircutBps
    );

    /// @notice Per-tier LTV params validation errors.
    error TierLtvFloorAboveCeil(uint8 tier, uint16 floorBps, uint16 ceilBps);
    error TierLtvCeilTooHigh(uint8 tier, uint16 ceilBps);
    error TierLtvHaircutTooHigh(uint8 tier, uint16 haircutBps);
    error TierLtvBoundsNonMonotonic(
        uint16 tier1CeilBps, uint16 tier2FloorBps,
        uint16 tier2CeilBps, uint16 tier3FloorBps
    );

    /// @notice Max haircut governance may configure (10pp = 1000 BPS).
    ///         A haircut larger than that would push the autonomous
    ///         cache so far below the peer median that the gate becomes
    ///         vacuous; bounded here so a misfire can't lock borrowers
    ///         out via accidentally aggressive haircuts.
    uint16 internal constant TIER_LTV_HAIRCUT_CEIL_BPS = 1_000;

    /**
     * @notice Set the per-tier LTV safety-box parameters (floor /
     *         ceiling / haircut) for all three tiers atomically.
     *         Phase 7 of AutonomousLtvAndOracleFallback.md.
     *
     * @dev    ADMIN_ROLE-only — TimelockController post-handover, so
     *         48h-gated. Atomic for all three tiers so governance
     *         can never leave the protocol in a half-updated state
     *         where the cross-tier monotonic invariant (T1 box <= T2
     *         box <= T3 box) is temporarily broken.
     *
     *         Validation:
     *           - For each tier: `floor < ceil` and `ceil <= 10_000`.
     *           - Haircut <= 1_000 BPS (10pp) per tier — beyond that
     *             the gate is effectively vacuous.
     *           - Cross-tier monotonic: `T1.ceil <= T2.floor` AND
     *             `T2.ceil <= T3.floor` (boxes don't overlap, tier
     *             ordering is preserved).
     *
     *         Defaults (library constants used until governance
     *         overrides):
     *           Tier 1: floor 37% / ceil 55% / haircut 0pp
     *           Tier 2: floor 55% / ceil 69% / haircut 0pp
     *           Tier 3: floor 69% / ceil 82% / haircut 5pp
     *
     *         Each `TierLtvParams` slot is "configured" iff its
     *         `ceilBps` is non-zero — that's the storage-vs-default
     *         indicator. Passing a `ceilBps` of 0 for any tier is
     *         therefore rejected by the `floor < ceil` check (0 isn't
     *         a valid ceiling anyway).
     */
    function setTierLtvParams(
        uint16 tier1FloorBps, uint16 tier1CeilBps, uint16 tier1HaircutBps,
        uint16 tier2FloorBps, uint16 tier2CeilBps, uint16 tier2HaircutBps,
        uint16 tier3FloorBps, uint16 tier3CeilBps, uint16 tier3HaircutBps
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        uint16 bpsCeil = uint16(LibVaipakam.BASIS_POINTS);

        // Per-tier internal consistency.
        if (tier1FloorBps >= tier1CeilBps) revert TierLtvFloorAboveCeil(1, tier1FloorBps, tier1CeilBps);
        if (tier1CeilBps > bpsCeil)        revert TierLtvCeilTooHigh(1, tier1CeilBps);
        if (tier1HaircutBps > TIER_LTV_HAIRCUT_CEIL_BPS) revert TierLtvHaircutTooHigh(1, tier1HaircutBps);

        if (tier2FloorBps >= tier2CeilBps) revert TierLtvFloorAboveCeil(2, tier2FloorBps, tier2CeilBps);
        if (tier2CeilBps > bpsCeil)        revert TierLtvCeilTooHigh(2, tier2CeilBps);
        if (tier2HaircutBps > TIER_LTV_HAIRCUT_CEIL_BPS) revert TierLtvHaircutTooHigh(2, tier2HaircutBps);

        if (tier3FloorBps >= tier3CeilBps) revert TierLtvFloorAboveCeil(3, tier3FloorBps, tier3CeilBps);
        if (tier3CeilBps > bpsCeil)        revert TierLtvCeilTooHigh(3, tier3CeilBps);
        if (tier3HaircutBps > TIER_LTV_HAIRCUT_CEIL_BPS) revert TierLtvHaircutTooHigh(3, tier3HaircutBps);

        // Cross-tier monotonic invariant.
        if (tier1CeilBps > tier2FloorBps || tier2CeilBps > tier3FloorBps) {
            revert TierLtvBoundsNonMonotonic(
                tier1CeilBps, tier2FloorBps,
                tier2CeilBps, tier3FloorBps
            );
        }

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.tierLtvParams[1] = LibVaipakam.TierLtvParams({
            floorBps: tier1FloorBps,
            ceilBps:  tier1CeilBps,
            haircutBps: tier1HaircutBps
        });
        s.tierLtvParams[2] = LibVaipakam.TierLtvParams({
            floorBps: tier2FloorBps,
            ceilBps:  tier2CeilBps,
            haircutBps: tier2HaircutBps
        });
        s.tierLtvParams[3] = LibVaipakam.TierLtvParams({
            floorBps: tier3FloorBps,
            ceilBps:  tier3CeilBps,
            haircutBps: tier3HaircutBps
        });

        emit TierLtvParamsSet(
            tier1FloorBps, tier1CeilBps, tier1HaircutBps,
            tier2FloorBps, tier2CeilBps, tier2HaircutBps,
            tier3FloorBps, tier3CeilBps, tier3HaircutBps
        );
    }

    /// @notice Read the effective per-tier safety-box parameters
    ///         (governance override if set, library default otherwise).
    ///         Single-call view returning all three tiers' triples for
    ///         the protocol-console + audit-package per-chain
    ///         verification step.
    function getTierLtvParams()
        external
        view
        returns (
            uint16 tier1FloorBps, uint16 tier1CeilBps, uint16 tier1HaircutBps,
            uint16 tier2FloorBps, uint16 tier2CeilBps, uint16 tier2HaircutBps,
            uint16 tier3FloorBps, uint16 tier3CeilBps, uint16 tier3HaircutBps
        )
    {
        (tier1FloorBps, tier1CeilBps) = LibVaipakam.tierLtvBoundsBps(1);
        tier1HaircutBps = LibVaipakam.tierLtvHaircutBps(1);
        (tier2FloorBps, tier2CeilBps) = LibVaipakam.tierLtvBoundsBps(2);
        tier2HaircutBps = LibVaipakam.tierLtvHaircutBps(2);
        (tier3FloorBps, tier3CeilBps) = LibVaipakam.tierLtvBoundsBps(3);
        tier3HaircutBps = LibVaipakam.tierLtvHaircutBps(3);
    }

    /// @notice Emitted on every change to the auto-pause window.
    /// @custom:event-category informational/config
    event AutoPauseDurationSet(uint32 newSeconds);
    /// @notice Auto-pause duration outside the [MIN, MAX] bounds.
    error InvalidAutoPauseDuration(uint32 provided, uint256 minSec, uint256 maxSec);

    /**
     * @notice Set the auto-pause window duration (seconds). Used by
     *         the off-chain anomaly watcher's `AdminFacet.autoPause`
     *         entry to freeze the protocol while humans investigate.
     * @dev ADMIN_ROLE-only. Bounded inside `[MIN_AUTO_PAUSE_SECONDS,
     *      MAX_AUTO_PAUSE_SECONDS]` (5 min – 2 hours) — floor
     *      prevents stealth-disable via "set to 0", ceiling caps
     *      a compromised-watcher worst case. Pass any value in the
     *      bounds; pass exactly 0 to reset to the library default
     *      (`AUTO_PAUSE_DURATION_DEFAULT = 1800` ≡ 30 min).
     * @param newSeconds New duration in seconds.
     */
    function setAutoPauseDurationSeconds(uint32 newSeconds)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        // 0 is a valid sentinel meaning "use library default" (the
        // accessor handles the fallback). Non-zero values must fall
        // inside the [MIN, MAX] bounds so a misfire can't disable
        // the safety net or set an indefinite freeze ceiling.
        if (
            newSeconds != 0 &&
            (
                uint256(newSeconds) < LibVaipakam.MIN_AUTO_PAUSE_SECONDS ||
                uint256(newSeconds) > LibVaipakam.MAX_AUTO_PAUSE_SECONDS
            )
        ) {
            revert InvalidAutoPauseDuration(
                newSeconds,
                LibVaipakam.MIN_AUTO_PAUSE_SECONDS,
                LibVaipakam.MAX_AUTO_PAUSE_SECONDS
            );
        }
        LibVaipakam.storageSlot().protocolCfg.autoPauseDurationSeconds =
            newSeconds;
        emit AutoPauseDurationSet(newSeconds);
    }

    /// @notice Emitted on every change to the offer-creation duration cap.
    /// @custom:event-category informational/config
    event MaxOfferDurationDaysSet(uint16 newDays);
    /// @notice Max-offer-duration outside the [floor, ceil] bounds.
    error InvalidMaxOfferDurationDays(uint16 provided, uint256 floorDays, uint256 ceilDays);

    /**
     * @notice Update the maximum loan duration in days that
     *         `OfferFacet.createOffer` accepts (Findings 00025).
     * @dev ADMIN_ROLE-only. Bounded inside
     *      `[MIN_OFFER_DURATION_DAYS_FLOOR, MAX_OFFER_DURATION_DAYS_CEIL]`
     *      (7 days – 5 years) — the floor prevents an accidental
     *      "1 day max" lockout that would brick offer creation; the
     *      ceiling caps how far governance can stretch the
     *      `principal × rate × days / 365` interest formula's
     *      accuracy. Pass exactly 0 to reset to the library default
     *      (`MAX_OFFER_DURATION_DAYS_DEFAULT = 365` ≡ 1 year). Lower
     *      bound (1 day floor on every loan) is enforced separately
     *      at offer creation via the existing `durationDays == 0 →
     *      InvalidOfferType` check and is NOT governance-tunable.
     * @param newDays New maximum loan duration in days; pass 0 to
     *                reset to the library default.
     */
    function setMaxOfferDurationDays(uint16 newDays)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (
            newDays != 0 &&
            (
                newDays < LibVaipakam.MIN_OFFER_DURATION_DAYS_FLOOR ||
                newDays > LibVaipakam.MAX_OFFER_DURATION_DAYS_CEIL
            )
        ) {
            revert InvalidMaxOfferDurationDays(
                newDays,
                LibVaipakam.MIN_OFFER_DURATION_DAYS_FLOOR,
                LibVaipakam.MAX_OFFER_DURATION_DAYS_CEIL
            );
        }
        LibVaipakam.storageSlot().protocolCfg.maxOfferDurationDays = newDays;
        emit MaxOfferDurationDaysSet(newDays);
    }

    /// @notice T-032 / Numeraire generalization (Phase 1) — emitted on every change to
    ///         the per-loan-side notification fee. Value in numeraire-
    ///         units (1e18-scaled).
    /// @custom:event-category informational/config
    event NotificationFeeSet(uint256 newFeeNumeraire1e18);
    /// @notice T-032 — passed fee outside the [floor, ceil] bounds.
    error InvalidNotificationFee(
        uint256 provided,
        uint256 floor,
        uint256 ceil
    );

    /**
     * @notice Update the per-loan-side notification fee, denominated
     *         in NUMERAIRE-units (1e18 scaled). Charged in VPFI from
     *         the user's escrow on the FIRST PaidPush-tier notification
     *         fired by the off-chain hf-watcher.
     * @dev ADMIN_ROLE-only. Bounded inside
     *      `[MIN_NOTIFICATION_FEE_FLOOR, MAX_NOTIFICATION_FEE_CEIL]`
     *      (0.1 – 50.0 numeraire-units, = $0.10 – $50 under
     *      USD-as-numeraire). Floor prevents a misfire that sets the
     *      fee to ~zero and starves the Push channel; ceiling caps the
     *      worst-case user bill if governance misfires upward. Pass
     *      exactly 0 to reset to the library default
     *      `NOTIFICATION_FEE_DEFAULT` (2.0 numeraire-units = `2e18`).
     *
     *      Numeraire generalization (B1) — the per-knob `notificationFeeUsdOracle`
     *      was retired in Phase 1, and the `INumeraireOracle`
     *      abstraction was retired in B1. The protocol's reference
     *      currency now lives at the oracle layer
     *      (`s.ethNumeraireFeed` / `s.numeraireSymbol` /
     *      `s.numeraireChainlinkDenominator`); the fee → VPFI math is
     *      anchored to `getAssetPrice(WETH)` (which returns
     *      ETH/numeraire natively) times `VPFI_PER_ETH_FIXED_PHASE1`
     *      with no USD-intermediate. `setNumeraire` rotates everything
     *      atomically — the four feed-side slots plus the four
     *      numeraire-denominated value knobs (threshold + this fee +
     *      KYC tier 0 + KYC tier 1).
     * @param newFeeNumeraire1e18 New per-loan-side fee in numeraire-
     *                  unit 1e18 scaling; pass 0 to reset.
     */
    function setNotificationFee(uint256 newFeeNumeraire1e18)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (
            newFeeNumeraire1e18 != 0 &&
            (
                newFeeNumeraire1e18 < LibVaipakam.MIN_NOTIFICATION_FEE_FLOOR ||
                newFeeNumeraire1e18 > LibVaipakam.MAX_NOTIFICATION_FEE_CEIL
            )
        ) {
            revert InvalidNotificationFee(
                newFeeNumeraire1e18,
                LibVaipakam.MIN_NOTIFICATION_FEE_FLOOR,
                LibVaipakam.MAX_NOTIFICATION_FEE_CEIL
            );
        }
        LibVaipakam.storageSlot().protocolCfg.notificationFee = newFeeNumeraire1e18;
        emit NotificationFeeSet(newFeeNumeraire1e18);
    }

    /**
     * @notice T-032 / Numeraire generalization (Phase 1) — read the live notification-
     *         fee config in one RPC. Frontend reads this to render the
     *         cost disclosure on the subscription opt-in UI.
     * @return feeNumeraire1e18 Resolved fee in numeraire-units —
     *                     either the storage override or the library
     *                     default. Convert to USD via the global
     *                     `numeraireOracle` (read separately via
     *                     `getNumeraireOracle()`).
     * @return feesAccrued Cumulative VPFI debited via
     *                     `markNotifBilled` since deploy. Operator
     *                     monitors for anomalies.
     */
    function getNotificationFeeConfig()
        external
        view
        returns (uint256 feeNumeraire1e18, uint256 feesAccrued)
    {
        feeNumeraire1e18 = LibVaipakam.cfgNotificationFee();
        feesAccrued = LibVaipakam.storageSlot().notificationFeesAccrued;
    }

    /**
     * @notice Update the liquidation-path risk knobs atomically.
     * @param handlingFeeBps Treasury cut on successful DEX liquidation (default 200 ≡ 2%).
     * @param maxSlippageBps Ceiling on 0x slippage before falling back (default 600 ≡ 6%).
     * @param maxIncentiveBps Cap on dynamic liquidator incentive (default 300 ≡ 3%).
     * @dev ADMIN_ROLE-only. Pass `0` to reset any individual field.
     */
    function setLiquidationConfig(
        uint16 handlingFeeBps,
        uint16 maxSlippageBps,
        uint16 maxIncentiveBps
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (handlingFeeBps > MAX_FEE_BPS) revert InvalidFeeBps(handlingFeeBps, MAX_FEE_BPS);
        if (maxSlippageBps > MAX_SLIPPAGE_BPS) revert InvalidSlippageBps(maxSlippageBps, MAX_SLIPPAGE_BPS);
        if (maxIncentiveBps > MAX_INCENTIVE_BPS) revert InvalidIncentiveBps(maxIncentiveBps, MAX_INCENTIVE_BPS);
        LibVaipakam.ProtocolConfig storage c = LibVaipakam.storageSlot().protocolCfg;
        c.liquidationHandlingFeeBps = handlingFeeBps;
        c.maxLiquidationSlippageBps = maxSlippageBps;
        c.maxLiquidatorIncentiveBps = maxIncentiveBps;
        emit LiquidationConfigSet(handlingFeeBps, maxSlippageBps, maxIncentiveBps);
    }

    /**
     * @notice Update the volatility-fallback LTV threshold and rental buffer.
     * @param volatilityLtvThresholdBps LTV above which the loan falls back
     *        to the snapshot settlement (default 11000 ≡ 110%). Must be
     *        strictly greater than 10_000 BPS — a threshold at or below
     *        100% LTV would trigger fallback on every healthy loan.
     * @param rentalBufferBps Safety buffer on NFT rental prepay (default 500 ≡ 5%).
     * @dev ADMIN_ROLE-only. Pass `0` for `volatilityLtvThresholdBps` to
     *      reset to the default (the > 10_000 check is skipped on 0).
     */
    function setRiskConfig(uint16 volatilityLtvThresholdBps, uint16 rentalBufferBps)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (volatilityLtvThresholdBps != 0 && volatilityLtvThresholdBps <= uint16(LibVaipakam.BASIS_POINTS)) {
            revert InvalidVolatilityLtvBps(volatilityLtvThresholdBps);
        }
        if (rentalBufferBps > MAX_RENTAL_BUFFER_BPS) revert InvalidRentalBufferBps(rentalBufferBps);
        LibVaipakam.ProtocolConfig storage c = LibVaipakam.storageSlot().protocolCfg;
        c.volatilityLtvThresholdBps = volatilityLtvThresholdBps;
        c.rentalBufferBps = rentalBufferBps;
        emit RiskConfigSet(volatilityLtvThresholdBps, rentalBufferBps);
    }

    /**
     * @notice Update the VPFI escrow staking APR.
     * @param aprBps Annual rate in BPS (default 500 ≡ 5%). Passing `0`
     *        resets to the default.
     * @dev ADMIN_ROLE-only. Capped at 100% APR to guard against typos.
     *
     *      {LibStakingRewards.checkpointGlobal} MUST fire BEFORE writing
     *      the new rate. That call folds the OLD APR × elapsed time into
     *      `stakingRewardPerTokenStored` and stamps `stakingLastUpdateTime
     *      = now`, so the subsequent `currentRewardPerToken()` view uses
     *      the new APR only for time AFTER this tx. Without the checkpoint,
     *      `currentRewardPerToken()` computes `dt × newApr` for the whole
     *      elapsed period since the last update — effectively applying the
     *      new rate retroactively to the old era. The fix makes every APR
     *      era non-retroactive: each value applies to exactly the duration
     *      it was in effect, automatically across both active and dormant
     *      stakers (the global counter stores the full historical integral).
     */
    function setStakingApr(uint16 aprBps) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        // Setter-range audit (2026-05-02): tightened from
        // `≤ BASIS_POINTS` (100% APR) to `≤ STAKING_APR_BPS_MAX`
        // (20% APR). Above 20% is unrealistic for VPFI staking and
        // a compromised admin pushing past it is a governance-error
        // vector. Zero is permitted (disables rewards while
        // preserving the staked principal accounting).
        if (aprBps > LibVaipakam.STAKING_APR_BPS_MAX) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "stakingAprBps",
                uint256(aprBps),
                0,
                uint256(LibVaipakam.STAKING_APR_BPS_MAX)
            );
        }
        LibStakingRewards.checkpointGlobal();
        LibVaipakam.storageSlot().protocolCfg.vpfiStakingAprBps = aprBps;
        emit StakingAprSet(aprBps);
    }

    /**
     * @notice Update all four VPFI discount tier thresholds atomically.
     * @param t1 T1 minimum (default 100e18). Must be strictly less than `t2`.
     * @param t2 T2 minimum (default 1_000e18). Must be strictly less than `t3`.
     * @param t3 T3 minimum (default 5_000e18). Must be ≤ `t4`.
     * @param t4 T4 minimum-exclusive threshold (default 20_000e18).
     * @dev ADMIN_ROLE-only. Pass `0` in any slot to reset that slot to
     *      its default (and the monotonicity check is evaluated on the
     *      RESOLVED effective values, not the raw zero inputs).
     */
    function setVpfiTierThresholds(uint256 t1, uint256 t2, uint256 t3, uint256 t4)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        uint256 e1 = t1 == 0 ? LibVaipakam.VPFI_TIER1_MIN : t1;
        uint256 e2 = t2 == 0 ? LibVaipakam.VPFI_TIER2_MIN : t2;
        uint256 e3 = t3 == 0 ? LibVaipakam.VPFI_TIER3_MIN : t3;
        uint256 e4 = t4 == 0 ? LibVaipakam.VPFI_TIER4_THRESHOLD : t4;
        if (!(e1 < e2 && e2 < e3 && e3 <= e4)) {
            revert NonMonotoneTierThresholds(e1, e2, e3, e4);
        }
        LibVaipakam.ProtocolConfig storage c = LibVaipakam.storageSlot().protocolCfg;
        c.vpfiTier1Min = t1;
        c.vpfiTier2Min = t2;
        c.vpfiTier3Min = t3;
        c.vpfiTier4Threshold = t4;
        emit VpfiTierThresholdsSet(t1, t2, t3, t4);
    }

    /**
     * @notice Update all four VPFI discount tier BPS atomically.
     * @param t1 T1 discount (default 1000 ≡ 10%).
     * @param t2 T2 discount (default 1500 ≡ 15%).
     * @param t3 T3 discount (default 2000 ≡ 20%).
     * @param t4 T4 discount (default 2400 ≡ 24%).
     * @dev ADMIN_ROLE-only. Pass `0` to reset a slot. Effective values
     *      (override or default) must be monotone non-decreasing across
     *      tiers — T4 ≥ T3 ≥ T2 ≥ T1 — otherwise a higher-balance user
     *      could receive a smaller discount than a lower-balance one.
     *      Each BPS is capped at {MAX_DISCOUNT_BPS} (90%).
     */
    function setVpfiTierDiscountBps(uint16 t1, uint16 t2, uint16 t3, uint16 t4)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (t1 > MAX_DISCOUNT_BPS) revert DiscountBpsTooHigh(t1, MAX_DISCOUNT_BPS);
        if (t2 > MAX_DISCOUNT_BPS) revert DiscountBpsTooHigh(t2, MAX_DISCOUNT_BPS);
        if (t3 > MAX_DISCOUNT_BPS) revert DiscountBpsTooHigh(t3, MAX_DISCOUNT_BPS);
        if (t4 > MAX_DISCOUNT_BPS) revert DiscountBpsTooHigh(t4, MAX_DISCOUNT_BPS);
        uint16 e1 = t1 == 0 ? uint16(LibVaipakam.VPFI_TIER1_DISCOUNT_BPS) : t1;
        uint16 e2 = t2 == 0 ? uint16(LibVaipakam.VPFI_TIER2_DISCOUNT_BPS) : t2;
        uint16 e3 = t3 == 0 ? uint16(LibVaipakam.VPFI_TIER3_DISCOUNT_BPS) : t3;
        uint16 e4 = t4 == 0 ? uint16(LibVaipakam.VPFI_TIER4_DISCOUNT_BPS) : t4;
        if (!(e1 <= e2 && e2 <= e3 && e3 <= e4)) {
            revert NonMonotoneTierDiscounts(e1, e2, e3, e4);
        }
        LibVaipakam.ProtocolConfig storage c = LibVaipakam.storageSlot().protocolCfg;
        c.vpfiTier1DiscountBps = t1;
        c.vpfiTier2DiscountBps = t2;
        c.vpfiTier3DiscountBps = t3;
        c.vpfiTier4DiscountBps = t4;
        emit VpfiTierDiscountsSet(t1, t2, t3, t4);
    }

    /**
     * @notice Update the fallback-path settlement split (README §7).
     * @param lenderBonusBps Lender bonus share on the fallback path, in
     *        BPS of principal. Default 300 ≡ 3%. Pass `0` to reset.
     * @param treasuryBps    Treasury share on the fallback path, in BPS
     *        of principal. Default 200 ≡ 2%. Pass `0` to reset.
     * @dev ADMIN_ROLE-only. Each leg is capped at {MAX_FALLBACK_BPS}
     *      (10%); combined at {MAX_FALLBACK_COMBINED_BPS} (15%). The
     *      borrower's residual equity must stay meaningful even under
     *      the most adverse governance setting.
     *
     *      Prospective semantics: `LoanFacet.initiateLoan` snapshots the
     *      effective values at creation time onto `Loan.fallbackLender
     *      BonusBpsAtInit` / `fallbackTreasuryBpsAtInit`, and
     *      `LibFallback.computeFallbackEntitlements` reads from the
     *      snapshot — governance changes never retroactively alter the
     *      dual-consent offer contract.
     */
    function setFallbackSplit(uint16 lenderBonusBps, uint16 treasuryBps)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        // Resolve zero-as-default for the bounds check so the monotonicity
        // and combined-cap rules apply to what callers WILL see, not to
        // the raw zero input.
        uint16 e1 = lenderBonusBps == 0
            ? uint16(LibVaipakam.FALLBACK_LENDER_BONUS_BPS)
            : lenderBonusBps;
        uint16 e2 = treasuryBps == 0
            ? uint16(LibVaipakam.FALLBACK_TREASURY_BPS)
            : treasuryBps;
        if (e1 > MAX_FALLBACK_BPS || e2 > MAX_FALLBACK_BPS) {
            revert FallbackSplitTooHigh(e1, e2, MAX_FALLBACK_BPS);
        }
        uint256 combined = uint256(e1) + uint256(e2);
        if (combined > MAX_FALLBACK_COMBINED_BPS) {
            revert FallbackSplitCombinedTooHigh(combined, MAX_FALLBACK_COMBINED_BPS);
        }
        LibVaipakam.ProtocolConfig storage c = LibVaipakam.storageSlot().protocolCfg;
        c.fallbackLenderBonusBps = lenderBonusBps;
        c.fallbackTreasuryBps = treasuryBps;
        emit FallbackSplitSet(lenderBonusBps, treasuryBps);
    }

    /// ─── Range Orders Phase 1 master kill-switch flags ──────────────
    /// All three default `false` on a fresh deploy. Each gates a
    /// distinct mechanic in `OfferFacet` so governance can enable /
    /// disable independently. See docs/RangeOffersDesign.md §15.

    /// @notice Toggle whether `OfferFacet.createOffer` accepts a range
    ///         on the lending amount (`amountMax > amount`). When false,
    ///         every offer is forced single-value (`amountMax == amount`).
    function setRangeAmountEnabled(bool enabled)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.rangeAmountEnabled = enabled;
        emit RangeAmountEnabledSet(enabled);
    }

    /// @notice Toggle whether `OfferFacet.createOffer` accepts a range
    ///         on the interest rate.
    function setRangeRateEnabled(bool enabled)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.rangeRateEnabled = enabled;
        emit RangeRateEnabledSet(enabled);
    }

    /// @notice Toggle whether lender offers can be filled across multiple
    ///         matches. When false, every lender offer is single-fill
    ///         even if `rangeAmountEnabled` permits a range — the first
    ///         match exhausts the offer regardless of remaining capacity.
    function setPartialFillEnabled(bool enabled)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.partialFillEnabled = enabled;
        emit PartialFillEnabledSet(enabled);
    }

    /// ─── Depth-tiered LTV (Piece B) — governance globals ────────────
    /// See docs/DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md
    /// §4.2-§4.3. All ADMIN_ROLE-gated (→ Timelock post-handover),
    /// `0 ⇒ library default`, bounded so a hostile / fat-fingered vote
    /// can't push a value to a degenerate setting. The on-chain
    /// `getLiquidityTier` *is* the per-asset authority — there is no
    /// per-asset allowlist here; the only per-asset lever stays
    /// `AdminFacet.pauseAsset` / blacklist.

    /// @custom:event-category informational/config
    event DepthTieredLtvEnabledSet(bool enabled);
    /// @custom:event-category informational/config
    event LiquiditySlippageBpsSet(uint16 newBps);
    /// @custom:event-category informational/config
    event TwapGuardSet(uint32 windowSec, uint16 consistencyBps);
    /// @custom:event-category informational/config
    event LiquidityTierSizesSet(uint64 floorPad, uint64 tier1Pad, uint64 tier2Pad, uint64 tier3Pad);
    /// @custom:event-category informational/config
    event TierMaxInitLtvBpsSet(uint16 tier1, uint16 tier2, uint16 tier3);
    /// @custom:event-category informational/config
    event PaaAssetsSet(uint256 count);
    /// @notice Emitted when the off-chain liquidity-confidence relay
    ///         (`KEEPER_ROLE`) re-rates an asset. `tier` is 1..3.
    /// @custom:event-category informational/config
    event KeeperTierSet(address indexed asset, uint8 tier);

    /// @notice Master kill-switch for the depth-tiered init-LTV cap.
    ///         Default `false` — the loan-init gate stays exactly
    ///         today's `HF ≥ 1.5` (everyone effectively Tier 1 ≈ 53%);
    ///         `getLiquidityTier` still computes the real tier for the
    ///         keeper / UI. Flip on per chain *only after* that chain's
    ///         slippage census + the audit (§4.4 step 6).
    function setDepthTieredLtvEnabled(bool enabled)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.depthTieredLtvEnabled = enabled;
        emit DepthTieredLtvEnabledSet(enabled);
    }

    /// ─── FlashLoanLiquidationPath.md — discount-path governance ──────

    /// @notice Emitted on every flip of the discount-path master flag.
    /// @custom:event-category informational/config
    event DiscountPathEnabledSet(bool enabled);

    /// @notice Emitted on every update of the per-tier liquidator
    ///         discount values. Off-chain monitoring watches this so a
    ///         governance change is publicly observable; the keeper
    ///         bot also re-reads the values from this event so its
    ///         simulation math tracks the on-chain config without an
    ///         extra view call per loan.
    /// @custom:event-category informational/config
    event TierLiqDiscountBpsSet(
        uint16 tier1Bps,
        uint16 tier2Bps,
        uint16 tier3Bps
    );

    /// @notice Per-tier discount out of its per-tier safety box.
    error TierLiqDiscountOutOfRange(
        uint8 tier,
        uint16 valueBps,
        uint16 floorBps,
        uint16 ceilBps
    );

    /// @notice Cross-tier monotonic invariant violated. Tier 1 (thinnest)
    ///         must carry a discount ≥ Tier 2 ≥ Tier 3 (deepest) — same
    ///         "thinner tier = wider discount" ordering as the bounds.
    error TierLiqDiscountNonMonotonic(
        uint16 tier1Bps,
        uint16 tier2Bps,
        uint16 tier3Bps
    );

    /**
     * @notice Master kill-switch for the flash-loan /
     *         liquidator-buys-at-discount liquidation path
     *         (`RiskFacet.triggerLiquidationDiscounted`). Default
     *         `false` ⇒ the entry point reverts immediately so a
     *         fresh deploy never exposes the path before its per-chain
     *         audit + risk-committee sign-off.
     *
     * @dev    Independent of `depthTieredLtvEnabled` — the two flags
     *         gate different mechanics and may be flipped on
     *         independently per chain (e.g. discount-path active while
     *         autonomous-LTV is still in census-only mode). ADMIN_ROLE
     *         pre-handover; TimelockController-gated 48h post-handover.
     */
    function setDiscountPathEnabled(bool enabled)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.discountPathEnabled = enabled;
        emit DiscountPathEnabledSet(enabled);
    }

    /**
     * @notice Set the per-tier liquidator-discount values (BPS) for
     *         all three tiers atomically. Phase 8 of
     *         `FlashLoanLiquidationPath.md`.
     *
     * @dev    ADMIN_ROLE-only — TimelockController post-handover.
     *         Atomic over all three tiers so governance can never
     *         leave the protocol with a half-updated config that
     *         temporarily breaks the cross-tier monotonic invariant
     *         (`T1 ≥ T2 ≥ T3`).
     *
     *         Validation:
     *           - Per tier `value ∈ [floor, ceil]` from the
     *             `tierLiqDiscountBoundsBps` library accessor.
     *           - Cross-tier monotonic `T1 ≥ T2 ≥ T3` (thinner tier
     *             = wider discount). The library defaults (770 / 600
     *             / 500) satisfy this trivially.
     *
     *         Each tier slot in `ProtocolConfig` is interpreted as:
     *           value == 0  ⇒ use library default
     *           value != 0  ⇒ governance override
     *         A governance write of zero would effectively "clear back
     *         to default" — allowed by passing 0 for that tier (the
     *         per-tier floor check is skipped when value == 0). Doing
     *         so for all three tiers reverts via the monotonic check
     *         when the resulting library defaults are skewed; in
     *         practice governance either writes all three non-zero
     *         (atomic override) or never calls this setter.
     *
     * @param  tier1Bps Discount for Tier 1 (thinnest qualifying tier).
     * @param  tier2Bps Discount for Tier 2.
     * @param  tier3Bps Discount for Tier 3 (deepest).
     */
    function setTierLiqDiscountBps(
        uint16 tier1Bps,
        uint16 tier2Bps,
        uint16 tier3Bps
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        // Per-tier safety-box check. Zero is a valid sentinel meaning
        // "clear back to library default" — skip the floor check for
        // it; the `effectiveTierLiqDiscountBps` read fills in the
        // default at consumer-side.
        (uint16 t1Floor, uint16 t1Ceil) = LibVaipakam.tierLiqDiscountBoundsBps(1);
        if (tier1Bps != 0 && (tier1Bps < t1Floor || tier1Bps > t1Ceil)) {
            revert TierLiqDiscountOutOfRange(1, tier1Bps, t1Floor, t1Ceil);
        }
        (uint16 t2Floor, uint16 t2Ceil) = LibVaipakam.tierLiqDiscountBoundsBps(2);
        if (tier2Bps != 0 && (tier2Bps < t2Floor || tier2Bps > t2Ceil)) {
            revert TierLiqDiscountOutOfRange(2, tier2Bps, t2Floor, t2Ceil);
        }
        (uint16 t3Floor, uint16 t3Ceil) = LibVaipakam.tierLiqDiscountBoundsBps(3);
        if (tier3Bps != 0 && (tier3Bps < t3Floor || tier3Bps > t3Ceil)) {
            revert TierLiqDiscountOutOfRange(3, tier3Bps, t3Floor, t3Ceil);
        }

        // Cross-tier monotonic invariant — applied to the EFFECTIVE
        // values (zero falls through to the library default) so a
        // partial-override write can't accidentally invert the
        // ordering. E.g. writing (0, 0, 700) with library defaults
        // (770, 600, 500) yields effective (770, 600, 700) which
        // violates T2 ≥ T3 and reverts here.
        uint16 t1Eff = tier1Bps != 0 ? tier1Bps : LibVaipakam.TIER1_LIQ_DISCOUNT_DEFAULT_BPS;
        uint16 t2Eff = tier2Bps != 0 ? tier2Bps : LibVaipakam.TIER2_LIQ_DISCOUNT_DEFAULT_BPS;
        uint16 t3Eff = tier3Bps != 0 ? tier3Bps : LibVaipakam.TIER3_LIQ_DISCOUNT_DEFAULT_BPS;
        if (t1Eff < t2Eff || t2Eff < t3Eff) {
            revert TierLiqDiscountNonMonotonic(t1Eff, t2Eff, t3Eff);
        }

        LibVaipakam.ProtocolConfig storage cfg = LibVaipakam.storageSlot().protocolCfg;
        cfg.tier1LiqDiscountBps = tier1Bps;
        cfg.tier2LiqDiscountBps = tier2Bps;
        cfg.tier3LiqDiscountBps = tier3Bps;

        emit TierLiqDiscountBpsSet(tier1Bps, tier2Bps, tier3Bps);
    }

    /// @notice Read the effective per-tier discount values (governance
    ///         override if set, library default otherwise). Single-
    ///         call view for the protocol-console + audit-package
    ///         per-chain verification step.
    function getTierLiqDiscountBps()
        external
        view
        returns (uint16 tier1Bps, uint16 tier2Bps, uint16 tier3Bps)
    {
        tier1Bps = LibVaipakam.effectiveTierLiqDiscountBps(1);
        tier2Bps = LibVaipakam.effectiveTierLiqDiscountBps(2);
        tier3Bps = LibVaipakam.effectiveTierLiqDiscountBps(3);
    }

    /// @notice Set the slippage bound (bps) a simulated fixed-size swap
    ///         must clear to count toward a tier. Pass `0` to reset to
    ///         the library default (`LIQUIDITY_SLIPPAGE_BPS_DEFAULT` =
    ///         200 ≡ 2%); non-zero values must fall inside
    ///         `[MIN_LIQUIDITY_SLIPPAGE_BPS, MAX_LIQUIDITY_SLIPPAGE_BPS]`
    ///         (0.25% – 10%).
    function setLiquiditySlippageBps(uint16 newBps)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (
            newBps != 0 &&
            (
                uint256(newBps) < LibVaipakam.MIN_LIQUIDITY_SLIPPAGE_BPS ||
                uint256(newBps) > LibVaipakam.MAX_LIQUIDITY_SLIPPAGE_BPS
            )
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "liquiditySlippageBps",
                uint256(newBps),
                LibVaipakam.MIN_LIQUIDITY_SLIPPAGE_BPS,
                LibVaipakam.MAX_LIQUIDITY_SLIPPAGE_BPS
            );
        }
        LibVaipakam.storageSlot().protocolCfg.liquiditySlippageBps = newBps;
        emit LiquiditySlippageBpsSet(newBps);
    }

    /// @notice Set the pool spot-vs-own-TWAP manipulation guard — the
    ///         observation `windowSec` and the agreement `consistencyBps`
    ///         band — in one atomic call. Either field `0` ⇒ its library
    ///         default (`TWAP_WINDOW_SEC_DEFAULT` = 30 min /
    ///         `TWAP_CONSISTENCY_BPS_DEFAULT` = 300 ≡ 3%); non-zero must
    ///         fall inside `[MIN_TWAP_WINDOW_SEC, MAX_TWAP_WINDOW_SEC]`
    ///         (5 min – 1 day) and `[MIN_TWAP_CONSISTENCY_BPS,
    ///         MAX_TWAP_CONSISTENCY_BPS]` (0.5% – 10%) respectively.
    function setTwapGuard(uint32 windowSec, uint16 consistencyBps)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (
            windowSec != 0 &&
            (
                uint256(windowSec) < LibVaipakam.MIN_TWAP_WINDOW_SEC ||
                uint256(windowSec) > LibVaipakam.MAX_TWAP_WINDOW_SEC
            )
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "twapWindowSec",
                uint256(windowSec),
                LibVaipakam.MIN_TWAP_WINDOW_SEC,
                LibVaipakam.MAX_TWAP_WINDOW_SEC
            );
        }
        if (
            consistencyBps != 0 &&
            (
                uint256(consistencyBps) < LibVaipakam.MIN_TWAP_CONSISTENCY_BPS ||
                uint256(consistencyBps) > LibVaipakam.MAX_TWAP_CONSISTENCY_BPS
            )
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "twapConsistencyBps",
                uint256(consistencyBps),
                LibVaipakam.MIN_TWAP_CONSISTENCY_BPS,
                LibVaipakam.MAX_TWAP_CONSISTENCY_BPS
            );
        }
        LibVaipakam.ProtocolConfig storage c = LibVaipakam.storageSlot().protocolCfg;
        c.twapWindowSec = windowSec;
        c.twapConsistencyBps = consistencyBps;
        emit TwapGuardSet(windowSec, consistencyBps);
    }

    /// @notice Set the simulated-swap test sizes for the binary `Liquid`
    ///         floor and the three graded tiers, each in PAD × 1e6 units
    ///         (so `5_000e6` ≡ "5,000 PAD" — USD on the retail deploy;
    ///         see {LibVaipakam.effectivePadSymbol}). Any field `0` ⇒ its
    ///         library default (5k / 50k / 500k / 5M PAD). On the
    ///         *effective* (post-default) values the setter enforces
    ///         `floor ≤ tier1 ≤ tier2 ≤ tier3` and each ≥
    ///         `MIN_TIER_SIZE_PAD` (1,000 PAD) — so an all-zero call is
    ///         a clean "reset to defaults".
    function setLiquidityTierSizes(
        uint64 floorPad,
        uint64 tier1Pad,
        uint64 tier2Pad,
        uint64 tier3Pad
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        uint256 f = floorPad == 0 ? LibVaipakam.FLOOR_SIZE_PAD_DEFAULT : uint256(floorPad);
        uint256 t1 = tier1Pad == 0 ? LibVaipakam.TIER1_SIZE_PAD_DEFAULT : uint256(tier1Pad);
        uint256 t2 = tier2Pad == 0 ? LibVaipakam.TIER2_SIZE_PAD_DEFAULT : uint256(tier2Pad);
        uint256 t3 = tier3Pad == 0 ? LibVaipakam.TIER3_SIZE_PAD_DEFAULT : uint256(tier3Pad);
        uint256 minPad = LibVaipakam.MIN_TIER_SIZE_PAD;
        if (f < minPad) revert TierSizeTooSmall(f, minPad);
        if (!(f <= t1 && t1 <= t2 && t2 <= t3)) revert NonMonotoneTierSizes(f, t1, t2, t3);
        LibVaipakam.ProtocolConfig storage c = LibVaipakam.storageSlot().protocolCfg;
        c.floorSizePad = floorPad;
        c.tier1SizePad = tier1Pad;
        c.tier2SizePad = tier2Pad;
        c.tier3SizePad = tier3Pad;
        emit LiquidityTierSizesSet(floorPad, tier1Pad, tier2Pad, tier3Pad);
    }

    /// @notice Set the per-tier max init-LTV caps (bps). Any field `0`
    ///         ⇒ its library default (5000 / 6000 / 6500). On the
    ///         *effective* values: `tier1 ≤ tier2 ≤ tier3` and each ≤
    ///         `MAX_TIER_INIT_LTV_BPS_CEIL` (8000 ≡ 80%). When
    ///         `depthTieredLtvEnabled`, loan-init caps the LTV at
    ///         `min(assetRiskParams.loanInitMaxLtvBps, tierMaxInitLtvBps[
    ///         effectiveTier])`.
    function setTierMaxInitLtvBps(uint16 tier1, uint16 tier2, uint16 tier3)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        uint256 t1 = tier1 == 0 ? LibVaipakam.TIER1_MAX_INIT_LTV_BPS_DEFAULT : uint256(tier1);
        uint256 t2 = tier2 == 0 ? LibVaipakam.TIER2_MAX_INIT_LTV_BPS_DEFAULT : uint256(tier2);
        uint256 t3 = tier3 == 0 ? LibVaipakam.TIER3_MAX_INIT_LTV_BPS_DEFAULT : uint256(tier3);
        uint256 ceil = LibVaipakam.MAX_TIER_INIT_LTV_BPS_CEIL;
        if (t1 > ceil) revert TierLtvBpsTooHigh(t1, ceil);
        if (t2 > ceil) revert TierLtvBpsTooHigh(t2, ceil);
        if (t3 > ceil) revert TierLtvBpsTooHigh(t3, ceil);
        if (!(t1 <= t2 && t2 <= t3)) revert NonMonotoneTierLtvBps(t1, t2, t3);
        LibVaipakam.ProtocolConfig storage c = LibVaipakam.storageSlot().protocolCfg;
        c.tier1MaxInitLtvBps = tier1;
        c.tier2MaxInitLtvBps = tier2;
        c.tier3MaxInitLtvBps = tier3;
        emit TierMaxInitLtvBpsSet(tier1, tier2, tier3);
    }

    /// @notice Emitted on every change to the per-tier LIQUIDATION
    ///         threshold (the LTV at which a loan with that tier's
    ///         collateral becomes liquidatable). PR2 of the
    ///         internal-match work — see `InternalLiquidationLedger.md`
    ///         §0. Off-chain monitoring watches this so a governance
    ///         change to liquidation gates is publicly observable.
    /// @custom:event-category informational/config
    event TierLiquidationLtvBpsSet(uint16 tier1, uint16 tier2, uint16 tier3);

    /// @notice Bound + monotonic-ordering errors for the per-tier
    ///         liquidation-threshold setter.
    error TierLiquidationLtvBpsTooHigh(uint256 provided, uint256 maxAllowed);
    error TierLiquidationLtvBpsTooLow(uint256 provided, uint256 minAllowed);
    error NonMonotoneTierLiquidationLtvBps(uint256 t1, uint256 t2, uint256 t3);

    /// @notice Set the per-tier LIQUIDATION threshold (bps) atomically
    ///         for all three liquidity tiers. PR2 of the internal-match
    ///         work — replaces the retired per-asset
    ///         `RiskParams.liqThresholdBps`. Each `0` ⇒ library default
    ///         (9000 / 8500 / 8000 = 90% / 85% / 80%).
    /// @dev    ADMIN_ROLE-only (TimelockController post-handover).
    ///         Validation:
    ///           - Each tier value (after default-resolution) lies in
    ///             `[MIN_TIER_LIQUIDATION_LTV_BPS, MAX_TIER_LIQUIDATION_LTV_BPS]`
    ///             (i.e. 50% ≤ value ≤ 95%). Floor 50% prevents an
    ///             accidental "always liquidatable" misconfig; ceiling
    ///             95% preserves the ≥5% LTV bad-debt buffer below
    ///             100% at the most permissive setting.
    ///           - Cross-tier monotonic: `T1 ≥ T2 ≥ T3` (deeper-
    ///             liquidity tier tolerates higher pre-liquidation LTV).
    ///         New loans snapshot the effective value at `initiateLoan`
    ///         onto `Loan.liquidationLtvBpsAtInit`; existing loans
    ///         keep their original snapshot — admin tunes apply
    ///         prospectively only.
    function setTierLiquidationLtvBps(uint16 tier1, uint16 tier2, uint16 tier3)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        uint256 t1 = tier1 == 0 ? uint256(LibVaipakam.DEFAULT_TIER1_LIQUIDATION_LTV_BPS) : uint256(tier1);
        uint256 t2 = tier2 == 0 ? uint256(LibVaipakam.DEFAULT_TIER2_LIQUIDATION_LTV_BPS) : uint256(tier2);
        uint256 t3 = tier3 == 0 ? uint256(LibVaipakam.DEFAULT_TIER3_LIQUIDATION_LTV_BPS) : uint256(tier3);
        uint256 floor = uint256(LibVaipakam.MIN_TIER_LIQUIDATION_LTV_BPS);
        uint256 ceil = uint256(LibVaipakam.MAX_TIER_LIQUIDATION_LTV_BPS);
        if (t1 < floor) revert TierLiquidationLtvBpsTooLow(t1, floor);
        if (t2 < floor) revert TierLiquidationLtvBpsTooLow(t2, floor);
        if (t3 < floor) revert TierLiquidationLtvBpsTooLow(t3, floor);
        if (t1 > ceil) revert TierLiquidationLtvBpsTooHigh(t1, ceil);
        if (t2 > ceil) revert TierLiquidationLtvBpsTooHigh(t2, ceil);
        if (t3 > ceil) revert TierLiquidationLtvBpsTooHigh(t3, ceil);
        // Cross-tier monotonic: deeper-liquidity tier tolerates higher
        // pre-liquidation LTV, i.e. T1 ≥ T2 ≥ T3.
        if (!(t1 >= t2 && t2 >= t3)) revert NonMonotoneTierLiquidationLtvBps(t1, t2, t3);
        LibVaipakam.ProtocolConfig storage c = LibVaipakam.storageSlot().protocolCfg;
        c.tier1LiquidationLtvBps = tier1;
        c.tier2LiquidationLtvBps = tier2;
        c.tier3LiquidationLtvBps = tier3;
        emit TierLiquidationLtvBpsSet(tier1, tier2, tier3);
    }

    /// @notice Get the effective per-tier LIQUIDATION threshold (bps)
    ///         — override OR library default — for each of the three
    ///         liquidity tiers. Frontend reads this to render the
    ///         "liquidation at LTV X%" disclosure per loan after
    ///         resolving the asset's tier via
    ///         `OracleFacet.getEffectiveLiquidityTier`.
    function getTierLiquidationLtvBps()
        external
        view
        returns (uint256 tier1, uint256 tier2, uint256 tier3)
    {
        tier1 = LibVaipakam.cfgTier1LiquidationLtvBps();
        tier2 = LibVaipakam.cfgTier2LiquidationLtvBps();
        tier3 = LibVaipakam.cfgTier3LiquidationLtvBps();
    }

    /// @notice Replace the PAA list — the per-chain "predominantly
    ///         available" quote tokens the depth-tier route search probes
    ///         an asset's pools against (e.g. `[WETH, USDC, USDT, DAI]`
    ///         by their addresses on this chain). Pass an empty array to
    ///         reset to the implicit `[wethContract]` fallback. Validates:
    ///         no zero address, no duplicates, length ≤ {MAX_PAA_ASSETS}.
    ///         (A member without a Chainlink feed is harmless — the route
    ///         search skips it; this is *not* a per-asset *tiering*
    ///         allowlist.)
    function setPaaAssets(address[] calldata assets)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        uint256 n = assets.length;
        if (n > MAX_PAA_ASSETS) revert PaaListInvalid("over MAX_PAA_ASSETS");
        for (uint256 i; i < n; ++i) {
            if (assets[i] == address(0)) revert PaaListInvalid("zero address");
            for (uint256 j = i + 1; j < n; ++j) {
                if (assets[i] == assets[j]) revert PaaListInvalid("duplicate");
            }
        }
        address[] storage list = LibVaipakam.storageSlot().paaAssets;
        // Solidity has no array-assign-from-calldata; rebuild in place.
        uint256 oldLen = list.length;
        for (uint256 i; i < n; ++i) {
            if (i < oldLen) list[i] = assets[i];
            else list.push(assets[i]);
        }
        for (uint256 k = oldLen; k > n; --k) list.pop();
        emit PaaAssetsSet(n);
    }

    /// @notice Off-chain liquidity-confidence relay write (§4.1.b item 2)
    ///         — re-rate `asset` to `tier` (1..3). `effectiveTier(asset)
    ///         = min(getLiquidityTier(asset), tier)`, so this can only
    ///         ever *lower* an asset's effective tier toward the
    ///         no-keeper Tier-1 baseline, never raise it above the
    ///         on-chain ceiling; a compromised `KEEPER_ROLE` key is
    ///         bounded accordingly. The relay promotes one step at a time
    ///         on accumulated 0x/1inch confidence and demotes immediately
    ///         on observed degradation (the process is §4.4 step 5).
    /// @dev    KEEPER_ROLE-only (admin = DEFAULT_ADMIN_ROLE → governance
    ///         can rotate the keeper EOA). `tier == 0` is rejected — the
    ///         stored-zero default already reads as Tier 1, and demoting
    ///         *below* the no-keeper baseline isn't a thing (use
    ///         `AdminFacet.pauseAsset` to take an asset out entirely).
    function setKeeperTier(address asset, uint8 tier)
        external
        onlyRole(LibAccessControl.KEEPER_ROLE)
    {
        if (asset == address(0)) revert IVaipakamErrors.InvalidAsset();
        if (tier == 0 || tier > LibVaipakam.MAX_LIQUIDITY_TIER) revert InvalidLiquidityTier(tier);
        LibVaipakam.storageSlot().keeperTier[asset] = tier;
        emit KeeperTierSet(asset, tier);
    }

    /// ─── Getters (effective values: override OR default) ────────────

    /// @notice Two-fee getter used by the frontend fee hints and pricing previews.
    function getFeesConfig()
        external
        view
        returns (uint256 treasuryFeeBps, uint256 loanInitiationFeeBps)
    {
        treasuryFeeBps = LibVaipakam.cfgTreasuryFeeBps();
        loanInitiationFeeBps = LibVaipakam.cfgLoanInitiationFeeBps();
    }

    function getLiquidationConfig()
        external
        view
        returns (uint256 handlingFeeBps, uint256 maxSlippageBps, uint256 maxIncentiveBps)
    {
        handlingFeeBps = LibVaipakam.cfgLiquidationHandlingFeeBps();
        maxSlippageBps = LibVaipakam.cfgMaxLiquidationSlippageBps();
        maxIncentiveBps = LibVaipakam.cfgMaxLiquidatorIncentiveBps();
    }

    function getRiskConfig()
        external
        view
        returns (uint256 volatilityLtvThresholdBps, uint256 rentalBufferBps)
    {
        volatilityLtvThresholdBps = LibVaipakam.cfgVolatilityLtvThresholdBps();
        rentalBufferBps = LibVaipakam.cfgRentalBufferBps();
    }

    function getStakingAprBps() external view returns (uint256) {
        return LibVaipakam.cfgVpfiStakingAprBps();
    }

    /// @notice Single-field getter for the treasury fee. Mirrors the
    ///         tuple-returning {getFeesConfig} but returns just the
    ///         treasury slice. Added for the protocol console knob
    ///         schema, which expects per-knob single-value getters.
    function getTreasuryFeeBps() external view returns (uint256) {
        return LibVaipakam.cfgTreasuryFeeBps();
    }

    /// @notice Single-field getter for the loan-initiation fee.
    ///         Companion of {getTreasuryFeeBps}; same rationale.
    function getLoanInitiationFeeBps() external view returns (uint256) {
        return LibVaipakam.cfgLoanInitiationFeeBps();
    }

    /// @notice Single-field getter for the LIF matcher fee (1% kickback
    ///         to the matcher on each successful match).
    function getLifMatcherFeeBps() external view returns (uint256) {
        return LibVaipakam.cfgLifMatcherFeeBps();
    }

    /// @notice Single-field getter for the rangeAmount master flag.
    ///         Mirrors {getMasterFlags}'s first return value. Added for
    ///         the protocol-console knob schema.
    function getRangeAmountEnabled() external view returns (bool) {
        return LibVaipakam.storageSlot().protocolCfg.rangeAmountEnabled;
    }

    /// @notice Single-field getter for the rangeRate master flag.
    function getRangeRateEnabled() external view returns (bool) {
        return LibVaipakam.storageSlot().protocolCfg.rangeRateEnabled;
    }

    /// @notice Single-field getter for the partialFill master flag.
    function getPartialFillEnabled() external view returns (bool) {
        return LibVaipakam.storageSlot().protocolCfg.partialFillEnabled;
    }

    /// @notice Current effective fallback-path split. Each value is in BPS
    ///         of principal. These are the **live** values — the UI should
    ///         use them when showing "what terms would apply to a new
    ///         loan?". For a specific existing loan, the snapshotted values
    ///         on the `Loan` struct are authoritative (prospective).
    function getFallbackSplit()
        external
        view
        returns (uint256 lenderBonusBps, uint256 treasuryBps)
    {
        lenderBonusBps = LibVaipakam.cfgFallbackLenderBonusBps();
        treasuryBps = LibVaipakam.cfgFallbackTreasuryBps();
    }

    function getVpfiTierThresholds()
        external
        view
        returns (uint256 t1, uint256 t2, uint256 t3, uint256 t4)
    {
        return LibVaipakam.cfgVpfiTierThresholds();
    }

    function getVpfiTierDiscountBps()
        external
        view
        returns (uint256 t1, uint256 t2, uint256 t3, uint256 t4)
    {
        t1 = LibVaipakam.cfgVpfiTierDiscountBps(1);
        t2 = LibVaipakam.cfgVpfiTierDiscountBps(2);
        t3 = LibVaipakam.cfgVpfiTierDiscountBps(3);
        t4 = LibVaipakam.cfgVpfiTierDiscountBps(4);
    }

    /// @notice Range Orders Phase 1 master kill-switch flags. All three
    ///         default `false` on a fresh deploy. Flipped on by governance
    ///         after the testnet bake. Frontend reads via the bundle
    ///         below or these direct getters; conditional render of the
    ///         range / partial-fill UI gates on these values.
    function getMasterFlags()
        external
        view
        returns (bool rangeAmount, bool rangeRate, bool partialFill)
    {
        LibVaipakam.ProtocolConfig storage c = LibVaipakam.storageSlot().protocolCfg;
        rangeAmount = c.rangeAmountEnabled;
        rangeRate = c.rangeRateEnabled;
        partialFill = c.partialFillEnabled;
    }

    /// ─── Depth-tiered LTV (Piece B) — getters ───────────────────────

    /// @notice Single-field getter for the depth-tiered-LTV master flag.
    ///         Mirrors {getRangeAmountEnabled} & co. for the
    ///         protocol-console knob schema.
    function getDepthTieredLtvEnabled() external view returns (bool) {
        return LibVaipakam.storageSlot().protocolCfg.depthTieredLtvEnabled;
    }

    /// @notice The PAA list — the per-chain quote tokens the depth-tier
    ///         route search probes. Empty config resolves to
    ///         `[wethContract]` (the {LibVaipakam.effectivePaaAssets}
    ///         fallback) — this getter returns that *resolved* list, so
    ///         the frontend never sees a misleading empty array.
    function getPaaAssets() external view returns (address[] memory) {
        return LibVaipakam.effectivePaaAssets();
    }

    /// @notice The *effective* keeper-confidence tier for `asset`
    ///         (1..3) — stored-zero reads as Tier 1, matching how
    ///         `OracleFacet.getEffectiveLiquidityTier` resolves it.
    function getKeeperTier(address asset) external view returns (uint8) {
        if (asset == address(0)) return 0;
        return LibVaipakam.effectiveKeeperTier(asset);
    }

    /// @notice One-call bundle of the depth-tier governance globals for
    ///         the frontend (`useProtocolConfig` reads this alongside
    ///         {getProtocolConfigBundle} + {getPaaAssets}). Kept separate
    ///         from {getProtocolConfigBundle} so neither tuple grows
    ///         unwieldy. Every value is the *effective* one
    ///         (override-OR-default); sizes are PAD × 1e6 units.
    function getDepthTierConfigBundle()
        external
        view
        returns (
            bool depthTieredLtvEnabled,
            uint256 liquiditySlippageBps,
            uint256 twapWindowSec,
            uint256 twapConsistencyBps,
            uint256 floorSizePad,
            uint256 tier1SizePad,
            uint256 tier2SizePad,
            uint256 tier3SizePad,
            uint256 tier1MaxInitLtvBps,
            uint256 tier2MaxInitLtvBps,
            uint256 tier3MaxInitLtvBps
        )
    {
        depthTieredLtvEnabled = LibVaipakam.cfgDepthTieredLtvEnabled();
        liquiditySlippageBps = LibVaipakam.cfgLiquiditySlippageBps();
        twapWindowSec = LibVaipakam.cfgTwapWindowSec();
        twapConsistencyBps = LibVaipakam.cfgTwapConsistencyBps();
        floorSizePad = LibVaipakam.cfgFloorSizePad();
        tier1SizePad = LibVaipakam.cfgTier1SizePad();
        tier2SizePad = LibVaipakam.cfgTier2SizePad();
        tier3SizePad = LibVaipakam.cfgTier3SizePad();
        tier1MaxInitLtvBps = LibVaipakam.cfgTier1MaxInitLtvBps();
        tier2MaxInitLtvBps = LibVaipakam.cfgTier2MaxInitLtvBps();
        tier3MaxInitLtvBps = LibVaipakam.cfgTier3MaxInitLtvBps();
    }

    /// @notice Single-call bundle for the frontend — returns every
    ///         config knob the UI needs to render fee hints, tier
    ///         tables and risk disclosures.
    function getProtocolConfigBundle()
        external
        view
        returns (
            uint256 treasuryFeeBps,
            uint256 loanInitiationFeeBps,
            uint256 liquidationHandlingFeeBps,
            uint256 maxLiquidationSlippageBps,
            uint256 maxLiquidatorIncentiveBps,
            uint256 volatilityLtvThresholdBps,
            uint256 rentalBufferBps,
            uint256 vpfiStakingAprBps,
            uint256[4] memory tierThresholds,
            uint256[4] memory tierDiscountBps,
            // Range Orders Phase 1 master kill-switch flags. Frontend
            // conditionals + Advanced-mode reveals for range sliders /
            // partial-fill checkbox gate on these. See §15 of design doc.
            bool rangeAmountEnabled,
            bool rangeRateEnabled,
            bool partialFillEnabled,
            // Matcher's slice of the LIF kickback (BPS).
            // Governance-tunable via `setLifMatcherFeeBps`; default
            // 100 (1%). Frontend uses this to render bot-economics
            // copy on the matcher dashboard.
            uint256 lifMatcherFeeBps,
            // Auto-pause window duration (seconds). Governance-tunable
            // via `setAutoPauseDurationSeconds` within [5min, 2h];
            // default 1800 (30 min). Frontend renders countdown +
            // policy disclosure against this.
            uint256 autoPauseDurationSeconds,
            // Maximum loan duration in days that `createOffer` accepts.
            // Governance-tunable via `setMaxOfferDurationDays` within
            // [7d, 5y]; default 365 days. Frontend's offer-creation
            // duration input enforces this so users don't get a
            // server-side revert on submit.
            uint256 maxOfferDurationDays
        )
    {
        treasuryFeeBps = LibVaipakam.cfgTreasuryFeeBps();
        loanInitiationFeeBps = LibVaipakam.cfgLoanInitiationFeeBps();
        liquidationHandlingFeeBps = LibVaipakam.cfgLiquidationHandlingFeeBps();
        maxLiquidationSlippageBps = LibVaipakam.cfgMaxLiquidationSlippageBps();
        maxLiquidatorIncentiveBps = LibVaipakam.cfgMaxLiquidatorIncentiveBps();
        volatilityLtvThresholdBps = LibVaipakam.cfgVolatilityLtvThresholdBps();
        rentalBufferBps = LibVaipakam.cfgRentalBufferBps();
        vpfiStakingAprBps = LibVaipakam.cfgVpfiStakingAprBps();
        (uint256 a, uint256 b, uint256 c, uint256 d) = LibVaipakam.cfgVpfiTierThresholds();
        tierThresholds = [a, b, c, d];
        tierDiscountBps = [
            LibVaipakam.cfgVpfiTierDiscountBps(1),
            LibVaipakam.cfgVpfiTierDiscountBps(2),
            LibVaipakam.cfgVpfiTierDiscountBps(3),
            LibVaipakam.cfgVpfiTierDiscountBps(4)
        ];
        LibVaipakam.ProtocolConfig storage cfg = LibVaipakam.storageSlot().protocolCfg;
        rangeAmountEnabled = cfg.rangeAmountEnabled;
        rangeRateEnabled = cfg.rangeRateEnabled;
        partialFillEnabled = cfg.partialFillEnabled;
        lifMatcherFeeBps = LibVaipakam.cfgLifMatcherFeeBps();
        autoPauseDurationSeconds = LibVaipakam.cfgAutoPauseDurationSeconds();
        maxOfferDurationDays = LibVaipakam.cfgMaxOfferDurationDays();
    }

    /// @notice Read-only bundle of protocol-wide compile-time constants
    ///         that surface in user-facing copy. Returned via a single
    ///         RPC so frontends never have to hardcode these values
    ///         (and so the UI auto-tracks any future contract redeploy
    ///         that bumps a constant).
    /// @dev    These are `constant` declarations in {LibVaipakam}, NOT
    ///         governance-mutable storage — there's no setter pair and
    ///         the values are baked into bytecode. The view exists
    ///         purely to give the frontend a single source of truth so
    ///         tooltip / explainer copy never drifts from the deployed
    ///         contract. For governance-mutable values (treasury fee,
    ///         tier thresholds, staking APR, ...) use
    ///         {getProtocolConfigBundle}.
    /// @return minHealthFactor       1e18-scaled HF floor at loan
    ///                               initiation and after partial-
    ///                               withdrawal / cure / refinance.
    /// @return vpfiStakingPoolCap    Hard cap on the staking-rewards
    ///                               pool (55.2M VPFI = 24% of total).
    /// @return vpfiInteractionPoolCap Hard cap on the interaction-
    ///                               rewards pool (69M VPFI = 30%).
    /// @return maxInteractionClaimDays Per-tx upper bound on the days
    ///                               an interaction-rewards claim can
    ///                               walk in one window (split across
    ///                               multiple claims if it'd otherwise
    ///                               exceed this).
    function getProtocolConstants()
        external
        pure
        returns (
            uint256 minHealthFactor,
            uint256 vpfiStakingPoolCap,
            uint256 vpfiInteractionPoolCap,
            uint256 maxInteractionClaimDays
        )
    {
        return (
            LibVaipakam.MIN_HEALTH_FACTOR,
            LibVaipakam.VPFI_STAKING_POOL_CAP,
            LibVaipakam.VPFI_INTERACTION_POOL_CAP,
            LibVaipakam.MAX_INTERACTION_CLAIM_DAYS
        );
    }

    /**
     * @notice Replace the duration-tiered grace-period schedule used by
     *         DefaultedFacet / RepayFacet / RiskFacet. T-044 — fixed
     *         6-slot positional table. Caller MUST supply exactly
     *         `GRACE_BUCKETS_FIXED_COUNT` entries; each slot's values
     *         must lie inside the per-slot bounds returned by
     *         `LibVaipakam.graceSlotBounds(slot)`.
     * @dev ADMIN_ROLE-only. Validation surface:
     *      - `buckets.length == GRACE_BUCKETS_FIXED_COUNT` (no add /
     *        remove rows; admin can only edit values inside fixed slots).
     *      - For each slot 0..4 (non-catch-all):
     *          - `maxDurationDays` ∈ slot's `[minDays, maxDays]` window.
     *          - Strictly ascending vs. previous slot's `maxDurationDays`.
     *      - For slot 5 (catch-all): `maxDurationDays == 0` enforced.
     *      - For every slot: `graceSeconds` ∈ slot's `[minGrace, maxGrace]`
     *        window AND inside the global `[GRACE_SECONDS_MIN,
     *        GRACE_SECONDS_MAX]` floor / ceiling (defense in depth).
     *      Per-slot bounds defend against a compromised admin pushing
     *      a single slot to either extreme — same policy as
     *      setStakingApr, setSecondaryOracleMaxStaleness, etc. (T-033).
     * @param buckets New schedule. Order matters; rejected if invalid.
     */
    function setGraceBuckets(
        LibVaipakam.GraceBucket[] calldata buckets
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        uint256 n = buckets.length;
        if (n != LibVaipakam.GRACE_BUCKETS_FIXED_COUNT) {
            revert GraceBucketsInvalid("wrong-count");
        }
        // Per-slot positional validation. Each slot has its own
        // [minDays, maxDays] for the threshold AND its own
        // [minGrace, maxGrace] for the grace period. The bounds come
        // from the policy table in LibVaipakam.graceSlotBounds.
        uint256 prevDays = 0;
        for (uint256 i = 0; i < n; i++) {
            (
                uint256 minDays,
                uint256 maxDays,
                uint256 minGrace,
                uint256 maxGrace
            ) = LibVaipakam.graceSlotBounds(i);
            uint256 d = buckets[i].maxDurationDays;
            uint256 g = buckets[i].graceSeconds;

            // Slot 5 — catch-all. Enforce `maxDurationDays == 0`. Any
            // non-zero would push it into the lookup-by-duration path
            // below, breaking the "covers any loan length" semantic.
            // graceSlotBounds returns (0, 0, ...) for slot 5 so the
            // generic check below would also reject it, but the
            // dedicated message here surfaces the cause clearly.
            if (i == LibVaipakam.GRACE_BUCKETS_FIXED_COUNT - 1) {
                if (d != 0) revert GraceBucketsInvalid("catchall-not-zero");
            } else {
                // Non-catch-all slots: validate the day threshold.
                if (d < minDays || d > maxDays) {
                    revert IVaipakamErrors.ParameterOutOfRange(
                        "graceBucketMaxDurationDays",
                        d,
                        minDays,
                        maxDays
                    );
                }
                if (d <= prevDays) {
                    revert GraceBucketsInvalid("not-monotonic");
                }
                prevDays = d;
            }
            // Grace bound — both layers (per-slot + global) must hold.
            if (g < minGrace || g > maxGrace) {
                revert IVaipakamErrors.ParameterOutOfRange(
                    "graceBucketSeconds",
                    g,
                    minGrace,
                    maxGrace
                );
            }
            if (
                g < LibVaipakam.GRACE_SECONDS_MIN ||
                g > LibVaipakam.GRACE_SECONDS_MAX
            ) {
                revert IVaipakamErrors.ParameterOutOfRange(
                    "graceSecondsGlobalBound",
                    g,
                    LibVaipakam.GRACE_SECONDS_MIN,
                    LibVaipakam.GRACE_SECONDS_MAX
                );
            }
        }
        // Atomic replace. Solidity-0.8 storage-array writes from
        // calldata-iter pop+push are the safe primitive.
        LibVaipakam.GraceBucket[] storage dst = LibVaipakam
            .storageSlot()
            .graceBuckets;
        while (dst.length > 0) dst.pop();
        for (uint256 i = 0; i < n; i++) {
            dst.push(buckets[i]);
        }
        emit GraceBucketsUpdated(n);
    }

    /**
     * @notice Drop the configured schedule, reverting to the compile-
     *         time defaults baked into `LibVaipakam.gracePeriod()`.
     * @dev ADMIN_ROLE-only. Useful as an emergency rollback if a bad
     *      schedule was pushed by mistake — the defaults are always
     *      safe and well-tested.
     */
    function clearGraceBuckets() external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.GraceBucket[] storage dst = LibVaipakam
            .storageSlot()
            .graceBuckets;
        while (dst.length > 0) dst.pop();
        emit GraceBucketsUpdated(0);
    }

    /**
     * @notice Read the current grace-bucket schedule.
     * @return buckets The configured array. Empty when the protocol is
     *         using the compile-time defaults — caller can detect this
     *         via `buckets.length == 0`.
     */
    function getGraceBuckets()
        external
        view
        returns (LibVaipakam.GraceBucket[] memory buckets)
    {
        return LibVaipakam.getGraceBucketsConfigured();
    }

    /**
     * @notice Convenience view exposing the current effective grace
     *         period for a given duration. Reads through the same
     *         path DefaultedFacet uses, so the admin console can
     *         display "what would happen for a 90-day loan" without
     *         re-implementing the lookup logic.
     * @param durationDays Loan duration in days.
     * @return graceSeconds Effective grace, in seconds.
     */
    function getEffectiveGraceSeconds(
        uint256 durationDays
    ) external view returns (uint256 graceSeconds) {
        return LibVaipakam.gracePeriod(durationDays);
    }

    /**
     * @notice Per-slot policy bounds the admin console renders next to
     *         each editable row. Mirrors the table in
     *         {LibVaipakam.graceSlotBounds}. Returned in slot order
     *         (0..GRACE_BUCKETS_FIXED_COUNT-1). For the catch-all slot
     *         (last index), `minDays[i] == maxDays[i] == 0` (the only
     *         legal value is 0).
     * @return minDays  Per-slot lower bound on `maxDurationDays`.
     * @return maxDays  Per-slot upper bound on `maxDurationDays`.
     * @return minGrace Per-slot lower bound on `graceSeconds`.
     * @return maxGrace Per-slot upper bound on `graceSeconds`.
     */
    function getGraceSlotBounds()
        external
        pure
        returns (
            uint256[] memory minDays,
            uint256[] memory maxDays,
            uint256[] memory minGrace,
            uint256[] memory maxGrace
        )
    {
        uint256 n = LibVaipakam.GRACE_BUCKETS_FIXED_COUNT;
        minDays = new uint256[](n);
        maxDays = new uint256[](n);
        minGrace = new uint256[](n);
        maxGrace = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            (
                minDays[i],
                maxDays[i],
                minGrace[i],
                maxGrace[i]
            ) = LibVaipakam.graceSlotBounds(i);
        }
    }

    // ── T-034 — Periodic Interest Payment setters + getters ──────────────
    // See docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md
    // §6 (numeraire abstraction), §10 (kill-switches).

    /// @notice Emitted when the numeraire address AND its companion
    ///         threshold value flip atomically via {setNumeraire}.
    /// @notice Emitted on every atomic numeraire rotation. After
    ///         Numeraire generalization (B1), the numeraire is identified by its
    ///         feed-side config (ETH/<numeraire> Chainlink feed +
    ///         lowercase ASCII symbol that drives Tellor/API3/DIA
    ///         queries) — there is no longer a single numeraireOracle
    ///         contract. Off-chain monitors index `numeraireSymbol` to
    ///         identify which currency the rotation targets ("usd",
    ///         "eur", "xau", etc.).
    /// @param oldEthFeed Previous ETH/<numeraire> Chainlink feed.
    /// @param newEthFeed New ETH/<numeraire> Chainlink feed.
    /// @param numeraireSymbol Lowercase ASCII symbol of the new
    ///        numeraire (e.g. `bytes32("eur")`).
    /// @custom:event-category informational/config
    event NumeraireUpdated(
        address indexed oldEthFeed,
        address indexed newEthFeed,
        bytes32 numeraireSymbol
    );

    /// @notice Emitted when the principal threshold for finer cadences
    ///         is updated within the same numeraire.
    /// @custom:event-category informational/config
    event MinPrincipalForFinerCadenceSet(uint256 newThreshold);

    /// @notice Emitted when the shared maturity / periodic-checkpoint
    ///         pre-notify lead time is updated.
    /// @custom:event-category informational/config
    event PreNotifyDaysSet(uint8 newDays);

    /// @notice Emitted when the master kill-switch for the entire
    ///         Periodic Interest Payment mechanic is toggled.
    /// @custom:event-category informational/config
    event PeriodicInterestEnabledSet(bool enabled);

    /// @notice Emitted when the cross-numeraire swap kill-switch is
    ///         toggled.
    /// @custom:event-category informational/config
    event NumeraireSwapEnabledSet(bool enabled);

    /// @notice T-034 Numeraire generalization (B1) — atomic numeraire rotation.
    ///         The struct carries ALL state that defines the protocol's
    ///         reference currency at once. By construction, governance
    ///         cannot rotate the numeraire without simultaneously
    ///         re-anchoring every value denominated in it AND every
    ///         oracle-side input that produces numeraire-quoted prices.
    ///
    ///         Inconsistent intermediate state ("numeraire = EUR but
    ///         notification fee still in USD-units" or "Tellor still
    ///         queries `<symbol>/usd`") is unreachable.
    /// @param ethNumeraireFeed Chainlink ETH/<numeraire> AggregatorV3.
    ///        ETH/USD by default; rotates to ETH/EUR / ETH/XAU / etc.
    ///        as the numeraire changes. Zero address rejected.
    /// @param numeraireChainlinkDenominator Chainlink Feed Registry
    ///        constant for the active numeraire (e.g. `Denominations.USD`,
    ///        `Denominations.EUR`). Drives Path 2 of `_primaryPrice`
    ///        (direct asset/<numeraire> registry lookup). Zero rejected.
    /// @param numeraireSymbol Lowercase ASCII bytes32 of the numeraire's
    ///        symbol (e.g. `bytes32("usd")`, `bytes32("eur")`). Drives
    ///        Tellor / API3 / DIA query construction. Zero rejected.
    /// @param pythCrossCheckFeedId Pyth ETH/<numeraire> feed id for the
    ///        T-033 cross-check gate. Zero is acceptable (disables the
    ///        Pyth gate — soft-skip behaviour).
    /// @param newThresholdInNewNumeraire Finer-cadence principal
    ///        threshold in numeraire-units (1e18-scaled). 0 ⇒ default.
    /// @param newNotificationFeeInNewNumeraire Per-loan-side
    ///        notification fee in numeraire-units (1e18-scaled). 0 ⇒
    ///        default.
    /// @param newKycTier0InNewNumeraire KYC Tier-0 threshold in
    ///        numeraire-units (1e18-scaled). 0 ⇒ default. MUST be <
    ///        `newKycTier1InNewNumeraire` when both non-zero.
    /// @param newKycTier1InNewNumeraire KYC Tier-1 threshold in
    ///        numeraire-units (1e18-scaled). 0 ⇒ default.
    function setNumeraire(
        address ethNumeraireFeed,
        address numeraireChainlinkDenominator,
        bytes32 numeraireSymbol,
        bytes32 pythCrossCheckFeedId,
        uint256 newThresholdInNewNumeraire,
        uint256 newNotificationFeeInNewNumeraire,
        uint256 newKycTier0InNewNumeraire,
        uint256 newKycTier1InNewNumeraire
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.ProtocolConfig storage c =
            LibVaipakam.storageSlot().protocolCfg;
        if (!c.numeraireSwapEnabled) revert IVaipakamErrors.NumeraireSwapDisabled();

        // The three feed-side inputs are load-bearing — without them,
        // `_primaryPrice` and the secondary-quorum query construction
        // would break.
        if (ethNumeraireFeed == address(0)) revert IVaipakamErrors.InvalidAddress();
        if (numeraireChainlinkDenominator == address(0))
            revert IVaipakamErrors.InvalidAddress();
        if (numeraireSymbol == bytes32(0))
            revert IVaipakamErrors.ParameterOutOfRange(
                bytes32("numeraireSymbol"), 0, 1, type(uint256).max
            );

        // Range checks per value knob — zero accepted as "reset to default".
        if (
            newThresholdInNewNumeraire != 0 &&
            (
                newThresholdInNewNumeraire <
                    LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_FLOOR ||
                newThresholdInNewNumeraire >
                    LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_CEIL
            )
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                bytes32("minPrincipalForFinerCadence"),
                newThresholdInNewNumeraire,
                LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_FLOOR,
                LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_CEIL
            );
        }
        if (
            newNotificationFeeInNewNumeraire != 0 &&
            (
                newNotificationFeeInNewNumeraire < LibVaipakam.MIN_NOTIFICATION_FEE_FLOOR ||
                newNotificationFeeInNewNumeraire > LibVaipakam.MAX_NOTIFICATION_FEE_CEIL
            )
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                bytes32("notificationFee"),
                newNotificationFeeInNewNumeraire,
                LibVaipakam.MIN_NOTIFICATION_FEE_FLOOR,
                LibVaipakam.MAX_NOTIFICATION_FEE_CEIL
            );
        }
        // KYC tier monotonicity — only enforce when both are non-zero
        // (zero pair = "reset both to defaults", which the lib defaults
        // satisfy by construction).
        if (
            newKycTier0InNewNumeraire != 0 &&
            newKycTier1InNewNumeraire != 0 &&
            newKycTier0InNewNumeraire >= newKycTier1InNewNumeraire
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                bytes32("kycTier0VsTier1"),
                newKycTier0InNewNumeraire,
                0,
                newKycTier1InNewNumeraire
            );
        }
        if (
            newKycTier0InNewNumeraire != 0 &&
            (
                newKycTier0InNewNumeraire < LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MIN_FLOOR ||
                newKycTier0InNewNumeraire > LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MAX_CEIL
            )
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                bytes32("kycTier0ThresholdNumeraire"),
                newKycTier0InNewNumeraire,
                LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MIN_FLOOR,
                LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MAX_CEIL
            );
        }
        if (
            newKycTier1InNewNumeraire != 0 &&
            (
                newKycTier1InNewNumeraire < LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MIN_FLOOR ||
                newKycTier1InNewNumeraire > LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MAX_CEIL
            )
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                bytes32("kycTier1ThresholdNumeraire"),
                newKycTier1InNewNumeraire,
                LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MIN_FLOOR,
                LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MAX_CEIL
            );
        }

        // Atomic write: feed-side first (so any subsequent oracle read
        // in the same tx sees the new state), then value-side.
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address oldEthFeed = s.ethNumeraireFeed;
        s.ethNumeraireFeed = ethNumeraireFeed;
        s.numeraireChainlinkDenominator = numeraireChainlinkDenominator;
        s.numeraireSymbol = numeraireSymbol;
        s.pythCrossCheckFeedId = pythCrossCheckFeedId;
        c.minPrincipalForFinerCadence = newThresholdInNewNumeraire;
        c.notificationFee = newNotificationFeeInNewNumeraire;
        s.kycTier0ThresholdNumeraire = newKycTier0InNewNumeraire;
        s.kycTier1ThresholdNumeraire = newKycTier1InNewNumeraire;
        emit NumeraireUpdated(oldEthFeed, ethNumeraireFeed, numeraireSymbol);
    }

    /// @notice Update only the principal threshold for finer cadences,
    ///         within the same numeraire. NOT gated by
    ///         `numeraireSwapEnabled` — governance can tune the
    ///         threshold without unlocking numeraire swap.
    /// @dev Range `[FLOOR, CEIL]`; zero accepted as "reset to default".
    /// @param newThreshold Threshold in numeraire-units (1e18-scaled).
    function setMinPrincipalForFinerCadence(uint256 newThreshold)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (
            newThreshold != 0 &&
            (
                newThreshold <
                    LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_FLOOR ||
                newThreshold >
                    LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_CEIL
            )
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                bytes32("minPrincipalForFinerCadence"),
                newThreshold,
                LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_FLOOR,
                LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_CEIL
            );
        }
        LibVaipakam.storageSlot().protocolCfg.minPrincipalForFinerCadence = newThreshold;
        emit MinPrincipalForFinerCadenceSet(newThreshold);
    }

    /// @notice Update the shared pre-notify lead time (days) consumed
    ///         by the off-chain hf-watcher for both maturity and
    ///         periodic-checkpoint pre-notify lanes.
    /// @dev Range `[FLOOR, CEIL]`; zero accepted as "reset to default".
    /// @param newDays Lead time in days; pass `0` to reset.
    function setPreNotifyDays(uint8 newDays)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (
            newDays != 0 &&
            (
                newDays < LibVaipakam.PERIODIC_PRE_NOTIFY_DAYS_FLOOR ||
                newDays > LibVaipakam.PERIODIC_PRE_NOTIFY_DAYS_CEIL
            )
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                bytes32("preNotifyDays"),
                uint256(newDays),
                uint256(LibVaipakam.PERIODIC_PRE_NOTIFY_DAYS_FLOOR),
                uint256(LibVaipakam.PERIODIC_PRE_NOTIFY_DAYS_CEIL)
            );
        }
        LibVaipakam.storageSlot().protocolCfg.preNotifyDays = newDays;
        emit PreNotifyDaysSet(newDays);
    }

    /// @notice Master kill-switch for the entire Periodic Interest
    ///         Payment mechanic. Default `false` — feature ships
    ///         dormant; flipped on by governance when ready.
    function setPeriodicInterestEnabled(bool enabled)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.periodicInterestEnabled = enabled;
        emit PeriodicInterestEnabledSet(enabled);
    }

    /// @notice Independent kill-switch gating the cross-numeraire
    ///         batched setter `setNumeraire`. Default `false` — a
    ///         fresh deploy ships USD-as-numeraire and governance
    ///         cannot rotate to a different numeraire until this
    ///         flag flips.
    function setNumeraireSwapEnabled(bool enabled)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.numeraireSwapEnabled = enabled;
        emit NumeraireSwapEnabledSet(enabled);
    }

    /// @notice Individual getter for `numeraireSymbol` — the lowercase
    ///         ASCII bytes32 symbol of the active numeraire (e.g.
    ///         `bytes32("usd")`, `bytes32("eur")`). Empty bytes32
    ///         indicates the post-deploy default ("usd"). Frontend
    ///         knob card reads this for currency labels.
    function getNumeraireSymbol() external view returns (bytes32) {
        return LibVaipakam.storageSlot().numeraireSymbol;
    }

    /// @notice Individual getter for `ethNumeraireFeed` — the
    ///         Chainlink ETH/<numeraire> AggregatorV3 address.
    function getEthNumeraireFeed() external view returns (address) {
        return LibVaipakam.storageSlot().ethNumeraireFeed;
    }

    // ─── T-048 — Predominantly Available Denominator (PAD) ─────────────

    /// @notice Emitted when governance rotates the PAD config. Indexes
    ///         the old → new denominator transition for off-chain
    ///         monitoring; the symbol + feeds are non-indexed because
    ///         most chains will never rotate (PAD stays at USD).
    /// @custom:event-category informational/config
    event PredominantDenominatorUpdated(
        address indexed oldDenominator,
        address indexed newDenominator,
        bytes32 newSymbol,
        address newEthPadFeed,
        address newPadNumeraireRateFeed
    );

    /// @notice Emitted when governance sets / clears a per-asset
    ///         numeraire-direct feed override.
    /// @custom:event-category informational/config
    event AssetNumeraireDirectFeedOverrideSet(
        address indexed asset,
        address indexed previous,
        address indexed next
    );

    /// @notice Atomic rotation of the Predominantly Available
    ///         Denominator config — all four slots in one tx so the
    ///         PAD identity is never half-rotated. PAD is the
    ///         universally-covered Chainlink denomination
    ///         (`Denominations.USD` by post-deploy default) the
    ///         protocol pivots through when the active numeraire is
    ///         non-USD. See README §16 / docs/AdminConfigurableKnobsAndSwitches.md.
    /// @dev    Admin-only. The setter accepts:
    ///          - `newDenominator`: the Chainlink Feed Registry
    ///            denomination constant (e.g.
    ///            `0x0000…0000348` for USD). Must be non-zero;
    ///            zeroing the slot would disable the PAD pivot
    ///            entirely and is reachable only via a governance
    ///            decision to revert to a pre-T-048 deploy shape
    ///            (use `clearPredominantDenominator` for that).
    ///          - `newSymbol`: lowercase ASCII bytes32 (e.g.
    ///            `bytes32("usd")`) for symbol-derived secondary
    ///            oracles. Empty bytes32 is interpreted as `"usd"`.
    ///          - `newEthPadFeed`: Chainlink ETH/<PAD> AggregatorV3.
    ///            REQUIRED on every chain because it's the load-
    ///            bearing leg of (a) WETH pricing and (b) the
    ///            derived PAD/<numeraire> rate. Must be non-zero.
    ///          - `newPadNumeraireRateFeed`: optional Chainlink
    ///            PAD/<numeraire> AggregatorV3 (e.g. USD/EUR on
    ///            mainnet). Zero is valid — the protocol derives the
    ///            rate from `ethNumeraireFeed ÷ ethPadFeed`.
    function setPredominantDenominator(
        address newDenominator,
        bytes32 newSymbol,
        address newEthPadFeed,
        address newPadNumeraireRateFeed
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (newDenominator == address(0)) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "predominantDenominator",
                0,
                1,
                type(uint256).max
            );
        }
        if (newEthPadFeed == address(0)) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "ethPadFeed",
                0,
                1,
                type(uint256).max
            );
        }

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address oldDenominator = s.predominantDenominator;
        s.predominantDenominator = newDenominator;
        s.predominantDenominatorSymbol = newSymbol;
        s.ethPadFeed = newEthPadFeed;
        s.padNumeraireRateFeed = newPadNumeraireRateFeed;

        emit PredominantDenominatorUpdated(
            oldDenominator,
            newDenominator,
            newSymbol,
            newEthPadFeed,
            newPadNumeraireRateFeed
        );
    }

    /// @notice Set / clear a per-asset numeraire-direct feed override.
    ///         When set non-zero, `OracleFacet._primaryPrice` reads
    ///         this Chainlink feed directly as the asset's
    ///         numeraire-quoted price and skips the PAD pivot.
    ///         Operator vouches the feed is verified-rated; the
    ///         protocol does NOT cross-check it against Pyth.
    /// @dev    Pass `address(0)` to clear and revert to PAD-pivot
    ///         behaviour for that asset. Admin-only.
    function setAssetNumeraireDirectFeedOverride(address asset, address feed)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (asset == address(0)) revert IVaipakamErrors.InvalidAsset();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address previous = s.assetNumeraireDirectFeedOverride[asset];
        s.assetNumeraireDirectFeedOverride[asset] = feed;
        emit AssetNumeraireDirectFeedOverrideSet(asset, previous, feed);
    }

    /// @notice Read the active PAD denomination — the Chainlink
    ///         Feed Registry denominator that `_primaryPrice` queries
    ///         first. Zero on a pre-T-048 deploy where PAD wasn't set
    ///         (legacy numeraire-direct path active).
    function getPredominantDenominator() external view returns (address) {
        return LibVaipakam.storageSlot().predominantDenominator;
    }

    /// @notice Read the active PAD symbol — bytes32 lowercase ASCII
    ///         used by symbol-derived secondary oracles when querying
    ///         asset/PAD pairs. Empty bytes32 (post-deploy default)
    ///         reads as `"usd"` per `LibVaipakam.effectivePadSymbol()`.
    function getPredominantDenominatorSymbol() external view returns (bytes32) {
        return LibVaipakam.storageSlot().predominantDenominatorSymbol;
    }

    /// @notice Read the Chainlink ETH/<PAD> AggregatorV3 address.
    ///         REQUIRED post-T-048; load-bearing for WETH pricing
    ///         and for the derived PAD/<numeraire> rate.
    function getEthPadFeed() external view returns (address) {
        return LibVaipakam.storageSlot().ethPadFeed;
    }

    /// @notice Read the optional Chainlink PAD/<numeraire>
    ///         AggregatorV3 address. Zero means the protocol derives
    ///         the FX rate from existing ETH-pivot feeds.
    function getPadNumeraireRateFeed() external view returns (address) {
        return LibVaipakam.storageSlot().padNumeraireRateFeed;
    }

    /// @notice Read the per-asset numeraire-direct feed override.
    ///         Zero means the asset routes through the PAD pivot.
    function getAssetNumeraireDirectFeedOverride(address asset)
        external
        view
        returns (address)
    {
        return LibVaipakam.storageSlot().assetNumeraireDirectFeedOverride[asset];
    }

    /// @notice Individual getter for `minPrincipalForFinerCadence`.
    ///         Returns the effective value (override or library default).
    function getMinPrincipalForFinerCadence() external view returns (uint256) {
        uint256 v = LibVaipakam.storageSlot().protocolCfg.minPrincipalForFinerCadence;
        return v == 0
            ? LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_DEFAULT
            : v;
    }

    /// @notice Individual getter for `preNotifyDays`. Returns the
    ///         effective value (override or library default).
    function getPreNotifyDays() external view returns (uint8) {
        uint8 v = LibVaipakam.storageSlot().protocolCfg.preNotifyDays;
        return v == 0 ? LibVaipakam.PERIODIC_PRE_NOTIFY_DAYS_DEFAULT : v;
    }

    /// @notice Individual getter for `periodicInterestEnabled` master
    ///         kill-switch. Cards / hooks that gate UI on the flag use
    ///         this rather than fan out the bundle.
    function getPeriodicInterestEnabled() external view returns (bool) {
        return LibVaipakam.storageSlot().protocolCfg.periodicInterestEnabled;
    }

    /// @notice Individual getter for `numeraireSwapEnabled` independent
    ///         kill-switch.
    function getNumeraireSwapEnabled() external view returns (bool) {
        return LibVaipakam.storageSlot().protocolCfg.numeraireSwapEnabled;
    }

    /// @notice Bundled getter for the entire T-034 config surface,
    ///         intended for the frontend `usePeriodicInterestConfig`
    ///         hook. Numeraire generalization (B1) — the per-knob `numeraireOracle`
    ///         field is gone; the numeraire identity is captured by
    ///         the symbol (`getNumeraireSymbol()`) + ETH feed
    ///         (`getEthNumeraireFeed()`) — both readable individually.
    /// @return symbol Lowercase ASCII bytes32 of the active numeraire.
    /// @return threshold The effective `minPrincipalForFinerCadence`
    ///         (override or library default), in numeraire-units.
    /// @return preNotify The effective `preNotifyDays` (override or
    ///         library default).
    /// @return periodicEnabled Master kill-switch state.
    /// @return numeraireSwapEnabled_ Numeraire-swap kill-switch state.
    function getPeriodicInterestConfig()
        external
        view
        returns (
            bytes32 symbol,
            uint256 threshold,
            uint8 preNotify,
            bool periodicEnabled,
            bool numeraireSwapEnabled_
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ProtocolConfig storage c = s.protocolCfg;
        symbol = s.numeraireSymbol;
        threshold = c.minPrincipalForFinerCadence == 0
            ? LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_DEFAULT
            : c.minPrincipalForFinerCadence;
        preNotify = c.preNotifyDays == 0
            ? LibVaipakam.PERIODIC_PRE_NOTIFY_DAYS_DEFAULT
            : c.preNotifyDays;
        periodicEnabled = c.periodicInterestEnabled;
        numeraireSwapEnabled_ = c.numeraireSwapEnabled;
    }
}
