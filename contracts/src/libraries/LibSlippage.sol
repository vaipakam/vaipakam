// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title  LibSlippage
 * @notice Pure pool arithmetic for the depth-tiered-LTV liquidity check
 *         (Piece B — docs/DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md
 *         §4.1). Two-and-a-half primitives:
 *
 *           1. {constantProductAmountOut} — the Uni-V2-style `x·y=k`
 *              swap output for `amountIn`, charging `feePips` (in 1e6ths)
 *              on the input. `feePips` is explicit so the same function
 *              covers Uni-V2 forks (0.30% / Pancake-V2 0.25%) *and* every
 *              Uni-V3 fee tier (`100` / `500` / `2500` / `3000`).
 *
 *           2. {priceImpactBps} — how far the *executed* price of that
 *              swap falls below the pool's pre-trade mid price, fee
 *              included, in basis points. This is the figure the design
 *              doc's "tier = which test size the asset clears at ≤ the
 *              slippage bound" rule keys on — i.e. "if a liquidator
 *              dumped `amountIn` of this asset right now, how much worse
 *              than the mid would they net?". Crucially **decimal-
 *              independent**: the closed form collapses to a ratio of
 *              like-unit (token-in) quantities, so callers never need the
 *              token-out side's decimals (and a stable↔stable pool
 *              correctly scores ~0 impact, unlike `liquidity()`-based
 *              metrics — see §3/§4.1).
 *
 *           ½. {v3VirtualReserves} — a Uni-V3-clone pool's *virtual*
 *              reserves at the current tick, `r0 = L·2⁹⁶/√P_X96` (token0)
 *              and `r1 = L·√P_X96/2⁹⁶` (token1), in token base units.
 *              Feeding those into (1)/(2) is the in-tick constant-product
 *              **approximation** the design settled on (§4.1): exact while
 *              the trade stays inside the current tick — which a small
 *              trade against a pool with millions in `L` does, and which
 *              the larger test trades do *iff* the pool is deep enough to
 *              be in that tier anyway — and fail-safe (it under-states
 *              depth, never over-states) for a large trade whose adjacent
 *              ticks are thin. Walking the ticks for an exact answer is
 *              the Uni Quoter (~100k–500k gas/call) — too heavy for the
 *              `createOffer`/`initiateLoan` hot path; the keeper relay
 *              (§4.4 step 5) runs the Quoter off-chain for the exact
 *              cross-check.
 *
 *         No storage, no external calls — trivially unit-testable and
 *         audit-friendly. Sizing the test trade (a PAD-denominated tier
 *         size → token-in base units) and the spot≈Chainlink-feed / TWAP
 *         consistency guards live in {OracleFacet}, which has the price
 *         machinery; this library is purely the constant-product math.
 *         `Math.mulDiv` (full 512-bit intermediate) guards every product.
 */
library LibSlippage {
    /// @dev Uni-V3 fixed-point base for `sqrtPriceX96` (= 2**96).
    uint256 internal constant Q96 = 1 << 96;
    /// @dev Fee denominator for `feePips` — 1e6, the Uniswap convention
    ///      (a 0.30% pool is `feePips = 3000`, 0.05% is `500`, …).
    uint256 internal constant FEE_DENOM = 1_000_000;
    /// @dev Basis-points scale for the returned price-impact figure.
    uint256 internal constant BPS = 10_000;

    /// @dev A reserve (or `sqrtPriceX96`) was zero — un-initialised /
    ///      drained pool, or a `staticcall` against a non-pool that
    ///      decoded to zeroes.
    error InvalidReserves();
    /// @dev `feePips >= FEE_DENOM` — a 100%+ fee is degenerate (the swap
    ///      would yield nothing); callers pass a real Uni fee tier.
    error FeeTooHigh();

    /**
     * @notice Constant-product (`x·y=k`) swap output: the amount of the
     *         output token received for `amountIn` of the input token
     *         against a pool with reserves `(reserveIn, reserveOut)`,
     *         charging `feePips`/1e6 on the input.
     * @dev    `dxNet = ⌊amountIn · (FEE_DENOM − feePips) / FEE_DENOM⌋` ;
     *         `amountOut = ⌊reserveOut · dxNet / (reserveIn + dxNet)⌋`.
     *         Reverts {InvalidReserves} on a zero reserve and {FeeTooHigh}
     *         on `feePips ≥ FEE_DENOM`. Returns `0` for `amountIn == 0`
     *         (or when the post-fee input rounds to zero).
     * @param amountIn   Input-token amount, in the input token's base units.
     * @param reserveIn  Input-token reserve in the pool (base units; for a
     *                   Uni-V3 pool pass the {v3VirtualReserves} value).
     * @param reserveOut Output-token reserve in the pool (base units).
     * @param feePips    Pool fee in 1e6ths (e.g. `3000` for a 0.30% pool).
     * @return amountOut Output-token amount, in the output token's base units.
     */
    function constantProductAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 feePips
    ) internal pure returns (uint256 amountOut) {
        if (reserveIn == 0 || reserveOut == 0) revert InvalidReserves();
        if (feePips >= FEE_DENOM) revert FeeTooHigh();
        if (amountIn == 0) return 0;
        uint256 dxNet = Math.mulDiv(amountIn, FEE_DENOM - feePips, FEE_DENOM);
        if (dxNet == 0) return 0;
        amountOut = Math.mulDiv(reserveOut, dxNet, reserveIn + dxNet);
    }

    /**
     * @notice Price impact, in basis points, of swapping `amountIn` of
     *         the input token against `(reserveIn)` at `feePips` — i.e.
     *         `1 − (executed price ÷ pre-trade mid price)`, fee included.
     * @dev    For the constant product, `executedPrice / midPrice`
     *         collapses to a ratio of like-unit (token-in) quantities:
     *
     *             exec/mid = (1 − fee) · reserveIn / (reserveIn + dxNet)
     *
     *         where `dxNet = amountIn · (1 − fee)` — *no token-out
     *         quantity appears*, so the caller never needs the token-out
     *         decimals, and the metric is identical whether the pool is
     *         WETH/USDC, USDC/USDT (≈0 impact — correctly "deep"), or
     *         WETH/SHIB. Hence:
     *
     *             impactBps = BPS − BPS·(FEE_DENOM − feePips)·reserveIn
     *                               ÷ (FEE_DENOM·(reserveIn + dxNet))
     *
     *         computed via one `Math.mulDiv(BPS·(FEE_DENOM − feePips),
     *         reserveIn, FEE_DENOM·(reserveIn + dxNet))` — the
     *         `BPS·(FEE_DENOM − feePips)` factor is ≤ 1e10, the divisor
     *         `FEE_DENOM·(reserveIn + dxNet)` is bounded by `uint256` for
     *         any real ERC-20 reserve, and `mulDiv` carries the 512-bit
     *         `· reserveIn` intermediate. Result clamped to `[0, BPS]`.
     *         Reverts {InvalidReserves}/{FeeTooHigh} like
     *         {constantProductAmountOut}; returns `0` for `amountIn == 0`.
     *
     *         The `ratioBps` is `mulDiv`-floored, which biases the
     *         returned `impactBps` *upward* by at most 1 bp — a
     *         deliberate, fail-safe direction for a tier gate (it can
     *         only ever *under*-tier a borderline asset, never over-tier
     *         it). Note also that even an infinitesimal trade returns
     *         ≈ `feePips/100` bps of impact — the swap fee is part of
     *         what a liquidator eats, so the "≤ 2%" tier bound is
     *         *inclusive* of it (a 0.30% pool starts at 30 bps, leaving
     *         ~170 bps of headroom for actual price impact). A trade far
     *         larger than the pool degrades correctly toward `BPS`
     *         (≈100% impact).
     * @param amountIn  Input-token amount, in the input token's base units.
     * @param reserveIn Input-token reserve in the pool (base units; for a
     *                  Uni-V3 pool pass the {v3VirtualReserves} value).
     * @param feePips   Pool fee in 1e6ths.
     * @return impactBps Price impact in basis points, in `[0, 10000]`.
     */
    function priceImpactBps(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 feePips
    ) internal pure returns (uint256 impactBps) {
        if (feePips >= FEE_DENOM) revert FeeTooHigh();
        if (reserveIn == 0) revert InvalidReserves();
        if (amountIn == 0) return 0;
        uint256 dxNet = Math.mulDiv(amountIn, FEE_DENOM - feePips, FEE_DENOM);
        // exec/mid · BPS, rounded down. dxNet == 0 ⇒ ratio = (1−fee)·BPS
        // exactly (an all-but-dust trade still eats the fee).
        uint256 ratioBps = Math.mulDiv(
            BPS * (FEE_DENOM - feePips),
            reserveIn,
            FEE_DENOM * (reserveIn + dxNet)
        );
        return ratioBps >= BPS ? 0 : BPS - ratioBps;
    }

    /**
     * @notice The virtual reserves of a Uniswap-V3-clone pool at the
     *         current tick, in token base units.
     * @dev    `reserve0 = ⌊L · 2⁹⁶ / √P_X96⌋` (token0),
     *         `reserve1 = ⌊L · √P_X96 / 2⁹⁶⌋` (token1). Exact *at* the
     *         current tick — see the contract-level note on the in-tick
     *         CPMM approximation. Reverts {InvalidReserves} on
     *         `sqrtPriceX96 == 0` (un-initialised pool). `liquidity == 0`
     *         is *not* rejected here (it yields `(0, 0)`, which the
     *         downstream {constantProductAmountOut}/{priceImpactBps} then
     *         reject as {InvalidReserves}) — keeping this helper a pure
     *         coordinate transform.
     * @param liquidity     The pool's in-range `liquidity()` (uint128).
     * @param sqrtPriceX96  The pool's `slot0().sqrtPriceX96` (uint160).
     * @return reserve0 token0 virtual reserve (base units).
     * @return reserve1 token1 virtual reserve (base units).
     */
    function v3VirtualReserves(
        uint128 liquidity,
        uint160 sqrtPriceX96
    ) internal pure returns (uint256 reserve0, uint256 reserve1) {
        if (sqrtPriceX96 == 0) revert InvalidReserves();
        reserve0 = Math.mulDiv(uint256(liquidity), Q96, uint256(sqrtPriceX96));
        reserve1 = Math.mulDiv(uint256(liquidity), uint256(sqrtPriceX96), Q96);
    }
}
