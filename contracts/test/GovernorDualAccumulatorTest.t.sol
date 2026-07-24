// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {RewardBroadcastV2} from "../src/interfaces/IRewardMessenger.sol";

/**
 * @title  GovernorDualAccumulatorTest
 * @notice Governor PR-3c (#1217 §3.1) — the dual fresh/recycled accumulator
 *         + consume-at-claim, end-to-end on the REAL finalize → claim path:
 *
 *           1. An armed-day claim splits fresh vs recycled: the fresh share
 *              consumes the 69M pool; the recycled share debits the bucket
 *              (`paidOutRecycled`) and retires its commitment.
 *           2. A recycled-funded FORFEIT is a pure commitment release —
 *              the bucket balance does NOT change for that share (crediting
 *              it would inflate Ā while absorbing nothing); the fresh share
 *              credits the bucket as genuine absorption.
 *           3. Fresh-pool exhaustion steady state: claims keep paying from
 *              the recycled term alone — no `InteractionPoolExhausted`.
 *           4. Mixed pre/post-cutover windows slice by construction
 *              (pre-arming days contribute zero recycled).
 *           5. The composition broadcast: a mirror stores the Base-stamped
 *              halves + arming day verbatim.
 *           6. Arming is one-shot and future-only.
 */
contract GovernorDualAccumulatorTest is SetupTest {
    MockRewardMessenger internal messenger;
    VPFIToken internal vpfi;

    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    uint256 internal constant DIAMOND_SEED = 100_000_000 ether;
    // Reports: gLender = 30e18, gBorrower = 15e18 per finalized day.
    uint256 internal constant G_LENDER = 30e18;

    address internal alice;

    function setUp() public {
        setupHelper();
        messenger = new MockRewardMessenger(address(diamond));

        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                VPFIToken.initialize,
                (address(this), address(this), address(this))
            )
        );
        vpfi = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
        uint256 have = vpfi.balanceOf(address(this));
        if (DIAMOND_SEED > have) vpfi.mint(address(this), DIAMOND_SEED - have);
        vpfi.transfer(address(diamond), DIAMOND_SEED);

        alice = makeAddr("alice");

        vm.chainId(CHAIN_BASE);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(true);
        _rep().setRewardMessenger(address(messenger));
        uint32[] memory chainIds = new uint32[](2);
        chainIds[0] = CHAIN_BASE;
        chainIds[1] = CHAIN_ARB;
        _agg().setExpectedSourceChainIds(chainIds);

        _facet().setInteractionLaunchTimestamp(block.timestamp);
        vm.warp(block.timestamp + 6 days);
    }

    function _facet() internal view returns (InteractionRewardsFacet) {
        return InteractionRewardsFacet(address(diamond));
    }

    ///  #1306 follow-up — read-only lens accessor (getters moved off
    ///      InteractionRewardsFacet into InteractionRewardsLensFacet).
    function _lens() internal view returns (InteractionRewardsLensFacet) {
        return InteractionRewardsLensFacet(address(diamond));
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

    /// @dev The cumulative claim cursor advances CONTIGUOUSLY from day 1,
    ///      so every day before the target needs its global set + cap
    ///      threshold (uncapped) — seeded via the mutator (pre-arming days
    ///      use the legacy schedule, no stamp required).
    function _seedPriorDays(uint256 uptoExclusive) internal {
        for (uint256 d = 1; d < uptoExclusive; d++) {
            _mut().setKnownGlobalDailyInterest(d, 1e18, 1e18, true);
            _mut().setDayCapThreshold18(d, type(uint256).max);
        }
    }

    function _finalize(uint256 dayId) internal {
        messenger.deliverChainReport(CHAIN_BASE, dayId, 10e18, 5e18);
        messenger.deliverChainReport(CHAIN_ARB, dayId, 20e18, 10e18);
        _agg().finalizeDay(dayId);
    }

    /// @dev Arm from `armDay`, seed bucket + trailing credits so day
    ///      `armDay`'s stamp carries a non-zero recycled budget, and
    ///      finalize it. Returns (floor, recycled) of the armed day.
    function _armAndFinalize(uint256 armDay, uint256 creditedPerWindow)
        internal
        returns (uint256 floor_, uint256 recycled)
    {
        _seedPriorDays(armDay);
        _mut().setGovernorCommitArmedFromDayRaw(armDay);
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(armDay, creditedPerWindow);
        _finalize(armDay);
        (, floor_, recycled, , ) = _agg().getDayPoolStamp(armDay);
        // #1351 slice 2c — `finalizeDay` also stamps the D1 `(user, side, day)`
        // ceiling (20% of the side half by default), and an armed day is now
        // CLAIMED through the ShareOfPool day walk that enforces it. This suite
        // is about the DUAL ACCUMULATOR — the fresh/recycled split, the bucket
        // debit and the commitment retirement — and its entries deliberately
        // sweep the WHOLE side pool, which the D1 ceiling would trim to 20%.
        //
        // Every assertion here would still pass if simply scaled by 0.2, which
        // is exactly why that is the wrong fix: the suite would keep passing
        // while silently testing two mechanisms at once, and a later change to
        // the share-cap default would break it for reasons that have nothing to
        // do with the accumulator. Neutralise the ceiling instead; it has its
        // own coverage in ShareOfPoolDayPrimitiveTest.
        _mut().setDayUserSideCapRaw(armDay, type(uint256).max);
    }

    /// @dev Lender entry sweeping the WHOLE lender side of days
    ///      `[startDay, endDayExcl)` (perDay == gLender).
    function _seedEntry(address user, uint64 loanId, uint32 startDay, uint32 endDayExcl)
        internal
        returns (uint256 id)
    {
        id = _mut().pushRewardEntry(
            user, loanId, LibVaipakam.RewardSide.Lender, G_LENDER, startDay
        );
        _mut().closeRewardEntryRaw(id, endDayExcl);
    }

    /// @dev RL-3 (Codex #1317 r7) — accrue `duration` of continuously-
    ///      executable time toward the horizon+notice threshold via ≤7-day
    ///      heartbeat sweeps. Stops early if the entry expires.
    function _accrueExec(uint256[] memory ids, uint256 duration)
        internal
        returns (uint256 swept)
    {
        uint256 remaining = duration;
        while (remaining > 0) {
            uint256 step = remaining < 7 days ? remaining : 7 days;
            vm.warp(vm.getBlockTimestamp() + step);
            uint256 s = _facet().sweepExpiredInteractionRewards(ids);
            swept += s;
            remaining -= step;
            if (s > 0) break;
        }
    }

    // ─── 1. Armed claim splits + consumes ────────────────────────────────────

    function testArmedClaimSplitsFreshAndRecycled() public {
        (uint256 floor5, uint256 recycled5) = _armAndFinalize(5, 700 ether);
        assertGt(recycled5, 0, "armed day carries a recycled term");

        _seedEntry(alice, 42, 5, 6); // exactly day 5, whole lender side
        uint256 bucketBefore = _cfg().getRecycleBucket();

        vm.prank(alice);
        (uint256 paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewardsTo(
            LibVaipakam.RewardDelivery.Wallet
        );

        // Lender-side day-5 pool = floor/2 + recycled/2 (per side).
        uint256 expectFresh = floor5 / 2;
        uint256 expectRecycled = recycled5 / 2;
        assertApproxEqAbs(
            paid, expectFresh + expectRecycled, 1e6, "paid = both halves"
        );
        // Fresh consumed the 69M pool ONLY for the fresh share.
        assertApproxEqAbs(
            _lens().getInteractionPoolPaidOut(),
            expectFresh,
            1e6,
            "pool consumed fresh share only"
        );
        // Recycled consumed the bucket + surfaced in paidOutRecycled.
        (, , uint256 outR, uint256 paidRec) = _agg().getGovernorCommitState();
        assertApproxEqAbs(paidRec, expectRecycled, 1e6, "paidOutRecycled");
        assertApproxEqAbs(
            bucketBefore - _cfg().getRecycleBucket(),
            expectRecycled,
            1e6,
            "bucket debited by the recycled payout"
        );
        // Commitments retired: recycled outstanding dropped by the payout.
        assertApproxEqAbs(
            outR,
            recycled5 - expectRecycled,
            1e6,
            "recycled commitment consumed (borrower half still outstanding)"
        );
    }

    // ─── 2. Recycled forfeit = release, not credit ───────────────────────────

    function testRecycledForfeitReleasesWithoutCredit() public {
        (uint256 floor5, uint256 recycled5) = _armAndFinalize(5, 700 ether);

        uint256 id = _seedEntry(alice, 77, 5, 6);
        _mut().setRewardEntryForfeitedRaw(id);
        _mut().setLoanActiveLenderEntryId(77, id);

        uint256 bucketBefore = _cfg().getRecycleBucket();
        (, , uint256 outRBefore, ) = _agg().getGovernorCommitState();

        vm.prank(makeAddr("keeper"));
        uint256 swept = _facet().sweepForfeitedInteractionRewards(77);

        uint256 expectFresh = floor5 / 2;
        uint256 expectRecycled = recycled5 / 2;
        assertApproxEqAbs(
            swept, expectFresh + expectRecycled, 1e6, "sweep = both halves"
        );
        // Bucket: +freshShare (genuine absorption), NOT +recycledShare.
        assertApproxEqAbs(
            _cfg().getRecycleBucket() - bucketBefore,
            expectFresh,
            1e6,
            "only the fresh share credits the bucket"
        );
        // credited[D] must exclude the recycled share too (never feeds A-bar).
        (uint256 today, ) = _lens().getInteractionCurrentDay();
        assertApproxEqAbs(
            _cfg().getRecycledCreditedByDay(today),
            expectFresh,
            1e6,
            "credited[D] carries the fresh share only"
        );
        // Recycled commitment released (not consumed): paidOutRecycled 0.
        (, , uint256 outRAfter, uint256 paidRec) =
            _agg().getGovernorCommitState();
        assertEq(paidRec, 0, "a forfeit never pays the recycled counter");
        assertApproxEqAbs(
            outRBefore - outRAfter,
            expectRecycled,
            1e6,
            "recycled commitment released"
        );
    }

    // ─── 3. Fresh exhaustion steady state ────────────────────────────────────

    function testClaimsSurviveFreshExhaustionOnRecycledTerm() public {
        // Exhaust the fresh pool BEFORE finalization: the stamp then has
        // floor 0 and the recycled term alone.
        _mut().setInteractionPoolPaidOut(LibVaipakam.VPFI_INTERACTION_POOL_CAP);
        (uint256 floor5, uint256 recycled5) = _armAndFinalize(5, 700 ether);
        assertEq(floor5, 0, "floor zero at exhaustion");
        assertGt(recycled5, 0, "recycled term alive");

        _seedEntry(alice, 43, 5, 6);
        vm.prank(alice);
        (uint256 paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewardsTo(
            LibVaipakam.RewardDelivery.Wallet
        );
        assertApproxEqAbs(
            paid, recycled5 / 2, 1e6,
            "recycled term pays alone - the steady state"
        );
        assertEq(vpfi.balanceOf(alice), paid, "tokens delivered");
    }

    // ─── 4. Mixed pre/post-cutover window ────────────────────────────────────

    function testMixedWindowSlicesAtArmingDay() public {
        // Days 4 (pre-arming) and 5 (armed): entry spans both.
        _seedPriorDays(4);
        _mut().setGovernorCommitArmedFromDayRaw(5);
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setRecycledCreditedByDayRaw(4, 700 ether);
        _mut().setRecycledCreditedByDayRaw(5, 700 ether);
        _finalize(4);
        _finalize(5);
        // #1351 slice 2c — neutralise day 5's D1 ceiling for the same reason as
        // {_armAndFinalize}: this test is about the pre/post-arming SLICE, and
        // the entry deliberately sweeps the whole lender side. Day 4 needs no
        // override — it is pre-arming, so it is paid by the O(1) window product
        // and the D1 ceiling does not apply to it at all.
        _mut().setDayUserSideCapRaw(5, type(uint256).max);
        (, uint256 floor4, uint256 recycled4, , ) = _agg().getDayPoolStamp(4);
        (, uint256 floor5, uint256 recycled5, , ) = _agg().getDayPoolStamp(5);
        assertGt(recycled5, 0, "armed day recycled term");

        _seedEntry(alice, 44, 4, 6); // days 4 + 5
        vm.prank(alice);
        (uint256 paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewardsTo(
            LibVaipakam.RewardDelivery.Wallet
        );

        // Day 4 (pre-arming): schedule-only, no recycled. Day 5: both halves.
        assertApproxEqAbs(
            paid,
            floor4 / 2 + floor5 / 2 + recycled5 / 2,
            1e6,
            "pre-arming day contributes schedule only"
        );
        // Day 4's STAMP still records the formula value (PR-3b records-only
        // semantics) — but being pre-arming, the accumulator ignored it:
        // the paid assertion above proves no recycled4 payout happened.
        assertGt(recycled4, 0, "pre-arming stamp records the formula value");
        (, , , uint256 paidRec) = _agg().getGovernorCommitState();
        assertApproxEqAbs(
            paidRec, recycled5 / 2, 1e6, "recycled consumption = armed day only"
        );
    }

    // ─── 4b. RL-3 expiry is ALL-OR-NOTHING (no partial-credit reap) ──────────

    function testExpiryIsAllOrNothingAtNearExhaustion() public {
        _cfg().setRewardClaimHorizonDays(180);
        (uint256 floor5, uint256 recycled5) = _armAndFinalize(5, 700 ether);
        assertGt(floor5, 0, "armed day has a fresh floor");

        uint256 id = _seedEntry(alice, 45, 5, 6);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        _facet().sweepExpiredInteractionRewards(ids); // stamp the clock
        // Accrue to just under the H + notice threshold, funded throughout.
        _accrueExec(ids, 180 days + 90 days - 7 days);

        // Near-exhaust the fresh pool (1 wei of headroom) so the entry's fresh
        // share does NOT fully fit. ALL-OR-NOTHING (Codex #1317): the sweep
        // DEFERS the whole entry — it never partial-credits a sliver and drops
        // the uncreditable remainder, which would silently reap the claimant.
        _mut().setInteractionPoolPaidOut(
            LibVaipakam.VPFI_INTERACTION_POOL_CAP - 1
        );
        (, uint256 outFBefore, uint256 outRBefore, ) =
            _agg().getGovernorCommitState();

        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertEq(
            _facet().sweepExpiredInteractionRewards(ids),
            0,
            "near-exhaustion defers the whole entry, never partial-credits"
        );
        (, uint256 outFMid, uint256 outRMid, ) = _agg().getGovernorCommitState();
        assertEq(outFBefore, outFMid, "armed fresh commitment untouched by defer");
        assertEq(outRBefore, outRMid, "recycled commitment untouched by defer");

        // Restore full pool headroom → the entry expires FULLY: the WHOLE
        // fresh share credits and the full armed fresh + recycled commitments
        // retire (no remainder ever dropped).
        _mut().setInteractionPoolPaidOut(0);
        uint256 swept = _facet().sweepExpiredInteractionRewards(ids);
        assertApproxEqAbs(
            swept,
            floor5 / 2 + recycled5 / 2,
            1e6,
            "full fresh + recycled expirable once headroom is restored"
        );
        (, uint256 outFAfter, uint256 outRAfter, ) =
            _agg().getGovernorCommitState();
        assertApproxEqAbs(
            outFBefore - outFAfter, floor5 / 2, 1e6, "full armed fresh retired"
        );
        assertApproxEqAbs(
            outRBefore - outRAfter, recycled5 / 2, 1e6, "recycled released"
        );
    }

    /// @dev #1351 slice 2d — the expiry sweep prices the REMAINING window
    ///      (the core prices from the claim cursor), so:
    ///
    ///      1. A FULLY walked entry (`cursor == endDay`) has nothing left —
    ///         the sweep credits 0 and never re-recycles the walked days.
    ///      2. A PART-claimed spanning entry is reaped for EXACTLY its
    ///         unsettled suffix — proven by a TWIN: bob's armed-only entry
    ///         over the identical remaining day, never touched by a walk,
    ///         must reap the identical credit.
    ///
    ///      Discrimination on the twin equality: the pre-2d whole-window
    ///      sweep fails it HIGH (alice's reap re-credits her settled day 4);
    ///      the interim #1408 part-claimed stopgap fails it at ZERO (no reap
    ///      at all). Either failure flags a regression on this boundary.
    function testExpiryReapsExactlyTheRemainingWindow() public {
        _cfg().setRewardClaimHorizonDays(180);
        (uint256 floor5, ) = _armAndFinalize(5, 700 ether);
        assertGt(floor5, 0, "armed day has a fresh floor");

        // Case 1 — fully walked: nothing remains, nothing is credited.
        uint256 walked = _seedEntry(alice, 47, 5, 6);
        uint256[] memory one = new uint256[](1);
        one[0] = walked;
        _facet().sweepExpiredInteractionRewards(one); // stamp the clock
        _accrueExec(one, 180 days + 90 days - 7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        _mut().setInteractionPoolPaidOut(0);
        _mut().setRewardEntryClaimNextDayRaw(walked, 6);
        assertEq(
            _facet().sweepExpiredInteractionRewards(one),
            0,
            "a fully walked entry has no remaining value to reap"
        );

        // Case 2 — part-claimed spanning entry vs its armed-only twin.
        address bob = makeAddr("suffixTwin");
        uint256 spanning = _seedEntry(alice, 48, 4, 6); // day 4 legacy + day 5
        uint256 twin = _seedEntry(bob, 49, 5, 6); //      day 5 only
        // A chunked claim settled alice's legacy slice; the cursor write IS
        // the record — her remaining window is exactly bob's whole window.
        _mut().setRewardEntryClaimNextDayRaw(spanning, 5);

        uint256[] memory pair = new uint256[](2);
        pair[0] = spanning;
        pair[1] = twin;
        _facet().sweepExpiredInteractionRewards(pair); // stamp both clocks
        _accrueExec(pair, 180 days + 90 days - 7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        uint256[] memory a = new uint256[](1);
        a[0] = spanning;
        uint256[] memory b = new uint256[](1);
        b[0] = twin;
        uint256 creditSpanning = _facet().sweepExpiredInteractionRewards(a);
        uint256 creditTwin = _facet().sweepExpiredInteractionRewards(b);
        assertGt(creditTwin, 0, "the twin's armed day is genuinely reapable");
        assertEq(
            creditSpanning,
            creditTwin,
            "a part-claimed entry reaps EXACTLY its remaining window"
        );
    }

    /// @dev Codex #1410 r4 — the expiry clock PAUSES through a recycled-
    ///      bucket drought. The walk defers a recycled-short day WHOLE (fresh
    ///      included), the claim then reverts, and a gate that still counted
    ///      the entry payable would accrue — and, once the bucket refills,
    ///      instantly reap — a reward its owner genuinely could not collect
    ///      during the drought. Against the pre-fix gate the final assert
    ///      fails with an instant nonzero reap.
    function testCountdownPausesThroughRecycledBucketDrought() public {
        _cfg().setRewardClaimHorizonDays(180);
        (, uint256 recycled5) = _armAndFinalize(5, 700 ether);
        assertGt(recycled5, 0, "day carries a recycled component");

        uint256 id = _seedEntry(alice, 50, 5, 6);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        _facet().sweepExpiredInteractionRewards(ids); // stamp the clock

        // DROUGHT: drain the bucket, then serve MORE than the whole
        // window + notice under heartbeat sweeps.
        _mut().setRecycleBucketRaw(0);
        assertEq(
            _accrueExec(ids, 180 days + 90 days + 14 days),
            0,
            "nothing reaps during the drought"
        );

        // Bucket refills: no time may have accrued through the drought, so
        // there must be NO instant reap — the window has to be re-served.
        _mut().setRecycleBucketRaw(1_000_000 ether);
        assertEq(
            _facet().sweepExpiredInteractionRewards(ids),
            0,
            "no instant reap after the drought - the clock was paused"
        );
    }

    /// @dev Codex #1410 r8 P1 — the drought sum must use the RAW recycled
    ///      share: the loan-side cap is fresh-first over the aggregate
    ///      window, so a capped entry's CAPPED recycled can read 0 while the
    ///      per-day walk still draws the bucket on its first day — a
    ///      capped-sum gate fails open and accrues (and reaps) through the
    ///      drought. Raw >= any actual cumulative walk draw, so the raw gate
    ///      can never fail open; over-detection only pauses (safe).
    function testDroughtGateUsesRawRecycledUnderLoanSideCap() public {
        _cfg().setRewardClaimHorizonDays(180);
        (uint256 floor5, uint256 recycled5) = _armAndFinalize(5, 700 ether);
        assertGt(recycled5, 0, "day 5 carries a recycled component");

        uint256 id = _seedEntry(alice, 57, 5, 6);
        // Cap small enough that the aggregate fresh-first trim consumes the
        // whole headroom from fresh alone: the CAPPED recycled share reads 0
        // while the raw recycled share stays nonzero.
        _mut().setFeeEntitlementRaw(
            57,
            LibVaipakam.FeeEntitlement({
                borrowerMode: LibVaipakam.FeeEntitlementMode.None,
                lenderMode: LibVaipakam.FeeEntitlementMode.None,
                openDays: 1,
                rewardHaircutBpsAtOpen: 0,
                borrowerTariffPaid: 0,
                lenderTariffPaid: 0,
                cStarOpen: 0,
                loanSideRewardCapOpen: uint128(floor5 / 8)
            })
        );
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        _facet().sweepExpiredInteractionRewards(ids); // stamp the clock

        _mut().setRecycleBucketRaw(0); // drought
        assertEq(
            _accrueExec(ids, 180 days + 90 days + 14 days),
            0,
            "nothing reaps during the drought"
        );
        _mut().setRecycleBucketRaw(1_000_000 ether);
        assertEq(
            _facet().sweepExpiredInteractionRewards(ids),
            0,
            "no instant reap after refill - the clock was paused"
        );
    }

    /// @dev Codex #1410 r7 P1 — the sweep must ADVANCE the user's cursors
    ///      before testing the aggregate drought. A longer sibling whose last
    ///      day is not yet advanced-through prices 0 in the upper bound, so a
    ///      pre-advance drought test misses its recycled draw on the first
    ///      touch after that day finalizes and credits an interval the real
    ///      claim (advance first, then defer the joint day) could not serve.
    ///      Against the pre-fix ordering this fails by crediting + reaping on
    ///      that touch; the follow-up refill assert catches even a
    ///      backing-deferred variant of the same credit.
    function testDroughtGateAdvancesCursorsFirst() public {
        _cfg().setRewardClaimHorizonDays(180);
        (, uint256 recycled5) = _armAndFinalize(5, 700 ether);
        assertGt(recycled5, 0, "day 5 carries a recycled component");

        uint256 shorter = _seedEntry(alice, 55, 5, 6);
        uint256 longer = _seedEntry(alice, 56, 5, 7); // day 6 unfinalized yet
        uint256[] memory ids = new uint256[](2);
        ids[0] = shorter;
        ids[1] = longer;
        _facet().sweepExpiredInteractionRewards(ids); // stamp the clocks

        // Bucket covers the shorter's day-5 slice alone, not the joint draw.
        uint256 each = recycled5 / 2;
        _mut().setRecycleBucketRaw(each + each / 2);

        // LEGITIMATE accrual to just under the threshold: with day 6 not yet
        // finalized the longer sibling prices 0 for claim and gate alike, so
        // the bucket genuinely covers everything payable and the claim works.
        _accrueExec(ids, 180 days + 90 days - 7 days);

        // Day 6 finalizes mid-drought: the sibling's recycled draw now
        // exists, but only an ADVANCE reveals it to the gate.
        _mut().setRecycledCreditedByDayRaw(6, 700 ether);
        _finalize(6);
        _mut().setDayUserSideCapRaw(6, type(uint256).max);

        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertEq(
            _facet().sweepExpiredInteractionRewards(ids),
            0,
            "the touch advances, sees the joint drought, and pauses - no reap"
        );

        // The drought interval must never have been credited: even with the
        // bucket refilled, the window still has to be finished the honest way.
        _mut().setRecycleBucketRaw(1_000_000 ether);
        assertEq(
            _facet().sweepExpiredInteractionRewards(ids),
            0,
            "no instant reap after refill - the drought interval was dropped"
        );
    }

    /// @dev Codex #1410 r6 — the drought gate is AGGREGATE: two same-day
    ///      recycled entries whose bucket covers EACH alone but not BOTH
    ///      still defer jointly (the walk's per-day check is against the
    ///      user's joint draw), so the clock must pause for both. Against the
    ///      per-entry gate this fails with an instant post-refill reap.
    function testDroughtGateIsAggregateAcrossEntries() public {
        _cfg().setRewardClaimHorizonDays(180);
        (, uint256 recycled5) = _armAndFinalize(5, 700 ether);
        assertGt(recycled5, 0, "day carries a recycled component");

        uint256 a = _seedEntry(alice, 51, 5, 6);
        uint256 b = _seedEntry(alice, 52, 5, 6);
        uint256[] memory ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
        _facet().sweepExpiredInteractionRewards(ids); // stamp both clocks

        // Bucket covers each entry's recycled slice alone, NOT both: the
        // joint day defers, the claim reverts, both clocks must pause.
        uint256 each = recycled5 / 2; // two equal-perDay entries split the day
        _mut().setRecycleBucketRaw(each + each / 2);
        assertEq(
            _accrueExec(ids, 180 days + 90 days + 14 days),
            0,
            "nothing reaps while the JOINT draw exceeds the bucket"
        );

        _mut().setRecycleBucketRaw(1_000_000 ether);
        assertEq(
            _facet().sweepExpiredInteractionRewards(ids),
            0,
            "no instant reap after the drought - both clocks were paused"
        );
    }

    /// @dev #1351 — `_userForfeitFresh` sums FORFEITED entries at their
    ///      whole-window fresh face value to size the aggregate claim funding
    ///      need. Once a chunked claim settles a forfeited entry's pre-`D*`
    ///      legacy slice to treasury — recorded by the FIRST write of
    ///      `rewardEntryClaimNextDay`, there is deliberately no separate
    ///      marker (2d-0 Deliverable 2) — counting that slice a second time
    ///      OVERSTATES the need, which makes `_entryExecutableNow` read false
    ///      and silently pauses the expiry accrual clock. Nothing reverts, so
    ///      only the number itself shows it.
    ///
    ///      Found by sweeping every caller of the window split rather than by
    ///      review: this function is not in the slice's diff — the slice
    ///      changed the invariants it depends on, not its text.
    function testForfeitFundingNeedDropsTheAlreadySettledLegacySlice() public {
        _armAndFinalize(5, 700 ether);
        // Entry spans day 4 (pre-`D*`, legacy) + day 5 (armed), and is forfeited.
        uint256 id = _seedEntry(alice, 48, 4, 6);
        _mut().setRewardEntryForfeitedRaw(id);

        uint256 needBefore = _mut().userClaimFundingNeedRaw(alice);
        assertGt(needBefore, 0, "an unsettled forfeited entry needs funding");

        // A chunked claim settles the legacy slice; the cursor write IS the
        // settlement record (walk starts at `D*` = day 5).
        _mut().setRewardEntryClaimNextDayRaw(id, 5);

        uint256 needAfter = _mut().userClaimFundingNeedRaw(alice);
        assertLt(
            needAfter,
            needBefore,
            "settled legacy slice must stop counting toward the funding need"
        );
    }

    // ─── 4c. RL-3 Codex r2 — zero-credit expiry defers, never burns ──────────

    function testExpirySweepDefersAtFullFreshExhaustion() public {
        _cfg().setRewardClaimHorizonDays(180);
        (uint256 floor5, ) = _armAndFinalize(5, 700 ether);
        assertGt(floor5, 0, "entry carries a fresh share");

        uint256 id = _seedEntry(alice, 46, 5, 6);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        _facet().sweepExpiredInteractionRewards(ids); // stamp the clock
        // Accrue to just under the H + notice threshold, funded throughout.
        _accrueExec(ids, 180 days + 90 days - 7 days);

        // FULL fresh exhaustion: expiring now would credit the bucket
        // nothing for the fresh share — the entry must be DEFERRED (stay
        // live), not processed with its value silently burned.
        _mut().setInteractionPoolPaidOut(
            LibVaipakam.VPFI_INTERACTION_POOL_CAP
        );
        (, uint256 outFBefore, , ) = _agg().getGovernorCommitState();
        // The final executable interval crosses H + notice, but the fresh
        // share can't be credited (pool exhausted) → deferred, not burned.
        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertEq(
            _facet().sweepExpiredInteractionRewards(ids),
            0,
            "zero-credit expiry deferred"
        );
        (, uint256 outFAfter, , ) = _agg().getGovernorCommitState();
        assertEq(outFBefore, outFAfter, "commitments untouched by a defer");
        // The id surface keepers/UI drive this from is enumerable on-chain.
        uint256[] memory got = _lens().getUserRewardEntryIds(alice);
        assertEq(got.length, 1, "id enumeration exposed");
        assertEq(got[0], id, "id matches the entry");
    }

    // ─── 5. Composition broadcast to a mirror ────────────────────────────────

    function testMirrorStoresBroadcastCompositionAndArming() public {
        // Stand the diamond up as a MIRROR and deliver a full-shape packet.
        vm.chainId(CHAIN_ARB);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(false);
        _rep().setRewardMessenger(address(messenger));

        messenger.deliverBroadcastWithComposition(
            7, 30e18, 15e18, type(uint256).max,
            /* scheduleFloorHalf */ 100 ether,
            /* recycledHalf */ 9 ether,
            /* armedFromDay */ 7
        );

        (bool stamped, uint256 floor7, uint256 recycled7, , ) =
            _agg().getDayPoolStamp(7);
        assertTrue(stamped, "mirror stamped from the broadcast");
        assertEq(floor7, 200 ether, "floor = 2x half");
        assertEq(recycled7, 18 ether, "recycled = 2x half");
        (uint256 armed, , , ) = _agg().getGovernorCommitState();
        assertEq(armed, 7, "arming day travels in-band");
    }

    /// #1222 M3 B2-b — a MIRROR's recycled claim legs never debit its local
    /// bucket: the bucket surrendered its instructed slice ONCE at V2
    /// arrival; claim funding beyond that is remitted (and counted). The
    /// pre-B2-b behaviour debited the full recycled payout at claim, which
    /// silently drained the mirror bucket for value Base had already
    /// accounted — this test fails against that code on both assertions.
    function testMirrorClaimSkipsLocalBucketDebit() public {
        vm.chainId(CHAIN_ARB);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(false);
        _rep().setRewardMessenger(address(messenger));

        _seedPriorDays(5);
        _mut().setGovernorCommitArmedFromDayRaw(5);
        _mut().setRecycleBucketRaw(1_000 ether);

        messenger.deliverBroadcastV2(
            RewardBroadcastV2({
                dayId: 5,
                globalLenderNumeraire18: G_LENDER,
                globalBorrowerNumeraire18: 15e18,
                capMode: 1, // ShareOfPool
                // Neutralise the D1 ceiling — same rationale as
                // {_armAndFinalize}'s cap seed: this test is about the
                // bucket, not the share cap.
                capPayloadLender: type(uint256).max,
                capPayloadBorrower: type(uint256).max,
                armedFromDay: 5,
                freshLenderHalf: 100 ether,
                freshBorrowerHalf: 100 ether,
                recycledLenderHalfEquiv: 50 ether,
                recycledBorrowerHalfEquiv: 50 ether,
                recycleConsume: 30 ether,
                keeperAllocate: 0,
                destChainId: CHAIN_ARB
            })
        );
        assertEq(
            _cfg().getRecycleBucket(),
            970 ether,
            "arrival surrenders exactly the instructed slice"
        );

        _seedEntry(alice, 42, 5, 6); // whole lender side of day 5

        vm.prank(alice);
        (uint256 paid, , ) = RewardClaimFacet(address(diamond))
            .claimInteractionRewardsTo(LibVaipakam.RewardDelivery.Wallet);

        assertApproxEqAbs(
            paid, 150 ether, 1e6, "fresh 100 + recycled 50 lender halves"
        );
        assertEq(
            _cfg().getRecycleBucket(),
            970 ether,
            "the claim never touches the mirror bucket"
        );
        assertApproxEqAbs(
            _agg().getMirrorRemitFundedRecycledPaid(),
            50 ether,
            1e6,
            "skipped debit stays visible for reconciliation"
        );
    }

    /// Codex #1417 r3 — the walk's recycled DEFER gate must not price a
    /// MIRROR's claims against its local bucket: after consume-on-arrival
    /// drains it, the bucket is not the funding source (the surrendered
    /// slice + remittances are). Here the arrival surrender takes the
    /// bucket to ZERO and the claim must still pay in full — against the
    /// pre-fix code the recycled legs defer forever on the empty bucket.
    function testMirrorClaimPaysWithBucketDrainedToZero() public {
        vm.chainId(CHAIN_ARB);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(false);
        _rep().setRewardMessenger(address(messenger));

        _seedPriorDays(5);
        _mut().setGovernorCommitArmedFromDayRaw(5);
        _mut().setRecycleBucketRaw(30 ether);

        messenger.deliverBroadcastV2(
            RewardBroadcastV2({
                dayId: 5,
                globalLenderNumeraire18: G_LENDER,
                globalBorrowerNumeraire18: 15e18,
                capMode: 1,
                capPayloadLender: type(uint256).max,
                capPayloadBorrower: type(uint256).max,
                armedFromDay: 5,
                freshLenderHalf: 100 ether,
                freshBorrowerHalf: 100 ether,
                recycledLenderHalfEquiv: 50 ether,
                recycledBorrowerHalfEquiv: 50 ether,
                recycleConsume: 30 ether, // the WHOLE bucket
                keeperAllocate: 0,
                destChainId: CHAIN_ARB
            })
        );
        assertEq(_cfg().getRecycleBucket(), 0, "bucket fully surrendered");

        _seedEntry(alice, 43, 5, 6);

        vm.prank(alice);
        (uint256 paid, , ) = RewardClaimFacet(address(diamond))
            .claimInteractionRewardsTo(LibVaipakam.RewardDelivery.Wallet);

        assertApproxEqAbs(
            paid,
            150 ether,
            1e6,
            "recycled legs pay despite the drained bucket"
        );
        assertEq(_cfg().getRecycleBucket(), 0, "bucket untouched by the claim");
    }

    // ─── 6. Arming guards ────────────────────────────────────────────────────

    function testArmingIsFutureOnlyAndOneShot() public {
        (uint256 today, ) = _lens().getInteractionCurrentDay();
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardAggregatorFacet.GovernorArmingDayNotFuture.selector,
                today,
                today
            )
        );
        _agg().setGovernorCommitArmedFromDay(today);

        _agg().setGovernorCommitArmedFromDay(today + 2);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardAggregatorFacet.GovernorAlreadyArmed.selector,
                today + 2
            )
        );
        _agg().setGovernorCommitArmedFromDay(today + 3);
    }
}
