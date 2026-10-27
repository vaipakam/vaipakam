// test/InitRiskGateRuleTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";

/**
 * @title  InitRiskGateRuleTest
 * @notice #2956 — the range-match preview judges whether a pair carries the
 *         initiation risk gate by the same rule as the binding accept
 *         ({LibInitRiskGate.applies}: both legs Liquid). A pair with an
 *         illiquid leg is admitted on both parties' consent, so it carries no
 *         init-LTV check whichever regime is on, and the preview must not
 *         refuse what `matchOffers` would admit. A both-liquid pair still
 *         carries the gate.
 */
contract InitRiskGateRuleTest is SetupTest {
    uint256 constant PRINCIPAL = 5_000 ether;
    uint256 constant COLLATERAL = 10_000 ether;

    function setUp() public {
        setupHelper();
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        vm.prank(borrower);
        ERC20(mockIlliquidERC20).approve(
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower),
            type(uint256).max
        );
        vm.prank(borrower);
        ERC20(mockIlliquidERC20).approve(address(diamond), type(uint256).max);
    }

    function _params(LibVaipakam.OfferType offerType, address collateralAsset)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            offerType: offerType,
            lendingAsset: mockERC20,
            amount: PRINCIPAL,
            interestRateBps: 500,
            collateralAsset: collateralAsset,
            collateralAmount: COLLATERAL,
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
            amountMax: PRINCIPAL,
            interestRateBpsMax: 600,
            collateralAmountMax: COLLATERAL,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
    }

    function _offers(address collateralAsset)
        internal
        returns (uint256 lenderOfferId, uint256 borrowerOfferId)
    {
        vm.prank(lender);
        lenderOfferId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, collateralAsset)
        );
        vm.prank(borrower);
        borrowerOfferId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, collateralAsset)
        );
    }

    /// @dev Depth-tiered LTV on, with `asset` measured at tier 0 — the
    ///      regime whose tier cap refuses any positive LTV.
    function _depthTieredWithTierZero(address asset) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getEffectiveLiquidityTier.selector, asset),
            abi.encode(uint8(0))
        );
        address[] memory quotes = new address[](1);
        quotes[0] = mockERC20;
        vm.startPrank(owner);
        ConfigFacet(address(diamond)).setPaaAssets(quotes);
        ConfigFacet(address(diamond)).setDepthTieredLtvEnabled(true);
        vm.stopPrank();
    }

    /// @notice A consented pair with an illiquid collateral leg is matchable
    ///         under depth-tiered LTV: the preview reports Ok, and the match
    ///         settles, because neither carries the init-LTV gate.
    function test_illiquidPair_depthTiered_previewAgreesWithMatch() public {
        (uint256 lId, uint256 bId) = _offers(mockIlliquidERC20);
        _depthTieredWithTierZero(mockIlliquidERC20);

        LibOfferMatch.MatchResult memory r =
            OfferMatchFacet(address(diamond)).previewMatch(lId, bId, address(this), address(this));
        assertEq(uint8(r.errorCode), uint8(LibOfferMatch.MatchError.Ok), "preview admits the consented illiquid pair");

        OfferMatchFacet(address(diamond)).matchOffers(lId, bId);
        LibVaipakam.Offer memory B = OfferCancelFacet(address(diamond)).getOffer(bId);
        assertEq(B.amountFilled, PRINCIPAL, "the match settles as the preview said");
    }

    /// @notice The same pair is matchable with depth-tiered LTV off too.
    function test_illiquidPair_hfRegime_previewAgreesWithMatch() public {
        (uint256 lId, uint256 bId) = _offers(mockIlliquidERC20);

        LibOfferMatch.MatchResult memory r =
            OfferMatchFacet(address(diamond)).previewMatch(lId, bId, address(this), address(this));
        assertEq(uint8(r.errorCode), uint8(LibOfferMatch.MatchError.Ok), "preview admits the consented illiquid pair");

        OfferMatchFacet(address(diamond)).matchOffers(lId, bId);
        LibVaipakam.Offer memory B = OfferCancelFacet(address(diamond)).getOffer(bId);
        assertEq(B.amountFilled, PRINCIPAL, "the match settles as the preview said");
    }

    /// @notice A both-liquid pair still carries the gate: tier-0 collateral
    ///         under depth-tiered LTV is refused by the preview and the match.
    function test_liquidPair_tierZero_stillGated() public {
        (uint256 lId, uint256 bId) = _offers(mockCollateralERC20);
        _depthTieredWithTierZero(mockCollateralERC20);

        LibOfferMatch.MatchResult memory r =
            OfferMatchFacet(address(diamond)).previewMatch(lId, bId, address(this), address(this));
        assertEq(uint8(r.errorCode), uint8(LibOfferMatch.MatchError.LtvAboveTier), "preview refuses tier-0 liquid collateral");

        vm.expectRevert();
        OfferMatchFacet(address(diamond)).matchOffers(lId, bId);
    }
}
