// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    ICrossChainMessenger,
    ICrossChainMessageRecipient
} from "../../src/crosschain/ICrossChainMessenger.sol";

/**
 * @title MockCrossChainMessenger
 * @notice In-memory implementation of the {ICrossChainMessenger} port for
 *         unit-testing Vaipakam's cross-chain DOMAIN contracts — the VPFI
 *         buy adapter/receiver and the reward messenger (T-068 Phases 3–4)
 *         — without CCIP or {CcipMessenger}.
 *
 * @dev The port's whole point: a domain contract depends only on
 *      {ICrossChainMessenger}, so a test can substitute this mock for the
 *      real CCIP adapter wholesale. `sendMessage` honours the same pull
 *      model as {CcipMessenger} (it pulls approved tokens from the caller)
 *      and parks the message; a test then calls {relay} to drive it into a
 *      recipient's {onCrossChainMessage}, choosing the `sourceChainId` and
 *      `sourceSender` the recipient should observe.
 */
contract MockCrossChainMessenger is ICrossChainMessenger {
    struct Sent {
        uint256 destinationChainId;
        address sender; // the domain contract that called sendMessage
        bytes payload;
        TokenAmount[] tokens;
        uint256 destGasLimit;
        bool relayed;
    }

    /// @notice Fee returned by {quoteMessageFee} and required by
    ///         {sendMessage}. Test-settable.
    uint256 public fee = 0.001 ether;

    /// @notice Value {localChainId} reports. Test-settable; defaults to the
    ///         actual chain id.
    uint256 private _localChainId = block.chainid;

    /// @notice Every message captured by {sendMessage}, in send order.
    Sent[] public sent;

    event MessageSent(uint256 indexed index, uint256 indexed destinationChainId);
    event MessageRelayed(uint256 indexed index, address indexed recipient);

    // ─── Test configuration ─────────────────────────────────────────────────

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function setLocalChainId(uint256 chainId) external {
        _localChainId = chainId;
    }

    function sentCount() external view returns (uint256) {
        return sent.length;
    }

    /// @notice The token list captured for a given send (the indexed
    ///         `sent` getter cannot return the nested array).
    function sentTokens(
        uint256 index
    ) external view returns (TokenAmount[] memory) {
        return sent[index].tokens;
    }

    /// @notice The raw payload captured for a given send (the auto-getter omits
    ///         the dynamic `bytes` member).
    function sentPayload(uint256 index) external view returns (bytes memory) {
        return sent[index].payload;
    }

    // ─── ICrossChainMessenger ───────────────────────────────────────────────

    function sendMessage(
        uint256 destinationChainId,
        bytes calldata payload,
        TokenAmount[] calldata tokens,
        uint256 destGasLimit
    ) external payable override returns (bytes32 messageId) {
        require(msg.value >= fee, "MockMessenger: fee not covered");

        Sent storage s = sent.push();
        s.destinationChainId = destinationChainId;
        s.sender = msg.sender;
        s.payload = payload;
        s.destGasLimit = destGasLimit;
        for (uint256 i; i < tokens.length; ++i) {
            IERC20(tokens[i].token).transferFrom(
                msg.sender, address(this), tokens[i].amount
            );
            s.tokens.push(tokens[i]);
        }

        messageId = keccak256(abi.encode(address(this), sent.length - 1));
        emit MessageSent(sent.length - 1, destinationChainId);
    }

    function quoteMessageFee(
        uint256,
        bytes calldata,
        TokenAmount[] calldata,
        uint256
    ) external view override returns (uint256) {
        return fee;
    }

    function localChainId() external view override returns (uint256) {
        return _localChainId;
    }

    // ─── Test-driven delivery ───────────────────────────────────────────────

    /// @notice Drive a captured message into a recipient, transferring any
    ///         parked tokens first (matching {CcipMessenger}: the handler
    ///         holds the tokens before the callback runs).
    /// @param index         Index into {sent}.
    /// @param recipient     The {ICrossChainMessageRecipient} to deliver to.
    /// @param sourceChainId The origin chain id the recipient should see.
    /// @param sourceSender  The origin sender the recipient should see.
    function relay(
        uint256 index,
        address recipient,
        uint256 sourceChainId,
        address sourceSender
    ) external {
        Sent storage s = sent[index];
        require(!s.relayed, "MockMessenger: already relayed");
        s.relayed = true;

        for (uint256 i; i < s.tokens.length; ++i) {
            IERC20(s.tokens[i].token).transfer(
                recipient, s.tokens[i].amount
            );
        }

        ICrossChainMessageRecipient(recipient).onCrossChainMessage(
            sourceChainId, sourceSender, s.payload, s.tokens
        );
        emit MessageRelayed(index, recipient);
    }
}
