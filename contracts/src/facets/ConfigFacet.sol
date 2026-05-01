// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {LibStakingRewards} from "../libraries/LibStakingRewards.sol";

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

    /// @notice T-032 — emitted on every change to the per-loan-side
    ///         notification fee USD amount.
    event NotificationFeeUsdSet(uint256 newFeeUsd1e18);
    /// @notice T-032 — emitted on every change to the pluggable
    ///         VPFI/<denomination> oracle. `address(0)` resets to the
    ///         Phase 1 fixed-rate fallback (ETH/USD × 1 VPFI = 0.001 ETH).
    event NotificationFeeUsdOracleSet(address indexed newOracle);
    /// @notice T-032 — passed fee outside the [floor, ceil] bounds.
    error InvalidNotificationFeeUsd(
        uint256 provided,
        uint256 floorUsd,
        uint256 ceilUsd
    );

    /**
     * @notice Update the per-loan-side notification fee, USD-denominated
     *         (1e18 scaled). Charged in VPFI from the user's escrow on
     *         the FIRST PaidPush-tier notification fired by the
     *         off-chain hf-watcher.
     * @dev ADMIN_ROLE-only. Bounded inside
     *      `[MIN_NOTIFICATION_FEE_USD_FLOOR, MAX_NOTIFICATION_FEE_USD_CEIL]`
     *      ($0.10 – $50). Floor prevents a misfire that sets the fee to
     *      ~zero and starves the Push channel; ceiling caps the
     *      worst-case user bill at $50/loan-side if governance misfires
     *      upward. Pass exactly 0 to reset to the library default
     *      `NOTIFICATION_FEE_USD_DEFAULT` ($2 ≡ 2e18).
     * @param newFeeUsd1e18 New per-loan-side fee in USD-1e18 scaling;
     *                     pass 0 to reset to the library default.
     */
    function setNotificationFeeUsd(uint256 newFeeUsd1e18)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (
            newFeeUsd1e18 != 0 &&
            (
                newFeeUsd1e18 < LibVaipakam.MIN_NOTIFICATION_FEE_USD_FLOOR ||
                newFeeUsd1e18 > LibVaipakam.MAX_NOTIFICATION_FEE_USD_CEIL
            )
        ) {
            revert InvalidNotificationFeeUsd(
                newFeeUsd1e18,
                LibVaipakam.MIN_NOTIFICATION_FEE_USD_FLOOR,
                LibVaipakam.MAX_NOTIFICATION_FEE_USD_CEIL
            );
        }
        LibVaipakam.storageSlot().protocolCfg.notificationFeeUsd = newFeeUsd1e18;
        emit NotificationFeeUsdSet(newFeeUsd1e18);
    }

    /**
     * @notice Set the pluggable price oracle for the notification fee
     *         (Phase 2 / governance — switching denomination).
     * @dev ADMIN_ROLE-only. Phase 1 default is `address(0)`, in which
     *      case `LibNotificationFee.vpfiAmountForUsdFee` falls back to
     *      ETH/USD × the fixed VPFI/ETH rate. Setting a non-zero
     *      address here makes the library consult that
     *      `AggregatorV3Interface` directly as a VPFI/<denomination>
     *      feed — used when VPFI lists with a real market price OR when
     *      governance wants to denominate the fee in something other
     *      than USD (EUR / JPY / XAU / etc.) by pointing at a feed
     *      whose denominator is the desired reference asset.
     *
     *      No on-chain validation that the address actually implements
     *      AggregatorV3Interface — the library's `try`-shaped read
     *      will revert if the oracle returns malformed data, which is
     *      the right failure mode (operator catches it in dry-run
     *      before broadcasting).
     * @param newOracle  New oracle address; pass `address(0)` to reset
     *                  to the Phase 1 fixed-rate fallback.
     */
    function setNotificationFeeUsdOracle(address newOracle)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.notificationFeeUsdOracle = newOracle;
        emit NotificationFeeUsdOracleSet(newOracle);
    }

    /**
     * @notice T-032 — read the live notification-fee config in one
     *         RPC. Frontend reads this to render the cost disclosure
     *         on the subscription opt-in UI ("Notification fee: $X").
     * @return feeUsd1e18  Resolved fee — either the storage override
     *                     or the library default.
     * @return feeOracle   Pluggable VPFI/<denomination> oracle, or
     *                     `address(0)` for the Phase 1 fixed-rate
     *                     fallback.
     * @return feesAccrued Cumulative VPFI debited via
     *                     `markNotifBilled` since deploy. Operator
     *                     monitors for anomalies.
     */
    function getNotificationFeeConfig()
        external
        view
        returns (uint256 feeUsd1e18, address feeOracle, uint256 feesAccrued)
    {
        feeUsd1e18 = LibVaipakam.cfgNotificationFeeUsd();
        feeOracle = LibVaipakam.storageSlot().protocolCfg.notificationFeeUsdOracle;
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
        if (aprBps > uint16(LibVaipakam.BASIS_POINTS)) revert InvalidStakingAprBps(aprBps);
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
}
