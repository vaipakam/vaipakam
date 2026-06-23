// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";

import {GuardianPausable} from "./GuardianPausable.sol";
import {ICrossChainMessenger, ICrossChainMessageRecipient} from "./ICrossChainMessenger.sol";

/**
 * @title CcipMessenger — the Chainlink CCIP adapter behind Vaipakam's
 *        cross-chain messaging port
 *
 * T-068. This is the ONE contract in the codebase that is CCIP-aware —
 * the single adapter that implements {ICrossChainMessenger} (the outbound
 * port) and the CCIP {CCIPReceiver} base (the inbound port). Every domain
 * contract — the VPFI buy adapter/receiver, the reward messenger — talks
 * only to {ICrossChainMessenger} and never imports a CCIP library. A
 * future provider swap re-implements this one file (plus the token pools)
 * and the domain contracts are untouched. See
 * `docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md` §4.1.
 *
 * ── Channels ───────────────────────────────────────────────────────────
 * A *channel* is a logical cross-chain conversation between a matched pair
 * of domain contracts — e.g. the "vpfi-reward" channel pairs the two
 * `VaipakamRewardMessenger` deployments, and the "vpfi-buyback" channel
 * pairs each mirror Diamond with the Base `BuybackRemittanceReceiver`. One
 * deployed CcipMessenger carries every channel for its chain; inbound
 * messages are dispatched to the right local handler by `channelId`.
 *
 *   - `handlerOf[channelId]`  — the domain contract on THIS chain for a
 *                               channel (the receive target).
 *   - `channelOf[handler]`    — the reverse: a registered handler's
 *                               channel, used to stamp outbound messages.
 *   - `channelPeerOf[channelId][remoteChainId]` — the domain contract on
 *                               a remote chain for a channel; surfaced to
 *                               the local handler as the inbound
 *                               `sourceSender`.
 *
 * ── Routing envelope ───────────────────────────────────────────────────
 * Outbound, the adapter wraps the domain payload as
 * `abi.encode(channelId, payload)` and addresses the CCIP message to the
 * REMOTE CcipMessenger (`remoteMessengerOf[destChainId]`), never directly
 * to a domain contract. Inbound, the adapter unwraps the envelope and
 * forwards exactly `payload` to the local handler — so a recipient gets
 * back the precise bytes the sender passed (per the {ICrossChainMessenger}
 * contract).
 *
 * ── Forgery guards ─────────────────────────────────────────────────────
 *   1. `onlyRouter` — `ccipReceive` accepts calls only from the CCIP
 *      router (enforced by {CCIPReceiver}).
 *   2. Messenger allowlist — the decoded CCIP `message.sender` must equal
 *      the `remoteMessengerOf[sourceChainId]` we registered. This is the
 *      CCIP analogue of LayerZero's peer registry.
 *   3. Channel config — both ends of a channel must be configured
 *      (`handlerOf` here, `channelPeerOf` for the source). An
 *      unconfigured channel is rejected, never silently dropped.
 * Any domain-layer secondary guard (e.g. two-step releases) lives in the
 * channel's handler contract, not here.
 *
 * ── Tokens ─────────────────────────────────────────────────────────────
 * Pull model on send: a calling handler approves this adapter for each
 * token in the {ICrossChainMessenger.TokenAmount} list; `sendMessage`
 * pulls them and approves the router. On receive, CCIP delivers tokens to
 * this adapter; `_ccipReceive` forwards them to the local handler BEFORE
 * the `onCrossChainMessage` callback — so the handler already holds them.
 *
 * Per-lane CCIP rate limits (the value/time blast-radius cap) live on the
 * CCIP TokenPools, configured in Phase 2 — not on this adapter.
 *
 * @dev UUPS-upgradeable. The CCIP router is a constructor immutable (baked
 *      into the implementation, the same posture as the stock
 *      {CCIPReceiver}); rotating it is an implementation upgrade. Guardian
 *      + owner emergency pause via {GuardianPausable} freezes BOTH the
 *      send and the receive path — a paused `_ccipReceive` reverts, which
 *      CCIP records as a failed message that is manually re-executable
 *      once unpaused, so no message is lost.
 */
contract CcipMessenger is
    Initializable,
    CCIPReceiver,
    Ownable2StepUpgradeable,
    GuardianPausable,
    ReentrancyGuardTransient,
    UUPSUpgradeable,
    ICrossChainMessenger
{
    using SafeERC20 for IERC20;

    // ─── Storage ────────────────────────────────────────────────────────────

    /// @notice EVM chain id → CCIP chain selector (the provider's own
    ///         chain identifier). The translation point the design
    ///         mandates: domain contracts pass plain `chainId`; only this
    ///         adapter knows the selector. Zero selector = unconfigured.
    mapping(uint256 => uint64) public chainSelectorOf;

    /// @notice CCIP chain selector → EVM chain id. The reverse of
    ///         {chainSelectorOf}, kept in lockstep by {setChainSelector};
    ///         used inbound to turn a CCIP `sourceChainSelector` back into
    ///         the plain `chainId` the handler callback expects.
    mapping(uint64 => uint256) public chainIdOf;

    /// @notice EVM chain id → the CcipMessenger deployed on that chain.
    ///         Outbound, this is the CCIP message receiver; inbound, the
    ///         allowlisted sender. Zero = no peer messenger.
    mapping(uint256 => address) public remoteMessengerOf;

    /// @notice channelId → the local domain contract that handles that
    ///         channel's inbound messages. Zero = channel not registered
    ///         on this chain.
    mapping(bytes32 => address) public handlerOf;

    /// @notice Local handler → its channelId. The reverse of {handlerOf},
    ///         kept in lockstep by {registerChannel}; used to stamp the
    ///         channel onto an outbound message from `msg.sender`.
    mapping(address => bytes32) public channelOf;

    /// @notice channelId → remote chain id → the channel's domain contract
    ///         on that remote chain. Surfaced to the local handler as the
    ///         inbound `sourceSender`; the handler does its own equality
    ///         check against the peer it expects. Zero = unconfigured.
    mapping(bytes32 => mapping(uint256 => address)) public channelPeerOf;

    /// @dev Reserved storage for upgrade-safe appends. 6 slots used above.
    // forge-lint: disable-next-line(mixed-case-variable)
    uint256[44] private __gap;

    // ─── Events ─────────────────────────────────────────────────────────────

    /// @notice A cross-chain message left this chain.
    /// @custom:event-category state-change/crosschain-send
    event MessageSent(
        bytes32 indexed messageId,
        bytes32 indexed channelId,
        uint256 indexed destinationChainId
    );

    /// @notice A cross-chain message was delivered and dispatched to its
    ///         local handler.
    /// @custom:event-category state-change/crosschain-receive
    event MessageReceived(
        bytes32 indexed messageId,
        bytes32 indexed channelId,
        uint256 indexed sourceChainId,
        address sourceSender
    );

    /// @custom:event-category informational/config
    event ChainSelectorSet(uint256 indexed chainId, uint64 selector);
    /// @custom:event-category informational/config
    event RemoteMessengerSet(uint256 indexed chainId, address messenger);
    /// @custom:event-category informational/config
    event ChannelRegistered(bytes32 indexed channelId, address localHandler);
    /// @custom:event-category informational/config
    event ChannelPeerSet(
        bytes32 indexed channelId,
        uint256 indexed remoteChainId,
        address peer
    );

    // ─── Errors ─────────────────────────────────────────────────────────────

    /// @notice A constructor / initializer argument was the zero address.
    error ZeroAddress();
    /// @notice {setChainSelector} called with `chainId == 0`.
    error ZeroChainId();
    /// @notice {registerChannel} called with the zero channelId.
    error ZeroChannelId();
    /// @notice `sendMessage` / `quoteMessageFee` caller is not a
    ///         registered channel handler.
    error CallerNotHandler(address caller);
    /// @notice No CCIP chain selector configured for an EVM chain id.
    error UnconfiguredChain(uint256 chainId);
    /// @notice An inbound CCIP `sourceChainSelector` maps to no EVM
    ///         chain id.
    error UnconfiguredSelector(uint64 selector);
    /// @notice No remote CcipMessenger configured for a chain id.
    error NoRemoteMessenger(uint256 chainId);
    /// @notice The CCIP router does not support the resolved selector.
    error UnsupportedByRouter(uint64 selector);
    /// @notice An inbound message arrived for a channelId not registered
    ///         on this chain.
    error UnknownChannel(bytes32 channelId);
    /// @notice No business peer configured for a (channel, chain) pair.
    error NoChannelPeer(bytes32 channelId, uint256 chainId);
    /// @notice An inbound message's decoded sender is not the registered
    ///         CcipMessenger for its source chain.
    error UnauthorizedSourceMessenger(uint64 selector, address sender);
    /// @notice `msg.value` did not cover the CCIP fee.
    error InsufficientFee(uint256 provided, uint256 required);
    /// @notice The fee-overpayment refund to the calling handler failed.
    error RefundFailed();
    /// @notice A CCIP selector is already bound to a different chain id —
    ///         the selector↔chain map must stay one-to-one.
    error SelectorAlreadyBound(uint64 selector, uint256 boundChainId);
    /// @notice A handler is already registered on a different channel —
    ///         the channel↔handler map must stay one-to-one.
    error HandlerAlreadyBound(address handler, bytes32 boundChannelId);
    /// @notice The outbound token list named the same token twice; each
    ///         token may appear at most once per message.
    error DuplicateToken(address token);

    // ─── Construction ───────────────────────────────────────────────────────

    /// @param router The CCIP router for the chain this implementation is
    ///        deployed on. Immutable in the implementation bytecode (the
    ///        same model as the stock {CCIPReceiver}); a router change is
    ///        an implementation upgrade.
    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(address router) CCIPReceiver(router) {
        if (router == address(0)) revert ZeroAddress();
        _disableInitializers();
    }

    /// @notice Initialize the proxy.
    /// @param owner_ The owner (the admin multi-sig initially, the
    ///        governance timelock later). Holds every config setter and
    ///        the upgrade authorization.
    function initialize(address owner_) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        __Ownable2Step_init();
        _guardianPausableInit();
    }

    // ─── Outbound — the {ICrossChainMessenger} port ─────────────────────────

    /// @inheritdoc ICrossChainMessenger
    /// @dev Native-funded: the caller forwards the CCIP fee as `msg.value`.
    ///      The fee is quoted internally and the exact amount is sent on;
    ///      any overpayment is refunded to the calling handler (CCIP itself
    ///      keeps overpayment, so the adapter must not over-send). The
    ///      caller must have approved this adapter for every token in
    ///      `tokens`.
    function sendMessage(
        uint256 destinationChainId,
        bytes calldata payload,
        TokenAmount[] calldata tokens,
        uint256 destGasLimit
    )
        external
        payable
        override
        whenNotPaused
        nonReentrant
        returns (bytes32 messageId)
    {
        bytes32 channelId = channelOf[msg.sender];
        if (channelId == bytes32(0)) revert CallerNotHandler(msg.sender);

        (uint64 selector, address remoteMessenger) =
            _resolveDestination(destinationChainId);

        // Pull each token from the calling handler and approve the router.
        Client.EVMTokenAmount[] memory ccipTokens = _pullTokens(tokens);

        Client.EVM2AnyMessage memory message = _buildMessage(
            remoteMessenger, channelId, payload, ccipTokens, destGasLimit
        );

        IRouterClient router = IRouterClient(getRouter());
        uint256 fee = router.getFee(selector, message);
        if (msg.value < fee) revert InsufficientFee(msg.value, fee);

        messageId = router.ccipSend{value: fee}(selector, message);
        emit MessageSent(messageId, channelId, destinationChainId);

        // Refund any fee overpayment. `nonReentrant` (transient guard) is
        // still held here, so a re-entrant `sendMessage` from the handler's
        // receive hook reverts rather than nesting; and it is the LAST
        // statement, after `ccipSend` and every state write (CEI). The
        // adapter custodies no balance between calls regardless.
        uint256 refund = msg.value - fee;
        if (refund > 0) {
            (bool ok, ) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @inheritdoc ICrossChainMessenger
    /// @dev Pass the SAME arguments intended for {sendMessage}. The caller
    ///      must be a registered handler so the quote reflects the exact
    ///      routing envelope {sendMessage} would build.
    function quoteMessageFee(
        uint256 destinationChainId,
        bytes calldata payload,
        TokenAmount[] calldata tokens,
        uint256 destGasLimit
    ) external view override returns (uint256 nativeFee) {
        bytes32 channelId = channelOf[msg.sender];
        if (channelId == bytes32(0)) revert CallerNotHandler(msg.sender);

        (uint64 selector, address remoteMessenger) =
            _resolveDestination(destinationChainId);

        // Build the CCIP token list WITHOUT pulling — a view cannot move
        // tokens; the fee depends only on the list's shape, not custody.
        Client.EVMTokenAmount[] memory ccipTokens =
            new Client.EVMTokenAmount[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            ccipTokens[i] = Client.EVMTokenAmount({
                token: tokens[i].token,
                amount: tokens[i].amount
            });
        }

        Client.EVM2AnyMessage memory message = _buildMessage(
            remoteMessenger, channelId, payload, ccipTokens, destGasLimit
        );
        nativeFee = IRouterClient(getRouter()).getFee(selector, message);
    }

    /// @inheritdoc ICrossChainMessenger
    function localChainId() external view override returns (uint256) {
        return block.chainid;
    }

    // ─── Inbound — the CCIP receive path ────────────────────────────────────

    /// @dev CCIP delivery callback. `onlyRouter` is enforced by the
    ///      {CCIPReceiver} base; `whenNotPaused` freezes delivery during an
    ///      incident (a revert here is recorded by CCIP as a failed
    ///      message, manually re-executable once unpaused).
    function _ccipReceive(
        Client.Any2EVMMessage memory message
    ) internal override whenNotPaused {
        // 1. Allowlist: the message must come from the CcipMessenger we
        //    registered for the source chain.
        uint256 sourceChainId = chainIdOf[message.sourceChainSelector];
        if (sourceChainId == 0) {
            revert UnconfiguredSelector(message.sourceChainSelector);
        }
        address sourceMessenger = abi.decode(message.sender, (address));
        if (sourceMessenger != remoteMessengerOf[sourceChainId]) {
            revert UnauthorizedSourceMessenger(
                message.sourceChainSelector, sourceMessenger
            );
        }

        // 2. Unwrap the routing envelope written by the remote adapter.
        (bytes32 channelId, bytes memory payload) =
            abi.decode(message.data, (bytes32, bytes));

        // 3. Resolve the local handler and the configured business peer.
        address handler = handlerOf[channelId];
        if (handler == address(0)) revert UnknownChannel(channelId);
        address sourceSender = channelPeerOf[channelId][sourceChainId];
        if (sourceSender == address(0)) {
            revert NoChannelPeer(channelId, sourceChainId);
        }

        // 4. Forward any delivered tokens to the handler, translating the
        //    CCIP token list into the seam's own TokenAmount type.
        uint256 n = message.destTokenAmounts.length;
        TokenAmount[] memory tokens = new TokenAmount[](n);
        for (uint256 i; i < n; ++i) {
            Client.EVMTokenAmount memory t = message.destTokenAmounts[i];
            IERC20(t.token).safeTransfer(handler, t.amount);
            tokens[i] = TokenAmount({token: t.token, amount: t.amount});
        }

        // 5. Dispatch to the domain handler. It is owner-registered (so
        //    trusted) but the {ICrossChainMessenger} contract still
        //    requires it to treat the payload as advisory.
        ICrossChainMessageRecipient(handler).onCrossChainMessage(
            sourceChainId, sourceSender, payload, tokens
        );

        emit MessageReceived(
            message.messageId, channelId, sourceChainId, sourceSender
        );
    }

    // ─── Internal helpers ───────────────────────────────────────────────────

    /// @dev Resolve a destination EVM chain id to its CCIP selector and
    ///      the remote CcipMessenger, reverting if any leg is unconfigured
    ///      or the router does not support the lane.
    function _resolveDestination(
        uint256 chainId
    ) internal view returns (uint64 selector, address remoteMessenger) {
        selector = chainSelectorOf[chainId];
        if (selector == 0) revert UnconfiguredChain(chainId);
        remoteMessenger = remoteMessengerOf[chainId];
        if (remoteMessenger == address(0)) revert NoRemoteMessenger(chainId);
        if (!IRouterClient(getRouter()).isChainSupported(selector)) {
            revert UnsupportedByRouter(selector);
        }
    }

    /// @dev Pull each token from the calling handler into this adapter and
    ///      approve the router for the CCIP transfer. `forceApprove`
    ///      tolerates tokens that require a zero-then-set allowance.
    /// @dev A token may appear at most once: `forceApprove` *replaces* the
    ///      router allowance per entry, so a repeated address would leave
    ///      only the last amount approved and `ccipSend` would revert
    ///      mid-list. A duplicate is rejected up front with a clear error.
    function _pullTokens(
        TokenAmount[] calldata tokens
    ) internal returns (Client.EVMTokenAmount[] memory ccipTokens) {
        ccipTokens = new Client.EVMTokenAmount[](tokens.length);
        address router = getRouter();
        for (uint256 i; i < tokens.length; ++i) {
            address tokenAddr = tokens[i].token;
            for (uint256 j; j < i; ++j) {
                if (tokens[j].token == tokenAddr) {
                    revert DuplicateToken(tokenAddr);
                }
            }
            IERC20 token = IERC20(tokenAddr);
            uint256 amount = tokens[i].amount;
            token.safeTransferFrom(msg.sender, address(this), amount);
            token.forceApprove(router, amount);
            ccipTokens[i] =
                Client.EVMTokenAmount({token: tokenAddr, amount: amount});
        }
    }

    /// @dev Build the CCIP message: addressed to the remote CcipMessenger,
    ///      carrying the `(channelId, payload)` routing envelope, fee paid
    ///      in native gas, with a `GenericExtraArgsV2` gas limit. Out-of-
    ///      order execution is allowed — Vaipakam's cross-chain messages
    ///      carry their own `requestId` ordering and several chains enforce
    ///      this flag anyway.
    /// @dev `GenericExtraArgsV2` is the CCIP v1.6 name for what v1.5 called
    ///      `EVMExtraArgsV2` — identical fields and tag, renamed because the
    ///      tag is now valid across multiple chain families.
    function _buildMessage(
        address receiver,
        bytes32 channelId,
        bytes calldata payload,
        Client.EVMTokenAmount[] memory ccipTokens,
        uint256 destGasLimit
    ) internal pure returns (Client.EVM2AnyMessage memory) {
        return Client.EVM2AnyMessage({
            receiver: abi.encode(receiver),
            data: abi.encode(channelId, payload),
            tokenAmounts: ccipTokens,
            feeToken: address(0),
            extraArgs: Client._argsToBytes(
                Client.GenericExtraArgsV2({
                    gasLimit: destGasLimit,
                    allowOutOfOrderExecution: true
                })
            )
        });
    }

    // ─── Admin — lane and channel configuration (owner-only) ────────────────

    /// @notice Map an EVM chain id to its CCIP chain selector (and keep the
    ///         reverse map in lockstep). Pass `selector == 0` to unconfigure
    ///         a chain.
    /// @dev Owner is the admin multi-sig initially, the governance timelock
    ///      later — the standard protocol phasing.
    function setChainSelector(
        uint256 chainId,
        uint64 selector
    ) external onlyOwner {
        if (chainId == 0) revert ZeroChainId();
        // Keep the map one-to-one: a selector already pointing at another
        // chain would, on this write, leave that chain's `chainSelectorOf`
        // entry orphaned and silently re-route its inbound messages here.
        if (selector != 0) {
            uint256 boundChain = chainIdOf[selector];
            if (boundChain != 0 && boundChain != chainId) {
                revert SelectorAlreadyBound(selector, boundChain);
            }
        }
        uint64 previous = chainSelectorOf[chainId];
        // Drop a stale reverse entry if this chain's selector changes.
        if (previous != 0 && previous != selector) delete chainIdOf[previous];
        chainSelectorOf[chainId] = selector;
        if (selector != 0) chainIdOf[selector] = chainId;
        emit ChainSelectorSet(chainId, selector);
    }

    /// @notice Register (or, with `address(0)`, clear) the CcipMessenger
    ///         deployed on a remote chain — the outbound receiver and the
    ///         inbound allowlisted sender for that chain.
    function setRemoteMessenger(
        uint256 chainId,
        address messenger
    ) external onlyOwner {
        if (chainId == 0) revert ZeroChainId();
        remoteMessengerOf[chainId] = messenger;
        emit RemoteMessengerSet(chainId, messenger);
    }

    /// @notice Register (or, with `address(0)`, clear) the local domain
    ///         contract that handles a channel on this chain. Keeps the
    ///         {channelOf} reverse map in lockstep.
    function registerChannel(
        bytes32 channelId,
        address handler
    ) external onlyOwner {
        if (channelId == bytes32(0)) revert ZeroChannelId();
        // Keep the map one-to-one: a handler already registered on another
        // channel would stay reachable inbound via both channels while its
        // outbound messages are stamped with only the latest — misrouting.
        if (handler != address(0)) {
            bytes32 boundChannel = channelOf[handler];
            if (boundChannel != bytes32(0) && boundChannel != channelId) {
                revert HandlerAlreadyBound(handler, boundChannel);
            }
        }
        address previous = handlerOf[channelId];
        if (previous != address(0)) delete channelOf[previous];
        handlerOf[channelId] = handler;
        if (handler != address(0)) channelOf[handler] = channelId;
        emit ChannelRegistered(channelId, handler);
    }

    /// @notice Configure (or, with `address(0)`, clear) the domain contract
    ///         on a remote chain for a channel — the inbound `sourceSender`
    ///         the local handler is told a message came from.
    function setChannelPeer(
        bytes32 channelId,
        uint256 remoteChainId,
        address peer
    ) external onlyOwner {
        if (channelId == bytes32(0)) revert ZeroChannelId();
        if (remoteChainId == 0) revert ZeroChainId();
        channelPeerOf[channelId][remoteChainId] = peer;
        emit ChannelPeerSet(channelId, remoteChainId, peer);
    }

    // ─── Emergency pause ────────────────────────────────────────────────────

    /// @notice Freeze both the send and the receive path. Callable by the
    ///         guardian or the owner — the detect-to-freeze fast lever.
    function pause() external onlyGuardianOrOwner {
        _pause();
    }

    /// @notice Resume. Owner-only — recovery travels the governance path.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── UUPS / Ownable MRO ─────────────────────────────────────────────────

    /// @inheritdoc UUPSUpgradeable
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {}

    /// @dev `transferOwnership` is defined by both {OwnableUpgradeable} and
    ///      {Ownable2StepUpgradeable} (the latter reached via this
    ///      contract's inheritance of both {GuardianPausable} and
    ///      {Ownable2StepUpgradeable}); resolve to the two-step variant so
    ///      ownership handover is always pending-accept.
    function transferOwnership(
        address newOwner
    ) public override(OwnableUpgradeable, Ownable2StepUpgradeable) onlyOwner {
        Ownable2StepUpgradeable.transferOwnership(newOwner);
    }

    /// @dev MRO resolution for the internal counterpart of the above.
    function _transferOwnership(
        address newOwner
    ) internal override(OwnableUpgradeable, Ownable2StepUpgradeable) {
        Ownable2StepUpgradeable._transferOwnership(newOwner);
    }
}
