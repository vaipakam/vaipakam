// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {RewardHorizonSweepFacet} from "../src/facets/RewardHorizonSweepFacet.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibPausable} from "../src/libraries/LibPausable.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title  RewardHorizonClaimAgreementTest
 * @notice #1499 acceptance — "the expiry predicate agrees with the claim gate
 *         on every refusal cause, boundary-tested both sides".
 *
 *         The RL-3 expiry clock may only accrue while the owner COULD claim.
 *         Its predicate ({LibInteractionRewards._entryExecutableNow}, read raw
 *         through `entryExecutableNowRaw`; the authoritative sweep applies the
 *         same rule) and the claim are two implementations of one question,
 *         so each cell here is a STRADDLE: one fixture, ONE variable moved
 *         across the refusal's boundary, and on BOTH sides BOTH readers are
 *         asserted — the predicate's verdict and the claim's actual outcome.
 *
 *         Why both readers on both sides: a one-sided predicate test passes
 *         against a predicate stuck closed; a one-sided claim test says
 *         nothing about the clock. The failure mode #1499 exists to prevent is
 *         a predicate LOOSER than the claim — a clock that runs while the claim
 *         reverts, expiring an entry its owner never could have collected.
 *
 *         Fixture: the {RewardDeliveredChokepointTest} shape — a seeded
 *         Diamond, days 1 and 2 finalized and uncapped, a lender entry over
 *         both, the chain configured as a MIRROR (the role whose delivered
 *         ledger is live), reward custody inactive and no `D*` installed, so
 *         the whole entry is LEGACY fresh: exactly the vintage design row 13
 *         says the bound must measure. The delivered ledger is written raw so
 *         the bound is the only variable a cell moves.
 */
contract RewardHorizonClaimAgreementTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    uint256 internal constant DIAMOND_SEED = 100_000_000 ether;
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    uint256 internal constant AMPLE = 1_000_000e18; // far above the fixture's ~2e22-wei payout
    uint256 internal constant GAP = 5 days; // under the 7-day max observation gap
    address internal alice;
    uint256 internal entryId;

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
        uint256 have = vpfi.balanceOf(address(this));
        if (DIAMOND_SEED > have) vpfi.mint(address(this), DIAMOND_SEED - have);
        vpfi.transfer(address(diamond), DIAMOND_SEED);
        AdminFacet(address(diamond)).setTreasury(makeAddr("treasury"));
        alice = makeAddr("agree-alice");
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(block.timestamp);
        vm.warp(block.timestamp + 5 days);
        _mut().setKnownGlobalDailyInterest(1, 100e18, 0, true);
        _mut().setKnownGlobalDailyInterest(2, 100e18, 0, true);
        _mut().setDayCapThreshold18(1, type(uint256).max);
        _mut().setDayCapThreshold18(2, type(uint256).max);

        // The mirror role: `deliveredFreshBound` reads `received − paid` here.
        vm.chainId(CHAIN_ARB);
        _rep().setIsCanonicalRewardChain(false);
        _rep().setBaseChainId(CHAIN_BASE);
        RewardRemittanceFacet(address(diamond)).setRewardRemittanceReceiver(address(this));

        _cfg().setRewardClaimHorizonDays(180);
        entryId = _mut().pushRewardEntry(alice, 42, LibVaipakam.RewardSide.Lender, 100e18, 1);
        _mut().closeRewardEntryRaw(entryId, 3); // accrues days 1 + 2, all legacy fresh
        // Advance the side cursors the way the claim does first: the
        // predicate is a view and cannot, and an unadvanced entry prices 0.
        _mut().userClaimFundingNeedRaw(alice);
    }

    // ─── accessors ───────────────────────────────────────────────────────────

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    function _cfg() internal view returns (ConfigFacet) {
        return ConfigFacet(address(diamond));
    }

    function _rep() internal view returns (RewardReporterFacet) {
        return RewardReporterFacet(address(diamond));
    }

    function _lens() internal view returns (InteractionRewardsLensFacet) {
        return InteractionRewardsLensFacet(address(diamond));
    }

    function _rlens() internal view returns (RewardRemittanceLensFacet) {
        return RewardRemittanceLensFacet(address(diamond));
    }

    function _sweeper() internal view returns (RewardHorizonSweepFacet) {
        return RewardHorizonSweepFacet(address(diamond));
    }

    function _ids(uint256 id) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = id;
    }

    function _executable() internal view returns (bool) {
        return _mut().entryExecutableNowRaw(entryId);
    }

    function _claim() internal returns (uint256 paid) {
        vm.prank(alice);
        (paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewards();
    }

    /// @dev The claim's EXACT fresh outflow, learned from a funded run that is
    ///      then rewound: the pool arithmetic rounds by wei, and a straddle
    ///      needs the true figure rather than the half-pool sum.
    function _measureActual() internal returns (uint256 actual) {
        uint256 snap = vm.snapshotState();
        _mut().setArmedFreshLedgerRaw(AMPLE, 0);
        actual = _claim();
        vm.revertToState(snap);
        assertGt(actual, 1, "fixture pays something");
    }

    /// @dev The AUTHORITATIVE clock's verdict over one real interval, read off
    ///      the countdown: `expiresAt = now + (required − elapsed)`, so an
    ///      interval the sweep CREDITS leaves the deadline where it was and one
    ///      it does not credit pushes it later by exactly the interval. The
    ///      first sweep settles any pending blocked/unblocked observation so
    ///      the measured interval is clean.
    function _clockAccruesOverGap() internal returns (bool accrued) {
        _sweeper().sweepExpiredInteractionRewards(_ids(entryId));
        (uint64 stamp, uint64 before_) = _lens().getRewardEntryExpiry(entryId);
        assertGt(stamp, 0, "fixture: the clock is stamped");
        vm.warp(vm.getBlockTimestamp() + GAP);
        _sweeper().sweepExpiredInteractionRewards(_ids(entryId));
        (, uint64 after_) = _lens().getRewardEntryExpiry(entryId);
        if (after_ == before_) return true;
        assertEq(uint256(after_), uint256(before_) + GAP, "a paused clock recedes by exactly the interval");
        return false;
    }

    /// @dev Stamp the clock on an executable observation, then hand the cell
    ///      the ledger it wants.
    function _stampThenLedger(uint256 delivered) internal {
        _mut().setArmedFreshLedgerRaw(AMPLE, 0);
        _sweeper().sweepExpiredInteractionRewards(_ids(entryId)); // stamps
        _mut().setArmedFreshLedgerRaw(delivered, 0);
    }

    // ─── cell 1: the delivered bound, ±1 wei (row 13) ───────────────────────

    /// @notice Refusal cause: the claim's fresh outflow exceeds the delivered
    ///         headroom (`DeliveredFreshBoundExceeded` at the claim
    ///         chokepoint). Variable: delivered = actual − 1 vs actual.
    /// @dev    BOTH sides, BOTH readers. One wei short: the predicate reads
    ///         false, the sweep does not credit the interval (the deadline
    ///         recedes), and the claim reverts with the exact figures. Exactly
    ///         met: predicate true, the clock accrues, the claim pays `actual`.
    ///         Kills: dropping `freshNeed > deliveredFreshBound` in the
    ///         predicate (short side reads true); the same in the sweep's
    ///         `deliveredPayable` (short side's clock accrues); `>` → `>=`
    ///         (met side reads false); and an off-by-one in the claim's
    ///         chokepoint (either claim assertion).
    function test_DeliveredBound_StraddlesOneWei_PredicateClockAndClaimAgree() public {
        uint256 actual = _measureActual();

        // One wei short.
        _stampThenLedger(actual - 1);
        assertFalse(_executable(), "short by one wei: the predicate reads non-executable");
        assertFalse(_clockAccruesOverGap(), "short by one wei: the authoritative clock does not accrue");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DeliveredFreshBoundExceeded.selector, actual, actual - 1));
        RewardClaimFacet(address(diamond)).claimInteractionRewards();

        // Exactly met — the ONE variable moves by one wei.
        _mut().setArmedFreshLedgerRaw(actual, 0);
        assertTrue(_executable(), "exactly met: the predicate reads executable");
        assertTrue(_clockAccruesOverGap(), "exactly met: the clock accrues");
        assertEq(_claim(), actual, "exactly met: the claim pays in full");
        (, uint256 remaining) = _rlens().getDeliveredFreshBound();
        assertEq(remaining, 0, "and consumes the headroom exactly");
    }

    // ─── cell 2: the bound with the pool cap applied FIRST ──────────────────

    /// @notice Refusal cause: the delivered bound, measured on the POOL-CAPPED
    ///         need. Raw need ≫ poolRemaining = P, so the claim truncates its
    ///         fresh to P before the chokepoint; the bound must compare P, not
    ///         the raw need. Variable: delivered = P − 1 vs P.
    /// @dev    Kills: dropping `_cappedFreshNeed` so the raw need is compared
    ///         (the met side reads false — a predicate STRICTER than the claim
    ///         there, which never terminalizes a retired era over a claim that
    ///         succeeds); and dropping the bound refusal (the short side reads
    ///         true while the claim reverts).
    function test_DeliveredBound_PoolCappedFirst_StraddlesP() public {
        uint256 actual = _measureActual();
        uint256 p = 1e18;
        assertGt(actual, 1000 * p, "fixture: the raw need dwarfs the pool headroom");
        _mut().setInteractionPoolPaidOut(LibVaipakam.VPFI_INTERACTION_POOL_CAP - p);
        assertEq(_lens().getInteractionPoolPaidOut(), LibVaipakam.VPFI_INTERACTION_POOL_CAP - p);

        _mut().setArmedFreshLedgerRaw(p - 1, 0);
        assertFalse(_executable(), "P - 1 delivered: non-executable on the capped need");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DeliveredFreshBoundExceeded.selector, p, p - 1));
        RewardClaimFacet(address(diamond)).claimInteractionRewards();

        _mut().setArmedFreshLedgerRaw(p, 0);
        assertTrue(_executable(), "P delivered: executable - the cap was applied first");
        assertEq(_claim(), p, "and the claim pays exactly the pool headroom");
    }

    // ─── cell 3: the detached role ──────────────────────────────────────────

    /// @notice Refusal cause: closure 3 — a DETACHED chain bounds at zero, so
    ///         any fresh outflow is refused. Variable: the role (Mirror vs
    ///         Detached), with delivered headroom above the need throughout.
    /// @dev    As Mirror: predicate true, claim pays (measured under a
    ///         snapshot so the same entry is then detached). Detached:
    ///         predicate false, claim reverts `DeliveredFreshBoundExceeded(·,0)`.
    ///         Kills dropping the predicate's bound refusal (detached reads
    ///         executable while the claim reverts). By the same token it would
    ///         catch the pre-closure-3 mirror-only gating of that test, which
    ///         let Detached skip it (that exact shape was not re-run).
    function test_DetachedRole_PredicateAndClaimBothRefuse_MirrorBothPay() public {
        uint256 actual = _measureActual();
        _mut().setArmedFreshLedgerRaw(actual + 1e18, 0);

        assertTrue(_executable(), "mirror, delivered above need: executable");
        uint256 snap = vm.snapshotState();
        assertEq(_claim(), actual, "mirror: the claim pays");
        vm.revertToState(snap);

        _rep().setBaseChainId(0); // detach: configured, then base cleared
        assertEq(_rep().getRewardRole(), uint8(LibVaipakam.RewardRole.Detached), "fixture: detached");
        (, uint256 remaining) = _rlens().getDeliveredFreshBound();
        assertEq(remaining, 0, "detached bounds at zero");
        assertFalse(_executable(), "detached: non-executable");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DeliveredFreshBoundExceeded.selector, actual, 0));
        RewardClaimFacet(address(diamond)).claimInteractionRewards();
    }

    // ─── cell 4: paused ─────────────────────────────────────────────────────

    /// @notice Refusal cause: the protocol pause (every claim reverts
    ///         `EnforcedPause`). Variable: paused vs unpaused, on a stamped
    ///         entry with every other gate open.
    /// @dev    Kills: dropping `if (LibPausable.paused()) return false;` from
    ///         the predicate (paused side reads true while the claim reverts).
    function test_Paused_PredicateAndClaimBothRefuse_UnpausedBothPay() public {
        uint256 actual = _measureActual();
        _stampThenLedger(AMPLE);
        (uint64 stamp, ) = _lens().getRewardEntryExpiry(entryId);
        assertGt(stamp, 0, "fixture: stamped");

        assertTrue(_executable(), "unpaused: executable");
        uint256 snap = vm.snapshotState();
        assertEq(_claim(), actual, "unpaused: the claim pays");
        vm.revertToState(snap);

        AdminFacet(address(diamond)).pause();
        assertFalse(_executable(), "paused: non-executable");
        vm.prank(alice);
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        RewardClaimFacet(address(diamond)).claimInteractionRewards();
    }
}
