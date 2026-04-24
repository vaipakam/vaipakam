// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {OAppUpgradeable, Origin, MessagingFee, MessagingReceipt} from "@layerzerolabs/oapp-evm-upgradeable/contracts/oapp/OAppUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IVPFIBuyMessages} from "../interfaces/IVPFIBuyMessages.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {LZGuardianPausable} from "./LZGuardianPausable.sol";

/**
 * @title VPFIBuyAdapter
 * @author Vaipakam Developer Team
 * @notice Non-Base OApp wrapping the Early Fixed-Rate VPFI Buy Program
 *         so users can purchase VPFI from their origin chain. Paired 1:1
 *         with a {VPFIBuyReceiver} on Base.
 *
 * @dev Dual-mode payment:
 *        - `paymentToken == address(0)`: native ETH. User calls
 *          {buy} with `msg.value == amountIn + lzFee`. Adapter holds
 *          the `amountIn` ETH locked until Base responds.
 *        - `paymentToken != address(0)`: ERC20 (e.g. WETH on Polygon).
 *          User pre-approves adapter, calls {buy}, adapter
 *          `safeTransferFrom`s `amountIn` of the token. `msg.value`
 *          covers only the LayerZero fee. `amountIn` is still
 *          expressed in ETH-denominated wei (1e18 = 1 ETH) so the
 *          Base-side fixed rate contract sees a uniform quote.
 *
 *      Request lifecycle:
 *        1. {buy}(amountIn, minVpfiOut, options) → locks `amountIn`,
 *           mints `requestId`, sends BUY_REQUEST to Base, emits
 *           {BuyRequested} (the "purchase receipt" event the frontend
 *           polls for a LayerZero GUID).
 *        2a. BUY_SUCCESS inbound → adapter releases `amountIn` to
 *            `treasury`, marks the request Resolved. VPFI arrives
 *            separately via OFT receive on the user's origin chain.
 *        2b. BUY_FAILED inbound → adapter refunds `amountIn` to buyer,
 *            marks Refunded.
 *        3. If no response arrives within {refundTimeoutSeconds}, any
 *           caller can trigger {reclaimTimedOutBuy}(requestId) and
 *           the buyer gets their stake back. Late responses for that
 *           id are then rejected.
 *
 *      Trust model:
 *        - `_lzReceive` inherits OAppReceiver's `msg.sender == endpoint`
 *          and `peer == _origin.sender` checks — only the paired Base
 *          receiver can land responses here.
 *        - Buyer identity is pinned on adapter side (mapped against
 *          `msg.sender` at buy time) — the Base response echoes
 *          `requestId` only; we never trust the origin chain to re-send
 *          a buyer address.
 *
 *      Per CLAUDE.md convention this OApp is UUPS so future endpoint
 *      migrations or payload-format changes preserve the peer mesh.
 */
contract VPFIBuyAdapter is
    Initializable,
    OAppUpgradeable,
    Ownable2StepUpgradeable,
    LZGuardianPausable,
    UUPSUpgradeable,
    IVPFIBuyMessages,
    IVaipakamErrors
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

    /// @notice LayerZero eid of the Base receiver peer. Destination of
    ///         every {buy} BUY_REQUEST. Owner-configurable.
    uint32 public receiverEid;

    /// @notice Treasury on this chain — receives the buyer's locked
    ///         `amountIn` once Base acknowledges BUY_SUCCESS.
    address public treasury;

    /// @notice Payment token. `address(0)` enables native ETH mode;
    ///         a non-zero ERC20 (canonical WETH on Polygon) enables
    ///         pull-token mode. Rate on Base is ETH-denominated, so in
    ///         WETH mode the token MUST be 1:1 with ETH (18 dec).
    address public paymentToken;

    /// @notice Seconds a PendingBuy stays reclaimable-by-anyone before
    ///         its buyer can unilaterally trigger a refund. Default 15m
    ///         at initialize; admin-tunable via {setRefundTimeout}.
    uint64 public refundTimeoutSeconds;

    /// @notice Executor options used on the outbound BUY_REQUEST.
    ///         Must encode `lzReceiveOption` gas budget big enough to
    ///         cover the Base-side Diamond debit + OFT quoteSend.
    bytes public buyOptions;

    /// @notice Monotonic counter used to mint unique request ids.
    uint64 public nextRequestId;

    /// @notice requestId → PendingBuy state.
    mapping(uint64 => PendingBuy) public pendingBuys;

    /// @notice Sum of `amountIn` for every buy currently in {BuyStatus.Pending}.
    ///         Locked against ops rescue: {rescueETH} (native mode) and
    ///         {rescueERC20} (WETH mode) refuse to drain below this figure,
    ///         so a compromised owner cannot sweep buyer funds still awaiting
    ///         a Base response. Incremented on {buy}, decremented whenever a
    ///         pending buy transitions to Resolved* (success / refund /
    ///         timeout).
    uint256 public totalPendingAmountIn;

    // ─── Rate limits (defence-in-depth) ─────────────────────────────────────

    /// @notice Max `amountIn` per single {buy} call, in the adapter's
    ///         native payment unit (wei for ETH mode, token units for
    ///         WETH mode — always 18-dec, 1:1 with ETH). Set via
    ///         {setRateLimits}. Initialized to `type(uint256).max` so
    ///         existing tests and testnet deploys aren't affected until
    ///         governance explicitly enables the cap on mainnet.
    /// @dev Layered above the Diamond-side caps (`globalCap`,
    ///      `perWalletCap`) on the Base canonical chain. If a compromised
    ///      DVN landed a forged BUY_REQUEST, this caps the damage to at
    ///      most one per-request worth of locked funds on the adapter.
    uint256 public perRequestCap;

    /// @notice Max cumulative `amountIn` accepted within a rolling 24h
    ///         window. Second-layer bound against rapid repeat-attacks
    ///         that fit inside the per-request cap individually. Also
    ///         initialized to `type(uint256).max`.
    uint256 public dailyCap;

    /// @notice Anchor timestamp for the current 24h window. Resets when
    ///         `block.timestamp >= dailyWindowStart + 1 days`. Not a true
    ///         rolling window (that would require a per-buy log); in
    ///         practice a "first-buy anchored" tumbling window closes the
    ///         midnight-burst exploit that fixed-clock windows have.
    uint256 public dailyWindowStart;

    /// @notice `amountIn` accumulated during the current window. Reset
    ///         alongside `dailyWindowStart`.
    uint256 public dailyUsed;

    // ─── Events ─────────────────────────────────────────────────────────────

    event ReceiverEidSet(uint32 indexed oldEid, uint32 indexed newEid);
    event TreasurySet(address indexed oldTreasury, address indexed newTreasury);
    event PaymentTokenSet(address indexed oldToken, address indexed newToken);
    event RefundTimeoutSet(uint64 oldSeconds, uint64 newSeconds);
    event BuyOptionsSet(bytes options);
    event RateLimitsSet(uint256 perRequestCap, uint256 dailyCap);
    event DailyWindowReset(uint256 newWindowStart);

    /// @notice Purchase receipt — emitted synchronously when the user
    ///         calls {buy}. The frontend uses `(requestId, lzGuid)` to
    ///         render a "pending transaction" view with a direct link
    ///         into LayerZero Scan. No estimated-out field — the rate
    ///         lives on Base, not this chain, and a cross-chain quote
    ///         preview would require a second LayerZero round trip.
    event BuyRequested(
        uint64 indexed requestId,
        address indexed buyer,
        uint32 indexed dstEid,
        uint256 amountIn,
        uint256 minVpfiOut,
        bytes32 lzGuid
    );

    /// @notice Base accepted the buy. `amountIn` released to treasury.
    event BuyResolvedSuccess(
        uint64 indexed requestId,
        address indexed buyer,
        uint256 amountIn,
        uint256 vpfiOut
    );

    /// @notice Base rejected the buy. `amountIn` refunded to buyer.
    event BuyRefunded(
        uint64 indexed requestId,
        address indexed buyer,
        uint256 amountIn,
        uint8 reason
    );

    /// @notice Buyer (or anyone) reclaimed a stale PENDING buy after
    ///         {refundTimeoutSeconds} elapsed without a Base response.
    event BuyTimedOutRefunded(
        uint64 indexed requestId,
        address indexed buyer,
        uint256 amountIn,
        address caller
    );

    /// @notice Late BUY_SUCCESS / BUY_FAILED landed after the buy was
    ///         already resolved (typically timed-out then manually
    ///         refunded). Payload is logged but ignored.
    event LateResponseDropped(
        uint64 indexed requestId,
        uint8 msgType,
        BuyStatus currentStatus
    );

    // ─── Errors ─────────────────────────────────────────────────────────────

    error ReceiverEidNotSet();
    error TreasuryNotSet();
    error NativeValueMismatch();
    error UnexpectedNativeValue();
    error PendingBuyNotFound();
    error BuyAlreadyResolved();
    error RefundTimeoutNotElapsed();
    error UnknownMessageType(uint8 msgType);
    error EthSendFailed();
    error RescueWouldTouchPendingLock();
    error BuyExceedsPerRequestCap(uint256 amountIn, uint256 cap);
    error BuyExceedsDailyCap(uint256 attemptedTotal, uint256 cap);

    // ─── Construction ───────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address lzEndpoint) OAppUpgradeable(lzEndpoint) {
        _disableInitializers();
    }

    /**
     * @notice Initialize the adapter proxy.
     * @param owner_          OApp owner / LayerZero delegate.
     * @param receiverEid_    LayerZero eid of the Base {VPFIBuyReceiver}.
     * @param treasury_       Local treasury that receives released ETH / token.
     * @param paymentToken_   Zero for native-ETH chains (Eth/Arb/Op);
     *                        canonical WETH ERC20 for Polygon.
     * @param buyOptions_     Executor options for the BUY_REQUEST leg
     *                        (may be empty at init; owner must set).
     * @param refundTimeoutSeconds_ Timeout before a PENDING buy is
     *                              reclaimable. Sensible default 15m.
     */
    function initialize(
        address owner_,
        uint32 receiverEid_,
        address treasury_,
        address paymentToken_,
        bytes calldata buyOptions_,
        uint64 refundTimeoutSeconds_
    ) external initializer {
        if (owner_ == address(0) || treasury_ == address(0)) {
            revert InvalidAddress();
        }

        __OApp_init(owner_);
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __LZGuardianPausable_init();

        receiverEid = receiverEid_;
        treasury = treasury_;
        paymentToken = paymentToken_;
        buyOptions = buyOptions_;
        refundTimeoutSeconds = refundTimeoutSeconds_;

        // Rate limits start disabled (type(uint256).max). Governance is
        // expected to call {setRateLimits} with finite caps before mainnet
        // goes live — the ConfigureLZConfig.s.sol rollout script is the
        // enforcement point.
        perRequestCap = type(uint256).max;
        dailyCap = type(uint256).max;

        emit ReceiverEidSet(0, receiverEid_);
        emit TreasurySet(address(0), treasury_);
        emit PaymentTokenSet(address(0), paymentToken_);
        emit RefundTimeoutSet(0, refundTimeoutSeconds_);
        emit RateLimitsSet(type(uint256).max, type(uint256).max);
    }

    // ─── Emergency pause + rate-limit admin ─────────────────────────────────

    /// @notice Pause user-initiated {buy} calls and inbound response
    ///         handling. Callable by either the guardian (incident-response
    ///         multi-sig, no timelock) or the owner (timelock-gated multi-
    ///         sig). The guardian path exists so the pause can land inside
    ///         the detect-to-freeze window that a 48h timelock would
    ///         otherwise foreclose. When `_lzReceive` is paused it reverts
    ///         — LZ retries the packet after `unpause()` so legitimate
    ///         responses aren't dropped.
    function pause() external onlyGuardianOrOwner {
        _pause();
    }

    /// @notice Resume {buy} and inbound response handling after an incident
    ///         has been investigated and resolved.
    /// @dev Deliberately owner-only. Recovery must travel the full
    ///      governance path — a compromised or impatient guardian must
    ///      not be able to race the incident team to unpause.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Configure the per-request and rolling-24h `amountIn` caps.
    ///         Tunable at any time by the timelock / multi-sig owner.
    /// @dev Pass `type(uint256).max` on either field to disable that
    ///      individual bound (the initialize default). Does not reset the
    ///      current window's `dailyUsed` — tightening a cap mid-window is
    ///      intentionally conservative (next {buy} evaluates the new cap
    ///      against the existing spend).
    /// @param perRequestCap_ Max `amountIn` for a single {buy} call.
    /// @param dailyCap_      Max cumulative `amountIn` in a 24h window.
    function setRateLimits(
        uint256 perRequestCap_,
        uint256 dailyCap_
    ) external onlyOwner {
        perRequestCap = perRequestCap_;
        dailyCap = dailyCap_;
        emit RateLimitsSet(perRequestCap_, dailyCap_);
    }

    // ─── Public quote ───────────────────────────────────────────────────────

    /// @notice Quote the LayerZero native fee for a BUY_REQUEST. UI
    ///         should call this before invoking {buy}.
    /// @param amountIn Wei amount the user is about to commit.
    /// @param minVpfiOut Slippage guard forwarded to Base.
    /// @return fee LayerZero fee (native). In ETH mode, user's
    ///             `msg.value` must equal `amountIn + fee.nativeFee`.
    ///             In WETH mode, `msg.value == fee.nativeFee`.
    function quoteBuy(
        uint256 amountIn,
        uint256 minVpfiOut
    ) external view returns (MessagingFee memory fee) {
        if (receiverEid == 0) revert ReceiverEidNotSet();
        uint64 previewId = nextRequestId + 1;
        bytes memory payload = _encodeBuyRequest(
            previewId,
            msg.sender,
            amountIn,
            minVpfiOut
        );
        fee = _quote(receiverEid, payload, buyOptions, false);
    }

    // ─── User entry ─────────────────────────────────────────────────────────

    /**
     * @notice Purchase VPFI on Base at the fixed rate from this chain.
     *
     * @dev Native mode (`paymentToken == 0`): `msg.value` MUST equal
     *      `amountIn + fee.nativeFee`. The adapter keeps `amountIn`
     *      locked and spends `fee.nativeFee` on the LayerZero send.
     *
     *      WETH mode: `safeTransferFrom(caller, adapter, amountIn)`
     *      pulls the token; `msg.value` must equal `fee.nativeFee`.
     *
     * @param amountIn    Wei (ETH-denominated) the buyer is staking.
     * @param minVpfiOut  Slippage guard forwarded verbatim to Base. On
     *                    Base, {processBridgedBuy} reverts and we
     *                    receive BUY_FAILED if the quote undershoots.
     * @return requestId  Tracking id — use with {reclaimTimedOutBuy}
     *                    and for event correlation.
     * @return lzGuid     LayerZero GUID — deep-link into LZScan.
     */
    function buy(
        uint256 amountIn,
        uint256 minVpfiOut
    )
        external
        payable
        whenNotPaused
        returns (uint64 requestId, bytes32 lzGuid)
    {
        if (receiverEid == 0) revert ReceiverEidNotSet();
        if (treasury == address(0)) revert TreasuryNotSet();
        if (amountIn == 0) revert InvalidAmount();

        // Rate-limit checks. Per-request cap short-circuits a single
        // oversize attempt; the rolling-24h window catches rapid repeat
        // attempts below the per-request bound. Both default to
        // `type(uint256).max` (disabled) until governance tightens them.
        if (amountIn > perRequestCap) {
            revert BuyExceedsPerRequestCap(amountIn, perRequestCap);
        }
        if (block.timestamp >= dailyWindowStart + 1 days) {
            // Window expired (or first buy post-deploy): anchor a new one
            // to `now` and clear usage. "First-buy anchored" tumbling
            // closes the midnight-burst exploit that fixed-clock windows
            // have — the earliest possible reset after a large buy is
            // `now + 24h`.
            dailyWindowStart = block.timestamp;
            dailyUsed = 0;
            emit DailyWindowReset(block.timestamp);
        }
        uint256 newDailyUsed = dailyUsed + amountIn;
        if (newDailyUsed > dailyCap) {
            revert BuyExceedsDailyCap(newDailyUsed, dailyCap);
        }
        dailyUsed = newDailyUsed;

        // Mint request id FIRST so the outbound payload is final. The
        // state write follows the LZ send so a send revert rolls the id
        // back too (EVM reverts are atomic).
        unchecked {
            ++nextRequestId;
        }
        requestId = nextRequestId;

        // Pull or lock funds.
        address token = paymentToken;
        uint256 nativeFee;
        if (token == address(0)) {
            if (msg.value < amountIn) revert NativeValueMismatch();
            unchecked {
                nativeFee = msg.value - amountIn;
            }
        } else {
            IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
            nativeFee = msg.value;
        }

        bytes memory payload = _encodeBuyRequest(
            requestId,
            msg.sender,
            amountIn,
            minVpfiOut
        );

        MessagingReceipt memory r = _lzSend(
            receiverEid,
            payload,
            buyOptions,
            MessagingFee({nativeFee: nativeFee, lzTokenFee: 0}),
            payable(msg.sender)
        );
        lzGuid = r.guid;

        pendingBuys[requestId] = PendingBuy({
            buyer: msg.sender,
            amountIn: uint96(amountIn),
            initiatedAt: uint64(block.timestamp),
            status: BuyStatus.Pending
        });
        totalPendingAmountIn += amountIn;

        emit BuyRequested(
            requestId,
            msg.sender,
            receiverEid,
            amountIn,
            minVpfiOut,
            lzGuid
        );
    }

    // ─── Timeout refund ─────────────────────────────────────────────────────

    /**
     * @notice Permissionless refund path for a PENDING buy whose Base
     *         response never arrived within {refundTimeoutSeconds}.
     * @dev Anyone may call — the refund always goes to the recorded
     *      buyer, never the caller. A late BUY_SUCCESS for this id is
     *      subsequently ignored via {LateResponseDropped}, so this path
     *      is safe against races (first-writer wins on status).
     * @param requestId The PENDING buy to settle.
     */
    function reclaimTimedOutBuy(uint64 requestId) external {
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

        emit BuyTimedOutRefunded(
            requestId,
            p.buyer,
            amt,
            msg.sender
        );
    }

    // ─── Receive (endpoint) ─────────────────────────────────────────────────

    function _lzReceive(
        Origin calldata /*_origin*/,
        bytes32 /*_guid*/,
        bytes calldata _message,
        address /*_executor*/,
        bytes calldata /*_extraData*/
    ) internal override whenNotPaused {
        (uint8 msgType, uint64 requestId, uint256 vpfiOut, uint8 reason) = abi
            .decode(_message, (uint8, uint64, uint256, uint8));

        PendingBuy storage p = pendingBuys[requestId];
        if (p.buyer == address(0)) {
            // Unknown request — either never existed or state was never
            // written (shouldn't happen on happy path). Log and drop.
            emit LateResponseDropped(requestId, msgType, BuyStatus.None);
            return;
        }
        if (p.status != BuyStatus.Pending) {
            emit LateResponseDropped(requestId, msgType, p.status);
            return;
        }

        uint256 amt = uint256(p.amountIn);
        if (msgType == MSG_TYPE_BUY_SUCCESS) {
            p.status = BuyStatus.ResolvedSuccess;
            totalPendingAmountIn -= amt;
            _releaseToTreasury(amt);
            emit BuyResolvedSuccess(requestId, p.buyer, amt, vpfiOut);
        } else if (msgType == MSG_TYPE_BUY_FAILED) {
            p.status = BuyStatus.ResolvedRefunded;
            totalPendingAmountIn -= amt;
            _returnFunds(p.buyer, amt);
            emit BuyRefunded(requestId, p.buyer, amt, reason);
        } else {
            revert UnknownMessageType(msgType);
        }
    }

    // ─── Internals ──────────────────────────────────────────────────────────

    function _encodeBuyRequest(
        uint64 requestId,
        address buyer,
        uint256 amountIn,
        uint256 minVpfiOut
    ) internal view returns (bytes memory) {
        // Adapter runs on the *local* chain so `originEid` is the LZ eid
        // of this chain. OAppCore exposes it via `endpoint.eid()`.
        uint32 myEid = endpoint.eid();
        return
            abi.encode(
                MSG_TYPE_BUY_REQUEST,
                requestId,
                buyer,
                myEid,
                amountIn,
                minVpfiOut
            );
    }

    /// @dev Return locked funds to the buyer. Native-ETH mode uses a
    ///      low-level call; WETH mode uses safeTransfer.
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

    /// @dev Release locked funds to treasury on BUY_SUCCESS.
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

    // ─── Overrides ──────────────────────────────────────────────────────────

    /// @dev In native mode, `msg.value` includes the user's `amountIn`
    ///      on top of the fee, so the default OAppSender check
    ///      (`msg.value == _nativeFee`) would revert. We validate the
    ///      split ourselves in {buy}.
    function _payNative(
        uint256 _nativeFee
    ) internal virtual override returns (uint256) {
        return _nativeFee;
    }

    receive() external payable {
        // Refunds from the endpoint on BUY_REQUEST overpay land here.
        // Intentionally no-op: kept by the adapter and drained via
        // {rescueETH} if needed.
    }

    // ─── Admin setters ──────────────────────────────────────────────────────

    function setReceiverEid(uint32 newEid) external onlyOwner {
        uint32 old = receiverEid;
        receiverEid = newEid;
        emit ReceiverEidSet(old, newEid);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidAddress();
        address old = treasury;
        treasury = newTreasury;
        emit TreasurySet(old, newTreasury);
    }

    /// @notice Rotate the payment token. Setting a non-zero token
    ///         flips the adapter into WETH-pull mode. CAUTION: only
    ///         change when there are no PENDING buys — existing locked
    ///         balances would refund in the wrong asset.
    function setPaymentToken(address newToken) external onlyOwner {
        address old = paymentToken;
        paymentToken = newToken;
        emit PaymentTokenSet(old, newToken);
    }

    function setRefundTimeout(uint64 newSeconds) external onlyOwner {
        uint64 old = refundTimeoutSeconds;
        refundTimeoutSeconds = newSeconds;
        emit RefundTimeoutSet(old, newSeconds);
    }

    function setBuyOptions(bytes calldata newOptions) external onlyOwner {
        buyOptions = newOptions;
        emit BuyOptionsSet(newOptions);
    }

    // ─── Rescue ─────────────────────────────────────────────────────────────

    /// @notice Owner-only: drain loose ETH (e.g. LZ fee-refund dust).
    ///         In native-ETH mode, enforces
    ///         `balance - amount >= totalPendingAmountIn` so a compromised
    ///         owner cannot sweep buyer funds still awaiting a Base
    ///         response. In WETH mode the adapter's ETH balance is only
    ///         LZ-fee dust (buyer ETH never lands here), so the guard is
    ///         a no-op but still cheap to evaluate.
    function rescueETH(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidAddress();
        if (paymentToken == address(0)) {
            uint256 bal = address(this).balance;
            if (amount > bal || bal - amount < totalPendingAmountIn) {
                revert RescueWouldTouchPendingLock();
            }
        }
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert EthSendFailed();
    }

    /// @notice Owner-only: drain a non-payment ERC20 mistakenly sent in.
    ///         In WETH mode, refuses to drain below the pending-lock sum
    ///         for the payment token; other tokens have no protection
    ///         (they aren't backing in-flight buys).
    function rescueERC20(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        if (to == address(0)) revert InvalidAddress();
        if (token == paymentToken && paymentToken != address(0)) {
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (amount > bal || bal - amount < totalPendingAmountIn) {
                revert RescueWouldTouchPendingLock();
            }
        }
        IERC20(token).safeTransfer(to, amount);
    }

    // ─── UUPS / Ownable MRO ─────────────────────────────────────────────────

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {}

    function transferOwnership(
        address newOwner
    )
        public
        override(OwnableUpgradeable, Ownable2StepUpgradeable)
        onlyOwner
    {
        Ownable2StepUpgradeable.transferOwnership(newOwner);
    }

    function _transferOwnership(
        address newOwner
    )
        internal
        override(OwnableUpgradeable, Ownable2StepUpgradeable)
    {
        Ownable2StepUpgradeable._transferOwnership(newOwner);
    }
}
