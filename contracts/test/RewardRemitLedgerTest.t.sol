// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardIngressFacet} from "../src/facets/RewardIngressFacet.sol";
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
import {LibRemitDayLedger} from "../src/libraries/LibRemitDayLedger.sol";
import {RewardCommitmentFacet} from "../src/facets/RewardCommitmentFacet.sol";
import {RepatriationFacet} from "../src/facets/RepatriationFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {MockCrossChainMessenger} from "./mocks/MockCrossChainMessenger.sol";
import {LibRewardRemitDispatch} from "../src/libraries/LibRewardRemitDispatch.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {LibD8Delivery} from "./helpers/LibD8Delivery.sol";

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
    RewardIngressFacet internal ingress;
    RewardRemittanceLensFacet rlens;
    RewardCompensationDispatchFacet comp;
    MockRewardMessenger internal rewardMessenger; // data path (reports + acks)
    MockCrossChainMessenger internal ccip; // value path (token remittance)
    VPFIToken internal vpfiTok;
    TestMutatorFacet internal mutator;

    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    uint32 internal constant CHAIN_OP = 10;
    /// @dev #918 — the part cap the quotes are asked about; the remits here pass
    ///      the same 69M ceiling, so every day goes in one part unless a cell
    ///      says otherwise.
    uint256 internal constant CAP = 69_000_000 ether;

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
        ingress = RewardIngressFacet(address(diamond));
        rlens = RewardRemittanceLensFacet(address(diamond));
        comp = RewardCompensationDispatchFacet(address(diamond));
        mutator = TestMutatorFacet(address(diamond));

        vm.chainId(CHAIN_BASE);
        _ensureRewardClockLaunched();

        RewardReporterFacet rep = RewardReporterFacet(address(diamond));
        rep.setBaseChainId(CHAIN_BASE);
        rep.setIsCanonicalRewardChain(true);
        // #1566 slice 4 PR B — a canonical chain dispatches out of the custody
        // holder, bounded by what was funded: activate and fund the pool. The
        // freeze this arms is why the mirror fixture below sets the role RAW.
        activateRewardCustodyForTest(address(vpfiTok), 10_000_000 ether);
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

    // ─── #2561 — every remittance records the adapter it was bound to ──────

    address internal constant MIRROR_MESSENGER = address(0xA11CE);

    event RemitRouteRecorded(uint256 indexed remitId, uint32 indexed dstChainId, address remoteMessenger);

    /// Each of the three blocks that create a reservation records the remote
    /// adapter the messenger named for the destination, and the lens reads it
    /// back beside the live one (the same while nothing was re-pointed).
    function test_EveryDispatchPathRecordsItsRoute() public {
        ccip.setRemoteMessenger(CHAIN_ARB, MIRROR_MESSENGER);

        _finalizeDay(1);
        vm.expectEmit(true, true, false, true, address(diamond));
        emit RemitRouteRecorded(1, CHAIN_ARB, MIRROR_MESSENGER);
        _remitDay1ToArb();

        _finalizeDay(2);
        mutator.setChainDayRemitIneligibleRaw(2, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 2, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 2, 2e18, 2e18);

        rewardMessenger.deliverRemitAck(CHAIN_ARB, 2, 4e18);
        comp.remitSupplementalBudget{value: 0.01 ether}(CHAIN_ARB, 2, 1e18, 0);

        assertEq(rlens.getRemitReservationNonce(), 3, "fixture: every creating block drove once");
        for (uint256 id = 1; id <= 3; ++id) {
            (address sentM, address liveM) = rlens.getRemitRoute(id);
            assertEq(sentM, MIRROR_MESSENGER, "sent adapter");
            assertEq(liveM, MIRROR_MESSENGER, "live adapter");
        }
    }

    /// The lane re-pointed at a redeployed mirror after the send: the record
    /// keeps the adapter the message was bound to, the live read names the
    /// new one, and the two differ. That difference is what the keeper reads
    /// to alert instead of waiting.
    function test_RemitRoute_SurvivesALaneRepointedAfterTheSend() public {
        ccip.setRemoteMessenger(CHAIN_ARB, MIRROR_MESSENGER);
        _finalizeDay(1);
        _remitDay1ToArb();

        address newMessenger = address(0xA11CE2);
        ccip.setRemoteMessenger(CHAIN_ARB, newMessenger);

        (address sentM, address liveM) = rlens.getRemitRoute(1);
        assertEq(sentM, MIRROR_MESSENGER, "sent adapter kept");
        assertEq(liveM, newMessenger, "live adapter moved");
    }

    /// A destination with no remote adapter is refused before any value
    /// moves, and the strict fee dry run refuses it by the same rule.
    function test_Remit_UndeclaredRoute_RefusedBeforeValueMoves() public {
        _finalizeDay(1);
        uint256 diamondVpfi = vpfiTok.balanceOf(address(diamond));

        ccip.setRemoteMessenger(CHAIN_ARB, address(0));
        bytes memory refusal =
            abi.encodeWithSelector(LibRewardRemitDispatch.RemitRouteUndeclared.selector, CHAIN_ARB);
        vm.expectRevert(refusal);
        remit.quoteRemittanceFee(CHAIN_ARB, _days(1), CAP);
        vm.expectRevert(refusal);
        remit.remitRewardBudget{value: 0.01 ether}(CHAIN_ARB, _days(1), 69_000_000 ether);

        assertEq(rlens.getRemitReservationNonce(), 0, "no reservation");
        assertEq(ccip.sentCount(), 0, "nothing sent");
        assertEq(vpfiTok.balanceOf(address(diamond)), diamondVpfi, "no VPFI moved");

        // Declared again, the same remittance goes out.
        ccip.setRemoteMessenger(CHAIN_ARB, MIRROR_MESSENGER);
        _remitDay1ToArb();
        assertEq(rlens.getRemitReservationNonce(), 1, "sent once declared");
    }

    /// A remitId never issued reads both adapters as zero.
    function test_RemitRoute_NeverIssued_IsZero() public view {
        (address sentM, address liveM) = rlens.getRemitRoute(99);
        assertEq(sentM, address(0));
        assertEq(liveM, address(0));
    }

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

        // The d8 payload carries the echo remitId and names its one funded
        // day inline (#2828).
        (uint256 tag, RemitWire.D8 memory w) = abi.decode(ccip.sentPayload(0), (uint256, RemitWire.D8));
        assertEq(tag, RemitWire.REMIT_WIRE_TAG_D8, "the d8 wire");
        assertEq(w.dayId, 1, "payload day: the one funded day");
        assertEq(w.total, total, "payload total");
        assertEq(w.remitId, 1, "payload remitId");
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

    /// Codex #2489 r2 — the reservation keeps WHICH of its closed days it funded,
    /// immutably. Day 1 is funded; day 2 is armed with a zero commitment, so it
    /// closes at zero in the same batch and is NOT on the wire. The release then
    /// clears the live per-day mark, and the reservation's own record survives
    /// it — the funded list the d6 root committed to stays recoverable.
    /// @dev Mutations: marking every closed day funded (bits = 3) fails the
    ///      first read; clearing the record on release fails the last.
    function test_Reservation_KeepsItsFundedDays_PastARelease() public {
        _finalizeDay(1);
        _finalizeDay(2);
        _armDayForArb(2, 100e18, 0);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 2, 0, 0);
        uint256[] memory both = new uint256[](2);
        both[0] = 1;
        both[1] = 2;
        remit.remitRewardBudget{value: 0.01 ether}(CHAIN_ARB, both, 69_000_000 ether);
        LibVaipakam.RemitReservation memory r = rlens.getRemitReservation(1);
        assertEq(r.dayIds.length, 2, "both days closed by this reservation");
        assertEq(r.fundedDayBits.length, 1, "one word covers them");
        assertEq(r.fundedDayBits[0], 1, "day 1 (index 0) funded; day 2 (index 1) closed at zero, off the wire");
        assertGt(rlens.getRewardBudgetRemitted(CHAIN_ARB, 1), 0, "fixture live: day 1 carries a slice");

        vm.warp(block.timestamp + 7 days);
        comp.releaseRemitReservation(1);
        assertEq(rlens.getRewardBudgetRemitted(CHAIN_ARB, 1), 0, "the release clears the live mark");
        r = rlens.getRemitReservation(1);
        assertEq(r.fundedDayBits.length, 1, "the record survives the release");
        assertEq(r.fundedDayBits[0], 1, "unchanged");
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
            remit.quoteRemitDayPlans(CHAIN_ARB, _days(1), CAP);
        assertEq(pa[0], 0, "planner amount gated");
        assertFalse(pc[0], "planner not closeable while gated");
        (uint256 fee, uint256 ft) = remit.quoteRemittanceFee(CHAIN_ARB, _days(1), CAP);
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
            remit.quoteRemitDayPlans(CHAIN_ARB, _days(1), CAP);
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
        (, bool[] memory pc2) = remit.quoteRemitDayPlans(CHAIN_ARB, _days(1), CAP);
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

        assertEq(quoted, perDay[0] + perDay[1], "the budget quote sums the plan");

        // Both days carry VPFI, so the list is refused on the fee quote and
        // the send alike (#2821); each day is sent on its own.
        bytes memory refusal = abi.encodeWithSelector(IVaipakamErrors.TransportDayFanoutExceeded.selector, 2, 1);
        vm.expectRevert(refusal);
        remit.quoteRemittanceFee(CHAIN_ARB, both, CAP);
        vm.expectRevert(refusal);
        remit.remitRewardBudget{value: 0.01 ether}(CHAIN_ARB, both, 1e24);

        for (uint256 d = 1; d <= 2; ++d) {
            (, uint256 feeTotal) = remit.quoteRemittanceFee(CHAIN_ARB, _days(d), CAP);
            assertEq(feeTotal, perDay[d - 1], "fee-quote total == the plan's day");
            remit.remitRewardBudget{value: 0.01 ether}(CHAIN_ARB, _days(d), 1e24);
            LibVaipakam.RemitReservation memory r = rlens.getRemitReservation(d);
            assertEq(r.total, perDay[d - 1], "send == quote");
            assertEq(r.dayIds.length, 1, "the day closed");
        }
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

    /// @dev #1656 r1 / #2875 — the supplemental's bound reads the per-side
    ///      funded record every manual compensation dispatch stamps. A day
    ///      closed by a remit that stamped none is not a compensation day,
    ///      so the supplemental refuses it.
    function test_Supplemental_RefusesDayWithoutFundedRecord() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, 3e18);
        // Stage a closing remit with no funded record.
        mutator.setCompFundedRaw(CHAIN_ARB, 1, 0, 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.SupplementalFundedRecordMissing.selector,
                1,
                CHAIN_ARB
            )
        );
        comp.remitSupplementalBudget{value: 0.01 ether}(CHAIN_ARB, 1, 1e18, 0);
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
    /// @dev #1566 slice 4 PR B — the suite's setUp activates the custody,
    ///      which arms the role freeze; the tests that flip the role (this
    ///      fixture, the arming helper and the demotion tests) lift it RAW
    ///      first and then drive the PRODUCTION setters, so their residual
    ///      retirement and arming semantics are exercised as before. The
    ///      freeze itself is pinned in RewardCustodyCutoverTest.
    function _unfreezeRole() internal {
        TestMutatorFacet(address(diamond)).setRewardRoleChangesFrozenRaw(false);
    }

    /// @dev A budget delivery on the rooted (d6) wire, the only budget shape
    ///      the remittance receiver accepts, filed in the live era. Returns
    ///      the packet stamp.
    function _d8(
        address token,
        uint256 amount,
        uint256 dayId,
        uint256 sourceChainId,
        uint256 remitId,
        address remitter,
        uint256 recycled,
        uint256 fresh,
        bytes32 messageId
    ) internal returns (bytes32 h) {
        h = LibD8Delivery.deliver(
            address(diamond),
            LibD8Delivery.Delivery({
                token: token,
                amount: amount,
                dayId: dayId,
                sourceChainId: sourceChainId,
                remitId: remitId,
                remitter: remitter,
                recycled: recycled,
                fresh: fresh,
                messageId: messageId,
                era: 0
            })
        );
    }

    function _configureMirror() internal {
        vm.chainId(CHAIN_ARB);
        RewardReporterFacet rep = RewardReporterFacet(address(diamond));
        _unfreezeRole();
        rep.setIsCanonicalRewardChain(false);
        rep.setBaseChainId(CHAIN_BASE);
        // A mirror starts with an EMPTY delivered ledger until Base remits;
        // the setUp's canonical funding (and the retirement the demotion
        // just applied to it) is not this mirror's history.
        TestMutatorFacet(address(diamond)).setArmedFreshLedgerRaw(0, 0);
        remit.setRewardRemittanceReceiver(address(this));
    }

    function test_MirrorIngress_RecordsReceipt_and_AckIsResendable() public {
        _configureMirror();

        _d8(address(vpfiTok), 7e18, 3, CHAIN_BASE, 42, address(0xBA5E), 0, 7e18, bytes32(0));
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
        _d8(address(vpfiTok), 7e18, 3, CHAIN_BASE, 0, address(0xBA5E), 0, 7e18, bytes32(0));
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
        _d8(address(vpfiTok), 7e18, 3, CHAIN_BASE, 42, address(0xBA5E), 0, 7e18, bytes32(0));
        // Owner rotates the canonical deployment — through Detached, as
        // #1566 slice 4 PR B requires of a mirror's source; the freeze is
        // lifted raw (the stale-receipt rule is what this test pins).
        _unfreezeRole();
        RewardReporterFacet(address(diamond)).setBaseChainId(0);
        _unfreezeRole();
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
        _d8(address(vpfiTok), 7e18, 3, CHAIN_BASE, 42, address(0x01D), 0, 7e18, keccak256("receipt-old-era"));
        _d8(address(vpfiTok), 9e18, 4, CHAIN_BASE, 42, address(0x2EF), 0, 9e18, keccak256("receipt-new-era"));
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
        // Per-key delivered ONCE (Codex #2198 r1): a delayed duplicate is
        // refused whole, so it can neither overwrite the receipt nor add
        // its value to the ledger (it used to be kept silently as
        // first-write-wins, with the duplicate's value still credited).
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.IngressReceiptAlreadyDelivered.selector,
                keccak256(abi.encode(address(0x2EF), uint256(42)))
            )
        );
        _d8(address(vpfiTok), 1e18, 5, CHAIN_BASE, 42, address(0x2EF), 0, 1e18, keccak256("receipt-duplicate"));
        assertEq(
            rlens.getReceivedRemit(address(0x2EF), 42).amount,
            9e18,
            "the one receipt per key stands"
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
            remit.quoteRemitDayPlans(CHAIN_ARB, _days(1), CAP);
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
            uint256 relocated,
            uint256 bucket,
            uint256 reported,
            uint256 paidOut,
            uint256 outstanding
        )
    {
        RewardAggregatorFacet agg = RewardAggregatorFacet(address(diamond));
        (raw, releasedStranded, , ) = agg.getRecycleCompositionPosition();
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

    /// @dev #2875 — the REPORTED cumulative is the stored absorption
    ///      counter itself: there is no derived floor on a fresh Diamond, so
    ///      the two views must read one figure.
    function _assertDerivation(string memory ctx) internal view {
        (uint256 raw, , , , uint256 reported, , ) = _composition();
        assertEq(
            reported,
            raw,
            string.concat("derivation: reported == the stored counter @ ", ctx)
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

        (uint256 rawBefore, uint256 strandedBefore, bool canonBefore, ) =
            RewardAggregatorFacet(address(diamond))
                .getRecycleCompositionPosition();
        assertEq(strandedBefore, 0, "no release yet");
        assertTrue(canonBefore, "fixture: this diamond is the canonical chain");

        vm.warp(block.timestamp + 7 days);
        comp.releaseRemitReservation(1);

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
        comp.releaseRemitReservation(1);

        (, uint256 stranded, , uint256 bucket, , , uint256 outstanding) =
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
        , bytes32(0));
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
        , bytes32(0));
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
        , bytes32(0));
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 3e18, 3e18, 0
        , bytes32(0));
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
        , bytes32(0));
        _armReturnIngress();
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.StrandedReturnUnknownReservation.selector,
                77
            )
        );
        comp.onStrandedReturnReceived(
            address(diamond), 77, 1, CHAIN_ARB, address(vpfiTok), 1e18, 1e18, 0
        , bytes32(0));
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
        , bytes32(0));
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
        , bytes32(0));
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
        , bytes32(0));
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
        , bytes32(0));
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
        , bytes32(0));
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
        , bytes32(0));
    }

    /// #1660 r6 - the wire's classification word offsets by one, so the
    /// unassigned value 0 refuses re-executably rather than reading as a
    /// classification.
    function test_Recovery_ZeroClassificationRefused() public {
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
        , bytes32(0));
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
        , bytes32(0));
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
        , bytes32(0));
        comp.remitSupplementalBudget{value: 0.01 ether}(
            CHAIN_ARB, 1, 1e18, 1e18
        );
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 2, 2e18); // consumed
        // The original's terminal chunk re-opens the day (its declared
        // unwinds; the supplement's funding is retained).
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 2e18, 2e18, 0
        , bytes32(0));
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
        // #1566 slice 4 PR B: on this activated deployment the raw bucket
        // write relocates that whole balance into the holder's recycled row,
        // so the Diamond holds nothing and the inflow itself — the only
        // earmark the ceremony asserts here now — is unbacked.
        uint256 bal = vpfiTok.balanceOf(address(diamond));
        mutator.setRecycleBucketRaw(bal);
        assertEq(vpfiTok.balanceOf(address(diamond)), 0, "the raw bucket moved the balance into the holder");
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.CeremonyInflowNotBacked.selector,
                1,
                0,
                1e18
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
        (, uint256 strandedBefore, , ) = RewardAggregatorFacet(
            address(diamond)
        ).getRecycleCompositionPosition();
        assertGt(strandedBefore, 0, "fixture: the release stranded value");
        comp.recordRecoveryCeremony(1, r.fresh, r.recycled);
        (
            ,
            uint256 strandedAfter,
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
        , bytes32(0));
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
        (, uint256 stranded, , uint256 resolvedBefore) =
            RewardAggregatorFacet(address(diamond))
                .getRecycleCompositionPosition();
        assertGt(stranded, 0, "fixture: the release stranded value");
        assertEq(resolvedBefore, 0, "nothing resolved yet");
        comp.recordRecoveryTerminalLoss(1, r.fresh, r.recycled);
        (, , , uint256 resolvedAfter) = RewardAggregatorFacet(
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
        (, uint256 stranded, , uint256 resolvedBefore) =
            RewardAggregatorFacet(address(diamond))
                .getRecycleCompositionPosition();
        assertGt(stranded, 0, "fixture: local stranding");
        assertEq(resolvedBefore, 0);
        r;

        address oldBase = address(0x01dBA5E);
        comp.importOutstandingCompensation(CHAIN_ARB, oldBase, 7);
        vpfiTok.mint(address(diamond), 1e18);
        comp.clearImportedOutstanding(CHAIN_ARB, 1e18);
        (, , , uint256 resolvedAfter) = RewardAggregatorFacet(
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
        , bytes32(0));
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
        comp.importOutstandingCompensation(CHAIN_ARB, oldBase, 7);
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
        comp.importOutstandingCompensation(CHAIN_ARB, oldBase, 7);
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

    /// r8-h5 - the conflict carve-out keys on whether the R6 GATE still
    /// holds this receipt, not on terminalization.
    ///
    /// A RELEASED receipt has its declared funding unwound and the gate
    /// held. A NONTERMINAL return chunk then CLEARS the gate without
    /// setting the terminal flag - so keying on the flag skipped the
    /// re-close on exactly the path where the obligation had already lost
    /// its protection, letting a charged replacement fund the open day
    /// while the consumed original also backs mirror claims.
    function test_Recovery_PartialReturnThenConflictRecloses() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 1, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 2e18, 1e18);
        // RELEASE: declared funding unwound, gate still HELD.
        vm.warp(block.timestamp + 7 days);
        comp.releaseRemitReservation(1);
        (uint256 fl0, uint256 fb0) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertEq(fl0 + fb0, 0, "release unwound the declared split");
        assertEq(
            rlens.getCompensationOutstanding(CHAIN_ARB), 1, "gate still held"
        );
        // The quarantine attestation the B1 return needs.
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, false);
        // A PARTIAL chunk: remainder non-zero, so the terminal flag is
        // NEVER set - but the return settlement clears the gate.
        _armReturnIngressNoAck();
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 1e18, 1e18,
            2e18
        , bytes32(0));
        assertEq(
            rlens.getCompensationOutstanding(CHAIN_ARB),
            0,
            "the PARTIAL return cleared the gate"
        );
        // The contradicting consumed ack must RE-CLOSE: nothing else
        // protects the day now. Keyed on terminalization it would not.
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, true);
        (uint256 fl, uint256 fb) = rlens.getCompFunded(CHAIN_ARB, 1);
        assertGt(fl + fb, 0, "funding re-closed once the gate was gone");
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
        comp.importOutstandingCompensation(CHAIN_ARB, oldBase, 7);
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
        comp.importOutstandingCompensation(CHAIN_ARB, oldBase, 7);
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
        comp.importOutstandingCompensation(CHAIN_ARB, oldBase, 7);
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
        , bytes32(0));
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
        , bytes32(0));
        // The permissionless non-consumed ack lands; the re-executed
        // return now settles.
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, 3e18, false);
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 3e18, 3e18, 0
        , bytes32(0));
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
        , bytes32(0));
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
        , bytes32(0));
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
        , bytes32(0));
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
        , bytes32(0));
        assertEq(rlens.getStrandedReturnShortfall(1), 1e18);
        // The delayed earlier chunk (1e18) lands: the loss shrinks to 0.
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 1e18, 1e18,
            2e18
        , bytes32(0));
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
        , bytes32(0));
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
        , bytes32(0));
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
        , bytes32(0));
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
        , bytes32(0));
        assertEq(
            rlens.getStrandedReturnShortfall(1),
            0,
            "no loss closed while the remainder is in flight"
        );
        comp.onStrandedReturnReceived(
            address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), 2e18, 2e18, 0
        , bytes32(0));
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
        , bytes32(0));
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


    // ─── #1461 — a released remittance that LANDS resolves its stranded share ───

    /// @dev #1461 — a late acknowledgement of a RELEASED reservation resolves the
    ///      share its release counted as stranded, exactly once.
    function test_LateAckAfterRelease_ResolvesTheStrandedShare_Once() public {
        (, uint256 recycledSent) = _remitRecycledWithResidual();
        vm.warp(block.timestamp + 7 days);
        comp.releaseRemitReservation(1);
        (, uint256 stranded, , uint256 resolvedBefore) =
            RewardAggregatorFacet(address(diamond)).getRecycleCompositionPosition();
        assertGt(recycledSent, 0, "fixture-live: a recycled share was sent");
        assertEq(stranded, recycledSent, "fixture-live: the release stranded the sent share");
        assertEq(resolvedBefore, 0, "nothing resolved yet");
        assertEq(rlens.getRemitReservation(1).strandedRecycled, recycledSent, "recorded on the reservation");
        uint256 total = rlens.getRemitReservation(1).total;
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, total);
        (, , , uint256 resolved) = RewardAggregatorFacet(address(diamond)).getRecycleCompositionPosition();
        assertEq(resolved, recycledSent, "the landed delivery resolved it");
        assertEq(rlens.getRemitReservation(1).strandedRecycled, 0, "and the record is spent");
        (uint256 booked, ) = rlens.getChainRemittedRecycled(CHAIN_ARB);
        assertEq(booked, recycledSent, "#1452: the late consumption is booked as delivered");
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, total);
        (, , , uint256 again) = RewardAggregatorFacet(address(diamond)).getRecycleCompositionPosition();
        assertEq(again, recycledSent, "a repeated acknowledgement resolves nothing more");
        (uint256 bookedAgain, ) = rlens.getChainRemittedRecycled(CHAIN_ARB);
        assertEq(bookedAgain, recycledSent, "#1452: and books nothing more");
    }

    /// @dev #1461 — a terminal-loss record for the remittance takes its share off
    ///      the same record first, so a late acknowledgement resolves only the
    ///      remainder: the two together never exceed the stranded share.
    function test_TerminalLossThenLateAck_ResolvesOnlyTheRemainder() public {
        (, uint256 recycledSent) = _remitRecycledWithResidual();
        vm.warp(block.timestamp + 7 days);
        comp.releaseRemitReservation(1);
        uint256 lost = recycledSent / 2;
        assertGt(lost, 0, "fixture-live: a non-trivial share");
        comp.recordRecoveryTerminalLoss(1, 0, lost);
        assertEq(rlens.getRemitReservation(1).strandedRecycled, recycledSent - lost, "the loss came off the record");
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, rlens.getRemitReservation(1).total);
        (, , , uint256 resolved) = RewardAggregatorFacet(address(diamond)).getRecycleCompositionPosition();
        assertEq(resolved, recycledSent, "loss plus late delivery resolve the share once, not more");
    }

    // ─── #1452 — the acknowledged recycled share, per destination ───

    /// @dev #1452 — an acknowledged remittance records its recycled share for the
    ///      watcher's relocated-custody cross-check.
    function test_Ack_RecordsTheRecycledShare() public {
        (, uint256 recycledSent) = _remitRecycledWithResidual();
        (uint256 acked0, uint256 forced0) = rlens.getChainRemittedRecycled(CHAIN_ARB);
        assertEq(acked0 + forced0, 0, "nothing before the acknowledgement");
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, rlens.getRemitReservation(1).total);
        (uint256 acked, uint256 forced) = rlens.getChainRemittedRecycled(CHAIN_ARB);
        assertGt(acked, 0, "fixture-live: a recycled share was delivered");
        assertEq(acked, recycledSent, "the delivered recycled share");
        assertEq(forced, 0, "nothing forced");
    }

    /// @dev #1452 — a FORCED finalization is evidenced, not delivered: counted apart.
    function test_ForcedFinalize_CountsTheRecycledShareApart() public {
        (, uint256 recycledSent) = _remitRecycledWithResidual();
        remit.finalizeRemitReservation(1);
        (uint256 acked, uint256 forced) = rlens.getChainRemittedRecycled(CHAIN_ARB);
        assertEq(acked, 0, "no delivery acknowledged");
        assertEq(forced, recycledSent, "the forced share, apart");
    }

    /// @dev #1452 — the mirror relocates custody only when it CREDITS a delivery:
    ///      a quarantined or provisional acknowledgement books nothing, the first
    ///      consumed one books the share, and a repeat books nothing more.
    function test_OnlyAConsumedAck_BooksTheDeliveredShare_Once() public {
        (, uint256 recycledSent) = _remitRecycledWithResidual();
        uint256 total = rlens.getRemitReservation(1).total;
        rewardMessenger.deliverRemitAckWithClassification(CHAIN_ARB, 1, total, 3);
        (uint256 a0, uint256 f0) = rlens.getChainRemittedRecycled(CHAIN_ARB);
        assertEq(rlens.getRemitReservation(1).status, 2, "fixture-live: the provisional ack finalized it");
        assertEq(a0 + f0, 0, "a provisional acknowledgement books nothing");
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, total, false);
        (uint256 a1, ) = rlens.getChainRemittedRecycled(CHAIN_ARB);
        assertEq(a1, 0, "nor does a quarantined one");
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, total);
        (uint256 a2, ) = rlens.getChainRemittedRecycled(CHAIN_ARB);
        assertEq(a2, recycledSent, "the consumption books it");
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, total);
        (uint256 a3, ) = rlens.getChainRemittedRecycled(CHAIN_ARB);
        assertEq(a3, recycledSent, "once");
    }

    /// @dev Codex #2489 r3 — a SHORT delivery books what the mirror relocated,
    ///      `floor(recycled * received / total)`, never the declared share: the
    ///      mesh watcher holds the mirror's relocated custody to this figure.
    ///      Mutation: booking the declared share makes both asserts fail.
    function test_AShortDelivery_BooksTheDeliveredShare_NotTheDeclaredOne() public {
        (, uint256 recycledSent) = _remitRecycledWithResidual();
        uint256 total = rlens.getRemitReservation(1).total;
        uint256 received = total - total / 10; // a 10% fee on transfer
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, received);
        (uint256 acked, ) = rlens.getChainRemittedRecycled(CHAIN_ARB);
        uint256 relocated = Math.mulDiv(recycledSent, received, total);
        assertLt(relocated, recycledSent, "fixture-live: the short delivery scales the share down");
        assertEq(acked, relocated, "booked as the mirror relocated it");
    }

    /// @dev Codex #2489 r3 — the forced bucket keeps the DECLARED share, and a
    ///      later short authentic acknowledgement moves exactly that off it and
    ///      the DELIVERED share onto the acked figure.
    function test_ForcedThenShortAcked_MovesDeclaredOff_DeliveredOn() public {
        (, uint256 recycledSent) = _remitRecycledWithResidual();
        remit.finalizeRemitReservation(1);
        (, uint256 forcedBefore) = rlens.getChainRemittedRecycled(CHAIN_ARB);
        assertEq(forcedBefore, recycledSent, "fixture-live: the declared share is booked as forced");
        uint256 total = rlens.getRemitReservation(1).total;
        uint256 received = total - total / 10;
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, received);
        (uint256 acked, uint256 forced) = rlens.getChainRemittedRecycled(CHAIN_ARB);
        assertEq(forced, 0, "the declared share comes off the forced figure");
        assertEq(acked, Math.mulDiv(recycledSent, received, total), "the delivered share goes on the acked one");
    }

    /// @dev #1452 — a forced finalization later confirmed by the delivery's own
    ///      consumed acknowledgement IS acknowledged: its share moves over.
    function test_ForcedThenAcked_MovesTheShareToAcked() public {
        (, uint256 recycledSent) = _remitRecycledWithResidual();
        remit.finalizeRemitReservation(1);
        (, uint256 forcedBefore) = rlens.getChainRemittedRecycled(CHAIN_ARB);
        assertEq(forcedBefore, recycledSent, "fixture-live: the forced share is booked");
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, rlens.getRemitReservation(1).total);
        (uint256 acked, uint256 forced) = rlens.getChainRemittedRecycled(CHAIN_ARB);
        assertEq(forced, 0, "off the forced figure");
        assertEq(acked, recycledSent, "onto the acknowledged one");
    }

    function _resolvedStranded() internal view returns (uint256 resolved) {
        (, , , resolved) = RewardAggregatorFacet(address(diamond)).getRecycleCompositionPosition();
    }

    /// @dev #1461 — a QUARANTINED late delivery was not credited on the mirror:
    ///      it resolves nothing; neither does a consumption reported after it
    ///      (contradicted, so not trusted); and the recovery ceremony that brings
    ///      the value home resolves it — once, not on top of an acknowledgement.
    function test_AQuarantinedLateAck_ResolvesNothing_TheCeremonyResolvesOnce() public {
        LibVaipakam.RemitReservation memory r = _releasedMixedFixture();
        uint256 stranded = r.strandedRecycled;
        assertGt(stranded, 0, "fixture-live: the release stranded a recycled share");
        uint256 resolved0 = _resolvedStranded();
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, r.total, false);
        assertTrue(rlens.getRemitReservation(1).quarantineAcked, "fixture-live: the quarantine is stamped");
        assertEq(_resolvedStranded(), resolved0, "a quarantined delivery resolves nothing");
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, r.total);
        assertTrue(rlens.getRemitReservation(1).consumedAcked, "fixture-live: the consumption is stamped too");
        assertEq(_resolvedStranded(), resolved0, "a contradicted consumption resolves nothing");
        assertEq(rlens.getRemitReservation(1).strandedRecycled, stranded, "the record stands for the ceremony");
        comp.recordRecoveryCeremony(1, r.fresh, r.recycled);
        assertEq(_resolvedStranded() - resolved0, r.recycled, "the ceremony resolves its recycled inflow, once");
    }

    /// @dev #1461 — the exclusivity rests on trust never lapsing: once a late
    ///      consumption is trusted (and has resolved the share), a later
    ///      quarantine report is refused and so is the ceremony — nothing can
    ///      resolve the same remittance a second time. A provisional report
    ///      changes nothing either.
    function test_ATrustedConsumption_NeverLapses_SoNothingResolvesTwice() public {
        LibVaipakam.RemitReservation memory r = _releasedMixedFixture();
        uint256 stranded = r.strandedRecycled;
        assertGt(stranded, 0, "fixture-live: the release stranded a recycled share");
        uint256 resolved0 = _resolvedStranded();
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, r.total);
        assertEq(_resolvedStranded() - resolved0, stranded, "the trusted consumption resolved it");
        rewardMessenger.deliverRemitAckWithClassification(CHAIN_ARB, 1, r.total, 3);
        rewardMessenger.deliverRemitAckWithConsumed(CHAIN_ARB, 1, r.total, false);
        assertFalse(rlens.getRemitReservation(1).quarantineAcked, "the quarantine report is refused");
        assertEq(_resolvedStranded() - resolved0, stranded, "still resolved once");
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.StrandedReturnConsumedReceipt.selector, 1));
        comp.recordRecoveryCeremony(1, 0, r.recycled);
    }

    // ─── #2760 — why a day does or does not close ─────────────────────────

    function _statuses(uint256[] memory list) internal view returns (LibRemitDayLedger.RemitDayStatus[] memory) {
        return remit.quoteRemitDayStatuses(CHAIN_ARB, list, CAP);
    }

    function _status1(uint256 d) internal view returns (LibRemitDayLedger.RemitDayStatus) {
        return _statuses(_days(d))[0];
    }

    /// A status agrees with the planner's figure for the same list: a day is
    /// `Closeable` exactly when `quoteRemitDayPlans` calls it closeable.
    function _assertAgrees(uint256[] memory list) internal view {
        (, bool[] memory closeable) = remit.quoteRemitDayPlans(CHAIN_ARB, list, CAP);
        LibRemitDayLedger.RemitDayStatus[] memory st = _statuses(list);
        assertEq(st.length, list.length, "aligned to the input");
        for (uint256 i; i < list.length; ++i) {
            bool acts = st[i] == LibRemitDayLedger.RemitDayStatus.Closeable
                || st[i] == LibRemitDayLedger.RemitDayStatus.Partial;
            assertEq(acts, closeable[i], "status agrees with the plan");
        }
    }

    function test_Status_OpenRepeatedUnfinalizedThenRemitted() public {
        _finalizeDay(1);
        uint256[] memory list = new uint256[](3);
        list[0] = 1;
        list[1] = 1;
        list[2] = 2; // not finalized
        LibRemitDayLedger.RemitDayStatus[] memory st = _statuses(list);
        assertEq(uint8(st[0]), uint8(LibRemitDayLedger.RemitDayStatus.Closeable), "owed and closeable");
        assertEq(uint8(st[1]), uint8(LibRemitDayLedger.RemitDayStatus.Repeated), "the copy is not judged");
        assertEq(uint8(st[2]), uint8(LibRemitDayLedger.RemitDayStatus.NotFinalized), "not finalized");
        _assertAgrees(list);

        _remitDay1ToArb();
        assertEq(uint8(_status1(1)), uint8(LibRemitDayLedger.RemitDayStatus.Remitted), "settled by a remit");
        _assertAgrees(list);
    }

    function test_Status_ZeroClampCloseReadsClosed() public {
        _finalizeDay(1);
        _armDayForArb(1, 100e18, 0);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 0, 0);
        assertEq(uint8(_status1(1)), uint8(LibRemitDayLedger.RemitDayStatus.Closeable), "close-only is closeable");
        remit.remitRewardBudget{value: 0.01 ether}(CHAIN_ARB, _days(1), 1e24);
        assertEq(uint8(_status1(1)), uint8(LibRemitDayLedger.RemitDayStatus.Closed), "closed with nothing sent");
    }

    function test_Status_ArmedDayAwaitsItsCommitmentReport() public {
        _finalizeDay(1);
        _armDayForArb(1, 100e18, 0);
        assertEq(
            uint8(_status1(1)), uint8(LibRemitDayLedger.RemitDayStatus.AwaitingCommitment), "owed, waiting on the report"
        );
        _assertAgrees(_days(1));
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 1e30, 1e30);
        assertEq(uint8(_status1(1)), uint8(LibRemitDayLedger.RemitDayStatus.Closeable), "the report releases it");
    }

    function test_Status_RemitIneligibleDayIsNamed() public {
        _finalizeDay(1);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        assertEq(uint8(_status1(1)), uint8(LibRemitDayLedger.RemitDayStatus.Ineligible), "owed via the manual path");
        _assertAgrees(_days(1));
    }

    function test_Status_RecycledDayWithoutBackingIsUnbacked() public {
        _finalizeDay(1);
        _armDayForArb(1, 0, 50e18); // recycled-only slice
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 3e18, 0);
        mutator.setRecycleBucketRaw(0);
        mutator.setOutstandingCommitRaw(0, 1_000e18);
        assertEq(uint8(_status1(1)), uint8(LibRemitDayLedger.RemitDayStatus.Unbacked), "owed, backing short");
        _assertAgrees(_days(1));
        mutator.setRecycleBucketRaw(2_000e18);
        assertEq(uint8(_status1(1)), uint8(LibRemitDayLedger.RemitDayStatus.Closeable), "backed again");
    }

    /// A finalized day that gave this mirror no budget owes nothing and is
    /// never closed: before the status view it read exactly like an owed,
    /// gated day.
    function test_Status_DayWithNoBudgetForTheMirrorOwesNothing() public {
        rewardMessenger.deliverChainReport(CHAIN_BASE, 1, 10e18, 5e18);
        rewardMessenger.deliverChainReport(CHAIN_ARB, 1, 0, 0);
        rewardMessenger.deliverChainReport(CHAIN_OP, 1, 30e18, 15e18);
        RewardAggregatorFacet(address(diamond)).finalizeDay(1);
        assertEq(uint8(_status1(1)), uint8(LibRemitDayLedger.RemitDayStatus.NothingOwed), "nothing owed");
        _assertAgrees(_days(1));
    }

    /// An ARMED day that gave this mirror no budget owes nothing even before
    /// its commitment report arrives: the report can only clamp a budget
    /// down, so the gate must not name such a day owed and waiting (#2760 r1).
    function test_Status_ArmedDayWithNoBudgetOwesNothingBeforeItsReport() public {
        rewardMessenger.deliverChainReport(CHAIN_BASE, 1, 10e18, 5e18);
        rewardMessenger.deliverChainReport(CHAIN_ARB, 1, 0, 0);
        rewardMessenger.deliverChainReport(CHAIN_OP, 1, 30e18, 15e18);
        RewardAggregatorFacet(address(diamond)).finalizeDay(1);
        _armDayForArb(1, 0, 0);
        assertEq(uint8(_status1(1)), uint8(LibRemitDayLedger.RemitDayStatus.NothingOwed), "nothing owed, no report");
        _assertAgrees(_days(1));
    }

    /// The zero value is never `Closeable`, so a status a path forgot to set
    /// cannot read as one.
    function test_Status_ZeroValueIsNotCloseable() public pure {
        assertEq(uint8(LibRemitDayLedger.RemitDayStatus.NotFinalized), 0);
        assertTrue(uint8(LibRemitDayLedger.RemitDayStatus.Closeable) != 0);
    }

    // ─── #918 — a day sent in parts ───────────────────────────────────────

    function _ledger(uint256 d) internal view returns (LibVaipakam.RemitDayLedger memory) {
        return RewardRemittanceLensFacet(address(diamond)).getRemitDayLedger(CHAIN_ARB, d);
    }

    function _partStatus(uint256 d, uint256 partCap) internal view returns (LibRemitDayLedger.RemitDayStatus) {
        return remit.quoteRemitDayStatuses(CHAIN_ARB, _days(d), partCap)[0];
    }

    /// @dev Send day `d`'s next part under `partCap`, asserting the fee quote
    ///      names exactly what the send then moves. Returns the part.
    function _sendPart(uint256 d, uint256 partCap) internal returns (uint256 part) {
        (uint256[] memory plan, bool[] memory acts) = remit.quoteRemitDayPlans(CHAIN_ARB, _days(d), partCap);
        assertTrue(acts[0], "the part is actionable");
        (, uint256 quoted) = remit.quoteRemittanceFee(CHAIN_ARB, _days(d), partCap);
        assertEq(quoted, plan[0], "fee quote == plan");
        uint256 nonce = rlens.getRemitReservationNonce();
        remit.remitRewardBudget{value: 0.01 ether}(CHAIN_ARB, _days(d), partCap);
        LibVaipakam.RemitReservation memory r = rlens.getRemitReservation(nonce + 1);
        part = r.total;
        assertEq(part, quoted, "send == quote");
        assertLe(part, partCap, "a part never exceeds its cap");
        assertEq(r.dayIds.length, 1, "the reservation names its one day");
        assertEq(r.fundedDayBits[0], part == 0 ? 0 : 1, "funded iff it moved VPFI");
    }

    /// @notice #918 case 1 — an unarmed fresh-only day larger than the cap goes
    ///         in three fresh parts. Every part is reserved and counted once,
    ///         the day stays open (no marker) until the last, and the parts
    ///         sum to the whole the first part locked.
    function test_918_AFreshDay_GoesInParts_AndClosesOnlyOnTheLast() public {
        _finalizeDay(1);
        (uint256 whole, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        assertGt(whole, 2, "fixture: a slice to split");
        uint256 cap = whole / 3 + 1;

        assertEq(uint8(_partStatus(1, cap)), uint8(LibRemitDayLedger.RemitDayStatus.Partial), "first part is partial");
        uint256 p1 = _sendPart(1, cap);
        assertEq(p1, cap, "fresh-first, cap-sized");
        LibVaipakam.RemitDayLedger memory l = _ledger(1);
        assertTrue(l.locked, "stored: the whole is locked at the first part");
        assertEq(l.wholeFresh, whole, "stored: the whole");
        assertEq(l.sentFresh, p1, "stored: the part");
        assertEq(rlens.getRewardBudgetRemitted(CHAIN_ARB, 1), 0, "not remitted until whole");
        assertEq(rlens.getDayClosedByRemitId(CHAIN_ARB, 1), 0, "not closed until whole");
        (uint256 owed, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        assertEq(owed, whole - p1, "the cap-free quote names what is still owed");

        uint256 p2 = _sendPart(1, cap);
        assertEq(uint8(_partStatus(1, cap)), uint8(LibRemitDayLedger.RemitDayStatus.Closeable), "the last part completes");
        uint256 p3 = _sendPart(1, cap);
        assertEq(p1 + p2 + p3, whole, "the parts sum to the whole");
        l = _ledger(1);
        assertEq(l.partsSent, 3, "stored: three parts");
        assertEq(l.partsLive, 3);
        assertEq(rlens.getRewardBudgetRemitted(CHAIN_ARB, 1), whole, "remitted at the whole");
        assertEq(rlens.getDayClosedByRemitId(CHAIN_ARB, 1), 3, "closed by the completing part");
        assertEq(rlens.getRewardBudgetRemittedGlobal(), whole, "global counted once per VPFI");
        assertEq(rlens.getRemitPendingTotal(CHAIN_ARB), whole, "pending = every part in flight");
        assertEq(uint8(_partStatus(1, cap)), uint8(LibRemitDayLedger.RemitDayStatus.Remitted), "and settled");
        vm.expectRevert(RewardRemittanceFacet.NothingToRemit.selector);
        remit.remitRewardBudget{value: 0.01 ether}(CHAIN_ARB, _days(1), cap);
    }

    /// @notice #918 (Codex #2959 r3) — an armed day's FIRST part converts its
    ///         whole fresh commitment, clamp residual included, into the pool
    ///         hold, so every spender of the pool sees the rest of the day as
    ///         used. A Base claim or sweep reads `poolRemaining` and never nets
    ///         the commitments; before r3 the rest of a partly sent armed day
    ///         was held only by its commitment and a claim could take it.
    ///         Mutation: leave the commitment standing for the unsent rest
    ///         (retire per part) and the pool reads the rest as free.
    function test_918_AnArmedDay_ConvertsItsWholeCommitmentIntoTheHold_AtItsFirstPart() public {
        _finalizeDay(1);
        _armDayForArb(1, 100e18, 0);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 2e18, 1e18);
        mutator.setOutstandingCommitRaw(1_000e18, 0);
        (, uint256 f0, , ) = RewardAggregatorFacet(address(diamond)).getGovernorCommitState();
        InteractionRewardsLensFacet ilens = InteractionRewardsLensFacet(address(diamond));
        uint256 room0 = ilens.getInteractionPoolRemaining();

        uint256 p1 = _sendPart(1, 1e18);
        LibVaipakam.RemitDayLedger memory l = _ledger(1);
        assertTrue(l.armed, "stored: armed");
        assertEq(l.wholeFresh, 3e18, "the clamped whole");
        assertGt(l.armedWholeFresh, l.wholeFresh, "fixture: a residual exists");
        assertEq(l.residualRemitId, 1, "stored: the first part retired the residual");
        assertEq(rlens.getRemitReservation(1).armedFreshFull, l.armedWholeFresh, "part 1 retires the whole commitment");
        (, uint256 f1, , ) = RewardAggregatorFacet(address(diamond)).getGovernorCommitState();
        assertEq(f0 - f1, l.armedWholeFresh, "the commitment is gone after the first part");
        assertEq(rlens.getRemitDayFreshReserved(), l.wholeFresh - p1, "the hold carries the rest of the day");
        assertEq(ilens.getInteractionPoolRemaining(), room0 - l.wholeFresh, "the pool, as a claim reads it, has the whole day as used");

        _sendPart(1, 1e18);
        _sendPart(1, 1e18);
        assertEq(rlens.getRemitReservation(2).armedFreshFull, 0, "a later part retires no fresh commitment");
        assertEq(rlens.getRemitReservation(3).armedFreshFull, 0);
        (, uint256 f3, , ) = RewardAggregatorFacet(address(diamond)).getGovernorCommitState();
        assertEq(f0 - f3, l.armedWholeFresh, "the whole armed commitment retired exactly once");
        assertEq(rlens.getRemitDayFreshReserved(), 0, "a whole day holds nothing");
        assertEq(ilens.getInteractionPoolRemaining(), room0 - l.wholeFresh, "and the pool use is the whole, once");
        assertEq(rlens.getRewardBudgetRemitted(CHAIN_ARB, 1), 3e18, "remitted at the clamp");
    }

    /// @notice #918 — a mixed day goes fresh-first; the bucket is debited by
    ///         the recycled parts only, and the recycled residual retires once.
    function test_918_AMixedDay_GoesFreshFirst_AndDebitsTheBucketByItsRecycledParts() public {
        _finalizeDay(1);
        _armDayForArb(1, 100e18, 50e18);
        mutator.setRecycleBucketRaw(1_000e18);
        mutator.setOutstandingCommitRaw(1_000e18, 1_000e18);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 1e30, 1e30);
        (uint256 whole, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));

        uint256 sentFresh;
        uint256 sentRecycled;
        uint256 cap = whole / 4 + 1;
        for (uint256 i; i < 8 && rlens.getDayClosedByRemitId(CHAIN_ARB, 1) == 0; ++i) {
            uint256 n = rlens.getRemitReservationNonce();
            _sendPart(1, cap);
            LibVaipakam.RemitReservation memory r = rlens.getRemitReservation(n + 1);
            if (sentFresh < _ledger(1).wholeFresh) {
                assertEq(sentRecycled, 0, "no recycled before the fresh is sent");
            }
            sentFresh += r.fresh;
            sentRecycled += r.recycled;
        }
        LibVaipakam.RemitDayLedger memory l = _ledger(1);
        assertEq(sentFresh, l.wholeFresh, "every fresh unit sent once");
        assertEq(sentRecycled, l.wholeRecycled, "every recycled unit sent once");
        assertEq(sentFresh + sentRecycled, whole, "and nothing else");
        assertEq(ConfigFacet(address(diamond)).getRecycleBucket(), 1_000e18 - l.wholeRecycled, "bucket debit = recycled parts");
        (, , uint256 outRecycled, ) = RewardAggregatorFacet(address(diamond)).getGovernorCommitState();
        assertEq(1_000e18 - outRecycled, l.armedWholeRecycled, "the whole recycled commitment retired once");
    }

    /// @notice #918 case 4 — releasing one part restores exactly that part:
    ///         the day re-opens owing it, the other parts stand, and the
    ///         re-send moves exactly the released amount. On an armed day the
    ///         fresh commitment is NOT restored (Codex #2959 r3): it became the
    ///         day's pool hold at the first part, so the released fresh is
    ///         uncovered instead and the re-send must find room for it, as on
    ///         an unarmed day. Releasing the part that retired the residual
    ///         hands the residual marker to the next part.
    function test_918_ReleasingAPart_RestoresExactlyThatPart() public {
        _finalizeDay(1);
        _armDayForArb(1, 100e18, 0);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 2e18, 1e18);
        mutator.setOutstandingCommitRaw(1_000e18, 0);
        (, uint256 f0, , ) = RewardAggregatorFacet(address(diamond)).getGovernorCommitState();
        _sendPart(1, 1e18);
        _sendPart(1, 1e18);
        _sendPart(1, 1e18);
        uint256 armedWhole = _ledger(1).armedWholeFresh;

        vm.warp(block.timestamp + 7 days);
        // A middle part: the day re-opens owing exactly it.
        comp.releaseRemitReservation(2);
        LibVaipakam.RemitDayLedger memory l = _ledger(1);
        assertEq(l.sentFresh, 2e18, "stored: the other parts stand");
        assertEq(l.partsLive, 2);
        assertEq(l.residualRemitId, 1, "the residual stays with part 1");
        assertEq(l.freshUncovered, 1e18, "stored: the released fresh is uncovered");
        assertEq(rlens.getRewardBudgetRemitted(CHAIN_ARB, 1), 0, "no longer whole: unmarked");
        assertEq(rlens.getDayClosedByRemitId(CHAIN_ARB, 1), 0);
        (uint256 owed, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        assertEq(owed, 1e18, "owes exactly the released part");
        (, uint256 fMid, , ) = RewardAggregatorFacet(address(diamond)).getGovernorCommitState();
        assertEq(fMid, f0 - armedWhole, "no fresh commitment is restored");

        // The residual-holder: its release hands the residual marker on.
        comp.releaseRemitReservation(1);
        l = _ledger(1);
        assertEq(l.residualRemitId, 0, "the residual is unretired again");
        assertEq(l.wholeFresh, 3e18, "the whole stays locked");
        assertEq(l.freshUncovered, 2e18, "stored: both released parts are uncovered");
        (, uint256 fBoth, , ) = RewardAggregatorFacet(address(diamond)).getGovernorCommitState();
        assertEq(fBoth, f0 - armedWhole, "still none restored");

        uint256 globalBefore = rlens.getRewardBudgetRemittedGlobal();
        uint256 re = _sendPart(1, 5e18);
        assertEq(re, 2e18, "the re-send moves exactly what was released");
        assertEq(rlens.getRemitReservation(4).armedFreshFull, 0, "and retires no fresh commitment");
        assertEq(_ledger(1).residualRemitId, 4, "it takes the residual marker");
        assertEq(rlens.getRewardBudgetRemittedGlobal(), globalBefore + 2e18, "the re-sent fresh is charged again");
        (, uint256 fEnd, , ) = RewardAggregatorFacet(address(diamond)).getGovernorCommitState();
        assertEq(f0 - fEnd, armedWhole, "the whole commitment retired exactly once, net");
        assertEq(rlens.getRemitDayFreshReserved(), 0, "a whole day holds nothing");
        assertEq(rlens.getDayClosedByRemitId(CHAIN_ARB, 1), 4, "re-closed by the re-send");
        assertEq(rlens.getRewardBudgetRemitted(CHAIN_ARB, 1), 3e18);
    }

    function _openDays() internal view returns (uint256[] memory) {
        return RewardRemittanceLensFacet(address(diamond)).getRemitOpenDays(CHAIN_ARB);
    }

    /// @notice #2960 — Base lists the days it has sent a destination in part
    ///         and still owes: a part that leaves its day owing lists it, the
    ///         completing part takes it off, and a release that reopens a
    ///         whole day lists it again until the re-send. A day sent whole
    ///         in one part is never listed. Mutation: list on lock instead of
    ///         on "not whole" and the completed day stays listed.
    function test_2960_TheOpenDayList_FollowsTheLedger() public {
        _finalizeDay(1);
        _armDayForArb(1, 100e18, 0);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 2e18, 1e18);
        mutator.setOutstandingCommitRaw(1_000e18, 0);
        assertEq(_openDays().length, 0, "nothing sent, nothing open");

        _sendPart(1, 1e18);
        uint256[] memory open = _openDays();
        assertEq(open.length, 1, "a part that leaves the day owing lists it");
        assertEq(open[0], 1);
        _sendPart(1, 1e18);
        assertEq(_openDays().length, 1, "listed once, however many parts");
        _sendPart(1, 1e18);
        assertEq(_openDays().length, 0, "the completing part takes it off");

        vm.warp(block.timestamp + 7 days);
        comp.releaseRemitReservation(2);
        open = _openDays();
        assertEq(open.length, 1, "a release that reopens the day lists it again");
        assertEq(open[0], 1);
        _sendPart(1, 5e18);
        assertEq(_openDays().length, 0, "the re-send takes it off");
    }

    /// @notice #918 (Codex #2959 r1) — an UNARMED day holds the rest of its
    ///         fresh in the pool between parts, and a released part's fresh
    ///         stops being held: the re-send must find room for it again, as a
    ///         re-send of a released whole day always has.
    function test_918_AnUnarmedDay_HoldsItsRest_AndAReleasedPartNeedsRoomAgain() public {
        _finalizeDay(1);
        (uint256 whole, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        uint256 cap = whole / 3 + 1;
        uint256 p1 = _sendPart(1, cap);
        assertFalse(_ledger(1).armed, "fixture: unarmed");
        assertEq(rlens.getRemitDayFreshReserved(), whole - p1, "the first part holds the rest");
        uint256 p2 = _sendPart(1, cap);
        uint256 held = whole - p1 - p2;
        assertEq(rlens.getRemitDayFreshReserved(), held, "each part moves itself out of the hold");

        vm.warp(block.timestamp + 7 days);
        comp.releaseRemitReservation(2);
        assertEq(_ledger(1).freshUncovered, p2, "stored: the released part is uncovered");
        assertEq(rlens.getRemitDayFreshReserved(), held, "the hold is unchanged by a release");
        assertEq(rlens.getRewardBudgetRemittedGlobal(), p1 + p2, "the released part stays charged");

        // One wei short of the room the released part needs: refused.
        mutator.setInteractionPoolPaidOut(CAP - (p1 + p2) - held - (p2 - 1));
        vm.expectRevert(
            abi.encodeWithSelector(RewardRemittanceFacet.RewardPoolCapExceeded.selector, p2, p2 - 1)
        );
        remit.remitRewardBudget{value: 0.01 ether}(CHAIN_ARB, _days(1), whole);

        // Exactly enough: the rest of the day goes in one, and the hold empties.
        mutator.setInteractionPoolPaidOut(CAP - (p1 + p2) - held - p2);
        uint256 rest = _sendPart(1, whole);
        assertEq(rest, whole - p1, "the re-send moves the released part and the rest");
        assertEq(rlens.getRemitDayFreshReserved(), 0, "a whole day holds nothing");
        assertEq(_ledger(1).freshUncovered, 0, "stored: nothing uncovered");
        assertEq(rlens.getRewardBudgetRemittedGlobal(), whole + p2, "the re-sent part is charged twice, as documented");
        assertEq(rlens.getRewardBudgetRemitted(CHAIN_ARB, 1), whole, "and the day completes");
    }

    /// @notice #918 case 5 — the backing verdict does not depend on the part
    ///         size: a day the whole send would refuse for recycled backing is
    ///         refused at every cap, and one it would admit is admitted.
    function test_918_TheBackingVerdict_IsPartSizeIndependent() public {
        _finalizeDay(1);
        _armDayForArb(1, 0, 50e18);
        mutator.setOutstandingCommitRaw(0, 1_000e18);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, 1, 1e30, 1e30);
        mutator.setRecycleBucketRaw(1_000e18);
        (uint256 whole, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        assertGt(whole, 0, "fixture: a recycled slice");
        uint256[3] memory caps = [whole, whole / 2 + 1, whole / 7 + 1];

        // At the margin: the bucket one wei short of the outstanding recycled
        // commitment (no clamp residual to retire) fails the net backing gate
        // whatever the part size, and exactly level passes it at every size.
        mutator.setRecycleBucketRaw(1_000e18 - 1);
        for (uint256 i; i < 3; ++i) {
            assertEq(uint8(_partStatus(1, caps[i])), uint8(LibRemitDayLedger.RemitDayStatus.Unbacked), "refused at every cap");
        }
        mutator.setRecycleBucketRaw(1_000e18);
        for (uint256 i; i < 3; ++i) {
            LibRemitDayLedger.RemitDayStatus st = _partStatus(1, caps[i]);
            assertTrue(
                st == LibRemitDayLedger.RemitDayStatus.Closeable || st == LibRemitDayLedger.RemitDayStatus.Partial,
                "admitted at every cap"
            );
        }
    }

    /// @notice #918 — a partly-sent day has one funding record: the manual
    ///         path refuses it even when the day is (made) remit-ineligible.
    function test_918_TheManualPath_RefusesAPartlySentDay() public {
        _finalizeDay(1);
        (uint256 whole, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        _sendPart(1, whole / 2);
        mutator.setChainDayRemitIneligibleRaw(1, CHAIN_ARB, true);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.RemitDayPartlySent.selector, uint256(1), CHAIN_ARB));
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 1, 1e18, 0);
    }

    /// @notice #918 — `partCap` is validated on the quotes as on the send.
    function test_918_TheQuotes_RefuseAZeroPartCap() public {
        _finalizeDay(1);
        vm.expectRevert(RewardRemittanceFacet.InvalidRemittanceCap.selector);
        remit.quoteRemitDayPlans(CHAIN_ARB, _days(1), 0);
        vm.expectRevert(RewardRemittanceFacet.InvalidRemittanceCap.selector);
        remit.quoteRemitDayStatuses(CHAIN_ARB, _days(1), 0);
        vm.expectRevert(RewardRemittanceFacet.InvalidRemittanceCap.selector);
        remit.quoteRemittanceFee(CHAIN_ARB, _days(1), 0);
    }

    /// @notice #918 case 9 — an ordinary fresh-only PART is a one-day
    ///         reservation with no declared split, so the stranded-return
    ///         ingress (compensation receipts only) refuses it by name. Parts
    ///         make that shape common; it must not read as a compensation.
    function test_918_TheStrandedReturn_RefusesAnOrdinaryPart() public {
        _finalizeDay(1);
        (uint256 whole, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        uint256 part = _sendPart(1, whole / 2);
        _armReturnIngress();
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.StrandedReturnNotCompensation.selector, uint256(1)));
        comp.onStrandedReturnReceived(address(diamond), 1, 1, CHAIN_ARB, address(vpfiTok), part, part, 0, bytes32(0));
    }
}
