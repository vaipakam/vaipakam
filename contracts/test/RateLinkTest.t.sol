// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {RegistryKeys} from "../src/governance/RegistryKeys.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RateLinkFacet} from "../src/facets/RateLinkFacet.sol";
import {IRateReference} from "../src/interfaces/IRateReference.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockProtocolRegistry} from "./mocks/MockProtocolRegistry.sol";
import {MockRateReferenceLink} from "./mocks/MockRateReferenceLink.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {LibTestTiming} from "./helpers/LibTestTiming.sol";

/// @title RateLinkTest — #3635 part A and the #3713 warning band
/// @notice The Diamond's wiring of the rate reference, against a stand-in
///         reference with set figures: the band check on every rate write
///         (the maker's typed worst bound, the taker's actual rate), the
///         link admission, the linked endpoint a direct accept opens at, the
///         acceptor's signed limit and the warnings a loan records.
contract RateLinkTest is SetupTest {
    uint256 internal constant PRINCIPAL = 1_000 ether;
    MockRateReferenceLink internal ref;
    RateLinkFacet internal link;

    function setUp() public {
        setupHelper();
        ref = new MockRateReferenceLink();
        link = RateLinkFacet(address(diamond));
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function _install() internal {
        MockProtocolRegistry(OracleAdminFacet(address(diamond)).getProtocolRegistry()).setPointer(
            RegistryKeys.RATE_REFERENCE, address(ref)
        );
        ref.setTermAverage(5e16); // 5%
    }

    function _params(LibVaipakam.OfferType kind, uint256 rate, uint256 rateMax)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory p)
    {
        p = LibVaipakam.CreateOfferParams({
            integrator: address(0),
            lifecycleFlex: 0,
            offerType: kind,
            lendingAsset: mockERC20,
            amount: PRINCIPAL,
            interestRateBps: rate,
            collateralAsset: mockCollateralERC20,
            collateralAmount: PRINCIPAL * 2,
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
            interestRateBpsMax: rateMax,
            collateralAmountMax: PRINCIPAL * 2,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false,
            linkKind: 0,
            linkMarginBps: 0,
            rateFarFromAverageAcknowledged: false
        });
    }

    function _create(address who, LibVaipakam.CreateOfferParams memory p) internal returns (uint256) {
        ERC20Mock(p.offerType == LibVaipakam.OfferType.Lender ? mockERC20 : mockCollateralERC20).mint(
            who, PRINCIPAL * 2
        );
        vm.prank(who);
        return OfferCreateFacet(address(diamond)).createOffer(p, type(uint64).max);
    }

    function _expectCreateRevert(address who, LibVaipakam.CreateOfferParams memory p, bytes memory err) internal {
        ERC20Mock(p.offerType == LibVaipakam.OfferType.Lender ? mockERC20 : mockCollateralERC20).mint(
            who, PRINCIPAL * 2
        );
        vm.prank(who);
        vm.expectRevert(err);
        OfferCreateFacet(address(diamond)).createOffer(p, type(uint64).max);
    }

    /// @dev A lender offer linked to the reference + 1 point, typed range
    ///      3% to 8%.
    function _linkedLender() internal returns (uint256 offerId) {
        ref.setLinked(4e16, 0); // 4% -> linked floor 5%
        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Lender, 300, 800);
        p.linkKind = uint8(IRateReference.LinkKind.Reference);
        p.linkMarginBps = 100;
        offerId = _create(lender, p);
        LibTestTiming.waitOutTermsAge(address(diamond), offerId);
    }

    function _terms(uint256 offerId, uint256 limitBps, bool ack)
        internal
        returns (LibAcceptTerms.AcceptTerms memory t, bytes memory sig)
    {
        t = LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, true, 0);
        t.interestRateBps = limitBps;
        t.rateFarFromAverageAcknowledged = ack;
        sig = LibAcceptTestSigner.sign(address(diamond), t, borrowerPk);
    }

    // ── No reference ─────────────────────────────────────────────────────

    /// With no reference there is no band, and a link is refused by name.
    function test_noReference_noBandAndLinkRefused() public {
        assertEq(link.getRateReference(), address(0));
        _create(lender, _params(LibVaipakam.OfferType.Lender, 2_000, 2_000));
        (uint8 w, IRateReference.Band memory b) = link.rateWarnings(mockERC20, 30, 2_000);
        assertEq(w, 0);
        assertFalse(b.available);

        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Lender, 300, 300);
        p.linkKind = 1;
        _expectCreateRevert(lender, p, abi.encodeWithSelector(RateLinkFacet.RateLinkNoReference.selector, mockERC20));
    }

    // ── The maker's typed worst bound ────────────────────────────────────

    function test_lenderFloorFarAbove_needsTheAcknowledgement() public {
        _install();
        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Lender, 800, 800);
        _expectCreateRevert(
            lender,
            p,
            abi.encodeWithSelector(RateLinkFacet.RateFarFromTermAverage.selector, mockERC20, 30, 800, 500, true)
        );
        p.rateFarFromAverageAcknowledged = true;
        _create(lender, p);
        (uint8 w,) = link.rateWarnings(mockERC20, 30, 800);
        assertEq(w, link.WARN_FAR_ABOVE());
    }

    function test_lenderFloorFarBelow_needsTheAcknowledgement() public {
        _install();
        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Lender, 200, 200);
        _expectCreateRevert(
            lender,
            p,
            abi.encodeWithSelector(RateLinkFacet.RateFarFromTermAverage.selector, mockERC20, 30, 200, 500, false)
        );
        // Within 2 points is never outside, however far in proportion.
        _create(lender, _params(LibVaipakam.OfferType.Lender, 400, 400));
    }

    /// A borrower is checked on its ceiling, not its floor.
    function test_borrowerCeilingIsTheCheckedRate() public {
        _install();
        _create(borrower, _params(LibVaipakam.OfferType.Borrower, 100, 500)); // floor far below, ceiling at avg
        _expectCreateRevert(
            borrower,
            _params(LibVaipakam.OfferType.Borrower, 500, 900),
            abi.encodeWithSelector(RateLinkFacet.RateFarFromTermAverage.selector, mockERC20, 30, 900, 500, true)
        );
    }

    /// An edit that leaves the checked rate where it was asks for no new flag.
    function test_edit_unchangedCheckedRateNeedsNoFlag() public {
        _install();
        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Lender, 800, 800);
        p.rateFarFromAverageAcknowledged = true;
        uint256 offerId = _create(lender, p);

        vm.prank(lender);
        OfferMutateFacet(address(diamond)).setOfferRate(offerId, 800, 800, 0, 0, false, type(uint64).max);

        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(RateLinkFacet.RateFarFromTermAverage.selector, mockERC20, 30, 900, 500, true)
        );
        OfferMutateFacet(address(diamond)).setOfferRate(offerId, 900, 900, 0, 0, false, type(uint64).max);

        vm.prank(lender);
        OfferMutateFacet(address(diamond)).setOfferRate(offerId, 900, 900, 0, 0, true, type(uint64).max);
    }

    // ── Link admission ───────────────────────────────────────────────────

    function test_linkAdmission() public {
        _install();
        assertEq(link.getRateReference(), address(ref));
        link.requireLinkAdmissible(mockERC20, 2, -100); // term average, margin below

        vm.expectRevert(abi.encodeWithSelector(RateLinkFacet.RateLinkInvalid.selector, uint8(3), int256(0)));
        link.requireLinkAdmissible(mockERC20, 3, 0);
        vm.expectRevert(abi.encodeWithSelector(RateLinkFacet.RateLinkInvalid.selector, uint8(0), int256(5)));
        link.requireLinkAdmissible(mockERC20, 0, 5);
        int16 tooFar = int16(int256(LibVaipakam.MAX_INTEREST_BPS) + 1);
        vm.expectRevert(abi.encodeWithSelector(RateLinkFacet.RateLinkInvalid.selector, uint8(1), int256(tooFar)));
        link.requireLinkAdmissible(mockERC20, 1, tooFar);

        ref.setSeries(0);
        vm.expectRevert(abi.encodeWithSelector(RateLinkFacet.RateLinkNoReference.selector, mockERC20));
        link.requireLinkAdmissible(mockERC20, 1, 0);
    }

    /// An edit writing a link runs the same admission as a creation.
    function test_edit_linkMarginOutOfRangeRefused() public {
        _install();
        uint256 offerId = _create(lender, _params(LibVaipakam.OfferType.Lender, 500, 500));
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(RateLinkFacet.RateLinkInvalid.selector, uint8(1), int256(-20_000)));
        OfferMutateFacet(address(diamond)).setOfferRate(offerId, 500, 500, 1, -20_000, false, type(uint64).max);
    }

    // ── Direct accept of a linked offer ──────────────────────────────────

    function test_linkedLender_bounds() public {
        _install();
        uint256 offerId = _linkedLender();
        (uint256 lo, uint256 hi, uint8 refusal) = link.offerRateBounds(offerId, 30);
        assertEq(lo, 500, "the link lifts the floor");
        assertEq(hi, 800);
        assertEq(refusal, 0);
        ref.setLinked(1e16, 0); // a link below the typed floor never loosens it
        (lo,,) = link.offerRateBounds(offerId, 30);
        assertEq(lo, 300);
    }

    function test_directAccept_opensAtTheLinkedFloor_withinTheSignedLimit() public {
        _install();
        uint256 offerId = _linkedLender();

        (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) = _terms(offerId, 300, false);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(RateLinkFacet.RateBeyondAcceptorLimit.selector, 500, 300));
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);

        (t, sig) = _terms(offerId, 600, false);
        vm.prank(borrower);
        uint256 loanId = OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(l.interestRateBps, 500);
        assertTrue(l.rateFromLink);
        assertEq(link.loanRateWarnings(loanId), 0);
    }

    /// The taker is checked on the actual rate, with its own flag.
    function test_directAccept_takerBandNeedsTheAcknowledgement() public {
        _install();
        uint256 offerId = _linkedLender();
        ref.setTermAverage(1e16); // the average falls after the offer was posted

        (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) = _terms(offerId, 600, false);
        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(RateLinkFacet.RateFarFromTermAverage.selector, mockERC20, 30, 500, 100, true)
        );
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);

        (t, sig) = _terms(offerId, 600, true);
        vm.prank(borrower);
        uint256 loanId = OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
        assertEq(link.loanRateWarnings(loanId), link.WARN_FAR_ABOVE());
    }

    function test_directAccept_refusedWhileTheLinkCannotBeUsed() public {
        _install();
        uint256 offerId = _linkedLender();
        ref.setLinked(0, uint8(IRateReference.LinkRefusal.ReferenceUnavailable));

        (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) = _terms(offerId, 600, false);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(RateLinkFacet.RateLinkUnavailable.selector, uint8(1)));
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
    }

    /// The link only tightens: a linked floor above the typed maximum leaves
    /// no acceptable rate, and a direct accept is refused rather than opened
    /// above the maker's own ceiling.
    function test_directAccept_refusedWhenTheLinkCrossesTheTypedMax() public {
        _install();
        uint256 offerId = _linkedLender();
        ref.setLinked(9e16, 0); // 9% -> linked floor 10%, above the 8% max
        (uint256 lo, uint256 hi, uint8 refusal) = link.offerRateBounds(offerId, 30);
        assertEq(lo, 1000);
        assertEq(hi, 800);
        assertEq(refusal, 3, "an empty range is reported");

        (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) = _terms(offerId, 2000, true);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(RateLinkFacet.RateRangeEmpty.selector, 1000, 800));
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
    }

    /// An unlinked offer still binds the signed rate exactly.
    function test_unlinkedOffer_keepsTheExactRateBinding() public {
        _install();
        uint256 offerId = _create(lender, _params(LibVaipakam.OfferType.Lender, 500, 500));
        LibTestTiming.waitOutTermsAge(address(diamond), offerId);
        (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) = _terms(offerId, 600, false);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(OfferAcceptFacet.OfferTermsMismatch.selector, uint8(8)));
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
    }

    // ── Auto-lend slot ───────────────────────────────────────────────────

    function _setIntent(uint256 minRate, bool ack) internal {
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, 0, 100_000 ether, minRate, 6600, 90, 100 ether, false, 0, false, true,
            LibVaipakam.IntentRateTerms(0, 0, ack),
            type(uint64).max
        );
    }

    function test_intentFloor_needsTheAcknowledgement_onceForTheSameFloor() public {
        _install();
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(RateLinkFacet.RateFarFromTermAverage.selector, mockERC20, 90, 800, 500, true)
        );
        _setIntent(800, false);

        vm.prank(lender);
        _setIntent(800, true);
        // Re-setting the same floor asks for no new flag.
        vm.prank(lender);
        _setIntent(800, false);
    }
}
