// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";

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
    RewardReporterFacet internal reporter;
    RewardAggregatorFacet internal aggregator;
    InteractionRewardsFacet internal interaction;
    MockRewardMessenger internal oApp;

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

        // Cut in reward plumbing + InteractionRewards (plus mutator already).
        reporter = new RewardReporterFacet();
        aggregator = new RewardAggregatorFacet();
        interaction = new InteractionRewardsFacet();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](3);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(reporter),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getRewardReporterFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(aggregator),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getRewardAggregatorFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(interaction),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getInteractionRewardsFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        oApp = new MockRewardMessenger(address(diamond));

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
        _rep().setRewardOApp(address(oApp));
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
        _rep().setRewardOApp(address(oApp));
    }

    // ════════════════════════════════════════════════════════════════════════
    // Admin-setter coverage — revert-path + success-path
    // ════════════════════════════════════════════════════════════════════════

    function testSetRewardOAppRequiresAdminRole() public {
        vm.prank(alice);
        vm.expectRevert();
        _rep().setRewardOApp(address(oApp));
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

        // No OApp call on canonical path.
        assertEq(oApp.sendCount(), 0, "no LZ send on base");
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

    function testCloseDayMirrorForwardsToOApp() public {
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

        assertEq(oApp.sendCount(), 1, "one LZ send");
        assertEq(oApp.lastSendDay(), 1);
        assertEq(oApp.lastSendLenderNumeraire18(), 25e18);
        assertEq(oApp.lastSendBorrowerNumeraire18(), 15e18);
        assertEq(oApp.lastSendRefund(), alice, "refund beneficiary = caller");
        assertEq(oApp.lastSendValue(), 0.3 ether, "full msg.value forwarded");

        // Mirror path does NOT write to aggregator storage locally.
        assertFalse(_agg().isChainReported(1, CHAIN_ARB));
    }

    function testCloseDayMirrorRevertsWithoutOApp() public {
        _configureMirror(CHAIN_ARB);
        _rep().setRewardOApp(address(0));
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(
            block.timestamp
        );
        _mut().setDailyLenderInterest(1, alice, 1e18, 1e18);
        _mut().setKnownGlobalSet(1, false);
        vm.warp(block.timestamp + 2 days + 1);

        vm.expectRevert(RewardOAppNotSet.selector);
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

    function testOnChainReportRevertsWhenNotOApp() public {
        _configureCanonical();
        vm.prank(alice);
        vm.expectRevert(NotAuthorizedRewardOApp.selector);
        _agg().onChainReportReceived(CHAIN_ARB, 1, 10e18, 5e18);
    }

    function testOnChainReportRevertsOnNonCanonical() public {
        _configureMirror(CHAIN_ARB);
        // Even the registered OApp cannot deliver reports to a mirror.
        vm.expectRevert(NotCanonicalRewardChain.selector);
        oApp.deliverChainReport(CHAIN_OP, 1, 10e18, 5e18);
    }

    function testOnChainReportRevertsOnUnknownChainId() public {
        _configureCanonical();
        vm.expectRevert(SourceChainIdNotExpected.selector);
        oApp.deliverChainReport(CHAIN_UNKNOWN, 1, 10e18, 5e18);
    }

    function testOnChainReportRevertsOnDuplicate() public {
        _configureCanonical();
        oApp.deliverChainReport(CHAIN_ARB, 1, 10e18, 5e18);
        vm.expectRevert(ChainDayAlreadyReported.selector);
        oApp.deliverChainReport(CHAIN_ARB, 1, 10e18, 5e18);
    }

    function testOnChainReportRevertsAfterFinalization() public {
        _configureCanonical();
        oApp.deliverChainReport(CHAIN_BASE, 1, 10e18, 5e18);
        oApp.deliverChainReport(CHAIN_ARB, 1, 10e18, 5e18);
        oApp.deliverChainReport(CHAIN_OP, 1, 10e18, 5e18);
        _agg().finalizeDay(1);

        vm.expectRevert(ReportAfterFinalization.selector);
        // Even with a fresh chain id (if list grew) the finalized-gate fires first.
        oApp.deliverChainReport(CHAIN_ARB, 1, 1, 1);
    }

    function testOnChainReportStampsFirstReportAt() public {
        _configureCanonical();
        uint64 t0 = uint64(block.timestamp);
        oApp.deliverChainReport(CHAIN_ARB, 1, 10e18, 5e18);
        assertEq(_agg().getDailyFirstReportAt(1), t0, "first stamped");

        // Subsequent reports do not move the stamp.
        vm.warp(block.timestamp + 1 hours);
        oApp.deliverChainReport(CHAIN_OP, 1, 1e18, 1e18);
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
        oApp.deliverChainReport(CHAIN_ARB, 1, 10e18, 5e18);
        // Only 1 of 3 expected chainIds reported, grace (4h) not elapsed.
        vm.expectRevert(DayNotReadyToFinalize.selector);
        _agg().finalizeDay(1);
    }

    function testFinalizeWithFullCoverageAtAnyTime() public {
        _configureCanonical();
        oApp.deliverChainReport(CHAIN_BASE, 1, 10e18, 5e18);
        oApp.deliverChainReport(CHAIN_ARB, 1, 20e18, 10e18);
        oApp.deliverChainReport(CHAIN_OP, 1, 30e18, 15e18);

        _agg().finalizeDay(1);
        (bool fin, uint256 gl, uint256 gb) = _agg().getDailyGlobalInterest(1);
        assertTrue(fin, "finalized");
        assertEq(gl, 60e18, "lender sum");
        assertEq(gb, 30e18, "borrower sum");
    }

    function testFinalizeAfterGraceElapsesWithPartialCoverage() public {
        _configureCanonical();
        oApp.deliverChainReport(CHAIN_ARB, 1, 10e18, 5e18);

        vm.warp(block.timestamp + 4 hours + 1);
        _agg().finalizeDay(1);

        (bool fin, uint256 gl, uint256 gb) = _agg().getDailyGlobalInterest(1);
        assertTrue(fin, "finalized after grace");
        assertEq(gl, 10e18, "only reported lender");
        assertEq(gb, 5e18, "only reported borrower");
    }

    function testFinalizeEmitsChainContributionZeroedForMissingChains() public {
        _configureCanonical();
        oApp.deliverChainReport(CHAIN_ARB, 1, 10e18, 5e18);

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
        oApp.deliverChainReport(CHAIN_BASE, 1, 1e18, 1e18);
        oApp.deliverChainReport(CHAIN_ARB, 1, 1e18, 1e18);
        oApp.deliverChainReport(CHAIN_OP, 1, 1e18, 1e18);
        _agg().finalizeDay(1);

        vm.expectRevert(DayAlreadyFinalized.selector);
        _agg().finalizeDay(1);
    }

    function testFinalizeMirrorsIntoKnownGlobalOnBase() public {
        _configureCanonical();
        oApp.deliverChainReport(CHAIN_BASE, 1, 7e18, 3e18);
        oApp.deliverChainReport(CHAIN_ARB, 1, 5e18, 2e18);
        oApp.deliverChainReport(CHAIN_OP, 1, 3e18, 1e18);
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
        oApp.deliverChainReport(CHAIN_ARB, 1, 2e18, 1e18);

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

    function testBroadcastRevertsWithoutOApp() public {
        _configureCanonical();
        oApp.deliverChainReport(CHAIN_BASE, 1, 1e18, 1e18);
        vm.warp(block.timestamp + 4 hours + 1);
        _agg().finalizeDay(1);
        _rep().setRewardOApp(address(0));

        vm.expectRevert(RewardOAppNotSet.selector);
        _agg().broadcastGlobal(1);
    }

    function testBroadcastForwardsFinalizedPairToOApp() public {
        _configureCanonical();
        oApp.deliverChainReport(CHAIN_BASE, 1, 7e18, 3e18);
        oApp.deliverChainReport(CHAIN_ARB, 1, 5e18, 2e18);
        oApp.deliverChainReport(CHAIN_OP, 1, 3e18, 1e18);
        _agg().finalizeDay(1);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        _agg().broadcastGlobal{value: 0.2 ether}(1);

        assertEq(oApp.broadcastCount(), 1, "one broadcast");
        assertEq(oApp.lastBroadcastDay(), 1);
        assertEq(oApp.lastBroadcastLenderNumeraire18(), 15e18);
        assertEq(oApp.lastBroadcastBorrowerNumeraire18(), 6e18);
        assertEq(oApp.lastBroadcastRefund(), alice);
        assertEq(oApp.lastBroadcastValue(), 0.2 ether);
    }

    function testBroadcastIsRetryFriendly() public {
        _configureCanonical();
        oApp.deliverChainReport(CHAIN_BASE, 1, 7e18, 3e18);
        oApp.deliverChainReport(CHAIN_ARB, 1, 5e18, 2e18);
        oApp.deliverChainReport(CHAIN_OP, 1, 3e18, 1e18);
        _agg().finalizeDay(1);

        _agg().broadcastGlobal(1);
        _agg().broadcastGlobal(1);
        _agg().broadcastGlobal(1);
        assertEq(oApp.broadcastCount(), 3, "three retries allowed");
    }

    // ════════════════════════════════════════════════════════════════════════
    // onRewardBroadcastReceived — mirror-side ingress
    // ════════════════════════════════════════════════════════════════════════

    function testBroadcastReceivedRevertsWhenNotOApp() public {
        _configureMirror(CHAIN_ARB);
        vm.prank(alice);
        vm.expectRevert(NotAuthorizedRewardOApp.selector);
        _rep().onRewardBroadcastReceived(1, 10e18, 5e18);
    }

    function testBroadcastReceivedRevertsWhenOAppUnset() public {
        _configureMirror(CHAIN_ARB);
        _rep().setRewardOApp(address(0));
        vm.expectRevert(NotAuthorizedRewardOApp.selector);
        oApp.deliverBroadcast(1, 10e18, 5e18);
    }

    function testBroadcastReceivedSetsKnownGlobalAndEmits() public {
        _configureMirror(CHAIN_ARB);

        vm.expectEmit(true, false, false, true);
        emit RewardReporterFacet.KnownGlobalInterestSet(1, 10e18, 5e18);
        oApp.deliverBroadcast(1, 10e18, 5e18);

        (uint256 gl, uint256 gb, bool isSet) = _rep()
            .getKnownGlobalInterestNumeraire18(1);
        assertTrue(isSet);
        assertEq(gl, 10e18);
        assertEq(gb, 5e18);
    }

    function testBroadcastReceivedIdempotentOnMatchingReplay() public {
        _configureMirror(CHAIN_ARB);
        oApp.deliverBroadcast(1, 10e18, 5e18);
        // Identical values — must succeed silently (no revert).
        oApp.deliverBroadcast(1, 10e18, 5e18);
    }

    function testBroadcastReceivedRevertsOnDivergentReplay() public {
        _configureMirror(CHAIN_ARB);
        oApp.deliverBroadcast(1, 10e18, 5e18);
        vm.expectRevert(KnownGlobalAlreadySet.selector);
        oApp.deliverBroadcast(1, 99e18, 5e18);
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
        oApp.deliverChainReport(CHAIN_ARB, 1, 1e18, 1e18);
        (bool ready, uint8 reason) = _agg().isDayReadyToFinalize(1);
        assertFalse(ready);
        assertEq(reason, 3, "reason=waiting");
    }

    function testIsDayReadyReturnsReadyOnCoverage() public {
        _configureCanonical();
        oApp.deliverChainReport(CHAIN_BASE, 1, 1e18, 1e18);
        oApp.deliverChainReport(CHAIN_ARB, 1, 1e18, 1e18);
        oApp.deliverChainReport(CHAIN_OP, 1, 1e18, 1e18);
        (bool ready, uint8 reason) = _agg().isDayReadyToFinalize(1);
        assertTrue(ready);
        assertEq(reason, 0);
    }

    function testIsDayReadyReturnsReadyAfterGraceEvenPartial() public {
        _configureCanonical();
        oApp.deliverChainReport(CHAIN_ARB, 1, 1e18, 1e18);
        vm.warp(block.timestamp + 4 hours + 1);
        (bool ready, uint8 reason) = _agg().isDayReadyToFinalize(1);
        assertTrue(ready);
        assertEq(reason, 0);
    }

    function testIsDayReadyReturnsOneWhenFinalized() public {
        _configureCanonical();
        oApp.deliverChainReport(CHAIN_BASE, 1, 1e18, 1e18);
        oApp.deliverChainReport(CHAIN_ARB, 1, 1e18, 1e18);
        oApp.deliverChainReport(CHAIN_OP, 1, 1e18, 1e18);
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
        oApp.deliverChainReport(CHAIN_BASE, 1, 1e18, 1e18);
        oApp.deliverChainReport(CHAIN_ARB, 1, 1e18, 1e18);
        oApp.deliverChainReport(CHAIN_OP, 1, 1e18, 1e18);

        AdminFacet(address(diamond)).pause();
        vm.expectRevert();
        _agg().finalizeDay(1);
    }

    function testBroadcastPauseGated() public {
        _configureCanonical();
        oApp.deliverChainReport(CHAIN_BASE, 1, 1e18, 1e18);
        oApp.deliverChainReport(CHAIN_ARB, 1, 1e18, 1e18);
        oApp.deliverChainReport(CHAIN_OP, 1, 1e18, 1e18);
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
        oApp.deliverChainReport(CHAIN_ARB, 1, 1e18, 1e18); // succeeds
        assertTrue(_agg().isChainReported(1, CHAIN_ARB));
    }

    function testOnRewardBroadcastIngressNotPauseGated() public {
        _configureMirror(CHAIN_ARB);
        AdminFacet(address(diamond)).pause();
        oApp.deliverBroadcast(1, 10e18, 5e18); // succeeds
        (, , bool isSet) = _rep().getKnownGlobalInterestNumeraire18(1);
        assertTrue(isSet);
    }

    // ════════════════════════════════════════════════════════════════════════
    // OApp rotation mid-lifecycle
    // ════════════════════════════════════════════════════════════════════════

    function testOldOAppRejectedAfterRotation() public {
        _configureCanonical();
        oApp.deliverChainReport(CHAIN_ARB, 1, 1e18, 1e18);

        MockRewardMessenger newOApp = new MockRewardMessenger(address(diamond));
        _rep().setRewardOApp(address(newOApp));

        // Old mock can no longer deliver.
        vm.expectRevert(NotAuthorizedRewardOApp.selector);
        oApp.deliverChainReport(CHAIN_OP, 1, 1e18, 1e18);

        // New one can.
        newOApp.deliverChainReport(CHAIN_OP, 1, 1e18, 1e18);
        assertTrue(_agg().isChainReported(1, CHAIN_OP));
    }

    // ════════════════════════════════════════════════════════════════════════
    // Full cross-chain lifecycle (simulated via one Diamond + mock OApp)
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

        // 2. Other chains deliver via OApp.
        oApp.deliverChainReport(CHAIN_ARB, 1, 20e18, 0);
        oApp.deliverChainReport(CHAIN_OP, 1, 10e18, 0);

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
        assertEq(oApp.broadcastCount(), 1);
        assertEq(oApp.lastBroadcastLenderNumeraire18(), 70e18);
    }
}
