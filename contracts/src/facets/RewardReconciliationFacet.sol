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
 *     by the operator's component caps (fixed by the first entry, immutable
 *     after, their sum bounded by the classifiable part — so a wrong split
 *     refuses rather than exhausting the hash), by the row's own figure and
 *     the global uncounted aggregate, and by a per-entry replay guard.
 *     Cumulative per component: an understated entry leaves the hash
 *     classifiable; a rounding residual STAYS in the row.
 *  2. **`reclassifyReconciliationEntry`** — attribution moves between the two
 *     sides of an already-classified entry without changing its total,
 *     bounded by what is still UNSPENT. Spent-ness reads the pool itself:
 *     what the side's pool — the live row; the bucket — no longer physically
 *     backs of the classified credits is spent, distributed among the
 *     entries FIFO by classification order (the earliest spent first) through
 *     a Fenwick tree's prefix sums, so a correction's work is logarithmic in
 *     the log and no writer of the pool has to know about the queue. Unspent
 *     credit moves WITH its tokens (in-holder; the recycled side bounded by
 *     the uncommitted bucket); spent credit moves as an inherited debit —
 *     `received` and `paid` together, the destination's consumption rising —
 *     never replacement capital, because an authenticated ledger inherits
 *     it; on the recycled side only consumption is inheritable. The part of
 *     a fresh credit the standing deficit absorbed into restitution is
 *     neither queued nor movable. A packet's component counters and caps
 *     follow its entry, so the caps stay the corrected split.
 *  3. **`importLegacyEnvelope`** — the inventory that arrived BEFORE packets
 *     were stamped, as ONE netted aggregate every figure of which is read on
 *     chain at the import (`uncounted − holder-held − Diamond-side reserved −
 *     returned`), resolved whole and once: relocated from the Diamond's own
 *     balance (measured), replacement-funded by the caller (delta-checked),
 *     or written down — and entered into the same log, so the snapshot-keyed
 *     error path is the same reclassification.
 *
 *     The epoch stays open, without exception: no finalization exists here
 *     (design §5c, "what an operator's off-chain confidence buys is the
 *     decision to stop watching, never a state transition"). What stays out:
 *     transport epochs (they need slice 4 PR C's era balances to be
 *     consumable; a PR of their own before PR C), the era registry itself
 *     (every entry keys era 0 until PR C's backfill), and the owner-only
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
    /// @notice The packet's component caps were fixed by its first entry.
    /// @custom:event-category state-change/reward-custody
    event LegacyPacketCapsFixed(bytes32 indexed packetHash, uint256 freshCap, uint256 recycledCap, uint256 budget);
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
        uint256 relocatedFresh,
        uint256 relocatedRecycled,
        uint256 replacedFresh,
        uint256 replacedRecycled,
        uint256 writtenDown
    );

    uint64 internal constant PRE_BACKFILL_ERA = 0;

    // ─── The entries ────────────────────────────────────────────────────────

    /**
     * @notice Classify part of a legacy packet's untyped remainder out of the
     *         `Unclassified` row: `freshShare` to the received side (live
     *         backing, or restitution for what the standing deficit absorbs)
     *         and `recycledShare` to the bucket, both in-holder.
     * @dev    ADMIN, MANUAL pause, activated. Every bound is checked BEFORE
     *         any mutation, so a mistaken entry reverts whole. The first
     *         entry for a packet fixes its component caps; every later entry
     *         must restate them. A packet whose receipt still carries a live
     *         stranded-recovery record is not classifiable: its value is the
     *         R4 return's.
     * @param  packetHash    The packet's ingress stamp.
     * @param  freshShare    Classified as fresh.
     * @param  recycledShare Classified as recycled.
     * @param  freshCap      The authenticated fresh component of the
     *                       classifiable part (fixed once).
     * @param  recycledCap   The authenticated recycled component (fixed once).
     * @param  entryId       The operator's entry reference; applied once.
     */
    function classifyLegacyPacket(
        bytes32 packetHash,
        uint256 freshShare,
        uint256 recycledShare,
        uint256 freshCap,
        uint256 recycledCap,
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
        _fixCaps(p, packetHash, freshCap, recycledCap);
        uint256 cumulativeFresh = p.classifiedFresh + freshShare;
        if (cumulativeFresh > p.freshCap) {
            revert ReconciliationComponentCapExceeded(packetHash, 0, cumulativeFresh, p.freshCap);
        }
        uint256 cumulativeRecycled = p.classifiedRecycled + recycledShare;
        if (cumulativeRecycled > p.recycledCap) {
            revert ReconciliationComponentCapExceeded(packetHash, 1, cumulativeRecycled, p.recycledCap);
        }
        // The three effects, atomically: the step-down (packet remainder,
        // row figure, global aggregate — each exact), the fresh credit under
        // the split, the bucket credit as relocated custody.
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
     *         source credit under the live-queue FIFO; beyond it, the spent
     *         part moves as an inherited debit.
     * @dev    ADMIN, MANUAL pause, activated. Fresh → recycled: the unspent
     *         part leaves the LIVE row with its tokens (restitution custody
     *         is not a correction's to move) and raises the bucket; the
     *         spent part lowers `received` and `paid` together and raises
     *         the recycled consumption. Recycled → fresh: the unspent part
     *         leaves the bucket (bounded by its uncommitted balance) into
     *         live or restitution under the split; the spent part raises
     *         `received` and `paid` together and gives the recycled
     *         consumption back. Every later entry of the touched queue
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
        LibVaipakam.ReconciliationEntry storage e = s.reconciliationLog[index];
        Spent memory sp = _spent(s, index);
        uint256 refId = uint256(e.key);
        uint256 movingUnspent;
        uint256 movingSpent;
        if (freshToRecycled) {
            // The absorbed part is restitution custody: not a correction's
            // to move. Unspent credit moves first, with its tokens; only then
            // spent credit, as an inherited debit — so what an entry keeps
            // after any move that took spent units is all spent.
            uint256 movable = sp.freshUnspent + sp.freshSpent;
            if (amount > movable) revert ReconciliationRestitutionNotMovable(index, amount, movable);
            movingUnspent = amount < sp.freshUnspent ? amount : sp.freshUnspent;
            movingSpent = amount - movingUnspent;
            LibRewardCustody.debitFreshFromLive(s, LibVaipakam.RewardCustodyRow.Recycled, movingUnspent);
            LibVpfiRecycle.creditBucketReattributed(refId, movingUnspent, false);
            LibRewardCustody.inheritFreshDebitAsRecycled(s, movingSpent);
            LibVpfiRecycle.creditBucketReattributed(refId, movingSpent, true);
            // Spent units leave the source's INHERITED figure first (a
            // reversal of an earlier move: those consumption units return to
            // the recycled queue); the rest were spent here and become
            // inherited there.
            uint256 reversing = movingSpent < e.freshInherited ? movingSpent : e.freshInherited;
            e.freshInherited -= reversing;
            e.recycledConsumedInherited -= reversing;
            s.recycledConsumedInheritedTotal -= reversing;
            e.recycledInherited += movingSpent - reversing;
            e.freshCredit -= amount;
            e.recycledCredit += amount;
            _queueAdjust(s, e.era, index, -int256(movingUnspent + movingSpent - reversing), int256(movingUnspent + reversing));
            _packetFollows(s, e, amount, true);
        } else {
            movingUnspent = amount < sp.recycledUnspent ? amount : sp.recycledUnspent;
            movingSpent = amount - movingUnspent;
            if (movingSpent > sp.recycledInheritable) {
                revert ReconciliationSpentRecycledNotInheritable(index, movingSpent, sp.recycledInheritable);
            }
            LibVpfiRecycle.debitBucketReattributed(refId, movingUnspent, false);
            (, uint256 absorbed) =
                LibRewardCustody.creditFreshFromRow(s, LibVaipakam.RewardCustodyRow.Recycled, movingUnspent);
            LibVpfiRecycle.debitBucketReattributed(refId, movingSpent, true);
            LibRewardCustody.inheritRecycledDebitAsFresh(s, movingSpent);
            uint256 reversing = movingSpent < e.recycledInherited ? movingSpent : e.recycledInherited;
            e.recycledInherited -= reversing;
            e.recycledConsumedInherited += movingSpent - reversing;
            s.recycledConsumedInheritedTotal += movingSpent - reversing;
            e.freshInherited += movingSpent - reversing;
            e.freshAbsorbed += absorbed;
            e.recycledCredit -= amount;
            e.freshCredit += amount;
            _queueAdjust(s, e.era, index, int256(movingUnspent + reversing - absorbed), -int256(movingUnspent + movingSpent - reversing));
            _packetFollows(s, e, amount, false);
        }
        emit ReconciliationEntryReclassified(index, entryId, freshToRecycled, movingUnspent, movingSpent);
    }

    /**
     * @notice Import the pre-stamp inventory as one netted envelope, whole
     *         and once: every unit of it relocated from the Diamond's own
     *         balance (measured), replacement-funded by the caller
     *         (delta-checked into the holder), or written down.
     * @dev    ADMIN, MANUAL pause, activated. The envelope's figures are all
     *         read on chain at the call — the operator asserts nothing the
     *         chain can state — and the five dispositions must sum to the
     *         netted total exactly. The fresh dispositions credit the
     *         received side under the deficit split; the recycled ones
     *         credit the bucket as relocated custody. The whole leaves the
     *         global uncounted aggregate, the written-down part recorded as
     *         such: it is value pre-holder outflows spent, not custody. The
     *         envelope's log entry is reclassifiable like any other.
     * @param  snapshotId      The ceremony's record id; one import per id.
     * @param  relocateFresh   Relocated from the Diamond as fresh.
     * @param  relocateRecycled Relocated from the Diamond as recycled.
     * @param  replaceFresh    Pulled from the caller as fresh.
     * @param  replaceRecycled Pulled from the caller as recycled.
     * @param  writeDown       Recorded as gone.
     */
    function importLegacyEnvelope(
        bytes32 snapshotId,
        uint256 relocateFresh,
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
        uint256 stated = relocateFresh + relocateRecycled + replaceFresh + replaceRecycled + writeDown;
        if (stated != netTotal) revert LegacyEnvelopeMismatch(snapshotId, stated, netTotal);
        s.rewardBudgetFreshUncounted = raw - netTotal;
        uint256 refId = uint256(snapshotId);
        uint256 freshTotal = relocateFresh + replaceFresh;
        uint256 recycledTotal = relocateRecycled + replaceRecycled;
        (, uint256 absorbed) = LibRewardCustody.relocateFreshIngress(s, relocateFresh);
        LibVpfiRecycle.creditCustodyRelocated(refId, relocateRecycled, LibVpfiRecycle.RecycleSource.LegacyReconciliation);
        LibRewardCustody.pullFromCaller(s, msg.sender, replaceFresh + replaceRecycled);
        (, uint256 absorbedReplaced) = LibRewardCustody.creditFreshIngress(s, replaceFresh);
        LibVpfiRecycle.creditCustodyFundedInHolder(refId, replaceRecycled);
        uint256 index = _pushEntry(s, snapshotId, true, freshTotal, recycledTotal, absorbed + absorbedReplaced);
        env.importedAt = uint64(block.timestamp);
        env.rawUncounted = raw;
        env.holderUncounted = holderUncounted;
        env.diamondReserved = diamondReserved;
        env.returnedCumulative = returned;
        env.netTotal = netTotal;
        env.relocatedFresh = relocateFresh;
        env.relocatedRecycled = relocateRecycled;
        env.replacedFresh = replaceFresh;
        env.replacedRecycled = replaceRecycled;
        env.writtenDown = writeDown;
        env.entryIndex = index;
        emit LegacyEnvelopeImported(
            snapshotId, index, netTotal, relocateFresh, relocateRecycled, replaceFresh, replaceRecycled, writeDown
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

    /// @notice A packet's reconciliation figures: what it put into the row,
    ///         what it still holds there, its exits by kind, and its caps.
    ///         Identity: `unclassified + classifiedFresh + classifiedRecycled
    ///         + disposed == protectedCumulative`.
    function getPacketReconciliation(
        bytes32 packetHash
    )
        external
        view
        returns (
            uint256 protectedCumulative,
            uint256 unclassified,
            uint256 classifiedFresh,
            uint256 classifiedRecycled,
            uint256 disposed,
            uint256 freshCap,
            uint256 recycledCap,
            bool capsFixed
        )
    {
        LibVaipakam.IngressPacket storage p = LibVaipakam.storageSlot().ingressPackets[packetHash];
        return (
            p.protectedCumulative,
            p.unclassified,
            p.classifiedFresh,
            p.classifiedRecycled,
            p.disposed,
            p.freshCap,
            p.recycledCap,
            p.capsFixed
        );
    }

    /// @notice A log entry as recorded.
    function getReconciliationEntry(uint256 index) external view returns (LibVaipakam.ReconciliationEntry memory) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (index >= s.reconciliationLog.length) revert ReconciliationEntryUnknown(index);
        return s.reconciliationLog[index];
    }

    /// @notice An entry's spent-ness, per side — its inherited figure plus
    ///         what the side's pool no longer backs of it, in FIFO order —
    ///         what of it is still unspent (movable with its tokens), the
    ///         part of the recycled spent-ness a fresh-side correction may
    ///         inherit (consumption attributed first in queue order, plus
    ///         what was inherited from fresh), the restitution-absorbed part
    ///         of its fresh credit (neither queued nor movable), and the
    ///         queued credit classified before it on each side (the tree's
    ///         prefix). Logarithmic in the log's length.
    function getReconciliationEntrySpent(
        uint256 index
    ) external view returns (Spent memory) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (index >= s.reconciliationLog.length) revert ReconciliationEntryUnknown(index);
        return _spent(s, index);
    }

    /// @notice The two queues as they stand: each side's queued classified
    ///         credit against the pool that backs it (the live row of `era`;
    ///         the bucket), and the recycled consumption record.
    function getQueueState(
        uint64 era
    )
        external
        view
        returns (
            uint256 freshQueuedTotal,
            uint256 liveRow,
            uint256 recycledQueuedTotal,
            uint256 bucket,
            bool recycledOpen,
            uint256 recycledConsumedSeq,
            uint256 recycledConsumedBase,
            uint256 recycledConsumedInheritedTotal
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.freshQueuedTotalByEra[era],
            s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.LiveFresh],
            s.recycledQueuedTotal,
            s.recycleBucket,
            s.recycledQueueOpen,
            s.recycledConsumedSeq,
            s.recycledQueueConsumedBase,
            s.recycledConsumedInheritedTotal
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

    /// @dev The caps are the operator's authenticated component split of the
    ///      packet's CLASSIFIABLE part (what it holds in the row plus what
    ///      was classified — never what a repatriation already took out),
    ///      fixed by the first entry and restated exactly by every later one.
    function _fixCaps(
        LibVaipakam.IngressPacket storage p,
        bytes32 packetHash,
        uint256 freshCap,
        uint256 recycledCap
    ) private {
        if (p.capsFixed) {
            if (freshCap != p.freshCap || recycledCap != p.recycledCap) {
                revert ReconciliationCapsFixed(packetHash, p.freshCap, p.recycledCap);
            }
            return;
        }
        uint256 budget = p.unclassified + p.classifiedFresh + p.classifiedRecycled;
        if (freshCap + recycledCap > budget) {
            revert ReconciliationCapsExceedBudget(packetHash, freshCap + recycledCap, budget);
        }
        p.freshCap = freshCap;
        p.recycledCap = recycledCap;
        p.capsFixed = true;
        emit LegacyPacketCapsFixed(packetHash, freshCap, recycledCap, budget);
    }

    /// @notice An entry's derived figures, per side.
    struct Spent {
        uint256 freshSpent;
        uint256 freshUnspent;
        uint256 freshAbsorbed;
        uint256 freshPrefix;
        uint256 recycledSpent;
        uint256 recycledUnspent;
        uint256 recycledInheritable;
        uint256 recycledPrefix;
    }

    /// @dev Append a log entry and its queued credit to both trees; the
    ///      recycled queue's consumption base is taken at its first
    ///      positive credit (Codex #2206 r1: a zero-credit side opens
    ///      nothing, so consumption before the first recycled classification
    ///      is never inheritable through it).
    function _pushEntry(
        LibVaipakam.Storage storage s,
        bytes32 key,
        bool envelope,
        uint256 fresh,
        uint256 recycled,
        uint256 absorbed
    ) private returns (uint256 index) {
        uint64 era = PRE_BACKFILL_ERA;
        if (recycled != 0 && !s.recycledQueueOpen) {
            s.recycledQueueOpen = true;
            s.recycledQueueConsumedBase = s.recycledConsumedSeq;
        }
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
                freshAbsorbed: absorbed,
                recycledConsumedInherited: 0
            })
        );
        uint256 queuedFresh = fresh - absorbed;
        _treeAppend(s.freshQueueTreeByEra[era], queuedFresh);
        s.freshQueuedTotalByEra[era] += queuedFresh;
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

    /// @dev A packet-backed entry's correction moves the packet's component
    ///      counters AND its caps with it (Codex #2206 r2): the caps are the
    ///      operator's authenticated split, and a correction is that split
    ///      restated — their sum unchanged, each component still covering
    ///      what was classified into it. An envelope entry has no packet.
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
            p.freshCap -= amount;
            p.recycledCap += amount;
        } else {
            p.classifiedRecycled -= amount;
            p.classifiedFresh += amount;
            p.recycledCap -= amount;
            p.freshCap += amount;
        }
        emit LegacyPacketCapsFixed(e.key, p.freshCap, p.recycledCap, p.unclassified + p.classifiedFresh + p.classifiedRecycled);
    }

    /// @dev Spent-ness reads the pool (design §5c's FIFO, on the landed
    ///      shape): what a side's pool no longer physically backs of the
    ///      classified queued credit — the live row of the era for fresh
    ///      (restitution is not live backing), the bucket for recycled — is
    ///      spent, and is attributed to the entries FIFO by log order: an
    ///      entry's spent part is that shortfall less the queued credit
    ///      classified before it (the tree's prefix), clamped to its own.
    ///      Inherited credit is spent by definition; on the recycled side
    ///      the INHERITABLE part attributes the bucket's consumption since
    ///      the queue opened — less what the fresh side already inherited —
    ///      first in queue order, plus what was inherited from fresh; what
    ///      left by surplus repatriation stays where it left from.
    function _spent(LibVaipakam.Storage storage s, uint256 index) private view returns (Spent memory r) {
        LibVaipakam.ReconciliationEntry storage e = s.reconciliationLog[index];
        uint256 queuedFresh = e.freshCredit - e.freshInherited - e.freshAbsorbed;
        uint256 live = s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.LiveFresh];
        uint256 totalFresh = s.freshQueuedTotalByEra[e.era];
        uint256 shortFresh = totalFresh > live ? totalFresh - live : 0;
        r.freshPrefix = _treePrefix(s.freshQueueTreeByEra[e.era], index);
        uint256 fifoFresh = _clampSpent(shortFresh, r.freshPrefix, queuedFresh);
        r.freshSpent = e.freshInherited + fifoFresh;
        r.freshUnspent = queuedFresh - fifoFresh;
        r.freshAbsorbed = e.freshAbsorbed;

        uint256 queuedRecycled = e.recycledCredit - e.recycledInherited;
        uint256 bucket = s.recycleBucket;
        uint256 totalRecycled = s.recycledQueuedTotal;
        uint256 shortRecycled = totalRecycled > bucket ? totalRecycled - bucket : 0;
        r.recycledPrefix = _treePrefix(s.recycledQueueTree, index);
        uint256 fifoRecycled = _clampSpent(shortRecycled, r.recycledPrefix, queuedRecycled);
        r.recycledSpent = e.recycledInherited + fifoRecycled;
        r.recycledUnspent = queuedRecycled - fifoRecycled;
        uint256 consumed = s.recycledQueueOpen ? s.recycledConsumedSeq - s.recycledQueueConsumedBase : 0;
        uint256 passedOn = s.recycledConsumedInheritedTotal;
        uint256 consumedLeft = consumed > passedOn ? consumed - passedOn : 0;
        uint256 inheritableTotal = consumedLeft < shortRecycled ? consumedLeft : shortRecycled;
        r.recycledInheritable = e.recycledInherited + _clampSpent(inheritableTotal, r.recycledPrefix, queuedRecycled);
    }

    function _clampSpent(uint256 shortfall, uint256 prefix, uint256 credit) private pure returns (uint256) {
        if (shortfall <= prefix) return 0;
        uint256 beyond = shortfall - prefix;
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
