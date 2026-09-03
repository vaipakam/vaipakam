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
     *      {IRewardMessenger.quoteBroadcastGlobal}. Leftover refunds to the
     *      caller.
     *
     *      Separated from {finalizeDay} so finalization stays cheap and
     *      a LZ outage on one destination can be retried independently
     *      from another via a follow-up call.
     * @param dayId Day whose finalized pair to broadcast.
     */
    function broadcastGlobal(
        uint256 dayId
    ) external payable nonReentrant whenNotPaused onlyCanonical {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.dailyGlobalFinalized[dayId]) revert DayNotReadyToFinalize();
        address messenger = s.rewardMessenger;
        if (messenger == address(0)) revert RewardMessengerNotSet();

        // #1434 P2-w1 — three-step send ladder: V3 (kind-10, the frozen
        // day-clock facts) → V2 (kind-5) → legacy (kind-2). Each step falls
        // through ONLY on an empty revert (= missing selector on an older
        // messenger proxy — the established capability probe); a reasoned
        // revert is a real failure and bubbles. A day finalized BEFORE this
        // upgrade has no frozen clock (`dayLapseClock[dayId].finalizedAt ==
        // 0`) and is broadcast on the V2 wire permanently: there is no
        // authentic finalization timestamp to send, and a zero-clock V3
        // would fail closed at the mirror ingress as a PERMANENTLY failed
        // CCIP message — the V2 fallback is what keeps pre-upgrade days
        // broadcastable at all.
        _broadcastDayV3(
            s,
            dayId,
            messenger,
            IRewardMessenger(messenger).getBroadcastDestinations()
        );
    }

    /// @notice B2-b (Codex #1417 r1) — quote the fee the PERMISSIONLESS
    ///         {broadcastGlobal} trigger will actually pay: assembles the
    ///         SAME per-destination V2 payloads as the send and quotes them
    ///         through the messenger, falling back to the legacy quote when
    ///         the messenger predates V2 (empty revert = missing selector)
    ///         — the exact mirror of the send-side shim, so the unchanged
    ///         public entry point stays quotable across the rollout window.
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
        // #1434 P2-w1 — quote the V3 shape iff the send path would send it:
        // the day carries a frozen clock AND the messenger has the V3
        // selector. The exact mirror of the send-side ladder, so the
        // permissionless trigger's quote can never price a different wire
        // generation than the send dispatches.
        if (s.dayLapseClock[dayId].finalizedAt != 0) {
            try IRewardMessenger(messenger).quoteBroadcastDayV3(
                shared, _dayExtras(s, dayId), _toV3PerDest(s, dayId, perDest)
            ) returns (uint256 f3) {
                return f3;
            } catch (bytes memory reason) {
                if (reason.length != 0) {
                    assembly ("memory-safe") {
                        revert(add(reason, 0x20), mload(reason))
                    }
                }
            }
        }
        try IRewardMessenger(messenger).quoteBroadcastDayV2(shared, perDest)
        returns (uint256 f) {
            return f;
        } catch (bytes memory reason) {
            if (reason.length != 0) {
                assembly ("memory-safe") {
                    revert(add(reason, 0x20), mload(reason))
                }
            }
        }
        // Pre-B2-b messenger: the send path will fall back to the legacy
        // kind-2 broadcast, so quote that shape.
        return IRewardMessenger(messenger).quoteBroadcastGlobal(
            dayId,
            s.dailyGlobalLenderInterestNumeraire18[dayId],
            s.dailyGlobalBorrowerInterestNumeraire18[dayId]
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
    ///         after its kind-5 apply could otherwise never receive its V3
    ///         clock backfill (design §1.1). Admission is day-scoped
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
        if (s.dayLapseClock[dayId].finalizedAt == 0) {
            revert DayHasNoLapseClock(dayId);
        }
        _assertDayStanding(s, dayId, destChainId);

        uint256[] memory one = new uint256[](1);
        one[0] = destChainId;
        (
            IRewardMessenger.BroadcastV2Shared memory shared,
            IRewardMessenger.BroadcastV2PerDest[] memory perDest
        ) = _assembleDayV2(s, dayId, one);

        try IRewardMessenger(messenger).broadcastDayV3Single{
            value: msg.value
        }(
            shared,
            _dayExtras(s, dayId),
            _toV3PerDest(s, dayId, perDest)[0],
            payable(msg.sender)
        ) returns (bytes32) {} catch (bytes memory reason) {
            if (reason.length != 0) {
                assembly ("memory-safe") {
                    revert(add(reason, 0x20), mload(reason))
                }
            }
            revert MessengerPredatesV3();
        }
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
        if (s.dayLapseClock[dayId].finalizedAt == 0) {
            revert DayHasNoLapseClock(dayId);
        }
        _assertDayStanding(s, dayId, destChainId);

        uint256[] memory one = new uint256[](1);
        one[0] = destChainId;
        (
            IRewardMessenger.BroadcastV2Shared memory shared,
            IRewardMessenger.BroadcastV2PerDest[] memory perDest
        ) = _assembleDayV2(s, dayId, one);

        try IRewardMessenger(messenger).quoteBroadcastDayV3Single(
            shared, _dayExtras(s, dayId), _toV3PerDest(s, dayId, perDest)[0]
        ) returns (uint256 f) {
            return f;
        } catch (bytes memory reason) {
            if (reason.length != 0) {
                assembly ("memory-safe") {
                    revert(add(reason, 0x20), mload(reason))
                }
            }
            revert MessengerPredatesV3();
        }
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

    /// @dev B2-b — assemble the kind-5 per-destination broadcast: the
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

    /// @dev B2-b — build + send the kind-5 per-destination broadcast.
    function _broadcastDayV2(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        address messenger,
        uint256[] memory dests
    ) private {
        (
            IRewardMessenger.BroadcastV2Shared memory shared,
            IRewardMessenger.BroadcastV2PerDest[] memory perDest
        ) = _assembleDayV2(s, dayId, dests);

        try IRewardMessenger(messenger).broadcastDayV2{value: msg.value}(
            shared, perDest, payable(msg.sender)
        ) {} catch (bytes memory reason) {
            // Empty revert = missing selector on a pre-B2-b messenger
            // proxy → legacy kind-2 fallback (the failed call returned
            // the full msg.value, so the legacy send re-forwards it).
            // Reasoned reverts (fee shortfall, destination-set mismatch)
            // are real failures and bubble.
            if (reason.length != 0) {
                assembly ("memory-safe") {
                    revert(add(reason, 0x20), mload(reason))
                }
            }
            _broadcastLegacy(s, dayId, messenger);
        }
    }

    /// @dev #1434 P2-w1 — the V3 ladder head: assemble the SAME V2 fields
    ///      the kind-5 wire would carry, append the day's frozen clock facts,
    ///      and try the kind-10 send; fall through to {_broadcastDayV2} on
    ///      an empty revert (pre-V3 messenger proxy — the established
    ///      missing-selector probe; the failed call returned the full
    ///      msg.value, so the V2 send re-forwards it) or when the day has no
    ///      frozen clock (finalized before this upgrade — see
    ///      {broadcastGlobal}). Reasoned reverts bubble.
    function _broadcastDayV3(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        address messenger,
        uint256[] memory dests
    ) private {
        if (s.dayLapseClock[dayId].finalizedAt == 0) {
            _broadcastDayV2(s, dayId, messenger, dests);
            return;
        }
        (
            IRewardMessenger.BroadcastV2Shared memory shared,
            IRewardMessenger.BroadcastV2PerDest[] memory perDest
        ) = _assembleDayV2(s, dayId, dests);

        try IRewardMessenger(messenger).broadcastDayV3{value: msg.value}(
            shared,
            _dayExtras(s, dayId),
            _toV3PerDest(s, dayId, perDest),
            payable(msg.sender)
        ) {} catch (bytes memory reason) {
            if (reason.length != 0) {
                assembly ("memory-safe") {
                    revert(add(reason, 0x20), mload(reason))
                }
            }
            _broadcastDayV2(s, dayId, messenger, dests);
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

    /// @dev B2-b — the pre-V2 kind-2 send, kept as the fallback for a
    ///      not-yet-upgraded messenger proxy (rollout shim; remove with
    ///      the legacy wire).
    function _broadcastLegacy(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        address messenger
    ) private {
        LibVaipakam.DayPoolStamp storage stamp = s.dayPoolStamp[dayId];
        IRewardMessenger(messenger).broadcastGlobal{value: msg.value}(
            dayId,
            s.dailyGlobalLenderInterestNumeraire18[dayId],
            s.dailyGlobalBorrowerInterestNumeraire18[dayId],
            // #1008 (S13) — ship the finalize-snapshotted canonical §4 cap
            // threshold so every mirror caps identically.
            s.dayCapThreshold18[dayId],
            // Governor PR-3c (#1217 §6/§8) — ship the finalize-stamped
            // day-pool composition (per-side halves) + the arming day so
            // every mirror prices the identical dailyPool and arms on the
            // same D* with zero operator drift.
            uint256(stamp.scheduleFloor) / 2,
            uint256(stamp.recycledBudget) / 2,
            s.governorCommitArmedFromDay,
            payable(msg.sender)
        );
    }
}
