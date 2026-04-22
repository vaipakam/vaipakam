// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";

interface IChainlinkFeedRegistry {
    function latestRoundData(address base, address quote)
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );

    function decimals(address base, address quote) external view returns (uint8);
}

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee)
        external
        view
        returns (address);
}

/**
 * @title OracleMainnetForkTest
 * @notice Sanity checks that the oracle addresses the protocol relies on
 *         are reachable and return plausible data on mainnet. Gated by
 *         FORK_URL_MAINNET env — skipped silently if unset so CI without
 *         archive-node credentials is not blocked.
 *
 *         Ranges are intentionally wide — this is not a backtest. We only
 *         want to catch:
 *           - wrong registry or factory address (call reverts)
 *           - stale feed (updatedAt in the distant past)
 *           - price returning zero / negative
 *           - pool not deployed for a supported pair
 */
contract OracleMainnetForkTest is Test {
    // Mainnet Chainlink Feed Registry
    address internal constant CHAINLINK_FEED_REGISTRY =
        0x47Fb2585D2C56Fe188D0E6ec628a38b74fCeeeDf;
    address internal constant USD_DENOM =
        0x0000000000000000000000000000000000000348;

    // Mainnet Uniswap V3 Factory
    address internal constant UNISWAP_V3_FACTORY =
        0x1F98431c8aD98523631AE4a59f267346ea31F984;

    // Token addresses
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    bool internal forkEnabled;

    function setUp() public {
        string memory url = vm.envOr("FORK_URL_MAINNET", string(""));
        if (bytes(url).length == 0) {
            forkEnabled = false;
            return;
        }
        vm.createSelectFork(url);
        forkEnabled = true;
    }

    function test_Fork_ChainlinkEthUsdFeed() public view {
        if (!forkEnabled) return;
        IChainlinkFeedRegistry reg = IChainlinkFeedRegistry(CHAINLINK_FEED_REGISTRY);
        (, int256 answer, , uint256 updatedAt, ) = reg.latestRoundData(WETH, USD_DENOM);
        assertGt(answer, 0, "ETH price non-positive");
        // Plausibility: $100 < ETH < $100k — wide enough to survive any era.
        uint8 dec = reg.decimals(WETH, USD_DENOM);
        uint256 price = uint256(answer);
        uint256 floor = 100 * (10 ** dec);
        uint256 ceil = 100_000 * (10 ** dec);
        assertGt(price, floor, "ETH price below plausibility floor");
        assertLt(price, ceil, "ETH price above plausibility ceiling");
        // Staleness: updatedAt within the last 48 hours.
        assertGt(updatedAt, block.timestamp - 2 days, "ETH feed stale");
    }

    function test_Fork_ChainlinkUsdcUsdFeed() public view {
        if (!forkEnabled) return;
        IChainlinkFeedRegistry reg = IChainlinkFeedRegistry(CHAINLINK_FEED_REGISTRY);
        (, int256 answer, , uint256 updatedAt, ) = reg.latestRoundData(USDC, USD_DENOM);
        assertGt(answer, 0, "USDC price non-positive");
        uint8 dec = reg.decimals(USDC, USD_DENOM);
        uint256 price = uint256(answer);
        // USDC should be within [$0.90, $1.10]
        uint256 floor = (90 * (10 ** dec)) / 100;
        uint256 ceil = (110 * (10 ** dec)) / 100;
        assertGe(price, floor, "USDC below peg band");
        assertLe(price, ceil, "USDC above peg band");
        assertGt(updatedAt, block.timestamp - 2 days, "USDC feed stale");
    }

    function test_Fork_UniswapV3UsdcWethPoolExists() public view {
        if (!forkEnabled) return;
        IUniswapV3Factory f = IUniswapV3Factory(UNISWAP_V3_FACTORY);
        // Check all three common fee tiers; at least one must exist.
        address p500 = f.getPool(USDC, WETH, 500);
        address p3000 = f.getPool(USDC, WETH, 3000);
        address p10000 = f.getPool(USDC, WETH, 10000);
        assertTrue(
            p500 != address(0) || p3000 != address(0) || p10000 != address(0),
            "no USDC/WETH pool found on any fee tier"
        );
    }
}
