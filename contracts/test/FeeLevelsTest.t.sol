// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {FeeLevelsFacet} from "../src/facets/FeeLevelsFacet.sol";
import {HelperTest} from "./HelperTest.sol";
import {ArtifactDeploy} from "../script/lib/ArtifactDeploy.sol";

/// @title FeeLevelsTest
/// @notice #3649 — the initiation fee by term: the rate at the points
///         `FeeLevelsDesign.md` section 7 names, the absence of a step at the
///         base term and the one-year point, the bounded term settings, and
///         the base-rate setter's new bound against the yearly rate.
contract FeeLevelsTest is Test {
    VaipakamDiamond diamond;
    FeeLevelsFacet fees;
    ConfigFacet config;
    address attacker = makeAddr("attacker");

    uint256 constant P = 10_000e18;

    function setUp() public {
        DiamondCutFacet cutFacet = DiamondCutFacet(ArtifactDeploy.deploy(type(DiamondCutFacet).name));
        diamond = new VaipakamDiamond(address(this), address(cutFacet));
        HelperTest h = new HelperTest();
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](3);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(AccessControlFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: h.getAccessControlFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(ConfigFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: h.getConfigFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(FeeLevelsFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: h.getFeeLevelsFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();
        // Diamond born paused (LibPausable); clear it directly.
        vm.store(
            address(diamond),
            bytes32(uint256(0x2160e84a745d8897ad2778886d40d3563c8bc30c059c5f2173e21e9d47057400)),
            bytes32(0)
        );
        fees = FeeLevelsFacet(address(diamond));
        config = ConfigFacet(address(diamond));
    }

    function _fee(uint256 termDays) internal view returns (uint256 f) {
        (f,,) = fees.quoteLoanInitiationFee(P, termDays);
    }

    // ── Defaults ─────────────────────────────────────────────────────────

    function test_defaults() public view {
        (uint256 b, uint256 t0, uint256 y, uint256 d) = fees.getLoanInitiationFeeTerms();
        assertEq(b, 20);
        assertEq(t0, 30);
        assertEq(y, 50);
        assertEq(d, 365);
        (uint256 tFee,) = config.getFeesConfig();
        assertEq(tFee, 500, "interest share default is 5%");
    }

    // ── The rate at the design's points ──────────────────────────────────

    function test_rateAtDesignPoints() public view {
        // 0.2% up to 30 days.
        assertEq(_fee(1), 20e18);
        assertEq(_fee(30), 20e18);
        // Straight line from 0.2% at 30 days to 0.5% at 365 days.
        assertEq(_fee(31), (P * (20 * 334 + 50 * 1)) / (335 * 10_000));
        assertEq(_fee(197), (P * (20 * 168 + 50 * 167)) / (335 * 10_000));
        assertEq(_fee(365), 50e18);
        // 0.5% a year, in proportion to the days, beyond one year.
        assertEq(_fee(366), (P * 50 * 366) / (365 * 10_000));
        assertEq(_fee(548), (P * 50 * 548) / (365 * 10_000));
        assertEq(_fee(730), 100e18);
    }

    function test_quotedRatesBracketTheExactRate() public view {
        (, uint256 down, uint256 up) = fees.quoteLoanInitiationFee(P, 197);
        assertEq(down, 34); // 11710 / 335 = 34.955…
        assertEq(up, 35);
        (, down, up) = fees.quoteLoanInitiationFee(P, 730);
        assertEq(down, 100);
        assertEq(up, 100);
    }

    /// The rate never falls as the term grows, and there is no step at the
    /// base term or the one-year point: one more day adds at most one day's
    /// share of the steepest slope.
    function test_noStepAndNonDecreasing() public view {
        uint256 prev = _fee(1);
        // Steepest per-day rise: the slope between 30 and 365 days
        // ((50 - 20) / 335 bps a day) is below the yearly slope (50 / 365).
        uint256 maxStep = (P * 50) / (365 * 10_000) + 1;
        for (uint256 t = 2; t <= 800; ++t) {
            uint256 f = _fee(t);
            assertGe(f, prev, "non-decreasing");
            assertLe(f - prev, maxStep, "no step");
            prev = f;
        }
    }

    /// Twelve 30-day loans pay more than one 365-day loan: chaining short
    /// loans does not avoid the fee.
    function test_chainingShortLoansCostsMore() public view {
        assertGt(12 * _fee(30), _fee(365));
    }

    // ── Settings ─────────────────────────────────────────────────────────

    function test_setTermsAndRestoreDefaults() public {
        fees.setLoanInitiationFeeTerms(60, 80, 300);
        (, uint256 t0, uint256 y, uint256 d) = fees.getLoanInitiationFeeTerms();
        assertEq(t0, 60);
        assertEq(y, 80);
        assertEq(d, 300);
        assertEq(_fee(60), 20e18);
        assertEq(_fee(300), 80e18);
        fees.setLoanInitiationFeeTerms(0, 0, 0);
        (, t0, y, d) = fees.getLoanInitiationFeeTerms();
        assertEq(t0, 30);
        assertEq(y, 50);
        assertEq(d, 365);
    }

    function test_setTermsIsAdminOnly() public {
        vm.prank(attacker);
        vm.expectRevert();
        fees.setLoanInitiationFeeTerms(30, 50, 365);
    }

    function test_setTermsBounds() public {
        _expectBad(91, 50, 365); // base term above 90 days
        _expectBad(30, 50, 179); // one-year point below 180 days
        _expectBad(30, 50, 731); // one-year point above 730 days
        _expectBad(30, 19, 365); // yearly rate below the base rate (0.2%)
        // The longest admissible term may not cost more than the 50% ceiling:
        // y * 4385 <= 5000 * d. At d = 365: y <= 416.
        fees.setLoanInitiationFeeTerms(30, 416, 365);
        _expectBad(30, 417, 365);
        assertLe(_fee(4385), P / 2);
    }

    function test_baseRateMayNotPassTheYearlyRate() public {
        config.setFeesConfig(500, 50); // equal is allowed
        vm.expectRevert(abi.encodeWithSelector(ConfigFacet.InvalidFeeBps.selector, 51, 50));
        config.setFeesConfig(500, 51);
    }

    function _expectBad(uint16 t0, uint16 y, uint16 d) internal {
        vm.expectRevert(
            abi.encodeWithSelector(FeeLevelsFacet.InvalidLoanInitiationFeeTerms.selector, uint256(t0), uint256(y), uint256(d))
        );
        fees.setLoanInitiationFeeTerms(t0, y, d);
    }
}
