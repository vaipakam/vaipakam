// test/MetricsDashboardFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {SetupComposable} from "./composable/SetupComposable.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {MetricsDashboardFacet} from "../src/facets/MetricsDashboardFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/**
 * @notice Tests the per-user dashboard surface
 *         (AnalyticalGettersDesign §3.1 / D1–D4): scalar snapshot
 *         + three paginated list views.
 *
 *         Uses TestMutatorFacet to scaffold loans / offers / claims
 *         straight into storage, so the bundled views are exercised
 *         without going through the full lifecycle.
 */
contract MetricsDashboardFacetTest is Test {

    // ── Stage 6 composition migration (2026-05-27) ──────────────────────
    // Inherit only forge-std `Test`; the Diamond + facet routing + state
    // are owned by a `SetupComposable` instance the test composes via
    // `setUp`. Common SetupTest fields are mirrored locally below so the
    // bulk of test-body code keeps compiling unchanged.
    SetupComposable internal helpers;
    VaipakamDiamond internal diamond;
    address internal owner;
    address internal lender;
    address internal borrower;
    address internal mockERC20;
    address internal mockCollateralERC20;
    address internal mockIlliquidERC20;
    address internal mockNft721;
    address internal mockZeroExProxy;
    uint256 internal constant BASIS_POINTS = 10_000;
    uint256 internal constant KYC_THRESHOLD_USD = 2000 * 1e18;
    uint256 internal constant RENTAL_BUFFER_BPS = 500;
    uint256 internal constant MIN_HEALTH_FACTOR = 150 * 1e16;
    MetricsDashboardFacet internal dash;
    address internal lender2;
    address internal borrower2;

    function setUp() public {
        helpers = new SetupComposable();
        helpers.bootstrap(address(this));
        diamond = helpers.diamond();
        owner = helpers.owner();
        lender = helpers.lender();
        borrower = helpers.borrower();
        mockERC20 = helpers.mockERC20();
        mockCollateralERC20 = helpers.mockCollateralERC20();
        mockIlliquidERC20 = helpers.mockIlliquidERC20();
        mockNft721 = helpers.mockNft721();
        mockZeroExProxy = helpers.mockZeroExProxy();
        dash = MetricsDashboardFacet(address(diamond));
        lender2 = makeAddr("lender2");
        borrower2 = makeAddr("borrower2");
    }

    // ── scaffolding ────────────────────────────────────────────────────────

    function _seedActiveLoan(
        uint256 loanId,
        address l_,
        address b_
    ) internal {
        LibVaipakam.Loan memory l;
        l.id = loanId;
        l.lender = l_;
        l.borrower = b_;
        l.principal = 1000 ether;
        l.principalAsset = mockERC20;
        l.collateralAsset = mockERC20;
        l.collateralAmount = 1500 ether;
        l.interestRateBps = 500;
        l.durationDays = 30;
        l.status = LibVaipakam.LoanStatus.Active;
        l.assetType = LibVaipakam.AssetType.ERC20;
        l.collateralAssetType = LibVaipakam.AssetType.ERC20;
        l.startTime = uint64(block.timestamp);
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(loanId, l);
    }

    function _seedOpenOffer(uint256 offerId, address creator_) internal {
        LibVaipakam.Offer memory o;
        o.id = offerId;
        o.creator = creator_;
        o.lendingAsset = mockERC20;
        o.amount = 1000 ether;
        o.accepted = false;
        o.offerType = LibVaipakam.OfferType.Lender;
        o.assetType = LibVaipakam.AssetType.ERC20;
        o.collateralAssetType = LibVaipakam.AssetType.ERC20;
        TestMutatorFacet(address(diamond)).scaffoldOpenOffer(offerId, o);
    }

    // ── snapshot scalar reads ──────────────────────────────────────────────

    /// @dev Empty state — every counter zero, every reward 0.
    function testSnapshot_emptyUser() public view {
        MetricsDashboardFacet.DashboardScalars memory snap = dash.getUserDashboardSnapshot(lender);
        assertEq(snap.lenderLoanCount, 0);
        assertEq(snap.borrowerLoanCount, 0);
        assertEq(snap.activeOfferCount, 0);
        assertEq(snap.filledOfferCount, 0);
        assertEq(snap.lenderClaimableCount, 0);
        assertEq(snap.borrowerClaimableCount, 0);
        assertEq(snap.stakingRewardsPending, 0);
        assertEq(snap.vaultVpfiBalance, 0);
        assertEq(snap.vpfiTier, 0);
    }

    /// @dev User on lender side of one loan + borrower side of another
    ///      yields the expected per-side counts.
    function testSnapshot_countsLenderAndBorrowerSides() public {
        _seedActiveLoan(1, lender, borrower);
        _seedActiveLoan(2, borrower, lender); // role-swapped: lender is borrower here
        TestMutatorFacet(address(diamond)).setNextLoanId(3);

        MetricsDashboardFacet.DashboardScalars memory snap = dash.getUserDashboardSnapshot(lender);
        assertEq(snap.lenderLoanCount, 1);
        assertEq(snap.borrowerLoanCount, 1);
    }

    /// @dev Counts open vs filled offers separately (D4). Both states
    ///      live in the per-user `userOfferIds[creator]` index — only
    ///      the `accepted` flag distinguishes them. We scaffold both
    ///      to populate the per-user index, then flip offer #2's
    ///      accepted flag via `setOffer` to simulate a filled state.
    function testSnapshot_countsOpenAndFilledOffers() public {
        _seedOpenOffer(1, lender);
        _seedOpenOffer(2, lender);

        // Flip offer #2 to accepted=true (filled).
        LibVaipakam.Offer memory filled;
        filled.id = 2;
        filled.creator = lender;
        filled.lendingAsset = mockERC20;
        filled.amount = 1000 ether;
        filled.accepted = true;
        filled.offerType = LibVaipakam.OfferType.Lender;
        filled.assetType = LibVaipakam.AssetType.ERC20;
        filled.collateralAssetType = LibVaipakam.AssetType.ERC20;
        TestMutatorFacet(address(diamond)).setOffer(2, filled);

        MetricsDashboardFacet.DashboardScalars memory snap = dash.getUserDashboardSnapshot(lender);
        assertEq(snap.activeOfferCount, 1);
        assertEq(snap.filledOfferCount, 1);
    }

    // ── paginated loans ────────────────────────────────────────────────────

    function testLoans_lenderSide_returnsRowsWithRisk() public {
        _seedActiveLoan(1, lender, borrower);
        _seedActiveLoan(2, lender, borrower2);
        _seedActiveLoan(3, lender2, borrower); // not for `lender`
        TestMutatorFacet(address(diamond)).setNextLoanId(4);

        MetricsDashboardFacet.LoanWithRisk[] memory rows = dash.getUserDashboardLoans(
            lender, /* borrowerSide */ false, 0, 50
        );
        assertEq(rows.length, 2);
        assertTrue(rows[0].loan.lender == lender);
        assertTrue(rows[1].loan.lender == lender);
    }

    function testLoans_pagination_offsetAndLimit() public {
        _seedActiveLoan(1, lender, borrower);
        _seedActiveLoan(2, lender, borrower2);
        _seedActiveLoan(3, lender, borrower);
        TestMutatorFacet(address(diamond)).setNextLoanId(4);

        MetricsDashboardFacet.LoanWithRisk[] memory page1 = dash.getUserDashboardLoans(
            lender, false, 0, 2
        );
        MetricsDashboardFacet.LoanWithRisk[] memory page2 = dash.getUserDashboardLoans(
            lender, false, 2, 2
        );
        assertEq(page1.length, 2);
        assertEq(page2.length, 1);
    }

    function testLoans_revertsOnLimitTooLarge() public {
        vm.expectRevert(
            abi.encodeWithSelector(MetricsDashboardFacet.LimitTooLarge.selector, 101, 100)
        );
        dash.getUserDashboardLoans(lender, false, 0, 101);
    }

    // ── unified both-sides loans ───────────────────────────────────────────

    /// @dev User on both sides yields one merged page; the per-row
    ///      `borrowerSide` tag distinguishes which side they hold.
    function testLoansBothSides_unifiedMergedPage() public {
        // 1 lender-side loan + 2 borrower-side loans (where `lender` is
        // actually the borrower); 1 unrelated loan that shouldn't surface.
        _seedActiveLoan(1, lender, borrower);
        _seedActiveLoan(2, borrower, lender);
        _seedActiveLoan(3, borrower2, lender);
        _seedActiveLoan(4, lender2, borrower2);
        TestMutatorFacet(address(diamond)).setNextLoanId(5);

        MetricsDashboardFacet.LoanWithRiskAndSide[] memory rows =
            dash.getUserDashboardLoansBothSides(lender, 0, 50);
        assertEq(rows.length, 3);

        // Locate the lender-side row + verify its tag is borrowerSide=false.
        bool foundLenderSide;
        uint256 borrowerSideCount;
        for (uint256 i = 0; i < rows.length; i++) {
            if (!rows[i].borrowerSide) foundLenderSide = true;
            else borrowerSideCount += 1;
        }
        assertTrue(foundLenderSide);
        assertEq(borrowerSideCount, 2);
    }

    function testLoansBothSides_revertsOnLimitTooLarge() public {
        vm.expectRevert(
            abi.encodeWithSelector(MetricsDashboardFacet.LimitTooLarge.selector, 101, 100)
        );
        dash.getUserDashboardLoansBothSides(lender, 0, 101);
    }

    // ── paginated offers ───────────────────────────────────────────────────

    function testOffers_openOnly() public {
        _seedOpenOffer(1, lender);
        _seedOpenOffer(2, lender);
        _seedOpenOffer(3, lender2); // not for `lender`
        TestMutatorFacet(address(diamond)).setNextOfferId(4);

        LibVaipakam.Offer[] memory openOffers =
            dash.getUserDashboardOffers(lender, /* filledOnly */ false, 0, 50);
        assertEq(openOffers.length, 2);
        assertEq(openOffers[0].creator, lender);

        LibVaipakam.Offer[] memory filledOffers =
            dash.getUserDashboardOffers(lender, true, 0, 50);
        assertEq(filledOffers.length, 0);
    }

    function testOffers_revertsOnLimitTooLarge() public {
        vm.expectRevert(
            abi.encodeWithSelector(MetricsDashboardFacet.LimitTooLarge.selector, 101, 100)
        );
        dash.getUserDashboardOffers(lender, false, 0, 101);
    }

    // ── paginated claimables ───────────────────────────────────────────────

    function testClaimables_lenderSide() public {
        _seedActiveLoan(1, lender, borrower);
        TestMutatorFacet(address(diamond)).setNextLoanId(2);
        // Populate the lender claim — Raw setters touch the
        // {asset, amount} fields independently; default `claimed`
        // boolean is false which is what we want.
        TestMutatorFacet(address(diamond)).setLenderClaimAssetRaw(1, mockERC20);
        TestMutatorFacet(address(diamond)).setLenderClaimAmountRaw(1, 200 ether);

        (uint256[] memory loanIds, LibVaipakam.ClaimInfo[] memory claims) =
            dash.getUserDashboardClaimables(lender, /* borrowerSide */ false, 0, 50);
        assertEq(loanIds.length, 1);
        assertEq(loanIds[0], 1);
        assertEq(claims[0].amount, 200 ether);
    }

    function testClaimables_revertsOnLimitTooLarge() public {
        vm.expectRevert(
            abi.encodeWithSelector(MetricsDashboardFacet.LimitTooLarge.selector, 101, 100)
        );
        dash.getUserDashboardClaimables(lender, false, 0, 101);
    }
}
