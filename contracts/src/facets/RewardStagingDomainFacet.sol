// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibRewardCustody} from "../libraries/LibRewardCustody.sol";
import {LibRewardStaging} from "../libraries/LibRewardStaging.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title RewardStagingDomainFacet
 * @notice 3b-ii-A2-ii (#2305) — the lifecycle entries of a multi-chunk claim
 *         DOMAIN ({LibVaipakam.StagingDomain}): a claim whose pending armed
 *         days exceed one settlement chunk is PREPARED by the claim walk (one
 *         day record per day, nothing paid) and then, through these
 *         permissionless pages, RESERVED day by day from the live sources and
 *         the cap headroom, RESOLVED in day order once every day is reserved,
 *         or UNWOUND past its deadline or on the claimant's cancel. Hosted on
 *         its own facet: `RewardStagingFacet` carries the record machinery
 *         and sits within 2.4 KB of EIP-170.
 * @dev    Every value movement here is a record's own — a page of this facet
 *         only chooses which record's page runs; the records' events name the
 *         moves. The domain's own events name its phases, its cursor stops
 *         and its clearing.
 */
contract RewardStagingDomainFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    /// @notice A2-ii domain events the staging library emits through this
    ///         facet's entries, declared here for the exported ABI.
    event StagingDomainOpened(bytes32 indexed domainKey, address indexed user, uint8 side, uint64 firstDay, uint64 lastDay, uint256 chunks);
    event StagingDomainPhase(bytes32 indexed domainKey, uint8 phase);
    event StagingDomainReserveStopped(bytes32 indexed domainKey, uint64 day);
    event StagingDomainCleared(bytes32 indexed domainKey, bool paid);
    event StagingDomainDeadlineSet(bytes32 indexed domainKey, uint64 deadline);
    event LegacySliceConsumed(uint256 indexed entryId, uint256 epochFresh);
    event LegacySliceDomainOpened(uint256 indexed entryId, bytes32 indexed domainKey, uint64 firstDay, uint64 lastDay);

    /// @notice One reservation page of the domain under `domainKey`
    ///         ({LibRewardStaging.reserveDomainPage}). Permissionless.
    function reserveDomainPage(bytes32 domainKey) external nonReentrant whenNotPaused returns (bool done) {
        return LibRewardStaging.reserveDomainPage(LibVaipakam.storageSlot(), domainKey);
    }

    /// @notice One resolution page ({LibRewardStaging.resolveDomainPage}). Permissionless.
    function resolveDomainPage(bytes32 domainKey) external nonReentrant whenNotPaused returns (bool done) {
        return LibRewardStaging.resolveDomainPage(LibVaipakam.storageSlot(), domainKey);
    }

    /// @notice One unwind page ({LibRewardStaging.unwindDomainPage}): past the
    ///         deadline anyone, before it only the claimant.
    function unwindDomainPage(bytes32 domainKey) external nonReentrant returns (bool done) {
        return LibRewardStaging.unwindDomainPage(LibVaipakam.storageSlot(), domainKey, msg.sender);
    }

    /// @notice The claimant binds the venue the domain's days deliver to, while
    ///         the domain is still staging.
    function setDomainVenue(bytes32 domainKey, LibVaipakam.RewardDelivery venue) external nonReentrant {
        LibRewardStaging.setDomainVenue(LibVaipakam.storageSlot(), domainKey, msg.sender, venue);
    }

    /// @notice One step of entry `entryId`'s LEGACY-SLICE domain (A2-ii (c)):
    ///         a preparation page while the window is not prepared, a
    ///         consumption page once it is; permissionless, so anyone may
    ///         drive a slice home ahead of its settlement. Reverts when the
    ///         slice has no pending domain (not listed, or already consumed).
    function stepLegacySlice(uint256 entryId) external nonReentrant whenNotPaused returns (bool consumed) {
        return LibRewardStaging.legacySliceStep(LibVaipakam.storageSlot(), entryId);
    }

    /// @notice The legacy slice's gate, hosted here (A2-ii (c); EIP-170): every
    ///         settlement site — the claim's entry loop, the forfeit sweep, the
    ///         expiry sweep — reaches it by Diamond self-call, so the slice's
    ///         domain machinery is compiled into one facet. Gated to the
    ///         Diamond; no reentrancy guard or pause check of its own — the
    ///         settlement that calls it carries both.
    function legacySliceEpochsInternal(uint256 entryId) external returns (bool ready, uint256 epochFresh, bool stepped) {
        if (msg.sender != address(this)) revert RewardCustodyOnlyDiamondInternal(msg.sender);
        return LibRewardStaging.legacySliceEpochs(LibVaipakam.storageSlot(), entryId);
    }

    /// @notice The legacy slice's settle, hosted here (A2-ii (c); EIP-170): the
    ///         settlement site that pays the slice reaches it by Diamond
    ///         self-call right before it routes the legs. Gated to the Diamond.
    function legacySliceSettledInternal(uint256 entryId) external {
        if (msg.sender != address(this)) revert RewardCustodyOnlyDiamondInternal(msg.sender);
        LibRewardStaging.legacySliceSettled(LibVaipakam.storageSlot(), entryId);
    }

    /// @notice The legacy-slice domain of `entryId`: its key, phase (0 none,
    ///         1 preparing or consuming, 3 consumed), extent, preparation and
    ///         consumption cursors, live records and the epoch fresh consumed.
    function getLegacySliceDomain(uint256 entryId)
        external
        view
        returns (
            bytes32 domainKey,
            uint8 phase,
            uint64 firstDay,
            uint64 lastDay,
            uint64 preparedThrough,
            uint64 consumeCursor,
            uint32 liveRecords,
            uint256 epochFresh
        )
    {
        domainKey = LibRewardCustody.legacyDomainKey(entryId);
        LibVaipakam.StagingDomain storage dom = LibVaipakam.storageSlot().stagingDomains[domainKey];
        return (domainKey, uint8(dom.phase), dom.firstDay, dom.lastDay, dom.preparedThrough, dom.resolveCursor, dom.liveRecords, dom.aggFresh);
    }

    /// @notice The domain of (`user`, `side`) — every scalar it carries, and its key.
    function getStagingDomain(address user, LibVaipakam.RewardSide side)
        external
        view
        returns (
            bytes32 domainKey,
            uint8 phase,
            uint64 firstDay,
            uint64 lastDay,
            uint64 preparedThrough,
            uint64 reserveCursor,
            uint64 resolveCursor,
            uint64 unwindCursor,
            uint32 liveRecords,
            uint64 openedAt,
            uint64 deadline,
            uint256 chunks,
            uint256 entryCount
        )
    {
        domainKey = LibRewardCustody.domainKey(user, side);
        LibVaipakam.StagingDomain storage dom = LibVaipakam.storageSlot().stagingDomains[domainKey];
        return (
            domainKey,
            uint8(dom.phase),
            dom.firstDay,
            dom.lastDay,
            dom.preparedThrough,
            dom.reserveCursor,
            dom.resolveCursor,
            dom.unwindCursor,
            dom.liveRecords,
            dom.openedAt,
            dom.deadline,
            dom.chunks,
            dom.entryIds.length
        );
    }

    // ───────────── 3b-ii-A2 (#2305) — the staging records' reads ─────────────
    // #1566 sanctions slice — moved here from RewardEpochViewFacet with the
    // same selectors and bodies (a CLEAN HOST SPLIT): the view facet hosts the
    // armed-need dry run, which inlines most of the claim engine, and sat a few
    // hundred bytes under EIP-170; these reads belong beside the domain and
    // legacy-slice reads this staging facet already hosts. Refresh the two
    // facets together: a Diamond refresh re-points these selectors here.


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
        /// @dev The day's restore log (Codex #2308 r15, r16): how far this
        ///      record has read it, and how long it is now. While the two
        ///      differ the reservation refuses `StagingScanIncomplete`, and
        ///      each preparation re-offers up to one window of the difference.
        uint256 restoredSeen;
        uint256 restoredLogLength;
        /// @dev The pages forced on the record so far — a late-chain restart's
        ///      pages, and one per call forced after the scan had completed —
        ///      what the deadline counts beside the list's pages and the
        ///      forced work still pending (Codex #2308 r17, r22).
        uint256 forcedPages;
    }

    /// @notice `batchId`'s priority window (A2-ii, replacing A2-i's
    ///         obligation-keyed cooldown): when it closes, who released into
    ///         it, the oldest registrant and its record's opening time, whether
    ///         a priority reservation is taken and still held, and whether
    ///         ORDINARY staging from the batch is admitted now (a stranger's
    ///         read of {LibRewardCustody.stageableFor}). `closesAt == 0` means
    ///         no release ever touched the batch.
    function getTransportBatchWindow(bytes32 batchId)
        external
        view
        returns (
            uint64 closesAt,
            bytes32 releasedBy,
            bytes32 oldestKey,
            uint64 oldestOpenedAt,
            bool priorityHeld,
            bool ordinaryOpen
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.TransportBatchWindow storage w = s.transportBatchWindows[batchId];
        closesAt = w.closesAt;
        releasedBy = w.releasedBy;
        oldestKey = w.oldestKey;
        oldestOpenedAt = w.oldestOpenedAt;
        priorityHeld = w.winnerNonceKey != bytes32(0) && s.stagingBatchIndexPlusOne[w.winnerNonceKey][batchId] != 0;
        (ordinaryOpen, ) = LibRewardCustody.stageableFor(s, batchId, bytes32(0));
    }

    /// @notice Whether the obligation under `key` has used its one priority
    ///         reservation on `batchId` — permanent (A2-ii).
    function isTransportBatchPriorityUsed(bytes32 batchId, bytes32 key) external view returns (bool) {
        return LibVaipakam.storageSlot().transportBatchPriorityUsed[batchId][key];
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
        v.restoredSeen = r.restoredSeen;
        v.restoredLogLength = LibVaipakam.storageSlot().transportDayRestored[r.day].length;
        v.forcedPages = r.forcedPages;
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
}
