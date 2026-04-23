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
 * @dev Env vars (per chain — populate from `.env.local`):
 *        - PRIVATE_KEY         : deployer / admin key (broadcaster).
 *        - DIAMOND_ADDRESS     : target Vaipakam Diamond proxy.
 *        - WETH_ADDRESS        : canonical WETH ERC20 on this chain
 *                                (e.g. Sepolia: 0xfFf9…4, Base mainnet:
 *                                0x4200000000000000000000000000000000000006).
 *        - UNISWAP_V3_FACTORY  : Uniswap V3 factory on this chain.
 *        - USD_DENOMINATOR     : (optional) Chainlink USD denominator —
 *                                defaults to the universal Chainlink
 *                                constant 0x000…0348 (840). Override only
 *                                if the target registry uses a non-standard
 *                                USD denominator.
 *        - ETH_DENOMINATOR     : (optional) Chainlink ETH denominator —
 *                                defaults to 0x000…000E (14).
 *        - WETH_USD_PRICE_E8   : (optional) initial mock WETH price
 *                                (8-decimal Chainlink scale). Default
 *                                2000e8 ($2000/ETH).
 *        - USDC_USD_PRICE_E8   : (optional) initial mock USDC price.
 *                                Default 1e8 ($1.00).
 */
contract UpgradeOracle is Script {
    // Chainlink denominators are universal across every Chainlink Feed
    // Registry deployment — safe as fallback defaults. Documented at
    // github.com/smartcontractkit/chainlink/blob/contracts-v1.3.0/contracts/src/v0.8/Denominations.sol
    address constant DEFAULT_USD_DENOMINATOR = 0x0000000000000000000000000000000000000348;
    address constant DEFAULT_ETH_DENOMINATOR = 0x000000000000000000000000000000000000000E;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address diamond = vm.envAddress("DIAMOND_ADDRESS");
        address wethAddress = vm.envAddress("WETH_ADDRESS");
        address uniswapV3Factory = vm.envAddress("UNISWAP_V3_FACTORY");
        address usdDenominator = _envAddressOr("USD_DENOMINATOR", DEFAULT_USD_DENOMINATOR);
        address ethDenominator = _envAddressOr("ETH_DENOMINATOR", DEFAULT_ETH_DENOMINATOR);
        uint256 wethUsdPrice = vm.envOr("WETH_USD_PRICE_E8", uint256(2000e8));
        uint256 usdcUsdPrice = vm.envOr("USDC_USD_PRICE_E8", uint256(1e8));

        vm.startBroadcast(deployerKey);

        // ── 1. Deploy new facets ────────────────────────────────────────
        OracleFacet newOracleFacet = new OracleFacet();
        console.log("New OracleFacet:", address(newOracleFacet));

        OracleAdminFacet oracleAdminFacet = new OracleAdminFacet();
        console.log("OracleAdminFacet:", address(oracleAdminFacet));

        // ── 2. Deploy mock Chainlink registry + price feeds ─────────────
        MockChainlinkRegistry mockRegistry = new MockChainlinkRegistry();
        console.log("MockChainlinkRegistry:", address(mockRegistry));

        // Mock USDC feed — price from env (default $1.00, 8-decimal).
        MockChainlinkFeed usdcFeed = new MockChainlinkFeed(int256(usdcUsdPrice), 8);
        console.log("USDC Feed:", address(usdcFeed));

        // Mock WETH feed — price from env (default $2000, 8-decimal).
        MockChainlinkFeed wethFeed = new MockChainlinkFeed(int256(wethUsdPrice), 8);
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
        OracleAdminFacet(diamond).setUsdChainlinkDenominator(usdDenominator);
        OracleAdminFacet(diamond).setEthChainlinkDenominator(ethDenominator);
        OracleAdminFacet(diamond).setWethContract(wethAddress);
        OracleAdminFacet(diamond).setEthUsdFeed(address(wethFeed));
        OracleAdminFacet(diamond).setUniswapV3Factory(uniswapV3Factory);
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

    /// @dev Read an env address, falling back to a default when unset or
    ///      empty. Forge's `vm.envOr` doesn't have an address overload, so
    ///      we parse through `envOr(uint256)` via address→uint160 round-trip.
    function _envAddressOr(string memory name, address fallback_) internal view returns (address) {
        try vm.envAddress(name) returns (address v) {
            return v;
        } catch {
            return fallback_;
        }
    }
}
