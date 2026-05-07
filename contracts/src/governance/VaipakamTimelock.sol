// src/governance/VaipakamTimelock.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title  VaipakamTimelock
 * @author Vaipakam Developer Team
 * @notice OZ {TimelockController} extended with an on-chain
 *         pending-proposal list so the AdminDashboard can render
 *         "what's queued for execution" without an event-replay
 *         dependency. AnalyticalGettersDesign §3.3 (decision D7
 *         resolved here: the standalone-contract option).
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

    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {}

    // ─── Override hooks ──────────────────────────────────────────────────

    /// @inheritdoc TimelockController
    /// @dev Single-call schedule path. Adds the resulting id to the
    ///      active list after the base's checks + emit.
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
    }

    /// @inheritdoc TimelockController
    /// @dev Multi-call schedule path. Same hook; the batch id covers
    ///      the whole call list.
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
    function cancel(bytes32 id) public virtual override {
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
        _removeActive(hashOperation(target, value, payload, predecessor, salt));
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
