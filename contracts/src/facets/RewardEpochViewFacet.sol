// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibRewardCustody} from "../libraries/LibRewardCustody.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";

/**
 * @title  RewardEpochViewFacet
 * @notice The READ side of the transport epochs that prices a claimant's
 *         days: the claim's dry run, the allocation domain's needs, and
 *         whether that domain has an epoch in reach. Every entry is a view.
 * @dev    #1566 transport epochs PR 3b-ii-A (Codex #2276 r2). These views
 *         inline the whole day-pricing engine — the side worklists, the
 *         cursor machinery, `processUserSideDay` — which is the bulk of any
 *         facet that carries them: the lens facet did once and stood at
 *         25 KB, and the ledger facet ({RewardEpochFacet}) hosted them next
 *         and went over EIP-170 the moment the domain probe joined. So the
 *         engine is inlined ONCE, here, and reached by staticcall through the
 *         Diamond ({LibRewardCustody.callDryRunShareOfPoolDays},
 *         {LibRewardCustody.callDomainNeeds}); the ledger facet keeps the
 *         writes and the ledger-only reads. A2's staging reads belong beside
 *         these, not on the ledger facet. No access control: nothing here
 *         writes, and every caller is a preview or a gate.
 */
contract RewardEpochViewFacet {
    // ───────────── 3b-ii-A2 (#2305) — the staging records' reads ─────────────

    /// @notice A lean view of a record — the scalars; its arrays are paged:
    ///         the batches through {getStagingRecordBatches}, the committed
    ///         entries with their reserved slices through
    ///         {getStagingRecordEntries}, and the epochs it passed over pending
    ///         through {getStagingRecordPending} (Codex #2308 r6).
    struct StagingRecordView {
        address user;
        uint8 side;
        uint8 op;
        uint8 phase;
        uint8 venue;
        bool venueSet;
        uint64 day;
        uint64 openedAt;
        uint64 deadline;
        bytes32 commitment;
        uint256 entryCount;
        uint256 stagedFresh;
        uint256 stagedRecycled;
        uint256 needUserFresh;
        uint256 needUserRecycled;
        uint256 needTreasuryFresh;
        uint256 needTreasuryRecycled;
        uint256 epochUserFresh;
        uint256 epochUserRecycled;
        uint256 epochTreasuryFresh;
        uint256 epochTreasuryRecycled;
        uint256 reservedLiveUserFresh;
        uint256 reservedLiveTreasuryFresh;
        uint256 reservedLiveUserRecycled;
        uint256 reservedPoolCap;
        uint256 heldEpoch;
        uint256 heldRecycled;
        uint256 batchCount;
        uint256 resolveCursor;
        bool scanComplete;
        uint256 cappedOffFresh;
        uint256 cappedOffRecycled;
        bytes32 continuationNode;
        bytes32 lateSeen;
        uint256 lateGenSeen;
        uint256 listCountSeen;
        uint256 consumeFreshLeft;
        uint256 consumeRecycledLeft;
        uint64 challengeStart;
        uint256 nonce;
        bool wasReserved;
        uint256 skippedCount;
        bool pendingOverflow;
        uint256 lateWorkBase;
    }

    /// @notice The preview's dry run of `user`'s ShareOfPool days against the
    ///         given delivered cap and fresh budget — what a claim would pay,
    ///         the full capped armed fresh it would charge, the part of it the
    ///         live delivery must fund, its draw on the recycle bucket net of
    ///         what the epochs pay (a deferred day included), and whether it
    ///         would defer a day on the transport scan window.
    /// @dev    See {LibInteractionRewards.dryRunShareOfPoolDaysView}.
    function getDryRunShareOfPoolDays(
        address user,
        uint256 deliveredCap,
        uint256 freshBudget
    )
        external
        view
        returns (uint256 userTotal, uint256 armedTotal, uint256 liveArmed, uint256 bucketRecycled, bool capHit)
    {
        return LibInteractionRewards.dryRunShareOfPoolDaysView(user, deliveredCap, freshBudget);
    }

    /// @notice The allocation DOMAIN's gross needs for `user`'s next claim
    ///         call — the fresh and recycled the days it would settle need
    ///         before any source is applied. Prices the chunk regardless of
    ///         whether an epoch is in reach; {getObligationDomainListsAnEpoch}
    ///         is that question.
    /// @dev    See {LibInteractionRewards.userDomainNeedsView}.
    function getObligationDomainNeeds(address user) external view returns (uint256 needFresh, uint256 needRecycled) {
        return LibInteractionRewards.userDomainNeedsView(user);
    }

    /// @notice Whether any day `user`'s next claim call could price has an
    ///         epoch listed — read from the ledger, the chunk's own days
    ///         enumerated without pricing them. False means "the day is the
    ///         domain" and the needs view need not run.
    /// @dev    See {LibInteractionRewards.chunkListsAnEpochView}. Its own
    ///         question, so the needs view stays a pure pricing view and a
    ///         chain with no epochs pays this enumeration and no pricing
    ///         (Codex #2276 r2 P1: a counter appended for this purpose read
    ///         zero over epochs that predate the release).
    function getObligationDomainListsAnEpoch(address user) external view returns (bool) {
        return LibInteractionRewards.chunkListsAnEpochView(user);
    }
    /// @notice The cooldown a non-settlement release put on `(user, side,
    ///         day)`: until this timestamp a claim on the day opens no record
    ///         and defers as before staging existed; zero when none stands
    ///         (Codex #2308 r7). The key is {LibRewardCustody.stagingKey}'s.
    function getStagingCooldown(address user, LibVaipakam.RewardSide side, uint256 day) external view returns (uint64 until) {
        until = LibVaipakam.storageSlot().stagingCooldownUntil[LibRewardCustody.stagingKey(user, side, day)];
        // Passed is none: the claim path reads `block.timestamp < until`, and
        // this reads the same lifecycle (Codex #2308 r9).
        if (until <= block.timestamp) until = 0;
    }

    /// @notice How many staging records are resolving — the count reward
    ///         custody's activation refuses on (Codex #2308 r7, r9): a
    ///         resolving record's consumed epoch value rests in the Diamond's
    ///         balance under no attribution until its last page pays it. The
    ///         activation ceremony reads this before it sends anything.
    function getStagingResolvingCount() external view returns (uint256) {
        return LibVaipakam.storageSlot().stagingResolvingCount;
    }

    /// @notice The record under `key` — every scalar it carries. A key with
    ///         no record reads as phase `None` with zeros, never reverts.
    function getStagingRecord(bytes32 key) external view returns (StagingRecordView memory v) {
        LibVaipakam.StagingRecord storage r = LibVaipakam.storageSlot().stagingRecords[key];
        v.user = r.user;
        v.side = uint8(r.side);
        v.op = uint8(r.op);
        v.phase = uint8(r.phase);
        v.venue = uint8(r.venue);
        v.venueSet = r.venueSet;
        v.day = r.day;
        v.openedAt = r.openedAt;
        v.deadline = r.deadline;
        v.commitment = r.commitment;
        v.entryCount = r.entryIds.length;
        v.stagedFresh = r.stagedFresh;
        v.stagedRecycled = r.stagedRecycled;
        v.needUserFresh = r.needUserFresh;
        v.needUserRecycled = r.needUserRecycled;
        v.needTreasuryFresh = r.needTreasuryFresh;
        v.needTreasuryRecycled = r.needTreasuryRecycled;
        v.epochUserFresh = r.epochUserFresh;
        v.epochUserRecycled = r.epochUserRecycled;
        v.epochTreasuryFresh = r.epochTreasuryFresh;
        v.epochTreasuryRecycled = r.epochTreasuryRecycled;
        v.reservedLiveUserFresh = r.reservedLiveUserFresh;
        v.reservedLiveTreasuryFresh = r.reservedLiveTreasuryFresh;
        v.reservedLiveUserRecycled = r.reservedLiveUserRecycled;
        v.reservedPoolCap = r.reservedPoolCap;
        v.heldEpoch = r.heldEpoch;
        v.heldRecycled = r.heldRecycled;
        v.batchCount = r.batchIds.length;
        v.resolveCursor = r.resolveCursor;
        v.scanComplete = r.scanComplete;
        v.cappedOffFresh = r.cappedOffFresh;
        v.cappedOffRecycled = r.cappedOffRecycled;
        v.continuationNode = r.continuationNode;
        v.lateSeen = r.lateSeen;
        v.lateGenSeen = r.lateGenSeen;
        v.listCountSeen = r.listCountSeen;
        v.consumeFreshLeft = r.consumeFreshLeft;
        v.consumeRecycledLeft = r.consumeRecycledLeft;
        v.challengeStart = r.challengeStart;
        v.nonce = r.nonce;
        v.wasReserved = r.wasReserved;
        v.skippedCount = r.skippedIds.length;
        v.pendingOverflow = r.pendingOverflow;
        v.lateWorkBase = r.lateWorkBase;
    }

    /// @notice One page of the record's batches — each with the components it
    ///         gave — from `from`, at most `count`.
    function getStagingRecordBatches(bytes32 key, uint256 from, uint256 count)
        external
        view
        returns (bytes32[] memory ids, uint256[] memory fresh, uint256[] memory recycled)
    {
        LibVaipakam.StagingRecord storage r = LibVaipakam.storageSlot().stagingRecords[key];
        uint256 n = r.batchIds.length;
        if (from >= n) return (ids, fresh, recycled);
        uint256 end = from + count;
        if (end > n) end = n;
        uint256 m = end - from;
        ids = new bytes32[](m);
        fresh = new uint256[](m);
        recycled = new uint256[](m);
        for (uint256 i; i < m; ) {
            ids[i] = r.batchIds[from + i];
            fresh[i] = r.batchFresh[from + i];
            recycled[i] = r.batchRecycled[from + i];
            unchecked { ++i; }
        }
    }

    /// @notice One page of the record's committed entries, from `from`, at
    ///         most `count`, each with the slice the reservation fixed for it
    ///         and whether that slice is charged to its loan side — the
    ///         figures {reserveStagedDay} wrote and the last page persists,
    ///         so a reader can substantiate a loan side's reserved figure
    ///         entry by entry (Codex #2308 r6). Before the reservation the
    ///         slices are empty and read as zero.
    function getStagingRecordEntries(bytes32 key, uint256 from, uint256 count)
        external
        view
        returns (uint256[] memory entryIds, uint256[] memory sliceAmounts, bool[] memory sliceChargeable)
    {
        LibVaipakam.StagingRecord storage r = LibVaipakam.storageSlot().stagingRecords[key];
        uint256 n = r.entryIds.length;
        if (from >= n) return (entryIds, sliceAmounts, sliceChargeable);
        uint256 end = from + count;
        if (end > n) end = n;
        uint256 m = end - from;
        bool sliced = r.sliceAmounts.length == n;
        entryIds = new uint256[](m);
        sliceAmounts = new uint256[](m);
        sliceChargeable = new bool[](m);
        for (uint256 i; i < m; ) {
            entryIds[i] = r.entryIds[from + i];
            if (sliced) {
                sliceAmounts[i] = r.sliceAmounts[from + i];
                sliceChargeable[i] = r.sliceChargeable[from + i];
            }
            unchecked { ++i; }
        }
    }

    /// @notice One page of the epochs the record passed over PENDING —
    ///         untyped, or not yet whole — from `from`, at most `count`: the
    ///         re-check page a preparation offers first, and what blocks the
    ///         reservation once one becomes stageable (Codex #2308 r6).
    function getStagingRecordPending(bytes32 key, uint256 from, uint256 count) external view returns (bytes32[] memory ids) {
        LibVaipakam.StagingRecord storage r = LibVaipakam.storageSlot().stagingRecords[key];
        uint256 n = r.skippedIds.length;
        if (from >= n) return ids;
        uint256 end = from + count;
        if (end > n) end = n;
        uint256 m = end - from;
        ids = new bytes32[](m);
        for (uint256 i; i < m; ) {
            ids[i] = r.skippedIds[from + i];
            unchecked { ++i; }
        }
    }
}
