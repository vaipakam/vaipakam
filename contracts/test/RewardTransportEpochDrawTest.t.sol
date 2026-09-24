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
    event TransportDayCursorAdvanced(uint256 indexed dayId, bytes32 cursor);
    event IngressPacketClassifiedBeyondCaps(bytes32 indexed packetHash, uint256 fresh, uint256 recycled);

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

    /// @dev The per-epoch legs an allocation WOULD draw, for one epoch. The
    ///      totals cannot discriminate here: two coverings of the same ask are
    ///      equal in amount and differ only in which epochs they spend, so the
    ///      assertion has to read the split's own output (Codex #2296 item 1).
    function _plannedLegs(uint256 dayId, uint256 needF, uint256 needR, bytes32 id)
        internal
        view
        returns (uint256 f, uint256 r)
    {
        LibRewardCustody.AllocRequest memory q;
        q.dayId = dayId;
        q.needFresh = needF;
        q.needRecycled = needR;
        q.domainFresh = type(uint256).max;
        q.domainRecycled = type(uint256).max;
        q.poolFresh = type(uint256).max;
        q.ovIds = new bytes32[](0);
        q.ovFresh = new uint256[](0);
        q.ovRecycled = new uint256[](0);
        LibRewardCustody.AllocResult memory a = _epoch().getTransportAllocationForDay(q);
        for (uint256 i; i < a.planIds.length; ) {
            if (a.planIds[i] == id) return (a.planFresh[i], a.planRecycled[i]);
            unchecked { ++i; }
        }
        revert("fixture: the epoch is not in the day's plan");
    }

    /// @dev The cursor's POSITION in the day's order — the count of leading
    ///      exhausted epochs — exact here because every day in this suite is
    ///      shorter than the hundred nodes the read walks.
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

    /// @dev A batch listing a day BEYOND the one being planned is drawn LAST
    ///      (Codex #2276, the necessity and contested gates): the design
    ///      inverts transport-first for exactly these, because an early day
    ///      draining a shared batch transport-first leaves the later day
    ///      unfunded though other sources covered the early one. The same
    ///      scene as the transport-first cell above, with the epoch listing
    ///      days 1 AND 2: now live pays day 1 and the epoch is left whole.
    function test_ASharedEpoch_IsDrawnLast_WhenLiveCanPay() public {
        _scene(NEED);
        _liveOf(1e18, _one(1), 1, keccak256("live"));
        bytes32 h = _epochOf(10e18, _two(1, 2), 2, keccak256("shared"));
        uint256 liveBefore = _row(LibVaipakam.RewardCustodyRow.LiveFresh);
        assertEq(_claim(), NEED);
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(lf + lr, 0, "the shared epoch is spared for its later day");
        assertEq(liveBefore - _row(LibVaipakam.RewardCustodyRow.LiveFresh), NEED, "live paid day 1");
    }

    /// @dev ...and drawn when it is the ONLY way to pay (necessity, not
    ///      exclusion): no live delivery at all, so day 1 is funded from the
    ///      shared epoch by the last pass, for exactly its gap.
    function test_ASharedEpoch_StillPays_WhenNothingElseCan() public {
        _scene(NEED);
        bytes32 h = _epochOf(10e18, _two(1, 2), 2, keccak256("shared-only"));
        assertEq(_claim(), NEED, "the day is paid from the shared epoch");
        (uint256 lf, ) = _legs(h);
        assertEq(lf, NEED, "for exactly the day's gap");
        assertEq(_balance(h), 10e18 - NEED, "and the rest stays for the later day");
    }

    /// @dev A shared epoch is last-resort for EVERY day it lists, earlier as
    ///      well as later (Codex #2276, the round after the tier landed). The
    ///      tier first protected only LATER days, which let a batch listing
    ///      days 1 and 2 be spent transport-first for day 2 while another
    ///      claimant's day-1 obligation could still need it — a contested draw.
    ///      With live funding able to pay each day, the allocator must draw the
    ///      shared epoch for NEITHER day.
    function test_ASharedEpoch_IsLastResort_ForEveryDayItLists() public {
        _epochOf(NEED, _two(1, 2), 2, keccak256("shared-both-ways"));
        (uint256 tf1, uint256 tr1, ) =
            _alloc(1, NEED, 0, type(uint256).max, type(uint256).max, type(uint256).max, NEED, 0);
        assertEq(tf1 + tr1, 0, "day 1: live can pay, so the shared epoch is spared");
        (uint256 tf2, uint256 tr2, ) =
            _alloc(2, NEED, 0, type(uint256).max, type(uint256).max, type(uint256).max, NEED, 0);
        assertEq(tf2 + tr2, 0, "day 2 as well: an EARLIER listed day protects it too");
        // Where nothing else can pay, it still pays the gap, for either day.
        (tf2, , ) = _alloc(2, NEED, 0, type(uint256).max, type(uint256).max, type(uint256).max, 0, 0);
        assertEq(tf2, NEED, "and it still funds the day when it is the only source");
    }

    /// @dev The ordinary tier is credited only with what it can pay on EACH
    ///      leg, not its aggregate balance (Codex #2276). An ordinary epoch that
    ///      can pay only recycled, a shared epoch that can pay only fresh, a
    ///      fresh-only need that live funding covers. Credited with its
    ///      aggregate, the ordinary tier was asked for fresh it cannot pay, and
    ///      the split spilled that fresh into the shared epoch. Live must pay,
    ///      and the shared epoch must be spared.
    function test_TheOrdinaryTier_IsCreditedPerLeg_NotByItsAggregate() public {
        _epochOf(5, _one(1), 91, keccak256("ord-recycled-only"));
        _attest(91, 0, 5);
        vm.warp(vm.getBlockTimestamp() + 1);
        _epochOf(5, _two(1, 2), 92, keccak256("nec-fresh-only"));
        _attest(92, 5, 0);
        (uint256 tf, uint256 tr, ) =
            _alloc(1, 5, 0, type(uint256).max, type(uint256).max, type(uint256).max, 5, 0);
        assertEq(tf + tr, 0, "live pays the fresh leg; no epoch is drawn at all");
    }

    /// @dev ...and where the shared tier IS needed, its own leg restrictions
    ///      shape how the ordinary tier is spent (Codex #2276, found locally).
    ///      An ordinary epoch that can pay either leg, a shared epoch that can
    ///      pay only fresh, a need for both legs and nothing else to pay it.
    ///      Both legs are coverable: the ordinary epoch pays recycled and the
    ///      shared epoch pays fresh. Hiding the shared tier from the split's
    ///      look-ahead spent the ordinary epoch on fresh and left recycled
    ///      unpaid.
    function test_TheSharedTier_ShapesTheOrdinarySpend_WhenItIsNeeded() public {
        _epochOf(5, _one(1), 93, keccak256("ord-flexible"));
        vm.warp(vm.getBlockTimestamp() + 1);
        _epochOf(5, _two(1, 2), 94, keccak256("nec-fresh-only-2"));
        _attest(94, 5, 0);
        (uint256 tf, uint256 tr, ) =
            _alloc(1, 5, 5, type(uint256).max, type(uint256).max, type(uint256).max, 0, 0);
        assertEq(tf, 5, "the fresh leg is paid, from the shared epoch");
        assertEq(tr, 5, "and the recycled leg too, from the ordinary epoch");
    }

    function test_AShortEpochPaysWhatItHolds_TheLedgerTheRest_AndIsRetired() public {
        _scene(NEED);
        _liveOf(1e18, _one(1), 1, keccak256("live"));
        bytes32 h = _epochOf(0.1e18, _one(1), 2, keccak256("short"));
        uint256 liveBefore = _row(LibVaipakam.RewardCustodyRow.LiveFresh);
        uint256 unclBefore = _row(LibVaipakam.RewardCustodyRow.Unclassified);

        vm.expectEmit(true, false, false, true, address(diamond));
        emit TransportDayCursorAdvanced(1, h); // the cursor is the exhausted epoch itself (r7)
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

    /// @dev A late epoch links into its place in constant work (Codex #2276
    ///      r7 P2): an old two-day epoch indexed after 70 newer ones on each
    ///      day indexes both days in ONE call and leads both lists.
    function test_Materialization_LinksALateEpochInConstantWork() public {
        uint256[] memory both = _two(1, 2);
        _ingress().onRewardBudgetReceived(address(vpfi), 1e18, both, CHAIN_BASE, 70, REMITTER, 0, 0, keccak256("old"), false);
        bytes32 hOld = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("old")));
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        for (uint256 i; i < 70; ++i) {
            _epochOf(1, both, 100 + i, keccak256(abi.encode("newer", i)));
        }
        assertEq(_epoch().materializeTransportBatchPage(hOld, both), 2, "both days in one call");
        (bytes32[] memory p1, , uint256 t1, ) = _epoch().getTransportDayBatches(1, 0, 1);
        assertEq(t1, 71);
        assertEq(p1[0], hOld, "at the front of day 1");
        (bytes32[] memory p2, , , ) = _epoch().getTransportDayBatches(2, 0, 1);
        assertEq(p2[0], hOld, "at the front of day 2");
    }

    /// @dev Without a predecessor hint the ledger walks back a bounded number
    ///      of steps and refuses past it; with the hint (the head here) the
    ///      same epoch links in constant work (Codex #2276 r7 P2).
    function test_Materialization_RefusesAnUnboundedWalk_UnlessHinted() public {
        uint256[] memory d1 = _one(1);
        _ingress().onRewardBudgetReceived(address(vpfi), 1e18, d1, CHAIN_BASE, 80, REMITTER, 0, 0, keccak256("older"), false);
        bytes32 hOld = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("older")));
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        for (uint256 i; i < 130; ++i) {
            _epochOf(1, d1, 200 + i, keccak256(abi.encode("newer", i)));
        }
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.TransportIndexWalkExceeded.selector, hOld, 1));
        _epoch().materializeTransportBatchPage(hOld, d1);
        bytes32[] memory hints = new bytes32[](1); // zero: at the head
        assertEq(_epoch().materializeTransportBatchPageHinted(hOld, d1, hints), 1, "linked with the hint");
        (bytes32[] memory page, , uint256 total, ) = _epoch().getTransportDayBatches(1, 0, 1);
        assertEq(total, 131);
        assertEq(page[0], hOld, "at the front");
        bytes32 wrong = page[0];
        vm.expectRevert();
        _epoch().materializeTransportBatchPageHinted(hOld, d1, _hintOf(wrong)); // already listed: idempotent, refused as whole
    }

    function _hintOf(bytes32 h) internal pure returns (bytes32[] memory a) {
        a = new bytes32[](1);
        a[0] = h;
    }

    /// @dev A day's reported coverage counts only what its epochs can pay
    ///      through at least one leg (Codex #2276 r7 P2): a 1F/2R split on 2
    ///      wei records 0 fresh room and 1 recycled room, and the day can fund
    ///      1, not 2.
    function test_TheCoverage_CountsOnlyWhatIsDrawable() public {
        _epochOf(2, _one(1), 90, keccak256("two-wei"));
        _attest(90, 1, 2);
        (uint256 avail, ) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 1, "the residual wei is reserved for the disposition path");
    }

    /// @dev A day deferred on the scan window ends the whole call's walk, on
    ///      every side (Codex #2276 r7 P2): the claimant covers day 1 on both
    ///      sides, 64 husks lead the day and a funded epoch sits beyond them.
    ///      The first claim pays nothing and prunes; the preview agrees; the
    ///      second claim pays both sides from the now-visible epoch.
    function test_ACapHitDeferral_EndsTheWalkOnEverySide() public {
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
        for (uint256 i; i < 64; ++i) {
            bytes32 h = _epochOf(1, _one(1), 400 + i, keccak256(abi.encode("husk", i)));
            _mut().parkTransportBatchRaw(h);
        }
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _epochOf(2 * NEED, _one(1), 500, keccak256("funded"));
        assertEq(_preview(), 0, "the preview stops at the window too");
        assertEq(_claim(), 0, "deferred on the window; the walk ended on both sides");
        assertEq(_cursor(1), 64, "and the prune persisted");
        assertEq(_claim(), 2 * NEED, "the next call pays both sides from the funded epoch");
    }

    /// @dev A draw records its exit on the PACKET too, so the packet's own

    // ─── round 8: days indexed before the list; residual-only epochs; the lens ──

    /// @dev An attested epoch with no room left under either cap is exhausted
    ///      for the cursor even though a residual unit remains (Codex #2276 r8
    ///      P2), reached the way a real one is: a two-leg day, an epoch one
    ///      wei over the two legs attested at the legs' proportion, so the
    ///      floors leave one wei outside both caps; the claim drains both
    ///      rooms, the wei stays, and the prune passes the epoch.
    function test_AResidualOnlyEpoch_IsExhaustedForTheCursor() public {
        _twoLegDay(1, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(1);
        _entry(1, 2);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        (uint256 needF, uint256 needR) = _epochView().getObligationDomainNeeds(alice);
        assertGt(needR, 0, "fixture: a recycled leg");
        bytes32 h = _epochOf(needF + needR + 1, _one(1), 2, keccak256("e"));
        _attest(2, needF, needR);
        _mut().setOutstandingCommitRaw(0, needR);
        assertEq(_claim(), NEED);
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(lf, needF, "both rooms drained");
        assertEq(lr, needR);
        assertEq(_balance(h), 1, "the residual wei remains");
        (uint256 avail, ) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 0, "and is not coverage");
        assertEq(_cursor(1), 1, "the draw's own prune passed the epoch");
        _epoch().epochPruneTransportDayCursor(1);
        assertEq(_cursor(1), 1, "idempotent");
    }

    /// @dev 64 residual-only epochs ahead of a funded one (Codex #2276 r8 P2):
    ///      each holds one wei with both caps attested at zero. The first
    ///      claim defers on the window and prunes past them; the second pays.
    ///      Before r8 the prune passed only an empty epoch and the day was
    ///      deferred forever.
    function test_ResidualOnlyEpochs_DoNotHoldTheWindow() public {
        _scene(NEED);
        for (uint256 i; i < 64; ++i) {
            _epochOf(1, _one(1), 600 + i, keccak256(abi.encode("residual", i)));
            _attest(600 + i, 1, 1); // one wei at 1:1 floors to 0 fresh / 0 recycled
        }
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _epochOf(NEED, _one(1), 700, keccak256("funded"));
        (uint256 avail, bool capHit) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 0, "the residuals fund nothing");
        assertTrue(capHit, "and fill the window");
        assertEq(_claim(), 0, "deferred on the window");
        assertEq(_cursor(1), 64, "the residual epochs are exhausted for the cursor");
        assertEq(_claim(), NEED, "the funded epoch is reachable");
    }

    /// @dev Node-based pages each cost their own length (Codex #2276 r8 P2):
    ///      a page from the head, the next from the node it names, the end.
    function test_TheLens_PagesFromANode() public {
        bytes32[] memory hs = new bytes32[](5);
        for (uint256 i; i < 5; ++i) {
            hs[i] = _epochOf(1e18, _one(1), 800 + i, keccak256(abi.encode("p", i)));
            vm.warp(vm.getBlockTimestamp() + 1);
        }
        (bytes32[] memory p1, uint64[] memory at1, bytes32 next) = _epoch().getTransportDayBatchesFrom(1, bytes32(0), 2);
        assertEq(p1.length, 2);
        assertEq(p1[0], hs[0]);
        assertEq(p1[1], hs[1]);
        assertLt(at1[0], at1[1], "with their ordering keys");
        assertEq(next, hs[2], "the next page starts at the node named");
        (bytes32[] memory p2, , bytes32 next2) = _epoch().getTransportDayBatchesFrom(1, next, 10);
        assertEq(p2.length, 3, "the rest");
        assertEq(p2[0], hs[2]);
        assertEq(p2[2], hs[4]);
        assertEq(next2, bytes32(0), "the end");
        (bytes32[] memory none, , bytes32 next3) = _epoch().getTransportDayBatchesFrom(1, bytes32(0), 0);
        assertEq(none.length, 0, "an empty page");
        assertEq(next3, hs[0], "starts where it was asked to");
        (bytes32[] memory stray, , bytes32 next4) = _epoch().getTransportDayBatchesFrom(1, keccak256("elsewhere"), 10);
        assertEq(stray.length, 0, "a node outside the order pages nothing");
        assertEq(next4, bytes32(0));
    }

    // ─── round 9: a wide pre-list day; the exact split; caps net of classification; the preview's prune ──

    /// @dev The split spends in plan order, and holds an epoch's flexible
    ///      balance back only where a later epoch's capacity for the other
    ///      leg could not otherwise be used (Codex #2276 r12 P1), on Codex's
    ///      shape: a flexible one-day epoch ahead of a fresh-only two-day
    ///      epoch, a fresh-only obligation on the first day — the one-day
    ///      epoch pays, and the two-day epoch keeps its fresh for the other
    ///      day; the round-5 shape (both legs asked) still reserves it.
    function test_TheSplit_HonoursPlanPriority_ReservingOnlyAsNeeded() public {
        _scene(NEED);
        bytes32 one = _epochOf(NEED, _one(1), 51, keccak256("one-day"));
        vm.warp(vm.getBlockTimestamp() + 1);
        bytes32 two = _epochOf(NEED, _two(1, 2), 52, keccak256("two-day"));
        _attest(52, NEED, 0); // fresh-only
        assertEq(_claim(), NEED);
        (uint256 lf1, ) = _legs(one);
        (uint256 lf2, ) = _legs(two);
        assertEq(lf1, NEED, "the one-day epoch pays: the priority");
        assertEq(lf2, 0, "the two-day epoch is kept for its other day");
    }

    /// @dev A day's ORDER holds every member from the first, with no link step
    ///      and no second read source (Codex #2296 items 2 and 4). Three
    ///      epochs read back complete and in order the moment they are
    ///      materialized; a day WIDER than one scan window draws from its
    ///      window rather than being refused outright, which is what the
    ///      retired array-ordered path could not do (a window of an array is
    ///      not a prefix of the order, so such a day had to defer with nothing
    ///      drawn); and the retired catch-up entry is not routed at all. The
    ///      five pre-list cells this replaces built a day the ledger can no
    ///      longer be in: an array holding members its order does not.
    function test_ADaysOrder_HoldsEveryMember_WithNoLinkStep() public {
        for (uint256 i; i < 3; ++i) {
            _epochOf(1, _one(1), 71 + i, keccak256(abi.encode("ordered", i)));
            vm.warp(vm.getBlockTimestamp() + 1);
        }
        (, uint64[] memory at, uint256 total, uint256 cursor) =
            _epoch().getTransportDayBatches(1, 0, 10);
        assertEq(total, 3, "three members in the day's membership set");
        assertEq(cursor, 0, "nothing consumed");
        // The ORDER's own length has to be WALKED. That view's page is sized
        // from the membership count, so its length says nothing about how much
        // the order holds -- asserting on it read as a check and was not one,
        // which the link mutation below is what exposed.
        (bytes32[] memory walk, , bytes32 next) = _epoch().getTransportDayBatchesFrom(1, bytes32(0), 10);
        assertEq(walk.length, total, "and the order holds every one of them, with no link call");
        assertEq(next, bytes32(0), "the walk ends at the last member");
        assertTrue(at[0] < at[1] && at[1] < at[2], "in arrival order");
        (uint256 count, bytes32 node) = _epoch().getTransportDayIndex(1);
        assertEq(count, total, "the index view reports the same membership");
        assertEq(node, bytes32(0), "and no cursor node yet");

        // A day wider than one window: 65 epochs of one wei on day 2, asked
        // for one. The window covers it; the retired path deferred with zero.
        for (uint256 i; i < 65; ++i) {
            _epochOf(1, _one(2), 200 + i, keccak256(abi.encode("wide", i)));
        }
        (uint256 tf, uint256 tr, bool capHit) =
            _alloc(2, 1, 0, type(uint256).max, type(uint256).max, type(uint256).max, 0, 0);
        assertEq(tf + tr, 1, "a wide day draws from its window");
        assertTrue(capHit, "and still reports that more lies beyond it");

        // The catch-up entry is retired, and the control proves the check can
        // fail: a live epoch selector on the same Diamond answers.
        (bool ok, bytes memory ret) = address(diamond).call(
            abi.encodeWithSelector(
                bytes4(keccak256("epochLinkTransportDayIndex(uint256,bytes32[])")),
                uint256(1),
                new bytes32[](0)
            )
        );
        assertFalse(ok, "the retired catch-up entry is not routed");
        assertEq(
            bytes4(ret),
            bytes4(keccak256("FunctionDoesNotExist()")),
            "unrouted, not a body that reverts"
        );
        (ok, ) = address(diamond).call(
            abi.encodeWithSelector(RewardEpochFacet.getTransportDayScanIds.selector, uint256(1))
        );
        assertTrue(ok, "control: a routed epoch selector answers");
    }

    /// @dev Where two coverings of the same ask are equal in amount, the split
    ///      spends the EARLIER epochs (Codex #2276 r17 P1, arrested per #2296
    ///      item 1), on Codex's shape: a flexible epoch, then a fresh-only
    ///      one, then a recycled-only one, asked one of each leg. The retired
    ///      fresh-first tie gave the flexible epoch's balance to fresh and so
    ///      reached PAST the fresh-only epoch to the recycled-only one; now the
    ///      flexible epoch pays recycled, the nearer fresh capacity is the one
    ///      consumed, and the last epoch is left for the other day it may
    ///      list. The coverage is the same either way, which is exactly why
    ///      the totals cannot see the difference.
    function test_TheSplit_SparesTheLaterEpoch_WhenEitherLegCouldPay() public {
        bytes32 flex = _epochOf(1, _one(1), 41, keccak256("tie-flexible"));
        vm.warp(vm.getBlockTimestamp() + 1);
        bytes32 freshOnly = _epochOf(1, _one(1), 42, keccak256("tie-fresh-only"));
        _attest(42, 1, 0);
        vm.warp(vm.getBlockTimestamp() + 1);
        bytes32 recycledOnly = _epochOf(1, _one(1), 43, keccak256("tie-recycled-only"));
        _attest(43, 0, 1);
        (uint256 tf, uint256 tr, ) =
            _alloc(1, 1, 1, type(uint256).max, type(uint256).max, type(uint256).max, 0, 0);
        assertEq(tf, 1, "the fresh leg is covered");
        assertEq(tr, 1, "and the recycled leg: the tie never costs coverage");
        (uint256 af, uint256 ar) = _plannedLegs(1, 1, 1, flex);
        assertEq(af, 0, "the flexible epoch does not take the fresh leg");
        assertEq(ar, 1, "it takes recycled: its fresh alternative is the nearer one");
        (uint256 bf, uint256 br) = _plannedLegs(1, 1, 1, freshOnly);
        assertEq(bf, 1, "so the nearer capacity is the one consumed");
        assertEq(br, 0);
        (uint256 cf, uint256 cr) = _plannedLegs(1, 1, 1, recycledOnly);
        assertEq(cf + cr, 0, "and the later epoch is spared for its other day");
    }

    /// @dev The SECOND shape on the same decision (Codex #2276, the round
    ///      after the tie landed): when both legs' next capacity is the SAME
    ///      epoch, comparing only that index says nothing, and fresh-first
    ///      drained a third epoch. Plan-ordered A = flexible 1, B = 2 with one
    ///      unit of room per leg, C = recycled-only 1, asked 1F/2R. A to fresh
    ///      leaves 2R, which B (one unit of recycled room) cannot meet alone,
    ///      so C is opened; A to recycled leaves 1F/1R, which B covers exactly,
    ///      and C — which may list another day — is left standing. Same
    ///      coverage either way, so again the totals cannot see it.
    function test_TheSplit_SparesTheLaterEpoch_WhenBothLegsShareTheNextOne() public {
        bytes32 flex = _epochOf(1, _one(1), 81, keccak256("joint-flexible"));
        vm.warp(vm.getBlockTimestamp() + 1);
        bytes32 both = _epochOf(2, _one(1), 82, keccak256("joint-both"));
        _attest(82, 1, 1);
        vm.warp(vm.getBlockTimestamp() + 1);
        bytes32 recycledOnly = _epochOf(1, _one(1), 83, keccak256("joint-recycled-only"));
        _attest(83, 0, 1);
        (uint256 tf, uint256 tr, ) =
            _alloc(1, 1, 2, type(uint256).max, type(uint256).max, type(uint256).max, 0, 0);
        assertEq(tf, 1, "the fresh leg is covered");
        assertEq(tr, 2, "and both recycled units: the rule never costs coverage");
        (uint256 af, uint256 ar) = _plannedLegs(1, 1, 2, flex);
        assertEq(af, 0, "the flexible epoch does not take the fresh leg");
        assertEq(ar, 1, "it takes recycled: that is the leg that must otherwise reach furthest");
        (uint256 bf, uint256 br) = _plannedLegs(1, 1, 2, both);
        assertEq(bf, 1, "so the shared next epoch pays BOTH its legs");
        assertEq(br, 1, "rather than one of them");
        (uint256 cf, uint256 cr) = _plannedLegs(1, 1, 2, recycledOnly);
        assertEq(cf + cr, 0, "and the later epoch is spared for its other day");
    }

    /// @dev The preview's overlay holds every draw of a chunk and grows as it
    ///      goes (Codex #2276 r12 P1): thirty two-day epochs worth one and a
    ///      half days, day one draws twenty, day two sees ten — the preview
    ///      and the claim both pay one day.
    function test_ThePreview_OverlayScalesAcrossAChunk() public {
        _armedDay(1, NEED);
        _armedDay(2, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(2);
        _entry(1, 3);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        for (uint256 i; i < 30; ++i) {
            _epochOf(NEED / 20, _two(1, 2), 100 + i, keccak256(abi.encode("slice", i)));
            vm.warp(vm.getBlockTimestamp() + 1);
        }
        assertEq(_preview(), NEED, "one day, not two: every draw of day one is remembered");
        assertEq(_claim(), NEED, "and the claim agrees");
    }

    /// @dev The split pays the most either leg can be paid (Codex #2276 r9
    ///      P1), on Codex's shape: an older unattested one-wei epoch (wholly
    ///      flexible) ahead of an attested two-wei epoch with one wei of room
    ///      per leg (wholly exclusive); asked 1F/2R, the exclusive epoch pays
    ///      1F and 1R and the flexible one the last 1R — 1F/2R, where ordering
    ///      by raw room paid 1F/1R.
    function test_TheSplit_TakesExclusiveCapacityFirst() public {
        _epochOf(1, _one(1), 31, keccak256("flexible"));
        vm.warp(vm.getBlockTimestamp() + 1);
        _epochOf(2, _one(1), 32, keccak256("exclusive"));
        _attest(32, 1, 1);
        (uint256 tf, uint256 tr, ) = _alloc(1, 1, 2, type(uint256).max, type(uint256).max, type(uint256).max, 0, 0);
        assertEq(tf, 1, "fresh from the exclusive epoch");
        assertEq(tr, 2, "recycled from both");
    }

    /// @dev A late attestation reconciles against each cap NET of the
    ///      classification the packet already carries (Codex #2276 r9 P1), on
    ///      Codex's shape: a packet classified for half its value before the
    ///      batch gate existed, admitted for the rest, drawn recycled while
    ///      unattested, then attested 1:1 — the recycled cap is spent by the
    ///      classification, so the leg is retyped fresh; the identity holds.
    function test_ALateAttestation_ReconcilesNetOfPriorClassification() public {
        _twoLegDay(1, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(1);
        _entry(1, 2);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        (uint256 needF, uint256 needR) = _epochView().getObligationDomainNeeds(alice);
        assertGt(needR, 0, "fixture: a recycled leg");
        _liveOf(needF, _one(1), 1, keccak256("live"));
        // A packet that landed before the ledger: delivered, its epoch
        // removed, half of it classified recycled as a pre-gate classification
        // did, then admitted for what it still holds.
        uint256[] memory d1 = _one(1);
        _ingress().onRewardBudgetReceived(address(vpfi), 2 * needR, d1, CHAIN_BASE, 2, REMITTER, 0, 0, keccak256("pre"), false);
        bytes32 h = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("pre")));
        _mut().unadmitTransportBatchRaw(h);
        _mut().classifyPacketPreGateRaw(h, 0, needR);
        assertEq(_epoch().admitLegacyTransportBatch(h, d1), h);
        _epoch().materializeTransportBatchPage(h, d1);
        assertEq(_balance(h), needR, "fixture: the unclassified half is the epoch");
        _mut().setOutstandingCommitRaw(0, needR);
        assertEq(_claim(), NEED);
        (uint256 lf, uint256 lr) = _legs(h);
        assertEq(lr, needR, "drawn recycled, nothing known to bound it");
        assertEq(lf, 0);
        _attest(2, 1, 1); // caps needR fresh / needR recycled on 2 * needR
        (lf, lr) = _legs(h);
        assertEq(lr, 0, "the recycled cap was spent by the classification");
        assertEq(lf, needR, "so the leg is retyped fresh, within the fresh cap");
        assertEq(_balance(h) + lf + lr + _beyond(h), needR, "the epoch's identity holds");
    }

    /// @dev The preview simulates the prune a successful draw performs, across
    ///      sides (Codex #2276 r9 P2): 64 epochs that one side's need
    ///      exhausts exactly, a funded 65th beyond the window, the other side
    ///      on the same day. The claim's first side drains the 64 and prunes,
    ///      its second side reads the 65th; the preview says the same.
    function test_ThePreview_SimulatesTheDrawsPruneAcrossSides() public {
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
        for (uint256 i; i < 64; ++i) {
            _epochOf(NEED / 64, _one(1), 400 + i, keccak256(abi.encode("slice", i)));
        }
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _epochOf(NEED, _one(1), 500, keccak256("funded"));
        assertEq(_preview(), 2 * NEED, "the preview reads the 65th for the second side");
        assertEq(_claim(), 2 * NEED, "as the claim does");
        assertEq(_cursor(1), 65, "every epoch drained and passed");
    }

    // ─── round 10: the marker follows the live draw's reach; the lens's numeric cursor ──

    /// @dev The preview marks a day settled only where the claim's settlement
    ///      reaches the epoch draw (Codex #2276 r10 P2): a recycled-only day
    ///      whose lender entry is forfeited — its recycled slice a release,
    ///      no epoch leg, no draw call, no prune live — ahead of a payable
    ///      borrower entry on the same day, behind 64 husks with a funded 65th.
    ///      The claim's second side rescans the husks and defers; the preview
    ///      says the same, where a marker on every advanced day let it read
    ///      the 65th. The deferral's prune then makes the next claim pay.
    function test_ThePreview_MarksADaySettled_OnlyWhereTheClaimPrunes() public {
        _mut().setDayPoolStampRaw(1, 0, uint128(2e18)); // a recycled-only day
        _mut().setKnownGlobalDailyInterest(1, 1e18, 1e18, true); // both sides
        _mut().setDayCapThreshold18(1, type(uint256).max);
        _mut().setDayCapModeRaw(1, 1);
        _mut().setDayUserSideCapRaw(1, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(1);
        uint256 a = _entry(1, 2);
        _mut().setRewardEntryForfeitedRaw(a);
        uint256 b = _mut().pushRewardEntry(alice, LOAN, LibVaipakam.RewardSide.Borrower, 1e18, 1);
        _mut().closeRewardEntryRaw(b, 2);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        (uint256 needF, uint256 needR) = _epochView().getObligationDomainNeeds(alice);
        assertEq(needF, 0, "fixture: no fresh leg on a recycled-only day");
        assertGt(needR, 0, "fixture: the borrower's recycled leg");
        _mut().setOutstandingCommitRaw(0, needR);
        for (uint256 i; i < 64; ++i) {
            bytes32 h = _epochOf(1, _one(1), 400 + i, keccak256(abi.encode("husk", i)));
            _mut().parkTransportBatchRaw(h);
        }
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _epochOf(needR, _one(1), 500, keccak256("funded"));
        assertEq(_preview(), 0, "the preview rescans the husks on the second side, as the claim will");
        assertEq(_claim(), 0, "deferred on the window; the prune is kept");
        assertEq(_cursor(1), 64, "the husks are passed");
        assertEq(_claim(), needR, "the next attempt pays the borrower from the 65th");
    }

    /// @dev The lens keeps its numeric cursor on the existing selector and
    ///      reports it EXACTLY whatever the read walks (Codex #2276 r10, r11
    ///      P2): a stored position, since the cursor only advances; the node
    ///      comes from the day-index view.
    function test_TheLens_ReportsTheExactCursor_WhateverTheWalk() public {
        bytes32[] memory hs = new bytes32[](3);
        for (uint256 i; i < 3; ++i) {
            hs[i] = _epochOf(1e18, _one(1), 800 + i, keccak256(abi.encode("c", i)));
            vm.warp(vm.getBlockTimestamp() + 1);
        }
        _mut().parkTransportBatchRaw(hs[0]);
        _mut().parkTransportBatchRaw(hs[1]);
        _epoch().epochPruneTransportDayCursor(1);
        (, , , uint256 c1) = _epoch().getTransportDayBatches(1, 0, 1);
        assertEq(c1, 2, "exact on a one-node walk");
        (, , , uint256 c2) = _epoch().getTransportDayBatches(1, 0, 2);
        assertEq(c2, 2, "and on a two-node walk");
        (bytes32[] memory none, , uint256 total, uint256 c3) = _epoch().getTransportDayBatches(1, 5, 1);
        assertEq(none.length, 0, "an offset past the end pages nothing");
        assertEq(c3, 2, "and still reports the cursor");
        assertEq(total, 3);
        _mut().parkTransportBatchRaw(hs[2]);
        _epoch().epochPruneTransportDayCursor(1);
        (, , , uint256 c4) = _epoch().getTransportDayBatches(1, 0, 0);
        assertEq(c4, total, "cursor == total reads the day exhausted, on an empty page");
        (, bytes32 node) = _epoch().getTransportDayIndex(1);
        assertEq(node, hs[2], "the node itself, from the day-index view");
    }

    /// @dev A late epoch whose arrival places it among the epochs the cursor
    ///      has passed takes the first place of the window, and the cursor
    ///      does not move back (Codex #2276 r11 P2): the day's order reads
    ///      exhausted, late, live; the position stays exact; coverage counts
    ///      it. A still-older late epoch, hinted, may name only the cursor.
    function test_ALateEpoch_OlderThanTheCursor_LeadsTheWindow() public {
        vm.warp(vm.getBlockTimestamp() + 1 days);
        _scene(NEED);
        uint256[] memory d1 = _one(1);
        bytes32 e1 = _epochOf(NEED, d1, 1, keccak256("e1"));
        vm.warp(vm.getBlockTimestamp() + 1);
        bytes32 e2 = _epochOf(NEED, d1, 2, keccak256("e2"));
        assertEq(_claim(), NEED, "paid from e1, the older");
        assertEq(_cursor(1), 1, "e1 passed");
        _ingress().onRewardBudgetReceived(address(vpfi), NEED, d1, CHAIN_BASE, 3, REMITTER, 0, 0, keccak256("late"), false);
        bytes32 late = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("late")));
        _mut().setPacketArrivedAtRaw(late, 2); // landed long before e1; written down now
        _epoch().materializeTransportBatchPage(late, d1);
        (bytes32[] memory order, , , uint256 cursor) = _epoch().getTransportDayBatches(1, 0, 10);
        assertEq(cursor, 1, "the cursor did not move back");
        assertEq(order[0], e1);
        assertEq(order[1], late, "the first place of the window");
        assertEq(order[2], e2);
        (uint256 avail, ) = _epoch().getTransportCoverageForDay(1);
        assertEq(avail, 2 * NEED, "visible and counted");
        _ingress().onRewardBudgetReceived(address(vpfi), NEED, d1, CHAIN_BASE, 4, REMITTER, 0, 0, keccak256("older"), false);
        bytes32 older = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("older")));
        _mut().setPacketArrivedAtRaw(older, 1);
        bytes32[] memory hints = new bytes32[](1); // zero: at the head — inside the passed prefix
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.TransportIndexHintInvalid.selector, older, 1, bytes32(0)));
        _epoch().materializeTransportBatchPageHinted(older, d1, hints);
        hints[0] = e1; // the cursor may precede an epoch older than itself
        assertEq(_epoch().materializeTransportBatchPageHinted(older, d1, hints), 1);
        (order, , , cursor) = _epoch().getTransportDayBatches(1, 0, 10);
        assertEq(cursor, 1, "still");
        assertEq(order[1], older, "the older late epoch leads the window, by key");
        assertEq(order[2], late);
        assertEq(order[3], e2);
    }

    /// @dev Late epochs after the cursor are ordered by key among themselves
    ///      whoever links them and in whatever order (Codex #2276 r12 P1):
    ///      arrivals 50 then 1 read [1, 50]; one at 25 finds its place between
    ///      them unhinted, or hinted at the epoch before it; a hint at a
    ///      passed epoch other than the cursor, or at the head, is refused.
    function test_LateEpochs_KeepTheirOrderAfterTheCursor() public {
        vm.warp(vm.getBlockTimestamp() + 1 days);
        _scene(NEED);
        uint256[] memory d1 = _one(1);
        bytes32 e0 = _epochOf(1, d1, 1, keccak256("e0"));
        _mut().parkTransportBatchRaw(e0);
        vm.warp(vm.getBlockTimestamp() + 1);
        bytes32 e1 = _epochOf(NEED, d1, 2, keccak256("e1"));
        assertEq(_claim(), NEED);
        assertEq(_cursor(1), 2, "e0 and e1 passed");
        bytes32[] memory hs = new bytes32[](3);
        uint64[3] memory at = [uint64(50), 1, 25];
        for (uint256 i; i < 3; ++i) {
            _ingress().onRewardBudgetReceived(address(vpfi), 1e18, d1, CHAIN_BASE, 10 + i, REMITTER, 0, 0, keccak256(abi.encode("late", i)), false);
            hs[i] = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256(abi.encode("late", i))));
            _mut().setPacketArrivedAtRaw(hs[i], at[i]);
        }
        _epoch().materializeTransportBatchPage(hs[0], d1); // arrival 50
        _epoch().materializeTransportBatchPage(hs[1], d1); // arrival 1, linked second
        (bytes32[] memory order, , , uint256 cursor) = _epoch().getTransportDayBatches(1, 0, 10);
        assertEq(cursor, 2, "the cursor did not move");
        assertEq(order[2], hs[1], "arrival 1 leads the window");
        assertEq(order[3], hs[0], "arrival 50 after it, although linked first");
        bytes32[] memory hints = new bytes32[](1);
        hints[0] = e0; // passed, and not the cursor
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.TransportIndexHintInvalid.selector, hs[2], 1, e0));
        _epoch().materializeTransportBatchPageHinted(hs[2], d1, hints);
        hints[0] = bytes32(0); // the head: behind the window
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.TransportIndexHintInvalid.selector, hs[2], 1, bytes32(0)));
        _epoch().materializeTransportBatchPageHinted(hs[2], d1, hints);
        hints[0] = hs[1]; // arrival 1: the epoch before arrival 25
        assertEq(_epoch().materializeTransportBatchPageHinted(hs[2], d1, hints), 1);
        (order, , , cursor) = _epoch().getTransportDayBatches(1, 0, 10);
        assertEq(cursor, 2);
        assertEq(order[2], hs[1]);
        assertEq(order[3], hs[2], "arrival 25 between them");
        assertEq(order[4], hs[0]);
    }

    /// @dev The compact overlay a day is handed carries the run's draws AND
    ///      the day's settled mark (Codex #2276 r13 P1): sixty-four epochs one
    ///      side exhausts exactly, a HALF-funded sixty-fifth, the other side on
    ///      the same day. With the mark the second side skips the husks and
    ///      reads the half; without it the preview counts the husks' full
    ///      balances again and reports more than the claim pays. The
    ///      round-9 across-sides cell cannot tell the two apart — there the
    ///      double count lands on the same total — which is why the
    ///      sixty-fifth is funded by half here.
    function test_ThePreview_CarriesTheSettledMarkInTheCompactOverlay() public {
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
        for (uint256 i; i < 64; ++i) {
            _epochOf(NEED / 64, _one(1), 400 + i, keccak256(abi.encode("slice", i)));
        }
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _epochOf(NEED / 2, _one(1), 500, keccak256("half"));
        uint256 previewed = _preview();
        assertLt(previewed, 2 * NEED, "the husks are not counted again on the second side");
        assertEq(_claim(), previewed, "the claim pays what the preview said");
    }

    // ─── round 14: the call's epoch-write budget; the exact conversion ──

    /// @dev A settlement call draws from at most `TRANSPORT_DRAW_CALL_CAP`
    ///      epochs over every day it settles (Codex #2276 r14 P1): three days
    ///      each funded by a window of sixty-four small epochs — the first
    ///      call pays two days and defers the third, keeping the two, the
    ///      preview says the same, and the next call pays the third.
    function test_TheClaim_StopsAtTheEpochWriteBudget_AndTheNextCallGoesOn() public {
        _armedDay(1, NEED);
        _armedDay(2, NEED);
        _armedDay(3, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(3);
        _entry(1, 4);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        for (uint256 d = 1; d <= 3; ++d) {
            for (uint256 i; i < 64; ++i) {
                _epochOf(NEED / 64, _one(d), 1000 * d + i, keccak256(abi.encode("small", d, i)));
            }
            vm.warp(vm.getBlockTimestamp() + 1);
        }
        assertEq(_preview(), 2 * NEED, "the preview stops where the claim will");
        assertEq(_claim(), 2 * NEED, "two days of sixty-four epochs each: the budget");
        // A settlement batched in the SAME transaction after the budget is
        // spent (Codex #2276 r15 P2): its first day defers, the earlier draws
        // are its progress, it pays nothing — and does not revert the batch.
        assertEq(_claim(), 0, "batched after the budget: nothing paid, nothing reverted");
        // On chain the next claim is its own transaction and its transient
        // count starts at zero; a test is one transaction, so clear it.
        _mut().resetTransportDrawWritesRaw();
        assertEq(_claim(), NEED, "the next transaction pays the third day");
    }

    /// @dev An attestation that finds a classification already past its cap
    ///      records the divergence rather than saturating it away (Codex
    ///      #2276 r15 P1), on Codex's shape: a ten-token rollout packet
    ///      classified seven recycled before the batch gate, admitted for
    ///      three, then attested 8F/2R — the recycled excess of five is
    ///      recorded and exposed, the recycled room is zero, and the epoch's
    ///      three are fresh-only coverage.
    function test_AnAttestation_RecordsAClassificationAlreadyPastItsCap() public {
        uint256[] memory d1 = _one(1);
        _ingress().onRewardBudgetReceived(address(vpfi), 10e18, d1, CHAIN_BASE, 2, REMITTER, 0, 0, keccak256("roll"), false);
        bytes32 h = keccak256(abi.encode(uint256(CHAIN_BASE), keccak256("roll")));
        _mut().unadmitTransportBatchRaw(h);
        _mut().classifyPacketPreGateRaw(h, 0, 7e18);
        assertEq(_epoch().admitLegacyTransportBatch(h, d1), h);
        _epoch().materializeTransportBatchPage(h, d1);
        // BEFORE the split is attested the excess is not knowable, and the lens
        // must say so rather than report a zero that reads as "within caps"
        // (Codex #2276) — this packet is about to be shown five over its cap.
        (bool attBefore, uint256 preF, uint256 preR) =
            RewardReconciliationFacet(address(diamond)).getPacketClassificationExcess(h);
        assertFalse(attBefore, "before attestation the excess is not yet knowable");
        assertEq(preF + preR, 0, "and no figure is offered in its place");
        RewardReporterFacet(address(diamond)).setRewardMessenger(address(this));
        vm.expectEmit(true, false, false, true);
        emit IngressPacketClassifiedBeyondCaps(h, 0, 5e18);
        _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, 2, 8, 2); // caps 8e18 fresh / 2e18 recycled on 10e18
        (bool att, uint256 exF, uint256 exR) =
            RewardReconciliationFacet(address(diamond)).getPacketClassificationExcess(h);
        assertTrue(att, "attested now, so a zero below is a real zero");
        assertEq(exF, 0);
        assertEq(exR, 5e18, "the recycled classification exceeds its cap by five: recorded");
        // A CORRECTION moves the five back to fresh (0F/7R -> 5F/2R against caps
        // 8F/2R). The view must follow the current classifications: both
        // components are now within their caps, so it reports no excess at all
        // (Codex #2276 — a figure frozen at attestation kept reporting five).
        _mut().setPacketClassifiedRaw(h, 5e18, 2e18);
        (att, exF, exR) = RewardReconciliationFacet(address(diamond)).getPacketClassificationExcess(h);
        assertTrue(att);
        assertEq(exF + exR, 0, "after the correction the packet is within both caps");
        // Put the classification back, so the allocation checks below see the
        // state they were written against.
        _mut().setPacketClassifiedRaw(h, 0, 7e18);
        // An unrecorded hash is refused, never read as a packet within its caps (Codex #2276 r16 P2).
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ReconciliationPacketUnknown.selector, keccak256("nobody")));
        RewardReconciliationFacet(address(diamond)).getPacketClassificationExcess(keccak256("nobody"));
        (uint256 tf, uint256 tr, ) = _alloc(1, 3e18, 3e18, type(uint256).max, type(uint256).max, type(uint256).max, 0, 0);
        assertEq(tf, 3e18, "the epoch's three are fresh room");
        assertEq(tr, 0, "and no recycled room remains under a cap the classification already exceeds");
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

    /// @dev The claim's allocator must be told the LIVE BACKING room and not
    ///      only the delivered bound (Codex #2276). Two days, because ONE
    ///      cannot show this: the residual pass reads the DOMAIN deficits,
    ///      which span every day of the call, while the coverage, the bucket
    ///      and the epochs are PER DAY — so day 1's leg choice is made against
    ///      a deficit day 2 contributes to, and day 1's own pass cannot see
    ///      day 2's epoch. On one day the same pass always tops the other leg
    ///      back up, or the mandatory draw eats the coverage and both branches
    ///      defer; neither reverts a payable claim.
    ///
    ///      Day 1 needs both legs and lists a FLEXIBLE epoch worth its fresh
    ///      leg; day 2 needs recycled only and lists a RECYCLED-ONLY epoch
    ///      worth all of it; the bucket holds day 1's recycled leg exactly; the
    ///      live custody row is EMPTY, so any live-paid fresh reverts the
    ///      claim's backing gate.
    ///
    ///      Told only the bound, day 1 reads no fresh shortfall and the domain
    ///      shows a large recycled deficit (day 2's whole leg), so day 1 spends
    ///      its flexible epoch on RECYCLED, its fresh leg falls to live, and the
    ///      gate reverts a claim both days' funding covers. Told the backing
    ///      room, day 1's fresh shortfall is its whole leg, the epoch pays
    ///      FRESH, the bucket pays day 1's recycled and day 2 pays from its own
    ///      epoch.
    function test_TheClaim_PassesBackingRoomIntoAllocation() public {
        uint256 cap = 0.4e18;
        // Day 2 carries NO schedule floor, so its whole cap is a recycled leg.
        _mut().setDayPoolStampRaw(1, uint128(2e18), uint128(2e18));
        _mut().setDayPoolStampRaw(2, uint128(0), uint128(2e18));
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
        (uint256 needF, uint256 needR) = _epochView().getObligationDomainNeeds(alice);
        // Day 1 owns all the fresh; the recycled spans both days.
        uint256 day1R = needR - cap;
        assertEq(needF, cap / 2, "fixture: day 1 is half fresh");
        assertEq(day1R, cap / 2, "fixture: and half recycled");
        assertEq(_row(LibVaipakam.RewardCustodyRow.LiveFresh), 0, "fixture: no live backing");
        // Generous ledger: the delivered bound must never be what binds, so
        // that the backing room is. Both the user and the treasury leg charge
        // it, which is why a figure sized to one leg is not enough.
        _mut().setArmedFreshLedgerRaw(100 * cap, 0);
        _mut().setRecycleBucketRaw(day1R);
        bytes32 flex = _epochOf(needF, _one(1), 11, keccak256("backing-day1-flexible"));
        vm.warp(vm.getBlockTimestamp() + 1);
        bytes32 recycledOnly = _epochOf(cap, _one(2), 12, keccak256("backing-day2-recycled"));
        _attest(12, 0, cap);
        uint256 paidBefore = _mut().getArmedFreshPaidRaw();
        assertEq(_claim(), 2 * cap, "both days are funded and must pay");
        assertEq(_mut().getArmedFreshPaidRaw() - paidBefore, 0, "and nothing was paid live");
        (uint256 ff, uint256 fr) = _legs(flex);
        assertEq(ff, needF, "day 1's flexible epoch paid the FRESH leg");
        assertEq(fr, 0, "and none of the recycled");
        (, uint256 rr) = _legs(recycledOnly);
        assertEq(rr, cap, "day 2 paid from its own epoch");
        assertEq(_cfg().getRecycleBucket(), 0, "and the bucket paid day 1's recycled");
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
