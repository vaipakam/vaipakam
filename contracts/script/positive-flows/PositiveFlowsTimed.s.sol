// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ForcedSalePreviewFacet} from "../../src/facets/ForcedSalePreviewFacet.sol";
import {console} from "forge-std/console.sol";
import {PositiveFlowsStaged} from "./PositiveFlowsStaged.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibSwap} from "../../src/libraries/LibSwap.sol";
import {IVaipakamErrors} from "../../src/interfaces/IVaipakamErrors.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../../src/facets/OfferCancelFacet.sol";
import {VaultDepositoryFacet} from "../../src/facets/VaultDepositoryFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {ClaimViewFacet} from "../../src/facets/ClaimViewFacet.sol";
import {NumeraireConfigFacet} from "../../src/facets/NumeraireConfigFacet.sol";
import {RepayPeriodicFacet} from "../../src/facets/RepayPeriodicFacet.sol";
import {ForcedSaleFacet} from "../../src/facets/ForcedSaleFacet.sol";
import {FixedRateSwapAdapter} from "../mocks/FixedRateSwapAdapter.sol";

/**
 * @title PositiveFlowsTimed
 * @notice The positive flows whose next step must wait longer than an offer's
 *         terms age (#848 Phase 2): cancelling an unaccepted offer after the
 *         cancel cooldown (PF-045, PF-046), and a periodic-interest checkpoint
 *         settled once it is due (PF-116).
 *
 *         A staged module ({PositiveFlowsStaged}, #3574): each scenario is a
 *         list of steps, and a step says how long its successor must wait
 *         ({_nextStepNotBefore}). `run()` is the simulation, which steps its
 *         clock past each wait; `stage()` is the broadcastable run, one
 *         stage per `forge script` call, which `script/positive-flows/run-staged.sh
 *         PositiveFlowsTimed` drives. On a local Anvil the runner steps the
 *         clock; on a live rehearsal chain it waits out the cancel cooldown
 *         (five minutes) and stops before the month PF-116 waits, saying when
 *         to run it again.
 *
 *           - PF-045 / PF-046: post the offer and show its cancel is refused
 *             inside the cooldown; once the cooldown has passed, cancel it and
 *             check exactly what was locked came back.
 *           - PF-116: turn on the periodic-interest switch if it is off,
 *             register the settlement adapter, lower the finer-cadence
 *             threshold if needed, and post a Monthly-cadence offer; once its
 *             terms have aged, accept it, put the threshold back and show the
 *             checkpoint is not yet due; once it is due, settle it from
 *             collateral, repay, claim, and put back the switch and the
 *             adapter.
 *
 *         WHAT STAYS CHANGED ACROSS A WAIT, AND HOW IT IS PUT BACK. Between
 *         PF-116's steps the switch, the adapter and (for one terms-age wait)
 *         the threshold stay changed, which for the checkpoint is a month.
 *         Each is recorded as a setting to put back ({_toRestore}), with the
 *         value the run found, and stays in the record to the end of the run,
 *         even after the step that puts it back (whose broadcast may not land
 *         whole). A run abandoned part-way is unwound with `unwind()`,
 *         which puts back whatever the chain shows still changed; it leaves
 *         the run's open offers and loan on the rehearsal chain. `finish()`
 *         refuses while the chain shows any recorded setting still changed.
 *
 *         The settlement adapter is registered by the first step, a month
 *         before the settle sells through it, so a stage that changes a
 *         setting is never the stage that depends on its change landing.
 *         Fixture, runner and ids: {PositiveFlowsBase}.
 */
contract PositiveFlowsTimed is PositiveFlowsStaged {
    /// @dev PF-116's principal: twice the fixture's loan, so its value sits
    ///      clearly above the lowest finer-cadence threshold governance may set.
    uint256 private constant PERIODIC_PRINCIPAL = 2 * LOAN_AMOUNT;
    /// @dev The same principal in numeraire units (1e18-scaled USD at $1 per USDC).
    uint256 private constant PERIODIC_PRINCIPAL_NUMERAIRE = 2_000e18;
    uint256 private constant PERIODIC_COLLATERAL = 2 * COLLATERAL_AMOUNT;
    /// @dev Longer than the 30-day Monthly interval, which must be strictly
    ///      shorter than the loan.
    uint256 private constant PERIODIC_DURATION_DAYS = 60;

    // ── What a step keeps for a later one ({_keep}) ─────────────────────
    string private constant OFFER = "offer";
    string private constant LOAN = "loan";
    string private constant ADAPTER = "adapter";
    string private constant SWITCH_WAS_OFF = "switchWasOff";
    string private constant THRESHOLD_LOWERED = "thresholdLowered";

    // ── Settings PF-116 changes across a wait ({_toRestore}) ─────────────
    /// @dev Recorded with 0: the switch is put back off.
    string private constant PERIODIC_SWITCH = "periodicInterestSwitch";
    /// @dev Recorded with the threshold the run found (the effective value).
    string private constant FINER_CADENCE_THRESHOLD = "finerCadenceThreshold";

    function moduleName() public pure override returns (string memory) {
        return "PositiveFlowsTimed";
    }

    function scenarios() public pure override returns (Scenario[] memory list) {
        list = new Scenario[](3);
        list[0] = Scenario("PF-045", "Creator cancels an unaccepted lender offer after the cancel cooldown",
            "PF-040, PF-045");
        list[1] = Scenario("PF-046", "Creator cancels an unaccepted borrower offer after the cancel cooldown",
            "PF-041, PF-046");
        list[2] = Scenario("PF-116", "A due periodic-interest checkpoint is settled from collateral; the loan stays active",
            "PF-116, PF-110, PF-112, PF-113");
    }

    /// @dev Post, then cancel; PF-116: open, accept, settle.
    function _stepCount(uint256 index) internal pure override returns (uint256) {
        return index == 2 ? 3 : 2;
    }

    function _runStep(uint256 index, uint256 step) internal override {
        if (index == 0) _lenderOfferCancel(step);
        else if (index == 1) _borrowerOfferCancel(step);
        else if (index == 2) _periodicCheckpoint(step);
        else revert("PositiveFlowsTimed: no scenario at index");
    }

    // ─── Settings to put back ─────────────────────────────────────────────

    function _stillToRestore(string memory name, uint256 value) internal view override returns (bool) {
        if (_eq(name, PERIODIC_SWITCH)) {
            return NumeraireConfigFacet(diamond).getPeriodicInterestEnabled() != (value != 0);
        }
        if (_eq(name, FINER_CADENCE_THRESHOLD)) {
            return NumeraireConfigFacet(diamond).getMinPrincipalForFinerCadence() != value;
        }
        return super._stillToRestore(name, value);
    }

    function _restore(string memory name, uint256 value) internal override {
        if (_eq(name, PERIODIC_SWITCH)) return _setPeriodicSwitch(value != 0);
        if (_eq(name, FINER_CADENCE_THRESHOLD)) return _restoreFinerCadenceThreshold(value);
        super._restore(name, value);
    }

    /// @dev Puts back the threshold PF-116 found. The getter reports the
    ///      effective value, so a threshold left at the library default is
    ///      written back as 0, which is how the setter says "use the default".
    function _restoreFinerCadenceThreshold(uint256 was) internal {
        _setFinerCadenceThreshold(was == LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_DEFAULT ? 0 : was);
    }

    // ─── PF-045 / PF-046 ──────────────────────────────────────────────────

    /// @dev The Diamond refuses a cancel within `MIN_OFFER_CANCEL_DELAY` of
    ///      an offer's creation while nothing of the offer is filled and it
    ///      has not expired, whatever the partial-fill setting (#664). These
    ///      scenarios show it holds, then lets go, on a chain.

    function _lenderOfferCancel(uint256 step) internal {
        if (step == 0) {
            uint256 id = _createLenderOffer(lenderKey);
            _keep(OFFER, id);
            return _requireCooldownHolds(lender, id, "PF-045");
        }
        uint256 offerId = _kept(OFFER);
        _requireOpenOffer(offerId, lender, "PF-045");
        uint256 before = usdc.balanceOf(lender);
        VaultDepositoryFacet depo = VaultDepositoryFacet(diamond);
        uint256 freeBefore = depo.getDepositoryHolding(lender, address(usdc), 0);
        vm.startBroadcast(lenderKey);
        OfferCancelFacet(diamond).cancelOffer(offerId);
        vm.stopBroadcast();
        // #3744 — the refund is the holder's free vault balance; the
        // holder's own withdrawal is what reaches the wallet.
        require(depo.getDepositoryHolding(lender, address(usdc), 0) - freeBefore == LOAN_AMOUNT,
            "PF-045: the cancel should free exactly the locked principal in the vault");
        vm.startBroadcast(lenderKey);
        depo.withdrawFromVault(lender, uint8(LibVaipakam.AssetType.ERC20), address(usdc), 0, LOAN_AMOUNT, lender);
        vm.stopBroadcast();
        require(usdc.balanceOf(lender) - before == LOAN_AMOUNT,
            "PF-045: the withdrawal should return exactly the locked principal");
        require(OfferCancelFacet(diamond).getOffer(offerId).creator == address(0),
            "PF-045: the cancelled offer should be gone");
        console.log("Lender offer cancelled; principal returned:", LOAN_AMOUNT);
    }

    function _borrowerOfferCancel(uint256 step) internal {
        if (step == 0) {
            vm.startBroadcast(borrowerKey);
            weth.approve(diamond, COLLATERAL_AMOUNT);
            uint256 id = OfferCreateFacet(diamond).createOffer(_borrowerOfferStandard(), type(uint64).max);
            vm.stopBroadcast();
            console.log("Borrower offer created:", id);
            _keep(OFFER, id);
            return _requireCooldownHolds(borrower, id, "PF-046");
        }
        uint256 offerId = _kept(OFFER);
        _requireOpenOffer(offerId, borrower, "PF-046");
        uint256 before = weth.balanceOf(borrower);
        VaultDepositoryFacet depo = VaultDepositoryFacet(diamond);
        uint256 freeBefore = depo.getDepositoryHolding(borrower, address(weth), 0);
        vm.startBroadcast(borrowerKey);
        OfferCancelFacet(diamond).cancelOffer(offerId);
        vm.stopBroadcast();
        // #3744 — the refund is the holder's free vault balance; the
        // holder's own withdrawal is what reaches the wallet.
        require(depo.getDepositoryHolding(borrower, address(weth), 0) - freeBefore == COLLATERAL_AMOUNT,
            "PF-046: the cancel should free exactly the locked collateral in the vault");
        vm.startBroadcast(borrowerKey);
        depo.withdrawFromVault(borrower, uint8(LibVaipakam.AssetType.ERC20), address(weth), 0, COLLATERAL_AMOUNT, borrower);
        vm.stopBroadcast();
        require(weth.balanceOf(borrower) - before == COLLATERAL_AMOUNT,
            "PF-046: the withdrawal should return exactly the locked collateral");
        require(OfferCancelFacet(diamond).getOffer(offerId).creator == address(0),
            "PF-046: the cancelled offer should be gone");
        console.log("Borrower offer cancelled; collateral returned:", COLLATERAL_AMOUNT);
    }

    /// @dev The creator's cancel is refused now, and the next step waits
    ///      until the cooldown ends.
    function _requireCooldownHolds(address creator, uint256 offerId, string memory id) internal {
        uint256 dueAt = OfferCancelFacet(diamond).getOffer(offerId).createdAt + LibVaipakam.MIN_OFFER_CANCEL_DELAY;
        _requireRefused(
            creator,
            abi.encodeWithSelector(OfferCancelFacet.cancelOffer.selector, offerId),
            abi.encodeWithSelector(OfferCancelFacet.CancelCooldownActive.selector),
            string.concat(id, ": a cancel inside the cooldown should be refused (CancelCooldownActive)")
        );
        console.log("Cancel refused inside the cooldown; due at", dueAt);
        _nextStepNotBefore(dueAt);
    }

    function _requireOpenOffer(uint256 offerId, address creator, string memory id) internal view {
        LibVaipakam.Offer memory o = OfferCancelFacet(diamond).getOffer(offerId);
        require(o.creator == creator && !o.accepted && o.amountFilled == 0,
            string.concat(id, ": the offer should be open, with nothing of it filled"));
    }

    // ─── PF-116 ───────────────────────────────────────────────────────────

    /// @dev A Monthly-cadence loan. Nothing is paid toward its first period,
    ///      so when the checkpoint is due the whole period's interest is a
    ///      shortfall, and a permissionless settler covers it by selling
    ///      collateral through the fixture's fixed-rate adapter.
    function _periodicCheckpoint(uint256 step) internal {
        if (step == 0) return _openPeriodicOffer();
        if (step == 1) return _acceptPeriodicOffer();
        _settlePeriodicLoan();
    }

    /// @dev Step 1: the settings the loan needs, and its funding offer.
    function _openPeriodicOffer() internal {
        bool switchWasOff = !NumeraireConfigFacet(diamond).getPeriodicInterestEnabled();
        _keep(SWITCH_WAS_OFF, switchWasOff ? 1 : 0);
        if (switchWasOff) {
            _setPeriodicSwitch(true);
            _toRestore(PERIODIC_SWITCH, 0);
            console.log("Periodic-interest switch turned on; the last step turns it off again");
        }
        // The adapter the settle sells through, registered a month before it
        // is used, so the settle stage only reads that it is there.
        (FixedRateSwapAdapter adapter,) = _registerRunSwapAdapter();
        _keep(ADAPTER, uint256(uint160(address(adapter))));
        console.log("Settlement adapter registered:", address(adapter));

        // A finer cadence than None needs the principal's value at or above
        // the threshold, at posting and again when the loan opens. Lower it
        // until the accept, which puts it back.
        uint256 thresholdWas = NumeraireConfigFacet(diamond).getMinPrincipalForFinerCadence();
        bool lowered = thresholdWas > PERIODIC_PRINCIPAL_NUMERAIRE;
        _keep(THRESHOLD_LOWERED, lowered ? 1 : 0);
        if (lowered) {
            _setFinerCadenceThreshold(LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_FLOOR);
            _toRestore(FINER_CADENCE_THRESHOLD, thresholdWas);
        }

        LibVaipakam.CreateOfferParams memory offer = _lenderOfferStandard();
        offer.amount = PERIODIC_PRINCIPAL;
        offer.amountMax = PERIODIC_PRINCIPAL;
        offer.collateralAmount = PERIODIC_COLLATERAL;
        offer.collateralAmountMax = PERIODIC_COLLATERAL;
        offer.durationDays = PERIODIC_DURATION_DAYS;
        offer.periodicInterestCadence = LibVaipakam.PeriodicInterestCadence.Monthly;
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, PERIODIC_PRINCIPAL);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(offer, type(uint64).max);
        vm.stopBroadcast();
        _keep(OFFER, offerId);
        console.log("Monthly-cadence lender offer created:", offerId);
    }

    /// @dev Step 2, once the offer's terms have aged: the loan opens with its
    ///      cadence, the threshold goes back, and a settle before the
    ///      checkpoint and its grace is refused. The next step waits for both.
    function _acceptPeriodicOffer() internal {
        uint256 loanId = _acceptAs(borrowerKey, _kept(OFFER), address(weth), PERIODIC_COLLATERAL);
        _keep(LOAN, loanId);
        console.log("Monthly-cadence loan initiated:", loanId);
        if (_kept(THRESHOLD_LOWERED) == 1) {
            _restore(FINER_CADENCE_THRESHOLD, _restoreValueOf(FINER_CADENCE_THRESHOLD));
            console.log("Finer-cadence principal threshold put back");
        }

        (uint8 cadence, uint256 periodEndAt, uint256 graceEndsAt,,,, bool canSettleNow) =
            RepayPeriodicFacet(diamond).previewPeriodicSettle(loanId);
        require(cadence == uint8(LibVaipakam.PeriodicInterestCadence.Monthly) && !canSettleNow,
            "PF-116: the loan should carry a Monthly cadence that is not yet due");
        _requireRefused(
            newLender,
            abi.encodeWithSelector(
                RepayPeriodicFacet.settlePeriodicInterest.selector, loanId, uint256(0), new LibSwap.AdapterCall[](0)
            ),
            abi.encodeWithSelector(IVaipakamErrors.PeriodicSettleNotDue.selector, loanId, periodEndAt, graceEndsAt),
            "PF-116: a settle before the checkpoint and its grace should be refused (PeriodicSettleNotDue)"
        );
        console.log("Settle refused before the checkpoint; due at", graceEndsAt);
        _nextStepNotBefore(graceEndsAt);
    }

    /// @dev Step 3, once the checkpoint and its grace have passed: settle it
    ///      from collateral, close the loan out, and put back the switch and
    ///      the adapter.
    function _settlePeriodicLoan() internal {
        uint256 loanId = _kept(LOAN);
        FixedRateSwapAdapter adapter = FixedRateSwapAdapter(address(uint160(_kept(ADAPTER))));
        _settleCheckpoint(loanId, adapter);
        _repayInFull(borrowerKey, loanId);
        _claimUnclaimed(loanId);

        _removeFixedRateAdapter(adapter);
        console.log("Settlement adapter removed from the swap list:", address(adapter));
        if (_kept(SWITCH_WAS_OFF) == 1) {
            _setPeriodicSwitch(false);
            console.log("Periodic-interest switch put back off");
        }
    }

    /// @dev Every unit of the sale is accounted for: the settler's bonus,
    ///      the treasury's handling fee, the lender's share and what is left
    ///      over for the borrower add up to exactly what the swap returned,
    ///      the lender's share covers the period's interest and is credited
    ///      against the loan's interest, and the loan's collateral falls by
    ///      exactly what was sold. The sale is sized to clear the interest
    ///      after its fees even at the worst price the slippage floor allows,
    ///      so at the fixed-rate adapter's price something is left over, and
    ///      it goes to the borrower (#2876).
    function _settleCheckpoint(uint256 loanId, FixedRateSwapAdapter adapter) internal {
        LibVaipakam.Loan memory before = LoanFacet(diamond).getLoanDetails(loanId);
        (,,, uint256 expected,, uint256 shortfall, bool canSettleNow) =
            RepayPeriodicFacet(diamond).previewPeriodicSettle(loanId);
        require(canSettleNow && shortfall == expected && shortfall > 0,
            "PF-116: the checkpoint should be due, with the whole period's interest unpaid");

        require(_isSwapAdapter(address(adapter)),
            "PF-116: the first step's settlement adapter should still be on the Diamond's swap list");
        LibSwap.AdapterCall[] memory route = _swapRouteFor(address(adapter));
        Balances memory b0 = _balances(adapter);
        // The settler quotes the host's plan, as a keeper does (#2796).
        uint256 sellAmount = ForcedSalePreviewFacet(diamond)
            .previewForcedSale(loanId, ForcedSaleFacet.ForcedSaleKind.PeriodicSettlement).sell;
        vm.startBroadcast(newLenderKey);
        RepayPeriodicFacet(diamond).settlePeriodicInterest(loanId, sellAmount, route);
        vm.stopBroadcast();
        _requireSettleAccounted(loanId, before, b0, _balances(adapter), shortfall);
    }

    /// @dev Each side claims if it has not yet; the loan then settles.
    function _claimUnclaimed(uint256 loanId) internal {
        (,, bool lenderClaimed) = ClaimViewFacet(diamond).getClaimableAmount(loanId, true);
        if (!lenderClaimed) {
            vm.startBroadcast(lenderKey);
            ClaimFacet(diamond).claimAsLender(loanId);
            vm.stopBroadcast();
        }
        (,, bool borrowerClaimed) = ClaimViewFacet(diamond).getClaimableAmount(loanId, false);
        if (!borrowerClaimed) {
            vm.startBroadcast(borrowerKey);
            ClaimFacet(diamond).claimAsBorrower(loanId);
            vm.stopBroadcast();
        }
        require(LoanFacet(diamond).getLoanDetails(loanId).status == LibVaipakam.LoanStatus.Settled,
            "PF-116: the loan should settle once both sides have claimed");
        console.log("Both parties claimed for loanId:", loanId);
    }

    /// @dev The balances PF-116's settle moves, read before and after it.
    struct Balances {
        uint256 adapterWeth;
        uint256 adapterUsdc;
        uint256 lender;
        uint256 settler;
        uint256 treasury;
        uint256 borrower;
    }

    function _balances(FixedRateSwapAdapter adapter) internal view returns (Balances memory) {
        return Balances({
            adapterWeth: weth.balanceOf(address(adapter)),
            adapterUsdc: usdc.balanceOf(address(adapter)),
            lender: usdc.balanceOf(lender) + _vaultBalance(usdc, lender),
            settler: usdc.balanceOf(newLender),
            treasury: _treasuryUsdc(),
            borrower: usdc.balanceOf(borrower) + _vaultBalance(usdc, borrower)
        });
    }

    /// @dev What the settle moved, from the balances before and after it.
    struct Moved {
        uint256 sold;
        uint256 proceeds;
        uint256 lenderIn;
        uint256 settlerIn;
        uint256 treasuryIn;
        uint256 borrowerIn;
    }

    function _requireSettleAccounted(
        uint256 loanId,
        LibVaipakam.Loan memory before,
        Balances memory b0,
        Balances memory b1,
        uint256 shortfall
    ) internal view {
        Moved memory m = Moved({
            sold: b1.adapterWeth - b0.adapterWeth,
            proceeds: b0.adapterUsdc - b1.adapterUsdc,
            lenderIn: b1.lender - b0.lender,
            settlerIn: b1.settler - b0.settler,
            treasuryIn: b1.treasury - b0.treasury,
            borrowerIn: b1.borrower - b0.borrower
        });
        LibVaipakam.Loan memory afterLoan = LoanFacet(diamond).getLoanDetails(loanId);
        _requireSaleSplit(before, afterLoan, m, shortfall);
        _requireCheckpointAdvanced(loanId, before, afterLoan, m.lenderIn);
        console.log("Shortfall / collateral sold (WETH) / proceeds:", shortfall, m.sold, m.proceeds);
        console.log("Lender / settler bonus / treasury fee:", m.lenderIn, m.settlerIn, m.treasuryIn);
        console.log("Left over for the borrower:", m.borrowerIn);
    }

    function _requireSaleSplit(
        LibVaipakam.Loan memory before,
        LibVaipakam.Loan memory afterLoan,
        Moved memory m,
        uint256 shortfall
    ) internal pure {
        require(before.collateralAmount - afterLoan.collateralAmount == m.sold && m.sold > 0,
            "PF-116: the loan's collateral should fall by exactly what was sold");
        require(m.lenderIn + m.settlerIn + m.treasuryIn + m.borrowerIn == m.proceeds,
            "PF-116: the lender, settler, treasury and borrower shares should add up to the proceeds");
        require(m.lenderIn >= shortfall, "PF-116: the lender's share should cover the period's interest");
        require(m.treasuryIn > 0, "PF-116: the treasury should take its handling fee");
    }

    function _requireCheckpointAdvanced(
        uint256 loanId,
        LibVaipakam.Loan memory before,
        LibVaipakam.Loan memory afterLoan,
        uint256 lenderIn
    ) internal view {
        require(afterLoan.status == LibVaipakam.LoanStatus.Active, "PF-116: the loan should stay Active");
        require(afterLoan.interestSettled - before.interestSettled == lenderIn,
            "PF-116: the lender's share should be credited against the loan's interest");
        uint256 moved = uint256(afterLoan.lastPeriodicInterestSettledAt) - uint256(before.lastPeriodicInterestSettledAt);
        require(moved == LibVaipakam.PERIODIC_INTERVAL_MONTHLY_DAYS * 1 days,
            "PF-116: the checkpoint should move on by exactly one period");
        // The next checkpoint may already be due, if the settle stage ran
        // after its grace too (from about day 61). The scenario settles one
        // checkpoint and then closes the loan, so that is stated, not refused.
        (,,,,,, bool nextDue) = RepayPeriodicFacet(diamond).previewPeriodicSettle(loanId);
        if (nextDue) console.log("The next checkpoint is due as well; the full repayment covers it");
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    function _setPeriodicSwitch(bool on) internal {
        vm.startBroadcast(adminKey);
        NumeraireConfigFacet(diamond).setPeriodicInterestEnabled(on);
        vm.stopBroadcast();
    }

    function _setFinerCadenceThreshold(uint256 value) internal {
        vm.startBroadcast(adminKey);
        NumeraireConfigFacet(diamond).setMinPrincipalForFinerCadence(value);
        vm.stopBroadcast();
    }
}
