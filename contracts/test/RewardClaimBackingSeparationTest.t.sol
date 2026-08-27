// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {RewardHorizonSweepFacet} from "../src/facets/RewardHorizonSweepFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title  RewardClaimBackingSeparationTest
 * @notice #1460 — the bucket/fresh separation invariant asserted across a
 *         PAYING claim.
 *
 *         The gap this closes: `recycleBucket` and the fresh reward budget
 *         are two protocol-owned claims on ONE fungible Diamond balance, and
 *         the claim path debited the bucket by the RECYCLED component only
 *         while transferring the AGGREGATE out — with no check that the
 *         FRESH part fitted in `balanceOf - recycleBucket`. The invariant was
 *         stated in the governor design (§7 #3), enforced on INFLOW by
 *         {LibVpfiRecycle.credit} and on the RL-3 EXPIRY sweep, claimed (over-
 *         claimed) in a {RewardAggregatorFacet} comment — and asserted by
 *         exactly one test, {RecycleBucketTest}, on a FORFEIT claim where
 *         `paid == 0`. A zero-payout claim cannot violate a separation
 *         invariant, so that assertion was vacuous for this defect: nothing
 *         anywhere exercised a claim that actually MOVED tokens.
 *
 *         Every test here therefore pays out, and each asserts the post-state
 *         `balanceOf(diamond) >= recycleBucket` that the defect broke.
 */
contract RewardClaimBackingSeparationTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;

    uint256 internal constant DIAMOND_SEED = 100_000_000 ether;

    address internal alice;

    function setUp() public {
        setupHelper();

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

        AdminFacet(address(diamond)).setTreasury(makeAddr("treasury"));
        alice = makeAddr("alice");

        _facet().setInteractionLaunchTimestamp(block.timestamp);
        // Days 1 + 2 finalized in the past.
        vm.warp(block.timestamp + 5 days);

        // Alice is the only contributor on days 1–2; per-day cap disabled so
        // the accrual is the raw half-pool share (same scaffolding as
        // {RecycleBucketTest}, so the two suites agree on the fixture).
        _mut().setKnownGlobalDailyInterest(1, 100e18, 0, true);
        _mut().setKnownGlobalDailyInterest(2, 100e18, 0, true);
        _mut().setDayCapThreshold18(1, type(uint256).max);
        _mut().setDayCapThreshold18(2, type(uint256).max);
    }

    function _facet() internal view returns (InteractionRewardsFacet) {
        return InteractionRewardsFacet(address(diamond));
    }

    function _lens() internal view returns (InteractionRewardsLensFacet) {
        return InteractionRewardsLensFacet(address(diamond));
    }

    function _cfg() internal view returns (ConfigFacet) {
        return ConfigFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    /// @dev Seed a CLOSED, NOT-forfeited lender entry over days 1–2 — i.e. a
    ///      claim that actually pays the claimant, which is the case the
    ///      pre-#1460 suite never exercised against the bucket.
    function _seedPayable(address user, uint64 loanId)
        internal
        returns (uint256 id, uint256 expected)
    {
        id = _mut().pushRewardEntry(
            user, loanId, LibVaipakam.RewardSide.Lender, 100e18, 1
        );
        _mut().closeRewardEntryRaw(id, 3); // endDay = 3 ⇒ accrues days 1 + 2
        expected =
            _lens().getInteractionHalfPoolForDay(1) +
            _lens().getInteractionHalfPoolForDay(2);
    }

    // ─── The regression ──────────────────────────────────────────────────────

    /// The defect, direct — and the property that decides its remedy.
    ///
    /// A fresh-only payout larger than the un-earmarked balance. Pre-#1460
    /// it paid in FULL and left `recycleBucket` claiming more tokens than
    /// remained behind it. It must now be refused — and refusing rather than
    /// part-paying is the load-bearing choice: the claim legs commit before
    /// the caps run, so a part-payment would consume the entry and delete
    /// the untruncated remainder. This test pins BOTH halves: the refusal,
    /// and that the claimant is made whole once funding lands.
    /// #1499 — THE HORIZON AND THE CLAIM MUST AGREE.
    ///
    /// The RL-3 notice clock only accrues while an entry is claim-executable,
    /// and `rewardEntryExpiry` mirrors that: it folds the pending interval into
    /// `elapsed` ONLY when `_entryExecutableNow` holds. So a horizon that is
    /// more lenient than the claim is directly observable — the countdown
    /// advances for a claimant whose claim reverts, and when backing later
    /// lands the next sweep can expire the entry immediately on that stale
    /// elapsed time, consuming the notice window the horizon exists to give.
    ///
    /// This is the cell where they diverged: the claim refuses a payout whose
    /// FRESH part does not fit ABOVE the earmark, while the horizon's predicate
    /// tested a bare payout against the balance and never netted the bucket.
    /// Balance covers the payout, so the OLD predicate called this executable;
    /// balance does not cover payout + bucket, so the claim refuses it.
    ///
    /// Note the suite this lives in: four tests already covered the claim side
    /// of #1460 and NONE touched the horizon, which is why the divergence
    /// survived — and why three attempts to align it inside #1497 each passed
    /// a green suite.
    function testHorizonPausesWhenTheClaimWouldBeRefusedForBacking() public {
        (uint256 id, uint256 expected) = _seedPayable(alice, 77);

        // Arm the horizon. While `rewardClaimHorizonDays == 0` (the deploy
        // default) the sweep returns at its first line and nothing accrues, so
        // an unarmed run cannot exhibit this at all.
        // 180 is the MINIMUM the setter accepts (bounds-checked to
        // [180, 1095] days); 30 reverts ParameterOutOfRange.
        _cfg().setRewardClaimHorizonDays(180);

        _mut().setRecycleBucketRaw(1 ether); // ample: entry is executable
        // START THE CLOCK. `rewardEntryFirstClaimableAt` is stamped by the
        // SWEEP itself, on its first claim-EXECUTABLE observation
        // (`LibInteractionRewards:3229`) — there is no mutator for it, and
        // without the stamp `rewardEntryExpiry` returns `expiresAt == 0`, which
        // would make every assertion below pass trivially against zero.
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        RewardHorizonSweepFacet(address(diamond)).sweepExpiredInteractionRewards(ids);

        uint256 bal = vpfi.balanceOf(address(diamond));
        // NOW thin the backing: the balance still covers the payout outright,
        // but NOT the payout sitting ABOVE the earmark. Exactly the divergence
        // window — the old predicate calls this executable, the claim refuses.
        assertGt(bal, expected, "fixture: balance covers the bare payout");
        // One wei of room above the earmark: ANY positive fresh payout is
        // refused, while the balance still covers the bare payout outright so
        // the OLD predicate called it executable. Derived from the balance
        // rather than from `expected`, which is the day half-pool total and
        // over-states this entry's own share.
        _mut().setRecycleBucketRaw(bal - 1);

        // The claim refuses it.
        vm.prank(alice);
        vm.expectPartialRevert(InteractionRewardBackingShort.selector);
        RewardClaimFacet(address(diamond)).claimInteractionRewards();

        // ...so the countdown must NOT advance across this interval. Sampled
        // either side of a real time gap: a diverging predicate folds the gap
        // into `elapsed` and brings `expiresAt` nearer, an aligned one leaves
        // it where it was.
        (, uint64 expiresBefore) = _lens().getRewardEntryExpiry(id);
        vm.warp(block.timestamp + 5 days);
        (, uint64 expiresAfter) = _lens().getRewardEntryExpiry(id);

        assertTrue(expiresBefore != 0, "fixture: the countdown is live to begin with");
        // THE DEADLINE RECEDES WHEN THE CLOCK PAUSES. `expiresAt` is
        // `block.timestamp + (required - elapsed)`, so while an entry is
        // continuously executable `elapsed` grows by exactly the time that
        // passes and the deadline stays PUT. A paused clock leaves `elapsed`
        // where it was while `block.timestamp` moves, pushing the deadline
        // later. So "later" is the signature of a paused notice clock, which
        // is what a claimant whose claim is refused must get.
        assertGt(
            expiresAfter,
            expiresBefore,
            "deadline must RECEDE - the notice clock cannot accrue against a claimant whose claim is refused"
        );
    }

    /// #1499 — the CONTROL for the test above. Same entry, same horizon, the
    /// only difference is that the earmark leaves room for the fresh payout.
    /// Without this, a predicate hard-wired to "never executable" would satisfy
    /// the assertion above and pin nothing.
    function testHorizonStillAccruesWhenTheClaimWouldSucceed() public {
        (uint256 id, ) = _seedPayable(alice, 78);
        // 180 is the MINIMUM the setter accepts (bounds-checked to
        // [180, 1095] days); 30 reverts ParameterOutOfRange.
        _cfg().setRewardClaimHorizonDays(180);

        // Ample room above the earmark throughout — the claim would pay.
        _mut().setRecycleBucketRaw(1 ether);
        // START THE CLOCK. `rewardEntryFirstClaimableAt` is stamped by the
        // SWEEP itself, on its first claim-EXECUTABLE observation
        // (`LibInteractionRewards:3229`) — there is no mutator for it, and
        // without the stamp `rewardEntryExpiry` returns `expiresAt == 0`, which
        // would make every assertion below pass trivially against zero.
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        RewardHorizonSweepFacet(address(diamond)).sweepExpiredInteractionRewards(ids);

        (, uint64 expiresBefore) = _lens().getRewardEntryExpiry(id);
        vm.warp(block.timestamp + 5 days);
        (, uint64 expiresAfter) = _lens().getRewardEntryExpiry(id);

        assertTrue(expiresBefore != 0, "fixture: countdown live");
        // The paired direction: a backed claimant's clock ACCRUES, so the
        // absolute deadline holds steady. Without this control a predicate
        // stuck permanently closed would satisfy the receding-deadline
        // assertion above and pin nothing.
        assertEq(
            expiresAfter,
            expiresBefore,
            "a backed claimant's deadline holds steady - the clock is accruing, not stuck"
        );
    }

    // #1499 matrix — TWO CELLS WITHDRAWN, deliberately, rather than shipped green.
    //
    // A forfeit-present cell and a recycled-only cell were written here and
    // both were VACUOUS: mutating the production formula to the exact defects
    // they targeted left them passing.
    //
    //  - forfeit cell: it squeezed the balance with `bucket = bal - 1`, which
    //    makes EVERY formula unmeetable, so the clock paused under the correct
    //    and the broken predicate alike. To discriminate it needs a balance in
    //    the gap `fresh + bucket <= bal < payout + bucket + forfeitFresh`.
    //  - recycled-only cell: `_seedPayable` builds a FRESH entry, so it never
    //    seeded recycled value at all; and with ample balance r2's
    //    `payout + bucket` shape still fit, so the clock accrued either way. It
    //    needs a genuinely armed/recycled entry and a balance in
    //    `bucket <= bal < recycled + bucket`.
    //
    // Left out until they can fail. This card's own history is three attempts
    // that each passed a 179-test suite, and a green test that cannot fail is
    // what produced that.

    /// #1499 / #1970 r1 P2 — THE FALSE NEGATIVE I INTRODUCED, and its fix.
    ///
    /// The first draft tested the UNCAPPED fresh entitlement against backing.
    /// The claim truncates fresh to the remaining 69M pool headroom FIRST and
    /// only then checks backing (`RewardClaimFacet:338-400`), so an uncapped
    /// test over-states the requirement.
    ///
    /// That is not the safe direction it looks like. `remaining` is
    /// `CAP - interactionPoolPaidOut - rewardBudgetRemittedGlobal`, both
    /// append-only, so it is monotone NON-INCREASING — an over-strict gate does
    /// not delay a reap, it stops the clock INDEFINITELY for a claim that is
    /// executable. I argued in the PR that overstating fresh "only ever delays
    /// a reap"; that was wrong, and this is the cell that would have caught it.
    ///
    /// Shape follows the reviewer's worked example: pool headroom well below
    /// the fresh entitlement, with backing ample for what the claim would
    /// ACTUALLY pay after truncation.
    function testPoolCappedClaimantKeepsAccruingRatherThanStallingForever()
        public
    {
        (uint256 id, uint256 expected) = _seedPayable(alice, 82);
        // 180 is the setter's MINIMUM (bounds-checked to [180, 1095]).
        _cfg().setRewardClaimHorizonDays(180);
        _mut().setRecycleBucketRaw(1 ether);

        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        RewardHorizonSweepFacet(address(diamond)).sweepExpiredInteractionRewards(ids);
        (, uint64 before_) = _lens().getRewardEntryExpiry(id);
        assertTrue(before_ != 0, "fixture: countdown live");

        // Squeeze the POOL so the claim truncates fresh to 1 VPFI.
        _mut().setInteractionPoolPaidOut(
            LibVaipakam.VPFI_INTERACTION_POOL_CAP - 1 ether
        );

        // STRADDLE THE BALANCE — this is what makes the cell discriminate, and
        // omitting it is why the first version of this test was VACUOUS
        // (mutating the cap away left it green). Reachability is not
        // discrimination: with an ample balance BOTH formulas clear it, so the
        // capped and uncapped predicates never disagree.
        //
        // With `room = 1e18` and `earmarked = bucket`:
        //     capped need   = 1e18     + bucket   <= balance   (executable)
        //     uncapped need = freshRaw + bucket    > balance    (would stall)
        // Choosing `bucket = balance - expected + 1` puts the balance exactly
        // inside that gap, since `expected > 1e18` here.
        // Straddle on the MEASURED claimable, not on `expected`. `_seedPayable`
        // returns the day half-pool SUM, which over-states this entry's own
        // share — here by 38 wei. Leaving room of `expected - 1` therefore left
        // room ABOVE the real fresh figure, so the uncapped need still fit and
        // the mutation (cap removed) stayed green. Four drafts of this cell were
        // vacuous before measuring showed the gap.
        (uint256 freshNow, , ) = _lens().previewInteractionRewards(alice);
        uint256 bal = vpfi.balanceOf(address(diamond));
        assertGt(freshNow, 1 ether, "fixture: entitlement exceeds the pool room");
        // room = freshNow - 1, so:
        //   capped need   = 1e18     + earmarked <= balance  (executable)
        //   uncapped need = freshNow + earmarked  > balance  (would stall)
        _mut().setRecycleBucketRaw(bal - freshNow + 1);

        vm.warp(block.timestamp + 5 days);
        (, uint64 after_) = _lens().getRewardEntryExpiry(id);
        assertEq(
            after_,
            before_,
            "pool-capped claimant keeps accruing - an uncapped test would stall this clock forever"
        );
    }

    /// #1499 / #1970 r1 P1 — the horizon must read `backingPosition`, not a
    /// hand-added bucket.
    ///
    /// `backingPosition` subtracts THREE terms — `recycleBucket`,
    /// `strandedRecoveryReserved`, and the recovery position — while the first
    /// draft added only the bucket. With a stranded reservation outstanding the
    /// claim's room is smaller than a bucket-only view believes, so the horizon
    /// called entries executable that the claim refuses and the notice clock
    /// accrued against a claimant with no working path.
    ///
    /// STRADDLE (this is what makes the cell discriminate, and four cells on
    /// this card were vacuous for lacking it): with `stranded` reserved,
    ///     bucket-only need   = fresh + bucket             <= balance   (passes, wrongly)
    ///     backingPosition need = fresh + bucket + stranded  > balance   (pauses, correctly)
    /// so the balance is placed strictly between them.
    function testHorizonHonoursStrandedRecoveryReservation() public {
        (uint256 id, ) = _seedPayable(alice, 91);
        // 180 is the setter's MINIMUM (bounds-checked to [180, 1095]).
        _cfg().setRewardClaimHorizonDays(180);
        _mut().setRecycleBucketRaw(1 ether);

        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        RewardHorizonSweepFacet(address(diamond)).sweepExpiredInteractionRewards(ids);
        (, uint64 before_) = _lens().getRewardEntryExpiry(id);
        assertTrue(before_ != 0, "fixture: countdown live");

        // Measured, not assumed: `_seedPayable`'s return over-states this
        // entry's own share, which is what made an earlier straddle miss by
        // 38 wei.
        (uint256 freshNow, , ) = _lens().previewInteractionRewards(alice);
        uint256 bal = vpfi.balanceOf(address(diamond));
        uint256 stranded = 5 ether;

        // Leave room for exactly `fresh` above the bucket — so a bucket-only
        // predicate is satisfied — then reserve `stranded` on top, which only
        // `backingPosition` subtracts.
        _mut().setRecycleBucketRaw(bal - freshNow);
        _mut().setStrandedRecoveryRaw(address(0xD1), 1, stranded, 1, 4);

        vm.warp(block.timestamp + 5 days);
        (, uint64 after_) = _lens().getRewardEntryExpiry(id);
        assertGt(
            after_,
            before_,
            "deadline must RECEDE - a stranded reservation shrinks the claim's room, so the clock pauses"
        );
    }

    function testUnderfundedClaimIsRefusedAndLosesNothing() public {
        (, uint256 expected) = _seedPayable(alice, 42);

        uint256 bal = vpfi.balanceOf(address(diamond));
        // Backing covers a QUARTER of the accrual: enough that a truncating
        // implementation would happily pay a partial claim here.
        uint256 room = expected / 4;
        _mut().setRecycleBucketRaw(bal - room);

        vm.prank(alice);
        vm.expectPartialRevert(InteractionRewardBackingShort.selector);
        RewardClaimFacet(address(diamond)).claimInteractionRewards();

        assertEq(vpfi.balanceOf(alice), 0, "nothing paid while underfunded");
        assertGe(
            vpfi.balanceOf(address(diamond)),
            _cfg().getRecycleBucket(),
            "separation: bucket still fully backed"
        );

        // Funding arrives — the bucket's claim on the balance shrinks.
        _mut().setRecycleBucketRaw(1 ether);

        vm.prank(alice);
        (uint256 paid, , ) =
            RewardClaimFacet(address(diamond)).claimInteractionRewards();

        // THE no-value-loss property: the FULL accrual, not the quarter a
        // truncating implementation would have paid before consuming the
        // entry. "Recoverable back-pressure, never lost value"
        // (TokenomicsTechSpec section 4a).
        assertApproxEqAbs(
            paid, expected, 1e6, "claimant made whole once backing lands"
        );
        assertGt(paid, room * 3, "recovered far more than a part-payment");
        assertGe(
            vpfi.balanceOf(address(diamond)),
            _cfg().getRecycleBucket(),
            "separation holds across the PAYING claim too"
        );
    }

    /// Diagnosis accuracy. Zero backing and an exhausted 69M pool both stop
    /// a claim, and an operator's response to them differs completely — one
    /// resolves when funding lands, the other never does. Here the schedule
    /// has essentially all of its headroom and only the backing is gone, so
    /// the claim must report a backing shortfall and NOT
    /// {InteractionPoolExhausted}.
    function testZeroBackingReportsBackingShortNotPoolExhausted() public {
        _seedPayable(alice, 43);
        _mut().setRecycleBucketRaw(vpfi.balanceOf(address(diamond)));

        vm.prank(alice);
        vm.expectPartialRevert(InteractionRewardBackingShort.selector);
        RewardClaimFacet(address(diamond)).claimInteractionRewards();

        assertGe(
            vpfi.balanceOf(address(diamond)),
            _cfg().getRecycleBucket(),
            "separation preserved by refusing the claim"
        );
        assertEq(vpfi.balanceOf(alice), 0, "nothing paid out");
    }

    /// ORDERING — the backing gate must run AFTER the 69M cap, not before
    /// (Codex #1497 r1 P1).
    ///
    /// The two caps ask different questions and only one of them is about
    /// what actually transfers. Here the raw entitlement far exceeds both
    /// the pool headroom and the backing, but the pool truncates the payout
    /// down to an amount the backing covers exactly — so the claim is fully
    /// backed for everything it may legally pay and MUST succeed. Gating on
    /// the pre-cap figure refused it, and that refusal could never clear: a
    /// mirror cannot obtain the missing headroom, because remittance is
    /// bounded by the same 69M cap.
    function testPoolTruncatedClaimSucceedsWhenTheCappedAmountIsBacked()
        public
    {
        (, uint256 expected) = _seedPayable(alice, 46);

        // Pool headroom = a quarter of the entitlement.
        uint256 headroom = expected / 4;
        _mut().setInteractionPoolPaidOut(
            LibVaipakam.VPFI_INTERACTION_POOL_CAP - headroom
        );
        // Backing covers the CAPPED amount but not the raw entitlement.
        uint256 bal = vpfi.balanceOf(address(diamond));
        _mut().setRecycleBucketRaw(bal - headroom);

        vm.prank(alice);
        (uint256 paid, , ) =
            RewardClaimFacet(address(diamond)).claimInteractionRewards();

        assertEq(paid, headroom, "pays the pool-capped amount, not refused");
        assertGe(
            vpfi.balanceOf(address(diamond)),
            _cfg().getRecycleBucket(),
            "separation still holds at the exact backing boundary"
        );
    }

    /// Negative control — the gate must not over-refuse. With ample
    /// un-earmarked balance the same claim pays in full.
    function testAmpleBackingPaysInFull() public {
        (, uint256 expected) = _seedPayable(alice, 44);
        _mut().setRecycleBucketRaw(1 ether); // negligible against the seed

        vm.prank(alice);
        (uint256 paid, , ) =
            RewardClaimFacet(address(diamond)).claimInteractionRewards();

        assertApproxEqAbs(
            paid, expected, 1e6, "full accrual paid when backing is ample"
        );
        assertGe(
            vpfi.balanceOf(address(diamond)),
            _cfg().getRecycleBucket(),
            "separation holds on the unblocked path too"
        );
    }

    // #1555 r4 — the two tests that pinned a treasury-owned-VPFI
    // reservation were REMOVED with the subtraction they covered. Reverting
    // it was deliberate: four rounds surfaced five distinct owners of this
    // balance, so enumerating them is unsound, and that r3 subtraction had
    // already diverged the claim gate from the RL-3 expiry predicates. The
    // reservation returns with the delivered-reward-funding bound (#1498),
    // which covers every owner at once and is where the coverage belongs.

}
