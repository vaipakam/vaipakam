// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";

import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {
    InteractionRewardsLensFacet
} from "../src/facets/InteractionRewardsLensFacet.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";

import {HelperTest} from "./HelperTest.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MeshBusMessenger} from "./mocks/MeshBusMessenger.sol";
import {RewardBroadcastV2} from "../src/interfaces/IRewardMessenger.sol";

/**
 * @title  MeshThreeChainE2ETest
 * @notice #1222 M3 B4-b — the three-chain mesh END-TO-END suite: one
 *         canonical (Base) diamond and two mirror diamonds, wired to each
 *         other through a queueing messenger, driven around the full recycled
 *         funding cycle with no synthesised state on either side.
 *
 * @dev    **What this suite exists to reach that no other mesh test can.**
 *         Every pre-B4 mesh test runs against ONE diamond playing Base while
 *         `MockRewardMessenger.deliverChainReport*` synthesises the mirror's
 *         side from test-supplied arguments. Base's books are therefore
 *         checked against numbers the test invented, never against a mirror's
 *         real bucket, reservation ledger or retirement counters. Here every
 *         figure Base ingests was produced by a real mirror diamond executing
 *         real facet code, and every figure a mirror applies came out of
 *         Base's real finalization — so the two models can be compared, which
 *         is the whole point of B3's identity and the governor §7 clauses.
 *
 *         The cycle each test drives (design records
 *         `Vpfi1222B3SourceScopedNettingDesign.md` §2 and
 *         `Vpfi1222B2dDeliveredBackingDesign.md` §2e):
 *
 *           mirror `closeDay` → real 8-word send → bus queue → Base ingress
 *           → `finalizeDay` (armed mesh funding resolution instructs
 *           mirror-local funding) → `broadcastGlobal` → per-destination
 *           delivery → mirror reserves its instructed commit → mirror retires
 *           it → next `closeDay` carries the retirement cumulatives → Base
 *           closes the reservation and restores availability.
 *
 *         **Scope boundary.** The bus is a transparent transport: it composes
 *         and queues, it does not encode. Payload framing, generation
 *         fallbacks and fee accounting are `CrossChainRewardPlumbingTest`'s
 *         subject; the accounting across real diamonds is this one's.
 */
contract MeshThreeChainE2ETest is Test {
    // ─── Mesh topology ─────────────────────────────────────────────────────

    uint256 internal constant BASE = 8453;
    uint256 internal constant ARB = 42161;
    uint256 internal constant OP = 10;

    MeshBusMessenger internal bus;

    mapping(uint256 => address) internal diamondOf;
    address internal baseD;
    address internal arbD;
    address internal opD;

    /// @notice Mirror-side VPFI, one token per mirror — a mirror pays claims
    ///         from its own delivered balance.
    mapping(uint256 => VPFIToken) internal vpfiOf;

    /// @dev Seed sizes. The bucket is what a mirror can self-fund from; the
    ///      per-day absorption feed is what sizes the armed day's coupled
    ///      target (`Ā`) — B4-a's hard-won lesson is that seeding the bucket
    ///      WITHOUT the absorption feed leaves `Ā = 0`, nothing is ever
    ///      instructed, and every ledger assertion passes vacuously.
    uint256 internal constant BUCKET_SEED = 500_000 ether;
    /// @dev Per-chain daily absorption, deliberately DIFFERENT per mirror.
    ///      Identical feeds left the per-`(day, chain)` attribution ledger
    ///      unverifiable: swapping ARB's and OP's `recycledForDay18` preserved
    ///      every asserted value and the aggregate `Ā` (Codex #1439 r4). That
    ///      ledger is the headroom baseline later reports are clamped against,
    ///      so it needs its own discriminating assertion.
    uint256 internal constant ABSORB_ARB = 700 ether;
    uint256 internal constant ABSORB_OP = 900 ether;

    address internal alice;

    // ─── Setup ─────────────────────────────────────────────────────────────

    function setUp() public {
        alice = makeAddr("alice");
        bus = new MeshBusMessenger();

        // Facets are stateless code — one deployment serves all three
        // diamonds, exactly as one facet address serves every caller on a
        // live chain.
        HelperTest helper = new HelperTest();
        IDiamondCut.FacetCut[] memory cuts = _buildCuts(helper);

        baseD = _deployChain(BASE, cuts);
        arbD = _deployChain(ARB, cuts);
        opD = _deployChain(OP, cuts);

        _wireBase();
        _wireMirror(ARB);
        _wireMirror(OP);

        bus.enroll(BASE, baseD, true);
        bus.enroll(ARB, arbD, false);
        bus.enroll(OP, opD, false);
        uint256[] memory dests = new uint256[](2);
        dests[0] = ARB;
        dests[1] = OP;
        bus.setBroadcastDestinations(dests);
    }

    function _buildCuts(HelperTest helper)
        private
        returns (IDiamondCut.FacetCut[] memory cuts)
    {
        cuts = new IDiamondCut.FacetCut[](9);
        cuts[0] = _cut(
            address(new AccessControlFacet()),
            helper.getAccessControlFacetSelectors()
        );
        cuts[1] =
            _cut(address(new AdminFacet()), helper.getAdminFacetSelectors());
        cuts[2] = _cut(
            address(new VPFITokenFacet()), helper.getVPFITokenFacetSelectors()
        );
        cuts[3] = _cut(
            address(new InteractionRewardsFacet()),
            helper.getInteractionRewardsFacetSelectors()
        );
        cuts[4] = _cut(
            address(new InteractionRewardsLensFacet()),
            helper.getInteractionRewardsLensFacetSelectors()
        );
        cuts[5] = _cut(
            address(new RewardClaimFacet()),
            helper.getRewardClaimFacetSelectors()
        );
        cuts[6] = _cut(
            address(new RewardReporterFacet()),
            helper.getRewardReporterFacetSelectors()
        );
        cuts[7] = _cut(
            address(new RewardAggregatorFacet()),
            helper.getRewardAggregatorFacetSelectors()
        );
        cuts[8] = _cut(
            address(new TestMutatorFacet()),
            helper.getTestMutatorFacetSelectors()
        );
    }

    function _cut(address facet, bytes4[] memory selectors)
        private
        pure
        returns (IDiamondCut.FacetCut memory)
    {
        return IDiamondCut.FacetCut({
            facetAddress: facet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });
    }

    /// @dev Stand up one chain's diamond and its local VPFI. `vm.chainId` is
    ///      pinned for the whole deployment because several initializers read
    ///      `block.chainid` into storage.
    function _deployChain(uint256 chainId, IDiamondCut.FacetCut[] memory cuts)
        private
        returns (address d)
    {
        vm.chainId(chainId);
        d = address(new VaipakamDiamond(address(this), address(new DiamondCutFacet())));
        IDiamondCut(d).diamondCut(cuts, address(0), "");

        AccessControlFacet(d).initializeAccessControl();
        AdminFacet(d).unpause();
        AdminFacet(d).setTreasury(d);

        VPFIToken impl = new VPFIToken();
        VPFIToken token = VPFIToken(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        VPFIToken.initialize,
                        (address(this), address(this), address(this))
                    )
                )
            )
        );
        vpfiOf[chainId] = token;
        VPFITokenFacet(d).setCanonicalVPFIChain(chainId == BASE);
        VPFITokenFacet(d).setVPFIToken(address(token));

        // Same launch instant on every chain, so day `d` means the same
        // interval mesh-wide — the assumption the whole day-close protocol
        // rests on.
        InteractionRewardsFacet(d).setInteractionLaunchTimestamp(block.timestamp);

        diamondOf[chainId] = d;
    }

    function _wireBase() private {
        vm.chainId(BASE);
        RewardReporterFacet(baseD).setBaseChainId(uint32(BASE));
        RewardReporterFacet(baseD).setIsCanonicalRewardChain(true);
        RewardReporterFacet(baseD).setRewardMessenger(address(bus));

        uint32[] memory expected = new uint32[](3);
        expected[0] = uint32(BASE);
        expected[1] = uint32(ARB);
        expected[2] = uint32(OP);
        RewardAggregatorFacet(baseD).setExpectedSourceChainIds(expected);
    }

    function _wireMirror(uint256 chainId) private {
        address d = diamondOf[chainId];
        vm.chainId(chainId);
        RewardReporterFacet(d).setBaseChainId(uint32(BASE));
        RewardReporterFacet(d).setRewardMessenger(address(bus));
    }

    // ─── Cycle drivers ─────────────────────────────────────────────────────

    function _agg() private view returns (RewardAggregatorFacet) {
        return RewardAggregatorFacet(baseD);
    }

    function _mut(uint256 chainId) private view returns (TestMutatorFacet) {
        return TestMutatorFacet(diamondOf[chainId]);
    }

    /// @dev Advance the clock so `day` is strictly past and therefore
    ///      closable everywhere (all three chains share a launch instant).
    function _warpPast(uint256 day) private {
        vm.warp(vm.getBlockTimestamp() + day * 1 days + 1);
    }

    /// @dev Give `chainId` a real recycle bucket and a real per-day
    ///      absorption feed for the trailing `Ā` window. Written through the
    ///      mutator because the upstream absorption channels (M1 tariff, fee
    ///      routing) are not this suite's subject — but the values then live
    ///      in that diamond's OWN storage and are read back by its OWN
    ///      `closeDay`, so what Base ingests is still that chain's real book.
    function _seedRecycled(uint256 chainId, uint256 throughDay) private {
        uint256 perDay = _absorbFor(chainId);
        _mut(chainId).setRecycleBucketRaw(BUCKET_SEED);
        for (uint256 d = 1; d <= throughDay; ++d) {
            _mut(chainId).setRecycledCreditedByDayRaw(d, perDay);
        }
    }

    function _absorbFor(uint256 chainId) private pure returns (uint256) {
        return chainId == ARB ? ABSORB_ARB : ABSORB_OP;
    }

    /// @dev Every mirror learns `D*` only in-band, from the first broadcast
    ///      applied after Base arms. If that field were dropped anywhere in
    ///      the chain — V2 assembly, bus composition, mirror ingress — Base
    ///      would still finalize as armed and each mirror would still reserve
    ///      the nonzero `recycleConsume`, so every reservation and decay
    ///      assertion would pass while the mirror was never actually armed
    ///      (Codex #1439 r4). Any conclusion about ARMED-day behaviour has to
    ///      pin this first.
    function _assertMirrorsArmedFrom(uint256 day) private view {
        (uint256 arbArmed,,,) =
            RewardAggregatorFacet(arbD).getGovernorCommitState();
        (uint256 opArmed,,,) =
            RewardAggregatorFacet(opD).getGovernorCommitState();
        assertEq(arbArmed, day, "ARB learned the arming day from the broadcast");
        assertEq(opArmed, day, "OP learned the arming day from the broadcast");
    }

    /// @dev Every chain closes `dayId` for real. Base writes locally; the two
    ///      mirrors send through the bus, which queues.
    function _allChainsCloseDay(uint256 dayId) private {
        vm.chainId(ARB);
        RewardReporterFacet(arbD).closeDay(dayId);
        vm.chainId(OP);
        RewardReporterFacet(opD).closeDay(dayId);
        vm.chainId(BASE);
        RewardReporterFacet(baseD).closeDay(dayId);
    }

    /// @dev Queued reports the test has deliberately DROPPED. Membership is
    ///      permanent: a dropped message models one the lane lost, so no
    ///      later delivery sweep may quietly pick it up — without this the
    ///      self-heal test would deliver the "lost" report on its next sweep
    ///      and prove nothing (the end state is identical either way, because
    ///      the later report's cumulative subsumes it).
    mapping(uint256 => bool) internal droppedReport;

    /// @dev Deliver every queued report that is neither delivered nor
    ///      deliberately dropped.
    function _deliverPendingReports() private {
        vm.chainId(BASE);
        uint256 n = bus.reportCount();
        for (uint256 i; i < n; ++i) {
            if (bus.reportDeliveries(i) == 0 && !droppedReport[i]) {
                bus.deliverReport(i);
            }
        }
    }

    function _finalize(uint256 dayId) private {
        vm.chainId(BASE);
        _agg().finalizeDay(dayId);
    }

    function _broadcast(uint256 dayId) private {
        vm.chainId(BASE);
        _agg().broadcastGlobal(dayId);
    }

    /// @dev Deliver one queued broadcast to its own destination, with the
    ///      chain id the destination will observe. This is the step a
    ///      contract cannot take for itself — only the test owns `vm.chainId`
    ///      — and it is why the bus queues instead of relaying.
    function _deliverBroadcastAt(uint256 i) private {
        vm.chainId(bus.broadcastAt(i).destChainId);
        bus.deliverBroadcast(i);
    }

    function _deliverBroadcastFor(uint256 dayId, uint256 destChainId) private {
        _deliverBroadcastAt(bus.findBroadcast(dayId, destChainId));
    }

    /// @dev Arm the mesh from `dayId` on Base — the D* cutover switch.
    function _arm(uint256 dayId) private {
        _mut(BASE).setGovernorCommitArmedFromDayRaw(dayId);
    }

    /// @dev Seed a day's LOCAL interest on `chainId` so its report carries a
    ///      real denominator contribution.
    ///
    ///      `setDailyLenderInterest` is a SINGLE-CHAIN helper: it also
    ///      pre-stamps `knownGlobal*`, which on a mirror is exactly the value
    ///      Base's broadcast is supposed to deliver. Leaving it stamped would
    ///      hide the broadcast's job — and the real ingress rejects the packet
    ///      outright (`KnownGlobalAlreadySet`) rather than overwrite a
    ///      consensus figure it did not agree with. So a mirror's copy is
    ///      cleared here and only Base keeps its own locally-computed pair.
    function _seedInterest(
        uint256 chainId,
        uint256 dayId,
        address who,
        uint256 lenderTotal,
        uint256 borrowerTotal
    ) private {
        _mut(chainId).setDailyLenderInterest(dayId, who, lenderTotal, lenderTotal);
        _mut(chainId).setDailyBorrowerInterest(
            dayId, who, borrowerTotal, borrowerTotal
        );
        // Clear AFTER both sides: each single-chain seeder stamps
        // `knownGlobalSet`, and on a mirror that pair must arrive from
        // Base's broadcast (see the note on the caller).
        if (chainId != BASE) {
            _mut(chainId).setKnownGlobalDailyInterest(dayId, 0, 0, false);
        }
    }

    /// @dev Seed `dayId` on all three chains with DELIBERATELY UNEQUAL
    ///      interest. The asymmetry is load-bearing, not decoration: a mirror's
    ///      instructed slice is sized from its share of the day's global
    ///      denominator, so equal seeds would give ARB and OP identical
    ///      figures — and a fan-out that cross-wired the two destinations
    ///      would then satisfy every per-chain assertion in this suite. With
    ///      ARB at twice OP, a mis-routed packet is detectable.
    function _seedAllInterest(uint256 dayId) private {
        // FOUR pairwise-distinct totals across two chains and two sides. The
        // asymmetry is load-bearing twice over: unequal per-chain figures make
        // a cross-wired fan-out detectable, and unequal per-SIDE figures make
        // a dropped or cross-wired BORROWER leg detectable. Seeding the lender
        // side alone left every borrower report and every borrower funding
        // field at zero, so half the two-sided path was untested and any
        // regression in it passed the whole suite (Codex #1439 r3).
        _seedInterest(ARB, dayId, alice, 2e18, 3e18);
        _seedInterest(OP, dayId, alice, 1e18, 5e18);
        _seedInterest(BASE, dayId, alice, 1e18, 7e18);
    }

    /// @dev One complete mesh cycle for `dayId`: every chain closes the day
    ///      → reports reach Base → Base finalizes → Base broadcasts → each
    ///      mirror applies its own packet.
    ///
    ///      The SAME sequence regardless of arming — armedness is a property
    ///      of whether `_arm` has been called for a day at or below `dayId`,
    ///      not of the cycle. On an armed day the finalize step additionally
    ///      runs the mesh funding resolution and the packets carry a nonzero
    ///      `recycleConsume`; on an unarmed day they carry zero and nothing
    ///      is reserved.
    function _runDayCycle(uint256 dayId) private {
        _allChainsCloseDay(dayId);
        _deliverPendingReports();
        _finalize(dayId);
        _broadcast(dayId);
        _deliverBroadcastFor(dayId, ARB);
        _deliverBroadcastFor(dayId, OP);
    }

    // ─── Tests ─────────────────────────────────────────────────────────────

    /**
     * @notice The full cycle across three real diamonds: each mirror's own
     *         report drives Base's finalization, and Base's per-destination
     *         instruction lands back on that same mirror as a real
     *         reservation in its own books.
     *
     *         The load-bearing assertion is the LAST one: Base's
     *         `chainConsumedRecycled[c]` (what it instructed) equals the
     *         mirror's own `outstandingCommitRecycled` (what the mirror
     *         reserved). Those are two independent diamonds' storage slots
     *         reached by two different code paths; a single-diamond mesh test
     *         can only ever assert one of them.
     */
    function test_E2E_InstructionMatchesMirrorReservationOnBothMirrors() public {
        _seedRecycled(ARB, 8);
        _seedRecycled(OP, 8);
        _seedAllInterest(5);
        _arm(5);
        _warpPast(6);

        _runDayCycle(5);

        // Base instructed BOTH mirrors — a fan-out that reached only one
        // destination would leave the other's ledger at zero.
        (, uint256 arbInstructed,,) = _agg().getChainRecycledLedger(uint32(ARB));
        (, uint256 opInstructed,,) = _agg().getChainRecycledLedger(uint32(OP));
        assertGt(arbInstructed, 0, "ARB instructed to self-fund");
        assertGt(opInstructed, 0, "OP instructed to self-fund");
        // The two instructions must actually DIFFER, or every per-chain
        // assertion below would survive a fan-out that swapped the two
        // destinations. ARB was seeded at twice OP's interest precisely so
        // this discriminates.
        assertTrue(
            arbInstructed != opInstructed,
            "the two destinations carry distinguishable figures"
        );

        // Bind each instruction to ITS OWN source report. Distinguishable
        // instructions alone do not prove correct attribution: a delivery
        // that swapped the two chains' interest totals while keeping their
        // source ids would still produce two unequal instructions, and each
        // mirror would still reserve exactly what Base computed under the
        // corrupted key (Codex #1439 r2). Asserting the ingested numerators
        // is what detects cross-attributed demand.
        (uint256 arbLender, uint256 arbBorrower) =
            _agg().getChainReport(5, uint32(ARB));
        (uint256 opLender, uint256 opBorrower) =
            _agg().getChainReport(5, uint32(OP));
        assertEq(arbLender, 2e18, "Base ingested ARB's own lender total");
        assertEq(opLender, 1e18, "Base ingested OP's own lender total");
        assertEq(arbBorrower, 3e18, "Base ingested ARB's own borrower total");
        assertEq(opBorrower, 5e18, "Base ingested OP's own borrower total");

        // The BORROWER half of the funding actually reaches each mirror. A
        // regression dropping or cross-wiring the borrower leg leaves these
        // at zero (or swapped) while every lender-side figure stays correct.
        RewardBroadcastV2 memory arbPacket =
            bus.broadcastAt(bus.findBroadcast(5, ARB));
        RewardBroadcastV2 memory opPacket =
            bus.broadcastAt(bus.findBroadcast(5, OP));
        assertGt(arbPacket.freshBorrowerHalf, 0, "ARB funded on the borrower side");
        assertGt(opPacket.freshBorrowerHalf, 0, "OP funded on the borrower side");
        assertGt(
            arbPacket.recycledBorrowerHalfEquiv,
            0,
            "ARB's borrower leg carries recycled funding"
        );
        assertGt(
            opPacket.recycledBorrowerHalfEquiv,
            0,
            "OP's borrower leg carries recycled funding"
        );

        // Each mirror STORED exactly the packet it was sent, field for field.
        // Positivity alone would not notice a lender-derived value copied
        // into a borrower slot at ingest (Codex #1439 r4) — and here the
        // fresh halves are equal by construction, so only an
        // packet-vs-stamp comparison can catch that class.
        _assertStampMatchesPacket(ARB, 5, arbPacket);
        _assertStampMatchesPacket(OP, 5, opPacket);

        // The finalized consensus pair: Base's own contribution is IN the
        // denominator (2+1+1 lender, 3+5+7 borrower), and both mirrors hold
        // that identical pair after delivery. Without this, Base omitting its
        // own contribution or the broadcast swapping the two sides leaves
        // funding nonzero and every reservation equality intact.
        (bool finalized, uint256 gL, uint256 gB) = _agg().getDailyGlobalInterest(5);
        assertTrue(finalized, "day 5 finalized");
        assertEq(gL, 4e18, "global lender denominator = 2 + 1 + 1");
        assertEq(gB, 15e18, "global borrower denominator = 3 + 5 + 7");
        _assertMirrorKnowsGlobals(ARB, 5, gL, gB);
        _assertMirrorKnowsGlobals(OP, 5, gL, gB);

        // The cap family produced by REAL finalization — mode and both
        // per-side ceilings — reaches each mirror intact. Existing ingress
        // coverage starts from a test-constructed packet, so a regression in
        // Base's V2 assembly that zeroed or swapped the real ceilings would
        // not be caught there.
        (uint256 baseCapL, uint256 baseCapB) = _agg().getDayUserSideCaps(5);
        assertEq(arbPacket.capMode, 1, "armed day broadcasts ShareOfPool");
        assertEq(arbPacket.capPayloadLender, baseCapL, "ARB packet lender cap");
        assertEq(arbPacket.capPayloadBorrower, baseCapB, "ARB packet borrower cap");
        _assertMirrorCaps(ARB, 5, baseCapL, baseCapB);
        _assertMirrorCaps(OP, 5, baseCapL, baseCapB);

        // Per-`(day, chain)` recycle attribution — the headroom baseline
        // later reports are clamped against. Distinct per-chain feeds make a
        // swap detectable.
        (uint256 arbCredit, bool arbAccepted) =
            _agg().getChainDailyRecycledCredit(5, uint32(ARB));
        (uint256 opCredit, bool opAccepted) =
            _agg().getChainDailyRecycledCredit(5, uint32(OP));
        assertTrue(arbAccepted && opAccepted, "both day-5 credits accepted");
        assertEq(arbCredit, ABSORB_ARB, "ARB's own daily credit attributed");
        assertEq(opCredit, ABSORB_OP, "OP's own daily credit attributed");
        // ...and the INSTRUCTIONS themselves follow each chain's own
        // numerators. Storing the reports under the right source ids does not
        // bind the funding CALCULATION: if `resolveAndStampDayFunding` read
        // OP's demand while building ARB's work item, every attribution
        // assertion above still passes, the two instructions stay unequal,
        // and each mirror faithfully reserves the wrong figure recorded for
        // it (Codex #1439 r5). Pinning both magnitudes is what closes that.
        //
        // ARB carries the larger lender share (2/4 vs 1/4) and the smaller
        // borrower share (3/15 vs 5/15); netted against the day's halves that
        // resolves to ~76 vs ~63.33. A cross-read swaps them, so both
        // assertions fail. Re-derive these two figures if the emission
        // schedule or the seeded demand changes.
        assertApproxEqAbs(
            arbInstructed, 76 ether, 1e12, "ARB's instruction follows ARB's demand"
        );
        assertApproxEqAbs(
            opInstructed, 63.3333e18, 1e15, "OP's instruction follows OP's demand"
        );
        assertGt(
            arbInstructed,
            opInstructed,
            "and their ORDERING follows demand, so a swap inverts it"
        );
        // NOTE on what these halves can and cannot discriminate — worth
        // recording, because the obvious assertion is the wrong one. The
        // fresh halves are a GLOBAL schedule floor (identical for every
        // destination AND both sides), and the recycled halves are
        // GLOBAL-EQUIVALENT figures, so neither varies per chain: here all
        // four fresh halves are 10082.19 and all four recycled halves are
        // ~95, differing only by rounding dust. Per-chain differentiation
        // lives in `recycleConsume` — the local funding instruction —
        // asserted above as `arbInstructed != opInstructed`. A cross-wired
        // BORROWER leg is therefore caught by the demand-attribution
        // assertions, not by comparing these halves.

        // Base's reservation ledger for each chain opens at the full
        // instruction (nothing retired yet).
        assertEq(
            _agg().getChainOutstandingRecycledCommit(uint32(ARB)),
            arbInstructed,
            "Base reserves ARB's whole instruction"
        );
        assertEq(
            _agg().getChainOutstandingRecycledCommit(uint32(OP)),
            opInstructed,
            "Base reserves OP's whole instruction"
        );

        // ...and each MIRROR's own books hold exactly what Base instructed
        // for it — the two-diamond agreement no single-diamond test reaches.
        assertEq(
            _localOutstanding(ARB),
            arbInstructed,
            "ARB reserved exactly what Base instructed IT"
        );
        assertEq(
            _localOutstanding(OP),
            opInstructed,
            "OP reserved exactly what Base instructed IT"
        );
    }

    /**
     * @notice Governor §7 #6, MIRROR side — a DUPLICATE broadcast delivery is
     *         a no-op.
     *
     * @dev    B4-a established the Base-side half and, in doing so, corrected
     *         the premise this test was originally written against: on Base a
     *         duplicate REPORT reverts (`ChainDayAlreadyReported`), so the
     *         "duplicate is a no-op" clause can only be about the mirror end
     *         of the wire. CCIP can legitimately re-execute a message, so the
     *         hazard is real: a second application of the same packet must not
     *         reserve the commitment twice, or the mirror would encumber
     *         double what Base instructed and under-report availability
     *         forever.
     */
    function test_E2E_DuplicateBroadcastToMirrorDoesNotDoubleTheReservation()
        public
    {
        _seedRecycled(ARB, 8);
        _seedRecycled(OP, 8);
        _seedAllInterest(5);
        _arm(5);
        _warpPast(6);

        _runDayCycle(5);

        uint256 reservedOnce = _localOutstanding(ARB);
        assertGt(reservedOnce, 0, "ARB reserved something to duplicate");

        // Re-deliver the IDENTICAL queued packet — byte-for-byte the message
        // the mirror already applied.
        uint256 idx = bus.findBroadcast(5, ARB);
        _deliverBroadcastAt(idx);
        assertEq(bus.broadcastDeliveries(idx), 2, "packet delivered twice");

        assertEq(
            _localOutstanding(ARB),
            reservedOnce,
            "duplicate broadcast did not re-reserve"
        );
        // The other mirror is untouched by ARB's replay.
        assertEq(
            _localOutstanding(OP),
            _instructedFor(OP),
            "OP's reservation unaffected by ARB's duplicate"
        );
    }

    /**
     * @notice A broadcast delivered to the WRONG mirror is rejected outright
     *         — the replay-stable binding, proved across two real diamonds
     *         rather than against a synthesised packet.
     */
    function test_E2E_BroadcastDeliveredToWrongMirrorReverts() public {
        _seedRecycled(ARB, 8);
        _seedRecycled(OP, 8);
        _seedAllInterest(5);
        _arm(5);
        _warpPast(6);

        _allChainsCloseDay(5);
        _deliverPendingReports();
        _finalize(5);
        _broadcast(5);

        // ARB's packet, handed to OP's diamond while OP's chain id is live.
        uint256 arbIdx = bus.findBroadcast(5, ARB);
        vm.chainId(OP);
        vm.expectRevert(
            abi.encodeWithSignature("BroadcastDestinationMismatch(uint256)", ARB)
        );
        bus.deliverBroadcastTo(arbIdx, opD);
    }

    /**
     * @notice Governor §7 #6 — a MISSED mirror report self-heals: the next
     *         report's monotonic cumulative carries the whole backlog, so
     *         Base's availability model catches up without any replay of the
     *         dropped message.
     */
    function test_E2E_DroppedMirrorReportSelfHealsOnTheNextOne() public {
        _seedRecycled(ARB, 8);
        _seedRecycled(OP, 8);
        _warpPast(6);

        // Day 4: every chain closes, but ARB's queued report is DROPPED.
        _seedAllInterest(4);
        _allChainsCloseDay(4);
        uint256 arbDay4 = _findReport(4, ARB);
        _dropReportAndDeliverRest(arbDay4);

        (uint256 reportedAfterDrop,,,) =
            _agg().getChainRecycledLedger(uint32(ARB));
        assertEq(reportedAfterDrop, 0, "ARB's day-4 report never landed");

        // SPEND part of the bucket, then absorb more. This separation is the
        // whole point: a `closeDay` that regressed from reporting the lifetime
        // `creditedCumulative` to reporting the LIVE `recycleBucket` would be
        // indistinguishable while nothing had ever been consumed, because the
        // two figures coincide (Codex #1439 r3). After a spend they diverge —
        // `creditedCumulative = recycleBucket + paidOutRecycled` — so only a
        // report carrying the true lifetime figure can heal Base to the value
        // asserted below.
        _mut(ARB).consumeRecycleRaw(40_000 ether);
        assertEq(
            _mut(ARB).getRecycleBucketRaw(),
            BUCKET_SEED - 40_000 ether,
            "the spend really left the bucket"
        );
        // Absorb 25k on top of the POST-SPEND balance.
        _mut(ARB).setRecycleBucketRaw(BUCKET_SEED - 40_000 ether + 25_000 ether);
        _seedAllInterest(5);
        _allChainsCloseDay(5);
        _deliverPendingReports();

        // The dropped message stayed dropped for the whole test — otherwise
        // the assertion below would be satisfied by a late delivery rather
        // than by the self-heal, and the two are indistinguishable from the
        // end state alone (the later cumulative subsumes the earlier one).
        assertEq(
            bus.reportDeliveries(arbDay4), 0, "day-4 report was never delivered"
        );

        (uint256 reportedAfterHeal,,,) =
            _agg().getChainRecycledLedger(uint32(ARB));
        // The LIVE bucket is now 485k while the LIFETIME cumulative is 525k.
        // Base must heal to the cumulative, not to the balance.
        assertEq(
            _mut(ARB).getRecycleBucketRaw(),
            BUCKET_SEED - 40_000 ether + 25_000 ether,
            "live bucket sits BELOW the lifetime cumulative"
        );
        assertEq(
            reportedAfterHeal,
            BUCKET_SEED + 25_000 ether,
            "one later report restored the FULL lifetime cumulative, backlog and spend included"
        );
    }

    /**
     * @notice B3's headline behaviour, end to end: a mirror that RELEASES a
     *         commitment un-spent reports it on its next day-close, and Base
     *         both closes the reservation and gives the availability back.
     *
     * @dev    This is the loop B3 built and no single-diamond test can run:
     *         the retirement figures Base ingests here were produced by the
     *         REAL `LibVpfiRecycle.releaseCommitment` primitive running on the
     *         mirror's own reservation, and are read back out of the mirror's
     *         own `closeDay`.
     */
    function test_E2E_MirrorReleaseFlowsBackAndRestoresBaseAvailability()
        public
    {
        _seedRecycled(ARB, 10);
        _seedRecycled(OP, 10);
        _seedAllInterest(5);
        _arm(5);
        _warpPast(7);

        _runDayCycle(5);

        uint256 instructed = _instructedFor(ARB);
        // Not just "> 0": the release below is `instructed / 2`, so a
        // regression shrinking the instruction to a wei would floor the
        // release to ZERO and every assertion in this test would pass
        // without exercising a release at all (Codex #1439 r2). Pin a
        // magnitude, then pin the derived release itself.
        assertGt(
            instructed, 1 ether, "ARB's instruction is of a meaningful size"
        );
        (,, uint256 availBefore,) = _agg().getChainRecycledLedger(uint32(ARB));

        // ARB releases HALF of what it reserved. Half, not all: a release is
        // clamped to the outstanding reservation, so releasing MORE than the
        // instruction would restore only the instruction and the test could
        // not tell a correct partial credit from a saturated one.
        uint256 release = instructed / 2;
        assertGt(release, 0, "the partial release is non-zero");
        vm.chainId(ARB);
        _mut(ARB).releaseRecycleCommitmentRaw(release);

        // The mirror's own counters moved — and by the ACTUAL decrement.
        (uint256 localRetired, uint256 localReleased) =
            RewardAggregatorFacet(arbD).getLocalRecycledCommitRetirement();
        assertEq(localRetired, release, "mirror retired the released amount");
        assertEq(localReleased, release, "a release counts on both counters");
        // ...and the mirror's OWN reservation actually fell. Counters alone
        // would not notice a `releaseCommitment` that advanced both
        // cumulatives without decrementing `outstandingCommitRecycled`: the
        // mirror would stay encumbered while Base restored its availability,
        // and the two ledgers would drift until Base instructed more than the
        // mirror can fund (Codex #1439 r5).
        assertEq(
            _localOutstanding(ARB),
            instructed - release,
            "the mirror's own reservation fell by the release"
        );

        // Day 6 closes on ARB and carries those counters to Base for real.
        _seedAllInterest(6);
        _allChainsCloseDay(6);
        _deliverPendingReports();

        (uint256 baseRetired, uint256 baseReleased) =
            _agg().getChainRecycledCommitRetirement(uint32(ARB));
        assertEq(baseRetired, release, "Base accepted the retirement");
        assertEq(baseReleased, release, "Base accepted the release");

        // B3's identity: outstanding == instructed − retired, at every
        // instant, in-flight broadcasts included.
        assertEq(
            _agg().getChainOutstandingRecycledCommit(uint32(ARB)),
            instructed - release,
            "Base closed the reservation by exactly the retirement"
        );

        // ...and the availability the release freed is back on the books.
        (,, uint256 availAfter,) = _agg().getChainRecycledLedger(uint32(ARB));
        assertEq(
            availAfter,
            availBefore + release,
            "released commitment restored availability one-for-one"
        );
    }

    /**
     * @notice The #1434 coupling, which only a three-chain e2e can show:
     *         with arming ON but mirror settlement still blocked, Base's
     *         per-chain reservation for a mirror GROWS with every armed day
     *         and its modelled availability FALLS — while that mirror's own
     *         bucket is untouched and its settlement totals stay at zero.
     *
     * @dev    **The operational consequence, which is the point.** Arming
     *         (`setGovernorCommitArmedFromDay`, the one-shot irreversible D*
     *         cutover) is the single switch that starts creating mirror
     *         reservations. While mirror armed-day pricing stays halted
     *         (#1434), those reservations accumulate with nothing retiring
     *         them, so Base progressively under-uses mirror-local funding and
     *         over-funds from its own bucket — the exact waste B3 removed
     *         from Base's own books, re-entering through the mirror end. It
     *         is recoverable (the totals are cumulative, so settlements after
     *         the halt lifts close the backlog) but D* cannot be walked back,
     *         so **#1434 lands before D* is chosen**.
     *
     *         **What this test does and does NOT establish (Codex #1439 r1,
     *         P1 — a correct finding, recorded rather than papered over).**
     *         It establishes the decay directly: two armed days, strictly
     *         growing outstanding, strictly falling availability, zero
     *         retirement on both sides. It does NOT establish the stronger
     *         counterfactual "the halt is the sole cause", because that
     *         counterfactual is not constructible today: lifting the halt in
     *         a mutation still retires nothing, since the armed-day mirror
     *         claim path has never been reachable and #1434's own two
     *         prerequisites (a delivered-fresh bound; zeroed-day repricing)
     *         are exactly what would make it pay. An earlier version of this
     *         test asserted the negative from a claim that paid only for the
     *         UNARMED day — which would have passed whether or not the halt
     *         had anything to do with it. The claim below is kept as a
     *         live-path WITNESS (it pays, and consumes zero recycled), not as
     *         proof of causation.
     *
     *         The halt itself is pinned separately by
     *         `test_D4_MirrorArmedDayPricingStaysHalted`.
     */
    function test_E2E_ArmingWithoutMirrorSettlementDecaysBaseAvailability()
        public
    {
        _seedRecycled(ARB, 12);
        _seedRecycled(OP, 12);
        _warpPast(8);

        // Alice claims from day 4 on — without this the walk starts at day 1
        // and stops on the first day whose global never reached this mirror.
        _mut(ARB).setInteractionLastClaimedDay(alice, 3);

        // A real reward ENTRY, because on an armed day `claimForUserWindow`
        // deletes the legacy per-day counters and pays through the entry path
        // only. Seeding legacy counters alone would leave the armed days with
        // nothing to price at all.
        uint256 entryId = _mut(ARB).pushRewardEntry(
            alice,
            /* loanId */ 1,
            LibVaipakam.RewardSide.Lender,
            /* perDayNumeraire18 */ 1e18,
            /* startDay */ 4
        );
        _mut(ARB).closeRewardEntryRaw(entryId, /* endDay */ 8);

        // Day 4, UNARMED — a genuinely payable day, and the day whose payout
        // proves the claim path is live on this mirror at all.
        _seedAllInterest(4);
        _runDayCycle(4);

        // ARB's live bucket before any armed day touches it.
        uint256 bucketBefore = _mut(ARB).getRecycleBucketRaw();
        assertEq(bucketBefore, BUCKET_SEED, "bucket starts at the seed");

        // Day 5, the first ARMED day.
        _seedAllInterest(5);
        _arm(5);
        _runDayCycle(5);

        // Before ANY conclusion about armed-day behaviour: both mirrors must
        // actually have learned D*.
        _assertMirrorsArmedFrom(5);

        uint256 outstandingAfterD5 =
            _agg().getChainOutstandingRecycledCommit(uint32(ARB));
        (,, uint256 availAfterD5,) = _agg().getChainRecycledLedger(uint32(ARB));
        assertGt(outstandingAfterD5, 0, "day 5 reserved something on Base");
        // The MIRROR's own reservation after the first armed day.
        uint256 localAfterD5 = _localOutstanding(ARB);

        // Day 6, a second ARMED day. Nothing retired the day-5 reservation in
        // between — because nothing on the mirror can.
        _seedAllInterest(6);
        _runDayCycle(6);

        uint256 outstandingAfterD6 =
            _agg().getChainOutstandingRecycledCommit(uint32(ARB));
        (,, uint256 availAfterD6,) = _agg().getChainRecycledLedger(uint32(ARB));
        uint256 localAfterD6 = _localOutstanding(ARB);

        // ACCUMULATION ON THE MIRROR ITSELF. Both figures above come from
        // Base's ledger, which Base writes at finalization — before the
        // broadcast is even delivered. So they would still grow if the mirror
        // ingress reserved only the cutover day and silently ignored day 6
        // (Codex #1439 r2). The documented multi-day mirror accumulation is
        // only established by reading the mirror's OWN books across both
        // days, and by requiring the two models to agree.
        assertGt(
            localAfterD6,
            localAfterD5,
            "the mirror reserved a SECOND armed day, not just the cutover"
        );
        assertEq(
            localAfterD6,
            outstandingAfterD6,
            "mirror's own reservation matches Base's model of it"
        );
        // ...and that agreement is only evidence if day 6 was computed from
        // ARB's OWN demand. Cross-attributing just the day-6 figures would
        // make Base size ARB's extra instruction from OP's demand and then
        // broadcast that same wrong amount back to ARB — so both models drift
        // TOGETHER and the equality above still holds (Codex #1439 r3). The
        // day-5 report assertions elsewhere do not cover day 6.
        (uint256 arbL6, uint256 arbB6) = _agg().getChainReport(6, uint32(ARB));
        (uint256 opL6, uint256 opB6) = _agg().getChainReport(6, uint32(OP));
        assertEq(arbL6, 2e18, "day 6 lender demand attributed to ARB");
        assertEq(arbB6, 3e18, "day 6 borrower demand attributed to ARB");
        assertEq(opL6, 1e18, "day 6 lender demand attributed to OP");
        assertEq(opB6, 5e18, "day 6 borrower demand attributed to OP");

        // THE DECAY. Base's reservation for ARB only grows, and what Base
        // believes ARB can self-fund only shrinks.
        assertGt(
            outstandingAfterD6,
            outstandingAfterD5,
            "a second armed day grew Base's reservation for ARB"
        );
        // NOTE — this strict decrease holds HERE because the fixture holds
        // ARB's absorption constant across the two armed days. It is not the
        // general property: a mirror that keeps absorbing ratchets `reported`
        // upward and can offset or exceed the instruction, so the absolute
        // figure need not fall (Codex #1439 r5). The invariant that always
        // holds is the one asserted just below — unretired instructions
        // accumulating while settlement stays at zero. Monitoring must key on
        // THAT, not on "availability fell".
        assertLt(
            availAfterD6,
            availAfterD5,
            "with absorption held constant, availability shrank"
        );

        // Nothing was retired on EITHER side of the wire across both days.
        (uint256 baseRetired,) =
            _agg().getChainRecycledCommitRetirement(uint32(ARB));
        assertEq(baseRetired, 0, "Base saw no retirement from ARB");
        (uint256 localRetired, uint256 localReleased) =
            RewardAggregatorFacet(arbD).getLocalRecycledCommitRetirement();
        assertEq(localRetired, 0, "ARB retired nothing locally");
        assertEq(localReleased, 0, "ARB released nothing locally");

        // ...and ARB's LIVE BUCKET is untouched: Base is withdrawing
        // availability for tokens that never moved. This is the
        // operator-visible symptom, and it must be read off the BUCKET.
        // Base's `chainReportedRecycled[c]` cannot stand in for it: that is a
        // monotonic lifetime-credit ratchet derived from
        // `recycleBucket + paidOutRecycled`, so it stays flat even if the
        // bucket were drained (Codex #1439 r2).
        assertEq(
            _mut(ARB).getRecycleBucketRaw(),
            bucketBefore,
            "ARB's live bucket never moved across either armed day"
        );
        (uint256 arbReported,,,) = _agg().getChainRecycledLedger(uint32(ARB));
        assertEq(
            arbReported, BUCKET_SEED, "and its reported absorption is flat too"
        );

        // WITNESS, not proof of causation: a real claim on this mirror runs
        // and pays — so the surface is live — and consumes zero recycled.
        vpfiOf[ARB].mint(arbD, 100_000 ether);
        vm.chainId(ARB);
        vm.prank(alice);
        (uint256 paid,,) = RewardClaimFacet(arbD).claimInteractionRewards();
        assertGt(paid, 0, "the claim surface is live on this mirror");
        (,,, uint256 paidOutRecycled) =
            RewardAggregatorFacet(arbD).getGovernorCommitState();
        assertEq(paidOutRecycled, 0, "and it drew nothing from the bucket");

        // The mechanism is sound — the reservation retires normally through
        // the release primitive, so the zeros above are about reachability,
        // not a broken counter.
        vm.chainId(ARB);
        _mut(ARB).releaseRecycleCommitmentRaw(_localOutstanding(ARB));
        (uint256 retiredAfter,) =
            RewardAggregatorFacet(arbD).getLocalRecycledCommitRetirement();
        assertGt(retiredAfter, 0, "the release primitive retires it fine");
    }

    /**
     * @notice Per-chain isolation across real diamonds: OP's activity moves
     *         OP's ledger on Base and leaves ARB's alone. A mesh that
     *         cross-attributed absorption would over-fund one chain from
     *         another's bucket.
     */
    function test_E2E_ChainLedgersAreIsolated() public {
        _seedRecycled(ARB, 8);
        _seedRecycled(OP, 8);
        _seedAllInterest(4);
        _warpPast(6);

        _allChainsCloseDay(4);
        _deliverPendingReports();

        (uint256 arbReported,,,) = _agg().getChainRecycledLedger(uint32(ARB));
        (uint256 opReported,,,) = _agg().getChainRecycledLedger(uint32(OP));
        assertEq(arbReported, BUCKET_SEED, "ARB reported its own bucket");
        assertEq(opReported, BUCKET_SEED, "OP reported its own bucket");

        // OP absorbs more; ARB does not.
        _mut(OP).setRecycleBucketRaw(BUCKET_SEED + 40_000 ether);
        _seedAllInterest(5);
        _allChainsCloseDay(5);
        _deliverPendingReports();

        (uint256 arbAfter,,,) = _agg().getChainRecycledLedger(uint32(ARB));
        (uint256 opAfter,,,) = _agg().getChainRecycledLedger(uint32(OP));
        assertEq(arbAfter, BUCKET_SEED, "ARB's ledger did not move");
        assertEq(
            opAfter, BUCKET_SEED + 40_000 ether, "OP's ledger moved alone"
        );
    }

    /**
     * @notice The mirrors really do send the CURRENT eight-word report shape
     *         — the generation the retirement signal rides on.
     * @dev    Guards the suite against a silent downgrade: if a mirror fell
     *         back to the six-word B1 shape, every retirement assertion above
     *         would read zeros and pass for the wrong reason.
     */
    function test_E2E_MirrorsSendTheCurrentReportGeneration() public {
        _seedRecycled(ARB, 8);
        _seedRecycled(OP, 8);
        _warpPast(6);
        _allChainsCloseDay(4);

        assertEq(bus.reportCount(), 2, "both mirrors queued a report");
        assertEq(bus.reportAt(0).arity, 8, "ARB sent the eight-word shape");
        assertEq(bus.reportAt(1).arity, 8, "OP sent the eight-word shape");
        assertEq(bus.reportAt(0).srcChainId, ARB, "source identified by sender");
        assertEq(bus.reportAt(1).srcChainId, OP, "source identified by sender");
    }

    /**
     * @notice B3's two settlement kinds are NOT the same thing, end to end: a
     *         commitment retired by PAYING (`consume` — the tokens left the
     *         bucket) retires the reservation but restores NO availability,
     *         whereas a release does both.
     *
     * @dev    Until now the only nonzero retirement carried across the wire
     *         had `retired == released`, so a regression reporting every
     *         consumed claim as ALSO released would have passed the whole
     *         suite — and Base would hand already-spent tokens back to
     *         availability and be free to commit them a second time (Codex
     *         #1439 r4). That is the single most consequential way B3's
     *         signal can be wrong, and it now has a test.
     *
     *         Day 6 is REPORTED but deliberately NOT finalized: an armed
     *         finalize would immediately re-instruct against the same chain
     *         and move `consumed`, so the availability assertion below could
     *         not attribute what it was measuring.
     */
    function test_E2E_ConsumedCommitmentRetiresWithoutRestoringAvailability()
        public
    {
        _seedRecycled(ARB, 10);
        _seedRecycled(OP, 10);
        _seedAllInterest(5);
        _arm(5);
        _warpPast(7);
        _runDayCycle(5);
        _assertMirrorsArmedFrom(5);

        uint256 instructed = _instructedFor(ARB);
        assertGt(instructed, 1 ether, "ARB carries a real instruction");
        (,, uint256 availBefore,) = _agg().getChainRecycledLedger(uint32(ARB));

        // ARB PAYS out of the reservation — tokens physically leave its
        // bucket. This is `consume`, not `releaseCommitment`.
        uint256 spend = instructed / 2;
        assertGt(spend, 0, "the spend is non-zero");
        uint256 bucketBefore = _mut(ARB).getRecycleBucketRaw();
        vm.chainId(ARB);
        _mut(ARB).consumeRecycleRaw(spend);
        assertEq(
            _mut(ARB).getRecycleBucketRaw(),
            bucketBefore - spend,
            "the tokens really left ARB's bucket"
        );

        // The mirror's own counters: retired moved, released did NOT.
        (uint256 localRetired, uint256 localReleased) =
            RewardAggregatorFacet(arbD).getLocalRecycledCommitRetirement();
        assertEq(localRetired, spend, "mirror retired the consumed amount");
        assertEq(localReleased, 0, "a CONSUME is not a release");
        // Same reasoning as the release path: a `consume` that debited the
        // bucket and advanced the retired cumulative but left
        // `outstandingCommitRecycled` stale would subtract the spend TWICE
        // from the mirror's fundable balance while Base counted it once.
        assertEq(
            _localOutstanding(ARB),
            instructed - spend,
            "the mirror's own reservation fell by the spend"
        );

        // Report day 6 without finalizing it (see the note above).
        _seedAllInterest(6);
        _allChainsCloseDay(6);
        _deliverPendingReports();

        (uint256 baseRetired, uint256 baseReleased) =
            _agg().getChainRecycledCommitRetirement(uint32(ARB));
        assertEq(baseRetired, spend, "Base accepted the retirement");
        assertEq(baseReleased, 0, "Base did NOT record a release");

        // The reservation closed by exactly the spend...
        assertEq(
            _agg().getChainOutstandingRecycledCommit(uint32(ARB)),
            instructed - spend,
            "reservation closed by the consumed amount"
        );
        // ...and availability did NOT grow, because those tokens are gone.
        (,, uint256 availAfter,) = _agg().getChainRecycledLedger(uint32(ARB));
        assertEq(
            availAfter,
            availBefore,
            "a CONSUMED commitment restores no availability"
        );
    }

    /**
     * @notice Ordering hazard: a STALE report delivered after a newer one
     *         must not walk the availability ratchet backwards.
     *
     * @dev    The queue exists to let this suite reorder, duplicate and drop
     *         messages, but every sweep until now iterated in insertion order
     *         and the drop test suppressed the older report entirely — so a
     *         lower cumulative arriving late was never actually delivered
     *         (Codex #1439 r4). CCIP gives no cross-message ordering
     *         guarantee, so this is an ordinary lane behaviour, not an edge
     *         case.
     */
    function test_E2E_StaleReportDeliveredAfterANewerOneCannotRegress() public {
        _seedRecycled(ARB, 10);
        _seedRecycled(OP, 10);
        _warpPast(7);

        _seedAllInterest(4);
        _allChainsCloseDay(4);

        // ARB absorbs more, then closes a LATER day.
        _mut(ARB).setRecycleBucketRaw(BUCKET_SEED + 30_000 ether);
        _seedAllInterest(5);
        _allChainsCloseDay(5);

        // Deliver day 5 FIRST, then the stale day-4 packet.
        uint256 idx5 = _findReport(5, ARB);
        uint256 idx4 = _findReport(4, ARB);
        vm.chainId(BASE);
        bus.deliverReport(idx5);
        (uint256 afterNewer,,,) = _agg().getChainRecycledLedger(uint32(ARB));
        assertEq(
            afterNewer, BUCKET_SEED + 30_000 ether, "newer cumulative accepted"
        );

        bus.deliverReport(idx4);
        (uint256 afterStale,,,) = _agg().getChainRecycledLedger(uint32(ARB));
        assertEq(
            afterStale,
            BUCKET_SEED + 30_000 ether,
            "the stale lower cumulative did NOT walk the ratchet back"
        );

        // Both days still attribute their own credit — accepting them out of
        // order must not lose the older day's per-day figure.
        (uint256 c4, bool a4) = _agg().getChainDailyRecycledCredit(4, uint32(ARB));
        (uint256 c5, bool a5) = _agg().getChainDailyRecycledCredit(5, uint32(ARB));
        assertTrue(a4 && a5, "both days accepted");
        assertEq(c4, ABSORB_ARB, "day 4 credit attributed");
        assertEq(c5, ABSORB_ARB, "day 5 credit attributed");
    }

    // ─── Assertion helpers ─────────────────────────────────────────────────

    /// @dev The mirror's OWN stored funding stamp equals the packet Base sent.
    function _assertStampMatchesPacket(
        uint256 chainId,
        uint256 dayId,
        RewardBroadcastV2 memory b
    ) private view {
        LibVaipakam.ChainDayFunding memory f = RewardAggregatorFacet(
            diamondOf[chainId]
        ).getChainDayRecycledFunding(dayId, uint32(chainId));
        assertTrue(f.stamped, "mirror stamped the day");
        assertEq(f.freshLenderHalf, b.freshLenderHalf, "stamp freshLenderHalf");
        assertEq(
            f.freshBorrowerHalf, b.freshBorrowerHalf, "stamp freshBorrowerHalf"
        );
        assertEq(
            f.lenderHalfEquiv, b.recycledLenderHalfEquiv, "stamp lenderHalfEquiv"
        );
        assertEq(
            f.borrowerHalfEquiv,
            b.recycledBorrowerHalfEquiv,
            "stamp borrowerHalfEquiv"
        );
        assertEq(f.recycleConsume, b.recycleConsume, "stamp recycleConsume");
    }

    function _assertMirrorKnowsGlobals(
        uint256 chainId,
        uint256 dayId,
        uint256 gL,
        uint256 gB
    ) private view {
        (uint256 l, uint256 b,) = RewardReporterFacet(diamondOf[chainId])
            .getKnownGlobalInterestNumeraire18(dayId);
        assertEq(l, gL, "mirror holds the finalized lender denominator");
        assertEq(b, gB, "mirror holds the finalized borrower denominator");
    }

    function _assertMirrorCaps(
        uint256 chainId,
        uint256 dayId,
        uint256 capL,
        uint256 capB
    ) private view {
        (uint256 l, uint256 b) = RewardAggregatorFacet(diamondOf[chainId])
            .getDayUserSideCaps(dayId);
        assertEq(l, capL, "mirror stored the lender ceiling");
        assertEq(b, capB, "mirror stored the borrower ceiling");
    }

    // ─── Read helpers ──────────────────────────────────────────────────────

    /// @dev A mirror's OWN outstanding recycled commitment — read from that
    ///      diamond's storage, not from Base's model of it.
    function _localOutstanding(uint256 chainId) private view returns (uint256) {
        (,, uint256 outstandingRecycled,) =
            RewardAggregatorFacet(diamondOf[chainId]).getGovernorCommitState();
        return outstandingRecycled;
    }

    function _instructedFor(uint256 chainId) private view returns (uint256) {
        (, uint256 instructed,,) =
            _agg().getChainRecycledLedger(uint32(chainId));
        return instructed;
    }

    function _findReport(uint256 dayId, uint256 srcChainId)
        private
        view
        returns (uint256)
    {
        uint256 n = bus.reportCount();
        for (uint256 i; i < n; ++i) {
            MeshBusMessenger.QueuedReport memory r = bus.reportAt(i);
            if (r.dayId == dayId && r.srcChainId == srcChainId) return i;
        }
        revert("no such queued report");
    }

    /// @dev Drop queued report `skip` PERMANENTLY, then deliver the rest.
    function _dropReportAndDeliverRest(uint256 skip) private {
        droppedReport[skip] = true;
        _deliverPendingReports();
    }
}
