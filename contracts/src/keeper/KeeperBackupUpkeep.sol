// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Chainlink Automation's upkeep interface (AutomationCompatibleInterface),
///         restated so this contract carries no Chainlink library dependency.
interface IAutomationCompatible {
    function checkUpkeep(bytes calldata checkData) external returns (bool upkeepNeeded, bytes memory performData);
    function performUpkeep(bytes calldata performData) external;
}

/// @notice The Diamond reads the backup uses to find candidate work. All are
///         plain views that exist on the deployed Diamond.
interface IBackupDiamondReads {
    function getActiveLoansCount() external view returns (uint256);
    function getActiveLoansPaginated(uint256 offset, uint256 limit) external view returns (uint256[] memory);
    function getActiveOffersCount() external view returns (uint256);
    function getActiveOffersPaginated(uint256 offset, uint256 limit) external view returns (uint256[] memory);
    function getOfferLinkedLoanId(uint256 offerId) external view returns (uint256);
    function getInteractionCurrentDay() external view returns (uint256 day, bool active);
    function getVaultBeacon() external view returns (address);
}

/// @dev The step entry points, by signature only. `AdapterCall` mirrors
///      `LibSwap.AdapterCall`; the backup always passes an empty list, so it
///      only ever takes the routes that need no swap.
interface IBackupSteps {
    struct AdapterCall {
        uint256 adapterIdx;
        bytes data;
    }

    function autoDeductDaily(uint256 loanId) external;
    function cancelExpiredPrepayListing(uint256 loanId) external;
    function cancelExpiredIntent(uint256 loanId) external;
    function autoListAtFloorOnGrace(uint256 loanId) external;
    function triggerDefault(uint256 loanId, uint256 sellAmount, AdapterCall[] calldata adapterCalls) external;
    function settlePeriodicInterest(uint256 loanId, uint256 sellAmount, AdapterCall[] calldata adapterCalls) external;
    function teardownStaleSaleListing(uint256 loanId) external;
    function closeDay(uint256 dayId) external payable;
    function lapseZeroedDay(uint256 dayId) external;
    function lapseShortCompensatedDay(uint256 dayId) external;
    function skipConflictedDay(uint256 dayId) external;
    function recycleSkippedDayValue(uint256 dayId) external returns (uint256 recycled);
    function executeCurrentVersion() external;
    function executeRevoke() external;
}

/**
 * @title  KeeperBackupUpkeep
 * @notice A BACKUP runner for permissionless upkeep steps, driven by Chainlink
 *         Automation (#3361). It runs a step only when our own keeper has left
 *         it undone for longer than a set lag. Liquidations and matching are
 *         deliberately not here: they are left to open competition.
 *
 * @dev    How a step is found, waited on and run.
 *
 *         FINDING. `checkUpkeep` is simulated by Chainlink's nodes and is never
 *         sent as a transaction (it refuses a real sender). It builds the
 *         candidate calls for every ENABLED step: per active loan in a rotating
 *         window, per active offer's linked loan in a rotating window, per day
 *         for the most recent closed days AND a rotating window over every
 *         older day (a lapse becomes possible only weeks after its day), and
 *         the VaultBeacon's two proposal executes. These parts and the note
 *         queue share the check's gas. The part that goes first moves on
 *         every block, and the first (step, argument) pair inside each part
 *         moves once per round of parts, so whenever a part leads, its start
 *         has moved on by one: a pair whose probe is costly cannot starve the
 *         rest. Whether a candidate is due is decided by the protocol
 *         itself: each candidate is PROBED, i.e. called from this contract
 *         inside a self-call that always reverts, so its effects are undone and
 *         only its success is kept. The backup carries no copy of any step's
 *         due rule, so the two cannot drift. The one exception is
 *         `recycleSkippedDayValue`, which succeeds with zero once there is
 *         nothing left: it is due only when its probe returns a non-zero amount.
 *
 *         WAITING. A due candidate is first NOTED: it joins a bounded queue
 *         with its first-seen time, in a cheap transaction. The queue is
 *         visited on its own, apart from the scan windows, so a noted candidate
 *         is revisited however far they have rotated away from it. It is RUN
 *         only when a check still finds it due between `lagSec` and
 *         `lagSec + actWindowSec` after that time. A noted candidate that is no
 *         longer due (our keeper ran it) is DROPPED, during its wait as well,
 *         so a later occurrence of a recurring step is noted afresh; perform
 *         re-probes before dropping, so a drop can only remove what is truly
 *         not due. A note older than its window is renewed if the step is still
 *         due, so a step that recurs (a daily rental deduction) waits the full
 *         lag every time.
 *
 *         RUNNING. `performUpkeep` accepts only the registered Chainlink
 *         forwarder, and only (step, argument) pairs: the call it makes is
 *         rebuilt here from the step id, so even a compromised forwarder can
 *         only run the steps this contract lists, each with the empty swap
 *         route. Every step is switched OFF at deployment and is switched on by
 *         the owner one by one, the same way each keeper pass ships disarmed.
 *
 *         WHAT THE BACKUP DOES NOT RUN, AND WHY. Steps whose caller pays a CCIP
 *         fee (this contract holds no native coin), steps that need swap quotes
 *         or page arguments computed off-chain, steps whose items are found only
 *         from event logs, `finalizeDay` (irreversible, and the keeper holds it
 *         on facts read from other chains), `backstopFill` (lends treasury
 *         capital) and steps that succeed without being due
 *         (`advanceInterestFrontiers`, `refreshTierLtvCache`,
 *         `epochPruneTransportDayCursor`). See
 *         docs/DesignsAndPlans/KeeperBackupAutomationDesign.md.
 *
 *         VALUE. The backup attaches no value to any call. A step can pay its
 *         caller (a time-based default that settles through an internal match
 *         pays the matcher bonus to `msg.sender`), so tokens may arrive here.
 *         They leave only to the treasury fixed at deployment, through the
 *         permissionless `sweep`; the owner cannot redirect them.
 */
contract KeeperBackupUpkeep is IAutomationCompatible, Ownable2Step {
    using SafeERC20 for IERC20;

    // ─── Steps ──────────────────────────────────────────────────────────

    /// @notice Every step the backup can run, by id. The id is the bit in
    ///         `enabledSteps`. Append only: an id never changes meaning.
    enum Step {
        AutoDeductDaily, // 0  per loan
        CancelExpiredPrepayListing, // 1  per loan
        CancelExpiredIntent, // 2  per loan
        AutoListAtFloorOnGrace, // 3  per loan
        DefaultWithoutSale, // 4  per loan: triggerDefault(id, 0, [])
        PeriodicStampWithoutSale, // 5  per loan: settlePeriodicInterest(id, 0, [])
        TeardownStaleSaleListing, // 6  per loan, and per active offer's linked loan
        CloseDay, // 7  per day (fee-free only where the chain charges none)
        LapseZeroedDay, // 8  per day
        LapseShortCompensatedDay, // 9  per day
        SkipConflictedDay, // 10 per day
        RecycleSkippedDayValue, // 11 per day, due only while it returns > 0
        BeaconExecuteCurrentVersion, // 12 once
        BeaconExecuteRevoke // 13 once
    }

    uint8 public constant STEP_COUNT = 14;
    uint256 private constant FIRST_LOAN_STEP = 0;
    uint256 private constant LAST_LOAN_STEP = 6;
    uint256 private constant FIRST_DAY_STEP = 7;
    uint256 private constant LAST_DAY_STEP = 11;

    /// @notice What a perform does with one (step, argument): note it as due,
    ///         run it, or drop a note that is no longer due (or whose step was
    ///         switched off).
    enum Mode {
        Note,
        Run,
        Drop
    }

    struct Action {
        Mode mode;
        uint8 step;
        uint256 arg;
    }

    // ─── Bounds ─────────────────────────────────────────────────────────

    uint32 public constant MIN_LAG_SEC = 10 minutes;
    uint32 public constant MAX_LAG_SEC = 7 days;
    uint32 public constant MIN_ACT_WINDOW_SEC = 10 minutes;
    uint32 public constant MAX_ACT_WINDOW_SEC = 1 days;
    uint16 public constant MAX_LOAN_WINDOW = 50;
    uint16 public constant MAX_DAY_WINDOW = 30;
    uint8 public constant MAX_ACTIONS = 16;
    /// @notice Most candidates waiting at once. A full queue delays new notes;
    ///         every entry leaves within `lagSec + actWindowSec` of its note.
    uint8 public constant MAX_PENDING = 64;
    uint8 public constant MAX_RUNS_PER_PERFORM = 4;
    /// @dev The parts of a check that share its gas: see `checkUpkeep`.
    uint256 private constant PARTS = 6;
    /// @notice Gas kept back in a check after the last probe, so the encoding
    ///         of the result never runs out.
    uint256 public constant CHECK_GAS_RESERVE = 300_000;

    // ─── Immutable wiring ───────────────────────────────────────────────

    /// @notice The Diamond whose steps this backs.
    address public immutable diamond;
    /// @notice Where tokens a step paid this contract go. Fixed at deployment.
    address public immutable treasury;

    // ─── Owner settings ─────────────────────────────────────────────────

    /// @notice The Chainlink upkeep forwarder, the only caller of `performUpkeep`.
    address public forwarder;
    /// @notice Bit i set = step i is armed. Zero at deployment.
    uint256 public enabledSteps;
    /// @notice How long a step must stay due before the backup runs it.
    uint32 public lagSec = 1 hours;
    /// @notice How long after the lag a note stays good for running.
    uint32 public actWindowSec = 1 hours;
    /// @notice Active loans (and active offers) probed per check.
    uint16 public loanWindow = 10;
    /// @notice How often the loan and offer windows move on, in seconds.
    uint32 public rotationSec = 5 minutes;
    /// @notice Closed days probed per check, counting back from yesterday.
    uint16 public dayWindow = 7;
    /// @notice Gas each probe may spend.
    uint32 public probeGas = 1_500_000;
    /// @notice Runs per perform. Notes are cheap and are not counted here.
    uint8 public runsPerPerform = 2;

    // ─── State ──────────────────────────────────────────────────────────

    /// @notice A noted candidate and when it was first seen due.
    struct Pending {
        uint8 step;
        uint64 seenAt;
        uint256 arg;
    }

    /// @dev The noted candidates, in no order. `_pendingSlot[key]` is the
    ///      entry's index + 1 (0 = not pending).
    Pending[] private _pending;
    mapping(bytes32 => uint256) private _pendingSlot;

    // ─── Events ─────────────────────────────────────────────────────────

    event StepsEnabled(uint256 previousMask, uint256 mask);
    event ForwarderSet(address previous, address forwarder);
    event TimingSet(uint32 lagSec, uint32 actWindowSec, uint32 rotationSec);
    event ScanSet(uint16 loanWindow, uint16 dayWindow, uint32 probeGas, uint8 runsPerPerform);
    /// @notice A step was seen due and its wait started.
    event BackupDueNoted(uint8 indexed step, uint256 indexed arg, uint64 at);
    /// @notice A noted step stopped being due before its run, and left the queue.
    event BackupNoteDropped(uint8 indexed step, uint256 indexed arg);
    /// @notice The backup ran a step our keeper had left undone past the lag.
    ///         `ok` is false when the call reverted (someone ran it first, or it
    ///         stopped being due); `revertSelector` names the refusal.
    event BackupStepRun(uint8 indexed step, uint256 indexed arg, bool ok, bytes4 revertSelector);
    event Swept(address indexed token, address indexed treasury, uint256 amount);

    // ─── Errors ─────────────────────────────────────────────────────────

    error OnlySimulatedBackend();
    error OnlyForwarder(address caller);
    error ZeroAddress();
    error UnknownStep(uint8 step);
    error StepsOutOfRange(uint256 mask);
    error SettingOutOfRange();
    error TooManyActions(uint256 count);
    /// @notice Raised by `probe` to carry the probed call's result out of the
    ///         self-call while undoing its effects.
    error ProbeResult(bool ok, uint256 firstWord);

    constructor(address diamond_, address treasury_, address owner_) Ownable(owner_) {
        if (diamond_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        diamond = diamond_;
        treasury = treasury_;
    }

    // ─── Owner ──────────────────────────────────────────────────────────

    /// @notice Arm or disarm steps. A bit beyond the last step is refused.
    function setEnabledSteps(uint256 mask) external onlyOwner {
        if (mask >> STEP_COUNT != 0) revert StepsOutOfRange(mask);
        emit StepsEnabled(enabledSteps, mask);
        enabledSteps = mask;
    }

    /// @notice The Chainlink forwarder of this contract's upkeep.
    function setForwarder(address forwarder_) external onlyOwner {
        if (forwarder_ == address(0)) revert ZeroAddress();
        emit ForwarderSet(forwarder, forwarder_);
        forwarder = forwarder_;
    }

    function setTiming(uint32 lagSec_, uint32 actWindowSec_, uint32 rotationSec_) external onlyOwner {
        if (lagSec_ < MIN_LAG_SEC || lagSec_ > MAX_LAG_SEC) revert SettingOutOfRange();
        if (actWindowSec_ < MIN_ACT_WINDOW_SEC || actWindowSec_ > MAX_ACT_WINDOW_SEC) revert SettingOutOfRange();
        if (rotationSec_ == 0 || rotationSec_ > 1 days) revert SettingOutOfRange();
        lagSec = lagSec_;
        actWindowSec = actWindowSec_;
        rotationSec = rotationSec_;
        emit TimingSet(lagSec_, actWindowSec_, rotationSec_);
    }

    function setScan(uint16 loanWindow_, uint16 dayWindow_, uint32 probeGas_, uint8 runsPerPerform_) external onlyOwner {
        if (loanWindow_ == 0 || loanWindow_ > MAX_LOAN_WINDOW) revert SettingOutOfRange();
        if (dayWindow_ == 0 || dayWindow_ > MAX_DAY_WINDOW) revert SettingOutOfRange();
        if (probeGas_ < 100_000 || probeGas_ > 5_000_000) revert SettingOutOfRange();
        if (runsPerPerform_ == 0 || runsPerPerform_ > MAX_RUNS_PER_PERFORM) revert SettingOutOfRange();
        loanWindow = loanWindow_;
        dayWindow = dayWindow_;
        probeGas = probeGas_;
        runsPerPerform = runsPerPerform_;
        emit ScanSet(loanWindow_, dayWindow_, probeGas_, runsPerPerform_);
    }

    // ─── Anyone ─────────────────────────────────────────────────────────

    /// @notice Send a token a step paid this contract to the treasury.
    function sweep(address token) external {
        uint256 amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) return;
        IERC20(token).safeTransfer(treasury, amount);
        emit Swept(token, treasury, amount);
    }

    /// @notice Call one candidate and revert with its result, so the effects
    ///         are undone. Used by `checkUpkeep`; it can never change state.
    function probe(uint8 step, uint256 arg) external {
        (address target, bytes memory data) = _call(step, arg);
        (bool ok, bytes memory ret) = target.call(data);
        uint256 firstWord;
        if (ok && ret.length >= 32) firstWord = abi.decode(ret, (uint256));
        revert ProbeResult(ok, firstWord);
    }

    /// @notice Whether a (step, argument) is due now, by the protocol's own rule.
    function isDue(uint8 step, uint256 arg) public returns (bool) {
        try this.probe{gas: probeGas}(step, arg) {
            return false; // unreachable: probe always reverts
        } catch (bytes memory reason) {
            if (reason.length != 68 || bytes4(reason) != ProbeResult.selector) return false;
            (bool ok, uint256 firstWord) = abi.decode(_tail(reason), (bool, uint256));
            if (!ok) return false;
            if (Step(step) == Step.RecycleSkippedDayValue) return firstWord != 0;
            return true;
        }
    }

    /// @notice When a (step, argument) was first noted as due; 0 = not pending.
    function firstSeenAt(uint8 step, uint256 arg) external view returns (uint64) {
        uint256 slot = _pendingSlot[_key(step, arg)];
        return slot == 0 ? 0 : _pending[slot - 1].seenAt;
    }

    /// @notice The noted candidates waiting now.
    function pendingCandidates() external view returns (Pending[] memory) {
        return _pending;
    }

    // ─── Chainlink Automation ───────────────────────────────────────────

    /// @inheritdoc IAutomationCompatible
    /// @dev Simulation only. Collects at most MAX_ACTIONS actions and at most
    ///      `runsPerPerform` runs, stopping early when gas runs low.
    function checkUpkeep(bytes calldata) external override returns (bool upkeepNeeded, bytes memory performData) {
        if (tx.origin != address(0) && tx.origin != address(0x1111111111111111111111111111111111111111)) {
            revert OnlySimulatedBackend();
        }
        Action[] memory actions = new Action[](MAX_ACTIONS);
        uint256 n;
        uint256 runs;
        uint256 mask = enabledSteps;
        if (mask == 0) return (false, "");

        // Six parts share the check's gas: the note queue, the beacon, the
        // recent days, the older days, the loans and the offers. The part
        // that goes first moves on every block, so a part whose probes are
        // costly, or run out of their gas, cannot starve the others: each
        // part leads one check in six.
        uint256 first = block.number % PARTS;
        for (uint256 k; k < PARTS && !_full(n, runs); k++) {
            (n, runs) = _scanPart((first + k) % PARTS, actions, n, runs, mask);
        }

        if (n == 0) return (false, "");
        Action[] memory out = new Action[](n);
        for (uint256 i; i < n; i++) out[i] = actions[i];
        return (true, abi.encode(out));
    }

    /// @inheritdoc IAutomationCompatible
    /// @dev Re-checks everything it can from storage: the step is armed, a
    ///      note is fresh, the run is inside its window. Whether the step is
    ///      still due is the protocol's to decide when it is called.
    function performUpkeep(bytes calldata performData) external override {
        if (msg.sender != forwarder || forwarder == address(0)) revert OnlyForwarder(msg.sender);
        Action[] memory actions = abi.decode(performData, (Action[]));
        if (actions.length > MAX_ACTIONS) revert TooManyActions(actions.length);
        uint256 runs;
        for (uint256 i; i < actions.length; i++) {
            Action memory a = actions[i];
            if (a.step >= STEP_COUNT) revert UnknownStep(a.step);
            bytes32 key = _key(a.step, a.arg);
            uint256 slot = _pendingSlot[key];
            Stage stage = slot == 0 ? Stage.None : _stage(_pending[slot - 1].seenAt);
            if (a.mode == Mode.Drop) {
                // Only a disarmed step, or one the protocol says is not due,
                // leaves the queue without running.
                if (slot == 0) continue;
                if (_on(enabledSteps, a.step) && isDue(a.step, a.arg)) continue;
                _removePending(key, slot);
                emit BackupNoteDropped(a.step, a.arg);
                continue;
            }
            if (!_on(enabledSteps, a.step)) continue;
            if (a.mode == Mode.Note) {
                if (stage == Stage.Waiting || stage == Stage.Ready) continue;
                if (slot != 0) {
                    _pending[slot - 1].seenAt = uint64(block.timestamp); // renew a stale note
                } else {
                    if (_pending.length >= MAX_PENDING) continue;
                    _pending.push(Pending(a.step, uint64(block.timestamp), a.arg));
                    _pendingSlot[key] = _pending.length;
                }
                emit BackupDueNoted(a.step, a.arg, uint64(block.timestamp));
            } else {
                if (stage != Stage.Ready || runs >= runsPerPerform) continue;
                runs++;
                _removePending(key, slot);
                (address target, bytes memory data) = _call(a.step, a.arg);
                (bool ok, bytes memory ret) = target.call(data);
                emit BackupStepRun(a.step, a.arg, ok, ok || ret.length < 4 ? bytes4(0) : bytes4(ret));
            }
        }
    }

    // ─── Internal ───────────────────────────────────────────────────────

    enum Stage {
        None, // never noted, or the note went stale
        Waiting, // noted, the lag has not passed
        Ready // noted, inside the run window
    }

    function _stage(uint64 seen) internal view returns (Stage) {
        if (seen == 0) return Stage.None;
        uint256 age = block.timestamp - seen;
        if (age < lagSec) return Stage.Waiting;
        if (age <= uint256(lagSec) + actWindowSec) return Stage.Ready;
        return Stage.None;
    }

    function _scanPart(uint256 part, Action[] memory actions, uint256 n, uint256 runs, uint256 mask)
        internal
        returns (uint256, uint256)
    {
        if (part == 0) return _scanQueue(actions, n, runs, mask);
        uint256[] memory args;
        uint256 firstStep;
        uint256 lastStep;
        if (part == 1) {
            firstStep = uint8(Step.BeaconExecuteCurrentVersion);
            lastStep = uint8(Step.BeaconExecuteRevoke);
            args = new uint256[](1); // the beacon's steps take no argument
        } else if (part == 2 || part == 3) {
            firstStep = FIRST_DAY_STEP;
            lastStep = LAST_DAY_STEP;
            if (_anyIn(mask, firstStep, lastStep)) args = _days(part == 2);
        } else if (part == 4) {
            firstStep = FIRST_LOAN_STEP;
            lastStep = LAST_LOAN_STEP;
            if (_anyIn(mask, firstStep, lastStep)) args = _window(true);
        } else {
            firstStep = uint8(Step.TeardownStaleSaleListing);
            lastStep = firstStep;
            if (_on(mask, uint8(firstStep))) args = _offerLinkedLoans();
        }
        // Only an offer can yield no candidate (no linked loan): day zero and
        // the beacon's argument are real zeros.
        return _scanCandidates(args, part == 5, firstStep, lastStep, actions, n, runs, mask);
    }

    /// @dev Every (step, argument) pair of one part, from a start that moves
    ///      every round of `PARTS` blocks (`_cycle`), so a costly pair (a
    ///      probe that spends its whole allowance) cannot keep the pairs after
    ///      it from being reached.
    function _scanCandidates(
        uint256[] memory args,
        bool skipZero,
        uint256 firstStep,
        uint256 lastStep,
        Action[] memory actions,
        uint256 n,
        uint256 runs,
        uint256 mask
    ) internal returns (uint256, uint256) {
        uint256 steps = lastStep - firstStep + 1;
        uint256 total = args.length * steps;
        if (total == 0) return (n, runs);
        uint256 start = _cycle() % total;
        for (uint256 j; j < total && !_full(n, runs); j++) {
            uint256 idx = (start + j) % total;
            uint256 arg = args[idx / steps];
            if (skipZero && arg == 0) continue;
            (n, runs) = _consider(actions, n, runs, mask, uint8(firstStep + idx % steps), arg);
        }
        return (n, runs);
    }

    /// @dev Every noted candidate, from a start that moves every round of
    ///      `PARTS` blocks (`_cycle`). A note is probed even while it waits, so
    ///      a step our keeper ran is dropped at once and a later occurrence of
    ///      a recurring step starts a wait of its own.
    function _scanQueue(Action[] memory actions, uint256 n, uint256 runs, uint256 mask)
        internal
        returns (uint256, uint256)
    {
        uint256 len = _pending.length;
        if (len == 0) return (n, runs);
        uint256 start = _cycle() % len;
        for (uint256 j; j < len && !_full(n, runs); j++) {
            Pending memory p = _pending[(start + j) % len];
            if (!_on(mask, p.step)) {
                actions[n++] = Action(Mode.Drop, p.step, p.arg); // disarmed since noted
                continue;
            }
            Stage stage = _stage(p.seenAt);
            if (!isDue(p.step, p.arg)) {
                actions[n++] = Action(Mode.Drop, p.step, p.arg);
            } else if (stage == Stage.Ready) {
                actions[n++] = Action(Mode.Run, p.step, p.arg);
                runs++;
            } else if (stage == Stage.None) {
                actions[n++] = Action(Mode.Note, p.step, p.arg); // stale: renew the wait
            }
            // Waiting and still due: nothing to do yet.
        }
        return (n, runs);
    }

    /// @dev Days are zero-based from launch, and none exists before launch.
    ///      `recent`: the last `dayWindow` closed days. Otherwise a window of
    ///      `dayWindow` days over all older days, moving on every `rotationSec`,
    ///      since a day's lapse opens only after its finalize plus a lapse
    ///      window.
    function _days(bool recent) internal view returns (uint256[] memory out) {
        (uint256 today, bool active) = IBackupDiamondReads(diamond).getInteractionCurrentDay();
        if (!active) return out;
        uint256 closed = today < dayWindow ? today : dayWindow;
        if (recent) {
            out = new uint256[](closed);
            for (uint256 back = 1; back <= closed; back++) out[back - 1] = today - back;
            return out;
        }
        uint256 older = today - closed; // days [0, older)
        if (older == 0) return out;
        uint256 pages = (older + dayWindow - 1) / dayWindow;
        uint256 first = ((block.timestamp / rotationSec) % pages) * dayWindow;
        uint256 end = first + dayWindow > older ? older : first + dayWindow;
        out = new uint256[](end - first);
        for (uint256 d = first; d < end; d++) out[d - first] = d;
    }

    /// @dev The linked loan of each offer in a rotating window of the
    ///      active-offer list (zero for an offer with none): a sale listing
    ///      that outlived its loan is reached from the offer.
    function _offerLinkedLoans() internal view returns (uint256[] memory out) {
        out = _window(false);
        for (uint256 i; i < out.length; i++) out[i] = IBackupDiamondReads(diamond).getOfferLinkedLoanId(out[i]);
    }

    /// @dev Add the action a due candidate needs, if any.
    function _consider(Action[] memory actions, uint256 n, uint256 runs, uint256 mask, uint8 step, uint256 arg)
        internal
        returns (uint256, uint256)
    {
        if (!_on(mask, step) || gasleft() < uint256(probeGas) + CHECK_GAS_RESERVE) return (n, runs);
        // A pending candidate was already handled from the queue this check.
        if (_pendingSlot[_key(step, arg)] != 0) return (n, runs);
        if (_pending.length + _countNotes(actions, n) >= MAX_PENDING) return (n, runs);
        if (!isDue(step, arg)) return (n, runs);
        actions[n] = Action(Mode.Note, step, arg);
        return (n + 1, runs);
    }

    /// @dev New notes already collected in this check.
    function _countNotes(Action[] memory actions, uint256 n) internal pure returns (uint256 c) {
        for (uint256 i; i < n; i++) {
            if (actions[i].mode == Mode.Note) c++;
        }
    }

    function _removePending(bytes32 key, uint256 slot) internal {
        uint256 last = _pending.length;
        if (slot != last) {
            Pending memory moved = _pending[last - 1];
            _pending[slot - 1] = moved;
            _pendingSlot[_key(moved.step, moved.arg)] = slot;
        }
        _pending.pop();
        delete _pendingSlot[key];
    }

    /// @dev The start inside a part moves once per round of `PARTS` blocks,
    ///      not on every block. A part that only gets gas while it leads
    ///      (block number = its index, modulo `PARTS`) would otherwise see
    ///      starts from one residue class only: with `PARTS` and the part's
    ///      pair count sharing a factor, some pairs would never lead. Per
    ///      round, each part leads once and its start has moved by one.
    function _cycle() internal view returns (uint256) {
        return block.number / PARTS;
    }

    function _full(uint256 n, uint256 runs) internal view returns (bool) {
        return n >= MAX_ACTIONS || runs >= runsPerPerform || gasleft() < uint256(probeGas) + CHECK_GAS_RESERVE;
    }

    /// @dev The window of the active-loan (or active-offer) list this check
    ///      reads. It moves on every `rotationSec`, wrapping at the end.
    function _window(bool loans) internal view returns (uint256[] memory) {
        IBackupDiamondReads d = IBackupDiamondReads(diamond);
        uint256 count = loans ? d.getActiveLoansCount() : d.getActiveOffersCount();
        if (count == 0) return new uint256[](0);
        uint256 pages = (count + loanWindow - 1) / loanWindow;
        uint256 offset = ((block.timestamp / rotationSec) % pages) * loanWindow;
        return loans ? d.getActiveLoansPaginated(offset, loanWindow) : d.getActiveOffersPaginated(offset, loanWindow);
    }

    /// @dev The call a (step, argument) makes. The only place a call is built.
    function _call(uint8 step, uint256 arg) internal view returns (address target, bytes memory data) {
        if (step >= STEP_COUNT) revert UnknownStep(step);
        Step s = Step(step);
        IBackupSteps.AdapterCall[] memory none = new IBackupSteps.AdapterCall[](0);
        target = diamond;
        if (s == Step.AutoDeductDaily) data = abi.encodeCall(IBackupSteps.autoDeductDaily, (arg));
        else if (s == Step.CancelExpiredPrepayListing) data = abi.encodeCall(IBackupSteps.cancelExpiredPrepayListing, (arg));
        else if (s == Step.CancelExpiredIntent) data = abi.encodeCall(IBackupSteps.cancelExpiredIntent, (arg));
        else if (s == Step.AutoListAtFloorOnGrace) data = abi.encodeCall(IBackupSteps.autoListAtFloorOnGrace, (arg));
        else if (s == Step.DefaultWithoutSale) data = abi.encodeCall(IBackupSteps.triggerDefault, (arg, 0, none));
        else if (s == Step.PeriodicStampWithoutSale) {
            data = abi.encodeCall(IBackupSteps.settlePeriodicInterest, (arg, 0, none));
        } else if (s == Step.TeardownStaleSaleListing) {
            data = abi.encodeCall(IBackupSteps.teardownStaleSaleListing, (arg));
        } else if (s == Step.CloseDay) data = abi.encodeCall(IBackupSteps.closeDay, (arg));
        else if (s == Step.LapseZeroedDay) data = abi.encodeCall(IBackupSteps.lapseZeroedDay, (arg));
        else if (s == Step.LapseShortCompensatedDay) data = abi.encodeCall(IBackupSteps.lapseShortCompensatedDay, (arg));
        else if (s == Step.SkipConflictedDay) data = abi.encodeCall(IBackupSteps.skipConflictedDay, (arg));
        else if (s == Step.RecycleSkippedDayValue) data = abi.encodeCall(IBackupSteps.recycleSkippedDayValue, (arg));
        else {
            // The beacon steps. A Diamond with no beacon has nothing to run:
            // the call goes to the Diamond, which refuses an unknown selector.
            address beacon = IBackupDiamondReads(diamond).getVaultBeacon();
            if (beacon != address(0)) target = beacon;
            data = s == Step.BeaconExecuteCurrentVersion
                ? abi.encodeCall(IBackupSteps.executeCurrentVersion, ())
                : abi.encodeCall(IBackupSteps.executeRevoke, ());
        }
    }

    function _key(uint8 step, uint256 arg) internal pure returns (bytes32) {
        return keccak256(abi.encode(step, arg));
    }

    function _on(uint256 mask, uint8 step) internal pure returns (bool) {
        return (mask >> step) & 1 == 1;
    }

    function _anyIn(uint256 mask, uint256 first, uint256 last) internal pure returns (bool) {
        return (mask >> first) & ((uint256(1) << (last - first + 1)) - 1) != 0;
    }

    /// @dev `reason` without its 4-byte selector.
    function _tail(bytes memory reason) internal pure returns (bytes memory out) {
        out = new bytes(reason.length - 4);
        for (uint256 i; i < out.length; i++) out[i] = reason[i + 4];
    }
}
