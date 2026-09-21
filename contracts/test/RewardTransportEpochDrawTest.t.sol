// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {RewardEpochFacet} from "../src/facets/RewardEpochFacet.sol";
import {RewardEpochViewFacet} from "../src/facets/RewardEpochViewFacet.sol";
import {RewardIngressFacet} from "../src/facets/RewardIngressFacet.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {RewardHorizonSweepFacet} from "../src/facets/RewardHorizonSweepFacet.sol";
import {RewardReconciliationFacet} from "../src/facets/RewardReconciliationFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibVpfiRecycle} from "../src/libraries/LibVpfiRecycle.sol";
import {LibRewardCustody} from "../src/libraries/LibRewardCustody.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title RewardTransportEpochDrawTest
 * @notice #1566 transport epochs PR 3b-ii-A — the DRAWS: an obligation on an
 *         armed day that an old-wire delivery listed is paid from that
 *         delivery's epoch FIRST, ahead of the delivered ledger and the
 *         bucket, and every chokepoint downstream sees only the residual.
 *
 *         The fixture is a mirror with reward custody active, one armed day
 *         priced so that the claimant's need is exactly the per-user cap, and
 *         an untyped delivery listing that day. Each rule is then pinned from
 *         both sides: an epoch that covers the whole need against one that
 *         covers part of it; a day the epoch lists against one it does not;
 *         the settle against the preview that predicts it; the claim against
 *         the forfeit sweep; and the design's own allocation counter-examples
 *         against the rule as the facet applies it.
 */
contract RewardTransportEpochDrawTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    address internal alice;
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    address internal constant REMITTER = address(0xBA5E);
    uint256 internal constant SEED = 1_000_000 ether;
    uint64 internal constant LOAN = 77;
    /// @dev The claimant's need on the fixture's armed day: the per-user cap
    ///      binds below the day's 1e18 fresh half.
    uint256 internal constant NEED = 0.4e18;

    /// @dev Declared locally so `expectEmit` can name it; the emitter is the
    ///      library inlined into the epoch facet.
    event TransportDrawn(bytes32 indexed batchId, uint256 indexed dayId, uint256 fresh, uint256 recycled);
    event TransportDayCursorAdvanced(uint256 indexed dayId, uint256 cursor);

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
        vm.warp(block.timestamp + 60 days); // many finalized past days
        uint256 have = vpfi.balanceOf(address(this));
        if (SEED > have) vpfi.mint(address(this), SEED - have);
        vpfi.transfer(address(diamond), SEED);
        _becomeMirror();
        activateRewardCustodyForTest(address(vpfi), 0);
        alice = makeAddr("draw-alice");
    }

    // ─── fixture ────────────────────────────────────────────────────────────

    function _epoch() internal view returns (RewardEpochFacet) {
        return RewardEpochFacet(address(diamond));
    }

    function _epochView() internal view returns (RewardEpochViewFacet) {
        return RewardEpochViewFacet(address(diamond));
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

    function _cfg() internal view returns (ConfigFacet) {
        return ConfigFacet(address(diamond));
    }

    function _rlens() internal view returns (RewardRemittanceLensFacet) {
        return RewardRemittanceLensFacet(address(diamond));
    }

    function _becomeMirror() internal {
        vm.chainId(CHAIN_ARB);
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(false);
        RewardReporterFacet(address(diamond)).setBaseChainId(CHAIN_BASE);
        RewardRemittanceFacet(address(diamond)).setRewardRemittanceReceiver(address(this));
    }

    /// @dev An armed ShareOfPool day whose fresh half is 1e18 and whose sole
    ///      lender interest is the claimant's, so the raw price is 1e18 and
    ///      `cap` is what binds.
    function _armedDay(uint256 d, uint256 cap) internal {
        _mut().setDayPoolStampRaw(d, uint128(2e18), 0);
        _mut().setKnownGlobalDailyInterest(d, 1e18, 0, true);
        _mut().setDayCapThreshold18(d, type(uint256).max);
        _mut().setDayCapModeRaw(d, 1); // ShareOfPool
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

    /// @dev The standard scene: day 1 armed at `cap`, one closed entry on it,
    ///      nothing delivered to the live ledger.
    function _scene(uint256 cap) internal returns (uint256 id) {
        _armedDay(1, cap);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(1);
        id = _entry(1, 2);
        _mut().setArmedFreshLedgerRaw(0, 0);
        // The preview is a view: it cannot advance the side cursors the
        // production claim advances first, so the fixture does (this is
        // what the existing mirror preview tests do too).
        _mut().userClaimFundingNeedRaw(alice);
    }

    function _one(uint256 d) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = d;
    }

    function _two(uint256 d1, uint256 d2) internal pure returns (uint256[] memory a) {
        a = new uint256[](2);
        a[0] = d1;
        a[1] = d2;
    }

    /// @dev An old-wire (untyped) delivery: opens an epoch, then indexes it.
    function _epochOf(uint256 amount, uint256[] memory dayIds, uint256 remitId, bytes32 id)
        internal
        returns (bytes32 h)
    {
        _ingress().onRewardBudgetReceived(address(vpfi), amount, dayIds, CHAIN_BASE, remitId, REMITTER, 0, 0, id, false);
        h = keccak256(abi.encode(uint256(CHAIN_BASE), id));
        _epoch().materializeTransportBatchPage(h, dayIds);
    }

    /// @dev A typed (d5) delivery that is wholly fresh: credits the live row
    ///      and the delivered ledger, opens no epoch.
    function _liveOf(uint256 amount, uint256[] memory dayIds, uint256 remitId, bytes32 id) internal {
        uint256 before = _row(LibVaipakam.RewardCustodyRow.LiveFresh);
        _ingress().onRewardBudgetReceived(address(vpfi), amount, dayIds, CHAIN_BASE, remitId, REMITTER, 0, amount, id, true);
        assertEq(_row(LibVaipakam.RewardCustodyRow.LiveFresh) - before, amount, "fixture: the typed delivery is live-fresh");
    }

    function _claim() internal returns (uint256 paid) {
        vm.prank(alice);
        (paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewards();
    }

    function _preview() internal view returns (uint256 amount) {
        (amount, , ) = InteractionRewardsLensFacet(address(diamond)).previewInteractionRewards(alice);
    }

    function _row(LibVaipakam.RewardCustodyRow r) internal view returns (uint256) {
        return _custody().rewardCustodyRow(r);
    }

    function _legs(bytes32 h) internal view returns (uint256 f, uint256 r) {
        (f, r, ) = _epoch().getTransportBatchLegs(h);
    }

    function _beyond(bytes32 h) internal view returns (uint256 b) {
        (, , b) = _epoch().getTransportBatchLegs(h);
    }

    function _balance(bytes32 h) internal view returns (uint256 b) {
        (, b, , , , ) = _epoch().getTransportBatch(h);
    }


    /// @dev The allocation view takes one request struct; this keeps the
    ///      rule tests readable as eight figures.
    function _alloc(
        uint256 dayId,
        uint256 needF,
        uint256 needR,
        uint256 domF,
        uint256 domR,
        uint256 poolF,
        uint256 cap,
        uint256 bucket
    ) internal view returns (uint256 tf, uint256 tr, bool capHit) {
        LibRewardCustody.AllocRequest memory q;
        q.dayId = dayId;
        q.needFresh = needF;
        q.needRecycled = needR;
        q.domainFresh = domF;
        q.domainRecycled = domR;
        q.poolFresh = poolF;
        q.deliveredCap = cap;
        q.bucket = bucket;
        q.ovIds = new bytes32[](0);
        q.ovFresh = new uint256[](0);
        q.ovRecycled = new uint256[](0);
        LibRewardCustody.AllocResult memory r = _epoch().getTransportAllocationForDay(q);
        return (r.transportFresh, r.transportRecycled, r.capHit);
    }

    function _cursor(uint256 d) internal view returns (uint256 c) {
        (, , , c) = _epoch().getTransportDayBatches(d, 0, 100);
    }

    // ─── the claim ──────────────────────────────────────────────────────────

    function test_ArmedDayClaim_DrawsFromTheEpoch_NotTheDeliveredLedger() public {
        _scene(NEED);
        bytes32 h = _epochOf(10e18, _one(1), 1, keccak256("e1"));
        uint256 rowBefore = _row(LibVaipakam.RewardCustodyRow.Unclassified);
        uint256 aliceBefore = vpfi.balanceOf(alice);
        assertEq(_preview(), NEED, "the preview prices the day from the epoch");

        vm.expectEmit(true, true, false, true, address(diamond));
        emit TransportDrawn(h, 1, NEED, 0);
        assertEq(_claim(), NEED, "paid in full");

        assertEq(vpfi.balanceOf(alice) - aliceBefore, NEED, "delivered to the wallet");
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(lf, NEED, "the fresh leg is recorded on the epoch");
        assertEq(lr, 0, "no recycled leg on a fresh-only day");
        assertEq(_balance(h), 10e18 - NEED, "the epoch fell by the draw");
        assertEq(_mut().getArmedFreshPaidRaw(), 0, "the delivered ledger is NOT charged");
        assertEq(rowBefore - _row(LibVaipakam.RewardCustodyRow.Unclassified), NEED, "the Unclassified row fell by the draw");
        assertEq(_rlens().getIngressPacket(h).unclassified, 10e18 - NEED, "the packet's untyped remainder fell with it");
        assertEq(_cursor(1), 0, "an epoch with balance left keeps its place");
        assertEq(_preview(), 0, "nothing left to preview");
    }

    function test_TransportFirst_AheadOfALiveLedgerThatCouldHavePaid() public {
        _scene(NEED);
        _liveOf(1e18, _one(1), 1, keccak256("live"));
        bytes32 h = _epochOf(10e18, _one(1), 2, keccak256("e1"));
        uint256 liveBefore = _row(LibVaipakam.RewardCustodyRow.LiveFresh);

        assertEq(_claim(), NEED);
        (uint256 lf, ) = _legs(h);
        assertEq(lf, NEED, "the epoch paid, though the ledger could have");
        assertEq(_mut().getArmedFreshPaidRaw(), 0, "the delivered ledger untouched");
        assertEq(_row(LibVaipakam.RewardCustodyRow.LiveFresh), liveBefore, "the live row untouched");
    }

    function test_AShortEpochPaysWhatItHolds_TheLedgerTheRest_AndIsRetired() public {
        _scene(NEED);
        _liveOf(1e18, _one(1), 1, keccak256("live"));
        bytes32 h = _epochOf(0.1e18, _one(1), 2, keccak256("short"));
        uint256 liveBefore = _row(LibVaipakam.RewardCustodyRow.LiveFresh);
        uint256 unclBefore = _row(LibVaipakam.RewardCustodyRow.Unclassified);

        vm.expectEmit(true, false, false, true, address(diamond));
        emit TransportDayCursorAdvanced(1, 1);
        assertEq(_claim(), NEED, "paid in full from both sources");

        (uint256 lf, ) = _legs(h);
        assertEq(lf, 0.1e18, "the epoch paid what it held");
        assertEq(_balance(h), 0, "and is exhausted");
        assertEq(_mut().getArmedFreshPaidRaw(), NEED - 0.1e18, "the ledger charged for the residual only");
        assertEq(liveBefore - _row(LibVaipakam.RewardCustodyRow.LiveFresh), NEED - 0.1e18, "the live row paid the residual");
        assertEq(unclBefore - _row(LibVaipakam.RewardCustodyRow.Unclassified), 0.1e18, "the Unclassified row paid the leg");
        assertEq(_cursor(1), 1, "the day's cursor moved past the exhausted epoch");
    }

    function test_AnEpochListingAnotherDay_IsNotThisDaysCoverage() public {
        _scene(NEED);
        bytes32 h = _epochOf(10e18, _one(2), 1, keccak256("elsewhere"));
        assertEq(_preview(), 0, "day 1 has no coverage");
        vm.prank(alice);
        vm.expectRevert(IVaipakamErrors.NoInteractionRewardsToClaim.selector);
        RewardClaimFacet(address(diamond)).claimInteractionRewards();
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(lf + lr, 0, "nothing drawn");
        assertEq(_mut().getArmedFreshPaidRaw(), 0);
    }

    function test_ThePreviewIsTheClaim_WithAndWithoutCoverage() public {
        _scene(NEED);
        _epochOf(0.25e18, _one(1), 1, keccak256("part"));
        _liveOf(0.05e18, _one(1), 2, keccak256("live"));
        // 0.25 epoch + 0.05 live < 0.4 need: the residual has no source, the day
        // defers on the delivered bound — the preview and the claim agree.
        assertEq(_preview(), 0, "deferred: the preview says so");
        vm.prank(alice);
        vm.expectRevert(IVaipakamErrors.NoInteractionRewardsToClaim.selector);
        RewardClaimFacet(address(diamond)).claimInteractionRewards();
        _liveOf(0.1e18, _one(1), 3, keccak256("more"));
        _mut().userClaimFundingNeedRaw(alice);
        uint256 p = _preview();
        assertEq(p, NEED, "now covered: 0.25 epoch + 0.15 live");
        assertEq(_claim(), p, "and the claim pays exactly that");
        assertEq(_mut().getArmedFreshPaidRaw(), 0.15e18, "the ledger charged for the live share");
    }

    function test_ClaimToTheVault_CarriesTheEpochLeg() public {
        _scene(NEED);
        _liveOf(0.1e18, _one(1), 1, keccak256("live"));
        _epochOf(0.3e18, _one(1), 2, keccak256("e"));
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(alice);
        uint256 vaultBefore = vpfi.balanceOf(vault);
        assertEq(_claim(), NEED);
        assertEq(vpfi.balanceOf(vault) - vaultBefore, NEED, "the vault received live + epoch legs");
        assertEq(_mut().getArmedFreshPaidRaw(), 0.1e18, "the ledger charged for the live share only");
    }

    function test_Conservation_HoldsAfterADraw() public {
        _scene(NEED);
        bytes32 h = _epochOf(10e18, _one(1), 1, keccak256("e1"));
        _claim();
        (, uint256 balance, uint256 admitted, , , ) = _epoch().getTransportBatch(h);
        (uint256 parked, , , , uint256 debited) = _epoch().getTransportRemainder(h);
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(balance + parked + debited + lf + lr, admitted, "admitted == balance + parked + debited + legs");
    }

    // ─── the forfeit sweep (row 1) ──────────────────────────────────────────

    function test_ForfeitSweep_AbsorbsTheEpochPaidLeg_InPlace() public {
        uint256 id = _scene(NEED);
        _mut().setRewardEntryForfeitedRaw(id);
        _mut().setLoanActiveLenderEntryId(LOAN, id);
        bytes32 h = _epochOf(10e18, _one(1), 1, keccak256("e1"));
        uint256 bucketBefore = _cfg().getRecycleBucket();
        uint256 recycledBefore = _row(LibVaipakam.RewardCustodyRow.Recycled);
        uint256 unclBefore = _row(LibVaipakam.RewardCustodyRow.Unclassified);

        uint256 swept = InteractionRewardsFacet(address(diamond)).sweepForfeitedInteractionRewards(LOAN);
        assertEq(swept, NEED, "the forfeit settled from the epoch, with the live row empty");
        (uint256 lf, ) = _legs(h);
        assertEq(lf, NEED, "the fresh leg recorded on the epoch");
        assertEq(_cfg().getRecycleBucket() - bucketBefore, NEED, "the bucket credited: recycled in place");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Recycled) - recycledBefore, NEED, "the recycled row grew");
        assertEq(unclBefore - _row(LibVaipakam.RewardCustodyRow.Unclassified), NEED, "out of the Unclassified row");
        assertEq(_mut().getArmedFreshPaidRaw(), 0, "the delivered ledger untouched");
    }

    function test_ForfeitSweep_WithNoCoverageAndNoBacking_StillDefers() public {
        uint256 id = _scene(NEED);
        _mut().setRewardEntryForfeitedRaw(id);
        _mut().setLoanActiveLenderEntryId(LOAN, id);
        uint256 bucketBefore = _cfg().getRecycleBucket();
        assertEq(InteractionRewardsFacet(address(diamond)).sweepForfeitedInteractionRewards(LOAN), 0, "deferred");
        assertEq(_cfg().getRecycleBucket(), bucketBefore, "no credit");
    }

    // ─── the expiry sweep (row 5) ───────────────────────────────────────────

    /// @dev The horizon clock accrues only while the entry is EXECUTABLE — and
    ///      with the live row empty it is executable only because row 13 reads
    ///      the need net of the epoch's coverage. So this test pins two things
    ///      at once: the predicate prices the day the way the settle does, and
    ///      the expiry that follows recycles the epoch-paid leg in place.
    function test_ExpirySweep_AccruesOnEpochCoverage_AndAbsorbsInPlace() public {
        uint256 id = _scene(NEED);
        _cfg().setRewardClaimHorizonDays(180);
        bytes32 h = _epochOf(10e18, _one(1), 1, keccak256("e1"));
        uint256 bucketBefore = _cfg().getRecycleBucket();
        uint256 unclBefore = _row(LibVaipakam.RewardCustodyRow.Unclassified);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        assertEq(RewardHorizonSweepFacet(address(diamond)).sweepExpiredInteractionRewards(ids), 0, "stamps only");
        uint256 remaining = 180 days + 90 days; // horizon + notice
        uint256 swept;
        while (remaining > 0) {
            uint256 step = remaining < 7 days ? remaining : 7 days; // the clock's max observation gap
            vm.warp(vm.getBlockTimestamp() + step);
            swept = RewardHorizonSweepFacet(address(diamond)).sweepExpiredInteractionRewards(ids);
            remaining -= step;
            if (swept > 0) break;
        }
        if (swept == 0) {
            vm.warp(vm.getBlockTimestamp() + 7 days);
            swept = RewardHorizonSweepFacet(address(diamond)).sweepExpiredInteractionRewards(ids);
        }
        assertEq(swept, NEED, "expired from the epoch, with the live row empty");
        (uint256 lf, ) = _legs(h);
        assertEq(lf, NEED, "the fresh leg recorded on the epoch");
        assertEq(_cfg().getRecycleBucket() - bucketBefore, NEED, "recycled in place");
        assertEq(unclBefore - _row(LibVaipakam.RewardCustodyRow.Unclassified), NEED, "out of the Unclassified row");
        assertEq(_mut().getArmedFreshPaidRaw(), 0, "the delivered ledger untouched");
    }

    // ─── the scan window ────────────────────────────────────────────────────

    function test_ACapHit_DefersTheDay_RatherThanPullTheLedger() public {
        _scene(NEED);
        _liveOf(1e18, _one(1), 1, keccak256("live"));
        // 65 one-wei epochs: the window sees 64 wei and reports it ended short
        // of the index; the ledger could pay the rest but must not.
        for (uint256 i; i < 65; ++i) {
            _epochOf(1, _one(1), 100 + i, keccak256(abi.encode("tiny", i)));
        }
        (uint256 avail, bool capHit) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 64, "one window");
        assertTrue(capHit, "and more beyond it");
        assertEq(_preview(), 0, "the preview defers");
        vm.prank(alice);
        vm.expectRevert(IVaipakamErrors.NoInteractionRewardsToClaim.selector);
        RewardClaimFacet(address(diamond)).claimInteractionRewards();
        assertEq(_mut().getArmedFreshPaidRaw(), 0, "the ledger was not pulled");
        assertEq(_cursor(1), 0, "nothing exhausted, nothing pruned");
    }

    function test_Prune_MovesPastEpochsAnotherDayExhausted() public {
        _armedDay(1, NEED);
        _armedDay(2, 0.3e18);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(1);
        _entry(2, 3); // the claimant's obligation is on day 2 only
        _mut().setArmedFreshLedgerRaw(0, 0);
        bytes32 a = _epochOf(0.1e18, _two(1, 2), 1, keccak256("a"));
        bytes32 b = _epochOf(0.1e18, _two(1, 2), 2, keccak256("b"));
        bytes32 c = _epochOf(0.1e18, _two(1, 2), 3, keccak256("c"));
        assertEq(_claim(), 0.3e18, "day 2 drained all three");
        assertEq(_balance(a) + _balance(b) + _balance(c), 0);
        assertEq(_cursor(2), 3, "day 2's cursor passed them as it drew");
        assertEq(_cursor(1), 0, "day 1's index still lists the husks");
        (uint256 avail, bool capHit) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 0);
        assertFalse(capHit);
        _epoch().epochPruneTransportDayCursor(1);
        assertEq(_cursor(1), 3, "pruned");
        _epoch().epochPruneTransportDayCursor(1);
        assertEq(_cursor(1), 3, "idempotent");
    }

    // ─── round 1: the seam's edges ──────────────────────────────────────────

    /// @dev A day priced with fresh AND recycled halves: the stamp carries a
    ///      recycled budget equal to the fresh half, so the claimant's capped
    ///      need splits across both legs.
    function _twoLegDay(uint256 d, uint256 cap) internal {
        _mut().setDayPoolStampRaw(d, uint128(2e18), uint128(2e18));
        _mut().setKnownGlobalDailyInterest(d, 1e18, 0, true);
        _mut().setDayCapThreshold18(d, type(uint256).max);
        _mut().setDayCapModeRaw(d, 1);
        _mut().setDayUserSideCapRaw(d, cap);
    }

    function _outstandingRecycled() internal view returns (uint256 o) {
        (, , , o, , , , ) = InteractionRewardsLensFacet(address(diamond)).getRecycleBackingSnapshot();
    }

    /// @dev A claim's recycled leg an epoch paid retires its commitment
    ///      without a bucket debit, exactly as a forfeit's does (Codex #2276
    ///      r1 P1): the outstanding recycled commitment falls by the epoch-paid
    ///      recycled, and the bucket does not move.
    function test_ClaimsEpochPaidRecycled_RetiresItsCommitment() public {
        _twoLegDay(1, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(1);
        _entry(1, 2);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        (uint256 needF, uint256 needR) = _epochView().getObligationDomainNeeds(alice);
        assertGt(needR, 0, "fixture: a recycled leg");
        _liveOf(needF, _one(1), 1, keccak256("live"));
        bytes32 h = _epochOf(needR, _one(1), 2, keccak256("e"));
        _mut().setOutstandingCommitRaw(0, needR); // the commitment behind the recycled leg
        uint256 bucketBefore = _cfg().getRecycleBucket();
        assertEq(_claim(), NEED);
        (, uint256 lr) = _legs(h);
        assertEq(lr, needR, "the epoch paid the recycled leg");
        assertEq(_outstandingRecycled(), 0, "and its commitment retired");
        assertEq(_cfg().getRecycleBucket(), bucketBefore, "without a bucket debit");
    }

    /// @dev An epoch whose membership is still being written in pages is
    ///      invisible to every day until its last page lands (Codex #2276 r1
    ///      P1): a 40-day delivery indexes 32 days per call, and day 1 reads
    ///      no coverage from it until the second page.
    function test_AnIncompletelyIndexedEpoch_IsInvisibleUntilWhole() public {
        uint256[] memory days_ = new uint256[](40);
        for (uint256 i; i < 40; ++i) days_[i] = i + 1;
        bytes32 id = keccak256("wide");
        _ingress().onRewardBudgetReceived(address(vpfi), 10e18, days_, CHAIN_BASE, 1, REMITTER, 0, 0, id, false);
        bytes32 h = keccak256(abi.encode(uint256(CHAIN_BASE), id));
        assertEq(_epoch().materializeTransportBatchPage(h, days_), 32, "first page");
        (uint256 avail, ) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 0, "day 1 sees nothing of a half-indexed epoch");
        assertEq(_epoch().materializeTransportBatchPage(h, days_), 40, "second page: whole");
        (avail, ) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 10e18, "and now the whole balance");
    }

    /// @dev The executability gates net the recycled upper bound by what the
    ///      epochs would pay (Codex #2276 r1 P1): with the bucket EMPTY and an
    ///      epoch covering the day's recycled leg, the expiry clock accrues
    ///      and the entry expires, absorbing both legs in place.
    function test_ExpiryClock_AccruesWhenAnEpochCoversTheRecycledLeg() public {
        _twoLegDay(1, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(1);
        uint256 id = _entry(1, 2);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        (uint256 needF, uint256 needR) = _epochView().getObligationDomainNeeds(alice);
        assertGt(needR, 0, "fixture: a recycled leg");
        assertEq(_cfg().getRecycleBucket(), 0, "fixture: the bucket is empty");
        _liveOf(needF, _one(1), 1, keccak256("live"));
        bytes32 h = _epochOf(needR, _one(1), 2, keccak256("e"));
        _cfg().setRewardClaimHorizonDays(180);
        uint256 bucketBefore = _cfg().getRecycleBucket();
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        assertEq(RewardHorizonSweepFacet(address(diamond)).sweepExpiredInteractionRewards(ids), 0, "stamps only");
        uint256 remaining = 180 days + 90 days;
        uint256 swept;
        while (remaining > 0) {
            uint256 step = remaining < 7 days ? remaining : 7 days;
            vm.warp(vm.getBlockTimestamp() + step);
            swept = RewardHorizonSweepFacet(address(diamond)).sweepExpiredInteractionRewards(ids);
            remaining -= step;
            if (swept > 0) break;
        }
        if (swept == 0) {
            vm.warp(vm.getBlockTimestamp() + 7 days);
            swept = RewardHorizonSweepFacet(address(diamond)).sweepExpiredInteractionRewards(ids);
        }
        assertEq(swept, NEED, "expired: the clock accrued with an empty bucket");
        (uint256 lf, uint256 lr) = _legs(h);
        // Codex #2276 r5 P1 — an expiry's recycled slice is a commitment
        // release, not a funding pull: the epoch pays none of it, and goes to
        // the fresh leg ahead of the live delivery instead.
        assertEq(lf, needF, "the epoch paid the expiry's fresh leg, transport first");
        assertEq(lr, 0, "and none of its recycled slice, which is a release");
        assertEq(_cfg().getRecycleBucket() - bucketBefore, needF, "the epoch-paid fresh recycled in place; the release moved nothing");
    }

    /// @dev Within one preview an epoch listing two days is not counted for
    ///      both (Codex #2276 r1 P2): one epoch worth one day lists days 1 and
    ///      2; the preview reports one day, and the claim pays one day.
    function test_ThePreview_DoesNotCountAnEpochTwice() public {
        _armedDay(1, NEED);
        _armedDay(2, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(2);
        _entry(1, 3);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        _epochOf(NEED, _two(1, 2), 1, keccak256("one-day-worth"));
        assertEq(_preview(), NEED, "one day, not two");
        assertEq(_claim(), NEED, "and the claim agrees");
    }

    /// @dev The draws need no migration on an in-place upgrade (Codex #2276
    ///      r1 P1): with the appended admission counter forced to zero over a
    ///      ledger that holds an epoch, the day still draws from it.
    function test_TheDomainPass_IsOnlyRunWhereAListedDayIsInReach() public {
        _scene(NEED);
        RewardEpochViewFacet v = _epochView();
        assertFalse(v.getObligationDomainListsAnEpoch(alice), "no listed day: the day is the domain");
        (uint256 f, uint256 r) = v.getObligationDomainNeeds(alice);
        assertEq(f + r, NEED, "the needs view prices regardless");
        // An epoch listing a day OUTSIDE the chunk changes nothing.
        _epochOf(1e18, _one(40), 1, keccak256("far"));
        assertFalse(v.getObligationDomainListsAnEpoch(alice), "a day this call cannot price does not count");
        // One listing the chunk's day switches the pass on — read from the
        // ledger, nothing else (no counter, nothing to backfill).
        _epochOf(1e18, _one(1), 2, keccak256("near"));
        assertTrue(v.getObligationDomainListsAnEpoch(alice), "a listed day in reach");
    }

    /// @dev The public armed need is the FULL capped figure — what the claim
    ///      charges the emission cap and the commitment — epoch-paid fresh
    ///      included; the live-funded part is reported beside it (Codex #2276
    ///      r2 P2).
    function test_ThePublicArmedNeed_CountsTheEpochPaidFresh() public {
        _scene(NEED);
        (uint256 needF, ) = _epochView().getObligationDomainNeeds(alice);
        assertGt(needF, 0, "fixture: a fresh leg");
        _epochOf(10e18, _one(1), 1, keccak256("e"));
        InteractionRewardsLensFacet lens = InteractionRewardsLensFacet(address(diamond));
        assertEq(lens.getUserArmedFreshNeed(alice), needF, "the requirement counts the epoch-paid fresh");
        (uint256 armed, , , , , , uint256 liveArmed) = lens.getUserArmedFreshNeedWithLegs(alice);
        assertEq(armed, needF, "same figure, flat shape");
        assertEq(liveArmed, 0, "and the live delivery must fund none of it");
    }

    /// @dev One epoch worth one day lists day 1, which the claimant covers on
    ///      BOTH sides: the preview counts the epoch once across the two side
    ///      walks (Codex #2276 r3 P1), and the claim agrees — the lender side
    ///      draws it, the borrower side finds nothing and defers.
    function test_ThePreview_CarriesTheOverlayAcrossSides() public {
        _mut().setDayPoolStampRaw(1, uint128(2e18), 0);
        _mut().setKnownGlobalDailyInterest(1, 1e18, 1e18, true);
        _mut().setDayCapThreshold18(1, type(uint256).max);
        _mut().setDayCapModeRaw(1, 1);
        _mut().setDayUserSideCapRaw(1, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(1);
        _entry(1, 2);
        uint256 b = _mut().pushRewardEntry(alice, LOAN, LibVaipakam.RewardSide.Borrower, 1e18, 1);
        _mut().closeRewardEntryRaw(b, 2);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        (uint256 needF, ) = _epochView().getObligationDomainNeeds(alice);
        assertEq(needF, 2 * NEED, "fixture: both sides need the day's fresh");
        _epochOf(NEED, _one(1), 1, keccak256("one-day-worth"));
        assertEq(_preview(), NEED, "one epoch, one side - not both");
        assertEq(_claim(), NEED, "and the claim agrees");
    }

    /// @dev The residual leg is chosen on the deficits NET of the mandatory
    ///      draws (Codex #2276 r4 P1), on Codex's own figures: day A needs
    ///      10F/5R, day B 1F/5R (domain 11F/10R), live fresh 5, bucket 5, an
    ///      11-token epoch on day A. Mandatory: 5F. Net deficits 1F vs 5R, so
    ///      the rest goes recycled first: 6F/5R, and both days settle.
    function test_TheResidualLeg_IsChosenNetOfTheMandatoryDraws() public {
        _epochOf(11e18, _one(1), 1, keccak256("eleven"));
        (uint256 tf, uint256 tr, ) = _alloc(1, 10e18, 5e18, 11e18, 10e18, type(uint256).max, 5e18, 5e18);
        assertEq(tf, 6e18, "fresh: the mandatory 5 and one more");
        assertEq(tr, 5e18, "recycled: the whole leg, the greater net deficit");
    }

    function _attest(uint256 remitId, uint256 fresh, uint256 recycled) internal {
        RewardReporterFacet(address(diamond)).setRewardMessenger(address(this));
        _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, remitId, fresh, recycled);
    }

    /// @dev An ATTESTED packet's epoch pays each leg only within that
    ///      component's remaining cap (Codex #2276 r4 P1): 4F/6R of 10, a day
    ///      asking 6F gets 4F from the epoch, and asking 6F/3R gets 4F/3R.
    function test_AnAttestedEpoch_PaysEachLegWithinItsRoom() public {
        _epochOf(10e18, _one(1), 7, keccak256("attested"));
        _attest(7, 4e18, 6e18);
        (uint256 tf, uint256 tr, ) = _alloc(1, 6e18, 0, type(uint256).max, type(uint256).max, type(uint256).max, 0, 0);
        assertEq(tf, 4e18, "fresh capped at the attested fresh");
        assertEq(tr, 0);
        (tf, tr, ) = _alloc(1, 6e18, 3e18, type(uint256).max, type(uint256).max, type(uint256).max, 0, 0);
        assertEq(tf, 4e18);
        assertEq(tr, 3e18, "recycled within its own room");
    }

    /// @dev A split attested AFTER a draw re-types the legs already drawn so
    ///      the caps hold (Codex #2276 r4 P1): a fresh-only day drew 0.4 fresh
    ///      from an unattested epoch; the attestation says 0.1F/9.9R; the legs
    ///      become 0.1F/0.3R, the epoch's total unchanged.
    function test_ALateAttestation_RetypesTheLegsAlreadyDrawn() public {
        _scene(NEED);
        bytes32 h = _epochOf(10e18, _one(1), 9, keccak256("late"));
        assertEq(_claim(), NEED);
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(lf, NEED, "drawn fresh, nothing known to bound it");
        assertEq(lr, 0);
        _attest(9, 0.1e18, 9.9e18);
        (lf, lr) = _legs(h);
        assertEq(lf, 0.1e18, "the fresh leg now fits the attested fresh");
        assertEq(lr, 0.3e18, "the excess re-typed recycled");
        assertEq(_balance(h) + lf + lr, 10e18, "the epoch's identity holds");
    }

    /// @dev A cap-hit deferral's prune is progress the claim keeps even when
    ///      it pays nothing (Codex #2276 r4 P2): 64 leading epochs exhausted
    ///      (parked) and a funded 65th beyond the window. The first claim pays
    ///      nothing, does not revert, and moves the cursor; the second pays.
    function test_APrune_SurvivesAnEmptyClaim() public {
        _scene(NEED);
        for (uint256 i; i < 64; ++i) {
            bytes32 h = _epochOf(1, _one(1), 100 + i, keccak256(abi.encode("dust", i)));
            _mut().parkTransportBatchRaw(h);
        }
        // Arrives after the husks, so it is ordered behind them (same-block
        // arrivals would be ordered by batch id — Codex #2276 r6).
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _epochOf(NEED, _one(1), 300, keccak256("funded"));
        assertEq(_cursor(1), 0, "fixture: the window starts at the husks");
        assertEq(_claim(), 0, "deferred on the window, not reverted");
        assertEq(_cursor(1), 64, "the prune persisted");
        assertEq(_claim(), NEED, "the next attempt sees the funded epoch");
    }

    /// @dev The day's index is arrival-ordered whoever indexes it (Codex #2276
    ///      r5 P1): the newer epoch is indexed first, and the older one still
    ///      leads the index.
    function test_TheIndex_IsArrivalOrdered_WhoeverIndexesFirst() public {
        uint256[] memory d1 = _one(1);
        _ingress().onRewardBudgetReceived(address(vpfi), 1e18, d1, CHAIN_BASE, 11, REMITTER, 0, 0, keccak256("old"), false);
        bytes32 hOld = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("old")));
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _ingress().onRewardBudgetReceived(address(vpfi), 1e18, d1, CHAIN_BASE, 12, REMITTER, 0, 0, keccak256("new"), false);
        bytes32 hNew = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("new")));
        _epoch().materializeTransportBatchPage(hNew, d1);
        _epoch().materializeTransportBatchPage(hOld, d1);
        (bytes32[] memory page, , , ) = _epoch().getTransportDayBatches(1, 0, 10);
        assertEq(page.length, 2);
        assertEq(page[0], hOld, "the older arrival leads, whoever indexed first");
        assertEq(page[1], hNew);
    }

    /// @dev Each leg is served first from the epochs least able to serve the
    ///      other (Codex #2276 r5 P1): a flexible epoch ahead of a fresh-only
    ///      one, a 5F/5R ask — the fresh-only epoch pays fresh, the flexible
    ///      one recycled, and both legs are covered.
    function test_TheSplit_ServesEachLegFromTheLeastFlexibleEpoch() public {
        _epochOf(5e18, _one(1), 41, keccak256("flexible"));
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _epochOf(5e18, _one(1), 42, keccak256("fresh-only"));
        _attest(42, 5e18, 0);
        (uint256 tf, uint256 tr, ) = _alloc(1, 5e18, 5e18, type(uint256).max, type(uint256).max, type(uint256).max, 0, 0);
        assertEq(tf, 5e18, "fresh from the epoch that can serve nothing else");
        assertEq(tr, 5e18, "recycled from the flexible one");
    }

    /// @dev A scaling residual is never carried by a leg past its recorded
    ///      cap (Codex #2276 r5 P2, r6 P1): a 1F/2R split lands on 1e18 and
    ///      floors to F + R = 1e18 - 1 wei; an epoch that drew the whole 1e18
    ///      fresh before the split was known re-types to exactly F fresh and
    ///      R recycled, and the residual wei is recorded beyond both caps for
    ///      the close-out's disposition path — the identity still holds.
    function test_ALateAttestation_KeepsBothLegsWithinTheRecordedCaps() public {
        _scene(1e18);
        bytes32 h = _epochOf(1e18, _one(1), 21, keccak256("dust"));
        assertEq(_claim(), 1e18, "the whole epoch drawn fresh");
        _attest(21, 1, 2);
        uint256 f = uint256(1e18) / 3;
        uint256 r = uint256(2e18) / 3;
        assertEq(f + r, 1e18 - 1, "fixture: the floors leave one wei");
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(lf, f, "the fresh leg is the recorded fresh cap");
        assertEq(lr, r, "the recycled leg is the recorded recycled cap");
        assertEq(_beyond(h), 1, "the residual wei is recorded beyond both caps");
        assertEq(lf + lr + _beyond(h), 1e18, "the identity holds");
    }

    /// @dev Coverage a leg's cap rejects goes to the other leg (Codex #2276
    ///      r6 P1): a recycled-only epoch, a 5F/5R day, live fresh and bucket
    ///      each covering their leg — the tie rule asks fresh, the epoch can
    ///      pay none of it, and the allocation offers the coverage to recycled
    ///      instead of leaving the epoch untouched.
    function test_CapRejectedCoverage_GoesToTheOtherLeg() public {
        _epochOf(5e18, _one(1), 51, keccak256("recycled-only"));
        _attest(51, 0, 5e18);
        (uint256 tf, uint256 tr, ) = _alloc(1, 5e18, 5e18, type(uint256).max, type(uint256).max, type(uint256).max, 5e18, 5e18);
        assertEq(tf, 0, "the epoch cannot pay fresh");
        assertEq(tr, 5e18, "so it pays the recycled leg, transport first");
    }

    /// @dev Same-block arrivals are ordered by batch id whoever materializes
    ///      first (Codex #2276 r6 P1): two deliveries in one block, indexed in
    ///      the order that would put the larger id first, still read in id
    ///      order.
    function test_TheIndex_BreaksSameBlockTies_ByBatchId() public {
        uint256[] memory d1 = _one(1);
        _ingress().onRewardBudgetReceived(address(vpfi), 1e18, d1, CHAIN_BASE, 61, REMITTER, 0, 0, keccak256("x"), false);
        _ingress().onRewardBudgetReceived(address(vpfi), 1e18, d1, CHAIN_BASE, 62, REMITTER, 0, 0, keccak256("y"), false);
        bytes32 hx = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("x")));
        bytes32 hy = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("y")));
        (bytes32 lo, bytes32 hi) = hx < hy ? (hx, hy) : (hy, hx);
        _epoch().materializeTransportBatchPage(hi, d1);
        _epoch().materializeTransportBatchPage(lo, d1);
        (bytes32[] memory page, , , ) = _epoch().getTransportDayBatches(1, 0, 10);
        assertEq(page[0], lo, "the smaller id leads, whoever indexed first");
        assertEq(page[1], hi);
    }

    /// @dev A materialization call indexes at least one day and stops its page
    ///      once the arrival-order shifts exceed the work budget (Codex #2276
    ///      r6 P2): an old two-day epoch indexed after 70 newer ones on each
    ///      day takes two calls, each landing its day at the front.
    function test_Materialization_ProgressesOneDayPerCall_UnderTheWorkBudget() public {
        uint256[] memory both = _two(1, 2);
        _ingress().onRewardBudgetReceived(address(vpfi), 1e18, both, CHAIN_BASE, 70, REMITTER, 0, 0, keccak256("old"), false);
        bytes32 hOld = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("old")));
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        for (uint256 i; i < 70; ++i) {
            _epochOf(1, both, 100 + i, keccak256(abi.encode("newer", i)));
        }
        assertEq(_epoch().materializeTransportBatchPage(hOld, both), 1, "the first call indexes one day and stops");
        (bytes32[] memory p1, , , ) = _epoch().getTransportDayBatches(1, 0, 1);
        assertEq(p1[0], hOld, "at the front of day 1");
        assertEq(_epoch().materializeTransportBatchPage(hOld, both), 2, "the second call indexes the other");
        (bytes32[] memory p2, , , ) = _epoch().getTransportDayBatches(2, 0, 1);
        assertEq(p2[0], hOld, "at the front of day 2");
    }

    /// @dev A forfeit's recycled slice is a commitment release and draws no
    ///      epoch value (Codex #2276 r5 P1), on Codex's shape: forfeited day A
    ///      (fresh + recycled) with an A-only epoch, live day B, live delivery
    ///      just enough for one day, bucket empty. The epoch pays A's fresh, A's
    ///      recycled is released, and the live delivery is left for B.
    function test_AForfeitsRecycledSlice_DrawsNoEpoch() public {
        _twoLegDay(1, NEED);
        _armedDay(2, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(2);
        uint256 a = _entry(1, 2);
        _mut().setRewardEntryForfeitedRaw(a);
        _entry(2, 3);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        bytes32 h = _epochOf(NEED / 2, _one(1), 31, keccak256("a-only"));
        _liveOf(NEED, _two(1, 2), 32, keccak256("live"));
        assertEq(_cfg().getRecycleBucket(), 0, "fixture: the bucket is empty");
        assertEq(_claim(), NEED, "day B paid from the live delivery the forfeit did not consume");
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(lf, NEED / 2, "the epoch paid the forfeit's fresh slice");
        assertEq(lr, 0, "and none of its recycled slice, which is a release");
    }

    /// @dev A draw records its exit on the PACKET too, so the packet's own
    ///      identity holds after it (Codex #2274 r8 P1).
    function test_ADraw_KeepsThePacketIdentity() public {
        _scene(NEED);
        bytes32 h = _epochOf(10e18, _one(1), 1, keccak256("e"));
        assertEq(_claim(), NEED);
        (, uint256 protectedIn, uint256 unclassified, uint256 cf, uint256 cr, uint256 disposed, , uint256 drawn) =
            RewardReconciliationFacet(address(diamond)).getPacketReconciliation(h);
        assertEq(drawn, NEED, "the draw is the packet's exit");
        assertEq(unclassified + cf + cr + disposed + drawn, protectedIn, "packet identity after a draw");
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(lf + lr, drawn, "and equals the epoch's two legs");
    }

    /// @dev The order is the ledger's, not the indexer's (Codex #2276 r1 P1):
    ///      X lists days 1 and 2, Y lists day 1 only, and X was indexed
    ///      first. Day 1 spends Y — the fewest listed days first — and keeps
    ///      X for day 2, which only X can fund.
    function test_FewestListedDaysFirst_KeepsTheWiderEpochForTheDayOnlyItFunds() public {
        _armedDay(1, NEED);
        _armedDay(2, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(2);
        _entry(1, 3);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        bytes32 x = _epochOf(NEED, _two(1, 2), 1, keccak256("x")); // indexed first
        bytes32 y = _epochOf(NEED, _one(1), 2, keccak256("y"));
        assertEq(_claim(), 2 * NEED, "both days settle");
        (uint256 xf, ) = _legs(x);
        (uint256 yf, ) = _legs(y);
        assertEq(yf, NEED, "day 1 spent Y");
        assertEq(xf, NEED, "day 2 spent X");
    }

    // ─── the allocation rule, on the design's own cases ─────────────────────

    function test_TheAllocationRule_FromTheDesignsOwnCases() public {
        _epochOf(5, _one(1), 1, keccak256("five"));
        // 5 fresh / 5 recycled, 5 live fresh, an empty bucket, a 5-token epoch:
        // fully backed ONLY if live pays fresh and the epoch pays recycled.
        uint256 MAX = type(uint256).max; // "the day is the domain"
        (uint256 tf, uint256 tr, bool capHit) = _alloc(1, 5, 5, MAX, MAX, 100, 5, 0);
        assertEq(tf, 0, "live covers fresh, so the epoch is not spent there");
        assertEq(tr, 5, "the epoch covers the recycled shortfall");
        assertFalse(capHit);
        // No typed source on either leg: fresh first on ties.
        (tf, tr, ) = _alloc(1, 5, 5, MAX, MAX, 100, 0, 0);
        assertEq(tf, 5);
        assertEq(tr, 0);
        // Both legs typed-covered: transport is still drawn first, in order.
        _epochOf(5, _one(1), 2, keccak256("five-more"));
        (tf, tr, ) = _alloc(1, 5, 5, MAX, MAX, 100, 5, 5);
        assertEq(tf, 5);
        assertEq(tr, 5);
        // The fresh need is read net of the pool cap: 2 of headroom, 10 of coverage.
        (tf, tr, ) = _alloc(1, 5, 5, MAX, MAX, 2, 0, 0);
        assertEq(tf, 2, "never assigned fresh the cap would not let anyone pay");
        assertEq(tr, 5);
    }

    /// @dev §5c's contention case, at the rule: day A needs 5F/5R and holds a
    ///      matching 5-batch, day B needs 5R, shared live fresh 5 and bucket
    ///      5. Locally A's shortfalls are both zero and fresh-first would park
    ///      the batch on fresh, draining the bucket on A and starving B. Over
    ///      the DOMAIN (A and B together) the recycled deficit is 5 and the
    ///      fresh deficit 0, so the batch relieves recycled.
    function test_TheAllocationRule_RelievesTheGreaterDomainDeficit() public {
        _epochOf(5, _one(1), 1, keccak256("five"));
        (uint256 tf, uint256 tr, ) = _alloc(1, 5, 5, 5, 10, 100, 5, 5);
        assertEq(tf, 0, "fresh is covered domain-wide by live");
        assertEq(tr, 5, "the batch relieves the domain's recycled deficit");
        // The same day with no other demand in the domain: fresh first.
        (tf, tr, ) = _alloc(1, 5, 5, 5, 5, 100, 5, 5);
        assertEq(tf, 5);
        assertEq(tr, 0);
        // The day's own shortfall always comes first, whatever the domain says.
        (tf, tr, ) = _alloc(1, 5, 5, 5, 10, 100, 0, 5);
        assertEq(tf, 5, "A cannot settle without its fresh shortfall covered");
        assertEq(tr, 0);
    }

    /// @dev The same contention end to end, one claimant over two days:
    ///      days 1 and 2 each need fresh and recycled halves of the cap; live
    ///      covers both days' fresh, the bucket only ONE day's recycled, and an
    ///      epoch worth one day's recycled lists day 1 alone. A local rule
    ///      spends the epoch on day 1's fresh, drains the bucket on day 1 and
    ///      defers day 2; the domain rule spends it on day 1's recycled and
    ///      both days settle.
    function test_TwoDayClaim_TheDomainRuleSettlesBothDays() public {
        uint256 cap = 0.4e18;
        _mut().setDayPoolStampRaw(1, uint128(2e18), uint128(2e18));
        _mut().setDayPoolStampRaw(2, uint128(2e18), uint128(2e18));
        for (uint256 d = 1; d <= 2; ++d) {
            _mut().setKnownGlobalDailyInterest(d, 1e18, 0, true);
            _mut().setDayCapThreshold18(d, type(uint256).max);
            _mut().setDayCapModeRaw(d, 1);
            _mut().setDayUserSideCapRaw(d, cap);
        }
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(2);
        _entry(1, 3);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        // Discover the fixture's per-day split under unbounded funding first,
        // so the assertions below are about the RULE and not about pricing.
        (uint256 needF, uint256 needR) = _epochView().getObligationDomainNeeds(alice);
        assertEq(needF + needR, 2 * cap, "fixture: two capped days");
        assertGt(needR, 0, "fixture: the days carry a recycled leg");
        uint256 dayR = needR / 2;
        uint256 dayF = needF / 2;
        // Live covers both days' fresh; the bucket covers ONE day's recycled;
        // the epoch is exactly one day's recycled and lists day 1 only.
        _liveOf(needF + dayR, _one(1), 1, keccak256("live"));
        // The raw credit is the bounding absorption itself, so it charges the
        // delivered ledger by `dayR` as it moves it live-fresh -> recycled:
        // the live row and the delivered bound then both stand at `needF`.
        _mut().creditRecycleRaw(LibVpfiRecycle.RecycleSource.ForfeitedReward, 0, dayR);
        assertEq(_cfg().getRecycleBucket(), dayR, "fixture: one day's recycled in the bucket");
        assertEq(_row(LibVaipakam.RewardCustodyRow.LiveFresh), needF, "fixture: live covers both days' fresh exactly");
        uint256 paidBefore = _mut().getArmedFreshPaidRaw();
        bytes32 h = _epochOf(dayR, _one(1), 2, keccak256("e"));
        assertEq(_preview(), 2 * cap, "the preview settles both days");
        assertEq(_claim(), 2 * cap, "and so does the claim");
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(lr, dayR, "the epoch paid day 1's RECYCLED leg");
        assertEq(lf, 0, "and none of its fresh");
        assertEq(_mut().getArmedFreshPaidRaw() - paidBefore, 2 * dayF, "live paid both days' fresh");
        assertEq(_cfg().getRecycleBucket(), 0, "the bucket paid day 2's recycled");
    }

    function test_NoEpochs_TheReadsAnswerZero_WithoutAScan() public {
        (uint256 avail, bool capHit) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 0);
        assertFalse(capHit);
        (uint256 tf, uint256 tr, ) =
            _alloc(1, 5, 5, type(uint256).max, type(uint256).max, 100, 0, 0);
        assertEq(tf + tr, 0);
    }

    // ─── the entries' gates ─────────────────────────────────────────────────

    function test_TheDraw_IsDiamondInternal_AndBoundedByTheWindow() public {
        _epochOf(10e18, _one(1), 1, keccak256("e1"));
        vm.expectRevert(abi.encodeWithSelector(RewardCustodyOnlyDiamondInternal.selector, address(this)));
        _epoch().epochDrawForDay(1, 1, 0);
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(TransportDrawExceedsCoverage.selector, 1, 11e18, 10e18));
        _epoch().epochDrawForDay(1, 11e18, 0);
    }
}
