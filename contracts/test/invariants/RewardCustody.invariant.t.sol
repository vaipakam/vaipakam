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

        targetContract(address(handler));
        RewardRemittanceFacet(address(diamond)).setRewardRemittanceReceiver(address(handler));
        bytes4[] memory sel = new bytes4[](8);
        sel[0] = RewardCustodyHandler.fund.selector;
        sel[1] = RewardCustodyHandler.claim.selector;
        sel[2] = RewardCustodyHandler.absorb.selector;
        sel[3] = RewardCustodyHandler.feeInflow.selector;
        sel[4] = RewardCustodyHandler.surplus.selector;
        sel[5] = RewardCustodyHandler.untypedIngress.selector;
        sel[6] = RewardCustodyHandler.classify.selector;
        sel[7] = RewardCustodyHandler.reclassify.selector;
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
    /// classifiedRecycled + disposed == protectedCumulative`.
    function invariant_PacketIdentityHolds() public view {
        RewardReconciliationFacet recon = RewardReconciliationFacet(address(diamond));
        uint256 n = handler.packets();
        for (uint256 i = 0; i < n; ++i) {
            (uint256 protectedIn, uint256 unclassified, uint256 cf, uint256 cr, uint256 disposed, , , ) =
                recon.getPacketReconciliation(handler.packetAt(i));
            assertEq(unclassified + cf + cr + disposed, protectedIn, "packet identity");
        }
    }

    /// #1566 closure 2 cutover PR 2 — the recycled consumption counter the
    /// epoch reads never falls: whatever the last action was (a
    /// reclassification included), it is at least what it read at that
    /// action's start.
    function invariant_ConsumptionCounterIsMonotone() public view {
        (, , , , , uint256 consumed, , ) = RewardReconciliationFacet(address(diamond)).getQueueState(0);
        assertGe(consumed, handler.recycledSeqAtActionStart(), "the consumption counter never falls");
    }

    /// #1566 closure 2 cutover PR 2 (Codex #2206 r2) — the two queues equal
    /// the log: each side's queued total is the sum of the entries' queued
    /// credits, and the tree's prefix before the last entry plus that
    /// entry's queued credit is the total.
    function invariant_QueuesMatchTheLog() public view {
        RewardReconciliationFacet recon = RewardReconciliationFacet(address(diamond));
        (uint256 entries, , ) = recon.getReconciliationTotals();
        (uint256 queuedFresh, , uint256 queuedRecycled, , , , , ) = recon.getQueueState(0);
        uint256 sumFresh;
        uint256 sumRecycled;
        for (uint256 i = 0; i < entries; ++i) {
            LibVaipakam.ReconciliationEntry memory e = recon.getReconciliationEntry(i);
            sumFresh += e.freshCredit - e.freshInherited - e.freshAbsorbed;
            sumRecycled += e.recycledCredit - e.recycledInherited;
        }
        assertEq(sumFresh, queuedFresh, "fresh queued total == sum of entries");
        assertEq(sumRecycled, queuedRecycled, "recycled queued total == sum of entries");
        if (entries > 0) {
            RewardReconciliationFacet.Spent memory last = recon.getReconciliationEntrySpent(entries - 1);
            LibVaipakam.ReconciliationEntry memory e = recon.getReconciliationEntry(entries - 1);
            assertEq(last.freshPrefix + (e.freshCredit - e.freshInherited - e.freshAbsorbed), queuedFresh, "fresh tree == total");
            assertEq(last.recycledPrefix + (e.recycledCredit - e.recycledInherited), queuedRecycled, "recycled tree == total");
        }
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
    ///      and this handler is the only source-8453 ingress), the caps it
    ///      fixed per packet, and the sequencing counters at the start of
    ///      the current action (the monotonicity invariant's baseline).
    bytes32[] internal packetHashes;
    uint256 internal seqStamped;
    uint256 public recycledSeqAtActionStart;

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
        (, , , , , uint256 consumed, , ) = RewardReconciliationFacet(diamond).getQueueState(0);
        recycledSeqAtActionStart = consumed;
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

    /// An untyped delivery as the receiver presents it (the handler is the
    /// registered receiver): the tokens are forwarded to the Diamond first,
    /// the fresh share is credited live, the remainder is protected into the
    /// `Unclassified` row — nothing of it stays in the Diamond.
    function untypedIngress(uint256 seed) external {
        _start();
        uint256 amount = bound(seed, 2, 10_000e18);
        uint256 fresh = bound(uint256(keccak256(abi.encode(seed, "fresh"))), 0, amount);
        _mint(diamond, amount);
        uint256[] memory days_ = new uint256[](1);
        days_[0] = 1;
        try RewardRemittanceFacet(diamond).onRewardBudgetReceived(
            address(vpfi), amount, days_, 8453, ++nextRemit, address(0xBA5E), 0, fresh, bytes32(0)
        ) {
            packetHashes.push(keccak256(abi.encode(uint256(8453), ++seqStamped, "seq")));
        } catch {
            refusals++;
        }
    }

    /// #1566 closure 2 cutover PR 2 — classify a random share of a random
    /// landed packet's remainder, under the pause; the caps are the
    /// packet's classifiable part split at random on the first entry and
    /// restated after (read back from the packet).
    function classify(uint256 seed) external {
        _start();
        if (packetHashes.length == 0) return;
        bytes32 h = packetHashes[seed % packetHashes.length];
        RewardReconciliationFacet recon = RewardReconciliationFacet(diamond);
        (, uint256 remainder, uint256 cf, uint256 cr, , uint256 fc, uint256 rc, bool fixed_) =
            recon.getPacketReconciliation(h);
        if (remainder == 0) return;
        if (!fixed_) {
            uint256 budget = remainder + cf + cr;
            fc = bound(uint256(keccak256(abi.encode(seed, "cap"))), 0, budget);
            rc = budget - fc;
        }
        uint256 freshRoom = fc > cf ? fc - cf : 0;
        uint256 recycledRoom = rc > cr ? rc - cr : 0;
        uint256 fresh = bound(uint256(keccak256(abi.encode(seed, "f"))), 0, freshRoom);
        uint256 recycled = bound(uint256(keccak256(abi.encode(seed, "r"))), 0, recycledRoom);
        if (fresh + recycled > remainder) recycled = remainder - fresh;
        if (fresh + recycled == 0) return;
        AdminFacet(diamond).pause();
        try recon.classifyLegacyPacket(h, fresh, recycled, fc, rc, keccak256(abi.encode("entry", calls))) {}
        catch {
            refusals++;
        }
        AdminFacet(diamond).unpause();
    }

    /// #1566 closure 2 cutover PR 2 — move a random amount between the sides
    /// of a random entry, either direction, under the pause.
    function reclassify(uint256 seed) external {
        _start();
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
        try recon.reclassifyReconciliationEntry(index, freshToRecycled, amount, keccak256(abi.encode("re", calls))) {}
        catch {
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
