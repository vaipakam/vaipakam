// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {GuardianPausable} from "./GuardianPausable.sol";
import {IVpfiBuyCcipMessages} from "./IVpfiBuyCcipMessages.sol";
import {
    ICrossChainMessenger,
    ICrossChainMessageRecipient
} from "./ICrossChainMessenger.sol";

/**
 * @title VpfiBuyAdapter — the source-chain entry point of the cross-chain
 *        fixed-rate VPFI buy flow, on the CCIP seam (T-068 Phase 3)
 *
 * The CCIP successor to the LayerZero `VPFIBuyAdapter`. It is a **domain
 * contract**: it depends only on the {ICrossChainMessenger} port and never
 * imports a CCIP library — a provider swap re-points {messenger} and this
 * file is untouched.
 *
 * Deployed on every mirror (non-canonical) chain; paired with one
 * `VpfiBuyReceiver` on the canonical Base chain over the
 * {IVpfiBuyCcipMessages.VPFI_BUY_CHANNEL} channel.
 *
 * ── Flow ───────────────────────────────────────────────────────────────
 *  1. {buy} — the user locks `amountIn` (native ETH, or a bridged-WETH
 *     ERC20), the adapter mints a `requestId` and sends a data-only
 *     BUY_REQUEST to Base via {ICrossChainMessenger.sendMessage}.
 *  2a. **VPFI delivery** (success) — Base mints VPFI and returns it as a
 *      CCIP programmable token transfer addressed to THIS adapter (not the
 *      buyer). {onCrossChainMessage} cross-checks `requestId` against the
 *      adapter's own `pendingBuys` record and only then forwards the VPFI
 *      to the recorded buyer and releases the locked payment to treasury.
 *      This is the design-§5 **two-step release**: the value destination
 *      is decided by authoritative *local* state, never by the inbound
 *      message — so even a forged or replayed delivery cannot route VPFI
 *      to an attacker. An unrecognised delivery is parked as "stuck", for
 *      owner recovery.
 *  2b. **BUY_FAILED** — Base rejected the buy; the data-only response
 *      refunds the locked `amountIn` to the buyer.
 *  3. {reclaimTimedOutBuy} — if no response arrives within
 *     {refundTimeoutSeconds}, anyone can settle the stale buy and the
 *     buyer is refunded.
 *
 * ── Trust ──────────────────────────────────────────────────────────────
 * {onCrossChainMessage} is callable only by the registered {messenger};
 * the messenger has already authenticated the CCIP source and the
 * channel peer. The buyer identity is pinned in `pendingBuys` at `buy()`
 * time against `msg.sender` — the response echoes only a `requestId`, and
 * VPFI is delivered solely to that pinned local buyer.
 *
 * @dev UUPS-upgradeable; guardian + owner emergency pause; the buy and
 *      receive entry points carry `ReentrancyGuardTransient`.
 */
contract VpfiBuyAdapter is
    Initializable,
    Ownable2StepUpgradeable,
    GuardianPausable,
    ReentrancyGuardTransient,
    UUPSUpgradeable,
    ICrossChainMessageRecipient,
    IVpfiBuyCcipMessages
{
    using SafeERC20 for IERC20;

    // ─── Types ──────────────────────────────────────────────────────────────

    enum BuyStatus {
        None,
        Pending,
        ResolvedSuccess,
        ResolvedRefunded,
        ResolvedTimedOut
    }

    struct PendingBuy {
        address buyer;
        uint96 amountIn;
        uint64 initiatedAt;
        BuyStatus status;
    }

    // ─── Storage ────────────────────────────────────────────────────────────

    /// @notice The cross-chain messaging port. A provider swap re-points
    ///         this; the rest of the contract is provider-agnostic.
    address public messenger;

    /// @notice EVM chain id of the canonical (Base) chain — the
    ///         destination of every BUY_REQUEST and the only chain a
    ///         response is accepted from.
    uint256 public baseChainId;

    /// @notice Treasury on THIS chain — receives the buyer's locked
    ///         `amountIn` once the buy settles successfully.
    address public treasury;

    /// @notice Payment token. `address(0)` = native-ETH mode; a non-zero
    ///         18-decimal bridged-WETH ERC20 = pull-token mode. The Base
    ///         rate is ETH-denominated, so in token mode the token must
    ///         be 1:1 with ETH.
    address public paymentToken;

    /// @notice Local mirror VPFI ERC20 — the token delivered to buyers
    ///         when a successful response lands.
    address public vpfiToken;

    /// @notice Seconds a PENDING buy stays unsettled before anyone may
    ///         trigger its refund via {reclaimTimedOutBuy}.
    uint64 public refundTimeoutSeconds;

    /// @notice Gas allowed for `VpfiBuyReceiver.onCrossChainMessage` on
    ///         the BUY_REQUEST leg (it runs the Diamond mint + the leg-2
    ///         send). Owner-tunable.
    uint256 public destGasLimit;

    /// @notice Monotonic counter minting unique request ids.
    uint64 public nextRequestId;

    /// @notice requestId → pending-buy state.
    mapping(uint64 => PendingBuy) public pendingBuys;

    /// @notice Sum of `amountIn` over every {BuyStatus.Pending} buy. The
    ///         rescue paths refuse to drain below this, so a compromised
    ///         owner cannot sweep buyer funds awaiting a response.
    uint256 public totalPendingAmountIn;

    // ─── Rate limits (defence-in-depth) ─────────────────────────────────────

    /// @notice Max `amountIn` per single {buy}. `type(uint256).max` until
    ///         governance tightens it.
    uint256 public perRequestCap;
    /// @notice Max cumulative `amountIn` per rolling-24h window.
    uint256 public dailyCap;
    /// @notice Anchor timestamp of the current 24h window.
    uint256 public dailyWindowStart;
    /// @notice `amountIn` accumulated in the current window.
    uint256 public dailyUsed;

    // ─── Two-step-release stuck accounting ──────────────────────────────────

    /// @notice requestId → VPFI parked on this contract because a delivery
    ///         had no matching (or an already-resolved) `pendingBuys`
    ///         entry — the two-step guard fired. Owner-recoverable.
    mapping(uint64 => uint256) public stuckVPFIByRequest;

    /// @notice Sum of stuck VPFI; the rescue path refuses to drain
    ///         {vpfiToken} below this figure.
    uint256 public totalStuckVPFI;

    /// @dev Reserved storage for upgrade-safe appends.
    uint256[38] private __gap;

    // ─── Events ─────────────────────────────────────────────────────────────

    /// @custom:event-category informational/config
    event MessengerSet(address indexed previousMessenger, address indexed newMessenger);
    /// @custom:event-category informational/config
    event BaseChainIdSet(uint256 previousChainId, uint256 newChainId);
    /// @custom:event-category informational/config
    event TreasurySet(address indexed previousTreasury, address indexed newTreasury);
    /// @custom:event-category informational/config
    event PaymentTokenSet(address indexed previousToken, address indexed newToken);
    /// @custom:event-category informational/config
    event VPFITokenSet(address indexed previousToken, address indexed newToken);
    /// @custom:event-category informational/config
    event RefundTimeoutSet(uint64 previousSeconds, uint64 newSeconds);
    /// @custom:event-category informational/config
    event DestGasLimitSet(uint256 previousLimit, uint256 newLimit);
    /// @custom:event-category informational/config
    event RateLimitsSet(uint256 perRequestCap, uint256 dailyCap);
    /// @custom:event-category informational/config
    event DailyWindowReset(uint256 newWindowStart);

    /// @notice Purchase receipt — emitted synchronously on {buy}.
    /// @custom:event-category state-change/escrow-mutation
    event BuyRequested(
        uint64 indexed requestId,
        address indexed buyer,
        uint256 indexed destinationChainId,
        uint256 amountIn,
        uint256 minVpfiOut,
        bytes32 messageId
    );

    /// @notice A buy settled — VPFI delivered to the buyer, payment
    ///         released to treasury.
    /// @custom:event-category state-change/escrow-mutation
    event BuyResolvedSuccess(
        uint64 indexed requestId,
        address indexed buyer,
        uint256 amountIn,
        uint256 vpfiOut
    );

    /// @notice Base rejected the buy — `amountIn` refunded to the buyer.
    /// @custom:event-category state-change/escrow-mutation
    event BuyRefunded(
        uint64 indexed requestId,
        address indexed buyer,
        uint256 amountIn,
        uint8 reason
    );

    /// @notice A stale PENDING buy was settled by refund after the
    ///         timeout elapsed without a response.
    /// @custom:event-category state-change/escrow-mutation
    event BuyTimedOutRefunded(
        uint64 indexed requestId,
        address indexed buyer,
        uint256 amountIn,
        address caller
    );

    /// @notice A response landed for a buy that was already resolved —
    ///         logged and ignored (first-writer wins).
    /// @custom:event-category informational/crosschain
    event LateResponseDropped(uint64 indexed requestId, BuyStatus currentStatus);

    /// @notice A VPFI delivery landed for a `requestId` with no matching
    ///         (or an already-resolved) pending buy — the two-step guard
    ///         fired. The VPFI is parked as stuck, for {recoverStuckVPFI}.
    /// @custom:event-category informational/crosschain
    event UnsolicitedDelivery(
        uint64 indexed requestId,
        uint256 vpfiAmount,
        BuyStatus pendingStatus
    );

    /// @notice Owner recovered VPFI parked by {UnsolicitedDelivery}.
    /// @custom:event-category state-change/escrow-mutation
    event StuckVPFIRecovered(
        uint64 indexed requestId,
        address indexed recipient,
        uint256 amount
    );

    // ─── Errors ─────────────────────────────────────────────────────────────

    error ZeroAddress();
    error InvalidAmount();
    error MessengerNotSet();
    error BaseChainNotSet();
    error TreasuryNotSet();
    error VpfiTokenNotSet();
    /// @notice {onCrossChainMessage} called by an address other than the
    ///         registered {messenger}.
    error NotMessenger(address caller);
    /// @notice A response arrived from a chain that is not {baseChainId}.
    error WrongSourceChain(uint256 sourceChainId);
    /// @notice A VPFI delivery carried a token that is not {vpfiToken}.
    error UnexpectedDeliveryToken(address token);
    /// @notice Native-mode {buy} `msg.value` did not cover `amountIn`.
    error NativeValueTooLow();
    error InsufficientFee(uint256 provided, uint256 required);
    error PendingBuyNotFound();
    error BuyAlreadyResolved();
    error RefundTimeoutNotElapsed();
    error EthSendFailed();
    error RescueWouldTouchPendingLock();
    error BuyExceedsPerRequestCap(uint256 amountIn, uint256 cap);
    error BuyExceedsDailyCap(uint256 attemptedTotal, uint256 cap);
    error PaymentTokenNotContract(address token);
    error PaymentTokenDecimalsNot18(address token, uint8 decimals);
    error PaymentTokenDecimalsCallFailed(address token);
    error NoStuckVPFI(uint64 requestId);

    // ─── Construction ───────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the adapter proxy.
    /// @param owner_                Owner (admin multi-sig → governance).
    /// @param messenger_            The {ICrossChainMessenger} deployment.
    /// @param baseChainId_          EVM chain id of the canonical chain.
    /// @param treasury_             Local treasury for released payments.
    /// @param paymentToken_         Zero for native-ETH chains; a bridged
    ///                              18-dec WETH ERC20 otherwise.
    /// @param vpfiToken_            Local mirror VPFI ERC20.
    /// @param refundTimeoutSeconds_ Timeout before a stale buy is
    ///                              reclaimable (e.g. 15 minutes).
    /// @param destGasLimit_         Gas for the receiver callback.
    function initialize(
        address owner_,
        address messenger_,
        uint256 baseChainId_,
        address treasury_,
        address paymentToken_,
        address vpfiToken_,
        uint64 refundTimeoutSeconds_,
        uint256 destGasLimit_
    ) external initializer {
        if (
            owner_ == address(0) || messenger_ == address(0)
                || treasury_ == address(0) || vpfiToken_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (baseChainId_ == 0) revert BaseChainNotSet();
        _assertPaymentTokenSane(paymentToken_);

        __Ownable_init(owner_);
        __Ownable2Step_init();
        __GuardianPausable_init();

        messenger = messenger_;
        baseChainId = baseChainId_;
        treasury = treasury_;
        paymentToken = paymentToken_;
        vpfiToken = vpfiToken_;
        refundTimeoutSeconds = refundTimeoutSeconds_;
        destGasLimit = destGasLimit_;

        // Rate limits start disabled; governance sets finite caps before
        // mainnet via {setRateLimits}.
        perRequestCap = type(uint256).max;
        dailyCap = type(uint256).max;

        emit MessengerSet(address(0), messenger_);
        emit BaseChainIdSet(0, baseChainId_);
        emit TreasurySet(address(0), treasury_);
        emit PaymentTokenSet(address(0), paymentToken_);
        emit VPFITokenSet(address(0), vpfiToken_);
        emit RefundTimeoutSet(0, refundTimeoutSeconds_);
        emit DestGasLimitSet(0, destGasLimit_);
        emit RateLimitsSet(type(uint256).max, type(uint256).max);
    }

    // ─── Quote ──────────────────────────────────────────────────────────────

    /// @notice Quote the native cross-chain fee for a {buy}. The UI calls
    ///         this first.
    /// @param amountIn   Wei the user will commit.
    /// @param minVpfiOut Slippage guard, forwarded to Base.
    /// @return nativeFee Fee in this chain's native token. Native-mode
    ///         {buy} needs `msg.value == amountIn + nativeFee`; token-mode
    ///         needs `msg.value == nativeFee`.
    function quoteBuy(
        uint256 amountIn,
        uint256 minVpfiOut
    ) external view returns (uint256 nativeFee) {
        if (messenger == address(0)) revert MessengerNotSet();
        bytes memory payload =
            abi.encode(nextRequestId + 1, msg.sender, amountIn, minVpfiOut);
        nativeFee = ICrossChainMessenger(messenger).quoteMessageFee(
            baseChainId, payload, _noTokens(), destGasLimit
        );
    }

    // ─── User entry ─────────────────────────────────────────────────────────

    /// @notice Buy VPFI on Base at the fixed rate, from this chain.
    /// @dev Native mode: `msg.value == amountIn + <quoted fee>`. Token
    ///      mode: the adapter pulls `amountIn` of {paymentToken} and
    ///      `msg.value == <quoted fee>`. The adapter re-quotes the exact
    ///      CCIP fee and forwards only that; any surplus the buyer
    ///      supplied (a padded or stale {quoteBuy} — CCIP fees fluctuate)
    ///      is refunded to the buyer, never stranded in the adapter.
    /// @param amountIn   Wei (ETH-denominated) the buyer stakes.
    /// @param minVpfiOut Slippage guard forwarded to Base.
    /// @return requestId Tracking id for {reclaimTimedOutBuy} + events.
    /// @return messageId Opaque cross-chain message id, for tracing.
    function buy(
        uint256 amountIn,
        uint256 minVpfiOut
    )
        external
        payable
        whenNotPaused
        nonReentrant
        returns (uint64 requestId, bytes32 messageId)
    {
        if (messenger == address(0)) revert MessengerNotSet();
        if (baseChainId == 0) revert BaseChainNotSet();
        if (treasury == address(0)) revert TreasuryNotSet();
        if (amountIn == 0) revert InvalidAmount();

        // ── Rate-limit gate ──
        if (amountIn > perRequestCap) {
            revert BuyExceedsPerRequestCap(amountIn, perRequestCap);
        }
        if (block.timestamp >= dailyWindowStart + 1 days) {
            dailyWindowStart = block.timestamp;
            dailyUsed = 0;
            emit DailyWindowReset(block.timestamp);
        }
        uint256 newDailyUsed = dailyUsed + amountIn;
        if (newDailyUsed > dailyCap) {
            revert BuyExceedsDailyCap(newDailyUsed, dailyCap);
        }
        dailyUsed = newDailyUsed;

        unchecked {
            ++nextRequestId;
        }
        requestId = nextRequestId;

        // ── Lock / pull funds; isolate the cross-chain fee ──
        address token = paymentToken;
        uint256 nativeFee;
        if (token == address(0)) {
            if (msg.value < amountIn) revert NativeValueTooLow();
            unchecked {
                nativeFee = msg.value - amountIn;
            }
        } else {
            IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
            nativeFee = msg.value;
        }

        bytes memory payload =
            abi.encode(requestId, msg.sender, amountIn, minVpfiOut);

        // Re-quote the exact CCIP fee and forward only that. Forwarding
        // the buyer's full `nativeFee` would land any overpayment in the
        // messenger's refund to THIS adapter (its `msg.sender`), where it
        // is stranded — so the adapter quotes, sends exact, and returns
        // the surplus to the buyer below (CEI).
        uint256 ccipFee = ICrossChainMessenger(messenger).quoteMessageFee(
            baseChainId, payload, _noTokens(), destGasLimit
        );
        if (nativeFee < ccipFee) revert InsufficientFee(nativeFee, ccipFee);

        messageId = ICrossChainMessenger(messenger).sendMessage{
            value: ccipFee
        }(baseChainId, payload, _noTokens(), destGasLimit);

        pendingBuys[requestId] = PendingBuy({
            buyer: msg.sender,
            amountIn: uint96(amountIn),
            initiatedAt: uint64(block.timestamp),
            status: BuyStatus.Pending
        });
        totalPendingAmountIn += amountIn;

        emit BuyRequested(
            requestId, msg.sender, baseChainId, amountIn, minVpfiOut, messageId
        );

        // CEI: refund the fee surplus last, after every state write. The
        // surplus is always native gas — CCIP's fee token is native even
        // in token-payment mode.
        uint256 feeSurplus;
        unchecked {
            feeSurplus = nativeFee - ccipFee;
        }
        if (feeSurplus > 0) {
            (bool ok, ) = payable(msg.sender).call{value: feeSurplus}("");
            if (!ok) revert EthSendFailed();
        }
    }

    // ─── Timeout refund ─────────────────────────────────────────────────────

    /// @notice Permissionless refund of a PENDING buy whose response never
    ///         arrived within {refundTimeoutSeconds}. The refund always
    ///         goes to the recorded buyer, never the caller; a later
    ///         response for the id is then dropped (first-writer wins).
    function reclaimTimedOutBuy(uint64 requestId) external nonReentrant {
        PendingBuy storage p = pendingBuys[requestId];
        if (p.buyer == address(0)) revert PendingBuyNotFound();
        if (p.status != BuyStatus.Pending) revert BuyAlreadyResolved();
        if (block.timestamp < uint256(p.initiatedAt) + refundTimeoutSeconds) {
            revert RefundTimeoutNotElapsed();
        }

        p.status = BuyStatus.ResolvedTimedOut;
        uint256 amt = uint256(p.amountIn);
        totalPendingAmountIn -= amt;
        _returnFunds(p.buyer, amt);

        emit BuyTimedOutRefunded(requestId, p.buyer, amt, msg.sender);
    }

    // ─── Inbound — the {ICrossChainMessageRecipient} port ───────────────────

    /// @inheritdoc ICrossChainMessageRecipient
    /// @dev Two response shapes, told apart by whether tokens accompany
    ///      the message (see {IVpfiBuyCcipMessages}):
    ///       - tokens present → a VPFI delivery (success). The two-step
    ///         guard runs: the VPFI is released to the buyer only if it
    ///         matches an own PENDING `pendingBuys` record.
    ///       - no tokens → a BUY_FAILED; the locked payment is refunded.
    ///      Callable only by the registered {messenger}.
    function onCrossChainMessage(
        uint256 sourceChainId,
        address /* sourceSender */,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens
    ) external override whenNotPaused nonReentrant {
        if (msg.sender != messenger) revert NotMessenger(msg.sender);
        // Defence in depth: the messenger has already authenticated the
        // channel peer, but a buy response must only ever come from Base.
        if (sourceChainId != baseChainId) {
            revert WrongSourceChain(sourceChainId);
        }

        if (tokens.length > 0) {
            _handleDelivery(payload, tokens);
        } else {
            _handleFailure(payload);
        }
    }

    /// @dev VPFI-delivery (success) path — the design-§5 two-step release.
    ///      The VPFI has already been transferred to this adapter by the
    ///      messenger; it is forwarded to the buyer ONLY against an own
    ///      authoritative PENDING record. Anything else is parked stuck.
    function _handleDelivery(
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens
    ) internal {
        uint64 requestId = abi.decode(payload, (uint64));
        if (tokens[0].token != vpfiToken) {
            revert UnexpectedDeliveryToken(tokens[0].token);
        }
        uint256 vpfiAmount = tokens[0].amount;

        PendingBuy storage p = pendingBuys[requestId];

        // No own record (a forged/unknown request) OR already resolved
        // (a replayed/late delivery): park the VPFI as stuck. The
        // attacker / duplicate gets nothing routed anywhere.
        if (p.buyer == address(0) || p.status != BuyStatus.Pending) {
            stuckVPFIByRequest[requestId] += vpfiAmount;
            totalStuckVPFI += vpfiAmount;
            emit UnsolicitedDelivery(
                requestId,
                vpfiAmount,
                p.buyer == address(0) ? BuyStatus.None : p.status
            );
            return;
        }

        // Happy path — flip status first (CEI), then move value.
        p.status = BuyStatus.ResolvedSuccess;
        uint256 amt = uint256(p.amountIn);
        totalPendingAmountIn -= amt;

        IERC20(vpfiToken).safeTransfer(p.buyer, vpfiAmount);
        _releaseToTreasury(amt);

        emit BuyResolvedSuccess(requestId, p.buyer, amt, vpfiAmount);
    }

    /// @dev BUY_FAILED path — refund the locked payment to the buyer.
    function _handleFailure(bytes calldata payload) internal {
        (uint64 requestId, uint8 reason) =
            abi.decode(payload, (uint64, uint8));

        PendingBuy storage p = pendingBuys[requestId];
        if (p.buyer == address(0) || p.status != BuyStatus.Pending) {
            emit LateResponseDropped(
                requestId,
                p.buyer == address(0) ? BuyStatus.None : p.status
            );
            return;
        }

        p.status = BuyStatus.ResolvedRefunded;
        uint256 amt = uint256(p.amountIn);
        totalPendingAmountIn -= amt;
        _returnFunds(p.buyer, amt);

        emit BuyRefunded(requestId, p.buyer, amt, reason);
    }

    /// @notice Owner recovery for VPFI parked by {UnsolicitedDelivery}.
    /// @dev `totalStuckVPFI` is decremented atomically so a compromised
    ///      owner cannot sweep VPFI tied to other stuck ids.
    function recoverStuckVPFI(
        uint64 requestId,
        address recipient
    ) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 amt = stuckVPFIByRequest[requestId];
        if (amt == 0) revert NoStuckVPFI(requestId);
        stuckVPFIByRequest[requestId] = 0;
        totalStuckVPFI -= amt;
        IERC20(vpfiToken).safeTransfer(recipient, amt);
        emit StuckVPFIRecovered(requestId, recipient, amt);
    }

    // ─── Internal helpers ───────────────────────────────────────────────────

    /// @dev Empty token list — the BUY_REQUEST and BUY_FAILED legs are
    ///      data-only.
    function _noTokens()
        internal
        pure
        returns (ICrossChainMessenger.TokenAmount[] memory)
    {
        return new ICrossChainMessenger.TokenAmount[](0);
    }

    /// @dev Return locked funds to a buyer (native call or ERC20 transfer).
    function _returnFunds(address to, uint256 amount) internal {
        if (amount == 0) return;
        address token = paymentToken;
        if (token == address(0)) {
            (bool ok, ) = payable(to).call{value: amount}("");
            if (!ok) revert EthSendFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    /// @dev Release a settled buy's locked funds to treasury.
    function _releaseToTreasury(uint256 amount) internal {
        if (amount == 0) return;
        address token = paymentToken;
        if (token == address(0)) {
            (bool ok, ) = payable(treasury).call{value: amount}("");
            if (!ok) revert EthSendFailed();
        } else {
            IERC20(token).safeTransfer(treasury, amount);
        }
    }

    /// @dev A non-zero payment token must have bytecode and report
    ///      exactly 18 decimals — catches an EOA / wrong-decimals
    ///      stablecoin / non-ERC20 pasted into the config.
    function _assertPaymentTokenSane(address token) internal view {
        if (token == address(0)) return;
        if (token.code.length == 0) revert PaymentTokenNotContract(token);
        try IERC20Metadata(token).decimals() returns (uint8 d) {
            if (d != 18) revert PaymentTokenDecimalsNot18(token, d);
        } catch {
            revert PaymentTokenDecimalsCallFailed(token);
        }
    }

    /// @dev Accept native funds — cross-chain fee refunds from the
    ///      messenger and ops top-ups land here.
    receive() external payable {}

    // ─── Admin ──────────────────────────────────────────────────────────────

    function setMessenger(address newMessenger) external onlyOwner {
        if (newMessenger == address(0)) revert ZeroAddress();
        emit MessengerSet(messenger, newMessenger);
        messenger = newMessenger;
    }

    function setBaseChainId(uint256 newChainId) external onlyOwner {
        if (newChainId == 0) revert BaseChainNotSet();
        emit BaseChainIdSet(baseChainId, newChainId);
        baseChainId = newChainId;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasurySet(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @notice Rotate the payment token. Validated up-front; only change
    ///         when there are no PENDING buys (locked balances would
    ///         otherwise refund in the wrong asset).
    function setPaymentToken(address newToken) external onlyOwner {
        _assertPaymentTokenSane(newToken);
        emit PaymentTokenSet(paymentToken, newToken);
        paymentToken = newToken;
    }

    function setVPFIToken(address newToken) external onlyOwner {
        if (newToken == address(0)) revert ZeroAddress();
        emit VPFITokenSet(vpfiToken, newToken);
        vpfiToken = newToken;
    }

    function setRefundTimeout(uint64 newSeconds) external onlyOwner {
        emit RefundTimeoutSet(refundTimeoutSeconds, newSeconds);
        refundTimeoutSeconds = newSeconds;
    }

    function setDestGasLimit(uint256 newLimit) external onlyOwner {
        emit DestGasLimitSet(destGasLimit, newLimit);
        destGasLimit = newLimit;
    }

    /// @notice Configure the per-request and rolling-24h `amountIn` caps.
    ///         `type(uint256).max` disables a bound.
    function setRateLimits(
        uint256 perRequestCap_,
        uint256 dailyCap_
    ) external onlyOwner {
        perRequestCap = perRequestCap_;
        dailyCap = dailyCap_;
        emit RateLimitsSet(perRequestCap_, dailyCap_);
    }

    /// @notice The configured caps, as one tuple — for deploy-time
    ///         health checks.
    function getRateLimits()
        external
        view
        returns (uint256 perRequestCap_, uint256 dailyCap_)
    {
        return (perRequestCap, dailyCap);
    }

    // ─── Emergency pause ────────────────────────────────────────────────────

    /// @notice Freeze {buy} and inbound response handling. Guardian or
    ///         owner. A paused inbound reverts — CCIP records the message
    ///         as failed, re-executable once unpaused, so no response is
    ///         lost.
    function pause() external onlyGuardianOrOwner {
        _pause();
    }

    /// @notice Resume. Owner-only.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── Rescue ─────────────────────────────────────────────────────────────

    /// @notice Owner-only: drain loose ETH. In native mode, refuses to
    ///         drain below {totalPendingAmountIn}.
    function rescueETH(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (paymentToken == address(0)) {
            uint256 bal = address(this).balance;
            if (amount > bal || bal - amount < totalPendingAmountIn) {
                revert RescueWouldTouchPendingLock();
            }
        }
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert EthSendFailed();
    }

    /// @notice Owner-only: drain an ERC20. Refuses to drain the payment
    ///         token below {totalPendingAmountIn}, or {vpfiToken} below
    ///         {totalStuckVPFI} — buyer funds and stuck VPFI are
    ///         protected from a compromised owner. Use {recoverStuckVPFI}
    ///         to release parked VPFI.
    function rescueERC20(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 floor;
        if (token == paymentToken && paymentToken != address(0)) {
            floor = totalPendingAmountIn;
        } else if (token == vpfiToken) {
            floor = totalStuckVPFI;
        }
        if (floor > 0) {
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (amount > bal || bal - amount < floor) {
                revert RescueWouldTouchPendingLock();
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
