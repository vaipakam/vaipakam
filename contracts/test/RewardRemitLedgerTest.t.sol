// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {MockCrossChainMessenger} from "./mocks/MockCrossChainMessenger.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/**
 * @title RewardRemitLedgerTest — #1222 M3 B2-d2 delivered-backing ledger.
 * @notice Exercises the reservation lifecycle (Pending → Acked / Released),
 *         the mirror ack surface, the armed-day commitment REMIT GATE +
 *         Σcommitments clamp (shared across all three remit sites), the
 *         terminal day-close commitment retirement/residual release, and the
 *         evidenced manual-budget path for zeroed chains.
 */
contract RewardRemitLedgerTest is SetupTest {
    RewardRemittanceFacet internal remit;
    MockRewardMessenger internal rewardMessenger; // data path (reports + acks)
    MockCrossChainMessenger internal ccip; // value path (token remittance)
    VPFIToken internal vpfiTok;
    TestMutatorFacet internal mutator;

    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    uint32 internal constant CHAIN_OP = 10;

    address internal stranger = address(0xCAFE);

    event RemitReservationAcked(
        uint256 indexed remitId,
        uint32 indexed dstChainId,
        uint256 total,
        uint256 amountReceived,
        bool forced
    );
    event RemitAckAfterRelease(
        uint256 indexed remitId,
        uint32 indexed srcChainId,
        uint256 amountReceived
    );

    function setUp() public {
        setupHelper();

        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                VPFIToken.initialize,
                (address(this), address(this), address(this))
            )
        );
        vpfiTok = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfiTok));
        vpfiTok.mint(address(this), 100_000_000 ether);
        vpfiTok.transfer(address(diamond), 100_000_000 ether);

        rewardMessenger = new MockRewardMessenger(address(diamond));
        ccip = new MockCrossChainMessenger();
        remit = RewardRemittanceFacet(address(diamond));
        mutator = TestMutatorFacet(address(diamond));

        vm.chainId(CHAIN_BASE);
        RewardReporterFacet rep = RewardReporterFacet(address(diamond));
        rep.setBaseChainId(CHAIN_BASE);
        rep.setIsCanonicalRewardChain(true);
        rep.setRewardMessenger(address(rewardMessenger));
        TreasuryFacet(address(diamond)).setCrossChainMessenger(address(ccip));

        uint32[] memory chainIds = new uint32[](3);
        chainIds[0] = CHAIN_BASE;
        chainIds[1] = CHAIN_ARB;
        chainIds[2] = CHAIN_OP;
        RewardAggregatorFacet(address(diamond)).setExpectedSourceChainIds(chainIds);

        vm.deal(address(this), 10 ether);
        vm.deal(stranger, 10 ether);
    }

    // ─── helpers ──────────────────────────────────────────────────────────

    function _finalizeDay(uint256 d) internal {
        rewardMessenger.deliverChainReport(CHAIN_BASE, d, 10e18, 5e18);
        rewardMessenger.deliverChainReport(CHAIN_ARB, d, 20e18, 10e18);
        rewardMessenger.deliverChainReport(CHAIN_OP, d, 30e18, 15e18);
        RewardAggregatorFacet(address(diamond)).finalizeDay(d);
    }

    function _days(uint256 d) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = d;
    }

    /// @dev Arm day `d` AFTER its (unarmed) finalization and seed ARB's
    ///      per-(day, chain) funding stamp so the armed slice path prices
    ///      from it. `freshHalf`/`recycledEquiv` shape the slice sources.
    function _armDayForArb(
        uint256 d,
        uint128 freshHalf,
        uint256 recycledEquiv
    ) internal {
        mutator.setGovernorCommitArmedFromDayRaw(d);
        mutator.setDayPoolStampRaw(d, uint128(freshHalf) * 2, 0);
        mutator.setChainDayFundingRaw(d, CHAIN_ARB, freshHalf, recycledEquiv);
    }

    /// @dev Remit day-1 to ARB with a generous cap, returning the sent total.
    function _remitDay1ToArb() internal returns (uint256 total) {
        (total, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        remit.remitRewardBudget{value: 0.01 ether}(CHAIN_ARB, _days(1), 69_000_000 ether);
    }

    function _outstanding()
        internal
        view
        returns (uint256 fresh, uint256 recycled, uint256 paidOut)
    {
        (, fresh, recycled, paidOut) =
            RewardAggregatorFacet(address(diamond)).getGovernorCommitState();
    }

    // ─── reservation lifecycle (pre-cutover days: no gate, no clamp) ──────

    function test_Remit_CreatesPendingReservation() public {
        _finalizeDay(1);
        uint256 total = _remitDay1ToArb();
        assertGt(total, 0, "non-zero slice");

        assertEq(remit.getRemitReservationNonce(), 1, "nonce");
        LibVaipakam.RemitReservation memory r = remit.getRemitReservation(1);
        assertEq(uint256(r.status), 1, "pending");
        assertEq(r.dstChainId, CHAIN_ARB, "dst");
        assertEq(r.total, total, "total");
        assertEq(r.fresh, total, "pre-cutover slice is fresh-only");
        assertEq(r.recycled, 0, "no recycled");
        assertEq(r.dayIds.length, 1, "one closed day");
        assertEq(r.dayIds[0], 1, "day 1");

        // messageId annotation + reverse index (mock id is deterministic).
        bytes32 expectedId = keccak256(abi.encode(address(ccip), uint256(0)));
        assertEq(r.ccipMessageId, expectedId, "ccip message id");
        assertEq(remit.getRemitIdByMessageId(expectedId), 1, "reverse index");

        assertEq(remit.getRemitPendingTotal(CHAIN_ARB), total, "pending total");
        assertEq(remit.getRemitAckedTotal(CHAIN_ARB), 0, "acked 0");
        assertEq(remit.getDayClosedByRemitId(CHAIN_ARB, 1), 1, "day closed by 1");

        // The widened payload carries the echo remitId.
        (, uint256[] memory pd, uint256 pt, uint256 prid, , ) = abi.decode(
            ccip.sentPayload(0),
            (uint256, uint256[], uint256, uint256, address, uint256)
        );
        assertEq(pd.length, 1, "payload days");
        assertEq(pt, total, "payload total");
        assertEq(prid, 1, "payload remitId");
    }

    function test_Ack_FinalizesReservation_Idempotently() public {
        _finalizeDay(1);
        uint256 total = _remitDay1ToArb();

        vm.expectEmit(true, true, false, true, address(diamond));
        emit RemitReservationAcked(1, CHAIN_ARB, total, total, false);
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, total);

        LibVaipakam.RemitReservation memory r = remit.getRemitReservation(1);
        assertEq(uint256(r.status), 2, "acked");
        assertEq(remit.getRemitPendingTotal(CHAIN_ARB), 0, "pending cleared");
        assertEq(remit.getRemitAckedTotal(CHAIN_ARB), total, "acked total");

        // Re-delivered ack: exactly-once (no revert, no double count).
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, total);
        assertEq(remit.getRemitAckedTotal(CHAIN_ARB), total, "still once");
    }

    function test_Ack_WrongChain_Reverts() public {
        _finalizeDay(1);
        _remitDay1ToArb();
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RemitAckChainMismatch.selector,
                1,
                CHAIN_ARB,
                CHAIN_OP
            )
        );
        rewardMessenger.deliverRemitAck(CHAIN_OP, 1, 1e18);
    }

    function test_Ack_UnknownReservation_Reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RemitReservationNotPending.selector,
                99
            )
        );
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 99, 1e18);
    }

    function test_Ack_OnlyMessenger() public {
        _finalizeDay(1);
        _remitDay1ToArb();
        vm.prank(stranger);
        vm.expectRevert(IVaipakamErrors.NotAuthorizedRewardMessenger.selector);
        remit.onRemitAckReceived(CHAIN_ARB, 1, 1e18, address(diamond));
    }

    function test_ForceFinalize_AdminValve() public {
        _finalizeDay(1);
        uint256 total = _remitDay1ToArb();

        vm.prank(stranger);
        vm.expectRevert();
        remit.finalizeRemitReservation(1);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit RemitReservationAcked(1, CHAIN_ARB, total, 0, true);
        remit.finalizeRemitReservation(1);
        assertEq(uint256(remit.getRemitReservation(1).status), 2, "acked");

        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RemitReservationNotPending.selector,
                1
            )
        );
        remit.finalizeRemitReservation(1);
    }

    function test_Release_RestoresLedgers_and_DayRefunds() public {
        _finalizeDay(1);
        uint256 total = _remitDay1ToArb();
        assertEq(remit.getRewardBudgetRemittedGlobal(), total, "fresh reserved");

        // r5 — the release valve is timeout-gated (§M3): too early reverts.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RemitReleaseTooEarly.selector,
                1,
                block.timestamp + 7 days
            )
        );
        remit.releaseRemitReservation(1);
        vm.warp(block.timestamp + 7 days);
        remit.releaseRemitReservation(1);

        LibVaipakam.RemitReservation memory r = remit.getRemitReservation(1);
        assertEq(uint256(r.status), 3, "released");
        assertEq(remit.getRewardBudgetRemitted(CHAIN_ARB, 1), 0, "day re-opened");
        assertEq(remit.getDayClosedByRemitId(CHAIN_ARB, 1), 0, "close cleared");
        // Codex r4 — the fresh counters stay RESERVED (the sent tokens are
        // physically outside Diamond custody; re-opening 69M headroom would
        // let the re-remit draw commingled custody as "fresh").
        assertEq(remit.getRewardBudgetRemittedGlobal(), total, "global reserved");
        assertEq(
            remit.getRewardBudgetRemittedTotal(CHAIN_ARB),
            total,
            "chain cumulative kept"
        );
        assertEq(remit.getRemitPendingTotal(CHAIN_ARB), 0, "pending cleared");

        // The re-opened day funds again under a NEW reservation, consuming
        // NEW fresh headroom (two real outflows happened).
        uint256 total2 = _remitDay1ToArb();
        assertEq(total2, total, "same slice re-funds");
        assertEq(
            remit.getRewardBudgetRemittedGlobal(),
            total * 2,
            "re-remit consumes new headroom"
        );
        assertEq(remit.getRemitReservationNonce(), 2, "second reservation");
        assertEq(remit.getDayClosedByRemitId(CHAIN_ARB, 1), 2, "closed by 2");

        // A late ack for the RELEASED reservation is surfaced, never
        // re-finalized (the operator released in error — double funding).
        vm.expectEmit(true, true, false, true, address(diamond));
        emit RemitAckAfterRelease(1, CHAIN_ARB, total);
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, total);
        assertEq(uint256(remit.getRemitReservation(1).status), 3, "still released");
        assertEq(remit.getRemitAckedTotal(CHAIN_ARB), 0, "not acked");
    }

    function test_Release_RequiresPending() public {
        _finalizeDay(1);
        uint256 total = _remitDay1ToArb();
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, total);
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RemitReservationNotPending.selector,
                1
            )
        );
        remit.releaseRemitReservation(1);
    }

    // ─── armed-day remit gate + Σcommitments clamp ────────────────────────

    function test_Gate_ArmedDayWaitsForCompleteReport() public {
        _finalizeDay(1);
        _armDayForArb(1, 100e18, 0);

        // No commitment report yet: the day contributes 0 at every site —
        // delays, never zeroes.
        (uint256 qt, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        assertEq(qt, 0, "gated quote");
        // Codex r1 — the batch planner distinguishes GATED (not actionable)
        // from close-only (actionable at zero): while gated, closeable=false.
        (uint256[] memory pa, bool[] memory pc) =
            remit.quoteRemitDayPlans(CHAIN_ARB, _days(1));
        assertEq(pa[0], 0, "planner amount gated");
        assertFalse(pc[0], "planner not closeable while gated");
        (uint256 fee, uint256 ft) = remit.quoteRemittanceFee(CHAIN_ARB, _days(1));
        assertEq(fee + ft, 0, "gated fee quote");
        vm.expectRevert(RewardRemittanceFacet.NothingToRemit.selector);
        remit.remitRewardBudget{value: 0.01 ether}(CHAIN_ARB, _days(1), 1e24);

        // Report lands (liability far above the slice) → the day funds fully.
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 1e30, 1e30);
        (uint256 qt2, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        assertGt(qt2, 0, "ungated");
        uint256 total = _remitDay1ToArb();
        assertEq(total, qt2, "quote == send");
    }

    function test_Clamp_BoundsSliceByReportedLiability() public {
        _finalizeDay(1);
        _armDayForArb(1, 100e18, 0); // fresh-only slice

        uint256 liabL = 2e18;
        uint256 liabB = 1e18;
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, liabL, liabB);

        (uint256 quoted, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        assertEq(quoted, liabL + liabB, "clamped to sum liability");

        mutator.setOutstandingCommitRaw(1_000e18, 0);
        (, uint256 f0, , ) =
            RewardAggregatorFacet(address(diamond)).getGovernorCommitState();

        uint256 total = _remitDay1ToArb();
        assertEq(total, liabL + liabB, "sent the clamp");
        assertEq(
            remit.getRewardBudgetRemitted(CHAIN_ARB, 1),
            liabL + liabB,
            "day marked with the clamped amount"
        );

        // The FULL pre-clamp armed fresh retired (remitted + residual are
        // both dead once the day terminally closes).
        LibVaipakam.RemitReservation memory r = remit.getRemitReservation(1);
        assertGt(r.armedFreshFull, r.fresh, "residual existed");
        (, uint256 f1, , ) =
            RewardAggregatorFacet(address(diamond)).getGovernorCommitState();
        assertEq(f0 - f1, r.armedFreshFull, "full fresh commitment retired");
    }

    function test_Clamp_RecycledShare_ConsumesAndReleasesResidual() public {
        _finalizeDay(1);
        _armDayForArb(1, 0, 50e18); // recycled-only slice
        mutator.setRecycleBucketRaw(1_000e18);
        mutator.setOutstandingCommitRaw(0, 1_000e18);

        uint256 liab = 3e18;
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, liab, 0);

        (uint256 quoted, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        assertEq(quoted, liab, "clamped");

        uint256 total = _remitDay1ToArb();
        assertEq(total, liab, "sent the clamp");

        LibVaipakam.RemitReservation memory r = remit.getRemitReservation(1);
        assertEq(r.recycled, liab, "recycled clamped share");
        assertGt(r.recycledFull, r.recycled, "recycled residual existed");

        // Bucket debited ONLY by the clamped share; paidOut tracks it; the
        // FULL pre-clamp recycled commitment retired (consume + residual
        // release together).
        assertEq(
            ConfigFacet(address(diamond)).getRecycleBucket(),
            1_000e18 - liab,
            "bucket debit = clamped only"
        );
        (, , uint256 outRecycled, uint256 paidOut) =
            RewardAggregatorFacet(address(diamond)).getGovernorCommitState();
        assertEq(paidOut, liab, "paidOutRecycled = clamped");
        assertEq(
            1_000e18 - outRecycled,
            r.recycledFull,
            "full recycled commitment retired"
        );
    }

    function test_Clamp_ZeroLiability_ClosesDayWithoutSend() public {
        _finalizeDay(1);
        _armDayForArb(1, 100e18, 0);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 0, 0);

        (uint256 quoted, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        assertEq(quoted, 0, "zero clamp");
        // Codex r1 — the planner is how a keeper DISCOVERS the close-only
        // day: zero amount but closeable=true (quoteRewardBudget alone
        // cannot distinguish it from a gated/closed day).
        (uint256[] memory pa, bool[] memory pc) =
            remit.quoteRemitDayPlans(CHAIN_ARB, _days(1));
        assertEq(pa[0], 0, "planner zero amount");
        assertTrue(pc[0], "planner closeable");

        uint256 sendsBefore = ccip.sentCount();
        uint256 balBefore = address(this).balance;
        remit.remitRewardBudget{value: 0.01 ether}(CHAIN_ARB, _days(1), 1e24);

        assertEq(ccip.sentCount(), sendsBefore, "nothing dispatched");
        assertEq(address(this).balance, balBefore, "full fee refunded");
        assertEq(remit.getRewardBudgetRemitted(CHAIN_ARB, 1), 0, "no amount mark");
        assertEq(remit.getDayClosedByRemitId(CHAIN_ARB, 1), 1, "day CLOSED");
        LibVaipakam.RemitReservation memory r = remit.getRemitReservation(1);
        assertEq(uint256(r.status), 2, "born terminal");
        assertEq(r.total, 0, "zero total");

        // Closed forever: a repeat is NothingToRemit, and the planner no
        // longer marks the day actionable.
        (, bool[] memory pc2) = remit.quoteRemitDayPlans(CHAIN_ARB, _days(1));
        assertFalse(pc2[0], "planner closed");
        vm.expectRevert(RewardRemittanceFacet.NothingToRemit.selector);
        remit.remitRewardBudget{value: 0.01 ether}(CHAIN_ARB, _days(1), 1e24);
    }

    function test_QuoteEqualsSend_MixedBatch() public {
        _finalizeDay(1);
        _finalizeDay(2);
        // Day 2 armed + clamped; day 1 stays pre-cutover (armedFrom = 2).
        mutator.setGovernorCommitArmedFromDayRaw(2);
        mutator.setDayPoolStampRaw(2, 200e18, 0);
        mutator.setChainDayFundingRaw(2, CHAIN_ARB, 100e18, 0);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 2, 1e18, 1e18);

        uint256[] memory both = new uint256[](2);
        both[0] = 1;
        both[1] = 2;
        (uint256 quoted, uint256[] memory perDay) =
            remit.quoteRewardBudget(CHAIN_ARB, both);
        assertGt(perDay[0], 0, "day1 funds");
        assertEq(perDay[1], 2e18, "day2 clamped");

        (, uint256 feeTotal) = remit.quoteRemittanceFee(CHAIN_ARB, both);
        assertEq(feeTotal, quoted, "fee-quote total == quote");

        remit.remitRewardBudget{value: 0.01 ether}(CHAIN_ARB, both, 1e24);
        LibVaipakam.RemitReservation memory r = remit.getRemitReservation(1);
        assertEq(r.total, quoted, "send == quote");
        assertEq(r.dayIds.length, 2, "both days closed");
    }

    /// @dev Codex r6 — the 69M guard is NET of outstanding armed-fresh
    ///      commitments (minus what the batch itself retires): after a
    ///      release keeps the sent amount counted while restoring the
    ///      obligation, a gross check would let a re-remit push total
    ///      issuance past the cap by the stranded amount.
    function test_FreshNetHeadroom_EncumberedByOutstandingCommitments() public {
        _finalizeDay(1);
        (uint256 quoted, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        assertGt(quoted, 0, "slice exists");
        mutator.setOutstandingCommitRaw(69_000_000 ether, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceFacet.RewardPoolCapExceeded.selector,
                quoted,
                0
            )
        );
        remit.remitRewardBudget{value: 0.01 ether}(CHAIN_ARB, _days(1), 1e24);
        // Clearing the encumbrance restores the send.
        mutator.setOutstandingCommitRaw(0, 0);
        uint256 total = _remitDay1ToArb();
        assertEq(total, quoted, "funds once unencumbered");
    }

    /// @dev Codex #1430 r1 (d3) — the reported liability covers the
    ///      mirror's WHOLE day-D claimable liability, part of which the
    ///      chain already backs from its own locally-committed recycled
    ///      share. The clamp must therefore bound the remittance by
    ///      `liability - localBacking`, or Base backs `local + liability`
    ///      for at most `liability` of claims.
    function test_Clamp_AccountsForMirrorLocalBacking() public {
        _finalizeDay(1);
        _armDayForArb(1, 0, 50e18); // recycled-only slice
        mutator.setRecycleBucketRaw(1_000e18);

        // The chain locally committed 4 VPFI of this day's recycled slice
        // (stamped by the funding resolution; netted out of the slice).
        mutator.setChainDayFundingLocalCommitRaw(1, CHAIN_ARB, 4e18);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 10e18, 0);

        // Recycled-only pool: the whole liability is a recycled leg, so the
        // local backing nets against it in full. Liability 10, local 4 → 6.
        (uint256 quoted, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        assertEq(quoted, 6e18, "clamped by liability NET of local backing");

        uint256 total = _remitDay1ToArb();
        assertEq(total, 6e18, "send matches the net-of-local clamp");
    }

    /// @dev Codex #1430 r2 (d3) — the netting must be PER FUNDING SOURCE.
    ///      The mirror's claim path splits every payout pro-rata over the
    ///      day's fresh:recycled composition, so local RECYCLED backing can
    ///      only cover the recycled leg — never the fresh leg Base funds in
    ///      full. Netting against the aggregate liability would strand the
    ///      fresh claims unbacked on a terminally-closed day.
    function test_Clamp_NetsLocalBackingPerFundingSource() public {
        _finalizeDay(1);
        // Pool composition on ARB: 90 fresh / 10 recycled (gross).
        // `_armDayForArb` stamps the equivs; the local commit is part of the
        // GROSS recycled pool, so the net slice carries the remainder.
        _armDayForArb(1, 45e18, 10e18); // freshHalf x2 = 90 fresh, 10 recycled
        mutator.setRecycleBucketRaw(1_000e18);
        mutator.setChainDayFundingLocalCommitRaw(1, CHAIN_ARB, 10e18);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 5e18, 0);

        // Gross pool on ARB for this day: 30 fresh + 6.67 recycled, plus the
        // 10 local commit = 40 gross (the local share is part of the pool the
        // claim path prices against). Liability 5 splits pro-rata → fresh leg
        // 5 x 30/40 = 3.75, recycled leg 1.25 (fully covered by the local 10).
        //
        // This is the discriminating assertion: netting against the AGGREGATE
        // liability (5 - 10 -> 0) would remit ZERO and strand the 3.75 of
        // fresh claims unbacked on a terminally-closed day.
        // Per-side (Codex r3): the liability sits entirely on the LENDER
        // side, whose composition is 15 fresh : 3.33 recycled (fresh-heavier
        // than the day aggregate). Liability 5 → fresh leg 5 x 15/18.33 =
        // 4.09, recycled leg 0.91, and the 10 of local backing covers that
        // recycled leg entirely. Pricing against the day AGGREGATE instead
        // would understate the fresh leg at 3.75 — the exact mispricing r3
        // identified.
        (uint256 quoted, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        assertApproxEqAbs(
            quoted, 4.0909e18, 1e15, "fresh leg on the LENDER composition"
        );

        uint256 total = _remitDay1ToArb();
        assertEq(total, quoted, "send matches the per-source clamp");
        LibVaipakam.RemitReservation memory r = remit.getRemitReservation(1);
        assertEq(r.recycled, 0, "recycled leg fully covered by local backing");
        assertEq(r.fresh, total, "the remittance is the fresh leg");
    }

    /// @dev Codex #1430 r3 (d3) — the clamp runs PER SIDE. The mirror
    ///      reports lender/borrower liabilities separately and the two sides
    ///      carry different fresh:recycled compositions, so a liability
    ///      concentrated on one side must be priced against THAT side's
    ///      composition. Here the whole liability sits on the lender side;
    ///      an aggregate clamp would blend the borrower side's composition
    ///      into the fresh/recycled split and misprice both legs.
    function test_Clamp_PricesEachSideAgainstItsOwnComposition() public {
        _finalizeDay(1);
        _armDayForArb(1, 45e18, 10e18);
        mutator.setRecycleBucketRaw(1_000e18);

        // All liability on the LENDER side, none on the borrower side.
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 5e18, 0);

        (uint256 quoted, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        // Lender side gross: 15 fresh + 3.33 recycled = 18.33; liability 5
        // → fresh leg 5 x 15/18.33 = 4.09, recycled leg 0.91. Borrower side
        // contributes nothing (zero liability). No local commit here, so the
        // whole per-side clamp remits.
        assertApproxEqAbs(quoted, 5e18, 1e15, "clamped to the lender-side liability");

        uint256 total = _remitDay1ToArb();
        assertEq(total, quoted, "send matches the per-side clamp");
        LibVaipakam.RemitReservation memory r = remit.getRemitReservation(1);
        // The split follows the LENDER side's composition (15:3.33), not the
        // day aggregate.
        assertApproxEqAbs(r.fresh, 4.09e18, 2e16, "fresh leg on lender composition");
        assertApproxEqAbs(r.recycled, 0.91e18, 2e16, "recycled leg on lender composition");
    }

    // ─── manual-budget path (zeroed chains) ───────────────────────────────

    function test_Manual_RequiresIneligibleFlag() public {
        _finalizeDay(1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RemitDayNotManualEligible.selector,
                1,
                CHAIN_ARB
            )
        );
        remit.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 5e18);
    }

    function test_Manual_FundsThroughTheLedger() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);

        uint256 amount = 5e18;
        remit.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, amount);

        LibVaipakam.RemitReservation memory r = remit.getRemitReservation(1);
        assertEq(uint256(r.status), 1, "pending");
        assertEq(r.total, amount, "amount");
        assertEq(r.fresh, amount, "fresh-funded");
        assertEq(r.recycled, 0, "no recycled draw");
        assertEq(r.armedFreshFull, 0, "no commitment retired");
        assertEq(remit.getRewardBudgetRemitted(CHAIN_ARB, 1), amount, "day marked");
        assertEq(remit.getDayClosedByRemitId(CHAIN_ARB, 1), 1, "day closed");
        assertEq(remit.getRewardBudgetRemittedGlobal(), amount, "69M reserved");

        // Payload rode the token channel with the echo id.
        (, uint256[] memory pd, uint256 pt, uint256 prid, , ) = abi.decode(
            ccip.sentPayload(0),
            (uint256, uint256[], uint256, uint256, address, uint256)
        );
        assertEq(pd[0], 1, "day");
        assertEq(pt, amount, "total");
        assertEq(prid, 1, "remitId");

        // Ack finalizes like any remit.
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, amount);
        assertEq(uint256(remit.getRemitReservation(1).status), 2, "acked");

        // A second manual send for the same (chain, day) is blocked.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RemitDayAlreadyClosed.selector,
                1,
                CHAIN_ARB
            )
        );
        remit.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, amount);
    }

    function test_Manual_AdminOnly() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert();
        remit.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 5e18);
    }

    // ─── mirror-side receipt + ack send ───────────────────────────────────

    /// @dev Reconfigure the SAME diamond as a mirror (matches the d1
    ///      commitment-test convention: one deploy, role flipped).
    function _configureMirror() internal {
        vm.chainId(CHAIN_ARB);
        RewardReporterFacet rep = RewardReporterFacet(address(diamond));
        rep.setIsCanonicalRewardChain(false);
        rep.setBaseChainId(CHAIN_BASE);
        remit.setRewardRemittanceReceiver(address(this));
    }

    function test_MirrorIngress_RecordsReceipt_and_AckIsResendable() public {
        _configureMirror();

        remit.onRewardBudgetReceived(
            address(vpfiTok), 7e18, _days(3), CHAIN_BASE, 42, address(0xBA5E), 0
        );
        LibVaipakam.ReceivedRemit memory rec =
            remit.getReceivedRemit(address(0xBA5E), 42);
        assertEq(rec.srcChainId, CHAIN_BASE, "src");
        assertEq(rec.amount, 7e18, "amount");
        assertGt(rec.receivedAt, 0, "stamped");

        uint256 fee = remit.quoteRemitAckFee(42, address(0xBA5E));
        remit.sendRemitAck{value: fee}(42, address(0xBA5E), payable(address(this)));
        assertEq(rewardMessenger.lastAckRemitId(), 42, "echoed id");
        assertEq(rewardMessenger.lastAckAmount(), 7e18, "mirror-computed amount");
        assertEq(
            rewardMessenger.lastAckRemitter(),
            address(0xBA5E),
            "echoes the receipt's payload-recorded remitter"
        );

        // Re-sendable: the lost-ack retry lever.
        remit.sendRemitAck{value: fee}(42, address(0xBA5E), payable(address(this)));
        assertEq(rewardMessenger.ackSendCount(), 2, "re-sent");
    }

    function test_MirrorIngress_LegacyDeliveryHasNoReceipt() public {
        _configureMirror();
        remit.onRewardBudgetReceived(
            address(vpfiTok), 7e18, _days(3), CHAIN_BASE, 0, address(0xBA5E), 0
        );
        assertEq(
            remit.getReceivedRemit(address(0xBA5E), 0).receivedAt,
            0,
            "no receipt for 0"
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ReceivedRemitNotFound.selector,
                0
            )
        );
        remit.sendRemitAck{value: 0.001 ether}(
            0, address(0xBA5E), payable(address(this))
        );
    }

    /// @dev Codex r2 — a receipt is bound to the Base deployment that sent
    ///      it; after an owner base-chain rotation the ack must not route a
    ///      stale receipt toward the NEW base (remit ids are per-deployment
    ///      and could finalize an unrelated same-numbered reservation).
    function test_SendRemitAck_RejectsStaleReceiptAfterBaseRotation() public {
        _configureMirror();
        remit.onRewardBudgetReceived(
            address(vpfiTok), 7e18, _days(3), CHAIN_BASE, 42, address(0xBA5E), 0
        );
        // Owner rotates the canonical deployment.
        RewardReporterFacet(address(diamond)).setBaseChainId(999);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ReceivedRemitStale.selector,
                42,
                CHAIN_BASE
            )
        );
        remit.sendRemitAck{value: 0.001 ether}(
            42, address(0xBA5E), payable(address(this))
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ReceivedRemitStale.selector,
                42,
                CHAIN_BASE
            )
        );
        remit.quoteRemitAckFee(42, address(0xBA5E));
    }

    /// @dev Codex r3 — an ack naming a sender other than THIS deployment is
    ///      rejected: remit ids are per-deployment, so a stale-era receipt
    ///      (recorded under a pre-rotation canonical, possibly on the SAME
    ///      chain id) must never finalize a same-numbered reservation here.
    function test_Ack_RejectsForeignDeploymentSender() public {
        _finalizeDay(1);
        uint256 total = _remitDay1ToArb();
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RemitAckSenderMismatch.selector,
                1,
                address(0x0DD)
            )
        );
        rewardMessenger.deliverRemitAckFrom(CHAIN_ARB, 1, total, address(0x0DD));
        assertEq(uint256(remit.getRemitReservation(1).status), 1, "still pending");
    }

    /// @dev Codex r3/r4 — receipts key by (remitter, remitId): different
    ///      canonical deployments' same-numbered receipts CO-EXIST under
    ///      distinct keys (no collision, no supersession ordering, no
    ///      delayed-delivery overwrite), and each ack routes independently
    ///      with its own recorded remitter.
    function test_MirrorIngress_DeploymentReceiptsCoexist() public {
        _configureMirror();
        remit.onRewardBudgetReceived(
            address(vpfiTok), 7e18, _days(3), CHAIN_BASE, 42, address(0x01D), 0
        );
        remit.onRewardBudgetReceived(
            address(vpfiTok), 9e18, _days(4), CHAIN_BASE, 42, address(0x2EF), 0
        );
        assertEq(
            remit.getReceivedRemit(address(0x01D), 42).amount,
            7e18,
            "old-era receipt intact"
        );
        assertEq(
            remit.getReceivedRemit(address(0x2EF), 42).amount,
            9e18,
            "new-era receipt co-exists"
        );
        // Per-key first-write-wins (a delayed duplicate cannot overwrite).
        remit.onRewardBudgetReceived(
            address(vpfiTok), 1e18, _days(5), CHAIN_BASE, 42, address(0x2EF), 0
        );
        assertEq(
            remit.getReceivedRemit(address(0x2EF), 42).amount,
            9e18,
            "first-wins per key"
        );
        // Each receipt's ack echoes ITS remitter.
        remit.sendRemitAck{value: 0.001 ether}(
            42, address(0x01D), payable(address(this))
        );
        assertEq(rewardMessenger.lastAckRemitter(), address(0x01D), "old echo");
        remit.sendRemitAck{value: 0.001 ether}(
            42, address(0x2EF), payable(address(this))
        );
        assertEq(rewardMessenger.lastAckRemitter(), address(0x2EF), "new echo");
    }

    /// @dev Codex r2 — a released recycled-bearing day must NOT re-remit
    ///      while its bucket backing is stranded outside Diamond custody:
    ///      the backing filter leaves the day open (not actionable) until
    ///      governance returns the tokens and re-credits the bucket.
    function test_Release_RecycledDay_WaitsForBackingBeforeReRemit() public {
        _finalizeDay(1);
        _armDayForArb(1, 0, 50e18); // recycled-only slice
        mutator.setRecycleBucketRaw(1_000e18);
        uint256 liab = 3e18;
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, liab, 0);

        uint256 total = _remitDay1ToArb();
        assertEq(total, liab, "first remit clamped");
        vm.warp(block.timestamp + 7 days);
        remit.releaseRemitReservation(1);
        assertEq(remit.getDayClosedByRemitId(CHAIN_ARB, 1), 0, "day re-opened");

        // Backing gone (stranded in the CCIP pool): the day is NOT
        // actionable at any planning site — no close, no quote, no remit.
        mutator.setRecycleBucketRaw(liab - 1);
        (uint256[] memory pa, bool[] memory pc) =
            remit.quoteRemitDayPlans(CHAIN_ARB, _days(1));
        assertEq(pa[0], 0, "under-backed amount 0");
        assertFalse(pc[0], "under-backed not actionable");
        (uint256 qt, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        assertEq(qt, 0, "under-backed quote 0");
        vm.expectRevert(RewardRemittanceFacet.NothingToRemit.selector);
        remit.remitRewardBudget{value: 0.01 ether}(CHAIN_ARB, _days(1), 1e24);

        // Backing returns (governance recovery + custody re-credit): the
        // day funds again and the bucket is debited by the clamped share.
        mutator.setRecycleBucketRaw(100e18);
        uint256 total2 = _remitDay1ToArb();
        assertEq(total2, liab, "re-remit after backing returns");
        assertEq(
            ConfigFacet(address(diamond)).getRecycleBucket(),
            100e18 - liab,
            "bucket debited by the clamped share"
        );
    }

    function test_SendRemitAck_MirrorOnly() public {
        // Canonical config from setUp.
        vm.expectRevert(IVaipakamErrors.OnlyMirrorRewardChain.selector);
        remit.sendRemitAck{value: 0.001 ether}(
            1, address(0xBA5E), payable(address(this))
        );
    }

    // ─── B2-d5: relocated-custody credit at remit arrival ─────────────────

    /// @dev The core d5 shape: an arriving remit's RECYCLED share credits the
    ///      mirror's bucket (so the claim path's `consume(paidRecycled)` has
    ///      real backing) while staying OUT of both Ā-feeding figures — the
    ///      day-bucket AND the cumulative this chain reports to Base.
    function test_D5_CustodyCredit_BacksBucket_ButFeedsNeitherAFigure() public {
        _configureMirror();
        ConfigFacet cfg = ConfigFacet(address(diamond));

        // Give the mirror some GENUINE local absorption first, so the test
        // distinguishes "excluded" from "trivially zero".
        mutator.setRecycleBucketRaw(40e18);
        mutator.setRecycleCreditedCumulativeRaw(40e18);
        (uint256 dayNow, ) = InteractionRewardsLensFacet(address(diamond))
            .getInteractionCurrentDay();
        uint256 dayBucketBefore = cfg.getRecycledCreditedByDay(dayNow);
        uint256 reportedBefore = cfg.getRecycleCreditedCumulative();
        assertEq(reportedBefore, 40e18, "precondition: genuine absorption");

        // Base tops up 23 recycled inside a 30-token delivery.
        remit.onRewardBudgetReceived(
            address(vpfiTok), 30e18, _days(3), CHAIN_BASE, 42, address(0xBA5E),
            23e18
        );

        // Bucket grew by exactly the recycled share — the claim path is backed.
        assertEq(cfg.getRecycleBucket(), 63e18, "bucket takes the top-up");
        // ...but neither Ā-feeding figure moved.
        assertEq(
            cfg.getRecycledCreditedByDay(dayNow),
            dayBucketBefore,
            "day-bucket (A-bar's per-day feed) untouched"
        );
        assertEq(
            cfg.getRecycleCreditedCumulative(),
            reportedBefore,
            "reported cumulative untouched despite the bucket growing"
        );

        (uint256 relocated, uint256 bucket, uint256 reported) =
            RewardAggregatorFacet(address(diamond))
                .getRecycleCustodyPosition();
        assertEq(relocated, 23e18, "custody counter records the relocation");
        assertEq(bucket, 63e18, "position reports the live bucket");
        assertEq(reported, 40e18, "position reports the netted cumulative");
    }

    /// @dev THE load-bearing invariant (design record §2f.2). Base derives a
    ///      mirror's committable local funding as `reported − consumed`. If
    ///      relocated custody reached `reported`, Base would re-offer its own
    ///      already-spent top-up as that mirror's OWN funding and commit it
    ///      twice. The exclusion must survive the tokens being CONSUMED,
    ///      because `creditedCumulative` derives a floor from
    ///      `recycleBucket + paidOutRecycled` — consuming moves the custody
    ///      value from one term of that sum into the other.
    function test_D5_ReportedCumulativeSurvivesConsume_NoPhantomAvailability()
        public
    {
        _configureMirror();
        ConfigFacet cfg = ConfigFacet(address(diamond));

        mutator.setRecycleBucketRaw(40e18);
        mutator.setRecycleCreditedCumulativeRaw(40e18);

        remit.onRewardBudgetReceived(
            address(vpfiTok), 23e18, _days(3), CHAIN_BASE, 42, address(0xBA5E),
            23e18
        );
        assertEq(cfg.getRecycleBucket(), 63e18, "backed");

        // The mirror's claims now consume the WHOLE recycled payout — the
        // 40 it absorbed itself plus the 23 Base delivered.
        mutator.consumeRecycleRaw(63e18);
        assertEq(cfg.getRecycleBucket(), 0, "bucket drained by claims");

        // The reported cumulative must still be 40: this chain absorbed 40,
        // full stop. Without the custody subtraction the derived floor
        // (`0 + 63`) would report 63 and hand Base 23 of phantom
        // availability on the very next day.
        assertEq(
            cfg.getRecycleCreditedCumulative(),
            40e18,
            "reports only GENUINE absorption after the custody tokens are consumed"
        );
    }

    /// @dev A payload cannot claim more recycled backing than it delivered —
    ///      the Diamond's own bound, independent of the receiver's scaling.
    function test_D5_Ingress_RejectsRecycledShareAboveDelivery() public {
        _configureMirror();
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RecycledShareExceedsDelivery.selector,
                8e18,
                7e18
            )
        );
        remit.onRewardBudgetReceived(
            address(vpfiTok), 7e18, _days(3), CHAIN_BASE, 42, address(0xBA5E),
            8e18
        );
    }

    /// @dev Backward-decodability: a delayed pre-d5 delivery arrives with a
    ///      zero share and must relocate NO custody — degrading to the old
    ///      behaviour rather than mis-crediting.
    function test_D5_LegacyShapedDelivery_RelocatesNoCustody() public {
        _configureMirror();
        ConfigFacet cfg = ConfigFacet(address(diamond));
        mutator.setRecycleBucketRaw(40e18);

        remit.onRewardBudgetReceived(
            address(vpfiTok), 7e18, _days(3), CHAIN_BASE, 0, address(0xBA5E), 0
        );

        assertEq(cfg.getRecycleBucket(), 40e18, "bucket unchanged");
        (uint256 relocated, , ) = RewardAggregatorFacet(address(diamond))
            .getRecycleCustodyPosition();
        assertEq(relocated, 0, "no custody relocated");
    }

    // ─── #1444 / #1446: externally verifiable bucket accounting ───────────

    /// @dev Read the composition view and re-derive both published figures
    ///      from the raw slots, exactly as `ops/mesh-watcher` does. Returning
    ///      the re-derivation (rather than asserting inside) keeps each test's
    ///      failure message about ITS invariant.
    function _composition()
        internal
        view
        returns (
            uint256 raw,
            uint256 releasedFull,
            uint256 releasedSent,
            uint256 relocated,
            uint256 bucket,
            uint256 reported,
            uint256 paidOut,
            uint256 outstanding
        )
    {
        RewardAggregatorFacet agg = RewardAggregatorFacet(address(diamond));
        (raw, releasedFull, releasedSent) = agg.getRecycleCompositionPosition();
        (relocated, bucket, reported) = agg.getRecycleCustodyPosition();
        (, , outstanding, paidOut) = agg.getGovernorCommitState();
    }

    /// @dev The composition bound of #1446, as an external checker computes
    ///      it: every credit lands in the bucket exactly once, so the two
    ///      cumulative counters can never exceed where the tokens went.
    function _assertComposition(string memory ctx) internal view {
        (
            uint256 raw,
            ,
            uint256 releasedSent,
            uint256 relocated,
            uint256 bucket,
            ,
            uint256 paidOut,

        ) = _composition();
        assertLe(
            raw + relocated,
            bucket + paidOut + releasedSent,
            string.concat("composition: raw+relocated <= bucket+paidOut+releasedSent @ ", ctx)
        );
    }

    /// @dev The derivation of #1446: the REPORTED cumulative must be
    ///      reproducible from the raw slots by an outside party. If the
    ///      library stopped netting relocated custody out of the floor, the
    ///      reported figure and Base's accepted copy would inflate together
    ///      and no cross-chain comparison could see it — this one can.
    function _assertDerivation(string memory ctx) internal view {
        (
            uint256 raw,
            ,
            ,
            uint256 relocated,
            uint256 bucket,
            uint256 reported,
            uint256 paidOut,

        ) = _composition();
        uint256 gross = bucket + paidOut;
        uint256 floorTerm = gross > relocated ? gross - relocated : 0;
        uint256 expected = raw >= floorTerm ? raw : floorTerm;
        assertEq(
            reported,
            expected,
            string.concat("derivation: reported == max(raw, bucket+paidOut-relocated) @ ", ctx)
        );
    }

    /// @dev Set up a recycled-only armed slice to ARB with a residual, remit
    ///      it, and return the reservation's pre-clamp / clamped recycled
    ///      figures. `bucket` and `outstanding` both start at 1_000e18.
    function _remitRecycledWithResidual()
        internal
        returns (uint256 recycledFull, uint256 recycledSent)
    {
        _finalizeDay(1);
        _armDayForArb(1, 0, 50e18); // recycled-only slice
        mutator.setRecycleBucketRaw(1_000e18);
        mutator.setRecycleCreditedCumulativeRaw(1_000e18);
        mutator.setOutstandingCommitRaw(0, 1_000e18);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 3e18, 0);
        _remitDay1ToArb();
        LibVaipakam.RemitReservation memory r = remit.getRemitReservation(1);
        assertGt(r.recycledFull, r.recycled, "fixture: residual must exist");
        return (r.recycledFull, r.recycled);
    }

    /// @dev #1444 — a release records what it moved. This is the ONE
    ///      primitive that shifts a recycled ledger figure with no matching
    ///      token movement, so without these counters an outside checker
    ///      cannot tell intended recovery from ledger corruption.
    function test_Release_RecordsBothReleasedRemitCumulatives() public {
        (uint256 recycledFull, uint256 recycledSent) =
            _remitRecycledWithResidual();

        (uint256 rawBefore, uint256 fullBefore, uint256 sentBefore) =
            RewardAggregatorFacet(address(diamond))
                .getRecycleCompositionPosition();
        assertEq(fullBefore, 0, "no release yet");
        assertEq(sentBefore, 0, "no release yet");

        vm.warp(block.timestamp + 7 days);
        remit.releaseRemitReservation(1);

        (uint256 raw, uint256 releasedFull, uint256 releasedSent) =
            RewardAggregatorFacet(address(diamond))
                .getRecycleCompositionPosition();
        assertEq(
            releasedFull,
            recycledFull,
            "records the PRE-clamp total whose commitment it restored"
        );
        assertEq(
            releasedSent,
            recycledSent,
            "records the paidOut reversal for the CLAMPED share actually sent"
        );
        assertEq(raw, rawBefore, "release is not absorption");

        (, , , uint256 paidOut) =
            RewardAggregatorFacet(address(diamond)).getGovernorCommitState();
        assertEq(paidOut, 0, "the clamped share was never paid to anyone");
    }

    /// @dev #1444 — the point of the counter. After a release the plain
    ///      relation `bucket >= outstanding` is FALSE on correct, intended
    ///      behaviour, which is why bucket coverage could only ship as a
    ///      canonical advisory. Adding the released term restores a HARD
    ///      relation that holds on both chain roles, so the watcher pages on
    ///      one rule instead of splitting severity by role.
    function test_Coverage_ReleasedTermRestoresTheHardRelation() public {
        (uint256 recycledFull, ) = _remitRecycledWithResidual();
        vm.warp(block.timestamp + 7 days);
        remit.releaseRemitReservation(1);

        (, uint256 releasedFull, , , uint256 bucket, , , uint256 outstanding) =
            _composition();

        // The naive form is genuinely violated here — assert that, so this
        // test fails if the release path ever stops being able to produce
        // the state the released term exists to explain.
        assertLt(bucket, outstanding, "precondition: naive coverage IS broken");
        assertGe(
            bucket + releasedFull,
            outstanding,
            "#1444: bucket + releasedRemitFull covers the reservations"
        );
        assertEq(releasedFull, recycledFull, "the released term is the cause");
    }

    /// @dev #1446 — the composition and derivation bounds across the
    ///      canonical chain's full lifecycle: credit, consume (via the remit
    ///      send), commitment release, and the released-remit restore.
    function test_Composition_HoldsAcrossTheCanonicalLifecycle() public {
        _assertComposition("genesis");
        _assertDerivation("genesis");

        _remitRecycledWithResidual();
        _assertComposition("after remit consume + residual release");
        _assertDerivation("after remit consume + residual release");

        vm.warp(block.timestamp + 7 days);
        remit.releaseRemitReservation(1);
        _assertComposition("after released-remit restore");
        _assertDerivation("after released-remit restore");
    }

    /// @dev #1446 — the mirror half, and the case the check exists for.
    ///      Relocated custody raises the bucket without advancing the
    ///      reported cumulative; if `creditCustodyRelocated` ever ALSO
    ///      advanced `recycleCreditedCumulative`, the left side of the
    ///      composition bound would jump by twice the credit against a right
    ///      side that moved once. Comparing the reported figure against
    ///      Base's copy cannot see that — both derive from the same helper.
    function test_Composition_HoldsAcrossRelocatedCustodyAndConsume() public {
        _configureMirror();
        mutator.setRecycleBucketRaw(40e18);
        mutator.setRecycleCreditedCumulativeRaw(40e18);
        _assertComposition("mirror genesis");
        _assertDerivation("mirror genesis");

        // Base tops up 23 recycled inside a 30-token delivery.
        remit.onRewardBudgetReceived(
            address(vpfiTok), 30e18, _days(3), CHAIN_BASE, 42, address(0xBA5E),
            23e18
        );
        (uint256 raw, , , uint256 relocated, uint256 bucket, , , ) =
            _composition();
        assertEq(relocated, 23e18, "fixture: custody relocated");
        assertEq(bucket, 63e18, "fixture: bucket took the top-up");
        // ORDER IS DELIBERATE: the composition bound is asserted BEFORE the
        // precise `raw` fixture check, because the bound is what
        // `ops/mesh-watcher` actually evaluates — it has no fixture knowledge
        // of what `raw` "should" be. Asserting the fixture first would let a
        // mutation be caught by an oracle the watcher does not have, and this
        // test would then overstate what is externally detectable.
        _assertComposition("after relocation");
        _assertDerivation("after relocation");
        assertEq(raw, 40e18, "the RAW counter must not move on relocation");

        // Consuming moves the custody value from one term of the derived
        // floor into the other — the exclusion has to survive that.
        mutator.consumeRecycleRaw(63e18);
        assertEq(
            ConfigFacet(address(diamond)).getRecycleBucket(), 0, "drained"
        );
        _assertComposition("after consuming the relocated tokens");
        _assertDerivation("after consuming the relocated tokens");
    }

    /// @dev Accept ETH refunds from the remit fee path.
    receive() external payable {}
}
