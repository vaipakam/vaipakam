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

    // ─── #1569 keeper earmark vs. the identity ───────────────────────────

    /// The keeper earmark must NOT ride `chainConsumedRecycled`.
    ///
    /// That counter is one half of `outstanding == instructed − retired`,
    /// and only the local COMMIT enters the retirement lifecycle — a mirror
    /// can retire at most what it was committed. The first version of #1569
    /// added the earmark to it, which broke the identity on the first
    /// non-zero allocation and left the difference as phantom consumption
    /// permanently suppressing the chain's availability (Codex #2031 r2).
    ///
    /// The earmark now has its own draw slot, exactly like the C2
    /// repatriation draw whose storage doc names this same trap.
    function test_KeeperEarmarkDoesNotBreakTheLedgerIdentity() public {
        // 25% — large enough that a regression cannot hide inside the
        // approximate-equality slack the instruction figure carries.
        _agg().setChainKeeperAllocateBps(CHAIN_ARB, 2_500);

        uint256 instructed = _armAndInstruct40();

        // The identity holds WITH an armed allocation. Against the first
        // version of #1569 this fails: outstanding is the commit while
        // instructed carries commit + earmark.
        _assertLedgerIdentity(CHAIN_ARB);
        assertEq(
            _agg().getChainOutstandingRecycledCommit(CHAIN_ARB),
            instructed,
            "the earmark never inflated the instruction cumulative"
        );
    }

    /// …and the property the wrong placement was reaching for still holds:
    /// availability nets the earmark, so Base cannot instruct the same
    /// tokens twice. Without this the fix would be a regression dressed as
    /// one — the identity restored by simply forgetting the earmark.
    ///
    /// Needs HEADROOM to be visible at all: `_armAndInstruct40` gives ARB
    /// exactly enough to fund its own demand, and an earmark is bounded by
    /// what the commit leaves (see the over-commit test below), so on that
    /// scaffold the armed figure is legitimately zero.
    function test_KeeperEarmarkStillDrawsDownAvailability() public {
        _agg().setChainKeeperAllocateBps(CHAIN_ARB, 2_500);
        uint256 instructed = _armAndInstructWithHeadroom();
        uint256 keeperArmed = _agg().getChainKeeperDraw(CHAIN_ARB);
        assertGt(keeperArmed, 0, "the earmark fits in the headroom");
        (, , uint256 availArmed, ) = _agg().getChainRecycledLedger(CHAIN_ARB);

        // The identical scenario with the knob dark.
        setUp();
        uint256 instructedDark = _armAndInstructWithHeadroom();
        (, , uint256 availDark, ) = _agg().getChainRecycledLedger(CHAIN_ARB);

        assertEq(instructed, instructedDark, "same commit either way");
        assertEq(
            availDark - availArmed,
            keeperArmed,
            "availability falls by exactly the earmark, and by nothing else"
        );
    }

    /// The earmark is a SECOND draw on one bucket, so it must fit in what
    /// the claim commit leaves (Codex #2031 r3).
    ///
    /// `_armAndInstruct40` is the exact shape of the report: ARB's demand
    /// consumes its whole 40 of availability. Against the pre-fix code a
    /// 25% instruction still derived 10 on top — 40 of claims plus 10 of
    /// keeper budget backed by 40 tokens, with the mirror dutifully
    /// reserving both.
    function test_KeeperEarmarkCannotOverCommitTheBucket() public {
        _agg().setChainKeeperAllocateBps(CHAIN_ARB, 2_500);
        uint256 instructed = _armAndInstruct40();

        (uint256 reported, uint256 consumed, , ) =
            _agg().getChainRecycledLedger(CHAIN_ARB);
        uint256 keeper = _agg().getChainKeeperDraw(CHAIN_ARB);

        // The invariant, which is the actual claim: the two draws on one
        // bucket never exceed what the chain reported holding.
        assertLe(
            consumed + keeper,
            reported,
            "the two draws together never exceed what the chain reported"
        );
        // And the trim really bit. The pro-rata commit split leaves a few
        // WEI of rounding headroom, so the bound clamps a want of ~10e18
        // (25% of a 40e18 commit, which the pre-fix code granted in full,
        // on top of the commit) down to that dust. Asserting the dust is
        // zero would be asserting the rounding rather than the property;
        // asserting it is negligible is the property.
        assertLt(
            keeper,
            1e15,
            "earmark trimmed to the headroom the commit left, not 25% on top"
        );
        // Trimmed, never refused: the day still funded its full commit.
        assertApproxEqAbs(instructed, 40 ether, 1e15, "commit is untouched");
    }

    /// Base cannot be its own allocation target, and the refusal is the
    /// point: the mesh split gives Base no local commit to take a share OF
    /// (`_stampOne` leaves `commitLocal` at zero for the canonical id), so
    /// the setting would be stored, acknowledged by a success event, and
    /// never produce a single wei. An operator would believe Base's keeper
    /// share was armed (Codex #2031 r6).
    function test_CanonicalChainIsRefusedAsAnAllocationTarget() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardAggregatorFacet.KeeperAllocateTargetIsCanonical.selector,
                CHAIN_BASE
            )
        );
        _agg().setChainKeeperAllocateBps(CHAIN_BASE, 2_500);
        assertEq(
            _agg().getChainKeeperAllocateBps(CHAIN_BASE),
            0,
            "nothing was stored for the canonical chain"
        );

        // The control: the guard is scoped to the canonical id and has not
        // broken the case the setter exists for. Without this a change that
        // rejected every chain would pass the assertion above.
        _agg().setChainKeeperAllocateBps(CHAIN_ARB, 2_500);
        assertEq(
            _agg().getChainKeeperAllocateBps(CHAIN_ARB),
            2_500,
            "a mirror is still a valid target"
        );
    }

    /// @dev Like `_armAndInstruct40` but reports MORE availability than the
    ///      day's demand consumes, so an earmark has room to land. Returns
    ///      the instructed figure.
    function _armAndInstructWithHeadroom() internal returns (uint256 instructed) {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether);
        _mut().setGovernorCommitArmedFromDayRaw(5);

        _reportArb(5, 400 ether, 0, 0);
        _finalize(5);

        (, instructed, , ) = _agg().getChainRecycledLedger(CHAIN_ARB);
        assertGt(instructed, 0, "the day instructed something");
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
    /// formula-check:allow cites the superseded B2-d3 form as the historical
    /// contrast this test exists to demonstrate.
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

    /// Codex #1435 r1 P1 — the availability read must never REVERT, whatever
    /// a chain reports. `chainReportedRecycled[c]` is ratcheted to whatever
    /// cumulative a chain sends and is deliberately unbounded, so computing
    /// formula-check:allow the addition form is named here to refuse it.
    /// `(reported + released) − consumed` would overflow on a near-max
    /// cumulative paired with any nonzero release. That is not contained:
    /// this read is on the `finalizeDay` path via the mesh funding pass, and
    /// the ratchets cannot be walked back — one poisoned report would wedge
    /// day finalization for the whole mesh, permanently.
    function test_B3_HugeReportedCumulativeCannotWedgeFinalization() public {
        _armAndInstruct40();

        // A faulty/compromised mirror reports an absurd lifetime cumulative
        // together with a genuine release.
        _reportArb(6, type(uint256).max, 20 ether, 15 ether);

        // The read survives, and the ceiling still holds structurally.
        (uint256 reported, , uint256 avail, ) =
            _agg().getChainRecycledLedger(CHAIN_ARB);
        assertEq(reported, type(uint256).max, "ratchet took the report");
        assertLe(avail, reported, "CEILING holds at the extreme too");

        // And the day still finalizes — the whole point.
        _finalize(6);
        assertTrue(
            _agg().getChainDayRecycledFunding(6, CHAIN_ARB).stamped,
            "finalization is not wedged"
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
