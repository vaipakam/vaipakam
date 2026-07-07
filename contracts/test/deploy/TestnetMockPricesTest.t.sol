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
import {DeployTestnetMocks} from "../../script/DeployTestnetMocks.s.sol";

/**
 * @title TestnetMockPricesTest
 * @notice Proves the realistic faucet-token pricing wired by
 *         {DeployTestnetMocks} keeps every liquid faucet token classifying
 *         **Liquid** even though the tokens now carry DISTINCT USD prices
 *         (tLIQ $2,000 / mUSDC $1 / mWETH $3,000).
 *
 *         The load-bearing piece is {DeployTestnetMocks._poolSqrtPriceX96}:
 *         once the legs' prices differ a plain 1:1 pool would fail
 *         `OracleFacet`'s value-balance guard and each token would fall to
 *         Illiquid. This test wires the EXACT same mocks the script wires —
 *         the real {MockChainlinkRegistry}, {MockChainlinkFeed}s at the
 *         same prices, the real {MockUniswapV3Factory} with pools created
 *         at the re-derived `sqrtPriceX96` (via the inherited helper), the
 *         `[weth]` PAA list, and the same risk params — then asserts all
 *         three classify Liquid and each returns its expected USD price.
 *
 * @dev    Inherits {DeployTestnetMocks} purely to reuse the production
 *         `_poolSqrtPriceX96` helper + the shared price/liquidity/denom
 *         constants, so the test can't drift from the script's math.
 */
contract TestnetMockPricesTest is Test, DeployTestnetMocks {
    VaipakamDiamond diamond;

    ERC20Mock tLIQ;
    ERC20Mock mUSDC;
    ERC20Mock mWETH;
    ERC20Mock weth;

    // Prices in 8-dec Chainlink scale.
    uint256 constant P_TLIQ = 2_000e8;
    uint256 constant P_MUSDC = 1e8;
    uint256 constant P_MWETH = 3_000e8;

    function setUp() public {
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
        MockChainlinkRegistry registry = new MockChainlinkRegistry();
        MockChainlinkFeed tliqFeed = new MockChainlinkFeed(int256(P_TLIQ), 8);
        MockChainlinkFeed musdcFeed = new MockChainlinkFeed(int256(P_MUSDC), 8);
        // mWETH + WETH share one feed so the pool stays 1:1 (static-mock
        // branch of the script; MWETH_USD_FEED override is the same wiring
        // with a live aggregator address).
        MockChainlinkFeed ethFeed = new MockChainlinkFeed(int256(P_MWETH), 8);
        registry.setFeed(address(tLIQ), USD_DENOM, address(tliqFeed));
        registry.setFeed(address(mUSDC), USD_DENOM, address(musdcFeed));
        registry.setFeed(address(mWETH), USD_DENOM, address(ethFeed));
        registry.setFeed(address(weth), USD_DENOM, address(ethFeed));

        MockUniswapV3Factory univ3 = new MockUniswapV3Factory();
        // Re-derived spot per pool via the production helper.
        univ3.createPool(
            address(tLIQ), address(weth), 3000,
            _poolSqrtPriceX96(address(tLIQ), P_TLIQ, address(weth), P_MWETH),
            MOCK_POOL_LIQUIDITY
        );
        univ3.createPool(
            address(mUSDC), address(weth), 3000,
            _poolSqrtPriceX96(address(mUSDC), P_MUSDC, address(weth), P_MWETH),
            MOCK_POOL_LIQUIDITY
        );
        univ3.createPool(
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
    }

    function _status(address a) internal view returns (uint256) {
        return uint256(OracleFacet(address(diamond)).checkLiquidity(a));
    }

    // ── Liquidity classification — all three must be Liquid (0) ────────

    function test_allLiquidTokensClassifyLiquid() public view {
        assertEq(_status(address(tLIQ)), uint256(LibVaipakam.LiquidityStatus.Liquid), "tLIQ Liquid");
        assertEq(_status(address(mUSDC)), uint256(LibVaipakam.LiquidityStatus.Liquid), "mUSDC Liquid");
        assertEq(_status(address(mWETH)), uint256(LibVaipakam.LiquidityStatus.Liquid), "mWETH Liquid");
    }

    // ── Prices — each token returns its distinct, realistic USD value ──

    function test_assetPricesAreDistinctAndRealistic() public view {
        (uint256 pTliq, uint8 dTliq) = OracleFacet(address(diamond)).getAssetPrice(address(tLIQ));
        (uint256 pMusdc, uint8 dMusdc) = OracleFacet(address(diamond)).getAssetPrice(address(mUSDC));
        (uint256 pMweth, uint8 dMweth) = OracleFacet(address(diamond)).getAssetPrice(address(mWETH));

        assertEq(dTliq, 8, "tLIQ 8-dec");
        assertEq(dMusdc, 8, "mUSDC 8-dec");
        assertEq(dMweth, 8, "mWETH 8-dec");

        assertEq(pTliq, P_TLIQ, "tLIQ == $2,000");
        assertEq(pMusdc, P_MUSDC, "mUSDC == $1");
        assertEq(pMweth, P_MWETH, "mWETH == $3,000");

        // The whole point: prices are NOT all equal any more.
        assertTrue(pTliq != pMusdc && pTliq != pMweth && pMusdc != pMweth, "distinct prices");
        // mWETH is 3000x mUSDC and tLIQ is 2000x mUSDC — realistic spread.
        assertEq(pMweth / pMusdc, 3000, "mWETH/mUSDC ratio");
        assertEq(pTliq / pMusdc, 2000, "tLIQ/mUSDC ratio");
    }

    // ── Helper math sanity: equal prices → ~1:1 sqrt (old constant) ────

    function test_poolSqrtPriceX96_equalPricesIsOneToOne() public view {
        uint160 s = _poolSqrtPriceX96(address(mWETH), P_MWETH, address(weth), P_MWETH);
        // 2**96 == 79228162514264337593543950336 (the old SQRT_PRICE_X96_ONE).
        assertApproxEqAbs(uint256(s), uint256(1) << 96, 2, "equal prices ~2**96");
    }
}
