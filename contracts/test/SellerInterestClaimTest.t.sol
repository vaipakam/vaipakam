// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibInterestLedger} from "../src/libraries/LibInterestLedger.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {EarlyWithdrawalDirectFacet} from "../src/facets/EarlyWithdrawalDirectFacet.sol";
import {SaleExitVerdictFacet} from "../src/facets/SaleExitVerdictFacet.sol";
import {SellerClaimFacet} from "../src/facets/SellerClaimFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title SellerInterestClaimTest
/// @notice #1209 + #1808 — a lender who sells keeps the interest they earned,
///         as a claim on the loan. Drives the real Diamond end to end: the
///         ledger prices each stretch at its own principal, the sale records
///         the claim, later interest pays sellers first and net of the fee,
///         the terminal split pays the holder's principal first, a seller
///         withdraws from their vault, and a fifth open claim is refused.
contract SellerInterestClaimTest is SetupTest {
    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant COLLATERAL = 2000 ether;
    uint256 internal constant DURATION_DAYS = 60;
    uint256 internal constant RATE_BPS = 500;

    function setUp() public {
        setupHelper();
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _params(LibVaipakam.OfferType kind, uint256 durationDays)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            offerType: kind,
            lendingAsset: mockERC20,
            amount: PRINCIPAL,
            interestRateBps: RATE_BPS,
            collateralAsset: mockCollateralERC20,
            collateralAmount: COLLATERAL,
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
            interestRateBpsMax: RATE_BPS,
            collateralAmountMax: COLLATERAL,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
    }

    function _openLoan() internal returns (uint256 loanId) {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, DURATION_DAYS)
        );
        loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
    }

    /// @dev A fresh buyer posts a buy offer for the loan's remaining term at
    ///      the loan's own rate (no shortfall), and the current holder sells
    ///      into it through the direct route.
    function _sell(uint256 loanId, address seller, string memory buyerName) internal returns (address buyer) {
        buyer = _provisionFundedActor(buyerName, mockERC20, PRINCIPAL * 2);
        uint256 remaining = LoanFacet(address(diamond)).getLoanDetails(loanId).interestRemainingDays;
        vm.prank(buyer);
        uint256 buyOfferId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, remaining)
        );
        vm.prank(seller);
        EarlyWithdrawalDirectFacet(address(diamond)).sellLoanViaBuyOffer(loanId, buyOfferId);
    }

    /// @dev Advances time from the VM's own clock. Under viaIR a second
    ///      `vm.warp(block.timestamp + dt)` in one test can reuse the first
    ///      read of `block.timestamp`, so the clock would not move.
    function _skip(uint256 dt) internal {
        vm.warp(vm.getBlockTimestamp() + dt);
    }

    function _ledger(uint256 loanId)
        internal
        view
        returns (uint256 holderEarned, uint256 principalOwed, LibVaipakam.SellerInterestClaim[] memory claims)
    {
        (holderEarned, principalOwed,, claims) = SellerClaimFacet(address(diamond)).getInterestLedger(loanId);
    }

    function _accrual(uint256 principal, uint256 secs) internal pure returns (uint256) {
        return (principal * RATE_BPS * secs) / (365 days * 10_000);
    }

    function _net(uint256 loanId, uint256 gross) internal view returns (uint256) {
        uint256 fee = LoanFacet(address(diamond)).getLoanDetails(loanId).treasuryFeeBpsAtInit;
        return (gross * (10_000 - fee)) / 10_000;
    }

    // ─── Ledger (#1808) ──────────────────────────────────────────────────────

    /// @dev Each stretch is priced at the principal in force over it: a
    ///      partial repayment pays the holder the first stretch (so nothing is
    ///      left owed for it) and the next stretch accrues on the smaller
    ///      principal.
    function test_ledger_eachStretchAtItsOwnPrincipal() public {
        uint256 loanId = _openLoan();
        _skip(10 days);
        (uint256 earned,,) = _ledger(loanId);
        assertEq(earned, _accrual(PRINCIPAL, 10 days), "the first stretch, at the full principal");

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loanId, PRINCIPAL / 2);
        (uint256 afterPay, uint256 owed,) = _ledger(loanId);
        assertEq(afterPay, 0, "the partial repayment paid the holder that stretch");
        assertEq(owed, PRINCIPAL / 2, "the principal owed fell by the principal repaid");

        _skip(10 days);
        (uint256 second,,) = _ledger(loanId);
        assertEq(second, _accrual(PRINCIPAL / 2, 10 days), "the second stretch, at the smaller principal");
    }

    // ─── The sale (#1209) ────────────────────────────────────────────────────

    /// @dev The seller is paid the whole principal (no forfeiture, no treasury
    ///      cut at the sale), and what they earned becomes their claim.
    function test_sale_sellerKeepsAClaimAndThePrincipal() public {
        uint256 loanId = _openLoan();
        _skip(10 days);
        uint256 earned = _accrual(PRINCIPAL, 10 days);

        uint256 sellerBefore = ERC20(mockERC20).balanceOf(lender);
        address buyer = _sell(loanId, lender, "buyer1");
        assertEq(ERC20(mockERC20).balanceOf(lender) - sellerBefore, PRINCIPAL, "the seller is paid the whole principal");
        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanId).lender, buyer, "the buyer holds the position");

        (uint256 holderEarned,, LibVaipakam.SellerInterestClaim[] memory claims) = _ledger(loanId);
        assertEq(claims.length, 1, "one seller claim");
        assertEq(claims[0].seller, lender, "the claim is the seller's");
        assertEq(claims[0].grossOwed, earned, "the claim is what the seller earned, to the wei");
        assertEq(holderEarned, 0, "the buyer starts at zero");
    }

    /// @dev Later interest pays the seller first, net of the fee, into the
    ///      seller's vault; the holder gets the rest; the seller withdraws.
    function test_partialRepay_paysTheSellerFirstThenTheHolder() public {
        uint256 loanId = _openLoan();
        _skip(10 days);
        uint256 sellerGross = _accrual(PRINCIPAL, 10 days);
        _sell(loanId, lender, "buyer1");
        _skip(5 days);

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loanId, PRINCIPAL / 2);

        (uint256 holderEarned,, LibVaipakam.SellerInterestClaim[] memory claims) = _ledger(loanId);
        assertEq(claims.length, 0, "the seller's claim was paid in full and closed");
        assertEq(holderEarned, 0, "the holder was paid their own stretch");
        uint256 held = SellerClaimFacet(address(diamond)).getSellerInterestHeld(loanId, lender, mockERC20);
        assertApproxEqAbs(held, _net(loanId, sellerGross), 2, "the seller's share, net of the fee, waits in their vault");

        uint256 before = ERC20(mockERC20).balanceOf(lender);
        vm.prank(lender);
        SellerClaimFacet(address(diamond)).claimAsSeller(loanId);
        assertEq(ERC20(mockERC20).balanceOf(lender) - before, held, "the seller withdraws it");
        assertEq(
            SellerClaimFacet(address(diamond)).getSellerInterestHeld(loanId, lender, mockERC20), 0, "nothing left waiting"
        );
    }

    /// @dev At a full repayment the holder's claim is split once: the holder's
    ///      principal first, then the seller's net claim, then the holder.
    function test_fullRepay_terminalSplitPaysSellerOnce() public {
        uint256 loanId = _openLoan();
        _skip(10 days);
        uint256 sellerGross = _accrual(PRINCIPAL, 10 days);
        address buyer = _sell(loanId, lender, "buyer1");
        _skip(5 days);

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        // The seller claims first: the split runs then, not at the holder's claim.
        uint256 sellerBefore = ERC20(mockERC20).balanceOf(lender);
        vm.prank(lender);
        SellerClaimFacet(address(diamond)).claimAsSeller(loanId);
        assertEq(
            ERC20(mockERC20).balanceOf(lender) - sellerBefore,
            _net(loanId, sellerGross),
            "the seller is paid their net claim at the terminal"
        );
        (,, LibVaipakam.SellerInterestClaim[] memory claims) = _ledger(loanId);
        assertEq(claims.length, 0, "every claim closed at the terminal");

        uint256 buyerBefore = ERC20(mockERC20).balanceOf(buyer);
        vm.prank(buyer);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        assertGe(ERC20(mockERC20).balanceOf(buyer) - buyerBefore, PRINCIPAL, "the holder keeps the principal and the rest");

        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(SellerClaimFacet.NothingToClaimAsSeller.selector, loanId, lender));
        SellerClaimFacet(address(diamond)).claimAsSeller(loanId);
    }

    // ─── The bound ───────────────────────────────────────────────────────────

    /// @dev Four open claims is the most a loan carries: the fifth sale is
    ///      refused, and the sale verdict names the reason first.
    function test_fifthSellerClaimIsRefused() public {
        uint256 loanId = _openLoan();
        address holder = lender;
        string[4] memory names = ["b1", "b2", "b3", "b4"];
        for (uint256 i; i < 4; ++i) {
            _skip(1 days);
            holder = _sell(loanId, holder, names[i]);
        }
        (,, LibVaipakam.SellerInterestClaim[] memory claims) = _ledger(loanId);
        assertEq(claims.length, 4, "four open seller claims");

        _skip(1 days);
        (SaleExitVerdictFacet.SaleRefusal[] memory direct,) =
            SaleExitVerdictFacet(address(diamond)).saleExitVerdict(loanId, holder);
        bytes memory full =
            abi.encodeWithSelector(LibInterestLedger.SellerClaimsFull.selector, loanId, uint256(4));
        bool named;
        for (uint256 i; i < direct.length; ++i) {
            if (keccak256(direct[i].reason) == keccak256(full)) named = true;
        }
        assertTrue(named, "the verdict names the full claim list");

        address buyer = _provisionFundedActor("b5", mockERC20, PRINCIPAL * 2);
        uint256 remaining = LoanFacet(address(diamond)).getLoanDetails(loanId).interestRemainingDays;
        vm.prank(buyer);
        uint256 buyOfferId =
            OfferCreateFacet(address(diamond)).createOffer(_params(LibVaipakam.OfferType.Lender, remaining));
        vm.prank(holder);
        vm.expectRevert(full);
        EarlyWithdrawalDirectFacet(address(diamond)).sellLoanViaBuyOffer(loanId, buyOfferId);
    }
}
