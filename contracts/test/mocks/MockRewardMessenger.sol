// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {
    IRewardMessenger,
    IRewardRemitAckIngress,
    RewardBroadcastV2
} from "../../src/interfaces/IRewardMessenger.sol";
import {RewardAggregatorFacet} from "../../src/facets/RewardAggregatorFacet.sol";
import {RewardReporterFacet} from "../../src/facets/RewardReporterFacet.sol";

/// @title MockRewardMessenger
/// @notice Test double for the production CCIP-backed reward messenger
///         (`VaipakamRewardMessenger`). Lets tests exercise the
///         trusted-ingress paths on `RewardAggregatorFacet` and
///         `RewardReporterFacet` without spinning up a full CCIP
///         router / OffRamp stack.
/// @dev Two operating modes per test:
///        1. Diamond.rewardMessenger() == address(this). Then the facet allows
///           this contract to deliver messages via {deliverChainReport}
///           (mirror→Base) and {deliverBroadcast} (Base→mirror).
///        2. {sendChainReport} / {broadcastGlobal} are the sender-side
///           interface methods called by the Diamond from within
///           `closeDay` / `broadcastGlobal` on mirror / canonical chains
///           respectively. We record the last payload so tests can assert
///           on it instead of trying to simulate a round-trip across the
///           mesh.
///
///         Renamed from `MockRewardOApp` in #181 to match the
///         transport-neutral `IRewardMessenger` interface name; the
///         transport has been Chainlink CCIP since T-068 (April 2026).
contract MockRewardMessenger is IRewardMessenger {
    address public diamond;

    // ─── Last-call spies for sendChainReport ──────────────────────────────
    uint256 public lastSendDay;
    uint256 public lastSendLenderNumeraire18;
    uint256 public lastSendBorrowerNumeraire18;
    // #1222 M3 B1 — recycled-report spies.
    uint256 public lastSendRecycledCumulative18;
    uint256 public lastSendRecycledForDay18;
    // #1222 M3 B3 — commitment-retirement spies, plus the arity the diamond
    // actually reached (8 = current, 6 = B1 shape) so a test can assert the
    // reporter's generation-fallback shim took the branch it expected.
    uint256 public lastSendCommitRetiredCumulative18;
    uint256 public lastSendCommitReleasedCumulative18;
    uint256 public lastSendArity;
    address public lastSendRefund;
    uint256 public lastSendValue;
    uint256 public sendCount;

    // ─── Last-call spies for broadcastGlobal ──────────────────────────────
    uint256 public lastBroadcastDay;
    uint256 public lastBroadcastLenderNumeraire18;
    uint256 public lastBroadcastBorrowerNumeraire18;
    uint256 public lastBroadcastCapThreshold18;
    // PR-3c composition + arming spies.
    uint256 public lastBroadcastScheduleFloorHalf;
    uint256 public lastBroadcastRecycledHalf;
    uint256 public lastBroadcastArmedFromDay;
    address public lastBroadcastRefund;
    uint256 public lastBroadcastValue;
    uint256 public broadcastCount;

    // ─── #1222 M3 B2-d1 — commitment-report spies ─────────────────────────
    uint256 public lastCommitSendDay;
    uint256 public lastCommitLiabilityLender18;
    uint256 public lastCommitLiabilityBorrower18;
    address public lastCommitRefund;
    uint256 public lastCommitValue;
    uint256 public commitSendCount;
    /// @notice The messageId {sendCommitmentReport} returns (settable so a
    ///         test can assert the facet surfaces it verbatim).
    bytes32 public commitMessageId = bytes32(uint256(0xC0117171));

    // ─── #1222 M3 B2-b — V2 broadcast spies + destination config ──────────
    uint256[] internal destsConfig;
    IRewardMessenger.BroadcastV2Shared public lastV2Shared;
    IRewardMessenger.BroadcastV2PerDest[] public lastV2Dests;
    uint256 public broadcastV2Count;

    // ─── Knobs ─────────────────────────────────────────────────────────────
    uint256 public quoteNative;
    bool public revertOnSend;
    bool public revertOnBroadcast;
    /// @notice B2-b — simulate a pre-B2-b messenger proxy: the V2 send
    ///         reverts EMPTY (missing selector), which must trip the
    ///         facet's legacy-fallback shim.
    bool public v2Unsupported;
    /// @notice #1222 M3 B3 — simulate a pre-B3 messenger proxy: the
    ///         eight-argument send reverts EMPTY (missing selector), which
    ///         must trip the reporter's 8 → 6 generation-fallback shim.
    bool public b3Unsupported;

    constructor(address diamond_) {
        diamond = diamond_;
    }

    function setQuoteNative(uint256 v) external {
        quoteNative = v;
    }

    function setRevertOnSend(bool v) external {
        revertOnSend = v;
    }

    function setRevertOnBroadcast(bool v) external {
        revertOnBroadcast = v;
    }

    function setB3Unsupported(bool v) external {
        b3Unsupported = v;
    }

    function setV2Unsupported(bool v) external {
        v2Unsupported = v;
    }

    function setBroadcastDestinations(uint256[] calldata d) external {
        destsConfig = d;
    }

    function lastV2DestsLength() external view returns (uint256) {
        return lastV2Dests.length;
    }

    // ─── IRewardMessenger — sender-side (called by Diamond) ───────────────

    function sendChainReport(
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        uint256 recycledCumulative18,
        uint256 recycledForDay18,
        address payable refundAddress
    ) external payable override {
        require(msg.sender == diamond, "MockMessenger: only diamond");
        if (revertOnSend) revert("MockMessenger: send revert");
        lastSendDay = dayId;
        lastSendLenderNumeraire18 = lenderNumeraire18;
        lastSendBorrowerNumeraire18 = borrowerNumeraire18;
        lastSendRecycledCumulative18 = recycledCumulative18;
        lastSendRecycledForDay18 = recycledForDay18;
        lastSendCommitRetiredCumulative18 = 0;
        lastSendCommitReleasedCumulative18 = 0;
        lastSendArity = 6;
        lastSendRefund = refundAddress;
        lastSendValue = msg.value;
        sendCount += 1;
    }

    /// @dev #1222 M3 B3 — the CURRENT eight-argument send. `revertOnSendB3`
    ///      makes ONLY this overload revert with empty returndata, which is
    ///      exactly the shape an older messenger produces for an unknown
    ///      selector — the trigger the reporter's generation-fallback shim
    ///      accepts. That is how a test drives the 8 → 6 downgrade without
    ///      deploying a second messenger generation.
    function sendChainReport(
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        uint256 recycledCumulative18,
        uint256 recycledForDay18,
        uint256 commitRetiredCumulative18,
        uint256 commitReleasedCumulative18,
        address payable refundAddress
    ) external payable override {
        require(msg.sender == diamond, "MockMessenger: only diamond");
        if (b3Unsupported) {
            assembly ("memory-safe") {
                revert(0, 0)
            }
        }
        if (revertOnSend) revert("MockMessenger: send revert");
        lastSendDay = dayId;
        lastSendLenderNumeraire18 = lenderNumeraire18;
        lastSendBorrowerNumeraire18 = borrowerNumeraire18;
        lastSendRecycledCumulative18 = recycledCumulative18;
        lastSendRecycledForDay18 = recycledForDay18;
        lastSendCommitRetiredCumulative18 = commitRetiredCumulative18;
        lastSendCommitReleasedCumulative18 = commitReleasedCumulative18;
        lastSendArity = 8;
        lastSendRefund = refundAddress;
        lastSendValue = msg.value;
        sendCount += 1;
    }

    function broadcastGlobal(
        uint256 dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18,
        uint256 capThreshold18,
        uint256 scheduleFloorHalf,
        uint256 recycledHalf,
        uint256 armedFromDay,
        address payable refundAddress
    ) external payable override {
        require(msg.sender == diamond, "MockMessenger: only diamond");
        if (revertOnBroadcast) revert("MockMessenger: broadcast revert");
        lastBroadcastDay = dayId;
        lastBroadcastLenderNumeraire18 = globalLenderNumeraire18;
        lastBroadcastBorrowerNumeraire18 = globalBorrowerNumeraire18;
        lastBroadcastCapThreshold18 = capThreshold18;
        // PR-3c — composition + arming spies.
        lastBroadcastScheduleFloorHalf = scheduleFloorHalf;
        lastBroadcastRecycledHalf = recycledHalf;
        lastBroadcastArmedFromDay = armedFromDay;
        lastBroadcastRefund = refundAddress;
        lastBroadcastValue = msg.value;
        broadcastCount += 1;
    }

    // ─── #1222 M3 B2-d1 — commitment-report surface ───────────────────────

    function setCommitMessageId(bytes32 id) external {
        commitMessageId = id;
    }

    function sendCommitmentReport(
        uint256 dayId,
        uint256 liabilityLender18,
        uint256 liabilityBorrower18,
        address payable refundAddress
    ) external payable override returns (bytes32 messageId) {
        require(msg.sender == diamond, "MockMessenger: only diamond");
        if (revertOnSend) revert("MockMessenger: send revert");
        lastCommitSendDay = dayId;
        lastCommitLiabilityLender18 = liabilityLender18;
        lastCommitLiabilityBorrower18 = liabilityBorrower18;
        lastCommitRefund = refundAddress;
        lastCommitValue = msg.value;
        commitSendCount += 1;
        return commitMessageId;
    }

    function quoteSendCommitmentReport(
        uint256,
        uint256,
        uint256
    ) external view override returns (uint256) {
        return quoteNative;
    }

    /// @notice Simulate a mirror's commitment report landing on the Base
    ///         aggregator ingress (kind-6 CCIP delivery).
    function deliverCommitmentReport(
        uint32 sourceChainId,
        uint256 dayId,
        uint256 liabilityLender18,
        uint256 liabilityBorrower18
    ) external {
        RewardAggregatorFacet(diamond).onCommitmentReportReceived(
            sourceChainId,
            dayId,
            liabilityLender18,
            liabilityBorrower18
        );
    }

    // ─── #1222 M3 B2-d2 — remit-ack surface ───────────────────────────────

    uint256 public lastAckRemitId;
    uint256 public lastAckAmount;
    address public lastAckRefund;
    uint256 public lastAckValue;
    uint256 public ackSendCount;
    /// @notice The messageId {sendRemitAck} returns (settable).
    bytes32 public ackMessageId = bytes32(uint256(0xACC));

    function setAckMessageId(bytes32 id) external {
        ackMessageId = id;
    }

    address public lastAckRemitter;

    function sendRemitAck(
        uint256 remitId,
        uint256 amountReceived,
        address remitter,
        address payable refundAddress
    ) external payable override returns (bytes32 messageId) {
        require(msg.sender == diamond, "MockMessenger: only diamond");
        if (revertOnSend) revert("MockMessenger: send revert");
        lastAckRemitId = remitId;
        lastAckAmount = amountReceived;
        lastAckRemitter = remitter;
        lastAckRefund = refundAddress;
        lastAckValue = msg.value;
        ackSendCount += 1;
        return ackMessageId;
    }

    function quoteSendRemitAck(
        uint256,
        uint256,
        address
    ) external view override returns (uint256) {
        return quoteNative;
    }

    /// @notice Simulate a mirror's remit ack landing on the Base remit
    ///         ingress (kind-7 CCIP delivery). Echoes the DIAMOND as
    ///         `remitter` — the well-formed self-naming ack; use
    ///         {deliverRemitAckFrom} to exercise the r3/r4 identity check.
    function deliverRemitAck(
        uint32 sourceChainId,
        uint256 remitId,
        uint256 amountReceived
    ) external {
        IRewardRemitAckIngress(diamond).onRemitAckReceived(
            sourceChainId, remitId, amountReceived, diamond
        );
    }

    /// @notice r3/r4 — deliver an ack echoing an arbitrary remitter (a
    ///         stale-era receipt's ack after a canonical rotation).
    function deliverRemitAckFrom(
        uint32 sourceChainId,
        uint256 remitId,
        uint256 amountReceived,
        address remitter
    ) external {
        IRewardRemitAckIngress(diamond).onRemitAckReceived(
            sourceChainId, remitId, amountReceived, remitter
        );
    }

    function quoteSendChainReport(
        uint256,
        uint256,
        uint256,
        uint256,
        uint256
    ) external view override returns (uint256) {
        return quoteNative;
    }

    /// @dev #1222 M3 B3 — quote for the eight-word shape. The mock prices
    ///      every shape identically (`quoteNative`); real CCIP prices by
    ///      payload size.
    function quoteSendChainReport(
        uint256,
        uint256,
        uint256,
        uint256,
        uint256,
        uint256,
        uint256
    ) external view override returns (uint256) {
        return quoteNative;
    }

    function quoteBroadcastGlobal(
        uint256,
        uint256,
        uint256
    ) external view override returns (uint256) {
        return quoteNative;
    }

    // ─── #1222 M3 B2-b — V2 broadcast surface ─────────────────────────────

    function broadcastDayV2(
        IRewardMessenger.BroadcastV2Shared calldata shared,
        IRewardMessenger.BroadcastV2PerDest[] calldata dests,
        address payable refundAddress
    ) external payable override {
        require(msg.sender == diamond, "MockMessenger: only diamond");
        if (v2Unsupported) {
            // Missing-selector analog: revert with EMPTY returndata.
            assembly ("memory-safe") {
                revert(0, 0)
            }
        }
        if (revertOnBroadcast) revert("MockMessenger: broadcast revert");
        lastV2Shared = shared;
        delete lastV2Dests;
        for (uint256 i; i < dests.length; ++i) {
            lastV2Dests.push(dests[i]);
        }
        lastBroadcastDay = shared.dayId;
        lastBroadcastRefund = refundAddress;
        lastBroadcastValue = msg.value;
        broadcastV2Count += 1;
    }

    function quoteBroadcastDayV2(
        IRewardMessenger.BroadcastV2Shared calldata,
        IRewardMessenger.BroadcastV2PerDest[] calldata dests
    ) external view override returns (uint256) {
        if (v2Unsupported) {
            // Missing-selector analog for the quote path too.
            assembly ("memory-safe") {
                revert(0, 0)
            }
        }
        // Per-destination pricing (one lane per entry) — deliberately
        // DIFFERENT from the flat legacy quote so a facet-level quote test
        // can discriminate which messenger path priced it.
        return quoteNative * dests.length;
    }

    function getBroadcastDestinations()
        external
        view
        override
        returns (uint256[] memory)
    {
        return destsConfig;
    }

    /// @notice B2-b — simulate a kind-5 delivery landing on the mirror
    ///         reporter ingress.
    function deliverBroadcastV2(RewardBroadcastV2 calldata b) external {
        RewardReporterFacet(diamond).onRewardBroadcastV2Received(b);
    }

    // ─── Receive-side: simulate a CCIP delivery landing on the Diamond ────

    /// @notice Simulate a mirror's report landing on the Base aggregator.
    /// @dev Test prank: the mock calls the Diamond's aggregator as itself
    ///      (`msg.sender == rewardMessenger`), satisfying `onlyRewardMessenger`.
    function deliverChainReport(
        uint32 sourceChainId,
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18
    ) external {
        // Legacy four-word shape: recycled fields absent → delivered as zero
        // (matches the production messenger's legacy-decode path).
        RewardAggregatorFacet(diamond).onChainReportReceived(
            sourceChainId,
            dayId,
            lenderNumeraire18,
            borrowerNumeraire18,
            0,
            0
        );
    }

    /// @notice #1222 M3 B1 — deliver a report carrying the recycled fields
    ///         (exercises Base's per-chain availability + attribution ledger).
    function deliverChainReportRecycled(
        uint32 sourceChainId,
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        uint256 recycledCumulative18,
        uint256 recycledForDay18
    ) external {
        RewardAggregatorFacet(diamond).onChainReportReceived(
            sourceChainId,
            dayId,
            lenderNumeraire18,
            borrowerNumeraire18,
            recycledCumulative18,
            recycledForDay18
        );
    }

    /// @notice #1222 M3 B3 — deliver the CURRENT eight-word report shape:
    ///         the B1 recycled pair plus the reporting chain's
    ///         commitment-retirement cumulatives.
    function deliverChainReportB3(
        uint32 sourceChainId,
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        uint256 recycledCumulative18,
        uint256 recycledForDay18,
        uint256 commitRetiredCumulative18,
        uint256 commitReleasedCumulative18
    ) external {
        RewardAggregatorFacet(diamond).onChainReportReceived(
            sourceChainId,
            dayId,
            lenderNumeraire18,
            borrowerNumeraire18,
            recycledCumulative18,
            recycledForDay18,
            commitRetiredCumulative18,
            commitReleasedCumulative18
        );
    }

    /// @notice Simulate a Base broadcast landing on a mirror reporter.
    ///         Legacy 4-arg shape kept for the pre-PR-3c tests: composition
    ///         halves zero, unarmed.
    function deliverBroadcast(
        uint256 dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18,
        uint256 capThreshold18
    ) external {
        RewardReporterFacet(diamond).onRewardBroadcastReceived(
            dayId,
            globalLenderNumeraire18,
            globalBorrowerNumeraire18,
            capThreshold18,
            0,
            0,
            0
        );
    }

    /// @notice PR-3c — full-shape broadcast delivery (composition + arming).
    function deliverBroadcastWithComposition(
        uint256 dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18,
        uint256 capThreshold18,
        uint256 scheduleFloorHalf,
        uint256 recycledHalf,
        uint256 armedFromDay
    ) external {
        RewardReporterFacet(diamond).onRewardBroadcastReceived(
            dayId,
            globalLenderNumeraire18,
            globalBorrowerNumeraire18,
            capThreshold18,
            scheduleFloorHalf,
            recycledHalf,
            armedFromDay
        );
    }

    receive() external payable {}
}
