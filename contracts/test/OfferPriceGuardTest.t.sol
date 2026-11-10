// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibOfferPriceGuard} from "../src/libraries/LibOfferPriceGuard.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferPreviewFacet} from "../src/facets/OfferPreviewFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {OfferPriceGuardFacet} from "../src/facets/OfferPriceGuardFacet.sol";
import {SaleFloorFacet} from "../src/facets/SaleFloorFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {MulticallFacet} from "../src/facets/MulticallFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {LibTestPriceGuard} from "./helpers/LibTestPriceGuard.sol";
import {LibTestTiming} from "./helpers/LibTestTiming.sol";
import {EarlyWithdrawalDirectFacet} from "../src/facets/EarlyWithdrawalDirectFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/**
 * @title OfferPriceGuardTest
 * @notice #3358 — the maker's price-move guard. A guarded offer refuses a
 *         fill when the collateral/principal rate moved past the creator's
 *         limit since the guard was recorded, when the pair is not calm
 *         against the last two hourly checkpoints, or when a price or a
 *         checkpoint is missing. Off by default: an unguarded offer fills as
 *         before, with no checkpoints at all.
 */
contract OfferPriceGuardTest is SetupTest {
    uint256 internal constant PLEDGED = 5000 ether;
    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant P0 = 1_000 * 1e8; // $1,000 on both legs

    function setUp() public {
        setupHelper();
        // Start on an hour boundary so the checkpoint hours are exact.
        vm.warp(((block.timestamp / 1 hours) + 10) * 1 hours);
        mockOraclePrice(mockERC20, P0, 8);
        mockOraclePrice(mockCollateralERC20, P0, 8);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    function _params(LibVaipakam.OfferType t, uint256 amountMax, uint256 rateMax)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            offerType: t,
            lendingAsset: mockERC20,
            amount: PRINCIPAL,
            interestRateBps: 500,
            collateralAsset: mockCollateralERC20,
            collateralAmount: PLEDGED,
            durationDays: 90,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: mockERC20,
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: true,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: amountMax,
            interestRateBpsMax: rateMax,
            collateralAmountMax: PLEDGED,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
    }

    function _lenderOffer() internal returns (uint256 offerId) {
        vm.prank(lender);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, PRINCIPAL, 500)
        );
        LibTestTiming.waitOutTermsAge(address(diamond), offerId);
    }

    function _guard(uint256 offerId, uint16 bps) internal {
        vm.prank(lender);
        OfferPriceGuardFacet(address(diamond)).setOfferPriceGuard(offerId, bps);
    }

    function _view(uint256 offerId) internal view returns (OfferPriceGuardFacet.OfferPriceGuardView memory) {
        return OfferPriceGuardFacet(address(diamond)).getOfferPriceGuard(offerId);
    }

    function _assets() internal view returns (address[] memory a) {
        a = new address[](2);
        a[0] = mockCollateralERC20;
        a[1] = mockERC20;
    }

    /// @dev Checkpoint both legs at the current prices in each of the two
    ///      hours before the one this leaves the clock in.
    function _twoCheckpoints() internal {
        SaleFloorFacet(address(diamond)).checkpointHourlyPrices(_assets());
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        SaleFloorFacet(address(diamond)).checkpointHourlyPrices(_assets());
        vm.warp(vm.getBlockTimestamp() + 1 hours);
    }

    /// @dev Expect `acceptOffer` of `offerId` by the borrower to revert with
    ///      `err`. The terms are built and signed first, so their view calls
    ///      do not consume the expectation.
    function _expectAcceptRevert(uint256 offerId, bytes memory err) internal {
        LibAcceptTerms.AcceptTerms memory t =
            LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, true, 0);
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, borrowerPk);
        vm.expectRevert(err);
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
    }

    function _previewCode(uint256 offerId) internal view returns (OfferAcceptFacet.AcceptError) {
        return OfferPreviewFacet(address(diamond)).previewAccept(offerId, borrower).errorCode;
    }

    // ─── Off by default ───────────────────────────────────────────────────

    function test_Unguarded_FillsWithNoCheckpoints() public {
        uint256 offerId = _lenderOffer();
        assertEq(uint8(_view(offerId).status), uint8(LibOfferPriceGuard.Status.Off));
        assertEq(uint8(_previewCode(offerId)), uint8(OfferAcceptFacet.AcceptError.None));
        assertGt(_signAndAcceptOffer(borrower, borrowerPk, offerId), 0);
    }

    // ─── Setting it ───────────────────────────────────────────────────────

    function test_Set_RecordsThePricesNow_AndEmits() public {
        uint256 offerId = _lenderOffer();
        vm.expectEmit(true, true, false, true, address(diamond));
        emit LibOfferPriceGuard.OfferPriceGuardSet(offerId, lender, 500, 1_000e18, 1_000e18);
        _guard(offerId, 500);
        OfferPriceGuardFacet.OfferPriceGuardView memory v = _view(offerId);
        assertEq(v.maxMoveBps, 500);
        assertEq(v.setAt, block.timestamp);
        assertEq(v.refCollateralPrice1e18, 1_000e18);
        assertEq(v.refPrincipalPrice1e18, 1_000e18);
        assertEq(v.calmMoveBps, 200, "the forced-sale calm bound");
        // No checkpoints yet: calm cannot be shown.
        assertEq(uint8(v.status), uint8(LibOfferPriceGuard.Status.NoCheckpoint));
    }

    function test_Set_OnlyTheCreator_OnAnOpenOffer_InRange() public {
        uint256 offerId = _lenderOffer();
        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.NotOfferCreator.selector);
        OfferPriceGuardFacet(address(diamond)).setOfferPriceGuard(offerId, 500);

        vm.prank(lender);
        vm.expectRevert(OfferPriceGuardFacet.InvalidOffer.selector);
        OfferPriceGuardFacet(address(diamond)).setOfferPriceGuard(offerId + 99, 500);

        uint16 lo = LibVaipakam.OFFER_PRICE_GUARD_BPS_MIN;
        uint16 hi = LibVaipakam.OFFER_PRICE_GUARD_BPS_MAX;
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector, bytes32("offerPriceGuardBps"), lo - 1, lo, hi
            )
        );
        OfferPriceGuardFacet(address(diamond)).setOfferPriceGuard(offerId, lo - 1);
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector, bytes32("offerPriceGuardBps"), hi + 1, lo, hi
            )
        );
        OfferPriceGuardFacet(address(diamond)).setOfferPriceGuard(offerId, hi + 1);

        // Accepted: no longer settable.
        _signAndAcceptOffer(borrower, borrowerPk, offerId);
        vm.prank(lender);
        vm.expectRevert();
        OfferPriceGuardFacet(address(diamond)).setOfferPriceGuard(offerId, 500);
    }

    function test_Set_RefusedWhenThePairCannotBePriced() public {
        uint256 offerId = _lenderOffer();
        vm.mockCallRevert(
            LibTestPriceGuard.guardOf(address(diamond)),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, mockCollateralERC20),
            "stale"
        );
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(LibOfferPriceGuard.OfferPriceGuardUnpriced.selector, offerId));
        OfferPriceGuardFacet(address(diamond)).setOfferPriceGuard(offerId, 500);
    }

    function test_Clear_ReturnsTheOfferToUnguarded() public {
        uint256 offerId = _lenderOffer();
        _guard(offerId, 500);
        vm.expectEmit(true, true, false, true, address(diamond));
        emit LibOfferPriceGuard.OfferPriceGuardSet(offerId, lender, 0, 0, 0);
        _guard(offerId, 0);
        assertEq(uint8(_view(offerId).status), uint8(LibOfferPriceGuard.Status.Off));
        // No checkpoints, yet it fills: the guard is gone.
        assertGt(_signAndAcceptOffer(borrower, borrowerPk, offerId), 0);
    }

    // ─── The fill check ───────────────────────────────────────────────────

    function test_Guarded_CalmAndInsideTheLimit_Fills() public {
        uint256 offerId = _lenderOffer();
        _guard(offerId, 500);
        // The rate moves exactly 5% and stays there for two hours: calm, and
        // a move equal to the limit is inside it.
        mockOraclePrice(mockCollateralERC20, 1_050 * 1e8, 8);
        _twoCheckpoints();
        OfferPriceGuardFacet.OfferPriceGuardView memory v = _view(offerId);
        assertEq(v.moveBps, 500);
        assertEq(uint8(v.status), uint8(LibOfferPriceGuard.Status.Clear));
        assertEq(uint8(_previewCode(offerId)), uint8(OfferAcceptFacet.AcceptError.None));
        assertGt(_signAndAcceptOffer(borrower, borrowerPk, offerId), 0);
    }

    function test_Guarded_MovedPastTheLimit_Refused() public {
        uint256 offerId = _lenderOffer();
        _guard(offerId, 500);
        // A fall of a little over 5% that has since settled (calm).
        mockOraclePrice(mockCollateralERC20, 949 * 1e8, 8);
        _twoCheckpoints();
        OfferPriceGuardFacet.OfferPriceGuardView memory v = _view(offerId);
        assertEq(v.moveBps, 510, "5.1%, rounded up");
        assertEq(uint8(v.status), uint8(LibOfferPriceGuard.Status.Moved));
        assertEq(uint8(_previewCode(offerId)), uint8(OfferAcceptFacet.AcceptError.PriceGuardRefused));
        _expectAcceptRevert(
            offerId, abi.encodeWithSelector(OfferPriceGuardFacet.OfferPriceMoved.selector, offerId, 510, 500)
        );
    }

    function test_Guarded_TheDirectionDoesNotMatter() public {
        uint256 offerId = _lenderOffer();
        _guard(offerId, 500);
        // The PRINCIPAL leg falls instead: the rate rises past the limit.
        mockOraclePrice(mockERC20, 900 * 1e8, 8);
        _twoCheckpoints();
        assertEq(uint8(_view(offerId).status), uint8(LibOfferPriceGuard.Status.Moved));
    }

    function test_Guarded_NotCalm_Refused() public {
        uint256 offerId = _lenderOffer();
        _guard(offerId, 2_000);
        _twoCheckpoints();
        // 3% since the checkpoints: inside the creator's 20%, but past the
        // 2% calm bound.
        mockOraclePrice(mockCollateralERC20, 1_030 * 1e8, 8);
        assertEq(uint8(_view(offerId).status), uint8(LibOfferPriceGuard.Status.NotCalm));
        assertEq(uint8(_previewCode(offerId)), uint8(OfferAcceptFacet.AcceptError.PriceGuardRefused));
        _expectAcceptRevert(offerId, abi.encodeWithSelector(OfferPriceGuardFacet.OfferPairNotCalm.selector, offerId));
    }

    function test_Guarded_NoCheckpoint_Refused() public {
        uint256 offerId = _lenderOffer();
        _guard(offerId, 500);
        // Only one hour checkpointed: the hour before that is missing.
        SaleFloorFacet(address(diamond)).checkpointHourlyPrices(_assets());
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        assertEq(uint8(_view(offerId).status), uint8(LibOfferPriceGuard.Status.NoCheckpoint));
        _expectAcceptRevert(
            offerId, abi.encodeWithSelector(OfferPriceGuardFacet.OfferPairNoCheckpoint.selector, offerId)
        );
    }

    function test_Guarded_PriceUnreadable_Refused() public {
        uint256 offerId = _lenderOffer();
        _guard(offerId, 500);
        _twoCheckpoints();
        vm.mockCallRevert(
            LibTestPriceGuard.guardOf(address(diamond)),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, mockERC20),
            "stale"
        );
        OfferPriceGuardFacet.OfferPriceGuardView memory v = _view(offerId);
        assertEq(uint8(v.status), uint8(LibOfferPriceGuard.Status.Unpriced));
        assertEq(v.moveBps, 0, "not measurable");
        // The fill check names it. (An accept itself refuses earlier here:
        // its own pricing of the loan needs the same price.)
        vm.expectRevert(abi.encodeWithSelector(OfferPriceGuardFacet.OfferPriceUnreadable.selector, offerId));
        OfferPriceGuardFacet(address(diamond)).requireOfferPriceGuardsClear(offerId, 0);
    }

    function test_View_AfterTheOfferCloses_SaysSo() public {
        uint256 offerId = _lenderOffer();
        _guard(offerId, 500);
        _twoCheckpoints();
        _signAndAcceptOffer(borrower, borrowerPk, offerId);
        LibOfferPriceGuard.Status st = _view(offerId).status;
        // A single-fill accept deletes the offer, or leaves it accepted.
        assertTrue(
            st == LibOfferPriceGuard.Status.NoOffer || st == LibOfferPriceGuard.Status.Clear,
            "closed offer reads as gone (or, still stored, as clear)"
        );
    }

    // ─── Armed before posting ─────────────────────────────────────────────

    function _armAndPost(uint16 bps, uint256 posts) internal returns (MulticallFacet.Result[] memory r) {
        MulticallFacet.Call[] memory calls = new MulticallFacet.Call[](1 + posts);
        calls[0] = MulticallFacet.Call(
            abi.encodeWithSelector(OfferPriceGuardFacet.armOfferPriceGuard.selector, bps), false
        );
        for (uint256 i = 1; i <= posts; ++i) {
            calls[i] = MulticallFacet.Call(
                abi.encodeWithSelector(
                    OfferCreateFacet.createOffer.selector, _params(LibVaipakam.OfferType.Lender, PRINCIPAL, 500)
                ),
                false
            );
        }
        vm.prank(lender);
        r = MulticallFacet(address(diamond)).multicall(calls);
    }

    function test_Armed_IsRecordedAtPosting_ForTheFirstOfferOnly() public {
        MulticallFacet.Result[] memory r = _armAndPost(700, 2);
        uint256 first = abi.decode(r[1].returnData, (uint256));
        uint256 second = abi.decode(r[2].returnData, (uint256));
        OfferPriceGuardFacet.OfferPriceGuardView memory v = _view(first);
        assertEq(v.maxMoveBps, 700);
        assertEq(v.setAt, block.timestamp, "recorded in the posting itself");
        assertEq(v.refCollateralPrice1e18, 1_000e18);
        assertEq(_view(second).maxMoveBps, 0, "an arm applies to one offer");
    }

    function test_Armed_LapsesWithTheTransaction() public {
        vm.prank(lender);
        OfferPriceGuardFacet(address(diamond)).armOfferPriceGuard(700);
        // A later transaction's post is not guarded.
        uint256 offerId = _lenderOffer();
        assertEq(_view(offerId).maxMoveBps, 0);
    }

    function test_Armed_RangeChecked() public {
        uint16 lo = LibVaipakam.OFFER_PRICE_GUARD_BPS_MIN;
        uint16 hi = LibVaipakam.OFFER_PRICE_GUARD_BPS_MAX;
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector, bytes32("offerPriceGuardBps"), 0, lo, hi
            )
        );
        OfferPriceGuardFacet(address(diamond)).armOfferPriceGuard(0);
    }

    function test_Armed_OnAnUnpricedPair_RefusesThePosting() public {
        vm.mockCallRevert(
            LibTestPriceGuard.guardOf(address(diamond)),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, mockCollateralERC20),
            "stale"
        );
        MulticallFacet.Call[] memory calls = new MulticallFacet.Call[](2);
        calls[0] = MulticallFacet.Call(
            abi.encodeWithSelector(OfferPriceGuardFacet.armOfferPriceGuard.selector, uint16(700)), false
        );
        calls[1] = MulticallFacet.Call(
            abi.encodeWithSelector(
                OfferCreateFacet.createOffer.selector, _params(LibVaipakam.OfferType.Lender, PRINCIPAL, 500)
            ),
            false
        );
        vm.prank(lender);
        vm.expectRevert();
        MulticallFacet(address(diamond)).multicall(calls);
    }

    // ─── A match checks both makers ───────────────────────────────────────

    function _matchPair() internal returns (uint256 lenderOfferId, uint256 borrowerOfferId) {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        lenderOfferId = _lenderOffer();
        vm.prank(borrower);
        borrowerOfferId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, PRINCIPAL, 500)
        );
        LibTestTiming.waitOutTermsAge(address(diamond), borrowerOfferId);
    }

    function _previewMatch(uint256 lo, uint256 bo) internal view returns (LibOfferMatch.MatchError) {
        return OfferMatchFacet(address(diamond)).previewMatch(lo, bo, address(this), address(this)).errorCode;
    }

    function test_Match_TheLenderOffersGuard_RefusesIt() public {
        (uint256 lo, uint256 bo) = _matchPair();
        assertEq(uint8(_previewMatch(lo, bo)), uint8(LibOfferMatch.MatchError.Ok), "unguarded pair matches");
        _guard(lo, 500);
        _twoCheckpoints();
        mockOraclePrice(mockCollateralERC20, 1_030 * 1e8, 8);
        assertEq(uint8(_previewMatch(lo, bo)), uint8(LibOfferMatch.MatchError.PriceGuardRefused));
        vm.expectRevert(abi.encodeWithSelector(OfferPriceGuardFacet.OfferPairNotCalm.selector, lo));
        OfferMatchFacet(address(diamond)).matchOffers(lo, bo);
    }

    function test_Match_TheBorrowerOffersGuard_RefusesIt() public {
        (uint256 lo, uint256 bo) = _matchPair();
        vm.prank(borrower);
        OfferPriceGuardFacet(address(diamond)).setOfferPriceGuard(bo, 500);
        // No checkpoints: the borrower's guard cannot be shown calm.
        assertEq(uint8(_previewMatch(lo, bo)), uint8(LibOfferMatch.MatchError.PriceGuardRefused));
        vm.expectRevert(abi.encodeWithSelector(OfferPriceGuardFacet.OfferPairNoCheckpoint.selector, bo));
        OfferMatchFacet(address(diamond)).matchOffers(lo, bo);
    }

    function test_Match_GuardedAndClear_Matches() public {
        (uint256 lo, uint256 bo) = _matchPair();
        _guard(lo, 500);
        vm.prank(borrower);
        OfferPriceGuardFacet(address(diamond)).setOfferPriceGuard(bo, 500);
        _twoCheckpoints();
        assertEq(uint8(_previewMatch(lo, bo)), uint8(LibOfferMatch.MatchError.Ok));
        assertGt(OfferMatchFacet(address(diamond)).matchOffers(lo, bo), 0);
    }
    // ─── Fills that open no loan (Codex r2) ──────────────────────────────

    /// @dev A direct loan sale fills the buyer's lender offer without opening
    ///      a loan, so it runs the guard itself: refused while the buyer's
    ///      guard cannot be shown inside, through once the guard is cleared.
    function test_DirectSale_GuardedBuyOffer_Refused() public {
        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, _lenderOffer());
        address buyer = _provisionFundedActor("guard-buyer", mockERC20, PRINCIPAL * 2);
        vm.prank(buyer);
        uint256 buyOfferId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, PRINCIPAL, 500)
        );
        LibTestTiming.waitOutTermsAge(address(diamond), buyOfferId);
        vm.prank(buyer);
        OfferPriceGuardFacet(address(diamond)).setOfferPriceGuard(buyOfferId, 500);

        vm.expectRevert(abi.encodeWithSelector(OfferPriceGuardFacet.OfferPairNoCheckpoint.selector, buyOfferId));
        vm.prank(lender);
        EarlyWithdrawalDirectFacet(address(diamond)).sellLoanViaBuyOffer(loanId, buyOfferId);

        vm.prank(buyer);
        OfferPriceGuardFacet(address(diamond)).setOfferPriceGuard(buyOfferId, 0);
        vm.prank(lender);
        EarlyWithdrawalDirectFacet(address(diamond)).sellLoanViaBuyOffer(loanId, buyOfferId);
        assertTrue(OfferCancelFacet(address(diamond)).getOffer(buyOfferId).accepted, "sold once unguarded");
    }

    /// @dev An obligation handover fills the incoming borrower's offer
    ///      without opening a loan, so it runs the guard itself too.
    function test_ObligationHandover_GuardedBorrowerOffer_Refused() public {
        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, _lenderOffer());
        address incoming = _provisionFundedActor("guard-incoming", mockCollateralERC20, PLEDGED * 2);
        vm.prank(incoming);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, PRINCIPAL, 500)
        );
        // Backdated rather than waited: a handover's incoming offer must end
        // by the loan's maturity, so the clock must not move.
        LibTestTiming.backdateTerms(address(diamond), offerId);
        vm.prank(incoming);
        OfferPriceGuardFacet(address(diamond)).setOfferPriceGuard(offerId, 500);
        ERC20Mock(mockERC20).mint(borrower, PRINCIPAL);

        vm.expectRevert(abi.encodeWithSelector(OfferPriceGuardFacet.OfferPairNoCheckpoint.selector, offerId));
        vm.prank(borrower);
        PrecloseFacet(address(diamond)).transferObligationViaOffer(loanId, offerId);

        vm.prank(incoming);
        OfferPriceGuardFacet(address(diamond)).setOfferPriceGuard(offerId, 0);
        vm.prank(borrower);
        PrecloseFacet(address(diamond)).transferObligationViaOffer(loanId, offerId);
        assertTrue(OfferCancelFacet(address(diamond)).getOffer(offerId).accepted, "handed over once unguarded");
    }
}
