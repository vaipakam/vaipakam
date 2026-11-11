// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {PriceGuard} from "../src/oracle/PriceGuard.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {LoanClockFacet} from "../src/facets/LoanClockFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {RepayPeriodicFacet} from "../src/facets/RepayPeriodicFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {NumeraireConfigFacet} from "../src/facets/NumeraireConfigFacet.sol";
import {LoanClockProbeFacet} from "./mocks/LoanClockProbeFacet.sol";
import {MockSequencerUptimeFeed} from "./mocks/MockSequencerUptimeFeed.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {LibTestPriceGuard} from "./helpers/LibTestPriceGuard.sol";
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";
import {periodicQuote} from "./helpers/ForcedSaleQuote.sol";
import {IPriceGuard} from "../src/interfaces/IPriceGuard.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";

/// @title SequencerOutageLoanClockTest
/// @notice #3410 (owner decision 2026-11-09): an L2 sequencer outage moves a
///         loan's grace end that falls inside the outage or its recovery
///         window to the window's end, and no late fee runs for time inside
///         that window. A periodic settlement deadline is NOT moved: the
///         collateral-sale settlement already refuses while the price read
///         is in its recovery window, and settles once it ends. Read without a
///         recorded log, from the sequencer uptime feed the price guard
///         holds ({PriceGuard.sequencerOutageWindow}).
contract SequencerOutageLoanClockTest is SetupTest {
    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant COLLATERAL = 2000 ether;
    uint256 internal constant DURATION_DAYS = 30;
    /// @dev The compile-time grace for a 30-day loan (30 <= d < 90).
    uint256 internal constant GRACE = 3 days;
    uint256 internal constant RECOVERY = 1 hours;

    MockSequencerUptimeFeed internal seqFeed;
    PriceGuard internal guard;

    function setUp() public {
        setupHelper();
        guard = PriceGuard(LibTestPriceGuard.guardOf(address(diamond)));
        assertEq(guard.SEQUENCER_GRACE_PERIOD(), RECOVERY, "fixture-live: the recovery window");
        bytes4[] memory sels = new bytes4[](1);
        sels[0] = LoanClockProbeFacet.probeLateFee.selector;
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(new LoanClockProbeFacet()),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sels
        });
        vm.prank(owner);
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        // Up since long before any loan here starts.
        uint256 t0 = vm.getBlockTimestamp();
        seqFeed = new MockSequencerUptimeFeed(0, t0 > 10 days ? t0 - 10 days : 1);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _wireFeed() internal {
        LibTestPriceGuard.setAddress(address(diamond), PriceGuard.Kind.SequencerFeed, address(seqFeed));
    }

    function _params(LibVaipakam.PeriodicInterestCadence cadence, uint256 durationDays, uint256 collateral)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: mockERC20,
            amount: PRINCIPAL,
            interestRateBps: 500,
            collateralAsset: mockCollateralERC20,
            collateralAmount: collateral,
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
            amountMax: PRINCIPAL,
            interestRateBpsMax: 500,
            collateralAmountMax: collateral,
            periodicInterestCadence: cadence,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
    }

    function _openLoan() internal returns (uint256 loanId) {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.PeriodicInterestCadence.None, DURATION_DAYS, COLLATERAL), type(uint64).max
        );
        loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Active), "fixture-live: the loan is active");
    }

    function _status(uint256 loanId) internal view returns (LibVaipakam.LoanStatus) {
        return LoanFacet(address(diamond)).getLoanDetails(loanId).status;
    }

    function _deadlines(uint256 loanId) internal view returns (uint256 maturity, uint256 graceEnd) {
        (,, maturity, graceEnd) = LoanClockFacet(address(diamond)).getLoanDeadlines(loanId);
    }

    /// @dev Records one outage on the feed: down at `downAt`, up at `upAt`.
    function _outage(uint256 downAt, uint256 upAt) internal {
        seqFeed.setStatus(1, downAt);
        seqFeed.setStatus(0, upAt);
    }

    // ─── 1. The guard's outage read ──────────────────────────────────────────

    function test_window_noFeedIsZero() public view {
        (uint256 downAt, uint256 windowEnd) = guard.sequencerOutageWindow();
        assertEq(downAt, 0);
        assertEq(windowEnd, 0);
    }

    function test_window_upAfterAnOutageReadsThePreviousRound() public {
        _wireFeed();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        uint256 t = vm.getBlockTimestamp();
        _outage(t - 3 hours, t - 20 minutes);
        (uint256 downAt, uint256 windowEnd) = guard.sequencerOutageWindow();
        assertEq(downAt, t - 3 hours, "the outage began at the previous round");
        assertEq(windowEnd, t - 20 minutes + RECOVERY, "the recovery window ends an hour after recovery");
    }

    function test_window_downNowRunsToNowPlusTheRecovery() public {
        _wireFeed();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        uint256 t = vm.getBlockTimestamp();
        seqFeed.setStatus(1, t - 2 hours);
        (uint256 downAt, uint256 windowEnd) = guard.sequencerOutageWindow();
        assertEq(downAt, t - 2 hours);
        assertEq(windowEnd, t + RECOVERY, "still down: an hour past now at the least");
    }

    function test_window_upWithNoEarlierRoundCountsOnlyTheRecovery() public {
        _wireFeed();
        (uint256 downAt, uint256 windowEnd) = guard.sequencerOutageWindow();
        assertEq(downAt, seqFeed.startedAt_(), "no earlier round: the start is unknown");
        assertEq(windowEnd, seqFeed.startedAt_() + RECOVERY);
    }

    function test_window_brokenFeedReadsAsDownFromNow() public {
        _wireFeed();
        uint256 t = vm.getBlockTimestamp();
        seqFeed.setStatus(0, t + 1 days); // a start in the future
        (uint256 downAt, uint256 windowEnd) = guard.sequencerOutageWindow();
        assertEq(downAt, t);
        assertEq(windowEnd, t + RECOVERY);
    }

    // ─── 2. The grace end ────────────────────────────────────────────────────

    function test_graceEnd_unchangedWithoutAFeed() public {
        uint256 loanId = _openLoan();
        (uint256 maturity, uint256 graceEnd) = _deadlines(loanId);
        assertEq(graceEnd, maturity + GRACE);
    }

    /// @dev The grace end falls inside the outage: it moves to the end of the
    ///      recovery window, the loan cannot be defaulted before then, and the
    ///      borrower can repay in the window.
    function test_graceEnd_insideAnOutageMovesToTheWindowEnd_repayOpen() public {
        uint256 loanId = _openLoan();
        _wireFeed();
        (uint256 maturity, uint256 scheduledGraceEnd) = _deadlines(loanId);
        assertEq(scheduledGraceEnd, maturity + GRACE, "fixture-live: no outage yet");

        uint256 upAt = scheduledGraceEnd + 2 hours;
        _outage(scheduledGraceEnd - 1 hours, upAt);
        vm.warp(upAt + 10 minutes);

        (, uint256 graceEnd) = _deadlines(loanId);
        assertEq(graceEnd, upAt + RECOVERY, "moved to the end of the recovery window");
        assertFalse(DefaultedFacet(address(diamond)).isLoanDefaultable(loanId), "not defaultable in the window");
        vm.expectRevert(DefaultedFacet.NotDefaultedYet.selector);
        DefaultedFacet(address(diamond)).triggerDefault(loanId, 0, defaultAdapterCalls());

        vm.startPrank(borrower);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        RepayFacet(address(diamond)).repayLoan(loanId);
        vm.stopPrank();
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Repaid), "repaid after the scheduled grace end");
    }

    /// @notice A partial repayment stays open inside the recovery window too,
    ///         read through the price guard as deployed. Its health-factor gate
    ///         is defensive only (a partial can only raise the health factor)
    ///         and needs a price the window refuses, so it is skipped there.
    function test_graceEnd_partialRepayOpenInTheRecoveryWindow_realGuard() public {
        uint256 loanId = _openLoan();
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertTrue(
            loan.collateralLiquidity == LibVaipakam.LiquidityStatus.Liquid
                && loan.principalLiquidity == LibVaipakam.LiquidityStatus.Liquid,
            "fixture-live: both legs liquid, so the health-factor gate applies"
        );
        assertTrue(loan.allowsPartialRepay, "fixture-live: partial repayment allowed");
        _wireFeed();
        (, uint256 scheduledGraceEnd) = _deadlines(loanId);
        uint256 upAt = scheduledGraceEnd + 2 hours;
        _outage(scheduledGraceEnd - 1 hours, upAt);
        vm.warp(upAt + 10 minutes);

        // The suite's price mocks answer the guard's price read directly and so
        // skip its sequencer check; cleared, the read goes through the guard as
        // deployed and refuses inside the recovery window.
        vm.clearMockedCalls();
        vm.expectRevert(IPriceGuard.SequencerGracePeriod.selector);
        RiskFacet(address(diamond)).calculateHealthFactor(loanId);

        vm.startPrank(borrower);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        RepayFacet(address(diamond)).repayPartial(loanId, PRINCIPAL / 2);
        vm.stopPrank();
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(loanId).principal,
            PRINCIPAL - PRINCIPAL / 2,
            "the partial went through past the scheduled grace end, inside the window"
        );
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Active), "and the loan stays active");
    }

    function test_graceEnd_defaultableOnceTheWindowCloses() public {
        uint256 loanId = _openLoan();
        _wireFeed();
        (, uint256 scheduledGraceEnd) = _deadlines(loanId);
        uint256 upAt = scheduledGraceEnd + 2 hours;
        _outage(scheduledGraceEnd - 1 hours, upAt);

        vm.warp(upAt + RECOVERY);
        assertFalse(DefaultedFacet(address(diamond)).isLoanDefaultable(loanId), "the window end itself is inside");
        vm.warp(upAt + RECOVERY + 1);
        assertTrue(DefaultedFacet(address(diamond)).isLoanDefaultable(loanId), "past the window end");

        vm.startPrank(borrower);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        vm.expectRevert(RepayFacet.RepaymentPastGracePeriod.selector);
        RepayFacet(address(diamond)).repayLoan(loanId);
        vm.stopPrank();
    }

    /// @dev While the sequencer is still down, a grace end it has passed stays
    ///      an hour ahead of now.
    function test_graceEnd_whileDownStaysAheadOfNow() public {
        uint256 loanId = _openLoan();
        _wireFeed();
        (, uint256 scheduledGraceEnd) = _deadlines(loanId);
        seqFeed.setStatus(1, scheduledGraceEnd - 1 hours);
        vm.warp(scheduledGraceEnd + 5 hours);
        (, uint256 graceEnd) = _deadlines(loanId);
        assertEq(graceEnd, vm.getBlockTimestamp() + RECOVERY);
        assertFalse(DefaultedFacet(address(diamond)).isLoanDefaultable(loanId));
    }

    /// @dev A grace end before the outage began is not moved: the borrower
    ///      had the whole grace window.
    function test_graceEnd_beforeTheOutageIsNotMoved() public {
        uint256 loanId = _openLoan();
        _wireFeed();
        (, uint256 scheduledGraceEnd) = _deadlines(loanId);
        _outage(scheduledGraceEnd + 1 hours, scheduledGraceEnd + 2 hours);
        vm.warp(scheduledGraceEnd + 4 hours);
        (, uint256 graceEnd) = _deadlines(loanId);
        assertEq(graceEnd, scheduledGraceEnd);
        assertTrue(DefaultedFacet(address(diamond)).isLoanDefaultable(loanId));
    }

    // ─── 3. The late fee ─────────────────────────────────────────────────────

    /// @dev The maturity falls inside the outage: no fee through the end of
    ///      the recovery window, then the schedule runs from there.
    function test_lateFee_noFeeForTheOutageAroundTheMaturity() public {
        uint256 loanId = _openLoan();
        _wireFeed();
        (uint256 maturity,) = _deadlines(loanId);
        uint256 upAt = maturity + 2 days;
        _outage(maturity - 1 hours, upAt);

        vm.warp(upAt + RECOVERY);
        assertEq(LoanClockProbeFacet(address(diamond)).probeLateFee(loanId), 0, "no fee through the window");
        (uint256 m2,) = _deadlines(loanId);
        assertEq(m2, maturity, "the due date itself does not move");

        vm.warp(upAt + RECOVERY + 1);
        assertEq(
            LoanClockProbeFacet(address(diamond)).probeLateFee(loanId),
            (PRINCIPAL * 100) / 10_000,
            "the first-day rate, from the window end"
        );
        vm.warp(upAt + RECOVERY + 1 days + 1);
        assertEq(LoanClockProbeFacet(address(diamond)).probeLateFee(loanId), (PRINCIPAL * 150) / 10_000);
    }

    /// @dev An outage after the maturity: only the time inside the window is
    ///      taken out of the late time.
    function test_lateFee_outageAfterTheMaturityIsTakenOut() public {
        uint256 loanId = _openLoan();
        _wireFeed();
        (uint256 maturity,) = _deadlines(loanId);
        // 1 day late, then a 2-day outage + 1h recovery, then 1 more day.
        uint256 downAt = maturity + 1 days;
        uint256 upAt = downAt + 2 days;
        _outage(downAt, upAt);
        vm.warp(upAt + RECOVERY + 1 days - 1);
        // Late time counted: 1 day + (1 day - 1 s) < 2 days -> one whole day.
        assertEq(LoanClockProbeFacet(address(diamond)).probeLateFee(loanId), (PRINCIPAL * 150) / 10_000);
        vm.warp(upAt + RECOVERY + 1 days);
        assertEq(LoanClockProbeFacet(address(diamond)).probeLateFee(loanId), (PRINCIPAL * 200) / 10_000);
    }

    function test_lateFee_unchangedWithoutAFeed() public {
        uint256 loanId = _openLoan();
        (uint256 maturity,) = _deadlines(loanId);
        vm.warp(maturity + 2 days + 1);
        assertEq(LoanClockProbeFacet(address(diamond)).probeLateFee(loanId), (PRINCIPAL * 200) / 10_000);
    }

    // ─── 4. Periodic settlement ──────────────────────────────────────────────

    function test_periodic_settleDeadlineNotMovedButSaleWaitsForRecovery() public {
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setPeriodicInterestEnabled(true);
        vm.prank(owner);
        ConfigFacet(address(diamond)).setMaxOfferDurationDays(2 * 365);
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8);
        mockOraclePrice(mockCollateralERC20, 1_000 * 1e8, 8);
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.PeriodicInterestCadence.Monthly, 90, 5 * PRINCIPAL), type(uint64).max
        );
        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
        _wireFeed();

        (,, uint256 scheduled,,,,) = RepayPeriodicFacet(address(diamond)).previewPeriodicSettle(loanId);
        uint256 upAt = scheduled + 3 hours;
        vm.warp(scheduled + 1 hours);
        uint256 quoteBefore = periodicQuote(address(diamond), loanId);
        _outage(scheduled - 30 minutes, upAt);
        vm.warp(upAt + 5 minutes);

        (,, uint256 after_,,,,) = RepayPeriodicFacet(address(diamond)).previewPeriodicSettle(loanId);
        assertEq(after_, scheduled, "the settlement deadline does not move");
        // Inside the recovery window the collateral sale cannot price, so a
        // settler holding a quote from before the outage cannot settle. The
        // suite's price mocks answer the guard's price read directly and so
        // skip its sequencer check; they are cleared here so the settlement
        // reads the guard as deployed, whose first step is that check.
        vm.clearMockedCalls();
        vm.prank(makeAddr("settler"));
        vm.expectRevert(IPriceGuard.SequencerGracePeriod.selector);
        RepayPeriodicFacet(address(diamond)).settlePeriodicInterest(loanId, quoteBefore, defaultAdapterCalls());

        // Control: once the window ends, the same settlement goes through, so
        // the refusal above came from the window and from nothing else.
        vm.warp(upAt + 1 hours + 1);
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8);
        mockOraclePrice(mockCollateralERC20, 1_000 * 1e8, 8);
        uint256 quoteAfter = periodicQuote(address(diamond), loanId);
        vm.prank(makeAddr("settler"));
        RepayPeriodicFacet(address(diamond)).settlePeriodicInterest(loanId, quoteAfter, defaultAdapterCalls());
        assertGt(
            LoanFacet(address(diamond)).getLoanDetails(loanId).lastPeriodicInterestSettledAt,
            0,
            "the period settled after the window"
        );
    }
}
