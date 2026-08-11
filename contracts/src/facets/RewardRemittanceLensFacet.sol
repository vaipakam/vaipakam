// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {IRewardMessenger} from "../interfaces/IRewardMessenger.sol";

/**
 * @title RewardRemittanceLensFacet — the remittance ledger's READ surface.
 *
 * @notice #1434 P2-w4 — the pure-storage-read views split off
 *         {RewardRemittanceFacet} for EIP-170 headroom (the same carve the
 *         #1306 InteractionRewardsLensFacet made): the w4 supplemental +
 *         R6 gate pushed the mutating facet past the 24,576-byte limit,
 *         and the views are the clean, helper-free slice. Shares
 *         LibVaipakam storage through the Diamond; ONLY `external view`
 *         functions belong here — the quote/planner views that consult
 *         the mutating facet's private helpers stay behind.
 */
contract RewardRemittanceLensFacet {
    /// @dev The receipt key derivation — MUST stay byte-identical to
    ///      {RewardRemittanceFacet._receiptKey} (receipts are written
    ///      there and read here through the same mapping).
    function _receiptKey(
        address remitter,
        uint256 remitId
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(remitter, remitId));
    }

    /// @notice #1434 P2-w2 — a day's compensation state (pools payable at
    ///         w3's repricing; `provisional` = awaiting its V3 broadcast).
    function getDayCompensation(uint256 dayId)
        external
        view
        returns (LibVaipakam.DayCompensation memory)
    {
        return LibVaipakam.storageSlot().dayCompensation[dayId];
    }

    /// @notice #1434 P2-w2 — the arrival reservation: Σ quarantined
    ///         compensation value awaiting the R4 return, excluded from
    ///         ordinary-claim backing.
    function getStrandedRecoveryReserved() external view returns (uint256) {
        return LibVaipakam.storageSlot().strandedRecoveryReserved;
    }

    /// @notice #1434 P2-w2 — one receipt's quarantine record.
    function getStrandedRecovery(
        address remitter,
        uint256 remitId
    ) external view returns (LibVaipakam.StrandedRecovery memory) {
        return LibVaipakam.storageSlot().strandedRecoveries[
            _receiptKey(remitter, remitId)
        ];
    }

    /// @notice #1434 P2-w4 (§5.1) — the chain's outstanding compensation
    ///         reservation (0 = gate clear).
    function getCompensationOutstanding(
        uint32 chainId
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().compensationOutstanding[chainId];
    }

    /// @notice #1434 P2-w4 (§5.4 R6e) — every chain holding an
    ///         outstanding compensation reservation (the rotation
    ///         inventory; enumerable by design — the mutable destination
    ///         list would omit removed chains).
    function getCompensationOutstandingChains()
        external
        view
        returns (uint32[] memory)
    {
        return LibVaipakam.storageSlot().compensationOutstandingChains;
    }

    /// @notice #1434 P2-w4 (§2.5) — the per-side compensation funded so
    ///         far for a chain-day (manual + supplements).
    function getCompFunded(
        uint32 chainId,
        uint256 dayId
    ) external view returns (uint256 lender18, uint256 borrower18) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.compFundedLender18[chainId][dayId],
            s.compFundedBorrower18[chainId][dayId]
        );
    }

    /**
     * @notice #1434 P2-w4 (constraint-19) — paginated inventory of
     *         reservation ids that LOOK like pre-P2 legacy manual
     *         compensations: single-day, fresh-only, the day frozen-zeroed
     *         for the destination, and no per-side funded record (every
     *         post-w4 compensation stamps one). The §8 activation gate is
     *         this inventory reading EMPTY over the full id range; a
     *         Pending hit is released or allowed to resolve, a delivered
     *         one is healed mirror-side via {stampLegacyCompensation}.
     * @param  startId First reservation id to scan (ids begin at 1).
     * @param  maxCount Ids to scan this page (bounded by the nonce).
     */
    function getLegacyManualReservations(
        uint256 startId,
        uint256 maxCount
    ) external view returns (uint256[] memory ids, uint256 nextStartId) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 last = s.remitReservationNonce;
        uint256 end = startId + maxCount - 1;
        if (end > last) end = last;
        uint256[] memory buf = new uint256[](maxCount);
        uint256 n;
        for (uint256 id = startId; id <= end; ) {
            LibVaipakam.RemitReservation storage r = s.remitReservations[id];
            if (
                // #1656 r1 - Pending (1) and Acked (2) only: a RELEASED
                // reservation (3) is the documented remedy for a pending
                // legacy hit, and listing it forever would make the
                // empty-inventory activation gate unreachable.
                (r.status == 1 || r.status == 2) && r.dayIds.length == 1
                    && r.fresh == r.total && r.total != 0
            ) {
                uint256 d = r.dayIds[0];
                if (
                    s.dayZeroedForDest[d][r.dstChainId]
                        // #1656 r3 — the EXISTENCE flag, never the value
                        // pair: a post-w4 day whose severe short delivery
                        // reconciled both sides to zero is a recorded
                        // compensation, not a legacy hit (and it could
                        // never be cleared — Acked reservations cannot
                        // release and the seed refuses recorded days).
                        && !s.compFundedRecorded[r.dstChainId][d]
                ) {
                    buf[n] = id;
                    unchecked { ++n; }
                }
            }
            unchecked { ++id; }
        }
        ids = new uint256[](n);
        for (uint256 i; i < n; ) {
            ids[i] = buf[i];
            unchecked { ++i; }
        }
        nextStartId = end + 1;
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

    /**
     * @notice The released-remit stranded seed ceremony's state, for the
     *         operator deciding whether to run it and for watching one in
     *         flight.
     * @dev    #1448 r10. `recycleStrandedSeedApplied` had NO external view,
     *         so an operator could not answer "has this already run?" and had
     *         to infer it from the published figure — which is exactly the
     *         value-based reasoning that is WRONG here: a non-zero stranded
     *         total can be a post-upgrade release recorded organically, with
     *         a historical amount still unrecovered behind it. The one-shot
     *         flag is the only sound answer, so it is published.
     * @return applied        The ceremony has completed; it cannot run again.
     * @return target         The pinned range end (0 = none in flight).
     * @return cursor         How far the scan has reached.
     * @return accum          Stranded backing accumulated so far (published
     *                        only at completion).
     * @return counted        Released reservations found so far.
     * @return releasedCount  Lifetime count of releases, and the figure the
     *                        race guard pins against. On a Diamond upgraded in
     *                        place the slot is newly appended, so until the
     *                        ceremony completes this counts POST-UPGRADE
     *                        releases only; completion backfills it from the
     *                        full scan (#1448 r14). Read together with
     *                        `applied`: a true lifetime figure once that is
     *                        set, a partial one before it.
     */
    function getReleasedRemitStrandedSeedState()
        external
        view
        returns (
            bool applied,
            uint256 target,
            uint256 cursor,
            uint256 accum,
            uint256 counted,
            uint256 releasedCount
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.recycleStrandedSeedApplied,
            s.recycleStrandedSeedTarget,
            s.recycleStrandedSeedCursor,
            s.recycleStrandedSeedAccum,
            s.recycleStrandedSeedCounted,
            s.remitReleasedCount
        );
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
        address remitter,
        uint256 remitId
    ) external view returns (LibVaipakam.ReceivedRemit memory) {
        return LibVaipakam.storageSlot().receivedRemits[
            _receiptKey(remitter, remitId)
        ];
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

    /**
     * @notice #1434 P1-a — how much of the reward funding delivered to this
     *         chain counts as ARMED FRESH, and how much did not.
     * @dev    The two are returned together because either alone misleads.
     *         `counted` on its own cannot be told apart from "nothing was
     *         ever sent"; `uncounted` on its own does not say against what.
     *         Read as a pair they answer the only operational question here:
     *         is this chain's counted funding keeping up with what Base
     *         actually sent it?
     *
     *         NEITHER is a spendable balance, and neither is a bound. This
     *         is a RECEIPT-side ledger: it says what arrived and how it was
     *         attributed, not what remains. The bound it will feed — armed
     *         fresh delivered LESS armed fresh paid — needs the paid side,
     *         which lands with P1-b (see the storage docs for why the splits
     *         cannot report it today). Do not subtract
     *         `interactionPoolPaidOut` from `counted` and read the result as
     *         headroom: that cumulative also counts legacy-schedule payouts
     *         this funding never owed, and an earlier revision of this slice
     *         was withdrawn for doing exactly that (Codex #1556 r1).
     *
     *         Not applicable on the canonical chain — Base receives no
     *         remits, so both figures stay zero there regardless of how much
     *         it may legitimately pay. Base's own bound is
     *         {LibInteractionRewards.poolRemaining}.
     * @return counted   Σ fresh component of deliveries that were both
     *                   composition-known and armed-attributable.
     * @return uncounted Σ fresh-looking amount of every delivery that failed
     *                   either test. Non-zero means this chain's counted
     *                   funding UNDERSTATES what Base sent — the safe
     *                   direction, but one an operator must see.
     */
    function getDeliveredFreshPosition()
        external
        view
        returns (uint256 counted, uint256 uncounted)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        counted = s.rewardBudgetArmedFreshReceived;
        uncounted = s.rewardBudgetFreshUncounted;
    }

    /// @notice #1434 P2-w5 (§4.2) — the Base recovery position: lifetime
    ///         credited returns, lifetime uncharged re-dispatches (their
    ///         difference is the spendable position balance), and the
    ///         above-entitlement overage quarantine.
    function getRecoveryPosition()
        external
        view
        returns (uint256 recovered, uint256 redispatched, uint256 overage)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        recovered = s.rewardBudgetRecovered;
        redispatched = s.rewardBudgetRedispatched;
        overage = s.strandedReturnOverage;
    }

    /// @notice #1434 P2-w5 — how much of this reservation's entitlement a
    ///         stranded return has already credited (the bound's "already
    ///         recovered" term).
    function getRecoveredForReceipt(
        uint256 remitId
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().remitRecoveredForReceipt[remitId];
    }

    /// @notice #1434 P2-w5 — this mirror's lifetime VPFI returned to Base
    ///         by the R4 stranded return.
    function getStrandedReturnedCumulative() external view returns (uint256) {
        return LibVaipakam.storageSlot().strandedReturnedCumulative;
    }

    /// @dev Local twins of the mutating facet's errors (same selectors).
    error RewardMessengerNotSet();
    error ReceivedRemitNotFound(uint256 remitId);
    error ReceivedRemitStale(uint256 remitId, uint32 srcChainId);

    /// @notice Quote the CCIP native fee a {RewardRemittanceFacet.sendRemitAck}
    ///         for `remitId` costs. (#1660 r8 — moved here for EIP-170
    ///         headroom on the mutating facet; helper-free, view-only.)
    function quoteRemitAckFee(
        uint256 remitId,
        address remitter
    ) external view returns (uint256 fee) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address messenger = s.rewardMessenger;
        if (messenger == address(0)) revert RewardMessengerNotSet();
        LibVaipakam.ReceivedRemit storage rec =
            s.receivedRemits[_receiptKey(remitter, remitId)];
        if (rec.receivedAt == 0) revert ReceivedRemitNotFound(remitId);
        if (rec.srcChainId != s.baseChainId) {
            revert ReceivedRemitStale(remitId, rec.srcChainId);
        }
        fee = IRewardMessenger(messenger).quoteSendRemitAck(
            remitId, rec.amount, rec.remitter
        );
    }

    /// @notice #1660 r1 — this receipt's recorded B1 transport shortfall
    ///         (declared minus actual, cumulative): value the mirror's
    ///         retired one-shot record can never re-send — transport
    ///         loss awaiting the R6d loss ceremony, not recoverable
    ///         entitlement.
    function getStrandedReturnShortfall(
        uint256 remitId
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().strandedReturnShortfall[remitId];
    }
}
