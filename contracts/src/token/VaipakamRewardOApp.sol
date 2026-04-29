// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {OAppUpgradeable, Origin, MessagingFee, MessagingReceipt} from "@layerzerolabs/oapp-evm-upgradeable/contracts/oapp/OAppUpgradeable.sol";
import {IRewardOApp} from "../interfaces/IRewardOApp.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {LZGuardianPausable} from "./LZGuardianPausable.sol";

/**
 * @title VaipakamRewardOApp
 * @author Vaipakam Developer Team
 * @notice Dedicated LayerZero OApp that bridges cross-chain reward
 *         accounting messages between Vaipakam Diamonds (spec §4a).
 *
 * @dev Two complementary message flows travel through this contract:
 *        - REPORT   (mirror → Base): `(dayId, lenderUSD18, borrowerUSD18)`
 *          emitted when `RewardReporterFacet.closeDay` fires on a
 *          non-canonical Diamond. On arrival at the Base-side OApp we
 *          forward into `RewardAggregatorFacet.onChainReportReceived`
 *          tagged with `_origin.srcEid` so the aggregator knows which
 *          chain reported.
 *        - BROADCAST (Base → mirrors): `(dayId, globalLenderUSD18,
 *          globalBorrowerUSD18)` emitted once Base finalizes the day.
 *          Each mirror OApp delivers the pair into
 *          `RewardReporterFacet.onRewardBroadcastReceived`.
 *
 *      Trust model:
 *        - `diamond` is the Vaipakam Diamond proxy this OApp is paired
 *          with. Only the Diamond may call the two sender-side methods.
 *          On receive, the Diamond's facets authenticate `msg.sender`
 *          against their own `rewardOApp` field, so the pairing is
 *          symmetrically enforced on both contracts.
 *        - `peers[eid]` (inherited from OAppCore) must hold the
 *          bytes32-encoded address of the counterpart OApp on `eid`.
 *          Both sender and receiver use this table; a message from a
 *          non-peer eid is rejected before `_lzReceive` runs.
 *
 *      Fee model:
 *        - REPORT: one destination (Base). `msg.value` must equal the
 *          fee returned by {quoteSendChainReport}. Leftover refunded
 *          to `refundAddress`.
 *        - BROADCAST: N destinations. `msg.value` must cover the SUM
 *          returned by {quoteBroadcastGlobal}. `_payNative` is
 *          overridden so intermediate sends within one broadcast do
 *          not revert on msg.value !== _fee.nativeFee; the contract
 *          refunds the dust to `refundAddress` at the end.
 *
 *      Per project convention (CLAUDE.md: "contracts outside the
 *      Diamond must use UUPS upgradeable + ERC1967Proxy"), this OApp
 *      is UUPS so future endpoint migrations or payload-format changes
 *      do not require re-registering the peer mesh.
 */
contract VaipakamRewardOApp is
    Initializable,
    OAppUpgradeable,
    Ownable2StepUpgradeable,
    LZGuardianPausable,
    UUPSUpgradeable,
    IRewardOApp,
    IVaipakamErrors
{
    // ─── Message types ──────────────────────────────────────────────────────

    /// @notice Payload kind: mirror → Base day-close chain report.
    uint8 internal constant MSG_TYPE_REPORT = 1;
    /// @notice Payload kind: Base → mirrors finalized denominator broadcast.
    uint8 internal constant MSG_TYPE_BROADCAST = 2;

    /// @notice Canonical inbound payload size — `abi.encode(uint8,
    ///         uint256, uint256, uint256)` always produces four 32-byte
    ///         words. Both REPORT and BROADCAST share this shape, so a
    ///         single constant covers both message kinds.
    /// @dev    Strict-equality size check in `_lzReceive` rejects any
    ///         oversized or undersized packet outright. `abi.decode`
    ///         silently ignores trailing bytes past the head, so an
    ///         attacker who somehow lands a forged packet could otherwise
    ///         pad the payload with arbitrary tail data and have it parse.
    ///         This length pin closes that hole as defence-in-depth on
    ///         top of the DVN-set + peer-table guards.
    uint256 internal constant EXPECTED_PAYLOAD_SIZE = 4 * 32;

    // ─── Storage ────────────────────────────────────────────────────────────

    /// @notice Paired Vaipakam Diamond on the local chain. Only this
    ///         address may call {sendChainReport} / {broadcastGlobal},
    ///         and all inbound payloads are forwarded to it.
    address public diamond;

    /// @notice True iff this OApp is deployed on the canonical reward
    ///         chain (Base). Governs which inbound message kinds this
    ///         OApp accepts and which Diamond method receives them.
    bool public isCanonical;

    /// @notice LayerZero eid of the canonical reward chain (Base).
    ///         Used by mirror OApps as the REPORT destination; zero on
    ///         the Base-side deployment.
    uint32 public baseEid;

    /// @notice Destinations broadcast-to on Base when {broadcastGlobal}
    ///         fires. Kept append-only except through
    ///         {setBroadcastDestinationEids}. Zero-length on mirrors.
    uint32[] public broadcastDestinationEids;

    /// @notice Executor options used for REPORT packets (mirror → Base).
    ///         Must encode at least an `addExecutorLzReceiveOption` gas
    ///         budget big enough to cover the Base-side aggregator
    ///         ingress write. Owner-configurable.
    bytes public reportOptions;

    /// @notice Executor options used for BROADCAST packets (Base → mirror).
    ///         Applied per destination. Must cover the mirror-side
    ///         ingress write. Owner-configurable.
    bytes public broadcastOptions;

    // ─── Events ─────────────────────────────────────────────────────────────

    /// @notice Emitted once on initial proxy wiring or whenever ops
    ///         rotate the paired Diamond.
    event DiamondSet(address indexed oldDiamond, address indexed newDiamond);

    /// @notice Emitted when the canonical flag flips — governance-level
    ///         action (should only happen during migrations).
    event CanonicalFlagSet(bool isCanonical);

    /// @notice Emitted when the mirror-side destination (Base) eid
    ///         changes.
    event BaseEidSet(uint32 oldEid, uint32 newEid);

    /// @notice Emitted when Base's broadcast destination list changes.
    event BroadcastDestinationEidsSet(uint32[] eids);

    /// @notice Emitted when ops rotate REPORT or BROADCAST executor options.
    event OptionsSet(uint8 indexed msgType, bytes options);

    /// @notice Mirrors {IRewardOApp.sendChainReport} for observability —
    ///         the LayerZero scan UI already shows packet metadata but
    ///         this event ties the GUID to the reporter tuple.
    event ReportSent(
        bytes32 indexed guid,
        uint256 indexed dayId,
        uint256 lenderUSD18,
        uint256 borrowerUSD18
    );

    /// @notice Emitted once per broadcast destination.
    event BroadcastSent(
        bytes32 indexed guid,
        uint32 indexed dstEid,
        uint256 indexed dayId,
        uint256 globalLenderUSD18,
        uint256 globalBorrowerUSD18
    );

    /// @notice Emitted when an inbound REPORT is forwarded to the Base
    ///         aggregator Diamond.
    event ReportReceived(
        uint32 indexed srcEid,
        uint256 indexed dayId,
        uint256 lenderUSD18,
        uint256 borrowerUSD18
    );

    /// @notice Emitted when an inbound BROADCAST is forwarded to a
    ///         mirror reporter Diamond.
    event BroadcastReceived(
        uint32 indexed srcEid,
        uint256 indexed dayId,
        uint256 globalLenderUSD18,
        uint256 globalBorrowerUSD18
    );

    // ─── Errors ─────────────────────────────────────────────────────────────

    /// @notice Caller of a sender-side method is not the paired Diamond.
    error OnlyDiamond();
    /// @notice Inbound payload carries an unknown msgType tag.
    error UnknownMessageType(uint8 msgType);
    /// @notice Inbound REPORT arrived on a mirror-side OApp
    ///         (only the canonical OApp accepts REPORTs).
    error ReportOnMirror();
    /// @notice Inbound BROADCAST arrived on the canonical OApp
    ///         (only mirror OApps accept BROADCASTs — Base writes its
    ///         own globals directly in `finalizeDay`).
    error BroadcastOnCanonical();
    /// @notice Broadcast destination list is empty.
    error NoBroadcastDestinations();
    /// @notice `baseEid` has not been configured on a mirror OApp.
    error BaseEidNotConfigured();
    /// @notice Inbound packet length does not match the canonical 4-word
    ///         payload shape. Carries the actual length so off-chain
    ///         monitoring can correlate with LayerZero scan traces.
    error PayloadSizeMismatch(uint256 got, uint256 expected);

    // ─── Construction ───────────────────────────────────────────────────────

    /// @param lzEndpoint LayerZero V2 endpoint for the chain this
    ///                   implementation will back. Baked into the
    ///                   OAppCore immutable; proxies pointing at this
    ///                   implementation inherit the wired endpoint.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address lzEndpoint) OAppUpgradeable(lzEndpoint) {
        _disableInitializers();
    }

    /**
     * @notice Initialize the OApp proxy.
     * @dev Wires the OApp delegate (owner), pairs the Diamond that may
     *      invoke the sender-side methods, and stamps the canonical flag.
     *      Canonical OApps leave `baseEid_` at zero; mirrors pass the
     *      Base chain's LZ eid so {sendChainReport} has a destination.
     * @param owner_         OApp owner / LayerZero delegate (expected:
     *                       timelock-gated multi-sig).
     * @param diamond_       Vaipakam Diamond proxy on this chain.
     * @param isCanonical_   True iff this deployment is on Base.
     * @param baseEid_       LayerZero eid of Base (0 when `isCanonical_`).
     * @param reportOptions_ Executor options for mirror→Base REPORT
     *                       packets (may be empty at init; must be set
     *                       before {sendChainReport} is usable).
     * @param broadcastOptions_ Executor options for Base→mirror BROADCAST
     *                          packets (may be empty at init; must be
     *                          set before {broadcastGlobal} is usable).
     */
    function initialize(
        address owner_,
        address diamond_,
        bool isCanonical_,
        uint32 baseEid_,
        bytes calldata reportOptions_,
        bytes calldata broadcastOptions_
    ) external initializer {
        if (owner_ == address(0) || diamond_ == address(0)) {
            revert InvalidAddress();
        }

        __OApp_init(owner_);
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __LZGuardianPausable_init();

        diamond = diamond_;
        isCanonical = isCanonical_;
        baseEid = baseEid_;
        reportOptions = reportOptions_;
        broadcastOptions = broadcastOptions_;

        emit DiamondSet(address(0), diamond_);
        emit CanonicalFlagSet(isCanonical_);
        if (baseEid_ != 0) emit BaseEidSet(0, baseEid_);
    }

    // ─── Emergency pause ─────────────────────────────────────────────────────

    /// @notice Pause both sender-side (`sendChainReport` / `broadcastGlobal`)
    ///         and inbound (`_lzReceive`) paths. Callable by either the
    ///         guardian (incident-response multi-sig, no timelock) or the
    ///         owner (timelock-gated multi-sig). Because this OApp carries
    ///         scalar reward totals (not value), the worst-case forgery
    ///         impact is incorrect reward math, not stolen funds — but
    ///         stale math can still compound until unpaused, so the pause
    ///         lever is worth having.
    function pause() external onlyGuardianOrOwner {
        _pause();
    }

    /// @notice Resume send / receive paths after an incident has been
    ///         investigated and resolved.
    /// @dev Deliberately owner-only. Recovery must travel the full
    ///      governance path — a compromised or impatient guardian must
    ///      not be able to race the incident team to unpause.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── Modifiers ──────────────────────────────────────────────────────────

    /// @dev Sender-side methods are only callable by the paired Diamond.
    modifier onlyDiamond() {
        if (msg.sender != diamond) revert OnlyDiamond();
        _;
    }

    // ─── Sender side (IRewardOApp) ──────────────────────────────────────────

    /// @inheritdoc IRewardOApp
    function sendChainReport(
        uint256 dayId,
        uint256 lenderUSD18,
        uint256 borrowerUSD18,
        address payable refundAddress
    ) external payable override onlyDiamond whenNotPaused {
        if (baseEid == 0) revert BaseEidNotConfigured();

        bytes memory payload = abi.encode(
            MSG_TYPE_REPORT,
            dayId,
            lenderUSD18,
            borrowerUSD18
        );

        MessagingReceipt memory receipt = _lzSend(
            baseEid,
            payload,
            reportOptions,
            MessagingFee({nativeFee: msg.value, lzTokenFee: 0}),
            refundAddress
        );

        emit ReportSent(receipt.guid, dayId, lenderUSD18, borrowerUSD18);
    }

    /// @inheritdoc IRewardOApp
    function broadcastGlobal(
        uint256 dayId,
        uint256 globalLenderUSD18,
        uint256 globalBorrowerUSD18,
        address payable refundAddress
    ) external payable override onlyDiamond whenNotPaused {
        uint256 n = broadcastDestinationEids.length;
        if (n == 0) revert NoBroadcastDestinations();

        bytes memory payload = abi.encode(
            MSG_TYPE_BROADCAST,
            dayId,
            globalLenderUSD18,
            globalBorrowerUSD18
        );

        uint256 spent;
        for (uint256 i; i < n; ) {
            uint32 dstEid = broadcastDestinationEids[i];
            MessagingFee memory fee = _quote(
                dstEid,
                payload,
                broadcastOptions,
                false
            );
            // Route fee through the overridden `_payNative` path — it
            // just echoes the requested amount so per-dest sends can
            // share the aggregate msg.value held by this contract.
            MessagingReceipt memory receipt = _lzSend(
                dstEid,
                payload,
                broadcastOptions,
                fee,
                refundAddress
            );
            spent += fee.nativeFee;

            emit BroadcastSent(
                receipt.guid,
                dstEid,
                dayId,
                globalLenderUSD18,
                globalBorrowerUSD18
            );

            unchecked {
                ++i;
            }
        }

        // Refund dust — the endpoint already returned per-send refunds
        // to `refundAddress`, but defensive returning of the unused
        // balance on THIS contract prevents slow accumulation in case
        // fee estimation was conservative.
        if (msg.value > spent) {
            uint256 change = msg.value - spent;
            (bool ok, ) = refundAddress.call{value: change}("");
            require(ok, "refund failed");
        }
    }

    /// @inheritdoc IRewardOApp
    function quoteSendChainReport(
        uint256 dayId,
        uint256 lenderUSD18,
        uint256 borrowerUSD18
    ) external view override returns (uint256 nativeFee) {
        if (baseEid == 0) revert BaseEidNotConfigured();
        bytes memory payload = abi.encode(
            MSG_TYPE_REPORT,
            dayId,
            lenderUSD18,
            borrowerUSD18
        );
        MessagingFee memory fee = _quote(
            baseEid,
            payload,
            reportOptions,
            false
        );
        return fee.nativeFee;
    }

    /// @inheritdoc IRewardOApp
    function quoteBroadcastGlobal(
        uint256 dayId,
        uint256 globalLenderUSD18,
        uint256 globalBorrowerUSD18
    ) external view override returns (uint256 nativeFee) {
        uint256 n = broadcastDestinationEids.length;
        if (n == 0) return 0;

        bytes memory payload = abi.encode(
            MSG_TYPE_BROADCAST,
            dayId,
            globalLenderUSD18,
            globalBorrowerUSD18
        );

        uint256 sum;
        for (uint256 i; i < n; ) {
            MessagingFee memory fee = _quote(
                broadcastDestinationEids[i],
                payload,
                broadcastOptions,
                false
            );
            sum += fee.nativeFee;
            unchecked {
                ++i;
            }
        }
        return sum;
    }

    // ─── Receiver side ──────────────────────────────────────────────────────

    /**
     * @dev OApp receiver hook. Validates the payload msgType against the
     *      local canonical flag, decodes the pair, and forwards into the
     *      paired Diamond.
     *
     *      `lzReceive` in {OAppReceiverUpgradeable} already authenticates
     *      `msg.sender == endpoint` AND `_origin.sender == peers[srcEid]`
     *      before reaching this function, so the payload provenance is
     *      bound to a trusted peer OApp.
     */
    function _lzReceive(
        Origin calldata _origin,
        bytes32 /*_guid*/,
        bytes calldata _message,
        address /*_executor*/,
        bytes calldata /*_extraData*/
    ) internal override whenNotPaused {
        if (_message.length != EXPECTED_PAYLOAD_SIZE) {
            revert PayloadSizeMismatch(_message.length, EXPECTED_PAYLOAD_SIZE);
        }
        (uint8 msgType, uint256 dayId, uint256 a, uint256 b) = abi.decode(
            _message,
            (uint8, uint256, uint256, uint256)
        );

        if (msgType == MSG_TYPE_REPORT) {
            if (!isCanonical) revert ReportOnMirror();
            emit ReportReceived(_origin.srcEid, dayId, a, b);
            IRewardAggregatorIngress(diamond).onChainReportReceived(
                _origin.srcEid,
                dayId,
                a,
                b
            );
        } else if (msgType == MSG_TYPE_BROADCAST) {
            if (isCanonical) revert BroadcastOnCanonical();
            emit BroadcastReceived(_origin.srcEid, dayId, a, b);
            IRewardReporterIngress(diamond).onRewardBroadcastReceived(
                dayId,
                a,
                b
            );
        } else {
            revert UnknownMessageType(msgType);
        }
    }

    // ─── Native fee routing ─────────────────────────────────────────────────

    /**
     * @dev Overrides {OAppSenderUpgradeable._payNative}. The default
     *      implementation reverts unless `msg.value == _nativeFee`,
     *      which breaks {broadcastGlobal} where a single `msg.value`
     *      must fund N sequential sends. Here we instead trust the
     *      outer functions to validate the aggregate:
     *        - {sendChainReport} forwards the full msg.value and
     *          lets the endpoint refund dust to `refundAddress`.
     *        - {broadcastGlobal} sums quoted fees across destinations
     *          and refunds the tail itself.
     *
     *      The endpoint's own accounting reverts if the contract does
     *      not have enough balance to cover `_nativeFee` at send-time,
     *      so returning `_nativeFee` verbatim is safe.
     */
    function _payNative(
        uint256 _nativeFee
    ) internal virtual override returns (uint256 nativeFee) {
        return _nativeFee;
    }

    // ─── Admin ──────────────────────────────────────────────────────────────

    /// @notice Rotate the paired Diamond (e.g. during a Diamond
    ///         migration). Only the owner / timelock may call.
    /// @param diamond_ New Diamond proxy address (non-zero).
    function setDiamond(address diamond_) external onlyOwner {
        if (diamond_ == address(0)) revert InvalidAddress();
        address old = diamond;
        diamond = diamond_;
        emit DiamondSet(old, diamond_);
    }

    /// @notice Flip the canonical flag (rare — reserved for mesh
    ///         re-topology). Changes which inbound message kind this
    ///         OApp accepts.
    /// @param on Canonical flag value.
    function setIsCanonical(bool on) external onlyOwner {
        isCanonical = on;
        emit CanonicalFlagSet(on);
    }

    /// @notice Set the Base eid used as the REPORT destination on
    ///         mirror OApps. No-op-valued on the canonical OApp.
    /// @param eid LayerZero V2 endpoint id of the canonical chain.
    function setBaseEid(uint32 eid) external onlyOwner {
        uint32 old = baseEid;
        baseEid = eid;
        emit BaseEidSet(old, eid);
    }

    /// @notice Replace the list of broadcast destination eids. Only the
    ///         canonical OApp uses this list; mirror OApps may leave it
    ///         empty. Callers must also register a corresponding peer
    ///         via {setPeer} for each eid BEFORE the first broadcast.
    /// @param eids Full replacement list.
    function setBroadcastDestinationEids(
        uint32[] calldata eids
    ) external onlyOwner {
        uint256 cur = broadcastDestinationEids.length;
        for (uint256 i; i < cur; ) {
            broadcastDestinationEids.pop();
            unchecked {
                ++i;
            }
        }
        for (uint256 i; i < eids.length; ) {
            broadcastDestinationEids.push(eids[i]);
            unchecked {
                ++i;
            }
        }
        emit BroadcastDestinationEidsSet(eids);
    }

    /// @notice Rotate executor options used on the mirror→Base REPORT
    ///         channel. Setting an empty bytes value disables the send
    ///         path until a new value is written (any `_lzSend` with
    ///         empty options is a no-op at the endpoint level).
    /// @param options Encoded LayerZero executor options (type 3).
    function setReportOptions(bytes calldata options) external onlyOwner {
        reportOptions = options;
        emit OptionsSet(MSG_TYPE_REPORT, options);
    }

    /// @notice Rotate executor options used on the Base→mirror BROADCAST
    ///         channel.
    /// @param options Encoded LayerZero executor options (type 3).
    function setBroadcastOptions(bytes calldata options) external onlyOwner {
        broadcastOptions = options;
        emit OptionsSet(MSG_TYPE_BROADCAST, options);
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    /// @notice Returns the full broadcast destination list — ops tooling
    ///         uses this to verify mesh wiring after setPeer rounds.
    function getBroadcastDestinationEids()
        external
        view
        returns (uint32[] memory)
    {
        return broadcastDestinationEids;
    }

    // ─── UUPS ───────────────────────────────────────────────────────────────

    /// @dev UUPS authorization hook. Only the owner (timelock/multi-sig)
    ///      may authorize upgrades. Upgrades must preserve the storage
    ///      layout including the append-only `broadcastDestinationEids`.
    /// @param newImplementation Candidate implementation address.
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {}

    // ─── Ownable MRO Resolution ─────────────────────────────────────────────

    /// @dev OAppCore inherits `OwnableUpgradeable` while we additionally
    ///      mix in `Ownable2StepUpgradeable`. Both define
    ///      `transferOwnership` / `_transferOwnership` with identical
    ///      signatures — Solidity requires us to disambiguate. Routing
    ///      to Ownable2Step gives us the accept-pattern guard.
    /// @param newOwner Proposed owner (must accept via `acceptOwnership`).
    function transferOwnership(
        address newOwner
    )
        public
        override(OwnableUpgradeable, Ownable2StepUpgradeable)
        onlyOwner
    {
        Ownable2StepUpgradeable.transferOwnership(newOwner);
    }

    /// @dev Internal counterpart to {transferOwnership} disambiguation.
    /// @param newOwner New owner to persist (pending state is handled
    ///                 by Ownable2Step).
    function _transferOwnership(
        address newOwner
    )
        internal
        override(OwnableUpgradeable, Ownable2StepUpgradeable)
    {
        Ownable2StepUpgradeable._transferOwnership(newOwner);
    }
}

/// @dev Ingress surface on the Base-side Diamond that the canonical
///      OApp forwards inbound REPORT payloads to. Kept minimal so this
///      file does not depend on the whole facet.
interface IRewardAggregatorIngress {
    function onChainReportReceived(
        uint32 sourceEid,
        uint256 dayId,
        uint256 lenderUSD18,
        uint256 borrowerUSD18
    ) external;
}

/// @dev Ingress surface on mirror-side Diamonds that every OApp
///      forwards inbound BROADCAST payloads to.
interface IRewardReporterIngress {
    function onRewardBroadcastReceived(
        uint256 dayId,
        uint256 globalLenderUSD18,
        uint256 globalBorrowerUSD18
    ) external;
}
