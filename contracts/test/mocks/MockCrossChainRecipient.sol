// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    ICrossChainMessenger,
    ICrossChainMessageRecipient
} from "../../src/crosschain/ICrossChainMessenger.sol";

/**
 * @title MockCrossChainRecipient
 * @notice A stand-in domain handler for {CcipMessenger} unit tests
 *         (T-068 Phase 1). It registers as a channel handler, records
 *         every inbound {onCrossChainMessage}, and can itself send a
 *         message back through the messenger — exercising the
 *         receive → handler → `sendMessage` path the buy flow relies on.
 */
contract MockCrossChainRecipient is ICrossChainMessageRecipient {
    // ─── Last-received message ──────────────────────────────────────────────

    uint256 public lastSourceChainId;
    address public lastSourceSender;
    bytes public lastPayload;
    uint256 public receivedCount;
    /// @dev Token / amount of the most recent delivery, recorded flat
    ///      (covers the single-token case the buy flow uses).
    address public lastTokenIn;
    uint256 public lastTokenAmount;

    // ─── Optional resend-on-receive (exercises receive → send) ──────────────

    bool public resendOnReceive;
    address public resendMessenger;
    uint256 public resendDestChainId;
    bytes public resendPayload;
    uint256 public resendGasLimit;
    uint256 public resendValue;

    /// @notice Configure a resend triggered from inside the next
    ///         {onCrossChainMessage} — used to prove the inbound path can
    ///         re-enter {ICrossChainMessenger.sendMessage} without
    ///         deadlocking on a shared reentrancy guard.
    function armResend(
        address messenger,
        uint256 destChainId,
        bytes calldata payload,
        uint256 gasLimit,
        uint256 value
    ) external {
        resendOnReceive = true;
        resendMessenger = messenger;
        resendDestChainId = destChainId;
        resendPayload = payload;
        resendGasLimit = gasLimit;
        resendValue = value;
    }

    // ─── ICrossChainMessageRecipient ────────────────────────────────────────

    function onCrossChainMessage(
        uint256 sourceChainId,
        address sourceSender,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens
    ) external override {
        lastSourceChainId = sourceChainId;
        lastSourceSender = sourceSender;
        lastPayload = payload;
        ++receivedCount;
        if (tokens.length > 0) {
            lastTokenIn = tokens[0].token;
            lastTokenAmount = tokens[0].amount;
        } else {
            lastTokenIn = address(0);
            lastTokenAmount = 0;
        }

        if (resendOnReceive) {
            resendOnReceive = false; // one-shot
            ICrossChainMessenger.TokenAmount[] memory none =
                new ICrossChainMessenger.TokenAmount[](0);
            ICrossChainMessenger(resendMessenger).sendMessage{
                value: resendValue
            }(resendDestChainId, resendPayload, none, resendGasLimit);
        }
    }

    // ─── Outbound test helpers ──────────────────────────────────────────────

    /// @notice Send a message through `messenger`, forwarding `msg.value`
    ///         as the CCIP fee.
    function send(
        address messenger,
        uint256 destChainId,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens,
        uint256 destGasLimit
    ) external payable returns (bytes32) {
        return
            ICrossChainMessenger(messenger).sendMessage{value: msg.value}(
                destChainId, payload, tokens, destGasLimit
            );
    }

    /// @notice Quote a send through `messenger`.
    function quote(
        address messenger,
        uint256 destChainId,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens,
        uint256 destGasLimit
    ) external view returns (uint256) {
        return
            ICrossChainMessenger(messenger).quoteMessageFee(
                destChainId, payload, tokens, destGasLimit
            );
    }

    /// @notice Approve `spender` for `amount` of `token` — lets a test set
    ///         up the messenger's token pull.
    function approve(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }

    /// @dev Accept CCIP fee refunds and test-funded ETH.
    receive() external payable {}
}
