// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
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
        (uint256 paid, , ) = _facet().claimInteractionRewardsTo(
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
        (uint256 paid, , ) = _facet().claimInteractionRewardsTo(
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
        (, uint256 floor4, uint256 recycled4, , ) = _agg().getDayPoolStamp(4);
        (, uint256 floor5, uint256 recycled5, , ) = _agg().getDayPoolStamp(5);
        assertGt(recycled5, 0, "armed day recycled term");

        _seedEntry(alice, 44, 4, 6); // days 4 + 5
        vm.prank(alice);
        (uint256 paid, , ) = _facet().claimInteractionRewardsTo(
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

    // ─── 4b. RL-3 expiry sweep at fresh exhaustion retires commitments ───────

    function testExpirySweepRetiresFullArmedCommitmentWhenTruncated() public {
        _cfg().setRewardClaimHorizonDays(180);
        (uint256 floor5, uint256 recycled5) = _armAndFinalize(5, 700 ether);
        assertGt(floor5, 0, "armed day has a fresh floor");

        uint256 id = _seedEntry(alice, 45, 5, 6);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        _facet().sweepExpiredInteractionRewards(ids); // stamp the clock
        // Accrue to just under the H + notice threshold, funded throughout.
        _accrueExec(ids, 180 days + 90 days - 7 days);

        // Near-exhaust the fresh pool right before the final crossing (1 wei
        // of headroom): the expiry's fresh share truncates to that sliver,
        // but the entry is terminally processed, so its ENTIRE armed fresh
        // commitment must still retire.
        _mut().setInteractionPoolPaidOut(
            LibVaipakam.VPFI_INTERACTION_POOL_CAP - 1
        );
        (, uint256 outFBefore, uint256 outRBefore, ) =
            _agg().getGovernorCommitState();

        // The final executable interval crosses H + notice → processes.
        vm.warp(vm.getBlockTimestamp() + 7 days);
        uint256 swept = _facet().sweepExpiredInteractionRewards(ids);

        assertApproxEqAbs(
            swept, recycled5 / 2, 1e6,
            "recycled share + 1 wei fresh sliver expirable at near-exhaustion"
        );
        (, uint256 outFAfter, uint256 outRAfter, ) =
            _agg().getGovernorCommitState();
        assertApproxEqAbs(
            outFBefore - outFAfter,
            floor5 / 2,
            1e6,
            "full armed fresh commitment retired despite truncation"
        );
        assertApproxEqAbs(
            outRBefore - outRAfter,
            recycled5 / 2,
            1e6,
            "recycled commitment released"
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
        uint256[] memory got = _facet().getUserRewardEntryIds(alice);
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
