// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {GuardianPausable} from "./GuardianPausable.sol";
import {ReturnWire} from "./ReturnWire.sol";
import {
    ICrossChainMessenger,
    ICrossChainMessageRecipient
} from "./ICrossChainMessenger.sol";

/// @dev The Base Diamond's Mode-A repatriation ingresses (#1568 C2 part 1).
///      Both are gated on the caller being THIS contract (the configured
///      `repatriationReceiver`), and both re-verify the era
///      (`issuingBase == diamond`) and the authorization's source binding —
///      this satellite authenticates the transport, the Diamond
///      authenticates the lifecycle.
interface IRepatriationReturnIngress {
    function onRepatriationReturnReceived(
        uint256 authId,
        address issuingBase,
        uint32 sourceChainId,
        address token,
        uint256 declaredAmount,
        uint256 actualReceived
    ) external;

    function onRepatriationCancelAck(
        uint256 authId,
        address issuingBase,
        uint32 sourceChainId
    ) external;
}

/// @notice #1434 P2-w5 — the Diamond's Mode-B stranded-return ingress: the
///         satellite authenticates the transport and forwards the tokens;
///         the Diamond authenticates the receipt lifecycle (era, chain
///         binding, entitlement bound, gate settlement).
interface IStrandedReturnIngress {
    function onStrandedReturnReceived(
        address remitter,
        uint256 remitId,
        uint256 dayId,
        uint32 sourceChainId,
        address token,
        uint256 declaredAmount,
        uint256 actualReceived
    ) external;
}

/**
 * @title VpfiReturnReceiver — #1568 C2 (mirror→Base VPFI return channel, receive leg)
 *
 * Base-side UUPS satellite that owns the INBOUND leg of the shared
 * `vpfi-return` channel and dispatches each delivery BY PAYLOAD KIND — the
 * kind IS the mode discriminator (owner ratification 2026-08-07,
 * `VpfiCrossChainRecyclingDesign.md` §3.6a): the Mode-A return kind selects
 * the settlement ingress, the Mode-A cancel-ACK kind selects the release
 * ingress, and a payload whose kind this receiver does not know REVERTS
 * deterministically (the {ReturnWire} keccak-tag property), leaving the
 * delivery failed-but-re-executable for after the receiver is upgraded.
 * Mode B (#1434 R4) adds its own kind and branch here later; the channel is
 * shared, the wire protocols are not.
 *
 * Trust + behaviour (the {BuybackRemittanceReceiver} posture):
 *   - `onCrossChainMessage` is callable only by the registered {messenger},
 *     which has already authenticated the CCIP source chain + channel peer.
 *   - A RETURN delivery carries exactly one `TokenAmount` whose amount must
 *     equal the payload-declared amount; the tokens are forwarded to the
 *     Diamond BEFORE the ingress call and credited from the Diamond's
 *     actual balance delta (fee-on-transfer safe). Token identity and the
 *     exact-match against the authorization are enforced by the Diamond
 *     ingress, which knows the local VPFI and the authorization record.
 *   - A CANCEL-ACK delivery is data-only; any attached token is rejected.
 *
 * @dev UUPS-upgradeable; guardian + owner pause. Holds no native funds.
 */
contract VpfiReturnReceiver is
    Initializable,
    Ownable2StepUpgradeable,
    GuardianPausable,
    ReentrancyGuardTransient,
    UUPSUpgradeable,
    ICrossChainMessageRecipient
{
    using SafeERC20 for IERC20;

    // ─── Storage ──────────────────────────────────────────────────────

    /// @notice The {ICrossChainMessenger} adapter on the canonical chain.
    address public messenger;
    /// @notice The Vaipakam Diamond on the canonical chain — the credit
    ///         target and the lifecycle authority.
    address public diamond;

    /// @dev Reserved storage for upgrade-safe appends.
    // forge-lint: disable-next-line(mixed-case-variable)
    uint256[48] private __gap;

    // ─── Events ───────────────────────────────────────────────────────

    /// @custom:event-category informational/config
    event MessengerSet(address indexed previousMessenger, address indexed newMessenger);
    /// @custom:event-category informational/config
    event DiamondSet(address indexed previousDiamond, address indexed newDiamond);
    /// @custom:event-category informational/reward-transport
    event RepatriationReturnForwarded(
        uint256 indexed sourceChainId,
        uint256 indexed authId,
        address token,
        uint256 actualReceived
    );
    /// @custom:event-category informational/reward-transport
    event RepatriationCancelAckForwarded(
        uint256 indexed sourceChainId,
        uint256 indexed authId
    );
    /// @custom:event-category informational/reward-transport
    event StrandedReturnForwarded(
        uint256 indexed sourceChainId,
        address indexed remitter,
        uint256 indexed remitId,
        address token,
        uint256 actualReceived
    );

    // ─── Errors ───────────────────────────────────────────────────────

    error ZeroAddress();
    error NotAContract(address candidate);
    error NotMessenger(address caller);
    /// @notice Payload kind is not one this receiver decodes — a later wire
    ///         generation delivered before the upgrade. The revert keeps the
    ///         CCIP message failed-but-re-executable (fail-closed rollout).
    error UnknownReturnWireKind(uint256 head);
    error PayloadSizeMismatch(uint256 got, uint256 want);
    error WrongTokenCount(uint256 got);
    /// @notice Delivered amount disagrees with the payload's declared amount.
    error AmountMismatch(uint256 declared, uint256 delivered);
    error ZeroAmount();
    /// @notice CCIP source chain id exceeds the ledger's uint32 chain-id
    ///         domain — an operator misconfiguration; reject rather than
    ///         silently truncate onto another chain's authorization.
    error ChainIdTooLarge(uint256 chainId);

    // ─── Construction ─────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy.
    /// @param owner_     Owner (admin multi-sig → governance timelock).
    /// @param messenger_ The {ICrossChainMessenger} deployment on this chain.
    /// @param diamond_   The Vaipakam Diamond on this chain.
    function initialize(
        address owner_,
        address messenger_,
        address diamond_
    ) external initializer {
        if (
            owner_ == address(0) ||
            messenger_ == address(0) ||
            diamond_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (messenger_.code.length == 0) revert NotAContract(messenger_);
        if (diamond_.code.length == 0) revert NotAContract(diamond_);
        __Ownable_init(owner_);
        __Ownable2Step_init();
        _guardianPausableInit();

        messenger = messenger_;
        diamond = diamond_;

        emit MessengerSet(address(0), messenger_);
        emit DiamondSet(address(0), diamond_);
    }

    // ─── Inbound — the {ICrossChainMessageRecipient} port ─────────────

    /// @inheritdoc ICrossChainMessageRecipient
    function onCrossChainMessage(
        uint256 sourceChainId,
        // Deliberately unused (#1426 r4): the adapter derives this from its
        // delivery-time channel-peer CONFIG, so it cannot identify the
        // sending DEPLOYMENT for a delayed pre-rotation packet. The issuing
        // deployment rides IN the payload (`issuingBase` — immutable message
        // data), and the Diamond ingress binds to it.
        address /* sourceSender */,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens
    ) external override whenNotPaused nonReentrant {
        if (msg.sender != messenger) revert NotMessenger(msg.sender);
        if (sourceChainId > type(uint32).max) {
            revert ChainIdTooLarge(sourceChainId);
        }
        if (payload.length < 32) revert PayloadSizeMismatch(payload.length, 32);

        uint256 head = abi.decode(payload[:32], (uint256));
        if (head == ReturnWire.RETURN_WIRE_TAG_REPAT_A1) {
            _handleRepatReturn(uint32(sourceChainId), payload, tokens);
        } else if (head == ReturnWire.RETURN_WIRE_TAG_REPAT_CANCEL_ACK_A1) {
            _handleRepatCancelAck(uint32(sourceChainId), payload, tokens);
        } else if (head == ReturnWire.RETURN_WIRE_TAG_STRANDED_B1) {
            _handleStrandedReturn(uint32(sourceChainId), payload, tokens);
        } else {
            // Fail-closed rollout (the {ReturnWire} property): an unknown
            // keccak tag can never be coerced into a known shape, and the
            // revert leaves the CCIP delivery re-executable once this
            // receiver is upgraded with the new kind's branch.
            revert UnknownReturnWireKind(head);
        }
    }

    // ─── Kind handlers ────────────────────────────────────────────────

    /// @dev Mode-A RETURN: one token, declared == delivered, balance-delta
    ///      forward to the Diamond, then the settlement ingress.
    function _handleRepatReturn(
        uint32 sourceChainId,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens
    ) internal {
        if (payload.length != 4 * 32) {
            revert PayloadSizeMismatch(payload.length, 4 * 32);
        }
        if (tokens.length != 1) revert WrongTokenCount(tokens.length);
        (, address issuingBase, uint256 authId, uint256 declaredAmount) =
            abi.decode(payload, (uint256, address, uint256, uint256));

        address deliveredToken = tokens[0].token;
        uint256 deliveredAmount = tokens[0].amount;
        if (deliveredAmount != declaredAmount) {
            revert AmountMismatch(declaredAmount, deliveredAmount);
        }
        if (deliveredAmount == 0) revert ZeroAmount();

        // Fee-on-transfer safety (the remittance-receiver idiom): spend what
        // this contract actually holds and report what actually lands in the
        // Diamond. VPFI is a standard token, so this is normally exact; a
        // short actual is settled by the Diamond at the declared amount with
        // the gap recorded as shortfall (§3.6a 6a/7 — the source debit never
        // silently resizes).
        uint256 spendable = IERC20(deliveredToken).balanceOf(address(this));
        if (spendable == 0) revert ZeroAmount();
        uint256 toTransfer = spendable < deliveredAmount
            ? spendable
            : deliveredAmount;

        uint256 diamondBalBefore = IERC20(deliveredToken).balanceOf(diamond);
        IERC20(deliveredToken).safeTransfer(diamond, toTransfer);
        uint256 actualReceived = IERC20(deliveredToken).balanceOf(diamond) -
            diamondBalBefore;
        if (actualReceived == 0) revert ZeroAmount();

        IRepatriationReturnIngress(diamond).onRepatriationReturnReceived(
            authId,
            issuingBase,
            sourceChainId,
            deliveredToken,
            declaredAmount,
            actualReceived
        );

        emit RepatriationReturnForwarded(
            sourceChainId, authId, deliveredToken, actualReceived
        );
    }

    /// @dev Mode-A CANCEL-ACK: data-only; any attached token is a malformed
    ///      send and is rejected (re-executable, never silently absorbed).
    function _handleRepatCancelAck(
        uint32 sourceChainId,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens
    ) internal {
        if (payload.length != 3 * 32) {
            revert PayloadSizeMismatch(payload.length, 3 * 32);
        }
        if (tokens.length != 0) revert WrongTokenCount(tokens.length);
        (, address issuingBase, uint256 authId) =
            abi.decode(payload, (uint256, address, uint256));

        IRepatriationReturnIngress(diamond).onRepatriationCancelAck(
            authId,
            issuingBase,
            sourceChainId
        );

        emit RepatriationCancelAckForwarded(sourceChainId, authId);
    }

    /// @dev #1434 P2-w5 — Mode-B STRANDED RETURN: one token, declared must
    ///      match the transport amount exactly (the mirror sends its
    ///      recorded outflow, never a caller figure), and the spendable /
    ///      balance-delta idiom reports what actually lands in the Diamond
    ///      — the entitlement bound and any shortfall accounting are the
    ///      Diamond ingress's job, not the transport's.
    function _handleStrandedReturn(
        uint32 sourceChainId,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens
    ) internal {
        if (payload.length != 5 * 32) {
            revert PayloadSizeMismatch(payload.length, 5 * 32);
        }
        if (tokens.length != 1) revert WrongTokenCount(tokens.length);
        (, address remitter, uint256 remitId, uint256 dayId, uint256 declaredAmount)
            = abi.decode(payload, (uint256, address, uint256, uint256, uint256));

        address deliveredToken = tokens[0].token;
        uint256 deliveredAmount = tokens[0].amount;
        if (deliveredAmount != declaredAmount) {
            revert AmountMismatch(declaredAmount, deliveredAmount);
        }
        if (deliveredAmount == 0) revert ZeroAmount();

        uint256 spendable = IERC20(deliveredToken).balanceOf(address(this));
        if (spendable == 0) revert ZeroAmount();
        uint256 toTransfer = spendable < deliveredAmount
            ? spendable
            : deliveredAmount;

        uint256 diamondBalBefore = IERC20(deliveredToken).balanceOf(diamond);
        IERC20(deliveredToken).safeTransfer(diamond, toTransfer);
        uint256 actualReceived = IERC20(deliveredToken).balanceOf(diamond) -
            diamondBalBefore;
        if (actualReceived == 0) revert ZeroAmount();

        IStrandedReturnIngress(diamond).onStrandedReturnReceived(
            remitter,
            remitId,
            dayId,
            sourceChainId,
            deliveredToken,
            declaredAmount,
            actualReceived
        );

        emit StrandedReturnForwarded(
            sourceChainId, remitter, remitId, deliveredToken, actualReceived
        );
    }

    // ─── Emergency pause ──────────────────────────────────────────────

    /// @notice Pause the inbound path. Guardian or owner.
    function pause() external onlyGuardianOrOwner {
        _pause();
    }

    /// @notice Resume. Owner-only.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── Admin ────────────────────────────────────────────────────────

    function setMessenger(address newMessenger) external onlyOwner {
        if (newMessenger == address(0)) revert ZeroAddress();
        if (newMessenger.code.length == 0) revert NotAContract(newMessenger);
        emit MessengerSet(messenger, newMessenger);
        messenger = newMessenger;
    }

    /// @notice Re-point the credit target. DRAIN FIRST (Codex #1618 r7):
    ///         a delayed return or cancellation ACK delivered after a
    ///         rotation still names the OLD issuing Diamond in its
    ///         payload, and the new Diamond refuses it with
    ///         `RepatriationWrongEra` — the era binding doing its job —
    ///         leaving the delivery failed against a target that will
    ///         never accept it. Settle or cancel-and-ACK every PENDING
    ///         authorization before rotating (the standing
    ///         receiver-rotation precondition every remittance receiver
    ///         shares; see CcipCutoverRunbook "Rotating a Diamond or a
    ///         pool under in-flight repatriations").
    function setDiamond(address newDiamond) external onlyOwner {
        if (newDiamond == address(0)) revert ZeroAddress();
        if (newDiamond.code.length == 0) revert NotAContract(newDiamond);
        emit DiamondSet(diamond, newDiamond);
        diamond = newDiamond;
    }

    // ─── UUPS / Ownable MRO ───────────────────────────────────────────

    /// @inheritdoc UUPSUpgradeable
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {}

    /// @dev Resolve the `transferOwnership` clash between {OwnableUpgradeable}
    ///      (via {GuardianPausable}) and {Ownable2StepUpgradeable}.
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
