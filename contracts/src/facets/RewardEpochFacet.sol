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
 * @notice The TRANSPORT EPOCHS: each reward delivery landing on an activated
 *         custody holds its whole value as an epoch that only the obligations
 *         of the ONE day its wire named may draw from, typed by the split its
 *         own wire carried. The epoch is admitted and indexed under its day at
 *         ingress (#2828); this facet carries the rest of its lifecycle — the
 *         parking and acknowledgment that release a batch so what remains of
 *         its packet becomes classifiable — and the per-day allocation pass
 *         the settle paths reach by self-call.
 *
 *         WHAT THIS FACET OFFERS — every entry is live. Parking
 *         ({parkTransportBatchRemainder}) is permissionless, gated on STATE —
 *         the batch's day proven closed by the per-day closure proof (3b-ii-B)
 *         and no staging reference standing. The acknowledgment that RELEASES
 *         a parked batch ({acknowledgeTransportBatchRemainder}) is an operator
 *         disposition, ADMIN. (3b-i shipped the two release entries shut to
 *         every caller until the closure proof existed; 3b-ii-B opened them,
 *         #2258.)
 *
 *         THE FUNDS FACT: {LibRewardCustody.takeFromReleasedRemainder} refuses
 *         a packet whose batch is not released BEFORE it looks at the
 *         fresh-versus-recycled split, so a packet holding an epoch is
 *         unclassifiable until its batch is parked AND acknowledged; until then
 *         its value stays in the membership-bound holding, visible in the
 *         ledger, spendable only by the obligations of its day. A packet
 *         holding no epoch is untouched by all of this.
 * @dev    #1566 transport epochs PR 3b (design §5c); #2828.
 *
 *         WHY ITS OWN FACET. Admission happens at ingress and lives with the
 *         ingress; everything after it is a distinct lifecycle with distinct
 *         callers — permissionless parking, and the operator's acknowledgment
 *         that releases a batch (Codex #2232 r7) — and the two facets that
 *         would otherwise host it, {RewardReconciliationFacet} and
 *         {RewardIngressFacet}, are respectively out of EIP-170 headroom and
 *         named for something else. PR 3b-ii's per-day allocation pass lands
 *         here too, and that is the size argument: the pass must be run
 *         identically by the forfeit sweep, the expiry sweep and settlement,
 *         whose hosts have between 1.7 and 2.8 KB of headroom left. An
 *         `internal` library function is inlined into every contract that
 *         reaches it, so writing the pass as a library would grow all of them
 *         at once; hosted here, each consumer carries only the call and the
 *         pass exists once.
 *
 *         NOT `whenNotPaused`, matching {RewardReconciliationFacet}: under the
 *         migration pause every reward CONSUMER is refused while the packets
 *         being drained still land and are reconciled. Nothing here pays
 *         anybody — parking moves a batch's own remainder into a holding of
 *         the same batch — so refusing it would stall the migration the pause
 *         exists to permit.
 *
 *         RETIRED (#2828): the chunk materializer, the batchless delivery
 *         proof and the paged park. The d8 wire carries the funded day inline,
 *         so the mirror indexes the epoch and counts the part toward its day
 *         at arrival, and a one-day batch parks in one call.
 */
contract RewardEpochFacet is DiamondReentrancyGuard, DiamondAccessControl, IVaipakamErrors {
    /// @notice PARK what a batch's obligations left, under the batch's own key.
    ///         Permissionless, gated on state: the batch's day proven closed and
    ///         no staging reference standing (3b-ii-B).
    /// @dev    The first half of the release, and not the whole of it: the
    ///         remainder becomes classifiable only once
    ///         {acknowledgeTransportBatchRemainder} records the acknowledgment
    ///         (§5c). Splitting the two is what stops an operator making a
    ///         packet classifiable merely by draining its batch.
    ///
    ///         The parked remainder stays MEMBERSHIP-BOUND — it carries the
    ///         batch's day — so a late obligation on that day can still be
    ///         funded from it rather than finding the value in a general pool
    ///         it has no claim on.
    ///
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
    ///         One call (#2828): a batch funds one day, so there is no list to
    ///         page through. The rule is {LibRewardCustody.parkClosedTransportRemainder}.
    /// @param  batchId The batch whose remainder is parked.
    /// @return amount  What was parked.
    function parkTransportBatchRemainder(bytes32 batchId) external nonReentrant returns (uint256 amount) {
        return LibRewardCustody.parkClosedTransportRemainder(LibVaipakam.storageSlot(), batchId);
    }

    /// @notice Record the acknowledgment that RELEASES a batch — ADMIN (3b-ii-B).
    ///         (3b-i shipped this entry shut to everyone, the administrator
    ///         included, so the refusal was uniform while the release could
    ///         not yet be checked; the park's day-closure gate now exists, so
    ///         the door is open and the gate the note below argues for is on.)
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
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        // 3b-ii-B — the disposition, gated as the note above argues: a parked,
        // unacknowledged remainder becomes RELEASED, and the batch's packet
        // passes the classification gate from here on.
        LibRewardCustody.acknowledgeTransportRemainder(LibVaipakam.storageSlot(), batchId);
    }

    /// @notice 3b-ii-A2 (#2305) — a batch's STAGED components and the count of
    ///         staging records referencing it: the terms the conservation
    ///         identity gained, read beside {getTransportBatch}'s.
    function getTransportBatchStaged(bytes32 batchId)
        external
        view
        returns (uint256 stagedFresh, uint256 stagedRecycled, uint256 references)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.TransportBatch storage b = s.transportBatches[batchId];
        return (b.stagedFresh, b.stagedRecycled, s.transportBatchReferences[batchId]);
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
    ///         the conservation invariant already does, skipping on a zero
    ///         `packetHash` before reading anything else.
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
    /// @return dayId       The ONE day the delivery funds, as its wire named
    ///                     it (#2828). Zero is a real day: read `packetHash`,
    ///                     not this, for whether the batch exists.
    /// @return released    Whether its remainder is parked AND acknowledged.
    function getTransportBatch(bytes32 batchId)
        external
        view
        returns (
            bytes32 packetHash,
            uint256 balance,
            uint256 admitted,
            uint256 dayId,
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
            b.dayId,
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
        returns (uint256 consumedFresh, uint256 consumedRecycled)
    {
        LibVaipakam.TransportBatch storage b = LibVaipakam.storageSlot().transportBatches[batchId];
        if (!LibRewardCustody.transportBatchExists(b)) revert TransportBatchUnknown(batchId);
        return (b.consumedFresh, b.consumedRecycled);
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
    ///
    ///         `parked` is stated, not implied (#2828): the remainder used to
    ///         report a non-zero day COUNT once parked, and a one-day batch's
    ///         day may be day 0, so the day alone cannot say whether anything
    ///         is parked.
    /// @return parked       Whether the batch's remainder has been parked.
    /// @return amount       What is parked NOW; zero when nothing is, and also
    ///                      zero once classification has taken all of it.
    /// @return dayId        The day the parked remainder stays bound to (the
    ///                      batch's day); zero while nothing is parked.
    /// @return acknowledged Whether the acknowledgment has been recorded.
    /// @return debited      CUMULATIVE value classification has taken out of
    ///                      this remainder; never falls.
    function getTransportRemainder(bytes32 batchId)
        external
        view
        returns (
            bool parked,
            uint256 amount,
            uint256 dayId,
            bool acknowledged,
            uint256 debited
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!LibRewardCustody.transportBatchExists(s.transportBatches[batchId])) {
            revert TransportBatchUnknown(batchId);
        }
        LibVaipakam.TransportRemainder storage r = s.transportRemainders[batchId];
        if (r.batchId == bytes32(0)) return (false, 0, 0, false, 0);
        return (true, r.amount, r.dayId, r.acknowledged, r.debited);
    }

    /// @notice One day's batch MEMBERSHIP index, paginated, with each entry's
    ///         arrival and the day's consumption cursor.
    /// @dev    Paginated because the legacy lane can mint arbitrarily many
    ///         small batches listing one day: a view that returned the whole
    ///         index would stop being callable exactly on the days that matter
    ///         most. `cursor` is where allocation resumes, so `cursor ==
    ///         total` means every batch this day ever listed is spent.
    ///
    ///         `arrivedAt` is returned WITH the page (Codex #2232 r3): the
    ///         page walks the day's order, which is each delivery's own
    ///         recorded arrival — written once by the ingress, which also
    ///         links the epoch into the order (#2828) — so a reader can check
    ///         the key rather than infer it. Two deliveries that landed in the
    ///         same block share a key; within one block there is no arrival
    ///         order to preserve, and the batch id breaks the tie
    ///         deterministically for any reader that needs a total order.
    /// @param  dayId  The day.
    /// @param  offset Where to start in the order.
    /// @param  limit  How many to return.
    /// @return page      The batch ids in that window, in the day's order.
    /// @return arrivedAt Each returned batch's delivery arrival, same order as
    ///                   `page` — the ordering key, read from the packet.
    /// @return total     How many batches this day has ever indexed.
    /// @return cursor    The day's consumption cursor as a POSITION — the
    ///                   count of leading exhausted epochs in the day's order,
    ///                   exact and read in constant work (the cursor only
    ///                   advances, so the figure is stored beside the node;
    ///                   Codex #2276 r11 P2). Zero when nothing is consumed;
    ///                   `cursor == total` reads the day exhausted. The node
    ///                   itself is {getTransportDayIndex}'s.
    function getTransportDayBatches(uint256 dayId, uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory page, uint64[] memory arrivedAt, uint256 total, uint256 cursor)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        bytes32[] storage arr = s.transportBatchesByDay[dayId];
        total = arr.length;
        uint256 want = offset >= total ? 0 : (total - offset < limit ? total - offset : limit);
        page = new bytes32[](want);
        arrivedAt = new uint64[](want);
        // The read costs what its own arguments ask — `offset + limit` steps
        // along the order (Codex #2276 r8 P2) — and the cursor is the stored
        // position, exact in one read, on this selector's numeric contract
        // (r10, r11 P2). {getTransportDayBatchesFrom} pages from any node
        // for the cost of the page alone. One order: the list holds every day
        // whole (Codex #2296 items 2 and 4).
        cursor = s.transportDayCursor[dayId];
        bytes32 node = s.transportDayHead[dayId];
        uint256 pos;
        uint256 w;
        while (node != bytes32(0) && w < want) {
            if (pos >= offset) {
                page[w] = node;
                arrivedAt[w] = s.ingressPackets[node].arrivedAt;
                unchecked { ++w; }
            }
            node = s.transportDayNext[dayId][node];
            unchecked { ++pos; }
        }
    }

    /// @notice A page of `dayId`'s epochs in the day's order starting AT
    ///         `from` (zero: the head), with the node the next page starts
    ///         at (zero: none) — each page costs its own length (Codex #2276
    ///         r8 P2).
    /// @dev    The day's order is the list's, for every day (Codex #2296
    ///         items 2 and 4), so a page costs its own length and nothing
    ///         else — there is no array-ordered case that had to scan to
    ///         `from` by position.
    function getTransportDayBatchesFrom(uint256 dayId, bytes32 from, uint256 limit)
        external
        view
        returns (bytes32[] memory page, uint64[] memory arrivedAt, bytes32 next)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        bytes32[] memory buf = new bytes32[](limit);
        uint256 w;
        bytes32 head = s.transportDayHead[dayId];
        // A node outside the day's order pages nothing rather than itself.
        bool inOrder = from == bytes32(0) || from == head || s.transportDayPrev[dayId][from] != bytes32(0);
        bytes32 node = !inOrder ? bytes32(0) : (from == bytes32(0) ? head : from);
        while (node != bytes32(0) && w < limit) {
            buf[w] = node;
            unchecked { ++w; }
            node = s.transportDayNext[dayId][node];
        }
        next = node;
        page = new bytes32[](w);
        arrivedAt = new uint64[](w);
        for (uint256 k; k < w; ++k) {
            page[k] = buf[k];
            arrivedAt[k] = s.ingressPackets[buf[k]].arrivedAt;
        }
    }

    /// @notice The batch ids a plan of `dayId` can look up — the nodes from
    ///         the scan's start, at most one prune's worth and one window —
    ///         what a dry run hands the plan as a compact overlay (Codex
    ///         #2276 r13 P1). See {LibRewardCustody.transportDayScanIds}.
    function getTransportDayScanIds(uint256 dayId) external view returns (bytes32[] memory) {
        return LibRewardCustody.transportDayScanIds(LibVaipakam.storageSlot(), dayId);
    }

    /// @notice The state of `dayId`'s index: how many epochs it has ever
    ///         listed, and its consumption cursor as the NODE it is (Codex
    ///         #2276 r10 P2 — the last exhausted epoch at the front of the
    ///         order, zero when none is), which
    ///         {getTransportDayBatchesFrom} pages from.
    /// @dev    The list holds every day whole, so there is no "how much is
    ///         linked" figure and no conversion flag to report (Codex #2296
    ///         items 2 and 4): a day's membership count IS its order's
    ///         length. The cursor as a POSITION is
    ///         {getTransportDayBatches}'s fourth return.
    function getTransportDayIndex(uint256 dayId)
        external
        view
        returns (uint256 total, bytes32 cursor)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        total = s.transportBatchesByDay[dayId].length;
        cursor = s.transportDayCursorNode[dayId];
    }

    // ─── Transport epochs PR 3b-ii-A: the draws ─────────────────────────────

    /// @notice What `dayId`'s epochs can fund right now, within one scan
    ///         window; whether the window ended before the index did; and what
    ///         the window held that no draw may take, by named reason.
    /// @dev    See {LibRewardCustody.TransportDrawPlan} for the withheld
    ///         figure (Codex #2276 r26): `withheldUnattested` waits for its
    ///         packet's split attestation. (The multi-day figure retired with
    ///         the multi-day wire, #2828.)
    function getTransportCoverageForDay(uint256 dayId)
        external
        view
        returns (uint256 available, bool capHit, uint256 withheldUnattested)
    {
        return LibRewardCustody.transportCoverageForDay(LibVaipakam.storageSlot(), dayId);
    }

    /// @notice The gates a batch is admitted through, as flags (0 = drawable;
    ///         1 unattested — bits 2 and 4 retired with the multi-day wire,
    ///         #2828), and whether a staging record may stage from it
    ///         (drawable only).
    function getTransportBatchGates(bytes32 batchId) external view returns (uint8 gates, bool stageable) {
        gates = LibRewardCustody.batchGates(LibVaipakam.storageSlot(), batchId);
        stageable = gates == 0;
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
    function epochSettleLegs(
        uint8 source,
        uint256 liveFresh,
        uint256 epochLegs,
        uint256 treasuryRecycledRelease,
        uint256 userEpochRecycled,
        uint256 eraFunded,
        uint256 refId
    ) external {
        _requireDiamondInternal();
        LibVpfiRecycle.RecycleSource src = LibVpfiRecycle.RecycleSource(source);
        LibVpfiRecycle.absorbRewardFresh(src, refId, liveFresh);
        LibVpfiRecycle.absorbTransportFunded(src, refId, epochLegs);
        LibVpfiRecycle.absorbEraFunded(src, refId, eraFunded); // PR C-2 - era-funded: its own class, no bound charge
        if (treasuryRecycledRelease > 0) {
            LibVpfiRecycle.releaseCommitment(src, refId, treasuryRecycledRelease);
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
    /// @notice #2961 (owner decision 2026-10-28) — SKIP a reward day whose
    ///         delivery parts disagreed on its whole: close it UNPAID on this
    ///         mirror so every later day's claims and sweeps resume.
    ///         Permissionless and keeper-backed: the conflict is the chain's
    ///         own record, and the skip picks no figure. Releases the recycled
    ///         commitment the broadcast reserved for the day, under
    ///         `RecycleSource.DeliveryConflictSkipped`. The landed value moves
    ///         by {recycleSkippedDayValue}.
    /// @dev    Rule and refusals: {LibRewardCustody.skipConflictedDay}. Not
    ///         `whenNotPaused`, like the rest of this facet: it pays nobody.
    function skipConflictedDay(uint256 dayId) external nonReentrant {
        uint256 commit = LibRewardCustody.skipConflictedDay(LibVaipakam.storageSlot(), dayId);
        LibVpfiRecycle.releaseCommitment(LibVpfiRecycle.RecycleSource.DeliveryConflictSkipped, dayId, commit);
    }

    /// @notice #2961 — move what a SKIPPED day's epochs still hold into this
    ///         mirror's recycle bucket, where it funds later days on this
    ///         chain (owner decision 2026-10-28, option i). Absorbed exactly
    ///         like an epoch-funded forfeit, under
    ///         `RecycleSource.DeliveryConflictSkipped` with the day as refId.
    ///         Permissionless and repeatable: call until it returns zero.
    /// @dev    A pre-activation mirror holds no epochs: its fresh share is
    ///         already headroom in the delivered bound that funds later days,
    ///         and its recycled share is already in the bucket, so this draws
    ///         nothing there.
    /// @return recycled Both legs moved this call.
    function recycleSkippedDayValue(uint256 dayId) external nonReentrant returns (uint256 recycled) {
        (uint256 fresh, uint256 rec) = LibRewardCustody.drawSkippedDayRemainder(LibVaipakam.storageSlot(), dayId);
        recycled = fresh + rec;
        LibVpfiRecycle.absorbTransportFunded(LibVpfiRecycle.RecycleSource.DeliveryConflictSkipped, dayId, recycled);
    }

    function epochPruneTransportDayCursor(uint256 dayId) external nonReentrant {
        LibRewardCustody.pruneTransportDayCursor(LibVaipakam.storageSlot(), dayId);
    }

    function _requireDiamondInternal() private view {
        if (msg.sender != address(this)) revert RewardCustodyOnlyDiamondInternal(msg.sender);
    }
}
