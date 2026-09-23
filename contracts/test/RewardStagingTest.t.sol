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
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
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

    /// @dev `WIDE` attested fresh epochs, each `TINY`, all listing day 1, in
    ///      arrival order. Returns their ids in that order.
    function _wideDay(bool attested) internal returns (bytes32[] memory hs) {
        hs = new bytes32[](WIDE);
        for (uint256 i; i < WIDE; ++i) {
            vm.warp(block.timestamp + 1);
            hs[i] = _epochOf(TINY, 100 + i, keccak256(abi.encode("tiny", i)));
            if (attested) _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, 100 + i, TINY, 0);
        }
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

    function test_Reserve_HoldsTheResidualAndTheHeadroom_PerSource() public {
        _stagedScene();
        _staging().prepareStagedDay(_key());
        _liveFresh(1e18);
        uint256 poolBefore = _mut().poolRemainingRaw();
        _staging().reserveStagedDay(_key());
        RewardEpochViewFacet.StagingRecordView memory r = _rec();
        assertEq(r.phase, uint8(LibVaipakam.StagingPhase.Reserved));
        assertEq(r.needUserFresh, NEED, "the day's need, priced");
        assertEq(r.epochUserFresh, WIDE * TINY, "what the epochs cover");
        assertEq(r.reservedLiveUserFresh, NEED - WIDE * TINY, "the residual, reserved from live fresh");
        assertEq(r.reservedPoolCap, NEED, "the pool cap over the full fresh leg");
        assertEq(_mut().poolRemainingRaw(), poolBefore - NEED, "reserved reads as encumbered");
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

        assertFalse(_staging().resolveStagedDayPage(_key()), "page one: 64 of 65");
        RewardEpochViewFacet.StagingRecordView memory r = _rec();
        assertEq(r.phase, uint8(LibVaipakam.StagingPhase.Resolving), "irrevocable from the first page");
        assertEq(r.resolveCursor, 64);
        assertEq(r.heldEpoch, 64 * TINY, "the page's epoch legs are held");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Resolving), 64 * TINY, "in the resolving row");
        assertEq(unclassifiedBefore - _row(LibVaipakam.RewardCustodyRow.Unclassified), 64 * TINY, "out of the packets' row");
        (uint256 lf0, ) = _legs(hs[0]);
        (uint256 sf0, , uint256 refs0) = _staged(hs[0]);
        assertEq(lf0, TINY, "consumed");
        assertEq(sf0, 0);
        assertEq(refs0, 0, "released");
        assertEq(vpfi.balanceOf(alice), aliceBefore, "nothing paid between pages");
        _assertConserved(hs);

        assertTrue(_staging().resolveStagedDayPage(_key()), "page two: the last, and the payout");
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
        _staging().unwindStagedDayPage(_key());
        vm.warp(uint256(deadline) + 1);
        assertFalse(_staging().unwindStagedDayPage(_key()), "page one returns 64");
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.Unwinding));
        assertTrue(_staging().unwindStagedDayPage(_key()), "page two returns the last and closes");
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.None));
        for (uint256 i; i < WIDE; ++i) {
            (uint256 sf, , uint256 refs) = _staged(hs[i]);
            assertEq(_balance(hs[i]), TINY, "restored");
            assertEq(sf, 0);
            assertEq(refs, 0);
        }
        _assertConserved(hs);
        assertEq(_claim(), 0, "the next claim stages the window again");
        assertEq(_rec().batchCount, 64);
    }

    function test_TheClaimant_MayCancelBeforeTheDeadline_AndAReservationIsReleased() public {
        _stagedScene();
        _staging().prepareStagedDay(_key());
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        uint256 poolBefore = _mut().poolRemainingRaw();
        vm.startPrank(alice);
        _staging().unwindStagedDayPage(_key());
        _staging().unwindStagedDayPage(_key());
        vm.stopPrank();
        assertEq(_rec().phase, uint8(LibVaipakam.StagingPhase.None));
        assertEq(_mut().poolRemainingRaw(), poolBefore + NEED, "the pool reservation released");
        assertEq(_mut().liveFreshReservedRaw(), 0);
        assertEq(_mut().interactionPoolReservedRaw(), 0);
    }

    function test_AResolvingRecord_IsBeyondTheDeadline() public {
        _stagedScene();
        _staging().prepareStagedDay(_key());
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        _staging().resolveStagedDayPage(_key());
        vm.warp(block.timestamp + 365 days);
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.StagingPhaseInvalid.selector, _key(), uint8(LibVaipakam.StagingPhase.Resolving))
        );
        _staging().unwindStagedDayPage(_key());
        assertTrue(_staging().resolveStagedDayPage(_key()), "it only completes");
    }

    // ───────────────────────────── venue ─────────────────────────────

    function test_TheClaimant_BindsTheVenue_BeforeReservation() public {
        _stagedScene();
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.StagingVenueNotSettable.selector, _key()));
        _staging().setStagingVenue(_key(), LibVaipakam.RewardDelivery.Wallet);
        vm.prank(alice);
        _staging().setStagingVenue(_key(), LibVaipakam.RewardDelivery.Wallet);
        assertTrue(_rec().venueSet);
        assertEq(_rec().venue, uint8(LibVaipakam.RewardDelivery.Wallet));
        _staging().prepareStagedDay(_key());
        _liveFresh(1e18);
        _staging().reserveStagedDay(_key());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.StagingVenueNotSettable.selector, _key()));
        _staging().setStagingVenue(_key(), LibVaipakam.RewardDelivery.Vault);
    }
}
