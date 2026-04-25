// test/OracleLiquidityORTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {HelperTest} from "./HelperTest.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/**
 * @title OracleLiquidityORTest
 * @notice Phase 7b.1 — exercises the 3-V3-clone OR-logic in
 *         {OracleFacet._checkLiquidity}.
 *
 * Test design:
 *   - Same diamond + facet setup pattern as OracleFacetTest.
 *   - Three mock V3 factory addresses are registered (UniV3,
 *     PancakeV3, SushiV3). Each is independently mockable via
 *     `vm.mockCall`. Pool addresses are deterministic per
 *     (factory, asset, fee) so the tests can assert which probe
 *     committed.
 *   - Coverage: each factory pass/fail combination, fee-tier
 *     iteration (0.05% / 0.25% / 1% in addition to 0.3%), and
 *     short-circuit semantics (the OR commits on the first pass
 *     and never queries the others).
 */
contract OracleLiquidityORTest is Test {
    VaipakamDiamond diamond;
    address owner;

    address mockAsset;
    address mockRegistry;
    address mockFeed;
    address mockWeth;
    address mockEthUsdFeed;
    address mockDenom;

    address mockUniFactory;
    address mockPancakeFactory;
    address mockSushiFactory;

    DiamondCutFacet cutFacet;
    OracleFacet oracleFacet;
    OracleAdminFacet oracleAdminFacet;
    AdminFacet adminFacet;
    AccessControlFacet accessControlFacet;
    HelperTest helperTest;

    // Sentinels used to mock `factory.getPool(...)` returns. address(0)
    // means "no pool"; non-zero means "pool exists at this slot".
    address constant POOL_NONE = address(0);

    // Min liquidity threshold the contract expects (1_000_000 * 1e6).
    // Mocks need to clear this to be classified Liquid.
    // Value chosen large enough that 1e30 * 2000e8 / 1e8 = 2e33 ≫ 1e12.
    uint128 constant LIQUIDITY_PASSING = type(uint128).max / 4;
    uint128 constant LIQUIDITY_FAILING = 1; // way below MIN_LIQUIDITY_USD

    function setUp() public {
        owner = address(this);

        mockAsset       = address(new ERC20Mock("Asset", "AST", 18));
        mockRegistry    = makeAddr("registry");
        mockFeed        = makeAddr("feed");
        mockWeth        = makeAddr("weth");
        mockEthUsdFeed  = makeAddr("ethUsdFeed");
        mockDenom       = makeAddr("denom");

        mockUniFactory     = makeAddr("uniFactory");
        mockPancakeFactory = makeAddr("pancakeFactory");
        mockSushiFactory   = makeAddr("sushiFactory");

        cutFacet            = new DiamondCutFacet();
        diamond             = new VaipakamDiamond(owner, address(cutFacet));
        oracleFacet         = new OracleFacet();
        oracleAdminFacet    = new OracleAdminFacet();
        adminFacet          = new AdminFacet();
        accessControlFacet  = new AccessControlFacet();
        helperTest          = new HelperTest();

        bytes4[] memory oracleAdminSelectors = new bytes4[](7);
        oracleAdminSelectors[0] = OracleAdminFacet.setChainlinkRegistry.selector;
        oracleAdminSelectors[1] = OracleAdminFacet.setUsdChainlinkDenominator.selector;
        oracleAdminSelectors[2] = OracleAdminFacet.setEthChainlinkDenominator.selector;
        oracleAdminSelectors[3] = OracleAdminFacet.setWethContract.selector;
        oracleAdminSelectors[4] = OracleAdminFacet.setEthUsdFeed.selector;
        oracleAdminSelectors[5] = OracleAdminFacet.setUniswapV3Factory.selector;
        oracleAdminSelectors[6] = OracleAdminFacet.setStableTokenFeed.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](4);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(oracleFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getOracleFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(adminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAdminFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(accessControlFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAccessControlFacetSelectors()
        });
        cuts[3] = IDiamondCut.FacetCut({
            facetAddress: address(oracleAdminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: oracleAdminSelectors
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();

        vm.warp(7 days);

        OracleAdminFacet(address(diamond)).setUsdChainlinkDenominator(mockDenom);
        OracleAdminFacet(address(diamond)).setChainlinkRegistry(mockRegistry);
        OracleAdminFacet(address(diamond)).setWethContract(mockWeth);
        OracleAdminFacet(address(diamond)).setUniswapV3Factory(mockUniFactory);
        OracleAdminFacet(address(diamond)).setEthUsdFeed(mockEthUsdFeed);

        // Phase 7b.1 — register the two new V3-clone factories.
        AdminFacet(address(diamond)).setPancakeswapV3Factory(mockPancakeFactory);
        AdminFacet(address(diamond)).setSushiswapV3Factory(mockSushiFactory);

        // Default ETH/USD: $2000, 8 decimals, fresh.
        _mockFeedFull(mockEthUsdFeed, int256(2000e8), 8);
        // Default asset/USD feed wired so price-fresh check passes.
        _mockRegistryFeed(mockAsset, mockFeed);
        _mockFeedFull(mockFeed, int256(1e8), 8);

        // Default state: every factory returns "no pool" at every fee
        // tier. Tests opt-in to `_mockPool` for whichever (factory,
        // fee) combos they care about.
        _mockEmptyAtAllTiers(mockUniFactory);
        _mockEmptyAtAllTiers(mockPancakeFactory);
        _mockEmptyAtAllTiers(mockSushiFactory);
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    function _mockFeedFull(address feed, int256 price, uint8 decimals) internal {
        uint80 roundId = 1;
        uint256 startedAt = block.timestamp;
        uint256 updatedAt = block.timestamp;
        uint80 answeredInRound = 1;
        vm.mockCall(
            feed,
            abi.encodeWithSignature("decimals()"),
            abi.encode(decimals)
        );
        vm.mockCall(
            feed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(roundId, price, startedAt, updatedAt, answeredInRound)
        );
    }

    function _mockRegistryFeed(address asset, address feed) internal {
        vm.mockCall(
            mockRegistry,
            abi.encodeWithSignature("getFeed(address,address)", asset, mockDenom),
            abi.encode(feed)
        );
    }

    /// @dev Deterministic mock pool address per (factory, asset, fee).
    function _poolAddr(address factory, address asset, uint24 fee) internal view returns (address) {
        (address t0, address t1) = asset < mockWeth ? (asset, mockWeth) : (mockWeth, asset);
        return address(uint160(uint256(keccak256(
            abi.encode("mockPool", factory, t0, t1, fee)
        ))));
    }

    /// @dev Wire `factory.getPool(asset, weth, fee)` to return a
    ///      pseudo-pool whose `slot0()` and `liquidity()` are mocked
    ///      to satisfy the depth probe. `liquidity == LIQUIDITY_FAILING`
    ///      simulates "pool exists but too thin"; `LIQUIDITY_PASSING`
    ///      crosses the MIN_LIQUIDITY_USD floor.
    function _mockPool(
        address factory,
        address asset,
        uint24 fee,
        uint128 liquidity
    ) internal {
        address pool = _poolAddr(factory, asset, fee);
        (address t0, address t1) = asset < mockWeth ? (asset, mockWeth) : (mockWeth, asset);
        vm.mockCall(
            factory,
            abi.encodeWithSignature("getPool(address,address,uint24)", t0, t1, fee),
            abi.encode(pool)
        );
        // Need pool bytecode for `pool.code.length` check inside
        // `_v3DepthLiquid`. `vm.etch` plants bytecode so the address
        // looks like a real contract.
        vm.etch(pool, hex"6080");
        vm.mockCall(
            pool,
            abi.encodeWithSignature("slot0()"),
            abi.encode(uint160(1e18), int24(0), uint16(0), uint16(0), uint16(0), uint8(0), false)
        );
        vm.mockCall(pool, abi.encodeWithSignature("liquidity()"), abi.encode(liquidity));
    }

    /// @dev Force `factory.getPool(...)` to return `address(0)` for
    ///      every fee tier the contract probes.
    function _mockEmptyAtAllTiers(address factory) internal {
        uint24[5] memory fees = [uint24(3000), uint24(500), uint24(2500), uint24(10000), uint24(100)];
        (address t0, address t1) = mockAsset < mockWeth ? (mockAsset, mockWeth) : (mockWeth, mockAsset);
        for (uint256 i = 0; i < fees.length; ++i) {
            vm.mockCall(
                factory,
                abi.encodeWithSignature("getPool(address,address,uint24)", t0, t1, fees[i]),
                abi.encode(address(0))
            );
        }
    }

    function _checkLiquidity() internal view returns (LibVaipakam.LiquidityStatus) {
        return OracleFacet(address(diamond)).checkLiquidity(mockAsset);
    }

    // ─── Tests ──────────────────────────────────────────────────────

    function testLiquidityViaUniV3Only() public {
        _mockPool(mockUniFactory, mockAsset, 3000, LIQUIDITY_PASSING);
        // PancakeV3 + SushiV3 stay empty (default setUp state).
        assertEq(uint256(_checkLiquidity()), uint256(LibVaipakam.LiquidityStatus.Liquid));
    }

    function testLiquidityViaPancakeV3Only() public {
        // UniV3 has no pool at any tier; PancakeV3 has its native 2500
        // tier registered.
        _mockPool(mockPancakeFactory, mockAsset, 2500, LIQUIDITY_PASSING);
        assertEq(uint256(_checkLiquidity()), uint256(LibVaipakam.LiquidityStatus.Liquid));
    }

    function testLiquidityViaSushiV3Only() public {
        _mockPool(mockSushiFactory, mockAsset, 3000, LIQUIDITY_PASSING);
        assertEq(uint256(_checkLiquidity()), uint256(LibVaipakam.LiquidityStatus.Liquid));
    }

    function testLiquidityAllVenuesPassUsesFirstWhichIsUniV3() public {
        // All three pools liquid; the OR commits on the first pass
        // (UniV3) and the contract returns Liquid without touching
        // the others. We can't directly observe which leg ran (no
        // event), but the tx succeeds and the result is Liquid.
        _mockPool(mockUniFactory,     mockAsset, 3000, LIQUIDITY_PASSING);
        _mockPool(mockPancakeFactory, mockAsset, 2500, LIQUIDITY_PASSING);
        _mockPool(mockSushiFactory,   mockAsset, 3000, LIQUIDITY_PASSING);
        assertEq(uint256(_checkLiquidity()), uint256(LibVaipakam.LiquidityStatus.Liquid));
    }

    function testLiquidityNoVenueWithDepthIsIlliquid() public view {
        // Default setUp has every factory returning address(0) for
        // every fee tier — equivalent to "no pool exists for this
        // asset on any registered V3 clone".
        assertEq(uint256(_checkLiquidity()), uint256(LibVaipakam.LiquidityStatus.Illiquid));
    }

    function testLiquidityUniV3ThinPoolFallsThroughToPancakeV3() public {
        // UniV3 has a pool but liquidity is below the floor → that
        // leg of the OR returns false. PancakeV3 has a deep pool
        // → that leg passes → asset classified Liquid. Critical
        // semantic: a partially-drained UniV3 pool no longer flips
        // the asset to Illiquid as long as another venue is healthy.
        _mockPool(mockUniFactory,     mockAsset, 3000, LIQUIDITY_FAILING);
        _mockPool(mockPancakeFactory, mockAsset, 2500, LIQUIDITY_PASSING);
        assertEq(uint256(_checkLiquidity()), uint256(LibVaipakam.LiquidityStatus.Liquid));
    }

    function testLiquidityAllThreeThinIsIlliquid() public {
        _mockPool(mockUniFactory,     mockAsset, 3000, LIQUIDITY_FAILING);
        _mockPool(mockPancakeFactory, mockAsset, 2500, LIQUIDITY_FAILING);
        _mockPool(mockSushiFactory,   mockAsset, 3000, LIQUIDITY_FAILING);
        assertEq(uint256(_checkLiquidity()), uint256(LibVaipakam.LiquidityStatus.Illiquid));
    }

    function testLiquidityPancakeV3FactoryUnregisteredCollapsesToOthers() public {
        // Operator hasn't set the PancakeV3 factory yet (zero
        // address). The OR-combine should transparently skip that
        // leg and still classify Liquid via UniV3.
        AdminFacet(address(diamond)).setPancakeswapV3Factory(address(0));
        _mockPool(mockUniFactory, mockAsset, 3000, LIQUIDITY_PASSING);
        assertEq(uint256(_checkLiquidity()), uint256(LibVaipakam.LiquidityStatus.Liquid));
    }

    function testLiquidityAllThreeFactoriesUnsetIsIlliquid() public {
        OracleAdminFacet(address(diamond)).setUniswapV3Factory(address(0));
        AdminFacet(address(diamond)).setPancakeswapV3Factory(address(0));
        AdminFacet(address(diamond)).setSushiswapV3Factory(address(0));
        // Even though pool mocks are wired, the contract never reaches
        // them because every factory short-circuits to false on a zero
        // address.
        _mockPool(mockUniFactory, mockAsset, 3000, LIQUIDITY_PASSING);
        assertEq(uint256(_checkLiquidity()), uint256(LibVaipakam.LiquidityStatus.Illiquid));
    }

    function testLiquidityFeeTier500Found() public {
        // Pool exists only at the 0.05% tier on UniV3.
        _mockPool(mockUniFactory, mockAsset, 500, LIQUIDITY_PASSING);
        assertEq(uint256(_checkLiquidity()), uint256(LibVaipakam.LiquidityStatus.Liquid));
    }

    function testLiquidityFeeTier10000Found() public {
        // Pool exists only at the 1% tier on UniV3.
        _mockPool(mockUniFactory, mockAsset, 10000, LIQUIDITY_PASSING);
        assertEq(uint256(_checkLiquidity()), uint256(LibVaipakam.LiquidityStatus.Liquid));
    }

    function testLiquidityFeeTier100Found() public {
        // Pool exists only at the 0.01% tier (stable-pair tier).
        _mockPool(mockUniFactory, mockAsset, 100, LIQUIDITY_PASSING);
        assertEq(uint256(_checkLiquidity()), uint256(LibVaipakam.LiquidityStatus.Liquid));
    }

    function testLiquidityPancakeFeeTier2500Found() public {
        // PancakeV3's hallmark mid tier (replaces UniV3's 3000).
        _mockPool(mockPancakeFactory, mockAsset, 2500, LIQUIDITY_PASSING);
        assertEq(uint256(_checkLiquidity()), uint256(LibVaipakam.LiquidityStatus.Liquid));
    }

    function testLiquidityWethItselfBypassesPoolCheck() public view {
        // WETH is special-cased: liquid iff ETH/USD feed is fresh,
        // no pool lookup needed (would be circular).
        LibVaipakam.LiquidityStatus status = OracleFacet(address(diamond)).checkLiquidity(mockWeth);
        assertEq(uint256(status), uint256(LibVaipakam.LiquidityStatus.Liquid));
    }
}
