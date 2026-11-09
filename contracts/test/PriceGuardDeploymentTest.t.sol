// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {PriceGuard} from "../src/oracle/PriceGuard.sol";
import {VaipakamFeedRegistry} from "../src/oracle/VaipakamFeedRegistry.sol";
import {PriceGuardDeployment} from "../script/lib/PriceGuardDeployment.sol";
import {ArtifactDeploy} from "../script/lib/ArtifactDeploy.sol";

/// @dev External entry so a refusal is a call that reverts.
contract PriceGuardDeploymentHarness {
    function startingConfig(address feedRegistry)
        external
        view
        returns (PriceGuard.Identity memory, uint64, PriceGuard.Change[] memory)
    {
        return PriceGuardDeployment.startingConfig(feedRegistry);
    }

    function deploy(address admin, address feedRegistry) external returns (address) {
        return PriceGuardDeployment.deploy(admin, feedRegistry);
    }
}

/**
 * @title  PriceGuardDeploymentTest
 * @notice The guard's starting config as the Diamond deploy builds it (#3272):
 *         a production chain's guard starts complete or not at all, and its
 *         delay defaults to 3 days.
 * @dev    The env keys are chain-prefixed (`OPTIMISM_…`), which win over a
 *         bare key another suite may have set in this process.
 */
contract PriceGuardDeploymentTest is Test {
    PriceGuardDeploymentHarness internal h;
    address internal admin = makeAddr("admin");
    address internal feeds;

    function setUp() public {
        h = new PriceGuardDeploymentHarness();
        feeds = ArtifactDeploy.deploy(type(VaipakamFeedRegistry).name, abi.encode(admin, admin));
    }

    function test_AProductionGuardStartsComplete() public {
        vm.chainId(10);
        address weth = _code("weth");
        address ethUsd = _code("ethUsd");
        address seq = _code("sequencer");
        vm.setEnv("OPTIMISM_WETH_ADDRESS", vm.toString(weth));
        vm.setEnv("OPTIMISM_ETH_USD_FEED", vm.toString(ethUsd));
        vm.setEnv("OPTIMISM_SEQUENCER_UPTIME_FEED", vm.toString(seq));

        (PriceGuard.Identity memory id, uint64 delay, PriceGuard.Change[] memory c) = h.startingConfig(feeds);
        assertEq(id.numeraireDenominator, VaipakamFeedRegistry(feeds).USD());
        assertEq(id.ethDenominator, VaipakamFeedRegistry(feeds).ETH());
        assertEq(id.numeraireSymbol, bytes32("usd"));
        assertEq(id.padDenominator, address(0));
        assertEq(delay, 3 days, "production default");
        assertGe(c.length, 4);
        assertEq(uint8(c[0].kind), uint8(PriceGuard.Kind.FeedRegistry));
        assertEq(address(uint160(uint256(c[0].value))), feeds);
        assertEq(uint8(c[1].kind), uint8(PriceGuard.Kind.Weth));
        assertEq(address(uint160(uint256(c[1].value))), weth);
        assertEq(uint8(c[2].kind), uint8(PriceGuard.Kind.EthNumeraireFeed));
        assertEq(address(uint160(uint256(c[2].value))), ethUsd);
        assertEq(uint8(c[3].kind), uint8(PriceGuard.Kind.SequencerFeed));

        // And it constructs: every entry passes the guard's own checks.
        PriceGuard g = PriceGuard(h.deploy(admin, feeds));
        assertEq(g.weth(), weth);
        assertEq(g.ethNumeraireFeed(), ethUsd);
        assertEq(g.sequencerFeed(), seq);
        assertEq(g.delay(), 3 days);
        assertFalse(g.TESTNET());
    }

    function test_AProductionGuardRefusesAMissingLoadBearingEntry() public {
        vm.chainId(10);
        vm.setEnv("OPTIMISM_WETH_ADDRESS", vm.toString(_code("weth2")));
        // An address with no code is as missing as none.
        vm.setEnv("OPTIMISM_ETH_USD_FEED", vm.toString(makeAddr("eoa")));
        vm.expectRevert(
            bytes(
                "PriceGuardDeployment: OPTIMISM_ETH_USD_FEED must name a contract on a production chain - the guard starts complete there"
            )
        );
        h.startingConfig(feeds);
    }

    function test_ATestnetGuardLeavesMissingEntriesForConfigure() public {
        vm.chainId(421614);
        vm.setEnv("ARB_SEPOLIA_ETH_USD_FEED", vm.toString(makeAddr("noCode")));
        (, uint64 delay, PriceGuard.Change[] memory c) = h.startingConfig(feeds);
        assertEq(delay, 0, "testnet default");
        for (uint256 i; i < c.length; ++i) {
            assertTrue(c[i].kind != PriceGuard.Kind.EthNumeraireFeed, "a feed with no code is left unset");
        }
    }

    function _code(string memory name) internal returns (address a) {
        a = makeAddr(name);
        vm.etch(a, hex"00");
    }
}
