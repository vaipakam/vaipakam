// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {RewardHorizonSweepFacet} from "../src/facets/RewardHorizonSweepFacet.sol";
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
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

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
    /// @dev Mirror of the library signal, for `vm.expectEmit`.
    event RewardEntryExpiryBegun(uint256 indexed entryId, address indexed user);

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

    /// @dev #1434 — the claim-horizon sweep is hosted on its OWN facet,
    ///      {RewardHorizonSweepFacet}: once expiry began settling through the
    ///      ShareOfPool engine, neither InteractionRewardsFacet nor
    ///      RewardClaimFacet had the EIP-170 headroom to carry it. Same Diamond
    ///      address and same 4-byte selector throughout — only the facet that
    ///      serves it moved — so this accessor exists purely to give the test
    ///      the right compile-time type.
    function _sweeper() internal view returns (RewardHorizonSweepFacet) {
        return RewardHorizonSweepFacet(address(diamond));
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
        // #1222 M3 B2-c — armed-day finalization additionally requires the
        // mirror's commitments to be complete (report deferred to B2-d; set
        // the gate flag directly; inert unarmed).
        _mut().setChainDayCommitmentCompleteRaw(dayId, CHAIN_ARB, true);
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
            uint256 s = _sweeper().sweepExpiredInteractionRewards(ids);
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

    /// @dev #1434 P1-b (Codex #1699 r5 P2, reshaped by r18) — the mirror
    ///      bound is charged by the ARMED fresh that actually moved, never
    ///      by the unarmed (legacy) fresh. Under the engine the two legs
    ///      settle in separate chunks, so the property is now directly
    ///      observable per chunk instead of inferred from a pro-rata of a
    ///      clamped aggregate: the legacy chunk charges NOTHING, and the
    ///      armed chunk charges exactly its own credited fresh.
    function testP1bForfeitSweepChargesArmedPortionOfWhatItSpent() public {
        // Arm + finalize while still CANONICAL — finalization is Base-only.
        (uint256 floor5, uint256 recycled5) = _armAndFinalize(5, 700 ether);

        vm.chainId(CHAIN_ARB);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(false);
        _mut().setChainDayFundingRaw(
            5, uint32(CHAIN_ARB), floor5 / 2, recycled5 / 2
        );

        // MIXED ARMING — legacy day 4 + armed day 5, so the two legs are
        // genuinely distinct quantities.
        uint256 id = _seedEntry(alice, 77, 4, 6);
        _mut().setRewardEntryForfeitedRaw(id);
        _mut().setLoanActiveLenderEntryId(77, id);
        _mut().setArmedFreshLedgerRaw(1_000_000 ether, 0);

        // Chunk 1: the LEGACY leg settles and stamps the cursor. Pre-arming
        // fresh was never delivered, so it must charge the bound NOTHING.
        vm.prank(makeAddr("keeper"));
        uint256 legacySwept = _facet().sweepForfeitedInteractionRewards(77);
        assertGt(legacySwept, 0, "LIVE: the legacy leg settles");
        assertEq(
            _mut().getArmedFreshPaidRaw(),
            0,
            "the unarmed leg never charges the delivered bound"
        );
        assertFalse(
            _mut().getRewardEntryProcessedRaw(id),
            "LIVE: the armed tail is still owed"
        );

        // Chunk 2: the ARMED day settles through the engine and charges the
        // bound by exactly what it credited.
        vm.prank(makeAddr("keeper"));
        uint256 armedSwept = _facet().sweepForfeitedInteractionRewards(77);
        assertGt(armedSwept, 0, "LIVE: the armed day settles");
        uint256 paid = _mut().getArmedFreshPaidRaw();
        assertGt(paid, 0, "the armed chunk charges the bound");
        assertLe(
            paid,
            armedSwept,
            "and by no more than what that chunk actually moved"
        );
        assertTrue(
            _mut().getRewardEntryProcessedRaw(id),
            "and the entry terminalises once both legs settled"
        );
    }

    /// @dev #1434 P1-b (Codex #1699 r2 P1, reshaped by r18) — a mirror
    ///      forfeit whose armed fresh is undelivered must not spend it. The
    ///      r2 shape was a whole-sweep revert; the engine's shape (r18) is a
    ///      PER-DAY DEFER: the sweep returns zero progress, every ledger is
    ///      untouched, the entry stays intact, and the SAME call succeeds
    ///      once funding lands. Same guarantee — no unbacked armed spend —
    ///      now with partial progress preserved on multi-day entries.
    function testP1bForfeitSweepRefusesWhenDeliveredIsShort() public {
        (uint256 floor5, uint256 recycled5) = _armAndFinalize(5, 700 ether);

        vm.chainId(CHAIN_ARB);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(false);
        _mut().setChainDayFundingRaw(
            5, uint32(CHAIN_ARB), floor5 / 2, recycled5 / 2
        );

        uint256 id = _seedEntry(alice, 77, 5, 6);
        _mut().setRewardEntryForfeitedRaw(id);
        _mut().setLoanActiveLenderEntryId(77, id);

        // Nothing delivered: the armed fresh this sweep would spend is
        // entirely unbacked.
        _mut().setArmedFreshLedgerRaw(0, 0);

        uint256 bucketBefore = _cfg().getRecycleBucket();

        vm.prank(makeAddr("keeper"));
        uint256 swept0 = _facet().sweepForfeitedInteractionRewards(77);
        assertEq(swept0, 0, "an unfunded armed day DEFERS - nothing settles");
        assertEq(
            _cfg().getRecycleBucket(),
            bucketBefore,
            "a deferred sweep absorbs nothing"
        );
        assertEq(
            _mut().getArmedFreshPaidRaw(), 0, "and charges the bound nothing"
        );
        assertFalse(
            _mut().getRewardEntryProcessedRaw(id),
            "LIVE: the entry is intact, not consumed"
        );

        // FUNDED: the same call now succeeds, so the refusal was a wait and
        // the entry was genuinely left intact rather than consumed.
        _mut().setArmedFreshLedgerRaw(100_000 ether, 0);
        vm.prank(makeAddr("keeper"));
        uint256 swept = _facet().sweepForfeitedInteractionRewards(77);
        assertGt(swept, 0, "the same sweep succeeds once funding lands");
        assertGt(
            _mut().getArmedFreshPaidRaw(),
            0,
            "and only then charges the delivered bound"
        );
    }

    /// @dev #1434 P1-b (Codex #1699 r2 P1) — the one-shot pre-P1-b paid-side
    ///      seed, and its refusal to run twice.
    ///
    ///      An in-place-upgraded mirror already holds deliveries in the
    ///      RECEIVED counter for compensated / short-lapsed days that were
    ///      payable before this slice, while the paid counter starts at zero.
    ///      Unseeded, that already-spent funding reads as available. The seed
    ///      is one-shot because it ADDS: a second call would double-charge the
    ///      bound and strand funding that was never spent.
    function testP1bSeedArmedFreshPaidIsOneShot() public {
        vm.chainId(CHAIN_ARB);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(false);

        // Pre-upgrade shape: delivery recorded, paid side still at zero.
        _mut().setArmedFreshLedgerRaw(1_000 ether, 0);
        (, uint256 beforeSeed) = RewardRemittanceLensFacet(address(diamond)).getDeliveredFreshBound();
        assertEq(beforeSeed, 1_000 ether, "LIVE: unseeded reads fully available");

        _rep().seedArmedFreshPaid(400 ether);

        (uint256 paid, uint256 remaining) = RewardRemittanceLensFacet(address(diamond)).getDeliveredFreshBound();
        assertEq(paid, 400 ether, "the seed lands on the paid side");
        assertEq(remaining, 600 ether, "and the bound shrinks by exactly that");

        // One-shot: a second call must refuse rather than add again.
        vm.expectRevert(IVaipakamErrors.ArmedFreshPaidAlreadySeeded.selector);
        _rep().seedArmedFreshPaid(1 ether);

        (, uint256 after_) = RewardRemittanceLensFacet(address(diamond)).getDeliveredFreshBound();
        assertEq(after_, 600 ether, "a refused re-seed changes nothing");
    }

    /// @dev #1434 P1-b (Codex #1699 r2 P2, reshaped by r18) — near 69M
    ///      exhaustion the sweep settles what fits and charges the bound by
    ///      the CREDITED figure, never the nominal one. The engine truncates
    ///      the armed day's fresh via `cappedOff` (monotone budget), still
    ///      advances, and charges delivered funding only for what moved.
    function testP1bSweepSucceedsWhenPostCapChargeFits() public {
        (uint256 floor5, uint256 recycled5) = _armAndFinalize(5, 700 ether);

        vm.chainId(CHAIN_ARB);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(false);
        _mut().setChainDayFundingRaw(
            5, uint32(CHAIN_ARB), floor5 / 2, recycled5 / 2
        );

        uint256 id = _seedEntry(alice, 77, 4, 6);
        _mut().setRewardEntryForfeitedRaw(id);
        _mut().setLoanActiveLenderEntryId(77, id);
        _mut().setArmedFreshLedgerRaw(1_000_000 ether, 0);

        // Measure the UNCLAMPED armed charge first (both chunks, abundant).
        uint256 snap = vm.snapshotState();
        vm.prank(makeAddr("keeper"));
        _facet().sweepForfeitedInteractionRewards(77);
        vm.prank(makeAddr("keeper"));
        uint256 full = _facet().sweepForfeitedInteractionRewards(77);
        uint256 nominalArmed = _mut().getArmedFreshPaidRaw();
        vm.revertToState(snap);
        assertGt(full, 0, "LIVE: the armed day genuinely sweeps");
        assertGt(nominalArmed, 0, "LIVE: and it carries an armed charge");

        // Settle the legacy leg with the pool open, then SQUEEZE the 69M
        // headroom to a sliver of the armed charge.
        vm.prank(makeAddr("keeper"));
        _facet().sweepForfeitedInteractionRewards(77);
        uint256 sliver = nominalArmed / 4;
        _mut().setInteractionPoolPaidOut(
            LibVaipakam.VPFI_INTERACTION_POOL_CAP - sliver
        );

        // The armed chunk still settles — the cap trim is terminal, not a
        // wedge — and charges the bound by the truncated figure only.
        vm.prank(makeAddr("keeper"));
        uint256 swept = _facet().sweepForfeitedInteractionRewards(77);
        assertGt(swept, 0, "a cap-truncated forfeit still settles");
        uint256 paid = _mut().getArmedFreshPaidRaw();
        assertLt(
            paid,
            nominalArmed,
            "and the bound is charged the CREDITED figure, not the nominal"
        );
        assertTrue(
            _mut().getRewardEntryProcessedRaw(id),
            "and the entry terminalises rather than wedging"
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
        _sweeper().sweepExpiredInteractionRewards(ids); // stamp the clock
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
            _sweeper().sweepExpiredInteractionRewards(ids),
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
        uint256 swept = _sweeper().sweepExpiredInteractionRewards(ids);
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
    /// @dev #1434 (Codex #1699 r7 P1) — a SPANNING entry must be reapable.
    ///
    ///      An entry with `startDay < armedFrom < endDay` and no prior claim
    ///      is the shape expiry exists for: abandoned, straddling the cutover.
    ///      Unifying expiry onto the day engine broke it outright —
    ///      `_shareOfPoolCursorDay` hands the primitive `armedFrom` while the
    ///      primitive resolves an UNSET cursor to `startDay`, so the set
    ///      validation reverted `RewardEntrySetMismatch`. And because the sweep
    ///      is a permissionless BATCH, one such entry poisoned the whole keeper
    ///      call rather than just stalling itself.
    ///
    ///      489 tests passed while that was true, because no fixture reaped an
    ///      entry straddling the boundary. This is that fixture. Revert the
    ///      legacy-leg branch in `sweepExpiredEntry` and this reverts.
    function testP1bSpanningEntryReapsAcrossTheCutover() public {
        _cfg().setRewardClaimHorizonDays(180);
        (uint256 floor5, ) = _armAndFinalize(5, 700 ether);
        assertGt(floor5, 0, "armed day has a fresh floor");

        // Straddles the cutover: day 4 is legacy, day 5 is armed.
        uint256 id = _seedEntry(alice, 91, 4, 6);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        _mut().setInteractionPoolPaidOut(0);
        _sweeper().sweepExpiredInteractionRewards(ids); // stamp the clock
        _accrueExec(ids, 180 days + 90 days - 7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        // FIRST sweep settles the pre-cutover leg and stamps the cursor. It
        // must credit something and must NOT revert — the revert is the bug.
        uint256 legacyCredit = _sweeper().sweepExpiredInteractionRewards(ids);
        assertGt(legacyCredit, 0, "the legacy leg is credited, not rejected");
        assertEq(
            _mut().getRewardEntryClaimNextDayRaw(id),
            5,
            "and the cursor is stamped to the arming day, as a claim would"
        );

        // SECOND sweep reaps the armed tail through the day engine.
        uint256 armedCredit = _sweeper().sweepExpiredInteractionRewards(ids);
        assertGt(armedCredit, 0, "the armed tail then reaps");
        assertTrue(
            _mut().getRewardEntryProcessedRaw(id),
            "and the entry is finally terminalised"
        );
    }

    /// @dev #1434 (Codex #1699 r8 P1) — a claim racing a PARTLY-SWEPT entry
    ///      must not silently lose the already-recycled value.
    ///
    ///      Chunked reaping makes every credited chunk irreversible. While the
    ///      entry stayed claimable in between, an owner claiming mid-sweep got
    ///      nothing for what the bucket had already absorbed — and no removal
    ///      signal had been emitted to explain it, contradicting the guarantee
    ///      that a claim before removal wins.
    ///
    ///      The resolution is that the FIRST crediting chunk IS the removal
    ///      point: it announces itself and closes the claim. This asserts the
    ///      announcement happens and the claim is closed from that instant —
    ///      not that the claimant is quietly shortchanged.
    function testP1bFirstCreditedChunkIsTheRemovalPoint() public {
        _cfg().setRewardClaimHorizonDays(180);
        (uint256 floor5, ) = _armAndFinalize(5, 700 ether);
        assertGt(floor5, 0, "armed day has a fresh floor");

        uint256 id = _seedEntry(alice, 92, 4, 6); // straddles the cutover
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        _mut().setInteractionPoolPaidOut(0);
        _sweeper().sweepExpiredInteractionRewards(ids); // stamp the clock
        _accrueExec(ids, 180 days + 90 days - 7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        assertFalse(
            _mut().getRewardEntryExpiryBegunRaw(id),
            "LIVE: not yet at the removal point"
        );

        // The first chunk credits, so it must ANNOUNCE the removal.
        vm.expectEmit(true, true, false, false);
        emit RewardEntryExpiryBegun(id, alice);
        uint256 first = _sweeper().sweepExpiredInteractionRewards(ids);
        assertGt(first, 0, "LIVE: the chunk genuinely credited");
        assertTrue(
            _mut().getRewardEntryExpiryBegunRaw(id),
            "the first credited chunk is the removal point"
        );

        // From here the claim must not reach it at all — neither paying twice
        // for what was recycled nor paying a silently reduced amount.
        // The claim finds nothing at all — it reverts rather than paying a
        // reduced amount, which is the stronger guarantee.
        vm.prank(alice);
        vm.expectRevert(IVaipakamErrors.NoInteractionRewardsToClaim.selector);
        RewardClaimFacet(address(diamond)).claimInteractionRewards();
        assertFalse(
            _mut().getRewardEntryProcessedRaw(id),
            "LIVE: and the entry is still mid-sweep, not terminalised"
        );
    }

    /// @dev #1434 (Codex #1699 r8 P1) — a WHOLLY pre-cutover entry terminalises
    ///      in one pass and can never be paid again.
    ///
    ///      The spanning bootstrap keyed only on `startDay < armedFrom`, so an
    ///      entry whose whole window predates the cutover matched it too: it
    ///      was credited to the bucket, had its cursor stamped, and was never
    ///      marked processed — leaving a claim free to pay the SAME entry a
    ///      second time through the whole-window path.
    function testP1bWhollyLegacyEntryTerminalisesOnceOnly() public {
        _cfg().setRewardClaimHorizonDays(180);
        // Arm well AFTER the entry's window: days 2-4 are wholly pre-cutover.
        (uint256 floor9, ) = _armAndFinalize(9, 700 ether);
        assertGt(floor9, 0, "armed day exists, but past this entry");

        uint256 id = _seedEntry(alice, 93, 2, 4);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        _mut().setInteractionPoolPaidOut(0);
        _sweeper().sweepExpiredInteractionRewards(ids); // stamp the clock
        _accrueExec(ids, 180 days + 90 days - 7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        uint256 reaped = _sweeper().sweepExpiredInteractionRewards(ids);
        assertGt(reaped, 0, "LIVE: the wholly-legacy entry genuinely reaps");
        assertTrue(
            _mut().getRewardEntryProcessedRaw(id),
            "and terminalises in that ONE pass"
        );

        // The double-spend: a claim must find nothing left to pay.
        vm.prank(alice);
        vm.expectRevert(IVaipakamErrors.NoInteractionRewardsToClaim.selector);
        RewardClaimFacet(address(diamond)).claimInteractionRewards();
    }

    /// @dev #1434 (Codex #1699 r9 P1) — once removal has BEGUN, a fresh
    ///      shortfall must TERMINATE the entry, never defer it forever.
    ///
    ///      Two guards of mine collided. Deferring on a 69M shortfall protects
    ///      a still-claimable owner from being reaped with part of their value
    ///      discarded. The removal point protects an owner from silently
    ///      losing what was already recycled. Together they trapped the tail:
    ///      the first chunk credits and removes, the pool draw shrinks the
    ///      MONOTONE headroom, the next chunk defers forever, and the claim
    ///      path now skips the entry — so the guard against silent loss became
    ///      the cause of it.
    ///
    ///      Sequencing by the removal point resolves it: defer before, and
    ///      truncate-and-advance after, exactly as a claim does against the
    ///      same monotone budget.
    function testP1bRemovedEntryTerminatesUnderAShortfall() public {
        _cfg().setRewardClaimHorizonDays(180);
        // FRESH-ONLY armed day, deliberately. A recycled share moves
        // regardless of the 69M pool, so with any recycled component the
        // "exhausted" terminal chunk still moves tokens and still reads
        // claim-executable — and neither fixed path (the removed-entry gate
        // bypass, the capped-only commitment retirement) ever runs. Both r10
        // mutants survived against the 700-ether-recycled version of this
        // fixture for exactly that reason.
        (uint256 floor5, uint256 recycled5) = _armAndFinalize(5, 0);
        assertGt(floor5, 0, "armed day has a fresh floor");
        assertEq(recycled5, 0, "LIVE: and NO recycled share");

        uint256 id = _seedEntry(alice, 95, 4, 6); // spans: legacy + armed
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        _mut().setInteractionPoolPaidOut(0);
        _mut().setArmedFreshLedgerRaw(100_000 ether, 0);
        _sweeper().sweepExpiredInteractionRewards(ids); // stamp the clock
        _accrueExec(ids, 180 days + 90 days - 7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        // Chunk one: credits the legacy leg and crosses the removal point.
        uint256 first = _sweeper().sweepExpiredInteractionRewards(ids);
        assertGt(first, 0, "LIVE: the first chunk credited");
        assertTrue(
            _mut().getRewardEntryExpiryBegunRaw(id),
            "LIVE: and removal has begun"
        );
        assertFalse(
            _mut().getRewardEntryProcessedRaw(id),
            "LIVE: with a tail still owed"
        );

        // Now starve the monotone 69M budget. Before this fix the tail would
        // defer here and, because the budget can only shrink, defer forever.
        _mut().setInteractionPoolPaidOut(
            LibVaipakam.VPFI_INTERACTION_POOL_CAP
        );

        (, uint256 outFBefore, , ) = _agg().getGovernorCommitState();
        assertGt(outFBefore, 0, "LIVE: there is a commitment to retire");

        uint256 last = _sweeper().sweepExpiredInteractionRewards(ids);
        // LIVE: the terminal chunk moved NOTHING — zero fresh under the
        // exhausted pool, zero recycled by construction. This is the state
        // both r10 fixes exist for: the entry reads non-executable (post-cap
        // payable is zero), so only the removed-entry bypass reaches the
        // settlement at all, and the facet's early-return guard sees both
        // token totals at zero with the whole obligation in `cappedOff`.
        assertEq(last, 0, "LIVE: the terminal chunk credits zero tokens");
        assertTrue(
            _mut().getRewardEntryProcessedRaw(id),
            "a removed entry always terminalises, never strands its tail"
        );
        // Codex #1699 r10 P1 — terminalising is NOT the whole property, and
        // asserting only `processed` is what let the leak through. A final
        // chunk under full exhaustion moves no tokens and carries its entire
        // remaining obligation in `cappedOff`; the facet used to return early
        // on the token totals alone and skip `consumeArmedFresh`, leaving that
        // obligation in the outstanding sum FOREVER — depressing every later
        // day's fundability on an entry nobody can claim any more.
        (, uint256 outFAfter, , ) = _agg().getGovernorCommitState();
        assertLt(
            outFAfter,
            outFBefore,
            "and its commitment retires with it, never leaking"
        );
    }

    /// @dev #1434 (Codex #1699 r9 P1) — a ROLE transition retires the
    ///      delivered residual, in both directions.
    ///
    ///      The delivered bound is mirror-scoped (`received - paid`), but the
    ///      role flag is mutable both ways and the counters persisted across
    ///      it. A mirror holding a residual could be promoted — canonical
    ///      armed claims ignore the bound AND skip the paid-ledger write, so
    ///      they consume the very tokens that residual backed — and then
    ///      demoted, whereupon the untouched counters offer the SAME headroom
    ///      again. Unrelated custody funding a duplicate spend.
    ///
    ///      Retiring by levelling paid up to received errs safe: a chain
    ///      resumes with NO delivered headroom and earns it back from the next
    ///      remittance.
    function testP1bRoleTransitionRetiresTheDeliveredResidual() public {
        _rep().setIsCanonicalRewardChain(false);
        _mut().setArmedFreshLedgerRaw(10 ether, 4 ether);
        (, uint256 residual) = RewardRemittanceLensFacet(address(diamond))
            .getDeliveredFreshBound();
        assertEq(residual, 6 ether, "LIVE: the mirror holds a 6 residual");

        // Promote. The canonical era reads UNBOUNDED by design — bounding a
        // canonical chain would brick it — so the bound itself says nothing
        // here. What matters is whether the residual survives underneath.
        _rep().setIsCanonicalRewardChain(true);
        (, uint256 afterPromote) = RewardRemittanceLensFacet(address(diamond))
            .getDeliveredFreshBound();
        assertEq(
            afterPromote,
            type(uint256).max,
            "LIVE: canonical is unbounded, as designed"
        );

        // Demote — THE double-spend vector. Canonical-era armed claims ignore
        // the bound and skip the paid-ledger write, so they can consume the
        // tokens that residual was backing; if it survives the round trip the
        // same headroom is offered a second time.
        _rep().setIsCanonicalRewardChain(false);
        (, uint256 afterDemote) = RewardRemittanceLensFacet(address(diamond))
            .getDeliveredFreshBound();
        assertEq(
            afterDemote,
            0,
            "and a round trip cannot resurrect the same headroom"
        );
    }

    /// @dev Pre-merge review 2026-08-17 P1 — a fresh shortfall caused by the
    ///      recycle bucket's BACKING room (a held-balance constraint that
    ///      recovers with any inflow) must DEFER a removed entry's chunk, not
    ///      truncate it. Only the 69M pool cap is monotone; treating a
    ///      transient balance dip as terminal let a permissionless sweep
    ///      timed to the dip destroy value one block of patience recovered.
    function testP1bRemovedEntryDefersOnABackingDip() public {
        _cfg().setRewardClaimHorizonDays(180);
        // Fresh-only armed day, as in the terminal test: a recycled share
        // moves regardless of the pool and would mask the deferral.
        (uint256 floor5, uint256 recycled5) = _armAndFinalize(5, 0);
        assertGt(floor5, 0, "armed day has a fresh floor");
        assertEq(recycled5, 0, "LIVE: and NO recycled share");

        uint256 id = _seedEntry(alice, 98, 4, 6); // legacy day 4 + armed day 5
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        _mut().setInteractionPoolPaidOut(0);
        _mut().setArmedFreshLedgerRaw(100_000 ether, 0);
        _sweeper().sweepExpiredInteractionRewards(ids); // stamp the clock
        _accrueExec(ids, 180 days + 90 days - 7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        uint256 first = _sweeper().sweepExpiredInteractionRewards(ids);
        assertGt(first, 0, "LIVE: the first chunk credited");
        assertTrue(
            _mut().getRewardEntryExpiryBegunRaw(id),
            "LIVE: and removal has begun"
        );

        // The DIP: bucket levelled up to the whole balance -> backing room 0,
        // while the 69M pool still has its full headroom (paidOut is 0). The
        // shortfall the chunk now hits is entirely backing-caused.
        uint256 bucketBefore = _mut().getRecycleBucketRaw();
        _mut().setRecycleBucketRaw(vpfi.balanceOf(address(diamond)));
        uint256 dip = _sweeper().sweepExpiredInteractionRewards(ids);
        assertEq(dip, 0, "LIVE: nothing credits during the dip");
        assertFalse(
            _mut().getRewardEntryProcessedRaw(id),
            "a backing dip DEFERS a removed entry - it never truncates"
        );

        // Backing recovers -> the deferred remainder settles IN FULL.
        _mut().setRecycleBucketRaw(bucketBefore);
        uint256 last = _sweeper().sweepExpiredInteractionRewards(ids);
        assertGt(last, 0, "the deferred remainder credits once backing recovers");
        assertTrue(
            _mut().getRewardEntryProcessedRaw(id),
            "and the entry then terminalises normally"
        );
    }

    /// @dev Pre-merge review 2026-08-17 P2 — removal begins on the first
    ///      chunk that CREDITS, exactly as the event/storage docs promise. A
    ///      chunk that merely ADVANCES (a day whose D1 ceiling a sibling's
    ///      claim already consumed) moves nothing irreversible, so it must
    ///      not close the owner's claim nor flip the entry into
    ///      post-removal truncate mode.
    function testP1bZeroCreditChunkDoesNotRemove() public {
        _cfg().setRewardClaimHorizonDays(180);
        (uint256 floor5, ) = _armAndFinalize(5, 0);
        assertGt(floor5, 0, "armed day has a fresh floor");
        // Second armed day so a pending tail exists after the zero chunk.
        _mut().setRecycledCreditedByDayRaw(6, 0);
        _finalize(6);
        _mut().setDayUserSideCapRaw(6, type(uint256).max);

        uint256 id = _seedEntry(alice, 99, 5, 7); // wholly armed: days 5, 6
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        _mut().setInteractionPoolPaidOut(0);
        _mut().setArmedFreshLedgerRaw(100_000 ether, 0);
        _sweeper().sweepExpiredInteractionRewards(ids); // stamp the clock
        _accrueExec(ids, 180 days + 90 days - 7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        // Day 5's D1 ceiling is already fully consumed (as a sibling entry's
        // earlier claim would leave it): the chunk ADVANCES, credits zero.
        _mut().setDayUserSideCapRaw(5, 1 ether);
        _mut().setUserSideDayPaidRaw(
            alice, uint8(LibVaipakam.RewardSide.Lender), 5, 1 ether
        );
        uint256 zero = _sweeper().sweepExpiredInteractionRewards(ids);
        assertEq(zero, 0, "LIVE: the chunk credited nothing");
        assertEq(
            _mut().getRewardEntryClaimNextDayRaw(id),
            6,
            "LIVE: yet it advanced past the consumed day"
        );
        assertFalse(
            _mut().getRewardEntryExpiryBegunRaw(id),
            "a zero-credit chunk never removes - the claim stays open"
        );

        // The first chunk that actually CREDITS is the removal point.
        uint256 credited = _sweeper().sweepExpiredInteractionRewards(ids);
        assertGt(credited, 0, "LIVE: day 6 credits");
        assertTrue(
            _mut().getRewardEntryExpiryBegunRaw(id),
            "and removal begins exactly there"
        );
    }

    /// @dev Pre-merge review 2026-08-17 P2 — mirror-ness has TWO inputs
    ///      (`!isCanonicalRewardChain && baseChainId != 0`), and the r9
    ///      residual retirement guarded only the canonical knob. Detaching
    ///      via `setBaseChainId(0)` and re-attaching must retire the
    ///      delivered residual the same way a canonical round trip does.
    function testP1bBaseChainDetachRetiresTheDeliveredResidual() public {
        _rep().setIsCanonicalRewardChain(false); // mirror (baseChainId set)
        _mut().setArmedFreshLedgerRaw(10 ether, 4 ether);
        (, uint256 residual) = RewardRemittanceLensFacet(address(diamond))
            .getDeliveredFreshBound();
        assertEq(residual, 6 ether, "LIVE: the mirror holds a 6 residual");

        _rep().setBaseChainId(0); // detach: mirror -> neither
        _rep().setBaseChainId(uint32(CHAIN_BASE)); // re-attach
        (, uint256 afterRoundTrip) = RewardRemittanceLensFacet(
            address(diamond)
        ).getDeliveredFreshBound();
        assertEq(
            afterRoundTrip,
            0,
            "a detach round trip retires the residual, never re-offers it"
        );
    }

    /// @dev Pre-merge review 2026-08-17 P3 — a REMOVED entry is skipped by
    ///      the claim, so the pending preview and the claim-executable
    ///      aggregate must skip it too. Counting it overstated the user's
    ///      pending figure and froze SIBLING entries' expiry clocks behind a
    ///      funding need no balance could satisfy.
    function testP1bRemovedEntryLeavesThePendingAggregates() public {
        _cfg().setRewardClaimHorizonDays(180);
        (uint256 floor5, uint256 recycled5) = _armAndFinalize(5, 0);
        assertGt(floor5, 0, "armed day has a fresh floor");
        assertEq(recycled5, 0, "LIVE: and NO recycled share");

        uint256 id = _seedEntry(alice, 100, 4, 6);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        _mut().setInteractionPoolPaidOut(0);
        _mut().setArmedFreshLedgerRaw(100_000 ether, 0);
        _sweeper().sweepExpiredInteractionRewards(ids); // stamp the clock
        _accrueExec(ids, 180 days + 90 days - 7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        uint256 pendingBefore = _mut().getUserClaimPendingUncappedRaw(alice);
        assertGt(pendingBefore, 0, "LIVE: the entry counts while claimable");
        (uint256 previewBefore, , ) = _lens().previewInteractionRewards(alice);
        assertGt(previewBefore, 0, "LIVE: and previews while claimable");
        (, uint64 expiresBefore) = _lens().getRewardEntryExpiry(id);
        assertGt(
            uint256(expiresBefore),
            0,
            "LIVE: and carries a live countdown while claimable"
        );

        // Remove it (first crediting chunk), then PARK it mid-chunks on a
        // backing dip so it stays unprocessed.
        uint256 first = _sweeper().sweepExpiredInteractionRewards(ids);
        assertGt(first, 0, "LIVE: the first chunk credited");
        assertTrue(
            _mut().getRewardEntryExpiryBegunRaw(id),
            "LIVE: removal has begun"
        );
        _mut().setRecycleBucketRaw(vpfi.balanceOf(address(diamond)));
        _sweeper().sweepExpiredInteractionRewards(ids);
        assertFalse(
            _mut().getRewardEntryProcessedRaw(id),
            "LIVE: parked - removed but not terminal"
        );

        assertEq(
            _mut().getUserClaimPendingUncappedRaw(alice),
            0,
            "a removed entry no longer inflates the executable aggregate"
        );
        (uint256 previewAfter, , ) = _lens().previewInteractionRewards(alice);
        assertEq(previewAfter, 0, "nor the user's pending preview");
        // Codex #1699 r11 P2 — removal is terminal for the countdown too: a
        // deadline the owner can no longer act on must not keep ticking in
        // the Claim Center for the whole life of a deferred tail.
        (, uint64 expiresAfter) = _lens().getRewardEntryExpiry(id);
        assertEq(
            uint256(expiresAfter),
            0,
            "and a removed entry shows no claimant countdown"
        );
    }

    /// @dev Codex #1699 r13 P2 — the armed-need aggregate and the pending
    ///      preview must model the 69M LIFETIME cap alongside the delivered
    ///      bound, because `_attributeLegs` decides which constraint binds by
    ///      comparing them. With `fresh: max` in the dry run, a near-exhausted
    ///      pool read as a DELIVERED shortfall: the preview quoted zero for a
    ///      claim that succeeds (the live claim truncates at the cap and pays
    ///      the headroom), and the need demanded delivered allowance for value
    ///      the schedule will never owe — freezing the expiry clock forever,
    ///      since no remittance funds past the cap. The spec's bar is "the
    ///      fresh share truncated to the 69M pool cap" (TokenomicsTechSpec
    ///      claim-horizon section) — this aligns the dry run with it.
    function testP1bNeedAndPreviewModelTheLifetimeCap() public {
        _cfg().setRewardClaimHorizonDays(180);
        // Fresh-only armed day: a recycled share moves regardless of the
        // pool and would blur which constraint the assertions measure.
        (uint256 floor5, uint256 recycled5) = _armAndFinalize(5, 0);
        assertGt(floor5, 0, "armed day has a fresh floor");
        assertEq(recycled5, 0, "LIVE: and NO recycled share");
        // MIRROR: chain id moved too — per-day funding keys on block.chainid.
        vm.chainId(CHAIN_ARB);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(false);
        _mut().setChainDayFundingRaw(5, uint32(CHAIN_ARB), floor5 / 2, 0);

        uint256 id = _seedEntry(alice, 101, 5, 6);
        assertGt(id, 0, "LIVE: entry seeded");
        _mut().setInteractionPoolPaidOut(0);
        _mut().setArmedFreshLedgerRaw(100_000 ether, 0);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        _sweeper().sweepExpiredInteractionRewards(ids); // stamp the clock
        _accrueExec(ids, 30 days);

        uint256 needRaw = _lens().getUserArmedFreshNeed(alice);
        assertGt(needRaw, 0, "LIVE: an unconstrained armed demand exists");

        // Near-exhaust the schedule: headroom is HALF the demand, and the
        // delivered allowance matches it exactly — which is all a remittance
        // will ever fund, since Base remits the capped liability.
        uint256 headroom = needRaw / 2;
        _mut().setInteractionPoolPaidOut(
            LibVaipakam.VPFI_INTERACTION_POOL_CAP - headroom
        );
        _mut().setArmedFreshLedgerRaw(headroom, 0);

        assertEq(
            _lens().getUserArmedFreshNeed(alice),
            headroom,
            "the need demands only what the schedule can still owe"
        );
        (uint256 preview, , ) = _lens().previewInteractionRewards(alice);
        assertEq(
            preview,
            headroom,
            "and the preview quotes the claim-exact cap truncation, never a spurious delivered deferral"
        );
    }

    /// @dev Codex #1699 r14 P2(a) — the dry run's fresh budget DEPLETES
    ///      between days, mirroring the live walk's
    ///      `ctx.pool.fresh -= freshSpent`. Bound-but-undepleted let every
    ///      day measure against the original headroom: two d-valued days
    ///      against 1.5d of headroom dry-ran as 2d while the claim pays
    ///      d then terminally truncates the second day to 0.5d.
    function testP1bDryRunDepletesTheFreshBudgetBetweenDays() public {
        _cfg().setRewardClaimHorizonDays(180);
        (uint256 floor5, uint256 recycled5) = _armAndFinalize(5, 0);
        assertGt(floor5, 0, "armed day has a fresh floor");
        assertEq(recycled5, 0, "LIVE: and NO recycled share");
        _mut().setRecycledCreditedByDayRaw(6, 0);
        _finalize(6);
        _mut().setDayUserSideCapRaw(6, type(uint256).max);

        uint256 id = _seedEntry(alice, 102, 5, 7); // TWO armed days: 5, 6
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        _mut().setInteractionPoolPaidOut(0);
        _mut().setArmedFreshLedgerRaw(100_000 ether, 0);
        _sweeper().sweepExpiredInteractionRewards(ids); // stamp the clock
        _accrueExec(ids, 30 days);

        uint256 needRaw = _lens().getUserArmedFreshNeed(alice);
        assertGt(needRaw, 0, "LIVE: a two-day armed demand exists");

        // Headroom covers 3/4 of the demand: the first day fits whole, the
        // second truncates — the live walk's exact behaviour.
        uint256 headroom = (needRaw * 3) / 4;
        _mut().setInteractionPoolPaidOut(
            LibVaipakam.VPFI_INTERACTION_POOL_CAP - headroom
        );
        assertEq(
            _lens().getUserArmedFreshNeed(alice),
            headroom,
            "the two-day need depletes the budget between days"
        );
        (uint256 preview, , ) = _lens().previewInteractionRewards(alice);
        assertEq(
            preview,
            headroom,
            "and the preview quotes day-one whole plus day-two truncated"
        );
    }

    /// @dev Codex #1699 r14 P2(b) — the dry run's fresh budget reserves the
    ///      claim's PRECEDING legs (window, then entry-path legacy slices),
    ///      exactly as the live path threads `freshBudget` minus
    ///      `legacyFreshReserved` into the walk. Without the reservation
    ///      the armed need demanded delivered allowance for headroom the
    ///      legacy leg consumes first — pausing the expiry clock after Base
    ///      has remitted the capped liability in full.
    function testP1bDryRunReservesTheLegacyLegFirst() public {
        _cfg().setRewardClaimHorizonDays(180);
        (uint256 floor5, uint256 recycled5) = _armAndFinalize(5, 0);
        assertGt(floor5, 0, "armed day has a fresh floor");
        assertEq(recycled5, 0, "LIVE: and NO recycled share");

        uint256 id = _seedEntry(alice, 103, 4, 6); // legacy day 4 + armed day 5
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        _mut().setInteractionPoolPaidOut(0);
        _mut().setArmedFreshLedgerRaw(100_000 ether, 0);
        _sweeper().sweepExpiredInteractionRewards(ids); // stamp the clock
        _accrueExec(ids, 30 days);

        uint256 needAbundant = _lens().getUserArmedFreshNeed(alice);
        assertGt(needAbundant, 0, "LIVE: an armed demand exists");
        (uint256 previewAbundant, , ) = _lens().previewInteractionRewards(alice);
        uint256 legacy = previewAbundant - needAbundant;
        assertGt(legacy, 0, "LIVE: and a preceding legacy leg exists");

        // Headroom covers the legacy leg plus HALF the armed leg. The claim
        // settles the legacy leg first; the walk owns only the remainder.
        uint256 headroom = legacy + needAbundant / 2;
        _mut().setInteractionPoolPaidOut(
            LibVaipakam.VPFI_INTERACTION_POOL_CAP - headroom
        );
        assertEq(
            _lens().getUserArmedFreshNeed(alice),
            needAbundant / 2,
            "the armed need is measured AFTER the legacy leg's reservation"
        );
        (uint256 preview, , ) = _lens().previewInteractionRewards(alice);
        assertEq(
            preview,
            headroom,
            "and the preview quotes legacy-whole plus armed-remainder"
        );
    }

    /// @dev Codex #1699 r15 P2 — a FORFEITED entry's legacy slice spends the
    ///      same 69M pool on its way to treasury, and the live claim's
    ///      `legacyFreshReserved` includes it. The dry run's reservation
    ///      must too — while the displayed user preview keeps excluding it
    ///      (a forfeited entry pays the claimant nothing).
    function testP1bDryRunReservesTheForfeitLegToo() public {
        _cfg().setRewardClaimHorizonDays(180);
        (uint256 floor5, uint256 recycled5) = _armAndFinalize(5, 0);
        assertGt(floor5, 0, "armed day has a fresh floor");
        assertEq(recycled5, 0, "LIVE: and NO recycled share");

        uint256 idX = _seedEntry(alice, 104, 4, 6); // legacy day 4 + armed day 5
        uint256[] memory ids = new uint256[](1);
        ids[0] = idX;
        _mut().setInteractionPoolPaidOut(0);
        _mut().setArmedFreshLedgerRaw(100_000 ether, 0);
        _sweeper().sweepExpiredInteractionRewards(ids); // stamp the clock
        _accrueExec(ids, 30 days);

        uint256 armedN = _lens().getUserArmedFreshNeed(alice);
        assertGt(armedN, 0, "LIVE: an armed demand exists");
        (uint256 previewX, , ) = _lens().previewInteractionRewards(alice);
        uint256 legacyL = previewX - armedN;
        assertGt(legacyL, 0, "LIVE: and a legacy leg exists");

        // A second, IDENTICALLY-SHAPED wholly-legacy entry, then FORFEIT it:
        // its value equals X's legacy leg (same day, same perDay), and it
        // routes to treasury at claim.
        uint256 idY = _seedEntry(alice, 105, 4, 5);
        _mut().setRewardEntryForfeitedRaw(idY);
        (uint256 previewAfterForfeit, , ) =
            _lens().previewInteractionRewards(alice);
        assertEq(
            previewAfterForfeit,
            previewX,
            "LIVE: the forfeited entry shows the claimant NOTHING"
        );

        // Near-ceiling: headroom covers BOTH legacy legs plus half the armed
        // leg. The claim settles X's leg to the user and Y's leg to treasury
        // before the walk; the walk owns only armedN / 2.
        uint256 headroom = legacyL * 2 + armedN / 2;
        _mut().setInteractionPoolPaidOut(
            LibVaipakam.VPFI_INTERACTION_POOL_CAP - headroom
        );
        assertEq(
            _lens().getUserArmedFreshNeed(alice),
            armedN / 2,
            "the armed need reserves the TREASURY leg alongside the user leg"
        );
        (uint256 preview, , ) = _lens().previewInteractionRewards(alice);
        assertEq(
            preview,
            headroom - legacyL,
            "and the preview shows user legs + walk remainder, never the treasury leg"
        );
    }

    /// @dev Codex #1699 r16 P2 — the forfeit reservation covers the LEGACY
    ///      component only. A forfeited entry with ARMED days still passes
    ///      the worklist's claimable gate (the loan is terminal), so the
    ///      walk prices those days itself; reserving the whole remaining
    ///      split counted the armed part twice and UNDERSTATED the need —
    ///      the error direction that could reap a claimant whose live claim
    ///      still defers.
    function testP1bForfeitReservationIsLegacyOnly() public {
        _cfg().setRewardClaimHorizonDays(180);
        (uint256 floor5, uint256 recycled5) = _armAndFinalize(5, 0);
        assertGt(floor5, 0, "armed day has a fresh floor");
        assertEq(recycled5, 0, "LIVE: and NO recycled share");

        // A wholly-ARMED entry, forfeited: no legacy leg at all, so the
        // correct reservation from it is ZERO — its armed day belongs to
        // the walk on both the live and simulated sides.
        uint256 id = _seedEntry(alice, 106, 5, 6);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        _mut().setInteractionPoolPaidOut(0);
        _mut().setArmedFreshLedgerRaw(100_000 ether, 0);
        _sweeper().sweepExpiredInteractionRewards(ids); // stamp the clock
        _accrueExec(ids, 30 days);
        _mut().setRewardEntryForfeitedRaw(id);

        uint256 armedZ = _lens().getUserArmedFreshNeed(alice);
        assertGt(armedZ, 0, "LIVE: the forfeited armed leg still walks");

        // Headroom exactly covers the armed leg. A self-double-reservation
        // would shrink the budget to zero and understate the need.
        _mut().setInteractionPoolPaidOut(
            LibVaipakam.VPFI_INTERACTION_POOL_CAP - armedZ
        );
        assertEq(
            _lens().getUserArmedFreshNeed(alice),
            armedZ,
            "an armed forfeit leg never reserves against itself"
        );
    }

    /// @dev Codex #1699 r17 P1 — the forfeit sweep gates on the D1-CAPPED
    ///      armed figure, because that is the liability Base's commitment
    ///      report states (`min(rawPay, cap)` per day) and therefore all a
    ///      remittance will ever fund. Gating on the raw figure demanded
    ///      allowance that could never arrive: a capped forfeited entry —
    ///      and its commitment — wedged permanently.
    function testP1bForfeitSweepGatesOnTheCappedLiability() public {
        _cfg().setRewardClaimHorizonDays(180);
        (uint256 floor5, uint256 recycled5) = _armAndFinalize(5, 0);
        assertGt(floor5, 0, "armed day has a fresh floor");
        assertEq(recycled5, 0, "LIVE: and NO recycled share");
        vm.chainId(CHAIN_ARB);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(false);
        _mut().setChainDayFundingRaw(5, uint32(CHAIN_ARB), floor5 / 2, 0);

        uint64 loanId = 107;
        uint256 id = _seedEntry(alice, loanId, 5, 6); // wholly armed
        _mut().setLoanActiveLenderEntryId(loanId, id);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        _mut().setInteractionPoolPaidOut(0);
        _mut().setArmedFreshLedgerRaw(100_000 ether, 0);
        _sweeper().sweepExpiredInteractionRewards(ids); // stamp the clock
        _accrueExec(ids, 30 days);

        // Measure the RAW armed value while the entry is still claimable
        // (the need excludes forfeited entries) and the cap is neutral.
        uint256 raw = _lens().getUserArmedFreshNeed(alice);
        assertGt(raw, 0, "LIVE: the entry carries a raw armed value");

        // Bind the D1 cap BELOW the raw value, then forfeit. Base's report
        // funds only min(raw, cap) = cap for this day — deliver EXACTLY
        // that, which is all any remittance will ever owe.
        uint256 cap = raw / 2;
        _mut().setDayUserSideCapRaw(5, cap);
        _mut().setRewardEntryForfeitedRaw(id);
        _mut().setArmedFreshLedgerRaw(cap, 0);

        uint256 swept = _facet().sweepForfeitedInteractionRewards(loanId);
        assertGt(
            swept,
            0,
            "a capped forfeit settles on the capped liability, never wedging"
        );
        // STORED state: the delivered bound is charged EXACTLY the capped
        // figure — the raw figure would both have reverted the gate above
        // and spent delivered funding that never arrived.
        assertEq(
            _mut().getArmedFreshPaidRaw(),
            cap,
            "and the bound is charged the capped figure, no more"
        );
    }

    function testExpiryReapsExactlyTheRemainingWindow() public {
        _cfg().setRewardClaimHorizonDays(180);
        (uint256 floor5, ) = _armAndFinalize(5, 700 ether);
        assertGt(floor5, 0, "armed day has a fresh floor");

        // Case 1 — fully walked: nothing remains, nothing is credited.
        uint256 walked = _seedEntry(alice, 47, 5, 6);
        uint256[] memory one = new uint256[](1);
        one[0] = walked;
        _sweeper().sweepExpiredInteractionRewards(one); // stamp the clock
        _accrueExec(one, 180 days + 90 days - 7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        _mut().setInteractionPoolPaidOut(0);
        _mut().setRewardEntryClaimNextDayRaw(walked, 6);
        assertEq(
            _sweeper().sweepExpiredInteractionRewards(one),
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
        _sweeper().sweepExpiredInteractionRewards(pair); // stamp both clocks
        _accrueExec(pair, 180 days + 90 days - 7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        uint256[] memory a = new uint256[](1);
        a[0] = spanning;
        uint256[] memory b = new uint256[](1);
        b[0] = twin;
        uint256 creditSpanning = _sweeper().sweepExpiredInteractionRewards(a);
        uint256 creditTwin = _sweeper().sweepExpiredInteractionRewards(b);
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
        _sweeper().sweepExpiredInteractionRewards(ids); // stamp the clock

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
            _sweeper().sweepExpiredInteractionRewards(ids),
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
        _sweeper().sweepExpiredInteractionRewards(ids); // stamp the clock

        _mut().setRecycleBucketRaw(0); // drought
        assertEq(
            _accrueExec(ids, 180 days + 90 days + 14 days),
            0,
            "nothing reaps during the drought"
        );
        _mut().setRecycleBucketRaw(1_000_000 ether);
        assertEq(
            _sweeper().sweepExpiredInteractionRewards(ids),
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
        _sweeper().sweepExpiredInteractionRewards(ids); // stamp the clocks

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
            _sweeper().sweepExpiredInteractionRewards(ids),
            0,
            "the touch advances, sees the joint drought, and pauses - no reap"
        );

        // The drought interval must never have been credited: even with the
        // bucket refilled, the window still has to be finished the honest way.
        _mut().setRecycleBucketRaw(1_000_000 ether);
        assertEq(
            _sweeper().sweepExpiredInteractionRewards(ids),
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
        _sweeper().sweepExpiredInteractionRewards(ids); // stamp both clocks

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
            _sweeper().sweepExpiredInteractionRewards(ids),
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

    /// @dev #1434 P1-b (Codex #1699 r5 P2) — the expiry gate must measure the
    ///      GROUPED D1-capped obligation, not the raw one.
    ///
    ///      The round-4 fix moved this gate off `st.rawSplit` onto the
    ///      loan-side-capped split, which is the right idea at the wrong
    ///      STAGE: `_loanSideCapCompute` returns the UNTRIMMED split for
    ///      UNSTAMPED loans, and mirror loans are never stamped — so on the
    ///      one chain the delivered bound exists for, the "capped" figure was
    ///      still the raw one and the wedge survived its own fix.
    ///
    ///      Base remits against the CAPPED liability its commitment report
    ///      states. Demanding the raw figure therefore waits on funding nobody
    ///      owes: not a slow wait, a permanent one. The liveness control below
    ///      is what makes this test non-vacuous — it asserts the D1 ceiling
    ///      genuinely BIT (`needCapped < needRaw`) before funding exactly the
    ///      capped amount, so a gate that still read raw would defer here and
    ///      the sweep would credit zero.
    function testP1bExpiryGateMeasuresTheD1CappedObligation() public {
        _cfg().setRewardClaimHorizonDays(180);
        (uint256 floor5, uint256 recycled5) = _armAndFinalize(5, 700 ether);
        assertGt(floor5, 0, "entry carries a fresh share");
        // MIRROR. Arm + finalize FIRST (finalization is Base-only), and move
        // the chain id too — per-day funding is keyed by `block.chainid`, so
        // flipping only the canonical flag leaves the day unstamped here.
        vm.chainId(CHAIN_ARB);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(false);
        // Finalization stamped day 5 for BASE. Without the mirror's own stamp
        // `_dayPoolHalves` halts, the cumulative cursor cannot advance past the
        // armed day, and `sweepExpiredEntry` returns before reaching any gate —
        // a zero credit that looks identical to the wedge under test.
        _mut().setChainDayFundingRaw(
            5, uint32(CHAIN_ARB), floor5 / 2, recycled5 / 2
        );

        uint256 id = _seedEntry(alice, 46, 5, 6);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        // Fund BEFORE accruing. The expiry clock only advances while the entry
        // is EXECUTABLE, and on a mirror executability itself consults the
        // delivered bound — so accruing against an empty ledger blocks the
        // clock and the sweep returns on `elapsed < required`, long before any
        // gate. Clear the 69M pool draw for the same reason: a
        // `freshShare > freshHeadroom` defer is indistinguishable from the
        // wedge under test, since both simply credit zero.
        _mut().setInteractionPoolPaidOut(0);
        _mut().setArmedFreshLedgerRaw(100_000 ether, 0);
        _sweeper().sweepExpiredInteractionRewards(ids); // stamp the clock
        _accrueExec(ids, 180 days + 90 days - 7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        // CONTROL — with the ceiling off and funding abundant, this entry
        // genuinely reaps. Without this the test could "pass" on a fixture
        // that never expires anything, which is exactly how an earlier expiry
        // test in this programme turned out to be vacuous.
        uint256 snap = vm.snapshotState();
        uint256 fullCredit = _sweeper().sweepExpiredInteractionRewards(ids);
        uint256 fullCharge = _mut().getArmedFreshPaidRaw();
        vm.revertToState(snap);
        assertGt(fullCredit, 0, "LIVE: the entry reaps when unconstrained");
        assertGt(fullCharge, 0, "LIVE: and charges the bound when it does");

        // `_armAndFinalize` disables the D1 ceiling; read the need with it off,
        // then bind it well below that and read again.
        uint256 needRaw = _lens().getUserArmedFreshNeed(alice);
        assertGt(needRaw, 0, "LIVE: the entry carries an armed demand at all");
        _mut().setDayUserSideCapRaw(5, needRaw / 4);
        uint256 needCapped = _lens().getUserArmedFreshNeed(alice);
        assertLt(needCapped, needRaw, "LIVE: the D1 ceiling actually bit");
        assertGt(needCapped, 0, "LIVE: and did not trim to nothing");

        // Fund EXACTLY the capped liability — what Base would really remit.
        _mut().setArmedFreshLedgerRaw(needCapped, 0);

        uint256 credited = _sweeper().sweepExpiredInteractionRewards(ids);
        assertGt(
            credited,
            0,
            "a capped-but-fully-funded entry terminalises instead of wedging"
        );
        // STORED state: the bound is charged what actually moved, which is the
        // capped figure. Charging the raw one would spend delivered funding
        // that was never delivered.
        assertEq(
            _mut().getArmedFreshPaidRaw(),
            needCapped,
            "the delivered bound is charged the CAPPED amount, not the raw"
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
        _sweeper().sweepExpiredInteractionRewards(ids); // stamp the clock
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
            _sweeper().sweepExpiredInteractionRewards(ids),
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

    /// Codex #1417 r7 — a MIRROR must fail-closed on armed-day pricing until
    /// B2-d arms mirror consumption. If it priced the V2 stamp's recycled
    /// equivalents and then debited the LOCAL bucket at claim (canonical
    /// `consume` semantics), a remittance-funded reward would cannibalise
    /// the mirror's own recycled balance — the exact mirror consumption the
    /// re-slice defers. The armed day HALTS, so a mirror claim never touches
    /// its bucket. (Base never arms a mirror until B2-d ships, so this is a
    /// safety backstop; the test forces the armed state to prove the code
    /// invariant.)
    function testMirrorArmedDayHaltsAndNeverDebitsBucket() public {
        vm.chainId(CHAIN_ARB);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(false);
        _rep().setRewardMessenger(address(messenger));

        _seedPriorDays(5);
        _mut().setGovernorCommitArmedFromDayRaw(5);
        _mut().setRecycleBucketRaw(100 ether);

        // Base broadcasts an armed day WITH recycled equivalents to the
        // mirror — the shape that, without the halt, the claim would price
        // and then debit the local bucket for.
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
                recycleConsume: 0,
                keeperAllocate: 0,
                destChainId: CHAIN_ARB
            })
        );

        _seedEntry(alice, 90, 5, 6); // day-5 lender entry (armed)

        // ── Unfunded: the day DEFERS, so nothing is priced or consumed ──────
        vm.prank(alice);
        try
            RewardClaimFacet(address(diamond)).claimInteractionRewardsTo(
                LibVaipakam.RewardDelivery.Wallet
            )
        returns (uint256, uint256, uint256) {} catch {}

        assertEq(
            _cfg().getRecycleBucket(),
            100 ether,
            "unfunded armed day: bucket untouched"
        );

        // ── Funded: the SAME day prices and DOES debit the bucket ───────────
        //
        // #1434 P1-b — this half is what keeps the test honest. Before the
        // halt lift, the assertion above held because armed mirror days never
        // priced at all; it now holds because an UNFUNDED day defers. Those
        // are different reasons and the first assertion cannot tell them
        // apart — it passes under the old halt, under a correct delivered
        // bound, and under a bound that never releases. Only showing the
        // bucket move ONCE FUNDED distinguishes a deferral from a permanent
        // stop, which is the property the slice actually delivers.
        _mut().setArmedFreshLedgerRaw(1_000 ether, 0);
        vm.prank(alice);
        try
            RewardClaimFacet(address(diamond)).claimInteractionRewardsTo(
                LibVaipakam.RewardDelivery.Wallet
            )
        returns (uint256, uint256, uint256) {} catch {}

        assertLt(
            _cfg().getRecycleBucket(),
            100 ether,
            "funded armed day: the deferred recycled leg is now consumed"
        );
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
