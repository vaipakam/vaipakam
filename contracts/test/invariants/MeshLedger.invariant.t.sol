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
import {RewardReporterFacet} from "../../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../../src/facets/RewardAggregatorFacet.sol";
import {VPFIToken} from "../../src/token/VPFIToken.sol";
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
 *         **What the fuzzer controls**, which is what makes §7 #6's
 *         sequencing clauses meaningful rather than scripted: report order,
 *         report content (including hostile magnitudes), duplicate delivery,
 *         dropped days, the wire generation used, and where `finalizeDay`
 *         falls between all of it.
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

    uint256 internal constant BUCKET_SEED = 5_000_000 ether;

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

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](7);
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
        bytes4[] memory sel = new bytes4[](7);
        sel[0] = MeshHandler.reportB3.selector;
        sel[1] = MeshHandler.reportLegacyB1.selector;
        sel[2] = MeshHandler.reportLegacyPre1222.selector;
        sel[3] = MeshHandler.redeliver.selector;
        sel[4] = MeshHandler.finalize.selector;
        sel[5] = MeshHandler.warp.selector;
        sel[6] = MeshHandler.creditDay.selector;
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
            assertLe(
                consumed,
                reported + released,
                "SS7#6: consumed <= reported + released"
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
    function invariant_GlobalRecycledCommitWithinBucket() public view {
        (, , uint256 outstandingRecycled, ) = _agg().getGovernorCommitState();
        (, uint256 bucket, ) = _agg().getRecycleCustodyPosition();
        assertLe(
            outstandingRecycled,
            bucket,
            "SS7#2: outstanding recycled commitments <= bucket"
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

    constructor(address diamond_, address messenger_) {
        agg = RewardAggregatorFacet(diamond_);
        mut = TestMutatorFacet(diamond_);
        messenger = MockRewardMessenger(payable(messenger_));
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
        uint256 day = daySeed % 12;
        try messenger.deliverChainReportB3(
            c,
            day,
            bound(cumulative, 0, 1_000 ether),
            bound(cumulative, 0, 100 ether),
            bound(cumulative, 0, 2_000_000 ether),
            0,
            bound(retired, 0, 3_000_000 ether),
            bound(released, 0, 3_000_000 ether)
        ) {
            sent.push(
                Sent({
                    chainId: c,
                    dayId: day,
                    cumulative: bound(cumulative, 0, 2_000_000 ether),
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
            daySeed % 12,
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
            _chain(chainSeed), daySeed % 12, 1e18, 1e18
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
        uint256 day = daySeed % 12;
        mut.setChainDayCommitmentCompleteRaw(day, CHAIN_ARB, true);
        mut.setChainDayCommitmentCompleteRaw(day, CHAIN_OP, true);
        try agg.finalizeDay(day) {} catch {}
    }

    /// Advance the day cursor so later days become reportable/finalizable.
    function warp(uint256 delta) external {
        vm.warp(block.timestamp + bound(delta, 1 hours, 3 days));
    }

    /// Credit a day's absorption. Feeds `Ā`, which sizes the coupled target
    /// the armed funding resolution instructs against — without absorption
    /// the whole per-chain machinery is a no-op.
    function creditDay(uint256 daySeed, uint256 amount) external {
        mut.setRecycledCreditedByDayRaw(
            daySeed % 12, bound(amount, 0, 5_000 ether)
        );
    }

    function sentLength() external view returns (uint256) {
        return sent.length;
    }
}
