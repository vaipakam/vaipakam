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
import {HelperTest} from "./HelperTest.sol";

/// @title GovernanceConfigTest
/// @notice Targeted coverage for the Phase-1 governance-config additions:
///         fallback-split storage + setter + bounds, the zero-fallback
///         default semantics for the two new fields, and the bundle
///         returned by `getFallbackSplit`. The bigger tests — rollup
///         accumulator, loan-init snapshot, yield-fee time-weighted
///         path — live alongside their respective facets' test suites so
///         the full-stack flow can drive them.
contract GovernanceConfigTest is Test {
    VaipakamDiamond diamond;
    ConfigFacet configFacet;
    AccessControlFacet accessControlFacet;
    DiamondCutFacet cutFacet;
    HelperTest helperTest;
    address owner;
    address attacker;

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

    function testFallbackSplitDefaultsBeforeSet() public view {
        (uint256 lenderBonus, uint256 treasury) =
            ConfigFacet(address(diamond)).getFallbackSplit();
        // Defaults mirror LibVaipakam.FALLBACK_LENDER_BONUS_BPS / TREASURY_BPS.
        assertEq(lenderBonus, 300, "default lender bonus");
        assertEq(treasury, 200, "default treasury");
    }

    // ─── Access control ──────────────────────────────────────────────────

    function testSetFallbackSplitRevertsForNonAdmin() public {
        vm.prank(attacker);
        vm.expectRevert();
        ConfigFacet(address(diamond)).setFallbackSplit(250, 150);
    }

    function testSetFallbackSplitSucceedsForAdmin() public {
        ConfigFacet(address(diamond)).setFallbackSplit(250, 150);
        (uint256 lenderBonus, uint256 treasury) =
            ConfigFacet(address(diamond)).getFallbackSplit();
        assertEq(lenderBonus, 250, "lender bonus set");
        assertEq(treasury, 150, "treasury set");
    }

    function testSetFallbackSplitZeroRestoresDefault() public {
        // First push to non-default, then zero each field in separate calls.
        ConfigFacet(address(diamond)).setFallbackSplit(500, 400);
        ConfigFacet(address(diamond)).setFallbackSplit(0, 0);

        (uint256 lenderBonus, uint256 treasury) =
            ConfigFacet(address(diamond)).getFallbackSplit();
        assertEq(lenderBonus, 300, "lender bonus reset");
        assertEq(treasury, 200, "treasury reset");
    }

    // ─── Per-party cap (MAX_FALLBACK_BPS = 1000) ─────────────────────────

    function testSetFallbackSplitRevertsWhenLenderBonusExceedsCap() public {
        // 1001 > 10%
        vm.expectRevert();
        ConfigFacet(address(diamond)).setFallbackSplit(1001, 100);
    }

    function testSetFallbackSplitRevertsWhenTreasuryExceedsCap() public {
        vm.expectRevert();
        ConfigFacet(address(diamond)).setFallbackSplit(100, 1001);
    }

    function testSetFallbackSplitAcceptsPerPartyCapBoundary() public {
        // Exactly at per-party cap should succeed for each leg if combined
        // stays under MAX_FALLBACK_COMBINED_BPS (1500). 1000 + 499 = 1499.
        ConfigFacet(address(diamond)).setFallbackSplit(1000, 499);
        (uint256 lenderBonus, uint256 treasury) =
            ConfigFacet(address(diamond)).getFallbackSplit();
        assertEq(lenderBonus, 1000);
        assertEq(treasury, 499);
    }

    // ─── Combined cap (MAX_FALLBACK_COMBINED_BPS = 1500) ─────────────────

    function testSetFallbackSplitRevertsWhenCombinedExceedsCap() public {
        // 900 + 700 = 1600 > 1500 cap, but each leg ≤ 1000.
        vm.expectRevert();
        ConfigFacet(address(diamond)).setFallbackSplit(900, 700);
    }

    function testSetFallbackSplitAcceptsCombinedBoundary() public {
        // 900 + 600 = 1500 — right at cap, should succeed.
        ConfigFacet(address(diamond)).setFallbackSplit(900, 600);
        (uint256 lenderBonus, uint256 treasury) =
            ConfigFacet(address(diamond)).getFallbackSplit();
        assertEq(lenderBonus, 900);
        assertEq(treasury, 600);
    }

    function testSetFallbackSplitRejectsCombinedOverflowEvenWithOneZero() public {
        // Zero resolves to the default (300 / 200), so `(0, 1400)`
        // effectively asks for `300 + 1400 = 1700` > cap.
        vm.expectRevert();
        ConfigFacet(address(diamond)).setFallbackSplit(0, 1400);
    }

    // ─── Event emission ──────────────────────────────────────────────────

    function testSetFallbackSplitEmitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit ConfigFacet.FallbackSplitSet(350, 200);
        ConfigFacet(address(diamond)).setFallbackSplit(350, 200);
    }
}
