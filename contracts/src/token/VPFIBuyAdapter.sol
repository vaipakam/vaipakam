// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {OAppUpgradeable, Origin, MessagingFee, MessagingReceipt} from "@layerzerolabs/oapp-evm-upgradeable/contracts/oapp/OAppUpgradeable.sol";
import {IOAppComposer} from "@layerzerolabs/oapp-evm/contracts/oapp/interfaces/IOAppComposer.sol";
import {OFTComposeMsgCodec} from "@layerzerolabs/oft-evm/contracts/libs/OFTComposeMsgCodec.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
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
    IVaipakamErrors,
    IOAppComposer
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

    // ─── T-031 Layer 2: OFT-compose success path ────────────────────────────

    /// @notice Local VPFI ERC20 (the canonical-VPFI mirror on this
    ///         chain). The receiver on Base OFT-composes VPFI here;
    ///         the adapter then `safeTransfer`s the final amount to
    ///         the actual buyer recorded in `pendingBuys`.
    /// @dev    Owner-set via {setVPFIToken}. Held alongside
    ///         `paymentToken` because the two are different tokens —
    ///         `paymentToken` is what the buyer paid in (ETH / WETH),
    ///         `vpfiToken` is what they ultimately receive.
    address public vpfiToken;

    /// @notice Local VPFIMirror (or VPFIOFTAdapter on Base) — the OFT
    ///         contract that calls `endpoint.sendCompose` to dispatch
    ///         `lzCompose` here. Auth gate inside `lzCompose`: only
    ///         compose calls originating from this address are
    ///         honoured. Operator must set after the local mirror
    ///         is deployed.
    address public vpfiMirror;

    /// @notice requestId → stuck VPFI amount on this contract.
    ///         Populated when `lzCompose` lands a VPFI delivery whose
    ///         `requestId` either has no matching `pendingBuys` entry
    ///         (forged BUY_REQUEST scenario — Layer 2 defense fired)
    ///         or matches an already-resolved buy (replay / late). The
    ///         VPFI sits on this contract pending owner recovery via
    ///         {recoverStuckVPFI}.
    mapping(uint64 => uint256) public stuckVPFIByRequest;

    /// @notice Sum of VPFI stuck on this contract pending recovery.
    ///         {rescueERC20}-class flows MUST refuse to drain
    ///         `vpfiToken` below this figure so a compromised owner
    ///         can't sweep VPFI tied to specific stuck request ids.
    uint256 public totalStuckVPFI;

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

    /// @notice Late BUY_FAILED landed after the buy was already
    ///         resolved (typically timed-out then manually refunded).
    ///         Payload is logged but ignored. Pre-Layer-2 this also
    ///         covered late BUY_SUCCESS; that path is gone — success
    ///         arrives via OFT-compose now and {LateComposeStuck}
    ///         covers the equivalent late-success case.
    event LateResponseDropped(
        uint64 indexed requestId,
        uint8 msgType,
        BuyStatus currentStatus
    );

    // ─── T-031 Layer 2 events ────────────────────────────────────────────────

    event VPFITokenSet(address indexed oldToken, address indexed newToken);
    event VPFIMirrorSet(address indexed oldMirror, address indexed newMirror);

    /// @notice OFT-compose landed VPFI on this contract for a request
    ///         id whose `pendingBuys` entry either doesn't exist
    ///         (forged BUY_REQUEST scenario — Layer 2 defense fired)
    ///         or is already resolved. The VPFI is recorded as stuck
    ///         pending owner recovery via {recoverStuckVPFI}.
    event UnsolicitedComposeArrival(
        uint64 indexed requestId,
        uint256 vpfiAmount,
        BuyStatus pendingStatus
    );

    /// @notice Owner recovered VPFI that was stuck on this contract
    ///         from an {UnsolicitedComposeArrival} — typically by
    ///         bridging it back to Base and burning, or routing it
    ///         to a designated recovery wallet.
    event StuckVPFIRecovered(
        uint64 indexed requestId,
        address indexed recipient,
        uint256 amount
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
    /// @dev Operator passed a non-zero `paymentToken` whose address has no
    ///      bytecode (an EOA, or zero-code precompile slot). The receiver's
    ///      wei-per-VPFI rate is denominated in ETH-equivalent value, so on
    ///      non-ETH-native chains the adapter MUST be in WETH-pull mode
    ///      against a real ERC20 contract.
    error PaymentTokenNotContract(address token);
    /// @dev Operator passed a non-zero `paymentToken` whose `decimals()`
    ///      returns ≠ 18. Canonical WETH9 (every chain's bridged-ETH
    ///      ERC20) is 18-dec; an honest wrapped-ETH is 18-dec by
    ///      convention. Most common misconfig this catches: pasting the
    ///      6-dec USDC address by mistake.
    error PaymentTokenDecimalsNot18(address token, uint8 decimals);
    /// @dev `paymentToken.decimals()` reverted (non-IERC20Metadata
    ///      contract, or contract with no view function). Catches the
    ///      operator pasting a random non-ERC20 contract address.
    error PaymentTokenDecimalsCallFailed(address token);

    // T-031 Layer 2 errors — `lzCompose` auth gates.
    /// @dev `lzCompose` was called by something other than the LZ
    ///      endpoint. Only the endpoint dispatcher should ever invoke
    ///      this entrypoint.
    error NotEndpoint(address caller);
    /// @dev `lzCompose` was dispatched with `_from != vpfiMirror`.
    ///      Only OFT-compose calls originating from the local mirror
    ///      OFT contract are honoured.
    error UnauthorizedComposeSource(address from);
    /// @dev `lzCompose` arrived but {vpfiMirror} hasn't been set yet
    ///      by the operator. Same soft-fail philosophy as
    ///      `BuyAdapterNotSet` on the receiver — never accept a
    ///      compose against an unset registry.
    error VpfiMirrorNotSet();
    /// @dev `lzCompose` arrived but {vpfiToken} hasn't been set.
    error VpfiTokenNotSet();
    /// @dev Owner attempted {recoverStuckVPFI} for a requestId that
    ///      has no recorded stuck balance.
    error NoStuckVPFI(uint64 requestId);

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
        // Validate `paymentToken_` BEFORE any state writes. On non-ETH-
        // native chains (BNB, Polygon, etc.) the receiver's wei-per-VPFI
        // rate is denominated in ETH-equivalent value, so the adapter
        // MUST pull a bridged-WETH ERC20 with decimals() == 18 from the
        // user. Native-gas mode (paymentToken_ == address(0)) is only
        // valid on chains where 1 unit of native gas == 1 ETH for the
        // purpose of the rate (Sepolia / OP / Arbitrum / Base / Ethereum
        // mainnet). Operators selecting native-gas mode on BNB / Polygon
        // mainnet would silently mis-price every buy — the deploy
        // script's pre-flight (DeployVPFIBuyAdapter) catches that case
        // by chainId; this contract-side guard catches the operator-
        // misconfig flavour where paymentToken_ is non-zero but points
        // at the wrong contract (an EOA, the wrong-decimals stablecoin,
        // a non-ERC20).
        _assertPaymentTokenSane(paymentToken_);

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

    // ─── lzCompose (success path — T-031 Layer 2) ──────────────────────────

    /**
     * @notice OFT-compose entry point. Fires when the local VPFI mirror
     *         finishes minting the OFT to this contract and the LayerZero
     *         endpoint dispatches the compose payload.
     *
     * @dev Trust + auth: callable only by the LZ endpoint, only with
     *      `_from == vpfiMirror` (the local OFT contract that minted).
     *      The compose payload carries `(uint64 requestId)`. We then
     *      cross-check our own `pendingBuys[requestId]` — the
     *      authoritative local truth set by the actual ETH-paying
     *      tx — and only forward VPFI to the recorded buyer.
     *
     *      Forged BUY_REQUEST defense: a forged buy on the receiver
     *      side mints VPFI on Base which OFT-composes back to this
     *      adapter. Here we look up `pendingBuys[forgedRequestId]`,
     *      find `buyer == address(0)` (no real `buy()` was made for
     *      that id), and record the VPFI as stuck — owner-recoverable
     *      via {recoverStuckVPFI}. The attacker gets nothing.
     *
     *      Replay defense: if the same compose lands twice (LZ retry
     *      pathology), the second call sees `status != Pending` (we
     *      flipped to ResolvedSuccess on the first call) and records
     *      the duplicate VPFI as stuck. No double-payout.
     *
     *      Per IOAppComposer the function must be `payable`. We
     *      ignore any `msg.value` — the executor may forward gas-fee
     *      ETH but no semantic value transfer is expected.
     *
     * @param _from     The OFT contract that triggered the compose
     *                  dispatch — must equal {vpfiMirror}.
     * @param _message  OFTComposeMsgCodec-encoded blob:
     *                  `[nonce(8)][srcEid(4)][amountLD(32)][composeFrom(32)][appMsg…]`.
     *                  `amountLD` is the VPFI minted to this contract;
     *                  `composeMsg` decodes as `(uint64 requestId)`.
     */
    function lzCompose(
        address _from,
        bytes32 /* _guid */,
        bytes calldata _message,
        address /* _executor */,
        bytes calldata /* _extraData */
    ) external payable override whenNotPaused {
        // Auth: only the local LZ endpoint can dispatch compose. The
        // OApp base exposes `endpoint` as the L0 endpoint immutable.
        if (msg.sender != address(endpoint)) revert NotEndpoint(msg.sender);

        address mirror = vpfiMirror;
        if (mirror == address(0)) revert VpfiMirrorNotSet();
        if (_from != mirror) revert UnauthorizedComposeSource(_from);

        address vpfi = vpfiToken;
        if (vpfi == address(0)) revert VpfiTokenNotSet();

        // Decode the OFT-compose envelope. `amountLD` is the VPFI
        // amount minted to this contract; the inner `composeMsg`
        // carries our app payload `(uint64 requestId)`.
        uint256 vpfiAmount = OFTComposeMsgCodec.amountLD(_message);
        bytes memory inner = OFTComposeMsgCodec.composeMsg(_message);
        uint64 requestId = abi.decode(inner, (uint64));

        PendingBuy storage p = pendingBuys[requestId];

        // Forged BUY_REQUEST: no record of this requestId on the
        // adapter. Record VPFI as stuck and exit. Layer 2 defense
        // fires here.
        if (p.buyer == address(0)) {
            stuckVPFIByRequest[requestId] += vpfiAmount;
            totalStuckVPFI += vpfiAmount;
            emit UnsolicitedComposeArrival(
                requestId,
                vpfiAmount,
                BuyStatus.None
            );
            return;
        }

        // Replay / late: this requestId was already resolved (success,
        // refunded, or timed-out). Record VPFI as stuck and exit.
        if (p.status != BuyStatus.Pending) {
            stuckVPFIByRequest[requestId] += vpfiAmount;
            totalStuckVPFI += vpfiAmount;
            emit UnsolicitedComposeArrival(
                requestId,
                vpfiAmount,
                p.status
            );
            return;
        }

        // Happy path. Flip status FIRST (CEI: state-before-effects)
        // so a re-entrant transfer can't re-process the same id.
        p.status = BuyStatus.ResolvedSuccess;
        uint256 amt = uint256(p.amountIn);
        totalPendingAmountIn -= amt;

        // Deliver VPFI to the actual buyer recorded on this chain at
        // the time of `buy()` (NOT the buyer claimed by the compose
        // payload). This is the Layer 2 hardening — the buyer
        // identity comes from authoritative local state, never from
        // a cross-chain message.
        IERC20(vpfi).safeTransfer(p.buyer, vpfiAmount);

        // Release the user's ETH (or WETH) escrow to treasury — the
        // step BUY_SUCCESS used to drive in the pre-Layer-2 protocol.
        _releaseToTreasury(amt);

        emit BuyResolvedSuccess(requestId, p.buyer, amt, vpfiAmount);
    }

    /**
     * @notice Owner recovery path for VPFI stuck on this contract via
     *         {UnsolicitedComposeArrival}. Sweeps the recorded amount
     *         to a designated wallet (typically a Vaipakam recovery
     *         multisig — could later be re-bridged to Base and burned).
     * @dev    Auth: onlyOwner. Reverts if the recorded stuck balance
     *         for `requestId` is zero. {totalStuckVPFI} is decremented
     *         atomically so a compromised owner can't sweep VPFI tied
     *         to other stuck request ids on this contract.
     */
    function recoverStuckVPFI(uint64 requestId, address recipient)
        external
        onlyOwner
    {
        if (recipient == address(0)) revert InvalidAddress();
        uint256 amt = stuckVPFIByRequest[requestId];
        if (amt == 0) revert NoStuckVPFI(requestId);
        stuckVPFIByRequest[requestId] = 0;
        totalStuckVPFI -= amt;
        IERC20(vpfiToken).safeTransfer(recipient, amt);
        emit StuckVPFIRecovered(requestId, recipient, amt);
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
        // T-031 Layer 2: BUY_SUCCESS no longer arrives through this
        // path — success is delivered as an OFT-compose mint to the
        // adapter, handled by `lzCompose`. Only BUY_FAILED remains as
        // an OApp inbound. `vpfiOut` is decoded for the BUY_FAILED
        // payload-shape compatibility but is always 0 on this kind.
        vpfiOut; // silence unused-var lint for the dropped success branch
        if (msgType == MSG_TYPE_BUY_FAILED) {
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
    /// @dev    Validates the new token via {_assertPaymentTokenSane}
    ///         before mutating storage so a misconfigured rotation
    ///         (EOA, non-ERC20, wrong-decimals token) reverts up-front
    ///         rather than corrupting the buy path.
    function setPaymentToken(address newToken) external onlyOwner {
        _assertPaymentTokenSane(newToken);
        address old = paymentToken;
        paymentToken = newToken;
        emit PaymentTokenSet(old, newToken);
    }

    /// @dev Sanity-checks `token` for the WETH-pull mode contract:
    ///        - `address(0)` is the native-gas-mode sentinel — passes
    ///          unconditionally (the deploy-script pre-flight is
    ///          responsible for catching native-gas-mode-on-BNB-mainnet
    ///          and similar economic misconfigs by chainId).
    ///        - Any non-zero token must (a) have bytecode (not an EOA),
    ///          (b) respond to `decimals()`, and (c) return exactly 18.
    ///      The 18-decimal check is the canonical WETH9 invariant and
    ///      catches the most common operator-side misconfig: pasting a
    ///      6-dec stablecoin address (USDC / USDT) where a bridged-WETH
    ///      address belongs. It does NOT prove the token is the
    ///      *canonical* bridged WETH on this chain — that's an
    ///      operational check (deploy-script pre-flight prints
    ///      `name()` / `symbol()` for human-eyeball confirmation
    ///      against the chain's published WETH9 address).
    function _assertPaymentTokenSane(address token) internal view {
        if (token == address(0)) return;
        if (token.code.length == 0) {
            revert PaymentTokenNotContract(token);
        }
        try IERC20Metadata(token).decimals() returns (uint8 d) {
            if (d != 18) {
                revert PaymentTokenDecimalsNot18(token, d);
            }
        } catch {
            revert PaymentTokenDecimalsCallFailed(token);
        }
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

    /// @notice Set the local VPFI ERC20 (mirror on this chain). T-031
    ///         Layer 2: this is the token transferred to buyers when
    ///         `lzCompose` lands. Must be set before bridged buys can
    ///         settle on this chain.
    function setVPFIToken(address newToken) external onlyOwner {
        if (newToken == address(0)) revert InvalidAddress();
        address old = vpfiToken;
        vpfiToken = newToken;
        emit VPFITokenSet(old, newToken);
    }

    /// @notice Set the local OFT mirror — the contract that calls
    ///         `endpoint.sendCompose` to dispatch `lzCompose` here.
    ///         T-031 Layer 2: auth gate inside `lzCompose` requires
    ///         `_from == vpfiMirror`. Operator must set this to the
    ///         deployed VPFIMirror address on this chain (or to the
    ///         canonical VPFIOFTAdapter on Base if this adapter ever
    ///         co-locates on Base).
    function setVPFIMirror(address newMirror) external onlyOwner {
        if (newMirror == address(0)) revert InvalidAddress();
        address old = vpfiMirror;
        vpfiMirror = newMirror;
        emit VPFIMirrorSet(old, newMirror);
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
