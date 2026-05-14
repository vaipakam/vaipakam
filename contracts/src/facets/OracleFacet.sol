// src/facets/OracleFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibSlippage} from "../libraries/LibSlippage.sol";
import {LibPeerLTV} from "../libraries/LibPeerLTV.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FeedRegistryInterface} from "@chainlink/contracts/src/v0.8/interfaces/FeedRegistryInterface.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {AggregatorV2V3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV2V3Interface.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {ITellor} from "../interfaces/ITellor.sol";
import {IApi3ServerV1} from "../interfaces/IApi3ServerV1.sol";
import {IDIAOracleV2} from "../interfaces/IDIAOracleV2.sol";
import {IPyth} from "../interfaces/IPyth.sol";

/**
 * @title OracleFacet
 * @author Vaipakam Developer Team
 * @notice Asset liquidity classification and Chainlink price feeds for the
 *         Vaipakam platform.
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded on
 *      mutating admin setters; price/liquidity views are always callable.
 *
 *      ── Quote asset ──
 *      The v3-style AMM pool-depth gate is quoted against **WETH** on every
 *      EVM chain (WETH is the deepest cross-chain venue; the previous
 *      asset/USDT gate only worked on Ethereum mainnet). Pool depth is
 *      converted to USD via the direct Chainlink ETH/USD feed configured
 *      by the admin.
 *
 *      ── Price retrieval (hybrid) ──
 *      {getAssetPrice} prefers a direct asset/USD feed and falls back to
 *      asset/ETH × ETH/USD only when no direct USD feed is available:
 *        - WETH itself: priced from `ethNumeraireFeed` directly; no pool check.
 *        - Other assets (primary): Chainlink Feed Registry getFeed(asset, USD).
 *        - Other assets (fallback): Chainlink Feed Registry
 *          getFeed(asset, ETH) × latestRoundData(ethNumeraireFeed).
 *
 *      ── Stablecoin peg-aware staleness ──
 *      Feeds older than {ORACLE_VOLATILE_STALENESS} (2h) but inside
 *      {ORACLE_STABLE_STALENESS} (25h) are accepted only if the answer
 *      is within {ORACLE_PEG_TOLERANCE_BPS} of the implicit USD $1 peg
 *      OR of any registered fiat / commodity peg (EUR, JPY, XAU, …) in
 *      {LibVaipakam.Storage.stableFeedBySymbol}. Fiat peg reference
 *      feeds are Chainlink 24h-heartbeat feeds themselves, so they are
 *      subject to the same 25h ceiling rather than the 2h volatile one.
 *
 *      ── Fail-closed semantics ──
 *      Liquidity classification is never manually overrideable (README
 *      §1.5); on-chain registry / feed / pool lookups fail-closed to
 *      Illiquid. getAssetPrice reverts on missing / stale data so
 *      callers (RiskFacet, LoanFacet) do not consume partial oracle
 *      state in risk math.
 */
contract OracleFacet is DiamondReentrancyGuard, DiamondPausable, DiamondAccessControl, IVaipakamErrors {
    error NoPriceFeed();
    error NoDexPool();
    error StalePriceData();
    error InsufficientLiquidity();
    /// @notice T-033 — Chainlink ETH/USD and Pyth ETH/USD diverged
    ///         beyond the governance-tunable
    ///         `pythCrossCheckMaxDeviationBps`. Fail-closed: a
    ///         numeraire reading the protocol can't agree on between
    ///         two independent oracles is a strong signal that one
    ///         of them has been compromised; we'd rather block
    ///         protocol ops than accept a price the system itself
    ///         can't trust.
    error OracleCrossCheckDivergence(
        uint256 chainlinkPrice,
        uint256 pythPrice,
        uint256 deviationBps,
        uint256 maxDeviationBps
    );

    /// @notice Chainlink and a configured secondary oracle (Tellor /
    ///         API3 / DIA) disagreed beyond the chain-level
    ///         `secondaryOracleMaxDeviationBps`. Fail-closed — callers
    ///         must NOT fall back to a single-source price. Phase 7b.2
    ///         replaced the previous Pyth-specific deviation gate with
    ///         this multi-source AND-combine.
    error OraclePriceDivergence();

    /// @notice Reverted when the L2 sequencer is currently offline.
    error SequencerDown();
    /// @notice Reverted when the L2 sequencer has been up for less than
    ///         `LibVaipakam.SEQUENCER_GRACE_PERIOD` seconds after a recovery.
    error SequencerGracePeriod();

    // 0.3% v3-style AMM fee tier — the standard ERC20/WETH venue. Resolved
    // live via `factory.getPool(tokenA, tokenB, fee)` so the same code path
    // works against the canonical v3-style AMM factory or any ABI-compatible
    // mock on a testnet.
    uint24 private constant UNIV3_FEE_TIER = 3000;

    // Phase 7b — fee tiers iterated by `_lookupPool` against any
    // V3-clone factory. Includes UniswapV3's standard set (100, 500,
    // 3000, 10000) plus PancakeV3's 2500 tier. The probe returns the
    // first non-zero pool address; an asset whose pool exists at any
    // one of these tiers gets classified. Order is by deployment
    // popularity so the lookup short-circuits on the most likely tier
    // first. Hardcoded as separate constants because Solidity's
    // `constant` keyword does not support fixed-size storage arrays.
    uint24 private constant V3_TIER_LOW       = 100;
    uint24 private constant V3_TIER_LOW_MID   = 500;
    uint24 private constant V3_TIER_PANCAKE   = 2500;
    uint24 private constant V3_TIER_STANDARD  = 3000;
    uint24 private constant V3_TIER_HIGH      = 10000;

    // Per-clone canonical fee tier for Uni-V2-fork pools (Piece B
    // follow-up b). UniV2 and SushiV2 charge a flat 30bps; PancakeV2
    // charges 25bps. Single fee per pool — no tier iteration like V3.
    uint24 private constant V2_FEE_30BPS = 3000;
    uint24 private constant V2_FEE_25BPS = 2500;

    /// @dev `2**96` — the fixed-point base for a Uniswap-V3-style pool's
    ///      `sqrtPriceX96`. Used in {_v3DepthLiquid} to reconstruct the
    ///      pool's virtual reserves from `(liquidity, sqrtPriceX96)`.
    uint256 private constant Q96 = 1 << 96;

    /**
     * @notice Classification entry point for "is this asset liquid on the
     *         active network?" used at transaction-authorization boundaries.
     * @dev Fail-closed: oracle / registry / pool failures default to
     *      Illiquid. WETH is treated as Liquid whenever ETH/USD is fresh.
     */
    function checkLiquidity(
        address asset
    ) external view returns (LibVaipakam.LiquidityStatus) {
        if (asset == address(0)) revert InvalidAsset();
        return _checkLiquidity(asset);
    }

    /**
     * @notice Active-network liquidity check. Functionally identical to
     *         {checkLiquidity}; retained as a dedicated entry point for
     *         execution-routing call sites.
     */
    function checkLiquidityOnActiveNetwork(
        address asset
    ) external view returns (LibVaipakam.LiquidityStatus) {
        if (asset == address(0)) revert InvalidAsset();
        return _checkLiquidity(asset);
    }

    /// @dev Internal dispatch. Pre-checks the sequencer circuit breaker
    ///      fail-closed, special-cases WETH, then runs the asset/WETH
    ///      pool depth + freshness gate for everything else.
    function _checkLiquidity(address asset) internal view returns (LibVaipakam.LiquidityStatus) {
        if (!_sequencerHealthy()) return LibVaipakam.LiquidityStatus.Illiquid;

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address weth = s.wethContract;
        address ethFeed = s.ethNumeraireFeed;
        if (weth == address(0) || ethFeed == address(0)) {
            return LibVaipakam.LiquidityStatus.Illiquid;
        }

        // WETH itself: no asset/WETH pool (circular); Liquid iff ETH/USD
        // is fresh (2h, no peg branch — ETH is volatile).
        if (asset == weth) {
            (bool ok, , ) = _readFreshUsdFeed(ethFeed, /*allowStablePeg=*/ false);
            return ok ? LibVaipakam.LiquidityStatus.Liquid : LibVaipakam.LiquidityStatus.Illiquid;
        }

        // Every other asset must have a fresh asset/USD OR asset/ETH
        // price feed (the same hybrid chain `getAssetPrice` uses), AND
        // clear a fixed-size swap (default `cfgFloorSizePad` = $5k) at
        // ≤ `cfgLiquiditySlippageBps` (default 2%) on AT LEAST ONE
        // (asset/quote × V3-or-V2-fork) route discovered on-chain via
        // the PAA list.
        //
        // §4.4 step 3 full upgrade (MarketRateWidgetAndDepthTieredLTV.md):
        // replaces the previous `_v3DepthLiquid` depth-at-tick metric
        // (`2 × WETH-leg-virtual-reserve × ethPrice ≥ MIN_LIQUIDITY_PAD`)
        // with a slippage simulation against the same route-search
        // machinery {_liquidityTier} uses for tier resolution, scoped
        // to the floor size. The depth-at-tick figure was a real PAD
        // value but it answered a structurally different question
        // ("how much virtual reserve sits in the current tick?") than
        // the one liquidation actually cares about ("can a liquidator
        // dump $X at ≤Y% slippage?"). The slippage check matches the
        // liquidation question 1:1, is decimal-independent, and adds
        // a value-balance guard (pool spot ≈ Chainlink feed) that the
        // depth-at-tick metric lacked — correctly excluding the
        // degenerate-decimals and price-manipulated cases the old
        // metric let through.
        //
        // A single venue's outage / pool drainage / censorship cannot
        // flip the asset to Illiquid as long as one other route (any
        // PAA quote × any configured V3 / V2 venue × any fee tier
        // ≤ 0.3%) still clears the floor at the configured slippage.
        // Zero per-asset governance config — pool discovery is
        // on-chain via `factory.getPool` / `factory.getPair`.
        (bool priceOk, , ) = tryGetAssetPrice(asset);
        if (!priceOk) return LibVaipakam.LiquidityStatus.Illiquid;

        // ETH/USD freshness — kept as a soft pre-flight: the
        // route-search itself rechecks each quote-asset's oracle via
        // `tryGetAssetPrice(q)`, but bailing out early here when
        // the ETH numeraire feed is stale matches the previous
        // behaviour and short-circuits the ~3 V3 staticcalls per PAA
        // quote that would otherwise run.
        (bool ethOk, , ) = _readFreshUsdFeed(ethFeed, false);
        if (!ethOk) return LibVaipakam.LiquidityStatus.Illiquid;

        return _passesFloorSlippage(asset, s)
            ? LibVaipakam.LiquidityStatus.Liquid
            : LibVaipakam.LiquidityStatus.Illiquid;
    }

    /// @dev Floor-size slippage check used by {_checkLiquidity}. An
    ///      asset is Liquid iff at least one route (PAA × V3-or-V2
    ///      venue × fee ≤ 0.3%) clears `cfgFloorSizePad` at slippage
    ///      ≤ `cfgLiquiditySlippageBps`. Reuses the same route-search
    ///      machinery {_liquidityTier} uses (`_routeOverQuote` →
    ///      `_accumulatePoolImpacts` / `_v2AccumulatePoolImpacts`),
    ///      constrained to size[0] only by zeroing sizes[1..3] (which
    ///      the accumulator's `sizes[si] == 0` guard skips).
    ///
    ///      §4.4 step 3 full upgrade — replaces the previous
    ///      {_v3DepthLiquid} depth-at-tick metric.
    function _passesFloorSlippage(address asset, LibVaipakam.Storage storage s)
        private
        view
        returns (bool)
    {
        (bool okA, uint256 pA, uint8 dA) = tryGetAssetPrice(asset);
        if (!okA || pA == 0) return false;
        _TierCtx memory ctx = _TierCtx({
            pA: pA,
            scaleA: 10 ** (uint256(dA) + uint256(_tryTokenDecimals(asset))),
            band: LibVaipakam.cfgTwapConsistencyBps(),
            twapWindow: uint32(LibVaipakam.cfgTwapWindowSec())
        });
        // Probe only the floor size; the other slots are 0 so
        // `_accumulatePoolImpacts` skips them via its
        // `sizes[si] == 0 ⇒ continue` guard.
        uint256[4] memory sizes = [
            LibVaipakam.cfgFloorSizePad(),
            uint256(0),
            uint256(0),
            uint256(0)
        ];
        uint256[4] memory best = [
            type(uint256).max,
            type(uint256).max,
            type(uint256).max,
            type(uint256).max
        ];
        address[] memory paa = LibVaipakam.effectivePaaAssets();
        for (uint256 qi; qi < paa.length; ++qi) {
            address q = paa[qi];
            if (q != address(0) && q != asset) {
                _routeOverQuote(asset, q, s, ctx, sizes, best);
            }
        }
        return best[0] <= LibVaipakam.cfgLiquiditySlippageBps();
    }

    /// @dev V3-style depth probe — the same code path applied against
    ///      any UniswapV3-fork factory address (UniswapV3 itself,
    ///      PancakeSwap V3, SushiSwap V3, or any other ABI-compatible
    ///      mock). Returns true iff `factory` exposes an asset/WETH
    ///      pool whose **depth-at-tick** meets
    ///      {LibVaipakam.MIN_LIQUIDITY_PAD} (= 1,000,000 PAD — the
    ///      Predominantly Available Denominator, USD on the retail
    ///      deploy; expressed in PAD × 1e6 units).
    ///
    ///      Depth metric — a real PAD figure, not the old
    ///      `liquidity() × ethPrice` heuristic (whose magnitude was
    ///      dominated by the paired token's decimals + unit price, so a
    ///      single global threshold against it meant little more than
    ///      "the pool isn't empty"). At the current tick a V3 pool's
    ///      virtual reserves are `x_v = L · 2⁹⁶ / √P_X96` and
    ///      `y_v = L · √P_X96 / 2⁹⁶` (token0 / token1 base units), and
    ///      the pool is value-balanced there — so the PAD value of the
    ///      WETH leg, doubled, is the depth a liquidator could trade
    ///      against without crossing ticks. We take the WETH leg (token1
    ///      when `asset < weth`, else token0), value it at the spot
    ///      ETH/PAD feed, and double it. `Math.mulDiv` keeps the 512-bit
    ///      intermediate from overflowing.
    ///
    ///      Still an approximation (the virtual-reserve interpretation
    ///      assumes liquidity straddles the tick symmetrically, so it
    ///      over-states tightly-concentrated correlated pairs), and
    ///      single-hop (asset/WETH only) — the graded tiering on top of
    ///      this floor (Piece B, behind `depthTieredLtvEnabled`) is the
    ///      place where multi-denominator + a correlated-pair guard go;
    ///      this floor stays the cheap "is there obvious spot depth"
    ///      gate.
    ///
    ///      A zero `factory` short-circuits to false so the parent
    ///      OR-combine in {_checkLiquidity} can transparently skip
    ///      whichever V3-clone isn't deployed on this chain.
    // `_v3DepthLiquid` (the previous depth-at-tick PAD-figure probe)
    // was retired in the §4.4 step 3 full upgrade — replaced by the
    // slippage-at-floor route search in `_passesFloorSlippage` above.
    // See the rationale block in `_checkLiquidity` for why the slippage
    // metric is the structurally correct one. The `_lookupPool` helper
    // it called is removed too — the new flow uses `_le03FeeTiers()`
    // (explicit ≤0.3% set) via `_tryGetPool` inside the route search.


    /**
     * @notice Calculates the Loan-to-Value (LTV) ratio for a loan in basis points.
     * @dev LTV = (borrowedValueUSD * 10000) / collateralValueUSD; 0 for
     *      zero-collateral. Uses {getAssetPrice} for both legs, which
     *      reverts on missing/stale feeds. Callers (RiskFacet, LoanFacet)
     *      should only invoke this for liquid loans.
     */
    function calculateLTV(
        address borrowedAsset,
        uint256 borrowedAmount,
        address collateralAsset,
        uint256 collateralAmount
    ) external view returns (uint256 ltv) {
        if (collateralAmount == 0) return 0;

        (uint256 borrowedPrice, uint8 borrowedDec) = this.getAssetPrice(borrowedAsset);
        (uint256 collateralPrice, uint8 collateralDec) = this.getAssetPrice(collateralAsset);

        uint256 borrowedValueUSD = (borrowedAmount * borrowedPrice) / (10 ** borrowedDec);
        uint256 collateralValueUSD = (collateralAmount * collateralPrice) / (10 ** collateralDec);

        ltv = (borrowedValueUSD * LibVaipakam.LTV_SCALE) / collateralValueUSD;
    }

    /**
     * @notice Gets the USD price of an asset (scaled by feed decimals).
     * @dev Hybrid resolution:
     *        1. WETH → direct {ethNumeraireFeed}.
     *        2. Other: try asset/USD via Feed Registry (preferred).
     *        3. Fallback: asset/ETH via Feed Registry × ETH/USD.
     *      All paths honour the 2h volatile / 25h stable-peg staleness
     *      rule and revert on failure. The L2 sequencer circuit breaker
     *      runs first so queued-tx price lag never reaches LTV/HF math.
     * @param asset The ERC20 token address.
     * @return price The USD price (scaled, 8 decimals for direct USD
     *         feeds; 8 decimals for the asset/ETH fallback — the ETH/USD
     *         feed dominates the scale).
     * @return decimals The feed's decimal scaling.
     */
    /// @notice Permissionless daily oracle snapshot.
    ///         AnalyticalGettersDesign §3.4 (decisions D9–D11).
    /// @dev    Anyone may call. First caller per UTC-day per asset
    ///         wins; subsequent same-day calls revert
    ///         {AlreadySnapshotted}. Stores the live Chainlink answer
    ///         (via {getAssetPrice}) into
    ///         `s.assetPriceSnapshots[asset][dayIndex]` for later
    ///         historical-TVL reconstruction by the frontend chart.
    /// @dev    Cadence is enforced by the per-(asset, dayIndex) storage
    ///         slot — once a day's slot is written, it stays. The
    ///         permissionless-keeper model (D10) means a single
    ///         missed cron tick is rescuable by any subsequent
    ///         caller before the day ends.
    /// @param  assets List of assets to snapshot in one tx (gas-
    ///         efficient batch). Order doesn't matter; per-asset
    ///         snapshots are independent.
    function captureDailyPriceSnapshot(address[] calldata assets) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 today = block.timestamp / 1 days;
        for (uint256 i = 0; i < assets.length; i++) {
            address asset = assets[i];
            // Skip silently if today's slot is already populated —
            // batch keepers shouldn't fail-fast on a single
            // already-captured asset, the rest may still need work.
            if (s.assetPriceSnapshots[asset][today].capturedAt != 0) continue;
            // try-call so a single asset whose feed is stale or whose
            // secondary-quorum check disagrees doesn't take down the
            // whole batch. The day's slot stays unwritten and any
            // subsequent caller can retry once the feed recovers.
            try this.getAssetPrice(asset) returns (uint256 price, uint8 feedDecimals) {
                s.assetPriceSnapshots[asset][today] = LibVaipakam.AssetPriceSnapshot({
                    // Cast: Chainlink price is positive in practice and
                    // we already revert on stale / negative answers
                    // upstream in `_primaryPrice`.
                    price: int256(price),
                    feedDecimals: feedDecimals,
                    capturedAt: uint64(block.timestamp)
                });
                emit DailyAssetPriceCaptured(asset, today, price, feedDecimals);
            } catch {
                // No-op for this asset; loop continues.
            }
        }
    }

    /// @notice Read a previously-captured daily oracle snapshot.
    /// @dev    Returns the zero-struct for unwritten days
    ///         (`capturedAt == 0` is the canonical "never captured"
    ///         signal). The frontend's historical-TVL chart shows
    ///         "data as of HH:MM UTC" using `capturedAt` for
    ///         transparency about lag (D11).
    /// @param  asset    Asset whose snapshot to read.
    /// @param  dayIndex `block.timestamp / 86400` of the queried day.
    function getHistoricalAssetPrice(address asset, uint32 dayIndex)
        external
        view
        returns (LibVaipakam.AssetPriceSnapshot memory snapshot)
    {
        snapshot = LibVaipakam.storageSlot().assetPriceSnapshots[asset][dayIndex];
    }

    /// @notice Emitted on each `(asset, dayIndex)` snapshot capture.
    /// @custom:event-category informational/config
    event DailyAssetPriceCaptured(
        address indexed asset,
        uint256 indexed dayIndex,
        uint256 price,
        uint8 feedDecimals
    );

    function getAssetPrice(
        address asset
    ) external view returns (uint256 price, uint8 decimals) {
        (price, decimals) = _primaryPrice(asset);
        // Phase 7b.2 — Soft 2-of-N cross-validation across Tellor +
        // API3 + DIA. The aggregator probes each source, classifies
        // its result as Unavailable / Agree / Disagree, and:
        //   - returns Chainlink-only when every secondary is
        //     Unavailable (graceful fallback for sparse coverage),
        //   - returns Chainlink + agreeing-secondary quorum when at
        //     least one secondary agrees,
        //   - reverts {OraclePriceDivergence} only when every
        //     responding secondary disagrees (no quorum possible).
        // Pyth was removed in Phase 7b.2: per-asset priceId mapping
        // conflicts with the no-per-asset-config policy.
        _enforceSecondaryQuorum(asset, price, decimals);
        return (price, decimals);
    }

    /// @dev Chainlink-only primary read returning a numeraire-quoted
    ///      price. Architecture (T-048 — Predominantly Available
    ///      Denominator):
    ///
    ///        Step A — Retail short-circuit:
    ///          if `PAD == numeraire` (the post-deploy default —
    ///          both are `Denominations.USD`), read `asset/PAD`
    ///          directly via Chainlink Feed Registry and return.
    ///          Single read, no FX multiply, math identical to the
    ///          pre-T-048 deploy. ETH-pivot fallback (asset/ETH ×
    ///          ETH/PAD) handles assets that lack a direct
    ///          asset/PAD feed.
    ///
    ///        Step B — Industrial-fork (PAD ≠ numeraire):
    ///          B.1: per-asset operator-curated override —
    ///               if `assetNumeraireDirectFeedOverride[asset]`
    ///               is set, read that Chainlink feed directly as
    ///               the numeraire-quoted asset price and return.
    ///               Operator vouches that the override is a
    ///               🟢-rated direct asset/<numeraire> feed; the
    ///               protocol does not cross-check it against Pyth.
    ///          B.2: PAD pivot —
    ///               read asset price in PAD-units (asset/PAD direct
    ///               feed; falls back to asset/ETH × ETH/PAD when
    ///               direct feed is absent), then multiply by the
    ///               PAD/<numeraire> FX rate (direct feed if set,
    ///               else derived from ETH/<numeraire> ÷ ETH/PAD).
    ///               This routes all asset pricing through Chainlink's
    ///               top-rated USD feed set, structurally biasing
    ///               toward verified-quality data without needing
    ///               on-chain rating metadata.
    ///
    ///        Step C — All paths failed: revert {NoPriceFeed}.
    ///
    ///      The Phase 3.2 deviation check runs AFTER this returns.
    function _primaryPrice(
        address asset
    ) private view returns (uint256 price, uint8 decimals) {
        _requireSequencerHealthy();

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // Retail short-circuit: PAD == numeraire. Both are USD by the
        // post-deploy default; the asset/PAD read IS the numeraire-
        // quoted price. Behaviour identical to the pre-T-048 deploy.
        // Also covers pre-T-048 deploys (PAD == address(0)) where the
        // legacy numeraire-direct path stays active via
        // `_padPriceWithFallback` reading asset/numeraireDenominator.
        if (LibVaipakam.isPadEqualToNumeraire() || s.predominantDenominator == address(0)) {
            return _padPriceWithFallback(s, asset);
        }

        // Industrial-fork: PAD ≠ numeraire.

        // Step B.1: per-asset operator-curated override. When set, use
        // the direct asset/<numeraire> feed and skip the PAD pivot.
        // Operator vouches that the feed is verified-rated; no Pyth
        // cross-check (Pyth gate is configured for ETH/<numeraire>,
        // not asset/<numeraire>).
        address overrideFeed = s.assetNumeraireDirectFeedOverride[asset];
        if (overrideFeed != address(0)) {
            (uint256 op, uint8 od) = _readAggregatorStrict(
                overrideFeed,
                /*allowStablePeg=*/ true
            );
            return (op, od);
        }

        // Step B.2: PAD pivot.
        // Read asset price in PAD-units, then convert to numeraire.
        (uint256 padPrice, uint8 padDec) = _padPriceWithFallback(s, asset);

        // PAD/numeraire FX rate — direct feed if set, else derived
        // from ETH/<numeraire> ÷ ETH/PAD.
        (uint256 fxRate, uint8 fxDec) = _padNumeraireRate(s);

        // Compose: numeraire price = padPrice × fxRate / 10^fxDec.
        // Resulting decimals match `padDec` (Chainlink USD-quoted
        // feeds are 8-decimal; Feed Registry asset/USD feeds are
        // typically 8-decimal too). The fxDec cancellation keeps the
        // composed value in the same scale as the pad-quoted leg.
        uint256 numerPrice = (padPrice * fxRate) / (10 ** fxDec);
        return (numerPrice, padDec);
    }

    /// @dev Read asset price in PAD-units. Tries Chainlink Feed
    ///      Registry `asset/<padDenominator>` first; falls back to
    ///      `asset/ETH × ETH/PAD` for assets that lack a direct
    ///      USD-quoted feed (rare on the major asset set, but
    ///      possible). Special-cases WETH itself to read `ethPadFeed`
    ///      directly without the registry detour.
    ///
    ///      Pre-T-048 deploy compatibility: when
    ///      `predominantDenominator == address(0)`, the legacy
    ///      numeraire-direct path stays active. `usdDenom` falls back
    ///      to `numeraireChainlinkDenominator`; `ethPadAnchor` falls
    ///      back to `ethNumeraireFeed`. Behaviour identical to the
    ///      pre-T-048 deploy.
    function _padPriceWithFallback(
        LibVaipakam.Storage storage s,
        address asset
    ) private view returns (uint256 price, uint8 decimals) {
        address weth = s.wethContract;
        address padDenom = s.predominantDenominator;
        if (padDenom == address(0)) padDenom = s.numeraireChainlinkDenominator;
        address ethPadAnchor = s.ethPadFeed;
        if (ethPadAnchor == address(0)) ethPadAnchor = s.ethNumeraireFeed;

        // WETH → read ETH/PAD directly.
        if (asset != address(0) && asset == weth) {
            if (ethPadAnchor == address(0)) revert NoPriceFeed();
            (uint256 p, uint8 d) = _readAggregatorStrict(ethPadAnchor, /*allowStablePeg=*/ false);
            // T-033 numeraire-redundancy gate: cross-validate the
            // Chainlink ETH-anchor reading against Pyth's snapshot.
            // Soft-skips if Pyth is unset / stale / low-confidence;
            // reverts on divergence beyond tolerance.
            _validatePythCrossCheck(p, d);
            return (p, d);
        }

        // Primary: asset/PAD via Feed Registry.
        address registry = s.chainlnkRegistry;
        if (registry != address(0) && padDenom != address(0)) {
            AggregatorV3Interface feed = _registryFeed(registry, asset, padDenom);
            if (address(feed) != address(0)) {
                (uint256 p, uint8 d) = _readAggregatorStrict(address(feed), /*allowStablePeg=*/ true);
                return (p, d);
            }
        }

        // Fallback: asset/ETH × ETH/PAD via Feed Registry.
        address ethDenom = s.ethChainlinkDenominator;
        if (registry != address(0) && ethDenom != address(0) && ethPadAnchor != address(0)) {
            AggregatorV3Interface ethQuotedFeed = _registryFeed(registry, asset, ethDenom);
            if (address(ethQuotedFeed) != address(0)) {
                (uint256 assetPerEth, uint8 assetPerEthDec) = _readAggregatorStrict(
                    address(ethQuotedFeed),
                    /*allowStablePeg=*/ false
                );
                (uint256 ethPerPad, uint8 ethDec) = _readAggregatorStrict(ethPadAnchor, false);
                _validatePythCrossCheck(ethPerPad, ethDec);
                uint256 combined = (assetPerEth * ethPerPad) / (10 ** assetPerEthDec);
                return (combined, ethDec);
            }
        }

        revert NoPriceFeed();
    }

    /// @dev Resolve the PAD/<numeraire> FX rate. Tries the direct
    ///      Chainlink feed (`padNumeraireRateFeed`) when set; else
    ///      derives the rate from `ETH/<numeraire> ÷ ETH/PAD`.
    ///      Reverts {PadNumeraireRateUnavailable} if neither path is
    ///      reachable — a configuration error caught at first read,
    ///      not a runtime failure.
    ///
    ///      Returned `(rate, decimals)`: rate is in `decimals`-scale
    ///      (e.g. 8-dec when the feed is Chainlink USD/EUR which is
    ///      8-decimal). The caller composes `assetPriceInPad ×
    ///      rate / 10^decimals` to get a numeraire-quoted price in
    ///      the same scale as the asset/PAD leg.
    function _padNumeraireRate(LibVaipakam.Storage storage s)
        private
        view
        returns (uint256 rate, uint8 decimals)
    {
        address direct = s.padNumeraireRateFeed;
        if (direct != address(0)) {
            (uint256 r, uint8 d) = _readAggregatorStrict(direct, /*allowStablePeg=*/ true);
            return (r, d);
        }

        // Derive: PAD/<numeraire> = ETH/<numeraire> ÷ ETH/PAD.
        address ethNumerFeed = s.ethNumeraireFeed;
        address ethPadFeed = s.ethPadFeed;
        if (ethNumerFeed == address(0) || ethPadFeed == address(0)) {
            revert IVaipakamErrors.PadNumeraireRateUnavailable();
        }

        (uint256 ethNumer, uint8 ethNumerDec) = _readAggregatorStrict(ethNumerFeed, false);
        (uint256 ethPad, uint8 ethPadDec) = _readAggregatorStrict(ethPadFeed, false);

        // Both ETH-anchored feeds get the Pyth cross-check (the same
        // gate that PAD-pivot WETH and ETH-pivot fallback already use).
        _validatePythCrossCheck(ethPad, ethPadDec);

        // Normalize both to a common scale before division. We pick
        // the larger of (ethNumerDec, ethPadDec) as the working
        // decimals so neither leg loses precision via truncation.
        uint8 outDec = ethNumerDec > ethPadDec ? ethNumerDec : ethPadDec;
        uint256 ethNumerScaled = _rescale(ethNumer, ethNumerDec, outDec);
        uint256 ethPadScaled = _rescale(ethPad, ethPadDec, outDec);
        if (ethPadScaled == 0) revert IVaipakamErrors.PadNumeraireRateUnavailable();

        // rate = ethNumer / ethPad, then re-scaled into `outDec` so
        // the caller's composition `padPrice × rate / 10^outDec`
        // lands at `padPrice`'s native decimals.
        rate = (ethNumerScaled * (10 ** outDec)) / ethPadScaled;
        decimals = outDec;
    }

    // ─── T-033 — Pyth numeraire-redundancy gate ────────────────────────────

    /// @dev Cross-validate a Chainlink ETH/USD reading against Pyth's
    ///      latest snapshot. Soft-skips (no-op) when the gate is
    ///      effectively disabled or Pyth's data isn't trustworthy
    ///      for this read; reverts on a real divergence.
    ///
    ///      Soft-skip cases (gate degrades to Chainlink-only):
    ///        - `pythOracle` unset (governance-disabled).
    ///        - `pythCrossCheckFeedId` unset (governance-disabled at
    ///          the feed-id layer).
    ///        - `getPriceUnsafe` reverts (Pyth contract misbehaves /
    ///          missing on this chain).
    ///        - Pyth `publishTime` older than the staleness budget.
    ///        - Pyth `conf / |price|` exceeds the confidence ceiling
    ///          (publisher window too thin to trust on this read).
    ///        - Pyth `price <= 0` (negative or zero, never expected
    ///          on a USD peg).
    ///
    ///      Hard-fail case:
    ///        - `|chainlinkPx - pythPx| / chainlinkPx >
    ///          maxDeviationBps`. Reverts with
    ///          {OracleCrossCheckDivergence} so the caller surfaces a
    ///          structured error instead of a generic price-failure.
    function _validatePythCrossCheck(
        uint256 chainlinkPrice,
        uint8 chainlinkDecimals
    ) private view {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address pyth = s.pythOracle;
        bytes32 feedId = s.pythCrossCheckFeedId;
        if (pyth == address(0) || feedId == bytes32(0)) return;

        IPyth.Price memory snap;
        try IPyth(pyth).getPriceUnsafe(feedId) returns (
            IPyth.Price memory p
        ) {
            snap = p;
        } catch {
            return; // Pyth contract misbehaved — soft-skip.
        }

        // Negative / zero price is non-credible on a USD peg.
        if (snap.price <= 0) return;

        // Staleness gate.
        uint64 maxStale = LibVaipakam.effectivePythMaxStalenessSeconds();
        if (block.timestamp > snap.publishTime + maxStale) return;

        // Normalize Pyth's (price, expo) → uint256 in `chainlinkDecimals`-
        // scale so the deviation comparison is unit-consistent.
        uint256 pythScaled = _pythPriceToScale(
            uint256(uint64(snap.price)),
            snap.expo,
            chainlinkDecimals
        );
        if (pythScaled == 0) return;

        // Confidence-fraction gate: skip when conf/price exceeds
        // `pythConfidenceMaxBps`. Computed in Pyth's native scale
        // (no normalization needed for the ratio).
        uint16 confMax = LibVaipakam.effectivePythConfidenceMaxBps();
        uint256 confBps = (uint256(snap.conf) * LibVaipakam.BASIS_POINTS) /
            uint256(uint64(snap.price));
        if (confBps > confMax) return;

        // Divergence gate (the load-bearing check). Computed against
        // the Chainlink reading as the reference; either direction
        // breaches the tolerance.
        uint256 absDelta = chainlinkPrice > pythScaled
            ? chainlinkPrice - pythScaled
            : pythScaled - chainlinkPrice;
        uint256 deviationBps = (absDelta * LibVaipakam.BASIS_POINTS) / chainlinkPrice;
        uint256 maxDev = uint256(LibVaipakam.effectivePythCrossCheckMaxDeviationBps());
        if (deviationBps > maxDev) {
            revert OracleCrossCheckDivergence(
                chainlinkPrice,
                pythScaled,
                deviationBps,
                maxDev
            );
        }
    }

    /// @dev Convert Pyth's (price, expo) representation into a
    ///      uint256 expressed in `targetDecimals`. Pyth feeds carry
    ///      a signed `expo` (typically negative — e.g. ETH/USD =
    ///      price * 10^-8). We compose:
    ///        scaled = price * 10^(targetDecimals + expo)
    ///      where `targetDecimals + expo` may be negative (Pyth
    ///      precision finer than Chainlink) or positive (coarser).
    function _pythPriceToScale(
        uint256 priceMagnitude,
        int32 expo,
        uint8 targetDecimals
    ) private pure returns (uint256) {
        int256 net = int256(uint256(targetDecimals)) + int256(expo);
        if (net >= 0) {
            // Multiply up. Bound the exponent to avoid overflow in
            // pathological feed configurations (Pyth's documented
            // expo range is -18..0; we cap at 30 for hardening).
            if (net > 30) return 0;
            return priceMagnitude * (10 ** uint256(net));
        } else {
            uint256 down = uint256(-net);
            if (down > 30) return 0;
            return priceMagnitude / (10 ** down);
        }
    }

    // ─── Phase 7b.2 — symbol-derived secondary oracles + Soft 2-of-N ─
    //
    // Three cross-validation oracles (Tellor, API3, DIA), all keyed
    // by the asset's ERC-20 symbol read on-chain at call time. Zero
    // per-asset governance config — operators set ONE chain-level
    // address per oracle; the OracleFacet derives query ids / dapi
    // names / DIA keys from `asset.symbol()`.
    //
    // Combine rule (Soft 2-of-N quorum):
    //   1. Each enforcer probes its source and returns a status:
    //        - {Unavailable}: oracle not configured / symbol unreadable
    //          / no data / stale → silent skip, doesn't count.
    //        - {Agree}: data fresh AND within deviation tolerance → +1.
    //        - {Disagree}: data fresh AND beyond tolerance.
    //   2. The aggregator counts how many secondaries agree and how
    //      many disagree. Chainlink itself is the primary (always 1
    //      "agreement" with itself).
    //   3. Decision:
    //        - All secondaries Unavailable → accept (graceful fallback
    //          to Chainlink-only; preserves Phase 1 chain coverage on
    //          long-tail assets).
    //        - At least one Agrees → accept (quorum hit: Chainlink + 1
    //          secondary = 2 sources within tolerance).
    //        - Some Disagrees AND no Agrees → revert
    //          {OraclePriceDivergence}.

    enum SecondaryStatus { Unavailable, Agree, Disagree }

    /// @dev Aggregator that runs the Tellor + API3 + DIA probes and
    ///      enforces the Soft 2-of-N quorum rule documented above.
    function _enforceSecondaryQuorum(
        address asset,
        uint256 primaryPrice,
        uint8 primaryDec
    ) private view {
        SecondaryStatus tellor = _checkTellor(asset, primaryPrice, primaryDec);
        SecondaryStatus api3 = _checkApi3(asset, primaryPrice, primaryDec);
        SecondaryStatus dia = _checkDIA(asset, primaryPrice, primaryDec);

        bool anyAgree = tellor == SecondaryStatus.Agree ||
            api3 == SecondaryStatus.Agree ||
            dia == SecondaryStatus.Agree;
        bool anyDisagree = tellor == SecondaryStatus.Disagree ||
            api3 == SecondaryStatus.Disagree ||
            dia == SecondaryStatus.Disagree;

        // Soft fallback: every secondary returned Unavailable. Accept
        // Chainlink-only — preserves operability on long-tail assets
        // and chains with sparse oracle coverage.
        if (!anyDisagree && !anyAgree) return;

        // Quorum hit: at least one secondary agrees. Even if another
        // disagrees, the protocol has 2-of-N agreement (Chainlink +
        // the agreeing secondary). Accept.
        if (anyAgree) return;

        // anyDisagree && !anyAgree — every secondary that returned
        // data disagreed. No quorum can be formed; revert.
        revert OraclePriceDivergence();
    }

    /// @dev Tellor probe — returns the per-source status against
    ///      Chainlink. Standard SpotPrice queryId derivation:
    ///      `keccak256(abi.encode("SpotPrice", abi.encode(symbol, "usd")))`
    ///      where `symbol` is the asset's lowercased ERC-20 symbol.
    function _checkTellor(
        address asset,
        uint256 primaryPrice,
        uint8 primaryDec
    ) private view returns (SecondaryStatus) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address oracle = s.tellorOracle;
        if (oracle == address(0)) return SecondaryStatus.Unavailable;

        (string memory symbol, bool symOk) = _safeSymbol(asset);
        if (!symOk) return SecondaryStatus.Unavailable;
        string memory lower = _toLower(symbol);

        // T-034 Numeraire generalization (B1): lower-case numeraire symbol from
        // storage (e.g. "usd", "eur", "xau"). Empty bytes32 default
        // is interpreted as "usd" so the post-deploy behaviour is
        // unchanged out of the box.
        string memory numerLower = _numeraireLowerSymbol();
        bytes32 queryId = keccak256(
            abi.encode("SpotPrice", abi.encode(lower, numerLower))
        );
        bytes memory raw;
        uint256 reportedAt;
        try ITellor(oracle).getDataBefore(queryId, block.timestamp) returns (
            bytes memory v,
            uint256 t
        ) {
            raw = v;
            reportedAt = t;
        } catch {
            return SecondaryStatus.Unavailable;
        }
        if (reportedAt == 0 || raw.length < 32) return SecondaryStatus.Unavailable;
        if (block.timestamp - reportedAt > LibVaipakam.effectiveSecondaryOracleMaxStaleness()) {
            return SecondaryStatus.Unavailable;
        }
        uint256 tellorAt18 = abi.decode(raw, (uint256));
        if (tellorAt18 == 0) return SecondaryStatus.Unavailable;
        uint256 secondary = _rescale(tellorAt18, 18, primaryDec);
        if (secondary == 0) return SecondaryStatus.Unavailable;
        return _classifyDeviation(primaryPrice, secondary);
    }

    /// @dev API3 probe. dAPI name = `<UPPER_SYMBOL>/USD` packed
    ///      left-aligned into bytes32, hashed with keccak256.
    function _checkApi3(
        address asset,
        uint256 primaryPrice,
        uint8 primaryDec
    ) private view returns (SecondaryStatus) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address server = s.api3ServerV1;
        if (server == address(0)) return SecondaryStatus.Unavailable;

        (string memory symbol, bool symOk) = _safeSymbol(asset);
        if (!symOk) return SecondaryStatus.Unavailable;
        string memory upper = _toUpper(symbol);

        // T-034 Numeraire generalization (B1): dAPI name uses the active numeraire's
        // upper-case symbol from storage (default "USD").
        bytes memory packed = abi.encodePacked(upper, "/", _numeraireUpperSymbol());
        if (packed.length > 32) return SecondaryStatus.Unavailable;
        bytes32 dapiName;
        for (uint256 i = 0; i < packed.length; ++i) {
            dapiName |= bytes32(packed[i]) >> (i * 8);
        }
        bytes32 dapiNameHash = keccak256(abi.encodePacked(dapiName));

        int224 value;
        uint32 reportedAt;
        try IApi3ServerV1(server).readDataFeedWithDapiNameHash(dapiNameHash) returns (
            int224 v,
            uint32 t
        ) {
            value = v;
            reportedAt = t;
        } catch {
            return SecondaryStatus.Unavailable;
        }
        if (value <= 0 || reportedAt == 0) return SecondaryStatus.Unavailable;
        if (block.timestamp - reportedAt > LibVaipakam.effectiveSecondaryOracleMaxStaleness()) {
            return SecondaryStatus.Unavailable;
        }
        uint256 secondary = _rescale(uint256(int256(value)), 18, primaryDec);
        if (secondary == 0) return SecondaryStatus.Unavailable;
        return _classifyDeviation(primaryPrice, secondary);
    }

    /// @dev DIA probe. Key = `<UPPER_SYMBOL>/USD` (e.g. "ETH/USD").
    ///      DIA returns 8-decimal `(uint128 value, uint128 timestamp)`.
    function _checkDIA(
        address asset,
        uint256 primaryPrice,
        uint8 primaryDec
    ) private view returns (SecondaryStatus) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address oracle = s.diaOracleV2;
        if (oracle == address(0)) return SecondaryStatus.Unavailable;

        (string memory symbol, bool symOk) = _safeSymbol(asset);
        if (!symOk) return SecondaryStatus.Unavailable;
        // T-034 Numeraire generalization (B1): DIA key uses the active numeraire's
        // upper-case symbol from storage (default "USD").
        string memory key = string(abi.encodePacked(_toUpper(symbol), "/", _numeraireUpperSymbol()));

        uint128 value;
        uint128 reportedAt;
        try IDIAOracleV2(oracle).getValue(key) returns (
            uint128 v,
            uint128 t
        ) {
            value = v;
            reportedAt = t;
        } catch {
            return SecondaryStatus.Unavailable;
        }
        if (value == 0 || reportedAt == 0) return SecondaryStatus.Unavailable;
        if (block.timestamp - uint256(reportedAt) > LibVaipakam.effectiveSecondaryOracleMaxStaleness()) {
            return SecondaryStatus.Unavailable;
        }
        uint256 secondary = _rescale(uint256(value), 8, primaryDec);
        if (secondary == 0) return SecondaryStatus.Unavailable;
        return _classifyDeviation(primaryPrice, secondary);
    }

    /// @dev T-034 Numeraire generalization (B1) — read the numeraire symbol from
    ///      storage and convert to a lowercase Solidity string for
    ///      the symbol-derived secondary oracle query construction.
    ///      Empty bytes32 (governance never wrote the slot) defaults
    ///      to "usd" so the post-deploy behaviour matches the
    ///      pre-sweep deploy out of the box. The bytes32 is assumed
    ///      to already be lowercase ASCII (governance writes it that
    ///      way); we walk to the first null byte and emit a string of
    ///      that length. No reverse-case-fold needed.
    function _numeraireLowerSymbol() private view returns (string memory) {
        bytes32 raw = LibVaipakam.storageSlot().numeraireSymbol;
        if (raw == bytes32(0)) return "usd";
        // Walk to the first null byte (max length 32).
        uint256 len;
        for (len = 0; len < 32; ++len) {
            if (raw[len] == 0) break;
        }
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            out[i] = raw[i];
        }
        return string(out);
    }

    /// @dev T-034 Numeraire generalization (B1) — uppercase variant for API3 / DIA
    ///      query construction. Reuses `_numeraireLowerSymbol` then
    ///      upper-cases via the existing `_toUpper` helper.
    function _numeraireUpperSymbol() private view returns (string memory) {
        return _toUpper(_numeraireLowerSymbol());
    }

    /// @dev Classify a (primary, secondary) pair as Agree or Disagree
    ///      based on the chain-level deviation tolerance.
    function _classifyDeviation(
        uint256 primary,
        uint256 secondary
    ) private view returns (SecondaryStatus) {
        uint256 diff = primary > secondary ? primary - secondary : secondary - primary;
        uint256 deviationBps = (diff * LibVaipakam.BASIS_POINTS) / primary;
        if (deviationBps > LibVaipakam.effectiveSecondaryOracleMaxDeviationBps()) {
            return SecondaryStatus.Disagree;
        }
        return SecondaryStatus.Agree;
    }

    /// @dev Read `IERC20.symbol()` via try/staticcall. Falls back
    ///      gracefully on tokens that revert, return bytes32, or
    ///      omit the function entirely. Returns `(symbol, true)` on
    ///      success, `("", false)` otherwise.
    function _safeSymbol(address asset) private view returns (string memory, bool) {
        (bool ok, bytes memory ret) = asset.staticcall(
            abi.encodeWithSignature("symbol()")
        );
        if (!ok || ret.length == 0) return ("", false);
        // String return: ABI-encoded as offset(32) + length(32) + data.
        // Detect by checking the offset is exactly 32.
        if (ret.length >= 64) {
            uint256 off;
            assembly { off := mload(add(ret, 32)) }
            if (off == 32) {
                string memory s = abi.decode(ret, (string));
                if (bytes(s).length == 0) return ("", false);
                return (s, true);
            }
        }
        // Bytes32 return (legacy bytes32-symbol tokens). Strip
        // trailing zeros and convert.
        if (ret.length == 32) {
            bytes32 raw;
            assembly { raw := mload(add(ret, 32)) }
            uint256 len = 0;
            while (len < 32 && raw[len] != 0) {
                ++len;
            }
            if (len == 0) return ("", false);
            bytes memory out = new bytes(len);
            for (uint256 i = 0; i < len; ++i) {
                out[i] = raw[i];
            }
            return (string(out), true);
        }
        return ("", false);
    }

    /// @dev Returns the lowercase form of an ASCII string. Non-ASCII
    ///      bytes pass through unchanged.
    function _toLower(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(b.length);
        for (uint256 i = 0; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c >= 0x41 && c <= 0x5A) {
                out[i] = bytes1(c + 32);
            } else {
                out[i] = b[i];
            }
        }
        return string(out);
    }

    /// @dev Returns the uppercase form of an ASCII string.
    function _toUpper(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(b.length);
        for (uint256 i = 0; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c >= 0x61 && c <= 0x7A) {
                out[i] = bytes1(c - 32);
            } else {
                out[i] = b[i];
            }
        }
        return string(out);
    }

    /// @dev Rescale a price value from `fromDec` to `toDec` decimals.
    ///      Returns 0 if scaling down would round to zero (caller
    ///      treats as unavailable).
    function _rescale(uint256 value, uint8 fromDec, uint8 toDec) private pure returns (uint256) {
        if (fromDec == toDec) return value;
        if (fromDec < toDec) return value * (10 ** uint256(toDec - fromDec));
        return value / (10 ** uint256(fromDec - toDec));
    }

    // ─── README §13.5 asset-risk views ──────────────────────────────────

    /**
     * @notice Asset risk-parameter profile. Mirrors `RiskParams` with the
     *         Liquid/Illiquid classification decided live from
     *         {checkLiquidity}. Never reverts.
     * @dev    PR2 of internal-match work (2026-05-14) dropped
     *         `liqThresholdBps` from the return tuple — the per-asset
     *         liquidation threshold was retired in favour of per-tier
     *         values. Frontend should read the effective per-tier
     *         liquidation LTV via the tier returned by
     *         `getEffectiveLiquidityTier(asset)` + the
     *         `getTierLiquidationLtvBps()` view on `ConfigFacet`.
     */
    function getAssetRiskProfile(address token)
        external
        view
        returns (
            bool isSupported,
            LibVaipakam.LiquidityStatus status,
            uint256 loanInitMaxLtvBps,
            uint256 liqBonusBps
        )
    {
        if (token == address(0)) {
            return (false, LibVaipakam.LiquidityStatus.Illiquid, 0, 0);
        }
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.RiskParams storage rp = s.assetRiskParams[token];
        loanInitMaxLtvBps = rp.loanInitMaxLtvBps;
        liqBonusBps = rp.liqBonusBps;
        status = _checkLiquidity(token);
        isSupported = status == LibVaipakam.LiquidityStatus.Liquid;
    }

    // ─── Depth-tiered LTV (Piece B) — liquidity-tier views ──────────────

    /**
     * @notice The on-chain liquidity tier of `asset` — `0` if it doesn't
     *         classify `Liquid` (or can't clear the `floorSizePad`
     *         simulated swap at the configured slippage bound), else `1`,
     *         `2`, or `3` per the highest `tierNSizePad` whose simulated
     *         sell it absorbs at ≤ `liquiditySlippageBps`.
     * @dev    Permissionless tiering: this function *is* the on-chain tier
     *         authority — no governance per-asset allowlist (the only
     *         per-asset lever is the existing `AdminFacet.pauseAsset` /
     *         blacklist, which makes `_checkLiquidity` fail). See
     *         docs/DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md
     *         §4.1-§4.2.
     *
     *         The simulated swap is the cheap in-tick constant-product
     *         approximation on a Uni-V3-clone pool's virtual reserves
     *         ({LibSlippage}). Route search: best (lowest-impact) route
     *         over `{asset/q : q ∈ effectivePaaAssets()} × {UniswapV3,
     *         PancakeSwap V3, SushiSwap V3 factories} × {fee tiers ≤ 0.3%
     *         (100/500/2500/3000)}`. Two manipulation guards exclude a
     *         pool from the route search: (i) the pool's two legs must be
     *         value-balanced within `twapConsistencyBps` when priced at
     *         the assets' Chainlink feeds (= the pool's spot price agrees
     *         with the trusted feed), and (ii) if the pool's on-chain
     *         TWAP oracle is initialised, its `twapWindowSec`-mean tick
     *         must be within `twapConsistencyBps` of the current tick
     *         (catches a recently-manipulated pool). If `observe` reverts
     *         (un-bumped observation cardinality) only guard (ii) is
     *         skipped — guard (i) still applies — so a manipulator can't
     *         dodge the price check by routing through a low-cardinality
     *         pool.
     *
     *         Always returns the *real* tier — `depthTieredLtvEnabled`
     *         gates whether the loan-init LTV cap *consults* it, not what
     *         this view reports (so the keeper / frontend can read tiers
     *         even while the feature is dormant). Cost: a `view`; on-chain
     *         it's hit once per `initiateLoan` (collateral asset only)
     *         while the kill-switch is on.
     * @param asset The collateral / lending asset to classify.
     * @return tier  `0`..`3` (`0` = illiquid / untierable).
     */
    function getLiquidityTier(address asset) external view returns (uint8 tier) {
        if (asset == address(0)) return 0;
        return _liquidityTier(asset, LibVaipakam.storageSlot());
    }

    /**
     * @notice The *effective* liquidity tier — `min(getLiquidityTier(asset),
     *         keeperTier(asset))`, where `keeperTier` defaults to `1`
     *         (today's `HF ≥ 1.5` baseline) until the off-chain
     *         liquidity-confidence relay (`KEEPER_ROLE`, §4.4 step 5)
     *         promotes the asset. This is what the loan-init LTV cap
     *         consults when `depthTieredLtvEnabled`.
     * @dev    The `min` means: a new asset opens at Tier 1 until the
     *         keeper confirms; a compromised keeper can only *lower* an
     *         asset's tier toward the no-keeper baseline, never raise it
     *         above the on-chain ceiling; and an illiquid asset
     *         (`getLiquidityTier == 0`) stays Tier 0 regardless of the
     *         keeper default.
     */
    function getEffectiveLiquidityTier(address asset) external view returns (uint8 tier) {
        if (asset == address(0)) return 0;
        uint8 onChain = _liquidityTier(asset, LibVaipakam.storageSlot());
        if (onChain == 0) return 0;
        uint8 keeper = LibVaipakam.effectiveKeeperTier(asset);
        return onChain < keeper ? onChain : keeper;
    }

    // ─── Phase 4: autonomous tier-LTV cache ─────────────────────────────

    /// @notice Emitted when a tier's LTV cache is updated by a
    ///         successful refresh. `newLtvBps` already had the per-tier
    ///         haircut applied and passed the per-tier safety-box
    ///         bound check.
    /// @custom:event-category state-change/risk-config
    event TierLtvCacheUpdated(
        uint8 indexed tier,
        uint16 newLtvBps,
        uint16 oldLtvBps,
        uint8 assetsContributing
    );

    /// @notice Emitted when a tier's refresh attempt was rejected.
    ///         Reason codes (free-form strings, indexer matches on the
    ///         exact text):
    ///           - "no-reference-assets"     — `tierReferenceAssets[tier]` empty.
    ///           - "insufficient-readings"   — fewer than 2 reference
    ///                                          assets passed per-asset consensus.
    ///           - "out-of-band-low"         — candidate < tier floor.
    ///           - "out-of-band-high"        — candidate > tier ceiling.
    /// @custom:event-category state-change/risk-config
    event TierLtvCacheRefreshRejected(
        uint8 indexed tier,
        uint16 candidateLtvBps,
        string reason
    );

    /**
     * @notice Refresh the per-tier LTV cache by reading peer-protocol
     *         configs on-chain and aggregating per the tier-specific
     *         safety bounds. Permissionless — anyone can call.
     *
     * @dev    Reads Aave V3 + Compound V3 via {LibPeerLTV}. Per-asset
     *         consensus requires ≥ 2 peers agree within 15 BPS for
     *         each reference asset (the divergence-tolerance guard).
     *         Per-tier consensus requires ≥ 2 reference assets
     *         contribute (the multi-asset-stability guard). After
     *         aggregation, the per-tier haircut is subtracted and
     *         the result is bound-checked against the tier's safety
     *         box (`[floor, ceil]` per `LibVaipakam.tierLtvBoundsBps`).
     *
     *         Rejected candidates leave the previous cached value
     *         untouched (and the previous `lastRefreshedAt` unchanged).
     *         The function emits a `TierLtvCacheRefreshRejected` for
     *         the affected tier and CONTINUES to the next tier — a
     *         bad reading on Tier 3 doesn't block a clean refresh of
     *         Tier 1 / 2.
     *
     *         Gas cost: 30-50k per peer × N reference assets per tier
     *         × 3 tiers. With a typical 5-asset reference list per
     *         tier and 2 peers configured, ~750k-1.5M gas per refresh.
     *         No rate-limit (per-refresh gas is the natural one);
     *         honest operators / MEV bots are expected to invoke
     *         when peer governance changes.
     */
    function refreshTierLtvCache() external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address aave = s.aaveV3PoolDataProvider;
        address comet = s.compoundV3Comet;

        for (uint8 tier = 1; tier <= 3; ++tier) {
            address[] memory refAssets = LibVaipakam.getTierReferenceAssets(tier);
            if (refAssets.length == 0) {
                emit TierLtvCacheRefreshRejected(tier, 0, "no-reference-assets");
                continue;
            }
            (bool ok, uint16 tierMedian, ) = LibPeerLTV.aggregateTierLtv(
                aave,
                comet,
                refAssets,
                LibVaipakam.PEER_DIVERGENCE_TOLERANCE_BPS,
                LibVaipakam.TIER_MIN_PEER_READINGS,
                LibVaipakam.TIER_MIN_ASSET_READINGS
            );
            if (!ok) {
                emit TierLtvCacheRefreshRejected(tier, 0, "insufficient-readings");
                continue;
            }

            // Apply per-tier haircut (saturate at 0 — never wrap).
            uint16 haircut = LibVaipakam.tierLtvHaircutBps(tier);
            uint16 candidate = tierMedian > haircut ? tierMedian - haircut : 0;

            // Bound-check against the tier's safety box.
            (uint16 floorBps, uint16 ceilBps) = LibVaipakam.tierLtvBoundsBps(tier);
            if (candidate < floorBps) {
                emit TierLtvCacheRefreshRejected(tier, candidate, "out-of-band-low");
                continue;
            }
            if (candidate > ceilBps) {
                emit TierLtvCacheRefreshRejected(tier, candidate, "out-of-band-high");
                continue;
            }

            // Persist + emit.
            uint16 oldVal = s.tierLtvCache[tier].ltvBps;
            uint8 assetsContrib;
            // Re-compute the contributing-asset count via a separate
            // aggregateTierLtv call would double-cost; instead read it
            // back from the same `aggregateTierLtv` return... we lost
            // it above when we destructured to `(ok, tierMedian, )`.
            // Re-aggregate to get the count for the event (gas is
            // already in the millions; a second view-only call is the
            // smallest part). The duplicate would be cleaner with a
            // single `(ok, median, n)` return — left as-is for clarity
            // in this commit; aggregator re-shape is a follow-up.
            (, , assetsContrib) = LibPeerLTV.aggregateTierLtv(
                aave,
                comet,
                refAssets,
                LibVaipakam.PEER_DIVERGENCE_TOLERANCE_BPS,
                LibVaipakam.TIER_MIN_PEER_READINGS,
                LibVaipakam.TIER_MIN_ASSET_READINGS
            );
            s.tierLtvCache[tier] = LibVaipakam.TierLtvCacheEntry({
                ltvBps: candidate,
                lastRefreshedAt: uint64(block.timestamp)
            });
            emit TierLtvCacheUpdated(tier, candidate, oldVal, assetsContrib);
        }
    }

    /// @notice Read a tier's cached LTV reading + the last-refresh
    ///         timestamp. Returns (0, 0) for a never-refreshed tier
    ///         or for invalid tier indices. Loan init reads the
    ///         *effective* value via {getEffectiveTierMaxInitLtvBps}
    ///         (handles cache-stale fallback to library default).
    function getTierLtvCacheEntry(uint8 tier)
        external
        view
        returns (uint16 ltvBps, uint64 lastRefreshedAt)
    {
        if (tier == 0 || tier > LibVaipakam.MAX_LIQUIDITY_TIER) return (0, 0);
        LibVaipakam.TierLtvCacheEntry storage e = LibVaipakam.storageSlot().tierLtvCache[tier];
        return (e.ltvBps, e.lastRefreshedAt);
    }

    /// @notice Read the *effective* per-tier max-init-LTV the
    ///         loan-init gate will use. Returns the cached value if
    ///         < 14 days stale; else returns the library default for
    ///         that tier. Returns 0 for invalid tier indices.
    function getEffectiveTierMaxInitLtvBps(uint8 tier) external view returns (uint16) {
        return LibVaipakam.effectiveTierMaxInitLtvBps(tier);
    }

    /**
     * @notice List of asset addresses that appear as an active-loan leg and
     *         currently classify Illiquid on the active network.
     */
    function getIlliquidAssets() external view returns (address[] memory) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage active = s.activeLoanIdsList;
        uint256 aLen = active.length;
        address[] memory unique = new address[](aLen * 2);
        uint256 n;
        for (uint256 i = 0; i < aLen; i++) {
            LibVaipakam.Loan storage l = s.loans[active[i]];
            if (l.assetType == LibVaipakam.AssetType.ERC20 && l.principalAsset != address(0)) {
                n = _pushUniqueAddr(unique, n, l.principalAsset);
            }
            if (
                l.collateralAssetType == LibVaipakam.AssetType.ERC20 &&
                l.collateralAsset != address(0)
            ) {
                n = _pushUniqueAddr(unique, n, l.collateralAsset);
            }
        }
        address[] memory tmp = new address[](n);
        uint256 m;
        for (uint256 k = 0; k < n; k++) {
            address a = unique[k];
            if (_checkLiquidity(a) != LibVaipakam.LiquidityStatus.Liquid) {
                tmp[m] = a;
                m += 1;
            }
        }
        address[] memory out = new address[](m);
        for (uint256 k = 0; k < m; k++) out[k] = tmp[k];
        return out;
    }

    /// @notice True iff `token` classifies Liquid on the active network.
    function isAssetSupported(address token) external view returns (bool) {
        if (token == address(0)) return false;
        return _checkLiquidity(token) == LibVaipakam.LiquidityStatus.Liquid;
    }

    // ─── Internal helpers ────────────────────────────────────────────────

    // `_lookupPool` (first-non-zero V3 pool across [3000, 500, 2500,
    // 10000, 100] fee tiers) was retired alongside `_v3DepthLiquid` in
    // the §4.4 step 3 full upgrade. The new `_passesFloorSlippage` uses
    // the explicit ≤0.3%-only fee tier set via `_le03FeeTiers()` (which
    // intentionally drops the 1% bucket — dust pairs live there per the
    // §3 census, requiring depth in a ≤0.3% pool is the conservative
    // direction). `_tryGetPool` below stays — it's the single-tier
    // primitive used by the route-search machinery.

    /// @dev Single-tier probe — extracted so the parent loop reads
    ///      cleanly. Returns `address(0)` on any failure mode.
    function _tryGetPool(
        address factory,
        address token0,
        address token1,
        uint24 fee
    ) private view returns (address) {
        (bool ok, bytes memory data) = factory.staticcall(
            abi.encodeWithSignature(
                "getPool(address,address,uint24)",
                token0,
                token1,
                fee
            )
        );
        if (!ok || data.length < 32) return address(0);
        return abi.decode(data, (address));
    }

    // ─── Depth-tiered LTV (Piece B) — internal tier machinery ──────────

    /// @dev ≤0.3%-fee tiers iterated by the depth-tier route search —
    ///      `{100, 500, 2500 (PancakeV3 mid), 3000}`. Deliberately
    ///      excludes the 1% (`10000`) tier: per the §3 census every deep
    ///      pool sits in a ≤0.3% tier, the 1% tier is where dust pairs
    ///      live, so requiring depth in a ≤0.3% pool is the conservative
    ///      choice (and it slightly tightens the base `Liquid` gate vs
    ///      `_lookupPool`, which still probes 1% — fail-safe direction).
    function _le03FeeTiers() private pure returns (uint24[4] memory) {
        return [V3_TIER_LOW, V3_TIER_LOW_MID, V3_TIER_PANCAKE, V3_TIER_STANDARD];
    }

    /// @dev Best-effort `decimals()` — low-level `staticcall` so a
    ///      non-contract / non-conforming address (e.g. a fat-fingered
    ///      PAA entry) can't revert the never-reverting classification
    ///      view; falls back to `18` on call failure / short return /
    ///      an implausible (> 36) value. A wrong fallback is
    ///      self-correcting: the value-balance guard in
    ///      {_accumulatePoolImpacts} skips a pool whose legs don't
    ///      balance, which is exactly what a decimals mismatch produces.
    ///      (`try/catch IERC20Metadata(addr).decimals()` is *not* enough:
    ///      a call to a code-less address succeeds with empty returndata
    ///      and the compiler's "call to non-contract" guard then reverts
    ///      *outside* the catch.)
    function _tryTokenDecimals(address token) private view returns (uint8) {
        if (token.code.length == 0) return 18;
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
        if (!ok || data.length < 32) return 18;
        uint256 d = abi.decode(data, (uint256));
        return d > 36 ? 18 : uint8(d);
    }

    /// @dev Read a Uni-V3-clone pool's state for the depth-tier route
    ///      search. `ok == false` on any malformed/failed read or a
    ///      degenerate (zero-reserve / un-initialised) pool. `observeOk`
    ///      is independent: `false` when the pool's TWAP oracle isn't
    ///      initialised deep enough (`observe` reverts `OLD`) — then
    ///      {_accumulatePoolImpacts} applies only the value-balance guard,
    ///      so a manipulator can't dodge the price check via a
    ///      low-cardinality pool (the value-balance guard still requires
    ///      the spot to match the Chainlink feed).
    function _readV3PoolState(address pool, uint32 twapWindow)
        private
        view
        returns (
            bool ok,
            uint256 reserve0,
            uint256 reserve1,
            int24 currentTick,
            bool observeOk,
            int24 meanTick
        )
    {
        if (pool == address(0) || pool.code.length == 0) return (false, 0, 0, 0, false, 0);
        (bool slotOk, bytes memory slotData) = pool.staticcall(abi.encodeWithSignature("slot0()"));
        if (!slotOk || slotData.length < 224) return (false, 0, 0, 0, false, 0);
        uint160 sqrtPriceX96;
        (sqrtPriceX96, currentTick, , , , , ) = abi.decode(
            slotData,
            (uint160, int24, uint16, uint16, uint16, uint8, bool)
        );
        if (sqrtPriceX96 == 0) return (false, 0, 0, 0, false, 0);
        (bool liqOk, bytes memory liqData) = pool.staticcall(abi.encodeWithSignature("liquidity()"));
        if (!liqOk || liqData.length < 32) return (false, 0, 0, 0, false, 0);
        uint128 liquidity = abi.decode(liqData, (uint128));
        if (liquidity == 0) return (false, 0, 0, 0, false, 0);
        (reserve0, reserve1) = LibSlippage.v3VirtualReserves(liquidity, sqrtPriceX96);
        if (reserve0 == 0 || reserve1 == 0) return (false, 0, 0, 0, false, 0);
        ok = true;
        // Best-effort TWAP read — never reverts the route search.
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapWindow;
        secondsAgos[1] = 0;
        (bool obsOk, bytes memory obsData) = pool.staticcall(
            abi.encodeWithSignature("observe(uint32[])", secondsAgos)
        );
        // observe returns (int56[] tickCumulatives, uint160[] secondsPerLiquidity…);
        // a well-formed 2-element pair encodes to exactly 256 bytes
        // (2 head offsets + 2× [len + 2 words]). We only need [0]. The
        // length floor keeps the unconditional `abi.decode` from
        // reverting the (never-reverting) classification view on a short
        // return — a real V3 pool always answers with the full layout.
        if (obsOk && obsData.length >= 256) {
            (int56[] memory tickCumulatives, ) = abi.decode(obsData, (int56[], uint160[]));
            if (tickCumulatives.length >= 2 && twapWindow > 0) {
                int56 delta = tickCumulatives[1] - tickCumulatives[0];
                meanTick = int24(delta / int56(int256(uint256(twapWindow))));
                observeOk = true;
            }
        }
    }

    /// @dev Asset-side parameters shared across the whole route search,
    ///      bundled to keep {_liquidityTier} / {_routeOverQuote} /
    ///      {_accumulatePoolImpacts} clear of the viaIR stack ceiling.
    ///      `pA` = the classified asset's Chainlink price (feed-scaled);
    ///      `scaleA` = `10**(feedDecimals + tokenDecimals)` so a
    ///      PAD↔base-unit conversion is one `mulDiv`; `band` =
    ///      `twapConsistencyBps`; `twapWindow` = `twapWindowSec`.
    struct _TierCtx {
        uint256 pA;
        uint256 scaleA;
        uint256 band;
        uint32 twapWindow;
    }

    /// @dev For one resolved Uni-V3-clone pool, fold its best-route
    ///      contribution into `best[i]` = the lowest price-impact seen at
    ///      `sizes[i]` (PAD × 1e6) across every pool — *after* the two
    ///      manipulation guards (value-balance / spot≈feed, and the
    ///      best-effort TWAP-consistency tick check). `best` and `sizes`
    ///      are mutated-in-place memory arrays of length 4
    ///      `{floor, tier1, tier2, tier3}`. `pQ`/`scaleQ` are the quote
    ///      token's Chainlink price and `10**(feedDec + tokenDec)`
    ///      composite; the asset side comes from `ctx`.
    function _accumulatePoolImpacts(
        address pool,
        uint24 fee,
        _TierCtx memory ctx,
        bool assetIsToken0,
        uint256 pQ,
        uint256 scaleQ,
        uint256[4] memory sizes,
        uint256[4] memory best
    ) private view {
        (
            bool stOk,
            uint256 r0,
            uint256 r1,
            int24 curTick,
            bool obsOk,
            int24 meanTick
        ) = _readV3PoolState(pool, ctx.twapWindow);
        if (!stOk) return;
        (uint256 reserveAsset, uint256 reserveQ) = assetIsToken0 ? (r0, r1) : (r1, r0);
        // Guard 1 — the two legs' Chainlink-priced values must be
        // balanced within `band` bps (⇔ the pool's spot price agrees
        // with the trusted feed): `legValueRatio = feedMid / poolMid`,
        // so balanced legs ⇔ poolMid ≈ feedMid.
        {
            uint256 vAsset = Math.mulDiv(reserveAsset, ctx.pA * 1e6, ctx.scaleA); // PAD × 1e6
            uint256 vQ = Math.mulDiv(reserveQ, pQ * 1e6, scaleQ); // PAD × 1e6
            if (vAsset == 0 || vQ == 0) return;
            (uint256 lo, uint256 hi) = vAsset < vQ ? (vAsset, vQ) : (vQ, vAsset);
            uint256 bp = LibVaipakam.BASIS_POINTS;
            if (ctx.band < bp && lo * bp < hi * (bp - ctx.band)) return;
        }
        // Guard 2 — best-effort: if the pool's TWAP oracle answered, the
        // `twapWindow`-mean tick must be within `band` ticks of the
        // current tick (1 tick ≈ 1 bp of price for small `band`), which
        // catches a *recently*-manipulated pool that guard 1 alone would
        // miss if the price has since reverted.
        if (obsOk) {
            int256 d = int256(curTick) - int256(meanTick);
            if (d < 0) d = -d;
            if (uint256(d) > ctx.band) return;
        }
        // Fold the price-impact at each test size into the running best.
        // `priceImpactBps` is monotone in `amountIn`, so for one pool
        // best[0] ≤ best[1] ≤ best[2] ≤ best[3]; taking the min over
        // pools preserves that order.
        for (uint256 si; si < 4; ++si) {
            if (best[si] == 0 || sizes[si] == 0) continue;
            uint256 amountIn = Math.mulDiv(sizes[si], ctx.scaleA, ctx.pA * 1e6); // asset base units
            if (amountIn == 0) continue;
            uint256 imp = LibSlippage.priceImpactBps(amountIn, reserveAsset, uint256(fee));
            if (imp < best[si]) best[si] = imp;
        }
    }

    /// @dev Route the `asset/q` pair over every configured Uni-V3-clone
    ///      factory at every fee tier ≤ 0.3%, folding each found pool's
    ///      contribution into `best`. Skips `q` entirely when its
    ///      Chainlink price is unavailable (can't value its leg).
    function _routeOverQuote(
        address asset,
        address q,
        LibVaipakam.Storage storage s,
        _TierCtx memory ctx,
        uint256[4] memory sizes,
        uint256[4] memory best
    ) private view {
        (bool okQ, uint256 pQ, uint8 dQ) = tryGetAssetPrice(q);
        if (!okQ || pQ == 0) return;
        uint256 scaleQ = 10 ** (uint256(dQ) + uint256(_tryTokenDecimals(q)));
        bool assetIsToken0 = asset < q;
        // V3 leg: 3 factories × 4 fee tiers via `getPool(t0, t1, fee)`.
        {
            (address token0, address token1) = assetIsToken0 ? (asset, q) : (q, asset);
            uint24[4] memory feeTiers = _le03FeeTiers();
            address[3] memory factories = [
                s.uniswapV3Factory,
                s.pancakeswapV3Factory,
                s.sushiswapV3Factory
            ];
            for (uint256 fi; fi < 3; ++fi) {
                if (factories[fi] == address(0)) continue;
                for (uint256 ti; ti < 4; ++ti) {
                    address pool = _tryGetPool(factories[fi], token0, token1, feeTiers[ti]);
                    if (pool == address(0)) continue;
                    _accumulatePoolImpacts(pool, feeTiers[ti], ctx, assetIsToken0, pQ, scaleQ, sizes, best);
                }
            }
        }
        // V2 leg (Piece B follow-up b): 3 factories with their canonical
        // single fee tier via `getPair(a, b)` (bidirectional — order-
        // independent) + `getReserves()` (real reserves, not the V3 in-tick
        // virtual approximation ⇒ exact CPMM math). A zero factory skips
        // that leg; on a fresh deploy all three are zero ⇒ V3-only route
        // search, no behaviour change vs the pre-(b) state.
        {
            address[3] memory v2Factories = [
                s.uniswapV2Factory,
                s.sushiswapV2Factory,
                s.pancakeswapV2Factory
            ];
            uint24[3] memory v2Fees = [V2_FEE_30BPS, V2_FEE_30BPS, V2_FEE_25BPS];
            for (uint256 vi; vi < 3; ++vi) {
                if (v2Factories[vi] == address(0)) continue;
                _v2AccumulatePoolImpacts(
                    v2Factories[vi], v2Fees[vi], asset, q, ctx, assetIsToken0, pQ, scaleQ, sizes, best
                );
            }
        }
    }

    /// @dev V2 sibling of {_accumulatePoolImpacts}. `getPair` is
    ///      bidirectional in canonical V2 (and every V2 fork tracked by
    ///      Vaipakam — Sushi/Pancake), so we can pass `(asset, quote)`
    ///      in either order. `getReserves()` returns the *real* reserves
    ///      in token0/token1 order (canonical ascending address) — no
    ///      in-tick virtual-reserve step. No on-chain TWAP guard for V2
    ///      (no `observe`-style primitive in one shot); the value-balance
    ///      guard (spot ≈ Chainlink feed) is the only manipulation check,
    ///      same residual flash-loan-add-liquidity vector as V3 bounded
    ///      by the LTV cushion.
    function _v2AccumulatePoolImpacts(
        address factory,
        uint24 feePips,
        address asset,
        address quote,
        _TierCtx memory ctx,
        bool assetIsToken0,
        uint256 pQ,
        uint256 scaleQ,
        uint256[4] memory sizes,
        uint256[4] memory best
    ) private view {
        (bool ok, bytes memory pdata) = factory.staticcall(
            abi.encodeWithSignature("getPair(address,address)", asset, quote)
        );
        if (!ok || pdata.length < 32) return;
        address pool = abi.decode(pdata, (address));
        if (pool == address(0) || pool.code.length == 0) return;
        (bool rok, bytes memory rdata) = pool.staticcall(abi.encodeWithSignature("getReserves()"));
        // V2 `getReserves` ABI = `(uint112, uint112, uint32)` → 3×32-byte words.
        if (!rok || rdata.length < 96) return;
        (uint256 r0, uint256 r1, ) = abi.decode(rdata, (uint256, uint256, uint256));
        if (r0 == 0 || r1 == 0) return;
        (uint256 reserveAsset, uint256 reserveQ) = assetIsToken0 ? (r0, r1) : (r1, r0);
        // Value-balance guard (spot ≈ feed) — identical to the V3 path.
        {
            uint256 vAsset = Math.mulDiv(reserveAsset, ctx.pA * 1e6, ctx.scaleA);
            uint256 vQ = Math.mulDiv(reserveQ, pQ * 1e6, scaleQ);
            if (vAsset == 0 || vQ == 0) return;
            (uint256 lo, uint256 hi) = vAsset < vQ ? (vAsset, vQ) : (vQ, vAsset);
            uint256 bp = LibVaipakam.BASIS_POINTS;
            if (ctx.band < bp && lo * bp < hi * (bp - ctx.band)) return;
        }
        for (uint256 si; si < 4; ++si) {
            if (best[si] == 0 || sizes[si] == 0) continue;
            uint256 amountIn = Math.mulDiv(sizes[si], ctx.scaleA, ctx.pA * 1e6);
            if (amountIn == 0) continue;
            uint256 imp = LibSlippage.priceImpactBps(amountIn, reserveAsset, uint256(feePips));
            if (imp < best[si]) best[si] = imp;
        }
    }

    /// @dev The on-chain liquidity tier of `asset` (0..3) — see
    ///      {getLiquidityTier} for the full semantics. `0` iff the asset
    ///      doesn't classify `Liquid` (covers sequencer-down / no feed /
    ///      no $1M WETH pool / `pauseAsset`-blacklisted), or it can't
    ///      clear the `floorSizePad` simulated swap at
    ///      `liquiditySlippageBps` on any valid {effectivePaaAssets} ×
    ///      {Uni/Pancake/Sushi V3} × {fee ≤ 0.3%} route.
    function _liquidityTier(address asset, LibVaipakam.Storage storage s)
        internal
        view
        returns (uint8)
    {
        if (_checkLiquidity(asset) != LibVaipakam.LiquidityStatus.Liquid) return 0;
        (bool okA, uint256 pA, uint8 dA) = tryGetAssetPrice(asset);
        if (!okA || pA == 0) return 0;
        _TierCtx memory ctx = _TierCtx({
            pA: pA,
            scaleA: 10 ** (uint256(dA) + uint256(_tryTokenDecimals(asset))),
            band: LibVaipakam.cfgTwapConsistencyBps(),
            twapWindow: uint32(LibVaipakam.cfgTwapWindowSec())
        });
        uint256[4] memory sizes = [
            LibVaipakam.cfgFloorSizePad(),
            LibVaipakam.cfgTier1SizePad(),
            LibVaipakam.cfgTier2SizePad(),
            LibVaipakam.cfgTier3SizePad()
        ];
        uint256[4] memory best = [
            type(uint256).max,
            type(uint256).max,
            type(uint256).max,
            type(uint256).max
        ];
        address[] memory paa = LibVaipakam.effectivePaaAssets();
        for (uint256 qi; qi < paa.length; ++qi) {
            address q = paa[qi];
            if (q != address(0) && q != asset) {
                _routeOverQuote(asset, q, s, ctx, sizes, best);
            }
        }
        uint256 slipBound = LibVaipakam.cfgLiquiditySlippageBps();
        if (best[0] > slipBound) return 0; // can't clear `floorSizePad` ⇒ untierable
        if (best[3] <= slipBound) return 3;
        if (best[2] <= slipBound) return 2;
        return 1; // cleared the floor ⇒ at least Tier 1
    }

    /// @notice `getAssetPrice` look-alike but try/catch wrapped — callers
    ///         that want to fail-closed instead of fail-open (the
    ///         {checkLiquidity}, {getIlliquidAssets}, and the
    ///         oracle-quorum failed-swap fallback in `LibFallback`) can
    ///         detect pricing failure without bubbling a revert.
    /// @dev    Promoted from `private _tryGetAssetPriceView` to `public
    ///         tryGetAssetPrice` (Phase 2 of the
    ///         AutonomousLtvAndOracleFallback.md design) so `LibFallback`
    ///         can route through the diamond proxy to detect the
    ///         oracle-quorum-stale case and switch from the
    ///         oracle-priced settlement to the full-collateral fallback.
    ///         Same behaviour as before for in-facet callers — internal
    ///         calls bypass the proxy + try/catch overhead naturally.
    function tryGetAssetPrice(address asset)
        public
        view
        returns (bool ok, uint256 price, uint8 decimals)
    {
        try this.getAssetPrice(asset) returns (uint256 p, uint8 d) {
            return (true, p, d);
        } catch {
            return (false, 0, 0);
        }
    }

    /// @dev Feed Registry lookup, try/catch wrapped. Returns `address(0)`
    ///      on missing feed or registry failure.
    function _registryFeed(address registry, address base, address quote)
        private
        view
        returns (AggregatorV3Interface)
    {
        try FeedRegistryInterface(registry).getFeed(base, quote) returns (
            AggregatorV2V3Interface f
        ) {
            return AggregatorV3Interface(address(f));
        } catch {
            return AggregatorV3Interface(address(0));
        }
    }

    /// @dev Read a fresh-USD feed and enforce the staleness rule with
    ///      optional peg-aware stable branch. Returns (ok, price, dec).
    ///      Never reverts. Used by fail-closed callers (liquidity check).
    function _readFreshUsdFeed(address feed, bool allowStablePeg)
        private
        view
        returns (bool ok, uint256 price, uint8 decimals)
    {
        if (feed == address(0)) return (false, 0, 0);
        int256 answer;
        uint256 updatedAt;
        uint80 roundId;
        uint80 answeredInRound;
        try AggregatorV3Interface(feed).latestRoundData() returns (
            uint80 rId, int256 a, uint256, uint256 u, uint80 aIR
        ) {
            roundId = rId;
            answer = a;
            updatedAt = u;
            answeredInRound = aIR;
        } catch {
            return (false, 0, 0);
        }
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp || roundId != answeredInRound) {
            return (false, 0, 0);
        }
        uint256 age = block.timestamp - updatedAt;
        if (age > LibVaipakam.ORACLE_STABLE_STALENESS) return (false, 0, 0);
        uint8 dec;
        try AggregatorV3Interface(feed).decimals() returns (uint8 d) {
            dec = d;
        } catch {
            return (false, 0, 0);
        }
        if (age > LibVaipakam.ORACLE_VOLATILE_STALENESS) {
            if (!allowStablePeg) return (false, 0, 0);
            if (!_answerWithinAnyPeg(answer, dec)) return (false, 0, 0);
        }
        return (true, uint256(answer), dec);
    }

    /// @dev Read a Chainlink aggregator and enforce the staleness rule;
    ///      reverts on failure. Used by the revert-on-failure getAssetPrice
    ///      path. Consults the per-feed override first (Phase 3.1): when
    ///      set, `maxStaleness` replaces the two-tier default and
    ///      `minValidAnswer` imposes a hard floor on the returned answer.
    function _readAggregatorStrict(address feed, bool allowStablePeg)
        private
        view
        returns (uint256 price, uint8 decimals)
    {
        (
            uint80 roundId,
            int256 answer,
            ,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = AggregatorV3Interface(feed).latestRoundData();
        if (
            answer <= 0 ||
            updatedAt == 0 ||
            updatedAt > block.timestamp ||
            roundId != answeredInRound
        ) {
            revert StalePriceData();
        }
        uint256 age = block.timestamp - updatedAt;

        LibVaipakam.FeedOverride storage ovr = LibVaipakam
            .storageSlot()
            .feedOverrides[feed];

        // Minimum-valid-answer floor — if configured, reject below-floor
        // readings regardless of other freshness bounds. Guards against
        // incident-era near-zero prices entering the system.
        if (ovr.minValidAnswer > 0 && answer < ovr.minValidAnswer) {
            revert StalePriceData();
        }

        // Staleness enforcement is done BEFORE reading the feed's
        // decimals so a stale feed reverts with the precise
        // StalePriceData selector rather than tripping a secondary
        // revert if `decimals()` itself behaves unexpectedly (empty
        // return on a no-code address, stale nested call, etc).

        if (ovr.maxStaleness > 0) {
            // Override-enforced staleness. Deliberately bypasses the stable-
            // peg branch — an operator that sets an override has taken
            // explicit responsibility for the freshness budget on this feed,
            // so the implicit "let a stable feed be 25h old if it's near
            // $1" relaxation no longer applies. If the operator wants a
            // long ceiling (e.g. 24h for a fiat-quoted feed that really
            // does run 24h heartbeats), they set maxStaleness to that
            // value.
            if (age > ovr.maxStaleness) revert StalePriceData();
            uint8 dec = AggregatorV3Interface(feed).decimals();
            return (uint256(answer), dec);
        }

        // No override — fall through to the existing two-tier defaults:
        // volatile feeds must be fresh within 2h; stable feeds may be
        // up to 25h old only if the answer is within peg tolerance of
        // $1 or any registered fiat/commodity reference.
        if (age > LibVaipakam.ORACLE_STABLE_STALENESS) revert StalePriceData();
        uint8 dec2 = AggregatorV3Interface(feed).decimals();
        if (age > LibVaipakam.ORACLE_VOLATILE_STALENESS) {
            if (!allowStablePeg) revert StalePriceData();
            if (!_answerWithinAnyPeg(answer, dec2)) revert StalePriceData();
        }
        return (uint256(answer), dec2);
    }

    /// @dev Peg-aware stable branch. `answer` is accepted if it lies
    ///      within `ORACLE_PEG_TOLERANCE_BPS` of the implicit USD $1 peg
    ///      OR of any registered fiat / commodity reference. Reference
    ///      feeds themselves must be fresh within `ORACLE_STABLE_STALENESS`.
    ///      Gated on `dec == 8` so only 8-decimal USD-quoted feeds
    ///      qualify — an asset/ETH 1e18 reading is not misclassified.
    function _answerWithinAnyPeg(int256 answer, uint8 dec) private view returns (bool) {
        if (dec != 8) return false;

        if (_withinPegBps(answer, LibVaipakam.ORACLE_USD_PEG_1E8)) return true;

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 n = s.stableFeedSymbolsList.length;
        for (uint256 i = 0; i < n; i++) {
            address ref = s.stableFeedBySymbol[s.stableFeedSymbolsList[i]];
            if (ref == address(0)) continue;
            (bool ok, int256 refAnswer) = _readRefPegAnswer(ref);
            if (!ok) continue;
            if (_withinPegBps(answer, refAnswer)) return true;
        }
        return false;
    }

    /// @dev Read a peg reference feed (EUR/USD, JPY/USD, XAU/USD…) and
    ///      enforce the 25h stable ceiling — these feeds run 24h
    ///      heartbeats themselves so the 2h volatile bound does not
    ///      apply. Returns (ok, rawAnswer8).
    function _readRefPegAnswer(address feed) private view returns (bool ok, int256 answer) {
        uint256 updatedAt;
        uint80 roundId;
        uint80 answeredInRound;
        int256 a;
        try AggregatorV3Interface(feed).latestRoundData() returns (
            uint80 rId, int256 rA, uint256, uint256 u, uint80 aIR
        ) {
            roundId = rId;
            a = rA;
            updatedAt = u;
            answeredInRound = aIR;
        } catch {
            return (false, 0);
        }
        if (a <= 0 || updatedAt == 0 || updatedAt > block.timestamp || roundId != answeredInRound) {
            return (false, 0);
        }
        if (block.timestamp - updatedAt > LibVaipakam.ORACLE_STABLE_STALENESS) {
            return (false, 0);
        }
        try AggregatorV3Interface(feed).decimals() returns (uint8 d) {
            if (d != 8) return (false, 0);
        } catch {
            return (false, 0);
        }
        return (true, a);
    }

    /// @dev |answer - peg| / peg in basis points ≤ ORACLE_PEG_TOLERANCE_BPS.
    ///      Safe with positive-only answers (validated at the feed read).
    function _withinPegBps(int256 answer, int256 peg) private pure returns (bool) {
        if (peg <= 0) return false;
        int256 diff = answer > peg ? answer - peg : peg - answer;
        uint256 devBps = (uint256(diff) * LibVaipakam.BASIS_POINTS) / uint256(peg);
        return devBps <= LibVaipakam.ORACLE_PEG_TOLERANCE_BPS;
    }

    function _pushUniqueAddr(address[] memory arr, uint256 n, address v)
        private
        pure
        returns (uint256)
    {
        for (uint256 k = 0; k < n; k++) {
            if (arr[k] == v) return n;
        }
        arr[n] = v;
        return n + 1;
    }

    // ─── Sequencer uptime circuit breaker (Chainlink L2 feed) ──────────

    /// @notice Returns the configured L2 sequencer uptime feed address.
    function getSequencerUptimeFeed() external view returns (address) {
        return LibVaipakam.storageSlot().sequencerUptimeFeed;
    }

    /// @notice Non-reverting sequencer liveness view consumed by the
    ///         default/liquidation facets to decide between DEX-swap and
    ///         full-collateral-transfer liquidation paths.
    function sequencerHealthy() external view returns (bool) {
        return _sequencerHealthy();
    }

    /// @dev Revert-on-failure sequencer check enforced before every
    ///      price read in the getAssetPrice path.
    function _requireSequencerHealthy() internal view {
        address feed = LibVaipakam.storageSlot().sequencerUptimeFeed;
        if (feed == address(0)) return;
        (, int256 answer, uint256 startedAt, , ) = AggregatorV3Interface(feed).latestRoundData();
        if (answer != 0) revert SequencerDown();
        if (startedAt == 0) revert SequencerDown();
        if (block.timestamp - startedAt < LibVaipakam.SEQUENCER_GRACE_PERIOD) {
            revert SequencerGracePeriod();
        }
    }

    /// @dev Non-reverting sibling of {_requireSequencerHealthy} for
    ///      fail-closed callers (liquidity classification).
    function _sequencerHealthy() internal view returns (bool) {
        address feed = LibVaipakam.storageSlot().sequencerUptimeFeed;
        if (feed == address(0)) return true;
        try AggregatorV3Interface(feed).latestRoundData() returns (
            uint80,
            int256 answer,
            uint256 startedAt,
            uint256,
            uint80
        ) {
            if (answer != 0) return false;
            if (startedAt == 0) return false;
            if (block.timestamp - startedAt < LibVaipakam.SEQUENCER_GRACE_PERIOD) return false;
            return true;
        } catch {
            return false;
        }
    }
}
