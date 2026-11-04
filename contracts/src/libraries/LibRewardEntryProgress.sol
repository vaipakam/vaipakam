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
 *         consumption cursor and live-record count. One thing those fields
 *         cannot show: a legacy-slice step that works INSIDE one record (a
 *         further consumption page of a wide day, or a further preparation
 *         page of it) moves none of the domain's own cursors. So a domain in
 *         its Staging phase that the sweep will step counts as progress by
 *         itself ({legacyStepDue}). Its one over-count is a preparation page
 *         that stops at once on a day the cumulative curve has not reached;
 *         that costs a caller one transaction, never a stalled entry.
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

    /// @notice Whether the forfeited-entry sweep, reaching entry `id`, will
    ///         step its legacy-slice domain: a forfeited, unsettled spanning
    ///         entry (not yet stamped) whose domain is staging. Such a step
    ///         can work inside one record without moving the domain's
    ///         cursors, so it counts as progress by itself (see the header).
    function legacyStepDue(LibVaipakam.Storage storage s, uint256 id) internal view returns (bool) {
        LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
        if (e.processed || s.rewardEntryClaimNextDay[id] != 0) return false;
        if (!LibInteractionRewards.isEntryForfeited(s, e)) return false;
        return s.stagingDomains[LibRewardCustody.legacyDomainKey(id)].phase == LibVaipakam.DomainPhase.Staging;
    }

    /// @notice The progress digest of every entry the forfeited-entry sweep of
    ///         `loanId` reaches — its active lender entry, its borrower entry
    ///         and the lender entries a position sale orphaned — and whether
    ///         any of them has a legacy step due. The sweep compares the digest
    ///         before and after; a due step is progress on its own.
    function loanSweepMark(LibVaipakam.Storage storage s, uint256 loanId)
        internal
        view
        returns (bytes32 mark, bool stepDue)
    {
        uint256 lenderId = s.loanActiveLenderEntryId[loanId];
        uint256 borrowerId = s.loanBorrowerEntryId[loanId];
        uint256[] storage orphaned = s.loanForfeitedLenderEntryIds[loanId];
        mark = keccak256(abi.encode(_entryMark(s, lenderId), _entryMark(s, borrowerId)));
        stepDue = (lenderId != 0 && legacyStepDue(s, lenderId)) || (borrowerId != 0 && legacyStepDue(s, borrowerId));
        uint256 n = orphaned.length;
        for (uint256 i; i < n; ) {
            uint256 id = orphaned[i];
            mark = keccak256(abi.encode(mark, digest(s, id)));
            if (!stepDue && legacyStepDue(s, id)) stepDue = true;
            unchecked { ++i; }
        }
    }

    /// @dev An absent pointer (0) marks as zero, so it never reads entry 0.
    function _entryMark(LibVaipakam.Storage storage s, uint256 id) private view returns (bytes32) {
        return id == 0 ? bytes32(0) : digest(s, id);
    }
}
