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
 *     feed (`ethNumeraireFeed`) and compared to `MIN_LIQUIDITY_PAD`.
 *   - Asset pricing uses a hybrid path: direct asset/USD via the Feed
 *     Registry is primary; asset/ETH × ETH/USD is the fallback.
 *   - WETH itself is a supported quote/asset — its price comes directly
 *     from `ethNumeraireFeed` and its liquidity check skips the pool hop.
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
        mockEthUsdFeed  = makeAddr("ethNumeraireFeed");
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
        AdminFacet(address(diamond)).unpause();

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
    ///      `sqrtPriceX96 = 2^96` ⇒ pool price 1.0 ⇒ the WETH-leg virtual
    ///      reserve `_v3DepthLiquid` computes equals `liquidity` exactly
    ///      (and is independent of the asset-vs-WETH address ordering), so
    ///      the resulting USD depth is `2 × liquidity × ethPrice × 1e6 /
    ///      (1e18 × 10**ethDec)` — see {testCheckLiquidityReturnsLiquidWhenAllConditionsMet}.
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
            abi.encode(uint160(uint256(1) << 96), int24(0), uint16(0), uint16(0), uint16(0), uint8(0), false)
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
        // Trivially tiny WETH-leg depth: with sqrtPriceX96 = 2^96 the
        // WETH-leg virtual reserve == liquidity, and liquidity = 1 makes
        // the USD depth integer-divide to 0 — far below MIN_LIQUIDITY_PAD
        // (1_000_000 * 1e6 = 1e12). See the Liquid test for the metric.
        _mockLiquidPool(mockAsset, 1);
        LibVaipakam.LiquidityStatus status = OracleFacet(address(diamond)).checkLiquidity(mockAsset);
        assertEq(uint8(status), uint8(LibVaipakam.LiquidityStatus.Illiquid));
    }

    function testCheckLiquidityReturnsLiquidWhenAllConditionsMet() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        // Asset feed-priced to match WETH ($2000): post-§4.4-step-3
        // `_checkLiquidity` runs a slippage simulation that includes a
        // value-balance guard requiring the pool's spot to match the
        // Chainlink-feed-implied spot. Mock pool has sqrtPriceX96 =
        // 2^96 ⇒ asset:WETH = 1:1 in token units. The value-balance
        // guard accepts that only when both legs price equally — so
        // both legs at $2000 lets the pool through.
        _mockFeedFull(mockFeed, int256(2000e8), 8);
        // With sqrtPriceX96 = 2^96 the WETH-leg virtual reserve == liquidity.
        // The new check runs a $5k slippage simulation: at this depth
        // the floor-size swap is a tiny fraction of the virtual reserve,
        // so slippage stays well under 2% — passes.
        _mockLiquidPool(mockAsset, uint128(1e21));
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

    /// #2403 — zero collateral is refused, as the loan-level path refuses
    /// it, rather than answered with an LTV of 0 that reads as "no risk".
    function testCalculateLTVZeroCollateralReverts() public {
        vm.expectRevert(OracleFacet.ZeroCollateral.selector);
        OracleFacet(address(diamond)).calculateLTV(mockAsset, 1000 ether, mockAsset2, 0);
    }

    /// #2418 r2 — a leg too small to register at ANY fixed scale still
    /// counts: the ratio is taken in one step, never from rounded legs. One
    /// base unit of a 1-decimal token at 9e-18 per whole token (9e-19) against
    /// one unit of a 0-decimal token at 1e-18 is 0.9 — 9000 bps, not 0.
    function testCalculateLTVTinyLegsUseTheExactRatio() public {
        address b1 = address(new ERC20Mock("B1", "B1", 1));
        address c0 = address(new ERC20Mock("C0", "C0", 0));
        _mockRegistryFeed(b1, mockFeed);
        _mockRegistryFeed(c0, mockFeed2);
        _mockFeedFull(mockFeed, int256(9), 18);
        _mockFeedFull(mockFeed2, int256(1), 18);
        // Borrowed scale (19) above collateral scale (18): the divide-after branch.
        assertEq(OracleFacet(address(diamond)).calculateLTV(b1, 1, c0, 1), 9000);
        // And the other way round — the multiply-before branch: 81 units of
        // C0 (8.1e-17) against 100 units of B1 (9e-17) is 0.9 too.
        assertEq(OracleFacet(address(diamond)).calculateLTV(c0, 81, b1, 100), 9000);
    }

    /// #2418 r3 — when the borrowed scale is the larger, a quotient that is
    /// huge BEFORE the decimal division still returns the representable
    /// result: 2e74 base units of a 60-decimal token (2e14 whole) against one
    /// whole 0-decimal token, both at 1 with 0-decimal feeds, is 2e18 bps.
    /// Dividing the decimals out after the mulDiv overflowed at 2e78.
    function testCalculateLTVLargeBorrowedScaleDoesNotOverflowEarly() public {
        address b60 = address(new ERC20Mock("B60", "B60", 60));
        address c0 = address(new ERC20Mock("C0", "C0", 0));
        _mockRegistryFeed(b60, mockFeed);
        _mockRegistryFeed(c0, mockFeed2);
        _mockFeedFull(mockFeed, int256(1), 0);
        _mockFeedFull(mockFeed2, int256(1), 0);
        assertEq(OracleFacet(address(diamond)).calculateLTV(b60, 2e74, c0, 1), 2e18);
    }

    /// #2418 r3 — the reviewer's own case: a 77-decimal borrowed token (the
    /// widest gap the borrowed-larger branch represents) against a 0-decimal
    /// collateral at equal unit prices — 2e73 base units against 1 is 2 bps.
    function testCalculateLTVWidestBorrowedGapIsExact() public {
        address b77 = address(new ERC20Mock("B77", "B77", 77));
        address c0 = address(new ERC20Mock("C0", "C0", 0));
        _mockRegistryFeed(b77, mockFeed);
        _mockRegistryFeed(c0, mockFeed2);
        _mockFeedFull(mockFeed, int256(1), 0);
        _mockFeedFull(mockFeed2, int256(1), 0);
        assertEq(OracleFacet(address(diamond)).calculateLTV(b77, 2e73, c0, 1), 2);
    }

    /// #2418 r3 — a gap beyond what a branch represents exactly is refused BY
    /// NAME, never by an arithmetic panic: a 74-decimal COLLATERAL token
    /// (LTV_SCALE · 10**74 would not fit).
    function testCalculateLTVRefusesAnUnsupportedScaleGap() public {
        address b0 = address(new ERC20Mock("B0", "B0", 0));
        address c74 = address(new ERC20Mock("C74", "C74", 74));
        _mockRegistryFeed(b0, mockFeed);
        _mockRegistryFeed(c74, mockFeed2);
        _mockFeedFull(mockFeed, int256(1), 0);
        _mockFeedFull(mockFeed2, int256(1), 0);
        vm.expectRevert(abi.encodeWithSelector(OracleFacet.DecimalScaleUnsupported.selector, 74));
        OracleFacet(address(diamond)).calculateLTV(b0, 1, c74, 1e74);
    }

    /// #2418 r4 — the reviewer's case: a 1-decimal gap with a maximal borrow
    /// returns the representable result instead of overflowing the
    /// intermediate quotient. max units of B1 against 1000 of C0, unit prices:
    /// max · 1e4 / (10 · 1000) == max.
    function testCalculateLTVMaximalBorrowSmallGap() public {
        address b1 = address(new ERC20Mock("B1", "B1", 1));
        address c0 = address(new ERC20Mock("C0", "C0", 0));
        _mockRegistryFeed(b1, mockFeed);
        _mockRegistryFeed(c0, mockFeed2);
        _mockFeedFull(mockFeed, int256(1), 0);
        _mockFeedFull(mockFeed2, int256(1), 0);
        assertEq(OracleFacet(address(diamond)).calculateLTV(b1, type(uint256).max, c0, 1000), type(uint256).max);
    }

    /// #2418 r4 — when 10**gap · collateral does NOT fit, both orderings stay
    /// exact and never overflow: the larger divisor goes inside mulDiv.
    function testCalculateLTVOverflowingDenominatorBothOrders() public {
        address c0 = address(new ERC20Mock("C0", "C0", 0));
        _mockRegistryFeed(c0, mockFeed2);
        _mockFeedFull(mockFeed2, int256(1), 0);
        _mockFeedFull(mockFeed, int256(1), 0);
        // 10**gap larger: 77-decimal borrowed, max units against 1000.
        // floor(max · 1e4 / 1e80) == 11.
        address b77 = address(new ERC20Mock("B77", "B77", 77));
        _mockRegistryFeed(b77, mockFeed);
        assertEq(OracleFacet(address(diamond)).calculateLTV(b77, type(uint256).max, c0, 1000), 11);
        // Collateral larger: 1-decimal borrowed, max against max:
        // max · 1e4 / (10 · max) == 1000.
        address b1 = address(new ERC20Mock("B1", "B1", 1));
        _mockRegistryFeed(b1, mockFeed);
        assertEq(
            OracleFacet(address(diamond)).calculateLTV(b1, type(uint256).max, c0, type(uint256).max),
            1000
        );
    }

    /// #2418 r4 — a price that resolves to zero (a composed price can floor to
    /// zero from positive feeds) is refused by name on either side, never read
    /// as LTV 0 ("no risk") or as zero collateral.
    function testCalculateLTVRefusesAZeroPrice() public {
        _mockRegistryFeed(mockAsset2, mockFeed2);
        _mockFeedFull(mockFeed2, int256(1e8), 8);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, mockAsset),
            abi.encode(uint256(0), uint8(8))
        );
        vm.expectRevert(abi.encodeWithSelector(OracleFacet.ZeroPrice.selector, mockAsset));
        OracleFacet(address(diamond)).calculateLTV(mockAsset, 1 ether, mockAsset2, 1 ether);

        vm.expectRevert(abi.encodeWithSelector(OracleFacet.ZeroPrice.selector, mockAsset));
        OracleFacet(address(diamond)).calculateLTV(mockAsset2, 1 ether, mockAsset, 1 ether);
    }

    /// #2418 r2 — large amounts with high-decimal feeds and tokens do not
    /// overflow the one-step ratio: 1e9 whole 18-decimal tokens priced with an
    /// 18-decimal feed on both sides.
    function testCalculateLTVLargeAmountsDoNotOverflow() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        _mockRegistryFeed(mockAsset2, mockFeed2);
        _mockFeedFull(mockFeed, int256(1000e18), 18);
        _mockFeedFull(mockFeed2, int256(2000e18), 18);
        uint256 ltv = OracleFacet(address(diamond)).calculateLTV(mockAsset, 1e9 ether, mockAsset2, 1e9 ether);
        assertEq(ltv, 5000);
    }

    /// #2418 r1 — a borrow worth less than one whole numeraire unit keeps its
    /// precision: $0.50 against $1 of collateral is 5000 bps, never a
    /// truncated "0 — no risk".
    function testCalculateLTVSubUnitBorrowKeepsPrecision() public {
        _mockRegistryFeed(mockAsset, mockFeed);
        _mockRegistryFeed(mockAsset2, mockFeed2);
        _mockFeedFull(mockFeed, int256(1e8), 8);  // borrowed: $1
        _mockFeedFull(mockFeed2, int256(1e8), 8); // collateral: $1
        uint256 ltv = OracleFacet(address(diamond)).calculateLTV(mockAsset, 0.5 ether, mockAsset2, 1 ether);
        assertEq(ltv, 5000);
    }

    /// #2403 — each leg is scaled by its OWN token decimals. A 6-decimal
    /// borrowed token against an 18-decimal collateral gives the same LTV as
    /// the equal-decimals case for the same dollar amounts; dividing by the
    /// feed decimals alone made this ~0 (off by 10**12).
    function testCalculateLTVMixedTokenDecimals() public {
        address usd6 = address(new ERC20Mock("USD6", "USD6", 6));
        _mockRegistryFeed(usd6, mockFeed);
        _mockRegistryFeed(mockAsset2, mockFeed2);
        _mockFeedFull(mockFeed, int256(1e8), 8);   // borrowed: $1, 6 decimals
        _mockFeedFull(mockFeed2, int256(2e8), 8);  // collateral: $2, 18 decimals

        uint256 ltv = OracleFacet(address(diamond)).calculateLTV(usd6, 1000e6, mockAsset2, 1800 ether);
        assertEq(ltv, 2777);

        // And the other way round: 18-decimal borrowed, 6-decimal collateral.
        address coll6 = address(new ERC20Mock("COL6", "COL6", 6));
        _mockRegistryFeed(mockAsset, mockFeed);
        _mockRegistryFeed(coll6, mockFeed2);
        ltv = OracleFacet(address(diamond)).calculateLTV(mockAsset, 1000 ether, coll6, 1800e6);
        assertEq(ltv, 2777);
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
        // Set-up already mocks ethNumeraireFeed @ $2000 / 8 decimals.
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
        // Asset feed-priced to match WETH ($2000) so the §4.4-step-3
        // value-balance guard accepts the 1:1 mock pool (see
        // {testCheckLiquidityReturnsLiquidWhenAllConditionsMet}).
        _mockFeedFull(mockFeed, int256(2000e8), 8);

        address pool = _computePoolAddress(mockAsset, mockWeth);
        (address t0, address t1) = mockAsset < mockWeth ? (mockAsset, mockWeth) : (mockWeth, mockAsset);
        vm.mockCall(
            mockFactory,
            abi.encodeWithSignature("getPool(address,address,uint24)", t0, t1, uint24(3000)),
            abi.encode(pool)
        );
        // Initialized pool (non-zero sqrtPriceX96) with sufficient depth.
        // sqrtPriceX96 = 2^96 ⇒ price 1.0; with the matched $2000:$2000
        // feeds the value-balance guard passes, and a $5k slippage swap
        // at liquidity = 1e21 stays well under the 2% floor — passes.
        vm.mockCall(
            pool,
            abi.encodeWithSignature("slot0()"),
            abi.encode(uint160(uint256(1) << 96), int24(0), uint16(0), uint16(0), uint16(0), uint8(0), false)
        );
        vm.mockCall(pool, abi.encodeWithSignature("liquidity()"), abi.encode(uint128(1e21)));

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
        // Asset price-matched to WETH for the §4.4-step-3 value-balance
        // guard — see {testCheckLiquidityReturnsLiquidWhenAllConditionsMet}.
        _mockFeedFull(mockFeed, int256(2000e8), 8);
        _mockLiquidPool(mockAsset, uint128(1e21));
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
        // clearMockedCalls wipes the default ethNumeraireFeed mock too — restore it.
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
