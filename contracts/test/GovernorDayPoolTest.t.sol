// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";

import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
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

    /// Armed day, mirror with its own recycled availability: the mirror's
    /// slice funds from its OWN bucket first (`recycleConsume` = local),
    /// only the shortfall tops up from Base, Σ funded = the global stamp,
    /// and the reservations split by funding source (mirror-local into the
    /// per-chain ledger, Base-funded into the global outstanding).
    function testArmedTwoPassFundsMirrorLocallyFirst() public {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether); // Ā=100, coupled=95
        _mut().setGovernorCommitArmedFromDayRaw(5);

        // ARB has 40 VPFI of reported recycled availability.
        _finalizeWithArbRecycled(5, 40 ether, 0);

        (, , uint256 recycled5, , ) = _agg().getDayPoolStamp(5);
        LibVaipakam.ChainDayFunding memory arb =
            _agg().getChainDayRecycledFunding(5, CHAIN_ARB);
        LibVaipakam.ChainDayFunding memory base =
            _agg().getChainDayRecycledFunding(5, CHAIN_BASE);

        assertTrue(arb.stamped && base.stamped, "both chains stamped");
        // Demand weights: ARB carries 2/3 of both sides, Base 1/3.
        // coupled 95 → targets: ARB ≈ 63.33, Base ≈ 31.67.
        assertApproxEqAbs(
            arb.fundedLender + arb.fundedBorrower,
            63.333e18,
            1e15,
            "ARB funded to its full target"
        );
        assertApproxEqAbs(
            base.fundedLender + base.fundedBorrower,
            31.666e18,
            1e15,
            "Base funded its own slice"
        );
        // B2-b: `recycleConsume` is the capped-committable LOCAL share
        // (pro-rata floor of the chain's capped commit), availability-
        // trimmed — a hair under the raw 40 local funding, never over it.
        assertApproxEqAbs(
            arb.recycleConsume, 40 ether, 1e6, "mirror consumes ~its bucket"
        );
        assertLe(arb.recycleConsume, 40 ether, "never over availability");
        assertEq(arb.keeperAllocate, 0, "keeper allocation still reserved");
        // Σ funded is the global stamp.
        assertApproxEqAbs(
            arb.fundedLender + arb.fundedBorrower + base.fundedLender
                + base.fundedBorrower,
            recycled5,
            2,
            "global stamp = sum of funded slices"
        );
        assertApproxEqAbs(recycled5, 95 ether, 2, "mesh total matches coupled");

        // B2-b LIVE ledgers, split by funding source: ARB's locally-funded
        // share is booked as consumed on its per-chain ledger at
        // finalization (the broadcast instructs the mirror to surrender
        // the same figure), while the GLOBAL outstanding reserves ONLY the
        // Base-funded shares (Base's own slice + the ~23.33 top-up) — not
        // the Phase-A' whole-budget ~95.
        (, uint256 consumedArb, , ) = _cfg().getChainRecycledLedger(CHAIN_ARB);
        assertEq(
            consumedArb,
            arb.recycleConsume,
            "mirror-local share booked consumed at finalize"
        );
        (, , uint256 outR, ) = _agg().getGovernorCommitState();
        assertApproxEqAbs(
            outR,
            55 ether,
            1e6,
            "global outstanding = Base-funded shares only"
        );
        assertEq(
            _agg().getChainOutstandingRecycledCommit(CHAIN_ARB),
            0,
            "per-chain outstanding stays for B2-d in-flight reservations"
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

    /// Base tops up from its REMAINING availability only: with a small Base
    /// bucket, the top-up pool is `availBase − Base's own slice`, so mirror
    /// funding is bounded by `local + remainder` — never a double-commit of
    /// the same bucket.
    function testArmedTopUpDrawsFromRemainingBaseAvailabilityOnly() public {
        // Base bucket 40: its own slice ≈ 31.67 reserves first; only ~8.33
        // remains for ARB's ~63.33 target (ARB has zero local availability).
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

    /// B2-b LIVE across two armed days: day 5 consumes ARB's whole
    /// availability (booked on its per-chain ledger), so on day 6 the SAME
    /// reported cumulative backs nothing — ARB's slice is then entirely
    /// Base-funded (its `recycleConsume` is 0 and the global outstanding
    /// takes the whole day-6 commit). The per-chain consumption genuinely
    /// nets availability forward, never re-spending the same bucket.
    function testConsumedMirrorAvailabilityNetsOutOfNextDay() public {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether);
        _mut().setGovernorCommitArmedFromDayRaw(5);
        _finalizeWithArbRecycled(5, 40 ether, 0);

        LibVaipakam.ChainDayFunding memory arb5 =
            _agg().getChainDayRecycledFunding(5, CHAIN_ARB);
        (, uint256 consumedAfter5, uint256 availAfter5, ) =
            _cfg().getChainRecycledLedger(CHAIN_ARB);
        assertEq(consumedAfter5, arb5.recycleConsume, "day-5 local share consumed");
        assertApproxEqAbs(availAfter5, 0, 1e6, "availability nearly exhausted");

        (, , uint256 outRAfter5, ) = _agg().getGovernorCommitState();

        _mut().setRecycledCreditedByDayRaw(6, 700 ether);
        messenger.deliverChainReport(CHAIN_BASE, 6, 10e18, 5e18);
        messenger.deliverChainReportRecycled(
            CHAIN_ARB, 6, 20e18, 10e18, 40 ether, 0
        );
        _agg().finalizeDay(6);

        LibVaipakam.ChainDayFunding memory arb6 =
            _agg().getChainDayRecycledFunding(6, CHAIN_ARB);
        assertTrue(arb6.stamped, "each armed day stamps independently");
        // Reported cumulative is still 40 and 40-dust is already consumed:
        // ARB can fund almost nothing locally on day 6.
        assertApproxEqAbs(
            arb6.recycleConsume, 0, 1e6, "no local funding left on day 6"
        );
        (, uint256 consumedAfter6, , ) = _cfg().getChainRecycledLedger(CHAIN_ARB);
        assertEq(
            consumedAfter6,
            consumedAfter5 + arb6.recycleConsume,
            "consumption only advances by day-6's residual local share"
        );
        // Day 6's commit is (almost) entirely Base-funded → the global
        // outstanding grows by ~the WHOLE day-6 budget. (Day 6's coupled
        // target is 190: the 7-day Ā window now holds both 700-credits,
        // so Ā = 200 and coupled = 190.)
        (, , uint256 outRAfter6, ) = _agg().getGovernorCommitState();
        assertApproxEqAbs(
            outRAfter6 - outRAfter5,
            190 ether,
            1e6,
            "day-6 reservation lands on the global ledger"
        );
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

    /// B2-b remit netting: the remittance quote for a mirror ships ONLY the
    /// Base-funded recycled share — the mirror-locally-funded slice already
    /// sits on the mirror (surrendered at broadcast arrival). Discriminated
    /// by running the identical day twice from a snapshot: with ARB local
    /// availability the quote is smaller than without it by exactly ARB's
    /// consume figure (pre-B2-b both quotes were equal).
    function testRemitSizingShipsOnlyBaseFundedRecycledShare() public {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether);
        _mut().setGovernorCommitArmedFromDayRaw(5);
        uint256 snap = vm.snapshotState();

        // A — ARB funds 40 locally.
        _finalizeWithArbRecycled(5, 40 ether, 0);
        uint256 consumeA = _agg()
            .getChainDayRecycledFunding(5, CHAIN_ARB).recycleConsume;
        uint256[] memory dayIds = new uint256[](1);
        dayIds[0] = 5;
        (uint256 totalA, ) = RewardRemittanceFacet(address(diamond))
            .quoteRewardBudget(CHAIN_ARB, dayIds);

        // B — identical day, ARB reports no recycled availability: the
        // whole funded slice is Base-funded and ships in full.
        vm.revertToState(snap);
        _finalize(5);
        (uint256 totalB, ) = RewardRemittanceFacet(address(diamond))
            .quoteRewardBudget(CHAIN_ARB, dayIds);

        assertGt(consumeA, 0, "scenario A must have a local share");
        assertApproxEqAbs(
            totalB - totalA,
            consumeA,
            1e6,
            "remit ships the slice minus the mirror-local share"
        );
    }
}
