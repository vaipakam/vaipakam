// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {RateLimiter} from "@chainlink/contracts-ccip/contracts/libraries/RateLimiter.sol";

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {LibVpfiRecycle} from "../libraries/LibVpfiRecycle.sol";

/// @dev The slice of {VaipakamRewardMessenger} the Base-side dispatch
///      surfaces drive — the two #1568 C2 instruction kinds.
interface IRepatRewardMessenger {
    function sendRepatriationInstruction(
        uint256 dstChainId,
        uint256 authId,
        uint256 amount,
        address payable refundAddress
    ) external payable returns (bytes32 messageId);

    function sendRepatriationCancel(
        uint256 dstChainId,
        uint256 authId,
        address payable refundAddress
    ) external payable returns (bytes32 messageId);
}

/// @dev The slice of {CcipMessenger}'s registry the lane-capacity bounds
///      read — the chainId → CCIP-selector mapping ConfigureCcip wires.
interface ICcipSelectorRegistry {
    function chainSelectorOf(uint256 chainId) external view returns (uint64);
}

/// @dev The slice of the CCIP VPFI TokenPool the lane-capacity bounds
///      read — the LIVE per-lane limiter state. The struct comes from the
///      pinned CCIP library itself, never a hand-typed copy, so the
///      decode shape cannot drift from the audited pool's.
interface IVpfiPoolRateLimitView {
    function getCurrentInboundRateLimiterState(uint64 remoteChainSelector)
        external
        view
        returns (RateLimiter.TokenBucket memory);

    function getCurrentOutboundRateLimiterState(uint64 remoteChainSelector)
        external
        view
        returns (RateLimiter.TokenBucket memory);
}

/// @dev The slice of {VpfiReturnSender} the mirror-side surfaces drive —
///      the shared return channel's Mode-A send legs.
interface IVpfiReturnSender {
    function sendRepatriationReturn(
        address issuingBase,
        uint256 authId,
        uint256 amount,
        address payable refundAddress
    ) external payable returns (bytes32 messageId);

    function sendRepatriationCancelAck(
        address issuingBase,
        uint256 authId,
        address payable refundAddress
    ) external payable returns (bytes32 messageId);
}

/**
 * @title  RepatriationFacet
 * @author Vaipakam Developer Team
 * @notice #1568 C2 **Mode A** — planned-surplus repatriation: the Diamond-side
 *         accounting core of `VpfiCrossChainRecyclingDesign.md` §3.6a.
 *
 *         Mode A moves a mirror's surplus recycled VPFI back to the canonical
 *         chain under a Base-issued, releasable **pending authorization**
 *         (constraint 5). The availability draw is the dedicated
 *         `chainRepatriationDebited` / `chainRepatriationReleased` pair —
 *         **never** `chainConsumedRecycled`, which is one half of the
 *         `outstanding + retired == consumed` identity and would break it on
 *         the first authorization (constraint 5a; the alternative was removed
 *         from the design, not deprecated).
 *
 * @dev    DARK BY DEFAULT: every entry point gates on the C2 transport
 *         satellites being configured (`repatriationSender` mirror-side /
 *         `repatriationReceiver` Base-side). While unset — every deployment
 *         built before the C2 transport slice arms — this facet only ever
 *         reverts, and the ledger pair stays zero, keeping
 *         `mirrorAvailRecycled`'s repatriation term inert.
 *
 *         ALL lifecycle state lives in Diamond storage deliberately. §3.6a
 *         5b/5c's rotation gaps (a cancelled authorization executing after a
 *         handler swap; an executed one executing twice) both came from
 *         handler-local markers — a stateless transport satellite has nothing
 *         to lose in a rotation, so the replacement never has to answer "did
 *         the previous handler already act on this?" from inherited state.
 *         The mirror-side execution marker and cancellation tombstone are the
 *         SAME storage slot (`repatInstructionState`), making their mutual
 *         exclusion (5c) structural rather than checked.
 *
 *         Era binding (5b): the wire carries the ISSUING Base deployment in
 *         both directions. The mirror keys instruction state by
 *         `keccak256(issuingBase, authId)`, and Base's return/cancel
 *         ingresses accept only `issuingBase == address(this)` — a rotated
 *         deployment's records can never collide with a prior era's.
 *
 *         The transport rides two seams: the Base→mirror instruction kinds
 *         on {VaipakamRewardMessenger} (kinds 8/9 — this facet's
 *         `sendRepatriationInstruction` / `requestRepatriationCancel`
 *         dispatch them, its two `on…InstructionReceived` ingresses land
 *         them), and the shared mirror→Base `vpfi-return` channel
 *         (`VpfiReturnSender` escrow on the mirror, kind-dispatching
 *         `VpfiReturnReceiver` on Base — see {ReturnWire} for why each mode
 *         is its own wire protocol on that one channel).
 */
contract RepatriationFacet is
    DiamondAccessControl,
    DiamondReentrancyGuard,
    DiamondPausable
{
    using SafeERC20 for IERC20;

    // ── Authorization status values (LibVaipakam.RepatriationAuthorization) ─
    uint8 private constant AUTH_NONE = 0;
    uint8 private constant AUTH_PENDING = 1;
    uint8 private constant AUTH_SETTLED = 2;
    uint8 private constant AUTH_RELEASED = 3;

    // ── Mirror-side instruction states (repatInstructionState) ─────────────
    uint8 private constant INSTR_NONE = 0;
    uint8 private constant INSTR_PENDING = 1;
    uint8 private constant INSTR_EXECUTED = 2;
    uint8 private constant INSTR_TOMBSTONED = 3;

    // ── Events ──────────────────────────────────────────────────────────────

    /// @notice Base issued a Mode-A authorization: the availability draw is
    ///         charged and the pending record opened (§3.6a constraint 5).
    /// @custom:event-category state-change/treasury-mutation
    event RepatriationAuthorized(
        uint256 indexed authId,
        uint32 indexed dstChainId,
        uint256 amount
    );

    /// @notice A Mode-A return arrived and closed its authorization. A short
    ///         arrival (fee-on-transfer on the return leg) records the gap in
    ///         `shortfall` — the source debit never scales down (6a/7).
    /// @custom:event-category state-change/treasury-mutation
    event RepatriationSettled(
        uint256 indexed authId,
        uint32 indexed srcChainId,
        uint256 actualReceived,
        uint256 shortfall
    );

    /// @notice An authenticated mirror cancellation ACK released the
    ///         authorization — the ONLY path that restores availability
    ///         (constraint 5c; proven non-execution is not one).
    /// @custom:event-category state-change/treasury-mutation
    event RepatriationReleased(uint256 indexed authId, uint32 indexed dstChainId, uint256 amount);

    /// @notice Mirror recorded a Base repatriation instruction (pending).
    /// @custom:event-category state-change/treasury-mutation
    event RepatriationInstructionRecorded(
        address indexed issuingBase,
        uint256 indexed authId,
        uint256 amount
    );

    /// @notice C2 transport endpoints (re)configured. Zeroing either returns
    ///         the facet to dark.
    event RepatriationEndpointsSet(address sender, address receiver);

    /// @notice The VPFI TokenPool the lane-capacity bounds read was
    ///         (re)configured. Zeroing it re-darkens the bounded surfaces.
    event RepatriationLanePoolSet(address previousPool, address newPool);

    /// @notice Base dispatched (or re-dispatched) the cross-chain instruction
    ///         for a pending authorization.
    /// @custom:event-category informational/reward-transport
    event RepatriationInstructionDispatched(
        uint256 indexed authId,
        uint32 indexed dstChainId,
        uint256 amount,
        bytes32 messageId
    );

    /// @notice Base dispatched (or re-dispatched) a cancellation instruction
    ///         for a pending authorization. The authorization stays PENDING
    ///         until the mirror's ACK arrives — dispatching the request is
    ///         not the release (§3.6a constraint 5c).
    /// @custom:event-category informational/reward-transport
    event RepatriationCancelDispatched(
        uint256 indexed authId,
        uint32 indexed dstChainId,
        bytes32 messageId
    );

    /// @notice Mirror tombstoned an instruction on a Base cancellation —
    ///         terminal, mutually exclusive with execution (one shared slot).
    /// @custom:event-category state-change/treasury-mutation
    event RepatriationInstructionTombstoned(
        address indexed issuingBase,
        uint256 indexed authId
    );

    /// @notice Mirror executed a repatriation instruction: the bucket
    ///         surplus was debited and the VPFI left on the return channel.
    /// @custom:event-category state-change/treasury-mutation
    event RepatriationExecuted(
        address indexed issuingBase,
        uint256 indexed authId,
        uint256 amount,
        bytes32 messageId
    );

    /// @notice Mirror sent (or re-sent) the cancellation ACK for a
    ///         tombstoned instruction over the return channel.
    /// @custom:event-category informational/reward-transport
    event RepatriationCancelAckDispatched(
        address indexed issuingBase,
        uint256 indexed authId,
        bytes32 messageId
    );

    // ── Errors ──────────────────────────────────────────────────────────────

    /// @notice C2's transport is not configured on this deployment — the
    ///         facet is dark by design until the operator arms it.
    error RepatriationNotConfigured();
    /// @notice Caller is not the configured Base-side receiver satellite.
    error OnlyRepatriationReceiver(address caller);
    /// @notice Caller is not the registered reward messenger.
    error OnlyRewardMessengerRepat(address caller);
    /// @notice Wrong chain role for this entry point.
    error RepatriationWrongChainRole();
    /// @notice Zero amount, self-chain target, or otherwise malformed input.
    error RepatriationInvalidRequest();
    /// @notice The draw exceeds the chain's current recycled availability.
    error RepatriationExceedsAvailability(uint256 requested, uint256 available);
    /// @notice The amount exceeds the lane's LIVE limiter capacity (read
    ///         from the VPFI TokenPool at the moment of the check) — a
    ///         single return message above capacity is rejected
    ///         permanently by CCIP, never queued behind refill, so it
    ///         could only ever strand the authorization's draw.
    error RepatriationExceedsLaneCapacity(uint256 requested, uint256 capacity);
    /// @notice The messenger's registry has no CCIP selector for this
    ///         chain pair — the lane is not wired; fail closed.
    error RepatriationLaneUnknown(uint256 chainId);
    /// @notice The referenced authorization is not in the required state.
    error RepatriationAuthNotPending(uint256 authId, uint8 status);
    /// @notice The return/cancel names a different issuing deployment — a
    ///         prior era's record can never settle against this one (5b).
    error RepatriationWrongEra(address issuingBase);
    /// @notice The return arrived from a chain other than the authorization's
    ///         target (§3.6a constraint 6's source binding, applied to Mode A).
    error RepatriationWrongSourceChain(uint32 got, uint32 want);
    /// @notice 6a delivery checks failed: wrong token, mismatched declared
    ///         amount, or zero actual receipt.
    error RepatriationDeliveryInvalid();
    /// @notice A nonzero transport endpoint must be a contract — an EOA
    ///         receiver could fabricate cancellation ACKs with no transport
    ///         authentication behind them (Codex #1608 r1; the same
    ///         trust-root class setRewardRemittanceReceiver rejects).
    error RepatriationEndpointNotContract(address endpoint);
    /// @notice The reward messenger is not configured on this deployment —
    ///         the Base-side dispatch surfaces have no wire to ride.
    error RepatriationMessengerNotSet();
    /// @notice The referenced mirror instruction is not in the required
    ///         state for this action.
    error RepatriationInstructionWrongState(
        address issuingBase,
        uint256 authId,
        uint8 state
    );

    // ── Live lane-capacity bound ────────────────────────────────────────────

    /**
     * @dev Enforce `amount` against the LIVE limiter capacity of the CCIP
     *      lane toward `remoteChainId`, on this chain's own VPFI pool —
     *      the inbound bucket when this chain will RECEIVE the return
     *      (Base, at authorize), the outbound bucket when it will SEND it
     *      (mirror, at execute). Fail-closed on missing wiring: an unset
     *      pool or messenger, or an unknown lane selector, refuses rather
     *      than passes. A disabled limiter imposes no bound — CCIP's own
     *      `_consume` short-circuits the same way, and the pool rate
     *      governor refuses to disable a lane's limit (ET-008), so on a
     *      production deploy this branch means "governor policy says
     *      unlimited", not "unconfigured".
     */
    function _assertWithinLaneCapacity(
        LibVaipakam.Storage storage s,
        uint256 remoteChainId,
        uint256 amount,
        bool inbound
    ) private view {
        address pool = s.repatriationLanePool;
        address messenger = s.crossChainMessenger;
        if (pool == address(0) || messenger == address(0)) {
            revert RepatriationNotConfigured();
        }
        uint64 selector =
            ICcipSelectorRegistry(messenger).chainSelectorOf(remoteChainId);
        if (selector == 0) revert RepatriationLaneUnknown(remoteChainId);
        RateLimiter.TokenBucket memory bucket = inbound
            ? IVpfiPoolRateLimitView(pool).getCurrentInboundRateLimiterState(
                selector
            )
            : IVpfiPoolRateLimitView(pool).getCurrentOutboundRateLimiterState(
                selector
            );
        if (bucket.isEnabled && amount > uint256(bucket.capacity)) {
            revert RepatriationExceedsLaneCapacity(
                amount, uint256(bucket.capacity)
            );
        }
    }

    // ── Gates ───────────────────────────────────────────────────────────────

    modifier onlyCanonical() {
        if (!LibVaipakam.storageSlot().isCanonicalRewardChain) {
            revert RepatriationWrongChainRole();
        }
        _;
    }

    modifier onlyMirror() {
        if (LibVaipakam.storageSlot().isCanonicalRewardChain) {
            revert RepatriationWrongChainRole();
        }
        _;
    }

    // ── Base side: authorize / settle / release ─────────────────────────────

    /**
     * @notice Issue a Mode-A planned-surplus authorization against `dstChainId`.
     * @dev    Charges the dedicated draw (`chainRepatriationDebited`) BEFORE
     *         any instruction leaves — Base understates availability from this
     *         moment until settlement or an authenticated cancellation ACK,
     *         which is the safe direction (constraint 5: an unexecuted
     *         instruction must never leave availability re-offerable).
     *         The amount is bounded by the chain's LIVE availability, which
     *         already nets every prior repatriation draw through
     *         {LibVpfiRecycle.mirrorAvailRecycled}.
     *
     *         The cross-chain instruction dispatch rides the transport slice;
     *         until it lands this facet is dark (the endpoint gate below), so
     *         an authorization cannot strand availability on a deployment
     *         with no path to settle or cancel it.
     */
    function authorizeRepatriation(uint32 dstChainId, uint256 amount)
        external
        nonReentrant
        whenNotPaused
        onlyCanonical
        onlyRole(LibAccessControl.ADMIN_ROLE)
        returns (uint256 authId)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.repatriationReceiver == address(0)) {
            revert RepatriationNotConfigured();
        }
        if (amount == 0 || uint256(dstChainId) == block.chainid) {
            revert RepatriationInvalidRequest();
        }
        uint256 avail = LibVpfiRecycle.mirrorAvailRecycled(s, dstChainId);
        if (amount > avail) {
            revert RepatriationExceedsAvailability(amount, avail);
        }
        // LIVE lane-capacity bound, Base-inbound half (Codex #1618
        // r1→r6): the return is ONE token message consuming BOTH sides'
        // rate limiters, and a single CCIP request above either capacity
        // is rejected PERMANENTLY (not queued behind refill) — an
        // over-capacity authorization would charge a draw that can only
        // ever be released by the cancellation ceremony. The bound is
        // read from THIS chain's pool limiter at the moment of issuance —
        // never from an armed/recorded copy, four rounds of review having
        // shown every off-chain derivation stale or skippable on some
        // documented operator path. The mirror-outbound half is enforced
        // the same live way at {executeRepatriation}. A DISABLED limiter
        // imposes no bound, exactly as CCIP's own `_consume` treats it
        // (and the rate governor refuses to disable a lane's limit,
        // ET-008).
        _assertWithinLaneCapacity(s, uint256(dstChainId), amount, true);
        s.chainRepatriationDebited[dstChainId] += amount;
        authId = ++s.repatAuthNonce;
        s.repatAuthorizations[authId] = LibVaipakam.RepatriationAuthorization({
            status: AUTH_PENDING,
            dstChainId: dstChainId,
            issuedAt: uint64(block.timestamp),
            amount: amount
        });
        emit RepatriationAuthorized(authId, dstChainId, amount);
    }

    /**
     * @notice Dispatch (or re-dispatch) the cross-chain instruction for a
     *         pending authorization through the reward messenger.
     * @dev    PERMISSIONLESS and re-sendable by design: the instruction's
     *         content is derived entirely from the stored authorization —
     *         the ADMIN act was {authorizeRepatriation} — and the mirror
     *         ingress is idempotent, so re-dispatch can never double-record.
     *         A dispatch racing a cancellation converges on the mirror:
     *         whichever instruction lands first decides, execution requires
     *         a PENDING record, and a cancel tombstones even a record that
     *         never arrived — every ordering ends in exactly one of
     *         settle-by-return or release-by-ACK (§3.6a 5c's mutual
     *         exclusion is structural, one shared slot).
     *         `msg.value` must cover the CCIP fee (quote via the messenger's
     *         {quoteSendRepatriationInstruction}); the remainder refunds to
     *         `refundAddress`.
     */
    function sendRepatriationInstruction(
        uint256 authId,
        address payable refundAddress
    )
        external
        payable
        nonReentrant
        whenNotPaused
        onlyCanonical
        returns (bytes32 messageId)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.repatriationReceiver == address(0)) {
            revert RepatriationNotConfigured();
        }
        address rm = s.rewardMessenger;
        if (rm == address(0)) revert RepatriationMessengerNotSet();
        LibVaipakam.RepatriationAuthorization storage auth =
            s.repatAuthorizations[authId];
        if (auth.status != AUTH_PENDING) {
            revert RepatriationAuthNotPending(authId, auth.status);
        }
        messageId = IRepatRewardMessenger(rm).sendRepatriationInstruction{
            value: msg.value
        }(uint256(auth.dstChainId), authId, auth.amount, refundAddress);
        emit RepatriationInstructionDispatched(
            authId, auth.dstChainId, auth.amount, messageId
        );
    }

    /**
     * @notice Request cancellation of a pending authorization: dispatches
     *         the cancel instruction to the mirror. ADMIN-only — cancelling
     *         is an economic policy decision, like issuing.
     * @dev    The authorization stays PENDING (and its availability draw
     *         stays charged) until the mirror's authenticated ACK arrives
     *         through the return channel — the ONLY release path (§3.6a
     *         constraint 5c: proof of non-execution so far is not proof it
     *         will not execute). Re-sendable while still PENDING: the
     *         mirror tombstone is idempotent and a lost cancel is retried
     *         by re-calling.
     */
    function requestRepatriationCancel(
        uint256 authId,
        address payable refundAddress
    )
        external
        payable
        nonReentrant
        whenNotPaused
        onlyCanonical
        onlyRole(LibAccessControl.ADMIN_ROLE)
        returns (bytes32 messageId)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.repatriationReceiver == address(0)) {
            revert RepatriationNotConfigured();
        }
        address rm = s.rewardMessenger;
        if (rm == address(0)) revert RepatriationMessengerNotSet();
        LibVaipakam.RepatriationAuthorization storage auth =
            s.repatAuthorizations[authId];
        if (auth.status != AUTH_PENDING) {
            revert RepatriationAuthNotPending(authId, auth.status);
        }
        messageId = IRepatRewardMessenger(rm).sendRepatriationCancel{
            value: msg.value
        }(uint256(auth.dstChainId), authId, refundAddress);
        emit RepatriationCancelDispatched(authId, auth.dstChainId, messageId);
    }

    /**
     * @notice Base ingress for a Mode-A return. Called ONLY by the configured
     *         receiver satellite, which has already forwarded the delivered
     *         VPFI to the Diamond (balance-delta pattern) and reports both
     *         the payload-declared and transport-actual amounts.
     * @dev    Constraint 6a's delivery checks run here IN FULL for Mode A:
     *         exactly one token (receiver-enforced), that token is the local
     *         VPFI, the declared amount binds to the authorization EXACTLY
     *         (Mode A's exact-match rule), and the actual receipt is
     *         non-zero. A short actual (fee-on-transfer return) closes the
     *         authorization at its declared amount with the gap recorded in
     *         `repatShortfall` — the source debit never silently resizes.
     *         The arriving value re-enters Base's books as a CUSTODY
     *         RELOCATION (Ā-excluded): it was absorbed exactly once on the
     *         mirror, so crediting it as new absorption would double-count
     *         the §7 #8 composition.
     */
    function onRepatriationReturnReceived(
        uint256 authId,
        address issuingBase,
        uint32 sourceChainId,
        address token,
        uint256 declaredAmount,
        uint256 actualReceived
    ) external nonReentrant whenNotPaused onlyCanonical {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address receiver = s.repatriationReceiver;
        if (receiver == address(0) || msg.sender != receiver) {
            revert OnlyRepatriationReceiver(msg.sender);
        }
        if (issuingBase != address(this)) {
            revert RepatriationWrongEra(issuingBase);
        }
        LibVaipakam.RepatriationAuthorization storage auth =
            s.repatAuthorizations[authId];
        if (auth.status != AUTH_PENDING) {
            revert RepatriationAuthNotPending(authId, auth.status);
        }
        if (sourceChainId != auth.dstChainId) {
            revert RepatriationWrongSourceChain(sourceChainId, auth.dstChainId);
        }
        if (
            token != s.vpfiToken ||
            declaredAmount != auth.amount ||
            actualReceived == 0 ||
            actualReceived > declaredAmount
        ) {
            revert RepatriationDeliveryInvalid();
        }
        auth.status = AUTH_SETTLED;
        uint256 shortfall = declaredAmount - actualReceived;
        if (shortfall != 0) s.repatShortfall[authId] = shortfall;
        LibVpfiRecycle.creditCustodyRelocated(
            authId,
            actualReceived,
            LibVpfiRecycle.RecycleSource.RepatriationReturnRelocation
        );
        emit RepatriationSettled(authId, sourceChainId, actualReceived, shortfall);
    }

    /**
     * @notice Base ingress for an authenticated mirror CANCELLATION ACK — the
     *         only release path (constraint 5c). The mirror tombstones first
     *         (terminal, mutually exclusive with execution), then ACKs; ids
     *         the mirror never received a record for tombstone the same way.
     */
    function onRepatriationCancelAck(
        uint256 authId,
        address issuingBase,
        uint32 sourceChainId
    ) external nonReentrant whenNotPaused onlyCanonical {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address receiver = s.repatriationReceiver;
        if (receiver == address(0) || msg.sender != receiver) {
            revert OnlyRepatriationReceiver(msg.sender);
        }
        if (issuingBase != address(this)) {
            revert RepatriationWrongEra(issuingBase);
        }
        LibVaipakam.RepatriationAuthorization storage auth =
            s.repatAuthorizations[authId];
        if (auth.status != AUTH_PENDING) {
            revert RepatriationAuthNotPending(authId, auth.status);
        }
        if (sourceChainId != auth.dstChainId) {
            revert RepatriationWrongSourceChain(sourceChainId, auth.dstChainId);
        }
        auth.status = AUTH_RELEASED;
        // NET-DRAW release (Codex #1608 r1 P2): the draw slot is maintained
        // as the NET outstanding+settled charge — a release DECREMENTS it —
        // because the cumulative-pair form wedges at hostile magnitudes: a
        // cancelled near-max draw would leave the debited cumulative at
        // ~2^256 and every later authorization reverting on overflow while
        // availability says the capacity is back. The lifetime released
        // cumulative stays monotonic as pure observability. The floor is
        // structural (every release matches one prior un-released charge)
        // but kept anyway — this slot is the availability term and must
        // never be able to revert a read path.
        uint32 dst = auth.dstChainId;
        uint256 net = s.chainRepatriationDebited[dst];
        s.chainRepatriationDebited[dst] = net > auth.amount
            ? net - auth.amount
            : 0;
        // SATURATING lifetime observability (the sibling of the net-draw
        // fix, found by the invariant fuzz rather than predicted with it:
        // repeated near-max authorize→cancel cycles overflow a plain
        // cumulative, and a reverting release is the WORSE wedge — it
        // strands the authorization un-releasable and its availability
        // drawn forever). Near 2^256 the exact figure is meaningless;
        // saturation keeps the release path alive under any history.
        uint256 rel = s.chainRepatriationReleased[dst];
        uint256 amt = auth.amount;
        s.chainRepatriationReleased[dst] = rel > type(uint256).max - amt
            ? type(uint256).max
            : rel + amt;
        emit RepatriationReleased(authId, dst, auth.amount);
    }

    // ── Mirror side: instruction ingress (execution ships with transport) ───

    /**
     * @notice Mirror ingress for a Base repatriation instruction, delivered
     *         through the registered reward messenger (a new message kind in
     *         the transport slice; this function is its target).
     * @dev    Idempotent under CCIP re-execution: an already-recorded,
     *         executed, or tombstoned instruction is a no-op — re-delivery
     *         must never resurrect a terminal state (5b/5c). The instruction
     *         key carries the issuing deployment, so a rotated Base's ids
     *         land in fresh keys rather than colliding with a prior era's.
     */
    function onRepatriationInstructionReceived(
        address issuingBase,
        uint256 authId,
        uint256 amount
    ) external nonReentrant whenNotPaused onlyMirror {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.rewardMessenger || s.rewardMessenger == address(0)) {
            revert OnlyRewardMessengerRepat(msg.sender);
        }
        // Dark gate, mirror side (Codex #1608 r1 P2): a mirror whose sender
        // satellite is not configured must NOT consume an instruction — a
        // REVERT leaves the CCIP packet failed-but-re-executable, so the
        // instruction lands cleanly once the operator arms the transport,
        // instead of persisting state recorded while the deployment was
        // supposed to be dark.
        if (s.repatriationSender == address(0)) {
            revert RepatriationNotConfigured();
        }
        if (issuingBase == address(0) || authId == 0 || amount == 0) {
            revert RepatriationInvalidRequest();
        }
        bytes32 key = keccak256(abi.encodePacked(issuingBase, authId));
        if (s.repatInstructionState[key] != INSTR_NONE) return;
        s.repatInstructionState[key] = INSTR_PENDING;
        s.repatInstructionAmount[key] = amount;
        emit RepatriationInstructionRecorded(issuingBase, authId, amount);
    }

    /**
     * @notice Mirror ingress for a Base CANCEL instruction, delivered
     *         through the registered reward messenger.
     * @dev    Tombstones NONE (a pre-tombstone: the cancel overtook the
     *         instruction, so the instruction lands on a terminal record
     *         and no-ops) and PENDING. An EXECUTED record is a NO-OP, not a
     *         revert — execution won the race, the return is already on the
     *         wire, and Base will settle by it; reverting would only leave
     *         a CCIP packet endlessly re-executable toward a state that can
     *         never change (execution and tombstone share one slot — 5c's
     *         mutual exclusion is structural). A TOMBSTONED record is a
     *         no-op re-delivery.
     */
    function onRepatriationCancelInstructionReceived(
        address issuingBase,
        uint256 authId
    ) external nonReentrant whenNotPaused onlyMirror {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.rewardMessenger || s.rewardMessenger == address(0)) {
            revert OnlyRewardMessengerRepat(msg.sender);
        }
        // Dark gate — same REVERT posture as the instruction ingress: a
        // tombstone recorded while the deployment was supposed to be dark
        // is state the operator never armed; the CCIP packet stays
        // failed-but-re-executable instead.
        if (s.repatriationSender == address(0)) {
            revert RepatriationNotConfigured();
        }
        if (issuingBase == address(0) || authId == 0) {
            revert RepatriationInvalidRequest();
        }
        bytes32 key = keccak256(abi.encodePacked(issuingBase, authId));
        uint8 state = s.repatInstructionState[key];
        if (state == INSTR_EXECUTED || state == INSTR_TOMBSTONED) return;
        s.repatInstructionState[key] = INSTR_TOMBSTONED;
        emit RepatriationInstructionTombstoned(issuingBase, authId);
    }

    /**
     * @notice Execute a recorded repatriation instruction: debit the mirror
     *         bucket's un-reserved surplus and send the VPFI to Base over
     *         the shared return channel.
     * @dev    PERMISSIONLESS — the instruction is Base-authorized, its
     *         content is entirely storage-derived, and the caller
     *         contributes only the CCIP fee (quote via the sender
     *         satellite's {quoteRepatriationReturn}; remainder refunds to
     *         `refundAddress`). ONE-SHOT by checks-effects-interactions:
     *         the execution marker is written BEFORE the debit, the escrow
     *         transfer and the send, and the marker slot doubles as the
     *         tombstone slot, so a second execution — or a cancellation of
     *         an executed instruction — is structurally excluded (5c). A
     *         failed send reverts the whole call, marker included, leaving
     *         the instruction PENDING and retryable.
     *
     *         The debit can revert {RepatriationExceedsFundable} if claim
     *         commitments or the keeper earmark have since grown past the
     *         surplus Base observed at authorization — the execute is
     *         retryable after commitments retire, and Base's draw stays
     *         safely charged meanwhile (constraint 5's safe direction).
     */
    function executeRepatriation(
        address issuingBase,
        uint256 authId,
        address payable refundAddress
    )
        external
        payable
        nonReentrant
        whenNotPaused
        onlyMirror
        returns (bytes32 messageId)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address sender = s.repatriationSender;
        if (sender == address(0)) revert RepatriationNotConfigured();
        bytes32 key = keccak256(abi.encodePacked(issuingBase, authId));
        uint8 state = s.repatInstructionState[key];
        if (state != INSTR_PENDING) {
            revert RepatriationInstructionWrongState(issuingBase, authId, state);
        }
        uint256 amount = s.repatInstructionAmount[key];

        // LIVE lane-capacity bound, mirror-outbound half (Codex #1618
        // r1→r6) — checked BEFORE the one-shot marker, so an instruction
        // above the lane's current capacity fails RETRYABLY (still
        // PENDING, cancellable) instead of marking executed and sending
        // a message the limiter permanently rejects. This is also what
        // keeps a capacity LOWERED after instruction issuance from
        // wedging: the execute simply refuses until the operator cancels
        // or governance re-raises the lane.
        _assertWithinLaneCapacity(s, s.baseChainId, amount, false);

        // CEI: the one-shot marker precedes every effect and interaction.
        s.repatInstructionState[key] = INSTR_EXECUTED;
        LibVpfiRecycle.debitRepatriationSurplus(s, amount);
        IERC20(s.vpfiToken).safeTransfer(sender, amount);
        messageId = IVpfiReturnSender(sender).sendRepatriationReturn{
            value: msg.value
        }(issuingBase, authId, amount, refundAddress);
        emit RepatriationExecuted(issuingBase, authId, amount, messageId);
    }

    /**
     * @notice Send (or re-send) the cancellation ACK for a tombstoned
     *         instruction over the shared return channel — the evidence
     *         that lets Base release the authorization's availability draw.
     * @dev    PERMISSIONLESS: the tombstone is the Base-authorized fact
     *         being attested, the caller contributes only the CCIP fee
     *         (quote via {VpfiReturnSender.quoteRepatriationCancelAck}).
     *         Re-sendable because an ACK can be lost to a Base-side pause
     *         window: a duplicate simply reverts on Base's ingress (the
     *         authorization is no longer PENDING) as a failed, inert CCIP
     *         delivery.
     */
    function sendRepatriationCancelAck(
        address issuingBase,
        uint256 authId,
        address payable refundAddress
    )
        external
        payable
        nonReentrant
        whenNotPaused
        onlyMirror
        returns (bytes32 messageId)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address sender = s.repatriationSender;
        if (sender == address(0)) revert RepatriationNotConfigured();
        bytes32 key = keccak256(abi.encodePacked(issuingBase, authId));
        uint8 state = s.repatInstructionState[key];
        if (state != INSTR_TOMBSTONED) {
            revert RepatriationInstructionWrongState(issuingBase, authId, state);
        }
        messageId = IVpfiReturnSender(sender).sendRepatriationCancelAck{
            value: msg.value
        }(issuingBase, authId, refundAddress);
        emit RepatriationCancelAckDispatched(issuingBase, authId, messageId);
    }

    // ── Config ──────────────────────────────────────────────────────────────

    /**
     * @notice Configure (or zero, to re-darken) the C2 transport satellites.
     *         A mirror sets `sender_`; Base sets `receiver_`; each side may
     *         leave the other zero.
     */
    function setRepatriationEndpoints(address sender_, address receiver_)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        // Zero re-darkens; a NONZERO endpoint must hold code (Codex #1608
        // r1 P2 — an EOA receiver could release availability with no
        // transport authentication behind it).
        if (sender_ != address(0) && sender_.code.length == 0) {
            revert RepatriationEndpointNotContract(sender_);
        }
        if (receiver_ != address(0) && receiver_.code.length == 0) {
            revert RepatriationEndpointNotContract(receiver_);
        }
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.repatriationSender = sender_;
        s.repatriationReceiver = receiver_;
        emit RepatriationEndpointsSet(sender_, receiver_);
    }

    /**
     * @notice Configure this chain's VPFI CCIP TokenPool — the contract
     *         whose LIVE per-lane limiter state bounds every repatriation
     *         (Base reads its inbound bucket at authorize, a mirror its
     *         outbound bucket at execute). Reading the pool directly is
     *         what removed the armed-ceiling ceremony (Codex #1618
     *         r1→r6): there is no recorded copy to go stale, no arming
     *         order to follow, and no Safe-execution path that skips a
     *         local side effect. Zero re-darkens the bounded surfaces
     *         (fail-closed, like the endpoints); a nonzero pool must hold
     *         code for the same trust-root reason the endpoints must.
     */
    function setRepatriationLanePool(address pool_)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (pool_ != address(0) && pool_.code.length == 0) {
            revert RepatriationEndpointNotContract(pool_);
        }
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        emit RepatriationLanePoolSet(s.repatriationLanePool, pool_);
        s.repatriationLanePool = pool_;
    }

    /// @notice The configured VPFI TokenPool the live lane-capacity
    ///         bounds read (0 = the bounded surfaces are dark).
    function getRepatriationLanePool() external view returns (address) {
        return LibVaipakam.storageSlot().repatriationLanePool;
    }

    // ── Views ───────────────────────────────────────────────────────────────

    /// @notice One authorization record, as stored.
    function getRepatriationAuthorization(uint256 authId)
        external
        view
        returns (uint8 status, uint32 dstChainId, uint64 issuedAt, uint256 amount, uint256 shortfall)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.RepatriationAuthorization storage auth =
            s.repatAuthorizations[authId];
        return (auth.status, auth.dstChainId, auth.issuedAt, auth.amount, s.repatShortfall[authId]);
    }

    /// @notice A chain's repatriation draw figures, published for the mesh
    ///         watcher's re-derivation: `netDraw` is the LIVE availability
    ///         term (outstanding + settled charges, already net of
    ///         releases — exactly the §3.6a `(repatDebited − repatReleased)`
    ///         net, maintained in place); `lifetimeReleased` is the
    ///         monotonic release observability cumulative.
    function getChainRepatriationDraw(uint32 chainId)
        external
        view
        returns (uint256 netDraw, uint256 lifetimeReleased)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.chainRepatriationDebited[chainId],
            s.chainRepatriationReleased[chainId]
        );
    }

    /// @notice A mirror instruction record, keyed by its issuing deployment
    ///         and authorization id. `state`: 0 none, 1 pending, 2 executed,
    ///         3 tombstoned. This is how an operator (or the mesh watcher)
    ///         sees that a tombstone exists and its cancellation ACK is
    ///         still owed, or that a pending instruction awaits execution.
    function getRepatriationInstruction(address issuingBase, uint256 authId)
        external
        view
        returns (uint8 state, uint256 amount)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        bytes32 key = keccak256(abi.encodePacked(issuingBase, authId));
        return (s.repatInstructionState[key], s.repatInstructionAmount[key]);
    }

    /// @notice This chain's repatriation position: the mirror-side outflow
    ///         cumulative (§7 #8's new composition term), endpoints, and the
    ///         Base-side authorization nonce.
    function getRepatriationPosition()
        external
        view
        returns (
            uint256 repatriatedOutCumulative,
            address sender,
            address receiver,
            uint256 authNonce
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.recycleRepatriatedOutCumulative,
            s.repatriationSender,
            s.repatriationReceiver,
            s.repatAuthNonce
        );
    }
}
