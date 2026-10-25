// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {NumeraireConfigFacet} from "../src/facets/NumeraireConfigFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibMetricsTypes} from "../src/libraries/LibMetricsTypes.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title  LenderIntentAdmissionTest
 * @notice #2760 item 2 — a standing intent is admitted only when both legs are
 *         priced by the shared value rule and its smallest fill is worth at
 *         least the governance floor (default 100 numeraire units). Without it,
 *         a junk-token intent holding one unit entered the keeper feed.
 *         `mockERC20` / `mockCollateralERC20` are priced at $1 in SetupTest.
 */
contract LenderIntentAdmissionTest is SetupTest {
    address internal user;

    uint256 internal constant MAX_EXPOSURE = 100_000 ether;
    uint256 internal constant MIN_RATE_BPS = 300;
    uint16 internal constant MAX_INIT_LTV_BPS = 6600;
    uint32 internal constant MAX_DURATION_DAYS = 90;

    function setUp() public {
        setupHelper();
        user = makeAddr("intentLender");
    }

    function _set(address lendAsset, address collAsset, uint256 minFill) internal {
        vm.prank(user);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            lendAsset, collAsset, MAX_EXPOSURE, MIN_RATE_BPS, MAX_INIT_LTV_BPS,
            MAX_DURATION_DAYS, minFill, false, true
        );
    }

    function _expectBelow(uint256 value, uint256 minimum) internal {
        vm.expectRevert(
            abi.encodeWithSelector(LenderIntentFacet.LenderIntentFillBelowMinimum.selector, value, minimum)
        );
    }

    // ─── The floor ──────────────────────────────────────────────────────────

    function test_defaultFloor_is100Numeraire() public view {
        assertEq(LenderIntentFacet(address(diamond)).getMinIntentFillNumeraire(), 100e18);
        assertEq(LibVaipakam.MIN_INTENT_FILL_NUMERAIRE_DEFAULT, 100e18);
    }

    function test_minFillAtTheFloor_isAdmitted() public {
        _set(mockERC20, mockCollateralERC20, 100 ether); // $100 at $1
        assertTrue(
            LenderIntentFacet(address(diamond)).getLenderIntent(user, mockERC20, mockCollateralERC20).active,
            "admitted at exactly the floor"
        );
    }

    function test_minFillBelowTheFloor_reverts() public {
        _expectBelow(100e18 - 1, 100e18);
        _set(mockERC20, mockCollateralERC20, 100 ether - 1);
    }

    /// The junk shape the scanner found: a one-unit minimum fill.
    function test_oneUnitMinFill_reverts() public {
        // 1 wei of an 18-decimal $1 token values to 1 numeraire wei.
        _expectBelow(1, 100e18);
        _set(mockERC20, mockCollateralERC20, 1);
    }

    function test_floorFollowsGovernance() public {
        vm.prank(owner);
        LenderIntentFacet(address(diamond)).setMinIntentFillNumeraire(5e18);
        assertEq(LenderIntentFacet(address(diamond)).getMinIntentFillNumeraire(), 5e18);
        _set(mockERC20, mockCollateralERC20, 5 ether); // now admitted

        // Zero restores the default.
        vm.prank(owner);
        LenderIntentFacet(address(diamond)).setMinIntentFillNumeraire(0);
        assertEq(LenderIntentFacet(address(diamond)).getMinIntentFillNumeraire(), 100e18);
    }

    function test_setFloor_emitsEffectiveValue() public {
        vm.expectEmit(address(diamond));
        emit LenderIntentFacet.MinIntentFillNumeraireSet(100e18);
        vm.prank(owner);
        LenderIntentFacet(address(diamond)).setMinIntentFillNumeraire(0);
    }

    function test_setFloor_isBounded() public {
        vm.startPrank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector,
                bytes32("minIntentFillNumeraire"),
                1e18 - 1,
                1e18,
                1_000_000e18
            )
        );
        LenderIntentFacet(address(diamond)).setMinIntentFillNumeraire(1e18 - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector,
                bytes32("minIntentFillNumeraire"),
                1_000_000e18 + 1,
                1e18,
                1_000_000e18
            )
        );
        LenderIntentFacet(address(diamond)).setMinIntentFillNumeraire(1_000_000e18 + 1);
        vm.stopPrank();
    }

    function test_setFloor_adminOnly() public {
        vm.prank(user);
        vm.expectRevert();
        LenderIntentFacet(address(diamond)).setMinIntentFillNumeraire(5e18);
    }

    /// An admitted intent is not evicted when the floor later rises: the rule is
    /// applied when the intent is set, and re-setting re-applies it.
    function test_admittedIntent_survivesARaisedFloor_untilReset() public {
        _set(mockERC20, mockCollateralERC20, 100 ether);
        vm.prank(owner);
        LenderIntentFacet(address(diamond)).setMinIntentFillNumeraire(200e18);
        assertTrue(
            LenderIntentFacet(address(diamond)).getLenderIntent(user, mockERC20, mockCollateralERC20).active,
            "still admitted"
        );
        _expectBelow(100e18, 200e18);
        _set(mockERC20, mockCollateralERC20, 100 ether);
    }

    /// The floor is denominated in the numeraire, so rotating the numeraire
    /// returns it to the default until governance restates it in the new unit.
    function test_numeraireRotation_resetsTheFloor() public {
        vm.startPrank(owner);
        LenderIntentFacet(address(diamond)).setMinIntentFillNumeraire(5e18);
        NumeraireConfigFacet(address(diamond)).setNumeraireSwapEnabled(true);
        vm.expectEmit(address(diamond));
        emit NumeraireConfigFacet.MinIntentFillNumeraireSet(100e18);
        NumeraireConfigFacet(address(diamond)).setNumeraire(
            // forge-lint: disable-next-line(unsafe-typecast)
            makeAddr("ethEurFeed"), makeAddr("eurDenom"), bytes32("eur"), bytes32(0), 5_000e18, 0, 0
        );
        vm.stopPrank();
        assertEq(LenderIntentFacet(address(diamond)).getMinIntentFillNumeraire(), 100e18, "back to the default");
    }

    // ─── Priced legs ────────────────────────────────────────────────────────

    function test_unpricedLendingLeg_reverts() public {
        address junk = address(new ERC20Mock("Junk", "JNK", 18));
        vm.expectRevert(); // the oracle's own refusal, unchanged
        _set(junk, mockCollateralERC20, 1_000_000 ether);
    }

    function test_unpricedCollateralLeg_reverts() public {
        address junk = address(new ERC20Mock("Junk", "JNK", 18));
        vm.expectRevert(); // the oracle's own refusal, unchanged
        _set(mockERC20, junk, 1_000_000 ether);
    }

    function test_zeroPricedLeg_reverts() public {
        address junk = address(new ERC20Mock("Junk", "JNK", 18));
        mockOraclePrice(junk, 0, 8);
        vm.expectRevert(); // LibNumeraireValue.PriceZero
        _set(mockERC20, junk, 1_000_000 ether);
    }

    // ─── The feed ───────────────────────────────────────────────────────────

    /// The floor is also the least capital a listed intent locks: the feed lists
    /// an intent only once its capital covers one smallest fill.
    function test_feedListsOnlyAFloorSizedIntent() public {
        _set(mockERC20, mockCollateralERC20, 100 ether);
        ERC20Mock(mockERC20).mint(user, 100 ether);
        vm.startPrank(user);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        LenderIntentFacet(address(diamond)).fundLenderIntent(mockERC20, mockCollateralERC20, 100 ether - 1);
        vm.stopPrank();
        (, uint256 total) = MetricsFacet(address(diamond)).getActiveLenderIntents(0, 10);
        assertEq(total, 0, "under one smallest fill: not listed");
        vm.prank(user);
        LenderIntentFacet(address(diamond)).fundLenderIntent(mockERC20, mockCollateralERC20, 1);
        LibMetricsTypes.LenderIntentSummary[] memory page;
        (page, total) = MetricsFacet(address(diamond)).getActiveLenderIntents(0, 10);
        assertEq(total, 1, "one smallest fill funded: listed");
        assertEq(page[0].minFillAmount, 100 ether);
    }
}
