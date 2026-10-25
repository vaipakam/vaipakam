// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title MockPoolPricing
 * @notice The one place the testnet faucet scripts derive a mock v3 pool's
 *         `sqrtPriceX96` from its two legs' USD prices.
 *
 *         Every script that seeds or moves a mock pool needs the same answer
 *         and must never disagree: {DeployTestnetMocks} seeds each faucet
 *         pool's spot at deploy, {RepriceTestnetMock} moves an existing
 *         pool's spot when it reprices the asset's feed (#2314), and the two
 *         Anvil positive-flow suites seed their USDC/WETH pool (#848). `OracleFacet._accumulatePoolImpacts`
 *         only counts a pool whose spot agrees with the feed ratio within the
 *         TWAP-consistency band, so a pool priced by different math than the
 *         one that seeded it would read Illiquid for no market reason.
 *
 * @dev    Uniswap orders a pool's tokens by address (token0 = the lower
 *         one) and quotes token1 per token0. With both legs at the SAME
 *         token decimals there is no decimal term, and the value-balanced
 *         spot is `price(token0) / price(token1)`, so
 *         `sqrtPriceX96 = sqrt(price0 * 2**192 / price1)`.
 *
 *         Prices may be in ANY scale, as long as both legs share it — the
 *         ratio is scale-free. Equal prices give ~2**96 (a 1:1 pool).
 *
 *         Equal token decimals is a PRECONDITION of the four-argument form,
 *         not something it can see: it takes no token metadata. Every faucet
 *         token is 18-dec. A pair of different decimals uses the six-argument
 *         form, which takes each leg's decimals explicitly.
 *
 *         `Math.mulDiv` carries the full 512-bit product, so large prices do
 *         not overflow the intermediate; `SafeCast` reverts if the resulting
 *         ratio is too extreme for a uint160 spot.
 */
library MockPoolPricing {
    /// @notice The value-balanced `sqrtPriceX96` for a pool of `tokenA` /
    ///         `tokenB` priced at `priceA` / `priceB` (same scale, same token
    ///         decimals).
    function sqrtPriceX96(address tokenA, uint256 priceA, address tokenB, uint256 priceB)
        internal
        pure
        returns (uint160)
    {
        (uint256 price0, uint256 price1) = tokenA < tokenB ? (priceA, priceB) : (priceB, priceA);
        uint256 ratioX192 = Math.mulDiv(price0, uint256(1) << 192, price1);
        return SafeCast.toUint160(Math.sqrt(ratioX192));
    }

    /// @notice The same value-balanced spot for legs of DIFFERENT token
    ///         decimals (#848) — the Anvil rehearsal's 6-dec USDC against
    ///         18-dec WETH is the case the equal-decimals form cannot price.
    /// @dev    A pool quotes raw token1 units per raw token0 unit, so each
    ///         leg's USD price is per `10**decimals` raw units and the spot is
    ///         `(price0 / 10**dec0) / (price1 / 10**dec1)`, i.e.
    ///         `sqrtPriceX96 = sqrt(price0 * 10**dec1 * 2**192 / (price1 * 10**dec0))`.
    ///         Prices share one scale, as above. With equal decimals the two
    ///         power-of-ten terms cancel and this returns exactly what the
    ///         four-argument form returns.
    function sqrtPriceX96(
        address tokenA,
        uint256 priceA,
        uint8 decimalsA,
        address tokenB,
        uint256 priceB,
        uint8 decimalsB
    ) internal pure returns (uint160) {
        (uint256 price0, uint8 dec0, uint256 price1, uint8 dec1) = tokenA < tokenB
            ? (priceA, decimalsA, priceB, decimalsB)
            : (priceB, decimalsB, priceA, decimalsA);
        uint256 ratioX192 = Math.mulDiv(price0 * 10 ** dec1, uint256(1) << 192, price1 * 10 ** dec0);
        return SafeCast.toUint160(Math.sqrt(ratioX192));
    }
}
