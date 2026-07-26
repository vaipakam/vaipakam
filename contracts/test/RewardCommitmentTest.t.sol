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
///         mirror-side keeper-fed accumulation (demand-conservation
///         completeness, strictly-ascending user cursor, mirror-recomputed
///         figures), the once-per-day dispatch to Base, the Base ingress that
///         stores the per-side liabilities (the B2-d2 remit-gate input), and
///         the retimed finalize semantics: finalization has NO commitment
///         input (the report is only computable from the caps + stamp that
///         finalize itself produces — design doc §2b), and `remitIneligible`
///         marks chains ZEROED out of the interest denominator, not chains
///         whose report is merely still in flight.
contract RewardCommitmentTest is SetupTest, IVaipakamErrors {
    MockRewardMessenger internal messenger;

    address internal alice;
    // Strictly ascending commitment users (sorted in setUp).
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
        (u1, u2, u3) = _sort3(
            makeAddr("carol"),
            makeAddr("dave"),
            makeAddr("erin")
        );
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

    function _sort3(
        address a,
        address b,
        address c
    ) private pure returns (address, address, address) {
        if (a > b) (a, b) = (b, a);
        if (b > c) (b, c) = (c, b);
        if (a > b) (a, b) = (b, a);
        return (a, b, c);
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

    /// @dev Lender-side demand for `DAY`: total interest 100e18 (so
    ///      Δ_L = (20e18 + 10e18) × 1e18 / 100e18 = 0.3e18), per-user D1 cap
    ///      15e18, `u2` already paid 5e18. Expected per-user liability:
    ///        u1: raw 60e18×0.3 = 18e18 → min(18, 15−0)  = 15e18 (cap-bound)
    ///        u2: raw 40e18×0.3 = 12e18 → min(12, 15−5)  = 10e18 (paid-reduced)
    ///      → lender liability 25e18.
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
        _mut().setUserSideDayPaidRaw(u2, 0, DAY, 5e18);
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

    function _batch1(
        address user,
        uint256[] memory ids
    )
        internal
        pure
        returns (address[] memory users, uint256[][] memory entryIds)
    {
        users = new address[](1);
        users[0] = user;
        entryIds = new uint256[][](1);
        entryIds[0] = ids;
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

        // The zeroed chain's late report is STILL accepted — it stores the
        // exact liability figure the operator needs to size the manual remit.
        messenger.deliverCommitmentReport(CHAIN_ARB, DAY, 7e18, 8e18);
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
        messenger.deliverCommitmentReport(CHAIN_ARB, DAY, 25e18, 30e18);
        LibVaipakam.ChainDayCommitments memory c =
            _com().getChainDayCommitments(DAY, CHAIN_ARB);
        assertTrue(c.complete, "report accepted post-finalize");
        assertEq(c.liabilityLender18, 25e18, "lender liability stored");
        assertEq(c.liabilityBorrower18, 30e18, "borrower liability stored");
        assertTrue(_com().isChainDayCommitmentsComplete(DAY, CHAIN_ARB));

        // A re-delivered (or duplicate) report never rewrites the stored pair.
        messenger.deliverCommitmentReport(CHAIN_ARB, DAY, 1e18, 2e18);
        c = _com().getChainDayCommitments(DAY, CHAIN_ARB);
        assertEq(c.liabilityLender18, 25e18, "re-delivery no-ops");
        assertEq(c.liabilityBorrower18, 30e18, "re-delivery no-ops");
    }

    function test_ingress_guards() public {
        _configureCanonical();

        // Not the registered messenger.
        vm.expectRevert(NotAuthorizedRewardMessenger.selector);
        RewardAggregatorFacet(address(diamond)).onCommitmentReportReceived(
            CHAIN_ARB, DAY, 1, 1
        );

        // Unexpected source chain.
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
        (uint256 e1, uint256 e2, uint256 e3) = _seedLenderDemand();

        // Borrower demand: total 200e18 → Δ_B = 30e18×1e18/200e18 = 0.15e18.
        //   u1: raw 100e18×0.15 = 15e18 → exactly the 15e18 cap (boundary)
        //   u2: raw  60e18×0.15 =  9e18 → raw-bound
        //   u3: raw  40e18×0.15 =  6e18 → raw-bound
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

        // Lender side in two batches — the cursor spans batches.
        (address[] memory us, uint256[][] memory ids) = _batch1(u1, _ids1(e1));
        _com().submitCommitmentBatch(DAY, 0, us, ids);
        assertFalse(
            _com().isDayCommitmentReady(DAY),
            "lender conservation short => incomplete"
        );
        (us, ids) = _batch1(u2, _ids2(e2, e3));
        _com().submitCommitmentBatch(DAY, 0, us, ids);
        assertFalse(
            _com().isDayCommitmentReady(DAY),
            "borrower side still incomplete"
        );

        // Borrower side: all three users in ONE ascending batch.
        address[] memory bu = new address[](3);
        bu[0] = u1;
        bu[1] = u2;
        bu[2] = u3;
        uint256[][] memory bids = new uint256[][](3);
        bids[0] = _ids1(b1);
        bids[1] = _ids1(b2);
        bids[2] = _ids1(b3);
        _com().submitCommitmentBatch(DAY, 1, bu, bids);

        assertTrue(_com().isDayCommitmentReady(DAY), "both sides complete");

        vm.deal(address(this), 1 ether);
        bytes32 mid = _com().sendCommitmentReport{value: 0.02 ether}(DAY);
        assertEq(
            mid,
            messenger.commitMessageId(),
            "facet surfaces the messenger messageId"
        );
        assertEq(messenger.lastCommitSendDay(), DAY);
        assertEq(
            messenger.lastCommitLiabilityLender18(),
            25e18,
            "lender: min(18,15) + min(12,15-5)"
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
        (us, ids) = _batch1(u3, new uint256[](0));
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentReportAlreadySent.selector, DAY)
        );
        _com().submitCommitmentBatch(DAY, 0, us, ids);
    }

    function test_mirror_zeroDemandDay_sendRevert_staysRetryable() public {
        // A genuinely quiet armed day is trivially complete once the stamp
        // arrives and ships (0, 0). A messenger revert rolls the sent flag
        // back (CEI) so the send stays retryable.
        _configureMirror();
        _armAndStamp();
        assertTrue(
            _com().isDayCommitmentReady(DAY),
            "quiet stamped day trivially complete"
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
        (address[] memory us, uint256[][] memory ids) =
            _batch1(u1, new uint256[](0));

        // Unarmed day: nothing to report, never ready.
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentDayNotArmed.selector, DAY)
        );
        _com().submitCommitmentBatch(DAY, 0, us, ids);
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentDayNotArmed.selector, DAY)
        );
        _com().sendCommitmentReport(DAY);
        assertFalse(
            _com().isDayCommitmentReady(DAY),
            "unarmed quiet day must NOT look ready (0 == 0 conservation)"
        );

        // Armed but the funding stamp has not arrived: the pre-close race
        // guard — totals may not be folded yet, so a (0,0) send must be
        // impossible.
        _mut().setGovernorCommitArmedFromDayRaw(DAY);
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentStampNotArrived.selector, DAY)
        );
        _com().submitCommitmentBatch(DAY, 0, us, ids);
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentStampNotArrived.selector, DAY)
        );
        _com().sendCommitmentReport(DAY);
        assertFalse(
            _com().isDayCommitmentReady(DAY),
            "no stamp => not ready (pre-close race guard)"
        );

        // Batch submission is KEEPER_ROLE-gated (anti-grief: a partial-set
        // submission would consume the user cursor and wedge conservation).
        _mut().setDayPoolStampRaw(DAY, 40e18, 20e18);
        vm.prank(alice);
        vm.expectRevert();
        _com().submitCommitmentBatch(DAY, 0, us, ids);
    }

    function test_mirror_surfaceRevertsOnCanonical() public {
        _configureCanonical();
        (address[] memory us, uint256[][] memory ids) =
            _batch1(u1, new uint256[](0));
        vm.expectRevert(CommitmentReportOnlyMirror.selector);
        _com().submitCommitmentBatch(DAY, 0, us, ids);
        vm.expectRevert(CommitmentReportOnlyMirror.selector);
        _com().sendCommitmentReport(DAY);
        vm.expectRevert(CommitmentReportOnlyMirror.selector);
        _com().resetCommitmentAccumulation(DAY, 0);
    }

    function test_mirror_cursorMonotonic() public {
        _configureMirror();
        _armAndStamp();
        (uint256 e1, uint256 e2, uint256 e3) = _seedLenderDemand();

        // u2 first is fine; the cursor then bars anything <= u2.
        (address[] memory us, uint256[][] memory ids) =
            _batch1(u2, _ids2(e2, e3));
        _com().submitCommitmentBatch(DAY, 0, us, ids);

        (us, ids) = _batch1(u1, _ids1(e1));
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentUsersNotAscending.selector, u1)
        );
        _com().submitCommitmentBatch(DAY, 0, us, ids);

        (us, ids) = _batch1(u2, _ids2(e2, e3));
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentUsersNotAscending.selector, u2)
        );
        _com().submitCommitmentBatch(DAY, 0, us, ids);

        // Within-batch ordering on the untouched borrower side.
        address[] memory us2 = new address[](2);
        us2[0] = u2;
        us2[1] = u1;
        uint256[][] memory ids2 = new uint256[][](2);
        ids2[0] = new uint256[](0);
        ids2[1] = new uint256[](0);
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentUsersNotAscending.selector, u1)
        );
        _com().submitCommitmentBatch(DAY, 1, us2, ids2);
    }

    function test_mirror_entryValidation() public {
        _configureMirror();
        _armAndStamp();
        (uint256 e1, uint256 e2, ) = _seedLenderDemand();

        // Entry owned by another user.
        (address[] memory us, uint256[][] memory ids) = _batch1(u1, _ids1(e2));
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentEntryMismatch.selector, e2)
        );
        _com().submitCommitmentBatch(DAY, 0, us, ids);

        // Entry on the other side.
        (us, ids) = _batch1(u1, _ids1(e1));
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentEntryMismatch.selector, e1)
        );
        _com().submitCommitmentBatch(DAY, 1, us, ids);

        // Window: entry ends AT the day (dayId >= endDay).
        uint256 e4 = _mut().pushRewardEntry(
            u1, 7, LibVaipakam.RewardSide.Lender, 7e18, 1
        );
        _mut().setRewardEntryEndDayRaw(e4, uint32(DAY));
        (us, ids) = _batch1(u1, _ids1(e4));
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentEntryMismatch.selector, e4)
        );
        _com().submitCommitmentBatch(DAY, 0, us, ids);

        // Window: entry starts after the day.
        uint256 e5 = _mut().pushRewardEntry(
            u1, 8, LibVaipakam.RewardSide.Lender, 7e18, uint32(DAY + 2)
        );
        _mut().setRewardEntryEndDayRaw(e5, 10);
        (us, ids) = _batch1(u1, _ids1(e5));
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentEntryMismatch.selector, e5)
        );
        _com().submitCommitmentBatch(DAY, 0, us, ids);

        // Within-batch duplicate entry id (would double-count both sums).
        (us, ids) = _batch1(u1, _ids2(e1, e1));
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentEntryMismatch.selector, e1)
        );
        _com().submitCommitmentBatch(DAY, 0, us, ids);

        // users/entryIds length mismatch.
        us = new address[](1);
        us[0] = u1;
        ids = new uint256[][](0);
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentEntryMismatch.selector, 0)
        );
        _com().submitCommitmentBatch(DAY, 0, us, ids);
    }

    function test_mirror_partialSubmission_wedges_resetRecovers() public {
        _configureMirror();
        _armAndStamp();
        (uint256 e1, uint256 e2, uint256 e3) = _seedLenderDemand();

        // Keeper MIS-submission: u2 lands with only half its entry set.
        // Per-entry validation passes, but conservation is permanently short
        // (85e18 != 100e18) and u2's cursor slot is consumed.
        (address[] memory us, uint256[][] memory ids) = _batch1(u1, _ids1(e1));
        _com().submitCommitmentBatch(DAY, 0, us, ids);
        (us, ids) = _batch1(u2, _ids1(e2)); // e3 missing!
        _com().submitCommitmentBatch(DAY, 0, us, ids);

        assertFalse(
            _com().isDayCommitmentReady(DAY),
            "conservation short => never completes"
        );
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentUsersNotAscending.selector, u2)
        );
        _com().submitCommitmentBatch(DAY, 0, us, ids); // cursor bars repair

        // ADMIN valve: wipe the (day, side) accumulation and resubmit fully.
        vm.prank(alice);
        vm.expectRevert();
        _com().resetCommitmentAccumulation(DAY, 0); // admin-gated

        _com().resetCommitmentAccumulation(DAY, 0);
        (us, ids) = _batch1(u1, _ids1(e1));
        _com().submitCommitmentBatch(DAY, 0, us, ids);
        (us, ids) = _batch1(u2, _ids2(e2, e3));
        _com().submitCommitmentBatch(DAY, 0, us, ids);
        assertTrue(
            _com().isDayCommitmentReady(DAY),
            "reset + full resubmission completes"
        );

        // The recovered figure equals the clean-path liability.
        vm.deal(address(this), 1 ether);
        _com().sendCommitmentReport{value: 0.01 ether}(DAY);
        assertEq(messenger.lastCommitLiabilityLender18(), 25e18);

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
