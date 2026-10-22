// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

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
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {RewardHorizonSweepFacet} from "../src/facets/RewardHorizonSweepFacet.sol";
import {RewardReconciliationFacet} from "../src/facets/RewardReconciliationFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibVpfiRecycle} from "../src/libraries/LibVpfiRecycle.sol";
import {LibRewardCustody} from "../src/libraries/LibRewardCustody.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {RewardClosureFacet} from "../src/facets/RewardClosureFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {LibD6Delivery} from "./helpers/LibD6Delivery.sol";
import {MerkleFixture} from "./mocks/MerkleFixture.sol";
import {RemitWire} from "../src/crosschain/RemitWire.sol";

/**
 * @title RewardTransportEpochDrawTest
 * @notice #1566 transport epochs PR 3b-ii-A — the DRAWS: an obligation on an
 *         armed day that an old-wire delivery listed is paid from that
 *         delivery's epoch FIRST, ahead of the delivered ledger and the
 *         bucket, and every chokepoint downstream sees only the residual.
 *
 *         The fixture is a mirror with reward custody active, one armed day
 *         priced so that the claimant's need is exactly the per-user cap, and
 *         an untyped delivery listing that day. Each rule is then pinned from
 *         both sides: an epoch that covers the whole need against one that
 *         covers part of it; a day the epoch lists against one it does not;
 *         the settle against the preview that predicts it; the claim against
 *         the forfeit sweep; and the design's own allocation counter-examples
 *         against the rule as the facet applies it.
 */
/// @dev Two claims by one claimant inside ONE transaction. Runs at the
///      claimant's address for a single call (see `_claimTwiceInOneTx`), and
///      asks for `Vault` delivery explicitly because that is where a code-less
///      claimant's `Default` lands — the caller has code while it runs, and the
///      delivery venue must not change with it.
contract ClaimTwiceInOneTx {
    function claimTwice(address diamond) external returns (uint256 first, uint256 second) {
        (first, , ) = RewardClaimFacet(diamond).claimInteractionRewardsTo(LibVaipakam.RewardDelivery.Vault);
        (second, , ) = RewardClaimFacet(diamond).claimInteractionRewardsTo(LibVaipakam.RewardDelivery.Vault);
    }
}

contract RewardTransportEpochDrawTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    address internal alice;
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    address internal constant REMITTER = address(0xBA5E);
    uint256 internal constant SEED = 1_000_000 ether;
    uint64 internal constant LOAN = 77;
    /// @dev The claimant's need on the fixture's armed day: the per-user cap
    ///      binds below the day's 1e18 fresh half.
    uint256 internal constant NEED = 0.4e18;

    /// @dev Declared locally so `expectEmit` can name it; the emitter is the
    ///      library inlined into the epoch facet.
    event TransportDrawn(bytes32 indexed batchId, uint256 indexed dayId, uint256 fresh, uint256 recycled);
    event TransportDayCursorAdvanced(uint256 indexed dayId, bytes32 cursor);

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
        _becomeMirror();
        activateRewardCustodyForTest(address(vpfi), 0);
        alice = makeAddr("draw-alice");
    }

    // ─── fixture ────────────────────────────────────────────────────────────

    function _epoch() internal view returns (RewardEpochFacet) {
        return RewardEpochFacet(address(diamond));
    }

    function _epochView() internal view returns (RewardEpochViewFacet) {
        return RewardEpochViewFacet(address(diamond));
    }

    function _ingress() internal view returns (RewardIngressFacet) {
        return RewardIngressFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    function _custody() internal view returns (RewardCustodyFacet) {
        return RewardCustodyFacet(address(diamond));
    }

    function _cfg() internal view returns (ConfigFacet) {
        return ConfigFacet(address(diamond));
    }

    function _rlens() internal view returns (RewardRemittanceLensFacet) {
        return RewardRemittanceLensFacet(address(diamond));
    }

    function _becomeMirror() internal {
        vm.chainId(CHAIN_ARB);
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(false);
        RewardReporterFacet(address(diamond)).setBaseChainId(CHAIN_BASE);
        RewardRemittanceFacet(address(diamond)).setRewardRemittanceReceiver(address(this));
    }

    /// @dev An armed ShareOfPool day whose fresh half is 1e18 and whose sole
    ///      lender interest is the claimant's, so the raw price is 1e18 and
    ///      `cap` is what binds.
    function _armedDay(uint256 d, uint256 cap) internal {
        _mut().setDayPoolStampRaw(d, uint128(2e18), 0);
        _mut().setKnownGlobalDailyInterest(d, 1e18, 0, true);
        _mut().setDayCapThreshold18(d, type(uint256).max);
        _mut().setDayCapModeRaw(d, 1); // ShareOfPool
        _mut().setDayUserSideCapRaw(d, cap);
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

    function _entry(uint32 startDay, uint32 endDay) internal returns (uint256 id) {
        id = _mut().pushRewardEntry(alice, LOAN, LibVaipakam.RewardSide.Lender, 1e18, startDay);
        _mut().closeRewardEntryRaw(id, endDay);
    }

    /// @dev The standard scene: day 1 armed at `cap`, one closed entry on it,
    ///      nothing delivered to the live ledger.
    function _scene(uint256 cap) internal returns (uint256 id) {
        _armedDay(1, cap);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(1);
        id = _entry(1, 2);
        _mut().setArmedFreshLedgerRaw(0, 0);
        // The preview is a view: it cannot advance the side cursors the
        // production claim advances first, so the fixture does (this is
        // what the existing mirror preview tests do too).
        _mut().userClaimFundingNeedRaw(alice);
    }

    function _one(uint256 d) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = d;
    }

    function _two(uint256 d1, uint256 d2) internal pure returns (uint256[] memory a) {
        a = new uint256[](2);
        a[0] = d1;
        a[1] = d2;
    }

    /// @dev Every delivery's day list and chunk leaves, by packet, so a cell
    ///      can index a delivery it landed earlier.
    mapping(bytes32 => uint256[]) internal _daysOf;
    mapping(bytes32 => bytes32[]) internal _leavesOf;
    /// @dev Each delivery's packet, by remit id, for {_attest}.
    mapping(uint256 => bytes32) internal _packetOfRemit;

    /// @dev A rooted (d6) delivery with the wire split `fresh`:`recycled`
    ///      (whole: the two add up to `amount`), NOT yet indexed. The d6
    ///      ingress attests the epoch from that split at landing.
    function _land(uint256 amount, uint256[] memory dayIds, uint256 remitId, bytes32 id, uint256 fresh, uint256 recycled)
        internal
        returns (bytes32 h)
    {
        return this.landForTest(amount, dayIds, remitId, id, fresh, recycled);
    }

    /// @dev {_land}'s body, behind an external self-call so viaIR cannot
    ///      inline the delivery (and the copy of its list and leaves into
    ///      storage) into the cells that land many epochs in a loop: inlined,
    ///      one such cell sat one slot past the stack budget. The test
    ///      contract stays the ingress's caller, as the registered receiver.
    function landForTest(
        uint256 amount,
        uint256[] memory dayIds,
        uint256 remitId,
        bytes32 id,
        uint256 fresh,
        uint256 recycled
    ) external returns (bytes32 h) {
        require(msg.sender == address(this), "self only");
        bytes32[] memory leaves;
        (h, leaves) = LibD6Delivery.deliver(address(diamond), _delivery(amount, dayIds, remitId, id, fresh, recycled));
        _remember(h, remitId, dayIds, leaves);
    }

    /// @dev The delivery {_land} lands, built in its own frame.
    function _delivery(uint256 amount, uint256[] memory dayIds, uint256 remitId, bytes32 id, uint256 fresh, uint256 recycled)
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
            fresh: fresh,
            messageId: id,
            era: 0
        });
    }

    /// @dev Keep a landed packet's list and chunk leaves for indexing later.
    ///      Its own frame: copying the two arrays into storage beside
    ///      {_land}'s arguments put that frame one slot past the viaIR budget.
    function _remember(bytes32 h, uint256 remitId, uint256[] memory dayIds, bytes32[] memory leaves) internal {
        _daysOf[h] = dayIds;
        _leavesOf[h] = leaves;
        _packetOfRemit[remitId] = h;
    }

    /// @dev A whole-fresh delivery, NOT yet indexed.
    function _landFresh(uint256 amount, uint256[] memory dayIds, uint256 remitId, bytes32 id)
        internal
        returns (bytes32 h)
    {
        return _land(amount, dayIds, remitId, id, amount, 0);
    }

    /// @dev Index every chunk of a landed delivery.
    function _index(bytes32 h) internal returns (uint32 indexedDays) {
        uint256 n = _leavesOf[h].length;
        for (uint256 c; c < n; ++c) indexedDays = this.indexForTest(h, c, new bytes32[](0));
    }

    /// @dev Index chunk `c` of a landed delivery.
    function _indexChunk(bytes32 h, uint256 c) internal returns (uint32) {
        return this.indexForTest(h, c, new bytes32[](0));
    }

    /// @dev Index chunk `c` with predecessor hints.
    function _indexHinted(bytes32 h, uint256 c, bytes32[] memory hints) internal returns (uint32) {
        return this.indexForTest(h, c, hints);
    }

    /// @dev Materialize chunk `c` of a landed delivery from its stored list
    ///      and leaves. Behind an external self-call for the reason
    ///      {landForTest} is: the chunk, its proof and the call's arrays stay
    ///      out of the calling cell's frame. A refusal reverts this call, so a
    ///      cell's `expectRevert` still sees it as the next call.
    function indexForTest(bytes32 h, uint256 c, bytes32[] memory hints) external returns (uint32) {
        require(msg.sender == address(this), "self only");
        uint256[] memory chunk = MerkleFixture.chunk(_daysOf[h], c, RemitWire.D6_CHUNK_DAYS);
        bytes32[] memory proof = MerkleFixture.proof(_leavesOf[h], c);
        return _epoch().materializeTransportBatchChunk(h, c, chunk, proof, hints, new bytes32[](0));
    }

    /// @dev An epoch whose split is NOT attested, indexed. No production path
    ///      reaches this state — the d6 ingress attests every epoch at landing
    ///      — so the cells that cover the planner's fail-closed withhold stand
    ///      it in through the raw mutator.
    function _epochRaw(uint256 amount, uint256[] memory dayIds, uint256 remitId, bytes32 id)
        internal
        returns (bytes32 h)
    {
        h = _landFresh(amount, dayIds, remitId, id);
        _index(h);
        _mut().clearPacketAttestedRaw(h);
    }

    /// @dev A DRAWABLE epoch: wholly fresh — the standard scene's day is
    ///      fresh-only.
    function _epochOf(uint256 amount, uint256[] memory dayIds, uint256 remitId, bytes32 id)
        internal
        returns (bytes32 h)
    {
        h = _landFresh(amount, dayIds, remitId, id);
        _index(h);
    }

    /// @dev A FLEXIBLE epoch: both leg rooms the whole balance, through the
    ///      raw caps mutator — the state the residual-leg rule and the split's
    ///      reservation are defined for (see {setPacketAttestedCapsRaw}).
    function _epochFlex(uint256 amount, uint256[] memory dayIds, uint256 remitId, bytes32 id)
        internal
        returns (bytes32 h)
    {
        h = _epochOf(amount, dayIds, remitId, id);
        _mut().setPacketAttestedCapsRaw(h, amount, amount);
    }

    /// @dev A DRAWABLE epoch whose caps split what landed `fresh`:`recycled`,
    ///      each cap the floor of its proportion. Where the floors add up to
    ///      what landed, the delivery carries that split on its own wire; where
    ///      they leave a residual (a shape the d6 wire, which states a whole
    ///      split, never produces) the floored caps are stood in raw.
    function _epochSplit(
        uint256 amount,
        uint256[] memory dayIds,
        uint256 remitId,
        bytes32 id,
        uint256 fresh,
        uint256 recycled
    ) internal returns (bytes32 h) {
        (uint256 fc, uint256 rc) = _floorCaps(amount, fresh, recycled);
        h = _land(amount, dayIds, remitId, id, amount - rc, rc);
        _index(h);
        if (fc + rc != amount) _mut().setPacketAttestedCapsRaw(h, fc, rc);
    }

    function _floorCaps(uint256 amount, uint256 fresh, uint256 recycled)
        internal
        pure
        returns (uint256 fc, uint256 rc)
    {
        uint256 total = fresh + recycled;
        fc = (fresh * amount) / total;
        rc = (recycled * amount) / total;
    }

    /// @dev Attest a landed epoch's caps at the proportion `fresh`:`recycled`
    ///      of what landed — for the cells that stood an unattested epoch in
    ///      and then attest it.
    function _attest(uint256 remitId, uint256 fresh, uint256 recycled) internal {
        bytes32 h = _packetOfRemit[remitId];
        (uint256 fc, uint256 rc) = _floorCaps(_rlens().getIngressPacket(h).actualReceived, fresh, recycled);
        _mut().setPacketAttestedCapsRaw(h, fc, rc);
    }

    /// @dev LIVE fresh funding beside the epochs. On this activated custody
    ///      every budget delivery opens an epoch, so the live row is fed the
    ///      way a live-era compensation feeds it (see {relocateFreshIngressRaw}).
    ///      The day list, remit id and message id are the cell's labels only.
    function _liveOf(uint256 amount, uint256[] memory, uint256, bytes32) internal {
        uint256 before = _row(LibVaipakam.RewardCustodyRow.LiveFresh);
        _mut().relocateFreshIngressRaw(amount);
        assertEq(_row(LibVaipakam.RewardCustodyRow.LiveFresh) - before, amount, "fixture: live-fresh credited");
    }

    function _claim() internal returns (uint256 paid) {
        vm.prank(alice);
        (paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewards();
    }

    /// @dev The preview IS the claim (A2-iii): run in a reverting frame.
    function _preview() internal returns (uint256 amount) {
        (amount, , ) = previewByExecution(alice);
    }

    /// @dev The per-transaction epoch write budget is TRANSIENT, so "batched in
    ///      the same transaction" has to be one transaction. Two `_claim()`
    ///      calls are not: forge 1.8 clears transient storage between a test's
    ///      top-level calls, so the second claim met a fresh budget and paid.
    function _claimTwiceInOneTx() internal returns (uint256 first, uint256 second) {
        bytes memory had = alice.code;
        vm.etch(alice, type(ClaimTwiceInOneTx).runtimeCode);
        (first, second) = ClaimTwiceInOneTx(alice).claimTwice(address(diamond));
        vm.etch(alice, had);
    }

    /// @dev One obligation-day's gross needs for alice on the lender side —
    ///      what the retired domain view once sized fixtures with.
    function _dayNeeds(uint256 d) internal view returns (uint256 needF, uint256 needR) {
        return _mut().dayNeedsRaw(alice, LibVaipakam.RewardSide.Lender, d);
    }

    function _row(LibVaipakam.RewardCustodyRow r) internal view returns (uint256) {
        return _custody().rewardCustodyRow(r);
    }

    function _legs(bytes32 h) internal view returns (uint256 f, uint256 r) {
        (f, r) = _epoch().getTransportBatchLegs(h);
    }

    function _balance(bytes32 h) internal view returns (uint256 b) {
        (, b, , , , ) = _epoch().getTransportBatch(h);
    }


    /// @dev The allocation view takes one request struct; this keeps the
    ///      rule tests readable as eight figures.
    function _alloc(
        uint256 dayId,
        uint256 needF,
        uint256 needR,
        uint256 poolF,
        uint256 cap,
        uint256 bucket
    ) internal view returns (uint256 tf, uint256 tr, bool capHit) {
        LibRewardCustody.AllocRequest memory q;
        q.dayId = dayId;
        q.needFresh = needF;
        q.needRecycled = needR;
        q.poolFresh = poolF;
        q.deliveredCap = cap;
        q.bucket = bucket;
        LibRewardCustody.AllocResult memory r = _epoch().getTransportAllocationForDay(q);
        return (r.transportFresh, r.transportRecycled, r.capHit);
    }

    /// @dev The per-epoch legs an allocation WOULD draw, for one epoch. The
    ///      totals cannot discriminate here: two coverings of the same ask are
    ///      equal in amount and differ only in which epochs they spend, so the
    ///      assertion has to read the split's own output (Codex #2296 item 1).
    function _plannedLegs(uint256 dayId, uint256 needF, uint256 needR, bytes32 id)
        internal
        view
        returns (uint256 f, uint256 r)
    {
        LibRewardCustody.AllocRequest memory q;
        q.dayId = dayId;
        q.needFresh = needF;
        q.needRecycled = needR;
        q.poolFresh = type(uint256).max;
        LibRewardCustody.AllocResult memory a = _epoch().getTransportAllocationForDay(q);
        for (uint256 i; i < a.planIds.length; ) {
            if (a.planIds[i] == id) return (a.planFresh[i], a.planRecycled[i]);
            unchecked { ++i; }
        }
        revert("fixture: the epoch is not in the day's plan");
    }

    /// @dev The cursor's POSITION in the day's order — the count of leading
    ///      exhausted epochs — exact here because every day in this suite is
    ///      shorter than the hundred nodes the read walks.
    function _cursor(uint256 d) internal view returns (uint256 c) {
        (, , , c) = _epoch().getTransportDayBatches(d, 0, 100);
    }

    // ─── the claim ──────────────────────────────────────────────────────────

    function test_ArmedDayClaim_DrawsFromTheEpoch_NotTheDeliveredLedger() public {
        _scene(NEED);
        bytes32 h = _epochOf(10e18, _one(1), 1, keccak256("e1"));
        uint256 rowBefore = _row(LibVaipakam.RewardCustodyRow.Unclassified);
        uint256 aliceBefore = vpfi.balanceOf(alice);
        assertEq(_preview(), NEED, "the preview prices the day from the epoch");

        vm.expectEmit(true, true, false, true, address(diamond));
        emit TransportDrawn(h, 1, NEED, 0);
        assertEq(_claim(), NEED, "paid in full");

        assertEq(vpfi.balanceOf(alice) - aliceBefore, NEED, "delivered to the wallet");
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(lf, NEED, "the fresh leg is recorded on the epoch");
        assertEq(lr, 0, "no recycled leg on a fresh-only day");
        assertEq(_balance(h), 10e18 - NEED, "the epoch fell by the draw");
        assertEq(_mut().getArmedFreshPaidRaw(), 0, "the delivered ledger is NOT charged");
        assertEq(rowBefore - _row(LibVaipakam.RewardCustodyRow.Unclassified), NEED, "the Unclassified row fell by the draw");
        assertEq(_rlens().getIngressPacket(h).unclassified, 10e18 - NEED, "the packet's untyped remainder fell with it");
        assertEq(_cursor(1), 0, "an epoch with balance left keeps its place");
        assertEq(_preview(), 0, "nothing left to preview");
    }

    function test_TransportFirst_AheadOfALiveLedgerThatCouldHavePaid() public {
        _scene(NEED);
        _liveOf(1e18, _one(1), 1, keccak256("live"));
        bytes32 h = _epochOf(10e18, _one(1), 2, keccak256("e1"));
        uint256 liveBefore = _row(LibVaipakam.RewardCustodyRow.LiveFresh);

        assertEq(_claim(), NEED);
        (uint256 lf, ) = _legs(h);
        assertEq(lf, NEED, "the epoch paid, though the ledger could have");
        assertEq(_mut().getArmedFreshPaidRaw(), 0, "the delivered ledger untouched");
        assertEq(_row(LibVaipakam.RewardCustodyRow.LiveFresh), liveBefore, "the live row untouched");
    }

    /// @dev The ordinary tier is credited only with what it can pay on EACH
    ///      leg, not its aggregate balance (Codex #2276). An ordinary epoch that
    ///      can pay only recycled, a shared epoch that can pay only fresh, a
    ///      fresh-only need that live funding covers. Credited with its
    ///      aggregate, the ordinary tier was asked for fresh it cannot pay, and
    ///      the split spilled that fresh into the shared epoch. Live must pay,
    ///      and the shared epoch must be spared.
    function test_TheOrdinaryTier_IsCreditedPerLeg_NotByItsAggregate() public {
        _epochSplit(5, _one(1), 91, keccak256("ord-recycled-only"), 0, 5);
        vm.warp(vm.getBlockTimestamp() + 1);
        _epochOf(5, _two(1, 2), 92, keccak256("nec-fresh-only"));
        (uint256 tf, uint256 tr, ) =
            _alloc(1, 5, 0, type(uint256).max, 5, 0);
        assertEq(tf + tr, 0, "live pays the fresh leg; no epoch is drawn at all");
    }

    /// @dev The split is EXACT, not greedy (Codex #2276, the fourth finding on
    ///      this one decision). Plan-ordered A = balance 2 with room on both
    ///      legs, B = 1 payable only in fresh, C = 2 with one unit of room per
    ///      leg, asked 2F/1R. Every forward greedy chose A's legs without seeing
    ///      what that forced later — the last one gave A 2F, skipped B, and
    ///      took 1R from C. A 1F/1R and B 1F cover the same request and leave C,
    ///      which may be another day's only backing, untouched. The backward
    ///      walk makes each epoch supply only what the epochs before it cannot.
    function test_TheSplit_IsExact_AndSparesTheLatestEpoch() public {
        bytes32 a = _epochFlex(2, _one(1), 101, keccak256("exact-A"));
        vm.warp(vm.getBlockTimestamp() + 1);
        bytes32 b = _epochSplit(1, _one(1), 102, keccak256("exact-B"), 1, 0);
        vm.warp(vm.getBlockTimestamp() + 1);
        bytes32 c = _epochSplit(2, _one(1), 103, keccak256("exact-C"), 1, 1);
        (uint256 af, uint256 ar) = _plannedLegs(1, 2, 1, a);
        (uint256 bf, uint256 br) = _plannedLegs(1, 2, 1, b);
        (uint256 cf, uint256 cr) = _plannedLegs(1, 2, 1, c);
        assertEq(af + bf + cf, 2, "the fresh leg is covered");
        assertEq(ar + br + cr, 1, "and the recycled leg");
        assertEq(af, 1, "A pays one fresh");
        assertEq(ar, 1, "and one recycled");
        assertEq(bf + br, 1, "B pays its one fresh");
        assertEq(cf + cr, 0, "and C, the latest, is spared entirely");
    }

    function test_AShortEpochPaysWhatItHolds_TheLedgerTheRest_AndIsRetired() public {
        _scene(NEED);
        _liveOf(1e18, _one(1), 1, keccak256("live"));
        bytes32 h = _epochOf(0.1e18, _one(1), 2, keccak256("short"));
        uint256 liveBefore = _row(LibVaipakam.RewardCustodyRow.LiveFresh);
        uint256 unclBefore = _row(LibVaipakam.RewardCustodyRow.Unclassified);

        vm.expectEmit(true, false, false, true, address(diamond));
        emit TransportDayCursorAdvanced(1, h); // the cursor is the exhausted epoch itself (r7)
        assertEq(_claim(), NEED, "paid in full from both sources");

        (uint256 lf, ) = _legs(h);
        assertEq(lf, 0.1e18, "the epoch paid what it held");
        assertEq(_balance(h), 0, "and is exhausted");
        assertEq(_mut().getArmedFreshPaidRaw(), NEED - 0.1e18, "the ledger charged for the residual only");
        assertEq(liveBefore - _row(LibVaipakam.RewardCustodyRow.LiveFresh), NEED - 0.1e18, "the live row paid the residual");
        assertEq(unclBefore - _row(LibVaipakam.RewardCustodyRow.Unclassified), 0.1e18, "the Unclassified row paid the leg");
        assertEq(_cursor(1), 1, "the day's cursor moved past the exhausted epoch");
    }

    function test_AnEpochListingAnotherDay_IsNotThisDaysCoverage() public {
        _scene(NEED);
        bytes32 h = _epochOf(10e18, _one(2), 1, keccak256("elsewhere"));
        assertEq(_preview(), 0, "day 1 has no coverage");
        vm.prank(alice);
        vm.expectRevert(IVaipakamErrors.NoInteractionRewardsToClaim.selector);
        RewardClaimFacet(address(diamond)).claimInteractionRewards();
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(lf + lr, 0, "nothing drawn");
        assertEq(_mut().getArmedFreshPaidRaw(), 0);
    }

    function test_ThePreviewIsTheClaim_WithAndWithoutCoverage() public {
        _scene(NEED);
        _epochOf(0.25e18, _one(1), 1, keccak256("part"));
        _liveOf(0.05e18, _one(1), 2, keccak256("live"));
        // 0.25 epoch + 0.05 live < 0.4 need: the residual has no source, the day
        // defers on the delivered bound — the preview and the claim agree.
        assertEq(_preview(), 0, "deferred: the preview says so");
        vm.prank(alice);
        vm.expectRevert(IVaipakamErrors.NoInteractionRewardsToClaim.selector);
        RewardClaimFacet(address(diamond)).claimInteractionRewards();
        _liveOf(0.1e18, _one(1), 3, keccak256("more"));
        _mut().userClaimFundingNeedRaw(alice);
        uint256 p = _preview();
        assertEq(p, NEED, "now covered: 0.25 epoch + 0.15 live");
        assertEq(_claim(), p, "and the claim pays exactly that");
        assertEq(_mut().getArmedFreshPaidRaw(), 0.15e18, "the ledger charged for the live share");
    }

    function test_ClaimToTheVault_CarriesTheEpochLeg() public {
        _scene(NEED);
        _liveOf(0.1e18, _one(1), 1, keccak256("live"));
        _epochOf(0.3e18, _one(1), 2, keccak256("e"));
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(alice);
        uint256 vaultBefore = vpfi.balanceOf(vault);
        assertEq(_claim(), NEED);
        assertEq(vpfi.balanceOf(vault) - vaultBefore, NEED, "the vault received live + epoch legs");
        assertEq(_mut().getArmedFreshPaidRaw(), 0.1e18, "the ledger charged for the live share only");
    }

    function test_Conservation_HoldsAfterADraw() public {
        _scene(NEED);
        bytes32 h = _epochOf(10e18, _one(1), 1, keccak256("e1"));
        _claim();
        (, uint256 balance, uint256 admitted, , , ) = _epoch().getTransportBatch(h);
        (uint256 parked, , , uint256 debited) = _epoch().getTransportRemainder(h);
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(balance + parked + debited + lf + lr, admitted, "admitted == balance + parked + debited + legs");
    }

    // ─── the forfeit sweep (row 1) ──────────────────────────────────────────

    function test_ForfeitSweep_AbsorbsTheEpochPaidLeg_InPlace() public {
        uint256 id = _scene(NEED);
        _mut().setRewardEntryForfeitedRaw(id);
        _mut().setLoanActiveLenderEntryId(LOAN, id);
        bytes32 h = _epochOf(10e18, _one(1), 1, keccak256("e1"));
        uint256 bucketBefore = _cfg().getRecycleBucket();
        uint256 recycledBefore = _row(LibVaipakam.RewardCustodyRow.Recycled);
        uint256 unclBefore = _row(LibVaipakam.RewardCustodyRow.Unclassified);

        uint256 swept = InteractionRewardsFacet(address(diamond)).sweepForfeitedInteractionRewards(LOAN);
        assertEq(swept, NEED, "the forfeit settled from the epoch, with the live row empty");
        (uint256 lf, ) = _legs(h);
        assertEq(lf, NEED, "the fresh leg recorded on the epoch");
        assertEq(_cfg().getRecycleBucket() - bucketBefore, NEED, "the bucket credited: recycled in place");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Recycled) - recycledBefore, NEED, "the recycled row grew");
        assertEq(unclBefore - _row(LibVaipakam.RewardCustodyRow.Unclassified), NEED, "out of the Unclassified row");
        assertEq(_mut().getArmedFreshPaidRaw(), 0, "the delivered ledger untouched");
    }

    function test_ForfeitSweep_WithNoCoverageAndNoBacking_StillDefers() public {
        uint256 id = _scene(NEED);
        _mut().setRewardEntryForfeitedRaw(id);
        _mut().setLoanActiveLenderEntryId(LOAN, id);
        uint256 bucketBefore = _cfg().getRecycleBucket();
        assertEq(InteractionRewardsFacet(address(diamond)).sweepForfeitedInteractionRewards(LOAN), 0, "deferred");
        assertEq(_cfg().getRecycleBucket(), bucketBefore, "no credit");
    }

    // ─── the expiry sweep (row 5) ───────────────────────────────────────────

    /// @dev The horizon clock accrues only while the entry is EXECUTABLE — and
    ///      with the live row empty it is executable only because row 13 reads
    ///      the need net of the epoch's coverage. So this test pins two things
    ///      at once: the predicate prices the day the way the settle does, and
    ///      the expiry that follows recycles the epoch-paid leg in place.
    function test_ExpirySweep_AccruesOnEpochCoverage_AndAbsorbsInPlace() public {
        uint256 id = _scene(NEED);
        _cfg().setRewardClaimHorizonDays(180);
        bytes32 h = _epochOf(10e18, _one(1), 1, keccak256("e1"));
        uint256 bucketBefore = _cfg().getRecycleBucket();
        uint256 unclBefore = _row(LibVaipakam.RewardCustodyRow.Unclassified);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        assertEq(RewardHorizonSweepFacet(address(diamond)).sweepExpiredInteractionRewards(ids), 0, "stamps only");
        uint256 remaining = 180 days + 90 days; // horizon + notice
        uint256 swept;
        while (remaining > 0) {
            uint256 step = remaining < 7 days ? remaining : 7 days; // the clock's max observation gap
            vm.warp(vm.getBlockTimestamp() + step);
            swept = RewardHorizonSweepFacet(address(diamond)).sweepExpiredInteractionRewards(ids);
            remaining -= step;
            if (swept > 0) break;
        }
        if (swept == 0) {
            vm.warp(vm.getBlockTimestamp() + 7 days);
            swept = RewardHorizonSweepFacet(address(diamond)).sweepExpiredInteractionRewards(ids);
        }
        assertEq(swept, NEED, "expired from the epoch, with the live row empty");
        (uint256 lf, ) = _legs(h);
        assertEq(lf, NEED, "the fresh leg recorded on the epoch");
        assertEq(_cfg().getRecycleBucket() - bucketBefore, NEED, "recycled in place");
        assertEq(unclBefore - _row(LibVaipakam.RewardCustodyRow.Unclassified), NEED, "out of the Unclassified row");
        assertEq(_mut().getArmedFreshPaidRaw(), 0, "the delivered ledger untouched");
    }

    // ─── the scan window ────────────────────────────────────────────────────

    function test_ACapHit_DefersTheDay_RatherThanPullTheLedger() public {
        _scene(NEED);
        _liveOf(1e18, _one(1), 1, keccak256("live"));
        // 65 one-wei epochs: the window sees 64 wei and reports it ended short
        // of the index; the ledger could pay the rest but must not.
        for (uint256 i; i < 65; ++i) {
            _epochOf(1, _one(1), 100 + i, keccak256(abi.encode("tiny", i)));
        }
        (uint256 avail, bool capHit, , ) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 64, "one window");
        assertTrue(capHit, "and more beyond it");
        assertEq(_preview(), 0, "the preview defers");
        // The window's attested epochs are STAGED for the day (3b-ii-A2)
        // rather than drawn: nothing is paid now, and the ledger is not pulled.
        uint256 before = vpfi.balanceOf(alice);
        vm.prank(alice);
        (bool ok, ) = address(diamond).call(abi.encodeWithSelector(RewardClaimFacet.claimInteractionRewards.selector));
        ok; // staging is persisted progress; a deferral with nothing staged reverts — either way nothing is paid
        assertEq(vpfi.balanceOf(alice), before, "nothing paid");
        assertEq(_mut().getArmedFreshPaidRaw(), 0, "the ledger was not pulled");
        assertEq(_cursor(1), 0, "nothing exhausted, nothing pruned");
    }

    /// @dev The standalone prune passes husks at the front of a day's index
    ///      that no claim of that day drew (a shared epoch is withheld from
    ///      every day, so another day cannot exhaust one — Codex #2276 r26 —
    ///      and parking is what empties them here): an exhausted husk is
    ///      neither drawable nor withheld, and the prune is idempotent.
    function test_Prune_MovesPastExhaustedHusks() public {
        bytes32 a = _epochOf(0.1e18, _two(1, 2), 1, keccak256("a"));
        bytes32 b = _epochOf(0.1e18, _two(1, 2), 2, keccak256("b"));
        bytes32 c = _epochOf(0.1e18, _two(1, 2), 3, keccak256("c"));
        _mut().parkTransportBatchRaw(a);
        _mut().parkTransportBatchRaw(b);
        _mut().parkTransportBatchRaw(c);
        assertEq(_balance(a) + _balance(b) + _balance(c), 0);
        assertEq(_cursor(1), 0, "day 1's index still lists the husks");
        (uint256 avail, bool capHit, uint256 wContested, ) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 0);
        assertEq(wContested, 0, "an exhausted husk is not withheld");
        assertFalse(capHit);
        _epoch().epochPruneTransportDayCursor(1);
        assertEq(_cursor(1), 3, "pruned");
        _epoch().epochPruneTransportDayCursor(1);
        assertEq(_cursor(1), 3, "idempotent");
    }

    // ─── round 1: the seam's edges ──────────────────────────────────────────

    /// @dev A day priced with fresh AND recycled halves: the stamp carries a
    ///      recycled budget equal to the fresh half, so the claimant's capped
    ///      need splits across both legs.
    function _twoLegDay(uint256 d, uint256 cap) internal {
        _mut().setDayPoolStampRaw(d, uint128(2e18), uint128(2e18));
        _mut().setKnownGlobalDailyInterest(d, 1e18, 0, true);
        _mut().setDayCapThreshold18(d, type(uint256).max);
        _mut().setDayCapModeRaw(d, 1);
        _mut().setDayUserSideCapRaw(d, cap);
    }

    function _outstandingRecycled() internal view returns (uint256 o) {
        (, , , o, , , , ) = InteractionRewardsLensFacet(address(diamond)).getRecycleBackingSnapshot();
    }

    /// @dev A claim's recycled leg an epoch paid retires its commitment
    ///      without a bucket debit, exactly as a forfeit's does (Codex #2276
    ///      r1 P1): the outstanding recycled commitment falls by the epoch-paid
    ///      recycled, and the bucket does not move.
    function test_ClaimsEpochPaidRecycled_RetiresItsCommitment() public {
        _twoLegDay(1, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(1);
        _entry(1, 2);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        (uint256 needF, uint256 needR) = _dayNeeds(1);
        assertGt(needR, 0, "fixture: a recycled leg");
        _liveOf(needF, _one(1), 1, keccak256("live"));
        bytes32 h = _epochFlex(needR, _one(1), 2, keccak256("e"));
        _mut().setOutstandingCommitRaw(0, needR); // the commitment behind the recycled leg
        uint256 bucketBefore = _cfg().getRecycleBucket();
        assertEq(_claim(), NEED);
        (, uint256 lr) = _legs(h);
        assertEq(lr, needR, "the epoch paid the recycled leg");
        assertEq(_outstandingRecycled(), 0, "and its commitment retired");
        assertEq(_cfg().getRecycleBucket(), bucketBefore, "without a bucket debit");
    }

    /// @dev An epoch is invisible to a day until it is indexed whole: day 1
    ///      sees nothing of a half-indexed 40-day epoch — not even as withheld
    ///      — and once whole it is counted, as WITHHELD for listing more than
    ///      one day (Codex #2276 r26 P1).
    function test_AnIncompletelyIndexedEpoch_IsInvisibleUntilWhole() public {
        uint256[] memory days_ = new uint256[](40);
        for (uint256 i; i < 40; ++i) days_[i] = i + 1;
        bytes32 id = keccak256("wide");
        bytes32 h = _landFresh(10e18, days_, 1, id);
        assertEq(_indexChunk(h, 0), 16, "first chunk");
        assertEq(_indexChunk(h, 1), 32, "second chunk");
        (uint256 avail, , uint256 wContested, ) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail + wContested, 0, "day 1 sees nothing of a half-indexed epoch");
        assertEq(_indexChunk(h, 2), 40, "third chunk: whole");
        (avail, , wContested, ) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 0, "a shared epoch is never drawable");
        assertEq(wContested, 10e18, "but whole, it is counted as withheld");
    }

    /// @dev The executability gates net the recycled upper bound by what the
    ///      epochs would pay (Codex #2276 r1 P1): with the bucket EMPTY and an
    ///      epoch covering the day's recycled leg, the expiry clock accrues
    ///      and the entry expires, absorbing both legs in place.
    function test_ExpiryClock_AccruesWhenAnEpochCoversTheRecycledLeg() public {
        _twoLegDay(1, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(1);
        uint256 id = _entry(1, 2);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        (uint256 needF, uint256 needR) = _dayNeeds(1);
        assertGt(needR, 0, "fixture: a recycled leg");
        assertEq(_cfg().getRecycleBucket(), 0, "fixture: the bucket is empty");
        _liveOf(needF, _one(1), 1, keccak256("live"));
        // Recycled-attested: the epoch at the cursor covers the recycled leg, which
        // is what the static executability read sees (A2-iii).
        bytes32 h = _epochSplit(needR, _one(1), 2, keccak256("e"), 0, 1);
        _cfg().setRewardClaimHorizonDays(180);
        uint256 bucketBefore = _cfg().getRecycleBucket();
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        assertEq(RewardHorizonSweepFacet(address(diamond)).sweepExpiredInteractionRewards(ids), 0, "stamps only");
        uint256 remaining = 180 days + 90 days;
        uint256 swept;
        while (remaining > 0) {
            uint256 step = remaining < 7 days ? remaining : 7 days;
            vm.warp(vm.getBlockTimestamp() + step);
            swept = RewardHorizonSweepFacet(address(diamond)).sweepExpiredInteractionRewards(ids);
            remaining -= step;
            if (swept > 0) break;
        }
        if (swept == 0) {
            vm.warp(vm.getBlockTimestamp() + 7 days);
            swept = RewardHorizonSweepFacet(address(diamond)).sweepExpiredInteractionRewards(ids);
        }
        assertEq(swept, NEED, "expired: the clock accrued with an empty bucket");
        (uint256 lf, uint256 lr) = _legs(h);
        // Codex #2276 r5 P1 — an expiry's recycled slice is a commitment
        // release, not a funding pull: the epoch pays none of it. A2-iii: the
        // epoch at the cursor is recycled-attested, so it has no fresh room
        // either — the live delivery pays the expiry's fresh leg, which the
        // sweep absorbs into the bucket; the epoch is untouched.
        assertEq(lf, 0, "a recycled-attested epoch has no fresh room: live paid the fresh leg");
        assertEq(lr, 0, "and none of its recycled slice, which is a release");
        assertEq(_cfg().getRecycleBucket() - bucketBefore, needF, "the live-paid fresh absorbed into the bucket; the release moved nothing");
    }


    /// @dev The public armed need is the FULL capped figure — what the claim
    ///      charges the emission cap and the commitment — epoch-paid fresh
    ///      included; the live-funded part is reported beside it (Codex #2276
    ///      r2 P2).
    function test_ThePublicArmedNeed_CountsTheEpochPaidFresh() public {
        _scene(NEED);
        (uint256 needF, ) = _dayNeeds(1);
        assertGt(needF, 0, "fixture: a fresh leg");
        _epochOf(10e18, _one(1), 1, keccak256("e"));
        InteractionRewardsLensFacet lens = InteractionRewardsLensFacet(address(diamond));
        assertEq(RewardEpochViewFacet(address(diamond)).getUserArmedFreshNeed(alice), needF, "the requirement counts the epoch-paid fresh");
        (uint256 armed, , , , , , uint256 liveArmed, ) = RewardEpochViewFacet(address(diamond)).getUserArmedFreshNeedWithLegs(alice);
        assertEq(armed, needF, "same figure, flat shape");
        assertEq(liveArmed, 0, "and the live delivery must fund none of it");
    }

    /// @dev An ATTESTED packet's epoch pays each leg only within that
    ///      component's remaining cap (Codex #2276 r4 P1): 4F/6R of 10, a day
    ///      asking 6F gets 4F from the epoch, and asking 6F/3R gets 4F/3R.
    function test_AnAttestedEpoch_PaysEachLegWithinItsRoom() public {
        _epochSplit(10e18, _one(1), 7, keccak256("attested"), 4e18, 6e18);
        (uint256 tf, uint256 tr, ) = _alloc(1, 6e18, 0, type(uint256).max, 0, 0);
        assertEq(tf, 4e18, "fresh capped at the attested fresh");
        assertEq(tr, 0);
        (tf, tr, ) = _alloc(1, 6e18, 3e18, type(uint256).max, 0, 0);
        assertEq(tf, 4e18);
        assertEq(tr, 3e18, "recycled within its own room");
    }

    /// @dev An epoch whose split is not attested is WITHHELD, by name, and
    ///      drawn only once its attestation lands (Codex #2276 r26 P1): a leg
    ///      is typed once, by the caps it is drawn under, so nothing drawn is
    ///      ever retyped under settled custody.
    function test_AnUnattestedEpoch_IsWithheld_UntilItsSplitIsAttested() public {
        _scene(NEED);
        bytes32 h = _epochRaw(10e18, _one(1), 9, keccak256("unattested"));
        (uint256 avail, , uint256 wContested, uint256 wUnattested) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 0, "nothing is drawable");
        assertEq(wContested, 0);
        assertEq(wUnattested, 10e18, "withheld for its attestation");
        assertEq(_preview(), 0, "the preview prices nothing");
        vm.expectRevert(IVaipakamErrors.NoInteractionRewardsToClaim.selector);
        _claim();
        assertEq(_balance(h), 10e18, "the claim took nothing from it");
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(lf + lr, 0, "and typed no leg");

        _attest(9, 1, 1);
        (avail, , , wUnattested) = _epoch().getTransportCoverageForDay(1);
        assertEq(wUnattested, 0, "attested: no longer withheld");
        assertEq(avail, 10e18, "both rooms now drawable");
        assertEq(_claim(), NEED, "the deferred day is paid from the epoch");
        (lf, ) = _legs(h);
        assertEq(lf, NEED, "on the fresh leg its attested room allows");
    }

    /// @dev 3c-1 (#2318, option A) — a shared epoch whose OTHER listed day has
    ///      ARRIVED and still carries an obligation not proven terminated is
    ///      CONTESTED: withheld, by name, from this day's draw. Here day 2 is
    ///      armed and stamped (arrived) and alice's entry still covers it.
    ///      Unattested and contested are reported each on its own.
    function test_ASharedEpoch_IsContested_WhileAnotherArrivedDayIsOpen() public {
        _armedDay(1, NEED);
        _armedDay(2, NEED); // day 2 has ARRIVED
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(2);
        _entry(1, 3); // covers day 2: an obligation the proof has not closed
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        bytes32 h = _epochOf(10e18, _two(1, 2), 11, keccak256("shared"));
        (uint256 avail, , uint256 wContested, uint256 wUnattested) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 0, "nothing is drawable");
        assertEq(wContested, 10e18, "withheld as contested");
        assertEq(wUnattested, 0, "and not for want of an attestation");
        // Unattested AND contested: each reported (Codex #2276 r27 P2).
        _epochRaw(3e18, _two(1, 2), 12, keccak256("shared-unattested"));
        (avail, , wContested, wUnattested) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 0);
        assertEq(wContested, 13e18, "both contested");
        assertEq(wUnattested, 3e18, "and the unattested one's pending attestation");
        vm.expectRevert(IVaipakamErrors.NoInteractionRewardsToClaim.selector);
        _claim();
        assertEq(_balance(h), 10e18, "the claim took nothing from it");
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(lf + lr, 0, "and typed no leg");
    }

    /// @dev 3c-1 — a shared epoch whose other listed day is ARRIVED and PROVEN
    ///      CLOSED is uncontested: it is planned as ordinary and pays day 1
    ///      first, exactly like a one-day epoch. Day 2 carries no obligation,
    ///      so once the chain closes it the proof completes at its start.
    function test_ASharedEpoch_WhoseOtherDayIsProvenClosed_IsOrdinary() public {
        _scene(NEED); // alice's entry covers day 1 only
        _armedDay(2, NEED); // day 2: arrived, no obligation
        bytes32 h = _epochOf(10e18, _two(1, 2), 11, keccak256("shared-closed"));
        (uint256 avail, , uint256 wContested, ) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 0, "day 2 is arrived but not yet proven closed: contested");
        assertEq(wContested, 10e18);
        _closeDayLocally(2);
        (, , bool closed) = RewardClosureFacet(address(diamond)).startDayClosure(2);
        assertTrue(closed, "no obligation covers day 2: proven closed at the start");
        (avail, , wContested, ) = _epoch().getTransportCoverageForDay(1);
        assertEq(wContested, 0, "no longer contested");
        assertEq(avail, 10e18, "drawable as ordinary");
        assertEq(_claim(), NEED, "paid from the epoch, transport-first");
        (uint256 lf, ) = _legs(h);
        assertEq(lf, NEED);
    }

    /// @dev 3c-1 — the NECESSITY tier (design 2480–2506, revived from #2276
    ///      r26 with the contested gate beside it): a shared epoch whose other
    ///      listed day has NOT arrived is drawn LAST, only for the gap live
    ///      funding cannot cover. Live pays day 1; the epoch is left whole.
    function test_ASharedEpochWithAnUnarrivedDay_IsDrawnLast_WhenLiveCanPay() public {
        _scene(NEED); // day 2 is never stamped: unarrived
        _liveOf(1e18, _one(1), 1, keccak256("live"));
        bytes32 h = _epochOf(10e18, _two(1, 2), 2, keccak256("shared"));
        (uint256 avail, , uint256 wContested, ) = _epoch().getTransportCoverageForDay(1);
        assertEq(wContested, 0, "an unarrived day does not contest");
        assertEq(avail, 10e18, "it is available - as necessity");
        (uint256 ordinary, uint256 necessity) = _epoch().getTransportTiersForDay(1);
        assertEq(ordinary, 0); assertEq(necessity, 10e18);
        uint256 liveBefore = _row(LibVaipakam.RewardCustodyRow.LiveFresh);
        assertEq(_claim(), NEED);
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(lf + lr, 0, "the shared epoch is spared for its unarrived day");
        assertEq(liveBefore - _row(LibVaipakam.RewardCustodyRow.LiveFresh), NEED, "live paid day 1");
    }

    /// @dev ...and drawn when it is the ONLY way to pay (necessity, not
    ///      exclusion): no live delivery, so day 1 is funded from the shared
    ///      epoch for exactly its gap.
    function test_ASharedEpochWithAnUnarrivedDay_StillPays_WhenNothingElseCan() public {
        _scene(NEED);
        bytes32 h = _epochOf(10e18, _two(1, 2), 2, keccak256("shared-only"));
        assertEq(_claim(), NEED, "the day is paid from the shared epoch");
        (uint256 lf, ) = _legs(h);
        assertEq(lf, NEED, "for exactly the day's gap");
        assertEq(_balance(h), 10e18 - NEED, "and the rest stays for the unarrived day");
    }

    /// @dev 3c-1 — the necessity tier is never STAGED: a record (the wide-day
    ///      path) stages only ordinary epochs, since the live shortfall the
    ///      necessity tier may serve is known at reservation, not at staging.
    ///      The one-call path above is the only reader of that tier.
    function test_ANecessityTierEpoch_IsNotStageable() public {
        _scene(NEED);
        bytes32 h = _epochOf(10e18, _two(1, 2), 2, keccak256("shared"));
        (uint8 gates, bool stageable) = _epoch().getTransportBatchGates(h);
        assertEq(gates, 8, "necessity"); assertFalse(stageable, "necessity: not stageable");
        _armedDay(2, NEED);
        _closeDayLocally(2);
        RewardClosureFacet(address(diamond)).startDayClosure(2);
        (gates, stageable) = _epoch().getTransportBatchGates(h);
        assertEq(gates, 0); assertTrue(stageable, "ordinary once day 2 is arrived and closed");
    }

    /// @dev 3c-1 — an epoch wider than the fan-out cap, or one indexed before
    ///      its day list was kept, cannot have its gates read on a hot path:
    ///      it is withheld as contested, conservatively.
    function test_AnOversizeOrListlessEpoch_IsWithheld() public {
        _scene(NEED);
        bytes32 h = _epochOf(10e18, _two(1, 2), 2, keccak256("listless"));
        _mut().clearTransportBatchDaysRaw(h);
        (uint256 avail, , uint256 wContested, ) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 0); assertEq(wContested, 10e18, "list unknown: withheld");
        uint256[] memory wide = new uint256[](33);
        for (uint256 i; i < 33; ++i) wide[i] = i + 1;
        _epochOf(5e18, wide, 3, keccak256("oversize"));
        (avail, , wContested, ) = _epoch().getTransportCoverageForDay(1);
        assertEq(wContested, 15e18, "oversize: withheld too");
        assertEq(avail, 0);
    }

    /// @dev A classification correction never retypes a drawn leg (Codex
    ///      #2276 r26 P1): the leg was settled against custody. A recycled
    ///      correction that takes classification plus the recycled leg past
    ///      the recycled cap is RECORDED on the divergence view, and the
    ///      saturated room admits no further recycled draw.
    function test_AClassificationCorrection_NeverRetypesADrawnLeg() public {
        uint256[] memory d1 = _one(1);
        bytes32 h = _epochSplit(10e18, d1, 3, keccak256("corr"), 1, 1); // caps 5e18 fresh / 5e18 recycled
        _mut().classifyPacketPreGateRaw(h, 5e18, 0);
        _mut().setTransportBatchConsumedRaw(h, 0, 5e18); // five drawn recycled, within its cap
        _mut().moveClassificationRaw(h, 5e18, true); // the correction: 5F -> 5R
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(lf, 0, "the drawn legs stand as settled");
        assertEq(lr, 5e18, "no leg is retyped");
        (bool att, uint256 exF, uint256 exR) =
            RewardReconciliationFacet(address(diamond)).getPacketClassificationExcess(h);
        assertTrue(att);
        assertEq(exF, 0, "fresh within its cap");
        assertEq(exR, 5e18, "classification plus the recycled leg past the cap, recorded");
        (, uint256 tr, ) = _alloc(1, 0, 5e18, type(uint256).max, 0, 0);
        assertEq(tr, 0, "and no further recycled draw is admitted");
    }

    /// @dev A cap-hit deferral's prune is progress the claim keeps even when
    ///      it pays nothing (Codex #2276 r4 P2): 64 leading epochs exhausted
    ///      (parked) and a funded 65th beyond the window. The first claim pays
    ///      nothing, does not revert, and moves the cursor; the second pays.
    function test_APrune_SurvivesAnEmptyClaim() public {
        _scene(NEED);
        for (uint256 i; i < 64; ++i) {
            bytes32 h = _epochOf(1, _one(1), 100 + i, keccak256(abi.encode("dust", i)));
            _mut().parkTransportBatchRaw(h);
        }
        // Arrives after the husks, so it is ordered behind them (same-block
        // arrivals would be ordered by batch id — Codex #2276 r6).
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _epochOf(NEED, _one(1), 300, keccak256("funded"));
        assertEq(_cursor(1), 0, "fixture: the window starts at the husks");
        assertEq(_claim(), 0, "deferred on the window, not reverted");
        assertEq(_cursor(1), 64, "the prune persisted");
        assertEq(_claim(), NEED, "the next attempt sees the funded epoch");
    }

    /// @dev The day's index is arrival-ordered whoever indexes it (Codex #2276
    ///      r5 P1): the newer epoch is indexed first, and the older one still
    ///      leads the index.
    function test_TheIndex_IsArrivalOrdered_WhoeverIndexesFirst() public {
        uint256[] memory d1 = _one(1);
        bytes32 hOld = _landFresh(1e18, d1, 11, keccak256("old"));
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        bytes32 hNew = _landFresh(1e18, d1, 12, keccak256("new"));
        _index(hNew);
        _index(hOld);
        (bytes32[] memory page, , , ) = _epoch().getTransportDayBatches(1, 0, 10);
        assertEq(page.length, 2);
        assertEq(page[0], hOld, "the older arrival leads, whoever indexed first");
        assertEq(page[1], hNew);
    }

    /// @dev Each leg is served first from the epochs least able to serve the
    ///      other (Codex #2276 r5 P1): a flexible epoch ahead of a fresh-only
    ///      one, a 5F/5R ask — the fresh-only epoch pays fresh, the flexible
    ///      one recycled, and both legs are covered.
    function test_TheSplit_ServesEachLegFromTheLeastFlexibleEpoch() public {
        _epochFlex(5e18, _one(1), 41, keccak256("flexible"));
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _epochSplit(5e18, _one(1), 42, keccak256("fresh-only"), 5e18, 0);
        (uint256 tf, uint256 tr, ) = _alloc(1, 5e18, 5e18, type(uint256).max, 0, 0);
        assertEq(tf, 5e18, "fresh from the epoch that can serve nothing else");
        assertEq(tr, 5e18, "recycled from the flexible one");
    }

    /// @dev Coverage a leg's cap rejects goes to the other leg (Codex #2276
    ///      r6 P1): a recycled-only epoch, a 5F/5R day, live fresh and bucket
    ///      each covering their leg — the tie rule asks fresh, the epoch can
    ///      pay none of it, and the allocation offers the coverage to recycled
    ///      instead of leaving the epoch untouched.
    function test_CapRejectedCoverage_GoesToTheOtherLeg() public {
        _epochSplit(5e18, _one(1), 51, keccak256("recycled-only"), 0, 5e18);
        (uint256 tf, uint256 tr, ) = _alloc(1, 5e18, 5e18, type(uint256).max, 5e18, 5e18);
        assertEq(tf, 0, "the epoch cannot pay fresh");
        assertEq(tr, 5e18, "so it pays the recycled leg, transport first");
    }

    /// @dev Same-block arrivals are ordered by batch id whoever materializes
    ///      first (Codex #2276 r6 P1): two deliveries in one block, indexed in
    ///      the order that would put the larger id first, still read in id
    ///      order.
    function test_TheIndex_BreaksSameBlockTies_ByBatchId() public {
        uint256[] memory d1 = _one(1);
        bytes32 hx = _landFresh(1e18, d1, 61, keccak256("x"));
        bytes32 hy = _landFresh(1e18, d1, 62, keccak256("y"));
        (bytes32 lo, bytes32 hi) = hx < hy ? (hx, hy) : (hy, hx);
        _index(hi);
        _index(lo);
        (bytes32[] memory page, , , ) = _epoch().getTransportDayBatches(1, 0, 10);
        assertEq(page[0], lo, "the smaller id leads, whoever indexed first");
        assertEq(page[1], hi);
    }

    /// @dev A late epoch links into its place in constant work (Codex #2276
    ///      r7 P2): an old two-day epoch indexed after 70 newer ones on each
    ///      day indexes both days in ONE call and leads both lists.
    function test_Materialization_LinksALateEpochInConstantWork() public {
        uint256[] memory both = _two(1, 2);
        bytes32 hOld = _landFresh(1e18, both, 70, keccak256("old"));
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        for (uint256 i; i < 70; ++i) {
            _epochOf(1, both, 100 + i, keccak256(abi.encode("newer", i)));
        }
        assertEq(_index(hOld), 2, "both days in one call");
        (bytes32[] memory p1, , uint256 t1, ) = _epoch().getTransportDayBatches(1, 0, 1);
        assertEq(t1, 71);
        assertEq(p1[0], hOld, "at the front of day 1");
        (bytes32[] memory p2, , , ) = _epoch().getTransportDayBatches(2, 0, 1);
        assertEq(p2[0], hOld, "at the front of day 2");
    }

    /// @dev Without a predecessor hint the ledger walks back a bounded number
    ///      of steps and refuses past it; with the hint (the head here) the
    ///      same epoch links in constant work (Codex #2276 r7 P2).
    function test_Materialization_RefusesAnUnboundedWalk_UnlessHinted() public {
        uint256[] memory d1 = _one(1);
        bytes32 hOld = _landFresh(1e18, d1, 80, keccak256("older"));
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        for (uint256 i; i < 130; ++i) {
            _epochOf(1, d1, 200 + i, keccak256(abi.encode("newer", i)));
        }
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.TransportIndexWalkExceeded.selector, hOld, 1));
        _index(hOld);
        bytes32[] memory hints = new bytes32[](1); // zero: at the head
        assertEq(_indexHinted(hOld, 0, hints), 1, "linked with the hint");
        (bytes32[] memory page, , uint256 total, ) = _epoch().getTransportDayBatches(1, 0, 1);
        assertEq(total, 131);
        assertEq(page[0], hOld, "at the front");
        bytes32 wrong = page[0];
        vm.expectRevert();
        _indexHinted(hOld, 0, _hintOf(wrong)); // already indexed: refused
    }

    function _hintOf(bytes32 h) internal pure returns (bytes32[] memory a) {
        a = new bytes32[](1);
        a[0] = h;
    }

    /// @dev A day's reported coverage counts only what its epochs can pay
    ///      through at least one leg (Codex #2276 r7 P2): a 1F/2R split on 2
    ///      wei records 0 fresh room and 1 recycled room, and the day can fund
    ///      1, not 2.
    function test_TheCoverage_CountsOnlyWhatIsDrawable() public {
        _epochSplit(2, _one(1), 90, keccak256("two-wei"), 1, 2);
        (uint256 avail, , , ) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 1, "the residual wei is reserved for the disposition path");
    }

    /// @dev A day deferred on the scan window ends the whole call's walk, on
    ///      every side (Codex #2276 r7 P2): the claimant covers day 1 on both
    ///      sides, 64 husks lead the day and a funded epoch sits beyond them.
    ///      The first claim pays nothing and prunes; the preview agrees; the
    ///      second claim pays both sides from the now-visible epoch.
    function test_ACapHitDeferral_EndsTheWalkOnEverySide() public {
        _mut().setDayPoolStampRaw(1, uint128(2e18), 0);
        _mut().setKnownGlobalDailyInterest(1, 1e18, 1e18, true);
        _mut().setDayCapThreshold18(1, type(uint256).max);
        _mut().setDayCapModeRaw(1, 1);
        _mut().setDayUserSideCapRaw(1, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(1);
        _entry(1, 2);
        uint256 b = _mut().pushRewardEntry(alice, LOAN, LibVaipakam.RewardSide.Borrower, 1e18, 1);
        _mut().closeRewardEntryRaw(b, 2);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        for (uint256 i; i < 64; ++i) {
            bytes32 h = _epochOf(1, _one(1), 400 + i, keccak256(abi.encode("husk", i)));
            _mut().parkTransportBatchRaw(h);
        }
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _epochOf(2 * NEED, _one(1), 500, keccak256("funded"));
        assertEq(_preview(), 0, "the preview stops at the window too");
        assertEq(_claim(), 0, "deferred on the window; the walk ended on both sides");
        assertEq(_cursor(1), 64, "and the prune persisted");
        assertEq(_claim(), 2 * NEED, "the next call pays both sides from the funded epoch");
    }

    /// @dev A draw records its exit on the PACKET too, so the packet's own

    // ─── round 8: days indexed before the list; residual-only epochs; the lens ──

    /// @dev An attested epoch with no room left under either cap is exhausted
    ///      for the cursor even though a residual unit remains (Codex #2276 r8
    ///      P2), reached the way a real one is: a two-leg day, an epoch one
    ///      wei over the two legs attested at the legs' proportion, so the
    ///      floors leave one wei outside both caps; the claim drains both
    ///      rooms, the wei stays, and the prune passes the epoch.
    function test_AResidualOnlyEpoch_IsExhaustedForTheCursor() public {
        _twoLegDay(1, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(1);
        _entry(1, 2);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        (uint256 needF, uint256 needR) = _dayNeeds(1);
        assertGt(needR, 0, "fixture: a recycled leg");
        bytes32 h = _epochSplit(needF + needR + 1, _one(1), 2, keccak256("e"), needF, needR);
        _mut().setOutstandingCommitRaw(0, needR);
        assertEq(_claim(), NEED);
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(lf, needF, "both rooms drained");
        assertEq(lr, needR);
        assertEq(_balance(h), 1, "the residual wei remains");
        (uint256 avail, , , ) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 0, "and is not coverage");
        assertEq(_cursor(1), 1, "the draw's own prune passed the epoch");
        _epoch().epochPruneTransportDayCursor(1);
        assertEq(_cursor(1), 1, "idempotent");
    }

    /// @dev 64 residual-only epochs ahead of a funded one (Codex #2276 r8 P2):
    ///      each holds one wei with both caps attested at zero. The first
    ///      claim defers on the window and prunes past them; the second pays.
    ///      Before r8 the prune passed only an empty epoch and the day was
    ///      deferred forever.
    function test_ResidualOnlyEpochs_DoNotHoldTheWindow() public {
        _scene(NEED);
        for (uint256 i; i < 64; ++i) {
            _epochSplit(1, _one(1), 600 + i, keccak256(abi.encode("residual", i)), 1, 1); // one wei at 1:1 floors to 0 fresh / 0 recycled
        }
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _epochOf(NEED, _one(1), 700, keccak256("funded"));
        (uint256 avail, bool capHit, , ) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 0, "the residuals fund nothing");
        assertTrue(capHit, "and fill the window");
        assertEq(_claim(), 0, "deferred on the window");
        assertEq(_cursor(1), 64, "the residual epochs are exhausted for the cursor");
        assertEq(_claim(), NEED, "the funded epoch is reachable");
    }

    /// @dev Node-based pages each cost their own length (Codex #2276 r8 P2):
    ///      a page from the head, the next from the node it names, the end.
    function test_TheLens_PagesFromANode() public {
        bytes32[] memory hs = new bytes32[](5);
        for (uint256 i; i < 5; ++i) {
            hs[i] = _epochOf(1e18, _one(1), 800 + i, keccak256(abi.encode("p", i)));
            vm.warp(vm.getBlockTimestamp() + 1);
        }
        (bytes32[] memory p1, uint64[] memory at1, bytes32 next) = _epoch().getTransportDayBatchesFrom(1, bytes32(0), 2);
        assertEq(p1.length, 2);
        assertEq(p1[0], hs[0]);
        assertEq(p1[1], hs[1]);
        assertLt(at1[0], at1[1], "with their ordering keys");
        assertEq(next, hs[2], "the next page starts at the node named");
        (bytes32[] memory p2, , bytes32 next2) = _epoch().getTransportDayBatchesFrom(1, next, 10);
        assertEq(p2.length, 3, "the rest");
        assertEq(p2[0], hs[2]);
        assertEq(p2[2], hs[4]);
        assertEq(next2, bytes32(0), "the end");
        (bytes32[] memory none, , bytes32 next3) = _epoch().getTransportDayBatchesFrom(1, bytes32(0), 0);
        assertEq(none.length, 0, "an empty page");
        assertEq(next3, hs[0], "starts where it was asked to");
        (bytes32[] memory stray, , bytes32 next4) = _epoch().getTransportDayBatchesFrom(1, keccak256("elsewhere"), 10);
        assertEq(stray.length, 0, "a node outside the order pages nothing");
        assertEq(next4, bytes32(0));
    }

    // ─── round 9: a wide pre-list day; the exact split; caps net of classification; the preview's prune ──

    /// @dev The split spends in plan order, and holds an epoch's flexible
    ///      balance back only where a later epoch's capacity for the other
    ///      leg could not otherwise be used (Codex #2276 r12 P1), on Codex's
    ///      shape: a flexible one-day epoch ahead of a fresh-only two-day
    ///      epoch, a fresh-only obligation on the first day — the one-day
    ///      epoch pays, and the two-day epoch keeps its fresh for the other
    ///      day; the round-5 shape (both legs asked) still reserves it.
    function test_TheSplit_HonoursPlanPriority_ReservingOnlyAsNeeded() public {
        _scene(NEED);
        bytes32 one = _epochOf(NEED, _one(1), 51, keccak256("one-day"));
        vm.warp(vm.getBlockTimestamp() + 1);
        bytes32 two = _epochOf(NEED, _two(1, 2), 52, keccak256("two-day"));
        assertEq(_claim(), NEED);
        (uint256 lf1, ) = _legs(one);
        (uint256 lf2, ) = _legs(two);
        assertEq(lf1, NEED, "the one-day epoch pays: the priority");
        assertEq(lf2, 0, "the two-day epoch is kept for its other day");
    }

    /// @dev A day's ORDER holds every member from the first, with no link step
    ///      and no second read source (Codex #2296 items 2 and 4). Three
    ///      epochs read back complete and in order the moment they are
    ///      materialized; a day WIDER than one scan window draws from its
    ///      window rather than being refused outright, which is what the
    ///      retired array-ordered path could not do (a window of an array is
    ///      not a prefix of the order, so such a day had to defer with nothing
    ///      drawn); and the retired catch-up entry is not routed at all. The
    ///      five pre-list cells this replaces built a day the ledger can no
    ///      longer be in: an array holding members its order does not.
    function test_ADaysOrder_HoldsEveryMember_WithNoLinkStep() public {
        for (uint256 i; i < 3; ++i) {
            _epochOf(1, _one(1), 71 + i, keccak256(abi.encode("ordered", i)));
            vm.warp(vm.getBlockTimestamp() + 1);
        }
        (, uint64[] memory at, uint256 total, uint256 cursor) =
            _epoch().getTransportDayBatches(1, 0, 10);
        assertEq(total, 3, "three members in the day's membership set");
        assertEq(cursor, 0, "nothing consumed");
        // The ORDER's own length has to be WALKED. That view's page is sized
        // from the membership count, so its length says nothing about how much
        // the order holds -- asserting on it read as a check and was not one,
        // which the link mutation below is what exposed.
        (bytes32[] memory walk, , bytes32 next) = _epoch().getTransportDayBatchesFrom(1, bytes32(0), 10);
        assertEq(walk.length, total, "and the order holds every one of them, with no link call");
        assertEq(next, bytes32(0), "the walk ends at the last member");
        assertTrue(at[0] < at[1] && at[1] < at[2], "in arrival order");
        (uint256 count, bytes32 node) = _epoch().getTransportDayIndex(1);
        assertEq(count, total, "the index view reports the same membership");
        assertEq(node, bytes32(0), "and no cursor node yet");

        // A day wider than one window: 65 epochs of one wei on day 2, asked
        // for one. The window covers it; the retired path deferred with zero.
        for (uint256 i; i < 65; ++i) {
            _epochOf(1, _one(2), 200 + i, keccak256(abi.encode("wide", i)));
        }
        (uint256 tf, uint256 tr, bool capHit) =
            _alloc(2, 1, 0, type(uint256).max, 0, 0);
        assertEq(tf + tr, 1, "a wide day draws from its window");
        assertTrue(capHit, "and still reports that more lies beyond it");

        // The catch-up entry is retired, and the control proves the check can
        // fail: a live epoch selector on the same Diamond answers.
        (bool ok, bytes memory ret) = address(diamond).call(
            abi.encodeWithSelector(
                bytes4(keccak256("epochLinkTransportDayIndex(uint256,bytes32[])")),
                uint256(1),
                new bytes32[](0)
            )
        );
        assertFalse(ok, "the retired catch-up entry is not routed");
        assertEq(
            bytes4(ret),
            bytes4(keccak256("FunctionDoesNotExist()")),
            "unrouted, not a body that reverts"
        );
        (ok, ) = address(diamond).call(
            abi.encodeWithSelector(RewardEpochFacet.getTransportDayScanIds.selector, uint256(1))
        );
        assertTrue(ok, "control: a routed epoch selector answers");
    }

    /// @dev Where two coverings of the same ask are equal in amount, the split
    ///      spends the EARLIER epochs (Codex #2276 r17 P1, arrested per #2296
    ///      item 1), on Codex's shape: a flexible epoch, then a fresh-only
    ///      one, then a recycled-only one, asked one of each leg. The retired
    ///      fresh-first tie gave the flexible epoch's balance to fresh and so
    ///      reached PAST the fresh-only epoch to the recycled-only one; now the
    ///      flexible epoch pays recycled, the nearer fresh capacity is the one
    ///      consumed, and the last epoch is left for the other day it may
    ///      list. The coverage is the same either way, which is exactly why
    ///      the totals cannot see the difference.
    function test_TheSplit_SparesTheLaterEpoch_WhenEitherLegCouldPay() public {
        bytes32 flex = _epochFlex(1, _one(1), 41, keccak256("tie-flexible"));
        vm.warp(vm.getBlockTimestamp() + 1);
        bytes32 freshOnly = _epochSplit(1, _one(1), 42, keccak256("tie-fresh-only"), 1, 0);
        vm.warp(vm.getBlockTimestamp() + 1);
        bytes32 recycledOnly = _epochSplit(1, _one(1), 43, keccak256("tie-recycled-only"), 0, 1);
        (uint256 tf, uint256 tr, ) =
            _alloc(1, 1, 1, type(uint256).max, 0, 0);
        assertEq(tf, 1, "the fresh leg is covered");
        assertEq(tr, 1, "and the recycled leg: the tie never costs coverage");
        (uint256 af, uint256 ar) = _plannedLegs(1, 1, 1, flex);
        assertEq(af, 0, "the flexible epoch does not take the fresh leg");
        assertEq(ar, 1, "it takes recycled: its fresh alternative is the nearer one");
        (uint256 bf, uint256 br) = _plannedLegs(1, 1, 1, freshOnly);
        assertEq(bf, 1, "so the nearer capacity is the one consumed");
        assertEq(br, 0);
        (uint256 cf, uint256 cr) = _plannedLegs(1, 1, 1, recycledOnly);
        assertEq(cf + cr, 0, "and the later epoch is spared for its other day");
    }

    /// @dev The SECOND shape on the same decision (Codex #2276, the round
    ///      after the tie landed): when both legs' next capacity is the SAME
    ///      epoch, comparing only that index says nothing, and fresh-first
    ///      drained a third epoch. Plan-ordered A = flexible 1, B = 2 with one
    ///      unit of room per leg, C = recycled-only 1, asked 1F/2R. A to fresh
    ///      leaves 2R, which B (one unit of recycled room) cannot meet alone,
    ///      so C is opened; A to recycled leaves 1F/1R, which B covers exactly,
    ///      and C — which may list another day — is left standing. Same
    ///      coverage either way, so again the totals cannot see it.
    function test_TheSplit_SparesTheLaterEpoch_WhenBothLegsShareTheNextOne() public {
        bytes32 flex = _epochFlex(1, _one(1), 81, keccak256("joint-flexible"));
        vm.warp(vm.getBlockTimestamp() + 1);
        bytes32 both = _epochSplit(2, _one(1), 82, keccak256("joint-both"), 1, 1);
        vm.warp(vm.getBlockTimestamp() + 1);
        bytes32 recycledOnly = _epochSplit(1, _one(1), 83, keccak256("joint-recycled-only"), 0, 1);
        (uint256 tf, uint256 tr, ) =
            _alloc(1, 1, 2, type(uint256).max, 0, 0);
        assertEq(tf, 1, "the fresh leg is covered");
        assertEq(tr, 2, "and both recycled units: the rule never costs coverage");
        (uint256 af, uint256 ar) = _plannedLegs(1, 1, 2, flex);
        assertEq(af, 0, "the flexible epoch does not take the fresh leg");
        assertEq(ar, 1, "it takes recycled: that is the leg that must otherwise reach furthest");
        (uint256 bf, uint256 br) = _plannedLegs(1, 1, 2, both);
        assertEq(bf, 1, "so the shared next epoch pays BOTH its legs");
        assertEq(br, 1, "rather than one of them");
        (uint256 cf, uint256 cr) = _plannedLegs(1, 1, 2, recycledOnly);
        assertEq(cf + cr, 0, "and the later epoch is spared for its other day");
    }

    /// @dev The split pays the most either leg can be paid (Codex #2276 r9
    ///      P1), on Codex's shape: an older unattested one-wei epoch (wholly
    ///      flexible) ahead of an attested two-wei epoch with one wei of room
    ///      per leg (wholly exclusive); asked 1F/2R, the exclusive epoch pays
    ///      1F and 1R and the flexible one the last 1R — 1F/2R, where ordering
    ///      by raw room paid 1F/1R.
    function test_TheSplit_TakesExclusiveCapacityFirst() public {
        _epochFlex(1, _one(1), 31, keccak256("flexible"));
        vm.warp(vm.getBlockTimestamp() + 1);
        _epochSplit(2, _one(1), 32, keccak256("exclusive"), 1, 1);
        (uint256 tf, uint256 tr, ) = _alloc(1, 1, 2, type(uint256).max, 0, 0);
        assertEq(tf, 1, "fresh from the exclusive epoch");
        assertEq(tr, 2, "recycled from both");
    }

    // ─── round 10: the marker follows the live draw's reach; the lens's numeric cursor ──

    /// @dev The lens keeps its numeric cursor on the existing selector and
    ///      reports it EXACTLY whatever the read walks (Codex #2276 r10, r11
    ///      P2): a stored position, since the cursor only advances; the node
    ///      comes from the day-index view.
    function test_TheLens_ReportsTheExactCursor_WhateverTheWalk() public {
        bytes32[] memory hs = new bytes32[](3);
        for (uint256 i; i < 3; ++i) {
            hs[i] = _epochOf(1e18, _one(1), 800 + i, keccak256(abi.encode("c", i)));
            vm.warp(vm.getBlockTimestamp() + 1);
        }
        _mut().parkTransportBatchRaw(hs[0]);
        _mut().parkTransportBatchRaw(hs[1]);
        _epoch().epochPruneTransportDayCursor(1);
        (, , , uint256 c1) = _epoch().getTransportDayBatches(1, 0, 1);
        assertEq(c1, 2, "exact on a one-node walk");
        (, , , uint256 c2) = _epoch().getTransportDayBatches(1, 0, 2);
        assertEq(c2, 2, "and on a two-node walk");
        (bytes32[] memory none, , uint256 total, uint256 c3) = _epoch().getTransportDayBatches(1, 5, 1);
        assertEq(none.length, 0, "an offset past the end pages nothing");
        assertEq(c3, 2, "and still reports the cursor");
        assertEq(total, 3);
        _mut().parkTransportBatchRaw(hs[2]);
        _epoch().epochPruneTransportDayCursor(1);
        (, , , uint256 c4) = _epoch().getTransportDayBatches(1, 0, 0);
        assertEq(c4, total, "cursor == total reads the day exhausted, on an empty page");
        (, bytes32 node) = _epoch().getTransportDayIndex(1);
        assertEq(node, hs[2], "the node itself, from the day-index view");
    }

    /// @dev A late epoch whose arrival places it among the epochs the cursor
    ///      has passed takes the first place of the window, and the cursor
    ///      does not move back (Codex #2276 r11 P2): the day's order reads
    ///      exhausted, late, live; the position stays exact; coverage counts
    ///      it. A still-older late epoch, hinted, may name only the cursor.
    function test_ALateEpoch_OlderThanTheCursor_LeadsTheWindow() public {
        vm.warp(vm.getBlockTimestamp() + 1 days);
        _scene(NEED);
        uint256[] memory d1 = _one(1);
        bytes32 e1 = _epochOf(NEED, d1, 1, keccak256("e1"));
        vm.warp(vm.getBlockTimestamp() + 1);
        bytes32 e2 = _epochOf(NEED, d1, 2, keccak256("e2"));
        assertEq(_claim(), NEED, "paid from e1, the older");
        assertEq(_cursor(1), 1, "e1 passed");
        bytes32 late = _landFresh(NEED, d1, 3, keccak256("late"));
        _mut().setPacketArrivedAtRaw(late, 2); // landed long before e1; written down now
        _index(late);
        (bytes32[] memory order, , , uint256 cursor) = _epoch().getTransportDayBatches(1, 0, 10);
        assertEq(cursor, 1, "the cursor did not move back");
        assertEq(order[0], e1);
        assertEq(order[1], late, "the first place of the window");
        assertEq(order[2], e2);
        (uint256 avail, , , ) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 2 * NEED, "visible and counted");
        bytes32 older = _landFresh(NEED, d1, 4, keccak256("older"));
        _mut().setPacketArrivedAtRaw(older, 1);
        bytes32[] memory hints = new bytes32[](1); // zero: at the head — inside the passed prefix
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.TransportIndexHintInvalid.selector, older, 1, bytes32(0)));
        _indexHinted(older, 0, hints);
        hints[0] = e1; // the cursor may precede an epoch older than itself
        assertEq(_indexHinted(older, 0, hints), 1);
        (order, , , cursor) = _epoch().getTransportDayBatches(1, 0, 10);
        assertEq(cursor, 1, "still");
        assertEq(order[1], older, "the older late epoch leads the window, by key");
        assertEq(order[2], late);
        assertEq(order[3], e2);
    }

    /// @dev Late epochs after the cursor are ordered by key among themselves
    ///      whoever links them and in whatever order (Codex #2276 r12 P1):
    ///      arrivals 50 then 1 read [1, 50]; one at 25 finds its place between
    ///      them unhinted, or hinted at the epoch before it; a hint at a
    ///      passed epoch other than the cursor, or at the head, is refused.
    function test_LateEpochs_KeepTheirOrderAfterTheCursor() public {
        vm.warp(vm.getBlockTimestamp() + 1 days);
        _scene(NEED);
        uint256[] memory d1 = _one(1);
        bytes32 e0 = _epochOf(1, d1, 1, keccak256("e0"));
        _mut().parkTransportBatchRaw(e0);
        vm.warp(vm.getBlockTimestamp() + 1);
        bytes32 e1 = _epochOf(NEED, d1, 2, keccak256("e1"));
        assertEq(_claim(), NEED);
        assertEq(_cursor(1), 2, "e0 and e1 passed");
        bytes32[] memory hs = new bytes32[](3);
        uint64[3] memory at = [uint64(50), 1, 25];
        for (uint256 i; i < 3; ++i) {
            hs[i] = _landFresh(1e18, d1, 10 + i, keccak256(abi.encode("late", i)));
            _mut().setPacketArrivedAtRaw(hs[i], at[i]);
        }
        _index(hs[0]); // arrival 50
        _index(hs[1]); // arrival 1, linked second
        (bytes32[] memory order, , , uint256 cursor) = _epoch().getTransportDayBatches(1, 0, 10);
        assertEq(cursor, 2, "the cursor did not move");
        assertEq(order[2], hs[1], "arrival 1 leads the window");
        assertEq(order[3], hs[0], "arrival 50 after it, although linked first");
        bytes32[] memory hints = new bytes32[](1);
        hints[0] = e0; // passed, and not the cursor
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.TransportIndexHintInvalid.selector, hs[2], 1, e0));
        _indexHinted(hs[2], 0, hints);
        hints[0] = bytes32(0); // the head: behind the window
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.TransportIndexHintInvalid.selector, hs[2], 1, bytes32(0)));
        _indexHinted(hs[2], 0, hints);
        hints[0] = hs[1]; // arrival 1: the epoch before arrival 25
        assertEq(_indexHinted(hs[2], 0, hints), 1);
        (order, , , cursor) = _epoch().getTransportDayBatches(1, 0, 10);
        assertEq(cursor, 2);
        assertEq(order[2], hs[1]);
        assertEq(order[3], hs[2], "arrival 25 between them");
        assertEq(order[4], hs[0]);
    }

    // ─── round 14: the call's epoch-write budget; the exact conversion ──

    /// @dev A settlement call draws from at most `TRANSPORT_DRAW_CALL_CAP`
    ///      epochs over every day it settles (Codex #2276 r14 P1): three days
    ///      each funded by a window of sixty-four small epochs — the first
    ///      call pays two days and defers the third, keeping the two, the
    ///      preview says the same, and the next call pays the third.
    function test_TheClaim_StopsAtTheEpochWriteBudget_AndTheNextCallGoesOn() public {
        _armedDay(1, NEED);
        _armedDay(2, NEED);
        _armedDay(3, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(3);
        _entry(1, 4);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        for (uint256 d = 1; d <= 3; ++d) {
            for (uint256 i; i < 64; ++i) {
                _epochOf(NEED / 64, _one(d), 1000 * d + i, keccak256(abi.encode("small", d, i)));
            }
            vm.warp(vm.getBlockTimestamp() + 1);
        }
        assertEq(_preview(), 2 * NEED, "the preview stops where the claim will");
        (uint256 first, uint256 second) = _claimTwiceInOneTx();
        assertEq(first, 2 * NEED, "two days of sixty-four epochs each: the budget");
        // A settlement batched in the SAME transaction after the budget is
        // spent (Codex #2276 r15 P2): its first day defers, the earlier draws
        // are its progress, it pays nothing — and does not revert the batch.
        assertEq(second, 0, "batched after the budget: nothing paid, nothing reverted");
        // On chain the next claim is its own transaction and its transient
        // count starts at zero. Forge 1.8+ already gives each top-level call a
        // fresh transient context; the raw reset keeps this right on earlier
        // forge, where a whole test shared one.
        _mut().resetTransportDrawWritesRaw();
        assertEq(_claim(), NEED, "the next transaction pays the third day");
    }

    /// @dev A classification already past its cap is RECORDED as a divergence
    ///      rather than saturated away (Codex #2276 r15 P1): a ten-token epoch
    ///      attested 8F/2R carrying seven recycled classified without the batch
    ///      gate — the recycled excess of five is exposed, the recycled room is
    ///      zero, and the epoch's coverage is fresh-only. The view follows the
    ///      CURRENT classifications through a correction.
    function test_AClassificationPastItsCap_IsRecorded_AndFollowsCorrections() public {
        uint256[] memory d1 = _one(1);
        bytes32 h = _epochSplit(10e18, d1, 2, keccak256("roll"), 8, 2); // caps 8e18 fresh / 2e18 recycled
        _mut().classifyPacketPreGateRaw(h, 0, 7e18);
        (bool att, uint256 exF, uint256 exR) =
            RewardReconciliationFacet(address(diamond)).getPacketClassificationExcess(h);
        assertTrue(att, "attested from the wire, so a zero below is a real zero");
        assertEq(exF, 0);
        assertEq(exR, 5e18, "the recycled classification exceeds its cap by five: recorded");
        // A CORRECTION moves the five back to fresh (0F/7R -> 5F/2R against caps
        // 8F/2R). The view must follow the current classifications: both
        // components are now within their caps, so it reports no excess at all
        // (Codex #2276 — a figure frozen at attestation kept reporting five).
        _mut().setPacketClassifiedRaw(h, 5e18, 2e18);
        (att, exF, exR) = RewardReconciliationFacet(address(diamond)).getPacketClassificationExcess(h);
        assertTrue(att);
        assertEq(exF + exR, 0, "after the correction the packet is within both caps");
        // Put the classification back, so the allocation checks below see the
        // state they were written against.
        _mut().setPacketClassifiedRaw(h, 0, 7e18);
        // An unrecorded hash is refused, never read as a packet within its caps (Codex #2276 r16 P2).
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ReconciliationPacketUnknown.selector, keccak256("nobody")));
        RewardReconciliationFacet(address(diamond)).getPacketClassificationExcess(keccak256("nobody"));
        (uint256 tf, uint256 tr, ) = _alloc(1, 3e18, 3e18, type(uint256).max, 0, 0);
        assertEq(tf, 3e18, "the epoch pays fresh within its room");
        assertEq(tr, 0, "and no recycled room remains under a cap the classification already exceeds");
    }

    /// @dev Before a split is attested the excess is not knowable, and the lens
    ///      says so rather than report a zero that reads as "within caps"
    ///      (Codex #2276). Every d6 epoch is attested at landing, so the
    ///      unattested state is stood in raw.
    function test_AnUnattestedPacket_ReportsNoExcessFigure() public {
        bytes32 h = _epochRaw(10e18, _one(1), 2, keccak256("unattested-excess"));
        (bool att, uint256 exF, uint256 exR) =
            RewardReconciliationFacet(address(diamond)).getPacketClassificationExcess(h);
        assertFalse(att, "the excess is not yet knowable");
        assertEq(exF + exR, 0, "and no figure is offered in its place");
    }

    /// @dev A forfeit's recycled slice is a commitment release and draws no
    ///      epoch value (Codex #2276 r5 P1), on Codex's shape: forfeited day A
    ///      (fresh + recycled) with an A-only epoch, live day B, live delivery
    ///      just enough for one day, bucket empty. The epoch pays A's fresh, A's
    ///      recycled is released, and the live delivery is left for B.
    function test_AForfeitsRecycledSlice_DrawsNoEpoch() public {
        _twoLegDay(1, NEED);
        _armedDay(2, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(2);
        uint256 a = _entry(1, 2);
        _mut().setRewardEntryForfeitedRaw(a);
        _entry(2, 3);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        bytes32 h = _epochOf(NEED / 2, _one(1), 31, keccak256("a-only"));
        _liveOf(NEED, _two(1, 2), 32, keccak256("live"));
        assertEq(_cfg().getRecycleBucket(), 0, "fixture: the bucket is empty");
        assertEq(_claim(), NEED, "day B paid from the live delivery the forfeit did not consume");
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(lf, NEED / 2, "the epoch paid the forfeit's fresh slice");
        assertEq(lr, 0, "and none of its recycled slice, which is a release");
    }

    /// @dev A draw records its exit on the PACKET too, so the packet's own
    ///      identity holds after it (Codex #2274 r8 P1).
    function test_ADraw_KeepsThePacketIdentity() public {
        _scene(NEED);
        bytes32 h = _epochOf(10e18, _one(1), 1, keccak256("e"));
        assertEq(_claim(), NEED);
        (, uint256 protectedIn, uint256 unclassified, uint256 cf, uint256 cr, uint256 disposed, , uint256 drawn) =
            RewardReconciliationFacet(address(diamond)).getPacketReconciliation(h);
        assertEq(drawn, NEED, "the draw is the packet's exit");
        assertEq(unclassified + cf + cr + disposed + drawn, protectedIn, "packet identity after a draw");
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(lf + lr, drawn, "and equals the epoch's two legs");
    }

    /// @dev A wider epoch is withheld while a single-day one pays: X lists
    ///      days 1 and 2, Y lists day 1 only, X indexed first. Day 2 has ARRIVED
    ///      and alice's entry still covers it, so a draw on X for day 1 is
    ///      CONTESTED (3c-1): day 1 spends Y; X is drawn for neither day and
    ///      stands whole until day 2 settles and is proven closed.
    function test_AWiderEpoch_IsWithheld_WhileTheSingleDayEpochPays() public {
        _armedDay(1, NEED);
        _armedDay(2, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(2);
        _entry(1, 3);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        bytes32 x = _epochOf(NEED, _two(1, 2), 1, keccak256("x")); // indexed first
        bytes32 y = _epochOf(NEED, _one(1), 2, keccak256("y"));
        assertEq(_preview(), NEED, "the preview pays day 1 only");
        assertEq(_claim(), NEED, "and so does the claim");
        (uint256 xf, uint256 xr) = _legs(x);
        (uint256 yf, ) = _legs(y);
        assertEq(yf, NEED, "day 1 spent Y");
        assertEq(xf + xr, 0, "X was drawn for neither day");
        assertEq(_balance(x), NEED, "and stands whole while day 2's obligation is open");
    }

    /// @dev The chain closes `d` itself: its report stamp is the closure proof's
    ///      first condition. A mirror's close dispatches the day's report through
    ///      the messenger, so one is installed (the mock records the send).
    function _closeDayLocally(uint256 d) internal {
        if (address(_closeMessenger) == address(0)) {
            _closeMessenger = new MockRewardMessenger(address(diamond));
            RewardReporterFacet(address(diamond)).setRewardMessenger(address(_closeMessenger));
        }
        RewardReporterFacet(address(diamond)).closeDay(d);
    }

    MockRewardMessenger internal _closeMessenger;

    // ─── the allocation rule, on the design's own cases ─────────────────────

    function test_TheAllocationRule_FromTheDesignsOwnCases() public {
        _epochFlex(5, _one(1), 1, keccak256("five"));
        // 5 fresh / 5 recycled, 5 live fresh, an empty bucket, a 5-token epoch:
        // fully backed ONLY if live pays fresh and the epoch pays recycled.
        uint256 MAX = type(uint256).max; // "the day is the domain"
        (uint256 tf, uint256 tr, bool capHit) = _alloc(1, 5, 5, 100, 5, 0);
        assertEq(tf, 0, "live covers fresh, so the epoch is not spent there");
        assertEq(tr, 5, "the epoch covers the recycled shortfall");
        assertFalse(capHit);
        // No typed source on either leg: fresh first on ties.
        (tf, tr, ) = _alloc(1, 5, 5, 100, 0, 0);
        assertEq(tf, 5);
        assertEq(tr, 0);
        // Both legs typed-covered: transport is still drawn first, in order.
        _epochFlex(5, _one(1), 2, keccak256("five-more"));
        (tf, tr, ) = _alloc(1, 5, 5, 100, 5, 5);
        assertEq(tf, 5);
        assertEq(tr, 5);
        // The fresh need is read net of the pool cap: 2 of headroom, 10 of coverage.
        (tf, tr, ) = _alloc(1, 5, 5, 2, 0, 0);
        assertEq(tf, 2, "never assigned fresh the cap would not let anyone pay");
        assertEq(tr, 5);
    }

    function test_NoEpochs_TheReadsAnswerZero_WithoutAScan() public {
        (uint256 avail, bool capHit, , ) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 0);
        assertFalse(capHit);
        (uint256 tf, uint256 tr, ) =
            _alloc(1, 5, 5, 100, 0, 0);
        assertEq(tf + tr, 0);
    }

    // ─── the entries' gates ─────────────────────────────────────────────────

    function test_TheDraw_IsDiamondInternal_AndBoundedByTheWindow() public {
        _epochOf(10e18, _one(1), 1, keccak256("e1"));
        vm.expectRevert(abi.encodeWithSelector(RewardCustodyOnlyDiamondInternal.selector, address(this)));
        _epoch().epochDrawForDay(1, 1, 0);
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(TransportDrawExceedsCoverage.selector, 1, 11e18, 10e18));
        _epoch().epochDrawForDay(1, 11e18, 0);
    }

    // ───── A2-iii: the static read (row 13) — one entry-day rule, front of side, shared rooms ─────

    function _borrowerEntry(uint32 startDay, uint32 endDay) internal returns (uint256 id) {
        id = _mut().pushRewardEntry(alice, LOAN, LibVaipakam.RewardSide.Borrower, 1e18, startDay);
        _mut().closeRewardEntryRaw(id, endDay);
    }

    /// @dev Both sides' daily interest on an armed day (the lender-only
    ///      {_armedDay} leaves the borrower side's at zero, which prices to
    ///      nothing), and the side cursors advanced past every entry pushed —
    ///      what the production claim does before pricing a day.
    function _twoSidedDay(uint256 d) internal {
        _armedDay(d, NEED);
        _mut().setKnownGlobalDailyInterest(d, 1e18, 1e18, true);
    }

    function _ready() internal {
        _mut().userClaimFundingNeedRaw(alice);
    }

    function _userRead() internal view returns (uint256 armed, bool capHit, uint256 userPaid) {
        (armed, , , , , capHit, , userPaid) = RewardEpochViewFacet(address(diamond)).getUserArmedFreshNeedWithLegs(alice);
    }

    function _entryRead(uint256 id) internal view returns (uint256 armed, bool capHit) {
        (armed, , , , , capHit, , ) = RewardEpochViewFacet(address(diamond)).getRewardEntryArmedNeed(id);
    }

    /// @dev A2-iii — the day primitive's "entry is AT day d" check IS the
    ///      shared cursor rule, so the static read prices a spanning entry
    ///      the claim would stamp this transaction at `D*` without a
    ///      simulated cursor; and a SETTLING caller is still refused such an
    ///      entry, whose legacy slice is unpaid — the walk must never run
    ///      ahead of the legacy settlement.
    function test_ThePrimitive_PricesASettleableSpanningEntryStatically_AndRefusesToSettleIt() public {
        _armedDay(1, NEED);
        _armedDay(2, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(2);
        _loanSideOpen(3);
        uint256 id = _entry(1, 3); // day 1 legacy, day 2 armed; cursor unstamped
        _ready();
        _liveOf(1e18, _one(2), 999, keccak256("live"));
        (uint256 needF, ) = _mut().dayNeedsRaw(alice, LibVaipakam.RewardSide.Lender, 2);
        assertGt(needF, 0, "the static pricing admits the entry at D*");
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.RewardEntrySetMismatch.selector, id));
        _mut().processUserSideDayRaw(alice, 2, ids, 1e18, 0); // settling context: refused
    }

    /// @dev A2-iii — an entry BEHIND its side's front reads `capHit` whatever
    ///      its own day's coverage: the walk settles a side's days in order,
    ///      and a read that cannot price the day ahead must not say the claim
    ///      would pay this one now. The front reads its figure.
    function test_AnEntryBehindItsSidesFront_ReadsNotExecutable() public {
        uint256 front = _scene(NEED);
        _armedDay(2, NEED);
        _loanSideOpen(2);
        uint256 behind = _entry(2, 3);
        _ready();
        _liveOf(1e18, _one(1), 999, keccak256("live")); // live covers either day on its own
        (uint256 needF, ) = _mut().dayNeedsRaw(alice, LibVaipakam.RewardSide.Lender, 1);
        assertGt(needF, 0, "fixture: the front's day prices");
        (uint256 armedF, bool capF) = _entryRead(front);
        assertFalse(capF, "the front of its side: covered, executable");
        assertEq(armedF, needF, "priced exactly as the day primitive prices it");
        (uint256 armedB, bool capB) = _entryRead(behind);
        assertTrue(capB, "behind the front: not this call's day, whatever its coverage");
        assertEq(armedB, 0, "no figure is read for it");
        assertTrue(_mut().entryExecutableNowRaw(front));
        assertFalse(_mut().entryExecutableNowRaw(behind), "and the clock waits on it");
    }

    /// @dev A2-iii — the lender side walks first: a borrower entry reads
    ///      `capHit` while any lender day pends, whatever its coverage; the
    ///      user-level read counts both sides' first days, and meets the
    ///      claim exactly when nothing is deferred.
    function test_ABorrowerEntry_WaitsWhileALenderDayPends() public {
        uint256 lender = _scene(NEED);
        _twoSidedDay(1);
        uint256 borrower = _borrowerEntry(1, 2);
        _ready();
        _liveOf(1e18, _one(1), 999, keccak256("live"));
        (, bool capB) = _entryRead(borrower);
        assertTrue(capB, "a borrower entry waits while a lender day pends");
        assertFalse(_mut().entryExecutableNowRaw(borrower));
        (, bool capL) = _entryRead(lender);
        assertFalse(capL, "the lender day is this call's");
        (uint256 needL, ) = _mut().dayNeedsRaw(alice, LibVaipakam.RewardSide.Lender, 1);
        (uint256 needB, ) = _mut().dayNeedsRaw(alice, LibVaipakam.RewardSide.Borrower, 1);
        assertGt(needB, 0, "fixture: the borrower day prices");
        (uint256 armed, bool cap, uint256 userPaid) = _userRead();
        assertFalse(cap);
        assertEq(armed, needL + needB, "both sides' first days, lender first");
        (uint256 paid, , ) = previewByExecution(alice);
        assertEq(userPaid, paid, "the lower bound meets the claim when nothing is deferred");
    }

    /// @dev A2-iii — the epoch at a day's cursor is ONE source for both
    ///      sides: the lender day's draw of it is not there for a borrower
    ///      day on the same day. Read twice, counted once — the bound stays
    ///      under the claim.
    function test_ASharedDaysCursorEpoch_IsCountedOnce_AcrossTheSides() public {
        _scene(NEED); // no live
        _twoSidedDay(1);
        _borrowerEntry(1, 2);
        _ready();
        (uint256 needL, ) = _mut().dayNeedsRaw(alice, LibVaipakam.RewardSide.Lender, 1);
        (uint256 needB, ) = _mut().dayNeedsRaw(alice, LibVaipakam.RewardSide.Borrower, 1);
        assertGt(needB, 0);
        _epochOf(needL, _one(1), 5, keccak256("one-side-worth")); // covers the lender day exactly, nothing else
        (uint256 armed, bool cap, uint256 userPaid) = _userRead();
        assertEq(armed, needL, "the lender day, epoch-covered; the borrower day finds the epoch spent");
        assertTrue(cap, "so the borrower day is not covered");
        (uint256 paid, , ) = previewByExecution(alice);
        assertEq(userPaid, paid, "and the bound meets what the claim pays");
    }

    /// @dev A2-iii — the read stops where the walk stops, and only there: a
    ///      lender day the live sources cannot pay ends its SIDE, and the
    ///      borrower side is still read (the walk goes on to it); a day the
    ///      epochs cap-hit ends the CLAIM, and nothing after it is counted.
    function test_TheUserRead_StopsOnlyWhereTheClaimWouldStop() public {
        _scene(NEED); // lender day 1, no live, no epoch
        _twoSidedDay(2);
        _loanSideOpen(2);
        _borrowerEntry(2, 3);
        _ready();
        (uint256 needB, ) = _mut().dayNeedsRaw(alice, LibVaipakam.RewardSide.Borrower, 2);
        assertGt(needB, 0);
        _epochOf(needB, _one(2), 5, keccak256("borrower-day-only"));
        (uint256 armed, bool cap, uint256 userPaid) = _userRead();
        assertTrue(cap, "the lender day has no coverage: its side ends");
        assertEq(armed, needB, "the borrower day is still read, as the walk still pays it");
        (uint256 paid, , ) = previewByExecution(alice);
        assertEq(userPaid, paid, "the bound meets the claim");
    }

    /// @dev A2-iii — an unattested epoch at the cursor is withheld from the
    ///      static read exactly as from the draw: no coverage until its split
    ///      is attested, then coverage.
    function test_AnUnattestedEpochAtTheCursor_IsNoCoverage_UntilAttested() public {
        uint256 id = _scene(NEED);
        (uint256 needL, ) = _mut().dayNeedsRaw(alice, LibVaipakam.RewardSide.Lender, 1);
        _epochRaw(needL, _one(1), 5, keccak256("unattested"));
        (uint256 armed, bool cap, ) = _userRead();
        assertTrue(cap, "withheld for want of the attestation: no coverage");
        assertEq(armed, 0);
        assertFalse(_mut().entryExecutableNowRaw(id));
        _attest(5, 1, 0); // all fresh
        (armed, cap, ) = _userRead();
        assertFalse(cap, "attested: the epoch at the cursor is coverage");
        assertEq(armed, needL);
        assertTrue(_mut().entryExecutableNowRaw(id));
    }

    // ───── #1499 acceptance: the predicate AND the claim, both sides ─────

    /// @dev #1499 — refusal cause: an UNATTESTED epoch at the cursor is no
    ///      coverage (the walk defers the day awaiting its split). Variable:
    ///      the attestation. Unattested: the predicate reads false AND the
    ///      claim refuses `NoInteractionRewardsToClaim`, taking nothing.
    ///      Attested: predicate true AND the claim pays the day from the epoch.
    ///      The cell above pins the predicate alone; this one adds the claim on
    ///      both sides. The read reports the withheld day as `capHit`, so
    ///      dropping the predicate's `capHit` refusal reads the unattested side
    ///      executable while the claim refuses, and fails this cell.
    function test_1499_AnUnattestedEpoch_PredicateAndClaimAgree_BothSides() public {
        uint256 id = _scene(NEED);
        (uint256 needL, ) = _mut().dayNeedsRaw(alice, LibVaipakam.RewardSide.Lender, 1);
        bytes32 h = _epochRaw(needL, _one(1), 5, keccak256("unattested-1499"));

        assertFalse(_mut().entryExecutableNowRaw(id), "unattested: non-executable");
        vm.expectRevert(IVaipakamErrors.NoInteractionRewardsToClaim.selector);
        _claim();
        assertEq(_balance(h), needL, "the refused claim took nothing");

        _attest(5, 1, 0); // all fresh
        assertTrue(_mut().entryExecutableNowRaw(id), "attested: executable");
        assertEq(_claim(), needL, "attested: the claim pays the day from the epoch");
        assertEq(_balance(h), 0, "drawn exactly");
    }

    /// @dev #1499 cell 6 — the RECYCLED custody row, straddled at the exact
    ///      wei on BOTH readers, on an ACTIVATED deployment. A day of mixed
    ///      composition; the live fresh row and the delivered ledger cover the
    ///      fresh leg amply, so the recycled draw is the only gate that can
    ///      bind. Variable: the bucket — which on activated custody IS the
    ///      holder's recycled row (`setRecycleBucketRaw` relocates the
    ///      difference), so the predicate's two recycled tests (the drought
    ///      against `bucketAvailable` and the transfer test against the row)
    ///      move together.
    ///
    ///      Row = draw − 1: the predicate reads false and the claim, whose walk
    ///      defers the recycled-short day whole, refuses. Row = draw: the
    ///      predicate reads true and the claim pays the day.
    ///
    ///      Which refusal fires on the short side is pinned too: the armed-need
    ///      view reports a recycled-short day as `capHit` with a zero draw, so
    ///      the predicate's `capHit` test refuses it; the drought comparison
    ///      and the row test then see a zero draw. Kills: dropping the `capHit`
    ///      refusal (short side reads true while the claim refuses);
    ///      `>` → `>=` in the drought comparison, or `>=` → `>` in the row test
    ///      (the met side reads false while the claim pays). Dropping the
    ///      drought comparison or the row test alone is NOT killed — on
    ///      activated custody the row IS the bucket, and the short side is
    ///      refused upstream by `capHit`.
    function test_1499_TheRecycledRow_StraddlesTheDraw_PredicateAndClaimAgree() public {
        _armedDay(1, NEED); // day 1 finalized, so the cumulative reaches day 2
        _mut().setDayPoolStampRaw(2, uint128(1e18), uint128(1e18));
        _mut().setKnownGlobalDailyInterest(2, 1e18, 0, true);
        _mut().setDayCapThreshold18(2, type(uint256).max);
        _mut().setDayCapModeRaw(2, 1);
        _mut().setDayUserSideCapRaw(2, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(1);
        uint256 id = _entry(2, 3);
        _ready();
        _liveOf(2e18, _one(2), 999, keccak256("live-1499-6"));
        // Read the draw with the bucket able to fund it: the armed-need view
        // reports the draw of a day the walk would SETTLE.
        _mut().setRecycleBucketRaw(2 * NEED);
        (, , , , uint256 draw, bool capAmple, , ) = _epochView().getRewardEntryArmedNeed(id);
        assertFalse(capAmple, "fixture: ample bucket, the day is the claim's");
        assertGt(draw, 1, "fixture: the walk draws on the recycled row");

        _mut().setRecycleBucketRaw(draw - 1);
        assertEq(_row(LibVaipakam.RewardCustodyRow.Recycled), draw - 1, "fixture: the row follows the bucket");
        // OBSERVED: one wei short, the view reports the deferral as `capHit`
        // with a ZERO draw rather than a draw exceeding the bucket — so it is
        // the predicate's `capHit` refusal, not the drought comparison, that
        // refuses this side (see the kill list in the natspec).
        (, , , , uint256 drawShort, bool capShort, , ) = _epochView().getRewardEntryArmedNeed(id);
        assertTrue(capShort, "short: the read reports the walk's deferral");
        assertEq(drawShort, 0, "short: and no draw figure for the deferred day");
        assertFalse(_mut().entryExecutableNowRaw(id), "row one wei short of the draw: non-executable");
        vm.expectRevert(IVaipakamErrors.NoInteractionRewardsToClaim.selector);
        _claim();

        _mut().setRecycleBucketRaw(draw);
        assertEq(_row(LibVaipakam.RewardCustodyRow.Recycled), draw, "fixture: the row follows the bucket");
        assertTrue(_mut().entryExecutableNowRaw(id), "row exactly the draw: executable");
        uint256 paid = _claim();
        assertGt(paid, draw, "row exactly the draw: the claim pays the day, fresh and recycled");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Recycled), 0, "and draws the row exactly empty");
    }

    /// @dev #1499 owner decision 2026-10-18 — THE DELIBERATE CONSERVATIVE
    ///      EXCEPTION, tested rather than only documented. An entry BEHIND its
    ///      side's front reads non-executable (the static read cannot price
    ///      the day ahead of the front, so it does not say the claim would pay
    ///      this one now), yet its owner's claim SUCCEEDS: it pays the front's
    ///      day and then this one, in the same call.
    ///
    ///      So here the predicate is STRICTER than the claim, and that is the
    ///      permitted direction: a stricter predicate only pauses the clock —
    ///      it delays a reap, it never expires an entry its owner could not
    ///      claim. A LOOSER one is the #1499 failure mode. This cell pins both
    ///      halves of that asymmetry on one fixture, and pins exactly what the
    ///      claim paid, so the exception cannot silently widen into a claim
    ///      that pays something the predicate never priced.
    function test_1499_BehindTheFront_PredicateStricterThanTheClaim_TheDeliberateException() public {
        uint256 front = _scene(NEED);
        _armedDay(2, NEED);
        _loanSideOpen(2);
        uint256 behind = _entry(2, 3);
        _ready();
        _liveOf(1e18, _one(1), 999, keccak256("live-1499-8")); // covers both days on its own
        (uint256 need1, ) = _mut().dayNeedsRaw(alice, LibVaipakam.RewardSide.Lender, 1);
        assertGt(need1, 0, "fixture: the front's day prices");

        assertTrue(_mut().entryExecutableNowRaw(front), "the front: executable");
        assertFalse(_mut().entryExecutableNowRaw(behind), "behind the front: the predicate waits");

        uint256 paid = _claim();
        assertEq(paid, 2 * NEED, "yet the claim pays the front's day AND the behind entry's day");
        assertEq(paid, need1 + NEED, "the front's priced need, then the behind day at its cap");
        LibVaipakam.RewardEntry[] memory es = InteractionRewardsLensFacet(address(diamond)).getRewardEntriesRange(front, 2);
        assertTrue(es[0].processed, "the front settled");
        assertTrue(es[1].processed, "and the behind entry settled in the same call");
    }

    /// @dev #1499 — the same exception on the side axis: a BORROWER entry
    ///      reads non-executable while a lender day pends (the lender side
    ///      walks first), yet the claim pays both sides' days. Stricter, never
    ///      looser; the claim's payout is pinned to the two sides' priced needs.
    function test_1499_ABorrowerBehindALenderDay_PredicateStricterThanTheClaim() public {
        uint256 lender = _scene(NEED);
        _twoSidedDay(1);
        uint256 borrower = _borrowerEntry(1, 2);
        _ready();
        _liveOf(1e18, _one(1), 999, keccak256("live-1499-8b"));
        (uint256 needL, ) = _mut().dayNeedsRaw(alice, LibVaipakam.RewardSide.Lender, 1);
        (uint256 needB, ) = _mut().dayNeedsRaw(alice, LibVaipakam.RewardSide.Borrower, 1);
        assertGt(needB, 0, "fixture: the borrower day prices");

        assertTrue(_mut().entryExecutableNowRaw(lender), "the lender entry: executable");
        assertFalse(_mut().entryExecutableNowRaw(borrower), "the borrower entry: the predicate waits");
        assertEq(_claim(), needL + needB, "yet the claim pays the lender day and then the borrower day");
        LibVaipakam.RewardEntry[] memory es = InteractionRewardsLensFacet(address(diamond)).getRewardEntriesRange(lender, 2);
        assertTrue(es[0].processed && es[1].processed, "both settled in the one call");
    }

    /// @dev #1499 cell 2, with an EPOCH-PAID LEG present — does the pool cap
    ///      applied first make the predicate STRICTER than the claim? The
    ///      armed day needs 0.4; an attested epoch pays 0.1 of it; the pool
    ///      has P = 0.2 left, so the walk budgets the day to 0.2 and the live
    ///      delivery must fund only the residual 0.1 (`liveArmed`, net of the
    ///      epoch). The predicate caps `liveArmed + legacyFresh` at the pool
    ///      and compares it to the bound; the claim charges the delivered
    ///      ledger only for the live-paid fresh. Variable: the delivered
    ///      ledger, 0.1 − 1 vs 0.1.
    ///
    ///      FINDING: they agree to the wei — not stricter. One wei short, the
    ///      predicate reads false and the claim's walk defers the armed day
    ///      on the bound (`NoInteractionRewardsToClaim`); exactly met, the
    ///      predicate reads true and the claim pays the full pool-capped 0.2
    ///      (0.1 from the epoch, 0.1 live).
    ///
    ///      On an ARMED day the walk itself defers on the bound, and the read
    ///      reports that as `capHit` — so the short side is refused by the
    ///      predicate's `capHit` test (dropping it fails this cell) ahead of
    ///      the aggregate bound comparison. The met side is the
    ///      stricter-than-the-claim detector: a predicate comparing the GROSS
    ///      armed figure (`armed`, epoch share included) instead of
    ///      `liveArmed` reads false at 0.1 while the claim pays.
    function test_1499_PoolCappedBound_WithAnEpochLeg_PredicateExactlyAsStrictAsTheClaim() public {
        uint256 id = _scene(NEED);
        bytes32 h = _epochOf(0.1e18, _one(1), 5, keccak256("part-1499"));
        _liveOf(1e18, _one(1), 999, keccak256("live-1499-2b")); // the live ROW amply funded
        uint256 p = 0.2e18;
        _mut().setInteractionPoolPaidOut(LibVaipakam.VPFI_INTERACTION_POOL_CAP - p);
        (uint256 armed, , , uint256 legacyFresh, , bool capHit, uint256 liveArmed, ) =
            _epochView().getRewardEntryArmedNeed(id);
        assertEq(armed, p, "fixture: the walk budgets the day to the pool headroom");
        assertEq(liveArmed, 0.1e18, "fixture: the live residual is net of the epoch's leg");
        assertEq(legacyFresh, 0, "fixture: no legacy fresh");
        assertFalse(capHit, "fixture: the epoch covers its share");

        _mut().setArmedFreshLedgerRaw(0.1e18 - 1, 0);
        assertFalse(_mut().entryExecutableNowRaw(id), "one wei short of the live residual: non-executable");
        vm.expectRevert(IVaipakamErrors.NoInteractionRewardsToClaim.selector);
        _claim();

        _mut().setArmedFreshLedgerRaw(0.1e18, 0);
        assertTrue(_mut().entryExecutableNowRaw(id), "the live residual exactly: executable");
        assertEq(_claim(), p, "and the claim pays the pool-capped day");
        (uint256 lf, ) = _legs(h);
        assertEq(lf, 0.1e18, "0.1 of it from the epoch");
        assertEq(_mut().getArmedFreshPaidRaw(), 0.1e18, "and the live 0.1 charged the delivered ledger exactly");
    }
}
