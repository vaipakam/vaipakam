// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardRemitDestinationFacet} from "../src/facets/RewardRemitDestinationFacet.sol";
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
import {RewardCompensationDispatchFacet} from "../src/facets/RewardCompensationDispatchFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {RewardCommitmentFacet} from "../src/facets/RewardCommitmentFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibRemitDayLedger} from "../src/libraries/LibRemitDayLedger.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {MockCrossChainMessenger} from "./mocks/MockCrossChainMessenger.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/**
 * @title RewardRemitDestinationRemovalTest — #2963 a chain taken off Base's
 *        expected-source list.
 * @notice Owner decision 2026-10-27 ("On removal"): removing a chain releases,
 *         in the same write, the pool room Base held for its unsent remit days;
 *         only Base releases, each released day emits its figures, and the
 *         chain's users lose those days. These cells pin what is released for
 *         each kind of day, that an abandoned day is never sent again by any
 *         path, that a part released after the walk restores nothing the walk
 *         already freed (and one released before it is counted by the walk),
 *         and the re-list and continuation rules.
 */
contract RewardRemitDestinationRemovalTest is SetupTest {
    RewardRemittanceFacet internal remit;
    RewardRemitDestinationFacet internal dest;
    RewardRemittanceLensFacet internal rlens;
    RewardCompensationDispatchFacet internal comp;
    RewardAggregatorFacet internal agg;
    InteractionRewardsLensFacet internal ilens;
    MockRewardMessenger internal rewardMessenger;
    MockCrossChainMessenger internal ccip;
    VPFIToken internal vpfiTok;
    TestMutatorFacet internal mutator;

    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    uint32 internal constant CHAIN_OP = 10;
    uint256 internal constant CAP = 69_000_000 ether;

    address internal stranger = address(0xCAFE);
    uint256 internal launch;

    event RemitDestinationRemoved(uint32 indexed dstChainId, uint256 abandonedBefore, uint256 releaseCursor);
    event RemitAbandonedDayReleased(
        uint32 indexed dstChainId,
        uint256 indexed dayId,
        bool locked,
        uint256 heldFresh,
        uint256 commitFresh,
        uint256 commitRecycled
    );
    event RemitAbandonedPartReleased(
        uint32 indexed dstChainId, uint256 indexed dayId, uint256 indexed remitId, uint256 recycledNotRestored
    );

    function setUp() public {
        setupHelper();

        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(VPFIToken.initialize, (address(this), address(this), address(this)))
        );
        vpfiTok = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfiTok));
        vpfiTok.mint(address(this), 100_000_000 ether);
        vpfiTok.transfer(address(diamond), 100_000_000 ether);

        rewardMessenger = new MockRewardMessenger(address(diamond));
        ccip = new MockCrossChainMessenger();
        remit = RewardRemittanceFacet(address(diamond));
        dest = RewardRemitDestinationFacet(address(diamond));
        rlens = RewardRemittanceLensFacet(address(diamond));
        comp = RewardCompensationDispatchFacet(address(diamond));
        agg = RewardAggregatorFacet(address(diamond));
        ilens = InteractionRewardsLensFacet(address(diamond));
        mutator = TestMutatorFacet(address(diamond));

        vm.chainId(CHAIN_BASE);
        _ensureRewardClockLaunched();
        launch = ilens.getInteractionLaunchTimestamp();

        RewardReporterFacet rep = RewardReporterFacet(address(diamond));
        rep.setBaseChainId(CHAIN_BASE);
        rep.setIsCanonicalRewardChain(true);
        activateRewardCustodyForTest(address(vpfiTok), 10_000_000 ether);
        rep.setRewardMessenger(address(rewardMessenger));
        TreasuryFacet(address(diamond)).setCrossChainMessenger(address(ccip));

        agg.setExpectedSourceChainIds(_list3());
        RewardCommitmentFacet(address(diamond)).setMirrorRewardDeployment(CHAIN_ARB, address(rewardMessenger));

        vm.deal(address(this), 10 ether);
        vm.deal(stranger, 10 ether);
    }

    // ─── helpers ──────────────────────────────────────────────────────────

    function _list3() internal pure returns (uint32[] memory l) {
        l = new uint32[](3);
        l[0] = CHAIN_BASE;
        l[1] = CHAIN_ARB;
        l[2] = CHAIN_OP;
    }

    /// @dev The list without Arbitrum.
    function _listNoArb() internal pure returns (uint32[] memory l) {
        l = new uint32[](2);
        l[0] = CHAIN_BASE;
        l[1] = CHAIN_OP;
    }

    function _finalizeDay(uint256 d) internal {
        rewardMessenger.deliverChainReport(CHAIN_BASE, d, 10e18, 5e18);
        rewardMessenger.deliverChainReport(CHAIN_ARB, d, 20e18, 10e18);
        rewardMessenger.deliverChainReport(CHAIN_OP, d, 30e18, 15e18);
        agg.finalizeDay(d);
    }

    /// @dev Finalize days `0..n-1` with all three chains reporting.
    function _finalizeThrough(uint256 n) internal {
        for (uint256 d; d < n; ++d) _finalizeDay(d);
    }

    function _days(uint256 d) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = d;
    }

    function _warpToDay(uint256 d) internal {
        vm.warp(launch + d * 1 days + 1);
    }

    function _status(uint32 dst, uint256 d) internal view returns (LibRemitDayLedger.RemitDayStatus) {
        return remit.quoteRemitDayStatuses(dst, _days(d), CAP)[0];
    }

    function _outstanding() internal view returns (uint256 fresh, uint256 recycled) {
        (, fresh, recycled, ) = agg.getGovernorCommitState();
    }

    function _release() internal view returns (uint256 abandonedBefore, uint256 cursor) {
        return rlens.getRemitDestinationRelease(CHAIN_ARB);
    }

    /// @dev Arm day `d` for Arbitrum AFTER its unarmed finalization, with the
    ///      given fresh half and recycled equivalent, and seed the commitment
    ///      ledgers with a known baseline (production books them at an armed
    ///      finalize). `liab` is Arbitrum's reported liability per side: at or
    ///      above the slice it leaves the day unclamped.
    /// @dev Arming marks every day from `d` on as armed, so a cell arming a
    ///      day finalizes nothing after it: the walk then stops at the first
    ///      unfinalized day and releases the armed day alone.
    function _armArbDay(uint256 d, uint128 freshHalf, uint256 recycledEquiv, uint256 liab) internal {
        mutator.setGovernorCommitArmedFromDayRaw(d);
        mutator.setDayPoolStampRaw(d, uint128(freshHalf) * 2, 0);
        mutator.setChainDayFundingRaw(d, CHAIN_ARB, freshHalf, recycledEquiv);
        mutator.setRecycleBucketRaw(1_000e18);
        mutator.setOutstandingCommitRaw(1_000e18, 1_000e18);
        rewardMessenger.deliverCommitmentReport(CHAIN_ARB, d, liab, liab);
    }

    // ─── locked days ──────────────────────────────────────────────────────

    /// A partly sent unarmed day holds the rest of its fresh in the pool.
    /// Removing the chain frees exactly that, names it in an event, and the
    /// day is never sent again. Optimism's identical day is untouched.
    function test_Removal_FreesAPartlySentDaysHeldFresh() public {
        _finalizeThrough(4);
        (uint256 arb, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        uint256 half = arb / 2;
        remit.remitRewardBudget{value: 0.01 ether}(CHAIN_ARB, _days(1), half);
        remit.remitRewardBudget{value: 0.01 ether}(CHAIN_OP, _days(1), 1);
        uint256 opHeld = rlens.getRemitDayFreshReserved() - (arb - half);
        assertGt(opHeld, 0, "fixture: Optimism's day holds too");
        uint256 roomBefore = ilens.getInteractionPoolRemaining();

        _warpToDay(4);
        vm.expectEmit(true, false, false, true, address(diamond));
        emit RemitDestinationRemoved(CHAIN_ARB, 5, 0);
        vm.expectEmit(true, true, false, true, address(diamond));
        emit RemitAbandonedDayReleased(CHAIN_ARB, 1, true, arb - half, 0, 0);
        agg.setExpectedSourceChainIds(_listNoArb());

        assertEq(rlens.getRemitDayFreshReserved(), opHeld, "only Arbitrum's hold is freed");
        assertEq(ilens.getInteractionPoolRemaining(), roomBefore + (arb - half), "the pool gets it back");
        assertEq(rlens.getRewardBudgetRemittedGlobal(), half + 1, "what was sent stays charged");
        LibVaipakam.RemitDayLedger memory l = rlens.getRemitDayLedger(CHAIN_ARB, 1);
        assertEq(l.freshUncovered, arb - half, "the ledger reads as holding nothing");
        (uint256 bound, uint256 cursor) = _release();
        assertEq(bound, 5, "today included");
        assertEq(cursor, 4, "walked to the first unfinalized day");

        assertEq(rlens.getRemitOpenDays(CHAIN_ARB).length, 0, "#2960: an abandoned day is no longer owed a part");
        assertEq(rlens.getRemitOpenDays(CHAIN_OP).length, 1, "#2960: Optimism's partly sent day stays listed");
        assertEq(uint8(_status(CHAIN_ARB, 1)), uint8(LibRemitDayLedger.RemitDayStatus.Abandoned), "abandoned");
        assertEq(uint8(_status(CHAIN_OP, 1)), uint8(LibRemitDayLedger.RemitDayStatus.Closeable), "Optimism unchanged");
        vm.expectRevert();
        remit.remitRewardBudget{value: 0.01 ether}(CHAIN_ARB, _days(1), CAP);
    }

    /// An armed day sent in part holds its unsent fresh (its commitment became
    /// the hold at the first part) and the unsent rest of its recycled
    /// commitment. Removal frees both; the clamp residual the first part
    /// already retired is not freed twice.
    function test_Removal_FreesAnArmedPartlySentDaysRest() public {
        _finalizeThrough(2);
        _armArbDay(1, 100e18, 20e18, 1e30);
        (uint256 whole, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        remit.remitRewardBudget{value: 0.01 ether}(CHAIN_ARB, _days(1), 10e18);
        LibVaipakam.RemitDayLedger memory l = rlens.getRemitDayLedger(CHAIN_ARB, 1);
        assertTrue(l.armed && l.locked, "fixture: an armed locked day");
        assertEq(uint256(l.wholeFresh) + l.wholeRecycled, whole, "fixture: whole");
        assertGt(l.wholeRecycled, 0, "fixture: a recycled leg");
        assertGt(l.residualRemitId, 0, "fixture: the residual is retired by the first part");
        uint256 heldFresh = uint256(l.wholeFresh) - l.sentFresh;
        uint256 restRecycled = uint256(l.wholeRecycled) - l.sentRecycled;
        (uint256 f0, uint256 r0) = _outstanding();

        _warpToDay(4);
        vm.expectEmit(true, true, false, true, address(diamond));
        emit RemitAbandonedDayReleased(CHAIN_ARB, 1, true, heldFresh, 0, restRecycled);
        agg.setExpectedSourceChainIds(_listNoArb());

        assertEq(rlens.getRemitDayFreshReserved(), 0, "the hold is freed");
        (uint256 f1, uint256 r1) = _outstanding();
        assertEq(f1, f0, "no fresh commitment stood for a locked day");
        assertEq(r0 - r1, restRecycled, "the unsent recycled commitment is freed");
    }

    // ─── unlocked days ────────────────────────────────────────────────────

    /// An armed day no part of which went holds the commitments finalization
    /// booked toward the chain: exactly what a whole send would retire.
    function test_Removal_FreesAnArmedUnsentDaysCommitments() public {
        _finalizeThrough(2);
        _armArbDay(1, 100e18, 20e18, 1e30);
        (uint256 whole, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        (uint256 f0, uint256 r0) = _outstanding();

        _warpToDay(4);
        vm.recordLogs();
        agg.setExpectedSourceChainIds(_listNoArb());
        (bool seen, bool locked, uint256 held, uint256 cf, uint256 cr) = _abandonedLog(1);
        assertTrue(seen, "the day's figures are named");
        assertFalse(locked, "no part went");
        assertEq(held, 0, "an unlocked day holds nothing in the pool hold");
        assertGt(cf, 0, "a fresh commitment");
        assertGt(cr, 0, "a recycled commitment");
        assertEq(cf + cr, whole, "exactly what a whole send would retire (unclamped)");
        (uint256 f1, uint256 r1) = _outstanding();
        assertEq(f0 - f1, cf, "fresh commitment freed");
        assertEq(r0 - r1, cr, "recycled commitment freed");
    }

    /// An unarmed day no part of which went holds nothing: no event, no
    /// change, and the day is still abandoned.
    function test_Removal_AnUnarmedUnsentDayHoldsNothing() public {
        _finalizeThrough(4);
        mutator.setOutstandingCommitRaw(7, 9);
        uint256 room = ilens.getInteractionPoolRemaining();

        _warpToDay(4);
        vm.recordLogs();
        agg.setExpectedSourceChainIds(_listNoArb());
        (bool seen, , , , ) = _abandonedLog(1);
        assertFalse(seen, "nothing to name");
        (uint256 f, uint256 r) = _outstanding();
        assertEq(f, 7, "fresh commitments untouched");
        assertEq(r, 9, "recycled commitments untouched");
        assertEq(ilens.getInteractionPoolRemaining(), room, "pool untouched");
        assertEq(uint8(_status(CHAIN_ARB, 1)), uint8(LibRemitDayLedger.RemitDayStatus.Abandoned), "abandoned");
    }

    /// A day already whole holds nothing and is reported as settled, not as
    /// abandoned.
    function test_Removal_AWholeDayStaysRemitted() public {
        _finalizeThrough(4);
        remit.remitRewardBudget{value: 0.01 ether}(CHAIN_ARB, _days(1), CAP);
        _warpToDay(4);
        agg.setExpectedSourceChainIds(_listNoArb());
        assertEq(uint8(_status(CHAIN_ARB, 1)), uint8(LibRemitDayLedger.RemitDayStatus.Remitted), "settled");
    }

    // ─── a part released around the walk ──────────────────────────────────

    /// A reservation still pending on a day the walk has passed (here the
    /// day's whole went in one part, so the walk found it settled): its later
    /// release re-opens the day, but restores none of the recycled commitment
    /// the send retired (the day is never sent again, so nothing would ever
    /// retire it), and re-creates no hold.
    function test_Release_AfterTheWalk_RestoresNoCommitment() public {
        _finalizeThrough(2);
        _armArbDay(1, 100e18, 20e18, 1e30);
        remit.remitRewardBudget{value: 0.01 ether}(CHAIN_ARB, _days(1), CAP / 2);
        LibVaipakam.RemitReservation memory r = rlens.getRemitReservation(1);
        assertGt(r.recycled, 0, "fixture: the part moved recycled");

        _warpToDay(4);
        agg.setExpectedSourceChainIds(_listNoArb());
        (uint256 f0, uint256 r0) = _outstanding();
        uint256 reserved0 = rlens.getRemitDayFreshReserved();
        uint256 room0 = ilens.getInteractionPoolRemaining();

        vm.warp(block.timestamp + 7 days);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit RemitAbandonedPartReleased(CHAIN_ARB, 1, 1, r.recycledFull);
        comp.releaseRemitReservation(1);

        (uint256 f1, uint256 r1) = _outstanding();
        assertEq(f1, f0, "no fresh commitment restored");
        assertEq(r1, r0, "no recycled commitment restored");
        assertEq(rlens.getRemitDayFreshReserved(), reserved0, "no hold re-created");
        assertEq(ilens.getInteractionPoolRemaining(), room0, "pool room unchanged");
        assertEq(uint8(_status(CHAIN_ARB, 1)), uint8(LibRemitDayLedger.RemitDayStatus.Abandoned), "still abandoned");
    }

    /// A part released BEFORE the walk reaches its day restores as usual, and
    /// the walk then frees what was restored with the rest. Day 2 is left
    /// unfinalized so the removal's walk stops there and day 3 waits.
    function test_Release_BeforeTheWalk_IsCountedByTheWalk() public {
        _finalizeDay(0);
        _finalizeDay(1);
        _finalizeDay(3);
        _armArbDay(3, 100e18, 20e18, 1e30);
        (uint256 whole, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(3));
        (uint256 fBase, uint256 rBase) = _outstanding();
        remit.remitRewardBudget{value: 0.01 ether}(CHAIN_ARB, _days(3), CAP / 2);

        _warpToDay(4);
        agg.setExpectedSourceChainIds(_listNoArb());
        (, uint256 cursor) = _release();
        assertEq(cursor, 2, "the walk stops at the unfinalized day");

        vm.warp(block.timestamp + 7 days);
        comp.releaseRemitReservation(1);

        agg.forceFinalizeDay(2);
        agg.forceFinalizeDay(4);
        dest.continueRemitDestinationRelease(CHAIN_ARB, 10);
        (, cursor) = _release();
        assertEq(cursor, 5, "done");

        (uint256 f1, uint256 r1) = _outstanding();
        // The fresh commitment became the day's hold at its first part, and
        // the hold is gone; the recycled one (sent part restored, rest never
        // retired) is freed by the walk. Net: the whole armed commitment.
        LibVaipakam.RemitDayLedger memory l = rlens.getRemitDayLedger(CHAIN_ARB, 3);
        assertEq(fBase - f1, l.armedWholeFresh, "fresh: the whole commitment, once");
        assertEq(rBase - r1, l.armedWholeRecycled, "recycled: the whole commitment, once");
        assertEq(uint256(l.armedWholeFresh) + l.armedWholeRecycled, whole, "fixture: unclamped");
        assertEq(rlens.getRemitDayFreshReserved(), 0, "no hold left");
    }

    // ─── re-list, continuation, other paths ───────────────────────────────

    /// The chain cannot be listed again while a day before its bound is
    /// unwalked; once the release is done it can, its abandoned days stay
    /// abandoned, and a day after the bound is paid as usual.
    function test_Relist_WaitsForTheReleaseThenPaysLaterDaysOnly() public {
        _finalizeThrough(4);
        _warpToDay(4);
        agg.setExpectedSourceChainIds(_listNoArb());

        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.RemitDestinationReleasePending.selector, CHAIN_ARB, 4, 5)
        );
        agg.setExpectedSourceChainIds(_list3());

        agg.forceFinalizeDay(4);
        vm.prank(stranger);
        (uint256 cursor, uint256 bound) = dest.continueRemitDestinationRelease(CHAIN_ARB, 10);
        assertEq(cursor, bound, "done, by anyone");
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.RemitDestinationReleaseDone.selector, CHAIN_ARB));
        dest.continueRemitDestinationRelease(CHAIN_ARB, 10);

        agg.setExpectedSourceChainIds(_list3());
        assertEq(uint8(_status(CHAIN_ARB, 1)), uint8(LibRemitDayLedger.RemitDayStatus.Abandoned), "stays abandoned");
        _finalizeDay(5);
        assertEq(uint8(_status(CHAIN_ARB, 5)), uint8(LibRemitDayLedger.RemitDayStatus.Closeable), "a later day is paid");
    }

    /// The continuation walks at most the days it is asked to.
    function test_Continue_WalksAtMostMaxDays() public {
        _finalizeDay(0);
        _warpToDay(4);
        agg.setExpectedSourceChainIds(_listNoArb());
        (, uint256 cursor) = _release();
        assertEq(cursor, 1, "stopped at day 1");
        agg.forceFinalizeDay(1);
        agg.forceFinalizeDay(2);
        dest.continueRemitDestinationRelease(CHAIN_ARB, 1);
        (, cursor) = _release();
        assertEq(cursor, 2, "one day");
    }

    /// The compensation path refuses an abandoned day too.
    function test_Manual_RefusesAnAbandonedDay() public {
        _finalizeThrough(4);
        mutator.setChainDayRemitIneligibleRaw(2, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 2, 3e18, 2e18);
        _warpToDay(4);
        agg.setExpectedSourceChainIds(_listNoArb());
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.RemitDayAbandoned.selector, 2, CHAIN_ARB));
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 2, 2e18, 2e18);
    }

    /// A top-up of a compensation the mirror acknowledged before the removal
    /// is refused too, though the day's closure and funded record survive
    /// the removal: every compensation send is refused at the one sender of
    /// that wire.
    function test_Supplemental_RefusesAnAbandonedDay() public {
        _finalizeThrough(4);
        mutator.setChainDayRemitIneligibleRaw(2, CHAIN_ARB, true);
        rewardMessenger.deliverCompQuote(CHAIN_ARB, 2, 3e18, 2e18);
        comp.remitManualBudget{value: 0.01 ether}(CHAIN_ARB, 2, 2e18, 1e18);
        rewardMessenger.deliverRemitAck(CHAIN_ARB, 1, 3e18);
        _warpToDay(4);
        agg.setExpectedSourceChainIds(_listNoArb());
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.RemitDayAbandoned.selector, 2, CHAIN_ARB));
        comp.remitSupplementalBudget{value: 0.01 ether}(CHAIN_ARB, 2, 1e18, 1e18);
    }

    /// The list-change hook is a Diamond self-call only.
    function test_Hook_IsDiamondInternal() public {
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.RemitDestinationOnlyDiamondInternal.selector, address(this))
        );
        dest.onExpectedSourceListChange(_listNoArb());
    }

    /// A list change that drops nobody abandons nothing.
    function test_Relist_SameListAbandonsNothing() public {
        _finalizeThrough(4);
        _warpToDay(4);
        agg.setExpectedSourceChainIds(_list3());
        (uint256 bound, uint256 cursor) = _release();
        assertEq(bound, 0, "no bound");
        assertEq(cursor, 0, "no walk");
        assertEq(uint8(_status(CHAIN_ARB, 1)), uint8(LibRemitDayLedger.RemitDayStatus.Closeable), "still owed");
    }

    /// The test contract is the remitter: a send refunds its fee surplus here.
    receive() external payable {}

    // ─── log reading ──────────────────────────────────────────────────────

    function _abandonedLog(uint256 day)
        internal
        returns (bool seen, bool locked, uint256 held, uint256 cf, uint256 cr)
    {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = RemitAbandonedDayReleased.selector;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(diamond) && logs[i].topics[0] == sig
                    && uint256(logs[i].topics[1]) == CHAIN_ARB && uint256(logs[i].topics[2]) == day
            ) {
                (locked, held, cf, cr) = abi.decode(logs[i].data, (bool, uint256, uint256, uint256));
                return (true, locked, held, cf, cr);
            }
        }
    }
}
