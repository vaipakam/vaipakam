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
contract RewardBroadcastV3Test is SetupTest, IVaipakamErrors {
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

    function _configureMirror(uint32 localChainId) internal {
        vm.chainId(localChainId);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(false);
        _rep().setRewardMessenger(address(messenger));
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
            baseDeployment: ERA_BASE
        });
    }

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
        (uint64 at1, uint32 v1, uint64 w1, uint64 g1) =
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
        (uint64 at2, uint32 v2, uint64 w2, uint64 g2) =
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
        (uint64 at, uint32 ver, uint64 w, uint64 g) =
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
        (uint64 at, , uint64 w, ) = messenger.lastV3SingleExtras();
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
    function testV3IngressEraMismatchRejected() public {
        _configureMirror(CHAIN_ARB);
        messenger.deliverBroadcastV3(_v3Packet(CHAIN_ARB));

        RewardBroadcastV3 memory stale = _v3Packet(CHAIN_ARB);
        stale.baseDeployment = address(0x0DD);
        vm.expectRevert(
            abi.encodeWithSelector(
                BroadcastEraMismatch.selector, 3, ERA_BASE, address(0x0DD)
            )
        );
        messenger.deliverBroadcastV3(stale);
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
        assertEq(_rep().getDayClockEra(3), address(0), "no era recorded");
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
        messenger.deliverBroadcast(3, 30e18, 15e18, type(uint256).max);

        messenger.deliverBroadcastV3(_v3Packet(CHAIN_ARB));

        LibVaipakam.ChainDayFunding memory f =
            _agg().getChainDayRecycledFunding(3, CHAIN_ARB);
        assertTrue(f.stamped, "V2 layer applied on top of legacy pair");
        (uint64 at, , , ) = _com().getDayLapseClock(3);
        assertEq(at, 1_700_000_000, "clock installed");
    }
}
