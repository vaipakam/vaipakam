// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";

import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {RewardCommitmentFacet} from "../src/facets/RewardCommitmentFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {
    IRewardMessenger,
    RewardBroadcastV2,
    RewardBroadcastV3
} from "../src/interfaces/IRewardMessenger.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";

/// @title RewardBroadcastV3Test
/// @notice #1434 P2-w1 — facet-level coverage for the kind-10 V3 broadcast:
///         the finalization-time day-clock freeze, the versioned lapse
///         schedule (R5), the three-step send/quote ladder, the
///         permissionless single-destination heal, and the mirror-side V3
///         ingress (install / clock backfill / divergence extension / era
///         binding).
///
///         The four design-§8 slice-1 proofs live here (plus one at the
///         wire layer in VaipakamRewardFlowTest):
///           1. Re-broadcast determinism of the frozen fields
///              ({testReBroadcastCarriesIdenticalFrozenFacts}).
///           2. Clock backfill on an already-applied day
///              ({testClockBackfillOnKind5AppliedDay}).
///           3. An old in-flight kind-5 still applies
///              ({testKind5StillAppliesWithoutClock} facet-level;
///              wire-level in VaipakamRewardFlowTest).
///           4. Divergence-check extension to the frozen fields
///              ({testV3ReplayDivergenceOnEachFrozenField}).
///
///         SPLIT into two suite contracts over one shared harness on
///         purpose: a single contract holding the full test set exceeded
///         solc 0.8.29's per-assembly jump-tag space under viaIR
///         ("Tag too large for reserved space" ICE) — the same
///         unit-size ceiling family as #601/#603, at the assembly stage.
abstract contract RewardBroadcastV3Harness is SetupTest, IVaipakamErrors {
    MockRewardMessenger internal messenger;

    address internal alice;

    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    uint32 internal constant CHAIN_OP = 10;
    uint32 internal constant CHAIN_UNKNOWN = 137;

    function setUp() public {
        setupHelper();
        messenger = new MockRewardMessenger(address(diamond));
        alice = makeAddr("alice");
    }

    // ─── Harness (the CrossChainRewardPlumbingTest shapes) ──────────────────

    function _rep() internal view returns (RewardReporterFacet) {
        return RewardReporterFacet(address(diamond));
    }

    function _agg() internal view returns (RewardAggregatorFacet) {
        return RewardAggregatorFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    /// @dev The lapse-schedule setter + day-clock reads live on
    ///      RewardCommitmentFacet (EIP-170 headroom — see the facet
    ///      natspec).
    function _com() internal view returns (RewardCommitmentFacet) {
        return RewardCommitmentFacet(address(diamond));
    }

    function _configureCanonical() internal {
        vm.chainId(CHAIN_BASE);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(true);
        _rep().setRewardMessenger(address(messenger));
        uint32[] memory chainIds = new uint32[](3);
        chainIds[0] = CHAIN_BASE;
        chainIds[1] = CHAIN_ARB;
        chainIds[2] = CHAIN_OP;
        _agg().setExpectedSourceChainIds(chainIds);
        uint256[] memory dests = new uint256[](2);
        dests[0] = CHAIN_ARB;
        dests[1] = CHAIN_OP;
        messenger.setBroadcastDestinations(dests);
    }

    /// @dev Mirror config WITHOUT the era ground truth — the pre-arming
    ///      state a live mirror sits in between the facet upgrade and the
    ///      arming step (V3 ingress dark; kind-5/kind-2 still apply,
    ///      without provenance).
    function _configureMirrorUnarmed(uint32 localChainId) internal {
        vm.chainId(localChainId);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(false);
        _rep().setRewardMessenger(address(messenger));
    }

    function _configureMirror(uint32 localChainId) internal {
        _configureMirrorUnarmed(localChainId);
        // #1632 r1 — arm the era ground truth: without it the V3 ingress
        // is deliberately dark (fail-closed).
        _rep().setBaseRewardDeployment(ERA_BASE);
    }

    /// @dev Full-coverage day-1 reports + finalize on the canonical config.
    function _reportAndFinalizeDay1() internal {
        messenger.deliverChainReport(CHAIN_BASE, 1, 7e18, 3e18);
        messenger.deliverChainReport(CHAIN_ARB, 1, 5e18, 2e18);
        messenger.deliverChainReport(CHAIN_OP, 1, 3e18, 1e18);
        _agg().finalizeDay(1);
    }

    /// @dev The plumbing suite's V2 packet, verbatim (day 3, dest-bound).
    function _v2Packet(uint256 destChainId)
        internal
        pure
        returns (RewardBroadcastV2 memory b)
    {
        b = RewardBroadcastV2({
            dayId: 3,
            globalLenderNumeraire18: 30e18,
            globalBorrowerNumeraire18: 15e18,
            capMode: uint8(LibVaipakam.CapMode.ShareOfPool),
            capPayloadLender: 11e18,
            capPayloadBorrower: 7e18,
            armedFromDay: 2,
            freshLenderHalf: 20e18,
            freshBorrowerHalf: 20e18,
            recycledLenderHalfEquiv: 9e18,
            recycledBorrowerHalfEquiv: 4e18,
            recycleConsume: 5e18,
            keeperAllocate: 0,
            destChainId: destChainId
        });
    }

    address internal constant ERA_BASE = address(0xBA5EDEED);

    /// @dev The V2 packet wrapped in clock facts — the kind-10 form.
    function _v3Packet(uint256 destChainId)
        internal
        pure
        returns (RewardBroadcastV3 memory b)
    {
        b = RewardBroadcastV3({
            v2: _v2Packet(destChainId),
            finalizedAt: 1_700_000_000,
            lapseScheduleVersion: 1,
            lapseWindowSeconds: 7 days,
            dispatchCutoffGap: 24 hours,
            zeroedForDest: false,
            baseDeployment: ERA_BASE,
            // #1636 r2 — the day-level funded pool halves (the Δq
            // numerator transport; the raw-stamp convention's 40e18/20e18
            // shape halved).
            dayScheduleFloorHalf: 20e18,
            dayRecycledBudgetHalf: 10e18
        });
    }

}

/// @notice Base-side coverage: the R5 schedule, the finalization freeze,
///         proof 1 (re-broadcast determinism), the send/quote ladder and
///         the permissionless heal.
contract RewardBroadcastV3BaseTest is RewardBroadcastV3Harness {
    // ════════════════════════════════════════════════════════════════════════
    // R5 — the versioned lapse schedule (bounds, append-only versions)
    // ════════════════════════════════════════════════════════════════════════

    function testSetLapseScheduleStoresNewVersion() public {
        _configureCanonical();
        assertEq(_com().getCurrentLapseScheduleVersion(), 0, "starts unset");

        vm.expectEmit(true, false, false, true);
        emit RewardCommitmentFacet.LapseScheduleVersionSet(
            1, 7 days, 24 hours
        );
        _com().setLapseSchedule(7 days, 24 hours);

        assertEq(_com().getCurrentLapseScheduleVersion(), 1);
        (uint64 w, uint64 g) = _com().getLapseSchedule(1);
        assertEq(w, 7 days);
        assertEq(g, 24 hours);
    }

    function testSetLapseScheduleVersionsAreAppendOnly() public {
        _configureCanonical();
        _com().setLapseSchedule(7 days, 24 hours);
        _com().setLapseSchedule(10 days, 48 hours);

        assertEq(_com().getCurrentLapseScheduleVersion(), 2);
        // Version 1 stays readable forever — a finalized day prices its
        // clocks under its frozen version, so old versions never vanish.
        (uint64 w1, uint64 g1) = _com().getLapseSchedule(1);
        assertEq(w1, 7 days, "old version untouched");
        assertEq(g1, 24 hours);
        (uint64 w2, uint64 g2) = _com().getLapseSchedule(2);
        assertEq(w2, 10 days);
        assertEq(g2, 48 hours);
    }

    function testSetLapseScheduleWindowBounds() public {
        _configureCanonical();
        vm.expectRevert(
            abi.encodeWithSelector(
                LapseWindowOutOfBounds.selector, uint64(3 days - 1)
            )
        );
        _com().setLapseSchedule(3 days - 1, 24 hours);

        vm.expectRevert(
            abi.encodeWithSelector(
                LapseWindowOutOfBounds.selector, uint64(30 days + 1)
            )
        );
        _com().setLapseSchedule(30 days + 1, 24 hours);
    }

    function testSetLapseScheduleGapBounds() public {
        _configureCanonical();
        vm.expectRevert(
            abi.encodeWithSelector(
                DispatchCutoffGapOutOfBounds.selector, uint64(6 hours - 1)
            )
        );
        _com().setLapseSchedule(7 days, 6 hours - 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                DispatchCutoffGapOutOfBounds.selector, uint64(7 days + 1)
            )
        );
        _com().setLapseSchedule(30 days, 7 days + 1);
    }

    /// The relational bound: `window >= gap + 48h`. Both values are inside
    /// their independent ranges here — only the relation fails, which is
    /// exactly the "cutoff before finalization" trap the bound exists for.
    function testSetLapseScheduleRelationalBound() public {
        _configureCanonical();
        vm.expectRevert(
            abi.encodeWithSelector(
                LapseScheduleMarginViolated.selector,
                uint64(3 days),
                uint64(2 days)
            )
        );
        _com().setLapseSchedule(3 days, 2 days);

        // Exactly at the margin is accepted.
        _com().setLapseSchedule(4 days, 2 days);
        assertEq(_com().getCurrentLapseScheduleVersion(), 1);
    }

    function testSetLapseScheduleRequiresAdmin() public {
        _configureCanonical();
        vm.prank(alice);
        vm.expectRevert();
        _com().setLapseSchedule(7 days, 24 hours);
    }

    function testSetLapseScheduleRequiresCanonical() public {
        _configureMirror(CHAIN_ARB);
        vm.expectRevert(NotCanonicalRewardChain.selector);
        _com().setLapseSchedule(7 days, 24 hours);
    }

    // ════════════════════════════════════════════════════════════════════════
    // The finalization-time freeze
    // ════════════════════════════════════════════════════════════════════════

    function testFinalizeFreezesDayLapseClock() public {
        _configureCanonical();
        _com().setLapseSchedule(7 days, 24 hours);
        uint256 t0 = block.timestamp;
        _reportAndFinalizeDay1();

        (uint64 at, uint32 ver, uint64 w, uint64 g) = _com().getDayLapseClock(1);
        assertEq(at, uint64(t0), "authentic finalization timestamp");
        assertEq(ver, 1, "current schedule version frozen");
        assertEq(w, 7 days, "inline window frozen");
        assertEq(g, 24 hours, "inline gap frozen");
    }

    function testForceFinalizeFreezesClockToo() public {
        _configureCanonical();
        _com().setLapseSchedule(7 days, 24 hours);
        _agg().forceFinalizeDay(1);
        (uint64 at, uint32 ver, , ) = _com().getDayLapseClock(1);
        assertEq(at, uint64(block.timestamp));
        assertEq(ver, 1);
    }

    /// A day finalized before any schedule exists freezes version 0 with
    /// zero parameters — an authentic clock, but NOT lapse-eligible (the
    /// w4 terminals gate on a nonzero frozen version).
    function testFinalizeWithoutScheduleFreezesVersionZero() public {
        _configureCanonical();
        _reportAndFinalizeDay1();
        (uint64 at, uint32 ver, uint64 w, uint64 g) = _com().getDayLapseClock(1);
        assertEq(at, uint64(block.timestamp), "clock still authentic");
        assertEq(ver, 0, "version 0 = no schedule");
        assertEq(w, 0);
        assertEq(g, 0);
    }

    /// @dev Arm the governor for the current day + 1 and finalize that day
    ///      with CHAIN_OP missing — the R1 zeroed-destination shape.
    function _armAndFinalizeWithOpZeroed() internal returns (uint256 dayId) {
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(
            block.timestamp
        );
        (uint256 today, ) = InteractionRewardsLensFacet(address(diamond))
            .getInteractionCurrentDay();
        dayId = today + 1;
        _agg().setGovernorCommitArmedFromDay(dayId);

        // Let the armed day elapse, then report it short of CHAIN_OP.
        vm.warp(block.timestamp + 2 days + 1);
        messenger.deliverChainReport(CHAIN_BASE, dayId, 7e18, 3e18);
        messenger.deliverChainReport(CHAIN_ARB, dayId, 5e18, 2e18);
        // CHAIN_OP never reports; grace elapses.
        vm.warp(block.timestamp + 4 hours + 1);
        _agg().finalizeDay(dayId);
    }

    function testFinalizeFreezesZeroedForDest() public {
        _configureCanonical();
        _com().setLapseSchedule(7 days, 24 hours);
        uint256 dayId = _armAndFinalizeWithOpZeroed();

        assertTrue(
            _com().getDayZeroedForDest(dayId, CHAIN_OP),
            "missing chain frozen zeroed"
        );
        assertFalse(
            _com().getDayZeroedForDest(dayId, CHAIN_ARB),
            "reported chain not zeroed"
        );
        assertFalse(
            _com().getDayZeroedForDest(dayId, CHAIN_BASE),
            "canonical self exempt"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // PROOF 1 — re-broadcast determinism of the frozen fields
    // ════════════════════════════════════════════════════════════════════════

    /// Everything that previously leaked live state into a re-broadcast is
    /// mutated between two sends of the same day — the operator clears the
    /// zeroed chain's remit-ineligible flag, bumps the lapse schedule, and
    /// time passes — and the second send still carries the identical frozen
    /// clock facts. This is R2a: the wire reads only what finalization
    /// froze.
    function testReBroadcastCarriesIdenticalFrozenFacts() public {
        _configureCanonical();
        _com().setLapseSchedule(7 days, 24 hours);
        uint256 dayId = _armAndFinalizeWithOpZeroed();
        // Read the finalization instant back through the view rather than
        // `block.timestamp`: viaIR may legally cache an environment read
        // across `vm.warp` within one test frame (the warp-CSE gotcha), so
        // a direct timestamp read here is not reliable in a multi-warp
        // test. The clock == wall-clock property is covered warp-free in
        // {testFinalizeFreezesDayLapseClock}.
        (uint64 frozenAt, , , ) = _com().getDayLapseClock(dayId);

        _agg().broadcastGlobal(dayId);
        assertEq(messenger.broadcastV3Count(), 1);
        (uint64 at1, uint32 v1, uint64 w1, uint64 g1, , ) =
            messenger.lastV3Extras();
        bool zeroedOp1 = _zeroedFlagFor(CHAIN_OP);

        // Mutate every live source the frozen fields could have leaked
        // from.
        RewardCommitmentFacet(address(diamond))
            .reconcileCommitmentRemitEligibility(dayId, CHAIN_OP);
        _com().setLapseSchedule(10 days, 48 hours);
        vm.warp(block.timestamp + 30 days);

        _agg().broadcastGlobal(dayId);
        assertEq(messenger.broadcastV3Count(), 2);
        (uint64 at2, uint32 v2, uint64 w2, uint64 g2, , ) =
            messenger.lastV3Extras();

        assertEq(at2, at1, "finalizedAt identical across sends");
        assertEq(at1, frozenAt, "and it is the finalization timestamp");
        assertEq(v2, v1, "schedule version pinned to v1");
        assertEq(v1, 1);
        assertEq(w2, w1, "window frozen despite the v2 bump");
        assertEq(w1, 7 days);
        assertEq(g2, g1, "gap frozen despite the v2 bump");
        assertTrue(zeroedOp1, "first send carried the zeroed marker");
        assertTrue(
            _zeroedFlagFor(CHAIN_OP),
            "second send still carries it after reconciliation cleared the "
            "live flag"
        );
    }

    /// @dev The last-broadcast per-dest zeroed flag for `chainId`.
    function _zeroedFlagFor(uint32 chainId) internal view returns (bool) {
        uint256 n = messenger.lastV3DestsLength();
        for (uint256 i; i < n; ++i) {
            IRewardMessenger.BroadcastV3PerDest memory d =
                messenger.lastV3DestAt(i);
            if (d.base.destChainId == chainId) return d.zeroedForDest;
        }
        revert("dest not found in last V3 broadcast");
    }

    // ════════════════════════════════════════════════════════════════════════
    // The three-step send/quote ladder
    // ════════════════════════════════════════════════════════════════════════

    function testBroadcastUsesV3WhenClockPresent() public {
        _configureCanonical();
        _com().setLapseSchedule(7 days, 24 hours);
        _reportAndFinalizeDay1();

        _agg().broadcastGlobal(1);

        assertEq(messenger.broadcastV3Count(), 1, "V3 wire used");
        assertEq(messenger.broadcastV2Count(), 0);
        assertEq(messenger.broadcastCount(), 0);
        (uint64 at, uint32 ver, uint64 w, uint64 g, , ) =
            messenger.lastV3Extras();
        (uint64 cAt, uint32 cVer, uint64 cW, uint64 cG) =
            _com().getDayLapseClock(1);
        assertEq(at, cAt, "extras read back from the frozen clock");
        assertEq(ver, cVer);
        assertEq(w, cW);
        assertEq(g, cG);
    }

    function testBroadcastFallsBackToV2OnPreV3Messenger() public {
        _configureCanonical();
        messenger.setV3Unsupported(true);
        _com().setLapseSchedule(7 days, 24 hours);
        _reportAndFinalizeDay1();

        _agg().broadcastGlobal(1);

        assertEq(messenger.broadcastV3Count(), 0);
        assertEq(messenger.broadcastV2Count(), 1, "V2 fallback used");
        assertEq(messenger.broadcastCount(), 0, "legacy untouched");
    }

    /// A day finalized BEFORE the upgrade has no frozen clock; it must ride
    /// the V2 wire permanently even on a V3-capable messenger (a zero-clock
    /// V3 would fail closed at the mirror as a permanently failed CCIP
    /// message).
    function testBroadcastFallsBackToV2WhenDayHasNoClock() public {
        _configureCanonical();
        _com().setLapseSchedule(7 days, 24 hours);
        _reportAndFinalizeDay1();
        _mut().clearDayLapseClockRaw(1);

        _agg().broadcastGlobal(1);

        assertEq(messenger.broadcastV3Count(), 0, "no zero-clock V3 sent");
        assertEq(messenger.broadcastV2Count(), 1, "clockless day rides V2");
    }

    function testQuoteFollowsClocklessDayToV2() public {
        _configureCanonical();
        messenger.setQuoteNative(0.05 ether);
        _com().setLapseSchedule(7 days, 24 hours);
        _reportAndFinalizeDay1();

        // Clock present + V3-capable: V3 pricing (lane × 3 marker).
        assertEq(_agg().quoteBroadcastGlobal(1), 0.3 ether, "V3 quote");

        // Clockless: the quote prices the V2 wire the send would use.
        _mut().clearDayLapseClockRaw(1);
        assertEq(_agg().quoteBroadcastGlobal(1), 0.1 ether, "V2 quote");
    }

    // ════════════════════════════════════════════════════════════════════════
    // broadcastGlobalTo — the permissionless single-destination heal
    // ════════════════════════════════════════════════════════════════════════

    function testHealSendsSingleV3ToOffListDestWithStanding() public {
        _configureCanonical();
        _com().setLapseSchedule(7 days, 24 hours);
        _reportAndFinalizeDay1();

        // Remove ARB from the CURRENT destination list — the heal's whole
        // reason to exist.
        uint256[] memory only = new uint256[](1);
        only[0] = CHAIN_OP;
        messenger.setBroadcastDestinations(only);

        vm.prank(alice); // permissionless
        _agg().broadcastGlobalTo(1, CHAIN_ARB);

        assertEq(messenger.broadcastV3SingleCount(), 1, "single V3 sent");
        (
            IRewardMessenger.BroadcastV2PerDest memory base,
            bool zeroed
        ) = messenger.lastV3SingleDest();
        assertEq(base.destChainId, CHAIN_ARB, "targeted destination");
        assertFalse(zeroed, "reported chain not zeroed");
        (uint64 at, , uint64 w, , , ) = messenger.lastV3SingleExtras();
        (uint64 cAt, , uint64 cW, ) = _com().getDayLapseClock(1);
        assertEq(at, cAt, "frozen clock rides the heal");
        assertEq(w, cW);
    }

    /// Standing via the remit-ineligible record alone: the zeroed chain was
    /// NOT included in the denominator, yet it holds a chain-day
    /// commitments record — precisely the destination the clock backfill
    /// exists for.
    function testHealAdmitsZeroedDest() public {
        _configureCanonical();
        _com().setLapseSchedule(7 days, 24 hours);
        uint256 dayId = _armAndFinalizeWithOpZeroed();

        vm.prank(alice);
        _agg().broadcastGlobalTo(dayId, CHAIN_OP);

        assertEq(messenger.broadcastV3SingleCount(), 1);
        (, bool zeroed) = messenger.lastV3SingleDest();
        assertTrue(zeroed, "frozen zeroed marker rides the heal");
    }

    /// Codex #1632 r3 P1 — standing must survive RECONCILIATION: the live
    /// remit-ineligible flag is operator-clearable, and a zeroed
    /// destination that was reconciled and then removed from the current
    /// list is the exact chain the heal exists for. The FROZEN marker
    /// (which never clears) is what keeps it heal-eligible.
    function testHealSurvivesReconciliationOfZeroedDest() public {
        _configureCanonical();
        _com().setLapseSchedule(7 days, 24 hours);
        uint256 dayId = _armAndFinalizeWithOpZeroed();

        RewardCommitmentFacet(address(diamond))
            .reconcileCommitmentRemitEligibility(dayId, CHAIN_OP);
        uint256[] memory only = new uint256[](1);
        only[0] = CHAIN_ARB;
        messenger.setBroadcastDestinations(only); // OP off the list too

        vm.prank(alice);
        _agg().broadcastGlobalTo(dayId, CHAIN_OP);
        assertEq(
            messenger.broadcastV3SingleCount(),
            1,
            "frozen zeroed marker preserved the heal standing"
        );
        (, bool zeroed) = messenger.lastV3SingleDest();
        assertTrue(zeroed, "and the frozen marker rides the heal");
    }

    function testHealRevertsWithoutStanding() public {
        _configureCanonical();
        _com().setLapseSchedule(7 days, 24 hours);
        _reportAndFinalizeDay1();

        vm.expectRevert(
            abi.encodeWithSelector(
                DestinationHasNoDayStanding.selector, 1, uint256(CHAIN_UNKNOWN)
            )
        );
        _agg().broadcastGlobalTo(1, CHAIN_UNKNOWN);
    }

    function testHealRevertsForSelfAndOverwideChainId() public {
        _configureCanonical();
        _com().setLapseSchedule(7 days, 24 hours);
        _reportAndFinalizeDay1();

        vm.expectRevert(
            abi.encodeWithSelector(
                DestinationHasNoDayStanding.selector, 1, uint256(CHAIN_BASE)
            )
        );
        _agg().broadcastGlobalTo(1, CHAIN_BASE);

        uint256 wide = uint256(type(uint32).max) + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                DestinationHasNoDayStanding.selector, 1, wide
            )
        );
        _agg().broadcastGlobalTo(1, wide);
    }

    function testHealRevertsOnClocklessDay() public {
        _configureCanonical();
        _com().setLapseSchedule(7 days, 24 hours);
        _reportAndFinalizeDay1();
        _mut().clearDayLapseClockRaw(1);

        vm.expectRevert(
            abi.encodeWithSelector(DayHasNoLapseClock.selector, 1)
        );
        _agg().broadcastGlobalTo(1, CHAIN_ARB);
    }

    function testHealRevertsBeforeFinalization() public {
        _configureCanonical();
        vm.expectRevert(DayNotReadyToFinalize.selector);
        _agg().broadcastGlobalTo(1, CHAIN_ARB);
    }

    /// The heal cannot fall back to V2 — kind-5 carries no clock, so a
    /// fallback would "succeed" while healing nothing. A pre-V3 messenger
    /// is a reasoned refusal instead.
    function testHealRevertsOnPreV3Messenger() public {
        _configureCanonical();
        messenger.setV3Unsupported(true);
        _com().setLapseSchedule(7 days, 24 hours);
        _reportAndFinalizeDay1();

        vm.expectRevert(MessengerPredatesV3.selector);
        _agg().broadcastGlobalTo(1, CHAIN_ARB);

        vm.expectRevert(MessengerPredatesV3.selector);
        _agg().quoteBroadcastGlobalTo(1, CHAIN_ARB);
    }

    function testQuoteBroadcastGlobalTo() public {
        _configureCanonical();
        messenger.setQuoteNative(0.05 ether);
        _com().setLapseSchedule(7 days, 24 hours);
        _reportAndFinalizeDay1();

        assertEq(
            _agg().quoteBroadcastGlobalTo(1, CHAIN_ARB),
            0.15 ether,
            "single-lane V3 pricing"
        );
    }

}

/// @notice Mirror-side coverage: the V3 ingress (install / gates / era
///         binding / rotation), proof 2 (clock backfill), proof 3
///         (kind-5 still applies) and proof 4 (divergence extension).
contract RewardBroadcastV3MirrorTest is RewardBroadcastV3Harness {
    // ════════════════════════════════════════════════════════════════════════
    // Mirror-side V3 ingress — install, gates, era binding
    // ════════════════════════════════════════════════════════════════════════

    function testV3IngressFreshApplyInstallsClockAndV2Effects() public {
        _configureMirror(CHAIN_ARB);
        RewardBroadcastV3 memory b = _v3Packet(CHAIN_ARB);
        b.zeroedForDest = true;

        vm.expectEmit(true, true, false, true);
        emit RewardReporterFacet.DayClockInstalled(
            3, 1_700_000_000, 1, true, ERA_BASE, false
        );
        messenger.deliverBroadcastV3(b);

        // V2 layer applied (same effects the kind-5 path produces).
        (uint256 gl, uint256 gb, bool isSet) =
            _rep().getKnownGlobalInterestNumeraire18(3);
        assertTrue(isSet);
        assertEq(gl, 30e18);
        assertEq(gb, 15e18);
        LibVaipakam.ChainDayFunding memory f =
            _agg().getChainDayRecycledFunding(3, CHAIN_ARB);
        assertTrue(f.stamped, "funding stamp written");
        assertEq(f.recycleConsume, 5e18);

        // V3 layer installed.
        (uint64 at, uint32 ver, uint64 w, uint64 g) = _com().getDayLapseClock(3);
        assertEq(at, 1_700_000_000);
        assertEq(ver, 1);
        assertEq(w, 7 days);
        assertEq(g, 24 hours);
        assertEq(_rep().getDayClockEra(3), ERA_BASE, "era recorded");
        assertTrue(_rep().getDayDeliberatelyZeroed(3), "zeroed marker stored");
    }

    function testV3IngressRejectsZeroClock() public {
        _configureMirror(CHAIN_ARB);
        RewardBroadcastV3 memory b = _v3Packet(CHAIN_ARB);
        b.finalizedAt = 0;
        vm.expectRevert(
            abi.encodeWithSelector(BroadcastClockMissing.selector, 3)
        );
        messenger.deliverBroadcastV3(b);
    }

    function testV3IngressRejectsWrongDestination() public {
        _configureMirror(CHAIN_ARB);
        RewardBroadcastV3 memory b = _v3Packet(CHAIN_OP);
        vm.expectRevert(
            abi.encodeWithSelector(
                BroadcastDestinationMismatch.selector, uint256(CHAIN_OP)
            )
        );
        messenger.deliverBroadcastV3(b);
    }

    function testV3IngressMessengerGated() public {
        _configureMirror(CHAIN_ARB);
        vm.prank(alice);
        vm.expectRevert(NotAuthorizedRewardMessenger.selector);
        _rep().onRewardBroadcastV3Received(_v3Packet(CHAIN_ARB));
    }

    /// Era binding (§2h constraint 20): once a day's clock names its Base
    /// deployment, a packet from any OTHER deployment is rejected — a
    /// delayed broadcast from a retired Base cannot reach into the new era.
    /// (Reaching the per-day check requires a packet that PASSES the
    /// configured-era gate: rotate the config to the stale sender first —
    /// exactly the recorded-era-survives-rotation property.)
    function testV3IngressEraMismatchRejected() public {
        _configureMirror(CHAIN_ARB);
        messenger.deliverBroadcastV3(_v3Packet(CHAIN_ARB));

        _rep().setBaseRewardDeployment(address(0x0DD));
        RewardBroadcastV3 memory stale = _v3Packet(CHAIN_ARB);
        stale.baseDeployment = address(0x0DD);
        vm.expectRevert(
            abi.encodeWithSelector(
                BroadcastEraMismatch.selector, 3, ERA_BASE, address(0x0DD)
            )
        );
        messenger.deliverBroadcastV3(stale);
    }

    /// Codex #1632 r1 P1 — the FIRST install is the era race the per-day
    /// record cannot defend: with no clock recorded, a retired
    /// deployment's delayed packet must be rejected by the CONFIGURED
    /// ground truth, never allowed to win the race and poison the day.
    function testV3IngressRejectsRetiredDeploymentFirstInstall() public {
        _configureMirror(CHAIN_ARB);
        RewardBroadcastV3 memory stale = _v3Packet(CHAIN_ARB);
        stale.baseDeployment = address(0x0DD); // retired deployment
        vm.expectRevert(
            abi.encodeWithSelector(
                BroadcastEraUnauthenticated.selector,
                3,
                ERA_BASE,
                address(0x0DD)
            )
        );
        messenger.deliverBroadcastV3(stale);
        assertEq(_rep().getDayClockEra(3), address(0), "era not poisoned");
    }

    /// Fail-closed while unarmed: a mirror whose operator has not set the
    /// era ground truth rejects EVERY V3 (the packet stays a failed,
    /// re-executable CCIP message — healable after arming).
    function testV3IngressDarkUntilEraGroundTruthArmed() public {
        _configureMirrorUnarmed(CHAIN_ARB);

        vm.expectRevert(
            abi.encodeWithSelector(
                BroadcastEraUnauthenticated.selector, 3, address(0), ERA_BASE
            )
        );
        messenger.deliverBroadcastV3(_v3Packet(CHAIN_ARB));

        // Arming heals: the same packet now applies.
        _rep().setBaseRewardDeployment(ERA_BASE);
        messenger.deliverBroadcastV3(_v3Packet(CHAIN_ARB));
        assertEq(_rep().getDayClockEra(3), ERA_BASE);
    }

    function testSetBaseRewardDeploymentRequiresAdmin() public {
        _configureMirror(CHAIN_ARB);
        vm.prank(alice);
        vm.expectRevert();
        _rep().setBaseRewardDeployment(ERA_BASE);
    }

    /// Codex #1632 r2 P1 — a true era ROTATION permanently retires the
    /// identity-less legacy wires' FRESH applies (a retired era's delayed
    /// or re-executed kind-5/kind-2 is indistinguishable from a
    /// legitimate one; the new era only speaks V3). Replays of
    /// already-applied days stay idempotent, and a disarm/re-arm cycle of
    /// the SAME era is not a rotation.
    function testRotationRetiresLegacyWire() public {
        _configureMirror(CHAIN_ARB);
        messenger.deliverBroadcastV2(_v2Packet(CHAIN_ARB)); // day 3 applied

        // Disarm/re-arm same era: NOT a rotation — wire stays open.
        _rep().setBaseRewardDeployment(address(0));
        _rep().setBaseRewardDeployment(ERA_BASE);
        RewardBroadcastV2 memory day4 = _v2Packet(CHAIN_ARB);
        day4.dayId = 4;
        messenger.deliverBroadcastV2(day4);

        // A DIFFERENT nonzero era: rotation — legacy fresh applies retire.
        _rep().setBaseRewardDeployment(address(0xE2));
        RewardBroadcastV2 memory day5 = _v2Packet(CHAIN_ARB);
        day5.dayId = 5;
        vm.expectRevert(
            abi.encodeWithSelector(LegacyBroadcastRetired.selector, 5)
        );
        messenger.deliverBroadcastV2(day5);

        // Kind-2 fresh writes retire too (a retired era's pair would wedge
        // the day against the new era's V3).
        vm.expectRevert(
            abi.encodeWithSelector(LegacyBroadcastRetired.selector, 6)
        );
        messenger.deliverBroadcast(6, 1e18, 1e18, type(uint256).max);

        // Replays of the pre-rotation days stay idempotent.
        messenger.deliverBroadcastV2(_v2Packet(CHAIN_ARB));
        messenger.deliverBroadcastV2(day4);
    }

    /// Codex #1632 r2 P1 — the cross-era backfill sequence: a kind-5
    /// applied under era 1, then a rotation, then a current-era V3 for
    /// the same day. The apply-time PROVENANCE stamp is what blocks it:
    /// the day's recorded era names era 1, so the era-2 packet fails the
    /// per-day check instead of stamping era 2 onto era-1 figures.
    function testCrossEraBackfillBlocked() public {
        _configureMirror(CHAIN_ARB);
        messenger.deliverBroadcastV2(_v2Packet(CHAIN_ARB)); // era-1 figures
        assertEq(_rep().getDayClockEra(3), ERA_BASE, "provenance = era 1");

        _rep().setBaseRewardDeployment(address(0xE2)); // rotation

        RewardBroadcastV3 memory b = _v3Packet(CHAIN_ARB);
        b.baseDeployment = address(0xE2); // passes the configured-era gate
        vm.expectRevert(
            abi.encodeWithSelector(
                BroadcastEraMismatch.selector, 3, ERA_BASE, address(0xE2)
            )
        );
        messenger.deliverBroadcastV3(b);

        (uint64 at, , , ) = _com().getDayLapseClock(3);
        assertEq(at, 0, "no cross-era clock was smuggled in");
    }

    /// Codex #1632 r3 P1 — the PRE-ARMING inventory: days applied before
    /// the era ground truth existed carry no provenance (`era == 0`).
    /// After a ROTATION the mirror can no longer tell which era supplied
    /// their figures, so it refuses to attach V3 clock facts to them —
    /// via the backfill branch (kind-5-applied) AND the mixed-generation
    /// full apply (kind-2 pair). Such days belong to the pre-rotation
    /// drain/heal ceremony.
    function testEraUnknownDaysUnhealableAfterRotation() public {
        _configureMirrorUnarmed(CHAIN_ARB);
        messenger.deliverBroadcastV2(_v2Packet(CHAIN_ARB)); // day 3, era 0
        messenger.deliverBroadcast(7, 9e18, 4e18, type(uint256).max); // kind-2
        assertEq(_rep().getDayClockEra(3), address(0), "no provenance");

        _rep().setBaseRewardDeployment(ERA_BASE); // first arming
        _rep().setBaseRewardDeployment(address(0xE2)); // rotation

        RewardBroadcastV3 memory b3 = _v3Packet(CHAIN_ARB);
        b3.baseDeployment = address(0xE2);
        vm.expectRevert(
            abi.encodeWithSelector(
                BroadcastEraMismatch.selector, 3, address(0), address(0xE2)
            )
        );
        messenger.deliverBroadcastV3(b3);

        RewardBroadcastV3 memory b7 = _v3Packet(CHAIN_ARB);
        b7.v2.dayId = 7;
        b7.v2.globalLenderNumeraire18 = 9e18;
        b7.v2.globalBorrowerNumeraire18 = 4e18;
        b7.baseDeployment = address(0xE2);
        vm.expectRevert(
            abi.encodeWithSelector(
                BroadcastEraMismatch.selector, 7, address(0), address(0xE2)
            )
        );
        messenger.deliverBroadcastV3(b7);
    }

    /// The counterpart that keeps the LIVE MIGRATION healable: on a mirror
    /// that has NEVER rotated, era-unknown days (applied before arming)
    /// heal freely — a single era in the mirror's history leaves nothing
    /// to confuse them with.
    function testEraUnknownDayHealsOnNeverRotatedMirror() public {
        _configureMirrorUnarmed(CHAIN_ARB);
        messenger.deliverBroadcastV2(_v2Packet(CHAIN_ARB)); // day 3, era 0

        _rep().setBaseRewardDeployment(ERA_BASE); // first arming only
        messenger.deliverBroadcastV3(_v3Packet(CHAIN_ARB));

        (uint64 at, , , ) = _com().getDayLapseClock(3);
        assertEq(at, 1_700_000_000, "pre-arming day healed");
        assertEq(_rep().getDayClockEra(3), ERA_BASE, "era recorded");
    }

    // ════════════════════════════════════════════════════════════════════════
    // PROOF 2 — clock backfill on an already-applied day
    // ════════════════════════════════════════════════════════════════════════

    /// A day whose figures were applied via kind-5 before the upgrade
    /// accepts a V3 packet as a CLOCK BACKFILL: it verifies only the
    /// immutable global pair, writes only the V3 fields, and never touches
    /// the halves — proven here by delivering a V3 whose halves DIFFER
    /// (as they legitimately can after `backfillDayInclusion` mutated the
    /// destination's figures on Base) and asserting the mirror's stored
    /// stamp is unchanged.
    function testClockBackfillOnKind5AppliedDay() public {
        _configureMirror(CHAIN_ARB);
        messenger.deliverBroadcastV2(_v2Packet(CHAIN_ARB));
        (uint64 preAt, , , ) = _com().getDayLapseClock(3);
        assertEq(preAt, 0, "kind-5 apply leaves no clock");

        RewardBroadcastV3 memory b = _v3Packet(CHAIN_ARB);
        b.zeroedForDest = true;
        b.v2.freshLenderHalf = 999e18; // halves deliberately divergent
        b.v2.recycleConsume = 777e18;

        vm.expectEmit(true, true, false, true);
        emit RewardReporterFacet.DayClockInstalled(
            3, 1_700_000_000, 1, true, ERA_BASE, true
        );
        messenger.deliverBroadcastV3(b);

        // The clock landed…
        (uint64 at, uint32 ver, , ) = _com().getDayLapseClock(3);
        assertEq(at, 1_700_000_000);
        assertEq(ver, 1);
        assertEq(_rep().getDayClockEra(3), ERA_BASE);
        assertTrue(_rep().getDayDeliberatelyZeroed(3));
        // …and the applied figures did NOT (adding the clock is the
        // branch's only write).
        LibVaipakam.ChainDayFunding memory f =
            _agg().getChainDayRecycledFunding(3, CHAIN_ARB);
        assertEq(f.freshLenderHalf, 20e18, "halves untouched by backfill");
        assertEq(f.recycleConsume, 5e18, "consume untouched by backfill");
    }

    /// Codex #1632 r1 P1 — the backfill must PRESERVE the pre-d3
    /// reservation repair the V2 replay path performs: a day applied by a
    /// pre-d3 receiver has `broadcastV2Applied` without its reservation,
    /// and a backfill that returned early would leave the heal looking
    /// complete while the mirror stayed under-reserved. The repair uses the
    /// STORED applied figure — proven by a packet carrying divergent
    /// halves — and is idempotent on replay.
    function testClockBackfillRepairsPreD3Reservation() public {
        _configureMirror(CHAIN_ARB);
        messenger.deliverBroadcastV2(_v2Packet(CHAIN_ARB));
        // Reconstruct the PRE-d3 receiver state: applied + stamped, but
        // never reserved.
        _mut().setMirrorCommitReservedRaw(3, false);
        _mut().setOutstandingCommitRaw(0, 0);

        RewardBroadcastV3 memory b = _v3Packet(CHAIN_ARB);
        b.v2.recycleConsume = 777e18; // divergent packet figure — untrusted
        messenger.deliverBroadcastV3(b);

        (, , uint256 outstandingRecycled, ) = _agg().getGovernorCommitState();
        assertEq(
            outstandingRecycled,
            5e18,
            "repair reserved the STORED applied figure, not the packet's"
        );

        // Idempotent: a replay does not double-reserve. (With the clock now
        // installed, a replay routes through the shared core's
        // full-divergence path — so it must carry the TRUE figures; the
        // divergent probe above was only admissible on the backfill branch,
        // which deliberately does not compare halves.)
        messenger.deliverBroadcastV3(_v3Packet(CHAIN_ARB));
        (, , uint256 outstandingAfterReplay, ) =
            _agg().getGovernorCommitState();
        assertEq(outstandingAfterReplay, 5e18, "no double reservation");
    }

    /// The backfill still verifies the immutable pair — a packet from a
    /// diverging history cannot smuggle a clock in.
    function testClockBackfillRejectsDivergentGlobals() public {
        _configureMirror(CHAIN_ARB);
        messenger.deliverBroadcastV2(_v2Packet(CHAIN_ARB));

        RewardBroadcastV3 memory b = _v3Packet(CHAIN_ARB);
        b.v2.globalLenderNumeraire18 = 31e18;
        vm.expectRevert(KnownGlobalAlreadySet.selector);
        messenger.deliverBroadcastV3(b);
    }

    // ════════════════════════════════════════════════════════════════════════
    // PROOF 3 (facet level) — old kind-5 still applies, without a clock
    // ════════════════════════════════════════════════════════════════════════

    function testKind5StillAppliesWithoutClock() public {
        _configureMirror(CHAIN_ARB);
        messenger.deliverBroadcastV2(_v2Packet(CHAIN_ARB));

        (uint256 gl, , bool isSet) = _rep().getKnownGlobalInterestNumeraire18(3);
        assertTrue(isSet, "kind-5 applied in full");
        assertEq(gl, 30e18);
        (uint64 at, , , ) = _com().getDayLapseClock(3);
        assertEq(at, 0, "no clock - day not lapse-eligible");
        // #1632 r2 — an ARMED mirror stamps era PROVENANCE at apply time
        // (the configured era it believed was sending), even though the
        // kind-5 wire itself carries no identity and no clock.
        assertEq(
            _rep().getDayClockEra(3), ERA_BASE, "provenance stamped on apply"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // PROOF 4 — the replay-divergence check extends to the frozen fields
    // ════════════════════════════════════════════════════════════════════════

    function testV3ReplayIdenticalIsIdempotent() public {
        _configureMirror(CHAIN_ARB);
        messenger.deliverBroadcastV3(_v3Packet(CHAIN_ARB));
        messenger.deliverBroadcastV3(_v3Packet(CHAIN_ARB));
        (uint64 at, , , ) = _com().getDayLapseClock(3);
        assertEq(at, 1_700_000_000, "replay is a no-op");
    }

    function testV3ReplayDivergenceOnEachFrozenField() public {
        _configureMirror(CHAIN_ARB);
        messenger.deliverBroadcastV3(_v3Packet(CHAIN_ARB));

        RewardBroadcastV3 memory b;
        bytes memory divergence =
            abi.encodeWithSelector(BroadcastClockDivergence.selector, 3);

        b = _v3Packet(CHAIN_ARB);
        b.finalizedAt = 1_700_000_001;
        vm.expectRevert(divergence);
        messenger.deliverBroadcastV3(b);

        b = _v3Packet(CHAIN_ARB);
        b.lapseScheduleVersion = 2;
        vm.expectRevert(divergence);
        messenger.deliverBroadcastV3(b);

        b = _v3Packet(CHAIN_ARB);
        b.lapseWindowSeconds = 8 days;
        vm.expectRevert(divergence);
        messenger.deliverBroadcastV3(b);

        b = _v3Packet(CHAIN_ARB);
        b.dispatchCutoffGap = 12 hours;
        vm.expectRevert(divergence);
        messenger.deliverBroadcastV3(b);

        b = _v3Packet(CHAIN_ARB);
        b.zeroedForDest = true;
        vm.expectRevert(divergence);
        messenger.deliverBroadcastV3(b);
    }

    /// `armedFromDay` stays OUTSIDE the frozen-field comparison, exactly as
    /// on the V2 path: its install is first-apply-only, so a replay with a
    /// different value is accepted and changes nothing.
    function testV3ReplayArmedFromDayStaysOutsideComparison() public {
        _configureMirror(CHAIN_ARB);
        messenger.deliverBroadcastV3(_v3Packet(CHAIN_ARB));

        RewardBroadcastV3 memory b = _v3Packet(CHAIN_ARB);
        b.v2.armedFromDay = 9; // was 2
        messenger.deliverBroadcastV3(b); // accepted — no revert

        // First-apply-only: the original arming day survives.
        (uint256 armedFromDay, , , ) = _agg().getGovernorCommitState();
        assertEq(armedFromDay, 2, "first-applied arming day unchanged");
    }

    /// A V3 for a day applied via the LEGACY kind-2 wire (known pair set,
    /// but never V2-applied) takes the FULL apply path — V2 figures layered
    /// on, clock installed. Not a backfill: the backfill branch is only for
    /// `broadcastV2Applied` days.
    function testV3OnLegacyKind2AppliedDayDoesFullApply() public {
        _configureMirror(CHAIN_ARB);
        // #1636 r2 — the kind-2 pair carries the SAME frozen day-pool
        // figures the V3 packet does (production freezes once, sends on
        // both wires); a divergent pair is the consensus violation
        // {_installDayPoolStampV3} rejects.
        messenger.deliverBroadcastFull(
            3, 30e18, 15e18, type(uint256).max, 20e18, 10e18, 0
        );

        messenger.deliverBroadcastV3(_v3Packet(CHAIN_ARB));

        LibVaipakam.ChainDayFunding memory f =
            _agg().getChainDayRecycledFunding(3, CHAIN_ARB);
        assertTrue(f.stamped, "V2 layer applied on top of legacy pair");
        (uint64 at, , , ) = _com().getDayLapseClock(3);
        assertEq(at, 1_700_000_000, "clock installed");
    }

    /// @dev #1636 r2 P1 — the V3 PRODUCTION path installs the day-level
    ///      pool stamp (the Δq quote numerator + the quote surface's
    ///      stamp gate). Before r2 only the retiring legacy kind-2
    ///      ingress wrote it, leaving V3-delivered zeroed days unable to
    ///      quote at all; the earlier tests concealed that by seeding the
    ///      stamp raw.
    function testV3InstallsDayPoolStamp() public {
        _configureMirror(CHAIN_ARB);
        messenger.deliverBroadcastV3(_v3Packet(CHAIN_ARB));
        (bool stamped, uint256 floor, uint256 recycled, , ) =
            _agg().getDayPoolStamp(3);
        assertTrue(stamped, "V3 apply installs the day-pool stamp");
        assertEq(floor, 40e18, "floor = wire half x 2");
        assertEq(recycled, 20e18, "recycled = half x 2");
    }

    /// @dev #1636 r2 — a pre-r2 V3 day (kind-5 applied: clock and stamp
    ///      both missing) heals BOTH by the same permissionless re-send,
    ///      through the clock-backfill branch.
    function testV3BackfillInstallsDayPoolStampToo() public {
        _configureMirror(CHAIN_ARB);
        messenger.deliverBroadcastV2(_v2Packet(CHAIN_ARB)); // no stamp
        (bool stampedBefore, , , , ) = _agg().getDayPoolStamp(3);
        assertFalse(stampedBefore, "kind-5 leaves no day-pool stamp");

        messenger.deliverBroadcastV3(_v3Packet(CHAIN_ARB)); // backfill
        (bool stamped, uint256 floor, , , ) = _agg().getDayPoolStamp(3);
        assertTrue(stamped, "backfill branch installs the stamp");
        assertEq(floor, 40e18, "floor from the wire");
    }
}

/// @notice #1434 P2-w2 — the §2.2 compensation-ingress CLASSIFICATION over
///         the same harness (the mirror's era/zeroed/clock state is driven
///         by real V3 deliveries). Slice-2 proofs: quarantine on each
///         ingress case; the arrival reservation visible in the backing
///         figures (the ONE `backingPosition` definition both enforcement
///         sites read — #1555); unstamped-mirror classification (the
///         provisional credit, CONFIRMED and DEMOTED).
contract CompensationClassificationTest is RewardBroadcastV3Harness {
    address internal constant REMITTER = ERA_BASE; // honest-path sender
    uint256 internal constant REMIT_ID = 42;

    ERC20Mock internal vpfiToken;

    function _remit() internal view returns (RewardRemittanceFacet) {
        return RewardRemittanceFacet(address(diamond));
    }

    function _rlens() internal view returns (RewardRemittanceLensFacet) {
        return RewardRemittanceLensFacet(address(diamond));
    }

    function _lens() internal view returns (InteractionRewardsLensFacet) {
        return InteractionRewardsLensFacet(address(diamond));
    }

    /// @dev Mirror config + this test as the remittance receiver (so the
    ///      classifying ingress is directly callable) + a real ERC20 as
    ///      the VPFI token with a funded Diamond balance, so the backing
    ///      snapshot's balance read is live.
    function _configureCompMirror() internal {
        _configureMirror(CHAIN_ARB);
        _remit().setRewardRemittanceReceiver(address(this));
        vpfiToken = new ERC20Mock("VPFI", "VPFI", 18);
        _mut().setVpfiTokenRaw(address(vpfiToken));
        vpfiToken.mint(address(diamond), 1_000e18);
    }

    function _deliverComp(
        uint256 dayId,
        address remitter,
        uint256 lenderShare,
        uint256 borrowerShare
    ) internal {
        // Healthy clock words: frozen v1, 7-day window, far-future
        // finalization relative to the test clock (t is small in tests),
        // so the arrival is never past expiry unless a test says so.
        _deliverCompWithClock(
            dayId,
            remitter,
            lenderShare,
            borrowerShare,
            uint64(block.timestamp),
            uint32(1),
            uint64(7 days)
        );
    }

    function _deliverCompWithClock(
        uint256 dayId,
        address remitter,
        uint256 lenderShare,
        uint256 borrowerShare,
        uint64 finalizedAt,
        uint32 scheduleVersion,
        uint64 lapseWindowSeconds
    ) internal {
        _remit().onCompensationBudgetReceived(
            address(vpfiToken),
            lenderShare + borrowerShare,
            dayId,
            CHAIN_BASE,
            REMIT_ID,
            remitter,
            lenderShare,
            borrowerShare,
            finalizedAt,
            scheduleVersion,
            lapseWindowSeconds,
            uint64(24 hours)
        );
    }

    // ── Quarantine case 1: day applied + era known, NOT zeroed ─────────────

    function testQuarantine_NotZeroedDay() public {
        _configureCompMirror();
        messenger.deliverBroadcastV3(_v3Packet(CHAIN_ARB)); // zeroed = false

        (, , uint256 unearmarkedBefore, , , , uint256 reservedBefore) =
            _lens().getRecycleBackingSnapshot();
        assertEq(reservedBefore, 0, "reservation starts empty");

        _deliverComp(3, REMITTER, 3e18, 2e18);

        LibVaipakam.StrandedRecovery memory sr =
            _rlens().getStrandedRecovery(REMITTER, REMIT_ID);
        assertEq(sr.amount, 5e18, "whole arrival reserved");
        assertEq(sr.dayId, 3, "bound day recorded");
        assertEq(sr.reason, 1, "reason: not a zeroed day");
        assertEq(
            _rlens().getStrandedRecoveryReserved(), 5e18, "sum advanced"
        );
        // The §4.1 claim exclusion, visible at the ONE definition both
        // enforcement sites read: unearmarked shrinks by the reservation.
        (, , uint256 unearmarkedAfter, , , , uint256 reservedAfter) =
            _lens().getRecycleBackingSnapshot();
        assertEq(reservedAfter, 5e18, "snapshot publishes the reservation");
        assertEq(
            unearmarkedAfter,
            unearmarkedBefore > 5e18 ? unearmarkedBefore - 5e18 : 0,
            "unearmarked excludes the reservation"
        );
        // Nothing payable was credited, and the fresh value is UNCOUNTED.
        LibVaipakam.DayCompensation memory dc = _rlens().getDayCompensation(3);
        assertEq(dc.lenderPool18, 0, "no pool credit");
        assertFalse(dc.compensated, "not compensated");
        // Receipt recorded exactly like an ordinary delivery (ACK path).
        assertGt(
            _rlens().getReceivedRemit(REMITTER, REMIT_ID).receivedAt,
            0,
            "receipt recorded"
        );
    }

    // ── Quarantine case 2: era mismatch on a known day ─────────────────────

    function testQuarantine_EraMismatch() public {
        _configureCompMirror();
        RewardBroadcastV3 memory b = _v3Packet(CHAIN_ARB);
        b.zeroedForDest = true;
        messenger.deliverBroadcastV3(b);

        _deliverComp(3, address(0xDD), 3e18, 2e18);

        LibVaipakam.StrandedRecovery memory sr =
            _rlens().getStrandedRecovery(address(0xDD), REMIT_ID);
        assertEq(sr.amount, 5e18, "reserved");
        assertEq(sr.reason, 2, "reason: era mismatch");
        assertFalse(_rlens().getDayCompensation(3).compensated, "no credit");
    }

    // ── Quarantine case 3: post-lapse arrival (w4 flags via mutator) ───────

    function testQuarantine_PostLapse() public {
        _configureCompMirror();
        RewardBroadcastV3 memory b = _v3Packet(CHAIN_ARB);
        b.zeroedForDest = true;
        messenger.deliverBroadcastV3(b);
        _mut().setDayLapsedRaw(3, true, false);

        _deliverComp(3, REMITTER, 3e18, 2e18);

        assertEq(
            _rlens().getStrandedRecovery(REMITTER, REMIT_ID).reason,
            3,
            "reason: post-lapse"
        );
        assertFalse(_rlens().getDayCompensation(3).compensated, "no credit");
    }

    // ── The confirmed credit: applied + era match + zeroed + not lapsed ────

    function testCredit_ZeroedDay() public {
        _configureCompMirror();
        RewardBroadcastV3 memory b = _v3Packet(CHAIN_ARB);
        b.zeroedForDest = true;
        messenger.deliverBroadcastV3(b);

        uint256 armedBefore = 0; // fresh deploy: nothing armed-received yet
        _deliverComp(3, REMITTER, 3e18, 2e18);

        LibVaipakam.DayCompensation memory dc = _rlens().getDayCompensation(3);
        assertEq(dc.lenderPool18, 3e18, "lender pool per side");
        assertEq(dc.borrowerPool18, 2e18, "borrower pool per side");
        assertTrue(dc.compensated, "compensated");
        assertFalse(dc.provisional, "state was known - not provisional");
        // Day 3 >= the packet's armedFromDay (2): armed-attributable, and
        // what was counted is recorded for a potential demotion.
        assertEq(dc.armedFreshCounted, 5e18, "counted figure stored");
        assertEq(
            _rlens().getStrandedRecoveryReserved(),
            armedBefore,
            "nothing quarantined"
        );
    }

    // ── The provisional credit (§2.2 case b): compensation OVERTAKES V3 ────

    function testProvisional_UnappliedDay() public {
        _configureCompMirror();
        _deliverComp(3, REMITTER, 3e18, 2e18); // no broadcast yet

        LibVaipakam.DayCompensation memory dc = _rlens().getDayCompensation(3);
        assertTrue(dc.compensated, "credited");
        assertTrue(dc.provisional, "provisional - era unknown");
        assertEq(dc.provisionalEra, REMITTER, "assumed era = remitter");
        assertEq(dc.lenderPool18, 3e18, "pools credited pending the era");
    }

    function testProvisionalConfirmedInPlace() public {
        _configureCompMirror();
        _deliverComp(3, REMITTER, 3e18, 2e18);
        // Credited while the chain was UNARMED (no broadcast yet), so
        // nothing counted toward the armed-fresh ledger at credit time.
        assertEq(
            _rlens().getDayCompensation(3).armedFreshCounted,
            0,
            "unarmed at credit - uncounted"
        );

        RewardBroadcastV3 memory b = _v3Packet(CHAIN_ARB);
        b.zeroedForDest = true; // genuinely zeroed, matching era
        messenger.deliverBroadcastV3(b);

        LibVaipakam.DayCompensation memory dc = _rlens().getDayCompensation(3);
        assertTrue(dc.compensated, "credit stands");
        assertFalse(dc.provisional, "confirmed in place");
        assertEq(dc.lenderPool18, 3e18, "pools untouched");
        assertEq(_rlens().getStrandedRecoveryReserved(), 0, "no quarantine");
        // #1634 r3 — the confirming broadcast ALSO installed D* (the core
        // runs before the hook), so the credit reclassifies against it:
        // the delivered-fresh bound must see this day's backing.
        assertEq(
            dc.armedFreshCounted,
            5e18,
            "reclassified against the now-installed arming day"
        );
    }

    /// #1634 r3 — a fee-on-transfer delivery's per-side shares each floor,
    /// so their sum can sit below the credited amount; the demotion
    /// reserves the CREDITED amount wholesale, never the pool sum.
    function testDemotionReservesFullCreditedAmount() public {
        _configureCompMirror();
        _remit().onCompensationBudgetReceived(
            address(vpfiToken),
            5e18, // credited amount
            3,
            CHAIN_BASE,
            REMIT_ID,
            address(0xDD), // stale era - will demote on the real broadcast
            3e18,
            2e18 - 1, // floored shares: sum = 5e18 - 1
            uint64(block.timestamp),
            uint32(1),
            uint64(7 days),
            uint64(24 hours)
        );

        RewardBroadcastV3 memory b = _v3Packet(CHAIN_ARB);
        b.zeroedForDest = true;
        messenger.deliverBroadcastV3(b); // era 0xDD != ERA_BASE -> demote

        assertEq(
            _rlens().getStrandedRecovery(address(0xDD), REMIT_ID).amount,
            5e18,
            "the FULL credited amount is reserved, not the floored pool sum"
        );
        assertEq(_rlens().getStrandedRecoveryReserved(), 5e18, "sum moved");
    }

    function testProvisionalDemoted_EraMismatch() public {
        _configureCompMirror();
        _deliverComp(3, address(0xDD), 3e18, 2e18); // stale-era sender

        RewardBroadcastV3 memory b = _v3Packet(CHAIN_ARB);
        b.zeroedForDest = true;
        messenger.deliverBroadcastV3(b); // confirmed era = ERA_BASE

        LibVaipakam.DayCompensation memory dc = _rlens().getDayCompensation(3);
        assertFalse(dc.compensated, "provisional state deleted");
        LibVaipakam.StrandedRecovery memory sr =
            _rlens().getStrandedRecovery(address(0xDD), REMIT_ID);
        assertEq(sr.amount, 5e18, "whole credit demoted to the reservation");
        assertEq(sr.reason, 2, "reason: era mismatch");
        assertEq(_rlens().getStrandedRecoveryReserved(), 5e18, "sum moved");
    }

    function testProvisionalDemoted_NotZeroed() public {
        _configureCompMirror();
        _deliverComp(3, REMITTER, 3e18, 2e18);

        messenger.deliverBroadcastV3(_v3Packet(CHAIN_ARB)); // zeroed = false

        LibVaipakam.StrandedRecovery memory sr =
            _rlens().getStrandedRecovery(REMITTER, REMIT_ID);
        assertEq(sr.amount, 5e18, "demoted");
        assertEq(sr.reason, 1, "reason: the day was never zeroed");
    }

    // ── Malformed payload + hook gate ──────────────────────────────────────

    function testSharesBoundIsEnforced() public {
        _configureCompMirror();
        vm.expectRevert(
            abi.encodeWithSelector(
                CompensationSharesExceedDelivery.selector, 3e18, 3e18, 5e18
            )
        );
        _remit().onCompensationBudgetReceived(
            address(vpfiToken),
            5e18,
            3,
            CHAIN_BASE,
            REMIT_ID,
            REMITTER,
            3e18,
            3e18,
            uint64(1_700_000_000),
            uint32(1),
            uint64(7 days),
            uint64(24 hours)
        );
    }

    function testHookIsSelfGated() public {
        _configureCompMirror();
        vm.expectRevert(
            abi.encodeWithSelector(
                CompensationHookNotSelf.selector, address(this)
            )
        );
        _remit().onCompensationDayBroadcastArrived(3, ERA_BASE, true);
    }

    function testIngressIsReceiverGated() public {
        _configureMirror(CHAIN_ARB); // receiver NOT set to this test
        vm.expectRevert();
        _deliverComp(3, REMITTER, 3e18, 2e18);
    }

    // ── Codex #1634 r1 fixes ───────────────────────────────────────────────

    /// A SECOND arrival while a provisional credit is held must quarantine
    /// under its OWN receipt key (reason 4), never overwrite the first
    /// packet's era/remitId binding — otherwise a demotion would record
    /// BOTH packets' pools under the last key and the receipt-bounded
    /// return could recover at most one reservation's entitlement.
    function testSecondProvisionalArrivalQuarantines() public {
        _configureCompMirror();
        _deliverComp(3, address(0xD1), 3e18, 2e18); // first: provisional

        _deliverComp(3, address(0xD2), 4e18, 1e18); // second: conflicts

        LibVaipakam.DayCompensation memory dc = _rlens().getDayCompensation(3);
        assertEq(dc.provisionalEra, address(0xD1), "first binding intact");
        assertEq(dc.lenderPool18, 3e18, "first pools intact");
        LibVaipakam.StrandedRecovery memory sr =
            _rlens().getStrandedRecovery(address(0xD2), REMIT_ID);
        assertEq(sr.amount, 5e18, "second arrival reserved whole");
        assertEq(sr.reason, 4, "reason: provisional conflict");
    }

    /// A rotated mirror's legacy-applied era-less day can never receive its
    /// V3 heal (the w1 gate), so a compensation for it must quarantine at
    /// ingress (reason 5) — a provisional credit there could never reach
    /// the confirm/demote hook and its tokens would sit outside the
    /// reservation as spendable backing.
    function testUnhealableDayQuarantinesInsteadOfProvisional() public {
        _configureCompMirror();
        // Era-less applied state (pre-arming kind-5 apply), then a rotation.
        _rep().setBaseRewardDeployment(address(0));
        vm.chainId(CHAIN_ARB);
        _mut().setBroadcastV2AppliedRaw(3, true);
        _rep().setBaseRewardDeployment(ERA_BASE);
        _rep().setBaseRewardDeployment(address(0xE2)); // rotation

        _deliverComp(3, address(0xE2), 3e18, 2e18);

        assertFalse(
            _rlens().getDayCompensation(3).provisional,
            "never provisional"
        );
        LibVaipakam.StrandedRecovery memory sr =
            _rlens().getStrandedRecovery(address(0xE2), REMIT_ID);
        assertEq(sr.amount, 5e18, "reserved");
        assertEq(sr.reason, 5, "reason: V3-unhealable day");
    }

    /// The overtake case evaluates the WIRE-CARRIED frozen words: an
    /// arrival already past its true expiry quarantines (reason 3) instead
    /// of taking a provisional credit that could only lapse at
    /// confirmation.
    function testExpiredOvertakeQuarantinesFromWireWords() public {
        _configureCompMirror();
        vm.warp(block.timestamp + 30 days);
        uint64 finalizedLongAgo = uint64(block.timestamp - 10 days);

        _deliverCompWithClock(
            3, REMITTER, 3e18, 2e18, finalizedLongAgo, 1, uint64(7 days)
        );

        assertFalse(_rlens().getDayCompensation(3).compensated, "no credit");
        assertEq(
            _rlens().getStrandedRecovery(REMITTER, REMIT_ID).reason,
            3,
            "reason: past expiry, evaluated from the wire words"
        );
    }

    /// #1634 r2 — a CLOCKLESS payload (zero finalizedAt) quarantines on
    /// the overtake path (reason 6): an honest Base refuses such a
    /// dispatch, so an arrival carrying one is stale or hostile and its
    /// provisional credit could never settle.
    function testClocklessPayloadQuarantines() public {
        _configureCompMirror();
        _deliverCompWithClock(3, REMITTER, 3e18, 2e18, 0, 0, 0);

        assertFalse(_rlens().getDayCompensation(3).compensated, "no credit");
        assertEq(
            _rlens().getStrandedRecovery(REMITTER, REMIT_ID).reason,
            6,
            "reason: clockless payload"
        );
    }

    /// The known-state ladder evaluates the INSTALLED clock even before any
    /// w4 terminal has run: a compensation arriving after the day's true
    /// expiry quarantines on the clock alone (no lapse flags involved).
    function testExpiredKnownDayQuarantinesFromInstalledClock() public {
        _configureCompMirror();
        RewardBroadcastV3 memory b = _v3Packet(CHAIN_ARB);
        b.zeroedForDest = true; // installed clock: 1.7e9 + 7 days
        messenger.deliverBroadcastV3(b);

        vm.warp(uint256(1_700_000_000) + 8 days); // past the installed expiry
        _deliverComp(3, REMITTER, 3e18, 2e18);

        assertEq(
            _rlens().getStrandedRecovery(REMITTER, REMIT_ID).reason,
            3,
            "reason: past expiry, evaluated from the installed clock"
        );
    }
}
