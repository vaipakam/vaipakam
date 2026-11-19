// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {RepayPeriodicFacet} from "../src/facets/RepayPeriodicFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {NumeraireConfigFacet} from "../src/facets/NumeraireConfigFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {periodicQuote} from "./helpers/ForcedSaleQuote.sol";

/// @title PeriodicInterestSettleTest
/// @notice T-034 PR2 — coverage for the settle entry point (just-stamp +
///         not-due guard + kill-switch + sanctions-tier-1 gate) AND the
///         repay-fold's interest-first checkpoint advance. The auto-
///         liquidate path (which requires a working swap try-list) is
///         covered separately in PeriodicInterestAutoLiquidateTest.t.sol
///         once that's wired with the existing 4-DEX failover mock
///         infrastructure.
contract PeriodicInterestSettleTest is SetupTest {
    LibVaipakam.PeriodicInterestCadence constant MONTHLY =
        LibVaipakam.PeriodicInterestCadence.Monthly;

    uint256 internal loanId;
    uint256 internal startTs;

    function setUp() public {
        setupHelper();
        // Enable the feature.
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setPeriodicInterestEnabled(true);
        // Bump the max offer duration so a 90-day loan with monthly
        // cadence fits without tripping the existing duration cap.
        vm.prank(owner);
        ConfigFacet(address(diamond)).setMaxOfferDurationDays(2 * 365);
        // Price the lending asset so the loan crosses the threshold —
        // 1000 tokens × $1000 = $1M, well above the $100k default
        // threshold so monthly cadence is permitted.
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8);
        mockOraclePrice(mockCollateralERC20, 1_000 * 1e8, 8);
        loanId = _createMonthlyLoan(90);
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        startTs = uint256(l.startTime);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _createMonthlyLoan(uint256 durationDays)
        internal
        returns (uint256 newLoanId)
    {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                integrator: address(0),
                lifecycleFlex: 0,
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 1000 ether,
                interestRateBps: 1200, // 12% APR
                collateralAsset: mockCollateralERC20,
                collateralAmount: 5000 ether,
                durationDays: durationDays,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: true,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: 1000 ether,
                interestRateBpsMax: 1200,
                collateralAmountMax: 5000 ether,
                periodicInterestCadence: MONTHLY,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            }),
            type(uint64).max
        );
        _signAndAcceptOffer(borrower, borrowerPk, offerId);
        return 1;
    }

    function _emptyAdapterCalls()
        internal
        pure
        returns (LibSwap.AdapterCall[] memory)
    {
        return new LibSwap.AdapterCall[](0);
    }

    // ─── Loan struct snapshot at acceptance ──────────────────────────────────

    function testCadenceSnapshottedAtAcceptance() public {
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(l.periodicInterestCadence), uint8(MONTHLY));
        assertEq(l.lastPeriodicInterestSettledAt, SafeCast.toUint64(startTs));
        assertEq(l.interestAccrualStart, SafeCast.toUint64(startTs), "the accrual starts with the loan");
    }

    // ─── previewPeriodicSettle ───────────────────────────────────────────────

    function testPreview_BeforePeriodEnd() public view {
        (
            uint8 cadence,
            uint256 periodEndAt,
            uint256 graceEndsAt,
            uint256 expected,
            uint256 paid,
            uint256 shortfall,
            bool canSettleNow
        ) = RepayPeriodicFacet(address(diamond)).previewPeriodicSettle(loanId);
        assertEq(cadence, uint8(MONTHLY));
        assertEq(periodEndAt, startTs + 30 days);
        // Monthly cadence → grace slot 1 (< 30d bucket → default 1 day).
        assertEq(graceEndsAt, startTs + 30 days + 1 days);
        // Expected: 1000e18 × 12% × 30/365 ≈ 9.86e18.
        // Computed exactly: 1000e18 * 1200 * 30 / (10000 * 365)
        uint256 expectedCalc = (uint256(1000 ether) * 1200 * 30) /
            (uint256(10_000) * 365);
        assertEq(expected, expectedCalc);
        assertEq(paid, 0);
        assertEq(shortfall, expected);
        assertFalse(canSettleNow);
    }

    function testPreview_AfterGrace() public {
        vm.warp(startTs + 30 days + 1 days + 1);
        (, , , , , , bool canSettleNow) =
            RepayPeriodicFacet(address(diamond)).previewPeriodicSettle(loanId);
        assertTrue(canSettleNow);
    }

    function testPreview_NoneCadence() public {
        // Manufacture a None-cadence loan via a separate offer.
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                integrator: address(0),
                lifecycleFlex: 0,
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 100 ether,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 500 ether,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: 100 ether,
                interestRateBpsMax: 500,
                collateralAmountMax: 500 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            }),
            type(uint64).max
        );
        _signAndAcceptOffer(borrower, borrowerPk, offerId);
        uint256 noneLoanId = 2;
        (
            uint8 cadence,
            uint256 periodEndAt,
            uint256 graceEndsAt,
            uint256 expected,
            uint256 paid,
            uint256 shortfall,
            bool canSettleNow
        ) = RepayPeriodicFacet(address(diamond)).previewPeriodicSettle(noneLoanId);
        assertEq(cadence, 0);
        assertEq(periodEndAt, 0);
        assertEq(graceEndsAt, 0);
        assertEq(expected, 0);
        assertEq(paid, 0);
        assertEq(shortfall, 0);
        assertFalse(canSettleNow);
    }

    // ─── nextPeriodCheckpoint ────────────────────────────────────────────────

    function testNextPeriodCheckpoint() public view {
        uint256 next = RepayPeriodicFacet(address(diamond)).nextPeriodCheckpoint(loanId);
        assertEq(next, startTs + 30 days);
    }

    // ─── settlePeriodicInterest revert paths ─────────────────────────────────

    function testSettle_RevertsWhenKillSwitchOff() public {
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setPeriodicInterestEnabled(false);
        vm.warp(startTs + 30 days + 1 days + 1);
        uint256 sellQuote = periodicQuote(address(diamond), loanId);
        vm.expectRevert(IVaipakamErrors.PeriodicInterestDisabled.selector);
        RepayPeriodicFacet(address(diamond)).settlePeriodicInterest(loanId, sellQuote, _emptyAdapterCalls());
    }

    function testSettle_RevertsBeforeGraceEnd() public {
        vm.warp(startTs + 30 days); // exactly at boundary, before grace
        uint256 sellQuote = periodicQuote(address(diamond), loanId);
        vm.expectPartialRevert(IVaipakamErrors.PeriodicSettleNotDue.selector);
        RepayPeriodicFacet(address(diamond)).settlePeriodicInterest(loanId, sellQuote, _emptyAdapterCalls());
    }

    function testSettle_RevertsAtGraceBoundaryMinusOne() public {
        // One second BEFORE grace ends — still NotDue.
        vm.warp(startTs + 30 days + 1 days - 1);
        uint256 sellQuote = periodicQuote(address(diamond), loanId);
        vm.expectPartialRevert(IVaipakamErrors.PeriodicSettleNotDue.selector);
        RepayPeriodicFacet(address(diamond)).settlePeriodicInterest(loanId, sellQuote, _emptyAdapterCalls());
    }

    function testSettle_AllowedAtGraceBoundaryExact() public {
        // At the exact grace boundary, settle is allowed (the gate uses
        // strictly-less-than). With empty calls + shortfall > 0 we land
        // on SwapPathRequired — proves the time gate cleared.
        vm.warp(startTs + 30 days + 1 days);
        uint256 sellQuote = periodicQuote(address(diamond), loanId);
        vm.expectPartialRevert(IVaipakamErrors.PeriodicSettleSwapPathRequired.selector);
        RepayPeriodicFacet(address(diamond)).settlePeriodicInterest(loanId, sellQuote, _emptyAdapterCalls());
    }

    function testSettle_RevertsForNoneCadence() public {
        // A None-cadence loan can't be settled.
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                integrator: address(0),
                lifecycleFlex: 0,
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 100 ether,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 500 ether,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: 100 ether,
                interestRateBpsMax: 500,
                collateralAmountMax: 500 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            }),
            type(uint64).max
        );
        _signAndAcceptOffer(borrower, borrowerPk, offerId);
        uint256 noneLoanId = 2;
        vm.warp(block.timestamp + 30 days + 2 days);
        uint256 sellQuote = periodicQuote(address(diamond), noneLoanId);
        vm.expectPartialRevert(IVaipakamErrors.PeriodicSettleNotApplicable.selector);
        RepayPeriodicFacet(address(diamond)).settlePeriodicInterest(noneLoanId, sellQuote, _emptyAdapterCalls());
    }

    function testSettle_RevertsWithEmptyAdapterCallsOnShortfall() public {
        vm.warp(startTs + 30 days + 1 days + 1);
        // Borrower hasn't paid → shortfall > 0 → empty calls list rejected.
        uint256 sellQuote = periodicQuote(address(diamond), loanId);
        vm.expectPartialRevert(IVaipakamErrors.PeriodicSettleSwapPathRequired.selector);
        RepayPeriodicFacet(address(diamond)).settlePeriodicInterest(loanId, sellQuote, _emptyAdapterCalls());
    }

    // ─── settlePeriodicInterest just-stamp path (shortfall == 0) ─────────────

    /// @dev The 12% APR fixture's interest on `principal` over `secs`.
    function _interest(uint256 principal, uint256 secs) internal pure returns (uint256) {
        return (principal * 1200 * secs) / (365 days * 10_000);
    }

    function _repayPartial(uint256 amount) internal {
        ERC20Mock(mockERC20).mint(borrower, 100 ether);
        vm.startPrank(borrower);
        ERC20Mock(mockERC20).approve(address(diamond), 100 ether);
        RepayFacet(address(diamond)).repayPartial(loanId, amount);
        vm.stopPrank();
    }

    function _preview() internal view returns (uint256 expected, uint256 paid, uint256 shortfall) {
        (,,, expected, paid, shortfall,) = RepayPeriodicFacet(address(diamond)).previewPeriodicSettle(loanId);
    }

    /// @dev #3779 — a part repayment pays all the interest so far and
    ///      restarts the accrual on the reduced principal, so a period that
    ///      straddles it owes only what the reduced principal accrued from the
    ///      repayment to the boundary. A part repayment after the boundary pays
    ///      that too, and the period closes inline. Kills: a per-period figure
    ///      priced on the whole period at the current principal, which read the
    ///      period short by 29 days of interest the repayment already paid.
    function testSettle_JustStamp_AfterRepayPartialFold() public {
        vm.warp(startTs + 29 days);
        _repayPartial(50 ether);

        vm.warp(startTs + 30 days + 1 days + 1);
        (uint256 expected, uint256 paid, uint256 shortfall) = _preview();
        assertEq(expected, _interest(950 ether, 1 days), "only the day after the repayment is owed");
        assertEq(paid, 0);
        assertEq(shortfall, expected);

        // A second part repayment after the boundary pays that day too, and
        // the period closes inline.
        _repayPartial(20 ether);
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(l.lastPeriodicInterestSettledAt, SafeCast.toUint64(startTs + 30 days));
        assertEq(l.interestAccrualStart, block.timestamp, "the accrual restarted at the repayment");
    }

    /// @dev #3779 — the interest so far, paid from a wallet in two parts,
    ///      counts toward the period, and the part at the period's end closes
    ///      it inline with no sale; the settlement then has nothing to sell.
    function testPayInterest_FromWalletClosesThePeriodWithoutASale() public {
        vm.warp(startTs + 20 days);
        uint256 first = _friendPays(100 ether);
        assertEq(first, _interest(1000 ether, 20 days), "the interest so far, no more");
        LibVaipakam.Loan memory mid = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(mid.interestSettled, first, "settled on the loan");
        assertEq(mid.lastPeriodicInterestSettledAt, SafeCast.toUint64(startTs), "period still open");
        assertEq(mid.principal, 1000 ether, "principal untouched");
        assertEq(mid.interestAccrualStart, SafeCast.toUint64(startTs), "the accrual is not restarted");

        vm.warp(startTs + 30 days);
        _friendPays(100 ether);
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(l.lastPeriodicInterestSettledAt, SafeCast.toUint64(startTs + 30 days), "closed inline");
        assertEq(l.interestSettled, _interest(1000 ether, 30 days), "the period's interest, settled once");
    }

    function _friendPays(uint256 maxAmount) internal returns (uint256) {
        address friend = makeAddr("friend");
        ERC20Mock(mockERC20).mint(friend, maxAmount);
        vm.startPrank(friend);
        ERC20Mock(mockERC20).approve(address(diamond), maxAmount);
        uint256 paid = RepayPeriodicFacet(address(diamond)).payInterest(loanId, maxAmount);
        vm.stopPrank();
        return paid;
    }

    /// @dev #3779 — a payment after a period's end pays the part day past it
    ///      too; nothing is carried, yet the next period reads only the 29.5
    ///      days still unpaid, because a period's shortfall is the accrual
    ///      through its boundary less everything settled.
    function testPayInterest_PartDayPaidAheadCountsTowardTheNextBoundary() public {
        vm.warp(startTs + 30 days + 12 hours);
        uint256 first = _friendPays(100 ether);
        assertEq(first, _interest(1000 ether, 30 days + 12 hours), "30.5 days");
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(l.lastPeriodicInterestSettledAt, SafeCast.toUint64(startTs + 30 days), "first period closed");

        vm.warp(startTs + 61 days + 1);
        (uint256 expected, uint256 paid, uint256 shortfall) = _preview();
        assertEq(expected, _interest(1000 ether, 60 days), "owed through the second boundary");
        assertEq(paid, first);
        assertEq(shortfall, expected - first, "29.5 days short, not 30");

        _friendPays(100 ether);
        l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(l.lastPeriodicInterestSettledAt, SafeCast.toUint64(startTs + 60 days), "second period closed");
    }

    /// @dev #3779 — one payment covering two whole periods closes both.
    function testPayInterest_OnePaymentClosesTwoPeriods() public {
        vm.warp(startTs + 60 days);
        _friendPays(100 ether);
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(l.lastPeriodicInterestSettledAt, SafeCast.toUint64(startTs + 60 days), "both closed");
    }

    /// @dev Interest already settled on the segment (seeded as a forced sale
    ///      would leave it) covers the period, so the settlement just stamps.
    function testSettle_JustStamp_DirectSettlerCall() public {
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        l.interestSettled = _interest(1000 ether, 30 days);
        TestMutatorFacet(address(diamond)).setLoan(loanId, l);

        // Past the boundary + grace.
        vm.warp(startTs + 30 days + 1 days);

        address bot = makeAddr("bot");
        uint256 sellQuote = periodicQuote(address(diamond), loanId);
        vm.prank(bot);
        RepayPeriodicFacet(address(diamond)).settlePeriodicInterest(loanId, sellQuote, _emptyAdapterCalls());

        LibVaipakam.Loan memory after_ = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(after_.lastPeriodicInterestSettledAt, SafeCast.toUint64(startTs + 30 days));
        assertEq(after_.interestSettled, l.interestSettled, "a just-stamp moves nothing");
    }

    // ─── repayPartial and the period ─────────────────────────────────────────

    /// @dev #3779 — a part repayment inside a period restarts the accrual
    ///      through the one restart writer and leaves the period open; the
    ///      period then owes the reduced principal's accrual to its boundary.
    function testRepayPartial_RestartsTheAccrualAndLeavesThePeriodOpen() public {
        vm.warp(startTs + 10 days);
        _repayPartial(50 ether);

        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(l.interestAccrualStart, block.timestamp);
        assertEq(l.interestSettled, 0);
        assertEq(l.lastPeriodicInterestSettledAt, SafeCast.toUint64(startTs));
        (uint256 expected,, uint256 shortfall) = _preview();
        assertEq(expected, _interest(950 ether, 20 days));
        assertEq(shortfall, expected);
    }

    /// @dev Pass-2 A3 (#1191, #1229) / #3779 — settled interest beyond what
    ///      the segment accrued (a forced sale can deliver more than has
    ///      accrued) is the borrower's, paid ahead: a part repayment charges no
    ///      interest out of it, carries the rest into the restarted segment,
    ///      and the carried interest counts toward the period once.
    function testRepayPartial_SettledAheadIsCarriedAndCountedOnce() public {
        uint256 seededCredit = 100 ether; // >> 10-day accrual → no interest charged
        LibVaipakam.Loan memory l0 = LoanFacet(address(diamond)).getLoanDetails(loanId);
        l0.interestSettled = seededCredit;
        TestMutatorFacet(address(diamond)).setLoan(loanId, l0);

        vm.warp(startTs + 10 days);
        _repayPartial(50 ether);

        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        uint256 carried = seededCredit - _interest(1000 ether, 10 days);
        assertEq(l.interestSettled, carried, "the excess is carried into the restarted segment");
        assertEq(l.lastPeriodicInterestSettledAt, SafeCast.toUint64(startTs), "the boundary has not passed");
        (uint256 expected, uint256 paid, uint256 shortfall) = _preview();
        assertEq(expected, _interest(950 ether, 20 days));
        assertEq(paid, expected, "the carried interest covers the period");
        assertEq(shortfall, 0);
    }
}
