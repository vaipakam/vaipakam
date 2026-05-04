// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {OAppUpgradeable, Origin, MessagingFee, MessagingReceipt} from "@layerzerolabs/oapp-evm-upgradeable/contracts/oapp/OAppUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IOFT, SendParam, MessagingFee as OFTMessagingFee, MessagingReceipt as OFTMessagingReceipt, OFTReceipt} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import {IVPFIBuyMessages} from "../interfaces/IVPFIBuyMessages.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {LZGuardianPausable} from "./LZGuardianPausable.sol";

/**
 * @title VPFIBuyReceiver
 * @author Vaipakam Developer Team
 * @notice Base-only LayerZero OApp that lands bridged fixed-rate VPFI
 *         buys. Paired 1:1 with a {VPFIBuyAdapter} on each non-Base
 *         chain in the mesh (Ethereum, Polygon, Arbitrum, Optimism).
 *
 * @dev Flow per inbound BUY_REQUEST (see {IVPFIBuyMessages}):
 *        1. Decode `(requestId, buyer, originEid, ethAmountPaid,
 *           minVpfiOut)`.
 *        2. try {IVPFIDiscount.processBridgedBuy}. On revert: ship
 *           BUY_FAILED back to the adapter so it refunds the user.
 *        3. On success: debited VPFI lands on this contract. Approve
 *           the canonical VPFIOFTAdapter and call {IOFT.send} to deliver
 *           the VPFI to `buyer` on `originEid`. Ship BUY_SUCCESS back
 *           so the adapter releases the user's ETH to the origin-chain
 *           treasury.
 *
 *      Funding model: the receiver holds an ETH float (pre-funded by
 *      ops) to cover LayerZero native fees for the OFT bridge and the
 *      BUY_SUCCESS/BUY_FAILED response. `rescueETH` drains the float
 *      back to owner. `rescueERC20` drains any stuck VPFI (should only
 *      happen if an OFT send fails mid-flight — the {VPFIStuckForManualBridge}
 *      event flags it).
 *
 *      Trust model:
 *        - `_lzReceive` inherits OAppReceiver's `msg.sender == endpoint`
 *          and `_origin.sender == peers[srcEid]` checks.
 *        - The paired Diamond on Base checks `msg.sender == bridgedBuyReceiver`
 *          inside {processBridgedBuy}, so the pairing is symmetric.
 *
 *      Per CLAUDE.md convention this OApp is UUPS so future endpoint
 *      migrations or payload-format changes preserve the peer mesh.
 */
contract VPFIBuyReceiver is
    Initializable,
    OAppUpgradeable,
    Ownable2StepUpgradeable,
    LZGuardianPausable,
    UUPSUpgradeable,
    IVPFIBuyMessages,
    IVaipakamErrors
{
    using SafeERC20 for IERC20;

    // ─── Constants ──────────────────────────────────────────────────────────

    /// @dev Kind tag for the {OptionsSet} event when {setOFTSendOptions}
    ///      writes the executor options used on the OFT-compose back leg.
    ///      Value `4` chosen to sit clear of the message-type enum
    ///      (`1 = BUY_REQUEST`, `3 = BUY_FAILED`) — `2` is the retired
    ///      `MSG_TYPE_BUY_SUCCESS` slot kept reserved for protocol
    ///      compatibility.
    uint8 internal constant OPT_KIND_OFT_BACK_LEG = 4;

    // ─── Storage ────────────────────────────────────────────────────────────

    /// @notice Paired Vaipakam Diamond on Base. Called via
    ///         {IVPFIDiscount.processBridgedBuy}.
    address public diamond;

    /// @notice Canonical VPFI ERC20 on Base — approved to the OFT
    ///         adapter before each bridge-back call.
    address public vpfiToken;

    /// @notice Canonical VPFIOFTAdapter on Base. Used to bridge VPFI
    ///         back to the buyer on their origin chain.
    address public vpfiOftAdapter;

    /// @notice Executor options used when sending BUY_SUCCESS / BUY_FAILED
    ///         back to the origin-chain adapter. Owner-configurable.
    bytes public responseOptions;

    /// @notice Executor options used inside the OFT `SendParam.extraOptions`
    ///         when bridging VPFI back. Owner-configurable.
    bytes public oftSendOptions;

    /// @notice Sum of VPFI amounts currently flagged via
    ///         {VPFIStuckForManualBridge} and awaiting {rescueBridgeVPFI}.
    ///         {rescueERC20} refuses to drain {vpfiToken} below this
    ///         figure so a compromised owner cannot sweep VPFI that still
    ///         owes delivery to a buyer. Incremented on each stuck event,
    ///         decremented on {rescueBridgeVPFI} success.
    uint256 public totalStuckVPFI;

    /// @notice requestId → stuck VPFI amount. Lets {rescueBridgeVPFI}
    ///         decrement {totalStuckVPFI} by the exact in-flight figure
    ///         and prevents double-accounting if the same id is replayed.
    mapping(uint64 => uint256) public stuckVPFIByRequest;

    /// @notice Per-eid registry of source-chain {VPFIBuyAdapter} contract
    ///         addresses that are allowed to be the OFT-compose receiver
    ///         on the success path. T-031 Layer 2: the receiver routes
    ///         VPFI via OFT compose to the *adapter* contract on the
    ///         source chain (not the buyer's wallet); the adapter then
    ///         cross-checks its own `pendingBuys[requestId]` before
    ///         forwarding to the actual buyer. A forged BUY_REQUEST
    ///         message that lands here can therefore mint VPFI but
    ///         cannot deliver it to an attacker-controlled wallet —
    ///         the adapter rejects on the local-state cross-check and
    ///         the VPFI is recorded as stuck for owner recovery.
    /// @dev Owner-set via {setBuyAdapter}. Storage layout: appended at
    ///      the end of the existing reservation so the UUPS upgrade
    ///      path doesn't shift any prior slots.
    mapping(uint32 => address) public buyAdapterByEid;

    /// @notice Master switch for the off-chain reconciliation watchdog
    ///         (T-031 Layer 4a). The watchdog Worker reads this flag
    ///         before each pass — when `false`, it skips reconciliation
    ///         and emits no alerts. Default `true` post-init so
    ///         monitoring runs out of the box; governance can flip via
    ///         {setReconciliationWatchdogEnabled} to silence the
    ///         watchdog during a planned bridge ceremony or known
    ///         reconciliation gap. The flag is informational from the
    ///         contract's perspective — turning it off does NOT change
    ///         on-chain behaviour, only the off-chain alert plane.
    /// @dev    Owner-only setter. Stays as a single global toggle for
    ///         now; per-chain granularity can be added as a later
    ///         `mapping(uint32 => bool)` if a partial-pause ever
    ///         becomes necessary.
    bool public reconciliationWatchdogEnabled;

    // ─── Events ─────────────────────────────────────────────────────────────

    event DiamondSet(address indexed oldDiamond, address indexed newDiamond);
    event OFTAdapterSet(address indexed oldAdapter, address indexed newAdapter);
    event VPFITokenSet(address indexed oldToken, address indexed newToken);
    event OptionsSet(uint8 indexed kind, bytes options);

    /// @notice Emitted when the per-eid registry of source-chain
    ///         {VPFIBuyAdapter} addresses is updated. T-031 Layer 2:
    ///         the OFT-compose target on the success path is read
    ///         from `buyAdapterByEid[dstEid]`.
    event BuyAdapterSet(
        uint32 indexed eid,
        address indexed oldAdapter,
        address indexed newAdapter
    );

    /// @notice Emitted when governance flips the reconciliation
    ///         watchdog enable/disable flag. Off-chain Workers in the
    ///         T-031 Layer 4a watchdog lane subscribe to this event
    ///         (or poll the `reconciliationWatchdogEnabled` view) to
    ///         pause/resume their reconciliation pass.
    event ReconciliationWatchdogToggled(bool enabled);

    /// @notice Emitted when a BUY_REQUEST was successfully processed
    ///         by the Diamond AND the return OFT send dispatched.
    event BridgedBuyProcessed(
        uint64 indexed requestId,
        uint32 indexed originEid,
        address indexed buyer,
        uint256 ethAmountPaid,
        uint256 vpfiOut,
        bytes32 oftGuid
    );

    /// @notice Emitted when the Diamond rejected the bridged buy.
    ///         Adapter will refund the user.
    event BridgedBuyFailed(
        uint64 indexed requestId,
        uint32 indexed originEid,
        address indexed buyer,
        uint8 reason
    );

    /// @notice Emitted when the Diamond accepted the buy but the OFT
    ///         bridge-back call reverted. VPFI is now stuck in this
    ///         contract — owner must manually push it to the buyer
    ///         via {rescueBridgeVPFI} or {rescueERC20}. BUY_SUCCESS is
    ///         STILL sent (caps were debited on Base; the user's
    ///         origin-chain ETH must transfer to the local treasury to
    ///         keep the accounting identity).
    event VPFIStuckForManualBridge(
        uint64 indexed requestId,
        uint32 indexed originEid,
        address indexed buyer,
        uint256 vpfiOut,
        bytes reason
    );

    /// @notice Emitted when owner replays the OFT bridge for a stuck
    ///         request.
    event BridgedBuyRescued(
        uint64 indexed requestId,
        uint32 indexed originEid,
        address indexed buyer,
        uint256 vpfiOut,
        bytes32 oftGuid
    );

    /// @notice Inbound LZ packet decoded to a msgType we don't handle.
    ///         Logged (instead of reverted) so a misconfigured peer can't
    ///         stick the packet in LayerZero's retry queue.
    event UnknownInboundMessage(uint32 indexed srcEid, uint8 msgType);

    /// @notice Owner replayed a stuck bridge but the accounting couldn't
    ///         find the requestId (e.g. already rescued). Informational.
    event RescueNotedForUnknownStuck(uint64 indexed requestId);

    // ─── Errors ─────────────────────────────────────────────────────────────

    error OFTAdapterNotSet();
    error DiamondNotSet();
    error EthSendFailed();
    error RescueWouldTouchStuckVPFI();
    /// @dev Operator forgot to call {setBuyAdapter} for the source chain.
    ///      Surfaced inside `_tryOftSend` as a soft-fail (BUY_FAILED reply
    ///      + refund) so a missing config can never wedge the LZ retry queue
    ///      or land VPFI at an attacker-controlled wallet.
    error BuyAdapterNotSet(uint32 eid);

    // ─── Construction ───────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address lzEndpoint) OAppUpgradeable(lzEndpoint) {
        _disableInitializers();
    }

    /**
     * @notice Initialize the receiver proxy.
     * @param owner_          OApp owner / LayerZero delegate.
     * @param diamond_        Vaipakam Diamond on Base.
     * @param vpfiToken_      Canonical VPFI ERC20 address on Base.
     * @param vpfiOftAdapter_ Canonical VPFIOFTAdapter on Base.
     * @param responseOptions_ Options bytes for the BUY_SUCCESS / BUY_FAILED
     *                         response leg (may be empty at init; owner
     *                         must set before first use).
     * @param oftSendOptions_  Options bytes for the return OFT send
     *                         leg (may be empty at init).
     */
    function initialize(
        address owner_,
        address diamond_,
        address vpfiToken_,
        address vpfiOftAdapter_,
        bytes calldata responseOptions_,
        bytes calldata oftSendOptions_
    ) external initializer {
        if (
            owner_ == address(0) ||
            diamond_ == address(0) ||
            vpfiToken_ == address(0) ||
            vpfiOftAdapter_ == address(0)
        ) revert InvalidAddress();

        __OApp_init(owner_);
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __LZGuardianPausable_init();

        diamond = diamond_;
        vpfiToken = vpfiToken_;
        vpfiOftAdapter = vpfiOftAdapter_;
        responseOptions = responseOptions_;
        oftSendOptions = oftSendOptions_;
        // T-031 Layer 4a: watchdog defaults to ON post-init so
        // reconciliation runs out of the box. Governance can flip via
        // {setReconciliationWatchdogEnabled} during planned bridge
        // ceremonies / known reconciliation gaps.
        reconciliationWatchdogEnabled = true;

        emit DiamondSet(address(0), diamond_);
        emit VPFITokenSet(address(0), vpfiToken_);
        emit OFTAdapterSet(address(0), vpfiOftAdapter_);
        emit ReconciliationWatchdogToggled(true);
    }

    // ─── Emergency pause ─────────────────────────────────────────────────────

    /// @notice Pause inbound BUY_REQUEST handling. Emergency lever for the
    ///         timelock / multi-sig in case a LayerZero-side incident (DVN
    ///         compromise, executor failure) is suspected. A paused
    ///         `_lzReceive` reverts the inbound packet — LZ retries after
    ///         `unpause()` so legitimate buyers' requests aren't dropped.
    ///         Since this contract performs the Diamond debit and the OFT
    ///         send-back of VPFI to the user, pausing here is the highest-
    ///         leverage single contract to halt a suspected forgery.
    function pause() external onlyGuardianOrOwner {
        _pause();
    }

    /// @notice Resume inbound BUY_REQUEST handling after an incident has
    ///         been investigated and resolved.
    /// @dev Deliberately owner-only. Recovery must travel the full
    ///      governance path — a compromised or impatient guardian must
    ///      not be able to race the incident team to unpause.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── Receive (endpoint) ─────────────────────────────────────────────────

    function _lzReceive(
        Origin calldata _origin,
        bytes32 /*_guid*/,
        bytes calldata _message,
        address /*_executor*/,
        bytes calldata /*_extraData*/
    ) internal override whenNotPaused {
        (
            uint8 msgType,
            uint64 requestId,
            address buyer,
            uint32 originEid,
            uint256 ethAmountPaid,
            uint256 minVpfiOut
        ) = abi.decode(
                _message,
                (uint8, uint64, address, uint32, uint256, uint256)
            );

        if (msgType != MSG_TYPE_BUY_REQUEST) {
            // Soft-fail: reverting here would wedge the packet in the LZ
            // retry queue forever. Log and drop instead — a legitimate
            // adapter peer only ever sends BUY_REQUEST anyway.
            emit UnknownInboundMessage(_origin.srcEid, msgType);
            return;
        }
        // Origin-eid encoded in the payload must match the actual LZ
        // source. This defends against a peer sending the wrong value
        // (trust-but-verify — peers[] already gates the sender, but
        // mismatched origin would silently land VPFI on the wrong chain).
        if (originEid != _origin.srcEid) {
            emit BridgedBuyFailed(
                requestId,
                _origin.srcEid,
                buyer,
                FAIL_REASON_UNKNOWN
            );
            _sendResponse(
                _origin.srcEid,
                MSG_TYPE_BUY_FAILED,
                requestId,
                0,
                FAIL_REASON_UNKNOWN
            );
            return;
        }

        (bool ok, uint256 vpfiOut, uint8 reason) = _tryProcessBuy(
            buyer,
            originEid,
            ethAmountPaid,
            minVpfiOut
        );

        if (!ok) {
            emit BridgedBuyFailed(requestId, originEid, buyer, reason);
            _sendResponse(
                originEid,
                MSG_TYPE_BUY_FAILED,
                requestId,
                0,
                reason
            );
            return;
        }

        // T-031 Layer 2: VPFI is sitting on this contract. OFT-compose
        // it back to the *source-chain adapter* (NOT the buyer's wallet
        // — that's the Layer 2 hardening). The compose payload carries
        // `requestId`; the adapter's lzCompose handler cross-checks its
        // own `pendingBuys[requestId].buyer` (authoritative local
        // truth) before delivering VPFI and releasing the user's ETH
        // to treasury. If the OFT-compose call reverts, caps are
        // already debited on Base — flag the VPFI as stuck for owner
        // recovery via {rescueBridgeVPFI}; no separate BUY_SUCCESS
        // reply is needed because the compose mint *is* the success
        // signal under the new flow.
        (bytes32 oftGuid, bool oftOk, bytes memory oftErr) = _tryOftSend(
            requestId,
            buyer,
            originEid,
            vpfiOut
        );

        if (!oftOk) {
            stuckVPFIByRequest[requestId] = vpfiOut;
            totalStuckVPFI += vpfiOut;
            emit VPFIStuckForManualBridge(
                requestId,
                originEid,
                buyer,
                vpfiOut,
                oftErr
            );
        }

        emit BridgedBuyProcessed(
            requestId,
            originEid,
            buyer,
            ethAmountPaid,
            vpfiOut,
            oftGuid
        );
        // T-031 Layer 2: no separate BUY_SUCCESS reply — the OFT-compose
        // mint to the source-chain adapter (dispatched inside _tryOftSend)
        // is now the success signal. The adapter's lzCompose handler does
        // the local cross-check, transfers VPFI to the buyer, and releases
        // the user's ETH to the local treasury — all driven by the compose
        // message landing, not a separate OApp send.
    }

    // ─── Internals ──────────────────────────────────────────────────────────

    /// @dev Wraps the Diamond call in a try/catch so any revert
    ///      becomes a BUY_FAILED response instead of a stuck retry.
    function _tryProcessBuy(
        address buyer,
        uint32 originEid,
        uint256 ethAmountPaid,
        uint256 minVpfiOut
    ) internal returns (bool ok, uint256 vpfiOut, uint8 reason) {
        if (diamond == address(0)) {
            return (false, 0, FAIL_REASON_PROCESS_REVERT);
        }
        try
            IVPFIDiscountIngress(diamond).processBridgedBuy(
                buyer,
                originEid,
                ethAmountPaid,
                minVpfiOut
            )
        returns (uint256 out) {
            return (true, out, 0);
        } catch (bytes memory errData) {
            return (false, 0, _decodeFailReason(errData));
        }
    }

    /// @dev Quote → approve → OFT-compose send. Returns (guid, ok, errData).
    ///      T-031 Layer 2: routes VPFI to the *source-chain adapter*
    ///      contract via OFT compose, with `requestId` in the compose
    ///      payload. The adapter's lzCompose handler cross-checks its
    ///      own `pendingBuys[requestId].buyer` (authoritative local
    ///      truth — set by the actual ETH-paying tx) before forwarding
    ///      VPFI to the buyer and releasing ETH to treasury. A forged
    ///      BUY_REQUEST therefore mints VPFI on Base but cannot
    ///      deliver it to an attacker-controlled wallet.
    ///
    ///      Soft-fails (returns `ok=false`) when:
    ///        - OFT adapter not set (operator misconfig at deploy),
    ///        - source-chain BuyAdapter not registered for `dstEid`
    ///          (operator forgot to call {setBuyAdapter}),
    ///        - quote or send revert (e.g. malformed options).
    ///      Soft-fail keeps the outer `_lzReceive` defensive against
    ///      any OFT-side misconfig so the Diamond debit does not leave
    ///      a stuck packet on the endpoint retry queue. Caller stamps
    ///      the resulting failure as a stuck-bridge event for owner
    ///      recovery.
    ///
    ///      `buyer` parameter is retained for the stuck-bridge event
    ///      payload only — it does NOT drive the OFT destination
    ///      anymore. Destination is read from `buyAdapterByEid[dstEid]`.
    function _tryOftSend(
        uint64 requestId,
        address /* buyer */,
        uint32 dstEid,
        uint256 vpfiOut
    ) internal returns (bytes32 guid, bool ok, bytes memory errData) {
        address oft = vpfiOftAdapter;
        if (oft == address(0)) {
            return (bytes32(0), false, abi.encode("oft-unset"));
        }
        address adapter = buyAdapterByEid[dstEid];
        if (adapter == address(0)) {
            return (bytes32(0), false, abi.encode("buy-adapter-unset"));
        }

        SendParam memory sp = SendParam({
            dstEid: dstEid,
            to: bytes32(uint256(uint160(adapter))),
            amountLD: vpfiOut,
            minAmountLD: vpfiOut,
            extraOptions: oftSendOptions,
            composeMsg: abi.encode(requestId),
            oftCmd: ""
        });

        // Quote in a try so a bad options config becomes a soft-fail
        // instead of a stuck retry. Receiver must hold enough native
        // balance to pay `nativeFee` on top of the response send.
        try IOFT(oft).quoteSend(sp, false) returns (
            OFTMessagingFee memory fee
        ) {
            IERC20(vpfiToken).forceApprove(oft, vpfiOut);
            try
                IOFT(oft).send{value: fee.nativeFee}(
                    sp,
                    OFTMessagingFee({
                        nativeFee: fee.nativeFee,
                        lzTokenFee: 0
                    }),
                    /* refundAddress */ address(this)
                )
            returns (OFTMessagingReceipt memory r, OFTReceipt memory) {
                // Zero the approval defensively — forceApprove already
                // pins the exact amount, but we pull it to zero so stale
                // approvals can't be consumed by a malicious upgrade.
                IERC20(vpfiToken).forceApprove(oft, 0);
                return (r.guid, true, "");
            } catch (bytes memory e) {
                IERC20(vpfiToken).forceApprove(oft, 0);
                return (bytes32(0), false, e);
            }
        } catch (bytes memory e) {
            return (bytes32(0), false, e);
        }
    }

    /// @dev Ship a BUY_SUCCESS or BUY_FAILED back to the origin adapter.
    ///      Pays native fee from the receiver's ETH float. Any refund
    ///      returns to this contract.
    function _sendResponse(
        uint32 originEid,
        uint8 kind,
        uint64 requestId,
        uint256 vpfiOut,
        uint8 reason
    ) internal {
        bytes memory payload = abi.encode(
            kind,
            requestId,
            vpfiOut,
            reason
        );
        MessagingFee memory fee = _quote(
            originEid,
            payload,
            responseOptions,
            false
        );
        _lzSend(
            originEid,
            payload,
            responseOptions,
            MessagingFee({nativeFee: fee.nativeFee, lzTokenFee: 0}),
            payable(address(this))
        );
    }

    /// @dev Maps an EVM revert blob back to the compact failure reason
    ///      carried in BUY_FAILED. Kept selector-based so we don't have
    ///      to string-parse — the selectors live on {IVaipakamErrors}
    ///      via the Diamond.
    function _decodeFailReason(
        bytes memory errData
    ) internal pure returns (uint8) {
        if (errData.length < 4) return FAIL_REASON_PROCESS_REVERT;
        bytes4 sel;
        assembly {
            sel := mload(add(errData, 0x20))
        }
        if (sel == IVaipakamErrors.VPFIGlobalCapExceeded.selector) {
            return FAIL_REASON_CAP_EXCEEDED;
        }
        if (sel == IVaipakamErrors.VPFIPerWalletCapExceeded.selector) {
            return FAIL_REASON_CAP_EXCEEDED;
        }
        if (sel == IVaipakamErrors.VPFIBuyRateNotSet.selector) {
            return FAIL_REASON_RATE_UNSET_OR_DISABLED;
        }
        if (sel == IVaipakamErrors.VPFIBuyDisabled.selector) {
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

    // ─── Overrides ──────────────────────────────────────────────────────────

    /// @dev Receiver draws its outbound native fees from its own ETH
    ///      float (funded via {receive} / {fundETH}). Bypassing the
    ///      default msg.value equality check keeps the _lzReceive
    ///      path self-funded without forcing ops to attach ETH to
    ///      every inbound packet.
    function _payNative(
        uint256 _nativeFee
    ) internal virtual override returns (uint256) {
        return _nativeFee;
    }

    /// @notice Accept native ETH deposits from ops to top up the float.
    receive() external payable {}

    /// @notice Owner-only ETH top-up (alias of `receive` for clarity in
    ///         ops runbooks).
    function fundETH() external payable {}

    // ─── Admin / rescue ─────────────────────────────────────────────────────

    /// @notice Re-try the OFT bridge for a previously stuck buy.
    ///         Pre-approves and calls IOFT.send with owner-supplied
    ///         parameters. Emits {BridgedBuyRescued}.
    /// @param requestId Tracking id (for event correlation only).
    /// @param dstEid    Buyer's origin chain LZ eid.
    /// @param buyer     Buyer address.
    /// @param vpfiOut   VPFI amount to push.
    /// @param nativeFee Native fee to attach (owner pre-quoted off-chain).
    function rescueBridgeVPFI(
        uint64 requestId,
        uint32 dstEid,
        address buyer,
        uint256 vpfiOut,
        uint256 nativeFee
    ) external onlyOwner {
        if (vpfiOftAdapter == address(0)) revert OFTAdapterNotSet();
        SendParam memory sp = SendParam({
            dstEid: dstEid,
            to: bytes32(uint256(uint160(buyer))),
            amountLD: vpfiOut,
            minAmountLD: vpfiOut,
            extraOptions: oftSendOptions,
            composeMsg: "",
            oftCmd: ""
        });
        IERC20(vpfiToken).forceApprove(vpfiOftAdapter, vpfiOut);
        (OFTMessagingReceipt memory r, ) = IOFT(vpfiOftAdapter).send{
            value: nativeFee
        }(
            sp,
            OFTMessagingFee({nativeFee: nativeFee, lzTokenFee: 0}),
            payable(address(this))
        );
        IERC20(vpfiToken).forceApprove(vpfiOftAdapter, 0);

        // Release the stuck-accounting slot so the VPFI that just left
        // is no longer locked against {rescueERC20}. Owner may rescue an
        // unknown id (e.g. manual top-up of a different stuck batch) —
        // surface that via a log rather than reverting, which would block
        // legitimate recovery.
        uint256 tracked = stuckVPFIByRequest[requestId];
        if (tracked == 0) {
            emit RescueNotedForUnknownStuck(requestId);
        } else {
            delete stuckVPFIByRequest[requestId];
            totalStuckVPFI -= tracked;
        }

        emit BridgedBuyRescued(requestId, dstEid, buyer, vpfiOut, r.guid);
    }

    /// @notice Owner-only: drain the native ETH float.
    function rescueETH(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidAddress();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert EthSendFailed();
    }

    /// @notice Owner-only: drain any ERC20 stuck here (VPFI or otherwise).
    ///         When draining {vpfiToken}, enforces
    ///         `balance - amount >= totalStuckVPFI` so a compromised owner
    ///         cannot sweep VPFI still owed to a buyer whose bridge-back
    ///         failed. Use {rescueBridgeVPFI} to replay the bridge instead,
    ///         which is the intended recovery path.
    function rescueERC20(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        if (to == address(0)) revert InvalidAddress();
        if (token == vpfiToken) {
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (amount > bal || bal - amount < totalStuckVPFI) {
                revert RescueWouldTouchStuckVPFI();
            }
        }
        IERC20(token).safeTransfer(to, amount);
    }

    // ─── Admin setters ──────────────────────────────────────────────────────

    function setDiamond(address diamond_) external onlyOwner {
        if (diamond_ == address(0)) revert InvalidAddress();
        address old = diamond;
        diamond = diamond_;
        emit DiamondSet(old, diamond_);
    }

    function setOFTAdapter(address oft) external onlyOwner {
        if (oft == address(0)) revert InvalidAddress();
        address old = vpfiOftAdapter;
        vpfiOftAdapter = oft;
        emit OFTAdapterSet(old, oft);
    }

    function setVPFIToken(address token) external onlyOwner {
        if (token == address(0)) revert InvalidAddress();
        address old = vpfiToken;
        vpfiToken = token;
        emit VPFITokenSet(old, token);
    }

    function setResponseOptions(bytes calldata options) external onlyOwner {
        responseOptions = options;
        emit OptionsSet(MSG_TYPE_BUY_FAILED, options);
    }

    function setOFTSendOptions(bytes calldata options) external onlyOwner {
        oftSendOptions = options;
        emit OptionsSet(OPT_KIND_OFT_BACK_LEG, options);
    }

    /// @notice Register (or replace) the source-chain {VPFIBuyAdapter}
    ///         for a given LayerZero endpoint id. T-031 Layer 2: the
    ///         OFT-compose target on the success path is read from this
    ///         registry, NOT from the buyer's address. A bridged buy on
    ///         a chain whose adapter is unset soft-fails with
    ///         BUY_FAILED + refund.
    /// @dev    Owner-only. Address can be re-set or zeroed; passing
    ///         `address(0)` effectively pauses bridged buys for that
    ///         chain (subsequent BUY_REQUESTs from that eid will refund).
    function setBuyAdapter(uint32 eid, address adapter) external onlyOwner {
        address old = buyAdapterByEid[eid];
        buyAdapterByEid[eid] = adapter;
        emit BuyAdapterSet(eid, old, adapter);
    }

    /// @notice Enable or disable the off-chain reconciliation watchdog
    ///         (T-031 Layer 4a). The watchdog Worker reads the
    ///         `reconciliationWatchdogEnabled` view before each pass —
    ///         when `false` it skips reconciliation and emits no
    ///         alerts. Same auth path as every other governance lever
    ///         on this contract (`onlyOwner`, ultimately routed
    ///         through the Vaipakam multisig + timelock).
    /// @dev    Idempotent toggle — emits regardless so observers can
    ///         see the explicit set.
    function setReconciliationWatchdogEnabled(bool enabled)
        external
        onlyOwner
    {
        reconciliationWatchdogEnabled = enabled;
        emit ReconciliationWatchdogToggled(enabled);
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

/// @dev Base-side Diamond surface that the receiver calls into.
interface IVPFIDiscountIngress {
    function processBridgedBuy(
        address buyer,
        uint32 originEid,
        uint256 ethAmountPaid,
        uint256 minVpfiOut
    ) external returns (uint256 vpfiOut);
}
