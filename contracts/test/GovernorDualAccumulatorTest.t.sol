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
    /// #1499 — the RECYCLED-TRANSFER guard, asserted on the quantity it sets.
    ///
    /// The guard raises the claim's funding requirement to the claimant's
    /// recycled obligation when that exceeds what the balance can transfer
    /// above the earmark. It shipped in #1970 unexercised, because
    /// `RewardClaimBackingSeparationTest` never arms the governor and
    /// {_entryPriceCore} clamps `recycled` to the armed amount — so every entry
    /// there has a zero recycled share. This suite arms and `_armAndFinalize`
    /// already seeds a recycled credit.
    ///
    /// Asserted on `userClaimFundingNeed` rather than on the expiry deadline.
    /// A first attempt asserted the deadline and PASSED with the guard removed:
    /// the countdown has further gates of its own, so it cannot isolate this
    /// one. The funding requirement is the exact value the guard writes, so
    /// deleting the guard moves it and the assertion fails.
    ///
    /// The pool is exhausted first so the fresh term is zero and
    /// `freshTotal + earmarked` degenerates to the bare balance; without that,
    /// the first backing condition decides the outcome and the guard is never
    /// the reason for it.
    function testFundingNeedRisesToTheRecycledObligation() public {
        _cfg().setRewardClaimHorizonDays(180);
        (, uint256 recycled5) = _armAndFinalize(5, 700 ether);
        assertGt(recycled5, 0, "fixture: the armed day has a NON-ZERO recycled share");

        uint256 id = _seedEntry(alice, 100, 4, 6);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        _mut().setInteractionPoolPaidOut(0);
        _mut().setArmedFreshLedgerRaw(100_000 ether, 0);
        _sweeper().sweepExpiredInteractionRewards(ids);

        // Fresh truncates to zero; bucket above the balance so the earmark is
        // the whole balance — the shape in which the first condition is vacuous.
        _mut().setInteractionPoolPaidOut(LibVaipakam.VPFI_INTERACTION_POOL_CAP);
        _mut().setRecycleBucketRaw(1_000_000 ether);

        uint256 bal = vpfi.balanceOf(address(diamond));

        // ABOVE the obligation: the requirement is just the balance, and the
        // claim is fundable.
        vm.prank(address(diamond));
        vpfi.transfer(address(0xdead), bal - 500 ether);
        uint256 balHigh = vpfi.balanceOf(address(diamond));
        uint256 needHigh = _mut().userClaimFundingNeedRaw(alice);
        assertEq(needHigh, balHigh, "above the obligation the requirement is the balance");

        // BELOW it: the requirement rises to the recycled obligation, so the
        // claim is NOT fundable — which is what stops the horizon clock.
        vm.prank(address(diamond));
        vpfi.transfer(address(0xdead), 490 ether);
        uint256 balLow = vpfi.balanceOf(address(diamond));
        uint256 needLow = _mut().userClaimFundingNeedRaw(alice);
        assertGt(needLow, balLow, "below it the requirement exceeds the balance");
        assertGt(
            needLow,
            needHigh - (balHigh - balLow),
            "the requirement is pinned to the obligation, not to the balance"
        );
    }

    /// #1499 — the funding requirement agrees with the claim under a BINDING
    /// loan-side cap: `need == what the claim pays + the earmark`, exactly.
    ///
    /// This is the cap x backing intersection. Surveying the suites, exactly
    /// one cell combined a binding loan-side cap with a backing manipulation
    /// ({testDroughtGateUsesRawRecycledUnderLoanSideCap}), and it covers the
    /// DROUGHT gate — raw recycled against the bucket — not the funding gate.
    ///
    /// The property matters because the cap changes the post-cap figures the
    /// predicate consumes, and the predicate's correctness claim is precisely
    /// that it reads post-cap values rather than raw ones. The cap here is set
    /// the way the drought cell sets it, small enough that the aggregate
    /// fresh-first trim consumes the headroom from fresh alone.
    ///
    /// Asserted as an EXACT equation rather than an inequality, so it fails in
    /// both directions: drop the earmark and `need` collapses to the payout;
    /// read raw instead of post-cap and `need` exceeds it.
    function testFundingNeedEqualsCappedPayoutPlusEarmarkUnderLoanSideCap()
        public
    {
        _cfg().setRewardClaimHorizonDays(180);
        (uint256 floor5, uint256 recycled5) = _armAndFinalize(5, 700 ether);
        assertGt(recycled5, 0, "fixture: the armed day has a recycled component");

        uint256 id = _seedEntry(alice, 57, 5, 6);
        uint256 cap = floor5 / 8;
        _mut().setFeeEntitlementRaw(
            57,
            LibVaipakam.FeeEntitlement({
                borrowerMode: LibVaipakam.FeeEntitlementMode.None,
                lenderMode: LibVaipakam.FeeEntitlementMode.None,
                openDays: 1,
                rewardHaircutBpsAtOpen: 0,
                borrowerTariffPaid: 0,
                lenderTariffPaid: 0,
                cStarOpen: uint128(0),
                loanSideRewardCapOpen: uint128(cap)
            })
        );

        uint256 bucket = 1_000_000 ether;
        _mut().setRecycleBucketRaw(bucket); // ample: not a drought
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        _sweeper().sweepExpiredInteractionRewards(ids);

        uint256 need = _mut().userClaimFundingNeedRaw(alice);

        vm.prank(alice);
        (uint256 paid, , ) =
            RewardClaimFacet(address(diamond)).claimInteractionRewards();

        assertEq(paid, cap, "fixture: the loan-side cap is what BINDS the payout");
        assertEq(
            need,
            paid + bucket,
            "the requirement is the capped payout plus the earmark - post-cap, not raw"
        );
    }

    /// #1499 — a FORFEITED entry enters the funding requirement as a TERM,
    /// through the same single formula, without re-adding the earmark.
    ///
    /// This is the forfeit x backing intersection. Seven cells combine a
    /// forfeit with a backing manipulation, but only two assert on a funding
    /// gate — one of those is the DROUGHT gate, and the other lives in
    /// `RewardClaimBackingSeparationTest`, which never arms and so has no
    /// recycled component at all. The requirement itself was unasserted here.
    ///
    /// The invariant is the one the predicate's own comment states: "ONE
    /// predicate, no forfeit branch. Forfeit value enters as `treasuryLegs` —
    /// a TERM, not a second formula with its own arithmetic". A second formula
    /// is what Codex #1970 r2 found bypassing {LibVpfiRecycle.backingPosition}
    /// entirely, so this pins the shape rather than the value: adding a
    /// forfeited sibling must add its own contribution and NOTHING else.
    ///
    /// Written as an exact equation over the two measurements, so it fails in
    /// both directions — drop the forfeit term and the requirement does not
    /// grow; count the earmark per entry instead of once and it grows twice as
    /// much.
    function testForfeitedEntryEntersTheRequirementAsATermNotASecondFormula()
        public
    {
        _cfg().setRewardClaimHorizonDays(180);
        (, uint256 recycled5) = _armAndFinalize(5, 700 ether);
        assertGt(recycled5, 0, "fixture: the armed day has a recycled component");

        uint256 bucket = 1_000_000 ether;
        _mut().setRecycleBucketRaw(bucket);

        // Codex #1988 r1: the earmark must NOT equal the bucket, or this cell
        // cannot tell {LibVpfiRecycle.backingPosition} from a bare
        // `s.recycleBucket` read. With the stranded and recovery reservations
        // at zero, `bal - unearmarked` IS exactly `bucket`, so the historical
        // second-branch shape `payout + s.recycleBucket + forfeitFresh` — the
        // very formula Codex #1970 r2 caught bypassing `backingPosition` —
        // satisfied the equation below. A distinct reservation separates them.
        uint256 stranded = 7_000 ether;
        _mut().setStrandedRecoveryRaw(address(0xD1), 1, stranded, 1, 4);
        uint256 earmark = bucket + stranded;

        // One live entry: requirement = its own contribution + the earmark.
        _seedEntry(alice, 100, 4, 6);
        uint256 needLiveOnly = _mut().userClaimFundingNeedRaw(alice);
        assertGt(needLiveOnly, earmark, "fixture: the live entry contributes");
        uint256 perEntry = needLiveOnly - earmark;
        (, uint256 userLegsLive, uint256 treasuryLegsLive) =
            _lens().getUserArmedFreshNeedWithLegs(alice);

        // An identical sibling, FORFEITED. Its value still has to be funded —
        // the forfeit-credit path spends it — so it enters the same formula.
        uint256 gone = _seedEntry(alice, 101, 4, 6);
        _mut().setRewardEntryForfeitedRaw(gone);
        uint256 needWithForfeit = _mut().userClaimFundingNeedRaw(alice);

        // Codex #1988 r1: assert the sibling is priced through the TREASURY
        // leg. The combined total alone is unchanged if the preview ignored
        // the `forfeited` bit and priced both siblings as live `userLegs`, so
        // the arithmetic could be satisfied by a classification regression.
        (, uint256 userLegsAfter, uint256 treasuryLegsAfter) =
            _lens().getUserArmedFreshNeedWithLegs(alice);
        assertEq(
            treasuryLegsLive,
            0,
            "fixture: with only a live entry there is no treasury leg"
        );
        assertGt(
            treasuryLegsAfter,
            0,
            "the forfeited sibling is priced through the TREASURY leg"
        );
        assertEq(
            userLegsAfter,
            userLegsLive,
            "and it does NOT inflate the user leg - it is not priced as live"
        );

        assertEq(
            needWithForfeit,
            perEntry * 2 + earmark,
            "the forfeited sibling adds its own contribution and the earmark - bucket PLUS the stranded reservation - stays counted ONCE"
        );
    }

    /// #1499 — the loan-side cap makes a claim AFFORDABLE, and the predicate
    /// allows it: the claim succeeds at a balance the RAW entitlement would
    /// not have fitted.
    ///
    /// #1986 pinned this intersection with an ample balance, so it covers only
    /// the backed half, and a per-test-body survey found no cell anywhere that
    /// combines a binding cap with a deliberate shortfall. That is the half
    /// where this card's failure mode lives: the cap TRIMS the payout, so a
    /// claim can be unaffordable raw and affordable trimmed. A predicate
    /// comparing the RAW entitlement against the balance refuses it, the
    /// horizon stops, and the notice window stalls on a claim that would have
    /// succeeded.
    ///
    /// The assertion is therefore the OPPOSITE shape from #1986's: not that a
    /// shortfall is refused — a broken predicate refuses too — but that the
    /// claim SUCCEEDS between post-cap and raw. The window is measured and
    /// asserted non-empty, so the cell cannot straddle nothing.
    ///
    /// A distinct `strandedRecoveryReserved` is seeded, or `bal - unearmarked`
    /// collapses to exactly `recycleBucket` and the backing arithmetic
    /// degenerates into an identity of the fixture (Codex #1988 r1).
    ///
    /// `deal` sets the balance rather than transferring it out. That is not
    /// only tidier: reading `balanceOf` inside a transfer's arguments consumes
    /// the preceding `vm.prank`, so the transfer runs as the test contract and
    /// reverts on an empty balance — and hoisting that read into a local puts
    /// this frame one slot over the viaIR budget.
    function testLoanSideCapMakesAClaimAffordableThatRawWouldNotFit() public {
        (uint256 floor5, ) = _armAndFinalize(5, 700 ether);
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setStrandedRecoveryRaw(address(0xD1), 1, 7_000 ether, 1, 4);
        _seedEntry(alice, 57, 5, 6);

        uint256 needUncapped = _mut().userClaimFundingNeedRaw(alice);
        _stampLoanSideCap(57, floor5 / 8);
        uint256 needCapped = _mut().userClaimFundingNeedRaw(alice);
        assertLt(
            needCapped,
            needUncapped,
            "fixture: the cap must TRIM the requirement, or there is no window"
        );

        // Sit exactly at the post-cap requirement: affordable trimmed, and
        // NOT affordable at the raw entitlement.
        deal(address(vpfi), address(diamond), needCapped);
        assertGt(
            needUncapped,
            needCapped,
            "fixture: the RAW entitlement would NOT have fitted this balance"
        );

        // The claim must succeed here. A predicate reading raw would have
        // called this unexecutable and stalled the clock on a live claim.
        vm.prank(alice);
        (uint256 paid, , ) =
            RewardClaimFacet(address(diamond)).claimInteractionRewards();
        assertEq(
            paid,
            floor5 / 8,
            "the claim pays the capped amount and does not revert"
        );
    }

    /// @dev Stamp a binding loan-side reward cap on `loanId`.
    function _stampLoanSideCap(uint256 loanId, uint256 cap) internal {
        _mut().setFeeEntitlementRaw(
            loanId,
            LibVaipakam.FeeEntitlement({
                borrowerMode: LibVaipakam.FeeEntitlementMode.None,
                lenderMode: LibVaipakam.FeeEntitlementMode.None,
                openDays: 1,
                rewardHaircutBpsAtOpen: 0,
                borrowerTariffPaid: 0,
                lenderTariffPaid: 0,
                cStarOpen: 0,
                loanSideRewardCapOpen: uint128(cap)
            })
        );
    }

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
    // #1499 / #1970 r2 P1#3 — TRANSFER-CONDITION CELL WITHDRAWN (vacuous).
    //
    // Written here, then mutated: removing the transfer condition
    // (`if (payout > need) need = payout`) left it PASSING, so it pinned
    // nothing. The pause it observed came from the ADMISSION gate, not from
    // the condition under test.
    //
    // Why: with `balance <= bucket`, `unearmarked` floors to 0 and
    // `earmarked == balance`, so `need = freshTotal + balance`. Any positive
    // `freshTotal` already exceeds the balance and pauses the clock on its own.
    // The transfer condition only binds when BOTH:
    //     freshTotal == 0      (admission degenerates to `balance >= balance`)
    //     payout     >  balance
    // i.e. a purely RECYCLED payout larger than the live balance. The fixture
    // here spans a pre-cutover day, whose legacy leg is fresh by construction,
    // so `freshTotal > 0` and the case is never reached.
    //
    // To build it: a wholly post-cutover entry on an armed day with a ZERO
    // fresh floor (so the armed fresh need is 0), plus `setRecycleBucketRaw`
    // above the live balance so the recycled payout can exceed it.
    //
    // Left out rather than committed green. Four cells on this card were
    // vacuous before this one; a green test that cannot fail is what the card
    // exists to stop.

    // #1499 / #1970 r2 P1#2 — GROUPED-ARMED-NEED CELL NOT BUILT, and the
    // measurement says why rather than my guessing at it.
    //
    // A probe (since removed) measured `getUserArmedFreshNeed(alice)` with one
    // entry and then two, both spanning the armed day 5, cursors advanced by a
    // real sweep:
    //
    //     one entry  : 10082191780821917808210
    //     two entries: 20164383561643835616420   == EXACTLY 2x
    //
    // So the D1 `(user, side, day)` ceiling does NOT bind at this sizing:
    // grouped and per-entry-summed are the same number, and no fixture built on
    // it can tell the two apart. An assertion here would have been the sixth
    // vacuous cell on this card.
    //
    // MEASURED FURTHER: the need was walked from 1 to 8 entries and tracked
    // N x single EXACTLY at every count (10082e18, 20164e18, 30246e18, ...
    // 80657e18). The ceiling does not bind at ANY entry count reachable here,
    // so no fixture built on this suite's day-pool sizing can separate the
    // grouped figure from a per-entry sum.
    //
    // To make it discriminate, the group must EXCEED the ceiling `finalizeDay`
    // stamps (20% of the side half by default). Either raise the entry sizing
    // well above that share, or lower `setDayCapThreshold18` for the armed day
    // BEFORE `_armAndFinalize` stamps the ceiling — the stamp happens at
    // finalize, so setting it afterwards has no effect.
    //
    // The probe also showed the dry-run reads through the side CURSORS, which
    // only the sweep advances: measured before a sweep, every entry's need
    // reads 0 — which would have made a grouped-vs-summed comparison trivially
    // equal as well.

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

    /// @dev Codex #1699 r19 P1(a) — a wholly-legacy forfeit is clamped to
    ///      the remaining 69M headroom: a permissionless sweep must never
    ///      push the fresh-payout ledger past the lifetime cap. The trim is
    ///      terminal (monotone budget, no claimant).
    function testP1bWhollyLegacyForfeitClampsToTheHeadroom() public {
        // Wholly pre-cutover: never arm. The entry settles whole O(1).
        _cfg().setRewardClaimHorizonDays(180);
        _seedPriorDays(6);
        uint256 id = _seedEntry(alice, 108, 2, 5);
        _mut().setRewardEntryForfeitedRaw(id);
        _mut().setLoanActiveLenderEntryId(108, id);

        // LIVE: measure the unclamped value.
        uint256 snap = vm.snapshotState();
        _mut().setInteractionPoolPaidOut(0);
        uint256 full = _facet().sweepForfeitedInteractionRewards(108);
        vm.revertToState(snap);
        assertGt(full, 0, "LIVE: the entry carries legacy value");

        // Pool headroom = half the value; ample backing means the CAP is
        // the binding (monotone) constraint, so the sweep settles clamped.
        uint256 headroom = full / 2;
        _mut().setInteractionPoolPaidOut(
            LibVaipakam.VPFI_INTERACTION_POOL_CAP - headroom
        );
        uint256 swept = _facet().sweepForfeitedInteractionRewards(108);
        assertEq(
            swept,
            headroom,
            "the sweep credits exactly the remaining headroom, never past it"
        );
        assertTrue(
            _mut().getRewardEntryProcessedRaw(id),
            "and the cap trim is terminal"
        );
    }

    /// @dev Codex #1699 r19 P1(b) — a spanning forfeit's legacy leg DEFERS
    ///      on a backing-bound shortfall with the cursor untouched; stamping
    ///      would strand the unbacked remainder despite that budget
    ///      refilling with the next inflow.
    function testP1bSpanningForfeitLegacyLegDefersOnABackingDip() public {
        _cfg().setRewardClaimHorizonDays(180);
        (uint256 floor5, uint256 recycled5) = _armAndFinalize(5, 0);
        assertGt(floor5, 0, "armed day has a fresh floor");
        assertEq(recycled5, 0, "LIVE: and NO recycled share");

        uint256 id = _seedEntry(alice, 109, 4, 6); // legacy day 4 + armed 5
        _mut().setRewardEntryForfeitedRaw(id);
        _mut().setLoanActiveLenderEntryId(109, id);
        _mut().setInteractionPoolPaidOut(0);

        // The DIP: bucket levelled to the whole balance -> backing room 0
        // while the pool is wide open — the shortfall is backing-caused.
        uint256 bucketBefore = _mut().getRecycleBucketRaw();
        _mut().setRecycleBucketRaw(vpfi.balanceOf(address(diamond)));
        uint256 dip = _facet().sweepForfeitedInteractionRewards(109);
        assertEq(dip, 0, "a backing-bound legacy leg defers");
        assertEq(
            _mut().getRewardEntryClaimNextDayRaw(id),
            0,
            "with the cursor untouched, so nothing is stranded"
        );

        // Backing recovers -> the SAME leg settles in full.
        _mut().setRecycleBucketRaw(bucketBefore);
        uint256 settled = _facet().sweepForfeitedInteractionRewards(109);
        assertGt(settled, 0, "and settles fully once backing recovers");
        assertEq(
            _mut().getRewardEntryClaimNextDayRaw(id),
            5,
            "stamping the cursor only when the leg genuinely settled"
        );
    }

    /// @dev Codex #1699 r20 P1 — an UNPRICED preflight defers. With the
    ///      cumulative cursor 730–1460 days behind, the preflight's bounded
    ///      advance leaves the entry unpriced (preFresh reads zero, the
    ///      backing-defer passes vacuously) while the settle's own second
    ///      bounded advance completes — processing the entry under a
    ///      transient backing clamp and losing the recoverable remainder.
    function testP1bFarBehindLegacyForfeitDefersWhileUnpriced() public {
        _cfg().setRewardClaimHorizonDays(180);
        // Wholly-legacy, FAR out: the cursor starts ~1400 days behind the
        // entry end, so one bounded advance cannot price it.
        _seedPriorDays(1410);
        uint256 id = _seedEntry(alice, 110, 1400, 1405);
        _mut().setRewardEntryForfeitedRaw(id);
        _mut().setLoanActiveLenderEntryId(110, id);
        _mut().setInteractionPoolPaidOut(0);

        // BACKING DIP active: the state where settling early loses value.
        uint256 bucketBefore = _mut().getRecycleBucketRaw();
        _mut().setRecycleBucketRaw(vpfi.balanceOf(address(diamond)));

        // Call 1: preflight advances its bounded stretch but cannot price —
        // the sweep must DEFER, never let the settle's second advance
        // complete under the dip.
        uint256 first = _facet().sweepForfeitedInteractionRewards(110);
        assertEq(first, 0, "an unpriced preflight defers");
        assertFalse(
            _mut().getRewardEntryProcessedRaw(id),
            "the entry is intact - nothing settled under the dip"
        );

        // Backing recovers -> a later sweep (advance now caught up) settles
        // the WHOLE value.
        _mut().setRecycleBucketRaw(bucketBefore);
        uint256 second = _facet().sweepForfeitedInteractionRewards(110);
        assertGt(second, 0, "and the full value settles once priced+backed");
        assertTrue(
            _mut().getRewardEntryProcessedRaw(id),
            "terminalising with nothing lost"
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

    /// Codex #1417 r7 — a MIRROR had to fail-closed on armed-day pricing
    /// until B2-d armed mirror consumption; B2-d has since shipped and the
    /// halt was lifted by #1434 P1-b, so what protects the bucket now is its
    /// own budget term rather than a refusal to price. If it priced the V2 stamp's recycled
    /// equivalents and then debited the LOCAL bucket at claim (canonical
    /// `consume` semantics), a remittance-funded reward would cannibalise
    /// the mirror's own recycled balance — the exact mirror consumption that
    /// is now bounded rather than forbidden. Note WHICH bound does it: the
    /// recycled leg is capped by `PoolBudget.recycled`, seeded from the live
    /// `recycleBucket`, so the bucket cannot be overdrawn. P1-b's
    /// `deliveredFresh` bounds the FRESH leg only — it is what releases this
    /// test's deferral, not what protects the bucket, and on a day with little
    /// fresh liability it protects nothing here at all. An UNFUNDED armed day defers, so a mirror claim
    /// never touches its bucket. Before #1434 P1-b this held for a different
    /// reason — the blanket halt meant armed mirror days never priced at all
    /// — and the funded half below is what distinguishes the two; see its
    /// note. (The test forces the armed state to prove the code invariant.)
    function testMirrorArmedDayUnfundedDefersAndNeverDebitsBucket() public {
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

    // ─── 5b. #1878 — the MIRROR's reserve → consume → release lifecycle ──────
    //
    // `LibVpfiRecycle.reserveMirrorCommit`'s own natspec states the contract
    // this section tests: a mirror reserves its instructed commit and then gets
    // "the identical reserve → consume → release lifecycle Base already runs,
    // with no new primitives: claims retire it via {consume}, forfeits/expiries
    // via {releaseCommitment}."
    //
    // That was a promise with no test. Section 1 and 2 above prove consume and
    // release on the CANONICAL chain, and every mirror-side retirement figure
    // elsewhere in the tree is written by `consumeRecycleRaw` — a mutator that
    // writes the outcome directly, and therefore cannot tell a working
    // retirement from an absent one. The nearest mirror test
    // (`testMirrorArmedDayUnfundedDefersAndNeverDebitsBucket`) broadcasts
    // `recycleConsume: 0`, so the mirror reserves NOTHING and its funded half
    // debits a bucket against no commitment at all.
    //
    // Why it matters before `D*` (#1878): what a mirror ships to Base is
    // `getLocalRecycledCommitRetirement`, and Base sizes the next day's
    // instruction from it. A mirror that consumes but under-retires reports
    // less retirement than it performed, and the error compounds daily on a
    // cutover that cannot be reversed.

    /// @dev The mirror fixture's local recycle balance. A named constant
    ///      because two places asserted the literal `100 ether` and a third
    ///      sized a reservation against it by eye — which is how the second
    ///      release ended up sitting exactly on `releaseCommitment`'s floor
    ///      (Codex #1907 r5).
    /// @dev The day the mirror fixture's broadcast carries. NOT the same as
    ///      `getInteractionCurrentDay()` — setUp warps six days — which is
    ///      exactly the gap that let a credit to the armed day hide (Codex
    ///      #1907 r6).
    uint256 internal constant MIRROR_DAY = 5;

    uint256 internal constant MIRROR_BUCKET = 400 ether;

    /// @dev The instructed reservation. Sized deliberately ABOVE everything a
    ///      day can draw — one consumption OR two releases — because
    ///      `consume` and `releaseCommitment` both FLOOR their retirement at
    ///      the outstanding sum. At the old `100 ether` the second forfeit
    ///      landed exactly on that floor, so an over-large second request
    ///      would have decremented by the remaining balance and passed every
    ///      cumulative check (Codex #1907 r5). Each test asserts the residual
    ///      is non-zero, which is what says the floor stayed out of the way.
    uint256 internal constant MIRROR_RESERVE = 300 ether;

    /// @dev `_seedEntry` with an explicit per-day contribution, so two users
    ///      can split one day's side and each claim SEPARATELY — which is the
    ///      only way to get two live `consume` calls out of one armed day
    ///      (Codex #1907 r5).
    function _seedEntryPerDay(
        address user,
        uint64 loanId,
        uint256 perDay,
        uint32 startDay,
        uint32 endDayExcl
    ) internal returns (uint256 id) {
        id = _mut().pushRewardEntry(
            user, loanId, LibVaipakam.RewardSide.Lender, perDay, startDay
        );
        _mut().closeRewardEntryRaw(id, endDayExcl);
    }

    /// @dev The WHOLE mirror-side ledger in one value. Three rounds running,
    ///      the finding has been "a leg was added and inherited only some of
    ///      the checks its twin has" — so the check-set stops being a list
    ///      each leg re-derives and becomes one snapshot plus one delta rule
    ///      per operation class. A new leg then gets the full set by
    ///      construction rather than by whoever wrote it remembering.
    struct MirrorLedger {
        uint256 outFresh;
        uint256 outRecycled;
        uint256 paidOut;
        uint256 retired;
        uint256 released;
        uint256 bucket;
        uint256 credited;
        uint256 creditedDay;
        uint256 custody;
        uint256 freshPaid;
        uint256 freshRemaining;
    }

    function _snapMirror(uint256 today)
        internal
        view
        returns (MirrorLedger memory m)
    {
        (, m.outFresh, m.outRecycled, m.paidOut) =
            _agg().getGovernorCommitState();
        (m.retired, m.released) = _agg().getLocalRecycledCommitRetirement();
        m.bucket = _cfg().getRecycleBucket();
        m.credited = _cfg().getRecycledCreditedByDay(today);
        m.creditedDay = _cfg().getRecycledCreditedByDay(MIRROR_DAY);
        m.custody = vpfi.balanceOf(address(diamond));
        (m.freshPaid, m.freshRemaining) =
            RewardRemittanceLensFacet(address(diamond)).getDeliveredFreshBound();
    }

    /// @dev An instruction COMMITS and does nothing else — asserted as a
    ///      DELTA so it holds for a later instruction arriving into non-zero
    ///      state, not only for the first one into a zeroed ledger.
    function _assertOnlyReserved(
        MirrorLedger memory b,
        MirrorLedger memory a,
        uint256 amount
    ) internal pure {
        assertGe(a.outRecycled, b.outRecycled, "a reservation never SHRINKS the outstanding sum");
        assertEq(a.outRecycled - b.outRecycled, amount, "it encumbers exactly the instruction");
        assertEq(a.outFresh, b.outFresh, "and nothing on the fresh side");
        assertEq(a.bucket, b.bucket, "it debits no bucket");
        assertEq(a.retired, b.retired, "retires nothing");
        assertEq(a.released, b.released, "releases nothing");
        assertEq(a.paidOut, b.paidOut, "pays nobody");
        assertEq(a.credited, b.credited, "credits no absorption");
        assertEq(a.creditedDay, b.creditedDay, "not on the delivered day either");
        assertEq(a.custody, b.custody, "and moves no tokens");
        assertEq(a.freshPaid, b.freshPaid, "spends no delivered fresh");
        assertEq(a.freshRemaining, b.freshRemaining, "and delivers none");
    }

    /// @dev A RELEASE returns a commitment without spending: the recycled half
    ///      stays in the bucket, the fresh half credits it as genuine
    ///      absorption, and no tokens leave.
    function _assertReleased(
        MirrorLedger memory b,
        MirrorLedger memory a,
        uint256 released,
        uint256 swept
    ) internal pure {
        assertEq(b.outRecycled - a.outRecycled, released, "outstanding fell by the release");
        assertEq(a.retired - b.retired, released, "the SHARED retirement total carries it");
        assertEq(a.released - b.released, released, "and so does the release subset");
        assertEq(a.paidOut, b.paidOut, "a release pays nobody");
        assertEq(a.bucket - b.bucket, swept - released, "the bucket gains the FRESH share only");
        assertEq(a.credited - b.credited, swept - released, "credited[D] carries that same share");
        assertGe(a.custody, b.custody, "and the released tokens never left custody");
    }

    /// @dev Stand this diamond up as a MIRROR (`!isCanonical && baseChainId`).
    function _standUpMirror() internal {
        vm.chainId(CHAIN_ARB);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(false);
        _rep().setRewardMessenger(address(messenger));
    }

    /// @dev An armed day 5 delivered the way a mirror really learns one — in
    ///      band, from Base's broadcast — carrying a non-zero `recycleConsume`
    ///      so the mirror actually RESERVES against its local bucket.
    ///
    ///      `reserve` is deliberately sized well above anything the day can
    ///      consume: `consume` FLOORS its retirement at the outstanding sum, so
    ///      a reservation smaller than the payout would make the retirement
    ///      identity below hold for the wrong reason (both sides pinned at the
    ///      floor). The tests assert the floor did not bind.
    function _mirrorArmedDay5(uint256 reserve) internal {
        _seedPriorDays(5);
        _mut().setGovernorCommitArmedFromDayRaw(5);
        _mut().setRecycleBucketRaw(MIRROR_BUCKET);
        _mirrorBroadcast(MIRROR_DAY, reserve);
    }

    /// @dev One armed-day broadcast, separable so a test can deliver a SECOND
    ///      instruction into non-zero commitment state (Codex #1907 r7).
    ///
    ///      Asserts the delivery moves NO tokens, and the snapshot is taken
    ///      BEFORE it: every other custody baseline in these tests is read
    ///      after delivery, so a reservation that transferred VPFI out of the
    ///      Diamond without touching the bucket or `paidOutRecycled` would
    ///      have been folded into those baselines and every later custody
    ///      assertion would still have passed.
    function _mirrorBroadcast(uint256 dayId, uint256 reserve) internal {
        uint256 custodyBefore = vpfi.balanceOf(address(diamond));
        messenger.deliverBroadcastV2(
            RewardBroadcastV2({
                dayId: dayId,
                globalLenderNumeraire18: G_LENDER,
                globalBorrowerNumeraire18: 15e18,
                capMode: 1,
                capPayloadLender: type(uint256).max,
                capPayloadBorrower: type(uint256).max,
                armedFromDay: 5,
                freshLenderHalf: 100 ether,
                freshBorrowerHalf: 60 ether,
                recycledLenderHalfEquiv: 50 ether,
                recycledBorrowerHalfEquiv: 30 ether,
                recycleConsume: reserve,
                keeperAllocate: 0,
                destChainId: CHAIN_ARB
            })
        );
        assertEq(
            vpfi.balanceOf(address(diamond)),
            custodyBefore,
            "the instruction moved no tokens: it COMMITS, it does not spend"
        );
    }

    /// @dev Codex #1907 r1+r2 — every baseline in these tests is read AFTER the
    ///      broadcast, so a reservation with side effects hides inside the
    ///      baseline itself and every later delta-comparison still passes.
    ///      Round 1 named the retirement counters, round 2 named `credited[D]`;
    ///      the RULE is the whole post-broadcast state, so it is asserted in
    ///      one place both tests call rather than as a growing list of the
    ///      fields somebody has thought of.
    ///
    ///      What it says: an instruction COMMITS and does nothing else. It
    ///      encumbers `reserve`, and it must not debit the bucket (the double
    ///      charge `reserveMirrorCommit`'s own note exists to prevent), report
    ///      a retirement or release, pay anyone, or feed the absorption
    ///      average that sizes future budgets.
    function _assertReservationOnlyEncumbers(uint256 reserve, uint256 today)
        internal
        view
    {
        // Codex #1907 r6 — `today` is NOT the delivered day. The fixture warps
        // six days at setUp, so `getInteractionCurrentDay()` returns 6 while
        // the broadcast carries day 5; a reservation that credited
        // `recycledCreditedByDay[5]` inflated the ARMED day's absorption
        // series and passed every check here. Both days are asserted now.
        assertEq(
            _cfg().getRecycledCreditedByDay(MIRROR_DAY),
            0,
            "the DELIVERED day's absorption series is untouched too"
        );
        // Codex #1907 r6 — and the broadcast must not have moved the
        // delivered-fresh ledger. The tests install synthetic funding with
        // `setArmedFreshLedgerRaw` immediately after this, which OVERWRITES
        // both halves — so a broadcast that booked `freshLenderHalf` as
        // received funding, or as already-paid, was erased before anything
        // could observe it. On a mirror that is either spending against
        // funding that never arrived or suppressing later headroom.
        (uint256 freshPaid, uint256 freshRemaining) =
            RewardRemittanceLensFacet(address(diamond)).getDeliveredFreshBound();
        assertEq(freshPaid, 0, "the broadcast paid no delivered fresh");
        assertEq(freshRemaining, 0, "and delivered no fresh headroom");
        (, uint256 outstandingFresh, uint256 outstanding, uint256 paid) =
            _agg().getGovernorCommitState();
        (uint256 retired, uint256 released) =
            _agg().getLocalRecycledCommitRetirement();
        assertEq(outstanding, reserve, "the instruction encumbered locally");
        // Codex #1907 r4 — and encumbered NOTHING on the fresh side. The tuple
        // carries both, and discarding the fresh one let a phantom fresh
        // reservation hide behind a helper whose whole claim is "only
        // encumbers `reserve`". Each entry would then retire part of a
        // commitment nobody made, leaving wrong fresh headroom.
        assertEq(outstandingFresh, 0, "and encumbered nothing on the fresh side");
        assertEq(
            _cfg().getRecycleBucket(), MIRROR_BUCKET, "and debited nothing"
        );
        assertEq(retired, 0, "a reservation retires nothing");
        assertEq(released, 0, "a reservation releases nothing");
        assertEq(paid, 0, "a reservation pays nobody");
        assertEq(
            _cfg().getRecycledCreditedByDay(today),
            0,
            "an encumbrance is not absorption: credited[D] untouched"
        );
    }

    /// @notice #1878 — a live mirror CLAIM retires the commitment it consumed.
    ///
    ///         The four figures must move by ONE number: the bucket debit, the
    ///         outstanding decrement, the retired cumulative Base reads, and
    ///         the `paidOutRecycled` transparency counter. Asserting only that
    ///         the bucket fell (the strongest mirror assertion in the tree
    ///         before this) leaves the reporting half — the half `D*` is sized
    ///         from — entirely unpinned.
    function testMirrorReservedCommitIsRetiredByALiveClaim() public {
        _standUpMirror();
        _mirrorArmedDay5(MIRROR_RESERVE);

        (uint256 today, ) = _lens().getInteractionCurrentDay();
        _assertReservationOnlyEncumbers(MIRROR_RESERVE, today);

        (, , uint256 outBefore, uint256 paidBefore) =
            _agg().getGovernorCommitState();
        (uint256 retiredBefore, uint256 releasedBefore) =
            _agg().getLocalRecycledCommitRetirement();
        uint256 bucketBefore = _cfg().getRecycleBucket();
        uint256 creditedBefore = _cfg().getRecycledCreditedByDay(today);

        // The day's own recycled budget, read from the stamp the MIRROR stored
        // from the broadcast — an anchor independent of anything the claim
        // does. `consumed` below is derived from the bucket delta, so it is a
        // reference point, not a check: a claim that consumed the same share
        // TWICE would move all four ledger figures together and satisfy every
        // identity (Codex #1907 r2). Only an outside expectation catches it.
        LibVaipakam.ChainDayFunding memory funding =
            _agg().getChainDayRecycledFunding(5, uint32(CHAIN_ARB));
        uint256 expectLenderShare = funding.lenderHalfEquiv;

        // Codex #1907 r5 — TWO claimants split the day's lender side, so the
        // fixture performs two live consumptions. With one, a `consume` that
        // OVERWROTE `recycleCommitRetiredCumulative` (and `paidOutRecycled`)
        // with the latest claim instead of accumulating would pass every
        // assertion, and Base would receive only the last claim as this
        // mirror's lifetime retirement.
        address bob = makeAddr("mirror-bob");
        _seedEntryPerDay(alice, 90, G_LENDER / 2, 5, 6);
        _seedEntryPerDay(bob, 93, G_LENDER / 2, 5, 6);
        // P1-b: the FRESH leg needs a delivered bound before the armed day
        // prices at all. Without it the day defers and nothing is consumed —
        // which is the neighbouring test's subject, not this one's.
        _mut().setArmedFreshLedgerRaw(1_000 ether, 0);

        // Codex #1907 r4, predicted sibling of the forfeit's custody check:
        // the ledger says the bucket was debited, and only a balance
        // comparison says the tokens actually went to the CLAIMANT rather
        // than somewhere else. A consumption moves tokens; a release does not.
        uint256 custodyBefore = vpfi.balanceOf(address(diamond));
        uint256 aliceBefore = vpfi.balanceOf(alice);

        vm.prank(alice);
        (uint256 paid, , ) = RewardClaimFacet(address(diamond))
            .claimInteractionRewardsTo(LibVaipakam.RewardDelivery.Wallet);

        // Codex #1907 r7 — anchor `paid` ITSELF. I declined this last round on
        // the grounds that the fresh leg has its own coverage, and that reason
        // does not survive the argument: `paid` is the custody REFERENCE here,
        // so a payout that omitted the recycled or the fresh half would drag
        // BOTH balance assertions down with it and pass. Each of the two
        // claimants splits the day's lender side, so each is owed half of that
        // side's fresh + recycled halves.
        uint256 expectPayout =
            (funding.freshLenderHalf + funding.lenderHalfEquiv) / 2;
        assertApproxEqAbs(
            paid, expectPayout, 1e6, "the claim paid this claimant's whole share"
        );
        assertEq(
            vpfi.balanceOf(alice) - aliceBefore,
            paid,
            "the claimant received what the claim reported paying"
        );
        assertEq(
            custodyBefore - vpfi.balanceOf(address(diamond)),
            paid,
            "and the Diamond parted with exactly that, nothing leaked"
        );

        uint256 consumed = bucketBefore - _cfg().getRecycleBucket();
        assertGt(consumed, 0, "the funded armed day consumed from the bucket");
        // The two entries split the lender side of day 5, so this claim's
        // expected draw is HALF that side's recycled budget. Dust tolerance
        // covers the per-side integer division, nothing more.
        assertApproxEqAbs(
            consumed,
            expectLenderShare / 2,
            1e6,
            "consumed exactly this claimant's recycled share, ONCE"
        );

        (, , uint256 outAfter, uint256 paidAfter) =
            _agg().getGovernorCommitState();
        (uint256 retiredAfter, uint256 releasedAfter) =
            _agg().getLocalRecycledCommitRetirement();

        uint256 bucketAfterFirst = _cfg().getRecycleBucket();

        // The floor did NOT bind, so the equalities below are the retirement
        // identity rather than two exhausted counters agreeing at zero.
        assertGt(outAfter, 0, "reservation outlived the claim (floor unbound)");

        assertEq(
            outBefore - outAfter,
            consumed,
            "outstanding retired by exactly what the claim consumed"
        );
        assertEq(
            retiredAfter - retiredBefore,
            consumed,
            "the cumulative this mirror REPORTS to Base moved by the same"
        );
        assertEq(
            paidAfter - paidBefore,
            consumed,
            "paidOutRecycled moved by the same"
        );
        // Codex #1907 r1 — and the RELEASE cumulative must NOT move. The two
        // cumulatives are not interchangeable on Base: a release restores the
        // mirror's availability because the tokens stayed in the bucket, while
        // a consumption spent them. A claim that reported its payout as a
        // release would make already-spent tokens committable again.
        assertEq(
            releasedAfter,
            releasedBefore,
            "a claim SPENDS; it must never report a release"
        );

        // ── The SECOND live consumption (Codex #1907 r5) ────────────────────
        //
        // Self-review: the first claim carries a custody-conservation pair and
        // the second was added without one. Same omission shape as the
        // unanchored second RELEASE — an assertion that exists three lines
        // away from where its twin belongs.
        uint256 custodyMid = vpfi.balanceOf(address(diamond));
        uint256 bobBefore = vpfi.balanceOf(bob);

        vm.prank(bob);
        (uint256 paid2, , ) = RewardClaimFacet(address(diamond))
            .claimInteractionRewardsTo(LibVaipakam.RewardDelivery.Wallet);

        assertApproxEqAbs(
            paid2,
            expectPayout,
            1e6,
            "and the second claim paid the second claimant's whole share"
        );
        assertEq(
            vpfi.balanceOf(bob) - bobBefore,
            paid2,
            "the second claimant received what their claim reported paying"
        );
        assertEq(
            custodyMid - vpfi.balanceOf(address(diamond)),
            paid2,
            "and the Diamond parted with exactly that, nothing leaked"
        );

        uint256 consumed2 = bucketAfterFirst - _cfg().getRecycleBucket();
        assertApproxEqAbs(
            consumed2,
            expectLenderShare / 2,
            1e6,
            "the second claimant drew their OWN share, not a remainder"
        );

        (, , uint256 outEnd, uint256 paidEnd) = _agg().getGovernorCommitState();
        (uint256 retiredEnd, uint256 releasedEnd) =
            _agg().getLocalRecycledCommitRetirement();

        // Codex #1907 r6 — the aggregate outstanding decrement, and the
        // release cumulative still standing still. Reading only the retired
        // total let a second `consume` pass while leaving
        // `outstandingCommitRecycled` untouched (an incomplete local
        // reservation reported to Base) or while ALSO advancing the release
        // cumulative (spent tokens made to look released).
        assertEq(
            outBefore - outEnd,
            consumed + consumed2,
            "outstanding fell by BOTH claims together"
        );
        assertEq(
            releasedEnd,
            releasedBefore,
            "and neither claim reported a release"
        );
        // Same fixture property on the claim side (Codex #1907 r5): the two
        // claimants together draw the whole lender-side share, so the
        // reservation must exceed it for `consume`'s floor to stay out of the
        // way.
        assertGt(
            MIRROR_RESERVE,
            2 * (expectLenderShare / 2),
            "reservation must exceed BOTH claims, or the floor is in play"
        );
        assertGt(outEnd, 0, "and a residual survives both");
        assertEq(
            retiredEnd - retiredBefore,
            consumed + consumed2,
            "the retired cumulative CONTAINS both claims, it is not the last"
        );
        assertEq(
            paidEnd - paidBefore,
            consumed + consumed2,
            "and so does paidOutRecycled"
        );
        // Same class, predicted rather than reported: spending the bucket is
        // not ABSORBING into it. `credited[D]` feeds the trailing average that
        // sizes future budgets, so a consumption that credited it would let a
        // mirror inflate tomorrow's runway with tokens it just paid away.
        assertEq(
            _cfg().getRecycledCreditedByDay(today),
            creditedBefore,
            "a claim credits nothing; consumption is not absorption"
        );

        // ── A SECOND instruction, into non-zero state (Codex #1907 r7) ──────
        //
        // Every fixture so far delivers one broadcast into zeroed commitment
        // state, so replacing `reserveMirrorCommit`'s `+=` with `=` satisfied
        // all of it. A mirror really does receive a later day's instruction
        // while earlier claims are still outstanding; overwriting that
        // residual would overstate local availability and lose the earlier
        // commitment's reporting.
        uint256 secondInstruction = 40 ether;
        // Codex #1907 r9 — the FULL reservation-only delta, not just the
        // recycled sum. This is the suite's only multi-reservation scenario,
        // and a state-dependent regression that added the instruction
        // correctly while also debiting the bucket, crediting day-6
        // absorption, touching delivered-fresh state or creating a fresh
        // commitment passed the narrower check.
        MirrorLedger memory beforeSecond = _snapMirror(today);
        _mirrorBroadcast(MIRROR_DAY + 1, secondInstruction);
        MirrorLedger memory afterSecond = _snapMirror(today);
        _assertOnlyReserved(beforeSecond, afterSecond, secondInstruction);

        uint256 outAfterSecond = afterSecond.outRecycled;

        // ── Consumption and release against ONE reservation (r7) ────────────
        //
        // The two lifecycle tests run in separate fresh fixtures, so the
        // forfeit never starts with a consumed retirement and the claim never
        // starts with a release. A primitive that overwrote the SHARED
        // `recycleCommitRetiredCumulative` with its own operation-class
        // subtotal would pass both — and erase previously reported retirement
        // the moment a real mirror interleaved the two.
        uint256 forfeitId = _seedEntryPerDay(alice, 94, G_LENDER / 2, 5, 6);
        _mut().setRewardEntryForfeitedRaw(forfeitId);
        _mut().setLoanActiveLenderEntryId(94, forfeitId);

        // Codex #1907 r9 — snapshot around it: the interleaved sweep discarded
        // its own return and checked none of the bucket, absorption or custody
        // deltas, so a stateful regression could release the right recycled
        // half while omitting or miscrediting the fresh one.
        MirrorLedger memory beforeForfeit = _snapMirror(today);
        vm.prank(makeAddr("mirror-keeper"));
        uint256 sweptHere = _facet().sweepForfeitedInteractionRewards(94);
        MirrorLedger memory afterForfeit = _snapMirror(today);

        uint256 outFinal = afterForfeit.outRecycled;
        uint256 paidFinal = afterForfeit.paidOut;
        uint256 retiredFinal = afterForfeit.retired;
        uint256 releasedFinal = afterForfeit.released;
        uint256 releasedHere = outAfterSecond - outFinal;
        _assertReleased(beforeForfeit, afterForfeit, releasedHere, sweptHere);
        assertGt(releasedHere, 0, "the interleaved forfeit released something");
        // Codex #1907 r8 — anchored like the two standalone releases. Every
        // cumulative expectation below is derived from `releasedHere`, so a
        // release path that under-released only AFTER the prior claims and the
        // second reservation — 1 wei, entry still marked processed — satisfied
        // all three while stranding the remainder. Which is precisely the
        // stateful case this leg was added to prove.
        assertApproxEqAbs(
            releasedHere,
            funding.lenderHalfEquiv / 2,
            1e6,
            "the interleaved release is its own stamped share"
        );

        assertEq(
            retiredFinal - retiredBefore,
            consumed + consumed2 + releasedHere,
            "shared retirement CONTAINS both operation classes"
        );
        assertEq(
            releasedFinal - releasedBefore,
            releasedHere,
            "the release subset carries only the release"
        );
        assertEq(
            paidFinal - paidBefore,
            consumed + consumed2,
            "and the payout counter only the consumptions"
        );
    }

    /// @notice #1878 — a live mirror FORFEIT releases the commitment instead of
    ///         consuming it: outstanding falls and the RELEASED cumulative
    ///         rises, while the bucket keeps the tokens and `paidOutRecycled`
    ///         does not move (nothing was paid to anyone).
    ///
    ///         The canonical twin is `testRecycledForfeitReleasesWithoutCredit`;
    ///         this is the mirror side of the same rule, which nothing drove
    ///         through a live entry point before.
    function testMirrorReservedCommitIsReleasedByAForfeit() public {
        _standUpMirror();
        _mirrorArmedDay5(MIRROR_RESERVE);

        (uint256 today, ) = _lens().getInteractionCurrentDay();
        _assertReservationOnlyEncumbers(MIRROR_RESERVE, today);

        _mut().setArmedFreshLedgerRaw(1_000 ether, 0);
        uint256 id = _seedEntry(alice, 91, 5, 6);
        _mut().setRewardEntryForfeitedRaw(id);
        _mut().setLoanActiveLenderEntryId(91, id);

        (, , uint256 outBefore, uint256 paidBefore) =
            _agg().getGovernorCommitState();
        (uint256 retiredBefore, uint256 releasedBefore) =
            _agg().getLocalRecycledCommitRetirement();
        uint256 bucketBefore = _cfg().getRecycleBucket();
        uint256 creditedBefore = _cfg().getRecycledCreditedByDay(today);
        // Codex #1907 r4 — the ledger deltas below are all satisfied by a
        // sweep that moves the recycled share OUT of the Diamond while
        // leaving `recycleBucket` untouched: the bucket would then be
        // ledger-correct and physically unbacked, and the next recycled claim
        // either fails or spends unrelated custody. A release moves no
        // tokens, so the Diamond's balance cannot fall.
        uint256 custodyBefore = vpfi.balanceOf(address(diamond));

        // Codex #1907 r3 — the same independent anchor the claim test uses,
        // on the site I should have swept when I added it there. `released`
        // below is derived from the outstanding delta, so an UNDERSIZED
        // recycled component satisfies every identity: both cumulatives move
        // by that same smaller number, and `swept - released` is still exactly
        // what the facet credited. The entry is processed either way, so the
        // omitted entitlement stays outstanding forever and the mirror
        // under-reports retirement to Base.
        LibVaipakam.ChainDayFunding memory funding =
            _agg().getChainDayRecycledFunding(5, uint32(CHAIN_ARB));

        vm.prank(makeAddr("mirror-keeper"));
        uint256 swept = _facet().sweepForfeitedInteractionRewards(91);

        (, , uint256 outAfter, uint256 paidAfter) =
            _agg().getGovernorCommitState();
        (uint256 retiredAfter, uint256 releasedAfter) =
            _agg().getLocalRecycledCommitRetirement();

        uint256 released = outBefore - outAfter;
        assertGt(released, 0, "the forfeit released a recycled commitment");
        assertApproxEqAbs(
            released,
            funding.lenderHalfEquiv,
            1e6,
            "released the lender side's WHOLE recycled share, not a slice"
        );
        // Predicted sibling: `swept` is the facet's own return, so the two
        // assertions below that spend it would move WITH an undersized fresh
        // leg. Anchor the sweep total on the stored funding record too, so
        // both legs are pinned to something outside the engine.
        assertApproxEqAbs(
            swept,
            funding.freshLenderHalf + funding.lenderHalfEquiv,
            1e6,
            "the sweep took the lender side's fresh AND recycled halves"
        );
        assertGt(outAfter, 0, "reservation outlived the forfeit (floor unbound)");
        assertEq(
            releasedAfter - releasedBefore,
            released,
            "the RELEASED cumulative carries it, not the retired one"
        );
        assertEq(
            paidAfter,
            paidBefore,
            "a release pays nobody, so paidOutRecycled must not move"
        );
        // Codex #1907 r1 — the RETIRED cumulative rises too. `releaseCommitment`
        // feeds both: the release-only subset AND the shared retirement total,
        // and Base CLAMPS a reported release to the retired figure. A release
        // that advanced only its own subset would break the
        // `released <= retired` invariant and be clamped away on arrival --
        // the mirror's availability would never be restored even though the
        // local reservation had genuinely disappeared.
        assertEq(
            retiredAfter - retiredBefore,
            released,
            "a release advances the shared retirement total as well"
        );

        // Codex #1907 r1 — pin the bucket DELTA, not its direction. A mirror
        // that credited the released share into the bucket on top of the
        // legitimate fresh absorption would inflate its reported recycled
        // availability for tokens that never left. The fresh portion is
        // exactly what the sweep moved less what it released.
        assertEq(
            _cfg().getRecycleBucket() - bucketBefore,
            swept - released,
            "the bucket gains the FRESH share only, never the released one"
        );
        // Same rule one layer down: credited[D] feeds the trailing absorption
        // average, so the released share must not reach it either.
        assertEq(
            _cfg().getRecycledCreditedByDay(today) - creditedBefore,
            swept - released,
            "credited[D] carries the fresh share only"
        );
        // Caveat, recorded because proving this check found it: this fixture's
        // treasury IS the Diamond, so value moved to TREASURY is invisible
        // here. The check catches value leaving the Diamond entirely, which is
        // the regression it is aimed at; a deployment with an external
        // treasury would need the treasury balance watched too.
        assertGe(
            vpfi.balanceOf(address(diamond)),
            custodyBefore,
            "a release moves no tokens: the bucket stays physically backed"
        );

        // Codex #1907 r4 — a SECOND forfeit, because one cannot tell a
        // cumulative counter from a last-write one. Swapping `+=` for `=` in
        // the release path satisfies every assertion above; Base would then
        // see only the latest retirement and never restore availability for
        // the earlier one.
        uint256 id2 = _seedEntry(alice, 92, 5, 6);
        _mut().setRewardEntryForfeitedRaw(id2);
        _mut().setLoanActiveLenderEntryId(92, id2);

        (, , uint256 outMid, uint256 paidMid) = _agg().getGovernorCommitState();
        uint256 bucketMid = _cfg().getRecycleBucket();
        uint256 creditedMid = _cfg().getRecycledCreditedByDay(today);
        uint256 custodyMid = vpfi.balanceOf(address(diamond));

        vm.prank(makeAddr("mirror-keeper"));
        uint256 swept2 = _facet().sweepForfeitedInteractionRewards(92);

        (, , uint256 outEnd, uint256 paidEnd) = _agg().getGovernorCommitState();
        (uint256 retiredEnd, uint256 releasedEnd) =
            _agg().getLocalRecycledCommitRetirement();
        uint256 released2 = outMid - outEnd;
        assertGt(released2, 0, "the second forfeit released as well");
        // Codex #1907 r5 — anchored like the first. `released2` is derived
        // from the outstanding delta, so a second sweep that released 1 wei,
        // marked the entry processed and advanced both cumulatives by that
        // same wei would satisfy every sum below while leaving the second
        // entry's entitlement outstanding forever.
        assertApproxEqAbs(
            released2,
            funding.lenderHalfEquiv,
            1e6,
            "the second release is its own WHOLE share, not a remainder"
        );
        // Codex #1907 r5 — the floor could not have bound, and this is the
        // assertion that says so. `assertGt(outEnd, 0)` was NOT enough: at the
        // old 100 ether reservation the two 50-ether releases left ~40 wei, so
        // a positive residual passed while the second release sat exactly on
        // `releaseCommitment`'s floor. What has to hold is a property of the
        // FIXTURE — the reservation strictly exceeds everything the day can
        // release — so a later edit that shrinks it fails here rather than
        // silently re-arming the trap.
        assertGt(
            MIRROR_RESERVE,
            2 * funding.lenderHalfEquiv,
            "reservation must exceed BOTH releases, or the floor is in play"
        );
        assertGt(outEnd, 0, "and a residual survives both");
        assertEq(
            releasedEnd - releasedBefore,
            released + released2,
            "the released cumulative CONTAINS both, it does not track the last"
        );
        assertEq(
            retiredEnd - retiredBefore,
            released + released2,
            "and so does the shared retirement total"
        );

        // Codex #1907 r6 — the second sweep gets every check the first has.
        // It was added to prove the release counters accumulate and then
        // discarded its own `swept`, so a same-day state bug that released the
        // recycled half correctly while omitting or miscrediting the SECOND
        // fresh absorption — or moving tokens out — satisfied `released2` and
        // both sums while corrupting the bucket and the absorption average.
        assertApproxEqAbs(
            swept2,
            funding.freshLenderHalf + funding.lenderHalfEquiv,
            1e6,
            "the second sweep took its own fresh AND recycled halves"
        );
        assertEq(
            _cfg().getRecycleBucket() - bucketMid,
            swept2 - released2,
            "the bucket gains the second FRESH share only"
        );
        assertEq(
            _cfg().getRecycledCreditedByDay(today) - creditedMid,
            swept2 - released2,
            "and credited[D] carries that same fresh share"
        );
        assertEq(
            paidEnd,
            paidMid,
            "a release pays nobody, on the second sweep as on the first"
        );
        assertGe(
            vpfi.balanceOf(address(diamond)),
            custodyMid,
            "and the second release moves no tokens either"
        );
    }

    /// @notice #1878 (Codex #1907 r8) — the BORROWER side of the same
    ///         lifecycle. Every other fixture here creates `RewardSide.Lender`
    ///         entries only, while the live pricing code carries separate
    ///         borrower denominators and its own `freshBorrowerHalf` /
    ///         `recycledBorrowerHalfEquiv` stamp fields.
    ///
    ///         The fixture's two sides are deliberately ASYMMETRIC. While they
    ///         carried identical figures, a regression that routed a borrower
    ///         claim through the LENDER fields was invisible by construction —
    ///         the wrong number and the right number were the same number.
    ///         This test anchors on the borrower stamp and asserts the sides
    ///         differ, so reading the wrong one cannot pass.
    function testMirrorBorrowerSideConsumesItsOwnStampedShare() public {
        _standUpMirror();
        _mirrorArmedDay5(MIRROR_RESERVE);

        (uint256 today, ) = _lens().getInteractionCurrentDay();
        _assertReservationOnlyEncumbers(MIRROR_RESERVE, today);

        LibVaipakam.ChainDayFunding memory funding =
            _agg().getChainDayRecycledFunding(MIRROR_DAY, uint32(CHAIN_ARB));
        // Non-vacuity: the whole point is that the two sides are distinct.
        assertTrue(
            funding.borrowerHalfEquiv != funding.lenderHalfEquiv,
            "the fixture's sides must differ or this test proves nothing"
        );
        assertTrue(
            funding.freshBorrowerHalf != funding.freshLenderHalf,
            "and their fresh halves too"
        );

        _mut().setArmedFreshLedgerRaw(1_000 ether, 0);

        // TWO borrower-side entries splitting the borrower side: one claimed,
        // one forfeited, so this fixture exercises BOTH operation classes on
        // the borrower stamp (Codex #1907 r9 — every sweep in the suite used a
        // lender entry, so a borrower forfeit routed through the lender stamp,
        // or never releasing at all, left everything green).
        uint256 id = _mut().pushRewardEntry(
            alice, 95, LibVaipakam.RewardSide.Borrower, 15e18 / 2, 5
        );
        _mut().closeRewardEntryRaw(id, 6);
        // The forfeited entry belongs to a DIFFERENT holder on purpose. A
        // claim absorbs the CLAIMANT's own forfeited entries — the trace shows
        // `RewardCommitmentReleased` firing inside `claimInteractionRewardsTo`
        // — so an alice-owned forfeit would be settled by alice's claim and
        // the keeper sweep would have nothing left to do.
        uint256 forfeitId = _mut().pushRewardEntry(
            makeAddr("mirror-carol"),
            96,
            LibVaipakam.RewardSide.Borrower,
            15e18 / 2,
            5
        );
        _mut().closeRewardEntryRaw(forfeitId, 6);
        _mut().setRewardEntryForfeitedRaw(forfeitId);
        _mut().setLoanBorrowerEntryId(96, forfeitId);

        uint256 bucketBefore = _cfg().getRecycleBucket();
        (, , uint256 outBefore, uint256 paidBefore) =
            _agg().getGovernorCommitState();
        (uint256 retiredBefore, ) = _agg().getLocalRecycledCommitRetirement();

        vm.prank(alice);
        (uint256 paid, , ) = RewardClaimFacet(address(diamond))
            .claimInteractionRewardsTo(LibVaipakam.RewardDelivery.Wallet);

        uint256 consumed = bucketBefore - _cfg().getRecycleBucket();
        assertApproxEqAbs(
            consumed,
            funding.borrowerHalfEquiv / 2,
            1e6,
            "consumed the BORROWER side's recycled share, not the lender's"
        );
        assertApproxEqAbs(
            paid,
            (funding.freshBorrowerHalf + funding.borrowerHalfEquiv) / 2,
            1e6,
            "and paid the borrower side's fresh + recycled halves"
        );

        (, , uint256 outAfter, uint256 paidAfter) =
            _agg().getGovernorCommitState();
        (uint256 retiredAfter, ) = _agg().getLocalRecycledCommitRetirement();
        assertEq(
            outBefore - outAfter, consumed, "borrower-side retirement lands too"
        );
        assertEq(retiredAfter - retiredBefore, consumed, "and is reported");
        assertEq(paidAfter - paidBefore, consumed, "and paid out");

        // ── the borrower FORFEIT (Codex #1907 r9) ───────────────────────────
        MirrorLedger memory beforeSweep = _snapMirror(today);
        vm.prank(makeAddr("mirror-keeper"));
        uint256 swept = _facet().sweepForfeitedInteractionRewards(96);
        MirrorLedger memory afterSweep = _snapMirror(today);

        uint256 released = beforeSweep.outRecycled - afterSweep.outRecycled;
        assertApproxEqAbs(
            released,
            funding.borrowerHalfEquiv / 2,
            1e6,
            "released the BORROWER side's recycled share, not the lender's"
        );
        assertApproxEqAbs(
            swept,
            (funding.freshBorrowerHalf + funding.borrowerHalfEquiv) / 2,
            1e6,
            "and swept the borrower side's fresh + recycled halves"
        );
        _assertReleased(beforeSweep, afterSweep, released, swept);
    }

    /// @notice #1878 (Codex #1907 r10) — the CLAIM path's own release leg.
    ///
    ///         `RewardClaimFacet` has a `forfeitRecycled -> releaseCommitment`
    ///         call of its own, separate from the keeper facet's. The previous
    ///         round moved the forfeited entry to another holder precisely so
    ///         the keeper sweep would be observable — and in doing so removed
    ///         the only case that exercised this leg. Remove or convert that
    ///         call to a consumption and the entry still terminalises while its
    ///         reservation is stranded or wrongly spent, with every other test
    ///         here still green.
    ///
    ///         One claimant, one claim, both classes: the payable entry is
    ///         CONSUMED, the forfeited one is RELEASED, and the three counters
    ///         keep their respective subsets.
    function testMirrorClaimReleasesTheClaimantsOwnForfeitedEntry() public {
        _standUpMirror();
        _mirrorArmedDay5(MIRROR_RESERVE);

        (uint256 today, ) = _lens().getInteractionCurrentDay();
        _assertReservationOnlyEncumbers(MIRROR_RESERVE, today);

        LibVaipakam.ChainDayFunding memory funding =
            _agg().getChainDayRecycledFunding(MIRROR_DAY, uint32(CHAIN_ARB));
        _mut().setArmedFreshLedgerRaw(1_000 ether, 0);

        // Codex #1907 r12 — a RELEASE lands FIRST, before any consumption.
        // The only other mixed-operation fixture always claims before it
        // forfeits, so it proves a release preserves earlier consumption but
        // not the reverse: a `consume` that replaced the shared retirement
        // total with its own class subtotal would pass that ordering and erase
        // a previously reported release here.
        uint256 preForfeited = _seedEntryPerDay(
            makeAddr("mirror-eve"), 101, G_LENDER / 4, 5, 6
        );
        _mut().setRewardEntryForfeitedRaw(preForfeited);
        _mut().setLoanActiveLenderEntryId(101, preForfeited);
        vm.prank(makeAddr("mirror-keeper"));
        _facet().sweepForfeitedInteractionRewards(101);
        (uint256 retiredAfterPre, uint256 releasedAfterPre) =
            _agg().getLocalRecycledCommitRetirement();
        assertGt(releasedAfterPre, 0, "the pre-claim release landed");

        // Same claimant, two entries splitting the lender side: one payable,
        // one forfeited. A claim settles BOTH.
        _seedEntryPerDay(alice, 97, G_LENDER / 2, 5, 6);
        uint256 forfeited = _seedEntryPerDay(alice, 98, G_LENDER / 2, 5, 6);
        _mut().setRewardEntryForfeitedRaw(forfeited);
        _mut().setLoanActiveLenderEntryId(98, forfeited);

        MirrorLedger memory b = _snapMirror(today);

        uint256 aliceBefore = vpfi.balanceOf(alice);

        vm.prank(alice);
        (uint256 paid, , ) = RewardClaimFacet(address(diamond))
            .claimInteractionRewardsTo(LibVaipakam.RewardDelivery.Wallet);

        MirrorLedger memory a = _snapMirror(today);

        // The two classes are read from the counters that distinguish them —
        // NOT from the bucket, which moves in both directions here (a
        // consumption debits it, the forfeit's FRESH share credits it).
        uint256 consumed = a.paidOut - b.paidOut;
        uint256 released = a.released - b.released;
        uint256 expectHalf = funding.lenderHalfEquiv / 2;

        assertApproxEqAbs(
            consumed, expectHalf, 1e6, "the payable entry's share was CONSUMED"
        );
        assertApproxEqAbs(
            released, expectHalf, 1e6, "the forfeited entry's share was RELEASED"
        );
        assertEq(
            a.retired - b.retired,
            consumed + released,
            "shared retirement carries both, from ONE claim"
        );
        assertEq(
            b.outRecycled - a.outRecycled,
            consumed + released,
            "and the reservation fell by both"
        );
        // Codex #1907 r12 — the earlier RELEASE survives this consumption.
        assertEq(
            a.released - releasedAfterPre,
            released,
            "the pre-claim release is still in the release subset"
        );
        assertEq(
            a.retired - retiredAfterPre,
            consumed + released,
            "and the shared total grew on top of it, not over it"
        );
        // The release leg must not be quietly re-classified as a spend.
        assertEq(
            consumed, a.paidOut - b.paidOut, "the payout counter holds only the consumption"
        );

        // Codex #1907 r11 — the aggregation state's OTHER effects. Checking
        // only the commitment counters let the claim fold the forfeited share
        // into the user's payout, or credit the recycled forfeit as fresh
        // absorption, and still pass. The isolated claim and forfeit fixtures
        // never see this state.
        uint256 payableShare =
            (funding.freshLenderHalf + funding.lenderHalfEquiv) / 2;
        assertApproxEqAbs(
            paid,
            payableShare,
            1e6,
            "the payout is the PAYABLE entry's share only, not the forfeited one"
        );
        assertEq(
            vpfi.balanceOf(alice) - aliceBefore,
            paid,
            "and the claimant received exactly that"
        );

        // Absorption is the forfeited entry's FRESH half — the recycled half
        // never left the bucket, so it must not appear here.
        uint256 creditedDelta = a.credited - b.credited;
        assertApproxEqAbs(
            creditedDelta,
            funding.freshLenderHalf / 2,
            1e6,
            "credited[D] carries the forfeit's FRESH share only"
        );
        // Net bucket movement: the consumption debits, the forfeit's fresh
        // share credits. Both directions in one call, which is why the two
        // classes are read from counters above rather than from this number.
        assertEq(
            a.bucket + consumed - b.bucket,
            creditedDelta,
            "bucket nets the consumption against the fresh absorption"
        );
        assertEq(
            b.custody - a.custody,
            paid,
            "and custody fell by exactly what was paid out"
        );

        // Codex #1907 r12 — the delivered-fresh charge covers BOTH fresh legs,
        // the user's and the treasury's. Charging only one half left the mirror
        // with apparent headroom it had not earned, for later armed-day
        // spending, while every payout, bucket, custody and commitment
        // assertion above still passed.
        // Dust tolerance, as everywhere else here: the side splits in two and
        // each half loses a wei to integer division.
        assertApproxEqAbs(
            a.freshPaid - b.freshPaid,
            funding.freshLenderHalf,
            1e6,
            "delivered fresh is charged for the payable AND forfeited legs"
        );
        assertEq(
            b.freshRemaining - a.freshRemaining,
            a.freshPaid - b.freshPaid,
            "and the remaining bound falls by exactly what was charged"
        );
    }

    /// @notice #1878 (Codex #1907 r10) — the EXPIRY release path, live, on a
    ///         mirror. `reserveMirrorCommit`'s natspec names three ways a
    ///         reservation retires — "claims retire it via {consume},
    ///         forfeits/expiries via {releaseCommitment}" — and this card's
    ///         scope says the same. Claim and forfeit were covered; RL-3
    ///         expiry, served by its own facet with its own
    ///         `releaseCommitment` call, was not.
    function testMirrorExpiryReleasesTheReservedCommitment() public {
        _cfg().setRewardClaimHorizonDays(180);
        _standUpMirror();
        _mirrorArmedDay5(MIRROR_RESERVE);

        (uint256 today, ) = _lens().getInteractionCurrentDay();
        _assertReservationOnlyEncumbers(MIRROR_RESERVE, today);

        LibVaipakam.ChainDayFunding memory funding =
            _agg().getChainDayRecycledFunding(MIRROR_DAY, uint32(CHAIN_ARB));
        _mut().setArmedFreshLedgerRaw(1_000 ether, 0);

        // Codex #1907 r12 — TWO entries in ONE call, so the facet's batch
        // accumulator is exercised. With a single entry, replacing the expiry
        // loop's `t.recycled += ex.recycled` with an assignment passes: every
        // entry is still marked processed, but only the LAST one's recycled
        // share is released and the earlier reservations stay stranded.
        uint256 id = _seedEntryPerDay(alice, 99, G_LENDER / 2, 5, 6);
        uint256 id2 = _seedEntryPerDay(
            makeAddr("mirror-dora"), 100, G_LENDER / 2, 5, 6
        );
        uint256[] memory ids = new uint256[](2);
        ids[0] = id;
        ids[1] = id2;
        _sweeper().sweepExpiredInteractionRewards(ids); // stamp the clock

        // The absorption day is the day of the SWEEP, not `today` — this
        // fixture warps roughly 270 days to reach the horizon, and snapshotting
        // `credited[today]` across that warp reads a day the credit never
        // touches. Same shape as the earlier `today`-vs-delivered-day miss, so
        // the day is recomputed after the warp and BOTH snapshots use it.
        _accrueExec(ids, 180 days + 90 days - 7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        (uint256 sweepDay, ) = _lens().getInteractionCurrentDay();

        MirrorLedger memory b = _snapMirror(sweepDay);
        uint256 expiredTotal = _sweeper().sweepExpiredInteractionRewards(ids);
        MirrorLedger memory a = _snapMirror(sweepDay);

        uint256 released = b.outRecycled - a.outRecycled;
        assertGt(released, 0, "the expiry released the reserved commitment");
        assertApproxEqAbs(
            released,
            funding.lenderHalfEquiv,
            1e6,
            "and released the stamped recycled share, not a slice"
        );
        assertEq(
            a.retired - b.retired, released, "the shared retirement total carries it"
        );
        assertEq(
            a.released - b.released, released, "and so does the release subset"
        );
        assertEq(a.paidOut, b.paidOut, "an expiry pays nobody");

        // Codex #1907 r11 — the expiry's FRESH effects, which the commitment
        // counters alone cannot see. Same delta rule the other live release
        // fixtures use, so a mirror-specific regression that released the
        // right recycled share while under-crediting the expired fresh share
        // or moving custody cannot pass.
        assertApproxEqAbs(
            expiredTotal,
            funding.freshLenderHalf + funding.lenderHalfEquiv,
            1e6,
            "the sweep reaped the day's fresh AND recycled halves"
        );
        _assertReleased(b, a, released, expiredTotal);
        // The delivered-fresh bound is CHARGED for the expired fresh share on
        // a mirror — it is the one ledger a release does move, so it is
        // asserted here rather than folded into the shared delta rule.
        assertEq(
            a.freshPaid - b.freshPaid,
            expiredTotal - released,
            "and the delivered-fresh bound was charged the fresh share"
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
