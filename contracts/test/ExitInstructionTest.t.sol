// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ExitInstructionFacet} from "../src/facets/ExitInstructionFacet.sol";
import {SwapToRepayFacet} from "../src/facets/SwapToRepayFacet.sol";
import {SwapToRepayPartialFacet} from "../src/facets/SwapToRepayPartialFacet.sol";
import {StandingInstructionFacet} from "../src/facets/StandingInstructionFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {ClaimViewFacet} from "../src/facets/ClaimViewFacet.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibStandingInstructions} from "../src/libraries/LibStandingInstructions.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LibTestPriceGuard} from "./helpers/LibTestPriceGuard.sol";
import {LibTestCalmPair} from "./helpers/LibTestCalmPair.sol";
import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";

/// @title ExitInstructionTest
/// @notice #3752 — sell and repay before liquidation, the fourth standing
///         instruction. Design: docs/DesignsAndPlans/ExitBeforeLiquidationDesign.md
///         §6 (the test list this suite follows, numbered in the test names).
/// @dev    The loan is scaffolded as in `SwapToRepayFacetTest`: 1,000
///         principal against 2,000 collateral, both 18 decimals, priced 1:1,
///         an 85% liquidation threshold and an 80% opening cap, so the health
///         factor starts near 1.7. Dropping the collateral price to 0.68
///         puts it near 1.156, below a 1.2 level. The swap adapter delivers
///         `outputMultiplierBps` of the input, so 6800 is exactly the oracle
///         value at 0.68.
contract ExitInstructionTest is SetupTest {
    ERC20Mock internal principalAsset;
    ERC20Mock internal collateralAsset;
    MockSwapAdapter internal adapter1;
    MockSwapAdapter internal adapter2;

    address internal borrowerEoa = address(0xB0B);
    address internal lenderEoa = address(0x1ED4E2);
    address internal runner = address(0xCA11E2);
    address internal borrowerVault;
    address internal lenderVault;

    uint256 internal constant LOAN = 1;
    uint256 internal constant PRINCIPAL = 1_000 ether;
    uint256 internal constant COLLATERAL = 2_000 ether;
    uint64 internal constant LEVEL = 1.2e18;
    uint8 internal constant CLOSE = 1;
    uint8 internal constant REDUCE = 2;

    function setUp() public {
        setupHelper();
        // The shared setup mocks the health factor and the LTV at fixed
        // figures; this suite needs the real ones, read from the prices.
        vm.clearMockedCalls();
        vm.warp(100 days);
        principalAsset = new ERC20Mock("Principal", "PRIN", 18);
        collateralAsset = new ERC20Mock("Collateral", "COLL", 18);
        borrowerVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrowerEoa);
        lenderVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lenderEoa);
        collateralAsset.mint(borrowerVault, COLLATERAL);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            borrowerEoa, address(collateralAsset), COLLATERAL
        );
        _price(address(principalAsset), 1e8);
        _price(address(collateralAsset), 1e8);
        adapter1 = new MockSwapAdapter("adapter1");
        adapter2 = new MockSwapAdapter("adapter2");
        principalAsset.mint(address(adapter1), 10_000 ether);
        principalAsset.mint(address(adapter2), 10_000 ether);
        AdminFacet(address(diamond)).addSwapAdapter(address(adapter1));
        AdminFacet(address(diamond)).addSwapAdapter(address(adapter2));
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    function _x() internal view returns (ExitInstructionFacet) {
        return ExitInstructionFacet(address(diamond));
    }

    function _price(address asset, uint256 price8) internal {
        vm.mockCall(
            LibTestPriceGuard.guardOf(address(diamond)),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, asset),
            abi.encode(price8, uint8(8))
        );
    }

    function _scaffold(bool allowsPartial) internal {
        TestMutatorFacet(address(diamond)).mintNFTRaw(lenderEoa, LOAN * 2 - 1);
        TestMutatorFacet(address(diamond)).mintNFTRaw(borrowerEoa, LOAN * 2);
        LibVaipakam.Loan memory loan;
        loan.id = LOAN;
        loan.principal = PRINCIPAL;
        loan.principalAsset = address(principalAsset);
        loan.collateralAmount = COLLATERAL;
        loan.collateralAsset = address(collateralAsset);
        loan.lender = lenderEoa;
        loan.borrower = borrowerEoa;
        loan.startTime = uint64(block.timestamp - 1 days);
        loan.durationDays = 30;
        loan.interestRateBps = 500;
        loan.lenderTokenId = uint128(LOAN * 2 - 1);
        loan.borrowerTokenId = uint128(LOAN * 2);
        loan.status = LibVaipakam.LoanStatus.Active;
        loan.assetType = LibVaipakam.AssetType.ERC20;
        loan.collateralAssetType = LibVaipakam.AssetType.ERC20;
        loan.allowsPartialRepay = allowsPartial;
        loan.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        loan.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        loan.initLtvCapBpsAtInit = 8000;
        loan.liquidationLtvBpsAtInit = 8500;
        TestMutatorFacet(address(diamond)).setLoan(LOAN, loan);
    }

    function _set(uint8 form, uint64 level, uint64 target, uint16 tol, bool fast) internal {
        vm.prank(borrowerEoa);
        _x().setExitInstruction(LOAN, ExitInstructionFacet.ExitInput(form, fast, tol, level, target));
    }

    /// @dev Drop the collateral to 0.68 and write two calm checkpoints there.
    function _fall() internal {
        _price(address(collateralAsset), 0.68e8);
        LibTestCalmPair.checkpoint(address(diamond), address(collateralAsset), address(principalAsset));
    }

    function _routes(uint256 idx) internal pure returns (LibSwap.AdapterCall[] memory c) {
        c = new LibSwap.AdapterCall[](1);
        c[0] = LibSwap.AdapterCall({adapterIdx: idx, data: ""});
    }

    function _hf() internal view returns (uint256) {
        return RiskFacet(address(diamond)).calculateHealthFactor(LOAN);
    }

    function _loan() internal view returns (LibVaipakam.Loan memory) {
        return LoanFacet(address(diamond)).getLoanDetails(LOAN);
    }

    // ─── 1, 14 — close: the loan ends Repaid, the caller gets nothing ──

    function test_1_close_repaysAndHoldsTheRest() public {
        _scaffold(false);
        _set(CLOSE, LEVEL, 0, 0, false);
        _fall();
        assertLt(_hf(), LEVEL);
        adapter1.setOutputMultiplierBps(6800);
        ExitInstructionFacet.ExitPreview memory pv = _x().previewExit(LOAN);
        assertTrue(pv.due, "due");
        assertEq(pv.toleranceBps, 100, "default tolerance 1%");
        assertEq(pv.calm, 0, "calm");

        uint256 runnerBefore = principalAsset.balanceOf(runner);
        uint256 lenderBefore = principalAsset.balanceOf(lenderVault);
        vm.prank(runner);
        _x().runExit(LOAN, _routes(1), type(uint64).max);

        LibVaipakam.Loan memory l = _loan();
        assertEq(uint256(l.status), uint256(LibVaipakam.LoanStatus.Repaid), "closed");
        assertEq(principalAsset.balanceOf(runner), runnerBefore, "caller receives nothing");
        assertEq(collateralAsset.balanceOf(runner), 0, "caller receives no collateral");
        assertGe(principalAsset.balanceOf(lenderVault) - lenderBefore, PRINCIPAL, "lender paid");
        // The unsold collateral is on the borrower claim, held for the position.
        (, uint256 held,,,,,,) = ClaimViewFacet(address(diamond)).getClaimable(LOAN, false);
        assertEq(held, COLLATERAL - pv.collateralToSell, "rest of the collateral held for the borrower position");
    }

    /// @dev 14 — a route that delivers exactly the floor succeeds; the holder's
    ///      cost is the tolerance and no more.
    function test_14_routeAtExactlyTheFloorSucceeds() public {
        _scaffold(false);
        _set(CLOSE, LEVEL, 0, 100, false);
        _fall();
        adapter1.setOutputMultiplierBps(6800 * 99 / 100);
        ExitInstructionFacet.ExitPreview memory pv = _x().previewExit(LOAN);
        vm.prank(runner);
        _x().runExit(LOAN, _routes(1), type(uint64).max);
        assertEq(uint256(_loan().status), uint256(LibVaipakam.LoanStatus.Repaid));
        assertGe(pv.minProceeds, pv.debtToPay, "the floor covers the debt");
    }

    // ─── 16 — over random prices and tolerances ──────────────────────

    /// @dev A close never sells more than the preview said, never pays the
    ///      caller, and pays the lender at least the debt the manual route
    ///      would have repaid at the same moment.
    function testFuzz_16_closeMatchesItsPreview(uint256 price8, uint16 tol) public {
        price8 = bound(price8, 0.56e8, 0.70e8);
        tol = uint16(bound(tol, 50, 300));
        _scaffold(false);
        _set(CLOSE, LEVEL, 0, tol, true);
        _price(address(collateralAsset), price8);
        if (_hf() >= LEVEL) return;
        ExitInstructionFacet.ExitPreview memory pv = _x().previewExit(LOAN);
        if (pv.skip != 0) return;
        (, , uint256 debtManual) = SwapToRepayFacet(address(diamond)).previewSwapToRepayFull(LOAN, COLLATERAL);
        adapter1.setOutputMultiplierBps(price8 * 10_000 / 1e8);
        uint256 lenderBefore = principalAsset.balanceOf(lenderVault);
        vm.prank(runner);
        _x().runExit(LOAN, _routes(1), type(uint64).max);
        assertEq(principalAsset.balanceOf(runner), 0, "caller paid nothing");
        assertEq(collateralAsset.balanceOf(runner), 0, "caller paid nothing");
        (, uint256 held,,,,,,) = ClaimViewFacet(address(diamond)).getClaimable(LOAN, false);
        assertEq(held, COLLATERAL - pv.collateralToSell, "sold exactly the previewed amount");
        assertGe(principalAsset.balanceOf(lenderVault) - lenderBefore + _treasuryCut(debtManual), debtManual - 1);
    }

    /// @dev The debt includes the treasury's share of the interest, which does
    ///      not reach the lender's vault; bound it by the interest itself.
    function _treasuryCut(uint256 debt) internal pure returns (uint256) {
        return debt - PRINCIPAL;
    }

    // ─── 2 — the same figures as the manual full route ───────────────

    function test_2_sameFiguresAsTheManualRoute() public {
        _scaffold(false);
        _set(CLOSE, LEVEL, 0, 300, false); // the manual cap
        _fall();
        adapter1.setOutputMultiplierBps(6800);
        (uint256 sellManual, uint256 floorManual, uint256 debtManual) =
            SwapToRepayFacet(address(diamond)).previewSwapToRepayFull(LOAN, COLLATERAL);
        ExitInstructionFacet.ExitPreview memory pv = _x().previewExit(LOAN);
        assertEq(pv.collateralToSell, sellManual, "sale size");
        assertEq(pv.minProceeds, floorManual, "floor");
        assertEq(pv.debtToPay, debtManual, "debt");
    }

    // ─── 3, 13 — not due ─────────────────────────────────────────────

    function test_3_healthAtOrAboveLevelReverts() public {
        _scaffold(false);
        _set(CLOSE, LEVEL, 0, 0, false);
        LibTestCalmPair.checkpoint(address(diamond), address(collateralAsset), address(principalAsset));
        vm.expectPartialRevert(ExitInstructionFacet.ExitHealthAtOrAboveLevel.selector);
        vm.prank(runner);
        _x().runExit(LOAN, _routes(1), type(uint64).max);
        assertFalse(_x().previewExit(LOAN).due);
    }

    function test_13_pastGraceReverts() public {
        _scaffold(false);
        _set(CLOSE, LEVEL, 0, 0, false);
        _price(address(collateralAsset), 0.68e8);
        vm.warp(vm.getBlockTimestamp() + 120 days);
        vm.expectRevert(abi.encodeWithSelector(ExitInstructionFacet.ExitWindowClosed.selector, LOAN));
        vm.prank(runner);
        _x().runExit(LOAN, _routes(1), type(uint64).max);
    }

    // ─── 4 — tolerance ───────────────────────────────────────────────

    function test_4_routeBelowFloorFailsOverAndAllFailingReverts() public {
        _scaffold(false);
        _set(CLOSE, LEVEL, 0, 100, false);
        _fall();
        adapter1.setOutputMultiplierBps(6700); // below 0.68 * 0.99
        adapter2.setOutputMultiplierBps(6800);
        LibSwap.AdapterCall[] memory two = new LibSwap.AdapterCall[](2);
        two[0] = LibSwap.AdapterCall({adapterIdx: 1, data: ""});
        two[1] = LibSwap.AdapterCall({adapterIdx: 2, data: ""});
        uint256 snap = vm.snapshotState();
        vm.prank(runner);
        _x().runExit(LOAN, two, type(uint64).max);
        assertEq(uint256(_loan().status), uint256(LibVaipakam.LoanStatus.Repaid), "second route wins");
        vm.revertToState(snap);

        adapter2.setOutputMultiplierBps(6700);
        vm.expectRevert(SwapToRepayFacet.SwapAllAdaptersFailed.selector);
        vm.prank(runner);
        _x().runExit(LOAN, two, type(uint64).max);
        assertEq(uint256(_loan().status), uint256(LibVaipakam.LoanStatus.Active), "nothing moved");
    }

    function test_4_toleranceBoundsAtSetting() public {
        _scaffold(false);
        vm.startPrank(borrowerEoa);
        vm.expectPartialRevert(ExitInstructionFacet.ExitToleranceOutOfBounds.selector);
        _x().setExitInstruction(LOAN, ExitInstructionFacet.ExitInput(CLOSE, false, 40, LEVEL, 0));
        vm.expectPartialRevert(ExitInstructionFacet.ExitToleranceOutOfBounds.selector);
        _x().setExitInstruction(LOAN, ExitInstructionFacet.ExitInput(CLOSE, false, 301, LEVEL, 0));
        vm.expectPartialRevert(ExitInstructionFacet.ExitLevelOutOfBounds.selector);
        _x().setExitInstruction(LOAN, ExitInstructionFacet.ExitInput(CLOSE, false, 0, 1.02e18, 0));
        vm.expectPartialRevert(ExitInstructionFacet.ExitLevelOutOfBounds.selector);
        _x().setExitInstruction(LOAN, ExitInstructionFacet.ExitInput(CLOSE, false, 0, 1.41e18, 0));
        _x().setExitInstruction(LOAN, ExitInstructionFacet.ExitInput(CLOSE, false, 0, LEVEL, 0));
        vm.stopPrank();
        assertEq(_x().getExitInstruction(LOAN).inForce.toleranceBps, 100, "default 1%");
    }

    // ─── 5, 17 — the calm wait ───────────────────────────────────────

    function test_5_notCalmAndMissingCheckpointSkip() public {
        _scaffold(false);
        _set(CLOSE, LEVEL, 0, 0, false);
        // No checkpoint at all.
        _price(address(collateralAsset), 0.68e8);
        vm.expectEmit(address(diamond));
        emit ExitInstructionFacet.StandingInstructionSkipped(
            LOAN, 4, LibStandingInstructions.SKIP_NO_CHECKPOINT, 0, runner
        );
        vm.prank(runner);
        _x().runExit(LOAN, _routes(1), type(uint64).max);

        // Checkpoints at 0.70, then the price moves to 0.68 (2.86%, past 2%).
        _price(address(collateralAsset), 0.70e8);
        LibTestCalmPair.checkpoint(address(diamond), address(collateralAsset), address(principalAsset));
        _price(address(collateralAsset), 0.68e8);
        vm.expectEmit(address(diamond));
        emit ExitInstructionFacet.StandingInstructionSkipped(LOAN, 4, LibStandingInstructions.SKIP_NOT_CALM, 0, runner);
        vm.prank(runner);
        _x().runExit(LOAN, _routes(1), type(uint64).max);
        assertEq(uint256(_loan().status), uint256(LibVaipakam.LoanStatus.Active), "nothing moved");

        // Once both checkpoints are at 0.68, it runs.
        LibTestCalmPair.checkpoint(address(diamond), address(collateralAsset), address(principalAsset));
        adapter1.setOutputMultiplierBps(6800);
        vm.prank(runner);
        _x().runExit(LOAN, _routes(1), type(uint64).max);
        assertEq(uint256(_loan().status), uint256(LibVaipakam.LoanStatus.Repaid));
    }

    function test_17_waitOffRunsInAMovingMarketAndRecordsIt() public {
        _scaffold(false);
        _set(CLOSE, LEVEL, 0, 0, true);
        _price(address(collateralAsset), 0.70e8);
        LibTestCalmPair.checkpoint(address(diamond), address(collateralAsset), address(principalAsset));
        _price(address(collateralAsset), 0.68e8);
        ExitInstructionFacet.ExitPreview memory pv = _x().previewExit(LOAN);
        assertTrue(pv.waitOff);
        assertEq(pv.calm, 2, "moving, as read");
        assertTrue(pv.due);
        adapter1.setOutputMultiplierBps(6800);
        vm.prank(runner);
        _x().runExit(LOAN, _routes(1), type(uint64).max);
        assertEq(uint256(_loan().status), uint256(LibVaipakam.LoanStatus.Repaid));
    }

    function test_17_waitOffWithNoCheckpointStatesNotKnown() public {
        _scaffold(false);
        _set(CLOSE, LEVEL, 0, 0, true);
        _price(address(collateralAsset), 0.68e8);
        assertEq(_x().previewExit(LOAN).calm, 1, "a checkpoint missing, as read");
        adapter1.setOutputMultiplierBps(6800);
        vm.prank(runner);
        _x().runExit(LOAN, _routes(1), type(uint64).max);
        assertEq(uint256(_loan().status), uint256(LibVaipakam.LoanStatus.Repaid));
    }

    function test_17_waitOffStillHoldsTheFloor() public {
        _scaffold(false);
        _set(CLOSE, LEVEL, 0, 100, true);
        _price(address(collateralAsset), 0.68e8);
        adapter1.setOutputMultiplierBps(6700);
        vm.expectRevert(SwapToRepayFacet.SwapAllAdaptersFailed.selector);
        vm.prank(runner);
        _x().runExit(LOAN, _routes(1), type(uint64).max);
    }

    // ─── 6 — the collateral cannot cover the debt at the floor ───────

    function test_6_cannotCoverSkips() public {
        _scaffold(false);
        _set(CLOSE, LEVEL, 0, 0, true);
        _price(address(collateralAsset), 0.40e8); // 800 of value against 1,000 debt
        vm.expectEmit(address(diamond));
        emit ExitInstructionFacet.StandingInstructionSkipped(
            LOAN, 4, LibStandingInstructions.SKIP_CANNOT_COVER, 0, runner
        );
        vm.prank(runner);
        _x().runExit(LOAN, _routes(1), type(uint64).max);
        assertEq(uint256(_loan().status), uint256(LibVaipakam.LoanStatus.Active));
    }

    // ─── 7 — reduce ──────────────────────────────────────────────────

    function test_7_reduceReachesTheHigherOfTargetAndCap() public {
        _scaffold(true);
        _set(REDUCE, LEVEL, 1.25e18, 0, false);
        _fall();
        ExitInstructionFacet.ExitPreview memory pv = _x().previewExit(LOAN);
        // The cap's health factor is 0.85 / 0.80 = 1.0625, below 1.25.
        assertFalse(pv.targetIsLtvCap, "the holder's target applies");
        assertEq(pv.form, REDUCE);
        adapter1.setOutputMultiplierBps(6800);
        uint256 hfBefore = _hf();
        vm.prank(runner);
        _x().runReduce(LOAN, _routes(1), type(uint64).max);
        LibVaipakam.Loan memory l = _loan();
        assertEq(uint256(l.status), uint256(LibVaipakam.LoanStatus.Active), "stays open");
        assertEq(l.collateralAmount, COLLATERAL - pv.collateralToSell, "sold the planned amount");
        assertGe(_hf(), 1.25e18, "target reached");
        assertGt(_hf(), hfBefore);

        // The interval applies between two reductions.
        vm.expectPartialRevert(ExitInstructionFacet.ExitReduceTooSoon.selector);
        vm.prank(runner);
        _x().runReduce(LOAN, _routes(1), type(uint64).max);
    }

    function test_7_reduceUsesTheCapWhenItIsHigher() public {
        _scaffold(true);
        // A lower opening cap, 70%: its health factor 0.85/0.70 = 1.214 sits
        // above a target of 1.21... the target must clear the level by the
        // margin, so use level 1.1 and target 1.15.
        TestMutatorFacet(address(diamond)).setLoan(LOAN, _withCap(7000));
        _set(REDUCE, 1.1e18, 1.15e18, 0, false);
        _price(address(collateralAsset), 0.64e8); // HF ~ 1.088
        LibTestCalmPair.checkpoint(address(diamond), address(collateralAsset), address(principalAsset));
        ExitInstructionFacet.ExitPreview memory pv = _x().previewExit(LOAN);
        assertTrue(pv.targetIsLtvCap, "the opening cap applies");
        adapter1.setOutputMultiplierBps(6400);
        vm.prank(runner);
        _x().runReduce(LOAN, _routes(1), type(uint64).max);
        assertLe(RiskFacet(address(diamond)).calculateLTV(LOAN), 7000, "back inside the opening cap");
    }

    /// @dev Whole-unit tokens: the route floors the oracle conversion and the
    ///      tolerance in token units, so the sale must be sized against those
    ///      rounded figures, not the continuous ones. A route that delivers
    ///      just its floor still ends back inside the opening cap.
    /// @dev A loan of 1,000 principal against 2,000 collateral, opening limit
    ///      `cap`, in tokens with `pDec` and `cDec` decimals.
    function _unitLoan(uint8 pDec, uint8 cDec, uint16 cap) internal {
        _unitLoanOf(pDec, cDec, cap, 1_000, 2_000);
    }

    function _unitLoanOf(uint8 pDec, uint8 cDec, uint16 cap, uint256 principal, uint256 collateral) internal {
        principalAsset = new ERC20Mock("PrincipalU", "PRINU", pDec);
        collateralAsset = new ERC20Mock("CollateralU", "COLLU", cDec);
        uint256 coll = collateral * 10 ** cDec;
        collateralAsset.mint(borrowerVault, coll);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            borrowerEoa, address(collateralAsset), coll
        );
        _price(address(principalAsset), 1e8);
        _price(address(collateralAsset), 1e8);
        principalAsset.mint(address(adapter1), 10_000 * 10 ** pDec);
        _scaffold(true);
        LibVaipakam.Loan memory l = _withCap(cap);
        l.principal = principal * 10 ** pDec;
        l.collateralAmount = coll;
        TestMutatorFacet(address(diamond)).setLoan(LOAN, l);
    }

    function _wholeUnitLoan(uint16 cap) internal {
        _unitLoan(0, 0, cap);
    }

    /// @dev Collateral with 18 decimals against principal with none: the
    ///      least sale is found however far the closed form falls short in
    ///      collateral units.
    function test_7_reduceSizesAcrossDecimals() public {
        _unitLoan(0, 18, 7000);
        _set(REDUCE, 1.1e18, 1.15e18, 100, false);
        _price(address(collateralAsset), 0.64e8);
        LibTestCalmPair.checkpoint(address(diamond), address(collateralAsset), address(principalAsset));
        ExitInstructionFacet.ExitPreview memory pv = _x().previewExit(LOAN);
        assertEq(pv.skip, 0, "due");
        assertEq(pv.form, REDUCE);
        // Pay 0.64 principal units per whole collateral token, less 1%.
        adapter1.setTokenPrice(address(collateralAsset), 64);
        adapter1.setTokenPrice(address(principalAsset), 100e18);
        adapter1.setOutputMultiplierBps(9900);
        vm.prank(runner);
        _x().runReduce(LOAN, _routes(1), type(uint64).max);
        assertLe(RiskFacet(address(diamond)).calculateLTV(LOAN), 7000, "back inside the opening cap");
    }

    /// @dev Whole units again, with the holder's target above the opening
    ///      limit's health factor: a route delivering about its floor still
    ///      reaches the target.
    function test_7_reduceReachesTheTargetInWholeUnits() public {
        _wholeUnitLoan(8000);
        _set(REDUCE, LEVEL, 1.25e18, 100, false);
        _fall();
        ExitInstructionFacet.ExitPreview memory pv = _x().previewExit(LOAN);
        assertEq(pv.skip, 0, "due");
        assertEq(pv.form, REDUCE);
        adapter1.setOutputMultiplierBps(6732);
        vm.prank(runner);
        _x().runReduce(LOAN, _routes(1), type(uint64).max);
        assertGe(_hf(), 1.25e18, "target reached");
    }

    /// @dev The rounded result is not monotone in the sale (here 12 reaches
    ///      the target, 13 does not, 14 does): the least is still found.
    function test_7_reduceFindsTheLeastSaleThoughRoundingIsNotMonotone() public {
        _unitLoanOf(0, 0, 8000, 11, 20);
        _set(REDUCE, LEVEL, 1.5e18, 100, false);
        _price(address(collateralAsset), 0.75e8);
        LibTestCalmPair.checkpoint(address(diamond), address(collateralAsset), address(principalAsset));
        ExitInstructionFacet.ExitPreview memory pv = _x().previewExit(LOAN);
        assertEq(pv.skip, 0, "due");
        assertEq(pv.form, REDUCE);
        assertEq(pv.collateralToSell, 12, "the least sale");
        adapter1.setOutputMultiplierBps(7425);
        vm.prank(runner);
        _x().runReduce(LOAN, _routes(1), type(uint64).max);
        assertGe(_hf(), 1.5e18, "target reached");
    }

    /// @dev Coarse units: the conservative bound asks for the whole debt, yet
    ///      a smaller sale reaches both bounds, so the loan stays open.
    function test_7_reduceStaysPartialWhenTheBoundAsksForAll() public {
        _unitLoanOf(0, 0, 8000, 7, 7);
        _price(address(collateralAsset), 2e8);
        _set(REDUCE, 1.4e18, 1.5e18, 100, false);
        _price(address(collateralAsset), 1.5e8);
        LibTestCalmPair.checkpoint(address(diamond), address(collateralAsset), address(principalAsset));
        ExitInstructionFacet.ExitPreview memory pv = _x().previewExit(LOAN);
        assertEq(pv.skip, 0, "due");
        assertEq(pv.form, REDUCE, "stays a reduction");
        assertEq(pv.collateralToSell, 4, "the least sale");
    }

    /// @dev An opening limit at or above the keep (no per-asset ceiling)
    ///      does not stop a reduction the target can reach.
    function test_7_reduceRunsUnderANonbindingCap() public {
        _unitLoan(18, 18, 10_000);
        _set(REDUCE, LEVEL, 1.3e18, 100, false);
        _fall();
        ExitInstructionFacet.ExitPreview memory pv = _x().previewExit(LOAN);
        assertEq(pv.skip, 0, "due");
        assertEq(pv.form, REDUCE);
        adapter1.setTokenPrice(address(collateralAsset), 68);
        adapter1.setTokenPrice(address(principalAsset), 100);
        adapter1.setOutputMultiplierBps(9900);
        vm.prank(runner);
        _x().runReduce(LOAN, _routes(1), type(uint64).max);
        assertGe(_hf(), 1.3e18, "target reached");
    }

    /// @dev One coarse collateral unit: no partial sale exists, so the
    ///      reduction closes the loan rather than skipping.
    function test_7_reduceClosesWhenNoPartialSaleExists() public {
        _unitLoanOf(0, 0, 8000, 1_000, 1);
        _price(address(collateralAsset), 1_600e8);
        _set(REDUCE, LEVEL, 1.3e18, 100, false);
        _price(address(collateralAsset), 1_400e8);
        LibTestCalmPair.checkpoint(address(diamond), address(collateralAsset), address(principalAsset));
        ExitInstructionFacet.ExitPreview memory pv = _x().previewExit(LOAN);
        assertEq(pv.skip, 0, "due");
        assertEq(pv.form, CLOSE, "closes instead");
        adapter1.setTokenPrice(address(collateralAsset), 1_400);
        adapter1.setTokenPrice(address(principalAsset), 1);
        adapter1.setOutputMultiplierBps(9900);
        vm.prank(runner);
        _x().runReduce(LOAN, _routes(1), type(uint64).max);
        assertEq(uint256(_loan().status), uint256(LibVaipakam.LoanStatus.Repaid), "closed");
    }

    function test_7_reduceHoldsTheCapInWholeUnits() public {
        _wholeUnitLoan(7000);
        _set(REDUCE, 1.1e18, 1.15e18, 100, false);
        _price(address(collateralAsset), 0.64e8);
        LibTestCalmPair.checkpoint(address(diamond), address(collateralAsset), address(principalAsset));
        ExitInstructionFacet.ExitPreview memory pv = _x().previewExit(LOAN);
        assertEq(pv.skip, 0, "due");
        assertEq(pv.form, REDUCE);
        // Deliver 0.64 x 0.99 per unit: the floor, give or take one unit.
        adapter1.setOutputMultiplierBps(6336);
        vm.prank(runner);
        _x().runReduce(LOAN, _routes(1), type(uint64).max);
        assertLe(RiskFacet(address(diamond)).calculateLTV(LOAN), 7000, "back inside the opening cap");
    }

    function test_7_reduceRefusedWithoutPartialRepay() public {
        _scaffold(false);
        vm.expectRevert(abi.encodeWithSelector(ExitInstructionFacet.ExitInstructionNotOffered.selector, LOAN));
        _set(REDUCE, LEVEL, 1.3e18, 0, false);
    }

    function test_7_reduceThatRetiresAllPrincipalCloses() public {
        _scaffold(true);
        // Smallest partial = 99% of the principal: the reduction would retire
        // all of it, so it closes instead.
        TestMutatorFacet(address(diamond)).setMinPartialBpsRaw(address(principalAsset), 9900);
        _set(REDUCE, LEVEL, 1.3e18, 0, false);
        _fall();
        ExitInstructionFacet.ExitPreview memory pv = _x().previewExit(LOAN);
        assertEq(pv.form, CLOSE, "becomes a close");
        adapter1.setOutputMultiplierBps(6800);
        vm.prank(runner);
        _x().runReduce(LOAN, _routes(1), type(uint64).max);
        assertEq(uint256(_loan().status), uint256(LibVaipakam.LoanStatus.Repaid));
    }

    function _withCap(uint16 cap) internal view returns (LibVaipakam.Loan memory l) {
        l = _loan();
        l.initLtvCapBpsAtInit = cap;
    }

    // ─── 8 — with the collateral top-up ──────────────────────────────

    function test_8_levelMustSitBelowTheTopUp() public {
        _scaffold(false);
        vm.prank(borrowerEoa);
        StandingInstructionFacet(address(diamond)).setStandingInstructions(
            LOAN, StandingInstructionFacet.InstructionInput(1.22e18, 1.5e18, false, false, 0)
        );
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.ExitLevelNotBelowTopUp.selector, LEVEL, uint64(1.22e18))
        );
        _set(CLOSE, LEVEL, 0, 0, false);
        _set(CLOSE, 1.15e18, 0, 0, false);
        // And the other way: a top-up trigger too close above the exit level.
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.ExitLevelNotBelowTopUp.selector, uint64(1.15e18), uint64(1.18e18))
        );
        vm.prank(borrowerEoa);
        StandingInstructionFacet(address(diamond)).setStandingInstructions(
            LOAN, StandingInstructionFacet.InstructionInput(1.18e18, 1.5e18, false, false, 0)
        );
    }

    // ─── 9 — setting below the level ─────────────────────────────────

    function test_9_settingWhileBelowTheLevelIsRefused() public {
        _scaffold(false);
        _price(address(collateralAsset), 0.68e8);
        vm.expectPartialRevert(ExitInstructionFacet.ExitLevelAboveHealth.selector);
        _set(CLOSE, LEVEL, 0, 0, false);
    }

    // ─── 10 — the instruction follows the wallet ─────────────────────

    function test_10_positionTransferSkipsTheOldHoldersInstruction() public {
        _scaffold(false);
        _set(CLOSE, LEVEL, 0, 0, false);
        _fall();
        LibTestPositionNFT.move(address(diamond), LOAN * 2, address(0xD00D));
        vm.expectEmit(address(diamond));
        emit ExitInstructionFacet.StandingInstructionSkipped(
            LOAN, 4, LibStandingInstructions.SKIP_HOLDER_CHANGED, 0, runner
        );
        vm.prank(runner);
        _x().runExit(LOAN, _routes(1), type(uint64).max);
        assertFalse(_x().getExitInstruction(LOAN).ownerHoldsPosition);
    }

    // ─── 11 — protected accounts: loosening waits, tightening does not ─

    /// @dev Protected mode as the borrower's vault reports it (the vault is
    ///      the only writer of that record), with a one-day delay.
    function _protect() internal {
        vm.mockCall(
            borrowerVault,
            abi.encodeWithSignature("protectionCore()"),
            abi.encode(true, false, uint32(1 days), borrowerEoa, false)
        );
        vm.mockCall(borrowerVault, abi.encodeWithSignature("protectionLockCount()"), abi.encode(uint64(0)));
    }

    function test_11_protectedLooseningWaitsTighteningIsImmediate() public {
        _scaffold(true);
        _protect();
        // Setting from nothing waits.
        _set(CLOSE, LEVEL, 0, 100, false);
        ExitInstructionFacet.ExitInstructionView memory v = _x().getExitInstruction(LOAN);
        assertEq(v.inForce.form, 0, "nothing in force yet");
        assertEq(v.record.pendingAt, uint64(vm.getBlockTimestamp() + 1 days), "waits the delay");
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertEq(_x().getExitInstruction(LOAN).inForce.levelHf, LEVEL, "in force once the wait ends");

        // Each loosening waits, and the old settings stay in force meanwhile.
        ExitInstructionFacet.ExitInput[5] memory loosen = [
            ExitInstructionFacet.ExitInput(CLOSE, false, 100, 1.25e18, 0), // higher level
            ExitInstructionFacet.ExitInput(CLOSE, false, 200, LEVEL, 0), // looser tolerance
            ExitInstructionFacet.ExitInput(CLOSE, true, 100, LEVEL, 0), // fast market on
            ExitInstructionFacet.ExitInput(REDUCE, false, 100, LEVEL, 1.3e18), // another form
            ExitInstructionFacet.ExitInput(CLOSE, false, 100, LEVEL, 0) // placeholder, replaced below
        ];
        for (uint256 i; i < 4; ++i) {
            vm.prank(borrowerEoa);
            _x().setExitInstruction(LOAN, loosen[i]);
            v = _x().getExitInstruction(LOAN);
            assertGt(v.record.pendingAt, 0, "loosening waits");
            assertEq(v.inForce.levelHf, LEVEL, "old level in force");
            assertEq(v.inForce.toleranceBps, 100, "old tolerance in force");
            assertFalse(v.inForce.actInFastMarket, "calm wait still in force");
            assertEq(v.inForce.form, CLOSE, "old form in force");
        }

        // A tightening is immediate and drops the waiting change.
        _set(CLOSE, 1.15e18, 0, 80, false);
        v = _x().getExitInstruction(LOAN);
        assertEq(v.record.pendingAt, 0, "nothing waits");
        assertEq(v.inForce.levelHf, 1.15e18, "lower level now");
        assertEq(v.inForce.toleranceBps, 80, "tighter tolerance now");

        // Raising a reduction's target waits; lowering it does not.
        vm.warp(vm.getBlockTimestamp() + 1);
        _set(REDUCE, 1.15e18, 1.3e18, 80, false);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        _set(REDUCE, 1.15e18, 1.4e18, 80, false);
        assertGt(_x().getExitInstruction(LOAN).record.pendingAt, 0, "higher target waits");
        _set(REDUCE, 1.15e18, 1.25e18, 80, false);
        assertEq(_x().getExitInstruction(LOAN).record.pendingAt, 0, "lower target is immediate");

        // Clearing is immediate.
        vm.prank(borrowerEoa);
        _x().clearExitInstruction(LOAN);
        assertEq(_x().getExitInstruction(LOAN).inForce.form, 0);
    }

    function test_11_lockedAccountFreezesIt() public {
        _scaffold(false);
        _set(CLOSE, LEVEL, 0, 0, false);
        _fall();
        vm.mockCall(
            borrowerVault,
            abi.encodeWithSignature("protectionCore()"),
            abi.encode(true, true, uint32(1 days), borrowerEoa, false)
        );
        vm.mockCall(borrowerVault, abi.encodeWithSignature("protectionLockCount()"), abi.encode(uint64(1)));
        vm.expectEmit(address(diamond));
        emit ExitInstructionFacet.StandingInstructionSkipped(
            LOAN, 4, LibStandingInstructions.SKIP_ACCOUNT_LOCKED, 0, runner
        );
        vm.prank(runner);
        _x().runExit(LOAN, _routes(1), type(uint64).max);
    }

    // ─── 12 — a flagged holder ───────────────────────────────────────

    function test_12_flaggedHolderCannotSetButASetOneRuns() public {
        _scaffold(false);
        _set(CLOSE, LEVEL, 0, 0, false);
        MockSanctionsList list = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(list));
        list.setFlagged(borrowerEoa, true);
        vm.expectPartialRevert(LibVaipakam.SanctionedAddress.selector);
        _set(CLOSE, 1.15e18, 0, 0, false);
        _fall();
        adapter1.setOutputMultiplierBps(6800);
        vm.prank(runner);
        _x().runExit(LOAN, _routes(1), type(uint64).max);
        assertEq(uint256(_loan().status), uint256(LibVaipakam.LoanStatus.Repaid), "the lender is made whole");
    }

    function test_12_flaggedHoldersReductionRuns() public {
        _scaffold(true);
        _set(REDUCE, LEVEL, 1.25e18, 0, false);
        MockSanctionsList list = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(list));
        list.setFlagged(borrowerEoa, true);
        _fall();
        adapter1.setOutputMultiplierBps(6800);
        uint256 hfBefore = _hf();
        vm.prank(runner);
        _x().runReduce(LOAN, _routes(1), type(uint64).max);
        assertEq(uint256(_loan().status), uint256(LibVaipakam.LoanStatus.Active), "stays open");
        assertGt(_hf(), hfBefore, "the reduction ran");
    }

    // ─── 15 — a busy loan ────────────────────────────────────────────

    function test_15_busyLoanSkips() public {
        _scaffold(false);
        _set(CLOSE, LEVEL, 0, 0, false);
        _fall();
        TestMutatorFacet(address(diamond)).setLoanToOffsetOfferIdRaw(LOAN, 77);
        vm.expectEmit(address(diamond));
        emit ExitInstructionFacet.StandingInstructionSkipped(
            LOAN, 4, LibStandingInstructions.SKIP_LOAN_BUSY, 0, runner
        );
        vm.prank(runner);
        _x().runExit(LOAN, _routes(1), type(uint64).max);
    }

    // ─── The instruction entries are the Diamond's own ───────────────

    function test_instructionEntriesAreDiamondOnly() public {
        _scaffold(true);
        vm.expectRevert(SwapToRepayFacet.OnlyDiamondInternal.selector);
        SwapToRepayFacet(address(diamond)).swapToRepayFullByInstruction(
            LOAN, borrowerEoa, _routes(1), 100, type(uint64).max
        );
        vm.expectRevert(SwapToRepayPartialFacet.OnlyDiamondInternal.selector);
        SwapToRepayPartialFacet(address(diamond)).swapToRepayPartialByInstruction(
            LOAN, borrowerEoa, 1 ether, _routes(1), 100, type(uint64).max
        );
    }

    function test_clearIsImmediate() public {
        _scaffold(false);
        _set(CLOSE, LEVEL, 0, 0, false);
        vm.prank(borrowerEoa);
        _x().clearExitInstruction(LOAN);
        _fall();
        vm.expectRevert(abi.encodeWithSelector(ExitInstructionFacet.ExitInstructionNotSet.selector, LOAN, CLOSE));
        vm.prank(runner);
        _x().runExit(LOAN, _routes(1), type(uint64).max);
    }
}
