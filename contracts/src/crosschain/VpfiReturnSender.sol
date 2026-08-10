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
import {ICrossChainMessenger} from "./ICrossChainMessenger.sol";

/**
 * @title VpfiReturnSender — #1568 C2 (mirror→Base VPFI return channel, send leg)
 *
 * Mirror-side UUPS satellite that owns the OUTBOUND leg of the shared
 * `vpfi-return` channel. It exists because `CcipMessenger.registerChannel`
 * binds one handler to one channel and each mirror Diamond is ALREADY the
 * buyback channel's handler — a Diamond-originated send would route to the
 * buyback receiver, and re-registering the Diamond reverts
 * `HandlerAlreadyBound` (§3.6a constraint 3; the authenticated-channel-
 * selection alternative was not taken, per the 2026-08-07 layered-split
 * ratification).
 *
 * The satellite is a pure TRANSPORT ESCROW, deliberately stateless about the
 * repatriation lifecycle: every lifecycle marker lives in Diamond storage
 * (§3.6a 5b/5c — a stateless handler has nothing to lose in a rotation), and
 * both send surfaces are callable ONLY by the local Diamond, whose
 * `executeRepatriation` / `sendRepatriationCancelAck` entry points enforce
 * the instruction-state machine before any send. Tokens pass through within
 * one transaction: the Diamond transfers the repatriated VPFI here, this
 * contract approves the exact amount to the messenger, and the messenger
 * pulls it in the same call — a failed send reverts the whole execution
 * atomically, so no escrow survives a failure.
 *
 * Mode B (#1434 R4) will add its own send surface with its own
 * {ReturnWire} kind — the channel is shared, the wire protocols are not.
 *
 * @dev UUPS-upgradeable; guardian + owner pause; exact-amount approvals only.
 */
/// @dev #1660 r1 - this satellite's WIRE GENERATION, file-level so the
///      in-place refresh script imports the same durable constant the
///      contract publishes (the receiver/messenger probe pattern).
///      Generation 2 = the B1 stranded-return send surface (#1434 P2-w5); a proxy
///      without the selector is generation 1.
uint256 constant VPFI_RETURN_SENDER_WIRE_GENERATION = 2;

contract VpfiReturnSender is
    Initializable,
    Ownable2StepUpgradeable,
    GuardianPausable,
    ReentrancyGuardTransient,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ─── Storage ──────────────────────────────────────────────────────

    /// @notice The {ICrossChainMessenger} adapter on this mirror chain.
    address public messenger;
    /// @notice The Vaipakam Diamond on this mirror chain — the only caller.
    address public diamond;
    /// @notice The local (mirror) VPFI token a repatriation returns.
    address public vpfiToken;
    /// @notice Gas forwarded to the Base-side receiver callback.
    uint256 public destGasLimit;

    /// @dev Reserved storage for upgrade-safe appends.
    // forge-lint: disable-next-line(mixed-case-variable)
    uint256[46] private __gap;

    /// @notice #1660 r1 - the durable upgrade probe the refresh script
    ///         generation-gates on.
    uint256 public constant WIRE_GENERATION =
        VPFI_RETURN_SENDER_WIRE_GENERATION;

    // ─── Events ───────────────────────────────────────────────────────

    /// @custom:event-category informational/config
    event MessengerSet(address indexed previousMessenger, address indexed newMessenger);
    /// @custom:event-category informational/config
    event DiamondSet(address indexed previousDiamond, address indexed newDiamond);
    /// @custom:event-category informational/config
    event VpfiTokenSet(address indexed previousToken, address indexed newToken);
    /// @custom:event-category informational/config
    event DestGasLimitSet(uint256 previousLimit, uint256 newLimit);
    /// @custom:event-category informational/reward-transport
    event RepatriationReturnSent(
        bytes32 indexed messageId,
        address indexed issuingBase,
        uint256 indexed authId,
        uint256 amount
    );
    /// @custom:event-category informational/reward-transport
    event RepatriationCancelAckSent(
        bytes32 indexed messageId,
        address indexed issuingBase,
        uint256 indexed authId
    );
    /// @custom:event-category informational/reward-transport
    event StrandedReturnSent(
        bytes32 indexed messageId,
        address indexed remitter,
        uint256 indexed remitId,
        uint256 dayId,
        uint256 amount
    );

    // ─── Errors ───────────────────────────────────────────────────────

    error ZeroAddress();
    error NotAContract(address candidate);
    error NotDiamond(address caller);
    error ZeroAmount();
    /// @notice The Diamond declared more than it delivered into escrow —
    ///         the send would pull tokens this contract does not hold.
    error InsufficientEscrow(uint256 declared, uint256 held);
    error InsufficientFee(uint256 provided, uint256 required);
    error RefundFailed();

    // ─── Construction ─────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy.
    /// @param owner_       Owner (admin multi-sig → governance timelock).
    /// @param messenger_   The {ICrossChainMessenger} deployment on this chain.
    /// @param diamond_     The Vaipakam Diamond on this chain.
    /// @param vpfiToken_   The local (mirror) VPFI token.
    /// @param destGasLimit_ Base-side receiver callback gas budget.
    ///
    /// @dev No destination is configured here (Codex #1618 r7): every
    ///      send takes its destination from the calling Diamond, which
    ///      just checked that lane's live capacity — a second copy in
    ///      this satellite could diverge from the lane that was checked.
    function initialize(
        address owner_,
        address messenger_,
        address diamond_,
        address vpfiToken_,
        uint256 destGasLimit_
    ) external initializer {
        if (
            owner_ == address(0) ||
            messenger_ == address(0) ||
            diamond_ == address(0) ||
            vpfiToken_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (messenger_.code.length == 0) revert NotAContract(messenger_);
        if (diamond_.code.length == 0) revert NotAContract(diamond_);
        if (vpfiToken_.code.length == 0) revert NotAContract(vpfiToken_);
        __Ownable_init(owner_);
        __Ownable2Step_init();
        _guardianPausableInit();

        messenger = messenger_;
        diamond = diamond_;
        vpfiToken = vpfiToken_;
        destGasLimit = destGasLimit_;

        emit MessengerSet(address(0), messenger_);
        emit DiamondSet(address(0), diamond_);
        emit VpfiTokenSet(address(0), vpfiToken_);
        emit DestGasLimitSet(0, destGasLimit_);
    }

    // ─── Send surfaces — Diamond-only ─────────────────────────────────

    /// @notice Send a Mode-A repatriation return to Base: the VPFI the
    ///         Diamond just moved into this escrow, plus the payload that
    ///         binds it to its issuing authorization.
    /// @dev    Called by {RepatriationFacet.executeRepatriation} in the same
    ///         transaction that debits the mirror bucket and transfers the
    ///         tokens here — the messenger pulls the exact approved amount,
    ///         and any failure reverts the whole execution (the one-shot
    ///         marker included), leaving nothing stranded in escrow.
    ///         `issuingBase` is trusted because the Diamond only executes an
    ///         instruction the reward messenger recorded, and the messenger
    ///         embedded the sending deployment at dispatch.
    function sendRepatriationReturn(
        uint256 dstChainId,
        address issuingBase,
        uint256 authId,
        uint256 amount,
        address payable refundAddress
    )
        external
        payable
        whenNotPaused
        nonReentrant
        returns (bytes32 messageId)
    {
        if (msg.sender != diamond) revert NotDiamond(msg.sender);
        if (amount == 0) revert ZeroAmount();
        address token = vpfiToken;
        uint256 held = IERC20(token).balanceOf(address(this));
        if (held < amount) revert InsufficientEscrow(amount, held);

        bytes memory payload = abi.encode(
            ReturnWire.RETURN_WIRE_TAG_REPAT_A1,
            issuingBase,
            authId,
            amount
        );
        ICrossChainMessenger.TokenAmount[] memory tokens =
            new ICrossChainMessenger.TokenAmount[](1);
        tokens[0] = ICrossChainMessenger.TokenAmount({
            token: token,
            amount: amount
        });

        // Exact-amount approval; the messenger's pull drains it to zero in
        // this same call.
        IERC20(token).forceApprove(messenger, amount);
        messageId = _send(dstChainId, payload, tokens, refundAddress);
        emit RepatriationReturnSent(messageId, issuingBase, authId, amount);
    }

    /// @notice Send a Mode-A cancellation ACK to Base — the authenticated
    ///         evidence of a mirror-side tombstone, and the ONLY event that
    ///         lets Base release the authorization's availability draw
    ///         (§3.6a constraint 5c). Data-only.
    /// @dev    Called by {RepatriationFacet.sendRepatriationCancelAck},
    ///         which requires the tombstone to exist first.
    function sendRepatriationCancelAck(
        uint256 dstChainId,
        address issuingBase,
        uint256 authId,
        address payable refundAddress
    )
        external
        payable
        whenNotPaused
        nonReentrant
        returns (bytes32 messageId)
    {
        if (msg.sender != diamond) revert NotDiamond(msg.sender);
        bytes memory payload = abi.encode(
            ReturnWire.RETURN_WIRE_TAG_REPAT_CANCEL_ACK_A1,
            issuingBase,
            authId
        );
        messageId = _send(dstChainId, payload, _noTokens(), refundAddress);
        emit RepatriationCancelAckSent(messageId, issuingBase, authId);
    }

    /// @notice #1434 P2-w5 — send a Mode-B STRANDED RETURN to Base: the
    ///         quarantined compensation VPFI the Diamond just moved into
    ///         this escrow, plus the payload binding it to the receipt it
    ///         settles (`remitter` = the issuing Base deployment,
    ///         `remitId` = the reservation the return retires).
    /// @dev    Called by {RepatriationFacet.sendStrandedReturn} in the same
    ///         transaction that retires the mirror's stranded-recovery
    ///         record and transfers the tokens here — any failure reverts
    ///         the whole return (record intact, nothing stranded in
    ///         escrow). Same exact-approval / whole-tx-atomicity posture as
    ///         the Mode-A leg above.
    function sendStrandedReturn(
        uint256 dstChainId,
        address remitter,
        uint256 remitId,
        uint256 dayId,
        uint256 amount,
        address payable refundAddress
    )
        external
        payable
        whenNotPaused
        nonReentrant
        returns (bytes32 messageId)
    {
        if (msg.sender != diamond) revert NotDiamond(msg.sender);
        if (amount == 0) revert ZeroAmount();
        address token = vpfiToken;
        uint256 held = IERC20(token).balanceOf(address(this));
        if (held < amount) revert InsufficientEscrow(amount, held);

        bytes memory payload = abi.encode(
            ReturnWire.RETURN_WIRE_TAG_STRANDED_B1,
            remitter,
            remitId,
            dayId,
            amount
        );
        ICrossChainMessenger.TokenAmount[] memory tokens =
            new ICrossChainMessenger.TokenAmount[](1);
        tokens[0] = ICrossChainMessenger.TokenAmount({
            token: token,
            amount: amount
        });

        IERC20(token).forceApprove(messenger, amount);
        messageId = _send(dstChainId, payload, tokens, refundAddress);
        emit StrandedReturnSent(messageId, remitter, remitId, dayId, amount);
    }

    // ─── Quotes ───────────────────────────────────────────────────────

    /// @notice Fee quote for {sendRepatriationReturn} with these arguments.
    function quoteRepatriationReturn(
        uint256 dstChainId,
        address issuingBase,
        uint256 authId,
        uint256 amount
    ) external view returns (uint256 fee) {
        bytes memory payload = abi.encode(
            ReturnWire.RETURN_WIRE_TAG_REPAT_A1,
            issuingBase,
            authId,
            amount
        );
        ICrossChainMessenger.TokenAmount[] memory tokens =
            new ICrossChainMessenger.TokenAmount[](1);
        tokens[0] = ICrossChainMessenger.TokenAmount({
            token: vpfiToken,
            amount: amount
        });
        return ICrossChainMessenger(messenger).quoteMessageFee(
            dstChainId, payload, tokens, destGasLimit
        );
    }

    /// @notice Fee quote for {sendStrandedReturn} with these arguments.
    function quoteStrandedReturn(
        uint256 dstChainId,
        address remitter,
        uint256 remitId,
        uint256 dayId,
        uint256 amount
    ) external view returns (uint256 fee) {
        bytes memory payload = abi.encode(
            ReturnWire.RETURN_WIRE_TAG_STRANDED_B1,
            remitter,
            remitId,
            dayId,
            amount
        );
        ICrossChainMessenger.TokenAmount[] memory tokens =
            new ICrossChainMessenger.TokenAmount[](1);
        tokens[0] = ICrossChainMessenger.TokenAmount({
            token: vpfiToken,
            amount: amount
        });
        return ICrossChainMessenger(messenger).quoteMessageFee(
            dstChainId, payload, tokens, destGasLimit
        );
    }

    /// @notice Fee quote for {sendRepatriationCancelAck} with these arguments.
    function quoteRepatriationCancelAck(
        uint256 dstChainId,
        address issuingBase,
        uint256 authId
    ) external view returns (uint256 fee) {
        bytes memory payload = abi.encode(
            ReturnWire.RETURN_WIRE_TAG_REPAT_CANCEL_ACK_A1,
            issuingBase,
            authId
        );
        return ICrossChainMessenger(messenger).quoteMessageFee(
            dstChainId, payload, _noTokens(), destGasLimit
        );
    }

    // ─── Internals ────────────────────────────────────────────────────

    /// @dev Quote, forward the exact fee, refund the remainder. The
    ///      destination comes from the calling Diamond on every send —
    ///      this satellite deliberately stores none (Codex #1618 r7).
    function _send(
        uint256 dstChainId,
        bytes memory payload,
        ICrossChainMessenger.TokenAmount[] memory tokens,
        address payable refundAddress
    ) internal returns (bytes32 messageId) {
        uint256 fee = ICrossChainMessenger(messenger).quoteMessageFee(
            dstChainId, payload, tokens, destGasLimit
        );
        if (msg.value < fee) revert InsufficientFee(msg.value, fee);
        // `messenger` is the owner-set CCIP adapter and `fee` is the exact
        // value just re-quoted from that same contract.
        // slither-disable-next-line arbitrary-send-eth
        messageId = ICrossChainMessenger(messenger).sendMessage{value: fee}(
            dstChainId, payload, tokens, destGasLimit
        );
        uint256 remainder = msg.value - fee;
        if (remainder != 0) {
            (bool ok, ) = refundAddress.call{value: remainder}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @dev Empty token list — the cancellation ACK is data-only.
    function _noTokens()
        internal
        pure
        returns (ICrossChainMessenger.TokenAmount[] memory)
    {
        return new ICrossChainMessenger.TokenAmount[](0);
    }

    // ─── Emergency pause ──────────────────────────────────────────────

    /// @notice Pause both send surfaces. Guardian or owner.
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

    function setDiamond(address newDiamond) external onlyOwner {
        if (newDiamond == address(0)) revert ZeroAddress();
        if (newDiamond.code.length == 0) revert NotAContract(newDiamond);
        emit DiamondSet(diamond, newDiamond);
        diamond = newDiamond;
    }

    function setVpfiToken(address newToken) external onlyOwner {
        if (newToken == address(0)) revert ZeroAddress();
        if (newToken.code.length == 0) revert NotAContract(newToken);
        emit VpfiTokenSet(vpfiToken, newToken);
        vpfiToken = newToken;
    }

    function setDestGasLimit(uint256 newLimit) external onlyOwner {
        emit DestGasLimitSet(destGasLimit, newLimit);
        destGasLimit = newLimit;
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
