// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {GuardianPausable} from "./GuardianPausable.sol";
import {IVpfiBuyCcipMessages} from "./IVpfiBuyCcipMessages.sol";
import {
    ICrossChainMessenger,
    ICrossChainMessageRecipient
} from "./ICrossChainMessenger.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/// @dev The Base-side Diamond surface the receiver calls into. `processBridgedBuy`
///      mints VPFI at the fixed rate, debits the global + per-wallet caps, and
///      returns the minted amount; it reverts on a cap / rate / reserve failure.
interface IVpfiBuyDiamond {
    function processBridgedBuy(
        address buyer,
        uint32 originChainId,
        uint256 ethAmountPaid,
        uint256 minVpfiOut
    ) external returns (uint256 vpfiOut);
}

/**
 * @title VpfiBuyReceiver — the Base-side hub of the cross-chain fixed-rate
 *        VPFI buy flow, on the CCIP seam (T-068 Phase 3)
 *
 * The CCIP successor to the LayerZero `VPFIBuyReceiver`. A **domain
 * contract**: it depends only on the {ICrossChainMessenger} port, never a
 * CCIP library. Deployed once on the canonical Base chain; paired with one
 * `VpfiBuyAdapter` per mirror chain over the
 * {IVpfiBuyCcipMessages.VPFI_BUY_CHANNEL} channel.
 *
 * Per inbound BUY_REQUEST ({onCrossChainMessage}):
 *  1. Decode `(requestId, buyer, amountIn, minVpfiOut)`.
 *  2. `try` the Diamond's `processBridgedBuy` — fixed-rate mint + cap
 *     debit. On revert → ship a data-only **BUY_FAILED** back so the
 *     adapter refunds the buyer.
 *  3. On success the minted VPFI sits on this contract. Ship it back as a
 *     CCIP **programmable token transfer** (tokens + the `requestId`)
 *     addressed to the source-chain `VpfiBuyAdapter` — leg 2.
 *
 * ── The no-double-mint invariant ───────────────────────────────────────
 * `processBridgedBuy` is NOT idempotent — a re-run mints again. So once it
 * has succeeded, {onCrossChainMessage} must NOT revert (a revert would let
 * CCIP re-execute the BUY_REQUEST and double-mint). The leg-2 send is
 * therefore wrapped in `try/catch`: if it fails, the VPFI is parked as
 * stuck (owner-retryable via {retryStuckDelivery}) and the inbound call
 * still completes cleanly. The pre-mint paths (decode, BUY_FAILED send)
 * MAY revert — re-execution there is harmless because nothing was minted.
 *
 * @dev UUPS-upgradeable; guardian + owner pause; holds an ETH float
 *      (top up via {fundETH}) to pay the leg-2 cross-chain fee.
 */
contract VpfiBuyReceiver is
    Initializable,
    Ownable2StepUpgradeable,
    GuardianPausable,
    ReentrancyGuardTransient,
    UUPSUpgradeable,
    ICrossChainMessageRecipient,
    IVpfiBuyCcipMessages
{
    using SafeERC20 for IERC20;

    // ─── Storage ────────────────────────────────────────────────────────────

    /// @notice The cross-chain messaging port.
    address public messenger;

    /// @notice The Vaipakam Diamond on Base — the fixed-rate buy ingress.
    address public diamond;

    /// @notice Canonical VPFI ERC20 on Base — minted by the Diamond,
    ///         shipped back on the leg-2 delivery.
    address public vpfiToken;

    /// @notice Gas allowed for `VpfiBuyAdapter.onCrossChainMessage` on the
    ///         leg-2 delivery. Owner-tunable.
    uint256 public destGasLimit;

    /// @notice requestId → VPFI parked on this contract because the leg-2
    ///         delivery send soft-failed. Owner-retryable via
    ///         {retryStuckDelivery}.
    mapping(uint64 => uint256) public stuckVPFIByRequest;

    /// @notice Sum of stuck VPFI; the rescue path refuses to drain
    ///         {vpfiToken} below this figure.
    uint256 public totalStuckVPFI;

    /// @notice Informational flag for the off-chain reconciliation
    ///         watchdog. No on-chain behaviour depends on it.
    bool public reconciliationWatchdogEnabled;

    /// @dev Reserved storage for upgrade-safe appends.
    uint256[44] private __gap;

    // ─── Events ─────────────────────────────────────────────────────────────

    /// @custom:event-category informational/config
    event MessengerSet(address indexed previousMessenger, address indexed newMessenger);
    /// @custom:event-category informational/config
    event DiamondSet(address indexed previousDiamond, address indexed newDiamond);
    /// @custom:event-category informational/config
    event VPFITokenSet(address indexed previousToken, address indexed newToken);
    /// @custom:event-category informational/config
    event DestGasLimitSet(uint256 previousLimit, uint256 newLimit);
    /// @custom:event-category informational/config
    event ReconciliationWatchdogToggled(bool enabled);

    /// @notice A BUY_REQUEST was processed and the VPFI delivery dispatched.
    /// @custom:event-category state-change/vault-mutation
    event BridgedBuyProcessed(
        uint64 indexed requestId,
        uint256 indexed sourceChainId,
        address indexed buyer,
        uint256 amountIn,
        uint256 vpfiOut,
        bytes32 messageId
    );

    /// @notice The Diamond rejected the buy — a BUY_FAILED was shipped
    ///         back so the adapter refunds the buyer.
    /// @custom:event-category informational/crosschain
    event BridgedBuyFailed(
        uint64 indexed requestId,
        uint256 indexed sourceChainId,
        address indexed buyer,
        uint8 reason
    );

    /// @notice The Diamond minted the VPFI but the leg-2 delivery send
    ///         failed — the VPFI is parked, retryable via
    ///         {retryStuckDelivery}. (Caps are already debited on Base,
    ///         so the buy must still be completed, not refunded.)
    /// @custom:event-category informational/crosschain
    event VPFIStuckForRetry(
        uint64 indexed requestId,
        uint256 indexed sourceChainId,
        address indexed buyer,
        uint256 vpfiOut
    );

    /// @notice Owner re-dispatched a previously stuck leg-2 delivery.
    /// @custom:event-category state-change/vault-mutation
    event StuckDeliveryRetried(
        uint64 indexed requestId,
        uint256 indexed sourceChainId,
        uint256 vpfiOut,
        bytes32 messageId
    );

    // ─── Errors ─────────────────────────────────────────────────────────────

    error ZeroAddress();
    error MessengerNotSet();
    error DiamondNotSet();
    /// @notice {onCrossChainMessage} called by an address other than the
    ///         registered {messenger}.
    error NotMessenger(address caller);
    error EthSendFailed();
    error RescueWouldTouchStuckVPFI();
    error NoStuckVPFI(uint64 requestId);
    /// @notice {retryStuckDelivery} could not dispatch — e.g. the ETH
    ///         float is too low or the lane is unconfigured.
    error RetryDispatchFailed(uint64 requestId);
    /// @notice The inbound source chain id does not fit the `uint32`
    ///         origin tag the Diamond's bridged-buy ingress expects.
    error ChainIdTooLarge(uint256 sourceChainId);

    // ─── Construction ───────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the receiver proxy.
    /// @param owner_        Owner (admin multi-sig → governance).
    /// @param messenger_    The {ICrossChainMessenger} deployment.
    /// @param diamond_      The Vaipakam Diamond on Base.
    /// @param vpfiToken_    Canonical VPFI ERC20 on Base.
    /// @param destGasLimit_ Gas for the adapter callback on leg 2.
    function initialize(
        address owner_,
        address messenger_,
        address diamond_,
        address vpfiToken_,
        uint256 destGasLimit_
    ) external initializer {
        if (
            owner_ == address(0) || messenger_ == address(0)
                || diamond_ == address(0) || vpfiToken_ == address(0)
        ) {
            revert ZeroAddress();
        }
        __Ownable_init(owner_);
        __Ownable2Step_init();
        _guardianPausableInit();

        messenger = messenger_;
        diamond = diamond_;
        vpfiToken = vpfiToken_;
        destGasLimit = destGasLimit_;
        reconciliationWatchdogEnabled = true;

        emit MessengerSet(address(0), messenger_);
        emit DiamondSet(address(0), diamond_);
        emit VPFITokenSet(address(0), vpfiToken_);
        emit DestGasLimitSet(0, destGasLimit_);
        emit ReconciliationWatchdogToggled(true);
    }

    // ─── Inbound — the {ICrossChainMessageRecipient} port ───────────────────

    /// @inheritdoc ICrossChainMessageRecipient
    /// @dev Handles a BUY_REQUEST. See the contract docstring for the
    ///      no-double-mint invariant: this function never reverts once
    ///      `processBridgedBuy` has succeeded.
    function onCrossChainMessage(
        uint256 sourceChainId,
        address /* sourceSender */,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata /* tokens */
    ) external override whenNotPaused nonReentrant {
        if (msg.sender != messenger) revert NotMessenger(msg.sender);

        (uint64 requestId, address buyer, uint256 amountIn, uint256 minVpfiOut)
        = abi.decode(payload, (uint64, address, uint256, uint256));

        (bool ok, uint256 vpfiOut, uint8 reason) =
            _tryProcessBuy(buyer, sourceChainId, amountIn, minVpfiOut);

        if (!ok) {
            // Pre-mint failure — a BUY_FAILED send MAY revert (CCIP will
            // re-execute; `processBridgedBuy` simply fails again — safe).
            emit BridgedBuyFailed(requestId, sourceChainId, buyer, reason);
            // `messenger` is the admin-set CCIP adapter; the value is the
            // exact fail-leg fee just re-quoted from that same contract.
            // Same rationale as the success-leg send below.
            // slither-disable-next-line arbitrary-send-eth
            ICrossChainMessenger(messenger).sendMessage{value: _quoteFailFee(sourceChainId, requestId, reason)}(
                sourceChainId,
                abi.encode(requestId, reason),
                _noTokens(),
                destGasLimit
            );
            return;
        }

        // Success — the VPFI is minted onto this contract. From here the
        // function MUST NOT revert (re-execution would double-mint), so
        // the leg-2 delivery is soft (`try/catch`).
        (bytes32 messageId, bool sent) =
            _tryDeliver(sourceChainId, requestId, vpfiOut);

        if (sent) {
            emit BridgedBuyProcessed(
                requestId, sourceChainId, buyer, amountIn, vpfiOut, messageId
            );
        } else {
            stuckVPFIByRequest[requestId] += vpfiOut;
            totalStuckVPFI += vpfiOut;
            emit VPFIStuckForRetry(requestId, sourceChainId, buyer, vpfiOut);
        }
    }

    // ─── Internals ──────────────────────────────────────────────────────────

    /// @dev Wrap the Diamond call so any revert becomes a BUY_FAILED
    ///      reason rather than a stuck inbound message.
    function _tryProcessBuy(
        address buyer,
        uint256 sourceChainId,
        uint256 amountIn,
        uint256 minVpfiOut
    ) internal returns (bool ok, uint256 vpfiOut, uint8 reason) {
        if (diamond == address(0)) {
            return (false, 0, FAIL_REASON_PROCESS_REVERT);
        }
        // The Diamond's bridged-buy ingress takes a uint32 origin-chain
        // tag. Every in-scope Vaipakam chain id fits in uint32; a wider
        // id is an operator misconfiguration — reject it loudly rather
        // than let a silent truncation alias it onto another chain. The
        // revert is pre-mint, so CCIP simply records a re-executable
        // failed message and the buyer's source-chain funds time out.
        if (sourceChainId > type(uint32).max) {
            revert ChainIdTooLarge(sourceChainId);
        }
        try
            IVpfiBuyDiamond(diamond).processBridgedBuy(
                buyer, uint32(sourceChainId), amountIn, minVpfiOut
            )
        returns (uint256 out) {
            return (true, out, 0);
        } catch (bytes memory errData) {
            return (false, 0, _decodeFailReason(errData));
        }
    }

    /// @dev Leg-2 delivery — a CCIP programmable token transfer (VPFI +
    ///      the `requestId`) to the source-chain adapter. Soft: every
    ///      messenger interaction is `try`-wrapped so a failure parks the
    ///      VPFI as stuck instead of reverting the (already-minted)
    ///      inbound call.
    function _tryDeliver(
        uint256 sourceChainId,
        uint64 requestId,
        uint256 vpfiOut
    ) internal returns (bytes32 messageId, bool ok) {
        bytes memory payload = abi.encode(requestId);
        ICrossChainMessenger.TokenAmount[] memory toks =
            new ICrossChainMessenger.TokenAmount[](1);
        toks[0] = ICrossChainMessenger.TokenAmount({
            token: vpfiToken,
            amount: vpfiOut
        });

        try
            ICrossChainMessenger(messenger).quoteMessageFee(
                sourceChainId, payload, toks, destGasLimit
            )
        returns (uint256 fee) {
            if (address(this).balance < fee) return (bytes32(0), false);
            IERC20(vpfiToken).forceApprove(messenger, vpfiOut);
            // `messenger` is the admin-set CCIP adapter — rotated via
            // `setMessenger` (owner-only), not caller-controlled. `fee` is
            // the exact value just re-quoted from that same contract.
            // slither-disable-next-line arbitrary-send-eth
            try
                ICrossChainMessenger(messenger).sendMessage{value: fee}(
                    sourceChainId, payload, toks, destGasLimit
                )
            returns (bytes32 mid) {
                IERC20(vpfiToken).forceApprove(messenger, 0);
                return (mid, true);
            } catch {
                IERC20(vpfiToken).forceApprove(messenger, 0);
                return (bytes32(0), false);
            }
        } catch {
            return (bytes32(0), false);
        }
    }

    /// @dev Quote the BUY_FAILED leg's fee. Unlike the success leg this
    ///      may revert — the caller is pre-mint, so a revert just lets
    ///      CCIP safely re-execute.
    function _quoteFailFee(
        uint256 sourceChainId,
        uint64 requestId,
        uint8 reason
    ) internal view returns (uint256) {
        return ICrossChainMessenger(messenger).quoteMessageFee(
            sourceChainId,
            abi.encode(requestId, reason),
            _noTokens(),
            destGasLimit
        );
    }

    /// @dev Empty token list for the data-only BUY_FAILED leg.
    function _noTokens()
        internal
        pure
        returns (ICrossChainMessenger.TokenAmount[] memory)
    {
        return new ICrossChainMessenger.TokenAmount[](0);
    }

    /// @dev Map a Diamond revert blob to a compact BUY_FAILED reason.
    function _decodeFailReason(
        bytes memory errData
    ) internal pure returns (uint8) {
        if (errData.length < 4) return FAIL_REASON_PROCESS_REVERT;
        bytes4 sel;
        assembly {
            sel := mload(add(errData, 0x20))
        }
        if (
            sel == IVaipakamErrors.VPFIGlobalCapExceeded.selector
                || sel == IVaipakamErrors.VPFIPerWalletCapExceeded.selector
        ) {
            return FAIL_REASON_CAP_EXCEEDED;
        }
        if (
            sel == IVaipakamErrors.VPFIBuyRateNotSet.selector
                || sel == IVaipakamErrors.VPFIBuyDisabled.selector
        ) {
            return FAIL_REASON_RATE_UNSET_OR_DISABLED;
        }
        if (sel == IVaipakamErrors.VPFIReserveInsufficient.selector) {
            return FAIL_REASON_RESERVE_INSUFFICIENT;
        }
        if (sel == IVaipakamErrors.VPFIBuyAmountTooSmall.selector) {
            return FAIL_REASON_AMOUNT_TOO_SMALL;
        }
        return FAIL_REASON_PROCESS_REVERT;
    }

    // ─── Stuck-delivery recovery ────────────────────────────────────────────

    /// @notice Owner-only: re-dispatch a leg-2 delivery that previously
    ///         soft-failed and was parked by {VPFIStuckForRetry}. Reverts
    ///         (so no accounting changes) if the re-dispatch still fails —
    ///         top up the ETH float or fix the lane config and retry.
    /// @param requestId      The stuck request.
    /// @param sourceChainId  The mirror chain to deliver to.
    // Slither flags `reentrancy-eth` because `stuckVPFIByRequest` /
    // `totalStuckVPFI` are written after the external `_tryDeliver` call
    // (which forwards ETH to `messenger`). Gated by `onlyOwner` AND
    // `nonReentrant`; the recipient is the admin-set messenger, not an
    // attacker contract. Not a vuln.
    // slither-disable-next-line reentrancy-eth
    function retryStuckDelivery(
        uint64 requestId,
        uint256 sourceChainId
    ) external onlyOwner nonReentrant {
        uint256 amt = stuckVPFIByRequest[requestId];
        if (amt == 0) revert NoStuckVPFI(requestId);

        (bytes32 messageId, bool ok) =
            _tryDeliver(sourceChainId, requestId, amt);
        if (!ok) revert RetryDispatchFailed(requestId);

        stuckVPFIByRequest[requestId] = 0;
        totalStuckVPFI -= amt;
        emit StuckDeliveryRetried(requestId, sourceChainId, amt, messageId);
    }

    // ─── ETH float ──────────────────────────────────────────────────────────

    /// @notice Accept native ETH — the float that pays leg-2 fees.
    receive() external payable {}

    /// @notice Owner / ops ETH top-up (named alias of {receive}).
    function fundETH() external payable {}

    // ─── Emergency pause ────────────────────────────────────────────────────

    /// @notice Pause inbound BUY_REQUEST handling. Guardian or owner.
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

    function setVPFIToken(address newToken) external onlyOwner {
        if (newToken == address(0)) revert ZeroAddress();
        emit VPFITokenSet(vpfiToken, newToken);
        vpfiToken = newToken;
    }

    function setDestGasLimit(uint256 newLimit) external onlyOwner {
        emit DestGasLimitSet(destGasLimit, newLimit);
        destGasLimit = newLimit;
    }

    /// @notice Toggle the off-chain reconciliation watchdog flag.
    function setReconciliationWatchdogEnabled(bool enabled)
        external
        onlyOwner
    {
        reconciliationWatchdogEnabled = enabled;
        emit ReconciliationWatchdogToggled(enabled);
    }

    // ─── Rescue ─────────────────────────────────────────────────────────────

    /// @notice Owner-only: drain the native ETH float.
    function rescueETH(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert EthSendFailed();
    }

    /// @notice Owner-only: drain an ERC20. When draining {vpfiToken},
    ///         refuses to go below {totalStuckVPFI} — VPFI owed to a buyer
    ///         whose delivery failed is protected; use {retryStuckDelivery}
    ///         to complete that buy instead.
    function rescueERC20(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (token == vpfiToken) {
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (amount > bal || bal - amount < totalStuckVPFI) {
                revert RescueWouldTouchStuckVPFI();
            }
        }
        IERC20(token).safeTransfer(to, amount);
    }

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
