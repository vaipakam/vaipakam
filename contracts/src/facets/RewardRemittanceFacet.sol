// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibVpfiRecycle} from "../libraries/LibVpfiRecycle.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {ICrossChainMessenger} from "../crosschain/ICrossChainMessenger.sol";
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
    struct RemitSplitTotals {
        uint256 totalAll;
        uint256 fresh;
        uint256 recycled;
        uint256 armedFresh;
        uint256 armedFrom;
        uint256 recycledFull;
        // Codex #1426 r2 — running recycled-backing budget (seeded from
        // `recycleBucket`, decremented per closed day): a day whose recycled
        // share exceeds it is SKIPPED, not closed. After an operator release
        // the stranded tokens sit outside Diamond custody, and a re-remit
        // would otherwise draw its "recycled" share from fresh/user custody
        // while `consume` floors the bucket at zero (bucket-backing
        // violation). Healthy-path no-op: finalize-time commitments reserve
        // every recycled share against `fundable`, so backing always covers
        // it; a blocked day flows again once governance returns the tokens
        // and re-credits the bucket (B2-d5 custody-credit class). Applied
        // IDENTICALLY at all four planning sites (send + three quotes).
        uint256 backingLeft;
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
    ///         the emission counters + outstanding commitments were restored.
    ///         `recycledStranded` is the recycled share whose tokens sit
    ///         locked in the CCIP token pool — the bucket is deliberately NOT
    ///         re-credited (out of Diamond custody); physical recovery rides
    ///         the B2-d5 custody-credit class.
    /// @custom:event-category informational/reward-transport
    event RemitReservationReleased(
        uint256 indexed remitId,
        uint32 indexed dstChainId,
        uint256 total,
        uint256 fresh,
        uint256 recycledStranded
    );

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

    /// @notice #1222 M3 B2-d2 — a mirror dispatched its remit ack toward Base.
    /// @custom:event-category informational/reward-transport
    event RemitAckDispatched(
        uint256 indexed remitId,
        bytes32 messageId,
        uint256 amount
    );

    /// @notice #1222 M3 B2-d2 — the evidenced manual-budget path funded a
    ///         `(chain, day)` a force-finalize had zeroed out of the
    ///         denominator (`remitIneligible` — the flag is the evidence and
    ///         must still be set). Fresh-funded under the 69M cap; reserves
    ///         and acks like any remit.
    /// @custom:event-category informational/reward-transport
    event ManualRewardBudgetRemitted(
        uint32 indexed dstChainId,
        uint256 indexed dayId,
        uint256 amount,
        uint256 remitId
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
    /// @custom:event-category informational/reward-transport
    event RewardBudgetReceived(
        uint256 indexed sourceChainId,
        address indexed token,
        uint256 amount,
        uint256[] dayIds,
        uint256 remitId
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
        // days that actually contribute VPFI into `fundedDays` (skipping
        // skipped/duplicate/zero days) — that filtered set, not the caller's
        // raw `dayIds`, rides the payload so the mirror's reconciliation
        // events name exactly the funded days. `closedDays` additionally
        // collects every day this batch terminally closes (funded + armed
        // clamped-to-zero) — the reservation records those for release.
        uint256[] memory fundedDays = new uint256[](dayIds.length);
        uint256 fundedCount;
        uint256[] memory closedDays = new uint256[](dayIds.length);
        uint256 closedCount;
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
        st.backingLeft = s.recycleBucket;
        for (uint256 i; i < dayIds.length; ) {
            uint256 dayId = dayIds[i];
            if (!s.dailyGlobalFinalized[dayId]) {
                revert RewardDayNotFinalized(dayId);
            }
            DayRemitPlan memory p = _planDay(s, dstChainId, dayId, st.armedFrom);
            // r2 backing filter (see {RemitSplitTotals.backingLeft}).
            if (p.close && p.recycled <= st.backingLeft) {
                st.backingLeft -= p.recycled;
                // Terminal close: a duplicate of this day later in the batch
                // re-enters {_planDay} and finds the marker, so each day
                // closes at most once.
                s.dayClosedByRemitId[dstChainId][dayId] = remitId;
                closedDays[closedCount] = dayId;
                unchecked {
                    ++closedCount;
                }
                uint256 slice = p.fresh + p.recycled;
                if (slice > 0) {
                    s.rewardBudgetRemitted[dstChainId][dayId] = slice;
                    st.totalAll += slice;
                    st.fresh += p.fresh;
                    st.recycled += p.recycled;
                    fundedDays[fundedCount] = dayId;
                    unchecked {
                        ++fundedCount;
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
        if (closedCount == 0) revert NothingToRemit();
        // Trim the collection arrays to their filled lengths (shrink the
        // memory arrays' lengths in place — safe, we only ever reduce them;
        // the annotation keeps solc's memoryguard active so viaIR can spill
        // this function's locals).
        assembly ("memory-safe") {
            mstore(fundedDays, fundedCount)
            mstore(closedDays, closedCount)
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
        uint256 used = s.rewardBudgetRemittedGlobal + s.interactionPoolPaidOut;
        uint256 remaining = used >= LibVaipakam.VPFI_INTERACTION_POOL_CAP
            ? 0
            : LibVaipakam.VPFI_INTERACTION_POOL_CAP - used;
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
            r.dayIds = closedDays;
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
            s, vpfi, messenger, dstChainId, fundedDays, st.totalAll, remitId
        );

        emit RewardBudgetRemitted(
            dstChainId, st.totalAll, fundedCount, messageId, remitId
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
        uint256 total,
        uint256 remitId
    ) private returns (bytes32 messageId) {
        IERC20(vpfi).forceApprove(messenger, total);

        bytes memory payload = abi.encode(fundedDays, total, remitId);
        ICrossChainMessenger.TokenAmount[] memory tokens =
            new ICrossChainMessenger.TokenAmount[](1);
        tokens[0] =
            ICrossChainMessenger.TokenAmount({token: vpfi, amount: total});

        uint256 fee = ICrossChainMessenger(messenger).quoteMessageFee(
            dstChainId,
            payload,
            tokens,
            REWARD_BUDGET_DEST_GAS_LIMIT
        );
        if (msg.value < fee) revert InsufficientRemittanceFee(msg.value, fee);

        messageId = ICrossChainMessenger(messenger).sendMessage{value: fee}(
            dstChainId,
            payload,
            tokens,
            REWARD_BUDGET_DEST_GAS_LIMIT
        );

        // slither-disable-start reentrancy-no-eth,reentrancy-benign
        // Deliberate write-after-call: records the send's OWN returned id
        // (unknowable earlier); messenger is the admin-wired CCIP adapter and
        // every caller is nonReentrant.
        s.remitReservations[remitId].ccipMessageId = messageId;
        s.remitIdByCcipMessageId[messageId] = remitId;
        // slither-disable-end reentrancy-no-eth,reentrancy-benign

        // Refund any fee overpayment to the caller (operator/keeper EOA).
        if (msg.value > fee) {
            (bool ok, ) = payable(msg.sender).call{value: msg.value - fee}("");
            if (!ok) revert RemittanceRefundFailed();
        }
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
        (uint256 sliceFresh, uint256 sliceRecycled) = LibInteractionRewards
            .chainRewardBudgetSplitForDay(s, dstChainId, dayId);
        uint256 sliceTotal = sliceFresh + sliceRecycled;
        if (sliceTotal == 0) return p;
        p.close = true;
        if (armed) {
            p.armedFreshFull = sliceFresh;
            p.recycledFull = sliceRecycled;
            uint256 liability =
                c.liabilityLender18 + c.liabilityBorrower18;
            if (liability < sliceTotal) {
                uint256 clampedFresh = liability == 0
                    ? 0
                    : (liability * sliceFresh) / sliceTotal;
                p.fresh = clampedFresh;
                p.recycled = liability - clampedFresh;
            } else {
                p.fresh = sliceFresh;
                p.recycled = sliceRecycled;
            }
        } else {
            p.fresh = sliceFresh;
            p.recycled = sliceRecycled;
        }
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
     */
    function onRewardBudgetReceived(
        address token,
        uint256 amount,
        uint256[] calldata dayIds,
        uint256 sourceChainId,
        uint256 remitId
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.rewardRemittanceReceiver) {
            revert NotRewardRemittanceReceiver(msg.sender);
        }
        if (token != s.vpfiToken) {
            revert RewardBudgetTokenMismatch(s.vpfiToken, token);
        }
        s.rewardBudgetReceivedTotal += amount;
        if (remitId != 0 && s.receivedRemits[remitId].receivedAt == 0) {
            s.receivedRemits[remitId] = LibVaipakam.ReceivedRemit({
                srcChainId: SafeCast.toUint32(sourceChainId),
                receivedAt: uint64(block.timestamp),
                amount: amount
            });
        }
        emit RewardBudgetReceived(sourceChainId, token, amount, dayIds, remitId);
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
        LibVaipakam.ReceivedRemit storage rec = s.receivedRemits[remitId];
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
        messageId = IRewardMessenger(messenger).sendRemitAck{value: msg.value}(
            remitId, rec.amount, refundAddress
        );
        emit RemitAckDispatched(remitId, messageId, rec.amount);
    }

    /// @notice Quote the CCIP native fee a {sendRemitAck} for `remitId` costs.
    function quoteRemitAckFee(
        uint256 remitId
    ) external view returns (uint256 fee) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address messenger = s.rewardMessenger;
        if (messenger == address(0)) revert RewardMessengerNotSet();
        LibVaipakam.ReceivedRemit storage rec = s.receivedRemits[remitId];
        if (rec.receivedAt == 0) revert ReceivedRemitNotFound(remitId);
        // Codex #1426 r2 — mirror the send's stale-receipt rejection.
        if (rec.srcChainId != s.baseChainId) {
            revert ReceivedRemitStale(remitId, rec.srcChainId);
        }
        fee = IRewardMessenger(messenger).quoteSendRemitAck(
            remitId, rec.amount
        );
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
        uint256 amountReceived
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.rewardMessenger || s.rewardMessenger == address(0))
        {
            revert NotAuthorizedRewardMessenger();
        }
        if (!s.isCanonicalRewardChain) revert NotCanonicalRewardChain();
        LibVaipakam.RemitReservation storage r = s.remitReservations[remitId];
        if (r.status == 2) return;
        if (r.status == 3) {
            emit RemitAckAfterRelease(remitId, sourceChainId, amountReceived);
            return;
        }
        if (r.status != 1) revert RemitReservationNotPending(remitId);
        if (r.dstChainId != sourceChainId) {
            revert RemitAckChainMismatch(remitId, r.dstChainId, sourceChainId);
        }
        _finalizeReservation(s, r, remitId, amountReceived, false);
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
        _finalizeReservation(s, r, remitId, 0, true);
    }

    /**
     * @notice ADMIN valve — release a PENDING reservation the operator has
     *         verified can NEVER execute: re-opens its days for funding and
     *         restores the emission counters + outstanding commitments.
     * @dev    LAST-RESORT + evidenced: CCIP failed messages stay manually
     *         re-executable indefinitely, so the normal recovery is
     *         re-execution → delivery → ack, with the reservation simply
     *         staying Pending meanwhile. Release is for a message with
     *         permanent-failure evidence (e.g. an unrecoverable receiver).
     *         The recycled share's TOKENS sit locked in the CCIP token pool —
     *         genuinely outside Diamond custody — so `recycleBucket` is
     *         deliberately NOT re-credited (see
     *         {LibVpfiRecycle.restoreReleasedRemit}); the release event
     *         records the stranded figure and physical recovery rides the
     *         B2-d5 custody-credit class. If the message executes AFTER a
     *         release, the late ack surfaces via {RemitAckAfterRelease}.
     */
    function releaseRemitReservation(
        uint256 remitId
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) onlyCanonical {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.RemitReservation storage r = s.remitReservations[remitId];
        if (r.status != 1) revert RemitReservationNotPending(remitId);
        r.status = 3;
        uint32 dst = r.dstChainId;
        uint256[] storage closed = r.dayIds;
        uint256 n = closed.length;
        for (uint256 i; i < n; ) {
            uint256 d = closed[i];
            delete s.rewardBudgetRemitted[dst][d];
            delete s.dayClosedByRemitId[dst][d];
            unchecked {
                ++i;
            }
        }
        uint256 g = s.rewardBudgetRemittedGlobal;
        s.rewardBudgetRemittedGlobal = g > r.fresh ? g - r.fresh : 0;
        uint256 t = s.rewardBudgetRemittedTotal[dst];
        s.rewardBudgetRemittedTotal[dst] = t > r.total ? t - r.total : 0;
        uint256 pending = s.remitPendingTotal[dst];
        s.remitPendingTotal[dst] = pending > r.total ? pending - r.total : 0;
        LibInteractionRewards.restoreArmedFresh(r.armedFreshFull);
        LibVpfiRecycle.restoreReleasedRemit(r.recycledFull, r.recycled);
        emit RemitReservationReleased(
            remitId, dst, r.total, r.fresh, r.recycled
        );
    }

    /// @dev Shared ack/force finalize: Pending → Acked, pending → acked
    ///      aggregates rolled.
    function _finalizeReservation(
        LibVaipakam.Storage storage s,
        LibVaipakam.RemitReservation storage r,
        uint256 remitId,
        uint256 amountReceived,
        bool forced
    ) private {
        r.status = 2;
        uint32 dst = r.dstChainId;
        uint256 total = r.total;
        uint256 pending = s.remitPendingTotal[dst];
        s.remitPendingTotal[dst] = pending > total ? pending - total : 0;
        s.remitAckedTotal[dst] += total;
        emit RemitReservationAcked(remitId, dst, total, amountReceived, forced);
    }

    /**
     * @notice ADMIN — the evidenced MANUAL-BUDGET path for a `(day, chain)` a
     *         force-finalize ZEROED out of the interest denominator: funds an
     *         operator-sized amount to the mirror through the full
     *         delivered-backing ledger (reservation → CCIP token send → ack).
     * @dev    Requires the day still marked `remitIneligible` — the un-cleared
     *         flag IS the on-chain evidence the day was zeroed; run this
     *         BEFORE any {RewardCommitmentFacet.reconcileCommitmentRemitEligibility}
     *         clear (for a zeroed day clearing restores nothing fundable —
     *         the automatic slice is 0 forever — and it removes this path's
     *         anchor). The amount is operator-sized from the mirror's locally
     *         readable state (day totals + entry set — design record §2b: the
     *         zeroed chain's own report prices at its deliberately-zero stamp
     *         and is NOT a sizing basis). FRESH-funded under the 69M
     *         `RewardPoolCapExceeded` guard (the zeroed day stamped no
     *         recycled funding for this chain, so a recycled draw has no
     *         backing figure); no armed-fresh commitment retires (the zeroed
     *         chain's share was never committed at finalize — its numerator
     *         was excluded from the globals). The flag stays set as
     *         historical evidence; the day is closed by the reservation
     *         marker, so no automatic path can double-fund it.
     */
    function remitManualBudget(
        uint32 dstChainId,
        uint256 dayId,
        uint256 amount
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
        if (amount == 0) revert NothingToRemit();
        if (!s.dailyGlobalFinalized[dayId]) {
            revert RewardDayNotFinalized(dayId);
        }
        if (!s.chainDayCommitments[dayId][dstChainId].remitIneligible) {
            revert RemitDayNotManualEligible(dayId, dstChainId);
        }
        if (
            s.rewardBudgetRemitted[dstChainId][dayId] != 0
                || s.dayClosedByRemitId[dstChainId][dayId] != 0
        ) {
            revert RemitDayAlreadyClosed(dayId, dstChainId);
        }
        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert VPFITokenNotSet();
        address messenger = s.crossChainMessenger;
        if (messenger == address(0)) revert RewardBudgetMessengerNotSet();

        uint256 used = s.rewardBudgetRemittedGlobal + s.interactionPoolPaidOut;
        uint256 remaining = used >= LibVaipakam.VPFI_INTERACTION_POOL_CAP
            ? 0
            : LibVaipakam.VPFI_INTERACTION_POOL_CAP - used;
        if (amount > remaining) {
            revert RewardPoolCapExceeded(amount, remaining);
        }

        // Effects (CEI) — mark, count, reserve.
        uint256 remitId = ++s.remitReservationNonce;
        s.rewardBudgetRemitted[dstChainId][dayId] = amount;
        s.dayClosedByRemitId[dstChainId][dayId] = remitId;
        s.rewardBudgetRemittedGlobal += amount;
        s.rewardBudgetRemittedTotal[dstChainId] += amount;
        s.remitPendingTotal[dstChainId] += amount;
        {
            LibVaipakam.RemitReservation storage r =
                s.remitReservations[remitId];
            r.dstChainId = dstChainId;
            r.status = 1;
            r.sentAt = uint64(block.timestamp);
            r.total = amount;
            r.fresh = amount;
            uint256[] memory one = new uint256[](1);
            one[0] = dayId;
            r.dayIds = one;
        }

        uint256[] memory fundedDays = new uint256[](1);
        fundedDays[0] = dayId;
        messageId = _sendRemitPayload(
            s, vpfi, messenger, dstChainId, fundedDays, amount, remitId
        );

        emit ManualRewardBudgetRemitted(dstChainId, dayId, amount, remitId);
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
        // r2 backing filter — identical to the send: an under-backed day
        // reads NOT actionable (it must wait for bucket backing to return).
        uint256 backingLeft = s.recycleBucket;
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
                if (p.close && p.recycled <= backingLeft) {
                    backingLeft -= p.recycled;
                    amounts[i] = p.fresh + p.recycled;
                    closeable[i] = true;
                }
            }
            unchecked {
                ++i;
            }
        }
    }

    /// @notice The delivered-backing reservation for `remitId` (status 0 =
    ///         never issued, 1 = Pending, 2 = Acked, 3 = Released).
    function getRemitReservation(
        uint256 remitId
    ) external view returns (LibVaipakam.RemitReservation memory) {
        return LibVaipakam.storageSlot().remitReservations[remitId];
    }

    /// @notice Reverse index: the `remitId` bound to a CCIP `messageId`
    ///         (0 = unknown) — the operator-reconciliation entry point from
    ///         observed CCIP delivery evidence.
    function getRemitIdByMessageId(
        bytes32 messageId
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().remitIdByCcipMessageId[messageId];
    }

    /// @notice The highest `remitId` issued so far (reservations are dense:
    ///         1..nonce — the keeper's zero-RPC enumeration handle).
    function getRemitReservationNonce() external view returns (uint256) {
        return LibVaipakam.storageSlot().remitReservationNonce;
    }

    /// @notice Σ VPFI in PENDING (in-flight, un-acked) reservations to
    ///         `chainId`.
    function getRemitPendingTotal(
        uint32 chainId
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().remitPendingTotal[chainId];
    }

    /// @notice Σ VPFI in ACKED (delivery-finalized) reservations to `chainId`.
    function getRemitAckedTotal(
        uint32 chainId
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().remitAckedTotal[chainId];
    }

    /// @notice The reservation that terminally closed `(chainId, dayId)`
    ///         (0 = still open).
    function getDayClosedByRemitId(
        uint32 chainId,
        uint256 dayId
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().dayClosedByRemitId[chainId][dayId];
    }

    /// @notice Mirror-side receipt record for `remitId` (`receivedAt` 0 =
    ///         never delivered here).
    function getReceivedRemit(
        uint256 remitId
    ) external view returns (LibVaipakam.ReceivedRemit memory) {
        return LibVaipakam.storageSlot().receivedRemits[remitId];
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
        // r2 backing filter — identical to the send (see
        // {RemitSplitTotals.backingLeft}).
        uint256 backingLeft = s.recycleBucket;
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
                if (p.close && p.recycled <= backingLeft) {
                    backingLeft -= p.recycled;
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
        // r2 backing filter — identical to the send.
        uint256 backingLeft = s.recycleBucket;
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
                if (p.close && p.recycled <= backingLeft) {
                    backingLeft -= p.recycled;
                    slice = p.fresh + p.recycled;
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
        uint256 used = s.rewardBudgetRemittedGlobal + s.interactionPoolPaidOut;
        uint256 remaining = used >= LibVaipakam.VPFI_INTERACTION_POOL_CAP
            ? 0
            : LibVaipakam.VPFI_INTERACTION_POOL_CAP - used;
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
            // B2-d2 — price the WIDENED 3-tuple the send builds; the fee
            // depends on payload length, so the placeholder id (the next
            // nonce the send would draw) keeps the quote exact.
            abi.encode(fundedDays, total, s.remitReservationNonce + 1),
            tokens,
            REWARD_BUDGET_DEST_GAS_LIMIT
        );
    }

    /// @notice VPFI already remitted for `(chainId, dayId)` (0 = not sent).
    function getRewardBudgetRemitted(
        uint32 chainId,
        uint256 dayId
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().rewardBudgetRemitted[chainId][dayId];
    }

    /// @notice Cumulative VPFI remitted to `chainId` across all days.
    function getRewardBudgetRemittedTotal(
        uint32 chainId
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().rewardBudgetRemittedTotal[chainId];
    }

    /// @notice Σ VPFI remitted across every mirror.
    function getRewardBudgetRemittedGlobal() external view returns (uint256) {
        return LibVaipakam.storageSlot().rewardBudgetRemittedGlobal;
    }

    /// @notice The configured keeper EOA (address(0) = owner-only).
    function getRewardRemittanceKeeper() external view returns (address) {
        return LibVaipakam.storageSlot().rewardRemittanceKeeper;
    }

    /// @notice The mirror-side receiver authorized for {onRewardBudgetReceived}.
    function getRewardRemittanceReceiver() external view returns (address) {
        return LibVaipakam.storageSlot().rewardRemittanceReceiver;
    }

    /// @notice Cumulative VPFI reward budget received from Base on this mirror.
    function getRewardBudgetReceivedTotal() external view returns (uint256) {
        return LibVaipakam.storageSlot().rewardBudgetReceivedTotal;
    }
}
