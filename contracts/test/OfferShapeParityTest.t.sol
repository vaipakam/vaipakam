// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibOfferShape} from "../src/libraries/LibOfferShape.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @title OfferShapeParityTest
/// @notice Pins the shared offer-shape rule (`LibOfferShape`) on both write
///         surfaces: what `createOffer` refuses, an edit refuses too (#2749),
///         and an ordinary creator can no longer post an ERC-20 loan against
///         ERC-20 collateral with no collateral at all (#2729). The
///         lender-sale vehicle, the one offer allowed to carry zero
///         collateral, is covered by the early-withdrawal suites.
contract OfferShapeParityTest is SetupTest {
    function setUp() public {
        setupHelper();
        deal(mockERC20, lender, 1_000_000 ether);
        deal(mockERC20, borrower, 1_000_000 ether);
        deal(mockCollateralERC20, borrower, 1_000_000 ether);
        vm.prank(lender);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);
        ERC20Mock(mockCollateralERC20).approve(address(diamond), type(uint256).max);
    }

    function _params(
        LibVaipakam.OfferType side,
        LibVaipakam.FillMode fillMode,
        uint256 amount,
        uint256 amountMax,
        uint256 collateral,
        uint256 collateralMax
    ) internal view returns (LibVaipakam.CreateOfferParams memory) {
        return LibVaipakam.CreateOfferParams({
            offerType: side,
            lendingAsset: mockERC20,
            amount: amount,
            interestRateBps: 500,
            collateralAsset: mockCollateralERC20,
            collateralAmount: collateral,
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
            collateralAmountMax: collateralMax,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: fillMode,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
    }

    // ─── #2729 — zero collateral is the sale vehicle's alone ───────────────

    function test_create_lenderZeroCollateralErc20Pair_refused() public {
        vm.prank(lender);
        vm.expectRevert(LibOfferShape.CollateralMustBePositive.selector);
        OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, LibVaipakam.FillMode.Partial, 1000 ether, 1000 ether, 0, 0)
        );
    }

    function test_create_borrowerZeroCollateralErc20Pair_refused() public {
        vm.prank(borrower);
        vm.expectRevert(LibOfferShape.CollateralMustBePositive.selector);
        OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, LibVaipakam.FillMode.Partial, 1000 ether, 1000 ether, 0, 0)
        );
    }

    /// @dev An edit is never the sale vehicle, so it cannot strip collateral.
    function test_mutate_collateralToZero_refused() public {
        vm.prank(lender);
        uint256 id = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, LibVaipakam.FillMode.Partial, 1000 ether, 1000 ether, 5000 ether, 5000 ether)
        );
        vm.prank(lender);
        vm.expectRevert(LibOfferShape.CollateralMustBePositive.selector);
        OfferMutateFacet(address(diamond)).setOfferCollateral(id, 0, 0);
    }

    // ─── #2749 — an all-or-nothing offer stays single-value ────────────────

    function _aonLenderOffer() internal returns (uint256 id) {
        vm.prank(lender);
        id = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, LibVaipakam.FillMode.Aon, 1000 ether, 1000 ether, 5000 ether, 5000 ether)
        );
    }

    function test_setOfferAmount_aonToRange_refused() public {
        uint256 id = _aonLenderOffer();
        vm.prank(lender);
        vm.expectRevert(LibOfferShape.AonRequiresSingleValueAmount.selector);
        OfferMutateFacet(address(diamond)).setOfferAmount(id, 1, 1000 ether);
    }

    function test_modifyOffer_aonToRange_refused() public {
        uint256 id = _aonLenderOffer();
        vm.prank(lender);
        vm.expectRevert(LibOfferShape.AonRequiresSingleValueAmount.selector);
        OfferMutateFacet(address(diamond)).modifyOffer(
            id,
            LibVaipakam.OfferModifyParams({
                amount: 1,
                amountMax: 1000 ether,
                interestRateBps: 500,
                interestRateBpsMax: 500,
                collateralAmount: 5000 ether,
                collateralAmountMax: 5000 ether
            })
        );
    }

    /// @dev A single-value edit of an AON offer is still allowed, and the
    ///      offer stays AON.
    function test_setOfferAmount_aonSingleValue_allowed() public {
        uint256 id = _aonLenderOffer();
        vm.prank(lender);
        OfferMutateFacet(address(diamond)).setOfferAmount(id, 800 ether, 800 ether);
        LibVaipakam.Offer memory o = OfferCancelFacet(address(diamond)).getOffer(id);
        assertEq(o.amount, 800 ether, "amount");
        assertEq(o.amountMax, 800 ether, "amountMax");
        assertEq(uint256(o.fillMode), uint256(LibVaipakam.FillMode.Aon), "still AON");
    }

    /// @dev A partial-fill offer keeps its range freedom: the rule is about
    ///      fill mode, not a blanket single-value requirement.
    function test_setOfferAmount_partialRange_allowed() public {
        vm.prank(lender);
        uint256 id = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, LibVaipakam.FillMode.Partial, 1000 ether, 1000 ether, 5000 ether, 5000 ether)
        );
        vm.prank(lender);
        OfferMutateFacet(address(diamond)).setOfferAmount(id, 100 ether, 1000 ether);
        assertEq(OfferCancelFacet(address(diamond)).getOffer(id).amount, 100 ether, "range edit kept");
    }
}
