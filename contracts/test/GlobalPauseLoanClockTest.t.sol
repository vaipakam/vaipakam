// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibPausable} from "../src/libraries/LibPausable.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {RepayPeriodicFacet} from "../src/facets/RepayPeriodicFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {NumeraireConfigFacet} from "../src/facets/NumeraireConfigFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {LoanClockProbeFacet} from "./mocks/LoanClockProbeFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {defaultAdapterCalls} from "./helpers/AdapterCallHelpers.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";

/// @title GlobalPauseLoanClockTest
/// @notice Owner decision D2 (#668 / #935): under a global pause repay and
///         add-collateral stay open, everything else stays paused, and the
///         paused time is added to every open loan's due date and grace end.
///         Covers the pause-interval log ({LibPausable}), the loan clock
///         ({LibLoanClock}) through the facets that read it, and the
///         disclosure getters.
contract GlobalPauseLoanClockTest is SetupTest {
    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant COLLATERAL = 2000 ether;
    uint256 internal constant DURATION_DAYS = 30;
    /// @dev The compile-time grace for a 30-day loan (30 <= d < 90).
    uint256 internal constant GRACE = 3 days;

    AdminFacet internal admin;

    function setUp() public {
        setupHelper();
        admin = AdminFacet(address(diamond));
        // Test-only reads of the late fee and the interest term, so each is
        // measured on its own.
        bytes4[] memory sels = new bytes4[](3);
        sels[0] = LoanClockProbeFacet.probeLateFee.selector;
        sels[1] = LoanClockProbeFacet.probeInterestTermEnd.selector;
        sels[2] = LoanClockProbeFacet.probeRemainingInterestSeconds.selector;
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(new LoanClockProbeFacet()),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sels
        });
        vm.prank(owner);
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _openLoan() internal returns (uint256 loanId) {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: COLLATERAL,
                durationDays: DURATION_DAYS,
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
                collateralAmountMax: COLLATERAL,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
        loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(loanId).status),
            uint8(LibVaipakam.LoanStatus.Active),
            "fixture-live: the loan is active"
        );
    }

    function _deadlines(uint256 loanId)
        internal
        view
        returns (uint256 original, uint256 credit, uint256 maturity, uint256 graceEnd)
    {
        return LoanFacet(address(diamond)).getLoanDeadlines(loanId);
    }

    function _intervals() internal view returns (LibPausable.PauseInterval[] memory iv) {
        (iv, ) = admin.getPauseIntervals(0, 100);
    }

    function _status(uint256 loanId) internal view returns (LibVaipakam.LoanStatus) {
        return LoanFacet(address(diamond)).getLoanDetails(loanId).status;
    }

    // ─── 1. The pause-interval log ───────────────────────────────────────────

    /// @dev `setupHelper` lifts the Diamond's born-paused state, so the log
    ///      already holds that first interval. Every test reads the log
    ///      relative to the count it starts from.
    function test_log_manualPauseRecordsOneClosedInterval() public {
        uint256 n0 = _intervals().length;
        uint256 before = admin.pausedSecondsAt(vm.getBlockTimestamp());
        uint64 t0 = uint64(vm.getBlockTimestamp());

        admin.pause();
        LibPausable.PauseInterval[] memory iv = _intervals();
        assertEq(iv.length, n0 + 1, "a pause opens one interval");
        assertEq(iv[n0].start, t0);
        assertEq(iv[n0].end, LibPausable.OPEN_END, "open while the pause is in force");

        vm.warp(vm.getBlockTimestamp() + 5 days);
        assertEq(admin.pausedSecondsAt(vm.getBlockTimestamp()) - before, 5 days, "an open interval counts up to now");

        vm.expectEmit(address(diamond));
        emit LibPausable.PauseIntervalClosed(t0, t0 + 5 days, uint64(before + 5 days));
        admin.unpause();

        iv = _intervals();
        assertEq(iv.length, n0 + 1, "the unpause closes it, adds none");
        assertEq(iv[n0].end, t0 + 5 days);
        assertEq(iv[n0].pausedBefore, before);

        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertEq(admin.pausedSecondsAt(vm.getBlockTimestamp()) - before, 5 days, "time after the unpause is not counted");
        assertEq(admin.pausedSecondsAt(t0 + 2 days) - before, 2 days, "a read inside the interval counts its part");
    }

    function test_log_autoPauseWindowEndsByItself() public {
        uint256 n0 = _intervals().length;
        uint256 before = admin.pausedSecondsAt(vm.getBlockTimestamp());
        uint256 d = LibVaipakam.AUTO_PAUSE_DURATION_DEFAULT;

        admin.autoPause("anomaly");
        LibPausable.PauseInterval[] memory iv = _intervals();
        assertEq(iv.length, n0 + 1);
        assertEq(iv[n0].end - iv[n0].start, d, "written closed, with the window's own end");

        vm.warp(vm.getBlockTimestamp() + d + 1 days);
        assertFalse(admin.paused(), "fixture-live: the window lapsed");
        assertEq(admin.pausedSecondsAt(vm.getBlockTimestamp()) - before, d, "only the window is counted");
    }

    function test_log_unpauseCutsAnAutoPauseWindowShort() public {
        uint256 n0 = _intervals().length;
        uint256 before = admin.pausedSecondsAt(vm.getBlockTimestamp());
        admin.autoPause("false positive");
        vm.warp(vm.getBlockTimestamp() + 10 minutes);
        admin.unpause();
        LibPausable.PauseInterval[] memory iv = _intervals();
        assertEq(iv.length, n0 + 1);
        assertEq(iv[n0].end - iv[n0].start, 10 minutes, "cut at the unpause");
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertEq(admin.pausedSecondsAt(vm.getBlockTimestamp()) - before, 10 minutes);
    }

    /// @dev A manual pause during a running auto-pause window is the same
    ///      pause continuing: one interval, reopened, never two that overlap.
    function test_log_manualPauseInsideAutoWindowReopensIt() public {
        uint256 n0 = _intervals().length;
        uint256 before = admin.pausedSecondsAt(vm.getBlockTimestamp());
        admin.autoPause("anomaly");
        vm.warp(vm.getBlockTimestamp() + 10 minutes);
        admin.pause();
        LibPausable.PauseInterval[] memory iv = _intervals();
        assertEq(iv.length, n0 + 1, "no second interval");
        assertEq(iv[n0].end, LibPausable.OPEN_END, "reopened");
        vm.warp(vm.getBlockTimestamp() + 2 days);
        admin.unpause();
        assertEq(admin.pausedSecondsAt(vm.getBlockTimestamp()) - before, 2 days + 10 minutes);
    }

    /// @dev An auto-pause fired under the manual pause is covered by the open
    ///      interval and adds nothing to the log.
    function test_log_autoPauseUnderManualPauseAddsNothing() public {
        uint256 n0 = _intervals().length;
        uint256 before = admin.pausedSecondsAt(vm.getBlockTimestamp());
        admin.pause();
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        admin.autoPause("incident");
        assertEq(_intervals().length, n0 + 1, "still one interval");
        vm.warp(vm.getBlockTimestamp() + 3 hours);
        admin.unpause();
        assertEq(admin.pausedSecondsAt(vm.getBlockTimestamp()) - before, 4 hours);
    }

    /// @dev The log's length slot: the namespace's fourth slot (the flags,
    ///      the first-unpause record and the launch gate come first).
    function _logLengthSlot() internal pure returns (bytes32) {
        return bytes32(uint256(LibPausable.PAUSABLE_STORAGE_POSITION) + 3);
    }

    /// @dev A Diamond upgraded in place while paused has a manual pause in
    ///      force and nothing on the log. The unpause records it from the
    ///      boundary the pause stamped.
    function test_log_upgradedWhilePaused_unpauseRecordsThePause() public {
        admin.pause();
        vm.store(address(diamond), _logLengthSlot(), bytes32(0));
        assertEq(
            uint256(vm.load(address(diamond), _logLengthSlot())), 0, "fixture-live: nothing stored, as before the upgrade"
        );
        assertEq(_intervals().length, 1, "the pause in force is still reported");
        vm.warp(vm.getBlockTimestamp() + 2 days);
        admin.unpause();
        assertEq(uint256(vm.load(address(diamond), _logLengthSlot())), 1, "the unpause stored it");
        assertEq(_intervals().length, 1);
        assertEq(admin.pausedSecondsAt(vm.getBlockTimestamp()), 2 days, "the whole pause is recorded");
    }

    /// @dev Same, with an auto-pause fired under that manual pause: the
    ///      auto-pause moves the boundary, so the manual pause is adopted
    ///      first and nothing before the auto-pause is lost.
    function test_log_upgradedWhilePaused_autoPauseDoesNotTruncateThePause() public {
        admin.pause();
        vm.store(address(diamond), _logLengthSlot(), bytes32(0));
        vm.warp(vm.getBlockTimestamp() + 2 days);
        admin.autoPause("incident");
        vm.warp(vm.getBlockTimestamp() + 1 days);
        admin.unpause();
        assertEq(_intervals().length, 1, "one interval");
        assertEq(admin.pausedSecondsAt(vm.getBlockTimestamp()), 3 days, "counted from the manual pause");
    }

    /// @dev #2809 r1 — before that pause is lifted, the clock already counts
    ///      it: the log reports it as its last entry, the loan's credit grows
    ///      with it, and repay stays open past the original grace end.
    function test_log_upgradedWhilePaused_clockCountsThePauseBeforeUnpause() public {
        uint256 loanId = _openLoan();
        uint256 start = vm.getBlockTimestamp();
        vm.warp(start + (DURATION_DAYS - 1) * 1 days);
        admin.pause();
        uint256 pausedAt = vm.getBlockTimestamp();
        vm.store(address(diamond), _logLengthSlot(), bytes32(0));
        vm.warp(pausedAt + 10 days); // past the ORIGINAL grace end, still paused

        LibPausable.PauseInterval[] memory iv = _intervals();
        assertEq(iv.length, 1, "the unrecorded pause is reported");
        assertEq(iv[0].start, pausedAt);
        assertEq(iv[0].end, LibPausable.OPEN_END, "as open");
        (, uint256 credit, , ) = _deadlines(loanId);
        assertEq(credit, 10 days, "credited while it runs");

        vm.startPrank(borrower);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        RepayFacet(address(diamond)).repayLoan(loanId);
        vm.stopPrank();
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Repaid));
    }

    /// @dev #2809 r1 — an auto-pause window set before the log existed is
    ///      counted, and a later pause records it rather than dropping it,
    ///      so a loan's credit never moves backwards.
    function test_log_upgradedDuringAutoPause_windowIsKeptByTheNextPause() public {
        uint256 loanId = _openLoan();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        uint256 n0 = _intervals().length;
        admin.autoPause("incident");
        LibPausable.PauseInterval memory w = _intervals()[n0];
        vm.store(address(diamond), _logLengthSlot(), bytes32(n0)); // drop the window's entry
        vm.warp(uint256(w.end) + 1 days); // the window has lapsed by itself

        (, uint256 creditBefore, , ) = _deadlines(loanId);
        assertGt(creditBefore, 0, "fixture-live: a non-empty window");
        assertEq(creditBefore, w.end - w.start, "the lapsed window is credited");

        admin.pause();
        (, uint256 creditAfter, , ) = _deadlines(loanId);
        assertEq(creditAfter, creditBefore, "the next pause keeps it");
        assertEq(_intervals().length, n0 + 2, "recorded, then the new pause opened");
    }

    function test_getPauseIntervals_pages() public {
        uint256 n0 = _intervals().length;
        for (uint256 i; i < 3; ++i) {
            admin.pause();
            vm.warp(vm.getBlockTimestamp() + 1 hours);
            admin.unpause();
            vm.warp(vm.getBlockTimestamp() + 1 hours);
        }
        (LibPausable.PauseInterval[] memory page, uint256 total) = admin.getPauseIntervals(n0 + 1, 1);
        assertEq(total, n0 + 3);
        assertEq(page.length, 1);
        (page, total) = admin.getPauseIntervals(n0 + 1, 10);
        assertEq(page.length, 2, "a page past the end is shortened");
        (page, ) = admin.getPauseIntervals(total + 5, 10);
        assertEq(page.length, 0, "a page past the log is empty");
    }

    // ─── 2. Repay and add-collateral stay open under a pause ────────────────

    function test_repayLoan_succeedsUnderAGlobalPause() public {
        uint256 loanId = _openLoan();
        vm.warp(vm.getBlockTimestamp() + 10 days);
        admin.pause();
        vm.startPrank(borrower);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        RepayFacet(address(diamond)).repayLoan(loanId);
        vm.stopPrank();
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Repaid), "repaid while paused");
    }

    function test_repayPartial_succeedsUnderAGlobalPause() public {
        uint256 loanId = _openLoan();
        vm.warp(vm.getBlockTimestamp() + 10 days);
        admin.pause();
        vm.startPrank(borrower);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        RepayFacet(address(diamond)).repayPartial(loanId, PRINCIPAL / 2);
        vm.stopPrank();
        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanId).principal, PRINCIPAL / 2, "half repaid while paused");
    }

    function test_addCollateral_succeedsUnderAGlobalPause() public {
        uint256 loanId = _openLoan();
        admin.pause();
        ERC20Mock(mockCollateralERC20).mint(borrower, 100 ether);
        vm.startPrank(borrower);
        ERC20Mock(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        AddCollateralFacet(address(diamond)).addCollateral(loanId, 100 ether);
        vm.stopPrank();
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(loanId).collateralAmount,
            COLLATERAL + 100 ether,
            "topped up while paused"
        );
    }

    function test_defaultStaysPausedUnderAGlobalPause() public {
        uint256 loanId = _openLoan();
        vm.warp(vm.getBlockTimestamp() + DURATION_DAYS * 1 days + GRACE + 1);
        admin.pause();
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());
    }

    // ─── 3. The loan clock ───────────────────────────────────────────────────

    /// @dev A pause that outlasts the grace window: once it is lifted the loan
    ///      is still inside its grace window for as long as the pause lasted,
    ///      and only past the moved grace end may it be defaulted.
    function test_clock_noDefaultRightAfterALongPause() public {
        uint256 loanId = _openLoan();
        uint256 start = vm.getBlockTimestamp();
        vm.warp(start + (DURATION_DAYS - 1) * 1 days);
        admin.pause();
        vm.warp(vm.getBlockTimestamp() + 10 days); // past the ORIGINAL grace end
        admin.unpause();

        (uint256 original, uint256 credit, uint256 maturity, uint256 graceEnd) = _deadlines(loanId);
        assertEq(original, start + DURATION_DAYS * 1 days, "original maturity");
        assertEq(credit, 10 days, "the whole pause is credited");
        assertEq(maturity, original + 10 days);
        assertEq(graceEnd, maturity + GRACE);
        assertGt(vm.getBlockTimestamp(), original + GRACE, "fixture-live: past the original grace end");

        assertFalse(DefaultedFacet(address(diamond)).isLoanDefaultable(loanId), "not defaultable after the pause");
        vm.expectRevert(DefaultedFacet.NotDefaultedYet.selector);
        DefaultedFacet(address(diamond)).triggerDefault(loanId, defaultAdapterCalls());

        vm.warp(graceEnd + 1);
        assertTrue(DefaultedFacet(address(diamond)).isLoanDefaultable(loanId), "defaultable past the moved grace end");
    }

    /// @dev The borrower can still repay after the original grace end, inside
    ///      the moved one.
    function test_clock_repayAllowedInsideTheMovedGraceWindow() public {
        uint256 loanId = _openLoan();
        uint256 start = vm.getBlockTimestamp();
        vm.warp(start + 5 days);
        admin.pause();
        vm.warp(vm.getBlockTimestamp() + 20 days);
        admin.unpause();
        vm.warp(start + DURATION_DAYS * 1 days + GRACE + 5 days); // original grace end + 5 days
        vm.startPrank(borrower);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        RepayFacet(address(diamond)).repayLoan(loanId);
        vm.stopPrank();
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Repaid));
    }

    /// @dev No late fee is charged for paused time: past the original
    ///      maturity but inside the credit, the fee is zero; past the moved
    ///      maturity it is the schedule's first-day rate.
    function test_clock_lateFeeRunsFromTheMovedMaturity() public {
        uint256 loanId = _openLoan();
        uint256 start = vm.getBlockTimestamp();
        vm.warp(start + 2 days);
        admin.pause();
        vm.warp(vm.getBlockTimestamp() + 6 days);
        admin.unpause();

        vm.warp(start + DURATION_DAYS * 1 days + 3 days);
        assertEq(LoanClockProbeFacet(address(diamond)).probeLateFee(loanId), 0, "no fee inside the credit");

        (, , uint256 maturity, ) = _deadlines(loanId);
        vm.warp(maturity + 1);
        assertEq(
            LoanClockProbeFacet(address(diamond)).probeLateFee(loanId),
            (PRINCIPAL * 100) / 10_000,
            "the first-day fee, from the moved maturity"
        );
    }

    /// @dev A pause before the loan started credits it nothing.
    function test_clock_pauseBeforeTheLoanIsNotCredited() public {
        admin.pause();
        vm.warp(vm.getBlockTimestamp() + 4 days);
        admin.unpause();
        uint256 loanId = _openLoan();
        (, uint256 credit, , ) = _deadlines(loanId);
        assertEq(credit, 0);
    }

    /// @dev A pause in force is credited as it runs.
    function test_clock_creditGrowsWhilePaused() public {
        uint256 loanId = _openLoan();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        admin.pause();
        vm.warp(vm.getBlockTimestamp() + 3 days);
        (, uint256 credit, , ) = _deadlines(loanId);
        assertEq(credit, 3 days);
    }

    /// @dev A loan paused for 10 days from day 5, with the clock at `day`.
    function _pausedTenDaysThenAt(uint256 day) internal returns (uint256 loanId) {
        loanId = _openLoan();
        uint256 start = vm.getBlockTimestamp();
        vm.warp(start + 5 days);
        admin.pause();
        vm.warp(vm.getBlockTimestamp() + 10 days);
        admin.unpause();
        vm.warp(start + day * 1 days);
    }

    /// @dev #2809 r1 — a lender may list the loan for sale inside the moved
    ///      term: past the original maturity but before the effective one.
    function test_clock_saleListingOpenInsideTheMovedTerm() public {
        uint256 loanId = _pausedTenDaysThenAt(DURATION_DAYS + 1); // past the ORIGINAL maturity
        vm.prank(lender);
        EarlyWithdrawalFacet(address(diamond)).createLoanSaleOffer(
            loanId, 500, true, uint64(LibVaipakam.MIN_SALE_LISTING_SECONDS)
        );
    }

    /// @dev Past the effective maturity the listing is refused.
    function test_clock_saleListingRefusedPastTheMovedMaturity() public {
        uint256 loanId = _pausedTenDaysThenAt(DURATION_DAYS + 10);
        (, uint256 credit, , ) = _deadlines(loanId);
        assertEq(credit, 10 days, "fixture-live: at the moved maturity");
        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.InvalidSaleOffer.selector);
        EarlyWithdrawalFacet(address(diamond)).createLoanSaleOffer(
            loanId, 500, true, uint64(LibVaipakam.MIN_SALE_LISTING_SECONDS)
        );
    }

    /// @dev #2809 r2 — the interest term a sale or an early close prices a
    ///      rate shortfall over runs to the moved maturity: past the original
    ///      one, nine days are left, not none.
    function test_clock_interestTermRunsToTheMovedMaturity() public {
        uint256 loanId = _pausedTenDaysThenAt(DURATION_DAYS + 1);
        (, , uint256 maturity, ) = _deadlines(loanId);
        LoanClockProbeFacet probe = LoanClockProbeFacet(address(diamond));
        assertEq(probe.probeInterestTermEnd(loanId), maturity, "the term ends at the moved maturity");
        assertEq(probe.probeRemainingInterestSeconds(loanId), 9 days, "nine days of term are left");
    }

    /// @dev A partial repay after a pause consumes no paused day from the
    ///      interest term, so the term still ends at the moved maturity.
    function test_clock_partialRepayAfterAPauseKeepsTheMovedTerm() public {
        uint256 loanId = _pausedTenDaysThenAt(20);
        vm.startPrank(borrower);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        RepayFacet(address(diamond)).repayPartial(loanId, PRINCIPAL / 2);
        vm.stopPrank();
        (, , uint256 maturity, ) = _deadlines(loanId);
        assertEq(
            LoanClockProbeFacet(address(diamond)).probeInterestTermEnd(loanId),
            maturity,
            "the re-stamped term still ends at the moved maturity"
        );
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(loanId).interestRemainingDays,
            20,
            "ten unpaused days consumed, not twenty"
        );
    }

    /// @dev The paid-through mark (`lenderInterestDeliveredThroughAt`) has no
    ///      getter: slot 480 of the Diamond's namespace, per
    ///      `storage-layout/layout.golden.json`. Proved by writing a known
    ///      value through the mutator before it is read.
    function _paidThrough(uint256 loanId) internal view returns (uint256) {
        bytes32 slot = keccak256(abi.encode(loanId, uint256(LibVaipakam.VANGKI_STORAGE_POSITION) + 480));
        return uint256(vm.load(address(diamond), slot));
    }

    /// @dev #2809 r2 P1 — a periodic settlement after a pause pays one
    ///      interval of interest, so it marks the lender paid through the
    ///      UNMOVED period end; the paused stretch stays unpaid. The deadline
    ///      the settlement was due by is the moved one.
    function test_clock_periodicSettlementMarksPaidThroughTheUnmovedPeriodEnd() public {
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setPeriodicInterestEnabled(true);
        vm.prank(owner);
        ConfigFacet(address(diamond)).setMaxOfferDurationDays(2 * 365);
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8);
        mockOraclePrice(mockCollateralERC20, 1_000 * 1e8, 8);
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: 1200,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 5 * PRINCIPAL,
                durationDays: 90,
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
                interestRateBpsMax: 1200,
                collateralAmountMax: 5 * PRINCIPAL,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.Monthly,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
        uint256 start = LoanFacet(address(diamond)).getLoanDetails(loanId).startTime;

        TestMutatorFacet(address(diamond)).setLenderPaidThroughRaw(loanId, 7);
        assertEq(_paidThrough(loanId), 7, "fixture: the slot is the paid-through mark");
        TestMutatorFacet(address(diamond)).setLenderPaidThroughRaw(loanId, 0);

        vm.warp(start + 5 days);
        admin.pause();
        vm.warp(vm.getBlockTimestamp() + 60 days);
        admin.unpause();
        vm.warp(start + 30 days + 60 days + 5 days); // past the moved period end and its grace

        vm.prank(makeAddr("settler"));
        RepayPeriodicFacet(address(diamond)).settlePeriodicInterest(loanId, defaultAdapterCalls());

        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(loanId).lastPeriodicInterestSettledAt,
            start + 30 days,
            "fixture-live: the first period settled"
        );
        assertEq(_paidThrough(loanId), start + 30 days, "paid through the unmoved period end");
    }

    /// @dev #2809 r2 — rent is charged by elapsed day, pause included, so a
    ///      rental's paid use ends on its original schedule: the renter's
    ///      expiry is the ORIGINAL maturity after a pause, and the prepaid
    ///      days run out (and the rental closes) before the moved maturity.
    ///      The pause moved only the late-fee and default deadlines.
    function test_clock_rentalUseEndsWithThePrepaidDays() public {
        uint256 rentalDays = 7;
        uint256 dailyFee = 10 ether;
        uint256 rent = dailyFee * rentalDays;
        uint256 totalPrepay = rent + (rent * 500) / 10_000;
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockNft721,
                amount: dailyFee,
                interestRateBps: 0,
                collateralAsset: mockERC20,
                collateralAmount: totalPrepay,
                durationDays: rentalDays,
                assetType: LibVaipakam.AssetType.ERC721,
                tokenId: 1,
                quantity: 1,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: dailyFee,
                interestRateBpsMax: 0,
                collateralAmountMax: totalPrepay,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
        uint256 start = LoanFacet(address(diamond)).getLoanDetails(loanId).startTime;

        vm.warp(start + 2 days);
        admin.pause();
        vm.warp(vm.getBlockTimestamp() + 5 days);
        admin.unpause();
        (uint256 original, uint256 credit, uint256 maturity, ) = _deadlines(loanId);
        assertEq(credit, 5 days, "fixture-live: the pause is credited");

        vm.warp(start + rentalDays * 1 days);
        RepayPeriodicFacet(address(diamond)).autoDeductDaily(loanId);
        assertEq(
            MockRentableNFT721(mockNft721).userExpires(1),
            original,
            "the renter's use ends at the original maturity"
        );
        for (uint256 i = 1; i < rentalDays; i++) {
            RepayPeriodicFacet(address(diamond)).autoDeductDaily(loanId);
        }
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Repaid), "closed with the prepaid days");
        assertLt(vm.getBlockTimestamp(), maturity, "before the moved maturity");
    }

    // ─── 4. Disclosure ───────────────────────────────────────────────────────

    function test_getLoanDeadlines_refusesALoanThatIsNotActive() public {
        vm.expectRevert(IVaipakamErrors.InvalidLoanStatus.selector);
        LoanFacet(address(diamond)).getLoanDeadlines(999);

        uint256 loanId = _openLoan();
        vm.startPrank(borrower);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        RepayFacet(address(diamond)).repayLoan(loanId);
        vm.stopPrank();
        vm.expectRevert(IVaipakamErrors.InvalidLoanStatus.selector);
        LoanFacet(address(diamond)).getLoanDeadlines(loanId);
    }

    function test_pauseRolesStillGateTheLog() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert();
        admin.pause();
        assertEq(AccessControlFacet(address(diamond)).hasRole(LibAccessControl.PAUSER_ROLE, stranger), false);
    }
}
