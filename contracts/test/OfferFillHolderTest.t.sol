// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibTerms} from "../src/libraries/LibTerms.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferPreviewFacet} from "../src/facets/OfferPreviewFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {LegalFacet} from "../src/facets/LegalFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VPFIDiscountAccumulatorFacet} from "../src/facets/VPFIDiscountAccumulatorFacet.sol";
import {VaultDepositoryFacet} from "../src/facets/VaultDepositoryFacet.sol";
import {ReferralFacet} from "../src/facets/ReferralFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {LibTestTiming} from "./helpers/LibTestTiming.sol";
import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";

/// @title  OfferFillHolderTest
/// @notice #3744 — a borrower offer's borrower side is taken by the holder of
///         the offer's position token at the fill. The net principal lands in
///         that holder's vault as free balance; the initiation fee's hold
///         discount is the holder's; a flagged holder or one that has not
///         accepted the Terms in force makes the offer unfillable, with a
///         named refusal the accept preview reports first. The creator, whose
///         vault holds the collateral, is screened as before.
contract OfferFillHolderTest is SetupTest {
    bytes32 internal constant H1 = keccak256("Vaipakam ToS v1");
    uint256 internal constant PRINCIPAL = 1000 ether;

    address internal buyer;

    function setUp() public {
        setupHelper();
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOraclePrice(mockERC20, 1e8, 8);
        mockOracleLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOraclePrice(mockCollateralERC20, 1e8, 8);
        buyer = makeAddr("borrowerOfferTokenBuyer");
        deal(mockCollateralERC20, borrower, 1_000_000 ether);
        deal(mockERC20, lender, 1_000_000 ether);
        vm.prank(borrower);
        ERC20Mock(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(lender);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    function _borrowerOffer() internal returns (uint256 id) {
        return _borrowerOfferBy(borrower);
    }

    function _borrowerOfferBy(address who) internal returns (uint256 id) {
        deal(mockCollateralERC20, who, 1_000_000 ether);
        vm.prank(who);
        ERC20Mock(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(who);
        id = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                integrator: address(0),
                lifecycleFlex: 0,
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 5000 ether,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: address(0),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: PRINCIPAL,
                interestRateBpsMax: 500,
                collateralAmountMax: 5000 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            }),
            type(uint64).max
        );
        LibTestTiming.waitOutTermsAge(address(diamond), id);
    }

    function _token(uint256 id) internal view returns (uint256) {
        return OfferCancelFacet(address(diamond)).getOffer(id).positionTokenId;
    }

    function _soldTo(uint256 id, address to) internal {
        LibTestPositionNFT.move(address(diamond), _token(id), to);
    }

    function _free(address who, address token) internal view returns (uint256) {
        return VaultDepositoryFacet(address(diamond)).getDepositoryHolding(who, token, 0);
    }

    function _previewCode(uint256 id) internal view returns (uint8) {
        return uint8(OfferPreviewFacet(address(diamond)).previewAccept(id, lender).errorCode);
    }

    function _acceptRaw(uint256 id) internal {
        (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) = _signed(id);
        vm.prank(lender);
        OfferAcceptFacet(address(diamond)).acceptOffer(id, t, sig);
    }

    /// @dev Expect `reason` from the lender's accept of `id`, with the terms
    ///      built first (building them reads the Diamond).
    function _acceptExpecting(uint256 id, bytes memory reason) internal {
        (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) = _signed(id);
        vm.expectRevert(reason);
        vm.prank(lender);
        OfferAcceptFacet(address(diamond)).acceptOffer(id, t, sig);
    }

    function _signed(uint256 id) internal returns (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) {
        t = LibAcceptTestSigner.buildTerms(address(diamond), lender, id, true, 0);
        sig = LibAcceptTestSigner.sign(address(diamond), t, lenderPk);
    }

    // ─── The holder takes the principal and the position ─────────────────

    function test_fillAfterTransfer_paysTheHoldersVault() public {
        uint256 id = _borrowerOffer();
        _soldTo(id, buyer);
        uint256 creatorFree0 = _free(borrower, mockERC20);

        uint256 loanId = _signAndAcceptOffer(lender, lenderPk, id);

        uint256 received = _free(buyer, mockERC20);
        assertGt(received, 0, "the net principal is in the holder's vault");
        assertLe(received, PRINCIPAL, "net of the initiation fee");
        assertEq(_free(borrower, mockERC20), creatorFree0, "nothing to the creator's vault");
        assertEq(ERC20Mock(mockERC20).balanceOf(buyer), 0, "no wallet payment");
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(LibTestPositionNFT.core(address(diamond)).ownerOf(loan.borrowerTokenId), buyer, "the holder holds the borrower side");
    }

    function test_fillWithCreatorHolding_paysTheCreatorsVault() public {
        uint256 id = _borrowerOffer();
        _signAndAcceptOffer(lender, lenderPk, id);
        assertGt(_free(borrower, mockERC20), 0, "unchanged: the creator's own vault");
    }

    // ─── The initiation fee's hold discount is the holder's ──────────────

    /// @dev Give `who` a hold discount of `bps` at the fill (the tier read is
    ///      mocked; its rule is covered by the discount suites).
    function _discount(address who, uint16 bps) internal {
        vm.prank(who);
        VPFIDiscountFacet(address(diamond)).setVPFIDiscountConsent(true);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VPFIDiscountAccumulatorFacet.effectiveTierAndBps.selector, who),
            abi.encode(uint8(2), bps)
        );
    }

    function test_feeDiscount_keysOnTheHolder_notTheCreator() public {
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        address other = makeAddr("undiscountedHolder");

        // The creator carries a discount; the holder does not: no discount.
        _discount(borrower, 2000);
        uint256 a = _borrowerOffer();
        _soldTo(a, other);
        _signAndAcceptOffer(lender, lenderPk, a);
        uint256 undiscounted = _free(other, mockERC20);

        // The holder carries one: the fee is discounted.
        _discount(buyer, 2000);
        uint256 b = _borrowerOffer();
        _soldTo(b, buyer);
        _signAndAcceptOffer(lender, lenderPk, b);
        uint256 discounted = _free(buyer, mockERC20);

        assertGt(undiscounted, 0);
        assertGt(discounted, undiscounted, "the holder's discount lowers the fee it pays");
    }

    // ─── The new-business screens apply to the holder ────────────────────

    function test_flaggedHolder_makesTheOfferUnfillable() public {
        uint256 id = _borrowerOffer();
        _soldTo(id, buyer);
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        m.setFlagged(buyer, true);

        assertEq(_previewCode(id), uint8(OfferAcceptFacet.AcceptError.SanctionedOfferHolder), "the preview names it");
        _acceptExpecting(id, abi.encodeWithSelector(ProfileFacet.SanctionedAddress.selector, buyer));

        // Back with an unflagged holder, the offer fills.
        m.setFlagged(buyer, false);
        assertEq(_previewCode(id), uint8(OfferAcceptFacet.AcceptError.None));
        _acceptRaw(id);
    }

    function test_holderWithoutTerms_makesTheOfferUnfillable() public {
        LegalFacet(address(diamond)).announceTos(1, H1, uint64(block.timestamp));
        vm.prank(borrower);
        LegalFacet(address(diamond)).acceptTerms(1, H1);
        vm.prank(lender);
        LegalFacet(address(diamond)).acceptTerms(1, H1);
        uint256 id = _borrowerOffer();
        _soldTo(id, buyer);

        assertEq(_previewCode(id), uint8(OfferAcceptFacet.AcceptError.TermsNotAccepted), "the preview names it");
        _acceptExpecting(id, abi.encodeWithSelector(LibTerms.TermsNotAccepted.selector, buyer, uint32(1)));

        vm.prank(buyer);
        LegalFacet(address(diamond)).acceptTerms(1, H1);
        assertEq(_previewCode(id), uint8(OfferAcceptFacet.AcceptError.None));
        _acceptRaw(id);
    }

    // ─── The lender side of a match follows the lender offer's token ─────

    function _lenderOffer(uint256 amountMax) internal returns (uint256 id) {
        vm.prank(lender);
        id = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                integrator: address(0),
                lifecycleFlex: 0,
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 5000 ether,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: address(0),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: amountMax,
                interestRateBpsMax: 500,
                collateralAmountMax: 5000 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            }),
            type(uint64).max
        );
        LibTestTiming.waitOutTermsAge(address(diamond), id);
    }

    function _enableMatching() internal {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
    }

    function _lenderOwner(uint256 loanId) internal view returns (address) {
        return LibTestPositionNFT.core(address(diamond)).ownerOf(LoanFacet(address(diamond)).getLoanDetails(loanId).lenderTokenId);
    }

    function test_match_transferredLenderOffer_holderOwnsTheLenderSide() public {
        _enableMatching();
        uint256 lo = _lenderOffer(PRINCIPAL);
        _soldTo(lo, buyer);
        uint256 bo = _borrowerOffer();
        uint256 creatorFree0 = _free(lender, mockERC20);

        uint256 loanId = OfferMatchFacet(address(diamond)).matchOffers(lo, bo);

        assertEq(_lenderOwner(loanId), buyer, "the holder owns the lender side");
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loan.lender, lender, "the creator's vault funded it (funding record)");
        assertEq(_free(lender, mockERC20), creatorFree0, "no principal moved back to the creator");
        assertEq(
            VPFIDiscountAccumulatorFacet(address(diamond)).lenderHoldDiscountView(loanId, buyer).entryHolder,
            buyer,
            "the entry discount is stamped for the holder"
        );
    }

    function test_match_transferredLenderOffer_inSlices_holderOwnsEach() public {
        _enableMatching();
        uint256 lo = _lenderOffer(PRINCIPAL * 2);
        _soldTo(lo, buyer);
        uint256 bo1 = _borrowerOffer();
        uint256 bo2 = _borrowerOfferBy(makeAddr("secondBorrower"));

        uint256 loan1 = OfferMatchFacet(address(diamond)).matchOffers(lo, bo1);
        uint256 loan2 = OfferMatchFacet(address(diamond)).matchOffers(lo, bo2);

        assertEq(_lenderOwner(loan1), buyer, "first slice");
        assertEq(_lenderOwner(loan2), buyer, "second slice");
    }

    function test_match_flaggedLenderHolder_refuses() public {
        _enableMatching();
        uint256 lo = _lenderOffer(PRINCIPAL);
        _soldTo(lo, buyer);
        uint256 bo = _borrowerOffer();
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        m.setFlagged(buyer, true);

        assertEq(
            uint8(OfferMatchFacet(address(diamond)).previewMatch(lo, bo, address(this), address(this)).errorCode),
            uint8(LibOfferMatch.MatchError.OfferHolderFlagged),
            "the preview names it"
        );
        vm.expectRevert(abi.encodeWithSelector(ProfileFacet.SanctionedAddress.selector, buyer));
        OfferMatchFacet(address(diamond)).matchOffers(lo, bo);
    }

    function test_match_lenderHolderWithoutTerms_refuses() public {
        _enableMatching();
        LegalFacet(address(diamond)).announceTos(1, H1, uint64(block.timestamp));
        vm.prank(borrower);
        LegalFacet(address(diamond)).acceptTerms(1, H1);
        vm.prank(lender);
        LegalFacet(address(diamond)).acceptTerms(1, H1);
        uint256 lo = _lenderOffer(PRINCIPAL);
        _soldTo(lo, buyer);
        uint256 bo = _borrowerOffer();

        assertEq(
            uint8(OfferMatchFacet(address(diamond)).previewMatch(lo, bo, address(this), address(this)).errorCode),
            uint8(LibOfferMatch.MatchError.TermsNotAccepted)
        );
        vm.expectRevert(abi.encodeWithSelector(LibTerms.TermsNotAccepted.selector, buyer, uint32(1)));
        OfferMatchFacet(address(diamond)).matchOffers(lo, bo);
    }

    /// The creator of a transferred lender offer cannot take back its side
    /// by matching it: the side still goes to the holder.
    function test_match_creatorSelfMatch_doesNotRegainThePosition() public {
        _enableMatching();
        uint256 lo = _lenderOffer(PRINCIPAL);
        _soldTo(lo, buyer);
        uint256 bo = _borrowerOfferBy(lender);

        vm.expectRevert();
        OfferMatchFacet(address(diamond)).matchOffers(lo, bo);
        assertEq(
            uint8(OfferMatchFacet(address(diamond)).previewMatch(lo, bo, address(this), address(this)).errorCode),
            uint8(LibOfferMatch.MatchError.SelfTrade),
            "same creator on both offers is a self-trade"
        );
    }

    /// The holder cannot match its held lender offer against its own borrower
    /// offer either: both sides would be one owner.
    function test_match_holderAgainstItsOwnBorrowerOffer_isSelfTrade() public {
        _enableMatching();
        uint256 lo = _lenderOffer(PRINCIPAL);
        _soldTo(lo, buyer);
        uint256 bo = _borrowerOfferBy(buyer);
        assertEq(
            uint8(OfferMatchFacet(address(diamond)).previewMatch(lo, bo, address(this), address(this)).errorCode),
            uint8(LibOfferMatch.MatchError.SelfTrade)
        );
        vm.expectRevert(abi.encodeWithSelector(OfferAcceptFacet.SelfTradeForbidden.selector, lender));
        OfferMatchFacet(address(diamond)).matchOffers(lo, bo);
    }
    // ─── Codex round 1 on #3805: the holder in every place the fill reads ─

    /// @dev The borrower side's holder is the one recorded as having borrowed,
    ///      so it can no longer bind an inviter; the creator who sold the
    ///      offer has borrowed nothing and still can.
    function test_fillAfterTransfer_holderIsTheOneWhoBorrowed() public {
        uint256 id = _borrowerOffer();
        _soldTo(id, buyer);
        _signAndAcceptOffer(lender, lenderPk, id);
        address inviter = makeAddr("someInviter");
        vm.prank(buyer);
        vm.expectRevert(ReferralFacet.ReferralAfterFirstBorrow.selector);
        ReferralFacet(address(diamond)).bindInviter(inviter);
        vm.prank(borrower);
        ReferralFacet(address(diamond)).bindInviter(inviter);
    }

    /// @dev The keepers the holder enabled on the offer, from its own
    ///      approved list, carry onto the loan.
    function test_fillAfterTransfer_holdersKeepersLatchOntoTheLoan() public {
        address keeper = makeAddr("holdersKeeper");
        uint256 id = _borrowerOffer();
        _soldTo(id, buyer);
        vm.prank(buyer);
        ProfileFacet(address(diamond)).approveKeeper(keeper, LibVaipakam.KEEPER_ACTION_COMPLETE_OFFSET);
        vm.prank(buyer);
        ProfileFacet(address(diamond)).setOfferKeeperEnabled(id, keeper, true);
        uint256 loanId = _signAndAcceptOffer(lender, lenderPk, id);
        assertTrue(ProfileFacet(address(diamond)).isLoanKeeperEnabled(loanId, keeper), "latched from the holder's list");
    }

    /// @dev The accept preview quotes the fee the holder pays, not the
    ///      creator's.
    function test_preview_quotesTheHoldersFee() public {
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        _discount(buyer, 2000);
        uint256 id = _borrowerOffer();
        uint256 creatorQuote = OfferPreviewFacet(address(diamond)).previewAccept(id, lender).lifEstimate;
        _soldTo(id, buyer);
        uint256 holderQuote = OfferPreviewFacet(address(diamond)).previewAccept(id, lender).lifEstimate;
        assertLt(holderQuote, creatorQuote, "the holder's discount is in the quote");
        uint256 before = _free(buyer, mockERC20);
        _signAndAcceptOffer(lender, lenderPk, id);
        assertEq(_free(buyer, mockERC20) - before, PRINCIPAL - holderQuote, "the quote is what the fill charged");
    }
    /// @dev The holder previewing its own offer's accept is told it is a self
    ///      trade, as the accept refuses it.
    function test_preview_holderAcceptingItsOwnOffer_isSelfTrade() public {
        uint256 id = _borrowerOffer();
        _soldTo(id, buyer);
        assertEq(
            uint8(OfferPreviewFacet(address(diamond)).previewAccept(id, buyer).errorCode),
            uint8(OfferAcceptFacet.AcceptError.SelfTrade)
        );
    }

    // ─── Codex round 2 ───────────────────────────────────────────────────

    /// With KYC enforcement on, the holder who takes the borrower side must
    /// meet the tier for the loan's value, as the creator and acceptor must.
    function test_kyc_appliesToTheBorrowerHolder() public {
        uint256 id = _borrowerOffer();
        _soldTo(id, buyer);
        AdminFacet(address(diamond)).setKYCEnforcement(true);
        ProfileFacet(address(diamond)).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(address(diamond)).updateKYCTier(lender, LibVaipakam.KYCTier.Tier2);
        _acceptExpecting(id, abi.encodeWithSelector(IVaipakamErrors.KYCRequired.selector));

        ProfileFacet(address(diamond)).updateKYCTier(buyer, LibVaipakam.KYCTier.Tier2);
        _acceptRaw(id);
    }

    /// A flag on the creator after the token moved does not strand the clean
    /// holder's escrow: the holder cancels, and the escrow reaches the
    /// holder's vault.
    function test_flaggedCreator_holderStillRecoversTheEscrow() public {
        uint256 id = _borrowerOffer();
        _soldTo(id, buyer);
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        m.setFlagged(borrower, true);

        vm.warp(block.timestamp + LibVaipakam.MIN_OFFER_CANCEL_DELAY + 1);
        vm.prank(buyer);
        OfferCancelFacet(address(diamond)).cancelOffer(id);
        assertEq(_free(buyer, mockCollateralERC20), 5000 ether, "the escrow is in the holder's vault");
    }
}
