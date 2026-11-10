// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibMetricsHooks} from "../src/libraries/LibMetricsHooks.sol";
import {PositionNFT} from "../src/PositionNFT.sol";
import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LibTestTiming} from "./helpers/LibTestTiming.sol";

/**
 * @title PositionTokenPerSliceTest
 * @notice #3205 — one position token per loan side, never shared across loans.
 *         Before the fix every slice of a ranged borrower request took the
 *         request's own token, so the slices' borrower sides answered to one
 *         NFT. These tests drive two-slice matches from each side and check
 *         that every loan side has its own token, the offer's own token
 *         retires with the offer, the four positions are claimed
 *         independently, and the registry refuses a token already bound to
 *         another loan.
 */
contract PositionTokenPerSliceTest is SetupTest {
    address lender2;
    PositionNFT core;

    function setUp() public {
        setupHelper();
        mockOraclePrice(mockCollateralERC20, 100e8, 8);
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);

        lender2 = makeAddr("lender2");
        ERC20Mock(mockERC20).mint(lender2, 100_000 ether);
        vm.prank(lender2);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(lender2);
        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(lender2, LibVaipakam.KYCTier.Tier2);

        // Interest headroom for the two repayments.
        ERC20Mock(mockERC20).mint(borrower, 100_000 ether);
        vm.prank(borrower);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);

        core = LibTestPositionNFT.core(address(diamond));
    }

    // ── helpers ──────────────────────────────────────────────────────

    function _offer(
        address creator,
        LibVaipakam.OfferType kind,
        uint256 amountMin,
        uint256 amountMax,
        uint256 collateralMin,
        uint256 collateralMax
    ) internal returns (uint256 offerId) {
        vm.prank(creator);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: kind,
                lendingAsset: mockERC20,
                amount: amountMin,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: collateralMin,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: amountMax,
                interestRateBpsMax: 600,
                collateralAmountMax: collateralMax,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
        LibTestTiming.waitOutTermsAge(address(diamond), offerId); // #3443
    }

    function _loan(uint256 id) internal view returns (LibVaipakam.Loan memory) {
        return LoanFacet(address(diamond)).getLoanDetails(id);
    }

    function _offerToken(uint256 offerId) internal view returns (uint256) {
        return OfferCancelFacet(address(diamond)).getOffer(offerId).positionTokenId;
    }

    /// @dev The four position tokens of two loans are distinct, none is either
    ///      offer's own token, and each is held by the right party.
    function _assertOwnTokens(
        uint256 loanA,
        uint256 loanB,
        uint256 offerTokenX,
        uint256 offerTokenY,
        address lenderA,
        address lenderB
    ) internal view {
        LibVaipakam.Loan memory a = _loan(loanA);
        LibVaipakam.Loan memory b = _loan(loanB);
        uint256[4] memory t = [a.lenderTokenId, a.borrowerTokenId, b.lenderTokenId, b.borrowerTokenId];
        for (uint256 i; i < 4; ++i) {
            assertTrue(t[i] != 0, "token minted");
            assertTrue(t[i] != offerTokenX && t[i] != offerTokenY, "not an offer's own token");
            for (uint256 j = i + 1; j < 4; ++j) assertTrue(t[i] != t[j], "no shared token");
        }
        assertEq(core.ownerOf(a.lenderTokenId), lenderA, "loan A lender holds its token");
        assertEq(core.ownerOf(b.lenderTokenId), lenderB, "loan B lender holds its token");
        assertEq(core.ownerOf(a.borrowerTokenId), borrower, "loan A borrower holds its token");
        assertEq(core.ownerOf(b.borrowerTokenId), borrower, "loan B borrower holds its token");
    }

    /// @dev Repay and claim loan A on both sides first, then loan B: closing
    ///      one slice must leave the other's positions live and claimable.
    function _claimIndependently(uint256 loanA, uint256 loanB, address lenderA, address lenderB) internal {
        LibVaipakam.Loan memory b = _loan(loanB);

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanA);
        vm.prank(lenderA);
        ClaimFacet(address(diamond)).claimAsLender(loanA);
        vm.prank(borrower);
        ClaimFacet(address(diamond)).claimAsBorrower(loanA);

        _assertClosedReceipt(loanA, _loan(loanA).lenderTokenId);
        _assertClosedReceipt(loanA, _loan(loanA).borrowerTokenId);

        VaipakamNFTFacet nft = VaipakamNFTFacet(address(diamond));
        assertFalse(nft.isPositionRetired(b.lenderTokenId), "loan B lender token still live");
        assertFalse(nft.isPositionRetired(b.borrowerTokenId), "loan B borrower token still live");
        assertEq(core.ownerOf(b.borrowerTokenId), borrower, "loan B borrower still holds");

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanB);
        vm.prank(lenderB);
        ClaimFacet(address(diamond)).claimAsLender(loanB);
        vm.prank(borrower);
        ClaimFacet(address(diamond)).claimAsBorrower(loanB);
    }

    /// @dev #3318 Codex r4 — a claimed position's token is a retired receipt.
    ///      Its summary (what `tokenURI` renders) states the loan's REAL
    ///      closed state, never Active, and what was lent and pledged, with
    ///      every live figure zero.
    function _assertClosedReceipt(uint256 loanId, uint256 tokenId) internal view {
        assertTrue(VaipakamNFTFacet(address(diamond)).isPositionRetired(tokenId), "claimed side retired");
        MetricsFacet.NFTPositionSummary memory s = MetricsFacet(address(diamond)).getNFTPositionSummary(tokenId);
        LibVaipakam.LoanStatus real = _loan(loanId).status;
        assertTrue(real != LibVaipakam.LoanStatus.Active, "precondition: the loan is closed");
        assertEq(uint8(s.loanStatus), uint8(real), "the receipt states the loan's real state");
        assertEq(s.principalAsset, mockERC20, "what was lent");
        assertEq(s.collateralAsset, mockCollateralERC20, "what was pledged");
        assertEq(s.principalAmount, 0, "no live principal");
        assertEq(s.collateralAmount, 0, "no live collateral");
        assertEq(s.claimableAmount, 0, "no live claim");
    }

    // ── tests ────────────────────────────────────────────────────────

    /// @notice A ranged borrower request filled by two lenders: each slice's
    ///         loan has its own borrower token (the bug shared the request's),
    ///         the request's token retires when it fills, and the slices are
    ///         claimed independently on both sides.
    function test_rangedBorrowerRequest_twoSlices_ownTokensBothSides_independentClaims() public {
        uint256 bOffer = _offer(borrower, LibVaipakam.OfferType.Borrower, 1_000, 10_000, 500, 5_000);
        uint256 lOffer1 = _offer(lender, LibVaipakam.OfferType.Lender, 5_000, 5_000, 500, 500);
        uint256 lOffer2 = _offer(lender2, LibVaipakam.OfferType.Lender, 5_000, 5_000, 500, 500);
        uint256 bToken = _offerToken(bOffer);

        uint256 loanA = OfferMatchFacet(address(diamond)).matchOffers(lOffer1, bOffer);
        assertFalse(
            VaipakamNFTFacet(address(diamond)).isPositionRetired(bToken),
            "an open request keeps its own token"
        );
        uint256 loanB = OfferMatchFacet(address(diamond)).matchOffers(lOffer2, bOffer);

        assertTrue(OfferCancelFacet(address(diamond)).getOffer(bOffer).accepted, "request filled");
        assertTrue(
            VaipakamNFTFacet(address(diamond)).isPositionRetired(bToken),
            "the filled request's own token retires"
        );
        _assertOwnTokens(loanA, loanB, bToken, _offerToken(lOffer1), lender, lender2);
        _claimIndependently(loanA, loanB, lender, lender2);
    }

    /// @notice The mirror: a ranged lender offer filled by two borrower
    ///         requests. Each slice's loan has its own lender token.
    function test_rangedLenderOffer_twoSlices_ownTokensBothSides_independentClaims() public {
        uint256 lOffer = _offer(lender, LibVaipakam.OfferType.Lender, 1_000, 10_000, 500, 500);
        uint256 bOffer1 = _offer(borrower, LibVaipakam.OfferType.Borrower, 5_000, 5_000, 500, 500);
        uint256 bOffer2 = _offer(borrower, LibVaipakam.OfferType.Borrower, 5_000, 5_000, 500, 500);
        uint256 lToken = _offerToken(lOffer);

        uint256 loanA = OfferMatchFacet(address(diamond)).matchOffers(lOffer, bOffer1);
        uint256 loanB = OfferMatchFacet(address(diamond)).matchOffers(lOffer, bOffer2);

        assertTrue(OfferCancelFacet(address(diamond)).getOffer(lOffer).accepted, "lender offer filled");
        assertTrue(
            VaipakamNFTFacet(address(diamond)).isPositionRetired(lToken),
            "the filled offer's own token retires"
        );
        _assertOwnTokens(loanA, loanB, lToken, _offerToken(bOffer1), lender, lender);
        _claimIndependently(loanA, loanB, lender, lender);
    }

    /// @notice Registering a position token already bound to another loan
    ///         reverts, so two loans can never answer to one NFT.
    function test_registeringATokenBoundToAnotherLoan_reverts() public {
        LibVaipakam.Loan memory a;
        a.id = 9_001;
        a.lender = lender;
        a.borrower = borrower;
        a.lenderTokenId = 7_001;
        a.borrowerTokenId = 7_002;
        a.status = LibVaipakam.LoanStatus.Active;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(a.id, a);

        LibVaipakam.Loan memory b = a;
        b.id = 9_002;
        b.lenderTokenId = 7_003;
        // b.borrowerTokenId stays 7_002 — already loan 9_001's.
        vm.expectRevert(
            abi.encodeWithSelector(LibMetricsHooks.PositionTokenBoundToAnotherLoan.selector, uint256(7_002), uint256(9_001))
        );
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(b.id, b);
    }
}
