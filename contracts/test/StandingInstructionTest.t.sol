// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibEncumbrance} from "../src/libraries/LibEncumbrance.sol";
import {LibInterestPayment, IInterestPaymentHost} from "../src/libraries/LibInterestPayment.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {RepayPeriodicFacet} from "../src/facets/RepayPeriodicFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {ClaimViewFacet} from "../src/facets/ClaimViewFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {NumeraireConfigFacet} from "../src/facets/NumeraireConfigFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {AutoLifecycleSettingsFacet} from "../src/facets/AutoLifecycleSettingsFacet.sol";
import {AutoLifecycleFacet} from "../src/facets/AutoLifecycleFacet.sol";
import {CollateralConcentrationFacet} from "../src/facets/CollateralConcentrationFacet.sol";
import {ForcedSaleFacet} from "../src/facets/ForcedSaleFacet.sol";
import {ForcedSalePreviewFacet} from "../src/facets/ForcedSalePreviewFacet.sol";
import {StandingInstructionFacet} from "../src/facets/StandingInstructionFacet.sol";
import {SettlementLegFacet} from "../src/facets/SettlementLegFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {TreasuryFeeFacet} from "../src/facets/TreasuryFeeFacet.sol";
import {ITreasuryFeeHost} from "../src/interfaces/ITreasuryFeeHost.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";
import {periodicQuote} from "./helpers/ForcedSaleQuote.sol";

/// @title StandingInstructionTest
/// @notice #3681 — the loan reserve and the three standing instructions:
///         keep my loan healthy, pay my interest, repay at the due date.
///         Design: docs/DesignsAndPlans/StandingInstructionsDesign.md §8.
contract StandingInstructionTest is SetupTest {
    uint256 internal constant LOAN = 1;
    uint256 internal constant ADAPTER_IDX = 1;
    uint256 internal constant TREASURY_BPS = LibVaipakam.TREASURY_FEE_BPS;
    uint8 internal constant PAYMENT = 0;
    uint8 internal constant COLLATERAL = 1;

    MockSwapAdapter internal adapter;
    address internal runner = makeAddr("anyone");
    uint256 internal startTs;

    function setUp() public {
        setupHelper();
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setPeriodicInterestEnabled(true);
        vm.prank(owner);
        ConfigFacet(address(diamond)).setMaxOfferDurationDays(2 * 365);
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8);
        mockOraclePrice(mockCollateralERC20, 1_000 * 1e8, 8);
        adapter = new MockSwapAdapter("periodic");
        ERC20Mock(mockERC20).mint(address(adapter), 1_000_000 ether);
        AdminFacet(address(diamond)).addSwapAdapter(address(adapter));
        _createMonthlyLoan();
        startTs = uint256(_loan().startTime);
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    function _si() internal view returns (StandingInstructionFacet) {
        return StandingInstructionFacet(address(diamond));
    }

    function _loan() internal view returns (LibVaipakam.Loan memory) {
        return LoanFacet(address(diamond)).getLoanDetails(LOAN);
    }

    function _createMonthlyLoan() internal {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                integrator: address(0),
                lifecycleFlex: 0,
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 1000 ether,
                interestRateBps: 1200,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 5000 ether,
                durationDays: 90,
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
                amountMax: 1000 ether,
                interestRateBpsMax: 1200,
                collateralAmountMax: 5000 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.Monthly,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            }),
            type(uint64).max
        );
        _signAndAcceptOffer(borrower, borrowerPk, offerId);
    }

    function _fund(address who, uint8 kind, uint256 amount) internal {
        address asset = kind == PAYMENT ? mockERC20 : mockCollateralERC20;
        ERC20Mock(asset).mint(who, amount);
        vm.startPrank(who);
        IERC20(asset).approve(address(diamond), amount);
        _si().fundLoanReserve(LOAN, kind, amount);
        vm.stopPrank();
    }

    function _set(uint64 trigger, uint64 target, bool payInterest, bool repayAtDue, uint32 lead) internal {
        vm.prank(borrower);
        _si().setStandingInstructions(
            LOAN, StandingInstructionFacet.InstructionInput(trigger, target, payInterest, repayAtDue, lead)
        );
    }

    function _view() internal view returns (StandingInstructionFacet.ReserveView memory) {
        return _si().getLoanReserve(LOAN, borrower);
    }

    /// @dev The shared setup pins every health-factor read at 2.0 by a
    ///      selector-wide mock; an exact-argument mock for this loan outranks
    ///      it. The top-up is linear in the health factor it reads, so the
    ///      tests assert the collateral it moves, not a re-read figure.
    function _mockHf(uint256 hf) internal {
        vm.mockCall(
            address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, LOAN), abi.encode(hf)
        );
    }

    function _lenderHeld() internal view returns (uint256 amount) {
        (, , , , , , amount, ) = ClaimViewFacet(address(diamond)).getClaimable(LOAN, true);
    }

    // ─── 1. The reserve ───────────────────────────────────────────────

    function test_reserve_fundAndWithdrawBothKinds() public {
        (, , uint256 free0, , ) = AutoLifecycleFacet(address(diamond)).getExtendFunding(LOAN, borrower);
        _fund(borrower, PAYMENT, 30 ether);
        _fund(borrower, COLLATERAL, 400 ether);
        StandingInstructionFacet.ReserveView memory v = _view();
        assertEq(v.paymentReserve, 30 ether);
        assertEq(v.collateralReserve, 400 ether);
        (, uint256 reserved, uint256 otherFree, , ) = AutoLifecycleFacet(address(diamond)).getExtendFunding(LOAN, borrower);
        assertEq(reserved, 30 ether, "the extension reads the same payment reserve");
        assertEq(otherFree, free0, "the funded amount is reserved, not added to the free balance");

        uint256 wallet0 = IERC20(mockCollateralERC20).balanceOf(borrower);
        vm.expectEmit(true, true, false, true, address(diamond));
        emit StandingInstructionFacet.LoanReserveWithdrawn(LOAN, borrower, COLLATERAL, mockCollateralERC20, 150 ether, 250 ether);
        vm.prank(borrower);
        _si().withdrawLoanReserve(borrower, LOAN, COLLATERAL, 150 ether);
        assertEq(IERC20(mockCollateralERC20).balanceOf(borrower) - wallet0, 150 ether);

        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibEncumbrance.LoanReserveInsufficient.selector, LOAN, borrower, PAYMENT, 31 ether, 30 ether
            )
        );
        _si().withdrawLoanReserve(borrower, LOAN, PAYMENT, 31 ether);
    }

    function test_reserve_fundRefusals() public {
        ERC20Mock(mockERC20).mint(lender, 1 ether);
        vm.startPrank(lender);
        IERC20(mockERC20).approve(address(diamond), 1 ether);
        vm.expectRevert(IVaipakamErrors.NotNFTOwner.selector);
        _si().fundLoanReserve(LOAN, PAYMENT, 1 ether);
        vm.stopPrank();
        vm.prank(borrower);
        vm.expectRevert(StandingInstructionFacet.LoanReserveZeroAmount.selector);
        _si().fundLoanReserve(LOAN, PAYMENT, 0);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(LibEncumbrance.LoanReserveKindUnknown.selector, uint8(7)));
        _si().fundLoanReserve(LOAN, 7, 1 ether);
    }

    function test_reserve_isNotCollateral_andSurvivesRepayment() public {
        _fund(borrower, COLLATERAL, 500 ether);
        assertEq(_loan().collateralAmount, 5000 ether, "the reserve is not in the loan, so not in its health factor");
        uint256 pledged = CollateralConcentrationFacet(address(diamond)).getConcentration(mockCollateralERC20).pledged;
        assertEq(pledged, 5000 ether, "nor in the pledged total");

        vm.warp(startTs + 20 days);
        ERC20Mock(mockERC20).mint(borrower, 2000 ether);
        vm.startPrank(borrower);
        IERC20(mockERC20).approve(address(diamond), type(uint256).max);
        RepayFacet(address(diamond)).repayLoan(LOAN);
        vm.stopPrank();
        assertEq(_view().collateralReserve, 500 ether, "the repayment took none of it");
        vm.prank(borrower);
        _si().withdrawLoanReserve(borrower, LOAN, COLLATERAL, 500 ether);
    }

    // ─── 2. Keep my loan healthy ──────────────────────────────────────

    function test_topUp_bounds() public {
        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(StandingInstructionFacet.TopUpBoundsInvalid.selector, uint64(1.0e18), uint64(1.5e18))
        );
        _si().setStandingInstructions(LOAN, StandingInstructionFacet.InstructionInput(1.0e18, 1.5e18, false, false, 0));
        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(StandingInstructionFacet.TopUpBoundsInvalid.selector, uint64(1.3e18), uint64(1.32e18))
        );
        _si().setStandingInstructions(LOAN, StandingInstructionFacet.InstructionInput(1.3e18, 1.32e18, false, false, 0));
        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(StandingInstructionFacet.TopUpBoundsInvalid.selector, uint64(1.3e18), uint64(2.1e18))
        );
        _si().setStandingInstructions(LOAN, StandingInstructionFacet.InstructionInput(1.3e18, 2.1e18, false, false, 0));
    }

    function test_topUp_movesTheLeastToTarget_thenWaitsTheInterval() public {
        _fund(borrower, COLLATERAL, 3000 ether);
        _set(1.3e18, 1.6e18, false, false, 0);
        uint256 hf0 = 1.2e18;
        _mockHf(hf0);
        uint256 want = (5000 ether * (1.6e18 - hf0) + hf0 - 1) / hf0;

        vm.prank(runner);
        _si().runCollateralTopUp(LOAN);
        assertEq(_loan().collateralAmount, 5000 ether + want, "moved the least to the target");
        assertEq(_view().collateralReserve, 3000 ether - want);
        assertGe(((5000 ether + want) * hf0) / 5000 ether, 1.6e18, "back at the target");
        assertLt(((5000 ether + want - 1) * hf0) / 5000 ether, 1.6e18, "and no more than needed");
        assertEq(
            CollateralConcentrationFacet(address(diamond)).getConcentration(mockCollateralERC20).pledged,
            5000 ether + want,
            "now pledged"
        );

        vm.prank(runner);
        vm.expectPartialRevert(StandingInstructionFacet.TopUpTooSoon.selector);
        _si().runCollateralTopUp(LOAN);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(runner);
        _si().runCollateralTopUp(LOAN);
        assertEq(_view().collateralReserve, 0, "clamped by the reserve");
    }

    function test_topUp_refusedAboveTrigger_andOffWhenUnset() public {
        vm.prank(runner);
        vm.expectRevert(
            abi.encodeWithSelector(StandingInstructionFacet.StandingInstructionNotSet.selector, LOAN, uint8(1))
        );
        _si().runCollateralTopUp(LOAN);
        _fund(borrower, COLLATERAL, 10 ether);
        _set(1.3e18, 1.6e18, false, false, 0);
        vm.prank(runner);
        vm.expectPartialRevert(StandingInstructionFacet.LoanHealthAboveTrigger.selector);
        _si().runCollateralTopUp(LOAN);
    }

    /// @dev The top-up stands in for adding collateral, which a flagged
    ///      holder may not do: it is skipped by name and moves nothing.
    function test_topUp_skippedWhileTheOwnerIsSanctioned() public {
        _fund(borrower, COLLATERAL, 3000 ether);
        _set(1.3e18, 1.6e18, false, false, 0);
        _mockHf(1.2e18);
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        m.setFlagged(borrower, true);

        assertEq(_view().topUpSkipNow, 10, "the view states the skip");
        vm.expectEmit(true, true, false, true, address(diamond));
        emit StandingInstructionFacet.StandingInstructionSkipped(LOAN, 1, 10, 0, runner);
        vm.prank(runner);
        _si().runCollateralTopUp(LOAN);
        assertEq(_loan().collateralAmount, 5000 ether, "nothing moved");
        assertEq(_view().collateralReserve, 3000 ether, "the reserve is intact");

        m.setFlagged(borrower, false);
        vm.prank(runner);
        _si().runCollateralTopUp(LOAN);
        assertGt(_loan().collateralAmount, 5000 ether, "runs once cleared");
    }

    // ─── 3. Pay my interest ───────────────────────────────────────────

    function test_interest_notBeforePeriodEnd() public {
        _fund(borrower, PAYMENT, 50 ether);
        _set(0, 0, true, false, 0);
        vm.prank(runner);
        vm.expectPartialRevert(StandingInstructionFacet.StandingInstructionNotDue.selector);
        _si().runInterestPayment(LOAN);
    }

    function test_interest_fullPayment_closesPeriodOnce_andBooksLikeAnyInterest() public {
        _fund(borrower, PAYMENT, 50 ether);
        _set(0, 0, true, false, 0);
        vm.warp(startTs + 30 days);
        (, , , , , uint256 shortfall, ) = RepayPeriodicFacet(address(diamond)).previewPeriodicSettle(LOAN);
        uint256 cut = (shortfall * TREASURY_BPS) / 10_000;
        uint256 treasury0 = IERC20(mockERC20).balanceOf(address(diamond));
        uint64 checkpoint0 = _loan().lastPeriodicInterestSettledAt;
        uint256 reservePart0 = TreasuryFeeFacet(address(diamond)).getReservePartHeldByTreasury(mockERC20);
        // The treasury share is an interest fee: split at the interest floor
        // (rounded up, capped at half the loan's share), the rest the reserve's.
        uint256 floor = (shortfall * LibVaipakam.FEE_FLOOR_INTEREST_BPS_DEFAULT + 9_999) / 10_000;
        uint256 halfShare = (shortfall * TREASURY_BPS) / 20_000;
        if (halfShare < floor) floor = halfShare;

        vm.expectEmit(true, true, false, true, address(diamond));
        emit LibInterestPayment.InterestPaymentBooked(
            LOAN, LibInterestPayment.SOURCE_PAYMENT_RESERVE, mockERC20, shortfall, shortfall, shortfall - cut, cut, shortfall
        );
        vm.prank(runner);
        _si().runInterestPayment(LOAN);

        LibVaipakam.Loan memory l = _loan();
        assertEq(l.lastPeriodicInterestSettledAt, checkpoint0 + 30 days, "the period closed, once");
        assertEq(l.interestPaidSinceLastPeriod, 0);
        assertEq(l.interestSettled, shortfall, "the gross counts as settled");
        assertEq(_lenderHeld(), shortfall - cut, "the lender's net, held");
        assertEq(IERC20(mockERC20).balanceOf(address(diamond)) - treasury0, cut, "the treasury share");
        assertEq(
            TreasuryFeeFacet(address(diamond)).getReservePartHeldByTreasury(mockERC20) - reservePart0,
            cut - floor,
            "the share is split at the interest floor"
        );
        assertGt(cut - floor, 0);
        assertEq(_view().paymentReserve, 50 ether - shortfall);
        assertEq(l.principal, 1000 ether, "no principal moved");

        // The periodic settlement after grace now has nothing to do in this
        // period: the next period is not yet due.
        vm.warp(startTs + 31 days + 1);
        vm.prank(runner);
        vm.expectPartialRevert(IVaipakamErrors.PeriodicSettleNotDue.selector);
        RepayPeriodicFacet(address(diamond)).settlePeriodicInterest(LOAN, 0, new LibSwap.AdapterCall[](0));
        assertEq(_loan().lastPeriodicInterestSettledAt, checkpoint0 + 30 days, "not advanced twice");
    }

    /// @dev Paying interest stays open to a flagged owner, as repaying does.
    function test_interest_paidWhileTheOwnerIsSanctioned() public {
        _fund(borrower, PAYMENT, 50 ether);
        _set(0, 0, true, false, 0);
        vm.warp(startTs + 30 days);
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        m.setFlagged(borrower, true);
        uint64 checkpoint0 = _loan().lastPeriodicInterestSettledAt;
        vm.prank(runner);
        _si().runInterestPayment(LOAN);
        assertEq(_loan().lastPeriodicInterestSettledAt, checkpoint0 + 30 days, "the period closed");
    }

    function test_interest_partialPayment_saleSellsOnlyTheRest() public {
        _fund(borrower, PAYMENT, 3 ether);
        _set(0, 0, true, false, 0);
        vm.warp(startTs + 30 days);
        (, , , , , uint256 shortfall, ) = RepayPeriodicFacet(address(diamond)).previewPeriodicSettle(LOAN);
        vm.prank(runner);
        _si().runInterestPayment(LOAN);
        assertEq(_view().paymentReserve, 0);
        uint64 checkpoint0 = _loan().lastPeriodicInterestSettledAt;
        assertEq(checkpoint0, uint64(startTs), "a part payment leaves the period open");

        vm.warp(startTs + 31 days + 1);
        ForcedSaleFacet.ForcedSalePlan memory p = ForcedSalePreviewFacet(address(diamond)).previewForcedSale(
            LOAN, ForcedSaleFacet.ForcedSaleKind.PeriodicSettlement
        );
        assertEq(p.debt, shortfall - 3 ether, "the sale is sized for the rest only");
        uint256 sellQuote = periodicQuote(address(diamond), LOAN);
        LibSwap.AdapterCall[] memory calls = new LibSwap.AdapterCall[](1);
        calls[0] = LibSwap.AdapterCall({adapterIdx: ADAPTER_IDX, data: ""});
        vm.prank(runner);
        RepayPeriodicFacet(address(diamond)).settlePeriodicInterest(LOAN, sellQuote, calls);
        LibVaipakam.Loan memory l = _loan();
        assertEq(l.lastPeriodicInterestSettledAt, checkpoint0 + 30 days, "the sale closed the period once");
        assertEq(l.interestSettled, shortfall, "reserve part and sale part both settled");
        // Lender and treasury are split the same way whichever source paid.
        uint256 netA = 3 ether - (3 ether * TREASURY_BPS) / 10_000;
        uint256 restGross = shortfall - 3 ether;
        uint256 netB = restGross - (restGross * TREASURY_BPS) / 10_000;
        assertEq(_lenderHeld(), netA + netB, "both sources book the lender's net alike");
    }

    function test_interest_skipsWhenReserveEmpty() public {
        _set(0, 0, true, false, 0);
        vm.warp(startTs + 30 days);
        vm.expectEmit(true, true, false, true, address(diamond));
        emit StandingInstructionFacet.StandingInstructionSkipped(LOAN, 2, 2, 0, runner);
        vm.prank(runner);
        _si().runInterestPayment(LOAN);
        assertEq(_loan().interestSettled, 0, "nothing changed");
    }

    // ─── 4. Repay at the due date ─────────────────────────────────────

    function test_repay_shortReserveDoesNothing_thenRepaysInFull() public {
        _set(0, 0, false, true, 1 hours);
        uint256 maturity = startTs + 90 days;
        vm.warp(maturity - 2 hours);
        vm.prank(runner);
        vm.expectPartialRevert(StandingInstructionFacet.StandingInstructionNotDue.selector);
        _si().runDueRepayment(LOAN);

        vm.warp(maturity - 1 hours);
        _fund(borrower, PAYMENT, 100 ether);
        vm.recordLogs();
        vm.prank(runner);
        _si().runDueRepayment(LOAN);
        assertEq(uint256(_loan().status), uint256(LibVaipakam.LoanStatus.Active), "short: nothing changed");
        assertEq(_view().paymentReserve, 100 ether);

        uint256 due = _view().repayDue;
        _fund(borrower, PAYMENT, due - 100 ether);
        vm.prank(runner);
        _si().runDueRepayment(LOAN);
        assertEq(uint256(_loan().status), uint256(LibVaipakam.LoanStatus.Repaid), "repaid in full");
        assertEq(_view().paymentReserve, 0, "drew exactly what it charged");
    }

    /// @dev Repaying from the reserve stays open to a flagged owner.
    function test_repay_paidWhileTheOwnerIsSanctioned() public {
        _set(0, 0, false, true, 1 hours);
        vm.warp(startTs + 90 days - 1 hours);
        _fund(borrower, PAYMENT, _view().repayDue);
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        m.setFlagged(borrower, true);
        vm.prank(runner);
        _si().runDueRepayment(LOAN);
        assertEq(uint256(_loan().status), uint256(LibVaipakam.LoanStatus.Repaid), "repaid in full");
    }

    function test_repay_onePlanForTheDueDate() public {
        _set(0, 0, false, true, 0);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(AutoLifecycleSettingsFacet.DueDatePlanExists.selector, LOAN));
        AutoLifecycleSettingsFacet(address(diamond)).setAutoExtendBorrowerCaps(
            LOAN, true, 0, 1000, uint64(startTs + 400 days), type(uint256).max
        );
        vm.prank(borrower);
        _si().clearStandingInstructions(LOAN);
        vm.prank(borrower);
        AutoLifecycleSettingsFacet(address(diamond)).setAutoExtendBorrowerCaps(
            LOAN, true, 0, 1000, uint64(startTs + 400 days), type(uint256).max
        );
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(StandingInstructionFacet.DueDatePlanExists.selector, LOAN));
        _si().setStandingInstructions(LOAN, StandingInstructionFacet.InstructionInput(0, 0, false, true, 0));
    }

    // ─── 4b. A refused leg (#3669) ────────────────────────────────────

    struct RepayEnd {
        uint8 status;
        uint256 parkedLender;
        address parkedPayer;
        uint256 parkedTreasury;
        uint256 treasuryBal;
        uint256 lenderClaim;
        uint256 borrowerClaim;
    }

    function _end() internal view returns (RepayEnd memory e) {
        e.status = uint8(_loan().status);
        LibVaipakam.ParkedLeg memory leg = SettlementLegFacet(address(diamond)).getParkedLenderLeg(LOAN);
        e.parkedLender = leg.amount;
        e.parkedPayer = leg.payer;
        (e.parkedTreasury,) = SettlementLegFacet(address(diamond)).getParkedTreasury(borrower, mockERC20);
        e.treasuryBal = IERC20(mockERC20).balanceOf(address(diamond));
        (, , , , , , e.lenderClaim, ) = ClaimViewFacet(address(diamond)).getClaimable(LOAN, true);
        (, , , , , , e.borrowerClaim, ) = ClaimViewFacet(address(diamond)).getClaimable(LOAN, false);
    }

    /// @dev The reserve repayment and a hand repayment, from the same state,
    ///      with the same leg refused; returns both end states.
    function _reserveVsHand(bool lenderFrozen) internal returns (RepayEnd memory viaReserve, RepayEnd memory byHand) {
        _set(0, 0, false, true, 1 hours);
        vm.warp(startTs + 90 days - 1 hours);
        uint256 due = _view().repayDue;
        uint256 snap = vm.snapshotState();

        _fund(borrower, PAYMENT, due);
        if (lenderFrozen) {
            vm.mockCallRevert(
                address(diamond),
                abi.encodeWithSelector(SettlementLegFacet.vaultLegToStoredLender.selector),
                "frozen lender vault"
            );
        } else {
            vm.mockCallRevert(
                address(diamond),
                abi.encodeWithSelector(ITreasuryFeeHost.collectFeeFromVault.selector),
                "frozen treasury"
            );
        }
        vm.prank(runner);
        _si().runDueRepayment(LOAN);
        vm.clearMockedCalls();
        viaReserve = _end();
        assertEq(_view().paymentReserve, 0, "the reserve is reduced by the full amount");

        vm.revertToState(snap);
        ERC20Mock(mockERC20).mint(borrower, due);
        vm.prank(borrower);
        IERC20(mockERC20).approve(address(diamond), due);
        if (lenderFrozen) {
            vm.mockCallRevert(
                address(diamond),
                abi.encodeWithSelector(VaultFactoryFacet.vaultDepositERC20From.selector),
                "frozen lender vault"
            );
        } else {
            vm.mockCallRevert(
                address(diamond),
                abi.encodeWithSelector(ITreasuryFeeHost.collectFeeFromPayer.selector),
                "frozen treasury"
            );
        }
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(LOAN);
        vm.clearMockedCalls();
        byHand = _end();
    }

    function _assertSame(RepayEnd memory a, RepayEnd memory b) internal pure {
        assertEq(a.status, b.status, "loan status");
        assertEq(a.parkedLender, b.parkedLender, "parked lender leg");
        assertEq(a.parkedPayer, b.parkedPayer, "parked in the same vault");
        assertEq(a.parkedTreasury, b.parkedTreasury, "parked treasury share");
        assertEq(a.treasuryBal, b.treasuryBal, "treasury accrual");
        assertEq(a.lenderClaim, b.lenderClaim, "lender claim");
        assertEq(a.borrowerClaim, b.borrowerClaim, "collateral back to the borrower side");
    }

    function test_repay_frozenLenderVault_parksAsAHandRepaymentWould() public {
        (RepayEnd memory r, RepayEnd memory h) = _reserveVsHand(true);
        assertEq(r.status, uint8(LibVaipakam.LoanStatus.Repaid), "the loan closes");
        assertGt(r.parkedLender, 0, "the lender's due parked");
        assertEq(r.parkedPayer, borrower, "in the holder's own vault");
        _assertSame(r, h);
    }

    function test_repay_frozenTreasury_parksAsAHandRepaymentWould() public {
        (RepayEnd memory r, RepayEnd memory h) = _reserveVsHand(false);
        assertEq(r.status, uint8(LibVaipakam.LoanStatus.Repaid), "the loan closes");
        assertGt(r.parkedTreasury, 0, "the treasury share parked");
        assertEq(r.parkedLender, 0, "the lender leg delivered");
        _assertSame(r, h);
    }

    function test_repay_parkedLeg_isNotReserve_andTheLenderClaimPaysIt() public {
        _set(0, 0, false, true, 1 hours);
        vm.warp(startTs + 90 days - 1 hours);
        uint256 due = _view().repayDue;
        _fund(borrower, PAYMENT, due);
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(SettlementLegFacet.vaultLegToStoredLender.selector),
            "frozen lender vault"
        );
        vm.prank(runner);
        _si().runDueRepayment(LOAN);
        vm.clearMockedCalls();
        uint256 parked = SettlementLegFacet(address(diamond)).getParkedLenderLeg(LOAN).amount;
        assertGt(parked, 0);

        // The depositor's reserve withdrawal cannot reach the parked amount.
        vm.prank(borrower);
        vm.expectRevert();
        _si().withdrawLoanReserve(borrower, LOAN, PAYMENT, 1);

        // The lender's later claim pays it, into the lender's vault (#3629).
        address lenderVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
        uint256 before = IERC20(mockERC20).balanceOf(lenderVault);
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(LOAN);
        assertEq(IERC20(mockERC20).balanceOf(lenderVault) - before, parked, "the claim paid the parked due");
        assertEq(SettlementLegFacet(address(diamond)).getParkedLenderLeg(LOAN).payer, address(0), "released");
    }

    function test_interest_refusedLeg_skipsByName_andThePreviewSaysSo() public {
        _fund(borrower, PAYMENT, 50 ether);
        _set(0, 0, true, false, 0);
        vm.warp(startTs + 30 days);
        (, , , , , uint256 shortfall, ) = RepayPeriodicFacet(address(diamond)).previewPeriodicSettle(LOAN);

        // Unrefused: the preview says it would pay, and changes nothing.
        vm.expectRevert(abi.encodeWithSelector(StandingInstructionFacet.InterestPaymentPreview.selector, 0, shortfall, bytes4(0)));
        _si().previewInterestPayment(LOAN);
        assertEq(_view().paymentReserve, 50 ether, "the preview moved nothing");

        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(ITreasuryFeeHost.collectFeeFromDiamond.selector),
            "frozen treasury"
        );
        // A mocked revert returns the bytes as given, so the first four are the inner selector.
        bytes4 inner = bytes4(bytes("frozen treasury"));
        vm.expectRevert(abi.encodeWithSelector(StandingInstructionFacet.InterestPaymentPreview.selector, 9, 0, inner));
        _si().previewInterestPayment(LOAN);

        vm.expectEmit(true, false, false, true, address(diamond));
        emit StandingInstructionFacet.InterestPaymentAttemptFailed(LOAN, inner);
        vm.expectEmit(true, true, false, true, address(diamond));
        emit StandingInstructionFacet.StandingInstructionSkipped(LOAN, 2, 9, 0, runner);
        vm.prank(runner);
        _si().runInterestPayment(LOAN);
        vm.clearMockedCalls();
        assertEq(_loan().interestSettled, 0, "nothing settled");
        assertEq(_view().paymentReserve, 50 ether, "nothing drawn");

        // Unfrozen, it pays.
        vm.prank(runner);
        _si().runInterestPayment(LOAN);
        assertEq(_loan().interestSettled, shortfall, "paid once the leg is accepted");
    }

    /// A booking that settles less than the payment (a lender delivery that
    /// arrived short) undoes the attempt and is skipped by name: the period is
    /// not credited with interest that never arrived.
    function test_interest_shortBooking_skipsAndCreditsNothing() public {
        _fund(borrower, PAYMENT, 50 ether);
        _set(0, 0, true, false, 0);
        vm.warp(startTs + 30 days);
        (, , , , , uint256 shortfall, ) = RepayPeriodicFacet(address(diamond)).previewPeriodicSettle(LOAN);
        uint64 checkpoint0 = _loan().lastPeriodicInterestSettledAt;

        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(IInterestPaymentHost.bookInterestPayment.selector),
            abi.encode(uint256(0), shortfall - 1)
        );
        vm.expectEmit(true, false, false, true, address(diamond));
        emit StandingInstructionFacet.InterestPaymentAttemptFailed(LOAN, IVaipakamErrors.TokenDeliveryShort.selector);
        vm.prank(runner);
        _si().runInterestPayment(LOAN);
        vm.clearMockedCalls();

        assertEq(_loan().lastPeriodicInterestSettledAt, checkpoint0, "the period is not credited");
        assertEq(_view().paymentReserve, 50 ether, "nothing drawn");
    }

    /// The preview leaves nothing behind, also when a caller catches its
    /// revert inside a larger call.
    function test_interest_previewLeavesNoState_evenWhenCaught() public {
        _fund(borrower, PAYMENT, 50 ether);
        _set(0, 0, true, false, 0);
        vm.warp(startTs + 30 days);
        LibVaipakam.Loan memory before = _loan();
        uint256 reserve0 = _view().paymentReserve;
        uint256 diamond0 = IERC20(mockERC20).balanceOf(address(diamond));
        PreviewCatcher c = new PreviewCatcher();
        bool caught = c.catchPreview(address(diamond), LOAN);
        assertTrue(caught, "the preview reverted, and the outer call went on");
        LibVaipakam.Loan memory after_ = _loan();
        assertEq(after_.interestSettled, before.interestSettled, "nothing settled");
        assertEq(after_.lastPeriodicInterestSettledAt, before.lastPeriodicInterestSettledAt, "period unchanged");
        assertEq(_view().paymentReserve, reserve0, "reserve unchanged");
        assertEq(IERC20(mockERC20).balanceOf(address(diamond)), diamond0, "no treasury accrual");
        assertEq(_lenderHeld(), 0, "nothing held for the lender");
    }

    // ─── 5. Position transfer ─────────────────────────────────────────

    function test_transfer_oldHoldersInstructionIsSkipped() public {
        _fund(borrower, PAYMENT, 50 ether);
        _set(0, 0, true, false, 0);
        StandingInstructionFacet.ReserveView memory v0 = _view();
        assertEq(v0.paymentSkipNow, 0, "nothing stands in the way yet");
        assertEq(v0.topUpSkipNow, 0);
        assertFalse(v0.consolidationPending);
        address newHolder = makeAddr("newHolder");
        uint256 tokenId = _loan().borrowerTokenId;
        LibTestPositionNFT.waitOutCooldown(address(diamond), tokenId);
        vm.prank(borrower);
        LibTestPositionNFT.core(address(diamond)).transferFrom(borrower, newHolder, tokenId);
        vm.warp(startTs + 30 days);
        // The view names the skip before anyone pays for a run.
        StandingInstructionFacet.ReserveView memory v1 = _view();
        assertEq(v1.paymentSkipNow, 1, "holder changed, seen from the view");
        assertEq(v1.topUpSkipNow, 1);
        assertTrue(v1.consolidationPending);
        vm.expectEmit(true, true, false, true, address(diamond));
        emit StandingInstructionFacet.StandingInstructionSkipped(LOAN, 2, 1, 0, runner);
        vm.prank(runner);
        _si().runInterestPayment(LOAN);
        vm.prank(borrower);
        _si().withdrawLoanReserve(borrower, LOAN, PAYMENT, 50 ether);
    }
}

/// @dev Calls the preview inside its own call and catches the revert, the way
///      another contract could, then returns normally.
contract PreviewCatcher {
    function catchPreview(address diamond, uint256 loanId) external returns (bool caught) {
        try StandingInstructionFacet(diamond).previewInterestPayment(loanId) {
            caught = false;
        } catch {
            caught = true;
        }
    }
}
