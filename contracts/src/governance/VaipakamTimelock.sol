// src/governance/VaipakamTimelock.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/**
 * @title  VaipakamTimelock
 * @author Vaipakam Developer Team
 * @notice OZ {TimelockController} extended with an on-chain
 *         pending-proposal list so the AdminDashboard can render
 *         "what's queued for execution" without an event-replay
 *         dependency. AnalyticalGettersDesign §3.3 (decision D7
 *         resolved here: the standalone-contract option).
 *
 *         Hardened per #938: the delay can never be lowered below the
 *         one it was deployed with, an independent canceller can veto a
 *         queued operation, and the contract is always self-administered.
 *
 *         One veto is withheld from a canceller: it cannot cancel a queued
 *         single-call operation that revokes CANCELLER_ROLE from ITSELF.
 *         Without this, a captured canceller could cancel every operation,
 *         including the one removing it, and freeze the timelock (and with
 *         it the Diamond's root) for good. A proposer, or any OTHER
 *         canceller, can still cancel such an operation, so two cancellers
 *         overlapping during a rotation keep their veto over each other's
 *         removal. The cost is stated rather
 *         than hidden: a captured proposer can queue the canceller's
 *         removal and its own operation together. Both stay public for one
 *         full delay, and the canceller keeps its veto over the second one
 *         until the removal executes, so it must actually cancel it in that
 *         window. If it does not, both run after one delay. Only an
 *         operation queued AFTER the removal has run is beyond the veto,
 *         and that one waits a second full delay.
 *
 *         Two waits (owner decision 2026-11-19, option A). Every operation
 *         waits the STANDARD delay ({standardDelay}, never below
 *         {STANDARD_DELAY_FLOOR}, 7 days on a mainnet). Two kinds wait only
 *         the RESTART delay ({getMinDelay}, never below {MIN_DELAY_FLOOR},
 *         48 hours on a mainnet):
 *         - an operation whose every call is on the fixed restart list
 *           ({isRestartCall}): (target, selector) pairs, the target being
 *           the Diamond fixed at deploy ({RESTART_TARGET}) and the
 *           selectors fixed in code ({restartSelectors}). Each lifts a pause
 *           in a fixed direction, so the selector alone shows what the call
 *           does; a setter taking the new value as an argument can never be
 *           on the list. No operation can add to it;
 *         - an urgent fix: an operation whose exact id an urgent approver
 *           (the pause multisig) approved before it was scheduled
 *           ({approveUrgent}). The approval is spent by that scheduling. An
 *           urgent approver can never be a proposer, so a short wait always
 *           needs two independent parties.
 *         Anything else scheduled below the standard delay is refused
 *         ({DelayBelowRequired}). A lower delay is never the default: the
 *         restart list is closed, and an urgent approval names one id.
 *
 *         One OZ behaviour is kept and stated here rather than changed:
 *         an operation has no expiry. Once ready it stays executable by
 *         any executor (anyone, with the open executor) until it is run
 *         or cancelled. A scheduled-then-forgotten operation is therefore
 *         a standing authorisation — cancel what will not be run, and
 *         watch {getPendingProposals} for stale entries.
 *
 * @dev Every public scheduling / cancellation / execution path is
 *      overridden to push or swap-pop a `bytes32 activeProposalIds`
 *      array; the bare OZ contract maintains only a per-id
 *      `_timestamps` mapping and no array, so this is the minimal
 *      hook that gets us the iterable view without re-implementing
 *      the protocol's timelock semantics.
 *
 *      The IPFS-frontend goal — render governance state from chain
 *      alone — needs this on-chain list because OZ doesn't expose
 *      the equivalent of {ProposalScheduled}/{Cancelled} as a
 *      derivable array. A subgraph would otherwise be the only path.
 *
 *      Storage cost: one slot per active proposal + one slot per
 *      proposal in the index map (used for O(1) swap-pop on cancel
 *      / execute). Dropped on terminal transitions, so the steady-
 *      state slot count stays small (= queued operations awaiting
 *      execution).
 *
 *      The base contract's `schedule` / `cancel` / `execute` paths
 *      are public + virtual — overriding them and calling `super`
 *      preserves every existing access-control + timing check.
 */
contract VaipakamTimelock is TimelockController {
    /// @notice Snapshot of a queued operation, returned by
    ///         {getPendingProposals}.
    /// @param id        OZ's keccak256 hash identifier for the op.
    /// @param eta       Earliest execution timestamp (Unix seconds);
    ///        0 indicates the operation is no longer pending (defensive).
    /// @param ready     `true` once `block.timestamp >= eta` AND the
    ///        operation has not been executed.
    struct PendingProposal {
        bytes32 id;
        uint256 eta;
        bool ready;
    }

    /// @notice IDs of proposals currently queued (scheduled, not yet
    ///         executed or cancelled). Order is preserved up to
    ///         swap-pop removals, so callers should treat the list
    ///         as unordered.
    bytes32[] private _activeProposalIds;

    /// @notice Index of each id within {_activeProposalIds} + 1
    ///         (storing `index + 1` so the default zero value means
    ///         "not present"). Maintained by the override hooks for
    ///         O(1) swap-pop removal.
    mapping(bytes32 => uint256) private _activeIdIndexPlus1;

    /// @notice The lowest delay {updateDelay} may ever set: the delay this
    ///         timelock was deployed with (#938). Raising the delay stays a
    ///         normal queued operation; lowering it below the deploy-time
    ///         figure is refused outright, so one scheduled operation can
    ///         never turn the timelock into a pass-through.
    uint256 public immutable MIN_DELAY_FLOOR;

    /// @dev {updateDelay} asked for less than {MIN_DELAY_FLOOR}.
    error DelayBelowFloor(uint256 requested, uint256 floor);

    /// @notice The role that may approve one exact operation as an urgent fix
    ///         ({approveUrgent}). Held by the pause multisig; never by a
    ///         proposer.
    bytes32 public constant URGENT_APPROVER_ROLE = keccak256("URGENT_APPROVER_ROLE");

    /// @notice The lowest {standardDelay} may ever be: the standard delay
    ///         this timelock was deployed with.
    uint256 public immutable STANDARD_DELAY_FLOOR;

    /// @notice The one contract a restart call may target: the Diamond.
    ///         Fixed at deploy; `address(0)` means no call is a restart.
    address public immutable RESTART_TARGET;

    /// @dev The wait every operation not on the restart list and not
    ///      approved as urgent must have. Never below {STANDARD_DELAY_FLOOR}
    ///      and never below {getMinDelay}.
    uint256 private _standardDelay;

    /// @notice The highest {standardDelay} may ever be. A cap keeps
    ///         `block.timestamp + delay` from overflowing, which would make
    ///         every operation but a restart impossible to schedule.
    uint256 public constant MAX_STANDARD_DELAY = 30 days;

    /// @notice How long an urgent approval stays usable after it is given.
    ///         An urgent fix is scheduled promptly; an approval left unused
    ///         past this window lapses, so no approval waits in the dark to
    ///         be used long after the situation it was given for.
    uint256 public constant URGENT_APPROVAL_WINDOW = 3 days;

    /// @dev One unspent urgent approval: who gave it and when.
    struct UrgentApproval {
        address approver;
        uint64 approvedAt;
    }

    /// @dev Operation ids an urgent approver approved and nobody has
    ///      scheduled yet. An approval counts only while its approver still
    ///      holds {URGENT_APPROVER_ROLE} and for {URGENT_APPROVAL_WINDOW}
    ///      after it was given ({isUrgentApproved}), so revoking a rotated or
    ///      compromised approver voids every approval it left behind.
    mapping(bytes32 => UrgentApproval) private _urgentApproved;

    /// @notice The standard delay changed.
    event StandardDelayChange(uint256 oldDuration, uint256 newDuration);

    /// @notice `approver` approved operation `id` as an urgent fix.
    event UrgentApproved(bytes32 indexed id, address indexed approver);

    /// @notice `approver` withdrew the urgent approval of operation `id`
    ///         before it was scheduled.
    event UrgentApprovalWithdrawn(bytes32 indexed id, address indexed approver);

    /// @notice Operation `id` was scheduled at the restart delay on an urgent
    ///         approval, which it spent.
    event UrgentApprovalSpent(bytes32 indexed id);

    /// @dev An operation was scheduled below the delay it needs.
    error DelayBelowRequired(bytes32 id, uint256 requested, uint256 required);

    /// @dev {updateStandardDelay} asked for less than
    ///      {STANDARD_DELAY_FLOOR} or less than {getMinDelay}.
    error StandardDelayOutOfRange(uint256 requested, uint256 floor);

    /// @dev A standard delay above {MAX_STANDARD_DELAY}.
    error StandardDelayAboveMax(uint256 requested, uint256 max);

    /// @dev {updateDelay} asked for more than {standardDelay}: the restart
    ///      delay is never the longer one.
    error RestartDelayAboveStandard(uint256 requested, uint256 standard);

    /// @dev One account would hold both PROPOSER_ROLE and
    ///      URGENT_APPROVER_ROLE, so one party alone could shorten a wait.
    error ProposerCannotApproveUrgent(address account);

    /// @dev The approval named is not pending.
    error UrgentApprovalNotPending(bytes32 id);

    /// @dev The operation was already scheduled, so an approval could never
    ///      apply to it.
    error UrgentApprovalForScheduledOperation(bytes32 id);

    /// @notice For each queued single-call operation that revokes
    ///         CANCELLER_ROLE on this timelock, the account it removes. That
    ///         account may not cancel it unless it is also a proposer (see
    ///         the contract notice). Cleared when the operation is executed
    ///         or cancelled.
    mapping(bytes32 => address) private _cancellerRemovalTarget;

    /// @notice How many calls this timelock has executed, counting each call
    ///         of a batch, from deployment on. It moves once per completed
    ///         call and never otherwise, so a reader who recorded it can tell
    ///         that governance has acted since — in particular the Diamond's
    ///         launch, which must execute against exactly the state its
    ///         proposal was decided on (#945, Codex #2686 r12).
    uint64 private _executedCalls;

    /// @dev Set while a call is executing ({_execute}), cleared when it
    ///      returns (a revert unwinds it with the call).
    bool private _executing;

    /// @notice A call tried to execute while another of this timelock's
    ///         calls was still executing (Codex #2686 r15). The inherited
    ///         controller lets a running call execute a DIFFERENT ready
    ///         operation; this timelock refuses, so every call runs to
    ///         completion before the next one starts and {executedCalls}
    ///         always counts every call that ran before the one reading it.
    ///         Without it, a governance call could run another operation
    ///         (the launch, say) from inside itself, while its own effects
    ///         were already in place but not yet counted.
    error NestedExecution();

    /// @dev The caller tried to cancel the operation that removes its own
    ///      CANCELLER_ROLE, without holding PROPOSER_ROLE.
    error CancellerRemovalNotCancellable(bytes32 id);

    /// @dev A zero address in the `cancellers` list: it would grant the
    ///      veto to nobody while the deploy log read as if a canceller
    ///      existed.
    error ZeroCanceller();

    /**
     * @param minDelay   The restart delay ({getMinDelay}), and permanently
     *                   the floor for {updateDelay} ({MIN_DELAY_FLOOR}).
     * @param standardDelay_ The standard delay ({standardDelay}), and
     *                   permanently its floor ({STANDARD_DELAY_FLOOR}). Not
     *                   below `minDelay`.
     * @param restartTarget_ The one contract whose restart calls may use the
     *                   restart delay: the Diamond ({RESTART_TARGET}).
     *                   `address(0)` leaves the restart list empty, so only
     *                   an approved urgent fix can use the restart delay.
     * @param proposers  Proposers. OZ also makes each a canceller.
     * @param executors  Executors; `address(0)` means anyone may execute a
     *                   ready operation.
     * @param cancellers Additional cancellers that are NOT proposers
     *                   (#938) — an independent party that can veto a
     *                   queued operation during its delay window. Without
     *                   one, a malicious operation's only defence is that
     *                   someone notices and exits. May be empty (testnets);
     *                   the mainnet deploy requires one.
     * @param urgentApprovers Holders of {URGENT_APPROVER_ROLE} (the pause
     *                   multisig). None may be a proposer. May be empty: then
     *                   no urgent fix can be approved until one is granted,
     *                   which waits the standard delay.
     * @dev The OZ `admin` argument is fixed to `address(0)`: the timelock
     *      administers itself, so changing proposers, cancellers or the
     *      delay goes through its own queue. A non-zero admin could
     *      re-wire every role with no delay, so it is not offered.
     */
    constructor(
        uint256 minDelay,
        uint256 standardDelay_,
        address restartTarget_,
        address[] memory proposers,
        address[] memory executors,
        address[] memory cancellers,
        address[] memory urgentApprovers
    ) TimelockController(minDelay, proposers, executors, address(0)) {
        if (standardDelay_ < minDelay) revert StandardDelayOutOfRange(standardDelay_, minDelay);
        if (standardDelay_ > MAX_STANDARD_DELAY) revert StandardDelayAboveMax(standardDelay_, MAX_STANDARD_DELAY);
        MIN_DELAY_FLOOR = minDelay;
        STANDARD_DELAY_FLOOR = standardDelay_;
        RESTART_TARGET = restartTarget_;
        _standardDelay = standardDelay_;
        emit StandardDelayChange(0, standardDelay_);
        for (uint256 i = 0; i < cancellers.length; ++i) {
            if (cancellers[i] == address(0)) revert ZeroCanceller();
            _grantRole(CANCELLER_ROLE, cancellers[i]);
        }
        _setRoleAdmin(URGENT_APPROVER_ROLE, DEFAULT_ADMIN_ROLE);
        for (uint256 i = 0; i < urgentApprovers.length; ++i) {
            if (urgentApprovers[i] == address(0)) revert ZeroCanceller();
            _grantRole(URGENT_APPROVER_ROLE, urgentApprovers[i]);
        }
    }

    // ─── The two waits ───────────────────────────────────────────────────

    /// @notice The wait every operation needs unless it is a restart or an
    ///         approved urgent fix. {getMinDelay} is the restart delay, the
    ///         shortest wait any operation may have.
    function standardDelay() public view returns (uint256) {
        return _standardDelay;
    }

    /// @notice Change the standard delay. Only the timelock itself, so the
    ///         change is its own queued operation (and waits the standard
    ///         delay). Never below {STANDARD_DELAY_FLOOR} or {getMinDelay},
    ///         never above {MAX_STANDARD_DELAY}.
    function updateStandardDelay(uint256 newDelay) external {
        address sender = _msgSender();
        if (sender != address(this)) revert TimelockUnauthorizedCaller(sender);
        uint256 floor = STANDARD_DELAY_FLOOR > getMinDelay() ? STANDARD_DELAY_FLOOR : getMinDelay();
        if (newDelay < floor) revert StandardDelayOutOfRange(newDelay, floor);
        if (newDelay > MAX_STANDARD_DELAY) revert StandardDelayAboveMax(newDelay, MAX_STANDARD_DELAY);
        emit StandardDelayChange(_standardDelay, newDelay);
        _standardDelay = newDelay;
    }

    /// @notice Approve the exact operation `id` as an urgent fix, so it may
    ///         be scheduled at the restart delay. Only an urgent approver,
    ///         and only before the operation is scheduled; scheduling spends
    ///         the approval. `id` is {hashOperation} or {hashOperationBatch}
    ///         of the operation, salt included, so it names one change.
    ///         The approval is bound to its approver and lapses after
    ///         {URGENT_APPROVAL_WINDOW}; approving again restarts the window.
    function approveUrgent(bytes32 id) external onlyRole(URGENT_APPROVER_ROLE) {
        if (isOperation(id)) revert UrgentApprovalForScheduledOperation(id);
        address approver = _msgSender();
        _urgentApproved[id] = UrgentApproval({approver: approver, approvedAt: uint64(block.timestamp)});
        emit UrgentApproved(id, approver);
    }

    /// @notice Withdraw an urgent approval nobody has used yet, lapsed or
    ///         not. Any urgent approver may withdraw one.
    function withdrawUrgentApproval(bytes32 id) external onlyRole(URGENT_APPROVER_ROLE) {
        if (_urgentApproved[id].approver == address(0)) revert UrgentApprovalNotPending(id);
        delete _urgentApproved[id];
        emit UrgentApprovalWithdrawn(id, _msgSender());
    }

    /// @notice Whether operation `id` holds an urgent approval that would let
    ///         it be scheduled now: unspent, given by an account that still
    ///         holds {URGENT_APPROVER_ROLE}, and within
    ///         {URGENT_APPROVAL_WINDOW} of when it was given.
    function isUrgentApproved(bytes32 id) public view returns (bool) {
        UrgentApproval memory a = _urgentApproved[id];
        if (a.approver == address(0)) return false;
        if (!hasRole(URGENT_APPROVER_ROLE, a.approver)) return false;
        return block.timestamp <= uint256(a.approvedAt) + URGENT_APPROVAL_WINDOW;
    }

    /// @notice Who gave operation `id`'s unspent approval and when; zero
    ///         when none is recorded. Read {isUrgentApproved} for whether it
    ///         still counts.
    function urgentApproval(bytes32 id) external view returns (address approver, uint64 approvedAt) {
        UrgentApproval memory a = _urgentApproved[id];
        return (a.approver, a.approvedAt);
    }

    /// @notice The selectors on the restart list, each called on
    ///         {RESTART_TARGET}. Fixed in code: the whole-platform unpause
    ///         (`unpause()`, `unpauseIfPauseEpoch(uint64)`) and the per-asset
    ///         unpause (`unpauseAsset(address)`). Each lifts a pause and only
    ///         that, whatever its argument. The deploy refuses a Diamond that
    ///         does not route every one of them.
    function restartSelectors() external pure returns (bytes4[] memory sels) {
        sels = new bytes4[](3);
        sels[0] = SEL_UNPAUSE;
        sels[1] = SEL_UNPAUSE_ASSET;
        sels[2] = SEL_UNPAUSE_IF_EPOCH;
    }

    /// @notice Whether one call is on the fixed restart list: a restart
    ///         selector ({restartSelectors}) called on {RESTART_TARGET}, with
    ///         the exact calldata length and no value, so a padded or
    ///         value-carrying call is not a restart.
    function isRestartCall(address target, uint256 value, bytes calldata data) public view returns (bool) {
        if (target == address(0) || target != RESTART_TARGET) return false;
        if (value != 0 || data.length < 4) return false;
        bytes4 sel = bytes4(data[:4]);
        if (data.length == 4) return sel == SEL_UNPAUSE;
        if (data.length == 36) return sel == SEL_UNPAUSE_ASSET || sel == SEL_UNPAUSE_IF_EPOCH;
        return false;
    }

    /// @notice The wait operation `id` needs, given its calls: the restart
    ///         delay when every call is a restart or `id` holds an urgent
    ///         approval, else the standard delay.
    function requiredDelay(
        bytes32 id,
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata payloads
    ) public view returns (uint256) {
        if (isUrgentApproved(id)) return getMinDelay();
        uint256 n = targets.length;
        if (n == 0 || n != values.length || n != payloads.length) return _standardDelay;
        for (uint256 i = 0; i < n; ++i) {
            if (!isRestartCall(targets[i], values[i], payloads[i])) return _standardDelay;
        }
        return getMinDelay();
    }

    bytes4 private constant SEL_UNPAUSE = bytes4(keccak256("unpause()"));
    bytes4 private constant SEL_UNPAUSE_ASSET = bytes4(keccak256("unpauseAsset(address)"));
    bytes4 private constant SEL_UNPAUSE_IF_EPOCH = bytes4(keccak256("unpauseIfPauseEpoch(uint64)"));

    /// @dev Refuses `delay` below what `id` needs, and spends any urgent
    ///      approval recorded for `id` (a lapsed one is cleared too: the
    ///      operation is now scheduled, so it could never apply again).
    function _requireDelay(bytes32 id, uint256 delay, uint256 required) private {
        if (delay < required) revert DelayBelowRequired(id, delay, required);
        if (_urgentApproved[id].approver != address(0)) {
            bool live = isUrgentApproved(id);
            delete _urgentApproved[id];
            if (live) emit UrgentApprovalSpent(id);
        }
    }

    /// @dev Keeps the proposer and the urgent approver apart: one party alone
    ///      must never be able to schedule a change at the restart delay.
    function _grantRole(bytes32 role, address account) internal virtual override returns (bool) {
        if (role == PROPOSER_ROLE && hasRole(URGENT_APPROVER_ROLE, account)) {
            revert ProposerCannotApproveUrgent(account);
        }
        if (role == URGENT_APPROVER_ROLE && hasRole(PROPOSER_ROLE, account)) {
            revert ProposerCannotApproveUrgent(account);
        }
        return super._grantRole(role, account);
    }

    /// @inheritdoc TimelockController
    /// @dev Adds the {MIN_DELAY_FLOOR} check (#938). OZ's own rule — only
    ///      the timelock itself may call it — is kept by `super`.
    function updateDelay(uint256 newDelay) public virtual override {
        if (newDelay < MIN_DELAY_FLOOR) revert DelayBelowFloor(newDelay, MIN_DELAY_FLOOR);
        if (newDelay > _standardDelay) revert RestartDelayAboveStandard(newDelay, _standardDelay);
        super.updateDelay(newDelay);
    }

    // ─── Override hooks ──────────────────────────────────────────────────

    /// @inheritdoc TimelockController
    /// @dev Single-call schedule path. Adds the resulting id to the
    ///      active list after the base's checks + emit, and records the
    ///      account removed when it revokes CANCELLER_ROLE on this timelock.
    function schedule(
        address target,
        uint256 value,
        bytes calldata data,
        bytes32 predecessor,
        bytes32 salt,
        uint256 delay
    ) public virtual override {
        bytes32 id = hashOperation(target, value, data, predecessor, salt);
        _requireDelay(
            id,
            delay,
            isUrgentApproved(id) || isRestartCall(target, value, data) ? getMinDelay() : _standardDelay
        );
        super.schedule(target, value, data, predecessor, salt, delay);
        _addActive(id);
        address removed = _cancellerRemoved(target, value, data);
        if (removed != address(0)) _cancellerRemovalTarget[id] = removed;
    }

    /// @inheritdoc TimelockController
    /// @dev Multi-call schedule path. Same hook; the batch id covers
    ///      the whole call list. A batch is never marked as a canceller
    ///      removal, so it stays cancellable by any canceller, including the
    ///      one it removes: remove a
    ///      canceller with a single-call {schedule}.
    function scheduleBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata payloads,
        bytes32 predecessor,
        bytes32 salt,
        uint256 delay
    ) public virtual override {
        bytes32 id = hashOperationBatch(targets, values, payloads, predecessor, salt);
        _requireDelay(id, delay, requiredDelay(id, targets, values, payloads));
        super.scheduleBatch(targets, values, payloads, predecessor, salt, delay);
        _addActive(id);
    }

    /// @inheritdoc TimelockController
    /// @dev The canceller an operation removes cannot cancel it unless it
    ///      is also a proposer; everyone else keeps OZ's CANCELLER_ROLE rule.
    function cancel(bytes32 id) public virtual override {
        address removed = _cancellerRemovalTarget[id];
        if (removed != address(0)) {
            if (_msgSender() == removed && !hasRole(PROPOSER_ROLE, removed)) {
                revert CancellerRemovalNotCancellable(id);
            }
            delete _cancellerRemovalTarget[id];
        }
        super.cancel(id);
        _removeActive(id);
    }

    /// @inheritdoc TimelockController
    function execute(
        address target,
        uint256 value,
        bytes calldata payload,
        bytes32 predecessor,
        bytes32 salt
    ) public payable virtual override {
        super.execute(target, value, payload, predecessor, salt);
        bytes32 id = hashOperation(target, value, payload, predecessor, salt);
        _removeActive(id);
        delete _cancellerRemovalTarget[id];
    }

    /// @inheritdoc TimelockController
    function executeBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata payloads,
        bytes32 predecessor,
        bytes32 salt
    ) public payable virtual override {
        super.executeBatch(targets, values, payloads, predecessor, salt);
        _removeActive(hashOperationBatch(targets, values, payloads, predecessor, salt));
    }

    /// @dev Counts the call AFTER it completes, so while a call is running
    ///      the count still excludes it: a call can read the count and see
    ///      exactly the calls that ran before it. Refuses to start while
    ///      another call is executing ({NestedExecution}), which is what
    ///      makes "the calls that ran before it" mean every call whose
    ///      effects are in place: no call can begin inside another one,
    ///      before that one has been counted.
    function _execute(address target, uint256 value, bytes calldata data) internal virtual override {
        if (_executing) revert NestedExecution();
        _executing = true;
        super._execute(target, value, data);
        _executing = false;
        unchecked {
            ++_executedCalls;
        }
    }

    /// @notice How many calls this timelock has completed (see
    ///         {_executedCalls}). While a call runs, the count excludes it.
    function executedCalls() external view returns (uint64) {
        return _executedCalls;
    }

    /// @dev The account removed when the call is
    ///      `revokeRole(CANCELLER_ROLE, account)` on this timelock, else
    ///      `address(0)`. Exact-length calldata only, so a padded encoding is
    ///      not recognised (it would still revoke, and would simply remain
    ///      cancellable by the canceller it removes).
    function _cancellerRemoved(address target, uint256 value, bytes calldata data)
        private
        view
        returns (address)
    {
        if (target != address(this) || value != 0 || data.length != 68) return address(0);
        if (bytes4(data[:4]) != IAccessControl.revokeRole.selector) return address(0);
        (bytes32 role, address account) = abi.decode(data[4:], (bytes32, address));
        return role == CANCELLER_ROLE ? account : address(0);
    }

    /// @notice The canceller queued operation `id` removes, which therefore
    ///         cannot cancel it; `address(0)` when `id` removes no canceller.
    function cancellerRemovalTarget(bytes32 id) external view returns (address) {
        return _cancellerRemovalTarget[id];
    }

    // ─── Public read surface ─────────────────────────────────────────────

    /// @notice `windowDays` must be in `[1, 100]`.
    error LimitTooLarge(uint256 requested, uint256 max);

    uint32 public constant MAX_PAGE_LIMIT = 100;

    /// @notice Total number of queued (scheduled-not-yet-executed)
    ///         proposals. Used by frontends to drive the page UI.
    function getPendingProposalsCount() external view returns (uint256) {
        return _activeProposalIds.length;
    }

    /// @notice Paginated snapshot of every currently-queued proposal.
    ///         Page size capped at {MAX_PAGE_LIMIT} (= 100).
    /// @dev    Each row carries the OZ id + eta (earliest-execution
    ///         timestamp) + a derived `ready` flag. Per D8 the
    ///         payload field is intentionally omitted — the frontend
    ///         decodes target+value+data from the `CallScheduled` /
    ///         `CallScheduledBatch` event indexed off-chain. This
    ///         keeps the on-chain view light AND lets consumers
    ///         reuse their existing per-target calldata decoders.
    /// @param  offset Skip this many entries.
    /// @param  limit  Max page size (≤ {MAX_PAGE_LIMIT}).
    function getPendingProposals(uint32 offset, uint32 limit)
        external
        view
        returns (PendingProposal[] memory page)
    {
        if (limit > MAX_PAGE_LIMIT) revert LimitTooLarge(limit, MAX_PAGE_LIMIT);
        uint256 total = _activeProposalIds.length;
        if (offset >= total) {
            return new PendingProposal[](0);
        }
        uint256 windowEnd = offset + limit;
        if (windowEnd > total) windowEnd = total;
        uint256 size = windowEnd - offset;

        page = new PendingProposal[](size);
        for (uint256 i = 0; i < size; i++) {
            bytes32 id = _activeProposalIds[offset + i];
            uint256 eta = getTimestamp(id);
            page[i] = PendingProposal({
                id: id,
                eta: eta,
                ready: eta != 0 && block.timestamp >= eta && !isOperationDone(id)
            });
        }
    }

    // ─── Internal index maintenance ──────────────────────────────────────

    /// @dev Append `id` if not already present. Idempotent — OZ's
    ///      `schedule` reverts on duplicate id before this hook runs,
    ///      so the guard is defensive only.
    function _addActive(bytes32 id) internal {
        if (_activeIdIndexPlus1[id] != 0) return;
        _activeProposalIds.push(id);
        _activeIdIndexPlus1[id] = _activeProposalIds.length; // index + 1
    }

    /// @dev Swap-pop `id` out of `_activeProposalIds`. Idempotent —
    ///      `super.cancel`/`super.execute` will already have reverted
    ///      if the id was unknown to the base contract.
    function _removeActive(bytes32 id) internal {
        uint256 idxPlus1 = _activeIdIndexPlus1[id];
        if (idxPlus1 == 0) return;
        uint256 idx = idxPlus1 - 1;
        uint256 last = _activeProposalIds.length - 1;
        if (idx != last) {
            bytes32 lastId = _activeProposalIds[last];
            _activeProposalIds[idx] = lastId;
            _activeIdIndexPlus1[lastId] = idx + 1;
        }
        _activeProposalIds.pop();
        delete _activeIdIndexPlus1[id];
    }
}
