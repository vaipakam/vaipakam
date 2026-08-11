// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibVpfiRecycle} from "../libraries/LibVpfiRecycle.sol";
import {LibRewardRemitDispatch} from "../libraries/LibRewardRemitDispatch.sol";
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
 * @dev    Base-only (`onlyCanonical`): the 69M interaction pool lives on the
 *         canonical chain, so only Base holds the VPFI to remit. Authorized to
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

    /// @notice #1222 M3 B2-d2 — an ADMIN released a reservation the operator
    ///         verified can never execute: its days re-opened for funding and
    ///         the outstanding commitments were restored. The VALUE counters
    ///         stay reserved (r4): the sent VPFI — fresh and recycled alike —
    ///         sits locked in the CCIP token pool outside Diamond custody, so
    ///         neither the 69M headroom nor the bucket is re-credited (a
    ///         re-remit consumes NEW headroom/backing; physical recovery
    ///         restores both through the B2-d5 governance ceremony).
    ///         `recycledStranded` is the stranded recycled share.
    /// @custom:event-category informational/reward-transport
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

    /// @notice Emitted (mirror side) when a reward budget is received + credited.
    /// @param sourceChainId Base chain id the budget came from.
    /// @param token         Local VPFI token credited.
    /// @param amount        VPFI credited to this Diamond.
    /// @param dayIds        The exact day ids the batch funded — the mirror
    ///                      keeps only `rewardBudgetReceivedTotal`, so this is
    ///                      the sole per-day reconciliation record (the design
    ///                      dropped a per-day map in favour of this event).
    /// @param remitId       B2-d2 delivered-backing reservation id this
    ///                      delivery fulfils (0 = legacy pre-d2 message — no
    ///                      receipt record, no ack).
    /// @param recycledShare #1434 P1-a — the delivery's declared RECYCLED
    ///                      component, post-scaling.
    /// @param freshShare    #1434 P1-a — its declared FRESH component,
    ///                      post-scaling. Zero on a wire generation that
    ///                      carried no split, which is NOT the same as
    ///                      "nothing was fresh".
    /// @dev    The two shares are the RAW INPUTS to the delivered-fresh
    ///         attribution, deliberately not its outcome. Whether a delivery
    ///         was counted is a function of these plus `dayIds` and the
    ///         chain's `D*`, all of which a reader already has — so emitting
    ///         the verdict as well would be a second source of the same
    ///         truth, free to drift from the counters. What a reader could
    ///         NOT previously reconstruct is `freshShare`: it depends on the
    ///         wire generation, which never reaches this Diamond. Without it,
    ///         a refused delivery is indistinguishable from a delivery that
    ///         genuinely carried no fresh funding.
    /// @custom:event-category informational/reward-transport
    event RewardBudgetReceived(
        uint256 indexed sourceChainId,
        address indexed token,
        uint256 amount,
        uint256[] dayIds,
        uint256 remitId,
        uint256 recycledShare,
        uint256 freshShare
    );

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
    /// @notice `onRewardBudgetReceived` called by an address other than the
    ///         configured mirror-side receiver.
    error NotRewardRemittanceReceiver(address caller);
    /// @notice The credited token is not this Diamond's VPFI token.
    error RewardBudgetTokenMismatch(address expected, address delivered);
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
        uint256 total,
        uint256 remitId
    ) private returns (bytes32) {
        return LibRewardRemitDispatch.dispatchRemitTail(
            s, vpfi, messenger, dstChainId, payload, total, remitId
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
            LibVpfiRecycle.consume(st.recycled);
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
        messageId =
            _tail(s, vpfi, messenger, dstChainId, payload, total, d.remitId);
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

    /**
     * @notice Record a reward budget the {RewardRemittanceReceiver} has already
     *         forwarded (as VPFI) into this mirror Diamond.
     * @dev    Monitoring-only: the VPFI is already in the Diamond's balance
     *         (the receiver transferred it before this call), and
     *         `claimInteractionRewards` pays from that balance. This just
     *         records the funded total + emits an event for reconciliation.
     *         Trust chain: gated to the registered receiver, whose own
     *         `onCrossChainMessage` is gated to the CCIP messenger.
     * @param token         Token credited — must be this Diamond's VPFI.
     * @param amount        VPFI amount credited.
     * @param dayIds        Days the batch covered (for the event log).
     * @param sourceChainId Base chain id the budget came from.
     * @param remitId       #1222 M3 B2-d2 — the Base-side delivered-backing
     *                      reservation id this delivery fulfils (0 for a
     *                      legacy pre-d2 message: no receipt record is
     *                      written and no ack ever flows — Base holds no
     *                      reservation for those). First delivery wins the
     *                      receipt slot; the ack content is later computed
     *                      from this record, never caller-supplied.
     * @param recycledShare RECYCLED component of `amount`, already scaled to
     *                      what physically landed. Zero on a legacy/d2
     *                      payload, whose wire never carried the split.
     * @param freshShare    #1434 P1-a — FRESH component of `amount`, likewise
     *                      pre-scaled. The receiver derives it from the WIRE
     *                      GENERATION it decoded and passes ZERO whenever the
     *                      composition was not transmitted, so this ingress
     *                      never has to infer a split from a payload that
     *                      does not carry one. `freshShare + recycledShare`
     *                      may be LESS than `amount` (both are floored) and
     *                      may never exceed it.
     */
    function onRewardBudgetReceived(
        address token,
        uint256 amount,
        uint256[] calldata dayIds,
        uint256 sourceChainId,
        uint256 remitId,
        address remitter,
        uint256 recycledShare,
        uint256 freshShare
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.rewardRemittanceReceiver) {
            revert NotRewardRemittanceReceiver(msg.sender);
        }
        if (token != s.vpfiToken) {
            revert RewardBudgetTokenMismatch(s.vpfiToken, token);
        }
        // Both component bounds are enforced BEFORE either is used. The
        // recycled bound was always here (it gates the custody credit
        // below); the fresh bound is its twin, and checking it against the
        // recycled REMAINDER rather than against `amount` is what makes the
        // pair jointly sound — two individually-valid shares can still sum
        // past the delivery.
        if (recycledShare > amount) {
            revert RecycledShareExceedsDelivery(recycledShare, amount);
        }
        uint256 freshLooking = amount - recycledShare;
        if (freshShare > freshLooking) {
            revert FreshShareExceedsDelivery(freshShare, freshLooking);
        }
        s.rewardBudgetReceivedTotal += amount;
        // #1434 P1-a — record the ARMED-ATTRIBUTABLE fresh component.
        //
        // Two independent tests, and a delivery must pass BOTH:
        //
        //   1. COMPOSITION KNOWN — decided by the receiver, which is the only
        //      party that saw the wire generation. A legacy/d2 payload never
        //      carried the fresh/recycled split, so the receiver sends
        //      `freshShare = 0` and the delivery contributes nothing. The
        //      earlier shape of this code inferred `amount - recycledShare`
        //      here, which recorded such a delivery as ENTIRELY fresh even
        //      where the original remit was partly recycled — over-stating
        //      exactly on the deliveries whose composition is unknown
        //      (Codex #1556 r1 P1).
        //   2. ARMED-ATTRIBUTABLE — every day this delivery covers is at or
        //      after this chain's `D*`. A pre-arming delivery funds legacy
        //      schedule days, which the delivered-fresh bound does not
        //      govern; counting it would hand the chain headroom for payouts
        //      that bound never owed.
        //
        // Whatever is not counted is recorded, not discarded — see
        // `rewardBudgetFreshUncounted`. The two always sum to `freshLooking`,
        // so an operator can reconcile a chain's counted funding against what
        // Base actually sent without re-deriving anything.
        uint256 counted =
            _armedAttributableDelivery(s, dayIds) ? freshShare : 0;
        if (counted != 0) s.rewardBudgetArmedFreshReceived += counted;
        if (freshLooking > counted) {
            s.rewardBudgetFreshUncounted += freshLooking - counted;
        }
        // #1222 M3 B2-d5 — the RECYCLED component of this delivery is
        // RELOCATED CUSTODY: the tokens are physically here and the claim
        // path will debit the bucket for the WHOLE recycled payout
        // (`RewardClaimFacet` → `consume(paidRecycled)`, no funding-source
        // split), so without this credit a Base-funded top-up would be
        // consumed against a bucket that never held it — flooring the ledger
        // at zero and over-counting `paidOutRecycled`, which inflates the
        // DERIVED `creditedCumulative` and reports Base's own tokens back as
        // this chain's absorption (Codex #1430 r3 F2).
        //
        // It is NOT absorption: {creditCustodyRelocated} keeps it out of the
        // Ā day-bucket AND out of the cumulative this chain reports to Base.
        // The guard against a malformed/hostile payload claiming more
        // recycled backing than actually arrived now runs at the TOP of this
        // function, alongside its fresh-share twin.
        LibVpfiRecycle.creditCustodyRelocated(
            remitId,
            recycledShare,
            LibVpfiRecycle.RecycleSource.RemittedCustodyRelocation
        );
        // r4 — receipts key by (remitter, remitId): `remitter` comes from
        // the remit PAYLOAD (immutable, messenger-authenticated message
        // data — never delivery-time channel config), so different
        // canonical deployments' same-numbered receipts CO-EXIST under
        // distinct keys — no collision, no supersession ordering. Plain
        // first-write-wins per key (CCIP executes a message once).
        if (remitId != 0 && remitter != address(0)) {
            bytes32 key = _receiptKey(remitter, remitId);
            LibVaipakam.ReceivedRemit storage rec = s.receivedRemits[key];
            if (rec.receivedAt == 0) {
                rec.srcChainId = SafeCast.toUint32(sourceChainId);
                rec.receivedAt = uint64(block.timestamp);
                rec.amount = amount;
                rec.remitter = remitter;
            }
        }
        emit RewardBudgetReceived(
            sourceChainId, token, amount, dayIds, remitId, recycledShare,
            freshShare
        );
    }

    // ─── #1434 P2-w2 — the classifying COMPENSATION ingress (§2.2) ────────

    /// @notice A P2 compensation was credited to a zeroed day's per-side
    ///         pools (payable at w3's repricing). `provisional` marks the
    ///         overtake case — the day's V3 broadcast had not landed, so
    ///         the payload's authenticated remitter stands as the assumed
    ///         era until the broadcast confirms or demotes it.
    /// @custom:event-category informational/reward-compensation
    event CompensationCredited(
        uint256 indexed dayId,
        uint256 lenderShare18,
        uint256 borrowerShare18,
        bool provisional,
        address era
    );

    /// @notice A P2 compensation arrival was QUARANTINED into the
    ///         stranded-recovery reservation (§2.2's token-safe rejection —
    ///         tokens accepted, never payable here; the R4 return takes it
    ///         from the reservation). `reason`: 1 = day not deliberately
    ///         zeroed, 2 = era mismatch, 3 = past the day's expiry (lapse
    ///         flags or the frozen clock words, installed or wire-carried),
    ///         4 = a second arrival while a provisional credit is already
    ///         held (one provisional receipt binding per day), 5 = the day
    ///         is permanently V3-unhealable on this rotated mirror (prior
    ///         state, no recorded era — the confirm/demote hook could never
    ///         run), 6 = clockless payload (zero finalizedAt — an honest
    ///         Base refuses such a dispatch, so this is stale or hostile
    ///         and could never settle).
    /// @custom:event-category informational/reward-compensation
    event CompensationQuarantined(
        uint256 indexed dayId,
        address indexed remitter,
        uint256 remitId,
        uint256 amount,
        uint8 reason
    );

    /// @notice A provisional compensation was CONFIRMED in place by the
    ///         day's V3 broadcast (matching era, day genuinely zeroed).
    /// @custom:event-category informational/reward-compensation
    event CompensationConfirmed(uint256 indexed dayId, address era);

    /// @notice A provisional compensation was DEMOTED to the
    ///         stranded-recovery reservation by the day's V3 broadcast
    ///         (era mismatch, or the day turned out not to be zeroed).
    /// @custom:event-category informational/reward-compensation
    event CompensationDemoted(
        uint256 indexed dayId, uint256 amount, uint8 reason
    );

    /**
     * @notice #1434 P2-w2 — trusted ingress for a P2 MANUAL-COMPENSATION
     *         delivery (design §2.2): classify the arrival against the
     *         day's mirror-local state and either credit the per-side
     *         compensated pools or quarantine the value into the arrival
     *         reservation. NEVER reverts on a classification failure — a
     *         revert is re-executable into the same revert forever (§2h
     *         R6d), so the token-safe form accepts the tokens and records
     *         why they are not payable.
     * @dev    Receiver-gated (the receiver already moved the VPFI in and
     *         scaled both shares to what physically landed). Cases, era
     *         first:
     *
     *         KNOWN state (day applied AND era recorded): a remitter that
     *         does not match the day's era quarantines (reason 2 — §1.1's
     *         compensation-side era binding); a day not deliberately
     *         zeroed quarantines (reason 1 — there is nothing to
     *         compensate); a lapsed / short-lapsed day quarantines
     *         (reason 3 — the loss was already recorded at lapse;
     *         unreachable until the w4 terminals ship). Otherwise the
     *         pools credit CONFIRMED.
     *
     *         UNKNOWN state (day not applied, or applied without an era —
     *         the compensation OVERTOOK the V3 broadcast, §2.2 case b):
     *         credit PROVISIONALLY under the payload's authenticated
     *         remitter as the assumed era. The V3 arrival later confirms
     *         in place or demotes to the reservation
     *         ({RewardReporterFacet.onRewardBroadcastV3Received} calls
     *         {onCompensationDayBroadcastArrived}). Never waits: the
     *         expiry inputs rode the remit itself (R4b).
     *
     *         In EVERY case the receipt is recorded exactly like an
     *         ordinary delivery (first write wins), so the ACK path is
     *         unchanged, and `rewardBudgetReceivedTotal` records the
     *         arrival. The armed-fresh counter advances only for CREDITED
     *         pools (quarantined value is recorded uncounted instead), and
     *         what was counted is stored so a demotion can move it —
     *         counted + uncounted always reconciles against what Base
     *         sent.
     */
    function onCompensationBudgetReceived(
        address token,
        uint256 amount,
        uint256 dayId,
        uint256 sourceChainId,
        uint256 remitId,
        address remitter,
        uint256 lenderShare18,
        uint256 borrowerShare18,
        uint64 finalizedAt,
        uint32 lapseScheduleVersion,
        uint64 lapseWindowSeconds,
        uint64 /* dispatchCutoffGap — Base-side input (the R3 refusal);
                  carried for symmetry + w4's gates, unused here */
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.rewardRemittanceReceiver) {
            revert NotRewardRemittanceReceiver(msg.sender);
        }
        if (token != s.vpfiToken) {
            revert RewardBudgetTokenMismatch(s.vpfiToken, token);
        }
        if (lenderShare18 + borrowerShare18 > amount) {
            revert CompensationSharesExceedDelivery(
                lenderShare18, borrowerShare18, amount
            );
        }

        s.rewardBudgetReceivedTotal += amount;
        // Receipt exactly as the ordinary ingress records it — the ACK
        // path reads this record and nothing else.
        if (remitId != 0 && remitter != address(0)) {
            bytes32 rKey = _receiptKey(remitter, remitId);
            LibVaipakam.ReceivedRemit storage rec = s.receivedRemits[rKey];
            if (rec.receivedAt == 0) {
                rec.srcChainId = SafeCast.toUint32(sourceChainId);
                rec.receivedAt = uint64(block.timestamp);
                rec.amount = amount;
                rec.remitter = remitter;
            }
        }

        address era = s.dayClockEra[dayId];
        bool stateKnown = s.broadcastV2Applied[dayId] && era != address(0);
        if (stateKnown) {
            uint8 reason = 0;
            if (remitter != era) reason = 2;
            else if (!s.dayDeliberatelyZeroed[dayId]) reason = 1;
            else if (
                s.dayLapsed[dayId] || s.dayShortLapsed[dayId]
                    // #1656 r3 — the raw-expiry test governs FIRST
                    // compensations only: a compensated-and-open day is
                    // inside its §2.5 REMEDIATION window (the short-lapse
                    // deadline supersedes the original expiry for
                    // supplements — §2.5: "a supplemental arriving after
                    // the state is set is quarantined", i.e. the terminal
                    // FLAGS govern, and they are tested above). Without
                    // this, an aged migrated day's re-opened supplemental
                    // headroom would be unreachable — every top-up would
                    // quarantine against a clock its remediation window
                    // replaced.
                    || (
                        !s.dayCompensation[dayId].compensated
                            && _pastExpiry(
                                s.dayLapseClock[dayId].finalizedAt,
                                s.dayLapseClock[dayId].scheduleVersion,
                                s.dayLapseClock[dayId].lapseWindowSeconds
                            )
                    )
            ) {
                // Codex #1634 r1 — the flags alone are the w4 TERMINALS'
                // record; the INSTALLED clock itself already decides "past
                // the applicable expiry" (§2.2's fourth case tests the
                // clock, not just the flags), so an arrival after the true
                // expiry quarantines even before any terminal has run.
                reason = 3;
            }
            if (reason != 0) {
                _quarantineCompensation(
                    s, dayId, remitter, remitId, amount, reason
                );
                return;
            }
            _creditCompensation(
                s,
                dayId,
                remitId,
                lenderShare18,
                borrowerShare18,
                amount,
                /* provisional */ false,
                era
            );
            return;
        }

        // Codex #1634 r1 — two arrivals that must NOT go provisional:
        //
        // (a) A day the w1 rotation gate has made permanently V3-unhealable
        //     (rotated mirror + prior state + no recorded era): its
        //     provisional credit could never reach the confirm/demote hook,
        //     leaving the value outside the reservation forever. Quarantine
        //     at ingress instead — the same three conjuncts the V3 ingress
        //     refuses on, threaded verbatim.
        if (
            s.rewardEraRotated && era == address(0)
                && (s.broadcastV2Applied[dayId] || s.knownGlobalSet[dayId])
        ) {
            _quarantineCompensation(s, dayId, remitter, remitId, amount, 5);
            return;
        }
        // (b) A SECOND compensation while one is already provisional: the
        //     day holds one provisional receipt binding (era + remitId),
        //     and overwriting it would demote BOTH packets' pools under the
        //     last receipt key — the receipt-bounded return could then
        //     recover at most that one reservation's entitlement, stranding
        //     the earlier packet. One provisional credit per day;
        //     conflicting arrivals hold their own receipt-keyed reservation
        //     until the day's broadcast settles which era governs.
        LibVaipakam.DayCompensation storage dcPrior = s.dayCompensation[dayId];
        if (dcPrior.provisional) {
            _quarantineCompensation(s, dayId, remitter, remitId, amount, 4);
            return;
        }
        // (c) A CLOCKLESS payload (zero finalizedAt) cannot settle: an
        //     honest Base refuses such a dispatch outright (#1634 r2 —
        //     {CompensationDayHasNoClock}), so one arriving here is stale
        //     or hostile, and a provisional credit for it would wait on a
        //     V3 broadcast that can never carry a matching clock. The
        //     token-safe mirror of the Base-side refusal (reason 6).
        if (finalizedAt == 0) {
            _quarantineCompensation(s, dayId, remitter, remitId, amount, 6);
            return;
        }
        // (d) The overtake case can still be PAST ITS TRUE EXPIRY: the wire
        //     carries the full frozen clock words (R4b), so the ingress
        //     evaluates them even with no broadcast state — a delivery
        //     arriving after the day's expiry must never be provisionally
        //     credited only to lapse at confirmation.
        if (_pastExpiry(finalizedAt, lapseScheduleVersion, lapseWindowSeconds))
        {
            _quarantineCompensation(s, dayId, remitter, remitId, amount, 3);
            return;
        }
        _creditCompensation(
            s,
            dayId,
            remitId,
            lenderShare18,
            borrowerShare18,
            amount,
            /* provisional */ true,
            remitter
        );
    }

    /// @dev §2.4 — expiry from FROZEN words only, both sourced from Base's
    ///      finalization-time freeze (the installed clock on a stamped day,
    ///      the wire's duplicated words on an unstamped one). Version 0 =
    ///      no schedule frozen ⇒ never expired (a zero window must not
    ///      read as "lapse immediately" — the w1 rule).
    function _pastExpiry(
        uint64 finalizedAt,
        uint32 scheduleVersion,
        uint64 lapseWindowSeconds
    ) private view returns (bool) {
        return finalizedAt != 0 && scheduleVersion != 0
            && block.timestamp > uint256(finalizedAt) + lapseWindowSeconds;
    }

    /// @dev Credit the per-side pools (+ the armed-fresh counter when the
    ///      day is armed-attributable), recording what was counted so a
    ///      later demotion can move exactly that.
    function _creditCompensation(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        uint256 remitId,
        uint256 lenderShare18,
        uint256 borrowerShare18,
        uint256 amount,
        bool provisional,
        address era
    ) private {
        LibVaipakam.DayCompensation storage dc = s.dayCompensation[dayId];
        // #1434 P2-w4 (§2.5) — the short-compensated deadline inputs,
        // stamped BEFORE the pools move so the qualifying test reads the
        // pre-credit shortfall. First credit starts the absolute 3×
        // clock; a later credit extends the rolling window ONLY if it is
        // QUALIFYING — cutting the remaining per-side shortfall by at
        // least one quarter on some short side — so dust top-ups cannot
        // park the day unclaimable forever (§2.5's bounded-deadline
        // rule). With no standing quote yet (accums zero) nothing is
        // "short", the qualifying test is vacuously false, and only the
        // first-credit stamp lands — the deadline then runs on the
        // absolute clock, which is the conservative direction.
        //
        // #1656 r11 — a PROVISIONAL credit stamps NO clocks: it awaits
        // its V3 confirmation, and until that lands Base holds the
        // compensation gate (a supplemental needs a consumed ACK's
        // round trip first), so no remediation interval exists yet. A
        // delayed broadcast would otherwise burn the whole window while
        // supplementing was impossible and let the short-lapse terminal
        // fire the moment `provisional` clears. The confirm hook stamps
        // the clocks at confirmation time instead; the demote path
        // deletes any stamped clocks with the credit (r1).
        if (!provisional) {
            if (s.firstCompReceiptAt[dayId] == 0) {
                s.firstCompReceiptAt[dayId] = uint64(block.timestamp);
                s.lastQualifyingCompReceiptAt[dayId] =
                    uint64(block.timestamp);
            } else if (
                _cutsShortfallByQuarter(
                    s, dayId, lenderShare18, borrowerShare18
                )
            ) {
                s.lastQualifyingCompReceiptAt[dayId] =
                    uint64(block.timestamp);
            }
        }
        dc.lenderPool18 += SafeCast.toUint128(lenderShare18);
        dc.borrowerPool18 += SafeCast.toUint128(borrowerShare18);
        dc.creditedAmount += SafeCast.toUint128(amount);
        dc.compensated = true;
        if (provisional) {
            dc.provisional = true;
            dc.provisionalEra = era;
        }
        dc.remitId = remitId;
        // #1656 r8 - receipt classification: era == the payload remitter
        // on both credit paths (the known-state ladder requires the
        // match; the provisional branch DEFINES era := remitter).
        s.receivedRemits[_receiptKey(era, remitId)].classification =
            provisional ? 2 : 0;

        uint256 armedFrom = s.governorCommitArmedFromDay;
        if (armedFrom != 0 && dayId >= armedFrom) {
            s.rewardBudgetArmedFreshReceived += amount;
            dc.armedFreshCounted += SafeCast.toUint128(amount);
        } else {
            s.rewardBudgetFreshUncounted += amount;
        }
        emit CompensationCredited(
            dayId, lenderShare18, borrowerShare18, provisional, era
        );
    }

    /// @dev #1434 P2-w4 (§2.5) — does this credit cut the remaining
    ///      per-side shortfall (quoted − pool, on a side that IS short)
    ///      by at least one quarter? Reads the PRE-credit pools (the
    ///      caller stamps before crediting). A side with no shortfall
    ///      contributes nothing; with neither side short there is nothing
    ///      to qualify against.
    function _cutsShortfallByQuarter(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        uint256 lenderShare18,
        uint256 borrowerShare18
    ) private view returns (bool) {
        LibVaipakam.DayCompensation storage dc = s.dayCompensation[dayId];
        uint256 shortL;
        uint256 shortB;
        {
            uint256 qL = s.compQuoteAccum18[
                dayId
            ][uint8(LibVaipakam.RewardSide.Lender)];
            uint256 qB = s.compQuoteAccum18[
                dayId
            ][uint8(LibVaipakam.RewardSide.Borrower)];
            uint256 pL = uint256(dc.lenderPool18);
            uint256 pB = uint256(dc.borrowerPool18);
            shortL = qL > pL ? qL - pL : 0;
            shortB = qB > pB ? qB - pB : 0;
        }
        if (shortL != 0 && lenderShare18 * 4 >= shortL) return true;
        if (shortB != 0 && borrowerShare18 * 4 >= shortB) return true;
        return false;
    }

    /// @dev The token-safe rejection: the whole arrival enters the
    ///      stranded-recovery reservation (backing excluded from ordinary
    ///      claims via {LibVpfiRecycle.backingPosition}), its fresh value
    ///      recorded UNCOUNTED, and the receipt-keyed record names it for
    ///      the R4 return (w5).
    function _quarantineCompensation(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        address remitter,
        uint256 remitId,
        uint256 amount,
        uint8 reason
    ) private {
        s.strandedRecoveryReserved += amount;
        s.rewardBudgetFreshUncounted += amount;
        LibVaipakam.StrandedRecovery storage sr =
            s.strandedRecoveries[_receiptKey(remitter, remitId)];
        sr.amount += amount;
        sr.dayId = dayId;
        if (sr.reservedAt == 0) sr.reservedAt = uint64(block.timestamp);
        sr.reason = reason;
        // #1656 r8 - the receipt carries the classification so the ACK
        // wire can say "not consumed" and hold the R6 gate.
        s.receivedRemits[_receiptKey(remitter, remitId)].classification = 1;
        emit CompensationQuarantined(dayId, remitter, remitId, amount, reason);
    }

    /**
     * @notice #1434 P2-w2 — the V3-broadcast arrival hook for a day
     *         holding a PROVISIONAL compensation: CONFIRM it in place when
     *         the broadcast's deployment matches the assumed era AND the
     *         day is genuinely deliberately-zeroed; DEMOTE the whole
     *         credit to the stranded-recovery reservation otherwise (the
     *         confirmed era's state governs).
     * @dev    Diamond-internal: callable only through the Diamond itself
     *         ({RewardReporterFacet.onRewardBroadcastV3Received} invokes it
     *         via `address(this)` after installing/verifying the day's
     *         clock). No-op for a day with no provisional credit.
     */
    function onCompensationDayBroadcastArrived(
        uint256 dayId,
        address baseDeployment,
        bool zeroedForDest
    ) external {
        if (msg.sender != address(this)) {
            revert CompensationHookNotSelf(msg.sender);
        }
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.DayCompensation storage dc = s.dayCompensation[dayId];
        if (!dc.provisional) return;

        if (dc.provisionalEra == baseDeployment && zeroedForDest) {
            dc.provisional = false;
            // #1656 r11 — the remediation clock starts NOW, not at the
            // provisional receipt: only from confirmation can Base's
            // supplemental path ever run (gate → consumed ACK → gate
            // clear), so the bounded window must not have been burning
            // while the credit sat unconfirmed. First-stamp only: a
            // provisional can exist solely on a day with no known
            // broadcast state, and every credited (clock-stamping)
            // receipt flows through the known-state branch — a non-zero
            // clock here is an unreachable ordering left untouched
            // defensively (the absolute 3× cap governs regardless).
            if (s.firstCompReceiptAt[dayId] == 0) {
                s.firstCompReceiptAt[dayId] = uint64(block.timestamp);
                s.lastQualifyingCompReceiptAt[dayId] =
                    uint64(block.timestamp);
            }
            // #1656 r8 - the settled credit is CONSUMED: its receipt's
            // ack may now clear the R6 gate.
            s.receivedRemits[
                _receiptKey(dc.provisionalEra, dc.remitId)
            ].classification = 0;
            // #1634 r3 — reclassify against the NOW-installed D*: the same
            // core call that delivered this confirming broadcast installs
            // `armedFromDay` BEFORE this hook runs, so a compensation that
            // overtook the arming broadcast (credited while the chain was
            // still unarmed, counted as zero) moves to the armed-fresh
            // ledger here — otherwise the delivered-fresh bound would
            // defer this day's claims despite their backing having landed.
            uint256 armedFrom = s.governorCommitArmedFromDay;
            if (
                dc.armedFreshCounted == 0 && armedFrom != 0
                    && dayId >= armedFrom
            ) {
                uint256 credited = dc.creditedAmount;
                s.rewardBudgetArmedFreshReceived += credited;
                uint256 unc = s.rewardBudgetFreshUncounted;
                s.rewardBudgetFreshUncounted =
                    unc > credited ? unc - credited : 0;
                dc.armedFreshCounted = SafeCast.toUint128(credited);
            }
            emit CompensationConfirmed(dayId, baseDeployment);
            return;
        }
        // Demote: era mismatch (2) or the day was never zeroed (1). The
        // reservation takes the CREDITED amount, wholesale (#1634 r3) —
        // the pool sum can floor a wei below it on a scaled delivery, and
        // the design promises the demotion moves the arrival, not the sum.
        uint8 reason = dc.provisionalEra == baseDeployment ? 1 : 2;
        uint256 pools = dc.creditedAmount;
        uint256 counted = dc.armedFreshCounted;
        s.strandedRecoveryReserved += pools;
        // Move the counted portion back to uncounted so the
        // counted + uncounted reconciliation identity holds.
        if (counted != 0) {
            uint256 af = s.rewardBudgetArmedFreshReceived;
            s.rewardBudgetArmedFreshReceived = af > counted ? af - counted : 0;
            s.rewardBudgetFreshUncounted += counted;
        }
        LibVaipakam.StrandedRecovery storage sr = s.strandedRecoveries[
            _receiptKey(dc.provisionalEra, dc.remitId)
        ];
        sr.amount += pools;
        sr.dayId = dayId;
        if (sr.reservedAt == 0) sr.reservedAt = uint64(block.timestamp);
        sr.reason = reason;
        // #1656 r8 - demoted = stranded: the receipt's ack must not
        // clear the R6 gate any more.
        s.receivedRemits[
            _receiptKey(dc.provisionalEra, dc.remitId)
        ].classification = 1;
        delete s.dayCompensation[dayId];
        // #1656 r1 - the demoted credit's receipt clocks go with it: a
        // later CURRENT-era compensation must get its own full bounded
        // window, not inherit a rejected packet's aged firstCompReceiptAt
        // (three windows past which it could be short-lapsed on arrival).
        delete s.firstCompReceiptAt[dayId];
        delete s.lastQualifyingCompReceiptAt[dayId];
        emit CompensationDemoted(dayId, pools, reason);
    }





    /**
     * @dev #1434 P1-a — may this delivery's fresh component be counted as
     *      ARMED funding on this chain?
     *
     *      True only when the chain has installed `D*` AND every day the
     *      delivery covers is at or after it. Both halves are load-bearing:
     *
     *        - Unarmed chain ⇒ false. There is no armed regime to attribute
     *          funding to yet, so nothing can be armed-attributable.
     *        - ANY pre-`D*` day ⇒ false for the WHOLE delivery. `_planDay`
     *          decides armedness per day and the remit carries one summed
     *          amount for its whole day set, so a batch that straddles the
     *          cutover cannot be apportioned from what arrives here. It is
     *          refused entirely rather than split on a guess — under-stating
     *          this chain's funding, which defers, instead of over-stating
     *          it, which pays.
     *
     *      An empty day set is likewise false: a delivery that names no days
     *      cannot be shown to fund armed ones.
     *
     *      A delivery for armed days that OVERTAKES the arming broadcast is
     *      therefore uncounted too — the chain is still unarmed when it lands
     *      and nothing re-attributes it afterwards. That ordering is not
     *      guaranteed by CCIP, only made unlikely by the schedule (`D*` is a
     *      future day at arming, and its funding cannot be planned until the
     *      day finalizes). It is a real conservative gap, not an impossible
     *      one, and `rewardBudgetFreshUncounted` is what surfaces it.
     */
    function _armedAttributableDelivery(
        LibVaipakam.Storage storage s,
        uint256[] calldata dayIds
    ) private view returns (bool) {
        uint256 armedFrom = s.governorCommitArmedFromDay;
        if (armedFrom == 0) return false;
        uint256 n = dayIds.length;
        if (n == 0) return false;
        for (uint256 i = 0; i < n; ) {
            if (dayIds[i] < armedFrom) return false;
            unchecked { ++i; }
        }
        return true;
    }

    /// @dev r4 — composite receipt key: remit ids are per-deployment.
    function _receiptKey(
        address remitter,
        uint256 remitId
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(remitter, remitId));
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
            s.receivedRemits[_receiptKey(remitter, remitId)];
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
        // #1434 P2-w6 (§5.4 R6e) — the IMPORTED-marker branch, before the
        // era check: after a Base rotation, the retired deployment's
        // outstanding compensation holds this chain's gate under an
        // imported old-era tuple. The mirror's receipt state survives the
        // rotation, and its permissionlessly re-presented ack reaches the
        // CURRENT deployment here — verified against the imported marker,
        // never against our own reservations (which never contained the
        // tuple). A CONSUMED attestation resolves the old delivery and
        // releases the gate; quarantined/provisional old-era value cannot
        // settle through a new-era return (the B1 era check refuses old
        // remitters by design) and resolves via the ADMIN evidenced
        // clear + ceremony instead — observed here, never guessed at.
        // #1660 r6 - the wire offsets classification by one (0 is the
        // RETIRED generation-1 bool-false shape): 1 consumed /
        // 2 quarantined / 3 provisional. Zero or out-of-range fails
        // closed and re-executable - never guessed at. (#1662 r1 -
        // validated BEFORE the imported branch, so an imported tuple's
        // malformed ack fails closed too, never "observes".)
        if (classification == 0 || classification > 3) {
            revert RemitAckClassificationInvalid(classification);
        }
        {
            LibVaipakam.ImportedOutstanding storage im =
                s.importedOutstanding[sourceChainId];
            if (
                im.oldRemitter != address(0) && im.oldRemitter == remitter
                    && im.oldRemitId == remitId
            ) {
                if (classification == 1) {
                    if (im.quarantineObserved) {
                        // #1662 r1 - consumed AFTER quarantined is the
                        // own-era contradiction rule, imported: an
                        // honest mirror never transitions quarantined ->
                        // consumed, so the re-present gets NO clear -
                        // the gate stays held for the operator's
                        // evidenced settlement.
                        emit ImportedOutstandingConflict(
                            sourceChainId, remitter, remitId
                        );
                    } else {
                        delete s.importedOutstanding[sourceChainId];
                        LibRewardRemitDispatch.clearCompensationGate(
                            s, sourceChainId
                        );
                        emit ImportedOutstandingResolved(
                            sourceChainId, remitter, remitId
                        );
                    }
                } else {
                    // #1662 r1 - a QUARANTINED re-present is terminal
                    // mirror-side evidence and is REMEMBERED (a later
                    // consumed re-present must conflict); a provisional
                    // one is not (it may still legitimately confirm
                    // consumed).
                    if (classification == 2) im.quarantineObserved = true;
                    emit ImportedOutstandingObserved(
                        sourceChainId, remitter, remitId, classification
                    );
                }
                return;
            }
        }
        // #1662 r4 — a SETTLED imported tuple: the marker was deleted at
        // settlement, so a late consumed re-present from the old mirror
        // would fall through to the era check and revert, leaving the
        // credit that settlement minted freely re-dispatchable while the
        // original delivery in fact backs mirror claims. The tombstone is
        // the only surviving link from the old-era tuple to that credit,
        // and consumption is exactly the evidence that voids it.
        {
            bytes32 tomb = keccak256(abi.encode(remitter, remitId));
            uint256 attributed = s.importedSettledAttribution[tomb];
            if (attributed != 0) {
                if (classification == 1) {
                    (uint256 claw, uint256 unspent) =
                        _voidRecoveryCredit(s, attributed);
                    if (unspent != 0) {
                        emit ImportedAttributionVoided(
                            sourceChainId, remitter, remitId, attributed, claw
                        );
                    }
                } else {
                    emit ImportedOutstandingObserved(
                        sourceChainId, remitter, remitId, classification
                    );
                }
                return;
            }
        }
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
                    ackConflict = _stampConsumedAck(s, r, remitId);
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
                    bool relConflict = _stampConsumedAck(s, r, remitId);
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

    /// @notice #1434 P2-w6 (§5.4 R6e) — a mirror's re-presented CONSUMED
    ///         attestation resolved an imported old-era outstanding
    ///         compensation; the chain's gate released.
    /// @custom:event-category state-change/reward-compensation
    event ImportedOutstandingResolved(
        uint32 indexed sourceChainId,
        address oldRemitter,
        uint256 oldRemitId
    );

    /// @notice §5.4 R6e — an imported tuple's ack arrived NON-consumed:
    ///         observed for the operator (the evidenced clear + ceremony
    ///         are the resolution path), gate unchanged.
    /// @custom:event-category informational/reward-compensation
    event ImportedOutstandingObserved(
        uint32 indexed sourceChainId,
        address oldRemitter,
        uint256 oldRemitId,
        uint8 classification
    );

    /// @notice §5.4 R6e (#1662 r1) — an imported tuple's re-presented
    ///         CONSUMED attestation CONTRADICTED its earlier quarantine
    ///         re-present: no clear extended; the evidenced settlement is
    ///         the only remaining resolution.
    /// @custom:event-category state-change/reward-compensation
    event ImportedOutstandingConflict(
        uint32 indexed sourceChainId,
        address oldRemitter,
        uint256 oldRemitId
    );

    /// @notice §5.4 R6e (#1662 r4) — an ALREADY-SETTLED imported tuple's
    ///         old mirror re-presented a CONSUMED attestation: the credit
    ///         that settlement minted is void (the delivery backs mirror
    ///         claims after all). `clawed` is what the pooled position
    ///         could physically absorb; the entitlement is voided whole.
    /// @custom:event-category state-change/reward-compensation
    event ImportedAttributionVoided(
        uint32 indexed sourceChainId,
        address oldRemitter,
        uint256 oldRemitId,
        uint256 attributionId,
        uint256 clawed
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
        uint256 remitId
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
        if (
            r.declaredUnwound
                && r.dayIds.length == 1
                && (r.declaredLender18 != 0 || r.declaredBorrower18 != 0)
        ) {
            uint32 cdst = r.dstChainId;
            uint256 cday = r.dayIds[0];
            if (s.dayClosedByRemitId[cdst][cday] == 0) {
                s.dayClosedByRemitId[cdst][cday] = remitId;
                s.rewardBudgetRemitted[cdst][cday] = r.total;
            }
            r.declaredUnwound = false;
            s.compFundedLender18[cdst][cday] += r.declaredLender18;
            s.compFundedBorrower18[cdst][cday] += r.declaredBorrower18;
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
        if (consumed) ackConflict = _stampConsumedAck(s, r, remitId);
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
