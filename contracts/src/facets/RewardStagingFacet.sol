// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibRewardStaging} from "../libraries/LibRewardStaging.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {LibRewardCustody} from "../libraries/LibRewardCustody.sol";

/**
 * @title RewardStagingFacet
 * @notice #1566 transport epochs 3b-ii-A2 (#2305) — the STAGING lifecycle: a
 *         claim day one call could not settle keeps what it drew,
 *         obligation-bound and unpaid, until the call that can.
 * @dev The walks that hand a day to a record are hosted apart, on
 *      `RewardClaimWalkFacet`; this facet carries the record's lifecycle up
 *      to its reservation — prepare and reserve, both of which re-price a
 *      day through the same primitive the walks use — and
 *      `RewardStagingSettleFacet` carries the rest: resolution, unwind and
 *      the venue, which price nothing. Three facets, one behaviour; refreshed
 *      together. The staging entries are PERMISSIONLESS and take a
 *      record key only: everything else is derived from storage, re-priced
 *      through the same day primitive, never trusted from calldata. Each takes
 *      the Diamond's guard and the pause, as the claim does. The reads are on
 *      `RewardEpochViewFacet`, beside the epochs' other reads.
 *
 *      Every value movement a record makes is explicit — a row move with an
 *      event, or a reserved count written on the record — see
 *      {LibRewardStaging}. Staging never settles.
 */
contract RewardStagingFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    /// @notice A staging record opened for (`user`, `side`, `day`) under
    ///         `key`, committed to `commitment` — the event every later
    ///         lifecycle event of the record refers back to.
    /// @dev    Emitted by {LibRewardCustody} from the claim walk's internal
    ///         host (`RewardClaimWalkFacet`), whose ABI is deliberately not
    ///         exported: it is declared HERE, identically, so the record's
    ///         opening is decodable from the published staging ABI without
    ///         exposing the host's `address(this)`-gated selector (Codex
    ///         #2308 r17).
    /// @custom:event-category state-change/reward-staging
    event StagingRecordOpened(bytes32 indexed key, address indexed user, uint8 side, uint64 day, bytes32 commitment);
    /// @notice A2-ii priority-window events the staging library emits through
    ///         this facet's entries, declared here for the exported ABI.
    event TransportBatchContested(bytes32 indexed batchId, bytes32 indexed key);
    event TransportBatchWaiterRegistered(bytes32 indexed batchId, bytes32 indexed key, uint64 openedAt);
    event TransportBatchPriorityStaged(bytes32 indexed batchId, bytes32 indexed key);

    // ────────────────────────── the staging lifecycle ──────────────────────────

    /// @notice Permissionless: continue staging the record's day — its late
    ///         chain first, then the list from its continuation, one window —
    ///         and re-size its deadline from the work the day's list needs.
    /// @return stagedFresh    Fresh staged by this call.
    /// @return stagedRecycled Recycled staged by this call.
    function prepareStagedDay(bytes32 key)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 stagedFresh, uint256 stagedRecycled)
    {
        return LibRewardStaging.prepare(LibVaipakam.storageSlot(), key);
    }

    /// @notice Permissionless: if the day is covered — staged transport plus
    ///         what the live sources can bear meets the priced need — reserve
    ///         the residual legs and the cap headroom, per source. Nothing is
    ///         paid; the record is `Reserved`, still unwindable.
    function reserveStagedDay(bytes32 key) external nonReentrant whenNotPaused {
        LibRewardStaging.reserve(LibVaipakam.storageSlot(), key);
    }

    /// @notice Permissionless: register the record under `key` for `batchId`'s
    ///         open priority window (A2-ii). The record must have found the
    ///         batch contested and not have used its one priority reservation
    ///         there; the oldest registrant by opening time stages the batch
    ///         first once the window closes.
    function registerForBatchWindow(bytes32 key, bytes32 batchId) external nonReentrant whenNotPaused {
        LibRewardStaging.register(LibVaipakam.storageSlot(), key, batchId);
    }

    /// @notice The record-opening seam, hosted ONCE (A2-ii): a walk that
    ///         prices a cap-hit day — the claim's, a forfeit's, an expiry's
    ///         — stages the plan it found under its operation's commitment
    ///         through this entry, by Diamond self-call
    ///         ({LibRewardCustody.callStageDayFromPlan}), so no walk's facet
    ///         carries the record machinery. Gated to the Diamond; no
    ///         reentrancy guard of its own, since the caller holds the
    ///         Diamond's.
    function stageDayFromPlanInternal(
        address user,
        uint8 side,
        uint256 day,
        uint256[] calldata entryIds,
        bytes32[] calldata ids,
        uint256[] calldata fresh,
        uint256[] calldata recycled,
        uint8 deliverTo,
        uint8 op
    ) external returns (bytes32 key, uint256 staged) {
        if (msg.sender != address(this)) revert RewardCustodyOnlyDiamondInternal(msg.sender);
        return LibRewardCustody.stageDayFromPlan(
            LibVaipakam.storageSlot(),
            user,
            LibVaipakam.RewardSide(side),
            day,
            entryIds,
            ids,
            fresh,
            recycled,
            LibVaipakam.RewardDelivery(deliverTo),
            LibVaipakam.StagingOp(op)
        );
    }
}
