// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {Vm} from "forge-std/Vm.sol";
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
            uint256 releasedStranded,
            bool seeded,
            uint256 relocated,
            uint256 bucket,
            uint256 reported,
            uint256 paidOut,
            uint256 outstanding
        )
    {
        RewardAggregatorFacet agg = RewardAggregatorFacet(address(diamond));
        (raw, releasedStranded, seeded, ) = agg.getRecycleCompositionPosition();
        (relocated, bucket, reported) = agg.getRecycleCustodyPosition();
        (, , outstanding, paidOut) = agg.getGovernorCommitState();
    }

    /// @dev The composition bound of #1446, as an external checker computes
    ///      it: every credit lands in the bucket exactly once, so the two
    ///      cumulative counters can never exceed where the tokens went.
    function _assertComposition(string memory ctx) internal view {
        (
            uint256 raw,
            uint256 releasedStranded,
            bool seeded,
            uint256 relocated,
            uint256 bucket,
            ,
            uint256 paidOut,

        ) = _composition();
        assertLe(
            raw + relocated,
            bucket + paidOut + releasedStranded,
            string.concat("composition: raw+relocated <= bucket+paidOut+stranded @ ", ctx)
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

        (uint256 rawBefore, uint256 strandedBefore, , bool canonBefore) =
            RewardAggregatorFacet(address(diamond))
                .getRecycleCompositionPosition();
        assertEq(strandedBefore, 0, "no release yet");
        assertTrue(canonBefore, "fixture: this diamond is the canonical chain");

        vm.warp(block.timestamp + 7 days);
        remit.releaseRemitReservation(1);

        (uint256 raw, uint256 stranded, , ) =
            RewardAggregatorFacet(address(diamond))
                .getRecycleCompositionPosition();
        // Codex #1448 r1 P1 — the SENT share, never the pre-clamp total. The
        // residual was retired by `releaseCommitment` without moving tokens,
        // so it is still sitting in the bucket; recording the full figure
        // would count it twice and hand the coverage check
        // `recycledFull - recycledSent` of backing that does not exist.
        assertEq(
            stranded,
            recycledSent,
            "records the paidOut reversal: what actually left the bucket"
        );
        assertLt(
            stranded,
            recycledFull,
            "and NOT the pre-clamp commitment restored (fixture has a residual)"
        );
        assertEq(raw, rawBefore, "release is not absorption");

        (, , , uint256 paidOut) =
            RewardAggregatorFacet(address(diamond)).getGovernorCommitState();
        assertEq(paidOut, 0, "the clamped share was never paid to anyone");
    }

    /// @dev #1444 — the point of the counter. After a release the plain
    ///      relation `bucket >= outstanding` is FALSE on correct, intended
    ///      behaviour, which is why bucket coverage could only ship as a
    ///      canonical advisory. Adding the stranded term restores a HARD
    ///      relation that holds on every chain role, so the watcher pages on
    ///      one rule instead of splitting severity by role.
    ///
    ///      EXACTLY, not approximately: the release lowered the bucket by
    ///      precisely the stranded amount, so `bucket + stranded` returns to
    ///      the pre-remit figure. That exactness is the argument against the
    ///      pre-clamp total, which would overshoot by the residual (Codex
    ///      #1448 r1 P1) and leave slack a later real shortfall could hide in.
    function test_Coverage_StrandedTermRestoresTheHardRelation() public {
        (uint256 recycledFull, uint256 recycledSent) =
            _remitRecycledWithResidual();
        // The bucket the fixture SEEDED, i.e. before the remit debited it.
        // `bucket + stranded` must return to exactly this: the remit removed
        // only the sent share, and the release strands exactly that share.
        uint256 bucketBeforeRemit = 1_000e18;
        vm.warp(block.timestamp + 7 days);
        remit.releaseRemitReservation(1);

        (, uint256 stranded, , , uint256 bucket, , , uint256 outstanding) =
            _composition();

        // The naive form is genuinely violated here — assert that, so this
        // test fails if the release path ever stops being able to produce
        // the state the stranded term exists to explain.
        assertLt(bucket, outstanding, "precondition: naive coverage IS broken");
        assertGe(
            bucket + stranded,
            outstanding,
            "#1444: bucket + stranded covers the reservations"
        );
        assertEq(
            bucket + stranded,
            bucketBeforeRemit,
            "the correction is EXACT: back to the pre-remit bucket"
        );

        // And the over-correction is real if the pre-clamp total were used:
        // it would exceed the true backing by the untouched residual.
        assertGt(
            bucket + recycledFull,
            bucketBeforeRemit,
            "pre-clamp total overshoots: the residual never left the bucket"
        );
        assertEq(
            recycledFull - recycledSent,
            (bucket + recycledFull) - bucketBeforeRemit,
            "and it overshoots by exactly the residual"
        );
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

    // ─── #1448 r3: the pre-upgrade seed ceremony ──────────────────────────

    /// @dev The state a Diamond is IN immediately after an in-place upgrade
    ///      that added the stranded counter: a real released reservation, but
    ///      the counter still zero because the old `restoreReleasedRemit` had
    ///      nothing to record it in. Both externally-checkable relations read
    ///      as violated on state the supported release path produced.
    function _preUpgradeReleasedState()
        internal
        returns (uint256 recycledSent)
    {
        (, recycledSent) = _remitRecycledWithResidual();
        vm.warp(block.timestamp + 7 days);
        remit.releaseRemitReservation(1);
        // Rewind the counter to reproduce the pre-upgrade shape.
        mutator.setReleasedRemitStrandedRaw(0);
    }

    /// @dev Without the seed, BOTH relations are violated by exactly the
    ///      historical stranded amount — so the watcher would page CRITICAL
    ///      twice, immediately on upgrade, on correct behaviour. This test
    ///      pins that precondition so the seed cannot look useful for the
    ///      wrong reason.
    function test_Seed_PreUpgradeStateViolatesBothRelations() public {
        uint256 sent = _preUpgradeReleasedState();
        (
            uint256 raw,
            uint256 stranded,
            ,
            uint256 relocated,
            uint256 bucket,
            ,
            uint256 paidOut,
            uint256 outstanding
        ) = _composition();
        assertEq(stranded, 0, "precondition: counter unwritten");
        assertLt(bucket + stranded, outstanding, "coverage reads violated");
        assertGt(
            raw + relocated,
            bucket + paidOut + stranded,
            "composition reads violated"
        );
        assertEq(
            raw + relocated - (bucket + paidOut + stranded),
            sent,
            "violated by EXACTLY the historical stranded amount"
        );
    }

    /// @dev The ceremony DERIVES the amount from storage — the caller only
    ///      says which reservations to count — and both relations reconcile.
    function test_Seed_DerivesTheStrandedTotalAndReconciles() public {
        uint256 sent = _preUpgradeReleasedState();
        remit.seedReleasedRemitStranded(remit.getRemitReservationNonce());

        (, uint256 stranded, , , uint256 bucket, , uint256 paidOut, uint256 outstanding) =
            _composition();
        assertEq(stranded, sent, "derived the CLAMPED sent share");
        assertGe(bucket + stranded, outstanding, "coverage reconciles");
        _assertComposition("after the seed");
        _assertDerivation("after the seed");
    }

    /// @dev It must sum the SENT share, never the pre-clamp commitment —
    ///      the same distinction Codex #1448 r1 established. Summing
    ///      `recycledFull` would leave permanent slack.
    function test_Seed_SumsTheSentShareNotThePreClampTotal() public {
        LibVaipakam.RemitReservation memory r;
        {
            (uint256 recycledFull, ) = _remitRecycledWithResidual();
            vm.warp(block.timestamp + 7 days);
            remit.releaseRemitReservation(1);
            mutator.setReleasedRemitStrandedRaw(0);
            r = remit.getRemitReservation(1);
            assertGt(recycledFull, r.recycled, "fixture: residual exists");
        }
        remit.seedReleasedRemitStranded(remit.getRemitReservationNonce());
        (, uint256 stranded, , , , , , ) = _composition();
        assertEq(stranded, r.recycled, "sent share");
        assertLt(stranded, r.recycledFull, "NOT the pre-clamp total");
    }

    /// @dev One-shot. A second run — or a run after an organic release
    ///      already recorded some — would double-count.
    function test_Seed_RefusesWhenAlreadySeeded() public {
        _preUpgradeReleasedState();
        remit.seedReleasedRemitStranded(remit.getRemitReservationNonce());
        (, uint256 stranded, , , , , , ) = _composition();
        uint256 seedTo = 2;
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceFacet.ReleasedRemitStrandedAlreadySeeded.selector,
                stranded
            )
        );
        remit.seedReleasedRemitStranded(seedTo);
    }

    /// @dev COMPLETENESS, the property the id-list shape could not provide
    ///      (Codex #1448 r4). A caller-supplied list could omit a release,
    ///      still satisfy both post-condition inequalities because ordinary
    ///      bucket headroom absorbed the gap, and permanently arm the
    ///      one-shot guard with a short total. Scanning `1..nonce` makes
    ///      completeness structural: with TWO historical releases the seed
    ///      must equal their sum, not either one alone.
    function test_Seed_CountsEveryReleasedReservationNotJustOne() public {
        (, uint256 sentA) = _remitRecycledWithResidual();
        vm.warp(block.timestamp + 7 days);
        remit.releaseRemitReservation(1);

        // A second remit of the re-opened day, released in turn.
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 3e18, 0);
        _remitDay1ToArb();
        LibVaipakam.RemitReservation memory r2 = remit.getRemitReservation(2);
        // 8 days, not another 7: two IDENTICAL `vm.warp(block.timestamp + N)`
        // expressions get common-subexpression-eliminated under viaIR and the
        // second is a no-op, so the release would revert RemitReleaseTooEarly.
        vm.warp(block.timestamp + 8 days);
        remit.releaseRemitReservation(2);

        assertEq(remit.getRemitReservationNonce(), 2, "fixture: two reservations");
        assertGt(r2.recycled, 0, "fixture: the second stranded something too");
        mutator.setReleasedRemitStrandedRaw(0);

        remit.seedReleasedRemitStranded(remit.getRemitReservationNonce());
        (, uint256 stranded, , , , , , ) = _composition();
        assertEq(stranded, sentA + r2.recycled, "summed BOTH releases");
        assertGt(stranded, sentA, "not just the first");
    }

    /// @dev A non-released reservation contributes nothing — the scan filters
    ///      on status rather than trusting the caller to pick.
    function test_Seed_IgnoresReservationsThatWereNotReleased() public {
        _finalizeDay(1);
        _remitDay1ToArb();
        assertEq(uint256(remit.getRemitReservation(1).status), 1, "pending");
        remit.seedReleasedRemitStranded(remit.getRemitReservationNonce());
        (, uint256 stranded, , , , , , ) = _composition();
        assertEq(stranded, 0, "a pending reservation stranded nothing");
    }

    /// @dev The post-condition is the load-bearing safety property: if the
    ///      derived seed does NOT reconcile, the divergence was not produced
    ///      by pre-upgrade releases and the ceremony must refuse rather than
    ///      half-silence a real alert.
    function test_Seed_RevertsWhenItWouldNotReconcile() public {
        _preUpgradeReleasedState();
        // An unexplained shortfall on top of the historical one: the seed
        // cannot account for this, so it must not be applied at all.
        mutator.setRecycleBucketRaw(0);
        uint256 seedTo = remit.getRemitReservationNonce();
        vm.expectRevert(
            RewardRemittanceFacet.SeedDoesNotReconcile.selector
        );
        remit.seedReleasedRemitStranded(seedTo);
    }

    // ─── #1448 r5: upgrade-path robustness ────────────────────────────────

    /// @dev A NEW release landing after the upgrade but BEFORE the ceremony
    ///      must not brick recovery. Guarding the one-shot on "the counter is
    ///      non-zero" did exactly that: the historical amount would have been
    ///      stranded forever with no entry point, and the redeploy script only
    ///      prints the ceremony after all refresh work, so an operator doing
    ///      nothing wrong could reach it.
    function test_Seed_StillRunsAfterAPostUpgradeReleaseRecordedSome() public {
        (, uint256 sentA) = _remitRecycledWithResidual();
        vm.warp(block.timestamp + 7 days);
        remit.releaseRemitReservation(1);
        // The pre-upgrade shape: the historical release recorded nothing.
        mutator.setReleasedRemitStrandedRaw(0);

        // Now a SECOND release lands organically, before the ceremony runs.
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 3e18, 0);
        _remitDay1ToArb();
        LibVaipakam.RemitReservation memory r2 = remit.getRemitReservation(2);
        vm.warp(block.timestamp + 8 days);
        remit.releaseRemitReservation(2);

        (, uint256 before, , , , , , ) = _composition();
        assertEq(before, r2.recycled, "only the NEW release is recorded");
        assertGt(before, 0, "so the value-based guard would have refused");

        remit.seedReleasedRemitStranded(remit.getRemitReservationNonce());

        (, uint256 after_, , , , , , ) = _composition();
        assertEq(after_, sentA + r2.recycled, "seed subsumes BOTH");
        assertGt(after_, before, "the historical amount was recovered");
    }

    /// @dev The scan ASSIGNS rather than adds, so a release already recorded
    ///      organically is not counted twice.
    function test_Seed_DoesNotDoubleCountAnAlreadyRecordedRelease() public {
        (, uint256 sent) = _remitRecycledWithResidual();
        vm.warp(block.timestamp + 7 days);
        remit.releaseRemitReservation(1);
        // Counter left AS RECORDED — not rewound. The ceremony must be a
        // no-op in value terms here.
        (, uint256 before, , , , , , ) = _composition();
        assertEq(before, sent, "recorded organically");

        remit.seedReleasedRemitStranded(remit.getRemitReservationNonce());
        (, uint256 after_, , , , , , ) = _composition();
        assertEq(after_, sent, "assigned, not added");
    }

    /// @dev One-shot is keyed on the APPLIED flag, so a second run refuses
    ///      even though the value is unchanged.
    function test_Seed_AppliedFlagIsWhatBlocksASecondRun() public {
        _preUpgradeReleasedState();
        remit.seedReleasedRemitStranded(remit.getRemitReservationNonce());
        (, uint256 stranded, , , , , , ) = _composition();
        uint256 seedTo = remit.getRemitReservationNonce();
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceFacet.ReleasedRemitStrandedAlreadySeeded.selector,
                stranded
            )
        );
        remit.seedReleasedRemitStranded(seedTo);
    }

    /// @dev The post-condition now checks BOTH directions. A chain whose
    ///      relocated counter is independently SHORT leaves the reverse
    ///      discrepancy alive; the one-sided form accepted that and armed the
    ///      ceremony anyway.
    function test_Seed_RefusesWhenTheReverseDirectionStaysBroken() public {
        _preUpgradeReleasedState();
        // Bucket holds more than any counter accounts for — an arrival that
        // credited without advancing the relocated cumulative.
        mutator.setRecycleBucketRaw(
            ConfigFacet(address(diamond)).getRecycleBucket() + 50e18
        );
        uint256 seedTo = remit.getRemitReservationNonce();
        vm.expectRevert(RewardRemittanceFacet.SeedDoesNotReconcile.selector);
        remit.seedReleasedRemitStranded(seedTo);
    }

    /// @dev #1448 r5 — the seeded marker is DERIVED, so a Diamond refreshed
    ///      over state that already has post-#1222 credits does not read as
    ///      never-seeded. Otherwise its under-credited composition would be
    ///      downgraded to an advisory until some later credit ran.
    function test_SeededMarker_DerivedFromExistingCumulatives() public {
        _configureMirror();
        // Raw slot false (appended storage), but real absorption exists.
        mutator.setRecycleBucketRaw(40e18);
        mutator.setRecycleCreditedCumulativeRaw(40e18);

        (, , bool seeded, ) = RewardAggregatorFacet(address(diamond))
            .getRecycleCompositionPosition();
        assertTrue(seeded, "existing absorption proves the chain was seeded");
    }

    /// @dev #1448 r6 — the OTHER direction of the same trap. A mirror with a
    ///      pre-#1222 bucket that took a relocation credit BEFORE the seed-fold
    ///      existed has a non-zero relocated cumulative and a still-ZERO raw
    ///      counter: the old `creditCustodyRelocated` advanced only the former
    ///      and never snapshotted the historical floor. Treating that as proof
    ///      of seeding turns the correct un-seeded advisory into a false
    ///      CRITICAL on valid upgrade state — the mirror image of the r5 bug.
    function test_SeededMarker_RelocatedAloneIsNotProofOfSeeding() public {
        _configureMirror();
        // The exact pre-commit shape: historical bucket, relocated custody
        // recorded, raw counter never written.
        mutator.setRecycleBucketRaw(63e18);
        mutator.setRecycleCustodyRelocatedRaw(23e18);
        mutator.setRecycleCreditedCumulativeRaw(0);

        (uint256 raw, , bool seeded, ) = RewardAggregatorFacet(address(diamond))
            .getRecycleCompositionPosition();
        assertEq(raw, 0, "fixture: the raw counter was never written");
        assertFalse(
            seeded,
            "relocated custody alone must NOT count as proof of seeding"
        );
    }

    /// @dev And it is still FALSE on a genuinely untouched chain — otherwise
    ///      the derivation would just always return true.
    function test_SeededMarker_FalseOnAnUntouchedChain() public {
        _configureMirror();
        (, , bool seeded, ) = RewardAggregatorFacet(address(diamond))
            .getRecycleCompositionPosition();
        assertFalse(seeded, "nothing has ever run here");
    }

    // ─── #1448 r7: the seed is resumable and bounded ──────────────────────

    /// @dev A Diamond with a long reservation history cannot scan `1..nonce`
    ///      in one transaction, and because the ceremony is one-shot it would
    ///      then NEVER seed — leaving the watcher permanently reporting valid
    ///      pre-upgrade state as CRITICAL. Ranges fix the liveness without
    ///      giving up completeness: the finish line is pinned from the nonce,
    ///      so `1..target` is still covered structurally.
    function test_Seed_ResumesAcrossRangesAndOnlyPublishesAtTheEnd() public {
        (, uint256 sentA) = _remitRecycledWithResidual();
        vm.warp(block.timestamp + 7 days);
        remit.releaseRemitReservation(1);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 3e18, 0);
        _remitDay1ToArb();
        LibVaipakam.RemitReservation memory r2 = remit.getRemitReservation(2);
        vm.warp(block.timestamp + 8 days);
        remit.releaseRemitReservation(2);
        mutator.setReleasedRemitStrandedRaw(0);
        assertEq(remit.getRemitReservationNonce(), 2, "fixture: two ids");

        // Range 1 of 2 — NOTHING is published yet, so every relation over the
        // ledger is exactly as it was. A partial total would make bucket
        // coverage more permissive, which is the direction that hides a real
        // shortfall.
        remit.seedReleasedRemitStranded(1);
        (, uint256 midway, , , , , , ) = _composition();
        assertEq(midway, 0, "partial scan publishes nothing");

        // Range 2 finishes it, and the total is BOTH releases.
        remit.seedReleasedRemitStranded(2);
        (, uint256 finalTotal, , , , , , ) = _composition();
        assertEq(finalTotal, sentA + r2.recycled, "both releases counted once");
    }

    /// @dev A release landing mid-ceremony records organically AND may sit in
    ///      an already-scanned range, so the scan and the live counter
    ///      disagree. Refuse rather than guess.
    function test_Seed_DetectsAReleaseLandingMidCeremony() public {
        _remitRecycledWithResidual();
        vm.warp(block.timestamp + 7 days);
        remit.releaseRemitReservation(1);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 3e18, 0);
        _remitDay1ToArb();
        mutator.setReleasedRemitStrandedRaw(0);

        remit.seedReleasedRemitStranded(1); // range 1, ceremony now in flight

        // Reservation 2 is released before the operator runs range 2.
        vm.warp(block.timestamp + 8 days);
        remit.releaseRemitReservation(2);

        (, uint256 nowCounter, , , , , , ) = _composition();
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceFacet.SeedRaceDetected.selector, 0, nowCounter
            )
        );
        remit.seedReleasedRemitStranded(2);
    }

    /// @dev Ranges must move forward and stay inside the pinned target — a
    ///      repeated or overlapping range is the double-count route the id
    ///      list had.
    function test_Seed_RejectsNonAdvancingOrOverrunningRanges() public {
        _preUpgradeReleasedState();
        uint256 target = remit.getRemitReservationNonce();

        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceFacet.SeedRangeInvalid.selector,
                target + 1, 0, target
            )
        );
        remit.seedReleasedRemitStranded(target + 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceFacet.SeedRangeInvalid.selector, 0, 0, target
            )
        );
        remit.seedReleasedRemitStranded(0);
    }

    /// @dev The target is PINNED at the first call, so a reservation created
    ///      later cannot move the finish line — the ceremony still completes.
    function test_Seed_TargetIsPinnedAgainstLaterReservations() public {
        _preUpgradeReleasedState();
        remit.seedReleasedRemitStranded(1);
        // A new reservation appears after the ceremony started.
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 3e18, 0);
        _remitDay1ToArb();
        assertEq(remit.getRemitReservationNonce(), 2, "nonce moved");
        // Completion is judged against the pinned target of 1, not the new
        // nonce, so the ceremony is already finished and refuses a re-run.
        (, uint256 stranded, , , , , , ) = _composition();
        assertGt(stranded, 0, "published at the pinned target");
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceFacet.ReleasedRemitStrandedAlreadySeeded.selector,
                stranded
            )
        );
        remit.seedReleasedRemitStranded(2);
    }

    /// @dev #1448 r8 — detecting the race must not BRICK the ceremony. Once a
    ///      release lands mid-flight the baseline check reverts every
    ///      subsequent call, so without a reset nothing can ever publish —
    ///      the same liveness failure the resumable design was added to
    ///      remove, reintroduced by the guard protecting it.
    function test_Seed_ResetRecoversFromADetectedRace() public {
        _remitRecycledWithResidual();
        vm.warp(block.timestamp + 7 days);
        remit.releaseRemitReservation(1);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 3e18, 0);
        _remitDay1ToArb();
        mutator.setReleasedRemitStrandedRaw(0);

        remit.seedReleasedRemitStranded(1);
        vm.warp(block.timestamp + 8 days);
        remit.releaseRemitReservation(2); // the race

        (, uint256 raced, , , , , , ) = _composition();
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceFacet.SeedRaceDetected.selector, 0, raced
            )
        );
        remit.seedReleasedRemitStranded(2);

        // Reset re-pins from the CURRENT state and the ceremony completes.
        remit.resetReleasedRemitStrandedSeed();
        remit.seedReleasedRemitStranded(remit.getRemitReservationNonce());

        (, uint256 finalTotal, , , , , , ) = _composition();
        LibVaipakam.RemitReservation memory r1 = remit.getRemitReservation(1);
        LibVaipakam.RemitReservation memory r2 = remit.getRemitReservation(2);
        assertEq(
            finalTotal,
            r1.recycled + r2.recycled,
            "restart counted both releases, exactly once each"
        );
    }

    /// @dev The reset is a restart lever, never a way to re-run a finished
    ///      ceremony or edit the published figure.
    function test_Seed_ResetRefusesOnceApplied() public {
        _preUpgradeReleasedState();
        remit.seedReleasedRemitStranded(remit.getRemitReservationNonce());
        (, uint256 stranded, , , , , , ) = _composition();
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceFacet.ReleasedRemitStrandedAlreadySeeded.selector,
                stranded
            )
        );
        remit.resetReleasedRemitStrandedSeed();
    }

    /// @dev And it refuses when nothing is in flight, so it cannot be used to
    ///      poke at a Diamond that has never started one.
    function test_Seed_ResetRefusesWhenNothingInFlight() public {
        _preUpgradeReleasedState();
        vm.expectRevert(RewardRemittanceFacet.SeedNotStarted.selector);
        remit.resetReleasedRemitStrandedSeed();
    }

    /// @dev The completion event must report RELEASED reservations, not the
    ///      reservation nonce — the latter includes pending and acked entries
    ///      and would inflate what audit consumers read (#1448 r8).
    function test_Seed_EventReportsReleasedCountNotTheNonce() public {
        _preUpgradeReleasedState();
        // Fixture: one released reservation, plus a pending one, so nonce > count.
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 3e18, 0);
        _remitDay1ToArb();
        uint256 nonce = remit.getRemitReservationNonce();
        assertEq(nonce, 2, "fixture: 2 reservations, only 1 released");

        vm.recordLogs();
        remit.seedReleasedRemitStranded(nonce);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("ReleasedRemitStrandedSeeded(uint256,uint256)");
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != sig) continue;
            (, uint256 reservations) =
                abi.decode(logs[i].data, (uint256, uint256));
            assertEq(reservations, 1, "the RELEASED count, not the nonce");
            seen = true;
        }
        assertTrue(seen, "completion event was emitted");
    }

    /// #1448 r10 — the race guard used to pin ONLY the stranded VALUE, which
    /// is blind to the release most likely to corrupt the emitted count: one
    /// whose recycled share is zero. `releaseRemitReservation` flips the
    /// status to Released unconditionally, but `restoreReleasedRemit` returns
    /// early when there is nothing to restore, so the value counter never
    /// moves. Landing in an already-scanned range, the scan misses it too —
    /// so the ceremony completed and reported a found-count the runbook tells
    /// operators to reconcile against the release history independently.
    ///
    /// The state under test is "a release happened, the value did not move".
    /// It is reproduced here by rewinding the value counter after a real
    /// release rather than by building a fresh-only slice, because the shape
    /// is what matters and the two are indistinguishable to the guard. In
    /// production it arises whenever a released reservation carries no
    /// recycled backing — a fresh-only remittance, or one whose recycled
    /// share clamped to zero.
    ///
    /// Guarding on the release COUNT closes it: nothing can flip a status
    /// without moving that.
    function test_Seed_RaceGuardCatchesAZeroRecycledRelease() public {
        _remitRecycledWithResidual();
        vm.warp(block.timestamp + 7 days);
        remit.releaseRemitReservation(1);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 3e18, 0);
        _remitDay1ToArb();
        mutator.setReleasedRemitStrandedRaw(0);

        // A PARTIAL scan: target pins at 2, cursor reaches 1. Reservation 2
        // is inside the pinned range but not yet scanned, and still Pending.
        remit.seedReleasedRemitStranded(1);
        (, uint256 valueMid, , , , , , ) = _composition();
        (, , , , , uint256 countMid) =
            remit.getReleasedRemitStrandedSeedState();

        // Release it, then rewind the value so the counter reads exactly as
        // it would after a release that stranded nothing.
        vm.warp(block.timestamp + 8 days);
        remit.releaseRemitReservation(2);
        mutator.setReleasedRemitStrandedRaw(valueMid);

        (, uint256 valueAfter, , , , , , ) = _composition();
        (, , , , , uint256 countAfter) =
            remit.getReleasedRemitStrandedSeedState();
        assertEq(
            valueAfter,
            valueMid,
            "precondition: the value counter did NOT move - a value-only "
            "guard is blind to this release by construction"
        );
        assertEq(countAfter, countMid + 1, "but the release COUNT did move");

        // The guard must still fire, on the count. `seedTo` is hoisted: a
        // nested getter would be "the next call" and eat the expectRevert.
        uint256 seedTo = remit.getRemitReservationNonce();
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceFacet.SeedRaceDetected.selector,
                valueMid,
                valueAfter
            )
        );
        remit.seedReleasedRemitStranded(seedTo);
    }

    /// The ceremony's own state must be readable. Without it an operator can
    /// only infer "has this already run?" from the published figure — which
    /// is exactly the value-based reasoning that is wrong here, since a
    /// non-zero total can be a post-upgrade release with a historical amount
    /// still unrecovered behind it.
    function test_Seed_StateIsExternallyReadable() public {
        _preUpgradeReleasedState();
        (bool appliedBefore, uint256 targetBefore, , , , ) =
            remit.getReleasedRemitStrandedSeedState();
        assertFalse(appliedBefore, "not yet run");
        assertEq(targetBefore, 0, "none in flight");

        remit.seedReleasedRemitStranded(remit.getRemitReservationNonce());

        (bool appliedAfter, , , uint256 accum, uint256 counted, ) =
            remit.getReleasedRemitStrandedSeedState();
        assertTrue(appliedAfter, "one-shot is visibly spent");
        assertGt(accum, 0, "and what it recovered is readable");
        assertEq(counted, 1, "one release behind it");
    }

    /// @dev Accept ETH refunds from the remit fee path.
    receive() external payable {}
}
