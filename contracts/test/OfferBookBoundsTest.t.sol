// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {OfferBookFacet} from "../src/facets/OfferBookFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {NumeraireConfigFacet} from "../src/facets/NumeraireConfigFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibOfferAdmission} from "../src/libraries/LibOfferAdmission.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title OfferBookBoundsTest
 * @notice #3242 — the two offer-book bounds: the value floor on a priced
 *         principal ($10 by default) and the per-wallet open-offer cap.
 *
 *         SetupTest convention: `mockERC20` and `mockCollateralERC20` are $1,
 *         18 decimals, liquid; `mockIlliquidERC20` is illiquid. A lender offer
 *         carries twice its amount as collateral to clear the #900 floor.
 */
contract OfferBookBoundsTest is SetupTest {
    function setUp() public {
        setupHelper();
        // The shared fixture lowers the floor for wei-sized suites; this one
        // tests the production default.
        NumeraireConfigFacet(address(diamond)).setMinOfferValueNumeraire(0);
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    function _params(
        LibVaipakam.OfferType offerType,
        address lendingAsset,
        uint256 amount,
        uint256 collateral
    ) internal view returns (LibVaipakam.CreateOfferParams memory) {
        return LibVaipakam.CreateOfferParams({
            offerType: offerType,
            lendingAsset: lendingAsset,
            amount: amount,
            interestRateBps: 500,
            collateralAsset: mockCollateralERC20,
            collateralAmount: collateral,
            durationDays: 30,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: lendingAsset,
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: amount,
            interestRateBpsMax: 500,
            collateralAmountMax: collateral,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
    }

    function _lend(uint256 amount) internal returns (uint256 offerId) {
        vm.prank(lender);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, mockERC20, amount, amount * 2)
        );
    }

    function _book() internal view returns (OfferBookFacet) {
        return OfferBookFacet(address(diamond));
    }

    // ── the value floor ─────────────────────────────────────────────────────

    function test_floorRefusesOfferWorthLessThanTenDollars() public {
        vm.expectRevert(
            abi.encodeWithSelector(LibOfferAdmission.OfferBelowMinimumValue.selector, 5e18, 10e18)
        );
        _lend(5 ether);
    }

    function test_floorAdmitsOfferAtTheFloor() public {
        uint256 id = _lend(10 ether);
        assertGt(id, 0);
    }

    /// @dev A one-wei liquid offer is refused like any other below the floor:
    ///      liquidity is read on its own, so a tiny value is never read as an
    ///      unpriced principal.
    function test_floorRefusesDust() public {
        vm.expectRevert(
            abi.encodeWithSelector(LibOfferAdmission.OfferBelowMinimumValue.selector, 1, 10e18)
        );
        vm.prank(lender);
        OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, mockERC20, 1, 10)
        );
    }

    /// @dev The protocol values an illiquid principal at nothing, so the floor
    ///      never refuses one, whatever its feed says.
    function test_floorNeverRefusesAnIlliquidPrincipal() public {
        vm.prank(borrower);
        uint256 id = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, mockIlliquidERC20, 1 ether, 100 ether)
        );
        assertGt(id, 0);
    }

    /// @dev The form-sizing view agrees with enforcement: its amount is
    ///      admitted and one base unit less is refused.
    function test_minOfferAmountIsTheSmallestAdmitted() public {
        (bool binds, uint256 minAmount) = _book().getMinOfferAmount(mockERC20);
        assertTrue(binds, "the floor binds a liquid priced token");
        assertEq(minAmount, 10 ether, "$10 of a $1 token");
        assertGt(_lend(minAmount), 0);
        vm.expectPartialRevert(LibOfferAdmission.OfferBelowMinimumValue.selector);
        _lend(minAmount - 1);
    }

    function test_minOfferAmountDoesNotBindAnIlliquidToken() public view {
        (bool binds, uint256 minAmount) = _book().getMinOfferAmount(mockIlliquidERC20);
        assertFalse(binds);
        assertEq(minAmount, 0);
    }

    function test_floorFollowsGovernanceAndResets() public {
        NumeraireConfigFacet(address(diamond)).setMinOfferValueNumeraire(20e18);
        assertEq(NumeraireConfigFacet(address(diamond)).getMinOfferValueNumeraire(), 20e18);
        vm.expectRevert(
            abi.encodeWithSelector(LibOfferAdmission.OfferBelowMinimumValue.selector, 15e18, 20e18)
        );
        _lend(15 ether);

        NumeraireConfigFacet(address(diamond)).setMinOfferValueNumeraire(0);
        assertEq(NumeraireConfigFacet(address(diamond)).getMinOfferValueNumeraire(), 10e18);
        _lend(15 ether);
    }

    function test_floorSetterIsBounded() public {
        vm.expectPartialRevert(IVaipakamErrors.ParameterOutOfRange.selector);
        NumeraireConfigFacet(address(diamond)).setMinOfferValueNumeraire(1e17);
        vm.expectPartialRevert(IVaipakamErrors.ParameterOutOfRange.selector);
        NumeraireConfigFacet(address(diamond)).setMinOfferValueNumeraire(1e25);
    }

    function test_floorSetterIsAdminOnly() public {
        vm.prank(lender);
        vm.expectRevert();
        NumeraireConfigFacet(address(diamond)).setMinOfferValueNumeraire(20e18);
    }

    /// @dev An amount change meets the same floor creation applies.
    function test_floorBindsAnAmountChange() public {
        uint256 id = _lend(100 ether);
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(LibOfferAdmission.OfferBelowMinimumValue.selector, 4e18, 10e18)
        );
        OfferMutateFacet(address(diamond)).setOfferAmount(id, 4 ether, 4 ether);
    }

    // ── the open-offer cap ──────────────────────────────────────────────────

    function test_capRefusesTheOfferPastIt_andCancellingMakesRoom() public {
        ConfigFacet(address(diamond)).setMaxOpenOffersPerWallet(5);
        uint256[] memory ids = new uint256[](5);
        for (uint256 i; i < 5; ++i) ids[i] = _lend(20 ether);

        (uint256 floor_, uint256 cap, uint256 open) = _book().getOfferBookBounds(lender);
        assertEq(floor_, 10e18);
        assertEq(cap, 5);
        assertEq(open, 5);

        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(LibOfferAdmission.TooManyOpenOffers.selector, 5, 5));
        OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, mockERC20, 20 ether, 40 ether)
        );

        // Past the cancel cooldown a fresh offer carries.
        vm.warp(block.timestamp + 1 days);
        vm.prank(lender);
        OfferCancelFacet(address(diamond)).cancelOffer(ids[2]);
        (, , open) = _book().getOfferBookBounds(lender);
        assertEq(open, 4);
        _lend(20 ether);
        (, , open) = _book().getOfferBookBounds(lender);
        assertEq(open, 5);
    }

    /// @dev The cap is per wallet: one wallet at the cap does not block another.
    function test_capIsPerWallet() public {
        ConfigFacet(address(diamond)).setMaxOpenOffersPerWallet(5);
        for (uint256 i; i < 5; ++i) _lend(20 ether);
        vm.prank(borrower);
        uint256 id = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, mockERC20, 20 ether, 100 ether)
        );
        assertGt(id, 0);
        (, , uint256 open) = _book().getOfferBookBounds(borrower);
        assertEq(open, 1);
    }

    function test_capDefaultAndSetterBounds() public {
        assertEq(ConfigFacet(address(diamond)).getMaxOpenOffersPerWallet(), 25);
        vm.expectPartialRevert(IVaipakamErrors.ParameterOutOfRange.selector);
        ConfigFacet(address(diamond)).setMaxOpenOffersPerWallet(4);
        vm.expectPartialRevert(IVaipakamErrors.ParameterOutOfRange.selector);
        ConfigFacet(address(diamond)).setMaxOpenOffersPerWallet(1001);
        ConfigFacet(address(diamond)).setMaxOpenOffersPerWallet(40);
        assertEq(ConfigFacet(address(diamond)).getMaxOpenOffersPerWallet(), 40);
        ConfigFacet(address(diamond)).setMaxOpenOffersPerWallet(0);
        assertEq(ConfigFacet(address(diamond)).getMaxOpenOffersPerWallet(), 25);
    }

    // ── the entry step itself ───────────────────────────────────────────────

    function test_openOfferOnBookIsDiamondInternal() public {
        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.UnauthorizedCrossFacetCall.selector);
        _book().openOfferOnBook(1, LibOfferAdmission.Route.UserPosted);
    }

    /// @dev The creation events still come out, with their old signatures.
    function test_creationStillEmitsOfferCreated() public {
        vm.expectEmit(true, true, false, true, address(diamond));
        emit OfferCreateFacet.OfferCreated(1, lender, LibVaipakam.OfferType.Lender);
        _lend(10 ether);
    }
}
