// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {RewardEpochFacet} from "../src/facets/RewardEpochFacet.sol";
import {RewardEpochViewFacet} from "../src/facets/RewardEpochViewFacet.sol";
import {RewardIngressFacet} from "../src/facets/RewardIngressFacet.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {LibVpfiRecycle} from "../src/libraries/LibVpfiRecycle.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardStagingFacet} from "../src/facets/RewardStagingFacet.sol";
import {RewardStagingSettleFacet} from "../src/facets/RewardStagingSettleFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibRewardCustody} from "../src/libraries/LibRewardCustody.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/// @title RewardStagingTest
/// @notice #1566 transport epochs 3b-ii-A2 (#2305) — the staging record's
///         lifecycle on a standalone claim day: a cap-hit deferral stages the
///         window, preparation stages the rest from the continuation, the
///         reservation holds the residual and the headroom per source, the
///         paginated resolution pays on its last page, and the unwind returns
///         exactly what was held. Every cell reads the batch identity with its
///         staged terms and the custody rows, so a move that was not explicit
///         would show.
contract RewardStagingTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    address internal alice;
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    address internal constant REMITTER = address(0xBA5E);
    uint256 internal constant SEED = 1_000_000 ether;
    uint64 internal constant LOAN = 77;
    /// @dev The day's user need: the scene caps the day at this figure.
    uint256 internal constant NEED = 0.4e18;
    /// @dev 65 epochs of this each list day 1: one window (64) offers 0.32,
    ///      short of the need, and one more stands past the cap.
    uint256 internal constant TINY = 0.005e18;
    uint256 internal constant WIDE = 65;
    /// @dev The arrival time of each wide-day epoch, recorded as it is minted.
    uint256[] internal arrivedAt;

    event StagingRecordOpened(bytes32 indexed key, address indexed user, uint8 side, uint64 day, bytes32 commitment);
    event TransportStaged(bytes32 indexed batchId, bytes32 indexed key, uint256 fresh, uint256 recycled);

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
        RewardReporterFacet(address(diamond)).setRewardMessenger(address(this));
        activateRewardCustodyForTest(address(vpfi), 0);
        alice = makeAddr("staging-alice");
    }

    // ───────────────────────────── fixtures ─────────────────────────────

    function _epoch() internal view returns (RewardEpochFacet) {
        return RewardEpochFacet(address(diamond));
    }

    function _view() internal view returns (RewardEpochViewFacet) {
        return RewardEpochViewFacet(address(diamond));
    }

    function _staging() internal view returns (RewardStagingFacet) {
        return RewardStagingFacet(address(diamond));
    }

    function _settle() internal view returns (RewardStagingSettleFacet) {
        return RewardStagingSettleFacet(address(diamond));
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

    function _armedDay(uint256 d, uint256 cap) internal {
        _mut().setDayPoolStampRaw(d, uint128(2e18), 0);
        _mut().setKnownGlobalDailyInterest(d, 1e18, 0, true);
        _mut().setDayCapThreshold18(d, type(uint256).max);
        _mut().setDayCapModeRaw(d, 1);
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

    /// @dev One armed day (1) with alice's one-day entry on it, the delivered
    ///      ledger at zero so only the epochs can pay until a cell says otherwise.
    function _scene() internal returns (uint256 id) {
        _armedDay(1, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(1);
        id = _entry(1, 2);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
    }

    function _one(uint256 d) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = d;
    }

    function _epochOf(uint256 amount, uint256 remitId, bytes32 id) internal returns (bytes32 h) {
        _ingress().onRewardBudgetReceived(address(vpfi), amount, _one(1), CHAIN_BASE, remitId, REMITTER, 0, 0, id, false);
        h = keccak256(abi.encode(uint256(CHAIN_BASE), id));
        _epoch().materializeTransportBatchPage(h, _one(1));
    }

    /// @dev `WIDE` fresh epochs, each `TINY`, all listing day 1, ten seconds
    ///      apart so the list is in their minting order (the times are computed
    ///      explicitly: viaIR folds a re-read `block.timestamp` across the loop).
    ///      The first `typed` are attested; the rest stay untyped, draw-only.
    function _wideDayTyped(uint256 typed) internal returns (bytes32[] memory hs) {
        return _wideDayTypedFrom(typed, 100);
    }

    /// @dev As above, with the remit ids and packet ids salted by `salt` so a
    ///      cell can mint a second wide day without replaying the first.
    function _wideDayTypedFrom(uint256 typed, uint256 salt) internal returns (bytes32[] memory hs) {
        hs = new bytes32[](WIDE);
        delete arrivedAt;
        uint256 t0 = block.timestamp;
        for (uint256 i; i < WIDE; ++i) {
            uint256 ti = t0 + 10 * (i + 1);
            vm.warp(ti);
            arrivedAt.push(ti);
            hs[i] = _epochOf(TINY, salt + i, keccak256(abi.encode("tiny", salt, i)));
            if (i < typed) _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, salt + i, TINY, 0);
        }
    }

    function _wideDay(bool attested) internal returns (bytes32[] memory hs) {
        return _wideDayTyped(attested ? WIDE : 0);
    }

    /// @dev Live fresh in custody plus a delivered ledger that can pay it.
    function _liveFresh(uint256 amount) internal {
        _ingress().onRewardBudgetReceived(
            address(vpfi), amount, _one(1), CHAIN_BASE, 999, REMITTER, 0, amount, keccak256("live"), true
        );
        _mut().setArmedFreshLedgerRaw(amount, 0);
    }

    function _claim() internal returns (uint256 paid) {
        vm.prank(alice);
        (paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewards();
    }

    function _key() internal view returns (bytes32) {
        return keccak256(abi.encode(alice, LibVaipakam.RewardSide.Lender, uint256(1)));
    }

    function _rec() internal view returns (RewardEpochViewFacet.StagingRecordView memory) {
        return _view().getStagingRecord(_key());
    }

    function _row(LibVaipakam.RewardCustodyRow r) internal view returns (uint256) {
        return _custody().rewardCustodyRow(r);
    }

    function _balance(bytes32 h) internal view returns (uint256 b) {
        (, b, , , , ) = _epoch().getTransportBatch(h);
    }

    function _admitted(bytes32 h) internal view returns (uint256 a) {
        (, , a, , , ) = _epoch().getTransportBatch(h);
    }

    function _staged(bytes32 h) internal view returns (uint256 f, uint256 r, uint256 refs) {
        return _epoch().getTransportBatchStaged(h);
    }

    function _legs(bytes32 h) internal view returns (uint256 f, uint256 r) {
        (f, r) = _epoch().getTransportBatchLegs(h);
    }

    function _cursor(uint256 d) internal view returns (uint256 c) {
        (, , , c) = _epoch().getTransportDayBatches(d, 0, 100);
    }

    function _preview() internal view returns (uint256 amount) {
        (amount, , ) = InteractionRewardsLensFacet(address(diamond)).previewInteractionRewards(alice);
    }

    function _rowsSum() internal view returns (uint256 s) {
        for (uint8 i; i <= uint8(LibVaipakam.RewardCustodyRow.Resolving); ++i) {
            s += _row(LibVaipakam.RewardCustodyRow(i));
        }
    }

    /// @dev The day's allocation as the ordinary settle path would read it now.
    function _allocFresh(uint256 need) internal view returns (uint256 tf) {
        LibRewardCustody.AllocRequest memory q;
        q.dayId = 1;
        q.needFresh = need;
        q.domainFresh = type(uint256).max;
        q.domainRecycled = type(uint256).max;
        q.poolFresh = type(uint256).max;
        q.deliveredCap = type(uint256).max;
        q.ovIds = new bytes32[](0);
        q.ovFresh = new uint256[](0);
        q.ovRecycled = new uint256[](0);
        LibRewardCustody.AllocResult memory r = _epoch().getTransportAllocationForDay(q);
        return r.transportFresh;
    }

    /// @dev The batch identity with its staged terms, per epoch.
    function _assertConserved(bytes32[] memory hs) internal view {
        for (uint256 i; i < hs.length; ++i) {
            (uint256 lf, uint256 lr) = _legs(hs[i]);
            (uint256 sf, uint256 sr, ) = _staged(hs[i]);
            assertEq(_balance(hs[i]) + lf + lr + sf + sr, _admitted(hs[i]), "identity with staged terms");
        }
    }

    /// @dev The scene, the wide day, and the claim that stages its window.
    function _stagedScene() internal returns (bytes32[] memory hs, uint256 id) {
        id = _scene();
        hs = _wideDay(true);
        assertEq(_claim(), 0, "nothing paid: the day is staged, not settled");
    }

    /// @dev The staged scene with the record's own scan run to the list's
    ///      end: the walk records no scan position (Codex #2308 r4), so the
    ///      first preparation rescans the walk's window — the 64 already
    ///      staged — and the second reaches the 65th. Two pages, stated here
    ///      once so every cell past the scan reads the same fact.
    function _stagedAndScanned() internal returns (bytes32[] memory hs, uint256 id) {
        (hs, id) = _stagedScene();
        (uint256 sf, ) = _staging().prepareStagedDay(_key());
        assertEq(sf, 0, "the first preparation rescans the window the walk staged");
        assertFalse(_rec().scanComplete, "and the 65th still stands past it");
        _staging().prepareStagedDay(_key());
        assertTrue(_rec().scanComplete, "the second reaches the list's end");
    }

    // ───────────────────────────── the walk stages ─────────────────────────────

    function test_ACapHitDeferral_StagesTheWindow_AndPaysNothing() public {
        (bytes32[] memory hs, ) = _stagedScene();
        RewardEpochViewFacet.StagingRecordView memory r = _rec();
        assertEq(r.phase, uint8(LibVaipakam.StagingPhase.Staging), "a record stands, staging");
        assertEq(r.user, alice);
        assertEq(r.day, 1);
        assertEq(r.batchCount, 64, "one window's epochs referenced");
        assertEq(r.stagedFresh, 64 * TINY, "the window's fresh is staged");
        assertEq(r.stagedRecycled, 0);
        assertGt(r.deadline, block.timestamp, "a deadline, from the work");
        // Which 64 of the 65 the window held is the ledger's order (same-block
        // arrivals tie by batch id), so the cells count rather than name them.
        uint256 stagedCount;
        for (uint256 i; i < WIDE; ++i) {
            (uint256 sf, , uint256 refs) = _staged(hs[i]);
            if (sf != 0) {
                assertEq(_balance(hs[i]), 0, "the epoch's balance moved into staged form");
                assertEq(sf, TINY);
                assertEq(refs, 1, "one reference, the record's");
                ++stagedCount;
            } else {
                assertEq(refs, 0, "an unstaged epoch is unreferenced");
                assertEq(_balance(hs[i]), TINY, "and untouched");
            }
        }
        assertEq(stagedCount, 64, "one window's epochs staged, the 65th past it");
        _assertConserved(hs);
        assertEq(_row(LibVaipakam.RewardCustodyRow.Resolving), 0, "staging holds nothing in the resolving row");
        assertEq(_mut().getArmedFreshPaidRaw(), 0, "the ledger was not pulled");
    }

    function test_StagingWaitsForTheType_AnUntypedWindowOpensNoRecord() public {
        _scene();
        bytes32[] memory hs = _wideDay(false);
        vm.prank(alice);
        vm.expectRevert(IVaipakamErrors.NoInteractionRewardsToClaim.selector);
        RewardClaimFacet(address(diamond)).claimInteractionRewards();
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.None), "no record over untyped epochs");
        for (uint256 i; i < WIDE; ++i) {
            assertEq(_balance(hs[i]), TINY, "nothing moved");
        }
    }

    function test_AReferencedBatch_IsNotPassedByTheCursor() public {
        _stagedScene();
        _epoch().epochPruneTransportDayCursor(1);
        assertEq(_cursor(1), 0, "an empty-but-referenced epoch is not passed");
        // The park refusal for a referenced batch stands in the code behind
        // the release gate, which #2258 keeps closed until the close-out
        // (B) lands; it is exercised there, not here.
    }

    function test_TheClaim_DefersADayWithAStandingRecord() public {
        _stagedScene();
        _liveFresh(1e18); // could pay the whole day live now
        assertEq(_claim(), 0, "nothing paid, nothing failed: the day is in hand");
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.Staging), "the day is the record's to settle");
        assertEq(_mut().getArmedFreshPaidRaw(), 0, "and the live ledger was not pulled past it");
    }

    // ───────────────────────────── prepare ─────────────────────────────

    function test_Prepare_StagesTheRest_FromTheContinuation() public {
        (bytes32[] memory hs, ) = _stagedScene();
        assertEq(_rec().continuationNode, bytes32(0), "the walk records no scan position");
        // The record's own scanner is the only one that advances: its first
        // page rescans the window from the day's cursor — every epoch there
        // already staged, so nothing is taken twice — and stops where the
        // window did; its second page takes the 65th.
        (uint256 sf, uint256 sr) = _staging().prepareStagedDay(_key());
        assertEq(sf + sr, 0, "the window rescanned: its epochs are staged already");
        assertEq(_rec().continuationNode, hs[63], "and the continuation stands at the window's last epoch");
        (sf, sr) = _staging().prepareStagedDay(_key());
        assertEq(sf, TINY, "the one epoch past the window, and no rescan of the staged prefix");
        assertEq(sr, 0);
        RewardEpochViewFacet.StagingRecordView memory r = _rec();
        assertEq(r.batchCount, WIDE);
        assertEq(r.stagedFresh, WIDE * TINY);
        (uint256 sf65, , uint256 refs65) = _staged(hs[64]);
        assertEq(sf65, TINY);
        assertEq(refs65, 1);
        _assertConserved(hs);
        (sf, sr) = _staging().prepareStagedDay(_key());
        assertEq(sf + sr, 0, "nothing left to stage");
    }

    function test_AnExpiredDeadline_IsTerminal_ListGrowthDoesNotReviveIt() public {
        _stagedScene();
        uint64 deadline = _rec().deadline;
        vm.warp(uint256(deadline) + 1);
        vm.warp(block.timestamp + 1);
        _epochOf(TINY, 500, keccak256("late")); // the list grows
        _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, 500, TINY, 0);
        _staging().prepareStagedDay(_key());
        assertEq(_rec().deadline, deadline, "a passed deadline never moves");
    }

    // ───────────────────────────── reserve ─────────────────────────────

    function test_Reserve_RefusesAnUncoveredDay() public {
        _stagedAndScanned();
        // 0.325 staged, 0.075 residual, and no live fresh to bear it.
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.StagingNotCovered.selector, _key()));
        _staging().reserveStagedDay(_key());
    }

    function test_Reserve_RefusesWhileTheScanIsIncomplete() public {
        _stagedScene(); // the window ended before the list did: 64 of 65 seen
        _liveFresh(1e18); // live could pay the residual — but transport comes first
        assertFalse(_rec().scanComplete);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.StagingScanIncomplete.selector, _key()));
        _staging().reserveStagedDay(_key());
        _staging().prepareStagedDay(_key()); // the window, rescanned
        assertFalse(_rec().scanComplete, "the 65th still unseen");
        _staging().prepareStagedDay(_key());
        assertTrue(_rec().scanComplete, "the list is seen to its end");
        vm.warp(block.timestamp + 10);
        _epochOf(TINY, 600, keccak256("grew")); // the list grew since
        _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, 600, TINY, 0);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.StagingScanIncomplete.selector, _key()));
        _staging().reserveStagedDay(_key());
        _staging().prepareStagedDay(_key());
        _staging().reserveStagedDay(_key());
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.Reserved));
    }

    function test_EverySettlementPath_DefersADayWithAStandingRecord() public {
        // Two typed epochs among 65: the walk stages those two and leaves 62
        // untyped, draw-only epochs live in the window. Then the day's cap
        // falls to what that window covers — without the guard the primitive
        // would price and settle the day for anyone who asked.
        uint256 id = _scene();
        _wideDayTyped(2);
        assertEq(_claim(), 0);
        assertEq(_rec().batchCount, 2, "the two typed epochs staged");
        _mut().setDayUserSideCapRaw(1, 0.1e18);
        _liveFresh(1e18);
        assertEq(_preview(), 0, "the dry run defers on the record");
        assertEq(_claim(), 0, "the claim defers on the record");
        assertEq(_mut().rewardEntryClaimNextDayRaw(id), 0, "the day was not persisted past the record (unset reads as its start day)");
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.Staging));
    }

    function test_ComponentRoom_IsNetOfWhatIsStaged() public {
        _scene();
        // 64 fresh epochs and, first by arrival, one attested half fresh, half
        // recycled — the window stages its fresh half for a fresh-only day.
        vm.warp(block.timestamp + 10);
        bytes32 mixed = _epochOf(2 * TINY, 99, keccak256("mixed"));
        _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, 99, TINY, TINY);
        _wideDay(true);
        assertEq(_claim(), 0);
        (uint256 sf, uint256 sr, ) = _staged(mixed);
        assertEq(sf, TINY, "its fresh half staged");
        assertEq(sr, 0);
        assertEq(_balance(mixed), TINY, "its recycled half still held");
        assertEq(_allocFresh(1e18), 0, "no fresh room is left in it for anyone else: the cap is net of the staged half");
    }

    function test_ALateEpoch_PastTheContinuation_IsStagedOnce() public {
        (bytes32[] memory hs, ) = _stagedScene();
        // Linked late, by arrival between the window's last epoch and the
        // 65th: it sorts AFTER the continuation, so the list scan from there
        // reaches it and the late chain must not feed it a second time.
        uint256 t65 = arrivedAt[64];
        vm.warp(t65 - 5);
        bytes32 late = _epochOf(TINY, 700, keccak256("late"));
        _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, 700, TINY, 0);
        vm.warp(t65 + 100);
        (uint256 sf, ) = _staging().prepareStagedDay(_key());
        assertEq(sf, 0, "the window rescanned first");
        (sf, ) = _staging().prepareStagedDay(_key());
        assertEq(sf, 2 * TINY, "the late epoch and the 65th, each once");
        assertEq(_rec().batchCount, WIDE + 1);
        (uint256 lsf, , uint256 lrefs) = _staged(late);
        assertEq(lsf, TINY);
        assertEq(lrefs, 1);
    }

    function test_Resolution_ReturnsTheStagedExcess_TheRepriceDidNotAssign() public {
        (bytes32[] memory hs, ) = _stagedAndScanned(); // 0.325 staged
        _mut().setInteractionPoolPaidOut(LibVaipakam.VPFI_INTERACTION_POOL_CAP - 0.2e18); // the pool shrank
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        RewardEpochViewFacet.StagingRecordView memory r = _rec();
        assertEq(r.epochUserFresh, 0.2e18, "the reprice assigns what the pool still allows");
        assertEq(r.cappedOffFresh, 0.2e18, "and records what the cap trimmed");
        uint256 aliceBefore = vpfi.balanceOf(alice);
        _settle().resolveStagedDayPage(_key());
        _settle().resolveStagedDayPage(_key());
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.None));
        assertEq(vpfi.balanceOf(alice) - aliceBefore, 0.2e18, "paid what was assigned");
        uint256 restored;
        uint256 consumed;
        for (uint256 i; i < WIDE; ++i) {
            restored += _balance(hs[i]);
            (uint256 lf, ) = _legs(hs[i]);
            consumed += lf;
        }
        assertEq(consumed, 0.2e18, "consumed what was paid");
        assertEq(restored, WIDE * TINY - 0.2e18, "the excess went back to its epochs");
        // And WHICH epochs were spent is the plan's order, not the walk's
        // (Codex #2308 r13): the budget ran out after forty, so the forty the
        // plan ranked first were consumed and the rest returned.
        (uint256 lfFirst, ) = _legs(hs[0]);
        assertEq(lfFirst, TINY, "the plan's first epoch was spent");
        assertEq(_balance(hs[0]), 0);
        (uint256 lfLast, ) = _legs(hs[64]);
        assertEq(lfLast, 0, "and the plan's last was returned, not spent");
        assertEq(_balance(hs[64]), TINY);
        assertEq(_mut().poolRemainingRaw(), 0, "the pool is exactly spent");
        assertEq(_mut().interactionPoolReservedRaw(), 0, "none reserved");
        _assertConserved(hs);
    }

    function test_ASanctionedClaimant_IsPaidToTheVaultOrNotAtAll() public {
        _stagedAndScanned();
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        _settle().resolveStagedDayPage(_key());
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        m.setFlagged(alice, true);
        ProfileFacet(address(diamond)).refreshSanctionsFlag(alice);
        uint256 aliceBefore = vpfi.balanceOf(alice);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.RewardCustodyVaultDeliveryFailed.selector, alice));
        _settle().resolveStagedDayPage(_key());
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.Resolving), "held, not paid to the wallet");
        assertEq(vpfi.balanceOf(alice), aliceBefore);
        m.setFlagged(alice, false);
        ProfileFacet(address(diamond)).refreshSanctionsFlag(alice);
        assertTrue(_settle().resolveStagedDayPage(_key()));
        assertEq(vpfi.balanceOf(alice) - aliceBefore, NEED);
    }

    function test_AReservation_BindsAOneCallClaimAsADeferral_NotATruncation() public {
        _stagedAndScanned();
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key()); // 0.4 of the pool cap reserved
        // Bob's day is armed with no epochs; the pool has 0.5 left in hard
        // terms and 0.1 available; his 0.4 fits the cap but not the room.
        address bob = makeAddr("staging-bob");
        _armedDay(2, NEED);
        _mut().setFeeEntitlementRaw(
            78,
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
        uint256 bobEntry = _mut().pushRewardEntry(bob, 78, LibVaipakam.RewardSide.Lender, 1e18, 2);
        _mut().closeRewardEntryRaw(bobEntry, 3);
        _mut().userClaimFundingNeedRaw(bob);
        _mut().setInteractionPoolPaidOut(LibVaipakam.VPFI_INTERACTION_POOL_CAP - 0.5e18);
        assertEq(_mut().poolRemainingRaw(), 0.5e18);
        assertEq(_mut().poolAvailableRaw(), 0.1e18);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.InteractionPoolReservedShortfall.selector, NEED, 0.1e18));
        RewardClaimFacet(address(diamond)).claimInteractionRewards();
        assertEq(_mut().rewardEntryClaimNextDayRaw(bobEntry), 0, "nothing was written off");
        (uint256 previewed, , ) = InteractionRewardsLensFacet(address(diamond)).previewInteractionRewards(bob);
        assertEq(previewed, 0, "the preview says what the claim does: nothing, while the reservation binds");
        assertFalse(_mut().entryExecutableNowRaw(bobEntry), "and the expiry clock does not count the interval");
        // The reservation unwinds: the room is bob's, in full.
        vm.warp(uint256(_rec().deadline) + 1);
        _settle().unwindStagedDayPage(_key());
        _settle().unwindStagedDayPage(_key());
        (previewed, , ) = InteractionRewardsLensFacet(address(diamond)).previewInteractionRewards(bob);
        assertEq(previewed, NEED, "and the full amount once it released");
        assertTrue(_mut().entryExecutableNowRaw(bobEntry), "executable again once it released");
        uint256 bobBefore = vpfi.balanceOf(bob);
        vm.prank(bob);
        (uint256 paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewards();
        assertEq(paid, NEED, "paid in full once the reservation released, not scaled");
        assertEq(vpfi.balanceOf(bob) - bobBefore, NEED);
    }

    function test_ALateChainLongerThanAPage_KeepsTheScanIncomplete() public {
        _stagedAndScanned(); // scan complete: 65 seen
        // Seventy epochs arrive out of order — older than everything the
        // window saw — after the record's last scan: they link late, ahead
        // of the continuation, more of them than one page walks.
        uint256 t0 = arrivedAt[0];
        for (uint256 i; i < 70; ++i) {
            vm.warp(t0 - 1000 + i);
            _epochOf(TINY, 800 + i, keccak256(abi.encode("older", i)));
            _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, 800 + i, TINY, 0);
        }
        vm.warp(arrivedAt[64] + 100);
        _liveFresh(1e18);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.StagingScanIncomplete.selector, _key()));
        _staging().reserveStagedDay(_key()); // the list grew
        _staging().prepareStagedDay(_key()); // one page of the late chain: 64 of 70
        assertFalse(_rec().scanComplete, "six late epochs stand unvisited");
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.StagingScanIncomplete.selector, _key()));
        _staging().reserveStagedDay(_key());
        _staging().prepareStagedDay(_key()); // the rest
        assertTrue(_rec().scanComplete);
        _staging().reserveStagedDay(_key());
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.Reserved));
    }

    function test_AnEpochAttestedAfterItWasSkipped_IsRevisited() public {
        _scene();
        _wideDayTyped(2); // the window: 2 typed staged, 62 untyped passed over
        assertEq(_claim(), 0);
        RewardEpochViewFacet.StagingRecordView memory r = _rec();
        assertEq(r.batchCount, 2);
        assertEq(r.skippedCount, 0, "the walk notes nothing: the record's own scan does");
        _staging().prepareStagedDay(_key()); // the window: 62 untyped remembered
        assertEq(_rec().skippedCount, 62, "the untyped epochs it passed over are remembered");
        assertFalse(_rec().scanComplete);
        _staging().prepareStagedDay(_key()); // the 65th, untyped: 63 skipped, scan complete
        assertTrue(_rec().scanComplete);
        assertEq(_rec().skippedCount, 63);
        // One of the skipped is attested now: no live source is reserved
        // ahead of it, and the next preparation stages it.
        _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, 100 + 10, TINY, 0);
        _liveFresh(1e18);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.StagingScanIncomplete.selector, _key()));
        _staging().reserveStagedDay(_key());
        (uint256 sf, ) = _staging().prepareStagedDay(_key());
        assertEq(sf, TINY, "the newly typed epoch staged");
        assertEq(_rec().batchCount, 3);
        assertEq(_rec().skippedCount, 62, "and forgotten as skipped");
        _staging().reserveStagedDay(_key());
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.Reserved));
    }

    function test_TheDeadline_IsSizedFromTheWorkLeft_NotTheDaysHistory() public {
        // Alice's record resolves and the day's cursor passes its 65 spent
        // epochs; 65 more arrive and bob's obligation on the same day opens
        // a record whose lease counts only the epochs past the cursor.
        (bytes32[] memory hs, ) = _stagedAndScanned();
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        _settle().resolveStagedDayPage(_key());
        _settle().resolveStagedDayPage(_key());
        _epoch().epochPruneTransportDayCursor(1);
        _epoch().epochPruneTransportDayCursor(1);
        assertEq(_cursor(1), WIDE, "every spent epoch passed");
        hs; // the spent ones
        vm.warp(arrivedAt[64] + 1000);
        _wideDayTypedFrom(WIDE, 900); // 65 more, all past the cursor
        address bob = makeAddr("staging-bob");
        _mut().setFeeEntitlementRaw(
            78,
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
        uint256 bobEntry = _mut().pushRewardEntry(bob, 78, LibVaipakam.RewardSide.Lender, 1e18, 1);
        _mut().closeRewardEntryRaw(bobEntry, 2);
        _mut().userClaimFundingNeedRaw(bob);
        _mut().setArmedFreshLedgerRaw(0, 0);
        vm.prank(bob);
        (uint256 paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewards();
        assertEq(paid, 0);
        bytes32 bobKey = keccak256(abi.encode(bob, LibVaipakam.RewardSide.Lender, uint256(1)));
        RewardEpochViewFacet.StagingRecordView memory r = _view().getStagingRecord(bobKey);
        assertEq(r.phase, uint8(LibVaipakam.StagingPhase.Staging));
        // 65 members left past the cursor → two pages → two cadences plus grace.
        assertEq(r.deadline, r.openedAt + 2 days + 3 days, "sized from the 65 left, not the 130 the day has seen");
    }

    function test_ASkippedEpoch_RecheckedTypedButUseless_IsForgotten() public {
        _scene();
        _wideDayTyped(2);
        assertEq(_claim(), 0);
        _staging().prepareStagedDay(_key()); // the window
        _staging().prepareStagedDay(_key()); // the 65th
        assertEq(_rec().skippedCount, 63);
        // A skipped epoch is attested recycled-only: typed, but with no fresh
        // room for a fresh-only day. Re-checked, it contributes nothing and
        // must not hold the reservation hostage.
        _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, 100 + 10, 0, TINY);
        _liveFresh(1e18);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.StagingScanIncomplete.selector, _key()));
        _staging().reserveStagedDay(_key());
        (uint256 sf, ) = _staging().prepareStagedDay(_key());
        assertEq(sf, 0, "nothing to take from it");
        assertEq(_rec().batchCount, 2, "not referenced");
        assertEq(_rec().skippedCount, 62, "but forgotten as skipped");
        _staging().reserveStagedDay(_key());
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.Reserved));
    }

    function test_Reserve_HoldsTheResidualAndTheHeadroom_PerSource() public {
        _stagedAndScanned();
        _liveFresh(1e18);
        uint256 poolBefore = _mut().poolAvailableRaw();
        _staging().reserveStagedDay(_key());
        RewardEpochViewFacet.StagingRecordView memory r = _rec();
        assertEq(r.phase, uint8(LibVaipakam.StagingPhase.Reserved));
        assertEq(_mut().rewardBudgetArmedFreshReservedRaw(), NEED - WIDE * TINY, "the delivered ledger holds the live fresh");
        assertEq(r.needUserFresh, NEED, "the day's need, priced");
        assertEq(r.epochUserFresh, WIDE * TINY, "what the epochs cover");
        assertEq(r.reservedLiveUserFresh, NEED - WIDE * TINY, "the residual, reserved from live fresh");
        assertEq(r.reservedPoolCap, NEED, "the pool cap over the full fresh leg");
        assertEq(_mut().poolAvailableRaw(), poolBefore - NEED, "reserved reads as encumbered to a settlement");
        assertEq(_mut().poolRemainingRaw(), poolBefore, "and not as spent to the lifetime cap");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Resolving), 0, "fresh is reserved by count, never held");
        assertEq(_mut().getArmedFreshPaidRaw(), 0, "nothing paid");
    }

    // ───────────────────────────── resolve ─────────────────────────────

    function test_Resolve_ConsumesByPages_AndPaysOnTheLast() public {
        (bytes32[] memory hs, uint256 id) = _stagedAndScanned();
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        uint256 aliceBefore = vpfi.balanceOf(alice);
        uint256 unclassifiedBefore = _row(LibVaipakam.RewardCustodyRow.Unclassified);

        assertFalse(_settle().resolveStagedDayPage(_key()), "page one: 64 of 65");
        RewardEpochViewFacet.StagingRecordView memory r = _rec();
        assertEq(r.phase, uint8(LibVaipakam.StagingPhase.Resolving), "irrevocable from the first page");
        assertEq(r.resolveCursor, 64, "sixty-four of the sixty-five consumed");
        assertEq(r.batchCount, WIDE, "the lifetime count stands; the cursor is the progress, and each batch was released as it was processed");
        assertEq(r.heldEpoch, 64 * TINY, "the page's epoch legs are held");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Resolving), 64 * TINY, "in the resolving row");
        assertEq(_mut().attributedTotalRaw(), _rowsSum(), "and attributed, never sweepable");
        (, , , , , , , , , , uint256 resolvingRow) = _custody().rewardCustodyLedger();
        assertEq(resolvingRow, 64 * TINY, "and named in the ledger");
        assertEq(unclassifiedBefore - _row(LibVaipakam.RewardCustodyRow.Unclassified), 64 * TINY, "out of the packets' row");
        (uint256 lf0, ) = _legs(hs[0]);
        (uint256 sf0, , uint256 refs0) = _staged(hs[0]);
        assertEq(lf0, TINY, "consumed: in the order the plan staged them, the first first");
        assertEq(sf0, 0);
        assertEq(refs0, 0, "released");
        (uint256 lfLast, ) = _legs(hs[64]);
        assertEq(lfLast, 0, "the 65th, staged last, is the last page's");
        assertEq(vpfi.balanceOf(alice), aliceBefore, "nothing paid between pages");
        _assertConserved(hs);

        assertTrue(_settle().resolveStagedDayPage(_key()), "page two: the last, and the payout");
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.None), "closed");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Resolving), 0, "the hold is empty");
        assertEq(vpfi.balanceOf(alice) - aliceBefore, NEED, "the day paid in full: epochs first, live the rest");
        assertEq(_mut().getArmedFreshPaidRaw(), NEED - WIDE * TINY, "the live ledger paid only the residual");
        assertEq(_mut().rewardEntryClaimNextDayRaw(id), 2, "the day persisted");
        assertEq(_mut().interactionPoolReservedRaw(), 0, "reserved converted to paid");
        assertEq(_mut().liveFreshReservedRaw(), 0);
        _assertConserved(hs);
        for (uint256 i; i < WIDE; ++i) {
            (, , uint256 refs) = _staged(hs[i]);
            assertEq(refs, 0);
            assertEq(_balance(hs[i]), 0);
        }
        _epoch().epochPruneTransportDayCursor(1);
        assertEq(_cursor(1), 64, "exhausted and unreferenced: one window passed");
    }

    // ───────────────────────────── unwind ─────────────────────────────

    function test_Unwind_RestoresExactlyWhatWasStaged() public {
        (bytes32[] memory hs, ) = _stagedAndScanned();
        uint64 deadline = _rec().deadline;
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.StagingNotExpired.selector, _key(), deadline));
        _settle().unwindStagedDayPage(_key());
        vm.warp(uint256(deadline) + 1);
        assertFalse(_settle().unwindStagedDayPage(_key()), "page one returns 64");
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.Unwinding));
        assertTrue(_settle().unwindStagedDayPage(_key()), "page two returns the last and closes");
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.None));
        for (uint256 i; i < WIDE; ++i) {
            (uint256 sf, , uint256 refs) = _staged(hs[i]);
            assertEq(_balance(hs[i]), TINY, "restored");
            assertEq(sf, 0);
            assertEq(refs, 0);
        }
        _assertConserved(hs);
        // A non-settlement release starts the obligation's cooldown: the
        // next claim opens no record and defers as A1 did, the restored
        // coverage being the window's meanwhile; past it, it stages again.
        vm.prank(alice);
        (bool ok, ) = address(diamond).call(abi.encodeWithSelector(RewardClaimFacet.claimInteractionRewards.selector));
        ok; // deferred: no record either way
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.None), "no record during the cooldown");
        vm.warp(block.timestamp + 3 days + 1);
        assertEq(_claim(), 0, "past the cooldown the claim stages the window again");
        assertEq(_rec().batchCount, 64);
    }

    function test_TheClaimant_MayCancelBeforeTheDeadline_AndAReservationIsReleased() public {
        _stagedAndScanned();
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        uint256 poolBefore = _mut().poolAvailableRaw();
        assertEq(_mut().loanSideRewardReservedRaw(LOAN, uint8(LibVaipakam.RewardSide.Lender)), NEED, "the loan side is encumbered while reserved");
        vm.startPrank(alice);
        _settle().unwindStagedDayPage(_key());
        _settle().unwindStagedDayPage(_key());
        vm.stopPrank();
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.None));
        assertEq(_mut().loanSideRewardReservedRaw(LOAN, uint8(LibVaipakam.RewardSide.Lender)), 0, "and released with the record");
        assertEq(_mut().poolAvailableRaw(), poolBefore + NEED, "the pool reservation released");
        assertEq(_mut().liveFreshReservedRaw(), 0);
        assertEq(_mut().interactionPoolReservedRaw(), 0);
    }

    function test_AResolvingRecord_IsBeyondTheDeadline() public {
        _stagedAndScanned();
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        _settle().resolveStagedDayPage(_key());
        vm.warp(block.timestamp + 365 days);
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.StagingPhaseInvalid.selector, _key(), uint8(LibVaipakam.StagingPhase.Resolving))
        );
        _settle().unwindStagedDayPage(_key());
        assertTrue(_settle().resolveStagedDayPage(_key()), "it only completes");
    }

    // ───────────────────────────── venue ─────────────────────────────

    function test_TheClaimant_BindsTheVenue_BeforeReservation() public {
        _stagedScene();
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.StagingVenueNotSettable.selector, _key()));
        _settle().setStagingVenue(_key(), LibVaipakam.RewardDelivery.Wallet);
        vm.prank(alice);
        _settle().setStagingVenue(_key(), LibVaipakam.RewardDelivery.Wallet);
        assertTrue(_rec().venueSet);
        assertEq(_rec().venue, uint8(LibVaipakam.RewardDelivery.Wallet));
        _staging().prepareStagedDay(_key());
        _staging().prepareStagedDay(_key());
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.StagingVenueNotSettable.selector, _key()));
        _settle().setStagingVenue(_key(), LibVaipakam.RewardDelivery.Vault);
    }

    // ───────────────────────── round 4: one scanner, one figure per source ─────────────────────────

    /// @dev A batch whose page holding day 1 is indexed before its other pages.
    function _pagedEpochOf(uint256 amount, uint256 remitId, bytes32 id) internal returns (bytes32 h) {
        uint256[] memory dayList = new uint256[](33); // one page (32) and one more
        for (uint256 i; i < 33; ++i) dayList[i] = i + 1;
        _ingress().onRewardBudgetReceived(address(vpfi), amount, dayList, CHAIN_BASE, remitId, REMITTER, 0, 0, id, false);
        h = keccak256(abi.encode(uint256(CHAIN_BASE), id));
        _epoch().materializeTransportBatchPage(h, dayList); // page one: days 1..32 — day 1 lists it, the batch is not whole
    }

    /// @dev A SHARED epoch the record scans is passed, not remembered, and
    ///      never staged — before or after its membership is whole (Codex #2276
    ///      r26, carried into staging): staging from it is the contested draw
    ///      the plan refuses until 3c, and a day holding many of them must not
    ///      fill the record's page of pending re-checks.
    function test_ASharedEpoch_WhenTheRecordScans_IsPassedNotRemembered() public {
        _scene();
        _wideDay(true);
        vm.warp(block.timestamp + 10);
        bytes32 paged = _pagedEpochOf(TINY, 950, keccak256("paged"));
        _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, 950, TINY, 0); // typed, shared, not yet whole
        assertEq(_claim(), 0);
        _staging().prepareStagedDay(_key()); // the window
        _staging().prepareStagedDay(_key()); // the 65th; the shared epoch is passed
        assertTrue(_rec().scanComplete);
        assertEq(_rec().skippedCount, 0, "a shared epoch is withheld, not pending");
        (, , uint256 refs) = _staged(paged);
        assertEq(refs, 0, "and not staged from");
        uint256[] memory dayList = new uint256[](33);
        for (uint256 i; i < 33; ++i) dayList[i] = i + 1;
        _epoch().materializeTransportBatchPage(paged, dayList);
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.Reserved), "nothing pending stands in the way");
        (, , refs) = _staged(paged);
        assertEq(refs, 0, "and, whole, it is still never staged");
    }

    function test_ALoanSideReservation_DefersAnotherHolder_NeverTrims() public {
        // Alice's record reserves 0.4 of the loan side. The side's lifetime cap
        // is then set to 0.5: bob's 0.4 on the same side fits the hard headroom
        // (0.5) but not what is left after the reservation (0.1). His day
        // defers — nothing trimmed, nothing retired — and pays in full once
        // the reservation releases.
        _stagedAndScanned();
        _liveFresh(2e18);
        _staging().reserveStagedDay(_key());
        assertEq(_mut().loanSideRewardReservedRaw(LOAN, uint8(LibVaipakam.RewardSide.Lender)), NEED);
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
                loanSideRewardCapOpen: uint128(0.5e18)
            })
        );
        address bob = makeAddr("staging-bob");
        _armedDay(2, NEED);
        uint256 bobEntry = _mut().pushRewardEntry(bob, LOAN, LibVaipakam.RewardSide.Lender, 1e18, 2);
        _mut().closeRewardEntryRaw(bobEntry, 3);
        _mut().userClaimFundingNeedRaw(bob);
        vm.prank(bob);
        vm.expectRevert(IVaipakamErrors.NoInteractionRewardsToClaim.selector);
        RewardClaimFacet(address(diamond)).claimInteractionRewards();
        assertEq(_mut().rewardEntryClaimNextDayRaw(bobEntry), 0, "the day was not persisted: nothing written off");
        (uint256 previewed, , ) = InteractionRewardsLensFacet(address(diamond)).previewInteractionRewards(bob);
        assertEq(previewed, 0, "the preview says what the claim does: nothing, while the reservation binds");
        assertFalse(_mut().entryExecutableNowRaw(bobEntry), "and the expiry clock does not count the interval");
        // The reservation unwinds: the side's hard headroom is bob's, in full.
        vm.warp(uint256(_rec().deadline) + 1);
        _settle().unwindStagedDayPage(_key());
        _settle().unwindStagedDayPage(_key());
        assertTrue(_mut().entryExecutableNowRaw(bobEntry), "executable again once it released");
        uint256 bobBefore = vpfi.balanceOf(bob);
        vm.prank(bob);
        (uint256 paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewards();
        assertEq(paid, NEED, "paid in full once the reservation released, not trimmed to the room it left");
        assertEq(vpfi.balanceOf(bob) - bobBefore, NEED);
    }

    function test_ARecycledReservation_PausesTheExpiryClock() public {
        // A day of half fresh, half recycled composition; the bucket holds
        // the recycled leg twice over. A reservation of the bucket that
        // leaves less than the leg reads non-executable — the same figure
        // the claim walk draws against — and executable again once released.
        _armedDay(1, NEED); // day 1 finalized, so the cumulative reaches day 2
        _mut().setDayPoolStampRaw(2, uint128(1e18), uint128(1e18));
        _mut().setKnownGlobalDailyInterest(2, 1e18, 0, true);
        _mut().setDayCapThreshold18(2, type(uint256).max);
        _mut().setDayCapModeRaw(2, 1);
        _mut().setDayUserSideCapRaw(2, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(1);
        address bob = makeAddr("staging-bob");
        uint256 bobEntry = _mut().pushRewardEntry(bob, LOAN, LibVaipakam.RewardSide.Lender, 1e18, 2);
        _mut().closeRewardEntryRaw(bobEntry, 3);
        _mut().userClaimFundingNeedRaw(bob);
        _liveFresh(2e18);
        _mut().setRecycleBucketRaw(2 * NEED);
        assertTrue(_mut().entryExecutableNowRaw(bobEntry), "live: bucket and fresh cover the day");
        _mut().setRecycleBucketReservedRaw(2 * NEED - NEED / 4); // a quarter of the need left available
        assertFalse(_mut().entryExecutableNowRaw(bobEntry), "a reservation of the bucket pauses the clock");
        _mut().setRecycleBucketReservedRaw(0);
        assertTrue(_mut().entryExecutableNowRaw(bobEntry), "released: executable again");
    }

    /// @dev An epoch listing day 1 linked with both predecessors named.
    function _epochOfHinted(uint256 remitId, bytes32 id, bytes32 hint, bytes32 lateHint, bool late) internal returns (bytes32 h) {
        _ingress().onRewardBudgetReceived(address(vpfi), TINY, _one(1), CHAIN_BASE, remitId, REMITTER, 0, 0, id, false);
        h = keccak256(abi.encode(uint256(CHAIN_BASE), id));
        bytes32[] memory hints = new bytes32[](1);
        hints[0] = hint;
        bytes32[] memory lateHints = new bytes32[](late ? 1 : 0);
        if (late) lateHints[0] = lateHint;
        _epoch().materializeTransportBatchPageHinted(h, _one(1), hints, lateHints);
    }

    function test_ADeepLateChain_LinksByTheLateHint() public {
        // 65 epochs listed; then 130 arrive each OLDER than everything before
        // it, so each links at the head of the list and of the late chain.
        // Past 128 late links the unhinted late walk is refused whatever the
        // list hint says; the late hint places the link in constant work.
        _scene();
        _wideDay(true);
        uint256 t0 = arrivedAt[0];
        for (uint256 i; i < 129; ++i) {
            vm.warp(t0 - 10 * (i + 1));
            _epochOfHinted(1000 + i, keccak256(abi.encode("older", i)), bytes32(0), bytes32(0), true);
        }
        // The 130th: the list hint alone is refused — the late chain is deeper
        // than the bounded walk — and with the late hint it links.
        vm.warp(t0 - 10 * 130);
        _ingress().onRewardBudgetReceived(address(vpfi), TINY, _one(1), CHAIN_BASE, 1130, REMITTER, 0, 0, keccak256("older-130"), false);
        bytes32 h130 = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("older-130")));
        bytes32[] memory hints = new bytes32[](1);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.TransportIndexWalkExceeded.selector, h130, uint256(1)));
        _epoch().materializeTransportBatchPageHinted(h130, _one(1), hints, new bytes32[](0));
        // A wrong late hint — the chain's newest, which sorts after this
        // link — is refused, never mis-orders.
        bytes32 newestLate = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256(abi.encode("older", uint256(0)))));
        bytes32[] memory wrong = new bytes32[](1);
        wrong[0] = newestLate;
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.TransportIndexHintInvalid.selector, h130, uint256(1), newestLate));
        _epoch().materializeTransportBatchPageHinted(h130, _one(1), hints, wrong);
        assertEq(_epoch().materializeTransportBatchPageHinted(h130, _one(1), hints, new bytes32[](1)), 1, "linked by the late hint");
        bytes32[] memory ids = _epoch().getTransportDayScanIds(1);
        assertEq(ids[0], h130, "the oldest stands first in the list");
    }

    // ───────────────────────── round 5 ─────────────────────────

    function test_ARecheckedEpoch_MetAgainByARestartedChainWalk_IsPlannedOnce() public {
        _stagedAndScanned();
        uint256 t0 = arrivedAt[0];
        // An untyped epoch older than everything: the chain's head, remembered
        // as pending by the next preparation.
        vm.warp(t0 - 1000);
        bytes32 l1 = _epochOf(TINY, 810, keccak256("late-untyped"));
        vm.warp(arrivedAt[64] + 200);
        _staging().prepareStagedDay(_key());
        assertEq(_rec().skippedCount, 1, "remembered");
        // It is attested, and an older typed epoch lands ahead of it in the
        // chain: the generation moves and the next walk restarts from the
        // chain's head — where it meets the re-checked epoch again.
        _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, 810, TINY, 0);
        vm.warp(t0 - 2000);
        bytes32 l2 = _epochOf(TINY, 811, keccak256("late-typed"));
        _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, 811, TINY, 0);
        vm.warp(arrivedAt[64] + 300);
        (uint256 sf, ) = _staging().prepareStagedDay(_key());
        assertEq(sf, 2 * TINY, "each staged once: the re-check and the new link");
        assertEq(_rec().batchCount, WIDE + 2);
        (uint256 s1, , uint256 r1) = _staged(l1);
        assertEq(s1, TINY); assertEq(r1, 1);
        (uint256 s2, , uint256 r2) = _staged(l2);
        assertEq(s2, TINY); assertEq(r2, 1);
        assertEq(_rec().skippedCount, 0, "forgotten once offered");
    }

    function test_ADemotion_LeavesTheReservedLiveFresh_InTheRowAndOnTheLedger() public {
        _stagedAndScanned();
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        uint256 reserved = _rec().reservedLiveUserFresh;
        assertEq(reserved, NEED - WIDE * TINY);
        uint256 row = _row(LibVaipakam.RewardCustodyRow.LiveFresh);
        assertGt(row, reserved, "live: the row holds more than the reservation");
        // A compensation demotion asks to uncredit more than the row holds:
        // it takes everything but the reservation, on the row and on the
        // delivered ledger alike, and the record still pays its last page.
        uint256 moved = _mut().uncreditFreshInHolderRaw(2e18);
        assertEq(moved, row - reserved, "the reserved live fresh is not the demotion's to take");
        assertEq(_row(LibVaipakam.RewardCustodyRow.LiveFresh), reserved, "it stays in the row");
        uint256 aliceBefore = vpfi.balanceOf(alice);
        _settle().resolveStagedDayPage(_key());
        assertTrue(_settle().resolveStagedDayPage(_key()), "and the last page pays");
        assertEq(vpfi.balanceOf(alice) - aliceBefore, NEED);
        assertEq(_row(LibVaipakam.RewardCustodyRow.LiveFresh), 0);
    }

    function test_TheLens_ReportsWhatIsReserved_AndWhatIsAvailable() public {
        _stagedAndScanned();
        _liveFresh(1e18);
        InteractionRewardsLensFacet lens = InteractionRewardsLensFacet(address(diamond));
        (uint256 pr, uint256 pa, uint256 ar, uint256 lr, uint256 la, uint256 se, uint256 br, uint256 ba) = lens.getRewardReservations();
        assertEq(pr + ar + lr + br, 0, "nothing reserved before the reservation");
        assertEq(pa, lens.getInteractionPoolRemaining(), "available equals the hard figure");
        assertEq(la, _row(LibVaipakam.RewardCustodyRow.LiveFresh), "the live fresh available is the whole row before the reservation");
        assertEq(se, WIDE * TINY, "the staged epoch value is published as its own earmark");
        _staging().reserveStagedDay(_key());
        (pr, pa, ar, lr, la, se, br, ba) = lens.getRewardReservations();
        assertEq(la, _row(LibVaipakam.RewardCustodyRow.LiveFresh) - lr, "and the row less the reservation after it");
        uint256 live = NEED - WIDE * TINY;
        assertEq(pr, NEED, "the pool cap over the full fresh leg");
        assertEq(pa, lens.getInteractionPoolRemaining() - NEED, "available is the hard figure less the reservation");
        assertEq(ar, live, "the delivered ledger's reserved charge");
        assertEq(lr, live, "the live fresh reserved by count");
        assertEq(br, 0); ba;
        assertEq(lens.getLoanSideRewardReserved(LOAN, LibVaipakam.RewardSide.Lender), NEED, "the loan side's reservation");
        (, uint256 remaining) = RewardRemittanceLensFacet(address(diamond)).getDeliveredFreshBound();
        assertEq(remaining, 1e18 - live, "the delivered bound is net of the reservation");
    }

    function test_AChainRestart_CountsItsOwnWork_InTheDeadline() public {
        // Seventy older epochs stand in the day's late chain BEFORE the record
        // opens: its deadline counts none of them (the base is the count at
        // opening). One more, older than all, lands ahead of the record's
        // place: the walk restarts from the chain's head and the deadline
        // grows by the pages that walk needs.
        _scene();
        _wideDay(true);
        uint256 t0 = arrivedAt[0];
        for (uint256 i; i < 70; ++i) {
            vm.warp(t0 - 1000 + i);
            _epochOf(TINY, 800 + i, keccak256(abi.encode("older", i)));
            _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, 800 + i, TINY, 0);
        }
        vm.warp(arrivedAt[64] + 100);
        assertEq(_claim(), 0);
        RewardEpochViewFacet.StagingRecordView memory r = _rec();
        assertEq(r.lateWorkBase, 70, "the chain's count at opening");
        // 135 members past the cursor, no late work: three pages.
        assertEq(r.deadline, r.openedAt + 3 days + 3 days);
        _staging().prepareStagedDay(_key());
        _staging().prepareStagedDay(_key());
        _staging().prepareStagedDay(_key());
        assertTrue(_rec().scanComplete);
        assertEq(_rec().deadline, r.openedAt + 3 days + 3 days, "unchanged by the record's own pages");
        vm.warp(t0 - 2000);
        // Older than all 135: beyond the unhinted walk, so both predecessors
        // are named — the list's head and the chain's head.
        _epochOfHinted(899, keccak256("older-than-all"), bytes32(0), bytes32(0), true);
        _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, 899, TINY, 0);
        vm.warp(arrivedAt[64] + 200);
        _staging().prepareStagedDay(_key()); // the restart: the chain from its head
        assertEq(_rec().lateWorkBase, 70, "the base is the count at opening, still");
        assertEq(_rec().lateWorkRestored, 71, "the restart restored the whole chain's walk");
        // 136 members, one link since opening, 71 restored: four pages.
        assertEq(_rec().deadline, r.openedAt + 4 days + 3 days, "the deadline grew by the restored page");
        // A SECOND restart — another epoch older than all — restores the
        // walk again, and the deadline grows again (Codex #2308 r10).
        vm.warp(t0 - 3000);
        _epochOfHinted(898, keccak256("older-than-all-2"), bytes32(0), bytes32(0), true);
        _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, 898, TINY, 0);
        vm.warp(arrivedAt[64] + 300);
        _staging().prepareStagedDay(_key());
        assertEq(_rec().lateWorkRestored, 71 + 72, "each restart adds the chain it re-walks");
        // 137 members, two links since opening, 143 restored: five pages.
        assertEq(_rec().deadline, r.openedAt + 5 days + 3 days, "the second restart's pages are in the lease too");
    }

    // ───────────────────────── round 6 ─────────────────────────

    function test_AStandingRecord_PausesTheClaimantsExpiryClock() public {
        // A standing record implies a day wider than one window, so there is
        // no executable state of this scene to straddle: the mutation check
        // (the record dropped from the refusal rule) is the discrimination.
        (, uint256 id) = _stagedScene();
        _liveFresh(1e18);
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.Staging), "the record stands");
        assertEq(_preview(), 0, "the dry run defers on the record");
        assertFalse(_mut().entryExecutableNowRaw(id), "the clock does not count the interval the record holds");
    }

    function test_TheView_PagesTheRecordsEntriesAndPending() public {
        (, uint256 id) = _scene2Typed();
        RewardEpochViewFacet.StagingRecordView memory r = _rec();
        assertEq(r.entryCount, 1);
        (uint256[] memory eids, uint256[] memory amounts, bool[] memory chargeable) = _view().getStagingRecordEntries(_key(), 0, 10);
        assertEq(eids.length, 1); assertEq(eids[0], id);
        assertEq(amounts[0], 0, "no slice before the reservation");
        assertFalse(chargeable[0]);
        _staging().prepareStagedDay(_key());
        bytes32[] memory pending = _view().getStagingRecordPending(_key(), 0, 100);
        assertEq(pending.length, 62, "the untyped epochs the scan passed over");
        bytes32[] memory page = _view().getStagingRecordPending(_key(), 60, 100);
        assertEq(page.length, 2, "paged from an offset");
        assertEq(page[0], pending[60]);
        assertEq(_view().getStagingRecordPending(_key(), 62, 10).length, 0, "past the end");
    }

    function test_AnExplicitVenue_RidesTheClaimIntoTheRecord() public {
        // Alice has a vault, so her DEFAULT delivery is the vault; she claims
        // to her WALLET explicitly. The day stages; the record carries the
        // wallet, and the payout reaches it.
        _scene();
        _wideDay(true);
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(alice);
        vm.prank(alice);
        (uint256 paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewardsTo(LibVaipakam.RewardDelivery.Wallet);
        assertEq(paid, 0);
        RewardEpochViewFacet.StagingRecordView memory r = _rec();
        assertTrue(r.venueSet, "the explicit venue is bound at opening");
        assertEq(r.venue, uint8(LibVaipakam.RewardDelivery.Wallet));
        _staging().prepareStagedDay(_key());
        _staging().prepareStagedDay(_key());
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        uint256 walletBefore = vpfi.balanceOf(alice);
        uint256 vaultBefore = vpfi.balanceOf(vault);
        _settle().resolveStagedDayPage(_key());
        assertTrue(_settle().resolveStagedDayPage(_key()));
        assertEq(vpfi.balanceOf(alice) - walletBefore, NEED, "paid to the wallet the claim named");
        assertEq(vpfi.balanceOf(vault), vaultBefore, "not to the vault the default would have chosen");
    }

    function test_ADefaultClaim_BindsNoVenue() public {
        _stagedScene();
        assertFalse(_rec().venueSet, "a default claim leaves the venue to the record's payout");
    }

    function test_APendingOverflow_StopsPreparation_AndStagesNothingMore() public {
        // Two typed epochs and 128 untyped ones on the day: the record opens
        // on the two, and its scans pass more pending epochs than it tracks.
        _scene();
        _wideDayTyped(2);
        // A typed epoch between the two wide days: it sits in the page that
        // overflows, so that page has something it would otherwise stage.
        vm.warp(block.timestamp + 10);
        bytes32 typedLate = _epochOf(TINY, 950, keccak256("typed-late"));
        _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, 950, TINY, 0);
        vm.warp(block.timestamp + 10);
        _wideDayTypedFrom(0, 300); // 65 more, all untyped
        assertEq(_claim(), 0);
        assertEq(_rec().batchCount, 2);
        _staging().prepareStagedDay(_key()); // the window rescanned: 62 pending
        assertFalse(_rec().pendingOverflow);
        // The next page passes 63 more: the tracked page overflows, and the
        // page stages nothing — not even the typed epoch in it.
        (uint256 sf, ) = _staging().prepareStagedDay(_key());
        assertTrue(_rec().pendingOverflow, "more pending epochs than the record tracks");
        assertEq(sf, 0, "the overflowing page stages nothing");
        (, , uint256 refs) = _staged(typedLate);
        assertEq(refs, 0, "no new reference for a record that can only be unwound");
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.StagingPendingOverflow.selector, _key()));
        _staging().prepareStagedDay(_key());
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.StagingPendingOverflow.selector, _key()));
        _staging().reserveStagedDay(_key());
        // Unwindable by the claimant now, by anyone past the deadline.
        vm.prank(alice);
        _settle().unwindStagedDayPage(_key());
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.None));
    }

    /// @dev Two typed epochs among 65 and the claim: the walk stages the two.
    function _scene2Typed() internal returns (bytes32[] memory hs, uint256 id) {
        id = _scene();
        hs = _wideDayTyped(2);
        assertEq(_claim(), 0);
    }

    // ───────────────────────── round 7 ─────────────────────────

    event StagingCooldownSet(bytes32 indexed key, uint64 until);

    function test_AReservedRecord_IsCounted_ForEveryPostureGate() public {
        _stagedAndScanned();
        _liveFresh(1e18);
        assertEq(_mut().stagingEncumberedCountRaw(), 0, "staging alone encumbers nothing");
        _staging().reserveStagedDay(_key());
        assertEq(_mut().stagingEncumberedCountRaw(), 1, "encumbered from the reservation");
        assertEq(_view().getStagingEncumberedCount(), 1, "and read by every posture gate");
        _settle().resolveStagedDayPage(_key());
        assertEq(_mut().stagingEncumberedCountRaw(), 1, "still, while it resolves");
        assertTrue(_settle().resolveStagedDayPage(_key()));
        assertEq(_mut().stagingEncumberedCountRaw(), 0, "released with the payout");
    }

    function test_TheCooldown_IsPublished() public {
        _stagedAndScanned();
        uint64 deadline = _rec().deadline;
        assertEq(_view().getStagingCooldown(alice, LibVaipakam.RewardSide.Lender, 1), 0, "none before a release");
        vm.warp(uint256(deadline) + 1);
        _settle().unwindStagedDayPage(_key());
        uint64 until = uint64(block.timestamp) + 3 days;
        vm.expectEmit(true, false, false, true);
        emit StagingCooldownSet(_key(), until);
        assertTrue(_settle().unwindStagedDayPage(_key()));
        assertEq(_view().getStagingCooldown(alice, LibVaipakam.RewardSide.Lender, 1), until, "read back");
        vm.warp(uint256(until));
        assertEq(_view().getStagingCooldown(alice, LibVaipakam.RewardSide.Lender, 1), 0, "passed is none, as the claim path reads it");
        vm.warp(uint256(until) - 1);
        vm.prank(alice);
        (bool ok, ) = address(diamond).call(abi.encodeWithSelector(RewardClaimFacet.claimInteractionRewards.selector));
        ok; // deferred either way: the cooldown is what says why
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.None), "no record while the published cooldown stands");
    }

    // ───────────────────────── round 8 ─────────────────────────

    function test_TheRecheckPage_IsReconciledBeforeTheCapIsEnforced() public {
        // Sixty-four pending epochs fill the record's page exactly; one of
        // them becomes stageable and a new pending epoch lands. The re-check
        // frees a place before the new epoch takes one, so nothing overflows.
        _scene();
        _wideDayTyped(2); // 2 typed, 63 untyped
        vm.warp(block.timestamp + 10);
        _epochOf(TINY, 960, keccak256("extra-untyped")); // the 64th pending
        assertEq(_claim(), 0);
        _staging().prepareStagedDay(_key()); // the window: 62 pending
        _staging().prepareStagedDay(_key()); // the 65th and 66th: 64 pending, the page full
        assertEq(_rec().skippedCount, 64);
        assertFalse(_rec().pendingOverflow);
        _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, 100 + 10, TINY, 0); // one becomes stageable
        vm.warp(block.timestamp + 10);
        _epochOf(TINY, 961, keccak256("new-untyped")); // a new pending epoch
        (uint256 sf, ) = _staging().prepareStagedDay(_key());
        assertFalse(_rec().pendingOverflow, "reconciled first: the page still fits");
        assertEq(sf, TINY, "the re-checked epoch is staged");
        assertEq(_rec().skippedCount, 64, "one forgotten, one remembered");
    }

    function test_TheAggregatePreview_CountsALegacyForfeitOnce() public {
        _stagedAndScanned();
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key()); // NEED of the pool reserved
        // The delivered ledger is ample, so the pool's availability is the
        // only figure that can defer bob's preview below.
        _mut().setArmedFreshLedgerRaw(4000e18, 0);
        // Bob holds a forfeited LEGACY entry on day 2 (finalized, and the
        // arming now starts at day 3, so the cumulative — not yet advanced
        // past day 1 — takes the day as legacy): its fresh goes to the
        // treasury and is a leg of the claim's aggregate exactly once.
        _armedDay(2, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(3);
        address bob = makeAddr("staging-bob");
        _mut().setFeeEntitlementRaw(
            78,
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
        uint256 bobEntry = _mut().pushRewardEntry(bob, 78, LibVaipakam.RewardSide.Lender, 0.1e18, 2);
        _mut().closeRewardEntryRaw(bobEntry, 3);
        _mut().setRewardEntryForfeitedRaw(bobEntry);
        _mut().userClaimFundingNeedRaw(bob);
        InteractionRewardsLensFacet lens = InteractionRewardsLensFacet(address(diamond));
        (, , uint256 treasuryLegs, uint256 legacyFresh, , , ) = lens.getUserArmedFreshNeedWithLegs(bob);
        assertGt(treasuryLegs, 0, "live: the forfeit's fresh is a treasury leg");
        assertEq(legacyFresh, treasuryLegs, "and the same figure is the legacy fresh");
        // Availability between the aggregate counted once and counted twice.
        uint256 available = treasuryLegs + treasuryLegs / 2;
        _mut().setInteractionPoolPaidOut(LibVaipakam.VPFI_INTERACTION_POOL_CAP - NEED - available);
        assertEq(_mut().poolAvailableRaw(), available);
        (uint256 amount, uint256 fromDay, ) = lens.previewInteractionRewards(bob);
        assertEq(amount, 0, "a forfeit pays the user nothing");
        assertEq(fromDay, 1, "not deferred: the forfeit's fresh fits availability, counted once");
    }

    // ───────────────────────── round 9 ─────────────────────────

    function test_AShrunkPool_StopsFurtherStaging_ButNotTheScan() public {
        _stagedScene(); // 0.32 staged; the day's need 0.4
        _mut().setInteractionPoolPaidOut(LibVaipakam.VPFI_INTERACTION_POOL_CAP - 0.2e18); // the pool can pay 0.2, ever
        _staging().prepareStagedDay(_key()); // the window rescanned
        (uint256 sf, ) = _staging().prepareStagedDay(_key()); // the 65th: stageable, but nothing is asked
        assertEq(sf, 0, "no more is staged than the pool could ever pay");
        assertEq(_rec().batchCount, 64, "the 65th is not referenced");
        assertTrue(_rec().scanComplete, "yet the scan reached the list's end");
        assertEq(_balance(_staged65()), TINY, "the 65th keeps its balance for the days that can use it");
    }

    function _staged65() internal view returns (bytes32) {
        return keccak256(abi.encode(uint256(CHAIN_BASE), keccak256(abi.encode("tiny", uint256(100), uint256(64)))));
    }

    // ───────────────────────── round 11 ─────────────────────────

    function test_EveryBucketDebit_HonoursTheReservation() public {
        // The bucket holds 1.0 with nothing committed; a staging reservation
        // of 0.4 stands by count. What any non-settlement debit may take is
        // 0.6, and a settlement may never consume below the reservation.
        _mut().setRecycleBucketRaw(1e18);
        _mut().setRecycleBucketReservedRaw(0.4e18);
        assertEq(_mut().bucketFundableRaw(), 0.6e18, "fundable is the bucket less the reservation (nothing committed)");
        vm.expectRevert(abi.encodeWithSelector(LibVpfiRecycle.RepatriationExceedsFundable.selector, 0.7e18, 0.6e18));
        _mut().debitRepatriationSurplusRaw(0.7e18);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.RecycleBucketReservedShortfall.selector, 0.7e18, 0.6e18));
        _mut().consumeRecycleBucketRaw(0.7e18);
        _mut().consumeRecycleBucketRaw(0.6e18);
        assertEq(_mut().bucketFundableRaw(), 0, "exactly the reservation is left");
        _mut().setRecycleBucketReservedRaw(0);
        assertEq(_mut().bucketFundableRaw(), 0.4e18, "released, it is fundable again");
    }

    // ───────────────────────── round 12 ─────────────────────────

    function test_AReservedLiveFreshRow_PausesTheExpiryClock() public {
        // The live fresh row holds 0.1; alice's record reserves 0.075 of it by
        // count, so the row reads 0.1 while the claim gate's room reads 0.025.
        // Bob needs 0.05: within the row, past the room — his claim would
        // refuse, so his clock must not run. Pool and delivered ledger ample.
        _stagedAndScanned();
        _liveFresh(0.1e18);
        _staging().reserveStagedDay(_key());
        _mut().setArmedFreshLedgerRaw(4000e18, 0);
        assertEq(_row(LibVaipakam.RewardCustodyRow.LiveFresh), 0.1e18, "the row is never reduced by a reservation");
        assertEq(_mut().liveFreshReservedRaw(), NEED - WIDE * TINY);
        address bob = makeAddr("staging-bob");
        _armedDay(2, 0.05e18);
        _mut().setFeeEntitlementRaw(
            78,
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
        uint256 bobEntry = _mut().pushRewardEntry(bob, 78, LibVaipakam.RewardSide.Lender, 1e18, 2);
        _mut().closeRewardEntryRaw(bobEntry, 3);
        _mut().userClaimFundingNeedRaw(bob);
        assertFalse(_mut().entryExecutableNowRaw(bobEntry), "the room, not the row, is what the clock reads");
        // The reservation unwinds: the room is the row again, and bob's clock runs.
        vm.warp(uint256(_rec().deadline) + 1);
        _settle().unwindStagedDayPage(_key());
        _settle().unwindStagedDayPage(_key());
        assertTrue(_mut().entryExecutableNowRaw(bobEntry), "executable once the reservation released");
    }

    // ───────────────────────── round 13 ─────────────────────────

    function test_ARoleChange_IsRefusedWhileARecordIsReserved() public {
        _stagedAndScanned();
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        // The role decides the delivered allowance the payout charges, so a
        // transition may not straddle the reservation.
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.RewardRoleChangeBlockedByStagedRecords.selector, uint256(1)));
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(true);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.RewardRoleChangeBlockedByStagedRecords.selector, uint256(1)));
        RewardReporterFacet(address(diamond)).setBaseChainId(0);
        // Settled, the reservation is no longer what refuses: this scene has
        // custody activated, so the standing role FREEZE takes over — a
        // different gate, named differently, and the discrimination between
        // them is the point.
        _settle().resolveStagedDayPage(_key());
        assertTrue(_settle().resolveStagedDayPage(_key()));
        assertEq(_mut().stagingEncumberedCountRaw(), 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RewardRoleChangeFrozen.selector,
                uint8(LibVaipakam.RewardRole.Mirror),
                uint8(LibVaipakam.RewardRole.Detached)
            )
        );
        RewardReporterFacet(address(diamond)).setBaseChainId(0);
    }

    function test_EverySourceRoom_IsNetOfItsReservation() public {
        // Six sources carry a staging reservation, and each has ONE room the
        // gates read. With a record reserved, every room is its hard figure
        // less that source's reservation — the rule stated once, read here in
        // one place so a source added without a room fails this cell.
        _stagedAndScanned();
        _liveFresh(1e18);
        uint256 poolHard = _mut().poolRemainingRaw();
        uint256 rowHard = _row(LibVaipakam.RewardCustodyRow.LiveFresh);
        (, uint256 deliveredHard) = RewardRemittanceLensFacet(address(diamond)).getDeliveredFreshBound();
        uint256 stagedTotal = _rec().stagedFresh + _rec().stagedRecycled;
        _staging().reserveStagedDay(_key());
        InteractionRewardsLensFacet lens = InteractionRewardsLensFacet(address(diamond));
        (uint256 pr, uint256 pa, uint256 ar, uint256 lr, uint256 la, uint256 se, uint256 br, uint256 ba) = lens.getRewardReservations();
        assertEq(pa, poolHard - pr, "1: the interaction pool");
        assertEq(la, rowHard - lr, "2: the live fresh row");
        (, uint256 deliveredNow) = RewardRemittanceLensFacet(address(diamond)).getDeliveredFreshBound();
        assertEq(deliveredNow, deliveredHard - ar, "3: the delivered ledger");
        assertEq(ba, _mut().getRecycleBucketRaw() - br, "4: the recycled runway");
        assertEq(lens.getLoanSideRewardReserved(LOAN, LibVaipakam.RewardSide.Lender), NEED, "5: the loan side");
        assertEq(_mut().stagedEpochTotalRaw(), stagedTotal, "6: the staged epoch value, earmarked out of the Diamond's balance");
        assertEq(se, stagedTotal, "and published beside the five reservations");
        // And every one of them returns to its hard figure when the record
        // releases: one reservation, six sources, no residue.
        vm.warp(uint256(_rec().deadline) + 1);
        _settle().unwindStagedDayPage(_key());
        _settle().unwindStagedDayPage(_key());
        (pr, pa, ar, lr, la, se, br, ba) = lens.getRewardReservations();
        assertEq(pr + ar + lr + br + se, 0, "nothing reserved, nothing earmarked");
        assertEq(pa, poolHard); assertEq(la, rowHard);
        (, deliveredNow) = RewardRemittanceLensFacet(address(diamond)).getDeliveredFreshBound();
        assertEq(deliveredNow, deliveredHard, "the delivered ledger is whole again");
        assertEq(lens.getLoanSideRewardReserved(LOAN, LibVaipakam.RewardSide.Lender), 0);
        assertEq(_mut().stagedEpochTotalRaw(), 0, "and the staged earmark is gone with the batches");
    }

    // ───────────────────────── round 14 ─────────────────────────

    function test_TheConsumedEpochValue_StaysEarmarked_UntilTheLastPagePays() public {
        (bytes32[] memory hs, ) = _stagedAndScanned();
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        uint256 staged = WIDE * TINY;
        assertEq(_mut().stagedEpochTotalRaw(), staged, "the whole staged amount is earmarked");
        // Page one consumes sixty-four epochs and pays nothing: every wei of
        // it is still owed to the claimant, so the earmark does not move.
        assertFalse(_settle().resolveStagedDayPage(_key()));
        assertEq(_mut().stagedEpochTotalRaw(), staged, "consumed is not released: the payout has not happened");
        assertTrue(_settle().resolveStagedDayPage(_key()), "the last page pays");
        assertEq(_mut().stagedEpochTotalRaw(), 0, "and the earmark goes with the payout");
        _assertConserved(hs);
    }

    function test_TheReturnedExcess_LeavesTheEarmarkAtItsPage() public {
        // The re-price assigns 0.2 of the 0.325 staged: the excess returns to
        // its epochs page by page and leaves the earmark with them, while the
        // consumed 0.2 stays earmarked until the payout.
        (bytes32[] memory hs, ) = _stagedAndScanned();
        _mut().setInteractionPoolPaidOut(LibVaipakam.VPFI_INTERACTION_POOL_CAP - 0.2e18);
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        assertEq(_mut().stagedEpochTotalRaw(), WIDE * TINY);
        assertFalse(_settle().resolveStagedDayPage(_key()));
        // Forty of the sixty-four paid the budget; twenty-four went back.
        assertEq(_mut().stagedEpochTotalRaw(), WIDE * TINY - 24 * TINY, "the page released exactly what it returned");
        assertTrue(_settle().resolveStagedDayPage(_key()));
        assertEq(_mut().stagedEpochTotalRaw(), 0, "the last page released the consumed share and the last epoch");
        _assertConserved(hs);
    }
}
