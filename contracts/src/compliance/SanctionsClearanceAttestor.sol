// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ISanctionsList} from "../interfaces/ISanctionsList.sol";
import {ICrossChainMessenger, ICrossChainMessageRecipient} from "../crosschain/ICrossChainMessenger.sol";
import {LibOracleFreshness} from "./LibOracleFreshness.sol";

/// @dev The clearance wire version both ends agree on. Two messages share it:
///      - request (timelock → attestor):
///        `abi.encode(uint16 version, uint8 CLEARANCE_REQUEST, uint64 requestId, address[] accounts)`;
///      - response (attestor → timelock):
///        `abi.encode(uint16 version, uint8 CLEARANCE_RESPONSE, uint64 requestId, address[] accounts,
///        bool[] flagged, uint64 oracleUpdatedAt)`, where `oracleUpdatedAt`
///        is the oracle's own last-update time, 0 when it reports none.
uint16 constant SANCTIONS_CLEARANCE_WIRE_VERSION = 1;
uint8 constant CLEARANCE_REQUEST = 1;
uint8 constant CLEARANCE_RESPONSE = 2;

/**
 * @title  SanctionsClearanceAttestor
 * @notice Answers a `SanctionsDelistingTimelock` on another chain with what
 *         RedStone's Sanctions Oracle says, on a chain where it is deployed
 *         (#2443).
 *
 * @dev    RedStone's oracle lives on few chains. A delisting anywhere else
 *         still has to be checked against it, so this contract carries the
 *         check, per address and on demand, rather than mirroring the whole
 *         list (which RedStone does not expose as a set).
 *
 *         **It answers requests; it does not volunteer readings.** The
 *         timelock sends a request over CCIP once a proposal's waiting
 *         window has ended. This contract reads the oracle WHEN THAT REQUEST
 *         ARRIVES — CCIP delivers a message only after the sending chain has
 *         finalized it — so every reading is taken after the request was
 *         made, and so after the window, by causality. Nothing here compares
 *         two chains' clocks or relies on a value someone could predict, and
 *         nobody can obtain a reading for a request the timelock did not
 *         make: inbound messages come only through the messenger, which
 *         authenticates the lane and the channel peer.
 *
 *         Reading and replying are two steps so this contract needs no
 *         balance of its own. On arrival it reads the oracle, records the
 *         hash of the reply it owes, and emits the reply in full. Anyone may
 *         then {sendReply} with that exact reply and pay its fee; a caller
 *         can choose when it is sent, never what it says. An oracle read
 *         that reverts reverts the arrival (CCIP records a failed message,
 *         manually re-executable), so an unreadable oracle never produces a
 *         "not flagged".
 *
 *         Each reply also carries the oracle's own
 *         `getLastUpdateBlockTimestamp()` (read through {LibOracleFreshness};
 *         0 when unknown), so a frozen oracle that still answers
 *         "not flagged" cannot clear a delisting.
 *
 *         No owner and no configuration beyond the oracle and messenger
 *         fixed at deploy. Needs this contract registered as the clearance
 *         channel's handler on this chain's messenger, with the timelock as
 *         that channel's peer for its chain; the mirror image on the
 *         timelock's chain.
 */
contract SanctionsClearanceAttestor is ICrossChainMessageRecipient {
    /// @notice The most addresses one request may carry.
    uint256 public constant MAX_ACCOUNTS = 100;

    /// @notice Destination gas for a reply: a base allowance plus a
    ///         per-address share (decoding, hashing the batch against the
    ///         proposal).
    uint256 public constant REPLY_GAS_BASE = 120_000;
    uint256 public constant REPLY_GAS_PER_ACCOUNT = 10_000;

    /// @notice RedStone's Sanctions Oracle on this chain.
    ISanctionsList public immutable oracle;

    /// @notice This chain's `ICrossChainMessenger`.
    ICrossChainMessenger public immutable messenger;

    /// @notice A reply owed for one request, keyed by the request's inbound
    ///         message id.
    /// @param destinationChainId The chain the request came from.
    /// @param payloadHash        `keccak256` of the reply payload.
    /// @param accounts           How many addresses it covers (sizes the gas).
    /// @param sent               Already sent.
    struct Reply {
        uint256 destinationChainId;
        bytes32 payloadHash;
        uint32 accounts;
        bool sent;
    }

    /// @notice Replies owed or sent, by request message id.
    mapping(bytes32 requestMessageId => Reply) public replyOf;

    /// @notice The oracle was read for a request. `payload` is the reply to
    ///         pass to {sendReply}.
    /// @custom:event-category informational/compliance
    event ClearanceRead(
        bytes32 indexed requestMessageId,
        uint256 indexed destinationChainId,
        uint64 indexed requestId,
        address[] accounts,
        bool[] flagged,
        uint64 oracleUpdatedAt,
        bytes payload
    );
    /// @custom:event-category informational/compliance
    event ClearanceReplySent(bytes32 indexed requestMessageId, bytes32 indexed replyMessageId, address indexed caller);

    error ZeroAddress();
    error NotAContract(address candidate);
    error NotMessenger(address caller);
    error UnexpectedTokens();
    error UnsupportedClearanceVersion(uint16 got);
    error UnexpectedKind(uint8 got);
    error EmptyBatch();
    error BatchTooLarge(uint256 size, uint256 max);
    error AlreadyRead(bytes32 requestMessageId);
    error NoReplyOwed(bytes32 requestMessageId);
    error ReplyAlreadySent(bytes32 requestMessageId);
    error ReplyMismatch(bytes32 requestMessageId);
    error UnexpectedNative(address from);
    error RefundFailed();

    constructor(ISanctionsList oracle_, ICrossChainMessenger messenger_) {
        if (address(oracle_) == address(0) || address(messenger_) == address(0)) revert ZeroAddress();
        if (address(oracle_).code.length == 0) revert NotAContract(address(oracle_));
        if (address(messenger_).code.length == 0) revert NotAContract(address(messenger_));
        oracle = oracle_;
        messenger = messenger_;
    }

    /// @inheritdoc ICrossChainMessageRecipient
    /// @dev    A request from the timelock: read the oracle now and record
    ///         the reply owed. The messenger has authenticated the lane and
    ///         the channel peer.
    function onCrossChainMessage(
        uint256 sourceChainId,
        address,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens,
        bytes32 messageId
    ) external {
        if (msg.sender != address(messenger)) revert NotMessenger(msg.sender);
        if (tokens.length != 0) revert UnexpectedTokens();
        (uint16 version, uint8 kind, uint64 requestId, address[] memory accounts) =
            abi.decode(payload, (uint16, uint8, uint64, address[]));
        if (version != SANCTIONS_CLEARANCE_WIRE_VERSION) revert UnsupportedClearanceVersion(version);
        if (kind != CLEARANCE_REQUEST) revert UnexpectedKind(kind);
        uint256 n = accounts.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_ACCOUNTS) revert BatchTooLarge(n, MAX_ACCOUNTS);
        if (replyOf[messageId].payloadHash != bytes32(0)) revert AlreadyRead(messageId);

        bool[] memory flagged = new bool[](n);
        for (uint256 i; i < n; ++i) {
            if (accounts[i] == address(0)) revert ZeroAddress();
            flagged[i] = oracle.isSanctioned(accounts[i]);
        }
        // Known values are at most this block's timestamp, so they fit.
        (, uint256 updatedAt) = LibOracleFreshness.lastUpdate(address(oracle));
        uint64 oracleUpdatedAt = uint64(updatedAt);
        bytes memory reply = abi.encode(
            SANCTIONS_CLEARANCE_WIRE_VERSION, CLEARANCE_RESPONSE, requestId, accounts, flagged, oracleUpdatedAt
        );
        replyOf[messageId] = Reply({
            destinationChainId: sourceChainId, payloadHash: keccak256(reply), accounts: uint32(n), sent: false
        });
        emit ClearanceRead(messageId, sourceChainId, requestId, accounts, flagged, oracleUpdatedAt, reply);
    }

    /// @notice Send the reply owed for a request. Anyone may call it; pay
    ///         the fee as `msg.value` (quote it with {quoteReply}); any
    ///         overpayment is returned.
    /// @param requestMessageId The request's inbound message id.
    /// @param payload          The reply exactly as {ClearanceRead} emitted.
    /// @return replyMessageId The transport's id for the reply.
    function sendReply(bytes32 requestMessageId, bytes calldata payload)
        external
        payable
        returns (bytes32 replyMessageId)
    {
        Reply storage r = _owed(requestMessageId, payload);
        r.sent = true;
        replyMessageId = messenger.sendMessage{value: msg.value}(
            r.destinationChainId, payload, new ICrossChainMessenger.TokenAmount[](0), _replyGas(r.accounts)
        );
        emit ClearanceReplySent(requestMessageId, replyMessageId, msg.sender);
        // The messenger refunds overpayment here; pass it on. This contract
        // holds nothing between calls, so its whole balance is the refund.
        uint256 refund = address(this).balance;
        if (refund != 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @notice The fee {sendReply} would need for the same arguments now.
    function quoteReply(bytes32 requestMessageId, bytes calldata payload) external view returns (uint256) {
        Reply storage r = _owed(requestMessageId, payload);
        return messenger.quoteMessageFee(
            r.destinationChainId, payload, new ICrossChainMessenger.TokenAmount[](0), _replyGas(r.accounts)
        );
    }

    /// @dev Only the messenger's fee refund is accepted.
    receive() external payable {
        if (msg.sender != address(messenger)) revert UnexpectedNative(msg.sender);
    }

    function _owed(bytes32 requestMessageId, bytes calldata payload) private view returns (Reply storage r) {
        r = replyOf[requestMessageId];
        if (r.payloadHash == bytes32(0)) revert NoReplyOwed(requestMessageId);
        if (r.sent) revert ReplyAlreadySent(requestMessageId);
        if (keccak256(payload) != r.payloadHash) revert ReplyMismatch(requestMessageId);
    }

    function _replyGas(uint256 n) private pure returns (uint256) {
        return REPLY_GAS_BASE + REPLY_GAS_PER_ACCOUNT * n;
    }
}
