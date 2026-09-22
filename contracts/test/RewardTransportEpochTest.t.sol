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
import {LibRewardCustody} from "../src/libraries/LibRewardCustody.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibRewardRemitDispatch} from "../src/libraries/LibRewardRemitDispatch.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title RewardTransportEpochTest
 * @notice #1566 transport epochs PR 3b — the EPOCH LEDGER: an old-wire
 *         delivery opens one untyped balance whose listed days are its
 *         membership, an oversize delivery is admitted compactly and indexed
 *         in pages against its own commitment, and what remains becomes
 *         classifiable only once the batch is parked AND acknowledged —
 *         a release this cut does NOT offer (#2258): the lifecycle tests run it
 *         through a test-only raw entry, and one test pins that no
 *         production path can.
 *
 *         Every rule is pinned on BOTH sides: the same fixture is driven
 *         through the side the rule refuses and the side it admits, so a
 *         vacuous guard cannot pass. The pairs are deliberate — a typed
 *         delivery against an untyped one, a within-cap admission against an
 *         over-cap one, a parked batch against a parked-and-acknowledged one.
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
        _becomeMirror();
        // #1566 transport epochs PR 3b (Codex #2232 r1) — an epoch is opened
        // only where the delivery's untyped remainder is attributed, which is
        // on an ACTIVATED deployment. `test_Untyped_OpensNoEpochBeforeCustodyIsActivated`
        // drives the other side from a fixture that skips this line.
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

    function _becomeMirror() internal {
        vm.chainId(CHAIN_ARB);
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(false);
        RewardReporterFacet(address(diamond)).setBaseChainId(CHAIN_BASE);
        RewardRemittanceFacet(address(diamond)).setRewardRemittanceReceiver(address(this));
    }

    function _days(uint256 n) internal pure returns (uint256[] memory d) {
        d = new uint256[](n);
        for (uint256 i; i < n; ++i) d[i] = i + 1;
    }

    /// @dev A delivery as the receiver presents it. `splitTyped` is the WIRE'S
    ///      fact and is passed explicitly here rather than derived, because
    ///      the distinction between the two accounting paths is this suite's
    ///      whole subject.
    function _deliver(uint256 amount, uint256[] memory dayIds, uint256 remitId, bytes32 id, bool splitTyped)
        internal
        returns (bytes32 h)
    {
        uint256 recycled = splitTyped ? amount : 0;
        _ingress().onRewardBudgetReceived(
            address(vpfi), amount, dayIds, CHAIN_BASE, remitId, REMITTER, recycled, 0, id, splitTyped
        );
        return keccak256(abi.encode(uint256(CHAIN_BASE), id));
    }

    /// @dev An untyped delivery WITH its membership materialized, which is the
    ///      state most tests here start from. Admission is compact for every
    ///      delivery, so the index is a separate, permissionless step; the
    ///      tests whose subject IS that step call `_deliver` and materialize by
    ///      hand.
    function _untyped(uint256 amount, uint256 dayCount, uint256 remitId, bytes32 id)
        internal
        returns (bytes32 h)
    {
        uint256[] memory dayIds = _days(dayCount);
        h = _deliver(amount, dayIds, remitId, id, false);
        _epoch().materializeTransportBatchPage(h, dayIds);
    }

    // ─── 1. admission ────────────────────────────────────────────────────────

    /// An untyped delivery opens its epoch, bounded by WHAT LANDED, with every
    /// listed day indexed and its cursor at the start.
    function test_Untyped_OpensItsEpochBoundedByWhatLanded() public {
        // `_deliver`, not `_untyped`: this test's subject is what ADMISSION
        // writes, and the shared helper materializes the index afterwards.
        bytes32 h = _deliver(10e18, _days(3), 1, keccak256("u1"), false);

        (
            bytes32 packetHash,
            uint256 balance,
            uint256 admitted,
            uint32 dayCount,
            uint32 indexedDays,
            bool released
        ) = _epoch().getTransportBatch(h);
        assertEq(packetHash, h, "the batch is keyed by its packet");
        assertEq(balance, 10e18, "balance is what landed");
        assertEq(admitted, 10e18, "the conservation anchor");
        assertEq(dayCount, 3, "the listed days");
        assertEq(indexedDays, 0, "admission is compact: nothing indexed yet");
        assertFalse(released, "nothing has released it");

        // Compact means COMPACT — not one per-day write, whatever the length.
        for (uint256 d = 1; d <= 3; ++d) {
            (, , uint256 total, ) = _epoch().getTransportDayBatches(d, 0, 10);
            assertEq(total, 0, "no day reaches it before materialization");
        }

        assertEq(_epoch().materializeTransportBatchPage(h, _days(3)), 3, "indexed whole in one page");
        for (uint256 d = 1; d <= 3; ++d) {
            (bytes32[] memory page, , uint256 total, uint256 cursor) =
                _epoch().getTransportDayBatches(d, 0, 10);
            assertEq(total, 1, "the day lists the batch");
            assertEq(page[0], h, "and it is this one");
            assertEq(cursor, 0, "no draw has consumed it");
        }
        // A day the delivery did NOT list is untouched — membership is a
        // filter, not a broadcast.
        (, , uint256 unlistedTotal, ) = _epoch().getTransportDayBatches(4, 0, 10);
        assertEq(unlistedTotal, 0, "an unlisted day has no claim on it");
    }

    /// The other side of the same rule: a TYPED delivery opens no epoch at
    /// all. Its components were credited to the shared ledgers at ingress, so
    /// a batch as well would make one delivery spendable twice.
    function test_Typed_OpensNoEpoch() public {
        bytes32 h = _deliver(10e18, _days(3), 2, keccak256("t1"), true);

        (bytes32 packetHash, uint256 balance, , uint32 dayCount, , ) = _epoch().getTransportBatch(h);
        assertEq(packetHash, bytes32(0), "no batch was admitted");
        assertEq(balance, 0, "and none holds value");
        assertEq(dayCount, 0, "and none carries a membership");
        for (uint256 d = 1; d <= 3; ++d) {
            (, , uint256 total, ) = _epoch().getTransportDayBatches(d, 0, 10);
            assertEq(total, 0, "no day indexes a typed delivery");
        }
    }

    /// An over-cap delivery is ADMITTED — the payload is immutable, so a
    /// refusal would repeat forever — but compactly: it carries its aggregate
    /// and its commitment with no index, which is then materialized in pages.
    function test_OverCap_IsAdmittedCompactly_ThenIndexedInPages() public {
        uint256 cap = LibRewardCustody.TRANSPORT_DAY_FANOUT_CAP;
        uint256 count = cap + cap + 6; // two whole pages and a short one
        uint256[] memory dayIds = _days(count);
        bytes32 h = _deliver(7e18, dayIds, 3, keccak256("o1"), false);

        (, uint256 balance, , uint32 dayCount, uint32 indexedDays, ) =
            _epoch().getTransportBatch(h);
        assertEq(balance, 7e18, "the balance is admitted whole");
        assertEq(dayCount, uint32(count), "the count is recorded");
        assertEq(indexedDays, 0, "nothing is indexed yet");
        (, , uint256 total0, ) = _epoch().getTransportDayBatches(1, 0, 10);
        assertEq(total0, 0, "and no day can reach it yet");

        assertEq(_epoch().materializeTransportBatchPage(h, dayIds), uint32(cap), "page 1");
        assertEq(_epoch().materializeTransportBatchPage(h, dayIds), uint32(cap * 2), "page 2");
        assertEq(_epoch().materializeTransportBatchPage(h, dayIds), uint32(count), "the short last page");

        (, , , , uint32 indexedAfter, ) = _epoch().getTransportBatch(h);
        assertEq(indexedAfter, uint32(count), "indexed whole");
        for (uint256 d = 1; d <= count; ++d) {
            (bytes32[] memory page, , uint256 total, ) = _epoch().getTransportDayBatches(d, 0, 4);
            assertEq(total, 1, "every listed day reaches it now");
            assertEq(page[0], h, "and it is this batch");
        }
        // Whole means finished: there is no page left to write.
        vm.expectRevert(abi.encodeWithSelector(TransportBatchFullyIndexed.selector, h));
        _epoch().materializeTransportBatchPage(h, dayIds);
    }

    /// The commitment is the authority: a page proved against a list the
    /// delivery never committed to writes nothing.
    function test_Page_RefusesADayListTheDeliveryDidNotCommitTo() public {
        uint256 cap = LibRewardCustody.TRANSPORT_DAY_FANOUT_CAP;
        uint256[] memory dayIds = _days(cap + 1);
        bytes32 h = _deliver(7e18, dayIds, 4, keccak256("o2"), false);

        uint256[] memory forged = _days(cap + 1);
        forged[0] = 999; // one day moved is enough
        bytes32 committed = keccak256(abi.encode(dayIds));
        vm.expectRevert(
            abi.encodeWithSelector(
                TransportDayListMismatch.selector, h, committed, keccak256(abi.encode(forged))
            )
        );
        _epoch().materializeTransportBatchPage(h, forged);

        (, , , , uint32 indexedDays, ) = _epoch().getTransportBatch(h);
        assertEq(indexedDays, 0, "the refusal wrote nothing");
        // The honest list still works, so the refusal was the list's fault and
        // not the batch's. 33 days is a whole page and then a one-day page —
        // the page size is what bounds a call, never the list.
        assertEq(_epoch().materializeTransportBatchPage(h, dayIds), uint32(cap), "the committed list indexes a page");
        assertEq(_epoch().materializeTransportBatchPage(h, dayIds), uint32(cap + 1), "and then the remainder");
    }

    /// A batch whose index is already whole has no page left — the refusal is
    /// about completeness, not about the list's length: a short list is
    /// admitted compactly like any other and takes one page.
    function test_Page_RefusesAnAlreadyWholeIndex() public {
        uint256[] memory dayIds = _days(3);
        bytes32 h = _deliver(5e18, dayIds, 5, keccak256("w1"), false);
        assertEq(_epoch().materializeTransportBatchPage(h, dayIds), 3, "one page covers it");
        vm.expectRevert(abi.encodeWithSelector(TransportBatchFullyIndexed.selector, h));
        _epoch().materializeTransportBatchPage(h, dayIds);
    }

    /// THE property the compact admission exists to guarantee: its cost does
    /// NOT scale with the day list. The mirror's receive callback runs under a
    /// fixed destination gas budget, so an admission that grew with the list
    /// would fail to deliver exactly the long in-flight old-wire messages this
    /// path is meant to preserve.
    ///
    /// Asserted as the DIFFERENCE between a one-day and a full-cap delivery,
    /// because that is the claim — constant cost — and it is the claim a test
    /// can hold the code to. Asserting a total against the budget instead
    /// would be asserting something this PR neither causes nor can fix; see
    /// `test_Ingress_BaselineAlreadyExceedsTheTransportBudget` below, which
    /// records that separately and honestly.
    function test_Admission_CostDoesNotScaleWithTheDayList() public {
        // A WARM-UP delivery first. The ledger's shared slots — the received
        // totals, the uncounted counter, the holder's row — are cold on the
        // first ingress of a test and warm afterwards, so two sequential
        // measurements are not comparable: without this, the 32-day call
        // measured LESS than the 1-day call that preceded it and the
        // subtraction below underflowed.
        _ingress().onRewardBudgetReceived(
            address(vpfi), 1e18, _days(1), CHAIN_BASE, 70, REMITTER, 0, 0, keccak256("gas-warm"), false
        );

        uint256[] memory one = _days(1);
        uint256 before = gasleft();
        _ingress().onRewardBudgetReceived(
            address(vpfi), 10e18, one, CHAIN_BASE, 77, REMITTER, 0, 0, keccak256("gas-1"), false
        );
        uint256 shortList = before - gasleft();

        uint256[] memory full = _days(LibRewardCustody.TRANSPORT_DAY_FANOUT_CAP);
        before = gasleft();
        _ingress().onRewardBudgetReceived(
            address(vpfi), 10e18, full, CHAIN_BASE, 78, REMITTER, 0, 0, keccak256("gas-32"), false
        );
        uint256 fullList = before - gasleft();

        emit log_named_uint("1-day untyped ingress ", shortList);
        emit log_named_uint("32-day untyped ingress", fullList);

        // Calldata and the commitment hash DO grow with the list — 31 extra
        // words is on the order of 16k — and that is fine: calldata is not what
        // a storage-bound admission would spend. The hypothesis this kills is a
        // PER-DAY STORAGE WRITE, which would put roughly 22k on each of those
        // 31 days, about 680k. A ceiling an order of magnitude below that
        // excludes it without pinning the calldata arithmetic, which is not
        // this test's subject.
        assertLt(
            fullList - shortList,
            100_000,
            "admission must not pay per listed day"
        );
    }

    /// Recorded rather than asserted-away: the ingress ALREADY costs more than
    /// the transport's declared destination budget, with no transport epoch
    /// involved at all.
    ///
    /// Found while measuring the admission above. A typed delivery — which
    /// opens no epoch and runs only the code that predates this PR — measured
    /// about 400k against a declared 300k. That is a pre-existing gap between
    /// `REWARD_BUDGET_DEST_GAS_LIMIT` and what the mirror ingress actually
    /// costs, and it is not this PR's to close; the epoch's own contribution
    /// is bounded by the test above.
    ///
    /// This test FAILS THE DAY THE GAP CLOSES, which is the point: whoever
    /// fixes the budget should be told there is a test here describing the old
    /// state, rather than finding a stale comment.
    function test_Ingress_BaselineAlreadyExceedsTheTransportBudget() public {
        uint256[] memory one = _days(1);
        uint256 before = gasleft();
        _ingress().onRewardBudgetReceived(
            address(vpfi), 10e18, one, CHAIN_BASE, 79, REMITTER, 10e18, 0, keccak256("gas-typed"), true
        );
        uint256 typedUsed = before - gasleft();
        emit log_named_uint("typed ingress gas (no epoch)", typedUsed);
        emit log_named_uint("declared destination budget ", LibRewardRemitDispatch.REWARD_BUDGET_DEST_GAS_LIMIT);
        assertGt(
            typedUsed,
            LibRewardRemitDispatch.REWARD_BUDGET_DEST_GAS_LIMIT,
            "if this now fits, the pre-existing budget gap was closed - delete this test and say so"
        );
    }

    // ─── 1b. the rollout population (Codex #2232 r3) ─────────────────────────

    /// @dev Put a delivered packet back into its PRE-3b shape: 3a's day-list
    ///      commitment and the protected balance intact, the epoch gone. This
    ///      is every old-wire packet that landed on an activated mirror while
    ///      3a was deployed and 3b was not, and it is the only way to produce
    ///      one — the current ingress always admits.
    function _asRolloutPacket(uint256 amount, uint256 dayCount, uint256 remitId, bytes32 id)
        internal
        returns (bytes32 h, uint256[] memory dayIds)
    {
        dayIds = _days(dayCount);
        h = _deliver(amount, dayIds, remitId, id, false);
        _mut().unadmitTransportBatchRaw(h);
    }

    /// A packet that landed between 3a and 3b is admitted from its OWN RECORD,
    /// and admitting it is what makes 3a's commitment mean what design §5c says
    /// it means. Before the entry existed that packet held untyped value with
    /// no epoch bounding it, its committed list was refused as an unknown
    /// batch, and its zero `batchId` made classification skip the gate.
    function test_Rollout_AdmitsAPacketThatLandedBeforeTheLedger() public {
        (bytes32 h, uint256[] memory dayIds) = _asRolloutPacket(10e18, 3, 60, keccak256("roll1"));

        // The pre-3b state, asserted rather than assumed — otherwise the test
        // below could pass against a packet that never lost its batch.
        (bytes32 before, , , , , ) = _epoch().getTransportBatch(h);
        assertEq(before, bytes32(0), "no epoch, as a pre-3b arrival has none");
        vm.expectRevert(abi.encodeWithSelector(TransportBatchUnknown.selector, h));
        _epoch().materializeTransportBatchPage(h, dayIds);

        assertEq(_epoch().admitLegacyTransportBatch(h, dayIds), h, "the batch is keyed by its packet");

        (
            bytes32 packetHash,
            uint256 balance,
            uint256 admitted,
            uint32 dayCount,
            uint32 indexedDays,
            bool released
        ) = _epoch().getTransportBatch(h);
        assertEq(packetHash, h, "the epoch exists now");
        assertEq(balance, 10e18, "bounded by what the packet still holds unclassified");
        assertEq(admitted, 10e18, "which is its conservation anchor");
        assertEq(dayCount, 3, "membership taken from the packet's own commitment");
        assertEq(indexedDays, 0, "and admitted COMPACTLY, exactly as the ingress admits");
        assertFalse(released, "nothing has released it");

        // One path afterwards, whichever entry opened the epoch: the same
        // commitment proves the same pages, and refuses any other list. The
        // refusal is driven BEFORE the index is whole, so it is the
        // commitment that rejects the page and not the progress counter.
        vm.expectRevert(
            abi.encodeWithSelector(
                TransportDayListMismatch.selector, h, keccak256(abi.encode(dayIds)), keccak256(abi.encode(_days(2)))
            )
        );
        _epoch().materializeTransportBatchPage(h, _days(2));
        assertEq(_epoch().materializeTransportBatchPage(h, dayIds), 3, "indexed against 3a's commitment");

        // And the gate now binds it, which is the whole point: before the
        // admission this packet could be classified with no release at all.
        AdminFacet(address(diamond)).pause();
        vm.expectRevert(abi.encodeWithSelector(TransportBatchNotReleased.selector, h, h));
        _recon().classifyLegacyPacket(h, 0, 4e18, keccak256("rollE1"));
        AdminFacet(address(diamond)).unpause();
    }

    /// The entry is permissionless, for the same reason materialization and
    /// the release are: every figure it writes is read from the packet's own
    /// record, so a stranger calling it can only make the ledger state what
    /// the ingress already wrote.
    function test_Rollout_IsOpenToAnyone() public {
        (bytes32 h, uint256[] memory dayIds) = _asRolloutPacket(6e18, 2, 61, keccak256("roll2"));
        vm.prank(makeAddr("rolloutStranger"));
        assertEq(_epoch().admitLegacyTransportBatch(h, dayIds), h, "anyone may admit it");
        (, uint256 balance, , , , ) = _epoch().getTransportBatch(h);
        assertEq(balance, 6e18, "from the record, not from the caller");
    }

    /// CLOSING THE GATE COSTS WHAT OPENING IT COSTS.
    ///
    /// The rollout admission sets `p.batchId`, which closes the classification
    /// gate on a packet that was ungated until then, and the only route back
    /// through that gate runs via `materializeTransportBatchPage`, which proves
    /// the day list against the packet's commitment. If admission did not take
    /// the same list, anyone could close a gate that only a list-holder could
    /// reopen — and the rollout population is by definition the oldest
    /// deliveries, whose list survives only in long-past event data.
    ///
    /// So a wrong list is refused by the same error the page uses, and the
    /// packet stays ungated and classifiable afterwards, which is the property
    /// that actually matters: a failed attempt must leave nothing behind.
    function test_Rollout_RefusesAListTheDeliveryDidNotCommitTo() public {
        (bytes32 h, uint256[] memory dayIds) = _asRolloutPacket(8e18, 3, 66, keccak256("roll7"));
        uint256[] memory wrong = _days(3);
        wrong[2] = 99;

        vm.expectRevert(
            abi.encodeWithSelector(
                TransportDayListMismatch.selector, h, keccak256(abi.encode(dayIds)), keccak256(abi.encode(wrong))
            )
        );
        _epoch().admitLegacyTransportBatch(h, wrong);

        (bytes32 stillNone, , , , , ) = _epoch().getTransportBatch(h);
        assertEq(stillNone, bytes32(0), "a refused admission opens no epoch");

        // And the packet stays GATED, which is what it means for a refused
        // admission to have cost nothing (Codex #2232 r4). This assertion
        // used to drive a classification through here and call the packet
        // unharmed — but a rollout-admissible packet holds no epoch only
        // until somebody admits it, so classifying now would spend, with no
        // release and no debit, exactly the value its own listed days are
        // entitled to reach. The refusal names the missing step.
        AdminFacet(address(diamond)).pause();
        vm.expectRevert(abi.encodeWithSelector(TransportBatchNotAdmitted.selector, h));
        _recon().classifyLegacyPacket(h, 0, 1e18, keccak256("roll7c"));
        AdminFacet(address(diamond)).unpause();

        // The committed list still admits it, on the WHOLE remainder — the
        // failed attempt consumed nothing and the refusal above took nothing.
        assertEq(_epoch().admitLegacyTransportBatch(h, dayIds), h, "the committed list admits it");
        (, uint256 balance, uint256 admitted, , , ) = _epoch().getTransportBatch(h);
        assertEq(admitted, 8e18, "over everything the delivery still held");
        assertEq(balance, admitted, "with nothing spent in the meantime");
    }

    /// Each refusal by name, and each straddled against the admission above —
    /// a guard that refused everything would pass a one-sided test.
    function test_Rollout_RefusesEveryPacketItMustNotAdmit() public {
        // 1. already admitted: a re-run must not restate an immutable anchor.
        bytes32 live = _deliver(9e18, _days(2), 62, keccak256("roll3"), false);
        vm.expectRevert(abi.encodeWithSelector(TransportBatchAlreadyAdmitted.selector, live));
        _epoch().admitLegacyTransportBatch(live, _days(2));

        // 2. wire-typed: its components were credited to the shared ledgers at
        //    ingress, so an epoch over them is one value in two places.
        bytes32 typed = _deliver(9e18, _days(2), 63, keccak256("roll4"), true);
        vm.expectRevert(abi.encodeWithSelector(TransportPacketWireTyped.selector, typed));
        _epoch().admitLegacyTransportBatch(typed, _days(2));

        // 3. unknown packet: nothing arrived under this stamp.
        bytes32 ghost = keccak256("neverArrived");
        vm.expectRevert(abi.encodeWithSelector(IngressPacketUnknown.selector, ghost));
        _epoch().admitLegacyTransportBatch(ghost, _days(1));

        // 4. no day list to be bound to, in BOTH shapes that carry none — a
        //    pre-3a arrival that recorded no fingerprint, and a record whose
        //    count is zero. Membership is never taken from a caller's word, so
        //    neither can be admitted however plainly untyped it looks.
        (bytes32 noList, uint256[] memory noListDays) = _asRolloutPacket(7e18, 2, 65, keccak256("roll6"));
        _mut().setPacketDayListRaw(noList, bytes32(0), 2);
        vm.expectRevert(abi.encodeWithSelector(TransportPacketHasNoDayList.selector, noList));
        _epoch().admitLegacyTransportBatch(noList, noListDays);
        _mut().setPacketDayListRaw(noList, keccak256("someList"), 0);
        vm.expectRevert(abi.encodeWithSelector(TransportPacketHasNoDayList.selector, noList));
        _epoch().admitLegacyTransportBatch(noList, noListDays);

        // 5. nothing untyped left to bind. Admitted, released, and classified
        //    down to zero: a second epoch over the emptied packet would hold it
        //    shut behind a release that releases nothing.
        (bytes32 spent, uint256[] memory spentDays) = (bytes32(0), _days(1));
        spent = _deliver(5e18, spentDays, 64, keccak256("roll5"), false);
        _epoch().materializeTransportBatchPage(spent, spentDays);
        _mut().parkTransportBatchRaw(spent);
        _mut().acknowledgeTransportBatchRaw(spent);
        AdminFacet(address(diamond)).pause();
        _recon().classifyLegacyPacket(spent, 0, 5e18, keccak256("rollE2"));
        AdminFacet(address(diamond)).unpause();
        _mut().unadmitTransportBatchRaw(spent);
        vm.expectRevert(abi.encodeWithSelector(TransportPacketNothingUntyped.selector, spent));
        _epoch().admitLegacyTransportBatch(spent, spentDays);
    }

    // ─── 2. the release, and the classification gate it opens ────────────────

    /// The gate, straddled: an old-wire packet is refused a classification
    /// while its epoch stands, still refused when the remainder is merely
    /// PARKED, and admitted only once the acknowledgment is recorded.
    function test_Classification_IsRefusedUntilTheEpochIsReleased() public {
        bytes32 h = _untyped(10e18, 2, 7, keccak256("g1"));

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

        ( , , , , , bool released) = _epoch().getTransportBatch(h);
        assertTrue(released, "the acknowledgment released it");
    }

    /// A packet holding no epoch passes the gate untouched — the rule is about
    /// value held in a transport epoch, and such a packet holds none.
    /// "No epoch" and "no epoch YET" are different, and only the first is
    /// ungated (Codex #2232 r4).
    ///
    /// A 3a-to-3b packet carries a day-list commitment and holds no batch
    /// until somebody calls the permissionless rollout admission. Reading
    /// that as "pre-ledger" let an administrator classify its remainder away
    /// with no release and no debit — the bypass the epoch gate exists to
    /// close, surviving on precisely the population the rollout entry exists
    /// to rescue. Both sides are driven here: the same packet is refused
    /// before admission and classifies after the full close-out, and the
    /// debit lands.
    function test_Classification_RefusesARolloutPacketUntilItIsAdmitted() public {
        (bytes32 h, uint256[] memory dayIds) = _asRolloutPacket(9e18, 2, 70, keccak256("gate1"));

        AdminFacet(address(diamond)).pause();
        vm.expectRevert(abi.encodeWithSelector(TransportBatchNotAdmitted.selector, h));
        _recon().classifyLegacyPacket(h, 0, 3e18, keccak256("gate1a"));
        AdminFacet(address(diamond)).unpause();

        // Admission alone is not enough either — it opens the epoch, and the
        // release is still owed.
        _epoch().admitLegacyTransportBatch(h, dayIds);
        AdminFacet(address(diamond)).pause();
        vm.expectRevert(
            abi.encodeWithSelector(TransportBatchNotReleased.selector, h, h)
        );
        _recon().classifyLegacyPacket(h, 0, 3e18, keccak256("gate1b"));
        AdminFacet(address(diamond)).unpause();

        // Indexed, parked, acknowledged — and the same call now lands, taking
        // its value from the parked remainder.
        _epoch().materializeTransportBatchPage(h, dayIds);
        _mut().parkTransportBatchRaw(h);
        _mut().acknowledgeTransportBatchRaw(h);
        AdminFacet(address(diamond)).pause();
        _recon().classifyLegacyPacket(h, 0, 3e18, keccak256("gate1c"));
        AdminFacet(address(diamond)).unpause();

        (uint256 parked, , , , uint256 debited) = _epoch().getTransportRemainder(h);
        assertEq(parked, 6e18, "the remainder is stepped down by what was classified");
        assertEq(debited, 3e18, "and the exit is recorded");
    }

    function test_Classification_IsUngatedForAPacketWithNoEpoch() public {
        bytes32 h = _deliver(10e18, _days(2), 8, keccak256("t3"), true);
        // Typed: its recycled component was credited at ingress, so there is
        // nothing unclassified to take — which is a DIFFERENT refusal, and
        // that is the point: the epoch gate is not what stands in the way.
        AdminFacet(address(diamond)).pause();
        try _recon().classifyLegacyPacket(h, 0, 1e18, keccak256("e2")) {
            // passing outright is also fine
        } catch (bytes memory err) {
            assertTrue(
                bytes4(err) != TransportBatchNotReleased.selector,
                "a packet with no epoch is never refused by the epoch gate"
            );
        }
        AdminFacet(address(diamond)).unpause();
    }

    /// Parking moves the WHOLE balance and keeps it membership-bound: the
    /// batch conserves (`admitted == balance + parked`) and the remainder
    /// carries the very commitment the delivery made at ingress.
    function test_Park_MovesTheWholeBalance_AndKeepsItMembershipBound() public {
        uint256[] memory dayIds = _days(3);
        bytes32 h = _deliver(9e18, dayIds, 9, keccak256("p1"), false);
        _epoch().materializeTransportBatchPage(h, dayIds);

        assertEq(_mut().parkTransportBatchRaw(h), 9e18, "parked what the obligations left");

        (, uint256 balance, uint256 admitted, , , ) = _epoch().getTransportBatch(h);
        (uint256 amount, bytes32 dayListHash, uint32 dayCount, bool acknowledged, uint256 debited) =
            _epoch().getTransportRemainder(h);
        assertEq(debited, 0, "nothing has been classified out of it yet");
        assertEq(balance, 0, "the epoch holds nothing now");
        assertEq(admitted, balance + amount, "and the batch conserves");
        assertEq(amount, 9e18, "the remainder is the whole balance");
        assertEq(dayListHash, keccak256(abi.encode(dayIds)), "bound by the delivery's own commitment");
        assertEq(dayCount, 3, "and by its count");
        assertFalse(acknowledged, "parking is not the acknowledgment");
    }

    /// An incompletely indexed batch cannot be parked: until its whole
    /// membership exists, what its obligations may still reach is not known.
    function test_Park_RefusesAnIncompletelyIndexedBatch() public {
        uint256 cap = LibRewardCustody.TRANSPORT_DAY_FANOUT_CAP;
        uint256[] memory dayIds = _days(cap + 2);
        bytes32 h = _deliver(4e18, dayIds, 10, keccak256("p2"), false);

        vm.expectRevert(
            abi.encodeWithSelector(TransportBatchNotFullyIndexed.selector, h, uint32(0), uint32(cap + 2))
        );
        _mut().parkTransportBatchRaw(h);

        _epoch().materializeTransportBatchPage(h, dayIds);
        vm.expectRevert(
            abi.encodeWithSelector(TransportBatchNotFullyIndexed.selector, h, uint32(cap), uint32(cap + 2))
        );
        _mut().parkTransportBatchRaw(h);

        // Indexed whole, the same call now succeeds — so the refusal was the
        // indexing and nothing else.
        _epoch().materializeTransportBatchPage(h, dayIds);
        assertEq(_mut().parkTransportBatchRaw(h), 4e18, "parks once whole");
    }

    /// Each half of the release happens exactly once, and neither can stand in
    /// for the other.
    function test_Release_EachHalfHappensOnce_AndNeitherSubstitutes() public {
        bytes32 h = _untyped(6e18, 2, 11, keccak256("r1"));

        vm.expectRevert(abi.encodeWithSelector(TransportRemainderNotParked.selector, h));
        _mut().acknowledgeTransportBatchRaw(h);

        _mut().parkTransportBatchRaw(h);
        vm.expectRevert(abi.encodeWithSelector(TransportRemainderAlreadyParked.selector, h));
        _mut().parkTransportBatchRaw(h);

        _mut().acknowledgeTransportBatchRaw(h);
        vm.expectRevert(abi.encodeWithSelector(TransportRemainderAlreadyAcknowledged.selector, h));
        _mut().acknowledgeTransportBatchRaw(h);
    }


    /// Materialization is permissionless too, and for the same reason: the
    /// authority is the delivery's commitment, not the caller.
    function test_Page_IsOpenToAnyone() public {
        uint256[] memory dayIds = _days(3);
        bytes32 h = _deliver(5e18, dayIds, 13, keccak256("perm2"), false);
        vm.prank(makeAddr("stranger2"));
        assertEq(_epoch().materializeTransportBatchPage(h, dayIds), 3, "anyone may index it");
    }


    /// A classification DEBITS the parked remainder by what it takes, and
    /// cannot take more than the entry still holds. Without the debit the entry
    /// would keep reporting its parked figure while the value had already left,
    /// so the restore and disposition machinery 3b-ii adds would treat
    /// already-classified value as still parked.
    function test_Classification_DebitsTheParkedRemainder_AndIsBoundedByIt() public {
        bytes32 h = _untyped(10e18, 2, 40, keccak256("dbt"));
        _mut().parkTransportBatchRaw(h);
        _mut().acknowledgeTransportBatchRaw(h);
        (uint256 parked, , , , ) = _epoch().getTransportRemainder(h);
        assertEq(parked, 10e18, "the whole balance is parked");

        AdminFacet(address(diamond)).pause();
        _recon().classifyLegacyPacket(h, 0, 4e18, keccak256("d1"));
        AdminFacet(address(diamond)).unpause();
        (parked, , , , ) = _epoch().getTransportRemainder(h);
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
        (parked, , , , ) = _epoch().getTransportRemainder(h);
        assertEq(parked, 0, "the entry is emptied exactly");
    }

    /// #2258 (owner decision 2026-09-20) — the RELEASE IS NOT AVAILABLE in
    /// 3b-i, to anyone. §5c requires classification to refuse a batch that
    /// still lists an outstanding obligation, and 3b-i has no per-day figure to
    /// test that with; a release the chain cannot check is an earmark spent on
    /// the caller's say-so. Both entries refuse FIRST — the admin, a stranger
    /// and an unknown id all get the same answer — while the library
    /// machinery behind them stays reachable through the test-only raw entry,
    /// which is how every lifecycle test above still runs.
    function test_Release_IsNotAvailableInThisCut_ForAnyone() public {
        bytes32 h = _untyped(6e18, 2, 12, keccak256("shut"));
        address[2] memory callers = [address(this), makeAddr("stranger")];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(TransportReleaseNotYetAvailable.selector, h));
            _epoch().parkTransportBatchRemainder(h);
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(TransportReleaseNotYetAvailable.selector, h));
            _epoch().acknowledgeTransportBatchRemainder(h);
        }
        // Refused before it looks: an id no delivery opened gets the same
        // answer, not `TransportBatchUnknown`.
        bytes32 nobody = keccak256("nobody");
        vm.expectRevert(abi.encodeWithSelector(TransportReleaseNotYetAvailable.selector, nobody));
        _epoch().parkTransportBatchRemainder(nobody);
        // And therefore nothing can be classified early: the gate still holds
        // because no production path can open it.
        ( , , , , , bool released) = _epoch().getTransportBatch(h);
        assertFalse(released, "no production path releases a batch in 3b-i");
        // The machinery exists and is the 3b-ii implementation — the raw entry
        // proves it, and every lifecycle test in this suite runs through it.
        assertEq(_mut().releaseTransportBatchRaw(h), 6e18, "the library release works, behind the door");
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
        bytes32 h = _untyped(10e18, 2, 12, keccak256("l1"));
        (uint256 consumedFresh, uint256 consumedRecycled, ) = _epoch().getTransportBatchLegs(h);
        assertEq(consumedFresh, 0, "no fresh leg has been drawn");
        assertEq(consumedRecycled, 0, "nor a recycled one");

        _mut().parkTransportBatchRaw(h);
        _mut().acknowledgeTransportBatchRaw(h);
        (consumedFresh, consumedRecycled, ) = _epoch().getTransportBatchLegs(h);
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
        bytes32 h = _untyped(10e18, 2, 77, keccak256("r15"));
        bytes32 nobody = keccak256("no delivery opened this");

        // The known batch: zeros, and they are an ANSWER.
        (uint256 consumedFresh, uint256 consumedRecycled, ) = _epoch().getTransportBatchLegs(h);
        assertEq(consumedFresh + consumedRecycled, 0, "a known batch has drawn nothing yet");
        (uint256 parked, , , bool acknowledged, uint256 debited) = _epoch().getTransportRemainder(h);
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
        (bytes32 packetHash, uint256 balance, uint256 admitted, , , bool released) =
            _epoch().getTransportBatch(nobody);
        assertEq(packetHash, bytes32(0), "the zero stamp IS the answer 'no batch here'");
        assertEq(balance, 0, "and nothing is claimed about a batch that does not exist");
        assertEq(admitted, 0, "nor about what it was admitted with");
        assertFalse(released, "nor about its release");
    }

    /// A TYPED delivery opens no epoch by design, so the detail reads refuse
    /// its packet stamp as well. Straddled here rather than left implied: the
    /// gate that lets a typed packet through classification is a different
    /// rule from this one, and a reader who confuses them would expect zeros.
    function test_Reads_RefuseATypedDeliverysStamp() public {
        bytes32 h = _deliver(10e18, _days(2), 78, keccak256("r15typed"), true);
        (bytes32 packetHash, , , , , ) = _epoch().getTransportBatch(h);
        assertEq(packetHash, bytes32(0), "a typed delivery holds no epoch");
        vm.expectRevert(abi.encodeWithSelector(TransportBatchUnknown.selector, h));
        _epoch().getTransportBatchLegs(h);
        vm.expectRevert(abi.encodeWithSelector(TransportBatchUnknown.selector, h));
        _epoch().getTransportRemainder(h);
    }

    /// The day index paginates and reports its cursor, because the legacy lane
    /// can mint arbitrarily many batches listing one day — a view returning
    /// the whole index would stop being callable on exactly the days that
    /// matter most.
    function test_DayIndex_Paginates() public {
        for (uint256 i; i < 5; ++i) {
            bytes32 bh = _deliver(1e18, _days(1), 20 + i, keccak256(abi.encode("d", i)), false);
            // Admission is compact, so each batch is indexed here.
            _epoch().materializeTransportBatchPage(bh, _days(1));
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
        // with it. Position is only where the materializing caller put it —
        // `test_DayIndex_OrdersByArrival_NotByWhoMaterializedFirst` drives the
        // side where the two disagree.
        (bytes32[] memory all, uint64[] memory arrivals, , ) =
            _epoch().getTransportDayBatches(1, 0, 10);
        assertEq(all.length, 5, "every member comes back");
        assertEq(arrivals.length, 5, "each with its ordering key");
        for (uint256 i; i < 5; ++i) {
            assertEq(arrivals[i], uint64(block.timestamp), "the delivery's own recorded arrival");
        }
    }

    /// A day's index is ARRIVAL-ORDERED BY CONSTRUCTION, whoever materializes
    /// first (3b-ii-A, Codex #2276 r5 P1). This test used to pin the
    /// opposite — that position carried no meaning and a reader had to sort
    /// by the arrival key — which held until the draws read the index through
    /// a bounded WINDOW: a window is a prefix of the index, and a prefix of a
    /// caller-ordered index is the caller's choice of what a day may draw
    /// from. So materialization now inserts each epoch at its place by
    /// arrival (never behind the day's cursor), and the array's order IS the
    /// arrival order.
    ///
    /// Materialization is permissionless and asynchronous, so a later
    /// delivery can still be indexed before an earlier one that lists the
    /// same day. This drives exactly that: B arrives second and is
    /// materialized FIRST — and A still leads the index.
    function test_DayIndex_OrdersByArrival_NotByWhoMaterializedFirst() public {
        uint256[] memory dayIds = _days(1);
        bytes32 a = _deliver(4e18, dayIds, 41, keccak256("aEarly"), false);
        bytes32 b = _deliver(5e18, dayIds, 42, keccak256("bLate"), false);
        // The deliveries share this block, so the arrivals are stamped apart
        // explicitly: the subject is the key, not the clock.
        _mut().setPacketArrivedAtRaw(a, 1000);
        _mut().setPacketArrivedAtRaw(b, 2000);

        // The LATER delivery is materialized FIRST — the caller-timing case.
        _epoch().materializeTransportBatchPage(b, dayIds);
        _epoch().materializeTransportBatchPage(a, dayIds);

        (bytes32[] memory page, uint64[] memory arrivals, uint256 total, ) =
            _epoch().getTransportDayBatches(1, 0, 10);
        assertEq(total, 2, "both list the day");
        assertEq(page[0], a, "position 0 is the EARLIER arrival, although it was materialized second");
        assertEq(page[1], b, "and position 1 the later one");
        assertEq(arrivals[0], 1000, "the key at position 0 is the earlier arrival");
        assertEq(arrivals[1], 2000, "and the key at position 1 the later one");
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
    /// It cannot, and this pins WHY, because the reason is INCIDENTAL to
    /// this ledger rather than stated by it. A stranded record binds to a
    /// packet only through `unclassifiedQuarantine`, whose two call sites
    /// both pass a COMPENSATION packet's stamp; and the compensation ingress
    /// records its whole amount as the fresh component, which
    /// `rolloutAdmissionStatus` refuses permanently as `ROLLOUT_WIRE_TYPED`.
    /// Nothing in the epoch ledger declares that dependency, so an ingress
    /// change that recorded a compensation untyped would open this door
    /// silently and no existing test would notice.
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

        // And no epoch can ever be opened over it. The live entry never runs
        // on a compensation; the retrospective one refuses by name.
        uint256[] memory one = new uint256[](1);
        one[0] = dayId;
        vm.expectRevert(abi.encodeWithSelector(TransportPacketWireTyped.selector, comp));
        _epoch().admitLegacyTransportBatch(comp, one);

        // WHY it refuses, taken from the record's SHAPE rather than from this
        // fixture's numbers: the compensation ingress states the whole amount
        // as the fresh component. Change that and the refusal above becomes
        // an admission without a single line of the epoch ledger changing.
        LibVaipakam.IngressPacket memory p = _lens().getIngressPacket(comp);
        // Pinned non-vacuously: two zeros would satisfy the equality below and
        // would ALSO be the untyped shape this clause is meant to refuse.
        assertEq(p.actualReceived, 6e18, "the whole delivery is on the record");
        assertEq(p.freshShare, p.actualReceived, "a compensation is recorded WIRE-TYPED, whole");
        assertTrue(
            p.dayListHash != bytes32(0),
            "and it does carry a 3a commitment - the day list is not what refuses it"
        );

        // The other side of the pair: an untyped BUDGET delivery DOES open an
        // epoch, and nothing is bound to it under its own receipt, so the door
        // is shut on the one packet that holds an anchor.
        bytes32 h = _untyped(10e18, 2, 901, keccak256("fourth-door-budget"));
        assertEq(_lens().getIngressPacket(h).batchId, h, "the budget packet holds its epoch");
        LibVaipakam.StrandedRecovery memory none = _lens().getStrandedRecovery(REMITTER, 901);
        assertEq(none.packetHash, bytes32(0), "and no stranded record names it");
        assertEq(none.held, 0, "with nothing for a return to draw from it");
    }
}

/**
 * @title RewardTransportEpochPreActivationTest
 * @notice #1566 transport epochs PR 3b (Codex #2232 r1) — the OTHER side of the
 *         activation rule, driven from a fixture that deliberately stops short
 *         of activating reward custody.
 *
 *         Its own contract rather than a test inside the suite above, because
 *         the condition is established in `setUp` and an activated deployment
 *         cannot be un-activated. Together the two contracts straddle the rule:
 *         the same delivery opens an epoch there and none here.
 *
 *         Why the rule exists: before activation the delivery's tokens sit
 *         Diamond-side and the activation envelope is what attributes them, so
 *         an epoch opened now would claim an amount that envelope is free to
 *         move somewhere else — two records on one sum, which no later
 *         arithmetic could reconcile.
 */
contract RewardTransportEpochPreActivationTest is SetupTest, IVaipakamErrors {
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
        // Deliberately NOT activated.
    }

    function test_Untyped_OpensNoEpochBeforeCustodyIsActivated() public {
        uint256[] memory dayIds = new uint256[](2);
        dayIds[0] = 1;
        dayIds[1] = 2;
        RewardIngressFacet(address(diamond)).onRewardBudgetReceived(
            address(vpfi), 10e18, dayIds, CHAIN_BASE, 99, REMITTER, 0, 0, keccak256("pre-act"), false
        );
        bytes32 h = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("pre-act")));

        RewardEpochFacet ep = RewardEpochFacet(address(diamond));
        (bytes32 packetHash, uint256 balance, , uint32 dayCount, , ) = ep.getTransportBatch(h);
        assertEq(packetHash, bytes32(0), "no epoch before activation");
        assertEq(balance, 0, "and none holds value");
        assertEq(dayCount, 0, "and none carries a membership");
        for (uint256 d = 1; d <= 2; ++d) {
            (, , uint256 total, ) = ep.getTransportDayBatches(d, 0, 4);
            assertEq(total, 0, "no day indexes it");
        }

        // The delivery itself is intact and unchanged — this is the pre-3b
        // path, not a refusal.
        assertGt(
            RewardRemittanceLensFacet(address(diamond)).getReceivedRemit(REMITTER, 99).receivedAt,
            0,
            "the delivery landed and wrote its receipt"
        );
    }

    /// The ROLLOUT admission carries the SAME activation condition as the
    /// ingress (Codex #2232 r3). A permissionless entry that could open an
    /// epoch here would reintroduce exactly the divergence r1 closed: the
    /// epoch would report a balance while the packet's tokens are still
    /// Diamond-side, waiting for the activation envelope to attribute them —
    /// two claims on one amount.
    function test_Rollout_OpensNoEpochBeforeCustodyIsActivated() public {
        uint256[] memory dayIds = new uint256[](2);
        dayIds[0] = 1;
        dayIds[1] = 2;
        RewardIngressFacet(address(diamond)).onRewardBudgetReceived(
            address(vpfi), 10e18, dayIds, CHAIN_BASE, 98, REMITTER, 0, 0, keccak256("pre-act-roll"), false
        );
        bytes32 h = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("pre-act-roll")));

        uint256[] memory preActDays = new uint256[](1);
        preActDays[0] = 1;
        vm.expectRevert(RewardCustodyNotActivated.selector);
        RewardEpochFacet(address(diamond)).admitLegacyTransportBatch(h, preActDays);
    }
}
