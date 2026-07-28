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

import {HelperTest} from "./HelperTest.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MeshBusMessenger} from "./mocks/MeshBusMessenger.sol";

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
    uint256 internal constant ABSORB_PER_DAY = 700 ether;

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
        _mut(chainId).setRecycleBucketRaw(BUCKET_SEED);
        for (uint256 d = 1; d <= throughDay; ++d) {
            _mut(chainId).setRecycledCreditedByDayRaw(d, ABSORB_PER_DAY);
        }
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

    /// @dev Deliver every queued-but-undelivered report to Base.
    function _deliverPendingReports() private {
        vm.chainId(BASE);
        uint256 n = bus.reportCount();
        for (uint256 i; i < n; ++i) {
            if (bus.reportDeliveries(i) == 0) bus.deliverReport(i);
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
        uint256 total
    ) private {
        _mut(chainId).setDailyLenderInterest(dayId, who, total, total);
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
        _seedInterest(ARB, dayId, alice, 2e18);
        _seedInterest(OP, dayId, alice, 1e18);
        _seedInterest(BASE, dayId, alice, 1e18);
    }

    /// @dev The same cycle on an UNARMED day — no mesh funding resolution
    ///      runs, so nothing is instructed and nothing is reserved, but the
    ///      day's consensus globals still reach every mirror.
    function _runUnarmedDay(uint256 dayId) private {
        _runArmedDay(dayId);
    }

    /// @dev One complete armed cycle for `dayId`: report → finalize →
    ///      broadcast → deliver to both mirrors.
    function _runArmedDay(uint256 dayId) private {
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

        _runArmedDay(5);

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

        _runArmedDay(5);

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
        _deliverAllReportsExcept(arbDay4);

        (uint256 reportedAfterDrop,,,) =
            _agg().getChainRecycledLedger(uint32(ARB));
        assertEq(reportedAfterDrop, 0, "ARB's day-4 report never landed");

        // ARB absorbs more, then day 5 closes and DOES land.
        _mut(ARB).setRecycleBucketRaw(BUCKET_SEED + 25_000 ether);
        _seedAllInterest(5);
        _allChainsCloseDay(5);
        _deliverPendingReports();

        (uint256 reportedAfterHeal,,,) =
            _agg().getChainRecycledLedger(uint32(ARB));
        assertEq(
            reportedAfterHeal,
            BUCKET_SEED + 25_000 ether,
            "one later report restored the FULL cumulative, backlog included"
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

        _runArmedDay(5);

        uint256 instructed = _instructedFor(ARB);
        assertGt(instructed, 0, "ARB carries a real instruction to release");
        (,, uint256 availBefore,) = _agg().getChainRecycledLedger(uint32(ARB));

        // ARB releases HALF of what it reserved. Half, not all: a release is
        // clamped to the outstanding reservation, so releasing MORE than the
        // instruction would restore only the instruction and the test could
        // not tell a correct partial credit from a saturated one.
        uint256 release = instructed / 2;
        vm.chainId(ARB);
        _mut(ARB).releaseRecycleCommitmentRaw(release);

        // The mirror's own counters moved — and by the ACTUAL decrement.
        (uint256 localRetired, uint256 localReleased) =
            RewardAggregatorFacet(arbD).getLocalRecycledCommitRetirement();
        assertEq(localRetired, release, "mirror retired the released amount");
        assertEq(localReleased, release, "a release counts on both counters");

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
     *         while mirror armed-day pricing stays HALTED, a mirror can
     *         RESERVE a commitment from Base's broadcast but has no user-
     *         reachable path to RETIRE it — so Base's per-chain reservation
     *         for that mirror is monotone.
     *
     * @dev    The halt itself is pinned by
     *         `test_D4_MirrorArmedDayPricingStaysHalted`. What is pinned HERE
     *         is its mesh consequence, and the consequence is what carries
     *         the operational rule: arming (`setGovernorCommitArmedFromDay`,
     *         the one-shot irreversible D* cutover) is the single switch that
     *         starts creating mirror reservations, so D* MUST NOT be set
     *         before #1434 lifts the halt — otherwise every armed day
     *         permanently shrinks what Base believes each mirror can
     *         self-fund, which is precisely the pre-B3 defect B3 removed from
     *         Base's own books.
     *
     *         **Anti-vacuity.** A claim that retires nothing proves nothing
     *         if the claim never really ran. So the mirror is first taken
     *         through an UNARMED day whose claim genuinely pays out: the
     *         single claim call pays for the unarmed day and stops at the
     *         armed one. A non-zero payout is what makes the zero retirement
     *         attributable to the halt rather than to a claim path that was
     *         unreachable in this harness all along.
     *
     *         The last assertion guards the opposite misreading — that the
     *         counters are simply broken: the same reservation retires
     *         normally through the release primitive.
     */
    function test_E2E_MirrorArmedDayReservationHasNoUserReachableRetirement()
        public
    {
        _seedRecycled(ARB, 10);
        _seedRecycled(OP, 10);
        _warpPast(7);

        // Alice has already claimed through day 3, so her walk starts at day
        // 4 — the two days this test actually drives. Without this the claim
        // begins at day 1 and stops on the first day whose global never
        // reached this mirror (`InteractionDayGlobalNotFinalized`), which
        // would have nothing to do with arming.
        _mut(ARB).setInteractionLastClaimedDay(alice, 3);

        // Day 4, UNARMED — gives alice a genuinely payable entry on ARB and
        // lands the day's consensus globals through the real broadcast.
        _seedAllInterest(4);
        _runUnarmedDay(4);

        // Day 5, ARMED — ARB is instructed to self-fund and reserves it.
        _seedAllInterest(5);
        _arm(5);
        _runArmedDay(5);

        uint256 reserved = _localOutstanding(ARB);
        assertGt(reserved, 0, "the mirror really is carrying a reservation");

        // Fund the mirror so a claim cannot fail merely for want of VPFI —
        // the point is that the armed day prices to nothing, not that the
        // payout is unfunded.
        vpfiOf[ARB].mint(arbD, 100_000 ether);

        vm.chainId(ARB);
        vm.prank(alice);
        (uint256 paid,,) = RewardClaimFacet(arbD).claimInteractionRewards();
        assertGt(paid, 0, "claim path is live here: the unarmed day paid");

        (uint256 retired, uint256 released) =
            RewardAggregatorFacet(arbD).getLocalRecycledCommitRetirement();
        assertEq(retired, 0, "no user path retired the reservation");
        assertEq(released, 0, "no user path released the reservation");
        assertEq(
            _localOutstanding(ARB),
            reserved,
            "the reservation is exactly where it was"
        );

        // The mechanism is sound — only the armed-day user path is halted.
        vm.chainId(ARB);
        _mut(ARB).releaseRecycleCommitmentRaw(reserved);
        (uint256 retiredAfter,) =
            RewardAggregatorFacet(arbD).getLocalRecycledCommitRetirement();
        assertEq(
            retiredAfter, reserved, "the release primitive retires it fine"
        );
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

    function _deliverAllReportsExcept(uint256 skip) private {
        vm.chainId(BASE);
        uint256 n = bus.reportCount();
        for (uint256 i; i < n; ++i) {
            if (i != skip && bus.reportDeliveries(i) == 0) bus.deliverReport(i);
        }
    }
}
