// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {GuardianPausable} from "./GuardianPausable.sol";
import {
    ICrossChainMessenger,
    ICrossChainMessageRecipient
} from "./ICrossChainMessenger.sol";

/// @dev Mirror-side Diamond ingress for the reward-budget remittance flow.
///      #1222 M3 B2-d2 widens the ingress with the echoed `remitId` (0 for a
///      legacy pre-d2 delivery — the Diamond records no receipt and no ack
///      ever flows; Base holds no reservation for those). B2-d5 adds
///      `recycledShare`: the RECYCLED component of `amount`, already scaled to
///      what physically landed. Zero for legacy/d2 layouts, which is the
///      pre-d5 behaviour.
interface IRewardBudgetIngress {
    function onRewardBudgetReceived(
        address token,
        uint256 amount,
        uint256[] calldata dayIds,
        uint256 sourceChainId,
        uint256 remitId,
        address remitter,
        uint256 recycledShare
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
    /// @dev #1222 M3 B2-d2 — `remitId` is the Base-side delivered-backing
    ///      reservation this delivery fulfils (0 = legacy pre-d2 message).
    event RewardBudgetForwarded(
        uint256 indexed sourceChainId,
        address indexed token,
        uint256 amount,
        uint256[] dayIds,
        uint256 remitId
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
        // Deliberately unused (#1426 r4): the adapter derives this from its
        // delivery-time channel-peer CONFIG, so it cannot identify the
        // sending DEPLOYMENT for a delayed pre-rotation packet. The
        // deployment identity rides IN the payload instead (`remitter` —
        // immutable message data), which is what the ingress binds to.
        address /* sourceSender */,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens
    ) external override whenNotPaused nonReentrant {
        if (msg.sender != messenger) revert NotMessenger(msg.sender);
        if (tokens.length != 1) revert WrongTokenCount(tokens.length);

        // Payload shapes (#1222 M3 B2-d2 dual-decode — delayed pre-d2 CCIP
        // deliveries and governance replays MUST keep decoding, per the plan
        // §M3 backward-decodability rule):
        //   legacy: `abi.encode(uint256[] dayIds, uint256 total)`
        //   d2 r4:  `abi.encode(uint256[] dayIds, uint256 total,
        //            uint256 remitId, address remitter)`
        //   d5:     `... + uint256 recycledShare`
        // Discriminated by the leading ABI head word — the `dayIds` array
        // offset, which is exactly `32 × head-slots`: 0x40 (two) for the
        // legacy tuple, 0x80 (four) for d2's, 0xA0 (five) for d5's.
        // Deterministic for these exact encodings; anything malformed still
        // reverts in `abi.decode` below. A legacy delivery carries no
        // `remitId`/`remitter` — the Diamond records no receipt and no ack
        // flows (Base holds no reservation for pre-d2 sends). `remitter` is
        // the sending deployment's own address, embedded at send — immutable
        // message data, so unlike the adapter's config-derived sourceSender
        // it identifies the DEPLOYMENT even for a delayed pre-rotation packet
        // (#1426 r4).
        //
        // B2-d5 — `recycledShare` is the RECYCLED component of `total`, which
        // the mirror credits as relocated custody so its claim path has real
        // backing. Older layouts leave it ZERO, which degrades to the
        // pre-d5 behaviour (no custody credit) rather than mis-crediting: the
        // conservative direction, and the reason a delayed pre-d5 packet is
        // safe to accept.
        uint256[] memory dayIds;
        uint256 declaredTotal;
        uint256 remitId;
        address remitter;
        uint256 recycledShare;
        uint256 head = abi.decode(payload[:32], (uint256));
        if (head == 0xA0) {
            (dayIds, declaredTotal, remitId, remitter, recycledShare) =
                abi.decode(
                    payload,
                    (uint256[], uint256, uint256, address, uint256)
                );
        } else if (head == 0x80) {
            (dayIds, declaredTotal, remitId, remitter) = abi.decode(
                payload,
                (uint256[], uint256, uint256, address)
            );
        } else {
            (dayIds, declaredTotal) = abi.decode(payload, (uint256[], uint256));
        }

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

        // B2-d5 — scale the declared recycled share to what ACTUALLY landed.
        // `recycledShare` is a component of `declaredTotal`, but the
        // fee-on-transfer path above can credit less than that, and crediting
        // the face value would relocate custody the Diamond never received —
        // {LibVpfiRecycle.creditCustodyRelocated} asserts physical backing and
        // would revert the whole arrival. Floored, matching the claim path's
        // convention that RECYCLED floors and fresh takes the remainder, so
        // the scaled share can never exceed `actualReceived`. `declaredTotal`
        // is non-zero here (it equals the non-zero `deliveredAmount`).
        if (recycledShare != 0 && actualReceived != declaredTotal) {
            recycledShare =
                Math.mulDiv(recycledShare, actualReceived, declaredTotal);
        }

        IRewardBudgetIngress(diamond).onRewardBudgetReceived(
            deliveredToken,
            actualReceived,
            dayIds,
            sourceChainId,
            remitId,
            remitter,
            recycledShare
        );

        emit RewardBudgetForwarded(
            sourceChainId,
            deliveredToken,
            actualReceived,
            dayIds,
            remitId
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
