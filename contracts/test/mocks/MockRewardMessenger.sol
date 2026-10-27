// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {
    IRewardMessenger,
    IRewardRemitAckIngress,
    RewardBroadcastV2,
    RewardBroadcastV3,
    ChainDayReport
} from "../../src/interfaces/IRewardMessenger.sol";
import {RewardAggregatorFacet} from "../../src/facets/RewardAggregatorFacet.sol";
import {RewardReporterFacet} from "../../src/facets/RewardReporterFacet.sol";
import {InteractionRewardsLensFacet} from "../../src/facets/InteractionRewardsLensFacet.sol";
import {RepatriationFacet} from "../../src/facets/RepatriationFacet.sol";
import {RewardCommitmentFacet} from "../../src/facets/RewardCommitmentFacet.sol";

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
///        2. {sendChainReport} / {broadcastDayV3} are the sender-side
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
    // #1222 M3 B3 — commitment-retirement spies.
    uint256 public lastSendCommitRetiredCumulative18;
    uint256 public lastSendCommitReleasedCumulative18;
    // #1566 PR C — custody era; #2620 — the reporter's reward clock; #2621 —
    // the destination the diamond named.
    uint64 public lastSendCustodyEra;
    uint256 public lastSendRewardLaunch;
    uint256 public lastSendDest;
    address public lastSendRefund;
    uint256 public lastSendValue;
    uint256 public sendCount;

    // ─── Last-call spies shared by the V3 broadcast sends ────────────────
    uint256 public lastBroadcastDay;
    address public lastBroadcastRefund;
    uint256 public lastBroadcastValue;

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

    // ─── Broadcast destination config ─────────────────────────────────────
    uint256[] internal destsConfig;

    // ─── #1434 P2-w1 — V3 broadcast spies ─────────────────────────────────
    IRewardMessenger.BroadcastV2Shared public lastV3Shared;
    IRewardMessenger.BroadcastV3Extras public lastV3Extras;
    IRewardMessenger.BroadcastV3PerDest[] public lastV3Dests;
    uint256 public broadcastV3Count;
    IRewardMessenger.BroadcastV2Shared public lastV3SingleShared;
    IRewardMessenger.BroadcastV3Extras public lastV3SingleExtras;
    IRewardMessenger.BroadcastV3PerDest public lastV3SingleDest;
    uint256 public broadcastV3SingleCount;
    uint256 public lastV3SingleValue;

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

    function lastV3DestsLength() external view returns (uint256) {
        return lastV3Dests.length;
    }

    function lastV3DestAt(uint256 i)
        external
        view
        returns (IRewardMessenger.BroadcastV3PerDest memory)
    {
        return lastV3Dests[i];
    }

    function setBroadcastDestinations(uint256[] calldata d) external {
        destsConfig = d;
    }

    // ─── IRewardMessenger — sender-side (called by Diamond) ───────────────

    /// @dev The one report send (#2621). `revertOnSend` makes it revert with
    ///      a reason, as a paused or underpaid messenger does.
    function sendChainReport(
        uint256 destChainId,
        ChainDayReport calldata r,
        address payable refundAddress
    ) external payable override {
        require(msg.sender == diamond, "MockMessenger: only diamond");
        if (revertOnSend) revert("MockMessenger: send revert");
        lastSendDest = destChainId;
        lastSendDay = r.dayId;
        lastSendLenderNumeraire18 = r.lenderNumeraire18;
        lastSendBorrowerNumeraire18 = r.borrowerNumeraire18;
        lastSendRecycledCumulative18 = r.recycledCumulative18;
        lastSendRecycledForDay18 = r.recycledForDay18;
        lastSendCommitRetiredCumulative18 = r.commitRetiredCumulative18;
        lastSendCommitReleasedCumulative18 = r.commitReleasedCumulative18;
        lastSendCustodyEra = r.custodyEra;
        lastSendRewardLaunch = r.rewardLaunchTimestamp;
        lastSendRefund = refundAddress;
        lastSendValue = msg.value;
        sendCount += 1;
    }

    function quoteSendChainReport(uint256, ChainDayReport calldata)
        external
        view
        override
        returns (uint256)
    {
        return quoteNative;
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
    uint8 public lastAckClassification;
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
        uint8 classification,
        address payable refundAddress
    ) external payable override returns (bytes32 messageId) {
        lastAckClassification = classification;
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
            sourceChainId, remitId, amountReceived, diamond, 1
        );
    }

    /// @dev #1656 r8 / #1660 r5 - the bool maps onto the honest
    ///      classifications: consumed=true -> 0 (credited), false -> 1
    ///      (QUARANTINED - what every non-consumed fixture models).
    function deliverRemitAckWithConsumed(
        uint32 sourceChainId,
        uint256 remitId,
        uint256 amountReceived,
        bool consumed
    ) external {
        IRewardRemitAckIngress(diamond).onRemitAckReceived(
            sourceChainId, remitId, amountReceived, diamond,
            consumed ? 1 : 2
        );
    }

    /// @dev #1660 r5/r6 - raw WIRE-classification delivery (1 consumed /
    ///      2 quarantined / 3 provisional; 0 is unassigned).
    function deliverRemitAckWithClassification(
        uint32 sourceChainId,
        uint256 remitId,
        uint256 amountReceived,
        uint8 classification
    ) external {
        IRewardRemitAckIngress(diamond).onRemitAckReceived(
            sourceChainId, remitId, amountReceived, diamond, classification
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
            sourceChainId, remitId, amountReceived, remitter, 1
        );
    }

    /// @dev #1434 P2-w6 (R6e) - arbitrary-remitter delivery with an
    ///      explicit wire classification (imported-marker branch tests).
    function deliverRemitAckFromWithClassification(
        uint32 sourceChainId,
        uint256 remitId,
        uint256 amountReceived,
        address remitter,
        uint8 classification
    ) external {
        IRewardRemitAckIngress(diamond).onRemitAckReceived(
            sourceChainId, remitId, amountReceived, remitter, classification
        );
    }

    function getBroadcastDestinations()
        external
        view
        override
        returns (uint256[] memory)
    {
        return destsConfig;
    }

    /// @notice Deliver Base's per-destination figures `b` to the mirror as
    ///         the one broadcast wire (kind 10). #1944 retired the kind-5
    ///         ingress this used to call; the packet now travels inside a
    ///         V3 envelope built by {_v3Envelope}.
    function deliverBroadcastV2(RewardBroadcastV2 calldata b) external {
        RewardReporterFacet(diamond).onRewardBroadcastV3Received(
            _v3Envelope(b, b.freshLenderHalf, 0)
        );
    }

    // ─── #1434 P2-w1 — V3 broadcast surface ───────────────────────────────

    function broadcastDayV3(
        IRewardMessenger.BroadcastV2Shared calldata shared,
        IRewardMessenger.BroadcastV3Extras calldata extras,
        IRewardMessenger.BroadcastV3PerDest[] calldata dests,
        address payable refundAddress
    ) external payable override {
        require(msg.sender == diamond, "MockMessenger: only diamond");
        if (revertOnBroadcast) revert("MockMessenger: broadcast revert");
        lastV3Shared = shared;
        lastV3Extras = extras;
        delete lastV3Dests;
        for (uint256 i; i < dests.length; ++i) {
            lastV3Dests.push(dests[i]);
        }
        lastBroadcastDay = shared.dayId;
        lastBroadcastRefund = refundAddress;
        lastBroadcastValue = msg.value;
        broadcastV3Count += 1;
    }

    function quoteBroadcastDayV3(
        IRewardMessenger.BroadcastV2Shared calldata,
        IRewardMessenger.BroadcastV3Extras calldata,
        IRewardMessenger.BroadcastV3PerDest[] calldata dests
    ) external view override returns (uint256) {
        // Per-destination pricing, deliberately DIFFERENT from the flat
        // single-lane quote so a facet-level quote test can tell which
        // surface priced it.
        return quoteNative * dests.length * 3;
    }

    function broadcastDayV3Single(
        IRewardMessenger.BroadcastV2Shared calldata shared,
        IRewardMessenger.BroadcastV3Extras calldata extras,
        IRewardMessenger.BroadcastV3PerDest calldata dest,
        address payable refundAddress
    ) external payable override returns (bytes32) {
        require(msg.sender == diamond, "MockMessenger: only diamond");
        if (revertOnBroadcast) revert("MockMessenger: broadcast revert");
        lastV3SingleShared = shared;
        lastV3SingleExtras = extras;
        lastV3SingleDest = dest;
        lastBroadcastRefund = refundAddress;
        lastV3SingleValue = msg.value;
        broadcastV3SingleCount += 1;
        return bytes32(uint256(0xB3515));
    }

    function quoteBroadcastDayV3Single(
        IRewardMessenger.BroadcastV2Shared calldata,
        IRewardMessenger.BroadcastV3Extras calldata,
        IRewardMessenger.BroadcastV3PerDest calldata
    ) external view override returns (uint256) {
        return quoteNative * 3;
    }

    /// @notice #1434 P2-w1 — simulate a kind-10 delivery landing on the
    ///         mirror reporter ingress.
    function deliverBroadcastV3(RewardBroadcastV3 calldata b) external {
        RewardReporterFacet(diamond).onRewardBroadcastV3Received(b);
    }

    // ─── #1434 P2-w3 — compensation-quote surface ─────────────────────────

    uint256 public lastCompQuoteDay;
    uint256 public lastCompQuoteLender18;
    uint256 public lastCompQuoteBorrower18;
    uint256 public compQuoteSendCount;

    function sendCompQuote(
        uint256 dayId,
        uint256 quotedLender18,
        uint256 quotedBorrower18,
        address payable
    ) external payable override returns (bytes32) {
        require(msg.sender == diamond, "MockMessenger: only diamond");
        if (revertOnSend) revert("MockMessenger: send revert");
        lastCompQuoteDay = dayId;
        lastCompQuoteLender18 = quotedLender18;
        lastCompQuoteBorrower18 = quotedBorrower18;
        compQuoteSendCount += 1;
        return bytes32(uint256(0xC0117E));
    }

    function quoteSendCompQuote(
        uint256,
        uint256,
        uint256
    ) external view override returns (uint256) {
        return quoteNative;
    }

    /// @notice #1434 P2-w3 — simulate a kind-11 delivery landing on the
    ///         canonical commitment-facet ingress.
    function deliverCompQuote(
        uint32 srcChainId,
        uint256 dayId,
        uint256 quotedLender18,
        uint256 quotedBorrower18
    ) external {
        // Default era = this mock (the "sending diamond" a real messenger
        // would stamp); era-divergence tests use the explicit overload.
        RewardCommitmentFacet(diamond).onCompQuoteReceived(
            srcChainId, dayId, quotedLender18, quotedBorrower18, address(this)
        );
    }

    /// @dev #1636 r1 — era-explicit delivery for the binding tests.
    function deliverCompQuoteFromEra(
        uint32 srcChainId,
        uint256 dayId,
        uint256 quotedLender18,
        uint256 quotedBorrower18,
        address era
    ) external {
        RewardCommitmentFacet(diamond).onCompQuoteReceived(
            srcChainId, dayId, quotedLender18, quotedBorrower18, era
        );
    }

    // ─── #1568 C2 — repatriation instruction surfaces ─────────────────────

    uint256 public lastRepatDst;
    uint256 public lastRepatAuthId;
    uint256 public lastRepatAmount;
    address public lastRepatRefund;
    uint256 public lastRepatValue;
    uint256 public repatSendCount;
    uint256 public lastRepatCancelDst;
    uint256 public lastRepatCancelAuthId;
    address public lastRepatCancelRefund;
    uint256 public lastRepatCancelValue;
    uint256 public repatCancelSendCount;
    /// @notice The messageId the repat sends return (settable).
    bytes32 public repatMessageId = bytes32(uint256(0x11E8A7));

    function setRepatMessageId(bytes32 id) external {
        repatMessageId = id;
    }

    function sendRepatriationInstruction(
        uint256 dstChainId,
        uint256 authId,
        uint256 amount,
        address payable refundAddress
    ) external payable returns (bytes32 messageId) {
        require(msg.sender == diamond, "MockMessenger: only diamond");
        if (revertOnSend) revert("MockMessenger: send revert");
        lastRepatDst = dstChainId;
        lastRepatAuthId = authId;
        lastRepatAmount = amount;
        lastRepatRefund = refundAddress;
        lastRepatValue = msg.value;
        repatSendCount += 1;
        return repatMessageId;
    }

    function quoteSendRepatriationInstruction(
        uint256,
        uint256,
        uint256
    ) external view returns (uint256) {
        return quoteNative;
    }

    function sendRepatriationCancel(
        uint256 dstChainId,
        uint256 authId,
        address payable refundAddress
    ) external payable returns (bytes32 messageId) {
        require(msg.sender == diamond, "MockMessenger: only diamond");
        if (revertOnSend) revert("MockMessenger: send revert");
        lastRepatCancelDst = dstChainId;
        lastRepatCancelAuthId = authId;
        lastRepatCancelRefund = refundAddress;
        lastRepatCancelValue = msg.value;
        repatCancelSendCount += 1;
        return repatMessageId;
    }

    function quoteSendRepatriationCancel(
        uint256,
        uint256
    ) external view returns (uint256) {
        return quoteNative;
    }

    /// @notice Simulate a Base repatriation instruction landing on the
    ///         mirror ingress (kind-8 CCIP delivery).
    function deliverRepatriationInstruction(
        address issuingBase,
        uint256 authId,
        uint256 amount
    ) external {
        RepatriationFacet(diamond).onRepatriationInstructionReceived(
            issuingBase, authId, amount
        );
    }

    /// @notice Simulate a Base repatriation CANCEL instruction landing on
    ///         the mirror ingress (kind-9 CCIP delivery).
    function deliverRepatriationCancel(
        address issuingBase,
        uint256 authId
    ) external {
        RepatriationFacet(diamond).onRepatriationCancelInstructionReceived(
            issuingBase, authId
        );
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
        _deliver(sourceChainId, dayId, lenderNumeraire18, borrowerNumeraire18, 0, 0, 0, 0, 0);
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
        _deliver(
            sourceChainId, dayId, lenderNumeraire18, borrowerNumeraire18,
            recycledCumulative18, recycledForDay18, 0, 0, 0
        );
    }

    /// @notice #1222 M3 B3 — deliver a report with the recycled pair plus the
    ///         reporting chain's commitment-retirement cumulatives.
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
        _deliver(
            sourceChainId, dayId, lenderNumeraire18, borrowerNumeraire18,
            recycledCumulative18, recycledForDay18,
            commitRetiredCumulative18, commitReleasedCumulative18, 0
        );
    }

    /// @notice #1566 PR C revision — deliver a report carrying the reporting
    ///         chain's live custody era.
    function deliverChainReportB4(
        uint32 sourceChainId,
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        uint64 custodyEra
    ) external {
        _deliver(sourceChainId, dayId, lenderNumeraire18, borrowerNumeraire18, 0, 0, 0, 0, custodyEra);
    }

    /// @notice #2459 r6 — a day report carrying the chain's cumulatives too.
    function deliverChainReportB4Full(
        uint32 sourceChainId,
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        uint256 recycledCumulative18,
        uint256 recycledForDay18,
        uint256 commitRetiredCumulative18,
        uint256 commitReleasedCumulative18,
        uint64 custodyEra
    ) external {
        _deliver(
            sourceChainId, dayId, lenderNumeraire18, borrowerNumeraire18,
            recycledCumulative18, recycledForDay18,
            commitRetiredCumulative18, commitReleasedCumulative18, custodyEra
        );
    }

    /// @notice #2620 — deliver an exact {ChainDayReport}, its reward clock
    ///         included, so a test can send one on a clock other than Base's.
    function deliverChainDayReport(uint32 sourceChainId, ChainDayReport calldata r) external {
        RewardAggregatorFacet(diamond).onChainReportReceived(sourceChainId, r);
    }

    /// @dev Every convenience wrapper above reports on Base's own reward
    ///      clock — the configuration a correct deployment has.
    function _deliver(
        uint32 sourceChainId,
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        uint256 recycledCumulative18,
        uint256 recycledForDay18,
        uint256 commitRetiredCumulative18,
        uint256 commitReleasedCumulative18,
        uint64 custodyEra
    ) internal {
        RewardAggregatorFacet(diamond).onChainReportReceived(
            sourceChainId,
            ChainDayReport({
                dayId: dayId,
                lenderNumeraire18: lenderNumeraire18,
                borrowerNumeraire18: borrowerNumeraire18,
                recycledCumulative18: recycledCumulative18,
                recycledForDay18: recycledForDay18,
                commitRetiredCumulative18: commitRetiredCumulative18,
                commitReleasedCumulative18: commitReleasedCumulative18,
                custodyEra: custodyEra,
                rewardLaunchTimestamp: InteractionRewardsLensFacet(diamond).getInteractionLaunchTimestamp()
            })
        );
    }

    // ─── Broadcast delivery shorthands (#1944: all ride kind 10) ──────────

    /// @dev The clock every shorthand stamps. Fixed so a re-delivery of the
    ///      same day replays rather than diverges. Lapse schedule version 0
    ///      means "not lapse-eligible", which keeps these shorthands out of
    ///      the P2 lapse machinery a test did not ask for.
    uint64 public constant SHORTHAND_FINALIZED_AT = 1;

    /// @notice Simulate a Base broadcast landing on a mirror reporter:
    ///         the consensus pair and the §4 cap threshold, unarmed, funded
    ///         at the day's schedule floor (what Base ships an included
    ///         destination below the 69M cap).
    function deliverBroadcast(
        uint256 dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18,
        uint256 capThreshold18
    ) external {
        _deliverShorthand(
            dayId, globalLenderNumeraire18, globalBorrowerNumeraire18,
            capThreshold18, 0, 0, 0
        );
    }

    /// @notice The full frozen tuple: composition halves and the arming
    ///         day too. A zero `scheduleFloorHalf` means "the day's
    ///         schedule half", as in {deliverBroadcast}.
    function deliverBroadcastFull(
        uint256 dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18,
        uint256 capThreshold18,
        uint256 scheduleFloorHalf,
        uint256 recycledHalf,
        uint256 armedFromDay
    ) external {
        _deliverShorthand(
            dayId, globalLenderNumeraire18, globalBorrowerNumeraire18,
            capThreshold18, scheduleFloorHalf, recycledHalf, armedFromDay
        );
    }

    /// @notice Alias of {deliverBroadcastFull}, kept for the PR-3c suites.
    function deliverBroadcastWithComposition(
        uint256 dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18,
        uint256 capThreshold18,
        uint256 scheduleFloorHalf,
        uint256 recycledHalf,
        uint256 armedFromDay
    ) external {
        _deliverShorthand(
            dayId, globalLenderNumeraire18, globalBorrowerNumeraire18,
            capThreshold18, scheduleFloorHalf, recycledHalf, armedFromDay
        );
    }

    /// @dev Builds the per-destination packet Base's `_perDestFields` ships
    ///      an included, unstamped destination: the floor half on both
    ///      sides, nothing recycled, nothing consumed or earmarked.
    function _deliverShorthand(
        uint256 dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18,
        uint256 capThreshold18,
        uint256 scheduleFloorHalf,
        uint256 recycledHalf,
        uint256 armedFromDay
    ) internal {
        uint256 floorHalf = scheduleFloorHalf != 0
            ? scheduleFloorHalf
            : InteractionRewardsLensFacet(diamond).getInteractionHalfPoolForDay(dayId);
        RewardBroadcastV2 memory v2 = RewardBroadcastV2({
            dayId: dayId,
            globalLenderNumeraire18: globalLenderNumeraire18,
            globalBorrowerNumeraire18: globalBorrowerNumeraire18,
            capMode: 0, // CapMode.LegacyEthRatio
            capPayloadLender: capThreshold18,
            capPayloadBorrower: 0,
            armedFromDay: armedFromDay,
            freshLenderHalf: floorHalf,
            freshBorrowerHalf: floorHalf,
            recycledLenderHalfEquiv: 0,
            recycledBorrowerHalfEquiv: 0,
            recycleConsume: 0,
            keeperAllocate: 0,
            destChainId: block.chainid
        });
        RewardReporterFacet(diamond).onRewardBroadcastV3Received(
            _v3Envelope(v2, floorHalf, recycledHalf)
        );
    }

    /// @dev Wraps `v2` in the V3 envelope a correctly bound Base messenger
    ///      sends: the mirror's own configured era (a test that has not set
    ///      one gets `BroadcastEraUnauthenticated`, as production would),
    ///      the fixed shorthand clock and the day-level pool halves.
    function _v3Envelope(
        RewardBroadcastV2 memory v2,
        uint256 dayScheduleFloorHalf,
        uint256 dayRecycledBudgetHalf
    ) internal view returns (RewardBroadcastV3 memory) {
        return RewardBroadcastV3({
            v2: v2,
            finalizedAt: SHORTHAND_FINALIZED_AT,
            lapseScheduleVersion: 0,
            lapseWindowSeconds: 0,
            dispatchCutoffGap: 0,
            zeroedForDest: false,
            baseDeployment: RewardReporterFacet(diamond).getBaseRewardDeployment(),
            dayScheduleFloorHalf: dayScheduleFloorHalf,
            dayRecycledBudgetHalf: dayRecycledBudgetHalf
        });
    }

    receive() external payable {}
}
