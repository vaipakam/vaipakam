// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test, console2} from "forge-std/Test.sol";

/// @dev Calls `target` once and reports the gas the call took, as the caller
///      sees it: the cold account charge and everything the target spends.
contract ReadMeter {
    function meter(address target, bytes calldata data) external view returns (uint256 used, bool ok) {
        uint256 g = gasleft();
        (ok,) = target.staticcall(data);
        used = g - gasleft();
    }
}

/**
 * @title  GuardSourceReadCostForkTest
 * @notice What one read of each outside source the price guard reads costs on
 *         a live network (#3915, design ruling on the instant borrow source
 *         cap). Each source is read once, cold, at the fork's block, through
 *         a meter that reports the gas the call took as its caller sees it.
 *         `GasSuiteGuardReadTest` builds a guard whose sources spend these
 *         figures, so its price read costs what a fully set-up guard costs.
 *
 *         Arbitrum One is used because one network carries every kind of
 *         source the mainnet guard reads: Chainlink feeds behind proxies, the
 *         L2 sequencer feed, Pyth, API3 and Tellor. DIA's getValue oracle is
 *         read on Arbitrum Sepolia, where DIA publishes it. The platform's
 *         own feed registry is read on Base Sepolia, where it is deployed.
 *         A source that answers stale data still costs a real read, which is
 *         what is measured here; the figures are printed, not asserted.
 *
 *         Gated on FORK_URL_ARBITRUM_ONE, FORK_URL_ARB_SEPOLIA and
 *         FORK_URL_BASE_SEPOLIA; a part whose URL is unset is skipped.
 */
contract GuardSourceReadCostForkTest is Test {
    // Arbitrum One.
    address internal constant CL_ETH_USD = 0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612;
    address internal constant CL_SEQUENCER = 0xFdB631F5EE196F0ed6FAa767959853A9F217697D;
    address internal constant PYTH = 0xff1a0f4744e8582DF1aE09D5611b887B6a12925C;
    bytes32 internal constant PYTH_ETH_USD = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    address internal constant API3_SERVER = 0x709944a48cAf83535e43471680fDA4905FB3920a;
    address internal constant TELLOR = 0xD9157453E2668B2fc45b7A803D3FEF3642430cC0;
    address internal constant WETH_ARB = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    // Arbitrum Sepolia.
    address internal constant DIA_V2 = 0x927ccBd9107bD63F8279Af83b96E7DAF924b9a7E;
    // Base Sepolia: the platform's feed registry and the chain's WETH.
    address internal constant FEED_REGISTRY = 0x68f2F4f8F0A5C49a440C62126F3a80c1F75889a7;
    address internal constant WETH_BASE = 0x4200000000000000000000000000000000000006;
    address internal constant USD = 0x0000000000000000000000000000000000000348;

    function _measure(string memory what, address target, bytes memory data) internal {
        ReadMeter m = new ReadMeter();
        (uint256 used, bool ok) = m.meter(target, data);
        console2.log(string.concat(what, ok ? "" : " (reverted)"), used);
    }

    function test_fork_arbitrumOneSources() public {
        string memory url = vm.envOr("FORK_URL_ARBITRUM_ONE", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        console2.log("arbitrum one block", block.number);
        _measure("chainlink ETH/USD latestRoundData", CL_ETH_USD, abi.encodeWithSignature("latestRoundData()"));
        _measure("chainlink ETH/USD decimals (warm proxy)", CL_ETH_USD, abi.encodeWithSignature("decimals()"));
        _measure("chainlink sequencer latestRoundData", CL_SEQUENCER, abi.encodeWithSignature("latestRoundData()"));
        _measure("pyth getPriceUnsafe", PYTH, abi.encodeWithSignature("getPriceUnsafe(bytes32)", PYTH_ETH_USD));
        bytes32 dapi = keccak256(abi.encodePacked(bytes32("ETH/USD")));
        _measure("api3 readDataFeedWithDapiNameHash", API3_SERVER, abi.encodeWithSignature("readDataFeedWithDapiNameHash(bytes32)", dapi));
        bytes32 q = keccak256(abi.encode("SpotPrice", abi.encode("eth", "usd")));
        _measure("tellor getDataBefore", TELLOR, abi.encodeWithSignature("getDataBefore(bytes32,uint256)", q, block.timestamp - 20 minutes));
        _measure("WETH symbol", WETH_ARB, abi.encodeWithSignature("symbol()"));
    }

    function test_fork_arbSepoliaDia() public {
        string memory url = vm.envOr("FORK_URL_ARB_SEPOLIA", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        _measure("dia getValue ETH/USD", DIA_V2, abi.encodeWithSignature("getValue(string)", "ETH/USD"));
    }

    function test_fork_baseSepoliaRegistry() public {
        string memory url = vm.envOr("FORK_URL_BASE_SEPOLIA", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        _measure("feed registry getFeed WETH/USD", FEED_REGISTRY, abi.encodeWithSignature("getFeed(address,address)", WETH_BASE, USD));
        _measure("feed registry pairBase WETH/USD (warm)", FEED_REGISTRY, abi.encodeWithSignature("pairBase(address,address)", WETH_BASE, USD));
    }

    /// @dev The Ethereum mainnet Chainlink Feed Registry, ETH and USD by
    ///      Chainlink's denominations.
    function test_fork_mainnetRegistry() public {
        string memory url = vm.envOr("FORK_URL_MAINNET", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        address reg = 0x47Fb2585D2C56Fe188D0E6ec628a38b74fCeeeDf;
        address eth = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
        address usdDen = 0x0000000000000000000000000000000000000348;
        address link = 0x514910771AF9Ca656af840dff83E8264EcF986CA;
        _measure("mainnet registry getFeed ETH/USD", reg, abi.encodeWithSignature("getFeed(address,address)", eth, usdDen));
        _measure("mainnet registry getFeed LINK/USD", reg, abi.encodeWithSignature("getFeed(address,address)", link, usdDen));
        _measure("mainnet registry latestRoundData LINK/USD", reg, abi.encodeWithSignature("latestRoundData(address,address)", link, usdDen));
    }
}
