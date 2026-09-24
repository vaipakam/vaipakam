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
 *     bounded by what is still UNSPENT (and, with its tokens, by what the
 *     pool holds beyond its commitments) and, toward fresh, by the same
 *     evidence. Spent-ness is RECORDED, never read from a balance, and
 *     recorded INTO the entry's own record (Codex #2206 r4–r6): each side's
 *     queue is one record per entry at the entry's own log index — the
 *     classification order the design fixes — with a frontier, and every
 *     outflow of a pool passes through that pool's own debit primitive,
 *     which writes what the outflow took of the queue (the pool's other
 *     backing consumed first, never more than the records still hold) into
 *     the records at the frontier, earliest first, with its kind — by a
 *     walk bounded per outflow, the rest pending in order, so no payout can
 *     ever be wedged. So a later credit un-spends nothing, a refill is
 *     consumed once, and which entry a consumption or a repatriation took
 *     from is known, not inferred. Unspent credit moves WITH its tokens
 *     (in-holder; bounded by the uncommitted live row or bucket); spent
 *     credit moves as an inherited debit — `received` and `paid` together,
 *     the destination's consumption rising — never replacement capital,
 *     because an authenticated ledger inherits it; and only spent credit the
 *     side's ledger actually charged (fresh `paid`; recycled consumption) is
 *     inheritable. Credit a correction moves re-enters the other side AT
 *     THE ENTRY'S OWN POSITION (design §5c: moved-in credit keeps its
 *     original order), the frontier moving back to it. Unspent credit moves
 *     FIRST: that order is what reproduces the ledger a correct-at-ingress
 *     split would have produced — the corrected credit still covers the
 *     first of the entry's payouts, and only what it can no longer cover
 *     was, in truth, the other side's. The part of a fresh credit the
 *     standing deficit absorbed into restitution is neither queued nor
 *     movable for as long as the restitution row holds it; what the row
 *     releases of it (recorded at the row's outflow the same way) re-enters
 *     the entry's own fresh record — free when the paid-correction moved it
 *     to live, spent when the deficit was paid with it. A packet's component
 *     counters follow its entry. A correction requires the side's pending
 *     takes drained; anyone may drain them (`advanceReconciliationQueue`).
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
    /// @notice A released remit's consumption that a correction had
    ///         inherited to an entry's fresh record was un-inherited by the
    ///         release: the payout never happened, so the units returned to
    ///         the recycled record, spent and uncharged (Codex #2206 r9).
    /// @custom:event-category state-change/reward-custody
    event ReconciliationInheritanceUndone(uint256 indexed remitId, uint256 indexed entryIndex, uint256 amount);
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
        // #1566 transport epochs PR 3b — an old-wire packet is classifiable
        // only once its TRANSPORT EPOCH has been released: the batch's
        // remainder parked, with its acknowledgment recorded (§5c names that
        // the only route). Classifying earlier would spend value the batch's
        // own listed obligations can still draw.
        //
        // The same call DEBITS the parked remainder by what this
        // classification takes (Codex #2232 r1). Classification is one of the
        // remainder's dispositions, so leaving the entry at its parked figure
        // would report value that has already left — and it bounds the take at
        // what the entry still holds, which is a second ceiling beside the
        // packet's own remainder. A packet that can never hold a batch passes
        // untouched and is debited nothing — which population that is, is
        // decided inside by LibRewardCustody.rolloutAdmissionStatus and is
        // deliberately not restated here (Codex #2232 r15): the list that used
        // to stand in this comment said "a pre-3b arrival", and an arrival
        // between 3a and 3b is owed an epoch rather than exempt from one.
        LibRewardCustody.takeFromReleasedRemainder(s, packetHash, freshShare + recycledShare);
        if (p.kind <= LibRewardCustody.PACKET_KIND_COMPENSATION) {
            LibVaipakam.StrandedRecovery storage sr =
                s.strandedRecoveries[keccak256(abi.encode(p.remitter, p.remitId))];
            if (sr.amount != 0 || sr.held != 0) revert ReconciliationPacketReserved(packetHash, sr.amount);
        }
        if (freshShare != 0) {
            _requireEvidence(packetHash, p.classifiedFresh + freshShare, LibRewardCustody.authenticatedFresh(p));
        }
        // The three effects, atomically: the step-down (packet remainder,
        // row figure, global aggregate — each exact), the fresh credit under
        // the split, the bucket credit as relocated custody. The credits are
        // INFLOWS of their rows; the row primitive records nothing for them,
        // and the entry's records join the queues at the tail.
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
     * @dev    ADMIN, MANUAL pause, activated, both queues drained. Fresh →
     *         recycled: the unspent part leaves the LIVE row with its tokens
     *         (restitution custody is not a correction's to move; the live
     *         row's outstanding fresh commitments stay) and raises the
     *         bucket; the spent part (paid) lowers `received` and `paid`
     *         together and raises the recycled consumption. Recycled →
     *         fresh: bounded by the entry's evidence (a packet's
     *         authenticated fresh figure; the envelope's replacement-funded
     *         fresh); the unspent part leaves the bucket (bounded by its
     *         uncommitted balance) into live or restitution under the split;
     *         the spent part (consumption) raises `received` and `paid`
     *         together and gives the recycled consumption back. The queues
     *         are adjusted BEFORE the tokens move, so the pool's debit
     *         primitive records nothing for the correction's own move; what
     *         moves re-enters the other side at the entry's own position.
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
        uint64 era = s.reconciliationLog[index].era;
        if (!LibRewardCustody.queueSettled(s, LibRewardCustody.SIDE_FRESH, era)) {
            revert ReconciliationQueueBehind(LibRewardCustody.SIDE_FRESH);
        }
        if (!LibRewardCustody.queueSettled(s, LibRewardCustody.SIDE_RECYCLED, era)) {
            revert ReconciliationQueueBehind(LibRewardCustody.SIDE_RECYCLED);
        }
        uint256 movingUnspent;
        uint256 movingSpent;
        if (freshToRecycled) {
            (movingUnspent, movingSpent) = _splitFreshMove(s, index, amount);
            _moveToRecycled(s, index, movingUnspent, movingSpent);
        } else {
            (movingUnspent, movingSpent) = _moveToFresh(s, index, amount);
        }
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

    /// @notice Write a queue's pending takes into its records, visiting at
    ///         most `steps` entries — what a hot outflow's bounded walk left
    ///         behind. Permissionless: it moves no value and changes no
    ///         total, only writes what is already recorded into the entries
    ///         it belongs to. `side`: 0 fresh (its backlog carries the
    ///         restitution releases too), 1 recycled.
    function advanceReconciliationQueue(uint8 side, uint256 steps) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (side == LibRewardCustody.SIDE_FRESH) {
            LibRewardCustody.advanceFresh(s, LibRewardCustody.PRE_BACKFILL_ERA, steps);
        } else if (side == LibRewardCustody.SIDE_RECYCLED) {
            LibRewardCustody.advanceRecycled(s, steps, 0);
        } else {
            revert ReconciliationUnknownSide(side);
        }
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
    ///         outflow's take of the fresh queue (bounded walk).
    function reconciliationTakeFresh(uint256 have, uint256 amount, bool paid) external {
        _requireDiamondInternal();
        LibRewardCustody.takeFresh(LibVaipakam.storageSlot(), LibRewardCustody.PRE_BACKFILL_ERA, have, amount, paid);
    }

    /// @notice Diamond-internal: {LibRewardCustody.releaseAbsorbed} — a
    ///         restitution-row outflow's release of the absorbed records.
    function reconciliationReleaseAbsorbed(uint256 have, uint256 amount, bool toLive, bool paid) external {
        _requireDiamondInternal();
        LibRewardCustody.releaseAbsorbed(LibVaipakam.storageSlot(), have, amount, toLive, paid);
    }

    /// @notice Diamond-internal: {LibRewardCustody.takeRecycled} — a
    ///         bucket-ledger debit's take of the recycled queue (a remit's
    ///         writes noted on its reservation).
    function reconciliationTakeRecycled(
        uint256 bucketBefore,
        uint256 amount,
        bool consumption,
        bool mustComplete,
        uint256 remitId
    ) external returns (uint256 took) {
        _requireDiamondInternal();
        return LibRewardCustody.takeRecycled(
            LibVaipakam.storageSlot(), bucketBefore, amount, consumption, mustComplete, remitId
        );
    }

    /// @notice Diamond-internal: a released remit's recorded consumption
    ///         reversed on exactly the records its take wrote, by exactly
    ///         what it wrote there (its payout never happened). A record's
    ///         recycled charge is lowered first; what is no longer there a
    ///         correction had meanwhile moved to the entry's FRESH record as
    ///         an inherited debit, and that inheritance is UNDONE — the units
    ///         return to the recycled record, spent and uncharged (stranded
    ///         like the rest of the take, never inheritable), the fresh
    ///         ledger's `received` and `paid` fall together, and the bucket's
    ///         payout figure takes the consumption back as a reattribution —
    ///         so the caller then reverses the remit's WHOLE sent share and
    ///         the stranded figure carries the full physical loss the
    ///         coverage relation must see (Codex #2206 r7, r9). What neither
    ///         record holds is a defect (an entry's charges always sum to
    ///         the consumption attributed to it) and refuses. The
    ///         reservation's record is cleared: a release is one-shot.
    function reconciliationReverseRemitTake(uint256 remitId) external {
        _requireDiamondInternal();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.RemitReservation storage r = s.remitReservations[remitId];
        uint256[] storage takes = r.classifiedTakes;
        uint256 n = takes.length;
        uint256 found;
        for (uint256 i = 0; i < n; ++i) {
            uint256 packed = takes[i];
            uint256 index = packed >> 128;
            uint256 amount = packed & type(uint128).max;
            LibVaipakam.SideRecord storage rec = s.recycledRecords[index];
            uint256 c = rec.charged;
            if (amount > c) {
                uint256 inherited = amount - c;
                if (inherited > s.freshRecords[index].charged) {
                    revert ReconciliationQueueInconsistent(LibRewardCustody.SIDE_RECYCLED);
                }
                _moveToRecycled(s, index, 0, inherited);
                emit ReconciliationInheritanceUndone(remitId, index, inherited);
            }
            rec.charged = uint128(rec.charged - amount);
            found += amount;
        }
        s.recycledConsumedTotal -= found;
        delete r.classifiedTakes;
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

    /// @notice By how much a classification `packetHash` carried BEFORE its
    ///         split was attested exceeds the attested cap of each component
    ///         (Codex #2276 r15 P1): a divergence the attestation recorded for
    ///         the correction path.
    /// @dev    Three states, and the return keeps them apart so a zero is never
    ///         ambiguous:
    ///
    ///         - A hash no packet was recorded under REVERTS
    ///           {ReconciliationPacketUnknown} (Codex #2276 r16 P2) — it names
    ///           nothing, so there is nothing to answer.
    ///         - A recorded packet whose split has NOT been attested returns
    ///           `attested == false` and zeros (Codex #2276): with no component
    ///           caps there is no excess to compute YET, and reporting a bare
    ///           zero read as "within caps" to reconciliation tooling, which
    ///           would then learn of an excess only when the delayed
    ///           attestation landed. It is a real packet whose answer is not yet
    ///           knowable — a different absence from an unknown hash, so it is
    ///           flagged rather than refused, which also lets a reconciler
    ///           SCAN packets without reverting on each unattested one.
    ///         - An attested packet returns `attested == true` with its two
    ///           recorded excesses; zero there genuinely means within its caps.
    /// @return attested Whether the packet's split has been attested.
    /// @return fresh    The fresh classification beyond the attested fresh cap.
    /// @return recycled The recycled classification beyond the attested recycled cap.
    function getPacketClassificationExcess(bytes32 packetHash)
        external
        view
        returns (bool attested, uint256 fresh, uint256 recycled)
    {
        LibVaipakam.IngressPacket storage p = LibVaipakam.storageSlot().ingressPackets[packetHash];
        if (p.arrivedAt == 0) revert ReconciliationPacketUnknown(packetHash);
        if (!p.attested) return (false, 0, 0);
        return (true, p.classifiedFreshBeyondCap, p.classifiedRecycledBeyondCap);
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
    ///         kind, its authenticated fresh figure (the bound on its
    ///         fresh side), and what the day draws have spent of it (3b-ii-A,
    ///         appended). Identity: `unclassified + classifiedFresh +
    ///         classifiedRecycled + disposed + drawn == protectedCumulative`.
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
            uint256 freshAuthenticated,
            uint256 drawn
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
            LibRewardCustody.authenticatedFresh(p),
            p.drawn
        );
    }

    /// @notice A log entry as recorded.
    function getReconciliationEntry(uint256 index) external view returns (LibVaipakam.ReconciliationEntry memory) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (index >= s.reconciliationLog.length) revert ReconciliationEntryUnknown(index);
        return s.reconciliationLog[index];
    }

    /// @notice An entry's figures per side, read from its own records: what
    ///         is unspent (movable with its tokens), what is spent, what of
    ///         the spent the other side may inherit (what the side's ledger
    ///         charged: fresh `paid`; recycled consumption), and the part of
    ///         its fresh credit the restitution row STILL holds absorbed
    ///         (neither queued nor movable). Constant work; reads no balance
    ///         and infers nothing. While a side's pending takes are not yet
    ///         written (`getFreshQueueState` / `getRecycledQueueState` say
    ///         so), the figures lag the totals by exactly those takes.
    function getReconciliationEntrySpent(
        uint256 index
    ) external view returns (Spent memory) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (index >= s.reconciliationLog.length) revert ReconciliationEntryUnknown(index);
        return _spent(s, index);
    }

    /// @notice An entry's raw records: fresh (amount, spent, charged),
    ///         recycled (amount, spent, charged), absorbed (amount,
    ///         released).
    function getEntryRecords(
        uint256 index
    )
        external
        view
        returns (
            uint256 freshAmount,
            uint256 freshSpent,
            uint256 freshCharged,
            uint256 recycledAmount,
            uint256 recycledSpent,
            uint256 recycledCharged,
            uint256 absorbedAmount,
            uint256 absorbedReleased
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (index >= s.reconciliationLog.length) revert ReconciliationEntryUnknown(index);
        LibVaipakam.SideRecord storage f = s.freshRecords[index];
        LibVaipakam.SideRecord storage r = s.recycledRecords[index];
        LibVaipakam.AbsorbedRecord storage a = s.absorbedRecords[index];
        return (f.amount, f.spent, f.charged, r.amount, r.spent, r.charged, a.amount, a.released);
    }

    /// @notice The fresh side as it stands for `era`: the queue's frontier,
    ///         its unspent, spent and paid figures, what its pending takes
    ///         still hold unwritten (a counter, never a scan), the live row;
    ///         the absorbed records'
    ///         frontier, unreleased and released figures, the restitution
    ///         row. Only a known era is answered — the pre-backfill era
    ///         until the transport epochs land — an unknown one refusing
    ///         rather than pairing an empty era-keyed queue with the global
    ///         custody figures (Codex #2206 r9). Invariants: `paid ≤ spent`,
    ///         `unspent ≤ liveRow`, `unreleased ≤ restitutionRow`, every
    ///         entry before a frontier exhausted.
    function getFreshQueueState(
        uint64 era
    )
        external
        view
        returns (
            uint256 frontier,
            uint256 unspent,
            uint256 spent,
            uint256 paid,
            uint256 pendingAmount,
            uint256 liveRow,
            uint256 absorbedFrontier,
            uint256 absorbedUnreleased,
            uint256 absorbedReleased,
            uint256 restitutionRow
        )
    {
        LibRewardCustody.requireKnownEra(era);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.freshFrontierByEra[era],
            s.freshUnspentByEra[era],
            s.freshSpentTotalByEra[era],
            s.freshPaidTotalByEra[era],
            s.freshPendingAmountByEra[era],
            s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.LiveFresh],
            s.absorbedFrontier,
            s.absorbedUnreleased,
            s.absorbedReleasedTotal,
            s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.Restitution]
        );
    }

    /// @notice The recycled side as it stands: the queue's frontier, its
    ///         unspent, spent and consumed figures, what its pending takes
    ///         still hold unwritten, and the bucket. Invariants: `consumed ≤
    ///         spent`, `unspent ≤ the recycled row`.
    function getRecycledQueueState()
        external
        view
        returns (
            uint256 frontier,
            uint256 unspent,
            uint256 spent,
            uint256 consumed,
            uint256 pendingAmount,
            uint256 bucket
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.recycledFrontier,
            s.recycledUnspent,
            s.recycledSpentTotal,
            s.recycledConsumedTotal,
            s.recycledPendingAmount,
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
        return (p.classifiedFresh, LibRewardCustody.authenticatedFresh(p));
    }

    /// @notice An entry's figures, per side, read from its own records.
    struct Spent {
        uint256 freshSpent;
        uint256 freshUnspent;
        uint256 freshInheritable;
        uint256 freshAbsorbed;
        uint256 recycledSpent;
        uint256 recycledUnspent;
        uint256 recycledInheritable;
    }

    /// @dev A correction's fresh → recycled split. The absorbed part still
    ///      held is restitution custody: not a correction's to move. Unspent
    ///      credit moves first, with its tokens; only then spent credit, as
    ///      an inherited debit — and only what the fresh ledger charged — so
    ///      what an entry keeps after any move that took spent units is all
    ///      spent, which is the correct-at-ingress result (design §5c).
    function _splitFreshMove(
        LibVaipakam.Storage storage s,
        uint256 index,
        uint256 amount
    ) private view returns (uint256 movingUnspent, uint256 movingSpent) {
        LibVaipakam.SideRecord storage f = s.freshRecords[index];
        uint256 free = f.amount - f.spent;
        uint256 movable = free + f.spent;
        if (amount > movable) revert ReconciliationRestitutionNotMovable(index, amount, movable);
        movingUnspent = amount < free ? amount : free;
        movingSpent = amount - movingUnspent;
        if (movingSpent > f.charged) revert ReconciliationSpentFreshNotInheritable(index, movingSpent, f.charged);
    }

    /// @dev Fresh → recycled by an explicit split: a correction's
    ///      ({_splitFreshMove}), or a release's un-inheritance of spent
    ///      credit alone (Codex #2206 r9). The queues move FIRST: the units
    ///      leave the entry's fresh record and enter its recycled record —
    ///      at its own position, the recycled frontier moving back to it if
    ///      it now has anything free; the row primitive then records nothing
    ///      for the token move.
    function _moveToRecycled(
        LibVaipakam.Storage storage s,
        uint256 index,
        uint256 movingUnspent,
        uint256 movingSpent
    ) private {
        LibVaipakam.ReconciliationEntry storage e = s.reconciliationLog[index];
        LibVaipakam.SideRecord storage f = s.freshRecords[index];
        uint256 amount = movingUnspent + movingSpent;
        f.amount -= uint128(amount);
        f.spent -= uint128(movingSpent);
        f.charged -= uint128(movingSpent);
        s.freshUnspentByEra[e.era] -= movingUnspent;
        s.freshSpentTotalByEra[e.era] -= movingSpent;
        s.freshPaidTotalByEra[e.era] -= movingSpent;
        LibVaipakam.SideRecord storage r = s.recycledRecords[index];
        r.amount += uint128(amount);
        r.spent += uint128(movingSpent);
        r.charged += uint128(movingSpent);
        s.recycledUnspent += movingUnspent;
        s.recycledSpentTotal += movingSpent;
        s.recycledConsumedTotal += movingSpent;
        if (movingUnspent != 0 && index < s.recycledFrontier) s.recycledFrontier = index;
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
    ///      the credit will take is read ahead: its live part enters the
    ///      entry's fresh record, its absorbed part the entry's absorbed
    ///      record — each at the entry's own position, the frontiers moving
    ///      back to it); the bucket ledger's own debit then finds nothing
    ///      more to record.
    function _moveToFresh(
        LibVaipakam.Storage storage s,
        uint256 index,
        uint256 amount
    ) private returns (uint256 movingUnspent, uint256 movingSpent) {
        LibVaipakam.ReconciliationEntry storage e = s.reconciliationLog[index];
        (uint256 current, uint256 authenticated) = _freshEvidence(s, e);
        _requireEvidence(e.key, current + amount, authenticated);
        LibVaipakam.SideRecord storage r = s.recycledRecords[index];
        uint256 free = r.amount - r.spent;
        movingUnspent = amount < free ? amount : free;
        movingSpent = amount - movingUnspent;
        if (movingSpent > r.charged) revert ReconciliationSpentRecycledNotInheritable(index, movingSpent, r.charged);
        r.amount -= uint128(amount);
        r.spent -= uint128(movingSpent);
        r.charged -= uint128(movingSpent);
        s.recycledUnspent -= movingUnspent;
        s.recycledSpentTotal -= movingSpent;
        s.recycledConsumedTotal -= movingSpent;
        _enterFresh(s, index, e.era, movingUnspent, movingSpent);
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

    /// @dev The fresh side of a correction toward fresh: the unspent part
    ///      under the split the credit will take (read ahead of the move),
    ///      the spent part as an inherited debit — at the entry's own
    ///      position.
    function _enterFresh(
        LibVaipakam.Storage storage s,
        uint256 index,
        uint64 era,
        uint256 movingUnspent,
        uint256 movingSpent
    ) private {
        (uint256 toLive, uint256 absorbed) = LibRewardCustody.freshSplit(s, movingUnspent);
        LibVaipakam.SideRecord storage f = s.freshRecords[index];
        f.amount += uint128(toLive + movingSpent);
        f.spent += uint128(movingSpent);
        f.charged += uint128(movingSpent);
        s.freshUnspentByEra[era] += toLive;
        s.freshSpentTotalByEra[era] += movingSpent;
        s.freshPaidTotalByEra[era] += movingSpent;
        if (toLive != 0 && index < s.freshFrontierByEra[era]) s.freshFrontierByEra[era] = index;
        if (absorbed != 0) {
            s.absorbedRecords[index].amount += uint128(absorbed);
            s.absorbedUnreleased += absorbed;
            if (index < s.absorbedFrontier) s.absorbedFrontier = index;
        }
    }

    /// @dev Append a log entry and its records: its live fresh credit, its
    ///      absorbed part, its recycled credit — the newest entry, so no
    ///      frontier moves.
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
        uint256 live = fresh - absorbed;
        if (live != 0) {
            s.freshRecords[index].amount = uint128(live);
            s.freshUnspentByEra[era] += live;
        }
        if (absorbed != 0) {
            s.absorbedRecords[index].amount = uint128(absorbed);
            s.absorbedUnreleased += absorbed;
        }
        if (recycled != 0) {
            s.recycledRecords[index].amount = uint128(recycled);
            s.recycledUnspent += recycled;
        }
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

    /// @dev An entry's figures, per side, from its own records.
    function _spent(LibVaipakam.Storage storage s, uint256 index) private view returns (Spent memory r) {
        LibVaipakam.SideRecord storage f = s.freshRecords[index];
        r.freshUnspent = f.amount - f.spent;
        r.freshSpent = f.spent;
        r.freshInheritable = f.charged;
        LibVaipakam.SideRecord storage rc = s.recycledRecords[index];
        r.recycledUnspent = rc.amount - rc.spent;
        r.recycledSpent = rc.spent;
        r.recycledInheritable = rc.charged;
        LibVaipakam.AbsorbedRecord storage a = s.absorbedRecords[index];
        r.freshAbsorbed = a.amount - a.released;
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
