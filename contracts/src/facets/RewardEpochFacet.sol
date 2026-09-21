// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibRewardCustody} from "../libraries/LibRewardCustody.sol";
import {LibVpfiRecycle} from "../libraries/LibVpfiRecycle.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title  RewardEpochFacet
 * @notice The TRANSPORT EPOCHS: each old-wire reward delivery holds an untyped
 *         balance that only the obligations whose day it listed may draw from.
 *         This facet carries that ledger's lifecycle after ingress — the
 *         retrospective admission of a rollout-window delivery, a batch's
 *         paged indexing, and the parking and acknowledgment that release a
 *         batch so what remains of its packet becomes classifiable.
 *
 *         WHAT THIS CUT ACTUALLY OFFERS, stated here because the rest of this
 *         file describes the release in the present tense and a reader meets
 *         this header first (#2258, owner decision 2026-09-20; Codex #2232
 *         r10). It is stated as a COMPLEMENT — the refused set named
 *         exhaustively, everything else live — rather than by listing what
 *         works, because a list of what works omits an entry silently and a
 *         complement cannot (Codex #2232 r11, which is what an earlier
 *         "only the paged indexing is live" did to {admitLegacyTransportBatch}):
 *
 *           * REFUSED, to every caller, the administrator included — EXACTLY
 *             TWO entries: {parkTransportBatchRemainder} and
 *             {acknowledgeTransportBatchRemainder}, which revert
 *             `TransportReleaseNotYetAvailable`. So no batch on this
 *             deployment is ever `released`.
 *           * LIVE — everything else on this facet. That is
 *             {admitLegacyTransportBatch}, {materializeTransportBatchPage}
 *             and every read surface. The two write entries there are not
 *             optional housekeeping: a delivery from the 3a-to-3b rollout
 *             window is admitted ONLY by {admitLegacyTransportBatch} (until
 *             it is, its packet is refused with `TransportBatchNotAdmitted`),
 *             and every admitted batch — oversize or not — has its membership
 *             written ONLY by {materializeTransportBatchPage}.
 *
 *         Read every "the release does X" below as 3b-ii's shape, which the
 *         library already implements and which this facet's bodies do not yet
 *         reach.
 *
 *         THE CONSEQUENCE IS NOT CONFINED TO THIS FACET, and is a funds fact
 *         rather than a surface one: {LibRewardCustody.takeFromReleasedRemainder}
 *         refuses a packet whose batch is not released BEFORE it looks at the
 *         fresh-versus-recycled split, so for as long as this door is shut a
 *         packet holding an epoch is WHOLLY unclassifiable — not "classifiable
 *         recycled only". Its value stays in the membership-bound holding,
 *         visible in the ledger, spendable by nobody. A packet holding no
 *         epoch is untouched by all of this.
 * @dev    #1566 transport epochs PR 3b (design §5c).
 *
 *         WHY ITS OWN FACET. Admission happens at ingress and lives with the
 *         ingress; everything after it is a distinct lifecycle with distinct
 *         callers — permissionless indexing and parking, and the operator's
 *         acknowledgment that releases a batch (Codex #2232 r7: this said
 *         "operator parking", which names the wrong half) — and the
 *         two facets that would otherwise host it, {RewardReconciliationFacet}
 *         and {RewardIngressFacet}, are respectively out of EIP-170 headroom
 *         and named for something else. PR 3b-ii's per-day allocation pass
 *         lands here too, and that is the size argument rather than this
 *         PR's: the pass must be run identically by the forfeit sweep, the
 *         expiry sweep and settlement, whose hosts have between 1.7 and 2.8 KB
 *         of headroom left. An `internal` library function is inlined into
 *         every contract that reaches it, so writing the pass as a library
 *         would grow all of them at once; hosted here, each consumer carries
 *         only the call and the pass exists once.
 *
 *         NOT `whenNotPaused`, matching {RewardReconciliationFacet}: under the
 *         migration pause every reward CONSUMER is refused while the packets
 *         being drained still land and are reconciled. Nothing here pays
 *         anybody — indexing records a membership the delivery already
 *         committed to, and parking moves a batch's own remainder into a
 *         holding of the same batch — so refusing these would stall the
 *         migration the pause exists to permit.
 */
contract RewardEpochFacet is DiamondReentrancyGuard, DiamondAccessControl, IVaipakamErrors {
    /// @notice Index one bounded page of a batch's membership. EVERY ADMITTED
    ///         BATCH NEEDS THIS, not only an oversize one: size changes how
    ///         many calls it takes, never whether any is needed.
    /// @dev    Permissionless, because the authority is the day-list
    ///         commitment the delivery's own ingress stamped and not the
    ///         caller: anyone may supply the payload, and nobody can supply a
    ///         different one.
    ///
    ///         ADMISSION WRITES NO MEMBERSHIP AT ALL. Every batch is admitted
    ///         compactly — a transport payload is immutable, so refusing one
    ///         at the destination would refuse the same message on every
    ///         re-execution — which means admission stamps the anchor, the
    ///         balance and the day COUNT and stops there, leaving
    ///         `indexedDays` at zero whatever the count. This is the only
    ///         writer of the membership itself, so a caller who materializes
    ///         only the batches that exceed `TRANSPORT_DAY_FANOUT_CAP` leaves
    ///         every ordinary batch permanently un-indexed, and therefore
    ///         unable to meet the fully-indexed precondition its lifecycle
    ///         will require. A within-cap batch simply reaches that state in
    ///         one call instead of several.
    /// @param  batchId The batch, which is its packet's ingress stamp.
    /// @param  dayIds  The delivery's WHOLE day list, re-supplied. The
    ///                 commitment is flat, so the whole list is what proves a
    ///                 page; only the page's entries are written.
    /// @return indexedDays The batch's day-index progress after this call.
    ///                     It is whole when it equals the batch's `dayCount`.
    function materializeTransportBatchPage(bytes32 batchId, uint256[] calldata dayIds)
        external
        nonReentrant
        returns (uint32 indexedDays)
    {
        return LibRewardCustody.materializeTransportBatchPage(
            LibVaipakam.storageSlot(),
            batchId,
            dayIds
        );
    }

    /// @notice PARK what a batch's obligations left, under the batch's own key.
    ///         NOT OFFERED IN THIS CUT — this entry refuses every caller (see
    ///         the body, and the header's "what this cut actually offers").
    ///         Everything the dev note below describes is 3b-ii's shape.
    /// @dev    The first half of the release, and not the whole of it: the
    ///         remainder becomes classifiable only once
    ///         {acknowledgeTransportBatchRemainder} records the acknowledgment
    ///         (§5c). Splitting the two is what stops an operator making a
    ///         packet classifiable merely by draining its batch.
    ///
    ///         The parked remainder stays MEMBERSHIP-BOUND — it carries the
    ///         same day-list commitment the packet does — so a late obligation
    ///         whose day is in that list can still be funded from it rather
    ///         than finding the value in a general pool it has no claim on.
    ///         PERMISSIONLESS (Codex #2232 r2), because the specification says
    ///         so and for the reason it gives: attesting a packet's split and
    ///         parking what its obligations left are both open to anyone and
    ///         may happen in either order, which is exactly why the evidence
    ///         bound is derived at use time rather than snapshotted. An
    ///         earlier revision of this facet gated parking on `ADMIN_ROLE`,
    ///         which turned a specified mechanical step into an
    ///         administrator-dependent one and left a valid batch's closeout
    ///         waiting on whoever holds the role.
    ///
    ///         That reason extends to THIS half and not to the other one, and
    ///         a later revision over-corrected by opening both (Codex #2232
    ///         r3): the ACKNOWLEDGMENT is the operator disposition the design
    ///         names, and it is gated. See
    ///         {acknowledgeTransportBatchRemainder} for which act is which and
    ///         why the split is exactly where the authority changes.
    ///
    ///         What makes a release valid is STATE, not the caller: the batch
    ///         must exist and its membership must be whole. 3b-ii adds §5c's
    ///         remaining condition — a batch with outstanding staging
    ///         references cannot be retired — to the same place.
    /// @return amount What was parked.
    function parkTransportBatchRemainder(bytes32 batchId)
        external
        nonReentrant
        returns (uint256 amount)
    {
        // #2258 (owner decision 2026-09-20) — NOT AVAILABLE in 3b-i, to
        // anyone, checked before anything else so the answer is the same for
        // an admin, a stranger and an unknown id: the release does not exist
        // yet. The design's rule for this act — refuse a batch that still
        // lists an outstanding obligation — cannot be tested until 3b-ii
        // tracks obligations per day, and a release the chain cannot check is
        // an earmark spent on the caller's say-so. The library function this
        // will call is written and tested (through the test-only raw entry);
        // only the door is shut.
        amount; // the return exists for 3b-ii's shape; nothing reaches it
        revert TransportReleaseNotYetAvailable(batchId);
    }

    /// @notice Record the acknowledgment that RELEASES a batch.
    ///         NOT OFFERED IN THIS CUT — this entry refuses every caller, the
    ///         administrator included. In particular the `ADMIN_ROLE` gate the
    ///         dev note below argues for is ABSENT from this cut's signature on
    ///         purpose, so that the refusal is uniform; do not read that
    ///         paragraph as a description of who may call this today. Nobody
    ///         may.
    /// @dev    After this, and only after this, the batch's packet passes the
    ///         classification gate: {LibRewardCustody.authenticatedFresh} then
    ///         derives the bound a classification reads from the packet's
    ///         immutable attested caps, NET of what the batch's own transport
    ///         legs have spent.
    ///
    ///         ADMIN, and NOT for the reason the park above is permissionless
    ///         (Codex #2232 r3). The two halves of the release look like one
    ///         lifecycle and are two different kinds of act, which is what an
    ///         earlier revision of this facet got wrong in both directions —
    ///         first gating both on `ADMIN_ROLE`, then opening both.
    ///
    ///         PARKING IS MECHANICAL. It moves a batch's own remainder into a
    ///         holding of the same batch, under the same membership
    ///         commitment; no authority is exercised, nothing becomes
    ///         spendable that was not, and the design says so at
    ///         `Vpfi1566CanonicalDeliveredBoundDesign.md:6695-6703` — attesting
    ///         and parking are permissionless and may happen in either order,
    ///         which is precisely why the evidence bound is derived at use
    ///         time rather than snapshotted here.
    ///
    ///         THE ACKNOWLEDGMENT IS A DISPOSITION. Design `:3019-3029` calls
    ///         it "a deliberate operator disposition carrying a recorded
    ///         acknowledgment, keyed by the batch", in the same family as
    ///         slice 0's shortfall disposition, and names its consequence:
    ///         obligations arriving afterwards for any of that batch's listed
    ///         days are REFUSED to the extent they looked to it. That is a
    ///         decision to stop waiting on a lane that cannot prove closure —
    ///         it forfeits a claim belonging to somebody else, and it is
    ///         one-way. Leaving it open let any caller forge the owner
    ///         decision that both unlocks authenticated-fresh classification
    ///         and governs how later listed obligations are handled.
    ///
    ///         So the release still cannot be reached by draining a batch
    ///         alone — that was the point of splitting it — and the half that
    ///         carries the consequence is the half that carries the authority.
    ///         State-gated as before on top of the role: a remainder must be
    ///         parked and not already acknowledged.
    function acknowledgeTransportBatchRemainder(bytes32 batchId)
        external
        nonReentrant
    {
        // #2258 — as above. The `onlyRole(ADMIN_ROLE)` gate this act carries
        // in 3b-ii (the acknowledgment is an operator disposition; parking is
        // not) is deliberately absent here so the refusal is uniform: a
        // stranger and the admin both learn the release does not exist yet,
        // rather than one of them learning they lack a role for it.
        revert TransportReleaseNotYetAvailable(batchId);
    }

    /// @notice A transport epoch as recorded.
    /// @dev    A lean tuple rather than the struct: an ABI-coded struct return
    ///         inflates the viaIR peak stack, which this codebase sits close
    ///         to. `balance` is what remains spendable by the batch's member
    ///         days; `admitted` is the immutable conservation anchor.
    ///
    ///         THIS IS THE EXISTENCE ORACLE, and the only ledger read that
    ///         answers rather than refusing an unknown id (Codex #2232 r15).
    ///         The sibling reads {getTransportBatchLegs} and
    ///         {getTransportRemainder} revert `TransportBatchUnknown`, because
    ///         their figures are meaningless for a batch that does not exist;
    ///         this one is how a caller ASKS whether it exists, so it must
    ///         stay callable on an id that does not. A reader with an id of
    ///         unknown provenance therefore calls this first — which is what
    ///         the conservation invariant and the rollout handler already do,
    ///         both skipping on a zero `packetHash` before reading anything
    ///         else.
    /// @return packetHash  The delivery that opened it; zero when no batch was
    ///                     admitted under this id — the same
    ///                     {LibRewardCustody.transportBatchExists} the two
    ///                     sibling reads refuse on, expressed as a value so
    ///                     this read can report the absence instead of
    ///                     reverting on it. DERIVED, not stored — the batch is
    ///                     keyed by that stamp, so storing it would restate
    ///                     the key.
    /// @return balance     Untyped value still held by the epoch.
    /// @return admitted    What admission recorded.
    /// @return dayCount    How many days the delivery listed.
    /// @return indexedDays How many of them carry an index entry. Zero at
    ///                     admission for every batch: admission is compact, and
    ///                     the index is materialized afterwards.
    /// @return released    Whether its remainder is parked AND acknowledged.
    function getTransportBatch(bytes32 batchId)
        external
        view
        returns (
            bytes32 packetHash,
            uint256 balance,
            uint256 admitted,
            uint32 dayCount,
            uint32 indexedDays,
            bool released
        )
    {
        LibVaipakam.TransportBatch storage b = LibVaipakam.storageSlot().transportBatches[batchId];
        uint256 admittedAmount = b.admitted;
        return (
            // Asked through the shared predicate rather than by re-testing
            // `admittedAmount` here, so this read and the two that refuse an
            // unknown id cannot come to disagree about what "exists" means.
            !LibRewardCustody.transportBatchExists(b) ? bytes32(0) : batchId,
            b.balance,
            admittedAmount,
            b.dayCount,
            b.indexedDays,
            b.released
        );
    }

    /// @notice What a batch's transport legs have spent, per component.
    /// @dev    Zero for every batch until PR 3b-ii's draws write them. Exposed
    ///         with the ledger rather than with the draws because they are
    ///         half of the evidence a classification is bounded by, and an
    ///         operator reading that bound needs both halves.
    ///
    ///         AN UNKNOWN ID IS REFUSED BY NAME, not answered with zeros
    ///         (Codex #2232 r15). A batch that exists and has drawn nothing
    ///         reads `(0, 0)`, and so did an id no delivery ever opened — so a
    ///         typo or a stale id was returned as substantiated evidence of no
    ///         consumption, on the very figures a classification's bound is
    ///         read from. Answering a question about a batch that does not
    ///         exist is the unstated unknown AGENTS.md names a defect, and
    ///         here it would be an unstated unknown about funds. The refusal
    ///         is the same one, by the same name, that the write paths give
    ///         for the same id: {LibRewardCustody.transportBatchExists} is
    ///         asked once and every surface gets one answer.
    function getTransportBatchLegs(bytes32 batchId)
        external
        view
        returns (uint256 consumedFresh, uint256 consumedRecycled, uint256 consumedBeyondCaps)
    {
        LibVaipakam.TransportBatch storage b = LibVaipakam.storageSlot().transportBatches[batchId];
        if (!LibRewardCustody.transportBatchExists(b)) revert TransportBatchUnknown(batchId);
        // The third figure (Codex #2276 r6): what a late attestation showed to
        // lie outside both recorded caps — in the epoch's identity, in neither
        // leg, for the close-out's disposition path.
        return (b.consumedFresh, b.consumedRecycled, b.consumedBeyondCaps);
    }

    /// @notice A batch's parked remainder, and what has left it.
    /// @dev    `amount` and `debited` are reported TOGETHER because neither is
    ///         readable on its own (Codex #2232 r3): a remainder parked at 10
    ///         and classified for 4 holds 6, and 6 alone cannot be told from a
    ///         batch that only ever parked 6. Both are what closes the epoch's
    ///         conservation identity — a batch's `admitted` is always its
    ///         `balance` plus what is parked plus what classification took,
    ///         plus (from PR 3b-ii) its transport legs.
    ///
    ///         AN UNKNOWN ID IS REFUSED BY NAME (Codex #2232 r15), and the
    ///         two absences this read has to keep apart are why. "No batch was
    ///         ever admitted here" and "this batch exists and has parked
    ///         nothing" both used to come back as the same all-zero tuple,
    ///         because the early return asked the REMAINDER record's own
    ///         `batchId` — which answers "is something parked", a different
    ///         question that reads identically when the answer is no. The
    ///         batch's existence is now asked of the batch, through the one
    ///         predicate {LibRewardCustody.transportBatchExists}; the parked
    ///         zeros stay an ANSWER, because for a known batch they are one.
    /// @return amount       What is parked NOW; zero when nothing is, and also
    ///                      zero once classification has taken all of it.
    /// @return dayListHash  The membership that still binds it.
    /// @return dayCount     How many days that list names.
    /// @return acknowledged Whether the acknowledgment has been recorded.
    /// @return debited      CUMULATIVE value classification has taken out of
    ///                      this remainder; never falls.
    function getTransportRemainder(bytes32 batchId)
        external
        view
        returns (
            uint256 amount,
            bytes32 dayListHash,
            uint32 dayCount,
            bool acknowledged,
            uint256 debited
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!LibRewardCustody.transportBatchExists(s.transportBatches[batchId])) {
            revert TransportBatchUnknown(batchId);
        }
        LibVaipakam.TransportRemainder storage r = s.transportRemainders[batchId];
        if (r.batchId == bytes32(0)) return (0, bytes32(0), 0, false, 0);
        return (r.amount, r.dayListHash, r.dayCount, r.acknowledged, r.debited);
    }

    /// @notice One day's batch MEMBERSHIP index, paginated, with each entry's
    ///         arrival and the day's consumption cursor.
    /// @dev    Paginated because the legacy lane can mint arbitrarily many
    ///         small batches listing one day: a view that returned the whole
    ///         index would stop being callable exactly on the days that matter
    ///         most. `cursor` is where allocation resumes, so `cursor ==
    ///         total` means every batch this day ever listed is spent.
    ///
    ///         `arrivedAt` is returned WITH the page, and that is the point
    ///         (Codex #2232 r3). A batch's position here records which caller
    ///         materialized it first, nothing more: indexing is permissionless
    ///         and asynchronous, and a rollout packet is admitted long after
    ///         it landed. So the order a reader wants is never the array's —
    ///         it is each delivery's own recorded arrival, which the ingress
    ///         wrote once and nothing can change. Returning it here is what
    ///         lets design §5c's preparer default (fewest-remaining-member-
    ///         days-first, OLDEST ON TIES) read an authenticated key instead
    ///         of inferring one from push order. Two deliveries that landed in
    ///         the same block share a key; within one block there is no
    ///         arrival order to preserve, and the batch id breaks the tie
    ///         deterministically for any reader that needs a total order.
    /// @param  dayId  The day.
    /// @param  offset Where to start in the index.
    /// @param  limit  How many to return.
    /// @return page      The batch ids in that window.
    /// @return arrivedAt Each returned batch's delivery arrival, same order as
    ///                   `page` — the ordering key, read from the packet.
    /// @return total     How many batches this day has ever indexed.
    /// @return cursor    The day's consumption cursor.
    function getTransportDayBatches(uint256 dayId, uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory page, uint64[] memory arrivedAt, uint256 total, uint256 cursor)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        bytes32[] storage index = s.transportBatchesByDay[dayId];
        total = index.length;
        cursor = s.transportDayCursor[dayId];
        if (offset >= total) return (new bytes32[](0), new uint64[](0), total, cursor);
        // Clamped against what REMAINS rather than computing `offset + limit`:
        // a caller asking for everything with an unbounded limit would
        // otherwise overflow into a panic instead of getting the tail.
        uint256 end = total - offset < limit ? total : offset + limit;
        page = new bytes32[](end - offset);
        arrivedAt = new uint64[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            bytes32 id = index[i];
            page[i - offset] = id;
            // The batch IS its packet's stamp, so the arrival is one read from
            // the packet record and never a second copy that could drift.
            arrivedAt[i - offset] = s.ingressPackets[id].arrivedAt;
        }
    }

    /// @notice Open the transport epoch of an old-wire packet that landed
    ///         before this ledger existed.
    /// @dev    Permissionless, and the authority is the packet's own record —
    ///         balance and day count are read from it, so a stranger calling
    ///         this can only make the ledger state what the ingress already
    ///         wrote. No role gates it for the same reason none gates
    ///         materialization or parking (Codex #2232 r2): what makes the
    ///         call valid is STATE, never the caller.
    ///
    ///         It does, however, require the COMMITTED DAY LIST, and that is
    ///         not an authority check.
    ///
    ///         NOT the symmetry argument this entry was introduced with, which
    ///         is RETIRED (Codex #2232 r5/r7): that argument said the list is
    ///         required because the admission CLOSES a classification gate only
    ///         a list-holder could reopen. Since
    ///         {LibRewardCustody.rolloutAdmissionStatus} became the gate's rule
    ///         too, an owed packet is gated by its own SHAPE from the moment it
    ///         lands, so this call closes nothing and a justification resting on
    ///         what it closes is false. It is written out here rather than left
    ///         standing, because this NatSpec is the public face of a funds gate
    ///         and a retired rationale read as current is how the conflation
    ///         behind it survived five rounds.
    ///
    ///         The check stays for the reason that does hold: this is the one
    ///         call that fixes an IMMUTABLE anchor over the protected row, and
    ///         an anchor bounding a membership nobody can exhibit describes a
    ///         set nobody can enumerate. It costs a caller nothing it does not
    ///         already need — {materializeTransportBatchPage} proves the same
    ///         list against the same commitment, so no route to a release
    ///         exists without it. The list is not stored, so this is not a
    ///         second copy of the membership.
    ///
    ///         Design §5c records the day-list commitment on every arrival on
    ///         a wire older than d6 precisely so "a packet landing between 3a
    ///         and 3b carries authenticated membership 3b can index". Without
    ///         this entry that is false for the entire 3a-to-3b window: those
    ///         packets hold untyped value with no epoch bounding it, their
    ///         committed list is refused as an unknown batch, and their zero
    ///         `batchId` makes classification skip the gate.
    ///
    ///         Its admission is COMPACT, exactly as the ingress's is, so the
    ///         membership is then built by {materializeTransportBatchPage} —
    ///         one path afterwards, whichever entry opened the epoch.
    /// @param  packetHash The packet's ingress stamp, which is its batch's key.
    /// @param  dayIds     The delivery's WHOLE day list, proved against the
    ///                    commitment its ingress stamped. Not written — the
    ///                    membership is still built in pages afterwards.
    /// @return batchId    The batch's key, equal to the packet's stamp.
    function admitLegacyTransportBatch(bytes32 packetHash, uint256[] calldata dayIds)
        external
        nonReentrant
        returns (bytes32 batchId)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // The same condition the ingress admits under (Codex #2232 r1): an
        // epoch and the `Unclassified` protection backing it are two views of
        // one value, so an epoch must not exist where custody has not
        // attributed that value. On a configured-but-not-yet-activated
        // deployment the packet's tokens are Diamond-side and the activation
        // envelope is what attributes them.
        if (!LibRewardCustody.active(s)) revert RewardCustodyNotActivated();
        batchId = LibRewardCustody.admitLegacyTransportBatch(s, packetHash, dayIds);
    }

    // ─── Transport epochs PR 3b-ii-A: the draws ─────────────────────────────

    /// @notice What `dayId`'s epochs can fund right now, within one scan
    ///         window, and whether the window ended before the index did.
    /// @dev    The read every armed-day settlement and preview makes, through
    ///         {LibRewardCustody.callTransportCoverageForDay}; see
    ///         {LibRewardCustody.transportCoverageForDay} for what the two
    ///         figures mean and why a cap hit defers a day.
    function getTransportCoverageForDay(uint256 dayId) external view returns (uint256 available, bool capHit) {
        return LibRewardCustody.transportCoverageForDay(LibVaipakam.storageSlot(), dayId);
    }

    /// @notice What `dayId`'s epochs would pay of an obligation's two legs,
    ///         given the legs' needs and their typed sources — §5c's split,
    ///         applied to the day's cursor-visible coverage.
    /// @dev    The ONE read every armed-day settlement and preview makes,
    ///         through {LibRewardCustody.callTransportAllocateForDay}; the
    ///         rule is {LibRewardCustody.transportAllocateForDay}.
    function getTransportAllocationForDay(LibRewardCustody.AllocRequest calldata q)
        external
        view
        returns (LibRewardCustody.AllocResult memory)
    {
        return LibRewardCustody.transportAllocateForDay(LibVaipakam.storageSlot(), q);
    }

    // The claim's dry run, the domain needs and the domain probe live on
    // {RewardEpochViewFacet} (Codex #2276 r2): they inline the day-pricing
    // engine, and this ledger facet went over EIP-170 carrying it.

    /// @notice Diamond-internal: settle a claim's or a forfeit sweep's
    ///         treasury and epoch legs — the live-funded fresh absorbed
    ///         through the bounding operation, the epoch-funded legs recycled
    ///         in place, the treasury's recycled commitment released, and the
    ///         USER's epoch-paid recycled commitment released without a bucket
    ///         debit (Codex #2276 r1: a claim an epoch paid recycled for would
    ///         otherwise leave that commitment outstanding forever, depressing
    ///         what the mirror reports fundable).
    /// @dev    Hosted here for `RewardClaimFacet`'s and
    ///         `InteractionRewardsFacet`'s EIP-170 headroom (3b-ii-A); the
    ///         operations are the callers' own, unchanged.
    function epochSettleClaimLegs(
        uint256 liveFresh,
        uint256 epochLegs,
        uint256 treasuryRecycledRelease,
        uint256 userEpochRecycled,
        uint256 refId
    ) external {
        _requireDiamondInternal();
        LibVpfiRecycle.absorbRewardFresh(LibVpfiRecycle.RecycleSource.ForfeitedReward, refId, liveFresh);
        LibVpfiRecycle.absorbTransportFunded(LibVpfiRecycle.RecycleSource.ForfeitedReward, refId, epochLegs);
        if (treasuryRecycledRelease > 0) {
            LibVpfiRecycle.releaseCommitment(LibVpfiRecycle.RecycleSource.ForfeitedReward, refId, treasuryRecycledRelease);
        }
        if (userEpochRecycled > 0) {
            LibVpfiRecycle.releaseCommitment(LibVpfiRecycle.RecycleSource.TransportPaidClaim, refId, userEpochRecycled);
        }
    }

    /// @notice Diamond-internal: {LibRewardCustody.drawTransportForDay} — and,
    ///         with both legs zero, the cursor prune a deferred day asks for.
    /// @dev    Hosted here and reached by the settle wrappers through a
    ///         self-call, because a library draw would be inlined into each
    ///         facet that settles an armed day, and those four sit within
    ///         1.3–2.8 KB of EIP-170 (design §5d, the 3b-ii-A note). Gated to
    ///         the Diamond itself: a draw with no settlement behind it would
    ///         spend an epoch on nothing.
    function epochDrawForDay(uint256 dayId, uint256 fresh, uint256 recycled) external returns (bool pruned) {
        _requireDiamondInternal();
        return LibRewardCustody.drawTransportForDay(LibVaipakam.storageSlot(), dayId, fresh, recycled);
    }

    /// @notice Advance `dayId`'s consumption cursor past exhausted epochs at
    ///         the front of its index. Permissionless and idempotent — see
    ///         {LibRewardCustody.pruneTransportDayCursor} for the day it
    ///         rescues.
    function epochPruneTransportDayCursor(uint256 dayId) external nonReentrant {
        LibRewardCustody.pruneTransportDayCursor(LibVaipakam.storageSlot(), dayId);
    }

    function _requireDiamondInternal() private view {
        if (msg.sender != address(this)) revert RewardCustodyOnlyDiamondInternal(msg.sender);
    }
}
