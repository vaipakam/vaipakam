// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {PositiveFlowsBase} from "./PositiveFlowsBase.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {VaipakamNFTFacet} from "../../src/facets/VaipakamNFTFacet.sol";
import {LibTiming} from "../../src/libraries/LibTiming.sol";
import {Deployments} from "../lib/Deployments.sol";

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
 *         kind of step may follow any other.
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
 *         run one module at a time.
 *
 *         A wait this runner does not cover is not hidden behind it: an
 *         early stage is refused by the protocol rule itself (a fill too
 *         early by `OfferTermsTooFresh`, a move by `PositionCoolingDown`), and
 *         the cancel cooldown and the periodic checkpoint keep their own
 *         staged module ({PositiveFlowsTimed}) until it moves here (#3574).
 *
 *         SCENARIOS NEVER INTERLEAVE. A scenario runs to its end before the
 *         next one starts, exactly as in `run()`; only the wall-clock time
 *         between its steps differs. So a setting a scenario changes for its
 *         own run, a price it moves or an intent it holds is never seen by
 *         another scenario part-way, and the stages number about as many as
 *         the module's waits.
 */
abstract contract PositiveFlowsStaged is PositiveFlowsBase {
    uint256 private constant RECORD_VERSION = 1;

    /// @notice `run()` under `--broadcast` reached a wait between two steps.
    ///         A broadcast cannot wait between its own transactions; use the
    ///         staged run. The next step could run from `readyAt`.
    error StepWaitNeedsStagedRun(uint256 readyAt);

    /// @dev The scenario whose step is running: what {_keep} and {_kept}
    ///      file values under.
    uint256 private _current;

    /// @dev What steps kept for a later step, by `s<index>_<name>`.
    mapping(bytes32 => uint256) private _keptValue;
    mapping(bytes32 => bool) private _keptKnown;
    string[] private _keptKeys;

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
            _runStep(index, step);
            if (_skipPending()) return;
        }
    }

    /// @dev The simulation's stand-in for the wait between two stages: the
    ///      clock steps past {_stepWaitSec} and into a later block, so
    ///      whatever the last step posted is fillable and whatever it opened
    ///      may move. A broadcast cannot wait between its own transactions,
    ///      so under `--broadcast` this refuses, before anything is sent.
    function _waitBetweenSteps() private {
        uint256 readyAt = block.timestamp + _stepWaitSec();
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) revert StepWaitNeedsStagedRun(readyAt);
        vm.warp(readyAt);
        vm.roll(block.number + 1);
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
            _requireLanded(json, "stage");
            _loadProgress(json, list.length);
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
        _requireLanded(json, "finish");

        Scenario[] memory list = scenarios();
        _loadProgress(json, list.length);
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
        console.log(string.concat(tag, "waits for its terms to age; it continues in the next stage"));
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
        vm.serializeUint(k, "waitSec", _stepWaitSec());
        vm.serializeUint(k, "maxStages", _maxStages(count));

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
            : "Run stage() again once this broadcast lands and the wait between steps has passed (seconds):");
        if (!finished) console.log("  wait between steps (s):", _stepWaitSec());
    }

    /// @dev Refuses a record written for another module, chain, Diamond or
    ///      version of this runner.
    function _checkRecord(string memory json) private view {
        require(vm.parseJsonUint(json, ".version") == RECORD_VERSION,
            string.concat(moduleName(), ": the staged-run record is from another version of this runner"));
        require(_eq(vm.parseJsonString(json, ".module"), moduleName()),
            string.concat(moduleName(), ": the staged-run record is another module's"));
        require(vm.parseJsonUint(json, ".chainId") == block.chainid,
            string.concat(moduleName(), ": the staged-run record is for another chain"));
        require(vm.parseJsonAddress(json, ".diamond") == diamond,
            string.concat(moduleName(), ": the staged-run record is for another Diamond"));
    }

    /// @dev Every actor's nonce on the chain is the one the recorded stage's
    ///      simulation left, so its broadcast landed whole and nothing else
    ///      signed with those keys since.
    function _requireLanded(string memory json, string memory what) private view {
        (string[6] memory names, address[6] memory actors) = _actors();
        for (uint256 a = 0; a < actors.length; a++) {
            uint256 expected = vm.parseJsonUint(json, string.concat(".nonce_", names[a]));
            uint256 onChain = vm.getNonce(actors[a]);
            require(onChain == expected, string.concat(
                moduleName(), ": cannot run ", what, ". The ", names[a], " account's nonce is ",
                vm.toString(onChain), " on the chain, and the recorded stage expected ", vm.toString(expected),
                ": that stage's broadcast did not land whole, or the key signed something else since. Remove ",
                Deployments.namedPath(_recordFile()), " and start a fresh run"
            ));
        }
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
            if (kb.length <= 5 || bytes5(kb) != bytes5("kept_")) continue;
            string memory key = _after5(keys[j]);
            bytes32 h = keccak256(bytes(key));
            _keptKnown[h] = true;
            _keptKeys.push(key);
            _keptValue[h] = vm.parseJsonUint(json, string.concat(".", keys[j]));
        }
    }

    function _after5(string memory s) private pure returns (string memory out) {
        bytes memory b = bytes(s);
        bytes memory r = new bytes(b.length - 5);
        for (uint256 i = 5; i < b.length; i++) r[i - 5] = b[i];
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
