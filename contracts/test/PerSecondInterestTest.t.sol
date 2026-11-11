// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {LoanClockFacet} from "../src/facets/LoanClockFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {LoanClockProbeFacet} from "./mocks/LoanClockProbeFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";

/// @title PerSecondInterestTest
/// @notice #3169 (owner decision 2026-11-05): an ERC-20 loan's interest counts
///         by the second on every path, rounded down once per settlement, and
///         a full-term loan's minimum is derived to the second from the term
///         (the clock's start to the term's end), with no remaining-day counter.
///         Pins: a segment closed inside its first day accrues; a full-term
///         loan settled early owes exactly the whole-term figure it always
///         did; grace accrual past the term counts seconds; a partial leaves
///         no part day of the minimum uncounted; a pause inside a segment does
///         not raise its minimum.
contract PerSecondInterestTest is SetupTest {
    uint256 internal constant PRINCIPAL = 1_000e18;
    uint256 internal constant COLLATERAL = 1_800e18;
    uint256 internal constant RATE_BPS = 500;
    uint256 internal constant DURATION_DAYS = 30;
    uint256 internal constant YEAR_BPS = 365 days * 10_000;

    LoanClockProbeFacet internal probe;

    function setUp() public {
        setupHelper();
        bytes4[] memory sels = new bytes4[](3);
        sels[0] = LoanClockProbeFacet.probeInterestTermEnd.selector;
        sels[1] = LoanClockProbeFacet.probeMinimumInterestSeconds.selector;
        sels[2] = LoanClockProbeFacet.probeSettlementInterest.selector;
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(new LoanClockProbeFacet()),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sels
        });
        vm.prank(owner);
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        probe = LoanClockProbeFacet(address(diamond));
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _openLoan(bool fullTerm) internal returns (uint256 loanId) {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: RATE_BPS,
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
                interestRateBpsMax: RATE_BPS,
                collateralAmountMax: COLLATERAL,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: fullTerm
            }),
            type(uint64).max
        );
        loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(l.status), uint8(LibVaipakam.LoanStatus.Active), "fixture-live: the loan is active");
        assertEq(l.useFullTermInterest, fullTerm, "fixture-live: the interest mode is the one asked for");
    }

    /// @dev Interest over `secs` on `principal`, the one rounding: down, once.
    function _interest(uint256 principal, uint256 secs) internal pure returns (uint256) {
        return (principal * RATE_BPS * secs) / YEAR_BPS;
    }

    function _maturity(uint256 loanId) internal view returns (uint256 m) {
        (, , m, ) = LoanClockFacet(address(diamond)).getLoanDeadlines(loanId);
    }

    // ─── Pro-rata ────────────────────────────────────────────────────────────

    /// @dev The #3169 defect: a pro-rata loan closed inside its first day owed
    ///      no interest at all. It now owes every second it was held.
    function test_proRata_subDayRepayOwesEverySecond() public {
        uint256 loanId = _openLoan(false);
        uint256 held = 6 hours + 17 minutes + 3 seconds;
        vm.warp(block.timestamp + held);

        uint256 expected = _interest(PRINCIPAL, held);
        assertGt(expected, 0, "a sub-day hold accrues");
        assertEq(probe.probeSettlementInterest(loanId), expected, "settlement interest counts seconds");
        assertEq(
            RepayFacet(address(diamond)).calculateRepaymentAmount(loanId),
            PRINCIPAL + expected,
            "the repayment quote carries the per-second interest"
        );
    }

    /// @dev A pro-rata loan's settlement interest is the same per-second figure
    ///      at any second, not a whole-day step: one second later owes more
    ///      whenever the second is worth at least one wei.
    function test_proRata_accruesBetweenDayBoundaries() public {
        uint256 loanId = _openLoan(false);
        vm.warp(block.timestamp + 3 days + 12 hours);
        uint256 a = probe.probeSettlementInterest(loanId);
        vm.warp(block.timestamp + 1 hours);
        uint256 b = probe.probeSettlementInterest(loanId);
        assertEq(a, _interest(PRINCIPAL, 3 days + 12 hours), "3.5 days, not 3");
        assertEq(b, _interest(PRINCIPAL, 3 days + 13 hours), "an hour later accrues the hour");
        assertGt(b, a, "accrual moves inside a day");
    }

    // ─── Full-term ───────────────────────────────────────────────────────────

    /// @dev SECONDS_PER_YEAR is exactly 365 days, so the full-term minimum in
    ///      seconds is the whole-term figure it always was, to the wei.
    function test_fullTerm_earlySettlementOwesTheWholeTermExactly() public {
        uint256 loanId = _openLoan(true);
        vm.warp(block.timestamp + 3 days + 7 hours);
        uint256 wholeTermDaysFormula = (PRINCIPAL * RATE_BPS * DURATION_DAYS) / (365 * 10_000);
        assertEq(probe.probeMinimumInterestSeconds(loanId), DURATION_DAYS * 1 days, "minimum = the term, in seconds");
        assertEq(probe.probeSettlementInterest(loanId), wholeTermDaysFormula, "unchanged from the whole-day formula");
    }

    /// @dev Past the term (inside grace) a full-term loan accrues the time
    ///      actually elapsed, to the second, above the minimum.
    function test_fullTerm_graceAccruesPerSecond() public {
        uint256 loanId = _openLoan(true);
        uint256 elapsed = DURATION_DAYS * 1 days + 5 hours + 11 seconds;
        vm.warp(block.timestamp + elapsed);
        assertEq(probe.probeSettlementInterest(loanId), _interest(PRINCIPAL, elapsed), "grace counts seconds");
    }

    /// @dev After a partial at a part-day offset, the residual's minimum runs
    ///      from the re-stamped clock to maturity to the second. The retired
    ///      counter floored it, so 10.5 days in, the minimum lost 12 hours.
    function test_fullTerm_partialKeepsTheWholeRemainingMinimum() public {
        uint256 loanId = _openLoan(true);
        uint256 maturity = _maturity(loanId);
        vm.warp(block.timestamp + 10 days + 12 hours);

        vm.startPrank(borrower);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        RepayFacet(address(diamond)).repayPartial(loanId, PRINCIPAL / 2);
        vm.stopPrank();

        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint256(l.interestAccrualStart), block.timestamp, "the partial restarted the interest clock");
        assertEq(_maturity(loanId), maturity, "the partial did not move maturity");
        assertEq(
            probe.probeMinimumInterestSeconds(loanId),
            maturity - block.timestamp,
            "the minimum runs to maturity to the second"
        );
        assertEq(maturity - block.timestamp, 19 days + 12 hours, "19.5 days, not floor(19.5)");
        assertEq(
            probe.probeSettlementInterest(loanId),
            _interest(l.principal, 19 days + 12 hours),
            "the residual owes its full remaining minimum"
        );
    }

    /// @dev A pause inside a segment moves the deadlines but does not raise
    ///      the segment's minimum: accrual already counts the paused seconds by
    ///      elapsed time.
    function test_fullTerm_pauseInsideSegmentDoesNotRaiseTheMinimum() public {
        uint256 loanId = _openLoan(true);
        uint256 originalMaturity = _maturity(loanId);
        vm.warp(block.timestamp + 2 days);
        AdminFacet(address(diamond)).pause();
        vm.warp(block.timestamp + 3 days);
        AdminFacet(address(diamond)).unpause();

        assertEq(_maturity(loanId), originalMaturity + 3 days, "fixture-live: the pause moved maturity");
        assertEq(
            probe.probeMinimumInterestSeconds(loanId),
            DURATION_DAYS * 1 days,
            "the minimum stays the term"
        );
        assertEq(
            probe.probeInterestTermEnd(loanId),
            originalMaturity + 3 days,
            "the interest term ends at the moved maturity"
        );
    }
}
