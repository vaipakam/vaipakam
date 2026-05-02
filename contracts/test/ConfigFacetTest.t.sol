// test/ConfigFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {HelperTest} from "./HelperTest.sol";

/// @title ConfigFacetTest
/// @notice Exercises the admin-configurable protocol parameter surface:
///         role-gating, value caps, monotonicity invariants, the
///         zero-fallback default semantics, and the frontend bundle.
contract ConfigFacetTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address attacker;

    DiamondCutFacet cutFacet;
    AccessControlFacet accessControlFacet;
    ConfigFacet configFacet;
    HelperTest helperTest;

    // Mirror defaults declared in LibVaipakam (kept in sync with on-chain
    // constants so a drift produces an immediate test failure).
    uint256 constant DEFAULT_TREASURY_FEE_BPS = 100;
    uint256 constant DEFAULT_LOAN_INIT_FEE_BPS = 10;
    uint256 constant DEFAULT_LIQ_HANDLING_FEE_BPS = 200;
    uint256 constant DEFAULT_MAX_SLIPPAGE_BPS = 600;
    uint256 constant DEFAULT_MAX_INCENTIVE_BPS = 300;
    uint256 constant DEFAULT_VOL_LTV_BPS = 11_000;
    uint256 constant DEFAULT_RENTAL_BUFFER_BPS = 500;
    uint256 constant DEFAULT_STAKING_APR_BPS = 500;

    function setUp() public {
        owner = address(this);
        attacker = makeAddr("attacker");

        cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));
        accessControlFacet = new AccessControlFacet();
        configFacet = new ConfigFacet();
        helperTest = new HelperTest();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(accessControlFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAccessControlFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(configFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getConfigFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();
    }

    // ─── Defaults (zero-fallback semantics) ──────────────────────────────

    function testDefaultsBeforeAnySetter() public view {
        (uint256 tFee, uint256 lFee) = ConfigFacet(address(diamond)).getFeesConfig();
        assertEq(tFee, DEFAULT_TREASURY_FEE_BPS, "treasury default");
        assertEq(lFee, DEFAULT_LOAN_INIT_FEE_BPS, "loan init default");

        (uint256 h, uint256 sl, uint256 inc) =
            ConfigFacet(address(diamond)).getLiquidationConfig();
        assertEq(h, DEFAULT_LIQ_HANDLING_FEE_BPS);
        assertEq(sl, DEFAULT_MAX_SLIPPAGE_BPS);
        assertEq(inc, DEFAULT_MAX_INCENTIVE_BPS);

        (uint256 vltv, uint256 rb) = ConfigFacet(address(diamond)).getRiskConfig();
        assertEq(vltv, DEFAULT_VOL_LTV_BPS);
        assertEq(rb, DEFAULT_RENTAL_BUFFER_BPS);

        assertEq(
            ConfigFacet(address(diamond)).getStakingAprBps(),
            DEFAULT_STAKING_APR_BPS
        );

        (uint256 a, uint256 b, uint256 c, uint256 d) =
            ConfigFacet(address(diamond)).getVpfiTierThresholds();
        assertEq(a, LibVaipakam.VPFI_TIER1_MIN);
        assertEq(b, LibVaipakam.VPFI_TIER2_MIN);
        assertEq(c, LibVaipakam.VPFI_TIER3_MIN);
        assertEq(d, LibVaipakam.VPFI_TIER4_THRESHOLD);

        (uint256 d1, uint256 d2, uint256 d3, uint256 d4) =
            ConfigFacet(address(diamond)).getVpfiTierDiscountBps();
        assertEq(d1, LibVaipakam.VPFI_TIER1_DISCOUNT_BPS);
        assertEq(d2, LibVaipakam.VPFI_TIER2_DISCOUNT_BPS);
        assertEq(d3, LibVaipakam.VPFI_TIER3_DISCOUNT_BPS);
        assertEq(d4, LibVaipakam.VPFI_TIER4_DISCOUNT_BPS);
    }

    // ─── setFeesConfig ───────────────────────────────────────────────────

    function testSetFeesConfigUpdatesEffectiveValues() public {
        ConfigFacet(address(diamond)).setFeesConfig(250, 50);
        (uint256 t, uint256 l) = ConfigFacet(address(diamond)).getFeesConfig();
        assertEq(t, 250);
        assertEq(l, 50);
    }

    function testSetFeesConfigZeroResetsToDefault() public {
        ConfigFacet(address(diamond)).setFeesConfig(250, 50);
        ConfigFacet(address(diamond)).setFeesConfig(0, 0);
        (uint256 t, uint256 l) = ConfigFacet(address(diamond)).getFeesConfig();
        assertEq(t, DEFAULT_TREASURY_FEE_BPS);
        assertEq(l, DEFAULT_LOAN_INIT_FEE_BPS);
    }

    function testSetFeesConfigRevertsAboveFeeCap() public {
        vm.expectRevert(
            abi.encodeWithSelector(ConfigFacet.InvalidFeeBps.selector, 5001, 5000)
        );
        ConfigFacet(address(diamond)).setFeesConfig(5001, 0);

        vm.expectRevert(
            abi.encodeWithSelector(ConfigFacet.InvalidFeeBps.selector, 5001, 5000)
        );
        ConfigFacet(address(diamond)).setFeesConfig(0, 5001);
    }

    function testSetFeesConfigRevertsNonAdmin() public {
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibAccessControl.AccessControlUnauthorizedAccount.selector,
                attacker,
                LibAccessControl.ADMIN_ROLE
            )
        );
        ConfigFacet(address(diamond)).setFeesConfig(100, 10);
    }

    // ─── setLiquidationConfig ────────────────────────────────────────────

    function testSetLiquidationConfigUpdatesEffectiveValues() public {
        ConfigFacet(address(diamond)).setLiquidationConfig(150, 800, 250);
        (uint256 h, uint256 sl, uint256 inc) =
            ConfigFacet(address(diamond)).getLiquidationConfig();
        assertEq(h, 150);
        assertEq(sl, 800);
        assertEq(inc, 250);
    }

    function testSetLiquidationConfigRevertsAboveSlippageCap() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.InvalidSlippageBps.selector,
                2501,
                2500
            )
        );
        ConfigFacet(address(diamond)).setLiquidationConfig(0, 2501, 0);
    }

    function testSetLiquidationConfigRevertsAboveIncentiveCap() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.InvalidIncentiveBps.selector,
                2001,
                2000
            )
        );
        ConfigFacet(address(diamond)).setLiquidationConfig(0, 0, 2001);
    }

    function testSetLiquidationConfigRevertsNonAdmin() public {
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibAccessControl.AccessControlUnauthorizedAccount.selector,
                attacker,
                LibAccessControl.ADMIN_ROLE
            )
        );
        ConfigFacet(address(diamond)).setLiquidationConfig(100, 600, 300);
    }

    // ─── setRiskConfig ───────────────────────────────────────────────────

    function testSetRiskConfigUpdatesEffectiveValues() public {
        ConfigFacet(address(diamond)).setRiskConfig(12_000, 600);
        (uint256 v, uint256 rb) = ConfigFacet(address(diamond)).getRiskConfig();
        assertEq(v, 12_000);
        assertEq(rb, 600);
    }

    function testSetRiskConfigRevertsVolatilityAtOrBelowBasisPoints() public {
        // 10_000 BPS (== 100% LTV) would fire fallback on every healthy
        // loan — must be strictly greater than BASIS_POINTS.
        vm.expectRevert(
            abi.encodeWithSelector(ConfigFacet.InvalidVolatilityLtvBps.selector, 10_000)
        );
        ConfigFacet(address(diamond)).setRiskConfig(10_000, 0);
    }

    function testSetRiskConfigZeroBypassesVolatilityFloor() public {
        // Explicit zero resets to default (skip the > BASIS_POINTS check).
        ConfigFacet(address(diamond)).setRiskConfig(0, 0);
        (uint256 v,) = ConfigFacet(address(diamond)).getRiskConfig();
        assertEq(v, DEFAULT_VOL_LTV_BPS);
    }

    function testSetRiskConfigRevertsRentalAboveCap() public {
        vm.expectRevert(
            abi.encodeWithSelector(ConfigFacet.InvalidRentalBufferBps.selector, 5001)
        );
        ConfigFacet(address(diamond)).setRiskConfig(11_000, 5001);
    }

    // ─── setStakingApr ───────────────────────────────────────────────────

    function testSetStakingAprUpdatesEffectiveValue() public {
        ConfigFacet(address(diamond)).setStakingApr(750);
        assertEq(ConfigFacet(address(diamond)).getStakingAprBps(), 750);
    }

    function testSetStakingAprRevertsAboveCap() public {
        // T-033 setter range audit: tightened from `≤ BASIS_POINTS`
        // (100% APR) to `≤ STAKING_APR_BPS_MAX` (20% APR). Setter now
        // surfaces `ParameterOutOfRange` instead of the legacy
        // `InvalidStakingAprBps`.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector,
                bytes32("stakingAprBps"),
                uint256(10_001),
                uint256(0),
                uint256(LibVaipakam.STAKING_APR_BPS_MAX)
            )
        );
        ConfigFacet(address(diamond)).setStakingApr(10_001);
    }

    function testSetStakingAprZeroResetsToDefault() public {
        ConfigFacet(address(diamond)).setStakingApr(750);
        ConfigFacet(address(diamond)).setStakingApr(0);
        assertEq(
            ConfigFacet(address(diamond)).getStakingAprBps(),
            DEFAULT_STAKING_APR_BPS
        );
    }

    // ─── setVpfiTierThresholds ───────────────────────────────────────────

    function testSetVpfiTierThresholdsUpdatesEffectiveValues() public {
        ConfigFacet(address(diamond)).setVpfiTierThresholds(
            200e18, 2_000e18, 10_000e18, 40_000e18
        );
        (uint256 a, uint256 b, uint256 c, uint256 d) =
            ConfigFacet(address(diamond)).getVpfiTierThresholds();
        assertEq(a, 200e18);
        assertEq(b, 2_000e18);
        assertEq(c, 10_000e18);
        assertEq(d, 40_000e18);
    }

    function testSetVpfiTierThresholdsRevertsNonMonotone() public {
        // e1 >= e2 → reverts (e1=200e18, e2=100e18)
        vm.expectRevert();
        ConfigFacet(address(diamond)).setVpfiTierThresholds(
            200e18, 100e18, 10_000e18, 40_000e18
        );
    }

    function testSetVpfiTierThresholdsMixedZeroAndOverrideValidatesEffective() public {
        // t1 = 0 (falls back to 100e18 default), t2 = 50e18 override
        // → effective (100e18, 50e18, ...) violates e1 < e2 → revert.
        vm.expectRevert();
        ConfigFacet(address(diamond)).setVpfiTierThresholds(
            0, 50e18, 10_000e18, 40_000e18
        );
    }

    function testSetVpfiTierThresholdsAllowsT3EqualT4() public {
        // Spec: e3 <= e4 (T3 can equal T4 — means T4 is empty band).
        ConfigFacet(address(diamond)).setVpfiTierThresholds(
            100e18, 1_000e18, 5_000e18, 5_000e18
        );
        (,, uint256 c, uint256 d) =
            ConfigFacet(address(diamond)).getVpfiTierThresholds();
        assertEq(c, 5_000e18);
        assertEq(d, 5_000e18);
    }

    // ─── setVpfiTierDiscountBps ──────────────────────────────────────────

    function testSetVpfiTierDiscountBpsUpdatesEffectiveValues() public {
        ConfigFacet(address(diamond)).setVpfiTierDiscountBps(
            1100, 1600, 2100, 2500
        );
        (uint256 d1, uint256 d2, uint256 d3, uint256 d4) =
            ConfigFacet(address(diamond)).getVpfiTierDiscountBps();
        assertEq(d1, 1100);
        assertEq(d2, 1600);
        assertEq(d3, 2100);
        assertEq(d4, 2500);
    }

    function testSetVpfiTierDiscountBpsRevertsAboveDiscountCap() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.DiscountBpsTooHigh.selector,
                9001,
                9000
            )
        );
        ConfigFacet(address(diamond)).setVpfiTierDiscountBps(9001, 0, 0, 0);
    }

    function testSetVpfiTierDiscountBpsRevertsNonMonotone() public {
        // Effective: (1100, 900, ...) — lower-balance tier has higher BPS.
        vm.expectRevert();
        ConfigFacet(address(diamond)).setVpfiTierDiscountBps(
            1100, 900, 2000, 2400
        );
    }

    function testSetVpfiTierDiscountBpsAllowsEqualAdjacent() public {
        // Non-decreasing is allowed (equal tiers fine — no tier bump).
        ConfigFacet(address(diamond)).setVpfiTierDiscountBps(
            1500, 1500, 2000, 2400
        );
        (uint256 d1, uint256 d2,,) =
            ConfigFacet(address(diamond)).getVpfiTierDiscountBps();
        assertEq(d1, 1500);
        assertEq(d2, 1500);
    }

    // ─── Bundle getter ───────────────────────────────────────────────────

    function testGetProtocolConfigBundleReturnsEffectiveValues() public {
        ConfigFacet(address(diamond)).setFeesConfig(150, 20);
        ConfigFacet(address(diamond)).setStakingApr(800);

        (
            uint256 tFee,
            uint256 lFee,
            uint256 h,
            uint256 sl,
            uint256 inc,
            uint256 vltv,
            uint256 rb,
            uint256 apr,
            uint256[4] memory tiers,
            uint256[4] memory disc,
            // Range Orders Phase 1 master kill-switch flags. All 3
            // default `false` on a fresh deploy.
            bool rangeAmount,
            bool rangeRate,
            bool partialFill,
            // Matcher kickback BPS — defaults to LIF_MATCHER_FEE_BPS
            // (100 = 1%) when unset; governance-tunable via
            // setLifMatcherFeeBps.
            uint256 matcherFeeBps,
            // Auto-pause window duration (seconds). Defaults to
            // AUTO_PAUSE_DURATION_DEFAULT (1800 = 30 min);
            // governance-tunable via setAutoPauseDurationSeconds.
            uint256 autoPauseDur,
            // Max offer duration in days. Defaults to
            // MAX_OFFER_DURATION_DAYS_DEFAULT (365 = 1 year);
            // governance-tunable via setMaxOfferDurationDays.
            uint256 maxDur
        ) = ConfigFacet(address(diamond)).getProtocolConfigBundle();

        // Overridden:
        assertEq(tFee, 150);
        assertEq(lFee, 20);
        assertEq(apr, 800);
        // Untouched — resolve to defaults:
        assertEq(h, DEFAULT_LIQ_HANDLING_FEE_BPS);
        assertEq(sl, DEFAULT_MAX_SLIPPAGE_BPS);
        assertEq(inc, DEFAULT_MAX_INCENTIVE_BPS);
        assertEq(vltv, DEFAULT_VOL_LTV_BPS);
        assertEq(rb, DEFAULT_RENTAL_BUFFER_BPS);
        assertEq(tiers[0], LibVaipakam.VPFI_TIER1_MIN);
        assertEq(tiers[3], LibVaipakam.VPFI_TIER4_THRESHOLD);
        assertEq(disc[0], LibVaipakam.VPFI_TIER1_DISCOUNT_BPS);
        assertEq(disc[3], LibVaipakam.VPFI_TIER4_DISCOUNT_BPS);
        // Master flags: default off on a fresh deploy.
        assertFalse(rangeAmount);
        assertFalse(rangeRate);
        assertFalse(partialFill);
        // Max offer duration default — 365 days unless governance has tuned.
        assertEq(maxDur, LibVaipakam.MAX_OFFER_DURATION_DAYS_DEFAULT);
    }

    /// @dev `getProtocolConstants` returns the four compile-time constants
    ///      surfaced in user-facing copy. Pure view — values can never
    ///      drift away from {LibVaipakam}'s constant declarations
    ///      because there's no setter pair. Mirrors the existing
    ///      `getProtocolConfigBundle` test pattern.
    function testGetProtocolConstantsMatchesLibrary() public view {
        (
            uint256 minHf,
            uint256 stakingCap,
            uint256 interactionCap,
            uint256 maxClaimDays
        ) = ConfigFacet(address(diamond)).getProtocolConstants();
        assertEq(minHf, LibVaipakam.MIN_HEALTH_FACTOR);
        assertEq(stakingCap, LibVaipakam.VPFI_STAKING_POOL_CAP);
        assertEq(interactionCap, LibVaipakam.VPFI_INTERACTION_POOL_CAP);
        assertEq(maxClaimDays, LibVaipakam.MAX_INTERACTION_CLAIM_DAYS);
    }
}
