// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {PositiveFlowsBase} from "./PositiveFlowsBase.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibSwap} from "../../src/libraries/LibSwap.sol";
import {IVaipakamErrors} from "../../src/interfaces/IVaipakamErrors.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../../src/facets/OfferCancelFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {NumeraireConfigFacet} from "../../src/facets/NumeraireConfigFacet.sol";
import {RepayPeriodicFacet} from "../../src/facets/RepayPeriodicFacet.sol";
import {ForcedSaleFacet} from "../../src/facets/ForcedSaleFacet.sol";
import {Deployments} from "../lib/Deployments.sol";
import {FixedRateSwapAdapter} from "../mocks/FixedRateSwapAdapter.sol";

/**
 * @title PositiveFlowsTimed
 * @notice The positive flows that need the chain clock to move between two of
 *         their steps (#848 Phase 2): cancelling an unaccepted offer after the
 *         cancel cooldown (PF-045, PF-046), and a periodic-interest checkpoint
 *         settled once it is due (PF-116).
 *
 *         A forge script cannot step the clock between its own transactions:
 *         `vm.warp` moves the simulation only, and the broadcast mines every
 *         transaction at the chain's own time. So these run in STAGES, each
 *         its own `forge script` invocation, with the clock stepped between
 *         the first two:
 *
 *           1. `open()` builds the fixture, opens each scenario's position,
 *              shows the step that must wait is refused while it waits, and
 *              records the fixture, the positions and the earliest moment the
 *              second stage may run in `deployments/<slug>/positive-flows-timed.json`.
 *           2. `settle()` refuses to run before that moment, binds the first
 *              stage's mocks again, completes whatever the chain shows is
 *              still open, and restores what the first stage changed. It
 *              keeps the record.
 *           3. `finish()` sends nothing. It reads the chain, and removes the
 *              record only once nothing the record names is still open and
 *              nothing the first stage changed is still changed.
 *
 *         THE RECORD IS A POINTER, NOT THE AUTHORITY. Forge runs a script's
 *         whole simulation, and writes its files, before it broadcasts
 *         anything, so a record says what a stage MEANT to send, not what
 *         landed. Every stage therefore reads each position's state from the
 *         chain before acting on it: `settle()` skips, and says so, a
 *         position that is not open there (an earlier settle closed it, or
 *         the open never landed) and resumes a half-closed one, and only the
 *         read-only `finish()` may remove the record. A broadcast that fails
 *         part-way through either stage leaves the record in place: run
 *         `settle()` again, then `finish()`, and `finish()` also clears a
 *         record whose open never landed.
 *
 *         `script/positive-flows/run-timed.sh` runs all three on a local Anvil
 *         and steps its clock. On any other chain the operator runs the
 *         stages by hand and waits out the real time, which for PF-116 is a
 *         month. `open()` writes the record only on a `--broadcast` run, so a
 *         dry run of it changes nothing.
 *
 *         In the one-pass runner ({PositiveFlows}, or `run()`), a scenario
 *         whose wait applies says SKIP and names the staged run. The cancel
 *         cooldown applies only while partial fills are on, so PF-045 and
 *         PF-046 run in one pass where they are off.
 *
 *         What the first stage changes until the second restores it: when the
 *         periodic-interest switch is off, PF-116 turns it on, and it stays on
 *         until `settle()` turns it off again. The finer-cadence principal
 *         threshold is lowered for the loan's creation only and restored
 *         within the first stage. The record carries every position the first
 *         stage creates (PF-116's funding offer as well as its loan) and every
 *         setting it changes, with the value it found, so a first stage that
 *         stops part-way leaves nothing `settle()` cannot close or restore and
 *         `finish()` cannot check. Fixture, runner and ids: {PositiveFlowsBase}.
 *
 *         ONLY THE OPEN STAGE CREATES OR CHANGES ANYTHING. `settle()` only
 *         closes what the record names and restores what it records as
 *         changed, so a settle broadcast that stops part-way leaves nothing
 *         the record does not already name. That is why PF-116's settlement
 *         adapter is registered by the open stage, a month before it is used,
 *         and not by the settle stage that sells through it.
 */
contract PositiveFlowsTimed is PositiveFlowsBase {
    /// @dev PF-116's principal: twice the fixture's loan, so its value sits
    ///      clearly above the lowest finer-cadence threshold governance may set.
    uint256 private constant PERIODIC_PRINCIPAL = 2 * LOAN_AMOUNT;
    /// @dev The same principal in numeraire units (1e18-scaled USD at $1 per USDC).
    uint256 private constant PERIODIC_PRINCIPAL_NUMERAIRE = 2_000e18;
    uint256 private constant PERIODIC_COLLATERAL = 2 * COLLATERAL_AMOUNT;
    /// @dev Longer than the 30-day Monthly interval, which must be strictly
    ///      shorter than the loan.
    uint256 private constant PERIODIC_DURATION_DAYS = 60;

    string private constant STATE_FILE = "positive-flows-timed.json";
    uint256 private constant STATE_VERSION = 3;

    // ── What the first stage opened (0 = not opened) ─────────────────────
    uint256 private lenderOfferId;
    uint256 private borrowerOfferId;
    /// @dev PF-116's funding offer, recorded beside its loan: an open that
    ///      stops after the offer lands and before the accept leaves this
    ///      offer funded and no loan.
    uint256 private periodicOfferId;
    uint256 private periodicLoanId;
    bool private periodicSwitchWasOn;
    /// @dev The finer-cadence threshold PF-116 found, and whether it lowered
    ///      it. The open restores it once the loan carries its cadence; an
    ///      open that stops in between leaves it lowered.
    uint256 private finerCadenceThresholdWas;
    bool private finerCadenceThresholdLowered;
    /// @dev The fixed-rate adapter PF-116's settle sells through. The open
    ///      stage registers it, before the loan's offer, so a loan on the
    ///      chain means the adapter is too; the settle stage removes it.
    FixedRateSwapAdapter private settlementAdapter;
    /// @dev The earliest timestamp at which every opened scenario can settle.
    uint256 private settleAfter;

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

    // ─── One-pass run ─────────────────────────────────────────────────────

    /// @dev Runs a scenario in one pass where its wait does not apply, and
    ///      skips it, naming the staged run, where it does.
    function _runScenario(uint256 index) internal override {
        if (index == 2) {
            return _skip("a periodic checkpoint is due a month after the loan starts;"
                " use the staged run (script/positive-flows/run-timed.sh)");
        }
        if (_cancelCooldownApplies()) {
            return _skip("the 5-minute cancel cooldown applies (partial fills on);"
                " use the staged run (script/positive-flows/run-timed.sh)");
        }
        _openScenario(index);
        _settleScenario(index);
    }

    // ─── Staged run ───────────────────────────────────────────────────────

    /// @notice Stage 1: open every scenario (or the one `ONLY_SCENARIO`
    ///         names) and record what the second stage needs.
    function open() external returns (uint256 passed, uint256 skipped) {
        string memory only = vm.envOr("ONLY_SCENARIO", string(""));
        if (bytes(only).length != 0 && !hasScenario(only)) {
            revert(string.concat(moduleName(), ": unknown ONLY_SCENARIO ", only));
        }
        string memory path = Deployments.namedPath(STATE_FILE);
        require(!vm.exists(path), string.concat(
            "PositiveFlowsTimed: ", path, " already records an open run. Run settle() and then finish(),",
            " which removes the record once the chain shows nothing it names is still open (also when that",
            " run's open never landed)"
        ));

        _beginModule("open");
        _deployFixture();
        (passed, skipped) = _runEach(only, _openScenario, "open");
        _writeState(path);
    }

    /// @notice Stage 2: complete whatever the first stage opened that the
    ///         chain shows is still open, and restore what it changed. Keeps
    ///         the record; {finish} removes it once the chain confirms.
    function settle() external returns (uint256 passed, uint256 skipped) {
        string memory path = Deployments.namedPath(STATE_FILE);
        require(vm.exists(path), string.concat(
            "PositiveFlowsTimed: no open run is recorded at ", path, "; run the open stage first"
        ));
        _beginModule("settle");
        FixtureAddresses memory f = _readState(path);
        require(block.timestamp >= settleAfter, string.concat(
            "PositiveFlowsTimed: too early to settle. The chain is at ", vm.toString(block.timestamp),
            " and the open run is due at ", vm.toString(settleAfter),
            ". On a local Anvil, script/positive-flows/run-timed.sh steps the clock; elsewhere, wait"
        ));
        _attachFixture(f);
        (passed, skipped) = _runEach("", _settleScenario, "settle");

        if (_periodicSwitchStillChanged()) {
            _setPeriodicSwitch(false);
            console.log("Periodic-interest switch restored to off");
        }
        if (_finerCadenceThresholdStillChanged()) {
            _restoreFinerCadenceThreshold();
            console.log("Finer-cadence principal threshold restored to", finerCadenceThresholdWas);
        }
        if (_settlementAdapterStillRegistered()) {
            _removeFixedRateAdapter(settlementAdapter);
            console.log("Settlement adapter removed from the swap list:", address(settlementAdapter));
        }
        console.log("The record is kept until finish() confirms the chain:", path);
    }

    /// @notice Stage 3: remove the record once the chain shows that nothing
    ///         it names is still open and the periodic-interest switch is
    ///         back where the first stage found it. Sends no transaction, so
    ///         run it without `--broadcast`, after the settle stage's
    ///         broadcast has landed. Refuses, keeping the record and naming
    ///         what is still open, otherwise.
    function finish() external {
        string memory path = Deployments.namedPath(STATE_FILE);
        require(vm.exists(path), string.concat("PositiveFlowsTimed: no open run is recorded at ", path));
        _beginModule("finish");
        _readState(path);
        string memory open = _stillOpen();
        require(bytes(open).length == 0, string.concat(
            "PositiveFlowsTimed: the record is kept, because the chain still shows", open,
            ". Run the settle stage, then finish() again"
        ));
        vm.removeFile(path);
        console.log("Nothing the record names is still open on the chain; record removed:", path);
    }

    function _openScenario(uint256 index) internal {
        if (index == 0) _openLenderOffer();
        else if (index == 1) _openBorrowerOffer();
        else if (index == 2) _openPeriodicLoan();
        else revert("PositiveFlowsTimed: no scenario at index");
    }

    /// @dev Acts only on what the chain shows is still open: see "THE RECORD
    ///      IS A POINTER" in the contract notice.
    function _settleScenario(uint256 index) internal {
        if (index == 0) {
            if (lenderOfferId == 0) return _skip("not opened by the open stage");
            if (!_offerStillOpen(lenderOfferId, lender)) return _skip(NOT_OPEN_ON_CHAIN);
            _cancelLenderOffer();
        } else if (index == 1) {
            if (borrowerOfferId == 0) return _skip("not opened by the open stage");
            if (!_offerStillOpen(borrowerOfferId, borrower)) return _skip(NOT_OPEN_ON_CHAIN);
            _cancelBorrowerOffer();
        } else if (index == 2) {
            if (periodicLoanId == 0) return _skip("not opened by the open stage");
            if (_periodicLoanStillOpen()) return _settlePeriodicLoan();
            if (!_offerStillOpen(periodicOfferId, lender)) return _skip(NOT_OPEN_ON_CHAIN);
            _cancelPeriodicOffer();
        } else {
            revert("PositiveFlowsTimed: no scenario at index");
        }
    }

    string private constant NOT_OPEN_ON_CHAIN =
        "the recorded position is not open on this chain: an earlier settle closed it, or the open never landed";

    /// @dev What the chain shows is still open of the record, as a list for a
    ///      refusal; empty when nothing is.
    function _stillOpen() internal view returns (string memory open) {
        if (lenderOfferId != 0 && _offerStillOpen(lenderOfferId, lender)) {
            open = _listed(open, string.concat("PF-045's lender offer ", vm.toString(lenderOfferId), " open"));
        }
        if (borrowerOfferId != 0 && _offerStillOpen(borrowerOfferId, borrower)) {
            open = _listed(open, string.concat("PF-046's borrower offer ", vm.toString(borrowerOfferId), " open"));
        }
        if (periodicLoanId != 0 && _periodicLoanStillOpen()) {
            open = _listed(open, string.concat("PF-116's loan ", vm.toString(periodicLoanId), " not settled"));
        }
        if (periodicOfferId != 0 && _offerStillOpen(periodicOfferId, lender)) {
            open = _listed(open, string.concat("PF-116's funding offer ", vm.toString(periodicOfferId), " open"));
        }
        if (_periodicSwitchStillChanged()) {
            open = _listed(open, "the periodic-interest switch still on");
        }
        if (_finerCadenceThresholdStillChanged()) {
            open = _listed(open, "the finer-cadence principal threshold still lowered");
        }
        if (_settlementAdapterStillRegistered()) {
            open = _listed(open, "PF-116's settlement adapter still on the swap list");
        }
    }

    function _listed(string memory list, string memory item) internal pure returns (string memory) {
        return bytes(list).length == 0 ? string.concat(" ", item) : string.concat(list, "; ", item);
    }

    /// @dev An offer of this run's `creator` that no one has accepted. A slot
    ///      whose creator is someone else is not this run's: the open that
    ///      recorded the id never landed, and the id went to another offer.
    function _offerStillOpen(uint256 offerId, address creator) internal view returns (bool) {
        LibVaipakam.Offer memory o = OfferCancelFacet(diamond).getOffer(offerId);
        return o.creator == creator && !o.accepted;
    }

    /// @dev This run's loan (its borrower is the fixture's), not yet settled.
    function _periodicLoanStillOpen() internal view returns (bool) {
        LibVaipakam.Loan memory l = LoanFacet(diamond).getLoanDetails(periodicLoanId);
        return l.borrower == borrower && l.status != LibVaipakam.LoanStatus.Settled;
    }

    /// @dev The first stage turned the switch on, and it is still on.
    function _periodicSwitchStillChanged() internal view returns (bool) {
        return periodicLoanId != 0 && !periodicSwitchWasOn
            && NumeraireConfigFacet(diamond).getPeriodicInterestEnabled();
    }

    function _settlementAdapterStillRegistered() internal view returns (bool) {
        return address(settlementAdapter) != address(0) && _isSwapAdapter(address(settlementAdapter));
    }

    /// @dev The first stage lowered the threshold, and it is not back.
    function _finerCadenceThresholdStillChanged() internal view returns (bool) {
        return finerCadenceThresholdLowered
            && NumeraireConfigFacet(diamond).getMinPrincipalForFinerCadence() != finerCadenceThresholdWas;
    }

    /// @dev Puts back the threshold PF-116 found. The getter reports the
    ///      effective value, so a threshold left at the library default is
    ///      written back as 0, which is how the setter says "use the default".
    function _restoreFinerCadenceThreshold() internal {
        _setFinerCadenceThreshold(
            finerCadenceThresholdWas == LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_DEFAULT
                ? 0
                : finerCadenceThresholdWas
        );
    }

    // ─── PF-045 / PF-046 ──────────────────────────────────────────────────

    /// @dev The Diamond refuses a cancel within `MIN_OFFER_CANCEL_DELAY` of
    ///      an offer's creation while partial fills are on and nothing of the
    ///      offer is filled. `OfferFacetCancelCooldownTest` covers the gate's
    ///      edges; these scenarios show it holds, then lets go, on a chain.
    function _cancelCooldownApplies() internal view returns (bool) {
        bool partialFillOn = ConfigFacet(diamond).getPartialFillEnabled();
        return partialFillOn;
    }

    function _openLenderOffer() internal {
        lenderOfferId = _createLenderOffer(lenderKey);
        _requireCooldownHolds(lender, lenderOfferId, "PF-045");
    }

    function _openBorrowerOffer() internal {
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        borrowerOfferId = OfferCreateFacet(diamond).createOffer(_borrowerOfferStandard());
        vm.stopBroadcast();
        console.log("Borrower offer created:", borrowerOfferId);
        _requireCooldownHolds(borrower, borrowerOfferId, "PF-046");
    }

    /// @dev Where the cooldown applies, the creator's cancel is refused now,
    ///      and the scenario becomes due when the cooldown ends.
    function _requireCooldownHolds(address creator, uint256 offerId, string memory id) internal {
        uint256 dueAt = OfferCancelFacet(diamond).getOffer(offerId).createdAt + LibVaipakam.MIN_OFFER_CANCEL_DELAY;
        if (_cancelCooldownApplies()) {
            _requireRefused(
                creator,
                abi.encodeWithSelector(OfferCancelFacet.cancelOffer.selector, offerId),
                abi.encodeWithSelector(OfferCancelFacet.CancelCooldownActive.selector),
                string.concat(id, ": a cancel inside the cooldown should be refused (CancelCooldownActive)")
            );
            console.log("Cancel refused inside the cooldown; due at", dueAt);
        }
        _noteDue(dueAt);
    }

    function _cancelLenderOffer() internal {
        _requireOpenOffer(lenderOfferId, lender, "PF-045");
        uint256 before = usdc.balanceOf(lender);
        vm.startBroadcast(lenderKey);
        OfferCancelFacet(diamond).cancelOffer(lenderOfferId);
        vm.stopBroadcast();
        require(usdc.balanceOf(lender) - before == LOAN_AMOUNT,
            "PF-045: the cancel should return exactly the locked principal");
        require(OfferCancelFacet(diamond).getOffer(lenderOfferId).creator == address(0),
            "PF-045: the cancelled offer should be gone");
        console.log("Lender offer cancelled; principal returned:", LOAN_AMOUNT);
    }

    function _cancelBorrowerOffer() internal {
        _requireOpenOffer(borrowerOfferId, borrower, "PF-046");
        uint256 before = weth.balanceOf(borrower);
        vm.startBroadcast(borrowerKey);
        OfferCancelFacet(diamond).cancelOffer(borrowerOfferId);
        vm.stopBroadcast();
        require(weth.balanceOf(borrower) - before == COLLATERAL_AMOUNT,
            "PF-046: the cancel should return exactly the locked collateral");
        require(OfferCancelFacet(diamond).getOffer(borrowerOfferId).creator == address(0),
            "PF-046: the cancelled offer should be gone");
        console.log("Borrower offer cancelled; collateral returned:", COLLATERAL_AMOUNT);
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
    function _openPeriodicLoan() internal {
        periodicSwitchWasOn = NumeraireConfigFacet(diamond).getPeriodicInterestEnabled();
        if (!periodicSwitchWasOn) {
            _setPeriodicSwitch(true);
            console.log("Periodic-interest switch turned on; the settle stage turns it off again");
        }
        // A finer cadence than None needs the principal's value at or above
        // the threshold. Lower it for this loan's creation only, and put it
        // back once the loan carries its cadence ({_restoreFinerCadenceThreshold}).
        // The adapter the settle stage sells through, registered first: the
        // broadcast lands in order, so if the loan exists, so does this.
        (settlementAdapter,) = _registerFixedRateAdapter();
        console.log("Settlement adapter registered:", address(settlementAdapter));

        finerCadenceThresholdWas = NumeraireConfigFacet(diamond).getMinPrincipalForFinerCadence();
        finerCadenceThresholdLowered = finerCadenceThresholdWas > PERIODIC_PRINCIPAL_NUMERAIRE;
        if (finerCadenceThresholdLowered) {
            _setFinerCadenceThreshold(LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_FLOOR);
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
        periodicOfferId = OfferCreateFacet(diamond).createOffer(offer);
        vm.stopBroadcast();
        periodicLoanId = _acceptAs(borrowerKey, periodicOfferId, address(weth), PERIODIC_COLLATERAL);
        if (finerCadenceThresholdLowered) _restoreFinerCadenceThreshold();
        console.log("Monthly-cadence loan initiated:", periodicLoanId);

        (uint8 cadence, uint256 periodEndAt, uint256 graceEndsAt,,,, bool canSettleNow) =
            RepayPeriodicFacet(diamond).previewPeriodicSettle(periodicLoanId);
        require(cadence == uint8(LibVaipakam.PeriodicInterestCadence.Monthly) && !canSettleNow,
            "PF-116: the loan should carry a Monthly cadence that is not yet due");
        _requireRefused(
            newLender,
            abi.encodeWithSelector(
                RepayPeriodicFacet.settlePeriodicInterest.selector, periodicLoanId, uint256(0),
                new LibSwap.AdapterCall[](0)
            ),
            abi.encodeWithSelector(IVaipakamErrors.PeriodicSettleNotDue.selector, periodicLoanId, periodEndAt, graceEndsAt),
            "PF-116: a settle before the checkpoint and its grace should be refused (PeriodicSettleNotDue)"
        );
        console.log("Settle refused before the checkpoint; due at", graceEndsAt);
        _noteDue(graceEndsAt);
    }

    /// @dev Three steps, each taken only while the chain shows it is still
    ///      owed, so a settle stage whose broadcast stopped part-way resumes
    ///      where it stopped: the checkpoint settle, the full repayment, and
    ///      each side's claim. The scenario PASSES only when this run settled
    ///      the checkpoint, the step it exists for. Otherwise it closes the
    ///      loan out and reports a SKIP that says why: an earlier settle run
    ///      settled the checkpoint (and checked its accounting then), or the
    ///      loan was repaid before any run settled it.
    function _settlePeriodicLoan() internal {
        LibVaipakam.Loan memory l = LoanFacet(diamond).getLoanDetails(periodicLoanId);
        bool settledEarlier = l.lastPeriodicInterestSettledAt > l.startTime;
        bool settledHere = l.status == LibVaipakam.LoanStatus.Active && !settledEarlier;
        if (settledHere) _settleCheckpoint(l);
        if (l.status == LibVaipakam.LoanStatus.Active) _repayInFull(borrowerKey, periodicLoanId);
        require(LoanFacet(diamond).getLoanDetails(periodicLoanId).status == LibVaipakam.LoanStatus.Repaid,
            "PF-116: the loan should be repaid before its claims");
        _claimUnclaimed(periodicLoanId);
        if (settledHere) return;
        _skip(settledEarlier
            ? "the checkpoint was settled, and its accounting checked, by an earlier settle run; this run closed the loan out"
            : "the loan was repaid before any settle run settled its checkpoint; this run closed it out");
    }

    /// @dev The open stopped after PF-116's funding offer landed and before
    ///      the borrower's accept did, so there is an offer and no loan. The
    ///      lender's principal is returned, and the scenario reports a SKIP:
    ///      the checkpoint it exists for was never reached.
    function _cancelPeriodicOffer() internal {
        uint256 before = usdc.balanceOf(lender);
        vm.startBroadcast(lenderKey);
        OfferCancelFacet(diamond).cancelOffer(periodicOfferId);
        vm.stopBroadcast();
        require(usdc.balanceOf(lender) - before == PERIODIC_PRINCIPAL,
            "PF-116: the cancel should return exactly the funding offer's principal");
        _skip("the open stopped before its loan began; its funding offer was cancelled and the principal returned");
    }

    /// @dev Every unit of the sale is accounted for: the settler's bonus,
    ///      the treasury's handling fee and the lender's share add up to
    ///      exactly what the swap returned, the lender's share covers the
    ///      period's interest and is credited against the loan's interest,
    ///      and the loan's collateral falls by exactly what was sold.
    function _settleCheckpoint(LibVaipakam.Loan memory before) internal {
        (,,, uint256 expected,, uint256 shortfall, bool canSettleNow) =
            RepayPeriodicFacet(diamond).previewPeriodicSettle(periodicLoanId);
        require(canSettleNow && shortfall == expected && shortfall > 0,
            "PF-116: the checkpoint should be due, with the whole period's interest unpaid");

        require(_isSwapAdapter(address(settlementAdapter)),
            "PF-116: the open stage's settlement adapter should still be on the Diamond's swap list");
        FixedRateSwapAdapter adapter = settlementAdapter;
        LibSwap.AdapterCall[] memory route = _swapRouteFor(address(adapter));
        Balances memory b0 = _balances(adapter);
        // The settler quotes the host's plan, as a keeper does (#2796).
        uint256 sellAmount = ForcedSaleFacet(diamond)
            .previewForcedSale(periodicLoanId, ForcedSaleFacet.ForcedSaleKind.PeriodicSettlement)
            .sell;
        vm.startBroadcast(newLenderKey);
        RepayPeriodicFacet(diamond).settlePeriodicInterest(periodicLoanId, sellAmount, route);
        vm.stopBroadcast();
        _requireSettleAccounted(before, b0, _balances(adapter), shortfall);
    }

    /// @dev Each side claims if it has not yet; the loan then settles.
    function _claimUnclaimed(uint256 loanId) internal {
        (,, bool lenderClaimed) = ClaimFacet(diamond).getClaimableAmount(loanId, true);
        if (!lenderClaimed) {
            vm.startBroadcast(lenderKey);
            ClaimFacet(diamond).claimAsLender(loanId);
            vm.stopBroadcast();
        }
        (,, bool borrowerClaimed) = ClaimFacet(diamond).getClaimableAmount(loanId, false);
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
    }

    function _balances(FixedRateSwapAdapter adapter) internal view returns (Balances memory) {
        return Balances({
            adapterWeth: weth.balanceOf(address(adapter)),
            adapterUsdc: usdc.balanceOf(address(adapter)),
            lender: usdc.balanceOf(lender),
            settler: usdc.balanceOf(newLender),
            treasury: _treasuryUsdc()
        });
    }

    /// @dev What the settle moved, from the balances before and after it.
    struct Moved {
        uint256 sold;
        uint256 proceeds;
        uint256 lenderIn;
        uint256 settlerIn;
        uint256 treasuryIn;
    }

    function _requireSettleAccounted(
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
            treasuryIn: b1.treasury - b0.treasury
        });
        LibVaipakam.Loan memory afterLoan = LoanFacet(diamond).getLoanDetails(periodicLoanId);
        _requireSaleSplit(before, afterLoan, m, shortfall);
        _requireCheckpointAdvanced(before, afterLoan, m.lenderIn);
        console.log("Shortfall / collateral sold (WETH) / proceeds:", shortfall, m.sold, m.proceeds);
        console.log("Lender / settler bonus / treasury fee:", m.lenderIn, m.settlerIn, m.treasuryIn);
    }

    function _requireSaleSplit(
        LibVaipakam.Loan memory before,
        LibVaipakam.Loan memory afterLoan,
        Moved memory m,
        uint256 shortfall
    ) internal pure {
        require(before.collateralAmount - afterLoan.collateralAmount == m.sold && m.sold > 0,
            "PF-116: the loan's collateral should fall by exactly what was sold");
        require(m.lenderIn + m.settlerIn + m.treasuryIn == m.proceeds,
            "PF-116: the lender, settler and treasury shares should add up to the proceeds");
        require(m.lenderIn >= shortfall, "PF-116: the lender's share should cover the period's interest");
        require(m.treasuryIn > 0, "PF-116: the treasury should take its handling fee");
    }

    function _requireCheckpointAdvanced(
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
        (,,,,,, bool nextDue) = RepayPeriodicFacet(diamond).previewPeriodicSettle(periodicLoanId);
        if (nextDue) console.log("The next checkpoint is due as well; the full repayment covers it");
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    function _noteDue(uint256 dueAt) internal {
        if (dueAt > settleAfter) settleAfter = dueAt;
    }

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

    /// @dev Writes the open-run record, on a `--broadcast` run only: a dry
    ///      run opened nothing on the chain, so recording it would make the
    ///      next real open refuse and the next settle act on positions that
    ///      do not exist.
    function _writeState(string memory path) internal {
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            console.log("Dry run: no open-run record written");
            return;
        }
        FixtureAddresses memory f = fixtureAddresses();
        string memory k = "positiveFlowsTimed";
        vm.serializeUint(k, "version", STATE_VERSION);
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "diamond", diamond);
        vm.serializeUint(k, "openedAt", block.timestamp);
        vm.serializeUint(k, "settleAfter", settleAfter);
        vm.serializeUint(k, "lenderOfferId", lenderOfferId);
        vm.serializeUint(k, "borrowerOfferId", borrowerOfferId);
        vm.serializeUint(k, "periodicOfferId", periodicOfferId);
        vm.serializeUint(k, "periodicLoanId", periodicLoanId);
        vm.serializeBool(k, "periodicSwitchWasOn", periodicSwitchWasOn);
        vm.serializeUint(k, "finerCadenceThresholdWas", finerCadenceThresholdWas);
        vm.serializeBool(k, "finerCadenceThresholdLowered", finerCadenceThresholdLowered);
        vm.serializeAddress(k, "settlementAdapter", address(settlementAdapter));
        vm.serializeAddress(k, "usdc", f.usdc);
        vm.serializeAddress(k, "weth", f.weth);
        vm.serializeAddress(k, "illiquidToken", f.illiquidToken);
        vm.serializeAddress(k, "illiquidLending", f.illiquidLending);
        vm.serializeAddress(k, "nft721", f.nft721);
        vm.serializeAddress(k, "nft1155", f.nft1155);
        vm.serializeAddress(k, "sanctions", f.sanctions);
        vm.serializeAddress(k, "registry", f.registry);
        vm.serializeAddress(k, "wethFeed", f.wethFeed);
        vm.serializeAddress(k, "univ3", f.univ3);
        string memory json = vm.serializeAddress(k, "pool", f.pool);
        vm.writeJson(json, path);
        console.log("Open-run record written:", path);
        console.log("Settle no earlier than:", settleAfter);
    }

    /// @dev Reads the open-run record into this run, refusing one written for
    ///      another chain, another Diamond or another version of this file.
    function _readState(string memory path) internal returns (FixtureAddresses memory f) {
        string memory json = vm.readFile(path);
        require(vm.parseJsonUint(json, ".version") == STATE_VERSION,
            "PositiveFlowsTimed: the open-run record is from another version of this script");
        require(vm.parseJsonUint(json, ".chainId") == block.chainid,
            "PositiveFlowsTimed: the open-run record is for another chain");
        require(vm.parseJsonAddress(json, ".diamond") == diamond,
            "PositiveFlowsTimed: the open-run record is for another Diamond");
        settleAfter = vm.parseJsonUint(json, ".settleAfter");
        lenderOfferId = vm.parseJsonUint(json, ".lenderOfferId");
        borrowerOfferId = vm.parseJsonUint(json, ".borrowerOfferId");
        periodicOfferId = vm.parseJsonUint(json, ".periodicOfferId");
        periodicLoanId = vm.parseJsonUint(json, ".periodicLoanId");
        periodicSwitchWasOn = vm.parseJsonBool(json, ".periodicSwitchWasOn");
        finerCadenceThresholdWas = vm.parseJsonUint(json, ".finerCadenceThresholdWas");
        finerCadenceThresholdLowered = vm.parseJsonBool(json, ".finerCadenceThresholdLowered");
        settlementAdapter = FixedRateSwapAdapter(vm.parseJsonAddress(json, ".settlementAdapter"));
        f = FixtureAddresses({
            usdc: vm.parseJsonAddress(json, ".usdc"),
            weth: vm.parseJsonAddress(json, ".weth"),
            illiquidToken: vm.parseJsonAddress(json, ".illiquidToken"),
            illiquidLending: vm.parseJsonAddress(json, ".illiquidLending"),
            nft721: vm.parseJsonAddress(json, ".nft721"),
            nft1155: vm.parseJsonAddress(json, ".nft1155"),
            sanctions: vm.parseJsonAddress(json, ".sanctions"),
            registry: vm.parseJsonAddress(json, ".registry"),
            wethFeed: vm.parseJsonAddress(json, ".wethFeed"),
            univ3: vm.parseJsonAddress(json, ".univ3"),
            pool: vm.parseJsonAddress(json, ".pool")
        });
        console.log("Open run recorded at", vm.parseJsonUint(json, ".openedAt"), "; due at", settleAfter);
    }
}
