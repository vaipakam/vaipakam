// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VPFIDiscountAccumulatorFacet} from "../src/facets/VPFIDiscountAccumulatorFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";

/// @title TierExplanationTest
/// @notice #3459 — the two read views an app needs to explain a fee-discount
///         tier: {VPFIDiscountFacet.getTwaConfig} (the holding rules and their
///         setter bounds) and {VPFIDiscountAccumulatorFacet.explainTier} (each
///         rule's value and which one holds the tier down). Every scenario
///         also checks that the explanation's tier is the tier
///         {VPFIDiscountFacet.getEffectiveDiscount} reports, so the view can
///         never describe a different rule from the one the fee path applies.
contract TierExplanationTest is SetupTest {
    VPFIToken internal vpfiToken;
    address internal staker;

    uint256 internal constant DUST_AMOUNT = 1 ether; // tier 0
    uint256 internal constant T1_AMOUNT = 500 ether; // tier 1
    uint256 internal constant T2_AMOUNT = 2_000 ether; // tier 2

    function setUp() public {
        // A realistic date (day 20,000): at the epoch's day 0 there are no
        // days before a holding for the look-back to wrongly include.
        vm.warp(20_000 days + 12 hours);
        setupHelper();
        VPFIToken impl = new VPFIToken();
        bytes memory initData =
            abi.encodeCall(VPFIToken.initialize, (address(this), address(this), address(this)));
        vpfiToken = VPFIToken(address(new ERC1967Proxy(address(impl), initData)));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfiToken));
        VPFIDiscountFacet(address(diamond)).setVPFIDiscountRate(1e15);
        staker = makeAddr("staker");
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    function _deposit(address user, uint256 amount) internal {
        vpfiToken.transfer(user, amount);
        vm.startPrank(user);
        IERC20(address(vpfiToken)).approve(address(diamond), amount);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(amount);
        VPFIDiscountFacet(address(diamond)).setVPFIDiscountConsent(true);
        vm.stopPrank();
    }

    function _explain(address user) internal view returns (VPFIDiscountAccumulatorFacet.TierExplanation memory) {
        return VPFIDiscountAccumulatorFacet(address(diamond)).explainTier(user);
    }

    /// @dev The explanation's tier is the applied one (consent on).
    function _assertMatchesApplied(VPFIDiscountAccumulatorFacet.TierExplanation memory e) internal view {
        (uint8 tier, uint16 bps) = VPFIDiscountFacet(address(diamond)).getEffectiveDiscount(staker);
        assertEq(e.effTier, tier, "explained tier is the applied tier");
        assertEq(e.effBps, bps, "explained bps is the applied bps");
    }

    // ─── getTwaConfig ─────────────────────────────────────────────────

    function test_TwaConfig_DefaultsAndBounds() public view {
        VPFIDiscountFacet.TwaConfig memory c = VPFIDiscountFacet(address(diamond)).getTwaConfig();
        assertEq(c.minStakedDays, LibVaipakam.DEFAULT_TWA_MIN_STAKED_DAYS);
        assertEq(c.windowDays, LibVaipakam.DEFAULT_TWA_WINDOW_DAYS);
        assertEq(c.recentDays, LibVaipakam.DEFAULT_TWA_RECENT_DAYS);
        assertEq(c.recentWeight, LibVaipakam.DEFAULT_TWA_RECENT_WEIGHT);
        assertEq(c.lookbackCapDays, 30);
        assertEq(c.minStakedDaysMin, 2);
        assertEq(c.minStakedDaysMax, 14);
        assertEq(c.windowDaysMin, 14);
        assertEq(c.windowDaysMax, 30);
        assertEq(c.recentDaysMin, 1);
        assertEq(c.recentDaysMax, 14);
        assertEq(c.recentWeightMin, 1);
        assertEq(c.recentWeightMax, 10);
    }

    function test_TwaConfig_ReadsTheSetValues() public {
        ConfigFacet(address(diamond)).setTwaMinStakedDays(5);
        ConfigFacet(address(diamond)).setTwaWindowDays(20);
        ConfigFacet(address(diamond)).setTwaRecentDays(4);
        ConfigFacet(address(diamond)).setTwaRecentWeight(2);
        VPFIDiscountFacet.TwaConfig memory c = VPFIDiscountFacet(address(diamond)).getTwaConfig();
        assertEq(c.minStakedDays, 5);
        assertEq(c.windowDays, 20);
        assertEq(c.recentDays, 4);
        assertEq(c.recentWeight, 2);
    }

    /// @dev The bounds the getter reports are exactly the setters' bounds:
    ///      each bound is accepted and one past it is refused.
    function test_TwaConfig_BoundsAreTheSetterBounds() public {
        VPFIDiscountFacet.TwaConfig memory c = VPFIDiscountFacet(address(diamond)).getTwaConfig();
        ConfigFacet cfg = ConfigFacet(address(diamond));

        cfg.setTwaMinStakedDays(c.minStakedDaysMin);
        cfg.setTwaMinStakedDays(c.minStakedDaysMax);
        vm.expectRevert(abi.encodeWithSelector(ConfigFacet.InvalidTwaMinStakedDays.selector, c.minStakedDaysMin - 1));
        cfg.setTwaMinStakedDays(c.minStakedDaysMin - 1);
        vm.expectRevert(abi.encodeWithSelector(ConfigFacet.InvalidTwaMinStakedDays.selector, c.minStakedDaysMax + 1));
        cfg.setTwaMinStakedDays(c.minStakedDaysMax + 1);

        cfg.setTwaWindowDays(c.windowDaysMin);
        cfg.setTwaWindowDays(c.windowDaysMax);
        vm.expectRevert(abi.encodeWithSelector(ConfigFacet.InvalidTwaWindowDays.selector, c.windowDaysMin - 1));
        cfg.setTwaWindowDays(c.windowDaysMin - 1);
        vm.expectRevert(abi.encodeWithSelector(ConfigFacet.InvalidTwaWindowDays.selector, c.windowDaysMax + 1));
        cfg.setTwaWindowDays(c.windowDaysMax + 1);

        cfg.setTwaRecentDays(c.recentDaysMin);
        cfg.setTwaRecentDays(c.recentDaysMax);
        vm.expectRevert(abi.encodeWithSelector(ConfigFacet.InvalidTwaRecentDays.selector, c.recentDaysMin - 1));
        cfg.setTwaRecentDays(c.recentDaysMin - 1);
        vm.expectRevert(abi.encodeWithSelector(ConfigFacet.InvalidTwaRecentDays.selector, c.recentDaysMax + 1));
        cfg.setTwaRecentDays(c.recentDaysMax + 1);

        cfg.setTwaRecentWeight(c.recentWeightMin);
        cfg.setTwaRecentWeight(c.recentWeightMax);
        vm.expectRevert(abi.encodeWithSelector(ConfigFacet.InvalidTwaRecentWeight.selector, c.recentWeightMin - 1));
        cfg.setTwaRecentWeight(c.recentWeightMin - 1);
        vm.expectRevert(abi.encodeWithSelector(ConfigFacet.InvalidTwaRecentWeight.selector, c.recentWeightMax + 1));
        cfg.setTwaRecentWeight(c.recentWeightMax + 1);
    }

    // ─── explainTier ──────────────────────────────────────────────────

    function test_Explain_NoHoldingHasNothingToHoldDown() public view {
        VPFIDiscountAccumulatorFacet.TierExplanation memory e = _explain(staker);
        assertTrue(e.canonical, "canonical chain");
        assertEq(e.countedBalance, 0);
        assertEq(e.balanceTier, 0);
        assertEq(e.stakeStartSec, 0);
        assertEq(e.effTier, 0);
        assertEq(uint8(e.heldBy), uint8(VPFIDiscountAccumulatorFacet.TierLimit.None));
        _assertMatchesApplied(e);
    }

    function test_Explain_YoungHoldingNamesTheMinimumPeriod() public {
        _deposit(staker, T1_AMOUNT);
        VPFIDiscountAccumulatorFacet.TierExplanation memory e = _explain(staker);
        assertEq(e.balanceTier, 1, "the balance alone reaches tier 1");
        assertEq(e.stakeStartSec, block.timestamp, "holding began now");
        assertEq(e.minHoldingEndsSec, block.timestamp + 3 days, "default minimum is 3 days");
        assertEq(e.rawTier, 1, "the average is already computed");
        assertEq(e.lookbackTier, 1, "the look-back is already computed");
        assertEq(e.effTier, 0, "no tier applies yet");
        assertEq(uint8(e.heldBy), uint8(VPFIDiscountAccumulatorFacet.TierLimit.HoldingTooYoung));
        _assertMatchesApplied(e);
    }

    function test_Explain_SteadyHoldingIsNotHeldDown() public {
        _deposit(staker, T1_AMOUNT);
        vm.warp(block.timestamp + 4 days + 1);
        VPFIDiscountAccumulatorFacet.TierExplanation memory e = _explain(staker);
        assertEq(e.effTier, 1);
        assertEq(e.effBps, uint16(LibVaipakam.VPFI_TIER1_DISCOUNT_BPS));
        assertEq(uint8(e.heldBy), uint8(VPFIDiscountAccumulatorFacet.TierLimit.None));
        _assertMatchesApplied(e);
    }

    function test_Explain_SameDayDustNamesTheLookback() public {
        _deposit(staker, DUST_AMOUNT);
        _deposit(staker, T1_AMOUNT);
        vm.warp(block.timestamp + 4 days + 1);
        VPFIDiscountAccumulatorFacet.TierExplanation memory e = _explain(staker);
        assertEq(e.balanceTier, 1);
        assertEq(e.rawTier, 1, "the average is tier 1");
        assertEq(e.lookbackTier, 0, "the dust day is in the look-back");
        assertEq(e.effTier, 0);
        assertEq(uint8(e.heldBy), uint8(VPFIDiscountAccumulatorFacet.TierLimit.LookbackDip));
        _assertMatchesApplied(e);
    }

    function test_Explain_RecentTopUpNamesTheAverage() public {
        _deposit(staker, T1_AMOUNT);
        vm.warp(block.timestamp + 20 days);
        _deposit(staker, T2_AMOUNT - T1_AMOUNT);
        vm.warp(block.timestamp + 1 days);
        VPFIDiscountAccumulatorFacet.TierExplanation memory e = _explain(staker);
        assertEq(e.balanceTier, 2, "the balance alone reaches tier 2");
        assertEq(e.rawTier, 1, "the average is still tier 1");
        assertEq(e.effTier, 1);
        assertEq(uint8(e.heldBy), uint8(VPFIDiscountAccumulatorFacet.TierLimit.Average));
        _assertMatchesApplied(e);
    }

    /// @dev The fee path applies nothing while consent is off; the
    ///      explanation still says what would apply with it on.
    function test_Explain_IgnoresConsent() public {
        _deposit(staker, T1_AMOUNT);
        vm.warp(block.timestamp + 4 days + 1);
        vm.prank(staker);
        VPFIDiscountFacet(address(diamond)).setVPFIDiscountConsent(false);
        (uint8 applied,) = VPFIDiscountFacet(address(diamond)).getEffectiveDiscount(staker);
        assertEq(applied, 0, "nothing applies with consent off");
        assertEq(_explain(staker).effTier, 1, "tier 1 would apply with consent on");
    }

    function test_Explain_MirrorChainSaysTheRulesRunOnTheCanonicalChain() public {
        _deposit(staker, T1_AMOUNT);
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(false);
        VPFIDiscountAccumulatorFacet.TierExplanation memory e = _explain(staker);
        assertFalse(e.canonical);
        assertEq(uint8(e.heldBy), uint8(VPFIDiscountAccumulatorFacet.TierLimit.MirrorCache));
        assertEq(e.stakeStartSec, 0, "no rule values on a mirror");
        _assertMatchesApplied(e);
    }

    /// @dev The explanation is a public read; the fee-path resolver stays
    ///      internal-only.
    function test_Explain_IsPublicWhileTheFeePathResolverIsNot() public {
        vm.prank(staker);
        _explain(staker);
        vm.prank(staker);
        vm.expectRevert(VPFIDiscountAccumulatorFacet.InternalCallerOnly.selector);
        VPFIDiscountAccumulatorFacet(address(diamond)).effectiveTierAndBps(staker);
    }
}
