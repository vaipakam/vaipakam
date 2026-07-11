// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";

import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/// @title CrossChainRewardPlumbingTest
/// @notice Production-readiness coverage for the cross-chain interaction-
///         reward mesh (docs/TokenomicsTechSpec.md §4a). Exercises every
///         revert path and state transition on RewardReporterFacet +
///         RewardAggregatorFacet, using {MockRewardMessenger} as the
///         trusted ingress peer instead of a live Chainlink CCIP
///         router / OffRamp stack.
///
///         Coverage layout:
///           - Admin surface (setters + role gate + event wiring)
///           - `closeDay` on canonical (Base) AND mirror branches
///           - `onChainReportReceived` ingress gates (auth, duplicate,
///             late-after-finalize, unknown-chain)
///           - `finalizeDay` preconditions (coverage vs grace, replay)
///           - `forceFinalizeDay` (admin-only, even with zero reports)
///           - `broadcastGlobal` (only-after-finalize, refund, retry)
///           - `onRewardBroadcastReceived` (auth + idempotent replay
///             + divergent-payload revert)
///           - `isDayReadyToFinalize` return codes
///           - Canonical-flag forks (Base path refunds msg.value, mirror
///             path forwards to the messenger, aggregator-only funcs
///             revert on non-canonical)
///           - Full E2E: mirror closeDay → Base ingress → finalize →
///             broadcast → mirror ingress → `InteractionRewardsFacet`
///             claim works
contract CrossChainRewardPlumbingTest is SetupTest, IVaipakamErrors {
    // #229 — RewardReporter/Aggregator + InteractionRewards facets are
    // now cut by `SetupTest.setupHelper()`. The prior local declarations
    // + local cut block dropped; existing `reporter.*` / `aggregator.*`
    // / `interaction.*` references are unused (the `_rep()` / `_agg()` /
    // `_int()` helpers below stay as-is, calling through the diamond
    // proxy directly).
    MockRewardMessenger internal messenger;

    address internal alice;
    address internal bob;

    // Real EVM chain ids — distinct, to catch self-inclusion bugs.
    // The Diamond's `block.chainid` is set per-test via `vm.chainId`.
    uint32 internal constant CHAIN_BASE = 8453; // Base mainnet (canonical)
    uint32 internal constant CHAIN_ARB = 42161; // Arbitrum (mirror)
    uint32 internal constant CHAIN_OP = 10; // Optimism (mirror)
    uint32 internal constant CHAIN_UNKNOWN = 137; // Polygon — not in expected list

    function setUp() public {
        setupHelper();

        // #229 — reward plumbing facets (RewardReporter, RewardAggregator,
        // InteractionRewards) now cut by setupHelper(). The prior local
        // cut here would double-cut and revert.
        messenger = new MockRewardMessenger(address(diamond));

        alice = makeAddr("alice");
        bob = makeAddr("bob");
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _rep() internal view returns (RewardReporterFacet) {
        return RewardReporterFacet(address(diamond));
    }

    function _agg() internal view returns (RewardAggregatorFacet) {
        return RewardAggregatorFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    /// @dev Configure the Diamond as the canonical (Base) reward chain.
    ///      `vm.chainId` makes the Diamond's `block.chainid` the canonical
    ///      id — the reward facets derive chain identity from it directly.
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
    }

    /// @dev Configure the Diamond as a mirror (non-canonical). `vm.chainId`
    ///      stands the Diamond up on the mirror's chain id.
    function _configureMirror(uint32 localChainId) internal {
        vm.chainId(localChainId);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(false);
        _rep().setRewardMessenger(address(messenger));
    }

    // ════════════════════════════════════════════════════════════════════════
    // Admin-setter coverage — revert-path + success-path
    // ════════════════════════════════════════════════════════════════════════

    function testSetRewardMessengerRequiresAdminRole() public {
        vm.prank(alice);
        vm.expectRevert();
        _rep().setRewardMessenger(address(messenger));
    }

    // T-068 removed `testSetLocalEidRequiresAdminRole` — `setLocalEid`
    // no longer exists; a chain's identity is `block.chainid`.

    function testSetBaseChainIdRequiresAdminRole() public {
        vm.prank(alice);
        vm.expectRevert();
        _rep().setBaseChainId(CHAIN_BASE);
    }

    function testSetIsCanonicalRequiresAdminRole() public {
        vm.prank(alice);
        vm.expectRevert();
        _rep().setIsCanonicalRewardChain(true);
    }

    function testSetGraceSecondsRequiresAdminRole() public {
        vm.prank(alice);
        vm.expectRevert();
        _rep().setRewardGraceSeconds(7200);
    }

    function testSetExpectedSourceChainIdsRequiresAdminRole() public {
        _configureCanonical();
        uint32[] memory chainIds = new uint32[](1);
        chainIds[0] = CHAIN_ARB;
        vm.prank(alice);
        vm.expectRevert();
        _agg().setExpectedSourceChainIds(chainIds);
    }

    function testSetExpectedSourceChainIdsRevertsOnMirror() public {
        _configureMirror(CHAIN_ARB);
        uint32[] memory chainIds = new uint32[](1);
        chainIds[0] = CHAIN_ARB;
        vm.expectRevert(NotCanonicalRewardChain.selector);
        _agg().setExpectedSourceChainIds(chainIds);
    }

    function testConfigGetterReturnsDefaultGraceWhenUnset() public {
        _configureCanonical();
        (, , , , uint64 grace) = _rep().getRewardReporterConfig();
        assertEq(grace, 4 hours, "default grace 4h");
    }

    function testConfigGetterReturnsCustomGrace() public {
        _configureCanonical();
        _rep().setRewardGraceSeconds(9999);
        (, , , , uint64 grace) = _rep().getRewardReporterConfig();
        assertEq(grace, 9999, "custom grace echoed");
    }

    function testExpectedSourceChainIdsListReplacement() public {
        _configureCanonical();

        // Sanity: initial list size is 3.
        assertEq(_agg().getExpectedSourceChainIds().length, 3, "initial list");

        uint32[] memory shorter = new uint32[](2);
        shorter[0] = CHAIN_BASE;
        shorter[1] = CHAIN_ARB;
        _agg().setExpectedSourceChainIds(shorter);

        uint32[] memory out = _agg().getExpectedSourceChainIds();
        assertEq(out.length, 2, "list replaced");
        assertEq(out[0], CHAIN_BASE);
        assertEq(out[1], CHAIN_ARB);
    }

    // ════════════════════════════════════════════════════════════════════════
    // closeDay — canonical (Base) branch
    // ════════════════════════════════════════════════════════════════════════

    function testCloseDayCanonicalWritesDirectlyAndEmits() public {
        _configureCanonical();
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(
            block.timestamp
        );

        // Seed a non-zero local total on day 1 via mutator, then warp.
        _mut().setDailyLenderInterest(1, alice, 60e18, 60e18);
        _mut().setDailyBorrowerInterest(1, bob, 40e18, 40e18);
        // Mutator auto-sets knownGlobalSet; roll it back so closeDay is
        // meaningful (it only affects the *aggregator* report, not known-global).
        _mut().setKnownGlobalSet(1, false);

        vm.warp(block.timestamp + 2 days + 1);

        _rep().closeDay(1);

        // Base path writes directly under its own chain id.
        assertTrue(_agg().isChainReported(1, CHAIN_BASE), "base reported");
        (uint256 l, uint256 b) = _agg().getChainReport(1, CHAIN_BASE);
        assertEq(l, 60e18, "lender report");
        assertEq(b, 40e18, "borrower report");
        assertEq(_agg().getChainDailyReportCount(1), 1, "count incremented");
        assertGt(_agg().getDailyFirstReportAt(1), 0, "firstReportAt stamped");

        // No messenger call on canonical path.
        assertEq(messenger.sendCount(), 0, "no LZ send on base");
        // ChainReportSentAt recorded on reporter-local storage.
        assertGt(_rep().getChainReportSentAt(1), 0, "local sentAt stamped");
    }

    function testCloseDayCanonicalRefundsMsgValue() public {
        _configureCanonical();
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(
            block.timestamp
        );
        _mut().setDailyLenderInterest(1, alice, 1e18, 1e18);
        _mut().setKnownGlobalSet(1, false);
        vm.warp(block.timestamp + 2 days + 1);

        uint256 balBefore = alice.balance;
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        _rep().closeDay{value: 0.5 ether}(1);

        // 0.5 ether refunded to alice.
        assertEq(alice.balance, balBefore + 1 ether, "refunded in full");
    }

    function testCloseDayRevertsBeforeDayElapsed() public {
        _configureCanonical();
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(
            block.timestamp
        );
        // today == 0, so day 0 is not elapsed.
        vm.expectRevert(RewardDayNotElapsed.selector);
        _rep().closeDay(0);

        // Advance to day 1; day 1 itself is still accruing.
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectRevert(RewardDayNotElapsed.selector);
        _rep().closeDay(1);
    }

    function testCloseDayRevertsOnDuplicate() public {
        _configureCanonical();
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(
            block.timestamp
        );
        _mut().setDailyLenderInterest(1, alice, 1e18, 1e18);
        _mut().setKnownGlobalSet(1, false);
        vm.warp(block.timestamp + 2 days + 1);

        _rep().closeDay(1);
        vm.expectRevert(ChainDayAlreadyReported.selector);
        _rep().closeDay(1);
    }

    // ════════════════════════════════════════════════════════════════════════
    // closeDay — mirror branch
    // ════════════════════════════════════════════════════════════════════════

    function testCloseDayMirrorForwardsToMessenger() public {
        _configureMirror(CHAIN_ARB);
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(
            block.timestamp
        );
        _mut().setDailyLenderInterest(1, alice, 25e18, 25e18);
        _mut().setDailyBorrowerInterest(1, bob, 15e18, 15e18);
        _mut().setKnownGlobalSet(1, false);
        vm.warp(block.timestamp + 2 days + 1);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        _rep().closeDay{value: 0.3 ether}(1);

        assertEq(messenger.sendCount(), 1, "one LZ send");
        assertEq(messenger.lastSendDay(), 1);
        assertEq(messenger.lastSendLenderNumeraire18(), 25e18);
        assertEq(messenger.lastSendBorrowerNumeraire18(), 15e18);
        assertEq(messenger.lastSendRefund(), alice, "refund beneficiary = caller");
        assertEq(messenger.lastSendValue(), 0.3 ether, "full msg.value forwarded");

        // Mirror path does NOT write to aggregator storage locally.
        assertFalse(_agg().isChainReported(1, CHAIN_ARB));
    }

    function testCloseDayMirrorRevertsWithoutMessenger() public {
        _configureMirror(CHAIN_ARB);
        _rep().setRewardMessenger(address(0));
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(
            block.timestamp
        );
        _mut().setDailyLenderInterest(1, alice, 1e18, 1e18);
        _mut().setKnownGlobalSet(1, false);
        vm.warp(block.timestamp + 2 days + 1);

        vm.expectRevert(RewardMessengerNotSet.selector);
        _rep().closeDay(1);
    }

    function testCloseDayMirrorRevertsWithoutBaseChainId() public {
        _configureMirror(CHAIN_ARB);
        _rep().setBaseChainId(0);
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(
            block.timestamp
        );
        _mut().setDailyLenderInterest(1, alice, 1e18, 1e18);
        _mut().setKnownGlobalSet(1, false);
        vm.warp(block.timestamp + 2 days + 1);

        vm.expectRevert(BaseChainIdNotSet.selector);
        _rep().closeDay(1);
    }

    // ════════════════════════════════════════════════════════════════════════
    // onChainReportReceived — trusted ingress gates
    // ════════════════════════════════════════════════════════════════════════

    function testOnChainReportRevertsWhenNotMessenger() public {
        _configureCanonical();
        vm.prank(alice);
        vm.expectRevert(NotAuthorizedRewardMessenger.selector);
        _agg().onChainReportReceived(CHAIN_ARB, 1, 10e18, 5e18);
    }

    function testOnChainReportRevertsOnNonCanonical() public {
        _configureMirror(CHAIN_ARB);
        // Even the registered messenger cannot deliver reports to a mirror.
        vm.expectRevert(NotCanonicalRewardChain.selector);
        messenger.deliverChainReport(CHAIN_OP, 1, 10e18, 5e18);
    }

    function testOnChainReportRevertsOnUnknownChainId() public {
        _configureCanonical();
        vm.expectRevert(SourceChainIdNotExpected.selector);
        messenger.deliverChainReport(CHAIN_UNKNOWN, 1, 10e18, 5e18);
    }

    function testOnChainReportRevertsOnDuplicate() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_ARB, 1, 10e18, 5e18);
        vm.expectRevert(ChainDayAlreadyReported.selector);
        messenger.deliverChainReport(CHAIN_ARB, 1, 10e18, 5e18);
    }

    function testOnChainReportRevertsAfterFinalization() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_BASE, 1, 10e18, 5e18);
        messenger.deliverChainReport(CHAIN_ARB, 1, 10e18, 5e18);
        messenger.deliverChainReport(CHAIN_OP, 1, 10e18, 5e18);
        _agg().finalizeDay(1);

        vm.expectRevert(ReportAfterFinalization.selector);
        // Even with a fresh chain id (if list grew) the finalized-gate fires first.
        messenger.deliverChainReport(CHAIN_ARB, 1, 1, 1);
    }

    function testOnChainReportStampsFirstReportAt() public {
        _configureCanonical();
        uint64 t0 = uint64(block.timestamp);
        messenger.deliverChainReport(CHAIN_ARB, 1, 10e18, 5e18);
        assertEq(_agg().getDailyFirstReportAt(1), t0, "first stamped");

        // Subsequent reports do not move the stamp.
        vm.warp(block.timestamp + 1 hours);
        messenger.deliverChainReport(CHAIN_OP, 1, 1e18, 1e18);
        assertEq(_agg().getDailyFirstReportAt(1), t0, "first stays");
    }

    // ════════════════════════════════════════════════════════════════════════
    // finalizeDay — coverage path, grace path, revert paths
    // ════════════════════════════════════════════════════════════════════════

    function testFinalizeRevertsOnMirror() public {
        _configureMirror(CHAIN_ARB);
        vm.expectRevert(NotCanonicalRewardChain.selector);
        _agg().finalizeDay(1);
    }

    function testFinalizeRevertsWhenNoReports() public {
        _configureCanonical();
        vm.expectRevert(DayNotReadyToFinalize.selector);
        _agg().finalizeDay(1);
    }

    function testFinalizeRevertsBeforeGraceAndIncompleteCoverage() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_ARB, 1, 10e18, 5e18);
        // Only 1 of 3 expected chainIds reported, grace (4h) not elapsed.
        vm.expectRevert(DayNotReadyToFinalize.selector);
        _agg().finalizeDay(1);
    }

    function testFinalizeWithFullCoverageAtAnyTime() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_BASE, 1, 10e18, 5e18);
        messenger.deliverChainReport(CHAIN_ARB, 1, 20e18, 10e18);
        messenger.deliverChainReport(CHAIN_OP, 1, 30e18, 15e18);

        _agg().finalizeDay(1);
        (bool fin, uint256 gl, uint256 gb) = _agg().getDailyGlobalInterest(1);
        assertTrue(fin, "finalized");
        assertEq(gl, 60e18, "lender sum");
        assertEq(gb, 30e18, "borrower sum");
    }

    function testFinalizeAfterGraceElapsesWithPartialCoverage() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_ARB, 1, 10e18, 5e18);

        vm.warp(block.timestamp + 4 hours + 1);
        _agg().finalizeDay(1);

        (bool fin, uint256 gl, uint256 gb) = _agg().getDailyGlobalInterest(1);
        assertTrue(fin, "finalized after grace");
        assertEq(gl, 10e18, "only reported lender");
        assertEq(gb, 5e18, "only reported borrower");
    }

    function testFinalizeEmitsChainContributionZeroedForMissingChains() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_ARB, 1, 10e18, 5e18);

        vm.warp(block.timestamp + 4 hours + 1);

        // Two chainIds missing: CHAIN_BASE and CHAIN_OP.
        vm.expectEmit(true, true, false, true);
        emit RewardAggregatorFacet.ChainContributionZeroed(
            1,
            CHAIN_BASE,
            /* forced */ false
        );
        vm.expectEmit(true, true, false, true);
        emit RewardAggregatorFacet.ChainContributionZeroed(
            1,
            CHAIN_OP,
            /* forced */ false
        );
        _agg().finalizeDay(1);
    }

    function testFinalizeRevertsOnReplay() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_BASE, 1, 1e18, 1e18);
        messenger.deliverChainReport(CHAIN_ARB, 1, 1e18, 1e18);
        messenger.deliverChainReport(CHAIN_OP, 1, 1e18, 1e18);
        _agg().finalizeDay(1);

        vm.expectRevert(DayAlreadyFinalized.selector);
        _agg().finalizeDay(1);
    }

    function testFinalizeMirrorsIntoKnownGlobalOnBase() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_BASE, 1, 7e18, 3e18);
        messenger.deliverChainReport(CHAIN_ARB, 1, 5e18, 2e18);
        messenger.deliverChainReport(CHAIN_OP, 1, 3e18, 1e18);
        _agg().finalizeDay(1);

        (uint256 gl, uint256 gb, bool isSet) = _rep()
            .getKnownGlobalInterestNumeraire18(1);
        assertTrue(isSet, "knownGlobal mirrored on base");
        assertEq(gl, 15e18);
        assertEq(gb, 6e18);
    }

    // ════════════════════════════════════════════════════════════════════════
    // forceFinalizeDay
    // ════════════════════════════════════════════════════════════════════════

    function testForceFinalizeRequiresAdmin() public {
        _configureCanonical();
        vm.prank(alice);
        vm.expectRevert();
        _agg().forceFinalizeDay(1);
    }

    function testForceFinalizeRevertsOnMirror() public {
        _configureMirror(CHAIN_ARB);
        vm.expectRevert(NotCanonicalRewardChain.selector);
        _agg().forceFinalizeDay(1);
    }

    function testForceFinalizeWorksWithZeroReports() public {
        _configureCanonical();
        _agg().forceFinalizeDay(1);

        (bool fin, uint256 gl, uint256 gb) = _agg().getDailyGlobalInterest(1);
        assertTrue(fin, "force finalized");
        assertEq(gl, 0, "zero lender");
        assertEq(gb, 0, "zero borrower");
    }

    function testForceFinalizeEmitsDayForceFinalizedAndZeroedWithForcedFlag()
        public
    {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_ARB, 1, 2e18, 1e18);

        // Missing chainIds (BASE, OP) emit ChainContributionZeroed with forced=true.
        vm.expectEmit(true, true, false, true);
        emit RewardAggregatorFacet.ChainContributionZeroed(1, CHAIN_BASE, true);
        vm.expectEmit(true, true, false, true);
        emit RewardAggregatorFacet.ChainContributionZeroed(1, CHAIN_OP, true);
        // Plus DayForceFinalized at the end.
        vm.expectEmit(true, false, false, true);
        emit RewardAggregatorFacet.DayForceFinalized(
            1,
            2e18,
            1e18,
            /* participating */ 1,
            /* missing */ 2
        );
        _agg().forceFinalizeDay(1);
    }

    function testForceFinalizeRevertsOnReplay() public {
        _configureCanonical();
        _agg().forceFinalizeDay(1);
        vm.expectRevert(DayAlreadyFinalized.selector);
        _agg().forceFinalizeDay(1);
    }

    // ════════════════════════════════════════════════════════════════════════
    // broadcastGlobal
    // ════════════════════════════════════════════════════════════════════════

    function testBroadcastRevertsBeforeFinalization() public {
        _configureCanonical();
        vm.expectRevert(DayNotReadyToFinalize.selector);
        _agg().broadcastGlobal(1);
    }

    function testBroadcastRevertsOnMirror() public {
        _configureMirror(CHAIN_ARB);
        vm.expectRevert(NotCanonicalRewardChain.selector);
        _agg().broadcastGlobal(1);
    }

    function testBroadcastRevertsWithoutMessenger() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_BASE, 1, 1e18, 1e18);
        vm.warp(block.timestamp + 4 hours + 1);
        _agg().finalizeDay(1);
        _rep().setRewardMessenger(address(0));

        vm.expectRevert(RewardMessengerNotSet.selector);
        _agg().broadcastGlobal(1);
    }

    function testBroadcastForwardsFinalizedPairToMessenger() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_BASE, 1, 7e18, 3e18);
        messenger.deliverChainReport(CHAIN_ARB, 1, 5e18, 2e18);
        messenger.deliverChainReport(CHAIN_OP, 1, 3e18, 1e18);
        _agg().finalizeDay(1);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        _agg().broadcastGlobal{value: 0.2 ether}(1);

        assertEq(messenger.broadcastCount(), 1, "one broadcast");
        assertEq(messenger.lastBroadcastDay(), 1);
        assertEq(messenger.lastBroadcastLenderNumeraire18(), 15e18);
        assertEq(messenger.lastBroadcastBorrowerNumeraire18(), 6e18);
        assertEq(messenger.lastBroadcastRefund(), alice);
        assertEq(messenger.lastBroadcastValue(), 0.2 ether);
    }

    function testBroadcastIsRetryFriendly() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_BASE, 1, 7e18, 3e18);
        messenger.deliverChainReport(CHAIN_ARB, 1, 5e18, 2e18);
        messenger.deliverChainReport(CHAIN_OP, 1, 3e18, 1e18);
        _agg().finalizeDay(1);

        _agg().broadcastGlobal(1);
        _agg().broadcastGlobal(1);
        _agg().broadcastGlobal(1);
        assertEq(messenger.broadcastCount(), 3, "three retries allowed");
    }

    // ════════════════════════════════════════════════════════════════════════
    // onRewardBroadcastReceived — mirror-side ingress
    // ════════════════════════════════════════════════════════════════════════

    function testBroadcastReceivedRevertsWhenNotMessenger() public {
        _configureMirror(CHAIN_ARB);
        vm.prank(alice);
        vm.expectRevert(NotAuthorizedRewardMessenger.selector);
        _rep().onRewardBroadcastReceived(1, 10e18, 5e18, type(uint256).max);
    }

    function testBroadcastReceivedRevertsWhenMessengerUnset() public {
        _configureMirror(CHAIN_ARB);
        _rep().setRewardMessenger(address(0));
        vm.expectRevert(NotAuthorizedRewardMessenger.selector);
        messenger.deliverBroadcast(1, 10e18, 5e18, type(uint256).max);
    }

    function testBroadcastReceivedSetsKnownGlobalAndEmits() public {
        _configureMirror(CHAIN_ARB);

        vm.expectEmit(true, false, false, true);
        emit RewardReporterFacet.KnownGlobalInterestSet(1, 10e18, 5e18);
        messenger.deliverBroadcast(1, 10e18, 5e18, type(uint256).max);

        (uint256 gl, uint256 gb, bool isSet) = _rep()
            .getKnownGlobalInterestNumeraire18(1);
        assertTrue(isSet);
        assertEq(gl, 10e18);
        assertEq(gb, 5e18);
    }

    function testBroadcastReceivedIdempotentOnMatchingReplay() public {
        _configureMirror(CHAIN_ARB);
        messenger.deliverBroadcast(1, 10e18, 5e18, type(uint256).max);
        // Identical values — must succeed silently (no revert).
        messenger.deliverBroadcast(1, 10e18, 5e18, type(uint256).max);
    }

    function testBroadcastReceivedRevertsOnDivergentReplay() public {
        _configureMirror(CHAIN_ARB);
        messenger.deliverBroadcast(1, 10e18, 5e18, type(uint256).max);
        vm.expectRevert(KnownGlobalAlreadySet.selector);
        messenger.deliverBroadcast(1, 99e18, 5e18, type(uint256).max);
    }

    /// #1008 (S13, Codex #1147 r7 K6) — a replay with matching globals but a
    /// DIVERGENT cap threshold must also revert (the threshold is part of the
    /// broadcast consensus value).
    function testBroadcastReceivedRevertsOnDivergentCapThreshold() public {
        _configureMirror(CHAIN_ARB);
        messenger.deliverBroadcast(1, 10e18, 5e18, 1_000e18);
        vm.expectRevert(KnownGlobalAlreadySet.selector);
        messenger.deliverBroadcast(1, 10e18, 5e18, 2_000e18);
    }

    // ════════════════════════════════════════════════════════════════════════
    // isDayReadyToFinalize — view status codes
    // ════════════════════════════════════════════════════════════════════════

    function testIsDayReadyReturnsTwoWhenNoReports() public {
        _configureCanonical();
        (bool ready, uint8 reason) = _agg().isDayReadyToFinalize(1);
        assertFalse(ready);
        assertEq(reason, 2, "reason=no reports");
    }

    function testIsDayReadyReturnsThreeDuringGrace() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_ARB, 1, 1e18, 1e18);
        (bool ready, uint8 reason) = _agg().isDayReadyToFinalize(1);
        assertFalse(ready);
        assertEq(reason, 3, "reason=waiting");
    }

    function testIsDayReadyReturnsReadyOnCoverage() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_BASE, 1, 1e18, 1e18);
        messenger.deliverChainReport(CHAIN_ARB, 1, 1e18, 1e18);
        messenger.deliverChainReport(CHAIN_OP, 1, 1e18, 1e18);
        (bool ready, uint8 reason) = _agg().isDayReadyToFinalize(1);
        assertTrue(ready);
        assertEq(reason, 0);
    }

    function testIsDayReadyReturnsReadyAfterGraceEvenPartial() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_ARB, 1, 1e18, 1e18);
        vm.warp(block.timestamp + 4 hours + 1);
        (bool ready, uint8 reason) = _agg().isDayReadyToFinalize(1);
        assertTrue(ready);
        assertEq(reason, 0);
    }

    function testIsDayReadyReturnsOneWhenFinalized() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_BASE, 1, 1e18, 1e18);
        messenger.deliverChainReport(CHAIN_ARB, 1, 1e18, 1e18);
        messenger.deliverChainReport(CHAIN_OP, 1, 1e18, 1e18);
        _agg().finalizeDay(1);
        (bool ready, uint8 reason) = _agg().isDayReadyToFinalize(1);
        assertFalse(ready);
        assertEq(reason, 1);
    }

    // ════════════════════════════════════════════════════════════════════════
    // Pause gating
    // ════════════════════════════════════════════════════════════════════════

    function testCloseDayPauseGated() public {
        _configureCanonical();
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(
            block.timestamp
        );
        _mut().setDailyLenderInterest(1, alice, 1e18, 1e18);
        _mut().setKnownGlobalSet(1, false);
        vm.warp(block.timestamp + 2 days + 1);

        AdminFacet(address(diamond)).pause();
        vm.expectRevert();
        _rep().closeDay(1);
    }

    function testFinalizePauseGated() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_BASE, 1, 1e18, 1e18);
        messenger.deliverChainReport(CHAIN_ARB, 1, 1e18, 1e18);
        messenger.deliverChainReport(CHAIN_OP, 1, 1e18, 1e18);

        AdminFacet(address(diamond)).pause();
        vm.expectRevert();
        _agg().finalizeDay(1);
    }

    function testBroadcastPauseGated() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_BASE, 1, 1e18, 1e18);
        messenger.deliverChainReport(CHAIN_ARB, 1, 1e18, 1e18);
        messenger.deliverChainReport(CHAIN_OP, 1, 1e18, 1e18);
        _agg().finalizeDay(1);

        AdminFacet(address(diamond)).pause();
        vm.expectRevert();
        _agg().broadcastGlobal(1);
    }

    function testOnChainReportIngressNotPauseGated() public {
        // By design: LZ ingress never pause-gates, so in-flight messages
        // don't fail-and-retry forever during an incident pause. See
        // docs/ops/AdminKeysAndPause.md.
        _configureCanonical();
        AdminFacet(address(diamond)).pause();
        messenger.deliverChainReport(CHAIN_ARB, 1, 1e18, 1e18); // succeeds
        assertTrue(_agg().isChainReported(1, CHAIN_ARB));
    }

    function testOnRewardBroadcastIngressNotPauseGated() public {
        _configureMirror(CHAIN_ARB);
        AdminFacet(address(diamond)).pause();
        messenger.deliverBroadcast(1, 10e18, 5e18, type(uint256).max); // succeeds
        (, , bool isSet) = _rep().getKnownGlobalInterestNumeraire18(1);
        assertTrue(isSet);
    }

    // ════════════════════════════════════════════════════════════════════════
    // Messenger rotation mid-lifecycle
    // ════════════════════════════════════════════════════════════════════════

    function testOldMessengerRejectedAfterRotation() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_ARB, 1, 1e18, 1e18);

        MockRewardMessenger newMessenger = new MockRewardMessenger(address(diamond));
        _rep().setRewardMessenger(address(newMessenger));

        // Old mock can no longer deliver.
        vm.expectRevert(NotAuthorizedRewardMessenger.selector);
        messenger.deliverChainReport(CHAIN_OP, 1, 1e18, 1e18);

        // New one can.
        newMessenger.deliverChainReport(CHAIN_OP, 1, 1e18, 1e18);
        assertTrue(_agg().isChainReported(1, CHAIN_OP));
    }

    // ════════════════════════════════════════════════════════════════════════
    // Full cross-chain lifecycle (simulated via one Diamond + mock messenger)
    // ════════════════════════════════════════════════════════════════════════

    function testCrossChainEndToEndClaimPath() public {
        // Test as canonical: Base owns its own closeDay + finalization, and
        // the MockRewardMessenger stand-in delivers Arb/OP reports into Base and
        // then broadcasts back into this same Diamond's mirror-side ingress
        // for symmetry (we pretend Base is also a mirror for itself, just
        // for the broadcast-land assertion).
        _configureCanonical();
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(
            block.timestamp
        );

        _mut().setDailyLenderInterest(1, alice, 40e18, 40e18); // base local
        _mut().setKnownGlobalSet(1, false); // roll back mutator auto-finalize

        vm.warp(block.timestamp + 2 days + 1);

        // 1. Base's own closeDay writes directly.
        _rep().closeDay(1);

        // 2. Other chains deliver via messenger.
        messenger.deliverChainReport(CHAIN_ARB, 1, 20e18, 0);
        messenger.deliverChainReport(CHAIN_OP, 1, 10e18, 0);

        // 3. Finalize.
        _agg().finalizeDay(1);
        (bool fin, uint256 gl, uint256 gb) = _agg().getDailyGlobalInterest(1);
        assertTrue(fin);
        assertEq(gl, 70e18, "base40 + arb20 + op10");
        assertEq(gb, 0);

        // 4. knownGlobal already mirrored on Base (finalize write-through).
        //    The §4a claim gate (`knownGlobalSet[day] == true`) is now open
        //    with a denominator of 70e18 — alice's 40e18 = 4/7 share of the
        //    lender half-pool. The actual VPFI mint path is covered by
        //    InteractionRewardsFacet tests; this test proves the mesh
        //    delivered consistent state into the gate.
        (uint256 kgLender, uint256 kgBorrower, bool kgSet) = _rep()
            .getKnownGlobalInterestNumeraire18(1);
        assertTrue(kgSet, "known global must be set for claim gate");
        assertEq(kgLender, 70e18, "lender denominator visible to claimants");
        assertEq(kgBorrower, 0);

        // 5. Broadcast would ship the pair to every peer (here: counted only).
        _agg().broadcastGlobal(1);
        assertEq(messenger.broadcastCount(), 1);
        assertEq(messenger.lastBroadcastLenderNumeraire18(), 70e18);
    }
}
