// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibTiming} from "../src/libraries/LibTiming.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferPreviewFacet} from "../src/facets/OfferPreviewFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";

/// @title  OfferTermsAgeTest
/// @notice #3443 — an offer can be filled only once its terms have stood the
///         minimum age (`LibTiming.minTermsAgeSec`, default 5 s, admin range
///         1..60 s). Pins the rule at the direct accept, the match (either
///         leg), both previews, an edit of the terms, and the setter.
contract OfferTermsAgeTest is SetupTest {
    uint256 internal constant AGE = LibTiming.DEFAULT_MIN_TERMS_AGE_SEC;

    function setUp() public {
        setupHelper();
        deal(mockERC20, lender, 1_000_000 ether);
        deal(mockERC20, borrower, 1_000_000 ether);
        deal(mockCollateralERC20, lender, 1_000_000 ether);
        deal(mockCollateralERC20, borrower, 1_000_000 ether);
        vm.prank(lender);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(lender);
        ERC20Mock(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);
        ERC20Mock(mockCollateralERC20).approve(address(diamond), type(uint256).max);
    }

    /// Build a minimal lender ERC-20 offer with the supplied expiresAt.
    /// All other fields stay at conservative defaults so the legacy
    /// HF >= 1.5e18 admission rule passes (single-value, 1000 principal
    /// against 5000 collateral).
    function _buildLenderParams(uint64 expiresAt)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
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
            amountMax: 1000 ether,
            interestRateBpsMax: 500,
            collateralAmountMax: 5000 ether,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: expiresAt,
            fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
        });
    }

    /// Mirror of `_buildLenderParams` for the borrower side. Uses
    /// distinct lender/borrower addresses so previewMatch's #194
    /// self-trade short-circuit does not pre-empt the expiry classifier.
    function _buildBorrowerParams(uint64 expiresAt)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Borrower,
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
            amountMax: 1000 ether,
            interestRateBpsMax: 500,
            collateralAmountMax: 5000 ether,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: expiresAt,
            fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
        });
    }

    function _createLender(uint64 expiresAt) internal returns (uint256) {
        vm.prank(lender);
        return OfferCreateFacet(address(diamond)).createOffer(
            _buildLenderParams(expiresAt)
        );
    }

    function _createBorrower(uint64 expiresAt) internal returns (uint256) {
        vm.prank(borrower);
        return OfferCreateFacet(address(diamond)).createOffer(
            _buildBorrowerParams(expiresAt)
        );
    }

    /// Terms for `id` signed by the borrower, then the clock set to `at`.
    /// The signer helper waits out the age itself, so a test of a fresh
    /// offer builds first and moves the clock back afterwards.
    function _termsAt(uint256 id, uint256 at)
        internal
        returns (LibAcceptTerms.AcceptTerms memory t, bytes memory sig)
    {
        t = LibAcceptTestSigner.buildTerms(address(diamond), borrower, id, true, 0);
        sig = LibAcceptTestSigner.sign(address(diamond), t, borrowerPk);
        vm.warp(at);
    }

    // ─── Stamp ──────────────────────────────────────────────────────

    function testCreateStampsTermsSetAt() public {
        uint256 id = _createLender(0);
        assertEq(
            OfferCancelFacet(address(diamond)).getOffer(id).termsSetAt,
            uint64(vm.getBlockTimestamp()),
            "create stamps the terms time"
        );
    }

    // ─── Direct accept ──────────────────────────────────────────────

    function testAcceptRefusedOneSecondBeforeReady() public {
        uint256 t0 = vm.getBlockTimestamp();
        uint256 id = _createLender(0);
        (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) = _termsAt(id, t0 + AGE - 1);
        vm.expectRevert(
            abi.encodeWithSelector(LibTiming.OfferTermsTooFresh.selector, id, t0 + AGE)
        );
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(id, t, sig);
    }

    function testAcceptRefusedInTheSameSecond() public {
        uint256 t0 = vm.getBlockTimestamp();
        uint256 id = _createLender(0);
        (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) = _termsAt(id, t0);
        vm.expectRevert(
            abi.encodeWithSelector(LibTiming.OfferTermsTooFresh.selector, id, t0 + AGE)
        );
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(id, t, sig);
    }

    function testAcceptAllowedAtReadyAt() public {
        uint256 t0 = vm.getBlockTimestamp();
        uint256 id = _createLender(0);
        (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) = _termsAt(id, t0 + AGE);
        vm.prank(borrower);
        uint256 loanId = OfferAcceptFacet(address(diamond)).acceptOffer(id, t, sig);
        assertGt(loanId, 0, "fills once the terms are old enough");
    }

    // ─── An edit restarts the wait ──────────────────────────────────

    function testEditRestartsTheWait() public {
        uint256 id = _createLender(0);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        uint256 editedAt = vm.getBlockTimestamp();
        vm.prank(lender);
        OfferMutateFacet(address(diamond)).setOfferRate(id, 600, 600);
        assertEq(
            OfferCancelFacet(address(diamond)).getOffer(id).termsSetAt,
            uint64(editedAt),
            "an edit re-stamps the terms time"
        );

        (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) =
            _termsAt(id, editedAt + AGE - 1);
        vm.expectRevert(
            abi.encodeWithSelector(LibTiming.OfferTermsTooFresh.selector, id, editedAt + AGE)
        );
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(id, t, sig);

        vm.warp(editedAt + AGE);
        vm.prank(borrower);
        assertGt(
            OfferAcceptFacet(address(diamond)).acceptOffer(id, t, sig),
            0,
            "fills once the edited terms are old enough"
        );
    }

    // ─── Preview parity ─────────────────────────────────────────────

    function testPreviewAcceptReportsTermsTooFresh() public {
        uint256 id = _createLender(0);
        OfferAcceptFacet.AcceptPreview memory p =
            OfferPreviewFacet(address(diamond)).previewAccept(id, borrower);
        assertEq(
            uint256(p.errorCode),
            uint256(OfferAcceptFacet.AcceptError.TermsTooFresh),
            "fresh offer previews TermsTooFresh"
        );

        vm.warp(vm.getBlockTimestamp() + AGE);
        p = OfferPreviewFacet(address(diamond)).previewAccept(id, borrower);
        assertEq(
            uint256(p.errorCode),
            uint256(OfferAcceptFacet.AcceptError.None),
            "aged offer previews clean"
        );
    }

    // ─── Match: either leg ──────────────────────────────────────────

    function testMatchRefusedWhileBorrowerLegFresh() public {
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        uint256 lenderId = _createLender(0);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        uint256 t1 = vm.getBlockTimestamp();
        uint256 borrowerId = _createBorrower(0);
        _assertMatchWaitsForFreshLeg(lenderId, borrowerId, borrowerId, t1);
    }

    function testMatchRefusedWhileLenderLegFresh() public {
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        uint256 borrowerId = _createBorrower(0);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        uint256 t1 = vm.getBlockTimestamp();
        uint256 lenderId = _createLender(0);
        _assertMatchWaitsForFreshLeg(lenderId, borrowerId, lenderId, t1);
    }

    function _assertMatchWaitsForFreshLeg(
        uint256 lenderId,
        uint256 borrowerId,
        uint256 freshId,
        uint256 freshAt
    ) internal {
        LibOfferMatch.MatchResult memory r = OfferMatchFacet(address(diamond))
            .previewMatch(lenderId, borrowerId, address(this), address(this));
        assertEq(
            uint256(r.errorCode),
            uint256(LibOfferMatch.MatchError.TermsTooFresh),
            "previewMatch reports the fresh leg"
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                LibTiming.OfferTermsTooFresh.selector, freshId, freshAt + AGE
            )
        );
        OfferMatchFacet(address(diamond)).matchOffers(lenderId, borrowerId);

        vm.warp(freshAt + AGE);
        r = OfferMatchFacet(address(diamond))
            .previewMatch(lenderId, borrowerId, address(this), address(this));
        assertTrue(
            r.errorCode != LibOfferMatch.MatchError.TermsTooFresh,
            "aged legs clear the age check"
        );
    }

    // ─── Admin setting ──────────────────────────────────────────────

    function testDefaultAgeIsFiveSeconds() public view {
        assertEq(ConfigFacet(address(diamond)).getMinTermsAgeSec(), 5);
    }

    function testSetterBounds() public {
        vm.expectRevert(
            abi.encodeWithSelector(ConfigFacet.InvalidMinTermsAgeSec.selector, uint32(0))
        );
        ConfigFacet(address(diamond)).setMinTermsAgeSec(0);
        vm.expectRevert(
            abi.encodeWithSelector(ConfigFacet.InvalidMinTermsAgeSec.selector, uint32(61))
        );
        ConfigFacet(address(diamond)).setMinTermsAgeSec(61);

        ConfigFacet(address(diamond)).setMinTermsAgeSec(1);
        assertEq(ConfigFacet(address(diamond)).getMinTermsAgeSec(), 1);
        ConfigFacet(address(diamond)).setMinTermsAgeSec(60);
        assertEq(ConfigFacet(address(diamond)).getMinTermsAgeSec(), 60);
    }

    function testSetterAdminOnly() public {
        vm.expectRevert();
        vm.prank(lender);
        ConfigFacet(address(diamond)).setMinTermsAgeSec(10);
    }

    function testLongerAgeAppliesToAccept() public {
        ConfigFacet(address(diamond)).setMinTermsAgeSec(30);
        uint256 t0 = vm.getBlockTimestamp();
        uint256 id = _createLender(0);
        (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) = _termsAt(id, t0 + 29);
        vm.expectRevert(
            abi.encodeWithSelector(LibTiming.OfferTermsTooFresh.selector, id, t0 + 30)
        );
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(id, t, sig);
    }
}
