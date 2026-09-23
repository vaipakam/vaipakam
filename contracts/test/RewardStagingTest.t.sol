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
        (f, r, ) = _epoch().getTransportBatchLegs(h);
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
        (uint256 sf, uint256 sr) = _staging().prepareStagedDay(_key());
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
        _stagedScene();
        _staging().prepareStagedDay(_key());
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
        assertEq(sf, 2 * TINY, "the late epoch and the 65th, each once");
        assertEq(_rec().batchCount, WIDE + 1);
        (uint256 lsf, , uint256 lrefs) = _staged(late);
        assertEq(lsf, TINY);
        assertEq(lrefs, 1);
    }

    function test_Resolution_ReturnsTheStagedExcess_TheRepriceDidNotAssign() public {
        (bytes32[] memory hs, ) = _stagedScene();
        _staging().prepareStagedDay(_key()); // 0.325 staged
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
        assertEq(_mut().poolRemainingRaw(), 0, "the pool is exactly spent");
        assertEq(_mut().interactionPoolReservedRaw(), 0, "none reserved");
        _assertConserved(hs);
    }

    function test_ASanctionedClaimant_IsPaidToTheVaultOrNotAtAll() public {
        _stagedScene();
        _staging().prepareStagedDay(_key());
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
        _stagedScene();
        _staging().prepareStagedDay(_key());
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
        _stagedScene(); // the continuation stands at the window's last epoch
        _staging().prepareStagedDay(_key()); // scan complete: 65 seen
        assertTrue(_rec().scanComplete);
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
        assertEq(r.skippedCount, 62, "the untyped epochs it passed over are remembered");
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
        (bytes32[] memory hs, ) = _stagedScene();
        _staging().prepareStagedDay(_key());
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
        _staging().prepareStagedDay(_key());
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
        _stagedScene();
        _staging().prepareStagedDay(_key());
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
        (bytes32[] memory hs, uint256 id) = _stagedScene();
        _staging().prepareStagedDay(_key());
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        uint256 aliceBefore = vpfi.balanceOf(alice);
        uint256 unclassifiedBefore = _row(LibVaipakam.RewardCustodyRow.Unclassified);

        assertFalse(_settle().resolveStagedDayPage(_key()), "page one: 64 of 65");
        RewardEpochViewFacet.StagingRecordView memory r = _rec();
        assertEq(r.phase, uint8(LibVaipakam.StagingPhase.Resolving), "irrevocable from the first page");
        assertEq(r.resolveCursor, 64);
        assertEq(r.heldEpoch, 64 * TINY, "the page's epoch legs are held");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Resolving), 64 * TINY, "in the resolving row");
        assertEq(_mut().attributedTotalRaw(), _rowsSum(), "and attributed, never sweepable");
        (, , , , , , , , , , uint256 resolvingRow) = _custody().rewardCustodyLedger();
        assertEq(resolvingRow, 64 * TINY, "and named in the ledger");
        assertEq(unclassifiedBefore - _row(LibVaipakam.RewardCustodyRow.Unclassified), 64 * TINY, "out of the packets' row");
        (uint256 lf0, ) = _legs(hs[0]);
        (uint256 sf0, , uint256 refs0) = _staged(hs[0]);
        assertEq(lf0, TINY, "consumed");
        assertEq(sf0, 0);
        assertEq(refs0, 0, "released");
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
        (bytes32[] memory hs, ) = _stagedScene();
        _staging().prepareStagedDay(_key());
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
        _stagedScene();
        _staging().prepareStagedDay(_key());
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
        _stagedScene();
        _staging().prepareStagedDay(_key());
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
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.StagingVenueNotSettable.selector, _key()));
        _settle().setStagingVenue(_key(), LibVaipakam.RewardDelivery.Vault);
    }
}
