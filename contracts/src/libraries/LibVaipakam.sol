// src/libraries/LibVaipakam.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibDiamond} from "@diamond-3/libraries/LibDiamond.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {ISanctionsList} from "../interfaces/ISanctionsList.sol";
// Numeraire generalization (b1) (T-047 prep): the INumeraireOracle interface that
// Phase 1+2 introduced for numeraire→USD boundary conversion is no
// longer needed — `OracleFacet.getAssetPrice` now returns numeraire-
// quoted prices directly via the renamed Chainlink slots
// (ethNumeraireFeed, numeraireChainlinkDenominator, numeraireSymbol).
// All comparison sites now compare numeraire-vs-numeraire, so the
// boundary conversion that lived in `_convertNumeraireToUsd` /
// `getKycTier{0,1}Threshold` is removed.

/**
 * @title LibVaipakam
 * @author Vaipakam Developer Team
 * @notice This library provides shared storage and data structures for the Vaipakam P2P lending platform.
 * @dev Used in the Diamond Standard (EIP-2535) to manage global state across facets.
 *      Storage is accessed via a specific slot to avoid collisions.
 *      Includes enums for asset types, liquidity, offer types, and loan statuses.
 *      Structs for Offers and Loans store key details.
 *      The Storage struct holds mappings and counters for offers, loans, vaults, and asset liquidity.
 *      No functions beyond storage access; all logic in facets.
 *      Expand for future phases (e.g., cross-chain, governance).
 *
 * @dev ─── Protocol-wide rounding convention ────────────────────────────
 *      All financial math uses Solidity's default integer division
 *      (rounds toward zero). Per formula, the direction is chosen so
 *      every wei of discrepancy favours a safe party. Per-site
 *      comments (`// Rounds DOWN — ...`) state the rationale at each
 *      division. Summary:
 *      - **LTV**: rounds DOWN → 1-BPS *under*-reported → borrower
 *        favour, sub-dust absolute error, acceptable.
 *      - **Health Factor**: rounds DOWN → slightly under-reported →
 *        protocol favour (liquidation may trigger marginally earlier).
 *      - **Interest accrual (simple)**: rounds DOWN on
 *        `(principal * rateBps * elapsed) / (SECONDS_PER_YEAR *
 *        BASIS_POINTS)` → borrower favour by <=1 wei (standard
 *        simple-interest convention).
 *      - **Reward split per user per day**: rounds DOWN on
 *        `(halfPool * userInterest) / chainTotal` → sum-of-shares <=
 *        half-pool, dust retained as over-emission guard.
 *      - **Liquidation bonus**: rounds DOWN on `(proceeds * bps) /
 *        10000` → bonus under-paid by <=1 wei (treasury favour).
 *      - **Oracle USD conversion**: `amount * price / 10**feedDec /
 *        10**tokenDec` — two sequential divides; error stays sub-dust
 *        because USD values are 1e18-scaled.
 *
 *      New division on a money path MUST state direction + who it
 *      favours + why it's safe. `ceilDiv` is reserved for cases where
 *      rounding down is actively dangerous (none currently).
 */
library LibVaipakam {
    using EnumerableSet for EnumerableSet.Bytes32Set; // #625 WI-2a — intent registry
    using EnumerableSet for EnumerableSet.UintSet; // #625 WI-2c — intent-loan registry

    /// @dev ERC-7201 namespaced storage slot for Vaipakam's global state.
    ///      Derived from: keccak256(abi.encode(uint256(keccak256("vaipakam.storage")) - 1)) & ~bytes32(uint256(0xff))
    ///      The `-1` and `& ~0xff` guard against collisions with Solidity's standard
    ///      storage layout (slot 0 for plain vars, `keccak256(key . pos)` for mappings).
    bytes32 internal constant VANGKI_STORAGE_POSITION =
        0x76f6f3ffb4e1cbadb2d289330bfeb7bd9d50e6e2407a61733161f6e3e1d10e00;

    // Constants (configurable via governance in Phase 2)
    uint256 constant MIN_HEALTH_FACTOR = 150 * 1e16; // 1.5 scaled to 1e18 — default admission floor (#394: now a runtime override default)
    /// @dev #394 Lever A — hard range-bounds for the runtime admission-HF-floor
    ///      override (`minHealthFactor()`). Floor 1.2e18: never let admission
    ///      drop into the thin <20%-buffer zone. Ceiling 2.0e18: a floor above
    ///      2.0 would make most liquid collateral un-borrowable. The constant
    ///      `MIN_HEALTH_FACTOR` (1.5e18) sits inside the band as the default.
    uint256 constant MIN_ADMISSION_HEALTH_FACTOR = 120 * 1e16; // 1.2e18
    uint256 constant MAX_ADMISSION_HEALTH_FACTOR = 200 * 1e16; // 2.0e18
    uint256 constant TREASURY_FEE_BPS = 100; // 1% of interest
    uint256 constant BASIS_POINTS = 10000;
    uint256 constant HF_SCALE = 1e18; // Health Factor precision
    uint256 constant HF_LIQUIDATION_THRESHOLD = 1e18; // HF < 1 for liquidation
    uint256 constant SECONDS_PER_YEAR = 365 days;
    uint256 constant DAYS_PER_YEAR = 365;
    uint256 constant ONE_DAY = 1 days;

    /// @notice T-086 Round-7 (Issue #355) — the floor for any
    ///         loan's grace duration. Used by the
    ///         `cfgPrepayListingDutchGraceMarginSec` setter to bound
    ///         the operator-set Dutch B-cond-3b safe-margin so a
    ///         misset can't pin `t_safe` outside the grace window
    ///         (see design doc §18.14). The on-chain saturating guard
    ///         inside B-cond-3b is the runtime defense-in-depth
    ///         fallback for legacy loans whose grace is shorter than
    ///         the configured margin. `1 days` matches the minimum
    ///         grace floor already enforced by `LibVaipakam.gracePeriod`
    ///         for short-duration loans.
    uint256 constant MIN_LOAN_GRACE_PERIOD = 1 days;
    // Pool-depth floor for classifying an asset as `Liquid` — 1,000,000
    // PAD units (the Predominantly Available Denominator: USD on the
    // retail deploy, whatever governance has rotated it to via T-048
    // otherwise — see {effectivePadSymbol}). Expressed in PAD × 1e6
    // units, i.e. `1_000_000 * 1e6` literally means "1,000,000 PAD".
    // {OracleFacet._v3DepthLiquid} computes a *real* depth-at-tick from
    // the asset/WETH v3-style pool (the WETH-leg virtual reserve
    // `L·√P/2⁹⁶` — or `L·2⁹⁶/√P` when WETH is token0 — valued at the
    // spot ETH/PAD feed, doubled, then × 1e6) and compares it to this.
    // (Pre-2026-05: the metric was `poolLiquidity × ethPrice` whose
    // magnitude was dominated by the paired token's decimals + unit
    // price, so this threshold was effectively "the pool isn't empty";
    // the metric was rewritten to a true PAD-denominated figure — see
    // that function's natspec.) Stays the binary `Liquid`/`Illiquid`
    // gate until the Piece-B slippage-at-`floorSizePad` rework (§4.4
    // step 3 in the design doc) replaces it with `cfgFloorSizePad()`;
    // the graded LTV tiers on top of this floor carry their own knobs
    // (`tier{1,2,3}SizePad` / `tier{1,2,3}MaxInitLtvBps`).
    uint256 constant MIN_LIQUIDITY_PAD = 1_000_000 * 1e6;
    // ─── Depth-tiered LTV (Piece B) — defaults + governance bounds ────
    // All sizes below are PAD × 1e6 units (USD on the retail deploy);
    // all `*_BPS` are basis points; the kill-switch
    // `depthTieredLtvEnabled` defaults `false` so a fresh deploy keeps
    // today's `HF ≥ 1.5` init gate. See
    // docs/DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md §4.2-§4.3.
    // Slippage bound a simulated test trade must clear to count toward a
    // tier (and the binary `Liquid` floor once §4.4-step-3-proper lands).
    uint256 constant LIQUIDITY_SLIPPAGE_BPS_DEFAULT = 200; // 2%
    uint256 constant MIN_LIQUIDITY_SLIPPAGE_BPS = 25; // 0.25% — floor so a setter can't make the test absurdly strict
    uint256 constant MAX_LIQUIDITY_SLIPPAGE_BPS = 1000; // 10% — ceiling so it can't be loosened into meaninglessness
    // Pool spot must agree with its own `twapWindowSec` TWAP within this
    // band, else the pool is treated as recently-manipulated → `Illiquid`.
    uint256 constant TWAP_CONSISTENCY_BPS_DEFAULT = 300; // 3%
    uint256 constant MIN_TWAP_CONSISTENCY_BPS = 50; // 0.5%
    uint256 constant MAX_TWAP_CONSISTENCY_BPS = 1000; // 10%
    uint256 constant TWAP_WINDOW_SEC_DEFAULT = 30 minutes;
    uint256 constant MIN_TWAP_WINDOW_SEC = 5 minutes; // too short ⇒ trivially flash-manipulable
    uint256 constant MAX_TWAP_WINDOW_SEC = 1 days; // too long ⇒ stale, blocks legit fast moves
    // Simulated-swap test sizes for the floor + the three graded tiers.
    uint256 constant FLOOR_SIZE_PAD_DEFAULT = 5_000 * 1e6; // clear ⇒ `Liquid`; fail ⇒ `Illiquid`
    uint256 constant TIER1_SIZE_PAD_DEFAULT = 50_000 * 1e6; // → Tier 1 (50% init-LTV)
    uint256 constant TIER2_SIZE_PAD_DEFAULT = 500_000 * 1e6; // → Tier 2 (60% init-LTV)
    uint256 constant TIER3_SIZE_PAD_DEFAULT = 5_000_000 * 1e6; // → Tier 3 (65% init-LTV)
    uint256 constant MIN_TIER_SIZE_PAD = 1_000 * 1e6; // floor for any size knob (1,000 PAD)
    // Per-tier init-LTV caps, applied as `min(assetRiskParams.loanInitMaxLtvBps,
    // tierNMaxInitLtvBps)` only while `depthTieredLtvEnabled`.
    uint256 constant TIER1_MAX_INIT_LTV_BPS_DEFAULT = 5000; // 50%
    uint256 constant TIER2_MAX_INIT_LTV_BPS_DEFAULT = 6000; // 60%
    uint256 constant TIER3_MAX_INIT_LTV_BPS_DEFAULT = 6500; // 65%
    uint256 constant MAX_TIER_INIT_LTV_BPS_CEIL = 8000; // 80% — hard ceiling on any tier-LTV setter

    // ── Per-tier LIQUIDATION threshold (PR2 of internal-match work) ────
    // The LTV at which a loan becomes liquidatable, indexed by the
    // collateral asset's liquidity tier. Replaces the previous per-asset
    // `RiskParams.liqThresholdBps`.
    //
    // #999 (S1) / #1007 (S11) — tier numbering is: tier 1 = THINNEST tierable
    // liquidity (clears the $50k tier-1 probe but not $500k), tier 3 = DEEPEST
    // ($5M probe), matching the init-LTV caps above (tier 1 = 50% cap, tier 3 =
    // 65% cap) and `OracleFacet._liquidityTier`. A liquid asset that clears only
    // the $5k floor but not the $50k probe is untierable (tier 0, #1007), not
    // tier 1.
    // So the gradient runs deeper ⇒ HIGHER pre-liquidation LTV: a DEEP asset
    // (tier 3) can safely tolerate a higher LTV before liquidation because it
    // sells quickly with low slippage, while a THIN asset (tier 1) must be
    // liquidated earlier (lower threshold, wider cushion) to absorb slippage +
    // handling + liquidator bonus without bad debt. The pre-#999 defaults were
    // inverted (thin tier 1 got 90%), leaving thin collateral liquidatable only
    // at 90% LTV — the exact bad-debt shape this gradient exists to prevent.
    // Each `Loan` snapshots the EFFECTIVE value at `initiateLoan` onto
    // `Loan.liquidationLtvBpsAtInit`, so tier-degradation mid-loan never
    // re-gates existing loans.
    //
    // See docs/DesignsAndPlans/InternalLiquidationLedger.md §0 for the
    // user-locked decision trail. Defaults span a 5% gradient between
    // tiers, mirroring the 5% gradient on the init-LTV side (50/60/65
    // ⇒ 80/85/90).
    uint16 constant DEFAULT_TIER1_LIQUIDATION_LTV_BPS = 8_000; // 80% — thinnest
    uint16 constant DEFAULT_TIER2_LIQUIDATION_LTV_BPS = 8_500; // 85%
    uint16 constant DEFAULT_TIER3_LIQUIDATION_LTV_BPS = 9_000; // 90% — deepest
    // Hard range bounds enforced by `ConfigFacet.setTierLiquidationLtvBps`.
    // Floor 50% prevents an accidental "always liquidatable" misconfig;
    // ceiling 95% preserves the ≥5% LTV bad-debt buffer below 100% even
    // at the most permissive admin setting.
    uint16 constant MIN_TIER_LIQUIDATION_LTV_BPS = 5_000;      // 50%
    uint16 constant MAX_TIER_LIQUIDATION_LTV_BPS = 9_500;      // 95%

    // ── Internal-liquidation match path (B.2) defaults + hard bounds ───
    // See docs/DesignsAndPlans/InternalLiquidationLedger.md §0.
    //
    // The view-only matching path runs ahead of external liquidation.
    // Per-loan trigger is `loan.liquidationLtvBpsAtInit` (snapshotted
    // per-tier at init); two GLOBAL knobs configure how the priority
    // window above that trigger behaves:
    //
    // - `externalLiquidationPriorityWindowBps` — the LTV band ABOVE
    //   each loan's per-tier liquidation threshold where ONLY internal
    //   match liquidation is permitted (external `triggerLiquidation`
    //   reverts). When LTV crosses
    //   `loan.liquidationLtvBpsAtInit + externalLiquidationPriorityWindowBps`,
    //   external opens up. Default 200 BPS = 2% LTV window.
    //
    // - `internalMatchIncentivePerLegBps` — % withheld from each
    //   matched leg's transferred collateral, paid to `msg.sender`
    //   (the bot). Default 100 BPS = 1%. Cap 300 BPS = 3% per leg.
    //   At the cap, a 2-way match nets the bot 6% of single-side
    //   notional total, still well under the 5–7.7% external-
    //   liquidation discount the borrowers would have paid.
    //
    // Plus a kill-switch (`internalMatchEnabled`, default false).
    uint16 constant DEFAULT_EXTERNAL_LIQUIDATION_PRIORITY_WINDOW_BPS = 200; // 2%
    uint16 constant MIN_EXTERNAL_LIQUIDATION_PRIORITY_WINDOW_BPS = 0;       // governance can collapse the window
    uint16 constant MAX_EXTERNAL_LIQUIDATION_PRIORITY_WINDOW_BPS = 500;     // 5% cap — keep bad-debt buffer above 100% LTV
    uint16 constant DEFAULT_INTERNAL_MATCH_INCENTIVE_BPS_PER_LEG = 100;     // 1%
    uint16 constant MIN_INTERNAL_MATCH_INCENTIVE_BPS_PER_LEG = 0;           // governance can zero the bot incentive
    uint16 constant MAX_INTERNAL_MATCH_INCENTIVE_BPS_PER_LEG = 300;         // 3% per leg ceiling
    // ── Treasury-conversion (T-600) governance defaults ────────────────
    // The target asset allocation for `TreasuryFacet.convertTreasuryAsset`
    // is a fully governance-configurable list of `(asset, bps)` entries —
    // see `TreasuryConvertTarget` + `s.treasuryConvertTargets`. This cap
    // bounds the per-conversion swap-leg count (gas).
    uint256 constant MAX_TREASURY_CONVERT_TARGETS = 8;
    // Eligibility gate: a conversion may run once the accumulated
    // numeraire-value (1e18-scaled — USD by post-deploy default) of an
    // input token clears this threshold, OR the max interval lapses —
    // whichever comes first.
    uint256 constant TREASURY_CONVERT_USD_THRESHOLD_DEFAULT = 10_000e18; // $10k
    uint32 constant TREASURY_CONVERT_MAX_INTERVAL_DAYS_DEFAULT = 30;     // 30 days
    // Default keeper-confidence tier for an asset the relay hasn't
    // touched yet — Tier 1, i.e. `effectiveTier` collapses to today's
    // `HF ≥ 1.5` until the off-chain 0x/1inch confidence accumulates.
    uint8 constant KEEPER_TIER_DEFAULT = 1;
    uint8 constant MAX_LIQUIDITY_TIER = 3;
    uint256 constant LTV_SCALE = 10000; // Basis points (e.g., 7500 = 75%)
    uint256 constant RENTAL_BUFFER_BPS = 500; // 5% buffer for NFT rentals
    uint256 constant VOLATILITY_LTV_THRESHOLD_BPS = 11000; // 110% LTV for fallback (1.1x loan value)
    uint256 constant MAX_LIQUIDATION_SLIPPAGE_BPS = 600; // 6% max slippage on DEX liquidation swaps (README §7)
    uint256 constant MAX_LIQUIDATOR_INCENTIVE_BPS = 300; // 3% cap on dynamic liquidator incentive (README §3)
    // T-090 — Swap-to-Repay (borrower-initiated DEX swap from collateral
    // to principal at repay time). Tighter than MAX_LIQUIDATION_SLIPPAGE_BPS
    // because the caller is the borrower, not an adversarial liquidator
    // on a clock — the borrower picks the moment and can abort if the
    // chain has gapped against them, so a 3% cap is appropriate.
    uint256 constant MAX_SWAP_TO_REPAY_SLIPPAGE_BPS = 300; // 3% max slippage on swap-to-repay (T-090)
    uint256 constant LIQUIDATION_HANDLING_FEE_BPS = 200; // 2% of proceeds to treasury on successful DEX liquidation (README §3)
    // ── Phase 4 of AutonomousLtvAndOracleFallback.md — tier-LTV cache constants ──
    //
    // Per-tier safety bounds for the autonomous tier-LTV cache. A
    // peer-consensus reading that lands outside its tier's box is
    // REJECTED (not silently clipped) — out-of-band data is signal
    // something's wrong with peer state, not a value to use. Bounds
    // are constitution-level: changing them requires an emergency
    // multisig + source-code change + audit, not a refresh call.
    uint16 constant TIER1_LTV_FLOOR_BPS = 3700;    // 37%
    uint16 constant TIER1_LTV_CEIL_BPS  = 5500;    // 55%
    uint16 constant TIER2_LTV_FLOOR_BPS = 5500;    // 55%
    uint16 constant TIER2_LTV_CEIL_BPS  = 6900;    // 69%
    uint16 constant TIER3_LTV_FLOOR_BPS = 6900;    // 69%
    uint16 constant TIER3_LTV_CEIL_BPS  = 8200;    // 82%

    // Library defaults — used when the cache is hard-stale (>14 days
    // since last refresh) or never-refreshed. Sit at the midpoint of
    // each tier's box so the cache-stale fallback is neutral.
    uint16 constant TIER1_LTV_DEFAULT_BPS = 5000;  // 50%
    uint16 constant TIER2_LTV_DEFAULT_BPS = 6200;  // 62%
    uint16 constant TIER3_LTV_DEFAULT_BPS = 7300;  // 73%

    // Per-tier haircut applied to the peer-consensus median before
    // bound-check. Tier-3 (deepest, highest absolute-dollar exposure)
    // takes a 5pp conservative haircut; Tier-1 / Tier-2 match peer
    // median (the bound check still applies).
    uint16 constant TIER1_LTV_HAIRCUT_BPS = 0;
    uint16 constant TIER2_LTV_HAIRCUT_BPS = 0;
    uint16 constant TIER3_LTV_HAIRCUT_BPS = 500;   // 5pp

    // Cache TTLs.
    uint256 constant TIER_LTV_CACHE_SOFT_TTL = 7 days;
    uint256 constant TIER_LTV_CACHE_HARD_TTL = 14 days;

    // ─── FlashLoanLiquidationPath.md §4 — per-tier liquidation-discount bounds ─
    //
    // The flash-loan / liquidator-buys-at-discount path
    // (`RiskFacet.triggerLiquidationDiscounted`) settles at
    // `debt-plus-discount-VALUE` priced from oracles: the liquidator
    // delivers `totalDebt` of the principal asset and receives the
    // borrower's collateral at a per-tier discount, profiting on the
    // spread between oracle-priced seizure and external DEX execution
    // (typically via a same-tx flash-loan).
    //
    // Per-tier shape: Tier 1 is the THINNEST qualifying tier and
    // therefore carries the widest discount band (liquidator slippage
    // on a thin order-book is higher → bigger incentive needed to
    // attract competing liquidators). Tier 3 is the deepest tier and
    // carries the tightest band — execution risk is small so the
    // liquidator doesn't need much haircut to be profitable.
    // Cross-tier monotonic invariant enforced at the setter:
    //   T1 default ≥ T2 default ≥ T3 default
    // (and the same for governance-configured values).
    //
    // Bounds are constitution-level — changing them requires a
    // source-code change + audit, not a configuration call. The
    // `ConfigFacet.setTierLiqDiscountBps` setter clamps governance
    // writes inside `[FLOOR, CEIL]` so a hostile-governance attack
    // cannot push the discount to a degenerate value (0% would
    // starve the liquidator market; 50% would gut borrower surplus).
    uint16 constant TIER1_LIQ_DISCOUNT_FLOOR_BPS = 300;   // 3.0%
    uint16 constant TIER1_LIQ_DISCOUNT_CEIL_BPS  = 1500;  // 15.0%
    uint16 constant TIER2_LIQ_DISCOUNT_FLOOR_BPS = 300;   // 3.0%
    uint16 constant TIER2_LIQ_DISCOUNT_CEIL_BPS  = 1000;  // 10.0%
    uint16 constant TIER3_LIQ_DISCOUNT_FLOOR_BPS = 200;   // 2.0%
    uint16 constant TIER3_LIQ_DISCOUNT_CEIL_BPS  = 800;   // 8.0%

    // Library defaults — match the user-ratified figures in
    // `docs/DesignsAndPlans/FlashLoanLiquidationPath.md` §3. Tier 1's
    // 770 BPS (7.7%) matches Aave V3's WBTC `liquidationBonus`
    // encoding 10770 (= 10000 + 770) — chosen so external liquidator
    // tooling already calibrated to Aave's discount math sees a
    // familiar magnitude on Vaipakam.
    uint16 constant TIER1_LIQ_DISCOUNT_DEFAULT_BPS = 770;  // 7.7%
    uint16 constant TIER2_LIQ_DISCOUNT_DEFAULT_BPS = 600;  // 6.0%
    uint16 constant TIER3_LIQ_DISCOUNT_DEFAULT_BPS = 500;  // 5.0%

    // Multi-peer / multi-asset consensus rules.
    // Peer divergence tolerance — how far apart two peers' LTV readings
    // can be on the same asset before we treat them as "contested" and
    // drop the asset from the tier aggregation. Set wide enough to
    // tolerate the structural Aave-vs-Compound disagreement: Aave's
    // per-asset LTVs (governance-set after risk-team modeling) are
    // systematically more conservative than Compound's borrow
    // collateral factors — empirically the spread for mid-cap assets
    // (LINK, UNI) sits at 20–30pp without anyone being "wrong",
    // because the two protocols have different liquidation models +
    // different risk-bonus structures. Set to 30pp so honest peer
    // disagreement doesn't reject the asset; manipulation (or peer
    // governance attack) would have to push values >30pp apart to
    // dodge this gate.
    uint16 constant PEER_DIVERGENCE_TOLERANCE_BPS = 3000;
    uint8 constant TIER_MIN_PEER_READINGS = 2;             // ≥ 2 peers agree per asset
    uint8 constant TIER_MIN_ASSET_READINGS = 2;            // ≥ 2 reference assets reporting per tier

    // Partial-liquidation close-factor cap (item 2 of liquidator hardening).
    // 10_000 BPS = 100% i.e. no cap by default — the keeper picks the
    // smallest fraction that restores HF >= 1. Governance can tighten
    // (e.g. to Aave-style 5_000 = 50%) via
    // `ConfigFacet.setMaxPartialLiquidationCloseFactorBps` if it ever
    // wants a per-call ceiling — useful for very long-tail collateral
    // where any single partial above N% slippage is risky. The 10_000
    // ceiling is also the hard upper bound at the setter: a partial
    // can never swap more than 100% of remaining collateral, by definition.
    uint256 constant MAX_PARTIAL_LIQUIDATION_CLOSE_FACTOR_BPS_DEFAULT = 10_000;
    // #395 graduated partial-liquidation sizing (Approach A). The two HF
    // thresholds are BPS-of-HF_SCALE; the dust floor is whole-numeraire — the
    // same scale {RiskFacet._computeNumeraireValues} returns ($1k == 1_000
    // with 8-decimal feeds, NOT 1e18-scaled). See the per-field notes below.
    //  - Target HF ceiling: a routine partial may not leave the borrower
    //    above this HF (prevents over-liquidation). Default HF 1.20.
    //    Bounded (1.05, 1.50] so it always sits strictly above the HF=1.00
    //    restore floor and never above MIN_HEALTH_FACTOR (1.50).
    uint256 constant PARTIAL_LIQ_TARGET_HF_CEILING_BPS_DEFAULT = 12_000;
    uint256 constant MIN_PARTIAL_LIQ_TARGET_HF_CEILING_BPS = 10_500; // HF 1.05
    uint256 constant MAX_PARTIAL_LIQ_TARGET_HF_CEILING_BPS = 15_000; // HF 1.50
    //  - Deep-underwater HF: at/below this HF the ceiling is waived (allow
    //    aggressive delever to the hard close-factor cap). Default HF 0.95.
    //    Bounded [0.80, 0.99] — always strictly below the HF=1.00 floor.
    uint256 constant PARTIAL_LIQ_DEEP_UNDERWATER_HF_BPS_DEFAULT = 9_500;
    uint256 constant MIN_PARTIAL_LIQ_DEEP_UNDERWATER_HF_BPS = 8_000; // HF 0.80
    uint256 constant MAX_PARTIAL_LIQ_DEEP_UNDERWATER_HF_BPS = 9_900; // HF 0.99
    //  - Dust floor: gates the dust waiver/prevention. UNITS: the same
    //    whole-numeraire scale {RiskFacet._computeNumeraireValues} returns
    //    (whole-USD with 8-decimal feeds; NOT 1e18-scaled). DEFAULT 0 ⇒
    //    DISABLED (Codex r3 P2): there is no universally-correct default
    //    because the active numeraire can be rotated away from USD, so a
    //    hard-coded $1k default would mis-classify ordinary loans as dust on
    //    a non-USD deployment. Governance sets an explicit floor in the
    //    active numeraire to switch dust handling on. Capped at 100_000 so a
    //    misconfigured floor can't turn every routine partial into a full
    //    close.
    uint256 constant MAX_LIQUIDATION_DUST_FLOOR_NUMERAIRE = 100_000;
    uint256 constant LOAN_INITIATION_FEE_BPS = 10; // 0.1% fee deducted from ERC-20 principal at loan initiation (README §6 lines 280, 332)
    // Fallback-path split (README §7): lender gets principal + accrued
    // interest + {FALLBACK_LENDER_BONUS_BPS} of principal; treasury gets
    // {FALLBACK_TREASURY_BPS} of principal; borrower gets the remainder.
    // Both are governance-configurable via {ConfigFacet.setFallbackSplit},
    // applied prospectively — each Loan snapshots the effective values at
    // `initiateLoan` so the dual-consent contract at offer creation is
    // never retroactively altered. Stored zero ⇒ use these defaults.
    uint256 constant FALLBACK_LENDER_BONUS_BPS = 300; // 3% lender bonus on fallback path
    uint256 constant FALLBACK_TREASURY_BPS = 200; // 2% treasury cut on fallback path
    // ─── Range Orders Phase 1 constants (docs/RangeOffersDesign.md) ─────
    // Cancel cooldown: when an offer has zero matches against it
    // (`amountFilled == 0`), `cancelOffer` reverts until this many seconds
    // after `Offer.createdAt`. Blunts the cancel-front-run attack on the
    // matching path (§9.2 of the design). Partial-filled offers can be
    // cancelled immediately because the lender has already committed value.
    uint256 constant MIN_OFFER_CANCEL_DELAY = 5 minutes;
    // ── #195 — GTT / offer-expiry horizon cap ────────────────────────────
    // Upper bound on `expiresAt - block.timestamp` at `createOffer`. A
    // user posting a multi-decade "1000-year offer" would lock storage
    // (and pre-vaulted assets) far past any plausible economic window
    // for free; capping the horizon at one year forces the creator to
    // re-post if they really want a long-lived offer, and lets the
    // permissionless-clear path reclaim genuinely abandoned slots
    // within a bounded grief window. The floor is implicit:
    // `expiresAt > block.timestamp` (also enforced at createOffer).
    uint256 constant MAX_OFFER_EXPIRY_HORIZON = 365 days;
    // Loan duration cap defaults + bounds (Findings 00025).
    // ProjectDetailsREADME §2 mandates `1 ≤ durationDays ≤ 365` with
    // on-chain enforcement so external callers cannot bypass the
    // frontend validation. Default is 365 days; admin can re-tune via
    // `ConfigFacet.setMaxOfferDurationDays(uint16)` within the
    // [floor, ceil] bounds below. The floor prevents an accidental
    // "1 day max" lockout (a bricked governance call that locks every
    // user out of placing a meaningful offer); the ceiling caps how
    // far governance can stretch the interest formula
    // `principal × rate × days / 365` before its accuracy degrades
    // for multi-year loans. Lower bound at offer creation is the
    // existing `durationDays == 0 → InvalidOfferType` check (so the
    // minimum loan duration is 1 day; that's not governance-tunable).
    uint16 constant MAX_OFFER_DURATION_DAYS_DEFAULT = 365;
    uint16 constant MIN_OFFER_DURATION_DAYS_FLOOR = 7;
    uint16 constant MAX_OFFER_DURATION_DAYS_CEIL = 4385; // 12+ years
    // Matcher fee, in BPS of LIF: when LIF flows to treasury, this
    // fraction kicks to `msg.sender` of the matching call (whoever
    // submitted `matchOffers` / `acceptOffer` / preclose-offset /
    // refinance). 1% of LIF — symbolic on L2s where gas is cheap;
    // establishes the seam for Phase 2 to dial up if community bots
    // need stronger incentives.
    uint256 constant LIF_MATCHER_FEE_BPS = 100;

    /// @dev Auto-pause defaults + bounds (Phase 1 follow-up). Default
    ///      30 min: long enough for human incident-response, short
    ///      enough that a false-positive doesn't strand users. Floor
    ///      5 min so admin can't stealth-disable by setting to ~0.
    ///      Ceiling 2 hours so a compromised watcher's worst case is
    ///      a 2-hour freeze (admin can short-circuit via `unpause()`).
    uint256 constant AUTO_PAUSE_DURATION_DEFAULT = 1800; // 30 min
    uint256 constant MIN_AUTO_PAUSE_SECONDS = 300; // 5 min
    uint256 constant MAX_AUTO_PAUSE_SECONDS = 7200; // 2 hours

    /// @dev T-032 / Numeraire generalization (b1) — Notification fee (per loan-side)
    ///      defaults + bounds. Charged in VPFI, denominated in the
    ///      ACTIVE NUMERAIRE (1e18-scaled — USD by post-deploy default;
    ///      whatever governance has rotated to otherwise), deducted on
    ///      first paid-tier notification fired by the off-chain
    ///      hf-watcher. Default 2.0 numeraire-units covers Push
    ///      Protocol channel-side delivery costs at the operator's
    ///      expected notification volumes (~5-10 notifications per
    ///      loan lifetime). Floor 0.1 prevents governance accidentally
    ///      setting it to ~0 and starving the channel; ceiling 50.0
    ///      caps the worst-case bill on a per-loan basis if governance
    ///      misfires upward.
    ///
    ///      The numeraire-quoted fee converts to VPFI via the
    ///      ETH/numeraire price returned by `OracleFacet.getAssetPrice(WETH)`
    ///      (anchored at the oracle layer post-b1) times the fixed
    ///      `VPFI_PER_ETH_FIXED_PHASE1` rate. No USD-intermediate is
    ///      involved — the fee storage value, the oracle return, and
    ///      the resulting math are all in the active numeraire end to
    ///      end. Atomic multi-arg `setNumeraire` in `ConfigFacet` keeps
    ///      this in lockstep with the threshold and KYC tiers when
    ///      governance rotates.
    uint256 constant NOTIFICATION_FEE_DEFAULT = 2 * 1e18;
    uint256 constant MIN_NOTIFICATION_FEE_FLOOR = 1e17; // 0.1 numeraire-units
    uint256 constant MAX_NOTIFICATION_FEE_CEIL = 50 * 1e18; // 50 numeraire-units

    /// @dev T-032 — Phase 1 fixed VPFI/ETH rate. VPFI doesn't have a
    ///      real market price yet; the fee math is anchored to
    ///      ETH/numeraire times this fixed rate so VPFI gets a
    ///      synthetic numeraire quote without needing a tradable VPFI
    ///      market:
    ///        `vpfiAmount = feeNumeraire
    ///                       / (ethPriceNumeraire × VPFI_PER_ETH_FIXED_PHASE1)`
    ///      where `VPFI_PER_ETH_FIXED_PHASE1 = 1e15` (1 VPFI = 0.001
    ///      ETH, both 18-dec). The constant is unit-agnostic — it
    ///      describes the VPFI-to-ETH peg, independent of the active
    ///      numeraire. When VPFI lists on an exchange (Phase 2),
    ///      governance can replace this fixed rate with a live
    ///      VPFI/numeraire feed without needing the USD intermediate
    ///      that the pre-b1 design carried.
    uint256 constant VPFI_PER_ETH_FIXED_PHASE1 = 1e15;
    // Sanity ceiling on `interestRateBpsMax` at offer creation. Below
    // 100% APR equivalent (10000 bps). Tighter would risk rejecting
    // legitimate distressed-borrower offers; higher would let pranks
    // / typo-grade offers spam the book.
    uint256 constant MAX_INTEREST_BPS = 10_000;
    // #400 (hardening) — bounds for the rate-model deviation cap (the max ±
    // BPS a model may move a quote from the caller's reference rate).
    uint256 constant RATE_MODEL_MAX_DEVIATION_BPS_DEFAULT = 500; // 5%
    uint256 constant MIN_RATE_MODEL_MAX_DEVIATION_BPS = 50;      // 0.5% floor — a model that can't move at all is pointless
    uint256 constant MAX_RATE_MODEL_MAX_DEVIATION_BPS = 2_500;   // 25% ceiling — caps how far automation can drift from market

    // ─── T-034 — Periodic Interest Payment defaults + bounds ─────────────
    // See docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md.
    //
    // Cadence interval lookup table (in days). The `intervalDays` library
    // helper returns these for the four non-`None` cadences. None → 0.
    uint256 constant PERIODIC_INTERVAL_MONTHLY_DAYS = 30;
    uint256 constant PERIODIC_INTERVAL_QUARTERLY_DAYS = 90;
    uint256 constant PERIODIC_INTERVAL_SEMI_ANNUAL_DAYS = 180;
    uint256 constant PERIODIC_INTERVAL_ANNUAL_DAYS = 365;

    // Pre-notify lead time. Single knob shared between the maturity
    // pre-notify lane and the new periodic-checkpoint pre-notify lane in
    // the off-chain hf-watcher. Range narrow on purpose: <1 day misses
    // weekend-buffer; >14 days creates noise that trains users to ignore
    // the alert. Default 3 mirrors the existing maturity-warning cadence.
    uint8 constant PERIODIC_PRE_NOTIFY_DAYS_DEFAULT = 3;
    uint8 constant PERIODIC_PRE_NOTIFY_DAYS_FLOOR = 1;
    uint8 constant PERIODIC_PRE_NOTIFY_DAYS_CEIL = 14;

    // Principal threshold above which the lender can opt the loan into a
    // finer-than-mandatory cadence (Monthly / Quarterly / SemiAnnual on
    // any duration; finer-than-Annual on multi-year). Denominated in
    // numeraire-units (1e18-scaled). Default $100k under USD-as-
    // numeraire (post-deploy default; b1 — read from Chainlink ETH/USD
    // via `ethNumeraireFeed`). Floor $1k stops a
    // misconfigured "everyone qualifies" setting; ceiling $10M caps the
    // worst-case "nobody qualifies" misfire.
    uint256 constant PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_DEFAULT = 100_000 * 1e18;
    uint256 constant PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_FLOOR = 1_000 * 1e18;
    uint256 constant PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_CEIL = 10_000_000 * 1e18;

    uint256 constant KYC_TIER0_THRESHOLD_NUMERAIRE = 1_000 * 1e18; // Tier0 max
    uint256 constant KYC_TIER1_THRESHOLD_NUMERAIRE = 10_000 * 1e18; // Tier1 max
    uint256 constant MAX_FEE_EVENTS_ITER = 10_000; // Max feeEventsLog entries scanned per window query in MetricsFacet
    uint256 constant SEQUENCER_GRACE_PERIOD = 3600; // 1h post-recovery grace on L2s before prices are trusted again

    // ─── T-044 — duration-tiered loan-default grace bounds ───────────────
    // The grace period applied between a loan's `endTime` and the moment
    // {DefaultedFacet.markDefaulted} can fire is a function of the loan's
    // original `durationDays`. Short loans get a short grace; long loans
    // get a longer one. Both the bucket threshold (`maxDurationDays`)
    // AND the per-bucket grace (`graceSeconds`) are admin-configurable
    // via {ConfigFacet.setGraceBuckets}, with `gracePeriod()` falling back
    // to the compile-time default schedule when storage is empty.
    //
    // **Schedule shape — fixed 6-slot positional table**:
    // The schedule is exactly 6 slots; admin can edit the values inside
    // each slot but cannot add or remove rows. Each slot carries its own
    // hard bounds for BOTH the duration threshold and the grace period
    // (see {graceSlotBounds}). This gives operators the flexibility to
    // tune values within sensible per-slot windows — a < 7 day bucket
    // can never be set to a 90-day grace, a < 365 day bucket can never
    // be flipped down to a 1-hour grace.
    //
    // Slot 5 is the catch-all (`maxDurationDays == 0`); it covers any
    // loan duration above slot 4's threshold and is governed only by its
    // own grace bounds (no duration ceiling).
    //
    // Defended against compromised-admin attacks the same way every other
    // governance setter is (see T-033) — every value is range-checked at
    // the setter and the bounds themselves are compile-time constants.
    uint256 constant GRACE_BUCKETS_FIXED_COUNT = 6;
    // Absolute floor / ceiling — every per-slot bound below stays inside
    // these. Belt-and-braces guard against a future per-slot-bound bump
    // that accidentally breaks the global invariants (TZ tolerance + max
    // lender lock-up).
    uint256 constant GRACE_SECONDS_MIN = 1 hours;
    uint256 constant GRACE_SECONDS_MAX = 90 days;

    // ─── Chainlink staleness thresholds (stable-peg-aware hybrid) ───────
    // Volatile feeds (ETH/BTC/etc.-USD) publish on a 1h heartbeat + 0.5%
    // deviation trigger. Stable / fiat / commodity feeds (USDC, EUR/USD,
    // JPY/USD, XAU/USD) publish on a 24h heartbeat + small deviation —
    // they commonly go a full day without an update because the price is
    // pinned to its reference. OracleFacet.getAssetPrice enforces a
    // two-tier staleness rule:
    //   age <= ORACLE_VOLATILE_STALENESS                              → accept
    //   age <= ORACLE_STABLE_STALENESS AND feed reports within peg    → accept
    //   otherwise                                                     → revert
    //
    // The stable-path check uses the SAME `answer` already read (no
    // extra feed call) and is gated on `feed.decimals() == 8` so only
    // 8-decimal USD-quoted feeds qualify — an asset/ETH feed that
    // happens to report 1e18 is not misclassified.
    //
    // "Within peg" = within ORACLE_PEG_TOLERANCE_BPS of either
    //   (a) the implicit USD $1 peg (ORACLE_USD_PEG_1E8), or
    //   (b) any registered non-USD peg in `stableFeedBySymbol` (EUR/JPY/
    //       XAU/etc.) whose reference feed is itself within
    //       ORACLE_STABLE_STALENESS. Fiat/commodity reference feeds are
    //       themselves on 24h heartbeats, so we cannot force a 2h
    //       freshness requirement on them — we reuse the stable ceiling.
    uint256 constant ORACLE_VOLATILE_STALENESS = 2 hours;
    uint256 constant ORACLE_STABLE_STALENESS = 25 hours;
    uint256 constant ORACLE_PEG_TOLERANCE_BPS = 300; // 3%
    int256 constant ORACLE_USD_PEG_1E8 = 1e8; // $1 scaled to 8 decimals

    // ─── VPFI Discount Tier Table (docs/TokenomicsTechSpec.md §6) ────────
    // Tiered fee discount gated purely by the user's vault VPFI balance.
    // A single platform-level consent flag (vpfiDiscountConsent) governs
    // both borrower Loan Initiation Fee and lender Yield Fee discounts.
    // Tier resolution is a pure balance check — no Chainlink dependency —
    // so the tier gate is deterministic and cheap to compute.
    //
    // Tier | Vault VPFI range       | Discount | Lender Yield | Borrower Init
    //   0  | < 100                   |     0%   |       1%     |        0.1%
    //   1  | 100 ≤ x < 1,000         |    10%   |     0.9%     |       0.09%
    //   2  | 1,000 ≤ x < 5,000       |    15%   |    0.85%     |      0.085%
    //   3  | 5,000 ≤ x ≤ 20,000      |    20%   |     0.8%     |       0.08%  (20k inclusive)
    //   4  |       x > 20,000        |    24%   |    0.76%     |      0.076%
    //
    // Discount BPS are applied to the NORMAL fee:
    //   effectiveFeeBps = normalFeeBps * (BASIS_POINTS - tierDiscountBps) / BASIS_POINTS
    //
    // Boundary semantics matter at the T3/T4 split: exactly 20,000 VPFI is
    // T3 (not T4), so the check is strictly `> 20_000e18` for T4.
    uint256 constant VPFI_TIER1_MIN = 100 * 1e18; // T1 starts at ≥ 100
    uint256 constant VPFI_TIER2_MIN = 1_000 * 1e18; // T2 starts at ≥ 1,000
    uint256 constant VPFI_TIER3_MIN = 5_000 * 1e18; // T3 starts at ≥ 5,000
    uint256 constant VPFI_TIER4_THRESHOLD = 20_000 * 1e18; // T4 starts strictly ABOVE this
    uint256 constant VPFI_TIER1_DISCOUNT_BPS = 1000; // 10%
    uint256 constant VPFI_TIER2_DISCOUNT_BPS = 1500; // 15%
    uint256 constant VPFI_TIER3_DISCOUNT_BPS = 2000; // 20%
    uint256 constant VPFI_TIER4_DISCOUNT_BPS = 2400; // 24%

    // ─── VPFI Reward Pools (docs/TokenomicsTechSpec.md §3, §4, §7) ───────
    // Hard caps on each Phase-1 emission category. The diamond pays
    // claims from its own VPFI balance; a cumulative paid-out counter
    // enforces these caps at claim time.
    // #687-B: VPFI_STAKING_POOL_CAP (24%) was removed with the 5% staking
    // yield. The freed supply allocation is an owner tokenomics decision
    // tracked under #687 / #694; this constant no longer gates any claim.
    uint256 constant VPFI_INTERACTION_POOL_CAP = 69_000_000 * 1e18; // 30% of supply
    // Reward base for interaction daily pool — multiplied by the
    // schedule's annualRate and `dt / 365` to size each day's emission.
    uint256 constant VPFI_INITIAL_MINT = 23_000_000 * 1e18;
    // Max days walked in a single claimInteractionRewards() call — bounds
    // gas cost for long-dormant users without denying access.
    uint256 constant MAX_INTERACTION_CLAIM_DAYS = 30;
    // Default per-user daily cap on platform-interaction reward payouts
    // (docs/TokenomicsTechSpec.md §4). Expressed as "whole VPFI per 1 ETH
    // of eligible interest" — 500 ≡ 0.5 VPFI per 0.001 ETH. Applied
    // independently on the lender and borrower sides each day. The
    // effective cap is admin-configurable via
    // {InteractionRewardsFacet.setInteractionCapVpfiPerEth}; a stored
    // zero falls back to this constant (see {getInteractionCapVpfiPerEth}).
    uint256 constant INTERACTION_CAP_DEFAULT_VPFI_PER_ETH = 500;

    // ─── VPFI recycling balance governor (#1222, design
    //     VpfiRecyclingBalanceGovernorDesign.md) ──────────────────────────
    /// @dev Platform-favouring margin the recycling governor retains from
    ///      absorption before sizing the coupled reward budget
    ///      (`recycledBudget = (10000 − marginBps)/10000 × Ā`). Default 5%.
    ///      Stored `0` ⇒ this default (see {cfgRecycleMarginBps}); a literal
    ///      0% is expressed as `1` bp — `0` is the reset-to-default sentinel.
    uint16 constant RECYCLE_MARGIN_DEFAULT_BPS = 500; // 5%
    /// @dev Hard ceiling on the retained margin (25%). The setter range is
    ///      `[1, RECYCLE_MARGIN_MAX_BPS]`; `0` resets to the default.
    uint16 constant RECYCLE_MARGIN_MAX_BPS = 2_500; // 25%
    /// @dev Governor PR-3b (#1217 §3.1) — trailing-window width `W` for the
    ///      absorption average `Ā[D] = Σ_{d∈(D−W..D]} credited[d] / W`.
    ///      Compile-time constant, ratified fixed at 7 (governor §11.3 —
    ///      one auditable economic knob beats two interacting ones). ALWAYS
    ///      divide by W, zero-padding the pre-launch prefix: dividing by
    ///      elapsed days would count a launch-day spike ≈2.6×, violating
    ///      the ≤1× lifetime-contribution bound (Codex r2).
    uint256 constant RECYCLE_TRAILING_WINDOW_DAYS = 7;
    /// @dev RL-3 (#1305, VpfiRecyclingLoopClosureDesign §6 — ratified
    ///      §10.2) — bounds for the post-claimability reward claim horizon
    ///      `H` (days). The ratified default is 365; the knob is bounded
    ///      below at 180 so governance can never spring a short horizon on
    ///      dormant claimants, and above at 1095 so the liability tail
    ///      stays genuinely bounded. Stored `0` ⇒ the feature is DARK
    ///      (deploy default): nothing expires, no clock runs.
    uint32 constant REWARD_CLAIM_HORIZON_MIN_DAYS = 180;
    uint32 constant REWARD_CLAIM_HORIZON_MAX_DAYS = 1095;

    /// @dev Tariff `k` for peg-free discount entitlements (design §4.2): VPFI
    ///      (1e18) charged per 1 ETH (1e18) of loan volume per day, so a
    ///      loan's tariff = `k × ethVolume18 × durationDays / 1e18`. A pure
    ///      QUANTITY schedule — never a fee-value conversion (that would
    ///      re-enter the price-peg surface). Stored `0` ⇒ this default (see
    ///      {cfgRecycleTariffKPer1e18EthDay}). Initial value; governance tunes
    ///      it in the same family as the interaction-reward ratio so the loop
    ///      stays net-absorbing after rewards at the governor margin.
    uint256 constant RECYCLE_TARIFF_K_DEFAULT = 5e16; // 0.05 VPFI / ETH·day
    uint256 constant RECYCLE_TARIFF_K_MIN = 1e15; // 0.001 VPFI / ETH·day
    uint256 constant RECYCLE_TARIFF_K_MAX = 1e18; // 1.0 VPFI / ETH·day

    /// @custom:event-category informational/config
    event TreasurySet(address indexed newTreasury);

    // Shared errors consolidated in IVaipakamErrors.sol

    /**
     * @notice Enum for supported asset types.
     * @dev ERC20 for tokens, NFT721 for unique NFTs, NFT1155 for semi-fungible NFTs.
     */
    enum AssetType {
        ERC20,
        ERC721,
        ERC1155
    }

    /**
     * @notice Enum for asset liquidity status.
     * @dev Liquid if Chainlink feed and DEX pool exist; Illiquid otherwise (includes all NFTs).
     */
    enum LiquidityStatus {
        Liquid,
        Illiquid
    }

    /**
     * @notice #671 — per-vault progressive risk-access tier.
     * @dev Default-init `0 == BlueChipOnly`, so every fresh vault starts at
     *      the safest tier with NO migration (zero-init storage = the strictest
     *      gate). A user opts UP — never down by accident — only via the
     *      EIP-712 self-submit setter in `RiskAccessFacet`. An offer's required
     *      level is the MAX (riskier) of its two legs' required levels — a
     *      blue-chip leg needs `BlueChipOnly` (0), an illiquid leg needs
     *      `IlliquidCustom` (2) — so the riskier leg governs and a vault must
     *      hold at least that level to transact the pair.
     *
     *      The tiers map to liquidity bands derived on-chain (NO governance
     *      allow-list — see `docs/DesignsAndPlans/ProgressiveRiskAccessDesign.md`):
     *        - `BlueChipOnly`  — only blue-chip assets: the numeraire basket
     *          (WETH + the configured PAA quote assets) OR an asset that earns
     *          `getEffectiveLiquidityTier == 3` (the O6 numeraire-basket union).
     *        - `BroadLiquid`   — any liquid (tier ≥ 1) asset. No per-pair step:
     *          the tier opt-up itself is the consent and the quantitative
     *          LTV/HF check still applies (design RD-1).
     *        - `IlliquidCustom`— illiquid / unpriced assets, with explicit
     *          per-pair consent.
     */
    enum RiskAccessLevel {
        BlueChipOnly,
        BroadLiquid,
        IlliquidCustom
    }

    /**
     * @notice Enum for offer types.
     * @dev Lender offers to lend, Borrower requests to borrow.
     */
    enum OfferType {
        Lender,
        Borrower
    }

    /**
     * @notice #125 — DEX-style fill-mode flavour of an offer.
     * @dev `PARTIAL` is the default (zero-init storage = today's
     *      Range-Orders Phase-1 partial-fill behaviour) so every legacy
     *      offer keeps working without a migration.
     *
     *      `AON` ("All-or-Nothing") rejects any non-full fill at match
     *      time. To make the invariant unambiguous, `createOffer`
     *      requires `amount == amountMax` on AON offers (a non-trivial
     *      range under AON is structurally meaningless — the only fill
     *      that ever lands is the full one).
     *
     *      `IOC` ("Immediate-or-Cancel") layers on `expiresAt` from
     *      #195 — the offer is partial-fillable, but only inside the
     *      time window the creator set. Past `expiresAt` the lazy-
     *      expiry gate kicks in and the unmatched remainder is
     *      cleanable via the permissionless `cancelOffer` path.
     *      `createOffer` requires `expiresAt > 0` on IOC offers; the
     *      flag itself is descriptive metadata for indexers/UI to
     *      surface "IOC, 60s window" rather than "GTT until <date>"
     *      — the runtime enforcement is shared with GTT.
     *
     *      `FOK` and `POST` were considered and deferred:
     *        - POST ("post-only / maker-only") would prevent the offer
     *          from being the taker of another offer; in Vaipakam every
     *          offer is structurally a maker (the acceptor is the
     *          caller of `acceptOffer` or the matcher bot, never an
     *          offer), so POST is a no-op.
     *        - FOK ("Fill-or-Kill") is strictly stricter than AON —
     *          must fill in full in the same block or revert. AON is
     *          a better fit for P2P lending's slower match cadence.
     *      Both excluded from this enum to keep the enum surface tight;
     *      can be appended later without breaking storage layout.
     */
    enum FillMode {
        Partial,
        Aon,
        Ioc
    }

    /**
     * @notice T-034 — cadence at which the borrower must settle accrued
     *         interest during the loan's lifetime.
     * @dev `None` is today's behavior — terminal-only repayment. The four
     *      finer values correspond to fixed intervals (30 / 90 / 180 /
     *      365 days). For loans with `durationDays > 365` the contract
     *      enforces a minimum cadence of `Annual`. For all loans, the
     *      cadence interval must be strictly less than `durationDays`
     *      (a cadence whose first checkpoint lands at or after maturity
     *      is meaningless). For loans where either side is illiquid,
     *      cadence MUST be `None` (the auto-liquidate path requires
     *      both assets to be DEX-swappable). See
     *      docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md §3.
     *      Lookup helper: `intervalDays(cadence)` returns the matching
     *      day count or 0 for `None`.
     */
    enum PeriodicInterestCadence {
        None,
        Monthly,
        Quarterly,
        SemiAnnual,
        Annual
    }

    /**
     * @notice Enum for loan statuses.
     * @dev Active during term, Repaid on successful closure, Defaulted on failure, Settled after both parties claim.
     */
    /**
     * @notice Loan lifecycle status.
     * @dev `FallbackPending` is the interim state entered when a DEX
     *      liquidation swap fails or would exceed the 6% slippage ceiling
     *      (README §§148-152, 298). In this state:
     *        - The lender may claim immediately (no borrower grace window).
     *        - The borrower may still cure by `addCollateral` (if HF/LTV
     *          is restored, the loan reverts to `Active` and the fallback
     *          snapshot is cancelled) or by `repayLoan` in full (loan
     *          transitions to `Repaid`, snapshot cancelled).
     *        - The borrower MAY NOT claim collateral until the lender
     *          claim finalizes and the status transitions to `Defaulted`.
     *      Once `claimAsLender` starts, it either retries the swap
     *      successfully (proceeds path) or falls back to the collateral
     *      split — either outcome sets the status to `Defaulted`.
     */
    enum LoanStatus {
        Active,
        Repaid,
        Defaulted,
        Settled,
        FallbackPending,
        // Internal-liquidation match path (B.2) terminal state. Set by
        // the matching entry point (PR4+) on a fully-matched loan
        // (both legs cleared). Loans where the match only cleared
        // part of the balance stay `Active` with reduced
        // principal/collateral (partial-match α from §7 of
        // InternalLiquidationLedger.md). Append-only at the end so
        // existing `uint8` ABI reads of `LoanStatus` stay stable.
        // PR3 reserves the enum slot; no facet sets this status
        // until the PR4 execution body lands.
        InternalMatched
    }

    /**
     * @notice NFT-position lifecycle status stamped on Vaipakam position NFTs.
     * @dev Distinct from `LoanStatus` because NFTs begin life as offer
     *      receipts (pre-loan) and outlive the loan through the claim phase.
     *      Stored on-chain as the enum; stringified only at `tokenURI()`.
     *      `None` is the default for uninitialized tokens — treat as
     *      equivalent to `OfferCreated` for rendering purposes.
     */
    enum LoanPositionStatus {
        None,
        OfferCreated,
        LoanInitiated,
        LoanRepaid,
        LoanDefaulted,
        LoanLiquidated,
        LoanClosed,
        LoanFallbackPending
    }

    /**
     * @notice Enum for KYC tier levels.
     * @dev Tier0 = no KYC, Tier1 = limited KYC, Tier2 = full KYC.
     */
    enum KYCTier {
        Tier0,
        Tier1,
        Tier2
    }

    /**
     * @notice Admin-configurable protocol parameters (read through the
     *         `cfg*` helpers below; written by {ConfigFacet}).
     * @dev Stored-zero semantics: every field treats `0` as "not set" and
     *      falls back to the corresponding `LibVaipakam` constant default.
     *      This preserves behaviour on freshly deployed diamonds that have
     *      not yet called any {ConfigFacet} setter and on diamonds
     *      upgraded in-place before {ConfigFacet.initializeConfig} runs.
     *
     *      Packing: the first 12 fields are `uint16` BPS values packed
     *      into a single storage slot (12 × 16 = 192 bits < 256). The
     *      four tier thresholds each occupy their own slot (they hold
     *      18-decimal VPFI balances that routinely exceed `uint128`).
     *
     *      Scope (user directive 2026-04-21): tunable = fees, VPFI tier
     *      table, LTV / liquidation risk knobs, rental buffer. Kept
     *      immutable: tokenomics supply caps (`VPFI_*_CAP`,
     *      `VPFI_INITIAL_MINT`), `MIN_HEALTH_FACTOR`, fallback 3%/2%
     *      settlement split, `BASIS_POINTS` and other scale constants.
     */
    struct ProtocolConfig {
        // ── Packed BPS slot (14 × uint16 = 224 bits; 32 bits of headroom) ──
        uint16 treasuryFeeBps; // 0 ⇒ TREASURY_FEE_BPS (100)
        uint16 loanInitiationFeeBps; // 0 ⇒ LOAN_INITIATION_FEE_BPS (10)
        uint16 liquidationHandlingFeeBps; // 0 ⇒ LIQUIDATION_HANDLING_FEE_BPS (200)
        uint16 maxLiquidationSlippageBps; // 0 ⇒ MAX_LIQUIDATION_SLIPPAGE_BPS (600)
        uint16 maxLiquidatorIncentiveBps; // 0 ⇒ MAX_LIQUIDATOR_INCENTIVE_BPS (300)
        uint16 volatilityLtvThresholdBps; // 0 ⇒ VOLATILITY_LTV_THRESHOLD_BPS (11000)
        uint16 rentalBufferBps; // 0 ⇒ RENTAL_BUFFER_BPS (500)
        uint16 vpfiTier1DiscountBps; // 0 ⇒ VPFI_TIER1_DISCOUNT_BPS (1000)
        uint16 vpfiTier2DiscountBps; // 0 ⇒ VPFI_TIER2_DISCOUNT_BPS (1500)
        uint16 vpfiTier3DiscountBps; // 0 ⇒ VPFI_TIER3_DISCOUNT_BPS (2000)
        uint16 vpfiTier4DiscountBps; // 0 ⇒ VPFI_TIER4_DISCOUNT_BPS (2400)
        // Fallback-path split, governance-configurable. Prospective
        // semantics: `Loan.fallbackLenderBonusBpsAtInit` / `...TreasuryBpsAtInit`
        // are snapshotted at `initiateLoan`, so governance changes via
        // `setFallbackSplit` never retroactively alter dual-consent offers.
        uint16 fallbackLenderBonusBps; // 0 ⇒ FALLBACK_LENDER_BONUS_BPS (300)
        uint16 fallbackTreasuryBps; // 0 ⇒ FALLBACK_TREASURY_BPS (200)
        // Range Orders Phase 1: matcher's slice of the LIF that flows
        // to treasury at match-time (lender-asset path) or at terminal
        // (VPFI path). 0 ⇒ LIF_MATCHER_FEE_BPS (100 = 1%). Tunable so
        // governance can dial up to 5-10% if community bot operators
        // need a stronger incentive to compete (per the design plan's
        // "Match-fee economics revisit" Phase 2 item). Capped at
        // MAX_FEE_BPS (50%) by the setter.
        uint16 lifMatcherFeeBps; // 0 ⇒ LIF_MATCHER_FEE_BPS (100)
        // Partial-liquidation close-factor cap (Phase 2 liquidator
        // hardening, item 2). Governance ceiling on the swap fraction
        // an off-chain keeper can pass to `RiskFacet.triggerPartialLiquidation`.
        // 0 ⇒ MAX_PARTIAL_LIQUIDATION_CLOSE_FACTOR_BPS_DEFAULT (10_000 =
        // no cap, keeper picks the smallest fraction that restores HF≥1).
        // Setter clamps the configured value to ≤ 10_000 — by definition
        // a partial can't swap more than 100% of remaining collateral.
        uint16 maxPartialLiquidationCloseFactorBps; // 0 ⇒ MAX_PARTIAL_LIQUIDATION_CLOSE_FACTOR_BPS_DEFAULT (10_000)
        // Auto-pause window (Phase 1 follow-up). Duration in seconds
        // for an off-chain anomaly-watcher's `autoPause()` to freeze
        // the protocol while humans investigate. 0 ⇒
        // AUTO_PAUSE_DURATION_DEFAULT (1800 = 30 min). Capped at
        // [MIN_AUTO_PAUSE_SECONDS, MAX_AUTO_PAUSE_SECONDS] by the
        // setter — floor prevents "set to 0" disable-by-stealth,
        // ceiling caps a compromised watcher's worst-case freeze.
        uint32 autoPauseDurationSeconds; // 0 ⇒ AUTO_PAUSE_DURATION_DEFAULT
        // Maximum offer durationDays (Findings 00025). 0 ⇒
        // MAX_OFFER_DURATION_DAYS_DEFAULT (365). Bounded at the setter
        // by [MIN_OFFER_DURATION_DAYS_FLOOR, MAX_OFFER_DURATION_DAYS_CEIL]
        // — floor prevents an accidental "1 day max" lockout, ceiling
        // caps how far governance can stretch the duration interest
        // formula's accuracy. Stored as uint16 so the slot stays
        // packed; the runtime read returns uint256 via `cfgMaxOfferDurationDays`.
        uint16 maxOfferDurationDays; // 0 ⇒ MAX_OFFER_DURATION_DAYS_DEFAULT (365)
        // ── Range Orders Phase 1 master kill-switch flags ─────────────
        // All default `false` on a fresh deploy. Flipped on by governance
        // via `ConfigFacet.setRangeAmountEnabled` / `setRangeRateEnabled`
        // / `setPartialFillEnabled` after the testnet bake. While off,
        // `OfferFacet.createOffer` enforces the legacy single-value
        // shape — see docs/RangeOffersDesign.md §15.
        bool rangeAmountEnabled;
        bool rangeRateEnabled;
        bool partialFillEnabled;
        // Phase 1 follow-up (Issue #164) — borrower-side collateral
        // range. Mirrors the lender-side amount range: when off (the
        // default), every offer must have `collateralAmountMax ==
        // collateralAmount` (single-value), so today's behaviour is
        // unchanged. Flipped on by governance via
        // `ConfigFacet.setRangeCollateralEnabled` once the contract
        // halves of #164 have baked on testnet.
        bool rangeCollateralEnabled;
        // ── VPFI discount tier thresholds (18-dec VPFI; 0 ⇒ default) ──
        uint256 vpfiTier1Min; // 0 ⇒ VPFI_TIER1_MIN (100e18)
        uint256 vpfiTier2Min; // 0 ⇒ VPFI_TIER2_MIN (1_000e18)
        uint256 vpfiTier3Min; // 0 ⇒ VPFI_TIER3_MIN (5_000e18)
        uint256 vpfiTier4Threshold; // 0 ⇒ VPFI_TIER4_THRESHOLD (20_000e18)
        // ── T-032 / Numeraire generalization (b1) — Notification fee config ─────────
        // Flat per-loan-side notification fee, denominated in the
        // ACTIVE NUMERAIRE (1e18 scaled — USD by post-deploy default;
        // whatever governance has rotated to otherwise). Charged in
        // VPFI from the user's vault at the moment the off-chain
        // hf-watcher fires the FIRST notification on a PaidPush-tier
        // subscription for that loan-side. Zero (default) means use
        // the library constant `NOTIFICATION_FEE_DEFAULT` (2.0
        // numeraire-units); set via `ConfigFacet.setNotificationFee`.
        // Bounded `[MIN_NOTIFICATION_FEE_FLOOR, MAX_NOTIFICATION_FEE_CEIL]`
        // at the setter so a misfire can't lock users out OR drain
        // their vaults. The fee → VPFI math is anchored end-to-end
        // in the active numeraire: `getAssetPrice(WETH)` returns
        // ETH/numeraire post-b1, multiplied by the fixed
        // `VPFI_PER_ETH_FIXED_PHASE1` peg gives a synthetic
        // VPFI/numeraire rate, and the stored fee divides directly. No
        // USD-intermediate is involved at any step (the per-knob
        // `notificationFeeUsdOracle` was retired in Numeraire generalization (Phase 1);
        // the `INumeraireOracle` abstraction was retired in b1).
        uint256 notificationFee; // 0 ⇒ NOTIFICATION_FEE_DEFAULT (2e18)
        // ── T-034 / b1 — Periodic Interest Payment config ─────────────
        // See docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md §6.
        //
        // The numeraire identity is captured by the feed-side slots at
        // the top-level Storage struct (`ethNumeraireFeed`,
        // `numeraireChainlinkDenominator`, `numeraireSymbol`) — there
        // is no longer a dedicated "numeraire oracle" contract. The
        // post-Numeraire-generalization design has `OracleFacet.getAssetPrice` return
        // numeraire-quoted prices natively; comparison sites compare
        // numeraire-vs-numeraire without any boundary conversion.
        // Principal threshold for opting into a finer-than-mandatory
        // cadence. Stored in numeraire-units (1e18-scaled). 0 ⇒
        // PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_DEFAULT. Range
        // `[PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_FLOOR,
        //   PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_CEIL]` enforced
        // by both setters. Read at `createOffer` to gate Filter 2.
        uint256 minPrincipalForFinerCadence; // 0 ⇒ default
        // Pre-notify lead time, in days. Single knob shared between
        // the maturity pre-notify lane and the new periodic-checkpoint
        // pre-notify lane in the off-chain hf-watcher. 0 ⇒
        // PERIODIC_PRE_NOTIFY_DAYS_DEFAULT (3). Range
        // `[PERIODIC_PRE_NOTIFY_DAYS_FLOOR, PERIODIC_PRE_NOTIFY_DAYS_CEIL]`
        // enforced by `ConfigFacet.setPreNotifyDays`.
        uint8 preNotifyDays; // 0 ⇒ default 3
        // Master kill-switch for the entire Periodic Interest Payment
        // mechanic. Default `false` — the feature ships dormant. While
        // `false`:
        //   - `OfferFacet.createOffer` reverts `PeriodicInterestDisabled`
        //     for any non-`None` cadence.
        //   - `RepayPeriodicFacet.settlePeriodicInterest` reverts wholesale (PR2).
        //   - `RepayFacet.repayPartial` interest-first fold + inline
        //     checkpoint advance is bypassed (PR2).
        //   - Every cadence-aware UI surface in the frontend is hidden.
        // Flipped on by `ADMIN_ROLE` via
        // `ConfigFacet.setPeriodicInterestEnabled(bool)` once governance
        // is ready to activate the feature mesh-wide. See §10.1 of the
        // design doc for the full behavior matrix.
        bool periodicInterestEnabled;
        // Independently gates the atomic batched `setNumeraire` setter.
        // Default `false` — a fresh deploy ships USD-as-numeraire (the
        // ETH/USD Chainlink feed pointed at by `s.ethNumeraireFeed`,
        // empty `s.numeraireSymbol` interpreted as "usd") and
        // governance cannot rotate to a different numeraire until this
        // flag flips. Threshold-only updates via
        // `setMinPrincipalForFinerCadence(uint256)` and the per-knob
        // setters are NOT gated by this flag — governance can tune
        // individual values within the same numeraire freely.
        bool numeraireSwapEnabled;
        // ── Depth-tiered LTV (Piece B) — governance globals ───────────
        // See docs/DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md
        // §4.2-§4.3. Every field is `0 ⇒ LibVaipakam constant default`;
        // setters live in {ConfigFacet} under `ADMIN_ROLE` (later
        // governance) and enforce the bounds + monotonicity noted below.
        //
        // Master kill-switch. Default `false` — the feature ships
        // dormant: `OracleFacet.getLiquidityTier` still computes a tier
        // (so the keeper / UI can read it) but the init gate in
        // `LoanFacet._runInitGates` and the synthetic-HF check in
        // `LibOfferMatch` ignore the per-tier LTV cap entirely → exactly
        // today's behaviour (only `assetRiskParams.loanInitMaxLtvBps` + the
        // `HF ≥ 1.5` floor). Flipped on per chain by `ADMIN_ROLE` via
        // `ConfigFacet.setDepthTieredLtvEnabled(bool)` only after that
        // chain's slippage census + audit (§4.4 step 6).
        bool depthTieredLtvEnabled;
        // Slippage budget (bps) a simulated fixed-size swap must clear
        // for the asset's pool to count toward a tier. 0 ⇒
        // LIQUIDITY_SLIPPAGE_BPS_DEFAULT (200 = 2%). Bounded
        // [MIN_LIQUIDITY_SLIPPAGE_BPS, MAX_LIQUIDITY_SLIPPAGE_BPS].
        uint16 liquiditySlippageBps; // 0 ⇒ 200
        // Pool spot-vs-own-TWAP agreement band (bps) — anti-manipulation
        // guard in `getLiquidityTier`. 0 ⇒ TWAP_CONSISTENCY_BPS_DEFAULT
        // (300 = 3%). Bounded [MIN_TWAP_CONSISTENCY_BPS, MAX_…].
        uint16 twapConsistencyBps; // 0 ⇒ 300
        // Per-tier max init-LTV caps (bps), applied as
        // `min(assetRiskParams.loanInitMaxLtvBps, tierNMaxInitLtvBps[
        // effectiveTier])` while `depthTieredLtvEnabled`. 0 ⇒
        // TIER{1,2,3}_MAX_INIT_LTV_BPS_DEFAULT (5000 / 6000 / 6500).
        // Setter enforces `tier1 ≤ tier2 ≤ tier3 ≤ MAX_TIER_INIT_LTV_BPS_CEIL`.
        uint16 tier1MaxInitLtvBps; // 0 ⇒ 5000
        uint16 tier2MaxInitLtvBps; // 0 ⇒ 6000
        uint16 tier3MaxInitLtvBps; // 0 ⇒ 6500
        // TWAP observation window (seconds) for the consistency guard.
        // 0 ⇒ TWAP_WINDOW_SEC_DEFAULT (1800 = 30 min). Bounded
        // [MIN_TWAP_WINDOW_SEC, MAX_TWAP_WINDOW_SEC].
        uint32 twapWindowSec; // 0 ⇒ 1800
        // Simulated-swap test sizes for the binary `Liquid` floor and
        // the three graded tiers, each in PAD × 1e6 units (so `5_000e6`
        // literally means "5,000 PAD" — USD on the retail deploy,
        // whatever governance has rotated PAD to via T-048 otherwise;
        // see {effectivePadSymbol}). 0 ⇒ FLOOR_SIZE_PAD_DEFAULT /
        // TIER{1,2,3}_SIZE_PAD_DEFAULT (5k / 50k / 500k / 5M). Setter
        // enforces `floor ≤ tier1 ≤ tier2 ≤ tier3` and each ≥
        // MIN_TIER_SIZE_PAD. (`floorSizePad` becomes the `Liquid`/`Illiquid`
        // threshold once the §4.4-step-3-proper slippage rework lands;
        // until then `MIN_LIQUIDITY_PAD` is that threshold.)
        uint64 floorSizePad; // 0 ⇒ 5_000e6
        uint64 tier1SizePad; // 0 ⇒ 50_000e6
        uint64 tier2SizePad; // 0 ⇒ 500_000e6
        uint64 tier3SizePad; // 0 ⇒ 5_000_000e6
        // ── Flash-loan / liquidator-buys-at-discount path ─────────────
        // See docs/DesignsAndPlans/FlashLoanLiquidationPath.md §6.
        // Master kill-switch — default `false` ⇒
        // `RiskFacet.triggerLiquidationDiscounted` reverts immediately
        // with `DiscountPathDisabled`. Independent of
        // `depthTieredLtvEnabled` so governance can flip each one
        // separately per chain (e.g. enable discount path while
        // autonomous-LTV still bakes, or vice versa). Flipped on via
        // `ConfigFacet.setDiscountPathEnabled(bool)` — ADMIN_ROLE
        // pre-handover, TimelockController-gated post-handover.
        bool discountPathEnabled;
        // Per-tier liquidator-discount (BPS) — applied to the seized
        // collateral value at settle time. Each `0 ⇒ TIER{N}_LIQ_
        // DISCOUNT_DEFAULT_BPS` library constant (770 / 600 / 500).
        // Setter (`setTierLiqDiscountBps`) bounds each tier inside
        // `[TIER{N}_LIQ_DISCOUNT_FLOOR_BPS, TIER{N}_LIQ_DISCOUNT_CEIL_BPS]`
        // and enforces the cross-tier monotonic invariant
        // `T1 ≥ T2 ≥ T3` (thinner tier = wider discount). A fresh
        // deploy never touches these slots ⇒ the library defaults
        // apply until governance overrides.
        uint16 tier1LiqDiscountBps; // 0 ⇒ 770
        uint16 tier2LiqDiscountBps; // 0 ⇒ 600
        uint16 tier3LiqDiscountBps; // 0 ⇒ 500
        // Per-tier LIQUIDATION threshold (PR2 of internal-match work):
        // the LTV at which a loan becomes liquidatable, indexed by the
        // collateral asset's liquidity tier (deepest-first). Each `0 ⇒
        // DEFAULT_TIER{N}_LIQUIDATION_LTV_BPS` library constant (9000 /
        // 8500 / 8000). Setter (`setTierLiquidationLtvBps`) bounds each
        // value inside `[MIN_TIER_LIQUIDATION_LTV_BPS,
        // MAX_TIER_LIQUIDATION_LTV_BPS]` and enforces the cross-tier
        // monotonic invariant `T1 ≥ T2 ≥ T3` (deeper liquidity tier
        // tolerates higher pre-liquidation LTV). Snapshotted to each
        // loan at `initiateLoan` onto `Loan.liquidationLtvBpsAtInit`,
        // so subsequent admin tunes never re-gate existing loans.
        uint16 tier1LiquidationLtvBps; // 0 ⇒ 9000
        uint16 tier2LiquidationLtvBps; // 0 ⇒ 8500
        uint16 tier3LiquidationLtvBps; // 0 ⇒ 8000
        // ── Internal-liquidation match path (B.2) governance globals ──
        // See docs/DesignsAndPlans/InternalLiquidationLedger.md §0.
        //
        // Master kill-switch. Default `false` ⇒ the view-only
        // `MetricsFacet.getMatchEligibleLoans` returns empty AND
        // the priority-window gate inside `triggerLiquidation`
        // short-circuits (external stays callable everywhere). The
        // matching entry point (PR4+) ALSO checks this flag and
        // reverts `InternalMatchDisabled` while it's off. Flipped on
        // per chain by `ADMIN_ROLE` via
        // `ConfigFacet.setInternalMatchEnabled(bool)` once that
        // chain's matcher-bot infra is live.
        bool internalMatchEnabled;
        // GLOBAL — LTV window above each loan's per-tier liquidation
        // threshold where external `triggerLiquidation` reverts so
        // internal matchers get a clean priority slot. `0` ⇒
        // DEFAULT_EXTERNAL_LIQUIDATION_PRIORITY_WINDOW_BPS (200 = 2%
        // LTV window). Setter range
        // `[MIN_EXTERNAL_LIQUIDATION_PRIORITY_WINDOW_BPS,
        //   MAX_EXTERNAL_LIQUIDATION_PRIORITY_WINDOW_BPS]` (0 – 5%).
        uint16 externalLiquidationPriorityWindowBps;
        // GLOBAL — % withheld from each matched leg's transferred
        // collateral and paid to the calling bot (`msg.sender`). 1%
        // default; 3% cap keeps even worst-case bot take below the
        // 5–7.7% external-liquidation discount borrowers would
        // otherwise pay. `0` ⇒ DEFAULT_INTERNAL_MATCH_INCENTIVE_BPS_PER_LEG.
        uint16 internalMatchIncentivePerLegBps;
        // ── Treasury-conversion (T-600) eligibility thresholds ─────────
        // The convert *target allocation* itself is the fully
        // governance-configurable `s.treasuryConvertTargets` list (see
        // `TreasuryConvertTarget`); only the eligibility thresholds live
        // on the packed config.
        //
        // Per-token numeraire-value (1e18) accumulation threshold that
        // makes a treasury conversion eligible. 0 ⇒
        // TREASURY_CONVERT_USD_THRESHOLD_DEFAULT ($10k).
        uint256 treasuryConvertUsdThreshold; // 0 ⇒ default
        // Max days between conversions — the time-based leg of the
        // eligibility gate (fires whichever comes first). 0 ⇒
        // TREASURY_CONVERT_MAX_INTERVAL_DAYS_DEFAULT (30).
        uint32 treasuryConvertMaxIntervalDays; // 0 ⇒ default
        // T-090 — Borrower-initiated swap-to-repay slippage ceiling.
        // 0 ⇒ MAX_SWAP_TO_REPAY_SLIPPAGE_BPS (300 = 3%). Sibling to
        // `maxLiquidationSlippageBps` (default 600 = 6%); tighter cap
        // because the caller is the borrower, not an adversarial
        // liquidator on a clock. Bounded by `MAX_SLIPPAGE_BPS` (2500 =
        // 25%) at the `ConfigFacet.setMaxSwapToRepaySlippageBps`
        // setter — same ceiling that guards the liquidation knob.
        uint16 maxSwapToRepaySlippageBps; // 0 ⇒ default

        // ── T-092 (#508) — auto-lifecycle admin kill switches ─────────
        // Three break-glass toggles for the auto-lend / auto-
        // refinance / auto-extend surfaces. All default `false` on
        // a fresh deploy (per-user consent flags + the feature
        // setters still work, but the actual auto-paths revert).
        // Admin flips to `true` post-deploy after the testnet bake.
        // Mirrors the `rangeAmountEnabled` / `partialFillEnabled` /
        // `cfgKeeperRewardEnabled` pattern: feature ships off,
        // governance turns on, governance can break-glass off
        // again if a bug surfaces. Setters live on `ConfigFacet`
        // (admin-only; migrates to `TimelockController` on the
        // governance handover path).
        bool cfgAutoLendEnabled;
        bool cfgAutoRefinanceEnabled;
        bool cfgAutoExtendEnabled;
        // ── #393 v1 — LenderIntentVault master kill-switch ────────────
        // Gates the standing-intent fill path (`OfferMatchFacet.matchIntent`).
        // Default `false` on a fresh deploy: a user can `setLenderIntent`
        // (register standing terms) but no fill executes until governance
        // flips this on post-bake. Same ship-off / governance-on / break-
        // glass-off pattern as `partialFillEnabled` / `internalMatchEnabled`.
        // Setter `ConfigFacet.setLenderIntentEnabled(bool)` (ADMIN_ROLE).
        bool lenderIntentEnabled;
        // ── #399 backstop v0 (Role A) kill-switches — both default OFF ──────
        // Master pause for the treasury backstop (both roles). `backstopFillEnabled`
        // gates Role A (auto-counterparty) independently so it can be paused without
        // touching Role B (the v2 absorb path, gated by a separate
        // `backstopAbsorbEnabled` flag added in PR 2). See
        // `docs/DesignsAndPlans/BackstopVaultV0Design.md` §6.
        bool backstopEnabled;
        bool backstopFillEnabled;
        // Minimum seconds an offer must sit before its `backstopEligibleAfter`
        // can fire (mandatory floor in the createOffer validation, §4.1). 0 ⇒
        // the library default `BACKSTOP_MIN_DELAY_DEFAULT`.
        uint64 minBackstopDelay;
        // ── #399 backstop v0 (Role B) kill-switch — default OFF ─────────────
        // Gates Role B (liquidator-of-last-resort, the cash buyout of a
        // FallbackPending loan via `claimAsLenderViaBackstop`) INDEPENDENTLY of
        // Role A's `backstopFillEnabled`, so the much-riskier absorb path can be
        // staged/paused on its own — an absorb incident must not force disabling
        // Role A, and vice-versa. Still subordinate to the `backstopEnabled`
        // master pause. See BackstopVaultV0Design.md §6.
        bool backstopAbsorbEnabled;
        // ── #633 admin/governance kill-switches over CURRENTLY-ON features ──
        // PAUSE semantics (not enable): default `false` = feature ACTIVE, so a
        // fresh deploy preserves current behaviour with no init and no test
        // breakage; admin/governance flips to `true` to disable in an incident
        // (→ Governance Safe / Timelock after handover). Distinct from the
        // `*Enabled` flags above, which gate OFF-by-default features.
        //
        // Freezes the #398 ERC-4626 aggregator-adapter feature: new-adapter
        // onboarding (`createAggregatorAdapter` / `publishAdapterImplementation`)
        // AND fills of an existing adapter's intent (gated in `matchIntent` on
        // `isAggregatorAdapter[lender]`). Narrower than the blunt
        // `lenderIntentEnabled` master, which also freezes user intents + backstop.
        bool aggregatorAdaptersPaused;
        // Global keeper pause: freezes every DELEGATED keeper action
        // (`LibAuth.requireKeeperFor` / `requireKeeperForPrincipal` + the
        // `KEEPER_ROLE` backstop absorb) protocol-wide. NFT owners can still act
        // on their own positions directly (the owner short-circuit runs first);
        // permissionless HF-liquidation is intentionally NOT gated (must stay
        // always-available). Complements the per-user `keeperAccessEnabled[user]`.
        bool keepersPaused;
        // Freezes the optional peer-protocol LTV reads (Aave / Compound, via
        // `LibPeerLTV` in `OracleFacet.refreshTierLtvCache`) so the depth-tiered
        // LTV falls back to the governance-set defaults if a peer source is
        // compromised. Does NOT touch the protocol's own core oracle / liquidity
        // layer (that's governed separately by the oracle-admin config + the
        // multi-venue quorum, not an optional peer dependency).
        bool peerLtvReadsPaused;
        // NOTE: #395 graduated partial-liquidation sizing knobs are NOT here —
        // appending to `ProtocolConfig` (embedded before live `Storage` fields
        // like `borrowerLifRebate` / `swapAdapters`) would shift every
        // subsequent top-level slot. They live at the append-only TAIL of
        // `Storage` instead (search `partialLiqTargetHfCeilingBps`).
    }

    /// @notice #393 v1 — a lender's STANDING INTENT: set-and-forget lending
    ///         terms a permissioned solver materializes concrete offers within,
    ///         consuming the lender's existing per-user vault balance. The
    ///         lender-of-record stays the depositing user (`loan.lender` = the
    ///         intent owner), so every downstream claim / VPFI / KYC / sanctions
    ///         site is unchanged — the vault is NOT the lender. See
    ///         docs/DesignsAndPlans/LenderIntentVaultV1Design.md §1.
    /// @dev    ERC-20-on-ERC-20 only (v1). One intent per (owner, lendingAsset,
    ///         collateralAsset) — keyed by `lenderIntent[owner][lendingAsset][collateralAsset]`.
    ///         Bounds are a HARD band a solver's concrete `matchIntent` terms
    ///         must fall within; the protocol HF/LTV init gate still applies on
    ///         top. Reservation of in-flight principal reuses the encumbrance
    ///         sub-ledger (#407) via the materialized slice offer's principal
    ///         lien — no new lock type.
    struct LenderIntent {
        bool active; // false ⇒ no standing intent (default / cancelled)
        uint256 maxExposure; // hard cap on aggregate LIVE principal out from this intent
        uint256 minRateBps; // APR floor — a fill below this is rejected
        uint16 maxInitLtvBps; // the lender's own init-LTV ceiling (on top of the protocol gate)
        uint32 maxDurationDays; // longest loan term the lender will accept
        uint256 minFillAmount; // smallest slice a solver may fill (dust floor; > 0)
        bool requiresKeeperAuth; // true ⇒ only an opted-in solver may fill (v1-c gate)
    }

    /// @dev #625 WI-2a — the (owner, lendingAsset, collateralAsset) triple that keys a
    ///      `LenderIntent`, stored so the `activeIntentKeys` enumerable set can be resolved
    ///      back to a concrete intent by `getActiveLenderIntents`.
    struct IntentKey {
        address owner;
        address lendingAsset;
        address collateralAsset;
    }

    /// @dev #625 WI-2a — canonical key hash for the active-intent registry. The ONE place
    ///      the (owner, lend, coll) → bytes32 mapping is defined, so the maintenance sites
    ///      (`setLenderIntent` add / `cancelLenderIntent` remove) and the read view can
    ///      never disagree on the key.
    function intentKeyHash(
        address owner,
        address lendingAsset,
        address collateralAsset
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, lendingAsset, collateralAsset));
    }

    /// @dev #625 WI-2a — keep the active-intent discovery registry
    ///      (`getActiveLenderIntents`) in sync with an intent's (active, funded) state.
    ///      The feed advertises ONLY intents that are active AND have funded capital, so
    ///      (a) a keeper never pages a zero-capital row, and (b) a bare zero-capital
    ///      registration can't bloat the global feed — entering it costs committed
    ///      capital. SHARED in this library (not a facet-private helper) so EVERY
    ///      `(active | capital)` transition can call it: `setLenderIntent` /
    ///      `cancelLenderIntent` / `fundLenderIntent` / `withdrawLenderIntentCapital` /
    ///      `rollIntentLoan` (LenderIntentFacet), `matchIntent` (OfferMatchFacet, the
    ///      fill draw-down), and the backstop's direct seeding (BackstopFacet). Call it
    ///      after EVERY `lienIntentCapital` / `unlienIntentCapital` / active flip;
    ///      idempotent (add/remove are no-ops when membership already matches).
    function syncIntentRegistry(
        address owner,
        address lendingAsset,
        address collateralAsset
    ) internal {
        Storage storage s = storageSlot();
        LenderIntent storage intent =
            s.lenderIntent[owner][lendingAsset][collateralAsset];
        bytes32 ik = intentKeyHash(owner, lendingAsset, collateralAsset);
        uint256 capital =
            s.lenderIntentCapital[owner][lendingAsset][collateralAsset];

        // #755 — per-OWNER registry: list while the intent EXISTS for the
        // lender to manage in the dapp — `active` OR carrying reserved capital
        // (a PAUSED intent) — and drop it only once fully torn down (inactive
        // AND no reserved capital). Broader than the global feed below, and the
        // first place the key->tuple resolution is recorded (active or funded
        // both imply owner-listed, so the global feed can read the tuple
        // without re-stamping it).
        if (intent.active || capital > 0) {
            if (s.ownerIntentKeys[owner].add(ik)) {
                s.intentKeyTuple[ik] = IntentKey({
                    owner: owner,
                    lendingAsset: lendingAsset,
                    collateralAsset: collateralAsset
                });
            }
        } else {
            s.ownerIntentKeys[owner].remove(ik);
        }

        // Global keeper feed (#625 WI-2a): list ONLY if active AND funded enough
        // for at least one VALID fill: a fill must be >= minFillAmount AND <=
        // available capital, so available capital below `minFillAmount` means no
        // fill is possible — don't advertise an unfillable intent (Codex WI-2a
        // r3). `intentKeyTuple` is already set by the per-owner branch above
        // (active ⇒ owner-listed).
        if (intent.active && capital >= intent.minFillAmount) {
            s.activeIntentKeys.add(ik);
        } else {
            s.activeIntentKeys.remove(ik);
        }
    }

    /// @notice #625 WI-2c — register/deregister an intent-originated loan in the
    ///         `activeIntentLoans` roll-discovery set. Called at the SET site
    ///         (`OfferMatchFacet.matchIntent`, when `intentOrigin` is written) and
    ///         both CLEAR sites (`LenderIntentFacet.releaseIntentExposure` — the
    ///         shared claim/withdraw/consolidation terminal hook — and
    ///         `LenderIntentFacet.rollIntentLoan`), so the set tracks EXACTLY the
    ///         loans with a live `intentOrigin`. Defined here because the
    ///         `using EnumerableSet for EnumerableSet.UintSet` directive lives in
    ///         this library; idempotent (EnumerableSet add/remove no-op on a
    ///         present/absent key).
    function addIntentLoan(uint256 loanId) internal {
        storageSlot().activeIntentLoans.add(loanId);
    }

    function removeIntentLoan(uint256 loanId) internal {
        storageSlot().activeIntentLoans.remove(loanId);
    }

    /// @dev Struct to store parameters of createOffer function, avoiding stack-too-deep.
    struct CreateOfferParams {
        OfferType offerType;
        address lendingAsset;
        uint256 amount;
        uint256 interestRateBps;
        address collateralAsset;
        uint256 collateralAmount;
        uint256 durationDays;
        AssetType assetType;
        uint256 tokenId;
        uint256 quantity;
        // Creator's agreement to the liquidation-fallback terms (abnormal-market
        // fallback + illiquid full-collateral transfer). Mandatory on every
        // offer — `createOffer` reverts when false.
        bool creatorRiskAndTermsConsent;
        address prepayAsset;
        AssetType collateralAssetType;
        uint256 collateralTokenId;
        uint256 collateralQuantity;
        // Phase 6: keeper access is now per-keeper-per-offer via
        // `offerKeeperEnabled[offerId][keeper]`. No single keeper bool on
        // the params; the creator enables specific keepers after create
        // (or before acceptance) via `ProfileFacet.setOfferKeeperEnabled`.

        // Lender-controlled gate for borrower-initiated partial repay
        // (`RepayFacet.repayPartial`). Semantics differ by offer side:
        //   - Lender offer: lender at create says "I allow my borrower
        //     to partial-repay". Borrower's accept = consent.
        //   - Borrower offer: borrower at create says "I want the option
        //     to partial-repay". Lender's accept = consent.
        // In both cases the offer is a take-it-or-leave-it package; an
        // acceptor who disagrees with the flag simply doesn't accept.
        // Snapshotted onto `Loan.allowsPartialRepay` at loan init and
        // enforced at the top of `RepayFacet.repayPartial`. Default
        // `false` is the Phase-1-safe behaviour: explicit opt-in only.
        bool allowsPartialRepay;
        // ── Range Orders Phase 1 max fields (docs/RangeOffersDesign.md
        //    §2.2). Pair with the legacy `amount` / `interestRateBps`
        //    fields above (= the min). Auto-collapsed to single-value
        //    semantics when left at 0 — preserves backward compat with
        //    every existing test / script that builds CreateOfferParams.
        //    Range mode requires the corresponding master flag
        //    (`rangeAmountEnabled` / `rangeRateEnabled`) to be true on
        //    the protocol config; see §15 of the design doc.
        uint256 amountMax;
        uint256 interestRateBpsMax;
        // ── Issue #164 — borrower-side collateral range (mirrors
        //    `amountMax`). Lender offers stay single-value: the
        //    createOffer write-side rejects a lender offer with
        //    `collateralAmountMax > collateralAmount` (the field is
        //    auto-collapsed to `collateralAmount` so the storage
        //    invariant `collateralAmount == collateralAmountMax`
        //    always holds for lender offers). Borrower offers can
        //    range — leaving `collateralAmountMax == 0` auto-collapses
        //    to single-value semantics, preserving backward compat for
        //    every legacy borrower-side test / script.
        uint256 collateralAmountMax;
        // ── T-034 — Periodic Interest Payment cadence ─────────────────
        // Lender's chosen settlement cadence. Default `None` (zero in
        // the enum) preserves backward compat with every existing
        // CreateOfferParams construction site that doesn't set this
        // field. While `periodicInterestEnabled == false`, any non-`None`
        // value is rejected at `createOffer` with
        // `PeriodicInterestDisabled`. See
        // docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md §3.
        PeriodicInterestCadence periodicInterestCadence;
        // ── #195 — GTT / offer-expiry (Good-Till-Time) ──────────────────
        // Optional absolute unix-seconds deadline after which the offer
        // can no longer be accepted or matched. `0` is the GTC sentinel
        // (today's behaviour: lives until the creator cancels it).
        // Bounded at `createOffer` by `[block.timestamp + 1,
        // block.timestamp + MAX_OFFER_EXPIRY_HORIZON]`. The acceptance /
        // match paths read this field via `LibVaipakam.isOfferExpired`
        // and revert before any state mutation. Append-only at the end
        // of CreateOfferParams so the calldata layout grows additively
        // (no positional shift for legacy ABI consumers — Solidity
        // named-arg syntax still requires every caller to supply the
        // field explicitly).
        uint64 expiresAt;
        // ── #125 — DEX-style fill-mode flavour ──────────────────────────
        // `Partial` (= 0) is the GTC-equivalent default and the
        // backward-compat sentinel: every legacy `CreateOfferParams`
        // construction site that doesn't set this field gets today's
        // Range-Orders Phase-1 behaviour. `Aon` requires the create-time
        // single-value invariant (`amount == amountMax`); `Ioc` requires
        // `expiresAt > 0` (the window is the IOC's defining knob).
        FillMode fillMode;
        // ── T-086 step 4 — `allowsPrepayListing` lender-consent gate ────
        // Lender-controlled gate for the borrower's right to post a
        // Seaport-mediated prepay collateral listing on the loan's
        // collateral NFT while the loan is still active (the T-086
        // flow — see
        // `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md`).
        //
        // Semantics mirror `allowsPartialRepay`: it's part of the
        // take-it-or-leave-it offer package. An acceptor who disagrees
        // with the flag simply doesn't accept. Snapshotted onto
        // `Loan.allowsPrepayListing` at loan-init and enforced at the
        // top of the (step-6) `NFTPrepayListingFacet.postPrepayListing`
        // entry. Default `false` is the safe behaviour: explicit
        // opt-in only.
        bool allowsPrepayListing;
        // ── T-086 Round-8 (#358) §19.5 — `allowsParallelSale` opt-in ──
        //
        // Borrower-controlled gate for the offer's right to be exposed
        // for parallel (pre-loan) sale on OpenSea / Seaport-conformant
        // marketplaces. Codex P1 round-1 #4 caught the missing
        // `CreateOfferParams` wiring on the initial Round-8 ship: every
        // newly created offer kept `allowsParallelSale == false` so
        // `postParallelSaleListing` always reverted in production
        // (the §19.9 test suite only worked because it scaffolded
        // offers via `TestMutatorFacet`).
        //
        // Default `false` keeps the existing-borrower posture safe —
        // opting into a parallel sale is an explicit borrower action,
        // mirroring the `allowsPrepayListing` lender-consent pattern.
        // Only valid on `OfferType.Borrower` offers with NFT
        // collateral; OfferCreateFacet rejects the flag on lender /
        // non-NFT-collateral offers.
        bool allowsParallelSale;
        // T-092 Phase 2b (#506) — refinance target.
        // When non-zero, this offer is created with the intent of
        // refinancing loanId == refinanceTargetLoanId. The creator
        // must be the current borrower-NFT owner of that loan + the
        // loan must be Active at create time; the offer's terms are
        // validated against `autoRefinanceCaps[loanId]` at BOTH
        // create AND accept time so a keeper-driven acceptance
        // can't route the borrower into a worse rate / longer
        // obligation than they pre-approved. Default 0 = standard
        // borrower offer (no refinance intent).
        uint256 refinanceTargetLoanId;
        // ── #408 / #410 / #413 (2026-06-12) ───────────────────────
        // Lender's election for the floor-model interest settlement.
        // When `true` (the dapp builder default), every borrower-
        // initiated ERC20 settlement on the resulting loan applies
        // the FULL-TERM FLOOR:
        //   gross = proRataInterest(P, rate, max(elapsedDays, durationDays))
        //   net   = gross - interestSettled (saturating at 0)
        //
        // When `false` (lender opt-out for "soft" loans),
        // floorDays = 0 → pure pro-rata-elapsed. Both branches still
        // accrue through grace + late fee.
        //
        // Carries through `OfferCreateFacet._writeOfferPrincipalFields`
        // into the existing `Offer.useFullTermInterest` field, then
        // `LoanFacet.initiateLoan:792` snapshots into
        // `Loan.useFullTermInterest`. Pre-#408 the params side
        // didn't exist; the offer + loan fields were stranded as
        // unreachable dead code, so `settlementInterest` always
        // returned pro-rata regardless of intent.
        bool useFullTermInterest;
    }

    /// @notice #193 — input bundle for `OfferMutateFacet.modifyOffer`.
    ///         Carries the post-mutation value for every field the
    ///         three setters can touch, so the combined helper can
    ///         atomically replay the same invariant set without
    ///         needing per-field sentinels. Callers supply the
    ///         existing value for fields they don't intend to change;
    ///         the frontend reads `getOffer(offerId)` first anyway,
    ///         so re-passing the unchanged values is free at the call
    ///         site and avoids the "0 means don't change" ambiguity
    ///         that would conflict with legitimate zero rates.
    /// @dev    Fields that aren't part of the modify surface
    ///         (`durationDays`, `lendingAsset`, asset types, `expiresAt`,
    ///         `prepayAsset`, `tokenId`/`quantity`, `allowsPartialRepay`,
    ///         `periodicInterestCadence`, `creatorRiskAndTermsConsent`)
    ///         are explicitly excluded — modifying them would change
    ///         the offer's economic contract in ways `OfferMutateFacet`
    ///         doesn't currently model.
    struct OfferModifyParams {
        uint256 amount;
        uint256 amountMax;
        uint256 interestRateBps;
        uint256 interestRateBpsMax;
        uint256 collateralAmount;
        uint256 collateralAmountMax;
    }

    /**
     * @notice Struct for an offer (lender or borrower).
     * @dev Stores details for matching and loan initiation.
     *      Liquidity determined at creation.
     *      Accepted flag prevents re-acceptance.
     */
    struct Offer {
        // Slot 0
        uint256 id;
        // Slot 1: creator(20) + 10 small fields (10) + 1 enum (1)
        //         + 1 enum (1) #125 = 32 bytes packed; 0 free
        address creator;
        OfferType offerType;
        LiquidityStatus principalLiquidity;
        LiquidityStatus collateralLiquidity;
        bool accepted;
        AssetType assetType;
        bool useFullTermInterest;
        bool creatorRiskAndTermsConsent;
        AssetType collateralAssetType;
        // Carried into `Loan.allowsPartialRepay` at offer acceptance.
        // See {CreateOfferParams.allowsPartialRepay} for full semantics.
        bool allowsPartialRepay;
        // ── T-034 — Periodic Interest Payment cadence ─────────────────
        // Lender's chosen settlement cadence (None for terminal-only).
        // Validated at `createOffer` per the matrix in
        // docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md §3 — three
        // filters: liquid-both precondition, interval < duration, and
        // duration-vs-threshold gating. Snapshotted onto `Loan` at
        // acceptance and immutable for the loan's lifetime.
        PeriodicInterestCadence periodicInterestCadence;
        // ── #125 — DEX-style fill-mode flavour ─────────────────────────
        // `Partial` (default 0) preserves Range-Orders Phase-1 behaviour
        // exactly for every legacy storage row (zero-init = Partial).
        // `Aon` makes the match path reject any non-full fill; `Ioc`
        // pairs with `expiresAt` to bound the fill window. Stamped
        // once at `createOffer` and immutable for the offer's
        // lifetime (mutation surface in #193 does not touch this
        // field; changing fill mode mid-life would alter the offer's
        // economic contract). Packs into slot 1 using the 1 byte of
        // headroom carried since the original Offer struct layout.
        FillMode fillMode;
        // Slot 2
        address lendingAsset; // ERC20 or NFT contract
        // Slot 3
        uint256 amount; // Principal/rental fee
        // Slot 4
        uint256 interestRateBps; // Basis points for interest/rental rate
        // Slot 5
        address collateralAsset; // ERC20 or NFT contract address
        // Slot 6
        uint256 collateralAmount;
        // Slot 7
        uint256 durationDays;
        // Slot 8
        uint256 tokenId; // For NFT721/1155; 0 for ERC20 — always the underlying asset token ID
        // Slot 9
        uint256 positionTokenId; // Vaipakam position NFT minted at offer creation
        // Slot 10
        uint256 quantity; // For ERC1155; 1 for ERC721; 0 for ERC20
        // Slot 11
        address prepayAsset; // ERC20 for NFT rental fees (e.g., USDC); address(0) for ERC20 loans
        // Slot 12
        uint256 collateralTokenId; // Token ID for NFT collateral; 0 for ERC20
        // Slot 13
        uint256 collateralQuantity; // Quantity for ERC1155 collateral; 0 for ERC20/ERC721
        // ── Range Orders Phase 1 fields (append-only; see
        //    docs/RangeOffersDesign.md §2.1). The legacy `amount` and
        //    `interestRateBps` fields above semantically equal the MIN
        //    of each range; the matching new field is the inclusive max.
        //    A single-value offer satisfies `amountMax == amount` and
        //    `interestRateBpsMax == interestRateBps`. Auto-collapsed at
        //    `createOffer` time when the caller leaves the max field
        //    zero so existing single-value tests / scripts compile + run
        //    unchanged.
        // Slot 14
        uint256 amountMax; // ≥ amount (= the min); 0 ⇒ collapse to amount at create.
        // Slot 15 — cumulative principal consumed across all matches
        //          against this offer. Lender-side partial fills only;
        //          borrower offers stay at 0 (Phase 1 single-fill).
        uint256 amountFilled;
        // Slot 16
        uint256 interestRateBpsMax; // ≥ interestRateBps; 0 ⇒ collapse to interestRateBps.
        // Slot 17 — packed: createdAt(8) + expiresAt(8) + 16 bytes headroom
        uint64 createdAt; // Unix-seconds; stamped at createOffer.
        // ── #195 — GTT / offer-expiry ──────────────────────────────────
        // Optional absolute unix-seconds deadline. `0` is the GTC
        // sentinel (preserves pre-#195 behaviour exactly: every legacy
        // storage row reads `expiresAt == 0` because the slot is in
        // the 16-byte headroom of slot 17, which was zeroed at create).
        // Reads on the accept / match paths flow through
        // `LibVaipakam.isOfferExpired(offer)` so the GTC short-circuit
        // is in one place. Stamped once at createOffer; never mutated.
        uint64 expiresAt;
        // ── Issue #164 — borrower-side collateral range. Append-only
        //    at the end of the Offer struct so the storage layout
        //    stays additive (no slot re-ordering). The legacy
        //    `collateralAmount` above semantically equals the MIN of
        //    the range on borrower offers (lender offers keep
        //    `collateralAmount == collateralAmountMax` as a structural
        //    invariant — see CreateOfferParams.collateralAmountMax for
        //    the createOffer-time enforcement). A single-value offer
        //    satisfies `collateralAmountMax == collateralAmount`;
        //    auto-collapsed when the caller leaves the new field at 0.
        //    Lender side stays single-value because the lender's
        //    `collateralAmount` slot already represents their derived
        //    requirement (at `amountMax`); a max wouldn't add meaning.
        // Slot 18 — ≥ collateralAmount; 0 ⇒ collapse to collateralAmount at create.
        uint256 collateralAmountMax;
        // Slot 19 — cumulative collateral consumed across all matches
        //          against this offer. Borrower-side partial-fills are
        //          NOT enabled in Phase 1 (mirrors `amountFilled`), so
        //          this field stays 0 across all Phase 1 borrower
        //          matches. Wired in for #102 (borrower partial-fill)
        //          to start writing — adding the slot now keeps the
        //          storage layout stable across the #164 → #102 step.
        uint256 collateralAmountFilled;
        // ── T-086 step 4 — `allowsPrepayListing` lender consent ─────────
        // Slot 20 (packed: 1 byte of a fresh slot). Append-only field;
        // copied verbatim from `CreateOfferParams.allowsPrepayListing`
        // at `createOffer` time and snapshotted onto
        // `Loan.allowsPrepayListing` at loan-init. While `false`
        // (the default), the (step-6) `NFTPrepayListingFacet` MUST
        // reject `postPrepayListing` calls for any loan created from
        // this offer. See
        // `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md` §13
        // step 4 for the full lifecycle.
        bool allowsPrepayListing;
        // ── T-086 Round-8 (#358) — borrow-OR-sell parallel-sale opt-in ──
        // Slot 20 byte 2 (packed). Append-only field; borrower's
        // explicit opt-in at offer-create that the offer's collateral
        // NFT may sit on a Seaport pre-loan listing in parallel to
        // the offer being open for lender acceptance. Whichever path
        // fires first (lender-accept vs buyer-fill) wins; the other
        // is structurally blocked. Round-3.7 against Codex round-7
        // P2 line 4979 — this flag is floor-load-bearing for the
        // §19.7 mutation lock (toggling it off mid-listing would
        // orphan a fillable Seaport order; OfferMutateFacet.updateOffer
        // rejects mutation when `s.offerPrepayListingOrderHash[offerId]
        // != bytes32(0)`). See
        // `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md` §19.5.
        bool allowsParallelSale;
        // Slot 21 — pre-loan Seaport orderHash, populated when
        // `allowsParallelSale == true` AND the borrower has called
        // `postParallelSaleListing` after offer-create. Mirrors the
        // diamond's `s.offerPrepayListingOrderHash[offerId]` mapping
        // for offer-terms visibility (indexers / lenders reading the
        // offer's terms see this directly). Cleared on every offer-
        // keyed cleanup path (sale-settle, lender-accept teardown,
        // borrower-cancel, expired-offer, release-lock); the §19.7c
        // shared `LibPrepayCleanup.clearOfferListing` primitive
        // touches this slot AND the mapping in lockstep.
        bytes32 parallelSaleOrderHash;
        // Slot 22 — T-092 Phase 2b (#506) — refinance target loan
        // id. Append-only field, copied verbatim from
        // `CreateOfferParams.refinanceTargetLoanId` at create-time.
        // Reads at create + accept time gate the offer against
        // `autoRefinanceCaps[refinanceTargetLoanId]`. Non-zero
        // implies this is a refinance-tagged Borrower offer; the
        // cap-check fires automatically. See AutoLifecycleFacet
        // for the consent surface that populates the caps.
        uint256 refinanceTargetLoanId;
        // Slot 23 (packed: 1 byte of a fresh slot) — #576 PERSISTED
        // collateral carry-over decision. Computed ONCE at `createOffer`
        // (after `LibAutoRefinanceCheck.validate`) from the full carry-over
        // predicate (tagged + non-transferred + single-value + live old-loan
        // lien + exact collateral identity) and never recomputed. Every later
        // consumption site — the create-time deposit/escrow-lock skips, the
        // loan-init collateral-lien skip, the cancel refund skip, and
        // `RefinanceFacet`'s retag-vs-legacy fork — reads THIS flag rather than
        // re-deriving from mutable state. Re-derivation was unsafe: the target
        // loan's `borrower` can change (`transferObligationViaOffer`) and its
        // lien can be released between create and the later sites, flipping a
        // recomputed predicate and desyncing it from the physical vault (a
        // carry-over offer deposited NO collateral, so a flipped "not
        // carry-over" read would withdraw/settle a batch that never existed).
        bool refinanceCarryOver;
        // Slot 23 (packed alongside refinanceCarryOver) — #399 backstop v0
        // (Role A). Borrower's opt-in deadline after which the treasury
        // backstop may auto-fill this still-valid-but-unmatched offer
        // (`BackstopFacet.backstopFill`). `0` ⇒ NOT backstop-eligible (default).
        // Non-zero is validated at `createOffer` as
        // `>= block.timestamp + minBackstopDelay && < expiresAt` (a genuine
        // unmatched interval before the offer dies — never a first-choice
        // route), AND the offer must be intent-fillable
        // (`useFullTermInterest == true && allowsPartialRepay == false`, since
        // the backstop fills via `matchIntent`). Append-only; flat (no
        // sub-structing — viaIR stack). See
        // `docs/DesignsAndPlans/BackstopVaultV0Design.md` §4.1.
        uint64 backstopEligibleAfter;
        // Slot 23 (packed alongside refinanceCarryOver + backstopEligibleAfter)
        // — #1193 (Pass-2 D3) NFT-rental buffer BPS snapshotted at create.
        // The prepay a rental offer vaults is `amount × durationDays × (1 +
        // bufferBps/10000)`; every later economic site (accept pull, cancel
        // refund, modify delta, loan-init `loan.bufferAmount`, Option-2 transfer
        // reset) must use the SAME bufferBps that was funded, not the live
        // governance config — else a `cfgRentalBufferBps()` retune between create
        // and a later site desyncs the refund/reset from the actually-vaulted
        // amount (a raise bricks cancel / over-funds the loan buffer; a cut
        // strands prepay). `0` ⇒ legacy offer created before this snapshot
        // existed → resolver `effectiveRentalBufferBps` falls back to live
        // `cfgRentalBufferBps()`. Append-only; flat (viaIR stack). Only the
        // Offer carries the BPS — the Loan already snapshots the ABSOLUTE buffer
        // (`bufferAmount`), which `calculateRentalLateFee` reads.
        uint16 rentalBufferBpsAtCreate;
    }

    /**
     * @notice Struct for an active loan.
     * @dev Created on offer acceptance; tracks repayment/default.
     *      References original offerId for details.
     */
    struct Loan {
        // Slot 0
        uint256 id;
        // Slot 1
        uint256 offerId;
        // Slot 2: lender(20) + 9 small fields (9) + 2 × uint16 (4) = 32 bytes packed
        address lender;
        LiquidityStatus principalLiquidity;
        LiquidityStatus collateralLiquidity;
        LoanStatus status;
        AssetType assetType;
        bool useFullTermInterest;
        bool riskAndTermsConsentFromBoth;
        AssetType collateralAssetType;
        // Phase 6: keeper access is now per-keeper-per-loan via
        // `loanKeeperEnabled[loanId][keeper]` (see Storage below). Per-side
        // authority is enforced via each NFT holder's own
        // `approvedKeeperActions` bitmask, so there's no per-loan per-side
        // bool here. The master "pause all keepers" switch remains on
        // `keeperAccessEnabled[user]` (per-user, Storage-level).
        // Fallback-path settlement split, snapshotted at `initiateLoan` from
        // the then-current {ProtocolConfig.fallbackLenderBonusBps} /
        // `fallbackTreasuryBps`. {LibFallback.computeFallbackEntitlements}
        // reads from here — not from live config — so any subsequent
        // governance change via {ConfigFacet.setFallbackSplit} applies
        // prospectively only to loans initiated after the change. Zero
        // on a pre-upgrade loan falls through to the compile-time defaults
        // in `LibFallback` (backfill-safe).
        uint16 fallbackLenderBonusBpsAtInit;
        uint16 fallbackTreasuryBpsAtInit;
        // Snapshotted from the effective per-tier liquidation LTV at
        // `initiateLoan` (computed from the collateral asset's effective
        // liquidity tier via `LibVaipakam.effectiveLiquidationLtvBps`).
        // Read by `RiskFacet.calculateHealthFactor` /
        // `isCollateralValueCollapsed` / `PartialWithdrawalFacet` instead
        // of the retired `RiskParams.liqThresholdBps`. Immutable for the
        // loan's lifetime — same snapshot discipline as the fallback
        // split fields above. Tier degradation mid-loan does NOT
        // re-gate existing loans. Zero on a pre-PR2 loan would short-
        // circuit HF math; backfill by storage slot init is not
        // applicable on a fresh deploy.
        uint16 liquidationLtvBpsAtInit;
        // Slot 3: borrower(20) + 1 small field (1) + 1 enum (1)
        //         + uint64 (8) = 30 bytes packed; 2 free
        address borrower;
        // Snapshotted from `Offer.allowsPartialRepay` at loan init.
        // Read by `RepayFacet.repayPartial` to gate borrower-initiated
        // partial repayment — when false, the call reverts with
        // `PartialRepayNotAllowed`. Snapshot semantics mirror other
        // loan-time invariants (fallback consent, fallback split bps):
        // immutable for the loan's lifetime regardless of any later
        // governance / offer-level change.
        bool allowsPartialRepay;
        // ── T-034 — Periodic Interest Payment fields ──────────────────
        // Snapshotted from `Offer.periodicInterestCadence` at loan init.
        // Immutable for the loan's lifetime — same snapshot discipline as
        // `allowsPartialRepay` and the fallback split bps. None on every
        // loan created while `periodicInterestEnabled` is false. See
        // docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md §2.1.
        PeriodicInterestCadence periodicInterestCadence;
        // Unix-seconds timestamp of the most recent fully-settled period
        // checkpoint. Initialised to `startTime` at `initiateLoan`.
        // Advanced by exactly `intervalDays(cadence) * 1 days` per
        // settlement (just-stamp or auto-liquidate). Zero on loans whose
        // cadence is None (the field is read but the next-checkpoint
        // computation in `RepayFacet` short-circuits when cadence is
        // None, so this never matters there).
        uint64 lastPeriodicInterestSettledAt;
        // Slot 4
        uint256 lenderTokenId;
        // Slot 5
        uint256 borrowerTokenId;
        // Slot 6
        uint256 principal; // Lent amount or rental value
        // Slot 7
        address principalAsset;
        // Slot 8
        uint256 interestRateBps;
        // Slot 9: startTime(8) + interestPaidSinceLastPeriod(16)
        //        = 24 bytes packed; 8 free
        // T-034 downsized startTime from uint256 to uint64 to free 24
        // bytes for `interestPaidSinceLastPeriod` and future expansion.
        // uint64 holds Unix-seconds through year 2554 — well past any
        // plausible loan horizon. Every reader implicitly widens to
        // uint256 via Solidity arithmetic; only the three write sites
        // (`LoanFacet.initiateLoan`, `RepayFacet`, `PrecloseFacet`) need
        // explicit `uint64(block.timestamp)` casts.
        uint64 startTime; // Timestamp of initiation
        // T-034 — interest paid by the borrower since the most recent
        // periodic checkpoint (or since `startTime` for the first
        // period). Reset to zero on each settlement. Only the interest
        // portion of `repayPartial` payments accumulates here — under
        // T-034's interest-first allocation, that's the same value as
        // `min(payment, accruedThisPeriod)`. uint128 is plenty: it
        // overflows at ~3.4 × 10^38 wei, far above any conceivable
        // single-period interest amount in any asset.
        uint128 interestPaidSinceLastPeriod;
        // Slot 10
        uint256 durationDays;
        // Slot 11
        address collateralAsset;
        // Slot 12
        uint256 collateralAmount;
        // Slot 13
        uint256 tokenId; // For NFT lending assets
        // Slot 14
        uint256 quantity; // For ERC1155
        // Slot 15
        uint256 prepayAmount;
        // Slot 16
        uint256 bufferAmount;
        // Slot 17
        uint256 lastDeductTime;
        // Slot 18
        address prepayAsset; // ERC20 for NFT rental fees (e.g., USDC); address(0) for ERC20 loans
        // Slot 19
        uint256 collateralTokenId; // Token ID for NFT collateral; 0 for ERC20
        // Slot 20
        uint256 collateralQuantity; // Quantity for ERC1155 collateral; 0 for ERC20/ERC721
        // Slot 21 — VPFI discount per-loan snapshot (§5.2a).
        // Lender's `UserVpfiDiscountState.cumulativeDiscountBpsSeconds`
        // at offer acceptance. At yield-fee settlement, subtracting this
        // from the lender's current accumulator and dividing by loan
        // duration yields the time-weighted average discount BPS — the
        // rate the lender actually earned over the loan's full lifetime.
        // Defeats last-minute vault top-ups that used to steal the full
        // tier-4 discount for a loan the lender was mostly at tier-1 on.
        uint256 lenderDiscountAccAtInit;
        // Slot 22 — Borrower-side mirror of the lender snapshot above
        // (Phase 5 / §5.2b). Borrower's
        // `UserVpfiDiscountState.cumulativeDiscountBpsSeconds` at offer
        // acceptance. Only populated on loans that take the VPFI-fee path
        // (the borrower chose to pay the full 0.1% LIF in VPFI); zero on
        // lending-asset-fee loans. On proper settlement the delta between
        // the borrower's current accumulator and this anchor, divided by
        // loan duration, yields the time-weighted average discount BPS
        // — which scales the VPFI rebate paid out via ClaimFacet. The
        // gameable one-shot tier lookup at init is replaced by this
        // time-weighted window, so a borrower who tops up to tier 3 at
        // accept and unstakes the next block earns only a prorated
        // rebate (~0) instead of the full discount.
        uint256 borrowerDiscountAccAtInit;
        // ── Range Orders Phase 1 — matcher address ─────────────────────
        // Recorded at loan init from the matching write's `msg.sender`
        // (`matchOffers` / `acceptOffer` / preclose-offset / refinance).
        // Consumed by `LibVPFIDiscount.settleBorrowerLifProper` and
        // `forfeitBorrowerLif` to route 1% of any LIF flowing to
        // treasury (lender-asset path: directly at match; VPFI path:
        // deferred to terminal). Zero on legacy loans created before
        // the Range Orders Phase 1 cutover. See
        // docs/RangeOffersDesign.md §"1% match fee mechanic."
        address matcher;
        // ── T-032 — notification-fee billed flags ──────────────────────
        // Set by `LoanFacet.markNotifBilled` (callable only by
        // `NOTIF_BILLER_ROLE` — held by the off-chain hf-watcher) the
        // first time a paid-tier (Push-Protocol) notification fires
        // for the corresponding side of this loan. Once set, the user's
        // VPFI vault has already been debited the
        // `cfgNotificationFee()`-equivalent amount in VPFI,
        // routed directly to treasury (no Diamond custody — see
        // `LibNotificationFee.bill` for the routing). Idempotent: the
        // facet method no-ops if the flag is already true. Free-tier
        // (Telegram-only) subscribers and unsubscribed users always
        // leave both flags `false` — they're billed only on PaidPush.
        bool lenderNotifBilled;
        bool borrowerNotifBilled;
        // ── T-086 step 4 — `allowsPrepayListing` snapshot at loan-init ──
        // Append-only field. Copied verbatim from
        // `Offer.allowsPrepayListing` in `LoanFacet.initiateLoan`;
        // immutable for the loan's lifetime regardless of any later
        // offer-level change (offers can't be edited post-create today,
        // but this matches the snapshot-and-lock pattern used for
        // `allowsPartialRepay` / fallback consent / split bps elsewhere
        // on this struct). The (step-6) `NFTPrepayListingFacet` reads
        // THIS field (not the offer's) — once the loan is initialized
        // the relevant consent is fixed-at-loan-init.
        bool allowsPrepayListing;
        // ── #408 / #410 / #413 (2026-06-12) ───────────────────────
        // Cumulative interest already paid toward this loan via:
        //   - `RepayFacet.repayPartial` — each partial's interest portion.
        //   - `RepayPeriodicFacet.settlePeriodicInterest` — each period's
        //     interest forwarded to the lender.
        // Read at every settlement (`LibEntitlement.settlementInterestNet`)
        // to credit-against the unified gross floor amount, so the
        // borrower never re-pays interest already paid. Removes the
        // #413 double-charge on `precloseDirect` after partial /
        // periodic settlement by construction.
        //
        // `uint256` chosen defensively (per Codex #558 round-3 P2):
        // at max-duration (4,385d) + max-APR + uint256 `amount`, a
        // smaller type could overflow. No packing benefit either way
        // because the field is appended in its own slot.
        //
        // Append-only field (storage layout discipline). Zero on
        // every existing loan at deploy time.
        uint256 interestSettled;
        // #394 Lever A (Codex #647 P1) — the loan-ADMISSION Health Factor
        // floor SNAPSHOTTED at init from the live `minHealthFactor()` knob.
        // Every post-admission HF check for THIS loan
        // (partial-withdrawal, fallback-cure, partial-repay / swap-to-repay
        // guards) reads this snapshot — NOT the live knob — so a later
        // governance retune of the admission floor never retroactively
        // loosens (or tightens) an open loan's collateral buffer. Same
        // immutable-at-init discipline as `liquidationLtvBpsAtInit`. Zero on
        // an illiquid loan (HF math never runs) or a pre-#394 loan ⇒
        // `effectiveLoanMinHealthFactor` falls back to `MIN_HEALTH_FACTOR`.
        // Append-only tail field. uint64 holds ≫ the 2.0e18 ceiling.
        uint64 minHealthFactorAtInit;
        // #394 Lever A (Codex #647 round-3 P1) — the EFFECTIVE loan-admission
        // init-LTV cap (bps) THIS loan was gated at, snapshotted at init.
        // Mirrors `_checkInitialLtvAndHf`: depth-tiered ⇒ `min(per-asset
        // loanInitMaxLtvBps, effectiveTierMaxInitLtvBps(tier))`; non-tiered ⇒
        // the per-asset `loanInitMaxLtvBps`. Post-admission collateral
        // withdrawal / max-withdrawable / fallback-cure enforce THIS cap (via
        // `effectiveLoanInitLtvCapBps`) so a tiered loan can't shed the tier
        // buffer the lender accepted at origination — the branch-aware HF-floor
        // snapshot alone doesn't bound LTV. `0` (illiquid or pre-#394 loan) ⇒
        // fall back to the live per-asset `loanInitMaxLtvBps`. Append-only tail.
        uint16 initLtvCapBpsAtInit;
        // #641 — the INTEREST-ACCRUAL clock, kept separate from the loan's
        // TERM (`startTime` + `durationDays`). Historically a partial
        // liquidation / repay reset `startTime`/`durationDays` to re-anchor
        // interest on the reduced principal — but those fields ALSO define the
        // maturity (`startTime + durationDays*1 days`) and the grace bucket
        // (`gracePeriod(durationDays)`), so the reset silently pulled the
        // default deadline earlier and collapsed grace. These two fields hold
        // the accrual clock instead: a partial sets `interestAccrualStart = now`
        // and `interestRemainingDays = remaining` while the term tuple stays
        // immutable, so maturity + grace are preserved on every path.
        // `LibEntitlement` reads these for ERC-20 interest, falling back to
        // `startTime` / `durationDays` when zero (a pre-#641 loan, or an NFT
        // rental whose fee model doesn't use them). Set at origination and at
        // every genuine re-term (offset, refinance). Pack: uint64 + uint16.
        // Append-only tail fields.
        uint64 interestAccrualStart;
        uint16 interestRemainingDays;
        // #957 (#921 item 6) — fee BPS SNAPSHOTTED at init from the live
        // governance knobs (`cfgTreasuryFeeBps` / `cfgLoanInitiationFeeBps`),
        // so a loan's economics are fixed at origination (the snapshot is
        // taken when the accept tx executes; a retune between signing and
        // inclusion still applies — only post-origination retunes are
        // neutralised). Every
        // settlement / close-out treasury split for THIS loan reads
        // `treasuryFeeBpsAtInit` (via `effectiveTreasuryFeeBps`) — NOT the
        // live knob — so a mid-loan governance retune never changes an
        // open loan's economics after it is originated.
        // `loanInitiationFeeBpsAtInit` records the LIF rate the loan was
        // originated under. The LIF is charged ONCE at init from the live knob
        // (the loan struct doesn't exist yet at the charge site), and this
        // field is stamped from the SAME live knob in the same tx — so the
        // recorded rate equals the charged rate by construction. It is a
        // per-loan economics RECEIPT (exposed via `getLoanDetails` for the
        // frontend / indexer / audit), with no post-init on-chain reader —
        // hence there is no `effectiveLoanInitiationFeeBps` resolver, unlike
        // the treasury field every settlement split reads. The RESOLVED value
        // is stored (never 0, since `cfg*` map a 0 config to the default), so
        // `0` unambiguously means a pre-#957 loan ⇒ `effectiveTreasuryFeeBps`
        // falls back to the live knob. Both fees are bounded by `MAX_FEE_BPS`
        // (5000) so `uint16` holds them; they pack into one slot. Append-only
        // tail fields — zero on every existing loan.
        uint16 treasuryFeeBpsAtInit;
        uint16 loanInitiationFeeBpsAtInit;
    }

    /**
     * @notice Struct for claimable funds after loan resolution.
     * @dev Tracks what each party can claim via ClaimFacet.
     */
    struct ClaimInfo {
        address asset;
        uint256 amount;
        AssetType assetType;
        uint256 tokenId;
        uint256 quantity;
        bool claimed;
    }

    /**
     * @notice Snapshot of a liquid-collateral loan that fell back to the
     *         claim-time settlement path (README §7 lines 142–153, 251, 290).
     * @dev Written by RiskFacet / DefaultedFacet when the DEX swap reverts
     *      (or is skipped for slippage > 6%). While `active == true`, the
     *      collateral is held inside the Diamond, the snapshot records the
     *      split that would apply if the lender-claim retry also fails,
     *      and ClaimFacet may attempt liquidation one more time.
     *      lenderCollateral / treasuryCollateral / borrowerCollateral are
     *      denominated in the collateral asset; lenderPrincipalDue /
     *      treasuryPrincipalDue are denominated in the principal asset and
     *      drive the retry-proceeds split if the retry swap succeeds.
     */
    struct FallbackSnapshot {
        uint256 lenderCollateral;
        uint256 treasuryCollateral;
        uint256 borrowerCollateral;
        uint256 lenderPrincipalDue;
        uint256 treasuryPrincipalDue;
        bool active;
        bool retryAttempted;
    }

    /**
     * @notice Per-day numeraire-quoted price snapshot for an asset.
     * @dev Captured by {OracleFacet.captureDailyPriceSnapshot}
     *      (permissionless, first-caller-per-day-per-asset wins,
     *      D10). Read by {OracleFacet.getHistoricalAssetPrice} —
     *      lets the frontend's historical-TVL chart be reconstructed
     *      from current-state reads alone, eliminating the last
     *      event-replay dependency on the analytical surface
     *      (AnalyticalGettersDesign §3.4 — Bucket-C → Bucket-A move).
     *      Slot-packs price + decimals + timestamp into one slot.
     * @param price         Chainlink-style price answer at capture
     *        time, denominated in the active numeraire (USD by
     *        post-deploy default).
     * @param feedDecimals  The feed's decimals (typically 8 for
     *        Chainlink, 18 for some VWAP / API3 dapis).
     * @param capturedAt    Block timestamp of the capture tx
     *        (informational; lets consumers spot stale snapshots if
     *        the keeper miss-fired by N hours).
     */
    struct AssetPriceSnapshot {
        int256 price;
        uint8 feedDecimals;
        uint64 capturedAt;
    }

    struct RiskParams {
        uint256 loanInitMaxLtvBps; // Max LTV in basis points
        uint256 liqBonusBps; // Liquidation Bonus in basis points
        uint256 reserveFactorBps; // Reserve Factor in basis points
        uint256 minPartialBps; // Min partial repay % (e.g., 100 for 1%)
        // NOTE: The per-asset `liqThresholdBps` was retired in PR2 of
        //   the internal-match work (2026-05-14). The liquidation
        //   threshold is now per-tier (see ProtocolConfig.tier{1,2,3}
        //   LiquidationLtvBps), snapshotted onto each loan as
        //   `Loan.liquidationLtvBpsAtInit` at `initiateLoan`. The HF
        //   formula reads the snapshot — no per-asset value remains.
    }

    /// @notice One row of the duration-tiered grace-period table.
    /// @dev Buckets are stored as a sorted array in
    ///      `Storage.graceBuckets`, with `maxDurationDays` strictly
    ///      ascending across the array. `gracePeriod(durationDays)`
    ///      returns the `graceSeconds` of the first bucket whose
    ///      `maxDurationDays > durationDays`. The LAST bucket is the
    ///      catch-all and is identified by `maxDurationDays == 0` —
    ///      its `graceSeconds` applies to every duration above the
    ///      penultimate bucket's threshold. This shape matches the
    ///      compile-time default schedule in `gracePeriod()` exactly,
    ///      so a fresh deploy with empty storage and a storage-driven
    ///      deploy produce identical lookups for the original 5
    ///      buckets, plus the new `≥ 365 days → 30 days` row.
    struct GraceBucket {
        uint256 maxDurationDays;
        uint256 graceSeconds;
    }

    /// @notice Per-feed oracle override. Governance-installed tighter
    ///         staleness bound and/or minimum-valid-answer floor on a
    ///         specific Chainlink aggregator address. `maxStaleness == 0`
    ///         is the "not set" marker — the global two-tier defaults
    ///         (ORACLE_VOLATILE_STALENESS / ORACLE_STABLE_STALENESS)
    ///         apply in that case.
    /// @dev `minValidAnswer <= 0` is treated as "no floor" (the baseline
    ///         `answer > 0` sanity check already rejects non-positive
    ///         readings). A feed returning below this floor triggers a
    ///         StalePriceData revert, preventing attacker- or
    ///         incident-driven near-zero reads from surfacing as legitimate
    ///         prices.
    struct FeedOverride {
        /// Max age in seconds. 0 = override not set.
        uint40 maxStaleness;
        /// Minimum acceptable `answer` from the aggregator. Must be
        /// expressed in the aggregator's own decimals. `<= 0` = no floor.
        int256 minValidAnswer;
    }

    /// @notice Per-user acceptance of the protocol's Terms of Service.
    ///         Written once per user per ToS version by
    ///         `LegalFacet.acceptTerms`. Frontends gate app entry until
    ///         `version == currentTosVersion` AND `hash == currentTosHash`.
    /// @dev `version == 0` is the "never accepted" marker — first-time
    ///      visitors always need to sign to enter the app.
    ///      `acceptedAt` is the block timestamp at acceptance; used by
    ///      audit / compliance queries asking "when did this wallet
    ///      accept version X?".
    struct TosAcceptance {
        uint32 version;
        bytes32 hash;
        uint64 acceptedAt;
    }

    /**
     * @notice Timestamped record of a fee accrual to the treasury.
     * @dev Appended by {LibFacet.recordTreasuryAccrual} at every treasury-debit
     *      site so MetricsFacet can report rolling 24h/7d windows and a true
     *      lifetime cumulative total. Packed into a single slot:
     *      `timestamp` fits any reasonable future block time in uint64, and
     *      `numeraireValue` in uint192 accommodates active-numeraire amounts
     *      scaled to 1e18 up to ~6.28e39 — vastly beyond any single fee. The
     *      protocol is currency-agnostic: amounts are quoted in whatever
     *      numeraire governance has configured (USD by post-deploy default).
     *      `numeraireValue` is 0 when the priced asset lacks a Chainlink feed
     *      at the time of accrual. The underlying asset-denominated accrual
     *      is reflected in `treasuryBalances[asset]` only when the configured
     *      treasury is the Diamond itself; external-treasury deployments
     *      push the tokens straight to the multisig, so `treasuryBalances`
     *      stays at zero for those fee paths (the fee still lives on-chain
     *      in the event log and `cumulativeFeesNumeraire`).
     */
    struct FeeEvent {
        uint64 timestamp;
        uint192 numeraireValue;
    }

    /// @notice Which side of a loan a {RewardEntry} represents.
    enum RewardSide {
        Lender,
        Borrower
    }

    /**
     * @notice RL-1 (VpfiRecyclingLoopClosureDesign §6) — delivery venue for a
     *         claimed interaction reward.
     * @dev `Default` resolves at claim time by caller shape: a direct
     *      EOA-style claim (`msg.sender.code.length == 0`) delivers to the
     *      claimant's per-user VAULT (the loop-closing default — the reward
     *      immediately counts toward tracked balance + fee-tier standing),
     *      while a contract caller gets the raw WALLET transfer every live
     *      integration observed before RL-1. `Wallet`/`Vault` are explicit
     *      overrides available to every caller — a smart-contract wallet
     *      (Safe, AA account) passes `Vault` to join the loop; an EOA passes
     *      `Wallet` to opt out. Vault delivery is best-effort and must never
     *      reduce claim availability: any vault-credit failure falls back to
     *      the wallet transfer.
     */
    enum RewardDelivery {
        Default,
        Wallet,
        Vault
    }

    /**
     * @notice Per-loan per-side reward accrual entry (spec §4 daily accrual).
     * @dev One entry per loan per side EXCEPT lender side, which may have
     *      multiple entries if the lender position is transferred via
     *      early-withdrawal sale. Each entry covers one contiguous
     *      `[startDay, endDay)` window for `user`.
     *
     *      endDay == 0 marks the entry as still open. closeLoan writes
     *      the terminal endDay + flags. Forfeited entries route to
     *      treasury at claim time (per-user directive: defaulted borrower
     *      rewards and early-withdrawal initiator rewards go to treasury).
     */
    struct RewardEntry {
        address user;
        uint64 loanId;
        uint32 startDay; // inclusive
        uint32 endDay; // exclusive; ACCRUAL BOUND only (never 0 in practice)
        RewardSide side;
        bool processed; // claim/sweep already routed this entry
        bool forfeited; // true ⇒ route to treasury on processing
        // #1002 (S4) — set true by {LibInteractionRewards._closeEntry} when the
        // loan is closed (or the lender position is sold). An entry is claimable
        // / sweepable ONLY once `closed`; `endDay` is now PURELY the accrual
        // upper bound. Pre-#1002 the "still open" gate keyed off `endDay == 0`,
        // but `_allocEntry` always stamps a nonzero `endDay` at registration, so
        // that gate was dead — both parties could claim the full-window reward at
        // contracted maturity while the loan was still open (a borrower intending
        // to default could claim, then default, dodging the §4 forfeit).
        bool closed;
        uint256 perDayNumeraire18; // Numeraire18 interest-per-day snapshotted at register
    }

    /**
     * @notice Per-user VPFI discount accumulator. Drives the time-weighted
     *         lender yield-fee discount (docs/GovernanceConfigDesign.md §5.2a).
     *         Updated on every vault-VPFI balance mutation and at every
     *         offer-accept / yield-fee settlement. Ordering invariant: the
     *         accompanying `rollupUserDiscount(user, postMutationBalance)`
     *         call runs at the mutation site; the closing period carries
     *         the bps stamp left by the prior rollup (the tier that was in
     *         effect across the just-closed window), and the re-stamp uses
     *         the post-mutation balance to seed the next period.
     *
     * @dev Packed layout:
     *        slot 0: uint16 (2) + uint64 (8) = 10 bytes → fits comfortably
     *        slot 1: uint256 cumulativeDiscountBpsSeconds
     *      `cumulativeDiscountBpsSeconds` is monotone non-decreasing and
     *      the per-loan delta `(now_cum - loan.lenderDiscountAccAtInit) /
     *      loanDuration` produces the average discount BPS the lender
     *      actually qualified for over that loan's lifetime — a last-
     *      minute top-up cannot backdate its effect onto prior periods.
     */
    struct UserVpfiDiscountState {
        uint16 discountBpsAtPreviousRollup;
        uint64 lastRollupAt;
        uint256 cumulativeDiscountBpsSeconds;
    }

    /**
     * @notice T-087 Sub 1.A — one day's snapshot inside the 30-slot
     *         ring buffer of the user's tracked VPFI stake.
     *
     * @dev Each ring slot stores BOTH the day id and the closing
     *      balance for that day, so the TWA scanner can filter
     *      slots by `dayId ∈ [currentDay - 29, currentDay]` and
     *      reject slots whose `dayId` has rolled out of the active
     *      30-day window. Codex round-4 P1 #2 caught that deriving
     *      a slot's day id from a single `firstWriteDayId` mis-labels
     *      old balances after the ring wraps.
     *
     *      `balance` is the protocol-tracked vault VPFI balance
     *      (`s.protocolTrackedVaultBalance[user][s.vpfiToken]`), NOT
     *      the raw vault VPFI balance — unsolicited transfers can't
     *      inflate the tier (Codex round-7 P1 #7).
     *
     *      `uint120` per balance field covers the full 230M VPFI
     *      token cap (1.3e36) with room to spare; the three fields
     *      together (16 + 120 + 120 = 256 bits) fit exactly in one
     *      storage slot per Solidity struct-array semantics.
     *
     *      Sub 1.C split (round-3 P2 #3): the original `balance`
     *      single-field shape couldn't simultaneously serve as
     *      "the day's minimum (for the min-tier-over-history clamp
     *      that closes the dust-then-bulk gaming vector — round-10
     *      P1 #5)" AND "the close-of-day balance (so the next-day
     *      gap-fill extends the user's live balance forward, not
     *      the historical minimum)". A user who staked 1 wei dust
     *      then topped up to a real tier later the same day stayed
     *      treated as 1 wei in every future read until they did
     *      another mutation on a later day (Sub 1.B P2 #3). The
     *      split lets the min-tier scan read `dayMin` and the
     *      TWA + future gap-fill read `dayClose`.
     */
    struct DaySnapshot {
        uint16 dayId;
        uint120 dayMin;
        uint120 dayClose;
    }

    /**
     * @notice T-087 Sub 1.A — mirror-side cached per-user tier
     *         entry written by the CCIP `TierUpdated` inbound
     *         handler (Sub 2) and read by every mirror fee-charging
     *         path (Sub 1.C).
     *
     * @dev Field ordering chosen for slot packing:
     *        8 + 40 + 64 + 40 + 16 + 16 = 184 bits → fits in one
     *        slot (256-bit ceiling).
     *
     *      `effectiveTier` is the post-min-history-gate tier value
     *      Base computed at push time; mirrors apply it as-is
     *      without re-deriving. `effectiveBps` (Codex round-11
     *      P1 #6) carries the actual BPS to apply so governance
     *      mutations of the per-tier discount table on Base
     *      propagate to mirrors directly; mirrors do NOT read
     *      their own local tier-BPS constants at fee-application
     *      time.
     *
     *      `lastNonce` is the monotonic ordering key — payload
     *      `nonce`, NOT a timestamp — so two same-block tier
     *      mutations on Base still order strictly (Codex round-2
     *      P1 #1). `tierExpirySec` is the absolute timestamp past
     *      which the cached tier is stale-by-construction; use
     *      `type(uint40).max` as the "no expiry" sentinel for
     *      steady-state stakers (Codex round-6 P1 #9).
     *      `tierTableVersion` lets mirrors detect governance
     *      threshold-table changes (Codex round-6 P1 #10).
     */
    struct CachedTier {
        uint8 effectiveTier;
        uint40 lastUpdateSec;
        uint64 lastNonce;
        uint40 tierExpirySec;
        uint16 tierTableVersion;
        uint16 effectiveBps;
    }

    /**
     * @notice Per-loan custody + claim bookkeeping for the borrower Loan
     *         Initiation Fee VPFI-path (Phase 5 / §5.2b).
     *
     * @dev Lifecycle:
     *        init (VPFI path):      vpfiHeld = full LIF-equivalent VPFI
     *                               pulled from borrower vault to the
     *                               Diamond; rebateAmount = 0
     *        proper settlement:     rebateAmount = vpfiHeld × avgBps / BPS
     *                               (Diamond sends treasury share to
     *                               treasury, retains rebateAmount for
     *                               the borrower claim); vpfiHeld = 0
     *        default / liquidation: both zeroed, full vpfiHeld forwarded
     *                               to treasury (no rebate)
     *        claim:                 rebateAmount cleared to zero as the
     *                               Diamond transfers VPFI to the claimant
     *
     *      Non-VPFI-path loans keep this struct at the zero default; no
     *      settlement side-effects and no claim.
     */
    struct BorrowerLifRebate {
        uint256 vpfiHeld; // Diamond's custody while the loan is live
        uint256 rebateAmount; // Claimable VPFI after proper settlement
    }

    /**
     * @notice Main storage struct for Vaipakam.
     * @dev Holds all global data: offers, loans, IDs, vaults, asset configs.
     *      Accessed via storageSlot function.
     *
     *      APPEND-ONLY POST-LAUNCH: after the first mainnet deployment, fields
     *      in this struct MUST only be added at the end. Never reorder, rename,
     *      or change the type of an existing field. Never remove a field — if
     *      a field becomes unused, mark it `// DEPRECATED` and leave the slot
     *      reserved (see `liquidAssets` for the precedent). Violating this
     *      rule corrupts every live loan, offer, and user vault in storage.
     *      Pre-launch: free to reorder at will.
     *
     *      ── Storage invariants (must hold across every tx boundary) ────────
     *        • `lenderClaims[loanId]` / `borrowerClaims[loanId]`: at most one
     *          unclaimed ClaimInfo per party per loan. Written only by the
     *          settlement path that produced the funds (repay / preclose /
     *          default / fallback); zeroed only by ClaimFacet on withdrawal.
     *        • `heldForLender[loanId]`: monotone non-decreasing between loan
     *          initiation and lender claim; reset to 0 when the lender is
     *          paid out. Only written by PrecloseFacet / RefinanceFacet /
     *          PartialWithdrawalFacet — never by repay paths.
     *        • `fallbackSnapshot[loanId].active == true` ⇔ the loan is in
     *          status FallbackPending. Set exclusively by RiskFacet /
     *          DefaultedFacet at fallback time; cleared by ClaimFacet on the
     *          first lender/borrower claim. Never mutated outside these sites.
     *        • `treasuryBalances[asset]`: IOU of treasury-earmarked tokens
     *          still physically held at the Diamond. Written by
     *          {LibFacet.recordTreasuryAccrual} only when `treasury ==
     *          address(this)`; external-treasury deployments leave this
     *          ledger at zero because the fees are pushed out synchronously
     *          (see `feeEventsLog` / `cumulativeFeesNumeraire` for the analytics
     *          of record). Monotone non-decreasing between accruals;
     *          reset to zero by `TreasuryFacet.claimTreasuryFees`. Any
     *          interest/late-fee split that debits lender/borrower MUST
     *          credit treasury via {LibFacet.recordTreasuryAccrual} by
     *          exactly `treasuryShare` — LibSettlement's plan is the single
     *          source of truth for that split.
     *        • `offerIdToLoanId[offerId]`: set exactly once, at loan
     *          initiation. Zero means "offer never consumed." Never rewritten.
     *        • `loanToSaleOfferId` / `saleOfferToLoanId` /
     *          `offsetOfferToLoanId` / `loanToOffsetOfferId`: bijective pairs.
     *          Both sides must be written together and cleared together;
     *          a one-sided write is a bug.
     *        • `approvedKeeperActions[user][keeper] != 0` ⇔ `keeper ∈
     *          approvedKeepersList[user]`. The list mirrors the mapping for
     *          enumeration and is capped at MAX_APPROVED_KEEPERS.
     *        • `keeperAccessEnabled[user]`: user-level master switch (Phase 6).
     *          A keeper call on a loan additionally requires
     *          `loanKeeperEnabled[loanId][keeper] == true` AND the
     *          per-action bit set on
     *          `approvedKeeperActions[nftOwner][keeper]` — all three gates
     *          must pass. See `LibAuth.requireKeeperFor` and
     *          `ProfileFacet.setLoanKeeperEnabled`.
     */

    /**
     * @dev T-090 v1.1 (#389) — per-loan swap-to-repay intent commit.
     *      Projection of the 1inch Fusion (Limit Order Protocol v4)
     *      order that the diamond signs via ERC-1271 + the Vaipakam-
     *      side bookkeeping needed for the
     *      `pre/postInteraction` hooks and the cancel paths.
     *
     *      Shape per
     *      `docs/DesignsAndPlans/SwapToRepayIntentBased.md` §5.2.
     *
     *      Fields that are derivable from the loan struct
     *      (`maker == receiver == address(this)`,
     *      `makerAsset == loan.collateralAsset`,
     *      `takerAsset == loan.principalAsset`) are not stored — they
     *      are recomputed at every use site so the storage footprint
     *      stays minimal. `getIntentCommit(loanId)` on the
     *      `SwapToRepayIntentFacet` returns the full reconstructed
     *      Fusion order for the dapp to post to 1inch's resolver-pickup
     *      endpoint.
     */
    struct SwapToRepayIntentCommit {
        // ── Fusion-order projection (Codex round-7 P1 #4 + round-11
        //    P1 #5 — every field the canonical hash + the
        //    `cancelOrder(MakerTraits, bytes32)` call site need):
        /// @dev Canonical 1inch LOP v4 orderHash, primary key for
        ///      the ERC-1271 binding check + the pre/postInteraction
        ///      hook lookup.
        bytes32 orderHash;
        /// @dev Borrower-supplied auction end; must equal
        ///      `makerTraits.expiration()` (round-8 P1 #5) AND must
        ///      be `<= loan.endTime + gracePeriod` (round-5 P2 #5).
        uint64 deadline;
        /// @dev `loan.collateralAmount` after the §5.1 step 8
        ///      fee-on-transfer rejection invariant (`received ==
        ///      loan.collateralAmount`). Kept separately to make the
        ///      LOP order canonical hash recomputable from storage.
        uint256 makerAmount;
        /// @dev Borrower-picked principal-side minimum (§5.4 floor
        ///      enforced at commit + recomputed at postInteraction
        ///      with live `lateFee`).
        uint256 takerAmount;
        /// @dev Borrower-supplied; low 160 bits must equal
        ///      `uint160(uint256(keccak256(params.extension)))` per
        ///      LOP v4's extension-binding rule (Codex round-8 P1 #1).
        uint256 salt;
        /// @dev Packed 1inch LOP v4 makerTraits. Stored as raw
        ///      `uint256` here so `LibVaipakam` stays free of LOP
        ///      dependency; cast to `MakerTraits` at use sites.
        ///      Round-8 + round-10 + round-12 fix every bit-pattern
        ///      check enforced at commit:
        ///      `hasExtension == 1`,
        ///      `needPreInteractionCall == 1`,
        ///      `needPostInteractionCall == 1`,
        ///      `getExpirationTime() == deadline`,
        ///      `usePermit2 == 0` (Codex round-10 P2 #3),
        ///      `allowPartialFills == 0` (Codex round-10 P2 #4),
        ///      `allowMultipleFills == 0`.
        uint256 makerTraits;
        /// @dev `keccak256(params.extension)`; the full extension
        ///      bytes live in `intentExtensionBytes` to keep this
        ///      struct cheap.
        bytes32 extensionHash;

        // ── Vaipakam-side bookkeeping:
        /// @dev Exact amount the diamond holds in custody from the
        ///      vault withdraw. Equal to `makerAmount` after §5.1
        ///      step 8 (fee-on-transfer rejection invariant). Used
        ///      by cancel paths to know how much to return + by the
        ///      per-token aggregate-allowance decrement on
        ///      fill / cancel.
        uint256 custodialCollateral;
        /// @dev Commit-time borrower-NFT holder — for activity-feed
        ///      attribution ONLY (Codex round-2 P2 #6). Cancel
        ///      authority follows the CURRENT borrower-NFT holder,
        ///      never this field.
        address committedByForRecord;
        /// @dev Codex round-10 P1 #6 — pinned Fusion
        ///      `LimitOrderProtocol` address at commit time.
        ///      Cancel + cancelExpired + every force-cancel branch +
        ///      pre/postInteraction's auth check all read THIS, NOT
        ///      `cfgFusionLimitOrderProtocol` (which might have
        ///      rotated). Defense-in-depth alongside the
        ///      `intentLiveCommitCount` rotation block.
        address lopAtCommit;
    }

    struct Storage {
        uint256 nextOfferId;
        uint256 nextLoanId;
        uint256 nextTokenId; // For Vaipakam NFTs
        address vaipakamVaultTemplate; // Shared UUPS implementation
        address treasury; // Configurable treasury address
        address zeroExProxy; // 0x proxy for liquidations
        address allowanceTarget; // allowance target for 0x proxy protocol
        address numeraireChainlinkDenominator; // Chainlink Feed Registry denominator constant for the active numeraire (Denominations.USD by default; rotates with the numeraire)
        // T-034 Numeraire generalization (b1) — symbol of the active numeraire used by
        // the symbol-derived secondary oracles (Tellor / API3 / DIA). Stored
        // as bytes32 (max 32 ASCII chars) for cheap on-chain comparison;
        // governance writes lowercase ASCII (e.g. "usd", "eur", "xau").
        // Empty bytes32 (post-deploy default before governance writes)
        // is interpreted as "usd" in `_checkTellor` / `_checkApi3` /
        // `_checkDia` so the protocol behaves identically to the pre-
        // sweep deploy out of the box.
        bytes32 numeraireSymbol;
        // T-048 — Predominantly Available Denominator (PAD).
        // PAD is the Chainlink-denomination side that the protocol expects
        // to have UNIVERSAL coverage on every supported chain — USD by the
        // post-deploy default. `_primaryPrice` queries `asset/PAD` first
        // (Chainlink Feed Registry, deepest coverage); if PAD ≠ active
        // numeraire, the PAD-quoted price is then converted via the
        // PAD/<numeraire> rate (direct feed if `padNumeraireRateFeed` is
        // set, else derived from `ethNumeraireFeed ÷ ethPadFeed`). When
        // PAD == numeraire (retail default — both are
        // `Denominations.USD`), the conversion is short-circuited and the
        // PAD price IS the numeraire price — zero overhead, behavior
        // identical to the pre-T-048 deploy.
        //
        // Tunable via `ConfigFacet.setPredominantDenominator`; zero on a
        // fresh deploy, in which case `_primaryPrice` falls through to the
        // legacy numeraire-direct path. An industrial-fork deploy on a
        // non-USD numeraire MUST set PAD before opening loans (a deploy-
        // script pre-flight enforces it).
        address predominantDenominator;
        // bytes32 lowercase ASCII symbol for the symbol-derived secondary
        // oracles (Tellor / API3 / DIA) when querying asset/PAD pairs.
        // Empty bytes32 is interpreted as "usd" — matches the existing
        // numeraireSymbol fallback convention.
        bytes32 predominantDenominatorSymbol;
        // Chainlink ETH/<PAD> AggregatorV3 — always populated when PAD is
        // set. Used (a) directly when the asset is WETH and PAD == numeraire,
        // and (b) as the denominator of the derived PAD/<numeraire> rate
        // when the direct feed is absent: rate = ETH/<numeraire> ÷ ETH/PAD.
        // On retail (PAD == numeraire == USD), this typically points at
        // the same Chainlink ETH/USD address as `ethNumeraireFeed` — the
        // two slots are allowed to alias.
        address ethPadFeed;
        // Optional Chainlink PAD/<numeraire> AggregatorV3 (e.g. USD/EUR
        // on Ethereum mainnet). When set, the FX rate is read from this
        // feed directly. When unset (the more common case on L2s), the
        // protocol derives the rate from ETH/<numeraire> ÷ ETH/PAD using
        // existing infrastructure. Address(0) on retail (PAD == numeraire)
        // is correct — no FX conversion is needed.
        address padNumeraireRateFeed;
        // Per-asset opt-in override for the PAD-pivot path. When non-zero,
        // `_primaryPrice` reads this Chainlink AggregatorV3 directly as the
        // asset's numeraire-quoted price and skips the PAD pivot entirely
        // (no FX multiply, no asset/PAD lookup). Use case: on a non-USD
        // numeraire deploy, an operator finds a 🟢-rated direct
        // `asset/<numeraire>` Chainlink feed (rare but possible) and wants
        // to use it instead of pivoting via USD. Default zero = pivot via
        // PAD (the structurally-safe path that biases toward the top-rated
        // asset/USD feed set). Cleared by writing zero.
        //
        // Operator vouches for the feed's quality when setting this — the
        // protocol does NOT cross-check the override against Pyth or the
        // secondary quorum, since both are configured for ETH/<numeraire>
        // not asset/<numeraire>. Use only for verified-rated feeds.
        mapping(address => address) assetNumeraireDirectFeedOverride;
        address chainlnkRegistry; // Chainlink Feed Registry (mainnet only; address(0) on L2s)
        address wethContract; // Canonical WETH on the active network — v3-style AMM liquidity quote asset
        address uniswapV3Factory; // UNISWAP_V3_FACTORY
        address diamondAddress;
        mapping(uint256 => uint256) loanToSaleOfferId;
        mapping(uint256 => Offer) offers;
        mapping(uint256 => Loan) loans;
        mapping(address => address) userVaipakamVaults; // Per-user proxy addresses
        mapping(address => RiskParams) assetRiskParams;
        mapping(address => uint256) treasuryBalances;
        // AnalyticalGettersDesign §3.2 / D5 — per-asset, per-UTC-day
        // running total of treasury accruals. dayIndex =
        // block.timestamp / 86400. Written on every
        // `LibFacet.recordTreasuryAccrual` call; read by
        // `MetricsFacet.getRevenueStats(address asset, uint16 windowDays)`
        // to produce O(windowDays) sums for rolling-window cards
        // without scanning the full feeEventsLog. Pre-deploy windows
        // start empty (no backfill — D5).
        mapping(address => mapping(uint256 => uint256)) treasuryAccrualByDay;
        // AnalyticalGettersDesign §3.4 — per-asset, per-UTC-day price
        // snapshot for historical TVL reconstruction without an
        // event-replay dependency. dayIndex = block.timestamp / 86400.
        // Captured once per day via the permissionless
        // {OracleFacet.captureDailyPriceSnapshot} keeper (D10).
        mapping(address => mapping(uint256 => AssetPriceSnapshot)) assetPriceSnapshots;
        // OfferBook 2-filter index — `assetPairActiveOfferIds
        // [lendingAsset][collateralAsset]` is the swap-pop array of
        // currently-active offer IDs for that exact asset pair, and
        // `assetPairActiveOfferIdsPos[lending][collateral][offerId]`
        // is the 1-based position lookup for O(1) removal. Maintained
        // by LibMetricsHooks at create / accept / cancel; consumed by
        // {MetricsFacet.getActiveOffersByAssetPair}. Replaces the
        // O(activeOfferCount) walk in `getActiveOffersByAsset` with
        // an O(asset-pair count) read at the cost of one extra SSTORE
        // per offer-lifecycle edge.
        mapping(address => mapping(address => uint256[])) assetPairActiveOfferIds;
        mapping(address => mapping(address => mapping(uint256 => uint256))) assetPairActiveOfferIdsPos;
        mapping(address => string) userCountry; // ISO code, e.g., "US"
        mapping(address => bool) kycVerified;
        mapping(bytes32 => mapping(bytes32 => bool)) allowedTrades; // hash(countryA) => hash(countryB) => true if A can trade with B
        mapping(uint256 => ClaimInfo) lenderClaims; // loanId => lender's claimable funds
        mapping(uint256 => ClaimInfo) borrowerClaims; // loanId => borrower's claimable funds
        mapping(address => KYCTier) kycTier; // user => KYC tier level
        mapping(uint256 => uint256) heldForLender; // loanId => extra amount held for lender from preclose operations
        mapping(uint256 => uint256) offsetOfferToLoanId; // newOfferId => originalLoanId for offset tracking
        mapping(uint256 => uint256) saleOfferToLoanId; // saleOfferId => loanId for lender sale completion
        mapping(uint256 => uint256) offerIdToLoanId; // offerId => loanId (set at loan initiation)
        mapping(uint256 => uint256) loanToOffsetOfferId; // loanId => offset offerId (borrower preclose Option 3)
        uint256 currentVaultVersion; // incremented on each implementation upgrade
        uint256 mandatoryVaultVersion; // minimum version required; 0 = no mandatory upgrade
        mapping(address => uint256) vaultVersion; // user => version when their proxy was last upgraded
        uint256 kycTier0ThresholdNumeraire; // Tier0 max (default 1_000 * 1e18)
        uint256 kycTier1ThresholdNumeraire; // Tier1 max (default 10_000 * 1e18)
        mapping(address => bool) keeperAccessEnabled; // User-level master switch — quick "pause all keepers for me" (default: false)
        // Snapshot of liquid-collateral liquidations that fell back to the
        // claim-time settlement path (README §7). Written by RiskFacet /
        // DefaultedFacet at fallback time; consumed by ClaimFacet on the
        // first lender/borrower claim.
        mapping(uint256 => FallbackSnapshot) fallbackSnapshot;
        // Phase 6: per-user whitelist of approved keepers + their per-action
        // authorization bitmask. The uint16 bitmask uses the KEEPER_ACTION_*
        // constants below (#1221 widened it from uint8 — a value written as
        // uint8 reads back identically since mapping values are one-per-slot,
        // right-aligned). A zero value means the keeper is not approved (equivalent to
        // not-on-the-list); a non-zero value authorizes the keeper for the set
        // bits' actions. Capped at MAX_APPROVED_KEEPERS per user. Per-side
        // authority is automatic: a lender-entitled action for a loan checks
        // the lender-NFT holder's bitmask, a borrower-entitled action checks
        // the borrower-NFT holder's — the two bitmasks are independent.
        mapping(address => mapping(address => uint16)) approvedKeeperActions;
        mapping(address => address[]) approvedKeepersList;
        // Phase 6: per-loan and per-offer keeper enable flags. A keeper may
        // drive an action on a loan iff they are both enabled for the loan
        // (this mapping) AND the relevant NFT holder's bitmask above has the
        // action bit set. Offer-level flags are latched into loan-level at
        // `initiateLoan` via the creator's whitelist; post-acceptance each
        // NFT holder can edit the loan-level flag via
        // `ProfileFacet.setLoanKeeperEnabled`.
        mapping(uint256 => mapping(address => bool)) loanKeeperEnabled;
        mapping(uint256 => mapping(address => bool)) offerKeeperEnabled;
        // README §13 analytics surface: timestamped log of every treasury-fee
        // accrual, priced in the active numeraire at accrual time. Appended
        // by LibFacet.recordTreasuryAccrual. Consumed by MetricsFacet for the
        // 24h/7d revenue windows and getRevenueStats(days_). Capped per query
        // by MAX_FEE_EVENTS_ITER on read.
        FeeEvent[] feeEventsLog;
        // Monotone cumulative sum of numeraireValue across feeEventsLog
        // entries — tracked separately so
        // MetricsFacet.getTreasuryMetrics.totalFeesCollectedNumeraire is an
        // O(1) read. Never decreases.
        uint256 cumulativeFeesNumeraire;
        // README §16 Phase 1 KYC pass-through flag. When FALSE (the default
        // at Phase 1 launch), every `meetsKYCRequirement` / `isKYCVerified`
        // check returns true so KYC logic does not block any user flow. The
        // tier / threshold / admin plumbing is preserved so governance may
        // flip this to true in a later phase to activate real enforcement
        // without a further diamond cut.
        bool kycEnforcementEnabled;
        // Phase 1 tokenomics (docs/TokenomicsTechSpec.md): address of the
        // VPFIToken UUPS proxy that serves as the canonical on-chain handle
        // for the protocol's ERC20. Written by VPFITokenFacet.setVPFIToken
        // (ADMIN_ROLE) after the token proxy is deployed; read by facets
        // that surface token state or (later) interact with minter/burn
        // paths. Zero value means the token has not been registered yet.
        //
        // On the canonical chain (Base mainnet / Base Sepolia testnet) this
        // points at the VPFIToken ERC20Capped proxy. On every non-canonical
        // chain (Eth/Polygon/Arbitrum/Optimism mainnet + Sepolia testnet) it
        // points at the VPFIMirror OFT proxy — same name/symbol/decimals,
        // no cap, no independent mint surface (supply flows in/out via the
        // Chainlink CCIP CCT pool, not via diamond-initiated mints).
        address vpfiToken;
        // True on the chain that hosts the canonical VPFIToken + CCT pool
        // (Base mainnet / Base Sepolia). On every other chain this stays
        // FALSE, which is what TreasuryFacet.mintVPFI checks to reject mint
        // calls on mirror chains — only the canonical chain can mint new
        // VPFI into circulation, mirrors receive VPFI exclusively via the
        // CCIP CCT pool. Defaults to false at diamond init; flipped to
        // true by VPFITokenFacet.setCanonicalVPFIChain(true) exactly once
        // during the canonical deploy.
        bool isCanonicalVpfiChain;
        // ── Borrower VPFI Discount (Phase 1) ────────────────────────────
        // VPFI price anchor for the consumptive fee-discount utility, stored
        // as wei-per-VPFI so the 0.001 ETH reference is `1e15`. Set via
        // VPFIDiscountFacet.setVPFIDiscountRate (ADMIN_ROLE). Zero means the
        // admin has not configured the rate yet and the discount path is
        // disabled (quoting returns canQuote=false). #687-A removed the issuer
        // fixed-rate ETH → VPFI sale that previously shared this anchor.
        uint256 vpfiDiscountWeiPerVpfi;
        // Chain-local ERC-20 address whose Chainlink USD feed is used to
        // convert the discounted fee from USD into ETH during the
        // discount-eligibility calculation. In practice this is the
        // canonical WETH on the active network. Zero means the ETH oracle
        // is not configured and the discount path falls back silently to
        // the normal lender-paid fee.
        address vpfiDiscountEthPriceAsset;
        // Platform-level opt-in to use vaulted VPFI for protocol fee
        // discounts. One common consent governs both the borrower Loan
        // Initiation Fee discount and the lender Yield Fee discount. Per
        // spec (docs/TokenomicsTechSpec.md §6 and §9, README §"Treasury and
        // Revenue Sharing"): offer-level or loan-level toggles are not
        // required once this flag is true. When false, all fee flows revert
        // to the default non-discounted path; when true, the discount is
        // applied automatically whenever the vault holds enough VPFI and
        // the asset leg is eligible (liquidity + oracle availability).
        mapping(address => bool) vpfiDiscountConsent;
        // #687-B: the VPFI 5% staking-yield accrual storage was removed with
        // the staking yield itself (the balance-based fee-discount tiers +
        // interaction rewards are unaffected — they read the vault balance /
        // discount accumulator, never the staking accrual).
        // ─── VPFI Lender Yield-Fee Time-Weighted Discount (§5.2a) ──────
        // Per-user accumulator backing the lender-side time-weighted
        // yield-fee discount. Each loan stores `lenderDiscountAccAtInit`
        // (on Loan struct) at offer acceptance; at yield-fee settlement,
        // the time-weighted average BPS over the loan window =
        //   (cumulativeDiscountBpsSeconds_now - loan.lenderDiscountAccAtInit)
        //   / (now - loan.startTime)
        // — and that average replaces the previous live tier-at-repay
        // lookup. See docs/GovernanceConfigDesign.md §5.2a for the full
        // rationale and the anti-gaming design sketch.
        // === DEPRECATED in T-087 Sub 1.A ===
        // The Phase-5 simple-TWA accumulator. The slot is retained
        // in place to preserve the storage layout contract loupe
        // tools depend on; new T-087 ring-buffer state is appended
        // at the end of this struct (see `dayBalances` et al). DO
        // NOT reinterpret this slot — leave it dead. Sub 1.B
        // rewires every call site off this mapping; Sub 1 ships
        // with the slot abandoned, not removed.
        mapping(address => UserVpfiDiscountState) userVpfiDiscountState_DEPRECATED;
        // ─── VPFI Platform Interaction Rewards (spec §4) ────────────────
        // Daily emission pool split 50/50 across lenders (by USD interest
        // earned that day) and borrowers (by USD interest paid that day on
        // CLEAN full-term in-grace repayment only — no defaults, no
        // liquidations, no post-grace settlements). Emission schedule
        // (§4) decays from 32% annual rate in months 0–6 down to 5% after
        // month 78, scaled against VPFI_INITIAL_MINT. Pull-only claims
        // via InteractionRewardsFacet.claimInteractionRewards().
        //
        // dayIndex = (block.timestamp - interactionLaunchTimestamp) / 1 days;
        // launch timestamp is seeded at diamond init by admin; zero means
        // emissions have not yet begun and both totals are no-ops.
        //
        // Settlement hooks (RepayFacet on clean full repay, and any
        // future preclose path on a strict clean-repay outcome) record
        // the USD-valued (Chainlink spot) interest booked on day `d`:
        //   totalLenderInterestNumeraire18[d] += interestUsd
        //   userLenderInterestNumeraire18[d][lender] += interestUsd
        //   (and borrower mirror iff clean)
        // Claims walk finalized days < today, cap at MAX_INTERACTION_CLAIM_DAYS
        // per tx, and advance interactionLastClaimedDay.
        uint256 interactionLaunchTimestamp;
        uint256 interactionPoolPaidOut;
        mapping(uint256 => uint256) totalLenderInterestNumeraire18;
        mapping(uint256 => uint256) totalBorrowerInterestNumeraire18;
        mapping(uint256 => mapping(address => uint256)) userLenderInterestNumeraire18;
        mapping(uint256 => mapping(address => uint256)) userBorrowerInterestNumeraire18;
        mapping(address => uint256) interactionLastClaimedDay;
        /// @dev Admin-configurable "whole VPFI per 1 ETH of eligible
        ///      interest" per-user daily cap used in
        ///      {LibInteractionRewards} claim + preview. Zero = use the
        ///      {INTERACTION_CAP_DEFAULT_VPFI_PER_ETH} default (500 →
        ///      0.5 VPFI per 0.001 ETH, matching docs/TokenomicsTechSpec.md
        ///      §4). Applied independently per side per day.
        uint256 interactionCapVpfiPerEth;
        // ─── Cross-Chain Reward Accounting (spec §4a) ────────────────────
        // The §4 reward formula's denominator `totalDailyInterestUSD` is
        // PROTOCOL-WIDE, not per-chain — but each independent Diamond
        // only sees local interest. This block wires the reporter /
        // aggregator / consumer sides across the mesh:
        //   - every Diamond (Base + mirrors) runs a reporter that ships
        //     its day-`D` local (lender, borrower) USD totals to Base
        //   - Base runs an aggregator that sums per-chain reports into
        //     `dailyGlobalLenderInterestNumeraire18[D]` and
        //     `dailyGlobalBorrowerInterestNumeraire18[D]` once all expected
        //     mirrors have reported OR `rewardGraceSeconds` has elapsed
        //   - Base then broadcasts the finalized global pair back to
        //     every mirror, where {LibInteractionRewards.claimForUserWindow}
        //     prefers `knownGlobal*InterestNumeraire18[D]` over the local total
        //     as the formula denominator
        //
        // Trust model: CCIP messages flow through the dedicated
        // VaipakamRewardMessenger contract addressed by `rewardMessenger`
        // (storage slot name retained for layout stability; see the
        // legacy-name comment below). Only that address may invoke
        // the trusted ingress handlers
        // (RewardAggregatorFacet.onChainReportReceived on Base,
        // RewardReporterFacet.onRewardBroadcastReceived on mirrors).

        /// @dev True exactly on the canonical reward chain (Base mainnet
        ///      chainId 8453 / Base Sepolia 84532). Gates the aggregator
        ///      ingress + finalize + broadcast trigger. Admin-settable so
        ///      the flag is parity-independent of the Diamond deployment.
        bool isCanonicalRewardChain;
        /// @dev DEPRECATED (T-068 LayerZero→CCIP). The reward flow no
        ///      longer stores a per-chain endpoint id — `block.chainid`
        ///      is the chain identity. Slot retained for storage-layout
        ///      stability; never read or written.
        uint32 localEidLegacyDoNotUse;
        /// @dev EVM chain id of the canonical (Base) reward chain.
        ///      Mirrors send chain reports here; zero on Base itself.
        uint32 baseChainId;
        /// @dev Authorized cross-chain messenger address on this chain
        ///      (`VaipakamRewardMessenger`, CCIP-backed post-T-068). Only
        ///      this address may call the trusted ingress handlers
        ///      (aggregator receive on Base, broadcast receive on mirrors).
        ///      Pre-T-068 the same slot held a LayerZero OApp address and
        ///      was named `rewardOApp`; the field was renamed to
        ///      `rewardMessenger` once the LayerZero rip-out completed.
        ///      Solidity storage layout is determined by field order and
        ///      type, not name — so the rename is layout-preserving (same
        ///      offset, same 32-byte slot). The selector / error name
        ///      changes (`setRewardMessenger`, `NotAuthorizedRewardMessenger`,
        ///      `RewardMessengerNotSet`) are the real ABI breaks; consumers
        ///      regenerate ABIs in the same PR.
        address rewardMessenger;
        /// @dev Seconds past the first chain report for day `D` after
        ///      which `finalizeDay(D)` may be called even if not every
        ///      expected mirror has reported. Defaults to 4 hours when
        ///      unset. Admin-configurable.
        uint64 rewardGraceSeconds;
        /// @dev Base-only: list of EVM chain ids expected to report each
        ///      day (every mirror chain in the mesh, PLUS the Base chain's
        ///      own `block.chainid` because Base is also a source of
        ///      interest). Admin-maintained.
        uint32[] expectedSourceChainIds;
        // ── Reporter side (every chain) ────────────────────────────────
        /// @dev Per-chain per-day "already reported" guard. Set when the
        ///      local Diamond successfully ships its day-`D` report (on
        ///      Base: writes directly to aggregator storage; on mirrors:
        ///      queues the cross-chain messenger send).
        mapping(uint256 => uint64) chainReportSentAt;
        // ── Aggregator side (Base only) ────────────────────────────────
        /// @dev Base-only: lender-side local Numeraire18 interest reported by
        ///      chain id for day `D`.
        mapping(uint256 => mapping(uint32 => uint256)) chainDailyLenderInterestNumeraire18;
        /// @dev Base-only: borrower-side local Numeraire18 interest reported by
        ///      chain id for day `D`.
        mapping(uint256 => mapping(uint32 => uint256)) chainDailyBorrowerInterestNumeraire18;
        /// @dev Base-only: `(dayId, chainId)` idempotency guard — rejects
        ///      duplicate reports for the same `(day, chain)` pair.
        mapping(uint256 => mapping(uint32 => bool)) chainDailyReported;
        /// @dev Base-only: number of expected chains that have reported
        ///      for day `D` so far. Used to decide full-coverage fast
        ///      finalization.
        mapping(uint256 => uint32) chainDailyReportCount;
        /// @dev Base-only: `block.timestamp` of the FIRST report for
        ///      day `D`. Drives the grace-window fallback when not all
        ///      mirrors have reported.
        mapping(uint256 => uint64) dailyFirstReportAt;
        /// @dev Base-only: finalized flag for day `D`. Set by
        ///      {RewardAggregatorFacet.finalizeDay}; late reports after
        ///      finalization are rejected (idempotency preserves claim
        ///      determinism).
        mapping(uint256 => bool) dailyGlobalFinalized;
        /// @dev Base-only: finalized global lender Numeraire18 interest for
        ///      day `D` (sum across reported chains).
        mapping(uint256 => uint256) dailyGlobalLenderInterestNumeraire18;
        /// @dev Base-only: finalized global borrower Numeraire18 interest for
        ///      day `D` (sum across reported chains).
        mapping(uint256 => uint256) dailyGlobalBorrowerInterestNumeraire18;
        // ── Consumer side (every chain) ────────────────────────────────
        /// @dev Finalized global lender denominator known on this chain
        ///      for day `D`. On Base it is set directly by
        ///      {RewardAggregatorFacet.finalizeDay}; on mirrors it is
        ///      set by {RewardReporterFacet.onRewardBroadcastReceived}.
        ///      Zero means "not yet known locally" — claims for `D`
        ///      revert until the broadcast lands.
        mapping(uint256 => uint256) knownGlobalLenderInterestNumeraire18;
        /// @dev Mirror of {knownGlobalLenderInterestNumeraire18} for the
        ///      borrower side.
        mapping(uint256 => uint256) knownGlobalBorrowerInterestNumeraire18;
        /// @dev Per-day `knownGlobal*` set-flag. Cheaper than comparing
        ///      both sides to zero; distinguishes "day `D` finalized
        ///      with zero global interest" from "day `D` not yet
        ///      broadcast here".
        mapping(uint256 => bool) knownGlobalSet;
        // ─── Bridged Fixed-Rate VPFI Buy (spec §: Early Fixed-Rate ──────
        // Purchase Program, cross-chain extension) ─────────────────────────
        // Base is the SOLE seller of the fixed-rate VPFI. Non-Base chains
        // get a "bridged buy" UX via VPFIBuyAdapter: user pays native ETH
        // ─── l2 Sequencer Uptime Circuit Breaker ────────────────────────
        // On L2s (Base/Arb/OP/etc.) we must not consume Chainlink prices
        // while the sequencer has been down — users can't submit txs, so
        // posted prices lag and create a restart-arb / liquidation-storm
        // window. When `sequencerUptimeFeed` is non-zero, OracleFacet
        // consults this Chainlink feed before every price read: if the
        // feed answer is 1 (sequencer DOWN) or the last status change
        // was within SEQUENCER_GRACE_PERIOD seconds (just recovered),
        // price reads revert. Set to `address(0)` on l1 / Ethereum
        // mainnet where no sequencer exists — skips the check.
        /// @dev Chainlink l2 Sequencer Uptime feed address (e.g., Base
        ///      mainnet: 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433).
        ///      Zero = check skipped (l1/mainnet deployments).
        address sequencerUptimeFeed;
        // ─── Per-Asset Pause (governance-controlled reserve pause) ──────
        // Governance can pause a specific asset without flipping the
        // protocol-wide pause. Creation paths (createOffer, acceptOffer,
        // addCollateral, refinance, preclose-offset) consult this map
        // via {LibFacet.requireAssetNotPaused}; exit paths (repay,
        // liquidate, triggerDefault, claim, withdraw, stake) always
        // remain callable so users can close out existing exposure on
        // an asset that is being wound down. Toggled via
        // {AdminFacet.pauseAsset} / {AdminFacet.unpauseAsset}.
        /// @dev `assetPaused[asset] == true` ⇒ new exposure through this
        ///      asset is blocked. Defaults to false for every asset.
        mapping(address => bool) assetPaused;
        // ─── Per-user reverse indexes for on-chain enumeration ──────────
        // bot / indexer / frontend friendly: lets callers page through
        // every loan and offer a user has touched without scanning event
        // logs. Append-only: entries are never removed even after a loan
        // settles or an offer is cancelled, so historical reads stay
        // stable and the arrays can be treated as monotonic logs.
        // Filtering by current `LoanStatus` / `offerCancelled` is done at
        // read time in the paginated views.
        /// @dev Loans where the user is lender OR borrower. Pushed once
        ///      per side at {LoanFacet.initiateLoan}. Sequential IDs.
        mapping(address => uint256[]) userLoanIds;
        /// @dev Offers created by the user. Pushed once at
        ///      {OfferFacet.createOffer}. Sequential IDs.
        mapping(address => uint256[]) userOfferIds;
        /// @dev Explicit cancel flag. The `Offer.accepted` field is
        ///      reused by matching, so a distinct `offerCancelled` map
        ///      is required to represent the pre-accept cancelled state
        ///      without changing the `Offer` struct layout (append-only
        ///      rule). Reads: both `accepted` and `offerCancelled` are
        ///      terminal — either flag means the offer is no longer
        ///      matchable.
        mapping(uint256 => bool) offerCancelled;
        // ─── MetricsFacet O(1) analytics layer ──────────────────────────
        // Counters and active-set indices maintained by LibMetricsHooks
        // at every loan/offer lifecycle edge. Eliminates the MAX_ITER
        // silent-truncation pattern in MetricsFacet: aggregators become
        // O(1) reads and list views iterate active-set lists in
        // O(results) instead of scanning 1..nextId.
        //
        // Invariants (must hold across every tx boundary):
        //   • activeLoansCount == #{loanId : status ∈ {Active, FallbackPending}}
        //   • activeLoansCount == activeLoanIdsList.length
        //   • activeOffersCount == #{offerId : !accepted && !cancelled}
        //   • activeOffersCount == activeOfferIdsList.length
        //   • activeLoanIdsListPos[id] ∈ {0, 1..activeLoanIdsList.length};
        //     0 ⇔ id not in list; k ⇔ list[k-1] == id (1-based).
        //   • same for activeOfferIdsListPos.
        //   • userSeen[u] == true ⇒ u contributed to uniqueUserCount exactly
        //     once (idempotent _markUserSeen).
        //   • nftsInVaultByCollection[c] == #{active loan legs valued in c
        //     where the leg asset type is not ERC20}.
        //   • loanIdByPositionTokenId[tokenId] points at the loan id whose
        //     lender- or borrower-position NFT has this tokenId; 0 if no
        //     active loan matches.
        //
        // Migration: these fields are append-only and safe to add on a
        // live diamond but will read zero until a one-time backfill walks
        // existing loans/offers and invokes the hooks retroactively.
        /// @dev Count of loans currently in {Active, FallbackPending}.
        uint256 activeLoansCount;
        /// @dev Monotone count of every loan ever initiated. Equals
        ///      nextLoanId on a diamond that has only ever created loans
        ///      via LoanFacet.initiateLoan.
        uint256 totalLoansEverCreated;
        /// @dev Count of loans currently in {Defaulted, Settled} — the
        ///      "loan ended badly or has been wound down" set that
        ///      MetricsFacet.getProtocolStats.defaultRateBps consumes.
        uint256 terminalBadOrSettledCount;
        /// @dev Σ interestRateBps across every loan ever initiated.
        ///      Divided by totalLoansEverCreated to yield averageApr.
        uint256 interestRateBpsSum;
        /// @dev T-032 — cumulative VPFI debited from user vaults and
        ///      routed to treasury via `LoanFacet.markNotifBilled`.
        ///      Never decremented; the operator monitors this for
        ///      anomaly detection (a compromised NOTIF_BILLER_ROLE
        ///      could falsely bill, capped at the per-loan-side fee
        ///      but observable here as a spike).
        uint256 notificationFeesAccrued;
        /// @dev Count of offers currently not accepted and not cancelled.
        uint256 activeOffersCount;
        /// @dev Count of unique wallets that have ever created an offer
        ///      or participated in a loan as lender/borrower. Pure
        ///      lifetime counter — never decremented.
        uint256 uniqueUserCount;
        /// @dev Idempotency guard for `uniqueUserCount`.
        mapping(address => bool) userSeen;
        /// @dev Per-collection count of active loan legs whose asset type
        ///      is NFT (ERC721/ERC1155). An active loan with NFT principal
        ///      leg increments the principal collection; NFT collateral
        ///      leg increments the collateral collection. Both can
        ///      increment the same collection when the legs share it.
        mapping(address => uint256) nftsInVaultByCollection;
        /// @dev Reverse map from Vaipakam position NFT id → loan id.
        ///      Populated at loan initiation for both lender and borrower
        ///      position NFTs. Stays set after the loan settles so
        ///      historical lookups still resolve; readers that require
        ///      liveness must check `loan.status` themselves.
        mapping(uint256 => uint256) loanIdByPositionTokenId;
        /// @dev Reverse map from Vaipakam position NFT id → offer id.
        ///      Populated at offer creation in OfferFacet._writeOfferFields;
        ///      cleared when the offer transitions to a loan (accept) or
        ///      gets cancelled. Pairs with `loanIdByPositionTokenId` to
        ///      give MetricsFacet a complete tokenId → (offer | loan)
        ///      reverse lookup in O(1). Used by `getUserPositionOffers`
        ///      to enumerate the offers whose creator-NFT a given user
        ///      currently holds (catches secondary-market recipients
        ///      whose address is NOT in `userOfferIds[user]`).
        mapping(uint256 => uint256) offerIdByPositionTokenId;
        /// @dev Append-with-swap-pop list of active loan ids. Enables
        ///      O(results) iteration for MetricsFacet.getActiveLoansPaginated.
        uint256[] activeLoanIdsList;
        /// @dev 1-based position map for swap-and-pop removal.
        mapping(uint256 => uint256) activeLoanIdsListPos;
        /// @dev Active-offer analogue of `activeLoanIdsList`.
        uint256[] activeOfferIdsList;
        /// @dev 1-based position map for active-offer swap-and-pop.
        mapping(uint256 => uint256) activeOfferIdsListPos;
        // ─── ETH-referenced oracle / liquidity config ────────────────────
        // OracleFacet classifies an ERC-20 as Liquid via a v3-style AMM
        // asset/WETH 0.3% pool (the deepest quote layer across EVM
        // chains), converts depth to USD via the ETH/USD feed, and
        // prices assets with a hybrid rule: prefer a direct asset/USD
        // Chainlink feed; fall back to asset/ETH × ETH/USD when no
        // direct USD feed exists. On L2s where the Chainlink Feed
        // Registry is not deployed, `chainlnkRegistry` is address(0)
        // and both the USD and ETH Feed Registry lookups are skipped —
        // pricing flows through the direct `ethNumeraireFeed` address for
        // WETH and reverts with {NoPriceFeed} for other assets unless
        // the admin wires a per-asset direct feed (not yet exposed;
        // tracked in the follow-up).
        /// @dev AggregatorV3 address for ETH/USD (8 decimals). REQUIRED
        ///      for liquidity depth conversion and for pricing WETH
        ///      itself. Zero disables every ETH-quoted code path.
        address ethNumeraireFeed;
        /// @dev Chainlink Feed Registry ETH pseudo-address denominator
        ///      (mainnet: 0x0000...0000000EeeeE...). Used by
        ///      getAssetPrice to look up asset/ETH feeds as the USD
        ///      fallback. Zero on L2s and disables the asset/ETH
        ///      fallback path.
        address ethChainlinkDenominator;
        // ─── Generalized stablecoin peg registry ─────────────────────────
        // OracleFacet's peg-aware stale branch accepts a price as fresh
        // if the feed (8-decimal USD-quoted) reports within
        // ORACLE_PEG_TOLERANCE_BPS of the USD $1 anchor OR of any
        // registered fiat / commodity reference (EUR, JPY, XAU, etc.).
        // The reference feeds are Chainlink 8-decimal USD-quoted
        // aggregators; they are themselves subject to the 25h
        // ORACLE_STABLE_STALENESS ceiling (their heartbeats are also
        // 24h+), and are skipped in the peg loop if stale beyond that.
        //
        // symbol key is `bytes32(bytes(symbol))` with right-padded
        // zeroes — e.g. `"EUR" -> 0x4555520000...`. Registry is
        // maintained swap-and-pop so iteration is O(active symbols).
        /// @dev Fiat / commodity symbol → AggregatorV3 reference feed.
        mapping(bytes32 => address) stableFeedBySymbol;
        /// @dev Append-with-swap-pop list of registered symbols.
        bytes32[] stableFeedSymbolsList;
        /// @dev 1-based position map for swap-and-pop removal.
        mapping(bytes32 => uint256) stableFeedSymbolPos;
        // ─── Per-feed oracle override (Phase 3.1 hardening) ──────────────
        // Lets governance tighten `maxStaleness` and install a minimum-
        // valid-answer floor on individual Chainlink aggregators WITHOUT
        // redeploying. The two-tier global defaults (ORACLE_VOLATILE_
        // STALENESS / ORACLE_STABLE_STALENESS) remain the fallback — an
        // override is consulted only when `maxStaleness > 0`. Set via
        // `OracleAdminFacet.setFeedOverride` under ORACLE_ADMIN_ROLE,
        // which becomes timelock-gated after the governance handover.
        //
        // Use cases:
        //   - High-value collateral (BTC, ETH) feed gets a tighter 30-
        //     minute staleness to reduce the blind window vs the default
        //     2h volatile ceiling.
        //   - A feed known to occasionally return 1 wei during incidents
        //     gets a `minValidAnswer` floor so a bad read reverts rather
        //     than producing a fake "asset collapse" price.
        //   - An off-US-market-hours commodity feed gets a relaxed
        //     staleness to avoid false stalenesss reverts overnight.
        mapping(address => FeedOverride) feedOverrides;
        // ─── Address-level sanctions oracle (Phase 4.3) ─────────────────
        // Chainalysis operates a free on-chain sanctions oracle on every
        // chain it supports; governance sets this slot to the per-chain
        // oracle address via {ProfileFacet.setSanctionsOracle}. When the
        // slot is non-zero, {OfferFacet.createOffer} and
        // {OfferFacet.acceptOffer} both refuse calls from (or involving)
        // flagged addresses — the OFAC-aligned "no new business" posture.
        // Ongoing actions (repay, claim) stay unrestricted so existing
        // counterparties aren't stranded. `address(0)` disables the
        // check entirely, which is the correct state on chains where
        // Chainalysis does not deploy an oracle.
        address sanctionsOracle;
        // ─── Legal: Terms of Service acceptance (Phase 4.1) ──────────────
        // On-chain record of every wallet's acceptance of the current ToS
        // version. `currentTosVersion` starts at 0 (no ToS in force), which
        // the frontend treats as "gate disabled — app is still pre-launch
        // / testnet"; once governance sets `currentTosVersion >= 1` via
        // `LegalFacet.setCurrentTos`, every user wallet must sign an
        // `acceptTerms(version, hash)` tx before the frontend unlocks
        // `/app/*` routes. The version+hash pair in storage lets audit
        // tooling reconstruct exactly which ToS text a given user agreed
        // to and when.
        uint32 currentTosVersion;
        bytes32 currentTosHash;
        mapping(address => TosAcceptance) tosAcceptance;
        // ─── Phase 2 Interaction Reward Accrual (spec §4 daily) ─────────
        // Replaces the Phase-1 "lump-sum-at-settlement" accounting with
        // per-day accrual. Each loan, on {LoanFacet.initiateLoan},
        // contributes `perDayNumeraire18` to the running open-per-day counter
        // via a START-day delta. At close, a matching NEGATIVE delta is
        // stamped on the close day (exclusive endDay). The delta cursor
        // is advanced lazily by the reporter path when shipping day `d`
        // AND by the claim path when walking reward entries.
        //
        // Claim math: per-entry reward =
        //   perDayNumeraire18 × (cumRPN18[endDay-1] − cumRPN18[startDay-1]) / 1e18
        // where cumRPN18[d] = Σ_{d' ≤ d} halfPool[d'] × 1e18 / globalTotal[d'].
        // Global denominator comes from the finalized cross-chain
        // broadcast (`knownGlobal*InterestNumeraire18[d]`); cumRPN cannot advance
        // past days whose broadcast hasn't landed.
        //
        // Forfeit routing (user directive):
        //   - defaulted / liquidated / post-grace cured borrower
        //     → entry.forfeited = true, reward goes to treasury
        //   - early-withdrawal-sale initiator (the old lender at transfer)
        //     → entry.forfeited = true, reward goes to treasury
        // A permissionless {sweepForfeitedByLoanId} lets anyone push
        // already-closed forfeited entries into the treasury accumulator
        // (covers abandoned wallets that never claim).

        /// @dev Sequential id → RewardEntry.
        mapping(uint256 => RewardEntry) rewardEntries;
        /// @dev Monotone-increasing id allocator; 0 is the "unset" sentinel.
        uint256 nextRewardEntryId;
        /// @dev Append-only list of entry ids per user (lender + borrower).
        mapping(address => uint256[]) userRewardEntryIds;
        /// @dev Per-loan borrower entry id (0 ⇒ unset). A loan has at most
        ///      one borrower entry.
        mapping(uint256 => uint256) loanBorrowerEntryId;
        /// @dev Per-loan CURRENTLY-OPEN lender entry id (0 ⇒ unset). On
        ///      early-withdrawal transfer, this pointer is advanced to the
        ///      new lender's freshly forged entry; the prior entry is
        ///      closed with forfeit=true.
        mapping(uint256 => uint256) loanActiveLenderEntryId;
        /// @dev Net change applied to {lenderOpenPerDayNumeraire18} at the START
        ///      of day `d`. registerLoan bumps [startDay] up, closeLoan
        ///      bumps [endDay] down. Stored as int256 for the net-zero
        ///      symmetry on same-day register + close.
        mapping(uint256 => int256) lenderPerDayDeltaNumeraire18;
        /// @dev Mirror of {lenderPerDayDeltaNumeraire18} for the borrower side.
        ///      Clean / forfeit status is recorded on the RewardEntry, NOT
        ///      by reversing deltas — defaulted borrowers remain in the
        ///      denominator to keep the daily pool budget stable.
        mapping(uint256 => int256) borrowerPerDayDeltaNumeraire18;
        /// @dev Running sum of `perDayNumeraire18` across lender-side loans open
        ///      at {lenderFrontierDay}. Advanced by {advanceLenderThrough}.
        uint256 lenderOpenPerDayNumeraire18;
        /// @dev Running sum of `perDayNumeraire18` across borrower-side loans
        ///      open at {borrowerFrontierDay}.
        uint256 borrowerOpenPerDayNumeraire18;
        /// @dev Last day for which {totalLenderInterestNumeraire18}[d] has been
        ///      snapshotted from the delta walk. Advance must be called
        ///      before the reporter ships day `d`.
        uint256 lenderFrontierDay;
        /// @dev Mirror of {lenderFrontierDay} for the borrower side.
        uint256 borrowerFrontierDay;
        /// @dev cumRPN18[d] = cumulative VPFI-wei reward per 1e18 Numeraire18
        ///      through END of day `d`, using the GLOBAL (cross-chain)
        ///      denominator. Populated lazily by {advanceCumLenderThrough};
        ///      halts at the first day without `knownGlobalSet[d]`.
        mapping(uint256 => uint256) cumLenderRpn18;
        /// @dev Mirror of {cumLenderRpn18} for the borrower side.
        mapping(uint256 => uint256) cumBorrowerRpn18;
        /// @dev Last day through which {cumLenderRpn18} is populated
        ///      (contiguous from day 0). Day 0 cum = 0 (spec §4 exclusion).
        uint256 cumLenderCursor;
        /// @dev Mirror of {cumLenderCursor} for the borrower side.
        uint256 cumBorrowerCursor;
        /// @dev Admin-configurable protocol parameters (fees, VPFI tier
        ///      table, risk knobs). Zero fields fall back to their
        ///      `LibVaipakam` constant defaults — see {ProtocolConfig}
        ///      and the `cfg*` helpers below. Written exclusively through
        ///      {ConfigFacet} under ADMIN_ROLE (routed through the 48h
        ///      Timelock post-handover).
        ProtocolConfig protocolCfg;
        // ─── Borrower LIF discount claim bookkeeping (Phase 5 / §5.2b) ─
        /// @dev Per-loan custody + claimable rebate for the borrower
        ///      VPFI-path LIF. Keys are loan ids. A loan that took the
        ///      lending-asset path (no VPFI discount) never touches this
        ///      mapping — the zero struct reads correctly and settlement
        ///      helpers no-op on zero vpfiHeld.
        mapping(uint256 => BorrowerLifRebate) borrowerLifRebate;
        // ─── Phase 7a: liquidation swap adapter failover chain ──────────
        /// @dev Priority-ordered list of {ISwapAdapter} contracts.
        ///      {LibSwap.swapWithFailover} iterates from index 0 and
        ///      commits on the first adapter that returns proceeds
        ///      at least equal to the oracle-derived `minOutputAmount`.
        ///      Governance (AdminFacet, ADMIN_ROLE) maintains the list
        ///      via `addSwapAdapter` / `removeSwapAdapter` /
        ///      `reorderSwapAdapters`. An empty list reverts
        ///      {LibSwap.NoSwapAdaptersConfigured} — any deployment
        ///      that routes liquidations must populate this array
        ///      before the first loan settles.
        address[] swapAdapters;
        // ─── Phase 7b: multi-venue oracle liquidity check ───────────────
        /// @dev PancakeSwap V3 factory address on this chain. PancakeV3
        ///      is a Uniswap V3 fork — same `IUniswapV3Factory.getPool`
        ///      lookup, same `slot0()` / `liquidity()` pool views — so
        ///      the depth probe in {OracleFacet} can target it via the
        ///      identical helper used for UniswapV3. Governance sets
        ///      per-chain; null collapses the OR-combine to whichever
        ///      other factories are configured. PancakeV3's fee-tier
        ///      set differs slightly from UniV3 (uses 2500 in place of
        ///      3000) so the on-chain probe iterates a superset that
        ///      covers every clone.
        address pancakeswapV3Factory;
        /// @dev SushiSwap V3 factory address on this chain. Also a
        ///      Uniswap V3 fork; same probe semantics as PancakeV3.
        ///      Together with `uniswapV3Factory` and
        ///      `pancakeswapV3Factory`, gives the liquidity check 1-of-3
        ///      OR-redundancy without any per-asset governance config.
        address sushiswapV3Factory;
        // ─── Phase 7b.2: cross-provider price-feed redundancy ──────────
        /// @dev Tellor oracle address on this chain. Tellor is keyed
        ///      by 32-byte queryId derived from the asset's symbol via
        ///      `keccak256(abi.encode("SpotPrice", abi.encode(symbol,
        ///      "usd")))`. {OracleFacet} reads `asset.symbol()` on
        ///      demand, lowercases it, derives the queryId, and runs
        ///      a deviation check against the Chainlink primary.
        ///      Zero address disables the Tellor leg silently — the
        ///      primary still works, no revert. Per-asset governance
        ///      config is intentionally NOT present.
        address tellorOracle;
        /// @dev API3 ServerV1 address on this chain. API3 is keyed by
        ///      32-byte dapiName hash derived from the asset's symbol
        ///      via `keccak256(abi.encodePacked(bytes32(string(symbol,
        ///      "/USD"))))`. Same derivation pattern as Tellor; same
        ///      no-per-asset-config policy.
        address api3ServerV1;
        /// @dev DIA Oracle V2 address on this chain. DIA is keyed by
        ///      a string `<SYMBOL>/USD` (e.g. "ETH/USD"). {OracleFacet}
        ///      derives the key by reading `asset.symbol()` and
        ///      concatenating `/USD`. Same no-per-asset-config policy
        ///      as Tellor + API3.
        address diaOracleV2;
        /// @dev Maximum allowed deviation between the Chainlink
        ///      primary and any secondary oracle (Tellor / API3),
        ///      in basis points. Chain-level config — no per-asset
        ///      override. Defaults to 500 (5%) on a fresh deploy
        ///      until governance writes a non-zero value via
        ///      `setSecondaryOracleMaxDeviationBps`. Zero is treated
        ///      as "use the LibVaipakam.SECONDARY_ORACLE_MAX_DEVIATION_BPS_DEFAULT".
        uint16 secondaryOracleMaxDeviationBps;
        /// @dev Maximum acceptable secondary-oracle data age, in
        ///      seconds. Chain-level. Defaults to
        ///      `LibVaipakam.SECONDARY_ORACLE_MAX_STALENESS_DEFAULT`
        ///      when zero.
        uint40 secondaryOracleMaxStaleness;
        // ─── T-033 — Pyth as numeraire-redundancy oracle ───────────────
        //
        // Pyth was removed in Phase 7b.2 because a per-asset `priceId`
        // mapping conflicts with the no-per-asset-config policy. T-033
        // re-introduces it in a *numeraire-only* shape: one Pyth feed
        // per chain (ETH/USD or, on non-ETH-native chains, WETH/USD)
        // is consulted as a sanity gate alongside Chainlink's
        // ETH/USD reading. Per-asset redundancy stays the symbol-
        // derived Tellor / API3 / DIA secondary quorum — Pyth doesn't
        // replace it, just adds a single load-bearing-peg defense.

        /// @dev Pyth contract address on this chain. Zero disables
        ///      the numeraire gate silently — protocol falls back to
        ///      Chainlink-only on the WETH/USD reading. Same
        ///      "off-by-default-on-fresh-deploy" pattern as the other
        ///      secondary oracles.
        address pythOracle;
        /// @dev Pyth feed id for this chain's numeraire ETH/USD (or
        ///      bridged WETH/USD on chains where bridged WETH is the
        ///      unit of account, e.g. BNB / Polygon mainnet). Single
        ///      governance write per chain — adding new collateral
        ///      assets never touches this slot.
        bytes32 pythCrossCheckFeedId;
        /// @dev Maximum acceptable staleness (in seconds) for the
        ///      Pyth numeraire snapshot. Beyond this, the gate soft-
        ///      skips (treats Pyth as unavailable for this read);
        ///      Chainlink-only proceeds. Bounded to
        ///      `[PYTH_MAX_STALENESS_MIN_SECONDS,
        ///      PYTH_MAX_STALENESS_MAX_SECONDS]` by the setter.
        uint64 pythMaxStalenessSeconds;
        /// @dev Maximum tolerated divergence between Chainlink ETH/USD
        ///      and Pyth ETH/USD, in basis points (1 bp = 0.01%).
        ///      Beyond this, the price view fails-closed
        ///      (`OracleCrossCheckDivergence`). Bounded to
        ///      `[PYTH_NUMERAIRE_MAX_DEVIATION_BPS_MIN,
        ///      PYTH_NUMERAIRE_MAX_DEVIATION_BPS_MAX]` by the setter
        ///      so a misconfig can't accidentally halt the protocol
        ///      (zero) or effectively disable the gate (≥ 100%).
        uint16 pythCrossCheckMaxDeviationBps;
        /// @dev Maximum tolerated Pyth confidence fraction
        ///      (`conf / price`) in basis points. When the published
        ///      uncertainty exceeds this, the gate soft-skips Pyth
        ///      (the publisher window is too thin to trust). Bounded
        ///      to `[PYTH_CONFIDENCE_MAX_BPS_MIN,
        ///      PYTH_CONFIDENCE_MAX_BPS_MAX]` by the setter.
        uint16 pythConfidenceMaxBps;
        // ── Range Orders Phase 1 — match-override slot ─────────────────
        // Set by `OfferFacet.matchOffers` immediately before
        // cross-facet-calling `LoanFacet.initiateLoan`, read by
        // `LoanFacet._copyFinancialFields`, cleared at the end of the
        // matchOffers tx. Lets matchOffers inject the midpoint match
        // terms (amount / rateBps / collateralAmount) into the loan
        // without changing `LoanFacet.initiateLoan`'s signature. The
        // `active` flag distinguishes "matchOffers in flight" from
        // "legacy single-value path" — the latter never sets it, so
        // _copyFinancialFields falls back to reading offer.amount /
        // offer.interestRateBps / offer.collateralAmount as before
        // (auto-collapse keeps that semantically correct because in
        // single-value mode amountMax == amount).
        MatchOverride matchOverride;
        // ── T-044 — admin-configurable loan-default grace schedule ─────
        // Empty array (length == 0) means "use the compile-time default
        // schedule embedded in `gracePeriod()`" — zero-config-friendly.
        // Populated array overrides the defaults; entries must be sorted
        // ascending on `maxDurationDays`, with the final entry's
        // `maxDurationDays == 0` marking the catch-all bucket. Validated
        // by {ConfigFacet.setGraceBuckets} against
        // GRACE_BUCKETS_MAX_LEN / GRACE_BUCKET_DAYS_MIN/MAX /
        // GRACE_SECONDS_MIN/MAX before any write.
        GraceBucket[] graceBuckets;
        // ── Stuck-token recovery (T-054 PR-3) ──────────────────────
        // Per-user replay-protection nonce for the EIP-712 recovery
        // acknowledgment. Incremented on every successful
        // `recoverStuckERC20` call so a previously-signed payload
        // can't be re-submitted. See
        // `docs/DesignsAndPlans/VaultStuckRecoveryDesign.md` §5.
        mapping(address => uint256) recoveryNonce;
        // Per-user "this vault declared a sanctioned source via the
        // recovery flow" mapping. When set to a non-zero address, the
        // sanctions check delegates to that source's CURRENT oracle
        // status — so the ban auto-unlocks if the address is later
        // de-listed without any on-chain action by us. Zero ⇒ no
        // recovery-induced ban.
        mapping(address => address) vaultBannedSource;
        // ── Vault protocol-tracked balance counter (T-051 / T-054) ──
        // Per-(user, token) running counter of ERC-20 amount the
        // protocol has deposited into / withdrawn from the user's
        // vault proxy. Incremented by `VaultFactoryFacet.vaultDepositERC20`
        // (and the counter-only sibling `recordVaultDepositERC20`,
        // used after Permit2 pulls); decremented by
        // `vaultWithdrawERC20`. Every protocol-side ERC-20 deposit
        // is required to flow through one of those entry points so
        // the counter stays correct.
        //
        // Two consumers depend on this being accurate:
        //
        //   1. The Asset Viewer / external integrations that want to
        //      display only protocol-managed balances. They render
        //      `min(balanceOf(vault, token), protocolTrackedVaultBalance[user][token])`
        //      so unsolicited dust someone pushed in directly via
        //      `IERC20.transfer` is structurally hidden from the UI.
        //
        //   2. The future stuck-token recovery flow (T-054). Recovery
        //      is capped at `max(0, balanceOf - tracked)` — the
        //      arithmetic itself prevents the recovery path from
        //      ever pulling protocol-managed collateral / claims /
        //      staked VPFI no matter what other checks were
        //      bypassed. Load-bearing safety property.
        //
        // The VPFI discount accumulator (`LibVPFIDiscount.rollupUserDiscount`)
        // also clamps to `min(balanceOf, tracked)` so unsolicited VPFI
        // dust does NOT inflate the tier.
        //
        // Underflow on withdraw means a withdrawal fired without a
        // matching deposit — that's an accounting bug somewhere upstream
        // and we want it to revert loudly rather than silently rolling
        // negative.
        mapping(address => mapping(address => uint256)) protocolTrackedVaultBalance;
        // ── Depth-tiered LTV (Piece B) — Predominantly Available Assets ─
        // Per-chain list of the "predominantly available" quote tokens
        // the liquidity check probes an asset's pools against — the
        // on-chain ERC-20 incarnations of the chain's deep stablecoin /
        // ETH liquidity (e.g. `[WETH, USDC, USDT, DAI]` by their
        // addresses on this chain). Distinct from PAD (the *unit of
        // account* the size thresholds are denominated in — USD/EUR/…,
        // typically not an ERC-20): PAA is *what pools we look at*, PAD
        // is *what we measure depth in*. Maintained by `ADMIN_ROLE`
        // (later governance) via `ConfigFacet.set/add/removePaaAsset`;
        // empty ⇒ {effectivePaaAssets} falls back to `[wethContract]`,
        // so an un-configured deploy behaves exactly like today's
        // WETH-only probe in `OracleFacet._v3DepthLiquid`. Keep it short
        // (2-4 entries) — every entry adds a `getPool` probe × the
        // ≤0.3% fee tiers to the liquidity check's hot path. Order is
        // irrelevant (the check takes the best route over all of them).
        // Pure-address config — no per-asset *tiering* allowlist; the
        // only per-asset *remove* lever stays `AdminFacet.pauseAsset` /
        // the blacklist.
        address[] paaAssets;
        // Keeper liquidity-confidence tier per asset (§4.1.b item 2).
        // Default `0` is read as `KEEPER_TIER_DEFAULT` (= Tier 1) via
        // {effectiveKeeperTier} — so a brand-new asset opens at Tier 1
        // (`HF ≥ 1.5`) until the off-chain 0x/1inch confidence relay
        // (`KEEPER_ROLE`, §4.4 step 5) promotes it. `effectiveTier(asset)
        // = min(getLiquidityTier(asset), effectiveKeeperTier(asset))` —
        // a compromised keeper can only lower an asset's tier toward the
        // no-keeper baseline, never raise it above the on-chain ceiling.
        // Written only by `ConfigFacet.setKeeperTier` under `KEEPER_ROLE`.
        mapping(address => uint8) keeperTier;
        // ── Depth-tiered LTV (Piece B) — Uni-V2-fork families ───────────
        // Per-chain Uniswap-V2-style factory addresses, each consulted
        // as an additional leg of `OracleFacet.getLiquidityTier`'s route
        // search alongside the V3-clone trio. V2 pools use a different
        // ABI (`factory.getPair(t0, t1)` — bidirectional, no fee tier
        // arg; `pool.getReserves()` returns *real* reserves, not the
        // tick-virtual approximation — so the in-pool depth measurement
        // is exact, no `_v3VirtualReserves` step), and each clone's
        // canonical fee tier differs (UniV2 / SushiV2 = 30bps = 3000
        // pips; PancakeV2 = 25bps = 2500 pips) — fed straight into
        // {LibSlippage.priceImpactBps}'s `feePips` arg. Zero ⇒ skip
        // that leg (same as the V3 trio); a fresh deploy has all three
        // unset, so the route search behaves exactly like the V3-only
        // configuration until governance configures them. Governance
        // setters live on {AdminFacet} (`setUniswapV2Factory` etc.) —
        // same shape as the V3-clone setters above.
        address uniswapV2Factory;
        address sushiswapV2Factory;
        address pancakeswapV2Factory;
        // ── Phase 3 of AutonomousLtvAndOracleFallback.md — peer-protocol addresses ──
        // Per-chain peer-lending-protocol addresses that the autonomous
        // tier-LTV cache reads (Phase 4 builds the refresh function on
        // top of these). All read-only — Vaipakam never writes to peer
        // contracts; the addresses just say "where to read LTV data
        // from for each protocol on this chain".
        //
        // Zero ⇒ skip that peer in the aggregation (peer not deployed
        // on this chain). A fresh deploy has all three unset; the
        // refresh function then falls back to library defaults.
        //
        // Governance setter: `OracleAdminFacet.setPeerProtocolAddresses`
        // under `ORACLE_ADMIN_ROLE`. Addresses verified against each
        // peer's official docs at the deploy step + audit.
        //
        // `aaveV3PoolDataProvider` — Aave V3's public data-provider
        // contract. Calls `getReserveConfigurationData(asset)` to read
        // an asset's LTV + liquidation threshold in BPS.
        //
        // `compoundV3Comet` — A single Compound V3 Comet (one base
        // asset per Comet — typically the chain's largest by liquidity;
        // operator picks at deploy). Multi-Comet aggregation is a
        // documented Phase-3-follow-up; for v1, the single Comet is
        // enough to add Compound to the consensus.
        //
        // `morphoBlue` — Morpho-Blue contract for per-market parameter
        // reads. Documented as Phase-3-follow-up; v1 reads only Aave
        // + Compound, so this slot can sit at zero until the
        // market-id enumeration story is built (deferred to Phase 3.5).
        address aaveV3PoolDataProvider;
        address compoundV3Comet;
        address morphoBlue;
        // ── Phase 4 of AutonomousLtvAndOracleFallback.md — tier-LTV cache ──
        // Per-tier cached LTV in BPS + last-refreshed timestamp.
        // Refreshed permissionlessly via `OracleFacet.refreshTierLtvCache()`
        // by anyone; the on-chain aggregation reads Aave V3 + Compound
        // V3 via `LibPeerLTV`, computes per-tier median across a
        // reference asset list, applies the per-tier haircut + bound
        // check, and writes here. Loan init reads this when computing
        // the per-asset init-LTV cap.
        //
        // Cache TTLs: 7d soft (informational stale event), 14d hard
        // (fall back to library defaults). Anyone may refresh at any
        // time — no permission, no rate-limit (per-refresh gas cost
        // is the natural rate-limit).
        mapping(uint8 => TierLtvCacheEntry) tierLtvCache;
        // Per-tier reference asset list — the assets that get queried
        // across each peer protocol during a refresh. Constitution-level:
        // set at deploy via `OracleAdminFacet.setTierReferenceAssets`,
        // changes require an owner-level governance call. Asset
        // selection is per-chain (e.g. Tier-3 on Base = WBTC, USDC,
        // USDT, cbETH, cbBTC; Tier-3 on Arb = WBTC, USDC, USDT, WETH,
        // LINK).
        //
        // Empty array for a tier ⇒ refreshes for that tier emit
        // `TierLtvCacheRefreshRejected(_, _, "no-reference-assets")`
        // and leave the cache value untouched.
        mapping(uint8 => address[]) tierReferenceAssets;
        // Phase 7 of AutonomousLtvAndOracleFallback.md — per-tier
        // safety-box parameters (floor / ceiling / haircut), governance-
        // configurable via `ConfigFacet.setTierLtvParams` (ADMIN_ROLE,
        // atomic for all three tiers, monotonic-boundary enforced).
        // Zero entries fall through to the library constants
        // (`TIER1/2/3_LTV_FLOOR_BPS` / `_CEIL_BPS` / `_HAIRCUT_BPS`).
        // A fresh deploy never touches this mapping ⇒ library defaults
        // apply everywhere until governance overrides.
        mapping(uint8 => TierLtvParams) tierLtvParams;
        // ─── EC-003 Phase 2 — asset-pair index of matchable loans ──────
        //
        // Mirrors the offer-side `assetPairActiveOfferIds` /
        // `assetPairActiveOfferIdsPos` pattern: a per-(principalAsset,
        // collateralAsset) array of loan IDs in the matchable set,
        // with a 1-based position map for O(1) swap-and-pop removal.
        //
        // Invariant: an entry exists iff the loan's status is in the
        // matchable set `{Active, FallbackPending}`. Loans push on
        // `initiateLoan`; terminal transitions (Active/FallbackPending
        // → Repaid/Defaulted/Settled/InternalMatched) remove via
        // swap-and-pop. Active ↔ FallbackPending edges keep the loan
        // in the index — both are matchable.
        //
        // Lookup for "does loan L have an opposing counterparty?" is
        // a read of `assetPairActiveLoanIds[L.collateralAsset][L.principalAsset]`
        // — the OPPOSING-direction key. The list size is the loose
        // upper bound on the on-chain auto-dispatch scan cost; the
        // per-iteration cost is the candidate's oracle-priceable
        // check. Total complexity: O(K) where K = candidates in
        // that exact asset pair — not O(N) over `activeLoanIdsList`.
        //
        // Foundation for the Phase 3 auto-dispatch in
        // `triggerLiquidation` / `triggerDefault` /
        // `claimAsLenderWithRetry`.
        mapping(address => mapping(address => uint256[])) assetPairActiveLoanIds;
        mapping(address => mapping(address => mapping(uint256 => uint256))) assetPairActiveLoanIdsPos;
        // ── Treasury conversion (T-600) — config + runtime state ───────
        // The fully governance-configurable target allocation for
        // `convertTreasuryAsset`: an ordered list of `(asset, bps)`
        // entries whose BPS sum to exactly 10000. Set atomically via
        // `ConfigFacet.setTreasuryConvertTargets` (ADMIN_ROLE → Timelock
        // → governance) — that one setter expresses add / remove /
        // reweight, and validates the sum-to-10000 invariant on every
        // write. Empty ⇒ `convertTreasuryAsset` reverts until governance
        // configures it (asset addresses are per-chain — there is no
        // sensible compile-time default). The FINAL entry absorbs
        // integer-division rounding.
        TreasuryConvertTarget[] treasuryConvertTargets;
        // Unix timestamp of the last successful
        // `TreasuryFacet.convertTreasuryAsset`. Drives the
        // time-based leg of the eligibility gate. 0 ⇒ never converted.
        uint64 treasuryLastConversionAt;
        // ── Founder / contributor salary streams (T-600 PayrollFacet) ──
        // Per-stream payroll state. `payrollStreamCount` is the monotone
        // next-id source — stream ids are 1-based, so id 0 is an
        // unambiguous "no stream" sentinel. A stream is funded ONLY by
        // an explicit `fundPayrollStream` governance top-up — never by a
        // fee accrual or a treasury conversion. That separation is the
        // structural guarantee that the founder salary is compensation
        // for services, not a securities-style revenue share.
        mapping(uint256 => PayrollStream) payrollStreams;
        uint256 payrollStreamCount;
        // ── T-086 step 5 — `collateralListingExecutor` singleton address ──
        // Append-only field. The Seaport prepay-listing flow routes
        // ERC-1271 sign-time + zone-callback fill-time verification
        // through a dedicated singleton (see
        // `contracts/src/seaport/CollateralListingExecutor.sol`). The
        // diamond stores the executor's address here so the
        // step-5 `PrepayListingFacet.executorFinalizePrepaySale`
        // callback can assert `msg.sender == storedExecutor` before
        // touching loan state (privileged-caller gate).
        //
        // Set post-deploy via `PrepayListingFacet.setCollateralListingExecutor`
        // (ADMIN_ROLE-gated → governance timelock + multisig
        // post-handover, per the CLAUDE.md Cross-Chain Security
        // Policy pattern). Default `address(0)` while unset; the
        // callback method's gate refuses every call until governance
        // wires the executor.
        address collateralListingExecutor;
        // ── T-086 step 6 — borrower-facing prepay-listing state ─────────
        // `prepayListingOrderHash[loanId]` is the Seaport orderHash the
        // borrower currently has live on the conduit for `loanId`, or
        // `bytes32(0)` if no listing is active. Three reasons for the
        // mapping (vs. inferring "is there a listing?" from the lock
        // alone):
        //   1. {NFTPrepayListingFacet.cancelPrepayListing} and the
        //      permissionless {cancelExpiredPrepayListing} need to
        //      call `executor.clearOrder(orderHash)` without forcing
        //      the caller (especially the permissionless cancel path)
        //      to know the off-chain orderHash. Indexers / frontends
        //      can cancel by loanId alone.
        //   2. {updatePrepayListing} must clear the OLD orderHash on
        //      the executor before recording the new one — a previous
        //      orderHash left in `orderContext` would still be
        //      fillable until grace expiry. We need the old hash to
        //      pass to `clearOrder`.
        //   3. The `LibERC721._lock(LockReason.PrepayCollateralListing)`
        //      lock is the consent + safety primitive; this mapping
        //      is the orderHash bookkeeping. Keeping them in separate
        //      storage slots avoids overloading the lock semantics.
        // Default `bytes32(0)`; the listing facet treats zero as "no
        // active listing" and the lock state is the canonical
        // post/cancel signal.
        mapping(uint256 => bytes32) prepayListingOrderHash;
        // T-086 step 6 round 2 — recording-executor pin per listing
        // (Codex P2 catch on PR #300 round 2). Records the
        // executor address that was active in
        // `s.collateralListingExecutor` at post/update time, so a
        // cancel can call `clearOrder` on THAT executor's
        // `orderContext` mapping rather than whichever executor is
        // currently configured. Governance rotation A → B while a
        // listing is live would otherwise leave A's orderContext
        // populated forever — and if A is later restored, the
        // supposedly-canceled order resurrects. Default `address(0)`
        // ≡ "no active listing"; set atomically with
        // `prepayListingOrderHash` in post / update; cleared
        // atomically with it in cancel / finalize.
        mapping(uint256 => address) prepayListingExecutor;
        // `cfgPrepayListingBufferBps` — the safety margin the listing
        // facet adds on top of the live floor when validating
        // `askPrice` at {NFTPrepayListingFacet.postPrepayListing} /
        // `updatePrepayListing` time. The live floor at the moment of
        // signing is a lower-bound; by the time a Seaport buyer fills
        // the order, accrued interest has grown the floor slightly.
        // Without a buffer, the executor's {validateOrder} zone
        // callback would reject the fill (lender / treasury legs
        // short-paid) and the borrower would have to re-list. The
        // buffer is the fillability headroom — design doc §10.2
        // settles on 200 bps (2%) as the default, which gives the
        // listing several hours of fill window at realistic APRs.
        // Governance-configurable via `ConfigFacet.setPrepayListingBufferBps`
        // (ADMIN_ROLE, range-bounded to ≤ 1000 bps so a misset doesn't
        // accidentally lock out every borrower from listing). Default
        // `0` while unset — the facet treats unset as "buffer
        // discipline not yet configured" and refuses listings until
        // governance has explicitly set it (one-time post-deploy
        // step). Stored as `uint256` for slot-packing simplicity even
        // though only the low 16 bits are used.
        uint256 cfgPrepayListingBufferBps;
        // `cfgPrepayListingEnabled` — master kill-switch for the
        // prepay-listing path. Default `false` until governance flips
        // it on once the FULL flow is wired end-to-end (the vault's
        // narrow `setCollateralOperatorApproval` entry from design-
        // doc step 7, the vault's ERC-1271 delegate, and the
        // default-flow lock-bypass from step 10 — without those,
        // postings can succeed at the diamond-side surface but the
        // Seaport fill path can't actually pull the NFT through the
        // conduit, stranding borrowers in lock-up). The
        // {NFTPrepayListingFacet.postPrepayListing} /
        // `updatePrepayListing` paths refuse to record a new listing
        // while this is `false`; cancel paths stay open regardless
        // (the cleanup path must always work, otherwise a flag-flip
        // window would strand whatever listings did get posted).
        bool cfgPrepayListingEnabled;

        // ─── T-086 Round-7 (Issue #355) — grace-period auto-list ───
        //
        // The auto-list-at-floor path is a permissionless keeper-driven
        // primitive that fires while a loan is in its grace window and
        // either reposts a fresh fixed-price-at-floor listing (Case A —
        // no live listing) or rotates an aspirationally-priced /
        // stale-leg / late-decaying listing down to the protocol floor
        // (Case B). See design doc §18.

        // `prepayListingAutoListOptedOut[loanId]` — borrower-controlled
        // sticky opt-out from the auto-list-at-floor path. Set
        // AUTOMATICALLY by `cancelPrepayListing` when invoked during
        // the grace window AND the cancel actually unwound a live
        // listing (per §18.7); cleared explicitly by the borrower via
        // `clearAutoListOptOut(loanId)`. Reset to `false` on every
        // terminal-loan path (repay / default / refinance / preclose /
        // executorFinalizePrepaySale per round-12 round-3 follow-up).
        // Borrower posting a fresh listing post-cancel does NOT
        // auto-clear the flag (round-3.11 sticky semantics).
        mapping(uint256 => bool) prepayListingAutoListOptedOut;

        // `prepayListingAutoListNonce[loanId]` — per-loan monotonically
        // increasing counter that the auto-list-at-floor salt mixes in
        // to defeat the same-block-cancel-and-relist salt collision
        // surface (Codex round-1 P2 on PR #356). `uint64` is room for
        // 18 quintillion relists per loan — overflow is structurally
        // unreachable. Reset to `0` on every terminal-loan path
        // alongside `prepayListingAutoListOptedOut`.
        mapping(uint256 => uint64) prepayListingAutoListNonce;

        // `cfgPrepayListingAutoListConduitKey` — the default Seaport
        // conduit key the permissionless `autoListAtFloorOnGrace` path
        // posts under for Case A (no existing listing) fresh posts.
        // Case B (rotation) inherits the conduit / conduit-key from
        // the existing listing's `OrderContext`. The keeper has no
        // borrower-specific conduit preference, so the value is set
        // once by governance to the protocol-blessed default (e.g.
        // OpenSea's canonical conduit on the deployed chain).
        // `bytes32(0)` while unset; the auto-list facet refuses to
        // post Case A until governance has explicitly configured it
        // (one-time post-deploy step).
        bytes32 cfgPrepayListingAutoListConduitKey;

        // `cfgPrepayListingDutchGraceMarginSec` — the Dutch B-cond-3b
        // "decays to floor too late" safe-margin (`t_safe =
        // gracePeriodEnd - safeMargin`). Default 3600 seconds = 1 hour
        // (§18.5 B-cond-3b). Bounded at set time by
        // `<= MIN_LOAN_GRACE_PERIOD - 60` so a misset can't pin
        // `t_safe` outside the grace window. The on-chain saturating
        // guard in B-cond-3b (`safeMargin = graceDuration >
        // cfgPrepayListingDutchGraceMarginSec ?
        // cfgPrepayListingDutchGraceMarginSec : graceDuration / 2`)
        // is the runtime defense-in-depth fallback for legacy loans
        // whose grace is shorter than the configured margin. Stored
        // as `uint256` for slot-packing simplicity even though only
        // the low 32 bits are used.
        uint256 cfgPrepayListingDutchGraceMarginSec;

        // ─── T-086 Round-8 (#358) — borrow-OR-sell offer-keyed mappings ──
        // Codex round-9 P1 #3 — these MUST be appended at the END of
        // the Storage struct so they don't shift the slot numbers of
        // every existing field above (which would corrupt every
        // storage read on a diamond upgrade). The platform is pre-live
        // so no live data is at risk yet, but this is the correct
        // append-only posture for forward compatibility.
        //
        // Round-3 against Codex round-1 P1 #5 + Raja P1 #2 + round-3.4
        // sanctions-callback widening + round-3.8 release-lock full slot
        // clear: §19.6 introduced the dedicated offer-keyed surface
        // because the executor's `ctx.loanId == 0` is the unrecorded-
        // order revert sentinel (so the round-2 "reuse recordOrder with
        // loanId = 0" claim was wrong). Four parallel mappings below
        // mirror the existing loan-keyed pattern:
        //
        //   `prepayListingOrderHash`  ↔  `offerPrepayListingOrderHash`
        //   `prepayListingExecutor`   ↔  `offerPrepayListingExecutor`
        //   `prepayListingAutoListNonce` ↔ `parallelSaleNonce`
        //   (no auto-list equivalent for the no-loan branch in v1; the
        //    new `offerConsumedBySale` mapping is the terminal-bit
        //    parallel to `offerCancelled` above.)
        //
        // See `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md` §19.13
        // for the full inventory.
        /// @dev Round-3.2 against Codex round-3.2 P1 #2 line 4802 — the
        ///      no-loan-sale terminal bit.
        mapping(uint256 => bool) offerConsumedBySale;
        /// @dev Round-3 against Codex round-1 P1 #5 — pre-loan Seaport
        ///      orderHash for the offer's parallel-sale listing.
        mapping(uint96 => bytes32) offerPrepayListingOrderHash;
        /// @dev Round-3.4 against Codex round-3.2 P1 #4 line 4803 + §19.7d
        ///      — pinned executor address for the offer's parallel-sale
        ///      listing.
        mapping(uint96 => address) offerPrepayListingExecutor;
        /// @dev Round-3.2 against Raja round-3.2 P3 #2 + §19.10 Q3 —
        ///      per-offer monotonically-increasing nonce.
        mapping(uint96 => uint64) parallelSaleNonce;
        // ─────────────────────────────────────────────────────────
        //  T-090 v1.1 (#389) — intent-based swap-to-repay surface
        //  Storage shape per
        //  docs/DesignsAndPlans/SwapToRepayIntentBased.md §5.2 + §5.6
        //  Appended to the top-level Storage struct (NOT the nested
        //  `protocolCfg` ProtocolConfig) per Codex round-7 P1 #5 —
        //  growing the nested struct would shift every slot after
        //  `protocolCfg` on upgrade and corrupt deployed state.
        // ─────────────────────────────────────────────────────────
        /// @dev §5.6 master switch. Default OFF on every chain; admin
        ///      enables after operator-side LOP address + token
        ///      allowlist verification.
        bool cfgIntentSwapToRepayEnabled;
        /// @dev §5.1 step 4 — HF_SCALE-scaled minimum HF required at
        ///      commit. Default 1.2e18 = 120% (blocks already-stressed
        ///      borrowers from using intent as a liquidation-stall
        ///      tactic). Codex round-10 P1 #1: stored as HF_SCALE-
        ///      scaled uint256, NOT BPS-scaled uint16.
        uint256 cfgIntentMinCommitHF;
        /// @dev §5.4 — buffer above (lenderLeg + treasuryLeg +
        ///      lateFee) the borrower's takerAmount must clear.
        ///      Default 200 bps = 2%.
        uint16 cfgIntentMinOutputBufferBps;
        /// @dev §5.1 step 2 — minimum auction window in seconds.
        ///      Default 60.
        uint32 cfgIntentMinAuctionSeconds;
        /// @dev §5.1 step 2 — maximum auction window in seconds.
        ///      Default 600 (5 min; Fusion's typical setting).
        uint32 cfgIntentMaxAuctionSeconds;
        /// @dev §5.5 — grace window after Fusion deadline before the
        ///      permissionless cancelExpired path opens.
        ///      Default 86400 = 24h.
        uint32 cfgIntentCancelGraceSeconds;
        /// @dev §5.1 — pinned Fusion LimitOrderProtocol address for
        ///      this chain. Admin-rotatable via
        ///      `setFusionLimitOrderProtocol`, BUT the setter reverts
        ///      `IntentLOPRotationWhileCommitsLive` if
        ///      `intentLiveCommitCount > 0` (Codex round-10 P1 #6) so
        ///      already-posted orders' cancel + cancellation flows
        ///      stay bound to the LOP they were committed against.
        address cfgFusionLimitOrderProtocol;
        /// @dev §5.1 step 1 + Codex round-8 P1 #6 — per-token explicit
        ///      allowlists for principal + collateral. Both default-OFF;
        ///      admin adds tokens after operator-side transfer
        ///      round-trip probes confirm non-fee-on-transfer +
        ///      non-rebasing behaviour. Replaces the upstream
        ///      "Liquid leg" check which doesn't probe transfer
        ///      symmetry (round-7's claim that it did was wrong).
        mapping(address => bool) cfgIntentAllowedPrincipalTokens;
        mapping(address => bool) cfgIntentAllowedCollateralTokens;
        /// @dev §5.1 step 9 + Codex round-2 P2 #7 — per-token
        ///      aggregate custodial collateral. Tracks the sum of all
        ///      live `intentCommits[*].custodialCollateral` for this
        ///      token so a second concurrent commit can re-approve
        ///      Fusion's LimitOrderProtocol to the new aggregate
        ///      without clobbering the first commit's allowance.
        mapping(address => uint256) intentAggregateAllowance;
        /// @dev §5.1 step 11 + Codex round-10 P1 #6 — live-commit count.
        ///      Incremented on commit; decremented on
        ///      postInteraction (fill) + cancel + cancelExpired +
        ///      every force-cancel branch. `setFusionLimitOrderProtocol`
        ///      reverts `IntentLOPRotationWhileCommitsLive` if this
        ///      is non-zero; rotation only allowed when no commit is
        ///      live (defense-in-depth alongside the per-commit
        ///      `lopAtCommit` pin).
        uint256 intentLiveCommitCount;
        /// @dev §5.2 — commit projection keyed by loanId.
        mapping(uint256 => SwapToRepayIntentCommit) intentCommits;
        /// @dev §5.2 — reverse-index orderHash → loanId for the
        ///      ERC-1271 + pre/postInteraction hook lookups (the
        ///      hooks receive only the orderHash from Fusion; they
        ///      need the loanId to look up the commit and route to
        ///      the right settlement waterfall).
        mapping(bytes32 => uint256) orderHashToLoanId;
        /// @dev §5.2 — extension bytes keyed by extensionHash. Kept
        ///      off the SwapToRepayIntentCommit struct so the struct
        ///      stays cheap; Fusion's protocol requires the
        ///      borrower's posted order to include the full extension
        ///      bytes, so the dapp reads them back via the
        ///      `getIntentCommit(loanId)` view function on the
        ///      SwapToRepayIntentFacet.
        mapping(bytes32 => bytes) intentExtensionBytes;
        /// @dev Codex round-1 PR #420 P2 #3 — refcount per
        ///      `extensionHash`. Two concurrent commits sharing the
        ///      same canonical extension bytes (the common case for
        ///      v1.1 since every commit on this diamond produces an
        ///      extension consisting of `(diamond, diamond)`)
        ///      increment this rather than overwrite the mapping
        ///      entry, and only the LAST teardown deletes the bytes.
        ///      Without this, closing one commit deletes the bytes
        ///      another live commit still references; `getIntentCommit`
        ///      on that commit would return empty bytes and the
        ///      dapp's resolver-pickup post would fail.
        mapping(bytes32 => uint256) intentExtensionBytesRefCount;
        /// @dev Codex round-1 PR #420 P1 #2 — nonce uniqueness per
        ///      live commit on the diamond. LOP v4 routes our
        ///      `allowPartialFills == false && allowMultipleFills ==
        ///      false` orders through the bit-invalidator path
        ///      where (maker, nonceOrEpoch) is the slot key. Two
        ///      orders sharing the same nonceOrEpoch land in the
        ///      same bit-slot — the first fill invalidates BOTH
        ///      orders (Fusion treats them as duplicates). Tracking
        ///      used nonces here + rejecting reuse forces the dapp
        ///      to vary nonceOrEpoch across borrowers.
        mapping(uint40 => bool) intentNonceUsed;
        // ─── T-087 Sub 1.A — Cross-chain reward + tier system ───────────
        //
        // Storage scaffolding only in Sub 1.A: the slots are added
        // here and the helper library (LibVPFIDiscount) has stub
        // entry points reading / writing them. The math + the
        // call-site rewires land in Sub 1.B; the CCIP wiring lands
        // in Sub 2. See docs/DesignsAndPlans/CrossChainRewardSystem.md
        // §5 for the design rationale; Codex review iteration is
        // tracked in the closed PR #439.
        //
        // ── Base-side: ring-buffer TWA accumulator ──────────────────────
        //
        // Per-user 30-slot daily ring buffer of protocol-tracked
        // stake snapshots, indexed by `dayId = block.timestamp /
        // 1 days`. Each slot stores its own `dayId` so the TWA
        // scanner can reject slots outside the active 30-day window
        // (Codex round-4 P1 #2). Lazy gap-fill on BOTH writes and
        // reads (Codex round-6 P1 #8) bounded at 30 iterations
        // (round-9 P1 #2).
        mapping(address => DaySnapshot[30]) dayBalances;
        // Most recent day a snapshot was written for the user.
        // `0` doubles as the "uninitialised" marker; the first write
        // initialises `lastUpdateDayId = currentDay - 1` to skip the
        // 20 000-iteration loop a literal Unix-epoch-based gap-fill
        // would otherwise require (round-8 P1 #8).
        mapping(address => uint16) lastUpdateDayId;
        // Day id of the user's most recent 0→positive transition.
        // Cleared on positive→0 transition so the next stake
        // re-seeds the tenure counter from scratch (Codex round-6
        // P1 #1 + round-10 P1 #2 — a primed wallet that previously
        // waited out the gate cannot carry old tenure across a
        // zero-balance gap, and the TWA scanner filters slots by
        // `dayId >= currentStakeStartDayId`).
        mapping(address => uint16) currentStakeStartDayId;
        // Seconds-since-epoch of the same transition. Used by the
        // elapsed-time min-history gate INSTEAD of inclusive day
        // buckets, so a user staking just before midnight can't
        // satisfy the 3-day gate after ~24 hours (Codex round-11
        // P2 #4).
        mapping(address => uint40) currentStakeStartSec;
        // Projected absolute timestamp past which the user's
        // current effective tier will fall to a lower tier IF no
        // further balance mutations occur. Computed at every rollup
        // pass from the ring buffer's deterministic future
        // trajectory; embedded in the CCIP payload so mirrors
        // enforce decay locally without a Base round-trip. Use
        // `type(uint40).max` for steady-state stakers whose
        // trajectory never crosses (Codex round-3 P1 #1 + round-6
        // P1 #9).
        mapping(address => uint40) tierExpirySec;
        // ── Tier propagation ordering keys ──────────────────────────────
        //
        // Monotonic per-user push nonce; the strict ordering key
        // mirrors compare against `userTierCache[user].lastNonce`.
        // Incremented on every effective-tier crossing, every
        // expiry shift in EITHER direction, every table-version
        // bump, or a forced push (Codex round-4 P1 #1 + round-7
        // P1 #1).
        mapping(address => uint64) userTierPushNonce;
        // Per-destination last-pushed nonce, keyed by destination
        // CCIP chain selector. Allows the broadcast step to skip
        // destinations already current AND lets the catchup path
        // bootstrap new destinations added between mutations
        // without manual sweep (Codex round-1 P2 #11 + round-2
        // P1 #2).
        mapping(address => mapping(uint64 => uint64)) userTierLastPushedNonce;
        // ── Tier table versioning (governance) ──────────────────────────
        //
        // Bumped by ConfigFacet on every tier-threshold or
        // discount-BPS mutation. Mirrors carry it in the cache slot
        // and treat a stale version as tier 0 until a fresh push
        // catches them up (Codex round-6 P1 #10).
        uint16 tierTableVersion;
        // One-shot per-(user, version, destination) bit for the
        // permissionless catchup sweep. Set when the sweep pushes
        // a fresh TierUpdated to that destination for that user at
        // that version; prevents repeat sweeps from draining
        // `protocolBroadcastBudget` by burning CCIP gas on no-ops
        // (Codex round-10 P1 #4 + round-11 P2 #1 — per-destination
        // granularity ensures new mirrors added between sweep calls
        // aren't permanently skipped).
        mapping(address => mapping(uint16 => mapping(uint64 => bool))) tierTableSweepDone;
        // Protocol-funded CCIP broadcast budget — native gas
        // balance held by the diamond on Base and topped up by
        // treasury allocation. Consumed by the in-tx auto-broadcast
        // helper on every nonce-bumping rollup pass; if exhausted,
        // the whole step-1 transaction reverts (fail-closed) so
        // there is no window where a balance-mutation lands without
        // mirror propagation (Codex round-5 P1 #3 + round-6 P1 #2).
        uint256 protocolBroadcastBudget;
        // Enumerable registry of users with non-zero tracked stake.
        // Populated on 0→positive, removed on positive→0. Lets the
        // permissionless `sweepTierTableUpdate(startIdx, count)`
        // walk every active staker after a `tierTableVersion` bump
        // (Codex round-8 P1 #4 — Solidity mappings aren't
        // enumerable, so the catchup pass needs this set).
        EnumerableSet.AddressSet activeStakerRegistry;
        // ── Mirror-side cached tier surface ─────────────────────────────
        //
        // Used ONLY on mirror chains (`!isCanonicalVpfiChain`).
        // Written by the CCIP `TierUpdated` inbound handler in
        // Sub 2; read by `LibVPFIDiscount.tryApply` /
        // `tryApplyYieldFee` in Sub 1.C. Empty on Base (the rollup
        // pass writes `userTierPushNonce` etc instead).
        mapping(address => CachedTier) userTierCache;
        // Highest `tierTableVersion` seen across all inbound
        // `TierUpdated` payloads on this mirror. Raised lazily;
        // mirror fee paths treat any `userTierCache[user]` whose
        // `tierTableVersion` differs from `currentTierTableVersion`
        // as tier 0 (Codex round-9 P1 #7 + round-10 P1 #1 — the
        // eager `VersionBumped` broadcast raises this immediately
        // on governance mutation; lazy adoption is the fallback).
        uint16 currentTierTableVersion;
        // Mirror-side EVM chain id of Base is REUSED from the
        // existing `baseChainId` slot (declared earlier in this
        // struct for the reward-report path); no new slot allocated.
        // The CCIP TierUpdated inbound handler validates
        // `srcChainId == s.baseChainId` (NOT the CCIP selector; the
        // messenger already translates per Codex round-9 P1 #4).
        //
        // Mirror-side authenticated business peer — the Base
        // diamond / messenger contract address whose `TierUpdated`
        // payloads we accept. Validated via the messenger's
        // existing `channelPeer` mapping (Codex round-4 P1 #4 +
        // round-9 P1 #4 — `Any2EVMMessage.sender` is always the
        // local CCIP adapter, never the business peer).
        address baseAuthorizedMessenger;
        // ── Cross-chain buyback custody (Base) ──────────────────────────
        //
        // Set of remittance-token addresses per chain that the
        // protocol will accept as buyback fuel; tokens not in the
        // allow-list have their full fee-fraction flow to the
        // treasury rather than the buyback budget (Codex round-5
        // P1 #4). Keyed by source chain id so a token address
        // collision across chains can't credit the wrong asset.
        mapping(uint256 => mapping(address => bool)) buybackAllowedToken;
        // Per-chain buyback budget accumulator (every chain). The
        // diamond holds the funds directly so it can `approve` the
        // CCIP messenger + remit cross-chain without round-tripping
        // through an external custody contract (Codex round-2 P2 #12).
        mapping(address => uint256) buybackBudget;
        // Base-side aggregated inbound buyback budget keyed by the
        // Base-delivered token (NOT the source-chain token — a
        // source-chain address may not exist on Base and may
        // collide across chains; round-6 P1 #11).
        mapping(address => uint256) baseBuybackBudget;
        // Base-side reservation accumulator for in-flight Fusion
        // buyback intents. On commit:
        //     baseBuybackBudget[token]   -= amountIn
        //     baseBuybackReserved[token] += amountIn
        // On fill, the reservation clears; on commit expiry the
        // reservation rolls back into the budget. Without the
        // reservation, two keepers committing against the same
        // available budget could over-allocate and the second
        // fill underflows at `safeTransferFrom` (Codex round-8
        // P1 #5).
        mapping(address => uint256) baseBuybackReserved;
        // #687-C: stakingPoolBuybackBudget (the buyback-overflow accumulator
        // that widened the staking pool cap) was removed with the 5% staking
        // yield — it was write-only with no spend path. The buyback overflow
        // tier now reverts instead of crediting it (LibTreasuryBuyback).
        // ── T-087 ConfigFacet knobs ─────────────────────────────────────
        //
        // All five knobs default to 0 in storage; the getter helpers
        // (LibVaipakam.cfgTwa*, cfgMirrorTierMaxAgeSec) substitute the
        // hardcoded default when the slot reads 0. The setters in
        // ConfigFacet enforce the per-knob bounds documented in
        // CrossChainRewardSystem.md §5.
        uint8 cfgTwaRecentDays;
        uint8 cfgTwaWindowDays;
        uint8 cfgTwaRecentWeight;
        uint8 cfgTwaMinStakedDays;
        uint32 cfgMirrorTierMaxAgeSec;
        // Mirror-side authenticated remittance receiver address.
        // `TreasuryFacet.absorbRemittance` is restricted to
        // `msg.sender == buybackRemittanceReceiver` so no
        // unauthorised caller can inflate `baseBuybackBudget` by
        // forging remittance call data (Codex round-11 P1 #5).
        address buybackRemittanceReceiver;
        // T-087 Sub 1.B — last-computed EFFECTIVE_TIER / EFFECTIVE_BPS
        // for the user, written at the end of every rollup. The
        // nonce-bump heuristic compares the post-rollup effective
        // state against these snapshots; a mismatch increments
        // `userTierPushNonce` so the Sub 2 broadcast helper fans
        // the change out to every destination. Appended at the END
        // of the struct (NOT inserted near `tierExpirySec` as the
        // first revision did) to keep the storage layout
        // append-only per Codex Sub 1.B P1 #1.
        mapping(address => uint8) lastEffectiveTier;
        mapping(address => uint16) lastEffectiveBps;

        // T-087 Sub 2.D round-3 P1 #2 — placeholder slot kept for
        // storage-layout stability ([[project_platform_prelive]]
        // notwithstanding, append-only discipline is policy). The
        // original `broadcastDestinationCount` was a duplicate of
        // the messenger's `broadcastDestinationChainIds.length`
        // gating the rollup-time broadcast at the Diamond level;
        // Codex caught it as a fail-OPEN drift surface (operator
        // syncs the messenger's list but forgets the Diamond knob
        // → every rollup silently returns). Replaced by the
        // messenger's own `NoBroadcastDestinations` revert
        // bubbling up through the accumulator. Slot retained as
        // `__reservedSub2D1` so any future slot append doesn't
        // shift mainnet storage offsets.
        uint8 __reservedSub2D1;

        // T-087 Sub 2.D round-2 P1 #1 — the de-dup gate must include
        // `tierExpirySec` and `tierTableVersion` alongside the
        // (tier, bps) pair. Mutations that keep tier the same but
        // change expiry (e.g., a partial withdrawal that accelerates
        // decay) OR change version (governance table bump) still
        // need to propagate to mirrors. Each of these slots tracks
        // the LAST PUSHED value next to its `lastEffectiveTier` /
        // `lastEffectiveBps` siblings.
        mapping(address => uint40) lastTierExpirySec;
        mapping(address => uint16) lastTierTableVersion;

        // T-087 Sub 3.A — the CcipMessenger contract address (the
        // cross-chain port, NOT a domain wrapper). The Diamond is
        // itself the registered channel handler for the buyback
        // channel and calls `CcipMessenger.sendMessage` directly
        // from `TreasuryFacet.remitBuyback`. The same messenger
        // serves any future cross-chain flow the Diamond wants to
        // originate from. Admin-set via
        // `TreasuryFacet.setCrossChainMessenger`.
        address crossChainMessenger;

        // T-087 Sub 3.A — admin-managed allow-list of tokens that
        // are EXEMPT from the buyback / convert paths. Used to mark
        // assets the protocol wants to keep in their native form
        // (e.g., ETH the protocol holds goes to operational
        // reserve + VPFI/ETH LP — never gets remitted cross-chain or
        // converted to other tokens). `remitBuyback` reverts if the
        // token is on this list. Per design discussion 2026-06-09.
        mapping(address => bool) buybackNoConvert;

        // T-087 Sub 3.A round-6 P2 #1 — per-srcToken admin-pinned
        // destination-side token address. `remitBuyback` requires
        // the operator-passed `destToken` to match this slot
        // exactly. Without this gate, an admin typo on `destToken`
        // would cause the CCIP send to succeed (source budget
        // debited) but the Base receiver to revert
        // `TokenMismatch` — funds stuck mid-bridge until manual
        // operator recovery. Set via `setBuybackDestToken(src,
        // dest)`; reading 0 means "no pinning configured" and the
        // remit refuses to proceed.
        mapping(address => address) buybackDestToken;

        // T-087 Sub 3.B — IntentDispatchFacet discriminator. Each
        // committed 1inch order hash gets stamped with its KIND at
        // commit time (`ORDER_KIND_SWAP_TO_REPAY` or
        // `ORDER_KIND_BUYBACK`). The dispatch facet's
        // `preInteraction` / `postInteraction` / `isValidSignature`
        // arms look up this discriminator and route to the matching
        // library. Cleared on terminal (fill / cancel / expire) so
        // a stale order hash can't be replayed against a different
        // KIND.
        mapping(bytes32 => bytes32) orderHashKind;

        // T-087 Sub 3.B — per-order info for the BUYBACK arm. Each
        // active buyback intent reserves `amountIn` of `token` out of
        // `s.baseBuybackBudget[token]` and into `s.baseBuybackReserved[token]`.
        // The terminal hook (fill / expire) reads this struct to
        // know which token's reservation to release. Packed across
        // 2 slots.
        mapping(bytes32 => BuybackOrderInfo) buybackOrders;

        // T-087 Sub 3.B round-3 P2 — per-token raw-amount tranche cap.
        // `commitBuyback` rejects `amountIn > cfgBuybackMaxTranche[token]`
        // unless the slot is 0 (no cap). Bounds the blast radius of
        // a single misquoted commit; the design's $5k USD cap is a
        // Sub 3.C add-on (needs oracle wiring), this raw-amount cap
        // is the conservative immediate fix.
        mapping(address => uint256) cfgBuybackMaxTranche;

        // T-087 Sub 3.C — per-orderHash "Fusion order template has
        // been validated against the canonical buyback shape" flag.
        // Set by `commitBuybackIntentValidated`; required by
        // `IntentDispatchFacet.isValidSignature` to return the
        // ERC-1271 magic value. Without this flag, a stamped BUYBACK
        // orderHash is still rejected at signature check (Sub 3.B
        // round-4 P1 mitigation).
        mapping(bytes32 => bool) buybackValidated;

        // T-087 Sub 3.C — running tally of the source token consumed
        // across partial fills for a given orderHash. TWAP orders
        // (`allowPartialFills = true` + `allowMultipleFills = true`)
        // can fire `postInteraction` multiple times per orderHash;
        // each fill increments this counter, releases the
        // proportional reservation + LOP allowance, and credits the
        // proportional VPFI delta. The order flips Filled only when
        // `consumedSoFar == amountIn`.
        mapping(bytes32 => uint128) buybackConsumedSoFar;

        // T-087 Sub 3.C round-1 P2 — running tally of VPFI delivered
        // across partial fills for a given orderHash. The pro-rata
        // minVpfiOut floor is enforced CUMULATIVELY (against
        // `floor(minVpfiOut * consumedSoFar / amountIn)`) rather
        // than per-partial; a per-partial floor with floor-division
        // lets rounding loss compound and the order can settle below
        // the committed minVpfiOut.
        mapping(bytes32 => uint128) buybackVpfiDeliveredSoFar;

        // T-087 Sub 3.C — Fusion TWAP window upper-bound (seconds).
        // The commit's `expiresAt - block.timestamp` must NOT exceed
        // this; bounds the time window during which the partial
        // fills can land. Default (when slot reads 0) is 1800
        // seconds (30 min); admin-bounded per the design card to
        // 600..3600.
        uint32 cfgBuybackTwapMaxWindowSec;

        // T-087 Sub 3 add-on #472 round-1 P1 #1 — APPENDED here
        // (after every prior storage slot) so the diamond's storage
        // layout for pre-existing slots is unchanged on upgrade.
        // Priority router destination budgets + their top-up
        // targets. When a buyback fill delivers VPFI, the proceeds
        // cascade:
        //   1. rewardEmissionsBudget (offsets fresh-mint inflation)
        //   2. keeperRewardBudget (operational keeper incentives)
        // Each step claims up to `(target - current_budget)`. Zero target
        // disables the step. #687-C removed the former step-3 staking-pool
        // overflow tier; any remainder past both targets now reverts
        // (BuybackOverflowNotAllowed) rather than stranding VPFI.
        uint256 rewardEmissionsBudget;
        uint256 keeperRewardBudget;
        uint256 cfgRewardEmissionsTopUpTarget;
        uint256 cfgKeeperRewardTopUpTarget;

        // T-087 Sub 3 add-on #473 — Productive treasury reserve.
        // Idle treasury balances earn 0% by default; this surface
        // routes a portion to external yield venues (Aave V3 for
        // ERC20 supply, Lido for ETH staking). The
        // `cfgTreasuryExternalYieldMaxBps` ceiling bounds how much
        // of a token's treasury balance can be deployed externally
        // — defence-in-depth against external-protocol counterparty
        // risk.
        //
        // Phase 0 (this card): external venues only.
        // Phase 1 (future card): adds VAIPAKAM_INTERNAL venue once
        // TVL crosses the operator-decided threshold.
        mapping(address => uint8) cfgTreasuryYieldVenue;
        mapping(address => uint256) treasuryDeployedExternal;
        uint16 cfgTreasuryExternalYieldMaxBps;
        address cfgAaveV3Pool;
        address cfgLidoStaking;
        // T-087 Sub 3 add-on #473 round-2 P1 #1 — count of tokens
        // with NON-ZERO Aave principal deployed. `setAaveV3Pool`
        // refuses to rotate the pool address while this is > 0,
        // because the old pool would still hold the existing
        // aTokens / principal. Incremented when a token's deployed
        // amount transitions 0 → >0 via `deployTreasuryYield`;
        // decremented when it transitions >0 → 0 via
        // `withdrawTreasuryYield`.
        uint256 aaveDeployedTokenCount;

        // T-087 Sub 3 add-on #474 — Keeper VPFI rewards.
        // Permissionless housekeeping calls (Sub 2.D sweep/force-
        // resend, periodic interest accrual, mirror cache catchup,
        // etc.) get paid in VPFI at `gasUsed * tx.gasprice * mult /
        // BASIS_POINTS` ETH-equivalent value, debited from
        // `s.keeperRewardBudget` (slot already exists from #472).
        //
        // Phase 0 (this card): config + setters + fixed-rate
        // pricing path. Hook wiring into individual housekeeping
        // facets is a separate per-facet task once this card lands.
        uint32 cfgKeeperRewardMultBps;
        uint16 cfgKeeperRewardCashOutSpreadBps;
        bool cfgKeeperRewardEnabled;
        uint32 cfgKeeperRewardTwapMaxAgeSec;

        // ─── T-092 — Auto-lifecycle (auto-lend / auto-refinance / auto-extend) ────────
        // Phase 1 scope: consent flags + per-loan caps that bound
        // the keeper-driven refinance + extend paths to the user's
        // pre-approved terms. Auto-lend is dapp-side only (this
        // flag is an opt-in marker; no contract enforcement).
        //
        // Auto-refinance is already keeper-callable today via
        // KEEPER_ACTION_REFINANCE; the gap this card closes is the
        // SAFETY BOUNDS — without per-loan caps, a keeper with the
        // refinance bit could route the borrower into a worse rate
        // or longer obligation than they agreed to.

        /// @notice Per-user auto-lend opt-in marker. No contract
        ///         enforcement — the dapp reads it to decide whether
        ///         to auto-post standing offers when vault deposits
        ///         land. Default false.
        mapping(address => bool) autoLendConsent;

        /// @notice Per-user convenience: when true, every new loan
        ///         the user originates as borrower has its
        ///         `autoRefinanceCaps[loanId]` auto-populated from
        ///         `defaultAutoRefinanceCaps[user]` at init time, so
        ///         the borrower doesn't need to re-set per-loan caps
        ///         on every loan. Default false.
        mapping(address => bool) autoOptInOnNewLoan;

        /// @notice Per-user borrower default caps copied into a
        ///         loan's `autoRefinanceCaps` at init when
        ///         `autoOptInOnNewLoan[borrower]` is true.
        mapping(address => AutoRefinanceCaps) defaultAutoRefinanceCaps;

        /// @notice Per-loan refinance caps (borrower-side consent).
        ///         When `enabled = true`, the keeper-driven
        ///         `refinanceLoan` path enforces the new offer's
        ///         rate ≤ maxRateBps and expiry ≤ maxNewExpiry.
        ///         When the call is by the borrower-NFT-owner
        ///         directly (not via a keeper), caps DO NOT apply —
        ///         the user is acting in their own interest.
        mapping(uint256 => AutoRefinanceCaps) autoRefinanceCaps;

        /// @notice Per-loan extend caps (lender + borrower
        ///         consent). Both sides must have `enabled = true`
        ///         for `extendLoanInPlace` to succeed. The keeper
        ///         picks new terms within the intersection of both
        ///         caps.
        mapping(uint256 => AutoExtendCaps) autoExtendBorrowerCaps;
        mapping(uint256 => AutoExtendCaps) autoExtendLenderCaps;

        // ── #407 (2026-06-12) — Vault encumbrance sub-ledger ─────────
        //
        // Per-loan collateral lien storage. Created at
        // `LoanFacet.initiateLoan` from the stamped `Loan.collateralAsset
        // / Amount / TokenId / Quantity / AssetType`; released on every
        // terminal that frees the collateral (`RepayFacet.repayLoan`,
        // `PrecloseFacet.precloseDirect`, `ClaimFacet`,
        // `DefaultedFacet.triggerDefault`, `RefinanceFacet.refinanceLoan`).
        // On obligation-transfer / refinance: the loan's collateral
        // identity may change; the lien must be re-keyed to the new
        // collateral fields.
        //
        // See `docs/DesignsAndPlans/PerLoanCollateralLien.md` §§2-6.
        mapping(uint256 => Encumbrance) loanCollateralLien;

        // Per-(user,asset,tokenId) running aggregate of all active
        // liens (collateral + offer-principal). The withdraw-chokepoint
        // guard in `VaultFactoryFacet.vaultWithdrawERC20` reads this
        // map to compute `freeBalance = balanceOf(proxy) - encumbered`.
        // ERC20 uses `tokenId = 0`; ERC721 / ERC1155 use the actual
        // tokenId. Keeping a single map for both lien categories means
        // the guard never has to ask "which kind of lien" — it just
        // asks "is this amount free?".
        //
        // See `PerLoanCollateralLien.md` §3.3 + §7.2 (the offer-
        // principal extension uses the same map).
        mapping(address => mapping(address => mapping(uint256 => uint256))) encumbered;

        // Per-offer principal lock storage (Lender offers with ERC20
        // lending asset only). Created at
        // `OfferCreateFacet._pullCreatorAssetsClassic`; released
        // partial on each `OfferMatchFacet.matchOffers` consumption,
        // final on `OfferCancelFacet.cancelOffer` /
        // `OfferAcceptFacet._acceptOffer` (single-fill) / dust-close
        // in `OfferMatchFacet` / lazy-expiry sweep.
        //
        // See `PerLoanCollateralLien.md` §7.3.
        mapping(uint256 => Encumbrance) offerPrincipalLien;

        // #585 — per-loan VPFI lender-PROCEEDS encumbrance. When an
        // internal match settles a VPFI-principal loan, the lender's
        // matched proceeds are deposited into the (possibly transferred-
        // away) stored `loan.lender`'s vault and recorded as a
        // `lenderClaims` row owed to the CURRENT lender-position holder.
        // VPFI is the one principal asset with a user-facing tracked-
        // balance exit (`VPFIDiscountFacet.withdrawVPFIFromVault`, the
        // unstake path), so without a reservation the stored lender could
        // front-run the holder's claim and unstake those proceeds. This
        // map records the amount ticked into the shared `encumbered`
        // aggregate for that loan, so `withdrawVPFIFromVault`'s
        // free-balance guard excludes it until `ClaimFacet` releases it
        // immediately before paying the rightful holder. Non-VPFI
        // proceeds need no entry (no user-facing tracked-withdraw path).
        // The same reservation should be extended to the other terminal
        // lender-proceeds paths (Repay / Default / Preclose / Risk) — a
        // pre-existing gap tracked as a follow-up; the release point in
        // `ClaimFacet` already handles every path keyed off this map.
        mapping(uint256 => uint256) lenderProceedsEncumbered;
        // #592 — the ASSET each loan's lender-proceeds reservation was
        // recorded under (the asset actually deposited into the lender vault
        // at the terminal: `principalAsset` for cash-settled closes,
        // `collateralAsset` for an in-kind/illiquid default — VPFI is
        // collateral-eligible). The release MUST decrement the same aggregate
        // it was reserved under, which is NOT always the loan's principal asset
        // nor the claim record's asset. A loan reserves lender-proceeds at its
        // single terminal, so this is written once per loan and cleared on
        // release.
        mapping(uint256 => address) lenderProceedsEncumberedAsset;
        // #396 v0.5 — signed off-chain offer book. APPEND-ONLY.
        // `signedOfferFilled`: order hash (the EIP-712 digest from
        // `LibSignedOffer.digest`) → cumulative principal already filled
        // against that signed offer. The remaining-fillable is
        // `amount(Max) − signedOfferFilled[hash]`; an AON offer closes on
        // first fill (set to `amount`), a partial-fillable one decrements
        // toward the dust floor. `cancelSignedOffer` sets it to `amount` so
        // the offer becomes unfillable. This is the off-chain-offer analog
        // of `Offer.amountFilled` and the sole replay/double-fill guard for
        // a non-stored offer.
        mapping(bytes32 => uint256) signedOfferFilled;
        // #396 v0.5 — per-signer batch-cancel nonce. A signer mass-
        // invalidates a cohort of their live signed offers by burning the
        // nonce they all carry (`invalidateNonce`); every fill checks this
        // before honouring the signature. Granular single-offer cancel is
        // `signedOfferFilled` (by order hash); this is the coarse bulk lever.
        mapping(address => mapping(uint256 => bool)) signedOfferNonceUsed;
        // #396 v0.5 — transient acceptor injection for the signed-offer fill
        // path. `SignedOfferFacet` sets this to the real counterparty
        // (`msg.sender`) immediately before its cross-facet
        // `acceptOfferInternal` call and clears it immediately after, so
        // `_acceptOffer` resolves the acceptor to the real caller instead of
        // the diamond (a cross-facet hop loses `msg.sender`). Mirrors the
        // `matchOverride.counterparty` injection the matcher uses. MUST be
        // address(0) outside an in-flight signed-offer fill — always cleared
        // in the same call; a non-zero value at rest is a bug.
        address signedOfferAcceptor;
        // #393 v1 — LenderIntentVault. APPEND-ONLY.
        // `lenderIntent[owner][lendingAsset][collateralAsset]` — the owner's
        // standing lending terms for that asset-pair (one per pair in v1).
        // The exposure-counter (`maxExposure` enforcement) + per-loan origin
        // marker land with the v1-b fill path that writes them — keyed by the
        // FULL intent (owner, lend, coll) and storing the ORIGINATING owner per
        // loan (loan.lender is mutated on a lender-position sale, so it can't be
        // the close-time decrement key — Codex #618 P2). Not scaffolded here.
        mapping(address => mapping(address => mapping(address => LenderIntent)))
            lenderIntent;
        // #393 v1-b — aggregate LIVE principal currently out in loans originated
        // from `owner`'s intent on the `(lendingAsset, collateralAsset)` pair.
        // Keyed by the FULL intent so two intents sharing a lending asset but
        // different collateral never share a cap. Incremented at `matchIntent`,
        // decremented once at the loan's terminal close.
        mapping(address => mapping(address => mapping(address => uint256)))
            lenderIntentLivePrincipal;
        // #393 v1-b — per-loan ORIGINATING intent key, so the terminal-close
        // decrement releases the right (owner, lend, coll) counter even after a
        // lender-position SALE mutates `loan.lender` (migrateLenderPosition).
        // `owner == address(0)` ⇒ the loan did NOT originate from an intent.
        mapping(uint256 => IntentOrigin) intentOrigin;
        // #393 v1-d — un-lent, LIENED working capital a lender has funded into
        // their vault for `owner`'s intent on the `(lendingAsset,
        // collateralAsset)` pair. Mirrors an offer's `offerPrincipalLien`: the
        // amount here is also held in `encumbered[owner][lendingAsset][0]`, so
        // it is NOT free balance and cannot be drained by any other vault-
        // withdraw door. `fundLenderIntent` adds; `matchIntent` releases each
        // fill slice (→ free, consumed by the existing materialize path);
        // `withdrawLenderIntentCapital` releases the remainder back to the
        // wallet (the cancel-offer pattern). Keyed by the FULL intent so two
        // intents sharing a lending asset but different collateral never share
        // a capital pool. Repaid proceeds NEVER land here — they return as a
        // separate free-balance + Position-NFT claim — so the exit door can
        // never double-spend them.
        mapping(address => mapping(address => mapping(address => uint256)))
            lenderIntentCapital;
        // #398 v1.5 — ERC-4626 aggregator-adapter factory state. Mirrors the
        // per-user vault version machinery (vaipakamVaultTemplate /
        // currentVaultVersion / mandatoryVaultVersion / vaultVersion): one shared
        // UUPS adapter implementation, per-aggregator proxies, governance-published
        // impls + aggregator-pull migration + a mandatory floor for critical fixes.
        address aggregatorAdapterTemplate;        // shared UUPS adapter impl
        uint256 currentAdapterVersion;            // bumped on each impl upgrade
        uint256 mandatoryAdapterVersion;          // min required; 0 = none
        mapping(address => uint256) adapterVersion;   // adapter proxy => version stamp
        mapping(address => bool) isAggregatorAdapter; // adapters this factory deployed
        // ── #399 backstop v0 — the single treasury-seeded backstop vault ────
        // One protocol-owned BackstopVault (no per-aggregator multiplicity, no
        // ERC-4626 shares — single principal). Provisioned once by governance;
        // holds per-asset-pair LenderIntents (Role A) + (PR 2) a free
        // absorb-cash bucket. See BackstopVaultV0Design.md §2.
        address backstopVaultTemplate; // shared UUPS BackstopVault impl
        address backstopVault;         // the provisioned proxy (0 = unprovisioned)
        // ── #399 backstop v0 Role B (PR 2) — absorb (liquidator-of-last-resort) ──
        // Per-(principalAsset, collateralAsset) FREE absorb-cash bucket: governance
        // seeds it via the §3 treasury-seed primitive into the backstop vault's
        // per-user vault as an UN-liened tracked balance (distinct from Role A's
        // LIENED origination capital). Decremented by `lenderPrincipalDue` on each
        // `claimAsLenderViaBackstop`; replenished by `seedBackstopAbsorb`. The cash
        // physically lives in the vault; this counter is the accounting ceiling on
        // what Role B may spend per pair.
        mapping(address => mapping(address => uint256)) backstopAbsorbCash;
        // Per-(principal, collateral) OUTSTANDING absorb exposure: cumulative
        // `lenderPrincipalDue` cash spent on collateral NOT yet sold back to cash.
        // Incremented on absorb, released ONLY on realized-cash sale / governance
        // write-off (§5.1) — NOT on a plain collateral move. Bounded by
        // `backstopAbsorbCap`.
        mapping(address => mapping(address => uint256)) backstopAbsorbExposure;
        // Governance per-(principal, collateral) cap on `backstopAbsorbExposure`
        // (distinct from Role A's origination `maxExposure`). 0 ⇒ absorb disabled
        // for the pair (no implicit capacity).
        mapping(address => mapping(address => uint256)) backstopAbsorbCap;
        // Per-loan lender opt-in to the Role B cash exit. Stores the AUTHORIZING
        // lender-position-NFT owner (not a bare bool): `claimAsLenderViaBackstop`
        // requires `lenderBackstopOptIn[loanId] == ownerOf(lenderTokenId)`, so a
        // post-opt-in NFT transfer voids the authorization (the new owner must
        // re-opt-in). Cleared (→ address(0)) when a FallbackPending loan is CURED
        // back to Active (AddCollateralFacet / RepayFacet), so a stale opt-in can't
        // carry into a later, distinct fallback episode. Preserves the borrower
        // cure window (the opt-in is the lender's state-terminating choice). See §5.
        mapping(uint256 => address) lenderBackstopOptIn;
        // Per-collateral-token aggregate of absorb collateral WAREHOUSED in the
        // backstop vault (Role B). Incremented when an absorb deposits the lender
        // slice; `sweepBackstopAbsorbCollateral` is bounded by it + decrements it,
        // so a sweep can never reach the seeded absorb CASH that shares the same
        // vault when one pair's collateral token equals another pair's principal.
        mapping(address => uint256) backstopWarehousedCollateral;
        // ─── #633 — per-venue swap-adapter pause (APPEND-ONLY tail) ─────────
        /// @dev Keyed by adapter ADDRESS (robust to `swapAdapters` reordering /
        ///      removal). `true` ⇒ {LibSwap} / the claim retry loop skip this
        ///      adapter, so governance can pause a compromised or illiquid venue
        ///      (0x / 1inch / UniV3 / Balancer) WITHOUT `removeSwapAdapter`
        ///      shifting every other adapter's index. Declared at the struct TAIL
        ///      so in-place storage upgrades don't shift existing slots. Default
        ///      `false` = active. Set via `AdminFacet.setSwapAdapterDisabled`.
        mapping(address => bool) swapAdapterDisabled;
        // ─── #395 — graduated partial-liquidation sizing (APPEND-ONLY tail) ──
        // Declared at the `Storage` tail (NOT inside `ProtocolConfig`, which is
        // embedded before live fields) so an in-place upgrade never shifts
        // existing slots — same discipline as `swapAdapterDisabled` above.
        // Consumed by `RiskFacet._assertPartialSizing`; each `0 ⇒ library
        // default`; values range-clamped at `AdminFacet.setPartialLiquidationSizing`.
        /// @dev Upper HF (BPS of HF_SCALE; 12_000 = HF 1.20) a *routine* partial
        ///      may leave the borrower at — caps over-liquidation. Waived when
        ///      deep-underwater or the PRE-partial position is dust.
        uint16 partialLiqTargetHfCeilingBps; // 0 ⇒ default (12_000)
        /// @dev HF (BPS of HF_SCALE; 9_500 = HF 0.95) at/below which the ceiling
        ///      is waived so a keeper may delever aggressively to restore solvency.
        uint16 partialLiqDeepUnderwaterHfBps; // 0 ⇒ default (9_500)
        /// @dev Dust floor in the whole-numeraire scale
        ///      {RiskFacet._computeNumeraireValues} returns (whole-USD with
        ///      8-decimal feeds; NOT 1e18-scaled). 0 ⇒ dust handling DISABLED
        ///      (Codex r3 P2 — no USD-scaled default that would misfire on a
        ///      rotated numeraire). When governance sets it (> 0), it both
        ///      WAIVES the over-liquidation ceiling for a PRE-partial dust
        ///      position (keyed on entry size, not the manufacturable residual)
        ///      AND PREVENTS a routine partial from leaving a fresh dust
        ///      position out of a non-dust loan (forces full liquidation).
        uint256 liquidationDustFloorNumeraire; // 0 ⇒ DISABLED
        // ─── #400 — pluggable quote-time rate model (APPEND-ONLY tail) ──────
        /// @dev The active {IRateModel}. `address(0)` ⇒ the IDENTITY model —
        ///      the user-supplied offer rate stands unchanged (today's
        ///      behaviour, zero-config). When set, `OfferCreateFacet` evaluates
        ///      it ONCE at offer-create and writes the concrete rate into the
        ///      offer; it is never consulted at match/accept or on a live loan
        ///      (E2). Registering a model is risk-increasing → timelock +
        ///      guardian-revocable after handover. Declared at the `Storage`
        ///      tail so the upgrade never shifts existing slots.
        address rateModel;
        /// @dev #400 (hardening) — max ± deviation, in BPS, a registered model
        ///      may move a quote from the caller's reference (market) rate. The
        ///      resolver CLAMPS the model's output to `[ref - dev, ref + dev]`,
        ///      so a model — even buggy/registered — can never push an
        ///      automated offer far off the market reference (the anti-rate-
        ///      setting / anti-reflexivity guarantee, baked into the substrate
        ///      rather than trusted to each consumer). 0 ⇒
        ///      RATE_MODEL_MAX_DEVIATION_BPS_DEFAULT. Range-clamped at the setter.
        uint16 rateModelMaxDeviationBps; // 0 ⇒ default (500 = 5%)
        /// @dev #394 Lever A — runtime override for the loan-admission Health
        ///      Factor floor (the value the NON-tiered init gate, and every
        ///      restore/maintain/preview HF check, compares against). `0` ⇒
        ///      the `MIN_HEALTH_FACTOR` constant (1.5e18 — today's behaviour),
        ///      so the protocol's live floor is unchanged until governance sets
        ///      it. Range-clamped at the setter to
        ///      `[MIN_ADMISSION_HEALTH_FACTOR, MAX_ADMISSION_HEALTH_FACTOR]`.
        ///      Packs into the high bytes of the `rateModel`+deviation slot, so
        ///      the upgrade shifts no existing slot. uint64 holds up to
        ///      ~18.4e18 — comfortably above the 2.0e18 ceiling.
        ///      NOTE: this is the *admission* floor only; the *liquidation*
        ///      trigger (`HF_LIQUIDATION_THRESHOLD`, 1e18) and the tiered-regime
        ///      init floor (also 1e18) are deliberately NOT touched by it.
        uint64 minHealthFactorOverride;
        // ──────────────────────────────────────────────────────────────
        // #594 — collateral/principal consolidation to the position-NFT
        // holder. Transient state for the gated+pinned Diamond NFT receiver
        // (design doc D-6): the `ReceiverFacet` hooks accept an inbound
        // ERC-721/1155 ONLY while `consolidationInFlight` is set AND the
        // (token, id, amount) match the in-flight move. `LibConsolidation`
        // sets these immediately before leg-1 of an NFT move and clears them
        // (consuming the pin) on the first accepted callback, so the Diamond
        // never becomes an open NFT sink. Appended to the Storage tail — no
        // existing slot shifts.
        bool consolidationInFlight;
        address consolidationExpectedToken;
        uint256 consolidationExpectedTokenId;
        uint256 consolidationExpectedAmount;
        /// @dev #594 Codex #659 P1/P2 — the EXACT stored owner whose vault may
        ///      be resolved sanctions-exempt, set by `LibConsolidation` ONLY
        ///      around the single from-side vault move (step 6). While set,
        ///      `getOrCreateUserVault` skips its Tier-1 sanctions gate for THIS
        ///      address ONLY. The from-side party is the DEPARTED (stored) owner
        ///      LOSING custody — their asset is pushed OUT to the already-
        ///      sanctions-checked current holder — so the gate (which exists to
        ///      stop a sanctioned wallet RECEIVING / holding protocol funds)
        ///      must not turn a Tier-2 close-out into a hard revert when the
        ///      stale anchor is flagged AFTER transfer.
        ///
        ///      Codex #659 round-3 — pinned to the address (not a global bool):
        ///      an arbitrary ERC-20/721/1155 transfer inside the move could
        ///      reenter and call `getOrCreateUserVault(otherFlaggedWallet)`; a
        ///      blanket bypass would let it mint a forbidden vault for a
        ///      DIFFERENT sanctioned wallet. Matching on the exact stored owner
        ///      closes that. `address(0)` (the default) exempts no one. Packs
        ///      into the same slot region as `consolidationInFlight`.
        address consolidationMoveFromUser;
        /// @dev #661 — borrower-side mirror of `lenderProceedsEncumbered` (#592).
        ///      A liquid default / liquidation can return a VPFI surplus to the
        ///      borrower's vault; like the lender proceeds it must be reserved
        ///      against the VPFI unstake path until the current borrower-position
        ///      holder claims it (else the stored borrower drains it after a
        ///      position transfer). Per-loan reserved amount + the recorded asset
        ///      (always the principal asset here — VPFI surplus is cash-settled),
        ///      written at the surplus deposit and cleared on `claimAsBorrower`.
        ///      Appended to the Storage tail — no existing slot shifts.
        mapping(uint256 => uint256) borrowerProceedsEncumbered;
        mapping(uint256 => address) borrowerProceedsEncumberedAsset;
        // ─── #638 — backstop-only oracle-coverage knob (APPEND-ONLY tail) ───
        /// @dev Minimum number of LIVE secondary price feeds (Tellor / API3 /
        ///      DIA — configured + fresh + non-zero) a collateral asset must
        ///      have for the TREASURY backstop to take it on. 0 ⇒ no requirement
        ///      (the default — general permissionless behaviour; the Soft-2-of-N
        ///      quorum's single-feed soft fallback still governs pricing). 1 (or
        ///      2/3) ⇒ the backstop refuses collateral priced by fewer than that
        ///      many secondaries, so protocol funds are never left holding
        ///      single-feed-priced collateral. BACKSTOP-SCOPED ONLY — read
        ///      solely by Role A (`backstopFill`) and Role B
        ///      (`claimAsLenderViaBackstop` absorb) via {LibBackstopOracleGate};
        ///      it never touches the general `OracleFacet` liquid-classification
        ///      or any general liquidation path (#638 owner direction: the
        ///      general path stays ungated). Range-bounded to [0, 3] in the
        ///      setter. Declared at the `Storage` tail (NOT inside the embedded
        ///      `ProtocolConfig`, which would shift every subsequent top-level
        ///      slot — see the note at the end of `ProtocolConfig`).
        uint8 backstopMinSecondaryOracleCoverage;
        // #662 — offer-accept term binding (anti-phishing). APPENDED AT THE TRUE
        // STORAGE TAIL (Codex #724 r2 P1) so applying this as a diamond upgrade
        // can't shift any pre-existing slot. `acceptNonceUsed[acceptor][nonce]`
        // is the per-acceptor EIP-712 replay ledger (see `LibAcceptTerms`); a
        // captured acceptance signature can't be replayed. The FIELD-equality
        // binding (signed terms == stored offer) is enforced at the public entry
        // (pure function of offer+terms; no liquidity read → no TOCTOU). The
        // acknowledged-illiquid ENFORCEMENT lives at the LTV/HF bypass site
        // (`LoanFacet._maybeRunInitialRiskGates`), checked against the SAME
        // liquidity classification that authorises the bypass — a hostile ERC-20
        // transfer hook can't flip a leg's liquidity between an entry-time read
        // and the gate (Codex #724 r1 P1). The entry forwards the signed acked
        // identities via the transient `acceptAck*` injection (idiom of
        // `matchOverride` / `signedOfferAcceptor`); `_acceptOffer` clears it. The
        // keeper match path never sets it (`acceptAckActive == false`) and is
        // exempt by construction (two self-authored offers — no phished acceptor;
        // see `docs/DesignsAndPlans/OfferAcceptTermBindingDesign.md` §5/§8b).
        mapping(address => mapping(uint256 => bool)) acceptNonceUsed;
        // Transient acked-illiquid-asset injection. MUST be cleared in the same
        // tx — a non-false `acceptAckActive` at rest is a bug.
        address acceptAckIlliquidLend;
        address acceptAckIlliquidColl;
        bool acceptAckActive;
        // #671 — progressive risk access (blue-chip default / mid-tier ack /
        // illiquid-custom consent). APPENDED AT THE TRUE STORAGE TAIL (same
        // append-only discipline as the #662 / #638 blocks above) so applying
        // this as a diamond upgrade can't shift any pre-existing slot. The whole
        // surface is gated by `riskAccessGateEnabled` (default `false` ⇒ every
        // gate site no-ops — the exact `depthTieredLtvEnabled` kill-switch idiom),
        // so a fresh deploy behaves identically until governance flips it on after
        // that chain's liquidity census. See
        // docs/DesignsAndPlans/ProgressiveRiskAccessDesign.md.
        bool riskAccessGateEnabled;
        // Per-vault risk tier (`RiskAccessLevel`). Zero-init `0 == BlueChipOnly`
        // is the default for every vault; opted up only via the EIP-712
        // self-submit setter in `RiskAccessFacet`.
        mapping(address => RiskAccessLevel) userRiskAccess;
        // Per-(user, pairKey) explicit consent to a specific ILLIQUID asset pair,
        // required for an `IlliquidCustom` vault to transact that pair. This is
        // the ONLY per-pair gate: liquid (BroadLiquid) pairs are NOT per-pair
        // gated — the BroadLiquid tier opt-up itself is the consent, and the
        // quantitative LTV/HF check still applies (design RD-1; Codex #727 r4).
        // pairKey == `LibRiskAccess.pairKey(PairId)`.
        mapping(address => mapping(bytes32 => bool)) illiquidPairConsent;
        // Monotonic terms-version ledger. A self-submit setter stamps the user's
        // anchor to `currentRiskTermsVersion` at unlock; a governance bump of
        // `currentRiskTermsVersion` re-locks every level whose anchor is now stale
        // (reject-stale + refresh-all-held). Revocations are exempt from the
        // stale-check (a user may always tighten).
        uint64 currentRiskTermsVersion;
        mapping(address => uint64) riskTierVersionAt;
        mapping(address => mapping(bytes32 => uint64)) illiquidPairVersionAt;
        // Per-vault unlock cooldown anchor: an opt-up takes effect only at/after
        // `riskTierUnlockAt[user]` (= now + `riskAccessUnlockCooldown` at set time).
        // Anti-grief so a phished signature can't both raise the tier AND
        // immediately transact a malicious pair in one atomic bundle.
        uint64 riskAccessUnlockCooldown;
        mapping(address => uint64) riskTierUnlockAt;
        // The tier that stays EFFECTIVE while a higher tier is cooling down
        // (Codex #727 r4 P2): raising Broad->Illiquid must not transiently drop
        // the vault below the BroadLiquid access it already held. On a raise this
        // is set to the prior effective tier; on a tighten/refresh it tracks the
        // new level. Read by `LibRiskAccess.effectiveTier` during the cooldown
        // window.
        mapping(address => RiskAccessLevel) riskTierSettled;
        // Opt-in self-imposed strict mode: when true, the user's offers re-assert
        // their tier at accept/match time too (not only at create), so a tier the
        // user later tightened can't be exploited via a pre-signed stale fill.
        mapping(address => bool) riskStrictMode;
        // Transient: set immediately before a protocol-authored lender-sale-vehicle
        // `createOffer` so the create gate exempts that offer (the sale vehicle's
        // tier is the EXITING lender's concern, already gated at the original loan).
        // Cleared in the same tx — a non-false value at rest is a bug (mirrors
        // `acceptAckActive`).
        bool saleVehicleCreate;
        // Allow-set of protocol-managed vaults (sale vehicles / backstop) that are
        // exempt from the self-submit signature requirement for tier opt-up.
        mapping(address => bool) protocolManagedVault;
        // Per-vault EIP-712 replay nonce for the gasless self-submit setters in
        // `RiskAccessFacet` (see `LibRiskAccess`). Separate from the #662
        // `acceptNonceUsed` ledger so the two signature surfaces never collide.
        mapping(address => mapping(uint256 => bool)) riskAccessNonceUsed;
        // #671 (Codex #727 r1 P1) — per-(vault, pairKey) arming anchor for a
        // pair consent/ack: the grant is effective only at/after this time
        // (= now + riskAccessUnlockCooldown at grant). Closes the atomic
        // sign-and-use window — a phished pair grant can't both land AND select
        // a malicious pair in the same tx once a cooldown is configured.
        mapping(address => mapping(bytes32 => uint64)) pairConsentUnlockAt;
        // #671 phase 2 RD-1 (#728 PR-2d) — opt-in STRICT MODE per-pair acks for
        // MID-TIER (BroadLiquid) pairs. `midTierExplicitAck[user][pairKey]` is the
        // EXPLICIT, setter-only ack timestamp (written ONLY by `setMidTierPairAck`,
        // never auto-stamped by the gate — so a strict-mode user must DELIBERATELY
        // ack each mid-tier pair). `midTierExplicitAckVersion` anchors it to the
        // risk-terms version at ack-time; the gate requires `>= currentRiskTermsVersion`
        // (a fresh ack), so a terms bump re-locks it just like the unlock anchors.
        // `midTierAckUnlockAt` is the per-(user,pair) ARMING anchor (= now +
        // riskAccessUnlockCooldown at ack-time): the ack is effective only at/after
        // it, closing the atomic sign-and-use window exactly like
        // `pairConsentUnlockAt` does for the illiquid consent (Codex #733 P1).
        mapping(address => mapping(bytes32 => uint64)) midTierExplicitAck;
        mapping(address => mapping(bytes32 => uint64)) midTierExplicitAckVersion;
        mapping(address => mapping(bytes32 => uint64)) midTierAckUnlockAt;
        // Strict-mode disable EXPIRY: when a vault turns strict mode OFF (a risk-
        // increasing change) this is set to `now + riskAccessUnlockCooldown` — the
        // ABSOLUTE timestamp until which the gate still treats the vault as strict
        // (mid-tier pairs still need a fresh explicit ack), closing the
        // disable→exploit window. Storing the resolved expiry (not the disable
        // instant) freezes the window against a later governance cooldown change
        // (Codex #733 P2). Zero (never disabled, or re-enabled) ⇒ no lingering
        // requirement.
        mapping(address => uint64) strictModeStrictUntil;
        // #730 — the `currentRiskTermsHash` the acceptor's signed #662
        // `AcceptTerms.riskTermsHash` named, injected by
        // `OfferAcceptFacet._verifyAndBindAccept` for the gate to read. Lets the
        // #662⇄#671 ack-substitution (`LibRiskAccess.assertAcceptorMayTransact`)
        // require the SIGNED acknowledgement — not just the vault's tier anchor —
        // to be fresh, so an ack signed before a governance `bumpRiskTermsVersion`
        // can't be submitted afterward as fresh per-pair illiquid consent. We bind
        // the unguessable HASH, not the numeric version: the version counter is
        // predictable, so a malicious UI could pre-stamp `N+1` and have it activate
        // on the next bump (Codex #736 r3). `currentRiskTermsHash` is derived from
        // bump-time block entropy a pre-signing UI can't predict. Set on every
        // accept entry and cleared alongside `acceptAckActive`; only read on the
        // direct-accept illiquid-substitution path (the keeper-match path leaves
        // `acceptAckActive == false`).
        bytes32 acceptAckTermsHash;
        // #730 (Codex #736 r3–r7) — the live risk-terms ANCHOR, paired with
        // `currentRiskTermsVersion`. Set by `revealRiskTermsBump` to a fresh RANDOM
        // SECRET (`termsAnchor`) published via commit-reveal: the slow/timelock
        // `commitRiskTermsBump` stores only a hiding `keccak256(abi.encode(anchor))`
        // (queued calldata exposes nothing) and the fast off-timelock reveal
        // activates it atomically — so the anchor is unknowable before activation
        // and a signer can't pre-stamp the next one (it is NOT the public terms-doc
        // hash, which is published separately). The numeric version stays the anchor
        // for the CONTRACT-written tier / illiquid-consent freshness checks (those
        // can't be pre-stamped); only the signer-controlled accept ack binds this
        // value. Zero before the first reveal (matches a zero-stamped ack, which is
        // correct pre-bump).
        bytes32 currentRiskTermsHash;
        // #730 (Codex #736 r5/r7) — the pending HIDING commitment to the next terms
        // anchor, set by `commitRiskTermsBump` and consumed by `revealRiskTermsBump`
        // (commit-reveal). `keccak256(abi.encode(termsAnchor))` where `termsAnchor`
        // is a secret, so a governance timelock's public queued calldata never
        // exposes the future anchor. Zero when no change is pending.
        bytes32 pendingRiskTermsCommitment;
        // #730 (Codex #736 r6) — every published terms hash is SINGLE-USE for the
        // protocol's lifetime. Without this, rolling terms A→B→A (or re-publishing
        // a hash) would let an ack stamped during the first A-period substitute
        // again once A is re-published. `revealRiskTermsBump` rejects any hash
        // already marked here.
        mapping(bytes32 => bool) riskTermsHashUsed;
        // #625 WI-2a — enumerable registry of ACTIVE lender intents, so a keeper can
        // page them (`getActiveLenderIntents`) instead of needing an off-chain index of
        // `LenderIntentSet`/`Cancelled` events. `activeIntentKeys` holds the
        // `intentKeyHash(owner, lend, coll)` of every currently-active intent (added on
        // `setLenderIntent`, removed on `cancelLenderIntent`); `intentKeyTuple` resolves a
        // key hash back to its (owner, lend, coll) so the view can read the concrete
        // intent + its live-principal + funded capital.
        EnumerableSet.Bytes32Set activeIntentKeys;
        mapping(bytes32 => IntentKey) intentKeyTuple;
        // #625 WI-2c — enumerable registry of LIVE intent-originated LOANS, so a keeper
        // can page them (`getRollableIntentLoans`) to find fully-repaid ones to AUTO-ROLL
        // (`rollIntentLoan`) instead of needing an off-chain index of `IntentMatched`
        // events. A loan id is added when `matchIntent` sets its `intentOrigin`, and
        // removed when that origin is cleared — at terminal release (`releaseIntentExposure`,
        // the shared claim/withdraw/consolidation hook) or at `rollIntentLoan`. The set
        // therefore holds exactly the loans with a live `intentOrigin`; the view filters
        // to `LoanStatus.Repaid` for the keeper's roll candidates.
        EnumerableSet.UintSet activeIntentLoans;
        // #625 #755 — per-OWNER enumerable registry so the dapp can list a
        // single lender's standing intents across pairs (the global
        // `activeIntentKeys` feed is owner-agnostic and funded-active only).
        // Membership is BROADER than the global feed — `active || capital > 0`
        // — so it includes PAUSED (cancelled-but-capital-reserved) intents the
        // lender still needs to manage; it drops a key only once the intent is
        // fully torn down (inactive AND no reserved capital). Maintained by
        // `syncIntentRegistry` at the same sites as `activeIntentKeys`.
        // APPENDED AT THE END of the struct (after the pre-existing
        // `activeIntentLoans`) per the append-only storage rule — a new shared
        // field must never shift an existing field's slot (Codex #756 P1).
        mapping(address => EnumerableSet.Bytes32Set) ownerIntentKeys;
        /// @dev #821 — RECEIVE-side mirror of `consolidationMoveFromUser`. The
        ///      exact recipient whose EXISTING vault a wind-down close-out
        ///      deposit may resolve through despite a sanctions flag. Unlike the
        ///      move-out exemption (where the flagged party loses custody), here
        ///      the flagged party RECEIVES — but the proceeds are LOCKED: the
        ///      deposit is protocol-tracked (so `recoverStuckERC20` can't reach
        ///      it) and `claimAsLender` / `claimAsBorrower` screen the stored
        ///      vault owner, so nothing leaves the vault until the flag clears.
        ///      This lets a Tier-2 close-out complete (the unflagged counterparty
        ///      is made whole) without routing fresh, spendable value to the
        ///      flagged wallet, and without commingling in the Diamond.
        ///
        ///      Same exact-address pinning as the move-out exemption (a reentrant
        ///      transfer can't resolve a DIFFERENT flagged wallet's vault), and
        ///      `getOrCreateUserVault` still refuses to CREATE a new vault for a
        ///      sanctioned recipient under this exemption — it only resolves an
        ///      already-existing one (every real loan party has one by close-out
        ///      time). `address(0)` (default) exempts no one.
        ///
        ///      APPENDED AT THE END of the struct per the append-only storage
        ///      rule (Codex #832 P1) — a transient single-slot field must never
        ///      shift an existing field's slot.
        address sanctionedDepositExemptUser;
        // ─── #776 Cross-chain reward-budget remittance (Base→mirror) ──────
        // APPENDED AT THE END per the append-only storage rule. On-demand
        // Base→mirror VPFI reward-budget bridge (Option C — see
        // docs/DesignsAndPlans/CrossChainRewardBudgetBridge.md). Base holds the
        // 69M interaction pool; mirror claims draw from a locally-funded VPFI
        // balance. `RewardRemittanceFacet.remitRewardBudget` computes each
        // finalized day's per-chain slice and ships VPFI over the CCIP token
        // path (the value-carrying `crossChainMessenger` on its own dedicated
        // `vpfi-reward-budget` channel, NOT the data-only `rewardMessenger`),
        // tracking what's been sent so a batch is idempotent and the global 69M
        // cap is never exceeded.
        //
        // dstChainId => dayId => VPFI already remitted for that (chain, day).
        // A non-zero entry blocks re-remittance, so re-running a partially-sent
        // batch is safe (already-sent days are skipped).
        mapping(uint32 => mapping(uint256 => uint256)) rewardBudgetRemitted;
        // dstChainId => cumulative VPFI remitted to that mirror. Monitoring +
        // reconciliation.
        mapping(uint32 => uint256) rewardBudgetRemittedTotal;
        // Σ across every mirror. Guarded together with `interactionPoolPaidOut`
        // so Base can never remit more than `VPFI_INTERACTION_POOL_CAP`.
        uint256 rewardBudgetRemittedGlobal;
        // Optional automation role. `address(0)` (default) = owner-only; when
        // set, this EOA may also call `remitRewardBudget` (the apps/keeper
        // loop). Setter is ADMIN_ROLE-only.
        address rewardRemittanceKeeper;
        // #776 — dayId => chainId => was this chain's numerator INCLUDED in
        // that day's finalized global denominator (i.e. expected AND reported
        // at `finalizeDay`)? Set by `RewardAggregatorFacet._finalizeAndWrite`.
        // The reward-budget slice (`LibInteractionRewards.chainRewardBudgetForDay`)
        // gates on this so a chain that reported but was removed from the
        // expected set before finalization — whose stale `chainDaily*` would
        // otherwise divide by the smaller denominator and over-send — yields a
        // zero slice. Immune to post-finalize expected-set edits (it snapshots
        // participation AT finalize, not a live membership check).
        mapping(uint256 => mapping(uint32 => bool)) chainDailyIncluded;
        // ─── #776 receive side (mirror chains) ────────────────────────────
        // The mirror-side `RewardRemittanceReceiver` authorized to call the
        // Diamond's `onRewardBudgetReceived` ingress. `address(0)` = ingress
        // disabled (Base, or an unconfigured mirror).
        address rewardRemittanceReceiver;
        // Cumulative VPFI reward budget received from Base on this mirror.
        // Monitoring/reconciliation only — claims draw from the raw balance.
        uint256 rewardBudgetReceivedTotal;
        // ─── #953 (Codex) — forfeited lender entries orphaned by a sale ────
        // `transferLenderEntry` forfeits the exiting lender's reward entry and
        // advances `loanActiveLenderEntryId` to the buyer's entry, so the
        // forfeited entry is no longer reachable by `sweepForfeitedByLoanId`
        // (which reads only the active pointer). Its sole remaining processing
        // path was the old holder's `claimInteractionRewards` — now Tier-1
        // sanctions-gated (#921 item 1), which would strand the forfeit if that
        // holder is flagged. Recording the orphaned id here lets the
        // permissionless, sanctions-open sweep still route it to treasury.
        // Append-only per loan; `_processEntry` is idempotent so a re-sweep (or a
        // later un-flagged claim) double-counts nothing.
        mapping(uint256 => uint256[]) loanForfeitedLenderEntryIds;
        // ─── #954 (Codex #981 P1/P2) — frozen swap-surplus borrower claim ─────
        // `SwapToRepayFacet.swapToRepayFull` normally hands the borrower's
        // principal surplus straight to the CURRENT borrower-NFT holder's EOA.
        // When that holder is sanctioned the payout is withheld and frozen in
        // `loan.borrower`'s vault instead (which always exists — collateral was
        // posted there at init — so a fresh vault-less transferee can't brick the
        // must-complete close-out). This slot records that frozen principal
        // surplus so the holder can withdraw it via `ClaimFacet.claimAsBorrower`
        // once delisted; the loan's ordinary `borrowerClaims` slot is taken by
        // the residual COLLATERAL (a different asset), so the surplus needs its
        // own claim row. Keyed by loanId; unset (amount 0) on the common unfrozen
        // path.
        mapping(uint256 => ClaimInfo) borrowerSurplusClaims;
        // ─── #954 (Codex #981/#986) — VPFI held-but-owed-to-another counter ────
        // When a close-out freezes a VPFI surplus (borrower) or VPFI proceeds
        // (lender) into a vault whose owner is NOT the economic owner — i.e. the
        // position NFT was transferred to a now-sanctioned holder — the funds sit
        // in the STORED party's tracked vault balance but belong to the current
        // holder (claimable once delisted). This per-owner counter records that
        // amount so the VPFI fee-tier stamp can EXCLUDE it (tier reads
        // `protocolTrackedVaultBalance`, which is blind to `s.encumbered`).
        // Incremented at the transferred-position freeze; decremented at claim/
        // release. Only the TRANSFERRED case bumps it — a flagged self-holder's
        // frozen VPFI is their own money and still counts toward their tier.
        // See docs/DesignsAndPlans/SanctionsCloseoutSweepAndSaleVehicleFixes.md §2.2.
        mapping(address => uint256) frozenVpfiOwedByVault;
        // Per-loan record of the EXACT VPFI amount this loan bumped into
        // `frozenVpfiOwedByVault` on each side, so the matching claim
        // decrements the aggregate by precisely what was added and can never
        // erode a DIFFERENT loan's frozen amount on the same owner. The lender
        // leg needs this because its `lenderClaims` row is written on EVERY
        // close (clean or frozen), so "was this leg's VPFI frozen-and-owed?"
        // is not re-derivable at claim time. Kept symmetric for the borrower
        // surplus. Zero on the common path; cleared to zero on release.
        mapping(uint256 => uint256) frozenVpfiOwedLenderLeg;
        mapping(uint256 => uint256) frozenVpfiOwedBorrowerSurplus;
        // ── #1123 — confirmed-flagged-wallet registry (APPENDED) ──────────────
        // Wallets CONFIRMED sanctions-flagged from an AUTHORITATIVE
        // (oracle-reachable) read. Consulted FAIL-CLOSED by the position-movement
        // restriction (`assertPositionMoveNotSanctioned`) so a flagged wallet can't
        // move a position NFT during a sanctions-oracle outage — closing the S10
        // laundering-chain class (#1006). Mutated ONLY from strict reads
        // (`sanctionsStatus`): registered at non-reverting oracle-up flag
        // observations (the S10 `recordFrozenClaimant` park hook below, sale-buyer
        // receives, and `recoverStuckERC20`'s recovery-ban) + the permissionless
        // `ProfileFacet.refreshSanctionsFlag`; cleared on a confirmed de-list.
        // Appended (Codex #1126 r1 P1) — no existing slot shifts.
        mapping(address => bool) sanctionsConfirmedFlagged;
        // ─── #998 S10 (#1006) — sanctioned-locked-proceeds frozen claimant ────
        // Per-(loan, side) record of the ADDRESS whose claim was frozen at
        // close-out because that party — the intended economic recipient (the
        // current position-NFT holder the payout was for) — was affirmatively
        // sanctions-flagged while the oracle was up. `address(0)` = not locked.
        // The claim release gate re-checks THIS recorded address fail-closed
        // (`assertNotSanctionedFailClosed`) so a confirmed freeze cannot lift
        // during an oracle outage AND cannot be laundered by transferring the
        // position to a clean wallet (release keys on the recorded party, not the
        // current holder / `msg.sender`). With #1123's fail-closed movement gate a
        // flagged holder can no longer transfer the position mid-outage, so this
        // stays a single first-write address (no laundering chain to track).
        // Cleared on a successful clean release.
        mapping(uint256 => address) sanctionsLockedLenderClaimant;
        mapping(uint256 => address) sanctionsLockedBorrowerClaimant;
        // ─── #998 S10 (#1006) Class B — ACTIVE-loan held reservation ──────────
        // A DEDICATED per-loan reservation for a mid-loan Class B lender-share
        // park (`LibCloseoutFreeze._parkActiveLenderShare`), kept SEPARATE from
        // the single-terminal `lenderProceedsEncumbered` ledger. Reusing that
        // single-asset terminal ledger for an active park bricks a later in-kind
        // default: the park reserves the `principalAsset` mid-loan, then the
        // in-kind terminal tries to reserve the `collateralAsset` under the same
        // per-loan record and trips its single-asset assert (Codex #1122-rework
        // fresh-round P1). This bucket reserves the held amount against the stored
        // lender's spend paths under its OWN per-loan (amount, asset) record, so
        // the two reservations coexist. Released alongside `heldForLender` at
        // `claimAsLender` (and the backstop absorb), and MIGRATED with the held
        // whenever the lender position moves (consolidation / sale), mirroring the
        // `lenderProceedsEncumbered` rekey — so a later release under the CURRENT
        // `loan.lender` always decrements the aggregate the reserve now sits in.
        mapping(uint256 => uint256) heldForLenderEncumbered;
        mapping(uint256 => address) heldForLenderEncumberedAsset;
        // ─── #951 v2 (Codex #959 bind-to-live redesign) — historical note ─────
        // The old `saleListingCollateral` snapshot (formerly the last struct
        // field) was removed by the #959 bind-to-live redesign merged to main:
        // the buyer's accept now binds `collateralAmount` `>=`-style against the
        // LIVE loan in `OfferAcceptFacet._bindTermsToOffer`, so there is no
        // snapshot to store, clean up, or drift. Pre-live removal is layout-safe.
        // The #954 frozen-surplus fields above are appended after it. See
        // docs/DesignsAndPlans/LenderSaleVehicleRedesign.md.
        // ─── #1008 (S13, Option B) — per-day interaction-reward cap ───────────
        // APPENDED AT THE STRUCT TAIL (Codex #1152 r1 P1) — never insert mid-
        // struct; that would shift every later field's slot.
        /// @dev Per-day §4 daily-cap threshold in RPN units:
        ///      `T_d = (10^feedDec · effectiveCapRatio · 1e18) / ethPrice`,
        ///      snapshotted at day-finalization from Base's `ethNumeraireFeed` +
        ///      the EFFECTIVE `getInteractionCapVpfiPerEth()` (so a stored 0 maps
        ///      to the default cap, not a zero cap). `type(uint256).max` = cap
        ///      DISABLED for that day (feed unavailable / malformed decimals /
        ///      capRatio at max ⇒ `min(Δ_d, T_d) = Δ_d`, uncapped). The §4 cap
        ///      threshold is ENTRY-INDEPENDENT (the per-entry numeraire cancels),
        ///      so one global per-day value serves every entry AND the per-chain
        ///      remittance. Broadcast canonically from Base so every mirror caps
        ///      identically (never locally recomputed on a mirror).
        mapping(uint256 => uint256) dayCapThreshold18;
        /// @dev Capped cumulative RPN:
        ///      `cumMinLenderRpn18[d] = Σ_{k≤d} min(Δ_k, dayCapThreshold18[k])`,
        ///      written alongside {cumLenderRpn18} in {advanceCumLenderThrough}
        ///      using the finalize-snapshotted threshold. Entry claims read this
        ///      (not the uncapped {cumLenderRpn18}) so the §4 daily cap is applied
        ///      per day while claims stay O(1). Rides the SAME cursor as
        ///      {cumLenderRpn18} (the threshold is guaranteed present once
        ///      `knownGlobalSet[d]`). Equals {cumLenderRpn18} on cap-disabled days.
        mapping(uint256 => uint256) cumMinLenderRpn18;
        /// @dev Mirror of {cumMinLenderRpn18} for the borrower side.
        mapping(uint256 => uint256) cumMinBorrowerRpn18;
        // ─── #1067 (S13 Part 2) — O(1) reward-entry membership index ──────────
        /// @dev 1-based position of reward entry `id` inside its user's
        ///      `userRewardEntryIds[user]` array (`idxPlus1`; 0 = absent). Lets
        ///      {LibInteractionRewards._removeUserEntry} swap-pop in O(1) instead
        ///      of scanning, so the centralized {closeLoan} re-anchor cannot be
        ///      griefed by a prolific holder's long entry list (Codex #1147 r3
        ///      G3 / r4 H3). Maintained at EVERY membership mutation: alloc push,
        ///      remove swap-pop (rewrites the moved tail entry's index), and the
        ///      {repointRewardEntry} newUser push.
        mapping(uint256 => uint256) rewardEntryUserIdx;
        // ─── VPFI recycling balance governor (#1222) — knobs ──────────────
        /// @dev Platform-retained margin (bps) the recycling governor keeps
        ///      from absorption before sizing the coupled reward budget.
        ///      `0` ⇒ {RECYCLE_MARGIN_DEFAULT_BPS} (see {cfgRecycleMarginBps}).
        ///      Set via {ConfigFacet.setRecycleMarginBps} (ADMIN_ROLE, bounded
        ///      `[1, RECYCLE_MARGIN_MAX_BPS]`). Appended at struct end — no
        ///      layout shift for an in-place facet refresh.
        uint16 recycleMarginBps;
        /// @dev Tariff `k` (VPFI-1e18 per ETH-1e18 of loan volume per day) for
        ///      peg-free discount entitlements (design §4.2). `0` ⇒
        ///      {RECYCLE_TARIFF_K_DEFAULT} (see
        ///      {cfgRecycleTariffKPer1e18EthDay}). Set via
        ///      {ConfigFacet.setRecycleTariffKPer1e18EthDay} (ADMIN_ROLE,
        ///      bounded `[RECYCLE_TARIFF_K_MIN, RECYCLE_TARIFF_K_MAX]`).
        uint256 recycleTariffKPer1e18EthDay;
        // ─── VPFI recycling governor PR-3a (#1217/#1222 §5) — bucket ledger ──
        /// @dev Protocol-owned recycle bucket: a LEDGER SLICE of the Diamond's
        ///      own VPFI balance (never a separate token pocket). Credited by
        ///      {LibVpfiRecycle.credit} at every recyclable VPFI receipt;
        ///      consumed only by the governor's coupled reward budget (PR-3b/3c)
        ///      and Phase-C surplus tooling. Separation invariant (governor §5):
        ///      `diamondVpfiBalance ≥ userLifCustody + unclaimedRewardBudget +
        ///      recycleBucket`. Appended at struct end — no layout shift for an
        ///      in-place facet refresh.
        uint256 recycleBucket;
        /// @dev Day-bucketed credit totals feeding the trailing-window
        ///      absorption average `Ā[D]` cheaply at day finalization
        ///      (governor §3.1/§5). Key = the interaction-reward schedule day
        ///      the credit landed in (day 0 collects pre-launch credits — the
        ///      trailing window ages them out naturally once emissions start).
        mapping(uint256 => uint256) recycledCreditedByDay;
        // ─── VPFI recycling governor PR-3b (#1217 §3.1) — day-pool stamps ───
        /// @dev Per-day governor stamp, written ONCE at day finalization
        ///      ({RewardAggregatorFacet._finalizeAndWrite}) — the #957/#1008
        ///      snapshot discipline: a mid-day margin retune or bucket
        ///      mutation never rewrites an already-finalized day. In Phase A′
        ///      the stamped values are also the day's commitment records
        ///      (single-chain: commit == the stamped halves; the per-chain
        ///      ceil-div refinement arrives with the mesh phase).
        mapping(uint256 => DayPoolStamp) dayPoolStamp;
        /// @dev PR-3c cutover arming for commitment RESERVATION. While 0
        ///      (unarmed, the deploy default) stamps are records only —
        ///      `outstandingCommit*` stay untouched, because the live claim
        ///      math still pays schedule-based rewards and nothing consumes
        ///      commitments yet; accumulating reservations without a consume
        ///      side would silently collapse `freshAvailable`. PR-3c sets
        ///      this to its cutover day and wires consume-at-claim, arming
        ///      reservation atomically with consumption (no migration).
        uint256 governorCommitArmedFromDay;
        /// @dev Σ armed fresh commitments not yet consumed/released
        ///      (governor §3.1: `freshAvailable` nets these out so two
        ///      near-exhaustion days can never size against the same VPFI).
        uint256 outstandingCommitFresh;
        /// @dev Σ armed recycled commitments not yet consumed/released
        ///      (`fundable[D] = recycleBucket − this`).
        uint256 outstandingCommitRecycled;
        // ─── Governor PR-3c (#1217 §3.1) — dual accumulator + consumption ──
        /// @dev Capped cumulative of the RECYCLED per-day RPN component:
        ///      `Σ_{k≤d} cappedRecycledΔ_k`, riding the same lazy cursor as
        ///      {cumMinLenderRpn18}. The per-user #1008 cap applies to the
        ///      COMBINED (fresh+recycled) Δ FIRST and the trim is
        ///      apportioned pro-rata (governor §3.1 / Codex r7 — capping
        ///      per-source would change the user's total); the FRESH capped
        ///      component is therefore always derived by subtraction
        ///      (`cumMin − cumMinRecycled`), never stored separately.
        ///      Zero for every pre-arming day (the recycled term only
        ///      exists post-cutover).
        mapping(uint256 => uint256) cumMinRecycledLenderRpn18;
        /// @dev Borrower-side mirror of {cumMinRecycledLenderRpn18}.
        mapping(uint256 => uint256) cumMinRecycledBorrowerRpn18;
        /// @dev Capped cumulative of the ARMED-DAY combined Δ (fresh +
        ///      recycled, post-cutover days only; 0 contribution from
        ///      pre-arming days). Lets a claim spanning the arming day
        ///      split its consumption exactly: `armedFresh = armedCombined
        ///      − recycled` releases the fresh commitment for precisely the
        ///      armed-day share — decrementing by the WHOLE fresh component
        ///      would eat other days' reservations (pre-arming days never
        ///      reserved anything).
        mapping(uint256 => uint256) cumMinArmedLenderRpn18;
        /// @dev Borrower-side mirror of {cumMinArmedLenderRpn18}.
        mapping(uint256 => uint256) cumMinArmedBorrowerRpn18;
        /// @dev VPFI paid out (or remitted) from the RECYCLED term since
        ///      arming. Never touches the 69M fresh pool:
        ///      `interactionPoolPaidOut` remains the FRESH-only counter
        ///      post-cutover (recycled payouts debit {recycleBucket}
        ///      instead). Transparency + reconciliation counter.
        uint256 paidOutRecycled;
        // ─── RL-3 (#1305) — post-claimability reward claim horizon ─────────
        /// @dev Horizon `H` in days. `0` ⇒ feature DARK (deploy default);
        ///      set via {ConfigFacet.setRewardClaimHorizonDays}, bounded
        ///      `[REWARD_CLAIM_HORIZON_MIN_DAYS, REWARD_CLAIM_HORIZON_MAX_DAYS]`.
        uint32 rewardClaimHorizonDays;
        /// @dev Per-entry first-observed-claimable timestamp — the horizon
        ///      clock's start. Stamped LAZILY by the permissionless expiry
        ///      sweep on its first touch of a claimable entry (never while a
        ///      claim is blocked by missing finalization/broadcast, which is
        ///      exactly the ratified "clock never runs while blocked" rule),
        ///      so every pre-existing dormant entry's clock starts at or
        ///      after feature activation — grandfathering by construction.
        mapping(uint256 => uint64) rewardEntryFirstClaimableAt;
    }

    /// @notice Governor PR-3b (#1217 §3.1) — the per-day pool composition
    ///         stamped at finalization.
    /// @dev `scheduleFloor` = min(schedule, freshAvailable);
    ///      `recycledBudget` = schedule==0 ? 0 : min(fundable, Ā×(1−m));
    ///      `dailyPool` = the sum. uint128 is ample (daily pools are
    ///      ~2e22 wei). `aBarAtFinalize` records the trailing absorption
    ///      average the recycled term was sized from (transparency +
    ///      #1218 metrics).
    struct DayPoolStamp {
        uint128 scheduleFloor;
        uint128 recycledBudget;
        uint128 aBarAtFinalize;
        uint16 marginBpsAtFinalize;
        bool stamped;
    }

    /// @notice #393 v1-b — the originating intent of a `matchIntent` loan,
    ///         recorded per loanId so the exposure-release keys off the SIGNER's
    ///         intent, not the (sale-mutable) current lender, and releases the
    ///         ORIGINAL fill amount (`amount`) — not `loan.principal`, which a
    ///         partial repayment reduces (otherwise the partial-repaid slice
    ///         would stay permanently counted against the cap).
    struct IntentOrigin {
        address owner;
        address lendingAsset;
        address collateralAsset;
        uint256 amount;
    }

    /// @notice T-092 — per-loan borrower-side refinance caps.
    /// @dev Storage occupant for `autoRefinanceCaps[loanId]` and
    ///      `defaultAutoRefinanceCaps[user]`. `setter` is recorded so
    ///      the reader can return enabled=false when the position NFT
    ///      has changed hands since the cap was set (per-loan slots
    ///      only — `defaultAutoRefinanceCaps[user]` ignores it).
    struct AutoRefinanceCaps {
        bool enabled;        // borrower opted this loan into auto-refinance
        uint16 maxRateBps;   // ceiling on the new offer's interest rate; 0 is a literal cap meaning "only 0% refinance is permitted" (NOT "any rate")
        uint64 maxNewExpiry; // ceiling on the new loan's end time (unix)
        address setter;      // who set this; reader fences caps when NFT has transferred
    }

    /// @notice T-092 — per-loan per-side extend caps. Lender's and
    ///         borrower's caps are stored separately; the executor
    ///         requires the keeper to pick terms inside BOTH.
    struct AutoExtendCaps {
        bool enabled;
        uint16 minRateBps;   // borrower stores a max; lender stores a min — the executor enforces minLender ≤ newRate ≤ maxBorrower
        uint16 maxRateBps;   //
        uint64 maxNewExpiry; // both sides store an outer bound; executor picks min(both)
        address setter;      // same NFT-transfer-staleness fence as AutoRefinanceCaps
    }

    /// @notice #407 (2026-06-12) — vault encumbrance record. One row per
    ///         lien (per loan's collateral; per offer's locked principal).
    ///         Read by `VaultFactoryFacet.vaultWithdrawERC20`'s guard
    ///         via the `encumbered[user][asset][tokenId]` aggregate,
    ///         and by per-loan / per-offer view selectors for the
    ///         dapp's "exact collateral / principal backing this
    ///         position" surface.
    ///
    ///         `released = true` rows MAY remain in storage as
    ///         tombstones (cheaper than `delete`) but MUST be ignored
    ///         by every consumer; the aggregate is the only
    ///         authoritative source for "free balance".
    ///
    /// @dev    Asset-type encoding (see `PerLoanCollateralLien.md` §3.5):
    ///         - ERC20:   `(asset, tokenId=0, amount)`
    ///         - ERC721:  `(asset, tokenId, amount=1)`
    ///         - ERC1155: `(asset, tokenId, quantity)`
    struct Encumbrance {
        address user;       // vault owner — the side whose vault is locked
        address asset;      // ERC20 / ERC721 / ERC1155 contract
        uint256 tokenId;    // 0 for ERC20; tokenId for ERC721 / ERC1155
        uint256 amount;     // ERC20 amount or ERC1155 quantity (1 for ERC721)
        AssetType assetType;
        bool released;      // tombstone marker — already released, ignore
    }

    /// @dev T-087 Sub 3 add-on #473 — yield venue discriminator.
    ///      Stored as uint8 in `cfgTreasuryYieldVenue[token]`.
    uint8 internal constant TREASURY_YIELD_VENUE_NONE       = 0;
    uint8 internal constant TREASURY_YIELD_VENUE_AAVE_V3    = 1;
    uint8 internal constant TREASURY_YIELD_VENUE_LIDO_STETH = 2;

    /// @notice T-087 Sub 3.B — per-buyback-order state.
    /// @param token       Source asset being swapped into VPFI.
    /// @param amountIn    Amount of `token` reserved out of
    ///                    `baseBuybackBudget`.
    /// @param minVpfiOut  Codex Sub 3.B round-3 P1 #1 — VPFI floor
    ///                    the fill must clear. Operator pins this
    ///                    from the off-chain quote; the
    ///                    `postInteractionImpl` reverts if the
    ///                    delivered VPFI delta is below this slot.
    /// @param expiresAt   Unix-seconds deadline after which anyone
    ///                    can call `expireBuyback(orderHash)` to roll
    ///                    the reservation back into the budget.
    /// @param status      Lifecycle marker — Pending / Filled /
    ///                    Expired. Used to prevent double-fills +
    ///                    double-expires.
    struct BuybackOrderInfo {
        address token;       // slot 0: 20 bytes
        uint96 amountIn;     // slot 0: 12 bytes  (up to ~7.9e28 raw units)
        uint128 minVpfiOut;  // slot 1: 16 bytes  (up to ~3.4e38 raw VPFI units)
        uint64 expiresAt;    // slot 1: 8 bytes
        uint8 status;        // slot 1: 1 byte
    }

    /// @dev T-087 Sub 3.B — buyback-order status enum values. Kept
    ///      as bare constants (not an enum) so we can compare in
    ///      assembly + match storage layout exactly.
    uint8 internal constant BUYBACK_ORDER_STATUS_NONE    = 0;
    uint8 internal constant BUYBACK_ORDER_STATUS_PENDING = 1;
    uint8 internal constant BUYBACK_ORDER_STATUS_FILLED  = 2;
    uint8 internal constant BUYBACK_ORDER_STATUS_EXPIRED = 3;

    /// @dev T-087 Sub 3.B — order-kind discriminators stamped into
    ///      `s.orderHashKind` at commit time + cleared at terminal.
    ///      Keccak-of-purpose; never re-used.
    bytes32 internal constant ORDER_KIND_SWAP_TO_REPAY =
        keccak256("vaipakam.intent.kind.swap-to-repay");
    bytes32 internal constant ORDER_KIND_BUYBACK =
        keccak256("vaipakam.intent.kind.buyback");

    /// @dev One entry of the treasury-conversion target allocation
    ///      (T-600). `convertTreasuryAsset` splits the input balance
    ///      across the configured list pro-rata to `bps`; the BPS of
    ///      all entries sum to exactly 10000. Fully governance-set —
    ///      `ConfigFacet.setTreasuryConvertTargets` replaces the whole
    ///      list atomically, so add / remove / reweight is one call and
    ///      the sum invariant is never transiently broken.
    struct TreasuryConvertTarget {
        address asset; // the reserve asset this leg converts into
        uint16 bps;    // its share of each conversion, in basis points
    }

    /// @dev Founder / contributor salary stream (T-600 `PayrollFacet`).
    ///      A continuous per-second accrual paid out of treasury funds:
    ///        accrued = accruedAtAnchor
    ///                  + (paused ? 0 : (now - lastRateChangeAt) * ratePerSecond)
    ///        withdrawable = min(accrued, funded) - withdrawn
    ///      Clamping the payout to `funded` is what makes the stream a
    ///      SALARY — it dries up unless governance tops it up via
    ///      `fundPayrollStream` — rather than a perpetual claim on
    ///      protocol revenue.
    struct PayrollStream {
        address beneficiary;      // the only address that may withdraw
        address asset;            // ERC-20 paid out (WETH / a stablecoin)
        uint256 ratePerSecond;    // accrual rate, asset-wei per second
        uint256 funded;           // cumulative governance top-ups
        uint256 withdrawn;        // cumulative amount withdrawn
        uint256 accruedAtAnchor;  // accrual already settled up to the anchor
        uint64 lastRateChangeAt;  // anchor timestamp for the live accrual
        bool paused;              // accrual frozen while true
        bool exists;              // true once created — distinguishes a zeroed slot
    }

    /// @dev Cached tier-LTV reading. Updated permissionlessly via
    ///      `OracleFacet.refreshTierLtvCache()`. Stale-detection (soft +
    ///      hard TTL) drives the fallback semantics at loan init.
    struct TierLtvCacheEntry {
        uint16 ltvBps;            // 0 ⇒ never-refreshed
        uint64 lastRefreshedAt;   // unix seconds; 0 ⇒ never-refreshed
    }

    /// @dev Phase 7 of AutonomousLtvAndOracleFallback.md — per-tier
    ///      safety-box parameters, governance-configurable so the
    ///      protocol can adjust risk tolerance over time (Aave-style)
    ///      without redeploying. Three uint16 fields = 48 bits per
    ///      tier × 3 tiers = 144 bits → all three entries pack into
    ///      a single storage slot via the mapping value layout.
    ///
    ///      Zero-valued entries are the indicator "never configured"
    ///      and the read accessors fall through to the library
    ///      constants (`TIER1/2/3_LTV_FLOOR_BPS` / `_CEIL_BPS` /
    ///      `_HAIRCUT_BPS`). Governance can override all three at once
    ///      via `ConfigFacet.setTierLtvParams` (atomic, ADMIN_ROLE).
    struct TierLtvParams {
        uint16 floorBps;
        uint16 ceilBps;
        uint16 haircutBps;
    }

    /// @dev Range Orders Phase 1 — set by matchOffers, read by
    ///      LoanFacet._copyFinancialFields + OfferFacet._acceptOffer,
    ///      cleared post-match. See `Storage.matchOverride` for full
    ///      semantics. Carries both the concrete match terms (amount /
    ///      rateBps / collateralAmount) AND the address-resolution
    ///      override (counterparty / matcher) needed when matchOffers
    ///      processes a lender offer with msg.sender = bot rather than
    ///      a counterparty.
    struct MatchOverride {
        // Match terms read by LoanFacet._copyFinancialFields.
        uint256 amount;
        uint256 rateBps;
        uint256 collateralAmount;
        // Address-resolution override read by OfferFacet._acceptOffer.
        // counterparty: the OTHER party in the match (= the borrower
        // when matchOffers processes a lender offer). _acceptOffer
        // uses this in place of msg.sender for sanctions/country/KYC
        // checks + the borrower-resolution branch + the borrower
        // collateral pull (which is SKIPPED when override active
        // because the borrower already vaulted at borrower-offer
        // create time).
        address counterparty;
        // matcher: receives the 1% LIF kickback. Same as msg.sender on
        // the legacy acceptOffer path (set client-side from msg.sender
        // there), distinct from msg.sender on the matchOffers path.
        address matcher;
        bool active;
    }

    /// @dev Default secondary-oracle deviation tolerance: 5%.
    uint16 internal constant SECONDARY_ORACLE_MAX_DEVIATION_BPS_DEFAULT = 500;

    /// @dev Default secondary-oracle staleness: 1h.
    uint40 internal constant SECONDARY_ORACLE_MAX_STALENESS_DEFAULT = 3600;

    // ─── T-033 — Pyth numeraire-redundancy bounds ──────────────────────────
    //
    // Every Pyth knob is governance-tunable but bounded so a
    // compromised admin / governance multisig cannot push the value
    // to a degenerate setting that effectively disables the gate
    // (too-loose bounds) or fail-closes the protocol (too-tight
    // bounds). The setter on {OracleAdminFacet} reverts on out-of-
    // range writes with a `ParameterOutOfRange(name, value, min,
    // max)` error so failed governance proposals surface clearly.

    /// @dev Default deviation between Chainlink and Pyth ETH/USD
    ///      that's tolerated before {OracleCrossCheckDivergence}
    ///      fires: 5%. Pyth and Chainlink can naturally drift this
    ///      far in fast markets without either being compromised.
    uint16 internal constant PYTH_NUMERAIRE_MAX_DEVIATION_BPS_DEFAULT = 500;

    /// @dev Lower bound on the deviation tolerance — 1% (100 bps).
    ///      Tighter than this would fail-close on legitimate
    ///      cross-oracle drift and DoS the protocol. The bound
    ///      applies to setter writes; the runtime value is allowed
    ///      to be at the floor.
    uint16 internal constant PYTH_NUMERAIRE_MAX_DEVIATION_BPS_MIN = 100;

    /// @dev Upper bound on the deviation tolerance — 20% (2000 bps).
    ///      Looser than this and the gate is effectively disabled
    ///      (a 20% peg-feed drift between independent oracles is
    ///      already unusual; a 30%+ drift is "one is compromised"
    ///      no matter how charitable the variance assumption).
    uint16 internal constant PYTH_NUMERAIRE_MAX_DEVIATION_BPS_MAX = 2000;

    /// @dev Default Pyth confidence-fraction ceiling: 1% (100 bps).
    ///      `conf / price > 1%` → soft-skip Pyth on this read.
    uint16 internal constant PYTH_CONFIDENCE_MAX_BPS_DEFAULT = 100;

    /// @dev Lower bound on confidence ceiling — 0.5% (50 bps).
    ///      Tighter and Pyth gets soft-skipped too often (most
    ///      well-published feeds run conf < 0.3%, so 0.5% gives
    ///      headroom for fast markets without going opaque).
    uint16 internal constant PYTH_CONFIDENCE_MAX_BPS_MIN = 50;

    /// @dev Upper bound on confidence ceiling — 5% (500 bps).
    ///      Beyond this the "Pyth said the price is X" claim has
    ///      enough uncertainty that consulting it is meaningless.
    uint16 internal constant PYTH_CONFIDENCE_MAX_BPS_MAX = 500;

    /// @dev Default Pyth max-staleness: 5 min. Pyth's published
    ///      heartbeat on ETH/USD is sub-second on Base; 5min is a
    ///      generous "the publishers are at least breathing" bound.
    uint64 internal constant PYTH_MAX_STALENESS_DEFAULT_SECONDS = 300;

    /// @dev Lower bound on Pyth staleness budget — 1 min. Tighter
    ///      and a transient mempool jam soft-skips Pyth too often.
    uint64 internal constant PYTH_MAX_STALENESS_MIN_SECONDS = 60;

    /// @dev Upper bound on Pyth staleness budget — 1 h. Beyond this
    ///      Pyth is effectively cached forever and a stale-but-
    ///      manipulated reading could drive divergence outcomes.
    uint64 internal constant PYTH_MAX_STALENESS_MAX_SECONDS = 3600;

    // ─── Setter range audit (2026-05-02) — bounds for governance-tunable
    //     parameters that previously had no min/max. The shared
    //     `ParameterOutOfRange(name, value, min, max)` error in
    //     {IVaipakamErrors} is the load-bearing guard; even a
    //     compromised governance multisig cannot push these values
    //     beyond the policy range without a contract upgrade.

    /// @dev Tighter cap on the secondary-oracle deviation tolerance
    ///      (Tellor / API3 / DIA). Replaces the previous
    ///      `(0, BASIS_POINTS)` window — too wide. Same shape as the
    ///      Pyth gate.
    uint16 internal constant SECONDARY_ORACLE_MAX_DEVIATION_BPS_MIN = 100;
    uint16 internal constant SECONDARY_ORACLE_MAX_DEVIATION_BPS_MAX = 2000;

    /// @dev Bounds for {setSecondaryOracleMaxStaleness}. Previous
    ///      `!= 0` had no upper bound — a misconfig could allow
    ///      arbitrary stale data through the secondary quorum.
    ///      Upper at 29h leaves a 5h buffer above the 24h heartbeat
    ///      that some stablecoin price feeds (USDC, USDT) publish on
    ///      — tightening below 24h would soft-skip those feeds on
    ///      every legitimate update.
    uint40 internal constant SECONDARY_ORACLE_MAX_STALENESS_MIN_SECONDS = 60;
    uint40 internal constant SECONDARY_ORACLE_MAX_STALENESS_MAX_SECONDS =
        29 * 3600;

    /// @dev Bounds for {setRewardGraceSeconds}. Previous setter had
    ///      no bounds. Min 5 min so a transient outage can't be
    ///      confused with a real grace; max 30 days so the grace
    ///      window can't be set to "indefinite" (defeats the purpose).
    uint64 internal constant REWARD_GRACE_MIN_SECONDS = 300;
    uint64 internal constant REWARD_GRACE_MAX_SECONDS = 30 days;

    /// @dev Bounds for {setInteractionCapVpfiPerEth}. The setter's
    ///      `value` is "whole VPFI per ETH of eligible interest"
    ///      (NOT 1e18-scaled; spec default is `500`). Previously
    ///      unbounded — a compromised admin could push to absurd
    ///      ratios. Min 1 VPFI/ETH (effectively shuts down rewards
    ///      without flipping the disable sentinel); max 1,000,000
    ///      VPFI/ETH (above any realistic interaction-rate spec).
    ///      The two intentional sentinels documented on the setter
    ///      (`0` = reset-to-default, `type(uint256).max` = disable
    ///      cap emergency knob) are preserved as escape paths.
    uint256 internal constant INTERACTION_CAP_VPFI_PER_ETH_MIN = 1;
    uint256 internal constant INTERACTION_CAP_VPFI_PER_ETH_MAX = 1_000_000;

    /// @dev Bounds for {RiskFacet.updateRiskParams.loanInitMaxLtvBps}. Min
    ///      10% — `maxLtv = 1` would effectively disable borrowing
    ///      for the asset. Upper bound stays at BASIS_POINTS via
    ///      the existing inline check.
    uint16 internal constant RISK_PARAMS_MAX_LTV_BPS_MIN = 1000;

    // NOTE: `RISK_PARAMS_LIQ_THRESHOLD_BPS_MIN` retired in PR2 of the
    //   internal-match work — the per-asset `RiskParams.liqThresholdBps`
    //   it gated no longer exists. Liquidation threshold is now
    //   per-tier; bounds live on `MIN_TIER_LIQUIDATION_LTV_BPS` /
    //   `MAX_TIER_LIQUIDATION_LTV_BPS` and are enforced by
    //   `ConfigFacet.setTierLiquidationLtvBps`.

    /// @dev Bounds for {RiskFacet.updateRiskParams.reserveFactorBps}.
    ///      Max 50% — `reserveFactor = BASIS_POINTS` (100%) means
    ///      lender receives 0% interest, defeats the lending
    ///      product. Existing inline `≤ BASIS_POINTS` is replaced
    ///      by this tighter cap.
    uint16 internal constant RISK_PARAMS_RESERVE_FACTOR_BPS_MAX = 5000;

    /// @dev Bounds for {ProfileFacet.updateKYCThresholds}. The
    ///      existing inline check enforces `tier0 < tier1`;
    ///      these bounds prevent governance from setting absurdly
    ///      low or high USD thresholds (denominated in 1e18).
    ///      KYC is OFF on the retail deploy (per CLAUDE.md), so
    ///      these bounds are belt-and-suspenders rather than
    ///      load-bearing on retail; on the industrial fork they
    ///      cap the tunable to a credible per-tier USD window.
    uint256 internal constant KYC_THRESHOLD_NUMERAIRE_MIN_FLOOR = 100e18; // $100
    uint256 internal constant KYC_THRESHOLD_NUMERAIRE_MAX_CEIL = 1_000_000e18; // $1M

    /// @notice #399 backstop v0 — default minimum seconds an offer must sit
    ///         unmatched before its `backstopEligibleAfter` may fire (used when
    ///         `protocolCfg.minBackstopDelay == 0`). 1 day: the backstop is a
    ///         genuine unmatched-after-interval fallback, never first-choice.
    uint64 internal constant BACKSTOP_MIN_DELAY_DEFAULT = 1 days;

    uint256 internal constant MAX_APPROVED_KEEPERS = 5;

    // ─── Phase 6: Keeper action bitmask constants ────────────────────────────
    // Each keeper carries a `uint16` bitmask of actions they're authorised to
    // drive for a given NFT holder. Bits are OR'd together; up to 16 actions
    // (8 defined today, bits 8–15 spare). The constants are `uint16` to match
    // the `approvedKeeperActions[user][keeper]` storage type. The container was
    // widened from `uint8` in #1221 (E-4/E-10 prereq): the original 8 bits
    // filled the byte, so adding a 9th action would otherwise force a storage +
    // ABI break. With the container already `uint16`, a new action is a pure
    // logic change — define its `1 << N` constant, OR it into
    // `KEEPER_ACTION_ALL`, and add the executor's `requireKeeperFor` check. No
    // storage migration (mapping values are one-per-slot, right-aligned, so a
    // value written as `uint8` reads back identically as `uint16`).
    uint16 internal constant KEEPER_ACTION_COMPLETE_LOAN_SALE = 1 << 0; // 0x01
    uint16 internal constant KEEPER_ACTION_COMPLETE_OFFSET = 1 << 1; // 0x02
    uint16 internal constant KEEPER_ACTION_INIT_EARLY_WITHDRAW = 1 << 2; // 0x04
    uint16 internal constant KEEPER_ACTION_INIT_PRECLOSE = 1 << 3; // 0x08
    uint16 internal constant KEEPER_ACTION_REFINANCE = 1 << 4; // 0x10
    /// @dev T-092 — auto in-place loan extension (no NFT churn).
    ///      Gated by BOTH the borrower's and lender's per-loan
    ///      `autoExtendConsent` caps in `AutoLifecycleFacet`. The
    ///      executor (`extendLoanInPlace`) lands in T-092 Phase 3;
    ///      the bit is reserved here so the consent-cap setters
    ///      shipped in Phase 1 stay forward-compatible.
    uint16 internal constant KEEPER_ACTION_EXTEND = 1 << 5; // 0x20
    /// @dev #393 v1-c — authorize a solver to fill the principal owner's
    ///      standing lending INTENT (`OfferMatchFacet.matchIntent`) when that
    ///      intent is set `requiresKeeperAuth`. PRE-loan / principal-keyed (the
    ///      loan doesn't exist at fill time), so it is checked via
    ///      `LibAuth.requireKeeperForPrincipal`, not the loan-keyed
    ///      `requireKeeperFor`. An un-opted intent stays openly fillable.
    uint16 internal constant KEEPER_ACTION_SIGNED_FILL = 1 << 6; // 0x40
    /// @dev #393 v1-d.2 — authorize a keeper to AUTO-ROLL the principal owner's
    ///      repaid standing-intent loans (`LenderIntentFacet.rollIntentLoan`):
    ///      re-lien the repaid principal + interest back into the intent's
    ///      capital pool for zero-gap redeployment, instead of paying it to the
    ///      lender's wallet. PRE-/cross-loan and principal-keyed (authority is
    ///      "act for this lender"), so checked via `requireKeeperForPrincipal`.
    ///      This filled the last bit of the original uint8 keeper bitmask;
    ///      #1221 widened `approvedKeeperActions` to uint16 so bits 8–15 are
    ///      now available for future actions (E-4 auto-protect, E-10
    ///      keeper-sweep) without a further storage/ABI break.
    uint16 internal constant KEEPER_ACTION_AUTO_ROLL = 1 << 7; // 0x80
    /// @dev All DEFINED actions — convenience for "grant everything" UX
    ///      flows, and the validation bound in
    ///      `ProfileFacet._requireValidKeeperActions`. T-092 Phase 3 (#503)
    ///      widened this from 0x1F to 0x3F at the same time the
    ///      `extendLoanInPlace` executor landed; #393 v1-c widened it 0x3F →
    ///      0x7F with SIGNED_FILL; #393 v1-d.2 widened it 0x7F → 0xFF with
    ///      AUTO_ROLL. The container is now uint16 (#1221); this value stays
    ///      0xFF until a bit 8–15 action is defined, at which point the new
    ///      bit is OR'd in here.
    uint16 internal constant KEEPER_ACTION_ALL = 0xFF;

    /**
     * @notice Retrieves the Vaipakam storage slot.
     * @dev Uses assembly to load the struct at the predefined position.
     *      Used by all facets to access shared state.
     * @return s The Storage struct.
     */
    function storageSlot() internal pure returns (Storage storage s) {
        bytes32 position = VANGKI_STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }

    /// @dev Writes `user`'s ISO country code into shared storage. No
    ///      validation of the string here — the calling facet (ProfileFacet)
    ///      enforces length / normalization.
    /// @param user    Address whose country code to set.
    /// @param country ISO-3166 country code.
    function setUserCountry(address user, string memory country) internal {
        Storage storage s = storageSlot();
        s.userCountry[user] = country;
    }

    /// @dev Returns the KYC Tier-0 threshold in NUMERAIRE-units (1e18-
    ///      scaled). After Numeraire generalization (b1), `OracleFacet.getAssetPrice`
    ///      returns numeraire-quoted prices directly, so comparison
    ///      sites (`OfferFacet`, `RiskFacet`, `DefaultedFacet`) compute
    ///      `valueNumeraire` and compare against this return value
    ///      numeraire-vs-numeraire. The boundary conversion that lived
    ///      here under Phase 2 is removed — the numeraire abstraction
    ///      moved up to the oracle layer.
    function getKycTier0Threshold() internal view returns (uint256 threshold) {
        uint256 v = storageSlot().kycTier0ThresholdNumeraire;
        return v == 0 ? KYC_TIER0_THRESHOLD_NUMERAIRE : v;
    }

    /// @dev Returns the KYC Tier-1 threshold in NUMERAIRE-units (1e18-
    ///      scaled). Same shape as Tier-0 above. Numeraire generalization (b1).
    function getKycTier1Threshold() internal view returns (uint256 threshold) {
        uint256 v = storageSlot().kycTier1ThresholdNumeraire;
        return v == 0 ? KYC_TIER1_THRESHOLD_NUMERAIRE : v;
    }

    /// @dev Returns the effective per-user daily interaction-reward cap
    ///      (whole VPFI per 1 ETH of eligible interest). Falls back to
    ///      {INTERACTION_CAP_DEFAULT_VPFI_PER_ETH} when the admin override
    ///      is unset. A governance-stored `type(uint256).max` disables the
    ///      cap entirely (claim math short-circuits on that sentinel).
    /// @return cap Whole VPFI per 1 ETH ratio used to size the per-user
    ///             per-side per-day payout ceiling.
    function getInteractionCapVpfiPerEth() internal view returns (uint256 cap) {
        uint256 v = storageSlot().interactionCapVpfiPerEth;
        return v == 0 ? INTERACTION_CAP_DEFAULT_VPFI_PER_ETH : v;
    }

    // ─── ProtocolConfig getters (zero ⇒ constant default) ────────────
    // Every call site that previously referenced a `LibVaipakam.*_BPS`
    // constant should now route through one of these helpers so that
    // {ConfigFacet} can tune the value at runtime. Keep these in sync
    // with the `ProtocolConfig` struct layout above.

    function cfgTreasuryFeeBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.treasuryFeeBps;
        return v == 0 ? TREASURY_FEE_BPS : uint256(v);
    }

    function cfgLoanInitiationFeeBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.loanInitiationFeeBps;
        return v == 0 ? LOAN_INITIATION_FEE_BPS : uint256(v);
    }

    function cfgLiquidationHandlingFeeBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.liquidationHandlingFeeBps;
        return v == 0 ? LIQUIDATION_HANDLING_FEE_BPS : uint256(v);
    }

    function cfgMaxLiquidationSlippageBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.maxLiquidationSlippageBps;
        return v == 0 ? MAX_LIQUIDATION_SLIPPAGE_BPS : uint256(v);
    }

    /// @notice Maximum slippage (BPS) the borrower-initiated
    ///         {SwapToRepayFacet} swap may realize. Sibling to
    ///         {cfgMaxLiquidationSlippageBps} with a tighter default
    ///         (300 vs. 600) — the borrower is not on an adversarial
    ///         clock and can wait for better price action.
    function cfgMaxSwapToRepaySlippageBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.maxSwapToRepaySlippageBps;
        return v == 0 ? MAX_SWAP_TO_REPAY_SLIPPAGE_BPS : uint256(v);
    }

    function cfgMaxLiquidatorIncentiveBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.maxLiquidatorIncentiveBps;
        return v == 0 ? MAX_LIQUIDATOR_INCENTIVE_BPS : uint256(v);
    }

    function cfgVolatilityLtvThresholdBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.volatilityLtvThresholdBps;
        return v == 0 ? VOLATILITY_LTV_THRESHOLD_BPS : uint256(v);
    }

    function cfgRentalBufferBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.rentalBufferBps;
        return v == 0 ? RENTAL_BUFFER_BPS : uint256(v);
    }

    /// @dev Effective platform-retained recycling margin (bps). `0` ⇒
    ///      {RECYCLE_MARGIN_DEFAULT_BPS}. The governor reads this once per
    ///      finalized day and stamps it, so a mid-day retune never rewrites
    ///      an already-finalized day (design §3.2).
    function cfgRecycleMarginBps() internal view returns (uint256) {
        uint16 v = storageSlot().recycleMarginBps;
        return v == 0 ? uint256(RECYCLE_MARGIN_DEFAULT_BPS) : uint256(v);
    }

    /// @dev Effective tariff `k` (VPFI-1e18 per ETH-1e18 of loan volume per
    ///      day). `0` ⇒ {RECYCLE_TARIFF_K_DEFAULT}.
    function cfgRecycleTariffKPer1e18EthDay() internal view returns (uint256) {
        uint256 v = storageSlot().recycleTariffKPer1e18EthDay;
        return v == 0 ? RECYCLE_TARIFF_K_DEFAULT : v;
    }

    /// @dev #1193 (Pass-2 D3) — the rental buffer BPS an offer FUNDED, read from
    ///      the create-time snapshot so a later `cfgRentalBufferBps()` governance
    ///      retune can't desync a cancel refund / Option-2 buffer reset from the
    ///      amount actually vaulted at create. `0` ⇒ legacy offer (snapshot did
    ///      not exist yet) → fall back to the live config, matching the
    ///      pre-#1193 behaviour for offers created before this field.
    function effectiveRentalBufferBps(Offer storage offer) internal view returns (uint256) {
        uint16 v = offer.rentalBufferBpsAtCreate;
        return v == 0 ? cfgRentalBufferBps() : uint256(v);
    }

    /// @dev Fallback-path split, with zero-is-default fall-through to the
    ///      compile-time constants. Callers at `initiateLoan` read these
    ///      once to snapshot onto the `Loan`; settlement (`LibFallback`)
    ///      reads from the loan's snapshot fields, not from here.
    function cfgFallbackLenderBonusBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.fallbackLenderBonusBps;
        return v == 0 ? FALLBACK_LENDER_BONUS_BPS : uint256(v);
    }

    function cfgFallbackTreasuryBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.fallbackTreasuryBps;
        return v == 0 ? FALLBACK_TREASURY_BPS : uint256(v);
    }

    /// @dev Range Orders Phase 1 — matcher's slice of any LIF that
    ///      flows to treasury, in BPS. Governance-tunable via
    ///      `ConfigFacet.setLifMatcherFeeBps`; falls back to the
    ///      LIF_MATCHER_FEE_BPS constant (100 = 1%) when unset.
    function cfgLifMatcherFeeBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.lifMatcherFeeBps;
        return v == 0 ? LIF_MATCHER_FEE_BPS : uint256(v);
    }

    /// @dev Phase 2 liquidator hardening (item 2) — close-factor ceiling
    ///      for `RiskFacet.triggerPartialLiquidation`. Governance-tunable
    ///      via `ConfigFacet.setMaxPartialLiquidationCloseFactorBps`;
    ///      falls back to MAX_PARTIAL_LIQUIDATION_CLOSE_FACTOR_BPS_DEFAULT
    ///      (10_000 = 100%, no cap) when unset. Setter caps the configured
    ///      value at 10_000 — a partial fraction above 100% has no
    ///      semantic meaning (would swap more than the loan's remaining
    ///      collateral). Read once at the partial-liquidation entry point
    ///      to enforce `fractionBps ≤ cap`.
    function cfgMaxPartialLiquidationCloseFactorBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.maxPartialLiquidationCloseFactorBps;
        return v == 0 ? MAX_PARTIAL_LIQUIDATION_CLOSE_FACTOR_BPS_DEFAULT : uint256(v);
    }

    /// @dev #395 — graduated partial-liquidation sizing (Approach A). All
    ///      three read `protocolCfg` with a `0 ⇒ library default` fallback;
    ///      `RiskFacet._assertPartialSizing` consumes them. Values are
    ///      range-clamped at the setter, so reads are trusted unconditionally.
    function cfgPartialLiqTargetHfCeilingBps() internal view returns (uint256) {
        uint16 v = storageSlot().partialLiqTargetHfCeilingBps;
        return v == 0 ? PARTIAL_LIQ_TARGET_HF_CEILING_BPS_DEFAULT : uint256(v);
    }

    function cfgPartialLiqDeepUnderwaterHfBps() internal view returns (uint256) {
        uint16 v = storageSlot().partialLiqDeepUnderwaterHfBps;
        return v == 0 ? PARTIAL_LIQ_DEEP_UNDERWATER_HF_BPS_DEFAULT : uint256(v);
    }

    /// @dev 0 ⇒ dust handling DISABLED (no default substitution) — see the
    ///      storage-field note. Governance opts in with a floor in the active
    ///      numeraire; `RiskFacet._assertPartialSizing` skips both the dust
    ///      waiver and the dust-prevention check while this is 0.
    function cfgLiquidationDustFloorNumeraire() internal view returns (uint256) {
        return storageSlot().liquidationDustFloorNumeraire;
    }

    /// @dev #400 — active quote-time rate model; `address(0)` ⇒ identity
    ///      (user-supplied rate stands). Consumed only by `OfferCreateFacet`.
    function cfgRateModel() internal view returns (address) {
        return storageSlot().rateModel;
    }

    /// @dev #400 (hardening) — max ± BPS a model may move a quote from the
    ///      reference; 0 ⇒ default. The resolver clamps to this band.
    function cfgRateModelMaxDeviationBps() internal view returns (uint256) {
        uint16 v = storageSlot().rateModelMaxDeviationBps;
        return v == 0 ? RATE_MODEL_MAX_DEVIATION_BPS_DEFAULT : uint256(v);
    }

    /// @dev #394 Lever A — the live loan-ADMISSION Health Factor floor (the
    ///      value the non-tiered init gate, plus the restore/maintain/preview
    ///      HF checks, compare against). `0` override ⇒ `MIN_HEALTH_FACTOR`
    ///      (1.5e18 — today's behaviour), so nothing moves until governance
    ///      sets it. The setter range-clamps to
    ///      `[MIN_ADMISSION_HEALTH_FACTOR, MAX_ADMISSION_HEALTH_FACTOR]`, so
    ///      this getter needs no re-clamp. Does NOT govern the liquidation
    ///      trigger (`HF_LIQUIDATION_THRESHOLD`) or the tiered-regime init
    ///      floor — both stay 1e18.
    function minHealthFactor() internal view returns (uint256) {
        uint64 v = storageSlot().minHealthFactorOverride;
        return v == 0 ? MIN_HEALTH_FACTOR : uint256(v);
    }

    /// @dev #394 Lever A (Codex #647 P1) — the admission HF floor a SPECIFIC
    ///      open loan was created under, read from its `minHealthFactorAtInit`
    ///      snapshot. Every post-admission HF check for that loan uses this
    ///      (NOT the live `minHealthFactor()`), so a governance retune never
    ///      retroactively moves an open loan's collateral buffer. `0` (illiquid
    ///      or pre-#394 loan) ⇒ `MIN_HEALTH_FACTOR` (1.5e18) — the conservative
    ///      legacy floor.
    function effectiveLoanMinHealthFactor(uint64 atInit) internal pure returns (uint256) {
        return atInit == 0 ? MIN_HEALTH_FACTOR : uint256(atInit);
    }

    /// @dev #394 Lever A (Codex #647 round-3 P1) — the init-LTV cap a SPECIFIC
    ///      open loan was admitted under, from its `initLtvCapBpsAtInit`
    ///      snapshot. Post-admission withdrawal / max-withdrawable / cure
    ///      enforce this (not the live per-asset cap), so a depth-tiered loan
    ///      keeps the tighter `min(assetCap, tierCap)` buffer it was born with.
    ///      `0` (illiquid or pre-#394 loan) ⇒ the live per-asset
    ///      `loanInitMaxLtvBps` passed in as `liveCapBps`.
    function effectiveLoanInitLtvCapBps(
        uint16 atInit,
        uint256 liveCapBps
    ) internal pure returns (uint256) {
        return atInit == 0 ? liveCapBps : uint256(atInit);
    }

    /// @dev #957 (#921 item 6) — the treasury-fee BPS a SPECIFIC open loan was
    ///      originated under, read from its `treasuryFeeBpsAtInit` snapshot.
    ///      Every settlement / close-out treasury split for that loan uses
    ///      this (NOT the live `cfgTreasuryFeeBps()`), so a mid-loan
    ///      governance retune never changes the economics of a loan already
    ///      originated. `0` (pre-#957 loan) ⇒ the live knob — the
    ///      conservative legacy behaviour.
    function effectiveTreasuryFeeBps(
        Loan storage loan
    ) internal view returns (uint256) {
        uint16 atInit = loan.treasuryFeeBpsAtInit;
        return atInit == 0 ? cfgTreasuryFeeBps() : uint256(atInit);
    }

    /// @dev Phase 1 follow-up — auto-pause duration (seconds) used by
    ///      `LibPausable.autoPause`. Governance-tunable via
    ///      `ConfigFacet.setAutoPauseDurationSeconds` within
    ///      [MIN_AUTO_PAUSE_SECONDS, MAX_AUTO_PAUSE_SECONDS]. Falls
    ///      back to AUTO_PAUSE_DURATION_DEFAULT (1800 = 30 min)
    ///      when unset.
    function cfgAutoPauseDurationSeconds() internal view returns (uint256) {
        uint32 v = storageSlot().protocolCfg.autoPauseDurationSeconds;
        return v == 0 ? AUTO_PAUSE_DURATION_DEFAULT : uint256(v);
    }

    /// @dev Maximum offer duration in days (Findings 00025).
    ///      Governance-tunable via `ConfigFacet.setMaxOfferDurationDays`
    ///      within [MIN_OFFER_DURATION_DAYS_FLOOR,
    ///      MAX_OFFER_DURATION_DAYS_CEIL]. Falls back to
    ///      MAX_OFFER_DURATION_DAYS_DEFAULT (365) when unset.
    function cfgMaxOfferDurationDays() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.maxOfferDurationDays;
        return v == 0 ? MAX_OFFER_DURATION_DAYS_DEFAULT : uint256(v);
    }

    /// @dev T-032 / Numeraire generalization (Phase 1) — Notification fee in NUMERAIRE
    ///      units (1e18 scaled). Governance-tunable via
    ///      `ConfigFacet.setNotificationFee` within
    ///      [MIN_NOTIFICATION_FEE_FLOOR, MAX_NOTIFICATION_FEE_CEIL].
    ///      Falls back to `NOTIFICATION_FEE_DEFAULT` (2.0 numeraire-units
    ///      = $2 under USD-as-numeraire) when unset. The numeraire-to-USD
    ///      conversion happens at the `LibNotificationFee.vpfiAmountForFee`
    ///      boundary so the stored value can be re-anchored when
    ///      governance rotates the numeraire.
    function cfgNotificationFee() internal view returns (uint256) {
        uint256 v = storageSlot().protocolCfg.notificationFee;
        return v == 0 ? NOTIFICATION_FEE_DEFAULT : v;
    }

    // ─── Depth-tiered LTV (Piece B) — config accessors ────────────────
    // See docs/DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md §4.2.
    // Every "size" is PAD × 1e6 units; every `*Bps` is basis points.

    /// @dev Master kill-switch for the depth-tiered init-LTV cap. While
    ///      `false` (the fresh-deploy default), `OracleFacet.getLiquidityTier`
    ///      still resolves a tier (read-only — for the keeper / UI) but
    ///      the loan-init gate and the `matchOffers` synthetic-HF check
    ///      ignore the per-tier LTV cap → exactly today's `HF ≥ 1.5`
    ///      behaviour. Flipped on per chain by `ConfigFacet.setDepthTieredLtvEnabled`
    ///      after that chain's slippage census + audit.
    function cfgDepthTieredLtvEnabled() internal view returns (bool) {
        return storageSlot().protocolCfg.depthTieredLtvEnabled;
    }

    /// @dev #671 — master kill-switch for the progressive risk-access gate.
    ///      Default `false` ⇒ every gate site (create / accept / match /
    ///      refinance / obligation-transfer) no-ops, so a fresh deploy is
    ///      unchanged. Flipped on per chain by
    ///      `ConfigFacet.setRiskAccessGateEnabled` after that chain's liquidity
    ///      census, mirroring the `depthTieredLtvEnabled` rollout. Lives at the
    ///      `Storage` tail (NOT in `ProtocolConfig`, which would shift every
    ///      subsequent top-level slot — same reason as
    ///      `backstopMinSecondaryOracleCoverage`).
    function cfgRiskAccessGateEnabled() internal view returns (bool) {
        return storageSlot().riskAccessGateEnabled;
    }

    /// @dev #671 (O6) — membership test for the configured PAA quote-asset
    ///      basket (the numeraire set the depth oracle measures every other
    ///      asset against). A member is blue-chip BY CONSTRUCTION — you cannot
    ///      use a non-deep asset as the measuring stick — so the risk gate
    ///      treats the basket as tier-3-equivalent even though a numeraire
    ///      can't route-quote against itself. WETH is handled separately in
    ///      `LibRiskAccess._isBlueChip` (it is the implicit single-element PAA
    ///      fallback when `paaAssets` is empty), so this checks only the
    ///      explicitly-configured array.
    function isPaaAsset(address asset) internal view returns (bool) {
        if (asset == address(0)) return false;
        address[] storage paa = storageSlot().paaAssets;
        uint256 n = paa.length;
        for (uint256 i; i < n; ++i) {
            if (paa[i] == asset) return true;
        }
        return false;
    }

    /// @dev Slippage bound (bps) a simulated fixed-size swap must clear
    ///      for the asset's pool to count toward a tier. `0 ⇒
    ///      LIQUIDITY_SLIPPAGE_BPS_DEFAULT` (200). Setter-bounded
    ///      `[MIN_LIQUIDITY_SLIPPAGE_BPS, MAX_LIQUIDITY_SLIPPAGE_BPS]`.
    function cfgLiquiditySlippageBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.liquiditySlippageBps;
        return v == 0 ? LIQUIDITY_SLIPPAGE_BPS_DEFAULT : uint256(v);
    }

    /// @dev Pool spot-vs-own-TWAP agreement band (bps) — manipulation
    ///      guard in `getLiquidityTier`. `0 ⇒ TWAP_CONSISTENCY_BPS_DEFAULT`
    ///      (300). Setter-bounded `[MIN_TWAP_CONSISTENCY_BPS, MAX_…]`.
    function cfgTwapConsistencyBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.twapConsistencyBps;
        return v == 0 ? TWAP_CONSISTENCY_BPS_DEFAULT : uint256(v);
    }

    /// @dev TWAP observation window (seconds) for the consistency guard.
    ///      `0 ⇒ TWAP_WINDOW_SEC_DEFAULT` (1800). Setter-bounded
    ///      `[MIN_TWAP_WINDOW_SEC, MAX_TWAP_WINDOW_SEC]`.
    function cfgTwapWindowSec() internal view returns (uint256) {
        uint32 v = storageSlot().protocolCfg.twapWindowSec;
        return v == 0 ? TWAP_WINDOW_SEC_DEFAULT : uint256(v);
    }

    /// @dev Binary `Liquid`/`Illiquid` floor — the simulated-swap test
    ///      size below which an asset is `Illiquid`. `0 ⇒
    ///      FLOOR_SIZE_PAD_DEFAULT` (5,000 PAD). (Becomes the active
    ///      `_v3DepthLiquid` threshold once §4.4-step-3-proper lands;
    ///      until then `MIN_LIQUIDITY_PAD` is.)
    function cfgFloorSizePad() internal view returns (uint256) {
        uint64 v = storageSlot().protocolCfg.floorSizePad;
        return v == 0 ? FLOOR_SIZE_PAD_DEFAULT : uint256(v);
    }

    /// @dev Tier-1 simulated-swap test size. `0 ⇒ TIER1_SIZE_PAD_DEFAULT` (50k PAD).
    function cfgTier1SizePad() internal view returns (uint256) {
        uint64 v = storageSlot().protocolCfg.tier1SizePad;
        return v == 0 ? TIER1_SIZE_PAD_DEFAULT : uint256(v);
    }

    /// @dev Tier-2 simulated-swap test size. `0 ⇒ TIER2_SIZE_PAD_DEFAULT` (500k PAD).
    function cfgTier2SizePad() internal view returns (uint256) {
        uint64 v = storageSlot().protocolCfg.tier2SizePad;
        return v == 0 ? TIER2_SIZE_PAD_DEFAULT : uint256(v);
    }

    /// @dev Tier-3 simulated-swap test size. `0 ⇒ TIER3_SIZE_PAD_DEFAULT` (5M PAD).
    function cfgTier3SizePad() internal view returns (uint256) {
        uint64 v = storageSlot().protocolCfg.tier3SizePad;
        return v == 0 ? TIER3_SIZE_PAD_DEFAULT : uint256(v);
    }

    /// @dev Convenience: the simulated-swap test size for tier `n`
    ///      (1, 2, or 3). Tier 0 returns the binary `Liquid` floor
    ///      (`cfgFloorSizePad`). Reverts for `n > MAX_LIQUIDITY_TIER`
    ///      — callers iterate over the known tier range.
    function cfgTierSizePad(uint8 tier) internal view returns (uint256) {
        if (tier == 0) return cfgFloorSizePad();
        if (tier == 1) return cfgTier1SizePad();
        if (tier == 2) return cfgTier2SizePad();
        if (tier == 3) return cfgTier3SizePad();
        revert IVaipakamErrors.ParameterOutOfRange(
            "liquidityTier", uint256(tier), 0, uint256(MAX_LIQUIDITY_TIER)
        );
    }

    /// @dev Tier-1 init-LTV cap (bps). `0 ⇒ TIER1_MAX_INIT_LTV_BPS_DEFAULT` (5000).
    function cfgTier1MaxInitLtvBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.tier1MaxInitLtvBps;
        return v == 0 ? TIER1_MAX_INIT_LTV_BPS_DEFAULT : uint256(v);
    }

    /// @dev Tier-2 init-LTV cap (bps). `0 ⇒ TIER2_MAX_INIT_LTV_BPS_DEFAULT` (6000).
    function cfgTier2MaxInitLtvBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.tier2MaxInitLtvBps;
        return v == 0 ? TIER2_MAX_INIT_LTV_BPS_DEFAULT : uint256(v);
    }

    /// @dev Tier-3 init-LTV cap (bps). `0 ⇒ TIER3_MAX_INIT_LTV_BPS_DEFAULT` (6500).
    function cfgTier3MaxInitLtvBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.tier3MaxInitLtvBps;
        return v == 0 ? TIER3_MAX_INIT_LTV_BPS_DEFAULT : uint256(v);
    }

    /// @dev The init-LTV cap (bps) at tier `n`. Tier 0 (below the
    ///      `Liquid` floor) ⇒ `0` — no borrow against it. Reverts for
    ///      `n > MAX_LIQUIDITY_TIER`. Only consulted while
    ///      `depthTieredLtvEnabled`; the effective init cap is
    ///      `min(assetRiskParams.loanInitMaxLtvBps, cfgTierMaxInitLtvBps(tier))`.
    function cfgTierMaxInitLtvBps(uint8 tier) internal view returns (uint256) {
        if (tier == 0) return 0;
        if (tier == 1) return cfgTier1MaxInitLtvBps();
        if (tier == 2) return cfgTier2MaxInitLtvBps();
        if (tier == 3) return cfgTier3MaxInitLtvBps();
        revert IVaipakamErrors.ParameterOutOfRange(
            "liquidityTier", uint256(tier), 0, uint256(MAX_LIQUIDITY_TIER)
        );
    }

    /// @dev Tier-1 LIQUIDATION threshold (bps). `0 ⇒ DEFAULT_TIER1_LIQUIDATION_LTV_BPS` (8000 = 80%).
    function cfgTier1LiquidationLtvBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.tier1LiquidationLtvBps;
        return v == 0 ? uint256(DEFAULT_TIER1_LIQUIDATION_LTV_BPS) : uint256(v);
    }

    /// @dev Tier-2 LIQUIDATION threshold (bps). `0 ⇒ DEFAULT_TIER2_LIQUIDATION_LTV_BPS` (8500 = 85%).
    function cfgTier2LiquidationLtvBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.tier2LiquidationLtvBps;
        return v == 0 ? uint256(DEFAULT_TIER2_LIQUIDATION_LTV_BPS) : uint256(v);
    }

    /// @dev Tier-3 LIQUIDATION threshold (bps). `0 ⇒ DEFAULT_TIER3_LIQUIDATION_LTV_BPS` (9000 = 90%).
    function cfgTier3LiquidationLtvBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.tier3LiquidationLtvBps;
        return v == 0 ? uint256(DEFAULT_TIER3_LIQUIDATION_LTV_BPS) : uint256(v);
    }

    /// @dev Per-tier liquidation threshold (bps) by liquidity tier. Tier 0
    ///      covers two distinct cases: (1) a genuinely ILLIQUID loan never
    ///      enters the HF path (it reverts `IlliquidLoanNoRiskMath` in
    ///      `RiskFacet`), so tier 0 there is a never-reached fail-safe the
    ///      gating site should already have rejected; and (2) a LIQUID-but-thin
    ///      asset (post-#1007: clears the $5k floor but not the $50k Tier-1
    ///      probe) legitimately sits at tier 0 and `LibRiskMath` uses this
    ///      threshold as its REAL HF bound. Either way tier 0 returns Tier-1
    ///      (the most conservative, 80% — post-#999 flip).
    function cfgTierLiquidationLtvBps(uint8 tier) internal view returns (uint256) {
        // #999 (S1) — tier 0 is the "untierable" / thinnest bucket (an asset that
        // can't clear the $5k floor, or post-#1007 the $50k tier-1 probe). It must
        // get the MOST CONSERVATIVE (lowest) threshold. Pre-#999 this aliased to
        // Tier 3, which was correct only while Tier 3 was the low end (80%) under
        // the inverted gradient; after the flip Tier 3 is the HIGHEST (90%), so
        // tier 0 now aliases to Tier 1 (the new conservative low, 80%). Leaving it
        // on Tier 3 would hand the thinnest collateral a 90% threshold — the exact
        // bad-debt shape #999 removes.
        if (tier == 0) return cfgTier1LiquidationLtvBps();
        if (tier == 1) return cfgTier1LiquidationLtvBps();
        if (tier == 2) return cfgTier2LiquidationLtvBps();
        if (tier == 3) return cfgTier3LiquidationLtvBps();
        revert IVaipakamErrors.ParameterOutOfRange(
            "liquidityTier", uint256(tier), 0, uint256(MAX_LIQUIDITY_TIER)
        );
    }

    /// @dev Internal-liquidation match path (B.2) — kill-switch flag.
    function cfgInternalMatchEnabled() internal view returns (bool) {
        return storageSlot().protocolCfg.internalMatchEnabled;
    }

    /// @dev #393 v1 — LenderIntentVault standing-intent fill path kill-switch.
    function cfgLenderIntentEnabled() internal view returns (bool) {
        return storageSlot().protocolCfg.lenderIntentEnabled;
    }

    /// @dev #399 backstop v0 — master backstop pause (both roles).
    function cfgBackstopEnabled() internal view returns (bool) {
        return storageSlot().protocolCfg.backstopEnabled;
    }

    /// @dev #399 backstop v0 — Role A (auto-counterparty) kill-switch.
    function cfgBackstopFillEnabled() internal view returns (bool) {
        return storageSlot().protocolCfg.backstopFillEnabled;
    }

    /// @dev #399 backstop v0 — Role B (liquidator-of-last-resort) kill-switch.
    function cfgBackstopAbsorbEnabled() internal view returns (bool) {
        return storageSlot().protocolCfg.backstopAbsorbEnabled;
    }

    /// @dev #633 — aggregator-adapter (#398) feature pause (default false=active).
    function cfgAggregatorAdaptersPaused() internal view returns (bool) {
        return storageSlot().protocolCfg.aggregatorAdaptersPaused;
    }

    /// @dev #633 — global delegated-keeper pause (default false=active).
    function cfgKeepersPaused() internal view returns (bool) {
        return storageSlot().protocolCfg.keepersPaused;
    }

    /// @dev #633 — peer-protocol LTV reads pause (default false=active).
    function cfgPeerLtvReadsPaused() internal view returns (bool) {
        return storageSlot().protocolCfg.peerLtvReadsPaused;
    }

    /// @dev #399 backstop v0 — mandatory min seconds before an offer's
    ///      `backstopEligibleAfter` may fire; 0 ⇒ `BACKSTOP_MIN_DELAY_DEFAULT`.
    function cfgMinBackstopDelay() internal view returns (uint64) {
        uint64 v = storageSlot().protocolCfg.minBackstopDelay;
        return v == 0 ? BACKSTOP_MIN_DELAY_DEFAULT : v;
    }

    /// @dev #399 backstop v0 — the provisioned treasury BackstopVault (0 = unset).
    function getBackstopVault() internal view returns (address) {
        return storageSlot().backstopVault;
    }

    /// @dev #577 / #585 — true when a FallbackPending loan still carries a
    ///      vault-held AddCollateral top-up: an active (non-released)
    ///      collateral lien. At fallback the original collateral moves to
    ///      Diamond custody and its lien is released; a non-curing
    ///      `AddCollateral` on the still-FallbackPending loan lands the top-up
    ///      in the borrower's vault and seeds a fresh active lien sized to that
    ///      vault portion (`AddCollateralFacet` accepts FallbackPending). Every
    ///      claim-time / liquidation mechanism that draws
    ///      `loan.collateralAmount` from Diamond custody — internal match and
    ///      the claim-time retry swap — would then mis-account the vault-held
    ///      top-up, drawing on same-token Diamond custody belonging to OTHER
    ///      fallback loans. Such a loan is therefore ineligible for internal
    ///      matching (rejected at the trigger gate / skipped by auto-dispatch /
    ///      filtered out of candidate scans) and for retry swaps, until the
    ///      top-up-aware unwind lands (#585); it resolves safely through the
    ///      in-kind fallback distribution, which only touches the snapshot
    ///      (the Diamond-held portion) and leaves the vault top-up liened.
    ///      Shared by `RiskMatchLiquidationFacet`, `MetricsFacet`, and
    ///      `ClaimFacet` so the "topped-up" definition lives in one place.
    ///      ERC-20-only (the lien is ERC-20-gated per D-1), so a non-zero lien
    ///      is always the ERC-20 top-up.
    function hasActiveFallbackTopUp(uint256 loanId) internal view returns (bool) {
        Storage storage s = storageSlot();
        if (s.loans[loanId].status != LoanStatus.FallbackPending) return false;
        Encumbrance storage lien = s.loanCollateralLien[loanId];
        return !lien.released && lien.amount > 0;
    }

    /// @dev #591 — the collateral a loan can contribute to an internal match
    ///      (the "Diamond-matchable" portion). For a topped-up FallbackPending
    ///      loan the AddCollateral top-up sits in the borrower's vault (liened),
    ///      NOT in Diamond custody, so only `collateralAmount − lien.amount`
    ///      (the at-fallback snapshot still in Diamond) may be matched; matching
    ///      against the full `collateralAmount` would over-draw Diamond custody.
    ///      For every other loan it is the full `collateralAmount`.
    ///
    ///      CRITICAL (Codex #605 P1): this can be `0` while `collateralAmount`
    ///      stays `> 0` — a topped-up FallbackPending loan whose Diamond
    ///      snapshot was fully consumed by an earlier partial match still
    ///      carries the vault top-up. Such a leg has NOTHING to contribute, so
    ///      every internal-match eligibility gate treats `== 0` as
    ///      non-matchable; otherwise it would receive a one-sided match that
    ///      drains the counterparty's collateral with no reciprocal debt
    ///      reduction. Single source of truth for `RiskMatchLiquidationFacet`
    ///      (leg sizing + gate) and `MetricsFacet` (candidate scan).
    function internalMatchableCollateral(uint256 loanId) internal view returns (uint256) {
        Storage storage s = storageSlot();
        Loan storage loan = s.loans[loanId];
        if (loan.status == LoanStatus.FallbackPending) {
            Encumbrance storage lien = s.loanCollateralLien[loanId];
            if (!lien.released && lien.amount > 0) {
                // Diamond portion = snapshot total = collateralAmount − top-up.
                return loan.collateralAmount - lien.amount;
            }
        }
        return loan.collateralAmount;
    }

    /// @dev Internal-liquidation match path (B.2) — global LTV
    ///      window above each loan's per-tier liquidation threshold
    ///      where external `triggerLiquidation` is gated to give
    ///      internal matchers a clean priority slot. `0` ⇒ default
    ///      200 BPS (2% LTV).
    function cfgExternalLiquidationPriorityWindowBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.externalLiquidationPriorityWindowBps;
        return v == 0
            ? uint256(DEFAULT_EXTERNAL_LIQUIDATION_PRIORITY_WINDOW_BPS)
            : uint256(v);
    }

    /// @dev Internal-liquidation match path (B.2) — bot incentive,
    ///      in BPS, withheld from each matched leg's transferred
    ///      collateral. `0` ⇒ default 100 BPS (1% per leg).
    function cfgInternalMatchIncentivePerLegBps() internal view returns (uint256) {
        uint16 v = storageSlot().protocolCfg.internalMatchIncentivePerLegBps;
        return v == 0
            ? uint256(DEFAULT_INTERNAL_MATCH_INCENTIVE_BPS_PER_LEG)
            : uint256(v);
    }

    /// @dev T-600 — per-token numeraire-value (1e18) accumulation
    ///      threshold that makes a treasury conversion eligible.
    function cfgTreasuryConvertUsdThreshold() internal view returns (uint256) {
        uint256 v = storageSlot().protocolCfg.treasuryConvertUsdThreshold;
        return v == 0 ? TREASURY_CONVERT_USD_THRESHOLD_DEFAULT : v;
    }

    /// @dev T-600 — max days between treasury conversions (time leg of
    ///      the eligibility gate).
    function cfgTreasuryConvertMaxIntervalDays() internal view returns (uint256) {
        uint32 v = storageSlot().protocolCfg.treasuryConvertMaxIntervalDays;
        return v == 0
            ? uint256(TREASURY_CONVERT_MAX_INTERVAL_DAYS_DEFAULT)
            : uint256(v);
    }

    /// @dev Keeper liquidity-confidence tier for `asset` — stored `0`
    ///      reads as `KEEPER_TIER_DEFAULT` (= Tier 1) so an asset the
    ///      relay hasn't touched opens at today's `HF ≥ 1.5` baseline.
    ///      Pair with `OracleFacet.getLiquidityTier` for the effective
    ///      tier: `min(onChainTier, effectiveKeeperTier)`.
    function effectiveKeeperTier(address asset) internal view returns (uint8) {
        uint8 v = storageSlot().keeperTier[asset];
        return v == 0 ? KEEPER_TIER_DEFAULT : v;
    }

    /// @dev The "predominantly available assets" the liquidity check
    ///      probes pools against (see `Storage.paaAssets`). Empty
    ///      config ⇒ `[wethContract]` — so an un-configured deploy
    ///      behaves like today's WETH-only probe. Returns a fresh
    ///      memory array; callers must tolerate a single-element fallback
    ///      (and a zero element if `wethContract` itself is unset, which
    ///      `OracleFacet` already skips).
    function effectivePaaAssets() internal view returns (address[] memory) {
        Storage storage s = storageSlot();
        uint256 n = s.paaAssets.length;
        if (n == 0) {
            address[] memory one = new address[](1);
            one[0] = s.wethContract;
            return one;
        }
        address[] memory out = new address[](n);
        for (uint256 i; i < n; ++i) out[i] = s.paaAssets[i];
        return out;
    }

    /// @dev Returns the four tier thresholds (T1 min, T2 min, T3 min, T4 min-exclusive).
    function cfgVpfiTierThresholds()
        internal
        view
        returns (uint256 t1, uint256 t2, uint256 t3, uint256 t4Excl)
    {
        ProtocolConfig storage c = storageSlot().protocolCfg;
        t1 = c.vpfiTier1Min == 0 ? VPFI_TIER1_MIN : c.vpfiTier1Min;
        t2 = c.vpfiTier2Min == 0 ? VPFI_TIER2_MIN : c.vpfiTier2Min;
        t3 = c.vpfiTier3Min == 0 ? VPFI_TIER3_MIN : c.vpfiTier3Min;
        t4Excl = c.vpfiTier4Threshold == 0
            ? VPFI_TIER4_THRESHOLD
            : c.vpfiTier4Threshold;
    }

    /// @dev Discount BPS for a tier index 1..4. Tier 0 is always zero.
    function cfgVpfiTierDiscountBps(
        uint8 tier
    ) internal view returns (uint256) {
        if (tier == 0) return 0;
        ProtocolConfig storage c = storageSlot().protocolCfg;
        if (tier == 4)
            return
                c.vpfiTier4DiscountBps == 0
                    ? VPFI_TIER4_DISCOUNT_BPS
                    : uint256(c.vpfiTier4DiscountBps);
        if (tier == 3)
            return
                c.vpfiTier3DiscountBps == 0
                    ? VPFI_TIER3_DISCOUNT_BPS
                    : uint256(c.vpfiTier3DiscountBps);
        if (tier == 2)
            return
                c.vpfiTier2DiscountBps == 0
                    ? VPFI_TIER2_DISCOUNT_BPS
                    : uint256(c.vpfiTier2DiscountBps);
        if (tier == 1)
            return
                c.vpfiTier1DiscountBps == 0
                    ? VPFI_TIER1_DISCOUNT_BPS
                    : uint256(c.vpfiTier1DiscountBps);
        return 0;
    }

    /// @dev Duration-tiered grace period used by DefaultedFacet, RepayFacet,
    ///      RiskFacet. T-044 made the schedule admin-configurable; when
    ///      `Storage.graceBuckets` is empty (the post-deploy default) this
    ///      function falls back to the original compile-time schedule
    ///      below, extended with a new ≥ 365 days bucket per T-044's spec.
    ///
    ///      Default schedule (used when `graceBuckets.length == 0`):
    ///        durationDays < 7    → 1 hour
    ///        durationDays < 30   → 1 day
    ///        durationDays < 90   → 3 days
    ///        durationDays < 180  → 1 week
    ///        durationDays < 365  → 2 weeks
    ///        durationDays >= 365 → 30 days   (T-044 — new bucket)
    ///
    ///      Configured-array semantics: walk buckets in storage order; the
    ///      first bucket whose `maxDurationDays > durationDays` wins. The
    ///      final bucket carries `maxDurationDays == 0` as the catch-all
    ///      marker. Setter validation (see ConfigFacet.setGraceBuckets)
    ///      guarantees the array is sorted, monotonic, and fully bounded.
    ///
    ///      Note: this used to be `pure`. T-044 changed it to `view`
    ///      because it now reads `s.graceBuckets`. Every existing caller
    ///      is `view` or `nonpayable` — no signature impact downstream.
    /// @param durationDays Loan duration in days.
    /// @return grace Grace period in seconds.
    function gracePeriod(
        uint256 durationDays
    ) internal view returns (uint256 grace) {
        GraceBucket[] storage buckets = storageSlot().graceBuckets;
        uint256 len = buckets.length;
        if (len == 0) {
            // Compile-time default schedule (T-044 extended).
            if (durationDays < 7) return 1 hours;
            if (durationDays < 30) return 1 days;
            if (durationDays < 90) return 3 days;
            if (durationDays < 180) return 1 weeks;
            if (durationDays < 365) return 2 weeks;
            return 30 days;
        }
        // Storage-driven path. Last entry's maxDurationDays == 0 marks
        // the catch-all; any bucket whose threshold strictly exceeds
        // durationDays wins, walked in array order.
        for (uint256 i = 0; i < len; i++) {
            uint256 maxD = buckets[i].maxDurationDays;
            if (maxD == 0) return buckets[i].graceSeconds;
            if (durationDays < maxD) return buckets[i].graceSeconds;
        }
        // Defensive fallback — setter validation prevents reaching here
        // (every valid array ends in a maxDurationDays == 0 catch-all),
        // but if storage is somehow malformed return the last entry's
        // grace rather than reverting.
        return buckets[len - 1].graceSeconds;
    }

    /// @notice T-086 Round-7 (Issue #355) — canonical "is loan in its
    ///         grace window" predicate: `loanEnd <= block.timestamp <
    ///         gracePeriodEnd`. Used by `cancelPrepayListing` (sets the
    ///         auto-list opt-out flag only on grace-window cancels)
    ///         and by `autoListAtFloorOnGrace` (revert outside the
    ///         window). Pulling the comparison into a single helper
    ///         avoids the off-by-one risk of duplicating the
    ///         `>=`/`<` pair at every call site.
    /// @dev    `loanEnd = loan.startTime + loan.durationDays × 1 days`;
    ///         `gracePeriodEnd = loanEnd + gracePeriod(durationDays)`.
    ///         The lower bound is inclusive (`>=`) because the loan is
    ///         "in grace" the moment it crosses its repayment deadline;
    ///         the upper bound is exclusive (`<`) because
    ///         `DefaultedFacet.markDefaulted` runs at strict equality
    ///         `block.timestamp == gracePeriodEnd` (Codex round-1 P3
    ///         fix on PR #356).
    function isGraceWindow(Loan storage loan) internal view returns (bool) {
        uint256 loanEnd = uint256(loan.startTime) + (uint256(loan.durationDays) * 1 days);
        uint256 gracePeriodEnd = loanEnd + gracePeriod(loan.durationDays);
        return block.timestamp >= loanEnd && block.timestamp < gracePeriodEnd;
    }

    /// @notice Pass-2 D1 (#1188) — a rental loan's REMAINING prepaid days.
    /// @dev    Rental amortisation (`autoDeductDaily`, rental `repayPartial`)
    ///         keeps `durationDays` IMMUTABLE (the origination term, so
    ///         `startTime + durationDays × 1 day` stays the fixed maturity every
    ///         consumer already relies on — the #641 "term tuple is fixed"
    ///         convention). Days consumed are tracked by `lastDeductTime`, which
    ///         advances by one day per auto-deduction (and by `partialAmount`
    ///         days per rental partial). Remaining = term − consumed. Non-rental
    ///         loans never advance `lastDeductTime` past `startTime`, so this
    ///         returns the full `durationDays` for them.
    /// @notice Pass-2 D1 (#1188) — rental days ALREADY consumed, tracked by
    ///         `lastDeductTime` advancing (auto-deduct: +1/day; rental partial:
    ///         +partialAmount days).
    /// @dev    Guarded: a loan whose `lastDeductTime` was never advanced past
    ///         `startTime` (init sets it to `startTime`; a legacy/imported loan
    ///         may have 0) has consumed nothing — `lastDeductTime <= startTime`
    ///         ⇒ 0, rather than underflowing. This is the single guarded
    ///         consumed-days derivation every caller should use.
    function consumedRentalDays(Loan storage loan) internal view returns (uint256) {
        uint256 ldt = uint256(loan.lastDeductTime);
        uint256 st = uint256(loan.startTime);
        return ldt > st ? (ldt - st) / 1 days : 0;
    }

    /// @notice Pass-2 D1 (#1188) — a rental loan's REMAINING prepaid days
    ///         = immutable term − consumed. Non-rental loans never advance
    ///         `lastDeductTime`, so this returns the full `durationDays`.
    /// @dev    ASSUMES `durationDays` is the IMMUTABLE origination term (the
    ///         D1 model). Loans created after the D1 upgrade satisfy this;
    ///         mainnet rollouts are always fresh (no pre-upgrade rentals carry
    ///         over — see RefreshAllFacetsInPlace policy), so the derivation is
    ///         exact there.
    function remainingRentalDays(Loan storage loan) internal view returns (uint256) {
        uint256 consumed = consumedRentalDays(loan);
        // Clamp so a view can never revert even if consumed overruns the term.
        return consumed >= uint256(loan.durationDays) ? 0 : uint256(loan.durationDays) - consumed;
    }

    /// @notice #641 — a loan's interest-accrual ORIGIN: the dedicated
    ///         `interestAccrualStart` clock (re-stamped by a partial WITHOUT
    ///         moving the term/maturity), falling back to the immutable
    ///         `startTime` for loans that predate the field. The canonical
    ///         accessor every interest computation (in `LibEntitlement` AND the
    ///         inline ones in Preclose / EarlyWithdrawal / AutoLifecycle /
    ///         Defaulted / Refinance) reads, so a partial's reduced-principal
    ///         re-anchor is honoured everywhere. `interestAccrualStart` is set
    ///         to a real timestamp at origination, so `!= 0` cleanly tells a
    ///         post-#641 loan (use the clock, even if `interestRemainingDays`
    ///         legitimately reached 0) from a legacy one.
    function interestAccrualStartOf(Loan storage loan) internal view returns (uint256) {
        return loan.interestAccrualStart != 0
            ? uint256(loan.interestAccrualStart)
            : uint256(loan.startTime);
    }

    /// @notice #641 — a loan's REMAINING interest term in days: the dedicated
    ///         `interestRemainingDays` (re-stamped by a partial), falling back
    ///         to the immutable `durationDays` for pre-field loans. Gated on
    ///         `interestAccrualStart` (NOT `interestRemainingDays != 0`) so a
    ///         post-#641 loan whose remaining term reached 0 isn't mistaken for
    ///         legacy.
    function interestRemainingDaysOf(Loan storage loan) internal view returns (uint256) {
        return loan.interestAccrualStart != 0
            ? uint256(loan.interestRemainingDays)
            : loan.durationDays;
    }

    /// @notice #641 — seed the interest clock from the term for a loan that
    ///         predates the fields, BEFORE the first partial re-stamps it. A
    ///         no-op for loans originated with the clock set. Called at the head
    ///         of every interest-clock re-stamp (partial liquidation, partial
    ///         repay, swap-to-repay) so a legacy loan's first partial doesn't
    ///         compute elapsed from timestamp 0 and zero out the remaining term.
    function seedInterestClockIfUnset(Loan storage loan) internal {
        if (loan.interestAccrualStart == 0) {
            loan.interestAccrualStart = loan.startTime;
            loan.interestRemainingDays = uint16(loan.durationDays);
        }
    }

    /// @notice T-034 — interval-in-days lookup for a cadence enum value.
    /// @dev Pure helper (no storage reads) so callers can fold it inline
    ///      cheaply. Returns 0 for `None` (the no-cadence sentinel) so
    ///      arithmetic that adds the result to a timestamp short-circuits
    ///      to "no checkpoint" automatically. See
    ///      docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md §2.4.
    function intervalDays(
        PeriodicInterestCadence cadence
    ) internal pure returns (uint256) {
        if (cadence == PeriodicInterestCadence.Monthly)
            return PERIODIC_INTERVAL_MONTHLY_DAYS;
        if (cadence == PeriodicInterestCadence.Quarterly)
            return PERIODIC_INTERVAL_QUARTERLY_DAYS;
        if (cadence == PeriodicInterestCadence.SemiAnnual)
            return PERIODIC_INTERVAL_SEMI_ANNUAL_DAYS;
        if (cadence == PeriodicInterestCadence.Annual)
            return PERIODIC_INTERVAL_ANNUAL_DAYS;
        return 0; // None
    }

    /// @notice External view exposing the current grace-bucket schedule.
    ///         Returns an empty array when storage is unconfigured (the
    ///         compile-time defaults in `gracePeriod()` are in force).
    /// @dev Read by the admin console's GraceBucketsCard via
    ///      ConfigFacet.getGraceBuckets — kept here as a library helper
    ///      so callers don't have to know storage layout.
    function getGraceBucketsConfigured()
        internal
        view
        returns (GraceBucket[] memory)
    {
        return storageSlot().graceBuckets;
    }

    /// @notice Per-slot policy bounds for the fixed 6-slot grace schedule
    ///         (T-044). Returns the inclusive bounds the setter validates
    ///         each slot against; the admin console reads the same view
    ///         to render per-row min/max hints.
    ///
    ///         Slot semantics:
    ///         | Slot | Default tier | maxDays bounds | grace bounds |
    ///         |------|--------------|----------------|--------------|
    ///         | 0    | < 7 days     | [1, 14]        | [1h,  5d]    |
    ///         | 1    | < 30 days    | [7, 60]        | [1h, 15d]    |
    ///         | 2    | < 90 days    | [30, 180]      | [1d, 30d]    |
    ///         | 3    | < 180 days   | [90, 270]      | [3d, 45d]    |
    ///         | 4    | < 365 days   | [180, 540]     | [7d, 60d]    |
    ///         | 5    | catch-all    | (must == 0)    | [14d, 90d]   |
    ///
    /// @param slot 0-indexed slot id (must be < GRACE_BUCKETS_FIXED_COUNT).
    /// @return minDays Lower bound on `maxDurationDays` for this slot.
    ///         For slot 5 (catch-all) returns 0 to indicate the only
    ///         legal value is 0.
    /// @return maxDays Upper bound on `maxDurationDays`. For slot 5
    ///         returns 0 to enforce the catch-all marker.
    /// @return minGrace Lower bound on `graceSeconds` for this slot.
    /// @return maxGrace Upper bound on `graceSeconds` for this slot.
    function graceSlotBounds(
        uint256 slot
    )
        internal
        pure
        returns (
            uint256 minDays,
            uint256 maxDays,
            uint256 minGrace,
            uint256 maxGrace
        )
    {
        if (slot == 0) return (1, 14, 1 hours, 5 days);
        if (slot == 1) return (7, 60, 1 hours, 15 days);
        if (slot == 2) return (30, 180, 1 days, 30 days);
        if (slot == 3) return (90, 270, 3 days, 45 days);
        if (slot == 4) return (180, 540, 7 days, 60 days);
        if (slot == 5) return (0, 0, 14 days, 90 days);
        revert("graceSlotBounds: slot out of range");
    }

    /// @dev Late fee schedule: 1% on the first day past due, +0.5% each
    ///      subsequent day, capped at 5% of principal. Returns 0 when the
    ///      loan is still within `endTime`.
    /// @param loanId  Loan id.
    /// @param endTime Unix timestamp at which the loan's duration expires.
    /// @return fee    Late fee in principal units (BPS-scaled).
    function calculateLateFee(
        uint256 loanId,
        uint256 endTime
    ) internal view returns (uint256 fee) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        if (block.timestamp <= endTime) return 0;

        uint256 daysLate = (block.timestamp - endTime) / 1 days;
        uint256 feePercent = 100 + (daysLate * 50); // 1% + 0.5% per day (in basis points)
        if (feePercent > 500) feePercent = 500; // Cap 5%

        return (loan.principal * feePercent) / 10000; // Basis points
    }

    /// @dev NFT-rental late fee (#998 S8 / #1004). The shared
    ///      {calculateLateFee} bases the fee on `loan.principal`, which is
    ///      correct for an ERC-20 loan (whole principal) but wrong for a
    ///      rental — there `loan.principal` is the PER-DAY fee, so the fee
    ///      never scaled with the size of the overdue obligation. This
    ///      rental variant bases the fee on the REMAINING OWED RENTAL
    ///      `principal × durationDays`. `durationDays` is the live remaining
    ///      term, retired by BOTH `autoDeductDaily` and `repayPartial`
    ///      (term-retirement semantics), so it faithfully tracks the overdue
    ///      rent with no separate paid-days counter.
    ///
    ///      The fee is capped two ways: the historical 5% penalty ceiling on
    ///      the slope, AND — load-bearingly — clamped to the loan's OWN
    ///      pre-funded `bufferAmount`. The clamp reads the per-loan
    ///      `loan.bufferAmount` (snapshotted at origination) rather than the
    ///      live `rentalBufferBps` config: a rental opened while the config was
    ///      below 5% pre-funded a smaller buffer, and if governance later
    ///      raised the config a live-config cap would compute a fee the buffer
    ///      can't cover, reverting `InsufficientPrepay` and bricking the very
    ///      close-out this protects (Codex #1096 P1). Clamping to the actual
    ///      pre-funded buffer guarantees `fee <= bufferAmount` under ANY later
    ///      config change — RepayFacet funds the rental late fee from
    ///      `bufferAmount`.
    /// @param loanId  Rental loan id.
    /// @param endTime Unix timestamp at which the rental term expires.
    /// @return fee    Late fee in prepay-asset units.
    function calculateRentalLateFee(
        uint256 loanId,
        uint256 endTime
    ) internal view returns (uint256 fee) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        if (block.timestamp <= endTime) return 0;

        uint256 daysLate = (block.timestamp - endTime) / 1 days;
        uint256 feePercent = 100 + (daysLate * 50); // 1% + 0.5% per day
        if (feePercent > 500) feePercent = 500; // historical 5% penalty ceiling

        // Pass-2 D1 (#1188) — base the fee on the REMAINING owed rental days
        // (`remainingRentalDays`), not the now-immutable `durationDays` term,
        // so a partially-serviced rental isn't penalised on already-paid days.
        fee = (loan.principal * remainingRentalDays(loan) * feePercent) / 10000;

        // Clamp to the loan's ACTUAL pre-funded buffer (per-loan snapshot, not
        // the mutable global config), so the buffer always covers the fee.
        if (fee > loan.bufferAmount) fee = loan.bufferAmount;
    }

    /**
     * @notice Sets trade allowance between two countries (owner-only).
     * @dev Bidirectional by default (sets both A->B and B->A); for asymmetric, call twice.
     *      Uses keccak256 for string hashing to save gas.
     *      Callable via a facet (e.g., ProfileFacet) by Diamond owner.
     * @param countryA ISO code for country A.
     * @param countryB ISO code for country B.
     * @param allowed True to allow trade, false to block.
     */
    function setTradeAllowance(
        string memory countryA,
        string memory countryB,
        bool allowed
    ) internal {
        // Access control enforced by calling facet via onlyRole modifier
        Storage storage s = storageSlot();
        bytes32 hashA = keccak256(bytes(countryA));
        bytes32 hashB = keccak256(bytes(countryB));
        s.allowedTrades[hashA][hashB] = allowed;
        s.allowedTrades[hashB][hashA] = allowed; // Bidirectional; remove if asymmetric needed
    }

    /**
     * @notice Checks if two countries can trade.
     * @dev PHASE 1 BEHAVIOR: country-pair restrictions are disabled at the
     *      protocol level. This always returns `true` regardless of the
     *      `allowedTrades` mapping, so any two users may transact
     *      irrespective of the countries stored on their profiles. The
     *      mapping and its setter {setTradeAllowance} are preserved so
     *      governance can re-activate pair-based sanctions in Phase 2
     *      without a storage migration — callers should treat the return
     *      value as load-bearing even though it's a no-op today.
     *      (silences unused-parameter warnings — `countryA` / `countryB`
     *      are read in the Phase-2 branch below.)
     * @param countryA ISO code for country A.
     * @param countryB ISO code for country B.
     * @return canTrade Always `true` in Phase 1.
     */
    function canTradeBetween(
        string memory countryA,
        string memory countryB
    ) internal pure returns (bool canTrade) {
        countryA;
        countryB;
        return true;
    }

    /**
     * @notice Gated, default-DENY country-pair check. Returns `true` only
     *         when governance has explicitly whitelisted the pair via
     *         {setTradeAllowance}; an unset entry (and self-trade) is
     *         denied.
     * @dev    NOT used by the retail Vaipakam deploy. The retail flow goes
     *         through {canTradeBetween} which is hardcoded to `true`.
     *         This helper exists for two reasons:
     *           1. The industrial-fork variant of the protocol switches
     *              the gate on without a storage-layout migration; that
     *              fork's facets call this function instead of the pure
     *              one.
     *           2. Test coverage: `CountryPairGatedTest` exercises the
     *              storage-driven semantics (whitelist, symmetry, missing
     *              pair => deny) so the gated branch stays truthful even
     *              while it's dormant on retail.
     *         Both helpers share the same `s.allowedTrades` storage —
     *         {setTradeAllowance} writes are visible to both, so the
     *         retail deploy can ship pre-populated whitelists for a
     *         later cutover without rewriting the setter API.
     * @param  countryA ISO-3166 alpha-2 / alpha-3 code (whatever the
     *         operator standardised on; comparison is keccak-by-bytes).
     * @param  countryB Same encoding as `countryA`.
     * @return canTrade  `true` iff `s.allowedTrades[hashA][hashB]` is set.
     */
    function _canTradeBetweenStorageGated(
        string memory countryA,
        string memory countryB
    ) internal view returns (bool canTrade) {
        Storage storage s = storageSlot();
        bytes32 hashA = keccak256(bytes(countryA));
        bytes32 hashB = keccak256(bytes(countryB));
        return s.allowedTrades[hashA][hashB];
    }

    /// @dev Set the Chainlink Feed Registry USD denominator. Owner-only.
    ///      Setting to `address(0)` forces {OracleFacet.getAssetPrice} down
    ///      the NoPriceFeed branch.
    /// @param newUsdChainlinkDenominator USD-denominator address registered
    ///        in the Chainlink Feed Registry (typically the canonical USD
    ///        pseudo-address).
    function setUsdChainlinkDenominator(
        address newUsdChainlinkDenominator
    ) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        s.numeraireChainlinkDenominator = newUsdChainlinkDenominator;
    }

    /// @dev Set the Chainlink Feed Registry contract used by OracleFacet.
    ///      Owner-only. Setting to `address(0)` disables price lookups.
    /// @param newChainlnkRegistry Chainlink Feed Registry contract address.
    function setChainlinkRegistry(address newChainlnkRegistry) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        s.chainlnkRegistry = newChainlnkRegistry;
    }

    /// @dev Set the canonical WETH ERC-20 used by OracleFacet as the
    ///      v3-style AMM pool-depth quote asset. Owner-only. Setting to
    ///      `address(0)` fail-closes every asset to Illiquid.
    /// @param newWethContract WETH ERC-20 contract address on the active
    ///        network.
    function setWethContract(address newWethContract) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        s.wethContract = newWethContract;
    }

    /// @dev Set the direct Chainlink ETH/USD AggregatorV3 feed. Owner-only.
    ///      REQUIRED — used by OracleFacet to price WETH itself and to
    ///      convert asset/WETH pool depth into USD. Setting to `address(0)`
    ///      disables every ETH-quoted code path (WETH pricing, depth
    ///      conversion, asset/ETH fallback price).
    /// @param newEthUsdFeed Chainlink ETH/USD aggregator contract address.
    function setEthUsdFeed(address newEthUsdFeed) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        s.ethNumeraireFeed = newEthUsdFeed;
    }

    /// @dev Set the Chainlink Feed Registry ETH-denominator pseudo-address
    ///      used by OracleFacet's asset/ETH fallback price path. Owner-only.
    ///      Zero on L2s where the Feed Registry does not exist —
    ///      disables the ETH-route fallback (assets without a direct
    ///      asset/USD feed revert NoPriceFeed).
    /// @param newEthChainlinkDenominator ETH-denominator address recognised
    ///        by the Chainlink Feed Registry.
    function setEthChainlinkDenominator(
        address newEthChainlinkDenominator
    ) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        s.ethChainlinkDenominator = newEthChainlinkDenominator;
    }

    /// @dev Register / replace / deregister a fiat or commodity peg
    ///      reference feed for OracleFacet's generalized peg-aware stable
    ///      staleness branch. Owner-only. `symbol` is the short ticker
    ///      ("USD" — implicit, do not register; "EUR", "JPY", "XAU",
    ///      "GBP", etc.), case-sensitive and up to 32 bytes.
    ///
    ///      Semantics:
    ///        - feed != 0 and symbol unknown → append to registry
    ///        - feed != 0 and symbol known   → update reference feed
    ///        - feed == 0 and symbol known   → remove via swap-and-pop
    ///        - feed == 0 and symbol unknown → no-op
    /// @param symbol Short fiat / commodity ticker (e.g. "EUR").
    /// @param feed   Chainlink aggregator for `<symbol>/USD` (8 decimals).
    function setStableTokenFeed(string memory symbol, address feed) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        // safe: stable-feed symbols are bounded by `MAX_STABLE_SYMBOL_LEN`
        // = 10 in `OracleAdminFacet.setStableTokenFeed` (the only call
        // site that flows here); the symbol's bytes are guaranteed ≤10,
        // well under bytes32's 32-byte limit.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes32 key = bytes32(bytes(symbol));
        uint256 pos = s.stableFeedSymbolPos[key];
        if (feed == address(0)) {
            if (pos == 0) return;
            uint256 lastIdx = s.stableFeedSymbolsList.length - 1;
            uint256 idx = pos - 1;
            if (idx != lastIdx) {
                bytes32 last = s.stableFeedSymbolsList[lastIdx];
                s.stableFeedSymbolsList[idx] = last;
                s.stableFeedSymbolPos[last] = idx + 1;
            }
            s.stableFeedSymbolsList.pop();
            delete s.stableFeedSymbolPos[key];
            delete s.stableFeedBySymbol[key];
            return;
        }
        s.stableFeedBySymbol[key] = feed;
        if (pos == 0) {
            s.stableFeedSymbolsList.push(key);
            s.stableFeedSymbolPos[key] = s.stableFeedSymbolsList.length;
        }
    }

    /// @dev Set the v3-style AMM factory used by OracleFacet's liquidity
    ///      classification. Owner-only. Setting to `address(0)` fail-closes
    ///      every asset to Illiquid.
    /// @param newUniswapV3Factory v3-style AMM factory contract address.
    function setUniswapV3Factory(address newUniswapV3Factory) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        s.uniswapV3Factory = newUniswapV3Factory;
    }

    /// @dev Set the Chainlink l2 Sequencer Uptime feed used by
    ///      OracleFacet as a circuit breaker before every price read.
    ///      Owner-only. Setting to `address(0)` disables the check —
    ///      correct for l1/Ethereum mainnet where no sequencer exists.
    ///      On L2s (Base/Arb/OP) this MUST be set to the canonical
    ///      sequencer uptime feed at deploy time.
    /// @param newFeed Chainlink l2 Sequencer Uptime feed address.
    function setSequencerUptimeFeed(address newFeed) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        s.sequencerUptimeFeed = newFeed;
    }

    /// @notice Emitted whenever a per-feed oracle override is installed or
    ///         cleared. Off-chain monitoring watches this so a governance-
    ///         driven freshness tightening is publicly observable.
    /// @param feed           Chainlink aggregator address the override
    ///                       applies to.
    /// @param maxStaleness   New max age in seconds (0 = cleared).
    /// @param minValidAnswer New minimum-valid-answer floor (0/negative =
    ///                       no floor).
    /// @custom:event-category informational/config
    event FeedOverrideSet(
        address indexed feed,
        uint40 maxStaleness,
        int256 minValidAnswer
    );

    /// @notice Emitted on every change to the autonomous tier-LTV
    ///         peer-protocol read addresses (Phase 3 of
    ///         AutonomousLtvAndOracleFallback.md). Off-chain monitoring
    ///         watches this so a governance change is publicly
    ///         observable.
    /// @custom:event-category informational/config
    event PeerProtocolAddressesSet(
        address aaveV3PoolDataProvider,
        address compoundV3Comet,
        address morphoBlue
    );

    /// @notice Emitted on every change to a tier's reference asset
    ///         list (Phase 4 of AutonomousLtvAndOracleFallback.md).
    ///         Constitution-level setting; off-chain monitoring
    ///         watches for governance changes.
    /// @custom:event-category informational/config
    event TierReferenceAssetsSet(uint8 indexed tier, address[] assets);

    /// @dev Per-tier safety-box bounds. Tier indices 1, 2, 3 (Tier 0
    ///      is "untierable" — no LTV cap applies because the asset
    ///      isn't accepted at all).
    ///
    ///      Phase 7 of AutonomousLtvAndOracleFallback.md — reads
    ///      governance overrides from `s.tierLtvParams[tier]` if set
    ///      (non-zero ceil = "configured" indicator); otherwise falls
    ///      through to the library constants. The constants stay
    ///      authoritative on a fresh deploy and after a hypothetical
    ///      governance "clear" (no clear API exists; governance
    ///      effectively-clears by setting back to the constants).
    function tierLtvBoundsBps(uint8 tier)
        internal
        view
        returns (uint16 floorBps, uint16 ceilBps)
    {
        if (tier == 0 || tier > MAX_LIQUIDITY_TIER) return (0, 0);
        TierLtvParams storage p = storageSlot().tierLtvParams[tier];
        if (p.ceilBps != 0) {
            return (p.floorBps, p.ceilBps);
        }
        if (tier == 1) return (TIER1_LTV_FLOOR_BPS, TIER1_LTV_CEIL_BPS);
        if (tier == 2) return (TIER2_LTV_FLOOR_BPS, TIER2_LTV_CEIL_BPS);
        return (TIER3_LTV_FLOOR_BPS, TIER3_LTV_CEIL_BPS);
    }

    /// @dev Per-tier haircut (BPS) applied to the peer-consensus
    ///      median before the bound check. Reads governance override
    ///      from `s.tierLtvParams[tier].haircutBps`; zero falls
    ///      through to the library constant (Phase 7).
    ///
    ///      Note: a configured-haircut value of zero can't be
    ///      distinguished from "never configured" at the storage
    ///      level — the convention is that callers configure the WHOLE
    ///      `TierLtvParams` triple (floor + ceil + haircut) atomically,
    ///      and a non-zero ceil acts as the "configured" indicator for
    ///      the full triple. A governance-set 0pp haircut is therefore
    ///      indistinguishable from the library 0pp default for Tier 1 /
    ///      Tier 2 (which already default to 0pp), and for Tier 3 the
    ///      library default of 500 (5pp) is what governance would
    ///      typically inherit anyway.
    function tierLtvHaircutBps(uint8 tier) internal view returns (uint16) {
        if (tier == 0 || tier > MAX_LIQUIDITY_TIER) return 0;
        TierLtvParams storage p = storageSlot().tierLtvParams[tier];
        if (p.ceilBps != 0) {
            return p.haircutBps;
        }
        if (tier == 1) return TIER1_LTV_HAIRCUT_BPS;
        if (tier == 2) return TIER2_LTV_HAIRCUT_BPS;
        return TIER3_LTV_HAIRCUT_BPS;
    }

    /// @dev Library default LTV per tier — used when the cache is
    ///      hard-stale (> 14 days) or never-refreshed. Sit at the
    ///      midpoint of each tier's safety box.
    function tierLtvLibraryDefaultBps(uint8 tier) internal pure returns (uint16) {
        if (tier == 1) return TIER1_LTV_DEFAULT_BPS;
        if (tier == 2) return TIER2_LTV_DEFAULT_BPS;
        if (tier == 3) return TIER3_LTV_DEFAULT_BPS;
        return 0;
    }

    /// @dev Effective tier-LTV the loan-init gate consults. Reads the
    ///      cache if fresh (≤ 14d since last refresh), else returns
    ///      the library default for that tier. Tier 0 always returns
    ///      0 (asset not classified — caller must reject before
    ///      reaching this).
    function effectiveTierMaxInitLtvBps(uint8 tier) internal view returns (uint16) {
        if (tier == 0 || tier > MAX_LIQUIDITY_TIER) return 0;
        Storage storage s = storageSlot();
        // #633 — only trust the cached peer-derived value when peer reads are NOT
        // paused. While paused (and in the window after an unpause, before a fresh
        // refresh, when the cache was invalidated) the cache is skipped.
        if (!s.protocolCfg.peerLtvReadsPaused) {
            TierLtvCacheEntry storage entry = s.tierLtvCache[tier];
            if (
                entry.lastRefreshedAt > 0 &&
                block.timestamp - uint256(entry.lastRefreshedAt) <= TIER_LTV_CACHE_HARD_TTL
            ) {
                return entry.ltvBps;
            }
        }
        // #633 — the cache-miss / paused fallback is the GOVERNANCE-configured tier
        // cap (which itself defaults to the library value when unset), NOT the bare
        // library default — so a governance-tightened Tier-2/3 cap is enforced both
        // during a pause AND in the post-unpause window before a fresh refresh,
        // never temporarily reopening at the looser hard-coded default.
        return uint16(cfgTierMaxInitLtvBps(tier));
    }

    // ─── FlashLoanLiquidationPath.md — per-tier discount accessors ─────

    /// @dev Per-tier liquidator-discount bounds (BPS). Constitution-
    ///      level: changing these requires a source change + audit,
    ///      not a config call. The setter clamps governance writes
    ///      inside this box; loan-side reads never consult bounds
    ///      directly — they go through `effectiveTierLiqDiscountBps`.
    function tierLiqDiscountBoundsBps(uint8 tier)
        internal
        pure
        returns (uint16 floorBps, uint16 ceilBps)
    {
        if (tier == 1) return (TIER1_LIQ_DISCOUNT_FLOOR_BPS, TIER1_LIQ_DISCOUNT_CEIL_BPS);
        if (tier == 2) return (TIER2_LIQ_DISCOUNT_FLOOR_BPS, TIER2_LIQ_DISCOUNT_CEIL_BPS);
        if (tier == 3) return (TIER3_LIQ_DISCOUNT_FLOOR_BPS, TIER3_LIQ_DISCOUNT_CEIL_BPS);
        return (0, 0);
    }

    /// @dev Library default discount per tier — used when the
    ///      `protocolCfg.tier{N}LiqDiscountBps` slot is zero (i.e.
    ///      governance has never overridden). Sit at the user-ratified
    ///      figures inside their respective safety boxes.
    function tierLiqDiscountLibraryDefaultBps(uint8 tier)
        internal
        pure
        returns (uint16)
    {
        if (tier == 1) return TIER1_LIQ_DISCOUNT_DEFAULT_BPS;
        if (tier == 2) return TIER2_LIQ_DISCOUNT_DEFAULT_BPS;
        if (tier == 3) return TIER3_LIQ_DISCOUNT_DEFAULT_BPS;
        return 0;
    }

    /// @dev Effective liquidator-discount the
    ///      `triggerLiquidationDiscounted` settlement consults. Reads
    ///      the governance override if set (non-zero), else falls
    ///      through to the library default. Tier 0 (unclassified)
    ///      always returns 0 — caller must reject before reaching the
    ///      settlement math. Pre-handover the override slot is
    ///      ADMIN_ROLE-tunable; post-handover it's TimelockController-
    ///      gated (48h).
    function effectiveTierLiqDiscountBps(uint8 tier) internal view returns (uint16) {
        if (tier == 0 || tier > MAX_LIQUIDITY_TIER) return 0;
        ProtocolConfig storage cfg = storageSlot().protocolCfg;
        uint16 override_;
        if (tier == 1) override_ = cfg.tier1LiqDiscountBps;
        else if (tier == 2) override_ = cfg.tier2LiqDiscountBps;
        else override_ = cfg.tier3LiqDiscountBps;
        if (override_ != 0) return override_;
        return tierLiqDiscountLibraryDefaultBps(tier);
    }

    /// @dev Master kill-switch view for the discount path. Mirrors
    ///      the `cfgDepthTieredLtvEnabled` pattern. Default `false`
    ///      on a fresh deploy ⇒ `triggerLiquidationDiscounted` reverts.
    function cfgDiscountPathEnabled() internal view returns (bool) {
        return storageSlot().protocolCfg.discountPathEnabled;
    }

    /// @dev Owner-only setter for a tier's reference asset list. Used
    ///      by `OracleAdminFacet.setTierReferenceAssets`. Passing an
    ///      empty array clears the tier (refreshes for that tier will
    ///      then no-op with `no-reference-assets`).
    function setTierReferenceAssets(uint8 tier, address[] memory assets) internal {
        LibDiamond.enforceIsContractOwner();
        require(
            tier >= 1 && tier <= MAX_LIQUIDITY_TIER,
            "tier out of range"
        );
        Storage storage s = storageSlot();
        delete s.tierReferenceAssets[tier];
        for (uint256 i = 0; i < assets.length; ++i) {
            require(assets[i] != address(0), "zero asset in reference list");
            s.tierReferenceAssets[tier].push(assets[i]);
        }
        emit TierReferenceAssetsSet(tier, assets);
    }

    /// @dev Read a tier's reference asset list. Used by the
    ///      refreshTierLtvCache aggregator + the
    ///      `OracleAdminFacet.getTierReferenceAssets` view.
    function getTierReferenceAssets(uint8 tier) internal view returns (address[] memory) {
        if (tier == 0 || tier > MAX_LIQUIDITY_TIER) return new address[](0);
        return storageSlot().tierReferenceAssets[tier];
    }

    /// @dev Set the per-chain peer-lending-protocol addresses the
    ///      autonomous tier-LTV cache reads. Owner-only — after the
    ///      governance handover the owner is the TimelockController,
    ///      so every change is 48h-gated. Setting any to `address(0)`
    ///      skips that peer in the aggregation (treat as "peer not
    ///      deployed on this chain").
    function setPeerProtocolAddresses(
        address aaveV3PoolDataProvider,
        address compoundV3Comet,
        address morphoBlue
    ) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        s.aaveV3PoolDataProvider = aaveV3PoolDataProvider;
        s.compoundV3Comet = compoundV3Comet;
        s.morphoBlue = morphoBlue;
        emit PeerProtocolAddressesSet(aaveV3PoolDataProvider, compoundV3Comet, morphoBlue);
    }

    /// @notice Installs or clears a per-feed staleness + min-answer
    ///         override for a specific Chainlink aggregator.
    /// @dev Owner-only. After the governance handover the owner is the
    ///      TimelockController, so every override change is 48h-gated
    ///      and publicly observable via `CallScheduled` on the timelock.
    ///      Passing `maxStaleness == 0` clears BOTH fields regardless of
    ///      the `minValidAnswer` argument — it's the "remove the
    ///      override entirely" escape hatch.
    /// @param feed           Chainlink aggregator to configure.
    /// @param maxStaleness   Max acceptable age in seconds. 0 clears.
    /// @param minValidAnswer Floor on the raw answer the aggregator
    ///                       returns; in the aggregator's decimals.
    ///                       Pass 0 (or a negative int) for no floor.
    function setFeedOverride(
        address feed,
        uint40 maxStaleness,
        int256 minValidAnswer
    ) internal {
        LibDiamond.enforceIsContractOwner();
        if (feed == address(0)) revert IVaipakamErrors.InvalidAddress();
        Storage storage s = storageSlot();
        FeedOverride storage ovr = s.feedOverrides[feed];
        if (maxStaleness == 0) {
            // Clear both fields — explicit "remove override" action.
            ovr.maxStaleness = 0;
            ovr.minValidAnswer = 0;
            emit FeedOverrideSet(feed, 0, 0);
            return;
        }
        ovr.maxStaleness = maxStaleness;
        ovr.minValidAnswer = minValidAnswer;
        emit FeedOverrideSet(feed, maxStaleness, minValidAnswer);
    }

    // ─── Phase 7b.2: Tellor + API3 + chain-level secondary config ──

    /// @notice Emitted when the chain's Tellor oracle address changes.
    /// @custom:event-category informational/config
    event TellorOracleSet(address indexed previous, address indexed next);

    /// @notice Emitted when the chain's API3 ServerV1 address changes.
    /// @custom:event-category informational/config
    event Api3ServerV1Set(address indexed previous, address indexed next);

    /// @notice Emitted when the chain's DIA Oracle V2 address changes.
    /// @custom:event-category informational/config
    event DIAOracleV2Set(address indexed previous, address indexed next);

    /// @notice Emitted when the chain-level secondary-oracle deviation
    ///         tolerance changes. Off-chain monitors should alert on
    ///         transitions: a wider tolerance weakens the cross-
    ///         provider check.
    /// @custom:event-category informational/config
    event SecondaryOracleMaxDeviationBpsSet(uint16 previous, uint16 current);

    /// @notice Emitted when the chain-level secondary-oracle staleness
    ///         tolerance changes.
    /// @custom:event-category informational/config
    event SecondaryOracleMaxStalenessSet(uint40 previous, uint40 current);

    /// @notice Install the chain's Tellor oracle address. Owner-only;
    ///         null disables Tellor's leg of the price-feed deviation
    ///         check globally.
    function setTellorOracle(address oracle) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        address prev = s.tellorOracle;
        s.tellorOracle = oracle;
        emit TellorOracleSet(prev, oracle);
    }

    /// @notice Install the chain's API3 ServerV1 address. Owner-only;
    ///         null disables API3's leg of the deviation check globally.
    function setApi3ServerV1(address server) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        address prev = s.api3ServerV1;
        s.api3ServerV1 = server;
        emit Api3ServerV1Set(prev, server);
    }

    /// @notice Install the chain's DIA Oracle V2 address. Owner-only;
    ///         null disables DIA's leg of the deviation check globally.
    // forge-lint: disable-next-line(mixed-case-function)
    function setDIAOracleV2(address oracle) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        address prev = s.diaOracleV2;
        s.diaOracleV2 = oracle;
        emit DIAOracleV2Set(prev, oracle);
    }

    /// @notice Set the chain-level deviation tolerance applied to
    ///         every secondary oracle (Tellor / API3 / DIA) when it
    ///         disagrees with the Chainlink primary.
    /// @dev    Setter-range audit (2026-05-02): tightened from the
    ///         original `(0, BASIS_POINTS)` window to
    ///         `[SECONDARY_ORACLE_MAX_DEVIATION_BPS_MIN,
    ///         SECONDARY_ORACLE_MAX_DEVIATION_BPS_MAX]` so a
    ///         compromised governance multisig cannot push the
    ///         tolerance to a degenerate setting (1 bps fail-closes
    ///         every legitimate cross-oracle drift; 9999 effectively
    ///         disables the gate).
    function setSecondaryOracleMaxDeviationBps(uint16 bps) internal {
        LibDiamond.enforceIsContractOwner();
        if (
            bps < SECONDARY_ORACLE_MAX_DEVIATION_BPS_MIN ||
            bps > SECONDARY_ORACLE_MAX_DEVIATION_BPS_MAX
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "secondaryOracleMaxDeviationBps",
                uint256(bps),
                uint256(SECONDARY_ORACLE_MAX_DEVIATION_BPS_MIN),
                uint256(SECONDARY_ORACLE_MAX_DEVIATION_BPS_MAX)
            );
        }
        Storage storage s = storageSlot();
        uint16 prev = s.secondaryOracleMaxDeviationBps;
        s.secondaryOracleMaxDeviationBps = bps;
        emit SecondaryOracleMaxDeviationBpsSet(prev, bps);
    }

    /// @notice Set the chain-level secondary-oracle staleness tolerance
    ///         in seconds.
    /// @dev    Setter-range audit (2026-05-02): added upper bound.
    ///         Previously only `!= 0` — a misconfig could allow
    ///         arbitrary stale data through the secondary quorum,
    ///         defeating the freshness gate.
    function setSecondaryOracleMaxStaleness(uint40 maxStaleness) internal {
        LibDiamond.enforceIsContractOwner();
        if (
            maxStaleness < SECONDARY_ORACLE_MAX_STALENESS_MIN_SECONDS ||
            maxStaleness > SECONDARY_ORACLE_MAX_STALENESS_MAX_SECONDS
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "secondaryOracleMaxStaleness",
                uint256(maxStaleness),
                uint256(SECONDARY_ORACLE_MAX_STALENESS_MIN_SECONDS),
                uint256(SECONDARY_ORACLE_MAX_STALENESS_MAX_SECONDS)
            );
        }
        Storage storage s = storageSlot();
        uint40 prev = s.secondaryOracleMaxStaleness;
        s.secondaryOracleMaxStaleness = maxStaleness;
        emit SecondaryOracleMaxStalenessSet(prev, maxStaleness);
    }

    /// @notice Read the effective deviation tolerance — falls back to
    ///         the package default when no value is configured.
    function effectiveSecondaryOracleMaxDeviationBps()
        internal
        view
        returns (uint16)
    {
        uint16 v = storageSlot().secondaryOracleMaxDeviationBps;
        return v == 0 ? SECONDARY_ORACLE_MAX_DEVIATION_BPS_DEFAULT : v;
    }

    /// @notice Read the effective staleness tolerance — falls back to
    ///         the package default when no value is configured.
    function effectiveSecondaryOracleMaxStaleness()
        internal
        view
        returns (uint40)
    {
        uint40 v = storageSlot().secondaryOracleMaxStaleness;
        return v == 0 ? SECONDARY_ORACLE_MAX_STALENESS_DEFAULT : v;
    }

    // ─── T-033 — Pyth setters + readers with bounded ranges ────────────────

    /// @notice Emitted when the chain-level Pyth contract address
    ///         changes. Setting to `address(0)` disables the
    ///         numeraire gate globally, so the event is worth a
    ///         human review either way.
    /// @custom:event-category informational/config
    event PythOracleSet(address indexed previous, address indexed next);

    /// @notice Emitted when the chain's Pyth ETH/USD (or WETH/USD)
    ///         feed id changes. Single-write-per-chain — emitted at
    ///         init and on any subsequent governance update.
    /// @custom:event-category informational/config
    event PythNumeraireFeedIdSet(
        bytes32 indexed previous,
        bytes32 indexed next
    );

    /// @notice Emitted when the Pyth max-staleness budget changes.
    /// @custom:event-category informational/config
    event PythMaxStalenessSecondsSet(uint64 previous, uint64 current);

    /// @notice Emitted when the Pyth numeraire deviation tolerance
    ///         changes. Stored value applies on the next price view.
    /// @custom:event-category informational/config
    event PythNumeraireMaxDeviationBpsSet(uint16 previous, uint16 current);

    /// @notice Emitted when the Pyth confidence ceiling changes.
    /// @custom:event-category informational/config
    event PythConfidenceMaxBpsSet(uint16 previous, uint16 current);

    /// @notice Set the Pyth contract address on this chain. Zero
    ///         disables the numeraire gate globally — protocol price
    ///         views fall back to Chainlink-only on the WETH/USD leg.
    /// @dev    Owner-only. No range bound — `address(0)` is the
    ///         meaningful "disabled" sentinel and any non-zero
    ///         contract is acceptable here (sanity-check that it
    ///         responds to {IPyth.getPriceUnsafe} happens on first
    ///         use, not at setter time).
    function setPythOracle(address oracle) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        address prev = s.pythOracle;
        s.pythOracle = oracle;
        emit PythOracleSet(prev, oracle);
    }

    /// @notice Set the Pyth feed id used as this chain's numeraire
    ///         (ETH/USD on ETH-native chains, bridged-WETH/USD on
    ///         BNB / Polygon mainnet).
    /// @dev    Zero disables the gate at the feed-id layer (same
    ///         soft-skip semantics as a zero `pythOracle`); non-zero
    ///         values are accepted as-is. The price-read path
    ///         catches a mis-identified feed via the deviation gate.
    function setPythCrossCheckFeedId(bytes32 feedId) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        bytes32 prev = s.pythCrossCheckFeedId;
        s.pythCrossCheckFeedId = feedId;
        emit PythNumeraireFeedIdSet(prev, feedId);
    }

    /// @notice Set the Pyth max-staleness budget in seconds. Bounded
    ///         to `[PYTH_MAX_STALENESS_MIN_SECONDS,
    ///         PYTH_MAX_STALENESS_MAX_SECONDS]`. A compromised
    ///         governance multisig cannot push the budget tighter
    ///         than 1 min (would soft-skip Pyth on every transient
    ///         mempool jam, defeating the gate) or looser than 1 h
    ///         (a stale-but-manipulated reading could drive the
    ///         deviation outcome).
    function setPythMaxStalenessSeconds(uint64 secondsBudget) internal {
        LibDiamond.enforceIsContractOwner();
        if (
            secondsBudget < PYTH_MAX_STALENESS_MIN_SECONDS ||
            secondsBudget > PYTH_MAX_STALENESS_MAX_SECONDS
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "pythMaxStalenessSeconds",
                uint256(secondsBudget),
                uint256(PYTH_MAX_STALENESS_MIN_SECONDS),
                uint256(PYTH_MAX_STALENESS_MAX_SECONDS)
            );
        }
        Storage storage s = storageSlot();
        uint64 prev = s.pythMaxStalenessSeconds;
        s.pythMaxStalenessSeconds = secondsBudget;
        emit PythMaxStalenessSecondsSet(prev, secondsBudget);
    }

    /// @notice Set the Chainlink ↔ Pyth max-deviation tolerance, in
    ///         basis points. Bounded to
    ///         `[PYTH_NUMERAIRE_MAX_DEVIATION_BPS_MIN,
    ///         PYTH_NUMERAIRE_MAX_DEVIATION_BPS_MAX]`.
    function setPythCrossCheckMaxDeviationBps(uint16 bps) internal {
        LibDiamond.enforceIsContractOwner();
        if (
            bps < PYTH_NUMERAIRE_MAX_DEVIATION_BPS_MIN ||
            bps > PYTH_NUMERAIRE_MAX_DEVIATION_BPS_MAX
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "pythCrossCheckMaxDeviationBps",
                uint256(bps),
                uint256(PYTH_NUMERAIRE_MAX_DEVIATION_BPS_MIN),
                uint256(PYTH_NUMERAIRE_MAX_DEVIATION_BPS_MAX)
            );
        }
        Storage storage s = storageSlot();
        uint16 prev = s.pythCrossCheckMaxDeviationBps;
        s.pythCrossCheckMaxDeviationBps = bps;
        emit PythNumeraireMaxDeviationBpsSet(prev, bps);
    }

    /// @notice Set the Pyth confidence-fraction ceiling, in basis
    ///         points. Bounded to `[PYTH_CONFIDENCE_MAX_BPS_MIN,
    ///         PYTH_CONFIDENCE_MAX_BPS_MAX]`.
    function setPythConfidenceMaxBps(uint16 bps) internal {
        LibDiamond.enforceIsContractOwner();
        if (
            bps < PYTH_CONFIDENCE_MAX_BPS_MIN ||
            bps > PYTH_CONFIDENCE_MAX_BPS_MAX
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "pythConfidenceMaxBps",
                uint256(bps),
                uint256(PYTH_CONFIDENCE_MAX_BPS_MIN),
                uint256(PYTH_CONFIDENCE_MAX_BPS_MAX)
            );
        }
        Storage storage s = storageSlot();
        uint16 prev = s.pythConfidenceMaxBps;
        s.pythConfidenceMaxBps = bps;
        emit PythConfidenceMaxBpsSet(prev, bps);
    }

    /// @notice Read the effective Pyth max-staleness — falls back to
    ///         the package default when no value is configured.
    function effectivePythMaxStalenessSeconds() internal view returns (uint64) {
        uint64 v = storageSlot().pythMaxStalenessSeconds;
        return v == 0 ? PYTH_MAX_STALENESS_DEFAULT_SECONDS : v;
    }

    /// @notice Read the effective Pyth deviation tolerance — falls
    ///         back to the package default when no value is
    ///         configured.
    function effectivePythCrossCheckMaxDeviationBps()
        internal
        view
        returns (uint16)
    {
        uint16 v = storageSlot().pythCrossCheckMaxDeviationBps;
        return v == 0 ? PYTH_NUMERAIRE_MAX_DEVIATION_BPS_DEFAULT : v;
    }

    /// @notice Read the effective Pyth confidence ceiling — falls
    ///         back to the package default when no value is
    ///         configured.
    function effectivePythConfidenceMaxBps() internal view returns (uint16) {
        uint16 v = storageSlot().pythConfidenceMaxBps;
        return v == 0 ? PYTH_CONFIDENCE_MAX_BPS_DEFAULT : v;
    }

    /// @notice T-048 — read the effective PAD symbol used by the
    ///         symbol-derived secondary oracles. Empty bytes32
    ///         (post-deploy default before governance writes) is
    ///         interpreted as `"usd"`, matching the
    ///         `numeraireSymbol` fallback convention.
    function effectivePadSymbol() internal view returns (bytes32) {
        bytes32 v = storageSlot().predominantDenominatorSymbol;
        // forge-lint: disable-next-line(unsafe-typecast)
        return v == bytes32(0) ? bytes32("usd") : v;
    }

    /// @notice T-048 — `true` when the active numeraire's Chainlink
    ///         denomination matches the PAD denomination. On retail
    ///         (both default to `Denominations.USD`), this returns
    ///         `true` and the oracle path short-circuits the FX
    ///         conversion. Industrial-fork deploys with
    ///         `numeraire == EUR / JPY / XAU` return `false` and
    ///         require the FX conversion path (direct or derived).
    ///
    ///         Treats unset `predominantDenominator` (zero) as a
    ///         pre-T-048 deploy where PAD wasn't configured: returns
    ///         `false` so the legacy numeraire-direct path keeps
    ///         working without a forced PAD configuration.
    function isPadEqualToNumeraire() internal view returns (bool) {
        Storage storage s = storageSlot();
        address pad = s.predominantDenominator;
        if (pad == address(0)) return false;
        return pad == s.numeraireChainlinkDenominator;
    }

    /// @notice Emitted when the chain's sanctions oracle address changes.
    ///         Off-chain monitoring should alert on a transition to or
    ///         from `address(0)`: zero disables the check globally, so
    ///         the event is worth a human review either way.
    /// @custom:event-category informational/config
    event SanctionsOracleSet(address indexed previous, address indexed next);

    /// @notice Installs the per-chain Chainalysis sanctions oracle
    ///         address. Owner-only — timelock-gated after the
    ///         governance handover. Setting to `address(0)` disables
    ///         sanctions screening across the chain (correct when
    ///         Chainalysis has not deployed an oracle there).
    /// @param oracle The Chainalysis oracle contract address, or zero.
    function setSanctionsOracle(address oracle) internal {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = storageSlot();
        address prev = s.sanctionsOracle;
        s.sanctionsOracle = oracle;
        emit SanctionsOracleSet(prev, oracle);
    }

    /// @notice Read-through helper: true iff the configured oracle
    ///         reports `who` as currently sanctioned. Returns false
    ///         when no oracle is configured (the gate is disabled)
    ///         OR when the oracle call reverts (fail-open on
    ///         infrastructure failure — the alternative would brick
    ///         every interaction on the chain whenever Chainalysis's
    ///         oracle has an outage, which would over-react to a
    ///         vendor availability issue).
    ///
    /// ─── Sanctions enforcement policy (Phase 1, retail deploy) ───
    ///
    /// The retail deploy may have a sanctions oracle configured (e.g.
    /// Chainalysis on-chain SDN list). When set, the gate splits the
    /// callable surface into two tiers:
    ///
    /// **Tier 1 — BLOCK** when `msg.sender` is sanctioned (revert
    /// with `ProfileFacet.SanctionedAddress(who)`). Any entry point
    /// that creates new state or routes funds TO the caller:
    ///   - `OfferFacet.createOffer` / `acceptOffer` (creator + acceptor checks)
    ///   - `VaultFactoryFacet.getOrCreateUserVault` (no vault ever
    ///     exists for a sanctioned wallet)
    ///   - `ClaimFacet.claimAsLender` / `claimAsBorrower` (funds OUT)
    ///   - `VPFIDiscountFacet.buyVPFI` (token purchase)
    ///   - `RiskFacet.triggerLiquidation` (3% liquidator bonus → caller)
    ///   - `EarlyWithdrawalFacet.withdrawEarly` (lender pulls early)
    ///   - `PrecloseFacet.transferObligationViaOffer` (funds + state)
    ///   - `RefinanceFacet.refinanceLoan` (funds + new loan state)
    ///
    /// **Tier 2 — ALLOW** even when `msg.sender` is sanctioned. Each
    /// entry point either CLOSES exposure to the sanctioned party or
    /// is a permissionless safety action that benefits the
    /// non-sanctioned counterparty:
    ///   - `RepayFacet.repay` / `repayPartial` — closes the loan,
    ///     unsanctioned lender gets paid. Refusing this would force
    ///     default → liquidation, which routes the same value through
    ///     a worse path; counter-productive for compliance.
    ///   - `AddCollateralFacet.addCollateral` — borrower puts MORE
    ///     skin in to keep loan healthy; pro-protocol.
    ///   - `DefaultedFacet.markDefaulted` — anyone unflagged calls
    ///     this; value flows to lender, not msg.sender.
    ///
    /// ─── Legal reasoning for Tier-2 carve-outs ───
    ///
    /// Liquidation of a sanctioned-borrower's collateral is allowed
    /// because the lender's claim was established BEFORE the
    /// sanction (security interest in the collateral, contractually
    /// pledged at loan-init). Executing on a pre-existing security
    /// interest is the pattern OFAC General Licenses authorize for
    /// "wind-down of contracts entered into prior to designation".
    /// The sanctioned party's residual interest (collateral surplus
    /// after debt + bonus) stays frozen in their own vault — Tier-1
    /// blocks `claimAsBorrower`, so no value flows to the sanctioned
    /// wallet. Lender (unsanctioned) receives principal+interest;
    /// liquidator (must be unsanctioned, Tier-1 blocks the bonus)
    /// receives the 3% bonus. Sanctioned residue is held but not
    /// transferred to any other address.
    ///
    /// ─── What about funds frozen in a sanctioned wallet's vault? ───
    ///
    /// The protocol does not seize, redirect, or release these funds.
    /// They remain in the sanctioned wallet's own vault and become
    /// claimable again if the oracle delists the address. This is
    /// the same behaviour as Circle's USDC blocklist — frozen, not
    /// seized. The frontend communicates this to a sanctioned wallet
    /// when it connects; the public Terms of Service carries one
    /// generic disclosure line about restricted access.
    ///
    /// @param who The address to check.
    function isSanctionedAddress(address who) internal view returns (bool) {
        address oracle = storageSlot().sanctionsOracle;
        if (oracle == address(0)) return false;

        // Recovery-induced ban (T-054 PR-3): if `who` previously
        // declared a sanctioned source via the recovery flow, treat
        // them as sanctioned for as long as that source IS still
        // sanctioned. Source-tracked rather than persistent so the
        // ban auto-unlocks if the underlying address is de-listed.
        address bannedSource = storageSlot().vaultBannedSource[who];
        if (bannedSource != address(0)) {
            try ISanctionsList(oracle).isSanctioned(bannedSource) returns (bool sourceFlagged) {
                if (sourceFlagged) return true;
                // Else fall through: source de-listed → ban lifted →
                // direct check on `who` decides.
            } catch {
                // Oracle call failed — fall through. Direct check on
                // `who` retains the existing fail-open behaviour
                // documented at the top of this block.
            }
        }

        try ISanctionsList(oracle).isSanctioned(who) returns (bool flagged) {
            return flagged;
        } catch {
            return false;
        }
    }

    /// @notice True when an offer's GTT deadline has elapsed. Single
    ///         source-of-truth for the GTC short-circuit (`expiresAt
    ///         == 0`), so every accept / match / preview / cancel call
    ///         reads the deadline through the same predicate.
    /// @dev    Pure of storage writes; takes a storage-pointer so the
    ///         caller pays only the one SLOAD for `expiresAt` (packed
    ///         next to `createdAt` in slot 17 of the Offer struct, so
    ///         on the hot accept-path it usually piggybacks on a slot
    ///         already in the warm cache).
    ///
    ///         `>= expiresAt` (not `>`) — the deadline is exclusive of
    ///         its own second to keep the boundary unambiguous: an offer
    ///         created with `expiresAt = T` cannot be accepted at
    ///         `block.timestamp == T`. The matching MAX_OFFER_EXPIRY_HORIZON
    ///         cap and the createOffer `expiresAt > block.timestamp`
    ///         check use the same convention.
    /// @param offer Storage pointer to the offer being queried.
    /// @return expired `true` iff `expiresAt != 0 && block.timestamp >= expiresAt`.
    function isOfferExpired(Offer storage offer) internal view returns (bool expired) {
        uint64 deadline = offer.expiresAt;
        // GTC sentinel — never expires.
        if (deadline == 0) return false;
        return block.timestamp >= uint256(deadline);
    }

    /// @notice Mirrors `ProfileFacet.SanctionedAddress` (same name +
    ///         same args ⇒ same EVM selector). Declared here so
    ///         LibVaipakam doesn't have to import ProfileFacet,
    ///         which would create a circular dependency. Consumers
    ///         see identical revert data regardless of which file
    ///         emits.
    error SanctionedAddress(address who);

    /// @notice Tier-1 enforcement helper. Reverts with
    ///         `SanctionedAddress(who)` (selector identical to
    ///         `ProfileFacet.SanctionedAddress`) when `who` is
    ///         flagged by the configured oracle. No-op when the
    ///         oracle is unset or fails open. See the policy block
    ///         above for the full Tier-1 / Tier-2 split.
    /// @dev Plant this at every Tier-1 entry point. Co-located here
    ///      so a single edit point dedups the boilerplate.
    function _assertNotSanctioned(address who) internal view {
        if (isSanctionedAddress(who)) {
            revert SanctionedAddress(who);
        }
    }

    /// @notice FAIL-CLOSED twin of {isSanctionedAddress}/{_assertNotSanctioned}
    ///         (#998 S10 / #1006). Reverts `SanctionedAddress(who)` when `who`
    ///         (or its recovery-declared source) is flagged, AND reverts
    ///         `SanctionsOracleUnavailable()` whenever the oracle is unset or its
    ///         call reverts — i.e. every fail-OPEN `return false` / `catch { return
    ///         false }` leg of {isSanctionedAddress} becomes a fail-CLOSED revert.
    /// @dev    Used ONLY at the sanctioned-locked-proceeds release gate, applied to
    ///         the RECORDED frozen-claimant address (not `msg.sender`), so that
    ///         confirmed-at-close-out freezes cannot silently lift during a
    ///         sanctions-oracle outage. Ordinary (never-locked) claims keep using
    ///         the fail-open {_assertNotSanctioned} on `msg.sender`, so an oracle
    ///         blip never bricks honest users. Mirrors the fail-closed pattern in
    ///         `VaultFactoryFacet.recoverStuckERC20`. Reuses the shared
    ///         `IVaipakamErrors.SanctionsOracleUnavailable` + local
    ///         `SanctionedAddress` errors.
    function assertNotSanctionedFailClosed(address who) internal view {
        address oracle = storageSlot().sanctionsOracle;
        // Leg 1 — oracle unset ⇒ fail CLOSED (isSanctionedAddress returns false).
        if (oracle == address(0)) revert IVaipakamErrors.SanctionsOracleUnavailable();

        // Leg 2 — recovery-induced ban: a `who` whose declared recovery source is
        // still flagged is treated as sanctioned. A screen that checked only
        // `who`'s own EOA would let a recovery-banned owner withdraw locked funds
        // once their EOA reads clean, so this leg is load-bearing. On an oracle
        // revert here we must fail CLOSED (isSanctionedAddress falls through /
        // catches to false).
        address bannedSource = storageSlot().vaultBannedSource[who];
        if (bannedSource != address(0)) {
            try ISanctionsList(oracle).isSanctioned(bannedSource) returns (bool sourceFlagged) {
                if (sourceFlagged) revert SanctionedAddress(who);
                // Source de-listed → ban lifted → fall through to the direct check.
            } catch {
                revert IVaipakamErrors.SanctionsOracleUnavailable();
            }
        }

        // Leg 3 — direct check on `who`. Flagged ⇒ SanctionedAddress; oracle
        // revert ⇒ fail CLOSED; clean ⇒ proceed.
        try ISanctionsList(oracle).isSanctioned(who) returns (bool flagged) {
            if (flagged) revert SanctionedAddress(who);
        } catch {
            revert IVaipakamErrors.SanctionsOracleUnavailable();
        }
    }

    /// @notice #1144 (S10 Invariant B) — registry-aware "is this recipient barred
    ///         from a prepay-sale INLINE payout / fill?" read. The fail-closed
    ///         BACKSTOP the prepay-sale fill path consults, with the SAME
    ///         outage-only-registry semantics as the `_assertMovePartyNotSanctioned`
    ///         position-move gate (Codex #1146-r1 P2):
    ///           - no oracle configured (`address(0)`, the disabled regime) ⇒ NOT
    ///             barred (the committed registry is ignored entirely, per §1349);
    ///           - authoritative `Flagged` ⇒ barred;
    ///           - authoritative `Clean` ⇒ NOT barred — a stale/not-yet-refreshed
    ///             marker on a now-clean (or de-listed) wallet never bars, and the
    ///             sync path self-heals it via `syncBuyerSanctionsFlag`;
    ///           - `Unavailable` (oracle set but unreachable — a genuine outage) ⇒
    ///             barred ONLY if the wallet carries a COMMITTED
    ///             `sanctionsConfirmedFlagged` marker (the outage backstop).
    ///         Deliberately NOT `assertNotSanctionedFailClosed`, which hard-reverts
    ///         on ANY outage (bricking an honest holder). `address(0)` (a burned-NFT
    ///         holder resolved via `_ownerOfRaw`) is never barred.
    function isRecipientBarred(address who) internal view returns (bool) {
        if (who == address(0)) return false;
        if (storageSlot().sanctionsOracle == address(0)) return false; // disabled regime
        SanctionsRead st = sanctionsStatus(who);
        if (st == SanctionsRead.Flagged) return true; // oracle-up authoritative flag
        if (st == SanctionsRead.Clean) return false; // oracle-up clean — stale marker ignored
        return storageSlot().sanctionsConfirmedFlagged[who]; // Unavailable ⇒ outage backstop
    }

    /// @notice Revert `SanctionedAddress(who)` when {isRecipientBarred} holds.
    function assertRecipientNotBarred(address who) internal view {
        if (isRecipientBarred(who)) revert SanctionedAddress(who);
    }

    /// @notice Internal accountant for protocol-deposited ERC-20
    ///         tokens in a user's vault. Increments the per-(user,
    ///         token) counter that the Asset Viewer and the future
    ///         stuck-token recovery flow read.
    /// @dev    Library-internal helper called from
    ///         `VaultFactoryFacet.vaultDepositERC20` and
    ///         `recordVaultDepositERC20` (the counter-only sibling
    ///         used after Permit2 pulls). Solidity 0.8+ checked
    ///         arithmetic protects against overflow.
    function recordVaultDeposit(
        address user,
        address token,
        uint256 amount
    ) internal {
        storageSlot().protocolTrackedVaultBalance[user][token] += amount;
    }

    /// @notice Internal accountant for protocol-withdrawn ERC-20
    ///         tokens from a user's vault.
    /// @dev    Called from `VaultFactoryFacet.vaultWithdrawERC20`.
    ///         Underflow reverts — a decrement greater than the
    ///         tracked balance means a withdraw fired without a
    ///         matching deposit somewhere, which is an accounting
    ///         bug upstream that we want to surface loudly.
    function recordVaultWithdraw(
        address user,
        address token,
        uint256 amount
    ) internal {
        storageSlot().protocolTrackedVaultBalance[user][token] -= amount;
    }

    // ─── #1123 — fail-closed position-movement restriction ─────────────

    /// @notice Authoritative tri-state sanctions read used ONLY to MUTATE the
    ///         `sanctionsConfirmedFlagged` registry (#1123). Unlike the fail-open
    ///         {isSanctionedAddress} (which returns `false` for both clean AND
    ///         outage), this NEVER conflates a clean read with an unavailable one:
    ///         a registry write must act only on a definitive `Clean`/`Flagged`,
    ///         so a mid-outage refresh can't wrongly clear a still-flagged wallet.
    /// @dev    Folds in the recovery-ban leg (`vaultBannedSource`) exactly as
    ///         {isSanctionedAddress}. `Unavailable` covers BOTH the oracle-unset
    ///         and oracle-reverts cases; callers that must distinguish "regime
    ///         disabled" from "outage" check `sanctionsOracle == address(0)`
    ///         themselves first (see {assertPositionMoveNotSanctioned}).
    enum SanctionsRead { Clean, Flagged, Unavailable }

    function sanctionsStatus(address who) internal view returns (SanctionsRead) {
        address oracle = storageSlot().sanctionsOracle;
        if (oracle == address(0)) return SanctionsRead.Unavailable;

        // Recovery-ban leg: a `who` whose declared recovery source is still
        // flagged is Flagged. A de-listed (clean) source falls through to the
        // direct check below. A FAILED source read must NOT mask a direct flag
        // (Codex #1126 r4 P2): still try the direct `who` read — a directly
        // sanctioned wallet is authoritatively Flagged regardless of the source
        // outage — but a clean/failed direct read stays Unavailable, because with
        // the source unreadable we can neither confirm nor CLEAR the recovery-ban
        // flag, so we must not downgrade `who` to Clean.
        address bannedSource = storageSlot().vaultBannedSource[who];
        if (bannedSource != address(0)) {
            try ISanctionsList(oracle).isSanctioned(bannedSource) returns (bool srcFlagged) {
                if (srcFlagged) return SanctionsRead.Flagged;
            } catch {
                try ISanctionsList(oracle).isSanctioned(who) returns (bool flagged) {
                    return flagged ? SanctionsRead.Flagged : SanctionsRead.Unavailable;
                } catch {
                    return SanctionsRead.Unavailable;
                }
            }
        }

        try ISanctionsList(oracle).isSanctioned(who) returns (bool flagged) {
            return flagged ? SanctionsRead.Flagged : SanctionsRead.Clean;
        } catch {
            return SanctionsRead.Unavailable;
        }
    }

    /// @notice #1123 — FAIL-CLOSED position-movement gate. Replaces the fail-open
    ///         `_assertNotSanctioned(from)+(to)` pair at every user-initiated
    ///         position-NFT MOVEMENT path (ERC-721 `transferFrom`/`safeTransferFrom`,
    ///         and the burn/mint sale-vehicle / obligation-transfer migrations).
    ///         A wallet CONFIRMED flagged while the oracle was reachable cannot
    ///         move a position during an outage, which closes the S10
    ///         laundering-chain class (#1006).
    /// @dev    Mutating (may self-heal-clear a de-listed party on an authoritative
    ///         clean read). Three-way by oracle state:
    ///           - oracle UNSET      → ignore registry, allow (regime disabled);
    ///           - oracle set+reachable, Flagged → revert (registry write would be
    ///             rolled back by the revert, so none is attempted here —
    ///             population is done by the non-reverting park/refresh paths);
    ///           - oracle set+reachable, Clean  → clear registry, allow;
    ///           - oracle set+outage (Unavailable) → fail-closed on the registry.
    ///         `from` MUST be the LIVE `ownerOf(positionTokenId)` at the migration
    ///         sites (captured before any loan-row rewrite) — the ERC-721
    ///         entrypoints already pass the live owner.
    function assertPositionMoveNotSanctioned(address from, address to) internal {
        // Regime disabled — ignore the registry entirely (matches the existing
        // "oracle unset ⇒ no screening" semantics; stale entries must not block).
        if (storageSlot().sanctionsOracle == address(0)) return;
        _assertMovePartyNotSanctioned(from);
        _assertMovePartyNotSanctioned(to);
    }

    function _assertMovePartyNotSanctioned(address party) private {
        if (party == address(0)) return;
        SanctionsRead st = sanctionsStatus(party);
        if (st == SanctionsRead.Flagged) {
            // Authoritative flag — block. (No registry write: it would be rolled
            // back by this revert; population is via the park/refresh paths.)
            revert SanctionedAddress(party);
        } else if (st == SanctionsRead.Clean) {
            // Authoritative clean — self-heal any stale registry entry.
            delete storageSlot().sanctionsConfirmedFlagged[party];
        } else {
            // Unavailable here means OUTAGE (oracle is set — checked above), so
            // fail CLOSED on a previously-confirmed flag.
            if (storageSlot().sanctionsConfirmedFlagged[party]) {
                revert SanctionedAddress(party);
            }
        }
    }

    /// @notice #1123 — sync the registry for a party observed on a non-reverting
    ///         path that must NOT be blocked (a sale BUYER whose flagged receive is
    ///         frozen-not-bricked per #831, but who must still be barred from later
    ///         MOVING the position during an outage). Authoritative `Flagged` ⇒
    ///         register; authoritative `Clean` ⇒ **self-heal-clear** any stale entry
    ///         (Codex #1126 r2 — a de-listed buyer's clean receive must lift the
    ///         restriction, mirroring `_assertMovePartyNotSanctioned`); `Unavailable`
    ///         ⇒ no-op (never mutate on an unconfirmed read). Never reverts.
    function syncBuyerSanctionsFlag(address who) internal {
        if (who == address(0)) return;
        SanctionsRead st = sanctionsStatus(who);
        if (st == SanctionsRead.Flagged) {
            storageSlot().sanctionsConfirmedFlagged[who] = true;
        } else if (st == SanctionsRead.Clean) {
            delete storageSlot().sanctionsConfirmedFlagged[who];
        }
    }

    /// @notice #1123 — movement gate for the protocol SALE vehicles (lender-sale).
    ///         Unlike a raw transfer / obligation transfer (both parties blocked),
    ///         a sale's BUYER receive is intentionally NOT blocked — the sale
    ///         completes and the buyer's proceeds are FROZEN (#831). So: block a
    ///         flagged/registered SELLER (the offload — the laundering vector), and
    ///         REGISTER a flagged BUYER (so they can't later move the position
    ///         during an outage) without blocking their receive. No-op when the
    ///         oracle is unset (regime disabled).
    function assertPositionSaleMoveNotSanctioned(address seller, address buyer) internal {
        if (storageSlot().sanctionsOracle == address(0)) return;
        _assertMovePartyNotSanctioned(seller);
        syncBuyerSanctionsFlag(buyer);
    }

    // ─────────────────────────────────────────────────────────────
    //  T-090 v1.1 (#389) — documented config defaults
    //  Codex round-1 PR #420 P2 #4: storage-zero values must
    //  fall back to the documented defaults so a fresh deploy
    //  where governance enables the surface without explicitly
    //  setting every knob doesn't ship with broken invariants
    //  (HF gate disabled, zero auction window, zero buffer, etc.).
    // ─────────────────────────────────────────────────────────────
    uint256 internal constant DEFAULT_INTENT_MIN_COMMIT_HF = 1.2e18;
    uint16 internal constant DEFAULT_INTENT_MIN_OUTPUT_BUFFER_BPS = 200;
    uint32 internal constant DEFAULT_INTENT_MIN_AUCTION_SECONDS = 60;
    uint32 internal constant DEFAULT_INTENT_MAX_AUCTION_SECONDS = 600;
    uint32 internal constant DEFAULT_INTENT_CANCEL_GRACE_SECONDS = 86_400;

    function cfgIntentMinCommitHFEffective() internal view returns (uint256) {
        uint256 v = storageSlot().cfgIntentMinCommitHF;
        return v == 0 ? DEFAULT_INTENT_MIN_COMMIT_HF : v;
    }
    function cfgIntentMinOutputBufferBpsEffective() internal view returns (uint16) {
        uint16 v = storageSlot().cfgIntentMinOutputBufferBps;
        return v == 0 ? DEFAULT_INTENT_MIN_OUTPUT_BUFFER_BPS : v;
    }
    function cfgIntentMinAuctionSecondsEffective() internal view returns (uint32) {
        uint32 v = storageSlot().cfgIntentMinAuctionSeconds;
        return v == 0 ? DEFAULT_INTENT_MIN_AUCTION_SECONDS : v;
    }
    function cfgIntentMaxAuctionSecondsEffective() internal view returns (uint32) {
        uint32 v = storageSlot().cfgIntentMaxAuctionSeconds;
        return v == 0 ? DEFAULT_INTENT_MAX_AUCTION_SECONDS : v;
    }
    function cfgIntentCancelGraceSecondsEffective() internal view returns (uint32) {
        uint32 v = storageSlot().cfgIntentCancelGraceSeconds;
        return v == 0 ? DEFAULT_INTENT_CANCEL_GRACE_SECONDS : v;
    }

    // ── T-087 Sub 1.A — ring-buffer TWA + mirror-cache defaults ─────────
    //
    // Hardcoded defaults align with the design doc §5 launch values;
    // any zero in storage falls through to these so a fresh deploy
    // behaves correctly with no post-deploy governance calls.
    uint8 internal constant DEFAULT_TWA_RECENT_DAYS = 7;
    uint8 internal constant DEFAULT_TWA_WINDOW_DAYS = 30;
    uint8 internal constant DEFAULT_TWA_RECENT_WEIGHT = 3;
    uint8 internal constant DEFAULT_TWA_MIN_STAKED_DAYS = 3;
    uint32 internal constant DEFAULT_MIRROR_TIER_MAX_AGE_SEC = 5_184_000; // 60 days

    function cfgTwaRecentDaysEffective() internal view returns (uint8) {
        uint8 v = storageSlot().cfgTwaRecentDays;
        return v == 0 ? DEFAULT_TWA_RECENT_DAYS : v;
    }

    function cfgTwaWindowDaysEffective() internal view returns (uint8) {
        uint8 v = storageSlot().cfgTwaWindowDays;
        return v == 0 ? DEFAULT_TWA_WINDOW_DAYS : v;
    }

    function cfgTwaRecentWeightEffective() internal view returns (uint8) {
        uint8 v = storageSlot().cfgTwaRecentWeight;
        return v == 0 ? DEFAULT_TWA_RECENT_WEIGHT : v;
    }

    function cfgTwaMinStakedDaysEffective() internal view returns (uint8) {
        uint8 v = storageSlot().cfgTwaMinStakedDays;
        return v == 0 ? DEFAULT_TWA_MIN_STAKED_DAYS : v;
    }

    function cfgMirrorTierMaxAgeSecEffective() internal view returns (uint32) {
        uint32 v = storageSlot().cfgMirrorTierMaxAgeSec;
        return v == 0 ? DEFAULT_MIRROR_TIER_MAX_AGE_SEC : v;
    }

    /**
     * @notice T-090 v1.1 (#389) — `IntentPending` guard helper.
     *         Reverts `IntentPending(loanId)` when an intent-based
     *         swap-to-repay commit is live for the loan. Wired at
     *         the top of every voluntary-close / collateral-mutating
     *         entry point that touches `loan.borrower`'s vault, per
     *         design §5.8.
     *
     *         Lender-protection entry points (HF-liquidation,
     *         time-default, periodic-shortfall) call
     *         `forceCancelIntentIfDueOrRevert` instead — that helper
     *         force-cancels the intent when the loan is already
     *         liquidatable / defaultable AND reverts `IntentPending`
     *         otherwise. The latter lands when the
     *         `SwapToRepayIntentFacet` bodies implement the cancel
     *         primitives the force-cancel branches depend on.
     *
     * @dev    Internal one-liner so each call site stays a
     *         single-line edit. Uses the cheap inline reads on
     *         `storageSlot().intentCommits[loanId]` (single SLOAD on
     *         the first struct slot — `orderHash` is the first field
     *         + is set non-zero on commit + cleared on every cancel
     *         / fill / force-cancel path).
     */
    function assertNoLiveIntentCommit(uint256 loanId) internal view {
        if (storageSlot().intentCommits[loanId].orderHash != bytes32(0)) {
            revert IVaipakamErrors.IntentPending(loanId);
        }
    }
}
