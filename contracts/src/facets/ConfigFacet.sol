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

    /// ─── Events ─────────────────────────────────────────────────────
    event FeesConfigSet(uint16 treasuryFeeBps, uint16 loanInitiationFeeBps);
    event LiquidationConfigSet(
        uint16 handlingFeeBps,
        uint16 maxSlippageBps,
        uint16 maxIncentiveBps
    );
    event RiskConfigSet(uint16 volatilityLtvThresholdBps, uint16 rentalBufferBps);
    event StakingAprSet(uint16 aprBps);
    event VpfiTierThresholdsSet(uint256 t1, uint256 t2, uint256 t3, uint256 t4);
    event VpfiTierDiscountsSet(uint16 t1, uint16 t2, uint16 t3, uint16 t4);
    event FallbackSplitSet(uint16 lenderBonusBps, uint16 treasuryBps);
    // ── Range Orders Phase 1 master-flag setter events ──────────────────
    event RangeAmountEnabledSet(bool enabled);
    event RangeRateEnabledSet(bool enabled);
    event PartialFillEnabledSet(bool enabled);

    // ── T-044 — admin-configurable loan-default grace schedule ──────────
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
    // Fallback-split bounds: each party capped at 10% of principal, combined
    // (lender bonus + treasury) at 15%. These keep the borrower's remainder
    // meaningful even under the most adverse governance setting — a
    // theoretical abuse where a vote set both to 50% each would wipe out
    // the borrower's collateral recovery right, which is exactly the kind
    // of hostile-governance scenario the timelock + cap combo is for.
    uint16 private constant MAX_FALLBACK_BPS = 1_000;       // 10% per party
    uint16 private constant MAX_FALLBACK_COMBINED_BPS = 1_500; // 15% combined

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

    /// @notice Emitted on every change to the auto-pause window.
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
        if (rentalBufferBps > MAX_FEE_BPS) revert InvalidRentalBufferBps(rentalBufferBps);
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
    event NumeraireUpdated(
        address indexed oldEthFeed,
        address indexed newEthFeed,
        bytes32 numeraireSymbol
    );

    /// @notice Emitted when the principal threshold for finer cadences
    ///         is updated within the same numeraire.
    event MinPrincipalForFinerCadenceSet(uint256 newThreshold);

    /// @notice Emitted when the shared maturity / periodic-checkpoint
    ///         pre-notify lead time is updated.
    event PreNotifyDaysSet(uint8 newDays);

    /// @notice Emitted when the master kill-switch for the entire
    ///         Periodic Interest Payment mechanic is toggled.
    event PeriodicInterestEnabledSet(bool enabled);

    /// @notice Emitted when the cross-numeraire swap kill-switch is
    ///         toggled.
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
    event PredominantDenominatorUpdated(
        address indexed oldDenominator,
        address indexed newDenominator,
        bytes32 newSymbol,
        address newEthPadFeed,
        address newPadNumeraireRateFeed
    );

    /// @notice Emitted when governance sets / clears a per-asset
    ///         numeraire-direct feed override.
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
