// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts@4.8.3/token/ERC20/IERC20.sol";
import {IERC165} from "@openzeppelin/contracts@5.0.2/utils/introspection/IERC165.sol";
import {IEVM2AnyOnRampClient} from "@chainlink/contracts-ccip/contracts/interfaces/IEVM2AnyOnRampClient.sol";
import {IPoolV1} from "@chainlink/contracts-ccip/contracts/interfaces/IPool.sol";
import {IRouter} from "@chainlink/contracts-ccip/contracts/interfaces/IRouter.sol";
import {IAny2EVMMessageReceiver} from "@chainlink/contracts-ccip/contracts/interfaces/IAny2EVMMessageReceiver.sol";
import {ITokenAdminRegistry} from "@chainlink/contracts-ccip/contracts/interfaces/ITokenAdminRegistry.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {Internal} from "@chainlink/contracts-ccip/contracts/libraries/Internal.sol";
import {Pool} from "@chainlink/contracts-ccip/contracts/libraries/Pool.sol";

/**
 * @title  The local CCIP lane's two ramps — e2e only (#2516)
 * @notice What a two-node Anvil harness puts where Chainlink's DONs sit, and
 *         NOTHING else. Every other CCIP contract on each node is the real one
 *         from `lib/chainlink-ccip`: the `Router` (fee wrapping, token pulls,
 *         ramp authorization, `routeMessage`), the `RMNRemote` behind an
 *         `RMNProxy` (the curse checks both the router and the pools make),
 *         the `TokenAdminRegistry` with its `RegistryModuleOwnerCustom` (the
 *         CCT registration `ConfigureCcip` performs), and the stock VPFI
 *         `LockReleaseTokenPool` / `BurnMintTokenPool` (`DeployCrosschain`).
 *
 * @dev    WHY RAMPS ARE THE SEAM. A real lane's on-ramp quotes through a
 *         FeeQuoter that needs live price reports, and its off-ramp executes
 *         only messages a committing DON has rooted under OCR signatures and
 *         the RMN has blessed. Neither has a local operator. What the two
 *         contracts here keep is everything the protocol's own contracts can
 *         observe of a lane:
 *
 *           - {E2ELocalOnRamp} is the router's registered on-ramp for the one
 *             remote selector. It returns a fixed native fee (so the sender
 *             really pays it, wrapped, into the ramp), takes each token's pool
 *             from the registry and calls the pool's REAL `lockOrBurn` — which
 *             itself refuses any caller that is not the router's on-ramp — and
 *             emits the real `CCIPMessageSent` event with the
 *             `EVM2AnyRampMessage` the pool's answer completes.
 *           - {E2ELocalOffRamp} is the router's registered off-ramp for that
 *             selector. It executes a message the way OffRamp v1.6's
 *             `executeSingleMessage` does: each token through the registry's
 *             pool and the pool's REAL `releaseOrMint` (which checks the
 *             caller is a router off-ramp, the source pool is the configured
 *             remote pool, the RMN, and the inbound rate limit), the
 *             receiver's balance checked before and after, then the message
 *             through the router's REAL `routeMessage` with the gas limit the
 *             sender's extra args set. It accepts a message only from its
 *             relayer, only for its own lane, and only once.
 *
 *         The relayer is the harness's relay (`packages/anvil-harness`), which
 *         reads `CCIPMessageSent` from the SOURCE node's on-ramp and hands the
 *         message it carries, unchanged, to the destination's off-ramp. It
 *         never builds a message itself: what is delivered is what the source
 *         chain's contracts sent. That is the whole substitute for the DONs,
 *         and it is a trusted one — which is why these ramps exist only under
 *         `script/e2e/` and are deployed only onto a local Anvil node.
 *
 *         A receiver that fails is NOT swallowed: the off-ramp reverts with
 *         the receiver's own revert data, so the tokens it released are
 *         rolled back with it and the message stays executable — the state a
 *         real lane leaves a failed message in (manually re-executable), made
 *         loud for a test.
 */

/// @dev The real `Router`'s fee-token getter (not on `IRouter`).
interface IWrappedNativeSource {
    function getWrappedNative() external view returns (address);
}

/// @notice The lane's on-ramp (see the file header).
contract E2ELocalOnRamp is IEVM2AnyOnRampClient {
    error OnlyRouter(address caller);
    error WrongLane(uint64 destChainSelector);
    error FeeTokenNotWrappedNative(address feeToken);
    error NoPoolForToken(address token);

    /// The real OnRamp's event, byte-identical in signature.
    event CCIPMessageSent(
        uint64 indexed destChainSelector, uint64 indexed sequenceNumber, Internal.EVM2AnyRampMessage message
    );

    address public immutable router;
    ITokenAdminRegistry public immutable registry;
    uint64 public immutable localChainSelector;
    uint64 public immutable remoteChainSelector;
    /// @notice The native fee every message is quoted (and pays) on this lane.
    uint256 public immutable nativeFee;

    /// @notice The last sequence number used; the next message takes +1.
    uint64 public sequenceNumber;
    /// @notice Per-sender nonce, as the real NonceManager keeps one.
    mapping(address => uint64) public senderNonce;

    constructor(address router_, address registry_, uint64 localSelector_, uint64 remoteSelector_, uint256 nativeFee_) {
        router = router_;
        registry = ITokenAdminRegistry(registry_);
        localChainSelector = localSelector_;
        remoteChainSelector = remoteSelector_;
        nativeFee = nativeFee_;
    }

    /// @inheritdoc IEVM2AnyOnRampClient
    /// @dev The router has already replaced a native-fee `address(0)` with its
    ///      wrapped native, so that is the only fee token accepted.
    function getFee(uint64 destChainSelector, Client.EVM2AnyMessage calldata message)
        external
        view
        returns (uint256 fee)
    {
        if (destChainSelector != remoteChainSelector) revert WrongLane(destChainSelector);
        address wrapped = IWrappedNativeSource(router).getWrappedNative();
        if (message.feeToken != wrapped) revert FeeTokenNotWrappedNative(message.feeToken);
        return nativeFee;
    }

    /// @inheritdoc IEVM2AnyOnRampClient
    function getPoolBySourceToken(uint64 destChainSelector, IERC20 sourceToken) public view returns (IPoolV1) {
        if (destChainSelector != remoteChainSelector) revert WrongLane(destChainSelector);
        address pool = registry.getPool(address(sourceToken));
        if (pool == address(0)) revert NoPoolForToken(address(sourceToken));
        return IPoolV1(pool);
    }

    /// @inheritdoc IEVM2AnyOnRampClient
    function getSupportedTokens(uint64) external pure returns (address[] memory tokens) {
        return tokens;
    }

    /// @inheritdoc IEVM2AnyOnRampClient
    function forwardFromRouter(
        uint64 destChainSelector,
        Client.EVM2AnyMessage memory message,
        uint256 feeTokenAmount,
        address originalSender
    ) external returns (bytes32 messageId) {
        if (msg.sender != router) revert OnlyRouter(msg.sender);
        if (destChainSelector != remoteChainSelector) revert WrongLane(destChainSelector);

        Internal.EVM2AnyRampMessage memory m;
        m.header.sourceChainSelector = localChainSelector;
        m.header.destChainSelector = destChainSelector;
        m.header.sequenceNumber = ++sequenceNumber;
        m.header.nonce = ++senderNonce[originalSender];
        m.sender = originalSender;
        m.data = message.data;
        m.receiver = message.receiver;
        m.extraArgs = message.extraArgs;
        m.feeToken = message.feeToken;
        m.feeTokenAmount = feeTokenAmount;
        m.tokenAmounts = new Internal.EVM2AnyTokenTransfer[](message.tokenAmounts.length);

        // The router has already moved each token to its pool; the pool's own
        // `lockOrBurn` locks or burns it and names the destination token.
        for (uint256 i; i < message.tokenAmounts.length; ++i) {
            Client.EVMTokenAmount memory t = message.tokenAmounts[i];
            IPoolV1 pool = getPoolBySourceToken(destChainSelector, IERC20(t.token));
            Pool.LockOrBurnOutV1 memory out = pool.lockOrBurn(
                Pool.LockOrBurnInV1({
                    receiver: message.receiver,
                    remoteChainSelector: destChainSelector,
                    originalSender: originalSender,
                    amount: t.amount,
                    localToken: t.token
                })
            );
            m.tokenAmounts[i] = Internal.EVM2AnyTokenTransfer({
                sourcePoolAddress: address(pool),
                destTokenAddress: out.destTokenAddress,
                extraData: out.destPoolData,
                amount: t.amount,
                destExecData: ""
            });
        }

        // Unique per lane and sequence, and bound to the content.
        messageId = keccak256(abi.encode(localChainSelector, destChainSelector, m.header.sequenceNumber, m));
        m.header.messageId = messageId;
        emit CCIPMessageSent(destChainSelector, m.header.sequenceNumber, m);
    }
}

/// @notice The lane's off-ramp (see the file header).
contract E2ELocalOffRamp {
    error OnlyRelayer(address caller);
    error WrongLane(uint64 sourceChainSelector, uint64 destChainSelector);
    error AlreadyExecuted(bytes32 messageId);
    error NotACompatiblePool(address pool);
    error ReleaseOrMintBalanceMismatch(uint256 amountReleased, uint256 balancePre, uint256 balancePost);
    error UnsupportedExtraArgs(bytes4 tag);
    error ReceiverError(bytes returnData);

    /// The real OffRamp's event, with its state as a plain `uint8`
    /// (`Internal.MessageExecutionState`: 2 = SUCCESS).
    event ExecutionStateChanged(
        uint64 indexed sourceChainSelector,
        uint64 indexed sequenceNumber,
        bytes32 indexed messageId,
        bytes32 messageHash,
        uint8 state,
        bytes returnData,
        uint256 gasUsed
    );

    /// OffRamp v1.6's own constant: the gas the exact-gas call reserves.
    uint16 public constant GAS_FOR_CALL_EXACT_CHECK = 5_000;
    uint8 internal constant STATE_SUCCESS = 2;
    /// The destination gas limit a real lane applies when none is given.
    uint256 internal constant DEFAULT_GAS_LIMIT = 200_000;

    IRouter public immutable router;
    ITokenAdminRegistry public immutable registry;
    uint64 public immutable localChainSelector;
    uint64 public immutable remoteChainSelector;
    /// @notice The only account that may hand this ramp a message: the
    ///         harness relay's key (see the file header).
    address public immutable relayer;

    mapping(bytes32 => bool) public executed;

    constructor(address router_, address registry_, uint64 localSelector_, uint64 remoteSelector_, address relayer_) {
        router = IRouter(router_);
        registry = ITokenAdminRegistry(registry_);
        localChainSelector = localSelector_;
        remoteChainSelector = remoteSelector_;
        relayer = relayer_;
    }

    /// @notice Execute one message the remote on-ramp emitted, unchanged.
    function execute(Internal.EVM2AnyRampMessage calldata m) external {
        if (msg.sender != relayer) revert OnlyRelayer(msg.sender);
        if (m.header.sourceChainSelector != remoteChainSelector || m.header.destChainSelector != localChainSelector) {
            revert WrongLane(m.header.sourceChainSelector, m.header.destChainSelector);
        }
        bytes32 id = m.header.messageId;
        if (executed[id]) revert AlreadyExecuted(id);
        executed[id] = true;

        address receiver = abi.decode(m.receiver, (address));
        Client.EVMTokenAmount[] memory destTokenAmounts = new Client.EVMTokenAmount[](m.tokenAmounts.length);
        for (uint256 i; i < m.tokenAmounts.length; ++i) {
            destTokenAmounts[i] = _releaseOrMint(m.tokenAmounts[i], m.sender, receiver);
        }

        uint256 gasUsed;
        bytes memory ret;
        // As OffRamp v1.6: a receiver that is not a contract, or does not
        // declare the CCIP receiver interface, gets its tokens and no call.
        if (receiver.code.length != 0 && _supportsReceiver(receiver)) {
            Client.Any2EVMMessage memory any2Evm = Client.Any2EVMMessage({
                messageId: id,
                sourceChainSelector: m.header.sourceChainSelector,
                sender: abi.encode(m.sender),
                data: m.data,
                destTokenAmounts: destTokenAmounts
            });
            bool success;
            (success, ret, gasUsed) =
                router.routeMessage(any2Evm, GAS_FOR_CALL_EXACT_CHECK, _gasLimit(m.extraArgs), receiver);
            if (!success) revert ReceiverError(ret);
        }
        emit ExecutionStateChanged(
            m.header.sourceChainSelector, m.header.sequenceNumber, id, keccak256(abi.encode(m)), STATE_SUCCESS, ret, gasUsed
        );
    }

    /// @dev OffRamp v1.6's `_releaseOrMintSingleToken`, without its exact-gas
    ///      wrapping: the pool the registry names for the destination token,
    ///      its real `releaseOrMint`, and the receiver's balance checked to
    ///      have moved by exactly what the pool reports.
    function _releaseOrMint(Internal.EVM2AnyTokenTransfer calldata t, address originalSender, address receiver)
        private
        returns (Client.EVMTokenAmount memory)
    {
        address localToken = abi.decode(t.destTokenAddress, (address));
        address pool = registry.getPool(localToken);
        if (pool == address(0) || !IERC165(pool).supportsInterface(Pool.CCIP_POOL_V1)) revert NotACompatiblePool(pool);
        uint256 pre = IERC20(localToken).balanceOf(receiver);
        Pool.ReleaseOrMintOutV1 memory out = IPoolV1(pool).releaseOrMint(
            Pool.ReleaseOrMintInV1({
                originalSender: abi.encode(originalSender),
                remoteChainSelector: remoteChainSelector,
                receiver: receiver,
                sourceDenominatedAmount: t.amount,
                localToken: localToken,
                sourcePoolAddress: abi.encode(t.sourcePoolAddress),
                sourcePoolData: t.extraData,
                offchainTokenData: ""
            })
        );
        if (receiver != pool) {
            uint256 post = IERC20(localToken).balanceOf(receiver);
            if (post < pre || post - pre != out.destinationAmount) {
                revert ReleaseOrMintBalanceMismatch(out.destinationAmount, pre, post);
            }
        }
        return Client.EVMTokenAmount({token: localToken, amount: out.destinationAmount});
    }

    function _supportsReceiver(address receiver) private view returns (bool) {
        try IERC165(receiver).supportsInterface(type(IAny2EVMMessageReceiver).interfaceId) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    /// @dev The destination gas limit from the sender's extra args — the two
    ///      EVM forms `Client` defines.
    function _gasLimit(bytes calldata extraArgs) private pure returns (uint256) {
        // No extra args: the lane default a real FeeQuoter applies.
        if (extraArgs.length == 0) return DEFAULT_GAS_LIMIT;
        if (extraArgs.length < 4) revert UnsupportedExtraArgs(bytes4(0));
        bytes4 tag = bytes4(extraArgs[:4]);
        if (tag == Client.GENERIC_EXTRA_ARGS_V2_TAG) {
            return abi.decode(extraArgs[4:], (Client.GenericExtraArgsV2)).gasLimit;
        }
        if (tag == Client.EVM_EXTRA_ARGS_V1_TAG) {
            return abi.decode(extraArgs[4:], (Client.EVMExtraArgsV1)).gasLimit;
        }
        revert UnsupportedExtraArgs(tag);
    }
}
