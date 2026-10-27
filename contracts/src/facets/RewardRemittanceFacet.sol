// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibVpfiRecycle} from "../libraries/LibVpfiRecycle.sol";
import {LibRewardRemitDispatch} from "../libraries/LibRewardRemitDispatch.sol";
import {LibRewardCustody} from "../libraries/LibRewardCustody.sol";
import {LibRemitDayLedger} from "../libraries/LibRemitDayLedger.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {ICrossChainMessenger} from "../crosschain/ICrossChainMessenger.sol";
import {RemitWire} from "../crosschain/RemitWire.sol";
import {IRewardMessenger} from "../interfaces/IRewardMessenger.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title RewardRemittanceFacet — #776 Base→mirror reward-budget bridge (send).
 *
 * @notice The Base-only send side of the on-demand VPFI reward-budget bridge
 *         (Option C, see docs/DesignsAndPlans/CrossChainRewardBudgetBridge.md).
 *
 *         The cross-chain reward mesh finalizes accounting and broadcasts each
 *         day's global interest denominator to mirrors, which opens the local
 *         claim gate — but nothing funds the VPFI a mirror needs to pay those
 *         claims. This facet closes that gap: it computes each finalized day's
 *         per-chain reward slice and remits the VPFI over the CCIP token path
 *         to the mirror, where a {RewardRemittanceReceiver} (PR2) credits the
 *         mirror Diamond so the unchanged claim path can pay from balance.
 *
 *         On-demand + batched + idempotent, deliberately decoupled from the
 *         `finalizeDay` hot path so a large backlog can be drained in
 *         lane-sized chunks under the VPFI CCIP rate limits, and a failed
 *         batch is safe to retry (already-sent (chain,day) pairs are skipped).
 *
 * @dev    Base-only (`onlyCanonical`): the 69M interaction-reward allowance is
 *         accounted on the canonical chain and the balance it draws against is
 *         funded there, so only Base holds the VPFI to remit. Authorized to
 *         the ADMIN role, or an optional `rewardRemittanceKeeper` EOA for the
 *         apps/keeper automation loop.
 *
 *         Rides the value-carrying `crossChainMessenger` (the same CCIP adapter
 *         buyback uses) on its OWN dedicated `vpfi-reward-budget` channel — NOT
 *         the data-only `rewardMessenger`. Reusing the shared messenger is safe:
 *         on Base the Diamond is NOT a handler on it (the buyback inbound
 *         handler is the separate `BuybackRemittanceReceiver`, and reward data
 *         routes through `VaipakamRewardMessenger`), so `channelOf[Diamond]` is
 *         free and deploy wiring registers the Base Diamond as the reward-budget
 *         channel's handler; on each mirror the {RewardRemittanceReceiver} (a
 *         distinct address from the mirror Diamond) is that channel's handler,
 *         so the one-to-one `channelOf[handler]` binding never collides.
 *         `remitRewardBudget` reverts `RewardBudgetMessengerNotSet` until the
 *         messenger is configured (`TreasuryFacet.setCrossChainMessenger`).
 *
 * #1566 transport epochs PR 3a — the MIRROR-SIDE INGRESS half (the three
 * `on…Received` / `…Arrived` entries and their compensation helpers) moved
 * verbatim to {RewardIngressFacet}: this facet had 285 bytes of EIP-170
 * headroom left, and the ingress is exactly where the transport epochs grow
 * (3a's day-list commitment, 3b's batch admission, PR C's intended-era
 * validation). Same storage, same Diamond, same selectors for every caller;
 * only the runtime bytecode is separate. The two must be refreshed
 * together — the full refresh carries both.
 */
contract RewardRemittanceFacet is
    DiamondAccessControl,
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    /// @dev PR-3c — remit-batch funding decomposition (memory struct so the
    ///      send path stays under the viaIR stack ceiling). #918: the batch
    ///      ACTS on each day it applies a part to (`actedDays`, the funded
    ///      day plus any close-only day riding along) and FUNDS the days whose
    ///      part moves value (`fundedDays`, the list the wire commits to).
    struct RemitDayLists {
        uint256[] fundedDays;
        uint256 fundedCount;
        uint256[] actedDays;
        uint256 actedCount;
    }

    /// @dev B2-d2 / #918: `fresh` / `recycled` are the CLAMPED part this batch
    ///      sends; `armedFresh` / `recycledFull` the commitments it retires
    ///      (each part's own amounts, plus a day's clamp residual on the part
    ///      that retires it — see {LibRemitDayLedger}).
    struct RemitSplitTotals {
        uint256 totalAll;
        uint256 fresh;
        uint256 recycled;
        uint256 armedFresh;
        uint256 armedFrom;
        uint256 recycledFull;
        // Codex #1426 r2/r6 — running NET recycled-backing gate, applied
        // IDENTICALLY at every planning site (send + quotes). An acted day may
        // apply its part only when the POST-part invariant holds:
        // `bucket' >= outstanding'`, i.e.
        // `bucketLeft + recycledFull_part >= outRecycledLeft + recycled_part`
        // (the part retires its commitments while sending only its clamped
        // share). Comparing against the gross bucket (r2's first cut) let an
        // operator-released reservation's stranded hole migrate onto innocent
        // later days: release keeps the bucket custody-true but RESTORES the
        // full outstanding commitment, so outstanding deliberately exceeds
        // backing by the stranded amount — the net gate makes every recycled
        // remit wait until the B2-d5 recovery ceremony heals that hole, and is
        // a structural no-op on the healthy path (finalize reserves
        // commitments ⊆ fundable = bucket − outstanding). #918: the gate is
        // tested on the day's remaining owed (`owedRecycled`,
        // `gateRecycledFull`), not on the part, so a part passes exactly when
        // the rest of its day sent in one would.
        uint256 bucketLeft;
        uint256 outRecycledLeft;
        // #918 — the gate figures ({LibRemitDayLedger.DayPlan}): the fresh the
        // acted days must find new pool room for (an armed day's remaining
        // owed; an unarmed day's owed not yet held for it) and what sending
        // all of it would retire of the armed fresh commitments. The
        // fresh-headroom gate tests these, never the part alone, so a part
        // passes exactly when the rest of its day sent in one would.
        uint256 gateFresh;
        uint256 gateArmedFresh;
        // #918 — the FUNDED day's whole slice, per component, for the d7 wire
        // (every part of a day carries it). The send funds at most one day
        // ({LibRewardCustody.TRANSPORT_DAY_FANOUT_CAP}); a plan funding more is
        // refused before a payload is built.
        uint256 fundedWholeFresh;
        uint256 fundedWholeRecycled;
    }

    /// @dev #1222 M3 B2-d5 — the scalar payload fields {_sendRemitPayload}
    ///      encodes, collected into one memory struct.
    ///
    ///      Passing them individually is what it looked like at first, but
    ///      adding `recycledShare` as an eighth parameter pushed
    ///      {remitRewardBudget} past the viaIR stack ceiling at the call site
    ///      ("Variable ... is 1 too deep"). One pointer keeps a single slot
    ///      live there instead of three. This is a private helper, NOT an ABI
    ///      boundary — sub-structing an ABI-boundary type inflates the coder's
    ///      peak stack and would make things worse.
    struct RemitDispatch {
        /// @dev Total VPFI this remit sends (fresh + recycled).
        uint256 total;
        /// @dev Reservation id this delivery fulfils.
        uint256 remitId;
        /// @dev RECYCLED component of `total` — the mirror credits it as
        ///      relocated custody. Zero on the fresh-only manual path.
        uint256 recycledShare;
    }

    /// @notice ONE plan of a remittance batch, produced by {_planBatch} and
    ///         read by the send and by every quote view.
    /// @dev    #1566 transport epochs PR 3b (#2232 r16 root arrest). The day
    ///         walk - dedupe, finalization, per-day plan, the net recycled-
    ///         backing gate, the funded and acted lists, the totals - used to
    ///         be hand-copied FOUR times (the send, {quoteRemitDayPlans},
    ///         {quoteRewardBudget}, {quoteRemittanceFee}), and each copy
    ///         enforced a different subset of the rules. There is one walk
    ///         now. It REPORTS what it would refuse rather than throwing,
    ///         because its callers legitimately differ in what they do about a
    ///         refusal: the send and the fee quote revert (a dry run must fail
    ///         where the run fails), while the discovery views stay tolerant
    ///         (the keeper scans a window and relies on a non-remittable day
    ///         reading zero, not reverting).
    ///
    ///         `dl` and `st` are the send's own working structs. `perDay` /
    ///         `actionable` / `status` are aligned to the INPUT list; `acted`
    ///         (each acted day's {LibRemitDayLedger.DayPlan}) to
    ///         `dl.actedDays`.
    struct BatchPlan {
        RemitDayLists dl;
        RemitSplitTotals st;
        uint256[] perDay;
        bool[] actionable;
        LibRemitDayLedger.DayPlan[] acted;
        /// @dev Aligned to the INPUT list: each day's status.
        LibRemitDayLedger.RemitDayStatus[] status;
        /// @dev The first unfinalized day in INPUT order, reported rather than
        ///      thrown; `anyUnfinalized` says whether it is meaningful.
        uint256 firstUnfinalized;
        bool anyUnfinalized;
    }

    using SafeERC20 for IERC20;

    /// @notice #1222 M3 B2-d2 (Codex #1426 r5) — minimum reservation age
    ///         before {releaseRemitReservation} may run (plan §M3's bounded
    ///         reconciliation TIMEOUT, enforced on-chain): a merely-delayed
    ///         CCIP message is re-executable and typically lands within
    ///         hours, so a premature release would re-open the days for
    ///         re-funding while the original message can still execute —
    ///         double-funding the mirror. Seven days is far past any
    ///         observed CCIP delay while keeping the terminal usable.
    uint256 internal constant REMIT_RELEASE_MIN_AGE = 7 days;

    // ─── Events ───────────────────────────────────────────────────────────

    /// @notice Emitted when a reward-budget remittance is sent to a mirror.
    /// @param dstChainId Mirror funded.
    /// @param total      VPFI remitted in this batch: the funded day's PART
    ///                   (#918; the day's per-part record is
    ///                   {LibRemitDayLedger.RemitDayPartSent}).
    /// @param fundedDayCount Number of days that ACTUALLY funded VPFI in this
    ///                   batch (skipped/duplicate/zero-part days excluded) —
    ///                   matches the day set carried in the CCIP payload.
    /// @param messageId  CCIP message id, for tracing (zero on a close-only
    ///                   batch — every covered day clamped to zero, nothing
    ///                   dispatched).
    /// @param remitId    B2-d2 delivered-backing reservation id (echoed back
    ///                   by the mirror's ack).
    /// @custom:event-category informational/reward-transport
    event RewardBudgetRemitted(
        uint32 indexed dstChainId,
        uint256 total,
        uint256 fundedDayCount,
        bytes32 messageId,
        uint256 remitId
    );

    /// @notice #1222 M3 B2-d2 — a reservation was finalized: the mirror's
    ///         authenticated ack arrived (`forced` false) or the ADMIN
    ///         force-finalize valve ran against observed CCIP delivery
    ///         evidence (`forced` true, `amountReceived` 0).
    /// @custom:event-category informational/reward-transport
    event RemitReservationAcked(
        uint256 indexed remitId,
        uint32 indexed dstChainId,
        uint256 total,
        uint256 amountReceived,
        bool forced
    );

    // #1662 r12 — the `RemitReservationReleased` NatSpec that used to sit
    //   here was ORPHANED when r4 relocated that event to
    //   {RewardCompensationDispatchFacet} for EIP-170. NatSpec binds to the
    //   next declaration, so it had silently become the documentation for
    //   `RemitAckAfterRelease` below — describing an ADMIN release and a
    //   `recycledStranded` field that event does not have. Deleted rather
    //   than moved: the relocated event carries its own, and this copy also
    //   still claimed physical recovery "restores both", which the §5.3
    //   unification superseded (recovery restores NEITHER; it credits the
    //   recovery position and relocated bucket custody instead).
    /// @notice #1222 M3 B2-d2 — an ack arrived for a RELEASED reservation:
    ///         the operator released in error and the mirror WAS funded
    ///         (double-funding if its days were re-remitted). Surfaced for
    ///         the watcher; never re-finalized.
    /// @custom:event-category informational/reward-transport
    event RemitAckAfterRelease(
        uint256 indexed remitId,
        uint32 indexed srcChainId,
        uint256 amountReceived
    );

    /// @notice #1656 r3 - a forced-finalized compensation reservation's
    ///         authentic ACK arrived later and ran the one-shot
    ///         declared-to-received reconciliation.
    /// @custom:event-category informational/reward-compensation
    event RemitAckAfterForcedFinalize(
        uint256 indexed remitId,
        uint32 indexed sourceChainId,
        uint256 amountReceived
    );

    /// @notice #1656 r9 - an early non-consumed ack held the R6 gate on
    ///         an Acked reservation; the first CONSUMED re-presentation
    ///         (post-confirm) cleared it and reconciled.
    /// @custom:event-category informational/reward-compensation
    event RemitAckLateConsumption(
        uint256 indexed remitId,
        uint32 indexed sourceChainId,
        uint256 amountReceived
    );

    /// @notice #1222 M3 B2-d2 — a mirror dispatched its remit ack toward Base.
    /// @custom:event-category informational/reward-transport
    event RemitAckDispatched(
        uint256 indexed remitId,
        bytes32 messageId,
        uint256 amount
    );


    /// @notice Emitted when the optional keeper automation role is set/cleared.
    /// @custom:event-category informational/config
    event RewardRemittanceKeeperUpdated(address indexed keeper);


    /// @notice Emitted when the mirror-side receiver address is set/cleared.
    /// @custom:event-category informational/config
    event RewardRemittanceReceiverUpdated(address indexed receiver);

    // ─── Errors (facet-local; shared ones come from IVaipakamErrors) ──────

    /// @notice Caller is neither ADMIN nor the configured remittance keeper.
    error NotRewardRemitter(address caller);
    /// @notice The value-carrying cross-chain messenger is unset. Configure it
    ///         with `TreasuryFacet.setCrossChainMessenger` before remitting.
    error RewardBudgetMessengerNotSet();
    /// @notice A requested day has not been finalized on Base yet.
    error RewardDayNotFinalized(uint256 dayId);
    /// @notice No un-remitted, non-zero budget across the requested days.
    error NothingToRemit();
    /// @notice `dayIds` was empty.
    error EmptyDayList();
    /// @notice `partCap` is zero or above the whole interaction pool.
    error InvalidRemittanceCap();
    /// @notice The batch would push the pool's used figure (Base-paid,
    ///         remitted, and what partly sent days hold) over the 69M cap.
    ///         `requested` is the fresh the acted days need NEW room for
    ///         (#918): an armed day's remaining owed, an unarmed day's owed
    ///         not yet held for it — never only this part.
    error RewardPoolCapExceeded(uint256 requested, uint256 remaining);
    /// @notice `msg.value` is below the quoted CCIP fee.
    error InsufficientRemittanceFee(uint256 provided, uint256 required);
    /// @notice Native fee refund to the caller failed.
    error RemittanceRefundFailed();
    /// @notice A non-zero mirror-side receiver was set to an address with no
    ///         code (likely an EOA typo) — the ingress trusts the receiver.
    error RewardReceiverNotContract(address receiver);

    // ─── Modifiers ────────────────────────────────────────────────────────

    function _checkCanonical() private view {
        if (!LibVaipakam.storageSlot().isCanonicalRewardChain) {
            revert NotCanonicalRewardChain();
        }
    }

    /// @dev Thin forwarder to {LibRewardRemitDispatch.freshHeadroomNet} —
    ///      same viaIR stack-shape rationale as {_tail}.
    function _headroom(
        LibVaipakam.Storage storage s,
        uint256 retires
    ) private view returns (uint256) {
        return LibRewardRemitDispatch.freshHeadroomNet(s, retires);
    }

    /// @dev Thin forwarder to {LibRewardRemitDispatch.dispatchRemitTail} —
    ///      exists purely to keep the batch-remit loop's viaIR stack frame
    ///      at its pre-split shape (the inlined library call pushed one
    ///      variable too deep; a private call restores the frame break).
    function _tail(
        LibVaipakam.Storage storage s,
        address vpfi,
        address messenger,
        uint32 dstChainId,
        bytes memory payload,
        uint256 remitId,
        LibRewardCustody.TransportDraw memory draw
    ) private returns (bytes32) {
        return LibRewardRemitDispatch.dispatchRemitTail(
            s, vpfi, messenger, dstChainId, payload, remitId, draw
        );
    }

    /// @dev The pool lives on Base — remittance is a Base-only action.
    modifier onlyCanonical() {
        _checkCanonical();
        _;
    }

    function _checkRemitter() private view {
        if (LibAccessControl.hasRole(LibAccessControl.ADMIN_ROLE, msg.sender)) {
            return;
        }
        address keeper = LibVaipakam.storageSlot().rewardRemittanceKeeper;
        if (keeper == address(0) || msg.sender != keeper) {
            revert NotRewardRemitter(msg.sender);
        }
    }

    /// @dev ADMIN, or the optional keeper EOA (when configured).
    modifier onlyRemitter() {
        _checkRemitter();
        _;
    }

    // ─── Remittance ───────────────────────────────────────────────────────

    /**
     * @notice Remit the un-remitted VPFI reward budget for `dayIds` to
     *         mirror `dstChainId` over the CCIP token path — one PART of the
     *         funded day's slice, no larger than `partCap` (#918).
     * @dev    Idempotent: a `(dstChainId, dayId)` whose whole slice has gone is
     *         skipped (not re-sent), so re-running a batch is safe; a day sent
     *         in part plans only what it still owes. CEI order: marks +
     *         accounting BEFORE the external send; if the send reverts the
     *         whole tx (and the marks) roll back. Forwards exactly the quoted
     *         CCIP native fee and refunds any surplus `msg.value` to the caller.
     *
     *         #918 — a day's slice may go in several sends. Each send moves
     *         `min(owed, partCap)` of the funded day, fresh first, as its own
     *         reservation; the day-close markers stand only when its WHOLE
     *         slice has gone, and the mirror holds the day until every part
     *         has landed there ({LibRemitDayLedger}). A day whose slice exceeds
     *         the lane's capacity is therefore no longer stranded.
     * @param dstChainId Mirror to fund.
     * @param dayIds     Finalized days to remit (any already whole are
     *                   skipped; every day must be finalized). At most ONE of
     *                   them may carry VPFI (#2821, see
     *                   {LibRewardCustody.TRANSPORT_DAY_FANOUT_CAP});
     *                   close-only days may ride along.
     * @param partCap    The most VPFI the funded day moves in THIS call, so the
     *                   operator/keeper keeps a single send under the live VPFI
     *                   CCIP lane bucket. Must be in (0, 69M].
     * @return messageId CCIP message id.
     */
    function remitRewardBudget(
        uint32 dstChainId,
        uint256[] calldata dayIds,
        uint256 partCap
    )
        external
        payable
        nonReentrant
        whenNotPaused
        onlyCanonical
        onlyRemitter
        returns (bytes32 messageId)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        if (dayIds.length == 0) revert EmptyDayList();
        _checkPartCap(partCap);

        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert VPFITokenNotSet();
        address messenger = s.crossChainMessenger;
        if (messenger == address(0)) revert RewardBudgetMessengerNotSet();

        // #2232 r16 root arrest - ONE plan, then apply it. Every refusal a
        // dry run must reproduce is decided on the plan before any write, so
        // the fee quote, which calls the same {_planBatch}, cannot price a
        // batch this refuses. See {BatchPlan}. Only the days that actually
        // move VPFI ride the payload (`dl.fundedDays`), so the mirror's
        // records name exactly the funded day; `dl.actedDays` also holds every
        // close-only day the batch closes, which the reservation records for
        // release.
        BatchPlan memory plan = _planBatch(s, dstChainId, dayIds, partCap);
        if (plan.anyUnfinalized) revert RewardDayNotFinalized(plan.firstUnfinalized);
        RemitDayLists memory dl = plan.dl;
        RemitSplitTotals memory st = plan.st;
        if (dl.actedCount == 0) revert NothingToRemit();
        // Global 69M-cap guard: everything remitted so far, plus what Base has
        // itself paid out locally, plus what partly sent days hold, plus the
        // FRESH this send needs new room for, must stay within the pool.
        // PR-3c — the recycled share is bucket-backed (its finalize-time
        // commitment already reserved it against `fundable`) and never
        // consumes the fresh cap: at fresh exhaustion recycled remittances
        // keep flowing, the promised steady state.
        // #918 — tested on the acted days' remaining owed fresh, not on this
        // part: a day is not started on a margin its whole does not fit. It
        // runs BEFORE the apply loop, which moves the pool hold
        // (`remitDayFreshReserved`): the gate reads the pool as it stood
        // before this send, exactly as every quote does.
        uint256 remaining = _headroom(s, st.gateArmedFresh);
        if (st.gateFresh > remaining) {
            revert RewardPoolCapExceeded(st.gateFresh, remaining);
        }

        uint256 remitId = ++s.remitReservationNonce;
        // APPLY - per acted day, in plan order: lock its whole on its first
        // part, hold an unarmed day's unsent fresh in the pool, add this part,
        // retire its clamp residual when this part does, and close it once
        // whole ({LibRemitDayLedger.applyPart}).
        for (uint256 k; k < dl.actedCount; ) {
            LibRemitDayLedger.applyPart(s, dstChainId, dl.actedDays[k], remitId, plan.acted[k]);
            unchecked {
                ++k;
            }
        }
        // The fan-out bound on the list the destination will receive, by the
        // same rule the fee quote applies to the same plan.
        LibRewardCustody.requireRemittableFanout(dl.fundedCount);

        // Effects (CEI) — before the external send. `rewardBudgetRemittedGlobal`
        // stays the FRESH-only reservation counter (the availability terms in
        // the governor stamp and the claim cap both read it that way);
        // `rewardBudgetRemittedTotal` keeps the full funding record. B2-d2 /
        // #918: `armedFresh` is what this part retires of the armed fresh
        // commitments — its own fresh, plus the day's clamp residual when this
        // part is the one that retires it.
        s.rewardBudgetRemittedGlobal += st.fresh;
        s.rewardBudgetRemittedTotal[dstChainId] += st.totalAll;
        if (st.recycled > 0) {
            // #1566 closure 2 cutover PR 2 (Codex #2206 r5–r7) — the remit's
            // reservation is told exactly which classified records its
            // consumption wrote, so a release reverses exactly that.
            LibVpfiRecycle.consume(st.recycled, true, remitId);
        }
        LibInteractionRewards.consumeArmedFresh(st.armedFresh);

        // B2-d2 — delivered-backing reservation, written BEFORE the external
        // send (CEI). A close-only batch (every acted day moves nothing)
        // dispatches nothing: its reservation is born terminal (Acked) with
        // zero value so the closed days stay traceable, and the full
        // `msg.value` refunds.
        {
            LibVaipakam.RemitReservation storage r =
                s.remitReservations[remitId];
            r.dstChainId = dstChainId;
            r.sentAt = uint64(block.timestamp);
            r.total = st.totalAll;
            r.fresh = st.fresh;
            r.recycled = st.recycled;
            r.armedFreshFull = st.armedFresh;
            r.recycledFull = st.recycledFull;
            r.dayIds = dl.actedDays;
            // #2489 (Codex r2) — which acted days were FUNDED, kept immutably:
            // the d7 root commits to exactly these, and a release clears the
            // live per-day mark they would otherwise be rebuilt from.
            r.fundedDayBits = _fundedDayBits(dl.actedDays, dl.fundedDays);
            if (st.totalAll == 0) {
                r.status = 2; // Acked — nothing in flight, terminal.
            } else {
                r.status = 1; // Pending — awaits the mirror's ack.
                s.remitPendingTotal[dstChainId] += st.totalAll;
            }
        }
        if (st.totalAll == 0) {
            if (msg.value > 0) {
                (bool okRefund, ) =
                    payable(msg.sender).call{value: msg.value}("");
                if (!okRefund) revert RemittanceRefundFailed();
            }
            emit RewardBudgetRemitted(dstChainId, 0, 0, bytes32(0), remitId);
            return bytes32(0);
        }

        // 3d-2 — the ROOTED wire: the payload is built ONCE here, by the same
        // builder the fee quote uses, and the day-list root it commits to is
        // kept on the reservation — the canonical record of what was sent
        // carries the commitment the mirror indexes against. B2-d5's
        // `recycledShare` still rides it: the mirror cannot re-derive it
        // (`p.recycled` is computed after Base's Σcommitments clamp, which is
        // Base-global state), so it drives the arrival's typed caps. #918: so
        // does the day's whole, which the mirror waits for.
        bytes memory payload;
        {
            bytes32 root;
            (payload, root) = _remitPayload(s, dstChainId, dl.fundedDays, st, remitId);
            s.remitReservations[remitId].dayListRoot = root;
        }
        messageId = _sendRemitPayload(
            s,
            vpfi,
            messenger,
            dstChainId,
            payload,
            RemitDispatch({
                total: st.totalAll,
                remitId: remitId,
                recycledShare: st.recycled
            })
        );

        emit RewardBudgetRemitted(
            dstChainId, st.totalAll, dl.fundedCount, messageId, remitId
        );
    }

    /// @dev The part cap the send and the strict dry run both accept: a
    ///      positive figure no larger than the whole interaction pool.
    function _checkPartCap(uint256 partCap) private pure {
        if (partCap == 0 || partCap > LibVaipakam.VPFI_INTERACTION_POOL_CAP) {
            revert InvalidRemittanceCap();
        }
    }

    /// @dev #2489 (Codex r2) — the funded-day bitmap over `closed` (the ACTED
    ///      days, #918): bit `i` set when `closed[i]` is in `funded`. The
    ///      planner appends a day to `funded` exactly when it appends it to the
    ///      acted list with a non-zero part, so `funded` is an in-order
    ///      subsequence of `closed` and one forward pass with two cursors marks
    ///      it.
    function _fundedDayBits(uint256[] memory closed, uint256[] memory funded)
        private
        pure
        returns (uint256[] memory bits)
    {
        bits = new uint256[]((closed.length + 255) >> 8);
        uint256 j;
        for (uint256 i; i < closed.length && j < funded.length; ++i) {
            if (closed[i] == funded[j]) {
                bits[i >> 8] |= uint256(1) << (i & 255);
                unchecked {
                    ++j;
                }
            }
        }
    }

    /**
     * @dev #1222 M3 B2-d2 — the shared remit INTERACTION tail (batch +
     *      manual-budget paths): approve the messenger for exactly `total`,
     *      send the VPFI + widened payload over the CCIP token path, annotate
     *      the reservation with the returned CCIP message id, refund the fee
     *      surplus. `forceApprove` re-sets the allowance to exactly `total`
     *      (handles non-standard ERC20s + any leftover); the receiver
     *      validates delivered-vs-declared against the `total` in the
     *      payload and dual-decodes the legacy 2-tuple.
     *
     *      The post-send reservation annotation is a deliberate state write
     *      after the external call (§M3's messageId binding: a message cannot
     *      carry its own id) — it records the call's own result, the
     *      messenger is the admin-wired CCIP adapter, and every caller is
     *      nonReentrant.
     */
    function _sendRemitPayload(
        LibVaipakam.Storage storage s,
        address vpfi,
        address messenger,
        uint32 dstChainId,
        bytes memory payload,
        RemitDispatch memory d
    ) private returns (bytes32 messageId) {
        uint256 total = d.total;

        // The payload arrives BUILT — by {_remitPayload}, the one builder the
        // fee quote also calls (3d-2). It carries THIS deployment's identity
        // (r4: receipts key by (remitter, remitId), so a rotated deployment's
        // same-numbered remit can never be confused with this one) and LEADS
        // with a keccak-derived wire tag (B2-d5's rule, kept by every later
        // shape): a not-yet-upgraded mirror reads the tag as an array offset,
        // its decoder's bounds check fails and the delivery REVERTS — never a
        // silent mis-decode — and CCIP re-executes it once that mirror is
        // upgraded. See {RemitWire}.
        //
        // #1566 slice 4 PR B — the ordinary remittance names LIVE custody:
        // its fresh share is bounded and charged against the delivered
        // ledger and leaves the live-fresh row, its recycled share leaves
        // the recycled row (the bucket's ledger debit is {consume} above).
        messageId = _tail(
            s,
            vpfi,
            messenger,
            dstChainId,
            payload,
            d.remitId,
            LibRewardCustody.TransportDraw({
                source: LibRewardCustody.TransportSource.Live,
                fresh: total - d.recycledShare,
                recycled: d.recycledShare
            })
        );
    }

    /// @notice The ONE builder of an ordinary remittance's payload — the send
    ///         and its fee quote both call it, so the quote prices exactly the
    ///         bytes the send emits (one walk for a send and all its quotes).
    /// @dev    #918 — the d7 (ROOTED) wire: the funded days are committed to by
    ///         a Merkle root over fixed-size indexed chunks
    ///         ({RemitWire.d6Chunks}, {RemitWire.d6Root}) and travel with the
    ///         extent, the typed split, the era and the funded day's WHOLE
    ///         slice per component. The funded list is bounded by
    ///         {LibRewardCustody.requireRemittableFanout} before this runs, so
    ///         it holds one day (#2821), the root is over one chunk, and the
    ///         whole is that day's. The era word is the custody era the
    ///         DESTINATION last reported (its B4 day report; #1566 PR C
    ///         revision) — eras are numbered per chain, so the receiver
    ///         compares like with like: a delivery the destination has since
    ///         moved past lands in the era it was sent for.
    /// @return payload The wire bytes.
    /// @return root    The day-list root the payload commits to; the send keeps
    ///                 it on the reservation.
    function _remitPayload(
        LibVaipakam.Storage storage s,
        uint32 dstChainId,
        uint256[] memory fundedDays,
        RemitSplitTotals memory st,
        uint256 remitId
    ) private view returns (bytes memory payload, bytes32 root) {
        bytes32[] memory leaves = RemitWire.d6Chunks(fundedDays);
        root = RemitWire.d6Root(leaves);
        // #1566 PR C revision — stamped with the DESTINATION's era as it last
        // reported it. A remittance funding days of an era the destination has
        // since retired is stamped the newer era and files there; its days still
        // draw from its epoch (a draw reads batch membership, never the era), so
        // only where an unused remainder goes once those days close differs.
        payload = RemitWire.encodeD7(
            RemitWire.D7({
                dayListRoot: root,
                elementCount: fundedDays.length,
                chunkCount: leaves.length,
                total: st.totalAll,
                remitId: remitId,
                remitter: address(this),
                recycledShare: st.recycled,
                intendedEra: s.chainCustodyEraReported[dstChainId],
                dayWholeFresh: st.fundedWholeFresh,
                dayWholeRecycled: st.fundedWholeRecycled
            })
        );
    }

    /// @notice THE day walk. See {BatchPlan} for why there is exactly one.
    /// @dev    Pure planning: reads state, writes none, so the same call serves
    ///         a view and the send's planning phase alike. The send applies
    ///         the plan afterwards ({remitRewardBudget}); planning is
    ///         write-independent within a batch because
    ///         {LibRemitDayLedger.planDay} reads only the CURRENT day's cells
    ///         and the send writes only the current day's cells.
    ///
    ///         Duplicates are dropped by an explicit scan. An unfinalized day
    ///         is skipped and REPORTED, not thrown: the send and the fee quote
    ///         revert on it with the first such day in input order, and the
    ///         discovery views keep reading it as zero.
    /// @param partCap The most VPFI one day's part moves (#918). The send and
    ///                the strict dry run pass the caller's cap; the cap-free
    ///                discovery view passes `type(uint256).max`, which plans
    ///                each day's whole remaining owed.
    function _planBatch(
        LibVaipakam.Storage storage s,
        uint32 dstChainId,
        uint256[] calldata dayIds,
        uint256 partCap
    ) private view returns (BatchPlan memory plan) {
        uint256 n = dayIds.length;
        plan.dl.fundedDays = new uint256[](n);
        plan.dl.actedDays = new uint256[](n);
        plan.perDay = new uint256[](n);
        plan.actionable = new bool[](n);
        plan.acted = new LibRemitDayLedger.DayPlan[](n);
        plan.status = new LibRemitDayLedger.RemitDayStatus[](n);
        plan.st.armedFrom = s.governorCommitArmedFromDay;
        // Net of what staging records have reserved (Codex #2308 r11): a
        // remit may not send a resolving record's recycled backing away.
        plan.st.bucketLeft = LibVpfiRecycle.bucketAvailable(s);
        plan.st.outRecycledLeft = s.outstandingCommitRecycled;
        for (uint256 i; i < n; ) {
            uint256 dayId = dayIds[i];
            bool seen;
            for (uint256 j; j < i; ) {
                if (dayIds[j] == dayId) {
                    seen = true;
                    break;
                }
                unchecked {
                    ++j;
                }
            }
            if (seen) {
                plan.status[i] = LibRemitDayLedger.RemitDayStatus.Repeated;
            } else if (!s.dailyGlobalFinalized[dayId]) {
                plan.status[i] = LibRemitDayLedger.RemitDayStatus.NotFinalized;
                if (!plan.anyUnfinalized) {
                    plan.anyUnfinalized = true;
                    plan.firstUnfinalized = dayId;
                }
            } else {
                _planOne(s, dstChainId, dayId, i, partCap, plan);
            }
            unchecked {
                ++i;
            }
        }
        // Truncate the two lists to what was written (memory-safe: lengths
        // only ever shrink), so every consumer reads exact arrays. `acted`
        // stays at its allocated length; its readers index it by
        // `dl.actedCount`.
        {
            uint256[] memory fundedDays_ = plan.dl.fundedDays;
            uint256 fundedCount_ = plan.dl.fundedCount;
            uint256[] memory actedDays_ = plan.dl.actedDays;
            uint256 actedCount_ = plan.dl.actedCount;
            assembly ("memory-safe") {
                mstore(fundedDays_, fundedCount_)
                mstore(actedDays_, actedCount_)
            }
        }
    }

    /// @dev One finalized, first-seen day of {_planBatch}: plan its part and
    ///      apply the net recycled-backing gate to it, in its own frame (the
    ///      walk sits at the viaIR stack ceiling).
    function _planOne(
        LibVaipakam.Storage storage s,
        uint32 dstChainId,
        uint256 dayId,
        uint256 i,
        uint256 partCap,
        BatchPlan memory plan
    ) private view {
        LibRemitDayLedger.DayPlan memory p =
            LibRemitDayLedger.planDay(s, dstChainId, dayId, plan.st.armedFrom, partCap);
        plan.status[i] = p.status;
        if (!p.act) return;
        RemitSplitTotals memory st = plan.st;
        // The net recycled-backing gate, applied identically for every caller
        // because it is applied HERE (Codex #1426 r2/r6): a part applies only
        // when the post-part invariant `bucket' >= outstanding'` still holds.
        if (st.bucketLeft + p.gateRecycledFull < st.outRecycledLeft + p.owedRecycled) {
            plan.status[i] = LibRemitDayLedger.RemitDayStatus.Unbacked;
            return;
        }
        st.bucketLeft -= p.recycled;
        st.outRecycledLeft = st.outRecycledLeft > p.recycledFull
            ? st.outRecycledLeft - p.recycledFull
            : 0;
        uint256 part = p.fresh + p.recycled;
        plan.perDay[i] = part;
        plan.actionable[i] = true;
        RemitDayLists memory dl = plan.dl;
        uint256 c = dl.actedCount;
        dl.actedDays[c] = dayId;
        plan.acted[c] = p;
        dl.actedCount = c + 1;
        if (part > 0) {
            dl.fundedDays[dl.fundedCount] = dayId;
            unchecked {
                ++dl.fundedCount;
            }
            st.totalAll += part;
            st.fresh += p.fresh;
            st.recycled += p.recycled;
            st.fundedWholeFresh = p.wholeFresh;
            st.fundedWholeRecycled = p.wholeRecycled;
        }
        st.armedFresh += p.armedFresh;
        st.recycledFull += p.recycledFull;
        st.gateFresh += p.gateFresh;
        st.gateArmedFresh += p.gateArmedFresh;
    }

    // ─── Admin ────────────────────────────────────────────────────────────

    /**
     * @notice Set (or clear, with `address(0)`) the optional keeper EOA allowed
     *         to call {remitRewardBudget} alongside ADMIN.
     * @dev    ADMIN-only. Default unset = owner-only remittance.
     */
    function setRewardRemittanceKeeper(
        address keeper
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.storageSlot().rewardRemittanceKeeper = keeper;
        emit RewardRemittanceKeeperUpdated(keeper);
    }

    /**
     * @notice Set (or clear, with `address(0)`) the mirror-side
     *         {RewardRemittanceReceiver} authorized to call the budget and
     *         compensation ingresses on this (mirror) Diamond.
     * @dev    ADMIN-only. Base leaves this unset. A non-zero receiver MUST have
     *         code — the ingress trusts this address (it inflates
     *         `rewardBudgetReceivedTotal` + emits the reconciliation record
     *         without a balance-delta check), so an EOA typo'd here would let
     *         that EOA fabricate funded-day events. `address(0)` clears it.
     */
    function setRewardRemittanceReceiver(
        address receiver
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (receiver != address(0) && receiver.code.length == 0) {
            revert RewardReceiverNotContract(receiver);
        }
        LibVaipakam.storageSlot().rewardRemittanceReceiver = receiver;
        emit RewardRemittanceReceiverUpdated(receiver);
    }

    // ─── #1222 M3 B2-d2 — mirror-side remit ack ───────────────────────────

    /**
     * @notice Dispatch this mirror's delivery ACK for `remitId` toward Base,
     *         finalizing Base's delivered-backing reservation.
     * @dev    Mirror-only, permissionless, and deliberately RE-SENDABLE: the
     *         content is computed from this Diamond's own receipt record (a
     *         caller can neither forge nor inflate it), Base finalizes
     *         idempotently, and the caller pays the CCIP fee — so a repeat
     *         send is a fee-payer's retry lever for a lost ack, not a grief.
     *         Quote first via {quoteRemitAckFee}; the messenger refunds any
     *         surplus to `refundAddress`.
     */
    function sendRemitAck(
        uint256 remitId,
        address remitter,
        address payable refundAddress
    )
        external
        payable
        nonReentrant
        whenNotPaused
        returns (bytes32 messageId)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!LibVaipakam.isMirrorRewardChain(s)) {
            revert OnlyMirrorRewardChain();
        }
        address messenger = s.rewardMessenger;
        if (messenger == address(0)) revert RewardMessengerNotSet();
        LibVaipakam.ReceivedRemit storage rec =
            s.receivedRemits[LibRewardCustody.remitReceiptKey(remitter, remitId)];
        if (rec.receivedAt == 0) revert ReceivedRemitNotFound(remitId);
        // Codex #1426 r2 — a receipt is bound to the Base DEPLOYMENT that
        // sent it: remit ids are per-deployment, so after an owner
        // base-chain rotation an ack for a stale receipt routed to the NEW
        // base could finalize an unrelated same-numbered reservation there.
        // Stale receipts are rejected; the old deployment's reservation
        // resolves through its own operator valves.
        if (rec.srcChainId != s.baseChainId) {
            revert ReceivedRemitStale(remitId, rec.srcChainId);
        }
        // r3/r4 — echo the receipt's PAYLOAD-recorded remitter so the
        // canonical ingress can verify the ack names ITSELF (remit ids are
        // per-deployment; see {LibVaipakam.ReceivedRemit.remitter}).
        // #1656 r8 / #1660 r5 - the wire carries the receipt's full
        // CLASSIFICATION (0 consumed / 1 quarantined / 2 provisional),
        // not a collapsed consumed bit: only a consumption ack clears
        // the Base R6 gate, and only a QUARANTINE ack is B1-return
        // evidence - an Acked-non-consumed state alone could be a
        // PROVISIONAL receipt that later confirms as consumed, so Base
        // must be able to tell the two apart. Re-presentable: after the
        // confirm/demote the stored classification changes and the ack
        // re-presents with the new value.
        // #1660 r6 - WIRE classification = storage classification + 1:
        // value 0 is deliberately unassigned, so an all-zero or truncated
        // word can never read as a classification and fails closed at
        // both ends.
        messageId = IRewardMessenger(messenger).sendRemitAck{value: msg.value}(
            remitId,
            rec.amount,
            rec.remitter,
            rec.classification + 1,
            refundAddress
        );
        emit RemitAckDispatched(remitId, messageId, rec.amount);
    }


    // ─── #1222 M3 B2-d2 — Base-side ack ingress + operator valves ─────────

    /**
     * @notice Ingress for a mirror→Base remit ACK (called by the reward
     *         messenger after peer authentication): finalizes the echoed
     *         reservation exactly once.
     * @dev    Idempotent on re-delivery (an already-Acked reservation
     *         no-ops); an ack for a RELEASED reservation is surfaced via
     *         {RemitAckAfterRelease} — the operator released in error and
     *         the mirror WAS funded — never re-finalized. A never-issued
     *         `remitId` reverts (bogus packet; CCIP keeps it failed).
     *         `amountReceived` is recorded on the event for anomaly
     *         monitoring; delivery itself is what finalizes (a
     *         fee-on-transfer shortfall is an anomaly to surface, not a
     *         reason to hold Base's accounting open).
     */
    function onRemitAckReceived(
        uint32 sourceChainId,
        uint256 remitId,
        uint256 amountReceived,
        address remitter,
        // #1656 r8 / #1660 r5 - the mirror-attested receipt
        // CLASSIFICATION (0 consumed / 1 quarantined / 2 provisional).
        // Consumption gates the R6 clear + compFunded reconciliation;
        // QUARANTINE is the B1 return's eligibility evidence - a
        // provisional attestation stamps neither (it can still confirm
        // as consumed, and treating it as quarantine would let a faulty
        // mirror return value ahead of that confirmation).
        uint8 classification
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.rewardMessenger || s.rewardMessenger == address(0))
        {
            revert NotAuthorizedRewardMessenger();
        }
        if (!s.isCanonicalRewardChain) revert NotCanonicalRewardChain();
        // Codex #1426 r3/r4 — the ack must name THIS deployment: the echo
        // is the remit PAYLOAD's embedded sender identity (immutable,
        // messenger-authenticated message data recorded on the mirror's
        // receipt — never delivery-time channel config), and remit ids
        // restart per deployment, so a stale-era receipt (pre-rotation,
        // possibly same chain id) can never finalize a same-numbered
        // reservation here.
        // #1434 P2-w6 (§5.4 R6e) — there is NO imported-marker branch
        // here any more. The r1 shape put one BEFORE the era check, so a
        // mirror's re-presented old-era ack could resolve a carried gate;
        // r7 deleted it (see the note below the classification check), and
        // old-era remitters now fall through to the ordinary era check
        // like any other stale sender. An imported gate is released only
        // by the operator's evidenced {clearImportedOutstanding}.
        // #1660 r6 - the wire offsets classification by one (0 is
        // unassigned): 1 consumed / 2 quarantined / 3 provisional. Zero or out-of-range fails
        // closed and re-executable - never guessed at. (#1662 r1 -
        // validated BEFORE the imported branch, so an imported tuple's
        // malformed ack fails closed too, never "observes".)
        if (classification == 0 || classification > 3) {
            revert RemitAckClassificationInvalid(classification);
        }
        // #1662 r7 — there is NO permissionless clear for an imported
        // gate. A mistyped import can name an unrelated, already-CONSUMED
        // historical receipt, and that receipt's re-presented ack would
        // clear the sentinel while the genuinely outstanding delivery is
        // still live — the replacement and the original would then BOTH
        // back mirror claims. Binding the import to the real outstanding
        // gate would need the predecessor read that r6 removed (it cannot
        // be authenticated), so the permissionless path goes instead:
        // an imported gate clears ONLY through the operator's evidenced
        // {clearImportedOutstanding}. That is what makes a mistaken
        // import genuinely liveness-only.
        if (remitter != address(this)) {
            revert RemitAckSenderMismatch(remitId, remitter);
        }
        LibVaipakam.RemitReservation storage r = s.remitReservations[remitId];
        bool consumed = classification == 1;
        bool quarantined = classification == 2;
        if (r.status == 2) {
            if (r.dstChainId == sourceChainId) {
                // #1656 r3 - a FORCED finalization preserved declared
                // funding with no received figure; the FIRST authentic
                // ACK that lands afterwards carries it. One-shot (the
                // flag clears).
                // #1656 r10 - the one-shot survives NON-consumed acks:
                // a provisional ack dispatched pre-confirm but arriving
                // post-force must not burn the flag before the consumed
                // re-presentation can reconcile.
                bool ackConflict;
                if (consumed) {
                    ackConflict = _stampConsumedAck(s, r, remitId, amountReceived);
                    // #1452 — a consumption first attested by this
                    // re-presentation (or confirming a forced one) is booked.
                    _bookRecycledDelivered(s, r, amountReceived, false);
                }
                if (quarantined) _stampQuarantineAck(r, remitId);
                if (r.forcedFinalized && consumed && !ackConflict) {
                    r.forcedFinalized = false;
                    _reconcileCompFunded(s, r, amountReceived);
                    emit RemitAckAfterForcedFinalize(
                        remitId, sourceChainId, amountReceived
                    );
                }
                // #1656 r9 - the LATE-CONSUMPTION settle: an early
                // NON-consumed ack (provisional delivery, ack before the
                // V3 confirm) Acked the reservation while the R6 gate
                // held. The first CONSUMED re-presentation after the
                // confirm clears the gate and reconciles - a normal
                // cross-chain ordering, not an error path. Idempotent:
                // once cleared, the gate no longer names this remit.
                if (
                    consumed && !ackConflict
                        && s.compensationOutstanding[r.dstChainId]
                            == remitId
                ) {
                    LibRewardRemitDispatch.clearCompensationGate(
                        s, r.dstChainId
                    );
                    _reconcileCompFunded(s, r, amountReceived);
                    emit RemitAckLateConsumption(
                        remitId, sourceChainId, amountReceived
                    );
                }
            }
            return;
        }
        if (r.status == 3) {
            // #1660 r5 - a RELEASED reservation's late ack still records
            // its classification EVIDENCE (nothing else): the B1 return
            // requires a quarantine attestation even for released
            // reservations - released-alone says the MESSAGE was deemed
            // dead, not what the delivery became if it executed after
            // all (it could have been consumed, and a return against
            // consumed lineage is the r4/r5 bypass).
            if (r.dstChainId == sourceChainId) {
                if (consumed) {
                    bool relConflict = _stampConsumedAck(s, r, remitId, amountReceived);
                    // #1452 — the mirror credited it after all: relocated
                    // custody it must hold, so it is booked as delivered.
                    _bookRecycledDelivered(s, r, amountReceived, false);
                    // #1662 r2 (self-review) — a CLEAN consumption on a
                    // released reservation CLEARS the gate. The release
                    // held it pending the value's fate; a consumed
                    // delivery IS that fate settled (§5.1's clearing
                    // evidence — the compensation funded the obligation
                    // after all), so the gate's premise is discharged and
                    // nothing needs recovering. Withholding the clear
                    // here bricked the chain permanently: consumption
                    // closes the return path AND both governance
                    // settlement records, leaving no writer able to
                    // clear. A CONTRADICTED consumption still clears
                    // nothing (w5's withheld privileges) — that case
                    // resolves through the operator's evidenced
                    // settlement, which {_consumptionTrusted} keeps open.
                    if (
                        !relConflict
                            && s.compensationOutstanding[r.dstChainId]
                                == remitId
                    ) {
                        LibRewardRemitDispatch.clearCompensationGate(
                            s, r.dstChainId
                        );
                        emit RemitAckLateConsumption(
                            remitId, sourceChainId, amountReceived
                        );
                    }
                }
                if (quarantined) _stampQuarantineAck(r, remitId);
                // #1461 — AFTER the stamps: the stranded share resolves only on
                // a TRUSTED consumption (the mirror credited it); anything else
                // is left to the ceremony / loss record.
                LibVpfiRecycle.settleReleasedRemitStranded(s, remitId);
            }
            emit RemitAckAfterRelease(remitId, sourceChainId, amountReceived);
            return;
        }
        if (r.status != 1) revert RemitReservationNotPending(remitId);
        if (r.dstChainId != sourceChainId) {
            revert RemitAckChainMismatch(remitId, r.dstChainId, sourceChainId);
        }
        _finalizeReservation(
            s, r, remitId, amountReceived, false, consumed, quarantined
        );
    }

    /**
     * @notice ADMIN valve — finalize a PENDING reservation against observed
     *         CCIP delivery evidence (the delivered-but-ack-lost terminal,
     *         when the mirror's re-sendable ack path cannot recover it).
     * @dev    Evidenced + manual by design (plan §M3's bounded
     *         reconciliation): the operator verifies the CCIP message
     *         executed on the destination before finalizing.
     */
    function finalizeRemitReservation(
        uint256 remitId
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) onlyCanonical {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.RemitReservation storage r = s.remitReservations[remitId];
        if (r.status != 1) revert RemitReservationNotPending(remitId);
        // #1656 r8 - the forced finalize is the operator's consumption
        // attestation (same evidenced mould as the ACK), so it clears
        // the gate.
        _finalizeReservation(s, r, remitId, 0, true, true, false);
    }


    /// @dev #1656 r2/r3 - the declared-to-received reconciliation of the
    ///      per-side funded cumulative for a COMPENSATION reservation
    ///      (single-day by construction): a short delivery re-opens
    ///      exactly the supplemental headroom it left. Pro-rata over the
    ///      reservation's declared split; the mirror's receiver scales
    ///      its credited shares the same way, and rounding skew is
    ///      absorbed by the saturating subtraction + the per-side quote
    ///      bound.
    function _reconcileCompFunded(
        LibVaipakam.Storage storage s,
        LibVaipakam.RemitReservation storage r,
        uint256 amountReceived
    ) private {
        uint256 total = r.total;
        if (amountReceived >= total || total == 0 || r.dayIds.length != 1) {
            return;
        }
        uint32 dst = r.dstChainId;
        uint256 d = r.dayIds[0];
        uint256 redL = r.declaredLender18
            - (r.declaredLender18 * amountReceived) / total;
        uint256 redB = r.declaredBorrower18
            - (r.declaredBorrower18 * amountReceived) / total;
        uint256 curL = s.compFundedLender18[dst][d];
        uint256 curB = s.compFundedBorrower18[dst][d];
        s.compFundedLender18[dst][d] = curL > redL ? curL - redL : 0;
        s.compFundedBorrower18[dst][d] = curB > redB ? curB - redB : 0;
    }

    /// @dev Shared ack/force finalize: Pending → Acked, pending → acked
    ///      aggregates rolled.
    /// @notice #1660 r8 - contradictory terminal classifications landed
    ///         for one receipt (an honest mirror can never produce both:
    ///         quarantined never transitions to consumed, nor consumed to
    ///         quarantined). The still-unspent slice of any return credit
    ///         is clawed into the overage quarantine; what a re-dispatch
    ///         already consumed is unrecoverable on-chain and becomes the
    ///         recovery ceremony's evidence.
    /// @custom:event-category state-change/reward-compensation
    event RemitAckClassificationConflict(
        uint256 indexed remitId,
        uint256 clawedToOverage,
        uint256 unrecoverable
    );

    /// @dev #1662 r4 - ONE implementation of the recovery-credit VOID.
    ///      Both the own-era contradiction claw and the settled-import
    ///      tombstone need exactly this rule, and writing it twice is how
    ///      the two drifted in the first place: the ENTITLEMENT is voided
    ///      whole, while only what the pooled position can absorb moves
    ///      PHYSICALLY to the overage quarantine. Idempotent - a replay
    ///      recomputes `unspent` as zero and does nothing.
    /// @return claw    what physically moved to the quarantine.
    /// @return unspent the entitlement voided (always >= claw).
    function _voidRecoveryCredit(
        LibVaipakam.Storage storage s,
        uint256 receiptId
    ) private returns (uint256 claw, uint256 unspent) {
        uint256 credit = s.remitRecoveredForReceipt[receiptId]
            - s.ceremonyRecycledRecovered[receiptId];
        uint256 spent = s.recoveryRedispatchedForReceipt[receiptId]
            + s.recoveryClawedForReceipt[receiptId];
        unspent = credit > spent ? credit - spent : 0;
        if (unspent == 0) return (0, 0);
        uint256 avail =
            s.rewardBudgetRecovered - s.rewardBudgetRedispatched;
        claw = unspent < avail ? unspent : avail;
        if (claw != 0) {
            s.rewardBudgetRecovered -= claw;
            s.strandedReturnOverage += claw;
            // #1566 slice 4 PR B — the claw is an in-holder re-attribution
            // on an activated deployment: recovery row → overage row.
            if (LibRewardCustody.active(s)) {
                LibRewardCustody.callMove(
                    LibVaipakam.RewardCustodyRow.Recovery, LibVaipakam.RewardCustodyRow.Overage, claw
                );
            }
        }
        s.recoveryClawedForReceipt[receiptId] += unspent;
    }

    /// @dev #1660 r8 - stamp a CONSUMED attestation. Returns true when it
    ///      CONTRADICTS a prior quarantine attestation: the caller must
    ///      then withhold the consumed-ack privileges (gate clear +
    ///      reconciliation) - a mirror contradicting itself gets no
    ///      further trust extended. The conflict freezes the receipt's
    ///      return credit: the unspent slice moves to the overage
    ///      quarantine (not claimable, not re-dispatchable), and
    ///      `consumedAcked` blocks every further B1 credit.
    ///      #1662 r2 (self-review) - the CLAW now fires on ANY standing
    ///      recovery credit for the receipt, not only on a
    ///      mirror-self-contradiction. A w6 recovery ceremony credits the
    ///      position WITHOUT requiring a quarantine attestation (its
    ///      evidence is governance + physical backing, not the mirror), so
    ///      gating the claw on `quarantineAcked` let ceremony-minted
    ///      UNCHARGED re-dispatch capacity survive a later consumed
    ///      attestation - capacity backing value that also backs mirror
    ///      claims, the exact 69M bypass the claw exists to prevent. The
    ///      RETURN value stays the mirror-self-contradiction signal: a
    ///      ceremony contradicted by consumption is governance-vs-mirror,
    ///      which does not impeach the ack's own privileges.
    function _stampConsumedAck(
        LibVaipakam.Storage storage s,
        LibVaipakam.RemitReservation storage r,
        uint256 remitId,
        // #1662 r7 — the authenticated received figure, so the funding
        // re-close below can reconcile a SHORT delivery instead of
        // recording the day as fully funded and blocking its supplement.
        uint256 amountReceived
    ) private returns (bool conflict) {
        conflict = r.quarantineAcked;
        r.consumedAcked = true;
        // #1660 r9 - ONE-SHOT: a replayed consumed ack on an already-
        // conflicted receipt keeps the privileges withheld (the return
        // value) but must not claw again - `avail` is the GLOBAL
        // position balance, and a replay after another receipt's
        // legitimate credit would drain unrelated capacity into the
        // overage quarantine.
        // #1662 r2 (self-review) - the POSITION-provenance part only.
        // Pre-w6 the per-receipt cumulative was 1:1 with position credits
        // (B1 returns credit the position in full), but a ceremony folds
        // its RECYCLED half into the same cumulative while sending that
        // half to the BUCKET - clawing on the raw cumulative would debit
        // the global position for value that never entered it, i.e. drain
        // UNRELATED receipts' legitimate capacity into the permanent
        // overage quarantine. The recycled half is physically-present
        // bucket custody (the settlement's backing assertion proved the
        // tokens are here); freezing it would strand real tokens outside
        // every ledger, and it mints no uncharged emission capacity.
        // #1662 r2 - this receipt's OWN UNSPENT credit, never the
        // pooled balance. The position is fungible but the claw is not:
        // once receipt A's credit has been re-dispatched, `avail` is
        // made of OTHER receipts' credits, and clawing against it
        // permanently confiscates capacity they can never re-earn
        // (their own per-receipt entitlement is already exhausted).
        // A's already-spent slice is genuinely unrecoverable on-chain
        // and is reported as such in the event.
        uint256 rec = s.remitRecoveredForReceipt[remitId]
            - s.ceremonyRecycledRecovered[remitId];
        if ((conflict || rec != 0) && !r.conflictClawed) {
            r.conflictClawed = true;
            (uint256 claw, ) = _voidRecoveryCredit(s, remitId);
            emit RemitAckClassificationConflict(remitId, claw, rec - claw);
        }
        // #1660 r11 / #1662 r2 - a settled released receipt whose
        // delivery turns out to have been CONSUMED must have its funding
        // accounting RE-CLOSED: the release (or the terminal return)
        // unwound the declared contribution on the premise that the
        // message never executed, and a consumed delivery falsifies
        // that premise - the value does back mirror claims after all.
        // Leaving it unwound lets governance dispatch a replacement
        // against a quote the original already funded, OVERFUNDING the
        // obligation.
        //
        // r2 widened this beyond terminalized (B1-returned) receipts: a
        // receipt settled by CEREMONY or terminal loss alone never
        // terminalizes, so it took no re-close at all. `declaredUnwound`
        // is itself the one-shot - clearing it IS the closure - and the
        // compensation shape is checked here rather than inherited from
        // the terminalized guard. The day re-closes under the original
        // receipt only if still open, so a successor's closure (and its
        // gate) is never clobbered.
        // #1662 r7 — only a TRUSTED, RECONCILED re-close.
        //
        // (a) NOT under contradiction. A quarantine→consumed sequence
        //     earns no trust anywhere else — the gate stays held for
        //     governance — so re-closing funding on it would leave the
        //     operator unable to fund a replacement even after recording
        //     the old parcel as lost: the quote bound would refuse it.
        //
        // (b) RECONCILED to what actually arrived. Restoring the full
        //     DECLARED split for a short delivery records the day as
        //     fully funded and blocks the legitimate supplement for the
        //     shortfall — the same declared-vs-received reconciliation
        //     the ordinary ack path performs.
        // The CONFLICT carve-out is conditional, because two findings pull
        // opposite ways and the deciding fact is whether the R6 gate is
        // still protecting this obligation:
        //   - a TERMINAL RETURN both cleared the gate and re-opened the
        //     day (#1660 r11). Nothing blocks a replacement there, so a
        //     contradicting consumption MUST re-close or the day is
        //     funded twice while the consumed value also backs claims.
        //   - a plain RELEASE holds the gate pending governance (#1662
        //     r7). The gate already blocks the replacement, so re-closing
        //     adds no protection and actively harms: after governance
        //     records the parcel lost, the quote bound would refuse the
        //     replacement the settlement exists to enable.
        // #1662 r8 — keyed on the GATE, not on terminalization. Round 7
        // used `strandedReturnTerminalized` as a proxy for "the gate was
        // cleared", which is wrong for a PARTIAL return: a nonterminal
        // chunk clears the gate too but never sets the terminal flag, so
        // the proxy skipped the re-close on exactly the path where the
        // obligation had already lost its protection. State the principle
        // directly instead of proxying it.
        if (
            (!conflict || s.compensationOutstanding[r.dstChainId] != remitId)
                && r.declaredUnwound
                && r.dayIds.length == 1
                && (r.declaredLender18 != 0 || r.declaredBorrower18 != 0)
        ) {
            uint32 cdst = r.dstChainId;
            uint256 cday = r.dayIds[0];
            uint256 total = r.total;
            uint256 restoreL = r.declaredLender18;
            uint256 restoreB = r.declaredBorrower18;
            if (amountReceived < total && total != 0) {
                restoreL = (restoreL * amountReceived) / total;
                restoreB = (restoreB * amountReceived) / total;
            }
            if (s.dayClosedByRemitId[cdst][cday] == 0) {
                s.dayClosedByRemitId[cdst][cday] = remitId;
                s.rewardBudgetRemitted[cdst][cday] = restoreL + restoreB;
            }
            r.declaredUnwound = false;
            s.compFundedLender18[cdst][cday] += restoreL;
            s.compFundedBorrower18[cdst][cday] += restoreB;
        }
    }

    /// @dev #1660 r8 - stamp a QUARANTINE attestation; refused (with the
    ///      conflict surfaced) when a consumed attestation already stands
    ///      - B1 eligibility must never be forged onto a consumed receipt.
    function _stampQuarantineAck(
        LibVaipakam.RemitReservation storage r,
        uint256 remitId
    ) private {
        if (r.consumedAcked) {
            emit RemitAckClassificationConflict(remitId, 0, 0);
            return;
        }
        r.quarantineAcked = true;
    }

    /// @dev #1452 — book a reservation's recycled share in Base's per-destination
    ///      delivered figures, once, at its first ATTESTED CONSUMPTION: by the
    ///      delivery's own consumed acknowledgement (`chainRemittedRecycledAcked`,
    ///      the figure the mesh watcher holds the mirror's relocated custody to),
    ///      or by the operator's forced finalization (`...ForceFinalized`, apart —
    ///      evidenced, not delivered). An authentic consumption that later
    ///      confirms a forced one moves the share across; nothing else books.
    ///      A CONTRADICTED consumption (quarantine reported first) books too:
    ///      the mirror reported crediting it, and booking is the stricter
    ///      direction for this check — the opposite of the stranded settle,
    ///      which refuses to resolve on it, also the stricter direction there.
    ///
    ///      An authentic acknowledgement books what the mirror RELOCATED, not
    ///      what was declared (Codex #2489 r3): on a short delivery (fee on
    ///      transfer) the receiver relocates the declared share scaled to what
    ///      landed, `floor(recycled * received / total)`, and the mesh watcher
    ///      holds the mirror's relocated custody to this figure — booking the
    ///      declared share there was a permanent false critical for every short
    ///      delivery. The forced bucket keeps the declared share: a forced
    ///      finalization carries no received figure (its `amountReceived` is a
    ///      zero sentinel), and that bucket is evidence, not delivery. The move
    ///      from forced to acked takes the declared share OFF the forced figure
    ///      (what was put there) and puts the delivered share ON the acked one.
    function _bookRecycledDelivered(
        LibVaipakam.Storage storage s,
        LibVaipakam.RemitReservation storage r,
        uint256 amountReceived,
        bool forced
    ) private {
        uint8 booked = r.recycledBooked;
        if (booked == RECYCLED_BOOKED_ACKED) return; // booked once, at the first consumption
        uint32 dst = r.dstChainId;
        uint256 declared = r.recycled;
        if (forced) {
            // Only a PENDING reservation is force-finalized, and nothing books
            // before finalization, so a forced booking is always the first.
            s.chainRemittedRecycledForceFinalized[dst] += declared;
            r.recycledBooked = RECYCLED_BOOKED_FORCED;
            return;
        }
        if (booked == RECYCLED_BOOKED_FORCED) {
            uint256 f = s.chainRemittedRecycledForceFinalized[dst];
            s.chainRemittedRecycledForceFinalized[dst] = f > declared ? f - declared : 0;
        }
        s.chainRemittedRecycledAcked[dst] += _deliveredShare(declared, amountReceived, r.total);
        r.recycledBooked = RECYCLED_BOOKED_ACKED;
    }

    /// @dev The share of `declared` that a delivery of `received` out of `total`
    ///      relocated on the mirror — the receiver's own flooring
    ///      (`RewardRemittanceReceiver`: `mulDiv(share, actualReceived,
    ///      declaredTotal)`), so the two sides compute one figure. A full or
    ///      over-delivery, or a reservation with no total, is the declared share.
    function _deliveredShare(uint256 declared, uint256 received, uint256 total) private pure returns (uint256) {
        if (received >= total || total == 0) return declared;
        return Math.mulDiv(declared, received, total);
    }

    /// @dev {RemitReservation.recycledBooked} states (0 = not booked).
    uint8 private constant RECYCLED_BOOKED_FORCED = 1;
    uint8 private constant RECYCLED_BOOKED_ACKED = 2;

    function _finalizeReservation(
        LibVaipakam.Storage storage s,
        LibVaipakam.RemitReservation storage r,
        uint256 remitId,
        uint256 amountReceived,
        bool forced,
        // #1656 r8 - false for a quarantined / still-provisional
        // delivery's ack: the reservation still finalizes (delivery
        // evidence), but the R6 gate HOLDS - SS5.1's clearing evidence
        // is CONSUMPTION, and a stranded delivery settles via the w5
        // return.
        bool consumed,
        // #1660 r5 - the ack specifically attested QUARANTINE (the B1
        // return's eligibility evidence; provisional stamps neither).
        bool quarantined
    ) private {
        r.status = 2;
        uint32 dst = r.dstChainId;
        uint256 total = r.total;
        uint256 pending = s.remitPendingTotal[dst];
        s.remitPendingTotal[dst] = pending > total ? pending - total : 0;
        s.remitAckedTotal[dst] += total;
        // #1452 — only an attested CONSUMPTION books the recycled share: the
        // mirror relocates custody when it credits a delivery, never for a
        // quarantined or provisional one.
        if (consumed) _bookRecycledDelivered(s, r, amountReceived, forced);
        // #1434 P2-w4 (§5.1 R6) — a finalized COMPENSATION reservation
        // clears the chain's one-in-flight gate. The consumption ACK is
        // the ratified clearing evidence; the operator-evidenced forced
        // finalize is its equivalent (same consumption semantics, same
        // mould). A cancel/release does NOT come through here — it
        // records terminal message state while the gate HOLDS (ratified),
        // pending the w5 return / w6 recovery settlements.
        // #1660 r3 - the CONSUMPTION stamp: a consumed receipt is not
        // B1-recoverable (its value entered the mirror's compensated
        // pools as claim backing; a return against it would reuse the
        // dispatch's cap lineage). Stamped whether or not the gate
        // still names this remit.
        bool ackConflict;
        if (consumed) ackConflict = _stampConsumedAck(s, r, remitId, amountReceived);
        else if (quarantined) _stampQuarantineAck(r, remitId);
        if (consumed && !ackConflict && s.compensationOutstanding[dst] == remitId) {
            LibRewardRemitDispatch.clearCompensationGate(s, dst);
            // #1656 r2 - AUTHENTIC ACKs only: the forced finalize passes
            // amountReceived = 0 as a sentinel, and reading it as a real
            // zero-token delivery would subtract the whole declared split
            // and let the same obligation fund twice. A forced
            // finalization preserves declared funding and MARKS the
            // reservation (#1656 r3), so the first authentic ACK that
            // later arrives can still reconcile it exactly once.
            if (forced) {
                r.forcedFinalized = true;
            } else {
                _reconcileCompFunded(s, r, amountReceived);
            }
        }
        emit RemitReservationAcked(remitId, dst, total, amountReceived, forced);
    }

    // ─── #1222 M3 B2-d2 — ledger views ────────────────────────────────────

    /**
     * @notice #1222 M3 B2-d2 (Codex #1426 r1) / #918 — batch remit planner:
     *         for each day, the amount a remit with this `partCap` would move
     *         for it AND whether the batch would act on the day at all
     *         (`actionable` — it applies a part: true for days owing value,
     *         whether the part completes them or not, and for gate-passing
     *         armed days whose Σcommitments clamp lands at ZERO, which move no
     *         VPFI but must still close to retire their finalize-time
     *         commitments).
     * @dev    {quoteRewardBudget} alone cannot surface the zero-clamp case —
     *         a zero amount there is indistinguishable from a gated /
     *         already-closed / remit-ineligible day — so a keeper reading only
     *         amounts would never drive the close-only batch. Whether an
     *         actionable day COMPLETES under this cap or stays open owing the
     *         rest is {quoteRemitDayStatuses}' `Closeable` / `Partial`. Mirrors
     *         the send's in-batch de-duplication and skips non-finalized days.
     *         Tolerant for days (no DAY reverts); `partCap` is refused on the
     *         send's own terms, because a plan under an invalid cap is a plan
     *         of a send that cannot happen.
     */
    function quoteRemitDayPlans(
        uint32 dstChainId,
        uint256[] calldata dayIds,
        uint256 partCap
    )
        external
        view
        returns (uint256[] memory amounts, bool[] memory actionable)
    {
        _checkPartCap(partCap);
        // #2232 r16 - the same plan the send applies (see {BatchPlan}).
        BatchPlan memory plan = _planBatch(LibVaipakam.storageSlot(), dstChainId, dayIds, partCap);
        return (plan.perDay, plan.actionable);
    }

    /**
     * @notice #2760 / #918 — why each day of a remittance plan does or does not
     *         move under `partCap`: one {LibRemitDayLedger.RemitDayStatus} per
     *         entry of `dayIds`, aligned to the input.
     * @dev    The same plan the send applies ({_planBatch}), so the statuses
     *         and {quoteRemitDayPlans}' figures for one list and one cap always
     *         agree: a day is `Closeable` or `Partial` exactly when it is
     *         `actionable` there. `Unbacked` depends on the days listed before
     *         it, as the send's backing gate does. Tolerant for days; `partCap`
     *         is refused on the send's terms.
     */
    function quoteRemitDayStatuses(
        uint32 dstChainId,
        uint256[] calldata dayIds,
        uint256 partCap
    ) external view returns (LibRemitDayLedger.RemitDayStatus[] memory statuses) {
        _checkPartCap(partCap);
        return _planBatch(LibVaipakam.storageSlot(), dstChainId, dayIds, partCap).status;
    }

    // ─── Views ────────────────────────────────────────────────────────────

    /**
     * @notice Plan a remittance: the VPFI each of `dayIds` still OWES
     *         `dstChainId`, and their sum. Non-reverting — non-finalized or
     *         already-whole days contribute 0.
     * @dev    CAP-FREE (#918): a day's figure is everything it still owes —
     *         its whole slice less the parts already sent — not what one send
     *         would move under a lane-sized cap; {quoteRemitDayPlans} with a
     *         `partCap` answers that. Mirrors {remitRewardBudget}'s in-call
     *         de-duplication: a `dayId` repeated in `dayIds` contributes only
     *         on its FIRST occurrence.
     *
     *         This is the DISCOVERY view and it stays tolerant on purpose: the
     *         keeper scans a recent window every tick and relies on an
     *         unfinalized, repeated or already-remitted day reading ZERO here,
     *         not reverting. What it does NOT do is claim the send would accept
     *         the whole list: the send funds ONE day per remittance
     *         (`TRANSPORT_DAY_FANOUT_CAP`, #2821), in parts no larger than its
     *         cap, and {quoteRemittanceFee} is the strict dry run that refuses
     *         the same lists the send refuses.
     * @return total  Sum of what the days still owe (each day counted once).
     * @return perDay `perDay[i]` = what `dayIds[i]` still owes (0 if not
     *                finalized, already whole, gated, or a repeat).
     */
    function quoteRewardBudget(
        uint32 dstChainId,
        uint256[] calldata dayIds
    ) external view returns (uint256 total, uint256[] memory perDay) {
        BatchPlan memory plan =
            _planBatch(LibVaipakam.storageSlot(), dstChainId, dayIds, type(uint256).max);
        return (plan.st.totalAll, plan.perDay);
    }

    /**
     * @notice Quote the CCIP native fee a {remitRewardBudget} over `dayIds` with
     *         `partCap` would cost, plus the VPFI total it would send.
     * @dev    The keeper/operator EOA cannot call
     *         `CcipMessenger.quoteMessageFee` directly — the messenger
     *         authorizes quotes by `channelOf[msg.sender]` and only the Diamond
     *         is a registered reward-budget handler. This view runs the quote
     *         AS the Diamond, building the exact same funded-day payload +
     *         token list the send would, for the same part, so `fee` is what to
     *         pass as `msg.value` (overpayment is refunded anyway). The part
     *         size matters: the d7 payload carries the part, and a CCIP token
     *         fee may scale with the amount moved.
     *
     *         It is a faithful DRY-RUN of the send's intrinsic guards: it
     *         reverts `InvalidRemittanceCap` on a cap the send refuses,
     *         `RewardDayNotFinalized` on an unfinalized day and
     *         `RewardPoolCapExceeded` when the fresh the acted days need new
     *         room for would breach the 69M pool (#918: tested on the rest of
     *         the day, not on the part),
     *         exactly like {remitRewardBudget}. Returns (0, 0) when nothing is
     *         remittable, or the messenger/VPFI is unset.
     * @return fee   CCIP native fee for the send (0 if nothing to remit).
     * @return total VPFI the send would move (0 if nothing to remit).
     */
    function quoteRemittanceFee(
        uint32 dstChainId,
        uint256[] calldata dayIds,
        uint256 partCap
    ) external view returns (uint256 fee, uint256 total) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vpfi = s.vpfiToken;
        address messenger = s.crossChainMessenger;
        if (vpfi == address(0) || messenger == address(0)) return (0, 0);
        _checkPartCap(partCap);

        // #2232 r16 root arrest - the STRICT dry run: the same plan the send
        // applies, refused on the same terms and in the same order, so this
        // can never price a batch the send would reject. See {BatchPlan}.
        BatchPlan memory plan = _planBatch(s, dstChainId, dayIds, partCap);
        if (plan.anyUnfinalized) revert RewardDayNotFinalized(plan.firstUnfinalized);
        total = plan.st.totalAll;
        if (total == 0) return (0, 0);
        uint256 remaining = _headroom(s, plan.st.gateArmedFresh);
        if (plan.st.gateFresh > remaining) {
            revert RewardPoolCapExceeded(plan.st.gateFresh, remaining);
        }
        LibRewardCustody.requireRemittableFanout(plan.dl.fundedCount);

        ICrossChainMessenger.TokenAmount[] memory tokens =
            new ICrossChainMessenger.TokenAmount[](1);
        tokens[0] = ICrossChainMessenger.TokenAmount({token: vpfi, amount: total});
        // B2-d2 — price exactly the bytes the send builds; the fee depends on
        // payload length, so the placeholder id (the next nonce the send would
        // draw) keeps the quote exact. 3d-2 — the SAME builder as the send
        // ({_remitPayload}) over the SAME totals, so `quote == send` holds by
        // construction.
        (bytes memory payload, ) =
            _remitPayload(s, dstChainId, plan.dl.fundedDays, plan.st, s.remitReservationNonce + 1);
        // #2561 — the send refuses a remittance with no bound remote adapter,
        // so the dry run refuses it too, by the same rule.
        LibRewardRemitDispatch.boundRemoteMessenger(messenger, dstChainId);
        fee = ICrossChainMessenger(messenger).quoteMessageFee(
            dstChainId,
            payload,
            tokens,
            LibRewardRemitDispatch.REWARD_BUDGET_DEST_GAS_LIMIT
        );
    }
}
