// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {SetupTest} from "../SetupTest.t.sol";
import {VPFIToken} from "../../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../../src/facets/VPFITokenFacet.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {AccessControlFacet} from "../../src/facets/AccessControlFacet.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {RewardClaimFacet} from "../../src/facets/RewardClaimFacet.sol";
import {RewardStagingDomainFacet} from "../../src/facets/RewardStagingDomainFacet.sol";
import {RewardCustodyFacet} from "../../src/facets/RewardCustodyFacet.sol";
import {RewardReconciliationFacet} from "../../src/facets/RewardReconciliationFacet.sol";
import {RewardRemittanceLensFacet} from "../../src/facets/RewardRemittanceLensFacet.sol";
import {RewardRemittanceFacet} from "../../src/facets/RewardRemittanceFacet.sol";
import {RewardEpochFacet} from "../../src/facets/RewardEpochFacet.sol";
import {RewardReporterFacet} from "../../src/facets/RewardReporterFacet.sol";
import {InteractionRewardsFacet} from "../../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../../src/facets/InteractionRewardsLensFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibAccessControl} from "../../src/libraries/LibAccessControl.sol";
import {LibVpfiRecycle} from "../../src/libraries/LibVpfiRecycle.sol";
import {TestMutatorFacet} from "../mocks/TestMutatorFacet.sol";
import {LibD8Delivery} from "../helpers/LibD8Delivery.sol";

/**
 * @title  RewardCustodyInvariant
 * @notice #1566 slice 4 PR B — the two holder invariants the design pins
 *         (§5d: "the sum of attributed rows never exceeds the holder's
 *         balance, and no row goes negative"), plus the two identities the
 *         cutover establishes on an activated CANONICAL deployment: the
 *         recycled row IS the bucket, and the live-fresh row IS the delivered
 *         bound (`received − paid`) — proved against any sequence of the
 *         writers PR B ships: the registered funding writer, claims paid
 *         from the holder (wallet and vault routes), reward absorptions,
 *         non-reward fee inflows, and repatriation surplus debits.
 *
 *         "No row goes negative" is structural in `uint256`; what the
 *         handler proves is that a debit a row cannot cover REVERTS (it is
 *         caught and counted) rather than being floored or paid from another
 *         row — a floor would show up as a broken identity below.
 *
 *         The Diamond's own VPFI balance is the fourth assertion: every
 *         reward flow bypasses it on an activated deployment, so it holds
 *         exactly what the surplus debits released into it (the handler's
 *         chosen destination) and nothing else — funding, claims and
 *         absorptions never touch it.
 */
contract RewardCustodyInvariant is SetupTest {
    VPFIToken internal vpfi;
    RewardCustodyHandler internal handler;
    uint32 internal constant CHAIN_BASE = 8453;

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
        TestMutatorFacet mut = TestMutatorFacet(address(diamond));
        mut.setKnownGlobalDailyInterest(1, 100e18, 0, true);
        mut.setKnownGlobalDailyInterest(2, 100e18, 0, true);
        mut.setDayCapThreshold18(1, type(uint256).max);
        mut.setDayCapThreshold18(2, type(uint256).max);

        vm.chainId(CHAIN_BASE);
        RewardReporterFacet(address(diamond)).setBaseChainId(CHAIN_BASE);
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(true);
        activateRewardCustodyForTest(address(vpfi), 0);

        handler = new RewardCustodyHandler(address(diamond), vpfi, address(this));
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.ADMIN_ROLE, address(handler));
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.PAUSER_ROLE, address(handler));
        // Codex #2206 r3 — `unpause` is UNPAUSER_ROLE's (the asymmetric
        // split); without it every paused action reverted at its own
        // unpause and rolled its mutation back, so the classification
        // invariants below ran on an idle log.
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.UNPAUSER_ROLE, address(handler));

        targetContract(address(handler));
        RewardRemittanceFacet(address(diamond)).setRewardRemittanceReceiver(address(handler));
        bytes4[] memory sel = new bytes4[](9);
        sel[0] = RewardCustodyHandler.fund.selector;
        sel[1] = RewardCustodyHandler.claim.selector;
        sel[2] = RewardCustodyHandler.absorb.selector;
        sel[3] = RewardCustodyHandler.feeInflow.selector;
        sel[4] = RewardCustodyHandler.surplus.selector;
        sel[5] = RewardCustodyHandler.budgetIngress.selector;
        sel[6] = RewardCustodyHandler.classify.selector;
        sel[7] = RewardCustodyHandler.reclassify.selector;
        // #1566 transport epochs PR 3b (Codex #2232 r3) — the RELEASE, or
        // the campaign cannot reach the debit seam at all: classification
        // against an epoch-backed packet is gated on it, so without this
        // action every such call reverts at the gate and the conservation
        // invariant passes over a transition it never performs.
        sel[8] = RewardCustodyHandler.releaseEpoch.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    function _custody() internal view returns (RewardCustodyFacet) {
        return RewardCustodyFacet(address(diamond));
    }

    /// #1566 closure 2 cutover PR 1 — the `Unclassified` row is auditable
    /// like every other: it equals its figure (protected deliveries and
    /// quarantines held), under every interleaving of budget deliveries with
    /// the other flows.
    function invariant_UnclassifiedRowEqualsItsFigure() public view {
        (uint256 uncountedHeld, ) =
            RewardRemittanceLensFacet(address(diamond)).getUnclassifiedPosition();
        assertEq(
            _custody().rewardCustodyRow(LibVaipakam.RewardCustodyRow.Unclassified),
            uncountedHeld,
            "Unclassified row == uncounted held"
        );
    }

    /// The attribution rows never describe more than the holder holds.
    function invariant_AttributedNeverExceedsHeld() public view {
        (, , bool known, uint256 held, uint256 attributed) = _custody().rewardCustodySnapshot();
        assertTrue(known, "holder balance readable");
        assertLe(attributed, held, "attributed <= held");
    }

    /// The recycled row is the bucket, credit for credit and debit for debit.
    function invariant_RecycledRowIsTheBucket() public view {
        assertEq(
            _custody().rewardCustodyRow(LibVaipakam.RewardCustodyRow.Recycled),
            ConfigFacet(address(diamond)).getRecycleBucket(),
            "recycled row == bucket"
        );
    }

    /// The live-fresh row is the delivered bound on a canonical chain with no
    /// deficit: every funding credits both, every fresh outflow debits both.
    function invariant_LiveRowIsTheBound() public view {
        (uint256 received, uint256 paid) = _custody().armedFreshLedger();
        assertGe(received, paid, "no deficit on a funded canonical chain");
        assertEq(
            _custody().rewardCustodyRow(LibVaipakam.RewardCustodyRow.LiveFresh),
            received - paid,
            "live row == received - paid"
        );
    }

    /// #1566 closure 2 cutover PR 2 — every packet's identity holds under
    /// every interleaving of protection, classification, reclassification
    /// and the other flows: `unclassified + classifiedFresh +
    /// classifiedRecycled + disposed + drawn == protectedCumulative` (the
    /// `drawn` exit is 3b-ii-A's; this handler never draws, so the term is
    /// zero here and the draw suite's identity cell is where it is exercised).
    function invariant_PacketIdentityHolds() public view {
        RewardReconciliationFacet recon = RewardReconciliationFacet(address(diamond));
        uint256 n = handler.packets();
        for (uint256 i = 0; i < n; ++i) {
            (, uint256 protectedIn, uint256 unclassified, uint256 cf, uint256 cr, uint256 disposed, , uint256 drawn) =
                recon.getPacketReconciliation(handler.packetAt(i));
            assertEq(unclassified + cf + cr + disposed + drawn, protectedIn, "packet identity");
        }
    }

    /// #1566 transport epochs PR 3b — the LIVENESS check behind the
    /// conservation invariant below: the handler's deliveries must actually
    /// produce transport epochs.
    ///
    /// Deterministic and not an invariant, on purpose. The property it
    /// establishes is "the handler has subjects", and an invariant asserting
    /// that would be flaky. Driving two known seeds by hand proves it once.
    ///
    /// Every budget delivery lands on the d8 wire (#2828) and, on this activated custody, opens an epoch whatever split it
    /// states. The first version of the handler drew the wire from
    /// `fresh != 0`, which made the epoch path all but unreachable while the
    /// conservation invariant passed over an empty set; this pin is what keeps
    /// that from coming back in another form.
    function test_Handler_EveryDeliveryAdmitsAnEpoch() public {
        handler.budgetIngress(2);
        handler.budgetIngress(3);
        assertEq(handler.epochsAdmitted(), 2, "both deliveries landed");
        RewardEpochFacet ep = RewardEpochFacet(address(diamond));
        uint256 n = handler.packets();
        assertEq(n, 2, "two packets recorded");
        for (uint256 i; i < n; ++i) {
            (bytes32 packetHash, , uint256 admitted, , ) = ep.getTransportBatch(handler.packetAt(i));
            assertEq(packetHash, handler.packetAt(i), "each delivery opened its epoch");
            assertGt(admitted, 0, "over the amount that landed");
        }
    }

    /// #1566 transport epochs PR 3b — every TRANSPORT EPOCH conserves under
    /// every interleaving: what a batch was admitted with is always what it
    /// still holds, plus what has been parked out of it, plus EVERY WAY VALUE
    /// HAS LEFT IT. In 3b-i there is exactly one such way — a classification
    /// taking from the released remainder — and the transport legs are pinned
    /// at zero below because no draw exists until 3b-ii, which will turn that
    /// pin into two more terms of this same sum.
    ///
    /// The exits are named rather than netted (Codex #2232 r3). An earlier
    /// revision asserted `balance + parked == admitted`, which is not the
    /// conservation identity — it is the identity BEFORE the first
    /// classification, and false after it: park 10 and classify 4 and the two
    /// sides read 6 and 10. It passed 50,000 calls only because the campaign
    /// could not reach the transition at all (no handler action released a
    /// batch, so every classification against an epoch-backed packet reverted
    /// at the gate). A blind invariant and a false one, and the blindness is
    /// what hid the falsity — which is why `test_Handler_ReleaseAndClassify
    /// ReachesTheDebit` below pins the liveness rather than trusting it.
    ///
    /// Since #2828 the ingress indexes each epoch under its day, so the
    /// handler's claims draw from it and the leg terms are live; before, no
    /// handler action indexed an epoch before its release, and the identity
    /// also asserted the legs were zero.
    ///
    /// It also pins the rule the ingress relies on: on an activated custody a
    /// budget delivery credits no shared ledger, and its whole amount is what
    /// the batch is admitted with, so no component can sit in an epoch as
    /// well as in a ledger it was credited to.
    function invariant_TransportEpochsConserve() public view {
        RewardEpochFacet ep = RewardEpochFacet(address(diamond));
        uint256 n = handler.packets();
        for (uint256 i = 0; i < n; ++i) {
            bytes32 h = handler.packetAt(i);
            (bytes32 packetHash, uint256 balance, uint256 admitted, , ) = ep.getTransportBatch(h);
            if (packetHash == bytes32(0)) continue; // defensive: every handler delivery opens one
            (, uint256 parked, , , uint256 debited) = ep.getTransportRemainder(h);
            (uint256 legFresh, uint256 legRecycled) = ep.getTransportBatchLegs(h);
            // 3b-ii-A2 (#2305) — the identity gains the staged terms.
            (uint256 stagedFresh, uint256 stagedRecycled, ) = ep.getTransportBatchStaged(h);
            assertEq(
                balance + parked + debited + legFresh + legRecycled + stagedFresh + stagedRecycled,
                admitted,
                "transport epoch conserves"
            );
        }
    }

    /// #1566 transport epochs 3b-ii-A — the day's ordered list holds every
    /// member the handler indexed, in (arrival, batch id) order: the node
    /// pages walk exactly as many as the day has ever listed, each ordered
    /// after the last — except that the order may restart right after the
    /// cursor, where a late epoch older than the passed prefix takes the first
    /// place of the window (Codex #2276 r11). The handler's deliveries all
    /// list day 1.
    ///
    /// There is no longer a "how much is linked" figure to compare (Codex
    /// #2296 items 2 and 4): every member is linked as it is pushed, so the
    /// count the walk reaches IS the membership, and this walk is what proves
    /// it rather than a flag the ledger sets about itself.
    function invariant_DayIndexIsLinkedAndOrdered() public view {
        RewardEpochFacet ep = RewardEpochFacet(address(diamond));
        (uint256 total, bytes32 cursorNode) = ep.getTransportDayIndex(1);
        bytes32 from;
        uint256 seen;
        uint64 lastAt;
        bytes32 last;
        while (true) {
            (bytes32[] memory page, uint64[] memory at, bytes32 next) = ep.getTransportDayBatchesFrom(1, from, 16);
            for (uint256 i = 0; i < page.length; ++i) {
                if (last != bytes32(0) && last == cursorNode) {
                    lastAt = 0;
                    last = bytes32(0);
                }
                assertTrue(at[i] > lastAt || (at[i] == lastAt && page[i] > last), "in (arrival, batch id) order");
                lastAt = at[i];
                last = page[i];
                ++seen;
            }
            if (page.length == 0 || next == bytes32(0)) break;
            from = next;
        }
        assertEq(seen, total, "and no more");
    }

    /// #1566 closure 2 cutover PR 2 (Codex #2206 r4) — the recorded spent
    /// and released figures fall only by a correction (which moves them
    /// with the units it moves): after any other action each is at least
    /// what it read at that action's start — a credit, a refill, a payout
    /// never lowers what the outflows already took.
    function invariant_SpentFiguresFallOnlyByACorrection() public view {
        if (handler.lastActionWasCorrection()) return;
        RewardReconciliationFacet recon = RewardReconciliationFacet(address(diamond));
        (, , uint256 freshSpent, , , , , , uint256 released, ) = recon.getFreshQueueState(0);
        (, , uint256 recycledSpent, , , ) = recon.getRecycledQueueState();
        assertGe(freshSpent, handler.freshSpentAtActionStart(), "the fresh spent figure never falls");
        assertGe(recycledSpent, handler.recycledSpentAtActionStart(), "the recycled spent figure never falls");
        assertGe(released, handler.freshReleasedAtActionStart(), "the released figure never falls");
    }

    /// #1566 closure 2 cutover PR 2 (Codex #2206 r4) — each queue's unspent
    /// part is what its row holds of it: `paid ≤ spent ≤ queued + released`
    /// and the live row backs the rest; `consumed ≤ spent ≤ queued` and the
    /// recycled row backs the rest; `released ≤ absorbed` and the
    /// restitution row holds the rest. The record and the pool never
    /// disagree, under every interleaving.
    function invariant_UnspentQueuesAreBacked() public view {
        RewardReconciliationFacet recon = RewardReconciliationFacet(address(diamond));
        (, uint256 freshUnspent, uint256 freshSpent, uint256 freshPaid, , uint256 liveRow, , uint256 unreleased, , uint256 restitutionRow) =
            recon.getFreshQueueState(0);
        (, uint256 recycledUnspent, uint256 recycledSpent, uint256 consumed, , ) = recon.getRecycledQueueState();
        assertLe(freshPaid, freshSpent, "paid <= spent");
        assertLe(freshUnspent, liveRow, "the live row backs the unspent fresh queue");
        assertLe(consumed, recycledSpent, "consumed <= spent");
        assertLe(
            recycledUnspent,
            _custody().rewardCustodyRow(LibVaipakam.RewardCustodyRow.Recycled),
            "the recycled row backs the unspent recycled queue"
        );
        assertLe(unreleased, restitutionRow, "restitution holds the unreleased records");
    }

    /// #1566 closure 2 cutover PR 2 (Codex #2206 r2–r6) — the queues equal
    /// the log: with no take pending, every figure the queues report is the
    /// sum of the entries' own records (with takes pending, the records lag
    /// by no more than what is pending); every entry before a frontier is
    /// exhausted; and an entry's credit on a side is its record.
    function invariant_QueuesMatchTheLog() public view {
        _freshQueueMatchesTheLog();
        _recycledQueueMatchesTheLog();
        _absorbedRecordsMatchTheLog();
    }

    function _freshQueueMatchesTheLog() internal view {
        RewardReconciliationFacet recon = RewardReconciliationFacet(address(diamond));
        (uint256 entries, , ) = recon.getReconciliationTotals();
        (uint256 frontier, uint256 unspent, uint256 spent, uint256 paid, uint256 pending, , , , , ) =
            recon.getFreshQueueState(0);
        uint256 sumUnspent;
        uint256 sumSpent;
        uint256 sumPaid;
        for (uint256 i = 0; i < entries; ++i) {
            RewardReconciliationFacet.Spent memory sp = recon.getReconciliationEntrySpent(i);
            sumUnspent += sp.freshUnspent;
            sumSpent += sp.freshSpent;
            sumPaid += sp.freshInheritable;
            if (i < frontier) assertEq(sp.freshUnspent, 0, "every entry before the fresh frontier is exhausted");
        }
        if (pending == 0) {
            assertEq(sumUnspent, unspent, "fresh unspent == sum of records");
            assertEq(sumSpent, spent, "fresh spent == sum of records");
            assertEq(sumPaid, paid, "fresh paid == sum of records");
        } else {
            assertLe(sumSpent, spent, "records lag the spent total");
            assertLe(spent - sumSpent, pending, "by no more than the pending takes");
        }
        assertLe(frontier, entries, "frontier within the log");
    }

    function _recycledQueueMatchesTheLog() internal view {
        RewardReconciliationFacet recon = RewardReconciliationFacet(address(diamond));
        (uint256 entries, , ) = recon.getReconciliationTotals();
        (uint256 frontier, uint256 unspent, uint256 spent, uint256 consumed, uint256 pending, ) =
            recon.getRecycledQueueState();
        uint256 sumUnspent;
        uint256 sumSpent;
        uint256 sumConsumed;
        for (uint256 i = 0; i < entries; ++i) {
            RewardReconciliationFacet.Spent memory sp = recon.getReconciliationEntrySpent(i);
            sumUnspent += sp.recycledUnspent;
            sumSpent += sp.recycledSpent;
            sumConsumed += sp.recycledInheritable;
            assertEq(
                sp.recycledUnspent + sp.recycledSpent,
                recon.getReconciliationEntry(i).recycledCredit,
                "an entry's recycled credit is its record"
            );
            if (i < frontier) assertEq(sp.recycledUnspent, 0, "every entry before the recycled frontier is exhausted");
        }
        if (pending == 0) {
            assertEq(sumUnspent, unspent, "recycled unspent == sum of records");
            assertEq(sumSpent, spent, "recycled spent == sum of records");
            assertEq(sumConsumed, consumed, "recycled consumed == sum of records");
        } else {
            assertLe(sumSpent, spent, "records lag the spent total");
            assertLe(spent - sumSpent, pending, "by no more than the pending takes");
        }
        assertLe(frontier, entries, "frontier within the log");
    }

    function _absorbedRecordsMatchTheLog() internal view {
        RewardReconciliationFacet recon = RewardReconciliationFacet(address(diamond));
        (uint256 entries, , ) = recon.getReconciliationTotals();
        (, , , , uint256 pending, , uint256 frontier, uint256 unreleased, , ) = recon.getFreshQueueState(0);
        uint256 sumHeld;
        for (uint256 i = 0; i < entries; ++i) {
            RewardReconciliationFacet.Spent memory sp = recon.getReconciliationEntrySpent(i);
            sumHeld += sp.freshAbsorbed;
            assertEq(
                sp.freshUnspent + sp.freshSpent + sp.freshAbsorbed,
                recon.getReconciliationEntry(i).freshCredit,
                "an entry's fresh credit is its fresh record plus what the row still holds absorbed"
            );
            if (i < frontier) assertEq(sp.freshAbsorbed, 0, "every entry before the absorbed frontier is released");
        }
        if (pending == 0) assertEq(sumHeld, unreleased, "absorbed still held == sum of records");
        assertLe(frontier, entries, "frontier within the log");
    }


    /// #1566 transport epochs PR 3b (Codex #2232 r3) — the handler can REACH
    /// the released-epoch debit, and the conservation identity holds ACROSS
    /// it.
    ///
    /// This is the liveness half of `invariant_TransportEpochsConserve`, and
    /// it exists because that invariant previously reported success over a
    /// transition the campaign could not perform: no action released a batch,
    /// so every classification against an epoch-backed packet reverted at the
    /// gate and the debit seam was never touched in 50,000 calls. A count of
    /// calls says nothing about which code they reached, so the reach is
    /// asserted here rather than assumed there.
    ///
    /// It also pins the arithmetic the old assertion got wrong: after a
    /// classification, `balance + parked` is SHORT of `admitted` by exactly
    /// what left, and it is `debited` that closes it.
    function test_Handler_ReleaseAndClassifyReachesTheDebit() public {
        handler.budgetIngress(2);
        bytes32 h = handler.packetAt(0);
        RewardEpochFacet ep = RewardEpochFacet(address(diamond));

        handler.releaseEpoch(0);
        assertGt(handler.released(), 0, "the handler released an epoch");
        (, , , bool acknowledged, ) = ep.getTransportRemainder(h);
        assertTrue(acknowledged, "and the acknowledgment is recorded");

        for (uint256 seed = 1; seed <= 32 && handler.classified() == 0; ++seed) {
            handler.classify(seed);
        }
        assertGt(handler.classified(), 0, "a classification was applied against the released epoch");

        (, uint256 balance, uint256 admitted, , ) = ep.getTransportBatch(h);
        (, uint256 parked, , , uint256 debited) = ep.getTransportRemainder(h);
        assertGt(debited, 0, "and it DEBITED the remainder - the seam is reached");
        assertLt(balance + parked, admitted, "which the old two-term identity would have called a loss");
        assertEq(balance + parked + debited, admitted, "the epoch conserves with the exit named");
    }

    /// Codex #2206 r3 — the handler's classification actions PERSIST (it
    /// unpauses with the role that can): driven directly, the log grows, so
    /// the packet and queue invariants above are exercised on real state
    /// rather than on rolled-back calls.
    function test_HandlerClassificationActionsPersist() public {
        RewardReconciliationFacet recon = RewardReconciliationFacet(address(diamond));
        handler.budgetIngress(7);
        bytes32 h = handler.packetAt(0);
        // Classification of an epoch-backed packet is gated on its release.
        handler.releaseEpoch(0);
        (, , uint256 remainder, , , , , ) = recon.getPacketReconciliation(h);
        // The whole remainder evidenced on both sides, so whichever way the
        // handler splits its entry, one direction of a later correction is
        // always open.
        TestMutatorFacet(address(diamond)).setPacketAttestedCapsRaw(h, remainder, remainder);
        for (uint256 seed = 1; seed <= 16 && handler.classified() == 0; ++seed) {
            handler.classify(seed);
        }
        assertGt(handler.classified(), 0, "a classification was applied");
        (uint256 entries, , ) = recon.getReconciliationTotals();
        assertEq(entries, 1, "the log grew");
        for (uint256 seed = 1; seed <= 64 && handler.reclassified() == 0; ++seed) {
            handler.reclassify(seed);
        }
        assertGt(handler.reclassified(), 0, "a reclassification was applied");
    }

    /// Reward flows never touch the Diamond's own balance: it holds exactly
    /// what the surplus debits released into it.
    function invariant_DiamondBalanceHoldsOnlyWhatSurplusReleasedIntoIt() public view {
        assertEq(vpfi.balanceOf(address(diamond)), handler.surplusReleased(), "diamond balance == surplus released");
    }

    /// After the campaign: the handler paid at least one claim from the
    /// holder AND saw at least one refusal, so the four invariants above were
    /// exercised on both sides of the gates they bound rather than on an
    /// idle Diamond. (An `invariant_` function also runs before the first
    /// call, so this cannot be one of them.)
    function afterInvariant() public view {
        assertGt(handler.calls(), 0, "the handler ran");
        assertGt(handler.payouts(), 0, "at least one claim was paid from the holder");
        assertGt(handler.refusals(), 0, "at least one refusal was exercised");
    }
}

contract RewardCustodyHandler is Test {
    address internal immutable diamond;
    VPFIToken internal immutable vpfi;
    /// @dev The VPFI minter (the suite contract); the handler mints under
    ///      its identity.
    address internal immutable minter;
    uint256 public calls;
    uint256 public nextRemit;
    uint256 public refusals;
    uint256 public payouts;
    uint256 public surplusReleased;
    uint64 internal nextLoan = 1;
    /// @dev #1566 closure 2 cutover PR 2 — the packets this handler
    ///      landed (zero transport id → the per-source sequence stamps them,
    ///      and this handler is the only source-8453 ingress), the recorded
    ///      spent/released figures at the start of the current action and
    ///      whether that action was a correction (the fall-only-by-a-
    ///      correction invariant's baseline), and how many classification
    ///      actions were APPLIED (Codex #2206 r3: the liveness the campaign
    ///      is checked against).
    /// @dev #1566 transport epochs PR 3b — how many deliveries this handler
    ///      landed, each of which opens a transport epoch. Read by the liveness
    ///      test: an invariant over transport epochs proves nothing if the
    ///      handler never produces one.
    uint256 public epochsAdmitted;
    /// @dev #1566 transport epochs PR 3b (Codex #2232 r3) — how many epochs
    ///      this handler has RELEASED (parked and acknowledged). Same reason as
    ///      the counter above, and the sharpest of the three: the release
    ///      is what a classification against an epoch-backed packet is gated
    ///      on, so with this at zero the whole debit seam is unreachable and
    ///      every invariant over it passes vacuously.
    uint256 public released;
    bytes32[] internal packetHashes;
    uint256 internal seqStamped;
    uint256 public freshSpentAtActionStart;
    uint256 public recycledSpentAtActionStart;
    uint256 public freshReleasedAtActionStart;
    bool public lastActionWasCorrection;
    uint256 public classified;
    uint256 public reclassified;

    constructor(address diamond_, VPFIToken vpfi_, address minter_) {
        diamond = diamond_;
        vpfi = vpfi_;
        minter = minter_;
    }

    function _mint(address to, uint256 amount) internal {
        vm.prank(minter);
        vpfi.mint(to, amount);
    }

    function packets() external view returns (uint256) {
        return packetHashes.length;
    }

    function packetAt(uint256 i) external view returns (bytes32) {
        return packetHashes[i];
    }

    function _start() internal {
        calls++;
        RewardReconciliationFacet recon = RewardReconciliationFacet(diamond);
        (, , uint256 freshSpent, , , , , , uint256 released, ) = recon.getFreshQueueState(0);
        (, , uint256 recycledSpent, , , ) = recon.getRecycledQueueState();
        freshSpentAtActionStart = freshSpent;
        recycledSpentAtActionStart = recycledSpent;
        freshReleasedAtActionStart = released;
        lastActionWasCorrection = false;
    }

    function fund(uint256 seed) external {
        _start();
        uint256 amount = bound(seed, 1, 50_000e18);
        _mint(address(this), amount);
        vpfi.approve(diamond, amount);
        try RewardCustodyFacet(diamond).fundRewardPool(amount) {} catch { refusals++; }
    }

    /// A fresh claimant with one payable entry; the claim is paid from the
    /// holder or refused for want of backing — never from the Diamond.
    function claim(uint256 seed) external {
        _start();
        address user = address(uint160(uint256(keccak256(abi.encode("claimant", seed)))));
        TestMutatorFacet mut = TestMutatorFacet(diamond);
        uint256 id = mut.pushRewardEntry(user, nextLoan++, LibVaipakam.RewardSide.Lender, 100e18, 1);
        mut.closeRewardEntryRaw(id, 3);
        // An entry listed by an admitted batch defers its first claim
        // while its legacy-slice domain is driven (A2-ii (c)); drive it home with
        // the facet's permissionless step, then claim again, as a keeper would.
        bool paidOut;
        vm.prank(user);
        try RewardClaimFacet(diamond).claimInteractionRewards() returns (uint256 paid, uint256, uint256) {
            paidOut = paid != 0;
        } catch {
            refusals++;
        }
        if (!paidOut) {
            for (uint256 i; i < 16; ++i) {
                try RewardStagingDomainFacet(diamond).stepLegacySlice(id) returns (bool consumed) {
                    if (consumed) break;
                } catch {
                    break;
                }
            }
            vm.prank(user);
            try RewardClaimFacet(diamond).claimInteractionRewards() returns (uint256 paid, uint256, uint256) {
                paidOut = paid != 0;
            } catch {
                refusals++;
            }
        }
        if (paidOut) payouts++;
    }

    /// A reward absorption: live-fresh → recycled, in-holder.
    function absorb(uint256 seed) external {
        _start();
        uint256 live = RewardCustodyFacet(diamond).rewardCustodyRow(LibVaipakam.RewardCustodyRow.LiveFresh);
        uint256 amount = bound(seed, 1, live + 1e18); // may exceed the row: must refuse, never floor
        try TestMutatorFacet(diamond).creditRecycleRaw(LibVpfiRecycle.RecycleSource.ForfeitedReward, 0, amount) {} catch {
            refusals++;
        }
    }

    /// A user fee pulled into the Diamond, then relocated into the holder.
    function feeInflow(uint256 seed) external {
        _start();
        uint256 amount = bound(seed, 1, 1_000e18);
        uint256 before = vpfi.balanceOf(diamond);
        _mint(diamond, amount);
        TestMutatorFacet(diamond).creditInflowRawWithBefore(LibVpfiRecycle.RecycleSource.NotificationFee, 1, amount, before);
    }

    /// A budget delivery on the d8 wire, as the receiver presents it
    /// (the handler is the registered receiver): the tokens are forwarded to
    /// the Diamond first, then the ingress protects the WHOLE amount into the
    /// `Unclassified` row and opens a transport epoch over it. On an activated
    /// custody a budget delivery credits no live row; the split the wire
    /// states (drawn here, and whole, as the ingress requires) is recorded as
    /// the packet's attestation. So every delivery is a subject of the
    /// conservation invariant.
    function budgetIngress(uint256 seed) external {
        _start();
        uint256 amount = bound(seed, 2, 10_000e18);
        uint256 fresh = bound(uint256(keccak256(abi.encode(seed, "fresh"))), 0, amount);
        _mint(diamond, amount);
        // Through an external self-call, so a refusal is counted rather than
        // reverting the handler: the ingress call itself is built by the
        // shared test-side delivery library.
        try this.deliverD8(amount, fresh, ++nextRemit) {
            ++epochsAdmitted;
            packetHashes.push(keccak256(abi.encode(uint256(8453), ++seqStamped, "seq")));
        } catch {
            refusals++;
        }
    }

    /// A whole-split d8 delivery of `amount` on the handler's one day, from
    /// Base, with no transport id (the per-source sequence stamps it), in the
    /// live era. Self-call only: {budgetIngress} wraps it in a `try`.
    function deliverD8(uint256 amount, uint256 fresh, uint256 remitId) external {
        require(msg.sender == address(this), "self only");
        LibD8Delivery.deliver(
            diamond,
            LibD8Delivery.Delivery({
                token: address(vpfi),
                amount: amount,
                dayId: 1,
                sourceChainId: 8453,
                remitId: remitId,
                remitter: address(0xBA5E),
                recycled: amount - fresh,
                fresh: fresh,
                messageId: bytes32(0),
                era: 0
            })
        );
    }

    /// #1566 closure 2 cutover PR 2 — classify a random share of a random
    /// landed packet's remainder, under the pause. The packet's evidence
    /// (its authenticated fresh figure) is written once per packet, at
    /// random within what it put in, the way the transport attestation
    /// would; the fresh share stays within it, the recycled share within
    /// the remainder.
    function classify(uint256 seed) external {
        _start();
        if (packetHashes.length == 0) return;
        bytes32 h = packetHashes[seed % packetHashes.length];
        RewardReconciliationFacet recon = RewardReconciliationFacet(diamond);
        (, , uint256 remainder, uint256 cf, uint256 cr, , uint256 authenticated, ) = recon.getPacketReconciliation(h);
        if (remainder == 0) return;
        if (authenticated == 0) {
            authenticated = bound(uint256(keccak256(abi.encode(seed, "evidence"))), 0, remainder + cf + cr);
            TestMutatorFacet(diamond).setPacketFreshAuthenticatedRaw(h, authenticated);
        }
        uint256 freshRoom = authenticated > cf ? authenticated - cf : 0;
        if (freshRoom > remainder) freshRoom = remainder;
        uint256 fresh = bound(uint256(keccak256(abi.encode(seed, "f"))), 0, freshRoom);
        uint256 recycled = bound(uint256(keccak256(abi.encode(seed, "r"))), 0, remainder - fresh);
        if (fresh + recycled == 0) return;
        AdminFacet(diamond).pause();
        try recon.classifyLegacyPacket(h, fresh, recycled, keccak256(abi.encode("entry", calls))) {
            classified++;
        } catch {
            refusals++;
        }
        AdminFacet(diamond).unpause();
    }

    /// #1566 transport epochs PR 3b (Codex #2232 r3) — RELEASE a random
    /// landed packet's epoch: park what its obligations left, and record the
    /// acknowledgment.
    ///
    /// Without this the campaign could not reach `takeFromReleasedRemainder`
    /// AT ALL. Classification against an epoch-backed packet is gated on the
    /// release, no other action performed one, so every such call reverted at
    /// the gate and landed in `refusals` — the new debit seam was untouched by
    /// 50,000 calls while the conservation invariant reported success over it.
    /// That is the failure mode an invariant campaign is least able to
    /// announce, so `released` is counted and asserted on, the way
    /// `epochsAdmitted` already is.
    ///
    /// Each step is attempted independently rather than guarded up front: the
    /// steps are reachable in different states (a batch may already be
    /// parked, already acknowledged by an earlier draw of
    /// this action), and refusing the whole action on any of them would make
    /// the reachable interleavings a function of draw order.
    function releaseEpoch(uint256 seed) external {
        _start();
        if (packetHashes.length == 0) return;
        bytes32 h = packetHashes[seed % packetHashes.length];
        RewardEpochFacet ep = RewardEpochFacet(diamond);
        (bytes32 packetHash, , , , ) = ep.getTransportBatch(h);
        if (packetHash == bytes32(0)) return; // defensive: every handler delivery opens one
        // #2828 — the ingress indexed the epoch under its one day when it
        // landed, so there is no membership step left before the release.
        // #2258 — the production release refuses everyone in 3b-i, so the
        // handler reaches the release (and the debit seam the conservation
        // invariant exists for) through the test-only raw entry.
        try TestMutatorFacet(diamond).releaseTransportBatchRaw(h) {
            released++;
        } catch {
            refusals++;
        }
    }

    /// #1566 closure 2 cutover PR 2 — move a random amount between the sides
    /// of a random entry, either direction, under the pause.
    function reclassify(uint256 seed) external {
        _start();
        lastActionWasCorrection = true;
        RewardReconciliationFacet recon = RewardReconciliationFacet(diamond);
        (uint256 entries, , ) = recon.getReconciliationTotals();
        if (entries == 0) return;
        uint256 index = seed % entries;
        bool freshToRecycled = uint256(keccak256(abi.encode(seed, "dir"))) % 2 == 0;
        LibVaipakam.ReconciliationEntry memory e = recon.getReconciliationEntry(index);
        uint256 credit = freshToRecycled ? e.freshCredit : e.recycledCredit;
        if (credit == 0) return;
        uint256 amount = bound(uint256(keccak256(abi.encode(seed, "amt"))), 1, credit);
        AdminFacet(diamond).pause();
        try recon.reclassifyReconciliationEntry(index, freshToRecycled, amount, keccak256(abi.encode("re", calls))) {
            reclassified++;
        } catch {
            refusals++;
        }
        AdminFacet(diamond).unpause();
    }


    /// A repatriation surplus debit, released into the Diamond (the raw
    /// mutator's destination); beyond the fundable slice it must refuse.
    function surplus(uint256 seed) external {
        _start();
        uint256 bucket = ConfigFacet(diamond).getRecycleBucket();
        uint256 amount = bound(seed, 1, bucket + 1e18);
        try TestMutatorFacet(diamond).debitRepatriationSurplusRaw(amount) {
            surplusReleased += amount;
        } catch {
            refusals++;
        }
    }
}
