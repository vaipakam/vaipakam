// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {LibRewardCustody} from "../libraries/LibRewardCustody.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {IRewardMessenger} from "../interfaces/IRewardMessenger.sol";
import {ICrossChainMessenger} from "../crosschain/ICrossChainMessenger.sol";
import {LibVpfiLane} from "../libraries/LibVpfiLane.sol";
import {RateLimiter} from "@chainlink/contracts-ccip/contracts/libraries/RateLimiter.sol";

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
            LibRewardCustody.remitReceiptKey(remitter, remitId)
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

    /**
     * @notice The remote adapter remit `remitId` was bound to, beside the one
     *         a remit to the same destination would be bound to now.
     * @dev    #2561. `sentMessenger` is recorded at dispatch: the adapter on
     *         the destination chain the message was addressed to, which is
     *         where it executes, whatever the lane points at later (the
     *         handler behind it is resolved there at execution).
     *         `liveMessenger` is what the messenger names for that chain right
     *         now. When they differ, the destination was redeployed after the
     *         send: the message executes, if at all, behind the old adapter,
     *         whose acknowledgement Base no longer authenticates, and the
     *         reservation needs an operator decision on evidence
     *         (`finalizeRemitReservation` only when the destination receipt
     *         shows the remittance consumed, since it attests consumption
     *         with a zero received figure and clears any compensation gate;
     *         `releaseRemitReservation` when it will never execute).
     *
     *         Both are zero for a `remitId` never issued. `sentMessenger` is
     *         also zero for a remit dispatched before the route was recorded:
     *         the route is then UNKNOWN, which is not the same as "unchanged".
     *         `liveMessenger` is zero when no messenger is configured, or it
     *         names no adapter for the destination.
     */
    function getRemitRoute(
        uint256 remitId
    ) external view returns (address sentMessenger, address liveMessenger) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        sentMessenger = s.remitRemoteMessenger[remitId];
        uint32 dstChainId = s.remitReservations[remitId].dstChainId;
        address messenger = s.crossChainMessenger;
        if (dstChainId != 0 && messenger != address(0)) {
            liveMessenger = ICrossChainMessenger(messenger).remoteMessengerOf(dstChainId);
        }
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

    /// @notice #1452 — the recycled share of every remittance to `chainId` that
    ///         Base saw ACKNOWLEDGED, and apart from it the share of FORCED
    ///         finalizations. The destination must have relocated at least
    ///         `acked` as delivered custody; the mesh watcher checks it.
    function getChainRemittedRecycled(uint32 chainId)
        external
        view
        returns (uint256 acked, uint256 forceFinalized)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (s.chainRemittedRecycledAcked[chainId], s.chainRemittedRecycledForceFinalized[chainId]);
    }

    /// @notice Σ VPFI in ACKED (delivery-finalized) reservations to `chainId`.
    function getRemitAckedTotal(
        uint32 chainId
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().remitAckedTotal[chainId];
    }

    /// @notice The reservation that terminally closed `(chainId, dayId)`
    ///         (0 = still open). #918: on a day sent in parts, the part that
    ///         completed it; 0 while any of its slice is still owed.
    function getDayClosedByRemitId(
        uint32 chainId,
        uint256 dayId
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().dayClosedByRemitId[chainId][dayId];
    }

    /// @notice #918 — Base's remit ledger for `(chainId, dayId)`: the day's
    ///         whole slice (locked at its first part), what its live parts have
    ///         sent, and which part retired its clamp residual. All zero, with
    ///         `locked` false, until a part is sent. See
    ///         {LibVaipakam.RemitDayLedger}.
    function getRemitDayLedger(
        uint32 chainId,
        uint256 dayId
    ) external view returns (LibVaipakam.RemitDayLedger memory) {
        return LibVaipakam.storageSlot().remitDayLedger[chainId][dayId];
    }

    /// @notice #918 — the live outbound VPFI CCIP lane bucket toward
    ///         `chainId`: how much one remittance part can move there right now.
    /// @dev    Resolved by the same rule the repatriation bounds enforce
    ///         ({LibVpfiLane.liveBucket}). `readable` false means a rung is
    ///         missing (no registry or messenger configured, no pool for the
    ///         token, or a lane the pool does not carry) and nothing is known
    ///         about the bucket — never that it is unlimited. `limited` false
    ///         on a readable lane means the pool's limiter is disabled, so the
    ///         lane imposes no bound.
    /// @return readable The lane resolved.
    /// @return limited  The lane's outbound limiter is enabled.
    /// @return tokens   The bucket's tokens, refilled to this block.
    /// @return capacity The bucket's capacity.
    function getRemitLaneBucket(uint32 chainId)
        external
        view
        returns (bool readable, bool limited, uint256 tokens, uint256 capacity)
    {
        (LibVpfiLane.LaneStatus status, RateLimiter.TokenBucket memory b) =
            LibVpfiLane.liveBucket(LibVaipakam.storageSlot(), chainId, false);
        if (status != LibVpfiLane.LaneStatus.Read) return (false, false, 0, 0);
        return (true, b.isEnabled, b.tokens, b.capacity);
    }

    /// @notice Mirror-side receipt record for `remitId` (`receivedAt` 0 =
    ///         never delivered here).
    function getReceivedRemit(
        address remitter,
        uint256 remitId
    ) external view returns (LibVaipakam.ReceivedRemit memory) {
        return LibVaipakam.storageSlot().receivedRemits[
            LibRewardCustody.remitReceiptKey(remitter, remitId)
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

    /// @notice The mirror-side receiver authorized for the budget and
    ///         compensation ingresses.
    function getRewardRemittanceReceiver() external view returns (address) {
        return LibVaipakam.storageSlot().rewardRemittanceReceiver;
    }

    /// @notice Cumulative VPFI reward budget received from Base on this mirror.
    function getRewardBudgetReceivedTotal() external view returns (uint256) {
        return LibVaipakam.storageSlot().rewardBudgetReceivedTotal;
    }

    /**
     * @notice #1434 P1-b (Codex #1699 r1) — the PAID side of the
     *         delivered-fresh bound, and the allowance that remains.
     * @dev    A NEW selector rather than a third return on
     *         {getDeliveredFreshPosition}: widening an existing return keeps
     *         the same selector while changing the decode, which is the
     *         silent-drift failure mode an ABI-supplied client cannot see.
     *
     *         `remaining` is the SATURATING difference, and reading it here
     *         rather than differencing the two figures by hand is the point:
     *         the received side is not monotone (it carries an unwind for a
     *         released or reclassified delivery), so `paid` can legitimately
     *         exceed it and a hand-rolled subtraction would underflow.
     *
     *         Zero `remaining` has TWO meanings, and the reward role
     *         ({RewardReporterFacet.getRewardRole}) tells them apart:
     *           - on a `Mirror` it means armed-day payouts WAIT on this
     *             chain — a satisfiable wait that the next remittance
     *             clears, not an exhausted cap;
     *           - on a `Detached` chain (#1566 closure 3) it is ROLE-ENFORCED:
     *             no remittance can raise it while the role stays Detached,
     *             because the chain has no authenticated source of further
     *             delivery. Recovery is re-attachment (`setBaseChainId`),
     *             not funding — a remittance sent to a Detached chain
     *             changes nothing this lens reports.
     *         On the canonical chain, and on an `Unconfigured` one, the
     *         bound does not apply and `remaining` reads
     *         `type(uint256).max`.
     * @return paid      Fresh reward value this chain has paid out of its
     *                   delivered funding, whatever the day's vintage
     *                   (#1566 closure 2 — charged at the claim's delivery
     *                   and at the reward-absorption credit, never per day
     *                   inside the walk). The field keeps its historical
     *                   "Armed" name; renaming a storage field is a layout
     *                   event the provenance walker gates on.
     * @return remaining Delivered-less-paid allowance still spendable — and
     *                   since 3b-ii-A2 (#2305) less what staging records have
     *                   RESERVED of it as well, which `paid` does not carry;
     *                   the reserved figure itself is on
     *                   {InteractionRewardsLensFacet.getRewardReservations}
     *                   (Codex #2308 r5).
     */
    function getDeliveredFreshBound()
        external
        view
        returns (uint256 paid, uint256 remaining)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        paid = s.rewardBudgetArmedFreshPaid;
        remaining = LibInteractionRewards.deliveredFreshBound(s);
    }

    /**
     * @notice #1944 consequence 1 — whether day `dayId` is priced to owe
     *         FRESH reward value on this chain for `side` (0 lender,
     *         1 borrower, 2 either) while no delivery proven to list it has
     *         landed here. True means every pricing path on this mirror
     *         holds the day — the cursors halt before it and every
     *         settlement defers by name — until the proof lands.
     * @dev    THE self-staticcall target of
     *         {LibRewardCustody.callDayAwaitsFreshDelivery}. The rule is
     *         inlined HERE, once, instead of into the five walk facets that
     *         price days: they sit within a few hundred bytes of EIP-170 and
     *         each carries only the cheap prefix (gate dark, day below the
     *         gate, day landed) plus this call. The body is the library rule
     *         verbatim, so the view and the rung cannot disagree.
     *
     *         ROUTING IS LOAD-BEARING on every mirror: the gate binds by
     *         role from the first priced day (#1944, no arming step), so an
     *         unrouted selector on a mirror turns every claim, sweep and
     *         staging call into a bubbled `FunctionDoesNotExist`. Off a mirror
     *         the caller's prefix returns before the call. Deploy and refresh
     *         this facet together with the walk facets. Reads only.
     */
    function dayAwaitsFreshDelivery(uint8 side, uint256 dayId) external view returns (bool) {
        return LibRewardCustody.dayAwaitsFreshDelivery(LibVaipakam.storageSlot(), side, dayId);
    }

    /**
     * @notice #1944 consequence 1 — the operator's readback of one day's
     *         delivery gate on this chain, every input of
     *         {dayAwaitsFreshDelivery} beside its verdict.
     * @dev    Read the state off the tuple, in this order: NotApplied
     *         (`!stamped` — Base's broadcast has not priced the day here);
     *         Landed (`landed`); AwaitingReport (`reportSent == false` on an
     *         armed day that awaits — Base itself waits for the mirror's
     *         commitment report before it plans the fresh leg);
     *         AwaitingDelivery (any other day that awaits); Open (nothing
     *         awaits — the day owes no fresh value here, or the gate does not
     *         bind it). The figures are returned raw rather than as an enum
     *         so a state added later cannot be mis-decoded by an old reader.
     * @return gateBinds     The gate binds on this chain: it is a reward-mesh
     *                       Mirror. The gate binds by role on every day, with
     *                       no arming step (#1944).
     * @return stamped       Base's per-chain funding stamp for the day has
     *                       landed here.
     * @return freshStamped  That stamp prices a non-zero FRESH half for
     *                       either side.
     * @return landed        The day's whole slice has landed here: the parts
     *                       counted toward it (indexed or proven) sum, per
     *                       component, to the whole Base declared (#918).
     * @return firstPart     The first packet counted toward the day, by
     *                       either route (zero before any part has landed).
     *                       The full per-day record is {getDayDeliveryParts}.
     * @return epochCount    Transport epochs indexed under the day.
     * @return reported      This chain's day report has been sent to Base.
     * @return reportSent    The day's commitment report has been sent.
     * @return awaitsLender  {dayAwaitsFreshDelivery} for the lender side.
     * @return awaitsBorrower {dayAwaitsFreshDelivery} for the borrower side.
     */
    function getDayDeliveryState(uint256 dayId)
        external
        view
        returns (
            bool gateBinds,
            bool stamped,
            bool freshStamped,
            bool landed,
            bytes32 firstPart,
            uint256 epochCount,
            bool reported,
            bool reportSent,
            bool awaitsLender,
            bool awaitsBorrower
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        gateBinds = LibVaipakam.rewardRole(s) == LibVaipakam.RewardRole.Mirror;
        {
            LibVaipakam.ChainDayFunding storage f = s.chainDayRecycledFunding[dayId][uint32(block.chainid)];
            stamped = f.stamped;
            freshStamped = stamped && (f.freshLenderHalf != 0 || f.freshBorrowerHalf != 0);
        }
        landed = LibRewardCustody.dayDeliveryLanded(s, dayId);
        firstPart = s.dayDeliveryParts[dayId].firstPacket;
        epochCount = s.transportBatchesByDay[dayId].length;
        reported = s.chainReportSentAt[dayId] != 0;
        reportSent = s.commitmentReportSent[dayId];
        awaitsLender = LibRewardCustody.dayAwaitsFreshDelivery(s, 0, dayId);
        awaitsBorrower = LibRewardCustody.dayAwaitsFreshDelivery(s, 1, dayId);
    }

    /// @notice #918 — this mirror's delivery record for `dayId`: the whole slice
    ///         Base declared, the parts landed so far summed per component, when
    ///         the day landed (0 = not yet), how many parts were counted, whether
    ///         a part declared a different whole, and the first packet counted.
    ///         See {LibVaipakam.DayDeliveryParts}.
    function getDayDeliveryParts(uint256 dayId)
        external
        view
        returns (LibVaipakam.DayDeliveryParts memory)
    {
        return LibVaipakam.storageSlot().dayDeliveryParts[dayId];
    }

    /**
     * @notice #1944 consequence 1 — which proof route a landed packet takes,
     *         and whether it is refused: `batched` → the batch materializers;
     *         else `dayListRoot != 0` → {RewardEpochFacet.proveDeliveryDayChunk};
     *         else nothing to prove (a compensation, which funds no listed
     *         day). `disposed != 0` is refused. (No packet is quarantined since the custody-era
     *         revision, so the flag that read it is gone.)
     * @dev    A narrow read of existing packet fields rather than the whole
     *         {getIngressPacket} record: the keeper's proof step needs only
     *         these, and a fixed tuple keeps its decode stable when the
     *         append-only packet struct's tail widens. Nothing new is stored.
     * @return dayListRoot         The rooted (d6) commitment (0 = none).
     * @return chunkCount          The rooted list's chunk count.
     * @return chunksIndexed       Bit `i` set = chunk `i` proven.
     * @return batched             The packet holds a transport batch.
     * @return classificationFinal Its classification is final.
     * @return disposed            Value disposed of by a non-classification exit.
     */
    function getPacketDeliveryProof(bytes32 packetHash)
        external
        view
        returns (
            bytes32 dayListRoot,
            uint32 chunkCount,
            uint256 chunksIndexed,
            bool batched,
            bool classificationFinal,
            uint256 disposed
        )
    {
        LibVaipakam.IngressPacket storage p = LibVaipakam.storageSlot().ingressPackets[packetHash];
        return (
            p.dayListRoot,
            p.chunkCount,
            p.chunksIndexed,
            p.batchId != bytes32(0),
            p.classificationFinal,
            p.disposed
        );
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
     *         attributed, not what remains. The bound it feeds — armed fresh
     *         delivered LESS armed fresh paid — is live as of #1434 P1-b,
     *         which added the paid side (`rewardBudgetArmedFreshPaid`); read
     *         it via {LibInteractionRewards.deliveredFreshBound}, which
     *         saturates because the received side is not monotone. Do not
     *         subtract
     *         `interactionPoolPaidOut` from `counted` and read the result as
     *         headroom: that cumulative also counts legacy-schedule payouts
     *         this funding never owed, and an earlier revision of this slice
     *         was withdrawn for doing exactly that (Codex #1556 r1).
     *
     *         Not applicable on the canonical chain — Base receives no
     *         remits, so both figures stay zero there regardless of how much
     *         it may legitimately pay. Base's own bound is
     *         {LibInteractionRewards.poolRemaining}.
     * @return counted   Σ authenticated fresh component of every
     *                   composition-known delivery, whatever days it funds —
     *                   never an in-holder re-credit (an era release, a
     *                   surplus drain), whose value was counted at delivery
     *                   (#1566 closure 2 retired the armed-attributable
     *                   test; the paid side is vintage-blind, so the
     *                   received side is too).
     * @return uncounted Σ fresh-looking value this chain did not count: a
     *                   delivery held as a transport epoch lands here whole
     *                   until its draws type it, and quarantined compensation
     *                   or a demoted provisional hold lands here until its
     *                   return. A typed (pre-activation) delivery contributes
     *                   nothing: the receiver sends the fresh share as what
     *                   actually landed less the scaled recycled share, and
     *                   the ingress refuses any split that is not whole
     *                   (#2910), so no residue is left uncounted. Non-zero
     *                   means this chain's counted funding UNDERSTATES what
     *                   Base sent — the safe direction, but one an operator
     *                   must read with those sources in mind.
     */
    function getDeliveredFreshPosition()
        external
        view
        returns (uint256 counted, uint256 uncounted)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Net of the in-holder re-credits (#1566 PR 1 review): an era release
        // or a surplus drain raises the received side as headroom, but its
        // value was counted at its delivery. Saturating: a reconciliation
        // correction may lower the received side below the tally (a demotion
        // no longer does — it releases a provisional hold, never counted,
        // #2459 r5).
        uint256 received = s.rewardBudgetArmedFreshReceived;
        uint256 reCredited = s.rewardBudgetFreshReCredited;
        counted = received > reCredited ? received - reCredited : 0;
        uncounted = s.rewardBudgetFreshUncounted;
    }

    /// @notice #2459 r5 — the provisional compensation value HELD APART: counted
    ///         by neither figure of {getDeliveredFreshPosition} until the day's
    ///         broadcast confirms (counted) or demotes (uncounted) it, so what the
    ///         canonical chain sent reconciles as counted + uncounted + this. In
    ///         custody it is the `Provisional` row; a hold made before custody
    ///         activation rests at the Diamond.
    function getProvisionalFreshHeld() external view returns (uint256) {
        return LibVaipakam.storageSlot().rewardBudgetFreshProvisional;
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

    /// @notice #1434 P2-w6 (§5.3) — governance-recorded terminal loss for
    ///         a released reservation's stranded value (one term of the
    ///         custody-resolution identity the R6 gate clears on).
    function getCeremonyTerminalLoss(
        uint256 remitId
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().ceremonyTerminalLoss[remitId];
    }

    /// @notice #1434 P2-w6 (#1662 r1) — the per-receipt ceremony-recovered
    ///         cumulatives BY PROVENANCE component. Each is bounded by the
    ///         reservation's own dispatched split, and the recycled figure
    ///         is what the consumed-ack claw excludes from the position
    ///         debit (#1662 r2).
    function getCeremonyRecovered(
        uint256 remitId
    ) external view returns (uint256 fresh, uint256 recycled) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.ceremonyFreshRecovered[remitId],
            s.ceremonyRecycledRecovered[remitId]
        );
    }

    /// @notice #1434 P2-w6 (#1662 r2) — the per-receipt TERMINAL-LOSS
    ///         split by provenance. Their sum is {getCeremonyTerminalLoss};
    ///         the recycled half is what leaves the coverage allowance.
    function getCeremonyLoss(
        uint256 remitId
    ) external view returns (uint256 fresh, uint256 recycled) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.ceremonyFreshLoss[remitId],
            s.ceremonyRecycledLoss[remitId]
        );
    }

    /// @notice #1434 P2-w6 (#1662 r2) — the uncharged re-dispatch already
    ///         drawn against this receipt's own recovery credit, and the
    ///         credit itself (the fresh-provenance part of what it
    ///         recovered — the recycled half went to bucket custody, not
    ///         to the position). Their difference is the receipt's
    ///         UNSPENT capacity: what a further from-recovery dispatch may
    ///         draw, and the most a contradicting consumed ack may claw.
    /// @dev `clawed` (#1662 r3) — credit VOIDED by a contradicting
    ///      consumed attestation. Unspent capacity is
    ///      `credit − redispatched − clawed`; the clawed term is what
    ///      stops confiscated credit becoming spendable again once
    ///      another receipt replenishes the pooled position.
    function getRecoveryCreditForReceipt(
        uint256 remitId
    )
        external
        view
        returns (uint256 credit, uint256 redispatched, uint256 clawed)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 c = s.remitRecoveredForReceipt[remitId]
            - s.ceremonyRecycledRecovered[remitId];
        return (
            c,
            s.recoveryRedispatchedForReceipt[remitId],
            s.recoveryClawedForReceipt[remitId]
        );
    }

    /// @notice #1434 P2-w6 (§5.4 R6e, reshaped #1662 r1) — the imported
    ///         old-era outstanding record for a chain (zero remitter =
    ///         none).
    function getImportedOutstanding(
        uint32 dstChainId
    )
        external
        view
        returns (address oldRemitter, uint256 oldRemitId)
    {
        LibVaipakam.ImportedOutstanding storage im =
            LibVaipakam.storageSlot().importedOutstanding[dstChainId];
        return (im.oldRemitter, im.oldRemitId);
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
            s.receivedRemits[LibRewardCustody.remitReceiptKey(remitter, remitId)];
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

    /// @notice #1566 closure 2 cutover PR 1 — a value-bearing reward packet
    ///         as it LANDED, by its ingress stamp
    ///         `keccak256(sourceChainId, transportMessageId)` (or the
    ///         per-source sequence a transport without an id fell back to).
    ///         `unclassified` is what the packet still holds in the holder's
    ///         `Unclassified` row. An unknown stamp reads as all zeros
    ///         (`arrivedAt == 0`).
    function getIngressPacket(
        bytes32 packetHash
    ) external view returns (LibVaipakam.IngressPacket memory) {
        return LibVaipakam.storageSlot().ingressPackets[packetHash];
    }

    /// @notice #1566 closure 2 cutover PR 1 — the UNCLASSIFIED ingress
    ///         attribution's figures, the way every custody row is
    ///         auditable: `uncountedHeld` equals the holder's
    ///         `Unclassified` row, and `reservedHeld` is the part of the
    ///         stranded-recovery reservation whose tokens are in the holder
    ///         (the Diamond's backing position subtracts only the rest).
    /// @return uncountedHeld Untyped delivery remainders and quarantined
    ///         compensation held in the row, net of R4 returns.
    /// @return reservedHeld  The held part of `strandedRecoveryReserved`.
    function getUnclassifiedPosition()
        external
        view
        returns (uint256 uncountedHeld, uint256 reservedHeld)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uncountedHeld = s.rewardCustodyUnclassifiedUncounted;
        reservedHeld = s.strandedRecoveryReservedHeld;
    }
}
