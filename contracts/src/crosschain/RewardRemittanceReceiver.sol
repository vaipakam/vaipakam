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
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {GuardianPausable} from "./GuardianPausable.sol";
import {RemitWire} from "./RemitWire.sol";
import {
    ICrossChainMessenger,
    ICrossChainMessageRecipient
} from "./ICrossChainMessenger.sol";

/// @dev The receiver's CURRENT wire generation (#1434 P2-w2), at file level so
///      the refresh script imports the same value the deployed probe
///      ({RewardRemittanceReceiver.WIRE_GENERATION}) returns — one definition,
///      no literal to drift. What it governs is the refresh's UPGRADE
///      DECISION: a deployed proxy reporting less than this figure is
///      upgraded, so any change to the receiver's behaviour advances it,
///      whichever side of the contract the change is on.
///
///      6 — #1566 transport epochs 3d-1: the receiver decodes the d6 (rooted)
///      wire and forwards it through its own Diamond ingress.
///
///      7 — the receiver accepts the d6 budget wire and the P2 compensation
///      wire ONLY, and refuses every older budget shape by name
///      ({RewardRemittanceReceiver.UnknownRemitWireShape}). The untagged
///      legacy and d2 payloads and the tagged d5 payload carried a flat day
///      list, and the untagged two carried no split; the Diamond ingress that
///      took them is gone.
///
///      8 — #918: the receiver accepts the d7 budget wire (d6 plus the funded
///      day's whole slice, so a day may arrive in several parts) and the P2
///      compensation wire ONLY, refuses d6 by name like every older shape, and
///      forwards each delivery's DECLARED part and the day's whole to the
///      Diamond's `onRewardBudgetReceivedD7`.
///
///      9 — #2828: the receiver accepts the d8 budget wire (the one funded day
///      carried inline, in place of d7's rooted, chunked day list) and the P2
///      compensation wire ONLY, refuses d7 by name like every older shape, and
///      forwards the day to the Diamond's `onRewardBudgetReceivedD8`, which
///      indexes it at arrival.
uint256 constant REMIT_RECEIVER_WIRE_GENERATION = 9;

interface IRewardBudgetIngress {
    /// @notice #2828 — a d8 delivery: the ONE day it funds arrives inline,
    ///         the split is typed on the wire, the era the packet was
    ///         dispatched in rides along, and so do this part's DECLARED
    ///         figures and the day's whole slice, which the mirror's delivery
    ///         gate sums parts against.
    /// @param amount / recycledShare / freshShare What actually landed, split
    ///        (the recycled share scaled to a short delivery).
    /// @param dayId The day this delivery funds.
    /// @param declaredTotal / declaredRecycled This part as Base sent it,
    ///        before any scaling.
    /// @param dayWholeFresh / dayWholeRecycled The funded day's whole slice.
    function onRewardBudgetReceivedD8(
        address token,
        uint256 amount,
        uint256 dayId,
        uint256 sourceChainId,
        uint256 remitId,
        address remitter,
        uint256 recycledShare,
        uint256 freshShare,
        bytes32 transportMessageId,
        uint64 intendedEra,
        uint256 declaredTotal,
        uint256 declaredRecycled,
        uint256 dayWholeFresh,
        uint256 dayWholeRecycled
    ) external;
}

/// @notice #1434 P2-w2 — the mirror Diamond's COMPENSATION ingress
///         (`RewardRemittanceFacet.onCompensationBudgetReceived`): the
///         classifying counterpart of the d8 budget ingress for the
///         P2 manual-compensation wire (one zeroed day, per-side amounts,
///         the day's frozen expiry inputs riding along — §1.3/§2.2).
interface ICompensationBudgetIngress {
    function onCompensationBudgetReceived(
        address token,
        uint256 amount,
        uint256 dayId,
        uint256 sourceChainId,
        uint256 remitId,
        address remitter,
        uint256 lenderShare18,
        uint256 borrowerShare18,
        uint64 finalizedAt,
        uint32 lapseScheduleVersion,
        uint64 lapseWindowSeconds,
        uint64 dispatchCutoffGap,
        bytes32 transportMessageId
    ) external;
}

/**
 * @title RewardRemittanceReceiver — #776 (Base→mirror reward-budget bridge).
 *
 * Mirror-side UUPS contract that receives the token-bearing CCIP messages
 * {RewardRemittanceFacet.remitRewardBudget} sends from Base, forwards the
 * delivered VPFI into the local Vaipakam Diamond (which is what
 * `claimInteractionRewards` pays from), and calls the Diamond's
 * `onRewardBudgetReceivedD8` ingress to record the delivery.
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
    /// @notice The payload leads with a word that names no shape this
    ///         receiver accepts: only the d8 budget wire
    ///         ({RemitWire.REMIT_WIRE_TAG_D8}) and the P2 compensation wire
    ///         ({RemitWire.REMIT_WIRE_TAG_P2}) are. CCIP records the delivery
    ///         as a failed, re-executable message, so the tokens stay with
    ///         the transport rather than landing uncredited.
    error UnknownRemitWireShape(uint256 head);

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
        ICrossChainMessenger.TokenAmount[] calldata tokens,
        // #1566 closure 2 cutover PR 1 — passed through to the Diamond
        // ingress, which records the packet under its ingress stamp.
        bytes32 transportMessageId
    ) external override whenNotPaused nonReentrant {
        if (msg.sender != messenger) revert NotMessenger(msg.sender);
        if (tokens.length != 1) revert WrongTokenCount(tokens.length);

        // The payload's LEADING WORD names its shape ({RemitWire}): the d8
        // budget wire or the P2 compensation wire, each with its own decode
        // and its own Diamond ingress, handled in a separate frame. Both share
        // ONE token-delivery implementation ({_deliverTokens}), so the
        // delivered-vs-declared and fee-on-transfer rules can never diverge
        // between them. Any other word is refused by name: the older budget
        // shapes carried a flat day list (the untagged two no split), or
        // (d6, d7) a rooted day list this mirror no longer indexes, and
        // nothing on this mirror can account for one any more.
        uint256 head = abi.decode(payload[:32], (uint256));
        if (head == RemitWire.REMIT_WIRE_TAG_D8) {
            _handleBudget(sourceChainId, payload, tokens, transportMessageId);
        } else if (head == RemitWire.REMIT_WIRE_TAG_P2) {
            _handleCompensation(sourceChainId, payload, tokens, transportMessageId);
        } else {
            revert UnknownRemitWireShape(head);
        }
    }

    /// @notice #2828 — a d8 budget delivery was forwarded into the Diamond:
    ///         the delivered amount and the day it funds, for reconciliation
    ///         against the sender's dispatch record.
    /// @custom:event-category informational/reward-transport
    event RewardBudgetDayForwarded(
        uint256 indexed sourceChainId,
        address indexed token,
        uint256 amount,
        uint256 dayId,
        uint256 remitId
    );

    /// @dev The d8 frame. The split travels as the recycled component and the
    ///      total; the fresh component is what is left of what ACTUALLY landed
    ///      after the recycled share is scaled to it, so the two always sum to
    ///      the delivered amount — the Diamond's budget ingress requires a
    ///      WHOLE split, because the whole delivery becomes one epoch typed by
    ///      those two caps and a wei under no cap would be value no day could
    ///      draw. The DECLARED part (`total`, `recycledShare` as sent) and the
    ///      day's whole travel on unscaled (#918): the mirror's delivery gate
    ///      counts what Base sent, and a short delivery is surfaced by the
    ///      acknowledgement's received figure, not by holding the day. The
    ///      payload decodes into one memory struct ({RemitWire.D8}), which
    ///      keeps this frame's stack at one pointer.
    function _handleBudget(
        uint256 sourceChainId,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens,
        bytes32 transportMessageId
    ) private {
        (, RemitWire.D8 memory w) = abi.decode(payload, (uint256, RemitWire.D8));
        (address deliveredToken, uint256 actualReceived) = _deliverTokens(tokens, w.total);
        uint256 recycledShare = w.recycledShare;
        if (actualReceived != w.total && recycledShare != 0) {
            recycledShare = Math.mulDiv(recycledShare, actualReceived, w.total);
        }
        uint256 freshShare = actualReceived > recycledShare ? actualReceived - recycledShare : 0;
        IRewardBudgetIngress(diamond).onRewardBudgetReceivedD8(
            deliveredToken,
            actualReceived,
            w.dayId,
            sourceChainId,
            w.remitId,
            w.remitter,
            recycledShare,
            freshShare,
            transportMessageId,
            w.intendedEra,
            w.total,
            w.recycledShare,
            w.dayWholeFresh,
            w.dayWholeRecycled
        );
        emit RewardBudgetDayForwarded(sourceChainId, deliveredToken, actualReceived, w.dayId, w.remitId);
    }

    /// @notice #1434 P2-w2 — a P2 manual-compensation delivery was
    ///         forwarded into the Diamond's classifying ingress.
    event CompensationBudgetForwarded(
        uint256 indexed sourceChainId,
        uint256 indexed dayId,
        uint256 actualReceived,
        uint256 remitId
    );

    /// @dev #1434 P2-w2 — decode + forward the P2 compensation shape (own
    ///      frame for stack headroom). Same delivered-vs-declared and
    ///      fee-on-transfer rules as the d8 path ({_deliverTokens} is
    ///      shared), with BOTH per-side shares scaled to what actually
    ///      landed, each flooring — the dust stays unattributed, the
    ///      direction that defers. The expiry inputs
    ///      pass through verbatim: they are Base's frozen words, not this
    ///      contract's to interpret.
    function _handleCompensation(
        uint256 sourceChainId,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens,
        bytes32 transportMessageId
    ) private {
        (
            ,
            uint256 dayId,
            uint256 declaredTotal,
            uint256 remitId,
            address remitter,
            uint256 lenderShare,
            uint256 borrowerShare,
            uint256 finalizedAt,
            uint256 lapseScheduleVersion,
            uint256 lapseWindowSeconds,
            uint256 dispatchCutoffGap
        ) = abi.decode(
            payload,
            (
                uint256,
                uint256,
                uint256,
                uint256,
                address,
                uint256,
                uint256,
                uint256,
                uint256,
                uint256,
                uint256
            )
        );

        (address deliveredToken, uint256 actualReceived) =
            _deliverTokens(tokens, declaredTotal);

        if (actualReceived != declaredTotal) {
            if (lenderShare != 0) {
                lenderShare =
                    Math.mulDiv(lenderShare, actualReceived, declaredTotal);
            }
            if (borrowerShare != 0) {
                borrowerShare =
                    Math.mulDiv(borrowerShare, actualReceived, declaredTotal);
            }
        }

        ICompensationBudgetIngress(diamond).onCompensationBudgetReceived(
            deliveredToken,
            actualReceived,
            dayId,
            sourceChainId,
            remitId,
            remitter,
            lenderShare,
            borrowerShare,
            SafeCast.toUint64(finalizedAt),
            SafeCast.toUint32(lapseScheduleVersion),
            SafeCast.toUint64(lapseWindowSeconds),
            SafeCast.toUint64(dispatchCutoffGap),
            transportMessageId
        );

        emit CompensationBudgetForwarded(
            sourceChainId, dayId, actualReceived, remitId
        );
    }

    /// @dev The ONE token-delivery implementation both wire generations
    ///      share: validate the declared single-token VPFI delivery,
    ///      forward it to the Diamond, and return what ACTUALLY landed
    ///      (fee-on-transfer safety — mirrors the buyback receiver).
    function _deliverTokens(
        ICrossChainMessenger.TokenAmount[] calldata tokens,
        uint256 declaredTotal
    ) private returns (address deliveredToken, uint256 actualReceived) {
        deliveredToken = tokens[0].token;
        uint256 deliveredAmount = tokens[0].amount;
        if (deliveredToken != vpfiToken) {
            revert TokenMismatch(vpfiToken, deliveredToken);
        }
        if (deliveredAmount != declaredTotal) {
            revert AmountMismatch(declaredTotal, deliveredAmount);
        }
        if (deliveredAmount == 0) revert ZeroAmount();

        uint256 spendable = IERC20(deliveredToken).balanceOf(address(this));
        if (spendable == 0) revert ZeroAmount();
        uint256 toTransfer = spendable < deliveredAmount
            ? spendable
            : deliveredAmount;

        uint256 diamondBalBefore = IERC20(deliveredToken).balanceOf(diamond);
        IERC20(deliveredToken).safeTransfer(diamond, toTransfer);
        actualReceived =
            IERC20(deliveredToken).balanceOf(diamond) - diamondBalBefore;
        if (actualReceived == 0) revert ZeroAmount();
    }

    /// @notice #1434 P2-w2 (Codex #1634 r1) — the DURABLE upgrade probe
    ///         for the standalone receiver. The facet-refresh script's
    ///         original gate keyed on retired Diamond selectors, which an
    ///         already-migrated deployment no longer routes — so the P2
    ///         decoder would never install there and every manual
    ///         compensation would sit as a failed CCIP delivery while Base
    ///         had already closed the day. The script now probes THIS
    ///         constant instead: a missing selector (pre-P2 impl) or a
    ///         lower value means the proxy needs the upgrade. Bump it with
    ///         every change to what the receiver decodes or forwards; the history
    ///         is at {REMIT_RECEIVER_WIRE_GENERATION}.
    uint256 public constant WIRE_GENERATION =
        REMIT_RECEIVER_WIRE_GENERATION;

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
