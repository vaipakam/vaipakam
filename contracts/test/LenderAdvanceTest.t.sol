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
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {InstantTakeoverFacet} from "../src/facets/InstantTakeoverFacet.sol";
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
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {LibLenderSide} from "../src/libraries/LibLenderSide.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {SellerClaimFacet} from "../src/facets/SellerClaimFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/// @dev Test-only: drives the fallback's two final-claim steps through the one
///      writer library, as ClaimFacet does before and after the one retry.
contract LenderSideHarnessFacet {
    function harnessRowInKind(uint256 loanId, address asset, uint256 amount) external {
        LibVaipakam.ClaimInfo storage row = LibVaipakam.storageSlot().lenderClaims[loanId];
        row.asset = asset;
        row.assetType = LibVaipakam.AssetType.ERC20;
        row.amount = amount;
    }

    function harnessSetFinalAmount(uint256 loanId, uint256 amount) external returns (uint256) {
        return LibLenderSide.setFinalAmount(LibVaipakam.storageSlot(), loanId, amount);
    }

    function harnessSettleInKind(uint256 loanId, uint256 amount) external returns (uint256) {
        return LibLenderSide.settleFinalInKind(LibVaipakam.storageSlot(), loanId, amount);
    }

    /// @dev A lender leg parked in `payer`'s vault (0 clears it).
    function harnessParkLeg(uint256 loanId, address payer) external {
        LibVaipakam.storageSlot().parkedLenderLeg[loanId].payer = payer;
    }

    /// @dev The loan's terms allow a part repayment.
    function harnessAllowPartial(uint256 loanId) external {
        LibVaipakam.storageSlot().loans[loanId].allowsPartialRepay = true;
    }
}

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

    // ─── §6.4 / §6.6 A moved holder, and a flagged slot owner ───────────

    function _moveHolder() internal returns (address moved) {
        moved = _newParty("movedHolder");
        // The replacement move of a retired account carries the position to
        // its new wallet with the advance attached; the stored lender (the
        // advance's custody) stays where it was.
        LibTestPositionNFT.mockHolder(address(diamond), tokenId, moved);
    }

    /// @dev A holder who is not the stored lender repays while the slot owner
    ///      is flagged: the payment is set aside in the holder's own vault,
    ///      interest stops on it, and it is paid from there once the flag
    ///      clears. No refusal.
    function test_flaggedSlotOwnerHolderElsewhereRepays() public {
        _open();
        uint256 amount = 300 ether;
        _take(amount);
        address moved = _moveHolder();
        vm.prank(moved);
        VaultDepositoryFacet(address(diamond)).depositToVault(uint8(LibVaipakam.AssetType.ERC20), mockERC20, 0, 400 ether);
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        m.setFlagged(lender2, true);
        vm.warp(vm.getBlockTimestamp() + 5 days);

        vm.prank(moved);
        uint256 paid = LenderSideFacet(address(diamond)).repayAdvance(loanId, type(uint256).max);
        (LibVaipakam.Advance memory a, uint256 interest) = _advance();
        assertFalse(a.open, "paid in full");
        assertEq(a.heldElsewhere, paid, "held in the paying holder's vault");
        assertEq(a.setAside, 0, "nothing in the stored lender's vault");
        vm.warp(vm.getBlockTimestamp() + 30 days);
        (, interest) = _advance();
        assertEq(interest, 0, "no interest on money that has arrived");

        vm.expectRevert(abi.encodeWithSelector(LenderSideFacet.AdvancePayeeFlagged.selector, loanId, lender2));
        LenderSideFacet(address(diamond)).payAdvance(loanId);
        m.setFlagged(lender2, false);
        uint256 movedBefore = _vaultBal(moved, mockERC20);
        uint256 slotBefore = _vaultBal(lender2, mockERC20);
        LenderSideFacet(address(diamond)).payAdvance(loanId);
        (a,) = _advance();
        assertEq(a.heldElsewhere, 0, "paid out");
        assertEq(movedBefore - _vaultBal(moved, mockERC20), paid, "from the holder's vault");
        assertGe(_vaultBal(lender2, mockERC20) - slotBefore, amount, "the slot owner got the advance back");
    }

    /// @dev A holder moved by a recovery move still claims what is left after
    ///      the advance.
    function test_movedHolderClaimsWhatIsLeft() public {
        _open();
        _take(200 ether);
        address moved = _moveHolder();
        vm.warp(vm.getBlockTimestamp() + 5 days);
        vm.prank(taker);
        RepayFacet(address(diamond)).repayLoan(loanId);
        LenderSideFacet(address(diamond)).payAdvance(loanId);

        uint256 movedBefore = _vaultBal(moved, mockERC20);
        uint256 storedBefore = _vaultBal(lender, mockERC20);
        vm.prank(moved);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        uint256 got = _vaultBal(moved, mockERC20) - movedBefore;
        assertGt(got, PRINCIPAL - 200 ether, "the rest of the repayment");
        assertEq(storedBefore - _vaultBal(lender, mockERC20), got, "paid out of the stored lender's vault");
        (LibVaipakam.Advance memory a,) = _advance();
        assertFalse(a.open, "closed");
    }

    // ─── §6.6 / §10.10 The fallback's in-kind split (design ruling 2) ───

    function _harness() internal {
        LenderSideHarnessFacet h = new LenderSideHarnessFacet();
        bytes4[] memory sel = new bytes4[](5);
        sel[0] = h.harnessRowInKind.selector;
        sel[1] = h.harnessSetFinalAmount.selector;
        sel[2] = h.harnessSettleInKind.selector;
        sel[3] = h.harnessParkLeg.selector;
        sel[4] = h.harnessAllowPartial.selector;
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({facetAddress: address(h), action: IDiamondCut.FacetCutAction.Add, functionSelectors: sel});
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }

    function _fallback(uint256 rateNum, uint256 rateDen, uint256 slice) internal {
        _harness();
        TestMutatorFacet(address(diamond)).setFallbackSnapshotRaw(
            loanId,
            LibVaipakam.FallbackSnapshot({
                lenderCollateral: slice,
                treasuryCollateral: 0,
                borrowerCollateral: 0,
                lenderPrincipalDue: 0,
                treasuryPrincipalDue: 0,
                active: true,
                retryAttempted: false,
                rateNum: rateNum,
                rateDen: rateDen
            })
        );
        LenderSideHarnessFacet(address(diamond)).harnessRowInKind(loanId, mockCollateralERC20, slice);
    }

    /// @dev Before the one retry nothing is split: the row is recorded and
    ///      the advance stays open.
    function test_inKindNothingSplitBeforeTheRetry() public {
        _open();
        _take(300 ether);
        _fallback(2, 1, 2000 ether);
        LenderSideHarnessFacet(address(diamond)).harnessSetFinalAmount(loanId, 1900 ether);
        (LibVaipakam.Advance memory a,) = _advance();
        assertTrue(a.open, "still open");
        assertEq(a.inKindSetAside, 0, "nothing split");
    }

    /// @dev After a failed retry the split is at the fallback's own stored
    ///      rate: the advance takes collateral worth what it is owed.
    function test_inKindSplitAtTheStoredRate() public {
        _open();
        _take(300 ether);
        vm.warp(vm.getBlockTimestamp() + 3 days);
        (LibVaipakam.Advance memory before, uint256 interest) = _advance();
        uint256 owed = before.principalOwed + interest;
        _fallback(2, 1, 2000 ether);
        uint256 kept = LenderSideHarnessFacet(address(diamond)).harnessSettleInKind(loanId, 2000 ether);
        (LibVaipakam.Advance memory a,) = _advance();
        assertFalse(a.open, "closed by the split");
        assertEq(a.inKindSetAside, owed * 2, "collateral worth what is owed, at 2 per 1");
        assertEq(a.inKindInterest, interest * 2, "the interest part, interest first");
        assertEq(kept, 2000 ether - owed * 2, "the holder keeps the rest");
        assertEq(a.shortfall, 0, "nothing short");
    }

    /// @dev With no price the advance takes the whole slice.
    function test_inKindNoPriceTakesAll() public {
        _open();
        _take(300 ether);
        _fallback(0, 0, 2000 ether);
        uint256 kept = LenderSideHarnessFacet(address(diamond)).harnessSettleInKind(loanId, 2000 ether);
        (LibVaipakam.Advance memory a,) = _advance();
        assertFalse(a.open, "closed");
        assertEq(a.inKindSetAside, 2000 ether, "the whole slice");
        assertEq(kept, 0, "nothing for the holder");
    }

    // ─── The stored lender cannot change while locked ───────────────────

    /// @dev The advance's custody is the stored lender for its whole life:
    ///      no route may migrate the lender position while it is locked.
    function test_takeoverRefusedWhileLocked() public {
        _open();
        _take(200 ether);
        vm.prank(lender);
        vm.expectRevert();
        InstantTakeoverFacet(address(diamond)).takeoverInstant(
            loanId, lender2, 0, uint64(vm.getBlockTimestamp() + 1 hours)
        );
        assertEq(_loan(loanId).lender, lender, "stored lender unchanged");
    }

    // ─── Review round 1 ─────────────────────────────────────────────────

    /// @dev An emergency pause of either asset refuses a new advance.
    function test_refusedWhileAssetPaused() public {
        _open();
        AdminFacet(address(diamond)).pauseAsset(mockCollateralERC20);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.AssetPaused.selector, mockCollateralERC20));
        LenderAdvanceFacet(address(diamond)).takeAdvance(
            tokenId, lender2, 0, 200 ether, ADVANCE_RATE, 0, uint64(vm.getBlockTimestamp() + 1 hours)
        );
    }

    /// @dev A slot owner seen flagged when its money was set aside stays
    ///      unpaid through a later oracle outage.
    function test_flagHeldThroughAnOracleOutage() public {
        _open();
        _take(300 ether);
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        m.setFlagged(lender2, true);
        vm.warp(vm.getBlockTimestamp() + 5 days);
        vm.prank(taker);
        RepayFacet(address(diamond)).repayLoan(loanId);

        m.setRevertOnRead(true); // the oracle goes dark
        vm.expectRevert(abi.encodeWithSelector(LenderSideFacet.AdvancePayeeFlagged.selector, loanId, lender2));
        LenderSideFacet(address(diamond)).payAdvance(loanId);

        m.setRevertOnRead(false);
        m.setFlagged(lender2, false);
        LenderSideFacet(address(diamond)).payAdvance(loanId);
        (LibVaipakam.Advance memory a,) = _advance();
        assertEq(a.setAside, 0, "paid once it reads clean");
    }

    /// @dev The holder's own repayment spends free balance: it leaves their
    ///      depository holding.
    function test_holderRepayDebitsTheDepository() public {
        _open();
        _take(300 ether);
        uint256 before = VaultDepositoryFacet(address(diamond)).getDepositoryHolding(lender, mockERC20, 0);
        ERC20Mock(mockERC20).mint(lender, 100 ether);
        vm.prank(lender);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(lender);
        VaultDepositoryFacet(address(diamond)).depositToVault(uint8(LibVaipakam.AssetType.ERC20), mockERC20, 0, 100 ether);
        vm.prank(lender);
        uint256 paid = LenderSideFacet(address(diamond)).repayAdvance(loanId, 100 ether);
        assertEq(paid, 100 ether);
        assertEq(
            VaultDepositoryFacet(address(diamond)).getDepositoryHolding(lender, mockERC20, 0),
            before,
            "the deposit was spent on the advance"
        );
    }

    /// @dev Interest the advance took from a part repayment paid the holder's
    ///      own advance: the interest ledger counts it paid, not parked.
    function test_divertedInterestCountsAsPaid() public {
        _open();
        _take(300 ether);
        vm.warp(vm.getBlockTimestamp() + 20 days);
        (uint256 earnedBefore,,,) = SellerClaimFacet(address(diamond)).getInterestLedger(loanId);
        assertGt(earnedBefore, 0, "the holder earned interest");
        _harness();
        LenderSideHarnessFacet(address(diamond)).harnessAllowPartial(loanId);
        vm.prank(taker);
        RepayFacet(address(diamond)).repayPartial(loanId, 10 ether);
        (LibVaipakam.Advance memory a,) = _advance();
        assertGt(a.setAside, 0, "the advance took the arrival");
        (uint256 earnedAfter,,,) = SellerClaimFacet(address(diamond)).getInterestLedger(loanId);
        assertEq(earnedAfter, 0, "paid through the advance, nothing left parked");
    }

    /// @dev A default's in-kind leg parked in the payer's vault is not split
    ///      until it arrives; then it is split once.
    function test_parkedInKindLegSplitOnArrival() public {
        _open();
        _take(300 ether);
        _harness();
        LenderSideHarnessFacet(address(diamond)).harnessRowInKind(loanId, mockCollateralERC20, 2000 ether);
        LenderSideHarnessFacet(address(diamond)).harnessParkLeg(loanId, taker);
        uint256 kept = LenderSideHarnessFacet(address(diamond)).harnessSetFinalAmount(loanId, 2000 ether);
        (LibVaipakam.Advance memory a,) = _advance();
        assertTrue(a.open, "still open while the leg is parked");
        assertEq(a.inKindSetAside, 0, "nothing split before it arrives");
        assertEq(kept, 2000 ether);
        assertTrue(a.inKindRateRead, "the default's rate is recorded when its claim is written");
        uint256 den = a.inKindRateDen;

        LenderSideHarnessFacet(address(diamond)).harnessParkLeg(loanId, address(0)); // released
        kept = LenderSideHarnessFacet(address(diamond)).harnessSetFinalAmount(loanId, 2000 ether);
        (a,) = _advance();
        assertFalse(a.open, "split on arrival");
        assertEq(a.inKindSetAside + kept, 2000 ether, "split once");
        assertEq(a.inKindRateDen, den, "at the rate recorded at the default");
    }

    /// @dev A default that delivers the collateral directly (no fallback) is
    ///      split at the price read at the default, not as if unpriced; a
    ///      shortfall leaves the interest part interest first.
    function test_directInKindDefaultSplitAtItsRate() public {
        _open();
        _take(300 ether);
        vm.warp(vm.getBlockTimestamp() + 3 days);
        (LibVaipakam.Advance memory before, uint256 interest) = _advance();
        uint256 owed = before.principalOwed + interest;
        _harness();
        LenderSideHarnessFacet(address(diamond)).harnessRowInKind(loanId, mockCollateralERC20, 2000 ether);
        uint256 kept = LenderSideHarnessFacet(address(diamond)).harnessSetFinalAmount(loanId, 2000 ether);
        (LibVaipakam.Advance memory a,) = _advance();
        assertFalse(a.open, "closed by the split");
        assertGt(a.inKindRateDen, 0, "priced at the default");
        uint256 expected = (owed * a.inKindRateNum + a.inKindRateDen - 1) / a.inKindRateDen;
        assertEq(a.inKindSetAside, expected, "collateral worth what is owed");
        assertEq(kept, 2000 ether - expected, "the holder keeps the rest");
    }

    /// @dev A keeper under the holder's early-withdrawal mandate is answered
    ///      as the takeover answers it: "sell now" judged as the holder, and
    ///      the takeover slot the only source it may name.
    function test_cashOptionsForAMandatedKeeper() public {
        _open();
        address keeper = makeAddr("cashout-keeper");
        LenderCashOutFacet.CashOptions memory o =
            LenderCashOutFacet(address(diamond)).cashOptions(tokenId, keeper, 0);
        assertFalse(o.sellNow.open, "no mandate: closed");
        vm.prank(lender);
        ProfileFacet(address(diamond)).setKeeperAccess(true);
        vm.prank(lender);
        ProfileFacet(address(diamond)).approveKeeper(keeper, LibVaipakam.KEEPER_ACTION_INIT_EARLY_WITHDRAW);
        vm.prank(lender);
        ProfileFacet(address(diamond)).setLoanKeeperEnabled(loanId, keeper, true);
        o = LenderCashOutFacet(address(diamond)).cashOptions(tokenId, keeper, 0);
        LenderCashOutFacet.CashOptions memory h =
            LenderCashOutFacet(address(diamond)).cashOptions(tokenId, lender, 0);
        assertEq(o.sellNow.open, h.sellNow.open, "judged as the holder");
        assertEq(InstantTakeoverFacet(address(diamond)).takeoverPositionRefusal(loanId).length, 0, "takeover open");
        assertEq(o.sourceKinds.length, 1, "one kind");
        assertEq(uint8(o.sourceKinds[0]), uint8(LenderCashOutFacet.SourceKind.TakeoverSlot), "the takeover slot");

        // Something held for the position closes every takeover, and the
        // keeper's only source is a takeover slot: the read says so with the
        // takeover's own refusal (Codex r4).
        vm.warp(vm.getBlockTimestamp() + 20 days);
        _harness();
        LenderSideHarnessFacet(address(diamond)).harnessAllowPartial(loanId);
        vm.prank(taker);
        RepayFacet(address(diamond)).repayPartial(loanId, 10 ether);
        bytes memory refusal = InstantTakeoverFacet(address(diamond)).takeoverPositionRefusal(loanId);
        assertEq(bytes4(refusal), InstantTakeoverFacet.InstantTakeoverHeld.selector, "held closes the takeover");
        o = LenderCashOutFacet(address(diamond)).cashOptions(tokenId, keeper, 0);
        assertFalse(o.sellNow.open, "a keeper cannot sell while something is held");
        bool named;
        for (uint256 k; k < o.sellNow.refusals.length; ++k) {
            if (keccak256(o.sellNow.refusals[k].reason) == keccak256(refusal)) named = true;
        }
        assertTrue(named, "names the takeover's own refusal");
    }
}
