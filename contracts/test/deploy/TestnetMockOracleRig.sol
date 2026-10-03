// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OracleFacet} from "../../src/facets/OracleFacet.sol";
import {OracleAdminFacet} from "../../src/facets/OracleAdminFacet.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {RiskFacet} from "../../src/facets/RiskFacet.sol";
import {AccessControlFacet} from "../../src/facets/AccessControlFacet.sol";
import {DiamondCutFacet} from "../../src/facets/DiamondCutFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {HelperTest} from "../HelperTest.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {MockChainlinkRegistry, MockChainlinkFeed} from "../../script/mocks/MockChainlinkRegistry.sol";
import {MockUniswapV3Factory} from "../../script/mocks/MockUniswapV3.sol";
import {MockSwapAdapter} from "../mocks/MockSwapAdapter.sol";
import {DeployTestnetMocks} from "../../script/DeployTestnetMocks.s.sol";

/**
 * @title TestnetMockOracleRig
 * @notice A Diamond with the oracle facets cut in and wired to the EXACT
 *         faucet mocks {DeployTestnetMocks} deploys: the real
 *         {MockChainlinkRegistry}, {MockChainlinkFeed}s at the same prices,
 *         the real {MockUniswapV3Factory} with pools created at the
 *         re-derived `sqrtPriceX96`, the `[weth]` PAA list, the same risk
 *         params, and a {MockSwapAdapter} priced from the same snapshot.
 *
 *         Shared by {TestnetMockPricesTest} (the seed classifies Liquid) and
 *         {TestnetMockRepriceTest} (a reprice keeps it so, #2314). Split out
 *         so the second does not re-run the first's tests by inheriting them.
 *
 * @dev    Inherits {DeployTestnetMocks} purely to reuse the production
 *         `_poolSqrtPriceX96` helper + the shared price/liquidity/denom
 *         constants, so the rig can't drift from the script's math.
 */
abstract contract TestnetMockOracleRig is Test, DeployTestnetMocks {
    VaipakamDiamond diamond;

    ERC20Mock tLIQ;
    ERC20Mock mUSDC;
    ERC20Mock mWETH;
    ERC20Mock weth;

    // Prices in 8-dec Chainlink scale.
    uint256 constant P_TLIQ = 2_000e8;
    uint256 constant P_MUSDC = 1e8;
    uint256 constant P_MWETH = 3_000e8;

    // The oracle mocks, kept so a test can drive them after setUp — the
    // reprice test (#2314) moves the feeds and pool spots directly.
    MockChainlinkRegistry registry;
    MockChainlinkFeed tliqFeed;
    MockChainlinkFeed musdcFeed;
    MockChainlinkFeed ethFeed;
    MockUniswapV3Factory univ3;
    address tliqPool;
    address musdcPool;
    address mwethPool;
    MockSwapAdapter venue;

    function setUp() public virtual {
        address owner = address(this);

        tLIQ = new ERC20Mock("Vaipakam Test Liquid", "tLIQ", 18);
        mUSDC = new ERC20Mock("Mock USD Coin", "mUSDC", 18);
        mWETH = new ERC20Mock("Mock Wrapped ETH", "mWETH", 18);
        weth = new ERC20Mock("Wrapped ETH", "WETH", 18);

        DiamondCutFacet cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));
        HelperTest helper = new HelperTest();

        bytes4[] memory oracleAdminSelectors = new bytes4[](6);
        oracleAdminSelectors[0] = OracleAdminFacet.setChainlinkRegistry.selector;
        oracleAdminSelectors[1] = OracleAdminFacet.setUsdChainlinkDenominator.selector;
        oracleAdminSelectors[2] = OracleAdminFacet.setEthChainlinkDenominator.selector;
        oracleAdminSelectors[3] = OracleAdminFacet.setWethContract.selector;
        oracleAdminSelectors[4] = OracleAdminFacet.setEthUsdFeed.selector;
        oracleAdminSelectors[5] = OracleAdminFacet.setUniswapV3Factory.selector;

        bytes4[] memory riskSelectors = new bytes4[](1);
        riskSelectors[0] = RiskFacet.updateRiskParams.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](6);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(new OracleFacet()),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getOracleFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(new AdminFacet()),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getAdminFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(new AccessControlFacet()),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getAccessControlFacetSelectors()
        });
        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: address(new OracleAdminFacet()),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: oracleAdminSelectors
        });
        cuts[4] = IDiamondCut.FacetCut({
            facetAddress: address(new ConfigFacet()),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getConfigFacetSelectors()
        });
        cuts[5] = IDiamondCut.FacetCut({
            facetAddress: address(new RiskFacet()),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: riskSelectors
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();
        AdminFacet(address(diamond)).unpause();

        vm.warp(7 days);

        // ── Oracle mocks — mirrors DeployTestnetMocks step 1/2 exactly ──
        registry = new MockChainlinkRegistry();
        tliqFeed = new MockChainlinkFeed(int256(P_TLIQ), 8);
        musdcFeed = new MockChainlinkFeed(int256(P_MUSDC), 8);
        // mWETH + WETH share one feed so the pool stays 1:1 (static-mock
        // branch of the script; MWETH_USD_FEED override is the same wiring
        // with a live aggregator address).
        ethFeed = new MockChainlinkFeed(int256(P_MWETH), 8);
        registry.setFeed(address(tLIQ), USD_DENOM, address(tliqFeed));
        registry.setFeed(address(mUSDC), USD_DENOM, address(musdcFeed));
        registry.setFeed(address(mWETH), USD_DENOM, address(ethFeed));
        registry.setFeed(address(weth), USD_DENOM, address(ethFeed));

        univ3 = new MockUniswapV3Factory();
        // Re-derived spot per pool via the production helper.
        tliqPool = univ3.createPool(
            address(tLIQ), address(weth), 3000,
            _poolSqrtPriceX96(address(tLIQ), P_TLIQ, address(weth), P_MWETH),
            MOCK_POOL_LIQUIDITY
        );
        musdcPool = univ3.createPool(
            address(mUSDC), address(weth), 3000,
            _poolSqrtPriceX96(address(mUSDC), P_MUSDC, address(weth), P_MWETH),
            MOCK_POOL_LIQUIDITY
        );
        mwethPool = univ3.createPool(
            address(mWETH), address(weth), 3000,
            _poolSqrtPriceX96(address(mWETH), P_MWETH, address(weth), P_MWETH),
            MOCK_POOL_LIQUIDITY
        );

        OracleAdminFacet oa = OracleAdminFacet(address(diamond));
        oa.setChainlinkRegistry(address(registry));
        oa.setUsdChainlinkDenominator(USD_DENOM);
        oa.setEthChainlinkDenominator(ETH_DENOM);
        oa.setWethContract(address(weth));
        oa.setEthUsdFeed(address(ethFeed));
        oa.setUniswapV3Factory(address(univ3));

        address[] memory paa = new address[](1);
        paa[0] = address(weth);
        ConfigFacet(address(diamond)).setPaaAssets(paa);

        RiskFacet(address(diamond)).updateRiskParams(address(tLIQ), 8000, 300, 1000);
        RiskFacet(address(diamond)).updateRiskParams(address(mUSDC), 8000, 300, 1000);
        RiskFacet(address(diamond)).updateRiskParams(address(mWETH), 8000, 300, 1000);
        RiskFacet(address(diamond)).updateRiskParams(address(weth), 8000, 300, 1000);

        // The registered liquidation venue, priced from the same snapshot
        // the feeds carry — as DeployTestnetMocks wires it.
        venue = new MockSwapAdapter("vaipakam-testnet-mock");
        venue.setTokenPrice(address(tLIQ), P_TLIQ);
        venue.setTokenPrice(address(mUSDC), P_MUSDC);
        venue.setTokenPrice(address(mWETH), P_MWETH);
        venue.setTokenPrice(address(weth), P_MWETH);
        // Registered on the Diamond, so it is the venue liquidations route
        // through — the reprice script refuses one that is not (#2314).
        AdminFacet(address(diamond)).addSwapAdapter(address(venue));
    }

    function _status(address a) internal view returns (uint256) {
        return uint256(OracleFacet(address(diamond)).checkLiquidity(a));
    }
}
