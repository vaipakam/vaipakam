// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {OracleFacet} from "../../src/facets/OracleFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {MockSwapAdapter} from "../mocks/MockSwapAdapter.sol";
import {TestnetMockOracleRig} from "./TestnetMockOracleRig.sol";

/**
 * @title TestnetMockPricesTest
 * @notice Proves the realistic faucet-token pricing wired by
 *         {DeployTestnetMocks} keeps every liquid faucet token classifying
 *         **Liquid** even though the tokens now carry DISTINCT USD prices
 *         (tLIQ $2,000 / mUSDC $1 / mWETH $3,000).
 *
 *         The load-bearing piece is {DeployTestnetMocks._poolSqrtPriceX96}:
 *         once the legs' prices differ a plain 1:1 pool would fail
 *         `OracleFacet`'s value-balance guard and each token would fall to
 *         Illiquid. The wiring is {TestnetMockOracleRig}, which mirrors the
 *         script's mocks exactly; this file asserts all three classify
 *         Liquid and each returns its expected USD price.
 */
contract TestnetMockPricesTest is TestnetMockOracleRig {
    // ── Liquidity classification — all three must be Liquid (0) ────────

    function test_allLiquidTokensClassifyLiquid() public view {
        assertEq(_status(address(tLIQ)), uint256(LibVaipakam.LiquidityStatus.Liquid), "tLIQ Liquid");
        assertEq(_status(address(mUSDC)), uint256(LibVaipakam.LiquidityStatus.Liquid), "mUSDC Liquid");
        assertEq(_status(address(mWETH)), uint256(LibVaipakam.LiquidityStatus.Liquid), "mWETH Liquid");
    }

    // ── Prices — each token returns its distinct, realistic USD value ──

    function test_assetPricesAreDistinctAndRealistic() public view {
        (uint256 pTliq, uint8 dTliq) = OracleFacet(address(diamond)).getAssetPrice(address(tLIQ));
        (uint256 pMusdc, uint8 dMusdc) = OracleFacet(address(diamond)).getAssetPrice(address(mUSDC));
        (uint256 pMweth, uint8 dMweth) = OracleFacet(address(diamond)).getAssetPrice(address(mWETH));

        assertEq(dTliq, 8, "tLIQ 8-dec");
        assertEq(dMusdc, 8, "mUSDC 8-dec");
        assertEq(dMweth, 8, "mWETH 8-dec");

        assertEq(pTliq, P_TLIQ, "tLIQ == $2,000");
        assertEq(pMusdc, P_MUSDC, "mUSDC == $1");
        assertEq(pMweth, P_MWETH, "mWETH == $3,000");

        // The whole point: prices are NOT all equal any more.
        assertTrue(pTliq != pMusdc && pTliq != pMweth && pMusdc != pMweth, "distinct prices");
        // mWETH is 3000x mUSDC and tLIQ is 2000x mUSDC — realistic spread.
        assertEq(pMweth / pMusdc, 3000, "mWETH/mUSDC ratio");
        assertEq(pTliq / pMusdc, 2000, "tLIQ/mUSDC ratio");
    }

    // ── Helper math sanity: equal prices → ~1:1 sqrt (old constant) ────

    function test_poolSqrtPriceX96_equalPricesIsOneToOne() public view {
        uint160 s = _poolSqrtPriceX96(address(mWETH), P_MWETH, address(weth), P_MWETH);
        // 2**96 == 79228162514264337593543950336 (the old SQRT_PRICE_X96_ONE).
        assertApproxEqAbs(uint256(s), uint256(1) << 96, 2, "equal prices ~2**96");
    }

    // ── Price-aware liquidation adapter (Codex #1095) ──────────────────

    /// @notice With distinct faucet prices the registered swap adapter must
    ///         pay the FAIR price ratio, not a flat 1:1 — otherwise the
    ///         oracle-derived `minOutputAmount` is never met and HF/default
    ///         liquidation on an unequal pair drops into the full-collateral
    ///         fallback. Prove 1 mWETH ($3,000) → 3,000 mUSDC ($1).
    function test_mockSwapAdapter_paysFairPriceRatioOnCrossAssetSwap() public {
        ERC20Mock inTok = new ERC20Mock("In", "IN", 18);
        ERC20Mock outTok = new ERC20Mock("Out", "OUT", 18);
        MockSwapAdapter adapter = new MockSwapAdapter("test");
        adapter.setTokenPrice(address(inTok), 3_000e8); // mWETH-like
        adapter.setTokenPrice(address(outTok), 1e8); // mUSDC-like
        outTok.mint(address(adapter), 10_000e18); // proceeds float
        inTok.mint(address(this), 1e18);
        inTok.approve(address(adapter), 1e18);

        uint256 out =
            adapter.execute(address(inTok), address(outTok), 1e18, 2_900e18, address(this), "");
        assertEq(out, 3_000e18, "1 IN@$3,000 -> 3,000 OUT@$1");
        assertEq(outTok.balanceOf(address(this)), 3_000e18, "recipient got fair output");
    }

    /// @notice Unset prices preserve the legacy flat `inputAmount * bps`
    ///         payout every existing LibSwap failover test relies on.
    function test_mockSwapAdapter_legacyFlatPathWhenPricesUnset() public {
        ERC20Mock inTok = new ERC20Mock("In", "IN", 18);
        ERC20Mock outTok = new ERC20Mock("Out", "OUT", 18);
        MockSwapAdapter adapter = new MockSwapAdapter("test");
        outTok.mint(address(adapter), 10e18);
        inTok.mint(address(this), 5e18);
        inTok.approve(address(adapter), 5e18);

        uint256 out = adapter.execute(address(inTok), address(outTok), 5e18, 5e18, address(this), "");
        assertEq(out, 5e18, "flat 1:1 at default bps when prices unset");
    }
}
