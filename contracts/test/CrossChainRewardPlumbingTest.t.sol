// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";

import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {RewardBroadcastFacet} from "../src/facets/RewardBroadcastFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {RewardBroadcastV2, RewardBroadcastV3, ChainDayReport} from "../src/interfaces/IRewardMessenger.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibRewardDayReport} from "../src/libraries/LibRewardDayReport.sol";

/// @notice A messenger without the one report send (#2621) — what a mirror
///         Diamond meets if its messenger is rotated to an older build between
///         a caller's checks and its `closeDay`. Only an older send surface
///         exists, so the close must revert rather than fall back to it.
contract LegacyOnlyRewardMessenger {
    uint256 public lastSendDay;
    uint256 public lastSendLenderNumeraire18;
    uint256 public lastSendBorrowerNumeraire18;
    address public lastSendRefund;
    uint256 public sendCount;

    function sendChainReport(
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        address payable refundAddress
    ) external payable {
        lastSendDay = dayId;
        lastSendLenderNumeraire18 = lenderNumeraire18;
        lastSendBorrowerNumeraire18 = borrowerNumeraire18;
        lastSendRefund = refundAddress;
        sendCount += 1;
    }

    receive() external payable {}
}

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
///           - `onRewardBroadcastV3Received`, the one broadcast ingress
///             (auth + idempotent replay + divergent-payload revert)
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

    /// #1569 — broadcast moved to its own facet for EIP-170 headroom.
    /// Same Diamond, same selectors; only the cast type changed.
    function _bcast() internal view returns (RewardBroadcastFacet) {
        return RewardBroadcastFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    /// @dev Configure the Diamond as the canonical (Base) reward chain.
    ///      `vm.chainId` makes the Diamond's `block.chainid` the canonical
    ///      id — the reward facets derive chain identity from it directly.
    function _configureCanonical() internal {
        vm.chainId(CHAIN_BASE);
        // A canonical chain runs its reward clock before reports can reach
        // it: Base refuses a report while its own clock is unset (#2620).
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(block.timestamp);
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
        // The broadcast ingress authenticates Base's era (#1944: kind 10 is
        // the only broadcast wire, and it always carries the era word).
        _rep().setBaseRewardDeployment(BASE_ERA);
    }

    /// @dev The Base deployment every mirror in this suite is bound to.
    address internal constant BASE_ERA = address(0xBA5E0E7A);

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
        ChainDayReport memory r;
        r.dayId = 1;
        _agg().onChainReportReceived(CHAIN_ARB, r);
    }

    function testOnChainReportRevertsOnNonCanonical() public {
        _configureMirror(CHAIN_ARB);
        // Even the registered messenger cannot deliver reports to a mirror.
        vm.expectRevert(NotCanonicalRewardChain.selector);
        messenger.deliverChainReport(CHAIN_OP, 1, 10e18, 5e18);
    }

    /// @dev #2618 — an authenticated report from a chain off the expected
    ///      list is stored and announced, not refused: it starts no grace
    ///      window and its day figures count only if the chain is listed when
    ///      the day finalizes.
    function testOffListReportIsStoredNotCounted() public {
        _configureCanonical();
        vm.expectEmit(true, true, false, false, address(diamond));
        emit LibRewardDayReport.ChainReportStoredOffList(CHAIN_UNKNOWN, 1);
        messenger.deliverChainReport(CHAIN_UNKNOWN, 1, 10e18, 5e18);
        assertTrue(_agg().isChainReported(1, CHAIN_UNKNOWN), "stored");
        assertEq(_agg().getDailyFirstReportAt(1), 0, "an off-list report starts no grace window");
        (bool ready, uint8 reason) = _agg().isDayReadyToFinalize(1);
        assertFalse(ready);
        assertEq(reason, 2, "no listed chain has reported");

        messenger.deliverChainReport(CHAIN_BASE, 1, 1e18, 1e18);
        messenger.deliverChainReport(CHAIN_ARB, 1, 2e18, 2e18);
        messenger.deliverChainReport(CHAIN_OP, 1, 3e18, 3e18);
        _agg().finalizeDay(1);
        (, uint256 lender, uint256 borrower) = _agg().getDailyGlobalInterest(1);
        assertEq(lender, 6e18, "only the listed chains are summed");
        assertEq(borrower, 6e18);
    }

    /// @dev #2618 — a chain taken off the list by mistake and listed again
    ///      before the day finalizes counts, with no re-execution of anything.
    function testOffListReportCountsOnceRelistedBeforeFinalization() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_UNKNOWN, 1, 10e18, 5e18);
        uint32[] memory chainIds = new uint32[](2);
        chainIds[0] = CHAIN_BASE;
        chainIds[1] = CHAIN_UNKNOWN;
        _agg().setExpectedSourceChainIds(chainIds);
        messenger.deliverChainReport(CHAIN_BASE, 1, 1e18, 1e18);
        (bool ready, ) = _agg().isDayReadyToFinalize(1);
        assertTrue(ready, "every listed chain has reported");
        _agg().finalizeDay(1);
        (, uint256 lender, ) = _agg().getDailyGlobalInterest(1);
        assertEq(lender, 11e18, "the relisted chain's stored figures count");
    }

    /// @dev #2645 — an off-list report's recycled DAY credit is a day figure
    ///      too: its cumulative applies on arrival, but the day credit is
    ///      attributed only when the day finalizes counting the chain. So a
    ///      chain the day did not count never sizes the day's recycled budget.
    function testOffListRecycledDayCreditIsNotAttributed() public {
        _configureCanonical();
        messenger.deliverChainReportRecycled(CHAIN_UNKNOWN, 1, 10e18, 5e18, 100e18, 40e18);
        (uint256 reported, , , uint256 attributed) = _agg().getChainRecycledLedger(CHAIN_UNKNOWN);
        assertEq(reported, 100e18, "the chain-wide cumulative applies on arrival");
        assertEq(attributed, 0, "the day credit waits for the finalization");
        _agg().forceFinalizeDay(1);
        (uint256 credit, bool accepted) = _agg().getChainDailyRecycledCredit(1, CHAIN_UNKNOWN);
        assertFalse(accepted, "the day did not count the chain");
        assertEq(credit, 0);
        (, , , attributed) = _agg().getChainRecycledLedger(CHAIN_UNKNOWN);
        assertEq(attributed, 0, "and its credit stays in its headroom");
        (, , , , , uint256 absorbedMirror) = InteractionRewardsLensFacet(address(diamond)).getRecycleDayMetrics(1);
        assertEq(absorbedMirror, 0, "nothing reaches the day's absorption");
    }

    /// @dev #2645 — relisted before the day finalizes, the same report's day
    ///      credit is attributed at the finalization that counts it.
    function testRelistedRecycledDayCreditIsAttributedAtFinalization() public {
        _configureCanonical();
        messenger.deliverChainReportRecycled(CHAIN_UNKNOWN, 1, 10e18, 5e18, 100e18, 40e18);
        uint32[] memory chainIds = new uint32[](2);
        chainIds[0] = CHAIN_BASE;
        chainIds[1] = CHAIN_UNKNOWN;
        _agg().setExpectedSourceChainIds(chainIds);
        messenger.deliverChainReport(CHAIN_BASE, 1, 1e18, 1e18);
        _agg().finalizeDay(1);
        (uint256 credit, bool accepted) = _agg().getChainDailyRecycledCredit(1, CHAIN_UNKNOWN);
        assertTrue(accepted);
        assertEq(credit, 40e18, "attributed when the day counted the chain");
        (, , , , , uint256 absorbedMirror) = InteractionRewardsLensFacet(address(diamond)).getRecycleDayMetrics(1);
        assertEq(absorbedMirror, 40e18);
    }

    /// @dev #2613 — coverage is judged chain by chain: an off-list report does
    ///      not stand in for a listed chain that has not reported.
    function testOffListReportDoesNotCompleteCoverage() public {
        _configureCanonical();
        uint32[] memory chainIds = new uint32[](2);
        chainIds[0] = CHAIN_BASE;
        chainIds[1] = CHAIN_ARB;
        _agg().setExpectedSourceChainIds(chainIds);
        messenger.deliverChainReport(CHAIN_BASE, 1, 1e18, 1e18);
        messenger.deliverChainReport(CHAIN_OP, 1, 1e18, 1e18); // off the list
        assertEq(_agg().getChainDailyReportCount(1), 2, "two reports received");
        (bool ready, uint8 reason) = _agg().isDayReadyToFinalize(1);
        assertFalse(ready, "Arbitrum, which is listed, has not reported");
        assertEq(reason, 3);
        vm.expectRevert(DayNotReadyToFinalize.selector);
        _agg().finalizeDay(1);
    }

    /// @dev #2621 — the setter refuses a list that is empty or leaves Base
    ///      out, so neither can be stored from here on.
    function testSetExpectedSourceChainIdsRefusesAListWithoutBase() public {
        _configureCanonical();
        uint32[] memory chainIds = new uint32[](1);
        chainIds[0] = CHAIN_ARB;
        vm.expectRevert(ExpectedSourceListUnusable.selector);
        _agg().setExpectedSourceChainIds(chainIds);
        vm.expectRevert(ExpectedSourceListUnusable.selector);
        _agg().setExpectedSourceChainIds(new uint32[](0));
        assertEq(_agg().getExpectedSourceChainIds().length, 3, "the stored list is unchanged");
    }

    /// @dev #2613 — no permissionless finalization against a list that is
    ///      empty or leaves Base out (one stored before the setter refused
    ///      them); the admin override is not refused.
    function testFinalizeRefusesAListWithoutBase() public {
        _configureCanonical();
        uint32[] memory chainIds = new uint32[](1);
        chainIds[0] = CHAIN_ARB;
        _mut().setExpectedSourceChainIdsRaw(chainIds);
        messenger.deliverChainReport(CHAIN_ARB, 1, 1e18, 1e18);
        (bool ready, uint8 reason) = _agg().isDayReadyToFinalize(1);
        assertFalse(ready);
        assertEq(reason, 4, "the list leaves Base out");
        vm.expectRevert(ExpectedSourceListUnusable.selector);
        _agg().finalizeDay(1);
        vm.warp(block.timestamp + 4 hours + 1);
        vm.expectRevert(ExpectedSourceListUnusable.selector);
        _agg().finalizeDay(1);

        _mut().setExpectedSourceChainIdsRaw(new uint32[](0));
        (, reason) = _agg().isDayReadyToFinalize(1);
        assertEq(reason, 4, "an empty list");

        _agg().forceFinalizeDay(1);
        (bool finalized, , ) = _agg().getDailyGlobalInterest(1);
        assertTrue(finalized, "the admin override still closes the day");
    }

    /// @dev #2619 / #2626 — the finalization records what it counted: which
    ///      listed chains were zeroed, and which reports were included. A
    ///      later list edit does not change either, and a report from a chain
    ///      off the list at finalization lands without being included.
    function testFinalizationRecordsZeroedChainsAndInclusion() public {
        _configureCanonical();
        uint32[] memory chainIds = new uint32[](2);
        chainIds[0] = CHAIN_BASE;
        chainIds[1] = CHAIN_ARB;
        _agg().setExpectedSourceChainIds(chainIds);
        messenger.deliverChainReport(CHAIN_BASE, 1, 1e18, 1e18);
        messenger.deliverChainReport(CHAIN_OP, 1, 7e18, 7e18); // off the list

        (bool recorded, uint32[] memory zeroed) = _agg().getDayZeroedChains(1);
        assertFalse(recorded, "nothing recorded before finalization");
        assertEq(zeroed.length, 0);
        assertFalse(_agg().isChainIncluded(1, CHAIN_BASE), "nothing included before finalization");

        vm.warp(block.timestamp + 4 hours + 1);
        _agg().finalizeDay(1);

        (recorded, zeroed) = _agg().getDayZeroedChains(1);
        assertTrue(recorded, "the finalization wrote its record");
        assertEq(zeroed.length, 1, "one listed chain missed the day");
        assertEq(zeroed[0], CHAIN_ARB);
        assertTrue(_agg().isChainIncluded(1, CHAIN_BASE), "Base counted");
        assertFalse(_agg().isChainIncluded(1, CHAIN_ARB), "the zeroed chain is not included");
        assertTrue(_agg().isChainReported(1, CHAIN_OP), "the off-list report landed");
        assertFalse(_agg().isChainIncluded(1, CHAIN_OP), "and was not counted");

        // A later list edit leaves the day's record as it was.
        uint32[] memory wider = new uint32[](3);
        wider[0] = CHAIN_BASE;
        wider[1] = CHAIN_ARB;
        wider[2] = CHAIN_OP;
        _agg().setExpectedSourceChainIds(wider);
        (recorded, zeroed) = _agg().getDayZeroedChains(1);
        assertTrue(recorded);
        assertEq(zeroed.length, 1, "the record does not follow the list");
        assertEq(zeroed[0], CHAIN_ARB);
        assertFalse(_agg().isChainIncluded(1, CHAIN_OP), "nor does inclusion");
    }

    /// @dev #2645 r2 — a day every listed chain reported is RECORDED with an
    ///      empty zeroed set, so a reader can tell it from a day finalized by a
    ///      Diamond that kept no record.
    function testFullyReportedDayIsRecordedWithNoZeroedChains() public {
        _configureCanonical();
        uint32[] memory chainIds = new uint32[](2);
        chainIds[0] = CHAIN_BASE;
        chainIds[1] = CHAIN_ARB;
        _agg().setExpectedSourceChainIds(chainIds);
        messenger.deliverChainReport(CHAIN_BASE, 1, 1e18, 1e18);
        messenger.deliverChainReport(CHAIN_ARB, 1, 2e18, 2e18);
        _agg().finalizeDay(1);

        (bool recorded, uint32[] memory zeroed) = _agg().getDayZeroedChains(1);
        assertTrue(recorded, "the finalization recorded the day");
        assertEq(zeroed.length, 0, "and zeroed no chain");
    }

    function testOnChainReportRevertsOnDuplicate() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_ARB, 1, 10e18, 5e18);
        vm.expectRevert(ChainDayAlreadyReported.selector);
        messenger.deliverChainReport(CHAIN_ARB, 1, 10e18, 5e18);
    }

    /// @dev #2621 — a mirror report landing after its day is finalized is
    ///      not refused (that would discard its chain-wide figures too): it
    ///      is announced as late, and changes none of the finalized day.
    function testOnChainReportAfterFinalizationLeavesTheDayAlone() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_BASE, 1, 10e18, 5e18);
        messenger.deliverChainReport(CHAIN_ARB, 1, 10e18, 5e18);
        messenger.deliverChainReport(CHAIN_OP, 1, 10e18, 5e18);
        _agg().finalizeDay(1);
        uint256 countBefore = _agg().getChainDailyReportCount(1);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit RewardAggregatorFacet.ChainReportArrivedAfterFinalization(CHAIN_ARB, 1, 0);
        messenger.deliverChainReport(CHAIN_ARB, 1, 1, 1);
        assertEq(_agg().getChainDailyReportCount(1), countBefore, "the finalized day takes no late report");
    }

    /// @dev #1195 E3 (Pass-2) — the BASE-path self-report (`closeDay`) now also
    ///      rejects a report AFTER the day was finalized, matching the mirror
    ///      ingress guard. Finalize day 1, advance past it, then `closeDay(1)`
    ///      must revert `ReportAfterFinalization` (not store a poisoning late
    ///      report).
    function testCloseDayRevertsAfterFinalization() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_BASE, 1, 10e18, 5e18);
        messenger.deliverChainReport(CHAIN_ARB, 1, 10e18, 5e18);
        messenger.deliverChainReport(CHAIN_OP, 1, 10e18, 5e18);
        _agg().finalizeDay(1);

        // Advance past day 1 so `closeDay` clears RewardDayNotElapsed; the
        // aggregator ingress didn't set the reporter's chainReportSentAt, so
        // ChainDayAlreadyReported won't preempt — the finalized gate fires.
        vm.warp(block.timestamp + 2 days + 1);
        vm.expectRevert(ReportAfterFinalization.selector);
        _rep().closeDay(1);
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
        _bcast().broadcastGlobal(1);
    }

    function testBroadcastRevertsOnMirror() public {
        _configureMirror(CHAIN_ARB);
        vm.expectRevert(NotCanonicalRewardChain.selector);
        _bcast().broadcastGlobal(1);
    }

    function testBroadcastRevertsWithoutMessenger() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_BASE, 1, 1e18, 1e18);
        vm.warp(block.timestamp + 4 hours + 1);
        _agg().finalizeDay(1);
        _rep().setRewardMessenger(address(0));

        vm.expectRevert(RewardMessengerNotSet.selector);
        _bcast().broadcastGlobal(1);
    }

    /// @dev The trigger assembles the kind-10 per-destination broadcast
    ///      (one entry per configured mirror) with the shared consensus
    ///      fields and the frozen clock facts.
    function testBroadcastForwardsFinalizedPairToMessenger() public {
        _configureCanonical();
        uint256[] memory dests = new uint256[](2);
        dests[0] = CHAIN_ARB;
        dests[1] = CHAIN_OP;
        messenger.setBroadcastDestinations(dests);
        messenger.deliverChainReport(CHAIN_BASE, 1, 7e18, 3e18);
        messenger.deliverChainReport(CHAIN_ARB, 1, 5e18, 2e18);
        messenger.deliverChainReport(CHAIN_OP, 1, 3e18, 1e18);
        _agg().finalizeDay(1);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        _bcast().broadcastGlobal{value: 0.2 ether}(1);

        assertEq(messenger.broadcastV3Count(), 1, "one V3 broadcast");
        (uint256 vDay, uint256 vGL, uint256 vGB, , , , ) =
            messenger.lastV3Shared();
        assertEq(vDay, 1);
        assertEq(vGL, 15e18);
        assertEq(vGB, 6e18);
        assertEq(messenger.lastV3DestsLength(), 2, "one entry per mirror");
        assertEq(messenger.lastBroadcastRefund(), alice);
        assertEq(messenger.lastBroadcastValue(), 0.2 ether);
    }

    /// @dev B2-b (Codex #1417 r1) — the facet-level quote prices the SAME
    ///      per-destination payloads the send will dispatch (the mock prices
    ///      the batch per lane with a x3 marker, the single lane flat, so the
    ///      value proves which messenger surface ran).
    function testQuoteBroadcastGlobalPricesThePerDestinationPayloads()
        public
    {
        _configureCanonical();
        uint256[] memory dests = new uint256[](2);
        dests[0] = CHAIN_ARB;
        dests[1] = CHAIN_OP;
        messenger.setBroadcastDestinations(dests);
        messenger.setQuoteNative(0.05 ether);
        messenger.deliverChainReport(CHAIN_BASE, 1, 7e18, 3e18);
        messenger.deliverChainReport(CHAIN_ARB, 1, 5e18, 2e18);
        messenger.deliverChainReport(CHAIN_OP, 1, 3e18, 1e18);
        _agg().finalizeDay(1);

        assertEq(
            _bcast().quoteBroadcastGlobal(1),
            0.3 ether,
            "batch quote: one lane per destination, x3 marker"
        );
    }

    /// @dev A messenger revert bubbles unchanged: there is no older wire
    ///      to fall back to (#1944).
    function testBroadcastMessengerRevertBubbles() public {
        _configureCanonical();
        messenger.setRevertOnBroadcast(true);
        messenger.deliverChainReport(CHAIN_BASE, 1, 7e18, 3e18);
        messenger.deliverChainReport(CHAIN_ARB, 1, 5e18, 2e18);
        messenger.deliverChainReport(CHAIN_OP, 1, 3e18, 1e18);
        _agg().finalizeDay(1);

        vm.expectRevert(bytes("MockMessenger: broadcast revert"));
        _bcast().broadcastGlobal(1);
        assertEq(messenger.broadcastV3Count(), 0, "nothing sent");
    }

    function testBroadcastIsRetryFriendly() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_BASE, 1, 7e18, 3e18);
        messenger.deliverChainReport(CHAIN_ARB, 1, 5e18, 2e18);
        messenger.deliverChainReport(CHAIN_OP, 1, 3e18, 1e18);
        _agg().finalizeDay(1);

        _bcast().broadcastGlobal(1);
        _bcast().broadcastGlobal(1);
        _bcast().broadcastGlobal(1);
        assertEq(messenger.broadcastV3Count(), 3, "three retries allowed");
    }

    // ════════════════════════════════════════════════════════════════════════
    // onRewardBroadcastV3Received — the mirror-side broadcast ingress
    // ════════════════════════════════════════════════════════════════════════

    function testBroadcastReceivedRevertsWhenNotMessenger() public {
        _configureMirror(CHAIN_ARB);
        vm.prank(alice);
        vm.expectRevert(NotAuthorizedRewardMessenger.selector);
        RewardBroadcastV3 memory b;
        _rep().onRewardBroadcastV3Received(b);
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
        _bcast().broadcastGlobal(1);
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

        // 5. Broadcast would ship the pair to every peer (here: counted
        //    only — #1434 P2-w1 sends the kind-10 per-destination shape).
        _bcast().broadcastGlobal(1);
        assertEq(messenger.broadcastV3Count(), 1);
        (, uint256 vGL, , , , , ) = messenger.lastV3Shared();
        assertEq(vGL, 70e18);
    }

    // ════════════════════════════════════════════════════════════════════════
    // #1222 M3 B1 — per-chain recycled ledger (availability + Ā attribution)
    // ════════════════════════════════════════════════════════════════════════

    function _cfg() internal view returns (ConfigFacet) {
        return ConfigFacet(address(diamond));
    }

    /// The aggregate consistency clamp (Codex #1413 r2 form): a day's
    /// accepted credit never exceeds `reported − attributed`, so total
    /// attributed credit can never exceed the availability the chain
    /// reported.
    function testRecycledLedgerClampBoundsAttributionByReported() public {
        _configureCanonical();

        // Day 1 — honest report: forDay 40 backed by a 100 cumulative.
        messenger.deliverChainReportRecycled(CHAIN_ARB, 1, 1e18, 0, 100e18, 40e18);
        _agg().forceFinalizeDay(1); // #2645 — attribution happens at finalization
        (uint256 reported, , uint256 avail, uint256 attributed) =
            _agg().getChainRecycledLedger(CHAIN_ARB);
        assertEq(reported, 100e18, "availability cumulative");
        assertEq(avail, 100e18, "nothing consumed yet");
        assertEq(attributed, 40e18, "honest for-day accepted in full");
        (uint256 credit, bool accepted) =
            _agg().getChainDailyRecycledCredit(1, CHAIN_ARB);
        assertTrue(accepted);
        assertEq(credit, 40e18);

        // Day 2 — over-claimed: forDay 120 but only 110 of unattributed
        // backing exists (150 reported − 40 attributed) → clamped, so Ā can
        // never be fed credit the availability ledger does not back.
        messenger.deliverChainReportRecycled(CHAIN_ARB, 2, 1e18, 0, 150e18, 120e18);
        _agg().forceFinalizeDay(2); // #2645 — attribution happens at finalization
        (credit, accepted) = _agg().getChainDailyRecycledCredit(2, CHAIN_ARB);
        assertTrue(accepted);
        assertEq(credit, 110e18, "day credit clamped to unattributed backing");
        (reported, , , attributed) = _agg().getChainRecycledLedger(CHAIN_ARB);
        assertEq(reported, 150e18);
        assertEq(attributed, 150e18, "attributed never exceeds reported");
    }

    /// A stale (smaller) cumulative can never walk the availability ledger
    /// backwards, and headroom is measured against the RATCHETED total —
    /// never against the buggy lower value.
    function testRecycledLedgerCumulativeNeverRegresses() public {
        _configureCanonical();

        messenger.deliverChainReportRecycled(CHAIN_ARB, 1, 1e18, 0, 100e18, 10e18);

        _agg().forceFinalizeDay(1); // #2645 — attribution happens at finalization
        // A buggy mirror reports a DECREASED cumulative for day 2; its
        // honest 10 for-day still fits the ratcheted backing.
        messenger.deliverChainReportRecycled(CHAIN_ARB, 2, 1e18, 0, 80e18, 10e18);
        _agg().forceFinalizeDay(2); // #2645 — attribution happens at finalization

        (uint256 reported, , , uint256 attributed) =
            _agg().getChainRecycledLedger(CHAIN_ARB);
        assertEq(reported, 100e18, "availability never regresses");
        assertEq(attributed, 20e18, "backed day credit still attributes");

        // Day 3 heals the cumulative; its full for-day is backed.
        messenger.deliverChainReportRecycled(CHAIN_ARB, 3, 1e18, 0, 130e18, 50e18);
        _agg().forceFinalizeDay(3); // #2645 — attribution happens at finalization
        (uint256 credit, ) = _agg().getChainDailyRecycledCredit(3, CHAIN_ARB);
        assertEq(credit, 50e18, "headroom measured from the ratcheted total");
        (reported, , , attributed) = _agg().getChainRecycledLedger(CHAIN_ARB);
        assertEq(reported, 130e18);
        assertEq(attributed, 70e18);
    }

    /// The M3-plan-mandated DELAYED-DAY case: day D's report arriving after
    /// a later day was accepted still gets its exact credit — the baseline
    /// advances only by accepted credit, so D's unclaimed delta is still in
    /// the headroom regardless of delivery order.
    function testRecycledLedgerDelayedEarlierDayGetsExactCredit() public {
        _configureCanonical();

        // Day 1 in order; day 2's CCIP delivery is delayed; day 3 lands.
        messenger.deliverChainReportRecycled(CHAIN_ARB, 1, 1e18, 0, 100e18, 20e18);
        _agg().forceFinalizeDay(1); // #2645 — attribution happens at finalization
        messenger.deliverChainReportRecycled(CHAIN_ARB, 3, 1e18, 0, 180e18, 30e18);
        _agg().forceFinalizeDay(3); // #2645 — attribution happens at finalization

        // Day 2 arrives late (day 2 is not finalized). Its honest figures:
        // cumulative 150, forDay 50 — exactly the 100→150 delta.
        messenger.deliverChainReportRecycled(CHAIN_ARB, 2, 1e18, 0, 150e18, 50e18);
        _agg().forceFinalizeDay(2); // #2645 — attribution happens at finalization

        (uint256 credit, bool accepted) =
            _agg().getChainDailyRecycledCredit(2, CHAIN_ARB);
        assertTrue(accepted);
        assertEq(credit, 50e18, "delayed day attributes exactly");

        (uint256 reported, , , uint256 attributed) =
            _agg().getChainRecycledLedger(CHAIN_ARB);
        assertEq(reported, 180e18, "stale cumulative did not regress availability");
        assertEq(attributed, 100e18, "20 + 30 + 50, all exact");
    }

    /// Codex #1413 r1 — a DELAYED day 0 (day 1+ delivered first) still
    /// attributes: its (pre-launch-inclusive) bucket is backed by the
    /// reported cumulative like any other day.
    function testRecycledLedgerDelayedDayZeroKeepsAttribution() public {
        _configureCanonical();

        messenger.deliverChainReportRecycled(CHAIN_ARB, 1, 1e18, 0, 100e18, 20e18);

        _agg().forceFinalizeDay(1); // #2645 — attribution happens at finalization
        // Day 0 arrives late: cumulative 60 at its close, all 60 credited
        // in the day-0 bucket.
        messenger.deliverChainReportRecycled(CHAIN_ARB, 0, 1e18, 0, 60e18, 60e18);
        _agg().forceFinalizeDay(0); // #2645 — attribution happens at finalization

        (uint256 credit, bool accepted) =
            _agg().getChainDailyRecycledCredit(0, CHAIN_ARB);
        assertTrue(accepted);
        assertEq(credit, 60e18, "day-0 attribution kept");
        (uint256 reported, , , uint256 attributed) =
            _agg().getChainRecycledLedger(CHAIN_ARB);
        assertEq(reported, 100e18, "stale cumulative did not regress availability");
        assertEq(attributed, 80e18);
    }

    /// Codex #1413 r2 — the LATE CLOSE of a quiet day reports the LIVE
    /// lifetime cumulative next to a zero old-day bucket. The baseline
    /// advances only by accepted credit, so the later day whose credits
    /// that cumulative already includes keeps its full attribution (a
    /// baseline ratcheted to the reported cumulative would zero it).
    function testRecycledLedgerLateQuietDayCloseDoesNotStealAttribution()
        public
    {
        _configureCanonical();

        // Day 3 credited 100; quiet day 2 is closed LATE, so its report
        // carries the live cumulative (100) with a zero day-2 bucket.
        messenger.deliverChainReportRecycled(CHAIN_ARB, 2, 1e18, 0, 100e18, 0);
        _agg().forceFinalizeDay(2); // #2645 — attribution happens at finalization
        // Day 3's own report then claims its 100.
        messenger.deliverChainReportRecycled(CHAIN_ARB, 3, 1e18, 0, 100e18, 100e18);
        _agg().forceFinalizeDay(3); // #2645 — attribution happens at finalization

        (uint256 credit, bool accepted) =
            _agg().getChainDailyRecycledCredit(3, CHAIN_ARB);
        assertTrue(accepted);
        assertEq(credit, 100e18, "day-3 credit not stolen by the quiet-day close");
        (uint256 reported, , , uint256 attributed) =
            _agg().getChainRecycledLedger(CHAIN_ARB);
        assertEq(reported, 100e18);
        assertEq(attributed, 100e18);
    }

    /// A late day preceded by an unreported gap still attributes exactly —
    /// order independence means no "dropped attribution" cases exist for an
    /// honest chain.
    function testRecycledLedgerLateDayAfterGapStillAttributes() public {
        _configureCanonical();

        messenger.deliverChainReportRecycled(CHAIN_ARB, 1, 1e18, 0, 100e18, 10e18);

        _agg().forceFinalizeDay(1); // #2645 — attribution happens at finalization
        // Day 4 jumps ahead (days 2-3 never reported yet).
        messenger.deliverChainReportRecycled(CHAIN_ARB, 4, 1e18, 0, 200e18, 20e18);
        _agg().forceFinalizeDay(4); // #2645 — attribution happens at finalization
        // Day 3 arrives late — its 30 is still backed by unattributed total.
        messenger.deliverChainReportRecycled(CHAIN_ARB, 3, 1e18, 0, 180e18, 30e18);
        _agg().forceFinalizeDay(3); // #2645 — attribution happens at finalization

        (uint256 credit, bool accepted) =
            _agg().getChainDailyRecycledCredit(3, CHAIN_ARB);
        assertTrue(accepted, "report processed");
        assertEq(credit, 30e18, "late gap day attributes exactly");
        (uint256 reported, , , uint256 attributed) =
            _agg().getChainRecycledLedger(CHAIN_ARB);
        assertEq(reported, 200e18, "availability unaffected");
        assertEq(attributed, 60e18);
    }

    /// A legacy four-word report (recycled fields absent → zeros) advances
    /// nothing in the ledger but still marks the day processed.
    function testRecycledLedgerLegacyZerosAdvanceNothing() public {
        _configureCanonical();

        messenger.deliverChainReportRecycled(CHAIN_ARB, 1, 1e18, 0, 100e18, 10e18);

        _agg().forceFinalizeDay(1); // #2645 — attribution happens at finalization
        messenger.deliverChainReport(CHAIN_ARB, 2, 1e18, 0); // legacy shape
        _agg().forceFinalizeDay(2); // #2645 — attribution happens at finalization

        (uint256 reported, , , uint256 attributed) =
            _agg().getChainRecycledLedger(CHAIN_ARB);
        assertEq(reported, 100e18, "zero cumulative advances nothing");
        assertEq(attributed, 10e18, "zero for-day attributes nothing");
        (uint256 credit, bool accepted) =
            _agg().getChainDailyRecycledCredit(2, CHAIN_ARB);
        assertTrue(accepted, "day still marked processed");
        assertEq(credit, 0);
    }

    /// #2620 — a report from a chain whose reward clock is not Base's: its day
    /// figures never count (its day 1 is a different stretch of time), while
    /// what it says about the chain still applies, and the day is not marked
    /// reported, so it finalizes with that chain zeroed.
    function testClockMismatchDropsDayFiguresKeepsChainWide() public {
        _configureCanonical();
        uint256 baseLaunch = block.timestamp;
        ChainDayReport memory r = ChainDayReport({
            dayId: 1,
            lenderNumeraire18: 25e18,
            borrowerNumeraire18: 15e18,
            recycledCumulative18: 40e18,
            recycledForDay18: 4e18,
            commitRetiredCumulative18: 0,
            commitReleasedCumulative18: 0,
            custodyEra: 3,
            rewardLaunchTimestamp: baseLaunch + 1 hours
        });

        vm.expectEmit(true, true, false, true, address(diamond));
        emit RewardAggregatorFacet.ChainReportClockMismatch(
            CHAIN_ARB, 1, baseLaunch + 1 hours, baseLaunch
        );
        messenger.deliverChainDayReport(CHAIN_ARB, r);

        assertFalse(_agg().isChainReported(1, CHAIN_ARB), "day figures not taken");
        assertEq(_agg().getChainDailyReportCount(1), 0, "no report counted toward the day");
        (uint256 reported, , , ) = _agg().getChainRecycledLedger(CHAIN_ARB);
        assertEq(reported, 40e18, "the chain-wide cumulative applies");
        assertEq(_agg().getChainCustodyEraReported(CHAIN_ARB), 3, "the era applies");

        // The same chain on Base's clock is taken whole: the dropped report
        // left nothing behind that refuses it.
        r.rewardLaunchTimestamp = baseLaunch;
        messenger.deliverChainDayReport(CHAIN_ARB, r);
        assertTrue(_agg().isChainReported(1, CHAIN_ARB), "a matching clock counts");
    }

    /// #2620 review — a report reaching Base before Base's own clock is set
    /// is refused, not dropped as a mismatch: the mirror's close is stamped
    /// sent for good, so the delivery must stay re-executable until Base's
    /// clock runs.
    function testReportRefusedWhileBaseClockUnset() public {
        vm.chainId(CHAIN_BASE);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(true);
        _rep().setRewardMessenger(address(messenger));
        ChainDayReport memory r;
        r.dayId = 1;
        r.lenderNumeraire18 = 25e18;
        r.rewardLaunchTimestamp = block.timestamp;
        vm.expectRevert(
            abi.encodeWithSelector(RewardAggregatorFacet.RewardClockNotLaunchedOnBase.selector, CHAIN_ARB, uint256(1))
        );
        messenger.deliverChainDayReport(CHAIN_ARB, r);

        // Once Base's clock runs on the same moment, the same delivery lands.
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(block.timestamp);
        messenger.deliverChainDayReport(CHAIN_ARB, r);
        assertTrue(_agg().isChainReported(1, CHAIN_ARB), "re-executed after launch, it counts");
    }

    /// #2620 — a report on Base's clock is taken exactly as before.
    function testMatchingClockCountsDayFigures() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_ARB, 1, 25e18, 15e18);
        assertTrue(_agg().isChainReported(1, CHAIN_ARB), "interest recorded");
        (uint256 lender, uint256 borrower) = _agg().getChainReport(1, CHAIN_ARB);
        assertEq(lender, 25e18);
        assertEq(borrower, 15e18);
    }

    /// #2875 item 3 — the reported cumulative is the stored lifetime
    /// counter and nothing else. A bucket with no credited counter behind
    /// it (the shape an in-place refresh over pre-#1222 state left, which
    /// a fresh deploy can never reach) used to be floored up to
    /// `recycleBucket + paidOutRecycled`; the floor is retired, so neither
    /// the view nor the report reads the bucket.
    function testCloseDayReportsStoredCumulativeNotBucket() public {
        _configureMirror(CHAIN_ARB);
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(
            block.timestamp
        );
        _mut().setDailyLenderInterest(1, alice, 25e18, 25e18);
        _mut().setKnownGlobalSet(1, false);
        _mut().setRecycleBucketRaw(50e18);
        _mut().setRecycleCreditedCumulativeRaw(20e18);
        vm.warp(block.timestamp + 2 days + 1);

        assertEq(
            _cfg().getRecycleCreditedCumulative(),
            20e18,
            "view is the stored counter, not floored on the bucket"
        );

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        _rep().closeDay{value: 0.3 ether}(1);

        assertEq(
            messenger.lastSendRecycledCumulative18(),
            20e18,
            "report carries the stored counter"
        );
    }

    /// Mirror `closeDay` forwards the recycled pair (cumulative + the
    /// closing day's credited bucket) alongside the interest figures.
    function testCloseDayMirrorForwardsRecycledFigures() public {
        _configureMirror(CHAIN_ARB);
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(
            block.timestamp
        );
        _mut().setDailyLenderInterest(1, alice, 25e18, 25e18);
        _mut().setKnownGlobalSet(1, false);
        _mut().setRecycleCreditedCumulativeRaw(123e18);
        _mut().setRecycledCreditedByDayRaw(1, 7e18);
        vm.warp(block.timestamp + 2 days + 1);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        _rep().closeDay{value: 0.3 ether}(1);

        assertEq(messenger.lastSendRecycledCumulative18(), 123e18, "cumulative rides the report");
        assertEq(messenger.lastSendRecycledForDay18(), 7e18, "closing day's bucket rides the report");
    }

    /// #2621 — a messenger without the one report send (an older build,
    /// rotated in between a caller's checks and its close) makes `closeDay`
    /// revert, and the day stays unsent: no fallback to an older shape, and no
    /// stamp that would keep the day from being sent once the messenger is
    /// right.
    function testCloseDayRevertsOnAMessengerWithoutTheReportSend() public {
        _configureMirror(CHAIN_ARB);
        LegacyOnlyRewardMessenger legacyMessenger =
            new LegacyOnlyRewardMessenger();
        _rep().setRewardMessenger(address(legacyMessenger));
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(
            block.timestamp
        );
        _mut().setDailyLenderInterest(1, alice, 25e18, 25e18);
        _mut().setKnownGlobalSet(1, false);
        vm.warp(block.timestamp + 2 days + 1);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert();
        _rep().closeDay{value: 0.3 ether}(1);
        assertEq(legacyMessenger.sendCount(), 0, "no older shape was sent");

        // The right messenger then sends the same day.
        _rep().setRewardMessenger(address(messenger));
        vm.prank(alice);
        _rep().closeDay{value: 0.3 ether}(1);
        assertEq(messenger.sendCount(), 1, "the day was still sendable");
        assertEq(messenger.lastSendDest(), CHAIN_BASE, "to this Diamond's Base");
    }

    /// A REASONED send failure (fee shortfall, pause) bubbles unchanged.
    function testCloseDayMirrorReasonedSendFailureBubbles() public {
        _configureMirror(CHAIN_ARB);
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(
            block.timestamp
        );
        _mut().setDailyLenderInterest(1, alice, 25e18, 25e18);
        _mut().setKnownGlobalSet(1, false);
        vm.warp(block.timestamp + 2 days + 1);

        messenger.setRevertOnSend(true);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(bytes("MockMessenger: send revert"));
        _rep().closeDay{value: 0.3 ether}(1);
    }

    /// Base's own `closeDay` records its recycled figures into the SAME
    /// per-chain ledger (under its own chain id) that mirror reports feed —
    /// one uniform ledger for B2/B3's netting.
    function testCloseDayCanonicalRecordsOwnLedger() public {
        _configureCanonical();
        _mut().setDailyLenderInterest(1, alice, 40e18, 40e18);
        _mut().setKnownGlobalSet(1, false);
        _mut().setRecycleCreditedCumulativeRaw(55e18);
        _mut().setRecycledCreditedByDayRaw(1, 5e18);
        vm.warp(block.timestamp + 2 days + 1);

        _rep().closeDay(1);

        _agg().forceFinalizeDay(1); // #2645 — attribution happens at finalization

        (uint256 reported, , uint256 avail, uint256 attributed) =
            _agg().getChainRecycledLedger(CHAIN_BASE);
        assertEq(reported, 55e18, "own cumulative recorded under own chain id");
        assertEq(avail, 55e18);
        assertEq(attributed, 5e18, "own day credit attributed");
        (uint256 credit, bool accepted) =
            _agg().getChainDailyRecycledCredit(1, CHAIN_BASE);
        assertTrue(accepted);
        assertEq(credit, 5e18);
    }

    // ════════════════════════════════════════════════════════════════════════
    // #1222 M3 B2-b — the per-destination fields the kind-10 ingress applies
    // ════════════════════════════════════════════════════════════════════════

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

    /// One arrival applies the ingress: consensus pair, cap family (mode +
    /// per-side ceilings + legacy threshold disabled), the chain's own
    /// funding stamp, the in-band arming day — and (B2-d3) RESERVES the
    /// instructed `recycleConsume` against this chain's recycled
    /// commitments. Per plan SSM3 the broadcast *commits*; the bucket itself
    /// is debited pro-rata later at claim/remit, so the bucket balance is
    /// deliberately untouched here (debiting at arrival would double-charge
    /// against the claim-time consume — design record SS2e.1).
    function testBroadcastV2AppliesConsensusCapFamilyAndReservesCommit()
        public
    {
        _configureMirror(CHAIN_ARB);
        _mut().setRecycleBucketRaw(12e18);

        messenger.deliverBroadcastV2(_v2Packet(CHAIN_ARB));

        (uint256 gl, uint256 gb, bool isSet) =
            _rep().getKnownGlobalInterestNumeraire18(3);
        assertTrue(isSet, "consensus pair set");
        assertEq(gl, 30e18);
        assertEq(gb, 15e18);

        assertEq(_mut().dayCapModeRaw(3), 1, "ShareOfPool mode stamped");
        assertEq(
            _mut().dayCapThreshold18Raw(3),
            type(uint256).max,
            "legacy threshold disabled atomically with the mode"
        );
        (uint256 cL, uint256 cB) = _agg().getDayUserSideCaps(3);
        assertEq(cL, 11e18, "per-side lender ceiling verbatim");
        assertEq(cB, 7e18, "per-side borrower ceiling verbatim");

        LibVaipakam.ChainDayFunding memory f =
            _agg().getChainDayRecycledFunding(3, CHAIN_ARB);
        assertTrue(f.stamped, "own funding stamp written");
        assertEq(f.freshLenderHalf, 20e18);
        assertEq(f.lenderHalfEquiv, 9e18);
        assertEq(f.borrowerHalfEquiv, 4e18);
        assertEq(f.recycleConsume, 5e18, "wire recycleConsume stored");

        (uint256 armedFrom, , uint256 outR, ) = _agg().getGovernorCommitState();
        assertEq(armedFrom, 2, "arming day travels in-band");

        // B2-d3 — arrival COMMITS: the instruction is reserved against this
        // chain's recycled commitments, and the bucket is NOT debited (that
        // happens pro-rata at claim/remit through the unchanged consume).
        assertEq(outR, 5e18, "instructed commit reserved on arrival");
        assertEq(
            _cfg().getRecycleBucket(),
            12e18,
            "bucket debited at claim/remit, never at arrival"
        );
    }

    /// Whole-day idempotency: a re-delivered packet is a no-op (CCIP can
    /// duplicate), and any diverging stamped field reverts.
    function testBroadcastV2ReplayIsIdempotent() public {
        _configureMirror(CHAIN_ARB);
        _mut().setRecycleBucketRaw(12e18);

        messenger.deliverBroadcastV2(_v2Packet(CHAIN_ARB));
        messenger.deliverBroadcastV2(_v2Packet(CHAIN_ARB));
        assertEq(_cfg().getRecycleBucket(), 12e18, "bucket never touched");
        // B2-d3 — the reservation runs exactly once under the whole-day
        // idempotency guard, so a duplicated CCIP delivery cannot
        // double-encumber the mirror's availability.
        (, , uint256 outR, ) = _agg().getGovernorCommitState();
        assertEq(outR, 5e18, "reservation applied exactly once on replay");

        RewardBroadcastV2 memory diverged = _v2Packet(CHAIN_ARB);
        diverged.recycleConsume = 6e18;
        vm.expectRevert(IVaipakamErrors.KnownGlobalAlreadySet.selector);
        messenger.deliverBroadcastV2(diverged);
    }

    /// The embedded destination id is the replay-stable binding: a packet
    /// built for another chain must never apply its figures here.
    function testBroadcastV2RejectsWrongDestination() public {
        _configureMirror(CHAIN_ARB);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.BroadcastDestinationMismatch.selector,
                uint256(CHAIN_OP)
            )
        );
        messenger.deliverBroadcastV2(_v2Packet(CHAIN_OP));
    }

    /// #1944 — `getBroadcastV2Applied` is the readback the M7 arming ceremony
    /// needs: whether a mirror has already applied a candidate day. Until this getter
    /// the question was answerable only by scanning `RewardBroadcastV2Applied`
    /// logs, where a missed page reads as "not applied" — the exact wrong
    /// answer under ceremony pressure.
    ///
    /// Driven through the REAL ingress rather than `setBroadcastV2AppliedRaw`,
    /// so this asserts the getter tracks what the PRODUCTION apply path writes.
    /// A mutator-only test would pass even if the getter read a mapping the
    /// apply path never touches.
    function testGetBroadcastV2AppliedTracksTheApplyPath() public {
        _configureMirror(CHAIN_ARB);

        assertFalse(_rep().getBroadcastV2Applied(3), "day 3 unapplied before delivery");
        assertFalse(_rep().getBroadcastV2Applied(4), "day 4 unapplied before delivery");

        messenger.deliverBroadcastV2(_v2Packet(CHAIN_ARB)); // packet is dayId 3

        assertTrue(_rep().getBroadcastV2Applied(3), "day 3 reads applied after ingress");
        // PER-DAY DISCRIMINATION. Without this a getter that ignores `dayId`,
        // or returns a constant true once any day has landed, satisfies every
        // assertion above — which is the whole point of the readback, since the
        // ceremony asks the question per CANDIDATE day.
        assertFalse(
            _rep().getBroadcastV2Applied(4),
            "an unrelated day is unaffected - the getter is keyed on dayId"
        );

        // MAPPING DISCRIMINATION, and this is the assertion that earns the
        // test. The ingress sets `knownGlobalSet` ALONGSIDE
        // `broadcastV2Applied`, so both flip together on day 3 and a getter
        // pointed at the wrong mapping satisfies every assertion above. That
        // is not hypothetical: mutating the getter to read `knownGlobalSet`
        // PASSED the first draft of this test.
        //
        // With the kind-2 wire retired (#1944) no production path sets one
        // without the other, so the separation is staged raw.
        _mut().setKnownGlobalSet(7, true);
        assertFalse(
            _rep().getBroadcastV2Applied(7),
            "a known-global-only day is NOT applied - getter reads broadcastV2Applied, not knownGlobalSet"
        );
    }

    function testBroadcastV2RevertsWhenNotMessenger() public {
        _configureMirror(CHAIN_ARB);
        vm.prank(alice);
        vm.expectRevert(NotAuthorizedRewardMessenger.selector);
        RewardBroadcastV3 memory b;
        b.v2 = _v2Packet(CHAIN_ARB);
        _rep().onRewardBroadcastV3Received(b);
    }

    /// Legacy-mode packets (pre-cutover days) carry the §4 threshold in the
    /// lender payload slot and touch neither the mode nor the ceilings.
    function testBroadcastV2LegacyCapModeStoresThresholdOnly() public {
        _configureMirror(CHAIN_ARB);
        RewardBroadcastV2 memory b = _v2Packet(CHAIN_ARB);
        b.capMode = uint8(LibVaipakam.CapMode.LegacyEthRatio);
        b.capPayloadLender = 123e18;
        b.capPayloadBorrower = 0;
        b.recycleConsume = 0;
        b.armedFromDay = 0;

        messenger.deliverBroadcastV2(b);

        assertEq(_mut().dayCapThreshold18Raw(3), 123e18, "threshold verbatim");
        assertEq(_mut().dayCapModeRaw(3), 0, "mode untouched pre-cutover");
        (uint256 cL, uint256 cB) = _agg().getDayUserSideCaps(3);
        assertEq(cL, 0);
        assertEq(cB, 0);
    }
}
