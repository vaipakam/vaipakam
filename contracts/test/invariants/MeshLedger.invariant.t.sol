// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {VaipakamDiamond} from "../../src/VaipakamDiamond.sol";
import {DiamondCutFacet} from "../../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../../src/facets/AccessControlFacet.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {VPFITokenFacet} from "../../src/facets/VPFITokenFacet.sol";
import {InteractionRewardsFacet} from "../../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../../src/facets/InteractionRewardsLensFacet.sol";
import {RewardReporterFacet} from "../../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../../src/facets/RewardAggregatorFacet.sol";
import {VPFIToken} from "../../src/token/VPFIToken.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../../src/libraries/LibInteractionRewards.sol";
import {TestMutatorFacet} from "../mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "../mocks/MockRewardMessenger.sol";
import {HelperTest} from "../HelperTest.sol";

/**
 * @title  MeshLedgerInvariant
 * @notice #1222 M3 B4-a — the governor §7 per-chain commitment invariants,
 *         proved against ANY sequence of mesh messages the fuzzer can script.
 *
 *         **Why no multi-diamond harness here.** Every §7 per-chain invariant
 *         is a property of the CANONICAL chain's books — what Base believes
 *         about each mirror, and how those beliefs relate to each other. A
 *         mirror's own ledger is not an input to any of them. So the suite
 *         fuzzes Base's mesh INGRESS directly (that is also the exact attack
 *         surface: a mirror can only ever influence Base through a report).
 *         The three-diamond end-to-end lives in B4-b, where a mirror's real
 *         state genuinely matters.
 *
 *         **What the fuzzer controls:** report order, report content
 *         (including hostile magnitudes), duplicate delivery, dropped days,
 *         the wire generation used, and where `finalizeDay` falls between all
 *         of it.
 *
 *         **What the fuzz campaign does NOT establish** (Codex #1437 r1 P2 —
 *         an overclaim in this suite's first version). Every invariant below
 *         is an algebraic UPPER BOUND on final state. §7 #6's two ordering
 *         clauses — "a duplicate is a no-op" and "a missed report self-heals"
 *         — are statements about a TRANSITION, and a ledger that mishandles a
 *         duplicate (adding an already-seen cumulative instead of ratcheting
 *         it, say) can still satisfy every bound here. Bounds cannot prove
 *         them, and no amount of fuzzing changes that.
 *
 *         Those two clauses are therefore proved by the DETERMINISTIC
 *         before/after tests at the bottom of this file, which read the
 *         ledger, apply exactly one message, and read it again. The fuzz
 *         campaign's job is the bounds; theirs is the transitions.
 *
 *         Invariants asserted (governor design §7 + the B3 design record §4):
 *
 *           1. §7 #6 — `consumed ≤ reported + released` per chain. B3's form
 *              of the original `consumed ≤ reported`: a commitment the chain
 *              released un-spent is legitimately re-offerable, so the bound
 *              gains the release term rather than being weakened.
 *           2. B3 identity — `outstanding == instructed − retired` per chain,
 *              exact at every instant including with broadcasts in flight.
 *           3. Ceiling — `availRecycled ≤ reported` per chain. The property
 *              that keeps B2-d5's relocated-custody exclusion intact: Base
 *              can never be induced to re-offer its own already-remitted
 *              custody as a mirror's own funds.
 *           4. Clamp chain — `released ≤ retired ≤ instructed` per chain.
 *              Base trusts a reporting chain for TIMING only, never for
 *              magnitude; every clamp is evaluated against Base-local state.
 *           5. §7 #2 — `outstandingCommitRecycled ≤ recycleBucket`. A day can
 *              never size against availability another unclaimed day already
 *              committed.
 *           6. Base's own chain id stays inert in the per-chain books (it
 *              never instructs itself), so a single-chain deployment cannot
 *              be perturbed through this surface at all.
 *
 *         **What a mutation run actually showed** (both ingest clamps
 *         removed, so a reporting chain is believed about magnitude):
 *         invariants 2, 4 and 6 fail — the clamp chain is what carries them.
 *         Two results are worth stating plainly rather than overclaiming:
 *
 *           * **Invariant 3 (the ceiling) still HELD without the clamps.**
 *             That is not luck: after the #1435 r1 P1 fix the availability
 *             read is `reported − (consumed − released)` with both
 *             subtractions floored, so `avail ≤ reported` is STRUCTURAL —
 *             true of the arithmetic itself, not derived from the clamps.
 *             The mutation is the evidence for that claim.
 *           * **Invariant 1 is the weakest of the set.** With the clamps
 *             gone a hostile `released` inflates the right-hand side, so
 *             `consumed ≤ reported + released` passes trivially. It is
 *             retained because it is the governor §7 #6 wording in B3's
 *             form and it does bind while the clamps hold — but invariant 4
 *             is what actually defends the bound, and a future change that
 *             weakens the clamps would be caught by 4, not by 1.
 */
contract MeshLedgerInvariant is Test {
    VaipakamDiamond public diamond;
    VPFIToken public vpfi;
    MockRewardMessenger public messenger;
    MeshHandler public handler;

    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    uint32 internal constant CHAIN_OP = 10;

    /// Codex #1437 r1 P1 — sized so invariant 5 can BIND. At 5,000,000 the
    /// bucket dwarfed the ~60,000 of aggregate demand 12 days × 5,000 VPFI can
    /// generate, so `outstanding <= bucket` was never approached and a
    /// regression that stopped netting prior commitments out of fundable
    /// availability would have stayed green. Kept comparable to generated
    /// demand instead.
    uint256 internal constant BUCKET_SEED = 40_000 ether;

    function setUp() public {
        address owner = address(this);
        vm.chainId(CHAIN_BASE);

        DiamondCutFacet cut = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cut));
        HelperTest helper = new HelperTest();

        AccessControlFacet ac = new AccessControlFacet();
        AdminFacet admin = new AdminFacet();
        VPFITokenFacet vpfiFacet = new VPFITokenFacet();
        InteractionRewardsFacet interaction = new InteractionRewardsFacet();
        RewardReporterFacet reporter = new RewardReporterFacet();
        RewardAggregatorFacet aggregator = new RewardAggregatorFacet();
        TestMutatorFacet mutator = new TestMutatorFacet();
        // #1437 r1 P1 — §7 #2's FRESH half reads `getInteractionPoolPaidOut`,
        // which lives on the lens facet (#1306 follow-up split).
        InteractionRewardsLensFacet lens = new InteractionRewardsLensFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](8);
        cuts[0] = _cut(address(ac), helper.getAccessControlFacetSelectors());
        cuts[1] = _cut(address(admin), helper.getAdminFacetSelectors());
        cuts[2] = _cut(address(vpfiFacet), helper.getVPFITokenFacetSelectors());
        cuts[3] = _cut(
            address(interaction), helper.getInteractionRewardsFacetSelectors()
        );
        cuts[4] = _cut(
            address(reporter), helper.getRewardReporterFacetSelectors()
        );
        cuts[5] = _cut(
            address(aggregator), helper.getRewardAggregatorFacetSelectors()
        );
        cuts[6] = _cut(address(mutator), helper.getTestMutatorFacetSelectors());
        cuts[7] = _cut(
            address(lens), helper.getInteractionRewardsLensFacetSelectors()
        );
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        AccessControlFacet(address(diamond)).initializeAccessControl();
        AdminFacet(address(diamond)).unpause();
        AdminFacet(address(diamond)).setTreasury(address(diamond));

        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                VPFIToken.initialize, (address(this), address(this), address(this))
            )
        );
        vpfi = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
        // The bucket ledger is a slice of the Diamond's own VPFI balance, so
        // the seed must be genuinely held — `credit` enforces that, and an
        // unbacked seed would make invariant 5 vacuous.
        vpfi.mint(address(this), BUCKET_SEED);
        vpfi.transfer(address(diamond), BUCKET_SEED);

        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(
            block.timestamp
        );

        messenger = new MockRewardMessenger(address(diamond));
        RewardReporterFacet(address(diamond)).setBaseChainId(CHAIN_BASE);
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(true);
        RewardReporterFacet(address(diamond)).setRewardMessenger(
            address(messenger)
        );
        uint32[] memory chainIds = new uint32[](3);
        chainIds[0] = CHAIN_BASE;
        chainIds[1] = CHAIN_ARB;
        chainIds[2] = CHAIN_OP;
        RewardAggregatorFacet(address(diamond)).setExpectedSourceChainIds(
            chainIds
        );

        TestMutatorFacet(address(diamond)).setRecycleBucketRaw(BUCKET_SEED);
        // Seed ABSORPTION, not just the bucket. The armed funding resolution
        // sizes its target from `Ā` — the trailing average of per-day recycle
        // CREDITS — and returns immediately when that is zero. A bucket alone
        // leaves `coupledTarget == 0`, so nothing is ever instructed and every
        // per-chain invariant below is vacuously true. (This is what the
        // coverage probe caught.)
        for (uint256 d = 1; d <= 6; ++d) {
            TestMutatorFacet(address(diamond)).setRecycledCreditedByDayRaw(
                d, 700 ether
            );
        }
        // Arm from day 1 so the fuzzer reaches the armed paths — the whole
        // per-chain funding + commitment machinery is inert while unarmed.
        TestMutatorFacet(address(diamond)).setGovernorCommitArmedFromDayRaw(1);

        handler = new MeshHandler(address(diamond), address(messenger));
        targetContract(address(handler));
        // RESTRICT to the handler's OWN entry points. `MeshHandler` inherits
        // `Test`, which brings hundreds of public cheatcode/assertion helpers
        // with it — without this the fuzzer spreads its call budget across all
        // of them and essentially never drives the mesh ingress, which makes
        // every invariant below vacuously true. (Caught by the coverage probe
        // in `test_CoverageProbe_FuzzerReachesRealState`: with an unrestricted
        // target the probe showed ZERO instructions, ZERO retirements and an
        // untouched bucket after 50,000 calls.)
        bytes4[] memory sel = new bytes4[](8);
        sel[0] = MeshHandler.reportB3.selector;
        sel[1] = MeshHandler.reportLegacyB1.selector;
        sel[2] = MeshHandler.reportLegacyPre1222.selector;
        sel[3] = MeshHandler.redeliver.selector;
        sel[4] = MeshHandler.finalize.selector;
        sel[5] = MeshHandler.warp.selector;
        sel[6] = MeshHandler.creditDay.selector;
        sel[7] = MeshHandler.instructThenRetire.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    function _cut(
        address facet,
        bytes4[] memory selectors
    ) private pure returns (IDiamondCut.FacetCut memory) {
        return IDiamondCut.FacetCut({
            facetAddress: facet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });
    }

    function _agg() internal view returns (RewardAggregatorFacet) {
        return RewardAggregatorFacet(address(diamond));
    }

    function _chains() internal pure returns (uint32[3] memory) {
        return [CHAIN_BASE, CHAIN_ARB, CHAIN_OP];
    }

    // ─── Invariants ──────────────────────────────────────────────────────

    /// §7 #6, in B3's form. The original `consumed <= reported` gained the
    /// release term because a commitment released un-spent leaves its tokens
    /// in the chain's bucket and is legitimately committable again — the
    /// bound is widened by something real, not weakened.
    function invariant_ConsumedWithinReportedPlusReleased() public view {
        uint32[3] memory cs = _chains();
        for (uint256 i; i < cs.length; ++i) {
            (uint256 reported, uint256 consumed, , ) =
                _agg().getChainRecycledLedger(cs[i]);
            (, uint256 released) =
                _agg().getChainRecycledCommitRetirement(cs[i]);
            // Codex #1437 r1 P1 — SUBTRACTION form, for exactly the reason
            // the production read uses it (#1435 r1 P1): a chain's reported
            // cumulative is deliberately unbounded, so `reported + released`
            // overflows on a near-max report and this invariant would FAIL
            // against correct production code. An invariant that cannot
            // survive the states its own subject admits is worse than none.
            assertLe(
                consumed > released ? consumed - released : 0,
                reported,
                "SS7#6: consumed - released <= reported"
            );
        }
    }

    /// The B3 identity. Exact at every instant, in-flight broadcasts
    /// included — Base's outstanding is (instructed - applied) +
    /// (applied - retired), and the `applied` term cancels.
    function invariant_OutstandingEqualsInstructedMinusRetired() public view {
        uint32[3] memory cs = _chains();
        for (uint256 i; i < cs.length; ++i) {
            (, uint256 instructed, , ) = _agg().getChainRecycledLedger(cs[i]);
            (uint256 retired, ) =
                _agg().getChainRecycledCommitRetirement(cs[i]);
            assertEq(
                _agg().getChainOutstandingRecycledCommit(cs[i]),
                instructed > retired ? instructed - retired : 0,
                "B3: outstanding == instructed - retired"
            );
        }
    }

    /// The ceiling that keeps B2-d5's relocated-custody exclusion intact.
    /// If this can be broken, Base can be induced to re-offer its own
    /// already-remitted tokens as a mirror's own funds.
    function invariant_AvailNeverExceedsReported() public view {
        uint32[3] memory cs = _chains();
        for (uint256 i; i < cs.length; ++i) {
            (uint256 reported, , uint256 avail, ) =
                _agg().getChainRecycledLedger(cs[i]);
            assertLe(avail, reported, "B3 ceiling: avail <= reported");
        }
    }

    /// The clamp chain — Base trusts a reporting chain for TIMING only. Both
    /// figures are bounded by Base-local state, so no report content can
    /// walk them past what Base itself instructed.
    function invariant_RetirementWithinInstructions() public view {
        uint32[3] memory cs = _chains();
        for (uint256 i; i < cs.length; ++i) {
            (, uint256 instructed, , ) = _agg().getChainRecycledLedger(cs[i]);
            (uint256 retired, uint256 released) =
                _agg().getChainRecycledCommitRetirement(cs[i]);
            assertLe(released, retired, "clamp: released <= retired");
            assertLe(retired, instructed, "clamp: retired <= instructed");
        }
    }

    /// §7 #2 — a day can never size against availability another unclaimed
    /// day already committed.
    ///
    /// #1444 — stated in its UNIVERSAL form (`+ stranded`), because
    /// the governor design predates B2-d2's remit-release valve and the bare
    /// `outstanding <= bucket` is genuinely false after a release: the
    /// commitment is restored while the bucket deliberately is not, since
    /// those tokens sit locked in the transport's custody. The correction
    /// term is asserted ZERO here rather than merely added, so this suite
    /// still proves the STRICT bound — the universal form documents the
    /// relation without quietly weakening what is actually checked. The
    /// released case is covered directly in `RewardRemitLedgerTest`
    /// (`test_Coverage_ReleasedTermRestoresTheHardRelation`), which this
    /// handler cannot reach: it drives Base-side ingest, not the operator
    /// release valve.
    function invariant_GlobalRecycledCommitWithinBucket() public view {
        (, , uint256 outstandingRecycled, ) = _agg().getGovernorCommitState();
        (, uint256 bucket, ) = _agg().getRecycleCustodyPosition();
        (, uint256 stranded, , ) = _agg().getRecycleCompositionPosition();
        assertEq(
            stranded,
            0,
            "this handler never releases a remit: strict bound is under test"
        );
        assertLe(
            outstandingRecycled,
            bucket + stranded,
            "SS7#2: outstanding recycled commitments <= bucket + stranded remit"
        );
    }

    /// #1446 — the BUCKET COMPOSITION bound, the one relation that catches a
    /// regression in the B2-d5 custody exclusion itself.
    ///
    /// Every recycled credit lands in the bucket exactly once, so the two
    /// lifetime cumulatives can never exceed where the tokens actually went.
    /// A regression that advanced `recycleCreditedCumulative` on a custody
    /// relocation would raise the left side twice against a right side that
    /// moved once. No comparison of the REPORTED cumulative can see that,
    /// on this chain or against Base's accepted copy, because both derive
    /// from the same helper and would inflate together.
    ///
    /// Inequality rather than equality: `consume` floors the bucket at zero
    /// for bounded cap-trim dust, which can only widen the right side.
    function invariant_BucketCompositionWithinDestinations() public view {
        (uint256 raw, uint256 stranded, , ) =
            _agg().getRecycleCompositionPosition();
        (uint256 relocated, uint256 bucket, ) =
            _agg().getRecycleCustodyPosition();
        (, , , uint256 paidOut) = _agg().getGovernorCommitState();
        assertLe(
            raw + relocated,
            bucket + paidOut + stranded,
            "#1446: creditedRaw + relocated <= bucket + paidOut + stranded"
        );
    }

    /// §7 #2's OTHER half — `outstandingCommitFresh + paidOutFresh <= 69M`.
    /// Codex #1437 r1 P1: the first version of this suite asserted only the
    /// recycled bound while claiming to encode §7 #2, so a regression that
    /// over-reserved FRESH issuance would have stayed green. The pre-existing
    /// interaction-rewards invariant checks paid-out alone, not paid plus
    /// outstanding, so nothing else covered this.
    function invariant_FreshCommitWithinLifetimeCap() public view {
        (, uint256 outstandingFresh, , ) = _agg().getGovernorCommitState();
        uint256 paidOutFresh =
            InteractionRewardsLensFacet(address(diamond))
                .getInteractionPoolPaidOut();
        assertLe(
            outstandingFresh + paidOutFresh,
            LibVaipakam.VPFI_INTERACTION_POOL_CAP,
            "SS7#2: outstandingFresh + paidOutFresh <= 69M"
        );
    }


    /// ANTI-VACUITY GUARD. Runs once after each invariant campaign and
    /// asserts the fuzzer actually drove the mesh into a non-trivial state.
    ///
    /// Every invariant above is an upper bound, so ALL of them hold
    /// trivially on an untouched ledger — a handler that silently no-ops
    /// produces a fully green suite that proves nothing. That is not
    /// hypothetical: this suite was green and vacuous twice while being
    /// written. First because `MeshHandler` inherits `Test`, so an
    /// unrestricted `targetContract` spread the call budget over hundreds of
    /// inherited cheatcode helpers (fixed by `targetSelector`). Then because
    /// only the BUCKET was seeded and not per-day ABSORPTION — the armed
    /// funding resolution sizes from `Ā` and returns immediately when it is
    /// zero, so nothing was ever instructed.
    ///
    /// Both failures looked identical from the outside: 6 passed, 0 reverts.
    /// This guard is what makes the difference visible.
    function afterInvariant() public view {
        (, uint256 instructedArb, , ) =
            _agg().getChainRecycledLedger(CHAIN_ARB);
        (, uint256 instructedOp, , ) = _agg().getChainRecycledLedger(CHAIN_OP);
        assertGt(
            instructedArb + instructedOp,
            0,
            "VACUOUS RUN: the fuzzer never instructed any mirror - every "
            "invariant above passed on an untouched ledger"
        );
        // Codex #1437 r1 P1 — instructions alone are NOT enough. If no
        // post-instruction retirement report ever lands (or
        // `recordChainCommitRetirement` regresses to a no-op) then
        // `outstanding == instructed - 0` and every clamp and ceiling still
        // holds, so the suite stays green while never exercising the two
        // behaviours B3 actually added. Require both halves: retirement by
        // CONSUMPTION and restoration by RELEASE.
        (uint256 retArb, uint256 relArb) =
            _agg().getChainRecycledCommitRetirement(CHAIN_ARB);
        (uint256 retOp, uint256 relOp) =
            _agg().getChainRecycledCommitRetirement(CHAIN_OP);
        assertGt(
            retArb + retOp,
            0,
            "VACUOUS RUN: no retirement was ever recorded - B3's ledger "
            "retirement was never exercised"
        );
        assertGt(
            relArb + relOp,
            0,
            "VACUOUS RUN: no RELEASE was ever recorded - B3's availability "
            "restoration was never exercised"
        );
    }

    /// Base never instructs itself, so its own per-chain books stay zero
    /// whatever it reports about itself — which is what keeps the whole
    /// surface inert on a single-chain deployment.
    function invariant_BaseOwnBooksStayInert() public view {
        (, uint256 consumedBase, , ) =
            _agg().getChainRecycledLedger(CHAIN_BASE);
        (uint256 retiredBase, uint256 releasedBase) =
            _agg().getChainRecycledCommitRetirement(CHAIN_BASE);
        assertEq(consumedBase, 0, "Base never instructs itself");
        assertEq(retiredBase, 0, "Base retirement clamps to zero");
        assertEq(releasedBase, 0, "Base release clamps to zero");
        assertEq(
            _agg().getChainOutstandingRecycledCommit(CHAIN_BASE),
            0,
            "Base holds no per-chain reservation"
        );
    }

    // ─── §7 #2's FRESH half, at its boundary — deterministic ────────────
    //
    // #1222 M3 B4-d. `invariant_FreshCommitWithinLifetimeCap` asserts
    // `outstandingFresh + paidOutFresh <= 69M`, and like every bound in this
    // suite it holds trivially on state that never approaches the cap. The
    // fuzzer works in ether-scale amounts against a 69,000,000e18 ceiling, so
    // it will never get within seven orders of magnitude of it: the bound is
    // green because the boundary is unreachable, not because it is enforced.
    //
    // These two tests place the ledger AT the boundary and assert the cap
    // actually bites. They are deliberately deterministic — a fuzzer cannot
    // usefully search a region it cannot reach.

    /// The cap must reserve against OUTSTANDING fresh commitments, not only
    /// against what has already been paid out. That is the whole content of
    /// §7 #2's fresh half: a day already committed to fresh issuance has
    /// spent that headroom even though no tokens have moved, so the next
    /// day's schedule must size against what remains.
    ///
    /// Driven through the commitment term alone, with nothing paid out, so a
    /// regression that dropped `outstandingCommitFresh` from the reserved sum
    /// fails here and nowhere else — every bound in this suite would stay
    /// green while the platform issued past 69M across two open days.
    function test_Boundary_FreshScheduleClampsToRemainingCapHeadroom()
        public
    {
        uint256 headroom = 1_234 ether;
        TestMutatorFacet(address(diamond)).setOutstandingCommitRaw(
            LibVaipakam.VPFI_INTERACTION_POOL_CAP - headroom, 0
        );

        uint256 schedule = _scheduleForDay(1);
        assertGt(
            schedule,
            headroom,
            "fixture must place the schedule ABOVE the headroom, or the "
            "clamp is not under test"
        );

        _finalizeDayOne();

        (bool stamped, uint256 scheduleFloor, , , ) =
            _agg().getDayPoolStamp(1);
        assertTrue(stamped, "day 1 finalized");
        assertEq(
            scheduleFloor,
            headroom,
            "the fresh floor must clamp to the cap headroom left by the "
            "outstanding commitment, not to the day's own schedule"
        );

        // Codex #1457 r1 P1 — the STAMP is not the reservation. Finalization
        // could stamp the clamped floor and still reserve commitments sized
        // from the unclamped schedule, which walks the counter past the cap
        // while every assertion above stays green. Assert the counter itself.
        _assertFreshCapNotBreached("after a clamped finalize");
    }

    /// At the boundary EXACTLY, fresh goes to zero — and recycled does not.
    /// §7 #1 says the cap bounds fresh drawdown ONLY, so a day at the cap
    /// must still be able to pay from the recycle bucket. An implementation
    /// that zeroed the whole day would satisfy the fresh bound perfectly
    /// while silently ending recycling, and an implementation that let fresh
    /// through would breach the 30% allocation.
    function test_Boundary_AtTheCapFreshIsZeroAndRecycledIsNot() public {
        TestMutatorFacet(address(diamond)).setOutstandingCommitRaw(
            LibVaipakam.VPFI_INTERACTION_POOL_CAP, 0
        );

        _finalizeDayOne();

        (bool stamped, uint256 scheduleFloor, uint256 recycledBudget, uint256 aBar, ) =
            _agg().getDayPoolStamp(1);
        assertTrue(stamped, "day 1 finalized");
        assertEq(
            scheduleFloor,
            0,
            "no fresh headroom remains, so the day funds no fresh at all"
        );
        assertGt(aBar, 0, "fixture must supply absorption, or recycled is "
            "trivially zero and the second half of this test is vacuous");
        assertGt(
            recycledBudget,
            0,
            "the cap bounds FRESH drawdown only - a day at the cap must "
            "still fund from the recycle bucket"
        );
        assertEq(
            _outstandingFresh(),
            LibVaipakam.VPFI_INTERACTION_POOL_CAP,
            "at the cap exactly, finalization must reserve NO further fresh - "
            "a stamped zero floor with a non-zero reservation is the same "
            "breach, one indirection away"
        );
    }

    /// The third term in the fresh reservation is value already REMITTED to
    /// mirrors, and it is the one no other test can place at the boundary:
    /// reaching it for real needs a mirror to have been sent almost the whole
    /// allocation. With the other two terms carrying the fixture, dropping
    /// this one from the reserved sum is invisible — Base would keep stamping
    /// full fresh schedules for its own claimants against an allocation it has
    /// already shipped elsewhere, issuing the same value twice
    /// (Codex #1457 r1 P1).
    function test_Boundary_RemittedValueAlsoReservesAgainstTheCap() public {
        uint256 headroom = 1_234 ether;
        TestMutatorFacet(address(diamond)).setRewardBudgetRemittedGlobalRaw(
            LibVaipakam.VPFI_INTERACTION_POOL_CAP - headroom
        );

        assertGt(
            _scheduleForDay(1),
            headroom,
            "fixture must place the schedule ABOVE the headroom"
        );

        _finalizeDayOne();

        (bool stamped, uint256 scheduleFloor, , , ) =
            _agg().getDayPoolStamp(1);
        assertTrue(stamped, "day 1 finalized");
        assertEq(
            scheduleFloor,
            headroom,
            "already-remitted value reserves against the cap exactly as an "
            "outstanding commitment does"
        );
        _assertFreshCapNotBreached("after a remit-clamped finalize");
    }

    /// @dev The §7 #2 fresh half, read from live state. `remaining` is the
    ///      allocation net of what has been paid out AND what has been
    ///      remitted to mirrors, so "outstanding commitments fit inside what
    ///      is left" is exactly `outstanding + paidOut + remitted <= cap` —
    ///      stated in the form the platform itself publishes, so the check
    ///      cannot drift from the number operators read.
    function _assertFreshCapNotBreached(string memory ctx) internal view {
        (, , uint256 remaining, , , ) =
            InteractionRewardsLensFacet(address(diamond))
                .getInteractionSnapshot();
        assertLe(
            _outstandingFresh(),
            remaining,
            string.concat("SS7#2 breached ", ctx)
        );
    }

    function _outstandingFresh() internal view returns (uint256 v) {
        (, v, , ) = _agg().getGovernorCommitState();
    }

    /// @dev The day's uncapped fresh schedule, as the governor computes it
    ///      before the cap headroom clamps it.
    function _scheduleForDay(uint256 dayId) internal pure returns (uint256) {
        return LibInteractionRewards.halfPoolForDay(dayId) * 2;
    }

    /// @dev Day 1 finalized with every expected chain reported and both
    ///      mirrors marked commitment-complete — the shape the release and
    ///      retirement transition tests above already use.
    function _finalizeDayOne() internal {
        messenger.deliverChainReportB3(
            CHAIN_BASE, 1, 10e18, 5e18, 900 ether, 0, 0, 0
        );
        messenger.deliverChainReportB3(
            CHAIN_ARB, 1, 20e18, 10e18, 900 ether, 0, 0, 0
        );
        messenger.deliverChainReportB3(
            CHAIN_OP, 1, 20e18, 10e18, 900 ether, 0, 0, 0
        );
        TestMutatorFacet(address(diamond)).setChainDayCommitmentCompleteRaw(
            1, CHAIN_ARB, true
        );
        TestMutatorFacet(address(diamond)).setChainDayCommitmentCompleteRaw(
            1, CHAIN_OP, true
        );
        _agg().finalizeDay(1);
    }

    // ─── §7 #6's ORDERING clauses — deterministic, not fuzzed ────────────
    //
    // Codex #1437 r1 P2. These are transition properties; the invariants
    // above are upper bounds on final state and cannot establish them.

    /// §7 #6's "a duplicate is a no-op" is a MIRROR-side property (the
    /// broadcast ingress, guarded by `broadcastV2Applied`). On BASE the
    /// equivalent guarantee is stronger and different, and this pins it: a
    /// second report for the same `(chain, day)` is REJECTED outright rather
    /// than silently absorbed. Discovered by writing the no-op assertion
    /// first and watching it revert — the mirror-side clause belongs to B4-b,
    /// where a real mirror exists to receive a broadcast.
    function test_Ordering_DuplicateReportIsRejectedNotAbsorbed() public {
        messenger.deliverChainReportB3(
            CHAIN_ARB, 3, 20e18, 10e18, 500 ether, 0, 0, 0
        );
        (uint256 rep0, uint256 con0, uint256 av0, uint256 att0) =
            _agg().getChainRecycledLedger(CHAIN_ARB);

        vm.expectRevert();
        messenger.deliverChainReportB3(
            CHAIN_ARB, 3, 20e18, 10e18, 500 ether, 0, 0, 0
        );

        // Rejected, and the rejection left nothing half-applied.
        (uint256 rep1, uint256 con1, uint256 av1, uint256 att1) =
            _agg().getChainRecycledLedger(CHAIN_ARB);
        assertEq(rep1, rep0, "duplicate moved reported");
        assertEq(con1, con0, "duplicate moved consumed");
        assertEq(av1, av0, "duplicate moved availability");
        assertEq(att1, att0, "duplicate moved attribution");
    }

    /// "A missed report self-heals." A chain that skips a day entirely must
    /// be made whole by the NEXT report it does land — the cumulative is the
    /// carrier, so the gap costs nothing permanently.
    function test_Ordering_MissedReportSelfHeals() public {
        messenger.deliverChainReportB3(
            CHAIN_ARB, 3, 20e18, 10e18, 100 ether, 0, 0, 0
        );
        (uint256 repAfterFirst, , , ) =
            _agg().getChainRecycledLedger(CHAIN_ARB);
        assertEq(repAfterFirst, 100 ether, "first report recorded");

        // Day 4 is never reported at all. Day 5 lands, carrying the
        // cumulative that spans the gap.
        messenger.deliverChainReportB3(
            CHAIN_ARB, 5, 20e18, 10e18, 900 ether, 0, 0, 0
        );

        (uint256 repHealed, , uint256 avail, ) =
            _agg().getChainRecycledLedger(CHAIN_ARB);
        assertEq(
            repHealed,
            900 ether,
            "the skipped day cost nothing - the cumulative carried it"
        );
        assertEq(avail, 900 ether, "and it is fully available again");
    }

    /// **B3's headline behaviour, asserted exactly** (Codex #1437 r2 P1).
    /// Nothing else in this file actually pins it: a nonzero release counter
    /// only proves a release was RECORDED, and
    /// `invariant_AvailNeverExceedsReported` is an upper bound, so a
    /// regression of `mirrorAvailRecycled` to the pre-B3 formula — one that
    /// ignores `released` entirely — would leave every other check green
    /// while silently stranding released mirror funds and eventually forcing
    /// Base to fund the whole mesh again. That is the exact failure B3
    /// exists to prevent, so it gets an exact assertion.
    function test_Transition_ReleaseRestoresAvailabilityExactly() public {
        // Instruct ARB, which consumes its reported availability.
        messenger.deliverChainReportB3(
            CHAIN_BASE, 1, 10e18, 5e18, 900 ether, 0, 0, 0
        );
        messenger.deliverChainReportB3(
            CHAIN_ARB, 1, 20e18, 10e18, 900 ether, 0, 0, 0
        );
        messenger.deliverChainReportB3(
            CHAIN_OP, 1, 20e18, 10e18, 900 ether, 0, 0, 0
        );
        TestMutatorFacet(address(diamond)).setChainDayCommitmentCompleteRaw(
            1, CHAIN_ARB, true
        );
        TestMutatorFacet(address(diamond)).setChainDayCommitmentCompleteRaw(
            1, CHAIN_OP, true
        );
        _agg().finalizeDay(1);

        (, uint256 instructed, uint256 availBefore, ) =
            _agg().getChainRecycledLedger(CHAIN_ARB);
        assertGt(instructed, 0, "ARB was instructed");

        // A release of HALF the instruction - tokens that never left ARB's
        // bucket. Deliberately below `instructed`: a release is clamped to
        // what Base instructed, so asking for more than that restores only
        // the clamped amount and the one-for-one assertion below would be
        // testing the clamp rather than the restoration. (Learned by writing
        // it the other way first: with a release above the instruction,
        // availability simply pins to `reported` and the delta is the
        // instruction, not the request.)
        uint256 release = instructed / 2;
        assertGt(release, 0, "need a nonzero release to assert on");
        messenger.deliverChainReportB3(
            CHAIN_ARB, 2, 20e18, 10e18, 900 ether, 0, release, release
        );

        (, , uint256 availAfter, ) = _agg().getChainRecycledLedger(CHAIN_ARB);
        assertEq(
            availAfter,
            availBefore + release,
            "a release must restore availability ONE FOR ONE - not merely "
            "leave it within its upper bound"
        );
    }

    /// The retirement cumulatives must RATCHET (Codex #1437 r2 P1). A stale
    /// or reordered report carrying LOWER figures must not walk them back:
    /// an implementation that overwrote them would satisfy every clamp, the
    /// outstanding identity and the availability ceiling, while reopening
    /// reservations already retired and discarding restored availability.
    /// The clamps bound the values; only this pins the direction.
    function test_Transition_RetirementCumulativesNeverRegress() public {
        messenger.deliverChainReportB3(
            CHAIN_BASE, 1, 10e18, 5e18, 900 ether, 0, 0, 0
        );
        messenger.deliverChainReportB3(
            CHAIN_ARB, 1, 20e18, 10e18, 900 ether, 0, 0, 0
        );
        messenger.deliverChainReportB3(
            CHAIN_OP, 1, 20e18, 10e18, 900 ether, 0, 0, 0
        );
        TestMutatorFacet(address(diamond)).setChainDayCommitmentCompleteRaw(
            1, CHAIN_ARB, true
        );
        TestMutatorFacet(address(diamond)).setChainDayCommitmentCompleteRaw(
            1, CHAIN_OP, true
        );
        _agg().finalizeDay(1);

        // A high-water report, then a stale one carrying lower figures.
        messenger.deliverChainReportB3(
            CHAIN_ARB, 2, 20e18, 10e18, 900 ether, 0, 200 ether, 150 ether
        );
        (uint256 retHigh, uint256 relHigh) =
            _agg().getChainRecycledCommitRetirement(CHAIN_ARB);
        (, , uint256 availHigh, ) = _agg().getChainRecycledLedger(CHAIN_ARB);

        messenger.deliverChainReportB3(
            CHAIN_ARB, 3, 20e18, 10e18, 900 ether, 0, 10 ether, 5 ether
        );

        (uint256 retLow, uint256 relLow) =
            _agg().getChainRecycledCommitRetirement(CHAIN_ARB);
        (, , uint256 availLow, ) = _agg().getChainRecycledLedger(CHAIN_ARB);
        assertEq(retLow, retHigh, "retired ratchet walked backwards");
        assertEq(relLow, relHigh, "released ratchet walked backwards");
        assertEq(availLow, availHigh, "restored availability was discarded");
    }

    /// The ratchet is what makes both of the above safe: a stale delivery
    /// carrying an OLDER cumulative must never walk the ledger backwards.
    function test_Ordering_StaleReportNeverRegressesTheLedger() public {
        messenger.deliverChainReportB3(
            CHAIN_ARB, 3, 20e18, 10e18, 900 ether, 0, 0, 0
        );
        messenger.deliverChainReportB3(
            CHAIN_ARB, 4, 20e18, 10e18, 100 ether, 0, 0, 0
        );
        (uint256 reported, , , ) = _agg().getChainRecycledLedger(CHAIN_ARB);
        assertEq(reported, 900 ether, "ratchet held at the high-water mark");
    }
}

/**
 * @notice Fuzz driver for the mesh ingress. Every action is bounded and
 *         swallows reverts: the invariants are about the STATE the ingress
 *         is willing to reach, so a rejected message (duplicate day, report
 *         after finalization, unknown chain) is a valid outcome to explore,
 *         not a failure.
 */
contract MeshHandler is Test {
    RewardAggregatorFacet internal agg;
    TestMutatorFacet internal mut;
    MockRewardMessenger internal messenger;

    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    uint32 internal constant CHAIN_OP = 10;

    /// Replay log — every report actually delivered, so `redeliver` can
    /// reproduce one VERBATIM (that is what makes the duplicate-delivery
    /// clause of §7 #6 a real test rather than a near-miss).
    struct Sent {
        uint32 chainId;
        uint256 dayId;
        uint256 cumulative;
        uint256 retired;
        uint256 released;
    }

    Sent[] public sent;

    /// Steps the reserved-band day pair used by {instructThenRetire}.
    uint256 internal retireNonce;

    constructor(address diamond_, address messenger_) {
        agg = RewardAggregatorFacet(diamond_);
        mut = TestMutatorFacet(diamond_);
        messenger = MockRewardMessenger(payable(messenger_));
    }

    /// Codex #1437 r1 P1 — the reported cumulative is DELIBERATELY unbounded
    /// in production (B1: it is a chain's own lifetime absorption, monotonic
    /// guard, no cap). A generator capped at a few million never visits the
    /// states that actually stress the arithmetic, so one seed in eight lands
    /// in the near-`type(uint256).max` band on purpose.
    function _cumulative(uint256 seed) internal pure returns (uint256) {
        if (seed % 8 == 0) {
            return type(uint256).max - (seed % 1_000_000);
        }
        return seed % 2_000_000 ether;
    }

    function _chain(uint256 seed) internal pure returns (uint32) {
        uint256 k = seed % 3;
        if (k == 0) return CHAIN_BASE;
        if (k == 1) return CHAIN_ARB;
        return CHAIN_OP;
    }

    /// A day-close report in the CURRENT (eight-word) shape. Magnitudes are
    /// deliberately allowed to be hostile — up to and including values far
    /// above anything Base ever instructed — because that is precisely what
    /// the ingest clamps exist to bound.
    function reportB3(
        uint256 chainSeed,
        uint256 daySeed,
        uint256 cumulative,
        uint256 retired,
        uint256 released
    ) external {
        uint32 c = _chain(chainSeed);
        uint256 day = daySeed % 40;
        try messenger.deliverChainReportB3(
            c,
            day,
            bound(cumulative, 0, 1_000 ether),
            bound(cumulative, 0, 100 ether),
            _cumulative(cumulative),
            0,
            bound(retired, 0, 3_000_000 ether),
            bound(released, 0, 3_000_000 ether)
        ) {
            sent.push(
                Sent({
                    chainId: c,
                    dayId: day,
                    cumulative: _cumulative(cumulative),
                    retired: bound(retired, 0, 3_000_000 ether),
                    released: bound(released, 0, 3_000_000 ether)
                })
            );
        } catch {}
    }

    /// The previous (six-word) generation — carries no retirement figures.
    /// Exercises the rollout path where a mirror has not upgraded yet.
    function reportLegacyB1(
        uint256 chainSeed,
        uint256 daySeed,
        uint256 cumulative
    ) external {
        try messenger.deliverChainReportRecycled(
            _chain(chainSeed),
            daySeed % 40,
            1e18,
            1e18,
            bound(cumulative, 0, 2_000_000 ether),
            0
        ) {} catch {}
    }

    /// The pre-#1222 (four-word) generation — carries neither the recycled
    /// figures nor the retirement pair.
    function reportLegacyPre1222(
        uint256 chainSeed,
        uint256 daySeed
    ) external {
        try messenger.deliverChainReport(
            _chain(chainSeed), daySeed % 40, 1e18, 1e18
        ) {} catch {}
    }

    /// Re-deliver an already-sent report VERBATIM. §7 #6's duplicate clause.
    function redeliver(uint256 idx) external {
        if (sent.length == 0) return;
        Sent memory s = sent[idx % sent.length];
        try messenger.deliverChainReportB3(
            s.chainId, s.dayId, 1e18, 1e18, s.cumulative, 0, s.retired, s.released
        ) {} catch {}
    }

    /// Finalize a day. Mirrors' commitment-completeness gates are satisfied
    /// directly (the mirror-side report is B4-b's territory), so the fuzzer
    /// can reach the armed funding resolution rather than stalling on a gate.
    function finalize(uint256 daySeed) external {
        uint256 day = daySeed % 40;
        mut.setChainDayCommitmentCompleteRaw(day, CHAIN_ARB, true);
        mut.setChainDayCommitmentCompleteRaw(day, CHAIN_OP, true);
        try agg.finalizeDay(day) {} catch {}
    }

    /// Advance the day cursor so later days become reportable/finalizable.
    function warp(uint256 delta) external {
        vm.warp(block.timestamp + bound(delta, 1 hours, 3 days));
    }

    /// The three-step ordering retirement REQUIRES — report, finalize (which
    /// is what creates the instruction the clamps bound against), then report
    /// a LATER day carrying retirement figures. Codex #1437 r1 P1: leaving
    /// this to chance meant the campaign reached instructions but never a
    /// single retirement, so B3's actual behaviour went unexercised while the
    /// suite stayed green. The individual steps remain separately fuzzable —
    /// this only guarantees the path is reachable at all.
    function instructThenRetire(
        uint256 chainSeed,
        uint256 daySeed,
        uint256 retired,
        uint256 released
    ) external {
        uint32 c = _chain(chainSeed);
        if (c == CHAIN_BASE) c = CHAIN_ARB; // Base never instructs itself
        // RESERVED day band, stepped by an internal counter. Every
        // `(chain, day)` slot is one-shot, so sharing the general day space
        // let ordinary reports consume this path's days before an instruction
        // ever existed — and a campaign that lost that race recorded zero
        // retirements. Each invariant gets its own independent sequence, so
        // "usually reaches it" is not good enough for a coverage guard.
        uint256 d0 = 40 + 2 * (retireNonce % 12);
        retireNonce += 1;
        // FULL coverage for d0, not just chain `c`. Finalization readiness is
        // "every expected chain reported" OR "grace elapsed since the first
        // report" — and no time passes inside a single call, so a lone report
        // here can only ever reach the grace path, which is not yet open. That
        // is precisely why the earlier version of this action still produced
        // zero retirements: its `finalizeDay` always reverted, so no
        // instruction existed for the retirement figures to clamp against.
        try messenger.deliverChainReportB3(
            CHAIN_BASE, d0, 10e18, 5e18, 900 ether, 0, 0, 0
        ) {} catch {}
        try messenger.deliverChainReportB3(
            CHAIN_ARB, d0, 20e18, 10e18, 900 ether, 0, 0, 0
        ) {} catch {}
        try messenger.deliverChainReportB3(
            CHAIN_OP, d0, 20e18, 10e18, 900 ether, 0, 0, 0
        ) {} catch {}
        mut.setChainDayCommitmentCompleteRaw(d0, CHAIN_ARB, true);
        mut.setChainDayCommitmentCompleteRaw(d0, CHAIN_OP, true);
        try agg.finalizeDay(d0) {} catch {}
        uint256 r = bound(retired, 1, 1_000 ether);
        try messenger.deliverChainReportB3(
            c,
            d0 + 1,
            20e18,
            10e18,
            900 ether,
            0,
            r,
            bound(released, 1, r)
        ) {} catch {}
    }

    /// Credit a day's absorption. Feeds `Ā`, which sizes the coupled target
    /// the armed funding resolution instructs against — without absorption
    /// the whole per-chain machinery is a no-op.
    function creditDay(uint256 daySeed, uint256 amount) external {
        mut.setRecycledCreditedByDayRaw(
            daySeed % 40, bound(amount, 0, 5_000 ether)
        );
    }

    function sentLength() external view returns (uint256) {
        return sent.length;
    }
}
