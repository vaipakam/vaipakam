// test/PositionNftMetadataUnitsTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {VaipakamNFTMetadataFacet} from "../src/facets/VaipakamNFTMetadataFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @dev Exposes the facet's attribute renderer so a test can read the traits
///      as text instead of decoding the base64 token URI.
contract NftAttributesHarness is VaipakamNFTMetadataFacet {
    function attributes(MetricsFacet.NFTPositionSummary memory s)
        external
        pure
        returns (string memory)
    {
        return _buildAttributes(s);
    }
}

/**
 * @title  PositionNftMetadataUnitsTest
 * @notice #2957 — a position NFT's summary and metadata state every figure in
 *         the asset it is actually in. A rental (an ERC-721 lent against a
 *         6-decimal prepay token) is the case the role-based guess got wrong:
 *         its claims are in the prepay token, and it has no collateral leg.
 */
contract PositionNftMetadataUnitsTest is SetupTest {
    uint256 constant DAILY_FEE = 10e6; // 10 USDC a day
    uint256 constant DURATION = 7;

    address usdc;
    NftAttributesHarness harness;

    function setUp() public {
        setupHelper();
        usdc = address(new ERC20Mock("USD Coin", "USDC", 6));
        mockOracleLiquidity(usdc, LibVaipakam.LiquidityStatus.Liquid);
        mockOraclePrice(usdc, 1e8, 8);
        ERC20Mock(usdc).mint(borrower, 1_000_000e6);
        vm.prank(borrower);
        ERC20Mock(usdc).approve(address(diamond), type(uint256).max);
        harness = new NftAttributesHarness();
    }

    function _rental() internal returns (uint256 loanId) {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockNft721,
                amount: DAILY_FEE,
                interestRateBps: 0,
                collateralAsset: address(0),
                collateralAmount: 0,
                durationDays: DURATION,
                assetType: LibVaipakam.AssetType.ERC721,
                tokenId: 1,
                quantity: 1,
                creatorRiskAndTermsConsent: true,
                prepayAsset: usdc,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: DAILY_FEE,
                interestRateBpsMax: 0,
                collateralAmountMax: 0,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
        loanId = LibAcceptTestSigner.signAndAccept(address(diamond), borrower, borrowerPk, offerId);
    }

    function _summary(uint256 tokenId) internal view returns (MetricsFacet.NFTPositionSummary memory) {
        return MetricsFacet(address(diamond)).getNFTPositionSummary(tokenId);
    }

    function _has(string memory text, string memory part) internal pure returns (bool) {
        return vm.indexOf(text, part) != type(uint256).max;
    }

    /// @notice An open rental states the rented NFT, the daily fee and the
    ///         prepayment in the prepay token, and no collateral.
    function test_openRental_statesItsOwnUnits() public {
        uint256 loanId = _rental();
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        MetricsFacet.NFTPositionSummary memory s = _summary(loan.lenderTokenId);

        assertEq(uint8(s.principalAssetType), uint8(LibVaipakam.AssetType.ERC721), "lent asset is the NFT");
        assertEq(s.principalTokenId, 1, "rented token");
        assertEq(s.principalDecimals, 0, "an NFT has no decimals");
        assertEq(s.principalAmount, DAILY_FEE, "principal is the daily fee");
        assertEq(s.prepayAsset, usdc, "prepay asset");
        assertEq(s.prepaySymbol, "USDC", "prepay symbol");
        assertEq(s.prepayDecimals, 6, "prepay decimals");
        assertEq(s.prepayAmount, loan.prepayAmount, "prepaid rent");
        assertEq(s.bufferAmount, loan.bufferAmount, "prepaid buffer");
        assertEq(bytes(s.collateralSymbol).length, 0, "a rental has no collateral symbol");
        assertEq(s.collateralDecimals, 0, "a rental has no collateral decimals");

        string memory a = harness.attributes(s);
        assertTrue(_has(a, '"Lent Asset Kind","value":"ERC721"'), "lent kind");
        assertTrue(_has(a, '"Collateral Kind","value":"None"'), "no collateral kind");
        assertTrue(_has(a, '"Daily Rental Fee","value":"10 USDC"'), "daily fee in USDC");
        assertTrue(_has(a, '"Rented Asset","value":"'), "rented asset trait");
        assertFalse(_has(a, '"Collateral Amount"'), "no collateral amount trait");
    }

    /// @notice After the rental closes, each side's claim is stated in the
    ///         prepay token at its own decimals, whatever the holder's role.
    function test_closedRental_claimsInPrepayToken() public {
        uint256 loanId = _rental();
        vm.warp(block.timestamp + DURATION * 1 days);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);

        MetricsFacet.NFTPositionSummary memory l = _summary(loan.lenderTokenId);
        assertEq(l.claimableAsset, usdc, "lender claims in the prepay token");
        assertEq(uint8(l.claimableAssetType), uint8(LibVaipakam.AssetType.ERC20), "lender claim kind");
        assertEq(l.claimableSymbol, "USDC", "lender claim symbol");
        assertEq(l.claimableDecimals, 6, "lender claim decimals");

        MetricsFacet.NFTPositionSummary memory b = _summary(loan.borrowerTokenId);
        assertEq(b.claimableAsset, usdc, "borrower's buffer refund is in the prepay token");
        assertEq(b.claimableDecimals, 6, "borrower claim decimals");

        // The rendered claim is the amount at 6 decimals with the symbol.
        assertTrue(l.isClaimable, "lender claim is open");
        string memory a = harness.attributes(l);
        assertTrue(_has(a, ' USDC (terminal)"'), "claim rendered in USDC");
    }
}
