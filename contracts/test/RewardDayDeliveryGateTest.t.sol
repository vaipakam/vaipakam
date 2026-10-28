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
import {LibD6Delivery} from "./helpers/LibD6Delivery.sol";

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
 *         landed: an indexed transport epoch, or a batchless (pre-activation)
 *         packet whose day list was proven chunk by chunk with
 *         `proveDeliveryDayChunk`.
 * @dev    The fixture is the epoch-draw suites' mirror (Arbitrum chain id,
 *         Base as the reward chain, this contract as the remittance receiver).
 *         Days are stamped by REAL broadcasts (the per-destination fields
 *         inside the kind-10 envelope) through
 *         {MockRewardMessenger.deliverBroadcastV2} and closed locally (the
 *         chain's interest totals and `chainReportSentAt`) BEFORE the
 *         broadcast -- the order the production cycle runs in, close then
 *         report then finalize then broadcast. The gate binds by ROLE on every
 *         mirror day, with no arming step (#1944, owner decision 2026-10-26),
 *         so each cell only pins that it binds. Abstract, so no cell runs twice; the two concrete
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
    uint8 internal constant ROUTE_CHUNK = 2;
    bytes32 internal constant PROVED_SIG = keccak256("DayDeliveryProved(uint256,bytes32,uint256,uint8)");

    /// @dev Redeclared so `expectEmit` can name them; the emitters are the
    ///      libraries inlined into the epoch facet.
    event DayDeliveryProved(uint256 indexed dayId, bytes32 indexed packetHash, uint256 remitId, uint8 route);
    event TransportDrawn(bytes32 indexed batchId, uint256 indexed dayId, uint256 fresh, uint256 recycled);

    /// @dev {RewardRemittanceLensFacet.getDayDeliveryState}, named.
    struct GateDay {
        bool gateBinds;
        bool stamped;
        bool freshStamped;
        bool landed;
        bytes32 firstPart;
        uint256 epochCount;
        bool reported;
        bool reportSent;
        bool awaitsLender;
        bool awaitsBorrower;
    }

    /// @dev {RewardRemittanceLensFacet.getPacketDeliveryProof}, named.
    struct GatePacket {
        bytes32 dayListRoot;
        uint32 chunkCount;
        uint256 chunksIndexed;
        bool batched;
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
        // #1944 — the one broadcast wire authenticates Base's era.
        RewardReporterFacet(address(diamond)).setBaseRewardDeployment(address(0xBA5E0E7A));
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

    /// @dev What custody holds that a fresh claim can be paid from: the live
    ///      row and the epochs' unclassified value.
    function _payable() internal view returns (uint256) {
        return _live() + _row(LibVaipakam.RewardCustodyRow.Unclassified);
    }

    // ─── reads ───

    function _gd(uint256 d) internal view returns (GateDay memory v) {
        (
            v.gateBinds,
            v.stamped,
            v.freshStamped,
            v.landed,
            v.firstPart,
            v.epochCount,
            v.reported,
            v.reportSent,
            v.awaitsLender,
            v.awaitsBorrower
        ) = _rlens().getDayDeliveryState(d);
    }

    function _gp(bytes32 h) internal view returns (GatePacket memory v) {
        (
            v.dayListRoot,
            v.chunkCount,
            v.chunksIndexed,
            v.batched,
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

    /// @dev The gate needs no arming: on a mirror it binds by role, from the
    ///      first day. Each cell pins that here, where it used to arm.
    function _gateBinds() internal view {
        assertTrue(_gd(1).gateBinds, "the gate binds on a mirror, with no arming step");
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

    /// @dev A whole-fresh budget delivery on the rooted (d6) wire, the only
    ///      budget shape the receiver accepts, with its days NOT yet landed.
    ///      Before activation it takes the typed-ledger path (counted live,
    ///      no epoch) and its days land through the chunk proof. On an
    ///      activated custody it opens its epoch at ingress: indexing the
    ///      epoch lands its days and makes it drawable, so the epoch is the
    ///      delivery's funding.
    function _liveOf(uint256 amount, uint256[] memory dayIds, uint256 remitId, bytes32 id)
        internal
        returns (bytes32 h)
    {
        (h, ) = _d6(amount, dayIds, remitId, id, 0, 0);
    }

    /// @dev A rooted delivery whose epoch's split is NOT attested (see
    ///      {LibD6Delivery.deliverUnattested}). On an activated custody its
    ///      epoch opens COMPACTLY at ingress; its membership is indexed later.
    function _untyped(uint256 amount, uint256[] memory dayIds, uint256 remitId, bytes32 id)
        internal
        returns (bytes32 h)
    {
        (h, ) = LibD6Delivery.deliverUnattested(
            address(diamond), address(vpfi), amount, dayIds, CHAIN_BASE, remitId, REMITTER, id
        );
    }

    function _attest(uint256 remitId, uint256 fresh, uint256 recycled) internal {
        LibD6Delivery.attest(address(diamond), REMITTER, remitId, fresh, recycled);
    }

    /// @dev Counted LIVE funding with no packet behind it, standing in what a
    ///      typed delivery credited before the rooted wire: on an activated
    ///      custody a budget delivery feeds its epoch, never the live row.
    function _liveFunding(uint256 amount) internal {
        _mut().relocateFreshIngressRaw(amount);
    }

    /// @dev A rooted (d7) delivery as the registered receiver forwards it,
    ///      carrying its day's whole slice as its one part (#918).
    function _d6(uint256 amount, uint256[] memory dayIds, uint256 remitId, bytes32 id, uint256 recycled, uint64 era)
        internal
        returns (bytes32 h, bytes32[] memory leaves)
    {
        (h, leaves) = LibD6Delivery.deliver(address(diamond), _delivery(amount, dayIds, remitId, id, recycled, era));
    }

    /// @dev The rooted delivery {_d6} and {_part} land.
    function _delivery(uint256 amount, uint256[] memory dayIds, uint256 remitId, bytes32 id, uint256 recycled, uint64 era)
        internal
        view
        returns (LibD6Delivery.Delivery memory)
    {
        return LibD6Delivery.Delivery({
            token: address(vpfi),
            amount: amount,
            dayIds: dayIds,
            sourceChainId: CHAIN_BASE,
            remitId: remitId,
            remitter: REMITTER,
            recycled: recycled,
            fresh: amount - recycled,
            messageId: id,
            era: era
        });
    }

    /// @dev #918 — one PART of day `d`: `amount` of which `recycled` is
    ///      recycled, declaring the day's whole (`wholeFresh`, `wholeRecycled`).
    function _part(
        uint256 amount,
        uint256 d,
        uint256 remitId,
        bytes32 id,
        uint256 recycled,
        uint256 wholeFresh,
        uint256 wholeRecycled
    ) internal returns (bytes32 h) {
        (h, ) = LibD6Delivery.deliverPart(
            address(diamond),
            _delivery(amount, _one(d), remitId, id, recycled, 0),
            LibD6Delivery.Part({
                declaredTotal: amount,
                declaredRecycled: recycled,
                wholeFresh: wholeFresh,
                wholeRecycled: wholeRecycled
            })
        );
    }

    /// @dev {RewardRemittanceLensFacet.getDayDeliveryParts}.
    function _parts(uint256 d) internal view returns (LibVaipakam.DayDeliveryParts memory) {
        return _rlens().getDayDeliveryParts(d);
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

    /// @dev Land `dayIds` through packet `h`: a BATCHED packet's epoch is
    ///      indexed chunk by chunk (the epoch route, which writes no mark); a
    ///      batchless one (before activation) is proven chunk by chunk.
    function _prove(bytes32 h, uint256[] memory dayIds) internal {
        bytes32[] memory leaves = RemitWire.d6Chunks(dayIds);
        bool batched = _gp(h).batched;
        for (uint256 c; c < leaves.length; ++c) {
            if (batched) _indexChunk(h, dayIds, leaves, c);
            else _proveRooted(h, dayIds, leaves, c);
        }
    }

    /// @dev Whether day `d` landed through packet `h`: by its epoch's index
    ///      (a batched packet) or by its chunk proof (a batchless one). Either
    ///      way the packet counted the day's part (#918) and, as the day's one
    ///      part, is its first.
    function _landedBy(uint256 d, bytes32 h) internal view returns (bool) {
        GateDay memory g = _gd(d);
        if (!g.landed) return false;
        if (_gp(h).batched) return g.firstPart == h && g.epochCount > 0;
        return g.firstPart == h;
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

    // ─────────────────────── #918: a day in parts (both routes) ───────────────────────

    /**
     * @notice Cell 918-a (both routes: the base runs it activated and not)
     *         -- a day sent in PARTS opens only when the last one lands,
     *         in whatever order they are indexed or proven, and a replayed
     *         packet or chunk counts nothing.
     * @dev    Mutation: land on the first part, or sum a replay, and the held
     *         claim below pays early.
     */
    function test_918_a_ADayInParts_OpensOnlyOnTheLast_InAnyOrder() public {
        _gateBinds();
        _owedDay1();
        bytes32 hA = _part(3e18, 1, 181, keccak256("p-a"), 0, 10e18, 0);
        bytes32 hB = _part(3e18, 1, 182, keccak256("p-b"), 0, 10e18, 0);
        bytes32 hC = _part(4e18, 1, 183, keccak256("p-c"), 0, 10e18, 0);
        _expectHeld(1);

        _prove(hC, _one(1));
        _prove(hA, _one(1));
        LibVaipakam.DayDeliveryParts memory dp = _parts(1);
        assertEq(dp.parts, 2, "stored: two parts counted");
        assertEq(dp.landedFresh, 7e18, "stored: their sum");
        assertEq(dp.wholeFresh, 10e18, "stored: the whole they declared");
        assertEq(dp.firstPacket, hC, "stored: the first to land");
        assertFalse(_gd(1).landed, "two of three parts: still held");
        _expectHeld(1);

        bytes32[] memory leaves = RemitWire.d6Chunks(_one(1));
        bool batched = _gp(hA).batched;
        vm.expectRevert(abi.encodeWithSelector(TransportChunkAlreadyIndexed.selector, hA, uint256(0)));
        if (batched) _indexChunk(hA, _one(1), leaves, 0);
        else _proveRooted(hA, _one(1), leaves, 0);
        vm.expectRevert(abi.encodeWithSelector(IngressPacketReplayed.selector, hA));
        _part(3e18, 1, 181, keccak256("p-a"), 0, 10e18, 0);
        assertEq(_parts(1).landedFresh, 7e18, "a replay counts nothing");

        _prove(hB, _one(1));
        assertTrue(_gd(1).landed, "the last part opens the day");
        assertEq(_parts(1).parts, 3);
        assertEq(_claim(), NEED, "and the claim pays");
    }

    /**
     * @notice Cell 918-b -- PER COMPONENT: a recycled part landing twice
     *         (a released part and its re-send both arrive) does not stand in
     *         for a fresh part still missing.
     * @dev    Mutation: compare the total instead of each component and the day
     *         opens on 8e18 of recycled against a 10e18 whole.
     */
    function test_918_b_ARecycledOverLanding_DoesNotOpenAFreshShortDay() public {
        _gateBinds();
        _owedDay1();
        bytes32 hR1 = _part(4e18, 1, 191, keccak256("r-1"), 4e18, 6e18, 4e18);
        bytes32 hR2 = _part(4e18, 1, 192, keccak256("r-2"), 4e18, 6e18, 4e18);
        _prove(hR1, _one(1));
        _prove(hR2, _one(1));
        LibVaipakam.DayDeliveryParts memory dp = _parts(1);
        assertEq(dp.landedRecycled, 8e18, "stored: the recycled over-landed");
        assertEq(dp.landedFresh, 0);
        assertFalse(_gd(1).landed, "the fresh component is still missing");
        _expectHeld(1);

        bytes32 hF = _part(6e18, 1, 193, keccak256("f-1"), 0, 6e18, 4e18);
        _prove(hF, _one(1));
        assertTrue(_gd(1).landed, "the fresh part opens it");
    }

    /**
     * @notice Cell 918-c -- parts that disagree on the day's whole never
     *         open it: Base locks the whole at the first part, so a
     *         disagreement is a fault to investigate, and it is recorded.
     * @dev    Mutation: let the sums open a conflicted day.
     */
    function test_918_c_PartsThatDisagreeOnTheWhole_NeverOpenTheDay() public {
        _gateBinds();
        _owedDay1();
        bytes32 hA = _part(5e18, 1, 201, keccak256("w-a"), 0, 10e18, 0);
        bytes32 hB = _part(7e18, 1, 202, keccak256("w-b"), 0, 12e18, 0);
        _prove(hA, _one(1));
        _prove(hB, _one(1));
        LibVaipakam.DayDeliveryParts memory dp = _parts(1);
        assertTrue(dp.wholeConflict, "stored: the conflict");
        assertEq(dp.wholeFresh, 10e18, "the first part's whole stands");
        assertGe(dp.landedFresh, dp.wholeFresh, "fixture: the sums would otherwise open it");
        assertFalse(_gd(1).landed, "a conflicted day does not open");
        _expectHeld(1);
    }

    // ─── #2961 option B — skipping a conflicted day ───

    /// @dev Day 1 owed and CONFLICTED (two parts declaring different wholes);
    ///      day 2 owed behind it and fully delivered. Returns the two day-1
    ///      packets.
    function _conflictedDay1ThenOwedDay2() internal returns (bytes32 hA, bytes32 hB) {
        _gateBinds();
        _owedDay1();
        _closeLocal(2, 1e18, 0);
        _broadcastV2(_armedPacket(2));
        _entry(2, 3);
        hA = _part(5e18, 1, 501, keccak256("skip-a"), 0, 10e18, 0);
        hB = _part(7e18, 1, 502, keccak256("skip-b"), 0, 12e18, 0);
        _prove(hA, _one(1));
        _prove(hB, _one(1));
        bytes32 h2 = _part(10e18, 2, 503, keccak256("skip-day2"), 0, 10e18, 0);
        _prove(h2, _one(2));
        assertTrue(_parts(1).wholeConflict, "fixture: day 1 is conflicted");
        assertTrue(_gd(2).landed, "fixture: day 2 landed");
    }

    /**
     * @notice Cell 2961-a -- a conflicted day holds every later day until it
     *         is skipped. The skip waits one day from the first conflicting
     *         part, refuses twice, refuses a day with no conflict, and then
     *         the day closes UNPAID while the day behind it pays.
     * @dev    Mutation: skip without zeroing the funding record and day 1
     *         still holds the cursor (or pays from its stamp).
     */
    function test_2961_a_TheSkip_ClosesTheDayUnpaid_AndLaterDaysPay() public {
        _conflictedDay1ThenOwedDay2();
        uint64 conflictAt = _parts(1).conflictAt;
        assertEq(conflictAt, uint64(block.timestamp), "stored: when the conflict was seen");
        _expectHeld(1);

        uint256 readyAt = uint256(conflictAt) + 1 days;
        vm.expectRevert(abi.encodeWithSelector(DayDeliverySkipTooEarly.selector, uint256(1), readyAt));
        _epoch().skipConflictedDay(1);
        vm.expectRevert(abi.encodeWithSelector(DayDeliveryNotConflicted.selector, uint256(2)));
        _epoch().skipConflictedDay(2);

        vm.warp(readyAt);
        vm.prank(makeAddr("gate-stranger"));
        _epoch().skipConflictedDay(1);
        assertEq(_parts(1).skippedAt, uint64(readyAt), "stored: skipped, by anyone, at the warp target");
        assertFalse(_awaits(0, 1), "the gate no longer holds day 1");
        assertFalse(_awaits(1, 1), "on either side");
        vm.expectRevert(abi.encodeWithSelector(DayDeliveryAlreadySkipped.selector, uint256(1)));
        _epoch().skipConflictedDay(1);

        assertEq(_claim(), NEED, "day 2 pays; day 1 gives nothing");
        assertGt(_cursor(), 1, "the fold walked past the skipped day");
    }

    /**
     * @notice Cell 2961-b -- the value that landed for a skipped day moves to
     *         this mirror's recycle bucket, by anyone, repeatably: on an
     *         activated mirror it leaves the day's epochs and lands in the
     *         Recycled row; a second call moves nothing. Before activation the
     *         day holds no epochs and nothing moves. A day not skipped refuses.
     * @dev    Mutation: credit the bucket without drawing the epochs (or the
     *         reverse) and the row assertions fail.
     */
    function test_2961_b_ASkippedDaysValue_Recycles_OnlyAfterTheSkip() public {
        _conflictedDay1ThenOwedDay2();
        vm.expectRevert(abi.encodeWithSelector(DayDeliveryNotSkipped.selector, uint256(1)));
        _epoch().recycleSkippedDayValue(1);
        vm.warp(block.timestamp + 1 days);
        _epoch().skipConflictedDay(1);

        uint256 recycledBefore = _row(LibVaipakam.RewardCustodyRow.Recycled);
        uint256 unclassifiedBefore = _row(LibVaipakam.RewardCustodyRow.Unclassified);
        vm.prank(makeAddr("gate-stranger"));
        uint256 moved = _epoch().recycleSkippedDayValue(1);
        if (_custodyActive()) {
            assertEq(moved, 12e18, "both conflicting parts' value leaves the day");
            assertEq(
                _row(LibVaipakam.RewardCustodyRow.Recycled), recycledBefore + moved, "stored: into the Recycled row"
            );
            assertEq(
                _row(LibVaipakam.RewardCustodyRow.Unclassified),
                unclassifiedBefore - moved,
                "stored: out of the epochs' Unclassified row"
            );
        } else {
            assertEq(moved, 0, "before activation the day holds no epochs");
        }
        assertEq(_epoch().recycleSkippedDayValue(1), 0, "a second call moves nothing");
        assertEq(_claim(), NEED, "and day 2 still pays in full");
    }

    /**
     * @notice Cell 918-e (#2961) -- a DISPOSED delivery's part never counts
     *         toward its day, on either route: the proof refuses it by name,
     *         and the epoch index indexes it but counts no part. One writer
     *         holds the rule, so the two routes cannot disagree.
     * @dev    Mutation: drop the disposed line from `_noteDayDeliveryPart`
     *         and the batched route opens the day on value that left.
     */
    function test_918_e_ADisposedPart_NeverCounts_OnEitherRoute() public {
        _gateBinds();
        _owedDay1();
        bytes32 h = _part(10e18, 1, 401, keccak256("disposed-part"), 0, 10e18, 0);
        _mut().setPacketDisposedRaw(h, 1);
        if (_gp(h).batched) {
            _prove(h, _one(1));
            assertEq(_parts(1).parts, 0, "stored: the index counted no part");
            assertEq(_parts(1).landedFresh, 0, "stored: and no value");
        } else {
            bytes32[] memory leaves = RemitWire.d6Chunks(_one(1));
            vm.expectRevert(abi.encodeWithSelector(DeliveryPacketDisposed.selector, h, uint256(1)));
            _proveRooted(h, _one(1), leaves, 0);
        }
        assertFalse(_gd(1).landed, "a disposed whole opens nothing");
        _expectHeld(1);
    }

    /**
     * @notice Cell 918-d (#2961, scout case 8) -- a day sent in MORE parts
     *         than one draw window scans (65 > `TRANSPORT_DRAW_SCAN_CAP` = 64)
     *         opens on its last part and still pays the claim in full. Each
     *         part on an activated mirror is its own epoch, so the claim's
     *         draw crosses the scan cap.
     * @dev    Mutation: cap the part counter, or stop the draw at 64 epochs,
     *         and the day never opens or the claim pays short.
     */
    function test_918_d_ADayInMoreThan64Parts_OpensOnTheLast_AndPays() public {
        _gateBinds();
        _owedDay1();
        uint256 n = 65;
        uint256 whole = n * 1e17;
        bytes32[] memory hs = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            hs[i] = _part(1e17, 1, 3000 + i, keccak256(abi.encode("p65", i)), 0, whole, 0);
        }
        for (uint256 i; i + 1 < n; ++i) _prove(hs[i], _one(1));
        LibVaipakam.DayDeliveryParts memory dp = _parts(1);
        assertEq(dp.parts, n - 1, "stored: every part but the last counted");
        assertFalse(_gd(1).landed, "one part short: still held");
        _expectHeld(1);

        _prove(hs[n - 1], _one(1));
        dp = _parts(1);
        assertEq(dp.parts, n, "stored: all 65 parts counted");
        assertEq(dp.landedFresh, whole, "stored: their sum is the whole");
        assertTrue(_gd(1).landed, "the 65th part opens the day");

        uint256 paid;
        for (uint256 i; i < 4 && paid < NEED; ++i) {
            (bool ok, bytes memory ret) = _tryClaim();
            if (ok) paid += abi.decode(ret, (uint256));
        }
        assertEq(paid, NEED, "the claim pays in full across the scan cap");
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


    // ─────────────────────── cells 1-2: broadcast first ───────────────────────

    /// @dev Day 1 LANDED by a delivery whose epoch is indexed to list it, and
    ///      the live row funded with NEED beside it, so a fungible bound alone
    ///      would pay day 2 out of it. Day 2 stamped by Base, closed here with
    ///      lender interest, OWED, and listed by nothing that landed. Alice's
    ///      one entry is on day 2.
    function _heldScene() internal returns (uint256 id, bytes32 h1) {
        _gateBinds();
        _loanSideOpen(1);
        _closeLocal(1, 1e18, 0);
        _broadcastV2(_armedPacket(1));
        _closeLocal(2, 1e18, 0);
        _broadcastV2(_armedPacket(2));
        id = _entry(2, 3);
        h1 = _liveOf(NEED, _one(1), 1, keccak256("gate-live-1"));
        _prove(h1, _one(1));
        _liveFunding(NEED);
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
        assertEq(live, NEED, "fixture: the live row is able to pay day 2");

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
        assertTrue(g.gateBinds, "the gate binds day 2");
        assertTrue(g.stamped && g.freshStamped, "Base's stamp prices fresh on day 2");
        assertFalse(g.landed, "nothing listing day 2 has landed");
        assertEq(g.firstPart, bytes32(0), "no part of day 2 has landed");
        assertEq(g.epochCount, 0, "no epoch lists day 2");
        assertTrue(g.reported, "this chain reported day 2");
        assertFalse(g.reportSent, "its commitment report is not sent");
        assertTrue(g.awaitsLender, "the lender side owes fresh: it waits");
        assertFalse(g.awaitsBorrower, "no borrower interest closed here: that side owes nothing");
        assertTrue(_awaits(2, 2), "the either-side form agrees");

        GateDay memory g1 = _gd(1);
        assertTrue(g1.landed, "day 1 landed");
        assertTrue(_landedBy(1, h1), "stored: by the packet proven to list it");
        assertFalse(g1.awaitsLender || g1.awaitsBorrower, "so day 1 is open");
    }

    /**
     * @notice Cell 2 -- the CONTROL: a delivery listing day 2 arrives (still one
     *         proof short: the claim defers by name), then its epoch is
     *         indexed. The day lands, and the same claim pays out of that
     *         epoch with the fold past the day.
     * @dev    Mutation: make the batch index land no day (or another day) and
     *         the claim after it stays held.
     */
    function test_1944_2_TheProofLandsTheDay_AndTheSameClaimPays() public {
        _heldScene();
        bytes32 h2 = _liveOf(NEED, _one(2), 2, keccak256("gate-live-2"));
        _expectHeld(2); // one proof short: the delivery landed its value, not the day

        _prove(h2, _one(2));

        GateDay memory g = _gd(2);
        assertTrue(g.landed, "stored: day 2 landed");
        assertTrue(_landedBy(2, h2), "stored: by the packet proven to list it");
        assertFalse(g.awaitsLender, "nothing waits any more");

        uint256 uncl = _row(LibVaipakam.RewardCustodyRow.Unclassified);
        assertEq(_claim(), NEED, "the proof pays the day");
        assertEq(vpfi.balanceOf(alice), NEED, "to the claimant");
        assertEq(uncl - _row(LibVaipakam.RewardCustodyRow.Unclassified), NEED, "out of its epoch");
        assertGe(_cursor(), 2, "stored: the fold passed day 2");
    }

    // ─────────────────────── cell 3: proof first ───────────────────────

    /**
     * @notice Cell 3 -- PROOF BEFORE THE BROADCAST: a delivery proven to list
     *         day 1 lands before Base's stamp does. The day is landed and not
     *         stamped; before the stamp a claim pays nothing and nothing waits
     *         on the gate; the first claim after the stamp pays.
     * @dev    Mutation: let the broadcast clear or ignore a landing recorded
     *         before it (an order-dependent landed reader) and the claims after
     *         the stamp defer on the gate.
     */
    function test_1944_3_ProofBeforeTheBroadcast_LandsAnUnstampedDay() public {
        _gateBinds();
        _loanSideOpen(1);
        _closeLocal(1, 1e18, 0);
        _entry(1, 2);
        bytes32 h = _liveOf(NEED, _one(1), 31, keccak256("gate-early"));
        _prove(h, _one(1));

        GateDay memory g = _gd(1);
        assertTrue(g.landed, "landed before Base priced it");
        assertFalse(g.stamped, "and not yet stamped");
        assertTrue(_landedBy(1, h), "stored: the early proof");
        assertFalse(_awaits(2, 1), "an unstamped day never waits");

        // On an activated custody the delivery is an epoch, and the entry's
        // pre-arming slice settles through its legacy-slice domain: before the
        // stamp a claim opens that domain and pays nothing, and so does every
        // claim until Base prices the day. Nothing waits on the gate.
        assertEq(_claim(), 0, "a claim before the stamp pays nothing");
        assertEq(_claim(), 0, "and so does the next one");
        assertEq(vpfi.balanceOf(alice), 0, "nothing moved");

        _broadcastV2(_armedPacket(1));
        g = _gd(1);
        assertTrue(g.stamped && g.landed, "stamped after landing");
        assertFalse(g.awaitsLender, "so open");
        assertTrue(_landedBy(1, h), "the stamp left the landing alone");
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
        _gateBinds();
        _owedDay1();
        _expectHeld(1);

        bytes32 h = _d6Whole(10e18, _days(1, 1), 41, keccak256("gate-d6-whole"));
        GateDay memory g = _gd(1);
        assertTrue(g.landed, "the epoch index lands the day");
        assertEq(g.epochCount, 1, "one epoch lists it");
        assertEq(g.firstPart, h, "the index counted the packet's part (#918)");
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
     * @notice Cell 4b (#918) -- only a ONE-DAY packet counts a part: a 20-day
     *         epoch indexed chunk by chunk lands no day (Base funds one day per
     *         send, #2821, and a wider epoch is withheld for good), so the day
     *         stays held until a one-day delivery of it lands.
     * @dev    Mutation: count a part for a wider packet and day 1 opens on the
     *         20-day epoch's index.
     */
    function test_918_4b_AWiderPacket_LandsNoDay() public {
        _gateBinds();
        _owedDay1();
        uint256[] memory list = _days(20, 1);
        (bytes32 h, bytes32[] memory leaves) = _d6(10e18, list, 42, keccak256("gate-d6-part"), 0, 0);
        for (uint256 c; c < leaves.length; ++c) _indexChunk(h, list, leaves, c);
        GateDay memory g = _gd(1);
        assertEq(g.epochCount, 1, "stored: the day's index holds the epoch");
        assertFalse(g.landed, "but a wider packet carries no day's part");
        assertEq(_parts(1).parts, 0, "stored: no part counted");
        _expectHeld(1);

        bytes32 h1 = _d6Whole(10e18, _one(1), 43, keccak256("gate-one-day"));
        assertTrue(_landedBy(1, h1), "the one-day delivery lands it");
        assertEq(_claim(), NEED, "and pays");
    }

    // ─────────────────────── cell 5: the batched refusals ───────────────────────

    /**
     * @notice Cell 5 (activated half) -- the chunk proof refuses, by name,
     *         what it cannot prove: an unknown packet, a BATCHED packet (its
     *         days land through the batch index) and a non-budget packet. None
     *         of them marks anything; the batched packet's own index lands
     *         the day. On an activated custody every budget delivery is
     *         batched, so the index is the only route that lands a day here.
     * @dev    Mutation: let the proof entry accept `batchId != 0` and the
     *         `DeliveryProofRouteIsBatch` expectation fails -- a second
     *         statement of a fact the batch index already owns.
     */
    function test_1944_5_TheProofRoutes_RefuseWhatTheyCannotProve() public {
        _gateBinds();
        bytes32 nobody = keccak256("gate-nobody");
        vm.expectRevert(abi.encodeWithSelector(IngressPacketUnknown.selector, nobody));
        _epoch().proveDeliveryDayChunk(nobody, 0, _one(1), new bytes32[](0));

        (bytes32 h6, bytes32[] memory leaves) = _d6(5e18, _one(1), 51, keccak256("gate-batched-d6"), 0, 0);
        assertTrue(_gp(h6).batched, "fixture: on an activated custody a d6 opens its epoch at ingress");
        vm.expectRevert(abi.encodeWithSelector(DeliveryProofRouteIsBatch.selector, h6));
        _epoch().proveDeliveryDayChunk(h6, 0, _one(1), MerkleFixture.proof(leaves, 0));

        bytes32 hC = _compensation(53, keccak256("gate-comp"));
        vm.expectRevert(
            abi.encodeWithSelector(DeliveryProofNotBudget.selector, hC, LibRewardCustody.PACKET_KIND_COMPENSATION)
        );
        _epoch().proveDeliveryDayChunk(hC, 0, _one(7), new bytes32[](0));

        GateDay memory g = _gd(1);
        assertFalse(g.landed, "no refused proof marked anything; no epoch was indexed");
        assertEq(g.firstPart, bytes32(0));

        _prove(h6, _one(1));
        assertTrue(_landedBy(1, h6), "the batched packet's own index lands the day");
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
        _gateBinds();
        _closeLocal(1, 100e18, 0);
        _broadcastV2(_unarmedPacket(1, h1));
        _mut().setDailyLenderInterest(1, alice, 50e18, 100e18); // the window counter
        _legacyEntry(50e18, 1, 2); // and the legacy entry, same day
        bytes32 h = _liveOf(2 * h1, _one(1), 61, keccak256("gate-pre-dstar"));
        // The legacy window half is live-paid: the claim weighs it against
        // LIVE backing, which an activated custody's budget delivery never
        // credits (it feeds its epoch). Live funding stands it in here. The
        // window counter itself is a fixture: no production path writes one
        // (real loans accrue through reward entries), so this cell pins the
        // gate's two rungs, not a live funding route.
        _liveFunding(2 * h1);
        assertTrue(_gd(1).awaitsLender, "fixture: no D*, yet the unarmed day owes fresh and waits");

        uint256 snap = vm.snapshotState();
        _prove(h, _one(1));
        // The window half pays on the first claim, which also prepares the
        // legacy slice's domain; the next claim pays the slice.
        uint256 livePaid = _claim();
        livePaid += _claim();
        assertApproxEqAbs(livePaid, h1, 1e6, "LIVE: proven, the window half and the legacy slice both pay");
        vm.revertToState(snap);

        uint256 live = _payable();
        _expectHeld(1);
        assertEq(_payable(), live, "nothing paid while held");
        assertEq(_mut().advanceCumThroughRaw(0, 1), 0, "the fold halts before the unarmed day too");

        _prove(h, _one(1));
        uint256 paid = _claim();
        paid += _claim();
        assertEq(paid, livePaid, "the held claims pay exactly what the proven-first claims paid");
        assertEq(live - _payable(), paid, "out of custody");
    }

    // ─────────────────────── cell 7: zero slices never wait ───────────────────────

    /// @dev Day 1 is the zero-slice day under test; day 2 is a funded, owed
    ///      day behind it that alice claims, listed by an unproven delivery.
    function _zeroSliceThenOwedDay2(RewardBroadcastV2 memory day1, uint256 lender1, uint256 borrower1)
        internal
        returns (bytes32 h2)
    {
        _gateBinds();
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
        _gateBinds();
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
     * @notice Cell 7d (S1-R1) -- the derivation fix, nothing held: an UNARMED day
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
        _liveFunding(h2);
        assertTrue(_gd(1).gateBinds, "fixture: the gate binds");
        assertFalse(_awaits(2, 1) || _awaits(2, 2), "neither day waits (excluded / never reported): this is the derivation alone");

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
        _liveFunding(sched);
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
        _gateBinds();
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
        _gateBinds();
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

    // ───────────────── cell 10: a retired era's delivery lands ─────────────────

    /**
     * @notice Cell 10 (#1566 PR C revision) -- a delivery for a RETIRED custody era
     *         is not held: a list-bearing delivery naming a retired-era day opens its
     *         epoch in that day's era, so the day LANDS through the epoch's index and
     *         the chunk proof names the epoch route (`DeliveryProofRouteIsBatch`). An
     *         earlier revision quarantined such a packet until an administrator
     *         classified it; the custody-era revision removed every manual step.
     * @dev    Mutation: re-admit a quarantine (refuse the retired-era packet's
     *         epoch) and the day never lands.
     */
    function test_1944_10_ARetiredErasDelivery_LandsThroughItsEpoch() public {
        _gateBinds();
        _owedDay1();
        _detach();
        _reattach();
        assertEq(_eraF().getCustodyEraCurrent(), 2, "fixture: two effective role changes after day 1 was owed");
        assertTrue(_awaits(0, 1), "fixture: day 1 still owes fresh and waits");

        bytes32 h = _untyped(4e18, _one(1), 101, keccak256("gate-retired-era"));
        assertTrue(_gp(h).batched, "the retired-era delivery opened its epoch");
        bytes32[] memory leaves = RemitWire.d6Chunks(_one(1));
        vm.expectRevert(abi.encodeWithSelector(DeliveryProofRouteIsBatch.selector, h));
        _epoch().proveDeliveryDayChunk(h, 0, _one(1), MerkleFixture.proof(leaves, 0));
        assertFalse(_gd(1).landed, "straddle: not before the epoch's index lists the day");
        _indexChunk(h, _one(1), leaves, 0); // the index, as the keeper's pass builds it
        GateDay memory g = _gd(1);
        assertTrue(g.landed, "its epoch's index lands the day");
        assertGt(g.epochCount, 0, "an epoch lists it");
    }

    /**
     * @notice Cell 10b -- the gate follows the ROLE across a role change, with
     *         no setter: detached, it does not bind and nothing waits; a mirror
     *         again past custody era zero, it binds from day 1 and the owed day
     *         waits again (#1566 PR C revision: Base stamps the destination's
     *         reported era and a retired era's delivery opens its epoch, so
     *         binding there wedges nothing). The retired arming selector is not
     *         routed.
     */
    function test_1944_10b_TheGate_FollowsTheRole_PastEraZero() public {
        _owedDay1();
        assertTrue(_awaits(0, 1), "fixture: a mirror's owed, unproven day waits");
        _detach();
        assertFalse(_gd(1).gateBinds, "detached: the gate does not bind");
        assertFalse(_awaits(0, 1), "detached: nothing waits");
        _reattach();
        assertGt(_eraF().getCustodyEraCurrent(), 0, "fixture: a mirror again, past era zero");
        assertTrue(_gd(1).gateBinds, "a mirror again: the gate binds");
        assertTrue(_awaits(0, 1), "and the owed day waits again");
        (bool ok, ) = address(diamond).call(abi.encodeWithSignature("setDayDeliveryGateFromDay(uint256)", uint256(1)));
        assertFalse(ok, "the retired arming setter is not routed");
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
     *         fold's cursor, which never retreats, and the gate bound when
     *         that day was priced (it binds from a mirror's first day, with no
     *         later arming that could re-hold it) -- the rung cannot hold it.
     *         That is a reachability argument, not a measurement.
     */
    function test_1944_11a_TheExpiryClockAndThePreviews_ShareTheRung() public {
        _gateBinds();
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
     * @notice #1499 acceptance -- AWAITING DELIVERY on both readers. Refusal
     *         cause: the day owes fresh value on this mirror and no delivery
     *         proven to list it has landed (rung A). Variable: the proof of
     *         the delivery's day list. Held: the expiry predicate reads false
     *         AND the claim refuses `InteractionDayAwaitingDelivery(1)`.
     *         Proven: predicate true AND the claim pays the day.
     * @dev    Cell 11a pins the predicate and the previews across the same
     *         variable; this cell adds the CLAIM on both sides. The proven
     *         side delivers EXACTLY the need, so it also sits on the delivered
     *         bound's boundary: `>` → `>=` in the predicate's bound test reads
     *         it non-executable while the claim pays, and fails this cell. The
     *         held side is refused twice over (the day prices nothing AND the
     *         read reports it deferred): dropping either the zero-payable or
     *         the `capHit` refusal alone leaves the other refusing, so neither
     *         single mutation fails it.
     */
    function test_1499_AwaitingDelivery_PredicateAndClaimAgree_BothSides() public {
        _gateBinds();
        uint256 id = _owedDay1();
        bytes32 h = _liveOf(NEED, _one(1), 149, keccak256("gate-1499"));
        _mut().userClaimFundingNeedRaw(alice);

        assertFalse(_mut().entryExecutableNowRaw(id), "held: non-executable");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(InteractionDayAwaitingDelivery.selector, 1));
        RewardClaimFacet(address(diamond)).claimInteractionRewards();

        _prove(h, _one(1));
        _mut().userClaimFundingNeedRaw(alice);
        assertTrue(_mut().entryExecutableNowRaw(id), "proven: executable");
        assertEq(_claim(), NEED, "proven: the claim pays the day");
    }

    /**
     * @notice Cell 11b -- the FORFEIT sweep shares the rung: held, it credits
     *         nothing and moves nothing; proven, it settles the forfeited
     *         share into the bucket.
     * @dev    Mutation: as 11a -- a forfeit pricing around the rung recycles a
     *         share of a day this chain was never funded for.
     */
    function test_1944_11b_TheForfeitSweep_CreditsNothingWhileHeld() public {
        _gateBinds();
        uint256 id = _owedDay1();
        _mut().setRewardEntryForfeitedRaw(id);
        _mut().setLoanActiveLenderEntryId(LOAN, id);
        bytes32 h = _liveOf(NEED, _one(1), 122, keccak256("gate-forfeit"));
        uint256 bucket = _cfg().getRecycleBucket();
        uint256 live = _payable();

        assertEq(InteractionRewardsFacet(address(diamond)).sweepForfeitedInteractionRewards(LOAN), 0, "held: nothing settles");
        assertEq(_cfg().getRecycleBucket(), bucket, "no credit to the bucket");
        assertEq(_payable(), live, "and custody is untouched");

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
        return RewardStagingDomainFacet(address(diamond)).getStagingRecord(
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
     *         BEFORE a held day; the gate binds from a mirror's first day, so no
     *         later arming can reach below a cursor; and the predicate is
     *         one-way for a day the fold passed.
     *         So every day of a started entry is landed or owes nothing, and
     *         `rewardEntryObsBlocked` pauses a running clock only for the
     *         deferrals that can follow a start (a delivered shortfall, a
     *         drought, a pause, a sanction). A block observed by the sweep
     *         leaves the stored elapsed time unchanged, so it would show here
     *         as a deadline moving with the warp: the unchanged deadline is
     *         the stored evidence that no block was recorded.
     */
    function test_1944_11c_AHeldLaterDay_NeverFreezesARunningCountdown() public {
        _gateBinds();
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
        _gateBinds();
        _loanSideOpen(n);
        for (uint256 d = 1; d <= n; ++d) {
            _closeLocal(d, 1e18, 0);
            _broadcastV2(_armedPacket(d));
        }
        _entry(1, n + 1);
        // One delivery per day, as the canonical chain sends them (#2821):
        // days 1-4 landed and proven, days 5..n landed and not yet proven.
        bytes32[] memory held = new bytes32[](n + 1);
        for (uint256 d = 1; d <= n; ++d) {
            held[d] = _liveOf(d <= 4 ? 5e18 : 1e18, _one(d), 140 + d, keccak256(abi.encode("gate-11d", d)));
            if (d <= 4) _prove(held[d], _one(d));
        }
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

        for (uint256 d = 5; d <= n; ++d) _prove(held[d], _one(d));
        assertEq(_claim(), 0, "proven: the same claim resumes the preparation");
        (phase, prepared, , records) = _domainOf();
        assertEq(phase, uint8(LibVaipakam.DomainPhase.Staging), "still preparing, nothing paid");
        assertEq(prepared, n, "stored: through the extent's last day");
        assertEq(records, n, "a record per day");
        assertEq(_recordPhase(5), uint8(LibVaipakam.StagingPhase.Staging), "the once-held day is staged");
    }

    // ─────────────────────── cell 14: no arming step ───────────────────────

    /**
     * @notice Cell 14 -- with NO arming step, an owed, unproven day waits from
     *         a mirror's very first day: the claim defers by name and pays
     *         nothing until the proof lands.
     * @dev    Mutation: put any latch or first-day exit back in front of the
     *         role test and this day pays unproven -- the named deferral fails.
     */
    function test_1944_14_AnOwedDay_WaitsFromTheFirstDay_WithNoArmingStep() public {
        _owedDay1();
        _liveFunding(NEED);
        GateDay memory g = _gd(1);
        assertTrue(g.gateBinds, "the gate binds with nothing armed");
        assertTrue(g.stamped && g.reported && !g.landed, "fixture: an owed, unproven day");
        assertTrue(g.awaitsLender, "day 1 waits");
        uint256 live = _payable();
        _expectHeld(1);
        assertEq(_payable(), live, "nothing paid while held");
        assertEq(vpfi.balanceOf(alice), 0, "nothing reached the claimant");
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
        _gateBinds();
        _owedDay1();
        _broadcastV2(_armedPacket(1));
        assertTrue(_awaits(0, 1), "a replay is not a delivery");
        assertFalse(_gd(1).landed, "stored: nothing landed");

        bytes32 h = _liveOf(NEED, _one(1), 151, keccak256("gate-replay"));
        _prove(h, _one(1));
        _broadcastV2(_armedPacket(1));
        assertTrue(_landedBy(1, h), "stored: the landing survives a replay");

        RewardBroadcastV2 memory diverged = _armedPacket(1);
        diverged.freshLenderHalf = 2e18;
        _rep().setRewardMessenger(address(messenger));
        vm.expectRevert(KnownGlobalAlreadySet.selector);
        messenger.deliverBroadcastV2(diverged);
        assertTrue(_landedBy(1, h), "stored: and a diverging one");
        assertEq(_claim(), NEED, "the day pays once");
    }

    // ─────────────────────── cell 17: ingress writes no day ───────────────────────

    /**
     * @notice Cell 17 -- INGRESS writes nothing per day: a rooted delivery
     *         lands its value and none of its days, whether its split is
     *         attested at the wire or not. The batch index then lands the day
     *         (term i), and the attested epoch pays.
     * @dev    Mutation: add a per-day write at the ingress and a `landed`
     *         assertion right after it fails.
     */
    function test_1944_17_IngressWritesNothingPerDay() public {
        _gateBinds();
        _owedDay1();

        bytes32 hU = _untyped(10e18, _one(1), 172, keccak256("gate-i-unattested"));
        assertFalse(_gd(1).landed, "an unattested delivery's ingress lands no day");
        assertEq(_gd(1).epochCount, 0, "its epoch opened compactly, indexing nothing");
        assertTrue(_gp(hU).batched, "fixture: the epoch exists");

        (bytes32 h6, ) = _d6(5e18, _one(1), 173, keccak256("gate-i-d6"), 0, 0);
        assertFalse(_gd(1).landed, "a d6 delivery's ingress lands no day");
        assertEq(_gp(h6).chunksIndexed, 0, "stored: no chunk indexed");
        _expectHeld(1);

        _prove(hU, _one(1));
        GateDay memory g = _gd(1);
        assertTrue(g.landed, "the batch index lands the day");
        assertEq(g.epochCount, 1, "stored: one indexed epoch");
        assertEq(g.firstPart, hU, "its part is the day's first (#918)");

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
 *         batch, and is proven chunk by chunk), cells 10c and 16 (the proof
 *         mark, which only a batchless packet writes) and cell 12 (the role
 *         exemption).
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
        _gateBinds();
        _owedDay1();
        uint256[] memory list = _days(1, 1);
        (bytes32 h, bytes32[] memory leaves) =
            LibD6Delivery.deliver(address(diamond), _delivery(10e18, list, 51, keccak256("gate-pre-act-d6"), 0, 0));
        GatePacket memory p = _gp(h);
        assertFalse(p.batched, "fixture: before activation a rooted delivery opens no epoch");
        assertEq(p.dayListRoot, RemitWire.d6Root(leaves), "stored: the commitment");
        assertEq(p.chunkCount, 1);
        _expectHeld(1);

        bytes32[] memory none = new bytes32[](0);
        vm.expectRevert(abi.encodeWithSelector(TransportBatchUnknown.selector, h));
        _epoch().materializeTransportBatchChunk(h, 0, list, MerkleFixture.proof(leaves, 0), none, none);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit DayDeliveryProved(1, h, 51, ROUTE_CHUNK);
        _proveRooted(h, list, leaves, 0);
        assertEq(_gp(h).chunksIndexed, 1, "stored: chunk 0 proven");
        GateDay memory g = _gd(1);
        assertTrue(g.landed, "the proof lands the day");
        assertEq(g.firstPart, h, "stored: by this packet");
        assertEq(g.epochCount, 0, "with no epoch anywhere");

        vm.expectRevert(abi.encodeWithSelector(TransportChunkAlreadyIndexed.selector, h, uint256(0)));
        _proveRooted(h, list, leaves, 0);

        assertEq(_claim(), NEED, "proven: pays");
    }

    /**
     * @notice Cell 10c (S1) -- a batchless packet whose value was DISPOSED of
     *         funds no day: its chunk proof is refused by name. Straddle: undisposed, the same
     *         packet proves.
     * @dev    Mutation: drop the `disposed == 0` refusal and the packet marks.
     */
    function test_1944_10c_ADisposedPacket_IsRefused() public {
        _gateBinds();
        bytes32 h = _liveOf(NEED, _one(1), 111, keccak256("gate-disposed"));
        uint256 snap = vm.snapshotState();
        _prove(h, _one(1));
        assertEq(_gd(1).firstPart, h, "straddle: undisposed, the packet proves");
        vm.revertToState(snap);

        _setPacketDisposedRaw(h, 1);
        assertEq(_gp(h).disposed, 1, "fixture: one wei disposed");
        bytes32[] memory leaves = RemitWire.d6Chunks(_one(1));
        vm.expectRevert(abi.encodeWithSelector(DeliveryPacketDisposed.selector, h, uint256(1)));
        _proveRooted(h, _one(1), leaves, 0);
        assertFalse(_gd(1).landed, "nothing marked");
    }

    /**
     * @notice Cell 16 (#918) -- the chunk proof counts each packet's part
     *         ONCE: one event per (packet, day), a repeat refused writing
     *         nothing, and a second packet is the day's next part, not a
     *         duplicate. The first part's packet stays recorded as the first.
     * @dev    Mutation: let a repeat proof sum again, or overwrite the first
     *         packet, and the stored sums or the first-part assertion fail.
     */
    function test_1944_16_TheProofCountsEachPartOnce_TheFirstPartStays() public {
        _gateBinds();
        _owedDay1();
        uint256 half = NEED / 2;
        bytes32 hA = _part(half, 1, 161, keccak256("gate-first"), 0, NEED, 0);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit DayDeliveryProved(1, hA, 161, ROUTE_CHUNK);
        _prove(hA, _one(1));
        assertFalse(_gd(1).landed, "half the day: held");

        bytes32[] memory leavesA = RemitWire.d6Chunks(_one(1));
        vm.expectRevert(abi.encodeWithSelector(TransportChunkAlreadyIndexed.selector, hA, uint256(0)));
        _proveRooted(hA, _one(1), leavesA, 0); // a repeat proof is refused whole, writing and emitting nothing
        assertEq(_parts(1).landedFresh, half, "stored: counted once");

        bytes32 hB = _part(NEED - half, 1, 162, keccak256("gate-second"), 0, NEED, 0);
        vm.recordLogs();
        _prove(hB, _one(1));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_provedLogs(logs, 1), 1, "the second part's proof is its own event");
        assertEq(_gd(1).firstPart, hA, "stored: the first part stays first");
        assertTrue(_gd(1).landed, "both parts: landed");
        assertEq(_claim(), NEED, "and the proven day pays");
    }

    /**
     * @notice Cell 12 -- ROLES: the gate does not bind on any non-Mirror; on a
     *         Mirror it binds, and the same storage read as Canonical or Unconfigured holds
     *         nothing and pays as today -- the stamp's half where a stamp
     *         landed, the schedule half where none did (the derivation's
     *         byte-identical side). Straddle: as a Mirror the day waits.
     * @dev    Mutation: drop step 2 (the role exit) and Canonical / Unconfigured
     *         wait on a delivery that never comes.
     */
    function test_1944_12_TheCanonicalAndUnconfiguredRoles_AreNeverHeld() public {
        uint256 snap = vm.snapshotState();
        _mut().setRewardRoleRaw(CHAIN_BASE, true, true);
        assertFalse(_gd(1).gateBinds, "Canonical: the gate does not bind");
        _mut().setRewardRoleRaw(0, false, false);
        assertFalse(_gd(1).gateBinds, "Unconfigured: the gate does not bind");
        vm.revertToState(snap);

        uint256 h1 = LibInteractionRewards.halfPoolForDay(1);
        uint256 h2 = LibInteractionRewards.halfPoolForDay(2);
        _gateBinds();
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

    // ─────────────── cell 18: a former canonical's own days ───────────────

    /**
     * @notice Cell 18 -- a day this chain funded ITSELF, while it was
     *         canonical, is never held once the chain is a mirror: Base sent
     *         it nothing, so no delivery could land it. The day carries every
     *         input that holds an owed day (its own stamp with a fresh half,
     *         the denominator, the report, a cap threshold, interest) except a
     *         broadcast. A broadcast for that day is then refused by name, so
     *         the record keeps one writer and the gate never rises on it later.
     * @dev    Mutation: read the stamp instead of `broadcastV2Applied` in step
     *         4 and the first assertion fails; drop the ingress refusal and the
     *         broadcast overwrites the local record.
     */
    function test_1944_18_AFormerCanonicalsOwnDays_AreNeverHeld() public {
        _gateBinds();
        uint32 self = uint32(block.chainid);
        _closeLocal(1, 1e18, 0);
        // What `finalizeDay` wrote here while this chain was canonical.
        _mut().setChainDayFundingRaw(1, self, 1e18, 0);
        _mut().setKnownGlobalDailyInterest(1, 1e18, 1e18, true);
        _mut().setDayCapThreshold18(1, type(uint256).max);
        assertFalse(_awaits(0, 1), "a locally funded day is not held");
        assertFalse(_gd(1).awaitsLender, "the operator read agrees");

        uint256 snap = vm.snapshotState();
        _mut().setBroadcastV2AppliedRaw(1, true);
        assertTrue(_awaits(0, 1), "contrast: the same day, applied by a broadcast, waits");
        vm.revertToState(snap);

        _rep().setRewardMessenger(address(messenger));
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.DayFundedLocally.selector, uint256(1)));
        messenger.deliverBroadcastV2(_armedPacket(1));
        assertFalse(_awaits(0, 1), "still unheld after the refused broadcast");
    }
}
