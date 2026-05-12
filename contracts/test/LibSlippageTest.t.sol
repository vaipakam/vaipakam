// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {LibSlippage} from "../src/libraries/LibSlippage.sol";

/// @dev Wrapper so the pure `internal` library functions get an external
///      ABI surface `expectRevert` can target by selector.
contract SlippageHarness {
    function amountOut(uint256 aIn, uint256 rIn, uint256 rOut, uint256 feePips)
        external
        pure
        returns (uint256)
    {
        return LibSlippage.constantProductAmountOut(aIn, rIn, rOut, feePips);
    }

    function impactBps(uint256 aIn, uint256 rIn, uint256 feePips)
        external
        pure
        returns (uint256)
    {
        return LibSlippage.priceImpactBps(aIn, rIn, feePips);
    }

    function v3Reserves(uint128 liquidity, uint160 sqrtPriceX96)
        external
        pure
        returns (uint256 r0, uint256 r1)
    {
        return LibSlippage.v3VirtualReserves(liquidity, sqrtPriceX96);
    }
}

/// @notice Unit tests for {LibSlippage} — the pure constant-product
///         price-impact + V3-virtual-reserve math behind the depth-tiered
///         liquidity check (Piece B, §4.1).
contract LibSlippageTest is Test {
    SlippageHarness internal h;

    uint256 internal constant FEE_03 = 3000; // 0.30% (Uni-V2 / Uni-V3 0.3% tier)
    uint256 internal constant FEE_005 = 500; // 0.05% (Uni-V3)
    uint256 internal constant FEE_0 = 0;

    function setUp() public {
        h = new SlippageHarness();
    }

    // ─── constantProductAmountOut ────────────────────────────────────

    function test_amountOut_balancedPool_smallTrade() public view {
        // 1e21 : 1e21 reserves, sell 1e18 at 0.3% → out ≈ 0.996e18 (just
        // under the post-fee 0.997e18, the CPMM curve eating a sliver).
        uint256 out = h.amountOut(1e18, 1e21, 1e21, FEE_03);
        assertLt(out, 997 * 1e15, "out must be below the post-fee input");
        assertGt(out, 996 * 1e15, "out must be close to post-fee for a tiny trade");
    }

    function test_amountOut_zeroInput_isZero() public view {
        assertEq(h.amountOut(0, 1e21, 1e21, FEE_03), 0);
    }

    function test_amountOut_isConcave_inAmountIn() public view {
        // Doubling the input yields strictly less than double the output
        // (price impact) — the defining property of x·y=k.
        uint256 a = h.amountOut(10e18, 1e21, 1e21, FEE_0);
        uint256 b = h.amountOut(20e18, 1e21, 1e21, FEE_0);
        assertLt(b, 2 * a, "output must be concave in input");
    }

    function test_amountOut_revertsOnZeroReserve() public {
        vm.expectRevert(LibSlippage.InvalidReserves.selector);
        h.amountOut(1e18, 0, 1e21, FEE_03);
        vm.expectRevert(LibSlippage.InvalidReserves.selector);
        h.amountOut(1e18, 1e21, 0, FEE_03);
    }

    function test_amountOut_revertsOnFeeTooHigh() public {
        vm.expectRevert(LibSlippage.FeeTooHigh.selector);
        h.amountOut(1e18, 1e21, 1e21, 1_000_000);
    }

    // ─── priceImpactBps ──────────────────────────────────────────────

    function test_impact_dustTrade_isJustTheFee() public view {
        // A trade negligible vs the reserve eats essentially only the
        // swap fee: 0.30% → 30 bps, 0.05% → 5 bps (exact — `dxNet` rounds
        // to 0 against a 1e30 reserve, leaving ratio = (1−fee)·BPS).
        assertEq(h.impactBps(1, 1e30, FEE_03), 30);
        assertEq(h.impactBps(1, 1e30, FEE_005), 5);
        // Fee-free, `dxNet == amountIn` (no fee floor to 0), so the
        // sub-wei impact rounds *up* to 1 bp — a deliberate conservative
        // bias (the tier check must never *over*-state liquidity).
        assertLe(h.impactBps(1, 1e30, FEE_0), 1);
    }

    function test_impact_onePercentOfReserve_isAboutOnePercent() public view {
        // Sell 1% of the (input-side) reserve, no fee → executed price is
        // ~1/1.01 of the mid → ~99 bps impact (the CPMM curve, fee-free).
        uint256 bps = h.impactBps(1e21 / 100, 1e21, FEE_0);
        assertGe(bps, 98);
        assertLe(bps, 100);
    }

    function test_impact_oneReserveSizedTrade_is50pct() public view {
        // Selling exactly 1× the reserve (fee-free): k stays fixed, so
        // the executed price is half the mid → 5000 bps.
        assertEq(h.impactBps(1e21, 1e21, FEE_0), 5000);
    }

    function test_impact_hugeTrade_approachesFull() public view {
        // Dumping 1000× the reserve nearly zeroes the executed price.
        uint256 bps = h.impactBps(1000 * 1e21, 1e21, FEE_0);
        assertGt(bps, 9900, "an oversized dump should be near-total impact");
        assertLe(bps, 10000);
    }

    function test_impact_zeroInput_isZero() public view {
        assertEq(h.impactBps(0, 1e21, FEE_03), 0);
    }

    function test_impact_revertsOnZeroReserve() public {
        vm.expectRevert(LibSlippage.InvalidReserves.selector);
        h.impactBps(1e18, 0, FEE_03);
    }

    function test_impact_revertsOnFeeTooHigh() public {
        vm.expectRevert(LibSlippage.FeeTooHigh.selector);
        h.impactBps(1e18, 1e21, 1_000_000);
    }

    /// @dev Decimal-independence: the same *fractional* trade against the
    ///      same *fractional* reserve gives the same impact regardless of
    ///      the token's decimals (6-dec USDC-like vs 18-dec WETH-like).
    function test_impact_isDecimalIndependent() public view {
        uint256 a = h.impactBps(1_000 * 1e6, 1_000_000 * 1e6, FEE_03); // 6-dec
        uint256 b = h.impactBps(1_000 * 1e18, 1_000_000 * 1e18, FEE_03); // 18-dec
        assertEq(a, b);
    }

    /// @dev Monotonicity: impact is non-decreasing in `amountIn`.
    function testFuzz_impact_monotoneInAmountIn(uint256 a1, uint256 delta, uint256 reserveIn)
        public
        view
    {
        reserveIn = bound(reserveIn, 1e6, 1e30);
        a1 = bound(a1, 0, 1e30);
        delta = bound(delta, 0, 1e30);
        uint256 i1 = h.impactBps(a1, reserveIn, FEE_03);
        uint256 i2 = h.impactBps(a1 + delta, reserveIn, FEE_03);
        assertGe(i2, i1);
        assertLe(i2, 10000);
    }

    // ─── v3VirtualReserves ───────────────────────────────────────────

    function test_v3Reserves_priceOne_bothEqualLiquidity() public view {
        // sqrtPriceX96 = 2⁹⁶ ⇒ price 1 ⇒ both legs == L.
        (uint256 r0, uint256 r1) = h.v3Reserves(uint128(1e21), uint160(1 << 96));
        assertEq(r0, 1e21);
        assertEq(r1, 1e21);
    }

    function test_v3Reserves_priceFour_splitsTwoToOne() public view {
        // sqrtPriceX96 = 2⁹⁷ ⇒ price 4 ⇒ r0 = L/2, r1 = 2L.
        (uint256 r0, uint256 r1) = h.v3Reserves(uint128(1e21), uint160(1 << 97));
        assertEq(r0, 5e20);
        assertEq(r1, 2e21);
    }

    function test_v3Reserves_revertsOnZeroSqrtPrice() public {
        vm.expectRevert(LibSlippage.InvalidReserves.selector);
        h.v3Reserves(uint128(1e21), 0);
    }

    /// @dev The product `r0·r1 = L²` for any price (the constant-product
    ///      identity at the tick) — sanity-checks the coordinate transform.
    function testFuzz_v3Reserves_productIsLiquiditySquared(uint128 liquidity, uint160 sqrtPriceX96)
        public
        view
    {
        liquidity = uint128(bound(liquidity, 1, type(uint96).max));
        sqrtPriceX96 = uint160(bound(sqrtPriceX96, 1 << 48, type(uint160).max));
        (uint256 r0, uint256 r1) = h.v3Reserves(liquidity, sqrtPriceX96);
        // Allow a 1-unit rounding wobble per leg from the two ⌊·⌋s.
        uint256 lhs = r0 * r1;
        uint256 rhs = uint256(liquidity) * uint256(liquidity);
        // r0·r1 = (L·2⁹⁶/√P)·(L·√P/2⁹⁶) = L² exactly when both divisions
        // are exact; otherwise it's slightly below L². Bound the slack.
        assertLe(lhs, rhs);
        // Each ⌊·⌋ drops < 1 unit, so r0 ≥ L·2⁹⁶/√P − 1 and likewise r1;
        // the product loss is bounded by ~(r0 + r1) — generous bound:
        assertGe(lhs + r0 + r1 + 1, rhs);
    }
}
