// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";

import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../src/libraries/LibInteractionRewards.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";

/**
 * @title  GovernorDayPoolTest
 * @notice Governor PR-3b (#1217 §3.1) — the day-pool stamp written at
 *         finalization. Proves the ratified formula end-to-end on the real
 *         `finalizeDay` path:
 *
 *           Ā[D]           = Σ_{d∈(D−7..D]} credited[d] / 7  (zero-padded)
 *           scheduleFloor  = min(schedule, freshAvailable)
 *           recycledBudget = schedule==0 ? 0 : min(fundable, Ā×(1−m))
 *
 *         plus the snapshot discipline (a margin retune after finalization
 *         never rewrites a stamped day) and the commitment arming gate
 *         (records-only while `governorCommitArmedFromDay == 0`; armed
 *         stamps reserve into the outstanding sums).
 */
contract GovernorDayPoolTest is SetupTest {
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

    function _cfg() internal view returns (ConfigFacet) {
        return ConfigFacet(address(diamond));
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

    /// @dev Deliver full coverage for `dayId` and finalize it.
    function _finalize(uint256 dayId) internal {
        messenger.deliverChainReport(CHAIN_BASE, dayId, 10e18, 5e18);
        messenger.deliverChainReport(CHAIN_ARB, dayId, 20e18, 10e18);
        _agg().finalizeDay(dayId);
    }

    function _schedule(uint256 dayId) internal view returns (uint256) {
        return LibInteractionRewards.halfPoolForDay(dayId) * 2;
    }

    // ─── The formula ─────────────────────────────────────────────────────────

    function testStampMatchesRatifiedFormula() public {
        // Seed the bucket + one credited day inside the trailing window:
        // credited[3] = 700 VPFI → Ā[5] = 700/7 = 100 (zero-padded ÷7).
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(3, 700 ether);

        _finalize(5);

        (
            bool stamped,
            uint256 scheduleFloor,
            uint256 recycledBudget,
            uint256 aBar,
            uint256 marginBps
        ) = _agg().getDayPoolStamp(5);

        assertTrue(stamped, "stamped at finalize");
        assertEq(aBar, 100 ether, "trailing average zero-pads and divides by 7");
        assertEq(marginBps, 500, "default 5% margin stamped");
        assertEq(scheduleFloor, _schedule(5), "floor = schedule (pool untouched)");
        // recycled = min(fundable, 100 x 95%) = 95 VPFI (bucket is ample).
        assertEq(recycledBudget, 95 ether, "coupled term at 1-minus-margin");
        // Records-only: reservation is unarmed by default.
        (uint256 armed, uint256 outF, uint256 outR, ) =
            _agg().getGovernorCommitState();
        assertEq(armed, 0, "unarmed by default");
        assertEq(outF, 0, "no fresh reservation while unarmed");
        assertEq(outR, 0, "no recycled reservation while unarmed");
    }

    function testFundableClampsRecycledBudget() public {
        // Ā = 100 but the bucket holds only 30 → recycled = 30.
        _mut().setRecycleBucketRaw(30 ether);
        _mut().setRecycledCreditedByDayRaw(4, 700 ether);

        _finalize(5);

        (, , uint256 recycledBudget, , ) = _agg().getDayPoolStamp(5);
        assertEq(recycledBudget, 30 ether, "fundable (bucket) clamps the term");
    }

    function testDayZeroScheduleGatesRecycledTermOff() public {
        // Day 0 stays reward-excluded — recycling must not make day-0
        // activity rewardable (schedule==0 ⇒ recycled forced 0 too).
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(0, 7_000 ether);

        _finalize(0);

        (bool stamped, uint256 floor_, uint256 recycled, , ) =
            _agg().getDayPoolStamp(0);
        assertTrue(stamped, "day 0 still stamps (as zeros)");
        assertEq(floor_, 0, "day 0 schedule is zero");
        assertEq(recycled, 0, "coupled term gated off with the schedule");
    }

    function testMarginRetuneNeverRewritesStampedDay() public {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether);
        _finalize(5);
        (, , uint256 recycledBefore, , uint256 marginBefore) =
            _agg().getDayPoolStamp(5);
        assertEq(marginBefore, 500, "stamped at the default margin");

        // Retune to 25% — day 5 must keep its stamp; day 6 uses the new one.
        _cfg().setRecycleMarginBps(2_500);
        (, , uint256 recycledAfter, , uint256 marginAfter) =
            _agg().getDayPoolStamp(5);
        assertEq(marginAfter, 500, "stamp immutable after retune");
        assertEq(recycledAfter, recycledBefore, "recycled half unchanged");

        _mut().setRecycledCreditedByDayRaw(6, 700 ether);
        _finalize(6);
        (, , , , uint256 margin6) = _agg().getDayPoolStamp(6);
        assertEq(margin6, 2_500, "next day stamps the retuned margin");
    }

    function testFreshAvailableExhaustionZeroesFloorLeavingRecycledTerm() public {
        // Exhaust the 69M fresh pool → floor 0; the recycled term remains:
        // the promised steady state.
        _mut().setInteractionPoolPaidOut(LibVaipakam.VPFI_INTERACTION_POOL_CAP);
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether);

        _finalize(5);

        (, uint256 floor_, uint256 recycled, , ) = _agg().getDayPoolStamp(5);
        assertEq(floor_, 0, "floor zero at fresh exhaustion");
        assertEq(recycled, 95 ether, "recycled term carries the pool alone");
    }

    // ─── Commitment arming (PR-3c cutover gate) ──────────────────────────────

    function testArmedStampReservesOutstandingCommitments() public {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether);
        _mut().setGovernorCommitArmedFromDayRaw(5);

        _finalize(5);

        (, uint256 floor5, uint256 recycled5, , ) = _agg().getDayPoolStamp(5);
        (uint256 armed, uint256 outF, uint256 outR, ) =
            _agg().getGovernorCommitState();
        assertEq(armed, 5, "armed from day 5");
        // PR-3c (Codex #1315 P1): what is reserved is the CAPPED committable
        // (per-side ceil-div against the finalized denominators), which can
        // exceed the raw stamp by bounded ceil-dust (≤ sides wei-scale).
        assertApproxEqAbs(outF, floor5, 100, "fresh commitment reserved");
        assertApproxEqAbs(outR, recycled5, 100, "recycled commitment reserved");

        // The NEXT day's availability nets the day-5 reservations out:
        // fundable[6] = bucket − outR ⇒ with a tiny remaining bucket the
        // recycled term clamps to it.
        _mut().setRecycleBucketRaw(outR + 10 ether);
        _mut().setRecycledCreditedByDayRaw(6, 7_000 ether); // Ā big
        _finalize(6);
        (, , uint256 recycled6, , ) = _agg().getDayPoolStamp(6);
        assertEq(
            recycled6,
            10 ether,
            "fundable nets out prior armed commitments"
        );
    }

    // ─── #1351 (M2 PR-2, slice 2a) — D1 finalize snapshot ───────────────────

    /// @dev The load-bearing property of slice 2a: on an ARMED day, finalize
    ///      must stamp the cap MODE in the same write that disables the legacy
    ///      threshold. Setting `dayCapThreshold18 = max` (legacy cap off)
    ///      without marking the day ShareOfPool would leave the day priced by
    ///      NEITHER cap — an uncapped hole. Asserting both together is what
    ///      stops the two from drifting apart in a later refactor.
    function testArmedDayStampsShareOfPoolModeAtomicallyWithMaxThreshold()
        public
    {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setGovernorCommitArmedFromDayRaw(5);

        _finalize(5);

        assertEq(
            _mut().dayCapModeRaw(5),
            1,
            "armed day stamped ShareOfPool"
        );
        // C = sideHalf * 2000bps / 10000. sideHalf = (scheduleFloor +
        // recycledBudget) / 2 as finalized, so price the expectation off the
        // stamp rather than re-deriving the pool independently.
        (, uint256 floor5, uint256 recycled5, , ) = _agg().getDayPoolStamp(5);
        uint256 sideHalf = floor5 / 2 + recycled5 / 2;
        assertEq(
            _mut().dayUserSideCapVpfi18Raw(5),
            (sideHalf * 2000) / 10_000,
            "C = sideHalf x default 20% share"
        );
    }

    /// @dev Pre-arming days must be left on the legacy family with no D1 stamp,
    ///      so historical days keep their meaning without a migration.
    function testPreArmingDayStaysLegacyWithNoD1Stamp() public {
        _finalize(3); // unarmed (governorCommitArmedFromDay == 0)

        assertEq(_mut().dayCapModeRaw(3), 0, "unarmed day stays LegacyEthRatio");
        assertEq(
            _mut().dayUserSideCapVpfi18Raw(3),
            0,
            "no D1 ceiling stamped pre-arming"
        );
    }

    /// @dev A retune applies only to days finalized AFTER it — an already
    ///      finalized day keeps the ceiling it was stamped with, so governance
    ///      cannot retroactively reprice a past day's cap.
    function testShareCapRetuneNeverRewritesAlreadyFinalizedDay() public {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setGovernorCommitArmedFromDayRaw(5);
        _finalize(5);
        uint256 cBefore = _mut().dayUserSideCapVpfi18Raw(5);

        _cfg().setUserSideShareCapBps(500); // 5%

        assertEq(
            _mut().dayUserSideCapVpfi18Raw(5),
            cBefore,
            "finalized day keeps its stamped ceiling"
        );

        // ...but the NEXT finalized day prices off the new share.
        _finalize(6);
        (, uint256 floor6, uint256 recycled6, , ) = _agg().getDayPoolStamp(6);
        uint256 sideHalf6 = floor6 / 2 + recycled6 / 2;
        assertEq(
            _mut().dayUserSideCapVpfi18Raw(6),
            (sideHalf6 * 500) / 10_000,
            "later day prices off the retuned share"
        );
    }

    /// @dev The knob is bounded on BOTH sides; `0` is rejected so a stored `0`
    ///      unambiguously means "never configured" (a 0 share would strand
    ///      every claimant).
    function testShareCapKnobRejectsZeroAndOutOfRange() public {
        vm.expectRevert();
        _cfg().setUserSideShareCapBps(0);

        vm.expectRevert();
        _cfg().setUserSideShareCapBps(49);

        vm.expectRevert();
        _cfg().setUserSideShareCapBps(5001);

        _cfg().setUserSideShareCapBps(50); // floor accepted
        _cfg().setUserSideShareCapBps(5000); // ceiling accepted
    }

    function testPreArmingDaysNeverReserve() public {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether);
        _mut().setGovernorCommitArmedFromDayRaw(7); // arms in the future

        _finalize(5);

        (, uint256 outF, uint256 outR2, ) = _agg().getGovernorCommitState();
        // (destructure order: armedFromDay, fresh, recycled)
        assertEq(outF, 0, "pre-arming day reserves nothing (fresh)");
        assertEq(outR2, 0, "pre-arming day reserves nothing (recycled)");
    }

    // ════════════════════════════════════════════════════════════════════════
    // #1222 M3 B2-a — two-pass per-chain funding resolution (armed days)
    // ════════════════════════════════════════════════════════════════════════

    /// @dev Deliver coverage where ARB's report carries recycled figures.
    function _finalizeWithArbRecycled(
        uint256 dayId,
        uint256 arbCumulative,
        uint256 arbForDay
    ) internal {
        messenger.deliverChainReport(CHAIN_BASE, dayId, 10e18, 5e18);
        messenger.deliverChainReportRecycled(
            CHAIN_ARB, dayId, 20e18, 10e18, arbCumulative, arbForDay
        );
        _agg().finalizeDay(dayId);
    }

    /// Armed day, per-chain stamps LIVE — but the B2-b RE-SLICE defers
    /// mirror LOCAL funding to B2-d, so Base funds the WHOLE mesh budget
    /// (mirror avail = 0): each chain still gets its own funded stamp for
    /// pricing, but `recycleConsume` is 0 everywhere, no per-chain ledger is
    /// booked, and the GLOBAL reservation is the whole budget — numerically
    /// identical to the pre-mesh single-pool `min(fundable, coupled)`.
    function testArmedTwoPassFundsAllFromBaseUntilB2d() public {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether); // Ā=100, coupled=95
        _mut().setGovernorCommitArmedFromDayRaw(5);

        // ARB reports 40 recycled availability — IGNORED for funding in
        // B2-b (mirror local funding arms in B2-d).
        _finalizeWithArbRecycled(5, 40 ether, 0);

        (, , uint256 recycled5, , ) = _agg().getDayPoolStamp(5);
        LibVaipakam.ChainDayFunding memory arb =
            _agg().getChainDayRecycledFunding(5, CHAIN_ARB);
        LibVaipakam.ChainDayFunding memory base =
            _agg().getChainDayRecycledFunding(5, CHAIN_BASE);

        assertTrue(arb.stamped && base.stamped, "both chains stamped");
        // Demand weights: ARB carries 2/3 of both sides, Base 1/3.
        // coupled 95 → targets: ARB ≈ 63.33, Base ≈ 31.67 (funded via
        // Base top-up, since ARB contributes zero local availability).
        assertApproxEqAbs(
            arb.fundedLender + arb.fundedBorrower,
            63.333e18,
            1e15,
            "ARB funded to its full target (all from Base)"
        );
        assertApproxEqAbs(
            base.fundedLender + base.fundedBorrower,
            31.666e18,
            1e15,
            "Base funded its own slice"
        );
        // No local consumption instruction until B2-d.
        assertEq(arb.recycleConsume, 0, "recycleConsume deferred to B2-d");
        assertEq(base.recycleConsume, 0, "Base has no local consume either");
        assertEq(arb.keeperAllocate, 0, "keeper allocation is B2-b+");
        // Σ funded is the global stamp.
        assertApproxEqAbs(
            arb.fundedLender + arb.fundedBorrower + base.fundedLender
                + base.fundedBorrower,
            recycled5,
            2,
            "global stamp = sum of funded slices"
        );
        assertApproxEqAbs(recycled5, 95 ether, 2, "mesh total matches coupled");

        // No per-chain ledger booking; the GLOBAL outstanding reserves the
        // WHOLE budget (Phase-A') since everything is Base-funded.
        (, uint256 consumedArb, , ) = _cfg().getChainRecycledLedger(CHAIN_ARB);
        assertEq(consumedArb, 0, "no mirror-consumed booking in B2-b");
        (, , uint256 outR, ) = _agg().getGovernorCommitState();
        assertApproxEqAbs(
            outR, 95 ether, 1e6, "global outstanding = whole budget (Phase-A')"
        );
        assertEq(
            _agg().getChainOutstandingRecycledCommit(CHAIN_ARB),
            0,
            "per-chain outstanding arms in B2-d"
        );

        // Equiv halves make the per-side global-denominator math yield the
        // funded budget: equivL = fundedL x gL / chainL.
        assertApproxEqAbs(
            arb.lenderHalfEquiv,
            (arb.fundedLender * 30e18) / 20e18,
            2,
            "lender equiv half"
        );
        assertApproxEqAbs(
            arb.borrowerHalfEquiv,
            (arb.fundedBorrower * 15e18) / 10e18,
            2,
            "borrower equiv half"
        );
    }

    /// Base funds the whole mesh from its OWN availability: with a small
    /// Base bucket the total is bounded by that bucket (mirrors contribute
    /// zero local availability in B2-b).
    function testArmedTopUpDrawsFromRemainingBaseAvailabilityOnly() public {
        // Base bucket 40: its own slice ≈ 31.67 funds first; only ~8.33
        // remains to fund ARB's ~63.33 target.
        _mut().setRecycleBucketRaw(40 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether);
        _mut().setGovernorCommitArmedFromDayRaw(5);

        _finalize(5);

        LibVaipakam.ChainDayFunding memory arb =
            _agg().getChainDayRecycledFunding(5, CHAIN_ARB);
        LibVaipakam.ChainDayFunding memory base =
            _agg().getChainDayRecycledFunding(5, CHAIN_BASE);
        assertApproxEqAbs(
            base.fundedLender + base.fundedBorrower,
            31.666e18,
            1e15,
            "Base slice reserved first"
        );
        assertApproxEqAbs(
            arb.fundedLender + arb.fundedBorrower,
            8.333e18,
            1e15,
            "mirror gets only the remainder"
        );
        (, , uint256 recycled5, , ) = _agg().getDayPoolStamp(5);
        assertApproxEqAbs(recycled5, 40 ether, 2, "total bounded by real availability");
    }

    /// The Ā feed under the mesh: mirror day credits (B1 ledger) join
    /// Base's raw local series — and Base is EXCLUDED from the per-chain
    /// fold, because its own day credit is recorded in both places.
    function testTrailingAverageIncludesMirrorDayCredits() public {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        // Base local: 350 on day 4. ARB: 350 accepted for day 4 via its
        // day-close report (cumulative backs it).
        _mut().setRecycledCreditedByDayRaw(4, 350 ether);
        messenger.deliverChainReportRecycled(
            CHAIN_ARB, 4, 1e18, 0, 350 ether, 350 ether
        );

        _finalize(5);

        (, , , uint256 aBar, ) = _agg().getDayPoolStamp(5);
        assertEq(aBar, 100 ether, "(350 local + 350 mirror) / 7");
    }

    /// Unarmed days never touch the mesh machinery: no funding stamps, no
    /// per-chain reservations, Phase-A' sizing unchanged.
    function testUnarmedDayStampsNoChainFunding() public {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether);

        _finalizeWithArbRecycled(5, 40 ether, 0);

        LibVaipakam.ChainDayFunding memory arb =
            _agg().getChainDayRecycledFunding(5, CHAIN_ARB);
        assertFalse(arb.stamped, "no funding stamp pre-cutover");
        assertEq(
            _agg().getChainOutstandingRecycledCommit(CHAIN_ARB),
            0,
            "no per-chain reservation pre-cutover"
        );
        (, , uint256 recycled5, , ) = _agg().getDayPoolStamp(5);
        assertEq(recycled5, 95 ether, "Phase-A' sizing unchanged");
    }

    /// Codex #1417 r2 P1 — a chain EXCLUDED from the finalized denominator
    /// (here: ARB missing on a force-finalized day) must get ZERO halves in
    /// its funding stamp: its numerators are not in the globals, so a
    /// nonzero fresh half would let its users accrue rewards the remit
    /// sizing (inclusion-gated) will never fund. The included chain keeps
    /// its fresh floor. Fails against the unconditional-stamp code.
    function testExcludedChainGetsZeroHalvesOnForcedDay() public {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether);
        _mut().setGovernorCommitArmedFromDayRaw(5);

        // Only Base reports day 5; ARB never does — force-finalize.
        messenger.deliverChainReport(CHAIN_BASE, 5, 10e18, 5e18);
        _agg().forceFinalizeDay(5);

        LibVaipakam.ChainDayFunding memory arb =
            _agg().getChainDayRecycledFunding(5, CHAIN_ARB);
        assertTrue(arb.stamped, "excluded chain still stamped (no halt)");
        assertEq(arb.freshLenderHalf, 0, "no fresh half for an excluded chain");
        assertEq(arb.freshBorrowerHalf, 0);
        assertEq(arb.lenderHalfEquiv, 0, "no recycled slice either");
        assertEq(arb.recycleConsume, 0, "no consume instruction");

        LibVaipakam.ChainDayFunding memory base =
            _agg().getChainDayRecycledFunding(5, CHAIN_BASE);
        (, uint256 floor5, , , ) = _agg().getDayPoolStamp(5);
        assertEq(
            base.freshLenderHalf,
            floor5 / 2,
            "included chain keeps its fresh floor"
        );
    }
}
