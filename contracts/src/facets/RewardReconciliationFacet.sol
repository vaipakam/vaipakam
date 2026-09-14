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
 *     bounded by what is still UNSPENT under a FIFO over the live queue:
 *     outflows since the queue began consume entries in classification
 *     order, an entry's effective position is its original one net of every
 *     reclassification touching earlier entries (moved out subtracts, moved
 *     in adds), and the sequencing counters the FIFO reads only ever grow.
 *     Unspent credit moves WITH its tokens (in-holder; the recycled side
 *     bounded by the uncommitted bucket, the fresh side by the live row);
 *     spent credit moves as an inherited debit — `received` and `paid`
 *     together, the destination's consumption rising — never replacement
 *     capital, because an authenticated ledger inherits it.
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
        uint256 index = _appendEntry(s, packetHash, freshShare, recycledShare);
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
        (uint256 freshSpent, uint256 recycledSpent, , ) = _spent(s, index);
        uint256 credit = freshToRecycled ? e.freshCredit : e.recycledCredit;
        if (amount > credit) revert ReconciliationExceedsCredit(index, amount, credit);
        uint256 unspent = credit - (freshToRecycled ? freshSpent : recycledSpent);
        uint256 movingUnspent = amount < unspent ? amount : unspent;
        uint256 movingSpent = amount - movingUnspent;
        uint256 refId = uint256(e.key);
        if (freshToRecycled) {
            uint256 live = s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.LiveFresh];
            if (movingUnspent > live) revert ReconciliationExceedsLiveRow(movingUnspent, live);
            LibRewardCustody.debitFreshFromLive(s, LibVaipakam.RewardCustodyRow.Recycled, movingUnspent);
            LibVpfiRecycle.creditBucketReattributed(refId, movingUnspent, false);
            LibRewardCustody.inheritFreshDebitAsRecycled(s, movingSpent);
            LibVpfiRecycle.creditBucketReattributed(refId, movingSpent, true);
            e.freshCredit -= amount;
            e.recycledCredit += amount;
            e.freshShift -= int256(movingUnspent);
            e.recycledShift += int256(amount);
        } else {
            LibVpfiRecycle.debitBucketReattributed(refId, movingUnspent, false);
            LibRewardCustody.creditFreshFromRow(s, LibVaipakam.RewardCustodyRow.Recycled, movingUnspent);
            LibVpfiRecycle.debitBucketReattributed(refId, movingSpent, true);
            LibRewardCustody.inheritRecycledDebitAsFresh(s, e.era, movingSpent);
            e.recycledCredit -= amount;
            e.freshCredit += amount;
            e.recycledShift -= int256(movingUnspent);
            e.freshShift += int256(amount);
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
        LibRewardCustody.relocateFreshIngress(s, relocateFresh);
        LibVpfiRecycle.creditCustodyRelocated(refId, relocateRecycled, LibVpfiRecycle.RecycleSource.LegacyReconciliation);
        LibRewardCustody.pullFromCaller(s, msg.sender, replaceFresh + replaceRecycled);
        LibRewardCustody.creditFreshIngress(s, replaceFresh);
        LibVpfiRecycle.creditCustodyFundedInHolder(refId, replaceRecycled);
        uint256 index = _appendEntry(s, snapshotId, relocateFresh + replaceFresh, relocateRecycled + replaceRecycled);
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

    /// @notice An entry's spent-ness under the live-queue FIFO, per side,
    ///         with the effective positions it was read at. Scans the
    ///         entries before it — operator reads and paused corrections
    ///         only; the outflows themselves stay O(1).
    function getReconciliationEntrySpent(
        uint256 index
    )
        external
        view
        returns (uint256 freshSpent, uint256 recycledSpent, uint256 freshEffectivePos, uint256 recycledEffectivePos)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (index >= s.reconciliationLog.length) revert ReconciliationEntryUnknown(index);
        return _spent(s, index);
    }

    /// @notice The two monotone sequencing counters and the queue bases the
    ///         FIFO measures outflow from.
    function getSideOutflow(
        uint64 era
    ) external view returns (uint256 freshSeq, uint256 recycledSeq, uint256 freshQueueBase, uint256 recycledQueueBase) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (s.freshOutflowSeqByEra[era], s.recycledOutflowSeq, s.freshQueueBaseByEra[era], s.recycledQueueBase);
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

    /// @dev Append a log entry at the two queues' current positions, opening
    ///      a queue (its base = the sequencing counter now) on its first entry.
    function _appendEntry(
        LibVaipakam.Storage storage s,
        bytes32 key,
        uint256 fresh,
        uint256 recycled
    ) private returns (uint256 index) {
        uint64 era = PRE_BACKFILL_ERA;
        if (!s.freshQueueOpenByEra[era]) {
            s.freshQueueOpenByEra[era] = true;
            s.freshQueueBaseByEra[era] = s.freshOutflowSeqByEra[era];
        }
        if (!s.recycledQueueOpen) {
            s.recycledQueueOpen = true;
            s.recycledQueueBase = s.recycledOutflowSeq;
        }
        index = s.reconciliationLog.length;
        s.reconciliationLog.push(
            LibVaipakam.ReconciliationEntry({
                key: key,
                era: era,
                landedAt: uint64(block.timestamp),
                freshCredit: fresh,
                recycledCredit: recycled,
                freshPos: s.freshQueuePosByEra[era],
                recycledPos: s.recycledQueuePos,
                freshShift: 0,
                recycledShift: 0
            })
        );
        s.freshQueuePosByEra[era] += fresh;
        s.recycledQueuePos += recycled;
    }

    /// @dev Spent-ness over the LIVE queue (design §5c): the outflow since
    ///      the queue began, less the entry's effective position, clamped to
    ///      its credit. The effective position is the recorded one plus the
    ///      shifts of every earlier entry of the same queue.
    function _spent(
        LibVaipakam.Storage storage s,
        uint256 index
    )
        private
        view
        returns (uint256 freshSpent, uint256 recycledSpent, uint256 freshEffectivePos, uint256 recycledEffectivePos)
    {
        LibVaipakam.ReconciliationEntry storage e = s.reconciliationLog[index];
        int256 freshShift;
        int256 recycledShift;
        for (uint256 i = 0; i < index; ++i) {
            LibVaipakam.ReconciliationEntry storage earlier = s.reconciliationLog[i];
            if (earlier.era == e.era) freshShift += earlier.freshShift;
            recycledShift += earlier.recycledShift;
        }
        freshEffectivePos = _shifted(e.freshPos, freshShift);
        recycledEffectivePos = _shifted(e.recycledPos, recycledShift);
        uint256 freshOut = s.freshOutflowSeqByEra[e.era] - s.freshQueueBaseByEra[e.era];
        uint256 recycledOut = s.recycledOutflowSeq - s.recycledQueueBase;
        freshSpent = _clampSpent(freshOut, freshEffectivePos, e.freshCredit);
        recycledSpent = _clampSpent(recycledOut, recycledEffectivePos, e.recycledCredit);
    }

    function _shifted(uint256 pos, int256 shift) private pure returns (uint256) {
        int256 effective = int256(pos) + shift;
        return effective > 0 ? uint256(effective) : 0;
    }

    function _clampSpent(uint256 outflow, uint256 pos, uint256 credit) private pure returns (uint256) {
        if (outflow <= pos) return 0;
        uint256 beyond = outflow - pos;
        return beyond < credit ? beyond : credit;
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
