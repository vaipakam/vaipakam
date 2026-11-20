// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {OfferPriceGuardFacet} from "../src/facets/OfferPriceGuardFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VaultDepositoryFacet} from "../src/facets/VaultDepositoryFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {LibTestTiming} from "./helpers/LibTestTiming.sol";
import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";

/// @title  OfferHolderRightsTest
/// @notice #3744 — an open offer's value follows its position token. The
///         token's holder cancels it, changes its terms and lowers its escrow;
///         every refund (a cancel, an expired clean-up, a size-down) is paid
///         into that holder's VAULT as its free balance (only the owner's own
///         withdrawal reaches a wallet); only the creator, still holding the
///         token, may raise the escrow. A creator still holding its offer
///         keeps the released escrow, free, where it already sits.
contract OfferHolderRightsTest is SetupTest {
    address internal buyer;
    address internal cleaner;

    function setUp() public {
        setupHelper();
        buyer = makeAddr("offerTokenBuyer");
        cleaner = makeAddr("expiredCleaner");
        deal(mockERC20, lender, 1_000_000 ether);
        deal(mockCollateralERC20, borrower, 1_000_000 ether);
        deal(mockERC20, buyer, 1_000_000 ether);
        vm.prank(lender);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);
        ERC20Mock(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(buyer);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    function _params(LibVaipakam.OfferType kind, uint256 amountMax, uint64 expiresAt)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            integrator: address(0),
            lifecycleFlex: 0,
            offerType: kind,
            lendingAsset: mockERC20,
            amount: 1000 ether,
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
            expiresAt: expiresAt,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false,
            linkKind: 0,
            linkMarginBps: 0,
            rateFarFromAverageAcknowledged: false
        });
    }

    function _lenderOffer(uint64 expiresAt) internal returns (uint256 id) {
        vm.prank(lender);
        id = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, 1500 ether, expiresAt), type(uint64).max
        );
        LibTestTiming.waitOutTermsAge(address(diamond), id);
    }

    function _borrowerOffer() internal returns (uint256 id) {
        vm.prank(borrower);
        id = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, 1000 ether, 0), type(uint64).max
        );
        LibTestTiming.waitOutTermsAge(address(diamond), id);
    }

    function _token(uint256 id) internal view returns (uint256) {
        return OfferCancelFacet(address(diamond)).getOffer(id).positionTokenId;
    }

    /// @dev Hand the offer's token to `to`, then past the cancel cooldown.
    function _sell(uint256 id, address to) internal {
        LibTestPositionNFT.move(address(diamond), _token(id), to);
        vm.warp(block.timestamp + LibVaipakam.MIN_OFFER_CANCEL_DELAY);
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return ERC20Mock(token).balanceOf(who);
    }

    function _vault(address who) internal returns (address) {
        return VaultFactoryFacet(address(diamond)).getOrCreateUserVault(who);
    }

    function _free(address who, address token) internal view returns (uint256) {
        return VaultDepositoryFacet(address(diamond)).getDepositoryHolding(who, token, 0);
    }

    // ─── The creator still holds its offer: unchanged ────────────────────

    function test_creatorHolding_cancelRefundsCreator() public {
        uint256 id = _lenderOffer(0);
        vm.warp(block.timestamp + LibVaipakam.MIN_OFFER_CANCEL_DELAY);
        address v = _vault(lender);
        uint256 walletBefore = _bal(mockERC20, lender);
        uint256 vaultBefore = _bal(mockERC20, v);
        uint256 freeBefore = _free(lender, mockERC20);
        vm.prank(lender);
        OfferCancelFacet(address(diamond)).cancelOffer(id);
        assertEq(_bal(mockERC20, v), vaultBefore, "the escrow stays in the creator's vault");
        assertEq(_free(lender, mockERC20) - freeBefore, 1500 ether, "as the creator's free balance");
        assertEq(_bal(mockERC20, lender), walletBefore, "no wallet payment");
        vm.prank(lender);
        VaultDepositoryFacet(address(diamond)).withdrawFromVault(lender, 0, mockERC20, 0, 1500 ether, lender);
        assertEq(_bal(mockERC20, lender) - walletBefore, 1500 ether, "the owner's own withdrawal reaches the wallet");
    }

    // ─── The token moved: the holder acts and is paid ────────────────────

    function test_soldOffer_creatorCannotCancel() public {
        uint256 id = _lenderOffer(0);
        _sell(id, buyer);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(OfferCancelFacet.NotCreatorOrNotExpired.selector, buyer, uint64(0)));
        OfferCancelFacet(address(diamond)).cancelOffer(id);
    }

    function test_soldOffer_holderCancels_refundPaysHolder() public {
        uint256 id = _lenderOffer(0);
        address creatorVault = _vault(lender);
        address buyerVault = _vault(buyer);
        _sell(id, buyer);
        uint256 creatorBefore = _bal(mockERC20, lender);
        uint256 buyerBefore = _bal(mockERC20, buyer);
        uint256 vaultBefore = _bal(mockERC20, creatorVault);

        vm.prank(buyer);
        OfferCancelFacet(address(diamond)).cancelOffer(id);

        assertEq(_bal(mockERC20, buyerVault), 1500 ether, "the escrow pays the token holder's vault");
        assertEq(_free(buyer, mockERC20), 1500 ether, "as the holder's free balance");
        assertEq(_bal(mockERC20, buyer), buyerBefore, "no wallet payment");
        assertEq(_bal(mockERC20, lender), creatorBefore, "nothing reaches the creator");
        assertEq(vaultBefore - _bal(mockERC20, creatorVault), 1500 ether, "from the creator's vault");
        assertEq(_free(lender, mockERC20), 0, "none of it is the creator's");
    }

    function test_soldOffer_expiredCleanupByAnyone_paysHolder() public {
        uint256 id = _lenderOffer(uint64(block.timestamp + 1 days));
        _sell(id, buyer);
        vm.warp(block.timestamp + 2 days);
        uint256 creatorBefore = _bal(mockERC20, lender);
        uint256 buyerBefore = _bal(mockERC20, buyer);

        vm.prank(cleaner);
        OfferCancelFacet(address(diamond)).cancelOffer(id);

        assertEq(_bal(mockERC20, buyer), buyerBefore, "no wallet payment");
        assertEq(_free(buyer, mockERC20), 1500 ether, "the clean-up pays the holder's vault");
        assertEq(_bal(mockERC20, lender), creatorBefore, "not the creator");
        assertEq(_bal(mockERC20, cleaner), 0, "nor the cleaner");
    }

    function test_soldBorrowerOffer_collateralRefundPaysHolder() public {
        uint256 id = _borrowerOffer();
        _sell(id, buyer);
        uint256 creatorBefore = _bal(mockCollateralERC20, borrower);

        vm.prank(buyer);
        OfferCancelFacet(address(diamond)).cancelOffer(id);

        assertEq(_free(buyer, mockCollateralERC20), 5000 ether, "the collateral pays the holder's vault");
        assertEq(_bal(mockCollateralERC20, buyer), 0, "no wallet payment");
        assertEq(_bal(mockCollateralERC20, borrower), creatorBefore, "not the creator");
    }

    function test_soldOffer_holderLowersEscrow_refundPaysHolder() public {
        uint256 id = _lenderOffer(0);
        _sell(id, buyer);
        uint256 buyerBefore = _bal(mockERC20, buyer);
        uint256 creatorBefore = _bal(mockERC20, lender);

        vm.prank(buyer);
        OfferMutateFacet(address(diamond)).setOfferAmount(id, 1000 ether, 1200 ether, type(uint64).max);

        assertEq(_bal(mockERC20, buyer), buyerBefore, "no wallet payment");
        assertEq(_free(buyer, mockERC20), 300 ether, "the cut pays the holder's vault");
        assertEq(_bal(mockERC20, lender), creatorBefore, "not the creator");
    }

    function test_soldOffer_holderCannotRaiseEscrow() public {
        uint256 id = _lenderOffer(0);
        _sell(id, buyer);
        vm.prank(buyer);
        vm.expectRevert(OfferMutateFacet.OfferEscrowRaiseByCreatorOnly.selector);
        OfferMutateFacet(address(diamond)).setOfferAmount(id, 1000 ether, 2000 ether, type(uint64).max);
    }

    function test_soldOffer_holderChangesTerms_creatorRefused() public {
        uint256 id = _lenderOffer(0);
        _sell(id, buyer);

        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.NotOfferHolder.selector);
        OfferMutateFacet(address(diamond)).setOfferRate(id, 600, 600, 0, 0, false, type(uint64).max);

        vm.prank(buyer);
        OfferMutateFacet(address(diamond)).setOfferRate(id, 600, 600, 0, 0, false, type(uint64).max);
        assertEq(OfferCancelFacet(address(diamond)).getOffer(id).interestRateBps, 600, "the holder set the rate");
    }

    function test_soldOffer_stagingRightsFollowHolder() public {
        uint256 id = _lenderOffer(0);
        _sell(id, buyer);

        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.NotOfferHolder.selector);
        OfferPriceGuardFacet(address(diamond)).setOfferPriceGuard(id, 0);

        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.NotOfferHolder.selector);
        ProfileFacet(address(diamond)).setOfferKeeperEnabled(id, makeAddr("keeper"), true);

        vm.prank(buyer);
        ProfileFacet(address(diamond)).setOfferKeeperEnabled(id, makeAddr("keeper"), true);
    }

    function test_creatorHolding_raiseStillWorks() public {
        uint256 id = _lenderOffer(0);
        uint256 before = _bal(mockERC20, lender);
        vm.prank(lender);
        OfferMutateFacet(address(diamond)).setOfferAmount(id, 1000 ether, 2000 ether, type(uint64).max);
        assertEq(before - _bal(mockERC20, lender), 500 ether, "the creator's raise pulls from its wallet");
    }
}
