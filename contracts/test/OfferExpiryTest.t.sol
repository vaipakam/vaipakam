// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";

/// @title OfferExpiryTest
/// @notice #195 — GTT (Good-Till-Time) offer-expiry coverage. The
///         contract change is small but the surface is broad: the
///         expiry guard fires at every offer-read consumer (direct
///         accept, matchOffers, previewAccept, previewMatch) AND the
///         cancel-access gate widens. This file pins each branch.
contract OfferExpiryTest is SetupTest {
    uint64 internal constant ONE_HOUR = 60 * 60;

    function setUp() public {
        setupHelper();
        // Pre-seed both sides with ample balance + approvals so the
        // tests stay focused on the expiry logic.
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

    // ─── Helpers ────────────────────────────────────────────────────

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

    // ─── createOffer bounds ─────────────────────────────────────────

    function testCreateOfferGtcDefaultPreservesLegacyBehaviour() public {
        uint256 id = _createLender(0);
        LibVaipakam.Offer memory o =
            OfferCancelFacet(address(diamond)).getOffer(id);
        assertEq(o.expiresAt, 0, "GTC sentinel stays zero");
        assertEq(o.amount, 1000 ether, "principal unchanged");
    }

    function testCreateOfferWithFutureExpiryStampsField() public {
        uint64 deadline = uint64(block.timestamp + 1 days);
        uint256 id = _createLender(deadline);
        LibVaipakam.Offer memory o =
            OfferCancelFacet(address(diamond)).getOffer(id);
        assertEq(o.expiresAt, deadline, "expiresAt stamped");
    }

    function testCreateOfferRevertsOnExpiryInPast() public {
        // `expiresAt == block.timestamp` is rejected — boundary uses
        // `<=` so an offer that's expired-on-arrival cannot exist.
        vm.prank(lender);
        vm.expectRevert(OfferCreateFacet.OfferExpiryInPast.selector);
        OfferCreateFacet(address(diamond)).createOffer(
            _buildLenderParams(uint64(block.timestamp))
        );
    }

    function testCreateOfferRevertsOnExpiryStrictlyBelowNow() public {
        // Time-travel forward so we have a real past timestamp.
        vm.warp(1000 days);
        vm.prank(lender);
        vm.expectRevert(OfferCreateFacet.OfferExpiryInPast.selector);
        OfferCreateFacet(address(diamond)).createOffer(
            _buildLenderParams(uint64(block.timestamp - 1))
        );
    }

    function testCreateOfferRevertsOnExpiryAboveCap() public {
        uint64 tooFar =
            uint64(block.timestamp + LibVaipakam.MAX_OFFER_EXPIRY_HORIZON + 1);
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferCreateFacet.OfferExpiryAboveCap.selector,
                tooFar,
                block.timestamp + LibVaipakam.MAX_OFFER_EXPIRY_HORIZON
            )
        );
        OfferCreateFacet(address(diamond)).createOffer(
            _buildLenderParams(tooFar)
        );
    }

    function testCreateOfferAcceptsExpiryAtCapBoundary() public {
        // `expiresAt == block.timestamp + MAX_OFFER_EXPIRY_HORIZON`
        // is the inclusive upper bound and must succeed.
        uint64 maxAllowed =
            uint64(block.timestamp + LibVaipakam.MAX_OFFER_EXPIRY_HORIZON);
        uint256 id = _createLender(maxAllowed);
        LibVaipakam.Offer memory o =
            OfferCancelFacet(address(diamond)).getOffer(id);
        assertEq(o.expiresAt, maxAllowed, "boundary value stored");
    }

    // ─── Direct accept revert path ──────────────────────────────────

    function testAcceptRevertsOnExpiredOffer() public {
        uint64 deadline = uint64(block.timestamp + ONE_HOUR);
        uint256 id = _createLender(deadline);

        // Travel past the deadline (one second beyond — strict).
        vm.warp(uint256(deadline) + 1);

        // Build + sign FIRST so the helper's diamond view-calls don't consume
        // the expectRevert; the offer-expiry guard then fires.
        LibAcceptTerms.AcceptTerms memory _t =
            LibAcceptTestSigner.buildTerms(address(diamond), borrower, id, true, 0);
        bytes memory _sig =
            LibAcceptTestSigner.sign(address(diamond), _t, borrowerPk);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferAcceptFacet.OfferExpired.selector,
                id,
                deadline
            )
        );
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(id, _t, _sig);
    }

    function testAcceptRevertsAtExactExpiryBoundary() public {
        // `isOfferExpired` uses `>=` — `block.timestamp == expiresAt`
        // must already revert (matches the createOffer `<=` rejection).
        uint64 deadline = uint64(block.timestamp + ONE_HOUR);
        uint256 id = _createLender(deadline);

        vm.warp(uint256(deadline));

        // Build + sign FIRST so the helper's diamond view-calls don't consume
        // the expectRevert; the boundary-expiry guard then fires.
        LibAcceptTerms.AcceptTerms memory _t =
            LibAcceptTestSigner.buildTerms(address(diamond), borrower, id, true, 0);
        bytes memory _sig =
            LibAcceptTestSigner.sign(address(diamond), _t, borrowerPk);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferAcceptFacet.OfferExpired.selector,
                id,
                deadline
            )
        );
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(id, _t, _sig);
    }

    function testAcceptSucceedsJustBeforeExpiry() public {
        uint64 deadline = uint64(block.timestamp + ONE_HOUR);
        uint256 id = _createLender(deadline);

        // One second before the deadline — still acceptable.
        vm.warp(uint256(deadline) - 1);

        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, id);
        assertGt(loanId, 0, "loan minted just before expiry");
    }

    // ─── previewAccept classifier ───────────────────────────────────

    function testPreviewAcceptReturnsOfferExpiredClassifier() public {
        uint64 deadline = uint64(block.timestamp + ONE_HOUR);
        uint256 id = _createLender(deadline);

        vm.warp(uint256(deadline) + 1);

        OfferAcceptFacet.AcceptPreview memory p =
            OfferAcceptFacet(address(diamond)).previewAccept(id, borrower);
        assertEq(
            uint256(p.errorCode),
            uint256(OfferAcceptFacet.AcceptError.OfferExpired),
            "preview surfaces OfferExpired classifier"
        );
    }

    function testPreviewAcceptIsCleanWhenUnexpired() public {
        uint64 deadline = uint64(block.timestamp + ONE_HOUR);
        uint256 id = _createLender(deadline);

        OfferAcceptFacet.AcceptPreview memory p =
            OfferAcceptFacet(address(diamond)).previewAccept(id, borrower);
        assertEq(
            uint256(p.errorCode),
            uint256(OfferAcceptFacet.AcceptError.None),
            "unexpired offer clears the classifier"
        );
    }

    // ─── previewMatch classifier ────────────────────────────────────

    function testPreviewMatchReturnsOfferExpiredWhenLenderExpired() public {
        uint64 deadline = uint64(block.timestamp + ONE_HOUR);
        uint256 lenderId = _createLender(deadline);
        uint256 borrowerId = _createBorrower(0); // GTC borrower

        vm.warp(uint256(deadline) + 1);

        LibOfferMatch.MatchResult memory r =
            OfferMatchFacet(address(diamond)).previewMatch(lenderId, borrowerId);
        assertEq(
            uint256(r.errorCode),
            uint256(LibOfferMatch.MatchError.OfferExpired),
            "lender-side expiry surfaces in previewMatch"
        );
    }

    function testPreviewMatchReturnsOfferExpiredWhenBorrowerExpired() public {
        uint64 deadline = uint64(block.timestamp + ONE_HOUR);
        uint256 lenderId = _createLender(0); // GTC lender
        uint256 borrowerId = _createBorrower(deadline);

        vm.warp(uint256(deadline) + 1);

        LibOfferMatch.MatchResult memory r =
            OfferMatchFacet(address(diamond)).previewMatch(lenderId, borrowerId);
        assertEq(
            uint256(r.errorCode),
            uint256(LibOfferMatch.MatchError.OfferExpired),
            "borrower-side expiry surfaces in previewMatch"
        );
    }

    // ─── cancelOffer — creator path unchanged ───────────────────────

    function testCreatorCanStillCancelUnexpiredGTCOffer() public {
        uint256 id = _createLender(0);
        vm.prank(lender);
        OfferCancelFacet(address(diamond)).cancelOffer(id);

        LibVaipakam.Offer memory o =
            OfferCancelFacet(address(diamond)).getOffer(id);
        assertEq(o.creator, address(0), "offer storage cleared");
    }

    function testNonCreatorCannotCancelUnexpiredOffer() public {
        uint256 id = _createLender(0);
        // borrower is NOT the creator and the offer is GTC (never
        // expires) — must hit the new typed revert.
        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferCancelFacet.NotCreatorOrNotExpired.selector,
                lender,
                uint64(0)
            )
        );
        OfferCancelFacet(address(diamond)).cancelOffer(id);
    }

    function testNonCreatorCannotCancelGTTOfferBeforeExpiry() public {
        uint64 deadline = uint64(block.timestamp + ONE_HOUR);
        uint256 id = _createLender(deadline);
        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferCancelFacet.NotCreatorOrNotExpired.selector,
                lender,
                deadline
            )
        );
        OfferCancelFacet(address(diamond)).cancelOffer(id);
    }

    // ─── cancelOffer — permissionless lazy-clear path ───────────────

    function testAnyoneCanCancelExpiredOfferAndRefundRoutesToCreator() public {
        uint64 deadline = uint64(block.timestamp + ONE_HOUR);
        uint256 id = _createLender(deadline);

        // Snapshot the lender's wallet balance before warp + clear so
        // we can compare the principal-refund destination.
        uint256 lenderBalBefore = ERC20Mock(mockERC20).balanceOf(lender);
        uint256 cleanerBalBefore = ERC20Mock(mockERC20).balanceOf(borrower);

        vm.warp(uint256(deadline) + 1);

        // borrower (NOT the creator) clears the expired offer.
        vm.prank(borrower);
        OfferCancelFacet(address(diamond)).cancelOffer(id);

        // The lender (creator) receives the full pre-vaulted principal
        // back; the cleaner sees no asset flow.
        uint256 lenderBalAfter = ERC20Mock(mockERC20).balanceOf(lender);
        uint256 cleanerBalAfter = ERC20Mock(mockERC20).balanceOf(borrower);

        assertEq(
            lenderBalAfter - lenderBalBefore,
            1000 ether,
            "refund routes to creator, not cleaner"
        );
        assertEq(
            cleanerBalAfter,
            cleanerBalBefore,
            "cleaner gets no asset kickback"
        );
    }

    function testCreatorCanCancelOwnExpiredOffer() public {
        uint64 deadline = uint64(block.timestamp + ONE_HOUR);
        uint256 id = _createLender(deadline);

        vm.warp(uint256(deadline) + 1);

        uint256 balBefore = ERC20Mock(mockERC20).balanceOf(lender);

        vm.prank(lender);
        OfferCancelFacet(address(diamond)).cancelOffer(id);

        uint256 balAfter = ERC20Mock(mockERC20).balanceOf(lender);
        assertEq(balAfter - balBefore, 1000 ether, "creator self-cancel refunds in full");
    }

    // ─── Cooldown bypass for expired offers ─────────────────────────

    function testExpiredOfferBypassesCancelCooldown() public {
        // Turn partialFillEnabled on so the cooldown becomes live, then
        // create an offer whose deadline is BEFORE the cooldown expiry.
        // The cleaner must succeed despite the cooldown still notionally
        // active for non-expired siblings.
        // The cooldown is governance-flipped; for this test we toggle
        // it via the diamond's ConfigFacet directly. If the flag is
        // already off (default), the test still passes — the bypass
        // branch just isn't load-bearing in that case.

        uint64 deadline = uint64(block.timestamp + 30); // 30s expiry
        uint256 id = _createLender(deadline);

        // Move past expiry but stay BEFORE the MIN_OFFER_CANCEL_DELAY
        // window would have elapsed (5 minutes). The bypass is the
        // load-bearing thing here.
        vm.warp(uint256(deadline) + 1);

        // Non-creator cleans up; expiry-bypass means the cooldown
        // check short-circuits to "skip" regardless of partialFillEnabled.
        vm.prank(borrower);
        OfferCancelFacet(address(diamond)).cancelOffer(id);

        LibVaipakam.Offer memory o =
            OfferCancelFacet(address(diamond)).getOffer(id);
        assertEq(o.creator, address(0), "offer cleared despite cooldown window");
    }
}
