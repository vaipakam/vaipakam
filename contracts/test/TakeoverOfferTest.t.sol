// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferPreviewFacet} from "../src/facets/OfferPreviewFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {LibTestTiming} from "./helpers/LibTestTiming.sol";

/// @title TakeoverOfferTest — #3844
/// @notice An obligation handover consumes only a borrower offer posted to
///         take over that very loan (`OfferCreateFacet.createTakeoverOffer`).
///         An ordinary borrow request, or one posted for another loan, is
///         refused; and an offer that names a loan never opens a new loan
///         through accept or match. Real flows on the shared setup, no vault
///         mocks.
contract TakeoverOfferTest is SetupTest {
    event TakeoverOfferPosted(uint256 indexed loanId, uint256 indexed offerId, address indexed creator);

    uint256 internal constant PRINCIPAL = 10_000 ether;

    function setUp() public {
        setupHelper();
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function _params(LibVaipakam.OfferType kind, uint256 durationDays)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            integrator: address(0),
            lifecycleFlex: 0,
            offerType: kind,
            lendingAsset: mockERC20,
            amount: PRINCIPAL,
            interestRateBps: 500,
            collateralAsset: mockCollateralERC20,
            collateralAmount: PRINCIPAL * 2,
            durationDays: durationDays,
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
            interestRateBpsMax: 500,
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

    function _lenderOffer(uint256 durationDays) internal returns (uint256 offerId) {
        ERC20Mock(mockERC20).mint(lender, PRINCIPAL);
        vm.prank(lender);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, durationDays), type(uint64).max
        );
        LibTestTiming.waitOutTermsAge(address(diamond), offerId);
    }

    /// @dev An open loan: `lender` lends to `borrower`.
    function _openLoan() internal returns (uint256) {
        return LibAcceptTestSigner.signAndAcceptVia(
            address(diamond), borrower, borrowerPk, _lenderOffer(30), address(0)
        );
    }

    function _fund(address who) internal {
        ERC20Mock(mockCollateralERC20).mint(who, PRINCIPAL * 2);
        vm.prank(who);
        IERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
    }

    function _ordinaryRequest(address who) internal returns (uint256 offerId) {
        _fund(who);
        vm.prank(who);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, 30), type(uint64).max
        );
        LibTestTiming.backdateTerms(address(diamond), offerId);
    }

    function _takeoverOffer(address who, uint256 loanId) internal returns (uint256 offerId) {
        _fund(who);
        vm.prank(who);
        offerId = OfferCreateFacet(address(diamond)).createTakeoverOffer(
            loanId, _params(LibVaipakam.OfferType.Borrower, 30), type(uint64).max
        );
        LibTestTiming.backdateTerms(address(diamond), offerId);
    }

    function _armLeavingBorrower() internal {
        ERC20Mock(mockERC20).mint(borrower, PRINCIPAL);
        vm.prank(borrower);
        IERC20(mockERC20).approve(address(diamond), type(uint256).max);
    }

    function _principalHeld(address who) internal view returns (uint256) {
        address vault = VaultFactoryFacet(address(diamond)).getUserVaultAddress(who);
        return IERC20(mockERC20).balanceOf(who) + (vault == address(0) ? 0 : IERC20(mockERC20).balanceOf(vault));
    }

    // ── The handover consumes only an offer naming its loan ──────────────

    /// An ordinary borrow request is never consumed by a handover: the loan,
    /// the request and its creator's collateral stay exactly as they were.
    function test_handover_refusesAnOrdinaryRequest() public {
        uint256 loanId = _openLoan();
        address other = makeAddr("otherBorrower");
        uint256 offerId = _ordinaryRequest(other);
        _armLeavingBorrower();

        uint256 encBefore = MetricsFacet(address(diamond)).getEncumbered(other, mockCollateralERC20, 0);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.TakeoverOfferNotForLoan.selector, loanId, offerId));
        PrecloseFacet(address(diamond)).transferObligationViaOffer(loanId, offerId, type(uint64).max);

        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanId).borrower, borrower, "debt not moved");
        assertEq(
            MetricsFacet(address(diamond)).getEncumbered(other, mockCollateralERC20, 0), encBefore, "collateral untouched"
        );
        assertEq(OfferCreateFacet(address(diamond)).getTakeoverOfferLoan(offerId), 0, "ordinary request");
    }

    /// An offer posted to take over one loan cannot be used for another.
    function test_handover_refusesAnOfferNamingAnotherLoan() public {
        uint256 loanA = _openLoan();
        uint256 loanB = _openLoan();
        uint256 offerId = _takeoverOffer(makeAddr("incoming"), loanA);
        _armLeavingBorrower();

        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.TakeoverOfferNotForLoan.selector, loanB, offerId));
        PrecloseFacet(address(diamond)).transferObligationViaOffer(loanB, offerId, type(uint64).max);
    }

    /// The agreed route: the incoming borrower posts an offer naming the loan,
    /// and the handover moves the debt onto them. They receive no principal,
    /// which is what their offer stated.
    function test_handover_consumesAnOfferNamingTheLoan() public {
        uint256 loanId = _openLoan();
        address incoming = makeAddr("incoming");

        _fund(incoming);
        vm.prank(incoming);
        uint256 offerId = OfferCreateFacet(address(diamond)).createTakeoverOffer(
            loanId, _params(LibVaipakam.OfferType.Borrower, 30), type(uint64).max
        );
        LibTestTiming.backdateTerms(address(diamond), offerId);
        assertEq(OfferCreateFacet(address(diamond)).getTakeoverOfferLoan(offerId), loanId, "record names the loan");

        uint256 principalBefore = _principalHeld(incoming);
        _armLeavingBorrower();
        vm.prank(borrower);
        PrecloseFacet(address(diamond)).transferObligationViaOffer(loanId, offerId, type(uint64).max);

        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanId).borrower, incoming, "debt moved");
        assertEq(_principalHeld(incoming), principalBefore, "no principal to the incoming borrower");
    }

    function test_post_emitsTheRecord() public {
        uint256 loanId = _openLoan();
        address incoming = makeAddr("incoming");
        _fund(incoming);
        vm.recordLogs();
        vm.prank(incoming);
        uint256 offerId = OfferCreateFacet(address(diamond)).createTakeoverOffer(
            loanId, _params(LibVaipakam.OfferType.Borrower, 30), type(uint64).max
        );
        bytes32 topic = TakeoverOfferPosted.selector;
        bool seen;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 4 && logs[i].topics[0] == topic) {
                assertEq(uint256(logs[i].topics[1]), loanId);
                assertEq(uint256(logs[i].topics[2]), offerId);
                assertEq(address(uint160(uint256(logs[i].topics[3]))), incoming);
                seen = true;
            }
        }
        assertTrue(seen, "TakeoverOfferPosted emitted");
    }

    // ── A takeover offer never opens a new loan ──────────────────────────

    function test_accept_refusesATakeoverOffer() public {
        uint256 loanId = _openLoan();
        uint256 offerId = _takeoverOffer(makeAddr("incoming"), loanId);

        OfferAcceptFacet.AcceptPreview memory p =
            OfferPreviewFacet(address(diamond)).previewAccept(offerId, lender);
        assertEq(uint8(p.errorCode), uint8(OfferAcceptFacet.AcceptError.TakeoverOffer), "preview names it");

        ERC20Mock(mockERC20).mint(lender, PRINCIPAL);
        vm.prank(lender);
        IERC20(mockERC20).approve(address(diamond), type(uint256).max);
        LibAcceptTerms.AcceptTerms memory t =
            LibAcceptTestSigner.buildTerms(address(diamond), lender, offerId, true, 0);
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, lenderPk);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.TakeoverOfferNotFillable.selector, offerId));
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
    }

    function test_match_refusesATakeoverOffer() public {
        uint256 loanId = _openLoan();
        uint256 borrowerOfferId = _takeoverOffer(makeAddr("incoming"), loanId);
        uint256 lenderOfferId = _lenderOffer(30);
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);

        LibOfferMatch.MatchResult memory r = OfferMatchFacet(address(diamond)).previewMatch(
            lenderOfferId, borrowerOfferId, address(this), address(this)
        );
        assertEq(uint8(r.errorCode), uint8(LibOfferMatch.MatchError.TakeoverOffer), "preview names it");

        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.TakeoverOfferNotFillable.selector, borrowerOfferId));
        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId, borrowerOfferId);
    }

    // ── Posting refusals ─────────────────────────────────────────────────

    function test_post_refusesALenderOffer() public {
        uint256 loanId = _openLoan();
        ERC20Mock(mockERC20).mint(lender, PRINCIPAL);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(OfferCreateFacet.InvalidTakeoverOffer.selector, loanId));
        OfferCreateFacet(address(diamond)).createTakeoverOffer(
            loanId, _params(LibVaipakam.OfferType.Lender, 30), type(uint64).max
        );
    }

    function test_post_refusesARefinanceTagOrParallelSale() public {
        uint256 loanId = _openLoan();
        address incoming = makeAddr("incoming");
        _fund(incoming);
        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Borrower, 30);
        p.refinanceTargetLoanId = loanId;
        vm.prank(incoming);
        vm.expectRevert(abi.encodeWithSelector(OfferCreateFacet.InvalidTakeoverOffer.selector, loanId));
        OfferCreateFacet(address(diamond)).createTakeoverOffer(loanId, p, type(uint64).max);

        p = _params(LibVaipakam.OfferType.Borrower, 30);
        p.allowsParallelSale = true;
        vm.prank(incoming);
        vm.expectRevert(abi.encodeWithSelector(OfferCreateFacet.InvalidTakeoverOffer.selector, loanId));
        OfferCreateFacet(address(diamond)).createTakeoverOffer(loanId, p, type(uint64).max);
    }

    function test_post_refusesALoanThatIsNotActive() public {
        address incoming = makeAddr("incoming");
        _fund(incoming);
        vm.prank(incoming);
        vm.expectRevert(abi.encodeWithSelector(OfferCreateFacet.InvalidTakeoverOffer.selector, uint256(999)));
        OfferCreateFacet(address(diamond)).createTakeoverOffer(
            999, _params(LibVaipakam.OfferType.Borrower, 30), type(uint64).max
        );
    }
}
