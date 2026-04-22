// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {OAppUpgradeable, Origin, MessagingFee, MessagingReceipt} from "@layerzerolabs/oapp-evm-upgradeable/contracts/oapp/OAppUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IOFT, SendParam, MessagingFee as OFTMessagingFee, MessagingReceipt as OFTMessagingReceipt, OFTReceipt} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import {IVPFIBuyMessages} from "../interfaces/IVPFIBuyMessages.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

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
    PausableUpgradeable,
    UUPSUpgradeable,
    IVPFIBuyMessages,
    IVaipakamErrors
{
    using SafeERC20 for IERC20;

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

    // ─── Events ─────────────────────────────────────────────────────────────

    event DiamondSet(address indexed oldDiamond, address indexed newDiamond);
    event OFTAdapterSet(address indexed oldAdapter, address indexed newAdapter);
    event VPFITokenSet(address indexed oldToken, address indexed newToken);
    event OptionsSet(uint8 indexed kind, bytes options);

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
        __Pausable_init();

        diamond = diamond_;
        vpfiToken = vpfiToken_;
        vpfiOftAdapter = vpfiOftAdapter_;
        responseOptions = responseOptions_;
        oftSendOptions = oftSendOptions_;

        emit DiamondSet(address(0), diamond_);
        emit VPFITokenSet(address(0), vpfiToken_);
        emit OFTAdapterSet(address(0), vpfiOftAdapter_);
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
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume inbound BUY_REQUEST handling after an incident has
    ///         been investigated and resolved.
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

        // VPFI is now sitting on this contract. Attempt to OFT-send it
        // back to the buyer on their origin chain. If the OFT call
        // reverts, caps are already debited on Base — we still tell the
        // adapter SUCCESS so the user's origin-chain ETH goes to the
        // local treasury (accounting invariant), and flag the stuck
        // VPFI for owner recovery.
        (bytes32 oftGuid, bool oftOk, bytes memory oftErr) = _tryOftSend(
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
        _sendResponse(originEid, MSG_TYPE_BUY_SUCCESS, requestId, vpfiOut, 0);
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

    /// @dev Quote → approve → OFT send. Returns (guid, ok, errData).
    ///      Keeps the outer `_lzReceive` defensive against any OFT-side
    ///      misconfig so the Diamond debit does not leave a stuck
    ///      packet on the endpoint retry queue.
    function _tryOftSend(
        address buyer,
        uint32 dstEid,
        uint256 vpfiOut
    ) internal returns (bytes32 guid, bool ok, bytes memory errData) {
        address oft = vpfiOftAdapter;
        if (oft == address(0)) {
            return (bytes32(0), false, abi.encode("oft-unset"));
        }

        SendParam memory sp = SendParam({
            dstEid: dstEid,
            to: bytes32(uint256(uint160(buyer))),
            amountLD: vpfiOut,
            minAmountLD: vpfiOut,
            extraOptions: oftSendOptions,
            composeMsg: "",
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
        emit OptionsSet(MSG_TYPE_BUY_SUCCESS, options);
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
