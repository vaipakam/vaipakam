// script/UpgradeOracle.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {MockChainlinkRegistry, MockChainlinkFeed} from "./mocks/MockChainlinkRegistry.sol";

/**
 * @title UpgradeOracle
 * @notice Diamond-cuts the OracleFacet and OracleAdminFacet into the deployed
 *         Diamond, plus mock Chainlink infrastructure for testnet use.
 *         Liquidity is determined strictly by on-chain Chainlink + Uniswap v3
 *         checks (README §1.5) — no manual overrides exist.
 *
 * Env vars: PRIVATE_KEY, DIAMOND_ADDRESS
 */
contract UpgradeOracle is Script {
    // Sepolia addresses
    address constant WETH_SEPOLIA = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14; // Sepolia canonical WETH
    address constant UNISWAP_V3_FACTORY = 0x0227628f3F023bb0B980b67D528571c95c6DaC1c;
    address constant CHAINLINK_USD_DENOMINATOR = 0x0000000000000000000000000000000000000348; // Chainlink Denominations.USD
    address constant CHAINLINK_ETH_DENOMINATOR = 0x000000000000000000000000000000000000000E; // Chainlink Denominations.ETH

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address diamond = vm.envAddress("DIAMOND_ADDRESS");

        vm.startBroadcast(deployerKey);

        // ── 1. Deploy new facets ────────────────────────────────────────
        OracleFacet newOracleFacet = new OracleFacet();
        console.log("New OracleFacet:", address(newOracleFacet));

        OracleAdminFacet oracleAdminFacet = new OracleAdminFacet();
        console.log("OracleAdminFacet:", address(oracleAdminFacet));

        // ── 2. Deploy mock Chainlink registry + price feeds ─────────────
        MockChainlinkRegistry mockRegistry = new MockChainlinkRegistry();
        console.log("MockChainlinkRegistry:", address(mockRegistry));

        // Mock USDC feed: $1.00 (1e8 with 8 decimals)
        MockChainlinkFeed usdcFeed = new MockChainlinkFeed(1e8, 8);
        console.log("USDC Feed:", address(usdcFeed));

        // Mock WETH feed: $2000 (2000e8 with 8 decimals)
        MockChainlinkFeed wethFeed = new MockChainlinkFeed(2000e8, 8);
        console.log("WETH Feed:", address(wethFeed));

        // ── 3. Diamond cut: Replace OracleFacet + Add OracleAdminFacet ──
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);

        // Replace OracleFacet (same selectors, new implementation with override support)
        bytes4[] memory oracleSelectors = new bytes4[](4);
        oracleSelectors[0] = OracleFacet.checkLiquidity.selector;
        oracleSelectors[1] = OracleFacet.getAssetPrice.selector;
        oracleSelectors[2] = OracleFacet.calculateLTV.selector;
        oracleSelectors[3] = OracleFacet.checkLiquidityOnActiveNetwork.selector;

        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newOracleFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: oracleSelectors
        });

        // Add new OracleAdminFacet
        bytes4[] memory adminSelectors = new bytes4[](7);
        adminSelectors[0] = OracleAdminFacet.setChainlinkRegistry.selector;
        adminSelectors[1] = OracleAdminFacet.setUsdChainlinkDenominator.selector;
        adminSelectors[2] = OracleAdminFacet.setEthChainlinkDenominator.selector;
        adminSelectors[3] = OracleAdminFacet.setWethContract.selector;
        adminSelectors[4] = OracleAdminFacet.setEthUsdFeed.selector;
        adminSelectors[5] = OracleAdminFacet.setUniswapV3Factory.selector;
        adminSelectors[6] = OracleAdminFacet.setStableTokenFeed.selector;

        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(oracleAdminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: adminSelectors
        });

        IDiamondCut(diamond).diamondCut(cuts, address(0), "");
        console.log("Diamond cut complete");

        // ── 4. Configure oracle addresses ───────────────────────────────
        OracleAdminFacet(diamond).setChainlinkRegistry(address(mockRegistry));
        OracleAdminFacet(diamond).setUsdChainlinkDenominator(CHAINLINK_USD_DENOMINATOR);
        OracleAdminFacet(diamond).setEthChainlinkDenominator(CHAINLINK_ETH_DENOMINATOR);
        OracleAdminFacet(diamond).setWethContract(WETH_SEPOLIA);
        OracleAdminFacet(diamond).setEthUsdFeed(address(wethFeed));
        OracleAdminFacet(diamond).setUniswapV3Factory(UNISWAP_V3_FACTORY);
        console.log("Oracle config set");

        vm.stopBroadcast();

        console.log("");
        console.log("=== Oracle Upgrade Complete ===");
        console.log("Diamond:", diamond);
        console.log("MockRegistry:", address(mockRegistry));
        console.log("USDC Feed:", address(usdcFeed));
        console.log("WETH Feed:", address(wethFeed));
        console.log("");
        console.log("NEXT STEPS:");
        console.log("1. In SepoliaPositiveFlows, register mock token feeds:");
        console.log("   mockRegistry.setFeed(mockUSDC, USD_DENOM, usdcFeed)");
        console.log("   mockRegistry.setFeed(mockWETH, USD_DENOM, wethFeed)");
        console.log("2. Ensure mock tokens have a Uniswap v3 pool on the testnet or");
        console.log("   they will be classified Illiquid by on-chain checks.");
    }
}
