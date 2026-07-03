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

/// @dev Mirror-side Diamond ingress for the reward-budget remittance flow.
interface IRewardBudgetIngress {
    function onRewardBudgetReceived(
        address token,
        uint256 amount,
        uint256[] calldata dayIds,
        uint256 sourceChainId
    ) external;
}

/**
 * @title RewardRemittanceReceiver — #776 (Base→mirror reward-budget bridge).
 *
 * Mirror-side UUPS contract that receives the token-bearing CCIP messages
 * {RewardRemittanceFacet.remitRewardBudget} sends from Base, forwards the
 * delivered VPFI into the local Vaipakam Diamond (which is what
 * `claimInteractionRewards` pays from), and calls the Diamond's
 * `onRewardBudgetReceived` ingress to record the funded total for monitoring.
 *
 * The mirror image of {BuybackRemittanceReceiver} (mirror→Base): same trust +
 * fee-on-transfer handling, differing only in direction and the payload shape.
 *
 * Trust + behaviour:
 *   - `onCrossChainMessage` is callable only by the registered {messenger}
 *     (which has already authenticated the CCIP source chain + channel peer).
 *   - Exactly one `TokenAmount` per delivery; the token must equal the
 *     configured local {vpfiToken} and the delivered amount must equal the
 *     `total` declared in the payload (delivered-vs-declared cross-check).
 *   - Delivered tokens are forwarded to the Diamond BEFORE the ingress call;
 *     the credited amount is measured from the Diamond's actual balance delta,
 *     so a fee-on-transfer token can't over-credit (and a 100%-fee token
 *     reverts, so CCIP marks the message re-executable rather than silently
 *     losing the Base-side debit).
 *
 * @dev UUPS-upgradeable; guardian + owner pause. Holds no native funds.
 */
contract RewardRemittanceReceiver is
    Initializable,
    Ownable2StepUpgradeable,
    GuardianPausable,
    ReentrancyGuardTransient,
    UUPSUpgradeable,
    ICrossChainMessageRecipient
{
    using SafeERC20 for IERC20;

    // ─── Storage ──────────────────────────────────────────────────────

    /// @notice The {ICrossChainMessenger} adapter on this mirror chain.
    address public messenger;
    /// @notice The Vaipakam Diamond on this mirror chain — the credit target.
    address public diamond;
    /// @notice The local (mirror) VPFI token the reward budget arrives as.
    address public vpfiToken;

    /// @dev Reserved storage for upgrade-safe appends.
    // forge-lint: disable-next-line(mixed-case-variable)
    uint256[47] private __gap;

    // ─── Events ───────────────────────────────────────────────────────

    /// @custom:event-category informational/config
    event MessengerSet(address indexed previousMessenger, address indexed newMessenger);
    /// @custom:event-category informational/config
    event DiamondSet(address indexed previousDiamond, address indexed newDiamond);
    /// @custom:event-category informational/config
    event VpfiTokenSet(address indexed previousToken, address indexed newToken);
    /// @custom:event-category informational/reward-transport
    event RewardBudgetForwarded(
        uint256 indexed sourceChainId,
        address indexed token,
        uint256 amount,
        uint256[] dayIds
    );

    // ─── Errors ───────────────────────────────────────────────────────

    error ZeroAddress();
    error NotAContract(address candidate);
    error NotMessenger(address caller);
    error WrongTokenCount(uint256 got);
    /// @notice Delivered token is not the configured local VPFI.
    error TokenMismatch(address expected, address delivered);
    /// @notice Delivered amount disagrees with the payload's declared total.
    error AmountMismatch(uint256 declared, uint256 delivered);
    error ZeroAmount();

    // ─── Construction ─────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy.
    /// @param owner_     Owner (admin multi-sig → governance timelock).
    /// @param messenger_ The {ICrossChainMessenger} deployment on this chain.
    /// @param diamond_   The Vaipakam Diamond on this chain.
    /// @param vpfiToken_ The local (mirror) VPFI token.
    function initialize(
        address owner_,
        address messenger_,
        address diamond_,
        address vpfiToken_
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

        emit MessengerSet(address(0), messenger_);
        emit DiamondSet(address(0), diamond_);
        emit VpfiTokenSet(address(0), vpfiToken_);
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

        // Payload shape: `abi.encode(uint256[] dayIds, uint256 total)`.
        (uint256[] memory dayIds, uint256 declaredTotal) = abi.decode(
            payload,
            (uint256[], uint256)
        );

        address deliveredToken = tokens[0].token;
        uint256 deliveredAmount = tokens[0].amount;
        if (deliveredToken != vpfiToken) {
            revert TokenMismatch(vpfiToken, deliveredToken);
        }
        if (deliveredAmount != declaredTotal) {
            revert AmountMismatch(declaredTotal, deliveredAmount);
        }
        if (deliveredAmount == 0) revert ZeroAmount();

        // Fee-on-transfer safety: spend what this contract actually holds and
        // credit only what actually lands in the Diamond (mirrors the buyback
        // receiver). VPFI is a standard token, so this is normally benign.
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

        IRewardBudgetIngress(diamond).onRewardBudgetReceived(
            deliveredToken,
            actualReceived,
            dayIds,
            sourceChainId
        );

        emit RewardBudgetForwarded(
            sourceChainId,
            deliveredToken,
            actualReceived,
            dayIds
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

    function setVpfiToken(address newToken) external onlyOwner {
        if (newToken == address(0)) revert ZeroAddress();
        if (newToken.code.length == 0) revert NotAContract(newToken);
        emit VpfiTokenSet(vpfiToken, newToken);
        vpfiToken = newToken;
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
