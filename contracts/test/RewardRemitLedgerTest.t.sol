// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
import {RewardCompensationDispatchFacet} from "../src/facets/RewardCompensationDispatchFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {RemitWire} from "../src/crosschain/RemitWire.sol";
import {RewardCommitmentFacet} from "../src/facets/RewardCommitmentFacet.sol";
import {RepatriationFacet} from "../src/facets/RepatriationFacet.sol";
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
    RewardRemittanceLensFacet rlens;
    RewardCompensationDispatchFacet comp;
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
        rlens = RewardRemittanceLensFacet(address(diamond));
        comp = RewardCompensationDispatchFacet(address(diamond));
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

        // #1636 r2 — the quote ingress is FAIL-CLOSED until the mirror era
        // is registered; the mock stamps itself as the sending diamond.
        RewardCommitmentFacet(address(diamond)).setMirrorRewardDeployment(
            CHAIN_ARB, address(rewardMessenger)
        );

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

        assertEq(rlens.getRemitReservationNonce(), 1, "nonce");
        LibVaipakam.RemitReservation memory r = rlens.getRemitReservation(1);
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
        assertEq(rlens.getRemitIdByMessageId(expectedId), 1, "reverse index");

        assertEq(rlens.getRemitPendingTotal(CHAIN_ARB), total, "pending total");
        assertEq(rlens.getRemitAckedTotal(CHAIN_ARB), 0, "acked 0");
        assertEq(rlens.getDayClosedByRemitId(CHAIN_ARB, 1), 1, "day closed by 1");

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

        LibVaipakam.RemitReservation memory r = rlens.getRemitReservation(1);
        assertEq(uint256(r.status), 2, "acked");
        assertEq(rlens.getRemitPendingTotal(CHAIN_ARB), 0, "pending cleared");
        assertEq(rlens.getRemitAckedTotal(CHAIN_ARB), total, "acked total");

        // Re-delivered ack: exactly-once (no revert, no double count).
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, total);
        assertEq(rlens.getRemitAckedTotal(CHAIN_ARB), total, "still once");
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
        remit.onRemitAckReceived(CHAIN_ARB, 1, 1e18, address(diamond), 1);
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
        assertEq(uint256(rlens.getRemitReservation(1).status), 2, "acked");

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
        assertEq(rlens.getRewardBudgetRemittedGlobal(), total, "fresh reserved");

        // r5 — the release valve is timeout-gated (§M3): too early reverts.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RemitReleaseTooEarly.selector,
                1,
                block.timestamp + 7 days
            )
        );
        comp.releaseRemitReservation(1);
        vm.warp(block.timestamp + 7 days);
        comp.releaseRemitReservation(1);

        LibVaipakam.RemitReservation memory r = rlens.getRemitReservation(1);
        assertEq(uint256(r.status), 3, "released");
        assertEq(rlens.getRewardBudgetRemitted(CHAIN_ARB, 1), 0, "day re-opened");
        assertEq(rlens.getDayClosedByRemitId(CHAIN_ARB, 1), 0, "close cleared");
        // Codex r4 — the fresh counters stay RESERVED (the sent tokens are
        // physically outside Diamond custody; re-opening 69M headroom would
        // let the re-remit draw commingled custody as "fresh").
        assertEq(rlens.getRewardBudgetRemittedGlobal(), total, "global reserved");
        assertEq(
            rlens.getRewardBudgetRemittedTotal(CHAIN_ARB),
            total,
            "chain cumulative kept"
        );
        assertEq(rlens.getRemitPendingTotal(CHAIN_ARB), 0, "pending cleared");

        // The re-opened day funds again under a NEW reservation, consuming
        // NEW fresh headroom (two real outflows happened).
        uint256 total2 = _remitDay1ToArb();
        assertEq(total2, total, "same slice re-funds");
        assertEq(
            rlens.getRewardBudgetRemittedGlobal(),
            total * 2,
            "re-remit consumes new headroom"
        );
        assertEq(rlens.getRemitReservationNonce(), 2, "second reservation");
        assertEq(rlens.getDayClosedByRemitId(CHAIN_ARB, 1), 2, "closed by 2");

        // A late ack for the RELEASED reservation is surfaced, never
        // re-finalized (the operator released in error — double funding).
        vm.expectEmit(true, true, false, true, address(diamond));
        emit RemitAckAfterRelease(1, CHAIN_ARB, total);
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, total);
        assertEq(uint256(rlens.getRemitReservation(1).status), 3, "still released");
        assertEq(rlens.getRemitAckedTotal(CHAIN_ARB), 0, "not acked");
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
        comp.releaseRemitReservation(1);
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
            rlens.getRewardBudgetRemitted(CHAIN_ARB, 1),
            liabL + liabB,
            "day marked with the clamped amount"
        );

        // The FULL pre-clamp armed fresh retired (remitted + residual are
        // both dead once the day terminally closes).
        LibVaipakam.RemitReservation memory r = rlens.getRemitReservation(1);
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

        LibVaipakam.RemitReservation memory r = rlens.getRemitReservation(1);
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
        assertEq(rlens.getRewardBudgetRemitted(CHAIN_ARB, 1), 0, "no amount mark");
        assertEq(rlens.getDayClosedByRemitId(CHAIN_ARB, 1), 1, "day CLOSED");
        LibVaipakam.RemitReservation memory r = rlens.getRemitReservation(1);
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
        LibVaipakam.RemitReservation memory r = rlens.getRemitReservation(1);
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
        LibVaipakam.RemitReservation memory r = rlens.getRemitReservation(1);
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
        LibVaipakam.RemitReservation memory r = rlens.getRemitReservation(1);
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
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 3e18, 2e18);
    }

    function test_Manual_FundsThroughTheLedger() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        // #1434 P2-w3 — the standing mirror quote the funding is bounded by.
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);

        // #1434 P2-w2 — the manual path is sized PER SIDE on the wire.
        uint256 amount = 5e18;
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 3e18, 2e18);

        LibVaipakam.RemitReservation memory r = rlens.getRemitReservation(1);
        assertEq(uint256(r.status), 1, "pending");
        assertEq(r.total, amount, "amount");
        assertEq(r.fresh, amount, "fresh-funded");
        assertEq(r.recycled, 0, "no recycled draw");
        assertEq(r.armedFreshFull, 0, "no commitment retired");
        assertEq(rlens.getRewardBudgetRemitted(CHAIN_ARB, 1), amount, "day marked");
        assertEq(rlens.getDayClosedByRemitId(CHAIN_ARB, 1), 1, "day closed");
        assertEq(rlens.getRewardBudgetRemittedGlobal(), amount, "69M reserved");

        // #1434 P2-w2 — the payload is the P2 compensation shape: tag +
        // single day + per-side amounts + the day's frozen expiry inputs.
        (
            uint256 pTag,
            uint256 pDay,
            uint256 pt,
            uint256 prid,
            ,
            uint256 pLender,
            uint256 pBorrower,
            ,
            ,
            ,

        ) = abi.decode(
            ccip.sentPayload(0),
            (
                uint256,
                uint256,
                uint256,
                uint256,
                address,
                uint256,
                uint256,
                uint256,
                uint256,
                uint256,
                uint256
            )
        );
        assertEq(pTag, RemitWire.REMIT_WIRE_TAG_P2, "P2 wire tag");
        assertEq(pDay, 1, "day");
        assertEq(pt, amount, "total");
        assertEq(prid, 1, "remitId");
        assertEq(pLender, 3e18, "lender side rides the wire");
        assertEq(pBorrower, 2e18, "borrower side rides the wire");

        // Ack finalizes like any remit.
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, amount);
        assertEq(uint256(rlens.getRemitReservation(1).status), 2, "acked");

        // A second manual send for the same (chain, day) is blocked.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RemitDayAlreadyClosed.selector,
                1,
                CHAIN_ARB
            )
        );
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 3e18, 2e18);
    }

    function test_Manual_AdminOnly() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert();
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 3e18, 2e18);
    }

    /// @dev #1434 P2-w3 — funding is EVIDENCE-BOUNDED (§1.4): no standing
    ///      mirror quote, no manual compensation.
    function test_Manual_RequiresStandingQuote() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CompensationNotQuoted.selector, 1, CHAIN_ARB
            )
        );
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 3e18, 2e18);
    }

    /// @dev #1434 P2-w3 — each side is bounded SEPARATELY by the standing
    ///      quote (§2.5: an aggregate bound admits overfunding one side
    ///      while shorting the other). Under-quote per side is allowed —
    ///      partial funding defers on the mirror until w4's supplemental /
    ///      short-lapse terminal resolves it.
    function test_Manual_BoundedPerSideByQuote() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);

        // Aggregate below the quoted sum, but the LENDER side over its
        // bound — must still refuse.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CompensationExceedsQuote.selector,
                4e18,
                1e18,
                3e18,
                2e18
            )
        );
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 4e18, 1e18);

        // Borrower side over its bound.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CompensationExceedsQuote.selector,
                1e18,
                4e18,
                3e18,
                2e18
            )
        );
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 1e18, 4e18);

        // Per-side under-quote is allowed.
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
    }

    /// @dev #1434 P2-w4 — the supplemental lifecycle over the R6 gate:
    ///      manual sets the gate + per-side funded cumulative; the
    ///      consumption ACK clears it; a supplemental needs the closed
    ///      day's reservation ACKED, accumulates per side under the
    ///      standing quote, holds the gate itself, and its own ACK clears
    ///      again.
    function test_Supplemental_LifecycleAndGate() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);

        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        assertEq(
            rlens.getCompensationOutstanding(CHAIN_ARB), 1, "gate = remit 1"
        );
        assertEq(
            rlens.getCompensationOutstandingChains().length,
            1,
            "chain in the R6e inventory"
        );
        (uint256 fl, uint256 fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 2e18, "lender funded cumulative");
        assertEq(fb, 1e18, "borrower funded cumulative");

        // Gate held: another chain-day's manual is blocked while remit 1
        // is outstanding for this chain.
        _finalizeDay(2);
        mutator.setChainDayRemitIneligibleRaw(2, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 2, 1e18, 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CompensationGateHeld.selector, CHAIN_ARB, 1
            )
        );
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 2, 1e18, 1e18);

        // A supplemental needs the closing reservation ACKED.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.SupplementalReservationNotAcked.selector,
                1,
                uint8(1)
            )
        );
        comp.remitSupplementalBudget{value: 0.01 ether}(CHAIN_ARB, 1, 1e18, 0);

        // The consumption ACK clears the gate.
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, 3e18);
        assertEq(rlens.getCompensationOutstanding(CHAIN_ARB), 0, "cleared");
        assertEq(
            rlens.getCompensationOutstandingChains().length, 0, "index empty"
        );

        // Per-side cumulative bound: 2 + 2 = 4 > 3 quoted on the lender
        // side — refused even though the aggregate stays under 5.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CompensationExceedsQuote.selector,
                4e18,
                1e18,
                3e18,
                2e18
            )
        );
        comp.remitSupplementalBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 0);

        // A within-bound supplement dispatches, re-holds the gate under
        // its OWN reservation, and its ACK clears again. The day markers
        // stay untouched (funding accumulates against the same
        // obligation).
        comp.remitSupplementalBudget{value: 0.01 ether}(
            CHAIN_ARB, 1, 1e18, 1e18
        );
        (fl, fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 3e18, "cumulative at quote");
        assertEq(fb, 2e18, "cumulative at quote");
        uint256 suppId = rlens.getCompensationOutstanding(CHAIN_ARB);
        assertGt(suppId, 1, "own reservation");
        assertEq(
            rlens.getDayClosedByRemitId(CHAIN_ARB, 1),
            1,
            "day still closed by the ORIGINAL remit"
        );
        rewardMessenger.deliverRemitAck(CHAIN_ARB, suppId, 2e18);
        assertEq(rlens.getCompensationOutstanding(CHAIN_ARB), 0, "cleared");
    }

    /// @dev #1434 P2-w4 — a supplemental tops up only a CLOSED day.
    function test_Supplemental_RequiresClosedDay() public {
        _finalizeDay(1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.SupplementalDayNotClosed.selector,
                1,
                CHAIN_ARB
            )
        );
        comp.remitSupplementalBudget{value: 0.01 ether}(CHAIN_ARB, 1, 1e18, 0);
    }

    /// @dev #1434 P2-w4 (constraint-19) — the legacy inventory lists only
    ///      the pre-P2 shape: single-day fresh-only reservations to a
    ///      frozen-zeroed dest with NO per-side funded record; a post-w4
    ///      compensation (which always stamps one) never appears.
    function test_LegacyInventory() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        mutator.setDayZeroedForDestRaw(1, CHAIN_ARB, true);

        (uint256[] memory ids, uint256 next) =
            rlens.getLegacyManualReservations(1, 10);
        assertEq(ids.length, 0, "post-w4 compensation is not legacy");
        assertEq(next, 2, "page advanced past the scanned id");

        // The pre-w4 legacy shape: same reservation, no funded record.
        mutator.setCompFundedRaw(CHAIN_ARB, 1, 0, 0);
        (ids, ) = rlens.getLegacyManualReservations(1, 10);
        assertEq(ids.length, 1, "legacy shape listed");
        assertEq(ids[0], 1, "the reservation id");
    }

    /// @dev #1656 r1 — the ACK reconciles the per-side funded cumulative
    ///      from DECLARED to RECEIVED, so a short delivery re-opens
    ///      exactly the supplemental headroom it left.
    function test_Supplemental_ShortDeliveryReconciliation() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);

        // Half the declared total arrives (fee-on-transfer shape).
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, 1.5e18);
        (uint256 fl, uint256 fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 1e18, "lender funded scaled to received");
        assertEq(fb, 0.5e18, "borrower funded scaled to received");

        // The supplemental now fits exactly the re-opened headroom.
        comp.remitSupplementalBudget{value: 0.01 ether}(
            CHAIN_ARB, 1, 2e18, 1.5e18
        );
        (fl, fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 3e18, "cumulative back at quote");
        assertEq(fb, 2e18, "cumulative back at quote");
    }

    /// @dev #1656 r1 — releasing a failed SUPPLEMENTAL must not erase the
    ///      original manual remit's day closure (the markers belong to the
    ///      acknowledged original).
    function test_Supplemental_ReleaseDoesNotEraseTheClosure() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, 3e18);
        comp.remitSupplementalBudget{value: 0.01 ether}(CHAIN_ARB, 1, 1e18, 1e18);
        uint256 suppId = rlens.getCompensationOutstanding(CHAIN_ARB);

        vm.warp(block.timestamp + 8 days); // past REMIT_RELEASE_MIN_AGE
        comp.releaseRemitReservation(suppId);
        assertEq(
            rlens.getDayClosedByRemitId(CHAIN_ARB, 1),
            1,
            "closure still owned by the ORIGINAL remit"
        );
        assertEq(
            rlens.getRewardBudgetRemitted(CHAIN_ARB, 1),
            3e18,
            "funded scalar record intact"
        );
        // #1656 r6 - the released supplemental's declared split leaves
        // the funded cumulative with it, so the post-recovery replacement
        // fits the per-side bound. The R6 gate itself correctly HOLDS
        // (SS5.1: a release records terminal message state, and only the
        // w6 recovery settlement clears it), so the replacement dispatch
        // is the recovery ceremony's proof, not this one's.
        (uint256 fl, uint256 fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 2e18, "back to the original's contribution");
        assertEq(fb, 1e18, "back to the original's contribution");
        assertEq(
            rlens.getCompensationOutstanding(CHAIN_ARB),
            suppId,
            "gate held pending recovery settlement"
        );
    }

    /// @dev #1656 r1 — a pre-w4 P2 compensation has no per-side funded
    ///      record: the supplemental refuses until the ADMIN seed
    ///      backfills it (exactly-sum + per-side-quote validated).
    function test_Supplemental_SeedBackfillsPreW4Record() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        // #1656 r7 - a PENDING closure cannot be seeded (it delivered
        // nothing; its remedy is release or resolution).
        mutator.setCompFundedRaw(CHAIN_ARB, 1, 0, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.SupplementalReservationNotAcked.selector,
                1,
                uint8(1)
            )
        );
        comp.seedCompFunded(CHAIN_ARB, 1, 2e18, 1e18);
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, 3e18);
        // Stage the pre-w4 shape: funded scalar present, per-side zero
        // (the ACK's reconciliation re-stamped values; clear them again).
        mutator.setCompFundedRaw(CHAIN_ARB, 1, 0, 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.SupplementalFundedRecordMissing.selector,
                1,
                CHAIN_ARB
            )
        );
        comp.remitSupplementalBudget{value: 0.01 ether}(CHAIN_ARB, 1, 1e18, 0);

        // Seed may not EXCEED the recorded scalar (#1656 r2: at-most,
        // so an already-ACKed short delivery seeds at received).
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CompFundedSeedInvalid.selector, 1, CHAIN_ARB
            )
        );
        comp.seedCompFunded(CHAIN_ARB, 1, 3e18, 0.5e18); // sums past 3
        comp.seedCompFunded(CHAIN_ARB, 1, 2e18, 1e18);
        (uint256 fl, uint256 fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 2e18, "seeded");
        assertEq(fb, 1e18, "seeded");
        // One-shot.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CompFundedSeedInvalid.selector, 1, CHAIN_ARB
            )
        );
        comp.seedCompFunded(CHAIN_ARB, 1, 2e18, 1e18);
        // Supplemental now bounded normally.
        comp.remitSupplementalBudget{value: 0.01 ether}(CHAIN_ARB, 1, 1e18, 1e18);
    }

    /// @dev #1656 r1 — a RELEASED reservation drops from the legacy
    ///      inventory (the documented pending-hit remedy must converge the
    ///      empty-inventory activation gate).
    function test_LegacyInventory_ReleasedDrops() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        mutator.setDayZeroedForDestRaw(1, CHAIN_ARB, true);
        mutator.setCompFundedRaw(CHAIN_ARB, 1, 0, 0); // legacy shape
        (uint256[] memory ids, ) = rlens.getLegacyManualReservations(1, 10);
        assertEq(ids.length, 1, "listed while pending");

        vm.warp(block.timestamp + 8 days);
        comp.releaseRemitReservation(1);
        (ids, ) = rlens.getLegacyManualReservations(1, 10);
        assertEq(ids.length, 0, "released hit drops from the inventory");
    }

    /// @dev #1656 r2 — a severe short delivery whose reconciliation
    ///      rounds both funded sides to ZERO is still a RECORDED day: the
    ///      supplemental admits it (the existence flag, never the value
    ///      pair, is the record).
    function test_Supplemental_RoundedToZeroRecordStillSupplementable()
        public
    {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        // Near-total loss: 1 wei arrives; both shares floor to zero.
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, 1);
        (uint256 fl, uint256 fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 0, "lender share floors to zero");
        assertEq(fb, 0, "borrower share floors to zero");
        // Still supplementable — nearly the whole quote re-opened.
        comp.remitSupplementalBudget{value: 0.01 ether}(
            CHAIN_ARB, 1, 2e18, 2e18
        );
    }

    /// @dev #1656 r2 — the migration seed records the CREDITED figure: an
    ///      already-ACKed short delivery seeds at received (≤ the declared
    ///      scalar), re-opening the shortfall's supplemental headroom.
    function test_Supplemental_SeedAtReceivedBelowDeclared() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, 3e18);
        // Pre-w4 shape (no record) whose historical ACK reported HALF.
        mutator.setCompFundedRaw(CHAIN_ARB, 1, 0, 0);
        // Above the declared scalar still refuses…
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CompFundedSeedInvalid.selector, 1, CHAIN_ARB
            )
        );
        comp.seedCompFunded(CHAIN_ARB, 1, 3e18, 1e18);
        // …but seeding at the RECEIVED figure (below declared) works.
        comp.seedCompFunded(CHAIN_ARB, 1, 1e18, 0.5e18);
        comp.remitSupplementalBudget{value: 0.01 ether}(
            CHAIN_ARB, 1, 2e18, 1.5e18
        );
        (uint256 fl, uint256 fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 3e18, "back at quote");
        assertEq(fb, 2e18, "back at quote");
    }

    /// @dev #1656 r2 — the FORCED finalize preserves declared funding:
    ///      its zero amountReceived is a sentinel, not a delivery figure,
    ///      and reconciling on it would let the obligation fund twice.
    function test_Supplemental_ForcedFinalizePreservesDeclared() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 3e18, 2e18);
        remit.finalizeRemitReservation(1); // forced, amountReceived = 0
        (uint256 fl, uint256 fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 3e18, "declared preserved");
        assertEq(fb, 2e18, "declared preserved");
        assertEq(rlens.getCompensationOutstanding(CHAIN_ARB), 0, "gate clear");
        // No headroom re-opened: any supplement exceeds the quote.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CompensationExceedsQuote.selector,
                3e18 + 1,
                2e18,
                3e18,
                2e18
            )
        );
        comp.remitSupplementalBudget{value: 0.01 ether}(CHAIN_ARB, 1, 1, 0);
    }

    /// @dev #1656 r3 — a supplemental dispatches past the day's ORIGINAL
    ///      frozen expiry: the mirror admits top-ups on a compensated-and-
    ///      open day until its remediation deadline, so the R3 cutoff's
    ///      guaranteed-quarantine premise does not hold for supplements.
    function test_Supplemental_DispatchesPastOriginalExpiry() public {
        RewardCommitmentFacet(address(diamond)).setLapseSchedule(
            7 days, 24 hours
        );
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, 1.5e18);
        vm.warp(block.timestamp + 30 days); // far past the frozen expiry
        comp.remitSupplementalBudget{value: 0.01 ether}(
            CHAIN_ARB, 1, 1e18, 1e18
        );
    }

    /// @dev #1656 r3 — a rounded-to-zero post-w4 day is NOT a legacy
    ///      inventory hit (the existence flag governs, not the values).
    function test_LegacyInventory_RoundedZeroRecordNotListed() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, 1); // rounds to 0/0
        mutator.setDayZeroedForDestRaw(1, CHAIN_ARB, true);
        (uint256[] memory ids, ) = rlens.getLegacyManualReservations(1, 10);
        assertEq(ids.length, 0, "recorded day never lists as legacy");
    }

    /// @dev #1656 r3 — a forced-finalized compensation's LATE authentic
    ///      ACK runs the declared-to-received reconciliation exactly once.
    function test_Supplemental_LateAckAfterForcedFinalizeReconciles()
        public
    {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        remit.finalizeRemitReservation(1); // forced — declared preserved
        (uint256 fl, uint256 fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 2e18, "declared preserved at force");
        // The delayed authentic ACK arrives: HALF was received.
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, 1.5e18);
        (fl, fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 1e18, "reconciled to received");
        assertEq(fb, 0.5e18, "reconciled to received");
        // One-shot: a replayed ACK changes nothing.
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, 1);
        (fl, fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 1e18, "replay is inert");
        // The re-opened headroom is usable.
        comp.remitSupplementalBudget{value: 0.01 ether}(
            CHAIN_ARB, 1, 2e18, 1.5e18
        );
    }

    /// @dev #1656 r10 — the forced-finalize one-shot survives a NON-
    ///      consumed ack: a provisional ack dispatched pre-confirm but
    ///      arriving post-force must not burn `forcedFinalized` before
    ///      the consumed re-presentation can reconcile the declared
    ///      split down to what was actually received.
    function test_Supplemental_NonConsumedAckPreservesForcedOneShot()
        public
    {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        remit.finalizeRemitReservation(1); // forced — declared preserved
        // A provisional (non-consumed) ack lands AFTER the force: no
        // reconciliation, and the one-shot is NOT burned.
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 1.5e18, false);
        (uint256 fl, uint256 fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 2e18, "declared preserved through non-consumed ack");
        assertEq(fb, 1e18, "declared preserved through non-consumed ack");
        // The consumed re-presentation reconciles via the preserved flag.
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 1.5e18, true);
        (fl, fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 1e18, "consumed re-ack reconciled to received");
        assertEq(fb, 0.5e18, "consumed re-ack reconciled to received");
        // One-shot spent: replays inert.
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 1, true);
        (fl, fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 1e18, "replay inert after reconciliation");
    }

    /// @dev #1656 r8 — a NON-consumption ack (quarantined / still-
    ///      provisional delivery) finalizes the reservation but HOLDS the
    ///      R6 gate (§5.1: the clearing evidence is CONSUMPTION; a
    ///      stranded delivery settles via the w5 return) and skips the
    ///      compFunded reconciliation.
    function test_Supplemental_NonConsumedAckHoldsGate() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        // #1660 r8 - the non-consumed-then-consumed ordering is the
        // PROVISIONAL receipt's flow (classification 3): a QUARANTINED
        // receipt never becomes consumed - that ordering is now the
        // classification-conflict case with its own regression.
        rewardMessenger.deliverRemitAckWithClassification(CHAIN_ARB, 1, 1.5e18, 3);
        assertEq(
            uint256(rlens.getRemitReservation(1).status),
            2,
            "reservation finalized (delivery evidence)"
        );
        assertEq(
            rlens.getCompensationOutstanding(CHAIN_ARB),
            1,
            "gate HELD - not a consumption ack"
        );
        (uint256 fl, uint256 fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 2e18, "no reconciliation on a stranded delivery");
        assertEq(fb, 1e18, "no reconciliation on a stranded delivery");

        // #1656 r9 - the V3 confirm settles the credit mirror-side and
        // the re-presented ack is now CONSUMED: the first one clears the
        // held gate and reconciles (a normal cross-chain ordering).
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 1.5e18, true);
        assertEq(
            rlens.getCompensationOutstanding(CHAIN_ARB),
            0,
            "late-consumption ack clears the gate"
        );
        (fl, fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 1e18, "reconciled to received");
        assertEq(fb, 0.5e18, "reconciled to received");
        // Replays inert - the gate no longer names this remit.
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 1, true);
        (fl, fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 1e18, "replay inert");
    }

    /// @dev #1636 r4 — a resolved-zero standing quote is TERMINAL: its
    ///      (0,0) ingress retired the day's manual-funding anchor, so the
    ///      era-rotation clear refuses it (deleting would strand the
    ///      chain-day outside every admission path, and any era's
    ///      re-quote is deterministically (0,0) again).
    function test_Quote_ResolvedZeroRecordRefusesClear() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        RewardCommitmentFacet com = RewardCommitmentFacet(address(diamond));

        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 0, 0);
        assertFalse(
            com.getChainDayCommitments(1, CHAIN_ARB).remitIneligible,
            "zero quote retired the funding anchor"
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CompQuoteResolvedZeroFinal.selector,
                1,
                CHAIN_ARB
            )
        );
        com.clearCompQuote(1, CHAIN_ARB);
    }

    /// @dev #1636 r1+r2 — the full two-layer era lifecycle: the FAIL-CLOSED
    ///      registry ground truth authenticates every arrival (including
    ///      the first), the standing-quote binding protects evidence
    ///      across a registry rotation, the ADMIN clear releases a stale
    ///      binding, and a funded day rejects both re-quote and clear.
    function test_Quote_EraBindingAndClear() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        RewardCommitmentFacet com = RewardCommitmentFacet(address(diamond));
        address eraA = makeAddr("mirrorDiamondA");
        address eraB = makeAddr("mirrorDiamondB");

        // LAYER 1 — registry ground truth. Unset (fail-closed): even a
        // FIRST arrival is refused, so a delayed retired-era wire can
        // never bind unchallenged.
        com.setMirrorRewardDeployment(CHAIN_ARB, address(0));
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CompQuoteMirrorEraUnset.selector, CHAIN_ARB
            )
        );
        rewardMessenger.deliverCompQuoteFromEra(CHAIN_ARB, 1, 3e18, 2e18, eraA);

        // Registered era A: A's quote lands; same-era re-delivery
        // refreshes (the honest lost-message retry).
        com.setMirrorRewardDeployment(CHAIN_ARB, eraA);
        rewardMessenger.deliverCompQuoteFromEra(CHAIN_ARB, 1, 3e18, 2e18, eraA);
        rewardMessenger.deliverCompQuoteFromEra(CHAIN_ARB, 1, 4e18, 2e18, eraA);
        LibVaipakam.CompQuote memory q = com.getCompQuote(1, CHAIN_ARB);
        assertEq(q.lender18, 4e18, "same-era refresh applied");
        assertEq(q.era, eraA, "bound era recorded");

        // A non-registered era is refused by the ground truth.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CompQuoteEraMismatch.selector,
                1,
                CHAIN_ARB,
                eraA,
                eraB
            )
        );
        rewardMessenger.deliverCompQuoteFromEra(CHAIN_ARB, 1, 9e18, 9e18, eraB);

        // LAYER 2 — the rotation ceremony: registry moves to B, but the
        // STANDING quote is still bound to A — B's wire diverges from the
        // record until the operator clears it deliberately.
        com.setMirrorRewardDeployment(CHAIN_ARB, eraB);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CompQuoteEraMismatch.selector,
                1,
                CHAIN_ARB,
                eraA,
                eraB
            )
        );
        rewardMessenger.deliverCompQuoteFromEra(CHAIN_ARB, 1, 3e18, 2e18, eraB);
        // #1636 r5 — the FUNDING path holds the same ground truth: the
        // retired era's standing quote must not fund the current mirror
        // during the rotation window (expected = eraB, standing = eraA).
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CompQuoteEraMismatch.selector,
                1,
                CHAIN_ARB,
                eraB,
                eraA
            )
        );
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 3e18, 2e18);
        com.clearCompQuote(1, CHAIN_ARB);
        rewardMessenger.deliverCompQuoteFromEra(CHAIN_ARB, 1, 3e18, 2e18, eraB);
        assertEq(com.getCompQuote(1, CHAIN_ARB).era, eraB, "re-bound");

        // Fund the day — both re-quote and clear are now rejected: the
        // quote standing at dispatch is the receipt-bound obligation.
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 3e18, 2e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CompQuoteDayAlreadyFunded.selector,
                1,
                CHAIN_ARB
            )
        );
        rewardMessenger.deliverCompQuoteFromEra(CHAIN_ARB, 1, 3e18, 2e18, eraB);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CompQuoteDayAlreadyFunded.selector,
                1,
                CHAIN_ARB
            )
        );
        com.clearCompQuote(1, CHAIN_ARB);
    }

    /// @dev #1634 r2 — a clockless day cannot dispatch a P2 compensation:
    ///      it can never emit the settling V3 broadcast (the V2-permanent
    ///      fallback), so the mirror credit would sit provisional forever.
    ///      Fail-closed at the dispatch, where the operator can heal the
    ///      clock first (or route a pre-w1 day to the w4 legacy migration).
    function test_Manual_RefusesClocklessDay() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        mutator.clearDayLapseClockRaw(1); // reproduce a pre-w1 day

        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CompensationDayHasNoClock.selector, 1
            )
        );
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 3e18, 2e18);
    }

    /// @dev #1634 r3 — the R3 dispatch cutoff: a compensation must not
    ///      dispatch within `dispatchCutoffGap` of the day's frozen expiry
    ///      (bridge latency could carry it past expiry, where the mirror
    ///      quarantines it after Base closed the day). Exactly AT the
    ///      cutoff boundary is allowed; one second inside is refused.
    function test_Manual_RefusesInsideDispatchCutoff() public {
        RewardCommitmentFacet(address(diamond)).setLapseSchedule(
            7 days, 24 hours
        );
        _finalizeDay(1);
        (uint64 frozenAt, , , ) =
            RewardCommitmentFacet(address(diamond)).getDayLapseClock(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);

        uint256 expiry = uint256(frozenAt) + 7 days;
        // #1434 P2-w3 — quote first, so the boundary probe below reaches
        // the cutoff gate (which runs before the quote gate).
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        // One second INSIDE the cutoff window.
        vm.warp(expiry - 24 hours + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CompensationDispatchPastCutoff.selector,
                1,
                expiry,
                uint64(24 hours)
            )
        );
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 3e18, 2e18);

        // Exactly AT the boundary (now + gap == expiry) is allowed.
        vm.warp(expiry - 24 hours);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 3e18, 2e18);
    }

    /// @dev #1434 P2-w2 — the P2 payload's expiry inputs are the day's
    ///      FROZEN clock words (w1's finalization-time freeze), never live
    ///      state: set schedule v1, finalize (freezing v1 + now), then bump
    ///      to v2 and warp before dispatching — the wire still carries v1
    ///      and the finalization instant.
    function test_Manual_CarriesFrozenClockWords() public {
        RewardCommitmentFacet(address(diamond)).setLapseSchedule(
            7 days, 24 hours
        );
        _finalizeDay(1);
        (uint64 frozenAt, uint32 frozenVer, , ) =
            RewardCommitmentFacet(address(diamond)).getDayLapseClock(1);
        assertEq(frozenVer, 1, "day froze schedule v1");

        RewardCommitmentFacet(address(diamond)).setLapseSchedule(
            10 days, 48 hours
        );
        vm.warp(block.timestamp + 3 days);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 3e18, 2e18);

        (
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            uint256 wireAt,
            uint256 wireVer,
            uint256 wireWindow,
            uint256 wireGap
        ) = abi.decode(
            ccip.sentPayload(0),
            (
                uint256,
                uint256,
                uint256,
                uint256,
                address,
                uint256,
                uint256,
                uint256,
                uint256,
                uint256,
                uint256
            )
        );
        assertEq(wireAt, uint256(frozenAt), "frozen finalizedAt on the wire");
        assertEq(wireVer, 1, "frozen v1 despite the v2 bump");
        // Codex #1634 r1 — the INLINE parameters ride too (w1 chose no
        // mirror-side version table, so the version number alone is
        // underivable there).
        assertEq(wireWindow, 7 days, "frozen v1 window inline");
        assertEq(wireGap, 24 hours, "frozen v1 gap inline");
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
        , 0);
        LibVaipakam.ReceivedRemit memory rec =
            rlens.getReceivedRemit(address(0xBA5E), 42);
        assertEq(rec.srcChainId, CHAIN_BASE, "src");
        assertEq(rec.amount, 7e18, "amount");
        assertGt(rec.receivedAt, 0, "stamped");

        uint256 fee = rlens.quoteRemitAckFee(42, address(0xBA5E));
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
        , 0);
        assertEq(
            rlens.getReceivedRemit(address(0xBA5E), 0).receivedAt,
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
        , 0);
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
        rlens.quoteRemitAckFee(42, address(0xBA5E));
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
        assertEq(uint256(rlens.getRemitReservation(1).status), 1, "still pending");
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
        , 0);
        remit.onRewardBudgetReceived(
            address(vpfiTok), 9e18, _days(4), CHAIN_BASE, 42, address(0x2EF), 0
        , 0);
        assertEq(
            rlens.getReceivedRemit(address(0x01D), 42).amount,
            7e18,
            "old-era receipt intact"
        );
        assertEq(
            rlens.getReceivedRemit(address(0x2EF), 42).amount,
            9e18,
            "new-era receipt co-exists"
        );
        // Per-key first-write-wins (a delayed duplicate cannot overwrite).
        remit.onRewardBudgetReceived(
            address(vpfiTok), 1e18, _days(5), CHAIN_BASE, 42, address(0x2EF), 0
        , 0);
        assertEq(
            rlens.getReceivedRemit(address(0x2EF), 42).amount,
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
        comp.releaseRemitReservation(1);
        assertEq(rlens.getDayClosedByRemitId(CHAIN_ARB, 1), 0, "day re-opened");

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
        , 0);

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
        , 0);
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
        , 0);
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
        , 0);

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
        (raw, releasedStranded, seeded, , ) =
            agg.getRecycleCompositionPosition();
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
        LibVaipakam.RemitReservation memory r = rlens.getRemitReservation(1);
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

        (uint256 rawBefore, uint256 strandedBefore, , bool canonBefore, ) =
            RewardAggregatorFacet(address(diamond))
                .getRecycleCompositionPosition();
        assertEq(strandedBefore, 0, "no release yet");
        assertTrue(canonBefore, "fixture: this diamond is the canonical chain");

        vm.warp(block.timestamp + 7 days);
        comp.releaseRemitReservation(1);

        (uint256 raw, uint256 stranded, , , ) =
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
        comp.releaseRemitReservation(1);

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
        comp.releaseRemitReservation(1);
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
        , 0);
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
        comp.releaseRemitReservation(1);
        // Rewind BOTH appended slots to reproduce the pre-upgrade shape
        // (#1448 r14). Rewinding only the value would build a state that
        // cannot occur — a zero stranded total beside a release count that
        // somehow survived the upgrade — and would hide the count backfill.
        mutator.setReleasedRemitStrandedRaw(0);
        mutator.setRemitReleasedCountRaw(0);
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
        comp.seedReleasedRemitStranded(rlens.getRemitReservationNonce());

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
            comp.releaseRemitReservation(1);
            mutator.setReleasedRemitStrandedRaw(0);
            r = rlens.getRemitReservation(1);
            assertGt(recycledFull, r.recycled, "fixture: residual exists");
        }
        comp.seedReleasedRemitStranded(rlens.getRemitReservationNonce());
        (, uint256 stranded, , , , , , ) = _composition();
        assertEq(stranded, r.recycled, "sent share");
        assertLt(stranded, r.recycledFull, "NOT the pre-clamp total");
    }

    /// @dev One-shot. A second run — or a run after an organic release
    ///      already recorded some — would double-count.
    function test_Seed_RefusesWhenAlreadySeeded() public {
        _preUpgradeReleasedState();
        comp.seedReleasedRemitStranded(rlens.getRemitReservationNonce());
        (, uint256 stranded, , , , , , ) = _composition();
        uint256 seedTo = 2;
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCompensationDispatchFacet.ReleasedRemitStrandedAlreadySeeded.selector,
                stranded
            )
        );
        comp.seedReleasedRemitStranded(seedTo);
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
        comp.releaseRemitReservation(1);

        // A second remit of the re-opened day, released in turn.
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 3e18, 0);
        _remitDay1ToArb();
        LibVaipakam.RemitReservation memory r2 = rlens.getRemitReservation(2);
        // 8 days, not another 7: two IDENTICAL `vm.warp(block.timestamp + N)`
        // expressions get common-subexpression-eliminated under viaIR and the
        // second is a no-op, so the release would revert RemitReleaseTooEarly.
        vm.warp(block.timestamp + 8 days);
        comp.releaseRemitReservation(2);

        assertEq(rlens.getRemitReservationNonce(), 2, "fixture: two reservations");
        assertGt(r2.recycled, 0, "fixture: the second stranded something too");
        mutator.setReleasedRemitStrandedRaw(0);

        comp.seedReleasedRemitStranded(rlens.getRemitReservationNonce());
        (, uint256 stranded, , , , , , ) = _composition();
        assertEq(stranded, sentA + r2.recycled, "summed BOTH releases");
        assertGt(stranded, sentA, "not just the first");
    }

    /// @dev A non-released reservation contributes nothing — the scan filters
    ///      on status rather than trusting the caller to pick.
    function test_Seed_IgnoresReservationsThatWereNotReleased() public {
        _finalizeDay(1);
        _remitDay1ToArb();
        assertEq(uint256(rlens.getRemitReservation(1).status), 1, "pending");
        comp.seedReleasedRemitStranded(rlens.getRemitReservationNonce());
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
        uint256 seedTo = rlens.getRemitReservationNonce();
        vm.expectRevert(
            RewardCompensationDispatchFacet.SeedDoesNotReconcile.selector
        );
        comp.seedReleasedRemitStranded(seedTo);
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
        comp.releaseRemitReservation(1);
        // The pre-upgrade shape: the historical release recorded nothing.
        mutator.setReleasedRemitStrandedRaw(0);

        // Now a SECOND release lands organically, before the ceremony runs.
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 3e18, 0);
        _remitDay1ToArb();
        LibVaipakam.RemitReservation memory r2 = rlens.getRemitReservation(2);
        vm.warp(block.timestamp + 8 days);
        comp.releaseRemitReservation(2);

        (, uint256 before, , , , , , ) = _composition();
        assertEq(before, r2.recycled, "only the NEW release is recorded");
        assertGt(before, 0, "so the value-based guard would have refused");

        comp.seedReleasedRemitStranded(rlens.getRemitReservationNonce());

        (, uint256 after_, , , , , , ) = _composition();
        assertEq(after_, sentA + r2.recycled, "seed subsumes BOTH");
        assertGt(after_, before, "the historical amount was recovered");
    }

    /// @dev The scan ASSIGNS rather than adds, so a release already recorded
    ///      organically is not counted twice.
    function test_Seed_DoesNotDoubleCountAnAlreadyRecordedRelease() public {
        (, uint256 sent) = _remitRecycledWithResidual();
        vm.warp(block.timestamp + 7 days);
        comp.releaseRemitReservation(1);
        // Counter left AS RECORDED — not rewound. The ceremony must be a
        // no-op in value terms here.
        (, uint256 before, , , , , , ) = _composition();
        assertEq(before, sent, "recorded organically");

        comp.seedReleasedRemitStranded(rlens.getRemitReservationNonce());
        (, uint256 after_, , , , , , ) = _composition();
        assertEq(after_, sent, "assigned, not added");
    }

    /// @dev One-shot is keyed on the APPLIED flag, so a second run refuses
    ///      even though the value is unchanged.
    function test_Seed_AppliedFlagIsWhatBlocksASecondRun() public {
        _preUpgradeReleasedState();
        comp.seedReleasedRemitStranded(rlens.getRemitReservationNonce());
        (, uint256 stranded, , , , , , ) = _composition();
        uint256 seedTo = rlens.getRemitReservationNonce();
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCompensationDispatchFacet.ReleasedRemitStrandedAlreadySeeded.selector,
                stranded
            )
        );
        comp.seedReleasedRemitStranded(seedTo);
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
        uint256 seedTo = rlens.getRemitReservationNonce();
        vm.expectRevert(RewardCompensationDispatchFacet.SeedDoesNotReconcile.selector);
        comp.seedReleasedRemitStranded(seedTo);
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

        (, , bool seeded, , ) = RewardAggregatorFacet(address(diamond))
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

        (uint256 raw, , bool seeded, , ) =
            RewardAggregatorFacet(address(diamond))
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
        (, , bool seeded, , ) = RewardAggregatorFacet(address(diamond))
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
        comp.releaseRemitReservation(1);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 3e18, 0);
        _remitDay1ToArb();
        LibVaipakam.RemitReservation memory r2 = rlens.getRemitReservation(2);
        vm.warp(block.timestamp + 8 days);
        comp.releaseRemitReservation(2);
        mutator.setReleasedRemitStrandedRaw(0);
        assertEq(rlens.getRemitReservationNonce(), 2, "fixture: two ids");

        // Range 1 of 2 — NOTHING is published yet, so every relation over the
        // ledger is exactly as it was. A partial total would make bucket
        // coverage more permissive, which is the direction that hides a real
        // shortfall.
        comp.seedReleasedRemitStranded(1);
        (, uint256 midway, , , , , , ) = _composition();
        assertEq(midway, 0, "partial scan publishes nothing");

        // Range 2 finishes it, and the total is BOTH releases.
        comp.seedReleasedRemitStranded(2);
        (, uint256 finalTotal, , , , , , ) = _composition();
        assertEq(finalTotal, sentA + r2.recycled, "both releases counted once");
    }

    /// @dev A release landing mid-ceremony records organically AND may sit in
    ///      an already-scanned range, so the scan and the live counter
    ///      disagree. Refuse rather than guess.
    function test_Seed_DetectsAReleaseLandingMidCeremony() public {
        _remitRecycledWithResidual();
        vm.warp(block.timestamp + 7 days);
        comp.releaseRemitReservation(1);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 3e18, 0);
        _remitDay1ToArb();
        mutator.setReleasedRemitStrandedRaw(0);

        comp.seedReleasedRemitStranded(1); // range 1, ceremony now in flight

        // Reservation 2 is released before the operator runs range 2.
        vm.warp(block.timestamp + 8 days);
        comp.releaseRemitReservation(2);

        (, uint256 nowCounter, , , , , , ) = _composition();
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCompensationDispatchFacet.SeedRaceDetected.selector, 0, nowCounter
            )
        );
        comp.seedReleasedRemitStranded(2);
    }

    /// @dev Ranges must move forward and stay inside the pinned target — a
    ///      repeated or overlapping range is the double-count route the id
    ///      list had.
    function test_Seed_RejectsNonAdvancingOrOverrunningRanges() public {
        _preUpgradeReleasedState();
        uint256 target = rlens.getRemitReservationNonce();

        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCompensationDispatchFacet.SeedRangeInvalid.selector,
                target + 1, 0, target
            )
        );
        comp.seedReleasedRemitStranded(target + 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCompensationDispatchFacet.SeedRangeInvalid.selector, 0, 0, target
            )
        );
        comp.seedReleasedRemitStranded(0);
    }

    /// @dev The target is PINNED at the first call, so a reservation created
    ///      later cannot move the finish line — the ceremony still completes.
    function test_Seed_TargetIsPinnedAgainstLaterReservations() public {
        _preUpgradeReleasedState();
        comp.seedReleasedRemitStranded(1);
        // A new reservation appears after the ceremony started.
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 3e18, 0);
        _remitDay1ToArb();
        assertEq(rlens.getRemitReservationNonce(), 2, "nonce moved");
        // Completion is judged against the pinned target of 1, not the new
        // nonce, so the ceremony is already finished and refuses a re-run.
        (, uint256 stranded, , , , , , ) = _composition();
        assertGt(stranded, 0, "published at the pinned target");
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCompensationDispatchFacet.ReleasedRemitStrandedAlreadySeeded.selector,
                stranded
            )
        );
        comp.seedReleasedRemitStranded(2);
    }

    /// @dev #1448 r8 — detecting the race must not BRICK the ceremony. Once a
    ///      release lands mid-flight the baseline check reverts every
    ///      subsequent call, so without a reset nothing can ever publish —
    ///      the same liveness failure the resumable design was added to
    ///      remove, reintroduced by the guard protecting it.
    function test_Seed_ResetRecoversFromADetectedRace() public {
        _remitRecycledWithResidual();
        vm.warp(block.timestamp + 7 days);
        comp.releaseRemitReservation(1);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 3e18, 0);
        _remitDay1ToArb();
        mutator.setReleasedRemitStrandedRaw(0);

        comp.seedReleasedRemitStranded(1);
        vm.warp(block.timestamp + 8 days);
        comp.releaseRemitReservation(2); // the race

        (, uint256 raced, , , , , , ) = _composition();
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCompensationDispatchFacet.SeedRaceDetected.selector, 0, raced
            )
        );
        comp.seedReleasedRemitStranded(2);

        // Reset re-pins from the CURRENT state and the ceremony completes.
        comp.resetReleasedRemitStrandedSeed();
        comp.seedReleasedRemitStranded(rlens.getRemitReservationNonce());

        (, uint256 finalTotal, , , , , , ) = _composition();
        LibVaipakam.RemitReservation memory r1 = rlens.getRemitReservation(1);
        LibVaipakam.RemitReservation memory r2 = rlens.getRemitReservation(2);
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
        comp.seedReleasedRemitStranded(rlens.getRemitReservationNonce());
        (, uint256 stranded, , , , , , ) = _composition();
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCompensationDispatchFacet.ReleasedRemitStrandedAlreadySeeded.selector,
                stranded
            )
        );
        comp.resetReleasedRemitStrandedSeed();
    }

    /// @dev And it refuses when nothing is in flight, so it cannot be used to
    ///      poke at a Diamond that has never started one.
    function test_Seed_ResetRefusesWhenNothingInFlight() public {
        _preUpgradeReleasedState();
        vm.expectRevert(RewardCompensationDispatchFacet.SeedNotStarted.selector);
        comp.resetReleasedRemitStrandedSeed();
    }

    /// @dev The completion event must report RELEASED reservations, not the
    ///      reservation nonce — the latter includes pending and acked entries
    ///      and would inflate what audit consumers read (#1448 r8).
    function test_Seed_EventReportsReleasedCountNotTheNonce() public {
        _preUpgradeReleasedState();
        // Fixture: one released reservation, plus a pending one, so nonce > count.
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 3e18, 0);
        _remitDay1ToArb();
        uint256 nonce = rlens.getRemitReservationNonce();
        assertEq(nonce, 2, "fixture: 2 reservations, only 1 released");

        vm.recordLogs();
        comp.seedReleasedRemitStranded(nonce);
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
        comp.releaseRemitReservation(1);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 3e18, 0);
        _remitDay1ToArb();
        mutator.setReleasedRemitStrandedRaw(0);

        // A PARTIAL scan: target pins at 2, cursor reaches 1. Reservation 2
        // is inside the pinned range but not yet scanned, and still Pending.
        comp.seedReleasedRemitStranded(1);
        (, uint256 valueMid, , , , , , ) = _composition();
        (, , , , , uint256 countMid) =
            rlens.getReleasedRemitStrandedSeedState();

        // Release it, then rewind the value so the counter reads exactly as
        // it would after a release that stranded nothing.
        vm.warp(block.timestamp + 8 days);
        comp.releaseRemitReservation(2);
        mutator.setReleasedRemitStrandedRaw(valueMid);

        (, uint256 valueAfter, , , , , , ) = _composition();
        (, , , , , uint256 countAfter) =
            rlens.getReleasedRemitStrandedSeedState();
        assertEq(
            valueAfter,
            valueMid,
            "precondition: the value counter did NOT move - a value-only "
            "guard is blind to this release by construction"
        );
        assertEq(countAfter, countMid + 1, "but the release COUNT did move");

        // The guard must still fire, on the count. `seedTo` is hoisted: a
        // nested getter would be "the next call" and eat the expectRevert.
        uint256 seedTo = rlens.getRemitReservationNonce();
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCompensationDispatchFacet.SeedRaceDetected.selector,
                valueMid,
                valueAfter
            )
        );
        comp.seedReleasedRemitStranded(seedTo);
    }

    /// #1448 r12 — a DEMOTED chain must still be able to seed its own
    /// history. A Diamond that released remittances while canonical, was
    /// switched to mirror, and is refreshed afterwards holds exactly the
    /// status-3 reservations this ceremony reconstructs. Gating on the
    /// CURRENT role would leave it with an unseeded composition discrepancy
    /// permanently — unless an operator re-promoted a mirror purely to run a
    /// migration, which is a far worse instruction than not gating on a flag
    /// that can move underneath the ceremony.
    ///
    /// Recorded history is the real gate, and it is self-enforcing: only the
    /// canonical chain ever creates reservations, so a chain that was never
    /// canonical has an empty range and reverts `SeedNothingToScan`.
    function test_Seed_RunsOnADemotedFormerCanonicalChain() public {
        uint256 sentA = _preUpgradeReleasedState();
        assertGt(sentA, 0, "fixture: released real backing while canonical");

        // The role moves AFTER the history exists.
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(false);

        comp.seedReleasedRemitStranded(rlens.getRemitReservationNonce());

        (, uint256 stranded, , , , , , ) = _composition();
        assertEq(
            stranded,
            sentA,
            "the historical amount is recoverable after demotion - it is "
            "history, and history does not change role"
        );
    }

    /// And the gate that replaces the role check actually bites: a Diamond
    /// with no reservation history cannot seed at all, whatever its role.
    function test_Seed_RefusesWithNoReservationHistory() public {
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(false);
        vm.expectRevert(RewardCompensationDispatchFacet.SeedNothingToScan.selector);
        comp.seedReleasedRemitStranded(1);
    }

    /// The ceremony's own state must be readable. Without it an operator can
    /// only infer "has this already run?" from the published figure — which
    /// is exactly the value-based reasoning that is wrong here, since a
    /// non-zero total can be a post-upgrade release with a historical amount
    /// still unrecovered behind it.
    function test_Seed_StateIsExternallyReadable() public {
        _preUpgradeReleasedState();
        (bool appliedBefore, uint256 targetBefore, , , , ) =
            rlens.getReleasedRemitStrandedSeedState();
        assertFalse(appliedBefore, "not yet run");
        assertEq(targetBefore, 0, "none in flight");

        comp.seedReleasedRemitStranded(rlens.getRemitReservationNonce());

        (bool appliedAfter, , , uint256 accum, uint256 counted, ) =
            rlens.getReleasedRemitStrandedSeedState();
        assertTrue(appliedAfter, "one-shot is visibly spent");
        assertGt(accum, 0, "and what it recovered is readable");
        assertEq(counted, 1, "one release behind it");
    }

    /// #1448 r14 — the published pair must not contradict itself. Both
    /// counters behind it are APPENDED slots, so on a Diamond upgraded in
    /// place both start at zero with historical releases already behind them.
    /// The scan recovers the history into `counted`; without the matching
    /// backfill the tuple would advertise a "lifetime" release count SMALLER
    /// than the "found so far" subset it is meant to contain — and an
    /// operator reconciling it against the release history, exactly as the
    /// runbook instructs, would find it short by every pre-upgrade release.
    ///
    /// Asserts the STORED counter (via the getter's own field), not a figure
    /// derived for display: it is what a later consumer reads.
    function test_Seed_BackfillsTheLifetimeReleaseCount() public {
        _preUpgradeReleasedState();

        // Precondition: the shape this exists for. One release is real and
        // recorded in the reservation, but the lifetime counter cannot see it.
        (, , , , , uint256 countBefore) =
            rlens.getReleasedRemitStrandedSeedState();
        assertEq(countBefore, 0, "precondition: appended slot reads zero");
        assertEq(
            uint256(rlens.getRemitReservation(1).status),
            3,
            "precondition: yet the release itself is real and Released"
        );

        comp.seedReleasedRemitStranded(rlens.getRemitReservationNonce());

        (bool applied, , , , uint256 counted, uint256 lifetime) =
            rlens.getReleasedRemitStrandedSeedState();
        assertTrue(applied, "ceremony completed");
        assertEq(counted, 1, "the scan found the historical release");
        assertEq(
            lifetime,
            counted,
            "and the lifetime count was backfilled to match - not left at 0, "
            "which would make the published tuple self-contradictory"
        );
    }

    /// The backfill must not be able to DISCARD releases either — the
    /// direction the assert covers. A count above what the scan found can
    /// only mean the two disagree about the history, which must revert rather
    /// than quietly overwrite. Unreachable through the public surface (the
    /// race guard blocks completion after any mid-ceremony release), so it is
    /// reached here by forcing the counter above the scan's own tally.
    function test_Seed_RefusesToShrinkTheLifetimeReleaseCount() public {
        _preUpgradeReleasedState();
        mutator.setRemitReleasedCountRaw(5);

        uint256 seedTo = rlens.getRemitReservationNonce();
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCompensationDispatchFacet.SeedWouldShrinkReleasedCount.selector,
                1,
                5
            )
        );
        comp.seedReleasedRemitStranded(seedTo);
    }

    /// @dev Current interaction-schedule day (arming must be strictly future).
    function _today() internal view returns (uint256 d) {
        (d, ) = InteractionRewardsLensFacet(address(diamond))
            .getInteractionCurrentDay();
    }

    /// @dev Two-day batch, for the cutover-straddling case.
    function _days2(uint256 a, uint256 b)
        internal
        pure
        returns (uint256[] memory out)
    {
        out = new uint256[](2);
        out[0] = a;
        out[1] = b;
    }

    /// @dev Install `D*` through the CANONICAL setter (which is Base-only),
    ///      then return to the mirror chain id the ingress tests run under.
    ///      Deliberately not the raw mutator: the point of these tests is the
    ///      attribution rule reading real arming state.
    function _armFrom(uint256 dayId) internal {
        vm.chainId(CHAIN_BASE);
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(true);
        RewardAggregatorFacet(address(diamond))
            .setGovernorCommitArmedFromDay(dayId);
        vm.chainId(CHAIN_ARB);
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(false);
    }

    // ─── #1434 P1-a — delivered-fresh accounting ──────────────────────────
    //
    // The counter exists because `poolRemaining()` is not a delivered-funding
    // bound on a mirror (it is the GLOBAL 69M cap less LOCAL payouts, so every
    // mirror believes it owns the whole pool).
    //
    // It counts ARMED-ATTRIBUTABLE, COMPOSITION-KNOWN deliveries only, and
    // records everything else as `uncounted` rather than dropping it. There is
    // no subtraction here and no baseline: the first shape of this slice
    // netted a lifetime receipt cumulative against a payout snapshot taken at
    // arming, and baselining one side of a subtraction is what made it
    // unsound (Codex #1556 r1 P1 ×2). What these assert is the attribution
    // rule; the bound that will consume it lands with P1-b, which needs the
    // armed fresh PAID figure the splits do not report today.

    /// @dev The counted case, and the non-vacuity anchor for every negative
    ///      test below: an armed-day delivery whose composition arrived on
    ///      the wire is counted in full.
    function test_DeliveredFresh_CountsArmedAttributableDelivery() public {
        _configureMirror();
        uint256 dStar = _today() + 5;
        _armFrom(dStar);

        remit.onRewardBudgetReceived(
            address(vpfiTok), 7e18, _days(dStar), CHAIN_BASE, 42,
            address(0xBA5E), 0, 7e18
        );

        (uint256 counted, uint256 uncounted) = rlens.getDeliveredFreshPosition();
        assertEq(counted, 7e18, "armed-day delivery counts in full");
        assertEq(uncounted, 0, "nothing was refused");
    }

    /// @dev **Finding (c).** A wire generation that never carried the split
    ///      arrives with `freshShare == 0`, and the Diamond must NOT infer
    ///      `amount - recycledShare`. The old code did, booking a delivery of
    ///      unknown composition as entirely fresh — over-stating precisely
    ///      where least is known.
    ///
    ///      Non-vacuous by construction: the same fixture, same chain, same
    ///      armed day and same amount is counted in full by the test above.
    ///      The ONLY difference is the declared fresh share.
    function test_DeliveredFresh_UnknownCompositionCountsNothing() public {
        _configureMirror();
        uint256 dStar = _today() + 5;
        _armFrom(dStar);

        remit.onRewardBudgetReceived(
            address(vpfiTok), 7e18, _days(dStar), CHAIN_BASE, 42,
            address(0xBA5E), 0, 0
        );

        (uint256 counted, uint256 uncounted) = rlens.getDeliveredFreshPosition();
        assertEq(counted, 0, "unknown composition contributes no fresh");
        assertEq(uncounted, 7e18, "and is recorded, not discarded");
    }

    /// @dev **Finding (b).** Funding delivered for PRE-`D*` days is not armed
    ///      funding and must not enter. The withdrawn design counted it and
    ///      then tried to net it out with a payout snapshot taken at arming —
    ///      which erased the spend while keeping the receipt, so 100 VPFI
    ///      delivered and spent before arming reported as 100 VPFI of
    ///      reusable headroom. Never entering removes the whole class.
    ///
    ///      Both legs run in ONE test so the negative cannot pass vacuously:
    ///      the armed-day delivery proves the fixture counts at all.
    function test_DeliveredFresh_PreArmingDeliveryIsNotCounted() public {
        _configureMirror();
        uint256 dStar = _today() + 5;
        _armFrom(dStar);

        // Armed day -> counted.
        remit.onRewardBudgetReceived(
            address(vpfiTok), 3e18, _days(dStar), CHAIN_BASE, 42,
            address(0xBA5E), 0, 3e18
        );
        (uint256 counted, ) = rlens.getDeliveredFreshPosition();
        assertEq(counted, 3e18, "fixture counts armed deliveries");

        // A day before the cutover -> refused, same everything else.
        remit.onRewardBudgetReceived(
            address(vpfiTok), 100e18, _days(dStar - 1), CHAIN_BASE, 43,
            address(0xBA5E), 0, 100e18
        );

        uint256 uncounted;
        (counted, uncounted) = rlens.getDeliveredFreshPosition();
        assertEq(counted, 3e18, "pre-arming funding did not enter");
        assertEq(uncounted, 100e18, "it is visible as uncounted");
    }

    /// @dev A batch straddling the cutover is refused WHOLE rather than
    ///      apportioned. `_planDay` decides armedness per day but the remit
    ///      carries one summed amount for its whole day set, so nothing that
    ///      arrives here can split it; guessing a split would over-state on
    ///      the guess. Documented as a deliberate under-count.
    function test_DeliveredFresh_BatchStraddlingCutoverIsNotCounted() public {
        _configureMirror();
        uint256 dStar = _today() + 5;
        _armFrom(dStar);

        remit.onRewardBudgetReceived(
            address(vpfiTok), 8e18, _days2(dStar - 1, dStar), CHAIN_BASE, 42,
            address(0xBA5E), 0, 8e18
        );

        (uint256 counted, uint256 uncounted) = rlens.getDeliveredFreshPosition();
        assertEq(counted, 0, "one unarmed day refuses the whole batch");
        assertEq(uncounted, 8e18, "and the shortfall is visible");

        // The all-armed pair IS counted — so the refusal above is the
        // straddle, not merely "two days".
        remit.onRewardBudgetReceived(
            address(vpfiTok), 8e18, _days2(dStar, dStar + 1), CHAIN_BASE, 43,
            address(0xBA5E), 0, 8e18
        );
        (counted, ) = rlens.getDeliveredFreshPosition();
        assertEq(counted, 8e18, "an all-armed batch counts");
    }

    /// @dev An unarmed chain has no armed regime to attribute funding to, and
    ///      a delivery naming no days cannot be shown to fund armed ones.
    ///      Both refuse; both stay visible.
    function test_DeliveredFresh_UnarmedChainAndEmptyDaySetCountNothing()
        public
    {
        _configureMirror();

        // Unarmed: `governorCommitArmedFromDay` is still 0.
        remit.onRewardBudgetReceived(
            address(vpfiTok), 5e18, _days(9), CHAIN_BASE, 42,
            address(0xBA5E), 0, 5e18
        );
        (uint256 counted, uint256 uncounted) = rlens.getDeliveredFreshPosition();
        assertEq(counted, 0, "unarmed chain counts nothing");
        assertEq(uncounted, 5e18, "recorded");

        // Armed, but the delivery names no days.
        uint256 dStar = _today() + 5;
        _armFrom(dStar);
        remit.onRewardBudgetReceived(
            address(vpfiTok), 6e18, new uint256[](0), CHAIN_BASE, 43,
            address(0xBA5E), 0, 6e18
        );
        (counted, uncounted) = rlens.getDeliveredFreshPosition();
        assertEq(counted, 0, "empty day set counts nothing");
        assertEq(uncounted, 11e18, "both refusals accumulate");
    }

    /// @dev Only the FRESH component accrues. The recycled component is
    ///      bounded separately — it credits the bucket as relocated custody
    ///      (B2-d5) — so counting it here would double-count backing. The
    ///      two counters still account for the whole non-recycled remainder.
    function test_DeliveredFresh_ExcludesRecycledComponent() public {
        _configureMirror();
        uint256 dStar = _today() + 5;
        _armFrom(dStar);
        // Back the relocated-custody credit: {creditCustodyRelocated} asserts
        // `balance >= bucket + share`, so the tokens must really be here.
        vpfiTok.transfer(address(diamond), 10e18);

        remit.onRewardBudgetReceived(
            address(vpfiTok), 10e18, _days(dStar), CHAIN_BASE, 43,
            address(0xBA5E), 4e18, 6e18
        );

        (uint256 counted, uint256 uncounted) = rlens.getDeliveredFreshPosition();
        assertEq(counted, 6e18, "10 delivered, 4 recycled -> 6 fresh");
        assertEq(uncounted, 0, "the remainder was fully attributed");
    }

    /// @dev The accounting identity the pair exists to support: across a
    ///      counted delivery, a refused one, and one carrying recycled
    ///      backing, `counted + uncounted` equals the summed NON-RECYCLED
    ///      delivery. Nothing is invented and nothing is lost — which is what
    ///      makes `uncounted` usable for reconciliation rather than a hint.
    function test_DeliveredFresh_CountedPlusUncountedIsExhaustive() public {
        _configureMirror();
        uint256 dStar = _today() + 5;
        _armFrom(dStar);
        vpfiTok.transfer(address(diamond), 4e18);

        remit.onRewardBudgetReceived(
            address(vpfiTok), 7e18, _days(dStar), CHAIN_BASE, 42,
            address(0xBA5E), 0, 7e18
        );
        remit.onRewardBudgetReceived(
            address(vpfiTok), 5e18, _days(dStar - 2), CHAIN_BASE, 43,
            address(0xBA5E), 0, 5e18
        );
        remit.onRewardBudgetReceived(
            address(vpfiTok), 9e18, _days(dStar), CHAIN_BASE, 44,
            address(0xBA5E), 4e18, 5e18
        );

        (uint256 counted, uint256 uncounted) = rlens.getDeliveredFreshPosition();
        // 7 counted + 5 refused + 5 counted = 12 counted, 5 uncounted; the
        // 4e18 recycled leg belongs to the bucket, not to either counter.
        assertEq(counted, 12e18, "both armed deliveries counted");
        assertEq(uncounted, 5e18, "the pre-arming one refused");
        assertEq(
            counted + uncounted,
            (7e18) + (5e18) + (9e18 - 4e18),
            "exhaustive over the non-recycled delivery"
        );
    }

    /// @dev The two shares are bounded JOINTLY. Each is individually no
    ///      larger than the delivery here, and they still sum past it — the
    ///      case a per-share bound would wave through, letting one delivery
    ///      be booked as both relocated recycled custody and armed fresh.
    function test_DeliveredFresh_RevertsWhenSharesJointlyExceedDelivery()
        public
    {
        _configureMirror();
        uint256 dStar = _today() + 5;
        _armFrom(dStar);

        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.FreshShareExceedsDelivery.selector, 7e18, 6e18
            )
        );
        remit.onRewardBudgetReceived(
            address(vpfiTok), 10e18, _days(dStar), CHAIN_BASE, 45,
            address(0xBA5E), 4e18, 7e18
        );
    }

    /// @dev Accept ETH refunds from the remit fee path.
    receive() external payable {}
    // ── #1434 P2-w5: the recovery position + uncharged re-dispatch ────────

    /// Arm this test contract as the Base return-channel "receiver" so it
    /// can present authenticated B1 settlements to the ingress directly.
    function _armReturnIngress() internal {
        RepatriationFacet(address(diamond)).setRepatriationEndpoints(
            address(0), address(this)
        );
    }

    /// Bucket component of the backing snapshot (w6 ceremony tests).
    function _bucket() internal view returns (uint256 bucket) {
        (, bucket, , , , , , ) = InteractionRewardsLensFacet(
            address(diamond)
        ).getRecycleBackingSnapshot();
    }

    /// Same arming, named for tests that deliberately present NO ack
    /// first (the r4 refusal paths).
    function _armReturnIngressNoAck() internal {
        RepatriationFacet(address(diamond)).setRepatriationEndpoints(
            address(0), address(this)
        );
    }

    /// §8-5 — the full arc: charged dispatch → authenticated return
    /// (position credited, gate cleared, NO headroom restored) → release
    /// re-opens the day → UNCHARGED re-dispatch from the position (cap
    /// untouched, redispatched advances, reservation stamped).
    function test_Recovery_ReturnThenUnchargedRedispatch() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        uint256 globalAfter = rlens.getRewardBudgetRemittedGlobal();
        // #1660 r4 - positive non-consumption evidence precedes credit.
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, false);

        _armReturnIngress();
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 3e18, 3e18, 0
        );
        (uint256 recovered, uint256 redispatched, uint256 overage) =
            rlens.getRecoveryPosition();
        assertEq(recovered, 3e18, "position credited");
        assertEq(redispatched, 0);
        assertEq(overage, 0);
        assertEq(
            rlens.getCompensationOutstanding(CHAIN_ARB),
            0,
            "return settlement cleared the gate"
        );
        assertEq(
            rlens.getRewardBudgetRemittedGlobal(),
            globalAfter,
            "the return restores NO headroom"
        );

        // #1660 r3/r4 - the terminal return itself re-opened the day
        // (closure unwound); no release needed - and none possible, the
        // reservation is Acked (statuses partition: return needs 2/3,
        // release needs 1).
        assertEq(rlens.getDayClosedByRemitId(CHAIN_ARB, 1), 0);

        // Uncharged re-dispatch from the position.
        comp.remitManualBudgetFromRecovery{value: 0.01 ether}(
            CHAIN_ARB, 1, 2e18, 1e18, 1
        );
        assertEq(
            rlens.getRewardBudgetRemittedGlobal(),
            globalAfter,
            "cap untouched by the re-dispatch"
        );
        (recovered, redispatched, ) = rlens.getRecoveryPosition();
        assertEq(redispatched, 3e18, "position consumed");
        assertTrue(
            rlens.getRemitReservation(2).fundedFromRecovery,
            "reservation stamped fundedFromRecovery"
        );

        // Receipt 1's own credit is now fully spent: a further draw
        // against it refuses at the PER-RECEIPT bound (#1662 r2), which
        // precedes the pooled backstop - and is the bound that makes the
        // contradiction claw attributable rather than confiscatory.
        // Absolute warp - viaIR CSEs identical block.timestamp reads
        // across vm.warp within one test frame (the warp-CSE gotcha).
        vm.warp(30 days);
        comp.releaseRemitReservation(2);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RecoveryReceiptCreditInsufficient.selector,
                1,
                3e18,
                0
            )
        );
        comp.remitManualBudgetFromRecovery{value: 0.01 ether}(
            CHAIN_ARB, 1, 2e18, 1e18, 1
        );
    }

    /// A released FROM-RECOVERY reservation restores neither headroom
    /// (never charged) nor the position (tokens are physically outside
    /// custody until the R6d ceremony brings them home).
    function test_Recovery_ReleaseOfRedispatchRestoresNothing() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        uint256 globalAfter = rlens.getRewardBudgetRemittedGlobal();
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, false);
        _armReturnIngress();
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 3e18, 3e18, 0
        );
        // (terminal return re-opened the day - no release of the Acked
        // reservation needed or possible)
        comp.remitManualBudgetFromRecovery{value: 0.01 ether}(
            CHAIN_ARB, 1, 2e18, 1e18, 1
        );
        vm.warp(30 days); // absolute - the warp-CSE gotcha
        comp.releaseRemitReservation(2);
        assertEq(
            rlens.getRewardBudgetRemittedGlobal(),
            globalAfter,
            "release of an uncharged dispatch restores no headroom"
        );
        (, uint256 redispatched, ) = rlens.getRecoveryPosition();
        assertEq(
            redispatched,
            3e18,
            "position NOT restored by release - the ceremony's job"
        );
    }

    /// The entitlement bound accumulates per receipt: a duplicate return
    /// finds no headroom and lands whole in the overage quarantine.
    function test_Recovery_DuplicateReturnQuarantinesAsOverage() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, false);
        _armReturnIngress();
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 3e18, 3e18, 0
        );
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 3e18, 3e18, 0
        );
        (uint256 recovered, , uint256 overage) = rlens.getRecoveryPosition();
        assertEq(recovered, 3e18, "entitlement caps the receipt cumulative");
        assertEq(overage, 3e18, "duplicate quarantined whole");
        assertEq(rlens.getRecoveredForReceipt(1), 3e18);
    }

    /// Ingress auth: only the configured receiver satellite may present a
    /// settlement; unknown reservations refuse.
    function test_Recovery_IngressAuthAndUnknownReservation() public {
        _finalizeDay(1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.OnlyStrandedReturnReceiver.selector,
                address(this)
            )
        );
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 1e18, 1e18, 0
        );
        _armReturnIngress();
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.StrandedReturnUnknownReservation.selector,
                77
            )
        );
        comp.onStrandedReturnReceived(
            address(diamond), 77, 1, CHAIN_ARB, address(vpfiTok), 1e18, 1e18, 0
        );
    }

    /// #1660 r1 — only COMPENSATION reservations are a valid entitlement
    /// basis: an ordinary batch remit (recycled component never charged
    /// the cap) is refused, so a faulty mirror cannot mint uncharged
    /// re-dispatch capacity off a batch receipt.
    function test_Recovery_BatchReservationRefused() public {
        _finalizeDay(1);
        _remitDay1ToArb(); // ordinary batch reservation, remitId 1
        _armReturnIngress();
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.StrandedReturnNotCompensation.selector, 1
            )
        );
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 1e18, 1e18, 0
        );
    }

    /// #1660 r1 — a short actual is TRANSPORT LOSS: recorded per receipt
    /// (the mirror's one-shot record retired at declared and can never
    /// re-send the gap), credited only at the actual, gate still settles.
    function test_Recovery_ShortActualRecordsShortfall() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, false);
        _armReturnIngress();
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 3e18, 2.5e18, 0
        );
        (uint256 recovered, , uint256 overage) = rlens.getRecoveryPosition();
        assertEq(recovered, 2.5e18, "credited at the actual");
        assertEq(overage, 0);
        assertEq(
            rlens.getStrandedReturnShortfall(1),
            0.5e18,
            "transport loss recorded per receipt"
        );
        assertEq(
            rlens.getCompensationOutstanding(CHAIN_ARB),
            0,
            "gate settles on the short delivery too"
        );
    }

    /// #1660 r8 - CONTRADICTORY classifications freeze the return credit:
    /// a consumed ack landing after quarantine eligibility (impossible for
    /// an honest mirror) claws the receipt's unspent credit into the
    /// overage quarantine; what a re-dispatch already consumed is reported
    /// unrecoverable, and every further B1 credit is blocked.
    function test_Recovery_ClassificationConflictFreezesCredit() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, false);
        _armReturnIngressNoAck();
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 3e18, 3e18, 0
        );
        // 2e18 of the credit is already re-dispatched (spent).
        comp.remitManualBudgetFromRecovery{value: 0.01 ether}(
            CHAIN_ARB, 1, 1.5e18, 0.5e18, 1
        );
        // The contradicting consumed ack lands: the unspent 1e18 is clawed
        // into the overage quarantine; 2e18 is unrecoverable on-chain.
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, 3e18);
        (uint256 recovered, uint256 redispatched, uint256 overage) =
            rlens.getRecoveryPosition();
        assertEq(recovered, 2e18, "unspent credit clawed out");
        assertEq(redispatched, 2e18, "spent slice untouched");
        assertEq(overage, 1e18, "clawed slice quarantined");
        // Position balance (recovered - redispatched) is zero: no further
        // uncharged capacity exists.

        // #1660 r9 - the claw is ONE-SHOT: another receipt's legitimate
        // credit lands, and a REPLAYED conflicting consumed ack must not
        // drain it into the overage quarantine.
        mutator.setRemitReservationCompRaw(80, CHAIN_ARB, 2, 1e18, 6);
        comp.onStrandedReturnReceived(
            address(diamond), 80, 6, CHAIN_ARB, address(vpfiTok), 1e18, 1e18,
            0
        );
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, 3e18); // replay
        (recovered, redispatched, overage) = rlens.getRecoveryPosition();
        assertEq(recovered, 3e18, "unrelated credit untouched by the replay");
        assertEq(overage, 1e18, "no second claw");
        // #1660 r11 - the conflict re-added the original's declared split
        // on top of the successor's funding: the cumulative reflects the
        // consumed reality and freezes further headroom, while the
        // successor's closure was never clobbered.
        (uint256 cfl, uint256 cfb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(cfl, 1.5e18 + 2e18, "declared re-added over successor");
        assertEq(cfb, 0.5e18 + 1e18, "declared re-added over successor");
        assertEq(
            rlens.getDayClosedByRemitId(CHAIN_ARB, 1),
            2,
            "successor closure untouched"
        );
    }

    /// #1660 r11 - a conflict landing while the terminal-reopened day is
    /// still OPEN re-closes it under the original receipt and restores
    /// the declared funding: the consumed delivery still backs mirror
    /// claims, so the re-opened funding path must close again.
    function test_Recovery_ConflictReclosesReopenedDay() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, false);
        _armReturnIngressNoAck();
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 3e18, 3e18, 0
        );
        assertEq(rlens.getDayClosedByRemitId(CHAIN_ARB, 1), 0, "re-opened");
        // The contradicting consumed ack lands before any replacement.
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, 3e18);
        assertEq(
            rlens.getDayClosedByRemitId(CHAIN_ARB, 1),
            1,
            "day re-closed under the original receipt"
        );
        (uint256 fl, uint256 fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 2e18, "declared funding restored");
        assertEq(fb, 1e18, "declared funding restored");
        // A fresh manual dispatch is refused - the obligation is closed.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RemitDayAlreadyClosed.selector, 1, CHAIN_ARB
            )
        );
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 1e18, 1e18);
    }

    /// #1660 r8 - the reverse contradiction: a quarantine ack after a
    /// consumed one never forges B1 eligibility.
    function test_Recovery_QuarantineAfterConsumedNeverEligible() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, 3e18); // consumed
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, false);
        _armReturnIngressNoAck();
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.StrandedReturnConsumedReceipt.selector, 1
            )
        );
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 3e18, 3e18, 0
        );
    }

    /// #1660 r6 - the wire's classification word offsets by one so the
    /// retired generation-1 bool shape cannot be misread: a legacy
    /// non-consumed ack (bool false = 0) refuses re-executably, while a
    /// legacy consumed ack (bool true = 1) decodes as consumed with
    /// identical semantics (proven by every deliverRemitAck fixture).
    function test_Recovery_LegacyZeroClassificationRefused() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RemitAckClassificationInvalid.selector, 0
            )
        );
        rewardMessenger.deliverRemitAckWithClassification(CHAIN_ARB, 1, 3e18, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RemitAckClassificationInvalid.selector, 4
            )
        );
        rewardMessenger.deliverRemitAckWithClassification(CHAIN_ARB, 1, 3e18, 4);
        // The re-presented current-encoding ack settles normally.
        rewardMessenger.deliverRemitAckWithClassification(CHAIN_ARB, 1, 3e18, 2);
        assertEq(uint256(rlens.getRemitReservation(1).status), 2);
    }

    /// #1660 r5 - a PROVISIONAL attestation is not quarantine evidence:
    /// the receipt can still confirm as consumed, so the return waits for
    /// a true quarantine ack - and after the consumed confirmation, the
    /// consumed stamp refuses it outright.
    function test_Recovery_ProvisionalAckNotReturnEvidence() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        // The mirror credited PROVISIONALLY (compensation overtook V3);
        // its ack attests classification 2.
        rewardMessenger.deliverRemitAckWithClassification(CHAIN_ARB, 1, 3e18, 3);
        _armReturnIngressNoAck();
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.StrandedReturnAwaitingAck.selector, 1, 2
            )
        );
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 3e18, 3e18, 0
        );
        // The V3 confirm settled the credit CONSUMED; the re-presented
        // ack stamps it and the return is refused outright.
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, 3e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.StrandedReturnConsumedReceipt.selector, 1
            )
        );
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 3e18, 3e18, 0
        );
    }

    /// #1660 r5 - the re-opened manual path holds the CUMULATIVE per-side
    /// quote bound: a successor supplement's retained funding plus the
    /// fresh request can never pass the quote, so a re-opened day cannot
    /// be overfunded on top of a successful supplement.
    function test_Recovery_ReopenedDayKeepsCumulativeQuoteBound() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, false);
        _armReturnIngressNoAck();
        // Non-terminal chunk clears the gate; a supplement tops the day
        // up to the full quote while the terminal chunk is in flight.
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 1e18, 1e18,
            2e18
        );
        comp.remitSupplementalBudget{value: 0.01 ether}(
            CHAIN_ARB, 1, 1e18, 1e18
        );
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 2, 2e18); // consumed
        // The original's terminal chunk re-opens the day (its declared
        // unwinds; the supplement's funding is retained).
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 2e18, 2e18, 0
        );
        assertEq(rlens.getDayClosedByRemitId(CHAIN_ARB, 1), 0);
        (uint256 fl, uint256 fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 1e18, "supplement funding retained");
        assertEq(fb, 1e18, "supplement funding retained");
        // A full-quote re-dispatch on top would overfund: refused on the
        // CUMULATIVE bound.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CompensationExceedsQuote.selector,
                4e18,
                3e18,
                3e18,
                2e18
            )
        );
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 3e18, 2e18);
        // The legitimate remainder passes.
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        (fl, fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 3e18, "cumulative lands exactly at quote");
        assertEq(fb, 2e18, "cumulative lands exactly at quote");
    }

    // -- #1434 P2-w6: the recovery ceremony + R6e rotation (SS8-6) ------

    /// Fixture: a released compensation reservation (remit 1, day 1,
    /// total 3e18, FRESH-only by construction) with the gate still held
    /// by it; each test brings the stranded tokens "home" as needed.
    function _releasedCeremonyFixture() internal {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        vm.warp(block.timestamp + 7 days);
        comp.releaseRemitReservation(1);
        assertEq(
            rlens.getCompensationOutstanding(CHAIN_ARB),
            1,
            "release holds the gate"
        );
    }

    /// Fixture: a RELEASED batch remit carrying BOTH provenances, both
    /// strictly positive. `_remitRecycledWithResidual` arms a
    /// recycled-ONLY slice, which makes every per-component assertion
    /// collapse into the total - a component bound cannot be told apart
    /// from the total bound when one component is the whole reservation.
    function _releasedMixedFixture()
        internal
        returns (LibVaipakam.RemitReservation memory r)
    {
        _finalizeDay(1);
        _armDayForArb(1, 20e18, 50e18);
        mutator.setRecycleBucketRaw(1_000e18);
        mutator.setRecycleCreditedCumulativeRaw(1_000e18);
        mutator.setOutstandingCommitRaw(0, 1_000e18);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 3e18, 0);
        _remitDay1ToArb();
        vm.warp(block.timestamp + 7 days);
        comp.releaseRemitReservation(1);
        r = rlens.getRemitReservation(1);
        // LIVE-fixture assertions: the properties below are only
        // meaningful while BOTH components are non-zero.
        assertGt(r.fresh, 0, "fixture: a fresh component exists");
        assertGt(r.recycled, 0, "fixture: a recycled component exists");
        vpfiTok.mint(address(diamond), 2_000e18 + r.total);
    }

    /// SS8-6 - a compensation reservation is FRESH-only by construction,
    /// so its ceremony is bounded all-fresh (#1662 r1: the total bound
    /// alone cannot see a provenance relabel that would move uncharged
    /// value into the bucket's claimable custody). The fresh credit lands
    /// in the w5 recovery position, folds into the ONE per-receipt
    /// recovered cumulative, and clears the gate only at FULL resolution.
    function test_Ceremony_CompFreshOnlyCreditsPositionAndClears() public {
        _releasedCeremonyFixture();
        vpfiTok.mint(address(diamond), 3e18); // pool -> Diamond, physically
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CeremonyProvenanceExceeded.selector,
                1,
                1e18,
                0
            )
        );
        comp.recordRecoveryCeremony(1, 2e18, 1e18);
        comp.recordRecoveryCeremony(1, 3e18, 0);
        (uint256 recovered, , ) = rlens.getRecoveryPosition();
        assertEq(recovered, 3e18, "the fresh credit entered the position");
        assertEq(rlens.getRecoveredForReceipt(1), 3e18, "one cumulative");
        assertEq(
            rlens.getCompensationOutstanding(CHAIN_ARB),
            0,
            "full resolution clears the gate"
        );
        // The recovered value re-dispatches UNCHARGED from the position.
        uint256 globalBefore = rlens.getRewardBudgetRemittedGlobal();
        comp.remitManualBudgetFromRecovery{value: 0.01 ether}(
            CHAIN_ARB, 1, 1.5e18, 0.5e18, 1
        );
        assertEq(
            rlens.getRewardBudgetRemittedGlobal(),
            globalBefore,
            "ceremony-recovered value re-dispatches uncharged"
        );
    }

    /// SS8-6 (#1662 r1) - a released BATCH remit's ceremony books each
    /// half under its own dispatched provenance: the recycled half
    /// re-enters as relocated bucket custody, and a component past the
    /// reservation's own split refuses even inside the total bound.
    function test_Ceremony_BatchRecycledHalfRelocates() public {
        LibVaipakam.RemitReservation memory r = _releasedMixedFixture();
        // Relabeling the recycled half as "fresh" refuses at the
        // provenance bound even though the total bound would pass.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CeremonyProvenanceExceeded.selector,
                1,
                r.fresh + r.recycled,
                r.fresh
            )
        );
        comp.recordRecoveryCeremony(1, r.fresh + r.recycled, 0);
        uint256 bucketBefore = _bucket();
        comp.recordRecoveryCeremony(1, r.fresh, r.recycled);
        assertEq(
            _bucket() - bucketBefore,
            r.recycled,
            "the recycled half relocated into the bucket"
        );
        (uint256 recovered, , ) = rlens.getRecoveryPosition();
        assertEq(recovered, r.fresh, "the fresh half entered the position");
        assertEq(rlens.getRecoveredForReceipt(1), r.total, "one cumulative");
    }

    /// SS8-6 - partial recoveries HOLD the gate; the terminal-loss record
    /// completes the identity; over-recording refuses.
    function test_Ceremony_PartialHoldsGateAndLossCompletes() public {
        _releasedCeremonyFixture();
        vpfiTok.mint(address(diamond), 2e18);
        comp.recordRecoveryCeremony(1, 1e18, 0);
        assertEq(
            rlens.getCompensationOutstanding(CHAIN_ARB),
            1,
            "partial recovery holds the gate"
        );
        comp.recordRecoveryCeremony(1, 1e18, 0);
        assertEq(rlens.getCompensationOutstanding(CHAIN_ARB), 1, "still held");
        // Over-recording past the dispatched total refuses.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CeremonyExceedsStranded.selector,
                1,
                4e18,
                3e18
            )
        );
        comp.recordRecoveryTerminalLoss(1, 2e18, 0);
        // The evidenced terminal loss completes the resolution.
        comp.recordRecoveryTerminalLoss(1, 1e18, 0);
        assertEq(rlens.getCeremonyTerminalLoss(1), 1e18);
        assertEq(
            rlens.getCompensationOutstanding(CHAIN_ARB),
            0,
            "recovered + loss == stranded clears the gate"
        );
    }

    /// SS8-6 - ceremony guards: live reservations refuse (their value
    /// settles through acks/returns), and a books-only recovery with no
    /// tokens behind it rolls back.
    function test_Ceremony_Guards() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CeremonyReservationNotReleased.selector, 1
            )
        );
        comp.recordRecoveryCeremony(1, 1e18, 0);
        vm.warp(block.timestamp + 7 days);
        comp.releaseRemitReservation(1);
        // Books-only: pin the bucket at the whole balance so the fresh
        // credit has NO unearmarked float behind it - a recovery with no
        // tokens actually home must roll back at the record.
        uint256 bal = vpfiTok.balanceOf(address(diamond));
        mutator.setRecycleBucketRaw(bal);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CeremonyInflowNotBacked.selector,
                1,
                bal,
                bal + 1e18
            )
        );
        comp.recordRecoveryCeremony(1, 1e18, 0);
    }

    /// SS8-6 (#1662 r1/r2) - a CLEAN late CONSUMED ack on a released
    /// reservation closes BOTH ceremony records (the value backs mirror
    /// claims - it is neither recoverable nor "terminal loss") AND clears
    /// the gate itself. Both halves matter: r1 added the refusals, and
    /// without the r2 clear those refusals BRICKED the chain - consumption
    /// closes the B1 return path and both governance records, so no
    /// writer could ever clear the gate again.
    function test_Ceremony_CleanConsumedRefusesRecordsAndClearsGate()
        public
    {
        _releasedCeremonyFixture();
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, true);
        assertEq(
            rlens.getCompensationOutstanding(CHAIN_ARB),
            0,
            "a settled delivery discharges the gate's premise"
        );
        vpfiTok.mint(address(diamond), 3e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.StrandedReturnConsumedReceipt.selector, 1
            )
        );
        comp.recordRecoveryCeremony(1, 1e18, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.StrandedReturnConsumedReceipt.selector, 1
            )
        );
        comp.recordRecoveryTerminalLoss(1, 1e18, 0);
        // The chain is LIVE again - the brick is what this pins.
        _finalizeDay(2);
        mutator.setChainDayRemitIneligibleRaw(2, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 2, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 2, 2e18, 1e18);
    }

    /// SS8-6 (#1662 r2) - a CONTRADICTED consumption (the mirror attested
    /// quarantine, then consumed) earns no trust, so it clears NOTHING -
    /// and precisely because it clears nothing, it must NOT close the
    /// governance settlement paths too. Under contradiction the operator's
    /// evidenced record is the only remaining source of truth; closing it
    /// as well is what would leave the gate permanently unclearable.
    function test_Ceremony_ContradictedConsumptionKeepsSettlementOpen()
        public
    {
        _releasedCeremonyFixture();
        // Quarantine first, then the contradicting consumption.
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, false);
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, true);
        assertEq(
            rlens.getCompensationOutstanding(CHAIN_ARB),
            1,
            "a contradicted consumption clears nothing"
        );
        // The evidenced settlement still runs, and resolves the gate.
        comp.recordRecoveryTerminalLoss(1, 3e18, 0);
        assertEq(
            rlens.getCompensationOutstanding(CHAIN_ARB),
            0,
            "governance evidence remains able to settle"
        );
    }

    /// SS8-6 (#1662 r2) - a ceremony credits the recovery position on
    /// GOVERNANCE evidence, requiring no quarantine attestation, so the
    /// w5 claw's `quarantineAcked` trigger never fired for it: a later
    /// consumed attestation left ceremony-minted UNCHARGED re-dispatch
    /// capacity standing against value that also backs mirror claims -
    /// the 69M bypass the claw exists to prevent. The claw now fires on
    /// any standing position credit.
    function test_Ceremony_ConsumedAckClawsCeremonyCredit() public {
        _releasedCeremonyFixture();
        vpfiTok.mint(address(diamond), 3e18);
        comp.recordRecoveryCeremony(1, 2e18, 0);
        (uint256 recovered, , ) = rlens.getRecoveryPosition();
        assertEq(recovered, 2e18, "the ceremony credited the position");
        (, , uint256 overageBefore) = rlens.getRecoveryPosition();
        // The mirror now attests the delivery was CONSUMED after all.
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, true);
        (uint256 recAfter, uint256 redis, uint256 overageAfter) =
            rlens.getRecoveryPosition();
        assertEq(
            recAfter - redis,
            0,
            "the contradicted capacity is clawed out of the position"
        );
        assertEq(
            overageAfter - overageBefore,
            2e18,
            "and frozen in the overage quarantine"
        );
    }

    /// SS8-6 (#1662 r2) - the claw must size on the POSITION-provenance
    /// part only. A ceremony folds its RECYCLED half into the same
    /// per-receipt cumulative while sending that half to the BUCKET, so
    /// clawing the raw cumulative would debit the GLOBAL position for
    /// value that never entered it - draining an unrelated receipt's
    /// legitimate uncharged capacity into the permanent quarantine.
    function test_Ceremony_ClawExcludesRecycledHalfAndSparesOthers()
        public
    {
        // Receipt 1: a released BATCH remit with both provenances.
        LibVaipakam.RemitReservation memory r = _releasedMixedFixture();
        comp.recordRecoveryCeremony(1, r.fresh, r.recycled);
        (uint256 fresh1, uint256 recycled1) = rlens.getCeremonyRecovered(1);
        assertEq(fresh1, r.fresh, "stored fresh cumulative");
        assertEq(recycled1, r.recycled, "stored recycled cumulative");

        // An UNRELATED receipt's position credit, standing alongside
        // receipt 1's own fresh credit. The claw sizes on the GLOBAL
        // position, so an over-claw is only observable against capacity
        // that does not belong to the contradicted receipt.
        uint256 posBefore = r.fresh + 5e18;
        mutator.setRecoveryPositionRaw(posBefore, 0);

        // Receipt 1 is now contradicted by a consumed attestation.
        rewardMessenger.deliverRemitAckWithConsumed(
            CHAIN_ARB, 1, r.total, true
        );
        (uint256 recAfter, uint256 redisAfter, ) = rlens.getRecoveryPosition();
        assertEq(
            posBefore - (recAfter - redisAfter),
            r.fresh,
            "only receipt 1's FRESH credit is clawed - the recycled half went to the bucket, and the unrelated 5e18 is untouched"
        );
    }

    /// SS8-6 (#1662 r2) - the a4 provenance bounds are CUMULATIVE, not
    /// per-call: two ceremonies whose fresh halves sum past the
    /// reservation's own fresh split must refuse. Without the accumulator
    /// term a caller could recover a component twice, one call at a time.
    ///
    /// A BATCH reservation is required here, not a compensation one: a
    /// compensation is fresh-only, so its fresh bound and its total bound
    /// are the same number and the total bound fires first - the component
    /// bound would go untested against exactly the mutation it exists for.
    function test_Ceremony_ProvenanceBoundIsCumulative() public {
        LibVaipakam.RemitReservation memory r = _releasedMixedFixture();
        comp.recordRecoveryCeremony(1, r.fresh, 0);
        (uint256 fresh1, ) = rlens.getCeremonyRecovered(1);
        assertEq(fresh1, r.fresh, "the accumulator is STORED, not per-call");
        // Still well inside the TOTAL bound - only the cumulative FRESH
        // bound can refuse this, which is the point.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CeremonyProvenanceExceeded.selector,
                1,
                r.fresh + 1,
                r.fresh
            )
        );
        comp.recordRecoveryCeremony(1, 1, 0);
    }

    /// SS8-6 (#1662 r2) - a recovery settlement's RECYCLED half returns
    /// value the release recorded as stranded, but the stranded record is
    /// monotone history and does not retire. The recovered cumulative is
    /// what lets an external checker net the two: without it, the coverage
    /// allowance `bucket + stranded` backs the same VPFI twice forever.
    function test_Ceremony_RecycledHalfAdvancesRecoveredCumulative()
        public
    {
        LibVaipakam.RemitReservation memory r = _releasedMixedFixture();
        (, uint256 strandedBefore, , , ) = RewardAggregatorFacet(
            address(diamond)
        ).getRecycleCompositionPosition();
        assertGt(strandedBefore, 0, "fixture: the release stranded value");
        comp.recordRecoveryCeremony(1, r.fresh, r.recycled);
        (
            ,
            uint256 strandedAfter,
            ,
            ,
            uint256 recoveredAfter
        ) = RewardAggregatorFacet(address(diamond))
            .getRecycleCompositionPosition();
        assertEq(
            strandedAfter,
            strandedBefore,
            "the stranded record is monotone history - it does not retire"
        );
        assertEq(
            recoveredAfter,
            r.recycled < strandedBefore ? r.recycled : strandedBefore,
            "the recovered cumulative advances, capped at the stranded record"
        );
    }

    // -- #1662 r2: the five round-2 findings -------------------------

    /// r2-b1 - a ceremony-settled released receipt that LATER takes a
    /// clean consumed ack must have its funding accounting RE-CLOSED.
    /// The release unwound the declared contribution on the premise the
    /// message never executed; a consumed delivery falsifies that, so
    /// leaving it unwound lets governance dispatch a replacement against
    /// a quote the original already funded - OVERFUNDING the obligation.
    /// Pre-fix the re-close ran only for B1-terminalized receipts, so a
    /// ceremony-only settlement took none at all.
    function test_Ceremony_LateConsumptionRecloses() public {
        _releasedCeremonyFixture();
        (uint256 fl0, uint256 fb0) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl0 + fb0, 0, "release unwound the declared split");
        vpfiTok.mint(address(diamond), 3e18);
        comp.recordRecoveryCeremony(1, 3e18, 0);
        assertEq(
            rlens.getCompensationOutstanding(CHAIN_ARB),
            0,
            "the ceremony resolved the receipt"
        );
        // The delivery executed after all.
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, true);
        (uint256 fl, uint256 fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 2e18, "lender contribution re-closed");
        assertEq(fb, 1e18, "borrower contribution re-closed");
        // ...and the cumulative quote bound now refuses the replacement
        // that the unwound state would have allowed.
        vm.expectRevert();
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
    }

    /// r2-b3 - the claw may only ever take the contradicted receipt's OWN
    /// UNSPENT credit. Once receipt A's recovery has been re-dispatched,
    /// the pooled position consists of OTHER receipts' credits; sizing
    /// the claw on that balance permanently confiscates capacity they can
    /// never re-earn, because their own per-receipt entitlement is
    /// already exhausted.
    function test_Recovery_ClawTakesOnlyOwnUnspentCredit() public {
        // Receipt 1: a released compensation, ceremony-recovered 3e18.
        _releasedCeremonyFixture();
        vpfiTok.mint(address(diamond), 3e18);
        comp.recordRecoveryCeremony(1, 3e18, 0);
        // Receipt 90: an UNRELATED receipt's B1 return credit, untouched.
        mutator.setRemitReservationCompRaw(90, CHAIN_ARB, 2, 2e18, 4);
        _armReturnIngress();
        comp.onStrandedReturnReceived(
            address(diamond), 90, 4, CHAIN_ARB, address(vpfiTok), 2e18, 2e18, 0
        );
        // Receipt 1 spends its OWN credit in full.
        comp.remitManualBudgetFromRecovery{value: 0.01 ether}(
            CHAIN_ARB, 1, 2e18, 1e18, 1
        );
        (uint256 c1, uint256 d1, ) = rlens.getRecoveryCreditForReceipt(1);
        assertEq(c1 - d1, 0, "receipt 1 has nothing left unspent");
        (uint256 recBefore, uint256 redBefore, ) = rlens.getRecoveryPosition();
        assertEq(recBefore - redBefore, 2e18, "only receipt 90's credit left");

        // Receipt 1 is now contradicted. Its own credit is already spent,
        // so there is NOTHING left to claw - receipt 90 must be untouched.
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, true);
        (uint256 recAfter, uint256 redAfter, ) = rlens.getRecoveryPosition();
        assertEq(
            recAfter - redAfter,
            2e18,
            "receipt 90's capacity survives receipt 1's contradiction"
        );
        // ...and it is still ATTRIBUTABLE to 90, which is what makes it
        // spendable: a from-recovery draw is bounded by the named
        // receipt's own unspent credit, and 90's is untouched.
        // (`test_Recovery_SupplementalFromRecovery` exercises 90 actually
        // spending it, on a day with the quote headroom to accept it.)
        (uint256 c90, uint256 d90, uint256 z90) =
            rlens.getRecoveryCreditForReceipt(90);
        assertEq(c90, 2e18, "90's credit intact");
        assertEq(d90, 0, "90 has drawn nothing");
        assertEq(z90, 0, "and nothing of 90's was clawed");
    }

    /// r2-b3 - a from-recovery dispatch may not draw against a receipt
    /// that has no (remaining) credit of its own, even while the pooled
    /// position is ample. Attribution is what makes the claw bounded.
    function test_Recovery_DispatchBoundedByNamedReceiptCredit() public {
        _releasedCeremonyFixture();
        vpfiTok.mint(address(diamond), 3e18);
        comp.recordRecoveryCeremony(1, 3e18, 0);
        // Receipt 90 owns no credit; the position is 3e18 all the same.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RecoveryReceiptCreditInsufficient.selector,
                90,
                1e18,
                0
            )
        );
        comp.remitManualBudgetFromRecovery{value: 0.01 ether}(
            CHAIN_ARB, 1, 0.6e18, 0.4e18, 90
        );
    }

    /// r2-b4 - terminally LOST recycled tokens must leave the coverage
    /// allowance. They are gone; leaving them counted as in-transit
    /// backing lets a dead balance back live reservations forever - the
    /// same phantom-headroom failure the recovered half closes, reached
    /// from the other end.
    function test_Ceremony_TerminalLossRetiresRecycledBacking() public {
        LibVaipakam.RemitReservation memory r = _releasedMixedFixture();
        (, uint256 stranded, , , uint256 resolvedBefore) =
            RewardAggregatorFacet(address(diamond))
                .getRecycleCompositionPosition();
        assertGt(stranded, 0, "fixture: the release stranded value");
        assertEq(resolvedBefore, 0, "nothing resolved yet");
        comp.recordRecoveryTerminalLoss(1, r.fresh, r.recycled);
        (, , , , uint256 resolvedAfter) = RewardAggregatorFacet(
            address(diamond)
        ).getRecycleCompositionPosition();
        assertEq(
            resolvedAfter,
            r.recycled < stranded ? r.recycled : stranded,
            "the lost recycled provenance leaves the allowance"
        );
        (uint256 lf, uint256 lr) = rlens.getCeremonyLoss(1);
        assertEq(lf, r.fresh, "fresh loss recorded by provenance");
        assertEq(lr, r.recycled, "recycled loss recorded by provenance");
        assertEq(
            rlens.getCompensationOutstanding(CHAIN_ARB),
            0,
            "full loss resolves the receipt"
        );
    }

    /// r2-b4 - recovery and loss are draws on the SAME dispatched split,
    /// so they bound JOINTLY per component: a loss cannot re-spend a
    /// component a ceremony already recovered.
    function test_Ceremony_LossAndRecoveryBoundJointly() public {
        LibVaipakam.RemitReservation memory r = _releasedMixedFixture();
        comp.recordRecoveryCeremony(1, 0, r.recycled);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CeremonyProvenanceExceeded.selector,
                1,
                r.recycled + 1,
                r.recycled
            )
        );
        comp.recordRecoveryTerminalLoss(1, 0, 1);
    }

    /// r2-b2 - an IMPORTED old-era settlement must NOT net out of the
    /// LOCAL coverage allowance: that value was stranded on the retired
    /// deployment and never entered this one's cumulative, so netting it
    /// under-recognises local backing and pages a false CRITICAL.
    function test_Import_SettlementDoesNotNetLocalStranding() public {
        LibVaipakam.RemitReservation memory r = _releasedMixedFixture();
        (, uint256 stranded, , , uint256 resolvedBefore) =
            RewardAggregatorFacet(address(diamond))
                .getRecycleCompositionPosition();
        assertGt(stranded, 0, "fixture: local stranding");
        assertEq(resolvedBefore, 0);
        r;

        address oldBase = address(0x01dBA5E);
        comp.importOutstandingCompensation(CHAIN_ARB, oldBase, 7, false);
        vpfiTok.mint(address(diamond), 1e18);
        comp.clearImportedOutstanding(CHAIN_ARB, 1e18);
        (, , , , uint256 resolvedAfter) = RewardAggregatorFacet(
            address(diamond)
        ).getRecycleCompositionPosition();
        assertEq(
            resolvedAfter,
            0,
            "an old-era recovery never nets the local allowance"
        );
    }


    // -- #1662 r3 ----------------------------------------------------

    /// r3-c1 - a contradiction VOIDS the receipt's whole remaining
    /// recovery entitlement, not merely the slice the pooled position
    /// could absorb at that instant. The physical claw is bounded by the
    /// balance; the entitlement is not. Leaving the remainder standing
    /// let it become spendable again the moment ANOTHER receipt credited
    /// the pool - drawing against backing that was never its own.
    function test_Recovery_ClawedCreditNeverBecomesSpendable() public {
        // Receipt 1 recovers 3e18 by ceremony...
        _releasedCeremonyFixture();
        vpfiTok.mint(address(diamond), 3e18);
        comp.recordRecoveryCeremony(1, 3e18, 0);
        // ...then spends 2e18 of it, leaving 1e18 unspent.
        comp.remitManualBudgetFromRecovery{value: 0.01 ether}(
            CHAIN_ARB, 1, 1.4e18, 0.6e18, 1
        );
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 2, 2e18, true);
        // The contradiction lands while the pool holds only 1e18, so the
        // PHYSICAL claw is 1e18 - and the entitlement is voided with it.
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, true);
        (uint256 c, uint256 d, uint256 z) =
            rlens.getRecoveryCreditForReceipt(1);
        assertEq(c - d - z, 0, "receipt 1's entitlement is fully void");

        // Another receipt now replenishes the pooled position.
        mutator.setRemitReservationCompRaw(90, CHAIN_ARB, 2, 2e18, 4);
        _armReturnIngress();
        comp.onStrandedReturnReceived(
            address(diamond), 90, 4, CHAIN_ARB, address(vpfiTok), 2e18, 2e18, 0
        );
        (uint256 rec, uint256 red, ) = rlens.getRecoveryPosition();
        assertGt(rec - red, 0, "the pool is funded again");
        // ...and receipt 1 still cannot spend a wei of it. (A fresh day,
        // so the refusal is the CREDIT check and not day-closure.)
        _finalizeDay(2);
        mutator.setChainDayRemitIneligibleRaw(2, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 2, 3e18, 2e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RecoveryReceiptCreditInsufficient.selector,
                1,
                1e18,
                0
            )
        );
        comp.remitManualBudgetFromRecovery{value: 0.01 ether}(
            CHAIN_ARB, 2, 0.6e18, 0.4e18, 1
        );
    }

    /// r3-c3 - a resolution recorded BEFORE the one-time stranded seed
    /// completes must not be discarded. The stored cumulative accrues
    /// uncapped and is capped only where published, so the seed's later
    /// assignment reveals the full resolved figure instead of leaving
    /// returned/written-off value reading as in-transit forever.
    function test_Ceremony_ResolutionSurvivesLateStrandedSeed() public {
        LibVaipakam.RemitReservation memory r = _releasedMixedFixture();
        // Reproduce the pre-seed shape: the stranded floor is not yet
        // published, exactly as on an in-place-upgraded Diamond.
        mutator.setReleasedRemitStrandedRaw(0);
        comp.recordRecoveryTerminalLoss(1, r.fresh, r.recycled);
        (, , , , uint256 publishedPreSeed) = RewardAggregatorFacet(
            address(diamond)
        ).getRecycleCompositionPosition();
        assertEq(publishedPreSeed, 0, "capped at the unseeded floor");
        // The seed lands the historical total.
        mutator.setReleasedRemitStrandedRaw(r.recycled);
        (, , , , uint256 publishedPostSeed) = RewardAggregatorFacet(
            address(diamond)
        ).getRecycleCompositionPosition();
        assertEq(
            publishedPostSeed,
            r.recycled,
            "the pre-seed resolution was retained, not discarded"
        );
    }

    /// r3-c4 - the joint provenance bound must hold in BOTH orders.
    /// Recording loss first and recovery second previously spent one
    /// component twice while still satisfying the aggregate identity by
    /// borrowing the other component's slack.
    function test_Ceremony_LossThenRecoveryStillBoundsJointly() public {
        LibVaipakam.RemitReservation memory r = _releasedMixedFixture();
        comp.recordRecoveryTerminalLoss(1, r.fresh, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CeremonyProvenanceExceeded.selector,
                1,
                r.fresh + 1,
                r.fresh
            )
        );
        comp.recordRecoveryCeremony(1, 1, 0);
    }


    // -- #1662 r4 ----------------------------------------------------

    /// r4-d1 - the JOINT bound values fold in prior LOSS and must NOT be
    /// persisted as recovered. Storing them recorded loss as recovery, so
    /// `_drawFromRecovery` subtracted a recycled figure that never entered
    /// the position - publishing zero capacity for a receipt that has
    /// some, or reverting once the fictitious subtrahend exceeded credit.
    function test_Ceremony_LossDoesNotInflateRecoveredCounters() public {
        LibVaipakam.RemitReservation memory r = _releasedMixedFixture();
        // Record the whole RECYCLED component as lost...
        comp.recordRecoveryTerminalLoss(1, 0, r.recycled);
        // ...then recover FRESH. The joint bound must permit this (the
        // components are disjoint), and must not book the recycled loss
        // as recycled RECOVERY.
        comp.recordRecoveryCeremony(1, r.fresh, 0);
        (uint256 cf, uint256 cr) = rlens.getCeremonyRecovered(1);
        assertEq(cf, r.fresh, "fresh recovered is the fresh INFLOW");
        assertEq(cr, 0, "no recycled was recovered - only lost");
        // The per-receipt credit is therefore the whole fresh recovery,
        // and it is drawable rather than zeroed by a phantom subtrahend.
        (uint256 credit, uint256 red, uint256 clawed) =
            rlens.getRecoveryCreditForReceipt(1);
        assertEq(credit, r.fresh, "credit is not deflated by the loss");
        assertEq(red + clawed, 0);
    }

    /// r5-e3 - ONE import per tuple, ever. The gate returns to zero when a
    /// settlement clears it, so a replay would mint a SECOND attribution
    /// and overwrite the tombstone - leaving the first credit drawable and
    /// unreachable by the evidence that should void it.
    function test_Import_ReplayAfterSettlementRefused() public {
        address oldBase = address(0x01dBA5E);
        comp.importOutstandingCompensation(CHAIN_ARB, oldBase, 7, false);
        vpfiTok.mint(address(diamond), 3e18);
        comp.clearImportedOutstanding(CHAIN_ARB, 0);
        assertEq(rlens.getCompensationOutstanding(CHAIN_ARB), 0, "settled");
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ImportedTupleAlreadySeen.selector,
                CHAIN_ARB,
                7
            )
        );
        comp.importOutstandingCompensation(CHAIN_ARB, oldBase, 7, false);
    }



    /// r7-g3 - a SHORT late consumption must re-close only what actually
    /// arrived. Restoring the full DECLARED split records the day as
    /// fully funded and blocks the legitimate supplement for the
    /// shortfall - the same declared-vs-received reconciliation the
    /// ordinary ack path performs.
    function test_Recovery_ShortLateConsumptionReconciles() public {
        _releasedCeremonyFixture();
        (uint256 fl0, uint256 fb0) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl0 + fb0, 0, "release unwound the declared split");
        // 2 of the declared 3 actually arrived, and it was consumed.
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 2e18, true);
        (uint256 fl, uint256 fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        // Each side floors independently, so the pair can land up to one
        // wei per side UNDER the received figure - the conservative
        // direction (never over-crediting the obligation).
        assertApproxEqAbs(
            fl + fb, 2e18, 2, "re-closed at RECEIVED, not declared"
        );
        // ...so the 1e18 shortfall is still supplementable.
        assertLt(fl, 2e18, "lender side pro-rated");
        assertLt(fb, 1e18, "borrower side pro-rated");
    }

    /// r7-g4 - a receipt that predates per-receipt attribution has credit
    /// on record but no per-receipt spend/claw history (those were global
    /// only), so its unspent figure would read as the FULL credit however
    /// much was already drawn - and it could consume a LATER receipt's
    /// backing. Refused outright once attribution is armed.
    function test_Recovery_LegacyReceiptNotDrawableAfterArming() public {
        _releasedCeremonyFixture();
        vpfiTok.mint(address(diamond), 3e18);
        comp.recordRecoveryCeremony(1, 3e18, 0);
        // The upgrade arms attribution at the current nonce: receipt 1
        // predates it.
        comp.armRecoveryAttribution();
        _finalizeDay(2);
        mutator.setChainDayRemitIneligibleRaw(2, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 2, 3e18, 2e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RecoveryReceiptPredatesAttribution.selector, 1
            )
        );
        comp.remitManualBudgetFromRecovery{value: 0.01 ether}(
            CHAIN_ARB, 2, 0.6e18, 0.4e18, 1
        );
        // One-shot.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RecoveryAttributionAlreadyArmed.selector
            )
        );
        comp.armRecoveryAttribution();
    }

    /// SS8-6 (#1662 r7) - an imported gate has NO permissionless clear.
    ///
    /// A mistyped import can name an unrelated, already-CONSUMED
    /// historical receipt. If that receipt's re-presented acknowledgement
    /// could clear the sentinel, the operator would then fund a charged
    /// replacement while the genuinely outstanding delivery was still
    /// live - and BOTH would back mirror claims. Binding the import to
    /// the real outstanding gate would need the predecessor read that r6
    /// removed as unauthenticatable, so the permissionless path goes
    /// instead: only the operator's evidenced settlement opens it. That
    /// is what makes a mistaken import genuinely liveness-only.
    function test_Import_HasNoPermissionlessClear() public {
        address oldBase = address(0x01dBA5E);
        comp.importOutstandingCompensation(CHAIN_ARB, oldBase, 7, false);
        assertEq(
            rlens.getCompensationOutstanding(CHAIN_ARB),
            type(uint256).max,
            "the imported hold is the sentinel"
        );
        // A re-presented ack for the imported tuple - in ANY
        // classification - is refused at the era check and clears nothing.
        for (uint8 cls = 1; cls <= 3; ++cls) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    IVaipakamErrors.RemitAckSenderMismatch.selector, 7, oldBase
                )
            );
            rewardMessenger.deliverRemitAckFromWithClassification(
                CHAIN_ARB, 7, 3e18, oldBase, cls
            );
        }
        assertEq(
            rlens.getCompensationOutstanding(CHAIN_ARB),
            type(uint256).max,
            "still held after every re-present"
        );
        // Only the evidenced settlement opens it.
        comp.clearImportedOutstanding(CHAIN_ARB, 0);
        assertEq(rlens.getCompensationOutstanding(CHAIN_ARB), 0, "cleared");
    }

    /// SS8-6 (#1662 r6) - the evidenced settlement relocates the RECYCLED
    /// half into bucket custody and frees the gate; it mints no fresh
    /// capacity. A wrong-tuple ack never touches the imported gate, and a
    /// double clear refuses.
    function test_Import_EvidencedSettlementBooksAndWrongTuple() public {
        address oldBase = address(0x01dBA5E);
        comp.importOutstandingCompensation(CHAIN_ARB, oldBase, 7, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RemitAckSenderMismatch.selector,
                8,
                oldBase
            )
        );
        rewardMessenger.deliverRemitAckFromWithClassification(
            CHAIN_ARB, 8, 1e18, oldBase, 1
        );
        assertEq(
            rlens.getCompensationOutstanding(CHAIN_ARB),
            type(uint256).max,
            "held"
        );
        vpfiTok.mint(address(diamond), 1.5e18);
        uint256 bucketBefore = _bucket();
        (uint256 recBefore, uint256 redBefore, ) = rlens.getRecoveryPosition();
        comp.clearImportedOutstanding(CHAIN_ARB, 0.5e18);
        assertEq(
            _bucket() - bucketBefore,
            0.5e18,
            "the recycled component relocated into the bucket"
        );
        (uint256 recAfter, uint256 redAfter, ) = rlens.getRecoveryPosition();
        assertEq(
            recAfter - redAfter,
            recBefore - redBefore,
            "and NO fresh re-dispatch capacity was minted"
        );
        assertEq(rlens.getCompensationOutstanding(CHAIN_ARB), 0, "cleared");
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ImportedMarkerMissing.selector, CHAIN_ARB
            )
        );
        comp.clearImportedOutstanding(CHAIN_ARB, 0);
    }

    // -- #1662 r6 ----------------------------------------------------

    /// r6-f1 - an imported settlement mints NO fresh recovery capacity.
    ///
    /// Rounds 4 and 5 both tried to BOUND that mint - first on
    /// operator-supplied figures, then by reading the retiring deployment
    /// - and neither authenticates against a compromised ADMIN, who
    /// supplies the predecessor ADDRESS too and can point it at a reader
    /// returning anything. Removing the mint removes the surface.
    ///
    /// It is also wrong on its own terms: uncharged re-dispatch means
    /// "this parcel's cap charge already happened", which is true within
    /// ONE deployment's counters and false across a rotation - the new
    /// deployment's lifetime figure starts at zero and never charged for
    /// the old parcel.
    function test_Import_SettlementMintsNoFreshCapacity() public {
        address oldBase = address(0x01dBA5E);
        comp.importOutstandingCompensation(CHAIN_ARB, oldBase, 7, false);
        (uint256 recBefore, uint256 redBefore, ) = rlens.getRecoveryPosition();
        vpfiTok.mint(address(diamond), 5e18);
        // Even a large physically-present balance mints nothing: the
        // RECYCLED half relocates into bucket custody, and that is all.
        comp.clearImportedOutstanding(CHAIN_ARB, 2e18);
        (uint256 recAfter, uint256 redAfter, ) = rlens.getRecoveryPosition();
        assertEq(
            recAfter - redAfter,
            recBefore - redBefore,
            "an imported settlement creates no re-dispatch capacity"
        );
        assertEq(rlens.getCompensationOutstanding(CHAIN_ARB), 0, "gate freed");
    }

    /// r6-f7 - the claw must not poison the REDISPATCHED counter.
    ///
    /// `spent` folds in clawed credit for the ADMISSION bound, but storing
    /// that combined figure back double-counts the claw against recovery
    /// governance records LATER for the same receipt - which is
    /// deliberately allowed, because a CONTRADICTED consumption earns no
    /// trust and operator evidence stays the resolution path. The later
    /// capacity then reads as unavailable and cannot be drawn at all.
    ///
    /// A test that only claws cannot see this: the poisoned store lives on
    /// the DRAW path, so the sequence must claw, re-credit, and then draw
    /// twice - the second draw is what the defect makes impossible.
    function test_Recovery_ClawDoesNotPoisonRedispatchedCounter() public {
        _releasedCeremonyFixture();
        vpfiTok.mint(address(diamond), 20e18);
        comp.recordRecoveryCeremony(1, 1e18, 0);
        // Quarantine THEN consumed: a self-contradicting mirror, so the
        // claw fires and the settlement paths stay open to governance.
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, false);
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, true);
        (, , uint256 clawed) = rlens.getRecoveryCreditForReceipt(1);
        assertEq(clawed, 1e18, "the contradicted credit was voided");
        // Governance records further recovery on the same receipt.
        comp.recordRecoveryCeremony(1, 2e18, 0);
        (uint256 credit, uint256 red0, ) =
            rlens.getRecoveryCreditForReceipt(1);
        assertEq(credit, 3e18, "credit is the ceremony total");
        assertEq(red0, 0, "a claw is not a redispatch");

        // Draw HALF the still-available capacity on a fresh day...
        _finalizeDay(2);
        mutator.setChainDayRemitIneligibleRaw(2, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 2, 3e18, 2e18);
        comp.remitManualBudgetFromRecovery{value: 0.01 ether}(
            CHAIN_ARB, 2, 0.6e18, 0.4e18, 1
        );
        (, uint256 red1, ) = rlens.getRecoveryCreditForReceipt(1);
        assertEq(red1, 1e18, "only the DRAW advances the redispatched term");
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 2, 1e18, true);

        // ...and the remainder must still be drawable. Under the defect
        // the counter reads 2e18 here, so this reverts.
        _finalizeDay(3);
        mutator.setChainDayRemitIneligibleRaw(3, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 3, 3e18, 2e18);
        comp.remitManualBudgetFromRecovery{value: 0.01 ether}(
            CHAIN_ARB, 3, 0.6e18, 0.4e18, 1
        );
        (, uint256 red2, ) = rlens.getRecoveryCreditForReceipt(1);
        assertEq(red2, 2e18, "both draws recorded, claw excluded");
    }

    /// r6-f8 - a late B1 return must net GOVERNANCE-RECORDED LOSS, not
    /// just prior recovery. A released receipt can have partial terminal
    /// loss recorded while a quarantined return is still in flight;
    /// without the loss term the return credits against the gross total
    /// and `recovered + terminalLoss` passes the dispatched parcel.
    function test_Recovery_LateReturnNetsRecordedTerminalLoss() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        // Release FIRST (release needs Pending); a released reservation
        // still records the quarantine attestation the B1 return needs.
        vm.warp(block.timestamp + 7 days);
        comp.releaseRemitReservation(1);
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, false);
        // Governance writes off 2 of the 3 while the return is in flight.
        comp.recordRecoveryTerminalLoss(1, 2e18, 0);
        _armReturnIngressNoAck();
        // The whole 3 comes home anyway: only the unresolved 1 may credit.
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 3e18, 3e18, 0
        );
        assertEq(
            rlens.getRecoveredForReceipt(1),
            1e18,
            "credit is capped by total MINUS recorded loss"
        );
        assertEq(
            rlens.getRecoveredForReceipt(1) + rlens.getCeremonyTerminalLoss(1),
            3e18,
            "recovered + loss never passes the dispatched parcel"
        );
    }

    /// #1660 r4 - POSITIVE non-consumption evidence is required: a return
    /// arriving before the receipt's ack refuses (re-executable), so an
    /// out-of-order faulty mirror cannot credit ahead of its consumed
    /// attestation.
    function test_Recovery_PendingReturnRefusedUntilAck() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        _armReturnIngressNoAck();
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.StrandedReturnAwaitingAck.selector, 1, 1
            )
        );
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 3e18, 3e18, 0
        );
        // The permissionless non-consumed ack lands; the re-executed
        // return now settles.
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, false);
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 3e18, 3e18, 0
        );
        (uint256 recovered, , ) = rlens.getRecoveryPosition();
        assertEq(recovered, 3e18);
    }

    /// #1660 r4 - a RELEASED reservation's late return must not unwind the
    /// declared contribution twice: release already removed it, and a
    /// second subtraction would erase the funding a replacement recorded
    /// while the terminal chunk was still in flight.
    function test_Recovery_ReleasedReturnNoDoubleUnwind() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        // The message never executes; the operator releases (declared
        // unwound, day re-opened, gate still HELD).
        vm.warp(block.timestamp + 7 days);
        comp.releaseRemitReservation(1);
        (uint256 fl, uint256 fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl + fb, 0, "release unwound the declared split");
        // #1660 r5 - the quarantine ack is still presentable on the
        // RELEASED reservation and records the B1 eligibility evidence
        // (released-alone is not classification evidence).
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, false);
        // ...but it executes after all, quarantines mirror-side, and
        // returns CHUNKED: the first chunk clears the gate (status 3 is
        // return-eligible - the value coming home IS the recovery).
        _armReturnIngressNoAck();
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 1e18, 1e18,
            2e18
        );
        assertEq(rlens.getCompensationOutstanding(CHAIN_ARB), 0);
        // A replacement funds the day from the position meanwhile.
        comp.remitManualBudgetFromRecovery{value: 0.01 ether}(
            CHAIN_ARB, 1, 0.6e18, 0.4e18, 1
        );
        // The released reservation's TERMINAL chunk lands: the declared
        // subtraction must SKIP (already unwound at release) - the
        // replacement's funding survives.
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 2e18, 2e18, 0
        );
        (fl, fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 0.6e18, "replacement funding survives the late terminal");
        assertEq(fb, 0.4e18, "replacement funding survives the late terminal");
        assertEq(
            rlens.getDayClosedByRemitId(CHAIN_ARB, 1),
            2,
            "replacement closure untouched (ownership guard)"
        );
    }

    /// #1660 r3 - a CONSUMED receipt is not B1-recoverable: its consumed
    /// ack attested the value entered mirror claim backing, so a return
    /// against it would reuse the dispatch's cap lineage.
    function test_Recovery_ConsumedReceiptRefused() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, 3e18); // consumed
        _armReturnIngress();
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.StrandedReturnConsumedReceipt.selector, 1
            )
        );
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 3e18, 3e18, 0
        );
    }

    /// #1660 r3 - loss closure is ORDER-INDEPENDENT: the configured
    /// transport executes out of order, so a partial chunk landing AFTER
    /// the terminal one must shrink the loss it just recovered.
    function test_Recovery_OutOfOrderChunkRecomputesLoss() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, false);
        _armReturnIngress();
        // Terminal chunk (2e18, remainder 0) arrives FIRST: residual 1e18
        // reads as loss at that moment.
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 2e18, 2e18, 0
        );
        assertEq(rlens.getStrandedReturnShortfall(1), 1e18);
        // The delayed earlier chunk (1e18) lands: the loss shrinks to 0.
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 1e18, 1e18,
            2e18
        );
        assertEq(
            rlens.getStrandedReturnShortfall(1),
            0,
            "recovered value no longer recorded as loss"
        );
        (uint256 recovered, , ) = rlens.getRecoveryPosition();
        assertEq(recovered, 3e18);
    }

    /// #1660 r3 - the terminal return RE-OPENS the obligation: day markers
    /// unwind and the declared funding leaves the cumulative, so the
    /// position can fund the SAME day again - no release required.
    function test_Recovery_TerminalReturnReopensDayNoRelease() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        // Quarantined mirror-side: the non-consumed ack Acks the
        // reservation (delivery evidence) while the gate holds.
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, false);
        _armReturnIngress();
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 3e18, 3e18, 0
        );
        assertEq(
            rlens.getDayClosedByRemitId(CHAIN_ARB, 1), 0, "day re-opened"
        );
        (uint256 fl, uint256 fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl, 0, "declared funding unwound");
        assertEq(fb, 0, "declared funding unwound");
        // The replacement funds the SAME day from the position - the
        // Acked reservation needs no release.
        comp.remitManualBudgetFromRecovery{value: 0.01 ether}(
            CHAIN_ARB, 1, 2e18, 1e18, 1
        );
        assertTrue(rlens.getRemitReservation(2).fundedFromRecovery);
    }

    /// #1660 r2 - the reported day must be the reservation's own single
    /// day: settlement and loss evidence bind to the authoritative
    /// obligation, never a wire-supplied one.
    function test_Recovery_WrongDayRefused() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, false);
        _armReturnIngress();
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.StrandedReturnWrongDay.selector, 9, 1
            )
        );
        comp.onStrandedReturnReceived(
            address(diamond), 1, 9, CHAIN_ARB, address(vpfiTok), 3e18, 3e18, 0
        );
    }

    /// #1660 r2 - the TERMINAL chunk closes the receipt's loss evidence at
    /// the FULL residual, folding in the first-leg deficit: a compensation
    /// that arrived short Base-to-mirror left the mirror quarantining less
    /// than the reservation dispatched, and that gap must read as loss.
    function test_Recovery_TerminalChunkRecordsFirstLegDeficit() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, false);
        _armReturnIngress();
        // The mirror only ever held 2e18 (first leg arrived short); its
        // one-shot record returns exactly that, remainder zero.
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 2e18, 2e18, 0
        );
        (uint256 recovered, , uint256 overage) = rlens.getRecoveryPosition();
        assertEq(recovered, 2e18, "credited at what physically arrived");
        assertEq(overage, 0);
        assertEq(
            rlens.getStrandedReturnShortfall(1),
            1e18,
            "first-leg deficit terminalized as loss, not headroom"
        );
    }

    /// #1660 r2 - a NON-terminal chunk leaves the residual entitlement
    /// open (the remainder is still coming) and records only its own
    /// transport gap; the terminal chunk then closes the evidence.
    function test_Recovery_ChunkedReturnAccumulates() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, false);
        _armReturnIngress();
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 1e18, 1e18,
            2e18
        );
        assertEq(
            rlens.getStrandedReturnShortfall(1),
            0,
            "no loss closed while the remainder is in flight"
        );
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 2e18, 2e18, 0
        );
        (uint256 recovered, , ) = rlens.getRecoveryPosition();
        assertEq(recovered, 3e18, "chunks accumulate to the entitlement");
        assertEq(rlens.getStrandedReturnShortfall(1), 0, "nothing lost");
        assertEq(
            rlens.getCompensationOutstanding(CHAIN_ARB), 0, "gate settled"
        );
    }

    /// The supplemental wrapper draws the position under the same per-side
    /// quote bound as its charged twin.
    function test_Recovery_SupplementalFromRecovery() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        uint256 globalAfter = rlens.getRewardBudgetRemittedGlobal();
        // Short delivery: the consumed ack reconciles funding down, and
        // the day re-opens supplemental headroom.
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, 1.5e18);
        // A separate stranded return (another chain-day's failed remit)
        // seeded the position.
        mutator.setRemitReservationCompRaw(90, CHAIN_ARB, 2, 2e18, 4);
        _armReturnIngress();
        comp.onStrandedReturnReceived(
            address(diamond), 90, 4, CHAIN_ARB, address(vpfiTok), 2e18, 2e18, 0
        );
        comp.remitSupplementalBudgetFromRecovery{value: 0.01 ether}(
            CHAIN_ARB, 1, 1e18, 0.5e18, 90
        );
        assertEq(
            rlens.getRewardBudgetRemittedGlobal(),
            globalAfter,
            "supplemental re-dispatch uncharged"
        );
        (, uint256 redispatched, ) = rlens.getRecoveryPosition();
        assertEq(redispatched, 1.5e18);
        assertTrue(rlens.getRemitReservation(2).fundedFromRecovery);
    }

}
