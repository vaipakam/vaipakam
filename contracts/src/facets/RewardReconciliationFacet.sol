// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibRewardCustody} from "../libraries/LibRewardCustody.sol";
import {LibVpfiRecycle} from "../libraries/LibVpfiRecycle.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {LibPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title RewardReconciliationFacet
 * @notice #1566 closure 2 cutover PR 2 — the LEGACY RECONCILIATION EPOCH
 *         (design §5c): the administrator's classification of the value the
 *         ingress could only PROTECT. Three entries, every one ADMIN-only,
 *         under the manual pause, on an activated deployment:
 *
 *  1. **`classifyLegacyPacket`** — a packet's untyped remainder (what it put
 *     into the holder's `Unclassified` row) leaves the row for fresh, recycled
 *     or restitution backing, IN-HOLDER, under the deficit split. Bounded by
 *     the packet's own remainder (what it holds in the row is what it can
 *     ever classify — the aggregate wire bound is structural on this shape),
 *     by the row's own figure and the global uncounted aggregate, by a
 *     per-entry replay guard — and, on the FRESH side, by EVIDENCE (design
 *     §5c, "the fresh side of any split is the privileged direction, because
 *     fresh is what claims can spend"): a packet's classified fresh never
 *     exceeds its AUTHENTICATED fresh figure, which no administrator writes.
 *     The transport-carried attestation of the source chain's own recorded
 *     split is that figure's writer and lands with the transport epochs;
 *     until then it is zero, and an untyped packet classifies recycled or
 *     stays where it is. The recycled direction is the conservative one
 *     and needs no evidence: fresh value classified recycled under-publishes
 *     headroom, which the evidence-backed correction lifts; the reverse
 *     spends someone else's backing first (Codex #2206 r3). Cumulative per
 *     component: an understated entry leaves the hash classifiable; a
 *     rounding residual STAYS in the row.
 *  2. **`reclassifyReconciliationEntry`** — attribution moves between the two
 *     sides of an already-classified entry without changing its total,
 *     bounded by what is still UNSPENT and, toward fresh, by the same
 *     evidence. Spent-ness is RECORDED, never read from a balance, and
 *     recorded INTO the classified value's own record (Codex #2206 r4, r5):
 *     each side's queue is a sequence of SEGMENTS in classification order
 *     with a frontier, and every outflow of a pool passes through that
 *     pool's own debit primitive, which writes what the outflow took of the
 *     queue — the pool's other backing consumed first, never more than the
 *     segments still hold — into the segments at the frontier, earliest
 *     first, with its kind. So a later credit un-spends nothing, a refill is
 *     consumed once, and which entry a consumption or a repatriation took
 *     from is known, not inferred. Unspent credit moves WITH its tokens
 *     (in-holder; the recycled side bounded by the uncommitted bucket);
 *     spent credit moves as an inherited debit — `received` and `paid`
 *     together, the destination's consumption rising — never replacement
 *     capital, because an authenticated ledger inherits it; and only spent
 *     credit the side's ledger actually charged (fresh `paid`; recycled
 *     consumption) is inheritable. Credit a correction moves to a side joins
 *     that side's queue as a new segment at the tail — classified there at
 *     the correction. Unspent credit moves FIRST: that order is what
 *     reproduces the ledger a correct-at-ingress split would have produced
 *     (design §5c) — the corrected credit still covers the first of the
 *     entry's payouts, and only what it can no longer cover was, in truth,
 *     the other side's. The part of a fresh credit the standing deficit
 *     absorbed into restitution is neither queued nor movable for as long as
 *     the restitution row holds it; what the row releases of it (recorded at
 *     the row's outflow the same way) re-enters the fresh queue as a segment
 *     of its own — unspent when the paid-correction moved it to live, spent
 *     when the deficit was paid with it. A packet's component counters
 *     follow its entry.
 *  3. **`importLegacyEnvelope`** — the inventory that arrived BEFORE packets
 *     were stamped, as ONE netted aggregate every figure of which is read on
 *     chain at the import (`uncounted − holder-held − Diamond-side reserved −
 *     returned`), resolved whole and once: relocated from the Diamond's own
 *     balance (measured) as RECYCLED, replacement-funded by the caller
 *     (delta-checked) as fresh or recycled, or written down — and entered
 *     into the same log, so the snapshot-keyed error path is the same
 *     reclassification. The envelope has no evidence source (its history
 *     has no packet identities), so its fresh share is exactly what was
 *     replacement-funded: the same rule as a packet's, with delta-checked
 *     custody as the authenticated figure.
 *
 *     The epoch stays open, without exception: no finalization exists here
 *     (design §5c, "what an operator's off-chain confidence buys is the
 *     decision to stop watching, never a state transition"). What stays out:
 *     transport epochs (they need slice 4 PR C's era balances to be
 *     consumable; a PR of their own before PR C — and they carry the
 *     authenticated fresh figure's writer), the era registry itself (every
 *     entry keys era 0 until PR C's backfill), and the owner-only
 *     dispositions the design names (an imported-gap shortfall; an
 *     undrainable lane) — this facet ships the executable forms and refuses
 *     to pick.
 */
contract RewardReconciliationFacet is DiamondAccessControl, DiamondReentrancyGuard, IVaipakamErrors {
    // ─── Events ─────────────────────────────────────────────────────────────

    /// @notice A classification entry left the `Unclassified` row.
    /// @custom:event-category state-change/reward-custody
    event LegacyPacketClassified(
        bytes32 indexed packetHash,
        bytes32 indexed entryId,
        uint256 entryIndex,
        uint256 freshShare,
        uint256 recycledShare,
        uint256 toLive,
        uint256 toRestitution
    );
    /// @notice Attribution moved between an entry's two sides.
    /// @custom:event-category state-change/reward-custody
    event ReconciliationEntryReclassified(
        uint256 indexed entryIndex, bytes32 indexed entryId, bool freshToRecycled, uint256 unspentMoved, uint256 spentMoved
    );
    /// @notice The pre-stamp envelope was imported, whole and once.
    /// @custom:event-category state-change/reward-custody
    event LegacyEnvelopeImported(
        bytes32 indexed snapshotId,
        uint256 entryIndex,
        uint256 netTotal,
        uint256 relocatedRecycled,
        uint256 replacedFresh,
        uint256 replacedRecycled,
        uint256 writtenDown
    );

    /// @dev The sides a queue view names: the fresh queue (of era 0), the
    ///      recycled queue, the absorbed segments.
    uint8 internal constant SIDE_FRESH = 0;
    uint8 internal constant SIDE_RECYCLED = 1;
    uint8 internal constant SIDE_ABSORBED = 2;

    // ─── The entries ────────────────────────────────────────────────────────

    /**
     * @notice Classify part of a legacy packet's untyped remainder out of the
     *         `Unclassified` row: `freshShare` to the received side (live
     *         backing, or restitution for what the standing deficit absorbs)
     *         and `recycledShare` to the bucket, both in-holder.
     * @dev    ADMIN, MANUAL pause, activated. Every bound is checked BEFORE
     *         any mutation, so a mistaken entry reverts whole. The fresh
     *         share is bounded, cumulatively over the packet's entries, by
     *         the packet's authenticated fresh figure (zero until the
     *         transport attestation writes it); the recycled share by the
     *         remainder alone. A packet whose receipt still carries a live
     *         stranded-recovery record is not classifiable: its value is the
     *         R4 return's.
     * @param  packetHash    The packet's ingress stamp.
     * @param  freshShare    Classified as fresh.
     * @param  recycledShare Classified as recycled.
     * @param  entryId       The operator's entry reference; applied once.
     */
    function classifyLegacyPacket(
        bytes32 packetHash,
        uint256 freshShare,
        uint256 recycledShare,
        bytes32 entryId
    ) external nonReentrant onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = _open(entryId);
        LibVaipakam.IngressPacket storage p = s.ingressPackets[packetHash];
        if (p.arrivedAt == 0) revert ReconciliationPacketUnknown(packetHash);
        if (freshShare + recycledShare == 0) revert InvalidAmount();
        if (p.kind <= LibRewardCustody.PACKET_KIND_COMPENSATION) {
            LibVaipakam.StrandedRecovery storage sr =
                s.strandedRecoveries[keccak256(abi.encode(p.remitter, p.remitId))];
            if (sr.amount != 0 || sr.held != 0) revert ReconciliationPacketReserved(packetHash, sr.amount);
        }
        if (freshShare != 0) _requireEvidence(packetHash, p.classifiedFresh + freshShare, p.freshAuthenticated);
        // The three effects, atomically: the step-down (packet remainder,
        // row figure, global aggregate — each exact), the fresh credit under
        // the split, the bucket credit as relocated custody. The credits are
        // INFLOWS of their rows; the row primitive records nothing for them,
        // and the entry's segments join the queues at the tail.
        LibRewardCustody.takeFromUnclassified(s, packetHash, freshShare, recycledShare);
        (uint256 toLive, uint256 toRestitution) =
            LibRewardCustody.creditFreshFromRow(s, LibVaipakam.RewardCustodyRow.Unclassified, freshShare);
        LibVpfiRecycle.creditCustodyFromUnclassified(p.remitId, recycledShare);
        uint256 index = _pushEntry(s, packetHash, false, freshShare, recycledShare, toRestitution);
        emit LegacyPacketClassified(packetHash, entryId, index, freshShare, recycledShare, toLive, toRestitution);
    }

    /**
     * @notice Move `amount` of an entry's attribution from one side to the
     *         other — its total unchanged — bounded by the still-unspent
     *         source credit; beyond it, the spent part moves as an inherited
     *         debit, and only the part the source's ledger charged is
     *         inheritable.
     * @dev    ADMIN, MANUAL pause, activated. Fresh → recycled: the unspent
     *         part leaves the LIVE row with its tokens (restitution custody
     *         is not a correction's to move) and raises the bucket; the
     *         spent part (paid) lowers `received` and `paid` together and
     *         raises the recycled consumption. Recycled → fresh: bounded by
     *         the entry's evidence (a packet's authenticated fresh figure;
     *         the envelope's replacement-funded fresh); the unspent part
     *         leaves the bucket (bounded by its uncommitted balance) into
     *         live or restitution under the split; the spent part
     *         (consumption) raises `received` and `paid` together and gives
     *         the recycled consumption back. The queues are adjusted BEFORE
     *         the tokens move, so the pool's debit primitive records nothing
     *         for the correction's own move; what moves joins the
     *         destination's queue as new segments at the tail.
     * @param  index           The log entry.
     * @param  freshToRecycled The direction.
     * @param  amount          What moves.
     * @param  entryId         The operator's entry reference; applied once.
     */
    function reclassifyReconciliationEntry(
        uint256 index,
        bool freshToRecycled,
        uint256 amount,
        bytes32 entryId
    ) external nonReentrant onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = _open(entryId);
        if (index >= s.reconciliationLog.length) revert ReconciliationEntryUnknown(index);
        if (amount == 0) revert InvalidAmount();
        (uint256 movingUnspent, uint256 movingSpent) =
            freshToRecycled ? _moveToRecycled(s, index, amount) : _moveToFresh(s, index, amount);
        emit ReconciliationEntryReclassified(index, entryId, freshToRecycled, movingUnspent, movingSpent);
    }

    /**
     * @notice Import the pre-stamp inventory as one netted envelope, whole
     *         and once: every unit of it relocated from the Diamond's own
     *         balance (measured) as recycled backing, replacement-funded by
     *         the caller (delta-checked into the holder) as fresh or
     *         recycled, or written down.
     * @dev    ADMIN, MANUAL pause, activated. The envelope's figures are all
     *         read on chain at the call — the operator asserts nothing the
     *         chain can state — and the four dispositions must sum to the
     *         netted total exactly. The inventory has no evidence source,
     *         so it relocates as recycled only (design §5c: absent
     *         authenticated source evidence or delta-checked replacement
     *         custody, value classifies conservatively); the fresh
     *         disposition is the replacement-funded one, credited to the
     *         received side under the deficit split. The whole leaves the
     *         global uncounted aggregate, the written-down part recorded as
     *         such: it is value pre-holder outflows spent, not custody. The
     *         envelope's log entry is reclassifiable like any other, its
     *         fresh side bounded by what was replacement-funded.
     * @param  snapshotId       The ceremony's record id; one import per id.
     * @param  relocateRecycled Relocated from the Diamond as recycled.
     * @param  replaceFresh     Pulled from the caller as fresh.
     * @param  replaceRecycled  Pulled from the caller as recycled.
     * @param  writeDown        Recorded as gone.
     */
    function importLegacyEnvelope(
        bytes32 snapshotId,
        uint256 relocateRecycled,
        uint256 replaceFresh,
        uint256 replaceRecycled,
        uint256 writeDown
    ) external nonReentrant onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibPausable.requireManuallyPaused();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!LibRewardCustody.active(s)) revert RewardCustodyNotActivated();
        LibVaipakam.LegacyEnvelope storage env = s.legacyEnvelopes[snapshotId];
        if (env.importedAt != 0) revert LegacyEnvelopeAlreadyImported(snapshotId);
        (uint256 netTotal, uint256 raw, uint256 holderUncounted, uint256 diamondReserved, uint256 returned) =
            _envelope(s);
        if (netTotal == 0) revert LegacyEnvelopeEmpty(snapshotId);
        uint256 stated = relocateRecycled + replaceFresh + replaceRecycled + writeDown;
        if (stated != netTotal) revert LegacyEnvelopeMismatch(snapshotId, stated, netTotal);
        s.rewardBudgetFreshUncounted = raw - netTotal;
        uint256 refId = uint256(snapshotId);
        LibVpfiRecycle.creditCustodyRelocated(refId, relocateRecycled, LibVpfiRecycle.RecycleSource.LegacyReconciliation);
        LibRewardCustody.pullFromCaller(s, msg.sender, replaceFresh + replaceRecycled);
        (, uint256 absorbed) = LibRewardCustody.creditFreshIngress(s, replaceFresh);
        LibVpfiRecycle.creditCustodyFundedInHolder(refId, replaceRecycled);
        uint256 index = _pushEntry(s, snapshotId, true, replaceFresh, relocateRecycled + replaceRecycled, absorbed);
        env.importedAt = uint64(block.timestamp);
        env.rawUncounted = raw;
        env.holderUncounted = holderUncounted;
        env.diamondReserved = diamondReserved;
        env.returnedCumulative = returned;
        env.netTotal = netTotal;
        env.relocatedRecycled = relocateRecycled;
        env.replacedFresh = replaceFresh;
        env.replacedRecycled = replaceRecycled;
        env.writtenDown = writeDown;
        env.entryIndex = index;
        emit LegacyEnvelopeImported(
            snapshotId, index, netTotal, relocateRecycled, replaceFresh, replaceRecycled, writeDown
        );
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    /// @notice The envelope as the import would read it now: the global
    ///         uncounted aggregate net of what the holder already holds of
    ///         it (post-stamp remainders, protected at ingress), of the
    ///         Diamond-side quarantine reservation, and of every return ever
    ///         sent (which never decremented the aggregate) — each clamped.
    function previewLegacyEnvelope()
        external
        view
        returns (
            uint256 netTotal,
            uint256 rawUncounted,
            uint256 holderUncounted,
            uint256 diamondReserved,
            uint256 returnedCumulative
        )
    {
        return _envelope(LibVaipakam.storageSlot());
    }

    /// @notice An imported envelope's record; `importedAt == 0` for an
    ///         unknown snapshot id.
    function getLegacyEnvelope(bytes32 snapshotId) external view returns (LibVaipakam.LegacyEnvelope memory) {
        return LibVaipakam.storageSlot().legacyEnvelopes[snapshotId];
    }

    /// @notice A packet's reconciliation figures: when it was recorded
    ///         (`arrivedAt == 0` is an UNRECORDED hash — never a recorded
    ///         packet with nothing to reconcile; Codex #2206 r4), what it
    ///         put into the row, what it still holds there, its exits by
    ///         kind, and its authenticated fresh figure (the bound on its
    ///         fresh side). Identity: `unclassified + classifiedFresh +
    ///         classifiedRecycled + disposed == protectedCumulative`.
    function getPacketReconciliation(
        bytes32 packetHash
    )
        external
        view
        returns (
            uint64 arrivedAt,
            uint256 protectedCumulative,
            uint256 unclassified,
            uint256 classifiedFresh,
            uint256 classifiedRecycled,
            uint256 disposed,
            uint256 freshAuthenticated
        )
    {
        LibVaipakam.IngressPacket storage p = LibVaipakam.storageSlot().ingressPackets[packetHash];
        return (
            p.arrivedAt,
            p.protectedCumulative,
            p.unclassified,
            p.classifiedFresh,
            p.classifiedRecycled,
            p.disposed,
            p.freshAuthenticated
        );
    }

    /// @notice A log entry as recorded.
    function getReconciliationEntry(uint256 index) external view returns (LibVaipakam.ReconciliationEntry memory) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (index >= s.reconciliationLog.length) revert ReconciliationEntryUnknown(index);
        return s.reconciliationLog[index];
    }

    /// @notice An entry's figures per side, read from its own segments:
    ///         what is unspent (movable with its tokens), what is spent,
    ///         what of the spent the other side may inherit (what the side's
    ///         ledger charged: fresh `paid`; recycled consumption), and the
    ///         part of its fresh credit the restitution row STILL holds
    ///         absorbed (neither queued nor movable). Linear in the entry's
    ///         own segments (one per classification or correction of it);
    ///         reads no balance and infers nothing.
    function getReconciliationEntrySpent(
        uint256 index
    ) external view returns (Spent memory) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (index >= s.reconciliationLog.length) revert ReconciliationEntryUnknown(index);
        return _spent(s, index);
    }

    /// @notice The fresh side as it stands for `era`: the fresh queue's
    ///         segment count, frontier, unspent, spent and paid figures and
    ///         the live row; the absorbed segments' count, frontier,
    ///         unreleased and released figures and the restitution row.
    ///         Invariants: `paid ≤ spent`, `unspent ≤ liveRow`, `unreleased
    ///         ≤ restitutionRow`, every segment before a frontier exhausted.
    function getFreshQueueState(
        uint64 era
    )
        external
        view
        returns (
            uint256 segments,
            uint256 frontier,
            uint256 unspent,
            uint256 spent,
            uint256 paid,
            uint256 liveRow,
            uint256 absorbedSegments,
            uint256 absorbedFrontier,
            uint256 absorbedUnreleased,
            uint256 absorbedReleased,
            uint256 restitutionRow
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.freshQueueByEra[era].length,
            s.freshQueueFrontierByEra[era],
            s.freshUnspentByEra[era],
            s.freshSpentTotalByEra[era],
            s.freshPaidTotalByEra[era],
            s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.LiveFresh],
            s.absorbedQueue.length,
            s.absorbedQueueFrontier,
            s.absorbedUnreleased,
            s.absorbedReleasedTotal,
            s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.Restitution]
        );
    }

    /// @notice The recycled side as it stands: the queue's segment count,
    ///         frontier, unspent, spent and consumed figures and the bucket.
    ///         Invariants: `consumed ≤ spent`, `unspent ≤ the recycled row`.
    function getRecycledQueueState()
        external
        view
        returns (uint256 segments, uint256 frontier, uint256 unspent, uint256 spent, uint256 consumed, uint256 bucket)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.recycledQueue.length,
            s.recycledQueueFrontier,
            s.recycledUnspent,
            s.recycledSpentTotal,
            s.recycledConsumedTotal,
            s.recycleBucket
        );
    }

    /// @notice One segment of a queue: `side` 0 = the fresh queue of era 0,
    ///         1 = the recycled queue (`charged` = consumption), 2 = the
    ///         absorbed segments (`spent` = released; `charged` unused).
    function getQueueSegment(
        uint8 side,
        uint256 i
    ) external view returns (uint256 entryIndex, uint256 amount, uint256 spent, uint256 charged) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (side == SIDE_ABSORBED) {
            LibVaipakam.AbsorbedSegment storage a = s.absorbedQueue[i];
            return (a.entryIndex, a.amount, a.released, 0);
        }
        LibVaipakam.QueueSegment storage q =
            side == SIDE_FRESH ? s.freshQueueByEra[LibRewardCustody.PRE_BACKFILL_ERA][i] : s.recycledQueue[i];
        return (q.entryIndex, q.amount, q.spent, q.charged);
    }

    /// @notice The indices of an entry's segments on `side` (see
    ///         {getQueueSegment}), in the order they joined the queue.
    function getEntrySegments(uint256 index, uint8 side) external view returns (uint256[] memory) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (index >= s.reconciliationLog.length) revert ReconciliationEntryUnknown(index);
        if (side == SIDE_FRESH) return s.entryFreshSegments[index];
        if (side == SIDE_RECYCLED) return s.entryRecycledSegments[index];
        return s.entryAbsorbedSegments[index];
    }

    /// @notice The log's length and the bucket's two reattribution
    ///         cumulatives (its composition identity's terms for them).
    function getReconciliationTotals()
        external
        view
        returns (uint256 entries, uint256 reattributedIn, uint256 reattributedOut)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (s.reconciliationLog.length, s.recycleReattributedInCumulative, s.recycleReattributedOutCumulative);
    }

    /// @notice Whether an entry reference was applied.
    function isReconciliationEntryUsed(bytes32 entryId) external view returns (bool) {
        return LibVaipakam.storageSlot().reconciliationEntryUsed[entryId];
    }

    // ─── Diamond-internal: the queue machinery ──────────────────────────────
    //
    // The pools' debit primitives (`LibRewardCustody.debit` / `move` for the
    // live and restitution rows; `LibVpfiRecycle.consume` and
    // `debitRepatriationSurplus` for the bucket ledger) decide WHEN the
    // queues are written and reach the walks here through the Diamond's own
    // fallback, exactly as every facet reaches the custody mutations: the
    // primitives are inlined into facets at the EIP-170 budget, and the
    // queue machinery belongs with the epoch that owns it. Callable by the
    // Diamond itself only; never `nonReentrant` (a correction's own token
    // move reaches here from inside its guard, and finds nothing to take).

    function _requireDiamondInternal() private view {
        if (msg.sender != address(this)) revert RewardCustodyOnlyDiamondInternal(msg.sender);
    }

    /// @notice Diamond-internal: {LibRewardCustody.takeFresh} — a live-row
    ///         outflow's take of the fresh queue.
    function reconciliationTakeFresh(uint256 have, uint256 amount, bool paid) external {
        _requireDiamondInternal();
        LibRewardCustody.takeFresh(LibVaipakam.storageSlot(), LibRewardCustody.PRE_BACKFILL_ERA, have, amount, paid);
    }

    /// @notice Diamond-internal: {LibRewardCustody.releaseAbsorbed} — a
    ///         restitution-row outflow's release of the absorbed segments.
    function reconciliationReleaseAbsorbed(uint256 have, uint256 amount, bool toLive, bool paid) external {
        _requireDiamondInternal();
        LibRewardCustody.releaseAbsorbed(LibVaipakam.storageSlot(), have, amount, toLive, paid);
    }

    /// @notice Diamond-internal: {LibRewardCustody.takeRecycled} — a
    ///         bucket-ledger debit's take of the recycled queue.
    function reconciliationTakeRecycled(
        uint256 bucketBefore,
        uint256 amount,
        bool consumption
    ) external returns (uint256 took, uint256 from) {
        _requireDiamondInternal();
        return LibRewardCustody.takeRecycled(LibVaipakam.storageSlot(), bucketBefore, amount, consumption);
    }

    /// @notice Diamond-internal: {LibRewardCustody.reverseRecycledConsumption}.
    function reconciliationReverseRecycledConsumption(uint256 from, uint256 take) external {
        _requireDiamondInternal();
        LibRewardCustody.reverseRecycledConsumption(LibVaipakam.storageSlot(), from, take);
    }

    // ─── Internals ──────────────────────────────────────────────────────────

    /// @dev Every entry's common gate: the manual pause, an activated
    ///      deployment (a Diamond-side classification would be the
    ///      delta-checked relocation the design rejects — design §5c), and
    ///      the replay guard, marked before the effects. A refused entry
    ///      reverts the mark with everything else, so its id stays usable
    ///      for the corrected submission; only an APPLIED entry's id is
    ///      spent (design §5c: the guard stops the same entry being applied
    ///      twice, not a mistaken one from being corrected).
    function _open(bytes32 entryId) private returns (LibVaipakam.Storage storage s) {
        LibPausable.requireManuallyPaused();
        s = LibVaipakam.storageSlot();
        if (!LibRewardCustody.active(s)) revert RewardCustodyNotActivated();
        if (s.reconciliationEntryUsed[entryId]) revert ReconciliationEntryReplayed(entryId);
        s.reconciliationEntryUsed[entryId] = true;
    }

    /// @dev The evidence rule (design §5c): an entry's fresh side never
    ///      exceeds its authenticated fresh figure. ONE rule for both doors
    ///      into fresh — the classification and the correction toward fresh
    ///      — and for both kinds of entry: a packet's figure is what the
    ///      transport attestation authenticated of its remainder; the
    ///      envelope's is what was replacement-funded, delta-checked.
    function _requireEvidence(bytes32 key, uint256 cumulativeFresh, uint256 authenticated) private pure {
        if (cumulativeFresh > authenticated) revert ReconciliationFreshUnevidenced(key, cumulativeFresh, authenticated);
    }

    /// @dev An entry's fresh side as it stands against its evidence: a
    ///      packet's cumulative over all its entries (`classifiedFresh`,
    ///      which every correction keeps current) against its authenticated
    ///      figure; the envelope's own credit against its replaced fresh.
    function _freshEvidence(
        LibVaipakam.Storage storage s,
        LibVaipakam.ReconciliationEntry storage e
    ) private view returns (uint256 current, uint256 authenticated) {
        if (e.envelope) return (e.freshCredit, s.legacyEnvelopes[e.key].replacedFresh);
        LibVaipakam.IngressPacket storage p = s.ingressPackets[e.key];
        return (p.classifiedFresh, p.freshAuthenticated);
    }

    /// @notice An entry's figures, per side, read from its own segments.
    struct Spent {
        uint256 freshSpent;
        uint256 freshUnspent;
        uint256 freshInheritable;
        uint256 freshAbsorbed;
        uint256 recycledSpent;
        uint256 recycledUnspent;
        uint256 recycledInheritable;
    }

    /// @dev Fresh → recycled. The absorbed part still held is restitution
    ///      custody: not a correction's to move. Unspent credit moves first,
    ///      with its tokens; only then spent credit, as an inherited debit
    ///      — so what an entry keeps after any move that took spent units is
    ///      all spent, which is the correct-at-ingress result (design §5c).
    ///      The queues move FIRST: the units leave the entry's fresh
    ///      segments and join the recycled queue as new segments at the
    ///      tail; the row primitive then records nothing for the token move.
    function _moveToRecycled(
        LibVaipakam.Storage storage s,
        uint256 index,
        uint256 amount
    ) private returns (uint256 movingUnspent, uint256 movingSpent) {
        LibVaipakam.ReconciliationEntry storage e = s.reconciliationLog[index];
        Spent memory sp = _spent(s, index);
        uint256 movable = sp.freshUnspent + sp.freshSpent;
        if (amount > movable) revert ReconciliationRestitutionNotMovable(index, amount, movable);
        movingUnspent = amount < sp.freshUnspent ? amount : sp.freshUnspent;
        movingSpent = amount - movingUnspent;
        if (movingSpent > sp.freshInheritable) {
            revert ReconciliationSpentFreshNotInheritable(index, movingSpent, sp.freshInheritable);
        }
        _leaveSide(s.freshQueueByEra[e.era], s.entryFreshSegments[index], movingUnspent, movingSpent, SIDE_FRESH);
        s.freshUnspentByEra[e.era] -= movingUnspent;
        s.freshSpentTotalByEra[e.era] -= movingSpent;
        s.freshPaidTotalByEra[e.era] -= movingSpent;
        LibRewardCustody.appendRecycledSegment(s, index, movingUnspent, 0, 0);
        LibRewardCustody.appendRecycledSegment(s, index, movingSpent, movingSpent, movingSpent);
        e.freshCredit -= amount;
        e.recycledCredit += amount;
        // Then the tokens and the ledgers.
        uint256 refId = uint256(e.key);
        LibRewardCustody.debitFreshFromLive(s, LibVaipakam.RewardCustodyRow.Recycled, movingUnspent);
        LibVpfiRecycle.creditBucketReattributed(refId, movingUnspent, false);
        LibRewardCustody.inheritFreshDebitAsRecycled(s, movingSpent);
        LibVpfiRecycle.creditBucketReattributed(refId, movingSpent, true);
        _packetFollows(s, e, amount, true);
    }

    /// @dev Recycled → fresh: the privileged direction, bounded by the
    ///      entry's evidence before anything moves. Only consumption is
    ///      inheritable of the spent part. The queues move FIRST (the split
    ///      the credit will take is read ahead: its live part joins the
    ///      fresh queue, its absorbed part the absorbed segments); the bucket
    ///      ledger's own debit then finds nothing more to record.
    function _moveToFresh(
        LibVaipakam.Storage storage s,
        uint256 index,
        uint256 amount
    ) private returns (uint256 movingUnspent, uint256 movingSpent) {
        LibVaipakam.ReconciliationEntry storage e = s.reconciliationLog[index];
        (uint256 current, uint256 authenticated) = _freshEvidence(s, e);
        _requireEvidence(e.key, current + amount, authenticated);
        Spent memory sp = _spent(s, index);
        movingUnspent = amount < sp.recycledUnspent ? amount : sp.recycledUnspent;
        movingSpent = amount - movingUnspent;
        if (movingSpent > sp.recycledInheritable) {
            revert ReconciliationSpentRecycledNotInheritable(index, movingSpent, sp.recycledInheritable);
        }
        _leaveSide(s.recycledQueue, s.entryRecycledSegments[index], movingUnspent, movingSpent, SIDE_RECYCLED);
        s.recycledUnspent -= movingUnspent;
        s.recycledSpentTotal -= movingSpent;
        s.recycledConsumedTotal -= movingSpent;
        (uint256 toLive, uint256 absorbed) = LibRewardCustody.freshSplit(s, movingUnspent);
        LibRewardCustody.appendFreshSegment(s, e.era, index, toLive, 0, 0);
        LibRewardCustody.appendAbsorbedSegment(s, index, absorbed);
        LibRewardCustody.appendFreshSegment(s, e.era, index, movingSpent, movingSpent, movingSpent);
        e.recycledCredit -= amount;
        e.freshCredit += amount;
        // Then the tokens and the ledgers.
        uint256 refId = uint256(e.key);
        LibVpfiRecycle.debitBucketReattributed(refId, movingUnspent, false);
        LibRewardCustody.creditFreshFromRow(s, LibVaipakam.RewardCustodyRow.Recycled, movingUnspent);
        LibVpfiRecycle.debitBucketReattributed(refId, movingSpent, true);
        LibRewardCustody.inheritRecycledDebitAsFresh(s, movingSpent);
        _packetFollows(s, e, amount, false);
    }

    /// @dev Take `unspentOut` free units and `spentOut` charged-spent units
    ///      out of an entry's segments on one side, in the order the
    ///      segments joined the queue: free units shrink a segment's amount;
    ///      charged units shrink its amount, spent and charged together, so
    ///      what leaves is exactly what the entry's own record holds. A
    ///      segment before the frontier has nothing free, so the frontier
    ///      never has to move back. The figures asked for were read from
    ///      these same segments a moment ago; not finding them is a defect.
    function _leaveSide(
        LibVaipakam.QueueSegment[] storage q,
        uint256[] storage ids,
        uint256 unspentOut,
        uint256 spentOut,
        uint8 side
    ) private {
        uint256 n = ids.length;
        for (uint256 i = 0; i < n && (unspentOut != 0 || spentOut != 0); ++i) {
            LibVaipakam.QueueSegment storage seg = q[ids[i]];
            if (unspentOut != 0) {
                uint256 free = seg.amount - seg.spent;
                uint256 u = unspentOut < free ? unspentOut : free;
                seg.amount -= uint96(u);
                unspentOut -= u;
            }
            if (spentOut != 0) {
                uint256 c = seg.charged;
                uint256 u = spentOut < c ? spentOut : c;
                seg.amount -= uint96(u);
                seg.spent -= uint96(u);
                seg.charged -= uint96(u);
                spentOut -= u;
            }
        }
        if (unspentOut != 0 || spentOut != 0) revert ReconciliationQueueInconsistent(side);
    }

    /// @dev Append a log entry and its segments: its live fresh credit to
    ///      the fresh queue, its absorbed part to the absorbed segments, its
    ///      recycled credit to the recycled queue — each at the tail.
    function _pushEntry(
        LibVaipakam.Storage storage s,
        bytes32 key,
        bool envelope,
        uint256 fresh,
        uint256 recycled,
        uint256 absorbed
    ) private returns (uint256 index) {
        uint64 era = LibRewardCustody.PRE_BACKFILL_ERA;
        index = s.reconciliationLog.length;
        s.reconciliationLog.push(
            LibVaipakam.ReconciliationEntry({
                key: key,
                envelope: envelope,
                era: era,
                landedAt: uint64(block.timestamp),
                freshCredit: fresh,
                recycledCredit: recycled
            })
        );
        LibRewardCustody.appendFreshSegment(s, era, index, fresh - absorbed, 0, 0);
        LibRewardCustody.appendAbsorbedSegment(s, index, absorbed);
        LibRewardCustody.appendRecycledSegment(s, index, recycled, 0, 0);
    }

    /// @dev A packet-backed entry's correction moves the packet's component
    ///      counters with it, so the packet's cumulative fresh — what its
    ///      evidence bounds — stays current. An envelope entry has no packet.
    function _packetFollows(
        LibVaipakam.Storage storage s,
        LibVaipakam.ReconciliationEntry storage e,
        uint256 amount,
        bool freshToRecycled
    ) private {
        if (e.envelope) return;
        LibVaipakam.IngressPacket storage p = s.ingressPackets[e.key];
        if (freshToRecycled) {
            p.classifiedFresh -= amount;
            p.classifiedRecycled += amount;
        } else {
            p.classifiedRecycled -= amount;
            p.classifiedFresh += amount;
        }
    }

    /// @dev An entry's figures, per side, summed over its own segments.
    function _spent(LibVaipakam.Storage storage s, uint256 index) private view returns (Spent memory r) {
        LibVaipakam.ReconciliationEntry storage e = s.reconciliationLog[index];
        (r.freshUnspent, r.freshSpent, r.freshInheritable) =
            _sideFigures(s.freshQueueByEra[e.era], s.entryFreshSegments[index]);
        (r.recycledUnspent, r.recycledSpent, r.recycledInheritable) =
            _sideFigures(s.recycledQueue, s.entryRecycledSegments[index]);
        uint256[] storage a = s.entryAbsorbedSegments[index];
        uint256 n = a.length;
        for (uint256 i = 0; i < n; ++i) {
            LibVaipakam.AbsorbedSegment storage seg = s.absorbedQueue[a[i]];
            r.freshAbsorbed += seg.amount - seg.released;
        }
    }

    function _sideFigures(
        LibVaipakam.QueueSegment[] storage q,
        uint256[] storage ids
    ) private view returns (uint256 unspent, uint256 spent, uint256 charged) {
        uint256 n = ids.length;
        for (uint256 i = 0; i < n; ++i) {
            LibVaipakam.QueueSegment storage seg = q[ids[i]];
            unspent += seg.amount - seg.spent;
            spent += seg.spent;
            charged += seg.charged;
        }
    }

    /// @dev The envelope's netting (design §5c, "uncounted − reservedLive −
    ///      returnedCumulative, each clamped"), on the landed shape: the
    ///      holder-held uncounted figure is the post-stamp part the ingress
    ///      protected and is not the envelope's; the Diamond-side part of the
    ///      quarantine reservation is; and every return ever sent left the
    ///      aggregate un-decremented, so the cumulative nets out whole.
    function _envelope(
        LibVaipakam.Storage storage s
    )
        private
        view
        returns (uint256 netTotal, uint256 raw, uint256 holderUncounted, uint256 diamondReserved, uint256 returned)
    {
        raw = s.rewardBudgetFreshUncounted;
        holderUncounted = s.rewardCustodyUnclassifiedUncounted;
        uint256 reservedAll = s.strandedRecoveryReserved;
        uint256 held = s.strandedRecoveryReservedHeld;
        diamondReserved = reservedAll > held ? reservedAll - held : 0;
        returned = s.strandedReturnedCumulative;
        netTotal = raw > holderUncounted ? raw - holderUncounted : 0;
        netTotal = netTotal > diamondReserved ? netTotal - diamondReserved : 0;
        netTotal = netTotal > returned ? netTotal - returned : 0;
    }
}
