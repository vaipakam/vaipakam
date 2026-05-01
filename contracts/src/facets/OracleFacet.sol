// src/facets/OracleFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
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
 *        - WETH itself: priced from `ethUsdFeed` directly; no pool check.
 *        - Other assets (primary): Chainlink Feed Registry getFeed(asset, USD).
 *        - Other assets (fallback): Chainlink Feed Registry
 *          getFeed(asset, ETH) × latestRoundData(ethUsdFeed).
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
    ///         `pythNumeraireMaxDeviationBps`. Fail-closed: a
    ///         numeraire reading the protocol can't agree on between
    ///         two independent oracles is a strong signal that one
    ///         of them has been compromised; we'd rather block
    ///         protocol ops than accept a price the system itself
    ///         can't trust.
    error OracleNumeraireDivergence(
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
        address ethFeed = s.ethUsdFeed;
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
        // sufficient on-chain depth on AT LEAST ONE of the configured
        // V3-style venues (Phase 7b: UniswapV3 OR PancakeSwap V3 OR
        // SushiSwap V3 — all UniV3 forks at the contract layer, same
        // probe semantics, different factory addresses). A single
        // venue's outage / pool drainage / censorship cannot flip the
        // asset to Illiquid as long as one other clone still meets
        // the floor. Zero per-asset governance config — pool
        // discovery is on-chain via `factory.getPool`.
        (bool priceOk, , ) = _tryGetAssetPriceView(asset);
        if (!priceOk) return LibVaipakam.LiquidityStatus.Illiquid;

        // Read ETH/USD once; every venue probe needs it for the
        // depth→USD conversion.
        (bool ethOk, uint256 ethPrice, uint8 ethDec) = _readFreshUsdFeed(ethFeed, false);
        if (!ethOk) return LibVaipakam.LiquidityStatus.Illiquid;

        if (_v3DepthLiquid(s.uniswapV3Factory, asset, weth, ethPrice, ethDec)) {
            return LibVaipakam.LiquidityStatus.Liquid;
        }
        if (_v3DepthLiquid(s.pancakeswapV3Factory, asset, weth, ethPrice, ethDec)) {
            return LibVaipakam.LiquidityStatus.Liquid;
        }
        if (_v3DepthLiquid(s.sushiswapV3Factory, asset, weth, ethPrice, ethDec)) {
            return LibVaipakam.LiquidityStatus.Liquid;
        }
        return LibVaipakam.LiquidityStatus.Illiquid;
    }

    /// @dev V3-style depth probe — the same code path applied against
    ///      any UniswapV3-fork factory address (UniswapV3 itself,
    ///      PancakeSwap V3, SushiSwap V3, or any other ABI-compatible
    ///      mock). Returns true iff `factory` exposes an asset/WETH
    ///      pool whose `liquidity()` value, multiplied by the spot
    ///      ETH/USD price, meets {LibVaipakam.MIN_LIQUIDITY_USD}.
    ///      Pool selection iterates the standard fee tiers + 2500
    ///      (PancakeV3) via {_lookupPool}.
    ///
    ///      A zero `factory` short-circuits to false so the parent
    ///      OR-combine in {_checkLiquidity} can transparently skip
    ///      whichever V3-clone isn't deployed on this chain.
    function _v3DepthLiquid(
        address factory,
        address asset,
        address weth,
        uint256 ethPrice,
        uint8 ethDec
    ) private view returns (bool) {
        if (factory == address(0)) return false;

        address pool = _lookupPool(factory, asset, weth);
        if (pool == address(0) || pool.code.length == 0) return false;

        // slot0() returns 7 fields (uint160, int24, uint16, uint16,
        // uint16, uint8, bool) — a 224-byte ABI encoding. Guard the
        // length before decoding so a staticcall against a non-pool
        // (returns empty bytes with ok=true on an EOA) can't revert
        // the whole liquidity view.
        (bool slotOk, bytes memory slotData) = pool.staticcall(
            abi.encodeWithSignature("slot0()")
        );
        if (!slotOk || slotData.length < 224) return false;
        (uint160 sqrtPriceX96, , , , , , ) = abi.decode(
            slotData,
            (uint160, int24, uint16, uint16, uint16, uint8, bool)
        );
        if (sqrtPriceX96 == 0) return false;

        (bool liqOk, bytes memory liqData) = pool.staticcall(
            abi.encodeWithSignature("liquidity()")
        );
        if (!liqOk || liqData.length < 32) return false;
        uint128 poolLiquidity = abi.decode(liqData, (uint128));

        uint256 approxUsdLiquidity = (uint256(poolLiquidity) * ethPrice) / (10 ** ethDec);
        return approxUsdLiquidity >= LibVaipakam.MIN_LIQUIDITY_USD;
    }


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
     *        1. WETH → direct {ethUsdFeed}.
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

    /// @dev Chainlink-only primary read. Unchanged from Phase 3.1; the
    ///      Phase 3.2 deviation check runs AFTER this returns.
    function _primaryPrice(
        address asset
    ) private view returns (uint256 price, uint8 decimals) {
        _requireSequencerHealthy();

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address weth = s.wethContract;
        address ethFeed = s.ethUsdFeed;

        // WETH → read ETH/USD directly.
        if (asset != address(0) && asset == weth) {
            if (ethFeed == address(0)) revert NoPriceFeed();
            (uint256 p, uint8 d) = _readAggregatorStrict(ethFeed, /*allowStablePeg=*/ false);
            // T-033 numeraire-redundancy gate: cross-validate the
            // Chainlink ETH/USD reading against Pyth's snapshot.
            // Soft-skips if Pyth is unset / stale / low-confidence;
            // reverts on divergence beyond tolerance.
            _validatePythNumeraire(p, d);
            return (p, d);
        }

        // Primary: asset/USD via Feed Registry.
        address registry = s.chainlnkRegistry;
        address usdDenom = s.usdChainlinkDenominator;
        if (registry != address(0) && usdDenom != address(0)) {
            AggregatorV3Interface feed = _registryFeed(registry, asset, usdDenom);
            if (address(feed) != address(0)) {
                (uint256 p, uint8 d) = _readAggregatorStrict(address(feed), /*allowStablePeg=*/ true);
                return (p, d);
            }
        }

        // Fallback: asset/ETH via Feed Registry × ETH/USD.
        address ethDenom = s.ethChainlinkDenominator;
        if (registry != address(0) && ethDenom != address(0) && ethFeed != address(0)) {
            AggregatorV3Interface ethQuotedFeed = _registryFeed(registry, asset, ethDenom);
            if (address(ethQuotedFeed) != address(0)) {
                (uint256 assetPerEth, uint8 assetPerEthDec) = _readAggregatorStrict(
                    address(ethQuotedFeed),
                    /*allowStablePeg=*/ false
                );
                (uint256 ethPerUsd, uint8 ethDec) = _readAggregatorStrict(ethFeed, false);
                // assetPerEth is in `assetPerEthDec` (typically 1e18 for
                // asset/ETH feeds); ethPerUsd in `ethDec` (1e8).
                // Combined USD price scales to `ethDec` decimals by
                // dividing out the ETH feed's native scale.
                // T-033 — same numeraire-redundancy gate as the
                // direct WETH branch: the load-bearing leg of this
                // fallback is `ethPerUsd`, so cross-validate it
                // against Pyth before composing.
                _validatePythNumeraire(ethPerUsd, ethDec);
                uint256 combined = (assetPerEth * ethPerUsd) / (10 ** assetPerEthDec);
                return (combined, ethDec);
            }
        }

        revert NoPriceFeed();
    }

    // ─── T-033 — Pyth numeraire-redundancy gate ────────────────────────────

    /// @dev Cross-validate a Chainlink ETH/USD reading against Pyth's
    ///      latest snapshot. Soft-skips (no-op) when the gate is
    ///      effectively disabled or Pyth's data isn't trustworthy
    ///      for this read; reverts on a real divergence.
    ///
    ///      Soft-skip cases (gate degrades to Chainlink-only):
    ///        - `pythOracle` unset (governance-disabled).
    ///        - `pythNumeraireFeedId` unset (governance-disabled at
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
    ///          {OracleNumeraireDivergence} so the caller surfaces a
    ///          structured error instead of a generic price-failure.
    function _validatePythNumeraire(
        uint256 chainlinkPrice,
        uint8 chainlinkDecimals
    ) private view {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address pyth = s.pythOracle;
        bytes32 feedId = s.pythNumeraireFeedId;
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
        uint256 maxDev = uint256(LibVaipakam.effectivePythNumeraireMaxDeviationBps());
        if (deviationBps > maxDev) {
            revert OracleNumeraireDivergence(
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

        bytes32 queryId = keccak256(
            abi.encode("SpotPrice", abi.encode(lower, "usd"))
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

        bytes memory packed = abi.encodePacked(upper, "/USD");
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
        string memory key = string(abi.encodePacked(_toUpper(symbol), "/USD"));

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
        // Bytes32 return (legacy MakerDAO-style tokens). Strip
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
     */
    function getAssetRiskProfile(address token)
        external
        view
        returns (
            bool isSupported,
            LibVaipakam.LiquidityStatus status,
            uint256 maxLtvBps,
            uint256 liqThresholdBps,
            uint256 liqBonusBps
        )
    {
        if (token == address(0)) {
            return (false, LibVaipakam.LiquidityStatus.Illiquid, 0, 0, 0);
        }
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.RiskParams storage rp = s.assetRiskParams[token];
        maxLtvBps = rp.maxLtvBps;
        liqThresholdBps = rp.liqThresholdBps;
        liqBonusBps = rp.liqBonusBps;
        status = _checkLiquidity(token);
        isSupported = status == LibVaipakam.LiquidityStatus.Liquid;
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

    /// @dev Resolve a v3-style AMM pool for the (a,b) pair by calling
    ///      `factory.getPool(token0, token1, fee)` against every
    ///      configured fee tier and returning the first non-zero
    ///      result. Works against the canonical UniswapV3 factory,
    ///      PancakeSwap V3 factory, SushiSwap V3 factory, and any
    ///      ABI-compatible mock. Fails closed (returns `address(0)`)
    ///      on every-tier-empty / call failure / malformed return.
    ///
    ///      Phase 7b — extended from a single 0.3% probe to iterate
    ///      [3000, 500, 2500, 10000, 100] so PancakeV3 (whose mid
    ///      tier is 2500 instead of 3000) classifies on the same
    ///      probe path. The tier array is hardcoded as five separate
    ///      `staticcall`s — a small bytecode cost in exchange for
    ///      avoiding a fixed-size constant array (which Solidity's
    ///      `constant` keyword does not support).
    function _lookupPool(address factory, address a, address b) private view returns (address pool) {
        (address token0, address token1) = a < b ? (a, b) : (b, a);
        pool = _tryGetPool(factory, token0, token1, V3_TIER_STANDARD);
        if (pool != address(0)) return pool;
        pool = _tryGetPool(factory, token0, token1, V3_TIER_LOW_MID);
        if (pool != address(0)) return pool;
        pool = _tryGetPool(factory, token0, token1, V3_TIER_PANCAKE);
        if (pool != address(0)) return pool;
        pool = _tryGetPool(factory, token0, token1, V3_TIER_HIGH);
        if (pool != address(0)) return pool;
        pool = _tryGetPool(factory, token0, token1, V3_TIER_LOW);
        return pool;
    }

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

    /// @dev `getAssetPrice` look-alike but try/catch wrapped so callers
    ///      that want to fail-closed (checkLiquidity, getIlliquidAssets)
    ///      can detect pricing failure without bubbling a revert.
    function _tryGetAssetPriceView(address asset)
        private
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
