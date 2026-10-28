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
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {ArtifactDeploy} from "../script/lib/ArtifactDeploy.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";

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
        _sellTo(loanId, seller, buyer);
    }

    function _sellTo(uint256 loanId, address seller, address buyer) internal {
        uint256 remaining = LoanFacet(address(diamond)).getLoanDetails(loanId).interestRemainingDays;
        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Lender, remaining);
        // The buyer funds exactly the principal outstanding now.
        p.amount = LoanFacet(address(diamond)).getLoanDetails(loanId).principal;
        p.amountMax = p.amount;
        vm.prank(buyer);
        uint256 buyOfferId = OfferCreateFacet(address(diamond)).createOffer(p);
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

    // ─── Codex #3068 r1 ──────────────────────────────────────────────────────

    /// @dev Interest the borrower paid while the holder was frozen is parked in
    ///      the held balance, not owed by the loan. A sale pays it to the
    ///      seller out of that balance, so the seller is not left with a claim
    ///      only later interest could pay while the buyer keeps the tokens.
    function test_frozenPark_isPaidToTheSellerAtTheSale() public {
        uint256 loanId = _openLoan();
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        _skip(10 days);
        (uint256 earned,,) = _ledger(loanId);
        m.setFlagged(lender, true);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loanId, PRINCIPAL / 2);
        (uint256 kept,,) = _ledger(loanId);
        assertEq(kept, earned, "a parked share is not paid to the frozen holder");

        m.setFlagged(lender, false);
        _sell(loanId, lender, "buyer1");
        assertApproxEqAbs(
            SellerClaimFacet(address(diamond)).getSellerInterestHeld(loanId, lender, mockERC20),
            _net(loanId, earned),
            2,
            "the seller is paid the parked interest at the sale"
        );
        (,, LibVaipakam.SellerInterestClaim[] memory claims) = _ledger(loanId);
        assertEq(claims.length, 0, "nothing the loan no longer owes is left as a claim");
    }

    /// @dev Past its terminal the loan owes the lender side its claim row, so
    ///      the ledger reports nothing earned or owed, however long after.
    function test_ledger_readsZeroPastTheTerminal() public {
        uint256 loanId = _openLoan();
        _skip(10 days);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);
        _skip(30 days);
        (uint256 earned, uint256 owed,) = _ledger(loanId);
        assertEq(earned, 0, "no interest accrues on a repaid loan");
        assertEq(owed, 0, "a repaid loan owes its claim row, not principal");
    }
    /// @dev Parked funds wait on the recorded frozen claimant whoever holds
    ///      the position. A later holder's sale while that claimant is still
    ///      blocked is refused, and the verdict names it, rather than paying
    ///      the parked interest to another wallet.
    function test_frozenPark_otherClaimantStillBlocked_refusesTheSale() public {
        uint256 loanId = _openLoan();
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        _skip(10 days);
        m.setFlagged(lender, true);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loanId, PRINCIPAL / 2);

        m.setFlagged(lender, false);
        address holder = makeAddr("plainHolder");
        uint256 tokenId = LoanFacet(address(diamond)).getLoanDetails(loanId).lenderTokenId;
        vm.prank(lender);
        IERC721(address(diamond)).transferFrom(lender, holder, tokenId);
        m.setFlagged(lender, true);

        bytes memory blocked = abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, lender);
        (SaleExitVerdictFacet.SaleRefusal[] memory direct,) =
            SaleExitVerdictFacet(address(diamond)).saleExitVerdict(loanId, holder);
        bool named;
        for (uint256 i; i < direct.length; ++i) {
            if (keccak256(direct[i].reason) == keccak256(blocked)) named = true;
        }
        assertTrue(named, "the verdict names the still-blocked recorded claimant");

        address buyer = _provisionFundedActor("buyerB", mockERC20, PRINCIPAL * 2);
        LibVaipakam.CreateOfferParams memory p =
            _params(LibVaipakam.OfferType.Lender, LoanFacet(address(diamond)).getLoanDetails(loanId).interestRemainingDays);
        p.amount = LoanFacet(address(diamond)).getLoanDetails(loanId).principal;
        p.amountMax = p.amount;
        vm.prank(buyer);
        uint256 buyOfferId = OfferCreateFacet(address(diamond)).createOffer(p);
        vm.prank(holder);
        vm.expectRevert(blocked);
        EarlyWithdrawalDirectFacet(address(diamond)).sellLoanViaBuyOffer(loanId, buyOfferId);
    }
    // ─── Codex #3068 r1 (handover, yield fee, confirmation) ──────────────────

    /// @dev An obligation handover pays the open seller claims first, out of
    ///      the interest the exiting borrower pays, before the holder's part
    ///      is credited to the held balance.
    function test_obligationHandover_paysTheSellerFirst() public {
        uint256 loanId = _openLoan();
        _skip(10 days);
        uint256 sellerGross = _accrual(PRINCIPAL, 10 days);
        _sell(loanId, lender, "buyer1");
        _skip(5 days);

        address incoming = _provisionFundedActor("incoming-borrower", mockCollateralERC20, COLLATERAL * 2);
        vm.prank(incoming);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(_params(LibVaipakam.OfferType.Borrower, 40));
        ERC20Mock(mockERC20).mint(borrower, PRINCIPAL);
        vm.prank(borrower);
        PrecloseFacet(address(diamond)).transferObligationViaOffer(loanId, offerId);

        (,, LibVaipakam.SellerInterestClaim[] memory claims) = _ledger(loanId);
        assertEq(claims.length, 0, "the handover's interest paid the seller's claim");
        assertApproxEqAbs(
            SellerClaimFacet(address(diamond)).getSellerInterestHeld(loanId, lender, mockERC20),
            _net(loanId, sellerGross),
            2,
            "the seller's share, net of the fee, waits in their vault"
        );
    }

    /// @dev The holder's yield-fee discount prices only the holder's own part
    ///      of an interest payment: a seller's share pays the loan's own fee,
    ///      and the holder is not charged for it.
    function test_holderDiscount_doesNotPriceTheSellersShare() public {
        address impl = ArtifactDeploy.deploy(type(VPFIToken).name);
        VPFIToken vpfi = VPFIToken(
            ArtifactDeploy.deploy(
                type(ERC1967Proxy).name,
                abi.encode(impl, abi.encodeCall(VPFIToken.initialize, (address(this), address(this), address(this))))
            )
        );
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));

        uint256 loanId = _openLoan();
        address buyer = _provisionFundedActor("discounted-buyer", mockERC20, PRINCIPAL * 2);
        vpfi.transfer(buyer, 5_000 ether);
        vm.startPrank(buyer);
        vpfi.approve(address(diamond), 5_000 ether);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(5_000 ether);
        VPFIDiscountFacet(address(diamond)).setVPFIDiscountConsent(true);
        vm.stopPrank();

        _skip(10 days);
        uint256 sellerGross = _accrual(PRINCIPAL, 10 days);
        _sellTo(loanId, lender, buyer);
        _skip(5 days);
        (, uint16 bps) = VPFIDiscountFacet(address(diamond)).getEffectiveDiscount(buyer);
        assertGt(bps, 0, "the holder's discount is live");

        uint256 holderGross = _accrual(PRINCIPAL, 5 days);
        uint256 buyerBefore = ERC20(mockERC20).balanceOf(buyer);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loanId, PRINCIPAL / 2);

        assertApproxEqAbs(
            SellerClaimFacet(address(diamond)).getSellerInterestHeld(loanId, lender, mockERC20),
            _net(loanId, sellerGross),
            2,
            "the seller pays the loan's own fee, undiscounted"
        );
        uint256 holderInterest = ERC20(mockERC20).balanceOf(buyer) - buyerBefore - PRINCIPAL / 2;
        assertGt(holderInterest, _net(loanId, holderGross) + 2, "the holder's discount reaches the holder");
        assertLe(holderInterest, holderGross + 2, "and only on the holder's own part");
    }

    /// @dev A seller seen flagged when their share is credited is recorded as
    ///      confirmed, so a later oracle outage cannot release it.
    function test_sellerSeenFlaggedAtCredit_staysFrozenThroughAnOutage() public {
        uint256 loanId = _openLoan();
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        _skip(10 days);
        _sell(loanId, lender, "buyer1");
        _skip(5 days);
        m.setFlagged(lender, true);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loanId, PRINCIPAL / 2);
        assertGt(SellerClaimFacet(address(diamond)).getSellerInterestHeld(loanId, lender, mockERC20), 0);

        m.setRevertOnRead(true);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, lender));
        SellerClaimFacet(address(diamond)).claimAsSeller(loanId);
    }

    // ─── Codex #3068 r2 ──────────────────────────────────────────────────────

    /// @dev The holder's claim views show what the holder is paid: the row
    ///      less the sellers' part of it, which is what the claim then pays.
    function test_holderClaimView_showsTheRowLessTheSellersPart() public {
        uint256 loanId = _openLoan();
        _skip(10 days);
        uint256 sellerGross = _accrual(PRINCIPAL, 10 days);
        address buyer = _sell(loanId, lender, "buyer1");
        _skip(5 days);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        uint256 sellers = SellerClaimFacet(address(diamond)).getSellersShareOfLenderClaim(loanId);
        assertEq(sellers, _net(loanId, sellerGross), "the sellers' part is the seller's net claim");
        (, uint256 shown,,,,,,) = ClaimFacet(address(diamond)).getClaimable(loanId, true);
        (, uint256 shownAmount,) = ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertEq(shown, shownAmount, "both claim views agree");

        uint256 before = ERC20(mockERC20).balanceOf(buyer);
        vm.prank(buyer);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        assertEq(ERC20(mockERC20).balanceOf(buyer) - before, shown, "the holder is paid what they were shown");
    }

    /// @dev A holder who got the position by plain transfer has no vault. The
    ///      sale opens one while it has the seller screened clean, so a flag
    ///      raised later parks the seller's share instead of blocking the
    ///      borrower's repayment.
    function test_sale_opensTheSellersVault_soALaterFlagCannotBlockRepayment() public {
        uint256 loanId = _openLoan();
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        address holder = makeAddr("transfereeHolder");
        uint256 tokenId = LoanFacet(address(diamond)).getLoanDetails(loanId).lenderTokenId;
        vm.prank(lender);
        IERC721(address(diamond)).transferFrom(lender, holder, tokenId);
        assertEq(VaultFactoryFacet(address(diamond)).getUserVaultAddress(holder), address(0), "no vault yet");

        _skip(10 days);
        _sell(loanId, holder, "buyer1");
        assertTrue(
            VaultFactoryFacet(address(diamond)).getUserVaultAddress(holder) != address(0),
            "the sale opened the seller's vault"
        );

        _skip(5 days);
        m.setFlagged(holder, true);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loanId, PRINCIPAL / 2);
        assertGt(
            SellerClaimFacet(address(diamond)).getSellerInterestHeld(loanId, holder, mockERC20),
            0,
            "the flagged seller's share is parked in their vault"
        );
    }
}
