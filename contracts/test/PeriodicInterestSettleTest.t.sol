// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

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
        ConfigFacet(address(diamond)).setPeriodicInterestEnabled(true);
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
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
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
                creatorFallbackConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: true,
                amountMax: 0,
                interestRateBpsMax: 0,
                periodicInterestCadence: MONTHLY
            })
        );
        vm.prank(borrower);
        OfferFacet(address(diamond)).acceptOffer(offerId, true);
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
        assertEq(l.lastPeriodicInterestSettledAt, uint64(startTs));
        assertEq(l.interestPaidSinceLastPeriod, 0);
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
        ) = RepayFacet(address(diamond)).previewPeriodicSettle(loanId);
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
            RepayFacet(address(diamond)).previewPeriodicSettle(loanId);
        assertTrue(canSettleNow);
    }

    function testPreview_NoneCadence() public {
        // Manufacture a None-cadence loan via a separate offer.
        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
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
                creatorFallbackConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                amountMax: 0,
                interestRateBpsMax: 0,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
            })
        );
        vm.prank(borrower);
        OfferFacet(address(diamond)).acceptOffer(offerId, true);
        uint256 noneLoanId = 2;
        (
            uint8 cadence,
            uint256 periodEndAt,
            uint256 graceEndsAt,
            uint256 expected,
            uint256 paid,
            uint256 shortfall,
            bool canSettleNow
        ) = RepayFacet(address(diamond)).previewPeriodicSettle(noneLoanId);
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
        uint256 next = RepayFacet(address(diamond)).nextPeriodCheckpoint(loanId);
        assertEq(next, startTs + 30 days);
    }

    // ─── settlePeriodicInterest revert paths ─────────────────────────────────

    function testSettle_RevertsWhenKillSwitchOff() public {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPeriodicInterestEnabled(false);
        vm.warp(startTs + 30 days + 1 days + 1);
        vm.expectRevert(IVaipakamErrors.PeriodicInterestDisabled.selector);
        RepayFacet(address(diamond)).settlePeriodicInterest(loanId, _emptyAdapterCalls());
    }

    function testSettle_RevertsBeforeGraceEnd() public {
        vm.warp(startTs + 30 days); // exactly at boundary, before grace
        vm.expectPartialRevert(IVaipakamErrors.PeriodicSettleNotDue.selector);
        RepayFacet(address(diamond)).settlePeriodicInterest(loanId, _emptyAdapterCalls());
    }

    function testSettle_RevertsAtGraceBoundaryMinusOne() public {
        // One second BEFORE grace ends — still NotDue.
        vm.warp(startTs + 30 days + 1 days - 1);
        vm.expectPartialRevert(IVaipakamErrors.PeriodicSettleNotDue.selector);
        RepayFacet(address(diamond)).settlePeriodicInterest(loanId, _emptyAdapterCalls());
    }

    function testSettle_AllowedAtGraceBoundaryExact() public {
        // At the exact grace boundary, settle is allowed (the gate uses
        // strictly-less-than). With empty calls + shortfall > 0 we land
        // on SwapPathRequired — proves the time gate cleared.
        vm.warp(startTs + 30 days + 1 days);
        vm.expectPartialRevert(IVaipakamErrors.PeriodicSettleSwapPathRequired.selector);
        RepayFacet(address(diamond)).settlePeriodicInterest(loanId, _emptyAdapterCalls());
    }

    function testSettle_RevertsForNoneCadence() public {
        // A None-cadence loan can't be settled.
        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
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
                creatorFallbackConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                amountMax: 0,
                interestRateBpsMax: 0,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
            })
        );
        vm.prank(borrower);
        OfferFacet(address(diamond)).acceptOffer(offerId, true);
        uint256 noneLoanId = 2;
        vm.warp(block.timestamp + 30 days + 2 days);
        vm.expectPartialRevert(IVaipakamErrors.PeriodicSettleNotApplicable.selector);
        RepayFacet(address(diamond)).settlePeriodicInterest(noneLoanId, _emptyAdapterCalls());
    }

    function testSettle_RevertsWithEmptyAdapterCallsOnShortfall() public {
        vm.warp(startTs + 30 days + 1 days + 1);
        // Borrower hasn't paid → shortfall > 0 → empty calls list rejected.
        vm.expectPartialRevert(IVaipakamErrors.PeriodicSettleSwapPathRequired.selector);
        RepayFacet(address(diamond)).settlePeriodicInterest(loanId, _emptyAdapterCalls());
    }

    // ─── settlePeriodicInterest just-stamp path (shortfall == 0) ─────────────

    function testSettle_JustStamp_AfterRepayPartialFold() public {
        // Borrower partial-repays MORE than the period's expected interest
        // before the period boundary, then waits for grace, then anyone
        // calls settle → shortfall is zero → just-stamp path → no revert.
        // Actually the inline fold should already advance the checkpoint
        // when block.timestamp crosses the boundary AND interest paid >=
        // expected. Test the inline-advance path here.

        // Travel to just before the boundary, repay enough to cover the
        // period's interest.
        vm.warp(startTs + 29 days);
        ERC20Mock(mockERC20).mint(borrower, 100 ether);
        vm.prank(borrower);
        ERC20Mock(mockERC20).approve(address(diamond), 100 ether);
        // Partial-repay 50 ether of principal (minimum allowed by
        // assetRiskParams.minPartialBps which defaults to 100bps = 1%
        // of 1000 ether = 10 ether minimum). 50 ether is well above.
        // The contract pulls partialAmount + accrued from the borrower —
        // the accrued portion accumulates into interestPaidSinceLastPeriod.
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loanId, 50 ether);

        // Now warp past the period boundary AND grace.
        vm.warp(startTs + 30 days + 1 days + 1);

        // Has the inline advance already fired during the prior repay?
        // No — at that point block.timestamp was still 29 days, BEFORE
        // the boundary, so the advance condition `block.timestamp >=
        // boundary` was false. We need to trigger the advance via a
        // post-boundary repay OR a settle call.

        // Repay another small chunk after the boundary to trigger the
        // inline advance through the fold.
        ERC20Mock(mockERC20).mint(borrower, 100 ether);
        vm.prank(borrower);
        ERC20Mock(mockERC20).approve(address(diamond), 100 ether);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loanId, 20 ether);

        // Verify checkpoint advanced.
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(l.lastPeriodicInterestSettledAt, uint64(startTs + 30 days));
        assertEq(l.interestPaidSinceLastPeriod, 0); // reset after advance
    }

    function testSettle_JustStamp_DirectSettlerCall() public {
        // Seed interestPaidSinceLastPeriod high enough that the period
        // shortfall is exactly zero — exercises the just-stamp branch
        // without depending on the floating-point quirks of the
        // accrual math (every partial repay resets `startTime` so a
        // single call can't capture a full 30-day period's interest;
        // simulating this end-to-end would require multiple repays
        // and brittle fixture timing).
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        // Expected for the period at the current principal and rate.
        uint256 expected = (uint256(l.principal) *
            uint256(l.interestRateBps) * 30) / (10_000 * 365);
        l.interestPaidSinceLastPeriod = uint128(expected);
        TestMutatorFacet(address(diamond)).setLoan(loanId, l);

        // Past the boundary + grace.
        vm.warp(startTs + 30 days + 1 days);

        address bot = makeAddr("bot");
        vm.prank(bot);
        RepayFacet(address(diamond)).settlePeriodicInterest(loanId, _emptyAdapterCalls());

        LibVaipakam.Loan memory after_ = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(after_.lastPeriodicInterestSettledAt, uint64(startTs + 30 days));
        assertEq(after_.interestPaidSinceLastPeriod, 0);
    }

    // ─── repayPartial fold accounting ────────────────────────────────────────

    function testRepayPartial_AccrualAccumulatesIntoInterestPaidSinceLastPeriod() public {
        // Travel partway into the period, partial-repay, verify
        // interestPaidSinceLastPeriod tracks the accrued amount the
        // contract just settled.
        vm.warp(startTs + 10 days);
        ERC20Mock(mockERC20).mint(borrower, 100 ether);
        vm.prank(borrower);
        ERC20Mock(mockERC20).approve(address(diamond), 100 ether);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loanId, 50 ether);

        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        // Should be non-zero. Exact value depends on the existing
        // accrual math but must be > 0 at 10 days into the loan.
        assertGt(l.interestPaidSinceLastPeriod, 0);
        // Checkpoint NOT yet advanced (we're still within the period).
        assertEq(l.lastPeriodicInterestSettledAt, uint64(startTs));
    }
}
