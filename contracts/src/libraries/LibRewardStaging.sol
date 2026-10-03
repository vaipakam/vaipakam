// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibRewardCustody} from "./LibRewardCustody.sol";
import {LibInteractionRewards} from "./LibInteractionRewards.sol";
import {LibVpfiRecycle} from "./LibVpfiRecycle.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

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
    /// @notice Record `key` is STALE: `entryId`, one of its committed
    ///         entries, changed lifecycle since the reservation — forfeited,
    ///         defaulted, liquidated, expired, or closed before the day — so
    ///         its committed destination split no longer matches what the
    ///         live primitive would route. It is unwound, never resolved on
    ///         that split (the ratified design's revalidation at the first
    ///         irreversible page; Codex #2308 r23): emitted by the resolution
    ///         page that found it, or by the unwind anyone may run at once.
    /// @custom:event-category state-change/reward-staging
    event StagingRecordStale(bytes32 indexed key, uint256 indexed entryId);
    /// @notice The record is gone: unwound (`paid == false`) or paid.
    /// @custom:event-category state-change/reward-staging
    event StagingRecordClosed(bytes32 indexed key, bool paid);
    /// @notice A multi-chunk claim DOMAIN opened for `user` on `side` (A2-ii):
    ///         its committed extent `[firstDay, lastDay]` and the settlement
    ///         chunks it spans.
    /// @custom:event-category state-change/reward-staging
    event StagingDomainOpened(bytes32 indexed domainKey, address indexed user, uint8 side, uint64 firstDay, uint64 lastDay, uint256 chunks);
    /// @notice The domain moved to `phase` ({LibVaipakam.DomainPhase}).
    /// @custom:event-category state-change/reward-staging
    event StagingDomainPhase(bytes32 indexed domainKey, uint8 phase);
    /// @notice The domain's reservation cursor stopped at `day`: that day's
    ///         live sources or cap headroom cannot bear its residual; nothing
    ///         is paid, the days before stand reserved, the domain waits.
    /// @custom:event-category state-change/reward-staging
    event StagingDomainReserveStopped(bytes32 indexed domainKey, uint64 day);
    /// @notice The domain is gone: cleared after resolving every day
    ///         (`paid == true`) or after unwinding (`paid == false`).
    /// @custom:event-category state-change/reward-staging
    event StagingDomainCleared(bytes32 indexed domainKey, bool paid);
    /// @notice A non-settlement release started the obligation's cooldown:
    ///         until `until`, a claim on this key opens no record and defers
    ///         as before staging existed (Codex #2308 r7; read back through
    ///         {RewardEpochViewFacet.getStagingCooldown}).
    /// @custom:event-category state-change/reward-staging
    /// @notice The record under `key` (opened at `openedAt`) registered for
    ///         `batchId`'s open priority window; the oldest registrant stages
    ///         the batch first once the window closes (A2-ii).
    /// @custom:event-category state-change/reward-staging
    event TransportBatchWaiterRegistered(bytes32 indexed batchId, bytes32 indexed key, uint64 openedAt);

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
        if (s.stagingRecords[key].domainKey != bytes32(0)) {
            revert IVaipakamErrors.StagingRecordInDomain(key, s.stagingRecords[key].domainKey);
        }
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
        if (r.op == LibVaipakam.StagingOp.LegacySlice) {
            // A legacy-slice day (A2-ii (c)): the day's share of the slice,
            // fresh only, less what the record already holds; the day
            // primitive never prices a pre-`D*` day.
            (uint256 needD, ) = LibInteractionRewards.legacyDayNeed(s, r.entryIds[0], r.day); // priced: the record opened on a priced day
            return (needD > r.stagedFresh ? needD - r.stagedFresh : 0, 0);
        }
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
        bool restart = gen != r.lateGenSeen;
        if (restart) {
            r.lateSeen = bytes32(0);
            r.lateGenSeen = gen;
            // The restart re-walks the whole chain, history included: the
            // pages that walk needs — at least one — are forced on the
            // record, and the deadline counts them for every restart, not
            // only the first (Codex #2308 r5, r10, r22).
            r.forcedPages += LibRewardCustody.scanPagesOf(s.transportDayLateCount[r.day]);
        }
        // A call FORCED after the scan had completed — the list grew, a
        // restoration landed, a passed epoch became stageable — is a page of
        // its own in the lease (Codex #2308 r22), however little it walks. It
        // counts only when the call CONSUMED forced work (the figure fell): a
        // call that could act on nothing — every restoration still withheld by
        // its window, say — counts nothing, so the stager cannot lengthen the
        // lease by calling (A2-ii).
        uint256 forcedBefore = restart ? 0 : LibRewardCustody.forcedScanItems(s, r);
        LibRewardCustody.RecordTakes memory p = LibRewardCustody.planTakesForRecord(
            s, r.day, r.continuationNode, r.lateSeen, askF, askR, LibRewardCustody.recheckPage(s, r),
            LibRewardCustody.recordNonceKey(key, r.nonce)
        );
        if (p.lastNode != bytes32(0)) r.continuationNode = p.lastNode;
        if (p.lastLate != bytes32(0)) r.lateSeen = p.lastLate;
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
        for (uint256 k; k < p.skipped.length; ) {
            LibRewardCustody.noteSkipped(s, key, r, p.skipped[k]);
            unchecked { ++k; }
        }
        // The scan reached the end of the day's list: the reservation may
        // proceed as long as the list has not grown since.
        r.scanComplete = p.complete;
        if (p.complete) r.listCountSeen = s.transportBatchesByDay[r.day].length;
        if (forcedBefore != 0 && LibRewardCustody.forcedScanItems(s, r) < forcedBefore) ++r.forcedPages;
        // The page that overflowed the pending count stages nothing: the
        // record is unwindable from here, and nothing more is referenced
        // for it (Codex #2308 r6).
        if (r.pendingOverflow || p.ids.length == 0) {
            // Nothing to take this page, and the record is short: every
            // contested epoch it passed is one it may register on (A2-ii).
            LibRewardCustody.noteContested(s, key, r, p.contested);
            return (0, 0);
        }
        (stagedFresh, stagedRecycled) = LibRewardCustody.stageTakes(s, key, r, p.ids, p.fresh, p.recycled);
        if (askF + askR > stagedFresh + stagedRecycled) LibRewardCustody.noteContested(s, key, r, p.contested);
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
        if (r.domainKey != bytes32(0)) revert IVaipakamErrors.StagingRecordInDomain(key, r.domainKey);
        if (!_reserve(s, key, r)) revert IVaipakamErrors.StagingNotCovered(key);
    }

    /// @notice A DOMAIN record's reservation (A2-ii): the per-record step
    ///         {reserveDomainPage} drives by Diamond self-call, hosted on the
    ///         record facet that already inlines {_reserve}. Only a domain's
    ///         record; a short day returns false (the page stops), never reverts.
    function reserveInDomain(LibVaipakam.Storage storage s, bytes32 key) internal returns (bool ok) {
        LibVaipakam.StagingRecord storage r = record(s, key);
        if (r.domainKey == bytes32(0)) revert IVaipakamErrors.StagingRecordNotInDomain(key);
        return _reserve(s, key, r);
    }

    /// @dev The reservation primitive (A2-ii): true when the day is covered
    ///      and now reserved; false when the live sources or the cap headroom
    ///      cannot bear its residual — the standalone entry reverts on that,
    ///      the domain page STOPS on it. Every other refusal reverts as before.
    function _reserve(LibVaipakam.Storage storage s, bytes32 key, LibVaipakam.StagingRecord storage r) private returns (bool) {
        _requirePhase(key, r, LibVaipakam.StagingPhase.Staging);
        // A record that passed more pending epochs than it tracks can only be
        // unwound: the terminal refusal, named first (Codex #2308 r2, r6).
        if (r.pendingOverflow) revert IVaipakamErrors.StagingPendingOverflow(key);
        // Transport first: nothing is reserved from the live sources while
        // the day's list still has epochs no preparation has scanned, or has
        // grown since the last one did (Codex #2308 r1).
        // Nor while a late link landed behind the record's place, an epoch it
        // passed over pending has become stageable since (Codex #2308 r2, r4),
        // or an epoch was RESTORED on the day since the record last read the
        // restore log (r15). ONE predicate, shared with the static read
        // ({LibRewardCustody.recordScanSettled}).
        if (!LibRewardCustody.recordScanSettled(s, r)) {
            revert IVaipakamErrors.StagingScanIncomplete(key);
        }
        (LibInteractionRewards.DayCharge memory charge, LibInteractionRewards.DaySlice[] memory slices) = _price(s, r);
        if (!charge.advanced) return false;

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
        if (freshSpend > LibInteractionRewards.poolAvailable()) return false;
        if (liveUserFresh + liveTreasuryFresh > LibVpfiRecycle.freshBackingRoom(s)) {
            return false;
        }
        // Both live fresh destinations charge the delivered ledger at payout
        // — the user's through the delivery, the treasury's through the
        // absorption — so both are reserved on it (Codex #2308 r1).
        if (liveUserFresh + liveTreasuryFresh > LibInteractionRewards.deliveredFreshBound(s)) {
            return false;
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
                uint256 loanId = s.rewardEntries[r.entryIds[i]].loanId;
                s.loanSideRewardReservedVpfi[loanId][sideKey] += slices[i].amount;
                if (r.domainKey != bytes32(0)) {
                    // The domain's own carry (A2-ii): its later days count this
                    // day as rewarded and this amount as paid for the loan side.
                    s.stagingDomainLoanReserved[r.domainKey][loanId] += slices[i].amount;
                    ++s.stagingDomainLoanDays[r.domainKey][loanId];
                }
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
        return true;
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
        if (r.domainKey != bytes32(0)) revert IVaipakamErrors.StagingRecordInDomain(key, r.domainKey);
        return _resolvePage(s, key, r, true);
    }

    /// @notice A DOMAIN record's resolution page (A2-ii): the per-record step
    ///         {resolveDomainPage} drives by Diamond self-call, hosted on the
    ///         record facet that already inlines {_resolvePage}. No per-record
    ///         revalidation — the domain revalidated its whole extent before
    ///         resolving, and resolution is irrevocable.
    function resolvePageInDomain(LibVaipakam.Storage storage s, bytes32 key) internal returns (bool done) {
        LibVaipakam.StagingRecord storage r = record(s, key);
        if (r.domainKey == bytes32(0)) revert IVaipakamErrors.StagingRecordNotInDomain(key);
        return _resolvePage(s, key, r, false);
    }

    /// @dev One resolution page. `revalidate` runs the per-record stale check
    ///      at the Reserved → Resolving edge; a DOMAIN revalidates its whole
    ///      extent before entering its own resolving phase and then resolves
    ///      its records irrevocably, so it passes false (A2-ii).
    function _resolvePage(
        LibVaipakam.Storage storage s,
        bytes32 key,
        LibVaipakam.StagingRecord storage r,
        bool revalidate
    ) private returns (bool done) {
        if (r.phase == LibVaipakam.StagingPhase.Reserved) {
            // The first irreversible page REVALIDATES the commitment against
            // the entries' current lifecycle (Codex #2308 r23; the design's
            // rule): a record whose split is stale is unwound here and now,
            // never resolved on it — `_pay` would otherwise route the frozen
            // claimant and chargeability past a forfeit, a default or a
            // closed window the reservation never saw.
            if (revalidate) {
                (bool stale, uint256 entryId) = staleEntry(s, r);
                if (stale) {
                    emit StagingRecordStale(key, entryId);
                    r.phase = LibVaipakam.StagingPhase.Unwinding;
                    return _unwindPage(s, key, r);
                }
            }
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
            held += _resolveBatch(s, key, r, i);
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

    /// @dev One batch of a resolution page, in a frame of its own (the page
    ///      loop's locals overflowed `resolvePage`'s viaIR stack once the
    ///      close-out routed by operation, A2-ii): consume what the
    ///      reservation assigned, return the rest to the batch's balance and
    ///      re-offer it, release the reference and the record's slot.
    /// @return consumed The epoch value this batch contributed to the day.
    function _resolveBatch(
        LibVaipakam.Storage storage s,
        bytes32 key,
        LibVaipakam.StagingRecord storage r,
        uint256 i
    ) private returns (uint256 consumed) {
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
        consumed = cf + cr;
        emit StagingResolvedBatch(id, key, cf, cr);
        // The record no longer holds this batch's components, and the
        // Diamond's staged earmark no longer covers them (Codex #2308 r13).
        r.stagedFresh -= bf;
        r.stagedRecycled -= br;
        LibRewardCustody.releaseStagedBatchAt(s, key, r, i);
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
        LibVaipakam.StagingOp op = r.op;
        // A claimant flagged by the sanctions oracle is not paid: reward VPFI
        // not yet delivered to a flagged wallet is FORFEITED, while value
        // already in their vault stays frozen there (owner decision
        // 2026-10-02, rewards only — loan proceeds keep the wind-down freeze).
        // Their share settles exactly as the day's forfeit (treasury) leg
        // does, into the recycle bucket, so this page cannot fail for it and
        // the record can never be trapped in `Resolving` (Codex #2308 r18,
        // r21: a vault-only delivery reverted for a claimant with no vault).
        // A sweep's record (A2-ii) carries no user share to begin with.
        bool forfeit = op == LibVaipakam.StagingOp.Claim && LibVaipakam.isSanctionedAddress(user);
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
                uint256 loanId = s.rewardEntries[r.entryIds[i]].loanId;
                s.loanSideRewardReservedVpfi[loanId][sideKey] -= r.sliceAmounts[i];
                _releaseDomainCarry(s, r.domainKey, loanId, r.sliceAmounts[i]);
            }
            unchecked { ++i; }
        }

        // A staged EXPIRY day performs, at its payout, what the expiry walk
        // performs for a day it settles (A2-ii): the removal point begins on
        // the first day that credits, before the day persists.
        if (op == LibVaipakam.StagingOp.Expiry && r.needTreasuryFresh + r.needTreasuryRecycled != 0) {
            LibInteractionRewards.beginExpiry(s, r.entryIds[0], s.rewardEntries[r.entryIds[0]]);
        }
        // The A1 claim's settlement, for one day.
        LibInteractionRewards._persistDay(s, user, r.side, r.day, r.entryIds, slices);
        if (op == LibVaipakam.StagingOp.Expiry) {
            LibInteractionRewards.recordExpiredDay(
                s, r.entryIds[0], r.needTreasuryFresh + r.needTreasuryRecycled + r.cappedOffFresh, r.needTreasuryRecycled
            );
        }
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
        if (r.domainKey != bytes32(0)) {
            // A domain's day record delivers where the DOMAIN was bound (A2-ii;
            // addendum 5), set by the claimant before the reservation.
            LibVaipakam.StagingDomain storage dom = s.stagingDomains[r.domainKey];
            venue = dom.venueSet ? dom.venue : LibVaipakam.RewardDelivery.Default;
        }
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
        // The close-out's legs, by operation (A2-ii): a claim's and a
        // forfeit's treasury legs absorb as forfeited reward (the forfeit
        // under its loan's id, as the sweep records it), an expiry's as
        // expired reward — through the ONE settle every close-out uses.
        LibRewardCustody.callSettleLegs(
            uint8(
                op == LibVaipakam.StagingOp.Expiry
                    ? LibVpfiRecycle.RecycleSource.ExpiredReward
                    : LibVpfiRecycle.RecycleSource.ForfeitedReward
            ),
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
            op == LibVaipakam.StagingOp.Forfeit ? s.rewardEntries[r.entryIds[0]].loanId : 0
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

    /// @notice Whether record `r`'s commitment is STALE — an entry of its set
    ///         no longer valid for its day under the primitive's one rule
    ///         ({LibInteractionRewards.entrySetDefect}: expired, processed,
    ///         closed before the day, re-anchored), or one whose forfeit
    ///         status changed since the reservation stamped its chargeability
    ///         (a default or liquidation since) — and which entry. Read before
    ///         the first irreversible page and by the unwind anyone may run
    ///         at once (Codex #2308 r23). A record not yet reserved carries no
    ///         slices, so only the set rule applies to it.
    function staleEntry(
        LibVaipakam.Storage storage s,
        LibVaipakam.StagingRecord storage r
    ) internal view returns (bool stale, uint256 entryId) {
        (bool valid, uint256 bad) =
            LibInteractionRewards.entrySetDefect(s, r.user, r.day, r.entryIds, true, r.domainKey);
        if (!valid) return (true, bad);
        uint256 m = r.sliceChargeable.length;
        for (uint256 i; i < m; ) {
            uint256 id = r.entryIds[i];
            // Chargeable was stamped as the negation of "routes to the
            // treasury" under this record's operation: equal now means the
            // entry's status moved under the commitment.
            if (
                r.sliceChargeable[i]
                    == LibInteractionRewards.entryRoutesToTreasury(
                        s, s.rewardEntries[id], r.op == LibVaipakam.StagingOp.Expiry
                    )
            ) {
                return (true, id);
            }
            unchecked { ++i; }
        }
        return (false, 0);
    }

    /// @notice Register record `key` for `batchId`'s open priority window
    ///         (A2-ii): the record must stand in staging, must have found the
    ///         batch contested, and must not have used its one priority
    ///         reservation on the batch. The oldest registrant by the record's
    ///         opening time wins — a running minimum, so neither the order of
    ///         registration nor the order a scan met the batch decides.
    ///         Permissionless: anyone may register a record.
    function register(LibVaipakam.Storage storage s, bytes32 key, bytes32 batchId) internal {
        LibVaipakam.StagingRecord storage r = record(s, key);
        _requirePhase(key, r, LibVaipakam.StagingPhase.Staging);
        bytes32 nk = LibRewardCustody.recordNonceKey(key, r.nonce);
        if (s.transportBatchPriorityUsed[batchId][key]) revert IVaipakamErrors.StagingPriorityUsed(key, batchId);
        if (!s.transportBatchWaiting[nk][batchId]) revert IVaipakamErrors.StagingNotWaiting(key, batchId);
        LibVaipakam.TransportBatchWindow storage w = s.transportBatchWindows[batchId];
        if (w.closesAt == 0 || block.timestamp >= w.closesAt) revert IVaipakamErrors.TransportBatchWindowNotOpen(batchId);
        if (w.oldestNonceKey == bytes32(0) || r.openedAt < w.oldestOpenedAt) {
            w.oldestKey = key;
            w.oldestNonceKey = nk;
            w.oldestOpenedAt = r.openedAt;
        }
        emit TransportBatchWaiterRegistered(batchId, key, r.openedAt);
    }

    /// @notice One page of unwind: past the deadline anyone, before it only
    ///         the claimant (a voluntary cancellation) — or anyone, at once,
    ///         when the record is STALE ({staleEntry}; Codex #2308 r23), the
    ///         finding announced. Each page returns up
    ///         to `STAGING_PAGE` batches' staged components to their balance
    ///         and releases their references; the page that returns the last
    ///         batch releases the reservation, per source, and closes the
    ///         record. A `Resolving` record is beyond reach: it only completes.
    /// @return done Whether the record was closed by this page.
    function unwindPage(LibVaipakam.Storage storage s, bytes32 key, address caller) internal returns (bool done) {
        LibVaipakam.StagingRecord storage r = record(s, key);
        if (r.domainKey != bytes32(0)) revert IVaipakamErrors.StagingRecordInDomain(key, r.domainKey);
        LibVaipakam.StagingPhase p = r.phase;
        if (p == LibVaipakam.StagingPhase.Staging || p == LibVaipakam.StagingPhase.Reserved) {
            if (caller != r.user && block.timestamp < r.deadline) {
                // A STALE record is anyone's to unwind at once, with no
                // deadline to wait for (Codex #2308 r23; the design's rule).
                (bool stale, uint256 entryId) = staleEntry(s, r);
                if (!stale) revert IVaipakamErrors.StagingNotExpired(key, r.deadline);
                emit StagingRecordStale(key, entryId);
            }
            r.phase = LibVaipakam.StagingPhase.Unwinding;
        } else {
            _requirePhase(key, r, LibVaipakam.StagingPhase.Unwinding);
        }
        return _unwindPage(s, key, r);
    }

    /// @notice A DOMAIN record's unwind page (A2-ii): the per-record step
    ///         {unwindDomainPage} drives by Diamond self-call, hosted on the
    ///         record facet that already inlines {_unwindPage}. The domain
    ///         decided the unwind (deadline, cancel or a stale record), so the
    ///         record's own gates do not apply: a staging or reserved record is
    ///         sent to Unwinding here.
    function unwindPageInDomain(LibVaipakam.Storage storage s, bytes32 key) internal returns (bool done) {
        LibVaipakam.StagingRecord storage r = record(s, key);
        if (r.domainKey == bytes32(0)) revert IVaipakamErrors.StagingRecordNotInDomain(key);
        LibVaipakam.StagingPhase p = r.phase;
        if (p == LibVaipakam.StagingPhase.Staging || p == LibVaipakam.StagingPhase.Reserved) {
            r.phase = LibVaipakam.StagingPhase.Unwinding;
        } else {
            _requirePhase(key, r, LibVaipakam.StagingPhase.Unwinding);
        }
        return _unwindPage(s, key, r);
    }

    /// @dev One unwind page of a record already in `Unwinding`: returns up to
    ///      a page of staged batches, and on the last releases every
    ///      reservation by the figure recorded for it and closes the record.
    function _unwindPage(
        LibVaipakam.Storage storage s,
        bytes32 key,
        LibVaipakam.StagingRecord storage r
    ) private returns (bool done) {
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
            // A non-settlement release: the batch's priority window opens, the
            // releaser barred from re-taking what it returned (A2-ii).
            LibRewardCustody.openBatchWindow(s, id, key);
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
                        uint256 loanId = s.rewardEntries[r.entryIds[j]].loanId;
                        s.loanSideRewardReservedVpfi[loanId][sideKey] -= r.sliceAmounts[j];
                        _releaseDomainCarry(s, r.domainKey, loanId, r.sliceAmounts[j]);
                    }
                    unchecked { ++j; }
                }
            }
            // No obligation cooldown (A2-ii): each batch this unwind restored
            // carries its own priority window, opened page by page above.
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
            deliveredFresh: LibInteractionRewards.deliveredFreshBound(s)
        });
        LibInteractionRewards.DayContext memory dry = LibInteractionRewards._dayContext();
        dry.preparedOnly = true;
        dry.preparedFresh = r.stagedFresh;
        dry.preparedRecycled = r.stagedRecycled;
        // An expiry's day prices as the expiry walk prices it (A2-ii): the
        // entry's share routes to the treasury legs, recycled in place.
        dry.recycleSettlement = r.op == LibVaipakam.StagingOp.Expiry;
        // A domain's day record prices in its domain's context (A2-ii).
        dry.domainKey = r.domainKey;
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
        bytes32 dk = s.stagingRecords[key].domainKey;
        if (dk != bytes32(0)) --s.stagingDomains[dk].liveRecords; // the extent clears at zero (A2-ii)
        emit StagingRecordClosed(key, paid);
        delete s.stagingRecords[key];
    }

    // ───────────────────────── A2-ii — multi-chunk claim DOMAINS ─────────────────────────

    /// @dev Days a domain page walks per call (reservation, resolution, unwind, revalidation).
    uint256 internal constant DOMAIN_PAGE_DAYS = 8;

    /// @notice Open the claimant-side's domain over the committed extent (A2-ii):
    ///         the entry set and the last day are a SNAPSHOT; the lifecycle
    ///         version is anchored; the deadline starts at one cadence per
    ///         chunk plus the grace. Refused while a cleared-but-live domain
    ///         still stands (its records must all close first).
    function openDomain(
        LibVaipakam.Storage storage s,
        bytes32 dk,
        LibVaipakam.StagingDomain storage dom,
        address user,
        LibVaipakam.RewardSide side,
        uint256[] memory entryIds,
        uint256 first,
        uint256 last
    ) internal {
        if (dom.liveRecords != 0) revert IVaipakamErrors.StagingDomainStanding(dk, uint8(dom.phase));
        dom.phase = LibVaipakam.DomainPhase.Staging;
        dom.user = user;
        dom.side = side;
        dom.firstDay = SafeCast.toUint64(first);
        dom.lastDay = SafeCast.toUint64(last);
        dom.preparedThrough = SafeCast.toUint64(first - 1);
        dom.reserveCursor = 0;
        dom.resolveCursor = 0;
        dom.unwindCursor = 0;
        dom.revalidateCursor = 0;
        dom.openedAt = uint64(block.timestamp);
        dom.deadline = 0;
        dom.lifecycleVersionAtCommit = s.rewardLifecycleVersion[user][uint8(side)];
        dom.chunks = (last - first + 1 + LibVaipakam.MAX_INTERACTION_CLAIM_DAYS - 1) / LibVaipakam.MAX_INTERACTION_CLAIM_DAYS;
        dom.leaseAccum = 0;
        dom.venueSet = false;
        dom.entryIds = entryIds;
        emit StagingDomainOpened(dk, user, uint8(side), dom.firstDay, dom.lastDay, dom.chunks);
        LibRewardCustody.domainDeadlineRefresh(s, dk, dom);
    }

    /// @notice A preparation chunk ended (A2-ii): the domain's deadline is
    ///         refreshed from its chunks and its records' leases.
    function domainPrepared(LibVaipakam.Storage storage s, bytes32 dk, LibVaipakam.StagingDomain storage dom) internal {
        LibRewardCustody.domainDeadlineRefresh(s, dk, dom);
    }

    /// @notice The claimant binds the venue the domain's days deliver to, before
    ///         the reservation (A2-ii; addendum 5).
    function setDomainVenue(
        LibVaipakam.Storage storage s,
        bytes32 dk,
        address caller,
        LibVaipakam.RewardDelivery venue
    ) internal {
        LibVaipakam.StagingDomain storage dom = s.stagingDomains[dk];
        if (dom.legacy || dom.phase != LibVaipakam.DomainPhase.Staging) revert IVaipakamErrors.StagingDomainPhaseInvalid(dk, uint8(dom.phase));
        if (caller != dom.user) revert IVaipakamErrors.StagingNotClaimant(dk, caller);
        dom.venue = venue;
        dom.venueSet = true;
    }

    /// @notice One RESERVING page (A2-ii), permissionless. From Staging: the
    ///         extent must be fully prepared; the domain enters Reserving. If
    ///         the claimant-side's lifecycle version moved since the commit,
    ///         the extent is REVALIDATED first (a cursor, paged): a stale day
    ///         record sends the whole domain to unwind. Then the reservation
    ///         cursor reserves each day record in order — the live sources and
    ///         the cap headroom debited per day, the domain's own earlier days
    ///         counted as its own — and a day they cannot bear STOPS the cursor
    ///         (announced; the days before stand reserved, nothing paid). Once
    ///         every day is reserved the version is re-checked, O(1), and the
    ///         domain enters Resolving — irrevocable.
    /// @return done True once the domain is Resolving.
    function reserveDomainPage(LibVaipakam.Storage storage s, bytes32 dk) internal returns (bool done) {
        LibVaipakam.StagingDomain storage dom = s.stagingDomains[dk];
        if (dom.legacy) revert IVaipakamErrors.StagingDomainPhaseInvalid(dk, uint8(dom.phase)); // a legacy slice has its own pages (A2-ii (c))
        if (dom.phase == LibVaipakam.DomainPhase.Staging) {
            if (dom.preparedThrough < dom.lastDay) {
                revert IVaipakamErrors.StagingDomainNotPrepared(dk, dom.preparedThrough, dom.lastDay);
            }
            dom.phase = LibVaipakam.DomainPhase.Reserving;
            dom.reserveCursor = dom.firstDay;
            dom.revalidateCursor = dom.firstDay;
            emit StagingDomainPhase(dk, uint8(dom.phase));
        } else if (dom.phase != LibVaipakam.DomainPhase.Reserving) {
            revert IVaipakamErrors.StagingDomainPhaseInvalid(dk, uint8(dom.phase));
        }
        if (s.rewardLifecycleVersion[dom.user][uint8(dom.side)] != dom.lifecycleVersionAtCommit) {
            if (!_revalidateDomainPage(s, dk, dom)) return false;
        }
        uint256 walked;
        while (dom.reserveCursor <= dom.lastDay && walked < DOMAIN_PAGE_DAYS) {
            bytes32 key = LibRewardCustody.stagingKey(dom.user, dom.side, dom.reserveCursor);
            LibVaipakam.StagingRecord storage r = s.stagingRecords[key];
            if (r.phase == LibVaipakam.StagingPhase.Staging) {
                // Hosted on the record facet; reached by self-call (EIP-170).
                if (!LibRewardCustody.callReserveRecordInDomain(key)) {
                    emit StagingDomainReserveStopped(dk, dom.reserveCursor);
                    return false;
                }
            }
            // No record (the day priced to nothing) or already reserved: on.
            unchecked { ++dom.reserveCursor; ++walked; }
        }
        if (dom.reserveCursor <= dom.lastDay) return false;
        // Every day reserved. The O(1) check at the irreversible edge
        // (addendum 2): a lifecycle move since the walk sends the extent back
        // through revalidation on the next call.
        if (s.rewardLifecycleVersion[dom.user][uint8(dom.side)] != dom.lifecycleVersionAtCommit) {
            dom.revalidateCursor = dom.firstDay;
            return false;
        }
        dom.phase = LibVaipakam.DomainPhase.Resolving;
        dom.resolveCursor = dom.firstDay;
        emit StagingDomainPhase(dk, uint8(dom.phase));
        return true;
    }

    /// @dev One revalidation page over the extent (addendum 1): each day
    ///      record's commitment is re-read against its entries' current
    ///      lifecycle; a stale one unwinds the domain. Returns true once the
    ///      whole extent is revalidated (the version re-anchored).
    function _revalidateDomainPage(LibVaipakam.Storage storage s, bytes32 dk, LibVaipakam.StagingDomain storage dom)
        private
        returns (bool)
    {
        uint256 walked;
        while (dom.revalidateCursor <= dom.lastDay && walked < DOMAIN_PAGE_DAYS) {
            bytes32 key = LibRewardCustody.stagingKey(dom.user, dom.side, dom.revalidateCursor);
            LibVaipakam.StagingRecord storage r = s.stagingRecords[key];
            if (r.phase != LibVaipakam.StagingPhase.None) {
                (bool stale, uint256 entryId) = staleEntry(s, r);
                if (stale) {
                    emit StagingRecordStale(key, entryId);
                    _beginDomainUnwind(dk, dom);
                    return false;
                }
            }
            unchecked { ++dom.revalidateCursor; ++walked; }
        }
        if (dom.revalidateCursor <= dom.lastDay) return false;
        dom.lifecycleVersionAtCommit = s.rewardLifecycleVersion[dom.user][uint8(dom.side)];
        return true;
    }

    /// @notice One RESOLVING page (A2-ii), permissionless: the records resolve
    ///         in day order, each through its own pages, each paying on its
    ///         last; the domain is irrevocable here. Cleared (deleted) once
    ///         the cursor passes the extent and no record is live.
    /// @return done True once the domain is cleared.
    function resolveDomainPage(LibVaipakam.Storage storage s, bytes32 dk) internal returns (bool done) {
        LibVaipakam.StagingDomain storage dom = s.stagingDomains[dk];
        if (dom.legacy) revert IVaipakamErrors.StagingDomainPhaseInvalid(dk, uint8(dom.phase)); // a legacy slice has its own pages (A2-ii (c))
        if (dom.phase != LibVaipakam.DomainPhase.Resolving) revert IVaipakamErrors.StagingDomainPhaseInvalid(dk, uint8(dom.phase));
        uint256 walked;
        while (dom.resolveCursor <= dom.lastDay && walked < DOMAIN_PAGE_DAYS) {
            bytes32 key = LibRewardCustody.stagingKey(dom.user, dom.side, dom.resolveCursor);
            LibVaipakam.StagingRecord storage r = s.stagingRecords[key];
            if (r.phase != LibVaipakam.StagingPhase.None) {
                // Hosted on the settle facet; reached by self-call (EIP-170).
                if (!LibRewardCustody.callResolveRecordInDomain(key)) return false; // this record's next page, next call
            }
            unchecked { ++dom.resolveCursor; ++walked; }
        }
        if (dom.resolveCursor <= dom.lastDay || dom.liveRecords != 0) return false;
        emit StagingDomainCleared(dk, true);
        delete s.stagingDomains[dk];
        return true;
    }

    /// @notice One UNWIND page (A2-ii): past the deadline anyone, before it
    ///         only the claimant, while the domain is Staging or Reserving — a
    ///         resolving domain only completes. Each day record runs its own
    ///         paginated unwind (its provenance releases exactly what it held,
    ///         and each returned batch opens its priority window); the domain
    ///         is cleared once the cursor passes the extent and no record is
    ///         live, so no new domain commits before then.
    /// @return done True once the domain is cleared.
    function unwindDomainPage(LibVaipakam.Storage storage s, bytes32 dk, address caller) internal returns (bool done) {
        LibVaipakam.StagingDomain storage dom = s.stagingDomains[dk];
        if (dom.legacy) revert IVaipakamErrors.StagingDomainPhaseInvalid(dk, uint8(dom.phase)); // a legacy slice has its own pages (A2-ii (c))
        LibVaipakam.DomainPhase p = dom.phase;
        if (p == LibVaipakam.DomainPhase.Staging || p == LibVaipakam.DomainPhase.Reserving) {
            if (caller != dom.user && block.timestamp < dom.deadline) {
                revert IVaipakamErrors.StagingDomainNotExpired(dk, dom.deadline);
            }
            _beginDomainUnwind(dk, dom);
        } else if (p != LibVaipakam.DomainPhase.Unwinding) {
            revert IVaipakamErrors.StagingDomainPhaseInvalid(dk, uint8(p));
        }
        uint256 walked;
        while (dom.unwindCursor <= dom.lastDay && walked < DOMAIN_PAGE_DAYS) {
            bytes32 key = LibRewardCustody.stagingKey(dom.user, dom.side, dom.unwindCursor);
            LibVaipakam.StagingRecord storage r = s.stagingRecords[key];
            LibVaipakam.StagingPhase rp = r.phase;
            if (
                rp == LibVaipakam.StagingPhase.Staging || rp == LibVaipakam.StagingPhase.Reserved
                    || rp == LibVaipakam.StagingPhase.Unwinding
            ) {
                // Hosted on the settle facet (it sends a live record to Unwinding
                // and runs one page); reached by self-call (EIP-170).
                if (!LibRewardCustody.callUnwindRecordInDomain(key)) return false; // this record's next page, next call
            }
            unchecked { ++dom.unwindCursor; ++walked; }
        }
        if (dom.unwindCursor <= dom.lastDay || dom.liveRecords != 0) return false;
        emit StagingDomainCleared(dk, false);
        delete s.stagingDomains[dk];
        return true;
    }

    function _beginDomainUnwind(bytes32 dk, LibVaipakam.StagingDomain storage dom) private {
        dom.phase = LibVaipakam.DomainPhase.Unwinding;
        dom.unwindCursor = dom.firstDay;
        emit StagingDomainPhase(dk, uint8(dom.phase));
    }

    /// @dev A domain record's reservation released or persisted: the domain's
    ///      own carry for the loan drops by the slice (A2-ii).
    function _releaseDomainCarry(LibVaipakam.Storage storage s, bytes32 dk, uint256 loanId, uint256 amount) private {
        if (dk == bytes32(0)) return;
        s.stagingDomainLoanReserved[dk][loanId] -= amount;
        --s.stagingDomainLoanDays[dk][loanId];
    }

    /// @notice A DOMAIN record's preparation page (A2-ii (c)): the per-record
    ///         step a legacy slice's preparation drives by Diamond self-call,
    ///         hosted on the record facet that already inlines {prepare}.
    function prepareInDomain(LibVaipakam.Storage storage s, bytes32 key)
        internal
        returns (uint256 stagedFresh, uint256 stagedRecycled)
    {
        if (s.stagingRecords[key].domainKey == bytes32(0)) revert IVaipakamErrors.StagingRecordNotInDomain(key);
        return prepare(s, key);
    }

    /// @notice One page of a LEGACY-SLICE record's consumption (A2-ii (c)),
    ///         hosted on the settle facet (it already inlines the batch
    ///         resolution): a staging record whose scan is settled turns to
    ///         Resolving with its whole staged coverage to consume; each page
    ///         consumes up to `STAGING_PAGE` batches into `held`; the record
    ///         closes on its last page. `unsettled` — the day's list grew past
    ///         the record's scan — asks the caller for one more preparation
    ///         page instead. The custody row movement for `held` is the
    ///         caller's (the domain holds the aggregate).
    function consumeInLegacy(LibVaipakam.Storage storage s, bytes32 key)
        internal
        returns (uint256 held, bool done, bool unsettled)
    {
        LibVaipakam.StagingRecord storage r = record(s, key);
        if (r.domainKey == bytes32(0) || r.op != LibVaipakam.StagingOp.LegacySlice) {
            revert IVaipakamErrors.StagingRecordNotInDomain(key);
        }
        if (r.phase == LibVaipakam.StagingPhase.Staging) {
            if (!LibRewardCustody.recordScanSettled(s, r)) return (0, false, true);
            r.consumeFreshLeft = r.stagedFresh;
            r.consumeRecycledLeft = r.stagedRecycled;
            r.phase = LibVaipakam.StagingPhase.Resolving;
        } else {
            _requirePhase(key, r, LibVaipakam.StagingPhase.Resolving);
        }
        uint256 n = r.batchCount;
        uint256 i = r.resolveCursor;
        uint256 end = i + STAGING_PAGE;
        if (end > n) end = n;
        while (i < end) {
            held += _resolveBatch(s, key, r, i);
            unchecked { ++i; }
        }
        r.resolveCursor = i;
        if (i < n) return (held, false, false); // this record's next page, next call
        _close(s, key, true);
        return (held, true, false);
    }

    // ───────────────────────── A2-ii (c) — the LEGACY SLICE as a domain ─────────────────────────

    /// @dev Days a legacy preparation or consumption page walks per call.
    uint256 internal constant LEGACY_PAGE_DAYS = 8;

    /// @notice The legacy slice of `entryId` consumed its staged coverage:
    ///         `epochFresh` is what the slice's settlement pays as transport
    ///         legs instead of from the live sources (A2-ii (c)).
    /// @custom:event-category state-change/reward-staging
    event LegacySliceConsumed(uint256 indexed entryId, uint256 epochFresh);
    /// @notice The legacy slice's domain opened over `[firstDay, lastDay]`.
    /// @custom:event-category state-change/reward-staging
    event LegacySliceDomainOpened(uint256 indexed entryId, bytes32 indexed domainKey, uint64 firstDay, uint64 lastDay);

    /// @dev The slice's window: from the entry's first unsettled day to the day
    ///      before the arming (or the entry's last day, when wholly pre-`D*`).
    function _legacyWindow(LibVaipakam.Storage storage s, uint256 id, LibVaipakam.RewardEntry storage e)
        private
        view
        returns (uint256 first, uint256 last, bool any)
    {
        uint256 cur = s.rewardEntryClaimNextDay[id];
        first = cur == 0 ? e.startDay : cur;
        uint256 armedFrom = s.governorCommitArmedFromDay;
        uint256 endExcl = e.endDay;
        if (armedFrom != 0 && armedFrom < endExcl) endExcl = armedFrom;
        if (endExcl == 0 || first >= endExcl) return (0, 0, false);
        last = endExcl - 1;
        any = true;
    }

    /// @notice The legacy slice's epoch coverage for the settlement sites
    ///         (A2-ii (c)) — HOSTED on the domain facet, reached by every
    ///         settlement site through {LibRewardCustody.callLegacySliceEpochs}:
    ///         `ready` with `epochFresh == 0` when no epoch lists any day of the
    ///         slice's window (free under the chain-wide admitted-batch
    ///         short-circuit); `ready` with the aggregate once the slice's
    ///         domain has consumed every listed day; otherwise NOT ready — the
    ///         slice defers — after running ONE step of the domain (a
    ///         preparation page, or a consumption page) so a settlement that
    ///         keeps being called drives the slice home by itself, and anyone
    ///         may drive it faster through the facet's step. `stepped` reports
    ///         that the call moved the domain, so a deferring claim is progress.
    function legacySliceEpochs(LibVaipakam.Storage storage s, uint256 id)
        internal
        returns (bool ready, uint256 epochFresh, bool stepped)
    {
        if (s.transportBatchesAdmitted == 0) return (true, 0, false);
        LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
        bytes32 lk = LibRewardCustody.legacyDomainKey(id);
        LibVaipakam.StagingDomain storage dom = s.stagingDomains[lk];
        if (dom.phase == LibVaipakam.DomainPhase.None) {
            (uint256 first, uint256 last, bool any) = _legacyWindow(s, id, e);
            if (!any) return (true, 0, false);
            bool listed;
            for (uint256 d = first; d <= last; ) {
                if (s.transportBatchesByDay[d].length != 0) {
                    listed = true;
                    break;
                }
                unchecked { ++d; }
            }
            if (!listed) return (true, 0, false);
            dom.phase = LibVaipakam.DomainPhase.Staging;
            dom.legacy = true;
            dom.user = e.user;
            dom.side = e.side;
            dom.firstDay = SafeCast.toUint64(first);
            dom.lastDay = SafeCast.toUint64(last);
            dom.preparedThrough = SafeCast.toUint64(first - 1);
            dom.resolveCursor = SafeCast.toUint64(first);
            dom.openedAt = uint64(block.timestamp);
            dom.entryIds = new uint256[](1);
            dom.entryIds[0] = id;
            emit LegacySliceDomainOpened(id, lk, dom.firstDay, dom.lastDay);
            stepped = true;
        }
        if (dom.phase == LibVaipakam.DomainPhase.Resolving) return (true, dom.aggFresh, stepped);
        legacySliceStep(s, id);
        if (dom.phase == LibVaipakam.DomainPhase.Resolving) return (true, dom.aggFresh, true);
        return (false, 0, true);
    }

    /// @notice One step of entry `id`'s legacy-slice domain (A2-ii (c)),
    ///         permissionless: while the extent is not prepared, a preparation
    ///         page (up to `LEGACY_PAGE_DAYS` days: a day no epoch lists takes
    ///         its place with no record, a listed day's record is opened and
    ///         scans one page); once prepared, a consumption page (records in
    ///         day order, each consumed in bounded pages — a wide day's record
    ///         is prepared one more page instead — its batches debited into the
    ///         domain's aggregate and the record closed). The domain is
    ///         CONSUMED (phase Resolving) once the cursor passes the extent
    ///         with no record live. Each per-record step runs on the record
    ///         facet that hosts it, by Diamond self-call.
    /// @return consumed Whether the slice's domain is now consumed.
    function legacySliceStep(LibVaipakam.Storage storage s, uint256 id) internal returns (bool consumed) {
        bytes32 lk = LibRewardCustody.legacyDomainKey(id);
        LibVaipakam.StagingDomain storage dom = s.stagingDomains[lk];
        if (!dom.legacy || dom.phase != LibVaipakam.DomainPhase.Staging) revert IVaipakamErrors.LegacySliceNotPending(id);
        if (dom.preparedThrough < dom.lastDay) {
            _legacyPreparePage(s, lk, dom, id);
            return false;
        }
        _legacyConsumePage(s, dom);
        if (dom.resolveCursor > dom.lastDay && dom.liveRecords == 0) {
            dom.phase = LibVaipakam.DomainPhase.Resolving;
            emit LegacySliceConsumed(id, dom.aggFresh);
            return true;
        }
        return false;
    }

    function _legacyPreparePage(
        LibVaipakam.Storage storage s,
        bytes32 lk,
        LibVaipakam.StagingDomain storage dom,
        uint256 id
    ) private {
        uint256 d = uint256(dom.preparedThrough) + 1;
        uint256 last = dom.lastDay;
        uint256 walked;
        while (d <= last && walked < LEGACY_PAGE_DAYS) {
            bool listed = s.transportBatchesByDay[d].length != 0;
            (uint256 needD, bool priced) = listed ? LibInteractionRewards.legacyDayNeed(s, id, d) : (0, true);
            // A listed day the cumulative curve has not reached yet cannot be
            // asked for: the page stops here, unprepared, and the settlement
            // that drives it (which advances the curve first) comes back.
            if (!priced) return;
            if (listed && needD != 0) {
                bytes32 key = LibRewardCustody.stagingKey(dom.user, dom.side, d);
                LibVaipakam.StagingRecord storage r = s.stagingRecords[key];
                if (r.phase == LibVaipakam.StagingPhase.None) {
                    uint256[] memory one = new uint256[](1);
                    one[0] = id;
                    // The record opens through the one seam (hosted on the
                    // settle facet), with nothing staged yet.
                    LibRewardCustody.callStageDayFromPlan(
                        dom.user, dom.side, d, one, new bytes32[](0), new uint256[](0), new uint256[](0),
                        LibVaipakam.RewardDelivery.Default, LibVaipakam.StagingOp.LegacySlice, lk
                    );
                }
                // Its own preparation scans one page of the day's list
                // (hosted on the record facet).
                if (r.phase == LibVaipakam.StagingPhase.Staging && !r.scanComplete) {
                    LibRewardCustody.callPrepareRecordInDomain(key);
                }
            }
            dom.preparedThrough = uint64(d);
            unchecked { ++d; ++walked; }
        }
    }

    function _legacyConsumePage(LibVaipakam.Storage storage s, LibVaipakam.StagingDomain storage dom) private {
        uint256 walked;
        while (dom.resolveCursor <= dom.lastDay && walked < LEGACY_PAGE_DAYS) {
            bytes32 key = LibRewardCustody.stagingKey(dom.user, dom.side, dom.resolveCursor);
            if (s.stagingRecords[key].phase != LibVaipakam.StagingPhase.None) {
                // One page of the record's consumption, hosted on the settle facet.
                (uint256 held, bool done, bool unsettled) = LibRewardCustody.callConsumeRecordInLegacy(key);
                if (unsettled) {
                    // A wide day: one more preparation page (hosted on the
                    // record facet), then stop.
                    LibRewardCustody.callPrepareRecordInDomain(key);
                    return;
                }
                if (held != 0) {
                    dom.aggFresh += held;
                    if (LibRewardCustody.active(s)) {
                        LibRewardCustody.hold(
                            s, LibVaipakam.RewardCustodyRow.Unclassified, LibVaipakam.RewardCustodyRow.Resolving, held, key
                        );
                        dom.heldAgg += held;
                    }
                }
                if (!done) return; // this record's next page, next call
            }
            unchecked { ++dom.resolveCursor; ++walked; }
        }
    }

    /// @notice The slice SETTLED (A2-ii (c)) — HOSTED on the domain facet,
    ///         reached through {LibRewardCustody.callLegacySliceSettled}: the
    ///         held aggregate returns to the `Unclassified` row for the payout
    ///         to take, the staged earmark it still carried is released, and
    ///         the domain is deleted. Called by the settlement site right
    ///         before it routes the legs; a no-op for a slice with no domain.
    function legacySliceSettled(LibVaipakam.Storage storage s, uint256 id) internal {
        bytes32 lk = LibRewardCustody.legacyDomainKey(id);
        LibVaipakam.StagingDomain storage dom = s.stagingDomains[lk];
        if (dom.phase != LibVaipakam.DomainPhase.Resolving) return;
        if (dom.heldAgg != 0) {
            LibRewardCustody.releaseHold(
                s, LibVaipakam.RewardCustodyRow.Resolving, LibVaipakam.RewardCustodyRow.Unclassified, dom.heldAgg, lk
            );
        }
        LibRewardCustody.releaseStagedEarmark(s, dom.aggFresh);
        delete s.stagingDomains[lk];
    }
}
