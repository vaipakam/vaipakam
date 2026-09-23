// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibRewardCustody} from "./LibRewardCustody.sol";
import {LibInteractionRewards} from "./LibInteractionRewards.sol";
import {LibVpfiRecycle} from "./LibVpfiRecycle.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title LibRewardStaging
 * @notice #1566 transport epochs 3b-ii-A2 (#2305) — the lifecycle of a STAGING
 *         RECORD: a claim day that one call could not settle keeps what it drew,
 *         obligation-bound and unpaid, until the call that can.
 * @dev The one rule, stated once: STAGING NEVER SETTLES. What a record holds is
 *      debited from its batches and the live sources and credited to no one;
 *      the day pays out, persists and exhausts its batches only on the record's
 *      last page, and until then nothing is half-paid.
 *
 *      Every value movement is explicit (owner directive 2026-09-23): a batch's
 *      component moves into `stagedFresh` / `stagedRecycled` with an event that
 *      names the batch and the record; the live recycled residual and, page by
 *      page, the epoch legs move into the `Resolving` custody row as HOLDS with
 *      events naming source, destination, amount and record; fresh and the cap
 *      headroom are reserved by COUNT — the live fresh row's era queue records
 *      every debit as spend, so fresh is never held out of it — with the figure
 *      written on the record so the unwind returns exactly what was taken. The
 *      last page returns each hold to the row it came from and then runs the
 *      A1 claim's own delivery and treasury paths for the one day, so no
 *      accounting primitive changes meaning here.
 *
 *      Scope of this slice (A2-i): standalone CLAIM days — a day of the claim's
 *      entry walk that a cap hit deferred. A sweep's day, a multi-chunk domain
 *      and the legacy slice are A2-ii (#2305). Staging waits for the type: only
 *      an ATTESTED packet's batch is staged from, because the chain cannot
 *      tell a legacy rollout packet from one whose attestation is still in
 *      flight until the typed wire (3d) lands; until then the untyped
 *      population is draw-only, as in A1.
 *
 *      Hosted on `RewardStagingFacet` only. Nothing here is inlined into a
 *      settle facet: the claim walk that stages is on the host, and the
 *      permissionless entries derive everything from storage.
 */
library LibRewardStaging {
    // ─────────────────────────────── events ───────────────────────────────

    // `StagingRecordOpened` and `TransportStaged` are the custody library's:
    // the batch-side moves are made there, by the walk and by {prepare} alike.
    /// @notice The claimant set the record's delivery venue.
    /// @custom:event-category state-change/reward-staging
    event StagingVenueSet(bytes32 indexed key, uint8 venue);
    /// @notice The day is covered: the residual legs and the cap headroom are
    ///         reserved, per source, and the record can no longer be re-priced.
    /// @custom:event-category state-change/reward-staging
    event StagingReserved(
        bytes32 indexed key,
        uint256 liveUserFresh,
        uint256 liveTreasuryFresh,
        uint256 liveUserRecycled,
        uint256 poolCap
    );
    /// @notice A resolution page consumed `batchId`'s staged components for `key`.
    /// @custom:event-category state-change/reward-staging
    event StagingResolvedBatch(bytes32 indexed batchId, bytes32 indexed key, uint256 fresh, uint256 recycled);
    /// @notice The record's last page paid the day: the user's and the
    ///         treasury's fresh and recycled, by source.
    /// @custom:event-category state-change/reward-staging
    event StagingPaid(
        bytes32 indexed key,
        address indexed user,
        uint256 userFresh,
        uint256 userRecycled,
        uint256 treasuryFresh,
        uint256 treasuryRecycled,
        uint8 venue
    );
    /// @notice An unwind page returned `batchId`'s staged components for `key`.
    /// @custom:event-category state-change/reward-staging
    event StagingUnwoundBatch(bytes32 indexed batchId, bytes32 indexed key, uint256 fresh, uint256 recycled);
    /// @notice The record is gone: unwound (`paid == false`) or paid.
    /// @custom:event-category state-change/reward-staging
    event StagingRecordClosed(bytes32 indexed key, bool paid);

    // ────────────────────────────── constants ─────────────────────────────

    /// @dev Batches resolved or unwound per page — the scan cap, so a page's
    ///      work is bounded by the same figure as a scan's.
    uint256 internal constant STAGING_PAGE = LibRewardCustody.TRANSPORT_DRAW_SCAN_CAP;

    // ─────────────────────────────── reads ────────────────────────────────

    function record(
        LibVaipakam.Storage storage s,
        bytes32 key
    ) internal view returns (LibVaipakam.StagingRecord storage r) {
        r = s.stagingRecords[key];
        if (r.phase == LibVaipakam.StagingPhase.None) revert IVaipakamErrors.StagingRecordUnknown(key);
    }

    function _requirePhase(bytes32 key, LibVaipakam.StagingRecord storage r, LibVaipakam.StagingPhase p) private view {
        if (r.phase != p) revert IVaipakamErrors.StagingPhaseInvalid(key, uint8(r.phase));
    }

    // ─────────────────────────────── venue ────────────────────────────────

    /// @notice The claimant binds the delivery venue, before the record is
    ///         reserved (Codex #2297 post-merge item 5): preparation is
    ///         venue-neutral, only the claimant may choose, and an unset venue
    ///         resolves to the claimant's default at payout.
    function setVenue(
        LibVaipakam.Storage storage s,
        bytes32 key,
        address caller,
        LibVaipakam.RewardDelivery venue
    ) internal {
        LibVaipakam.StagingRecord storage r = record(s, key);
        if (caller != r.user || r.phase != LibVaipakam.StagingPhase.Staging) {
            revert IVaipakamErrors.StagingVenueNotSettable(key);
        }
        r.venue = venue;
        r.venueSet = true;
        emit StagingVenueSet(key, uint8(venue));
    }

    // ─────────────────────────────── prepare ──────────────────────────────

    /// @notice Permissionless: continue staging the record's day from its
    ///         continuation — the day's late chain first, then the list from
    ///         where the last scan stopped — up to one window, then re-size
    ///         the deadline. Derives the obligation from storage; the caller
    ///         supplies only the key.
    /// @dev The ask is transport-first, as A1's allocation is: the day's two
    ///      needs less what is already staged, not merely the live shortfall.
    ///      The record's own commitment is what is re-priced, so an entry
    ///      that changed lifecycle since makes the pricing revert
    ///      (`RewardEntrySetMismatch`) — a stale record is unwound, never
    ///      repriced in place.
    function prepare(LibVaipakam.Storage storage s, bytes32 key) internal returns (uint256 stagedFresh, uint256 stagedRecycled) {
        LibVaipakam.StagingRecord storage r = record(s, key);
        _requirePhase(key, r, LibVaipakam.StagingPhase.Staging);
        (uint256 askF, uint256 askR) = _ask(s, r);
        if (askF + askR != 0) (stagedFresh, stagedRecycled) = _scanAndStage(s, key, r, askF, askR);
        LibRewardCustody.stagingDeadlineRefresh(s, key, r);
    }

    /// @dev The transport the record still asks for: the day's two needs less
    ///      what is already staged — transport-first, as A1's allocation is.
    function _ask(
        LibVaipakam.Storage storage s,
        LibVaipakam.StagingRecord storage r
    ) private view returns (uint256 askF, uint256 askR) {
        (LibInteractionRewards.DayCharge memory charge, ) = _price(s, r);
        askF = charge.needFresh > r.stagedFresh ? charge.needFresh - r.stagedFresh : 0;
        askR = charge.needRecycled > r.stagedRecycled ? charge.needRecycled - r.stagedRecycled : 0;
    }

    /// @dev One window from the record's continuation (late chain first),
    ///      split for the ask, staged; the continuation advances to where the
    ///      scans stopped whether or not anything was stageable there.
    function _scanAndStage(
        LibVaipakam.Storage storage s,
        bytes32 key,
        LibVaipakam.StagingRecord storage r,
        uint256 askF,
        uint256 askR
    ) private returns (uint256 stagedFresh, uint256 stagedRecycled) {
        (bytes32[] memory ids, uint256[] memory fresh, uint256[] memory recycled, bytes32 lastNode, bytes32 lastLate) =
            LibRewardCustody.planTakesForRecord(s, r.day, r.continuationNode, r.lateSeen, askF, askR);
        if (lastNode != bytes32(0)) r.continuationNode = lastNode;
        if (lastLate != bytes32(0)) r.lateSeen = lastLate;
        if (ids.length == 0) return (0, 0);
        return LibRewardCustody.stageTakes(s, key, r, ids, fresh, recycled);
    }

    // ─────────────────────────────── reserve ──────────────────────────────

    /// @notice Permissionless: if the day is COVERED — staged transport plus
    ///         what the live sources can bear meets the priced need — reserve
    ///         the residual legs and the cap headroom, per source, and fix
    ///         the four figures the resolution pays. Nothing is paid; the
    ///         record becomes `Reserved`, still unwindable, no longer
    ///         re-priced.
    /// @dev The reservation is the A1 claim's own coverage checks applied to
    ///      one day — pool cap, delivered headroom, backing room, loan-side
    ///      cap — with RESERVED counters instead of paid ones (Codex #2297
    ///      post-merge item 3), so a concurrent one-call settlement sees the
    ///      headroom as encumbered, never as paid, and defers on it.
    function reserve(LibVaipakam.Storage storage s, bytes32 key) internal {
        LibVaipakam.StagingRecord storage r = record(s, key);
        _requirePhase(key, r, LibVaipakam.StagingPhase.Staging);
        (LibInteractionRewards.DayCharge memory charge, LibInteractionRewards.DaySlice[] memory slices) = _price(s, r);
        if (!charge.advanced) revert IVaipakamErrors.StagingNotCovered(key);

        // The four figures the resolution pays, and the four the epochs cover.
        r.needUserFresh = charge.toUser.armedFresh;
        r.needUserRecycled = charge.toUser.recycled;
        r.needTreasuryFresh = charge.toTreasury.armedFresh;
        r.needTreasuryRecycled = charge.toTreasury.recycled;
        r.epochUserFresh = charge.transportUser.armedFresh;
        r.epochUserRecycled = charge.transportUser.recycled;
        r.epochTreasuryFresh = charge.transportTreasury.armedFresh;
        r.epochTreasuryRecycled = charge.transportTreasury.recycled;

        uint256 liveUserFresh = r.needUserFresh - r.epochUserFresh;
        uint256 liveTreasuryFresh = r.needTreasuryFresh - r.epochTreasuryFresh;
        uint256 liveUserRecycled = r.needUserRecycled - r.epochUserRecycled;
        uint256 freshSpend = r.needUserFresh + r.needTreasuryFresh;

        // Coverage as the A1 claim checks it for a whole claim, here for a day:
        // the pool cap over the FULL fresh leg, the backing room over the
        // live fresh, the delivered headroom over the live user fresh. Short
        // on any: not covered, nothing reserved (a deferral, not a scaling).
        if (freshSpend > LibInteractionRewards.poolRemaining()) revert IVaipakamErrors.StagingNotCovered(key);
        if (liveUserFresh + liveTreasuryFresh > LibVpfiRecycle.freshBackingRoom(s)) {
            revert IVaipakamErrors.StagingNotCovered(key);
        }
        if (liveUserFresh > LibInteractionRewards.deliveredFreshBound(s)) revert IVaipakamErrors.StagingNotCovered(key);

        // Reserve, per source, with the figure written on the record.
        s.interactionPoolReserved += freshSpend;
        s.liveFreshReserved += liveUserFresh + liveTreasuryFresh;
        s.rewardBudgetArmedFreshReserved += liveUserFresh;
        s.recycleBucketReserved += liveUserRecycled;
        LibRewardCustody.hold(
            s, LibVaipakam.RewardCustodyRow.Recycled, LibVaipakam.RewardCustodyRow.Resolving, liveUserRecycled, key
        );
        r.heldRecycled = liveUserRecycled;
        r.reservedLiveUserFresh = liveUserFresh;
        r.reservedLiveTreasuryFresh = liveTreasuryFresh;
        r.reservedLiveUserRecycled = liveUserRecycled;
        r.reservedPoolCap = freshSpend;

        // The loan-side cap, per committed entry, and the slices persistence
        // will write — fixed now, so the payout writes what was reserved.
        uint256 n = slices.length;
        r.sliceAmounts = new uint256[](n);
        r.sliceChargeable = new bool[](n);
        uint8 sideKey = uint8(r.side);
        for (uint256 i; i < n; ) {
            r.sliceAmounts[i] = slices[i].amount;
            r.sliceChargeable[i] = slices[i].loanSideChargeable;
            if (slices[i].loanSideChargeable) {
                s.loanSideRewardReservedVpfi[s.rewardEntries[r.entryIds[i]].loanId][sideKey] += slices[i].amount;
            }
            unchecked { ++i; }
        }
        r.phase = LibVaipakam.StagingPhase.Reserved;
        emit StagingReserved(key, liveUserFresh, liveTreasuryFresh, liveUserRecycled, freshSpend);
    }

    // ─────────────────────────────── resolve ──────────────────────────────

    /// @notice Permissionless: one page of resolution. The first page makes
    ///         the record irrevocable (`Resolving`); each page consumes up to
    ///         `STAGING_PAGE` staged batches — leg counters, packet exit,
    ///         references, and the epoch legs held into `Resolving` — and the
    ///         page that consumes the last batch pays the day.
    /// @return done Whether the record was paid and closed by this page.
    function resolvePage(LibVaipakam.Storage storage s, bytes32 key) internal returns (bool done) {
        LibVaipakam.StagingRecord storage r = record(s, key);
        if (r.phase == LibVaipakam.StagingPhase.Reserved) {
            r.phase = LibVaipakam.StagingPhase.Resolving;
        } else {
            _requirePhase(key, r, LibVaipakam.StagingPhase.Resolving);
        }
        uint256 n = r.batchIds.length;
        uint256 i = r.resolveCursor;
        uint256 end = i + STAGING_PAGE;
        if (end > n) end = n;
        uint256 held;
        while (i < end) {
            bytes32 id = r.batchIds[i];
            uint256 bf = r.batchFresh[i];
            uint256 br = r.batchRecycled[i];
            LibVaipakam.TransportBatch storage b = s.transportBatches[id];
            b.stagedFresh -= bf;
            b.stagedRecycled -= br;
            b.consumedFresh += bf;
            b.consumedRecycled += br;
            LibRewardCustody.spendUntypedForDraw(s, id, bf + br);
            s.transportBatchReferences[id] -= 1;
            held += bf + br;
            emit StagingResolvedBatch(id, key, bf, br);
            unchecked { ++i; }
        }
        r.resolveCursor = i;
        if (held != 0) {
            LibRewardCustody.hold(
                s, LibVaipakam.RewardCustodyRow.Unclassified, LibVaipakam.RewardCustodyRow.Resolving, held, key
            );
            r.heldEpoch += held;
        }
        if (i == n) {
            _pay(s, key, r);
            done = true;
        }
    }

    /// @dev The last page. Every hold returns to the row it came from, every
    ///      reserved counter converts to paid, and the day is settled by the
    ///      A1 claim's own primitives for one day: persistence, the pool and
    ///      commitment writes, the delivery, the treasury legs.
    function _pay(LibVaipakam.Storage storage s, bytes32 key, LibVaipakam.StagingRecord storage r) private {
        address user = r.user;
        uint256 liveUserFresh = r.reservedLiveUserFresh;
        uint256 liveTreasuryFresh = r.reservedLiveTreasuryFresh;
        uint256 liveUserRecycled = r.reservedLiveUserRecycled;
        uint256 forfeitRecycled = r.needTreasuryRecycled - r.epochTreasuryRecycled;
        uint256 freshSpend = r.reservedPoolCap;

        // Holds back to their rows: the epoch legs to `Unclassified`, the live
        // recycled to `Recycled` — each an event naming the record.
        LibRewardCustody.releaseHold(
            s, LibVaipakam.RewardCustodyRow.Resolving, LibVaipakam.RewardCustodyRow.Unclassified, r.heldEpoch, key
        );
        LibRewardCustody.releaseHold(
            s, LibVaipakam.RewardCustodyRow.Resolving, LibVaipakam.RewardCustodyRow.Recycled, r.heldRecycled, key
        );
        r.heldEpoch = 0;
        r.heldRecycled = 0;

        // Reserved converts to paid, in the same page.
        s.interactionPoolReserved -= freshSpend;
        s.liveFreshReserved -= liveUserFresh + liveTreasuryFresh;
        s.rewardBudgetArmedFreshReserved -= liveUserFresh;
        s.recycleBucketReserved -= liveUserRecycled;
        uint8 sideKey = uint8(r.side);
        uint256 n = r.entryIds.length;
        LibInteractionRewards.DaySlice[] memory slices = new LibInteractionRewards.DaySlice[](n);
        for (uint256 i; i < n; ) {
            slices[i] = LibInteractionRewards.DaySlice({amount: r.sliceAmounts[i], loanSideChargeable: r.sliceChargeable[i]});
            if (r.sliceChargeable[i]) {
                s.loanSideRewardReservedVpfi[s.rewardEntries[r.entryIds[i]].loanId][sideKey] -= r.sliceAmounts[i];
            }
            unchecked { ++i; }
        }

        // The A1 claim's settlement, for one day.
        LibInteractionRewards._persistDay(s, user, r.side, r.day, r.entryIds, slices);
        s.interactionPoolPaidOut += freshSpend;
        LibInteractionRewards.consumeArmedFresh(freshSpend);
        if (liveUserRecycled != 0) LibVpfiRecycle.consume(liveUserRecycled, false, 0);
        LibInteractionRewards.chargeDeliveredFresh(s, liveUserFresh);

        LibVaipakam.RewardDelivery venue = r.venueSet ? r.venue : LibVaipakam.RewardDelivery.Default;
        // A claimant flagged since preparation is paid into their vault — the
        // close-out completes and the value is theirs, locked where the
        // sanctions path keeps proceeds; nothing is refused mid-walk.
        bool toVault = venue == LibVaipakam.RewardDelivery.Vault
            || (venue == LibVaipakam.RewardDelivery.Default && user.code.length == 0)
            || LibVaipakam.isSanctionedAddress(user);
        uint256 userTotal = liveUserFresh + liveUserRecycled + r.epochUserFresh + r.epochUserRecycled;
        if (userTotal != 0) {
            LibRewardCustody.callDeliverClaim(
                user, liveUserFresh, liveUserRecycled, r.epochUserFresh + r.epochUserRecycled, toVault
            );
        }
        LibRewardCustody.callSettleClaimLegs(
            liveTreasuryFresh,
            r.epochTreasuryFresh + r.epochTreasuryRecycled,
            forfeitRecycled,
            r.epochUserRecycled,
            0
        );
        emit StagingPaid(
            key,
            user,
            liveUserFresh + r.epochUserFresh,
            liveUserRecycled + r.epochUserRecycled,
            liveTreasuryFresh + r.epochTreasuryFresh,
            forfeitRecycled + r.epochTreasuryRecycled,
            uint8(toVault ? LibVaipakam.RewardDelivery.Vault : LibVaipakam.RewardDelivery.Wallet)
        );
        _close(s, key, r, true);
    }

    // ─────────────────────────────── unwind ───────────────────────────────

    /// @notice One page of unwind: past the deadline anyone, before it only
    ///         the claimant (a voluntary cancellation). Each page returns up
    ///         to `STAGING_PAGE` batches' staged components to their balance
    ///         and releases their references; the page that returns the last
    ///         batch releases the reservation, per source, and closes the
    ///         record. A `Resolving` record is beyond reach: it only completes.
    /// @return done Whether the record was closed by this page.
    function unwindPage(LibVaipakam.Storage storage s, bytes32 key, address caller) internal returns (bool done) {
        LibVaipakam.StagingRecord storage r = record(s, key);
        LibVaipakam.StagingPhase p = r.phase;
        if (p == LibVaipakam.StagingPhase.Staging || p == LibVaipakam.StagingPhase.Reserved) {
            if (caller != r.user && block.timestamp < r.deadline) {
                revert IVaipakamErrors.StagingNotExpired(key, r.deadline);
            }
            r.phase = LibVaipakam.StagingPhase.Unwinding;
        } else {
            _requirePhase(key, r, LibVaipakam.StagingPhase.Unwinding);
        }
        uint256 n = r.batchIds.length;
        uint256 i = r.resolveCursor;
        uint256 end = i + STAGING_PAGE;
        if (end > n) end = n;
        while (i < end) {
            bytes32 id = r.batchIds[i];
            uint256 bf = r.batchFresh[i];
            uint256 br = r.batchRecycled[i];
            LibVaipakam.TransportBatch storage b = s.transportBatches[id];
            b.stagedFresh -= bf;
            b.stagedRecycled -= br;
            b.balance += bf + br;
            s.transportBatchReferences[id] -= 1;
            emit StagingUnwoundBatch(id, key, bf, br);
            unchecked { ++i; }
        }
        r.resolveCursor = i;
        if (i == n) {
            // The reservation, if one was taken, by its recorded provenance.
            if (r.reservedPoolCap != 0 || r.heldRecycled != 0 || r.reservedLiveUserFresh + r.reservedLiveTreasuryFresh != 0) {
                s.interactionPoolReserved -= r.reservedPoolCap;
                s.liveFreshReserved -= r.reservedLiveUserFresh + r.reservedLiveTreasuryFresh;
                s.rewardBudgetArmedFreshReserved -= r.reservedLiveUserFresh;
                s.recycleBucketReserved -= r.reservedLiveUserRecycled;
                LibRewardCustody.releaseHold(
                    s, LibVaipakam.RewardCustodyRow.Resolving, LibVaipakam.RewardCustodyRow.Recycled, r.heldRecycled, key
                );
                uint8 sideKey = uint8(r.side);
                uint256 m = r.sliceAmounts.length;
                for (uint256 j; j < m; ) {
                    if (r.sliceChargeable[j]) {
                        s.loanSideRewardReservedVpfi[s.rewardEntries[r.entryIds[j]].loanId][sideKey] -= r.sliceAmounts[j];
                    }
                    unchecked { ++j; }
                }
            }
            _close(s, key, r, false);
            done = true;
        }
    }

    // ─────────────────────────────── internals ────────────────────────────

    /// @dev Re-price the record's day with its staged legs as the ONLY
    ///      transport (`preparedOnly`): the A1 day primitive, one day, the
    ///      live budget as a fresh claim would read it.
    function _price(
        LibVaipakam.Storage storage s,
        LibVaipakam.StagingRecord storage r
    ) private view returns (LibInteractionRewards.DayCharge memory charge, LibInteractionRewards.DaySlice[] memory slices) {
        LibInteractionRewards.PoolBudget memory pool = LibInteractionRewards.PoolBudget({
            fresh: LibInteractionRewards.poolRemaining(),
            recycled: LibVpfiRecycle.bucketAvailable(s),
            deliveredFresh: LibInteractionRewards.deliveredFreshBound(s),
            domainFresh: type(uint256).max,
            domainRecycled: type(uint256).max
        });
        LibInteractionRewards.DryRunState memory dry = LibInteractionRewards._noDryRun();
        dry.preparedOnly = true;
        dry.preparedFresh = r.stagedFresh;
        dry.preparedRecycled = r.stagedRecycled;
        (charge, slices) = LibInteractionRewards.processUserSideDay(r.user, r.day, r.entryIds, pool, dry);
    }

    function _close(LibVaipakam.Storage storage s, bytes32 key, LibVaipakam.StagingRecord storage r, bool paid) private {
        emit StagingRecordClosed(key, paid);
        delete s.stagingRecords[key];
        r; // silence: the storage pointer is dead after the delete
    }
}
