// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferMatchIntentFacet} from "../src/facets/OfferMatchIntentFacet.sol";
import {RiskPreviewFacet} from "../src/facets/RiskPreviewFacet.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {LoanClockFacet} from "../src/facets/LoanClockFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {LibMetricsTypes} from "../src/libraries/LibMetricsTypes.sol";
import {LibTiming} from "../src/libraries/LibTiming.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LibTestTiming} from "./helpers/LibTestTiming.sol";
import {LibTestPayout} from "./helpers/LibTestPayout.sol";
import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";
import {AutoLifecycleFacet} from "../src/facets/AutoLifecycleFacet.sol";
import {AutoLifecycleSettingsFacet} from "../src/facets/AutoLifecycleSettingsFacet.sol";

/**
 * @title  LenderIntentLendUntilTest
 * @notice #3618 / #3619 — a standing lender intent's lend-until time and its
 *         pro-rata opt-in. The lend-until time bounds each fill's AGREED
 *         maturity and stops rolls once no further loan fits; the opt-in lets
 *         the intent fill pro-rata requests, including partial-repay ones,
 *         whose partial repayments are paid to the position holder and leave
 *         the intent. Every refusal is checked on the live fill and on
 *         `previewIntent`, which must agree.
 * @dev    Offers are posted BEFORE the intent is set, so the only time that
 *         passes before a fill is the intent's own terms-age wait (seconds);
 *         each lend-until time carries an hour of slack over it.
 */
contract LenderIntentLendUntilTest is SetupTest {
    address internal solver;

    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant MAX_EXPOSURE = 10_000 ether;
    uint256 internal constant MIN_RATE_BPS = 500;
    uint16 internal constant MAX_INIT_LTV_BPS = 5000;
    uint32 internal constant MAX_DURATION = 60;
    uint256 internal constant MIN_FILL = 100 ether;
    uint256 internal constant SLACK = 1 hours;

    function setUp() public {
        setupHelper();
        solver = makeAddr("intentSolver");
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        vm.prank(owner);
        LenderIntentFacet(address(diamond)).setLenderIntentEnabled(true);
    }

    // ─── helpers ────────────────────────────────────────────────────────

    function _setIntent(uint64 lendUntil, bool acceptsProRata) internal {
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20,
            mockCollateralERC20,
            0,
            MAX_EXPOSURE,
            MIN_RATE_BPS,
            MAX_INIT_LTV_BPS,
            MAX_DURATION,
            MIN_FILL,
            false, // requiresKeeperAuth
            lendUntil,
            acceptsProRata,
            true, // riskAndTermsConsent
            type(uint64).max
        );
        LibTestTiming.waitOutIntentAge(address(diamond), lender, mockERC20, mockCollateralERC20);
    }

    function _fundIntent(uint256 amount) internal {
        ERC20Mock(mockERC20).mint(lender, amount);
        vm.prank(lender);
        ERC20(mockERC20).approve(address(diamond), amount);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).fundLenderIntent(mockERC20, mockCollateralERC20, 0, amount);
    }

    function _newBorrower(string memory name) internal returns (address b) {
        b = makeAddr(name);
        ERC20Mock(mockERC20).mint(b, 1_000_000 ether);
        ERC20Mock(mockCollateralERC20).mint(b, 1_000_000 ether);
        vm.prank(b);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(b);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(b);
        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(b, LibVaipakam.KYCTier.Tier2);
    }

    function _postBorrower(address creator, uint256 principal, uint32 duration, bool fullTerm, bool partialRepay)
        internal
        returns (uint256 offerId)
    {
        vm.prank(creator);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                lifecycleFlex: 0,
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: principal,
                interestRateBps: MIN_RATE_BPS,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 2 * principal,
                durationDays: duration,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: partialRepay,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: principal,
                interestRateBpsMax: MIN_RATE_BPS + 100,
                collateralAmountMax: 2 * principal,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: fullTerm
            }),
            type(uint64).max
        );
        LibTestTiming.waitOutTermsAge(address(diamond), offerId);
    }

    function _post(string memory name, uint256 principal, uint32 duration) internal returns (address b, uint256 id) {
        b = _newBorrower(name);
        id = _postBorrower(b, principal, duration, true, false);
    }

    function _preview(uint256 cp, uint256 fill) internal view returns (LibOfferMatch.IntentPreviewResult memory) {
        return RiskPreviewFacet(address(diamond)).previewIntent(
            solver, solver, lender, mockERC20, mockCollateralERC20, 0, cp, fill
        );
    }

    function _fill(uint256 cp, uint256 fill) internal returns (uint256) {
        LibOfferMatch.IntentPreviewResult memory r = _preview(cp, fill);
        assertTrue(r.ok, "preview admits the fill");
        vm.prank(solver);
        return OfferMatchIntentFacet(address(diamond)).matchIntent(lender, mockERC20, mockCollateralERC20, 0, cp, fill);
    }

    /// @dev The fill is refused for the lend-until time, by the preview and
    ///      by the live fill with the maturity it would have had.
    function _assertPastLendUntil(uint256 cp, uint256 fill, uint32 duration, uint64 lendUntil) internal {
        LibOfferMatch.IntentPreviewResult memory r = _preview(cp, fill);
        assertFalse(r.ok, "preview refuses");
        assertEq(uint8(r.intentError), uint8(LibOfferMatch.IntentError.PastLendUntil), "preview names the end date");
        vm.prank(solver);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferMatchIntentFacet.LenderIntentPastLendUntil.selector,
                vm.getBlockTimestamp() + uint256(duration) * 1 days,
                uint256(lendUntil)
            )
        );
        OfferMatchIntentFacet(address(diamond)).matchIntent(lender, mockERC20, mockCollateralERC20, 0, cp, fill);
    }

    function _intentCapital() internal view returns (uint256) {
        return LenderIntentFacet(address(diamond)).getLenderIntentCapital(lender, mockERC20, mockCollateralERC20, 0);
    }

    function _livePrincipal() internal view returns (uint256) {
        return LenderIntentFacet(address(diamond)).getLenderIntentLivePrincipal(lender, mockERC20, mockCollateralERC20, 0);
    }

    function _vaultHolding(address user) internal view returns (uint256) {
        return VaultFactoryFacet(address(diamond)).getTrackedHolding(user, mockERC20, 0);
    }

    // ─── #3618 — lend-until time ────────────────────────────────────────

    /// @dev No end date: the summary reads 0 / false and a full-length term
    ///      fills exactly as before.
    function test_noLendUntil_behavesAsBefore() public {
        (, uint256 cp) = _post("b0", PRINCIPAL, MAX_DURATION);
        _setIntent(0, false);
        _fundIntent(PRINCIPAL);
        (LibMetricsTypes.LenderIntentSummary[] memory rows,) =
            LenderIntentFacet(address(diamond)).getActiveLenderIntents(0, 10);
        assertEq(rows.length, 1, "listed");
        assertEq(rows[0].lendUntil, 0, "no end date in the feed");
        assertFalse(rows[0].acceptsProRata, "no pro-rata opt-in in the feed");
        assertGt(_fill(cp, PRINCIPAL), 0, "a 60-day term fills without an end date");
    }

    /// @dev A term that ends inside the window fills; one a day longer is
    ///      refused by the preview and the fill alike.
    function test_fitsAndOneDayTooLong() public {
        (, uint256 fits) = _post("b-fit", PRINCIPAL, 30);
        (, uint256 tooLong) = _post("b-long", PRINCIPAL, 31);
        uint64 lendUntil = uint64(vm.getBlockTimestamp() + 30 days + SLACK);
        _setIntent(lendUntil, false);
        _fundIntent(2 * PRINCIPAL);

        _assertPastLendUntil(tooLong, PRINCIPAL, 31, lendUntil);
        assertGt(_fill(fits, PRINCIPAL), 0, "the 30-day term fits");
        LibVaipakam.LenderIntent memory i =
            LenderIntentFacet(address(diamond)).getLenderIntent(lender, mockERC20, mockCollateralERC20, 0);
        assertEq(i.lendUntil, lendUntil, "stored");
    }

    /// @dev The window shrinks as time passes, with no state change: a term
    ///      that fitted on day 0 is refused on day 5.
    function test_windowShrinksOverTime() public {
        (, uint256 cp) = _post("b-shrink", PRINCIPAL, 30);
        uint64 lendUntil = uint64(vm.getBlockTimestamp() + 30 days + SLACK);
        _setIntent(lendUntil, false);
        _fundIntent(PRINCIPAL);
        assertTrue(_preview(cp, PRINCIPAL).ok, "fits on day 0");
        vm.warp(vm.getBlockTimestamp() + 5 days);
        _assertPastLendUntil(cp, PRINCIPAL, 30, lendUntil);
    }

    /// @dev The owner's example: a 30-day window; a 20-day loan repaid on day
    ///      20 is rolled; then a 7-day and a 10-day request fill and an 11-day
    ///      one is refused.
    function test_ownersExample_rollThenShortTermsOnly() public {
        (address b20, uint256 cp20) = _post("b-20", PRINCIPAL, 20);
        (, uint256 cp7) = _post("b-7", 400 ether, 7);
        (, uint256 cp10) = _post("b-10", 400 ether, 10);
        (, uint256 cp11) = _post("b-11", 100 ether, 11);
        uint256 start = vm.getBlockTimestamp();
        uint64 lendUntil = uint64(start + 30 days + SLACK);
        _setIntent(lendUntil, false);
        _fundIntent(PRINCIPAL);

        uint256 loanId = _fill(cp20, PRINCIPAL);
        vm.warp(start + 20 days);
        vm.prank(b20);
        RepayFacet(address(diamond)).repayLoan(loanId);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).rollIntentLoan(loanId);
        assertGt(_intentCapital(), PRINCIPAL, "principal and interest back behind the intent");

        assertGt(_fill(cp7, 400 ether), 0, "a 7-day term fits on day 20");
        assertGt(_fill(cp10, 400 ether), 0, "a 10-day term fits on day 20");
        _assertPastLendUntil(cp11, 100 ether, 11, lendUntil);
    }

    /// @dev Once less than a day of the window is left the roll is refused,
    ///      the roll feed drops the loan, and the normal claim pays the lender
    ///      the whole lender claim.
    function test_rollRefusedAfterWindow_claimPaysInFull() public {
        (address b, uint256 cp) = _post("b-end", PRINCIPAL, 30);
        uint256 start = vm.getBlockTimestamp();
        uint64 lendUntil = uint64(start + 30 days + SLACK);
        _setIntent(lendUntil, false);
        _fundIntent(PRINCIPAL);
        uint256 loanId = _fill(cp, PRINCIPAL);

        vm.warp(start + 29 days + 12 hours);
        vm.prank(b);
        RepayFacet(address(diamond)).repayLoan(loanId);

        (LibMetricsTypes.RollableIntentLoan[] memory rows, uint256 total) =
            LenderIntentFacet(address(diamond)).getRollableIntentLoans(0, 10);
        assertEq(total, 1, "still registered");
        assertEq(rows.length, 0, "an ended intent offers no roll");

        vm.prank(lender);
        vm.expectRevert(LenderIntentFacet.LenderIntentEnded.selector);
        LenderIntentFacet(address(diamond)).rollIntentLoan(loanId);

        (, uint256 owed,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertGt(owed, PRINCIPAL, "principal plus interest owed");
        // The claim settles into the position holder's vault (here the same
        // vault the repayment landed in), as free balance, not intent capital.
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        (,, bool claimed) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertTrue(claimed, "the normal claim consumed the lender claim");
        assertGe(_vaultHolding(lender), owed, "the whole claim sits in the lender's vault");
        assertEq(_intentCapital(), 0, "nothing re-committed behind the ended intent");
        assertEq(_livePrincipal(), 0, "exposure released once");
    }

    /// @dev The fill feed lists an intent only while its window can still take
    ///      a one-day loan; the registry count is unchanged, so paging holds.
    function test_fillFeedDropsClosedWindow() public {
        uint256 start = vm.getBlockTimestamp();
        _setIntent(uint64(start + 2 days + SLACK), false);
        _fundIntent(PRINCIPAL);
        (LibMetricsTypes.LenderIntentSummary[] memory rows, uint256 total) =
            LenderIntentFacet(address(diamond)).getActiveLenderIntents(0, 10);
        assertEq(total, 1, "registered");
        assertEq(rows.length, 1, "listed while open");
        assertEq(rows[0].lendUntil, uint64(start + 2 days + SLACK), "summary carries the date");

        vm.warp(start + 1 days + SLACK);
        (rows,) = LenderIntentFacet(address(diamond)).getActiveLenderIntents(0, 10);
        assertEq(rows.length, 1, "exactly one day left still lists");

        vm.warp(start + 1 days + SLACK + 1);
        (rows, total) = LenderIntentFacet(address(diamond)).getActiveLenderIntents(0, 10);
        assertEq(total, 1, "still registered, capital withdrawable");
        assertEq(rows.length, 0, "a closed window is not listed");
    }

    /// @dev A date less than a day ahead is refused; re-setting the date is a
    ///      re-set of the terms, so the terms-age wait starts again.
    function test_setRules_minimumWindowAndTermsAge() public {
        vm.prank(lender);
        vm.expectRevert(LenderIntentFacet.LenderIntentInvalidBounds.selector);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, 0, MAX_EXPOSURE, MIN_RATE_BPS, MAX_INIT_LTV_BPS,
            MAX_DURATION, MIN_FILL, false, uint64(vm.getBlockTimestamp() + 1 days - 1), false, true, type(uint64).max
        );
        // The window is measured from when the new terms may be filled: one
        // day from now is too short while the terms-age wait runs, one day
        // from the end of that wait is the minimum.
        vm.prank(owner);
        ConfigFacet(address(diamond)).setMinTermsAgeSec(60);
        vm.prank(lender);
        vm.expectRevert(LenderIntentFacet.LenderIntentInvalidBounds.selector);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, 0, MAX_EXPOSURE, MIN_RATE_BPS, MAX_INIT_LTV_BPS,
            MAX_DURATION, MIN_FILL, false, uint64(vm.getBlockTimestamp() + 1 days + 59), false, true, type(uint64).max
        );
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, 0, MAX_EXPOSURE, MIN_RATE_BPS, MAX_INIT_LTV_BPS,
            MAX_DURATION, MIN_FILL, false, uint64(vm.getBlockTimestamp() + 1 days + 60), false, true, type(uint64).max
        );
        (, uint256 cp) = _post("b-age", PRINCIPAL, 1);
        _setIntent(uint64(vm.getBlockTimestamp() + 1 days + SLACK), false);
        _fundIntent(PRINCIPAL);
        assertTrue(_preview(cp, PRINCIPAL).ok, "aged terms fill");

        vm.prank(lender);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, 0, MAX_EXPOSURE, MIN_RATE_BPS, MAX_INIT_LTV_BPS,
            MAX_DURATION, MIN_FILL, false, uint64(vm.getBlockTimestamp() + 2 days), false, true, type(uint64).max
        );
        LibOfferMatch.IntentPreviewResult memory r = _preview(cp, PRINCIPAL);
        assertEq(uint8(r.intentError), uint8(LibOfferMatch.IntentError.TermsTooFresh), "a new date restarts the wait");
    }

    /// @dev A pause during a loan moves its maturity past the lend-until time
    ///      and reverts nothing: the date bounds AGREED maturity only.
    function test_pauseMovesMaturityPastLendUntil() public {
        (address b, uint256 cp) = _post("b-pause", PRINCIPAL, 30);
        uint64 lendUntil = uint64(vm.getBlockTimestamp() + 30 days + SLACK);
        _setIntent(lendUntil, false);
        _fundIntent(PRINCIPAL);
        uint256 loanId = _fill(cp, PRINCIPAL);

        AdminFacet(address(diamond)).pause();
        vm.warp(vm.getBlockTimestamp() + 2 days);
        AdminFacet(address(diamond)).unpause();

        (uint256 agreed,, uint256 maturity,) = LoanClockFacet(address(diamond)).getLoanDeadlines(loanId);
        assertLe(agreed, lendUntil, "agreed inside the window");
        assertGt(maturity, lendUntil, "the pause moved it past the window");
        vm.prank(b);
        RepayFacet(address(diamond)).repayLoan(loanId);
    }

    // ─── #3619 — pro-rata opt-in ────────────────────────────────────────

    /// @dev Without the opt-in a pro-rata request is refused; with it the
    ///      request fills as pro-rata, and a full-term request still fills as
    ///      full-term.
    function test_proRataOptIn_fillsBothModes() public {
        address bp = _newBorrower("b-pr");
        uint256 cpProRata = _postBorrower(bp, PRINCIPAL, 30, false, false);
        (, uint256 cpFull) = _post("b-ft", PRINCIPAL, 30);

        _setIntent(0, false);
        _fundIntent(2 * PRINCIPAL);
        LibOfferMatch.IntentPreviewResult memory r = _preview(cpProRata, PRINCIPAL);
        assertEq(uint8(r.intentError), uint8(LibOfferMatch.IntentError.FullTermRequired), "off: refused");
        vm.prank(solver);
        vm.expectRevert(OfferMatchIntentFacet.LenderIntentFullTermRequired.selector);
        OfferMatchIntentFacet(address(diamond)).matchIntent(lender, mockERC20, mockCollateralERC20, 0, cpProRata, PRINCIPAL);

        _setIntent(0, true);
        uint256 proRataLoan = _fill(cpProRata, PRINCIPAL);
        assertFalse(LoanFacet(address(diamond)).getLoanDetails(proRataLoan).useFullTermInterest, "loan is pro-rata");
        uint256 fullLoan = _fill(cpFull, PRINCIPAL);
        assertTrue(LoanFacet(address(diamond)).getLoanDetails(fullLoan).useFullTermInterest, "loan is full-term");
    }

    /// @dev An early repay of a pro-rata intent loan pays accrued interest
    ///      only, and the roll re-commits exactly what the vault received.
    function test_proRataEarlyRepay_rollRecommitsWhatArrived() public {
        address b = _newBorrower("b-early");
        uint256 cp = _postBorrower(b, PRINCIPAL, 30, false, false);
        _setIntent(0, true);
        _fundIntent(PRINCIPAL);
        uint256 loanId = _fill(cp, PRINCIPAL);

        vm.warp(vm.getBlockTimestamp() + 10 days);
        uint256 vaultBefore = _vaultHolding(lender);
        vm.prank(b);
        RepayFacet(address(diamond)).repayLoan(loanId);
        uint256 arrived = _vaultHolding(lender) - vaultBefore;
        (, uint256 owed,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertEq(owed, arrived, "the claim is what arrived");
        // Ten days of a 30-day term at 5-6% APR: well under full-term interest.
        assertLt(arrived - PRINCIPAL, (PRINCIPAL * 600 * 30) / (10_000 * 365), "accrued interest only");

        uint256 capitalBefore = _intentCapital();
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).rollIntentLoan(loanId);
        assertEq(_intentCapital() - capitalBefore, arrived, "the roll re-commits exactly what arrived");
    }

    /// @dev Partial repayment is refused on a full-term request whether or
    ///      not the intent opted in, and on a pro-rata request without it.
    function test_partialRepay_refusedCases() public {
        address b1 = _newBorrower("b-ft-partial");
        uint256 cpFullPartial = _postBorrower(b1, PRINCIPAL, 30, true, true);
        address b2 = _newBorrower("b-pr-partial");
        uint256 cpProRataPartial = _postBorrower(b2, PRINCIPAL, 30, false, true);

        _setIntent(0, false);
        _fundIntent(PRINCIPAL);
        assertEq(
            uint8(_preview(cpFullPartial, PRINCIPAL).intentError),
            uint8(LibOfferMatch.IntentError.PartialRepayNotAllowed),
            "off, full-term partial"
        );
        vm.prank(solver);
        vm.expectRevert(OfferMatchIntentFacet.LenderIntentPartialRepayNotAllowed.selector);
        OfferMatchIntentFacet(address(diamond)).matchIntent(lender, mockERC20, mockCollateralERC20, 0, cpFullPartial, PRINCIPAL);
        assertEq(
            uint8(_preview(cpProRataPartial, PRINCIPAL).intentError),
            uint8(LibOfferMatch.IntentError.FullTermRequired),
            "off, pro-rata partial"
        );
        vm.prank(solver);
        vm.expectRevert(OfferMatchIntentFacet.LenderIntentFullTermRequired.selector);
        OfferMatchIntentFacet(address(diamond)).matchIntent(lender, mockERC20, mockCollateralERC20, 0, cpProRataPartial, PRINCIPAL);

        _setIntent(0, true);
        assertEq(
            uint8(_preview(cpFullPartial, PRINCIPAL).intentError),
            uint8(LibOfferMatch.IntentError.PartialRepayNotAllowed),
            "on, full-term partial"
        );
        vm.prank(solver);
        vm.expectRevert(OfferMatchIntentFacet.LenderIntentPartialRepayNotAllowed.selector);
        OfferMatchIntentFacet(address(diamond)).matchIntent(lender, mockERC20, mockCollateralERC20, 0, cpFullPartial, PRINCIPAL);
    }

    /// @dev Opted in, a pro-rata request allowing partial repayment fills. A
    ///      partial repayment is paid to the position holder's wallet (not the
    ///      vault, nothing re-committed) and leaves exposure untouched; after
    ///      the final repayment the roll re-commits only what the lender claim
    ///      holds, and exposure drops by the original fill exactly once.
    /// @dev #3629 — a partial repayment is held for the lender position in the
    ///      owner's vault (never paid to a wallet), and the roll at full
    ///      repayment re-commits the final claim plus everything still held.
    function test_partialRepay_admittedForOptedInProRata() public {
        (uint256 loanId, address b) = _proRataLoan("b-partial");

        vm.warp(vm.getBlockTimestamp() + 5 days);
        uint256 walletBefore = ERC20(mockERC20).balanceOf(lender);
        uint256 vaultBefore = _vaultHolding(lender);
        uint256 capitalBefore = _intentCapital();
        vm.prank(b);
        RepayFacet(address(diamond)).repayPartial(loanId, 400 ether);
        uint256 held = _lenderHeld(loanId);
        assertGt(held, 400 ether, "the slice and its interest are held for the position");
        assertEq(ERC20(mockERC20).balanceOf(lender), walletBefore, "nothing paid to the wallet");
        assertEq(_vaultHolding(lender) - vaultBefore, held, "held in the owner's vault");
        assertEq(_intentCapital(), capitalBefore, "nothing re-committed yet");
        assertEq(_livePrincipal(), PRINCIPAL, "exposure unchanged until the loan closes");

        vm.warp(vm.getBlockTimestamp() + 5 days);
        vm.prank(b);
        RepayFacet(address(diamond)).repayLoan(loanId);
        (, uint256 owed,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertLt(owed, PRINCIPAL, "the claim carries only the remainder");
        assertGt(owed, PRINCIPAL - 400 ether, "remainder plus its interest");

        vm.prank(lender);
        LenderIntentFacet(address(diamond)).rollIntentLoan(loanId);
        assertEq(_intentCapital() - capitalBefore, owed + held, "the roll re-commits the claim and the held part");
        assertEq(_lenderHeld(loanId), 0, "nothing left held");
        assertEq(_livePrincipal(), 0, "exposure released by the original fill, once");
    }

    /// @dev #3629 — the held part goes back behind the intent while the loan
    ///      runs; the loan stays open and its exposure is unchanged.
    function test_recommitHeldToIntent_whileOpen() public {
        (uint256 loanId, address b) = _proRataLoan("b-recommit");
        vm.warp(vm.getBlockTimestamp() + 5 days);
        vm.prank(b);
        RepayFacet(address(diamond)).repayPartial(loanId, 400 ether);
        uint256 held = _lenderHeld(loanId);
        uint256 capitalBefore = _intentCapital();
        (LibMetricsTypes.RollableIntentLoan[] memory rows,) =
            LenderIntentFacet(address(diamond)).getRollableIntentLoans(0, 50);
        assertEq(rows.length, 1, "the open loan with a held payment is a candidate");
        assertTrue(rows[0].open, "marked open");
        assertEq(rows[0].held, held, "with what is held");

        vm.prank(lender);
        LenderIntentFacet(address(diamond)).recommitHeldToIntent(loanId);
        assertEq(_intentCapital() - capitalBefore, held, "the held part is intent capital again");
        assertEq(_lenderHeld(loanId), 0, "nothing left held");
        assertEq(_livePrincipal(), PRINCIPAL, "exposure unchanged until the loan closes");
        assertEq(
            uint256(LoanFacet(address(diamond)).getLoanDetails(loanId).status),
            uint256(LibVaipakam.LoanStatus.Active),
            "the loan runs on"
        );

        vm.prank(lender);
        vm.expectRevert(LenderIntentFacet.LenderIntentNothingToRoll.selector);
        LenderIntentFacet(address(diamond)).recommitHeldToIntent(loanId);
    }

    /// @dev #3629 — a stranger cannot re-commit the owner's held payments, and
    ///      a cancelled intent sends them to the holder's claim instead.
    function test_recommitHeldToIntent_refusals() public {
        (uint256 loanId, address b) = _proRataLoan("b-recommit-refused");
        vm.warp(vm.getBlockTimestamp() + 5 days);
        vm.prank(b);
        RepayFacet(address(diamond)).repayPartial(loanId, 400 ether);

        vm.prank(b);
        vm.expectRevert(IVaipakamErrors.KeeperAccessRequired.selector);
        LenderIntentFacet(address(diamond)).recommitHeldToIntent(loanId);

        vm.prank(lender);
        LenderIntentFacet(address(diamond)).cancelLenderIntent(mockERC20, mockCollateralERC20, 0);
        vm.prank(lender);
        vm.expectRevert(LenderIntentFacet.LenderIntentLoanNotRollable.selector);
        LenderIntentFacet(address(diamond)).recommitHeldToIntent(loanId);

        uint256 held = _lenderHeld(loanId);
        uint256 vaultBefore = _vaultHolding(lender);
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimHeldForLender(loanId);
        assertEq(_lenderHeld(loanId), 0, "claimed instead");
        assertEq(_vaultHolding(lender), vaultBefore, "the held funds were already in the holder's vault");
        assertGt(held, 0);
    }

    function _proRataLoan(string memory name) internal returns (uint256 loanId, address b) {
        b = _newBorrower(name);
        uint256 cp = _postBorrower(b, PRINCIPAL, 30, false, true);
        _setIntent(0, true);
        _fundIntent(PRINCIPAL);
        loanId = _fill(cp, PRINCIPAL);
        assertTrue(LoanFacet(address(diamond)).getLoanDetails(loanId).allowsPartialRepay, "loan allows partial repay");
        assertEq(_livePrincipal(), PRINCIPAL, "exposure out");
    }

    function _lenderHeld(uint256 loanId) internal view returns (uint256 amount) {
        (, , , , , , amount, ) = ClaimFacet(address(diamond)).getClaimable(loanId, true);
    }

    // ─── #3618 follow-up — the lend-until time bounds an extension ──────

    /// @dev A 20-day intent loan with both sides' auto-extend caps wide open
    ///      (rate 0–10%, expiry 400 days) and an extension reserve, so only
    ///      the intent's lend-until time can refuse the extension.
    function _extendableIntentLoan(uint64 lendUntil) internal returns (uint256 loanId, address b) {
        uint256 cp;
        (b, cp) = _post("b-ext", PRINCIPAL, 20);
        _setIntent(lendUntil, false);
        _fundIntent(PRINCIPAL);
        loanId = _fill(cp, PRINCIPAL);
        LibTestPayout.withdrawAllFree(address(diamond), b);

        uint64 farExpiry = uint64(vm.getBlockTimestamp() + 400 days);
        vm.prank(b);
        AutoLifecycleSettingsFacet(address(diamond)).setAutoExtendBorrowerCaps(loanId, true, 0, 1000, farExpiry, type(uint256).max);
        vm.prank(lender);
        AutoLifecycleSettingsFacet(address(diamond)).setAutoExtendLenderCaps(loanId, true, 0, 1000, farExpiry);

        ERC20Mock(mockERC20).mint(b, 50 ether);
        vm.startPrank(b);
        ERC20(mockERC20).approve(address(diamond), 50 ether);
        AutoLifecycleFacet(address(diamond)).fundExtendReserve(loanId, 50 ether);
        vm.stopPrank();
    }

    function _extend(address b, uint256 loanId, uint256 days_) internal {
        vm.prank(b);
        AutoLifecycleFacet(address(diamond)).extendLoanInPlace(loanId, uint16(MIN_RATE_BPS), days_);
    }

    /// @dev An extension ending exactly at the lend-until time is taken; one
    ///      second later is refused, naming both times. The bound view
    ///      reports the time the executor uses.
    function test_extend_boundByLendUntil() public {
        uint64 lendUntil = uint64(vm.getBlockTimestamp() + 30 days + SLACK);
        (uint256 loanId, address b) = _extendableIntentLoan(lendUntil);
        assertEq(
            AutoLifecycleFacet(address(diamond)).getAutoExtendLendUntil(loanId), lendUntil, "the view reports the bound"
        );

        uint256 snap = vm.snapshotState();
        vm.warp(uint256(lendUntil) - 13 days + 1);
        vm.prank(b);
        vm.expectRevert(
            abi.encodeWithSelector(AutoLifecycleFacet.AutoExtendPastLendUntil.selector, uint256(lendUntil) + 1, lendUntil)
        );
        AutoLifecycleFacet(address(diamond)).extendLoanInPlace(loanId, uint16(MIN_RATE_BPS), 13);
        vm.revertToState(snap);

        vm.warp(uint256(lendUntil) - 13 days);
        _extend(b, loanId, 13);
        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanId).durationDays, 13, "extended to the end date");
        (,, uint256 maturity,) = LoanClockFacet(address(diamond)).getLoanDeadlines(loanId);
        assertEq(maturity, lendUntil, "ends exactly then");
    }

    /// @dev The owner's latest choice counts: clearing the lend-until time on
    ///      the intent lifts the bound for loans it already made.
    function test_extend_readsTheIntentLive() public {
        uint64 lendUntil = uint64(vm.getBlockTimestamp() + 30 days + SLACK);
        (uint256 loanId, address b) = _extendableIntentLoan(lendUntil);
        _setIntent(0, false);
        assertEq(AutoLifecycleFacet(address(diamond)).getAutoExtendLendUntil(loanId), 0, "no end date, no bound");
        vm.warp(uint256(lendUntil) - 13 days);
        _extend(b, loanId, 30);
        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanId).durationDays, 30, "extended past the old date");
    }

    /// @dev An intent with no lend-until time leaves extensions to the caps.
    function test_extend_noLendUntilUnbound() public {
        (uint256 loanId, address b) = _extendableIntentLoan(0);
        assertEq(AutoLifecycleFacet(address(diamond)).getAutoExtendLendUntil(loanId), 0, "no bound");
        (uint64 opensAt,) = AutoLifecycleFacet(address(diamond)).getAutoExtendWindow(loanId);
        vm.warp(opensAt);
        _extend(b, loanId, 60);
        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanId).durationDays, 60, "a long extension is taken");
    }

    /// @dev Once the intent's owner no longer holds the lender position the
    ///      holder agreed to no end date, so nothing binds. The position NFT
    ///      only moves through the sale flow; the holder is mocked here, as in
    ///      the roll's sold-position test.
    function test_extend_soldPositionUnbound() public {
        uint64 lendUntil = uint64(vm.getBlockTimestamp() + 30 days + SLACK);
        (uint256 loanId,) = _extendableIntentLoan(lendUntil);
        uint256 tok = LoanFacet(address(diamond)).getLoanDetails(loanId).lenderTokenId;
        LibTestPositionNFT.mockHolder(address(diamond), tok, makeAddr("positionBuyer"));
        assertEq(AutoLifecycleFacet(address(diamond)).getAutoExtendLendUntil(loanId), 0, "a sold position is unbound");
        vm.clearMockedCalls();
        assertEq(AutoLifecycleFacet(address(diamond)).getAutoExtendLendUntil(loanId), lendUntil, "bound again once held");
    }

    /// @dev A loan no intent made is never bound.
    function test_extend_nonIntentLoanUnbound() public {
        assertEq(AutoLifecycleFacet(address(diamond)).getAutoExtendLendUntil(type(uint64).max), 0, "no origin");
    }
}
