// test/DepthTieredLtv.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {HelperTest} from "./HelperTest.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/**
 * @title DepthTieredLtv
 * @notice Piece B — exercises {OracleFacet.getLiquidityTier} /
 *         {getEffectiveLiquidityTier} (the on-chain liquidity-tier
 *         authority + the keeper-min effective tier) and the
 *         {ConfigFacet} governance surface (knob setters + bounds +
 *         `setKeeperTier`). Mirrors the mock-V3-pool setup of
 *         `OracleLiquidityORTest` and adds {ConfigFacet} to the cut.
 *
 *         Pricing convention used throughout: the test asset (an 18-dec
 *         ERC-20) and WETH (the default single-element PAA list) are both
 *         priced at $2,000 via `vm.mockCall` on `getAssetPrice`, and the
 *         mock pool's `sqrtPriceX96 == 2⁹⁶` (internal price 1.0) — so the
 *         pool's virtual reserves are `(L, L)` and the two legs are
 *         exactly value-balanced (the manipulation guard passes). With
 *         `pA = 2000e8`, `scaleA = 1e26`: a `$X`-PAD test trade is
 *         `amountIn = X·1e6·5e8` base units, and from the closed-form
 *         CPMM impact a pool clears that trade at ≤ `liquiditySlippageBps`
 *         (200 = 2%) iff `L ≳ 57.5·amountIn`. The chosen `L`s land each
 *         tier comfortably mid-band.
 */
contract DepthTieredLtv is Test {
    VaipakamDiamond diamond;
    address owner = address(this);

    ERC20Mock assetTok; // 18-dec ERC-20 used as the classified collateral
    address mockAsset;
    address mockWeth = makeAddr("weth");
    address mockRegistry = makeAddr("registry");
    address mockDenom = makeAddr("denom");
    address mockEthUsdFeed = makeAddr("ethNumeraireFeed");
    address mockAssetFeed = makeAddr("assetFeed");
    address mockUniFactory = makeAddr("uniFactory");
    address mockPancakeFactory = makeAddr("pancakeFactory");
    address mockSushiFactory = makeAddr("sushiFactory");
    address keeperBot = makeAddr("keeperBot");
    address rando = makeAddr("rando");

    // ETH (and the asset) priced at $2,000 with an 8-dec feed.
    int256 constant PRICE_2000 = 2000e8;

    // Pool `liquidity()` values that land each tier (see the contract
    // doc for the derivation). With the $2,000 / 18-dec / `sqrtP = 2⁹⁶`
    // convention: the `_checkLiquidity` ($1M depth-at-tick) floor needs
    // `L ≥ 2.5e20`; Tier 1 ($50k @ ≤2%) needs `L ≳ 1.44e21`, Tier 2
    // ($500k) `L ≳ 1.44e22`, Tier 3 ($5M) `L ≳ 1.44e23`.
    uint128 constant L_NOT_LIQUID = uint128(1e20); // below the $1M floor ⇒ Illiquid ⇒ Tier 0
    uint128 constant L_TIER1 = uint128(1e22); // clears $50k, not $500k ⇒ Tier 1
    uint128 constant L_TIER2 = uint128(5e22); // clears $500k, not $5M ⇒ Tier 2
    uint128 constant L_TIER3 = uint128(5e23); // clears $5M ⇒ Tier 3

    function setUp() public {
        assetTok = new ERC20Mock("Asset", "AST", 18);
        mockAsset = address(assetTok);

        DiamondCutFacet cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));
        HelperTest helper = new HelperTest();

        bytes4[] memory oracleAdminSelectors = new bytes4[](7);
        oracleAdminSelectors[0] = OracleAdminFacet.setChainlinkRegistry.selector;
        oracleAdminSelectors[1] = OracleAdminFacet.setUsdChainlinkDenominator.selector;
        oracleAdminSelectors[2] = OracleAdminFacet.setEthChainlinkDenominator.selector;
        oracleAdminSelectors[3] = OracleAdminFacet.setWethContract.selector;
        oracleAdminSelectors[4] = OracleAdminFacet.setEthUsdFeed.selector;
        oracleAdminSelectors[5] = OracleAdminFacet.setUniswapV3Factory.selector;
        oracleAdminSelectors[6] = OracleAdminFacet.setStableTokenFeed.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](5);
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
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();
        AdminFacet(address(diamond)).unpause();
        // Hand KEEPER_ROLE to the bot EOA (initializeAccessControl granted
        // it to `owner`; production handover would rotate it the same way).
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.KEEPER_ROLE, keeperBot);

        vm.warp(7 days);

        OracleAdminFacet(address(diamond)).setUsdChainlinkDenominator(mockDenom);
        OracleAdminFacet(address(diamond)).setChainlinkRegistry(mockRegistry);
        OracleAdminFacet(address(diamond)).setWethContract(mockWeth);
        OracleAdminFacet(address(diamond)).setUniswapV3Factory(mockUniFactory);
        OracleAdminFacet(address(diamond)).setEthUsdFeed(mockEthUsdFeed);
        AdminFacet(address(diamond)).setPancakeswapV3Factory(mockPancakeFactory);
        AdminFacet(address(diamond)).setSushiswapV3Factory(mockSushiFactory);

        // ETH/USD = $2,000, fresh — used by `_checkLiquidity`'s WETH-leg
        // depth conversion (and is what makes `_v3DepthLiquid` compute a
        // `padDepthScaled = L·4e-9` against `MIN_LIQUIDITY_PAD = 1e12`).
        _mockFeedFull(mockEthUsdFeed, PRICE_2000, 8);
        // Asset/USD registry feed (so the raw freshness pre-check in
        // `_checkLiquidity` is satisfied).
        vm.mockCall(
            mockRegistry,
            abi.encodeWithSignature("getFeed(address,address)", mockAsset, mockDenom),
            abi.encode(mockAssetFeed)
        );
        _mockFeedFull(mockAssetFeed, PRICE_2000, 8);

        // `getAssetPrice` is consulted (via the diamond, by
        // `_liquidityTier._tryGetAssetPriceView`) for both legs — pin
        // both to $2,000 / 8-dec so the value-balance guard passes for a
        // `sqrtP = 2⁹⁶` (1:1) pool with equal-decimal tokens.
        _mockAssetPrice(mockAsset, uint256(uint256(PRICE_2000)), 8);
        _mockAssetPrice(mockWeth, uint256(uint256(PRICE_2000)), 8);

        // Default: no pool at any probed tier on any factory. Tests
        // opt-in via `_mockPool` for whichever (factory, fee, L) they need.
        _mockEmptyAtAllTiers(mockUniFactory);
        _mockEmptyAtAllTiers(mockPancakeFactory);
        _mockEmptyAtAllTiers(mockSushiFactory);
    }

    // ─── getLiquidityTier — tier resolution by depth ────────────────

    function test_tier_illiquidAsset_isZero() public view {
        // No pool anywhere ⇒ not Liquid ⇒ Tier 0.
        assertEq(OracleFacet(address(diamond)).getLiquidityTier(mockAsset), 0);
        // address(0) ⇒ 0, never reverts.
        assertEq(OracleFacet(address(diamond)).getLiquidityTier(address(0)), 0);
    }

    function test_tier_belowLiquidityFloor_isZero() public {
        // Pool exists but `liquidity()` is below the `MIN_LIQUIDITY_PAD`
        // depth-at-tick floor ⇒ `_checkLiquidity` Illiquid ⇒ Tier 0.
        _mockPool(mockUniFactory, mockAsset, 3000, L_NOT_LIQUID);
        assertEq(OracleFacet(address(diamond)).getLiquidityTier(mockAsset), 0);
    }

    function test_tier1_pool() public {
        _mockPool(mockUniFactory, mockAsset, 3000, L_TIER1);
        assertEq(OracleFacet(address(diamond)).getLiquidityTier(mockAsset), 1);
    }

    function test_tier2_pool() public {
        _mockPool(mockUniFactory, mockAsset, 3000, L_TIER2);
        assertEq(OracleFacet(address(diamond)).getLiquidityTier(mockAsset), 2);
    }

    function test_tier3_pool() public {
        _mockPool(mockUniFactory, mockAsset, 3000, L_TIER3);
        assertEq(OracleFacet(address(diamond)).getLiquidityTier(mockAsset), 3);
    }

    function test_tier_bestRouteAcrossFactories() public {
        // A thin pool on Uni, a deep one on Sushi — the route search
        // takes the *best* (deepest / lowest-impact), so the deep Sushi
        // pool wins ⇒ Tier 3.
        _mockPool(mockUniFactory, mockAsset, 3000, L_TIER1);
        _mockPool(mockSushiFactory, mockAsset, 3000, L_TIER3);
        assertEq(OracleFacet(address(diamond)).getLiquidityTier(mockAsset), 3);
    }

    function test_tier_excludesPoolWhoseSpotDisagreesWithFeed() public {
        // Pool is deep enough for Tier 3, but its 1:1 internal price
        // disagrees with the feeds (asset feed-priced 2× WETH while the
        // pool prices them equal) ⇒ the value-balance guard excludes it
        // ⇒ no valid route ⇒ Tier 0.
        //
        // Post-§4.4-step-3 upgrade: `_checkLiquidity` ALSO runs the same
        // value-balance guard (it shares the route-search machinery
        // with `getLiquidityTier`), so an asset whose only pool fails
        // the guard now correctly classifies Illiquid at the base check
        // too — a tightening vs the legacy `_v3DepthLiquid` metric which
        // had no value-balance guard and would have said Liquid here.
        _mockPool(mockUniFactory, mockAsset, 3000, L_TIER3);
        _mockAssetPrice(mockAsset, uint256(uint256(PRICE_2000)) * 2, 8); // asset now "worth 2× WETH"
        assertEq(
            uint256(OracleFacet(address(diamond)).checkLiquidity(mockAsset)),
            uint256(LibVaipakam.LiquidityStatus.Illiquid)
        );
        assertEq(OracleFacet(address(diamond)).getLiquidityTier(mockAsset), 0);
    }

    // ─── getLiquidityTier — Uni-V2-fork family (Piece B follow-up b) ──

    /// @dev With only a thin V3 pool (just enough for `_checkLiquidity`
    ///      to pass) the route search lands Tier 1; adding a deep V2
    ///      pool against the same quote token pulls the asset up to
    ///      Tier 3 — i.e. the V2 leg is consulted alongside the V3 trio
    ///      and contributes to the best-route selection.
    function test_tier_v2_poolPullsAssetUpToTier3() public {
        // Thin V3 pool — clears `_checkLiquidity`'s $1M depth-at-tick
        // floor (L_TIER1 = 1e22 ⇒ ~$40M padDepthScaled) and lands Tier 1
        // in the route search by itself.
        _mockPool(mockUniFactory, mockAsset, 3000, L_TIER1);
        assertEq(OracleFacet(address(diamond)).getLiquidityTier(mockAsset), 1);

        // Configure the UniV2 factory + mock a deep V2 pool. With both
        // legs of the route search active the V2 pool's lower slippage
        // at the larger test sizes wins ⇒ Tier 3.
        address mockUniV2 = makeAddr("uniV2Factory");
        AdminFacet(address(diamond)).setUniswapV2Factory(mockUniV2);
        _mockV2Pool(mockUniV2, mockAsset, mockWeth, uint112(L_TIER3), uint112(L_TIER3));
        assertEq(OracleFacet(address(diamond)).getLiquidityTier(mockAsset), 3);
    }

    /// @dev V2 value-balance guard: a V2 pool with mismatched legs
    ///      (asset reserves valued 2× the WETH reserve per the feeds)
    ///      gets excluded from the route search — only the (thin) V3
    ///      pool's contribution remains, so the tier doesn't climb.
    function test_tier_v2_valueBalanceGuardExcludesMismatchedPool() public {
        _mockPool(mockUniFactory, mockAsset, 3000, L_TIER1);
        address mockUniV2 = makeAddr("uniV2Factory");
        AdminFacet(address(diamond)).setUniswapV2Factory(mockUniV2);
        // V2 pool with deep but unbalanced reserves (asset side 2× the
        // WETH side at the feed prices ⇒ pool spot disagrees with the
        // feed by 100% ⇒ guard rejects ⇒ V2 leg contributes nothing).
        _mockV2Pool(mockUniV2, mockAsset, mockWeth, uint112(L_TIER3) * 2, uint112(L_TIER3));
        assertEq(OracleFacet(address(diamond)).getLiquidityTier(mockAsset), 1);
    }

    /// @dev V2-only path: a chain with no V3 deployment configured but a
    ///      deep V2 pool now classifies the asset Liquid post-§4.4-step-3.
    ///      The legacy `_v3DepthLiquid` was V3-only, so this scenario
    ///      previously fell through to Illiquid (documented by the
    ///      pre-step-3 version of this test, which has been kept here in
    ///      flipped form to make the semantic upgrade legible). The new
    ///      `_passesFloorSlippage` consults the same V2 leg the route
    ///      search uses for tier resolution, so a deep V2 pool against a
    ///      PAA quote is enough to clear the floor.
    function test_tier_v2_aloneClassifiesLiquidPostStep3() public {
        address mockUniV2 = makeAddr("uniV2Factory");
        AdminFacet(address(diamond)).setUniswapV2Factory(mockUniV2);
        _mockV2Pool(mockUniV2, mockAsset, mockWeth, uint112(L_TIER3), uint112(L_TIER3));
        // V3 factories all empty for this asset (default setUp), but the
        // deep V2 pool clears the floor slippage on its own.
        assertEq(
            uint256(OracleFacet(address(diamond)).checkLiquidity(mockAsset)),
            uint256(LibVaipakam.LiquidityStatus.Liquid)
        );
        // The tier resolution then runs over the same routes — V2 pool
        // at L_TIER3 ⇒ clears every test size ⇒ Tier 3.
        assertEq(OracleFacet(address(diamond)).getLiquidityTier(mockAsset), 3);
    }

    // ─── getEffectiveLiquidityTier = min(onChain, keeperTier) ───────

    function test_effectiveTier_defaultKeeperTierIsOne() public {
        // On-chain Tier 3, keeper hasn't touched it ⇒ keeperTier defaults
        // to 1 ⇒ effective tier = min(3, 1) = 1.
        _mockPool(mockUniFactory, mockAsset, 3000, L_TIER3);
        assertEq(OracleFacet(address(diamond)).getLiquidityTier(mockAsset), 3);
        assertEq(OracleFacet(address(diamond)).getEffectiveLiquidityTier(mockAsset), 1);
        assertEq(ConfigFacet(address(diamond)).getKeeperTier(mockAsset), 1);
    }

    function test_effectiveTier_keeperPromotesToOnChainCeiling() public {
        _mockPool(mockUniFactory, mockAsset, 3000, L_TIER3);
        vm.prank(keeperBot);
        ConfigFacet(address(diamond)).setKeeperTier(mockAsset, 3);
        assertEq(OracleFacet(address(diamond)).getEffectiveLiquidityTier(mockAsset), 3);
        assertEq(ConfigFacet(address(diamond)).getKeeperTier(mockAsset), 3);
    }

    function test_effectiveTier_keeperCannotExceedOnChainCeiling() public {
        // On-chain only Tier 1; keeper sets 3 ⇒ effective = min(1, 3) = 1.
        _mockPool(mockUniFactory, mockAsset, 3000, L_TIER1);
        vm.prank(keeperBot);
        ConfigFacet(address(diamond)).setKeeperTier(mockAsset, 3);
        assertEq(OracleFacet(address(diamond)).getEffectiveLiquidityTier(mockAsset), 1);
    }

    function test_effectiveTier_illiquidStaysZeroRegardlessOfKeeper() public {
        // No pool ⇒ on-chain 0; keeper sets 3 ⇒ effective = min(0, 3) = 0.
        vm.prank(keeperBot);
        ConfigFacet(address(diamond)).setKeeperTier(mockAsset, 3);
        assertEq(OracleFacet(address(diamond)).getEffectiveLiquidityTier(mockAsset), 0);
        // The raw keeperTier mapping still records 3, but effective is 0.
        assertEq(ConfigFacet(address(diamond)).getKeeperTier(mockAsset), 3);
    }

    // ─── ConfigFacet — setKeeperTier access control + bounds ────────

    function test_setKeeperTier_onlyKeeperRole() public {
        vm.prank(rando);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibAccessControl.AccessControlUnauthorizedAccount.selector,
                rando,
                LibAccessControl.KEEPER_ROLE
            )
        );
        ConfigFacet(address(diamond)).setKeeperTier(mockAsset, 2);
    }

    function test_setKeeperTier_rejectsOutOfRange() public {
        vm.startPrank(keeperBot);
        vm.expectRevert(abi.encodeWithSelector(ConfigFacet.InvalidLiquidityTier.selector, uint8(0)));
        ConfigFacet(address(diamond)).setKeeperTier(mockAsset, 0);
        vm.expectRevert(abi.encodeWithSelector(ConfigFacet.InvalidLiquidityTier.selector, uint8(4)));
        ConfigFacet(address(diamond)).setKeeperTier(mockAsset, 4);
        vm.stopPrank();
    }

    function test_setKeeperTier_rejectsZeroAsset() public {
        vm.prank(keeperBot);
        vm.expectRevert(IVaipakamErrors.InvalidAsset.selector);
        ConfigFacet(address(diamond)).setKeeperTier(address(0), 2);
    }

    // ─── ConfigFacet — knob setters (bounds + monotonicity) ─────────

    function test_setDepthTieredLtvEnabled_toggles() public {
        assertFalse(ConfigFacet(address(diamond)).getDepthTieredLtvEnabled());
        ConfigFacet(address(diamond)).setDepthTieredLtvEnabled(true);
        assertTrue(ConfigFacet(address(diamond)).getDepthTieredLtvEnabled());
        ConfigFacet(address(diamond)).setDepthTieredLtvEnabled(false);
        assertFalse(ConfigFacet(address(diamond)).getDepthTieredLtvEnabled());
    }

    function test_setLiquiditySlippageBps_boundsAndDefault() public {
        // Out of range (above MAX = 1000) reverts.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector,
                bytes32("liquiditySlippageBps"),
                uint256(5000),
                LibVaipakam.MIN_LIQUIDITY_SLIPPAGE_BPS,
                LibVaipakam.MAX_LIQUIDITY_SLIPPAGE_BPS
            )
        );
        ConfigFacet(address(diamond)).setLiquiditySlippageBps(5000);
        // In range sticks.
        ConfigFacet(address(diamond)).setLiquiditySlippageBps(150);
        ( , uint256 slip, , , , , , , , , ) = ConfigFacet(address(diamond)).getDepthTierConfigBundle();
        assertEq(slip, 150);
        // 0 ⇒ default 200.
        ConfigFacet(address(diamond)).setLiquiditySlippageBps(0);
        ( , slip, , , , , , , , , ) = ConfigFacet(address(diamond)).getDepthTierConfigBundle();
        assertEq(slip, LibVaipakam.LIQUIDITY_SLIPPAGE_BPS_DEFAULT);
    }

    function test_setLiquidityTierSizes_monotoneEnforced() public {
        // floor (default 5000e6) > tier1 (100e6) ⇒ non-monotone.
        vm.expectRevert();
        ConfigFacet(address(diamond)).setLiquidityTierSizes(0, uint64(100e6), 0, uint64(5e12));
        // Below MIN_TIER_SIZE_PAD on the floor ⇒ too small.
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.TierSizeTooSmall.selector,
                uint256(1),
                LibVaipakam.MIN_TIER_SIZE_PAD
            )
        );
        ConfigFacet(address(diamond)).setLiquidityTierSizes(1, uint64(50e9), uint64(500e9), uint64(5e12));
        // Valid monotone set sticks.
        ConfigFacet(address(diamond)).setLiquidityTierSizes(
            uint64(10_000e6), uint64(100_000e6), uint64(1_000_000e6), uint64(10_000_000e6)
        );
        ( , , , , uint256 f, uint256 t1, uint256 t2, uint256 t3, , , ) =
            ConfigFacet(address(diamond)).getDepthTierConfigBundle();
        assertEq(f, 10_000e6);
        assertEq(t1, 100_000e6);
        assertEq(t2, 1_000_000e6);
        assertEq(t3, 10_000_000e6);
        // All-zero ⇒ reset to defaults.
        ConfigFacet(address(diamond)).setLiquidityTierSizes(0, 0, 0, 0);
        ( , , , , f, t1, t2, t3, , , ) = ConfigFacet(address(diamond)).getDepthTierConfigBundle();
        assertEq(f, LibVaipakam.FLOOR_SIZE_PAD_DEFAULT);
        assertEq(t3, LibVaipakam.TIER3_SIZE_PAD_DEFAULT);
    }

    function test_setTierMaxInitLtvBps_monotoneAndCeil() public {
        // t1 > t2 ⇒ non-monotone.
        vm.expectRevert();
        ConfigFacet(address(diamond)).setTierMaxInitLtvBps(7000, 6000, 6500);
        // Above the 80% ceiling ⇒ too high.
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.TierLtvBpsTooHigh.selector,
                uint256(9000),
                LibVaipakam.MAX_TIER_INIT_LTV_BPS_CEIL
            )
        );
        ConfigFacet(address(diamond)).setTierMaxInitLtvBps(5000, 6000, 9000);
        // Valid set sticks; 0 fields ⇒ defaults.
        ConfigFacet(address(diamond)).setTierMaxInitLtvBps(0, 5500, 0);
        ( , , , , , , , , uint256 t1, uint256 t2, uint256 t3) =
            ConfigFacet(address(diamond)).getDepthTierConfigBundle();
        assertEq(t1, LibVaipakam.TIER1_MAX_INIT_LTV_BPS_DEFAULT);
        assertEq(t2, 5500);
        assertEq(t3, LibVaipakam.TIER3_MAX_INIT_LTV_BPS_DEFAULT);
    }

    function test_setTwapGuard_boundsAndDefaults() public {
        // windowSec too short.
        vm.expectRevert();
        ConfigFacet(address(diamond)).setTwapGuard(uint32(60), 300);
        // consistencyBps too high.
        vm.expectRevert();
        ConfigFacet(address(diamond)).setTwapGuard(uint32(1800), 5000);
        // Valid sticks; 0 ⇒ defaults.
        ConfigFacet(address(diamond)).setTwapGuard(uint32(1 hours), 250);
        ( , , uint256 w, uint256 cb, , , , , , , ) = ConfigFacet(address(diamond)).getDepthTierConfigBundle();
        assertEq(w, 1 hours);
        assertEq(cb, 250);
        ConfigFacet(address(diamond)).setTwapGuard(0, 0);
        ( , , w, cb, , , , , , , ) = ConfigFacet(address(diamond)).getDepthTierConfigBundle();
        assertEq(w, LibVaipakam.TWAP_WINDOW_SEC_DEFAULT);
        assertEq(cb, LibVaipakam.TWAP_CONSISTENCY_BPS_DEFAULT);
    }

    // ─── ConfigFacet — PAA list management ──────────────────────────

    function test_setPaaAssets_emptyResolvesToWeth() public {
        address[] memory empty = new address[](0);
        ConfigFacet(address(diamond)).setPaaAssets(empty);
        address[] memory got = ConfigFacet(address(diamond)).getPaaAssets();
        assertEq(got.length, 1);
        assertEq(got[0], mockWeth);
    }

    function test_setPaaAssets_storesAndReflectsInRouteSearch() public {
        // Configure PAA = [mockAsset2] (a token *other* than WETH) — and
        // mock an `asset/mockAsset2` pool. The route search must then
        // probe that pair (not `asset/WETH`) — verify by giving the
        // `asset/WETH` pool tier-1-only depth and the `asset/mockAsset2`
        // pool tier-3 depth: the asset comes back Tier 3 only if PAA was
        // honoured. (And `_checkLiquidity` still needs an `asset/WETH`
        // pool — keep that one.)
        ERC20Mock altQuote = new ERC20Mock("Alt", "ALT", 18);
        _mockAssetPrice(address(altQuote), uint256(uint256(PRICE_2000)), 8);
        _mockEmptyAtAllPairsTiers(mockUniFactory, mockAsset, address(altQuote));

        _mockPool(mockUniFactory, mockAsset, 3000, L_TIER1); // asset/WETH (keeps it Liquid)
        _mockPoolPair(mockUniFactory, mockAsset, address(altQuote), 3000, L_TIER3); // asset/altQuote

        // Default PAA = [WETH] ⇒ only sees the tier-1 asset/WETH pool.
        assertEq(OracleFacet(address(diamond)).getLiquidityTier(mockAsset), 1);

        // Switch PAA to [altQuote] ⇒ now sees the deep asset/altQuote pool.
        address[] memory paa = new address[](1);
        paa[0] = address(altQuote);
        ConfigFacet(address(diamond)).setPaaAssets(paa);
        assertEq(OracleFacet(address(diamond)).getLiquidityTier(mockAsset), 3);
    }

    function test_setPaaAssets_rejectsZeroDuplicateAndOverCap() public {
        address[] memory withZero = new address[](2);
        withZero[0] = mockWeth;
        withZero[1] = address(0);
        vm.expectRevert(abi.encodeWithSelector(ConfigFacet.PaaListInvalid.selector, "zero address"));
        ConfigFacet(address(diamond)).setPaaAssets(withZero);

        address[] memory withDup = new address[](2);
        withDup[0] = mockWeth;
        withDup[1] = mockWeth;
        vm.expectRevert(abi.encodeWithSelector(ConfigFacet.PaaListInvalid.selector, "duplicate"));
        ConfigFacet(address(diamond)).setPaaAssets(withDup);

        address[] memory tooMany = new address[](9);
        for (uint256 i; i < 9; ++i) tooMany[i] = address(uint160(0x1000 + i));
        vm.expectRevert(abi.encodeWithSelector(ConfigFacet.PaaListInvalid.selector, "over MAX_PAA_ASSETS"));
        ConfigFacet(address(diamond)).setPaaAssets(tooMany);
    }

    function test_setPaaAssets_replaceShrinksAndGrows() public {
        address a1 = address(uint160(0xAA1));
        address a2 = address(uint160(0xAA2));
        address a3 = address(uint160(0xAA3));
        address[] memory three = new address[](3);
        (three[0], three[1], three[2]) = (a1, a2, a3);
        ConfigFacet(address(diamond)).setPaaAssets(three);
        assertEq(ConfigFacet(address(diamond)).getPaaAssets().length, 3);
        address[] memory one = new address[](1);
        one[0] = a2;
        ConfigFacet(address(diamond)).setPaaAssets(one);
        address[] memory got = ConfigFacet(address(diamond)).getPaaAssets();
        assertEq(got.length, 1);
        assertEq(got[0], a2);
        address[] memory two = new address[](2);
        (two[0], two[1]) = (a1, a3);
        ConfigFacet(address(diamond)).setPaaAssets(two);
        got = ConfigFacet(address(diamond)).getPaaAssets();
        assertEq(got.length, 2);
        assertEq(got[0], a1);
        assertEq(got[1], a3);
    }

    function test_configSetters_onlyAdmin() public {
        vm.startPrank(rando);
        vm.expectRevert();
        ConfigFacet(address(diamond)).setDepthTieredLtvEnabled(true);
        vm.expectRevert();
        ConfigFacet(address(diamond)).setLiquiditySlippageBps(150);
        address[] memory empty = new address[](0);
        vm.expectRevert();
        ConfigFacet(address(diamond)).setPaaAssets(empty);
        vm.stopPrank();
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _mockFeedFull(address feed, int256 price, uint8 decimals) internal {
        vm.mockCall(feed, abi.encodeWithSignature("decimals()"), abi.encode(decimals));
        vm.mockCall(
            feed,
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(uint80(1), price, block.timestamp, block.timestamp, uint80(1))
        );
    }

    function _mockAssetPrice(address asset, uint256 price, uint8 decimals) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, asset),
            abi.encode(price, decimals)
        );
    }

    /// @dev Deterministic mock pool address per (factory, t0, t1, fee).
    function _poolAddr(address factory, address a, address b, uint24 fee) internal pure returns (address) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        return address(uint160(uint256(keccak256(abi.encode("mockPool", factory, t0, t1, fee)))));
    }

    /// @dev Wire `factory.getPool(asset, weth, fee)` ⇒ a pseudo-pool with
    ///      `sqrtPriceX96 = 2⁹⁶` and `liquidity = L`. Plants bytecode so
    ///      `pool.code.length > 0`. `observe(...)` is left unmocked ⇒ the
    ///      best-effort TWAP guard is skipped (only the value-balance
    ///      guard applies).
    function _mockPool(address factory, address asset, uint24 fee, uint128 liquidity) internal {
        _mockPoolPair(factory, asset, mockWeth, fee, liquidity);
    }

    function _mockPoolPair(
        address factory,
        address a,
        address b,
        uint24 fee,
        uint128 liquidity
    ) internal {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        address pool = _poolAddr(factory, a, b, fee);
        vm.mockCall(
            factory,
            abi.encodeWithSignature("getPool(address,address,uint24)", t0, t1, fee),
            abi.encode(pool)
        );
        vm.etch(pool, hex"6080");
        vm.mockCall(
            pool,
            abi.encodeWithSignature("slot0()"),
            abi.encode(uint160(uint256(1) << 96), int24(0), uint16(0), uint16(0), uint16(0), uint8(0), false)
        );
        vm.mockCall(pool, abi.encodeWithSignature("liquidity()"), abi.encode(liquidity));
    }

    function _mockEmptyAtAllTiers(address factory) internal {
        _mockEmptyAtAllPairsTiers(factory, mockAsset, mockWeth);
    }

    /// @dev Force `factory.getPool(a, b, fee) ⇒ address(0)` for every fee
    ///      tier the contract probes (`{100, 500, 2500, 3000, 10000}` —
    ///      a superset of both `_lookupPool`'s and the tier search's).
    function _mockEmptyAtAllPairsTiers(address factory, address a, address b) internal {
        uint24[5] memory fees = [uint24(100), uint24(500), uint24(2500), uint24(3000), uint24(10000)];
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        for (uint256 i; i < fees.length; ++i) {
            vm.mockCall(
                factory,
                abi.encodeWithSignature("getPool(address,address,uint24)", t0, t1, fees[i]),
                abi.encode(address(0))
            );
        }
    }

    /// @dev Wire a Uni-V2-clone factory: `factory.getPair(a, b)` and
    ///      `getPair(b, a)` both return a deterministic pseudo-pool
    ///      whose `getReserves()` is mocked. Reserves are mapped to
    ///      canonical token0/token1 order (ascending address) the same
    ///      way real V2 factories store them. Plants bytecode at the
    ///      pool address so the contract's `pool.code.length` check
    ///      passes.
    function _mockV2Pool(
        address factory,
        address a,
        address b,
        uint112 reserveA,
        uint112 reserveB
    ) internal {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        (uint112 r0, uint112 r1) = a < b ? (reserveA, reserveB) : (reserveB, reserveA);
        address pool = address(
            uint160(uint256(keccak256(abi.encode("mockV2Pool", factory, t0, t1))))
        );
        vm.mockCall(
            factory,
            abi.encodeWithSignature("getPair(address,address)", t0, t1),
            abi.encode(pool)
        );
        vm.mockCall(
            factory,
            abi.encodeWithSignature("getPair(address,address)", t1, t0),
            abi.encode(pool)
        );
        vm.etch(pool, hex"6080");
        vm.mockCall(
            pool,
            abi.encodeWithSignature("getReserves()"),
            abi.encode(r0, r1, uint32(0))
        );
    }
}
