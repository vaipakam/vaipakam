// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
import {RewardCompensationDispatchFacet} from "../src/facets/RewardCompensationDispatchFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/**
 * @title  RemitHistoryBackfillTest
 * @notice Codex #2489 r7 — the reservation HISTORY rule. `strandedRecycled`
 *         and `recycledBooked` were appended to the reservation record after
 *         reservations had been released and finalized on upgraded-in-place
 *         Diamonds, so both facts are derived from the record's own state:
 *         lazily where read (the stranded settle, the recovery ceremony) and
 *         eagerly by the permissionless bounded walk
 *         `RewardRemittanceFacet.backfillRemitHistory`. The rows here are
 *         raw-driven into exactly the shape an upgrade leaves: a status and
 *         flags, no stamp, no booking.
 */
contract RemitHistoryBackfillTest is SetupTest {
    RewardRemittanceFacet internal remit;
    RewardRemittanceLensFacet internal rlens;
    RewardCompensationDispatchFacet internal comp;
    TestMutatorFacet internal mutator;

    uint32 internal constant ARB = 42161;
    uint32 internal constant OP = 10;

    event RemitRecycledBookedFromHistory(uint256 indexed remitId, uint8 booked);
    event ReleasedRemitStrandedStamped(uint256 indexed remitId, uint256 amount);
    event ReleasedRemitStrandedResolved(uint256 indexed remitId, uint256 amount);

    function setUp() public {
        setupHelper();
        remit = RewardRemittanceFacet(address(diamond));
        rlens = RewardRemittanceLensFacet(address(diamond));
        comp = RewardCompensationDispatchFacet(address(diamond));
        mutator = TestMutatorFacet(address(diamond));
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(true);
    }

    /// @dev A released row as an upgrade leaves it: finalized shape first (the
    ///      total survives), then status 3 with its recycled share, no stamp.
    function _releasedRaw(uint256 id, uint256 total, uint256 recycled) internal {
        mutator.setRemitReservationFinalizedRaw(id, ARB, total, recycled, false, false, false);
        mutator.setRemitReservationReleasedRaw(id, recycled);
    }

    /// @notice Finalized history books its recycled share for its destination,
    ///         acknowledged (the declared share) or forced, exactly once, in any
    ///         chunking; a finalized row that moved no value books nothing.
    /// @dev    Mutation: book the forced bucket for a consumed row → the ARB
    ///         acked figure misses 10e18 and the forced one gains it.
    function test_History_BooksFinalizedShares_ByDestination_Once() public {
        mutator.setRemitReservationFinalizedRaw(1, ARB, 30e18, 10e18, true, false, false); // acked
        mutator.setRemitReservationFinalizedRaw(2, ARB, 20e18, 5e18, false, false, true); // forced only
        mutator.setRemitReservationFinalizedRaw(3, OP, 9e18, 4e18, true, true, true); // forced, then acked (contradicted)
        mutator.setRemitReservationFinalizedRaw(4, OP, 0, 0, false, false, false); // moved nothing
        // A RELEASED row the mirror consumed after all (the live late-ack
        // path books it; Codex #2489 r8), and one it never did.
        _releasedRaw(5, 10e18, 3e18);
        mutator.setReleasedRemitHistoryRaw(5, 0, 0, true, false);
        _releasedRaw(6, 10e18, 2e18);
        (uint256 acked, uint256 forced) = rlens.getChainRemittedRecycled(ARB);
        assertEq(acked + forced, 0, "fixture: nothing booked before the walk");

        (uint256 sp, uint256 bp, uint256 nonce) = rlens.getRemitHistoryPending(1, 100);
        assertEq(nonce, 6, "fixture: six reservations");
        assertEq(sp, 2, "two released rows to stamp");
        assertEq(bp, 4, "four shares to book: three finalized, one released-and-consumed");

        // Chunked: the first two, then the rest; every write announced.
        vm.expectEmit(true, false, false, true);
        emit RemitRecycledBookedFromHistory(1, 2);
        vm.expectEmit(true, false, false, true);
        emit RemitRecycledBookedFromHistory(2, 1);
        (uint256 s1, uint256 b1) = remit.backfillRemitHistory(1, 2);
        assertEq(s1, 0);
        assertEq(b1, 2, "first chunk: two booked");
        (, bp, ) = rlens.getRemitHistoryPending(1, 100);
        assertEq(bp, 2, "two left");
        vm.expectEmit(true, false, false, true);
        emit RemitRecycledBookedFromHistory(3, 2);
        vm.expectEmit(true, false, false, true);
        emit RemitRecycledBookedFromHistory(5, 2);
        (uint256 s2, uint256 b2) = remit.backfillRemitHistory(3, 1_000);
        assertEq(b2, 2, "second chunk: the last finalized row and the consumed released row, the range clipped to the nonce");
        assertEq(s2, 2, "both released rows stamped");

        (acked, forced) = rlens.getChainRemittedRecycled(ARB);
        assertEq(acked, 13e18, "ARB acked: the acknowledged finalized row plus the consumed released row");
        assertEq(forced, 5e18, "ARB forced: the forced-only row");
        assertEq(rlens.getRemitReservation(5).recycledBooked, 2, "released + consumed: booked acked");
        assertEq(rlens.getRemitReservation(6).recycledBooked, 0, "released, never consumed: nothing to book");
        (acked, forced) = rlens.getChainRemittedRecycled(OP);
        assertEq(acked, 4e18, "OP acked: a forced-then-acknowledged row books straight to acked");
        assertEq(forced, 0, "OP forced: nothing left in the forced bucket");
        assertEq(rlens.getRemitReservation(1).recycledBooked, 2, "row 1 booked acked");
        assertEq(rlens.getRemitReservation(2).recycledBooked, 1, "row 2 booked forced");
        assertEq(rlens.getRemitReservation(4).recycledBooked, 0, "a row that moved nothing stays unbooked");

        // Idempotent: a second pass writes nothing and moves no counter.
        (uint256 s3, uint256 b3) = remit.backfillRemitHistory(1, 100);
        assertEq(s3 + b3, 0, "second pass: nothing to write");
        (, bp, ) = rlens.getRemitHistoryPending(1, 100);
        assertEq(bp, 0, "nothing pending");
        (acked, forced) = rlens.getChainRemittedRecycled(ARB);
        assertEq(acked + forced, 18e18, "ARB unchanged");
        // An empty / past-the-end range is a no-op, not a revert.
        (s3, b3) = remit.backfillRemitHistory(50, 10);
        assertEq(s3 + b3, 0);
    }

    /// @notice Released history gets its stranded record from the share it sent
    ///         net of what the ceremony already resolved for it, and a trusted
    ///         consumption resolves it at once; an untrusted one does not.
    /// @dev    Mutation: derive from the share alone (ignore the ceremony's
    ///         per-reservation records) → row 6 stamps 20e18, not 15e18.
    function test_History_StampsReleasedStranded_NetOfCeremony_AndResolvesTrusted() public {
        _releasedRaw(6, 50e18, 20e18);
        mutator.setReleasedRemitHistoryRaw(6, 3e18, 2e18, false, false); // 5e18 already resolved
        _releasedRaw(7, 10e18, 8e18);
        mutator.setReleasedRemitHistoryRaw(7, 0, 0, true, false); // trusted consumption
        _releasedRaw(8, 10e18, 6e18);
        mutator.setReleasedRemitHistoryRaw(8, 0, 0, true, true); // contradicted: untrusted

        (uint256 sp, uint256 bp, ) = rlens.getRemitHistoryPending(1, 100);
        assertEq(sp, 3, "three stranded records to write");
        assertEq(bp, 2, "rows 7 and 8 were consumed after release: two shares to book (r8)");
        assertFalse(rlens.getRemitReservation(6).strandedStamped, "fixture: unstamped");

        vm.expectEmit(true, false, false, true);
        emit ReleasedRemitStrandedStamped(6, 15e18);
        vm.expectEmit(true, false, false, true);
        emit ReleasedRemitStrandedStamped(7, 8e18);
        vm.expectEmit(true, false, false, true);
        emit ReleasedRemitStrandedResolved(7, 8e18);
        vm.expectEmit(true, false, false, true);
        emit ReleasedRemitStrandedStamped(8, 6e18);
        (uint256 stranded, uint256 booked) = remit.backfillRemitHistory(1, 100);
        assertEq(stranded, 3, "three records written");
        assertEq(booked, 2, "the two consumed released rows booked");
        assertEq(rlens.getRemitReservation(7).recycledBooked, 2, "row 7 booked acked");
        assertEq(rlens.getRemitReservation(8).recycledBooked, 2, "row 8: a contradicted consumption books too (the stricter direction)");
        assertEq(rlens.getRemitReservation(6).recycledBooked, 0, "row 6 was never consumed: nothing to book");

        LibVaipakam.RemitReservation memory r6 = rlens.getRemitReservation(6);
        assertTrue(r6.strandedStamped, "row 6 stamped");
        assertEq(r6.strandedRecycled, 15e18, "row 6: 20e18 sent less 5e18 the ceremony resolved");
        LibVaipakam.RemitReservation memory r7 = rlens.getRemitReservation(7);
        assertTrue(r7.strandedStamped, "row 7 stamped");
        assertEq(r7.strandedRecycled, 0, "row 7: resolved at once by its trusted consumption");
        assertEq(rlens.getRemitReservation(8).strandedRecycled, 6e18, "row 8: a contradicted consumption resolves nothing");

        // Idempotent: a stamped record is never re-derived — row 7's zero is
        // "resolved", not "unstamped".
        (stranded, ) = remit.backfillRemitHistory(1, 100);
        assertEq(stranded, 0, "second pass writes nothing");
        assertEq(rlens.getRemitReservation(7).strandedRecycled, 0, "row 7 stays resolved");
        (sp, , ) = rlens.getRemitHistoryPending(1, 100);
        assertEq(sp, 0, "nothing pending");
    }

    /// @notice The ceremony stamps an unstamped released row from history BEFORE
    ///         it deducts, so the deduction lands on the record: a 5e18 terminal
    ///         loss on a 20e18 share leaves 15e18 stamped, immediately.
    /// @dev    Mutation: no ensure in the ceremony → the record is still 0 and
    ///         unstamped right after the loss (the walk would stamp 15e18 later,
    ///         so the end state alone cannot tell; the immediate state can).
    function test_History_CeremonyStampsBeforeItDeducts() public {
        _releasedRaw(9, 50e18, 20e18);
        comp.recordRecoveryTerminalLoss(9, 0, 5e18);
        LibVaipakam.RemitReservation memory r = rlens.getRemitReservation(9);
        assertTrue(r.strandedStamped, "stamped by the ceremony's ensure");
        assertEq(r.strandedRecycled, 15e18, "20e18 stamped, then 5e18 deducted");
        // And the walk has nothing left to write for it.
        (uint256 stranded, ) = remit.backfillRemitHistory(9, 1);
        assertEq(stranded, 0, "already stamped");
    }
}
