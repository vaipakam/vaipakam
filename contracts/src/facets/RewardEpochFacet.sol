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
 *         callers — permissionless indexing, and operator parking — and the
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
    ///         releasing its value for classification are both open to anyone
    ///         and may happen in either order, which is exactly why the
    ///         evidence bound is derived at use time rather than snapshotted.
    ///         An earlier revision of this facet gated both halves on
    ///         `ADMIN_ROLE`, which turned a specified lifecycle into an
    ///         administrator-dependent one and left a valid batch's closeout
    ///         waiting on whoever holds the role.
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
    ///         Permissionless for the same reason as the park above, and
    ///         state-gated the same way: a remainder must be parked and not
    ///         already acknowledged.
    function acknowledgeTransportBatchRemainder(bytes32 batchId)
        external
        nonReentrant
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

    /// @notice A batch's parked remainder.
    /// @return amount       What was parked; zero when nothing is.
    /// @return dayListHash  The membership that still binds it.
    /// @return dayCount     How many days that list names.
    /// @return acknowledged Whether the acknowledgment has been recorded.
    function getTransportRemainder(bytes32 batchId)
        external
        view
        returns (uint256 amount, bytes32 dayListHash, uint32 dayCount, bool acknowledged)
    {
        LibVaipakam.TransportRemainder storage r =
            LibVaipakam.storageSlot().transportRemainders[batchId];
        if (r.batchId == bytes32(0)) return (0, bytes32(0), 0, false);
        return (r.amount, r.dayListHash, r.dayCount, r.acknowledged);
    }

    /// @notice One day's ARRIVAL-ORDERED batch index, paginated, with its
    ///         consumption cursor.
    /// @dev    Paginated because the legacy lane can mint arbitrarily many
    ///         small batches listing one day: a view that returned the whole
    ///         index would stop being callable exactly on the days that matter
    ///         most. `cursor` is where allocation resumes, so `cursor ==
    ///         total` means every batch this day ever listed is spent.
    /// @param  dayId  The day.
    /// @param  offset Where to start, in arrival order.
    /// @param  limit  How many to return.
    /// @return page   The batch ids in that window.
    /// @return total  How many batches this day has ever indexed.
    /// @return cursor The day's consumption cursor.
    function getTransportDayBatches(uint256 dayId, uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory page, uint256 total, uint256 cursor)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        bytes32[] storage index = s.transportBatchesByDay[dayId];
        total = index.length;
        cursor = s.transportDayCursor[dayId];
        if (offset >= total) return (new bytes32[](0), total, cursor);
        // Clamped against what REMAINS rather than computing `offset + limit`:
        // a caller asking for everything with an unbounded limit would
        // otherwise overflow into a panic instead of getting the tail.
        uint256 end = total - offset < limit ? total : offset + limit;
        page = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = index[i];
        }
    }
}
