// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {PositiveFlowsBase} from "./PositiveFlowsBase.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {VaipakamNFTFacet} from "../../src/facets/VaipakamNFTFacet.sol";
import {LibTiming} from "../../src/libraries/LibTiming.sol";
import {Deployments} from "../lib/Deployments.sol";
import {LibSwap} from "../../src/libraries/LibSwap.sol";
import {FixedRateSwapAdapter} from "../mocks/FixedRateSwapAdapter.sol";

/**
 * @title PositiveFlowsStaged
 * @notice The runner for positive-flow modules whose scenarios post an offer
 *         and then fill it (#3502). An offer, or a lender intent, can be
 *         filled only once its terms have stood the minimum age (#3412,
 *         `minTermsAgeSec`, 5 s by default). One `forge script --broadcast`
 *         cannot wait between its own transactions: forge runs the whole
 *         simulation first and then sends the recorded transactions back to
 *         back, so the fill would land seconds too early and revert. A
 *         position NFT is held the same way: it may not move until the
 *         transfer cooldown has passed since value last left its position
 *         (#3413, 5 s by default), so a loan opened and its position handed
 *         on cannot share a broadcast either.
 *
 *         So a scenario here is a list of STEPS, split wherever a step fills
 *         terms an earlier step set or moves a position an earlier step
 *         opened. A step runs in one `forge script` call; the wait passes
 *         between calls. The wait is the longer of the two rules, so either
 *         kind of step may follow any other. A step whose successor must
 *         wait longer than that (an offer cancel after the cancel cooldown,
 *         a periodic checkpoint a month away, #3574) says so with
 *         {_nextStepNotBefore}, and the wait after it is that much longer.
 *
 *         TWO WAYS TO RUN A MODULE.
 *
 *           - `run()` — a simulation (no `--broadcast`). Every scenario runs
 *             its steps back to back, and between two steps the simulation's
 *             clock steps past that wait, as the staged run's wait does on
 *             the chain. Under `--broadcast` it stops at the first such wait
 *             with `StepWaitNeedsStagedRun`, before anything is sent.
 *           - `stage()` — the broadcastable run, one STAGE per call. Stage 1
 *             builds the fixture; every stage then carries the scenarios on
 *             IN ORDER until one of them reaches a step that must wait: the
 *             scenario that was waiting takes its next step, and while a
 *             step finishes its scenario the next scenario starts. Each stage records
 *             in `deployments/<slug>/positive-flows-staged-<module>.json`
 *             the fixture, what the steps kept for the next one, and where
 *             each scenario has got to. Once no scenario has a step left,
 *             `finish()` (no `--broadcast`) confirms the last stage landed,
 *             prints the module's result and removes the record.
 *             `script/positive-flows/run-staged.sh <module>` runs every
 *             stage, waits between them, and then `finish()`.
 *
 *         A STAGE RUNS ONLY ON TOP OF A STAGE THAT LANDED WHOLE. Forge
 *         writes files during the simulation, before it sends anything, so a
 *         record says what a stage MEANT to send. The record therefore also
 *         carries every actor's account nonce as the simulation left it. The
 *         next stage, and `finish()`, compare those with the chain and refuse
 *         to go on when any differs: a broadcast that stopped part-way (or
 *         never started) leaves at least one actor short, and a later stage
 *         would act on positions that do not exist. The refusal names the
 *         actor; the remedy is a fresh run (remove the record). An actor key
 *         used by anything else between stages is refused the same way, so
 *         run one module at a time. Matching nonces show the transactions
 *         were mined, not that they succeeded: a transaction that reverts
 *         still uses its nonce. So both also read forge's own log of the
 *         stage's broadcast (`broadcast/<module>.s.sol/<chain>/stage-latest.json`),
 *         tie it to the record by those nonces, and refuse unless every
 *         transaction in it has a receipt and every receipt is a success.
 *
 *         A wait this runner does not cover is not hidden behind it: an
 *         early stage is refused by the protocol rule itself (a fill too
 *         early by `OfferTermsTooFresh`, a move by `PositionCoolingDown`, a
 *         cancel by `CancelCooldownActive`), and a stage run before the time
 *         its record names is refused by name (`StageNotReady`).
 *
 *         SETTINGS A SCENARIO CHANGES ACROSS A WAIT ARE RECORDED (#3574). A
 *         scenario that changes a protocol setting in one step and puts it
 *         back in a later one leaves the setting changed while it waits,
 *         which for a periodic checkpoint is a month. Such a step names the
 *         setting and the value to put back ({_toRestore}), and the record
 *         keeps that entry for the rest of the run. No step removes it, not
 *         even the one that puts the setting back: a stage's record is written
 *         before its broadcast is sent, so a step that stopped part-way would
 *         otherwise have erased the value before the transaction putting it
 *         back landed. Whether a setting is still changed is read from the
 *         chain, never from the record ({_stillToRestore}): `unwind()` puts
 *         back whatever the chain shows is still changed, and `finish()`
 *         refuses while anything is.
 *
 *         SCENARIOS NEVER INTERLEAVE. A scenario runs to its end before the
 *         next one starts, exactly as in `run()`; only the wall-clock time
 *         between its steps differs. So a setting a scenario changes for its
 *         own run, a price it moves or an intent it holds is never seen by
 *         another scenario part-way, and the stages number about as many as
 *         the module's waits.
 */
abstract contract PositiveFlowsStaged is PositiveFlowsBase {
    /// @dev The record's format. Raised whenever a record written before
    ///      the change would be read differently after it, so the old record
    ///      is refused by name instead of misread. 3: a swap adapter a
    ///      scenario registers is recorded as `swapAdapter_<index>` (the
    ///      timed module's `settlementAdapter` entry is retired).
    uint256 private constant RECORD_VERSION = 3;

    /// @notice `run()` under `--broadcast` reached a wait between two steps.
    ///         A broadcast cannot wait between its own transactions; use the
    ///         staged run. The next step could run from `readyAt`.
    error StepWaitNeedsStagedRun(uint256 readyAt);

    /// @notice A stage was run before the time its record names for it. The
    ///         chain's clock is at `chainTime`; run the stage again from `readyAt`.
    error StageNotReady(uint256 readyAt, uint256 chainTime);

    /// @dev The scenario whose step is running: what {_keep} and {_kept}
    ///      file values under.
    uint256 private _current;

    /// @dev What steps kept for a later step, by `s<index>_<name>`.
    mapping(bytes32 => uint256) private _keptValue;
    mapping(bytes32 => bool) private _keptKnown;
    string[] private _keptKeys;

    /// @dev The earliest time the running scenario's next step may run, as
    ///      its last step declared ({_nextStepNotBefore}); 0 when it declared
    ///      nothing beyond the ordinary wait.
    uint256 private _notBefore;

    /// @dev Settings a step changed and a later step puts back, by name, with
    ///      the value to put back ({_toRestore}).
    string[] private _restoreNames;
    mapping(bytes32 => uint256) private _restoreValue;

    // ── Where each scenario has got to, for a staged run ─────────────────
    mapping(uint256 => bool) private _selected;
    mapping(uint256 => uint256) private _nextStep;
    mapping(uint256 => string) private _skipOf;
    string private _only;

    /// @notice How many steps scenario `index` of {scenarios} takes.
    function _stepCount(uint256 index) internal pure virtual returns (uint256);

    /// @dev Runs step `step` (0-based) of scenario `index`. A step that fills
    ///      terms an earlier step set must be a later step than that one.
    function _runStep(uint256 index, uint256 step) internal virtual;

    /// @dev Whether the setting `name`, recorded with {_toRestore}, still
    ///      differs on the chain from what putting back `value` leaves. The
    ///      base knows one setting, a swap adapter a scenario registered for
    ///      its own run ({_registerRunSwapAdapter}). A module that records
    ///      another overrides this and {_restore}, and passes every name it
    ///      does not know to `super`.
    function _stillToRestore(string memory name, uint256 value) internal view virtual returns (bool) {
        if (_isRunSwapAdapter(name)) return _isSwapAdapter(address(uint160(value)));
        revert(string.concat(moduleName(), ": records no setting called ", name));
    }

    /// @dev Puts back the setting `name`, recorded with {_toRestore}.
    function _restore(string memory name, uint256 value) internal virtual {
        if (_isRunSwapAdapter(name)) return _removeFixedRateAdapter(FixedRateSwapAdapter(address(uint160(value))));
        revert(string.concat(moduleName(), ": records no setting called ", name));
    }

    // ─── A swap adapter registered for one scenario's run ─────────────────

    /// @dev Recorded under this prefix and the scenario's index, with the
    ///      adapter's address: put back means off the Diamond's swap list.
    string private constant RUN_SWAP_ADAPTER = "swapAdapter_";

    /// @dev {PositiveFlowsBase-_registerFixedRateAdapter}, recorded as a
    ///      setting to put back ({_toRestore}), so a run that stops before
    ///      the scenario removes the adapter can be unwound. Remove it with
    ///      {PositiveFlowsBase-_removeFixedRateAdapter} as before; the record
    ///      keeps the entry and the chain shows it put back.
    function _registerRunSwapAdapter()
        internal
        returns (FixedRateSwapAdapter adapter, LibSwap.AdapterCall[] memory route)
    {
        (adapter, route) = _registerFixedRateAdapter();
        _toRestore(string.concat(RUN_SWAP_ADAPTER, vm.toString(_current)), uint256(uint160(address(adapter))));
    }

    function _isRunSwapAdapter(string memory name) private pure returns (bool) {
        bytes memory n = bytes(name);
        bytes memory p = bytes(RUN_SWAP_ADAPTER);
        if (n.length <= p.length) return false;
        for (uint256 i = 0; i < p.length; i++) {
            if (n[i] != p[i]) return false;
        }
        return true;
    }

    // ─── What a step says about the next one ──────────────────────────────

    /// @dev The running scenario's next step may not run before `at`. The
    ///      wait after this step is the longer of this and the ordinary wait
    ///      between steps (the terms age and the transfer cooldown).
    function _nextStepNotBefore(uint256 at) internal {
        if (at > _notBefore) _notBefore = at;
    }

    /// @dev This step changed the setting `name`, and a later step puts back
    ///      `value`. The staged run's record carries it from here to the end
    ///      of the run, so an abandoned run can be unwound ({unwind}) however
    ///      far its last broadcast got; the chain says whether it still needs
    ///      putting back ({_stillToRestore}). A second call for the same name
    ///      keeps the value first recorded: that is what the run found.
    function _toRestore(string memory name, uint256 value) internal {
        bytes32 h = keccak256(bytes(name));
        if (_restoreListed(h)) return;
        _restoreNames.push(name);
        _restoreValue[h] = value;
    }

    /// @dev The value an earlier step recorded to put back for `name`.
    function _restoreValueOf(string memory name) internal view returns (uint256) {
        bytes32 h = keccak256(bytes(name));
        require(_restoreListed(h), string.concat(moduleName(), ": no step recorded the setting ", name, " to put back"));
        return _restoreValue[h];
    }

    /// @dev Whether a step of this run recorded the setting `name`.
    function _restoreRecorded(string memory name) internal view returns (bool) {
        return _restoreListed(keccak256(bytes(name)));
    }

    function _restoreListed(bytes32 h) private view returns (bool) {
        for (uint256 i = 0; i < _restoreNames.length; i++) {
            if (keccak256(bytes(_restoreNames[i])) == h) return true;
        }
        return false;
    }

    // ─── Values one step leaves for the next ──────────────────────────────

    /// @dev Keeps `value` under `name` for a later step of the running
    ///      scenario. A staged run carries it in its record.
    function _keep(string memory name, uint256 value) internal {
        string memory key = _keptKey(_current, name);
        bytes32 h = keccak256(bytes(key));
        if (!_keptKnown[h]) {
            _keptKnown[h] = true;
            _keptKeys.push(key);
        }
        _keptValue[h] = value;
    }

    /// @dev The value an earlier step of the running scenario kept as `name`.
    function _kept(string memory name) internal view returns (uint256) {
        string memory key = _keptKey(_current, name);
        bytes32 h = keccak256(bytes(key));
        require(_keptKnown[h], string.concat(moduleName(), ": no earlier step kept ", key));
        return _keptValue[h];
    }

    function _keptKey(uint256 index, string memory name) private pure returns (string memory) {
        return string.concat("s", vm.toString(index), "_", name);
    }

    // ─── One pass (a simulation) ─────────────────────────────────────────

    /// @dev Every step of scenario `index` in turn, stopping at a skip, with
    ///      the wait between two steps that the staged run takes on the chain.
    function _runScenario(uint256 index) internal override {
        uint256 steps = _stepCount(index);
        for (uint256 step = 0; step < steps; step++) {
            if (step != 0) _waitBetweenSteps();
            _current = index;
            _notBefore = 0;
            _runStep(index, step);
            if (_skipPending()) return;
        }
    }

    /// @dev The simulation's stand-in for the wait between two stages: the
    ///      clock steps past {_waitAfterStep} and into a later block, so
    ///      whatever the last step posted is fillable, whatever it opened
    ///      may move and whatever it said to wait for has passed. A broadcast
    ///      cannot wait between its own transactions, so under `--broadcast`
    ///      this refuses, before anything is sent.
    function _waitBetweenSteps() private {
        uint256 readyAt = block.timestamp + _waitAfterStep();
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) revert StepWaitNeedsStagedRun(readyAt);
        vm.warp(readyAt);
        vm.roll(block.number + 1);
    }

    /// @dev The wait after the step that just ran, in seconds from now: the
    ///      ordinary wait between steps, or longer when the step said so
    ///      ({_nextStepNotBefore}).
    function _waitAfterStep() private view returns (uint256 wait) {
        wait = _stepWaitSec();
        if (_notBefore > block.timestamp && _notBefore - block.timestamp > wait) {
            wait = _notBefore - block.timestamp;
        }
    }

    // ─── Staged run ───────────────────────────────────────────────────────

    /// @notice Runs the next stage: the first (fixture and every scenario's
    ///         first step, or the one `ONLY_SCENARIO` names) when no record
    ///         exists, otherwise the step after the one the record shows for
    ///         every unfinished scenario. Run it with `--broadcast`; a dry run
    ///         writes no record.
    function stage() external {
        string memory path = Deployments.namedPath(_recordFile());
        bool resuming = vm.exists(path);
        string memory json = resuming ? vm.readFile(path) : "";
        uint256 stageNo = resuming ? vm.parseJsonUint(json, ".stage") + 1 : 1;
        _beginModule("");
        console.log(string.concat("Staged run, stage ", vm.toString(stageNo), resuming ? " (resumed from the record)" : ""));

        Scenario[] memory list = scenarios();
        if (!resuming) {
            _only = vm.envOr("ONLY_SCENARIO", string(""));
            if (bytes(_only).length != 0 && !hasScenario(_only)) {
                revert(string.concat(moduleName(), ": unknown ONLY_SCENARIO ", _only));
            }
            for (uint256 i = 0; i < list.length; i++) {
                _selected[i] = bytes(_only).length == 0 || _eq(list[i].id, _only);
            }
            _deployFixture();
        } else {
            _checkRecord(json);
            require(!vm.parseJsonBool(json, ".finished"), string.concat(
                moduleName(), ": every scenario in ", path, " has run its last step; run finish()"
            ));
            _loadProgress(json, list.length);
            _requireLanded(json, "stage");
            uint256 readyAt = vm.parseJsonUint(json, ".readyAt");
            if (block.timestamp < readyAt) revert StageNotReady(readyAt, block.timestamp);
            // Every stage after the first takes at least the waiting
            // scenario's next step, so a run needs no more stages than this.
            require(stageNo <= _maxStages(list.length), string.concat(
                moduleName(), ": ", path, " has run more stages than its scenarios have waits; this is a runner bug"
            ));
            _attachFixture(_recordedFixture(json));
        }

        // Carry the scenarios on in order: the waiting one takes its next
        // step; a scenario whose step finishes it hands over to the next,
        // whose first step waits on nothing. Stop at the first step that
        // leaves its scenario waiting.
        for (uint256 i = 0; i < list.length; i++) {
            if (!_selected[i] || !_hasStepLeft(i)) continue;
            if (!_runNextStep(i, list[i])) break;
        }

        _writeRecord(path, stageNo, list.length);
    }

    /// @notice Confirms on the chain that the last stage landed whole, prints
    ///         the module's result and removes the record. Sends nothing, so
    ///         run it without `--broadcast`, after the last stage's broadcast.
    function finish() external returns (uint256 passed, uint256 skipped) {
        string memory path = Deployments.namedPath(_recordFile());
        require(vm.exists(path), string.concat(moduleName(), ": no staged run is recorded at ", path));
        string memory json = vm.readFile(path);
        _beginModule("finish");
        _checkRecord(json);
        require(vm.parseJsonBool(json, ".finished"), string.concat(
            moduleName(), ": a scenario in ", path, " still has a step to run; run stage() again first"
        ));
        Scenario[] memory list = scenarios();
        _loadProgress(json, list.length);
        _requireLanded(json, "finish");
        string memory changed = _stillChanged();
        require(bytes(changed).length == 0, string.concat(
            moduleName(), ": the chain still shows a setting this run changed (", changed,
            "). Run unwind() with --broadcast to put it back, then finish() again"
        ));
        for (uint256 i = 0; i < list.length; i++) {
            if (!_selected[i]) continue;
            string memory tag = string.concat("[", list[i].id, "] ");
            if (bytes(_skipOf[i]).length != 0) {
                console.log(string.concat(tag, "SKIP ", _skipOf[i]));
                skipped++;
            } else {
                console.log(string.concat(tag, "PASS"));
                passed++;
            }
        }
        console.log("");
        console.log(string.concat("=== ", moduleName(), " (staged): ", vm.toString(passed), " passed, ",
            vm.toString(skipped), " skipped ==="));
        vm.removeFile(path);
        console.log("Every stage landed; record removed:", path);
    }

    /// @notice Puts back every setting the recorded run changed that the
    ///         chain still shows changed, for a run that will not be carried
    ///         on (a stage refused, or the operator stops it). Run it with
    ///         `--broadcast`. It reads the chain, not the record's progress,
    ///         so it is safe to run again; it keeps the record, and once its
    ///         broadcast has landed the record can be removed for a fresh run.
    function unwind() external {
        string memory path = Deployments.namedPath(_recordFile());
        require(vm.exists(path), string.concat(moduleName(), ": no staged run is recorded at ", path));
        string memory json = vm.readFile(path);
        _beginModule("unwind");
        _checkRecord(json);
        _loadProgress(json, scenarios().length);
        uint256 restored;
        for (uint256 i = 0; i < _restoreNames.length; i++) {
            string memory name = _restoreNames[i];
            uint256 value = _restoreValue[keccak256(bytes(name))];
            if (!_stillToRestore(name, value)) continue;
            _restore(name, value);
            console.log(string.concat("Put back: ", name));
            restored++;
        }
        console.log(restored == 0
            ? "Nothing the record names is still changed on the chain."
            : "Once this broadcast lands, the chain shows nothing the record names as changed.");
        console.log("Remove the record for a fresh run:", path);
    }

    /// @dev The settings the record names that the chain still shows
    ///      changed, as a list for a refusal; empty when none is.
    function _stillChanged() private view returns (string memory list) {
        for (uint256 i = 0; i < _restoreNames.length; i++) {
            string memory name = _restoreNames[i];
            if (!_stillToRestore(name, _restoreValue[keccak256(bytes(name))])) continue;
            list = bytes(list).length == 0 ? name : string.concat(list, ", ", name);
        }
    }

    /// @notice Logs where this module's staged-run record lives on the
    ///         target chain, as `STAGED_RECORD=<path>`, for
    ///         `run-staged.sh`. Reads nothing else and sends nothing.
    function recordPath() external view {
        console.log(string.concat("STAGED_RECORD=", Deployments.namedPath(_recordFile())));
    }

    /// @dev Runs scenario `index`'s next step and logs its outcome. True when
    ///      the scenario is over (passed or skipped), false when it waits.
    function _runNextStep(uint256 index, Scenario memory sc) private returns (bool over) {
        string memory tag = string.concat("[", sc.id, "] ");
        uint256 step = _nextStep[index];
        console.log("");
        console.log(string.concat(tag, sc.title, "  (step ", vm.toString(step + 1), " of ",
            vm.toString(_stepCount(index)), ")"));
        if (step == 0) console.log(string.concat(tag, "  flows: ", sc.flows));
        _current = index;
        _notBefore = 0;
        _runStep(index, step);
        string memory reason = _takeSkipReason();
        if (bytes(reason).length != 0) {
            _skipOf[index] = reason;
            console.log(string.concat(tag, "SKIP ", reason));
            return true;
        }
        if (++_nextStep[index] == _stepCount(index)) {
            console.log(string.concat(tag, "PASS"));
            return true;
        }
        console.log(string.concat(tag, "waits ", vm.toString(_waitAfterStep()),
            "s for its next step; it continues in the next stage"));
        return false;
    }

    /// @dev The record's file name, one per module.
    function _recordFile() internal pure returns (string memory) {
        return string.concat("positive-flows-staged-", moduleName(), ".json");
    }

    /// @dev The most stages a run of the selected scenarios can take: the
    ///      first, plus one per wait (every stage after the first takes the
    ///      waiting scenario's next step).
    function _maxStages(uint256 count) private view returns (uint256 n) {
        n = 1;
        for (uint256 i = 0; i < count; i++) {
            if (_selected[i]) n += _stepCount(i) - 1;
        }
    }

    function _hasStepLeft(uint256 i) private view returns (bool) {
        return bytes(_skipOf[i]).length == 0 && _nextStep[i] < _stepCount(i);
    }

    // ─── The record ───────────────────────────────────────────────────────

    /// @dev Writes what the next stage needs. Only a `--broadcast` run writes
    ///      it: a dry run sends nothing, so there is nothing to continue.
    function _writeRecord(string memory path, uint256 stageNo, uint256 count) private {
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            console.log("");
            console.log("Dry run: no staged-run record written");
            return;
        }
        string memory k = "positiveFlowsStaged";
        vm.serializeUint(k, "version", RECORD_VERSION);
        vm.serializeString(k, "module", moduleName());
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "diamond", diamond);
        vm.serializeString(k, "only", _only);
        vm.serializeUint(k, "stage", stageNo);
        // The wait before the next stage, and the earliest time it may run
        // as this stage's simulation saw the clock. The broadcast lands
        // after the simulation, so once it has landed `run-staged.sh` moves
        // `readyAt` to `waitSec` past the landed block; the next stage
        // refuses to run before it ({StageNotReady}).
        uint256 waitSec = _waitAfterStep();
        vm.serializeUint(k, "waitSec", waitSec);
        vm.serializeUint(k, "readyAt", block.timestamp + waitSec);
        vm.serializeUint(k, "maxStages", _maxStages(count));
        for (uint256 r = 0; r < _restoreNames.length; r++) {
            vm.serializeUint(k, string.concat("restore_", _restoreNames[r]), _restoreValue[keccak256(bytes(_restoreNames[r]))]);
        }

        bool finished = true;
        for (uint256 i = 0; i < count; i++) {
            if (!_selected[i]) continue;
            vm.serializeUint(k, string.concat("next_s", vm.toString(i)), _nextStep[i]);
            vm.serializeString(k, string.concat("skip_s", vm.toString(i)), _skipOf[i]);
            if (_hasStepLeft(i)) finished = false;
        }
        for (uint256 j = 0; j < _keptKeys.length; j++) {
            vm.serializeUint(k, string.concat("kept_", _keptKeys[j]), _keptValue[keccak256(bytes(_keptKeys[j]))]);
        }
        (string[6] memory names, address[6] memory actors) = _actors();
        for (uint256 a = 0; a < actors.length; a++) {
            // The nonce the simulation leaves: what the chain shows once this
            // stage's broadcast has landed whole.
            vm.serializeUint(k, string.concat("nonce_", names[a]), vm.getNonce(actors[a]));
        }
        _serializeFixture(k);
        string memory out = vm.serializeBool(k, "finished", finished);
        vm.writeJson(out, path);
        console.log("");
        console.log("Staged-run record written:", path);
        console.log(finished
            ? "Every scenario has run its last step: run finish() (no --broadcast) once this broadcast lands."
            : "Run stage() again once this broadcast lands and this wait has passed (seconds):");
        if (!finished) console.log("  wait before the next stage (s):", waitSec);
    }

    /// @dev Refuses a record written for another module, chain, Diamond or
    ///      version of this runner.
    function _checkRecord(string memory json) private view {
        require(vm.parseJsonUint(json, ".version") == RECORD_VERSION,
            string.concat(moduleName(), ": the staged-run record is from another version of this runner. Finish",
                " or unwind it from the commit that wrote it, then remove it for a fresh run"));
        require(_eq(vm.parseJsonString(json, ".module"), moduleName()),
            string.concat(moduleName(), ": the staged-run record is another module's"));
        require(vm.parseJsonUint(json, ".chainId") == block.chainid,
            string.concat(moduleName(), ": the staged-run record is for another chain"));
        require(vm.parseJsonAddress(json, ".diamond") == diamond,
            string.concat(moduleName(), ": the staged-run record is for another Diamond"));
    }

    /// @dev The recorded stage landed whole, and every transaction it sent
    ///      succeeded. Two checks, because either alone can be fooled:
    ///      - every actor's nonce on the chain is the one the recorded
    ///        stage's simulation left, so its broadcast was mined in full and
    ///        nothing else signed with those keys since;
    ///      - forge's own log of that broadcast ({_stageBroadcastLog}) shows
    ///        every transaction with a receipt and every receipt a success. A
    ///        transaction that is mined and reverts still uses its nonce, so
    ///        the nonces alone would let a scenario whose last fill reverted
    ///        pass. The log is tied to the recorded stage by those same
    ///        nonces: for each actor that sent in it, its last transaction's
    ///        nonce is one below the recorded one. A stage that sent nothing
    ///        leaves the log of the stage before, whose nonces the record
    ///        then still carries, so it is judged by that stage's receipts.
    function _requireLanded(string memory json, string memory what) private view {
        (string[6] memory names, address[6] memory actors) = _actors();
        uint256[6] memory expected;
        for (uint256 a = 0; a < actors.length; a++) {
            expected[a] = vm.parseJsonUint(json, string.concat(".nonce_", names[a]));
            uint256 onChain = vm.getNonce(actors[a]);
            require(onChain == expected[a], string.concat(
                moduleName(), ": cannot run ", what, ". The ", names[a], " account's nonce is ",
                vm.toString(onChain), " on the chain, and the recorded stage expected ", vm.toString(expected[a]),
                ": that stage's broadcast did not land whole, or the key signed something else since. ",
                _freshRunRemedy()
            ));
        }
        _requireStageSucceeded(what, actors, expected);
    }

    /// @dev Reads forge's log of this module's last `stage()` broadcast on
    ///      this chain and refuses unless it is the recorded stage's (see
    ///      {_requireLanded}) and every transaction in it succeeded.
    function _requireStageSucceeded(string memory what, address[6] memory actors, uint256[6] memory expected)
        private
        view
    {
        string memory logPath = _stageBroadcastLog();
        string memory cannot = string.concat(moduleName(), ": cannot run ", what, ". ");
        require(vm.exists(logPath), string.concat(
            cannot, "forge's log of the last stage's broadcast (", logPath, ") is missing, so nothing shows that",
            " its transactions succeeded. ", _freshRunRemedy()
        ));
        string memory log = vm.readFile(logPath);
        require(!vm.keyExistsJson(log, ".pending[0]"), string.concat(
            cannot, "The last stage's broadcast left transactions pending (", logPath, "). ", _freshRunRemedy()
        ));

        uint256[6] memory sentUpTo;
        bool tied;
        uint256 txCount;
        for (; vm.keyExistsJson(log, string.concat(".transactions[", vm.toString(txCount), "]")); txCount++) {
            string memory txKey = string.concat(".transactions[", vm.toString(txCount), "].transaction");
            address from = vm.parseJsonAddress(log, string.concat(txKey, ".from"));
            uint256 next = vm.parseJsonUint(log, string.concat(txKey, ".nonce")) + 1;
            for (uint256 a = 0; a < actors.length; a++) {
                if (from == actors[a] && next > sentUpTo[a]) sentUpTo[a] = next;
            }
        }
        for (uint256 a = 0; a < actors.length; a++) {
            if (sentUpTo[a] == 0) continue;
            require(sentUpTo[a] == expected[a], string.concat(
                cannot, logPath, " is not the recorded stage's broadcast. ", _freshRunRemedy()
            ));
            tied = true;
        }
        require(tied, string.concat(cannot, logPath, " holds no transaction from this run's actors. ", _freshRunRemedy()));

        uint256 receiptCount;
        for (; vm.keyExistsJson(log, string.concat(".receipts[", vm.toString(receiptCount), "]")); receiptCount++) {
            string memory rKey = string.concat(".receipts[", vm.toString(receiptCount), "]");
            require(vm.parseJsonUint(log, string.concat(rKey, ".status")) == 1, string.concat(
                cannot, "Transaction ", vm.parseJsonString(log, string.concat(rKey, ".transactionHash")),
                " of the last stage was mined but reverted, so a scenario's step did not happen. ",
                _freshRunRemedy()
            ));
        }
        require(receiptCount == txCount, string.concat(
            cannot, "The last stage sent ", vm.toString(txCount), " transactions and ", logPath, " holds ",
            vm.toString(receiptCount), " receipts. ", _freshRunRemedy()
        ));
    }

    /// @dev Where forge logs this module's last `stage()` broadcast on this
    ///      chain: `broadcast/<script file>/<chain id>/<function>-latest.json`,
    ///      relative to `contracts/`. Each module lives in `<moduleName>.s.sol`.
    function _stageBroadcastLog() private view returns (string memory) {
        return string.concat("broadcast/", moduleName(), ".s.sol/", vm.toString(block.chainid), "/stage-latest.json");
    }

    function _freshRunRemedy() private view returns (string memory) {
        string memory removal = string.concat("remove ", Deployments.namedPath(_recordFile()), " and start a fresh run");
        if (bytes(_stillChanged()).length == 0) return string.concat("To start over, ", removal);
        return string.concat("To start over, run unwind() with --broadcast to put back the settings this run",
            " changed, then ", removal);
    }

    function _loadProgress(string memory json, uint256 count) private {
        _only = vm.parseJsonString(json, ".only");
        for (uint256 i = 0; i < count; i++) {
            string memory nextKey = string.concat("next_s", vm.toString(i));
            if (!vm.keyExistsJson(json, string.concat(".", nextKey))) continue;
            _selected[i] = true;
            _nextStep[i] = vm.parseJsonUint(json, string.concat(".", nextKey));
            _skipOf[i] = vm.parseJsonString(json, string.concat(".skip_s", vm.toString(i)));
        }
        string[] memory keys = vm.parseJsonKeys(json, "$");
        for (uint256 j = 0; j < keys.length; j++) {
            bytes memory kb = bytes(keys[j]);
            if (kb.length > 5 && bytes5(kb) == bytes5("kept_")) {
                string memory key = _after(keys[j], 5);
                bytes32 h = keccak256(bytes(key));
                _keptKnown[h] = true;
                _keptKeys.push(key);
                _keptValue[h] = vm.parseJsonUint(json, string.concat(".", keys[j]));
            } else if (kb.length > 8 && bytes8(kb) == bytes8("restore_")) {
                _toRestore(_after(keys[j], 8), vm.parseJsonUint(json, string.concat(".", keys[j])));
            }
        }
    }

    /// @dev `s` without its first `n` bytes.
    function _after(string memory s, uint256 n) private pure returns (string memory out) {
        bytes memory b = bytes(s);
        bytes memory r = new bytes(b.length - n);
        for (uint256 i = n; i < b.length; i++) r[i - n] = b[i];
        out = string(r);
    }

    function _serializeFixture(string memory k) private {
        FixtureAddresses memory f = fixtureAddresses();
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
        vm.serializeAddress(k, "pool", f.pool);
    }

    function _recordedFixture(string memory json) private pure returns (FixtureAddresses memory) {
        return FixtureAddresses({
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
    }

    /// @dev Every account a stage may sign with, by the name a refusal uses.
    function _actors() private view returns (string[6] memory names, address[6] memory actors) {
        names = ["deployer", "admin", "lender", "borrower", "newLender", "newBorrower"];
        actors = [vm.addr(deployerKey), admin, lender, borrower, newLender, newBorrower];
    }

    /// @dev The wait between two steps: the longer of the minimum terms age
    ///      (a fill) and the position transfer cooldown (a move).
    function _stepWaitSec() private view returns (uint256) {
        uint256 age = _minTermsAgeSec();
        uint256 cooldown = _transferCooldownSec();
        return age > cooldown ? age : cooldown;
    }

    /// @dev The position transfer cooldown (#3413), or 0 on a Diamond that
    ///      does not route the read (it predates the cooldown).
    function _transferCooldownSec() private view returns (uint256 sec) {
        try VaipakamNFTFacet(diamond).positionTransferCooldownSec() returns (uint32 s, uint32, uint32) {
            sec = s;
        } catch {}
    }

    /// @dev The Diamond's minimum terms age, or the protocol default on a
    ///      Diamond that does not route the read.
    function _minTermsAgeSec() private view returns (uint256 age) {
        age = LibTiming.DEFAULT_MIN_TERMS_AGE_SEC;
        try ConfigFacet(diamond).getMinTermsAgeSec() returns (uint256 a) {
            age = a;
        } catch {}
    }
}
