// test/PauseGatingTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibPausable} from "../src/libraries/LibPausable.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";
import {PartialWithdrawalFacet} from "../src/facets/PartialWithdrawalFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {HelperTest} from "./HelperTest.sol";
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
 */
contract PauseGatingTest is Test {
    VaipakamDiamond diamond;

    function setUp() public {
        DiamondCutFacet cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(address(this), address(cutFacet));
        HelperTest helper = new HelperTest();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](15);
        cuts[0] = _cut(address(new AccessControlFacet()), helper.getAccessControlFacetSelectors());
        cuts[1] = _cut(address(new AdminFacet()), helper.getAdminFacetSelectors());
        cuts[2] = _cut(address(new OfferFacet()), helper.getOfferFacetSelectors());
        cuts[3] = _cut(address(new LoanFacet()), helper.getLoanFacetSelectors());
        cuts[4] = _cut(address(new RepayFacet()), helper.getRepayFacetSelectors());
        cuts[5] = _cut(address(new PrecloseFacet()), helper.getPrecloseFacetSelectors());
        cuts[6] = _cut(address(new RefinanceFacet()), helper.getRefinanceFacetSelectors());
        cuts[7] = _cut(address(new EarlyWithdrawalFacet()), helper.getEarlyWithdrawalFacetSelectors());
        cuts[8] = _cut(address(new PartialWithdrawalFacet()), helper.getPartialWithdrawalFacetSelectors());
        cuts[9] = _cut(address(new AddCollateralFacet()), helper.getAddCollateralFacetSelectors());
        cuts[10] = _cut(address(new ClaimFacet()), helper.getClaimFacetSelectors());
        cuts[11] = _cut(address(new RiskFacet()), helper.getRiskFacetSelectors());
        cuts[12] = _cut(address(new DefaultedFacet()), helper.getDefaultedFacetSelectors());
        cuts[13] = _cut(address(new ProfileFacet()), helper.getProfileFacetSelectors());
        cuts[14] = _cut(address(new TreasuryFacet()), helper.getTreasuryFacetSelectors());

        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        AccessControlFacet(address(diamond)).initializeAccessControl();
        AdminFacet(address(diamond)).pause();
        assertTrue(AdminFacet(address(diamond)).paused());
    }

    function _cut(address facet, bytes4[] memory selectors)
        internal
        pure
        returns (IDiamondCut.FacetCut memory)
    {
        return IDiamondCut.FacetCut({
            facetAddress: facet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });
    }

    // ── OfferFacet ──────────────────────────────────────────────────────────

    function test_pause_createOffer() public {
        LibVaipakam.CreateOfferParams memory p;
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        OfferFacet(address(diamond)).createOffer(p);
    }

    function test_pause_acceptOffer() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        OfferFacet(address(diamond)).acceptOffer(0, false);
    }

    function test_pause_cancelOffer() public {
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        OfferFacet(address(diamond)).cancelOffer(0);
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
        RiskFacet(address(diamond)).updateRiskParams(address(0), 0, 0, 0, 0);
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
