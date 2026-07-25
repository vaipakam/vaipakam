// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";

import {RewardCommitmentFacet} from "../src/facets/RewardCommitmentFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";

/// @title RewardCommitmentTest
/// @notice #1222 M3 B2-c — the Base-side commitment-GATE plumbing: the armed
///         finalization-readiness gate (mirror commitments complete; canonical
///         exempt), the force-finalize remit-ineligible mark, the grace-vs-
///         force split, and operator reconciliation.
///
/// @dev The mirror→Base commitment report that populates `complete` is
///      DEFERRED to B2-d (owner re-slice 2026-07-25 after Codex #1422 showed a
///      paged, permissionless, active-loan-list report is the wrong mechanism
///      for day-`D` claimable liabilities). These tests set `complete`
///      directly via a mutator to exercise the dormant gate now.
contract RewardCommitmentTest is SetupTest, IVaipakamErrors {
    MockRewardMessenger internal messenger;

    address internal alice;

    uint32 internal constant CHAIN_BASE = 8453; // canonical
    uint32 internal constant CHAIN_ARB = 42161; // mirror
    uint32 internal constant CHAIN_OP = 10; // mirror

    function setUp() public {
        setupHelper();
        messenger = new MockRewardMessenger(address(diamond));
        alice = makeAddr("alice");
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _com() internal view returns (RewardCommitmentFacet) {
        return RewardCommitmentFacet(address(diamond));
    }

    function _rep() internal view returns (RewardReporterFacet) {
        return RewardReporterFacet(address(diamond));
    }

    function _agg() internal view returns (RewardAggregatorFacet) {
        return RewardAggregatorFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
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
    }

    /// @dev Set the B2-d-populated `complete` flag directly (report deferred).
    function _complete(uint32 chainId, uint256 dayId) internal {
        _mut().setChainDayCommitmentCompleteRaw(dayId, chainId, true);
    }

    // ═══ Finalization-readiness gate ═════════════════════════════════════════

    function test_armedFinalize_waitsForMirrorCommitments() public {
        _configureCanonical();
        _mut().setGovernorCommitArmedFromDayRaw(1);

        // Full INTEREST coverage for every expected chain…
        messenger.deliverChainReport(CHAIN_BASE, 1, 0, 0);
        messenger.deliverChainReport(CHAIN_ARB, 1, 0, 0);
        messenger.deliverChainReport(CHAIN_OP, 1, 0, 0);

        // …but no mirror commitments complete ⇒ the armed full-coverage path is
        // NOT ready (grace has not elapsed). The gate is the whole point.
        vm.expectRevert(DayNotReadyToFinalize.selector);
        _agg().finalizeDay(1);

        // Complete every MIRROR (canonical BASE is exempt — never remitted to).
        _complete(CHAIN_ARB, 1);
        _complete(CHAIN_OP, 1);
        _agg().finalizeDay(1); // succeeds

        vm.expectRevert(DayAlreadyFinalized.selector);
        _agg().finalizeDay(1);
    }

    function test_singleChain_gateInert() public {
        // Single-chain mesh (Base only, no mirrors): the armed gate is
        // trivially ready — no mirror commitments to wait for.
        vm.chainId(CHAIN_BASE);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(true);
        _rep().setRewardMessenger(address(messenger));
        uint32[] memory chainIds = new uint32[](1);
        chainIds[0] = CHAIN_BASE;
        _agg().setExpectedSourceChainIds(chainIds);
        _mut().setGovernorCommitArmedFromDayRaw(1);

        messenger.deliverChainReport(CHAIN_BASE, 1, 0, 0);
        _agg().finalizeDay(1); // no mirrors ⇒ ready without any commitment
        vm.expectRevert(DayAlreadyFinalized.selector);
        _agg().finalizeDay(1);
    }

    function test_armedGraceFinalize_incompleteMirror_marksIneligible() public {
        // The GRACE backstop still closes an armed day with an incomplete
        // mirror, but — never remitting from a partial set (Codex #1422 r2) —
        // it marks that mirror remit-INELIGIBLE, exactly like a force-finalize;
        // an operator reconciles before its ShareOfPool remittance proceeds.
        _configureCanonical();
        _mut().setGovernorCommitArmedFromDayRaw(1);

        messenger.deliverChainReport(CHAIN_BASE, 1, 0, 0);
        messenger.deliverChainReport(CHAIN_ARB, 1, 0, 0);
        messenger.deliverChainReport(CHAIN_OP, 1, 0, 0);
        _complete(CHAIN_OP, 1); // ARB stays incomplete

        vm.expectRevert(DayNotReadyToFinalize.selector);
        _agg().finalizeDay(1);

        vm.warp(block.timestamp + 4 hours + 1);
        _agg().finalizeDay(1); // grace branch
        vm.expectRevert(DayAlreadyFinalized.selector);
        _agg().finalizeDay(1);

        assertTrue(
            _com().getChainDayCommitments(1, CHAIN_ARB).remitIneligible,
            "grace finalize marks the incomplete mirror remit-ineligible"
        );
        assertFalse(
            _com().getChainDayCommitments(1, CHAIN_OP).remitIneligible,
            "complete mirror OP stays eligible"
        );
    }

    function test_forceFinalize_marksIncompleteMirrorRemitIneligible() public {
        _configureCanonical();
        _mut().setGovernorCommitArmedFromDayRaw(1);

        messenger.deliverChainReport(CHAIN_BASE, 1, 0, 0);
        messenger.deliverChainReport(CHAIN_ARB, 1, 0, 0);
        messenger.deliverChainReport(CHAIN_OP, 1, 0, 0);
        _complete(CHAIN_OP, 1); // OP complete; ARB missing

        _agg().forceFinalizeDay(1);

        assertTrue(
            _com().getChainDayCommitments(1, CHAIN_ARB).remitIneligible,
            "incomplete mirror ARB is remit-ineligible"
        );
        assertFalse(
            _com().getChainDayCommitments(1, CHAIN_OP).remitIneligible,
            "complete mirror OP stays eligible"
        );
        assertFalse(
            _com().getChainDayCommitments(1, CHAIN_BASE).remitIneligible,
            "canonical BASE is exempt (never flagged)"
        );
    }

    function test_forceFinalize_unarmedDay_marksNothing() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_ARB, 1, 0, 0);
        _agg().forceFinalizeDay(1);
        assertFalse(
            _com().getChainDayCommitments(1, CHAIN_ARB).remitIneligible,
            "unarmed day never flags remit-ineligible"
        );
    }

    // ═══ Reconciliation ══════════════════════════════════════════════════════

    function test_reconcile_clearsRemitIneligible() public {
        _configureCanonical();
        _mut().setGovernorCommitArmedFromDayRaw(1);
        messenger.deliverChainReport(CHAIN_ARB, 1, 0, 0);
        _agg().forceFinalizeDay(1);
        assertTrue(_com().getChainDayCommitments(1, CHAIN_ARB).remitIneligible);

        _com().reconcileCommitmentRemitEligibility(1, CHAIN_ARB);
        assertFalse(
            _com().getChainDayCommitments(1, CHAIN_ARB).remitIneligible,
            "operator reconciliation clears the flag"
        );
    }

    function test_reconcile_requiresAdmin() public {
        _configureCanonical();
        vm.prank(alice);
        vm.expectRevert();
        _com().reconcileCommitmentRemitEligibility(1, CHAIN_ARB);
    }

    function test_reconcile_requiresCanonical() public {
        // The facet is cut on mirror Diamonds too, but the remit-ineligible
        // flag is authoritative on Base — a mirror-chain reconcile must revert
        // rather than silently clear an unused local mapping (Codex #1422 r4).
        vm.chainId(CHAIN_ARB);
        _rep().setIsCanonicalRewardChain(false);
        vm.expectRevert(NotCanonicalRewardChain.selector);
        _com().reconcileCommitmentRemitEligibility(1, CHAIN_ARB);
    }

    // ═══ Readiness view parity ═══════════════════════════════════════════════

    function test_isDayReadyToFinalize_respectsCommitmentGate() public {
        // The public readiness view must never report "ready" for a call that
        // finalizeDay would revert (keeper/tooling parity — Codex #1422 r4).
        _configureCanonical();
        _mut().setGovernorCommitArmedFromDayRaw(1);
        messenger.deliverChainReport(CHAIN_BASE, 1, 0, 0);
        messenger.deliverChainReport(CHAIN_ARB, 1, 0, 0);
        messenger.deliverChainReport(CHAIN_OP, 1, 0, 0);

        // Full interest coverage but mirrors incomplete ⇒ NOT ready (matches
        // finalizeDay's DayNotReadyToFinalize revert before grace).
        (bool ready, ) = _agg().isDayReadyToFinalize(1);
        assertFalse(ready, "not ready while a mirror's commitments incomplete");

        _complete(CHAIN_ARB, 1);
        _complete(CHAIN_OP, 1);
        (ready, ) = _agg().isDayReadyToFinalize(1);
        assertTrue(ready, "ready once every mirror is complete");
    }

    // ═══ Dormant views ═══════════════════════════════════════════════════════

    function test_views_defaultDormant() public {
        _configureCanonical();
        assertFalse(
            _com().isChainDayCommitmentsComplete(1, CHAIN_ARB),
            "complete defaults false (report is B2-d)"
        );
        LibVaipakam.ChainDayCommitments memory c =
            _com().getChainDayCommitments(1, CHAIN_ARB);
        assertFalse(c.complete, "struct complete false");
        assertFalse(c.remitIneligible, "struct remitIneligible false");
    }
}
