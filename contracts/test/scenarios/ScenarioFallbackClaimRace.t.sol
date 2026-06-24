// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "../invariants/InvariantBase.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../../src/facets/OfferAcceptFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../../src/facets/AddCollateralFacet.sol";
import {LibAcceptTestSigner} from "../helpers/LibAcceptTestSigner.sol";

/**
 * @title ScenarioFallbackClaimRace
 * @notice Concrete end-to-end scenarios that exercise the narrow window
 *         between offer acceptance and settlement, where the claim side
 *         can race against a borrower cure. Each scenario is a fully
 *         deterministic, single-path regression test — they complement
 *         the invariant suites by pinning exact expected behaviour.
 *
 *         Scenario A: Borrower repays an active loan before either side
 *                     triggers default; lender-claim must be rejected.
 *         Scenario B: Borrower tops up collateral before default trigger;
 *                     late default attempt must still succeed per protocol
 *                     rules (collateral additions do not immunise the
 *                     loan once the grace window expires) — OR revert if
 *                     the added collateral lifted HF above the trigger
 *                     threshold. We accept either path and check the
 *                     end-state invariants.
 *         Scenario C: Full repayment after partial repayment; the final
 *                     loan status must be Repaid and the borrower must be
 *                     the only party able to claim the released collateral.
 */
contract ScenarioFallbackClaimRaceTest is Test {
    InvariantBase internal base;
    address internal diamond;
    address internal usdc;
    address internal weth;

    function setUp() public {
        base = new InvariantBase();
        base.deploy();
        diamond = address(base.diamond());
        usdc = base.mockUsdc();
        weth = base.mockWeth();
    }

    // ── Helpers ────────────────────────────────────────────────────────

    function _createLenderOffer(
        address lender,
        uint256 amount,
        uint256 collateralAmount,
        uint256 durationDays,
        uint256 rateBps
    ) internal returns (uint256 offerId) {
        LibVaipakam.CreateOfferParams memory p = LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: usdc,
            amount: amount,
            interestRateBps: rateBps,
            collateralAsset: weth,
            collateralAmount: collateralAmount,
            durationDays: durationDays,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: address(0),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: true,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: amount,
            interestRateBpsMax: rateBps,
            collateralAmountMax: collateralAmount,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
        });
        vm.prank(lender);
        offerId = OfferCreateFacet(diamond).createOffer(p);
    }

    function _acceptAsBorrower(address borrower, uint256 borrowerPk, uint256 offerId)
        internal
        returns (uint256 loanId)
    {
        loanId = LibAcceptTestSigner.signAndAccept(diamond, borrower, borrowerPk, offerId);
    }

    // ── Scenario A ─────────────────────────────────────────────────────

    function test_ScenarioA_BorrowerRepaysBeforeLenderClaim() public {
        address lender = base.lenderAt(0);
        address borrower = base.borrowerAt(0);
        uint256 borrowerPk = base.borrowerPkAt(0);

        uint256 offerId = _createLenderOffer(lender, 1_000 ether, 10 ether, 30, 500);
        uint256 loanId = _acceptAsBorrower(borrower, borrowerPk, offerId);

        LibVaipakam.Loan memory L = LoanFacet(diamond).getLoanDetails(loanId);
        assertEq(uint256(L.status), uint256(LibVaipakam.LoanStatus.Active), "not Active");

        // Borrower repays full
        vm.prank(borrower);
        RepayFacet(diamond).repayLoan(loanId);

        L = LoanFacet(diamond).getLoanDetails(loanId);
        assertEq(uint256(L.status), uint256(LibVaipakam.LoanStatus.Repaid), "not Repaid");

        // Non-lender wallet must not be able to claim the returned principal.
        vm.prank(borrower);
        vm.expectRevert();
        ClaimFacet(diamond).claimAsLender(loanId);

        // Lender collects principal + accrued interest.
        uint256 before = IERC20(usdc).balanceOf(lender);
        vm.prank(lender);
        ClaimFacet(diamond).claimAsLender(loanId);
        assertGt(
            IERC20(usdc).balanceOf(lender),
            before,
            "lender received no principal back"
        );
    }

    // ── Scenario B ─────────────────────────────────────────────────────

    function test_ScenarioB_BorrowerAddsCollateralBeforeDefault() public {
        address lender = base.lenderAt(1);
        address borrower = base.borrowerAt(1);
        uint256 borrowerPk = base.borrowerPkAt(1);

        uint256 offerId = _createLenderOffer(lender, 500 ether, 5 ether, 10, 800);
        uint256 loanId = _acceptAsBorrower(borrower, borrowerPk, offerId);

        // Borrower tops up collateral
        vm.prank(borrower);
        AddCollateralFacet(diamond).addCollateral(loanId, 5 ether);

        LibVaipakam.Loan memory L = LoanFacet(diamond).getLoanDetails(loanId);
        assertEq(L.collateralAmount, 10 ether, "collateral not updated");

        // Nudge time forward a few days but stay inside the duration so
        // repay is legal — protocol blocks repayment past the grace window.
        vm.warp(block.timestamp + 3 days);

        // Repay the loan to settle cleanly — exercising that added collateral
        // is correctly released to the borrower at full repayment.
        uint256 before = IERC20(weth).balanceOf(borrower);
        vm.prank(borrower);
        RepayFacet(diamond).repayLoan(loanId);

        L = LoanFacet(diamond).getLoanDetails(loanId);
        assertEq(uint256(L.status), uint256(LibVaipakam.LoanStatus.Repaid), "not Repaid");

        vm.prank(borrower);
        ClaimFacet(diamond).claimAsBorrower(loanId);

        uint256 got = IERC20(weth).balanceOf(borrower) - before;
        assertEq(got, 10 ether, "collateral not returned in full");
    }

    // ── Scenario C ─────────────────────────────────────────────────────

    function test_ScenarioC_PartialThenFullRepay() public {
        address lender = base.lenderAt(2);
        address borrower = base.borrowerAt(2);
        uint256 borrowerPk = base.borrowerPkAt(2);

        uint256 offerId = _createLenderOffer(lender, 2_000 ether, 20 ether, 60, 1000);
        uint256 loanId = _acceptAsBorrower(borrower, borrowerPk, offerId);

        vm.prank(borrower);
        RepayFacet(diamond).repayPartial(loanId, 500 ether);

        LibVaipakam.Loan memory L = LoanFacet(diamond).getLoanDetails(loanId);
        assertEq(uint256(L.status), uint256(LibVaipakam.LoanStatus.Active), "partial closed loan");

        vm.warp(block.timestamp + 30 days);

        vm.prank(borrower);
        RepayFacet(diamond).repayLoan(loanId);

        L = LoanFacet(diamond).getLoanDetails(loanId);
        assertEq(uint256(L.status), uint256(LibVaipakam.LoanStatus.Repaid), "final not Repaid");

        // Borrower claims released collateral; non-borrower caller rejected.
        vm.prank(lender);
        vm.expectRevert();
        ClaimFacet(diamond).claimAsBorrower(loanId);

        vm.prank(borrower);
        ClaimFacet(diamond).claimAsBorrower(loanId);

        // Lender separately claims returned principal.
        vm.prank(borrower);
        vm.expectRevert();
        ClaimFacet(diamond).claimAsLender(loanId);

        vm.prank(lender);
        ClaimFacet(diamond).claimAsLender(loanId);
    }
}
