// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/**
 * @title ICrossChainMessenger — Vaipakam's internal cross-chain messaging port
 *
 * T-068 — the modular seam between Vaipakam's domain logic (the VPFI buy
 * flow, the reward accounting) and whatever cross-chain messaging provider
 * sits underneath. Today the provider is Chainlink CCIP (`CcipMessenger`);
 * the LayerZero integration that preceded it was deeply coupled — T-081
 * flagged it as one of only two deeply-integrated dependencies. This
 * interface is the fix: domain contracts depend ONLY on these types and
 * methods, never on a provider SDK.
 *
 * Design rules (load-bearing — see
 * `docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md` §4.1):
 *
 *  - Every type here is a **Vaipakam type**. Chain identity is the plain
 *    EVM `chainId` — NOT a CCIP chain selector, NOT a LayerZero endpoint
 *    id. The provider adapter translates at its own boundary.
 *  - No provider SDK type (`Client.*`, `Origin`, `IOFT`, …) ever appears
 *    in this file. If one leaks in, the abstraction is fake.
 *  - A future provider swap re-implements the adapter (`CcipMessenger`)
 *    against this interface; the domain contracts are untouched.
 *
 * The port is two halves: {ICrossChainMessenger} (a domain contract sends
 * through it) and {ICrossChainMessageRecipient} (a domain contract receives
 * through it). One deployed adapter implements the messenger and dispatches
 * inbound messages to the recipient registered for each channel.
 */
interface ICrossChainMessenger {
    /**
     * @notice A token amount to move alongside a message — addresses are
     *         always on the *local* chain of the contract handling them.
     * @param token  Local-chain ERC20 address.
     * @param amount Amount in the token's own decimals.
     */
    struct TokenAmount {
        address token;
        uint256 amount;
    }

    /**
     * @notice Send a cross-chain message — arbitrary `payload` data and/or
     *         a set of token transfers — to `destinationChainId`.
     * @dev Native-token-funded: the caller forwards the cross-chain fee as
     *      `msg.value` (quote it first with {quoteMessageFee}). Any token
     *      in `tokens` must already be approved to / held by the adapter
     *      per the adapter's documented pull model. The adapter resolves
     *      `destinationChainId` to the provider's own chain identifier and
     *      rejects an unconfigured destination.
     * @param destinationChainId EVM chain id of the destination chain.
     * @param payload            Opaque domain payload (the adapter wraps it
     *                           with routing metadata; recipients get back
     *                           exactly these bytes).
     * @param tokens             Token transfers to accompany the message;
     *                           empty for a data-only message.
     * @param destGasLimit       Gas to allow for the recipient callback on
     *                           the destination chain.
     * @return messageId         Opaque provider message id, for tracing.
     */
    function sendMessage(
        uint256 destinationChainId,
        bytes calldata payload,
        TokenAmount[] calldata tokens,
        uint256 destGasLimit
    ) external payable returns (bytes32 messageId);

    /**
     * @notice Quote the native-token fee for the equivalent {sendMessage}.
     * @dev Pass the SAME arguments you will pass to {sendMessage}; the fee
     *      depends on payload size, token set and `destGasLimit`.
     * @return nativeFee Fee in the local chain's native token (wei).
     */
    function quoteMessageFee(
        uint256 destinationChainId,
        bytes calldata payload,
        TokenAmount[] calldata tokens,
        uint256 destGasLimit
    ) external view returns (uint256 nativeFee);

    /**
     * @notice EVM chain id this adapter is deployed on (its local chain).
     */
    function localChainId() external view returns (uint256);
}

/**
 * @title ICrossChainMessageRecipient — the inbound half of the port
 *
 * A Vaipakam domain contract (e.g. the VPFI buy receiver, the reward
 * messenger) implements this and registers with the adapter for a channel.
 * The adapter calls {onCrossChainMessage} when a message for that channel
 * arrives — after the adapter has authenticated the source (provider
 * verification + the source-sender allowlist) and forwarded any tokens.
 */
interface ICrossChainMessageRecipient {
    /**
     * @notice Handle an inbound cross-chain message.
     * @dev MUST be callable only by the registered messenger adapter — the
     *      implementer enforces that. Any `tokens` have already been
     *      transferred to this contract by the adapter before this call.
     *      The implementer must still treat the message as advisory and
     *      decide outcomes from its own authoritative local state, never
     *      solely from the payload (see the migration design §5).
     * @param sourceChainId EVM chain id the message originated on.
     * @param sourceSender  The source-chain contract that sent it (the
     *                      adapter has already checked it against the
     *                      per-channel allowlist).
     * @param payload       The exact bytes the sender passed to
     *                      {ICrossChainMessenger.sendMessage}.
     * @param tokens        Tokens delivered with the message, now held by
     *                      this contract; empty for a data-only message.
     */
    function onCrossChainMessage(
        uint256 sourceChainId,
        address sourceSender,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens
    ) external;
}
