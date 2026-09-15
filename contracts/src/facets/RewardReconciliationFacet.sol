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
 *     evidence. Spent-ness is RECORDED, never read from a balance (Codex
 *     #2206 r4): every outflow of a pool passes through that pool's own
 *     debit primitive (the live and restitution rows'; the bucket ledger's,
 *     whose row follows it), and that primitive records what the outflow
 *     took of the classified queue — the pool's other backing consumed
 *     first, never more than the records still hold — so a later credit
 *     un-spends nothing and a refill
 *     is consumed once; the figure is distributed among the entries FIFO by
 *     classification order (the earliest spent first) through a Fenwick
 *     tree's prefix sums, logarithmic in the log. Unspent credit moves WITH
 *     its tokens (in-holder; the recycled side bounded by the uncommitted
 *     bucket); spent credit moves as an inherited debit — `received` and
 *     `paid` together, the destination's consumption rising — never
 *     replacement capital, because an authenticated ledger inherits it; and
 *     only spent credit the side's ledger actually charged (fresh `paid`;
 *     recycled consumption) is inheritable. Unspent credit moves FIRST:
 *     that order is what reproduces the ledger a correct-at-ingress split
 *     would have produced (design §5c) — the corrected credit still covers
 *     the first of the entry's payouts, and only what it can no longer
 *     cover was, in truth, the other side's. The part of a fresh credit the
 *     standing deficit absorbed into restitution is neither queued nor
 *     movable for as long as the restitution row holds it; what the row
 *     releases of it (recorded at the row's outflow the same way) re-enters
 *     the live queue FIFO — unspent when the paid-correction moved it to
 *     live, spent when the deficit was paid with it. A packet's component
 *     counters follow its entry.
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
        // and the entry queues behind everything recorded so far.
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
     *         source credit under the FIFO; beyond it, the spent part moves
     *         as an inherited debit, and only the part the source's ledger
     *         charged is inheritable.
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
     *         the tokens move, so the row primitive records nothing for the
     *         correction's own move. Every later entry of the touched queue
     *         reads exactly as before for the spent part, and shifts by the
     *         unspent part.
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

    /// @notice An entry's spent-ness, per side — its inherited figure plus
    ///         what the side's outflows took of it, in FIFO order — what of
    ///         it is still unspent (movable with its tokens), the part of
    ///         its spent-ness the other side may inherit (what the side's
    ///         ledger charged: fresh `paid`; recycled consumption — first in
    ///         queue order, plus what was inherited from the other side),
    ///         the part of its fresh credit the restitution row STILL holds
    ///         absorbed (neither queued nor movable), and the queued credit
    ///         classified before it on each side (the tree's prefix).
    ///         Logarithmic in the log's length; reads no balance.
    function getReconciliationEntrySpent(
        uint256 index
    ) external view returns (Spent memory) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (index >= s.reconciliationLog.length) revert ReconciliationEntryUnknown(index);
        return _spent(s, index);
    }

    /// @notice The queues as they stand: on the fresh side the tree's queued
    ///         total (each entry's credit less its inherited and absorbed
    ///         records), what the restitution row released of the absorbed
    ///         records (re-queued, FIFO), the recorded spent and paid
    ///         figures, the live row, the absorbed total and the restitution
    ///         row; on the recycled side the queued total, the recorded
    ///         spent and consumption figures, and the bucket. Invariants:
    ///         `paid ≤ spent ≤ queued + released`, `consumed ≤ spent ≤
    ///         queued`, `released ≤ absorbed`, and each queue's unspent part
    ///         is what its row holds of it.
    function getQueueState(
        uint64 era
    )
        external
        view
        returns (
            uint256 freshQueued,
            uint256 freshReleased,
            uint256 freshSpent,
            uint256 freshPaid,
            uint256 liveRow,
            uint256 freshAbsorbedTotal,
            uint256 restitutionRow,
            uint256 recycledQueued,
            uint256 recycledSpent,
            uint256 recycledConsumed,
            uint256 bucket
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.freshQueuedTotalByEra[era],
            s.freshReleasedTotal,
            s.freshSpentTotalByEra[era],
            s.freshPaidTotalByEra[era],
            s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.LiveFresh],
            s.freshAbsorbedTotal,
            s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.Restitution],
            s.recycledQueuedTotal,
            s.recycledSpentTotal,
            s.recycledConsumedTotal,
            s.recycleBucket
        );
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

    /// @notice An entry's derived figures, per side.
    struct Spent {
        uint256 freshSpent;
        uint256 freshUnspent;
        uint256 freshInheritable;
        uint256 freshAbsorbed;
        uint256 freshPrefix;
        uint256 recycledSpent;
        uint256 recycledUnspent;
        uint256 recycledInheritable;
        uint256 recycledPrefix;
    }

    /// @dev Fresh → recycled. The absorbed part still held is restitution
    ///      custody: not a correction's to move. Unspent credit moves first,
    ///      with its tokens; only then spent credit, as an inherited debit
    ///      — so what an entry keeps after any move that took spent units is
    ///      all spent, which is the correct-at-ingress result (design §5c).
    ///      The queues and the recorded figures move FIRST; the row
    ///      primitive then records nothing for the token move.
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
        // Spent units leave the source's INHERITED figure first (a reversal
        // of an earlier move: those consumption units return to the
        // recycled queue, spent there by its own record again); the rest
        // were paid out of the fresh queue and become inherited there.
        uint256 reversing = movingSpent < e.freshInherited ? movingSpent : e.freshInherited;
        _leaveFreshQueue(s, index, amount - reversing, movingSpent - reversing, e.freshAbsorbed - sp.freshAbsorbed, reversing);
        e.freshInherited -= reversing;
        e.recycledInherited += movingSpent - reversing;
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
    ///      inheritable of the spent part. The queues and the recorded
    ///      figures move FIRST (the split the credit will take is read
    ///      ahead); the row primitive then records nothing for the move.
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
        uint256 reversing = movingSpent < e.recycledInherited ? movingSpent : e.recycledInherited;
        _enterFreshQueue(s, index, movingUnspent, movingSpent - reversing, reversing);
        e.recycledInherited -= reversing;
        e.freshInherited += movingSpent - reversing;
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

    /// @dev Fresh → recycled, the queues and the recorded figures first.
    ///      Of the QUEUED credit that leaves (`queuedLeaving`: everything
    ///      but the reversed inherited part), the part the restitution row
    ///      had released back into the queue goes first — the entry's
    ///      absorbed record shrinks by it, so what it keeps recorded is
    ///      exactly what the row still holds. The spent units that leave
    ///      the fresh queue (`leavingSpent`, all of them paid) take their
    ///      figures with them; the reversed units (`reversing`) re-enter
    ///      the recycled queue as spent consumption, which is what they
    ///      were before the earlier move inherited them.
    function _leaveFreshQueue(
        LibVaipakam.Storage storage s,
        uint256 index,
        uint256 queuedLeaving,
        uint256 leavingSpent,
        uint256 released,
        uint256 reversing
    ) private {
        uint256 fromTree = queuedLeaving - _releaseLeave(s, index, queuedLeaving, released);
        uint64 era = s.reconciliationLog[index].era;
        _queueAdjust(s, era, index, -int256(fromTree), int256(queuedLeaving - leavingSpent + reversing));
        _shiftSpentFigures(s, era, -int256(leavingSpent), int256(reversing));
    }

    /// @dev The released part of the queued credit that leaves in a
    ///      correction: the entry's absorbed record and the released total
    ///      shrink by it. Returns what left of the released part.
    function _releaseLeave(
        LibVaipakam.Storage storage s,
        uint256 index,
        uint256 queuedLeaving,
        uint256 released
    ) private returns (uint256 releasedLeaving) {
        releasedLeaving = queuedLeaving < released ? queuedLeaving : released;
        _absorbedAdjust(s, index, -int256(releasedLeaving));
        s.freshReleasedTotal -= releasedLeaving;
    }

    /// @dev A correction's shift of the recorded spent figures: what leaves
    ///      a side's queue as an inherited debit takes its spent AND
    ///      charged figure with it (every unit that may leave is charged —
    ///      the inheritable bound says so), and what returns re-enters as
    ///      both.
    function _shiftSpentFigures(
        LibVaipakam.Storage storage s,
        uint64 era,
        int256 freshDelta,
        int256 recycledDelta
    ) private {
        s.freshSpentTotalByEra[era] = _applyDelta(s.freshSpentTotalByEra[era], freshDelta);
        s.freshPaidTotalByEra[era] = _applyDelta(s.freshPaidTotalByEra[era], freshDelta);
        s.recycledSpentTotal = _applyDelta(s.recycledSpentTotal, recycledDelta);
        s.recycledConsumedTotal = _applyDelta(s.recycledConsumedTotal, recycledDelta);
    }

    /// @dev Recycled → fresh, the queues and the recorded figures first.
    ///      The unspent part enters the fresh queue under the split the
    ///      credit will take (read ahead of the move: its absorbed part is
    ///      a record, not queued credit); the spent units that leave the
    ///      recycled queue (`leavingSpent`, all of them consumption) take
    ///      their figures with them; the reversed units (`reversing`)
    ///      re-enter the fresh queue as paid spend, which is what they were
    ///      before the earlier move inherited them.
    function _enterFreshQueue(
        LibVaipakam.Storage storage s,
        uint256 index,
        uint256 movingUnspent,
        uint256 leavingSpent,
        uint256 reversing
    ) private {
        uint64 era = s.reconciliationLog[index].era;
        (, uint256 absorbed) = LibRewardCustody.freshSplit(s, movingUnspent);
        _absorbedAdjust(s, index, int256(absorbed));
        _queueAdjust(s, era, index, int256(movingUnspent + reversing - absorbed), -int256(movingUnspent + leavingSpent));
        _shiftSpentFigures(s, era, int256(reversing), -int256(leavingSpent));
    }

    /// @dev Append a log entry and its records to the three trees: its
    ///      queued credit per side, and its absorbed record.
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
                recycledCredit: recycled,
                freshInherited: 0,
                recycledInherited: 0,
                freshAbsorbed: absorbed
            })
        );
        uint256 queuedFresh = fresh - absorbed;
        _treeAppend(s.freshQueueTreeByEra[era], queuedFresh);
        s.freshQueuedTotalByEra[era] += queuedFresh;
        _treeAppend(s.freshAbsorbedTree, absorbed);
        s.freshAbsorbedTotal += absorbed;
        _treeAppend(s.recycledQueueTree, recycled);
        s.recycledQueuedTotal += recycled;
    }

    /// @dev A correction's change to an entry's QUEUED credit on each side,
    ///      applied to the trees and the totals.
    function _queueAdjust(
        LibVaipakam.Storage storage s,
        uint64 era,
        uint256 index,
        int256 freshDelta,
        int256 recycledDelta
    ) private {
        if (freshDelta != 0) {
            _treeAdd(s.freshQueueTreeByEra[era], index + 1, freshDelta);
            s.freshQueuedTotalByEra[era] = _applyDelta(s.freshQueuedTotalByEra[era], freshDelta);
        }
        if (recycledDelta != 0) {
            _treeAdd(s.recycledQueueTree, index + 1, recycledDelta);
            s.recycledQueuedTotal = _applyDelta(s.recycledQueuedTotal, recycledDelta);
        }
    }

    /// @dev A change to an entry's ABSORBED record, applied to the entry,
    ///      the absorbed tree and its total.
    function _absorbedAdjust(LibVaipakam.Storage storage s, uint256 index, int256 delta) private {
        if (delta == 0) return;
        LibVaipakam.ReconciliationEntry storage e = s.reconciliationLog[index];
        e.freshAbsorbed = _applyDelta(e.freshAbsorbed, delta);
        _treeAdd(s.freshAbsorbedTree, index + 1, delta);
        s.freshAbsorbedTotal = _applyDelta(s.freshAbsorbedTotal, delta);
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

    /// @dev Spent-ness from the RECORDED figures (design §5c's FIFO, on the
    ///      landed shape): what a side's outflows took of the classified
    ///      queue — recorded at the row primitive, never read from a balance
    ///      — is attributed to the entries FIFO by log order: an entry's
    ///      spent part is that figure less the queued credit classified
    ///      before it (the tree's prefix), clamped to its own; its
    ///      inheritable part reads the charged figure the same way.
    ///      Inherited credit is spent, and inheritable back, by definition.
    function _spent(LibVaipakam.Storage storage s, uint256 index) private view returns (Spent memory r) {
        _spentFresh(s, index, r);
        _spentRecycled(s, index, r);
    }

    /// @dev The fresh side. The absorbed record is released the same way the
    ///      queue is spent: what the restitution row's outflows released of
    ///      the absorbed records (the row's other backing released first) is
    ///      attributed FIFO by log order over the absorbed tree and
    ///      re-enters the live queue — where the recorded spent figure says
    ///      whether it is unspent (the paid-correction moved it to live) or
    ///      spent (the deficit was paid with it). What the row still holds
    ///      is neither queued nor movable.
    function _spentFresh(LibVaipakam.Storage storage s, uint256 index, Spent memory r) private view {
        LibVaipakam.ReconciliationEntry storage e = s.reconciliationLog[index];
        uint256 releasedTotal = s.freshReleasedTotal;
        uint256 absorbedPrefix = _treePrefix(s.freshAbsorbedTree, index);
        uint256 released = _clampSpent(releasedTotal, absorbedPrefix, e.freshAbsorbed);
        r.freshAbsorbed = e.freshAbsorbed - released;
        uint256 queued = e.freshCredit - e.freshInherited - r.freshAbsorbed;
        r.freshPrefix = _treePrefix(s.freshQueueTreeByEra[e.era], index)
            + (absorbedPrefix < releasedTotal ? absorbedPrefix : releasedTotal);
        uint256 fifo = _clampSpent(s.freshSpentTotalByEra[e.era], r.freshPrefix, queued);
        r.freshSpent = e.freshInherited + fifo;
        r.freshUnspent = queued - fifo;
        r.freshInheritable = e.freshInherited + _clampSpent(s.freshPaidTotalByEra[e.era], r.freshPrefix, queued);
    }

    /// @dev The recycled side. Of the spent part only CONSUMPTION is
    ///      inheritable: what `consume` recorded (net of reversed payouts),
    ///      attributed first in queue order; plus what was inherited from
    ///      fresh. What left by surplus repatriation stays where it left from.
    function _spentRecycled(LibVaipakam.Storage storage s, uint256 index, Spent memory r) private view {
        LibVaipakam.ReconciliationEntry storage e = s.reconciliationLog[index];
        uint256 queued = e.recycledCredit - e.recycledInherited;
        r.recycledPrefix = _treePrefix(s.recycledQueueTree, index);
        uint256 fifo = _clampSpent(s.recycledSpentTotal, r.recycledPrefix, queued);
        r.recycledSpent = e.recycledInherited + fifo;
        r.recycledUnspent = queued - fifo;
        r.recycledInheritable = e.recycledInherited + _clampSpent(s.recycledConsumedTotal, r.recycledPrefix, queued);
    }

    function _clampSpent(uint256 figure, uint256 prefix, uint256 credit) private pure returns (uint256) {
        if (figure <= prefix) return 0;
        uint256 beyond = figure - prefix;
        return beyond < credit ? beyond : credit;
    }

    function _applyDelta(uint256 value, int256 delta) private pure returns (uint256) {
        return delta < 0 ? value - uint256(-delta) : value + uint256(delta);
    }

    // ─── Fenwick tree (1-indexed; index i = log index i − 1) ─────────────────

    function _lowbit(uint256 i) private pure returns (uint256) {
        unchecked {
            return i & (~i + 1);
        }
    }

    /// @dev Append the next index with `value`: the new node covers
    ///      (n − lowbit(n), n], so its sum is the prefix difference plus the
    ///      value.
    function _treeAppend(uint256[] storage t, uint256 value) private {
        uint256 n = t.length + 1;
        uint256 covered = value + _treePrefix(t, n - 1) - _treePrefix(t, n - _lowbit(n));
        t.push(covered);
    }

    function _treeAdd(uint256[] storage t, uint256 i, int256 delta) private {
        uint256 n = t.length;
        for (; i <= n; i += _lowbit(i)) {
            t[i - 1] = _applyDelta(t[i - 1], delta);
        }
    }

    /// @dev The sum of the first `i` indices (log indices 0 .. i − 1).
    function _treePrefix(uint256[] storage t, uint256 i) private view returns (uint256 sum) {
        for (; i > 0; i -= _lowbit(i)) {
            sum += t[i - 1];
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
