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
import {LibRewardRemitDispatch} from "../src/libraries/LibRewardRemitDispatch.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title RewardTransportEpochTest
 * @notice #1566 transport epochs PR 3b — the EPOCH LEDGER: an old-wire
 *         delivery opens one untyped balance whose listed days are its
 *         membership, an oversize delivery is admitted compactly and indexed
 *         in pages against its own commitment, and what remains becomes
 *         classifiable only once the batch is parked AND acknowledged.
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
            (, uint256 total, ) = _epoch().getTransportDayBatches(d, 0, 10);
            assertEq(total, 0, "no day reaches it before materialization");
        }

        assertEq(_epoch().materializeTransportBatchPage(h, _days(3)), 3, "indexed whole in one page");
        for (uint256 d = 1; d <= 3; ++d) {
            (bytes32[] memory page, uint256 total, uint256 cursor) =
                _epoch().getTransportDayBatches(d, 0, 10);
            assertEq(total, 1, "the day lists the batch");
            assertEq(page[0], h, "and it is this one");
            assertEq(cursor, 0, "no draw has consumed it");
        }
        // A day the delivery did NOT list is untouched — membership is a
        // filter, not a broadcast.
        (, uint256 unlistedTotal, ) = _epoch().getTransportDayBatches(4, 0, 10);
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
            (, uint256 total, ) = _epoch().getTransportDayBatches(d, 0, 10);
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
        (, uint256 total0, ) = _epoch().getTransportDayBatches(1, 0, 10);
        assertEq(total0, 0, "and no day can reach it yet");

        assertEq(_epoch().materializeTransportBatchPage(h, dayIds), uint32(cap), "page 1");
        assertEq(_epoch().materializeTransportBatchPage(h, dayIds), uint32(cap * 2), "page 2");
        assertEq(_epoch().materializeTransportBatchPage(h, dayIds), uint32(count), "the short last page");

        (, , , , uint32 indexedAfter, ) = _epoch().getTransportBatch(h);
        assertEq(indexedAfter, uint32(count), "indexed whole");
        for (uint256 d = 1; d <= count; ++d) {
            (bytes32[] memory page, uint256 total, ) = _epoch().getTransportDayBatches(d, 0, 4);
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
        _epoch().parkTransportBatchRemainder(h);
        AdminFacet(address(diamond)).pause();
        vm.expectRevert(abi.encodeWithSelector(TransportBatchNotReleased.selector, h, h));
        _recon().classifyLegacyPacket(h, 0, 4e18, keccak256("e1"));
        AdminFacet(address(diamond)).unpause();

        _epoch().acknowledgeTransportBatchRemainder(h);
        AdminFacet(address(diamond)).pause();
        _recon().classifyLegacyPacket(h, 0, 4e18, keccak256("e1"));
        AdminFacet(address(diamond)).unpause();

        ( , , , , , bool released) = _epoch().getTransportBatch(h);
        assertTrue(released, "the acknowledgment released it");
    }

    /// A packet holding no epoch passes the gate untouched — the rule is about
    /// value held in a transport epoch, and such a packet holds none.
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

        assertEq(_epoch().parkTransportBatchRemainder(h), 9e18, "parked what the obligations left");

        (, uint256 balance, uint256 admitted, , , ) = _epoch().getTransportBatch(h);
        (uint256 amount, bytes32 dayListHash, uint32 dayCount, bool acknowledged) =
            _epoch().getTransportRemainder(h);
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
        _epoch().parkTransportBatchRemainder(h);

        _epoch().materializeTransportBatchPage(h, dayIds);
        vm.expectRevert(
            abi.encodeWithSelector(TransportBatchNotFullyIndexed.selector, h, uint32(cap), uint32(cap + 2))
        );
        _epoch().parkTransportBatchRemainder(h);

        // Indexed whole, the same call now succeeds — so the refusal was the
        // indexing and nothing else.
        _epoch().materializeTransportBatchPage(h, dayIds);
        assertEq(_epoch().parkTransportBatchRemainder(h), 4e18, "parks once whole");
    }

    /// Each half of the release happens exactly once, and neither can stand in
    /// for the other.
    function test_Release_EachHalfHappensOnce_AndNeitherSubstitutes() public {
        bytes32 h = _untyped(6e18, 2, 11, keccak256("r1"));

        vm.expectRevert(abi.encodeWithSelector(TransportRemainderNotParked.selector, h));
        _epoch().acknowledgeTransportBatchRemainder(h);

        _epoch().parkTransportBatchRemainder(h);
        vm.expectRevert(abi.encodeWithSelector(TransportRemainderAlreadyParked.selector, h));
        _epoch().parkTransportBatchRemainder(h);

        _epoch().acknowledgeTransportBatchRemainder(h);
        vm.expectRevert(abi.encodeWithSelector(TransportRemainderAlreadyAcknowledged.selector, h));
        _epoch().acknowledgeTransportBatchRemainder(h);
    }

    /// The release is PERMISSIONLESS, as the specification says: attesting a
    /// packet's split and releasing its value for classification are both open
    /// to anyone and may happen in either order. What makes a release valid is
    /// state, never the caller.
    function test_Release_IsOpenToAnyone() public {
        bytes32 h = _untyped(6e18, 2, 12, keccak256("perm"));
        address stranger = makeAddr("stranger");

        vm.prank(stranger);
        assertEq(_epoch().parkTransportBatchRemainder(h), 6e18, "anyone may park");
        vm.prank(stranger);
        _epoch().acknowledgeTransportBatchRemainder(h);

        ( , , , , , bool released) = _epoch().getTransportBatch(h);
        assertTrue(released, "and anyone may acknowledge");
    }

    /// Materialization is permissionless too, and for the same reason: the
    /// authority is the delivery's commitment, not the caller.
    function test_Page_IsOpenToAnyone() public {
        uint256[] memory dayIds = _days(3);
        bytes32 h = _deliver(5e18, dayIds, 13, keccak256("perm2"), false);
        vm.prank(makeAddr("stranger2"));
        assertEq(_epoch().materializeTransportBatchPage(h, dayIds), 3, "anyone may index it");
    }

    /// Both operations refuse an id no delivery opened, by name.
    function test_Release_RefusesAnUnknownBatch() public {
        bytes32 nobody = keccak256("nobody");
        vm.expectRevert(abi.encodeWithSelector(TransportBatchUnknown.selector, nobody));
        _epoch().parkTransportBatchRemainder(nobody);
        vm.expectRevert(abi.encodeWithSelector(TransportRemainderNotParked.selector, nobody));
        _epoch().acknowledgeTransportBatchRemainder(nobody);
    }

    /// A classification DEBITS the parked remainder by what it takes, and
    /// cannot take more than the entry still holds. Without the debit the entry
    /// would keep reporting its parked figure while the value had already left,
    /// so the restore and disposition machinery 3b-ii adds would treat
    /// already-classified value as still parked.
    function test_Classification_DebitsTheParkedRemainder_AndIsBoundedByIt() public {
        bytes32 h = _untyped(10e18, 2, 40, keccak256("dbt"));
        _epoch().parkTransportBatchRemainder(h);
        _epoch().acknowledgeTransportBatchRemainder(h);
        (uint256 parked, , , ) = _epoch().getTransportRemainder(h);
        assertEq(parked, 10e18, "the whole balance is parked");

        AdminFacet(address(diamond)).pause();
        _recon().classifyLegacyPacket(h, 0, 4e18, keccak256("d1"));
        AdminFacet(address(diamond)).unpause();
        (parked, , , ) = _epoch().getTransportRemainder(h);
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
        (parked, , , ) = _epoch().getTransportRemainder(h);
        assertEq(parked, 0, "the entry is emptied exactly");
    }

    // ─── 3. the evidence seams ───────────────────────────────────────────────

    /// The transport LEG counters ship with the ledger and read zero: no draw
    /// exists until PR 3b-ii writes one. Asserted so the day they stop being
    /// zero is a deliberate change with a failing test behind it, rather than
    /// a silent one.
    function test_Legs_ReadZeroUntilTheDrawsLand() public {
        bytes32 h = _untyped(10e18, 2, 12, keccak256("l1"));
        (uint256 consumedFresh, uint256 consumedRecycled) = _epoch().getTransportBatchLegs(h);
        assertEq(consumedFresh, 0, "no fresh leg has been drawn");
        assertEq(consumedRecycled, 0, "nor a recycled one");

        _epoch().parkTransportBatchRemainder(h);
        _epoch().acknowledgeTransportBatchRemainder(h);
        (consumedFresh, consumedRecycled) = _epoch().getTransportBatchLegs(h);
        assertEq(consumedFresh, 0, "and releasing draws nothing either");
        assertEq(consumedRecycled, 0, "on either leg");
    }

    // ─── 4. the reads ────────────────────────────────────────────────────────

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
        (bytes32[] memory page, uint256 total, uint256 cursor) = _epoch().getTransportDayBatches(1, 0, 2);
        assertEq(total, 5, "every batch this day ever listed");
        assertEq(page.length, 2, "one window");
        assertEq(cursor, 0, "nothing consumed");

        (bytes32[] memory tail, , ) = _epoch().getTransportDayBatches(1, 4, 10);
        assertEq(tail.length, 1, "a window clamped to the end");

        (bytes32[] memory past, uint256 pastTotal, ) = _epoch().getTransportDayBatches(1, 9, 10);
        assertEq(past.length, 0, "an offset past the end is empty, not a revert");
        assertEq(pastTotal, 5, "and still reports the total");

        // Arrival ORDER is the index's promise.
        (bytes32[] memory all, , ) = _epoch().getTransportDayBatches(1, 0, 10);
        assertEq(all[0], keccak256(abi.encode(uint256(CHAIN_BASE), keccak256(abi.encode("d", uint256(0))))), "first in");
        assertEq(all[4], keccak256(abi.encode(uint256(CHAIN_BASE), keccak256(abi.encode("d", uint256(4))))), "last in");
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
            (, uint256 total, ) = ep.getTransportDayBatches(d, 0, 4);
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
}
