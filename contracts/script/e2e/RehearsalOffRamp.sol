// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts@4.8.3/token/ERC20/IERC20.sol";
import {IERC165} from "@openzeppelin/contracts@5.0.2/utils/introspection/IERC165.sol";
import {IPoolV1} from "@chainlink/contracts-ccip/contracts/interfaces/IPool.sol";
import {IRouter} from "@chainlink/contracts-ccip/contracts/interfaces/IRouter.sol";
import {IAny2EVMMessageReceiver} from "@chainlink/contracts-ccip/contracts/interfaces/IAny2EVMMessageReceiver.sol";
import {ITokenAdminRegistry} from "@chainlink/contracts-ccip/contracts/interfaces/ITokenAdminRegistry.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {Pool} from "@chainlink/contracts-ccip/contracts/libraries/Pool.sol";
import {MessageV1Codec} from "./ccipV2/MessageV1Codec.sol";

/**
 * @title  The CCIP 2.0.0 on-ramp's message event, as the relay reads it
 * @notice `OnRamp 2.0.0`'s `CCIPMessageSent` and its `Receipt`, declared here
 *         so the harness relay decodes the event from a compiled ABI, never a
 *         hand-typed one. The signature is the deployed ramp's, byte for byte
 *         (Chainlink contracts-ccip 2.0.0, `onRamp/OnRamp.sol`).
 */
interface IOnRampV2Events {
    /// One fee receipt: a verifier, the token pool, the executor or the
    /// network fee, in that order.
    struct Receipt {
        address issuer;
        uint32 destGasLimit;
        uint32 destBytesOverhead;
        uint256 feeTokenAmount;
        bytes extraArgs;
    }

    event CCIPMessageSent(
        uint64 indexed destChainSelector,
        address indexed sender,
        bytes32 indexed messageId,
        address feeToken,
        uint256 tokenAmountBeforeTokenPoolFees,
        bytes encodedMessage,
        Receipt[] receipts,
        bytes[] verifierBlobs
    );
}

/**
 * @title  What the relay reads from the real ramps and router before install
 * @notice The views the harness relay calls on a fork's real CCIP contracts to
 *         find a lane's ramps, refuse any ramp version it was not built for,
 *         and read what the stand-in needs. Declared here, byte-compatible
 *         with the deployed contracts (`OnRamp 2.0.0`, `OffRamp 2.0.0`,
 *         `Router 1.2.0`), so the relay reads them through a compiled ABI.
 */
interface IRehearsalRampReads {
    struct OnRampDestChainConfig {
        address router;
        uint64 messageNumber;
        uint8 addressBytesLength;
        bool tokenReceiverAllowed;
        uint16 messageNetworkFeeUSDCents;
        uint16 tokenNetworkFeeUSDCents;
        uint32 baseExecutionGasCost;
        address defaultExecutor;
        address[] laneMandatedCCVs;
        address[] defaultCCVs;
        /// The destination off-ramp, raw (20 bytes on an EVM chain).
        bytes offRamp;
    }

    struct OffRampStaticConfig {
        uint64 localChainSelector;
        uint16 gasForCallExactCheck;
        address rmnRemote;
        address tokenAdminRegistry;
        uint32 maxGasBufferToUpdateState;
    }

    struct OffRampSourceChainConfig {
        address router;
        bool isEnabled;
        /// The source on-ramps, each abi-encoded (32 bytes on an EVM chain).
        bytes[] onRamps;
        address[] defaultCCVs;
        address[] laneMandatedCCVs;
    }

    struct RouterOffRamp {
        uint64 sourceChainSelector;
        address offRamp;
    }

    // Every ramp and the router.
    function typeAndVersion() external view returns (string memory);

    // OnRamp 2.0.0.
    function getDestChainConfig(uint64 destChainSelector) external view returns (OnRampDestChainConfig memory);

    // OffRamp 2.0.0.
    function getStaticConfig() external view returns (OffRampStaticConfig memory);
    function getSourceChainConfig(uint64 sourceChainSelector) external view returns (OffRampSourceChainConfig memory);

    // Router 1.2.0.
    function getOnRamp(uint64 destChainSelector) external view returns (address);
    function getOffRamps() external view returns (RouterOffRamp[] memory);
    function isOffRamp(uint64 sourceChainSelector, address offRamp) external view returns (bool);
}

/**
 * @dev The one `RMNRemote` read the stand-in makes: the source-chain curse
 *      `OffRamp 2.0.0` checks before it executes a message.
 */
interface IRMNRemoteCurse {
    function isCursed(bytes16 subject) external view returns (bool);
}

/**
 * @dev The 2.0.0 token pool interface, declared only so its ERC-165 id is the
 *      deployed one (the id is the XOR of exactly these six selectors). The
 *      stand-in calls `releaseOrMint` on a pool that declares it, as
 *      `OffRamp 2.0.0` does.
 */
interface IRehearsalPoolV2 {
    enum MessageDirection {
        Outbound,
        Inbound
    }

    struct TokenTransferFeeConfig {
        uint32 destGasOverhead;
        uint32 destBytesOverhead;
        uint32 finalityFeeUSDCents;
        uint32 fastFinalityFeeUSDCents;
        uint16 finalityTransferFeeBps;
        uint16 fastFinalityTransferFeeBps;
        bool isEnabled;
    }

    function lockOrBurn(Pool.LockOrBurnInV1 calldata lockOrBurnIn, bytes4 requestedFinalityConfig, bytes calldata tokenArgs)
        external
        returns (Pool.LockOrBurnOutV1 memory lockOrBurnOut, uint256 destTokenAmount);

    function releaseOrMint(Pool.ReleaseOrMintInV1 calldata releaseOrMintIn, bytes4 requestedFinalityConfig)
        external
        returns (Pool.ReleaseOrMintOutV1 memory releaseOrMintOut);

    function getRequiredCCVs(
        address localToken,
        uint64 remoteChainSelector,
        uint256 sourceAmount,
        bytes4 requestedFinalityConfig,
        bytes calldata extraData,
        MessageDirection direction
    ) external view returns (address[] memory requiredCCVs);

    function getTokenTransferFeeConfig(
        address localToken,
        uint64 destChainSelector,
        bytes4 requestedFinalityConfig,
        bytes calldata tokenArgs
    ) external view returns (TokenTransferFeeConfig memory feeConfig);

    function getFee(
        address localToken,
        uint64 destChainSelector,
        uint256 amount,
        address feeToken,
        bytes4 requestedFinalityConfig,
        bytes calldata tokenArgs
    )
        external
        view
        returns (uint256 feeUSDCents, uint32 destGasOverhead, uint32 destBytesOverhead, uint16 tokenFeeBps, bool isEnabled);

    function getRemoteToken(uint64 remoteChainSelector) external view returns (bytes memory);
}

/**
 * @title  The deploy rehearsal's off-ramp stand-in — harness only (#3892)
 * @notice What a deploy rehearsal puts at a fork's REAL `OffRamp 2.0.0`
 *         address so a message the real source on-ramp emitted can be
 *         delivered between two forks. Nothing else on either fork is
 *         replaced: the source router, on-ramp, fee logic and pool run as
 *         deployed, and on the destination the real router and the real pool
 *         check who delivers (`isOffRamp`, which names this address), the
 *         source pool, the curse and the inbound rate limit.
 *
 * @dev    HOW IT GETS THERE. The harness deploys this contract on the
 *         destination fork, then copies its runtime code (immutables
 *         included) over the code at the real off-ramp's address. So
 *         `address(this)` is the real off-ramp's address, and the storage it
 *         runs over is the real off-ramp's: its one record lives at a
 *         namespaced slot for that reason. The constructor values are read
 *         from the real off-ramp before its code is replaced.
 *
 *         WHAT IT KEEPS of `OffRamp 2.0.0`'s `execute` and
 *         `executeSingleMessage`: the message is the encoded bytes the source
 *         on-ramp emitted, decoded by the 2.0.0 codec, and its id is their
 *         hash; the destination selector, the source chain is not cursed
 *         on the real `RMNRemote` (the subject the real ramp checks), the
 *         addressed off-ramp (this address), the on-ramp (one the real off-ramp allowed for that
 *         source, recorded at install) and the lane (the router names this
 *         address for that source) are checked; the token goes through the
 *         registry's pool and the pool's real `releaseOrMint` (2.0.0 or 1.0
 *         interface, as the real ramp picks), with the token receiver's
 *         balance measured before and after; the receiver is called through
 *         the router's real `routeMessage` with the message's own
 *         `ccipReceiveGasLimit` and the real off-ramp's own exact-gas
 *         reserve, unless the message is a token-only transfer.
 *
 *         WHAT IT DOES NOT KEEP, and the rehearsal report says so: the
 *         verifiers' attestations (the messaging network's own verification),
 *         its delays and manual execution, the gas-limit override and the
 *         FAILURE state. A delivery that fails reverts here, with the
 *         receiver's or the pool's own error, so the relay reports a failed
 *         step instead of a message that silently sits failed.
 *
 *         It accepts a message only from the relay's key and only once. That
 *         trusted relayer is the whole substitute for the network, which is
 *         why this contract exists only under `script/e2e/` and is only ever
 *         installed on a local fork.
 */
contract RehearsalOffRamp {
    error OnlyRelayer(address caller);
    error WrongDestination(uint64 destChainSelector);
    error NotAddressedHere(bytes offRampAddress);
    error OnRampNotAllowed(uint64 sourceChainSelector, bytes onRampAddress);
    error LaneNotRouted(uint64 sourceChainSelector);
    error CursedByRMN(uint64 sourceChainSelector);
    error InvalidEVMAddress(bytes encodedAddress);
    error AlreadyExecuted(bytes32 messageId);
    error NotACompatiblePool(address pool);
    error TokenHandlingError(address token, bytes err);
    error ReceiverError(bytes returnData);

    /// `OffRamp 2.0.0`'s event, with its state as a plain `uint8`
    /// (`Internal.MessageExecutionState`: 2 = SUCCESS).
    event ExecutionStateChanged(
        uint64 indexed sourceChainSelector,
        uint64 indexed messageNumber,
        bytes32 indexed messageId,
        uint8 state,
        bytes returnData
    );

    /// @notice What the rehearsal report reads for each delivery: the gas the
    ///         receiver call was given (the message's own limit; 0 for a
    ///         token-only transfer, which calls no receiver) and what it used.
    event RehearsalDelivered(bytes32 indexed messageId, uint256 gasLimit, uint256 gasUsed, bool receiverCalled);

    /// @notice The on-ramps the installer allowed for a source chain, copied
    ///         from the real off-ramp's source chain config.
    event OnRampAllowed(uint64 indexed sourceChainSelector, bytes onRampAddress);

    uint8 internal constant STATE_SUCCESS = 2;

    /// @dev keccak256(abi.encode(uint256(keccak256("vaipakam.e2e.rehearsal.offramp")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_SLOT = 0xd134ccee4c0a112776a9845ce7dbd21cfb1bfb2b8bf878854ea2f41e1aae5200;

    /// @custom:storage-location erc7201:vaipakam.e2e.rehearsal.offramp
    struct RehearsalOffRampStorage {
        mapping(bytes32 messageId => bool) executed;
        mapping(uint64 sourceChainSelector => mapping(bytes32 onRampHash => bool)) onRampAllowed;
    }

    IRouter public immutable router;
    ITokenAdminRegistry public immutable registry;
    uint64 public immutable localChainSelector;
    /// @notice The real off-ramp's `gasForCallExactCheck`, read before install.
    uint16 public immutable gasForCallExactCheck;
    /// @notice The real off-ramp's `rmnRemote`, read before install. A source
    ///         chain it curses is refused before anything is delivered, as
    ///         `OffRamp 2.0.0` refuses it.
    IRMNRemoteCurse public immutable rmnRemote;
    /// @notice The only account that may hand this ramp a message or allow an
    ///         on-ramp: the harness relay's key.
    address public immutable relayer;

    constructor(
        address router_,
        address registry_,
        uint64 localChainSelector_,
        uint16 gasForCallExactCheck_,
        address rmnRemote_,
        address relayer_
    ) {
        router = IRouter(router_);
        registry = ITokenAdminRegistry(registry_);
        localChainSelector = localChainSelector_;
        gasForCallExactCheck = gasForCallExactCheck_;
        rmnRemote = IRMNRemoteCurse(rmnRemote_);
        relayer = relayer_;
    }

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert OnlyRelayer(msg.sender);
        _;
    }

    function _s() private pure returns (RehearsalOffRampStorage storage s) {
        bytes32 slot = STORAGE_SLOT;
        assembly {
            s.slot := slot
        }
    }

    /// @notice Whether the message with this id has been delivered here.
    function executed(bytes32 messageId) external view returns (bool) {
        return _s().executed[messageId];
    }

    /// @notice Whether `onRampAddress` (as the message carries it) is allowed
    ///         for `sourceChainSelector`.
    function isOnRampAllowed(uint64 sourceChainSelector, bytes calldata onRampAddress) external view returns (bool) {
        return _s().onRampAllowed[sourceChainSelector][keccak256(onRampAddress)];
    }

    /// @notice Record the on-ramps the real off-ramp allowed for a source,
    ///         read from its source chain config before install.
    function allowOnRamps(uint64 sourceChainSelector, bytes[] calldata onRampAddresses) external onlyRelayer {
        RehearsalOffRampStorage storage s = _s();
        for (uint256 i; i < onRampAddresses.length; ++i) {
            s.onRampAllowed[sourceChainSelector][keccak256(onRampAddresses[i])] = true;
            emit OnRampAllowed(sourceChainSelector, onRampAddresses[i]);
        }
    }

    /// @notice Deliver one message, as the source on-ramp emitted it.
    function execute(bytes calldata encodedMessage) external onlyRelayer {
        MessageV1Codec.MessageV1 memory message = MessageV1Codec._decodeMessageV1(encodedMessage);
        RehearsalOffRampStorage storage s = _s();

        if (message.destChainSelector != localChainSelector) revert WrongDestination(message.destChainSelector);
        if (rmnRemote.isCursed(bytes16(uint128(message.sourceChainSelector)))) {
            revert CursedByRMN(message.sourceChainSelector);
        }
        if (message.offRampAddress.length != 20 || address(bytes20(message.offRampAddress)) != address(this)) {
            revert NotAddressedHere(message.offRampAddress);
        }
        if (!s.onRampAllowed[message.sourceChainSelector][keccak256(message.onRampAddress)]) {
            revert OnRampNotAllowed(message.sourceChainSelector, message.onRampAddress);
        }
        if (!router.isOffRamp(message.sourceChainSelector, address(this))) {
            revert LaneNotRouted(message.sourceChainSelector);
        }
        if (message.receiver.length != 20) revert InvalidEVMAddress(message.receiver);

        bytes32 messageId = keccak256(encodedMessage);
        if (s.executed[messageId]) revert AlreadyExecuted(messageId);
        s.executed[messageId] = true;

        Client.EVMTokenAmount[] memory destTokenAmounts = new Client.EVMTokenAmount[](message.tokenTransfer.length);
        if (message.tokenTransfer.length != 0) {
            destTokenAmounts[0] = _releaseOrMint(message);
        }

        address receiver = address(bytes20(message.receiver));
        uint256 gasLimit = message.ccipReceiveGasLimit;
        bool tokenOnly = (message.data.length == 0 && gasLimit == 0) || receiver.code.length == 0
            || !_supportsReceiver(receiver);
        uint256 gasUsed;
        bytes memory returnData;
        if (!tokenOnly) {
            bool success;
            (success, returnData, gasUsed) = router.routeMessage(
                Client.Any2EVMMessage({
                    messageId: messageId,
                    sourceChainSelector: message.sourceChainSelector,
                    sender: message.sender,
                    data: message.data,
                    destTokenAmounts: destTokenAmounts
                }),
                gasForCallExactCheck,
                gasLimit,
                receiver
            );
            if (!success) revert ReceiverError(returnData);
        }

        emit ExecutionStateChanged(message.sourceChainSelector, message.messageNumber, messageId, STATE_SUCCESS, returnData);
        emit RehearsalDelivered(messageId, tokenOnly ? 0 : gasLimit, gasUsed, !tokenOnly);
    }

    /// @dev `OffRamp 2.0.0`'s `_releaseOrMintSingleToken`, plus the balance
    ///      measurement `executeSingleMessage` wraps around it.
    function _releaseOrMint(MessageV1Codec.MessageV1 memory message) private returns (Client.EVMTokenAmount memory out) {
        MessageV1Codec.TokenTransferV1 memory t = message.tokenTransfer[0];
        if (t.destTokenAddress.length != 20) revert InvalidEVMAddress(t.destTokenAddress);
        if (t.tokenReceiver.length != 20) revert InvalidEVMAddress(t.tokenReceiver);
        address localToken = address(bytes20(t.destTokenAddress));
        address tokenReceiver = address(bytes20(t.tokenReceiver));
        address pool = registry.getPool(localToken);
        if (pool == address(0)) revert NotACompatiblePool(pool);

        uint256 balancePre = _balanceOf(localToken, tokenReceiver);
        Pool.ReleaseOrMintInV1 memory input = Pool.ReleaseOrMintInV1({
            originalSender: message.sender,
            remoteChainSelector: message.sourceChainSelector,
            receiver: tokenReceiver,
            sourceDenominatedAmount: t.amount,
            localToken: localToken,
            sourcePoolAddress: t.sourcePoolAddress,
            sourcePoolData: t.extraData,
            offchainTokenData: ""
        });
        Pool.ReleaseOrMintOutV1 memory result;
        if (_supports(pool, type(IRehearsalPoolV2).interfaceId)) {
            try IRehearsalPoolV2(pool).releaseOrMint(input, message.finality) returns (Pool.ReleaseOrMintOutV1 memory r) {
                result = r;
            } catch (bytes memory err) {
                revert TokenHandlingError(localToken, err);
            }
        } else if (_supports(pool, Pool.CCIP_POOL_V1)) {
            try IPoolV1(pool).releaseOrMint(input) returns (Pool.ReleaseOrMintOutV1 memory r) {
                result = r;
            } catch (bytes memory err) {
                revert TokenHandlingError(localToken, err);
            }
        } else {
            revert NotACompatiblePool(pool);
        }

        out = Client.EVMTokenAmount({token: localToken, amount: result.destinationAmount});
        // A lock-release pool that is itself the receiver: trust its figure,
        // as the real ramp does. Otherwise the receiver's balance decides.
        if (tokenReceiver != pool) out.amount = _balanceOf(localToken, tokenReceiver) - balancePre;
    }

    function _balanceOf(address token, address who) private view returns (uint256) {
        try IERC20(token).balanceOf(who) returns (uint256 b) {
            return b;
        } catch (bytes memory err) {
            revert TokenHandlingError(token, err);
        }
    }

    function _supports(address target, bytes4 interfaceId) private view returns (bool) {
        try IERC165(target).supportsInterface(interfaceId) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    function _supportsReceiver(address receiver) private view returns (bool) {
        return _supports(receiver, type(IAny2EVMMessageReceiver).interfaceId);
    }
}
