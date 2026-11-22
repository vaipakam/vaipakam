// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CustodyInvariantBase} from "./invariants/CustodyInvariantBase.sol";
import {LibTestFallbackGate} from "./helpers/LibTestFallbackGate.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {liquidationQuote} from "./helpers/ForcedSaleQuote.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {LibFallbackEnd} from "../src/libraries/LibFallbackEnd.sol";
import {LibFallbackCustody} from "../src/libraries/LibFallbackCustody.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {ClaimViewFacet} from "../src/facets/ClaimViewFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {FallbackCustodyFacet} from "../src/facets/FallbackCustodyFacet.sol";
import {SettlementLegFacet} from "../src/facets/SettlementLegFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LegalFacet} from "../src/facets/LegalFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/**
 * @title  FallbackDatedEndTest
 * @notice #3865 — the dated end of a loan left in the fallback state. After a
 *         governed wait (30 days by default, bounded 14 to 90) counted from
 *         the entry on the loan clock, anyone may finish the loan in kind
 *         (`FallbackCustodyFacet.finishFallbackInKind`): the recorded split as
 *         it stands, the loan Defaulted, each side's part waiting for its own
 *         claim. Nothing is sold, matched or priced, and the caller is paid
 *         nothing.
 * @dev    Cells D1-D11 follow §9 of the design (tests 1-11); D12 is the
 *         legacy-row refusal and D13 the setting's bounds. Every fixture
 *         drives the real producer (an HF liquidation through the harness's
 *         permanently reverting venue), as {FallbackCustodyTest} does.
 */
contract FallbackDatedEndTest is CustodyInvariantBase {
    uint256 internal constant DE_HF_HEALTHY = 2e18;
    uint256 internal constant DE_HF_LIQUIDATABLE = 0.9e18;
    uint256 internal constant DE_LTV_HEALTHY = 5_000;
    uint256 internal constant DE_LTV_LIQUIDATABLE = 9_600;
    uint256 internal constant DE_LOAN_DAYS = 30;
    uint256 internal constant DE_RATE_BPS = 1_000;
    uint256 internal constant DE_PRINCIPAL = 1_000e18;
    uint256 internal constant DE_COLLATERAL = 2_000e18;
    uint256 internal constant DE_WAIT = 30 days;

    event FallbackEndScheduled(uint256 indexed loanId, uint256 enteredAt, uint256 waitSeconds);
    event FallbackFinishedInKind(
        uint256 indexed loanId, uint256 lenderPart, uint256 treasuryPart, uint256 borrowerPart, address indexed caller
    );

    address internal deLender;
    address internal deLender2;
    address internal deBorrower;
    uint256 internal deBorrowerPk;
    address internal deBorrower2;
    uint256 internal deBorrower2Pk;
    address internal stranger;

    function setUp() public {
        _deployCustodyHarness();
        deLender = custodyLenders[0];
        deLender2 = custodyLenders[1];
        deBorrower = custodyBorrowers[0];
        deBorrowerPk = custodyBorrowerPks[0];
        deBorrower2 = custodyBorrowers[1];
        deBorrower2Pk = custodyBorrowerPks[1];
        stranger = makeAddr("datedEndStranger");
    }

    // =====================================================================
    //  D1-D2: the date, and the step at it
    // =====================================================================

    /// @notice D1. The entry records the date (entry + 30 days) and the step
    ///         is refused one second before it, by name.
    function test_D1_entryRecordsTheDate_refusedBeforeIt() public {
        uint256 id = _forward(weth);
        uint256 t0 = block.timestamp;
        vm.recordLogs();
        _liquidateToFallback(id);
        uint256 entered = _scheduledAt(vm.getRecordedLogs(), id);
        assertEq(entered, block.timestamp, "the entry emitted FallbackEndScheduled at the entry time");

        (uint256 e, uint256 w, uint256 endAt, bool finishable) = _end(id);
        assertGe(e, t0, "fixture-live: entered now");
        assertEq(w, DE_WAIT, "the default wait is recorded");
        assertEq(endAt, e + DE_WAIT, "the date is entry + wait");
        assertFalse(finishable, "not finishable before the date");

        vm.warp(endAt - 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(FallbackCustodyFacet.FallbackEndNotReached.selector, id, endAt));
        FallbackCustodyFacet(address(diamond)).finishFallbackInKind(id);

        vm.warp(endAt);
        (,,, finishable) = _end(id);
        assertTrue(finishable, "straddle: finishable at the date");
    }

    /// @notice D2. A stranger finishes the loan at its date. Each side ends up
    ///         with exactly what the lender's claim without a route leaves it:
    ///         the lender's slice, the treasury's slice, the borrower's slice.
    ///         The caller is paid nothing, nothing passes through the Diamond.
    function test_D2_strangerFinishesAtTheDate_sameOutcomeAsTheClaimWithoutRoute() public {
        uint256 id = _forward(weth);
        _liquidateToFallback(id);
        (uint256 l, uint256 t, uint256 b) = _slices(id);
        assertGt(l, 0, "fixture-live: a lender slice");
        assertGt(t, 0, "fixture-live: a treasury slice");
        assertGt(b, 0, "fixture-live: a borrower slice");
        (,, uint256 endAt,) = _end(id);
        vm.warp(endAt);

        // The reference: the lender's claim without a route.
        uint256 snap = vm.snapshotState();
        uint256 refLender0 = _owned(deLender, weth);
        uint256 refTreasury0 = IERC20(weth).balanceOf(treasuryEOA);
        vm.prank(deLender);
        ClaimFacet(address(diamond)).claimAsLender(id);
        uint256 refLender = _owned(deLender, weth) - refLender0;
        uint256 refTreasury = IERC20(weth).balanceOf(treasuryEOA) - refTreasury0;
        (address refAsset, uint256 refBorrowerOwed,) =
            ClaimViewFacet(address(diamond)).getClaimableAmount(id, false);
        LibVaipakam.LoanStatus refStatus = _status(id);
        vm.revertToState(snap);

        uint256 lender0 = _owned(deLender, weth);
        uint256 treasury0 = IERC20(weth).balanceOf(treasuryEOA);
        uint256 stranger0 = _owned(stranger, weth);
        uint256 diamond0 = IERC20(weth).balanceOf(address(diamond));
        vm.expectEmit(true, true, false, true, address(diamond));
        emit FallbackFinishedInKind(id, l, t, b, stranger);
        vm.prank(stranger);
        FallbackCustodyFacet(address(diamond)).finishFallbackInKind(id);

        assertEq(uint8(_status(id)), uint8(LibVaipakam.LoanStatus.Defaulted), "the loan is Defaulted");
        assertEq(uint8(refStatus), uint8(LibVaipakam.LoanStatus.Defaulted), "as the claim leaves it");
        assertEq(IERC20(weth).balanceOf(treasuryEOA) - treasury0, refTreasury, "the treasury got what the claim gives it");
        assertEq(refTreasury, t, "which is the treasury slice");
        assertEq(_owned(stranger, weth), stranger0, "the caller is paid nothing");
        assertEq(IERC20(weth).balanceOf(address(diamond)), diamond0, "the Diamond is never a waypoint");
        assertEq(_owned(deLender, weth), lender0, "no wallet is paid by the step");
        assertEq(_row(id), 0, "the custody row is spent");
        assertEq(_lien(id), b, "the lien is exactly the borrower slice");
        (address asset, uint256 owed,) = ClaimViewFacet(address(diamond)).getClaimableAmount(id, false);
        assertEq(asset, refAsset, "the borrower is owed the same asset");
        assertEq(owed, refBorrowerOwed, "and the same amount as after the claim");
        assertEq(owed, b, "which is the borrower slice");
        (uint256 e2,, uint256 end2, bool fin2) = _end(id);
        assertEq(e2 + end2, 0, "a finished loan reports no date");
        assertFalse(fin2, "and is not finishable");

        // Each holder then claims as usual.
        vm.prank(deLender);
        ClaimFacet(address(diamond)).claimAsLender(id);
        assertEq(_owned(deLender, weth) - lender0, refLender, "the lender's claim pays what the claim alone paid");
        assertEq(refLender, l, "which is the lender slice");
        uint256 b0 = _owned(deBorrower, weth);
        vm.prank(deBorrower);
        ClaimFacet(address(diamond)).claimAsBorrower(id);
        assertEq(_owned(deBorrower, weth) - b0, b, "the borrower's claim pays the borrower slice");
        assertEq(_lien(id), 0, "and releases the lien");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(FallbackCustodyFacet.FallbackNotFinishable.selector, id));
        FallbackCustodyFacet(address(diamond)).finishFallbackInKind(id);
    }

    // =====================================================================
    //  D3-D5: what moves the date and what does not
    // =====================================================================

    /// @notice D3. A cure ends the count; a later entry records a new date.
    function test_D3_cureEndsTheCount_laterEntryRecordsANewDate() public {
        uint256 id = _forward(weth);
        _liquidateToFallback(id);
        (uint256 e1,, uint256 end1,) = _end(id);
        assertGt(end1, 0, "fixture-live: a date");

        vm.warp(block.timestamp + 5 days);
        _setRisk(id, DE_HF_HEALTHY, DE_LTV_HEALTHY);
        _topUp(id, 50e18);
        assertEq(uint8(_status(id)), uint8(LibVaipakam.LoanStatus.Active), "fixture-live: the top-up cured");
        (uint256 e0, uint256 w0, uint256 end0, bool f0) = _end(id);
        assertEq(e0 + w0 + end0, 0, "a cured loan reports no date, though its record remains");
        assertFalse(f0, "and is not finishable");
        vm.warp(end1);
        vm.expectRevert(abi.encodeWithSelector(FallbackCustodyFacet.FallbackNotFinishable.selector, id));
        FallbackCustodyFacet(address(diamond)).finishFallbackInKind(id);

        _liquidateToFallback(id);
        (uint256 e2, uint256 w2, uint256 end2,) = _end(id);
        assertEq(e2, block.timestamp, "the new entry is now");
        assertGt(e2, e1, "a new episode");
        assertEq(w2, DE_WAIT, "with the wait in force");
        assertEq(end2, e2 + DE_WAIT, "a new date from the new entry");
        vm.expectRevert(abi.encodeWithSelector(FallbackCustodyFacet.FallbackEndNotReached.selector, id, end2));
        FallbackCustodyFacet(address(diamond)).finishFallbackInKind(id);
    }

    /// @notice D4. A top-up that does not cure leaves the date where it was,
    ///         and the step folds it into the borrower's claim with the
    ///         borrower slice.
    function test_D4_nonCuringTopUp_dateUnchanged_landsInTheBorrowerClaim() public {
        uint256 id = _forward(weth);
        _liquidateToFallback(id);
        (uint256 e1, uint256 w1, uint256 end1,) = _end(id);
        vm.warp(block.timestamp + 5 days);
        uint256 topUp = 10e18;
        _topUp(id, topUp);
        assertEq(
            uint8(_status(id)), uint8(LibVaipakam.LoanStatus.FallbackPending), "fixture-live: still FallbackPending"
        );
        (uint256 e2, uint256 w2, uint256 end2,) = _end(id);
        assertEq(e2, e1, "the entry is unchanged");
        assertEq(w2, w1, "so is the wait");
        assertEq(end2, end1, "so is the date");

        (,, uint256 b) = _slices(id);
        vm.warp(end1);
        vm.prank(stranger);
        FallbackCustodyFacet(address(diamond)).finishFallbackInKind(id);
        (address asset, uint256 owed,) = ClaimViewFacet(address(diamond)).getClaimableAmount(id, false);
        assertEq(asset, weth, "the borrower is owed collateral");
        assertEq(owed, b + topUp, "the borrower slice plus the top-up");
        assertEq(_lien(id), b + topUp, "both still under the lien");
    }

    /// @notice D5. Paused time does not run: the date moves later by the
    ///         pause, and the step is refused while paused.
    function test_D5_pausedTimeIsNotCounted() public {
        uint256 id = _forward(weth);
        _liquidateToFallback(id);
        (uint256 e,, uint256 end1,) = _end(id);

        vm.warp(e + 5 days);
        AdminFacet(address(diamond)).pause();
        vm.warp(e + 8 days);
        (,, uint256 endPaused, bool finPaused) = _end(id);
        assertEq(endPaused, end1 + 3 days, "the open pause already moves the date");
        assertFalse(finPaused, "not finishable while paused");
        AdminFacet(address(diamond)).unpause();
        (,, uint256 end2,) = _end(id);
        assertEq(end2, end1 + 3 days, "the date moved by exactly the pause");

        vm.warp(end1);
        vm.expectRevert(abi.encodeWithSelector(FallbackCustodyFacet.FallbackEndNotReached.selector, id, end2));
        FallbackCustodyFacet(address(diamond)).finishFallbackInKind(id);

        vm.warp(end2);
        AdminFacet(address(diamond)).pause();
        vm.prank(stranger);
        vm.expectRevert();
        FallbackCustodyFacet(address(diamond)).finishFallbackInKind(id);
        AdminFacet(address(diamond)).unpause();
        (,, uint256 end3,) = _end(id);
        vm.warp(end3);
        vm.prank(stranger);
        FallbackCustodyFacet(address(diamond)).finishFallbackInKind(id);
        assertEq(uint8(_status(id)), uint8(LibVaipakam.LoanStatus.Defaulted), "straddle: finished once unpaused");
    }

    // =====================================================================
    //  D6-D7: a flagged holder and a refusing token never block the step
    // =====================================================================

    /// @notice D6. A flagged lender does not block the step. Its part waits
    ///         in its own vault; its claim is refused while flagged and pays
    ///         once the flag clears. The borrower's side is not held up.
    function test_D6_flaggedLender_doesNotBlock_partWaitsForTheClaim() public {
        uint256 id = _forward(weth);
        _liquidateToFallback(id);
        (uint256 l,, uint256 b) = _slices(id);
        (,, uint256 endAt,) = _end(id);
        vm.warp(endAt);
        sanctionsList.setFlagged(deLender, true);

        uint256 lVault0 = IERC20(weth).balanceOf(_vault(deLender));
        vm.prank(stranger);
        FallbackCustodyFacet(address(diamond)).finishFallbackInKind(id);
        assertEq(uint8(_status(id)), uint8(LibVaipakam.LoanStatus.Defaulted), "the step ran");
        assertEq(IERC20(weth).balanceOf(_vault(deLender)) - lVault0, l, "the lender slice is in the lender's vault");

        vm.prank(deLender);
        vm.expectRevert(abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, deLender));
        ClaimFacet(address(diamond)).claimAsLender(id);

        uint256 b0 = _owned(deBorrower, weth);
        vm.prank(deBorrower);
        ClaimFacet(address(diamond)).claimAsBorrower(id);
        assertEq(_owned(deBorrower, weth) - b0, b, "the borrower is not held up");

        sanctionsList.setFlagged(deLender, false);
        uint256 lender0 = _owned(deLender, weth);
        vm.prank(deLender);
        ClaimFacet(address(diamond)).claimAsLender(id);
        assertEq(_owned(deLender, weth) - lender0, l, "straddle: unflagged, the claim pays the slice");
    }

    /// @notice D7. A token that refuses the lender side's vault is parked,
    ///         and the step completes. The lender's claim later releases the
    ///         park and pays the slice.
    function test_D7_refusingToken_isParked_stepCompletes() public {
        uint256 id = _forward(weth);
        _liquidateToFallback(id);
        (uint256 l, uint256 t, uint256 b) = _slices(id);
        (,, uint256 endAt,) = _end(id);
        vm.warp(endAt);
        address lVault = _vault(deLender);
        address bVault = _vault(deBorrower);
        vm.mockCallRevert(weth, abi.encodeWithSelector(IERC20.transfer.selector, lVault, l), bytes("refused"));

        uint256 bVault0 = IERC20(weth).balanceOf(bVault);
        uint256 lVault0 = IERC20(weth).balanceOf(lVault);
        vm.prank(stranger);
        FallbackCustodyFacet(address(diamond)).finishFallbackInKind(id);
        assertEq(uint8(_status(id)), uint8(LibVaipakam.LoanStatus.Defaulted), "the step completed");
        assertEq(IERC20(weth).balanceOf(lVault), lVault0, "nothing reached the lender's vault");
        LibVaipakam.ParkedLeg memory p = _parked(id);
        assertEq(p.payer, deBorrower, "the slice is parked in the borrower's vault");
        assertEq(p.asset, weth, "in the collateral");
        assertEq(p.amount, l, "for exactly the lender slice");
        assertEq(bVault0 - IERC20(weth).balanceOf(bVault), t, "only the treasury slice left the borrower's vault");
        assertEq(_row(id), 0, "the custody row is spent");
        assertEq(_lien(id), b, "the lien is the borrower slice; the park is its own encumbrance");

        vm.clearMockedCalls();
        uint256 lender0 = _owned(deLender, weth);
        vm.prank(deLender);
        ClaimFacet(address(diamond)).claimAsLender(id);
        assertEq(_owned(deLender, weth) - lender0, l, "the claim releases the park and pays the slice");
    }

    // =====================================================================
    //  D8-D11: the setting, the backstop request, a closing network, a match
    // =====================================================================

    /// @notice D8. A change of the setting never moves a date already
    ///         running; the next entry takes the new wait.
    function test_D8_settingChange_doesNotMoveARecordedDate() public {
        uint256 id = _forward(weth);
        _liquidateToFallback(id);
        (, uint256 w1, uint256 end1,) = _end(id);
        FallbackCustodyFacet(address(diamond)).setFallbackEndWaitDays(60);
        assertEq(FallbackCustodyFacet(address(diamond)).getFallbackEndWaitDays(), 60, "the setting changed");
        (, uint256 w2, uint256 end2,) = _end(id);
        assertEq(w2, w1, "the recorded wait is unchanged");
        assertEq(end2, end1, "so is the date");

        uint256 id2 = _open(deLender2, deBorrower2, deBorrower2Pk, usdc, DE_PRINCIPAL, weth, DE_COLLATERAL);
        _liquidateToFallback(id2);
        (uint256 e3, uint256 w3, uint256 end3,) = _end(id2);
        assertEq(w3, 60 days, "a new entry takes the new wait");
        assertEq(end3, e3 + 60 days, "and its date follows it");
    }

    /// @notice D9. The lender's backstop request lapses with the step.
    function test_D9_backstopOptIn_isVoidAfterTheStep() public {
        uint256 id = _forward(weth);
        _liquidateToFallback(id);
        vm.prank(deLender);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(id, true);
        (,, uint256 endAt,) = _end(id);
        vm.warp(endAt);
        vm.prank(stranger);
        FallbackCustodyFacet(address(diamond)).finishFallbackInKind(id);
        // No getter reads the request; the via-backstop claim is refused.
        vm.expectRevert();
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(id, _route(true));
    }

    /// @notice D10. The step stays open on a closing network.
    function test_D10_openOnAClosingNetwork() public {
        uint256 id = _forward(weth);
        _liquidateToFallback(id);
        LegalFacet(address(diamond)).setNetworkClosing(true);
        (,, uint256 endAt,) = _end(id);
        vm.warp(endAt);
        vm.prank(stranger);
        FallbackCustodyFacet(address(diamond)).finishFallbackInKind(id);
        assertEq(uint8(_status(id)), uint8(LibVaipakam.LoanStatus.Defaulted), "finished while closing");
    }

    /// @notice D11. A part internal match never moves the date, and the step
    ///         applies the split as the match left it.
    function test_D11_partInternalMatch_dateUnchanged_stepAppliesTheScaledSplit() public {
        uint256 a = _forward(weth);
        _liquidateToFallback(a);
        (uint256 e1,, uint256 end1,) = _end(a);
        vm.warp(block.timestamp + 2 days);
        uint256 m = 300e18;
        uint256 b = _open(deLender2, deBorrower2, deBorrower2Pk, weth, m, usdc, 2 * m);
        _setRisk(b, DE_HF_LIQUIDATABLE, DE_LTV_LIQUIDATABLE);
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(a, b, 0);
        assertEq(uint8(_status(a)), uint8(LibVaipakam.LoanStatus.FallbackPending), "fixture-live: a part match");
        (uint256 l2, uint256 t2, uint256 b2) = _slices(a);
        assertEq(l2 + t2 + b2, _row(a), "fixture-live: the scaled split totals the row");
        (uint256 e2,, uint256 end2,) = _end(a);
        assertEq(e2, e1, "the entry is unchanged");
        assertEq(end2, end1, "so is the date");

        vm.warp(end1);
        uint256 treasury0 = IERC20(weth).balanceOf(treasuryEOA);
        vm.expectEmit(true, true, false, true, address(diamond));
        emit FallbackFinishedInKind(a, l2, t2, b2, stranger);
        vm.prank(stranger);
        FallbackCustodyFacet(address(diamond)).finishFallbackInKind(a);
        assertEq(IERC20(weth).balanceOf(treasuryEOA) - treasury0, t2, "the scaled treasury slice");
        assertEq(_lien(a), b2, "the scaled borrower slice stays under the lien");
    }

    // =====================================================================
    //  D12-D13: the legacy refusal and the setting's bounds
    // =====================================================================

    /// @notice D12. A legacy Diamond-held row is refused by name, and the view
    ///         says it is not finishable.
    function test_D12_legacyRow_refusedByName() public {
        uint256 id = _forward(weth);
        _liquidateToFallback(id);
        _makeLegacyRaw(id);
        (,, uint256 endAt,) = _end(id);
        vm.warp(endAt);
        (,,, bool finishable) = _end(id);
        assertFalse(finishable, "a legacy row is not finishable");
        vm.expectRevert(abi.encodeWithSelector(LibFallbackCustody.FallbackCustodyNotVaultHeld.selector, id));
        FallbackCustodyFacet(address(diamond)).finishFallbackInKind(id);
    }

    /// @notice D13. The setting reads the default while unset, is bounded
    ///         [14, 90], and is ADMIN_ROLE only.
    function test_D13_settingBoundsAndRole() public {
        FallbackCustodyFacet f = FallbackCustodyFacet(address(diamond));
        assertEq(f.getFallbackEndWaitDays(), LibFallbackEnd.DEFAULT_WAIT_DAYS, "the default while unset");
        vm.expectRevert(abi.encodeWithSelector(FallbackCustodyFacet.FallbackEndWaitOutOfRange.selector, uint16(13)));
        f.setFallbackEndWaitDays(13);
        vm.expectRevert(abi.encodeWithSelector(FallbackCustodyFacet.FallbackEndWaitOutOfRange.selector, uint16(91)));
        f.setFallbackEndWaitDays(91);
        vm.expectRevert(abi.encodeWithSelector(FallbackCustodyFacet.FallbackEndWaitOutOfRange.selector, uint16(0)));
        f.setFallbackEndWaitDays(0);
        f.setFallbackEndWaitDays(14);
        assertEq(f.getFallbackEndWaitDays(), 14, "the lower bound is allowed");
        f.setFallbackEndWaitDays(90);
        assertEq(f.getFallbackEndWaitDays(), 90, "the upper bound is allowed");
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibAccessControl.AccessControlUnauthorizedAccount.selector, stranger, LibAccessControl.ADMIN_ROLE
            )
        );
        f.setFallbackEndWaitDays(30);
    }

    // =====================================================================
    //  Fixtures
    // =====================================================================

    function _forward(address collateral) internal returns (uint256) {
        return _open(deLender, deBorrower, deBorrowerPk, usdc, DE_PRINCIPAL, collateral, DE_COLLATERAL);
    }

    function _open(
        address lender_,
        address borrower_,
        uint256 borrowerPk_,
        address lending,
        uint256 principal,
        address collateral,
        uint256 collateralAmount
    ) internal returns (uint256 loanId) {
        _fund(lender_, lending, principal);
        _fund(borrower_, collateral, collateralAmount);
        LibVaipakam.CreateOfferParams memory p = LibVaipakam.CreateOfferParams({
            integrator: address(0),
            lifecycleFlex: 0,
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: lending,
            amount: principal,
            interestRateBps: DE_RATE_BPS,
            collateralAsset: collateral,
            collateralAmount: collateralAmount,
            durationDays: DE_LOAN_DAYS,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: address(0),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: true,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: principal,
            interestRateBpsMax: DE_RATE_BPS,
            collateralAmountMax: collateralAmount,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false,
            linkKind: 0,
            linkMarginBps: 0,
            rateFarFromAverageAcknowledged: false
        });
        vm.prank(lender_);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(p, type(uint64).max);
        loanId = LibAcceptTestSigner.signAndAccept(address(diamond), borrower_, borrowerPk_, offerId);
        _setRisk(loanId, DE_HF_HEALTHY, DE_LTV_HEALTHY);
        assertEq(uint8(_status(loanId)), uint8(LibVaipakam.LoanStatus.Active), "fixture-live: the loan opened Active");
    }

    function _liquidateToFallback(uint256 loanId) internal {
        _setRisk(loanId, DE_HF_LIQUIDATABLE, DE_LTV_LIQUIDATABLE);
        LibTestFallbackGate.open(address(diamond), loanId);
        uint256 sellQuote = liquidationQuote(address(diamond), loanId);
        RiskFacet(address(diamond)).triggerLiquidation(loanId, sellQuote, _route(true));
        assertEq(
            uint8(_status(loanId)),
            uint8(LibVaipakam.LoanStatus.FallbackPending),
            "fixture-live: the failed liquidation entered FallbackPending"
        );
    }

    function _topUp(uint256 loanId, uint256 amount) internal {
        LibVaipakam.Loan memory l = _loan(loanId);
        _fund(l.borrower, l.collateralAsset, amount);
        vm.prank(l.borrower);
        AddCollateralFacet(address(diamond)).addCollateral(loanId, amount);
    }

    /// @dev FallbackCustodyTest F16's raw legacy shape: the units moved into
    ///      the Diamond, the tracked record and the lien dropped, the row zero
    ///      under the still-active snapshot.
    function _makeLegacyRaw(uint256 loanId) internal {
        LibVaipakam.Loan memory l = _loan(loanId);
        uint256 held = _row(loanId);
        vm.prank(_vault(l.borrower));
        assertTrue(IERC20(l.collateralAsset).transfer(address(diamond), held), "legacy units into the Diamond");
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            l.borrower,
            l.collateralAsset,
            VaultFactoryFacet(address(diamond)).getTrackedHolding(l.borrower, l.collateralAsset, 0) - held
        );
        (uint256 old, bool released) = TestMutatorFacet(address(diamond)).getLoanCollateralLienAmount(loanId);
        uint256 agg = TestMutatorFacet(address(diamond)).getEncumberedRaw(l.borrower, l.collateralAsset, 0);
        TestMutatorFacet(address(diamond)).setLoanCollateralLienRaw(
            loanId, l.borrower, l.collateralAsset, 0, 0, LibVaipakam.AssetType.ERC20
        );
        TestMutatorFacet(address(diamond)).setEncumberedRaw(
            l.borrower, l.collateralAsset, 0, agg - (released ? 0 : old)
        );
        TestMutatorFacet(address(diamond)).setFallbackVaultCustodyRaw(loanId, 0);
    }

    function _fund(address who, address token, uint256 amount) internal {
        if (amount == 0) return;
        if (token == vpfi) {
            assertTrue(IERC20(vpfi).transfer(who, amount), "VPFI funding");
        } else {
            ERC20Mock(token).mint(who, amount);
        }
    }

    function _setRisk(uint256 loanId, uint256 hf, uint256 ltv) internal {
        vm.mockCall(
            address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId), abi.encode(hf)
        );
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector, loanId), abi.encode(ltv));
    }

    function _route(bool fails) internal view returns (LibSwap.AdapterCall[] memory route) {
        route = new LibSwap.AdapterCall[](1);
        route[0] = LibSwap.AdapterCall({adapterIdx: fails ? failingAdapterIdx : workingAdapterIdx, data: bytes("")});
    }

    // =====================================================================
    //  Reads
    // =====================================================================

    function _end(uint256 loanId)
        internal
        view
        returns (uint256 enteredAt, uint256 waitSeconds, uint256 endAt, bool finishable)
    {
        return FallbackCustodyFacet(address(diamond)).getFallbackEnd(loanId);
    }

    function _row(uint256 loanId) internal view returns (uint256 row) {
        (row,) = FallbackCustodyFacet(address(diamond)).getFallbackCustody(loanId);
    }

    function _lien(uint256 loanId) internal view returns (uint256 amount) {
        (amount,) = TestMutatorFacet(address(diamond)).getLoanCollateralLienAmount(loanId);
    }

    function _slices(uint256 loanId) internal view returns (uint256 l, uint256 t, uint256 b) {
        (l, t, b,,,,) = ClaimViewFacet(address(diamond)).getFallbackSnapshot(loanId);
    }

    function _parked(uint256 loanId) internal view returns (LibVaipakam.ParkedLeg memory) {
        return SettlementLegFacet(address(diamond)).getParkedLenderLeg(loanId);
    }

    function _vault(address who) internal view returns (address) {
        return VaultFactoryFacet(address(diamond)).getUserVaultAddress(who);
    }

    function _loan(uint256 loanId) internal view returns (LibVaipakam.Loan memory) {
        return LoanFacet(address(diamond)).getLoanDetails(loanId);
    }

    function _status(uint256 loanId) internal view returns (LibVaipakam.LoanStatus) {
        return _loan(loanId).status;
    }

    /// @dev The `enteredAt` of the `FallbackEndScheduled` for `loanId`.
    function _scheduledAt(Vm.Log[] memory logs, uint256 loanId) internal view returns (uint256) {
        bytes32 sig = FallbackEndScheduled.selector;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(diamond) && logs[i].topics.length > 1 && logs[i].topics[0] == sig
                    && uint256(logs[i].topics[1]) == loanId
            ) {
                (uint256 enteredAt,) = abi.decode(logs[i].data, (uint256, uint256));
                return enteredAt;
            }
        }
        revert("FallbackDatedEndTest: no FallbackEndScheduled");
    }
}
