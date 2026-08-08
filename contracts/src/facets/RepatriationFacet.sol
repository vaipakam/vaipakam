// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {LibVpfiRecycle} from "../libraries/LibVpfiRecycle.sol";

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
 *         The transport slice (mirror sender/escrow satellite, kind-
 *         dispatching Base receiver, `executeRepatriation`, the messenger
 *         instruction kind and the shared-channel rollout tests) follows in
 *         its own PR; this facet is the ledger it will drive.
 */
contract RepatriationFacet is
    DiamondAccessControl,
    DiamondReentrancyGuard,
    DiamondPausable
{
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
