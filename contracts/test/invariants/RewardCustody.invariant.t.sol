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
import {RewardCustodyFacet} from "../../src/facets/RewardCustodyFacet.sol";
import {RewardReconciliationFacet} from "../../src/facets/RewardReconciliationFacet.sol";
import {RewardRemittanceLensFacet} from "../../src/facets/RewardRemittanceLensFacet.sol";
import {RewardRemittanceFacet} from "../../src/facets/RewardRemittanceFacet.sol";
import {RewardIngressFacet} from "../../src/facets/RewardIngressFacet.sol";
import {RewardEpochFacet} from "../../src/facets/RewardEpochFacet.sol";
import {RewardReporterFacet} from "../../src/facets/RewardReporterFacet.sol";
import {InteractionRewardsFacet} from "../../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../../src/facets/InteractionRewardsLensFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibAccessControl} from "../../src/libraries/LibAccessControl.sol";
import {LibVpfiRecycle} from "../../src/libraries/LibVpfiRecycle.sol";
import {TestMutatorFacet} from "../mocks/TestMutatorFacet.sol";

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
        bytes4[] memory sel = new bytes4[](10);
        sel[0] = RewardCustodyHandler.fund.selector;
        sel[1] = RewardCustodyHandler.claim.selector;
        sel[2] = RewardCustodyHandler.absorb.selector;
        sel[3] = RewardCustodyHandler.feeInflow.selector;
        sel[4] = RewardCustodyHandler.surplus.selector;
        sel[5] = RewardCustodyHandler.untypedIngress.selector;
        sel[6] = RewardCustodyHandler.classify.selector;
        sel[7] = RewardCustodyHandler.reclassify.selector;
        // #1566 transport epochs PR 3b (Codex #2232 r3) — the ROLLOUT
        // admission is a SECOND way an epoch comes into existence, so the
        // conservation invariant above must see epochs opened that way too.
        sel[8] = RewardCustodyHandler.rolloutAdmit.selector;
        // #1566 transport epochs PR 3b (Codex #2232 r3) — and the RELEASE, or
        // the campaign cannot reach the debit seam at all: classification
        // against an epoch-backed packet is gated on it, so without this
        // action every such call reverts at the gate and the conservation
        // invariant passes over a transition it never performs.
        sel[9] = RewardCustodyHandler.releaseEpoch.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    function _custody() internal view returns (RewardCustodyFacet) {
        return RewardCustodyFacet(address(diamond));
    }

    /// #1566 closure 2 cutover PR 1 — the `Unclassified` row is auditable
    /// like every other: it equals its two figures (untyped remainders and
    /// quarantines held, pre-attribution returns held), under every
    /// interleaving of untyped deliveries with the other flows.
    function invariant_UnclassifiedRowEqualsItsFigures() public view {
        (uint256 uncountedHeld, uint256 returnedHeld, ) =
            RewardRemittanceLensFacet(address(diamond)).getUnclassifiedPosition();
        assertEq(
            _custody().rewardCustodyRow(LibVaipakam.RewardCustodyRow.Unclassified),
            uncountedHeld + returnedHeld,
            "Unclassified row == uncounted held + returned held"
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
    /// conservation invariant below: an even seed must actually produce a
    /// transport epoch.
    ///
    /// Deterministic and not an invariant, on purpose. The property it
    /// establishes is "the handler has subjects", and an invariant asserting
    /// that would be flaky — a run whose draws happened to be all odd would
    /// fail on nothing being wrong. Driving one known-even seed by hand proves
    /// it once, for good.
    ///
    /// This exists because the first version of the handler derived the wire
    /// from `fresh != 0`, where `fresh` is bounded over `[0, amount]` and is
    /// therefore zero about one time in 10^19. The conservation invariant
    /// passed over an empty set.
    function test_Handler_UntypedDrawAdmitsAnEpoch() public {
        handler.untypedIngress(2); // even: the untyped wire
        assertEq(handler.untypedAdmitted(), 1, "the untyped path was taken");
        RewardEpochFacet ep = RewardEpochFacet(address(diamond));
        uint256 n = handler.packets();
        assertGt(n, 0, "the delivery landed");
        uint256 withEpoch;
        for (uint256 i; i < n; ++i) {
            (bytes32 packetHash, , , , , ) = ep.getTransportBatch(handler.packetAt(i));
            if (packetHash != bytes32(0)) ++withEpoch;
        }
        assertGt(withEpoch, 0, "an untyped delivery opens an epoch for the invariant to check");

        // And the odd draw takes the other path, so the parity means what the
        // handler says it means.
        handler.untypedIngress(3); // odd: a stated composition
        assertEq(handler.untypedAdmitted(), 1, "the typed path added no untyped delivery");
    }

    /// #1566 transport epochs PR 3b (Codex #2232 r3) — the same coverage pin
    /// for the SECOND way an epoch comes into existence. The rollout action is
    /// guarded (a typed delivery has no epoch to redo, a parked one is skipped),
    /// so without this the guards could silently swallow every draw and the
    /// conservation invariant would again pass over a path it never reached.
    function test_Handler_RolloutAdmitOpensAnEpoch() public {
        handler.untypedIngress(2); // even: the untyped wire, so an epoch exists
        assertEq(handler.rolloutAdmitted(), 0, "nothing has gone through the rollout yet");
        handler.rolloutAdmit(0);
        assertEq(handler.rolloutAdmitted(), 1, "the rollout admission opened one");

        RewardEpochFacet ep = RewardEpochFacet(address(diamond));
        (bytes32 packetHash, uint256 balance, uint256 admitted, , , ) =
            ep.getTransportBatch(handler.packetAt(0));
        assertEq(packetHash, handler.packetAt(0), "and the epoch is back");
        assertEq(balance, admitted, "conserving, with nothing parked");
        assertGt(admitted, 0, "over a real balance read from the packet");
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
    /// It also pins the rule the ingress relies on: a batch is admitted with
    /// the UNTYPED REMAINDER, so a delivery that stated a component can never
    /// have that component in an epoch as well as in the shared ledger it was
    /// credited to.
    function invariant_TransportEpochsConserve() public view {
        RewardEpochFacet ep = RewardEpochFacet(address(diamond));
        uint256 n = handler.packets();
        for (uint256 i = 0; i < n; ++i) {
            bytes32 h = handler.packetAt(i);
            (bytes32 packetHash, uint256 balance, uint256 admitted, , , ) = ep.getTransportBatch(h);
            if (packetHash == bytes32(0)) continue; // a typed delivery holds no epoch
            (uint256 parked, , , , uint256 debited) = ep.getTransportRemainder(h);
            (uint256 legFresh, uint256 legRecycled, uint256 beyond) = ep.getTransportBatchLegs(h);
            // 3b-ii-A2 (#2305) — the identity gains the staged terms.
            (uint256 stagedFresh, uint256 stagedRecycled, ) = ep.getTransportBatchStaged(h);
            assertEq(
                balance + parked + debited + legFresh + legRecycled + beyond + stagedFresh + stagedRecycled,
                admitted,
                "transport epoch conserves"
            );
            assertEq(legFresh + legRecycled, 0, "no draw exists until PR 3b-ii");
        }
    }

    /// #1566 transport epochs 3b-ii-A (Codex #2276 r8) — the day's ordered
    /// list holds every member the handler indexed, in (arrival, batch id)
    /// order: the linked count equals the membership, and the node pages walk
    /// exactly that many, each ordered after the last — except that the
    /// order may restart right after the cursor, where a late epoch older
    /// than the passed prefix takes the first place of the window (r11). The
    /// handler's untyped deliveries all list day 1.
    function invariant_DayIndexIsLinkedAndOrdered() public view {
        RewardEpochFacet ep = RewardEpochFacet(address(diamond));
        (uint256 linked, uint256 total, bytes32 cursorNode, ) = ep.getTransportDayIndex(1);
        assertEq(linked, total, "every member is linked");
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
        handler.untypedIngress(2); // even: the untyped wire, so an epoch exists
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

        (, uint256 balance, uint256 admitted, , , ) = ep.getTransportBatch(h);
        (uint256 parked, , , , uint256 debited) = ep.getTransportRemainder(h);
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
        handler.untypedIngress(7);
        bytes32 h = handler.packetAt(0);
        (, , uint256 remainder, , , , , ) = recon.getPacketReconciliation(h);
        // The whole remainder evidenced, so whichever way the handler splits
        // its entry, one direction of a later correction is always open.
        TestMutatorFacet(address(diamond)).setPacketFreshAuthenticatedRaw(h, remainder);
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
    /// @dev #1566 closure 2 cutover PR 2 — the untyped packets this handler
    ///      landed (zero transport id → the per-source sequence stamps them,
    ///      and this handler is the only source-8453 ingress), the recorded
    ///      spent/released figures at the start of the current action and
    ///      whether that action was a correction (the fall-only-by-a-
    ///      correction invariant's baseline), and how many classification
    ///      actions were APPLIED (Codex #2206 r3: the liveness the campaign
    ///      is checked against).
    /// @dev #1566 transport epochs PR 3b — how many UNTYPED deliveries this
    ///      handler has attempted. Read by the liveness test below: an
    ///      invariant over transport epochs proves nothing if the handler never
    ///      produces one.
    uint256 public untypedAdmitted;
    /// @dev #1566 transport epochs PR 3b (Codex #2232 r3) — how many epochs
    ///      were opened through the ROLLOUT admission rather than at ingress.
    ///      Same reason as the counter above: an invariant over epochs opened
    ///      a second way proves nothing if the handler never opens one.
    uint256 public rolloutAdmitted;
    /// @dev #1566 transport epochs PR 3b (Codex #2232 r3) — how many epochs
    ///      this handler has RELEASED (parked and acknowledged). Same reason as
    ///      the two counters above, and the sharpest of the three: the release
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
        vm.prank(user);
        try RewardClaimFacet(diamond).claimInteractionRewards() returns (uint256 paid, uint256, uint256) {
            if (paid != 0) payouts++;
        } catch {
            refusals++;
        }
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

    /// A delivery whose remainder is UNTYPED, as the receiver presents it
    /// (the handler is the registered receiver): the tokens are forwarded to
    /// the Diamond first, the fresh share is credited live, the remainder is
    /// protected into the `Unclassified` row — nothing of it stays in the
    /// Diamond.
    ///
    /// #1566 transport epochs PR 3b — the draw decides the WIRE too, not only
    /// the composition: a zero fresh share is what an untyped wire delivers,
    /// and such a delivery opens a transport epoch whose conservation the
    /// invariants below then cover.
    function untypedIngress(uint256 seed) external {
        _start();
        uint256 amount = bound(seed, 2, 10_000e18);
        // #1566 transport epochs PR 3b — the WIRE is its own draw, on the raw
        // seed's parity, so both accounting paths are reached about half the
        // time each.
        //
        // Deriving it from the fresh component instead (`fresh != 0`) looked
        // equivalent and was not: `fresh` is bounded over `[0, amount]`, so it
        // is zero with probability about 1/amount — effectively never. The
        // untyped path, and with it every transport epoch the conservation
        // invariant checks, would have had no subjects at all while the
        // invariant passed. `test_Handler_UntypedDrawAdmitsAnEpoch` pins the
        // parity so this cannot quietly regress to a path nothing exercises.
        bool splitTyped = seed % 2 == 1;
        uint256 fresh = splitTyped
            ? bound(uint256(keccak256(abi.encode(seed, "fresh"))), 0, amount)
            : 0;
        if (!splitTyped) ++untypedAdmitted;
        _mint(diamond, amount);
        uint256[] memory days_ = new uint256[](1);
        days_[0] = 1;
        try RewardIngressFacet(diamond).onRewardBudgetReceived(
            address(vpfi), amount, days_, 8453, ++nextRemit, address(0xBA5E), 0, fresh, bytes32(0),
            splitTyped
        ) {
            packetHashes.push(keccak256(abi.encode(uint256(8453), ++seqStamped, "seq")));
        } catch {
            refusals++;
        }
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

    /// #1566 transport epochs PR 3b (Codex #2232 r3) — put a random landed
    /// packet back into its PRE-3b shape and bring it in through the ROLLOUT
    /// admission, so an epoch opened that way is a subject of the conservation
    /// invariant under every interleaving and not only in its own unit suite.
    ///
    /// Skipped where a remainder ROW EXISTS. The fixture clears the batch row,
    /// and a remainder entry outliving it is an artifact of the mutator rather
    /// than a state the chain can reach: a rollout packet by definition never
    /// had a batch to park.
    ///
    /// The probe is the row's `dayCount`, not its `amount` (Codex #2232 r3).
    /// An earlier revision tested `parked != 0` and reasoned that this also
    /// excluded every classified packet, since classification is gated behind
    /// the release — true only while a classification could not empty the
    /// remainder. It can: park 10, classify 10, and `amount` is back to zero
    /// with the row very much alive. `dayCount` is copied from the batch at
    /// parking and never falls, so it answers "is there a row" rather than
    /// "does the row still hold anything", which is the question being asked.
    function rolloutAdmit(uint256 seed) external {
        _start();
        if (packetHashes.length == 0) return;
        bytes32 h = packetHashes[seed % packetHashes.length];
        RewardEpochFacet ep = RewardEpochFacet(diamond);
        (bytes32 packetHash, , , , , ) = ep.getTransportBatch(h);
        if (packetHash == bytes32(0)) return; // a typed delivery has no epoch to redo
        (, , uint32 remDayCount, , ) = ep.getTransportRemainder(h);
        if (remDayCount != 0) return;
        TestMutatorFacet(diamond).unadmitTransportBatchRaw(h);
        // The handler's untyped deliveries all list exactly this one day, so the
        // whole list re-supplied here is the list the commitment covers.
        uint256[] memory days_ = new uint256[](1);
        days_[0] = 1;
        try ep.admitLegacyTransportBatch(h, days_) {
            rolloutAdmitted++;
        } catch {
            refusals++;
        }
    }

    /// #1566 transport epochs PR 3b (Codex #2232 r3) — RELEASE a random
    /// landed packet's epoch: materialize its membership, park what its
    /// obligations left, and record the acknowledgment.
    ///
    /// Without this the campaign could not reach `takeFromReleasedRemainder`
    /// AT ALL. Classification against an epoch-backed packet is gated on the
    /// release, no other action performed one, so every such call reverted at
    /// the gate and landed in `refusals` — the new debit seam was untouched by
    /// 50,000 calls while the conservation invariant reported success over it.
    /// That is the failure mode an invariant campaign is least able to
    /// announce, so `released` is counted and asserted on, the way
    /// `untypedAdmitted` and `rolloutAdmitted` already are.
    ///
    /// Each step is attempted independently rather than guarded up front: the
    /// three are reachable in different states (a batch may already be
    /// indexed, already parked, already acknowledged by an earlier draw of
    /// this action), and refusing the whole action on any of them would make
    /// the reachable interleavings a function of draw order.
    function releaseEpoch(uint256 seed) external {
        _start();
        if (packetHashes.length == 0) return;
        bytes32 h = packetHashes[seed % packetHashes.length];
        RewardEpochFacet ep = RewardEpochFacet(diamond);
        (bytes32 packetHash, , , , , ) = ep.getTransportBatch(h);
        if (packetHash == bytes32(0)) return; // a typed delivery has no epoch to release
        // The handler's untyped deliveries all list exactly this one day, so
        // the whole list re-supplied here is the list the commitment covers.
        uint256[] memory days_ = new uint256[](1);
        days_[0] = 1;
        try ep.materializeTransportBatchPage(h, days_) {} catch {}
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
