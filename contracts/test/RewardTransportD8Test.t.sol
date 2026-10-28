// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {Vm} from "forge-std/Vm.sol";
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
import {LibRewardRemitDispatch} from "../src/libraries/LibRewardRemitDispatch.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {LibD8Delivery} from "./helpers/LibD8Delivery.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/// @title RewardTransportD8Test — #2828, the d8 wire's RECEIVE side on an
///        activated custody.
/// @notice A delivery names its one funded day inline, so the mirror does
///         everything that day needs at arrival: the delivery is held whole as
///         its own attested epoch, credits no shared ledger, is indexed under
///         its day in the same call, and counts its part toward the day's
///         delivery gate. An armed-day claim draws it transport-first; its
///         remainder parks in one call once its day is closed. The fixture is
///         the draw suite's (mirror, activated custody, day 1 armed).
contract RewardTransportD8Test is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    address internal alice;
    MockRewardMessenger internal closeMessenger;
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    address internal constant REMITTER = address(0xBA5E);
    uint256 internal constant SEED = 1_000_000 ether;
    uint64 internal constant LOAN = 77;
    uint256 internal constant NEED = 0.4e18;

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
        alice = makeAddr("d8-alice");
    }

    // ─── accessors ───
    event CustodyEraAheadFiledLive(bytes32 indexed packetHash, uint64 intended, uint64 live);

    function _epoch() internal view returns (RewardEpochFacet) { return RewardEpochFacet(address(diamond)); }
    function _ingress() internal view returns (RewardIngressFacet) { return RewardIngressFacet(address(diamond)); }
    function _mut() internal view returns (TestMutatorFacet) { return TestMutatorFacet(address(diamond)); }
    function _custody() internal view returns (RewardCustodyFacet) { return RewardCustodyFacet(address(diamond)); }
    function _rlens() internal view returns (RewardRemittanceLensFacet) { return RewardRemittanceLensFacet(address(diamond)); }
    function _clo() internal view returns (RewardClosureFacet) { return RewardClosureFacet(address(diamond)); }
    function _row(LibVaipakam.RewardCustodyRow r) internal view returns (uint256) { return _custody().rewardCustodyRow(r); }
    function _legs(bytes32 h) internal view returns (uint256 f, uint256 r) { (f, r) = _epoch().getTransportBatchLegs(h); }
    function _balance(bytes32 h) internal view returns (uint256 b) { (, b, , , ) = _epoch().getTransportBatch(h); }
    function _batchDay(bytes32 h) internal view returns (uint256 d) { (, , , d, ) = _epoch().getTransportBatch(h); }
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

    // ─── the d8 fixture ───

    /// @dev Deliver `amount` for `day` on the d8 wire as the registered
    ///      receiver would: the day inline, the split, the era.
    function _d8(uint256 amount, uint256 day, uint256 remitId, bytes32 id, uint256 recycled, uint64 era)
        internal
        returns (bytes32 h)
    {
        // The day's one part: the delivery is its whole (LibD8Delivery.wholeDay).
        h = LibD8Delivery.deliver(address(diamond), _delivery(amount, day, remitId, id, recycled, era));
    }

    function _delivery(uint256 amount, uint256 day, uint256 remitId, bytes32 id, uint256 recycled, uint64 era)
        internal
        view
        returns (LibD8Delivery.Delivery memory)
    {
        return LibD8Delivery.Delivery({
            token: address(vpfi),
            amount: amount,
            dayId: day,
            sourceChainId: CHAIN_BASE,
            remitId: remitId,
            remitter: REMITTER,
            recycled: recycled,
            fresh: amount - recycled,
            messageId: id,
            era: era
        });
    }

    function _hashOf(bytes32 id) internal pure returns (bytes32) {
        return keccak256(abi.encode(uint256(CHAIN_BASE), id));
    }

    /// @dev The derivation rule REWARD_BUDGET_DEST_GAS_LIMIT is held to: the
    ///      receiver's reserve plus a QUARTER's margin, which is what absorbs
    ///      the transport's receive overhead and the two 63/64 forwarding hops.
    function _assertFitsTheBudget(uint256 used, string memory what) internal pure {
        assertLe(
            (used + LibRewardRemitDispatch.REWARD_BUDGET_RECEIVER_RESERVE) * 5 / 4,
            LibRewardRemitDispatch.REWARD_BUDGET_DEST_GAS_LIMIT,
            what
        );
    }

    /// @dev #1566 PR 1 review (P2-5), re-measured for #2828 — the d8 ingress,
    ///      which every ordinary remittance to an activated mirror takes, fits
    ///      the destination budget the send declares with the receiver's own
    ///      work reserved. Measured COLD (the first ingress of the test: the
    ///      packet, its epoch, its day stamp, the day's index and delivery
    ///      record, the era count and the shared custody slots all first
    ///      writes), both legs typed. Since #2828 the ingress also indexes the
    ///      epoch under its day and counts its part toward the day, which used
    ///      to be a separate permissionless call each.
    function test_TheD8Ingress_FitsTheDestinationBudget() public {
        LibD8Delivery.Delivery memory d = _delivery(10e18, 1, 91, keccak256("gas-d8"), 4e18, 0);
        LibD8Delivery.deliver(address(diamond), d);
        // The Diamond call alone, not a gasleft() window around the helper:
        // the window would also count the helper building the calldata in the
        // test's own frame, which no chain executes.
        uint256 used = vm.lastCallGas().gasTotalUsed;
        emit log_named_uint("d8 ingress gas (cold, first part of its day)", used);
        LibVaipakam.IngressPacket memory p = _rlens().getIngressPacket(_hashOf(keccak256("gas-d8")));
        assertTrue(p.attested, "fixture-live: the full path ran (the epoch attested from the wire)");
        assertEq(_rlens().getDayDeliveryParts(1).parts, 1, "fixture-live: the part was counted");
        _assertFitsTheBudget(used, "the d8 ingress has eaten the destination budget's margin: re-derive it");
    }

    /// @dev The same budget for a LATER part of a day that already holds an
    ///      epoch, landing in a later second: linked at the tail, its part
    ///      summed into the existing record.
    function test_TheD8Ingress_ALaterPartOfItsDay_FitsTheDestinationBudget() public {
        LibD8Delivery.Delivery memory d = _delivery(10e18, 1, 92, keccak256("gas-part-1"), 4e18, 0);
        LibD8Delivery.Part memory part = LibD8Delivery.Part({
            declaredTotal: 10e18,
            declaredRecycled: 4e18,
            wholeFresh: 12e18,
            wholeRecycled: 8e18
        });
        LibD8Delivery.deliverPart(address(diamond), d, part);
        vm.warp(block.timestamp + 1);
        d.remitId = 93;
        d.messageId = keccak256("gas-part-2");
        LibD8Delivery.deliverPart(address(diamond), d, part);
        uint256 used = vm.lastCallGas().gasTotalUsed;
        emit log_named_uint("d8 ingress gas (a later part of its day)", used);
        assertEq(_rlens().getDayDeliveryParts(1).parts, 2, "fixture-live: both parts counted");
        assertGt(_rlens().getDayDeliveryParts(1).landedAt, 0, "and the day landed on the second");
        _assertFitsTheBudget(used, "a later part has eaten the destination budget's margin: re-derive it");
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
    function test_AD8Delivery_ForTheLiveEra_IsStampedWithIt() public {
        _scene(NEED);
        bytes32 h = _d8(NEED, 1, 31, keccak256("c3-live"), 0, 0);
        LibVaipakam.IngressPacket memory p = _rlens().getIngressPacket(h);
        assertEq(p.custodyEra, 0, "the live era's");
        assertEq(_claim(), NEED, "the claim draws the whole delivery");
        assertEq(_rlens().getIngressPacket(h).unclassified, 0, "nothing left unclassified");
    }

    /// @dev Security review F1 — a stamp AHEAD of this chain's era means this
    ///      Diamond replaced the one that reported: the delivery files into the
    ///      LIVE era (never stranded in the transport) and says so; the wire's
    ///      word stays on the packet. Straddle: a stamp AT the live era files
    ///      there with no such event.
    function test_AD8Delivery_StampedAheadOfThisChain_FilesIntoTheLiveEra() public {
        _transitionTwice();
        bytes32 id = keccak256("c3-ahead");
        bytes32 hAhead = _hashOf(id);
        vm.expectEmit(true, false, false, true, address(diamond));
        emit CustodyEraAheadFiledLive(hAhead, 5, 2);
        bytes32 h = _d8(10e18, 1, 32, id, 2e18, 5);
        assertEq(h, hAhead, "fixture: the packet hash");
        LibVaipakam.IngressPacket memory p = _rlens().getIngressPacket(h);
        assertEq(p.custodyEra, 2, "filed into the live era");
        assertEq(p.intendedEra, 5, "the wire's word is kept");
        (bytes32 packetHash, , , , ) = _epoch().getTransportBatch(h);
        assertEq(packetHash, h, "and it opened its epoch, as any delivery does");

        vm.recordLogs();
        bytes32 hLive = _d8(10e18, 1, 33, keccak256("c3-at"), 2e18, 2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != CustodyEraAheadFiledLive.selector, "a stamp at the live era is not ahead");
        }
        assertEq(_rlens().getIngressPacket(hLive).custodyEra, 2, "filed into the live era");
    }

    /// @dev #1566 PR C revision — a delivery dispatched for an era this chain has
    ///      retired belongs to THAT era and is not held inert: it opens its epoch,
    ///      attested from the wire's split — the era's separately backed, consumable
    ///      home its day draws from — and nothing reaches the live baseline.
    function test_AD8Delivery_ForARetiredEra_OpensItsEpoch_InThatEra() public {
        _transitionTwice();
        uint256 liveBefore = _row(LibVaipakam.RewardCustodyRow.LiveFresh);
        uint256 unclBefore = _row(LibVaipakam.RewardCustodyRow.Unclassified);
        bytes32 h = _d8(10e18, 1, 33, keccak256("c3-behind"), 2e18, 1);
        (bytes32 packetHash, uint256 balance, , , ) = _epoch().getTransportBatch(h);
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

    // ─── cells ───

    /// @dev The one accounting path, and everything the day needs, in the one
    ///      call: the whole delivery is its own epoch, typed by the wire's
    ///      split, attested by the wire, in no shared ledger; the packet and
    ///      the epoch both name the day; the epoch is already in the day's
    ///      index and drawable; and the part is counted toward the day.
    function test_AD8Delivery_OpensAnIndexedAttestedEpoch_AndCreditsNoLedger() public {
        uint256 liveBefore = _row(LibVaipakam.RewardCustodyRow.LiveFresh);
        uint256 unclBefore = _row(LibVaipakam.RewardCustodyRow.Unclassified);
        (uint256 countedBefore, uint256 uncountedBefore) = _rlens().getDeliveredFreshPosition();
        bytes32 h = _d8(10e18, 7, 11, keccak256("d8-a"), 3e18, 0);

        (bytes32 packetHash, uint256 balance, uint256 admitted, uint256 dayId, bool released) =
            _epoch().getTransportBatch(h);
        assertEq(packetHash, h, "an epoch was opened at ingress");
        assertEq(balance, 10e18, "holding the WHOLE delivery");
        assertEq(admitted, 10e18);
        assertEq(dayId, 7, "funding the one day the wire named");
        assertFalse(released);

        LibVaipakam.IngressPacket memory p = _rlens().getIngressPacket(h);
        assertTrue(p.attested, "attested by the wire");
        assertEq(p.freshAttested, 7e18, "the fresh cap is the wire's fresh");
        assertEq(p.recycledAttested, 3e18, "the recycled cap is the wire's recycled");
        assertEq(p.freshShare + p.recycledShare, 0, "nothing was credited to a shared ledger at ingress");
        assertEq(p.dayId, 7, "the packet names the day");
        assertTrue(p.dayNamed, "and says it does");
        assertEq(p.intendedEra, 0, "the era is stored: the one a sender stamps before the registry");
        assertEq(p.unclassified, 10e18, "the value sits under the packet");

        assertEq(_row(LibVaipakam.RewardCustodyRow.LiveFresh), liveBefore, "live-fresh untouched");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Unclassified) - unclBefore, 10e18, "the unclassified row holds it");
        (uint256 counted, uint256 uncounted) = _rlens().getDeliveredFreshPosition();
        assertEq(counted, countedBefore, "nothing counted into the delivered ledger");
        assertEq(uncounted - uncountedBefore, 10e18, "the whole delivery is uncounted, as an untyped one is");

        // Indexed at arrival: nothing for a caller to do before it can be drawn.
        (bytes32[] memory page, , uint256 total, ) = _epoch().getTransportDayBatches(7, 0, 4);
        assertEq(total, 1, "the day's index lists it");
        assertEq(page[0], h);
        assertEq(_gates(h), 0, "no gate holds it");
        (uint256 available, , uint256 withheld) = _epoch().getTransportCoverageForDay(7);
        assertEq(available, 10e18, "it covers its day at once");
        assertEq(withheld, 0);
        // And counted toward the day's delivery gate (#918).
        LibVaipakam.DayDeliveryParts memory dp = _rlens().getDayDeliveryParts(7);
        assertEq(dp.parts, 1, "the part was counted at arrival");
        assertEq(dp.firstPacket, h);
        assertGt(dp.landedAt, 0, "a whole-day part lands the day");
        assertGt(_rlens().getReceivedRemit(REMITTER, 11).receivedAt, 0, "the receipt is written");
    }

    /// @dev Day 0 is a real reward day: a delivery naming it is stamped,
    ///      indexed and counted like any other.
    function test_AD8Delivery_ForDayZero_IsADayLikeAnyOther() public {
        bytes32 h = _d8(1e18, 0, 12, keccak256("d8-zero"), 0, 0);
        LibVaipakam.IngressPacket memory p = _rlens().getIngressPacket(h);
        assertTrue(p.dayNamed, "the day is named");
        assertEq(p.dayId, 0);
        (, , uint256 total, ) = _epoch().getTransportDayBatches(0, 0, 4);
        assertEq(total, 1, "day 0's index lists it");
        assertEq(_rlens().getDayDeliveryParts(0).parts, 1, "and its part is counted");
    }

    /// @dev Deliveries of one day that land in the SAME second are ordered by
    ///      (arrival, batch id) — the walk back from the tail crosses only
    ///      those ties — and one landing a second later goes to the tail.
    function test_SameSecondParts_AreOrderedByBatchId_ALaterOneAtTheTail() public {
        bytes32 ha = _d8(1e18, 3, 41, keccak256("tie-a"), 0, 0);
        bytes32 hb = _d8(1e18, 3, 42, keccak256("tie-b"), 0, 0);
        bytes32 hc = _d8(1e18, 3, 43, keccak256("tie-c"), 0, 0);
        vm.warp(block.timestamp + 1);
        bytes32 hLater = _d8(1e18, 3, 44, keccak256("tie-later"), 0, 0);
        (bytes32[] memory page, uint64[] memory at, , ) = _epoch().getTransportDayBatches(3, 0, 8);
        assertEq(page.length, 4);
        bytes32[3] memory ties = [ha, hb, hc];
        // the three ties, ascending by id
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (ties[j] < ties[i]) (ties[i], ties[j]) = (ties[j], ties[i]);
            }
        }
        for (uint256 i; i < 3; ++i) assertEq(page[i], ties[i], "same-second ties sort by batch id");
        assertEq(page[3], hLater, "the later second goes to the tail");
        assertEq(at[0], at[2], "fixture: the ties share an arrival");
        assertGt(at[3], at[2]);
        assertEq(_rlens().getDayDeliveryParts(3).parts, 4, "every part counted");
    }

    /// @dev THE ONLY way the ingress-time link can refuse: more same-second
    ///      ties for one day than the walk cap, each landing ahead of all the
    ///      others. It refuses by name, and the same delivery landing a second
    ///      later — the transport's re-execution — links at the tail.
    function test_TheLinkWalk_RefusesPastTheCap_AndALaterSecondLinks() public {
        uint256 n = LibRewardCustody.TRANSPORT_INDEX_WALK_CAP + 2;
        bytes32[] memory ids = new bytes32[](n);
        bytes32[] memory hs = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = keccak256(abi.encode("walk", i));
            hs[i] = _hashOf(ids[i]);
        }
        // Descending by packet hash: each lands ahead of every earlier one.
        for (uint256 i = 1; i < n; ++i) {
            for (uint256 j = i; j > 0 && hs[j] > hs[j - 1]; --j) {
                (hs[j], hs[j - 1]) = (hs[j - 1], hs[j]);
                (ids[j], ids[j - 1]) = (ids[j - 1], ids[j]);
            }
        }
        for (uint256 i; i < n - 1; ++i) _d8(1e18, 5, 1000 + i, ids[i], 0, 0);
        uint256 last = n - 1;
        vm.expectRevert(abi.encodeWithSelector(TransportIndexWalkExceeded.selector, hs[last], 5));
        this.deliverExternal(1e18, 5, 1000 + last, ids[last]);
        assertEq(_rlens().getIngressPacket(hs[last]).arrivedAt, 0, "the refused delivery left no record");

        vm.warp(block.timestamp + 1);
        bytes32 h = _d8(1e18, 5, 1000 + last, ids[last], 0, 0);
        (, , uint256 total, ) = _epoch().getTransportDayBatches(5, 0, 0);
        assertEq(total, n, "every delivery is indexed");
        (bytes32[] memory tail, , ) = _epoch().getTransportDayBatchesFrom(5, h, 1);
        assertEq(tail[0], h, "the re-executed delivery is in the index");
        assertEq(_rlens().getDayDeliveryParts(5).parts, n, "and every part counted once");
    }

    /// @dev An external seam so `vm.expectRevert` sees the ingress revert.
    function deliverExternal(uint256 amount, uint256 day, uint256 remitId, bytes32 id) external {
        _d8(amount, day, remitId, id, 0, 0);
    }

    /// @dev The whole delivery becomes one epoch typed by two caps, so a split
    ///      that leaves a wei under neither is refused rather than stranded.
    function test_ASplitNotWhole_IsRefused() public {
        bytes32 h = _hashOf(keccak256("not-whole"));
        vm.expectRevert(abi.encodeWithSelector(TransportSplitNotWhole.selector, h, 6e18, 3e18, 10e18));
        _ingress().onRewardBudgetReceivedD8(
            address(vpfi), 10e18, 1, CHAIN_BASE, 22, REMITTER, 3e18, 6e18, keccak256("not-whole"), 0, 10e18, 3e18,
            10e18 - 3e18, 3e18
        );
    }

    /// @dev The claim draws the epoch first and charges no shared ledger —
    ///      the draw suite's armed-day cell, on a d8 delivery, with no step
    ///      between the delivery and the claim.
    function test_ArmedDayClaim_DrawsFromTheEpoch_NotTheDeliveredLedger() public {
        _scene(NEED);
        bytes32 h = _d8(10e18, 1, 16, keccak256("d8-e"), 0, 0);
        uint256 rowBefore = _row(LibVaipakam.RewardCustodyRow.Unclassified);
        uint256 aliceBefore = vpfi.balanceOf(alice);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit TransportDrawn(h, 1, NEED, 0);
        assertEq(_claim(), NEED, "paid in full from the epoch");

        assertEq(vpfi.balanceOf(alice) - aliceBefore, NEED, "delivered to the wallet");
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(lf, NEED, "the fresh leg is recorded on the epoch");
        assertEq(lr, 0);
        assertEq(_balance(h), 10e18 - NEED, "the epoch fell by the draw");
        assertEq(_mut().getArmedFreshPaidRaw(), 0, "the delivered ledger is NOT charged");
        assertEq(rowBefore - _row(LibVaipakam.RewardCustodyRow.Unclassified), NEED, "the unclassified row fell by the draw");
        assertEq(_rlens().getIngressPacket(h).unclassified, 10e18 - NEED, "and the packet's remainder with it");
    }

    /// @dev The park is ONE call gated on the batch's one day being closed.
    function test_TheEpoch_Parks_InOneCall_OnceItsDayIsClosed() public {
        bytes32 h = _d8(2e18, 1, 17, keccak256("d8-f"), 0, 0);
        vm.expectRevert(abi.encodeWithSelector(TransportDayNotClosed.selector, h, 1));
        _epoch().parkTransportBatchRemainder(h);
        _closeDayLocally(1);
        (, , bool closed) = _clo().startDayClosure(1);
        assertTrue(closed, "no obligation on day 1: closes at start");
        assertEq(_epoch().parkTransportBatchRemainder(h), 2e18, "the whole remainder, in one call");
        assertEq(_balance(h), 0, "moved out of the batch");
        (bool parked, uint256 amount, uint256 dayId, bool acknowledged, uint256 debited) =
            _epoch().getTransportRemainder(h);
        assertTrue(parked, "the remainder says it is parked");
        assertEq(amount, 2e18);
        assertEq(dayId, 1, "bound to the batch's day");
        assertFalse(acknowledged);
        assertEq(debited, 0);
        vm.expectRevert(abi.encodeWithSelector(TransportRemainderAlreadyParked.selector, h));
        _epoch().parkTransportBatchRemainder(h);
        bytes32 nobody = keccak256("no delivery");
        vm.expectRevert(abi.encodeWithSelector(TransportBatchUnknown.selector, nobody));
        _epoch().parkTransportBatchRemainder(nobody);
    }

    /// @dev Before anything is parked the remainder read states it, rather than
    ///      leaving a zero day to be read as an answer.
    function test_AnUnparkedRemainder_SaysSo() public {
        bytes32 h = _d8(2e18, 0, 18, keccak256("d8-g"), 0, 0);
        (bool parked, uint256 amount, uint256 dayId, , ) = _epoch().getTransportRemainder(h);
        assertFalse(parked, "nothing is parked");
        assertEq(amount, 0);
        assertEq(dayId, 0);
        assertEq(_batchDay(h), 0, "the batch itself funds day 0");
    }
}

/// @notice Before custody activation a d8 delivery takes the TYPED-LEDGER path
///         and opens no epoch: its tokens rest with the Diamond and the
///         activation assigns them. Its day is still stamped and its part
///         still counted toward the day.
contract RewardTransportD8PreActivationTest is SetupTest, IVaipakamErrors {
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

    function test_AD8Delivery_BeforeActivation_TakesTheTypedLedgerPath() public {
        RewardRemittanceLensFacet lens = RewardRemittanceLensFacet(address(diamond));
        (uint256 countedBefore, ) = lens.getDeliveredFreshPosition();
        RewardIngressFacet(address(diamond)).onRewardBudgetReceivedD8(
            address(vpfi), 10e18, 2, CHAIN_BASE, 99, REMITTER, 0, 10e18, keccak256("pre-act-d8"), 0, 10e18, 0, 10e18, 0
        );
        bytes32 h = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("pre-act-d8")));
        (bytes32 packetHash, uint256 balance, , uint256 dayId, ) = RewardEpochFacet(address(diamond)).getTransportBatch(h);
        assertEq(packetHash, bytes32(0), "no epoch before activation");
        assertEq(balance, 0);
        assertEq(dayId, 0);
        (uint256 counted, ) = lens.getDeliveredFreshPosition();
        assertEq(counted - countedBefore, 10e18, "the fresh component is counted on the typed ledger");
        LibVaipakam.IngressPacket memory p = lens.getIngressPacket(h);
        assertEq(p.freshShare, 10e18, "the packet records what the ingress credited");
        assertFalse(p.attested, "no epoch, so no caps were attested");
        assertTrue(p.dayNamed, "the day is still stamped");
        assertEq(p.dayId, 2);
        assertEq(p.intendedEra, 0, "and the era a sender stamps before the registry");
        assertGt(lens.getReceivedRemit(REMITTER, 99).receivedAt, 0, "the receipt is written");
        LibVaipakam.DayDeliveryParts memory dp = lens.getDayDeliveryParts(2);
        assertEq(dp.parts, 1, "the part counts toward its day on this path too");
        assertEq(dp.firstPacket, h);
        assertGt(dp.landedAt, 0, "and lands it");
        // Nothing brings it into the ledger later either: the budget ingress is the only entry that
        // opens an epoch, and only at the packet's own landing.
        assertEq(p.batchId, bytes32(0), "the packet holds no epoch, now or later");
    }
}
