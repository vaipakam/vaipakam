// test/OracleFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {HelperTest} from "./HelperTest.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/**
 * @title OracleFacetTest
 * @notice Full coverage for the rebuilt OracleFacet.
 *
 * Post-refactor oracle surface (recap):
 *   - Liquidity reference quote asset = WETH (was USDT).
 *   - Pool depth in ETH is converted to USD via a direct ETH/USD Chainlink
 *     feed (`ethUsdFeed`) and compared to `MIN_LIQUIDITY_USD`.
 *   - Asset pricing uses a hybrid path: direct asset/USD via the Feed
 *     Registry is primary; asset/ETH × ETH/USD is the fallback.
 *   - WETH itself is a supported quote/asset — its price comes directly
 *     from `ethUsdFeed` and its liquidity check skips the pool hop.
 *   - Peg-aware staleness grace applies only within ±3% of any registered
 *     peg ($1, or a non-USD peg registered via `setStableTokenFeed`).
 *
 * Config is wired through OracleAdminFacet (owner-only setters) rather
 * than direct `vm.store` slot writes, since several new fields were
 * appended to the Storage struct and hand-computing their slots is
 * brittle.
 */
contract OracleFacetTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address mockAsset;
    address mockAsset2;
    address mockRegistry;
    address mockFeed;
    address mockFeed2;
    address mockWeth;
    address mockEthUsdFeed;
    address mockFactory;
    address mockDenom; // USD denominator sentinel

    DiamondCutFacet cutFacet;
    OracleFacet oracleFacet;
    OracleAdminFacet oracleAdminFacet;
    AdminFacet adminFacet;
    AccessControlFacet accessControlFacet;
    HelperTest helperTest;

    function setUp() public {
        owner = address(this);

        mockAsset  = address(new ERC20Mock("Asset", "AST", 18));
        mockAsset2 = address(new ERC20Mock("Asset2", "AST2", 18));
        mockRegistry    = makeAddr("registry");
        mockFeed        = makeAddr("feed");
        mockFeed2       = makeAddr("feed2");
        mockWeth        = makeAddr("weth");
        mockEthUsdFeed  = makeAddr("ethUsdFeed");
        mockFactory     = makeAddr("factory");
        mockDenom       = makeAddr("denom");

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

        // Warp to a reasonable timestamp so block.timestamp − 1h does not underflow.
        vm.warp(7 days);

        // Wire oracle config through the admin facet (owner-only setters).
        OracleAdminFacet(address(diamond)).setUsdChainlinkDenominator(mockDenom);
        OracleAdminFacet(address(diamond)).setChainlinkRegistry(mockRegistry);
        OracleAdminFacet(address(diamond)).setWethContract(mockWeth);
        OracleAdminFacet(address(diamond)).setUniswapV3Factory(mockFactory);
        OracleAdminFacet(address(diamond)).setEthUsdFeed(mockEthUsdFeed);

        // Default ETH/USD mock: $2000, 8 decimals, fresh. Individual tests
        // may override or revert this to cover the ETH-feed branches.
        _mockFeedFull(mockEthUsdFeed, int256(2000e8), 8);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _mockFeedFull(address feed, int256 price, uint8 decimals) internal {
        uint80 roundId = 1;
        vm.mockCall(
            feed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(roundId, price, block.timestamp, block.timestamp, roundId)
        );
        vm.mockCall(feed, abi.encodeWithSignature("decimals()"), abi.encode(decimals));
    }

    function _mockRegistryFeed(address asset, address feed) internal {
        vm.mockCall(
            mockRegistry,
            abi.encodeWithSignature("getFeed(address,address)", asset, mockDenom),
            abi.encode(feed)
        );
    }

    /// @dev Deterministic mock pool address for asset/WETH pair. Previously
    ///      derived via CREATE2+init-code hash to match the v3-style AMM
    ///      deployment math, but `OracleFacet._lookupPool` now resolves
    ///      pools via `factory.getPool(tokenA, tokenB, feeTier)` — so this
    ///      helper just needs a stable, collision-free pseudo-address that
    ///      both the factory mock and the pool-level mocks can agree on.
    function _computePoolAddress(address tokenA, address tokenB) internal view returns (address) {
        address token0 = tokenA < tokenB ? tokenA : tokenB;
        address token1 = tokenA < tokenB ? tokenB : tokenA;
        return address(uint160(uint256(keccak256(
            abi.encode("mockPool", mockFactory, token0, token1, uint24(3000))
        ))));
    }

    /// @dev Mock a healthy asset/WETH v3-style AMM pool with `liquidity` raw
    ///      units. Wires `factory.getPool(...)` to return our deterministic
    ///      stub address and then mocks that address's `slot0` + `liquidity`
    ///      views so `OracleFacet._checkLiquidity` sees a real-looking pool.
    function _mockLiquidPool(address asset, uint128 liquidity) internal {
        address pool = _computePoolAddress(asset, mockWeth);
        (address t0, address t1) = asset < mockWeth ? (asset, mockWeth) : (mockWeth, asset);
        vm.mockCall(
            mockFactory,
            abi.encodeWithSignature("getPool(address,address,uint24)", t0, t1, uint24(3000)),
            abi.encode(pool)
        );
        vm.mockCall(
            pool,
            abi.encodeWithSignature("slot0()"),
            abi.encode(uint160(1e18), int24(0), uint16(0), uint16(0), uint16(0), uint8(0), false)
        );
        vm.mockCall(pool, abi.encodeWithSignature("liquidity()"), abi.encode(liquidity));
    }

    // ─── checkLiquidity ───────────────────────────────────────────────────────

    function testCheckLiquidityRevertsZeroAddress() public {
        vm.expectRevert(IVaipakamErrors.InvalidAsset.selector);
        OracleFacet(address(diamond)).checkLiquidity(address(0));
    }

    function testCheckLiquidityReturnsIlliquidWhenRegistryReverts() public {
        vm.mockCallRevert(
            mockRegistry,
            abi.encodeWithSignature("getFeed(address,address)", mockAsset, mockDenom),
            "FeedNotFound"
        );
        LibVaipakam.LiquidityStatus status = OracleFacet(address(diamond)).checkLiquidity(mockAsset);
        assertEq(uint8(status), uint8(LibVaipakam.LiquidityStatus.Illiquid));
    }

    function testCheckLiquidityReturnsIlliquidWhenFeedAddressZero() public {
        _mockRegistryFeed(mockAsset, address(0));
        LibVaipakam.LiquidityStatus status = OracleFacet(address(diamond)).checkLiquidity(mockAsset);
        assertEq(uint8(status), uint8(LibVaipakam.LiquidityStatus.Illiquid));
    }

    function testCheckLiquidityReturnsIlliquidWhenStalePriceData() public {
        _mockRegistryFeed(mockAsset, mockFeed);

        // Past the 25h stable ceiling — even $1 must be rejected as stale.
        vm.warp(LibVaipakam.ORACLE_STABLE_STALENESS + 10 hours);
        uint80 roundId = 1;
        uint256 staleAt = block.timestamp - (LibVaipakam.ORACLE_STABLE_STALENESS + 1);
        vm.mockCall(
            mockFeed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(roundId, int256(1e8), staleAt, staleAt, roundId)
        );

        LibVaipakam.LiquidityStatus status = OracleFacet(address(diamond)).checkLiquidity(mockAsset);
        assertEq(uint8(status), uint8(LibVaipakam.LiquidityStatus.Illiquid));
    }

    function testCheckLiquidityReturnsIlliquidWhenNegativePrice() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        uint80 roundId = 1;
        vm.mockCall(
            mockFeed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(roundId, int256(-1), block.timestamp, block.timestamp, roundId)
        );
        LibVaipakam.LiquidityStatus status = OracleFacet(address(diamond)).checkLiquidity(mockAsset);
        assertEq(uint8(status), uint8(LibVaipakam.LiquidityStatus.Illiquid));
    }

    function testCheckLiquidityReturnsIlliquidWhenLatestRoundDataReverts() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        vm.mockCallRevert(mockFeed, abi.encodeWithSignature("latestRoundData()"), "feed broken");
        LibVaipakam.LiquidityStatus status = OracleFacet(address(diamond)).checkLiquidity(mockAsset);
        assertEq(uint8(status), uint8(LibVaipakam.LiquidityStatus.Illiquid));
    }

    function testCheckLiquidityReturnsIlliquidWhenDecimalsReverts() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        uint80 roundId = 1;
        vm.mockCall(
            mockFeed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(roundId, int256(1e8), block.timestamp, block.timestamp, roundId)
        );
        vm.mockCallRevert(mockFeed, abi.encodeWithSignature("decimals()"), "no decimals");
        LibVaipakam.LiquidityStatus status = OracleFacet(address(diamond)).checkLiquidity(mockAsset);
        assertEq(uint8(status), uint8(LibVaipakam.LiquidityStatus.Illiquid));
    }

    function testCheckLiquidityReturnsIlliquidWhenPoolNotInitialized() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        _mockFeedFull(mockFeed, int256(1e8), 8);

        address pool = _computePoolAddress(mockAsset, mockWeth);
        vm.mockCall(
            pool,
            abi.encodeWithSignature("slot0()"),
            abi.encode(uint160(0), int24(0), uint16(0), uint16(0), uint16(0), uint8(0), false)
        );

        LibVaipakam.LiquidityStatus status = OracleFacet(address(diamond)).checkLiquidity(mockAsset);
        assertEq(uint8(status), uint8(LibVaipakam.LiquidityStatus.Illiquid));
    }

    function testCheckLiquidityReturnsIlliquidWhenPoolStaticCallFails() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        _mockFeedFull(mockFeed, int256(1e8), 8);
        address pool = _computePoolAddress(mockAsset, mockWeth);
        vm.mockCallRevert(pool, abi.encodeWithSignature("slot0()"), abi.encode("revert"));
        LibVaipakam.LiquidityStatus status = OracleFacet(address(diamond)).checkLiquidity(mockAsset);
        assertEq(uint8(status), uint8(LibVaipakam.LiquidityStatus.Illiquid));
    }

    function testCheckLiquidityReturnsIlliquidWhenLiquidityCallFails() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        _mockFeedFull(mockFeed, int256(1e8), 8);
        address pool = _computePoolAddress(mockAsset, mockWeth);
        vm.mockCall(
            pool,
            abi.encodeWithSignature("slot0()"),
            abi.encode(uint160(1e18), int24(0), uint16(0), uint16(0), uint16(0), uint8(0), false)
        );
        vm.mockCallRevert(pool, abi.encodeWithSignature("liquidity()"), abi.encode("revert"));
        LibVaipakam.LiquidityStatus status = OracleFacet(address(diamond)).checkLiquidity(mockAsset);
        assertEq(uint8(status), uint8(LibVaipakam.LiquidityStatus.Illiquid));
    }

    function testCheckLiquidityReturnsIlliquidWhenInsufficientLiquidity() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        _mockFeedFull(mockFeed, int256(1e8), 8);
        // Trivially tiny WETH depth. MIN_LIQUIDITY_USD = 1e6 * 1e6 (1M with 6-dec
        // scaling). Pool depth = liquidity * ethPrice / 10**ethDec
        //                       = 1 * 2000e8 / 1e8 = 2000 → far below 1M * 1e6.
        _mockLiquidPool(mockAsset, 1);
        LibVaipakam.LiquidityStatus status = OracleFacet(address(diamond)).checkLiquidity(mockAsset);
        assertEq(uint8(status), uint8(LibVaipakam.LiquidityStatus.Illiquid));
    }

    function testCheckLiquidityReturnsLiquidWhenAllConditionsMet() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        _mockFeedFull(mockFeed, int256(1e8), 8);
        // Pool depth = liquidity * 2000e8 / 1e8 = liquidity * 2000.
        // MIN_LIQUIDITY_USD = 1_000_000 * 1e6 = 1e12. Need liquidity * 2000 > 1e12.
        // liquidity = 1e18 → depth = 2e21 ≫ 1e12. Comfortably liquid.
        _mockLiquidPool(mockAsset, uint128(1e18));
        LibVaipakam.LiquidityStatus status = OracleFacet(address(diamond)).checkLiquidity(mockAsset);
        assertEq(uint8(status), uint8(LibVaipakam.LiquidityStatus.Liquid));
    }

    /// @dev WETH is a first-class asset: no asset/WETH pool hop, liquidity
    ///      status depends solely on ETH/USD feed freshness.
    function testCheckLiquidityLiquidForWeth() public view {
        LibVaipakam.LiquidityStatus status = OracleFacet(address(diamond)).checkLiquidity(mockWeth);
        assertEq(uint8(status), uint8(LibVaipakam.LiquidityStatus.Liquid));
    }

    /// @dev If the ETH/USD feed itself is stale, even WETH collapses to Illiquid.
    function testCheckLiquidityIlliquidForWethWhenEthFeedStale() public {
        vm.warp(LibVaipakam.ORACLE_STABLE_STALENESS + 10 hours);
        uint80 roundId = 1;
        uint256 staleAt = block.timestamp - (LibVaipakam.ORACLE_STABLE_STALENESS + 1);
        vm.mockCall(
            mockEthUsdFeed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(roundId, int256(2000e8), staleAt, staleAt, roundId)
        );
        LibVaipakam.LiquidityStatus status = OracleFacet(address(diamond)).checkLiquidity(mockWeth);
        assertEq(uint8(status), uint8(LibVaipakam.LiquidityStatus.Illiquid));
    }

    // ─── calculateLTV ─────────────────────────────────────────────────────────

    function testCalculateLTVZeroCollateralReturnsZero() public view {
        uint256 ltv = OracleFacet(address(diamond)).calculateLTV(mockAsset, 1000 ether, mockAsset2, 0);
        assertEq(ltv, 0);
    }

    function testCalculateLTVRevertsNoPriceFeedForBorrowed() public {
        _mockRegistryFeed(mockAsset, address(0));
        vm.expectRevert(OracleFacet.NoPriceFeed.selector);
        OracleFacet(address(diamond)).calculateLTV(mockAsset, 1000 ether, mockAsset2, 1000 ether);
    }

    function testCalculateLTVRevertsNoPriceFeedForCollateral() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        _mockFeedFull(mockFeed, int256(1e8), 8);
        _mockRegistryFeed(mockAsset2, address(0));
        vm.expectRevert(OracleFacet.NoPriceFeed.selector);
        OracleFacet(address(diamond)).calculateLTV(mockAsset, 1000 ether, mockAsset2, 1000 ether);
    }

    function testCalculateLTVBothLiquidSuccess() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        _mockRegistryFeed(mockAsset2, mockFeed2);
        _mockFeedFull(mockFeed,  int256(1e8), 8);   // borrowed: $1
        _mockFeedFull(mockFeed2, int256(2e8), 8);   // collateral: $2

        // LTV = (1000 * 1e18) / (1800 * 2) * 10000 = (1000 / 3600) * 10000 = 2777
        uint256 ltv = OracleFacet(address(diamond)).calculateLTV(mockAsset, 1000 ether, mockAsset2, 1800 ether);
        assertEq(ltv, 2777);
    }

    function testCalculateLTVReverts_StalePriceData_Borrowed() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        uint80 roundId = 1;
        vm.mockCall(
            mockFeed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(roundId, int256(0), block.timestamp, block.timestamp, roundId)
        );
        vm.expectRevert(OracleFacet.StalePriceData.selector);
        OracleFacet(address(diamond)).calculateLTV(mockAsset, 1000 ether, mockAsset2, 1000 ether);
    }

    function testCalculateLTVReverts_StalePriceData_Collateral() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        _mockRegistryFeed(mockAsset2, mockFeed2);
        _mockFeedFull(mockFeed, int256(1e8), 8);
        uint80 roundId = 1;
        vm.mockCall(
            mockFeed2,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(roundId, int256(-1), block.timestamp, block.timestamp, roundId)
        );
        vm.expectRevert(OracleFacet.StalePriceData.selector);
        OracleFacet(address(diamond)).calculateLTV(mockAsset, 1000 ether, mockAsset2, 1000 ether);
    }

    function testCalculateLTVRevertsWhenRegistryReverts() public {
        vm.mockCallRevert(
            mockRegistry,
            abi.encodeWithSignature("getFeed(address,address)", mockAsset, mockDenom),
            "FeedNotFound"
        );
        vm.expectRevert(OracleFacet.NoPriceFeed.selector);
        OracleFacet(address(diamond)).calculateLTV(mockAsset, 1000 ether, mockAsset2, 1000 ether);
    }

    // ─── getAssetPrice ────────────────────────────────────────────────────────

    function testGetAssetPriceSuccess() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        _mockFeedFull(mockFeed, int256(2000e8), 8);

        (uint256 price, uint8 decimals) = OracleFacet(address(diamond)).getAssetPrice(mockAsset);
        assertEq(price, 2000e8);
        assertEq(decimals, 8);
    }

    function testGetAssetPriceForWethUsesEthUsdFeedDirectly() public view {
        // Set-up already mocks ethUsdFeed @ $2000 / 8 decimals.
        (uint256 price, uint8 decimals) = OracleFacet(address(diamond)).getAssetPrice(mockWeth);
        assertEq(price, 2000e8);
        assertEq(decimals, 8);
    }

    function testGetAssetPriceRevertsNoPriceFeed() public {
        _mockRegistryFeed(mockAsset, address(0));
        vm.expectRevert(OracleFacet.NoPriceFeed.selector);
        OracleFacet(address(diamond)).getAssetPrice(mockAsset);
    }

    function testGetAssetPriceRevertsWhenRegistryReverts() public {
        vm.mockCallRevert(
            mockRegistry,
            abi.encodeWithSignature("getFeed(address,address)", mockAsset, mockDenom),
            "FeedNotFound"
        );
        vm.expectRevert(OracleFacet.NoPriceFeed.selector);
        OracleFacet(address(diamond)).getAssetPrice(mockAsset);
    }

    function testGetAssetPriceReverts_StalePriceData_ZeroPrice() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        uint80 roundId = 1;
        vm.mockCall(
            mockFeed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(roundId, int256(0), block.timestamp, block.timestamp, roundId)
        );
        vm.expectRevert(OracleFacet.StalePriceData.selector);
        OracleFacet(address(diamond)).getAssetPrice(mockAsset);
    }

    function testGetAssetPriceReverts_StalePriceData_ZeroUpdatedAt() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        uint80 roundId = 1;
        vm.mockCall(
            mockFeed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(roundId, int256(1e8), block.timestamp, uint256(0), roundId)
        );
        vm.expectRevert(OracleFacet.StalePriceData.selector);
        OracleFacet(address(diamond)).getAssetPrice(mockAsset);
    }

    function testGetAssetPriceReverts_StalePriceData_TooOld() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        vm.warp(LibVaipakam.ORACLE_STABLE_STALENESS + 10 hours);
        uint80 roundId = 1;
        uint256 staleAt = block.timestamp - (LibVaipakam.ORACLE_STABLE_STALENESS + 1);
        vm.mockCall(
            mockFeed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(roundId, int256(1e8), staleAt, staleAt, roundId)
        );
        vm.expectRevert(OracleFacet.StalePriceData.selector);
        OracleFacet(address(diamond)).getAssetPrice(mockAsset);
    }

    function testGetAssetPriceReverts_RoundMismatch() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        uint80 roundId = 1;
        uint80 answeredInRound = 2;
        vm.mockCall(
            mockFeed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(roundId, int256(1e8), block.timestamp, block.timestamp, answeredInRound)
        );
        vm.expectRevert(OracleFacet.StalePriceData.selector);
        OracleFacet(address(diamond)).getAssetPrice(mockAsset);
    }

    // ─── Additional branch coverage ───────────────────────────────────────────

    function testCheckLiquidityReturnsIlliquidWhenRoundMismatch() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        uint80 roundId = 1;
        uint80 answeredInRound = 2;
        vm.mockCall(
            mockFeed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(roundId, int256(1e8), block.timestamp, block.timestamp, answeredInRound)
        );
        LibVaipakam.LiquidityStatus status = OracleFacet(address(diamond)).checkLiquidity(mockAsset);
        assertEq(uint8(status), uint8(LibVaipakam.LiquidityStatus.Illiquid));
    }

    function testCheckLiquidityReturnsIlliquidWhenUpdatedAtZero() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        uint80 roundId = 1;
        vm.mockCall(
            mockFeed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(roundId, int256(1e8), block.timestamp, uint256(0), roundId)
        );
        LibVaipakam.LiquidityStatus status = OracleFacet(address(diamond)).checkLiquidity(mockAsset);
        assertEq(uint8(status), uint8(LibVaipakam.LiquidityStatus.Illiquid));
    }

    function testCheckLiquidityInitializedPoolCovered() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        _mockFeedFull(mockFeed, int256(1e8), 8);

        address pool = _computePoolAddress(mockAsset, mockWeth);
        (address t0, address t1) = mockAsset < mockWeth ? (mockAsset, mockWeth) : (mockWeth, mockAsset);
        vm.mockCall(
            mockFactory,
            abi.encodeWithSignature("getPool(address,address,uint24)", t0, t1, uint24(3000)),
            abi.encode(pool)
        );
        vm.mockCall(
            pool,
            abi.encodeWithSignature("slot0()"),
            abi.encode(uint160(2e18), int24(0), uint16(0), uint16(0), uint16(0), uint8(0), false)
        );
        vm.mockCall(pool, abi.encodeWithSignature("liquidity()"), abi.encode(uint128(5e18)));

        LibVaipakam.LiquidityStatus status = OracleFacet(address(diamond)).checkLiquidity(mockAsset);
        assertEq(uint8(status), uint8(LibVaipakam.LiquidityStatus.Liquid));
    }

    // ─── checkLiquidityOnActiveNetwork ────────────────────────────────────────

    function testCheckLiquidityOnActiveNetworkRevertsZeroAddress() public {
        vm.expectRevert(IVaipakamErrors.InvalidAsset.selector);
        OracleFacet(address(diamond)).checkLiquidityOnActiveNetwork(address(0));
    }

    function testCheckLiquidityOnActiveNetworkLiquid() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        _mockFeedFull(mockFeed, int256(1e8), 8);
        _mockLiquidPool(mockAsset, uint128(1e18));
        LibVaipakam.LiquidityStatus status =
            OracleFacet(address(diamond)).checkLiquidityOnActiveNetwork(mockAsset);
        assertEq(uint8(status), uint8(LibVaipakam.LiquidityStatus.Liquid));
    }

    function testCheckLiquidityOnActiveNetworkIlliquid() public {
        vm.mockCallRevert(
            mockRegistry,
            abi.encodeWithSignature("getFeed(address,address)", mockAsset, mockDenom),
            "no feed"
        );
        LibVaipakam.LiquidityStatus status =
            OracleFacet(address(diamond)).checkLiquidityOnActiveNetwork(mockAsset);
        assertEq(uint8(status), uint8(LibVaipakam.LiquidityStatus.Illiquid));
    }

    // ─── Liquidity dual-check ────────────────────────────────────────────────

    /// @dev checkLiquidity requires BOTH a Chainlink feed AND sufficient DEX
    ///      depth. Either missing → Illiquid.
    function testCheckLiquidityRequiresBothChainlinkAndDex() public {
        // (a) Valid feed, zero DEX depth → Illiquid.
        _mockRegistryFeed(mockAsset, mockFeed);
        _mockFeedFull(mockFeed, int256(1e8), 8);
        _mockLiquidPool(mockAsset, uint128(0));

        LibVaipakam.LiquidityStatus s1 =
            OracleFacet(address(diamond)).checkLiquidity(mockAsset);
        assertEq(
            uint8(s1),
            uint8(LibVaipakam.LiquidityStatus.Illiquid),
            "Illiquid when Chainlink ok but DEX depth is zero"
        );

        vm.clearMockedCalls();
        // clearMockedCalls wipes the default ethUsdFeed mock too — restore it.
        _mockFeedFull(mockEthUsdFeed, int256(2000e8), 8);

        // (b) No feed, plenty of DEX depth → still Illiquid.
        _mockRegistryFeed(mockAsset, address(0));
        LibVaipakam.LiquidityStatus s2 =
            OracleFacet(address(diamond)).checkLiquidity(mockAsset);
        assertEq(
            uint8(s2),
            uint8(LibVaipakam.LiquidityStatus.Illiquid),
            "Illiquid when Chainlink absent regardless of DEX depth"
        );
    }
}
