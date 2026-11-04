// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {RewardEpochFacet} from "../src/facets/RewardEpochFacet.sol";
import {RewardIngressFacet} from "../src/facets/RewardIngressFacet.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardReconciliationFacet} from "../src/facets/RewardReconciliationFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {LibD8Delivery} from "./helpers/LibD8Delivery.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";

/**
 * @title RewardTransportEpochTest
 * @notice #1566 transport epochs PR 3b — the EPOCH LEDGER'S LIFECYCLE, on the
 *         d8 wire: what a delivery's epoch holds is parked only once the one
 *         day it funds is proven closed, it becomes classifiable only once
 *         the parked remainder is
 *         ACKNOWLEDGED, a classification debits that remainder and is bounded
 *         by it, the reads refuse an id nothing opened, and a day's index is
 *         arrival-ordered.
 *
 *         Admission and the ingress-time index themselves are
 *         `RewardTransportD8Test`'s subject. This suite drove the flat-list,
 *         then the rooted (d6/d7) wire before #2828; their admission, paged
 *         and chunked indexes are gone, and the lifecycle below is the part of
 *         it that never depended on the wire.
 *
 *         Every rule is pinned on BOTH sides: the same fixture is driven
 *         through the side the rule refuses and the side it admits, so a
 *         vacuous guard cannot pass.
 */
contract RewardTransportEpochTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    address internal constant REMITTER = address(0xBA5E);
    uint256 internal constant SEED = 1_000_000 ether;

    function setUp() public {
        setupHelper();
        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(VPFIToken.initialize, (address(this), address(this), address(this)))
        );
        vpfi = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
        AdminFacet(address(diamond)).setTreasury(makeAddr("treasury"));
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(block.timestamp);
        vm.warp(block.timestamp + 5 days);
        uint256 have = vpfi.balanceOf(address(this));
        if (SEED > have) vpfi.mint(address(this), SEED - have);
        vpfi.transfer(address(diamond), SEED);
        vm.chainId(CHAIN_ARB);
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(false);
        RewardReporterFacet(address(diamond)).setBaseChainId(CHAIN_BASE);
        RewardRemittanceFacet(address(diamond)).setRewardRemittanceReceiver(address(this));
        // An epoch is opened only on an ACTIVATED deployment;
        // `RewardTransportD6PreActivationTest` drives the other side.
        activateRewardCustodyForTest(address(vpfi), 0);
    }

    // ─── fixture ─────────────────────────────────────────────────────────────

    function _epoch() internal view returns (RewardEpochFacet) {
        return RewardEpochFacet(address(diamond));
    }
    function _ingress() internal view returns (RewardIngressFacet) {
        return RewardIngressFacet(address(diamond));
    }
    function _recon() internal view returns (RewardReconciliationFacet) {
        return RewardReconciliationFacet(address(diamond));
    }
    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }
    function _lens() internal view returns (RewardRemittanceLensFacet) {
        return RewardRemittanceLensFacet(address(diamond));
    }

    /// @dev A whole-fresh delivery on the d8 wire for day `dayId`. Its epoch
    ///      is opened and indexed into the day at ingress.
    function _deliver(uint256 amount, uint256 dayId, uint256 remitId, bytes32 id) internal returns (bytes32 h) {
        return LibD8Delivery.deliverFresh(
            address(diamond), address(vpfi), amount, dayId, CHAIN_BASE, remitId, REMITTER, id
        );
    }

    /// @dev A delivery for day 1, the state most tests here start from.
    function _landed(uint256 amount, uint256 remitId, bytes32 id) internal returns (bytes32 h) {
        return _deliver(amount, 1, remitId, id);
    }

    // ─── 1. the release ──────────────────────────────────────────────────────

    /// The gate, straddled: a delivery's packet is refused a classification
    /// while its epoch stands, still refused when the remainder is merely
    /// PARKED, and admitted only once the acknowledgment is recorded.
    function test_Classification_IsRefusedUntilTheEpochIsReleased() public {
        bytes32 h = _landed(10e18, 7, keccak256("g1"));

        AdminFacet(address(diamond)).pause();
        vm.expectRevert(abi.encodeWithSelector(TransportBatchNotReleased.selector, h, h));
        _recon().classifyLegacyPacket(h, 0, 4e18, keccak256("e1"));
        AdminFacet(address(diamond)).unpause();

        // Parking alone is NOT the release: an operator must not be able to
        // make a packet classifiable merely by draining its batch.
        _mut().parkTransportBatchRaw(h);
        AdminFacet(address(diamond)).pause();
        vm.expectRevert(abi.encodeWithSelector(TransportBatchNotReleased.selector, h, h));
        _recon().classifyLegacyPacket(h, 0, 4e18, keccak256("e1"));
        AdminFacet(address(diamond)).unpause();

        _mut().acknowledgeTransportBatchRaw(h);
        AdminFacet(address(diamond)).pause();
        _recon().classifyLegacyPacket(h, 0, 4e18, keccak256("e1"));
        AdminFacet(address(diamond)).unpause();

        ( , , , , bool released) = _epoch().getTransportBatch(h);
        assertTrue(released, "the acknowledgment released it");
    }

    /// Parking moves the WHOLE balance and keeps it membership-bound: the
    /// batch conserves (`admitted == balance + parked`) and the remainder
    /// carries the one day the delivery funds.
    function test_Park_MovesTheWholeBalance_AndKeepsItMembershipBound() public {
        bytes32 h = _landed(9e18, 9, keccak256("p1"));

        assertEq(_mut().parkTransportBatchRaw(h), 9e18, "parked what the obligations left");

        (, uint256 balance, uint256 admitted, uint256 batchDay, ) = _epoch().getTransportBatch(h);
        (bool parked, uint256 amount, uint256 dayId, bool acknowledged, uint256 debited) =
            _epoch().getTransportRemainder(h);
        assertTrue(parked, "parked");
        assertEq(debited, 0, "nothing has been classified out of it yet");
        assertEq(balance, 0, "the epoch holds nothing now");
        assertEq(admitted, balance + amount, "and the batch conserves");
        assertEq(amount, 9e18, "the remainder is the whole balance");
        assertEq(dayId, 1, "bound by the delivery's own day");
        assertEq(batchDay, 1, "the day the batch was opened for");
        assertFalse(acknowledged, "parking is not the acknowledgment");
    }

    /// Each half of the release happens exactly once, and neither can stand in
    /// for the other.
    function test_Release_EachHalfHappensOnce_AndNeitherSubstitutes() public {
        bytes32 h = _landed(6e18, 11, keccak256("r1"));

        vm.expectRevert(abi.encodeWithSelector(TransportRemainderNotParked.selector, h));
        _mut().acknowledgeTransportBatchRaw(h);

        _mut().parkTransportBatchRaw(h);
        vm.expectRevert(abi.encodeWithSelector(TransportRemainderAlreadyParked.selector, h));
        _mut().parkTransportBatchRaw(h);

        _mut().acknowledgeTransportBatchRaw(h);
        vm.expectRevert(abi.encodeWithSelector(TransportRemainderAlreadyAcknowledged.selector, h));
        _mut().acknowledgeTransportBatchRaw(h);
    }


    /// A classification DEBITS the parked remainder by what it takes, and
    /// cannot take more than the entry still holds. Without the debit the entry
    /// would keep reporting its parked figure while the value had already left,
    /// so the restore and disposition machinery 3b-ii adds would treat
    /// already-classified value as still parked.
    function test_Classification_DebitsTheParkedRemainder_AndIsBoundedByIt() public {
        bytes32 h = _landed(10e18, 40, keccak256("dbt"));
        _mut().parkTransportBatchRaw(h);
        _mut().acknowledgeTransportBatchRaw(h);
        (, uint256 parked, , , ) = _epoch().getTransportRemainder(h);
        assertEq(parked, 10e18, "the whole balance is parked");

        AdminFacet(address(diamond)).pause();
        _recon().classifyLegacyPacket(h, 0, 4e18, keccak256("d1"));
        AdminFacet(address(diamond)).unpause();
        (, parked, , , ) = _epoch().getTransportRemainder(h);
        assertEq(parked, 6e18, "stepped down by what the classification took");

        // And the entry is a CEILING: past it the classification is refused by
        // name rather than silently flooring.
        AdminFacet(address(diamond)).pause();
        vm.expectRevert(
            abi.encodeWithSelector(TransportRemainderExceeded.selector, h, 7e18, 6e18)
        );
        _recon().classifyLegacyPacket(h, 0, 7e18, keccak256("d2"));
        // Exactly what is left still lands, so the refusal was the bound and
        // not the batch.
        _recon().classifyLegacyPacket(h, 0, 6e18, keccak256("d3"));
        AdminFacet(address(diamond)).unpause();
        (, parked, , , ) = _epoch().getTransportRemainder(h);
        assertEq(parked, 0, "the entry is emptied exactly");
    }

    /// 3b-ii-B — the RELEASE IS A GATE, not a shut door (3b-i shipped both
    /// entries refusing everyone because the rule could not be checked). The
    /// park is open to anyone and refuses BY NAME while its day is not
    /// proven closed — the same answer for the administrator and a stranger —
    /// and the acknowledgment is the administrator's disposition: a stranger
    /// is refused by role, the administrator by state while nothing is parked.
    /// The library machinery stays reachable through the test-only raw entry,
    /// which is how every lifecycle test above still runs.
    function test_Release_IsGatedOnClosedDays_NotShut() public {
        bytes32 h = _landed(6e18, 12, keccak256("shut"));
        address stranger = makeAddr("stranger");
        address[2] memory callers = [address(this), stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(TransportDayNotClosed.selector, h, 1));
            _epoch().parkTransportBatchRemainder(h);
        }
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(LibAccessControl.AccessControlUnauthorizedAccount.selector, stranger, LibAccessControl.ADMIN_ROLE)
        );
        _epoch().acknowledgeTransportBatchRemainder(h);
        vm.expectRevert(abi.encodeWithSelector(TransportRemainderNotParked.selector, h));
        _epoch().acknowledgeTransportBatchRemainder(h);
        // An id no delivery opened is refused by name.
        bytes32 nobody = keccak256("nobody");
        vm.expectRevert(abi.encodeWithSelector(TransportBatchUnknown.selector, nobody));
        _epoch().parkTransportBatchRemainder(nobody);
        // Nothing released: the gate holds until its day is proven closed.
        ( , , , , bool released) = _epoch().getTransportBatch(h);
        assertFalse(released, "no production path releases a batch whose day is open");
        // The machinery exists — the raw entry proves it, and every lifecycle
        // test in this suite runs through it.
        assertEq(_mut().releaseTransportBatchRaw(h), 6e18, "the library release works behind the gate");
    }

    /// The library's own refusals, unchanged and reached raw: an unknown id is
    /// refused by name, and an acknowledgment needs a park.
    function test_Release_LibraryRefusesAnUnknownBatch() public {
        bytes32 nobody = keccak256("nobody");
        vm.expectRevert(abi.encodeWithSelector(TransportBatchUnknown.selector, nobody));
        _mut().parkTransportBatchRaw(nobody);
        vm.expectRevert(abi.encodeWithSelector(TransportRemainderNotParked.selector, nobody));
        _mut().acknowledgeTransportBatchRaw(nobody);
    }

    // ─── 3. the evidence seams ───────────────────────────────────────────────

    /// The transport LEG counters ship with the ledger and read zero: no draw
    /// exists until PR 3b-ii writes one. Asserted so the day they stop being
    /// zero is a deliberate change with a failing test behind it, rather than
    /// a silent one.
    function test_Legs_ReadZeroUntilTheDrawsLand() public {
        bytes32 h = _landed(10e18, 12, keccak256("l1"));
        (uint256 consumedFresh, uint256 consumedRecycled) = _epoch().getTransportBatchLegs(h);
        assertEq(consumedFresh, 0, "no fresh leg has been drawn");
        assertEq(consumedRecycled, 0, "nor a recycled one");

        _mut().parkTransportBatchRaw(h);
        _mut().acknowledgeTransportBatchRaw(h);
        (consumedFresh, consumedRecycled) = _epoch().getTransportBatchLegs(h);
        assertEq(consumedFresh, 0, "and releasing draws nothing either");
        assertEq(consumedRecycled, 0, "on either leg");
    }

    // ─── 4. the reads ────────────────────────────────────────────────────────

    /// Codex #2232 r15 — the two DETAIL reads refuse an id the ledger never
    /// opened, and the straddle is the whole test: a known batch that has
    /// drawn nothing and parked nothing answers with zeros, and an unknown id
    /// used to answer with the SAME zeros. Those figures are half of the
    /// evidence a classification's bound is read from, so a typo returning
    /// them as substantiated no-consumption is an unstated unknown about
    /// funds. Both now refuse by the same name the write paths use.
    function test_Reads_RefuseAnUnknownBatch_ButAnswerZeroForAKnownOne() public {
        bytes32 h = _landed(10e18, 77, keccak256("r15"));
        bytes32 nobody = keccak256("no delivery opened this");

        // The known batch: zeros, and they are an ANSWER.
        (uint256 consumedFresh, uint256 consumedRecycled) = _epoch().getTransportBatchLegs(h);
        assertEq(consumedFresh + consumedRecycled, 0, "a known batch has drawn nothing yet");
        (bool isParked, uint256 parked, , bool acknowledged, uint256 debited) = _epoch().getTransportRemainder(h);
        assertFalse(isParked, "a known batch reads as not yet parked");
        assertEq(parked, 0, "and has parked nothing yet");
        assertEq(debited, 0, "with nothing taken out of a remainder that does not exist");
        assertFalse(acknowledged, "and no acknowledgment");

        // The unknown id: the same zeros are no longer offered as figures.
        vm.expectRevert(abi.encodeWithSelector(TransportBatchUnknown.selector, nobody));
        _epoch().getTransportBatchLegs(nobody);
        vm.expectRevert(abi.encodeWithSelector(TransportBatchUnknown.selector, nobody));
        _epoch().getTransportRemainder(nobody);
    }

    /// The EXISTENCE ORACLE stays answerable on an id nothing opened — it is
    /// how a caller asks the question the two reads above refuse on, so a
    /// reader holding an id of unknown provenance is never left without a
    /// non-reverting way to find out. Pinned because making this one refuse
    /// too would be the obvious "consistency" change and would close the only
    /// door out.
    function test_Reads_TheExistenceOracleStillAnswersForAnUnknownBatch() public {
        bytes32 nobody = keccak256("no delivery opened this either");
        (bytes32 packetHash, uint256 balance, uint256 admitted, , bool released) =
            _epoch().getTransportBatch(nobody);
        assertEq(packetHash, bytes32(0), "the zero stamp IS the answer 'no batch here'");
        assertEq(balance, 0, "and nothing is claimed about a batch that does not exist");
        assertEq(admitted, 0, "nor about what it was admitted with");
        assertFalse(released, "nor about its release");
    }

    /// The day index paginates and reports its cursor, because any number of
    /// deliveries can list one day — a view returning
    /// the whole index would stop being callable on exactly the days that
    /// matter most.
    function test_DayIndex_Paginates() public {
        for (uint256 i; i < 5; ++i) {
            _landed(1e18, 20 + i, keccak256(abi.encode("d", i)));
        }
        (bytes32[] memory page, , uint256 total, uint256 cursor) = _epoch().getTransportDayBatches(1, 0, 2);
        assertEq(total, 5, "every batch this day ever listed");
        assertEq(page.length, 2, "one window");
        assertEq(cursor, 0, "nothing consumed");

        (bytes32[] memory tail, , , ) = _epoch().getTransportDayBatches(1, 4, 10);
        assertEq(tail.length, 1, "a window clamped to the end");

        (bytes32[] memory past, , uint256 pastTotal, ) = _epoch().getTransportDayBatches(1, 9, 10);
        assertEq(past.length, 0, "an offset past the end is empty, not a revert");
        assertEq(pastTotal, 5, "and still reports the total");

        // The index holds every member, and the ORDER it is read by comes back
        // with it. `test_DayIndex_OrdersByArrival` drives arrivals apart.
        (bytes32[] memory all, uint64[] memory arrivals, , ) =
            _epoch().getTransportDayBatches(1, 0, 10);
        assertEq(all.length, 5, "every member comes back");
        assertEq(arrivals.length, 5, "each with its ordering key");
        for (uint256 i; i < 5; ++i) {
            assertEq(arrivals[i], uint64(block.timestamp), "the delivery's own recorded arrival");
        }
    }

    /// A day's index is ARRIVAL-ORDERED BY CONSTRUCTION (3b-ii-A, Codex #2276
    /// r5 P1): the draws read the index through a bounded WINDOW, a window is a
    /// prefix of the index, and a prefix of an index ordered any other way
    /// would be someone's choice of what a day may draw from. Since #2828 the
    /// epoch is linked into its day at its own ingress, so there is no later
    /// indexer whose timing could disturb the order; a delivery that lands
    /// later in time sits later in the index.
    function test_DayIndex_OrdersByArrival() public {
        bytes32 a = _deliver(4e18, 1, 41, keccak256("aEarly"));
        vm.warp(block.timestamp + 100);
        bytes32 b = _deliver(5e18, 1, 42, keccak256("bLate"));

        (bytes32[] memory page, uint64[] memory arrivals, uint256 total, ) =
            _epoch().getTransportDayBatches(1, 0, 10);
        assertEq(total, 2, "both fund the day");
        assertEq(page[0], a, "position 0 is the EARLIER arrival");
        assertEq(page[1], b, "and position 1 the later one");
        assertTrue(arrivals[0] < arrivals[1], "so the array's order and the arrival order agree, by construction");
    }

    // ─── 5. the fourth door, and why it cannot reach an epoch ────────────────

    /// The R4 repatriation steps a packet's `unclassified` down OUTSIDE the
    /// epoch gate — `releaseUnclassifiedForReturn` reduces the packet and
    /// books the exit as `disposed` without consulting any batch. So if ONE
    /// packet could ever hold both a transport epoch and a stranded record,
    /// a return would leave the epoch anchored over value that has gone
    /// home: `admitted` would outrun what the packet still holds, the
    /// remainder could never be debited down, and in 3b-ii a listed day
    /// would draw against a balance that is not there.
    ///
    /// It cannot, and this pins WHY. A stranded record binds to a packet only
    /// through `unclassifiedQuarantine`, whose two call sites both pass a
    /// COMPENSATION packet's stamp; and a compensation never holds an epoch,
    /// because only the budget ingress opens one, at the packet's own
    /// landing. Nothing in the epoch ledger declares that dependency, so an
    /// ingress change that opened an epoch over a compensation would open
    /// this door silently — which is what this test is for.
    function test_FourthDoor_CannotReachAPacketHoldingAnEpoch() public {
        uint256 dayId = 3;
        // A compensation whose remitter is not the day's era quarantines
        // (reason 2) — the route that attaches a stranded record to a packet
        // on an activated deployment, and so arms the fourth door on it.
        _mut().setDayClockEraRaw(dayId, address(0xE2A));
        _mut().setBroadcastV2AppliedRaw(dayId, true);
        bytes32 compId = keccak256("comp-fourth-door");
        _ingress().onCompensationBudgetReceived(
            address(vpfi), 6e18, dayId, CHAIN_BASE, 900, REMITTER, 3e18, 3e18,
            0, 1, uint64(7 days), uint64(24 hours), compId
        );
        bytes32 comp = keccak256(abi.encode(uint256(CHAIN_BASE), compId));

        // The door is armed on THIS packet: the record names it, and the
        // holder backs value a return can draw straight out of its row.
        LibVaipakam.StrandedRecovery memory sr = _lens().getStrandedRecovery(REMITTER, 900);
        assertEq(sr.packetHash, comp, "the stranded record names the compensation packet");
        assertEq(sr.held, 6e18, "and the holder backs what a return would draw");

        // And no epoch is ever opened over it: the compensation ingress opens
        // none, and the budget ingress — the only entry that opens one —
        // does so at a packet's own landing, never later.
        assertEq(_lens().getIngressPacket(comp).batchId, bytes32(0), "the compensation packet holds no epoch");
        (bytes32 stamp, , , , ) = _epoch().getTransportBatch(comp);
        assertEq(stamp, bytes32(0), "and the ledger has none under its stamp");

        // Its record's SHAPE, pinned rather than left to this fixture's
        // numbers: the compensation ingress states the whole amount as the
        // fresh component and stamps its one day.
        LibVaipakam.IngressPacket memory p = _lens().getIngressPacket(comp);
        // Pinned non-vacuously: two zeros would satisfy the equality below and
        // would ALSO be what an empty record reads as.
        assertEq(p.actualReceived, 6e18, "the whole delivery is on the record");
        assertEq(p.freshShare, p.actualReceived, "a compensation is recorded WIRE-TYPED, whole");
        assertTrue(p.dayNamed, "it carries its day, which opens nothing");
        assertEq(p.dayId, dayId, "the day it names");

        // The other side of the pair: a BUDGET delivery DOES open an epoch, and nothing is bound to it under its own receipt, so the door
        // is shut on the one packet that holds an anchor.
        bytes32 h = _landed(10e18, 901, keccak256("fourth-door-budget"));
        assertEq(_lens().getIngressPacket(h).batchId, h, "the budget packet holds its epoch");
        LibVaipakam.StrandedRecovery memory none = _lens().getStrandedRecovery(REMITTER, 901);
        assertEq(none.packetHash, bytes32(0), "and no stranded record names it");
        assertEq(none.held, 0, "with nothing for a return to draw from it");
    }
}
