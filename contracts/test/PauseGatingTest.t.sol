// test/PauseGatingTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibPausable} from "../src/libraries/LibPausable.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";
import {PartialWithdrawalFacet} from "../src/facets/PartialWithdrawalFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";

/**
 * @title PauseGatingTest
 * @notice Asserts that every loan-mutating external entry point reverts
 *         `LibPausable.EnforcedPause` when the diamond is paused.
 * @dev Regression guard: if a future facet adds a mutating external without
 *      the `whenNotPaused` modifier, one of these tests will fail. The pause
 *      modifier fires before any role / validation / downstream logic, so we
 *      do not need real loan / offer / oracle state — zero-initialized args
 *      are sufficient. The test contract itself holds every AccessControl
 *      role (initializeAccessControl grants the deployer all roles), so
 *      role-gated entries still reach the `whenNotPaused` check first per
 *      modifier ordering.
 *
 *      #168 Track A — folded onto `SetupTest` to drop the duplicated
 *      diamond-cut bytecode from this test's compile unit. `SetupTest`
 *      cuts a 28-facet superset of the 18 facets the original setUp
 *      cut + does `initializeAccessControl` + the first `unpause`;
 *      this test just re-pauses inside its own `setUp` to exercise
 *      the gated semantics (per SetupTest's own setupHelper comment
 *      that explicitly carves out this file as the expected pattern).
 *      Track A's same PR extended SetupTest from 24 → 28 facets so the
 *      preclose / refinance / early-withdrawal / partial-withdrawal
 *      selectors this file exercises actually route through the test
 *      diamond (test-vs-prod drift closed alongside the fold).
 */
contract PauseGatingTest is SetupTest {
    function setUp() public {
        setupHelper();
        // `SetupTest.setupHelper()` unpauses the diamond as part of its
        // happy-path init (`whenNotPaused` paths in every other test
        // would otherwise revert). Re-pause here so every assertion
        // below exercises the `EnforcedPause` branch.
        AdminFacet(address(diamond)).pause();
        assertTrue(AdminFacet(address(diamond)).paused());
    }

    // ── OfferFacet ──────────────────────────────────────────────────────────

    function test_pause_createOffer() public {
        LibVaipakam.CreateOfferParams memory p;
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        OfferCreateFacet(address(diamond)).createOffer(p);
    }

    function test_pause_acceptOffer() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        OfferAcceptFacet(address(diamond)).acceptOffer(0, false);
    }

    function test_pause_cancelOffer() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        OfferCancelFacet(address(diamond)).cancelOffer(0);
    }

    // ── LoanFacet ───────────────────────────────────────────────────────────

    function test_pause_initiateLoan() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        LoanFacet(address(diamond)).initiateLoan(0, address(0), false);
    }

    // ── RepayFacet ──────────────────────────────────────────────────────────

    function test_pause_repayLoan() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        RepayFacet(address(diamond)).repayLoan(0);
    }

    function test_pause_repayPartial() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        RepayFacet(address(diamond)).repayPartial(0, 0);
    }

    function test_pause_autoDeductDaily() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        RepayFacet(address(diamond)).autoDeductDaily(0);
    }

    // ── PrecloseFacet ───────────────────────────────────────────────────────

    function test_pause_precloseDirect() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        PrecloseFacet(address(diamond)).precloseDirect(0);
    }

    function test_pause_transferObligationViaOffer() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        PrecloseFacet(address(diamond)).transferObligationViaOffer(0, 0);
    }

    function test_pause_offsetWithNewOffer() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        PrecloseFacet(address(diamond)).offsetWithNewOffer(
            0, 0, 0, address(0), 0, false, address(0)
        );
    }

    function test_pause_completeOffset() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        PrecloseFacet(address(diamond)).completeOffset(0);
    }

    // ── RefinanceFacet ──────────────────────────────────────────────────────

    function test_pause_refinanceLoan() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        RefinanceFacet(address(diamond)).refinanceLoan(0, 0);
    }

    // ── EarlyWithdrawalFacet ────────────────────────────────────────────────

    function test_pause_sellLoanViaBuyOffer() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        EarlyWithdrawalFacet(address(diamond)).sellLoanViaBuyOffer(0, 0);
    }

    function test_pause_createLoanSaleOffer() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        EarlyWithdrawalFacet(address(diamond)).createLoanSaleOffer(0, 0, false);
    }

    function test_pause_completeLoanSale() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        EarlyWithdrawalFacet(address(diamond)).completeLoanSale(0);
    }

    // ── PartialWithdrawalFacet ──────────────────────────────────────────────

    function test_pause_partialWithdrawCollateral() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        PartialWithdrawalFacet(address(diamond)).partialWithdrawCollateral(0, 0);
    }

    // ── AddCollateralFacet ──────────────────────────────────────────────────

    function test_pause_addCollateral() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        AddCollateralFacet(address(diamond)).addCollateral(0, 0);
    }

    // ── ClaimFacet ──────────────────────────────────────────────────────────

    function test_pause_claimAsLender() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        ClaimFacet(address(diamond)).claimAsLender(0);
    }

    function test_pause_claimAsBorrower() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        ClaimFacet(address(diamond)).claimAsBorrower(0);
    }

    // ── RiskFacet ───────────────────────────────────────────────────────────

    function test_pause_triggerLiquidation() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        RiskFacet(address(diamond)).triggerLiquidation(0, defaultAdapterCalls());
    }

    function test_pause_updateRiskParams() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        RiskFacet(address(diamond)).updateRiskParams(address(0), 0, 0, 0);
    }

    // ── DefaultedFacet ──────────────────────────────────────────────────────

    function test_pause_triggerDefault() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        DefaultedFacet(address(diamond)).triggerDefault(0, defaultAdapterCalls());
    }

    // ── ProfileFacet ────────────────────────────────────────────────────────

    function test_pause_setUserCountry() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        ProfileFacet(address(diamond)).setUserCountry("US");
    }

    function test_pause_setTradeAllowance() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        ProfileFacet(address(diamond)).setTradeAllowance("US", "FR", true);
    }

    function test_pause_updateKYCTier() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        ProfileFacet(address(diamond)).updateKYCTier(address(0), LibVaipakam.KYCTier.Tier0);
    }

    function test_pause_updateKYCThresholds() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        ProfileFacet(address(diamond)).updateKYCThresholds(0, 0);
    }

    function test_pause_setKeeperAccess() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        ProfileFacet(address(diamond)).setKeeperAccess(true);
    }

    function test_pause_approveKeeper() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        ProfileFacet(address(diamond)).approveKeeper(
            address(0),
            LibVaipakam.KEEPER_ACTION_ALL
        );
    }

    function test_pause_revokeKeeper() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        ProfileFacet(address(diamond)).revokeKeeper(address(0));
    }

    // ── TreasuryFacet ───────────────────────────────────────────────────────

    function test_pause_claimTreasuryFees() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        TreasuryFacet(address(diamond)).claimTreasuryFees(address(0), address(0));
    }

    // ── Negative control: pause/unpause and reads remain callable ──────────

    function test_pause_unpauseStillWorks() public {
        AdminFacet(address(diamond)).unpause();
        assertFalse(AdminFacet(address(diamond)).paused());
    }
}
