// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {GuardianPausable} from "./GuardianPausable.sol";
import {
    ICrossChainMessenger,
    ICrossChainMessageRecipient
} from "./ICrossChainMessenger.sol";

/// @dev Base-side Diamond ingress for an inbound REPORT.
interface IRewardAggregatorIngress {
    function onChainReportReceived(
        uint32 sourceChainId,
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18
    ) external;
}

/// @dev Mirror-side Diamond ingress for an inbound BROADCAST.
interface IRewardReporterIngress {
    function onRewardBroadcastReceived(
        uint256 dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18
    ) external;
}

/**
 * @title VaipakamRewardMessenger — cross-chain reward accounting on the
 *        CCIP seam (T-068 Phase 4)
 *
 * The CCIP successor to the LayerZero `VaipakamRewardOApp`. A **domain
 * contract**: it depends only on the {ICrossChainMessenger} port, never a
 * CCIP library. One instance is deployed per chain; all instances share
 * the `vpfi-reward` channel.
 *
 * Two data-only message flows (no tokens, no two-step — reward messages
 * carry scalar numeraire totals, not value):
 *  - **REPORT** (mirror → Base): `(dayId, lenderNumeraire18,
 *    borrowerNumeraire18)` — a mirror Diamond's closed-day totals. On
 *    Base it is forwarded to `onChainReportReceived`, tagged with the
 *    source chain id so the aggregator knows who reported.
 *  - **BROADCAST** (Base → every mirror): `(dayId, globalLender,
 *    globalBorrower)` — the finalised global denominator. Each mirror
 *    forwards it to `onRewardBroadcastReceived`.
 *
 * ── Trust ──────────────────────────────────────────────────────────────
 * The sender-side methods are callable only by the paired {diamond}.
 * {onCrossChainMessage} is callable only by the registered {messenger},
 * which has already authenticated the CCIP source + channel peer; on top
 * of that a strict payload-length pin rejects any padded/forged packet.
 *
 * @dev UUPS-upgradeable; guardian + owner pause. The sender pays the
 *      cross-chain fee as `msg.value`; the exact quoted fee is forwarded
 *      and any remainder is returned to the caller-supplied refund
 *      address.
 */
contract VaipakamRewardMessenger is
    Initializable,
    Ownable2StepUpgradeable,
    GuardianPausable,
    ReentrancyGuardTransient,
    UUPSUpgradeable,
    ICrossChainMessageRecipient
{
    // ─── Constants ──────────────────────────────────────────────────────────

    /// @notice The {ICrossChainMessenger} channel id the reward flow runs
    ///         on (reference value — the live binding is a `CcipMessenger`
    ///         config).
    bytes32 internal constant VPFI_REWARD_CHANNEL =
        keccak256("vaipakam.ccip.channel.vpfi-reward");

    /// @notice Payload kind: mirror → Base closed-day report.
    uint8 internal constant MSG_TYPE_REPORT = 1;
    /// @notice Payload kind: Base → mirrors finalised-denominator broadcast.
    uint8 internal constant MSG_TYPE_BROADCAST = 2;

    /// @notice Canonical payload size — `abi.encode(uint8, uint256,
    ///         uint256, uint256)` is always four 32-byte words. A strict
    ///         length pin on the inbound path rejects a padded packet
    ///         (`abi.decode` would otherwise ignore trailing bytes).
    uint256 internal constant EXPECTED_PAYLOAD_SIZE = 4 * 32;

    // ─── Storage ────────────────────────────────────────────────────────────

    /// @notice The cross-chain messaging port.
    address public messenger;

    /// @notice The Vaipakam Diamond on this chain — the only caller of the
    ///         sender-side methods, and the forward target on receive.
    address public diamond;

    /// @notice True iff this instance is on the canonical reward chain
    ///         (Base). Governs which inbound kind is accepted.
    bool public isCanonical;

    /// @notice EVM chain id of the canonical chain — the REPORT
    ///         destination. Zero on the canonical instance.
    uint256 public baseChainId;

    /// @notice Mirror chain ids broadcast-to from the canonical instance.
    uint256[] public broadcastDestinationChainIds;

    /// @notice Gas allowed for the destination Diamond-ingress callback.
    uint256 public destGasLimit;

    /// @dev Reserved storage for upgrade-safe appends.
    uint256[44] private _gap;

    // ─── Events ─────────────────────────────────────────────────────────────

    /// @custom:event-category informational/config
    event MessengerSet(address indexed previousMessenger, address indexed newMessenger);
    /// @custom:event-category informational/config
    event DiamondSet(address indexed previousDiamond, address indexed newDiamond);
    /// @custom:event-category informational/config
    event CanonicalFlagSet(bool isCanonical);
    /// @custom:event-category informational/config
    event BaseChainIdSet(uint256 previousChainId, uint256 newChainId);
    /// @custom:event-category informational/config
    event BroadcastDestinationsSet(uint256[] chainIds);
    /// @custom:event-category informational/config
    event DestGasLimitSet(uint256 previousLimit, uint256 newLimit);

    /// @custom:event-category informational/reward-transport
    event ReportSent(
        bytes32 indexed messageId,
        uint256 indexed dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18
    );
    /// @custom:event-category informational/reward-transport
    event BroadcastSent(
        bytes32 indexed messageId,
        uint256 indexed destinationChainId,
        uint256 indexed dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18
    );
    /// @custom:event-category informational/reward-transport
    event ReportReceived(
        uint256 indexed sourceChainId,
        uint256 indexed dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18
    );
    /// @custom:event-category informational/reward-transport
    event BroadcastReceived(
        uint256 indexed sourceChainId,
        uint256 indexed dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18
    );

    // ─── Errors ─────────────────────────────────────────────────────────────

    error ZeroAddress();
    error MessengerNotSet();
    /// @notice A sender-side method was called by an address other than
    ///         the paired {diamond}.
    error OnlyDiamond();
    /// @notice {onCrossChainMessage} called by an address other than the
    ///         registered {messenger}.
    error NotMessenger(address caller);
    /// @notice `baseChainId` is unset on a mirror instance.
    error BaseChainNotConfigured();
    /// @notice The broadcast destination list is empty.
    error NoBroadcastDestinations();
    /// @notice A REPORT arrived on a mirror instance (only canonical
    ///         accepts REPORTs).
    error ReportOnMirror();
    /// @notice A BROADCAST arrived on the canonical instance (only
    ///         mirrors accept BROADCASTs).
    error BroadcastOnCanonical();
    /// @notice Unknown payload msgType.
    error UnknownMessageType(uint8 msgType);
    /// @notice Inbound payload length is not the canonical 4-word shape.
    error PayloadSizeMismatch(uint256 got, uint256 expected);
    /// @notice `msg.value` did not cover the quoted cross-chain fee.
    error InsufficientFee(uint256 provided, uint256 required);
    /// @notice The fee-remainder refund to the supplied address failed.
    error RefundFailed();
    /// @notice The inbound source chain id does not fit the `uint32`
    ///         origin tag the reward aggregator expects.
    error ChainIdTooLarge(uint256 sourceChainId);
    /// @notice A reward message arrived carrying CCIP tokens. The reward
    ///         channel is data-only — this contract has no token-recovery
    ///         path, so a token-bearing message is rejected (CCIP records
    ///         it failed + re-executable) rather than stranding assets.
    error UnexpectedTokens(uint256 count);

    // ─── Construction ───────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy.
    /// @param owner_        Owner (admin multi-sig → governance).
    /// @param messenger_    The {ICrossChainMessenger} deployment.
    /// @param diamond_      The Vaipakam Diamond on this chain.
    /// @param isCanonical_  True iff this instance is on Base.
    /// @param baseChainId_  EVM chain id of Base (0 on the canonical one).
    /// @param destGasLimit_ Gas for the destination Diamond callback.
    function initialize(
        address owner_,
        address messenger_,
        address diamond_,
        bool isCanonical_,
        uint256 baseChainId_,
        uint256 destGasLimit_
    ) external initializer {
        if (
            owner_ == address(0) || messenger_ == address(0)
                || diamond_ == address(0)
        ) {
            revert ZeroAddress();
        }
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __GuardianPausable_init();

        messenger = messenger_;
        diamond = diamond_;
        isCanonical = isCanonical_;
        baseChainId = baseChainId_;
        destGasLimit = destGasLimit_;

        emit MessengerSet(address(0), messenger_);
        emit DiamondSet(address(0), diamond_);
        emit CanonicalFlagSet(isCanonical_);
        emit BaseChainIdSet(0, baseChainId_);
        emit DestGasLimitSet(0, destGasLimit_);
    }

    // ─── Modifiers ──────────────────────────────────────────────────────────

    modifier onlyDiamond() {
        if (msg.sender != diamond) revert OnlyDiamond();
        _;
    }

    // ─── Sender side ────────────────────────────────────────────────────────

    /// @notice Send a closed-day REPORT from a mirror chain to Base.
    /// @dev Diamond-only. The exact quoted fee is forwarded; any
    ///      `msg.value` remainder returns to `refundAddress`.
    function sendChainReport(
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        address payable refundAddress
    ) external payable onlyDiamond whenNotPaused nonReentrant {
        if (messenger == address(0)) revert MessengerNotSet();
        if (baseChainId == 0) revert BaseChainNotConfigured();

        bytes memory payload = abi.encode(
            MSG_TYPE_REPORT, dayId, lenderNumeraire18, borrowerNumeraire18
        );
        bytes32 messageId =
            _dispatch(baseChainId, payload, msg.value, refundAddress);

        emit ReportSent(
            messageId, dayId, lenderNumeraire18, borrowerNumeraire18
        );
    }

    /// @notice Broadcast the finalised global denominator from Base to
    ///         every configured mirror.
    /// @dev Diamond-only. `msg.value` must cover the SUM of the per-lane
    ///      quotes (see {quoteBroadcastGlobal}); the remainder is refunded.
    ///
    ///      Slither flags the function as a whole with `msg-value-loop`
    ///      because `msg.value` is read inside the per-destination
    ///      for-loop. The pattern is intentional and bounded: the
    ///      `spent` cumulator plus the pre-iter `msg.value - spent < fee`
    ///      check make the total outflow ≤ `msg.value`, and the surplus
    ///      is refunded after the loop. The per-statement suppression
    ///      below silences the inner-statement match; this start/end
    ///      block silences the function-level match so the Code
    ///      Scanning queue stays clean. Removing the loop would mean N
    ///      separate operator txs for one global report — strictly
    ///      worse UX with no safety gain.
    // slither-disable-start msg-value-loop
    function broadcastGlobal(
        uint256 dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18,
        address payable refundAddress
    ) external payable onlyDiamond whenNotPaused nonReentrant {
        if (messenger == address(0)) revert MessengerNotSet();
        uint256 n = broadcastDestinationChainIds.length;
        if (n == 0) revert NoBroadcastDestinations();

        bytes memory payload = abi.encode(
            MSG_TYPE_BROADCAST,
            dayId,
            globalLenderNumeraire18,
            globalBorrowerNumeraire18
        );

        uint256 spent;
        for (uint256 i; i < n; ++i) {
            uint256 dst = broadcastDestinationChainIds[i];
            uint256 fee = ICrossChainMessenger(messenger).quoteMessageFee(
                dst, payload, _noTokens(), destGasLimit
            );
            if (msg.value - spent < fee) {
                revert InsufficientFee(msg.value - spent, fee);
            }
            // Slither flags this loop body as `msg-value-loop` /
            // `arbitrary-send-eth`. The per-iter `fee` is the exact value
            // just re-quoted from `messenger`, and the recipient is the
            // admin-set CCIP adapter (rotated via owner-only
            // `setMessenger`). The `spent` cumulator + `msg.value`
            // pre-check bound total outflow. Not a vuln.
            // slither-disable-next-line arbitrary-send-eth,msg-value-loop
            bytes32 messageId = ICrossChainMessenger(messenger).sendMessage{
                value: fee
            }(dst, payload, _noTokens(), destGasLimit);
            spent += fee;

            emit BroadcastSent(
                messageId,
                dst,
                dayId,
                globalLenderNumeraire18,
                globalBorrowerNumeraire18
            );
        }

        _refund(refundAddress, msg.value - spent);
    }
    // slither-disable-end msg-value-loop

    /// @notice Quote the fee for a {sendChainReport}.
    function quoteSendChainReport(
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18
    ) external view returns (uint256 nativeFee) {
        if (baseChainId == 0) revert BaseChainNotConfigured();
        bytes memory payload = abi.encode(
            MSG_TYPE_REPORT, dayId, lenderNumeraire18, borrowerNumeraire18
        );
        nativeFee = ICrossChainMessenger(messenger).quoteMessageFee(
            baseChainId, payload, _noTokens(), destGasLimit
        );
    }

    /// @notice Quote the total fee for a {broadcastGlobal} (sum over every
    ///         destination).
    function quoteBroadcastGlobal(
        uint256 dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18
    ) external view returns (uint256 nativeFee) {
        uint256 n = broadcastDestinationChainIds.length;
        bytes memory payload = abi.encode(
            MSG_TYPE_BROADCAST,
            dayId,
            globalLenderNumeraire18,
            globalBorrowerNumeraire18
        );
        for (uint256 i; i < n; ++i) {
            nativeFee += ICrossChainMessenger(messenger).quoteMessageFee(
                broadcastDestinationChainIds[i],
                payload,
                _noTokens(),
                destGasLimit
            );
        }
    }

    // ─── Inbound — the {ICrossChainMessageRecipient} port ───────────────────

    /// @inheritdoc ICrossChainMessageRecipient
    function onCrossChainMessage(
        uint256 sourceChainId,
        address /* sourceSender */,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens
    ) external override whenNotPaused nonReentrant {
        if (msg.sender != messenger) revert NotMessenger(msg.sender);
        // The reward channel is data-only. The messenger forwards any
        // attached tokens to this contract before the callback, and this
        // contract has no recovery path — reject a token-bearing message
        // so CCIP marks it failed + re-executable instead of stranding it.
        if (tokens.length != 0) revert UnexpectedTokens(tokens.length);
        if (payload.length != EXPECTED_PAYLOAD_SIZE) {
            revert PayloadSizeMismatch(payload.length, EXPECTED_PAYLOAD_SIZE);
        }

        (uint8 msgType, uint256 dayId, uint256 a, uint256 b) =
            abi.decode(payload, (uint8, uint256, uint256, uint256));

        if (msgType == MSG_TYPE_REPORT) {
            if (!isCanonical) revert ReportOnMirror();
            // The aggregator tags each report with a uint32 origin chain.
            // A wider source id is an operator misconfiguration — reject
            // it rather than let a silent truncation misattribute the
            // report (and corrupt per-chain reward accounting) onto
            // another chain.
            if (sourceChainId > type(uint32).max) {
                revert ChainIdTooLarge(sourceChainId);
            }
            emit ReportReceived(sourceChainId, dayId, a, b);
            IRewardAggregatorIngress(diamond).onChainReportReceived(
                uint32(sourceChainId), dayId, a, b
            );
        } else if (msgType == MSG_TYPE_BROADCAST) {
            if (isCanonical) revert BroadcastOnCanonical();
            emit BroadcastReceived(sourceChainId, dayId, a, b);
            IRewardReporterIngress(diamond).onRewardBroadcastReceived(
                dayId, a, b
            );
        } else {
            revert UnknownMessageType(msgType);
        }
    }

    // ─── Internal helpers ───────────────────────────────────────────────────

    /// @dev Send one data-only message: quote, forward the exact fee,
    ///      refund the remainder to `refundAddress`.
    function _dispatch(
        uint256 destinationChainId,
        bytes memory payload,
        uint256 budget,
        address payable refundAddress
    ) internal returns (bytes32 messageId) {
        uint256 fee = ICrossChainMessenger(messenger).quoteMessageFee(
            destinationChainId, payload, _noTokens(), destGasLimit
        );
        if (budget < fee) revert InsufficientFee(budget, fee);
        // `messenger` is the admin-set CCIP adapter (rotated via
        // owner-only `setMessenger`), and `fee` is the exact value just
        // re-quoted from that same contract.
        // slither-disable-next-line arbitrary-send-eth
        messageId = ICrossChainMessenger(messenger).sendMessage{value: fee}(
            destinationChainId, payload, _noTokens(), destGasLimit
        );
        _refund(refundAddress, budget - fee);
    }

    /// @dev Return an unused fee remainder.
    function _refund(address payable to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert RefundFailed();
    }

    /// @dev Empty token list — every reward message is data-only.
    function _noTokens()
        internal
        pure
        returns (ICrossChainMessenger.TokenAmount[] memory)
    {
        return new ICrossChainMessenger.TokenAmount[](0);
    }

    // ─── Emergency pause ────────────────────────────────────────────────────

    /// @notice Pause the sender and inbound paths. Guardian or owner.
    function pause() external onlyGuardianOrOwner {
        _pause();
    }

    /// @notice Resume. Owner-only.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── Admin ──────────────────────────────────────────────────────────────

    function setMessenger(address newMessenger) external onlyOwner {
        if (newMessenger == address(0)) revert ZeroAddress();
        emit MessengerSet(messenger, newMessenger);
        messenger = newMessenger;
    }

    function setDiamond(address newDiamond) external onlyOwner {
        if (newDiamond == address(0)) revert ZeroAddress();
        emit DiamondSet(diamond, newDiamond);
        diamond = newDiamond;
    }

    function setIsCanonical(bool on) external onlyOwner {
        isCanonical = on;
        emit CanonicalFlagSet(on);
    }

    function setBaseChainId(uint256 newChainId) external onlyOwner {
        emit BaseChainIdSet(baseChainId, newChainId);
        baseChainId = newChainId;
    }

    /// @notice Replace the broadcast destination chain-id list. Each id
    ///         must also have its channel peer configured on the
    ///         `CcipMessenger` before the first broadcast.
    function setBroadcastDestinations(
        uint256[] calldata chainIds
    ) external onlyOwner {
        broadcastDestinationChainIds = chainIds;
        emit BroadcastDestinationsSet(chainIds);
    }

    function setDestGasLimit(uint256 newLimit) external onlyOwner {
        emit DestGasLimitSet(destGasLimit, newLimit);
        destGasLimit = newLimit;
    }

    /// @notice The configured broadcast destinations — for ops wiring
    ///         verification.
    function getBroadcastDestinations()
        external
        view
        returns (uint256[] memory)
    {
        return broadcastDestinationChainIds;
    }

    /// @dev Accept native funds — fee-remainder dust / ops top-ups.
    receive() external payable {}

    // ─── UUPS / Ownable MRO ─────────────────────────────────────────────────

    /// @inheritdoc UUPSUpgradeable
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {}

    /// @dev Resolve the `transferOwnership` clash between
    ///      {OwnableUpgradeable} (via {GuardianPausable}) and
    ///      {Ownable2StepUpgradeable} to the two-step variant.
    function transferOwnership(
        address newOwner
    ) public override(OwnableUpgradeable, Ownable2StepUpgradeable) onlyOwner {
        Ownable2StepUpgradeable.transferOwnership(newOwner);
    }

    /// @dev MRO resolution for the internal counterpart.
    function _transferOwnership(
        address newOwner
    ) internal override(OwnableUpgradeable, Ownable2StepUpgradeable) {
        Ownable2StepUpgradeable._transferOwnership(newOwner);
    }
}
