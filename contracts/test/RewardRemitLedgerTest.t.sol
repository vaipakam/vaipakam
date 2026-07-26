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
        (uint256[] memory pd, uint256 pt, uint256 prid) = abi.decode(
            ccip.sentPayload(0),
            (uint256[], uint256, uint256)
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
        remit.onRemitAckReceived(CHAIN_ARB, 1, 1e18);
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

        remit.releaseRemitReservation(1);

        LibVaipakam.RemitReservation memory r = remit.getRemitReservation(1);
        assertEq(uint256(r.status), 3, "released");
        assertEq(remit.getRewardBudgetRemitted(CHAIN_ARB, 1), 0, "day re-opened");
        assertEq(remit.getDayClosedByRemitId(CHAIN_ARB, 1), 0, "close cleared");
        assertEq(remit.getRewardBudgetRemittedGlobal(), 0, "global restored");
        assertEq(remit.getRewardBudgetRemittedTotal(CHAIN_ARB), 0, "chain restored");
        assertEq(remit.getRemitPendingTotal(CHAIN_ARB), 0, "pending cleared");

        // The re-opened day funds again under a NEW reservation.
        uint256 total2 = _remitDay1ToArb();
        assertEq(total2, total, "same slice re-funds");
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
        (uint256[] memory pd, uint256 pt, uint256 prid) = abi.decode(
            ccip.sentPayload(0),
            (uint256[], uint256, uint256)
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
            address(vpfiTok), 7e18, _days(3), CHAIN_BASE, 42
        );
        LibVaipakam.ReceivedRemit memory rec = remit.getReceivedRemit(42);
        assertEq(rec.srcChainId, CHAIN_BASE, "src");
        assertEq(rec.amount, 7e18, "amount");
        assertGt(rec.receivedAt, 0, "stamped");

        uint256 fee = remit.quoteRemitAckFee(42);
        remit.sendRemitAck{value: fee}(42, payable(address(this)));
        assertEq(rewardMessenger.lastAckRemitId(), 42, "echoed id");
        assertEq(rewardMessenger.lastAckAmount(), 7e18, "mirror-computed amount");

        // Re-sendable: the lost-ack retry lever.
        remit.sendRemitAck{value: fee}(42, payable(address(this)));
        assertEq(rewardMessenger.ackSendCount(), 2, "re-sent");
    }

    function test_MirrorIngress_LegacyDeliveryHasNoReceipt() public {
        _configureMirror();
        remit.onRewardBudgetReceived(
            address(vpfiTok), 7e18, _days(3), CHAIN_BASE, 0
        );
        assertEq(remit.getReceivedRemit(0).receivedAt, 0, "no receipt for 0");
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ReceivedRemitNotFound.selector,
                0
            )
        );
        remit.sendRemitAck{value: 0.001 ether}(0, payable(address(this)));
    }

    /// @dev Codex r2 — a receipt is bound to the Base deployment that sent
    ///      it; after an owner base-chain rotation the ack must not route a
    ///      stale receipt toward the NEW base (remit ids are per-deployment
    ///      and could finalize an unrelated same-numbered reservation).
    function test_SendRemitAck_RejectsStaleReceiptAfterBaseRotation() public {
        _configureMirror();
        remit.onRewardBudgetReceived(
            address(vpfiTok), 7e18, _days(3), CHAIN_BASE, 42
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
        remit.sendRemitAck{value: 0.001 ether}(42, payable(address(this)));
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ReceivedRemitStale.selector,
                42,
                CHAIN_BASE
            )
        );
        remit.quoteRemitAckFee(42);
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
        remit.sendRemitAck{value: 0.001 ether}(1, payable(address(this)));
    }

    /// @dev Accept ETH refunds from the remit fee path.
    receive() external payable {}
}
