// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {StandingOfferCheckFacet} from "../src/facets/StandingOfferCheckFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {LibTestTiming} from "./helpers/LibTestTiming.sol";

/// @title StandingOfferCheckTest — #3720 (IntegratorFeeShareDesign section 7)
/// @notice The check of one standing lender offer a borrow preview points to:
///         the four verdicts, the accept path for a borrower with no posted
///         request (only an offer of exactly its amount is comparable), and
///         the match path for a borrower with a posted request.
contract StandingOfferCheckTest is SetupTest {
    uint256 internal constant LENT = 10_000 ether;
    uint256 internal constant RATE = 500;

    StandingOfferCheckFacet internal check;

    function setUp() public {
        setupHelper();
        check = StandingOfferCheckFacet(address(diamond));
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
    }

    function _params(LibVaipakam.OfferType kind, uint256 amount, uint256 amountMax, uint256 rate, uint256 rateMax)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            integrator: address(0),
            lifecycleFlex: 0,
            offerType: kind,
            lendingAsset: mockERC20,
            amount: amount,
            interestRateBps: rate,
            collateralAsset: mockCollateralERC20,
            collateralAmount: amountMax * 2,
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
            amountMax: amountMax,
            interestRateBpsMax: rateMax,
            collateralAmountMax: amountMax * 2,
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

    /// @dev A standing lender offer of up to LENT that a match may fill in
    ///      parts of at least a tenth; a direct accept lends all of LENT.
    function _standing() internal returns (uint256 id) {
        ERC20Mock(mockERC20).mint(lender, LENT);
        vm.prank(lender);
        id = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, LENT / 10, LENT, RATE, RATE), type(uint64).max
        );
        LibTestTiming.waitOutTermsAge(address(diamond), id);
    }

    function _request(uint256 amount, uint256 rateMax) internal returns (uint256 id) {
        vm.prank(borrower);
        id = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, amount, amount, RATE, rateMax), type(uint64).max
        );
        LibTestTiming.waitOutTermsAge(address(diamond), id);
    }

    function _forAmount(uint256 id, uint256 amount, uint256 quote)
        internal
        view
        returns (StandingOfferCheckFacet.Check memory)
    {
        return check.checkForAmount(id, borrower, mockERC20, mockCollateralERC20, 30, amount, quote);
    }

    function _assertVerdict(StandingOfferCheckFacet.Check memory c, StandingOfferCheckFacet.Verdict v) internal pure {
        assertEq(uint8(c.verdict), uint8(v), "verdict");
    }

    // ── No offer, no such offer, not a lender offer ─────────────────────

    function test_noOfferPointedTo_isNotChecked() public view {
        StandingOfferCheckFacet.Check memory c = _forAmount(0, LENT, 600);
        _assertVerdict(c, StandingOfferCheckFacet.Verdict.NotChecked);
        c = check.checkAgainstRequest(0, 1, 600);
        _assertVerdict(c, StandingOfferCheckFacet.Verdict.NotChecked);
        assertFalse(c.beatsQuote);
    }

    function test_unknownOffer_isRefusedByName() public view {
        StandingOfferCheckFacet.Check memory c = _forAmount(999, LENT, 600);
        _assertVerdict(c, StandingOfferCheckFacet.Verdict.Refused);
        assertEq(uint8(c.refusedBy), uint8(StandingOfferCheckFacet.RefusedBy.NoSuchOffer));
    }

    function test_borrowerOffer_isNotAStandingLenderOffer() public {
        uint256 req = _request(LENT, 600);
        StandingOfferCheckFacet.Check memory c = _forAmount(req, LENT, 600);
        _assertVerdict(c, StandingOfferCheckFacet.Verdict.Refused);
        assertEq(uint8(c.refusedBy), uint8(StandingOfferCheckFacet.RefusedBy.NotALenderOffer));
    }

    // ── No posted request: the accept path ──────────────────────────────

    function test_accept_wholeAmount_checkedAndBeatsAHigherQuote() public {
        uint256 id = _standing();
        StandingOfferCheckFacet.Check memory c = _forAmount(id, LENT, 600);
        _assertVerdict(c, StandingOfferCheckFacet.Verdict.Checked);
        assertEq(c.offerId, id);
        assertEq(c.rateBps, RATE);
        assertEq(c.amount, LENT);
        assertTrue(c.beatsQuote, "whole amount at a strictly lower rate");

        c = _forAmount(id, LENT, RATE);
        assertFalse(c.beatsQuote, "an equal rate does not beat the quote");
    }

    function test_accept_partOfTheOffer_isNotComparable() public {
        uint256 id = _standing();
        StandingOfferCheckFacet.Check memory c = _forAmount(id, LENT / 2, 600);
        _assertVerdict(c, StandingOfferCheckFacet.Verdict.NotComparable);
        assertFalse(c.beatsQuote, "not comparable never reads as better or worse");
        assertEq(c.amount, 0);
    }

    function test_accept_differentTerm_isRefused() public {
        uint256 id = _standing();
        StandingOfferCheckFacet.Check memory c =
            check.checkForAmount(id, borrower, mockERC20, mockCollateralERC20, 60, LENT, 600);
        _assertVerdict(c, StandingOfferCheckFacet.Verdict.Refused);
        assertEq(uint8(c.refusedBy), uint8(StandingOfferCheckFacet.RefusedBy.DifferentTerms));
    }

    /// A partly filled offer cannot be taken by a direct accept, so the
    /// check refuses it with the accept preview's own reason.
    function test_accept_partlyFilledOffer_isRefusedByTheAcceptPreview() public {
        uint256 id = _standing();
        uint256 req = _request(LENT / 4, 600);
        OfferMatchFacet(address(diamond)).matchOffers(id, req);

        StandingOfferCheckFacet.Check memory c = _forAmount(id, LENT - LENT / 4, 600);
        _assertVerdict(c, StandingOfferCheckFacet.Verdict.Refused);
        assertEq(uint8(c.refusedBy), uint8(StandingOfferCheckFacet.RefusedBy.Accept));
        assertEq(c.code, uint8(OfferAcceptFacet.AcceptError.OfferPartiallyFilled));
    }

    function test_accept_cancelledOffer_isRefused() public {
        uint256 id = _standing();
        vm.warp(vm.getBlockTimestamp() + 1 days); // past the cancel cooldown
        vm.prank(lender);
        OfferCancelFacet(address(diamond)).cancelOffer(id);
        StandingOfferCheckFacet.Check memory c = _forAmount(id, LENT, 600);
        _assertVerdict(c, StandingOfferCheckFacet.Verdict.Refused);
        assertFalse(c.beatsQuote);
    }

    // ── A posted request: the match path ────────────────────────────────

    function test_match_requestCovered_checkedAndBeats() public {
        uint256 id = _standing();
        uint256 req = _request(LENT / 4, 600);
        StandingOfferCheckFacet.Check memory c = check.checkAgainstRequest(id, req, 600);
        _assertVerdict(c, StandingOfferCheckFacet.Verdict.Checked);
        assertEq(c.amount, LENT / 4, "the match lends the request's amount");
        assertEq(c.rateBps, RATE);
        assertTrue(c.beatsQuote);
    }

    /// A request larger than the offer is covered in part: the figures are
    /// reported and it never beats the quote.
    function test_match_partFill_reportsTheAmount_doesNotBeat() public {
        uint256 id = _standing();
        // A request for anything from half the offer up to twice it.
        vm.prank(borrower);
        uint256 req = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, LENT / 2, LENT * 2, RATE, 600), type(uint64).max
        );
        LibTestTiming.waitOutTermsAge(address(diamond), req);
        StandingOfferCheckFacet.Check memory c = check.checkAgainstRequest(id, req, 600);
        _assertVerdict(c, StandingOfferCheckFacet.Verdict.Checked);
        assertEq(c.amount, LENT, "the most the standing offer lends");
        assertFalse(c.beatsQuote, "part coverage never beats the quote");
    }

    function test_match_refusal_isTheMatchPreviewsOwn() public {
        ERC20Mock(mockERC20).mint(lender, LENT);
        vm.prank(lender);
        uint256 id = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, LENT, LENT, 900, 900), type(uint64).max
        );
        LibTestTiming.waitOutTermsAge(address(diamond), id);
        uint256 req = _request(LENT / 4, 600);
        StandingOfferCheckFacet.Check memory c = check.checkAgainstRequest(id, req, 950);
        _assertVerdict(c, StandingOfferCheckFacet.Verdict.Refused);
        assertEq(uint8(c.refusedBy), uint8(StandingOfferCheckFacet.RefusedBy.Match));
        LibOfferMatch.MatchResult memory r = OfferMatchFacet(address(diamond)).previewMatch(id, req, borrower, borrower);
        assertEq(c.code, uint8(r.errorCode), "the same refusal the match preview names");
        assertTrue(c.code != 0);
    }
}
