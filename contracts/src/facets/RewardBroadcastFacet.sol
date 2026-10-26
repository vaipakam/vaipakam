// src/facets/RewardBroadcastFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IRewardMessenger} from "../interfaces/IRewardMessenger.sol";

/**
 * @title  RewardBroadcastFacet
 * @notice Ships a FINALIZED day's frozen figures to every mirror, and quotes
 *         what that will cost. Lifecycle step 4 of the reward day: report →
 *         finalize → stamp → BROADCAST.
 *
 * @dev    SPLIT FROM {RewardAggregatorFacet} (#1569) for EIP-170 headroom,
 *         along a seam that facet's own header already drew. It described
 *         broadcast as a separate step "so finalization stays cheap and a
 *         cross-chain outage on one destination can be retried independently",
 *         and the code carried a `Broadcast trigger` section divider at the
 *         exact line this file begins. So this does not introduce a boundary;
 *         it moves an implementation to the other side of one that was already
 *         there — the #1835 rule.
 *
 *         WHY IT HAD TO MOVE. `RewardAggregatorFacet` reached 24,544 bytes,
 *         leaving **32** under the 24,576-byte limit. That is far less than one
 *         cross-facet call, so the next behavioural change to anything it hosts
 *         was undeployable — the same condition that forced #1780's
 *         `EarlyWithdrawalFacet` split at 30 bytes and #1835's
 *         `OfferAcceptFacet` split at 164. It surfaced when arming the #1569
 *         keeper allocation, whose ~96 bytes of stamping did not fit.
 *
 *         WHY THIS SEAM AND NOT ANOTHER. Every helper here is `private` and
 *         reached only from these four entry points; nothing outside the
 *         cluster calls them and they call nothing outside it. No event or
 *         error is declared in the region — every revert resolves to
 *         {IVaipakamErrors}. So the move duplicates nothing.
 *
 *         Two alternatives were considered and rejected. Splitting the READ
 *         surface (the lens pattern) yields less and would separate
 *         `getChainSurplusPosition`, a guarded view, from the knob that sets
 *         what it reads. Splitting FINALIZATION would free more — it is what
 *         pulls in `LibMeshFunding` — but `finalizeDay` is the facet's
 *         namesake, emits four events declared there, and shares its grace
 *         constant with `isDayReadyToFinalize`; moving it crosses a boundary
 *         it does not already sit on.
 *
 *         SENDS AND QUOTES MOVED TOGETHER, deliberately. `_assembleDayV2`,
 *         `_dayExtras` and `_toV3PerDest` are shared between the payable sends
 *         and the view quotes precisely so the two can never price different
 *         payloads (Codex #1417 r1). Splitting read-from-write *inside* this
 *         cluster would duplicate them and re-open that divergence.
 *
 *         STORAGE AND SELECTORS ARE UNCHANGED. Both facets read the same
 *         {LibVaipakam} slot, and a 4-byte selector derives from the signature
 *         rather than the host contract — so the Diamond routes the same
 *         selectors to a different address. Nothing off-chain re-points.
 */
contract RewardBroadcastFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    /// @dev Copied from {RewardAggregatorFacet}: broadcast is canonical-only,
    ///      and the check is two lines. Sharing it would mean a cross-facet
    ///      call to read one storage flag.
    function _checkCanonical() private view {
        if (!LibVaipakam.storageSlot().isCanonicalRewardChain) {
            revert NotCanonicalRewardChain();
        }
    }

    modifier onlyCanonical() {
        _checkCanonical();
        _;
    }

    /**
     * @notice Ship the finalized `(globalLender, globalBorrower)` pair
     *         for `dayId` to every mirror via the registered messenger.
     * @dev Payable, permissionless. `msg.value` must cover the sum of
     *      per-destination CCIP native fees — quote first via
     *      {quoteBroadcastGlobal}. Leftover refunds to the caller.
     *
     *      Separated from {finalizeDay} so finalization stays cheap and
     *      a CCIP outage on one destination can be retried independently
     *      from another via a follow-up call.
     *
     *      ONE WIRE (#1944). The day ships as the kind-10 message only: the
     *      V2 figures plus the day's frozen clock facts. The kind-5 and
     *      kind-2 fallbacks are gone. They existed for a messenger proxy
     *      upgraded in place from before those wires and for a day
     *      finalized before the clock was frozen, and every chain gets a
     *      fresh deploy (owner decision O1 = A), so neither case can
     *      arise: {RewardAggregatorFacet.finalizeDay} is the only writer of
     *      `dailyGlobalFinalized` and freezes the clock in the same call.
     * @param dayId Day whose finalized pair to broadcast.
     */
    function broadcastGlobal(
        uint256 dayId
    ) external payable nonReentrant whenNotPaused onlyCanonical {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.dailyGlobalFinalized[dayId]) revert DayNotReadyToFinalize();
        address messenger = s.rewardMessenger;
        if (messenger == address(0)) revert RewardMessengerNotSet();

        (
            IRewardMessenger.BroadcastV2Shared memory shared,
            IRewardMessenger.BroadcastV2PerDest[] memory perDest
        ) = _assembleDayV2(
            s, dayId, IRewardMessenger(messenger).getBroadcastDestinations()
        );
        IRewardMessenger(messenger).broadcastDayV3{value: msg.value}(
            shared,
            _dayExtras(s, dayId),
            _toV3PerDest(s, dayId, perDest),
            payable(msg.sender)
        );
    }

    /// @notice B2-b (Codex #1417 r1) — quote the fee the PERMISSIONLESS
    ///         {broadcastGlobal} trigger will actually pay: assembles the
    ///         SAME per-destination payloads as the send and quotes them
    ///         through the messenger, so the quote can never price a
    ///         different payload than the send dispatches.
    function quoteBroadcastGlobal(uint256 dayId)
        external
        view
        returns (uint256 nativeFee)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.dailyGlobalFinalized[dayId]) revert DayNotReadyToFinalize();
        address messenger = s.rewardMessenger;
        if (messenger == address(0)) revert RewardMessengerNotSet();

        (
            IRewardMessenger.BroadcastV2Shared memory shared,
            IRewardMessenger.BroadcastV2PerDest[] memory perDest
        ) = _assembleDayV2(
            s, dayId, IRewardMessenger(messenger).getBroadcastDestinations()
        );
        return IRewardMessenger(messenger).quoteBroadcastDayV3(
            shared, _dayExtras(s, dayId), _toV3PerDest(s, dayId, perDest)
        );
    }

    /// @notice #1434 P2-w1 — the single-destination V3 heal: re-deliver day
    ///         `dayId`'s frozen clock facts (plus the full V2 figures) to
    ///         ONE destination. Permissionless and repeatable, exactly like
    ///         {broadcastGlobal} — the payload is assembled from the same
    ///         frozen state, so a re-send is byte-identical and the mirror
    ///         ingress is idempotent.
    /// @dev    Exists because {broadcastGlobal} enumerates the messenger's
    ///         CURRENT destination list: a mirror removed from that list
    ///         after the day finalized, whose first delivery failed, could
    ///         otherwise never receive the day at all (design §1.1). Admission is day-scoped
    ///         historical standing — included in the day's finalized
    ///         denominator, or holding any chain-day commitments record
    ///         (complete report, remit-ineligible marking, or a reported
    ///         liability) — NOT current-list membership. A chain with
    ///         neither has no stake in the day and cannot be used to spray
    ///         arbitrary lanes. If the LANE itself is torn down, the
    ///         underlying CCIP messenger reverts — the operator
    ///         decommissioning boundary stated in the design.
    /// @param dayId       The finalized day to heal.
    /// @param destChainId The destination chain (uint32-bounded).
    function broadcastGlobalTo(
        uint256 dayId,
        uint256 destChainId
    ) external payable nonReentrant whenNotPaused onlyCanonical {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.dailyGlobalFinalized[dayId]) revert DayNotReadyToFinalize();
        address messenger = s.rewardMessenger;
        if (messenger == address(0)) revert RewardMessengerNotSet();
        _assertDayStanding(s, dayId, destChainId);

        uint256[] memory one = new uint256[](1);
        one[0] = destChainId;
        (
            IRewardMessenger.BroadcastV2Shared memory shared,
            IRewardMessenger.BroadcastV2PerDest[] memory perDest
        ) = _assembleDayV2(s, dayId, one);

        IRewardMessenger(messenger).broadcastDayV3Single{value: msg.value}(
            shared,
            _dayExtras(s, dayId),
            _toV3PerDest(s, dayId, perDest)[0],
            payable(msg.sender)
        );
    }

    /// @notice #1434 P2-w1 — quote the fee {broadcastGlobalTo} will pay.
    ///         Same admission checks as the send, so quoting a
    ///         non-admissible heal fails the same way the send would.
    function quoteBroadcastGlobalTo(
        uint256 dayId,
        uint256 destChainId
    ) external view returns (uint256 nativeFee) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.dailyGlobalFinalized[dayId]) revert DayNotReadyToFinalize();
        address messenger = s.rewardMessenger;
        if (messenger == address(0)) revert RewardMessengerNotSet();
        _assertDayStanding(s, dayId, destChainId);

        uint256[] memory one = new uint256[](1);
        one[0] = destChainId;
        (
            IRewardMessenger.BroadcastV2Shared memory shared,
            IRewardMessenger.BroadcastV2PerDest[] memory perDest
        ) = _assembleDayV2(s, dayId, one);

        return IRewardMessenger(messenger).quoteBroadcastDayV3Single(
            shared, _dayExtras(s, dayId), _toV3PerDest(s, dayId, perDest)[0]
        );
    }

    /// @dev #1434 P2-w1 — the heal's admission gate: day-scoped historical
    ///      standing. A destination wider than uint32 can hold no standing
    ///      (every per-chain ledger is keyed uint32), so it fails here too.
    ///      Own frame for viaIR stack headroom.
    function _assertDayStanding(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        uint256 destChainId
    ) private view {
        if (destChainId <= type(uint32).max && destChainId != block.chainid) {
            uint32 dest = uint32(destChainId);
            LibVaipakam.ChainDayCommitments storage c =
                s.chainDayCommitments[dayId][dest];
            // Codex #1632 r3 P1 — the FROZEN zeroed marker is part of the
            // standing predicate: `remitIneligible` is operator-clearable
            // (reconciliation), so a zeroed destination that was reconciled
            // and then removed from the destination list would otherwise
            // lose its heal eligibility — the exact chain the heal exists
            // for. The frozen copy never clears, so standing survives.
            if (
                s.chainDailyIncluded[dayId][dest] || c.complete
                    || c.remitIneligible || c.liabilityLender18 != 0
                    || c.liabilityBorrower18 != 0
                    || s.dayZeroedForDest[dayId][dest]
            ) {
                return;
            }
        }
        revert DestinationHasNoDayStanding(dayId, destChainId);
    }

    // #1434 P2-w1 — the versioned lapse-schedule setter and the day-clock
    // read views live in {RewardCommitmentFacet}, NOT here: this facet sits
    // ~500 bytes under the EIP-170 ceiling and the commitment facet (which
    // already owns the day-scoped reconciliation surface the frozen zeroed
    // marker exists to be compared against) has ~20KB of headroom.

    /// @dev B2-b — assemble the per-destination V2 fields the kind-10 wire
    ///      nests: the
    ///      day-shared consensus fields once, each destination's OWN funded
    ///      figures from its finalize-time stamp. A destination the mesh
    ///      resolver skipped (unarmed day / no coupled target) gets the
    ///      global fresh floor halves and zeroed recycled fields — exactly
    ///      what the remit sizing assumes for it. Shared by the send AND
    ///      the facet-level quote so the two can never price different
    ///      payloads (Codex #1417 r1).
    function _assembleDayV2(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        uint256[] memory dests
    )
        private
        view
        returns (
            IRewardMessenger.BroadcastV2Shared memory shared,
            IRewardMessenger.BroadcastV2PerDest[] memory perDest
        )
    {
        uint256 armedFrom = s.governorCommitArmedFromDay;
        bool armed = armedFrom != 0 && dayId >= armedFrom;
        shared = IRewardMessenger.BroadcastV2Shared({
            dayId: dayId,
            globalLenderNumeraire18: s.dailyGlobalLenderInterestNumeraire18[
                dayId
            ],
            globalBorrowerNumeraire18: s
                .dailyGlobalBorrowerInterestNumeraire18[dayId],
            capMode: armed
                ? uint8(LibVaipakam.CapMode.ShareOfPool)
                : uint8(LibVaipakam.CapMode.LegacyEthRatio),
            // ShareOfPool: the per-SIDE D1 ceilings (global figures, Base-
            // computed). Legacy: the §4 threshold rides the lender slot.
            capPayloadLender: armed
                ? s.dayUserSideCapLenderVpfi18[dayId]
                : s.dayCapThreshold18[dayId],
            capPayloadBorrower: armed
                ? s.dayUserSideCapBorrowerVpfi18[dayId]
                : 0,
            armedFromDay: armedFrom
        });

        uint256 n = dests.length;
        perDest = new IRewardMessenger.BroadcastV2PerDest[](n);
        uint256 floorHalf = uint256(s.dayPoolStamp[dayId].scheduleFloor) / 2;
        for (uint256 i; i < n; ++i) {
            perDest[i] = _perDestFields(s, dayId, dests[i], floorHalf);
        }
    }

    /// @dev #1434 P2-w1 — the day's frozen clock facts, read back verbatim
    ///      from the finalization-time freeze (never recomputed — R2a).
    ///      #1636 r2 — plus the day-level funded pool halves from the same
    ///      freeze (`dayPoolStamp`, written by finalize): the Δq quote
    ///      numerator, which a zeroed destination cannot derive from its
    ///      own deliberately-zero slice.
    function _dayExtras(
        LibVaipakam.Storage storage s,
        uint256 dayId
    ) private view returns (IRewardMessenger.BroadcastV3Extras memory) {
        LibVaipakam.DayLapseClock storage c = s.dayLapseClock[dayId];
        LibVaipakam.DayPoolStamp storage p = s.dayPoolStamp[dayId];
        return IRewardMessenger.BroadcastV3Extras({
            finalizedAt: c.finalizedAt,
            lapseScheduleVersion: c.scheduleVersion,
            lapseWindowSeconds: c.lapseWindowSeconds,
            dispatchCutoffGap: c.dispatchCutoffGap,
            dayScheduleFloorHalf: uint256(p.scheduleFloor) / 2,
            dayRecycledBudgetHalf: uint256(p.recycledBudget) / 2
        });
    }

    /// @dev #1434 P2-w1 — wrap the assembled V2 per-destination entries with
    ///      each destination's FROZEN zeroed marker (never the live
    ///      `remitIneligible`, which reconciliation can clear between two
    ///      sends of the same day).
    function _toV3PerDest(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        IRewardMessenger.BroadcastV2PerDest[] memory perDest
    ) private view returns (IRewardMessenger.BroadcastV3PerDest[] memory) {
        uint256 n = perDest.length;
        IRewardMessenger.BroadcastV3PerDest[] memory v3 =
            new IRewardMessenger.BroadcastV3PerDest[](n);
        for (uint256 i; i < n; ++i) {
            v3[i] = IRewardMessenger.BroadcastV3PerDest({
                base: perDest[i],
                zeroedForDest: s.dayZeroedForDest[dayId][
                    uint32(perDest[i].destChainId)
                ]
            });
        }
        return v3;
    }

    /// @dev One destination's V2 fields (own frame — viaIR stack headroom).
    function _perDestFields(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        uint256 destChainId,
        uint256 floorHalf
    ) private view returns (IRewardMessenger.BroadcastV2PerDest memory) {
        LibVaipakam.ChainDayFunding storage f =
            s.chainDayRecycledFunding[dayId][uint32(destChainId)];
        if (f.stamped) {
            return IRewardMessenger.BroadcastV2PerDest({
                destChainId: destChainId,
                freshLenderHalf: f.freshLenderHalf,
                freshBorrowerHalf: f.freshBorrowerHalf,
                recycledLenderHalfEquiv: f.lenderHalfEquiv,
                recycledBorrowerHalfEquiv: f.borrowerHalfEquiv,
                recycleConsume: f.recycleConsume,
                keeperAllocate: f.keeperAllocate
            });
        }
        // Codex #1417 r2 P1 — a destination excluded from the finalized
        // denominator (grace/force-finalized without its report) gets ZERO
        // halves: its numerators are not in the globals, so any nonzero
        // half would let its users accrue unremittable rewards.
        if (!s.chainDailyIncluded[dayId][uint32(destChainId)]) {
            floorHalf = 0;
        }
        return IRewardMessenger.BroadcastV2PerDest({
            destChainId: destChainId,
            freshLenderHalf: floorHalf,
            freshBorrowerHalf: floorHalf,
            recycledLenderHalfEquiv: 0,
            recycledBorrowerHalfEquiv: 0,
            recycleConsume: 0,
            keeperAllocate: 0
        });
    }
}
