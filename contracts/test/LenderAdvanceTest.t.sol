// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {InstantMarketBase} from "./InstantMarketTest.t.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {InstantMarketFacet} from "../src/facets/InstantMarketFacet.sol";
import {InstantFillFacet} from "../src/facets/InstantFillFacet.sol";
import {LenderAdvanceFacet} from "../src/facets/LenderAdvanceFacet.sol";
import {LenderSideFacet} from "../src/facets/LenderSideFacet.sol";
import {LenderCashOutFacet} from "../src/facets/LenderCashOutFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {VaultDepositoryFacet} from "../src/facets/VaultDepositoryFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibAdvance} from "../src/libraries/LibAdvance.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LibTestCalmPair} from "./helpers/LibTestCalmPair.sol";
import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";

/**
 * @title  LenderAdvanceTest
 * @notice Lender cash-out (#3760, LenderCashOutDesign §6, tests §10.4–§10.9,
 *         §10.13–§10.14): a lender position borrows against itself from
 *         another lender's Auto-lend slot, and every arrival for the
 *         position pays the advance first.
 */
contract LenderAdvanceTest is InstantMarketBase {
    uint256 internal constant PRINCIPAL = 1000 ether;
    uint16 internal constant LOAN_RATE = 500;
    uint16 internal constant ADVANCE_RATE = 800;

    uint256 internal loanId;
    uint256 internal tokenId;

    /// @dev `lender`'s slot lends PRINCIPAL to `taker`; `lender2` funds a slot
    ///      on the same pair and consents to advance on loans.
    function _open() internal {
        address[] memory paa = new address[](2);
        paa[0] = mockERC20;
        paa[1] = mockCollateralERC20;
        ConfigFacet(address(diamond)).setPaaAssets(paa);
        vm.prank(owner);
        LenderAdvanceFacet(address(diamond)).setAdvancesEnabled(true);

        _slot(lender, LOAN_RATE, PRINCIPAL, true);
        _slot(lender2, ADVANCE_RATE, PRINCIPAL, false);
        vm.prank(lender2);
        LenderAdvanceFacet(address(diamond)).setAdvanceSlot(mockERC20, mockCollateralERC20, 0, true, 0);
        _age();
        InstantFillFacet.InstantSource[] memory srcs = new InstantFillFacet.InstantSource[](1);
        srcs[0] = _src(lender);
        (, InstantMarketFacet.InstantFill[] memory fills) = _borrow(_req(PRINCIPAL, 2000 ether, 700, PRINCIPAL), srcs);
        loanId = fills[0].loanId;
        tokenId = _loan(loanId).lenderTokenId;
        vm.mockCall(
            address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector), abi.encode(MAX_INIT_LTV_BPS)
        );
        // Past the new token's transfer wait, with fresh price checkpoints.
        vm.roll(block.number + 1);
        vm.warp(vm.getBlockTimestamp() + 2 days);
        LibTestCalmPair.checkpoint(address(diamond), mockERC20, mockCollateralERC20);
    }

    function _take(uint256 amount) internal returns (uint256 received) {
        vm.prank(lender);
        received = LenderAdvanceFacet(address(diamond)).takeAdvance(
            tokenId, lender2, 0, amount, ADVANCE_RATE, 0, uint64(vm.getBlockTimestamp() + 1 hours)
        );
    }

    function _advance() internal view returns (LibVaipakam.Advance memory a, uint256 interestNow) {
        return LenderSideFacet(address(diamond)).getAdvance(loanId);
    }

    // ─── §10.4 Taking an advance ─────────────────────────────────────────

    /// @dev The fee is taken from the amount, the rest lands in the holder's
    ///      vault, the slot's capital pays it and the position is locked.
    function test_takeAdvancePaysTheHolderAndLocks() public {
        _open();
        uint256 amount = 500 ether;
        LenderAdvanceFacet.AdvancePreview memory p =
            LenderAdvanceFacet(address(diamond)).previewAdvance(tokenId, lender, lender2, 0, amount);
        assertEq(p.refusals.length, 0, "preview open");
        uint256 holderBefore = _vaultBal(lender, mockERC20);
        uint256 slotBefore = _vaultBal(lender2, mockERC20);

        uint256 received = _take(amount);

        assertEq(received, p.received, "preview and take agree");
        assertEq(received + p.fee, amount, "fee taken from the amount");
        assertEq(_vaultBal(lender, mockERC20) - holderBefore, received, "holder's vault received it");
        assertEq(slotBefore - _vaultBal(lender2, mockERC20), amount, "slot capital paid the amount");
        (LibVaipakam.Advance memory a,) = _advance();
        assertTrue(a.open, "open");
        assertEq(a.principalOwed, amount, "owes the gross amount");
        assertEq(a.rateBps, ADVANCE_RATE, "the slot's rate");
        assertEq(a.slotOwner, lender2);
    }

    function test_refusedWhileSwitchOff() public {
        _open();
        vm.prank(owner);
        LenderAdvanceFacet(address(diamond)).setAdvancesEnabled(false);
        vm.expectRevert(LenderAdvanceFacet.AdvancesDisabled.selector);
        _take(500 ether);
    }

    function test_refusedAboveTheSlotCeiling() public {
        _open();
        // The default share is 70% of the principal, less the advance's
        // interest to the grace end: 700 is over it.
        vm.expectPartialRevert(LenderAdvanceFacet.AdvanceAboveCeiling.selector);
        _take(700 ether);
    }

    function test_refusedForANonHolder() public {
        _open();
        vm.prank(lender2);
        vm.expectRevert();
        LenderAdvanceFacet(address(diamond)).takeAdvance(
            tokenId, lender2, 0, 100 ether, ADVANCE_RATE, 0, uint64(vm.getBlockTimestamp() + 1 hours)
        );
    }

    function test_refusedAboveTheHoldersRate() public {
        _open();
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(LenderAdvanceFacet.AdvanceRateAboveMax.selector, ADVANCE_RATE, ADVANCE_RATE - 1)
        );
        LenderAdvanceFacet(address(diamond)).takeAdvance(
            tokenId, lender2, 0, 100 ether, ADVANCE_RATE - 1, 0, uint64(vm.getBlockTimestamp() + 1 hours)
        );
    }

    function test_oneAdvancePerPosition() public {
        _open();
        _take(200 ether);
        vm.expectRevert(abi.encodeWithSelector(LibAdvance.AdvanceLocksPosition.selector, loanId));
        _take(100 ether);
    }

    // ─── §10.8 The lock ──────────────────────────────────────────────────

    function test_lockBlocksTransfer() public {
        _open();
        _take(200 ether);
        address core = address(LibTestPositionNFT.core(address(diamond)));
        vm.prank(lender);
        vm.expectRevert();
        LibTestPositionNFT.core(address(diamond)).transferFrom(lender, lender2, tokenId);
        assertEq(ERC20(mockERC20).balanceOf(core), 0, "nothing moved");
    }

    function test_cashOptionsNamesTheAdvanceAsTheOpenRoute() public {
        _open();
        _take(200 ether);
        LenderCashOutFacet.CashOptions memory o =
            LenderCashOutFacet(address(diamond)).cashOptions(tokenId, lender, 0);
        assertEq(uint8(o.openRoute), uint8(LenderCashOutFacet.OpenRoute.Advance), "advance stands");
        assertFalse(o.sellNow.open, "no sale while it stands");
        assertFalse(o.sellAtMyPrice.open, "no listing while it stands");
        assertFalse(o.borrowAgainstIt.open, "no second advance");
    }

    // ─── §10.6–§10.7 Interest and the holder's repayment ────────────────

    /// @dev Interest is by time on what is owed; a part repayment pays the
    ///      interest first and the advance stays open; the rest closes it.
    function test_holderRepaysInPartThenInFull() public {
        _open();
        uint256 amount = 300 ether;
        _take(amount);
        vm.warp(vm.getBlockTimestamp() + 10 days);
        (, uint256 interest) = _advance();
        uint256 expected = (amount * ADVANCE_RATE * 10 days) / (365 days * 10_000);
        assertApproxEqAbs(interest, expected, 1, "interest by time on what is owed");

        uint256 slotBefore = _vaultBal(lender2, mockERC20);
        vm.prank(lender);
        LenderSideFacet(address(diamond)).repayAdvance(loanId, interest + 100 ether);
        (LibVaipakam.Advance memory a, uint256 interestAfter) = _advance();
        assertTrue(a.open, "still open");
        assertEq(a.principalOwed, amount - 100 ether, "interest first, then principal");
        assertEq(interestAfter, 0, "interest paid");
        assertGt(_vaultBal(lender2, mockERC20), slotBefore, "slot owner paid");

        // The holder needs the rest free in the vault.
        ERC20Mock(mockERC20).mint(lender, amount);
        vm.prank(lender);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(lender);
        VaultDepositoryFacet(address(diamond)).depositToVault(uint8(LibVaipakam.AssetType.ERC20), mockERC20, 0, amount);
        vm.prank(lender);
        LenderSideFacet(address(diamond)).repayAdvance(loanId, type(uint256).max);
        (a,) = _advance();
        assertFalse(a.open, "closed");
        LenderCashOutFacet.CashOptions memory o =
            LenderCashOutFacet(address(diamond)).cashOptions(tokenId, lender, 0);
        assertEq(uint8(o.openRoute), uint8(LenderCashOutFacet.OpenRoute.None), "the lock lifted");
    }

    // ─── §10.5 / §10.9 The order of payment at the loan's end ───────────

    /// @dev The borrower repays in full: the advance and its interest come
    ///      first, set aside in the holder's vault and moved to the slot
    ///      owner by anyone; interest stopped at the repayment; the holder's
    ///      claim gets the rest.
    function test_finalRepaymentPaysTheAdvanceFirst() public {
        _open();
        uint256 amount = 300 ether;
        _take(amount);
        vm.warp(vm.getBlockTimestamp() + 10 days);
        vm.prank(taker);
        RepayFacet(address(diamond)).repayLoan(loanId);

        (LibVaipakam.Advance memory a, uint256 interestAtRepay) = _advance();
        assertGt(a.setAside, 0, "set aside as it arrived");
        // Interest stops when the money arrives, whenever it is moved.
        vm.warp(vm.getBlockTimestamp() + 30 days);
        (LibVaipakam.Advance memory later, uint256 interestLater) = _advance();
        assertEq(later.setAside, a.setAside, "unchanged");
        assertEq(interestLater, interestAtRepay, "no interest after the arrival");

        uint256 slotBefore = _vaultBal(lender2, mockERC20);
        vm.prank(makeAddr("anyone"));
        LenderSideFacet(address(diamond)).payAdvance(loanId);
        uint256 toSlot = _vaultBal(lender2, mockERC20) - slotBefore;
        assertGt(toSlot, amount, "principal and interest, less the treasury's cut");
        assertLe(toSlot, a.setAside, "no more than was set aside");

        uint256 holderBefore = _vaultBal(lender, mockERC20);
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        (a,) = _advance();
        assertFalse(a.open, "closed at the claim");
        assertEq(a.shortfall, 0, "nothing short");
        // The holder's claim is what the loan paid less what the advance took.
        assertGe(_vaultBal(lender, mockERC20), holderBefore, "holder keeps the rest");
    }

    /// @dev §10.14: switching advances off refuses new ones; an open one runs
    ///      to its end.
    function test_switchOffLetsAnOpenAdvanceRun() public {
        _open();
        _take(200 ether);
        vm.prank(owner);
        LenderAdvanceFacet(address(diamond)).setAdvancesEnabled(false);
        vm.warp(vm.getBlockTimestamp() + 5 days);
        vm.prank(taker);
        RepayFacet(address(diamond)).repayLoan(loanId);
        LenderSideFacet(address(diamond)).payAdvance(loanId);
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        (LibVaipakam.Advance memory a,) = _advance();
        assertFalse(a.open, "ran to its end");
    }

    // ─── §10.12 / §10.13 Never in a borrower's way; everything adds up ──

    /// @dev A flagged slot owner does not stop the borrower repaying: the
    ///      advance's part is set aside for them and held, and only moves once
    ///      they are cleared.
    function test_flaggedSlotOwnerNeverBlocksTheRepayment() public {
        _open();
        _take(300 ether);
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        m.setFlagged(lender2, true);
        vm.warp(vm.getBlockTimestamp() + 5 days);

        vm.prank(taker);
        RepayFacet(address(diamond)).repayLoan(loanId);
        (LibVaipakam.Advance memory a,) = _advance();
        assertGt(a.setAside, 0, "booked for the flagged slot owner");

        vm.expectRevert(abi.encodeWithSelector(LenderSideFacet.AdvancePayeeFlagged.selector, loanId, lender2));
        LenderSideFacet(address(diamond)).payAdvance(loanId);

        m.setFlagged(lender2, false);
        LenderSideFacet(address(diamond)).payAdvance(loanId);
        (a,) = _advance();
        assertEq(a.setAside, 0, "moved once cleared");
    }

    /// @dev What the loan paid its lender side is split exactly between the
    ///      slot owner, the treasury's cut of the advance's interest and the
    ///      holder; nothing stays in the Diamond.
    function test_everythingAddsUp() public {
        _open();
        uint256 amount = 300 ether;
        uint256 received = _take(amount);
        vm.warp(vm.getBlockTimestamp() + 10 days);

        uint256 holderStart = _vaultBal(lender, mockERC20);
        uint256 slotStart = _vaultBal(lender2, mockERC20);
        uint256 diamondStart = ERC20(mockERC20).balanceOf(address(diamond));
        uint256 treasuryStart = TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20);
        vm.prank(taker);
        RepayFacet(address(diamond)).repayLoan(loanId);
        uint256 arrived = _vaultBal(lender, mockERC20) - holderStart;

        LenderSideFacet(address(diamond)).payAdvance(loanId);
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        (LibVaipakam.Advance memory a,) = _advance();
        assertFalse(a.open, "closed");

        uint256 toSlot = _vaultBal(lender2, mockERC20) - slotStart;
        uint256 interest = a.interestPaid;
        assertEq(toSlot + (interest - (toSlot - amount)), amount + interest, "principal and interest booked");
        assertGe(toSlot, amount, "the advance came back whole");
        uint256 cut = amount + interest - toSlot;
        assertLe(cut, interest, "the treasury's cut is from the interest only");
        // The holder kept what arrived less what the advance took.
        uint256 holderNow = _vaultBal(lender, mockERC20);
        assertEq(holderNow + amount + interest, holderStart + arrived, "holder: arrival less the advance");
        // The test Diamond is its own treasury: what it gained is exactly the
        // treasury's booked accruals (the loan's cut and the advance's), no
        // user money.
        assertEq(
            ERC20(mockERC20).balanceOf(address(diamond)) - diamondStart,
            TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20) - treasuryStart,
            "nothing but treasury fees rests in the Diamond"
        );
        received; // the advance's proceeds were in the holder's vault before the repayment
    }
}
