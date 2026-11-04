// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @title LifetimeLendingTotalsTest
/// @notice #1832 (owner decision 2026-10-28) — the per-asset lifetime
///         counters: principal is recorded once as a loan opens, interest as
///         each settlement charges it (late fee included, before the
///         treasury's yield fee), and the stats views value the counters
///         rather than scanning loans. Each settlement path is driven for
///         real, and the counter is checked against the figure the path's own
///         event reports, so the two can be reconciled on-chain.
contract LifetimeLendingTotalsTest is SetupTest {
    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant COLLATERAL = 2000 ether;
    uint256 internal constant RATE_BPS = 500;
    uint256 internal constant DURATION_DAYS = 30;

    function setUp() public {
        setupHelper();
    }

    function _openLoan() internal returns (uint256 loanId) {
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
                useFullTermInterest: false
            })
        );
        loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
        vm.prank(borrower);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
    }

    function _totals() internal view returns (uint256 principalLent, uint256 interestPaid) {
        return MetricsFacet(address(diamond)).getLifetimeLendingTotals(mockERC20);
    }

    /// @dev The `interestPaid + lateFeePaid` a `LoanRepaid` in `logs` reports.
    function _repaidInterest(Vm.Log[] memory logs) internal pure returns (uint256) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != RepayFacet.LoanRepaid.selector) continue;
            (uint256 interest, uint256 lateFee,,,) =
                abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, LibVaipakam.LoanStatus));
            return interest + lateFee;
        }
        revert("no LoanRepaid");
    }

    function test_open_recordsPrincipalOnce_andTheAsset() public {
        _openLoan();
        (uint256 principalLent, uint256 interestPaid) = _totals();
        assertEq(principalLent, PRINCIPAL, "principal recorded at the figure the loan opened with");
        assertEq(interestPaid, 0, "nothing paid yet: accruing interest is not paid interest");
        address[] memory assets = MetricsFacet(address(diamond)).getLifetimeLendingAssets();
        assertEq(assets.length, 1, "one lending asset");
        assertEq(assets[0], mockERC20, "the principal asset");

        _openLoan();
        (principalLent,) = _totals();
        assertEq(principalLent, 2 * PRINCIPAL, "a second loan adds its principal");
        assertEq(MetricsFacet(address(diamond)).getLifetimeLendingAssets().length, 1, "the asset is listed once");
    }

    function test_fullRepay_recordsTheInterestItsEventReports() public {
        uint256 loanId = _openLoan();
        vm.warp(vm.getBlockTimestamp() + 10 days);
        vm.recordLogs();
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);
        uint256 reported = _repaidInterest(vm.getRecordedLogs());

        (uint256 principalLent, uint256 interestPaid) = _totals();
        assertGt(reported, 0, "fixture: the repay charged interest");
        assertEq(interestPaid, reported, "the counter is what the repay charged");
        assertEq(principalLent, PRINCIPAL, "repaying never lowers principal lent");
    }

    /// @notice A partial repay pays interest through the mid-life seam and the
    ///         later full repay through the terminal one; each slice is counted
    ///         once, so the total is the sum of the two.
    function test_partialThenFull_countsEachSliceOnce() public {
        uint256 loanId = _openLoan();
        vm.warp(vm.getBlockTimestamp() + 10 days);
        uint256 accrued = (PRINCIPAL * RATE_BPS * 10 days) / (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loanId, PRINCIPAL / 2);
        (uint256 principalLent, uint256 afterPartial) = _totals();
        assertEq(afterPartial, accrued, "the partial repay's interest");
        assertEq(principalLent, PRINCIPAL, "a partial repay never lowers principal lent");

        vm.warp(vm.getBlockTimestamp() + 5 days);
        vm.recordLogs();
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);
        uint256 reported = _repaidInterest(vm.getRecordedLogs());
        (, uint256 total) = _totals();
        assertEq(total, accrued + reported, "the full repay adds only its own interest");
    }

    function test_precloseDirect_recordsTheInterestItsEventReports() public {
        uint256 loanId = _openLoan();
        vm.warp(vm.getBlockTimestamp() + 5 days);
        vm.recordLogs();
        vm.prank(borrower);
        PrecloseFacet(address(diamond)).precloseDirect(loanId);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 reported;
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != PrecloseFacet.LoanPreclosedDirect.selector) continue;
            reported = abi.decode(logs[i].data, (uint256));
            found = true;
        }
        assertTrue(found, "fixture: LoanPreclosedDirect emitted");
        (, uint256 interestPaid) = _totals();
        assertGt(interestPaid, 0, "a preclose charges interest");
        assertEq(interestPaid, reported, "the counter is what the preclose charged");
    }

    /// @notice The stats view values the counters: one loan repaid, so volume
    ///         lent is its principal and interest paid is what it paid, both
    ///         valued by the numeraire rule — with no loan scan behind either.
    function test_protocolStats_valuesTheCounters() public {
        uint256 loanId = _openLoan();
        vm.warp(vm.getBlockTimestamp() + 10 days);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);
        (uint256 principalLent, uint256 interestPaid) = _totals();

        (,,,, uint256 volume, uint256 interest,,) = MetricsFacet(address(diamond)).getProtocolStats();
        assertGt(volume, 0, "fixture: the asset is priced");
        // The test oracle prices the principal token at a flat rate, so each
        // figure scales by the same factor from its raw counter.
        assertEq(volume * interestPaid, interest * principalLent, "both figures value the same counters at one price");
    }
}
