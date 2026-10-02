// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibRewardCustody} from "../libraries/LibRewardCustody.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";

/**
 * @title  RewardEpochViewFacet
 * @notice The READ side of the transport epochs' staging records: every
 *         entry is a view of a record, its pages, its cooldown or the
 *         encumbrance count the posture gates read.
 * @dev    #1566 transport epochs PR 3b-ii-A (Codex #2276 r2) hosted the
 *         claim's dry run, the allocation domain's needs and the domain
 *         probe here. A2-iii retired all three: a preview is now the claim
 *         itself run in a reverting frame
 *         ({RewardClaimFacet.simulateClaimInteractionRewards}), the static
 *         consumers read row 13's O(1) prepared-coverage figure on the lens
 *         ({InteractionRewardsLensFacet.getUserArmedFreshNeedWithLegs},
 *         {InteractionRewardsLensFacet.getRewardEntryArmedNeed}), and the
 *         domain pre-pass was inert under the round-26 rule. Their selectors
 *         carry Remove legs in the in-place refresh. The ledger facet
 *         ({RewardEpochFacet}) keeps the writes and the ledger-only reads.
 *         No access control: nothing here writes.
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
        /// @dev What the record STILL holds staged, by component: a
        ///      resolution or unwind page takes its batches' components out of
        ///      these as it processes them (Codex #2308 r13).
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
        /// @dev The day's CURRENT late-chain generation (Codex #2308 r21):
        ///      while it differs from `lateGenSeen` the reservation refuses
        ///      `StagingScanIncomplete`, and the next preparation restarts the
        ///      late walk from the chain's head.
        uint256 lateGenNow;
        uint256 listCountSeen;
        uint256 consumeFreshLeft;
        uint256 consumeRecycledLeft;
        uint64 challengeStart;
        uint256 nonce;
        bool wasReserved;
        uint256 skippedCount;
        bool pendingOverflow;
        uint256 lateWorkBase;
        uint256 lateWorkRestored;
        /// @dev The day's restore log (Codex #2308 r15, r16): how far this
        ///      record has read it, and how long it is now. While the two
        ///      differ the reservation refuses `StagingScanIncomplete`, and
        ///      each preparation re-offers up to one window of the difference.
        uint256 restoredSeen;
        uint256 restoredLogLength;
        /// @dev The restore-log work processed so far, cumulative — what the
        ///      deadline counts beside the unread part (Codex #2308 r17).
        uint256 restoredWork;
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

    /// @notice How many staging records hold a live RESERVATION — reserved or
    ///         resolving — which is the count every POSTURE change refuses on
    ///         (Codex #2308 r7, r9, r13): the reward-custody activation
    ///         relocates the balance those reservations count against, and a
    ///         reward-role change moves the delivered allowance they were taken
    ///         against. The activation ceremony reads this before it sends
    ///         anything; the role setters read it on chain.
    function getStagingEncumberedCount() external view returns (uint256) {
        return LibVaipakam.storageSlot().stagingEncumberedCount;
    }

    /// @notice The record under `key` — every scalar it carries. A key with
    ///         no record reads as phase `None` with zeros, never reverts.
    function getStagingRecord(bytes32 key) external view returns (StagingRecordView memory v) {
        LibVaipakam.StagingRecord storage r = LibVaipakam.storageSlot().stagingRecords[key];
        // A key with no record reads as zeros — including the two DAY-level
        // figures below, which an absent record's zero day would otherwise
        // read off day 0 (Codex #2308 r21).
        if (r.phase == LibVaipakam.StagingPhase.None) return v;
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
        v.batchCount = r.batchCount;
        v.resolveCursor = r.resolveCursor;
        v.scanComplete = r.scanComplete;
        v.cappedOffFresh = r.cappedOffFresh;
        v.cappedOffRecycled = r.cappedOffRecycled;
        v.continuationNode = r.continuationNode;
        v.lateSeen = r.lateSeen;
        v.lateGenSeen = r.lateGenSeen;
        v.lateGenNow = LibVaipakam.storageSlot().transportDayLateGen[r.day];
        v.listCountSeen = r.listCountSeen;
        v.consumeFreshLeft = r.consumeFreshLeft;
        v.consumeRecycledLeft = r.consumeRecycledLeft;
        v.challengeStart = r.challengeStart;
        v.nonce = r.nonce;
        v.wasReserved = r.wasReserved;
        v.skippedCount = r.skippedIds.length;
        v.pendingOverflow = r.pendingOverflow;
        v.lateWorkBase = r.lateWorkBase;
        v.lateWorkRestored = r.lateWorkRestored;
        v.restoredSeen = r.restoredSeen;
        v.restoredLogLength = LibVaipakam.storageSlot().transportDayRestored[r.day].length;
        v.restoredWork = r.restoredWork;
    }

    /// @notice One page of the record's batches — each with the components it
    ///         STILL holds — from `from`, at most `count`, in the order the
    ///         plan staged them, which is the order the resolution consumes.
    ///         A batch the record has already resolved or unwound reads as
    ///         zeros: its components left the record (Codex #2308 r13), and
    ///         `resolveCursor` says how many have (`batchCount` stays the
    ///         record's lifetime total).
    function getStagingRecordBatches(bytes32 key, uint256 from, uint256 count)
        external
        view
        returns (bytes32[] memory ids, uint256[] memory fresh, uint256[] memory recycled)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.StagingRecord storage r = s.stagingRecords[key];
        uint256 n = r.batchCount;
        if (from >= n) return (ids, fresh, recycled);
        uint256 end = from + count;
        if (end > n) end = n;
        uint256 m = end - from;
        ids = new bytes32[](m);
        fresh = new uint256[](m);
        recycled = new uint256[](m);
        for (uint256 i; i < m; ) {
            LibVaipakam.StagedBatch storage sb = LibRewardCustody.stagedBatchAt(s, key, r, from + i);
            ids[i] = sb.id;
            fresh[i] = sb.fresh;
            recycled[i] = sb.recycled;
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

    // ───────── A2-iii — the static armed-need reads (row 13), hosted here ─────────

    /**
     * @notice #1434 P1-b (Codex #1699 r4) — the user's AGGREGATE capped
     *         armed-fresh requirement, as the claim itself computes it.
     * @dev    Hosted HERE, on the roomy view facet (A2-iii): the static read
     *         inlines the day pricing engine, and every facet that reaches it
     *         directly carries a copy — the expiry path once blew EIP-170 by
     *         5,037 bytes that way, and the lens, which hosted the three
     *         armed-need reads until A2-iii, by 1,023. One host; every other
     *         consumer — the lens's preview, the clock, the sweeps — reaches
     *         it by Diamond staticcall on the unchanged selectors.
     *
     *         Grouped and D1-capped, NOT a sum of per-entry prices: entries
     *         sharing a `(user, side, day)` ceiling would otherwise overstate
     *         the need and pause the expiry clock on funding nobody owes.
     *
     *         Measured with the delivered allowance SLACK. This is what the
     *         group needs; clamping it by the allowance it is then compared
     *         against would be circular and report every user as exactly
     *         affordable.
     * @param  user The claimant.
     * @return armed Capped armed fresh the user's open claim would consume.
     */
    function getUserArmedFreshNeed(address user)
        external
        view
        returns (uint256 armed)
    {
        return LibInteractionRewards.userArmedFreshNeedView(user);
    }

    /**
     * @notice Codex #1499 r6 P2 — the armed need together with the legacy legs
     *         its budget is derived from.
     * @dev    The horizon predicate reaches this by staticcall (an EIP-170
     *         requirement, see {LibInteractionRewards}), and it needs the same
     *         two legacy legs the walk's budget already computed. Returning
     *         them here is what keeps that O(entries) pass to ONE per swept
     *         entry instead of one on each side of the Diamond boundary. The
     *         scan runs before the unarmed early return, so the duplicate was
     *         paid on every chain rather than only on armed ones.
     *
     *         Additive on purpose: {getUserArmedFreshNeed} keeps its selector
     *         and its callers, so no routed selector is retired here.
     * @param  user The claimant.
     *         The shape stays FLAT and the first four outputs stay where they
     *         were (Codex #2276 r2 P2): the three readings 3b-ii-A added are
     *         appended, so a caller regenerated against the package keeps
     *         `armed` / `userLegs` / `treasuryLegs` / `legacyFresh` by name
     *         and by position. The library reads the same words as one
     *         struct ({LibInteractionRewards.ArmedNeed}, whose members are in
     *         this order), so the gates decode one shape.
     * @param  user The claimant.
     * @return armed        Capped armed fresh the user's open claim would
     *                      consume — the FULL figure, epoch-paid fresh
     *                      included (what the emission cap and the armed
     *                      commitment are charged).
     * @return userLegs     Legacy legs bound for the user.
     * @return treasuryLegs Legacy legs bound for treasury (they reserve too).
     * @return legacyFresh  #1566 closure 2 — the FRESH part of both legacy
     *                      legs PLUS the legacy window the claim settles
     *                      first. The executability predicate and the sweeps
     *                      measure the claimant's aggregate VINTAGE-BLIND fresh
     *                      need (the live-funded armed part plus this, capped
     *                      at the pool) against the delivered bound, because
     *                      the claim's delivery chokepoint refuses on the
     *                      TOTAL fresh component: a predicate that measured
     *                      only the armed part would read a legacy-only
     *                      claimant executable while their claim reverts, and
     *                      run their expiry clock.
     * @return bucketRecycled The read's days' draw on the recycle bucket,
     *                      net of what their prepared coverage pays.
     * @return capHit       A read day is NOT a day this claim would pay now —
     *                      a wide unprepared day, or a day a staging record
     *                      holds in any phase — so the claim would defer it;
     *                      preparation clears the former, the record's own
     *                      resolution the latter.
     * @return liveArmed    The part of `armed` the live delivery must fund;
     *                      the delivered and backing gates' figure.
     * @return userPaid     What the read's days would pay the USER, every
     *                      source — the conservative preview's armed part.
     *
     *         A2-iii SPECIFICATION CHANGE: the armed figures are row 13's
     *         STATIC read — per side, the FIRST pending armed day priced
     *         against PREPARED coverage (the one batch at the day's cursor;
     *         a day a staging record holds reads `capHit`) and the live
     *         sources, stopping at the first side that reads `capHit` — not
     *         a simulated walk of the whole chunk, which a view cannot run
     *         now that a preview is the settlement in a reverting frame.
     *         Conservative: never over-counts; a day no preparation has
     *         covered reads `capHit`. Eight outputs; the eighth is appended.
     */
    function getUserArmedFreshNeedWithLegs(address user)
        external
        view
        returns (
            uint256 armed,
            uint256 userLegs,
            uint256 treasuryLegs,
            uint256 legacyFresh,
            uint256 bucketRecycled,
            bool capHit,
            uint256 liveArmed,
            uint256 userPaid
        )
    {
        LibInteractionRewards.ArmedNeed memory n = LibInteractionRewards.userArmedFreshNeedWithLegsView(user);
        return (n.armed, n.userLegs, n.treasuryLegs, n.legacyFresh, n.bucketRecycled, n.capHit, n.liveArmed, n.userPaid);
    }

    /**
     * @notice The same static read for ONE reward entry's own pending day —
     *         the per-obligation figure the expiry clock and the sweeps read
     *         (A2-iii, row 13): the entry's day priced against its prepared
     *         coverage, the user's legacy figures beside it, same eight
     *         outputs. An entry not on its side's armed worklist (a purely
     *         legacy one) carries zero armed figures.
     * @dev    Reached by the clock through a Diamond staticcall for the same
     *         EIP-170 reason as its user-level sibling: ONE implementation,
     *         hosted here, never inlined into a settle facet.
     * @param  entryId The reward entry.
     */
    function getRewardEntryArmedNeed(uint256 entryId)
        external
        view
        returns (
            uint256 armed,
            uint256 userLegs,
            uint256 treasuryLegs,
            uint256 legacyFresh,
            uint256 bucketRecycled,
            bool capHit,
            uint256 liveArmed,
            uint256 userPaid
        )
    {
        LibInteractionRewards.ArmedNeed memory n = LibInteractionRewards.entryArmedNeedView(entryId);
        return (n.armed, n.userLegs, n.treasuryLegs, n.legacyFresh, n.bucketRecycled, n.capHit, n.liveArmed, n.userPaid);
    }
}
