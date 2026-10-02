// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibRewardCustody} from "./LibRewardCustody.sol";
import {LibInteractionRewards} from "./LibInteractionRewards.sol";
import {LibVpfiRecycle} from "./LibVpfiRecycle.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

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
    // `StagingVenueSet` is the custody library's: the venue is bound there,
    // by the claimant's explicit claim at opening and by {setVenue} alike.
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
    ///         treasury's fresh and recycled, by source. Where the user's
    ///         share went is {StagingDelivered}'s to say — or
    ///         {StagingClaimantForfeited}'s; this event claims no venue.
    /// @custom:event-category state-change/reward-staging
    event StagingPaid(
        bytes32 indexed key,
        address indexed user,
        uint256 userFresh,
        uint256 userRecycled,
        uint256 treasuryFresh,
        uint256 treasuryRecycled
    );
    /// @notice The record's user share — `amount`, every source — was
    ///         DELIVERED to `user` at `venue`: the venue the delivery actually
    ///         reached (the vault, or the wallet by choice or by fallback).
    ///         Emitted only when a delivery happened; a forfeited share emits
    ///         {StagingClaimantForfeited} instead, so no consumer reads a
    ///         venue for value that never moved to the claimant (Codex #2308
    ///         r22).
    /// @custom:event-category state-change/reward-staging
    event StagingDelivered(bytes32 indexed key, address indexed user, uint256 amount, uint8 venue);
    /// @notice The record's claimant `user` is sanctions-flagged, so the
    ///         day's user share — `fresh` and `recycled`, every source — was
    ///         FORFEITED into the recycle bucket instead of delivered, with the
    ///         treasury's own forfeit legs (owner decision 2026-10-02: reward
    ///         VPFI not yet delivered to a flagged wallet is forfeited; value
    ///         already in their vault stays frozen). `StagingPaid` for the same
    ///         record reports the user figures as zero.
    /// @custom:event-category state-change/reward-staging
    event StagingClaimantForfeited(bytes32 indexed key, address indexed user, uint256 fresh, uint256 recycled);
    /// @notice An unwind page returned `batchId`'s staged components for `key`.
    /// @custom:event-category state-change/reward-staging
    event StagingUnwoundBatch(bytes32 indexed batchId, bytes32 indexed key, uint256 fresh, uint256 recycled);
    /// @notice The record is gone: unwound (`paid == false`) or paid.
    /// @custom:event-category state-change/reward-staging
    event StagingRecordClosed(bytes32 indexed key, bool paid);
    /// @notice A non-settlement release started the obligation's cooldown:
    ///         until `until`, a claim on this key opens no record and defers
    ///         as before staging existed (Codex #2308 r7; read back through
    ///         {RewardEpochViewFacet.getStagingCooldown}).
    /// @custom:event-category state-change/reward-staging
    event StagingCooldownSet(bytes32 indexed key, uint64 until);

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
        LibRewardCustody.bindStagingVenue(key, r, venue);
    }

    // ─────────────────────────────── prepare ──────────────────────────────

    /// @notice Permissionless: continue staging the record's day from its
    ///         continuation — the day's late chain first, then the list from
    ///         where the last scan stopped — up to one window, then re-size
    ///         the deadline. Derives the obligation from storage; the caller
    ///         supplies only the key. A record the walk opened has no
    ///         continuation yet: its first preparation rescans the walk's
    ///         window from the day's cursor, the one page that lets one
    ///         scanner dispose of every epoch the window passed (Codex #2308
    ///         r4).
    /// @dev The ask is transport-first, as A1's allocation is: the day's two
    ///      needs less what is already staged, not merely the live shortfall.
    ///      The record's own commitment is what is re-priced, so an entry
    ///      that changed lifecycle since makes the pricing revert
    ///      (`RewardEntrySetMismatch`) — a stale record is unwound, never
    ///      repriced in place.
    function prepare(LibVaipakam.Storage storage s, bytes32 key) internal returns (uint256 stagedFresh, uint256 stagedRecycled) {
        LibVaipakam.StagingRecord storage r = record(s, key);
        _requirePhase(key, r, LibVaipakam.StagingPhase.Staging);
        // A record that passed more pending epochs than it tracks can only be
        // unwound (Codex #2308 r6): preparing it further would reference more
        // shared epochs for a day that can never settle through it.
        if (r.pendingOverflow) revert IVaipakamErrors.StagingPendingOverflow(key);
        (uint256 askF, uint256 askR) = _ask(s, key, r);
        // Nothing left to ask for still scans to the end: the reservation
        // needs the whole list seen, not merely the need met.
        (stagedFresh, stagedRecycled) = _scanAndStage(s, key, r, askF, askR);
        LibRewardCustody.stagingDeadlineRefresh(s, key, r);
    }

    /// @dev The transport the record still asks for: the day's two needs less
    ///      what is already staged — transport-first, as A1's allocation is.
    ///      A day another obligation's loan-side reservation defers has no
    ///      need to read (Codex #2308 r4): the preparation refuses rather
    ///      than scan with an ask of nothing, which would pass stageable
    ///      epochs the record could never be offered again.
    function _ask(
        LibVaipakam.Storage storage s,
        bytes32 key,
        LibVaipakam.StagingRecord storage r
    ) private view returns (uint256 askF, uint256 askR) {
        (LibInteractionRewards.DayCharge memory charge, ) = _price(s, r);
        if (charge.loanSideReserved) revert IVaipakamErrors.StagingNotCovered(key);
        // The fresh need is bounded by the pool's HARD headroom — the
        // lifetime cap trims terminally, so fresh past it can never be paid
        // to this obligation and staging it would only reference epochs
        // other days need (Codex #2308 r9). The scan still runs to the
        // list's end on an ask of nothing: the reservation needs it whole.
        uint256 needF = charge.needFresh;
        uint256 hard = LibInteractionRewards.poolRemaining();
        if (needF > hard) needF = hard;
        askF = needF > r.stagedFresh ? needF - r.stagedFresh : 0;
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
        // A late link that landed behind this record's place in the chain
        // bumped the day's late generation: restart the late walk from the
        // chain's head (Codex #2308 r2).
        uint256 gen = s.transportDayLateGen[r.day];
        if (gen != r.lateGenSeen) {
            r.lateSeen = bytes32(0);
            r.lateGenSeen = gen;
            // The restart re-walks the whole chain, history included: the
            // pages that walk needs — at least one — are forced on the
            // record, and the deadline counts them for every restart, not
            // only the first (Codex #2308 r5, r10, r22).
            r.forcedPages += LibRewardCustody.scanPagesOf(s.transportDayLateCount[r.day]);
        } else if (LibRewardCustody.forcedScanItems(s, r) != 0) {
            // A call FORCED after the scan had completed — the list grew, a
            // restoration landed, a passed epoch became stageable — is a page
            // of its own in the lease (Codex #2308 r22), however little it
            // walks; read before this scan takes the work. A call with
            // nothing new counts nothing: the stager cannot lengthen the
            // lease by calling.
            ++r.forcedPages;
        }
        (
            bytes32[] memory ids,
            uint256[] memory fresh,
            uint256[] memory recycled,
            bytes32 lastNode,
            bytes32 lastLate,
            bool complete,
            bytes32[] memory skipped
        ) = LibRewardCustody.planTakesForRecord(
            s, r.day, r.continuationNode, r.lateSeen, askF, askR, LibRewardCustody.recheckPage(s, r)
        );
        if (lastNode != bytes32(0)) r.continuationNode = lastNode;
        if (lastLate != bytes32(0)) r.lateSeen = lastLate;
        // Every remembered epoch re-checked stageable this time is forgotten
        // FIRST, staged or not: it was offered, and it will not be offered
        // twice. Then the epochs this scan passed over pending — untyped, or
        // not yet whole — are remembered. In that order (Codex #2308 r8): the
        // page cap is enforced against the RECONCILED set, so a full page
        // that frees places by re-checking does not overflow on the epochs
        // it takes in the same scan.
        bytes32[] memory rechecked = r.skippedIds;
        for (uint256 k; k < rechecked.length; ) {
            LibRewardCustody.forgetSkippedIfStageable(s, key, r, rechecked[k]);
            unchecked { ++k; }
        }
        for (uint256 k; k < skipped.length; ) {
            LibRewardCustody.noteSkipped(s, key, r, skipped[k]);
            unchecked { ++k; }
        }
        // The scan reached the end of the day's list: the reservation may
        // proceed as long as the list has not grown since.
        r.scanComplete = complete;
        if (complete) r.listCountSeen = s.transportBatchesByDay[r.day].length;
        // The page that overflowed the pending count stages nothing: the
        // record is unwindable from here, and nothing more is referenced
        // for it (Codex #2308 r6).
        if (r.pendingOverflow || ids.length == 0) return (0, 0);
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
        // A record that passed more pending epochs than it tracks can only be
        // unwound: the terminal refusal, named first (Codex #2308 r2, r6).
        if (r.pendingOverflow) revert IVaipakamErrors.StagingPendingOverflow(key);
        // Transport first: nothing is reserved from the live sources while
        // the day's list still has epochs no preparation has scanned, or has
        // grown since the last one did (Codex #2308 r1).
        if (!r.scanComplete || s.transportBatchesByDay[r.day].length != r.listCountSeen) {
            revert IVaipakamErrors.StagingScanIncomplete(key);
        }
        // Nor while a late link landed behind the record's place, or an epoch
        // it passed over pending has become stageable since (Codex #2308 r2, r4).
        if (s.transportDayLateGen[r.day] != r.lateGenSeen || LibRewardCustody.anySkippedNowStageable(s, r)) {
            revert IVaipakamErrors.StagingScanIncomplete(key);
        }
        // Nor while an epoch was RESTORED on the day since the record last
        // read the restore log (Codex #2308 r15): a restoration moves neither
        // the list's length nor its late generation, and the restored epoch
        // may be one this record's scan saw drained.
        if (r.restoredSeen != s.transportDayRestored[r.day].length) {
            revert IVaipakamErrors.StagingScanIncomplete(key);
        }
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
        // What the lifetime caps trimmed: paid to no one, its commitment
        // retired at payout as the ordinary claim retires it.
        r.cappedOffFresh = charge.cappedOff.armedFresh;
        r.cappedOffRecycled = charge.cappedOff.recycled;
        // What the resolution may consume of the staged components; the
        // rest returns to its epochs page by page.
        r.consumeFreshLeft = r.epochUserFresh + r.epochTreasuryFresh;
        r.consumeRecycledLeft = r.epochUserRecycled + r.epochTreasuryRecycled;

        uint256 liveUserFresh = r.needUserFresh - r.epochUserFresh;
        uint256 liveTreasuryFresh = r.needTreasuryFresh - r.epochTreasuryFresh;
        uint256 liveUserRecycled = r.needUserRecycled - r.epochUserRecycled;
        uint256 freshSpend = r.needUserFresh + r.needTreasuryFresh;

        // Coverage as the A1 claim checks it for a whole claim, here for a day:
        // the pool cap over the FULL fresh leg, the backing room over the
        // live fresh, the delivered headroom over the live user fresh. Short
        // on any: not covered, nothing reserved (a deferral, not a scaling).
        if (freshSpend > LibInteractionRewards.poolAvailable()) revert IVaipakamErrors.StagingNotCovered(key);
        if (liveUserFresh + liveTreasuryFresh > LibVpfiRecycle.freshBackingRoom(s)) {
            revert IVaipakamErrors.StagingNotCovered(key);
        }
        // Both live fresh destinations charge the delivered ledger at payout
        // — the user's through the delivery, the treasury's through the
        // absorption — so both are reserved on it (Codex #2308 r1).
        if (liveUserFresh + liveTreasuryFresh > LibInteractionRewards.deliveredFreshBound(s)) {
            revert IVaipakamErrors.StagingNotCovered(key);
        }

        // Reserve, per source, with the figure written on the record.
        s.interactionPoolReserved += freshSpend;
        s.liveFreshReserved += liveUserFresh + liveTreasuryFresh;
        s.rewardBudgetArmedFreshReserved += liveUserFresh + liveTreasuryFresh;
        s.recycleBucketReserved += liveUserRecycled;
        // The hold is a custody-row move; while custody is inactive the
        // Diamond's balance backs the payout as it backs a claim's, and the
        // recycled residual is reserved by count alone (Codex #2308 r3).
        if (LibRewardCustody.active(s)) {
            LibRewardCustody.hold(
                s, LibVaipakam.RewardCustodyRow.Recycled, LibVaipakam.RewardCustodyRow.Resolving, liveUserRecycled, key
            );
            r.heldRecycled = liveUserRecycled;
        }
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
        r.wasReserved = true;
        // Encumbered from here until the reservation is released (Codex #2308
        // r7, r13): no posture change — the custody activation, a reward-role
        // transition — may straddle it.
        ++s.stagingEncumberedCount;
        emit StagingReserved(key, liveUserFresh, liveTreasuryFresh, liveUserRecycled, freshSpend);
    }

    // ─────────────────────────────── resolve ──────────────────────────────

    /// @notice Permissionless: one page of resolution. The first page makes
    ///         the record irrevocable (`Resolving`); each page consumes up to
    ///         `STAGING_PAGE` staged batches from the list's tail, popping each
    ///         — leg counters, packet exit, references, and the epoch legs
    ///         held into `Resolving` — and the page that consumes the last
    ///         batch pays the day and closes a record whose arrays are then
    ///         bounded (Codex #2308 r12).
    /// @return done Whether the record was paid and closed by this page.
    function resolvePage(LibVaipakam.Storage storage s, bytes32 key) internal returns (bool done) {
        LibVaipakam.StagingRecord storage r = record(s, key);
        if (r.phase == LibVaipakam.StagingPhase.Reserved) {
            r.phase = LibVaipakam.StagingPhase.Resolving;
        } else {
            _requirePhase(key, r, LibVaipakam.StagingPhase.Resolving);
        }
        // In the order the plan STAGED them, from the record's cursor (Codex
        // #2308 r12, r13): the consumption budget the reservation assigned can
        // run out partway, and what it runs out on must be the epochs the plan
        // ranked last — a reverse walk spent those and returned the ones the
        // plan ranked first. The batches are not held in the record's struct
        // (they are its one unbounded state), so each is released as it is
        // processed and the close stays bounded either way.
        uint256 n = r.batchCount;
        uint256 i = r.resolveCursor;
        uint256 end = i + STAGING_PAGE;
        if (end > n) end = n;
        uint256 held;
        while (i < end) {
            LibVaipakam.StagedBatch storage sb = LibRewardCustody.stagedBatchAt(s, key, r, i);
            bytes32 id = sb.id;
            uint256 bf = sb.fresh;
            uint256 br = sb.recycled;
            LibVaipakam.TransportBatch storage b = s.transportBatches[id];
            // Consume only what the reservation assigned; a staged amount
            // beyond it goes back to the epoch here, never consumed unpaid
            // (Codex #2308 r1).
            uint256 cf = bf > r.consumeFreshLeft ? r.consumeFreshLeft : bf;
            uint256 cr = br > r.consumeRecycledLeft ? r.consumeRecycledLeft : br;
            r.consumeFreshLeft -= cf;
            r.consumeRecycledLeft -= cr;
            b.stagedFresh -= bf;
            b.stagedRecycled -= br;
            b.consumedFresh += cf;
            b.consumedRecycled += cr;
            if (bf - cf + br - cr != 0) {
                b.balance += bf - cf + br - cr;
                // Back in its batch, so out of the staged earmark. The
                // CONSUMED share stays earmarked: it is still owed to the
                // claimant until the last page pays it (Codex #2308 r14).
                LibRewardCustody.releaseStagedEarmark(s, bf - cf + br - cr);
                emit StagingUnwoundBatch(id, key, bf - cf, br - cr);
                LibRewardCustody.offerRestored(s, r.day, id);
            }
            if (cf + cr != 0) LibRewardCustody.spendUntypedForDraw(s, id, cf + cr);
            s.transportBatchReferences[id] -= 1;
            held += cf + cr;
            emit StagingResolvedBatch(id, key, cf, cr);
            // The record no longer holds this batch's components, and the
            // Diamond's staged earmark no longer covers them (Codex #2308 r13).
            r.stagedFresh -= bf;
            r.stagedRecycled -= br;
            LibRewardCustody.releaseStagedBatchAt(s, key, r, i);
            unchecked { ++i; }
        }
        r.resolveCursor = i;
        if (held != 0 && LibRewardCustody.active(s)) {
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
        uint256 freshSpend = r.reservedPoolCap;
        // A claimant flagged by the sanctions oracle is not paid: reward VPFI
        // not yet delivered to a flagged wallet is FORFEITED, while value
        // already in their vault stays frozen there (owner decision
        // 2026-10-02, rewards only — loan proceeds keep the wind-down freeze).
        // Their share settles exactly as the day's forfeit (treasury) leg
        // does, into the recycle bucket, so this page cannot fail for it and
        // the record can never be trapped in `Resolving` (Codex #2308 r18,
        // r21: a vault-only delivery reverted for a claimant with no vault).
        bool forfeit = LibVaipakam.isSanctionedAddress(user);
        // What the pages CONSUMED of the epochs is paid out below, so it
        // leaves the staged earmark here and not a page earlier (Codex #2308
        // r14): the budget the reservation assigned, less what the batches
        // could not fill. Both terms are the record's own.
        LibRewardCustody.releaseStagedEarmark(
            s,
            (r.epochUserFresh + r.epochTreasuryFresh - r.consumeFreshLeft)
                + (r.epochUserRecycled + r.epochTreasuryRecycled - r.consumeRecycledLeft)
        );

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
        --s.stagingEncumberedCount;
        s.interactionPoolReserved -= freshSpend;
        s.liveFreshReserved -= liveUserFresh + liveTreasuryFresh;
        s.rewardBudgetArmedFreshReserved -= liveUserFresh + liveTreasuryFresh;
        s.recycleBucketReserved -= liveUserRecycled;
        uint8 sideKey = uint8(r.side);
        uint256 n = r.entryIds.length;
        LibInteractionRewards.DaySlice[] memory slices = new LibInteractionRewards.DaySlice[](n);
        for (uint256 i; i < n; ) {
            // A FORFEITED share is persisted as NOT chargeable (Codex #2308
            // r22): the loan side's reward cap bounds what is emitted to the
            // side, and a share recycled instead of paid is not — the one
            // rule the day pricing stamps on every forfeit's slices
            // ({LibInteractionRewards._priceEntriesForDay}), applied here
            // because the flag was stamped at reservation, before the
            // claimant was flagged. The stored flag still releases the
            // reservation it took, just below.
            slices[i] = LibInteractionRewards.DaySlice({
                amount: r.sliceAmounts[i],
                loanSideChargeable: r.sliceChargeable[i] && !forfeit
            });
            if (r.sliceChargeable[i]) {
                s.loanSideRewardReservedVpfi[s.rewardEntries[r.entryIds[i]].loanId][sideKey] -= r.sliceAmounts[i];
            }
            unchecked { ++i; }
        }

        // The A1 claim's settlement, for one day.
        LibInteractionRewards._persistDay(s, user, r.side, r.day, r.entryIds, slices);
        s.interactionPoolPaidOut += freshSpend;
        // The commitment retires by the full figure, the capped-off fresh
        // included, as the ordinary claim retires it.
        LibInteractionRewards.consumeArmedFresh(freshSpend + r.cappedOffFresh);
        if (!forfeit) {
            // Paid: the recycled leaves the bucket, the live fresh is charged
            // to the delivered ledger. Forfeited, neither happens here — the
            // settlement below absorbs the live fresh through the bounding
            // operation (which charges that ledger itself) and releases the
            // recycled commitment without a bucket debit.
            if (liveUserRecycled != 0) LibVpfiRecycle.consume(liveUserRecycled, false, 0);
            LibInteractionRewards.chargeDeliveredFresh(s, liveUserFresh);
        }

        LibVaipakam.RewardDelivery venue = r.venueSet ? r.venue : LibVaipakam.RewardDelivery.Default;
        bool toVault = venue == LibVaipakam.RewardDelivery.Vault
            || (venue == LibVaipakam.RewardDelivery.Default && user.code.length == 0);
        uint256 userTotal = liveUserFresh + liveUserRecycled + r.epochUserFresh + r.epochUserRecycled;
        bool vaulted;
        if (forfeit) {
            emit StagingClaimantForfeited(
                key, user, liveUserFresh + r.epochUserFresh, liveUserRecycled + r.epochUserRecycled
            );
        } else if (userTotal != 0 && !LibRewardCustody.active(s)) {
            // Custody inactive: the Diamond's balance pays, as it pays a
            // claim — the vault where the venue asks for it, the wallet
            // otherwise.
            vaulted = _payFromDiamond(s, user, userTotal, toVault);
        } else if (userTotal != 0) {
            vaulted = LibRewardCustody.callDeliverClaim(
                user, liveUserFresh, liveUserRecycled, r.epochUserFresh + r.epochUserRecycled, toVault
            );
        }
        // A forfeited claimant's share joins the treasury's forfeit legs, by
        // the same three operations: live fresh absorbed into the bucket, epoch
        // legs absorbed in place, the recycled commitment released.
        uint256 forfeitLive = forfeit ? liveUserFresh : 0;
        uint256 forfeitEpoch = forfeit ? r.epochUserFresh + r.epochUserRecycled : 0;
        uint256 forfeitRecycled = forfeit ? liveUserRecycled + r.epochUserRecycled : 0;
        LibRewardCustody.callSettleClaimLegs(
            liveTreasuryFresh + forfeitLive,
            r.epochTreasuryFresh + r.epochTreasuryRecycled + forfeitEpoch,
            // The treasury's whole recycled figure — the claim path's own
            // argument (`res.toTreasury.recycled`), so the two paths state ONE
            // formula (Codex #2308 r18). The epoch-funded share it once
            // subtracted is zero by construction: the day's transport ask sums
            // only loan-side-chargeable recycled (the user's leg), and a
            // forfeit's or expiry's recycled is a commitment release that asks
            // the epochs for nothing — so `epochTreasuryRecycled` cannot be
            // non-zero, and nothing changes in value; only the two statements
            // can no longer drift apart if that ever changes.
            r.needTreasuryRecycled + r.cappedOffRecycled + forfeitRecycled,
            forfeit ? 0 : r.epochUserRecycled,
            0
        );
        if (!forfeit && userTotal != 0) {
            emit StagingDelivered(
                key, user, userTotal, uint8(vaulted ? LibVaipakam.RewardDelivery.Vault : LibVaipakam.RewardDelivery.Wallet)
            );
        }
        emit StagingPaid(
            key,
            user,
            forfeit ? 0 : liveUserFresh + r.epochUserFresh,
            forfeit ? 0 : liveUserRecycled + r.epochUserRecycled,
            liveTreasuryFresh + r.epochTreasuryFresh,
            r.needTreasuryRecycled
        );
        _close(s, key, true);
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
        // From the record's cursor, releasing each (Codex #2308 r12, r13) —
        // as the resolution walks it.
        uint256 n = r.batchCount;
        uint256 i = r.resolveCursor;
        uint256 end = i + STAGING_PAGE;
        if (end > n) end = n;
        while (i < end) {
            LibVaipakam.StagedBatch storage sb = LibRewardCustody.stagedBatchAt(s, key, r, i);
            bytes32 id = sb.id;
            uint256 bf = sb.fresh;
            uint256 br = sb.recycled;
            LibVaipakam.TransportBatch storage b = s.transportBatches[id];
            b.stagedFresh -= bf;
            b.stagedRecycled -= br;
            b.balance += bf + br;
            s.transportBatchReferences[id] -= 1;
            // All of it returns to the batch, so all of it leaves the earmark.
            LibRewardCustody.releaseStagedEarmark(s, bf + br);
            emit StagingUnwoundBatch(id, key, bf, br);
            LibRewardCustody.offerRestored(s, r.day, id);
            r.stagedFresh -= bf;
            r.stagedRecycled -= br;
            LibRewardCustody.releaseStagedBatchAt(s, key, r, i);
            unchecked { ++i; }
        }
        r.resolveCursor = i;
        if (i == n) {
            // The reservation, if one was taken, by its recorded provenance —
            // judged by the fact of the reservation, never by which sources
            // it happened to touch (Codex #2308 r2).
            if (r.wasReserved) {
                --s.stagingEncumberedCount;
                s.interactionPoolReserved -= r.reservedPoolCap;
                s.liveFreshReserved -= r.reservedLiveUserFresh + r.reservedLiveTreasuryFresh;
                s.rewardBudgetArmedFreshReserved -= r.reservedLiveUserFresh + r.reservedLiveTreasuryFresh;
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
            // A non-settlement release: the same obligation may not open a
            // new record until the cooldown passes; the restored coverage is
            // the window's meanwhile.
            uint64 until = uint64(block.timestamp) + LibRewardCustody.STAGING_GRACE;
            s.stagingCooldownUntil[key] = until;
            emit StagingCooldownSet(key, until);
            _close(s, key, false);
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

    /// @dev The claim facet's inactive-custody delivery, for one record: the
    ///      vault credit from the Diamond's balance, else a wallet transfer —
    ///      never the wallet for a flagged claimant.
    function _payFromDiamond(
        LibVaipakam.Storage storage s,
        address user,
        uint256 amount,
        bool toVault
    ) private returns (bool vaulted) {
        address vpfi = s.vpfiToken;
        if (toVault) {
            (bool ok, ) = address(this).call(
                abi.encodeWithSignature("vaultCreditFromDiamondERC20(address,address,uint256)", user, vpfi, amount)
            );
            if (ok) return true;
        }
        SafeERC20.safeTransfer(IERC20(vpfi), user, amount);
    }

    /// @dev The close is BOUNDED (Codex #2308 r12, r13): the record's staged
    ///      batches are not in the struct — the pages released each as they
    ///      processed it — so this deletes the day's entry set, its slices and
    ///      the pending page of at most one window, and nothing that grew
    ///      across calls.
    function _close(LibVaipakam.Storage storage s, bytes32 key, bool paid) private {
        emit StagingRecordClosed(key, paid);
        delete s.stagingRecords[key];
    }
}
