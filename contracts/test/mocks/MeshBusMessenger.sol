// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {
    IRewardMessenger,
    RewardBroadcastV2
} from "../../src/interfaces/IRewardMessenger.sol";
import {RewardAggregatorFacet} from "../../src/facets/RewardAggregatorFacet.sol";
import {RewardReporterFacet} from "../../src/facets/RewardReporterFacet.sol";

/**
 * @title  MeshBusMessenger
 * @notice #1222 M3 B4-b — a QUEUEING, multi-diamond reward messenger for the
 *         three-chain mesh end-to-end suite.
 *
 * @dev    Why this exists rather than reusing {MockRewardMessenger}: that
 *         mock is bound to ONE diamond (`require(msg.sender == diamond)`) and
 *         its `deliver*` helpers SYNTHESISE an inbound message from
 *         test-supplied arguments. Every mesh test written against it
 *         therefore fakes the mirror side — no mirror-local bucket,
 *         reservation ledger or B3 retirement counter actually exists, so
 *         Base's model of a chain can never be compared against that chain's
 *         real books. This messenger delivers only figures a REAL diamond
 *         produced.
 *
 *         **Queueing, not relaying.** A send does not deliver: it enqueues.
 *         Delivery is a separate, test-driven step, for one hard reason and
 *         one useful one.
 *
 *           - Hard: the destination's ingress asserts
 *             `b.destChainId == block.chainid`, and only the TEST can call
 *             `vm.chainId` — a contract cannot set the chain id mid-call. So
 *             the test must warp the chain id and then ask the bus to deliver.
 *           - Useful: holding messages in a queue hands the test explicit
 *             control over ORDERING, DUPLICATION (deliver the same index
 *             twice) and DROPS (never deliver an index) — the three
 *             sequencing hazards the governor §7 #6 clauses are about.
 *
 *         **Transparent transport, deliberately.** The bus composes the
 *         per-destination {RewardBroadcastV2} from `shared ∪ perDest` with
 *         the identical field mapping as the production encoder
 *         (`VaipakamRewardMessenger._encodeBroadcastV2`) but performs no
 *         `abi.encode`/`decode` round trip and charges no fee. The wire
 *         itself — payload framing, generation fallbacks, fee accounting — is
 *         covered by `CrossChainRewardPlumbingTest`; this harness isolates
 *         the MESH ACCOUNTING across real diamonds, so a transparent
 *         transport is the correct scope, not a gap.
 */
contract MeshBusMessenger is IRewardMessenger {
    // ─── Enrollment ────────────────────────────────────────────────────────

    /// @notice Chain id of each enrolled diamond (0 ⇒ not enrolled).
    mapping(address => uint256) public chainIdOf;
    /// @notice Diamond acting as each enrolled chain.
    mapping(uint256 => address) public diamondOf;
    /// @notice The canonical (Base) diamond — the only permitted broadcaster
    ///         and the destination of every queued report.
    address public baseDiamond;

    uint256[] internal dests;

    // ─── Queues ────────────────────────────────────────────────────────────

    /// @notice A mirror→Base day-close report, exactly as the mirror sent it.
    struct QueuedReport {
        uint256 srcChainId;
        uint256 dayId;
        uint256 lenderNumeraire18;
        uint256 borrowerNumeraire18;
        uint256 recycledCumulative18;
        uint256 recycledForDay18;
        uint256 commitRetiredCumulative18;
        uint256 commitReleasedCumulative18;
        /// @dev Which `sendChainReport` generation the sending diamond
        ///      reached (8 = current, 6 = B1, 4 = legacy) — lets a test
        ///      assert the reporter's fallback shim took the expected branch.
        uint256 arity;
    }

    QueuedReport[] internal reports;
    RewardBroadcastV2[] internal broadcasts;

    /// @notice How many times each queued message has been DELIVERED — a
    ///         duplicate-delivery test asserts on this rather than trusting
    ///         that it re-sent.
    mapping(uint256 => uint256) public reportDeliveries;
    mapping(uint256 => uint256) public broadcastDeliveries;

    error NotEnrolled(address caller);
    error NotBase(address caller);
    error DestinationSetMismatch(uint256 got, uint256 want);
    error DestinationNotFunded(uint256 destChainId);

    // ─── Wiring ────────────────────────────────────────────────────────────

    /// @notice Enroll `diamond` as the mesh participant for `chainId`.
    /// @param isBase True for the canonical chain (at most one).
    function enroll(uint256 chainId, address diamond, bool isBase) external {
        chainIdOf[diamond] = chainId;
        diamondOf[chainId] = diamond;
        if (isBase) baseDiamond = diamond;
    }

    /// @notice Set the broadcast destination list Base fans out to.
    function setBroadcastDestinations(uint256[] calldata d) external {
        dests = d;
    }

    function getBroadcastDestinations()
        external
        view
        override
        returns (uint256[] memory)
    {
        return dests;
    }

    // ─── Queue introspection ───────────────────────────────────────────────

    function reportCount() external view returns (uint256) {
        return reports.length;
    }

    function broadcastCount() external view returns (uint256) {
        return broadcasts.length;
    }

    function reportAt(uint256 i) external view returns (QueuedReport memory) {
        return reports[i];
    }

    function broadcastAt(uint256 i)
        external
        view
        returns (RewardBroadcastV2 memory)
    {
        return broadcasts[i];
    }

    /// @notice Index of the queued broadcast for `destChainId` on `dayId`,
    ///         reverting if absent — so a test can address one destination's
    ///         packet without hard-coding fan-out order.
    function findBroadcast(uint256 dayId, uint256 destChainId)
        external
        view
        returns (uint256)
    {
        for (uint256 i; i < broadcasts.length; ++i) {
            if (
                broadcasts[i].dayId == dayId
                    && broadcasts[i].destChainId == destChainId
            ) {
                return i;
            }
        }
        revert DestinationNotFunded(destChainId);
    }

    // ─── Send side (called by a diamond) ───────────────────────────────────

    /// @dev The CURRENT eight-word report. `msg.sender` identifies the
    ///      sending chain — the bus never takes a caller's word for its own
    ///      identity, exactly like a real lane.
    function sendChainReport(
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        uint256 recycledCumulative18,
        uint256 recycledForDay18,
        uint256 commitRetiredCumulative18,
        uint256 commitReleasedCumulative18,
        address payable
    ) external payable override {
        reports.push(
            QueuedReport({
                srcChainId: _senderChainId(),
                dayId: dayId,
                lenderNumeraire18: lenderNumeraire18,
                borrowerNumeraire18: borrowerNumeraire18,
                recycledCumulative18: recycledCumulative18,
                recycledForDay18: recycledForDay18,
                commitRetiredCumulative18: commitRetiredCumulative18,
                commitReleasedCumulative18: commitReleasedCumulative18,
                arity: 8
            })
        );
    }

    /// @dev The B1 six-word shape (kept live so the reporter's fallback shim
    ///      has somewhere to land if a test drives it).
    function sendChainReport(
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        uint256 recycledCumulative18,
        uint256 recycledForDay18,
        address payable
    ) external payable override {
        reports.push(
            QueuedReport({
                srcChainId: _senderChainId(),
                dayId: dayId,
                lenderNumeraire18: lenderNumeraire18,
                borrowerNumeraire18: borrowerNumeraire18,
                recycledCumulative18: recycledCumulative18,
                recycledForDay18: recycledForDay18,
                commitRetiredCumulative18: 0,
                commitReleasedCumulative18: 0,
                arity: 6
            })
        );
    }

    /// @dev Per-destination V2 fan-out. Mirrors the production messenger's
    ///      contract exactly: the configured destination set is the
    ///      authority, and every configured destination must have exactly one
    ///      funded entry (equal lengths + every-configured-found rules out
    ///      both extras and duplicates).
    function broadcastDayV2(
        IRewardMessenger.BroadcastV2Shared calldata shared,
        IRewardMessenger.BroadcastV2PerDest[] calldata perDest,
        address payable
    ) external payable override {
        if (msg.sender != baseDiamond) revert NotBase(msg.sender);
        uint256 n = dests.length;
        if (perDest.length != n) {
            revert DestinationSetMismatch(perDest.length, n);
        }
        for (uint256 i; i < n; ++i) {
            broadcasts.push(_compose(shared, _findDest(perDest, dests[i])));
        }
    }

    // ─── Deliver side (called by the TEST, after `vm.chainId`) ─────────────

    /// @notice Deliver queued report `i` to the canonical aggregator.
    /// @dev Called from the test so the bus is `msg.sender` at the ingress,
    ///      satisfying `onlyRewardMessenger`. Deliberately re-callable: a
    ///      duplicate delivery is a real lane behaviour and the ingress —
    ///      not the bus — must be the thing that rejects it.
    function deliverReport(uint256 i) external {
        QueuedReport memory r = reports[i];
        reportDeliveries[i] += 1;
        RewardAggregatorFacet(baseDiamond).onChainReportReceived(
            uint32(r.srcChainId),
            r.dayId,
            r.lenderNumeraire18,
            r.borrowerNumeraire18,
            r.recycledCumulative18,
            r.recycledForDay18,
            r.commitRetiredCumulative18,
            r.commitReleasedCumulative18
        );
    }

    /// @notice Deliver queued broadcast `i` to its destination diamond.
    /// @dev The caller must have set `vm.chainId(broadcastAt(i).destChainId)`
    ///      first; otherwise the ingress's replay-stable binding rejects it
    ///      with `BroadcastDestinationMismatch`, which is the behaviour under
    ///      test in the mis-routing case.
    function deliverBroadcast(uint256 i) external {
        RewardBroadcastV2 memory b = broadcasts[i];
        broadcastDeliveries[i] += 1;
        RewardReporterFacet(diamondOf[b.destChainId])
            .onRewardBroadcastV2Received(b);
    }

    /// @notice Deliver queued broadcast `i` to an ARBITRARY diamond — the
    ///         mis-routing probe (a delayed delivery after a destination-list
    ///         edit). Kept separate so the ordinary path cannot silently
    ///         cross-wire.
    function deliverBroadcastTo(uint256 i, address diamond) external {
        broadcastDeliveries[i] += 1;
        RewardReporterFacet(diamond).onRewardBroadcastV2Received(broadcasts[i]);
    }

    // ─── Internals ─────────────────────────────────────────────────────────

    function _senderChainId() private view returns (uint256 id) {
        id = chainIdOf[msg.sender];
        if (id == 0) revert NotEnrolled(msg.sender);
    }

    /// @dev `shared ∪ perDest`, field-for-field as
    ///      `VaipakamRewardMessenger._encodeBroadcastV2` builds it.
    function _compose(
        IRewardMessenger.BroadcastV2Shared calldata shared,
        IRewardMessenger.BroadcastV2PerDest calldata d
    ) private pure returns (RewardBroadcastV2 memory) {
        return RewardBroadcastV2({
            dayId: shared.dayId,
            globalLenderNumeraire18: shared.globalLenderNumeraire18,
            globalBorrowerNumeraire18: shared.globalBorrowerNumeraire18,
            capMode: shared.capMode,
            capPayloadLender: shared.capPayloadLender,
            capPayloadBorrower: shared.capPayloadBorrower,
            armedFromDay: shared.armedFromDay,
            freshLenderHalf: d.freshLenderHalf,
            freshBorrowerHalf: d.freshBorrowerHalf,
            recycledLenderHalfEquiv: d.recycledLenderHalfEquiv,
            recycledBorrowerHalfEquiv: d.recycledBorrowerHalfEquiv,
            recycleConsume: d.recycleConsume,
            keeperAllocate: d.keeperAllocate,
            destChainId: d.destChainId
        });
    }

    function _findDest(
        IRewardMessenger.BroadcastV2PerDest[] calldata perDest,
        uint256 destChainId
    ) private pure returns (IRewardMessenger.BroadcastV2PerDest calldata) {
        for (uint256 i; i < perDest.length; ++i) {
            if (perDest[i].destChainId == destChainId) return perDest[i];
        }
        revert DestinationNotFunded(destChainId);
    }

    // ─── Unused interface surface ──────────────────────────────────────────
    // Fee-free bus: every quote is zero, so `closeDay` / `broadcastGlobal`
    // need no `msg.value`. The remaining sends are not part of the B4-b
    // cycle and are inert rather than absent, so this stays concrete.

    function quoteSendChainReport(uint256, uint256, uint256, uint256, uint256)
        external
        pure
        override
        returns (uint256)
    {
        return 0;
    }

    function quoteSendChainReport(
        uint256,
        uint256,
        uint256,
        uint256,
        uint256,
        uint256,
        uint256
    ) external pure override returns (uint256) {
        return 0;
    }

    function quoteBroadcastGlobal(uint256, uint256, uint256)
        external
        pure
        override
        returns (uint256)
    {
        return 0;
    }

    function quoteBroadcastDayV2(
        IRewardMessenger.BroadcastV2Shared calldata,
        IRewardMessenger.BroadcastV2PerDest[] calldata
    ) external pure override returns (uint256) {
        return 0;
    }

    /// @dev The pre-B2-b flat broadcast. This bus configures a V2-capable
    ///      messenger, so reaching it means the facet took the legacy
    ///      fallback — a wiring error in a harness that never simulates an
    ///      un-upgraded proxy. Fail loud rather than silently swallow it.
    function broadcastGlobal(
        uint256,
        uint256,
        uint256,
        uint256,
        uint256,
        uint256,
        uint256,
        address payable
    ) external payable override {
        revert("MeshBus: legacy broadcast unexpected");
    }

    function sendCommitmentReport(uint256, uint256, uint256, address payable)
        external
        payable
        override
        returns (bytes32)
    {
        return bytes32(0);
    }

    function quoteSendCommitmentReport(uint256, uint256, uint256)
        external
        pure
        override
        returns (uint256)
    {
        return 0;
    }

    function sendRemitAck(uint256, uint256, address, address payable)
        external
        payable
        override
        returns (bytes32)
    {
        return bytes32(0);
    }

    function quoteSendRemitAck(uint256, uint256, address)
        external
        pure
        override
        returns (uint256)
    {
        return 0;
    }

    receive() external payable {}
}
