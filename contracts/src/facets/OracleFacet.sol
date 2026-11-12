// src/facets/OracleFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibSlippage} from "../libraries/LibSlippage.sol";
import {LibPeerLTV} from "../libraries/LibPeerLTV.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {LibNumeraireValue} from "../libraries/LibNumeraireValue.sol";
import {LibRiskMath} from "../libraries/LibRiskMath.sol";
import {LibPriceGuard} from "../libraries/LibPriceGuard.sol";
import {IPriceGuard} from "../interfaces/IPriceGuard.sol";

/**
 * @title OracleFacet
 * @author Vaipakam Developer Team
 * @notice Asset liquidity classification for the Vaipakam platform, and the
 *         Diamond's price selectors, which forward to the price guard.
 * @dev Part of the Diamond Standard (EIP-2535).
 *
 *      ── Prices (#3272 part 2) ──
 *      Every price comes from the standalone, non-upgradeable price guard
 *      the Timelock-owned protocol registry points at ({LibPriceGuard}). The
 *      pricing path (the asset/<PAD> feed resolved through the chain's feed
 *      registry, the asset/ETH × ETH/<PAD> fallback, the industrial PAD
 *      pivot, staleness and the stable-peg branch, per-feed overrides, the
 *      L2 sequencer check, the Pyth cross-check on the ETH anchor and the
 *      soft 2-of-N secondary quorum) runs there, under the guard's delayed
 *      config. {getAssetPrice}, {getAssetPriceStatus}, {tryGetAssetPrice},
 *      {countLiveSecondaryOracleFeeds} and {sequencerHealthy} forward to it,
 *      with the guard's refusals passed through unchanged.
 *
 *      ── Liquidity (stays in the Diamond) ──
 *      An ERC-20 is Liquid when its price is trusted and at least one route
 *      over the predominantly available quote assets clears the floor-size
 *      trade at the configured slippage, in a pool depth read time-weighted
 *      (#3354). The probe reads WETH, the ETH reference feed and the guard's
 *      freshness rule from the guard, so the classification and the prices
 *      never disagree about which feed or token is meant. The depth tiers
 *      and the tier LTV cache stay here too.
 *
 *      ── Fail-closed semantics ──
 *      Liquidity classification is never manually overrideable (README
 *      §1.5); registry, feed or pool failures read as Illiquid. A price that
 *      cannot be read reverts, so callers (RiskFacet, LoanFacet) never
 *      consume partial oracle state in risk math.
 */
contract OracleFacet is DiamondReentrancyGuard, DiamondPausable, DiamondAccessControl, IVaipakamErrors {
    /// @notice #633 — peer-protocol LTV reads are paused by governance.
    error PeerLtvReadsPaused();
    error NoDexPool();
    error InsufficientLiquidity();

    // ─── The price guard's refusals ────────────────────────────────────
    // Raised by the price guard and passed through {getAssetPrice}
    // unchanged (#3272 part 2). Declared here, with the guard's names and
    // parameters, so the Diamond's ABI decodes them and their selectors are
    // the ones callers have always read.

    /// @notice No feed prices the asset.
    error NoPriceFeed();
    /// @notice The feed's answer is older than the freshness rule allows.
    error StalePriceData();
    /// @notice The Pyth cross-check of the ETH reference price diverged
    ///         beyond the guard's bound: the price is distrusted.
    error OracleCrossCheckDivergence(
        uint256 chainlinkPrice,
        uint256 pythPrice,
        uint256 deviationBps,
        uint256 maxDeviationBps
    );
    /// @notice Every secondary source that answered (Tellor, API3, DIA)
    ///         disagreed with the primary price: the price is distrusted.
    error OraclePriceDivergence();
    /// @notice The L2 sequencer is down.
    error SequencerDown();
    /// @notice The L2 sequencer recovered less than the guard's grace period
    ///         ago.
    error SequencerGracePeriod();
    /// @notice Reverted by the pair-level {calculateLTV} when the collateral
    ///         leg values to zero — the same refusal, by the same name, as
    ///         the loan-level `RiskFacet.calculateLTV(loanId)`.
    error ZeroCollateral();
    /// @notice Reverted by {getAssetPrice} — and so by every valuation and
    ///         loan-to-value read built on it — when an asset's price
    ///         resolves to zero (#2418 r4 for the pair preview, #2419 for
    ///         every reader). A composed price can floor to zero even when
    ///         every component feed is positive. A zero price says nothing
    ///         about value, so it is refused rather than read as a value of
    ///         0 ("no debt", "no risk") or as zero collateral. The try and
    ///         status readers report it as Unavailable.
    error ZeroPrice(address asset);

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

    /// @dev `2**96` — the fixed-point base for a Uniswap-V3-style pool's
    ///      `sqrtPriceX96`. Used in {_v3DepthLiquid} to reconstruct the
    ///      pool's virtual reserves from `(liquidity, sqrtPriceX96)`.
    uint256 private constant Q96 = 1 << 96;

    /**
     * @notice Classification entry point for "is this asset liquid on the
     *         active network?" used at transaction-authorization boundaries.
     * @dev Fail-closed: oracle / registry / pool failures default to
     *      Illiquid. WETH is treated as Liquid whenever ETH/USD is fresh.
     *      #3354: an admission read. A pool's depth is the LOWER of its
     *      current in-range liquidity and its harmonic mean over the TWAP
     *      window, so a top-up made around one transaction cannot make an
     *      asset Liquid, and a pool drained since the window began reads
     *      at what is left.
     */
    function checkLiquidity(
        address asset
    ) external view returns (LibVaipakam.LiquidityStatus) {
        if (asset == address(0)) revert InvalidAsset();
        return _checkLiquidity(asset);
    }

    /**
     * @notice The liquidity check a forced close routes on (the time-based
     *         default's swap-or-in-kind choice, the split liquidation's
     *         liquid-only gate). Same classification as {checkLiquidity},
     *         with one difference (#666): an Illiquid verdict that rests on
     *         a DISTRUSTED price is not returned. It reverts with that
     *         price read's own divergence error instead
     *         ({OraclePriceDivergence} or {OracleCrossCheckDivergence}), so
     *         the close-out is refused and can be retried once the feeds
     *         agree.
     * @dev    An Illiquid verdict means "the lender takes the collateral in
     *         kind" on the default path, which is right when a price or a
     *         pool is genuinely missing and wrong when the secondary oracles
     *         merely disagree with Chainlink. Distrusted means: the asset's
     *         own price read is {PriceStatus.Divergent}, or a quote asset it
     *         has a pool with is (that route's verdict is then unknown rather
     *         than absent). A missing price stays Illiquid, as before.
     *         {checkLiquidity} keeps the Illiquid reading for every case: it
     *         gates new positions, where treating a distrusted asset as
     *         illiquid is the conservative answer.
     *
     *         #3354 — a close-out read credits a pool with its harmonic-mean
     *         liquidity over the TWAP window ALONE, not the lower of that and
     *         the current figure. Liquidity withdrawn in the same block as
     *         the close-out therefore cannot turn a sale into a refusal; the
     *         sale's own minimum output and the in-kind fallback decide what
     *         a genuinely thinner pool can fill. Depth that stays away for
     *         the window lowers the mean, and the asset then reads Illiquid
     *         as before. #3359 — it also values that depth at the feed
     *         price, not the pool's current price, so a price pushed in the
     *         same block cannot move the reading either way.
     */
    function checkLiquidityOnActiveNetwork(
        address asset
    ) external view returns (LibVaipakam.LiquidityStatus status) {
        if (asset == address(0)) revert InvalidAsset();
        address distrusted;
        (status, distrusted) = _classifyLiquidity(asset, /*closeOut=*/ true);
        if (distrusted != address(0)) _refuseDistrusted(distrusted);
    }

    /// @dev #666 — refuse because `distrusted`'s price is distrusted, with
    ///      the error its own price read raises, so the caller sees which
    ///      check disagreed (the secondary quorum, or the Pyth cross-check
    ///      of the ETH reference) rather than a generic refusal. The strict
    ///      read repeats the one {getAssetPriceStatus} just classified, in
    ///      the same transaction, so it reverts the same way; the trailing
    ///      revert only keeps the refusal unconditional.
    function _refuseDistrusted(address distrusted) private view {
        this.getAssetPrice(distrusted);
        revert OraclePriceDivergence();
    }

    /// @dev {_classifyLiquidity} without the distrust flag, for every
    ///      caller that reads a distrusted price as Illiquid.
    function _checkLiquidity(address asset) internal view returns (LibVaipakam.LiquidityStatus status) {
        (status, ) = _classifyLiquidity(asset, /*closeOut=*/ false);
    }

    /// @dev Internal dispatch. Pre-checks the sequencer circuit breaker
    ///      fail-closed, special-cases WETH, then runs the asset/WETH
    ///      pool depth + freshness gate for everything else. `distrusted`
    ///      is non-zero only on an Illiquid verdict that a distrusted price
    ///      produced (see {checkLiquidityOnActiveNetwork}), and names the
    ///      asset whose price it was: `asset` itself, or a quote asset over
    ///      which a route would have cleared the floor but for that price
    ///      ({_distrustedQuoteThatClears}). Every missing price, feed or
    ///      pool reports zero.
    function _classifyLiquidity(address asset, bool closeOut)
        internal
        view
        returns (LibVaipakam.LiquidityStatus, address distrusted)
    {
        IPriceGuard guard = LibPriceGuard.guard();
        if (!guard.sequencerHealthy()) return (LibVaipakam.LiquidityStatus.Illiquid, address(0));

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address weth = guard.weth();
        address ethFeed = guard.ethNumeraireFeed();
        if (weth == address(0) || ethFeed == address(0)) {
            return (LibVaipakam.LiquidityStatus.Illiquid, address(0));
        }

        // #666 — the asset's own price gates EVERY branch, WETH's included:
        // a distrusted price (the quorum, or the Pyth cross-check of the ETH
        // reference) is named so the settlement read refuses, and a missing
        // one is Illiquid like any unpriced asset. Before #666 WETH skipped
        // this gate and read Liquid on ETH/USD freshness alone, so a
        // distrusted WETH price never reached the refusal the classifier
        // owes, and an unavailable one sent the default into price reads
        // that revert instead of the missing-price rule every other asset
        // follows.
        (PriceStatus priceStatus, , ) = getAssetPriceStatus(asset);
        if (priceStatus != PriceStatus.Priced) {
            return (
                LibVaipakam.LiquidityStatus.Illiquid,
                priceStatus == PriceStatus.Divergent ? asset : address(0)
            );
        }

        // #2419 — an asset whose `decimals()` cannot be read is Illiquid:
        // no amount of it can be valued, so no risk math may run on it.
        // Read on the common path, before the WETH branch, so a configured
        // WETH whose decimals are unreadable is not reported Liquid while
        // every valuation of it refuses.
        (bool okDec, uint8 tokenDec) = LibNumeraireValue.tryTokenDecimals(asset);
        if (!okDec) return (LibVaipakam.LiquidityStatus.Illiquid, address(0));

        // WETH itself: no asset/WETH pool (circular); Liquid iff ETH/USD
        // is fresh (2h, no peg branch — ETH is volatile).
        if (asset == weth) {
            (bool ok, , ) = guard.readFeed(ethFeed, /*allowStablePeg=*/ false);
            return (ok ? LibVaipakam.LiquidityStatus.Liquid : LibVaipakam.LiquidityStatus.Illiquid, address(0));
        }

        // Every other asset must have a fresh asset/USD OR asset/ETH
        // price feed (the same hybrid chain `getAssetPrice` uses), AND
        // clear a fixed-size swap (default `cfgFloorSizePad` = $5k) at
        // ≤ `cfgLiquiditySlippageBps` (default 2%) on AT LEAST ONE
        // (asset/quote × V3-clone) route discovered on-chain via
        // the PAA list.
        //
        // #3354 — the depth that route is credited with is TIME-WEIGHTED:
        // the pool's own oracle must answer for the TWAP window, and the
        // liquidity read is its harmonic mean over that window (the lower
        // of that and the current figure, outside a close-out; see
        // {_accumulatePoolImpacts}). Depth that exists only around one
        // transaction cannot make an asset Liquid, and depth pulled in
        // the same block cannot make a liquid loan refuse its close-out.
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
        // PAA quote × any configured V3 venue × any fee tier
        // ≤ 0.3%) still clears the floor at the configured slippage.
        // Zero per-asset governance config — pool discovery is
        // on-chain via `factory.getPool`. The asset's
        // own price was gated above.

        // ETH/USD freshness — kept as a soft pre-flight: the
        // route-search itself rechecks each quote-asset's oracle via
        // `getAssetPriceStatus(q)`, but bailing out early here when
        // the ETH numeraire feed is stale matches the previous
        // behaviour and short-circuits the ~3 V3 staticcalls per PAA
        // quote that would otherwise run.
        (bool ethOk, , ) = guard.readFeed(ethFeed, false);
        if (!ethOk) return (LibVaipakam.LiquidityStatus.Illiquid, address(0));

        (bool passes, address distrustedQuote) = _passesFloorSlippage(asset, tokenDec, s, closeOut);
        return passes
            ? (LibVaipakam.LiquidityStatus.Liquid, address(0))
            : (LibVaipakam.LiquidityStatus.Illiquid, distrustedQuote);
    }

    /// @dev Floor-size slippage check used by {_checkLiquidity}. An
    ///      asset is Liquid iff at least one route (PAA × V3
    ///      venue × fee ≤ 0.3%) clears `cfgFloorSizePad` at slippage
    ///      ≤ `cfgLiquiditySlippageBps`. Reuses the same route-search
    ///      machinery {_liquidityTier} uses (`_routeOverQuote` →
    ///      `_accumulatePoolImpacts`),
    ///      constrained to size[0] only by zeroing sizes[1..3] (which
    ///      the accumulator's `sizes[si] == 0` guard skips).
    ///
    ///      §4.4 step 3 full upgrade — replaces the previous
    ///      {_v3DepthLiquid} depth-at-tick metric.
    ///
    ///      `distrustedQuote` (#666): when no trusted route clears, a quote
    ///      asset whose price is distrusted and over which a route would
    ///      have cleared on everything checkable without that price
    ///      ({_distrustedQuoteThatClears}). The failed search is then not
    ///      evidence the asset is illiquid. Zero when there is none.
    function _passesFloorSlippage(
        address asset,
        uint8 tdA,
        LibVaipakam.Storage storage s,
        bool closeOut
    )
        private
        view
        returns (bool passes, address distrustedQuote)
    {
        (bool okA, uint256 pA, uint8 dA) = tryGetAssetPrice(asset);
        if (!okA || pA == 0) return (false, address(0));
        // `tdA` is the decimals {_classifyLiquidity} already read (#2419).
        _TierCtx memory ctx = _TierCtx({
            pA: pA,
            scaleA: 10 ** (uint256(dA) + uint256(tdA)),
            band: LibVaipakam.cfgTwapConsistencyBps(),
            twapWindow: uint32(LibVaipakam.cfgTwapWindowSec()),
            quoteUnvalued: false,
            closeOut: closeOut
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
        if (best[0] <= LibVaipakam.cfgLiquiditySlippageBps()) return (true, address(0));
        return (false, _distrustedQuoteThatClears(asset, s, ctx, sizes, paa));
    }

    /// @dev #666 — after the trusted search has FAILED, the quote asset (if
    ///      any) whose price is distrusted and over which a route would
    ///      have cleared the floor on everything the search can check
    ///      without that price. Asked only here, where the answer can
    ///      change the verdict: a quote that is merely unavailable, or
    ///      distrusted with no route that clears, leaves the asset
    ///      Illiquid.
    ///
    ///      The probe runs the same pool reads, depth test and TWAP check
    ///      as the trusted search ({_foldRoutes}) and leaves out the one
    ///      check that needs the quote's price, the value-balance guard.
    ///      So an empty pool, or one too shallow to take the floor at the
    ///      configured slippage, cannot turn an Illiquid verdict into a
    ///      refusal; only a route with the depth the trusted search
    ///      demands can. The probe's result never counts toward a Liquid
    ///      verdict or a tier. What it cannot exclude is depth placed at
    ///      a price away from the market, since that is what the missing
    ///      guard checks; such a pool can only delay a close-out while the
    ///      quote stays distrusted, never move collateral.
    function _distrustedQuoteThatClears(
        address asset,
        LibVaipakam.Storage storage s,
        _TierCtx memory ctx,
        uint256[4] memory sizes,
        address[] memory paa
    ) private view returns (address) {
        // `ctx` is finished with for the trusted search; from here every
        // fold skips the value-balance guard.
        ctx.quoteUnvalued = true;
        uint256 slipBound = LibVaipakam.cfgLiquiditySlippageBps();
        for (uint256 qi; qi < paa.length; ++qi) {
            address q = paa[qi];
            if (q == address(0) || q == asset) continue;
            (PriceStatus stQ, , ) = getAssetPriceStatus(q);
            if (stQ != PriceStatus.Divergent) continue;
            uint256[4] memory unvalued = [
                type(uint256).max,
                type(uint256).max,
                type(uint256).max,
                type(uint256).max
            ];
            _foldRoutes(asset, q, s, ctx, 0, 0, sizes, unvalued);
            if (unvalued[0] <= slipBound) return q;
        }
        return address(0);
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
     * @notice Loan-to-value, in basis points, of borrowing `borrowedAmount`
     *         of `borrowedAsset` against `collateralAmount` of
     *         `collateralAsset` — a pair-level PREVIEW of the figure loan
     *         initiation checks.
     * @dev    #2419 — the SAME figure the loan-level path computes
     *         (`RiskFacet.calculateLTV(loanId)`, which initiation,
     *         liquidation, add-collateral and refinance read): each leg is
     *         valued by the one shared rule ({LibNumeraireValue.toValue}, 1e18
     *         numeraire, price over the feed's decimals AND the token's own
     *         decimals, #2403), the borrowed leg rounded UP and the collateral
     *         leg DOWN, and the ratio is {LibRiskMath.ltvBps} over the two
     *         values. So the preview is the binding figure, not an
     *         approximation of it: a nonzero borrow never reads as 0 (its
     *         value rounds up), and no intermediate product can overflow
     *         while both values fit in 256 bits — 2^256 / 1e18 numeraire units
     *         a leg, far above any real amount.
     *
     *         Reverts {ZeroCollateral} on a zero collateral amount, or a
     *         collateral leg that values to zero, as the loan-level path
     *         does; returning 0 read as "no risk". Reverts {ZeroPrice} when
     *         either asset's price resolves to zero (a composed price can
     *         floor to zero from positive feeds; {getAssetPrice} refuses it
     *         too), on a missing or stale feed via {getAssetPrice}, and
     *         {LibNumeraireValue.TokenDecimalsUnreadable} when a token's
     *         `decimals()` cannot be read or exceeds 36. Meaningful only for
     *         liquid (priced) assets.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function calculateLTV(
        address borrowedAsset,
        uint256 borrowedAmount,
        address collateralAsset,
        uint256 collateralAmount
    ) external view returns (uint256 ltv) {
        if (collateralAmount == 0) revert ZeroCollateral();
        uint256 debtValue = _numeraireValue(borrowedAsset, borrowedAmount, true);
        uint256 collateralValue = _numeraireValue(collateralAsset, collateralAmount, false);
        if (collateralValue == 0) revert ZeroCollateral();
        ltv = LibRiskMath.ltvBps(debtValue, collateralValue);
    }

    /// @dev One leg of {calculateLTV}: `amount` of `asset` in 1e18 numeraire
    ///      by the shared rule. A zero price is refused by name, by asset.
    function _numeraireValue(address asset, uint256 amount, bool roundUp)
        private
        view
        returns (uint256)
    {
        (uint256 price, uint8 feedDecimals) = this.getAssetPrice(asset);
        if (price == 0) revert ZeroPrice(asset);
        return LibNumeraireValue.toValue(
            amount, price, feedDecimals, LibNumeraireValue.tokenDecimals(asset), roundUp
        );
    }

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
                    // SafeCast: Chainlink price is non-negative + non-stale
                    // by `_primaryPrice`'s upstream guards. SafeCast.toInt256
                    // catches any pathological uint256 > 2^255 (impossible
                    // with valid feed data, but explicit revert > silent
                    // overflow into a negative int256). Per Codex P2 PR #266.
                    price: SafeCast.toInt256(price),
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

    // ─── Prices: forwarded to the price guard (#3272 part 2) ────────────
    //
    // Every price the Diamond reads comes from the standalone price guard
    // the protocol registry points at ({LibPriceGuard.guard}). The whole
    // pricing path (feed resolution, staleness, the stable-peg branch, the
    // PAD pivot, the Pyth cross-check, the soft secondary quorum and the
    // sequencer check) runs there, under the guard's own delayed config, and
    // the Diamond holds no write path into it. These selectors keep their
    // names and shapes, and a refusal bubbles up with the guard's revert
    // data unchanged, so no consumer facet changes.

    /**
     * @notice The asset's numeraire price and the decimals it is scaled by,
     *         from the price guard.
     * @dev    Reverts with the guard's own refusal ({NoPriceFeed},
     *         {StalePriceData}, {ZeroPrice}, {OraclePriceDivergence},
     *         {OracleCrossCheckDivergence}, {SequencerDown},
     *         {SequencerGracePeriod}, {PadNumeraireRateUnavailable}); the
     *         Diamond declares the same errors, so their selectors are the
     *         ones callers have always decoded. Also reverts when the Diamond
     *         cannot find a guard in its numeraire ({LibPriceGuard.guard}).
     * @param  asset The ERC-20 token address.
     * @return price The numeraire price, scaled by `decimals`.
     * @return decimals The price's decimal scaling.
     */
    function getAssetPrice(
        address asset
    ) external view returns (uint256 price, uint8 decimals) {
        return LibPriceGuard.guard().getAssetPrice(asset);
    }

    /// @notice The live secondary sources (Tellor, API3, DIA) for `asset`,
    ///         split by whether each agrees with the primary price: the
    ///         price guard's count, read by the backstop's oracle-coverage
    ///         gate (#638).
    /// @dev    Reverts only when the primary price read does.
    function countLiveSecondaryOracleFeeds(
        address asset
    ) external view returns (uint8 agreeing, uint8 disagreeing) {
        return LibPriceGuard.guard().countLiveSecondaryOracleFeeds(asset);
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
     *
     *         #2696: both per-asset values are optional tightenings, so the
     *         tuple says whether each was set rather than reporting an unset
     *         row as a number. `loanInitLtvCeilingBps` is the ceiling the LTV
     *         gates apply — `BASIS_POINTS` (no per-asset ceiling) when
     *         `ltvCeilingSet` is false; the tier cap or the admission
     *         health-factor floor then binds. `liqBonusBps == 0` means no
     *         per-asset cap on the dynamic liquidator incentive.
     * @return isSupported   True when the asset is liquid on this chain.
     * @return status        The live liquidity classification.
     * @return ltvCeilingSet Whether governance set a per-asset init-LTV ceiling.
     * @return loanInitLtvCeilingBps The per-asset init-LTV ceiling in effect.
     * @return liqBonusBps   Per-asset liquidator-incentive cap (`0` = none).
     */
    function getAssetRiskProfile(address token)
        external
        view
        returns (
            bool isSupported,
            LibVaipakam.LiquidityStatus status,
            bool ltvCeilingSet,
            uint256 loanInitLtvCeilingBps,
            uint256 liqBonusBps
        )
    {
        if (token == address(0)) {
            return (false, LibVaipakam.LiquidityStatus.Illiquid, false, 0, 0);
        }
        ltvCeilingSet = LibVaipakam.assetInitLtvCeilingSet(token);
        loanInitLtvCeilingBps = LibVaipakam.assetInitLtvCeilingBps(token);
        liqBonusBps = LibVaipakam.storageSlot().assetRiskParams[token].liqBonusBps;
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
        return _liquidityTier(asset, LibVaipakam.storageSlot(), false);
    }

    /**
     * @notice #3359 — the depth tier a forced SALE of `asset` reads: the
     *         same probes as {getLiquidityTier}, measured as a close-out
     *         measures them (the window-mean depth valued at the feed price,
     *         without the checks against the pool's current price, #3354 /
     *         #3371 / #3359), so depth
     *         pulled or a price pushed in the sale's own block cannot change
     *         the tier. The forced-sale floor reads it; it never gates a sale.
     * @param asset The collateral being sold.
     * @return tier `0`..`3` (`0` = shallower than the $50k probe, or not
     *         liquid at close-out).
     */
    function getCloseOutLiquidityTier(address asset) external view returns (uint8 tier) {
        if (asset == address(0)) return 0;
        return _liquidityTier(asset, LibVaipakam.storageSlot(), true);
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
        uint8 onChain = _liquidityTier(asset, LibVaipakam.storageSlot(), false);
        if (onChain == 0) return 0;
        uint8 keeper = LibVaipakam.effectiveKeeperTier(asset);
        return onChain < keeper ? onChain : keeper;
    }

    // ─── Phase 4: autonomous tier-LTV cache ─────────────────────────────

    /// @notice Emitted when a tier's LTV cache is updated by a
    ///         successful refresh. `newLtvBps` is the peer reading after
    ///         the per-tier haircut, stored unclipped: a loan uses it up
    ///         to the tier's governance ceiling (#3547), and
    ///         `getEffectiveTierMaxInitLtvBps` reports what a loan uses.
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
    ///         #3547 retired "out-of-band-low" / "out-of-band-high": a
    ///         reading outside the old safety box is now stored, and the
    ///         tier ceiling applies at the read.
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
     *         consensus requires ≥ 2 peers agree within
     *         `LibVaipakam.PEER_DIVERGENCE_TOLERANCE_BPS` (= 3000 BPS,
     *         i.e. 30%) for each reference asset (the
     *         divergence-tolerance guard — a wide tolerance is
     *         intentional, peers legitimately differ by 10-25% across
     *         protocols for the same asset, and each asset contributes
     *         the LOWEST of its agreeing peers). Per-tier consensus
     *         requires ≥ 2 reference assets contribute (the
     *         multi-asset-stability guard). After aggregation, the
     *         per-tier haircut is subtracted and the result is cached.
     *
     *         #3547 (owner decision 2026-11-11) — the result is stored as
     *         it is, not bound-checked: a reading below the old box floor
     *         is honoured, and one above the tier's governance ceiling is
     *         clipped to that ceiling when a loan reads it
     *         (`LibVaipakam.effectiveTierMaxInitLtvBps`), never here, so a
     *         ceiling governance changes later binds without a refresh.
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
        // #633 — when peer-protocol LTV reads are paused, don't refresh the
        // tier cache from Aave/Compound; the depth-tiered LTV keeps using the
        // last cached values / governance defaults until peers are re-enabled.
        if (LibVaipakam.cfgPeerLtvReadsPaused()) revert PeerLtvReadsPaused();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address aave = s.aaveV3PoolDataProvider;
        address comet = s.compoundV3Comet;

        for (uint8 tier = 1; tier <= 3; ++tier) {
            address[] memory refAssets = LibVaipakam.getTierReferenceAssets(tier);
            if (refAssets.length == 0) {
                emit TierLtvCacheRefreshRejected(tier, 0, "no-reference-assets");
                continue;
            }
            // Single aggregation per tier — `assetsContrib` is kept for
            // the event emission below so we don't pay 300-500k gas to
            // re-run the same view-only aggregation a second time.
            (bool ok, uint16 tierMedian, uint8 assetsContrib) = LibPeerLTV.aggregateTierLtv(
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

            // Apply per-tier haircut (saturate at 0 — never wrap). The
            // tier ceiling is applied at the read (#3547), not here.
            uint16 haircut = LibVaipakam.tierLtvHaircutBps(tier);
            uint16 candidate = tierMedian > haircut ? tierMedian - haircut : 0;

            // Persist + emit.
            uint16 oldVal = s.tierLtvCache[tier].ltvBps;
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
    ///         (the tier default when the reading is stale, the ceiling always).
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
    ///         loan-init gate will use: the cached peer reading while it is
    ///         at most 14 days old and peer reads are not paused, otherwise
    ///         the tier default, and in both cases no more than the tier's
    ///         governance ceiling (#3547). Returns 0 for invalid tier indices.
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


    /// @dev Read a Uni-V3-clone pool's state for the depth-tier route
    ///      search. `ok == false` on any malformed or failed read, an
    ///      un-initialised pool, or a pool whose own oracle cannot answer
    ///      for the whole `twapWindow` (`observe` reverts `OLD` on a
    ///      low-cardinality pool).
    ///
    ///      #3354: the oracle read is REQUIRED, not best-effort. It yields
    ///      the two time-weighted figures the route search needs: the
    ///      window's mean tick (the recent-manipulation guard) and its
    ///      harmonic-mean in-range liquidity, `window · 2¹²⁸ / Δ(seconds
    ///      per liquidity)`. The second is what makes depth durable:
    ///      liquidity that sits in the pool for one block contributes one
    ///      block's worth of seconds to the window, so it barely moves the
    ///      mean. Before #3354 a pool with no oracle history was searched
    ///      on its current state alone, so liquidity added and removed
    ///      around one transaction could make a token read Liquid.
    ///      `liquidity` is the current in-range figure and may be zero (a
    ///      pool just drained); the caller decides which figure it credits.
    function _readV3PoolState(address pool, uint32 twapWindow)
        private
        view
        returns (
            bool ok,
            uint160 sqrtPriceX96,
            uint128 liquidity,
            int24 currentTick,
            int24 meanTick,
            uint256 meanLiquidity
        )
    {
        if (pool == address(0) || pool.code.length == 0 || twapWindow == 0) {
            return (false, 0, 0, 0, 0, 0);
        }
        (bool slotOk, bytes memory slotData) = pool.staticcall(abi.encodeWithSignature("slot0()"));
        if (!slotOk || slotData.length < 224) return (false, 0, 0, 0, 0, 0);
        (sqrtPriceX96, currentTick, , , , , ) = abi.decode(
            slotData,
            (uint160, int24, uint16, uint16, uint16, uint8, bool)
        );
        if (sqrtPriceX96 == 0) return (false, 0, 0, 0, 0, 0);
        (bool liqOk, bytes memory liqData) = pool.staticcall(abi.encodeWithSignature("liquidity()"));
        if (!liqOk || liqData.length < 32) return (false, 0, 0, 0, 0, 0);
        liquidity = abi.decode(liqData, (uint128));
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapWindow;
        secondsAgos[1] = 0;
        (bool obsOk, bytes memory obsData) = pool.staticcall(
            abi.encodeWithSignature("observe(uint32[])", secondsAgos)
        );
        // observe returns (int56[] tickCumulatives, uint160[]
        // secondsPerLiquidityCumulativeX128s); a well-formed 2-element pair
        // encodes to exactly 256 bytes (2 head offsets + 2× [len + 2 words]).
        // The length floor keeps the `abi.decode` from reverting the
        // (never-reverting) classification view on a short return.
        if (!obsOk || obsData.length < 256) return (false, 0, 0, 0, 0, 0);
        (int56[] memory tickCumulatives, uint160[] memory splCumulatives) =
            abi.decode(obsData, (int56[], uint160[]));
        if (tickCumulatives.length < 2 || splCumulatives.length < 2) return (false, 0, 0, 0, 0, 0);
        // The accumulator only grows; a pool reporting otherwise is not a
        // V3 pool this search can read.
        if (splCumulatives[1] <= splCumulatives[0]) return (false, 0, 0, 0, 0, 0);
        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        // REVIEW-SAFECAST: intentional unchecked truncation on the
        // never-reverting route search. A junk meanTick from a malformed
        // pool fails the band comparison in {_accumulatePoolImpacts}
        // instead of reverting the view (Codex P1, PR #267).
        // forge-lint: disable-next-line(unsafe-typecast)
        meanTick = int24(delta / int56(int256(uint256(twapWindow))));
        meanLiquidity = (uint256(twapWindow) << 128) /
            uint256(splCumulatives[1] - splCumulatives[0]);
        ok = true;
    }

    /// @dev Asset-side parameters shared across the whole route search,
    ///      bundled to keep {_liquidityTier} / {_routeOverQuote} /
    ///      {_accumulatePoolImpacts} clear of the viaIR stack ceiling.
    ///      `pA` = the classified asset's Chainlink price (feed-scaled);
    ///      `scaleA` = `10**(feedDecimals + tokenDecimals)` so a
    ///      PAD↔base-unit conversion is one `mulDiv`; `band` =
    ///      `twapConsistencyBps`; `twapWindow` = `twapWindowSec`.
    ///      `quoteUnvalued` (#666): the quote's price is distrusted, so its
    ///      leg has no value and the value-balance guard is skipped; depth
    ///      and the TWAP check still run. Set only by
    ///      {_distrustedQuoteThatClears}, whose result never counts toward
    ///      a Liquid verdict or a tier.
    // forge-lint: disable-next-line(pascal-case-struct)
    struct _TierCtx {
        uint256 pA;
        uint256 scaleA;
        uint256 band;
        uint32 twapWindow;
        bool quoteUnvalued;
        bool closeOut;
    }

    /// @dev For one resolved Uni-V3-clone pool, fold its best-route
    ///      contribution into `best[i]` = the lowest price-impact seen at
    ///      `sizes[i]` (PAD × 1e6) across every pool — *after* the two
    ///      manipulation guards (value-balance / spot≈feed, and the
    ///      TWAP-consistency tick check), which run for admission reads
    ///      only (#3371). `best` and `sizes`
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
            uint160 sqrtPriceX96,
            uint128 curLiquidity,
            int24 curTick,
            int24 meanTick,
            uint256 meanLiquidity
        ) = _readV3PoolState(pool, ctx.twapWindow);
        if (!stOk) return;
        // #3354 — the depth credited. Admission (a loan opening, a tier, an
        // offer bound) credits the LOWER of the current and the
        // window-mean liquidity, so neither a one-block top-up nor a pool
        // drained since can make the asset look deeper than it is. A
        // close-out (the liquidation and default gates) credits the mean
        // alone, so liquidity pulled in the same block as the close-out
        // cannot make a loan that opened liquid refuse its sale; the sale's
        // own floor and the in-kind fallback then govern what a thin pool
        // can actually fill.
        uint256 credited = meanLiquidity;
        if (!ctx.closeOut && curLiquidity < credited) credited = curLiquidity;
        if (credited == 0) return;
        if (credited > type(uint128).max) credited = type(uint128).max;
        uint256 reserveAsset;
        uint256 reserveQ;
        if (ctx.closeOut && !ctx.quoteUnvalued) {
            // #3359 — a close-out builds the asset's reserve at the FEED
            // price, not at the pool's current price. The virtual reserve
            // depends on the price as well as on the liquidity, so a swap in
            // the close-out's own block would otherwise move the reserve,
            // and with it the probe impacts and the depth tier a forced
            // sale's floor is read from. The credited depth is the window
            // mean and the price is the feed's, so nothing the block itself
            // does moves the figure. Only the asset leg is needed: the
            // quote leg serves the admission guards below, which a
            // close-out does not run. A distrusted quote has no feed price
            // to use; that route keeps the pool's price and never counts
            // toward a Liquid verdict or a tier.
            reserveAsset = _feedImpliedAssetReserve(credited, ctx, pQ, scaleQ);
            if (reserveAsset == 0) return;
        } else {
            // forge-lint: disable-next-line(unsafe-typecast)
            (uint256 r0, uint256 r1) = LibSlippage.v3VirtualReserves(uint128(credited), sqrtPriceX96);
            if (r0 == 0 || r1 == 0) return;
            (reserveAsset, reserveQ) = assetIsToken0 ? (r0, r1) : (r1, r0);
        }
        // The two price-agreement guards below run for admission only
        // (#3371). They refuse a pool whose current price disagrees with the
        // feed or with its own window mean, which is what keeps a
        // manipulated pool from admitting a position. At a close-out they
        // would refuse the same pools in a genuine fast move (the current
        // tick runs ahead of its 30-minute mean) or after a one-block price
        // push, so the collateral would read not liquid exactly when its
        // liquidation or default must run. A close-out does not need them:
        // the forced sale demands an oracle-derived minimum output, and the
        // in-kind fallback takes over when no route meets it, so a moved
        // pool can only fail to fill, never fill at a bad price.
        if (!ctx.closeOut) {
            // Guard 1 — the two legs' Chainlink-priced values must be
            // balanced within `band` bps (⇔ the pool's spot price agrees
            // with the trusted feed): `legValueRatio = feedMid / poolMid`,
            // so balanced legs ⇔ poolMid ≈ feedMid. Skipped when the quote's
            // price is distrusted (`ctx.quoteUnvalued`, #666): there is no
            // trusted value to balance against.
            if (!ctx.quoteUnvalued) {
                uint256 vAsset = Math.mulDiv(reserveAsset, ctx.pA * 1e6, ctx.scaleA); // PAD × 1e6
                uint256 vQ = Math.mulDiv(reserveQ, pQ * 1e6, scaleQ); // PAD × 1e6
                if (vAsset == 0 || vQ == 0) return;
                (uint256 lo, uint256 hi) = vAsset < vQ ? (vAsset, vQ) : (vQ, vAsset);
                uint256 bp = LibVaipakam.BASIS_POINTS;
                if (ctx.band < bp && lo * bp < hi * (bp - ctx.band)) return;
            }
            // Guard 2 — the `twapWindow`-mean tick must be within `band`
            // ticks of the current tick (1 tick ≈ 1 bp of price for small
            // `band`), which catches a *recently*-manipulated pool that
            // guard 1 alone would miss if the price has since reverted.
            int256 d = int256(curTick) - int256(meanTick);
            if (d < 0) d = -d;
            // safe: `d` was just made non-negative above.
            // forge-lint: disable-next-line(unsafe-typecast)
            if (uint256(d) > ctx.band) return;
        }
        // Fold the price-impact at each test size into the running best.
        // Each size keeps its own best (lowest) impact over every pool. The
        // tiering walks the sizes upward and assumes no order between them
        // (#2752: at dust sizes the fee's base-unit rounding makes a smaller
        // trade read worse than a larger one).
        for (uint256 si; si < 4; ++si) {
            if (best[si] == 0 || sizes[si] == 0) continue;
            uint256 amountIn = Math.mulDiv(sizes[si], ctx.scaleA, ctx.pA * 1e6); // asset base units
            if (amountIn == 0) continue;
            uint256 imp = LibSlippage.priceImpactBps(amountIn, reserveAsset, uint256(fee));
            if (imp < best[si]) best[si] = imp;
        }
    }

    /// @dev #3359 — the asset's virtual reserve in a V3 pool of liquidity
    ///      `liquidity`, at the price the two feeds imply rather than the
    ///      pool's own. With `P` the pool price (token1 per token0, base
    ///      units), the reserves are `L / sqrt(P)` (token0) and
    ///      `L * sqrt(P)` (token1); whichever side the asset is on, its
    ///      reserve is `L * sqrt(R)`, where `R` = asset base units per quote
    ///      base unit = `(pQ / scaleQ) / (pA / scaleA)`. `R` is taken with
    ///      128 fractional bits, so its root carries 64. Rounds down, which
    ///      reads the pool as no deeper than it is. Returns 0 when a feed
    ///      figure is zero.
    function _feedImpliedAssetReserve(
        uint256 liquidity,
        _TierCtx memory ctx,
        uint256 pQ,
        uint256 scaleQ
    ) private pure returns (uint256) {
        uint256 den = ctx.pA * scaleQ;
        uint256 num = pQ * ctx.scaleA;
        if (den == 0 || num == 0) return 0;
        uint256 rootX64 = Math.sqrt(Math.mulDiv(num, uint256(1) << 128, den));
        return Math.mulDiv(liquidity, rootX64, uint256(1) << 64);
    }

    /// @dev Route the `asset/q` pair over every configured Uni-V3-clone
    ///      venue ({_foldRoutes}), folding each found pool's
    ///      contribution into `best`. Skips `q` entirely unless its price
    ///      reads as Priced: an unavailable quote cannot value its leg, and
    ///      a distrusted one (#666) is weighed separately, only when the
    ///      trusted search has failed ({_distrustedQuoteThatClears}).
    function _routeOverQuote(
        address asset,
        address q,
        LibVaipakam.Storage storage s,
        _TierCtx memory ctx,
        uint256[4] memory sizes,
        uint256[4] memory best
    ) private view {
        (bool usable, uint256 pQ, uint256 scaleQ) = _quoteLeg(q);
        if (!usable) return;
        _foldRoutes(asset, q, s, ctx, pQ, scaleQ, sizes, best);
    }

    /// @notice #2747 — whether the tier search can route over `quote`: the
    ///         same test {_routeOverQuote} applies before it inspects any
    ///         pool, exposed so the launch readiness check asks the Diamond
    ///         the question the tier search asks instead of keeping its own
    ///         copy. A quote that fails it is skipped whatever the depth of
    ///         its pools, so a quote-asset list naming only such quotes
    ///         leaves every asset it would tier at tier 0.
    /// @dev    Says nothing about depth: a usable quote with shallow pools
    ///         still tiers an asset low. Reads the price live, so a stale
    ///         or distrusted round answers false until it recovers.
    /// @param  quote The quote asset to test.
    /// @return usable True iff `quote` has a trusted, positive price and a
    ///         readable `decimals()`.
    function isLiquidityQuoteUsable(address quote) external view returns (bool usable) {
        (usable, , ) = _quoteLeg(quote);
    }

    /// @dev The one rule for a quote leg (#2747): Priced (an unavailable
    ///      quote cannot value its leg, and a distrusted one, #666, is
    ///      weighed only by {_distrustedQuoteThatClears}), a positive price,
    ///      and a readable `decimals()` (#2419). `scaleQ` is
    ///      `10**(feedDecimals + tokenDecimals)`; both values are zero when
    ///      the quote is not usable.
    function _quoteLeg(address q) private view returns (bool usable, uint256 pQ, uint256 scaleQ) {
        (PriceStatus stQ, uint256 p, uint8 dQ) = getAssetPriceStatus(q);
        if (stQ != PriceStatus.Priced || p == 0) return (false, 0, 0);
        (bool okDecQ, uint8 tdQ) = LibNumeraireValue.tryTokenDecimals(q);
        if (!okDecQ) return (false, 0, 0);
        return (true, p, 10 ** (uint256(dQ) + uint256(tdQ)));
    }

    /// @dev The pool walk {_routeOverQuote} and {_distrustedQuoteThatClears}
    ///      share: every configured Uni-V3-clone factory at every fee tier
    ///      ≤ 0.3% (no V2 fork since #3354). `pQ`/`scaleQ` value the
    ///      quote leg; both are zero, and unread, when `ctx.quoteUnvalued`.
    function _foldRoutes(
        address asset,
        address q,
        LibVaipakam.Storage storage s,
        _TierCtx memory ctx,
        uint256 pQ,
        uint256 scaleQ,
        uint256[4] memory sizes,
        uint256[4] memory best
    ) private view {
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
        // #3354 — no V2-fork leg. A constant-product pair keeps no
        // time-weighted record of its reserves, so its depth can only be
        // read as it stands in the current block, which a caller can top
        // up and withdraw around one transaction. V2-only depth therefore
        // never makes an asset Liquid or earns it a tier.
    }

    /// @dev The on-chain liquidity tier of `asset` (0..3) — see
    ///      {getLiquidityTier} for the full semantics. `0` iff the asset
    ///      doesn't classify `Liquid` (covers sequencer-down / no feed /
    ///      no $1M WETH pool / `pauseAsset`-blacklisted), or it can't
    ///      clear the `floorSizePad` simulated swap at
    ///      `liquiditySlippageBps` on any valid {effectivePaaAssets} ×
    ///      {Uni/Pancake/Sushi V3} × {fee ≤ 0.3%} route.
    function _liquidityTier(address asset, LibVaipakam.Storage storage s, bool closeOut)
        internal
        view
        returns (uint8)
    {
        (LibVaipakam.LiquidityStatus status, ) = _classifyLiquidity(asset, closeOut);
        if (status != LibVaipakam.LiquidityStatus.Liquid) return 0;
        (bool okA, uint256 pA, uint8 dA) = tryGetAssetPrice(asset);
        if (!okA || pA == 0) return 0;
        (bool okDec, uint8 tdA) = LibNumeraireValue.tryTokenDecimals(asset);
        if (!okDec) return 0; // the Liquid check refuses it, except for the configured WETH
        _TierCtx memory ctx = _TierCtx({
            pA: pA,
            scaleA: 10 ** (uint256(dA) + uint256(tdA)),
            band: LibVaipakam.cfgTwapConsistencyBps(),
            twapWindow: uint32(LibVaipakam.cfgTwapWindowSec()),
            quoteUnvalued: false,
            closeOut: closeOut
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
        // A tier is earned only by clearing EVERY probe size up to its own,
        // walked upward (#2752). The rule assumes nothing about how impact
        // grows with size: the swap fee's base-unit rounding makes a
        // dust-sized probe read WORSE than a larger one, so reading the
        // largest cleared size alone could rank an asset above a smaller
        // size it failed.
        if (best[0] > slipBound) return 0; // can't clear `floorSizePad` ($5k) ⇒ untierable
        // #1007 (S11) — Tier 1 requires clearing the $50k `tier1SizePad` probe
        // (`best[1]`), not merely the $5k floor. Pre-#1007 `best[1]` was computed
        // but never read, so an asset that absorbed $5k but not $50k was silently
        // promoted to Tier 1 (and, pre-#999, its 90% liquidation threshold). Such
        // an asset now falls to tier 0 (untierable) → the conservative tier-0 caps
        // (0% init-LTV, the Tier-1 liquidation floor), and the `tier1SizePad`
        // governance knob becomes live.
        if (best[1] > slipBound) return 0; // cleared $5k but not $50k ⇒ untierable
        if (best[2] > slipBound) return 1; // clears $50k ⇒ Tier 1
        if (best[3] > slipBound) return 2; // clears $500k
        return 3; // clears $5M ⇒ deepest
    }

    /// @notice What a price read found (#666). `Priced`: {getAssetPrice}
    ///         returned. `Unavailable`: there is no price to use right now
    ///         (no feed, a stale or non-positive answer, the sequencer
    ///         down, any other failure). `Divergent`: a price was read, but
    ///         the independent sources the read checks it against disagree:
    ///         every secondary oracle that responded disagreed with
    ///         Chainlink ({OraclePriceDivergence}), or the Pyth cross-check
    ///         of the ETH reference price diverged beyond its bound
    ///         ({OracleCrossCheckDivergence}). The price exists and is
    ///         DISTRUSTED. The two failures need opposite treatment where a
    ///         missing price hands the lender the whole collateral: a
    ///         missing price may, a distrusted one must refuse instead.
    enum PriceStatus { Priced, Unavailable, Divergent }

    /// @notice {getAssetPrice} without the revert, naming why a read
    ///         failed: the price guard's classification, the one place a
    ///         failed read is classified. Every caller that must tell "no
    ///         price" from "a price the quorum distrusts" reads this, never
    ///         the revert data itself.
    /// @dev    Reverts, rather than reading Unavailable, when the Diamond
    ///         cannot find a guard in its numeraire ({LibPriceGuard.guard}):
    ///         a missing guard is a deploy defect, and reading it as "no
    ///         price" would hand a lender the whole collateral on a price
    ///         nobody looked up.
    function getAssetPriceStatus(address asset)
        public
        view
        returns (PriceStatus status, uint256 price, uint8 decimals)
    {
        IPriceGuard.PriceStatus st;
        (st, price, decimals) = LibPriceGuard.guard().getAssetPriceStatus(asset);
        status = PriceStatus(uint8(st));
    }

    /// @notice `getAssetPrice` look-alike that never reverts on a refused
    ///         price: callers that fail closed (the {checkLiquidity},
    ///         {getIlliquidAssets}) can detect a pricing failure without
    ///         bubbling a revert. `ok` is false for a missing AND for a
    ///         distrusted price alike, which is right for a caller that only
    ///         proceeds on a usable price. A caller that would act
    ///         one-sidedly on "no price" reads {getAssetPriceStatus} instead
    ///         (#666).
    function tryGetAssetPrice(address asset)
        public
        view
        returns (bool ok, uint256 price, uint8 decimals)
    {
        PriceStatus status;
        (status, price, decimals) = getAssetPriceStatus(asset);
        ok = status == PriceStatus.Priced;
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

    // ─── Sequencer uptime (read from the price guard) ──────────────────

    /// @notice Whether the L2 sequencer is up and past its grace period, as
    ///         the price guard reads it (true on an L1, where no sequencer
    ///         feed is set). Consumed by the default and liquidation facets
    ///         to choose between a swap and the full-collateral transfer.
    function sequencerHealthy() external view returns (bool) {
        return LibPriceGuard.guard().sequencerHealthy();
    }
}
