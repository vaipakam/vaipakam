// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {PriceGuard} from "../src/oracle/PriceGuard.sol";
import {VaipakamFeedRegistry} from "../src/oracle/VaipakamFeedRegistry.sol";
import {PriceGuardDeployment} from "../script/lib/PriceGuardDeployment.sol";
import {ArtifactDeploy} from "../script/lib/ArtifactDeploy.sol";

/// @dev External entry so a refusal is a call that reverts.
contract PriceGuardDeploymentHarness {
    function fromEnv() external view returns (PriceGuardDeployment.Inputs memory) {
        return PriceGuardDeployment.fromEnv();
    }

    function startingConfig(address feedRegistry, PriceGuardDeployment.Inputs memory inputs)
        external
        view
        returns (PriceGuard.Identity memory, uint64, PriceGuard.Change[] memory)
    {
        return PriceGuardDeployment.startingConfig(feedRegistry, inputs);
    }

    function deploy(address admin, address feedRegistry, PriceGuardDeployment.Inputs memory inputs)
        external
        returns (address)
    {
        return PriceGuardDeployment.deploy(admin, feedRegistry, inputs);
    }
}

/**
 * @title  PriceGuardDeploymentTest
 * @notice The guard's starting config as the Diamond deploy builds it (#3272):
 *         a production chain's guard starts complete or not at all, and its
 *         delay defaults to 7 days.
 * @dev    Only `test_TheInputsComeFromTheChainPrefixedEnv` touches the env,
 *         under `OPTIMISM_…` keys, which win over a bare key another suite
 *         may have set in this process; every other case names its inputs.
 */
contract PriceGuardDeploymentTest is Test {
    PriceGuardDeploymentHarness internal h;
    address internal admin = makeAddr("admin");
    address internal feeds;

    function setUp() public {
        h = new PriceGuardDeploymentHarness();
        feeds = ArtifactDeploy.deploy(type(VaipakamFeedRegistry).name, abi.encode(admin, admin));
    }

    function test_TheInputsComeFromTheChainPrefixedEnv() public {
        vm.chainId(10);
        address weth = makeAddr("envWeth");
        address ethUsd = makeAddr("envEthUsd");
        vm.setEnv("OPTIMISM_WETH_ADDRESS", vm.toString(weth));
        vm.setEnv("OPTIMISM_ETH_USD_FEED", vm.toString(ethUsd));
        PriceGuardDeployment.Inputs memory i = h.fromEnv();
        assertEq(i.weth, weth);
        assertEq(i.ethUsdFeed, ethUsd);
        assertEq(i.delay, 7 days, "production default");
        vm.chainId(421614);
        assertEq(h.fromEnv().delay, 0, "testnet default");
    }

    function test_AProductionGuardStartsComplete() public {
        vm.chainId(10);
        PriceGuardDeployment.Inputs memory i;
        i.delay = 7 days;
        i.weth = _code("weth");
        i.ethUsdFeed = _code("ethUsd");
        i.sequencerFeed = _code("sequencer");

        (PriceGuard.Identity memory id, uint64 delay, PriceGuard.Change[] memory c) = h.startingConfig(feeds, i);
        assertEq(id.numeraireDenominator, VaipakamFeedRegistry(feeds).USD());
        assertEq(id.ethDenominator, VaipakamFeedRegistry(feeds).ETH());
        assertEq(id.numeraireSymbol, bytes32("usd"));
        assertEq(id.padDenominator, address(0));
        assertEq(delay, 7 days);
        assertEq(c.length, 4);
        assertEq(uint8(c[0].kind), uint8(PriceGuard.Kind.FeedRegistry));
        assertEq(address(uint160(uint256(c[0].value))), feeds);
        assertEq(uint8(c[1].kind), uint8(PriceGuard.Kind.Weth));
        assertEq(address(uint160(uint256(c[1].value))), i.weth);
        assertEq(uint8(c[2].kind), uint8(PriceGuard.Kind.EthNumeraireFeed));
        assertEq(address(uint160(uint256(c[2].value))), i.ethUsdFeed);
        assertEq(uint8(c[3].kind), uint8(PriceGuard.Kind.SequencerFeed));

        // And it constructs: every entry passes the guard's own checks.
        PriceGuard g = PriceGuard(h.deploy(admin, feeds, i));
        assertEq(g.weth(), i.weth);
        assertEq(g.ethNumeraireFeed(), i.ethUsdFeed);
        assertEq(g.sequencerFeed(), i.sequencerFeed);
        assertEq(g.delay(), 7 days);
        assertFalse(g.TESTNET());
    }

    function test_AProductionGuardRefusesAMissingLoadBearingEntry() public {
        vm.chainId(10);
        PriceGuardDeployment.Inputs memory i;
        i.delay = 7 days;
        i.weth = _code("weth2");
        // An address with no code is as missing as none.
        i.ethUsdFeed = makeAddr("eoa");
        vm.expectRevert(
            bytes(
                "PriceGuardDeployment: OPTIMISM_ETH_USD_FEED must name a contract on a production chain - the guard starts complete there"
            )
        );
        h.startingConfig(feeds, i);
    }

    function test_ATestnetGuardLeavesMissingEntriesForConfigure() public {
        vm.chainId(421614);
        PriceGuardDeployment.Inputs memory i;
        i.ethUsdFeed = makeAddr("noCode");
        i.stableSymbols = new bytes32[](2);
        i.stableFeeds = new address[](2);
        i.stableSymbols[0] = bytes32("USDC");
        i.stableFeeds[0] = _code("usdcFeed");
        i.stableSymbols[1] = bytes32("DAI");
        (, uint64 delay, PriceGuard.Change[] memory c) = h.startingConfig(feeds, i);
        assertEq(delay, 0);
        assertEq(c.length, 2, "the registry and the one stable feed with code");
        assertEq(uint8(c[1].kind), uint8(PriceGuard.Kind.StableRef));
        assertEq(c[1].subject, bytes32("USDC"));
    }

    function _code(string memory name) internal returns (address a) {
        a = makeAddr(name);
        vm.etch(a, hex"00");
    }
}
