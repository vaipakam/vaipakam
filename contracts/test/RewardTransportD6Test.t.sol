// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {RewardEpochFacet} from "../src/facets/RewardEpochFacet.sol";
import {RewardIngressFacet} from "../src/facets/RewardIngressFacet.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardClosureFacet} from "../src/facets/RewardClosureFacet.sol";
import {RewardEraFacet} from "../src/facets/RewardEraFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibRewardCustody} from "../src/libraries/LibRewardCustody.sol";
import {RemitWire} from "../src/crosschain/RemitWire.sol";
import {LibRewardRemitDispatch} from "../src/libraries/LibRewardRemitDispatch.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {MerkleFixture} from "./mocks/MerkleFixture.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/// @title RewardTransportD6Test — #1566 transport epochs 3d-1, the d6 wire's
///        RECEIVE side on an activated custody.
/// @notice A rooted delivery is held whole as its own attested epoch and credits
///         no shared ledger; its membership is indexed one proven chunk at a time
///         in any order; it is allocatable only when whole; an armed-day claim
///         draws it transport-first; its remainder parks from the kept list. The
///         fixture is the draw suite's (mirror, activated custody, day 1 armed).
contract RewardTransportD6Test is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    address internal alice;
    MockRewardMessenger internal closeMessenger;
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    address internal constant REMITTER = address(0xBA5E);
    uint256 internal constant SEED = 1_000_000 ether;
    uint64 internal constant LOAN = 77;
    uint256 internal constant NEED = 0.4e18;
    uint256 internal constant S = 16; // RemitWire.D6_CHUNK_DAYS

    event TransportDrawn(bytes32 indexed batchId, uint256 indexed dayId, uint256 fresh, uint256 recycled);

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
        vm.warp(block.timestamp + 60 days);
        uint256 have = vpfi.balanceOf(address(this));
        if (SEED > have) vpfi.mint(address(this), SEED - have);
        vpfi.transfer(address(diamond), SEED);
        vm.chainId(CHAIN_ARB);
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(false);
        RewardReporterFacet(address(diamond)).setBaseChainId(CHAIN_BASE);
        RewardRemittanceFacet(address(diamond)).setRewardRemittanceReceiver(address(this));
        activateRewardCustodyForTest(address(vpfi), 0);
        alice = makeAddr("d6-alice");
        assertEq(RemitWire.D6_CHUNK_DAYS, S, "fixture: the chunk size this suite assumes");
    }

    // ─── accessors ───
    function _epoch() internal view returns (RewardEpochFacet) { return RewardEpochFacet(address(diamond)); }
    function _ingress() internal view returns (RewardIngressFacet) { return RewardIngressFacet(address(diamond)); }
    function _mut() internal view returns (TestMutatorFacet) { return TestMutatorFacet(address(diamond)); }
    function _custody() internal view returns (RewardCustodyFacet) { return RewardCustodyFacet(address(diamond)); }
    function _rlens() internal view returns (RewardRemittanceLensFacet) { return RewardRemittanceLensFacet(address(diamond)); }
    function _clo() internal view returns (RewardClosureFacet) { return RewardClosureFacet(address(diamond)); }
    function _row(LibVaipakam.RewardCustodyRow r) internal view returns (uint256) { return _custody().rewardCustodyRow(r); }
    function _legs(bytes32 h) internal view returns (uint256 f, uint256 r) { (f, r) = _epoch().getTransportBatchLegs(h); }
    function _balance(bytes32 h) internal view returns (uint256 b) { (, b, , , , ) = _epoch().getTransportBatch(h); }
    function _indexed(bytes32 h) internal view returns (uint32 i) { (, , , , i, ) = _epoch().getTransportBatch(h); }
    function _gates(bytes32 h) internal view returns (uint8 g) { (g, ) = _epoch().getTransportBatchGates(h); }

    // ─── the scene the draw suite uses: day 1 armed, one lender entry, an empty live ledger ───
    function _armedDay(uint256 d, uint256 cap) internal {
        _mut().setDayPoolStampRaw(d, uint128(2e18), 0);
        _mut().setKnownGlobalDailyInterest(d, 1e18, 0, true);
        _mut().setDayCapThreshold18(d, type(uint256).max);
        _mut().setDayCapModeRaw(d, 1);
        _mut().setDayUserSideCapRaw(d, cap);
    }

    function _scene(uint256 cap) internal {
        _armedDay(1, cap);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _mut().setFeeEntitlementRaw(
            LOAN,
            LibVaipakam.FeeEntitlement({
                borrowerMode: LibVaipakam.FeeEntitlementMode.None,
                lenderMode: LibVaipakam.FeeEntitlementMode.None,
                openDays: 1,
                rewardHaircutBpsAtOpen: 0,
                borrowerTariffPaid: 0,
                lenderTariffPaid: 0,
                cStarOpen: 0,
                loanSideRewardCapOpen: type(uint128).max
            })
        );
        uint256 id = _mut().pushRewardEntry(alice, LOAN, LibVaipakam.RewardSide.Lender, 1e18, 1);
        _mut().closeRewardEntryRaw(id, 2);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
    }

    function _claim() internal returns (uint256 paid) {
        vm.prank(alice);
        (paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewards();
    }

    function _closeDayLocally(uint256 d) internal {
        if (address(closeMessenger) == address(0)) {
            closeMessenger = new MockRewardMessenger(address(diamond));
            RewardReporterFacet(address(diamond)).setRewardMessenger(address(closeMessenger));
        }
        RewardReporterFacet(address(diamond)).closeDay(d);
    }

    // ─── the d6 fixture ───
    function _days(uint256 n, uint256 from) internal pure returns (uint256[] memory d) {
        d = new uint256[](n);
        for (uint256 i; i < n; ++i) d[i] = from + i;
    }

    /// @dev Deliver `amount` on the d6 wire as the registered receiver would:
    ///      the root over the list's chunks, the extent, the split, the era.
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

    function _prove(bytes32 h, uint256[] memory dayIds, bytes32[] memory leaves, uint256 c) internal returns (uint32) {
        return _epoch().materializeTransportBatchChunk(
            h, c, MerkleFixture.chunk(dayIds, c, S), MerkleFixture.proof(leaves, c), new bytes32[](0), new bytes32[](0)
        );
    }

    function _d6Whole(uint256 amount, uint256[] memory dayIds, uint256 remitId, bytes32 id) internal returns (bytes32 h) {
        bytes32[] memory leaves;
        (h, leaves) = _d6(amount, dayIds, remitId, id, 0, 0);
        for (uint256 c; c < leaves.length; ++c) _prove(h, dayIds, leaves, c);
    }

    /// @dev #1566 PR 1 review (P2-5) — the ROOTED (d6) ingress, which every ordinary remittance to
    ///      an activated mirror takes, fits the destination budget the send declares with the
    ///      receiver's own work reserved — measured COLD (the first ingress of the test: the packet,
    ///      its epoch, the era count and the shared custody slots all first writes), over the widest
    ///      list one remittance funds, both legs typed. Under the old 300,000 it could never have
    ///      executed automatically.
    function test_TheRootedIngress_FitsTheDestinationBudget() public {
        uint256[] memory dayIds = _days(LibRewardCustody.TRANSPORT_DAY_FANOUT_CAP, 1);
        bytes32[] memory leaves = RemitWire.d6Chunks(dayIds);
        bytes32 root = RemitWire.d6Root(leaves);
        uint256 before = gasleft();
        _ingress().onRewardBudgetReceivedD6(
            address(vpfi), 10e18, root, dayIds.length, leaves.length,
            CHAIN_BASE, 91, REMITTER, 4e18, 6e18, keccak256("gas-d6"), 0
        );
        uint256 used = before - gasleft();
        emit log_named_uint("rooted ingress gas", used);
        LibVaipakam.IngressPacket memory p = _rlens().getIngressPacket(keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("gas-d6"))));
        assertTrue(p.attested, "fixture-live: the full path ran (the epoch attested from the wire)");
        assertLe(
            used + LibRewardRemitDispatch.REWARD_BUDGET_RECEIVER_RESERVE,
            LibRewardRemitDispatch.REWARD_BUDGET_DEST_GAS_LIMIT,
            "the rooted ingress overruns the destination budget"
        );
    }

    // ─── PR C-3: the intended era against the live one ───
    function _eraF() internal view returns (RewardEraFacet) { return RewardEraFacet(address(diamond)); }

    /// @dev Retire the live era and come back (two transitions): the chain is a
    ///      mirror again with era 2 live.
    function _transitionTwice() internal {
        RewardReporterFacet(address(diamond)).setBaseChainId(0);
        RewardReporterFacet(address(diamond)).setBaseChainId(CHAIN_BASE);
        assertEq(_eraF().getCustodyEraCurrent(), 2, "fixture: era 2 live");
    }

    /// @dev #1566 PR C revision — a delivery for the live era belongs to it: stamped
    ///      with it at arrival, and drawn whole by the obligation it funds.
    function test_AD6Delivery_ForTheLiveEra_IsStampedWithIt() public {
        _scene(NEED);
        bytes32 h = _d6Whole(NEED, _days(1, 1), 31, keccak256("c3-live"));
        LibVaipakam.IngressPacket memory p = _rlens().getIngressPacket(h);
        assertEq(p.custodyEra, 0, "the live era's");
        assertEq(_claim(), NEED, "the claim draws the whole delivery");
        assertEq(_rlens().getIngressPacket(h).unclassified, 0, "nothing left unclassified");
    }

    function test_AD6Delivery_ForAFutureEra_IsRefused() public {
        uint256[] memory one = _days(1, 1);
        bytes32[] memory leaves = RemitWire.d6Chunks(one);
        vm.expectRevert(abi.encodeWithSelector(CustodyEraAhead.selector, uint64(1), uint64(0)));
        _ingress().onRewardBudgetReceivedD6(
            address(vpfi), 1e18, RemitWire.d6Root(leaves), 1, 1, CHAIN_BASE, 32, REMITTER, 0, 1e18, keccak256("c3-ahead"), 1
        );
    }

    /// @dev #1566 PR C revision — a delivery dispatched for an era this chain has
    ///      retired belongs to THAT era and is not held inert: it opens its epoch,
    ///      attested from the wire's split — the era's separately backed, consumable
    ///      home its listed days draw from — and nothing reaches the live baseline.
    function test_AD6Delivery_ForARetiredEra_OpensItsEpoch_InThatEra() public {
        _transitionTwice();
        uint256 liveBefore = _row(LibVaipakam.RewardCustodyRow.LiveFresh);
        uint256 unclBefore = _row(LibVaipakam.RewardCustodyRow.Unclassified);
        (bytes32 h, ) = _d6(10e18, _days(3, 1), 33, keccak256("c3-behind"), 2e18, 1);
        (bytes32 packetHash, uint256 balance, , , , ) = _epoch().getTransportBatch(h);
        assertEq(packetHash, h, "its epoch is open");
        assertEq(balance, 10e18, "holding the whole delivery");
        LibVaipakam.IngressPacket memory p = _rlens().getIngressPacket(h);
        assertTrue(p.attested, "attested from the wire");
        assertEq(p.freshAttested, 8e18);
        assertEq(p.recycledAttested, 2e18);
        assertEq(p.freshShare + p.recycledShare, 0, "nothing credited to a shared ledger");
        assertEq(p.intendedEra, 1, "the wire's era is kept");
        assertEq(p.custodyEra, 1, "and the packet belongs to it");
        assertEq(_row(LibVaipakam.RewardCustodyRow.LiveFresh), liveBefore, "live-fresh untouched");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Unclassified) - unclBefore, 10e18, "under the epoch, unclassified");
        assertGt(_rlens().getReceivedRemit(REMITTER, 33).receivedAt, 0, "the receipt is written");
    }

    /// @dev An era-less list-bearing delivery carries no era, so it is placed by
    ///      the days it lists (#1566 PR C revision). One listing a day BEFORE the
    ///      live era's boundary belongs to the era of its earliest listed day: the
    ///      WHOLE delivery opens its epoch, typed from the wire's own split, and
    ///      nothing reaches the live ledgers.
    function test_AListBearingDelivery_ListingARetiredDay_OpensItsEpoch_InThatDaysEra() public {
        _transitionTwice();
        assertGt(_eraF().getCustodyEra(2).boundaryDay, 1, "fixture: day 1 predates the live era");
        uint256 liveBefore = _row(LibVaipakam.RewardCustodyRow.LiveFresh);
        uint256[] memory one = _days(1, 1);
        _ingress().onRewardBudgetReceived(address(vpfi), 4e18, one, CHAIN_BASE, 34, REMITTER, 0, 4e18, keccak256("c3-d5"), true);
        bytes32 h = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("c3-d5")));
        LibVaipakam.IngressPacket memory p = _rlens().getIngressPacket(h);
        assertEq(p.custodyEra, 0, "the era of its earliest listed day");
        assertEq(p.freshShare, 0, "recorded as credited to nothing");
        assertTrue(p.attested, "typed from the wire's own split");
        assertEq(p.freshAttested, 4e18);
        assertEq(p.unclassified, 4e18, "the whole delivery, under its epoch");
        assertEq(_row(LibVaipakam.RewardCustodyRow.LiveFresh), liveBefore, "the typed wire's live credit did not happen");
        (bytes32 packetHash, uint256 balance, , , , ) = _epoch().getTransportBatch(h);
        assertEq(packetHash, h, "its epoch is open");
        assertEq(balance, 4e18);
    }

    /// @dev The same wire listing only days from the live era's boundary on belongs
    ///      to the live era and is taken as before; one listing no day names no
    ///      retired obligation and is taken as before too.
    function test_AListBearingDelivery_ListingOnlyLiveDays_OrNoDay_IsTakenAsBefore() public {
        _transitionTwice();
        uint256 boundary = _eraF().getCustodyEra(2).boundaryDay;
        uint256 liveBefore = _row(LibVaipakam.RewardCustodyRow.LiveFresh);
        _ingress().onRewardBudgetReceived(
            address(vpfi), 4e18, _days(2, boundary), CHAIN_BASE, 35, REMITTER, 0, 4e18, keccak256("c3-d5-live"), true
        );
        LibVaipakam.IngressPacket memory p =
            _rlens().getIngressPacket(keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("c3-d5-live"))));
        assertEq(p.custodyEra, 2, "placed in the live era by its days");
        assertEq(p.freshShare, 4e18, "the typed split is recorded");
        assertEq(p.unclassified, 0, "nothing held");
        assertEq(_row(LibVaipakam.RewardCustodyRow.LiveFresh) - liveBefore, 4e18, "credited to the live row as before");
        uint256[] memory none;
        _ingress().onRewardBudgetReceived(
            address(vpfi), 1e18, none, CHAIN_BASE, 36, REMITTER, 0, 1e18, keccak256("c3-d5-undated"), true
        );
        p = _rlens().getIngressPacket(keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("c3-d5-undated"))));
        assertEq(p.custodyEra, 2, "undated value funds the live era");
        assertEq(_row(LibVaipakam.RewardCustodyRow.LiveFresh) - liveBefore, 5e18, "credited as before");
    }

    // ─── cells ───

    /// @dev The one accounting path: the whole delivery is its own epoch, typed by
    ///      the wire's split, attested by the wire, in no shared ledger; the
    ///      commitment, the extent and the era are on the packet.
    function test_AD6Delivery_OpensAnAttestedEpoch_AndCreditsNoLedger() public {
        uint256 liveBefore = _row(LibVaipakam.RewardCustodyRow.LiveFresh);
        uint256 unclBefore = _row(LibVaipakam.RewardCustodyRow.Unclassified);
        (uint256 countedBefore, uint256 uncountedBefore) = _rlens().getDeliveredFreshPosition();
        uint256[] memory list = _days(20, 1);
        (bytes32 h, bytes32[] memory leaves) = _d6(10e18, list, 11, keccak256("d6-a"), 3e18, 0);

        (bytes32 packetHash, uint256 balance, uint256 admitted, uint32 dayCount, uint32 indexedDays, bool released) =
            _epoch().getTransportBatch(h);
        assertEq(packetHash, h, "an epoch was opened at ingress");
        assertEq(balance, 10e18, "holding the WHOLE delivery");
        assertEq(admitted, 10e18);
        assertEq(dayCount, 20, "with the committed extent as its membership count");
        assertEq(indexedDays, 0, "and nothing indexed yet");
        assertFalse(released);

        LibVaipakam.IngressPacket memory p = _rlens().getIngressPacket(h);
        assertTrue(p.attested, "attested by the wire");
        assertEq(p.freshAttested, 7e18, "the fresh cap is the wire's fresh");
        assertEq(p.recycledAttested, 3e18, "the recycled cap is the wire's recycled");
        assertEq(p.freshShare + p.recycledShare, 0, "nothing was credited to a shared ledger at ingress");
        assertEq(p.dayListRoot, RemitWire.d6Root(leaves), "the root is stamped");
        assertEq(p.dayListHash, bytes32(0), "and no flat hash is");
        assertEq(p.dayCount, 20);
        assertEq(p.chunkCount, 2, "20 days in two chunks of 16");
        assertEq(p.chunksIndexed, 0);
        assertEq(p.intendedEra, 0, "the era is stored: the one a sender stamps before the registry");
        assertEq(p.unclassified, 10e18, "the value sits under the packet");

        assertEq(_row(LibVaipakam.RewardCustodyRow.LiveFresh), liveBefore, "live-fresh untouched");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Unclassified) - unclBefore, 10e18, "the unclassified row holds it");
        (uint256 counted, uint256 uncounted) = _rlens().getDeliveredFreshPosition();
        assertEq(counted, countedBefore, "nothing counted into the delivered ledger");
        assertEq(uncounted - uncountedBefore, 10e18, "the whole delivery is uncounted, as an untyped one is");
        // Beside the index, the kept list is still empty, so 3c-1's gate declines to read it (contested until
        // the index is whole: a list it cannot read is withheld, never admitted).
        assertEq(
            _gates(h), LibRewardCustody.GATE_UNINDEXED | LibRewardCustody.GATE_CONTESTED, "unindexed, and withheld until the list is whole"
        );
        assertGt(_rlens().getReceivedRemit(REMITTER, 11).receivedAt, 0, "the receipt is written");

        // A later Base attestation finds the wire's figures and holds them.
        RewardReporterFacet(address(diamond)).setRewardMessenger(address(this));
        vm.expectRevert(abi.encodeWithSelector(IngressPacketAlreadyAttested.selector, h));
        _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, 11, 1, 1);
    }

    /// @dev Chunks land in any order; each is checked against the root and its
    ///      committed length; the membership is whole exactly when every chunk
    ///      has landed, and both indexes carry every day.
    function test_Chunks_AreProven_InAnyOrder_AndCompleteTheIndex() public {
        uint256[] memory list = _days(20, 1);
        (bytes32 h, bytes32[] memory leaves) = _d6(10e18, list, 12, keccak256("d6-b"), 0, 0);
        assertEq(_prove(h, list, leaves, 1), 4, "the short last chunk first");
        assertEq(_rlens().getIngressPacket(h).chunksIndexed, 2, "bit 1 set");
        assertTrue((_gates(h) & LibRewardCustody.GATE_UNINDEXED) != 0, "not whole yet");
        assertEq(_prove(h, list, leaves, 0), 20, "then the full first chunk");
        assertEq(_rlens().getIngressPacket(h).chunksIndexed, 3, "both bits set");
        assertEq(_indexed(h), 20, "whole");
        assertTrue((_gates(h) & LibRewardCustody.GATE_UNINDEXED) == 0, "the index gate is down");
        assertTrue((_gates(h) & LibRewardCustody.GATE_NECESSITY) != 0, "its other days have not arrived: the necessity tier");
        assertEq(_epoch().getTransportBatchDays(h).length, 20, "the kept list is whole");
        for (uint256 d = 1; d <= 20; ++d) {
            (, , uint256 total, ) = _epoch().getTransportDayBatches(d, 0, 4);
            assertEq(total, 1, "every listed day indexes it");
        }
    }

    function test_AChunk_IsRefused_ByName() public {
        uint256[] memory list = _days(20, 1);
        (bytes32 h, bytes32[] memory leaves) = _d6(10e18, list, 13, keccak256("d6-c"), 0, 0);
        bytes32[] memory none = new bytes32[](0);

        // out of the extent
        vm.expectRevert(abi.encodeWithSelector(TransportChunkOutOfExtent.selector, h, 2, 2));
        _epoch().materializeTransportBatchChunk(h, 2, MerkleFixture.chunk(list, 1, S), MerkleFixture.proof(leaves, 1), none, none);
        // wrong length for the index
        vm.expectRevert(abi.encodeWithSelector(TransportChunkLengthMismatch.selector, h, 0, 16, 4));
        _epoch().materializeTransportBatchChunk(h, 0, MerkleFixture.chunk(list, 1, S), MerkleFixture.proof(leaves, 0), none, none);
        // right length, wrong days
        uint256[] memory forged = _days(16, 500);
        vm.expectRevert(
            abi.encodeWithSelector(TransportChunkProofInvalid.selector, h, 0, RemitWire.d6Leaf(0, forged))
        );
        _epoch().materializeTransportBatchChunk(h, 0, forged, MerkleFixture.proof(leaves, 0), none, none);
        // right days, the other chunk's proof
        vm.expectRevert(
            abi.encodeWithSelector(TransportChunkProofInvalid.selector, h, 0, RemitWire.d6Leaf(0, MerkleFixture.chunk(list, 0, S)))
        );
        _epoch().materializeTransportBatchChunk(h, 0, MerkleFixture.chunk(list, 0, S), MerkleFixture.proof(leaves, 1), none, none);
        // the flat-hash page is not this batch's route
        vm.expectRevert(abi.encodeWithSelector(TransportBatchRooted.selector, h));
        _epoch().materializeTransportBatchPage(h, list);
        // a chunk, once
        _prove(h, list, leaves, 0);
        vm.expectRevert(abi.encodeWithSelector(TransportChunkAlreadyIndexed.selector, h, 0));
        _prove(h, list, leaves, 0);
        // a hint list of the wrong width is refused before anything is read
        bytes32[] memory badHints = new bytes32[](3);
        vm.expectRevert(abi.encodeWithSelector(TransportDayListMismatch.selector, h, bytes32(0), bytes32(0)));
        _epoch().materializeTransportBatchChunk(h, 1, MerkleFixture.chunk(list, 1, S), MerkleFixture.proof(leaves, 1), badHints, none);

        // and the chunk route is not a flat-hash batch's
        uint256[] memory one = _days(1, 1);
        _ingress().onRewardBudgetReceived(address(vpfi), 1e18, one, CHAIN_BASE, 14, REMITTER, 0, 0, keccak256("flat"), false);
        bytes32 flat = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("flat")));
        vm.expectRevert(abi.encodeWithSelector(TransportBatchNotRooted.selector, flat));
        _epoch().materializeTransportBatchChunk(flat, 0, one, none, none, none);
    }

    /// @dev A wire whose extent is not the fixed-size chunking of its element
    ///      count, or that commits to nothing, is refused at ingress by name.
    function test_AMalformedExtent_IsRefused_ByName() public {
        bytes32 h = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("bad-extent")));
        vm.expectRevert(abi.encodeWithSelector(TransportRootExtentInvalid.selector, h, 20, 1));
        _ingress().onRewardBudgetReceivedD6(address(vpfi), 1e18, bytes32(uint256(1)), 20, 1, CHAIN_BASE, 21, REMITTER, 0, 1e18, keccak256("bad-extent"), 0);
        vm.expectRevert(abi.encodeWithSelector(TransportRootExtentInvalid.selector, h, 0, 0));
        _ingress().onRewardBudgetReceivedD6(address(vpfi), 1e18, bytes32(uint256(1)), 0, 0, CHAIN_BASE, 21, REMITTER, 0, 1e18, keccak256("bad-extent"), 0);
        vm.expectRevert(abi.encodeWithSelector(TransportRootExtentInvalid.selector, h, 20, 2));
        _ingress().onRewardBudgetReceivedD6(address(vpfi), 1e18, bytes32(0), 20, 2, CHAIN_BASE, 21, REMITTER, 0, 1e18, keccak256("bad-extent"), 0);
        uint256 tooMany = (RemitWire.D6_MAX_CHUNKS + 1) * S;
        vm.expectRevert(abi.encodeWithSelector(TransportRootExtentInvalid.selector, h, tooMany, RemitWire.D6_MAX_CHUNKS + 1));
        _ingress().onRewardBudgetReceivedD6(address(vpfi), 1e18, bytes32(uint256(1)), tooMany, RemitWire.D6_MAX_CHUNKS + 1, CHAIN_BASE, 21, REMITTER, 0, 1e18, keccak256("bad-extent"), 0);
    }

    /// @dev The whole delivery becomes one epoch typed by two caps, so a split
    ///      that leaves a wei under neither is refused rather than stranded.
    function test_ASplitNotWhole_IsRefused() public {
        bytes32 h = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("not-whole")));
        vm.expectRevert(abi.encodeWithSelector(TransportSplitNotWhole.selector, h, 6e18, 3e18, 10e18));
        _ingress().onRewardBudgetReceivedD6(address(vpfi), 10e18, bytes32(uint256(1)), 1, 1, CHAIN_BASE, 22, REMITTER, 3e18, 6e18, keccak256("not-whole"), 0);
    }

    /// @dev Spendable only when whole: the existing completeness rule, reached
    ///      through the chunk count rather than a new gate.
    function test_ARootedEpoch_IsAllocatable_OnlyWhenComplete() public {
        uint256[] memory one = _days(1, 1);
        (bytes32 h, bytes32[] memory leaves) = _d6(5e18, one, 15, keccak256("d6-d"), 0, 0);
        (uint256 available, , , ) = _epoch().getTransportCoverageForDay(1);
        assertEq(available, 0, "unindexed: nothing to draw");
        _prove(h, one, leaves, 0);
        (available, , , ) = _epoch().getTransportCoverageForDay(1);
        assertEq(available, 5e18, "whole: the epoch covers its day");
        assertEq(_gates(h), 0, "a one-day rooted epoch is ordinary once whole");
    }

    /// @dev The claim draws the rooted epoch first and charges no shared ledger —
    ///      the draw suite's armed-day cell, on a d6 delivery.
    function test_ArmedDayClaim_DrawsFromARootedEpoch_NotTheDeliveredLedger() public {
        _scene(NEED);
        bytes32 h = _d6Whole(10e18, _days(1, 1), 16, keccak256("d6-e"));
        uint256 rowBefore = _row(LibVaipakam.RewardCustodyRow.Unclassified);
        uint256 aliceBefore = vpfi.balanceOf(alice);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit TransportDrawn(h, 1, NEED, 0);
        assertEq(_claim(), NEED, "paid in full from the rooted epoch");

        assertEq(vpfi.balanceOf(alice) - aliceBefore, NEED, "delivered to the wallet");
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(lf, NEED, "the fresh leg is recorded on the epoch");
        assertEq(lr, 0);
        assertEq(_balance(h), 10e18 - NEED, "the epoch fell by the draw");
        assertEq(_mut().getArmedFreshPaidRaw(), 0, "the delivered ledger is NOT charged");
        assertEq(rowBefore - _row(LibVaipakam.RewardCustodyRow.Unclassified), NEED, "the unclassified row fell by the draw");
        assertEq(_rlens().getIngressPacket(h).unclassified, 10e18 - NEED, "and the packet's remainder with it");
    }

    /// @dev The park reads a rooted batch's KEPT list — no list is supplied, and
    ///      a supplied one is refused by name.
    function test_ARootedEpoch_Parks_FromItsKeptList() public {
        bytes32 h = _d6Whole(2e18, _days(1, 1), 17, keccak256("d6-f"));
        uint256[] memory none = new uint256[](0);
        vm.expectRevert(abi.encodeWithSelector(TransportDayNotClosed.selector, h, 1));
        _epoch().parkTransportBatchRemainder(h, none);
        _closeDayLocally(1);
        (, , bool closed) = _clo().startDayClosure(1);
        assertTrue(closed, "no obligation on day 1: closes at start");
        uint256[] memory supplied = _days(1, 1);
        vm.expectRevert(
            abi.encodeWithSelector(TransportDayListMismatch.selector, h, bytes32(0), keccak256(abi.encode(supplied)))
        );
        _epoch().parkTransportBatchRemainder(h, supplied);
        (uint32 checked, bool parked, uint256 amount) = _epoch().parkTransportBatchRemainder(h, none);
        assertEq(checked, 1);
        assertTrue(parked, "parked from the kept list");
        assertEq(amount, 2e18, "the whole remainder");
        assertEq(_balance(h), 0, "moved out of the batch");
    }
}

/// @notice Before custody activation a rooted delivery takes the TYPED-LEDGER
///         path exactly as a d5 one does and opens no epoch: its tokens rest
///         with the Diamond and the activation assigns them.
contract RewardTransportD6PreActivationTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    address internal constant REMITTER = address(0xBA5E);

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
        vpfi.mint(address(this), 1_000 ether);
        vpfi.transfer(address(diamond), 1_000 ether);
        vm.chainId(CHAIN_ARB);
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(false);
        RewardReporterFacet(address(diamond)).setBaseChainId(CHAIN_BASE);
        RewardRemittanceFacet(address(diamond)).setRewardRemittanceReceiver(address(this));
    }

    function test_AD6Delivery_BeforeActivation_TakesTheTypedLedgerPath() public {
        RewardRemittanceLensFacet lens = RewardRemittanceLensFacet(address(diamond));
        (uint256 countedBefore, ) = lens.getDeliveredFreshPosition();
        RewardIngressFacet(address(diamond)).onRewardBudgetReceivedD6(
            address(vpfi), 10e18, bytes32(uint256(0xC0DE)), 2, 1, CHAIN_BASE, 99, REMITTER, 0, 10e18, keccak256("pre-act-d6"), 0
        );
        bytes32 h = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("pre-act-d6")));
        (bytes32 packetHash, uint256 balance, , uint32 dayCount, , ) = RewardEpochFacet(address(diamond)).getTransportBatch(h);
        assertEq(packetHash, bytes32(0), "no epoch before activation");
        assertEq(balance, 0);
        assertEq(dayCount, 0);
        (uint256 counted, ) = lens.getDeliveredFreshPosition();
        assertEq(counted - countedBefore, 10e18, "the fresh component is counted, as a d5 delivery's is");
        LibVaipakam.IngressPacket memory p = lens.getIngressPacket(h);
        assertEq(p.freshShare, 10e18, "the packet records what the ingress credited");
        assertFalse(p.attested, "no epoch, so no caps were attested");
        assertEq(p.dayListRoot, bytes32(uint256(0xC0DE)), "the commitment is still stamped");
        assertEq(p.intendedEra, 0, "and the era a sender stamps before the registry");
        assertGt(lens.getReceivedRemit(REMITTER, 99).receivedAt, 0, "the receipt is written");
        // Nothing brings it into the ledger before activation: the rollout admission is gated on the
        // activation itself, ahead of any reading of the packet.
        uint256[] memory any = new uint256[](2);
        vm.expectRevert(RewardCustodyNotActivated.selector);
        RewardEpochFacet(address(diamond)).admitLegacyTransportBatch(h, any);
    }
}
