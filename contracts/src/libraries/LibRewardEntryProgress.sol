// src/libraries/LibRewardEntryProgress.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibRewardCustody} from "./LibRewardCustody.sol";
import {LibInteractionRewards} from "./LibInteractionRewards.sol";

/**
 * @title  LibRewardEntryProgress
 * @author Vaipakam Developer Team
 * @notice #3012 / #3026 — the ONE rule for "did a reward close-out call make
 *         progress on this entry", and the readable state it is built from.
 *
 * @dev    A permissionless close-out step (the forfeited-entry sweep, the
 *         zero-priced retirement) can move no VPFI and still change state: it
 *         advances the side's cumulative pricing cursor, steps the entry's
 *         legacy-slice domain, stamps or advances the entry's settlement
 *         cursor, or marks the entry processed. Its VPFI figure therefore
 *         cannot say whether the call did anything, and a caller that sends
 *         only on value either stalls a long backlog (the cursor-only advance,
 *         #3026) or sends a no-op every round (a deferred sweep, #3012).
 *
 *         So every such step reads the entry's progress here before and after
 *         and reports whether it moved. The same struct is what the lens
 *         returns, so the off-chain reader sees exactly the fields the rule
 *         compares — no second definition to drift.
 *
 *         What it compares, per entry: `processed`, the settlement cursor
 *         (`rewardEntryClaimNextDay`), the side's cumulative pricing cursor,
 *         and the legacy-slice domain's phase, preparation cursor,
 *         consumption cursor and live-record count. A legacy-slice step can
 *         also work INSIDE one day record (a further consumption or
 *         preparation page of a wide day) without moving any of the domain's
 *         own cursors. So the step measures the day record it worked on
 *         ({recordMarkOf}, every field of the record a page can write) before
 *         and after the page, and reports a change ({noteLegacyWork}, a
 *         per-transaction counter) only when the record actually moved. The
 *         caller reads that counter before and after its own call
 *         ({legacyWorkCount}). So a page that ran and changed nothing (a
 *         consumption the record's restoration window still blocks, with a
 *         preparation that leaves the blocked restoration unread), a step
 *         that stops at once (a day the cumulative curve has not reached)
 *         and a step that is never reached (a settlement deferred before it)
 *         all count nothing, and the report neither over- nor under-states a
 *         call's progress: it is measured, never inferred from a call
 *         having been made.
 */
library LibRewardEntryProgress {
    /// @notice One reward entry's settlement progress, as the close-out steps
    ///         compare it.
    /// @param processed             The entry is settled (nothing left to do).
    /// @param forfeited             It routes to the recycle bucket: forfeited
    ///                              by its own flag or by its loan's terminal
    ///                              state (only a forfeited entry is swept).
    /// @param claimNextDay          Its settlement cursor: the next day a
    ///                              settlement takes (0 = not stamped yet; a
    ///                              spanning entry is stamped to the cutover
    ///                              day once its legacy slice settles).
    /// @param sideCumCursor         The cumulative pricing cursor of its side,
    ///                              shared by every entry of that side. A step
    ///                              may only advance it (bounded per call).
    /// @param legacyPhase           Its legacy-slice domain's phase (0 none,
    ///                              1 staging: a step is pending, 3 consumed).
    /// @param legacyPreparedThrough The domain's preparation cursor.
    /// @param legacyConsumeCursor   The domain's consumption cursor.
    /// @param legacyLiveRecords     The domain's day records still open.
    struct EntryProgress {
        bool processed;
        bool forfeited;
        uint64 claimNextDay;
        uint256 sideCumCursor;
        uint8 legacyPhase;
        uint64 legacyPreparedThrough;
        uint64 legacyConsumeCursor;
        uint32 legacyLiveRecords;
    }

    /// @notice Entry `id`'s progress now.
    function read(LibVaipakam.Storage storage s, uint256 id) internal view returns (EntryProgress memory p) {
        LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
        LibVaipakam.StagingDomain storage dom = s.stagingDomains[LibRewardCustody.legacyDomainKey(id)];
        p.processed = e.processed;
        p.forfeited = LibInteractionRewards.isEntryForfeited(s, e);
        p.claimNextDay = s.rewardEntryClaimNextDay[id];
        p.sideCumCursor = e.side == LibVaipakam.RewardSide.Lender ? s.cumLenderCursor : s.cumBorrowerCursor;
        p.legacyPhase = uint8(dom.phase);
        p.legacyPreparedThrough = dom.preparedThrough;
        p.legacyConsumeCursor = dom.resolveCursor;
        p.legacyLiveRecords = dom.liveRecords;
    }

    /// @notice A digest of entry `id`'s progress: equal before and after a
    ///         call iff none of {EntryProgress}'s fields moved.
    function digest(LibVaipakam.Storage storage s, uint256 id) internal view returns (bytes32) {
        return keccak256(abi.encode(read(s, id)));
    }

    /// @dev Transient slot of the per-transaction legacy-step work counter.
    bytes32 private constant LEGACY_WORK_SLOT = keccak256("vaipakam.rewardEntryProgress.legacyWork");

    /// @notice A legacy-slice step changed a day record this transaction
    ///         (its {recordMark} differs after the page). Called by the step
    ///         itself, only after measuring the change.
    function noteLegacyWork() internal {
        bytes32 slot = LEGACY_WORK_SLOT;
        assembly ("memory-safe") {
            tstore(slot, add(tload(slot), 1))
        }
    }

    /// @notice A digest of every field of staging record `r` a consumption or
    ///         preparation page can write: equal before and after a page iff
    ///         the page changed nothing in the record. A closed record reads
    ///         as all-zero, so closing one is a change.
    /// @dev    Every value field, plus the record's two page-bounded lists
    ///         by content (the skipped epochs, at most one page, and the
    ///         committed entries). Split into groups only to keep each
    ///         encoding's stack small.
    function recordMark(LibVaipakam.StagingRecord storage r) internal view returns (bytes32) {
        bytes32 a = keccak256(abi.encode(
            r.phase, r.venue, r.venueSet, r.deadline, r.challengeStart, r.commitment,
            r.needUserFresh, r.needUserRecycled, r.needTreasuryFresh, r.needTreasuryRecycled,
            r.stagedFresh, r.stagedRecycled
        ));
        bytes32 b = keccak256(abi.encode(
            r.epochUserFresh, r.epochUserRecycled, r.epochTreasuryFresh, r.epochTreasuryRecycled,
            r.reservedLiveUserFresh, r.reservedLiveTreasuryFresh, r.reservedLiveUserRecycled,
            r.reservedPoolCap, r.heldEpoch, r.heldRecycled, r.batchCount, r.resolveCursor
        ));
        bytes32 c = keccak256(abi.encode(
            r.continuationNode, r.lateSeen, r.scanComplete, r.listCountSeen,
            r.cappedOffFresh, r.cappedOffRecycled, r.consumeFreshLeft, r.consumeRecycledLeft,
            r.nonce, r.lateGenSeen, r.wasReserved, r.pendingOverflow
        ));
        bytes32 d = keccak256(abi.encode(
            r.lateWorkBase, r.restoredSeen, r.forcedPages, r.eraId, r.eraUserFresh, r.eraTreasuryFresh,
            r.skippedIds, r.entryIds, r.sliceAmounts.length
        ));
        return keccak256(abi.encode(a, b, c, d));
    }

    /// @notice {recordMark} of staging record `key`, read through its one
    ///         runtime home, {InteractionRewardsLensFacet.getStagingRecordMark}.
    /// @dev    A self-staticcall rather than an inlined digest, so the digest
    ///         lives in one facet and the step's own facet (which sits near
    ///         EIP-170) carries only the call. A Diamond that does not route
    ///         the view fails the step closed (`StagingRecordMarkUnavailable`)
    ///         rather than reading every page as work or as none.
    function recordMarkOf(bytes32 key) internal view returns (bytes32 mark) {
        (bool ok, bytes memory ret) =
            address(this).staticcall(abi.encodeWithSignature("getStagingRecordMark(bytes32)", key));
        if (!ok || ret.length != 32) revert StagingRecordMarkUnavailable();
        mark = abi.decode(ret, (bytes32));
    }

    /// @notice The record-mark view is not routed on this Diamond.
    error StagingRecordMarkUnavailable();

    /// @notice How many legacy-slice work units this transaction has run so
    ///         far; a caller compares it before and after its own call.
    function legacyWorkCount() internal view returns (uint256 n) {
        bytes32 slot = LEGACY_WORK_SLOT;
        assembly ("memory-safe") {
            n := tload(slot)
        }
    }

    /// @notice The progress digest of every entry the forfeited-entry sweep of
    ///         `loanId` reaches — its active lender entry, its borrower entry
    ///         and the lender entries a position sale orphaned. The sweep
    ///         compares it before and after.
    function loanSweepMark(LibVaipakam.Storage storage s, uint256 loanId) internal view returns (bytes32 mark) {
        uint256 lenderId = s.loanActiveLenderEntryId[loanId];
        uint256 borrowerId = s.loanBorrowerEntryId[loanId];
        uint256[] storage orphaned = s.loanForfeitedLenderEntryIds[loanId];
        mark = keccak256(abi.encode(_entryMark(s, lenderId), _entryMark(s, borrowerId)));
        uint256 n = orphaned.length;
        for (uint256 i; i < n; ) {
            mark = keccak256(abi.encode(mark, digest(s, orphaned[i])));
            unchecked { ++i; }
        }
    }

    /// @dev An absent pointer (0) marks as zero, so it never reads entry 0.
    function _entryMark(LibVaipakam.Storage storage s, uint256 id) private view returns (bytes32) {
        return id == 0 ? bytes32(0) : digest(s, id);
    }
}
