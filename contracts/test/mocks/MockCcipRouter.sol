// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IRouterClient} from "@chainlink/contracts/src/v0.8/ccip/interfaces/IRouterClient.sol";
import {IAny2EVMMessageReceiver} from "@chainlink/contracts/src/v0.8/ccip/interfaces/IAny2EVMMessageReceiver.sol";
import {Client} from "@chainlink/contracts/src/v0.8/ccip/libraries/Client.sol";

/**
 * @title MockCcipRouter
 * @notice In-memory stand-in for the Chainlink CCIP `IRouterClient`, for
 *         unit-testing {CcipMessenger} (T-068 Phase 1) without a live
 *         CCIP deployment.
 *
 * @dev On `ccipSend` the mock pulls the approved tokens from the calling
 *      messenger (mimicking the CCIP TokenPool pull) and parks the message
 *      in {pending}. A test then calls {deliver} to push the message — and
 *      its tokens — into the destination messenger's `ccipReceive`, with
 *      the mock router itself as `msg.sender` so the `onlyRouter` gate
 *      passes. One shared MockCcipRouter should back both the "source" and
 *      "destination" messengers in a test so this caller identity holds.
 */
contract MockCcipRouter is IRouterClient {
    /// @dev A message captured by `ccipSend`, awaiting test-driven delivery.
    struct Pending {
        uint64 destChainSelector;
        address sourceMessenger; // the CcipMessenger that called ccipSend
        bytes receiver; // abi.encode(dest messenger) — from the message
        bytes data;
        Client.EVMTokenAmount[] tokenAmounts;
        bool delivered;
    }

    /// @notice Flat fee returned by {getFee}, in wei. Test-settable.
    uint256 public fixedFee = 0.01 ether;

    /// @notice Selectors {isChainSupported} answers `true` for.
    mapping(uint64 => bool) public supported;

    /// @notice Every message captured by {ccipSend}, in send order.
    Pending[] public pending;

    /// @notice Emitted by {deliver} once a message has been pushed.
    event Delivered(uint256 indexed index, bytes32 messageId);

    // ─── Test configuration ─────────────────────────────────────────────────

    function setFixedFee(uint256 fee) external {
        fixedFee = fee;
    }

    function setSupported(uint64 selector, bool ok) external {
        supported[selector] = ok;
    }

    function pendingCount() external view returns (uint256) {
        return pending.length;
    }

    // ─── IRouterClient ──────────────────────────────────────────────────────

    function isChainSupported(
        uint64 destChainSelector
    ) external view override returns (bool) {
        return supported[destChainSelector];
    }

    function getFee(
        uint64,
        Client.EVM2AnyMessage memory
    ) external view override returns (uint256) {
        return fixedFee;
    }

    function ccipSend(
        uint64 destinationChainSelector,
        Client.EVM2AnyMessage calldata message
    ) external payable override returns (bytes32) {
        if (!supported[destinationChainSelector]) {
            revert UnsupportedDestinationChain(destinationChainSelector);
        }
        if (msg.value < fixedFee) revert InsufficientFeeTokenAmount();

        // Pull the tokens the messenger approved — mimics the TokenPool.
        for (uint256 i; i < message.tokenAmounts.length; ++i) {
            IERC20(message.tokenAmounts[i].token).transferFrom(
                msg.sender, address(this), message.tokenAmounts[i].amount
            );
        }

        Pending storage p = pending.push();
        p.destChainSelector = destinationChainSelector;
        p.sourceMessenger = msg.sender;
        p.receiver = message.receiver;
        p.data = message.data;
        for (uint256 i; i < message.tokenAmounts.length; ++i) {
            p.tokenAmounts.push(message.tokenAmounts[i]);
        }
        return _messageId(pending.length - 1);
    }

    // ─── Test-driven delivery ───────────────────────────────────────────────

    /// @notice Push a captured message into its destination messenger's
    ///         `ccipReceive`, transferring any tokens first. `msg.sender`
    ///         of the callback is this router, satisfying `onlyRouter`.
    /// @param index            Index into {pending}.
    /// @param sourceSelector   CCIP selector the destination should see as
    ///                         the message's origin.
    function deliver(uint256 index, uint64 sourceSelector) external {
        Pending storage p = pending[index];
        require(!p.delivered, "MockCcipRouter: already delivered");
        p.delivered = true;

        address destMessenger = abi.decode(p.receiver, (address));

        for (uint256 i; i < p.tokenAmounts.length; ++i) {
            IERC20(p.tokenAmounts[i].token).transfer(
                destMessenger, p.tokenAmounts[i].amount
            );
        }

        Client.Any2EVMMessage memory m = Client.Any2EVMMessage({
            messageId: _messageId(index),
            sourceChainSelector: sourceSelector,
            sender: abi.encode(p.sourceMessenger),
            data: p.data,
            destTokenAmounts: p.tokenAmounts
        });

        IAny2EVMMessageReceiver(destMessenger).ccipReceive(m);
        emit Delivered(index, _messageId(index));
    }

    /// @dev Deterministic pseudo message id for a pending entry.
    function _messageId(uint256 index) internal view returns (bytes32) {
        return keccak256(abi.encode(address(this), index));
    }
}
