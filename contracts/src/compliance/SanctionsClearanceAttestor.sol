// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ISanctionsList} from "../interfaces/ISanctionsList.sol";
import {ICrossChainMessenger, ICrossChainMessageRecipient} from "../crosschain/ICrossChainMessenger.sol";

/// @dev The clearance wire format both ends agree on:
///      `abi.encode(uint16 version, address[] accounts, bool[] flagged, uint64 asOf)`.
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
 *         WHICH addresses are read, never what the answer is, and the
 *         receiving timelock keeps only the newest reading per address. An
 *         oracle read that reverts reverts the attestation, so an
 *         unreadable oracle never produces a "not flagged".
 *
 *         Each destination needs this contract registered as the handler of
 *         the clearance channel on this chain's messenger, with the
 *         destination timelock as that channel's peer; the timelock is the
 *         handler on its own chain, with this contract as its peer.
 */
contract SanctionsClearanceAttestor is ICrossChainMessageRecipient {
    /// @notice The most addresses one attestation may carry.
    uint256 public constant MAX_ACCOUNTS = 100;

    /// @notice Destination gas: a base allowance plus one clearance write
    ///         per address.
    uint256 public constant DEST_GAS_BASE = 100_000;
    uint256 public constant DEST_GAS_PER_ACCOUNT = 35_000;

    /// @notice RedStone's Sanctions Oracle on this chain.
    ISanctionsList public immutable oracle;

    /// @notice This chain's `ICrossChainMessenger`.
    ICrossChainMessenger public immutable messenger;

    /// @custom:event-category informational/compliance
    event ClearanceAttested(
        uint256 indexed destinationChainId,
        bytes32 indexed messageId,
        address indexed caller,
        address[] accounts,
        bool[] flagged,
        uint64 asOf
    );

    error ZeroAddress();
    error NotAContract(address candidate);
    error EmptyBatch();
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

    /// @notice Read the oracle for `accounts` and send the answers to the
    ///         timelock on `destinationChainId`. Pay the fee as `msg.value`
    ///         (quote it with {quote}); any overpayment is returned.
    /// @return messageId The transport's id for the message.
    function attest(uint256 destinationChainId, address[] calldata accounts)
        external
        payable
        returns (bytes32 messageId)
    {
        (bytes memory payload, bool[] memory flagged, uint64 asOf) = _payload(accounts);
        messageId = messenger.sendMessage{value: msg.value}(
            destinationChainId, payload, new ICrossChainMessenger.TokenAmount[](0), _destGas(accounts.length)
        );
        emit ClearanceAttested(destinationChainId, messageId, msg.sender, accounts, flagged, asOf);
        // The messenger refunds overpayment here; pass it on. This contract
        // holds nothing between calls, so its whole balance is the refund.
        uint256 refund = address(this).balance;
        if (refund != 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @notice The fee {attest} would need for the same arguments now.
    function quote(uint256 destinationChainId, address[] calldata accounts) external view returns (uint256) {
        (bytes memory payload,,) = _payload(accounts);
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

    function _payload(address[] calldata accounts)
        private
        view
        returns (bytes memory payload, bool[] memory flagged, uint64 asOf)
    {
        uint256 n = accounts.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_ACCOUNTS) revert BatchTooLarge(n, MAX_ACCOUNTS);
        flagged = new bool[](n);
        for (uint256 i; i < n; ++i) {
            if (accounts[i] == address(0)) revert ZeroAddress();
            flagged[i] = oracle.isSanctioned(accounts[i]);
        }
        asOf = uint64(block.timestamp);
        payload = abi.encode(SANCTIONS_CLEARANCE_WIRE_VERSION, accounts, flagged, asOf);
    }

    function _destGas(uint256 n) private pure returns (uint256) {
        return DEST_GAS_BASE + DEST_GAS_PER_ACCOUNT * n;
    }
}
