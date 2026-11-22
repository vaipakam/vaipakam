// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {AutoLifecycleSettingsFacet} from "../src/facets/AutoLifecycleSettingsFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {PrecloseOffsetFacet} from "../src/facets/PrecloseOffsetFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibAutoRefinanceCheck} from "../src/libraries/LibAutoRefinanceCheck.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {LibTestTiming} from "./helpers/LibTestTiming.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title ClosedLoanVehicleCancelTest
/// @notice #3753 — an offset offer or a refinance request left open when its
///         loan closes (repaid, defaulted, settled) can never complete: the
///         accept refuses by name before any value moves. This suite pins
///         that refusal, and that such an offer now reads as a dead route, so
///         anyone (and the keeper's dead-route cancel) may cancel it at once
///         and its escrow is released to its creator. A FallbackPending loan
///         can still be cured back to Active, so its offers stay live.
contract ClosedLoanVehicleCancelTest is SetupTest {
    uint256 internal constant LOAN_PRINCIPAL = 100 ether;
    uint256 internal constant LOAN_COLLATERAL = 1800 ether;

    event OfferCanceled(uint256 indexed offerId, address indexed creator);

    function setUp() public {
        setupHelper();
        AdminFacet(address(diamond)).setAutoRefinanceEnabled(true);
    }

    // ─── fixtures ──────────────────────────────────────────────────────

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
            _params(LibVaipakam.OfferType.Lender, 500, LibVaipakam.FillMode.Partial, 0), type(uint64).max
        );
        loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
    }

    function _params(LibVaipakam.OfferType offerType, uint256 rateBps, LibVaipakam.FillMode fillMode, uint256 targetLoanId)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            integrator: address(0),
            lifecycleFlex: 0,
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
            expiresAt: 0,
            fillMode: fillMode,
            refinanceTargetLoanId: targetLoanId,
            useFullTermInterest: false
        });
    }

    /// The borrower's offset offer on `loanId`, open until the far future.
    function _offset(uint256 loanId) internal returns (uint256 id) {
        ERC20Mock(mockERC20).mint(borrower, LOAN_PRINCIPAL * 4);
        vm.startPrank(borrower);
        ERC20(mockERC20).approve(VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower), type(uint256).max);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        id = PrecloseOffsetFacet(address(diamond)).offsetWithNewOffer(
            loanId, 500, 29, mockCollateralERC20, LOAN_COLLATERAL, true, mockERC20, type(uint64).max
        );
        vm.stopPrank();
        LibTestTiming.waitOutTermsAge(address(diamond), id);
    }

    /// The borrower's refinance request on `loanId`, pledging fresh collateral.
    function _request(uint256 loanId) internal returns (uint256 id) {
        return _request(loanId, LOAN_COLLATERAL);
    }

    /// A refinance request pledging `collateral`: the loan's own amount is a
    /// carry-over (nothing escrowed), any other amount a fresh pledge.
    function _request(uint256 loanId, uint256 collateral) internal returns (uint256 id) {
        ERC20Mock(mockCollateralERC20).mint(borrower, LOAN_COLLATERAL * 2);
        vm.prank(borrower);
        AutoLifecycleSettingsFacet(address(diamond)).setAutoRefinanceCaps(
            loanId, true, 600, uint64(block.timestamp + 365 days)
        );
        LibVaipakam.CreateOfferParams memory p =
            _params(LibVaipakam.OfferType.Borrower, 400, LibVaipakam.FillMode.Aon, loanId);
        p.collateralAmount = collateral;
        p.collateralAmountMax = collateral;
        vm.prank(borrower);
        id = OfferCreateFacet(address(diamond)).createOffer(p, type(uint64).max);
        LibTestTiming.waitOutTermsAge(address(diamond), id);
    }

    function _repay(uint256 loanId) internal {
        ERC20Mock(mockERC20).mint(borrower, LOAN_PRINCIPAL * 4);
        vm.startPrank(borrower);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        ERC20(mockERC20).approve(VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower), type(uint256).max);
        RepayFacet(address(diamond)).repayLoan(loanId);
        vm.stopPrank();
    }

    function _setStatus(uint256 loanId, LibVaipakam.LoanStatus st) internal {
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        l.status = st;
        TestMutatorFacet(address(diamond)).setLoan(loanId, l);
    }

    /// A funded, approved stranger tries to accept `offerId`; expect `err`.
    function _acceptRefused(uint256 offerId, uint256 linkedLoanId, bytes memory err) internal {
        address a = _provisionFundedActorWithVault("acceptor", mockERC20, LOAN_PRINCIPAL * 4);
        (, uint256 pk) = makeAddrAndKey("acceptor");
        ERC20Mock(mockCollateralERC20).mint(a, LOAN_COLLATERAL * 4);
        address av = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(a);
        vm.startPrank(a);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        ERC20(mockERC20).approve(av, type(uint256).max);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        ERC20(mockCollateralERC20).approve(av, type(uint256).max);
        vm.stopPrank();
        LibAcceptTerms.AcceptTerms memory t =
            LibAcceptTestSigner.buildTerms(address(diamond), a, offerId, true, linkedLoanId);
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, pk);
        vm.expectRevert(err);
        vm.prank(a);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
    }

    /// A stranger cancels `offerId` at once (no expiry, no cancel cooldown
    /// wait): the offer is gone, its link is cleared and `asset`'s escrow
    /// (`escrow`) is released from the creator's liens.
    function _strangerCancels(uint256 offerId, address asset, uint256 escrow) internal {
        assertTrue(OfferCancelFacet(address(diamond)).isOfferRouteDead(offerId), "closed loan: route dead");
        uint256 encBefore = MetricsFacet(address(diamond)).getEncumbered(borrower, asset, 0);
        vm.expectEmit(true, true, false, false, address(diamond));
        emit OfferCanceled(offerId, borrower);
        vm.prank(makeAddr("stranger"));
        OfferCancelFacet(address(diamond)).cancelOffer(offerId);
        assertEq(OfferCancelFacet(address(diamond)).getOffer(offerId).creator, address(0), "offer cleared");
        assertEq(OfferCancelFacet(address(diamond)).getOfferLinkedLoanId(offerId), 0, "link cleared");
        assertEq(
            encBefore - MetricsFacet(address(diamond)).getEncumbered(borrower, asset, 0), escrow, "escrow released"
        );
    }

    /// A request pledging the loan's own collateral (carry-over) escrowed
    /// nothing at create, so its cancel releases nothing; otherwise its
    /// fresh collateral was escrowed.
    function _requestEscrow(uint256 r) internal view returns (uint256) {
        return OfferCancelFacet(address(diamond)).getOffer(r).refinanceCarryOver ? 0 : LOAN_COLLATERAL;
    }

    function _notActive() internal pure returns (bytes memory) {
        return abi.encodeWithSignature("LoanNotActive()");
    }

    // ─── offset offer ──────────────────────────────────────────────────

    function test_offset_liveLoan_strangerCannotCancel() public {
        uint256 id = _activeLoan();
        uint256 o = _offset(id);
        assertFalse(OfferCancelFacet(address(diamond)).isOfferRouteDead(o));
        vm.warp(block.timestamp + LibVaipakam.MIN_OFFER_CANCEL_DELAY + 1);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        OfferCancelFacet(address(diamond)).cancelOffer(o);
    }

    function test_offset_afterRepay_refusedThenStrangerCancels() public {
        uint256 id = _activeLoan();
        uint256 o = _offset(id);
        uint256 escrow = OfferCancelFacet(address(diamond)).getOffer(o).amount;
        _repay(id);
        _acceptRefused(o, id, _notActive());
        _strangerCancels(o, mockERC20, escrow);
    }

    function test_offset_afterDefault_strangerCancels() public {
        uint256 id = _activeLoan();
        uint256 o = _offset(id);
        uint256 escrow = OfferCancelFacet(address(diamond)).getOffer(o).amount;
        _setStatus(id, LibVaipakam.LoanStatus.Defaulted);
        _acceptRefused(o, id, _notActive());
        _strangerCancels(o, mockERC20, escrow);
    }

    function test_offset_afterSettled_strangerCancels() public {
        uint256 id = _activeLoan();
        uint256 o = _offset(id);
        uint256 escrow = OfferCancelFacet(address(diamond)).getOffer(o).amount;
        _setStatus(id, LibVaipakam.LoanStatus.Settled);
        _acceptRefused(o, id, _notActive());
        _strangerCancels(o, mockERC20, escrow);
    }

    function test_offset_fallbackPending_staysLive() public {
        uint256 id = _activeLoan();
        uint256 o = _offset(id);
        _setStatus(id, LibVaipakam.LoanStatus.FallbackPending);
        assertFalse(OfferCancelFacet(address(diamond)).isOfferRouteDead(o), "curable loan: offset live");
    }

    // ─── refinance request ─────────────────────────────────────────────

    function test_request_afterRepay_refusedThenStrangerCancels() public {
        uint256 id = _activeLoan();
        uint256 r = _request(id);
        assertFalse(OfferCancelFacet(address(diamond)).isOfferRouteDead(r));
        _repay(id);
        _acceptRefused(r, 0, abi.encodeWithSelector(LibAutoRefinanceCheck.RefinanceTargetNotActive.selector));
        _strangerCancels(r, mockCollateralERC20, _requestEscrow(r));
    }

    function test_request_freshPledge_afterRepay_escrowReleased() public {
        uint256 id = _activeLoan();
        uint256 r = _request(id, LOAN_COLLATERAL + 100 ether);
        assertFalse(OfferCancelFacet(address(diamond)).getOffer(r).refinanceCarryOver, "fresh pledge");
        _repay(id);
        _acceptRefused(r, 0, abi.encodeWithSelector(LibAutoRefinanceCheck.RefinanceTargetNotActive.selector));
        _strangerCancels(r, mockCollateralERC20, LOAN_COLLATERAL + 100 ether);
    }

    function test_request_afterDefault_strangerCancels() public {
        uint256 id = _activeLoan();
        uint256 r = _request(id);
        _setStatus(id, LibVaipakam.LoanStatus.Defaulted);
        _strangerCancels(r, mockCollateralERC20, _requestEscrow(r));
    }

    function test_request_afterSettled_strangerCancels() public {
        uint256 id = _activeLoan();
        uint256 r = _request(id);
        _setStatus(id, LibVaipakam.LoanStatus.Settled);
        _strangerCancels(r, mockCollateralERC20, _requestEscrow(r));
    }

    function test_request_fallbackPending_staysLive() public {
        uint256 id = _activeLoan();
        uint256 r = _request(id);
        _setStatus(id, LibVaipakam.LoanStatus.FallbackPending);
        assertFalse(OfferCancelFacet(address(diamond)).isOfferRouteDead(r), "curable loan: request live");
    }
}
