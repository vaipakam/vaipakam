// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

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
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title RefinanceRequestGuardTest
 * @notice #2407 — a loan's standing refinance request is indexed on chain, one
 *         per loan, and the borrower actions that would change the loan
 *         underneath it are refused while it is live. A request stops being
 *         live — with no write anywhere — when it is cancelled, accepted,
 *         expires, or its creator no longer holds the borrower position.
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
            _params(LibVaipakam.OfferType.Lender, 500, LibVaipakam.FillMode.Partial, 0, 0)
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
            _params(LibVaipakam.OfferType.Borrower, 400, LibVaipakam.FillMode.Aon, loanId, expiresAt)
        );
    }

    /// The live request for `loanId`, or 0.
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
        calls[2] = abi.encodeCall(PrecloseFacet.transferObligationViaOffer, (loanId, 0));
        calls[3] = abi.encodeCall(
            PrecloseFacet.offsetWithNewOffer,
            (loanId, 500, 30, mockCollateralERC20, LOAN_COLLATERAL, true, mockERC20)
        );
        calls[4] = abi.encodeCall(PartialWithdrawalFacet.partialWithdrawCollateral, (loanId, 1));
        calls[5] = abi.encodeCall(SwapToRepayPartialFacet.swapToRepayPartial, (loanId, 1, none));
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
            _params(LibVaipakam.OfferType.Borrower, 400, LibVaipakam.FillMode.Aon, loanId, 0)
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
        vm.prank(borrower);
        IERC721(address(diamond)).transferFrom(borrower, newHolder, tokenId);
        assertEq(_live(loanId), 0);
    }

    // ─── the backfill for requests posted before the index ───────────

    function test_indexRecordsAPreIndexRequestAndNeverDisplacesOne() public {
        uint256 loanId = _activeLoan();
        uint256 offerId = _request(loanId, 0);
        // Recording again changes nothing: the request is already indexed.
        assertEq(RefinanceFacet(address(diamond)).indexRefinanceRequests(1, type(uint256).max), 0);

        // Simulate a request posted before the index existed: clear its slot.
        bytes32 slot = _indexSlotOf(loanId, offerId);
        vm.store(address(diamond), slot, bytes32(0));
        assertEq(_live(loanId), 0, "slot not cleared");

        // Anyone may record it; only what the chain proves is recorded.
        vm.prank(makeAddr("anyone"));
        assertEq(RefinanceFacet(address(diamond)).indexRefinanceRequests(1, type(uint256).max), 1);
        assertEq(_live(loanId), offerId);
    }

    // ─── #2424 r1 — only the RECORDED request can fill ───────────────

    /// A funded replacement lender, and the borrower's payoff approval.
    function _replacementLender(string memory label) internal returns (address l, uint256 pk) {
        l = _provisionFundedActorWithVault(label, mockERC20, LOAN_PRINCIPAL * 4);
        (, pk) = makeAddrAndKey(label);
        _grantStandingApprovalToDiamond(borrower, mockERC20);
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
        vm.prank(borrower);
        IERC721(address(diamond)).transferFrom(borrower, holderB, tokenId);
        address vaultB = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(holderB);
        ERC20Mock(mockCollateralERC20).mint(holderB, LOAN_COLLATERAL);
        vm.startPrank(holderB);
        ERC20(mockCollateralERC20).approve(vaultB, type(uint256).max);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        AutoLifecycleFacet(address(diamond)).setAutoRefinanceCaps(
            loanId, true, 600, uint64(block.timestamp + 365 days)
        );
        uint256 r2 = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, 400, LibVaipakam.FillMode.Aon, loanId, 0)
        );
        assertEq(_recorded(loanId), r2, "a former holder's request is displaced");
        OfferCancelFacet(address(diamond)).cancelOffer(r2);
        IERC721(address(diamond)).transferFrom(holderB, borrower, tokenId);
        vm.stopPrank();
        vm.prank(borrower);
        AutoLifecycleFacet(address(diamond)).setAutoRefinanceCaps(
            loanId, true, 600, uint64(block.timestamp + 365 days)
        );

        assertEq(_live(loanId), 0, "the guard watches the record, which holds the cancelled R2");
        _acceptExpectingRevert(r1, _notRecorded(loanId, r1));
    }

    /// A request posted before the record existed cannot fill until it is
    /// recorded — and once the holder has posted a new one, never.
    function test_aPreIndexRequestFillsOnlyOnceRecorded() public {
        uint256 loanId = _activeLoan();
        uint256 r1 = _request(loanId, 0);
        vm.store(address(diamond), _indexSlotOf(loanId, r1), bytes32(0));

        _acceptExpectingRevert(r1, _notRecorded(loanId, r1));

        // The holder posts a new request before the backfill reaches R1.
        vm.prank(borrower);
        uint256 r2 = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, 400, LibVaipakam.FillMode.Aon, loanId, 0)
        );
        assertEq(RefinanceFacet(address(diamond)).indexRefinanceRequests(1, type(uint256).max), 0);
        assertEq(_live(loanId), r2);
        _acceptExpectingRevert(r1, _notRecorded(loanId, r1));
    }

    /// Recorded by the backfill, a pre-index request fills normally.
    function test_aBackfilledRequestFills() public {
        uint256 loanId = _activeLoan();
        uint256 r1 = _request(loanId, 0);
        vm.store(address(diamond), _indexSlotOf(loanId, r1), bytes32(0));
        assertEq(RefinanceFacet(address(diamond)).indexRefinanceRequests(1, type(uint256).max), 1);

        (address l, uint256 pk) = _replacementLender("backfillLender");
        _signAndAcceptOffer(l, pk, r1);
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(loanId).status),
            uint8(LibVaipakam.LoanStatus.Repaid),
            "the backfilled request completed the refinance"
        );
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
            _params(LibVaipakam.OfferType.Borrower, 400, LibVaipakam.FillMode.Aon, loanId, 0)
        );

        vm.prank(borrower);
        OfferCancelFacet(address(diamond)).cancelOffer(r1);
        uint256 r2 = _request(loanId, 0);
        assertEq(_live(loanId), r2);
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
