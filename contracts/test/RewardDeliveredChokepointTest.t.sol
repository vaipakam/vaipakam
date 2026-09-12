// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {RewardHorizonSweepFacet} from "../src/facets/RewardHorizonSweepFacet.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibVpfiRecycle} from "../src/libraries/LibVpfiRecycle.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title RewardDeliveredChokepointTest
 * @notice #1566 closure 2 — the delivered-fresh ledger measures what MOVES,
 *         at the chokepoints where it moves, whatever the vintage.
 *
 *         Before this change the paid side was charged only for ARMED days
 *         (inside the share-of-pool walk) while the received side counted only
 *         ARMED-attributable deliveries; a pre-`D*` legacy claim never
 *         consulted the bound and drew on the Diamond's shared balance. Every
 *         test here straddles the rule it pins: the same fixture is run on the
 *         side the change refuses AND the side it permits, so a vacuous guard
 *         cannot pass.
 *
 *         Fixture: the RewardClaimBackingSeparation / RewardClaimHorizon
 *         shape — a VPFI token, a seeded Diamond, launch at t0, days 1 and 2
 *         known — with the chain configured as a MIRROR reward chain (the
 *         role whose ledger is live) unless a test says otherwise. No `D*` is
 *         installed, so every reward day is a LEGACY day — the exact slice the
 *         old rule left unbounded.
 */
contract RewardDeliveredChokepointTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    uint256 internal constant DIAMOND_SEED = 100_000_000 ether;
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    address internal constant REMITTER = address(0xBA5E);
    uint256 internal constant NOTICE = 90 days;
    uint256 internal constant MAX_GAP = 7 days;
    address internal alice;

    function setUp() public {
        setupHelper();
        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                VPFIToken.initialize,
                (address(this), address(this), address(this))
            )
        );
        vpfi = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
        uint256 have = vpfi.balanceOf(address(this));
        if (DIAMOND_SEED > have) vpfi.mint(address(this), DIAMOND_SEED - have);
        vpfi.transfer(address(diamond), DIAMOND_SEED);
        AdminFacet(address(diamond)).setTreasury(makeAddr("treasury"));
        alice = makeAddr("alice");
        _facet().setInteractionLaunchTimestamp(block.timestamp);
        vm.warp(block.timestamp + 5 days);
        _mut().setKnownGlobalDailyInterest(1, 100e18, 0, true);
        _mut().setKnownGlobalDailyInterest(2, 100e18, 0, true);
        _mut().setDayCapThreshold18(1, type(uint256).max);
        _mut().setDayCapThreshold18(2, type(uint256).max);
    }

    // ─── fixture helpers ─────────────────────────────────────────────────────

    function _facet() internal view returns (InteractionRewardsFacet) {
        return InteractionRewardsFacet(address(diamond));
    }
    function _lens() internal view returns (InteractionRewardsLensFacet) {
        return InteractionRewardsLensFacet(address(diamond));
    }
    function _rlens() internal view returns (RewardRemittanceLensFacet) {
        return RewardRemittanceLensFacet(address(diamond));
    }
    function _remit() internal view returns (RewardRemittanceFacet) {
        return RewardRemittanceFacet(address(diamond));
    }
    function _rep() internal view returns (RewardReporterFacet) {
        return RewardReporterFacet(address(diamond));
    }
    function _cfg() internal view returns (ConfigFacet) {
        return ConfigFacet(address(diamond));
    }
    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }
    function _sweeper() internal view returns (RewardHorizonSweepFacet) {
        return RewardHorizonSweepFacet(address(diamond));
    }

    /// @dev The role whose delivered ledger is LIVE. `deliveredFreshBound`
    ///      reads `received − paid` here and `max` on canonical/unconfigured.
    function _configureMirror() internal {
        vm.chainId(CHAIN_ARB);
        _rep().setIsCanonicalRewardChain(false);
        _rep().setBaseChainId(CHAIN_BASE);
        _remit().setRewardRemittanceReceiver(address(this));
    }

    /// @dev A stated-composition delivery for LEGACY day 1 (no `D*` is ever
    ///      installed in this file). Under the retired rule its fresh share
    ///      was `uncounted`; under closure 2 it is `received`.
    function _deliverFresh(uint256 fresh, uint256 recycled, uint256 remitId)
        internal
    {
        uint256[] memory days_ = new uint256[](1);
        days_[0] = 1;
        _remit().onRewardBudgetReceived(
            address(vpfi), fresh + recycled, days_, CHAIN_BASE, remitId, REMITTER, recycled, fresh
        );
    }

    function _seedPayable(address user, uint64 loanId)
        internal
        returns (uint256 id, uint256 expected)
    {
        id = _mut().pushRewardEntry(
            user, loanId, LibVaipakam.RewardSide.Lender, 100e18, 1
        );
        _mut().closeRewardEntryRaw(id, 3); // endDay = 3 ⇒ accrues days 1 + 2
        expected =
            _lens().getInteractionHalfPoolForDay(1) +
            _lens().getInteractionHalfPoolForDay(2);
    }

    function _ids(uint256 id) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = id;
    }

    // ─── the claim chokepoint ────────────────────────────────────────────────

    /// A LEGACY claim on a mirror with nothing delivered is REFUSED before the
    /// transfer. This is the exact over-draw the closure removes: the old walk
    /// never consulted the bound for a pre-`D*` slice, so this claim used to
    /// pay in full out of the shared balance.
    function test_MirrorLegacyClaim_RefusedBeforeTransfer_WhenNothingDelivered()
        public
    {
        _configureMirror();
        (, uint256 expected) = _seedPayable(alice, 42);
        assertGt(expected, 0, "fixture pays something");
        (uint256 paid0, uint256 remaining0) = _rlens().getDeliveredFreshBound();
        assertEq(remaining0, 0, "nothing delivered");
        uint256 diamondBefore = vpfi.balanceOf(address(diamond));

        vm.prank(alice);
        vm.expectPartialRevert(DeliveredFreshBoundExceeded.selector);
        RewardClaimFacet(address(diamond)).claimInteractionRewards();

        assertEq(vpfi.balanceOf(alice), 0, "nothing paid");
        assertEq(vpfi.balanceOf(address(diamond)), diamondBefore, "nothing left the Diamond");
        (uint256 paid1, ) = _rlens().getDeliveredFreshBound();
        assertEq(paid1, paid0, "the whole claim rolled back - no charge either");
    }

    /// The same claim, once a delivery has landed, pays — and the paid ledger
    /// is charged by the FRESH component of what moved (all of it here: the
    /// bucket is empty), against a delivery that under the retired rule would
    /// have been uncounted because its day is pre-`D*`.
    function test_MirrorLegacyClaim_PaysAndChargesFresh_WhenDelivered() public {
        _configureMirror();
        (, uint256 expected) = _seedPayable(alice, 42);
        uint256 delivered = expected + 1e18;
        _deliverFresh(delivered, 0, 7);

        (uint256 counted, uint256 uncounted) = _rlens().getDeliveredFreshPosition();
        assertEq(counted, delivered, "a legacy-day delivery is counted (vintage-blind)");
        assertEq(uncounted, 0, "nothing uncounted when the composition is stated");

        vm.prank(alice);
        (uint256 claimed, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewards();

        assertApproxEqAbs(claimed, expected, 1e6, "paid in full (pool arithmetic rounds by wei)");
        assertEq(vpfi.balanceOf(alice), claimed, "the claimant holds exactly what was paid");
        (uint256 paid, uint256 remaining) = _rlens().getDeliveredFreshBound();
        assertEq(paid, claimed, "charged by the fresh component of what moved - all of it here");
        assertEq(remaining, delivered - claimed, "headroom is what is left");
    }

    /// Straddle the bound exactly: delivered one wei short of the claim refuses,
    /// delivered exactly the claim pays. Reachability is not discrimination.
    function test_MirrorLegacyClaim_StraddlesTheBound() public {
        _configureMirror();
        _seedPayable(alice, 42);
        // Learn the EXACT fresh outflow from a funded dry run, then rewind:
        // the pool arithmetic rounds by wei, and a straddle needs the true
        // figure, not the half-pool sum.
        uint256 snap = vm.snapshotState();
        _deliverFresh(1_000_000e18, 0, 99); // far above what the fixture pays (~2e22 wei)
        vm.prank(alice);
        (uint256 actual, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewards();
        vm.revertToState(snap);
        assertGt(actual, 1, "fixture pays something");

        _deliverFresh(actual - 1, 0, 7); // one wei short
        vm.prank(alice);
        vm.expectPartialRevert(DeliveredFreshBoundExceeded.selector);
        RewardClaimFacet(address(diamond)).claimInteractionRewards();

        _deliverFresh(1, 0, 8); // the missing wei
        vm.prank(alice);
        RewardClaimFacet(address(diamond)).claimInteractionRewards();
        assertEq(vpfi.balanceOf(alice), actual, "paid once the bound is met");
        (, uint256 remaining) = _rlens().getDeliveredFreshBound();
        assertEq(remaining, 0, "exactly consumed");
    }

    /// Outside the Mirror role the bound is `max` and NOTHING is charged: the
    /// canonical / unconfigured column lands with slice 4 and its migration.
    function test_UnconfiguredClaim_UnboundedAndUncharged() public {
        (, uint256 expected) = _seedPayable(alice, 42);
        vm.prank(alice);
        (uint256 claimed, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewards();
        assertApproxEqAbs(claimed, expected, 1e6, "pays as before");
        assertEq(vpfi.balanceOf(alice), claimed, "claimant holds it");
        (uint256 paid, uint256 remaining) = _rlens().getDeliveredFreshBound();
        assertEq(paid, 0, "no charge outside the live ledger");
        assertEq(remaining, type(uint256).max, "unbounded");
    }

    // ─── the received side ───────────────────────────────────────────────────

    /// A delivery with a stated composition credits its authenticated FRESH
    /// share whatever days it funds; the recycled share is relocated custody
    /// into the bucket; an old-wire packet (no composition) stays UNCOUNTED
    /// whole, for the cutover epoch to reconcile.
    function test_ReceivedSide_FreshAnyVintage_OldWireUncounted() public {
        _configureMirror();
        uint256 bucketBefore = _cfg().getRecycleBucket();
        _deliverFresh(5e18, 2e18, 11); // stated: 5 fresh + 2 recycled, legacy day
        (uint256 counted, uint256 uncounted) = _rlens().getDeliveredFreshPosition();
        assertEq(counted, 5e18, "fresh share counted on a legacy day");
        assertEq(uncounted, 0, "nothing uncounted");
        assertEq(_cfg().getRecycleBucket() - bucketBefore, 2e18, "recycled share relocated");

        uint256[] memory days_ = new uint256[](1);
        days_[0] = 1;
        _remit().onRewardBudgetReceived(
            address(vpfi), 3e18, days_, CHAIN_BASE, 12, REMITTER, 0, 0
        ); // old wire: no split stated
        (counted, uncounted) = _rlens().getDeliveredFreshPosition();
        assertEq(counted, 5e18, "an unstated composition counts nothing");
        assertEq(uncounted, 3e18, "...and lands whole in uncounted");
    }

    // ─── the reward-absorption operation ─────────────────────────────────────

    /// An expired LEGACY entry sweeps its fresh value into the bucket through
    /// the reward operation, which charges the paid ledger by that fresh
    /// total. Under the retired rule a legacy day charged nothing.
    function test_ExpirySweep_ChargesFreshTotal_OnMirror() public {
        _configureMirror();
        _cfg().setRewardClaimHorizonDays(180);
        (uint256 id, uint256 expected) = _seedPayable(alice, 42);
        _deliverFresh(expected + 1e18, 0, 7);
        assertEq(_sweeper().sweepExpiredInteractionRewards(_ids(id)), 0, "stamps only");
        // accrue H + notice of executable time in gaps the accumulator accepts
        uint256 remaining = 180 days + NOTICE;
        uint256 swept;
        while (remaining > 0) {
            uint256 step = remaining < MAX_GAP ? remaining : MAX_GAP;
            vm.warp(vm.getBlockTimestamp() + step);
            swept = _sweeper().sweepExpiredInteractionRewards(_ids(id));
            remaining -= step;
            if (swept > 0) break;
        }
        if (swept == 0) {
            vm.warp(vm.getBlockTimestamp() + MAX_GAP);
            swept = _sweeper().sweepExpiredInteractionRewards(_ids(id));
        }
        assertGt(swept, 0, "expired");
        (uint256 paid, ) = _rlens().getDeliveredFreshBound();
        assertEq(paid, swept, "the expiry's fresh total charged the paid ledger");
    }

    /// The reward operation REJECTS beyond the remaining delivered headroom,
    /// before any credit — proven directly, because both current sweep callers
    /// pre-bound their input and could never reach this branch. A future
    /// reward terminal cannot skip it: there is no other door.
    function test_RewardOperation_RejectsBeyondHeadroom_ThenCreditsWithin() public {
        _configureMirror();
        uint256 bucketBefore = _cfg().getRecycleBucket();
        vm.expectRevert(
            abi.encodeWithSelector(DeliveredFreshBoundExceeded.selector, 1e18, 0)
        );
        _mut().creditRecycleRaw(LibVpfiRecycle.RecycleSource.ForfeitedReward, 0, 1e18);
        assertEq(_cfg().getRecycleBucket(), bucketBefore, "no credit on refusal");

        _deliverFresh(1e18, 0, 7);
        _mut().creditRecycleRaw(LibVpfiRecycle.RecycleSource.ForfeitedReward, 0, 1e18);
        assertEq(_cfg().getRecycleBucket() - bucketBefore, 1e18, "credited within headroom");
        (uint256 paid, uint256 remaining) = _rlens().getDeliveredFreshBound();
        assertEq(paid, 1e18, "and charged");
        assertEq(remaining, 0, "headroom consumed");
    }

    /// A DETACHED chain bounds at zero (closure 3), so the reward operation
    /// refuses every fresh absorption there — the fail-closed half, exercised
    /// through the closure-2 door.
    function test_RewardOperation_RefusedOnDetached() public {
        _configureMirror();
        _rep().setBaseChainId(0); // detach: configured, then base cleared
        vm.expectRevert(
            abi.encodeWithSelector(DeliveredFreshBoundExceeded.selector, 5, 0)
        );
        _mut().creditRecycleRaw(LibVpfiRecycle.RecycleSource.ExpiredReward, 0, 5);
    }

    // ─── the non-reward inflow operations ────────────────────────────────────

    /// Each proven inflow class has its own delta-checked door: a credit whose
    /// tokens did not arrive (the snapshot equals the current balance) is
    /// refused, and one whose delta covers the amount is credited under the
    /// operation's own tag. None of them touch the paid ledger.
    function test_InflowOperations_DeltaChecked_NeverChargeTheLedger() public {
        _configureMirror();
        uint256 bal = vpfi.balanceOf(address(diamond));
        LibVpfiRecycle.RecycleSource[3] memory classes = [
            LibVpfiRecycle.RecycleSource.NotificationFee,
            LibVpfiRecycle.RecycleSource.FullTariff,
            LibVpfiRecycle.RecycleSource.SpendGatedPerk
        ];
        uint256 bucketBefore = _cfg().getRecycleBucket();
        for (uint256 i; i < 3; i++) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    RecycleInflowUnverified.selector, uint8(classes[i]), 4e18, 0
                )
            );
            _mut().creditInflowRawWithBefore(classes[i], 1, 4e18, bal); // no delta
            _mut().creditInflowRawWithBefore(classes[i], 1, 4e18, bal - 4e18); // delta ok
        }
        assertEq(_cfg().getRecycleBucket() - bucketBefore, 12e18, "three verified credits");
        (uint256 paid, ) = _rlens().getDeliveredFreshBound();
        assertEq(paid, 0, "inflows never charge the delivered ledger");
    }

    /// A source with no operation has no door at all.
    function test_NoDoorForAnyOtherSource() public {
        vm.expectRevert(bytes("creditRecycleRaw: no door exists for this source (#1566 closure 2)"));
        _mut().creditRecycleRaw(LibVpfiRecycle.RecycleSource.MatcherRemainder, 0, 1);
    }
}
