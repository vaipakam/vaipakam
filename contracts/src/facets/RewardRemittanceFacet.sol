// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibVpfiRecycle} from "../libraries/LibVpfiRecycle.sol";
import {LibRewardRemitDispatch} from "../libraries/LibRewardRemitDispatch.sol";
import {LibRewardCustody} from "../libraries/LibRewardCustody.sol";
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
    ///      send path stays under the viaIR stack ceiling). B2-d2: `fresh` /
    ///      `recycled` are the CLAMPED shares actually sent; `armedFresh` is
    ///      the PRE-clamp armed-day fresh (the full finalize-time commitment
    ///      a terminally-closed day retires — remitted + clamp residual);
    ///      `recycledFull` is the pre-clamp recycled likewise.
    struct RemitDayLists {
        uint256[] fundedDays;
        uint256 fundedCount;
        uint256[] closedDays;
        uint256 closedCount;
    }

    struct RemitSplitTotals {
        uint256 totalAll;
        uint256 fresh;
        uint256 recycled;
        uint256 armedFresh;
        uint256 armedFrom;
        uint256 recycledFull;
        // Codex #1426 r2/r6 — running NET recycled-backing gate, applied
        // IDENTICALLY at all four planning sites (send + three quotes). A
        // closed day may fund only when the POST-close invariant holds:
        // `bucket' >= outstanding'`, i.e.
        // `bucketLeft + recycledFull_day >= outRecycledLeft + clamped_day`
        // (the close retires the day's FULL commitment while sending only
        // the clamped share). Comparing against the gross bucket (r2's
        // first cut) let an operator-released reservation's stranded hole
        // migrate onto innocent later days: release keeps the bucket
        // custody-true but RESTORES the full outstanding commitment, so
        // outstanding deliberately exceeds backing by the stranded amount —
        // the net gate makes every recycled remit wait until the B2-d5
        // recovery ceremony heals that hole, and is a structural no-op on
        // the healthy path (finalize reserves commitments ⊆ fundable =
        // bucket − outstanding).
        uint256 bucketLeft;
        uint256 outRecycledLeft;
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

    /// @dev #1222 M3 B2-d2 — one day's remit plan, produced by {_planDay}:
    ///      the SINGLE eligibility + gate + clamp computation all three remit
    ///      sites (send + both quotes) consume, so `quote == send` holds
    ///      structurally. `close` marks a day this batch terminally closes
    ///      (all filters passed, slice non-zero pre-clamp) — including an
    ///      armed day whose Σcommitments clamp lands at ZERO, whose
    ///      commitments must still retire exactly once.
    struct DayRemitPlan {
        bool close;
        uint256 fresh;
        uint256 recycled;
        uint256 armedFreshFull;
        uint256 recycledFull;
    }

    using SafeERC20 for IERC20;

    /// @notice Gas allotted to the mirror {RewardRemittanceReceiver} callback.
    ///         Matched to the buyback remittance receiver's budget.
    uint256 internal constant REWARD_BUDGET_DEST_GAS_LIMIT = 300_000;

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
    /// @param total      VPFI remitted in this batch (sum of un-remitted slices).
    /// @param fundedDayCount Number of days that ACTUALLY funded VPFI in this
    ///                   batch (skipped/duplicate/zero-slice days excluded) —
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
    /// @notice #1566 transport epochs PR 3a — a reservation's recorded split
    ///         was dispatched toward the mirror it was sent to.
    /// @custom:event-category informational/reward-transport
    event RemitSplitAttestationDispatched(
        uint256 indexed remitId, bytes32 indexed messageId, uint32 dstChainId, uint256 fresh, uint256 recycled
    );
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
    /// @notice `perRemittanceCap` is zero or above the whole interaction pool.
    error InvalidRemittanceCap();
    /// @notice The batch total exceeds the caller-supplied per-call cap.
    error RemittanceExceedsCap(uint256 total, uint256 cap);
    /// @notice The batch would push remitted + Base-paid over the 69M pool cap.
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
     *         mirror `dstChainId` over the CCIP token path.
     * @dev    Idempotent: a `(dstChainId, dayId)` already remitted is skipped
     *         (not re-sent), so re-running a partially-sent batch is safe.
     *         CEI order: mark + accounting BEFORE the external send; if the
     *         send reverts the whole tx (and the marks) roll back. Forwards
     *         exactly the quoted CCIP native fee and refunds any surplus
     *         `msg.value` to the caller.
     * @param dstChainId      Mirror to fund.
     * @param dayIds          Finalized days to remit (any already-sent are
     *                        skipped; every day must be finalized).
     * @param perRemittanceCap Caller-set ceiling on this batch's total, so the
     *                        operator/keeper keeps a single send under the live
     *                        VPFI CCIP lane bucket. Must be in (0, 69M].
     * @return messageId      CCIP message id.
     */
    function remitRewardBudget(
        uint32 dstChainId,
        uint256[] calldata dayIds,
        uint256 perRemittanceCap
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
        if (
            perRemittanceCap == 0 ||
            perRemittanceCap > LibVaipakam.VPFI_INTERACTION_POOL_CAP
        ) {
            revert InvalidRemittanceCap();
        }

        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert VPFITokenNotSet();
        address messenger = s.crossChainMessenger;
        if (messenger == address(0)) revert RewardBudgetMessengerNotSet();

        // Walk the requested days through the SHARED plan helper ({_planDay} —
        // the same eligibility + B2-d2 commitment gate + Σcommitments clamp
        // both quote views consume, so quote == send structurally). Every day
        // must be finalized (its denominator is immutable). Collect ONLY the
        // days that actually contribute VPFI into `dl.fundedDays` (skipping
        // skipped/duplicate/zero days) — that filtered set, not the caller's
        // raw `dayIds`, rides the payload so the mirror's reconciliation
        // events name exactly the funded days. `dl.closedDays` additionally
        // collects every day this batch terminally closes (funded + armed
        // clamped-to-zero) — the reservation records those for release.
        // (One memory struct for the four day-list locals — the w4 split
        // moved this function's compilation shape and four stack slots
        // became one; same lever as {RemitSplitTotals} below.)
        RemitDayLists memory dl = RemitDayLists({
            fundedDays: new uint256[](dayIds.length),
            fundedCount: 0,
            closedDays: new uint256[](dayIds.length),
            closedCount: 0
        });
        // B2-d2 — reserve the delivered-backing id up front: the day-close
        // markers written in the loop reference it, and the reservation
        // itself is written BEFORE the external send (CEI).
        uint256 remitId = ++s.remitReservationNonce;
        // PR-3c (#1217) — track the funding-source decomposition: the FRESH
        // share reserves against the 69M cap; the RECYCLED share debits the
        // bucket at remit (governor §3.2 — the tokens leave Base custody
        // here); armed-day fresh retires its finalize-time commitment.
        // (Memory struct: keeps the viaIR stack under the ceiling.)
        RemitSplitTotals memory st;
        st.armedFrom = s.governorCommitArmedFromDay;
        st.bucketLeft = s.recycleBucket;
        st.outRecycledLeft = s.outstandingCommitRecycled;
        for (uint256 i; i < dayIds.length; ) {
            uint256 dayId = dayIds[i];
            if (!s.dailyGlobalFinalized[dayId]) {
                revert RewardDayNotFinalized(dayId);
            }
            DayRemitPlan memory p = _planDay(s, dstChainId, dayId, st.armedFrom);
            // r2/r6 net backing gate (see {RemitSplitTotals.bucketLeft}).
            if (
                p.close
                    && st.bucketLeft + p.recycledFull
                        >= st.outRecycledLeft + p.recycled
            ) {
                st.bucketLeft -= p.recycled;
                st.outRecycledLeft = st.outRecycledLeft > p.recycledFull
                    ? st.outRecycledLeft - p.recycledFull
                    : 0;
                // Terminal close: a duplicate of this day later in the batch
                // re-enters {_planDay} and finds the marker, so each day
                // closes at most once.
                s.dayClosedByRemitId[dstChainId][dayId] = remitId;
                dl.closedDays[dl.closedCount] = dayId;
                unchecked {
                    ++dl.closedCount;
                }
                uint256 slice = p.fresh + p.recycled;
                if (slice > 0) {
                    s.rewardBudgetRemitted[dstChainId][dayId] = slice;
                    st.totalAll += slice;
                    st.fresh += p.fresh;
                    st.recycled += p.recycled;
                    dl.fundedDays[dl.fundedCount] = dayId;
                    unchecked {
                        ++dl.fundedCount;
                    }
                }
                st.armedFresh += p.armedFreshFull;
                st.recycledFull += p.recycledFull;
                // B2-d2 — the Σcommitments clamp residual will never be paid
                // on the mirror (the reported liability is the supremum of
                // its eventual capped claims), so the closed day releases the
                // residual RECYCLED commitment here — otherwise
                // `outstandingCommitRecycled` leaks it forever and `fundable`
                // under-states availability. The fresh residual retires via
                // `consumeArmedFresh(st.armedFresh)` below (full pre-clamp).
                uint256 residualRecycled = p.recycledFull - p.recycled;
                if (residualRecycled > 0) {
                    LibVpfiRecycle.releaseCommitment(
                        LibVpfiRecycle.RecycleSource.RemitClampResidual,
                        dayId,
                        residualRecycled
                    );
                }
            }
            unchecked {
                ++i;
            }
        }
        if (dl.closedCount == 0) revert NothingToRemit();
        // Trim the collection arrays to their filled lengths (shrink the
        // memory arrays' lengths in place — safe, we only ever reduce them;
        // the annotation keeps solc's memoryguard active so viaIR can spill
        // this function's locals).
        {
            uint256[] memory fundedDays_ = dl.fundedDays;
            uint256 fundedCount_ = dl.fundedCount;
            uint256[] memory closedDays_ = dl.closedDays;
            uint256 closedCount_ = dl.closedCount;
            assembly ("memory-safe") {
                mstore(fundedDays_, fundedCount_)
                mstore(closedDays_, closedCount_)
            }
        }
        if (st.totalAll > perRemittanceCap) {
            revert RemittanceExceedsCap(st.totalAll, perRemittanceCap);
        }

        // Global 69M-cap guard: everything remitted so far, plus what Base has
        // itself paid out locally, plus this batch's FRESH share, must stay
        // within the pool. PR-3c — the recycled share is bucket-backed (its
        // finalize-time commitment already reserved it against `fundable`)
        // and never consumes the fresh cap: at fresh exhaustion recycled
        // remittances keep flowing, the promised steady state.
        uint256 remaining = _headroom(s, st.armedFresh);
        if (st.fresh > remaining) {
            revert RewardPoolCapExceeded(st.fresh, remaining);
        }

        // Effects (CEI) — before the external send. `rewardBudgetRemittedGlobal`
        // stays the FRESH-only reservation counter (the availability terms in
        // the governor stamp and the claim cap both read it that way);
        // `rewardBudgetRemittedTotal` keeps the full funding record. B2-d2:
        // `armedFresh` is the PRE-clamp armed fresh — a terminally-closed
        // day's full finalize-time fresh commitment retires here (the clamp
        // residual is dead the moment the day closes).
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
        // send (CEI). A close-only batch (every covered day clamped to zero)
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
            r.dayIds = dl.closedDays;
            // #1566 transport epochs PR 3a — every payload this deployment
            // builds is the d5 shape, which carries the split, so the mirror
            // types this packet at ingress and a split attestation for it can
            // never land. Recorded on the row so the canonical side refuses
            // one before a fee is paid.
            LibRewardCustody.markReservationSplitOnWire(r);
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

        messageId = _sendRemitPayload(
            s,
            vpfi,
            messenger,
            dstChainId,
            dl.fundedDays,
            // B2-d5 — `recycledShare` is this batch's RECYCLED component. The
            // mirror cannot re-derive it (`p.recycled` is computed after
            // Base's Σcommitments clamp, which is Base-global state), so it
            // rides the payload and drives the arrival custody credit.
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
        uint256[] memory fundedDays,
        RemitDispatch memory d
    ) private returns (bytes32 messageId) {
        uint256 total = d.total;

        // r4 — the payload carries THIS deployment's identity (immutable
        // message data): receipts key by (remitter, remitId) and the ack
        // echoes it, so a rotated deployment's same-numbered remit can
        // never be confused with this one.
        //
        // B2-d5 appends `recycledShare` — the RECYCLED component of `total` —
        // and LEADS with {RemitWire.REMIT_WIRE_TAG_D5} rather than extending
        // the head-offset ladder to 0xA0. That is a rollout-safety choice, not
        // a cosmetic one: 0xA0 is a valid in-bounds array offset, so a
        // not-yet-upgraded mirror would decode the new payload as the LEGACY
        // 2-tuple and silently drop `remitId`/`remitter`/`recycledShare`,
        // stranding this reservation Pending with no custody credit — during
        // exactly the window where Base is refreshed before the mirrors. The
        // keccak-derived tag is far larger than any payload length, so an old
        // decoder's bounds check fails and the delivery REVERTS instead;
        // CCIP re-executes it once that mirror is upgraded. See {RemitWire}.
        bytes memory payload = abi.encode(
            RemitWire.REMIT_WIRE_TAG_D5,
            fundedDays,
            total,
            d.remitId,
            address(this),
            d.recycledShare
        );
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



    /**
     * @dev #1222 M3 B2-d2 — the SINGLE per-day eligibility + gate + clamp
     *      computation behind all three remit sites. Zeros (no close) when
     *      the day is already funded/closed, remit-ineligible, gated (armed
     *      day whose commitment report is not `.complete` — §M3's "delays,
     *      never zeroes"), or has a zero pre-clamp slice. On an armed
     *      gate-passing day the Σcommitments clamp bounds the slice by the
     *      reported per-side liability total — safe because the per-entry
     *      report is the SUPREMUM of the mirror's eventual capped claims
     *      (design record §2c: it can never under-state, so clamping to it
     *      can never brick a claim) — apportioned pro-rata across the
     *      fresh/recycled sources (floor on fresh; the PR-3c combined-cap
     *      convention). Pre-cutover days pass through unclamped (no
     *      commitment regime exists for them).
     */
    function _planDay(
        LibVaipakam.Storage storage s,
        uint32 dstChainId,
        uint256 dayId,
        uint256 armedFrom
    ) private view returns (DayRemitPlan memory p) {
        if (s.rewardBudgetRemitted[dstChainId][dayId] != 0) return p;
        if (s.dayClosedByRemitId[dstChainId][dayId] != 0) return p;
        LibVaipakam.ChainDayCommitments storage c =
            s.chainDayCommitments[dayId][dstChainId];
        // #1222 M3 B2-c — never remit a (chain, day) a force-finalize marked
        // remit-ineligible-pending-reconciliation: its ShareOfPool budget was
        // sized without the chain's real demand. The funding vehicle is the
        // manual-budget path ({remitManualBudget}), never this slice.
        if (c.remitIneligible) return p;
        bool armed = armedFrom != 0 && dayId >= armedFrom;
        if (armed && !c.complete) return p;
        LibInteractionRewards.ChainDayBudget memory b = LibInteractionRewards
            .chainRewardBudgetSideSplitForDay(s, dstChainId, dayId);
        uint256 grossRecycled = b.recycledLender + b.recycledBorrower;
        uint256 localBacking =
            s.chainDayRecycledFunding[dayId][dstChainId].recycleConsume;
        if (localBacking > grossRecycled) localBacking = grossRecycled;
        uint256 sliceFresh = b.freshLender + b.freshBorrower;
        uint256 sliceRecycled = grossRecycled - localBacking;
        if (sliceFresh + sliceRecycled == 0 && localBacking == 0) return p;
        p.close = true;
        if (armed) {
            p.armedFreshFull = sliceFresh;
            p.recycledFull = sliceRecycled;
            // #1222 M3 B2-d3 (Codex #1430 r1→r2→r3) — the clamp is applied
            // PER SIDE, because all three of these differ by side and
            // collapsing them first misprices the legs:
            //   * the mirror reports `liabilityLender18` / `liabilityBorrower18`
            //     separately, and the liability can concentrate on one side;
            //   * the two sides carry genuinely different fresh:recycled
            //     compositions (the reason B2-b introduced per-side halves);
            //   * local RECYCLED backing can only cover a recycled leg — Base
            //     funds all fresh — so it must net against that side's
            //     recycled leg alone.
            // The local backing is ONE fungible pool of recycled tokens on
            // the mirror — it is NOT earmarked per side — so only the LEG
            // SPLIT is per-side; the netting is aggregate. (Apportioning the
            // backing per side too would strand it: a day whose liability
            // lands entirely on one side would only be allowed to use that
            // side's notional share, and Base would over-remit the rest.)
            (uint256 freshLegL, uint256 recycledLegL) = _sideLegs(
                b.freshLender, b.recycledLender, c.liabilityLender18
            );
            (uint256 freshLegB, uint256 recycledLegB) = _sideLegs(
                b.freshBorrower, b.recycledBorrower, c.liabilityBorrower18
            );
            uint256 recycledLegs = recycledLegL + recycledLegB;
            p.fresh = freshLegL + freshLegB;
            p.recycled = recycledLegs > localBacking
                ? recycledLegs - localBacking
                : 0;
        } else {
            p.fresh = sliceFresh;
            p.recycled = sliceRecycled;
        }
    }

    /**
     * @dev #1222 M3 B2-d3 (Codex #1430 r3) — split ONE reward side's claim
     *      exposure into its fresh and recycled LEGS, using that side's OWN
     *      pool composition and its OWN reported liability.
     *
     *      The mirror's claim path splits every payout pro-rata over the
     *      side's fresh:recycled composition, and the two sides genuinely
     *      differ (that is why B2-b introduced per-side halves), so a
     *      liability concentrated on one side must be priced against that
     *      side — blending them first misprices whichever leg it lands on.
     *      Netting the chain's local backing is deliberately NOT done here:
     *      that backing is one fungible pool across both sides, so the
     *      caller nets it against the SUMMED recycled legs.
     * @param sideFresh    This side's Base-funded fresh budget.
     * @param sideRecycled This side's GROSS recycled budget (local included).
     * @param liability    This side's reported claimable liability.
     */
    function _sideLegs(
        uint256 sideFresh,
        uint256 sideRecycled,
        uint256 liability
    ) private pure returns (uint256 freshLeg, uint256 recycledLeg) {
        uint256 gross = sideFresh + sideRecycled;
        if (gross == 0) return (0, 0);
        if (liability >= gross) return (sideFresh, sideRecycled);
        // Codex #1430 r4 — use the CLAIM PATH's rounding convention:
        // `_splitDayAmount` floors the RECYCLED share and gives fresh the
        // remainder (and `_attributeLegs` repeats that per entry). Flooring
        // fresh here instead would round the recycled leg UP, over-net it
        // against the local backing, and under-remit the fresh leg — leaving
        // fresh claims short by up to a wei per entry, which is the unsafe
        // direction.
        recycledLeg = (liability * sideRecycled) / gross;
        freshLeg = liability - recycledLeg;
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
     *         {RewardRemittanceReceiver} authorized to call
     *         {onRewardBudgetReceived} on this (mirror) Diamond.
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

    // ─── Mirror-side ingress ──────────────────────────────────────────────


    // ─── #1566 transport epochs PR 3a — the split attestation (send) ────────

    /**
     * @notice Dispatch the SPLIT ATTESTATION for `remitId` toward the mirror
     *         it was sent to: this reservation's recorded `fresh` and
     *         `recycled` figures, which are the evidence a d2 packet's fresh
     *         side needs before it can ever be classified fresh (§5c).
     * @dev    Canonical-only, permissionless and deliberately RE-SENDABLE: the
     *         content is this Diamond's own record (a caller can neither forge
     *         nor inflate it), the mirror accepts exactly one, and the caller
     *         pays the transport fee — so a repeat send is a fee-payer's retry
     *         lever for a lost message, not a grief. Quote first via
     *         {RewardRemittanceLensFacet.quoteSplitAttestationFee}; the
     *         messenger refunds any surplus to `refundAddress`. Refused here,
     *         before any fee is paid, for a reservation the destination could
     *         only reject: one whose own wire carried the split, and one that
     *         moved no value and so wrote no receipt
     *         ({LibRewardCustody.requireAttestable}, which holds EVERY
     *         precondition — the canonical role, the messenger, and the
     *         reservation rules — and is the same call the fee quote makes,
     *         so a quote can never price what a send would refuse).
     */
    function attestRemitSplit(
        uint256 remitId,
        address payable refundAddress
    )
        external
        payable
        nonReentrant
        whenNotPaused
        returns (bytes32 messageId)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        (address messenger, LibVaipakam.RemitReservation storage r) =
            LibRewardCustody.requireAttestable(s, remitId);
        messageId = IRewardMessenger(messenger).sendSplitAttestation{value: msg.value}(
            r.dstChainId, address(this), remitId, r.fresh, r.recycled, refundAddress
        );
        emit RemitSplitAttestationDispatched(remitId, messageId, r.dstChainId, r.fresh, r.recycled);
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
        // value 0 is deliberately unassigned so the widened word is
        // unambiguous against a generation-1 bool ack in flight - a
        // legacy consumed ack (bool true = 1) decodes as CONSUMED with
        // identical semantics, and a legacy non-consumed ack (bool
        // false = 0) decodes as INVALID and stays re-executable until
        // anyone re-presents it under the current encoding.
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
        // #1660 r6 - the wire offsets classification by one (0 is the
        // RETIRED generation-1 bool-false shape): 1 consumed /
        // 2 quarantined / 3 provisional. Zero or out-of-range fails
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
        // #1662 r8 — the attribution watermark gates the CLAW as well as
        // the draw. A legacy receipt's spends were tracked GLOBALLY only,
        // so its per-receipt counters read zero and it would present its
        // whole (already-spent) legacy credit as unspent — moving a LATER
        // receipt's backing into the overage quarantine the moment that
        // receipt replenished the pool. Round 7 guarded only
        // `_drawFromRecovery`, which left this path open.
        if (
            s.recoveryAttributionArmed
                && receiptId <= s.recoveryAttributionArmedAt
        ) {
            return (0, 0);
        }
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
     * @notice #1222 M3 B2-d2 (Codex #1426 r1) — batch remit planner: for
     *         each day, the amount a remit would move AND whether the day is
     *         actionable at all (`closeable` — it would terminally close in
     *         a batch: true for fundable days and for gate-passing armed
     *         days whose Σcommitments clamp lands at ZERO, which move no
     *         VPFI but must still close to retire their finalize-time
     *         commitments).
     * @dev    {quoteRewardBudget} alone cannot surface the zero-clamp case —
     *         a zero amount there is indistinguishable from a gated /
     *         already-closed / remit-ineligible day — so a keeper reading
     *         only amounts would never drive the close-only batch and such a
     *         day's commitments would stay outstanding forever. Mirrors the
     *         send's in-batch de-duplication (a repeated day contributes
     *         only on first occurrence) and skips non-finalized days.
     */
    function quoteRemitDayPlans(
        uint32 dstChainId,
        uint256[] calldata dayIds
    )
        external
        view
        returns (uint256[] memory amounts, bool[] memory closeable)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        amounts = new uint256[](dayIds.length);
        closeable = new bool[](dayIds.length);
        uint256 armedFrom = s.governorCommitArmedFromDay;
        // r2/r6 net backing gate — identical to the send: an under-backed
        // day reads NOT actionable (it waits for the recovery ceremony).
        uint256 bucketLeft = s.recycleBucket;
        uint256 outRecycledLeft = s.outstandingCommitRecycled;
        for (uint256 i; i < dayIds.length; ) {
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
            if (!seen && s.dailyGlobalFinalized[dayId]) {
                DayRemitPlan memory p =
                    _planDay(s, dstChainId, dayId, armedFrom);
                if (
                    p.close
                        && bucketLeft + p.recycledFull
                            >= outRecycledLeft + p.recycled
                ) {
                    bucketLeft -= p.recycled;
                    outRecycledLeft = outRecycledLeft > p.recycledFull
                        ? outRecycledLeft - p.recycledFull
                        : 0;
                    amounts[i] = p.fresh + p.recycled;
                    closeable[i] = true;
                }
            }
            unchecked {
                ++i;
            }
        }
    }










    // ─── Views ────────────────────────────────────────────────────────────

    /**
     * @notice Plan a remittance: the un-remitted VPFI a {remitRewardBudget}
     *         call over `dayIds` would send to `dstChainId`, and the per-day
     *         breakdown. Non-reverting — non-finalized or already-remitted days
     *         contribute 0.
     * @dev    Mirrors {remitRewardBudget}'s in-call de-duplication: a `dayId`
     *         repeated in `dayIds` contributes only on its FIRST occurrence
     *         (later duplicates yield 0). Without this the quote would
     *         over-count a duplicated day — remit marks it on the first pass, so
     *         the send would fit under a cap the quote reported as too large.
     * @return total  Sum of the un-remitted slices (each day counted once).
     * @return perDay `perDay[i]` = amount `dayIds[i]` would contribute (0 if
     *                not finalized, already remitted, or a repeat of an earlier
     *                entry in `dayIds`).
     */
    function quoteRewardBudget(
        uint32 dstChainId,
        uint256[] calldata dayIds
    ) external view returns (uint256 total, uint256[] memory perDay) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        perDay = new uint256[](dayIds.length);
        // r2/r6 net backing gate — identical to the send (see
        // {RemitSplitTotals.bucketLeft}).
        uint256 bucketLeft = s.recycleBucket;
        uint256 outRecycledLeft = s.outstandingCommitRecycled;
        for (uint256 i; i < dayIds.length; ) {
            uint256 dayId = dayIds[i];
            // Skip a day already seen earlier in THIS call — the send path
            // marks the first occurrence and no-ops the rest.
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
            if (!seen && s.dailyGlobalFinalized[dayId]) {
                // B2-d2 — the shared {_planDay} carries every send-path
                // filter (already-funded/closed, remit-ineligible, the armed
                // commitment gate) plus the Σcommitments clamp, so this
                // quote's per-day figure is exactly what the send would move.
                DayRemitPlan memory p = _planDay(
                    s, dstChainId, dayId, s.governorCommitArmedFromDay
                );
                uint256 slice;
                if (
                    p.close
                        && bucketLeft + p.recycledFull
                            >= outRecycledLeft + p.recycled
                ) {
                    bucketLeft -= p.recycled;
                    outRecycledLeft = outRecycledLeft > p.recycledFull
                        ? outRecycledLeft - p.recycledFull
                        : 0;
                    slice = p.fresh + p.recycled;
                }
                perDay[i] = slice;
                total += slice;
            }
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Quote the CCIP native fee a {remitRewardBudget} over `dayIds`
     *         would cost, plus the VPFI total it would send.
     * @dev    The keeper/operator EOA cannot call
     *         `CcipMessenger.quoteMessageFee` directly — the messenger
     *         authorizes quotes by `channelOf[msg.sender]` and only the Diamond
     *         is a registered reward-budget handler. This view runs the quote
     *         AS the Diamond, building the exact same funded-day payload +
     *         token list the send would (same not-already-remitted /
     *         non-duplicate / non-zero-slice filter), so `fee` is what to pass
     *         as `msg.value` (overpayment is refunded anyway).
     *
     *         It is a faithful DRY-RUN of the send's intrinsic guards: it
     *         reverts `RewardDayNotFinalized` on an unfinalized day and
     *         `RewardPoolCapExceeded` when the batch would breach the 69M pool,
     *         exactly like {remitRewardBudget} — so a keeper that gets a
     *         successful quote knows the same send won't be rejected by those
     *         guards (the caller-supplied `perRemittanceCap` is the keeper's own
     *         concern, sized from the returned `total`). Returns (0, 0) when
     *         nothing is remittable, or the messenger/VPFI is unset.
     * @return fee   CCIP native fee for the send (0 if nothing to remit).
     * @return total VPFI the send would move (0 if nothing to remit).
     */
    function quoteRemittanceFee(
        uint32 dstChainId,
        uint256[] calldata dayIds
    ) external view returns (uint256 fee, uint256 total) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vpfi = s.vpfiToken;
        address messenger = s.crossChainMessenger;
        if (vpfi == address(0) || messenger == address(0)) return (0, 0);

        uint256[] memory fundedDays = new uint256[](dayIds.length);
        uint256 fundedCount;
        uint256 totalFresh; // PR-3c — fresh share for the cap guard below.
        uint256 totalArmedFresh; // r6 — commitments this batch would retire.
        // r2/r6 net backing gate — identical to the send.
        uint256 bucketLeft = s.recycleBucket;
        uint256 outRecycledLeft = s.outstandingCommitRecycled;
        for (uint256 i; i < dayIds.length; ) {
            uint256 dayId = dayIds[i];
            // Mirror remit's revert on any unfinalized day so this quote never
            // reports a valid fee for a batch remit would reject.
            if (!s.dailyGlobalFinalized[dayId]) {
                revert RewardDayNotFinalized(dayId);
            }
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
            if (!seen) {
                // B2-d2 — shared plan (filters + gate + clamp), so the quoted
                // fee prices the EXACT payload + token amount the send builds.
                DayRemitPlan memory p = _planDay(
                    s, dstChainId, dayId, s.governorCommitArmedFromDay
                );
                // r2 backing filter — identical to the send.
                uint256 slice;
                if (
                    p.close
                        && bucketLeft + p.recycledFull
                            >= outRecycledLeft + p.recycled
                ) {
                    bucketLeft -= p.recycled;
                    outRecycledLeft = outRecycledLeft > p.recycledFull
                        ? outRecycledLeft - p.recycledFull
                        : 0;
                    slice = p.fresh + p.recycled;
                    // r6 — this day would terminally close in the send,
                    // retiring its full armed-fresh commitment.
                    totalArmedFresh += p.armedFreshFull;
                }
                if (slice > 0) {
                    fundedDays[fundedCount] = dayId;
                    unchecked {
                        ++fundedCount;
                    }
                    total += slice;
                    totalFresh += p.fresh;
                }
            }
            unchecked {
                ++i;
            }
        }
        if (total == 0) return (0, 0);
        // Mirror remit's 69M pool-cap guard so a quote can't succeed for a batch
        // remit would reject near pool exhaustion. PR-3c — fresh share only,
        // mirroring the send path.
        uint256 remaining = _headroom(s, totalArmedFresh);
        if (totalFresh > remaining) {
            revert RewardPoolCapExceeded(totalFresh, remaining);
        }
        assembly ("memory-safe") {
            mstore(fundedDays, fundedCount)
        }

        ICrossChainMessenger.TokenAmount[] memory tokens =
            new ICrossChainMessenger.TokenAmount[](1);
        tokens[0] = ICrossChainMessenger.TokenAmount({token: vpfi, amount: total});
        fee = ICrossChainMessenger(messenger).quoteMessageFee(
            dstChainId,
            // B2-d2 — price the WIDENED tuple the send builds; the fee
            // depends on payload length, so the placeholder id (the next
            // nonce the send would draw) keeps the quote exact. B2-d5 adds
            // the wire tag and the recycled share, matching
            // {_sendRemitPayload} exactly so `quote == send` still holds.
            // `total − totalFresh` IS that share: every funded day contributes
            // `slice = p.fresh + p.recycled` to `total` and `p.fresh` to
            // `totalFresh`.
            abi.encode(
                RemitWire.REMIT_WIRE_TAG_D5,
                fundedDays,
                total,
                s.remitReservationNonce + 1,
                address(this),
                total - totalFresh
            ),
            tokens,
            REWARD_BUDGET_DEST_GAS_LIMIT
        );
    }







}
