// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {LibPositionNFT} from "../src/libraries/LibPositionNFT.sol";
import {SetupTest} from "./SetupTest.t.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {AutoLifecycleFacet} from "../src/facets/AutoLifecycleFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {PartialWithdrawalFacet} from "../src/facets/PartialWithdrawalFacet.sol";
import {SwapToRepayPartialFacet} from "../src/facets/SwapToRepayPartialFacet.sol";
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {LibAutoRefinanceCheck} from "../src/libraries/LibAutoRefinanceCheck.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {OfferPreviewFacet} from "../src/facets/OfferPreviewFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {RefinancePayoffPermitHelper} from "./helpers/RefinancePayoffPermitHelper.sol";
import {LibTestTiming} from "./helpers/LibTestTiming.sol";

/**
 * @title RefinanceRequestGuardTest
 * @notice #2407 — a loan's standing refinance request is indexed on chain, one
 *         per loan, and the borrower actions that would change the loan
 *         underneath it are refused while it STANDS. A request stops standing
 *         — with no write anywhere — when it is cancelled, accepted, expires,
 *         the loan closes, or its creator no longer holds the borrower
 *         position. Whether it could be filled right now is not part of that
 *         rule; `checkRefinanceRequest` reports it.
 */
contract RefinanceRequestGuardTest is SetupTest {
    uint256 internal constant LOAN_PRINCIPAL = 100 ether;
    uint256 internal constant LOAN_COLLATERAL = 1800 ether;

    function setUp() public {
        setupHelper();
        AdminFacet(address(diamond)).setAutoRefinanceEnabled(true);
    }

    // ─── fixtures (the T-092 integration test's shapes) ──────────────

    function _activeLoan() internal returns (uint256 loanId) {
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOraclePrice(mockERC20, 1e8, 8);
        mockOracleLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOraclePrice(mockCollateralERC20, 1e8, 8);
        address lenderVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
        address borrowerVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        vm.prank(lender);
        ERC20(mockERC20).approve(lenderVault, type(uint256).max);
        vm.prank(borrower);
        ERC20(mockCollateralERC20).approve(borrowerVault, type(uint256).max);
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, 500, LibVaipakam.FillMode.Partial, 0, 0),
            type(uint64).max
        );
        loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
    }

    function _params(
        LibVaipakam.OfferType offerType,
        uint256 rateBps,
        LibVaipakam.FillMode fillMode,
        uint256 targetLoanId,
        uint64 expiresAt
    ) internal view returns (LibVaipakam.CreateOfferParams memory) {
        return LibVaipakam.CreateOfferParams({
            offerType: offerType,
            lendingAsset: mockERC20,
            amount: LOAN_PRINCIPAL,
            interestRateBps: rateBps,
            collateralAsset: mockCollateralERC20,
            collateralAmount: LOAN_COLLATERAL,
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
            amountMax: LOAN_PRINCIPAL,
            interestRateBpsMax: rateBps,
            collateralAmountMax: LOAN_COLLATERAL,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: expiresAt,
            fillMode: fillMode,
            refinanceTargetLoanId: targetLoanId,
            useFullTermInterest: false
        });
    }

    /// A refinance request for `loanId`, posted by the borrower.
    function _request(uint256 loanId, uint64 expiresAt) internal returns (uint256 offerId) {
        vm.prank(borrower);
        AutoLifecycleFacet(address(diamond)).setAutoRefinanceCaps(
            loanId, true, 600, uint64(block.timestamp + 365 days)
        );
        vm.prank(borrower);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, 400, LibVaipakam.FillMode.Aon, loanId, expiresAt),
            type(uint64).max
        );
        LibTestTiming.waitOutTermsAge(address(diamond), offerId); // #3443
    }

    /// The standing request for `loanId` (`getRefinanceRequest`'s `live`), or 0.
    function _live(uint256 loanId) internal view returns (uint256) {
        (uint256 offerId, bool live) = RefinanceFacet(address(diamond)).getRefinanceRequest(loanId);
        return live ? offerId : 0;
    }

    function _recorded(uint256 loanId) internal view returns (uint256 offerId) {
        (offerId,) = RefinanceFacet(address(diamond)).getRefinanceRequest(loanId);
    }

    /// The revert selector a borrower call produces (0 when it succeeds).
    function _selectorOf(bytes memory callData) internal returns (bytes4 sel) {
        vm.prank(borrower);
        (bool ok, bytes memory ret) = address(diamond).call(callData);
        if (ok || ret.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            sel := mload(add(ret, 0x20))
        }
    }

    function _guarded(uint256 loanId) internal view returns (bytes[] memory calls) {
        LibSwap.AdapterCall[] memory none;
        calls = new bytes[](6);
        calls[0] = abi.encodeCall(RepayFacet.repayPartial, (loanId, 1));
        calls[1] = abi.encodeCall(PrecloseFacet.precloseDirect, (loanId));
        calls[2] = abi.encodeCall(PrecloseFacet.transferObligationViaOffer, (loanId, 0, type(uint64).max));
        calls[3] = abi.encodeCall(
            PrecloseFacet.offsetWithNewOffer,
            (loanId, 500, 30, mockCollateralERC20, LOAN_COLLATERAL, true, mockERC20, type(uint64).max)
        );
        calls[4] = abi.encodeCall(PartialWithdrawalFacet.partialWithdrawCollateral, (loanId, 1));
        calls[5] = abi.encodeCall(SwapToRepayPartialFacet.swapToRepayPartial, (loanId, 1, none, type(uint64).max));
    }

    // ─── the index ───────────────────────────────────────────────────

    function test_aRequestIsIndexedAndReported() public {
        uint256 loanId = _activeLoan();
        assertEq(_live(loanId), 0);
        uint256 offerId = _request(loanId, 0);
        assertEq(_live(loanId), offerId);
    }

    function test_aSecondRequestForTheSameLoanIsRefused() public {
        uint256 loanId = _activeLoan();
        uint256 first = _request(loanId, 0);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.RefinanceRequestOpen.selector, loanId, first));
        OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, 400, LibVaipakam.FillMode.Aon, loanId, 0),
            type(uint64).max
        );
    }

    // ─── the guard ───────────────────────────────────────────────────

    /// Every guarded action is refused, by name, while the request is live.
    function test_everyGuardedActionIsRefusedWhileARequestIsLive() public {
        uint256 loanId = _activeLoan();
        uint256 offerId = _request(loanId, 0);
        bytes[] memory calls = _guarded(loanId);
        bytes memory want = abi.encodeWithSelector(IVaipakamErrors.RefinanceRequestOpen.selector, loanId, offerId);
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(borrower);
            (bool ok, bytes memory ret) = address(diamond).call(calls[i]);
            assertFalse(ok, "guarded action went through");
            assertEq(ret, want, "guarded action refused for another reason");
        }
    }

    /// Without a request, none of those actions is refused BY THE GUARD —
    /// each fails (if it fails) for its own reason. Proves the guard, not some
    /// other check, is what refused them above.
    function test_noRequestNoGuardRefusal() public {
        uint256 loanId = _activeLoan();
        bytes[] memory calls = _guarded(loanId);
        for (uint256 i; i < calls.length; ++i) {
            assertTrue(
                _selectorOf(calls[i]) != IVaipakamErrors.RefinanceRequestOpen.selector,
                "guard fired with no request"
            );
        }
    }

    // ─── a request stops being live without any write ────────────────

    function test_cancellingTheRequestLiftsTheGuardAndFreesTheSlot() public {
        uint256 loanId = _activeLoan();
        uint256 offerId = _request(loanId, 0);
        // #664 — the cancel cooldown applies to every fresh offer.
        vm.warp(block.timestamp + LibVaipakam.MIN_OFFER_CANCEL_DELAY);
        vm.prank(borrower);
        OfferCancelFacet(address(diamond)).cancelOffer(offerId);
        assertEq(_live(loanId), 0);
        assertEq(_recorded(loanId), offerId, "a lapsed record is still reported");
        assertTrue(
            _selectorOf(abi.encodeCall(RepayFacet.repayPartial, (loanId, 1)))
                != IVaipakamErrors.RefinanceRequestOpen.selector
        );
        // And the borrower may post a fresh request.
        uint256 next = _request(loanId, 0);
        assertEq(_live(loanId), next);
        assertEq(_recorded(loanId), next, "the new request replaces the lapsed record");
    }

    function test_anExpiredRequestStopsBlocking() public {
        uint256 loanId = _activeLoan();
        uint256 offerId = _request(loanId, uint64(block.timestamp + 1 days));
        vm.warp(block.timestamp + 1 days);
        assertEq(_live(loanId), 0);
        // Still reported, so the borrower can find it to cancel it.
        assertEq(_recorded(loanId), offerId);
        assertTrue(
            _selectorOf(abi.encodeCall(RepayFacet.repayPartial, (loanId, 1)))
                != IVaipakamErrors.RefinanceRequestOpen.selector
        );
    }

    /// A request whose creator no longer holds the borrower position cannot be
    /// accepted, so it must not block the new holder.
    function test_aPositionTransferOrphansTheRequest() public {
        uint256 loanId = _activeLoan();
        uint256 offerId = _request(loanId, 0);
        assertEq(_live(loanId), offerId, "precondition: the request is live");
        uint256 tokenId = LoanFacet(address(diamond)).getLoanDetails(loanId).borrowerTokenId;
        address newHolder = makeAddr("newHolder");
        LibTestPositionNFT.waitOutCooldown(address(diamond), tokenId);
        vm.prank(borrower);
        LibTestPositionNFT.core(address(diamond)).transferFrom(borrower, newHolder, tokenId);
        assertEq(_live(loanId), 0);
    }

    /// #3205 (#3318) — a request completes only while the borrower position
    /// has not moved since it was recorded. A round trip (away and back) ends
    /// it: it neither stands nor can be taken, and it no longer blocks the
    /// holder from recording a fresh one.
    function test_aRoundTripEndsTheRequest() public {
        uint256 loanId = _activeLoan();
        uint256 r1 = _request(loanId, 0);
        uint256 tokenId = LoanFacet(address(diamond)).getLoanDetails(loanId).borrowerTokenId;
        address away = makeAddr("roundTripHolder");
        LibTestPositionNFT.waitOutCooldown(address(diamond), tokenId);
        vm.prank(borrower);
        LibTestPositionNFT.core(address(diamond)).transferFrom(borrower, away, tokenId);
        LibTestPositionNFT.waitOutCooldown(address(diamond), tokenId);
        vm.prank(away);
        LibTestPositionNFT.core(address(diamond)).transferFrom(away, borrower, tokenId);

        assertEq(_live(loanId), 0, "a round trip does not revive the request");
        _acceptExpectingRevert(
            r1, abi.encodeWithSelector(LibPositionNFT.PositionMovedSinceRouteOpened.selector, tokenId, 0, 2)
        );
        uint256 r2 = _request(loanId, 0);
        assertEq(_live(loanId), r2, "the holder records a fresh request, which stands");
    }

    // ─── #2424 r1 — only the RECORDED request can fill ───────────────

    /// A funded replacement lender. A test that completes a refinance also
    /// attaches the borrower's payoff permit to the request (#1558).
    function _replacementLender(string memory label) internal returns (address l, uint256 pk) {
        l = _provisionFundedActorWithVault(label, mockERC20, LOAN_PRINCIPAL * 4);
        (, pk) = makeAddrAndKey(label);
    }

    function _acceptExpectingRevert(uint256 offerId, bytes memory err) internal {
        (address l, uint256 pk) = _replacementLender("refusedLender");
        LibAcceptTerms.AcceptTerms memory t =
            LibAcceptTestSigner.buildTerms(address(diamond), l, offerId, true, 0);
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, pk);
        vm.expectRevert(err);
        vm.prank(l);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
    }

    function _notRecorded(uint256 loanId, uint256 offerId) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IVaipakamErrors.RefinanceRequestNotRecorded.selector, loanId, offerId);
    }

    /// Liveness is reversible (a position can return to its creator), so a
    /// request displaced from the record must not revive: A posts R1 and hands
    /// the position to B; B posts R2 (allowed — B could not cancel A's R1),
    /// cancels it and hands the position back. R1 meets every liveness
    /// condition again, but it is not the recorded request, so it cannot fill.
    function test_aDisplacedRequestCanNeverFill() public {
        uint256 loanId = _activeLoan();
        uint256 r1 = _request(loanId, 0);
        uint256 tokenId = LoanFacet(address(diamond)).getLoanDetails(loanId).borrowerTokenId;

        address holderB = makeAddr("holderB");
        LibTestPositionNFT.waitOutCooldown(address(diamond), tokenId);
        vm.prank(borrower);
        LibTestPositionNFT.core(address(diamond)).transferFrom(borrower, holderB, tokenId);
        address vaultB = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(holderB);
        ERC20Mock(mockCollateralERC20).mint(holderB, LOAN_COLLATERAL);
        vm.startPrank(holderB);
        ERC20(mockCollateralERC20).approve(vaultB, type(uint256).max);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        AutoLifecycleFacet(address(diamond)).setAutoRefinanceCaps(
            loanId, true, 600, uint64(block.timestamp + 365 days)
        );
        uint256 r2 = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, 400, LibVaipakam.FillMode.Aon, loanId, 0),
            type(uint64).max
        );
        assertEq(_recorded(loanId), r2, "a former holder's request is displaced");
        // #664 — the cancel cooldown applies to every fresh offer.
        vm.warp(block.timestamp + LibVaipakam.MIN_OFFER_CANCEL_DELAY);
        OfferCancelFacet(address(diamond)).cancelOffer(r2);
        LibTestPositionNFT.waitOutCooldown(address(diamond), tokenId);
        LibTestPositionNFT.core(address(diamond)).transferFrom(holderB, borrower, tokenId);
        vm.stopPrank();
        vm.prank(borrower);
        AutoLifecycleFacet(address(diamond)).setAutoRefinanceCaps(
            loanId, true, 600, uint64(block.timestamp + 365 days)
        );

        assertEq(_live(loanId), 0, "the guard watches the record, which holds the cancelled R2");
        _acceptExpectingRevert(r1, _notRecorded(loanId, r1));
        // #3336 — a displaced request is dead to the Diamond's read even with
        // the position back with its creator: it is no longer the record.
        assertTrue(OfferCancelFacet(address(diamond)).isOfferRouteDead(r1), "a displaced request reads dead");
    }

    /// A request posted before the record existed is never recorded, so it can
    /// never be taken — and it does not hold the loan back. Its borrower
    /// cancels it and posts a new one, which is recorded and takeable.
    function test_aPreIndexRequestCanNeverBeTaken() public {
        uint256 loanId = _activeLoan();
        uint256 r1 = _request(loanId, 0);
        vm.store(address(diamond), _indexSlotOf(loanId, r1), bytes32(0));

        _acceptExpectingRevert(r1, _notRecorded(loanId, r1));
        assertEq(_live(loanId), 0, "an unrecorded request does not hold the loan back");

        vm.prank(borrower);
        uint256 r2 = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, 400, LibVaipakam.FillMode.Aon, loanId, 0),
            type(uint64).max
        );
        assertEq(_live(loanId), r2);
        _acceptExpectingRevert(r1, _notRecorded(loanId, r1));
    }

    // ─── #2424 r1 — no request is dropped from view uncancelled ──────

    /// An expired request the holder never cancelled may still hold a fresh
    /// pledge, and the record is how it is found from the loan — so a new
    /// request is refused until the holder cancels it.
    function test_anExpiredRequestMustBeCancelledBeforeANewOne() public {
        uint256 loanId = _activeLoan();
        uint256 r1 = _request(loanId, uint64(block.timestamp + 1 days));
        vm.warp(block.timestamp + 1 days);

        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.RefinanceRequestNotCancelled.selector, loanId, r1)
        );
        OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, 400, LibVaipakam.FillMode.Aon, loanId, 0),
            type(uint64).max
        );

        vm.prank(borrower);
        OfferCancelFacet(address(diamond)).cancelOffer(r1);
        uint256 r2 = _request(loanId, 0);
        assertEq(_live(loanId), r2);
    }

    // ─── #2424 r2 ─────────────────────────────────────────────────────

    /// An offset closes the loan when it completes, so a request is not posted
    /// while one is live — the order the offset guard cannot see.
    function test_aRequestIsRefusedWhileAnOffsetIsLive() public {
        uint256 loanId = _activeLoan();
        address borrowerVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        vm.startPrank(borrower);
        ERC20(mockERC20).approve(borrowerVault, type(uint256).max);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        uint256 offsetOfferId = PrecloseFacet(address(diamond)).offsetWithNewOffer(
            loanId, 500, 30, mockCollateralERC20, LOAN_COLLATERAL, true, mockERC20,
            type(uint64).max
        );
        AutoLifecycleFacet(address(diamond)).setAutoRefinanceCaps(
            loanId, true, 600, uint64(block.timestamp + 365 days)
        );
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.RefinanceBlockedByOffset.selector, loanId, offsetOfferId)
        );
        OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, 400, LibVaipakam.FillMode.Aon, loanId, 0),
            type(uint64).max
        );
        // Once the offset is withdrawn, the request may be posted.
        // #664 — the cancel cooldown applies to every fresh offer.
        vm.warp(block.timestamp + LibVaipakam.MIN_OFFER_CANCEL_DELAY);
        OfferCancelFacet(address(diamond)).cancelOffer(offsetOfferId);
        uint256 r = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, 400, LibVaipakam.FillMode.Aon, loanId, 0),
            type(uint64).max
        );
        vm.stopPrank();
        assertEq(_live(loanId), r);
    }

    /// The accept preview reports an unrecorded request as unfillable, instead
    /// of advertising an acceptance the refinance hook would revert.
    function test_theAcceptPreviewReportsAnUnrecordedRequest() public {
        uint256 loanId = _activeLoan();
        uint256 r1 = _request(loanId, 0);
        address l = makeAddr("previewLender");
        assertTrue(
            OfferPreviewFacet(address(diamond)).previewAccept(r1, l).errorCode
                != OfferAcceptFacet.AcceptError.RefinanceRequestUntakeable,
            "the recorded request is not flagged"
        );
        vm.store(address(diamond), _indexSlotOf(loanId, r1), bytes32(0));
        assertEq(
            uint8(OfferPreviewFacet(address(diamond)).previewAccept(r1, l).errorCode),
            uint8(OfferAcceptFacet.AcceptError.RefinanceRequestUntakeable)
        );
    }

    /// The match preview (the bots' and the matcher's admission check) refuses
    /// an unrecorded carry-over request too.
    function test_theMatchPreviewRefusesAnUnrecordedRequest() public {
        // Matching on: with it off, previewMatch reports the switch
        // before any offer-level verdict (#2812).
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        uint256 loanId = _activeLoan();
        uint256 r1 = _request(loanId, 0);
        vm.prank(lender);
        uint256 lenderOffer = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, 400, LibVaipakam.FillMode.Partial, 0, 0),
            type(uint64).max
        );
        assertTrue(
            OfferMatchFacet(address(diamond)).previewMatch(lenderOffer, r1, address(this), address(this)).errorCode
                != LibOfferMatch.MatchError.RefinanceTagged,
            "the recorded carry-over request is admissible"
        );
        vm.store(address(diamond), _indexSlotOf(loanId, r1), bytes32(0));
        assertEq(
            uint8(OfferMatchFacet(address(diamond)).previewMatch(lenderOffer, r1, address(this), address(this)).errorCode),
            uint8(LibOfferMatch.MatchError.RefinanceTagged)
        );
    }

    // ─── #2424 r10 — a request holds the loan while it STANDS ────────
    //
    // Whether a lender could fill it right now is deliberately not part of the
    // rule (r7/r8 tried, and each round found another prerequisite to model).
    // A standing request that can no longer fill keeps holding the loan until
    // the borrower cancels it; `checkRefinanceRequest` says why it cannot fill.

    /// Withdrawing the refinance caps leaves the request unfillable but still
    /// standing: it keeps holding the loan, the check names the reason, and
    /// cancelling it is the way out.
    function test_withdrawingTheCapsLeavesTheRequestStanding() public {
        uint256 loanId = _activeLoan();
        uint256 r1 = _request(loanId, 0);
        vm.prank(borrower);
        AutoLifecycleFacet(address(diamond)).setAutoRefinanceCaps(
            loanId, false, 600, uint64(block.timestamp + 365 days)
        );
        assertEq(_live(loanId), r1, "an unfillable request still stands");
        assertEq(
            _selectorOf(abi.encodeCall(RepayFacet.repayPartial, (loanId, 1))),
            IVaipakamErrors.RefinanceRequestOpen.selector,
            "and still holds the loan"
        );
        vm.expectRevert(LibAutoRefinanceCheck.RefinanceCapsRequired.selector);
        RefinanceFacet(address(diamond)).checkRefinanceRequest(loanId, r1);

        // #664 — the cancel cooldown applies to every fresh offer.
        vm.warp(block.timestamp + LibVaipakam.MIN_OFFER_CANCEL_DELAY);
        vm.prank(borrower);
        OfferCancelFacet(address(diamond)).cancelOffer(r1);
        assertEq(_live(loanId), 0, "cancelling lifts it");
        assertTrue(
            _selectorOf(abi.encodeCall(RepayFacet.repayPartial, (loanId, 1)))
                != IVaipakamErrors.RefinanceRequestOpen.selector,
            "the guard lifted"
        );
    }

    /// Tightening the rate cap below the request's rate does the same.
    function test_tighteningTheRateCapLeavesTheRequestStanding() public {
        uint256 loanId = _activeLoan();
        uint256 r1 = _request(loanId, 0); // rate 400
        vm.prank(borrower);
        AutoLifecycleFacet(address(diamond)).setAutoRefinanceCaps(
            loanId, true, 300, uint64(block.timestamp + 365 days)
        );
        assertEq(_live(loanId), r1);
        vm.expectRevert(LibAutoRefinanceCheck.RefinanceRateExceedsCap.selector);
        RefinanceFacet(address(diamond)).checkRefinanceRequest(loanId, r1);
    }

    /// The public check gives the reason a request could not be accepted now.
    function test_checkRefinanceRequestGivesTheReason() public {
        uint256 loanId = _activeLoan();
        uint256 r1 = _request(loanId, 0);
        RefinanceFacet(address(diamond)).checkRefinanceRequest(loanId, r1); // passes

        vm.prank(borrower);
        AutoLifecycleFacet(address(diamond)).setAutoRefinanceCaps(
            loanId, false, 600, uint64(block.timestamp + 365 days)
        );
        vm.expectRevert(LibAutoRefinanceCheck.RefinanceCapsRequired.selector);
        RefinanceFacet(address(diamond)).checkRefinanceRequest(loanId, r1);

        // #664 — the cancel cooldown applies to every fresh offer.
        vm.warp(block.timestamp + LibVaipakam.MIN_OFFER_CANCEL_DELAY);
        vm.prank(borrower);
        OfferCancelFacet(address(diamond)).cancelOffer(r1);
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.RefinanceRequestNotLive.selector, loanId, r1)
        );
        RefinanceFacet(address(diamond)).checkRefinanceRequest(loanId, r1);
    }

    /// A carry-over request must match the loan's collateral exactly, so a
    /// top-up (which stays allowed) leaves it unfillable — still standing, and
    /// the check says so.
    function test_aCollateralTopUpLeavesACarryOverRequestStandingButUnfillable() public {
        uint256 loanId = _activeLoan();
        uint256 r1 = _request(loanId, 0);
        vm.prank(borrower);
        AddCollateralFacet(address(diamond)).addCollateral(loanId, 1 ether);
        assertEq(_live(loanId), r1, "still stands");
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.RefinanceRequestNotLive.selector, loanId, r1)
        );
        RefinanceFacet(address(diamond)).checkRefinanceRequest(loanId, r1);
    }

    /// A handed-away request lets the new holder open an offset. Since #3205
    /// an open offset no longer locks the position: it may come back to the
    /// request's creator, which only kills the offset (its completion needs
    /// the transfer count unchanged). The request still cannot be taken while
    /// the offset is open, whoever holds the position.
    function test_aRequestCannotStandOrBeTakenBesideAnOffset() public {
        uint256 loanId = _activeLoan();
        uint256 r1 = _request(loanId, 0);
        uint256 tokenId = LoanFacet(address(diamond)).getLoanDetails(loanId).borrowerTokenId;

        address holderB = makeAddr("offsetHolder");
        LibTestPositionNFT.waitOutCooldown(address(diamond), tokenId);
        vm.prank(borrower);
        LibTestPositionNFT.core(address(diamond)).transferFrom(borrower, holderB, tokenId);
        address vaultB = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(holderB);
        ERC20Mock(mockERC20).mint(holderB, LOAN_PRINCIPAL * 4);
        vm.startPrank(holderB);
        ERC20(mockERC20).approve(vaultB, type(uint256).max);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        // 29 days: the position waited out its cooldown, so a 30-day offset would outlast the loan.
        uint256 offsetOfferId = PrecloseFacet(address(diamond)).offsetWithNewOffer(
            loanId, 500, 29, mockCollateralERC20, LOAN_COLLATERAL, true, mockERC20,
            type(uint64).max
        );
        assertGt(offsetOfferId, 0, "precondition: the offset is open");
        LibTestPositionNFT.waitOutCooldown(address(diamond), tokenId);
        LibTestPositionNFT.core(address(diamond)).transferFrom(holderB, borrower, tokenId);
        vm.stopPrank();
        assertEq(LibTestPositionNFT.core(address(diamond)).ownerOf(tokenId), borrower, "the position came back");

        assertTrue(
            OfferPreviewFacet(address(diamond)).previewAccept(r1, makeAddr("previewLender")).errorCode
                != OfferAcceptFacet.AcceptError.None,
            "previewed as unable to complete"
        );
        // The creator holds the position again, but it moved (away and back)
        // since R1 was recorded, so R1 is dead (#3205): the moved check, which
        // every completion runs first, refuses it.
        _acceptExpectingRevert(
            r1, abi.encodeWithSelector(LibPositionNFT.PositionMovedSinceRouteOpened.selector, tokenId, 0, 2)
        );
    }

    /// #3318 (Raaj 08:22) — a dead offset (its borrower position moved) can be
    /// cancelled by anyone, and the refund holds ONLY the creator's own
    /// offset principal. The loan's collateral stays under the loan's lien.
    function test_deadOffset_thirdPartyCancel_refundsOnlyTheCreatorsPrincipal() public {
        uint256 loanId = _activeLoan();
        uint256 tokenId = LoanFacet(address(diamond)).getLoanDetails(loanId).borrowerTokenId;
        address creator = makeAddr("offsetCreator");
        LibTestPositionNFT.waitOutCooldown(address(diamond), tokenId);
        vm.prank(borrower);
        LibTestPositionNFT.core(address(diamond)).transferFrom(borrower, creator, tokenId);
        address creatorVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(creator);
        ERC20Mock(mockERC20).mint(creator, LOAN_PRINCIPAL * 4);
        vm.startPrank(creator);
        ERC20(mockERC20).approve(creatorVault, type(uint256).max);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        // 29 days: the position waited out its cooldown, so a 30-day offset would outlast the loan.
        uint256 offsetOfferId = PrecloseFacet(address(diamond)).offsetWithNewOffer(
            loanId, 500, 29, mockCollateralERC20, LOAN_COLLATERAL, true, mockERC20,
            type(uint64).max
        );
        vm.stopPrank();
        uint256 deposited = OfferCancelFacet(address(diamond)).getOffer(offsetOfferId).amountMax;
        if (deposited == 0) deposited = OfferCancelFacet(address(diamond)).getOffer(offsetOfferId).amount;

        // The position moves on: the offset is dead.
        address nextHolder = makeAddr("nextBorrowerHolder");
        LibTestPositionNFT.waitOutCooldown(address(diamond), tokenId);
        vm.prank(creator);
        LibTestPositionNFT.core(address(diamond)).transferFrom(creator, nextHolder, tokenId);

        address loanVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(
            LoanFacet(address(diamond)).getLoanDetails(loanId).borrower
        );
        uint256 collateralHeld = ERC20(mockCollateralERC20).balanceOf(loanVault);
        LibVaipakam.Encumbrance memory lienBefore = MetricsFacet(address(diamond)).getLoanCollateralLien(loanId);
        uint256 creatorWallet = ERC20(mockERC20).balanceOf(creator);
        uint256 creatorCollateral = ERC20(mockCollateralERC20).balanceOf(creator);

        vm.warp(block.timestamp + LibVaipakam.MIN_OFFER_CANCEL_DELAY + 1); // past the cancel cooldown
        vm.prank(makeAddr("offsetCleaner"));
        OfferCancelFacet(address(diamond)).cancelOffer(offsetOfferId);

        assertEq(ERC20(mockERC20).balanceOf(creator), creatorWallet + deposited, "the creator gets back exactly the offset principal");
        assertEq(ERC20(mockCollateralERC20).balanceOf(creator), creatorCollateral, "no collateral reaches the creator");
        assertEq(ERC20(mockCollateralERC20).balanceOf(loanVault), collateralHeld, "the loan's collateral stays put");
        LibVaipakam.Encumbrance memory lienAfter = MetricsFacet(address(diamond)).getLoanCollateralLien(loanId);
        assertEq(lienAfter.amount, lienBefore.amount, "the loan's lien is intact");
        assertFalse(lienAfter.released, "the loan's lien is still live");
        assertEq(LibTestPositionNFT.core(address(diamond)).ownerOf(tokenId), nextHolder, "the current holder keeps the position");
    }

    /// #3336 — a refinance request whose borrower position has moved can never
    /// be taken, so anyone may cancel it, with no expiry to wait for. Before
    /// the move only its creator may. The cleaner receives nothing, and the
    /// loan's collateral and lien are untouched.
    function test_movedRequest_thirdPartyCancel_leavesTheLoanWhole() public {
        uint256 loanId = _activeLoan();
        uint256 offerId = _request(loanId, 0);
        uint256 tokenId = LoanFacet(address(diamond)).getLoanDetails(loanId).borrowerTokenId;
        address cleaner = makeAddr("requestCleaner");
        vm.warp(block.timestamp + LibVaipakam.MIN_OFFER_CANCEL_DELAY + 1); // past the cancel cooldown

        vm.prank(cleaner);
        vm.expectPartialRevert(OfferCancelFacet.NotCreatorOrNotExpired.selector);
        OfferCancelFacet(address(diamond)).cancelOffer(offerId);
        assertFalse(OfferCancelFacet(address(diamond)).isOfferRouteDead(offerId), "the request is live before the move");

        address newHolder = makeAddr("requestNewHolder");
        LibTestPositionNFT.waitOutCooldown(address(diamond), tokenId);
        vm.prank(borrower);
        LibTestPositionNFT.core(address(diamond)).transferFrom(borrower, newHolder, tokenId);
        // #3336 — the Diamond's dead-vehicle read now names it, the rule the
        // cancel below applies.
        assertTrue(OfferCancelFacet(address(diamond)).isOfferRouteDead(offerId), "the request is dead once the position moved");

        address loanVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(
            LoanFacet(address(diamond)).getLoanDetails(loanId).borrower
        );
        uint256 collateralHeld = ERC20(mockCollateralERC20).balanceOf(loanVault);
        LibVaipakam.Encumbrance memory lienBefore = MetricsFacet(address(diamond)).getLoanCollateralLien(loanId);

        vm.prank(cleaner);
        OfferCancelFacet(address(diamond)).cancelOffer(offerId);

        assertEq(OfferCancelFacet(address(diamond)).getOffer(offerId).creator, address(0), "the request is gone");
        assertEq(ERC20(mockCollateralERC20).balanceOf(cleaner), 0, "the cleaner receives nothing");
        assertEq(ERC20(mockERC20).balanceOf(cleaner), 0, "the cleaner receives nothing");
        LibVaipakam.Encumbrance memory lienAfter = MetricsFacet(address(diamond)).getLoanCollateralLien(loanId);
        assertEq(lienAfter.amount, lienBefore.amount, "the loan's lien is intact");
        assertFalse(lienAfter.released, "the loan's lien is still live");
        assertLe(ERC20(mockCollateralERC20).balanceOf(loanVault), collateralHeld, "nothing is added to the loan's vault");
        assertGe(
            ERC20(mockCollateralERC20).balanceOf(loanVault), lienAfter.amount, "the loan's collateral is still there"
        );
        assertEq(LibTestPositionNFT.core(address(diamond)).ownerOf(tokenId), newHolder, "the new holder keeps the position");
    }

    /// #3336 — the cancel cooldown guards a race with an accept; a moved request
    /// can never be accepted, so a third party may clear it inside the cooldown.
    function test_movedRequest_thirdPartyCancel_insideTheCooldown() public {
        uint256 loanId = _activeLoan();
        uint256 offerId = _request(loanId, 0);
        uint256 tokenId = LoanFacet(address(diamond)).getLoanDetails(loanId).borrowerTokenId;
        address newHolder = makeAddr("cooldownNewHolder");
        LibTestPositionNFT.waitOutCooldown(address(diamond), tokenId);
        vm.prank(borrower);
        LibTestPositionNFT.core(address(diamond)).transferFrom(borrower, newHolder, tokenId);

        vm.prank(makeAddr("cooldownCleaner"));
        OfferCancelFacet(address(diamond)).cancelOffer(offerId);
        assertEq(OfferCancelFacet(address(diamond)).getOffer(offerId).creator, address(0), "the request is gone");
    }

    /// The storage slot holding `loanId`'s indexed request, found by observing
    /// which slot the view reads that holds `offerId` (the Storage struct is
    /// too large to compute its field offset by hand).
    function _indexSlotOf(uint256 loanId, uint256 offerId) internal returns (bytes32) {
        vm.record();
        _live(loanId);
        (bytes32[] memory reads,) = vm.accesses(address(diamond));
        for (uint256 i; i < reads.length; ++i) {
            if (uint256(vm.load(address(diamond), reads[i])) != offerId) continue;
            bytes32 prior = vm.load(address(diamond), reads[i]);
            vm.store(address(diamond), reads[i], bytes32(0));
            bool isIt = _live(loanId) == 0;
            vm.store(address(diamond), reads[i], prior);
            if (isIt) return reads[i];
        }
        revert("index slot not found");
    }
}
