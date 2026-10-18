// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ISanctionsList} from "../interfaces/ISanctionsList.sol";
import {ICrossChainMessenger, ICrossChainMessageRecipient} from "../crosschain/ICrossChainMessenger.sol";
import {LibOracleFreshness} from "./LibOracleFreshness.sol";

/// @dev The clearance wire format both ends agree on:
///      `abi.encode(uint16 version, bytes32 challenge, address[] accounts,
///      bool[] flagged, uint64 oracleUpdatedAt)`. `challenge` is the one the
///      destination timelock issued for the proposal; `oracleUpdatedAt` is
///      the oracle's own last-update time, 0 when it reports none.
uint16 constant SANCTIONS_CLEARANCE_WIRE_VERSION = 1;

/**
 * @title  SanctionsClearanceAttestor
 * @notice Reads RedStone's Sanctions Oracle for a few addresses on a chain
 *         where it is deployed, and sends the answers over CCIP to a
 *         `SanctionsDelistingTimelock` on another chain (#2443).
 *
 * @dev    RedStone's oracle lives on few chains. A delisting anywhere else
 *         still has to be checked against it, so this contract carries the
 *         check, per address and on demand, rather than mirroring the whole
 *         list (which RedStone does not expose as a set).
 *
 *         It reports what the oracle says and nothing else: no owner, no
 *         configuration beyond the oracle and messenger fixed at deploy,
 *         and anyone may call {attest} and pay its fee. A caller can choose
 *         WHICH addresses are read and which challenge is echoed, never
 *         what the answer is. An oracle read that reverts reverts the
 *         attestation, so an unreadable oracle never produces a
 *         "not flagged".
 *
 *         Two things make an answer usable at the destination, and neither
 *         relies on comparing this chain's clock with the destination's:
 *         - **The challenge.** The timelock seals it from the hash of a
 *           block that ran after the proposal's waiting window ended, so
 *           nobody can know it earlier. An answer echoing it was therefore
 *           read after the window, whatever either chain's clock says. The timelock ignores an answer for an unknown or
 *           superseded challenge, or for other addresses.
 *         - **The oracle's own freshness.** The message carries the
 *           oracle's `getLastUpdateBlockTimestamp()` (read through
 *           {LibOracleFreshness}; 0 when unknown), so a frozen oracle that
 *           still answers "not flagged" cannot clear a delisting.
 *
 *         Each destination needs this contract registered as the handler of
 *         the clearance channel on this chain's messenger, with the
 *         destination timelock as that channel's peer; the timelock is the
 *         handler on its own chain, with this contract as its peer.
 */
contract SanctionsClearanceAttestor is ICrossChainMessageRecipient {
    /// @notice The most addresses one attestation may carry.
    uint256 public constant MAX_ACCOUNTS = 100;

    /// @notice Destination gas: a base allowance plus a per-address share
    ///         (decoding, hashing the batch against the proposal).
    uint256 public constant DEST_GAS_BASE = 120_000;
    uint256 public constant DEST_GAS_PER_ACCOUNT = 10_000;

    /// @notice RedStone's Sanctions Oracle on this chain.
    ISanctionsList public immutable oracle;

    /// @notice This chain's `ICrossChainMessenger`.
    ICrossChainMessenger public immutable messenger;

    /// @custom:event-category informational/compliance
    event ClearanceAttested(
        uint256 indexed destinationChainId,
        bytes32 indexed messageId,
        address indexed caller,
        bytes32 challenge,
        address[] accounts,
        bool[] flagged,
        uint64 oracleUpdatedAt
    );

    error ZeroAddress();
    error NotAContract(address candidate);
    error EmptyBatch();
    error ZeroChallenge();
    error BatchTooLarge(uint256 size, uint256 max);
    error NotAReceiver();
    error UnexpectedNative(address from);
    error RefundFailed();

    constructor(ISanctionsList oracle_, ICrossChainMessenger messenger_) {
        if (address(oracle_) == address(0) || address(messenger_) == address(0)) revert ZeroAddress();
        if (address(oracle_).code.length == 0) revert NotAContract(address(oracle_));
        if (address(messenger_).code.length == 0) revert NotAContract(address(messenger_));
        oracle = oracle_;
        messenger = messenger_;
    }

    /// @notice Read the oracle for `accounts` and send the answers, with
    ///         the oracle's own freshness, to the timelock on
    ///         `destinationChainId`. Pay the fee as `msg.value` (quote it with
    ///         {quote}); any overpayment is returned.
    /// @param challenge The challenge the destination timelock issued for
    ///                  the proposal naming `accounts` (`requestClearance`).
    /// @param accounts  That proposal's addresses, in its order.
    /// @return messageId The transport's id for the message.
    function attest(uint256 destinationChainId, bytes32 challenge, address[] calldata accounts)
        external
        payable
        returns (bytes32 messageId)
    {
        (bytes memory payload, bool[] memory flagged, uint64 oracleUpdatedAt) = _payload(challenge, accounts);
        messageId = messenger.sendMessage{value: msg.value}(
            destinationChainId, payload, new ICrossChainMessenger.TokenAmount[](0), _destGas(accounts.length)
        );
        emit ClearanceAttested(
            destinationChainId, messageId, msg.sender, challenge, accounts, flagged, oracleUpdatedAt
        );
        // The messenger refunds overpayment here; pass it on. This contract
        // holds nothing between calls, so its whole balance is the refund.
        uint256 refund = address(this).balance;
        if (refund != 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @notice The fee {attest} would need for the same arguments now.
    function quote(uint256 destinationChainId, bytes32 challenge, address[] calldata accounts)
        external
        view
        returns (uint256)
    {
        (bytes memory payload,,) = _payload(challenge, accounts);
        return messenger.quoteMessageFee(
            destinationChainId, payload, new ICrossChainMessenger.TokenAmount[](0), _destGas(accounts.length)
        );
    }

    /// @notice This contract only sends; an inbound message is refused.
    function onCrossChainMessage(uint256, address, bytes calldata, ICrossChainMessenger.TokenAmount[] calldata, bytes32)
        external
        pure
    {
        revert NotAReceiver();
    }

    /// @dev Only the messenger's fee refund is accepted.
    receive() external payable {
        if (msg.sender != address(messenger)) revert UnexpectedNative(msg.sender);
    }

    function _payload(bytes32 challenge, address[] calldata accounts)
        private
        view
        returns (bytes memory payload, bool[] memory flagged, uint64 oracleUpdatedAt)
    {
        if (challenge == bytes32(0)) revert ZeroChallenge();
        uint256 n = accounts.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_ACCOUNTS) revert BatchTooLarge(n, MAX_ACCOUNTS);
        flagged = new bool[](n);
        for (uint256 i; i < n; ++i) {
            if (accounts[i] == address(0)) revert ZeroAddress();
            flagged[i] = oracle.isSanctioned(accounts[i]);
        }
        // Known values are at most this block's timestamp, so they fit.
        (, uint256 updatedAt) = LibOracleFreshness.lastUpdate(address(oracle));
        oracleUpdatedAt = uint64(updatedAt);
        payload = abi.encode(SANCTIONS_CLEARANCE_WIRE_VERSION, challenge, accounts, flagged, oracleUpdatedAt);
    }

    function _destGas(uint256 n) private pure returns (uint256) {
        return DEST_GAS_BASE + DEST_GAS_PER_ACCOUNT * n;
    }
}
