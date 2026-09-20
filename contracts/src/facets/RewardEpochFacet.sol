// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibRewardCustody} from "../libraries/LibRewardCustody.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title  RewardEpochFacet
 * @notice The TRANSPORT EPOCHS: each old-wire reward delivery holds an untyped
 *         balance that only the obligations whose day it listed may draw from.
 *         This facet carries that ledger's lifecycle after ingress — an
 *         oversize batch's paged indexing, and the parking and acknowledgment
 *         that release a batch so what remains of its packet becomes
 *         classifiable.
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
    /// @notice Index one bounded page of an OVERSIZE batch's membership.
    /// @dev    Permissionless, because the authority is the day-list
    ///         commitment the delivery's own ingress stamped and not the
    ///         caller: anyone may supply the payload, and nobody can supply a
    ///         different one. An oversize batch is admitted compactly — a
    ///         transport payload is immutable, so refusing one at the
    ///         destination would refuse the same message on every
    ///         re-execution — and this is how its membership is then written,
    ///         at a per-call storage cost equal to what a within-cap
    ///         admission pays in one go.
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
        return LibRewardCustody.parkTransportRemainder(LibVaipakam.storageSlot(), batchId);
    }

    /// @notice Record the acknowledgment that RELEASES a batch.
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
        LibRewardCustody.acknowledgeTransportRemainder(LibVaipakam.storageSlot(), batchId);
    }

    /// @notice A transport epoch as recorded.
    /// @dev    A lean tuple rather than the struct: an ABI-coded struct return
    ///         inflates the viaIR peak stack, which this codebase sits close
    ///         to. `balance` is what remains spendable by the batch's member
    ///         days; `admitted` is the immutable conservation anchor.
    /// @return packetHash  The delivery that opened it; zero when no batch was
    ///                     admitted under this id. DERIVED, not stored — the
    ///                     batch is keyed by that stamp, so storing it would
    ///                     restate the key.
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
            admittedAmount == 0 ? bytes32(0) : batchId,
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
    function getTransportBatchLegs(bytes32 batchId)
        external
        view
        returns (uint256 consumedFresh, uint256 consumedRecycled)
    {
        LibVaipakam.TransportBatch storage b = LibVaipakam.storageSlot().transportBatches[batchId];
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
        LibVaipakam.TransportRemainder storage r =
            LibVaipakam.storageSlot().transportRemainders[batchId];
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
}
