// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";

import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";

/**
 * @title  MeshCommitRetirementTest
 * @notice #1222 M3 B3 — source-scoped netted remittance completion: the
 *         mirror→Base commitment-RETIREMENT signal and the two books it
 *         closes (design record
 *         `docs/DesignsAndPlans/Vpfi1222B3SourceScopedNettingDesign.md`).
 *
 *         B2-d3 booked a mirror's locally-funded slice into
 *         `chainConsumedRecycled[c]` (the instruction cumulative) and
 *         `chainOutstandingRecycledCommit[c]` (the reservation ledger), but
 *         Base had no authenticated view of what the mirror then did with
 *         the reservation. Two consequences, both proved here:
 *
 *           1. the reservation ledger only ever GREW, and
 *           2. a commitment RELEASED un-spent (forfeit / RL-3 expiry — the
 *              tokens never left the mirror's bucket) was lost from Base's
 *              availability model permanently, so a chain with ordinary
 *              forfeit rates would eventually read as having zero
 *              availability while its bucket was full.
 *
 *         Every test drives the REAL armed-day finalization to create the
 *         instruction, then delivers a real report through the ingress —
 *         no direct writes to the books under test.
 */
contract MeshCommitRetirementTest is SetupTest {
    MockRewardMessenger internal messenger;

    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;

    function setUp() public {
        setupHelper();
        messenger = new MockRewardMessenger(address(diamond));
        _configureCanonical();
    }

    function _rep() internal view returns (RewardReporterFacet) {
        return RewardReporterFacet(address(diamond));
    }

    function _agg() internal view returns (RewardAggregatorFacet) {
        return RewardAggregatorFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    function _configureCanonical() internal {
        vm.chainId(CHAIN_BASE);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(true);
        _rep().setRewardMessenger(address(messenger));
        uint32[] memory chainIds = new uint32[](2);
        chainIds[0] = CHAIN_BASE;
        chainIds[1] = CHAIN_ARB;
        _agg().setExpectedSourceChainIds(chainIds);
    }

    /// @dev Deliver ARB's day-close report — the eight-word B3 shape —
    ///      WITHOUT finalizing. Reporting and finalization are separated
    ///      throughout this suite on purpose: an armed finalization
    ///      immediately re-instructs whatever availability the report just
    ///      restored, so an assertion taken after finalize would read the
    ///      restored figure back as ~zero and prove nothing.
    function _reportArb(
        uint256 dayId,
        uint256 arbCumulative,
        uint256 retiredCum,
        uint256 releasedCum
    ) internal {
        messenger.deliverChainReportB3(
            CHAIN_ARB,
            dayId,
            20e18,
            10e18,
            arbCumulative,
            0,
            retiredCum,
            releasedCum
        );
    }

    /// @dev Complete `dayId`'s coverage with Base's own report and finalize.
    function _finalize(uint256 dayId) internal {
        messenger.deliverChainReport(CHAIN_BASE, dayId, 10e18, 5e18);
        _mut().setChainDayCommitmentCompleteRaw(dayId, CHAIN_ARB, true);
        _agg().finalizeDay(dayId);
    }

    /// @dev The armed-day scaffold every retirement test starts from: ARB
    ///      reports 40 VPFI of availability on day 5, and the armed
    ///      finalization instructs it to fund that whole 40 locally.
    ///      Returns the instructed figure.
    function _armAndInstruct40() internal returns (uint256 instructed) {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether); // Ā=100, coupled=95
        _mut().setGovernorCommitArmedFromDayRaw(5);

        _reportArb(5, 40 ether, 0, 0);
        _finalize(5);

        (, instructed, , ) = _agg().getChainRecycledLedger(CHAIN_ARB);
        assertApproxEqAbs(instructed, 40 ether, 1e15, "ARB instructed ~40");
        assertEq(
            _agg().getChainOutstandingRecycledCommit(CHAIN_ARB),
            instructed,
            "reservation ledger starts at the full instruction"
        );
    }

    /// @dev The B3 invariant the reservation ledger must satisfy at every
    ///      instant, in-flight broadcasts included:
    ///      `outstanding == instructed − retired` (design record §2.2).
    function _assertLedgerIdentity(uint32 chainId) internal view {
        (, uint256 instructed, , ) = _agg().getChainRecycledLedger(chainId);
        (uint256 retired, ) =
            _agg().getChainRecycledCommitRetirement(chainId);
        assertEq(
            _agg().getChainOutstandingRecycledCommit(chainId),
            instructed > retired ? instructed - retired : 0,
            "outstanding == instructed - retired"
        );
    }

    // ─── The reservation ledger now retires ──────────────────────────────

    /// The core B3 behaviour: a later report carrying the mirror's
    /// retirement cumulative shrinks `chainOutstandingRecycledCommit[c]` by
    /// exactly that much. Against B2-d3's code the ledger is monotonic and
    /// this assertion fails at the full instructed figure.
    function test_B3_ReportedRetirementRetiresTheReservationLedger() public {
        uint256 instructed = _armAndInstruct40();

        // ARB spent 25 of its reservation on claims (retired, not released).
        _reportArb(6, 40 ether, 25 ether, 0);

        assertEq(
            _agg().getChainOutstandingRecycledCommit(CHAIN_ARB),
            instructed - 25 ether,
            "reservation shrank by exactly the retired amount"
        );
        _assertLedgerIdentity(CHAIN_ARB);
        (uint256 retired, uint256 released) =
            _agg().getChainRecycledCommitRetirement(CHAIN_ARB);
        assertEq(retired, 25 ether, "retired cumulative on record");
        assertEq(released, 0, "nothing released");
    }

    /// The retirement cumulative RATCHETS: a stale or re-ordered delivery
    /// reporting a lower figure can never walk the ledger backwards (and so
    /// can never re-inflate the reservation).
    function test_B3_StaleRetirementReportNeverWalksTheLedgerBack() public {
        uint256 instructed = _armAndInstruct40();
        _reportArb(6, 40 ether, 25 ether, 0);

        // A delayed earlier-day report arrives carrying an older, smaller
        // cumulative.
        _reportArb(7, 40 ether, 10 ether, 0);

        (uint256 retired, ) =
            _agg().getChainRecycledCommitRetirement(CHAIN_ARB);
        assertEq(retired, 25 ether, "ratchet held at the high-water mark");
        assertEq(
            _agg().getChainOutstandingRecycledCommit(CHAIN_ARB),
            instructed - 25 ether,
            "reservation unchanged by the stale report"
        );
    }

    // ─── Availability self-heals for RELEASED commitments ────────────────

    /// A commitment the mirror forfeits/expires un-spent leaves its tokens
    /// in that chain's bucket, so the availability Base models must come
    /// back. Against B2-d3's `reported - consumed` this reads 0 forever.
    function test_B3_ReleasedCommitmentsRestoreAvailability() public {
        _armAndInstruct40();

        (, , uint256 availBefore, ) = _agg().getChainRecycledLedger(CHAIN_ARB);
        assertApproxEqAbs(availBefore, 0, 1e15, "instruction exhausted it");

        // ARB retired all 40, but 15 of that was a RELEASE — those tokens
        // never left its bucket.
        _reportArb(6, 40 ether, 40 ether, 15 ether);

        (, , uint256 availAfter, ) = _agg().getChainRecycledLedger(CHAIN_ARB);
        assertApproxEqAbs(
            availAfter, 15 ether, 1e15, "released tokens are committable again"
        );
        assertEq(
            _agg().getChainOutstandingRecycledCommit(CHAIN_ARB),
            0,
            "everything instructed has been retired"
        );
    }

    /// Availability restored by a release is REAL funding capacity, not just
    /// a number in a view: the next armed day funds that chain locally again
    /// instead of drawing the whole slice from Base.
    function test_B3_RestoredAvailabilityFundsTheNextArmedDayLocally() public {
        _armAndInstruct40();
        _reportArb(6, 40 ether, 40 ether, 15 ether);

        _finalize(6);

        LibVaipakam.ChainDayFunding memory arb =
            _agg().getChainDayRecycledFunding(6, CHAIN_ARB);
        assertTrue(arb.stamped, "day 6 stamped");
        assertApproxEqAbs(
            arb.recycleConsume,
            15 ether,
            1e15,
            "ARB funds the restored 15 from its OWN bucket"
        );
        // And the instruction re-encumbers it: the ledger identity holds
        // across the restore → re-instruct cycle.
        _assertLedgerIdentity(CHAIN_ARB);
    }

    // ─── The clamps: Base trusts a mirror for timing, never magnitude ────

    /// Both figures are clamped to Base's OWN instruction cumulative, so a
    /// buggy or hostile mirror sender cannot manufacture availability. The
    /// load-bearing consequence is the ceiling `avail <= reported`.
    function test_B3_OverstatedRetirementIsClampedToInstructions() public {
        uint256 instructed = _armAndInstruct40();

        // ARB claims to have retired AND released ten times what it was ever
        // instructed to fund.
        _reportArb(6, 40 ether, 400 ether, 400 ether);

        (uint256 retired, uint256 released) =
            _agg().getChainRecycledCommitRetirement(CHAIN_ARB);
        assertEq(retired, instructed, "retired clamped to instructions");
        assertEq(released, instructed, "released clamped alongside it");

        (uint256 reported, , uint256 avail, ) =
            _agg().getChainRecycledLedger(CHAIN_ARB);
        assertLe(avail, reported, "CEILING: avail can never exceed reported");
        assertEq(avail, reported, "and here it is exactly the reported 40");
        assertEq(
            _agg().getChainOutstandingRecycledCommit(CHAIN_ARB),
            0,
            "the clamp retires at most everything instructed, never more"
        );
    }

    /// `released <= retired` is enforced independently of the instruction
    /// clamp: a report claiming more released than retired is trimmed to the
    /// retired figure, so the self-heal can never outrun what the mirror
    /// actually gave back.
    function test_B3_ReleasedIsClampedToRetired() public {
        _armAndInstruct40();

        _reportArb(6, 40 ether, 10 ether, 30 ether);

        (uint256 retired, uint256 released) =
            _agg().getChainRecycledCommitRetirement(CHAIN_ARB);
        assertEq(retired, 10 ether, "retired as reported");
        assertEq(released, 10 ether, "released trimmed to retired");
    }

    // ─── Older wire generations stay inert ───────────────────────────────

    /// A six-word (B1) or four-word (legacy) report forwards zeros for the
    /// retirement pair, and zeros advance nothing — the rollout shims cannot
    /// silently retire a reservation or invent availability.
    function test_B3_OlderReportShapesAdvanceNothing() public {
        uint256 instructed = _armAndInstruct40();

        messenger.deliverChainReportRecycled(
            CHAIN_ARB, 6, 20e18, 10e18, 40 ether, 0
        );
        messenger.deliverChainReport(CHAIN_ARB, 7, 20e18, 10e18);

        (uint256 retired, uint256 released) =
            _agg().getChainRecycledCommitRetirement(CHAIN_ARB);
        assertEq(retired, 0, "legacy shapes carry no retirement");
        assertEq(released, 0, "legacy shapes carry no release");
        assertEq(
            _agg().getChainOutstandingRecycledCommit(CHAIN_ARB),
            instructed,
            "reservation untouched by older generations"
        );
    }

    // ─── Base's own chain id is inert ────────────────────────────────────

    /// Base never instructs itself, so its own reported retirement pair is
    /// clamped to zero and can never inflate its per-chain books. Base funds
    /// from its live fundable balance, never through this model.
    function test_B3_BaseOwnChainRetirementIsInert() public {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether);
        _mut().setGovernorCommitArmedFromDayRaw(5);

        messenger.deliverChainReportB3(
            CHAIN_BASE, 5, 10e18, 5e18, 500 ether, 0, 500 ether, 500 ether
        );
        messenger.deliverChainReportB3(
            CHAIN_ARB, 5, 20e18, 10e18, 40 ether, 0, 0, 0
        );
        _mut().setChainDayCommitmentCompleteRaw(5, CHAIN_ARB, true);
        _agg().finalizeDay(5);

        (uint256 retired, uint256 released) =
            _agg().getChainRecycledCommitRetirement(CHAIN_BASE);
        assertEq(retired, 0, "Base retirement clamped to its zero instructions");
        assertEq(released, 0, "Base release clamped likewise");
        assertEq(
            _agg().getChainOutstandingRecycledCommit(CHAIN_BASE),
            0,
            "Base holds no per-chain reservation"
        );
    }

    // ─── The local counters the report actually carries ──────────────────

    /// The mirror-local counters are maintained by the two commitment
    /// primitives, and the day-close report ships exactly what they hold —
    /// the readback that lets an operator prove a mirror's report matches
    /// its own ledger.
    function test_B3_LocalCountersRideTheDayCloseReport() public {
        // Reserve 100, then retire 30 by consumption and release 20.
        _mut().setRecycleBucketRaw(1_000 ether);
        _mut().setOutstandingCommitRaw(0, 100 ether);
        _mut().consumeRecycleRaw(30 ether);
        _mut().releaseRecycleCommitmentRaw(20 ether);

        (uint256 retired, uint256 released) =
            _agg().getLocalRecycledCommitRetirement();
        assertEq(retired, 50 ether, "30 consumed + 20 released");
        assertEq(released, 20 ether, "release-only subset");
    }

    /// Both primitives FLOOR the outstanding sum at zero, and the counters
    /// must record the ACTUAL decrement — otherwise a chain whose
    /// outstanding is already exhausted would over-report retirement to
    /// Base, and (via the release half) manufacture availability.
    function test_B3_CountersRecordTheActualDecrementNotTheRequest() public {
        _mut().setRecycleBucketRaw(1_000 ether);
        _mut().setOutstandingCommitRaw(0, 10 ether);

        // Ask to retire far more than is outstanding, both ways.
        _mut().consumeRecycleRaw(40 ether);
        _mut().releaseRecycleCommitmentRaw(40 ether);

        (uint256 retired, uint256 released) =
            _agg().getLocalRecycledCommitRetirement();
        assertEq(retired, 10 ether, "only the 10 actually outstanding retired");
        assertEq(released, 0, "nothing left to release after the consume");
    }
}
