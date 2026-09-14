// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
import {RewardHorizonSweepFacet} from "../src/facets/RewardHorizonSweepFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VPFIDiscountAccumulatorFacet} from "../src/facets/VPFIDiscountAccumulatorFacet.sol";
import {RewardCustodyHolder} from "../src/RewardCustodyHolder.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibPausable} from "../src/libraries/LibPausable.sol";
import {LibVpfiRecycle} from "../src/libraries/LibVpfiRecycle.sol";
import {LibInteractionRewards} from "../src/libraries/LibInteractionRewards.sol";
import {ICrossChainMessenger} from "../src/crosschain/ICrossChainMessenger.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {MockCrossChainMessenger} from "./mocks/MockCrossChainMessenger.sol";

/// @dev The RL-1 forced-failure harness, reused: a Replace-cut over the
///      broadcast-free rollup makes the vault credit's LAST step revert after
///      the holder → vault release already executed in the same frame.
contract RevertingRollupForCutover {
    error ForcedRollupFailure();

    function rollupUserDiscountLocal(address, uint256) external pure {
        revert ForcedRollupFailure();
    }
}

/**
 * @title RewardCustodyCutoverTest
 * @notice #1566 slice 4 PR B — the custody cutover: on an ACTIVATED
 *         deployment every reward read and debit goes through the holder's
 *         rows, the canonical column takes its real bound, funding is a
 *         transfer into the holder under the deficit split, transports name
 *         their custody, and the role setters freeze.
 *
 *         Every rule is pinned on both sides where it has two: the same
 *         fixture refuses before the condition and pays after it, so a
 *         vacuous guard cannot pass. Fixture: the chokepoint suite's shape —
 *         a VPFI token, launch at t0, days 1 and 2 known, one payable entry
 *         — with the role chosen per test.
 */
contract RewardCustodyCutoverTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    uint32 internal constant CHAIN_OP = 10;
    uint256 internal constant CAP = 69_000_000 ether;
    address internal constant REMITTER = address(0xBA5E);
    address internal alice;
    address internal treasury;

    /// @dev The remittance refunds its fee surplus to the caller.
    receive() external payable {}

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
        treasury = makeAddr("treasury");
        AdminFacet(address(diamond)).setTreasury(treasury);
        alice = makeAddr("alice");
        _facet().setInteractionLaunchTimestamp(block.timestamp);
        vm.warp(block.timestamp + 5 days);
        _mut().setKnownGlobalDailyInterest(1, 100e18, 0, true);
        _mut().setKnownGlobalDailyInterest(2, 100e18, 0, true);
        _mut().setDayCapThreshold18(1, type(uint256).max);
        _mut().setDayCapThreshold18(2, type(uint256).max);
    }

    // ─── accessors ───────────────────────────────────────────────────────────

    function _custody() internal view returns (RewardCustodyFacet) {
        return RewardCustodyFacet(address(diamond));
    }
    function _rep() internal view returns (RewardReporterFacet) {
        return RewardReporterFacet(address(diamond));
    }
    function _remit() internal view returns (RewardRemittanceFacet) {
        return RewardRemittanceFacet(address(diamond));
    }
    function _rlens() internal view returns (RewardRemittanceLensFacet) {
        return RewardRemittanceLensFacet(address(diamond));
    }
    function _sweeper() internal view returns (RewardHorizonSweepFacet) {
        return RewardHorizonSweepFacet(address(diamond));
    }
    function _facet() internal view returns (InteractionRewardsFacet) {
        return InteractionRewardsFacet(address(diamond));
    }
    function _lens() internal view returns (InteractionRewardsLensFacet) {
        return InteractionRewardsLensFacet(address(diamond));
    }
    function _cfg() internal view returns (ConfigFacet) {
        return ConfigFacet(address(diamond));
    }
    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }
    function _vault() internal view returns (VaultFactoryFacet) {
        return VaultFactoryFacet(address(diamond));
    }
    function _claim() internal view returns (RewardClaimFacet) {
        return RewardClaimFacet(address(diamond));
    }
    function _admin() internal view returns (AdminFacet) {
        return AdminFacet(address(diamond));
    }

    function _row(LibVaipakam.RewardCustodyRow r) internal view returns (uint256) {
        return _custody().rewardCustodyRow(r);
    }
    function _live() internal view returns (uint256) {
        return _row(LibVaipakam.RewardCustodyRow.LiveFresh);
    }
    function _recycledRow() internal view returns (uint256) {
        return _row(LibVaipakam.RewardCustodyRow.Recycled);
    }
    function _holder() internal view returns (address) {
        return _custody().rewardCustodyHolder();
    }
    function _held() internal view returns (uint256) {
        return vpfi.balanceOf(_holder());
    }
    function _epoch() internal view returns (uint64 epoch) {
        (, , , epoch) = LibPausable.decodePausableSlot(
            vm.load(address(diamond), LibPausable.PAUSABLE_STORAGE_POSITION)
        );
    }
    function _ledger() internal view returns (uint256 received, uint256 paid) {
        (received, paid) = _custody().armedFreshLedger();
    }

    function _becomeCanonical() internal {
        vm.chainId(CHAIN_BASE);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(true);
    }

    function _becomeMirror() internal {
        vm.chainId(CHAIN_ARB);
        _rep().setIsCanonicalRewardChain(false);
        _rep().setBaseChainId(CHAIN_BASE);
        _remit().setRewardRemittanceReceiver(address(this));
    }

    function _seedDiamond(uint256 amount) internal {
        vpfi.mint(address(this), amount);
        vpfi.transfer(address(diamond), amount);
    }

    function _seedPayable(address user) internal returns (uint256 id, uint256 expected) {
        id = _mut().pushRewardEntry(user, 42, LibVaipakam.RewardSide.Lender, 100e18, 1);
        _mut().closeRewardEntryRaw(id, 3);
        expected = _lens().getInteractionHalfPoolForDay(1) + _lens().getInteractionHalfPoolForDay(2);
    }

    /// @dev A stated-composition delivery on a mirror, as the receiver would
    ///      present it: the tokens are already at the Diamond.
    function _deliverFresh(uint256 fresh, uint256 recycled, uint256 remitId) internal {
        uint256[] memory days_ = new uint256[](1);
        days_[0] = 1;
        _remit().onRewardBudgetReceived(
            address(vpfi), fresh + recycled, days_, CHAIN_BASE, remitId, REMITTER, recycled, fresh
        );
    }

    // ─── 1. activation ───────────────────────────────────────────────────────

    /// A Detached deployment does not activate in this slice: its receive
    /// ingresses do not yet refuse by role, so activation waits for PR C's
    /// era registry (Codex #2186 r1 P1).
    function test_Activation_RefusesADetachedDeployment() public {
        _becomeMirror();
        _admin().pause();
        _custody().bindRewardCustodyHolder();
        uint64 epoch = _epoch();
        _custody().rebaseArmedFreshPaid(0, epoch);
        _rep().setBaseChainId(0); // detach: no allocation yet, so not frozen
        assertEq(uint8(_rep().getRewardRole()), uint8(LibVaipakam.RewardRole.Detached), "detached");
        vm.expectRevert(RewardCustodyActivationDetachedNotSupported.selector);
        _custody().activateRewardCustody(epoch, false);
    }

    /// An Unconfigured deployment can never activate: its column stays at
    /// Diamond custody by design, and nothing here changes what it pays.
    function test_Activation_RefusesAnUnconfiguredDeployment() public {
        _admin().pause();
        _custody().bindRewardCustodyHolder();
        uint64 epoch = _epoch();
        _custody().rebaseArmedFreshPaid(0, epoch);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCustodyActivationRequiresConfiguredRole.selector,
                uint8(LibVaipakam.RewardRole.Unconfigured)
            )
        );
        _custody().activateRewardCustody(epoch, false);
        assertFalse(_custody().rewardCustodyActivated(), "not activated");
    }

    /// The ceremony's gates, each straddled: unpaused refuses; a stale epoch
    /// refuses; an unconsumed rebase refuses; the live epoch under the manual
    /// pause with the rebase consumed activates — once.
    function test_Activation_RequiresManualPauseLiveEpochAndRebase() public {
        _becomeCanonical();
        _custody().bindRewardCustodyHolder();
        uint64 epochUnpaused = _epoch();
        vm.expectRevert(LibPausable.ExpectedManualPause.selector);
        _custody().activateRewardCustody(epochUnpaused, false);

        _admin().pause();
        uint64 epoch = _epoch();
        vm.expectRevert(
            abi.encodeWithSelector(RewardCustodyActivationStalePauseEpoch.selector, epoch - 1, epoch)
        );
        _custody().activateRewardCustody(epoch - 1, false);

        vm.expectRevert(RewardCustodyActivationRequiresRebase.selector);
        _custody().activateRewardCustody(epoch, false);

        _custody().rebaseArmedFreshPaid(0, epoch);
        _custody().activateRewardCustody(epoch, false);
        assertTrue(_custody().rewardCustodyActivated(), "activated");
        assertTrue(_custody().rewardRoleChangesFrozen(), "the freeze armed");

        vm.expectRevert(RewardCustodyAlreadyActivated.selector);
        _custody().activateRewardCustody(epoch, false);
    }

    /// Activation and every bootstrap write require the COMPLETE-cut record
    /// to be current (Codex #2186 r4 P1, r5 P1): the version this tree's
    /// consumers implement, and the ROUTING — every facet with its selectors
    /// — as the complete cut left it. A cut after the record refuses with the
    /// four values named, whether it re-routes one selector to a mock or only
    /// REMOVES one selector from a facet that keeps its others (the case an
    /// address-only record was blind to); a stale version refuses on its own;
    /// re-recording under the pause, as the complete refresh does, admits the
    /// activation again; and the record itself is taken under the manual
    /// pause only.
    function test_Activation_RequiresTheCompleteCutRecord() public {
        _becomeCanonical();
        _seedDiamond(1e18);
        _admin().pause();
        _custody().bindRewardCustodyHolder();
        uint64 epoch = _epoch();
        _custody().rebaseArmedFreshPaid(0, epoch);
        (uint32 stampedV, uint32 requiredV, bytes32 stamped, bytes32 current) =
            _custody().rewardCustodyCutoverStatus();
        assertEq(stampedV, requiredV, "the build recorded this tree's version");
        assertEq(stamped, current, "the build recorded the routing");

        // A partial cut after the record: the routing moves, the record does not.
        RevertingRollupForCutover mock = new RevertingRollupForCutover();
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = VPFIDiscountAccumulatorFacet.rollupUserDiscountLocal.selector;
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(mock),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: sel
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        (, , bytes32 stampedAfterCut, bytes32 afterReplace) = _custody().rewardCustodyCutoverStatus();
        assertEq(stampedAfterCut, stamped, "a cut does not touch the record");
        assertTrue(afterReplace != stamped, "the routing moved");
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCustodyActivationRequiresCutover.selector, requiredV, requiredV, stamped, afterReplace
            )
        );
        _custody().activateRewardCustody(epoch, false);
        _mut().setRecycleBucketRaw(1e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCustodyActivationRequiresCutover.selector, requiredV, requiredV, stamped, afterReplace
            )
        );
        _custody().relocateRewardCustodyRow(LibVaipakam.RewardCustodyRow.Recycled, 1e18);

        // Re-recorded; then a REMOVE of one selector from a facet that keeps
        // its others (the facet-address set is unchanged) refuses too.
        _custody().stampRewardCustodyCutover();
        sel[0] = TestMutatorFacet.getRewardRoleChangesFrozenRaw.selector;
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(0),
            action: IDiamondCut.FacetCutAction.Remove,
            functionSelectors: sel
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        (, , bytes32 stampedBeforeRemove, bytes32 afterRemove) = _custody().rewardCustodyCutoverStatus();
        assertEq(stampedBeforeRemove, afterReplace, "the record is the re-taken one");
        assertTrue(afterRemove != afterReplace, "one removed selector moves the routing");
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCustodyActivationRequiresCutover.selector, requiredV, requiredV, afterReplace, afterRemove
            )
        );
        _custody().activateRewardCustody(epoch, false);

        // Re-recorded; then a stale VERSION refuses on its own.
        _custody().stampRewardCustodyCutover();
        _mut().setRewardCustodyCutoverRaw(0, afterRemove);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCustodyActivationRequiresCutover.selector, 0, requiredV, afterRemove, afterRemove
            )
        );
        _custody().activateRewardCustody(epoch, false);

        _custody().stampRewardCustodyCutover();
        _custody().relocateRewardCustodyRow(LibVaipakam.RewardCustodyRow.Recycled, 1e18);
        _custody().activateRewardCustody(epoch, false);
        assertTrue(_custody().rewardCustodyActivated(), "activated once the record is current");

        _admin().unpause();
        vm.expectRevert(LibPausable.ExpectedManualPause.selector);
        _custody().stampRewardCustodyCutover();
    }

    /// The expiry clock runs on holder custody (Codex #2186 r5 P1): on an
    /// activated chain whose reward funds rest ONLY in the holder — the
    /// Diamond's own balance is zero — the authoritative sweep observes the
    /// claim as executable and stamps the clock on its first observation,
    /// and the entry then expires out of the holder's rows. Before the fix
    /// the sweep tested the Diamond's balance and never started the clock.
    function test_ExpiryClock_RunsOnTheHolderRows_WithAnEmptyDiamondBalance() public {
        _becomeCanonical();
        _cfg().setRewardClaimHorizonDays(180);
        activateRewardCustodyForTest(address(vpfi), 0);
        (uint256 id, uint256 expected) = _seedPayable(alice);
        fundRewardPoolForTest(address(vpfi), expected + 1e18);
        assertEq(vpfi.balanceOf(address(diamond)), 0, "fixture: nothing rests in the Diamond's balance");
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;

        vm.expectEmit(true, true, false, true, address(diamond));
        emit LibInteractionRewards.RewardEntryHorizonStamped(id, alice, uint64(block.timestamp));
        assertEq(_sweeper().sweepExpiredInteractionRewards(ids), 0, "first observation stamps only");

        uint256 swept;
        uint256 guard = 60;
        while (swept == 0 && guard-- > 0) {
            vm.warp(vm.getBlockTimestamp() + 7 days);
            swept = _sweeper().sweepExpiredInteractionRewards(ids);
        }
        assertGt(swept, 0, "the entry expired");
        assertEq(vpfi.balanceOf(address(diamond)), 0, "and the Diamond's balance never moved");
    }

    /// A bucket with tokens still in the Diamond's balance refuses activation
    /// until the ceremony relocates them into the recycled row — bounded by
    /// the figure, never a wei more — and the holder then backs the bucket.
    function test_Activation_RefusesAnUnbackedBucket_UntilRelocated() public {
        _becomeCanonical();
        _seedDiamond(10e18);
        _mut().setRecycleBucketRaw(4e18);
        _admin().pause();
        _custody().bindRewardCustodyHolder();
        uint64 epoch = _epoch();
        _custody().rebaseArmedFreshPaid(0, epoch);

        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCustodyRowUnbacked.selector, uint8(LibVaipakam.RewardCustodyRow.Recycled), 4e18, 0
            )
        );
        _custody().activateRewardCustody(epoch, false);

        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCustodyBootstrapExceedsLedger.selector,
                uint8(LibVaipakam.RewardCustodyRow.Recycled),
                4e18 + 1,
                4e18
            )
        );
        _custody().relocateRewardCustodyRow(LibVaipakam.RewardCustodyRow.Recycled, 4e18 + 1);

        _custody().relocateRewardCustodyRow(LibVaipakam.RewardCustodyRow.Recycled, 4e18);
        assertEq(_recycledRow(), 4e18, "row backs the bucket");
        assertEq(_held(), 4e18, "tokens moved into the holder");
        assertEq(vpfi.balanceOf(address(diamond)), 6e18, "and out of the Diamond");

        _custody().activateRewardCustody(epoch, false);
        assertTrue(_custody().rewardCustodyActivated(), "activated once backed");

        // The bootstrap writers close with the activation.
        vm.expectRevert(RewardCustodyAlreadyActivated.selector);
        _custody().relocateRewardCustodyRow(LibVaipakam.RewardCustodyRow.Recycled, 1);
    }

    /// A bootstrap credit is refused on a role that cannot activate in this
    /// slice — Unconfigured, and Detached — since the allocation it would
    /// create is reachable by nothing there (Codex #2186 r2 P1).
    function test_Bootstrap_RefusesAnInactiveRole() public {
        _seedDiamond(10e18);
        _mut().setRecycleBucketRaw(4e18);
        _admin().pause();
        _custody().bindRewardCustodyHolder();
        vm.expectRevert(
            abi.encodeWithSelector(RewardCustodyBootstrapRequiresActiveRole.selector, uint8(LibVaipakam.RewardRole.Unconfigured))
        );
        _custody().relocateRewardCustodyRow(LibVaipakam.RewardCustodyRow.Recycled, 4e18);
        vpfi.mint(address(this), 1e18);
        vpfi.approve(address(diamond), 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(RewardCustodyBootstrapRequiresActiveRole.selector, uint8(LibVaipakam.RewardRole.Unconfigured))
        );
        _custody().fundRewardCustodyRow(LibVaipakam.RewardCustodyRow.Recycled, 1e18);
        assertEq(_held(), 0, "nothing moved into the holder");
        assertFalse(_custody().rewardRoleChangesFrozen(), "and nothing armed the freeze");

        _mut().setRewardRoleRaw(0, false, true); // Detached
        vm.expectRevert(
            abi.encodeWithSelector(RewardCustodyBootstrapRequiresActiveRole.selector, uint8(LibVaipakam.RewardRole.Detached))
        );
        _custody().relocateRewardCustodyRow(LibVaipakam.RewardCustodyRow.Recycled, 4e18);
    }

    /// The recovery and overage positions are backed the same way, and the
    /// overage row then has a disposition: release to the treasury, retiring
    /// the recorded position by the same amount, never beyond it.
    function test_Bootstrap_RecoveryAndOverage_ThenOverageReleasesToTreasury() public {
        _becomeCanonical();
        _seedDiamond(10e18);
        _mut().setRecoveryPositionWithOverageRaw(5e18, 2e18, 1e18); // position 3, overage 1
        _admin().pause();
        _custody().bindRewardCustodyHolder();
        uint64 epoch = _epoch();
        _custody().rebaseArmedFreshPaid(0, epoch);
        _custody().relocateRewardCustodyRow(LibVaipakam.RewardCustodyRow.Recovery, 3e18);
        // Replacement funding from the caller serves the same rows.
        vpfi.mint(address(this), 1e18);
        vpfi.approve(address(diamond), 1e18);
        _custody().fundRewardCustodyRow(LibVaipakam.RewardCustodyRow.Overage, 1e18);
        _custody().activateRewardCustody(epoch, false);

        vm.expectRevert(abi.encodeWithSelector(RewardCustodyOverageExceedsRecorded.selector, 1e18 + 1, 1e18));
        _custody().releaseRewardCustodyOverage(1e18 + 1);
        _custody().releaseRewardCustodyOverage(1e18);
        assertEq(vpfi.balanceOf(treasury), 1e18, "treasury received the overage");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Overage), 0, "row debited");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Recovery), 3e18, "recovery untouched");
    }

    /// A mirror's imported `received − paid` is history, not money: the
    /// live-fresh row can be FUNDED up to the gap (custody-only, no ledger
    /// change) and never RELOCATED from the Diamond; activation refuses
    /// while the row backs less than the gap.
    function test_Bootstrap_LiveFreshIsFundedNeverRelocated_AndActivationNeedsTheGap() public {
        _becomeMirror();
        _seedDiamond(10e18);
        _mut().setArmedFreshLedgerRaw(10e18, 4e18); // gap 6
        _admin().pause();
        _custody().bindRewardCustodyHolder();
        uint64 epoch = _epoch();
        _custody().rebaseArmedFreshPaid(4e18, epoch); // mirror: paid stays 4, received untouched

        vm.expectRevert(
            abi.encodeWithSelector(RewardCustodyBootstrapRowNotAllowed.selector, uint8(LibVaipakam.RewardCustodyRow.LiveFresh))
        );
        _custody().relocateRewardCustodyRow(LibVaipakam.RewardCustodyRow.LiveFresh, 6e18);

        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCustodyRowUnbacked.selector, uint8(LibVaipakam.RewardCustodyRow.LiveFresh), 6e18, 0
            )
        );
        _custody().activateRewardCustody(epoch, false);

        vpfi.mint(address(this), 7e18);
        vpfi.approve(address(diamond), 7e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCustodyBootstrapExceedsLedger.selector, uint8(LibVaipakam.RewardCustodyRow.LiveFresh), 7e18, 6e18
            )
        );
        _custody().fundRewardCustodyRow(LibVaipakam.RewardCustodyRow.LiveFresh, 7e18);
        _custody().fundRewardCustodyRow(LibVaipakam.RewardCustodyRow.LiveFresh, 6e18);
        (uint256 received, uint256 paid) = _ledger();
        assertEq(received, 10e18, "custody-only: the ledger is untouched");
        assertEq(paid, 4e18, "custody-only: the ledger is untouched");
        _custody().activateRewardCustody(epoch, false);
        assertEq(_live(), 6e18, "the live row equals the gap");
        (, uint256 remaining) = _rlens().getDeliveredFreshBound();
        assertEq(remaining, 6e18, "and the bound is the gap");
    }

    /// The other executable form: write the imported gap DOWN to what the
    /// holder backs. History stays in the event; headroom becomes what the
    /// holder can actually pay.
    function test_Activation_WritesDownAMirrorGapOnRequest() public {
        _becomeMirror();
        _mut().setArmedFreshLedgerRaw(10e18, 4e18); // gap 6
        _admin().pause();
        _custody().bindRewardCustodyHolder();
        uint64 epoch = _epoch();
        _custody().rebaseArmedFreshPaid(4e18, epoch);
        vpfi.mint(address(this), 2e18);
        vpfi.approve(address(diamond), 2e18);
        _custody().fundRewardCustodyRow(LibVaipakam.RewardCustodyRow.LiveFresh, 2e18);
        _custody().activateRewardCustody(epoch, true);
        (uint256 received, uint256 paid) = _ledger();
        assertEq(paid, 4e18, "paid retained");
        assertEq(received, 6e18, "received written down to paid + what the holder backs");
        assertEq(_live(), 2e18, "the row IS the headroom");
    }

    /// Every bootstrap write waits for the paid-side rebase (Codex #2186 r3
    /// P1): the rebase only raises `paid`, so a live row credited to the
    /// pre-rebase `received − paid` would be left above the figure the
    /// rebase leaves — which activation refuses and nothing before it can
    /// debit. Straddled: refused before the rebase, the same writes
    /// accepted after it.
    function test_Bootstrap_RequiresThePaidRebase() public {
        _becomeMirror();
        _seedDiamond(10e18);
        _mut().setArmedFreshLedgerRaw(10e18, 4e18); // gap 6
        _mut().setRecycleBucketRaw(4e18);
        _admin().pause();
        _custody().bindRewardCustodyHolder();
        vpfi.mint(address(this), 6e18);
        vpfi.approve(address(diamond), 6e18);

        vm.expectRevert(RewardCustodyBootstrapRequiresRebase.selector);
        _custody().fundRewardCustodyRow(LibVaipakam.RewardCustodyRow.LiveFresh, 6e18);
        vm.expectRevert(RewardCustodyBootstrapRequiresRebase.selector);
        _custody().relocateRewardCustodyRow(LibVaipakam.RewardCustodyRow.Recycled, 4e18);
        vm.expectRevert(RewardCustodyBootstrapRequiresRebase.selector);
        _custody().releaseRewardCustodyRow(LibVaipakam.RewardCustodyRow.Recycled, 1);
        assertEq(_held(), 0, "nothing moved into the holder");
        assertFalse(_custody().rewardRoleChangesFrozen(), "and nothing armed the freeze");

        _custody().rebaseArmedFreshPaid(4e18, _epoch());
        _custody().fundRewardCustodyRow(LibVaipakam.RewardCustodyRow.LiveFresh, 6e18);
        _custody().relocateRewardCustodyRow(LibVaipakam.RewardCustodyRow.Recycled, 4e18);
        assertEq(_live(), 6e18, "the live row backs the post-rebase gap");
        assertEq(_recycledRow(), 4e18, "the recycled row backs the bucket");
    }

    /// A figure that moves after its row was backed leaves the row ABOVE it:
    /// activation refuses, no reward path debits a row before activation,
    /// and the excess would sit at the holder until another facet upgrade.
    /// The bootstrap release is that exit — bounded by the excess, to the
    /// Diamond's own balance only, no ledger counter touched — and it closes
    /// with the activation like the two credits (Codex #2186 r3 P1).
    function test_Bootstrap_ReleasesAnOverBackedRow_ToTheDiamond() public {
        _becomeMirror();
        _seedDiamond(10e18);
        _mut().setArmedFreshLedgerRaw(10e18, 4e18); // gap 6
        _mut().setRecycleBucketRaw(4e18);
        _admin().pause();
        _custody().bindRewardCustodyHolder();
        uint64 epoch = _epoch();
        _custody().rebaseArmedFreshPaid(4e18, epoch);
        vpfi.mint(address(this), 6e18);
        vpfi.approve(address(diamond), 6e18);
        _custody().fundRewardCustodyRow(LibVaipakam.RewardCustodyRow.LiveFresh, 6e18);
        _custody().relocateRewardCustodyRow(LibVaipakam.RewardCustodyRow.Recycled, 4e18);
        assertEq(_held(), 10e18, "both rows backed");
        assertEq(vpfi.balanceOf(address(diamond)), 6e18, "the Diamond kept what was not relocated");

        // The CLASS, not one mover: the paid side rises (a payout a lifted
        // pause let through, or the rebase itself) and the bucket falls.
        _mut().setArmedFreshLedgerRaw(10e18, 7e18); // gap 3, row 6 — excess 3
        _mut().setRecycleBucketRaw(3e18); // bucket 3, row 4 — excess 1

        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCustodyRowUnbacked.selector, uint8(LibVaipakam.RewardCustodyRow.Recycled), 3e18, 4e18
            )
        );
        _custody().activateRewardCustody(epoch, false);

        // Only the excess can leave: never a wei of what the figure covers,
        // and nothing at all from a row that is not over-backed.
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCustodyBootstrapReleaseExceedsExcess.selector,
                uint8(LibVaipakam.RewardCustodyRow.LiveFresh),
                3e18 + 1,
                3e18
            )
        );
        _custody().releaseRewardCustodyRow(LibVaipakam.RewardCustodyRow.LiveFresh, 3e18 + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCustodyBootstrapReleaseExceedsExcess.selector, uint8(LibVaipakam.RewardCustodyRow.Recovery), 1, 0
            )
        );
        _custody().releaseRewardCustodyRow(LibVaipakam.RewardCustodyRow.Recovery, 1);

        vm.expectEmit(true, false, false, true, address(diamond));
        emit RewardCustodyFacet.RewardCustodyRowBootstrapReleased(
            uint8(LibVaipakam.RewardCustodyRow.LiveFresh), 3e18, 3e18
        );
        _custody().releaseRewardCustodyRow(LibVaipakam.RewardCustodyRow.LiveFresh, 3e18);
        _custody().releaseRewardCustodyRow(LibVaipakam.RewardCustodyRow.Recycled, 1e18);
        assertEq(_live(), 3e18, "the live row equals the moved gap");
        assertEq(_recycledRow(), 3e18, "the recycled row equals the moved bucket");
        assertEq(_held(), 6e18, "the holder gave back exactly the excess");
        assertEq(vpfi.balanceOf(address(diamond)), 10e18, "and the Diamond received it, no other destination");
        (uint256 received, uint256 paid) = _ledger();
        assertEq(received, 10e18, "custody-only: the ledger is untouched");
        assertEq(paid, 7e18, "custody-only: the ledger is untouched");

        _custody().activateRewardCustody(epoch, false);
        assertTrue(_custody().rewardCustodyActivated(), "activated once every row equals its figure");
        vm.expectRevert(RewardCustodyAlreadyActivated.selector);
        _custody().releaseRewardCustodyRow(LibVaipakam.RewardCustodyRow.LiveFresh, 1);
    }

    // ─── 2. the canonical column ─────────────────────────────────────────────

    /// THE cutover: a canonical claim is refused with nothing funded, and pays
    /// out of the HOLDER once `fundRewardPool` lands — the Diamond's own
    /// balance never moves, the live-fresh row is debited by exactly the
    /// fresh paid, and the paid ledger is charged by the same amount.
    function test_CanonicalClaim_RefusedUnfunded_ThenPaysFromTheHolder() public {
        _becomeCanonical();
        _seedDiamond(50e18); // unrelated Diamond balance — must stay untouched
        activateRewardCustodyForTest(address(vpfi), 0);
        (, uint256 expected) = _seedPayable(alice);
        assertGt(expected, 0, "fixture pays something");
        (, uint256 remaining0) = _rlens().getDeliveredFreshBound();
        assertEq(remaining0, 0, "canonical bounds at received - paid, zero unfunded");

        vm.prank(alice);
        vm.expectPartialRevert(InteractionRewardBackingShort.selector);
        _claim().claimInteractionRewards();
        assertEq(vpfi.balanceOf(alice), 0, "nothing paid");

        fundRewardPoolForTest(address(vpfi), expected + 1e18);
        assertEq(_held(), expected + 1e18, "funding landed in the holder");
        assertEq(_live(), expected + 1e18, "attributed as live fresh");
        assertEq(vpfi.balanceOf(address(diamond)), 50e18, "the Diamond's balance is not where funding goes");

        uint256 holderBefore = _held();
        vm.prank(alice);
        (uint256 claimed, , ) = _claim().claimInteractionRewards();
        assertApproxEqAbs(claimed, expected, 1e6, "paid in full");
        assertEq(vpfi.balanceOf(alice), claimed, "the claimant holds it");
        assertEq(vpfi.balanceOf(address(diamond)), 50e18, "the Diamond's balance never moved");
        // The fresh component moved out of the holder (the treasury share of
        // this fixture's forfeit absorbs in-holder, so the holder's balance
        // falls by exactly what the claimant received).
        assertEq(holderBefore - _held(), claimed, "the holder paid it");
        (uint256 received, uint256 paid) = _ledger();
        assertEq(_live(), received - paid, "the live row is the bound");
        assertGt(paid, 0, "the canonical column is charged now");
        (, uint256 remaining) = _rlens().getDeliveredFreshBound();
        assertEq(remaining, _live(), "bound and row agree");
    }

    /// The Unconfigured column is frozen at today's behaviour: the same claim
    /// pays from the Diamond's balance, charges nothing, and the deployment
    /// cannot even be activated.
    function test_UnconfiguredClaim_StillPaysFromTheDiamond() public {
        _seedDiamond(100_000e18);
        (, uint256 expected) = _seedPayable(alice);
        uint256 diamondBefore = vpfi.balanceOf(address(diamond));
        vm.prank(alice);
        (uint256 claimed, , ) = _claim().claimInteractionRewards();
        assertApproxEqAbs(claimed, expected, 1e6, "pays as before");
        assertLt(vpfi.balanceOf(address(diamond)), diamondBefore, "from the Diamond's balance");
        (uint256 paid, uint256 remaining) = _rlens().getDeliveredFreshBound();
        assertEq(paid, 0, "uncharged");
        assertEq(remaining, type(uint256).max, "unbounded");
        assertFalse(_custody().rewardRoleChangesFrozen(), "no allocation, no freeze");
    }

    /// `fundRewardPool` requires the activation and an ACTIVE role, and is
    /// bounded by the pool's lifetime cap.
    function test_FundRewardPool_RequiresActivationAndAnActiveRole() public {
        _becomeCanonical();
        vpfi.mint(address(this), 1e18);
        vpfi.approve(address(diamond), 1e18);
        vm.expectRevert(RewardCustodyNotActivated.selector);
        _custody().fundRewardPool(1e18);

        activateRewardCustodyForTest(address(vpfi), 0);
        vm.expectRevert(InvalidAmount.selector);
        _custody().fundRewardPool(0);
        vm.expectRevert(
            abi.encodeWithSelector(RewardCustodyFundingExceedsCap.selector, CAP + 1, CAP)
        );
        _custody().fundRewardPool(CAP + 1);
        _custody().fundRewardPool(1e18);
        assertEq(_live(), 1e18, "funded");

        // A detached chain (raw: configured, no base, not canonical) refuses.
        _mut().setRewardRoleRaw(0, false, true);
        assertEq(uint8(_rep().getRewardRole()), uint8(LibVaipakam.RewardRole.Detached), "detached");
        vpfi.mint(address(this), 1e18);
        vpfi.approve(address(diamond), 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCustodyFundingRequiresActiveRole.selector, uint8(LibVaipakam.RewardRole.Detached)
            )
        );
        _custody().fundRewardPool(1e18);
    }

    /// The §5c deficit split, straddled at the deficit: with `paid > received`
    /// the deficit-covering part of a funding lands in RESTITUTION and only
    /// the excess becomes live headroom; a second funding with the deficit
    /// closed is live in full.
    function test_FundRewardPool_SplitsAtTheDeficit() public {
        _becomeMirror();
        _admin().pause();
        _custody().bindRewardCustodyHolder();
        uint64 epoch = _epoch();
        _custody().rebaseArmedFreshPaid(6e18, epoch); // paid 6, received 0: a 6 deficit
        _custody().activateRewardCustody(epoch, false);
        _admin().unpause();

        fundRewardPoolForTest(address(vpfi), 10e18);
        assertEq(_row(LibVaipakam.RewardCustodyRow.Restitution), 6e18, "the deficit's cover is restitution");
        assertEq(_live(), 4e18, "only the excess is live");
        (uint256 received, uint256 paid) = _ledger();
        assertEq(received, 10e18, "received credited in full");
        assertEq(paid, 6e18, "paid untouched");
        (, uint256 remaining) = _rlens().getDeliveredFreshBound();
        assertEq(remaining, 4e18, "headroom is the live row");

        fundRewardPoolForTest(address(vpfi), 3e18);
        assertEq(_live(), 7e18, "no deficit left: live in full");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Restitution), 6e18, "restitution untouched");
        assertEq(_held(), 13e18, "the holder holds both");
    }

    // ─── 3. in-holder absorption and the recycled row ────────────────────────

    /// A reward absorption on an activated deployment is an IN-HOLDER
    /// transfer: live-fresh → recycled, no tokens move, the paid ledger is
    /// charged, and the bucket equals the recycled row.
    function test_Absorption_MovesLiveFreshToRecycled_InHolder() public {
        _becomeCanonical();
        activateRewardCustodyForTest(address(vpfi), 5e18);
        uint256 heldBefore = _held();
        _mut().creditRecycleRaw(LibVpfiRecycle.RecycleSource.ForfeitedReward, 0, 2e18);
        assertEq(_held(), heldBefore, "no tokens moved");
        assertEq(_live(), 3e18, "live debited");
        assertEq(_recycledRow(), 2e18, "recycled credited");
        assertEq(_cfg().getRecycleBucket(), 2e18, "the bucket is the recycled row");
        (, uint256 paid) = _ledger();
        assertEq(paid, 2e18, "charged");

        // Beyond the live row it is refused — and the refusal names the bound.
        vm.expectRevert(abi.encodeWithSelector(DeliveredFreshBoundExceeded.selector, 4e18, 3e18));
        _mut().creditRecycleRaw(LibVpfiRecycle.RecycleSource.ForfeitedReward, 0, 4e18);
    }

    /// A non-reward inflow (a fee the user paid into the Diamond) is RELOCATED
    /// into the recycled row on an activated deployment, measured.
    function test_FeeInflow_IsRelocatedIntoTheRecycledRow() public {
        _becomeCanonical();
        activateRewardCustodyForTest(address(vpfi), 0);
        uint256 before = vpfi.balanceOf(address(diamond));
        _seedDiamond(3e18); // the user's fee, already pulled into the Diamond
        _mut().creditInflowRawWithBefore(LibVpfiRecycle.RecycleSource.NotificationFee, 1, 3e18, before);
        assertEq(_recycledRow(), 3e18, "recycled row credited");
        assertEq(_held(), 3e18, "tokens relocated into the holder");
        assertEq(vpfi.balanceOf(address(diamond)), before, "and out of the Diamond");
        assertEq(_cfg().getRecycleBucket(), 3e18, "bucket equals the row");
    }

    /// A repatriation surplus leaves the holder's recycled row, measured.
    function test_RepatriationSurplus_ReleasesFromTheRecycledRow() public {
        _becomeCanonical();
        activateRewardCustodyForTest(address(vpfi), 5e18);
        _mut().creditRecycleRaw(LibVpfiRecycle.RecycleSource.ForfeitedReward, 0, 4e18);
        uint256 diamondBefore = vpfi.balanceOf(address(diamond));
        _mut().debitRepatriationSurplusRaw(3e18); // destination: the Diamond itself
        assertEq(_recycledRow(), 1e18, "row debited");
        assertEq(_cfg().getRecycleBucket(), 1e18, "bucket debited");
        assertEq(vpfi.balanceOf(address(diamond)) - diamondBefore, 3e18, "released from the holder");
        vm.expectRevert(
            abi.encodeWithSelector(LibVpfiRecycle.RepatriationExceedsFundable.selector, 2e18, 1e18)
        );
        _mut().debitRepatriationSurplusRaw(2e18);
    }

    // ─── 4. the payout's two rows and the vault leg ──────────────────────────

    /// The vault leg runs the row debits, the holder release, the record and
    /// the rollup in ONE frame: a failure after the token movement rolls the
    /// release back, the wallet is paid once from the holder, and the vault
    /// and the rows show no residue of the failed leg.
    function test_VaultDelivery_FailureAfterTheHolderRelease_PaysTheWalletOnce() public {
        _becomeCanonical();
        address vault = _vault().getOrCreateUserVault(alice);
        activateRewardCustodyForTest(address(vpfi), 0);
        (, uint256 expected) = _seedPayable(alice);
        fundRewardPoolForTest(address(vpfi), expected + 1e18);

        RevertingRollupForCutover mock = new RevertingRollupForCutover();
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = VPFIDiscountAccumulatorFacet.rollupUserDiscountLocal.selector;
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(mock),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: sel
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        uint256 holderBefore = _held();
        uint256 liveBefore = _live();
        vm.prank(alice);
        (uint256 paid, , ) = _claim().claimInteractionRewards();
        assertGt(paid, 0, "paid");
        assertEq(vpfi.balanceOf(alice), paid, "wallet paid exactly once");
        assertEq(vpfi.balanceOf(vault), 0, "vault release rolled back");
        assertEq(holderBefore - _held(), paid, "the holder was debited exactly once");
        assertEq(liveBefore - _live(), paid, "the live row was debited exactly once");
    }

    /// The vault route itself pays from the holder into the vault, and the
    /// holder-sourced primitive is Diamond-internal only.
    function test_VaultDelivery_PaysFromTheHolderIntoTheVault() public {
        _becomeCanonical();
        address vault = _vault().getOrCreateUserVault(alice);
        activateRewardCustodyForTest(address(vpfi), 0);
        (, uint256 expected) = _seedPayable(alice);
        fundRewardPoolForTest(address(vpfi), expected + 1e18);
        uint256 holderBefore = _held();
        vm.prank(alice);
        (uint256 paid, , ) = _claim().claimInteractionRewards();
        assertEq(vpfi.balanceOf(vault), paid, "vault credited from the holder");
        assertEq(vpfi.balanceOf(alice), 0, "no wallet transfer");
        assertEq(holderBefore - _held(), paid, "holder debited by the payout");

        vm.expectRevert(VaultFactoryFacet.OnlyDiamondInternal.selector);
        vm.prank(alice);
        _vault().vaultCreditFromRewardCustodyERC20(alice, address(vpfi), 1, 0);
    }

    // ─── 5. the mirror's ingress ─────────────────────────────────────────────

    /// A mirror's delivery relocates its counted fresh share into the live
    /// row and its recycled share into the recycled row; the claim then pays
    /// from the holder.
    function test_MirrorIngress_RelocatesTheSharesAndTheClaimPaysFromTheHolder() public {
        _becomeMirror();
        activateRewardCustodyForTest(address(vpfi), 0);
        (, uint256 expected) = _seedPayable(alice);
        _seedDiamond(expected + 10e18); // the receiver forwarded the delivery here
        _deliverFresh(expected + 1e18, 2e18, 7);
        assertEq(_live(), expected + 1e18, "fresh share relocated as live");
        assertEq(_recycledRow(), 2e18, "recycled share relocated");
        assertEq(_held(), expected + 3e18, "both in the holder");
        assertEq(vpfi.balanceOf(address(diamond)), 7e18, "out of the Diamond");

        uint256 holderBefore = _held();
        vm.prank(alice);
        (uint256 claimed, , ) = _claim().claimInteractionRewards();
        assertApproxEqAbs(claimed, expected, 1e6, "paid");
        assertEq(holderBefore - _held(), claimed, "from the holder");
    }

    // ─── 6. the transports ───────────────────────────────────────────────────

    /// A canonical remittance names LIVE custody: refused beyond the delivered
    /// headroom before anything is approved or moved; within it the tokens
    /// leave the holder (through the Diamond to the messenger, in one
    /// transaction), the live row is debited by the fresh share and the paid
    /// ledger charged by it.
    function test_Remittance_DrawsLiveCustodyAndChargesTheBound() public {
        MockRewardMessenger rewardMessenger = new MockRewardMessenger(address(diamond));
        MockCrossChainMessenger ccip = new MockCrossChainMessenger();
        _becomeCanonical();
        _rep().setRewardMessenger(address(rewardMessenger));
        TreasuryFacet(address(diamond)).setCrossChainMessenger(address(ccip));
        uint32[] memory chainIds = new uint32[](3);
        chainIds[0] = CHAIN_BASE;
        chainIds[1] = CHAIN_ARB;
        chainIds[2] = CHAIN_OP;
        RewardAggregatorFacet(address(diamond)).setExpectedSourceChainIds(chainIds);
        vm.deal(address(this), 10 ether);
        rewardMessenger.deliverChainReport(CHAIN_BASE, 1, 10e18, 5e18);
        rewardMessenger.deliverChainReport(CHAIN_ARB, 1, 20e18, 10e18);
        rewardMessenger.deliverChainReport(CHAIN_OP, 1, 30e18, 15e18);
        RewardAggregatorFacet(address(diamond)).finalizeDay(1);
        uint256[] memory day1 = new uint256[](1);
        day1[0] = 1;
        (uint256 expected, ) = _remit().quoteRewardBudget(CHAIN_ARB, day1);
        assertGt(expected, 0, "slice");

        activateRewardCustodyForTest(address(vpfi), expected - 1);
        uint256 diamondBefore = vpfi.balanceOf(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(DeliveredFreshBoundExceeded.selector, expected, expected - 1));
        _remit().remitRewardBudget{value: 1 ether}(CHAIN_ARB, day1, CAP);
        assertEq(ccip.sentCount(), 0, "nothing sent");
        assertEq(_held(), expected - 1, "nothing left the holder");

        fundRewardPoolForTest(address(vpfi), 1);
        _remit().remitRewardBudget{value: 1 ether}(CHAIN_ARB, day1, CAP);
        assertEq(ccip.sentCount(), 1, "sent");
        assertEq(ccip.sentTokens(0)[0].amount, expected, "the slice");
        assertEq(_held(), 0, "the holder paid the slice");
        assertEq(_live(), 0, "live row debited by the fresh share (all of it here)");
        assertEq(vpfi.balanceOf(address(diamond)), diamondBefore, "the Diamond's own balance is untouched");
        (uint256 received, uint256 paid) = _ledger();
        assertEq(paid, expected, "charged");
        assertEq(received, expected, "funded");
    }

    // ─── 7. the freeze ───────────────────────────────────────────────────────

    /// Effective role changes are refused while frozen, in every direction the
    /// setters can take, and a direct source rebinding is refused always.
    function test_RoleSetters_RefuseEffectiveChangesWhileFrozen_AndDirectRebinds() public {
        _becomeCanonical();
        // Before any allocation the setters still work (a fresh deploy is
        // configured this way).
        assertFalse(_custody().rewardRoleChangesFrozen(), "not frozen yet");
        activateRewardCustodyForTest(address(vpfi), 0);
        assertTrue(_custody().rewardRoleChangesFrozen(), "frozen");

        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRoleChangeFrozen.selector,
                uint8(LibVaipakam.RewardRole.Canonical),
                uint8(LibVaipakam.RewardRole.Mirror)
            )
        );
        _rep().setIsCanonicalRewardChain(false);
        // A write that resolves the SAME role is not a change.
        _rep().setIsCanonicalRewardChain(true);
        _rep().setBaseChainId(CHAIN_BASE);

        // A canonical chain's base chain id is not a funding source, so its
        // rewrite is neither a rebinding nor (while still canonical) a role
        // change. The mirror rule is pinned below.
        _rep().setBaseChainId(CHAIN_OP);
        _rep().setBaseChainId(CHAIN_BASE);

        // Detaching a canonical chain (base to zero first) is an effective
        // change only at the second write — the first keeps it Canonical.
        _rep().setBaseChainId(0);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRoleChangeFrozen.selector,
                uint8(LibVaipakam.RewardRole.Canonical),
                uint8(LibVaipakam.RewardRole.Detached)
            )
        );
        _rep().setIsCanonicalRewardChain(false);
    }

    /// A mirror's authenticated source — base chain and funding identity —
    /// is never rebound directly to a different retained one; disarming
    /// (zero) stays possible, and so does the pass through Detached.
    function test_BaseRewardDeployment_RefusesADirectRebindOnAMirror() public {
        _becomeMirror();
        vm.expectRevert(
            abi.encodeWithSelector(RewardBaseChainRebindRequiresDetach.selector, CHAIN_BASE, CHAIN_OP)
        );
        _rep().setBaseChainId(CHAIN_OP);
        _rep().setBaseChainId(0); // detach (no allocation yet: not frozen)
        _rep().setBaseChainId(CHAIN_OP); // re-attach to the new source
        _rep().setBaseChainId(0);
        _rep().setBaseChainId(CHAIN_BASE);
        address eraA = makeAddr("eraA");
        address eraB = makeAddr("eraB");
        _rep().setBaseRewardDeployment(eraA);
        _rep().setBaseRewardDeployment(address(0)); // disarm: allowed
        vm.expectRevert(
            abi.encodeWithSelector(RewardBaseDeploymentRebindRequiresDetach.selector, eraA, eraB)
        );
        _rep().setBaseRewardDeployment(eraB);
        _rep().setBaseRewardDeployment(eraA); // re-arming the same era: allowed
    }

    // ─── 8. restitution: the unwind and the two dispositions ─────────────────

    /// A demotion gives back the WHOLE credit still in the holder — the live
    /// portion first, then the restitution portion — to the Diamond, where
    /// the stranded reservation describes it (Codex #2186 r1 P1); only what
    /// was already paid out stays out.
    function test_UncreditFresh_ReturnsLiveThenRestitution() public {
        _becomeMirror();
        _admin().pause();
        _custody().bindRewardCustodyHolder();
        uint64 epoch = _epoch();
        _custody().rebaseArmedFreshPaid(6e18, epoch); // deficit 6
        _custody().activateRewardCustody(epoch, false);
        _admin().unpause();
        fundRewardPoolForTest(address(vpfi), 10e18); // restitution 6, live 4
        uint256 diamondBefore = vpfi.balanceOf(address(diamond));

        vm.prank(address(diamond)); // the Diamond-internal entry, as the demotion reaches it
        _custody().custodyUncreditFresh(9e18);
        assertEq(_live(), 0, "live gave back all 4");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Restitution), 1e18, "restitution gave back 5 of 6");
        assertEq(vpfi.balanceOf(address(diamond)) - diamondBefore, 9e18, "the Diamond received the whole unwound credit");
        (uint256 received, ) = _ledger();
        assertEq(received, 1e18, "received unwound");
    }

    /// The corrective disposition: `amount` of paid never happened, so the
    /// paid side falls and only the headroom that reappears moves from
    /// restitution to live — straddled: with the deficit still open the
    /// first correction creates no headroom, the second does.
    function test_Restitution_PaidCorrection_MovesOnlyTheHeadroomCreated() public {
        _becomeMirror();
        _admin().pause();
        _custody().bindRewardCustodyHolder();
        uint64 epoch = _epoch();
        _custody().rebaseArmedFreshPaid(6e18, epoch); // deficit 6
        _custody().activateRewardCustody(epoch, false);
        _admin().unpause();
        fundRewardPoolForTest(address(vpfi), 4e18); // all restitution; received 4, paid 6
        assertEq(_row(LibVaipakam.RewardCustodyRow.Restitution), 4e18, "covering tokens");
        assertEq(_live(), 0, "no headroom");

        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(RewardCustodyRestitutionCorrectionExceedsPaid.selector, 7e18, 6e18));
        _custody().releaseRestitutionAsPaidCorrection(7e18, bytes32("d0"));
        _custody().releaseRestitutionAsPaidCorrection(1e18, bytes32("d1")); // deficit 2 -> 1: no headroom yet
        assertEq(_live(), 0, "still no headroom");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Restitution), 4e18, "restitution untouched");
        _custody().releaseRestitutionAsPaidCorrection(3e18, bytes32("d2")); // paid 2: headroom 2
        (uint256 received, uint256 paid) = _ledger();
        assertEq(paid, 2e18, "paid corrected");
        assertEq(_live(), 2e18, "exactly the headroom created moved to live");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Restitution), 2e18, "the rest still covers paid");
        assertEq(_live(), received - paid, "the live row is the bound");
    }

    /// The genuine-deficit disposition: restitution routes to the treasury
    /// with paid retained and no headroom created.
    function test_Restitution_ReleaseToTreasury_RetainsPaid() public {
        _becomeMirror();
        _admin().pause();
        _custody().bindRewardCustodyHolder();
        uint64 epoch = _epoch();
        _custody().rebaseArmedFreshPaid(6e18, epoch);
        _custody().activateRewardCustody(epoch, false);
        _admin().unpause();
        fundRewardPoolForTest(address(vpfi), 4e18);
        _admin().pause();
        _custody().releaseRestitutionToTreasury(3e18, bytes32("genuine"));
        assertEq(vpfi.balanceOf(treasury), 3e18, "treasury received it");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Restitution), 1e18, "row debited");
        (uint256 received, uint256 paid) = _ledger();
        assertEq(paid, 6e18, "paid retained");
        assertEq(received, 4e18, "received untouched");
        assertEq(_live(), 0, "no headroom created");
        vm.expectRevert(
            abi.encodeWithSelector(RewardCustodyRowShort.selector, uint8(LibVaipakam.RewardCustodyRow.Restitution), 2e18, 1e18)
        );
        _custody().releaseRestitutionToTreasury(2e18, bytes32("over"));
    }

    // ─── 9. the token rotation guard ─────────────────────────────────────────

    /// The VPFI token cannot be rotated while any row is funded or the holder
    /// still holds the old token; once both are drained it can.
    function test_SetVPFIToken_RefusesRotationWhileCustodyExists() public {
        _becomeCanonical();
        activateRewardCustodyForTest(address(vpfi), 5e18);
        address newToken = address(new VPFIToken());
        vm.expectRevert(abi.encodeWithSelector(RewardCustodyTokenRotationBlocked.selector, 5e18, 5e18));
        VPFITokenFacet(address(diamond)).setVPFIToken(newToken);

        // Drain the rows: an in-holder absorption then a surplus release
        // leaves attribution zero but tokens at the holder — still refused.
        _mut().creditRecycleRaw(LibVpfiRecycle.RecycleSource.ForfeitedReward, 0, 5e18);
        _mut().debitRepatriationSurplusRaw(5e18);
        assertEq(_held(), 0, "holder drained through the surplus release");
        (, , , , uint256 attributed) = _custody().rewardCustodySnapshot();
        assertEq(attributed, 0, "rows drained");
        vpfi.mint(_holder(), 1); // an unsolicited wei at the holder
        vm.expectRevert(abi.encodeWithSelector(RewardCustodyTokenRotationBlocked.selector, 0, 1));
        VPFITokenFacet(address(diamond)).setVPFIToken(newToken);
        _admin().pause();
        _custody().sweepUnattributedVpfiFromRewardCustody(1);
        _admin().unpause();
        VPFITokenFacet(address(diamond)).setVPFIToken(newToken); // drained: allowed
        assertEq(VPFITokenFacet(address(diamond)).getVPFIToken(), newToken, "rotated");
    }

    // ─── 10. the versioned backing snapshot ──────────────────────────────────

    /// V2 carries the legacy eight fields unchanged plus the activation flag
    /// and the holder's balance and attributed total.
    function test_BackingSnapshotV2_ExposesTheHolderSide() public {
        _becomeCanonical();
        (bool act0, , , ) = _v2Tail();
        assertFalse(act0, "inactive");
        activateRewardCustodyForTest(address(vpfi), 5e18);
        _mut().creditRecycleRaw(LibVpfiRecycle.RecycleSource.ForfeitedReward, 0, 2e18);
        (uint256 vpfiBalance, uint256 bucket, uint256 unearmarked, , , , uint256 reserved, uint256 position, bool act, bool known, uint256 held, uint256 attributed) =
            _custody().getRecycleBackingSnapshotV2();
        (uint256 v1Balance, uint256 v1Bucket, uint256 v1Unearmarked, , , , uint256 v1Reserved, uint256 v1Position) =
            InteractionRewardsLensFacet(address(diamond)).getRecycleBackingSnapshot();
        assertEq(vpfiBalance, v1Balance, "legacy field unchanged");
        assertEq(bucket, v1Bucket, "legacy field unchanged");
        assertEq(unearmarked, v1Unearmarked, "legacy field unchanged");
        assertEq(reserved, v1Reserved, "legacy field unchanged");
        assertEq(position, v1Position, "legacy field unchanged");
        assertEq(bucket, 2e18, "bucket is the recycled row");
        assertTrue(act, "activated");
        assertTrue(known, "holder readable");
        assertEq(held, 5e18, "holder balance");
        assertEq(attributed, 5e18, "attributed");
    }

    function _v2Tail() internal view returns (bool act, bool known, uint256 held, uint256 attributed) {
        (, , , , , , , , act, known, held, attributed) = _custody().getRecycleBackingSnapshotV2();
    }

    // ─── 11. the ledger view ─────────────────────────────────────────────────

    function test_Ledger_ReportsActivationAndEveryRow() public {
        _becomeCanonical();
        (bool activated0, bool frozen0, , , , , , , , ) = _custody().rewardCustodyLedger();
        assertFalse(activated0, "inactive");
        assertFalse(frozen0, "unfrozen");
        activateRewardCustodyForTest(address(vpfi), 5e18);
        _mut().creditRecycleRaw(LibVpfiRecycle.RecycleSource.ForfeitedReward, 0, 2e18);
        (bool activated, bool frozen, uint256 live, uint256 recycled, , , , , , ) = _custody().rewardCustodyLedger();
        assertTrue(activated, "active");
        assertTrue(frozen, "frozen");
        assertEq(live, 3e18, "live");
        assertEq(recycled, 2e18, "recycled");
        (, , bool known, uint256 held, uint256 attributed) = _custody().rewardCustodySnapshot();
        assertTrue(known, "readable");
        assertEq(held, 5e18, "held");
        assertEq(attributed, 5e18, "fully attributed");
    }
}
