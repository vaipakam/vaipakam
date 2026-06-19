// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IRateModel} from "../src/interfaces/IRateModel.sol";
import {
    RiskPremiumRateModel,
    ILiquidityTierSource
} from "../src/models/RiskPremiumRateModel.sol";

/// @notice A configurable {ILiquidityTierSource} stand-in for the Diamond.
contract MockTierSource is ILiquidityTierSource {
    uint8 public tier;
    bool public shouldRevert;

    function setTier(uint8 t) external { tier = t; }
    function setRevert(bool r) external { shouldRevert = r; }

    function getEffectiveLiquidityTier(address) external view returns (uint8) {
        require(!shouldRevert, "tier source down");
        return tier;
    }
}

/// @title RiskPremiumRateModelTest
/// @notice #394 Lever B — the dual-factor risk-premium {IRateModel}. Asserts
///         the additive quote (reference + collateral-tier premium + tenor
///         premium), the defensive tier read (fails to the most conservative
///         tier), the hard-bounded governance setters, and the constructor
///         guards. The deviation-clamp interplay with #400's resolver is
///         covered in `RateModelTest` (the resolver harness).
contract RiskPremiumRateModelTest is Test {
    RiskPremiumRateModel internal model;
    MockTierSource internal tiers;

    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");
    address internal collateral = makeAddr("collateral");

    // Tier premiums: tier0 (illiquid) highest … tier3 (deepest) lowest.
    function _initialTiers() internal pure returns (uint16[4] memory tp) {
        tp = [uint16(800), uint16(500), uint16(300), uint16(100)];
    }

    function setUp() public {
        tiers = new MockTierSource();
        model = new RiskPremiumRateModel(
            owner,
            address(tiers),
            _initialTiers(),
            1_000, // tenor premium 10%/yr
            2_000  // tenor cap 20%
        );
    }

    function _input(uint256 refBps, uint256 durationDays)
        internal
        returns (IRateModel.RateModelInput memory)
    {
        return IRateModel.RateModelInput({
            creator: address(this),
            offerType: 0,
            lendingAsset: makeAddr("lending"),
            collateralAsset: collateral,
            amount: 1_000 ether,
            collateralAmount: 1_800 ether,
            durationDays: durationDays,
            referenceRateBps: refBps
        });
    }

    // ── Constructor guards ──────────────────────────────────────────────────

    function test_constructor_revertsZeroDiamond() public {
        vm.expectRevert(RiskPremiumRateModel.ZeroDiamond.selector);
        new RiskPremiumRateModel(owner, address(0), _initialTiers(), 1_000, 2_000);
    }

    function test_constructor_revertsTierPremiumOutOfRange() public {
        uint16[4] memory bad = [uint16(2_001), uint16(0), uint16(0), uint16(0)]; // > MAX 2000
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskPremiumRateModel.PremiumOutOfRange.selector,
                uint16(2_001),
                uint16(2_000)
            )
        );
        new RiskPremiumRateModel(owner, address(tiers), bad, 1_000, 2_000);
    }

    function test_constructor_revertsTenorPerYearOutOfRange() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskPremiumRateModel.PremiumOutOfRange.selector,
                uint16(1_001),
                uint16(1_000)
            )
        );
        new RiskPremiumRateModel(owner, address(tiers), _initialTiers(), 1_001, 2_000);
    }

    // ── Quote — dual factor ──────────────────────────────────────────────────

    /// @dev tier 2 ⇒ tierPremium 300; durationDays 30, 10%/yr ⇒
    ///      30 × 1000 / 365 = 82 (integer floor). quote = ref + 300 + 82.
    function test_quote_tierPlusTenor() public {
        tiers.setTier(2);
        uint256 q = model.quoteRateBps(_input(500, 30));
        assertEq(q, 500 + 300 + 82, "ref + tier-2 premium + pro-rata tenor");
    }

    /// @dev tier 3 (deepest) ⇒ lowest premium 100; zero duration ⇒ no tenor.
    function test_quote_deepestTierNoTenor() public {
        tiers.setTier(3);
        uint256 q = model.quoteRateBps(_input(500, 0));
        assertEq(q, 600, "ref + tier-3 premium only");
    }

    /// @dev Tenor premium is capped: 365d × 10%/yr = 1000, but cap is 500.
    function test_quote_tenorCapBinds() public {
        // Tighten the cap to 500 to make it bind.
        vm.prank(owner);
        model.setTenorPremium(1_000, 500);
        tiers.setTier(3); // tierPremium 100
        uint256 q = model.quoteRateBps(_input(500, 365));
        assertEq(q, 500 + 100 + 500, "tenor premium clamped to the 500-bps cap");
    }

    /// @dev Defensive tier read: a reverting Diamond resolves to tier 0 — the
    ///      MOST conservative (highest) premium. Fails expensive, never cheap.
    function test_quote_tierSourceRevert_fallsToTier0() public {
        tiers.setTier(3);        // would be cheap …
        tiers.setRevert(true);   // … but the read reverts → tier 0 (800)
        uint256 q = model.quoteRateBps(_input(500, 0));
        assertEq(q, 500 + 800, "reverting tier source -> conservative tier-0 premium");
    }

    /// @dev An out-of-range tier byte (>3) also resolves to tier 0.
    function test_quote_outOfRangeTier_fallsToTier0() public {
        tiers.setTier(7);
        uint256 q = model.quoteRateBps(_input(500, 0));
        assertEq(q, 500 + 800, "tier > 3 -> conservative tier-0 premium");
    }

    // ── Governance setters ───────────────────────────────────────────────────

    function test_setTierPremium_accessBoundsAndEffect() public {
        // non-owner rejected
        vm.prank(stranger);
        vm.expectRevert();
        model.setTierPremiumBps(1, 400);

        // tier index out of range
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(RiskPremiumRateModel.TierOutOfRange.selector, uint8(4))
        );
        model.setTierPremiumBps(4, 400);

        // premium out of range
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskPremiumRateModel.PremiumOutOfRange.selector,
                uint16(2_001),
                uint16(2_000)
            )
        );
        model.setTierPremiumBps(1, 2_001);

        // valid retune + effect
        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(model));
        emit RiskPremiumRateModel.TierPremiumSet(1, 450);
        model.setTierPremiumBps(1, 450);

        tiers.setTier(1);
        assertEq(model.quoteRateBps(_input(500, 0)), 950, "retuned tier-1 premium applied");
        assertEq(model.getTierPremiums()[1], 450, "view reflects retune");
    }

    function test_setTenorPremium_accessAndBounds() public {
        vm.prank(stranger);
        vm.expectRevert();
        model.setTenorPremium(500, 1_000);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskPremiumRateModel.PremiumOutOfRange.selector,
                uint16(2_001),
                uint16(2_000)
            )
        );
        model.setTenorPremium(500, 2_001); // cap over MAX_TENOR_PREMIUM_CAP_BPS

        vm.prank(owner);
        model.setTenorPremium(800, 1_500);
        assertEq(model.tenorPremiumPerYearBps(), 800);
        assertEq(model.maxTenorPremiumBps(), 1_500);
    }
}
