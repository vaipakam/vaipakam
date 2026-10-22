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
 *         than hidden: a captured proposer can remove the canceller, but
 *         only through one full public delay before its own operation can
 *         even be queued, so the veto becomes a warning of two delays.
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

    /// @notice For each queued single-call operation that revokes
    ///         CANCELLER_ROLE on this timelock, the account it removes. That
    ///         account may not cancel it unless it is also a proposer (see
    ///         the contract notice). Cleared when the operation is executed
    ///         or cancelled.
    mapping(bytes32 => address) private _cancellerRemovalTarget;

    /// @dev The caller tried to cancel the operation that removes its own
    ///      CANCELLER_ROLE, without holding PROPOSER_ROLE.
    error CancellerRemovalNotCancellable(bytes32 id);

    /// @dev A zero address in the `cancellers` list: it would grant the
    ///      veto to nobody while the deploy log read as if a canceller
    ///      existed.
    error ZeroCanceller();

    /**
     * @param minDelay   Initial minimum delay, and permanently the floor for
     *                   {updateDelay} ({MIN_DELAY_FLOOR}).
     * @param proposers  Proposers. OZ also makes each a canceller.
     * @param executors  Executors; `address(0)` means anyone may execute a
     *                   ready operation.
     * @param cancellers Additional cancellers that are NOT proposers
     *                   (#938) — an independent party that can veto a
     *                   queued operation during its delay window. Without
     *                   one, a malicious operation's only defence is that
     *                   someone notices and exits. May be empty (testnets);
     *                   the mainnet deploy requires one.
     * @dev The OZ `admin` argument is fixed to `address(0)`: the timelock
     *      administers itself, so changing proposers, cancellers or the
     *      delay goes through its own queue. A non-zero admin could
     *      re-wire every role with no delay, so it is not offered.
     */
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address[] memory cancellers
    ) TimelockController(minDelay, proposers, executors, address(0)) {
        MIN_DELAY_FLOOR = minDelay;
        for (uint256 i = 0; i < cancellers.length; ++i) {
            if (cancellers[i] == address(0)) revert ZeroCanceller();
            _grantRole(CANCELLER_ROLE, cancellers[i]);
        }
    }

    /// @inheritdoc TimelockController
    /// @dev Adds the {MIN_DELAY_FLOOR} check (#938). OZ's own rule — only
    ///      the timelock itself may call it — is kept by `super`.
    function updateDelay(uint256 newDelay) public virtual override {
        if (newDelay < MIN_DELAY_FLOOR) revert DelayBelowFloor(newDelay, MIN_DELAY_FLOOR);
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
        super.schedule(target, value, data, predecessor, salt, delay);
        bytes32 id = hashOperation(target, value, data, predecessor, salt);
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
        super.scheduleBatch(targets, values, payloads, predecessor, salt, delay);
        bytes32 id = hashOperationBatch(targets, values, payloads, predecessor, salt);
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
