// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IRewardMessenger} from "../../src/interfaces/IRewardMessenger.sol";
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
    address public lastSendRefund;
    uint256 public lastSendValue;
    uint256 public sendCount;

    // ─── Last-call spies for broadcastGlobal ──────────────────────────────
    uint256 public lastBroadcastDay;
    uint256 public lastBroadcastLenderNumeraire18;
    uint256 public lastBroadcastBorrowerNumeraire18;
    uint256 public lastBroadcastCapThreshold18;
    address public lastBroadcastRefund;
    uint256 public lastBroadcastValue;
    uint256 public broadcastCount;

    // ─── Knobs ─────────────────────────────────────────────────────────────
    uint256 public quoteNative;
    bool public revertOnSend;
    bool public revertOnBroadcast;

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

    // ─── IRewardMessenger — sender-side (called by Diamond) ───────────────

    function sendChainReport(
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        address payable refundAddress
    ) external payable override {
        require(msg.sender == diamond, "MockMessenger: only diamond");
        if (revertOnSend) revert("MockMessenger: send revert");
        lastSendDay = dayId;
        lastSendLenderNumeraire18 = lenderNumeraire18;
        lastSendBorrowerNumeraire18 = borrowerNumeraire18;
        lastSendRefund = refundAddress;
        lastSendValue = msg.value;
        sendCount += 1;
    }

    function broadcastGlobal(
        uint256 dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18,
        uint256 capThreshold18,
        address payable refundAddress
    ) external payable override {
        require(msg.sender == diamond, "MockMessenger: only diamond");
        if (revertOnBroadcast) revert("MockMessenger: broadcast revert");
        lastBroadcastDay = dayId;
        lastBroadcastLenderNumeraire18 = globalLenderNumeraire18;
        lastBroadcastBorrowerNumeraire18 = globalBorrowerNumeraire18;
        lastBroadcastCapThreshold18 = capThreshold18;
        lastBroadcastRefund = refundAddress;
        lastBroadcastValue = msg.value;
        broadcastCount += 1;
    }

    function quoteSendChainReport(
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
        RewardAggregatorFacet(diamond).onChainReportReceived(
            sourceChainId,
            dayId,
            lenderNumeraire18,
            borrowerNumeraire18
        );
    }

    /// @notice Simulate a Base broadcast landing on a mirror reporter.
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
            capThreshold18
        );
    }

    receive() external payable {}
}
