// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";

/**
 * @title  RecycleTransparencyMetricsTest
 * @notice #1218 M5 — the two reads that complete the recycling transparency
 *         surface (governor design §9).
 *
 *         The slice adds no storage and no event, so what needs proving is
 *         not that values persist but that the DERIVATIONS agree with the
 *         protocol they claim to describe:
 *
 *           1. `freshDrawdown[D]` is the figure finalization actually
 *              reserved — asserted against `outstandingCommitFresh`'s real
 *              movement, never against a re-derivation of the same formula.
 *           2. `absorbed[D]` carries BOTH the local and mirror terms. The
 *              mirror term had no AGGREGATE getter — it was reconstructible
 *              only per-chain, one call each, against a chain list that can
 *              go stale — so a dashboard built on the obvious read would have
 *              published Base-only absorption labelled as global.
 *           3. Absorption stays readable on an unfinalized day, while the
 *              pool figures correctly read as absent rather than zero.
 *           4. The backing snapshot survives the state it exists to detect,
 *              and carries every term its own formula needs — including the
 *              keeper earmark, whose omission would overstate platform
 *              reserve the moment the register is switched on.
 *           5. The global series REFUSES on any non-canonical chain, rather
 *              than answering with figures a mirror cannot compute.
 */
contract RecycleTransparencyMetricsTest is SetupTest {
    VPFIToken internal vpfi;
    MockRewardMessenger internal messenger;

    uint256 internal constant DIAMOND_SEED = 100_000_000 ether;

    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;

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

        messenger = new MockRewardMessenger(address(diamond));
        vm.chainId(CHAIN_BASE);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(true);
        _rep().setRewardMessenger(address(messenger));
        uint32[] memory chainIds = new uint32[](2);
        chainIds[0] = CHAIN_BASE;
        chainIds[1] = CHAIN_ARB;
        _agg().setExpectedSourceChainIds(chainIds);
    }

    function _lens() internal view returns (InteractionRewardsLensFacet) {
        return InteractionRewardsLensFacet(address(diamond));
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

    /// @dev Deliver full coverage for `dayId` and finalize it.
    function _finalize(uint256 dayId) internal {
        messenger.deliverChainReport(CHAIN_BASE, dayId, 10e18, 5e18);
        messenger.deliverChainReport(CHAIN_ARB, dayId, 20e18, 10e18);
        _mut().setChainDayCommitmentCompleteRaw(dayId, CHAIN_ARB, true);
        _agg().finalizeDay(dayId);
    }

    // ─── freshDrawdown[D] ────────────────────────────────────────────────────

    /**
     * @dev The load-bearing property: the published `freshDrawdown` is the
     *      SAME quantity finalization committed, not a plausible number that
     *      happens to be computed from the same inputs.
     *
     *      Asserted against `outstandingCommitFresh`'s actual movement across
     *      the finalize call. That matters because the obvious alternative —
     *      recomputing `committableForDay` in the test and comparing — would
     *      pass for ANY shared formula, including a wrong one, since the test
     *      and the lens would drift together. Here the reference value is
     *      produced by the production reservation path and nothing else.
     *
     *      Kills: reading the wrong stamp field, dropping the `/ 2` per-side
     *      division, passing the recycled half, or reading a different day.
     *      Does NOT kill a change made identically in BOTH `_finalizeAndWrite`
     *      and the lens — no single-call test can, and that is the point of
     *      binding to the reservation rather than to a constant.
     */
    function testFreshDrawdownEqualsTheReservationFinalizeActuallyMade()
        public
    {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setGovernorCommitArmedFromDayRaw(5);

        (, uint256 freshBefore, , ) = _agg().getGovernorCommitState();
        _finalize(5);
        (, uint256 freshAfter, , ) = _agg().getGovernorCommitState();

        uint256 reserved = freshAfter - freshBefore;
        assertGt(reserved, 0, "the armed day must reserve a fresh commitment");

        (bool stamped, , , uint256 drawdown, , ) =
            _lens().getRecycleDayMetrics(5);
        assertTrue(stamped, "day 5 finalized");
        assertEq(
            drawdown,
            reserved,
            "freshDrawdown must be the reservation, not a re-derivation"
        );
    }

    /**
     * @dev The upper-bound invariant: a day can never draw more fresh than it
     *      budgeted. Cheap to state, and it earns its place — the mutation
     *      that computes the drawdown off the WHOLE floor instead of the
     *      per-side half roughly doubles the figure and fails HERE as well as
     *      against the reservation.
     *
     *      The #1008 cap is NOT what separates these two on an armed day, and
     *      an earlier version of this comment said it was. Arming sets that
     *      day's legacy threshold to `type(uint256).max` — the ETH-ratio cap
     *      is retired under ShareOfPool pricing — so it can never trim an
     *      armed day. The next test covers what actually does.
     */
    function testFreshDrawdownNeverExceedsTheBudgetedFloor() public {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setGovernorCommitArmedFromDayRaw(5);
        _finalize(5);

        (, uint256 floor_, , uint256 drawdown, , ) =
            _lens().getRecycleDayMetrics(5);
        assertGt(floor_, 0, "day 5 has a budgeted floor");
        assertLe(drawdown, floor_, "drawdown can never exceed the floor");
    }

    /**
     * @dev Where the two figures actually diverge — and therefore why
     *      publishing both says something the stamp alone does not.
     *
     *      The floor is budgeted per SIDE, and a side with no activity commits
     *      nothing. On a day when only lenders earned, roughly half the floor
     *      is budgeted and never minted. That gap IS the metric's content: it
     *      is reward capacity the schedule offered and real activity did not
     *      take up.
     *
     *      Asserted as a strict inequality plus a magnitude, not as `!=`: an
     *      off-by-one-wei difference would satisfy `!=` while establishing
     *      nothing about the mechanism.
     *
     *      The magnitude needs a tolerance, and the tolerance is DERIVED
     *      rather than guessed. The per-side budget converts through a
     *      per-1e18 rate and floors once on the way (`freshHalf * 1e18 /
     *      global`, then back), so the result can land up to `global / 1e18`
     *      wei under the exact half. A first version of this test guessed 2
     *      and failed at 9 — the bound below is 30, and 30 wei against a
     *      ~1.0e22 half is a relative tolerance of 3e-21, so nothing
     *      meaningful hides inside it.
     */
    function testAnIdleSideLeavesItsHalfOfTheFloorUndrawn() public {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setGovernorCommitArmedFromDayRaw(5);

        // Borrower side idle all day — lender interest only.
        uint256 lenderBase = 10e18;
        uint256 lenderArb = 20e18;
        messenger.deliverChainReport(CHAIN_BASE, 5, lenderBase, 0);
        messenger.deliverChainReport(CHAIN_ARB, 5, lenderArb, 0);
        _mut().setChainDayCommitmentCompleteRaw(5, CHAIN_ARB, true);
        _agg().finalizeDay(5);

        (, uint256 floor_, , uint256 drawdown, , ) =
            _lens().getRecycleDayMetrics(5);
        assertGt(floor_, 0, "the day still budgets a full floor");
        assertLt(drawdown, floor_, "an idle side leaves budget undrawn");
        assertApproxEqAbs(
            drawdown,
            floor_ / 2,
            (lenderBase + lenderArb) / 1e18,
            "only the active side's half was drawn"
        );
    }

    // ─── absorbed[D] ─────────────────────────────────────────────────────────

    /**
     * @dev The gap that would have shipped a WRONG number rather than a
     *      missing one. `_stampGovernorDayPool` sums the local and mirror
     *      terms when it sizes `Ā`, but only the local term had a getter —
     *      so a dashboard reading `getRecycledCreditedByDay` alone would have
     *      published Base-only absorption while calling it global, and it
     *      would have looked entirely plausible.
     *
     *      The two terms are asserted SEPARATELY and at different values, so
     *      a lens that returned the local figure twice, or summed them into
     *      one, fails. Asserting only their sum would let both through.
     */
    function testAbsorbedCarriesTheMirrorTermAndNotOnlyTheLocalOne() public {
        uint256 day = 4;
        _mut().setRecycledCreditedByDayRaw(day, 700 ether);
        messenger.deliverChainReportRecycled(
            CHAIN_ARB,
            day,
            20e18,
            10e18,
            250 ether, // cumulative reported by the mirror
            250 ether // of which, attributable to this day
        );

        (, , , , uint256 local, uint256 mirror) =
            _lens().getRecycleDayMetrics(day);
        assertEq(local, 700 ether, "local absorption term");
        assertEq(mirror, 250 ether, "mirror absorption term");
        assertTrue(local != mirror, "the two terms must be distinguishable");
    }

    /**
     * @dev Base's OWN report must not double as a mirror credit. The write is
     *      gated on `sourceChainId != block.chainid` precisely so the local
     *      series is not counted twice when the totals are summed — and since
     *      the published global figure is `local + mirror`, a broken gate
     *      would double-count the canonical chain in every day's absorption.
     *
     *      The mutation this exists for is removing that gate, NOT swapping
     *      the lens's two reads: a lens returning the local series twice
     *      leaves this assertion green, because a chain report writes the
     *      per-chain ledger and never the local `recycledCreditedByDay` feed,
     *      so both sides read zero here. Recorded because the matrix's first
     *      run predicted the wrong killer for this test.
     */
    function testBaseOwnReportNeverLandsInTheMirrorTerm() public {
        uint256 day = 4;
        messenger.deliverChainReportRecycled(
            CHAIN_BASE,
            day,
            10e18,
            5e18,
            500 ether,
            500 ether
        );

        (, , , , , uint256 mirror) = _lens().getRecycleDayMetrics(day);
        assertEq(mirror, 0, "canonical chain is not its own mirror");
    }

    // ─── canonical-chain scoping ─────────────────────────────────────────────

    /**
     * @dev A mirror must REFUSE rather than answer, because on a mirror it
     *      would answer WRONGLY — and in the more dangerous of the two
     *      possible ways.
     *
     *      `dailyGlobal*InterestNumeraire18` is written only by Base's
     *      `finalizeDay`. Under the legacy broadcast a mirror still receives
     *      a `dayPoolStamp`, so the day reads `stamped == true` with a real
     *      floor and a `freshDrawdown` of ZERO — a plausible number, not an
     *      obviously absent one. That is the exact failure shape this PR
     *      fixes for `absorbed[D]`, so shipping it here would have been
     *      self-defeating (Codex #1487 r1 P2).
     *
     *      The canonical half of this test is what makes it non-vacuous: it
     *      first proves the same call returns a real, non-zero drawdown on
     *      Base, so the revert afterwards is attributable to the chain role
     *      and not to an empty fixture.
     *
     *      It also asserts the guard is SCOPED. The backing snapshot is a
     *      purely local figure and must keep working on a mirror — a blanket
     *      guard over both views would pass a naive revert test while
     *      removing something mirrors legitimately need.
     */
    function testDayMetricsRefusesOnAMirrorWhileBackingStillAnswers() public {
        _mut().setRecycleBucketRaw(1_000_000 ether);
        _mut().setGovernorCommitArmedFromDayRaw(5);
        _finalize(5);

        (bool stamped, , , uint256 drawdown, , ) =
            _lens().getRecycleDayMetrics(5);
        assertTrue(stamped, "canonical chain answers");
        assertGt(drawdown, 0, "and answers with a REAL figure");

        // Same Diamond, mirror role.
        _rep().setIsCanonicalRewardChain(false);

        vm.expectRevert(
            InteractionRewardsLensFacet
                .RecycleDayMetricsCanonicalChainOnly
                .selector
        );
        _lens().getRecycleDayMetrics(5);

        (uint256 bal, , , , , ) = _lens().getRecycleBackingSnapshot();
        assertEq(
            bal,
            DIAMOND_SEED,
            "the local backing snapshot must survive on a mirror"
        );
    }

    /**
     * @dev The role check alone is not enough, because the role is MUTABLE.
     *      `setIsCanonicalRewardChain` flips either way and neither clears
     *      nor tags historical state, so a Diamond promoted from mirror to
     *      canonical passes a current-role gate while still holding
     *      broadcast-written `dayPoolStamp` entries from its mirror era —
     *      days whose canonical `dailyGlobal*` denominators it never wrote.
     *      Under the LEGACY broadcast that is the dangerous shape all over
     *      again: a real stamp, a real floor, and a drawdown of zero.
     *
     *      Driven through the real broadcast path rather than a raw stamp
     *      mutator, so what is proven is the scenario and not a synthesised
     *      end state: receive as a mirror, then promote, then read.
     *
     *      The fix keys on `dailyGlobalFinalized[dayId]`, whose single writer
     *      is `_finalizeAndWrite` — per-DAY provenance instead of a
     *      point-in-time role (Codex #1487 r3 P2).
     */
    function testPromotedMirrorDoesNotServeItsMirrorEraDays() public {
        uint256 day = 7;

        // Mirror era: a legacy broadcast stamps the day pool locally, but no
        // canonical finalize ever runs here, so the denominators stay unset.
        _rep().setIsCanonicalRewardChain(false);
        messenger.deliverBroadcastWithComposition(
            day,
            30e18, // global lender
            15e18, // global borrower
            type(uint256).max,
            10_000 ether, // scheduleFloor half
            0, // recycled half
            0 // unarmed
        );

        // The stamp really did land — otherwise the assertion below would
        // pass for the wrong reason.
        (bool rawStamped, uint256 rawFloor, , , ) =
            _agg().getDayPoolStamp(day);
        assertTrue(rawStamped, "mirror-era broadcast wrote a real stamp");
        assertGt(rawFloor, 0, "with a real floor behind it");

        // Promotion. A current-role gate is satisfied from here on.
        _rep().setIsCanonicalRewardChain(true);

        (
            bool stamped,
            uint256 floor_,
            ,
            uint256 drawdown,
            ,

        ) = _lens().getRecycleDayMetrics(day);

        assertFalse(
            stamped,
            "a mirror-era day must not be served as canonical"
        );
        assertEq(floor_, 0, "and must not leak the broadcast floor");
        assertEq(drawdown, 0, "nor a zero drawdown beside a real floor");
    }

    // ─── the unfinalized day ─────────────────────────────────────────────────

    /**
     * @dev Absorption happens on the day it occurs, well before that day
     *      finalizes. Gating the absorbed terms on `stamped` would hide every
     *      credit landing on the CURRENT day — which is the day an operator
     *      most wants to see. The pool figures, by contrast, genuinely do not
     *      exist yet, so they must read as absent (`stamped == false`) rather
     *      than as a real zero.
     */
    function testUnfinalizedDayReportsLiveAbsorptionButNoPool() public {
        uint256 day = 6;
        _mut().setRecycledCreditedByDayRaw(day, 900 ether);

        (
            bool stamped,
            uint256 floor_,
            uint256 budget,
            uint256 drawdown,
            uint256 local,

        ) = _lens().getRecycleDayMetrics(day);

        assertFalse(stamped, "day 6 never finalized");
        assertEq(floor_, 0, "no floor before finalize");
        assertEq(budget, 0, "no recycled budget before finalize");
        assertEq(drawdown, 0, "no drawdown before finalize");
        assertEq(local, 900 ether, "absorption is live before finalize");
    }

    // ─── the backing snapshot (#1460's unmeasured third condition) ───────────

    /**
     * @dev `unearmarked` is the balance a scheduled payout can spend without
     *      eating recycle backing — the quantity #1460's third condition
     *      turns on, and the one nothing else on the surface can express.
     */
    function testBackingSnapshotReportsUnearmarkedBalance() public {
        (
            uint256 bal,
            uint256 bucket,
            uint256 unearmarked,
            ,
            ,

        ) = _lens().getRecycleBackingSnapshot();
        assertEq(bal, DIAMOND_SEED, "diamond holds the seed");
        assertEq(bucket, 0, "nothing labelled recycled yet");
        assertEq(unearmarked, DIAMOND_SEED, "all of it is unearmarked");

        _mut().setRecycleBucketRaw(40_000_000 ether);
        (bal, bucket, unearmarked, , , ) = _lens().getRecycleBackingSnapshot();
        assertEq(bucket, 40_000_000 ether, "bucket label applied");
        assertEq(
            unearmarked,
            DIAMOND_SEED - 40_000_000 ether,
            "labelling reduces what a scheduled payout may spend"
        );
    }

    /**
     * @dev The view must survive the exact state it exists to detect. A
     *      plain `balance - bucket` would panic on underflow precisely when
     *      backing has gone short — blinding every monitor at the one moment
     *      they must read, and turning a detectable breach into an opaque
     *      revert.
     *
     *      Kills: replacing the saturating subtraction with an unchecked or
     *      plain one; reverting on the shortfall instead of reporting it.
     *
     *      What it does NOT establish, stated because the distinction
     *      matters: this drives the bucket ABOVE the balance directly, so it
     *      proves the view stays readable in the breached state — not that a
     *      real fresh-only claim can reach that state. Demonstrating
     *      reachability belongs to #1460's own slice, together with the fix.
     */
    function testBackingSnapshotStaysReadableWhenBackingIsShort() public {
        _mut().setRecycleBucketRaw(DIAMOND_SEED + 1 ether);

        (
            uint256 bal,
            uint256 bucket,
            uint256 unearmarked,
            ,
            ,

        ) = _lens().getRecycleBackingSnapshot();

        assertEq(unearmarked, 0, "nothing unearmarked once backing is short");
        assertLt(bal, bucket, "and the shortfall itself stays READABLE");
    }

    /**
     * @dev `platformRetained` is published as its two raw terms rather than
     *      pre-netted, per the #1448 posture — consumers derive it and an
     *      independent re-derivation is what catches a relabelled figure.
     *      Both terms must therefore actually move.
     *
     *      **The first version of this test was vacuous and the mutation
     *      matrix did not say so.** It finalized day 5 with an empty
     *      trailing absorption window, so `Ā` was zero, so `recycledBudget`
     *      was zero, so nothing reserved and `outstandingCommitRecycled`
     *      stayed at 0 — the assertion compared 0 to 0. It still DIED to the
     *      mutation that reads `outstandingCommitFresh` instead, because
     *      that term is non-zero, which is exactly why the matrix passed it:
     *      a killed mutation proves the test distinguishes those two slots,
     *      NOT that it pins the right value. Seeding the trailing window
     *      below is what makes it pin one.
     *
     *      Generalisable: mutation-killed and non-vacuous are different
     *      properties, and a matrix measures only the first.
     */
    function testBackingSnapshotExposesBothPlatformRetainedTerms() public {
        // Seed the trailing absorption window so Ā > 0 and the day actually
        // stamps a recycled budget — without this the reserved amount is
        // structurally zero and every assertion below holds trivially.
        _mut().setRecycleBucketRaw(1_000_000 ether);
        for (uint256 d = 1; d <= 5; ++d) {
            _mut().setRecycledCreditedByDayRaw(d, 50_000 ether);
        }
        _mut().setGovernorCommitArmedFromDayRaw(5);
        _finalize(5);

        (, , uint256 recycledBudget, , , ) = _lens().getRecycleDayMetrics(5);
        assertGt(
            recycledBudget,
            0,
            "the day must stamp a NON-ZERO recycled budget, or the rest is vacuous"
        );

        (
            ,
            uint256 bucket,
            ,
            uint256 outstandingRecycled,
            ,

        ) = _lens().getRecycleBackingSnapshot();

        (, , uint256 stateOutstanding, ) = _agg().getGovernorCommitState();
        assertGt(
            stateOutstanding,
            0,
            "and must actually RESERVE against it"
        );
        assertEq(
            outstandingRecycled,
            stateOutstanding,
            "the subtrahend must be the governor's own outstanding sum"
        );
        assertGt(bucket, 0, "bucket term present");
    }

    /**
     * @dev `paidOutRecycled` is the return whose documented semantics are
     *      least obvious — it is NOT monotonic and NOT lifetime outflow,
     *      because a remittance send advances it before delivery and a
     *      release reverses it. Nothing asserted it at all until this test,
     *      which is the worst place to have no coverage: a mislabelled
     *      counter is exactly what a reader cannot check for themselves.
     *
     *      Pinned against the governor's own view of the same slot, and
     *      driven off zero first, so it cannot pass by both sides being
     *      empty the way the sibling test above once did.
     */
    function testBackingSnapshotReportsTheLiveConsumedRecycledFigure() public {
        _mut().setRecycleBucketRaw(1_000_000 ether);

        (, , , , uint256 before_, ) = _lens().getRecycleBackingSnapshot();
        assertEq(before_, 0, "nothing consumed yet");

        _mut().consumeRecycleRaw(250_000 ether);

        (, , , , uint256 after_, ) = _lens().getRecycleBackingSnapshot();
        assertEq(after_, 250_000 ether, "consume advances the live figure");

        (, , , uint256 statePaidOut) = _agg().getGovernorCommitState();
        assertEq(
            after_,
            statePaidOut,
            "and it is the governor's own slot, not a parallel count"
        );
    }

    /**
     * @dev The keeper earmark is carved from INSIDE the bucket, so
     *      `recycleBucket` does not move when it is taken — which makes a
     *      two-term `bucket − outstandingRecycled` derivation count the whole
     *      earmark as platform reserve. The governor's own `_recycleFundable`
     *      nets it alongside the outstanding commitments, so the published
     *      surface must expose it or every consumer overstates by exactly
     *      that amount (Codex #1487 r2 P2).
     *
     *      The register is dark by default, which is precisely why this needs
     *      a test: the overstatement would appear for the first time on the
     *      day someone enables the knob, long after this code was reviewed.
     *      Driven off zero and then made non-zero, so it cannot pass by the
     *      term being structurally absent.
     */
    function testBackingSnapshotExposesTheKeeperEarmark() public {
        (, , , , , uint256 keeperBefore) =
            _lens().getRecycleBackingSnapshot();
        assertEq(keeperBefore, 0, "register is dark by default");

        _mut().setRecycleBucketRaw(1_000_000 ether);
        for (uint256 d = 1; d <= 5; ++d) {
            _mut().setRecycledCreditedByDayRaw(d, 50_000 ether);
        }
        ConfigFacet(address(diamond)).setRecycleRegisterKeeperBps(2_000); // 20%
        _mut().setGovernorCommitArmedFromDayRaw(5);
        _finalize(5);

        (
            ,
            uint256 bucket,
            ,
            ,
            ,
            uint256 keeperAfter
        ) = _lens().getRecycleBackingSnapshot();

        assertGt(keeperAfter, 0, "the register earmarked a keeper share");
        assertEq(
            bucket,
            1_000_000 ether,
            "carved from INSIDE the bucket: the bucket itself is unmoved"
        );
    }
}
