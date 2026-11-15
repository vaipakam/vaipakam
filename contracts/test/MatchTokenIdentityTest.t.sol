// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";

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
}
