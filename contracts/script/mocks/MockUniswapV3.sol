// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/**
 * @title MockUniswapV3Pool
 * @notice Minimal Uniswap v3 pool mock — implements the two views that
 *         OracleFacet._checkLiquidity consumes: slot0() and liquidity().
 *         Both the price (sqrtPriceX96) and the liquidity reading can be
 *         configured at construction so a single deploy covers both the
 *         Liquid-classifying-threshold case (high liquidity) and the
 *         below-threshold case (used by tests that want an asset with a
 *         registered pool but failing depth).
 */
contract MockUniswapV3Pool {
    uint160 public sqrtPriceX96;
    uint128 public poolLiquidity;

    constructor(uint160 _sqrtPriceX96, uint128 _liquidity) {
        sqrtPriceX96 = _sqrtPriceX96;
        poolLiquidity = _liquidity;
    }

    function slot0()
        external
        view
        returns (uint160, int24, uint16, uint16, uint16, uint8, bool)
    {
        return (sqrtPriceX96, 0, 0, 0, 0, 0, false);
    }

    function liquidity() external view returns (uint128) {
        return poolLiquidity;
    }

    /// @notice Test hook — retune the pool price after deployment.
    function setSqrtPriceX96(uint160 _sqrtPriceX96) external {
        sqrtPriceX96 = _sqrtPriceX96;
    }

    /// @notice Test hook — retune the pool liquidity after deployment.
    function setLiquidity(uint128 _liquidity) external {
        poolLiquidity = _liquidity;
    }
}

/**
 * @title MockUniswapV3Factory
 * @notice Minimal Uniswap v3 factory mock, ABI-compatible with the canonical
 *         factory's `getPool(tokenA, tokenB, fee)` view. OracleFacet looks
 *         up pools via this call (no CREATE2 derivation), so the mock just
 *         maintains a (token0, token1, fee) → pool mapping populated by
 *         `createPool`.
 *
 * @dev    Scripts instantiate this factory, call `createPool` once per
 *         liquid asset/WETH pair (passing a non-zero sqrtPriceX96 and a
 *         liquidity value above `MIN_LIQUIDITY_USD` post-conversion), then
 *         register the factory on the Diamond via
 *         `OracleAdminFacet.setUniswapV3Factory`.
 */
contract MockUniswapV3Factory {
    mapping(address => mapping(address => mapping(uint24 => address))) public pools;

    event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, address pool);

    /// @notice Deploys a MockUniswapV3Pool for (tokenA, tokenB, fee) and
    ///         registers it under the canonical-ordered (token0 < token1)
    ///         slot, matching Uniswap v3 factory semantics.
    /// @return pool The newly-deployed MockUniswapV3Pool address.
    function createPool(
        address tokenA,
        address tokenB,
        uint24 fee,
        uint160 sqrtPriceX96,
        uint128 liquidity_
    ) external returns (address pool) {
        require(tokenA != tokenB, "SAME_TOKEN");
        require(tokenA != address(0) && tokenB != address(0), "ZERO_TOKEN");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(pools[token0][token1][fee] == address(0), "POOL_EXISTS");

        pool = address(new MockUniswapV3Pool(sqrtPriceX96, liquidity_));
        pools[token0][token1][fee] = pool;
        emit PoolCreated(token0, token1, fee, pool);
    }

    /// @notice Canonical Uniswap v3 `getPool` view. Returns `address(0)`
    ///         for unregistered pairs — OracleFacet treats that as Illiquid.
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return pools[token0][token1][fee];
    }
}
