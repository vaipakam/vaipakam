// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/**
 * @title MockUniswapV3Pool
 * @notice Minimal v3-style AMM pool mock — implements the three views
 *         OracleFacet's liquidity route search consumes: slot0(),
 *         liquidity() and observe(). Both the price (sqrtPriceX96) and the
 *         liquidity reading can be configured at construction so a single
 *         deploy covers both the Liquid-classifying-threshold case (high
 *         liquidity) and the below-threshold case (used by tests that want
 *         an asset with a registered pool but failing depth).
 * @dev    #3354: the route search requires the pool's own oracle to answer
 *         for the TWAP window and credits its harmonic-mean liquidity, so
 *         the mock keeps the V3 `secondsPerLiquidityCumulativeX128`
 *         accumulator across every `setLiquidity`. A rehearsal pool is a
 *         stand-in for a pool that already has a history, so its record
 *         starts `SEEDED_HISTORY` seconds before deployment at the
 *         constructor's liquidity; a later `setLiquidity` then moves the
 *         window mean the way a real pool's would. The mock's tick is
 *         always 0, so its mean tick is too.
 */
contract MockUniswapV3Pool {
    /// @dev Owner-gated tuning: these pools are wired as a public
    ///      testnet Diamond's LIVE liquidity source — open setters
    ///      would let anyone zero the depth or skew the spot and flip
    ///      `checkLiquidity` for the faucet assets (Codex #982 r9).
    ///      The factory passes its own owner (the deploying key) down.
    address public immutable owner;

    uint160 public sqrtPriceX96;
    uint128 public poolLiquidity;

    /// @dev How far back the record of a new pool reaches (one day, the
    ///      Diamond's largest TWAP window).
    uint32 internal constant SEEDED_HISTORY = 1 days;

    /// @dev One accumulator checkpoint: at `time` the accumulator read
    ///      `splCumulative`, and `liquidity` held from then on.
    struct Checkpoint {
        uint32 time;
        uint160 splCumulative;
        uint128 liquidity;
    }

    Checkpoint[] internal checkpoints;

    constructor(address _owner, uint160 _sqrtPriceX96, uint128 _liquidity) {
        owner = _owner;
        sqrtPriceX96 = _sqrtPriceX96;
        poolLiquidity = _liquidity;
        uint32 start = block.timestamp > SEEDED_HISTORY ? uint32(block.timestamp) - SEEDED_HISTORY : 0;
        checkpoints.push(Checkpoint(start, 0, _liquidity));
    }

    /// @notice V3's `observe`: for each `secondsAgo`, the tick and
    ///         seconds-per-liquidity accumulators at `now - secondsAgo`.
    ///         Reverts `OLD` before the pool's record begins, as V3 does.
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory splCumulatives)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        splCumulatives = new uint160[](secondsAgos.length);
        for (uint256 i; i < secondsAgos.length; ++i) {
            require(secondsAgos[i] <= block.timestamp, "OLD");
            splCumulatives[i] = _splAt(uint32(block.timestamp - secondsAgos[i]));
        }
    }

    function _splAt(uint32 target) internal view returns (uint160) {
        uint256 i = checkpoints.length;
        while (i > 0) {
            Checkpoint memory c = checkpoints[--i];
            if (c.time <= target) return c.splCumulative + _growth(target - c.time, c.liquidity);
        }
        revert("OLD");
    }

    /// @dev V3 divides by one when the pool held no liquidity.
    function _growth(uint32 secs, uint128 liq) internal pure returns (uint160) {
        return uint160((uint256(secs) << 128) / (liq == 0 ? 1 : liq));
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
        require(msg.sender == owner, "MockUniswapV3Pool: not owner");
        sqrtPriceX96 = _sqrtPriceX96;
    }

    /// @notice Test hook — retune the pool liquidity after deployment.
    function setLiquidity(uint128 _liquidity) external {
        require(msg.sender == owner, "MockUniswapV3Pool: not owner");
        uint32 nowTs = uint32(block.timestamp);
        checkpoints.push(Checkpoint(nowTs, _splAt(nowTs), _liquidity));
        poolLiquidity = _liquidity;
    }
}

/**
 * @title MockUniswapV3Factory
 * @notice Minimal v3-style AMM factory mock, ABI-compatible with the canonical
 *         factory's `getPool(tokenA, tokenB, fee)` view. OracleFacet looks
 *         up pools via this call (no CREATE2 derivation), so the mock just
 *         maintains a (token0, token1, fee) → pool mapping populated by
 *         `createPool`.
 *
 * @dev    Scripts instantiate this factory, call `createPool` once per
 *         liquid asset/WETH pair (passing a non-zero sqrtPriceX96 and a
 *         liquidity value above `MIN_LIQUIDITY_PAD` post-conversion), then
 *         register the factory on the Diamond via
 *         `OracleAdminFacet.setUniswapV3Factory`.
 */
contract MockUniswapV3Factory {
    /// @dev Deployer-gated: an open `createPool` on the registered
    ///      factory could NOT overwrite an existing pair (POOL_EXISTS)
    ///      but could pre-register attacker pools for pairs the
    ///      operator adds later — and the per-pool tuning setters key
    ///      off this owner. One key controls the whole mock venue.
    address public immutable owner;

    mapping(address => mapping(address => mapping(uint24 => address))) public pools;

    constructor() {
        owner = msg.sender;
    }

    event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, address pool);

    /// @notice Deploys a MockUniswapV3Pool for (tokenA, tokenB, fee) and
    ///         registers it under the canonical-ordered (token0 < token1)
    ///         slot, matching v3-style AMM factory semantics.
    /// @return pool The newly-deployed MockUniswapV3Pool address.
    function createPool(
        address tokenA,
        address tokenB,
        uint24 fee,
        uint160 sqrtPriceX96,
        uint128 liquidity_
    ) external returns (address pool) {
        require(msg.sender == owner, "MockUniswapV3Factory: not owner");
        require(tokenA != tokenB, "SAME_TOKEN");
        require(tokenA != address(0) && tokenB != address(0), "ZERO_TOKEN");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(pools[token0][token1][fee] == address(0), "POOL_EXISTS");

        pool = address(new MockUniswapV3Pool(owner, sqrtPriceX96, liquidity_));
        pools[token0][token1][fee] = pool;
        emit PoolCreated(token0, token1, fee, pool);
    }

    /// @notice Canonical v3-style AMM `getPool` view. Returns `address(0)`
    ///         for unregistered pairs — OracleFacet treats that as Illiquid.
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return pools[token0][token1][fee];
    }
}
