// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {RewardClosureFacet} from "../src/facets/RewardClosureFacet.sol";
import {RewardStagingSettleFacet} from "../src/facets/RewardStagingSettleFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/// @title RewardClosureProofTest
/// @notice 3b-ii-B — a past day is proven CLOSED once every obligation covering it
///         has terminated: a starter-keyed, resumable walk in the accumulation's
///         shape (ascending ids, the cover check, completeness by conservation
///         against the folded side totals), admissible once the fold has reached the
///         day — the chain's own day close is not required. An omission poisons only its
///         author's walk; the day is stamped by the first walk to complete.
contract RewardClosureProofTest is SetupTest, IVaipakamErrors {
    MockRewardMessenger internal messenger;
    address internal alice;
    address internal bob;
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    uint32 internal constant CHAIN_OP = 10;
    uint64 internal constant LOAN = 77;
    uint256 internal constant D = 3;
    uint256 internal launch;

    event DayObligationsClosed(uint256 indexed day, address indexed starter, uint64 nonce);

    function setUp() public {
        setupHelper();
        messenger = new MockRewardMessenger(address(diamond));
        launch = block.timestamp;
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(launch);
        vm.chainId(CHAIN_BASE);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(true);
        _rep().setRewardMessenger(address(messenger));
        uint32[] memory chainIds = new uint32[](3);
        chainIds[0] = CHAIN_BASE;
        chainIds[1] = CHAIN_ARB;
        chainIds[2] = CHAIN_OP;
        _agg().setExpectedSourceChainIds(chainIds);
        alice = makeAddr("closure-alice");
        bob = makeAddr("closure-bob");
    }

    function _rep() internal view returns (RewardReporterFacet) { return RewardReporterFacet(address(diamond)); }
    function _agg() internal view returns (RewardAggregatorFacet) { return RewardAggregatorFacet(address(diamond)); }
    function _clo() internal view returns (RewardClosureFacet) { return RewardClosureFacet(address(diamond)); }
    function _mut() internal view returns (TestMutatorFacet) { return TestMutatorFacet(address(diamond)); }

    /// @dev A lender entry over `[start, end)` whose per-day figure the interest
    ///      fold also carries (the registration writes both; the mutator writes neither).
    function _lenderEntry(address user, uint256 perDay, uint32 start, uint32 end) internal returns (uint256 id) {
        id = _mut().pushRewardEntry(user, LOAN, LibVaipakam.RewardSide.Lender, perDay, start);
        _mut().closeRewardEntryRaw(id, end);
        _mut().setInterestFoldDeltaRaw(start, int256(perDay), 0);
        _mut().setInterestFoldDeltaRaw(end, -int256(perDay), 0);
    }

    /// @dev The chain closes `d` itself, which folds through it.
    function _closeLocally(uint256 d) internal {
        vm.warp(launch + (d + 1) * 1 days + 1);
        _rep().closeDay(d);
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory r) { r = new uint256[](1); r[0] = a; }
    function _ids(uint256 a, uint256 b) internal pure returns (uint256[] memory r) { r = new uint256[](2); r[0] = a; r[1] = b; }

    /// @dev Two covering lender entries, both terminated — one settled whole, one
    ///      part-claimed past the day; the borrower side has nothing. The proof
    ///      completes on one page and the stamp is irreversible.
    function test_ADayWhoseEntriesAllTerminated_ProvesClosed_Once() public {
        uint256 id1 = _lenderEntry(alice, 1e18, 1, 5);
        uint256 id2 = _lenderEntry(bob, 2e18, 1, 5);
        _mut().setRewardEntryProcessedRaw(id1, true);
        _mut().setRewardEntryClaimNextDayRaw(id2, uint64(D + 1));
        _closeLocally(D);
        (, uint64 nonce, bool closed) = _clo().startDayClosure(D);
        assertFalse(closed, "the lender side has entries to visit");
        assertEq(nonce, 1);
        vm.expectEmit(true, true, true, true);
        emit DayObligationsClosed(D, address(this), 1);
        assertTrue(_clo().proveDayClosurePage(D, 1, 0, _ids(id1, id2)), "completes on one page");
        assertTrue(_clo().isDayObligationsClosed(D));
        LibVaipakam.ClosureWalk memory w = _clo().getClosureWalk(D, address(this), 1);
        assertTrue(w.completed); assertEq(w.lenderConservation, 3e18); assertEq(w.lenderCursor, id2);
        vm.expectRevert(abi.encodeWithSelector(ClosureDayAlreadyClosed.selector, D));
        _clo().startDayClosure(D);
    }

    /// @dev An entry still standing on the day is named, and the page leaves nothing
    ///      behind; once it settles past the day the same page passes.
    function test_AnOpenEntry_IsNamed_AndThePageLeavesNothing() public {
        uint256 id1 = _lenderEntry(alice, 1e18, 1, 5);
        uint256 id2 = _lenderEntry(bob, 2e18, 1, 5);
        _mut().setRewardEntryProcessedRaw(id1, true);
        _mut().setRewardEntryClaimNextDayRaw(id2, uint64(D)); // settled THROUGH day 2 only: day 3 still owed
        _closeLocally(D);
        (, uint64 nonce, ) = _clo().startDayClosure(D);
        assertFalse(_clo().isEntryTerminatedOn(id2, D));
        vm.expectRevert(abi.encodeWithSelector(ClosureEntryOpen.selector, D, id2));
        _clo().proveDayClosurePage(D, nonce, 0, _ids(id1, id2));
        LibVaipakam.ClosureWalk memory w = _clo().getClosureWalk(D, address(this), nonce);
        assertEq(w.lenderCursor, 0, "the refused page applied nothing");
        _mut().setRewardEntryClaimNextDayRaw(id2, uint64(D + 1));
        assertTrue(_clo().proveDayClosurePage(D, nonce, 0, _ids(id1, id2)));
    }

    /// @dev Admissibility: an elapsed day the fold has reached — nothing before; the chain's own
    ///      day close is not a condition (#1566 PR 1 review).
    function test_Admissibility_ElapsedAndFolded() public {
        _lenderEntry(alice, 1e18, 1, 5);
        vm.warp(launch + (D + 1) * 1 days + 1);
        vm.expectRevert(abi.encodeWithSelector(ClosureDayNotElapsed.selector, D + 1));
        _clo().startDayClosure(D + 1); // today
        vm.expectRevert(abi.encodeWithSelector(ClosureFrontierShort.selector, D, uint256(0), uint256(0)));
        _clo().startDayClosure(D); // elapsed, but the fold has not reached it
        _rep().advanceInterestFrontiers(D); // the fold, permissionless; no local close
        assertEq(_rep().getChainReportSentAt(D), 0, "fixture-live: the chain never closed the day itself");
        (, , bool closed) = _clo().startDayClosure(D);
        assertFalse(closed);
    }

    /// @dev #1566 PR 1 review (P2-4) — a day the canonical chain FINALIZED before closing it itself
    ///      can never be closed locally (`ReportAfterFinalization`), for ever; the proof needs only
    ///      the fold at the day, so the day still proves closed — and the custody era it belongs to,
    ///      and the token rotation that era's row blocks, are not locked behind it.
    function test_ADayFinalizedBeforeItsLocalClose_StillProvesClosed() public {
        uint256 id1 = _lenderEntry(alice, 1e18, 1, 5);
        _mut().setRewardEntryProcessedRaw(id1, true);
        vm.warp(launch + (D + 1) * 1 days + 1);
        _agg().forceFinalizeDay(D);
        vm.expectRevert(ReportAfterFinalization.selector);
        _rep().closeDay(D); // the local close can never land now
        _rep().advanceInterestFrontiers(D);
        (, uint64 nonce, bool closed) = _clo().startDayClosure(D);
        assertFalse(closed, "fixture-live: the lender side has an entry to visit");
        assertTrue(_clo().proveDayClosurePage(D, nonce, 0, _ids(id1)), "proven closed by the fold alone");
        assertTrue(_clo().isDayObligationsClosed(D));
    }

    /// @dev An omitted id advances only its author's cursor past it: that walk can
    ///      never complete; a fresh walk by anyone closes the day.
    function test_AnOmission_PoisonsOnlyItsStartersWalk() public {
        uint256 id1 = _lenderEntry(alice, 1e18, 1, 5);
        uint256 id2 = _lenderEntry(bob, 2e18, 1, 5);
        _mut().setRewardEntryProcessedRaw(id1, true);
        _mut().setRewardEntryProcessedRaw(id2, true);
        _closeLocally(D);
        (, uint64 nA, ) = _clo().startDayClosure(D);
        assertFalse(_clo().proveDayClosurePage(D, nA, 0, _ids(id2)), "short of conservation");
        vm.expectRevert(abi.encodeWithSelector(ClosureEntriesNotAscending.selector, id1));
        _clo().proveDayClosurePage(D, nA, 0, _ids(id1));
        assertFalse(_clo().isDayObligationsClosed(D));
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        (, uint64 nB, ) = _clo().startDayClosure(D);
        assertTrue(_clo().proveDayClosurePage(D, nB, 0, _ids(id1, id2)), "a fresh walk completes");
        vm.stopPrank();
        assertTrue(_clo().isDayObligationsClosed(D));
        assertFalse(_clo().getClosureWalk(D, address(this), nA).completed, "the poisoned walk stays as it was");
    }

    /// @dev A standing staging record of the claimant-side on the day keeps the
    ///      entry open for the proof (A2: a staged day is not closed).
    function test_AStagedDay_KeepsItsEntryOpen() public {
        uint256 id1 = _lenderEntry(alice, 1e18, 1, 5);
        _mut().setRewardEntryProcessedRaw(id1, true);
        _closeLocally(D);
        // The record opens through the one seam, as the Diamond would open it; a
        // domain key keeps an empty record standing.
        vm.prank(address(diamond));
        RewardStagingSettleFacet(address(diamond)).stageDayFromPlanInternal(
            alice, 0, D, _ids(id1), new bytes32[](0), new uint256[](0), new uint256[](0), 0, 1, keccak256("some-domain")
        );
        assertFalse(_clo().isEntryTerminatedOn(id1, D));
        (, uint64 nonce, ) = _clo().startDayClosure(D);
        vm.expectRevert(abi.encodeWithSelector(ClosureEntryOpen.selector, D, id1));
        _clo().proveDayClosurePage(D, nonce, 0, _ids(id1));
    }

    /// @dev An open legacy-slice domain whose window covers the day keeps the entry
    ///      open for the proof (A2-ii (c)); a window past the day does not.
    function test_AnOpenLegacyDomain_KeepsItsEntryOpen() public {
        uint256 id1 = _lenderEntry(alice, 1e18, 1, 5);
        _mut().setRewardEntryProcessedRaw(id1, true);
        _mut().setLegacyDomainOpenRaw(id1, 1, uint64(D));
        assertFalse(_clo().isEntryTerminatedOn(id1, D));
        _mut().setLegacyDomainOpenRaw(id1, uint64(D + 1), uint64(D + 1));
        assertTrue(_clo().isEntryTerminatedOn(id1, D), "a window past the day does not hold it");
    }

    /// @dev A day with no obligation on either side closes at the start — only once
    ///      the chain has closed it, with the fold at the day.
    function test_ANoObligationDay_ClosesAtStart() public {
        _lenderEntry(alice, 1e18, 1, 3); // ends before day 3
        _closeLocally(D);
        (, , bool closed) = _clo().startDayClosure(D);
        assertTrue(closed, "nothing to visit on either side");
        assertTrue(_clo().isDayObligationsClosed(D));
    }

    /// @dev A visited figure the fold never carried overruns conservation: the day's
    ///      records disagree and the proof refuses rather than completing on them.
    function test_AConservationOverrun_Refuses() public {
        uint256 id1 = _lenderEntry(alice, 1e18, 1, 5);
        // An entry the fold does not know (no delta): covers the day, terminated.
        uint256 ghost = _mut().pushRewardEntry(bob, LOAN, LibVaipakam.RewardSide.Lender, 5e18, 1);
        _mut().closeRewardEntryRaw(ghost, 5);
        _mut().setRewardEntryProcessedRaw(id1, true);
        _mut().setRewardEntryProcessedRaw(ghost, true);
        _closeLocally(D);
        (, uint64 nonce, ) = _clo().startDayClosure(D);
        vm.expectRevert(abi.encodeWithSelector(ClosureConservationExceeded.selector, D, 0, 6e18, 1e18));
        _clo().proveDayClosurePage(D, nonce, 0, _ids(id1, ghost));
    }
}
