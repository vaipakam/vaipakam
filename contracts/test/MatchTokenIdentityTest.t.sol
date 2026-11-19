// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibOfferMatchExecute} from "../src/libraries/LibOfferMatchExecute.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";
import {ERC1155Mock} from "./mocks/ERC1155Mock.sol";
import {LibTestTiming} from "./helpers/LibTestTiming.sol";

/**
 * @title  MatchTokenIdentityTest
 * @notice A match pairs only offers that name the same NFT. The loan takes
 *         the borrower offer's token, so a lender offer for token A must not
 *         be filled against a borrower offer for token B of the same
 *         collection.
 */
contract MatchTokenIdentityTest is SetupTest {
    MockRentableNFT721 internal nft;

    function setUp() public {
        setupHelper();
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        nft = new MockRentableNFT721();
        nft.mint(borrower, 42);
        mockOracleLiquidity(address(nft), LibVaipakam.LiquidityStatus.Illiquid);
        vm.prank(borrower);
        nft.approve(address(diamond), 42);
    }

    function _params(LibVaipakam.OfferType kind, uint256 tokenId)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory p)
    {
        p.offerType = kind;
        p.lendingAsset = mockERC20;
        p.amount = 1000 ether;
        p.amountMax = 1000 ether;
        p.interestRateBps = 500;
        p.interestRateBpsMax = 500;
        p.collateralAsset = address(nft);
        p.durationDays = 30;
        p.assetType = LibVaipakam.AssetType.ERC20;
        p.creatorRiskAndTermsConsent = true;
        p.prepayAsset = mockERC20;
        p.collateralAssetType = LibVaipakam.AssetType.ERC721;
        p.collateralTokenId = tokenId;
        p.fillMode = LibVaipakam.FillMode.Partial;
    }

    function _create(address who, LibVaipakam.OfferType kind, uint256 tokenId) internal returns (uint256) {
        vm.prank(who);
        return OfferCreateFacet(address(diamond)).createOffer(_params(kind, tokenId), type(uint64).max);
    }

    function _code(uint256 lenderOfferId, uint256 borrowerOfferId) internal view returns (LibOfferMatch.MatchError) {
        return OfferMatchFacet(address(diamond)).previewMatch(lenderOfferId, borrowerOfferId, address(this), address(this))
            .errorCode;
    }

    function test_lenderOfferForAnotherTokenIsRefused() public {
        uint256 borrowerOffer = _create(borrower, LibVaipakam.OfferType.Borrower, 42);
        uint256 lenderOffer = _create(lender, LibVaipakam.OfferType.Lender, 41);
        assertEq(uint8(_code(lenderOffer, borrowerOffer)), uint8(LibOfferMatch.MatchError.AssetMismatch));
    }

    function test_lenderOfferForTheSameTokenPassesTheIdentityRule() public {
        uint256 borrowerOffer = _create(borrower, LibVaipakam.OfferType.Borrower, 42);
        uint256 lenderOffer = _create(lender, LibVaipakam.OfferType.Lender, 42);
        LibOfferMatch.MatchError code = _code(lenderOffer, borrowerOffer);
        assertTrue(code != LibOfferMatch.MatchError.AssetMismatch, "identity rule passes");
        assertTrue(code != LibOfferMatch.MatchError.MatcherDisabled, "the core ran");
    }

    // ── ERC-1155 collateral: same token id, different quantity ──────────────

    function test_erc1155CollateralOfAnotherQuantityIsRefused() public {
        ERC1155Mock coll = new ERC1155Mock();
        coll.mint(borrower, 7, 10);
        mockOracleLiquidity(address(coll), LibVaipakam.LiquidityStatus.Illiquid);
        vm.prank(borrower);
        coll.setApprovalForAll(address(diamond), true);

        LibVaipakam.CreateOfferParams memory b = _params(LibVaipakam.OfferType.Borrower, 7);
        b.collateralAsset = address(coll);
        b.collateralAssetType = LibVaipakam.AssetType.ERC1155;
        b.collateralQuantity = 5;
        vm.prank(borrower);
        uint256 borrowerOffer = OfferCreateFacet(address(diamond)).createOffer(b, type(uint64).max);

        LibVaipakam.CreateOfferParams memory l = _params(LibVaipakam.OfferType.Lender, 7);
        l.collateralAsset = address(coll);
        l.collateralAssetType = LibVaipakam.AssetType.ERC1155;
        l.collateralQuantity = 3;
        vm.prank(lender);
        uint256 lenderOffer = OfferCreateFacet(address(diamond)).createOffer(l, type(uint64).max);

        assertEq(uint8(_code(lenderOffer, borrowerOffer)), uint8(LibOfferMatch.MatchError.AssetMismatch));
    }

    // ── Rental: the LENT token differs ──────────────────────────────────────

    function _rentalParams(LibVaipakam.OfferType kind, uint256 tokenId)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory p)
    {
        p.offerType = kind;
        p.lendingAsset = address(nft);
        p.amount = 10 ether;
        p.amountMax = 10 ether;
        p.durationDays = 30;
        p.assetType = LibVaipakam.AssetType.ERC721;
        p.tokenId = tokenId;
        p.quantity = 1;
        p.creatorRiskAndTermsConsent = true;
        p.prepayAsset = mockERC20;
        p.collateralAssetType = LibVaipakam.AssetType.ERC20;
        p.fillMode = LibVaipakam.FillMode.Partial;
    }

    function test_rentalOfAnotherLentTokenIsRefused() public {
        nft.mint(lender, 7);
        nft.mint(lender, 8);
        vm.prank(lender);
        nft.setApprovalForAll(address(diamond), true);

        vm.prank(lender);
        uint256 lenderOffer = OfferCreateFacet(address(diamond)).createOffer(
            _rentalParams(LibVaipakam.OfferType.Lender, 7), type(uint64).max
        );
        vm.prank(borrower);
        uint256 borrowerOffer = OfferCreateFacet(address(diamond)).createOffer(
            _rentalParams(LibVaipakam.OfferType.Borrower, 8), type(uint64).max
        );

        assertEq(uint8(_code(lenderOffer, borrowerOffer)), uint8(LibOfferMatch.MatchError.AssetMismatch));
    }

    // ── The executed match refuses it too ───────────────────────────────────

    function test_matchOffersRevertsForAnotherToken() public {
        uint256 borrowerOffer = _create(borrower, LibVaipakam.OfferType.Borrower, 42);
        uint256 lenderOffer = _create(lender, LibVaipakam.OfferType.Lender, 41);
        LibTestTiming.waitOutTermsAge(address(diamond), lenderOffer);
        LibTestTiming.waitOutTermsAge(address(diamond), borrowerOffer);

        vm.expectRevert(LibOfferMatchExecute.AssetMismatch.selector);
        OfferMatchFacet(address(diamond)).matchOffers(lenderOffer, borrowerOffer);
    }
}
