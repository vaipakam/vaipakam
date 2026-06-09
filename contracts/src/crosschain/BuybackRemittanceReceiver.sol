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
import {
    ICrossChainMessenger,
    ICrossChainMessageRecipient
} from "./ICrossChainMessenger.sol";

/// @dev Base-side Diamond ingress for the buyback remittance flow.
interface ITreasuryBuybackIngress {
    function absorbRemittance(
        address token,
        uint256 amount,
        uint256 sourceChainId
    ) external;
}

/**
 * @title BuybackRemittanceReceiver — T-087 Sub 3.A
 *
 * Base-side UUPS contract that receives token-bearing CCIP messages for
 * the buyback channel and forwards the delivered tokens into the
 * Vaipakam Diamond's treasury, then calls
 * `TreasuryFacet.absorbRemittance` to credit the consolidated buyback
 * budget. Each mirror chain's Diamond is the source-sender on its end;
 * the {CcipMessenger} on Base validates the channel-peer identity
 * before forwarding to this contract.
 *
 * Trust + behaviour:
 *   - `onCrossChainMessage` is callable only by the registered
 *     {messenger}. The messenger has already authenticated the CCIP
 *     source chain + channel peer.
 *   - Token-bearing only: exactly one `TokenAmount` per delivery.
 *     Multi-token deliveries are rejected (round-8 P2 #6) to avoid
 *     ambiguous accounting + double-credit risk.
 *   - Payload cross-validation: the inbound `payload` carries the
 *     `declaredToken` address; we revert if it disagrees with the
 *     `tokens[0].token` the messenger actually delivered (round-7
 *     P1 #6). Catches a misrouted token delivery before the diamond
 *     mistakenly credits the wrong budget.
 *   - The delivered tokens are forwarded to the Diamond BEFORE the
 *     absorb call (round-7 P2 #8), so the Diamond's `absorbRemittance`
 *     never has to reach back through this contract for token
 *     custody.
 *
 * @dev UUPS-upgradeable; guardian + owner pause. The receiver holds
 *      no native funds (gas for the absorb call is the inbound CCIP
 *      delivery's pre-funded budget, not value from this contract).
 */
contract BuybackRemittanceReceiver is
    Initializable,
    Ownable2StepUpgradeable,
    GuardianPausable,
    ReentrancyGuardTransient,
    UUPSUpgradeable,
    ICrossChainMessageRecipient
{
    using SafeERC20 for IERC20;

    // ─── Storage ──────────────────────────────────────────────────────

    /// @notice The {ICrossChainMessenger} adapter on Base. Forwards
    ///         the inbound delivery from CCIP to this contract.
    address public messenger;

    /// @notice The Vaipakam Diamond on Base — the absorb target.
    address public diamond;

    /// @dev Reserved storage for upgrade-safe appends.
    // forge-lint: disable-next-line(mixed-case-variable)
    uint256[48] private __gap;

    // ─── Events ───────────────────────────────────────────────────────

    /// @custom:event-category informational/config
    event MessengerSet(address indexed previousMessenger, address indexed newMessenger);
    /// @custom:event-category informational/config
    event DiamondSet(address indexed previousDiamond, address indexed newDiamond);
    /// @custom:event-category informational/buyback-transport
    event BuybackRemittanceForwarded(
        uint256 indexed sourceChainId,
        address indexed token,
        uint256 amount
    );

    // ─── Errors ───────────────────────────────────────────────────────

    error ZeroAddress();
    /// @notice Codex Sub 3.A round-2 P2 #2 — `diamond` (or `messenger`)
    ///         was set to an EOA. Forwarding the remitted tokens to
    ///         an EOA would silently strand them; the EOA can never
    ///         call `absorbRemittance` to credit the Base-side
    ///         budget. Reject any address with no code at config
    ///         time.
    error NotAContract(address candidate);
    /// @notice `onCrossChainMessage` called by an address other than the
    ///         registered {messenger}.
    error NotMessenger(address caller);
    /// @notice The inbound delivery carries a wrong number of tokens.
    ///         The buyback channel is strict-one-token-per-message.
    error WrongTokenCount(uint256 got);
    /// @notice The payload's `declaredToken` does not match the actual
    ///         delivered token. Catches a misrouted delivery before
    ///         the diamond credits the wrong budget.
    error TokenMismatch(address declared, address delivered);
    /// @notice The inbound payload is not the canonical 1-word shape.
    error PayloadSizeMismatch(uint256 got, uint256 expected);
    /// @notice The delivered amount is zero — almost certainly a misuse.
    error ZeroAmount();

    // ─── Construction ─────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy.
    /// @param owner_     Owner (admin multi-sig → governance timelock).
    /// @param messenger_ The {ICrossChainMessenger} deployment on Base.
    /// @param diamond_   The Vaipakam Diamond on Base.
    function initialize(
        address owner_,
        address messenger_,
        address diamond_
    ) external initializer {
        if (
            owner_ == address(0)
                || messenger_ == address(0)
                || diamond_ == address(0)
        ) {
            revert ZeroAddress();
        }
        // Codex round-2 P2 #2 — messenger + diamond must be deployed
        // contracts. An EOA in either slot strands tokens (diamond
        // case) or routes inbound to a no-op address (messenger case).
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
        address /* sourceSender */,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens
    ) external override whenNotPaused nonReentrant {
        if (msg.sender != messenger) revert NotMessenger(msg.sender);
        if (tokens.length != 1) revert WrongTokenCount(tokens.length);
        // Canonical payload shape: `abi.encode(address declaredToken)`
        // = exactly one 32-byte word. A strict length pin rejects
        // padded packets just like the reward messenger does for its
        // own shapes (Sub 2.B round-1 P1 #5).
        if (payload.length != 32) revert PayloadSizeMismatch(payload.length, 32);

        address declaredToken = abi.decode(payload, (address));
        address deliveredToken = tokens[0].token;
        uint256 deliveredAmount = tokens[0].amount;

        if (declaredToken != deliveredToken) {
            revert TokenMismatch(declaredToken, deliveredToken);
        }
        if (deliveredAmount == 0) revert ZeroAmount();

        // Codex Sub 3.A round-3 P2 #3 + round-4 P2 #1 — fee-on-transfer
        // / deflationary tokens are double-trouble: CCIP → receiver
        // might already have charged a fee BEFORE this callback, so
        // `tokens[0].amount` overstates what THIS contract holds; AND
        // the receiver → Diamond `safeTransfer` might charge another
        // fee. Compute the spendable amount FROM this contract's
        // actual balance (`balanceOf(this)`), transfer that, and
        // credit only the amount that actually lands in the Diamond.
        // For tokens without fees, `spendable == deliveredAmount` and
        // `actualReceived == spendable` so the path is benign.
        uint256 spendable = IERC20(deliveredToken).balanceOf(address(this));
        if (spendable == 0) revert ZeroAmount();
        // If the receiver-side fee took more than expected, fall back
        // to spending what we actually hold instead of reverting.
        uint256 toTransfer = spendable < deliveredAmount
            ? spendable
            : deliveredAmount;

        uint256 diamondBalBefore = IERC20(deliveredToken).balanceOf(diamond);
        IERC20(deliveredToken).safeTransfer(diamond, toTransfer);
        uint256 actualReceived =
            IERC20(deliveredToken).balanceOf(diamond) - diamondBalBefore;

        // Codex Sub 3.A round-6 P2 #2 — a 100%-fee token (or one
        // that silently no-ops `transfer`) would leave
        // `actualReceived == 0`. Crediting zero would mark the CCIP
        // delivery successful while Base's `baseBuybackBudget`
        // saw no funds — the source-chain debit would be lost
        // silently. Revert so CCIP marks the message failed (and
        // manually re-executable once the operator fixes the
        // token or pulls it out of the allow-list).
        if (actualReceived == 0) revert ZeroAmount();

        ITreasuryBuybackIngress(diamond).absorbRemittance(
            deliveredToken, actualReceived, sourceChainId
        );

        emit BuybackRemittanceForwarded(
            sourceChainId, deliveredToken, actualReceived
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
