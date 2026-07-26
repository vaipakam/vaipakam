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
/// @notice #1222 M3 B2-c/B2-d1 — the reward-mesh commitment REPORT end to end:
///         mirror-side keeper-fed per-ENTRY accumulation (demand-conservation
///         completeness, strictly-ascending entry-id cursor, mirror-recomputed
///         figures — the entry unit is transfer-invariant, Codex #1425 r1),
///         the once-per-day dispatch to Base, the Base ingress that stores the
///         per-side liabilities (the B2-d2 remit-gate input) with day-topology
///         membership, and the retimed finalize semantics: finalization has NO
///         commitment input (the report is only computable from the caps +
///         stamp finalize itself produces — design doc §2b), and
///         `remitIneligible` marks chains ZEROED out of the interest
///         denominator, not chains whose report is merely still in flight.
contract RewardCommitmentTest is SetupTest, IVaipakamErrors {
    MockRewardMessenger internal messenger;

    address internal alice;
    address internal u1;
    address internal u2;
    address internal u3;

    uint32 internal constant CHAIN_BASE = 8453; // canonical
    uint32 internal constant CHAIN_ARB = 42161; // mirror
    uint32 internal constant CHAIN_OP = 10; // mirror

    uint256 internal constant DAY = 1;

    function setUp() public {
        setupHelper();
        messenger = new MockRewardMessenger(address(diamond));
        alice = makeAddr("alice");
        u1 = makeAddr("carol");
        u2 = makeAddr("dave");
        u3 = makeAddr("erin");
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

    function _configureMirror() internal {
        vm.chainId(CHAIN_ARB);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(false);
        _rep().setRewardMessenger(address(messenger));
    }

    /// @dev Arm `DAY` and land this chain's funding stamp: fresh halves
    ///      20e18/20e18, recycled halves 10e18/10e18 (see
    ///      {TestMutatorFacet.setDayPoolStampRaw}). Call AFTER
    ///      {_configureMirror} so the stamp lands under the mirror chainid.
    function _armAndStamp() internal {
        _mut().setGovernorCommitArmedFromDayRaw(DAY);
        _mut().setDayPoolStampRaw(DAY, 40e18, 20e18);
    }

    /// @dev Mark the mirror's OWN day-`DAY` interest close as run (production
    ///      stamps this in `closeDay` right after the interest fold) — the
    ///      send path's race guard requires it.
    function _localClose() internal {
        _mut().setChainReportSentAtRaw(DAY, uint64(block.timestamp));
    }

    /// @dev Lender-side demand for `DAY`: total interest 100e18 (so
    ///      Δ_L = (20e18 + 10e18) × 1e18 / 100e18 = 0.3e18), per-entry D1 cap
    ///      15e18. Expected per-ENTRY liability:
    ///        e1: raw 60e18×0.3 = 18e18   → min(18, 15)  = 15e18 (cap-bound)
    ///        e2: raw 25e18×0.3 = 7.5e18  → 7.5e18       (raw-bound)
    ///        e3: raw 15e18×0.3 = 4.5e18  → 4.5e18       (raw-bound)
    ///      → lender liability 27e18.
    function _seedLenderDemand()
        internal
        returns (uint256 e1, uint256 e2, uint256 e3)
    {
        _mut().setDailyLenderInterest(DAY, u1, 0, 100e18);
        _mut().setDayUserSideCapRaw(DAY, 15e18);
        e1 = _mut().pushRewardEntry(
            u1, 1, LibVaipakam.RewardSide.Lender, 60e18, 1
        );
        _mut().setRewardEntryEndDayRaw(e1, 10);
        e2 = _mut().pushRewardEntry(
            u2, 2, LibVaipakam.RewardSide.Lender, 25e18, 1
        );
        _mut().setRewardEntryEndDayRaw(e2, 10);
        e3 = _mut().pushRewardEntry(
            u2, 3, LibVaipakam.RewardSide.Lender, 15e18, 1
        );
        _mut().setRewardEntryEndDayRaw(e3, 10);
    }

    function _ids1(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    function _ids2(
        uint256 a,
        uint256 b
    ) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
    }

    function _ids3(
        uint256 a,
        uint256 b,
        uint256 c
    ) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](3);
        ids[0] = a;
        ids[1] = b;
        ids[2] = c;
    }

    // ═══ Retimed finalize semantics (design doc §2b) ═════════════════════════

    function test_armedFinalize_fullCoverage_noCommitmentInput() public {
        // B2-d1 retiming: the day-`D` report prices from the caps + stamp
        // that finalizeDay(D) itself produces, so readiness must NOT consult
        // commitments — an armed day fast-closes on interest coverage alone.
        _configureCanonical();
        _mut().setGovernorCommitArmedFromDayRaw(DAY);

        messenger.deliverChainReport(CHAIN_BASE, DAY, 0, 0);
        messenger.deliverChainReport(CHAIN_ARB, DAY, 0, 0);
        messenger.deliverChainReport(CHAIN_OP, DAY, 0, 0);

        (bool ready, ) = _agg().isDayReadyToFinalize(DAY);
        assertTrue(ready, "full interest coverage alone => ready");
        _agg().finalizeDay(DAY);

        // Nothing was zeroed, so nothing is remit-ineligible: the mirrors'
        // reports simply arrive later and the d2 remit gate waits for them.
        assertFalse(
            _com().getChainDayCommitments(DAY, CHAIN_ARB).remitIneligible,
            "reported mirror not marked"
        );
        assertFalse(
            _com().getChainDayCommitments(DAY, CHAIN_OP).remitIneligible,
            "reported mirror not marked"
        );

        vm.expectRevert(DayAlreadyFinalized.selector);
        _agg().finalizeDay(DAY);
    }

    function test_singleChain_finalizeUnaffected() public {
        // Single-chain mesh (Base only): armed finalize closes normally.
        vm.chainId(CHAIN_BASE);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(true);
        _rep().setRewardMessenger(address(messenger));
        uint32[] memory chainIds = new uint32[](1);
        chainIds[0] = CHAIN_BASE;
        _agg().setExpectedSourceChainIds(chainIds);
        _mut().setGovernorCommitArmedFromDayRaw(DAY);

        messenger.deliverChainReport(CHAIN_BASE, DAY, 0, 0);
        _agg().finalizeDay(DAY);
        vm.expectRevert(DayAlreadyFinalized.selector);
        _agg().finalizeDay(DAY);
    }

    function test_armedGraceFinalize_zeroedChain_marksIneligible() public {
        // The grace backstop closing over a MISSING interest report zeroes
        // that chain out of the denominator — its ShareOfPool slice was sized
        // without its real demand, so it is remit-ineligible pending operator
        // reconciliation. Chains that DID report are not marked.
        _configureCanonical();
        _mut().setGovernorCommitArmedFromDayRaw(DAY);

        messenger.deliverChainReport(CHAIN_BASE, DAY, 0, 0);
        messenger.deliverChainReport(CHAIN_OP, DAY, 0, 0);
        // ARB's interest report never arrives.

        vm.expectRevert(DayNotReadyToFinalize.selector);
        _agg().finalizeDay(DAY);

        vm.warp(block.timestamp + 4 hours + 1);
        _agg().finalizeDay(DAY); // grace branch zeroes ARB

        assertTrue(
            _com().getChainDayCommitments(DAY, CHAIN_ARB).remitIneligible,
            "zeroed chain marked remit-ineligible"
        );
        assertFalse(
            _com().getChainDayCommitments(DAY, CHAIN_OP).remitIneligible,
            "reported chain NOT marked (its report just arrives later)"
        );
        assertFalse(
            _com().getChainDayCommitments(DAY, CHAIN_BASE).remitIneligible,
            "canonical exempt"
        );

        // The zeroed chain's late report is STILL accepted (it prices at the
        // zero stamp, so it is bookkeeping — not the operator's sizing basis).
        messenger.deliverCommitmentReport(CHAIN_ARB, DAY, 0, 0);
        assertTrue(
            _com().isChainDayCommitmentsComplete(DAY, CHAIN_ARB),
            "late report accepted for the zeroed chain"
        );
    }

    function test_forceFinalize_zeroedChain_marksIneligible() public {
        _configureCanonical();
        _mut().setGovernorCommitArmedFromDayRaw(DAY);

        messenger.deliverChainReport(CHAIN_BASE, DAY, 0, 0);
        messenger.deliverChainReport(CHAIN_OP, DAY, 0, 0);

        _agg().forceFinalizeDay(DAY); // ARB zeroed

        assertTrue(
            _com().getChainDayCommitments(DAY, CHAIN_ARB).remitIneligible,
            "zeroed chain marked"
        );
        assertFalse(
            _com().getChainDayCommitments(DAY, CHAIN_OP).remitIneligible,
            "reported chain stays eligible"
        );
    }

    function test_forceFinalize_unarmedDay_marksNothing() public {
        _configureCanonical();
        messenger.deliverChainReport(CHAIN_ARB, DAY, 0, 0);
        _agg().forceFinalizeDay(DAY); // BASE + OP zeroed, but unarmed
        assertFalse(
            _com().getChainDayCommitments(DAY, CHAIN_OP).remitIneligible,
            "unarmed day never flags remit-ineligible"
        );
    }

    // ═══ Base ingress (B2-d1) ════════════════════════════════════════════════

    function test_ingress_postFinalize_storesReport() public {
        _configureCanonical();
        _mut().setGovernorCommitArmedFromDayRaw(DAY);
        messenger.deliverChainReport(CHAIN_BASE, DAY, 0, 0);
        messenger.deliverChainReport(CHAIN_ARB, DAY, 0, 0);
        messenger.deliverChainReport(CHAIN_OP, DAY, 0, 0);
        _agg().finalizeDay(DAY);

        // Arriving AFTER finalize is the NORMAL sequence (§2b).
        messenger.deliverCommitmentReport(CHAIN_ARB, DAY, 27e18, 30e18);
        LibVaipakam.ChainDayCommitments memory c =
            _com().getChainDayCommitments(DAY, CHAIN_ARB);
        assertTrue(c.complete, "report accepted post-finalize");
        assertEq(c.liabilityLender18, 27e18, "lender liability stored");
        assertEq(c.liabilityBorrower18, 30e18, "borrower liability stored");
        assertTrue(_com().isChainDayCommitmentsComplete(DAY, CHAIN_ARB));

        // A re-delivered (or duplicate) report never rewrites the stored pair.
        messenger.deliverCommitmentReport(CHAIN_ARB, DAY, 1e18, 2e18);
        c = _com().getChainDayCommitments(DAY, CHAIN_ARB);
        assertEq(c.liabilityLender18, 27e18, "re-delivery no-ops");
        assertEq(c.liabilityBorrower18, 30e18, "re-delivery no-ops");
    }

    function test_ingress_dayTopology_survivesExpectedListEdit() public {
        // A chain removed from `expectedSourceChainIds` AFTER day D finalized
        // must still land its historical report: `chainDailyIncluded` proves
        // it was in the finalized denominator, `remitIneligible` proves it
        // was expected-and-zeroed (Codex #1425 r1).
        _configureCanonical();
        _mut().setGovernorCommitArmedFromDayRaw(DAY);
        messenger.deliverChainReport(CHAIN_BASE, DAY, 0, 0);
        messenger.deliverChainReport(CHAIN_ARB, DAY, 0, 0);
        // OP's interest report missing — zeroed + marked at force-finalize.
        _agg().forceFinalizeDay(DAY);
        assertTrue(_com().getChainDayCommitments(DAY, CHAIN_OP).remitIneligible);

        // Shrink the topology to BASE only.
        uint32[] memory chainIds = new uint32[](1);
        chainIds[0] = CHAIN_BASE;
        _agg().setExpectedSourceChainIds(chainIds);

        // Included-then-removed chain: accepted via chainDailyIncluded.
        messenger.deliverCommitmentReport(CHAIN_ARB, DAY, 5e18, 6e18);
        assertTrue(
            _com().isChainDayCommitmentsComplete(DAY, CHAIN_ARB),
            "included chain's historical report accepted after list edit"
        );
        // Zeroed-then-removed chain: accepted via remitIneligible.
        messenger.deliverCommitmentReport(CHAIN_OP, DAY, 0, 0);
        assertTrue(
            _com().isChainDayCommitmentsComplete(DAY, CHAIN_OP),
            "zeroed chain's historical report accepted after list edit"
        );
        // A chain with NO day-D evidence stays rejected.
        vm.expectRevert(SourceChainIdNotExpected.selector);
        messenger.deliverCommitmentReport(999, DAY, 1, 1);
    }

    function test_ingress_guards() public {
        _configureCanonical();

        // Not the registered messenger.
        vm.expectRevert(NotAuthorizedRewardMessenger.selector);
        RewardAggregatorFacet(address(diamond)).onCommitmentReportReceived(
            CHAIN_ARB, DAY, 1, 1
        );

        // Unexpected source chain (no day-D evidence either).
        vm.expectRevert(SourceChainIdNotExpected.selector);
        messenger.deliverCommitmentReport(999, DAY, 1, 1);

        // Non-canonical chain rejects the ingress.
        _rep().setIsCanonicalRewardChain(false);
        vm.expectRevert(NotCanonicalRewardChain.selector);
        messenger.deliverCommitmentReport(CHAIN_ARB, DAY, 1, 1);
    }

    // ═══ Mirror-side accumulation + send (B2-d1) ═════════════════════════════

    function test_mirror_reportFullFlow() public {
        _configureMirror();
        _armAndStamp();
        _localClose();
        (uint256 e1, uint256 e2, uint256 e3) = _seedLenderDemand();

        // Borrower demand: total 200e18 → Δ_B = 30e18×1e18/200e18 = 0.15e18.
        //   b1: raw 100e18×0.15 = 15e18 → exactly the 15e18 cap (boundary)
        //   b2: raw  60e18×0.15 =  9e18 → raw-bound
        //   b3: raw  40e18×0.15 =  6e18 → raw-bound
        // → borrower liability 30e18.
        _mut().setDailyBorrowerInterest(DAY, u1, 0, 200e18);
        uint256 b1 = _mut().pushRewardEntry(
            u1, 4, LibVaipakam.RewardSide.Borrower, 100e18, 1
        );
        _mut().setRewardEntryEndDayRaw(b1, 10);
        uint256 b2 = _mut().pushRewardEntry(
            u2, 5, LibVaipakam.RewardSide.Borrower, 60e18, 1
        );
        _mut().setRewardEntryEndDayRaw(b2, 10);
        uint256 b3 = _mut().pushRewardEntry(
            u3, 6, LibVaipakam.RewardSide.Borrower, 40e18, 1
        );
        _mut().setRewardEntryEndDayRaw(b3, 10);

        assertFalse(_com().isDayCommitmentReady(DAY), "nothing submitted");

        // Lender side in two batches — the entry cursor spans batches.
        _com().submitCommitmentBatch(DAY, 0, _ids1(e1));
        assertFalse(
            _com().isDayCommitmentReady(DAY),
            "lender conservation short => incomplete"
        );
        _com().submitCommitmentBatch(DAY, 0, _ids2(e2, e3));
        assertFalse(
            _com().isDayCommitmentReady(DAY),
            "borrower side still incomplete"
        );

        // Borrower side: all three entries in ONE ascending batch.
        _com().submitCommitmentBatch(DAY, 1, _ids3(b1, b2, b3));

        assertTrue(_com().isDayCommitmentReady(DAY), "both sides complete");

        // The resumability view reflects the walk.
        (uint256 cursor, uint256 liab, uint256 cons) =
            _com().getCommitmentAccumulation(DAY, 0);
        assertEq(cursor, e3, "lender cursor at last entry");
        assertEq(liab, 27e18, "lender liability accumulated");
        assertEq(cons, 100e18, "lender conservation == total");

        vm.deal(address(this), 1 ether);
        assertEq(
            _com().quoteCommitmentReportFee(DAY),
            0,
            "mock quote (quoteNative unset)"
        );
        bytes32 mid = _com().sendCommitmentReport{value: 0.02 ether}(DAY);
        assertEq(
            mid,
            messenger.commitMessageId(),
            "facet surfaces the messenger messageId"
        );
        assertEq(messenger.lastCommitSendDay(), DAY);
        assertEq(
            messenger.lastCommitLiabilityLender18(),
            27e18,
            "lender: min(18,15) + 7.5 + 4.5 per-entry"
        );
        assertEq(
            messenger.lastCommitLiabilityBorrower18(),
            30e18,
            "borrower: 15 (cap-exact) + 9 + 6 (raw-bound)"
        );
        assertEq(messenger.lastCommitRefund(), address(this));
        assertEq(messenger.lastCommitValue(), 0.02 ether);
        assertEq(messenger.commitSendCount(), 1);

        // Whole-day idempotency: no re-send, no late batches.
        assertFalse(_com().isDayCommitmentReady(DAY), "sent => not ready");
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentReportAlreadySent.selector, DAY)
        );
        _com().sendCommitmentReport(DAY);
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentReportAlreadySent.selector, DAY)
        );
        _com().submitCommitmentBatch(DAY, 0, new uint256[](0));
    }

    function test_mirror_zeroDemandDay_sendRevert_staysRetryable() public {
        // A genuinely quiet armed day is trivially complete once the stamp
        // arrived AND the local close ran, and ships (0, 0). A messenger
        // revert rolls the sent flag back (CEI) so the send stays retryable.
        _configureMirror();
        _armAndStamp();
        _localClose();
        assertTrue(
            _com().isDayCommitmentReady(DAY),
            "quiet stamped locally-closed day trivially complete"
        );

        messenger.setRevertOnSend(true);
        vm.expectRevert("MockMessenger: send revert");
        _com().sendCommitmentReport(DAY);
        assertTrue(
            _com().isDayCommitmentReady(DAY),
            "failed send rolls the sent flag back"
        );

        messenger.setRevertOnSend(false);
        _com().sendCommitmentReport(DAY);
        assertEq(messenger.lastCommitLiabilityLender18(), 0);
        assertEq(messenger.lastCommitLiabilityBorrower18(), 0);
        assertFalse(_com().isDayCommitmentReady(DAY));
    }

    function test_mirror_submitAndSendGuards() public {
        _configureMirror();
        uint256[] memory none = new uint256[](0);

        // Unarmed day: nothing to report, never ready.
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentDayNotArmed.selector, DAY)
        );
        _com().submitCommitmentBatch(DAY, 0, none);
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentDayNotArmed.selector, DAY)
        );
        _com().sendCommitmentReport(DAY);
        assertFalse(
            _com().isDayCommitmentReady(DAY),
            "unarmed quiet day must NOT look ready (0 == 0 conservation)"
        );

        // Armed but the funding stamp has not arrived.
        _mut().setGovernorCommitArmedFromDayRaw(DAY);
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentStampNotArrived.selector, DAY)
        );
        _com().submitCommitmentBatch(DAY, 0, none);
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentStampNotArrived.selector, DAY)
        );
        _com().sendCommitmentReport(DAY);
        assertFalse(_com().isDayCommitmentReady(DAY), "no stamp => not ready");

        // Armed + stamped but this mirror's OWN interest close never ran
        // (the Codex #1425 r1 zeroed-chain race): the day LOOKS quiet
        // (totals 0) yet the once-only (0,0) send must be impossible.
        _mut().setDayPoolStampRaw(DAY, 40e18, 20e18);
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentDayNotLocallyClosed.selector, DAY)
        );
        _com().sendCommitmentReport(DAY);
        assertFalse(
            _com().isDayCommitmentReady(DAY),
            "no local close => not ready (pre-close race guard)"
        );

        // Batch submission is KEEPER_ROLE-gated (anti-grief: an id-skipping
        // submission would wedge conservation behind the ascending cursor).
        vm.prank(alice);
        vm.expectRevert();
        _com().submitCommitmentBatch(DAY, 0, none);
    }

    function test_mirror_readiness_requiresMirrorAndWiring() public {
        // Codex #1425 r1: the readiness predicate must be false wherever the
        // send would revert — the canonical chain, and an un-wired mirror.
        _configureCanonical();
        _mut().setGovernorCommitArmedFromDayRaw(DAY);
        _mut().setDayPoolStampRaw(DAY, 40e18, 20e18);
        _mut().setChainReportSentAtRaw(DAY, uint64(block.timestamp));
        assertFalse(
            _com().isDayCommitmentReady(DAY),
            "canonical chain is never commitment-ready"
        );

        // Mirror flags but NO messenger wired: send reverts, so not ready.
        vm.chainId(CHAIN_ARB);
        _rep().setIsCanonicalRewardChain(false);
        _rep().setRewardMessenger(address(0));
        _mut().setDayPoolStampRaw(DAY, 40e18, 20e18); // stamp under ARB id
        assertFalse(
            _com().isDayCommitmentReady(DAY),
            "un-wired mirror is never commitment-ready"
        );
    }

    function test_mirror_surfaceRevertsOnCanonical() public {
        _configureCanonical();
        uint256[] memory none = new uint256[](0);
        vm.expectRevert(CommitmentReportOnlyMirror.selector);
        _com().submitCommitmentBatch(DAY, 0, none);
        vm.expectRevert(CommitmentReportOnlyMirror.selector);
        _com().sendCommitmentReport(DAY);
        vm.expectRevert(CommitmentReportOnlyMirror.selector);
        _com().resetCommitmentAccumulation(DAY, 0);
        vm.expectRevert(CommitmentReportOnlyMirror.selector);
        _com().quoteCommitmentReportFee(DAY);
    }

    function test_mirror_entryCursorMonotonic() public {
        _configureMirror();
        _armAndStamp();
        _localClose();
        (uint256 e1, uint256 e2, uint256 e3) = _seedLenderDemand();

        // Later ids first is legal; the cursor then bars anything <= e3.
        _com().submitCommitmentBatch(DAY, 0, _ids2(e2, e3));

        vm.expectRevert(
            abi.encodeWithSelector(CommitmentEntriesNotAscending.selector, e1)
        );
        _com().submitCommitmentBatch(DAY, 0, _ids1(e1));

        vm.expectRevert(
            abi.encodeWithSelector(CommitmentEntriesNotAscending.selector, e2)
        );
        _com().submitCommitmentBatch(DAY, 0, _ids2(e2, e3));

        // Within-batch: descending pair on the untouched borrower side.
        uint256 b1 = _mut().pushRewardEntry(
            u1, 4, LibVaipakam.RewardSide.Borrower, 10e18, 1
        );
        _mut().setRewardEntryEndDayRaw(b1, 10);
        uint256 b2 = _mut().pushRewardEntry(
            u2, 5, LibVaipakam.RewardSide.Borrower, 10e18, 1
        );
        _mut().setRewardEntryEndDayRaw(b2, 10);
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentEntriesNotAscending.selector, b1)
        );
        _com().submitCommitmentBatch(DAY, 1, _ids2(b2, b1));

        // A duplicate id inside a batch is the same ascending violation.
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentEntriesNotAscending.selector, b1)
        );
        _com().submitCommitmentBatch(DAY, 1, _ids2(b1, b1));
    }

    function test_mirror_entryValidation() public {
        _configureMirror();
        _armAndStamp();
        _localClose();
        (uint256 e1, , ) = _seedLenderDemand();

        // Entry on the other side.
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentEntryMismatch.selector, e1)
        );
        _com().submitCommitmentBatch(DAY, 1, _ids1(e1));

        // Window: entry ends AT the day (dayId >= endDay).
        uint256 e4 = _mut().pushRewardEntry(
            u1, 7, LibVaipakam.RewardSide.Lender, 7e18, 1
        );
        _mut().setRewardEntryEndDayRaw(e4, uint32(DAY));
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentEntryMismatch.selector, e4)
        );
        _com().submitCommitmentBatch(DAY, 0, _ids1(e4));

        // Window: entry starts after the day.
        uint256 e5 = _mut().pushRewardEntry(
            u1, 8, LibVaipakam.RewardSide.Lender, 7e18, uint32(DAY + 2)
        );
        _mut().setRewardEntryEndDayRaw(e5, 10);
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentEntryMismatch.selector, e5)
        );
        _com().submitCommitmentBatch(DAY, 0, _ids1(e5));

        // A nonexistent id decodes as a zeroed entry (endDay 0) — rejected.
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentEntryMismatch.selector, 999)
        );
        _com().submitCommitmentBatch(DAY, 0, _ids1(999));
    }

    function test_mirror_skippedEntry_wedges_resetRecovers() public {
        _configureMirror();
        _armAndStamp();
        _localClose();
        (uint256 e1, uint256 e2, uint256 e3) = _seedLenderDemand();

        // Keeper MIS-submission: e2 skipped below the consumed cursor.
        // Per-entry validation passes for e1+e3, but conservation is
        // permanently short (75e18 != 100e18) and e2 is now unreachable.
        _com().submitCommitmentBatch(DAY, 0, _ids2(e1, e3));
        assertFalse(
            _com().isDayCommitmentReady(DAY),
            "conservation short => never completes"
        );
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentEntriesNotAscending.selector, e2)
        );
        _com().submitCommitmentBatch(DAY, 0, _ids1(e2));

        // ADMIN valve: wipe the (day, side) accumulation and resubmit fully.
        vm.prank(alice);
        vm.expectRevert();
        _com().resetCommitmentAccumulation(DAY, 0); // admin-gated

        _com().resetCommitmentAccumulation(DAY, 0);
        _com().submitCommitmentBatch(DAY, 0, _ids3(e1, e2, e3));
        assertTrue(
            _com().isDayCommitmentReady(DAY),
            "reset + full resubmission completes"
        );

        // The recovered figure equals the clean-path liability.
        vm.deal(address(this), 1 ether);
        _com().sendCommitmentReport{value: 0.01 ether}(DAY);
        assertEq(messenger.lastCommitLiabilityLender18(), 27e18);

        // Reset after send is blocked (the report is out).
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentReportAlreadySent.selector, DAY)
        );
        _com().resetCommitmentAccumulation(DAY, 0);
    }

    // ═══ Reconciliation ══════════════════════════════════════════════════════

    function test_reconcile_clearsRemitIneligible() public {
        _configureCanonical();
        _mut().setGovernorCommitArmedFromDayRaw(DAY);
        messenger.deliverChainReport(CHAIN_ARB, DAY, 0, 0);
        _agg().forceFinalizeDay(DAY); // OP zeroed => marked
        assertTrue(_com().getChainDayCommitments(DAY, CHAIN_OP).remitIneligible);

        _com().reconcileCommitmentRemitEligibility(DAY, CHAIN_OP);
        assertFalse(
            _com().getChainDayCommitments(DAY, CHAIN_OP).remitIneligible,
            "operator reconciliation clears the flag"
        );
    }

    function test_reconcile_requiresAdmin() public {
        _configureCanonical();
        vm.prank(alice);
        vm.expectRevert();
        _com().reconcileCommitmentRemitEligibility(DAY, CHAIN_ARB);
    }

    function test_reconcile_requiresCanonical() public {
        // The facet is cut on mirror Diamonds too, but the remit-ineligible
        // flag is authoritative on Base — a mirror-chain reconcile must revert
        // rather than silently clear an unused local mapping (Codex #1422 r4).
        vm.chainId(CHAIN_ARB);
        _rep().setIsCanonicalRewardChain(false);
        vm.expectRevert(NotCanonicalRewardChain.selector);
        _com().reconcileCommitmentRemitEligibility(DAY, CHAIN_ARB);
    }

    // ═══ Default state ═══════════════════════════════════════════════════════

    function test_views_defaultUnreported() public {
        _configureCanonical();
        assertFalse(
            _com().isChainDayCommitmentsComplete(DAY, CHAIN_ARB),
            "complete defaults false until the mirror's report lands"
        );
        LibVaipakam.ChainDayCommitments memory c =
            _com().getChainDayCommitments(DAY, CHAIN_ARB);
        assertFalse(c.complete, "struct complete false");
        assertFalse(c.remitIneligible, "struct remitIneligible false");
        assertEq(c.liabilityLender18, 0, "no liability reported");
        assertEq(c.liabilityBorrower18, 0, "no liability reported");
    }
}
