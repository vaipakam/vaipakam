// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {RewardEpochFacet} from "../src/facets/RewardEpochFacet.sol";
import {RewardEpochViewFacet} from "../src/facets/RewardEpochViewFacet.sol";
import {RewardIngressFacet} from "../src/facets/RewardIngressFacet.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardCommitmentFacet} from "../src/facets/RewardCommitmentFacet.sol";
import {RewardReconciliationFacet} from "../src/facets/RewardReconciliationFacet.sol";
import {RewardEraFacet} from "../src/facets/RewardEraFacet.sol";
import {RewardHorizonSweepFacet} from "../src/facets/RewardHorizonSweepFacet.sol";
import {RewardStagingDomainFacet} from "../src/facets/RewardStagingDomainFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibRewardCustody} from "../src/libraries/LibRewardCustody.sol";
import {LibInteractionRewards} from "../src/libraries/LibInteractionRewards.sol";
import {RemitWire} from "../src/crosschain/RemitWire.sol";
import {RewardBroadcastV2} from "../src/interfaces/IRewardMessenger.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {MerkleFixture} from "./mocks/MerkleFixture.sol";

/**
 * @title  RewardDayDeliveryGateBase -- #1944 consequence 1, the mirror-side
 *         DAY-DELIVERY GATE: the shared fixture.
 * @notice A mirror prices a day from the stamp Base's broadcast carries, and
 *         Base funds that day with a SEPARATE remittance; the two land in
 *         either order. Before the gate, a day whose stamp arrived first was
 *         priced against the FUNGIBLE delivered bound and paid out of another
 *         day's delivery. With the gate armed, a day priced to owe FRESH value
 *         here waits -- the fold halts before it, every settlement defers by
 *         name, no value moves -- until a budget packet PROVEN to list it has
 *         landed: an indexed transport epoch, or a batchless packet whose day
 *         list was proven by `proveDeliveryDayList` / `proveDeliveryDayChunk`.
 * @dev    The fixture is the epoch-draw suites' mirror (Arbitrum chain id,
 *         Base as the reward chain, this contract as the remittance receiver).
 *         Days are stamped by REAL V2 broadcasts through
 *         {MockRewardMessenger.deliverBroadcastV2} and closed locally (the
 *         chain's interest totals and `chainReportSentAt`) BEFORE the
 *         broadcast -- the order the production cycle runs in, close then
 *         report then finalize then broadcast. The gate is armed per cell and
 *         never in `setUp`: the setter is one-shot, and three cells exercise it
 *         dark or refused. Abstract, so no cell runs twice; the two concrete
 *         suites below differ only in whether reward custody is ACTIVATED.
 */
abstract contract RewardDayDeliveryGateBase is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    MockRewardMessenger internal messenger;
    address internal alice;

    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    address internal constant REMITTER = address(0xBA5E);
    /// @dev Holds the local interest total a day CLOSES on, so a claimant's own
    ///      per-day window counters stay exactly what each cell writes.
    address internal constant CLOSER = address(0xC105E);
    uint256 internal constant SEED = 1_000_000 ether;
    uint64 internal constant LOAN = 77;
    uint64 internal constant LEGACY_LOAN = 42;
    /// @dev The claimant's need on an armed fixture day: the per-user ceiling
    ///      binds below the day's 1e18 fresh half.
    uint256 internal constant NEED = 0.4e18;
    uint256 internal constant S = 16; // RemitWire.D6_CHUNK_DAYS
    uint8 internal constant ROUTE_LIST = 1;
    uint8 internal constant ROUTE_CHUNK = 2;
    bytes32 internal constant PROVED_SIG = keccak256("DayDeliveryProved(uint256,bytes32,uint256,uint8)");
    bytes32 internal constant ARMED_SIG = keccak256("DayDeliveryGateArmed(uint256)");

    /// @dev Redeclared so `expectEmit` can name them; the emitters are the
    ///      libraries inlined into the epoch facet.
    event DayDeliveryProved(uint256 indexed dayId, bytes32 indexed packetHash, uint256 remitId, uint8 route);
    event TransportDrawn(bytes32 indexed batchId, uint256 indexed dayId, uint256 fresh, uint256 recycled);

    /// @dev {RewardRemittanceLensFacet.getDayDeliveryState}, named.
    struct GateDay {
        bool gateArmed;
        bool stamped;
        bool freshStamped;
        bool landed;
        bytes32 provedBy;
        uint256 epochCount;
        bool reported;
        bool reportSent;
        bool awaitsLender;
        bool awaitsBorrower;
    }

    /// @dev {RewardRemittanceLensFacet.getPacketDeliveryProof}, named.
    struct GatePacket {
        bytes32 dayListHash;
        bytes32 dayListRoot;
        uint32 chunkCount;
        uint256 chunksIndexed;
        bool batched;
        bool quarantined;
        bool classificationFinal;
        uint256 disposed;
    }

    /// @dev Whether `setUp` activates reward custody.
    function _custodyActive() internal pure virtual returns (bool);

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
        vm.warp(block.timestamp + 60 days); // many finalized past days
        uint256 have = vpfi.balanceOf(address(this));
        if (SEED > have) vpfi.mint(address(this), SEED - have);
        vpfi.transfer(address(diamond), SEED);
        vm.chainId(CHAIN_ARB);
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(false);
        RewardReporterFacet(address(diamond)).setBaseChainId(CHAIN_BASE);
        RewardRemittanceFacet(address(diamond)).setRewardRemittanceReceiver(address(this));
        if (_custodyActive()) activateRewardCustodyForTest(address(vpfi), 0);
        messenger = new MockRewardMessenger(address(diamond));
        alice = makeAddr("gate-alice");
    }

    // ─── accessors ───

    function _epoch() internal view returns (RewardEpochFacet) { return RewardEpochFacet(address(diamond)); }
    function _ingress() internal view returns (RewardIngressFacet) { return RewardIngressFacet(address(diamond)); }
    function _mut() internal view returns (TestMutatorFacet) { return TestMutatorFacet(address(diamond)); }
    function _custody() internal view returns (RewardCustodyFacet) { return RewardCustodyFacet(address(diamond)); }
    function _rlens() internal view returns (RewardRemittanceLensFacet) { return RewardRemittanceLensFacet(address(diamond)); }
    function _remit() internal view returns (RewardRemittanceFacet) { return RewardRemittanceFacet(address(diamond)); }
    function _rep() internal view returns (RewardReporterFacet) { return RewardReporterFacet(address(diamond)); }
    function _cfg() internal view returns (ConfigFacet) { return ConfigFacet(address(diamond)); }
    function _com() internal view returns (RewardCommitmentFacet) { return RewardCommitmentFacet(address(diamond)); }
    function _eraF() internal view returns (RewardEraFacet) { return RewardEraFacet(address(diamond)); }

    function _row(LibVaipakam.RewardCustodyRow r) internal view returns (uint256) {
        return _custody().rewardCustodyRow(r);
    }

    function _live() internal view returns (uint256) {
        return _row(LibVaipakam.RewardCustodyRow.LiveFresh);
    }

    // ─── reads ───

    function _gd(uint256 d) internal view returns (GateDay memory v) {
        (
            v.gateArmed,
            v.stamped,
            v.freshStamped,
            v.landed,
            v.provedBy,
            v.epochCount,
            v.reported,
            v.reportSent,
            v.awaitsLender,
            v.awaitsBorrower
        ) = _rlens().getDayDeliveryState(d);
    }

    function _gp(bytes32 h) internal view returns (GatePacket memory v) {
        (
            v.dayListHash,
            v.dayListRoot,
            v.chunkCount,
            v.chunksIndexed,
            v.batched,
            v.quarantined,
            v.classificationFinal,
            v.disposed
        ) = _rlens().getPacketDeliveryProof(h);
    }

    function _awaits(uint8 side, uint256 d) internal view returns (bool) {
        return _rlens().dayAwaitsFreshDelivery(side, d);
    }

    /// @dev The lender fold's stored cursor.
    function _cursor() internal view returns (uint256 c) {
        (c, , , , ) = _mut().getCumStateRaw(0, 0);
    }

    /// @dev `DayDeliveryProved` logs for `dayId` among `logs`.
    function _provedLogs(Vm.Log[] memory logs, uint256 dayId) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (
                l.emitter == address(diamond) && l.topics.length == 3 && l.topics[0] == PROVED_SIG
                    && uint256(l.topics[1]) == dayId
            ) ++n;
        }
    }

    // ─── the gate ───

    /// @dev Arm the gate and pin what the setter STORED and ANNOUNCED. The
    ///      announcement is matched by topic, so the cell reads the same whether
    ///      the event indexes its day or not.
    function _armGate(uint256 fromDay) internal {
        vm.recordLogs();
        _remit().setDayDeliveryGateFromDay(fromDay);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(diamond) || l.topics.length == 0 || l.topics[0] != ARMED_SIG) continue;
            uint256 announced = l.topics.length > 1 ? uint256(l.topics[1]) : abi.decode(l.data, (uint256));
            assertEq(announced, fromDay, "the arming announces its first day");
            ++seen;
        }
        assertEq(seen, 1, "the arming is announced once");
        assertTrue(_gd(fromDay).gateArmed, "stored: the gate binds from its first day");
        if (fromDay > 1) assertFalse(_gd(fromDay - 1).gateArmed, "stored: and not the day before it");
    }

    // ─── days ───

    /// @dev Close day `d` HERE: this chain's interest totals and its report
    ///      stamp. The single-chain seeders also pre-stamp the consensus pair,
    ///      which on a mirror is the broadcast's to deliver, so it is cleared.
    function _closeLocal(uint256 d, uint256 lenderTotal, uint256 borrowerTotal) internal {
        _mut().setDailyLenderInterest(d, CLOSER, 0, lenderTotal);
        _mut().setDailyBorrowerInterest(d, CLOSER, 0, borrowerTotal);
        _mut().setKnownGlobalDailyInterest(d, 0, 0, false);
        _mut().setChainReportSentAtRaw(d, uint64(block.timestamp));
    }

    /// @dev Base's armed (`D* = 1`) V2 packet for day `d` to this chain: a 1e18
    ///      fresh half per side, ShareOfPool with the per-user ceiling at NEED,
    ///      nothing recycled.
    function _armedPacket(uint256 d) internal pure returns (RewardBroadcastV2 memory b) {
        b.dayId = d;
        b.globalLenderNumeraire18 = 1e18;
        b.globalBorrowerNumeraire18 = 1e18;
        b.capMode = uint8(LibVaipakam.CapMode.ShareOfPool);
        b.capPayloadLender = NEED;
        b.capPayloadBorrower = NEED;
        b.armedFromDay = 1;
        b.freshLenderHalf = 1e18;
        b.freshBorrowerHalf = 1e18;
        b.destChainId = CHAIN_ARB;
    }

    /// @dev Base's UNARMED (no `D*`) V2 packet: the legacy ETH-ratio mode with
    ///      the threshold disabled, and `half` as this chain's fresh half -- the
    ///      schedule half for an included day, zero for an excluded one, the
    ///      floor at 69M exhaustion.
    function _unarmedPacket(uint256 d, uint256 half) internal pure returns (RewardBroadcastV2 memory b) {
        b.dayId = d;
        b.globalLenderNumeraire18 = 100e18;
        b.capMode = uint8(LibVaipakam.CapMode.LegacyEthRatio);
        b.capPayloadLender = type(uint256).max;
        b.freshLenderHalf = half;
        b.freshBorrowerHalf = half;
        b.destChainId = CHAIN_ARB;
    }

    function _broadcastV2(RewardBroadcastV2 memory b) internal {
        _rep().setRewardMessenger(address(messenger));
        messenger.deliverBroadcastV2(b);
    }

    function _loanSideOpen(uint32 openDays) internal {
        _mut().setFeeEntitlementRaw(
            LOAN,
            LibVaipakam.FeeEntitlement({
                borrowerMode: LibVaipakam.FeeEntitlementMode.None,
                lenderMode: LibVaipakam.FeeEntitlementMode.None,
                openDays: openDays,
                rewardHaircutBpsAtOpen: 0,
                borrowerTariffPaid: 0,
                lenderTariffPaid: 0,
                cStarOpen: 0,
                loanSideRewardCapOpen: type(uint128).max
            })
        );
    }

    /// @dev Alice's closed lender entry over `[startDay, endDay)`, 1e18 a day.
    function _entry(uint32 startDay, uint32 endDay) internal returns (uint256 id) {
        id = _mut().pushRewardEntry(alice, LOAN, LibVaipakam.RewardSide.Lender, 1e18, startDay);
        _mut().closeRewardEntryRaw(id, endDay);
    }

    /// @dev Alice's closed lender entry on a LEGACY loan, `perDay` a day.
    function _legacyEntry(uint256 perDay, uint32 startDay, uint32 endDay) internal returns (uint256 id) {
        id = _mut().pushRewardEntry(alice, LEGACY_LOAN, LibVaipakam.RewardSide.Lender, perDay, startDay);
        _mut().closeRewardEntryRaw(id, endDay);
    }

    /// @dev The standard OWED day: day 1 closed here with lender interest,
    ///      stamped by Base's armed broadcast, alice's one-day entry on it.
    function _owedDay1() internal returns (uint256 id) {
        _loanSideOpen(1);
        _closeLocal(1, 1e18, 0);
        _broadcastV2(_armedPacket(1));
        id = _entry(1, 2);
    }

    // ─── deliveries ───

    function _one(uint256 d) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = d;
    }

    function _two(uint256 d1, uint256 d2) internal pure returns (uint256[] memory a) {
        a = new uint256[](2);
        a[0] = d1;
        a[1] = d2;
    }

    function _days(uint256 n, uint256 from) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = from + i;
    }

    /// @dev A typed (d5) delivery, wholly fresh: credits the live row at
    ///      ingress, opens no epoch, and lands NO day until its list is proven.
    function _liveOf(uint256 amount, uint256[] memory dayIds, uint256 remitId, bytes32 id)
        internal
        returns (bytes32 h)
    {
        uint256 before = _live();
        _ingress().onRewardBudgetReceived(address(vpfi), amount, dayIds, CHAIN_BASE, remitId, REMITTER, 0, amount, id, true);
        if (_custodyActive()) assertEq(_live() - before, amount, "fixture: the typed delivery is live-fresh");
        h = keccak256(abi.encode(uint256(CHAIN_BASE), id));
    }

    /// @dev An old-wire (untyped) delivery. On an activated custody its epoch
    ///      opens COMPACTLY at ingress; its membership is indexed later.
    function _untyped(uint256 amount, uint256[] memory dayIds, uint256 remitId, bytes32 id)
        internal
        returns (bytes32 h)
    {
        _ingress().onRewardBudgetReceived(address(vpfi), amount, dayIds, CHAIN_BASE, remitId, REMITTER, 0, 0, id, false);
        h = keccak256(abi.encode(uint256(CHAIN_BASE), id));
    }

    function _attest(uint256 remitId, uint256 fresh, uint256 recycled) internal {
        _rep().setRewardMessenger(address(this));
        _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, remitId, fresh, recycled);
    }

    /// @dev A d6 (rooted) delivery as the registered receiver forwards it.
    function _d6(uint256 amount, uint256[] memory dayIds, uint256 remitId, bytes32 id, uint256 recycled, uint64 era)
        internal
        returns (bytes32 h, bytes32[] memory leaves)
    {
        leaves = RemitWire.d6Chunks(dayIds);
        _ingress().onRewardBudgetReceivedD6(
            address(vpfi), amount, RemitWire.d6Root(leaves), dayIds.length, leaves.length,
            CHAIN_BASE, remitId, REMITTER, recycled, amount - recycled, id, era
        );
        h = keccak256(abi.encode(uint256(CHAIN_BASE), id));
    }

    /// @dev Index chunk `c` of a BATCHED rooted delivery (the epoch route).
    function _indexChunk(bytes32 h, uint256[] memory dayIds, bytes32[] memory leaves, uint256 c) internal returns (uint32) {
        return _epoch().materializeTransportBatchChunk(
            h, c, MerkleFixture.chunk(dayIds, c, S), MerkleFixture.proof(leaves, c), new bytes32[](0), new bytes32[](0)
        );
    }

    function _d6Whole(uint256 amount, uint256[] memory dayIds, uint256 remitId, bytes32 id) internal returns (bytes32 h) {
        bytes32[] memory leaves;
        (h, leaves) = _d6(amount, dayIds, remitId, id, 0, 0);
        for (uint256 c; c < leaves.length; ++c) _indexChunk(h, dayIds, leaves, c);
    }

    /// @dev Prove a batchless packet's FLAT list (the d5 / pre-activation route).
    function _prove(bytes32 h, uint256[] memory dayIds) internal {
        _epoch().proveDeliveryDayList(h, dayIds);
    }

    /// @dev Prove chunk `c` of a batchless ROOTED packet.
    function _proveRooted(bytes32 h, uint256[] memory dayIds, bytes32[] memory leaves, uint256 c) internal {
        _epoch().proveDeliveryDayChunk(h, c, MerkleFixture.chunk(dayIds, c, S), MerkleFixture.proof(leaves, c));
    }

    // ─── claims ───

    function _claim() internal returns (uint256 paid) {
        vm.prank(alice);
        (paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewards();
    }

    function _tryClaim() internal returns (bool ok, bytes memory ret) {
        vm.prank(alice);
        (ok, ret) = address(diamond).call(abi.encodeWithSelector(RewardClaimFacet.claimInteractionRewards.selector));
    }

    /// @dev The claim AND its preview-by-execution defer on day `d`, by name.
    function _expectHeld(uint256 d) internal {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(InteractionDayAwaitingDelivery.selector, d));
        RewardClaimFacet(address(diamond)).claimInteractionRewards();
        vm.expectRevert(abi.encodeWithSelector(InteractionDayAwaitingDelivery.selector, d));
        RewardClaimFacet(address(diamond)).simulateClaimInteractionRewards(alice, LibVaipakam.RewardDelivery.Default);
    }

    /// @dev Whatever the claim does now, it is NOT the gate holding it.
    function _assertNotTheGate(string memory why) internal {
        (bool ok, bytes memory ret) = _tryClaim();
        if (!ok) assertTrue(ret.length < 4 || bytes4(ret) != InteractionDayAwaitingDelivery.selector, why);
    }
}

/**
 * @title  RewardDayDeliveryGateTest -- the gate on an ACTIVATED mirror.
 * @notice Cells 1-4, 5 (the batched refusals), 6-11 and 14-17 of the #1944
 *         consequence-1 brief. Every cell asserts its fixture is LIVE -- the
 *         day pays once its delivery is proven, or the rule's sibling side
 *         pays -- and STRADDLES the rule: one proof short defers by name, the
 *         proof pays. Each cell's natspec names the mutation of the production
 *         rule that turns it red.
 */
contract RewardDayDeliveryGateTest is RewardDayDeliveryGateBase {
    function _custodyActive() internal pure override returns (bool) {
        return true;
    }

    function _sweeper() internal view returns (RewardHorizonSweepFacet) {
        return RewardHorizonSweepFacet(address(diamond));
    }

    function _irlens() internal view returns (InteractionRewardsLensFacet) {
        return InteractionRewardsLensFacet(address(diamond));
    }

    function _detach() internal {
        _mut().setRewardRoleChangesFrozenRaw(false);
        _rep().setBaseChainId(0);
    }

    function _reattach() internal {
        _mut().setRewardRoleChangesFrozenRaw(false);
        _rep().setBaseChainId(CHAIN_BASE);
    }

    /// @dev A quarantined COMPENSATION packet (finalizedAt 0) -- the kind the
    ///      proof entries refuse: only a budget packet funds days.
    function _compensation(uint256 remitId, bytes32 id) internal returns (bytes32 h) {
        _ingress().onCompensationBudgetReceived(
            address(vpfi), 5 ether, 7, CHAIN_BASE, remitId, REMITTER, 3 ether, 2 ether, 0, 1, uint64(7 days),
            uint64(24 hours), id
        );
        h = keccak256(abi.encode(uint256(CHAIN_BASE), id));
    }

    /// @dev Give packet `h` a non-zero `disposed`. No production writer reaches
    ///      a BUDGET packet (disposal is the repatriation's exit, which binds
    ///      only compensation packets), so the word is found the way a probe
    ///      would: among the slots the packet read touches, the one zero word
    ///      whose write the packet read reports back as `disposed`. Every
    ///      other probe is restored, and a miss is a loud fixture failure.
    function _setPacketDisposedRaw(bytes32 h, uint256 v) internal {
        vm.record();
        _rlens().getIngressPacket(h);
        (bytes32[] memory reads, ) = vm.accesses(address(diamond));
        for (uint256 i; i < reads.length; ++i) {
            bytes32 was = vm.load(address(diamond), reads[i]);
            if (was != bytes32(0)) continue;
            vm.store(address(diamond), reads[i], bytes32(v));
            if (_rlens().getIngressPacket(h).disposed == v) return;
            vm.store(address(diamond), reads[i], was);
        }
        revert("fixture: the packet disposed word was not found");
    }

    // ─────────────────────── cells 1-2: broadcast first ───────────────────────

    /// @dev Day 1 LANDED by a typed delivery proven to list it -- that delivery
    ///      also funds the live row with NEED, so a fungible bound alone would
    ///      pay day 2 out of it. Day 2 stamped by Base, closed here with lender
    ///      interest, OWED, and listed by nothing that landed. Alice's one
    ///      entry is on day 2.
    function _heldScene() internal returns (uint256 id, bytes32 h1) {
        _armGate(1);
        _loanSideOpen(1);
        _closeLocal(1, 1e18, 0);
        _broadcastV2(_armedPacket(1));
        _closeLocal(2, 1e18, 0);
        _broadcastV2(_armedPacket(2));
        id = _entry(2, 3);
        h1 = _liveOf(NEED, _one(1), 1, keccak256("gate-live-1"));
        _prove(h1, _one(1));
    }

    /**
     * @notice Cell 1 -- BROADCAST FIRST: Base's stamp for day 2 has landed, its
     *         delivery has not. The claim and its preview defer on day 2 BY
     *         NAME, nothing moves, and the lender fold rests on day 1.
     * @dev    Mutation: delete rung A (the delivery test in `_dayPoolHalves`)
     *         and the claim pays day 2 out of day 1's live delivery -- the
     *         named deferral fails. Drop the walk's `awaitingDay` naming and the
     *         same claim reverts `NoInteractionRewardsToClaim` instead.
     */
    function test_1944_1_BroadcastFirst_AnUnprovenDayDefersByName_MovingNothing() public {
        (, bytes32 h1) = _heldScene();

        // LIVE first: once a delivery proven to list day 2 lands, the same claim pays it.
        uint256 snap = vm.snapshotState();
        bytes32 h2 = _liveOf(1, _one(2), 2, keccak256("gate-live-2"));
        _prove(h2, _one(2));
        assertEq(_claim(), NEED, "LIVE: once its delivery is proven, day 2 pays");
        vm.revertToState(snap);

        uint256 live = _live();
        uint256 uncl = _row(LibVaipakam.RewardCustodyRow.Unclassified);
        uint256 bucket = _cfg().getRecycleBucket();
        assertEq(live, NEED, "fixture: day 1's delivery left the live row able to pay day 2");

        _expectHeld(2);

        assertEq(_live(), live, "the live row paid nothing");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Unclassified), uncl, "nor the unclassified row");
        assertEq(_mut().getArmedFreshPaidRaw(), 0, "nothing charged to the delivered ledger");
        assertEq(_cfg().getRecycleBucket(), bucket, "nor to the bucket");
        assertEq(vpfi.balanceOf(alice), 0, "nothing reached the claimant");

        // The fold itself halts BEFORE the day: driven directly, it reaches day 1 and stops.
        assertEq(_mut().advanceCumThroughRaw(0, 2), 1, "the lender fold stops before day 2");
        assertEq(_cursor(), 1, "stored: the cursor rests on day 1");

        GateDay memory g = _gd(2);
        assertTrue(g.gateArmed, "the gate binds day 2");
        assertTrue(g.stamped && g.freshStamped, "Base's stamp prices fresh on day 2");
        assertFalse(g.landed, "nothing listing day 2 has landed");
        assertEq(g.provedBy, bytes32(0), "no proof names day 2");
        assertEq(g.epochCount, 0, "no epoch lists day 2");
        assertTrue(g.reported, "this chain reported day 2");
        assertFalse(g.reportSent, "its commitment report is not sent");
        assertTrue(g.awaitsLender, "the lender side owes fresh: it waits");
        assertFalse(g.awaitsBorrower, "no borrower interest closed here: that side owes nothing");
        assertTrue(_awaits(2, 2), "the either-side form agrees");

        GateDay memory g1 = _gd(1);
        assertTrue(g1.landed, "day 1 landed");
        assertEq(g1.provedBy, h1, "stored: by the packet proven to list it");
        assertFalse(g1.awaitsLender || g1.awaitsBorrower, "so day 1 is open");
    }

    /**
     * @notice Cell 2 -- the CONTROL: a delivery listing day 2 arrives (still one
     *         proof short: the claim defers by name), then its list is proven.
     *         One `DayDeliveryProved`, the mark stored, and the same claim pays
     *         out of the live row with the fold past the day.
     * @dev    Mutation: make the flat proof write no mark (or mark another day)
     *         and the claim after it stays held; emit on the wrong route or
     *         remit and the event expectation fails.
     */
    function test_1944_2_TheProofLandsTheDay_AndTheSameClaimPays() public {
        _heldScene();
        bytes32 h2 = _liveOf(NEED, _one(2), 2, keccak256("gate-live-2"));
        _expectHeld(2); // one proof short: the delivery landed its value, not the day

        vm.expectEmit(true, true, false, true, address(diamond));
        emit DayDeliveryProved(2, h2, 2, ROUTE_LIST);
        _prove(h2, _one(2));

        GateDay memory g = _gd(2);
        assertTrue(g.landed, "stored: day 2 landed");
        assertEq(g.provedBy, h2, "stored: by the packet proven to list it");
        assertFalse(g.awaitsLender, "nothing waits any more");

        uint256 live = _live();
        assertEq(_claim(), NEED, "the proof pays the day");
        assertEq(vpfi.balanceOf(alice), NEED, "to the claimant");
        assertEq(live - _live(), NEED, "out of the live row");
        assertGe(_cursor(), 2, "stored: the fold passed day 2");
    }

    // ─────────────────────── cell 3: proof first ───────────────────────

    /**
     * @notice Cell 3 -- PROOF BEFORE THE BROADCAST: a delivery proven to list
     *         day 1 lands before Base's stamp does. The day is landed and not
     *         stamped; before the stamp the claim waits on the pre-existing
     *         finalization name (not the gate's); the first claim after the
     *         stamp pays.
     * @dev    Mutation: let the broadcast clear or ignore a mark written before
     *         it (an order-dependent landed reader) and the first claim after
     *         the stamp defers on the gate.
     */
    function test_1944_3_ProofBeforeTheBroadcast_LandsAnUnstampedDay() public {
        _armGate(1);
        _loanSideOpen(1);
        _closeLocal(1, 1e18, 0);
        _entry(1, 2);
        bytes32 h = _liveOf(NEED, _one(1), 31, keccak256("gate-early"));
        _prove(h, _one(1));

        GateDay memory g = _gd(1);
        assertTrue(g.landed, "landed before Base priced it");
        assertFalse(g.stamped, "and not yet stamped");
        assertEq(g.provedBy, h, "stored: the early proof");
        assertFalse(_awaits(2, 1), "an unstamped day never waits");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(InteractionDayGlobalNotFinalized.selector, 1));
        RewardClaimFacet(address(diamond)).claimInteractionRewards();

        _broadcastV2(_armedPacket(1));
        g = _gd(1);
        assertTrue(g.stamped && g.landed, "stamped after landing");
        assertFalse(g.awaitsLender, "so open");
        assertEq(g.provedBy, h, "the stamp left the mark alone");
        assertEq(_claim(), NEED, "the first claim after the stamp pays");
    }

    // ─────────────────────── cells 4a-4b: the epoch path ───────────────────────

    /**
     * @notice Cell 4a -- a d6 delivery whose every chunk is indexed (and whose
     *         split the wire attested) lands the day through the BATCH INDEX,
     *         with no mark, and the claim pays FROM THE EPOCH: the unclassified
     *         row falls, the live row is untouched.
     * @dev    Mutation: make the landed reader read only the proof mark and this
     *         day never pays -- an epoch-path packet writes no mark.
     */
    function test_1944_4a_AWholeAttestedEpoch_LandsTheDay_AndPaysFromIt() public {
        _armGate(1);
        _owedDay1();
        _expectHeld(1);

        bytes32 h = _d6Whole(10e18, _days(1, 1), 41, keccak256("gate-d6-whole"));
        GateDay memory g = _gd(1);
        assertTrue(g.landed, "the epoch index lands the day");
        assertEq(g.epochCount, 1, "one epoch lists it");
        assertEq(g.provedBy, bytes32(0), "no mark: an epoch's fact is its index");
        assertFalse(_awaits(2, 1), "nothing waits");

        uint256 uncl = _row(LibVaipakam.RewardCustodyRow.Unclassified);
        uint256 live = _live();
        vm.expectEmit(true, true, false, true, address(diamond));
        emit TransportDrawn(h, 1, NEED, 0);
        assertEq(_claim(), NEED, "paid from the epoch");
        assertEq(uncl - _row(LibVaipakam.RewardCustodyRow.Unclassified), NEED, "out of the unclassified row");
        assertEq(_live(), live, "the live row untouched");
        (uint256 lf, uint256 lr) = _epoch().getTransportBatchLegs(h);
        assertEq(lf, NEED, "stored: the epoch's fresh leg");
        assertEq(lr, 0, "and no recycled leg");
    }

    /**
     * @notice Cell 4b -- LANDED IS NOT DRAWABLE: one indexed chunk lands day 1
     *         while its 20-day epoch is not whole. The gate lets the day price;
     *         with no live value the claim defers on the funding (NOT on the
     *         gate), and a live delivery then pays it, the epoch untouched.
     * @dev    Mutation: make the landed reader require a whole epoch and the
     *         first claim defers on the gate's name instead.
     */
    function test_1944_4b_OneIndexedChunk_LandsTheDay_ButTheEpochIsNotDrawable() public {
        _armGate(1);
        _owedDay1();
        uint256[] memory list = _days(20, 1);
        (bytes32 h, bytes32[] memory leaves) = _d6(10e18, list, 42, keccak256("gate-d6-part"), 0, 0);
        _expectHeld(1); // ingress landed the value, not the day

        _indexChunk(h, list, leaves, 0);
        GateDay memory g = _gd(1);
        assertTrue(g.landed, "one indexed chunk lands day 1");
        assertEq(g.epochCount, 1, "stored: the day's index holds the epoch");
        assertEq(g.provedBy, bytes32(0), "and no mark");
        (uint8 gates, ) = _epoch().getTransportBatchGates(h);
        assertTrue((gates & LibRewardCustody.GATE_UNINDEXED) != 0, "but the epoch is not whole");

        (bool ok, bytes memory ret) = _tryClaim();
        assertFalse(ok, "with no drawable value the claim defers");
        assertTrue(ret.length < 4 || bytes4(ret) != InteractionDayAwaitingDelivery.selector, "but NOT on the gate");
        assertEq(vpfi.balanceOf(alice), 0, "nothing paid");

        _liveOf(NEED, _one(1), 43, keccak256("gate-d6-live"));
        assertEq(_claim(), NEED, "a live delivery pays the landed day");
        (, uint256 balance, , , , ) = _epoch().getTransportBatch(h);
        assertEq(balance, 10e18, "the unwhole epoch untouched");
    }

    // ─────────────────────── cell 5: the batched refusals ───────────────────────

    /**
     * @notice Cell 5 (activated half) -- the proof routes refuse, by name, what
     *         they cannot prove: an unknown packet, a BATCHED packet on either
     *         route (its days land through the batch index), a non-budget
     *         packet, a flat packet on the rooted route, a list the packet
     *         never committed to, and a pre-3a packet with no list. None of
     *         them marks anything; the right packet on the right route does.
     * @dev    Mutation: let a proof entry accept `batchId != 0` and the
     *         `DeliveryProofRouteIsBatch` expectations fail -- a second
     *         statement of a fact the batch index already owns.
     */
    function test_1944_5_TheProofRoutes_RefuseWhatTheyCannotProve() public {
        _armGate(1);
        bytes32 nobody = keccak256("gate-nobody");
        vm.expectRevert(abi.encodeWithSelector(IngressPacketUnknown.selector, nobody));
        _epoch().proveDeliveryDayList(nobody, _one(1));
        vm.expectRevert(abi.encodeWithSelector(IngressPacketUnknown.selector, nobody));
        _epoch().proveDeliveryDayChunk(nobody, 0, _one(1), new bytes32[](0));

        (bytes32 h6, bytes32[] memory leaves) = _d6(5e18, _one(1), 51, keccak256("gate-batched-d6"), 0, 0);
        assertTrue(_gp(h6).batched, "fixture: on an activated custody a d6 opens its epoch at ingress");
        vm.expectRevert(abi.encodeWithSelector(DeliveryProofRouteIsBatch.selector, h6));
        _epoch().proveDeliveryDayChunk(h6, 0, _one(1), MerkleFixture.proof(leaves, 0));

        bytes32 hU = _untyped(5e18, _one(1), 52, keccak256("gate-batched-untyped"));
        assertTrue(_gp(hU).batched, "fixture: an untyped delivery opens its epoch at ingress");
        vm.expectRevert(abi.encodeWithSelector(DeliveryProofRouteIsBatch.selector, hU));
        _epoch().proveDeliveryDayList(hU, _one(1));

        bytes32 hC = _compensation(53, keccak256("gate-comp"));
        vm.expectRevert(
            abi.encodeWithSelector(DeliveryProofNotBudget.selector, hC, LibRewardCustody.PACKET_KIND_COMPENSATION)
        );
        _epoch().proveDeliveryDayList(hC, _one(7));

        bytes32 h5 = _liveOf(NEED, _one(1), 54, keccak256("gate-flat"));
        vm.expectRevert(abi.encodeWithSelector(TransportBatchNotRooted.selector, h5));
        _epoch().proveDeliveryDayChunk(h5, 0, _one(1), new bytes32[](0));
        vm.expectRevert(
            abi.encodeWithSelector(
                TransportDayListMismatch.selector, h5, keccak256(abi.encode(_one(1))), keccak256(abi.encode(_one(2)))
            )
        );
        _epoch().proveDeliveryDayList(h5, _one(2));

        bytes32 hOld = _liveOf(NEED, _one(1), 55, keccak256("gate-pre3a"));
        _mut().setPacketDayListRaw(hOld, bytes32(0), 0);
        vm.expectRevert(abi.encodeWithSelector(TransportPacketHasNoDayList.selector, hOld));
        _epoch().proveDeliveryDayList(hOld, _one(1));

        GateDay memory g = _gd(1);
        assertFalse(g.landed, "no refused proof marked anything; no epoch was indexed");
        assertEq(g.provedBy, bytes32(0));

        _prove(h5, _one(1));
        assertEq(_gd(1).provedBy, h5, "the right packet on the right route proves");
    }

    // ─────────────────────── cell 6: before D* ───────────────────────

    /**
     * @notice Cell 6 -- a PRE-ARMING propagation day: no `D*` is installed, yet
     *         Base's unarmed stamp prices fresh here, so the day waits. The
     *         claimant's legacy WINDOW counter (rung B, the window clamp) and
     *         her legacy ENTRY slice (rung A, the fold) both wait until the
     *         proof, then both pay -- exactly what they pay when proven first.
     * @dev    Mutations: delete rung B and the window pays the unfunded day;
     *         delete rung A and the legacy entry slice pays it. Either turns
     *         the named deferral below red.
     */
    function test_1944_6_APreArmingDay_HoldsTheWindowAndTheLegacySlice() public {
        uint256 h1 = LibInteractionRewards.halfPoolForDay(1);
        _armGate(1);
        _closeLocal(1, 100e18, 0);
        _broadcastV2(_unarmedPacket(1, h1));
        _mut().setDailyLenderInterest(1, alice, 50e18, 100e18); // the window counter
        _legacyEntry(50e18, 1, 2); // and the legacy entry, same day
        bytes32 h = _liveOf(2 * h1, _one(1), 61, keccak256("gate-pre-dstar"));
        assertTrue(_gd(1).awaitsLender, "fixture: no D*, yet the unarmed day owes fresh and waits");

        uint256 snap = vm.snapshotState();
        _prove(h, _one(1));
        uint256 livePaid = _claim();
        assertApproxEqAbs(livePaid, h1, 1e6, "LIVE: proven, the window half and the legacy slice both pay");
        vm.revertToState(snap);

        uint256 live = _live();
        _expectHeld(1);
        assertEq(_live(), live, "nothing paid while held");
        assertEq(_mut().advanceCumThroughRaw(0, 1), 0, "the fold halts before the unarmed day too");

        _prove(h, _one(1));
        uint256 paid = _claim();
        assertEq(paid, livePaid, "the held claim pays exactly what the proven-first claim paid");
        assertEq(live - _live(), paid, "out of the live row");
    }

    // ─────────────────────── cell 7: zero slices never wait ───────────────────────

    /// @dev Day 1 is the zero-slice day under test; day 2 is a funded, owed
    ///      day behind it that alice claims, listed by an unproven delivery.
    function _zeroSliceThenOwedDay2(RewardBroadcastV2 memory day1, uint256 lender1, uint256 borrower1)
        internal
        returns (bytes32 h2)
    {
        _armGate(1);
        _loanSideOpen(1);
        _closeLocal(1, lender1, borrower1);
        _broadcastV2(day1);
        _closeLocal(2, 1e18, 0);
        _broadcastV2(_armedPacket(2));
        _entry(2, 3);
        h2 = _liveOf(NEED, _one(2), 71, keccak256("gate-zero-slice"));
    }

    /**
     * @notice Cell 7a -- an EXCLUDED destination's day (zero fresh halves)
     *         never waits, so the owed day behind it waits only for its own
     *         proof and then pays: the cursor walks through the excluded day.
     * @dev    Mutation: drop step 7 (zero fresh half) and the excluded day reads
     *         as awaiting -- the view assertion fails.
     */
    function test_1944_7a_AnExcludedDestinationsDay_NeverWaits() public {
        RewardBroadcastV2 memory b = _armedPacket(1);
        b.freshLenderHalf = 0;
        b.freshBorrowerHalf = 0;
        bytes32 h2 = _zeroSliceThenOwedDay2(b, 1e18, 1e18);

        GateDay memory g = _gd(1);
        assertTrue(g.stamped && g.reported && !g.landed, "fixture: stamped, reported, never delivered");
        assertFalse(g.freshStamped, "Base excluded this chain: zero fresh halves");
        assertFalse(g.awaitsLender || g.awaitsBorrower, "so neither side waits");

        _expectHeld(2); // straddle: the funded day behind it still waits for its own proof
        _prove(h2, _one(2));
        assertEq(_claim(), NEED, "and pays once proven: the excluded day did not wedge the cursor");
        assertGe(_cursor(), 2, "stored: the fold walked through both days");
    }

    /**
     * @notice Cell 7b -- fresh halves stamped but NO local interest closed:
     *         Base's slice for this chain is zero, so the day never waits.
     * @dev    Mutation: drop step 8 (zero local total) and day 1 waits forever
     *         -- the fold halts at day 0 and day 2 can never pay (wedge).
     */
    function test_1944_7b_AZeroInterestDay_NeverWaits() public {
        bytes32 h2 = _zeroSliceThenOwedDay2(_armedPacket(1), 0, 0);

        GateDay memory g = _gd(1);
        assertTrue(g.stamped && g.freshStamped && g.reported && !g.landed, "fixture: priced fresh, never delivered");
        assertFalse(g.awaitsLender || g.awaitsBorrower, "no interest closed here: nothing owed, nothing waits");

        _expectHeld(2);
        _prove(h2, _one(2));
        assertEq(_claim(), NEED, "the day behind it pays once proven");
        assertGe(_cursor(), 2, "stored: the fold walked through both days");
    }

    /**
     * @notice Cell 7c -- a RECYCLED-ONLY side (fresh halves zero, a recycled
     *         equivalent, the mirror's own bucket backing it) never waits: it
     *         pays from the bucket with nothing proven. The straddle: the same
     *         day stamped with a fresh half waits.
     * @dev    Mutation: gate the recycled half too and this day wedges -- Base
     *         may send nothing for a locally backed side.
     */
    function test_1944_7c_ARecycledOnlySide_PaysFromTheBucket_WithNothingProven() public {
        _armGate(1);
        _loanSideOpen(1);
        _mut().setRecycleBucketRaw(10e18);
        _closeLocal(1, 1e18, 0);
        _entry(1, 2);

        uint256 snap = vm.snapshotState();
        _broadcastV2(_armedPacket(1));
        assertTrue(_awaits(0, 1), "straddle: with a fresh half the day waits");
        _expectHeld(1);
        vm.revertToState(snap);

        RewardBroadcastV2 memory b = _armedPacket(1);
        b.freshLenderHalf = 0;
        b.freshBorrowerHalf = 0;
        b.recycledLenderHalfEquiv = 1e18;
        b.recycleConsume = NEED;
        _broadcastV2(b);
        GateDay memory g = _gd(1);
        assertTrue(g.stamped && !g.freshStamped && !g.landed, "fixture: recycled-only, never delivered");
        assertFalse(_awaits(2, 1), "a recycled-only side never waits");

        uint256 bucket = _cfg().getRecycleBucket();
        assertEq(_claim(), NEED, "paid with nothing proven");
        assertEq(bucket - _cfg().getRecycleBucket(), NEED, "from the bucket");
        assertEq(_mut().getArmedFreshPaidRaw(), 0, "nothing fresh charged");
    }

    /**
     * @notice Cell 7d (S1-R1) -- the derivation fix, gate DARK: an UNARMED day
     *         Base excluded this chain from (stamp zero-halved) prices nothing
     *         through the window, while the identical counters on the included
     *         day beside it pay that day's half.
     * @dev    Mutation: revert `_sideFreshHalf` to `halfPoolForDay` and the
     *         window pays day 1 too -- an unfunded day, the exact figure fails.
     */
    function test_1944_7d_AnExcludedUnarmedDay_PricesTheStamp_NotTheSchedule() public {
        uint256 h2 = LibInteractionRewards.halfPoolForDay(2);
        assertGt(LibInteractionRewards.halfPoolForDay(1), 0, "fixture: the schedule would price day 1");
        _broadcastV2(_unarmedPacket(1, 0)); // excluded
        _broadcastV2(_unarmedPacket(2, h2)); // included
        _mut().setDailyLenderInterest(1, alice, 50e18, 100e18);
        _mut().setDailyLenderInterest(2, alice, 50e18, 100e18);
        _liveOf(h2, _two(1, 2), 74, keccak256("gate-7d"));
        assertFalse(_gd(1).gateArmed, "the gate is dark: this is the derivation alone");

        uint256 live = _live();
        uint256 paid = _claim();
        assertEq(paid, (h2 * 50e18) / 100e18, "only the included day pays");
        assertEq(live - _live(), paid, "out of the live row");
    }

    /**
     * @notice Cell 7e -- an EXHAUSTED unarmed day (the stamp's floor half below
     *         the schedule half): the window and the legacy slice both price
     *         the stamped half.
     * @dev    Mutation: as 7d -- the schedule half pays four times the floor.
     */
    function test_1944_7e_AnExhaustedUnarmedDay_PricesTheStampHalf() public {
        uint256 sched = LibInteractionRewards.halfPoolForDay(1);
        uint256 floorHalf = sched / 4;
        _broadcastV2(_unarmedPacket(1, floorHalf));
        _mut().setDailyLenderInterest(1, alice, 50e18, 100e18);
        _legacyEntry(50e18, 1, 2);
        _liveOf(sched, _one(1), 75, keccak256("gate-7e"));
        uint256 paid = _claim();
        assertApproxEqAbs(paid, floorHalf, 1e6, "the window and the legacy slice both price the floor half");
        assertLt(paid, sched / 2, "never the schedule half");
    }

    /**
     * @notice Cell 7f -- a day this chain NEVER REPORTED never waits: until the
     *         report is sent, Base's numerator for this chain is zero, so Base
     *         owes the day nothing here. The straddle: the same day, reported,
     *         waits. The owed day behind it then waits only for its own proof.
     * @dev    Mutation: drop step 5 (`chainReportSentAt == 0`) and the
     *         unreported day reads as awaiting -- the view assertion fails, and
     *         the fold halts before day 1, so the claim names day 1, not day 2.
     *         The stamp is cleared raw AFTER the broadcast: production writes
     *         it once, in the transaction that ships the totals, so an
     *         unreported day that Base nevertheless stamped is a force-finalized
     *         day this chain never closed -- the same stored word either way.
     */
    function test_1944_7f_ANeverReportedDay_NeverWaits() public {
        bytes32 h2 = _zeroSliceThenOwedDay2(_armedPacket(1), 1e18, 0);
        assertTrue(_awaits(2, 1), "straddle: reported, priced fresh and owed, the day waits");

        _mut().setChainReportSentAtRaw(1, 0);
        GateDay memory g = _gd(1);
        assertTrue(g.stamped && g.freshStamped && !g.landed, "fixture: priced fresh, never delivered");
        assertFalse(g.reported, "stored: this chain never reported the day");
        assertFalse(g.awaitsLender || g.awaitsBorrower, "never reported: nothing owed, neither side waits");
        assertFalse(_awaits(2, 1), "and the either-side form agrees");

        _expectHeld(2);
        _prove(h2, _one(2));
        assertEq(_claim(), NEED, "the day behind it pays once proven: day 1 did not wedge the cursor");
        assertGe(_cursor(), 2, "stored: the fold walked through both days");
    }

    /**
     * @notice Cell 7g -- a ZERO-THRESHOLD day never waits: with `T_d == 0`
     *         Base caps this chain's slice of the day to zero and sends
     *         nothing for it. Straddle as 7f.
     * @dev    Mutation: drop step 6 (`dayCapThreshold18 == 0`) and the day
     *         reads as awaiting -- the view assertion fails and the claim names
     *         day 1. The threshold is written raw: a ShareOfPool broadcast
     *         stores the disabled-cap maximum, and a zero is Base's legacy
     *         threshold for an unarmed day; the predicate reads the one stored
     *         word whichever writer put it there.
     */
    function test_1944_7g_AZeroThresholdDay_NeverWaits() public {
        bytes32 h2 = _zeroSliceThenOwedDay2(_armedPacket(1), 1e18, 0);
        assertTrue(_awaits(2, 1), "straddle: with its threshold the day waits");

        _mut().setDayCapThreshold18(1, 0);
        GateDay memory g = _gd(1);
        assertTrue(g.stamped && g.freshStamped && g.reported && !g.landed, "fixture: priced fresh, reported, never delivered");
        assertFalse(g.awaitsLender || g.awaitsBorrower, "a zero threshold: Base's slice is zero, neither side waits");
        assertFalse(_awaits(2, 1), "and the either-side form agrees");

        _expectHeld(2);
        _prove(h2, _one(2));
        assertEq(_claim(), NEED, "the day behind it pays once proven");
        assertGe(_cursor(), 2, "stored: the fold walked through both days");
    }

    /**
     * @notice Cell 7h -- a DUST fresh half never waits: Base sizes this chain's
     *         slice from `half * 1e18 / global`, which floors to zero whenever
     *         `0 < half * 1e18 < global`, so Base sends no fresh for the side and
     *         the mirror prices the same floored delta at zero. The straddle: a
     *         half one unit larger floors to one per unit and the day waits.
     * @dev    Mutation: drop step 7b (the floored-delta exit) and the dust day
     *         reads as awaiting -- the view assertion fails, and the fold halts
     *         before day 1, so the claim names day 1, not day 2.
     */
    function test_1944_7h_ADustFreshHalf_NeverWaits() public {
        uint256 snap = vm.snapshotState();
        RewardBroadcastV2 memory w = _armedPacket(1);
        w.globalLenderNumeraire18 = 2e18;
        w.freshLenderHalf = 2; // 2 * 1e18 / 2e18 == 1: a real fresh delta
        _zeroSliceThenOwedDay2(w, 1e18, 0);
        assertTrue(_awaits(0, 1), "straddle: a half that floors to one unit waits");
        vm.revertToState(snap);

        RewardBroadcastV2 memory b = _armedPacket(1);
        b.globalLenderNumeraire18 = 2e18;
        b.freshLenderHalf = 1; // 1 * 1e18 / 2e18 == 0: Base's floored delta is zero
        bytes32 h2 = _zeroSliceThenOwedDay2(b, 1e18, 0);

        GateDay memory g = _gd(1);
        assertTrue(g.stamped && g.freshStamped && g.reported && !g.landed, "fixture: a non-zero half, never delivered");
        assertFalse(g.awaitsLender || g.awaitsBorrower, "the floored delta is zero: neither side waits");
        assertFalse(_awaits(2, 1), "and the either-side form agrees");

        _expectHeld(2);
        _prove(h2, _one(2));
        assertEq(_claim(), NEED, "the day behind it pays once proven: the dust day did not wedge the cursor");
        assertGe(_cursor(), 2, "stored: the fold walked through both days");
    }

    // ─────────────────────── cells 8-9: the commitment report ───────────────────────

    function _reportCommitment(uint256 d, uint256 lenderEntry) internal {
        _com().submitCommitmentBatch(d, 0, _one(lenderEntry));
        _com().sendCommitmentReport(d);
    }

    /**
     * @notice Cell 8 -- a ZERO-LIABILITY armed side, report sent: Base clamps
     *         that side's fresh leg to zero, so the mirror does not wait for
     *         it, and the claim settles the day at zero. Straddle: the same
     *         day with a ceiling above zero reports a liability and waits.
     * @dev    Mutation: drop step 9 and the zero-liability day waits for a
     *         delivery Base never sends -- the cursor wedges on it.
     */
    function test_1944_8_AZeroLiabilitySide_ReportSent_IsNotHeld() public {
        _armGate(1);
        _loanSideOpen(1);
        _closeLocal(1, 1e18, 0);
        uint256 id = _entry(1, 2);

        uint256 snap = vm.snapshotState();
        _broadcastV2(_armedPacket(1));
        _reportCommitment(1, id);
        (, uint256 liability, ) = _com().getCommitmentAccumulation(1, 0);
        assertGt(liability, 0, "straddle: a ceiling above zero reports a liability");
        assertTrue(_awaits(0, 1), "and that side waits for its delivery");
        _expectHeld(1);
        vm.revertToState(snap);

        RewardBroadcastV2 memory b = _armedPacket(1);
        b.capPayloadLender = 0;
        _broadcastV2(b);
        _reportCommitment(1, id);
        (, liability, ) = _com().getCommitmentAccumulation(1, 0);
        assertEq(liability, 0, "a zero ceiling reports a zero lender liability");
        GateDay memory g = _gd(1);
        assertTrue(g.reportSent && g.freshStamped && !g.landed, "fixture: reported, priced fresh, never delivered");
        assertFalse(g.awaitsLender, "Base sends this side nothing fresh: nothing to wait for");

        assertEq(_claim(), 0, "the claim settles the day at zero");
        assertGe(_cursor(), 1, "stored: the fold passed the day");
    }

    /**
     * @notice Cell 9 -- an armed day whose commitment report is NOT sent waits
     *         (Base waits on the same report), yet the report itself flows
     *         while the day is held: the batch accumulates and the send
     *         dispatches. With a positive liability the day still waits for
     *         its delivery, which then pays it.
     * @dev    Mutation: put the rung in `dailyDeltaForCommitment` and the batch
     *         reverts `CommitmentStampNotArrived` -- Base waits on a report
     *         held behind the delivery the report releases (deadlock).
     */
    function test_1944_9_AnUnsentReport_HoldsTheDay_AndTheReportStillFlows() public {
        _armGate(1);
        uint256 id = _owedDay1();
        (, uint256 liability, ) = _com().getCommitmentAccumulation(1, 0);
        assertEq(liability, 0, "fixture: nothing accumulated yet");
        GateDay memory g = _gd(1);
        assertTrue(g.awaitsLender && !g.reportSent, "armed and unreported: unknown, so it waits");
        _expectHeld(1);

        _com().submitCommitmentBatch(1, 0, _one(id));
        (, liability, ) = _com().getCommitmentAccumulation(1, 0);
        assertEq(liability, NEED, "stored: the batch accumulated the capped need while held");
        _com().sendCommitmentReport(1);
        assertEq(messenger.lastCommitSendDay(), 1, "the report dispatched");
        assertEq(messenger.lastCommitLiabilityLender18(), NEED, "carrying the liability");
        assertTrue(_gd(1).reportSent, "stored: sent");
        assertTrue(_awaits(0, 1), "a positive liability: Base funds that leg, so the day waits for it");
        _expectHeld(1);

        bytes32 h = _liveOf(NEED, _one(1), 91, keccak256("gate-9"));
        _prove(h, _one(1));
        assertEq(_claim(), NEED, "landed: pays");
    }

    // ─────────────────────── cell 10: era quarantine ───────────────────────

    /**
     * @notice Cell 10 -- QUARANTINED packets fund nothing: a legacy delivery
     *         listing a retired-era day and a d6 dispatched for a retired era
     *         are refused by BOTH proof entries and by the rollout admission,
     *         by name, and the day stays held. Classified final -- the
     *         quarantine's own exit -- the flat proof lands the day.
     * @dev    Mutations: drop the proof entries' quarantine refusal, or the
     *         rollout clause (`ROLLOUT_ERA_QUARANTINED`), and the matching
     *         expectation fails; the admission would open the epoch the
     *         ingress refused and land the day through its index.
     */
    function test_1944_10_AQuarantinedPacket_IsRefused_UntilClassifiedFinal() public {
        _armGate(1);
        _owedDay1();
        _detach();
        _reattach();
        uint64 era = _eraF().getCustodyEraCurrent();
        assertEq(era, 2, "fixture: two effective role changes after arming");
        assertTrue(_awaits(0, 1), "fixture: day 1 still owes fresh and waits");

        bytes32 hQ = _untyped(4e18, _one(1), 101, keccak256("gate-q-legacy"));
        (bytes32 hD, bytes32[] memory leaves) = _d6(10e18, _one(1), 102, keccak256("gate-q-d6"), 0, 1);
        GatePacket memory pq = _gp(hQ);
        assertTrue(pq.quarantined && !pq.classificationFinal && !pq.batched, "fixture: the legacy packet is quarantined");
        GatePacket memory pd = _gp(hD);
        assertTrue(pd.quarantined && !pd.batched, "fixture: the retired-era d6 is quarantined");

        vm.expectRevert(abi.encodeWithSelector(TransportPacketEraQuarantined.selector, hQ));
        _epoch().proveDeliveryDayList(hQ, _one(1));
        vm.expectRevert(abi.encodeWithSelector(TransportPacketEraQuarantined.selector, hQ));
        _epoch().admitLegacyTransportBatch(hQ, _one(1));
        vm.expectRevert(abi.encodeWithSelector(TransportPacketEraQuarantined.selector, hD));
        _epoch().proveDeliveryDayChunk(hD, 0, _one(1), MerkleFixture.proof(leaves, 0));

        GateDay memory g = _gd(1);
        assertFalse(g.landed, "nothing landed");
        assertEq(g.epochCount, 0, "no epoch was opened");
        assertTrue(g.awaitsLender, "held");
        _expectHeld(1);

        AdminFacet(address(diamond)).pause();
        RewardReconciliationFacet(address(diamond)).classifyLegacyPacket(hQ, 0, 4e18, keccak256("gate-q-final"));
        AdminFacet(address(diamond)).unpause();
        assertTrue(_gp(hQ).classificationFinal, "stored: classified final");

        vm.expectEmit(true, true, false, true, address(diamond));
        emit DayDeliveryProved(1, hQ, 101, ROUTE_LIST);
        _epoch().proveDeliveryDayList(hQ, _one(1));
        g = _gd(1);
        assertTrue(g.landed, "the final packet lands the day");
        assertEq(g.provedBy, hQ, "stored: its stamp");
        assertFalse(g.awaitsLender, "open");
        _assertNotTheGate("once landed the claim is never held by the gate");
    }

    /**
     * @notice Cell 10b (S2-R1) -- the setter refuses a mirror past custody era
     *         zero (every d6 would land quarantined with no fresh exit), and a
     *         non-Mirror between the two role changes. Straddle: at era zero
     *         the same arming succeeds.
     * @dev    Mutation: drop the era check and the arming succeeds at era 2.
     */
    function test_1944_10b_TheSetter_RefusesAMirrorPastEraZero() public {
        uint256 snap = vm.snapshotState();
        _armGate(1);
        vm.revertToState(snap);

        _detach();
        vm.expectRevert(DeliveryGateNotMirror.selector);
        _remit().setDayDeliveryGateFromDay(1);
        _reattach();
        uint64 era = _eraF().getCustodyEraCurrent();
        assertGt(era, 0, "fixture: a mirror again, past era zero");
        vm.expectRevert(abi.encodeWithSelector(DeliveryGateEraRegistryPending.selector, era));
        _remit().setDayDeliveryGateFromDay(1);
        assertFalse(_gd(1).gateArmed, "stored: the gate stays dark");
    }

    /**
     * @notice Cell 10c (S1) -- a packet whose value was DISPOSED of funds no
     *         day: its proof is refused by name. Straddle: undisposed, the same
     *         packet proves.
     * @dev    Mutation: drop the `disposed == 0` refusal and the packet marks.
     */
    function test_1944_10c_ADisposedPacket_IsRefused() public {
        _armGate(1);
        bytes32 h = _liveOf(NEED, _one(1), 111, keccak256("gate-disposed"));
        uint256 snap = vm.snapshotState();
        _prove(h, _one(1));
        assertEq(_gd(1).provedBy, h, "straddle: undisposed, the packet proves");
        vm.revertToState(snap);

        _setPacketDisposedRaw(h, 1);
        assertEq(_gp(h).disposed, 1, "fixture: one wei disposed");
        vm.expectRevert(abi.encodeWithSelector(DeliveryPacketDisposed.selector, h, uint256(1)));
        _epoch().proveDeliveryDayList(h, _one(1));
        assertFalse(_gd(1).landed, "nothing marked");
    }

    // ─────────────────────── cell 11: one chokepoint ───────────────────────

    /**
     * @notice Cell 11a -- the expiry clock and the previews share the rung:
     *         while held, an ADVANCING caller cannot pass the day, the static
     *         preview prices nothing, the clock's predicate reads
     *         non-executable, the sweep never starts the clock across four
     *         weeks of sweeps, and preview-by-execution defers by name. Proven,
     *         every one of them comes alive.
     * @dev    Mutation: route any of these readers around rung A (a second,
     *         per-site guard that a refactor drops) and the clock starts on an
     *         unfunded day -- the never-started assertions fail.
     *         A DOMAIN's preparation, which prices days ahead of the fold, is
     *         cell 11d; a running countdown beside a held day is cell 11c. A
     *         single staging record's re-pricing (`prepareStagedDay`) is not
     *         exercised: a record is created only for a day a walk, an expiry
     *         or a domain had ALREADY priced, so its day sits at or below the
     *         fold's cursor, which never retreats and at or below which the
     *         setter refuses to arm -- the rung cannot hold it. That is a
     *         reachability argument, not a measurement.
     */
    function test_1944_11a_TheExpiryClockAndThePreviews_ShareTheRung() public {
        _armGate(1);
        uint256 id = _owedDay1();
        _cfg().setRewardClaimHorizonDays(180);
        bytes32 h = _liveOf(NEED, _one(1), 121, keccak256("gate-clock"));
        uint256[] memory ids = _one(id);

        _mut().userClaimFundingNeedRaw(alice);
        assertEq(_cursor(), 0, "stored: even an advancing caller leaves the fold before the held day");
        assertEq(RewardEpochViewFacet(address(diamond)).getUserArmedFreshNeed(alice), 0, "the static preview prices nothing");
        assertFalse(_mut().entryExecutableNowRaw(id), "the clock's predicate reads non-executable");
        for (uint256 i; i < 4; ++i) {
            assertEq(_sweeper().sweepExpiredInteractionRewards(ids), 0, "the sweep settles nothing");
            (uint64 first, uint64 expiresAt) = _irlens().getRewardEntryExpiry(id);
            assertEq(first, 0, "stored: the clock never starts on a held day");
            assertEq(expiresAt, 0, "so there is no countdown");
            vm.warp(vm.getBlockTimestamp() + 7 days);
        }
        _expectHeld(1);

        _prove(h, _one(1));
        _mut().userClaimFundingNeedRaw(alice);
        assertEq(_cursor(), 1, "stored: proven, the fold passes the day");
        assertEq(RewardEpochViewFacet(address(diamond)).getUserArmedFreshNeed(alice), NEED, "the static preview prices it");
        assertTrue(_mut().entryExecutableNowRaw(id), "the clock's predicate reads executable");
        assertEq(_sweeper().sweepExpiredInteractionRewards(ids), 0, "the first executable sweep stamps only");
        (uint64 started, uint64 deadline) = _irlens().getRewardEntryExpiry(id);
        assertGt(started, 0, "stored: the clock started");
        assertGt(uint256(deadline), block.timestamp, "and counts down");
        (uint256 previewed, , ) = previewByExecution(alice);
        assertEq(previewed, NEED, "preview-by-execution pays it");
    }

    /**
     * @notice Cell 11b -- the FORFEIT sweep shares the rung: held, it credits
     *         nothing and moves nothing; proven, it settles the forfeited
     *         share into the bucket.
     * @dev    Mutation: as 11a -- a forfeit pricing around the rung recycles a
     *         share of a day this chain was never funded for.
     */
    function test_1944_11b_TheForfeitSweep_CreditsNothingWhileHeld() public {
        _armGate(1);
        uint256 id = _owedDay1();
        _mut().setRewardEntryForfeitedRaw(id);
        _mut().setLoanActiveLenderEntryId(LOAN, id);
        bytes32 h = _liveOf(NEED, _one(1), 122, keccak256("gate-forfeit"));
        uint256 bucket = _cfg().getRecycleBucket();
        uint256 live = _live();

        assertEq(InteractionRewardsFacet(address(diamond)).sweepForfeitedInteractionRewards(LOAN), 0, "held: nothing settles");
        assertEq(_cfg().getRecycleBucket(), bucket, "no credit to the bucket");
        assertEq(_live(), live, "and the live row is untouched");

        _prove(h, _one(1));
        uint256 swept = InteractionRewardsFacet(address(diamond)).sweepForfeitedInteractionRewards(LOAN);
        assertEq(swept, NEED, "proven: the forfeit settles the capped share");
        assertEq(_cfg().getRecycleBucket() - bucket, swept, "recycled into the bucket");
    }

    /// @dev The (alice, lender) staging domain's progress scalars.
    function _domainOf() internal view returns (uint8 phase, uint64 prepared, uint64 lastDay, uint32 records) {
        (, phase, , lastDay, prepared, , , , records, , , , ) =
            RewardStagingDomainFacet(address(diamond)).getStagingDomain(alice, LibVaipakam.RewardSide.Lender);
    }

    /// @dev The phase of alice's lender staging record for day `d`.
    function _recordPhase(uint256 d) internal view returns (uint8) {
        return RewardEpochViewFacet(address(diamond)).getStagingRecord(
            LibRewardCustody.stagingKey(alice, LibVaipakam.RewardSide.Lender, d)
        ).phase;
    }

    /**
     * @notice Cell 11c -- a HELD later day never touches a RUNNING countdown.
     *         Entry A's day landed and its clock started; entry B's day is
     *         held. Across four sweeps a week apart A's deadline stands still
     *         -- its clock runs, because the claimant CAN claim A (the static
     *         preview prices exactly A) -- while B's clock never starts.
     *         Proven, day 2 no longer waits and the claim pays both days.
     *         (B's clock would start only once B reaches its side's front --
     *         the A2-iii static read files an entry behind a pending day as
     *         not executable -- so after the proof the claim is the evidence.)
     * @dev    Mutations: route the sweep's clock around rung A and B's clock
     *         starts on an unfunded day; hold the whole claim instead of the
     *         day and A's sweep observes a block, so its deadline moves and
     *         the claimant loses window time to a delivery that is not theirs.
     *
     *         WHY this, and not "the gate freezes a running countdown": the
     *         gate cannot reach a started clock. A clock starts only once the
     *         side's fold covers the entry's WHOLE window (the sweep returns
     *         before the clock while `cursor < endDay - 1`); the fold halts
     *         BEFORE a held day; the setter refuses to arm at or below either
     *         cursor; and the predicate is one-way for a day the fold passed.
     *         So every day of a started entry is landed or owes nothing, and
     *         `rewardEntryObsBlocked` pauses a running clock only for the
     *         deferrals that can follow a start (a delivered shortfall, a
     *         drought, a pause, a sanction). A block observed by the sweep
     *         leaves the stored elapsed time unchanged, so it would show here
     *         as a deadline moving with the warp: the unchanged deadline is
     *         the stored evidence that no block was recorded.
     */
    function test_1944_11c_AHeldLaterDay_NeverFreezesARunningCountdown() public {
        _armGate(1);
        _loanSideOpen(2);
        _closeLocal(1, 1e18, 0);
        _broadcastV2(_armedPacket(1));
        _closeLocal(2, 1e18, 0);
        _broadcastV2(_armedPacket(2));
        uint256 a = _entry(1, 2);
        uint256 b = _entry(2, 3);
        _cfg().setRewardClaimHorizonDays(180);
        bytes32 h1 = _liveOf(2 * NEED, _one(1), 131, keccak256("gate-11c-a"));
        _prove(h1, _one(1));
        bytes32 h2 = _liveOf(NEED, _one(2), 132, keccak256("gate-11c-b"));
        uint256[] memory ids = _two(a, b);
        assertTrue(_awaits(0, 2), "fixture: day 2 owes fresh and its delivery is unproven");

        // One second past setUp's pause boundary: the clock treats an observation
        // in the boundary's own block as spanning the pause and drops the next
        // interval, which would read here as a block the gate never recorded.
        vm.warp(vm.getBlockTimestamp() + 1);
        assertEq(_sweeper().sweepExpiredInteractionRewards(ids), 0, "the first sweep stamps only");
        (uint64 aStart, uint64 aDeadline) = _irlens().getRewardEntryExpiry(a);
        assertGt(aStart, 0, "stored: A's landed day starts its clock");
        assertEq(_cursor(), 1, "stored: the fold rests before the held day");
        for (uint256 i; i < 4; ++i) {
            vm.warp(vm.getBlockTimestamp() + 6 days);
            assertEq(_sweeper().sweepExpiredInteractionRewards(ids), 0, "nothing expires");
            (, uint64 deadline) = _irlens().getRewardEntryExpiry(a);
            assertEq(deadline, aDeadline, "A's countdown runs: a recorded block would move its deadline");
            assertTrue(_mut().entryExecutableNowRaw(a), "A stays executable");
            (uint64 bStart, ) = _irlens().getRewardEntryExpiry(b);
            assertEq(bStart, 0, "stored: B's held day starts no clock");
        }
        assertEq(
            RewardEpochViewFacet(address(diamond)).getUserArmedFreshNeed(alice),
            NEED,
            "the claimant can claim A, and only A"
        );

        _prove(h2, _one(2));
        assertFalse(_awaits(2, 2), "stored: proven, day 2 no longer waits");
        assertEq(_claim(), 2 * NEED, "and the claim pays both days");
    }

    /**
     * @notice Cell 11d -- DOMAIN preparation shares the rung. A claim whose
     *         armed extent exceeds one chunk opens its domain and prepares a
     *         record per day; at a held day the preparation PAUSES -- no
     *         record for that day, nothing charged, the claim paying nothing
     *         as a domain always does -- and the same claim resumes from that
     *         day once its delivery is proven.
     * @dev    Reachable where a single record's re-pricing is not: the
     *         domain's extent is fixed by its entries' `endDay`s when it opens
     *         and runs AHEAD of the fold, so `_prepareDomainDays` prices days
     *         the fold has not passed, through `processUserSideDay`, which
     *         defers at `_rpnReady`. Mutation: exempt the preparation path from
     *         the rung (a per-site bypass) and day 5 is staged before its
     *         delivery lands -- the `preparedThrough` and record-phase
     *         assertions fail.
     */
    function test_1944_11d_ADomainPreparation_PausesAtAHeldDay_AndResumesOnceProven() public {
        uint32 n = 32; // > MAX_INTERACTION_CLAIM_DAYS (30): the side is a domain
        _armGate(1);
        _loanSideOpen(n);
        for (uint256 d = 1; d <= n; ++d) {
            _closeLocal(d, 1e18, 0);
            _broadcastV2(_armedPacket(d));
        }
        _entry(1, n + 1);
        bytes32 hA = _liveOf(20e18, _days(4, 1), 141, keccak256("gate-11d-a"));
        _prove(hA, _days(4, 1));
        bytes32 hB = _liveOf(1e18, _days(n - 4, 5), 142, keccak256("gate-11d-b"));
        assertFalse(_awaits(0, 4), "fixture: day 4 landed");
        assertTrue(_awaits(0, 5), "fixture: day 5 owes fresh and its delivery is unproven");

        uint256 paidBefore = _mut().getArmedFreshPaidRaw();
        assertEq(_claim(), 0, "a domain pays nothing while it prepares");
        (uint8 phase, uint64 prepared, uint64 lastDay, uint32 records) = _domainOf();
        assertEq(phase, uint8(LibVaipakam.DomainPhase.Staging), "stored: the domain opened and prepares");
        assertEq(lastDay, n, "over the whole committed extent");
        assertEq(prepared, 4, "stored: the preparation PAUSED at the held day");
        assertEq(records, 4, "a record for each landed day only");
        assertEq(_recordPhase(4), uint8(LibVaipakam.StagingPhase.Staging), "the last landed day is staged");
        assertEq(_recordPhase(5), uint8(LibVaipakam.StagingPhase.None), "nothing staged for the held day");
        assertEq(_mut().getArmedFreshPaidRaw(), paidBefore, "nothing fresh charged");
        assertEq(_cursor(), 4, "stored: the fold rests before the held day");

        _prove(hB, _days(n - 4, 5));
        assertEq(_claim(), 0, "proven: the same claim resumes the preparation");
        (phase, prepared, , records) = _domainOf();
        assertEq(phase, uint8(LibVaipakam.DomainPhase.Staging), "still preparing, nothing paid");
        assertEq(prepared, n, "stored: through the extent's last day");
        assertEq(records, n, "a record per day");
        assertEq(_recordPhase(5), uint8(LibVaipakam.StagingPhase.Staging), "the once-held day is staged");
    }

    // ─────────────────────── cell 14: dark and below the gate ───────────────────────

    /**
     * @notice Cell 14a -- the gate DARK pays an owed, unproven day as today;
     *         the arming is one-shot afterwards, and zero is refused.
     * @dev    Mutation: drop step 1 (the latch) and the dark claim waits.
     */
    function test_1944_14a_TheDarkGate_PaysAsToday_AndArmsOnce() public {
        _owedDay1();
        _liveOf(NEED, _one(1), 141, keccak256("gate-dark"));
        GateDay memory g = _gd(1);
        assertFalse(g.gateArmed, "dark");
        assertTrue(g.stamped && g.reported && !g.landed, "fixture: an owed, unproven day");
        assertFalse(g.awaitsLender, "dark: nothing waits");
        assertEq(_claim(), NEED, "pays as today");

        _armGate(5);
        vm.expectRevert(abi.encodeWithSelector(DeliveryGateAlreadyArmed.selector, uint256(5)));
        _remit().setDayDeliveryGateFromDay(1);
        vm.expectRevert(InvalidAmount.selector);
        _remit().setDayDeliveryGateFromDay(0);
        assertFalse(_gd(1).gateArmed, "stored: still from day 5");
    }

    /**
     * @notice Cell 14b -- a day BELOW the gate's first day pays as today, the
     *         first day at it waits: one claim pays day 2 and parks on day 3,
     *         the next names day 3, the proof pays it.
     * @dev    Mutation: drop the `d < fromDay` exit and day 2 waits too -- the
     *         first claim reverts by name instead of paying.
     */
    function test_1944_14b_ADayBelowTheGate_PaysAsToday() public {
        _armGate(3);
        _loanSideOpen(2);
        for (uint256 d = 1; d <= 3; ++d) {
            _closeLocal(d, 1e18, 0);
            _broadcastV2(_armedPacket(d));
        }
        _entry(2, 4);
        bytes32 h = _liveOf(2 * NEED, _two(2, 3), 142, keccak256("gate-below"));
        assertFalse(_awaits(2, 2), "day 2 is below the gate");
        assertTrue(_awaits(2, 3), "day 3 is at it, owed and unproven");

        assertEq(_claim(), NEED, "day 2 pays as today; the walk parks on day 3");
        _expectHeld(3);
        _prove(h, _two(2, 3));
        assertEq(_claim(), NEED, "proven, day 3 pays");
        assertEq(vpfi.balanceOf(alice), 2 * NEED, "both days, once each");
    }

    /**
     * @notice Cell 14c -- the arming refuses a first day AT or BELOW either fold
     *         cursor: the fold priced that day without the gate and the walk may
     *         already have paid it, so arming under the cursor would claim a
     *         hold the stored state no longer honours. The straddle: one day
     *         above both cursors arms.
     * @dev    Mutation: drop the fold check and the arming at the cursor
     *         succeeds -- the expected revert is not raised.
     */
    function test_1944_14c_TheArming_RefusesADayAtOrBelowTheFold() public {
        _owedDay1();
        _liveOf(NEED, _one(1), 143, keccak256("gate-below-fold"));
        assertEq(_claim(), NEED, "fixture: the dark gate pays day 1");
        (uint256 lc, , , , ) = _mut().getCumStateRaw(0, 0);
        (uint256 bc, , , , ) = _mut().getCumStateRaw(1, 0);
        uint256 top = lc > bc ? lc : bc;
        assertGe(lc, 1, "fixture: the lender fold has passed day 1");

        vm.expectRevert(abi.encodeWithSelector(DeliveryGateBelowFold.selector, top, lc, bc));
        _remit().setDayDeliveryGateFromDay(top);
        vm.expectRevert(abi.encodeWithSelector(DeliveryGateBelowFold.selector, uint256(1), lc, bc));
        _remit().setDayDeliveryGateFromDay(1);
        assertFalse(_gd(top + 1).gateArmed, "stored: the gate stays dark");

        _armGate(top + 1);
    }

    // ─────────────────────── cell 15: replays ───────────────────────

    /**
     * @notice Cell 15 -- a replayed broadcast is idempotent and never touches
     *         the mark: before the proof it does not land the day, after the
     *         proof the mark stands, and a diverging replay reverts.
     * @dev    Mutation: write the mark (or clear it) in the broadcast apply and
     *         one of the two stored-mark assertions fails.
     */
    function test_1944_15_AReplayedBroadcast_IsIdempotent_AndNeverTheMark() public {
        _armGate(1);
        _owedDay1();
        _broadcastV2(_armedPacket(1));
        assertTrue(_awaits(0, 1), "a replay is not a delivery");
        assertFalse(_gd(1).landed, "stored: nothing landed");

        bytes32 h = _liveOf(NEED, _one(1), 151, keccak256("gate-replay"));
        _prove(h, _one(1));
        _broadcastV2(_armedPacket(1));
        assertEq(_gd(1).provedBy, h, "stored: the mark survives a replay");

        RewardBroadcastV2 memory diverged = _armedPacket(1);
        diverged.freshLenderHalf = 2e18;
        _rep().setRewardMessenger(address(messenger));
        vm.expectRevert(KnownGlobalAlreadySet.selector);
        messenger.deliverBroadcastV2(diverged);
        assertEq(_gd(1).provedBy, h, "stored: and a diverging one");
        assertEq(_claim(), NEED, "the day pays once");
    }

    // ─────────────────────── cell 16: idempotent proofs ───────────────────────

    /**
     * @notice Cell 16 -- the flat proof is idempotent PER DAY: one event per
     *         day on the first proof, nothing on a repeat, nothing for a
     *         second packet listing a marked day, whose first lister stays.
     * @dev    Mutation: let a later lister overwrite the mark, or emit on a
     *         repeat, and the stored-mark or the log-count assertion fails.
     */
    function test_1944_16_TheProofIsIdempotentPerDay_TheFirstListerStays() public {
        _armGate(1);
        _owedDay1();
        bytes32 hA = _liveOf(NEED, _two(1, 2), 161, keccak256("gate-first"));

        vm.expectEmit(true, true, false, true, address(diamond));
        emit DayDeliveryProved(1, hA, 161, ROUTE_LIST);
        vm.expectEmit(true, true, false, true, address(diamond));
        emit DayDeliveryProved(2, hA, 161, ROUTE_LIST);
        _prove(hA, _two(1, 2));

        vm.recordLogs();
        _prove(hA, _two(1, 2));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_provedLogs(logs, 1) + _provedLogs(logs, 2), 0, "a repeat proof writes and emits nothing");

        bytes32 hB = _liveOf(1, _one(2), 162, keccak256("gate-second"));
        vm.recordLogs();
        _prove(hB, _one(2));
        logs = vm.getRecordedLogs();
        assertEq(_provedLogs(logs, 2), 0, "a second lister emits nothing");
        assertEq(_gd(2).provedBy, hA, "stored: the first lister stays");
        assertEq(_gd(1).provedBy, hA, "stored: on every day it listed");
        assertEq(_claim(), NEED, "and the proven day pays");
    }

    // ─────────────────────── cell 17: ingress writes no day ───────────────────────

    /**
     * @notice Cell 17 -- INGRESS writes nothing per day, on every wire: a typed
     *         d5, an untyped legacy delivery and a d6 all land their value and
     *         none lands the day (the 300k destination budget is spent). The
     *         batch index then lands it (term i), and the attested epoch pays.
     * @dev    Mutation: add a per-day write at any ingress and a `landed`
     *         assertion right after it fails.
     */
    function test_1944_17_IngressWritesNothingPerDay() public {
        _armGate(1);
        _owedDay1();

        bytes32 h5 = _liveOf(NEED, _one(1), 171, keccak256("gate-i-typed"));
        assertFalse(_gd(1).landed, "a typed delivery's ingress lands no day");
        GatePacket memory p5 = _gp(h5);
        assertEq(p5.dayListHash, keccak256(abi.encode(_one(1))), "stored: its commitment, for the proof to come");
        assertFalse(p5.batched, "and no epoch");

        bytes32 hU = _untyped(10e18, _one(1), 172, keccak256("gate-i-untyped"));
        assertFalse(_gd(1).landed, "an untyped delivery's ingress lands no day");
        assertEq(_gd(1).epochCount, 0, "its epoch opened compactly, indexing nothing");
        assertTrue(_gp(hU).batched, "fixture: the epoch exists");

        (bytes32 h6, ) = _d6(5e18, _one(1), 173, keccak256("gate-i-d6"), 0, 0);
        assertFalse(_gd(1).landed, "a d6 delivery's ingress lands no day");
        assertEq(_gp(h6).chunksIndexed, 0, "stored: no chunk indexed");
        _expectHeld(1);

        _epoch().materializeTransportBatchPage(hU, _one(1));
        GateDay memory g = _gd(1);
        assertTrue(g.landed, "the batch index lands the day");
        assertEq(g.epochCount, 1, "stored: one indexed epoch");
        assertEq(g.provedBy, bytes32(0), "and no mark");

        _attest(172, 1, 0);
        assertEq(_claim(), NEED, "the attested epoch pays");
        (uint256 lf, ) = _epoch().getTransportBatchLegs(hU);
        assertEq(lf, NEED, "stored: from that epoch");
    }
}

/**
 * @title  RewardDayDeliveryGatePreActivationTest -- the gate on a mirror whose
 *         reward custody is NOT yet activated.
 * @notice Cell 5 (a pre-activation d6 takes the typed-ledger path, holds no
 *         batch, and is proven chunk by chunk) and cell 12 (the role exemption).
 */
contract RewardDayDeliveryGatePreActivationTest is RewardDayDeliveryGateBase {
    function _custodyActive() internal pure override returns (bool) {
        return false;
    }

    /**
     * @notice Cell 5 -- a PRE-ACTIVATION d6 holds no epoch: the chunk
     *         materializer refuses it as an unknown batch, the flat route
     *         refuses it as rooted, and `proveDeliveryDayChunk` marks its day
     *         -- once, with the chunk's bit stored -- after which it pays.
     * @dev    Mutation: route the chunk proof through the batch materializer
     *         only and this day can never land.
     */
    function test_1944_5_APreActivationD6_IsProvenByChunk_AndPays() public {
        _armGate(1);
        _owedDay1();
        uint256[] memory list = _days(1, 1);
        bytes32[] memory leaves = RemitWire.d6Chunks(list);
        bytes32 id = keccak256("gate-pre-act-d6");
        _ingress().onRewardBudgetReceivedD6(
            address(vpfi), 10e18, RemitWire.d6Root(leaves), 1, 1, CHAIN_BASE, 51, REMITTER, 0, 10e18, id, 0
        );
        bytes32 h = keccak256(abi.encode(uint256(CHAIN_BASE), id));
        GatePacket memory p = _gp(h);
        assertFalse(p.batched, "fixture: before activation a rooted delivery opens no epoch");
        assertEq(p.dayListRoot, RemitWire.d6Root(leaves), "stored: the commitment");
        assertEq(p.chunkCount, 1);
        _expectHeld(1);

        bytes32[] memory none = new bytes32[](0);
        vm.expectRevert(abi.encodeWithSelector(TransportBatchUnknown.selector, h));
        _epoch().materializeTransportBatchChunk(h, 0, list, MerkleFixture.proof(leaves, 0), none, none);
        vm.expectRevert(abi.encodeWithSelector(TransportBatchRooted.selector, h));
        _epoch().proveDeliveryDayList(h, list);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit DayDeliveryProved(1, h, 51, ROUTE_CHUNK);
        _proveRooted(h, list, leaves, 0);
        assertEq(_gp(h).chunksIndexed, 1, "stored: chunk 0 proven");
        GateDay memory g = _gd(1);
        assertTrue(g.landed, "the proof lands the day");
        assertEq(g.provedBy, h, "stored: by this packet");
        assertEq(g.epochCount, 0, "with no epoch anywhere");

        vm.expectRevert(abi.encodeWithSelector(TransportChunkAlreadyIndexed.selector, h, uint256(0)));
        _proveRooted(h, list, leaves, 0);

        assertEq(_claim(), NEED, "proven: pays");
    }

    /**
     * @notice Cell 12 -- ROLES: the setter refuses every non-Mirror; armed on a
     *         Mirror, the same storage read as Canonical or Unconfigured holds
     *         nothing and pays as today -- the stamp's half where a stamp
     *         landed, the schedule half where none did (the derivation's
     *         byte-identical side). Straddle: as a Mirror the day waits.
     * @dev    Mutation: drop step 2 (the role exit) and Canonical / Unconfigured
     *         wait on a delivery that never comes.
     */
    function test_1944_12_TheCanonicalAndUnconfiguredRoles_AreNeverHeld() public {
        uint256 snap = vm.snapshotState();
        _mut().setRewardRoleRaw(CHAIN_BASE, true, true);
        vm.expectRevert(DeliveryGateNotMirror.selector);
        _remit().setDayDeliveryGateFromDay(1);
        _mut().setRewardRoleRaw(0, false, false);
        vm.expectRevert(DeliveryGateNotMirror.selector);
        _remit().setDayDeliveryGateFromDay(1);
        vm.revertToState(snap);

        uint256 h1 = LibInteractionRewards.halfPoolForDay(1);
        uint256 h2 = LibInteractionRewards.halfPoolForDay(2);
        _armGate(1);
        _closeLocal(1, 100e18, 0);
        _broadcastV2(_unarmedPacket(1, h1));
        _legacyEntry(100e18, 1, 2);
        _mut().setDailyLenderInterest(2, alice, 50e18, 100e18); // day 2: unstamped, the window counter
        _mut().setDayCapThreshold18(2, type(uint256).max);
        uint256 expected = h1 + (h2 * 50e18) / 100e18;
        assertTrue(_awaits(0, 1), "straddle: as a Mirror the unproven day waits");
        _expectHeld(1);

        snap = vm.snapshotState();
        _mut().setRewardRoleRaw(CHAIN_BASE, true, true);
        assertFalse(_awaits(2, 1), "Canonical: Base funds itself, nothing waits");
        assertFalse(_gd(1).awaitsLender, "the operator read agrees");
        _mut().setArmedFreshLedgerRaw(SEED, 0);
        assertApproxEqAbs(_claim(), expected, 1e6, "Canonical pays as today");
        vm.revertToState(snap);

        _mut().setRewardRoleRaw(0, false, false);
        assertFalse(_awaits(2, 1), "Unconfigured: nothing waits");
        assertApproxEqAbs(_claim(), expected, 1e6, "Unconfigured pays as today");
    }
}
