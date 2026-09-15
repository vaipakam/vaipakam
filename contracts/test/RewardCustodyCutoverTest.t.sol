// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibRewardCustody} from "../src/libraries/LibRewardCustody.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {RewardReconciliationFacet} from "../src/facets/RewardReconciliationFacet.sol";
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
        _deliverStamped(fresh + recycled, fresh, recycled, remitId, bytes32(0));
    }

    /// @dev A delivery as the receiver presents it, with an explicit transport
    ///      id; `amount − fresh − recycled` is the untyped remainder.
    function _deliverStamped(uint256 amount, uint256 fresh, uint256 recycled, uint256 remitId, bytes32 id)
        internal
    {
        uint256[] memory days_ = new uint256[](1);
        days_[0] = 1;
        _remit().onRewardBudgetReceived(
            address(vpfi), amount, days_, CHAIN_BASE, remitId, REMITTER, recycled, fresh, id
        );
    }

    /// @dev A compensation delivery for day 3 as the receiver presents it;
    ///      `finalizedAt == 0` quarantines (state unknown), a live clock
    ///      credits provisionally.
    function _deliverCompensation(uint256 amount, uint256 remitId, uint64 finalizedAt, bytes32 id) internal {
        _remit().onCompensationBudgetReceived(
            address(vpfi), amount, 3, CHAIN_BASE, remitId, REMITTER, amount / 2, amount / 2, finalizedAt, 1,
            uint64(7 days), uint64(24 hours), id
        );
    }

    function _packetHash(bytes32 id) internal pure returns (bytes32) {
        return keccak256(abi.encode(uint256(CHAIN_BASE), id));
    }

    function _unclassified() internal view returns (uint256) {
        return _row(LibVaipakam.RewardCustodyRow.Unclassified);
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

    // ─── 5b. the UNCLASSIFIED ingress attribution (closure 2 cutover PR 1) ──

    /// An untyped arrival is PROTECTED AT INGRESS: on an activated deployment
    /// the delivery's remainder — what is neither the fresh share nor the
    /// recycled share — leaves the Diamond's balance for the holder's
    /// `Unclassified` row the moment it lands, the figures that describe the
    /// row move with it, and the packet is recorded under its ingress stamp
    /// with the receipt bound to it.
    function test_UntypedRemainder_IsProtectedIntoUnclassified_AtIngress() public {
        _becomeMirror();
        activateRewardCustodyForTest(address(vpfi), 0);
        _seedDiamond(10e18);
        bytes32 id = keccak256("pkt-1");
        bytes32 h = _packetHash(id);
        vm.expectEmit(true, false, false, true, address(diamond));
        emit LibRewardCustody.RewardCustodyUnclassifiedCredited(h, LibRewardCustody.PACKET_KIND_BUDGET, 1e18);
        _deliverStamped(6e18, 3e18, 2e18, 7, id);

        assertEq(_live(), 3e18, "the fresh share is live");
        assertEq(_recycledRow(), 2e18, "the recycled share relocated");
        assertEq(_unclassified(), 1e18, "the remainder is protected into Unclassified");
        assertEq(_held(), 6e18, "the whole landing is in the holder");
        assertEq(vpfi.balanceOf(address(diamond)), 4e18, "and none of it rests in the Diamond");
        (uint256 uncountedHeld, uint256 returnedHeld, uint256 reservedHeld) = _rlens().getUnclassifiedPosition();
        assertEq(uncountedHeld, 1e18, "the row's uncounted figure");
        assertEq(returnedHeld, 0);
        assertEq(reservedHeld, 0);
        (, uint256 uncounted) = _rlens().getDeliveredFreshPosition();
        assertEq(uncounted, 1e18, "the reconciliation twin still counts it");

        LibVaipakam.IngressPacket memory p = _rlens().getIngressPacket(h);
        assertEq(p.kind, LibRewardCustody.PACKET_KIND_BUDGET, "kind");
        assertEq(p.sourceChainId, CHAIN_BASE, "source");
        assertEq(p.actualReceived, 6e18, "what landed");
        assertEq(p.freshShare, 3e18);
        assertEq(p.recycledShare, 2e18);
        assertEq(p.unclassified, 1e18, "what the packet holds in the row");
        assertEq(p.remitter, REMITTER);
        assertEq(p.remitId, 7);
        assertGt(p.arrivedAt, 0, "recorded");
        LibVaipakam.ReceivedRemit memory rec = _rlens().getReceivedRemit(REMITTER, 7);
        assertEq(rec.packetHash, h, "the receipt is bound to the stamp");
        assertEq(rec.amount, 6e18, "the receipt is written by the record");
        assertEq(rec.srcChainId, CHAIN_BASE);
    }

    /// The same delivery on a deployment whose custody is NOT activated is
    /// byte-for-byte today's behaviour: the remainder stays in the Diamond's
    /// balance, no row moves — and the packet is still recorded, since the
    /// stamp is taken on every deployment.
    function test_UntypedRemainder_StaysDiamondSide_WhenNotActivated() public {
        _remit().setRewardRemittanceReceiver(address(this));
        _seedDiamond(10e18);
        bytes32 id = keccak256("pkt-legacy");
        _deliverStamped(6e18, 3e18, 2e18, 7, id);
        assertEq(_unclassified(), 0, "no row moves");
        assertEq(vpfi.balanceOf(address(diamond)), 10e18, "everything rests in the Diamond");
        (uint256 received, ) = _ledger();
        assertEq(received, 3e18, "counted Diamond-side");
        assertEq(_cfg().getRecycleBucket(), 2e18, "the recycled share credited the bucket");
        (, uint256 uncounted) = _rlens().getDeliveredFreshPosition();
        assertEq(uncounted, 1e18);
        LibVaipakam.IngressPacket memory p = _rlens().getIngressPacket(_packetHash(id));
        assertGt(p.arrivedAt, 0, "the packet is recorded on every deployment");
        assertEq(p.unclassified, 0, "nothing of it is in the row");
    }

    /// The ingress stamp is the packet's identity: a second landing under the
    /// same stamp refuses whole, and a transport without an id takes a
    /// per-source sequence the ingress allocates itself.
    function test_IngressPacket_ReplayRefused_AndAZeroIdTakesTheSequence() public {
        _becomeMirror();
        activateRewardCustodyForTest(address(vpfi), 0);
        _seedDiamond(20e18);
        bytes32 id = keccak256("pkt-2");
        _deliverStamped(3e18, 3e18, 0, 7, id);
        vm.expectRevert(abi.encodeWithSelector(IngressPacketReplayed.selector, _packetHash(id)));
        _deliverStamped(3e18, 3e18, 0, 8, id);

        _deliverStamped(1e18, 1e18, 0, 9, bytes32(0));
        _deliverStamped(1e18, 1e18, 0, 10, bytes32(0));
        bytes32 h1 = keccak256(abi.encode(uint256(CHAIN_BASE), uint256(1), "seq"));
        bytes32 h2 = keccak256(abi.encode(uint256(CHAIN_BASE), uint256(2), "seq"));
        assertGt(_rlens().getIngressPacket(h1).arrivedAt, 0, "first sequence stamp");
        assertGt(_rlens().getIngressPacket(h2).arrivedAt, 0, "second sequence stamp");
        assertEq(_rlens().getIngressPacket(h1).remitId, 9);
        assertEq(_rlens().getIngressPacket(h2).remitId, 10);
    }

    /// Codex #2198 r1 — a receipt is delivered ONCE: a second packet under an
    /// existing receipt (a distinct transport message, past the stamp guard)
    /// refuses whole, for a delivery and a compensation alike, so the
    /// stranded record's packet is THE packet and every receipt-keyed figure
    /// describes exactly one.
    function test_IngressPacket_SecondPacketForADeliveredReceiptRefused() public {
        _becomeMirror();
        activateRewardCustodyForTest(address(vpfi), 0);
        _seedDiamond(30e18);
        bytes32 key7 = keccak256(abi.encode(REMITTER, uint256(7)));
        _deliverStamped(3e18, 3e18, 0, 7, keccak256("pkt-a"));
        vm.expectRevert(abi.encodeWithSelector(IngressReceiptAlreadyDelivered.selector, key7));
        _deliverStamped(3e18, 3e18, 0, 7, keccak256("pkt-b"));
        vm.expectRevert(abi.encodeWithSelector(IngressReceiptAlreadyDelivered.selector, key7));
        _deliverCompensation(3e18, 7, 0, keccak256("pkt-c")); // a compensation naming a delivered receipt: the same
        assertEq(
            _rlens().getReceivedRemit(REMITTER, 7).packetHash, _packetHash(keccak256("pkt-a")), "the one binding stands"
        );
        assertEq(_rlens().getIngressPacket(_packetHash(keccak256("pkt-b"))).arrivedAt, 0, "a refused packet leaves no record");

        // A quarantined compensation, then a second packet for its receipt:
        // refused, so the record's held part, its packet and the packet's
        // figure stay one and the same.
        bytes32 idQ = keccak256("comp-q1");
        _deliverCompensation(5e18, 11, 0, idQ); // state unknown, no clock: quarantined
        bytes32 key11 = keccak256(abi.encode(REMITTER, uint256(11)));
        vm.expectRevert(abi.encodeWithSelector(IngressReceiptAlreadyDelivered.selector, key11));
        _deliverCompensation(5e18, 11, 0, keccak256("comp-q2"));
        LibVaipakam.StrandedRecovery memory sr = _rlens().getStrandedRecovery(REMITTER, 11);
        assertEq(sr.held, 5e18, "one packet's worth in the row");
        assertEq(sr.packetHash, _packetHash(idQ), "bound to that packet");
        assertEq(_rlens().getIngressPacket(_packetHash(idQ)).unclassified, 5e18, "whose figure is the record's");
        assertEq(_unclassified(), 5e18, "the row holds exactly the quarantine");
    }

    /// A quarantined compensation lands in the row on an activated
    /// deployment: the stranded record and the reservation say how much the
    /// holder backs, the Diamond's backing position no longer subtracts that
    /// part, and the versioned snapshot's reservation field reads the
    /// Diamond-side remainder only.
    function test_Quarantine_LandsInTheRow_AndTheBackingPositionNetsIt() public {
        _becomeMirror();
        activateRewardCustodyForTest(address(vpfi), 0);
        _seedDiamond(10e18);
        bytes32 id = keccak256("comp-q");
        _deliverCompensation(5e18, 11, 0, id); // state unknown, no clock: quarantined
        assertEq(_unclassified(), 5e18, "the quarantine is in the row");
        assertEq(_held(), 5e18);
        assertEq(vpfi.balanceOf(address(diamond)), 5e18, "and out of the Diamond");
        LibVaipakam.StrandedRecovery memory sr = _rlens().getStrandedRecovery(REMITTER, 11);
        assertEq(sr.amount, 5e18, "recorded");
        assertEq(sr.held, 5e18, "and the record knows the holder backs it");
        (uint256 uncountedHeld, , uint256 reservedHeld) = _rlens().getUnclassifiedPosition();
        assertEq(uncountedHeld, 5e18);
        assertEq(reservedHeld, 5e18);
        assertEq(_rlens().getStrandedRecoveryReserved(), 5e18, "the raw reservation is untouched");
        (, , uint256 unearmarked, , , , uint256 diamondSide, , , , , ) = _custody().getRecycleBackingSnapshotV2();
        assertEq(diamondSide, 0, "the snapshot's reservation is the Diamond-side part only");
        assertEq(unearmarked, 5e18, "the backing position subtracts nothing for the held part");
        LibVaipakam.IngressPacket memory p = _rlens().getIngressPacket(_packetHash(id));
        assertEq(p.kind, LibRewardCustody.PACKET_KIND_COMPENSATION);
        assertEq(p.unclassified, 5e18);
        assertEq(_rlens().getReceivedRemit(REMITTER, 11).packetHash, _packetHash(id));
    }

    /// A demotion re-attributes the credit's remainder IN-HOLDER — live
    /// first, then restitution — into the row, where the record and the
    /// reservation now describe it; nothing is released to the Diamond.
    function test_Demotion_MovesTheCreditInHolder_IntoUnclassified() public {
        _becomeMirror();
        activateRewardCustodyForTest(address(vpfi), 0);
        _seedDiamond(10e18);
        bytes32 id = keccak256("comp-p");
        _deliverCompensation(5e18, 12, uint64(block.timestamp), id); // live clock: provisional credit
        assertEq(_live(), 5e18, "credited live, provisionally");
        uint256 diamondBefore = vpfi.balanceOf(address(diamond));

        vm.prank(address(diamond)); // the broadcast hook is Diamond-internal
        _remit().onCompensationDayBroadcastArrived(3, address(0xDD), false); // another era: demote
        assertEq(_live(), 0, "the credit left the live row");
        assertEq(_unclassified(), 5e18, "and is re-attributed in the holder");
        assertEq(_held(), 5e18, "the holder's balance did not move");
        assertEq(vpfi.balanceOf(address(diamond)), diamondBefore, "nothing was released to the Diamond");
        (uint256 received, ) = _ledger();
        assertEq(received, 0, "the received side unwound");
        LibVaipakam.StrandedRecovery memory sr = _rlens().getStrandedRecovery(REMITTER, 12);
        assertEq(sr.amount, 5e18);
        assertEq(sr.held, 5e18, "the record knows the holder backs it");
        (uint256 uncountedHeld, , uint256 reservedHeld) = _rlens().getUnclassifiedPosition();
        assertEq(uncountedHeld, 5e18);
        assertEq(reservedHeld, 5e18);
        assertEq(_rlens().getIngressPacket(_packetHash(id)).unclassified, 5e18, "the packet's record follows");
    }

    /// MIGRATION MODE (design §5c): under the manual pause the receive
    /// ingresses still land — a delivery and a quarantine both reach the
    /// holder — while every consumer is refused; after the unpause the claim
    /// pays out of what landed.
    function test_MigrationMode_PausedIngressLands_AndPausedConsumersRefuse() public {
        _becomeMirror();
        activateRewardCustodyForTest(address(vpfi), 0);
        (uint256 id, uint256 expected) = _seedPayable(alice);
        _seedDiamond(expected + 20e18);
        _admin().pause();

        _deliverStamped(expected + 3e18, expected + 1e18, 2e18, 21, keccak256("paused-1"));
        assertEq(_live(), expected + 1e18, "landed under the pause");
        assertEq(_recycledRow(), 2e18);
        assertEq(_unclassified(), 0);
        _deliverCompensation(4e18, 22, 0, keccak256("paused-2"));
        assertEq(_unclassified(), 4e18, "the quarantine landed under the pause too");

        vm.prank(alice);
        vm.expectRevert();
        _claim().claimInteractionRewards();
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.expectRevert();
        _sweeper().sweepExpiredInteractionRewards(ids);

        _admin().unpause();
        uint256 holderBefore = _held();
        vm.prank(alice);
        (uint256 claimed, , ) = _claim().claimInteractionRewards();
        assertApproxEqAbs(claimed, expected, 1e6, "paid after the unpause");
        assertEq(holderBefore - _held(), claimed, "from the holder");
    }

    // ─── 7. the legacy reconciliation epoch (#1566 closure 2 cutover PR 2) ──

    function _recon() internal view returns (RewardReconciliationFacet) {
        return RewardReconciliationFacet(address(diamond));
    }
    /// An untyped (old-wire) delivery: no shares, the whole amount lands in
    /// the `Unclassified` row on an activated deployment.
    function _untyped(uint256 amount, uint256 remitId, bytes32 id) internal {
        _deliverStamped(amount, 0, 0, remitId, id);
    }
    /// The packet's authenticated fresh figure, as the transport attestation
    /// would write it (the test-only writer; production has none yet).
    function _evidence(bytes32 h, uint256 amount) internal {
        _mut().setPacketFreshAuthenticatedRaw(h, amount);
    }
    function _classify(bytes32 h, uint256 f, uint256 r, bytes32 entryId) internal {
        _admin().pause();
        _recon().classifyLegacyPacket(h, f, r, entryId);
        _admin().unpause();
    }
    function _reclassify(uint256 index, bool freshToRecycled, uint256 amount, bytes32 entryId) internal {
        _admin().pause();
        _recon().reclassifyReconciliationEntry(index, freshToRecycled, amount, entryId);
        _admin().unpause();
    }
    function _packet(bytes32 h)
        internal
        view
        returns (uint256 protectedIn, uint256 unclassified, uint256 cf, uint256 cr, uint256 disposed)
    {
        (, protectedIn, unclassified, cf, cr, disposed, ) = _recon().getPacketReconciliation(h);
    }
    function _authenticated(bytes32 h) internal view returns (uint256 a) {
        (, , , , , , a) = _recon().getPacketReconciliation(h);
    }
    /// The fresh queue of era 0: frontier, unspent, spent, paid, what its
    /// pending takes still hold unwritten, and the live row.
    function _queue()
        internal
        view
        returns (uint256 frontier, uint256 unspent, uint256 spent, uint256 paid, uint256 pending, uint256 liveRow)
    {
        (frontier, unspent, spent, paid, pending, liveRow, , , , , ) = _recon().getFreshQueueState(0);
    }
    /// The absorbed records: frontier, unreleased, released, the restitution
    /// row.
    function _aqueue()
        internal
        view
        returns (uint256 frontier, uint256 unreleased, uint256 released, uint256 restitutionRow)
    {
        (, , , , , , frontier, unreleased, released, restitutionRow, ) = _recon().getFreshQueueState(0);
    }
    /// The recycled queue: frontier, unspent, spent, consumed, pending.
    function _rqueue()
        internal
        view
        returns (uint256 frontier, uint256 unspent, uint256 spent, uint256 consumed, uint256 pending)
    {
        (frontier, unspent, spent, consumed, pending, ) = _recon().getRecycledQueueState();
    }
    function _records(
        uint256 i
    )
        internal
        view
        returns (
            uint256 freshAmount,
            uint256 freshSpent,
            uint256 freshCharged,
            uint256 recycledAmount,
            uint256 recycledSpent,
            uint256 recycledCharged,
            uint256 absorbedAmount,
            uint256 absorbedReleased
        )
    {
        return _recon().getEntryRecords(i);
    }
    function _bucket() internal view returns (uint256) {
        return _cfg().getRecycleBucket();
    }
    function _uncountedAggregate() internal view returns (uint256 uncounted) {
        (, uncounted) = _rlens().getDeliveredFreshPosition();
    }
    function _paidOutRecycled() internal view returns (uint256 paidOut) {
        (, , , , paidOut, , , , , , , ) = _custody().getRecycleBackingSnapshotV2();
    }
    function _activatedMirror() internal {
        _becomeMirror();
        activateRewardCustodyForTest(address(vpfi), 0);
    }
    /// A mirror activated with a standing deficit of `deficit` (paid beyond
    /// received), so a fresh credit takes the split.
    function _activatedMirrorWithDeficit(uint256 deficit) internal {
        _becomeMirror();
        _admin().pause();
        _custody().bindRewardCustodyHolder();
        uint64 epoch = _epoch();
        _custody().rebaseArmedFreshPaid(deficit, epoch);
        _custody().activateRewardCustody(epoch, false);
        _admin().unpause();
    }
    function _spentOf(uint256 index) internal view returns (RewardReconciliationFacet.Spent memory) {
        return _recon().getReconciliationEntrySpent(index);
    }
    function _entry(uint256 index) internal view returns (LibVaipakam.ReconciliationEntry memory) {
        return _recon().getReconciliationEntry(index);
    }
    function _feeInflow(uint256 amount) internal {
        uint256 before = vpfi.balanceOf(address(diamond));
        vpfi.mint(address(diamond), amount);
        _mut().creditInflowRawWithBefore(LibVpfiRecycle.RecycleSource.NotificationFee, 1, amount, before);
    }

    /// A classification leaves the row IN-HOLDER: the fresh share to live
    /// backing (no deficit), the recycled share to the recycled row with the
    /// bucket following, no token moving anywhere; the row's figure, the
    /// global aggregate and the packet's own figures all step down exactly;
    /// the entry is logged at the front of both queues.
    function test_Classify_MovesTheRemainderInHolder_UnderTheSplit() public {
        _activatedMirror();
        _seedDiamond(10e18);
        bytes32 id = keccak256("legacy-1");
        _untyped(10e18, 31, id);
        bytes32 h = _packetHash(id);
        assertEq(_unclassified(), 10e18, "protected at ingress");
        _evidence(h, 6e18);
        assertEq(_authenticated(h), 6e18, "the evidence, as recorded");
        uint256 holderBefore = _held();
        uint256 diamondBefore = vpfi.balanceOf(address(diamond));
        (uint256 receivedBefore, ) = _ledger();
        _classify(h, 6e18, 4e18, keccak256("e1"));
        assertEq(_unclassified(), 0, "the row emptied");
        assertEq(_live(), 6e18, "fresh into live (no deficit)");
        assertEq(_recycledRow(), 4e18, "recycled into the recycled row");
        assertEq(_bucket(), 4e18, "the bucket follows the row");
        (uint256 receivedAfter, ) = _ledger();
        assertEq(receivedAfter - receivedBefore, 6e18, "received rose by the fresh share");
        assertEq(_held(), holderBefore, "no tokens left the holder");
        assertEq(vpfi.balanceOf(address(diamond)), diamondBefore, "nor the Diamond");
        (uint256 uncountedHeld, , ) = _rlens().getUnclassifiedPosition();
        assertEq(uncountedHeld, 0, "the row's figure stepped down");
        assertEq(_uncountedAggregate(), 0, "and the global aggregate");
        (uint256 protectedIn, uint256 unclassified, uint256 cf, uint256 cr, ) = _packet(h);
        assertEq(protectedIn, 10e18, "what the packet put in");
        assertEq(unclassified, 0);
        assertEq(cf, 6e18);
        assertEq(cr, 4e18);
        LibVaipakam.ReconciliationEntry memory e = _entry(0);
        assertEq(e.key, h);
        assertEq(e.freshCredit, 6e18);
        assertEq(e.recycledCredit, 4e18);
        assertFalse(e.envelope, "a packet-backed entry");
        (, uint256 funspent, , , , ) = _queue();
        (, uint256 runspent, , , ) = _rqueue();
        assertEq(funspent, 6e18);
        assertEq(runspent, 4e18);
        (uint256 fa, uint256 fs, , uint256 ra, , , , ) = _records(0);
        assertEq(fa, 6e18, "the entry's own fresh record");
        assertEq(fs, 0);
        assertEq(ra, 4e18, "and its recycled record");
        assertTrue(_recon().isReconciliationEntryUsed(keccak256("e1")));
        (uint256 entries, , ) = _recon().getReconciliationTotals();
        assertEq(entries, 1);
    }

    /// The fresh leg takes the deficit split: what the standing deficit
    /// absorbs goes to restitution, only the excess to live.
    function test_Classify_ToFresh_SplitsAtTheDeficit() public {
        _activatedMirrorWithDeficit(6e18);
        _seedDiamond(10e18);
        bytes32 id = keccak256("legacy-deficit");
        _untyped(10e18, 32, id);
        _evidence(_packetHash(id), 10e18);
        _classify(_packetHash(id), 10e18, 0, keccak256("e-deficit"));
        assertEq(_row(LibVaipakam.RewardCustodyRow.Restitution), 6e18, "the absorbed portion to restitution");
        assertEq(_live(), 4e18, "only the excess to live");
        (uint256 received, uint256 paid) = _ledger();
        assertEq(received, 10e18);
        assertEq(paid, 6e18);
    }

    /// Codex #2206 r3 (P1) — the evidence rule (design L4436-4450): the
    /// fresh side is the privileged direction and needs evidence the
    /// administrator does not write; the recycled side is the conservative
    /// one and needs none. An untyped packet with no authenticated fresh
    /// figure classifies recycled, or stays.
    function test_Classify_FreshNeedsEvidence_RecycledDoesNot() public {
        _activatedMirror();
        _seedDiamond(10e18);
        bytes32 id = keccak256("legacy-evidence");
        _untyped(10e18, 33, id);
        bytes32 h = _packetHash(id);
        assertEq(_authenticated(h), 0, "no evidence for an untyped remainder");
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(ReconciliationFreshUnevidenced.selector, h, 1e18, 0));
        _recon().classifyLegacyPacket(h, 1e18, 0, keccak256("e-f1"));
        vm.expectRevert(abi.encodeWithSelector(ReconciliationFreshUnevidenced.selector, h, 1e18, 0));
        _recon().classifyLegacyPacket(h, 1e18, 9e18, keccak256("e-f1-r9"));
        _admin().unpause();
        assertEq(_unclassified(), 10e18, "nothing moved");
        _classify(h, 0, 10e18, keccak256("e-r10"));
        (, uint256 unclassified, uint256 cf, uint256 cr, ) = _packet(h);
        assertEq(unclassified, 0);
        assertEq(cf, 0);
        assertEq(cr, 10e18, "the whole remainder, recycled, on no evidence");
        assertEq(_bucket(), 10e18);
    }

    /// The fresh bound is CUMULATIVE over a packet's entries (design
    /// L4156-4161): with 4 authenticated, 4/0 passes and a later 4/2 refuses
    /// on the fresh component, not the total; the recycled component still
    /// takes the rest.
    function test_Classify_FreshIsBoundedByTheEvidence_Cumulatively() public {
        _activatedMirror();
        _seedDiamond(10e18);
        bytes32 id = keccak256("legacy-4-6");
        _untyped(10e18, 34, id);
        bytes32 h = _packetHash(id);
        _evidence(h, 4e18);
        _classify(h, 4e18, 0, keccak256("e-4-0"));
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(ReconciliationFreshUnevidenced.selector, h, 8e18, 4e18));
        _recon().classifyLegacyPacket(h, 4e18, 2e18, keccak256("e-4-2"));
        _admin().unpause();
        _classify(h, 0, 6e18, keccak256("e-0-6"));
        (, uint256 unclassified, uint256 cf, uint256 cr, ) = _packet(h);
        assertEq(unclassified, 0);
        assertEq(cf, 4e18);
        assertEq(cr, 6e18);
    }

    /// A wrong SPLIT that passes the total (design L3987-3993): 6/4 on a
    /// packet whose evidence says 4 fresh refuses at submission, exhausting
    /// nothing.
    function test_Classify_AWrongSplitRefusesAtSubmission() public {
        _activatedMirror();
        _seedDiamond(10e18);
        bytes32 id = keccak256("legacy-split");
        _untyped(10e18, 35, id);
        bytes32 h = _packetHash(id);
        _evidence(h, 4e18);
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(ReconciliationFreshUnevidenced.selector, h, 6e18, 4e18));
        _recon().classifyLegacyPacket(h, 6e18, 4e18, keccak256("e-6-4"));
        _admin().unpause();
        (, uint256 unclassified, uint256 cf, uint256 cr, ) = _packet(h);
        assertEq(unclassified, 10e18, "nothing moved");
        assertEq(cf + cr, 0);
        assertEq(_unclassified(), 10e18);
    }

    /// A rounding residual STAYS in the row (design L4070-4078): an entry
    /// can leave a share of the packet unclassified, and it stays visible in
    /// the row's figure, the global aggregate and the packet's remainder.
    function test_Classify_ResidualStaysInTheRow() public {
        _activatedMirror();
        _seedDiamond(10e18);
        bytes32 id = keccak256("legacy-dust");
        _untyped(10e18, 36, id);
        bytes32 h = _packetHash(id);
        _evidence(h, 4e18);
        _classify(h, 4e18, 5e18, keccak256("e-dust"));
        assertEq(_unclassified(), 1e18, "the residual stays in the row");
        (uint256 uncountedHeld, , ) = _rlens().getUnclassifiedPosition();
        assertEq(uncountedHeld, 1e18);
        assertEq(_uncountedAggregate(), 1e18);
        (, uint256 unclassified, , , ) = _packet(h);
        assertEq(unclassified, 1e18);
    }

    /// A packet whose value is still reserved for the R4 return is not
    /// classifiable (the local form of design L4393-4400).
    function test_Classify_RefusesAPacketWithAnOutstandingStrandedRecord() public {
        _activatedMirror();
        _seedDiamond(10e18);
        bytes32 id = keccak256("legacy-quarantine");
        _deliverCompensation(5e18, 11, 0, id); // quarantined: reserved for the return
        bytes32 h = _packetHash(id);
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(ReconciliationPacketReserved.selector, h, 5e18));
        _recon().classifyLegacyPacket(h, 0, 5e18, keccak256("e-q"));
        _admin().unpause();
    }

    /// The gates: the manual pause, an activated deployment, a known packet,
    /// a non-empty entry, the packet's own remainder, and the per-entry
    /// replay guard.
    function test_Classify_Gates() public {
        _becomeMirror();
        _seedDiamond(10e18);
        bytes32 id = keccak256("legacy-gates");
        _untyped(10e18, 37, id); // not activated: stays Diamond-side
        bytes32 h = _packetHash(id);
        vm.expectRevert(LibPausable.ExpectedManualPause.selector);
        _recon().classifyLegacyPacket(h, 0, 1e18, keccak256("g-1"));
        _admin().pause();
        vm.expectRevert(RewardCustodyNotActivated.selector);
        _recon().classifyLegacyPacket(h, 0, 1e18, keccak256("g-1"));
        _admin().unpause();
        activateRewardCustodyForTest(address(vpfi), 0);
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(ReconciliationPacketUnknown.selector, keccak256("nope")));
        _recon().classifyLegacyPacket(keccak256("nope"), 0, 1e18, keccak256("g-2"));
        vm.expectRevert(InvalidAmount.selector);
        _recon().classifyLegacyPacket(h, 0, 0, keccak256("g-3"));
        // The pre-activation packet's value is Diamond-side, not in the row:
        // its remainder is zero, so nothing of it is classifiable — that
        // value is the envelope's to import.
        vm.expectRevert(abi.encodeWithSelector(ReconciliationExceedsPacketRemainder.selector, h, 1e18, 0));
        _recon().classifyLegacyPacket(h, 0, 1e18, keccak256("g-4"));
        // A refused entry's id is NOT spent (the revert rolls the mark back);
        // an applied entry's is.
        _untyped(5e18, 38, keccak256("legacy-gates-2")); // lands protected, under the pause
        bytes32 h2 = _packetHash(keccak256("legacy-gates-2"));
        _recon().classifyLegacyPacket(h2, 0, 1e18, keccak256("g-2")); // "g-2" was refused above: usable
        vm.expectRevert(abi.encodeWithSelector(ReconciliationEntryReplayed.selector, keccak256("g-2")));
        _recon().classifyLegacyPacket(h2, 0, 1e18, keccak256("g-2"));
        _admin().unpause();
    }

    /// A packet landing UNDER the paused entry (the migration mode) is its
    /// own packet: the entry's bounds are per packet and unaffected.
    function test_Classify_APacketLandingUnderThePauseIsItsOwn() public {
        _activatedMirror();
        _seedDiamond(20e18);
        _untyped(10e18, 38, keccak256("A"));
        _admin().pause();
        _untyped(10e18, 39, keccak256("B")); // lands under the pause
        _recon().classifyLegacyPacket(_packetHash(keccak256("A")), 0, 10e18, keccak256("e-A"));
        _admin().unpause();
        (, uint256 unclassifiedB, , , ) = _packet(_packetHash(keccak256("B")));
        assertEq(unclassifiedB, 10e18, "B's remainder untouched");
        assertEq(_unclassified(), 10e18);
    }

    /// Unspent fresh credit moves to recycled WITH its tokens, in-holder:
    /// the live row and received fall, the recycled row and bucket rise, the
    /// entry's credits and the queues record the move.
    function test_Reclassify_UnspentFreshToRecycled_MovesCustody() public {
        _activatedMirror();
        _seedDiamond(10e18);
        bytes32 id = keccak256("legacy-move");
        _untyped(10e18, 40, id);
        _evidence(_packetHash(id), 10e18);
        _classify(_packetHash(id), 10e18, 0, keccak256("e-move"));
        uint256 holderBefore = _held();
        _reclassify(0, true, 4e18, keccak256("r-move"));
        assertEq(_live(), 6e18);
        assertEq(_recycledRow(), 4e18);
        assertEq(_bucket(), 4e18);
        (uint256 received, ) = _ledger();
        assertEq(received, 6e18);
        assertEq(_held(), holderBefore, "in-holder");
        LibVaipakam.ReconciliationEntry memory e = _entry(0);
        assertEq(e.freshCredit, 6e18);
        assertEq(e.recycledCredit, 4e18);
        (, uint256 freshUnspent, , , , uint256 liveRow) = _queue();
        (, uint256 recycledUnspent, , , ) = _rqueue();
        assertEq(freshUnspent, 6e18, "the fresh queue follows the credit");
        assertEq(recycledUnspent, 4e18, "the moved credit joined the recycled queue");
        assertEq(liveRow, 6e18);
        (, uint256 reIn, uint256 reOut) = _recon().getReconciliationTotals();
        assertEq(reIn, 4e18);
        assertEq(reOut, 0);
        // And back: recycled → fresh, within the evidence, bounded by the
        // uncommitted bucket.
        _reclassify(0, false, 4e18, keccak256("r-back"));
        assertEq(_live(), 10e18);
        assertEq(_bucket(), 0);
        (received, ) = _ledger();
        assertEq(received, 10e18);
        e = _entry(0);
        assertEq(e.freshCredit, 10e18);
        assertEq(e.recycledCredit, 0);
    }

    /// Codex #2206 r3 (P1) — the correction toward fresh is the same
    /// privileged door and takes the same evidence: recycled credit lifts to
    /// fresh only up to the packet's authenticated figure, cumulatively with
    /// what was classified fresh; the conservative direction is never bound.
    function test_Reclassify_ToFreshIsBoundedByTheEvidence() public {
        _activatedMirror();
        _seedDiamond(10e18);
        bytes32 id = keccak256("legacy-lift");
        _untyped(10e18, 41, id);
        bytes32 h = _packetHash(id);
        _classify(h, 0, 10e18, keccak256("e-lift")); // conservatively, on no evidence
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(ReconciliationFreshUnevidenced.selector, h, 1e18, 0));
        _recon().reclassifyReconciliationEntry(0, false, 1e18, keccak256("r-lift-0"));
        _admin().unpause();
        _evidence(h, 4e18); // the evidence arrives later and lifts it
        _reclassify(0, false, 4e18, keccak256("r-lift-4"));
        assertEq(_live(), 4e18);
        assertEq(_bucket(), 6e18);
        (, , uint256 cf, uint256 cr, ) = _packet(h);
        assertEq(cf, 4e18, "the packet's cumulative fresh followed");
        assertEq(cr, 6e18);
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(ReconciliationFreshUnevidenced.selector, h, 5e18, 4e18));
        _recon().reclassifyReconciliationEntry(0, false, 1e18, keccak256("r-lift-5"));
        _admin().unpause();
        _reclassify(0, true, 4e18, keccak256("r-back")); // toward recycled: always
        _reclassify(0, false, 4e18, keccak256("r-lift-again")); // and back up to the evidence
        assertEq(_live(), 4e18);
    }

    /// The design's 6/4→4/6 case (L4241-4247): a SPENT fresh split corrected
    /// moves its debit to recycled consumption — `received` and `paid` fall
    /// together, the destination's consumption rises, no replacement — while
    /// the unspent part moves with its tokens, so the entry rereads as fully
    /// spent on what it kept.
    function test_Reclassify_SpentFreshMovesTheDebit_NoReplacement() public {
        _activatedMirror();
        (, uint256 expected) = _seedPayable(alice);
        uint256 fresh = expected + 2e18;
        _seedDiamond(fresh + 4e18);
        bytes32 id = keccak256("legacy-spent");
        _untyped(fresh + 4e18, 42, id);
        _evidence(_packetHash(id), fresh);
        _classify(_packetHash(id), fresh, 4e18, keccak256("e-spent"));
        vm.prank(alice);
        (uint256 claimed, , ) = _claim().claimInteractionRewards();
        RewardReconciliationFacet.Spent memory sp = _spentOf(0);
        assertEq(sp.freshSpent, claimed, "the claim spent the entry's fresh credit: the live row is short by it");
        assertEq(sp.freshUnspent, fresh - claimed);
        assertEq(sp.recycledSpent, 0);
        (uint256 received0, uint256 paid0) = _ledger();
        uint256 bucket0 = _bucket();
        uint256 paidOut0 = _paidOutRecycled();
        _reclassify(0, true, fresh, keccak256("r-spent"));
        uint256 unspent = fresh - claimed;
        (uint256 received1, uint256 paid1) = _ledger();
        assertEq(received0 - received1, fresh, "received gave back the whole credit");
        assertEq(paid0 - paid1, claimed, "paid gave back exactly the spent part");
        assertEq(_live(), 0, "the unspent part left the live row");
        assertEq(_bucket() - bucket0, unspent, "and entered the bucket with its tokens");
        assertEq(_paidOutRecycled() - paidOut0, claimed, "the spent part is inherited recycled consumption");
        LibVaipakam.ReconciliationEntry memory e = _entry(0);
        assertEq(e.freshCredit, 0);
        assertEq(e.recycledCredit, 4e18 + fresh);
        (, , , uint256 ra, uint256 rs, uint256 rc, , ) = _records(0);
        assertEq(ra, 4e18 + fresh, "the entry's recycled record, at its own position");
        assertEq(rs, claimed, "the inherited debit arrived spent");
        assertEq(rc, claimed, "and charged: inheritable back");
        sp = _spentOf(0);
        assertEq(sp.freshSpent, 0);
        assertEq(sp.recycledSpent, claimed, "the moved-in spent credit reads spent by inheritance");
        assertEq(sp.recycledUnspent, 4e18 + unspent, "the bucket backs the rest");
        (, uint256 reIn, ) = _recon().getReconciliationTotals();
        assertEq(reIn, fresh);
    }

    /// Codex #2206 r3 — a PARTIAL correction of a partly spent entry moves
    /// the unspent part first, because that is the correct-at-ingress
    /// result (design L4028-4032): of ten fresh with five paid out,
    /// correcting two to recycled leaves fresh at eight with the same five
    /// paid — had the packet been classified 8/2 at ingress, eight would
    /// have covered those five payouts and the two would have sat unspent in
    /// the bucket. Only what the corrected credit can no longer cover was
    /// the other side's: correcting seven moves five with tokens and two as
    /// the debit — `received = 3, paid = 3`, recycled 7 with 2 consumed.
    function test_Reclassify_PartialCorrection_UnspentFirstIsCorrectAtIngress() public {
        _activatedMirror();
        (, uint256 expected) = _seedPayable(alice);
        uint256 fresh = expected + 5e18;
        _seedDiamond(fresh);
        bytes32 id = keccak256("legacy-partial");
        _untyped(fresh, 43, id);
        _evidence(_packetHash(id), fresh);
        _classify(_packetHash(id), fresh, 0, keccak256("e-partial"));
        vm.prank(alice);
        (uint256 claimed, , ) = _claim().claimInteractionRewards();
        uint256 unspent = fresh - claimed;
        (uint256 received0, uint256 paid0) = _ledger();
        _reclassify(0, true, 2e18, keccak256("r-2")); // within the unspent part
        (uint256 received1, uint256 paid1) = _ledger();
        assertEq(received0 - received1, 2e18, "received fell by the two");
        assertEq(paid1, paid0, "paid unchanged: the corrected credit still covers every payout");
        assertEq(_bucket(), 2e18, "the two sit unspent in the bucket, with their tokens");
        RewardReconciliationFacet.Spent memory sp = _spentOf(0);
        assertEq(sp.freshSpent, claimed, "still exactly the payouts spent");
        assertEq(sp.freshUnspent, unspent - 2e18);
        assertEq(sp.recycledUnspent, 2e18);
        assertEq(sp.recycledSpent, 0);
        _reclassify(0, true, unspent, keccak256("r-rest")); // the rest of the unspent part, then 2 of the debit
        (uint256 received2, uint256 paid2) = _ledger();
        assertEq(received2, received0 - unspent - 2e18);
        assertEq(paid2, paid0 - 2e18, "paid gave back only what the corrected credit cannot cover");
        assertEq(_bucket(), unspent, "every unspent unit moved with its tokens");
        assertEq(_paidOutRecycled(), 2e18, "two units of the debit are recycled consumption");
        sp = _spentOf(0);
        assertEq(sp.freshSpent, claimed - 2e18);
        assertEq(sp.freshUnspent, 0);
        assertEq(sp.recycledSpent, 2e18);
    }

    /// Spent-ness over the LIVE queue (design L4314-4321): A then B at the
    /// same size, A (still unspent) moved away, then a payout — the tokens
    /// consumed are B's, and B reads so because its effective position fell
    /// to the front.
    function test_Reclassify_LiveQueue_BReadsSpentAfterAWasRemoved() public {
        _activatedMirror();
        (, uint256 expected) = _seedPayable(alice);
        uint256 each = expected + 1e18;
        _seedDiamond(2 * each);
        _untyped(each, 44, keccak256("A"));
        _untyped(each, 45, keccak256("B"));
        _evidence(_packetHash(keccak256("A")), each);
        _evidence(_packetHash(keccak256("B")), each);
        _classify(_packetHash(keccak256("A")), each, 0, keccak256("eA"));
        _classify(_packetHash(keccak256("B")), each, 0, keccak256("eB"));
        (uint256 fr, , , , , ) = _queue();
        assertEq(fr, 0, "the frontier at A: B queued behind it");
        _reclassify(0, true, each, keccak256("rA")); // A, still unspent, moved out whole
        (uint256 fa, , , , , , , ) = _records(0);
        assertEq(fa, 0, "A's record emptied");
        vm.prank(alice);
        (uint256 claimed, , ) = _claim().claimInteractionRewards();
        assertEq(_spentOf(1).freshSpent, claimed, "the payout consumed B");
        assertEq(_spentOf(0).freshSpent, 0);
    }

    /// Movable recycled custody is bounded by the UNCOMMITTED bucket (design
    /// L4304-4308): a bucket of 10 fully committed moves nothing.
    function test_Reclassify_RecycledBoundedByUncommitted() public {
        _activatedMirror();
        _seedDiamond(10e18);
        bytes32 id = keccak256("legacy-committed");
        _untyped(10e18, 46, id);
        _evidence(_packetHash(id), 10e18);
        _classify(_packetHash(id), 0, 10e18, keccak256("e-c"));
        _mut().setOutstandingCommitRaw(0, 10e18);
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(ReconciliationExceedsUncommittedBucket.selector, 10e18, 0));
        _recon().reclassifyReconciliationEntry(0, false, 10e18, keccak256("r-c1"));
        _admin().unpause();
        _mut().setOutstandingCommitRaw(0, 4e18);
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(ReconciliationExceedsUncommittedBucket.selector, 7e18, 6e18));
        _recon().reclassifyReconciliationEntry(0, false, 7e18, keccak256("r-c2"));
        _admin().unpause();
        _reclassify(0, false, 6e18, keccak256("r-c3"));
        assertEq(_bucket(), 4e18);
        assertEq(_live(), 6e18);
    }

    /// Spent recycled credit corrected to fresh: the unspent part moves with
    /// its tokens, the spent part is inherited by the fresh side (`received`
    /// and `paid` rise together, the recycled consumption gives it back).
    /// Consumption is driven raw through the real `consume`, which records
    /// what it took of the classified credit at the outflow.
    function test_Reclassify_SpentRecycledToFresh_InheritsTheDebit() public {
        _activatedMirror();
        _seedDiamond(10e18);
        bytes32 id = keccak256("legacy-rspent");
        _untyped(10e18, 47, id);
        _evidence(_packetHash(id), 10e18);
        _classify(_packetHash(id), 0, 10e18, keccak256("e-r"));
        _mut().consumeRecycleRaw(4e18);
        (, , , uint256 consumed, ) = _rqueue();
        assertEq(consumed, 4e18, "the outflow recorded what it took of the classified credit");
        RewardReconciliationFacet.Spent memory sp = _spentOf(0);
        assertEq(sp.recycledSpent, 4e18, "the consumption spent the entry: the bucket is short by it");
        assertEq(sp.recycledInheritable, 4e18, "consumption is inheritable");
        (uint256 received0, uint256 paid0) = _ledger();
        _reclassify(0, false, 10e18, keccak256("r-r"));
        (uint256 received1, uint256 paid1) = _ledger();
        assertEq(received1 - received0, 10e18, "received rose by the whole credit");
        assertEq(paid1 - paid0, 4e18, "paid inherited the spent part");
        assertEq(_live(), 6e18, "the unspent part is live backing");
        assertEq(_bucket(), 0);
        assertEq(_paidOutRecycled(), 0, "the recycled consumption gave the debit back");
        sp = _spentOf(0);
        assertEq(sp.freshSpent, 4e18, "the moved-in credit reads spent by exactly the inherited part");
        assertEq(sp.freshUnspent, 6e18);
        (, , uint256 reOut) = _recon().getReconciliationTotals();
        assertEq(reOut, 10e18);
    }

    /// Codex #2206 r1 — a round trip restores the entry's original
    /// spent-ness: five of ten spent, moved to recycled and back, still reads
    /// five spent, with the ledgers back where they were.
    function test_Reclassify_RoundTrip_RestoresSpentness() public {
        _activatedMirror();
        (, uint256 expected) = _seedPayable(alice);
        uint256 fresh = expected + 5e18;
        _seedDiamond(fresh);
        bytes32 id = keccak256("legacy-round");
        _untyped(fresh, 50, id);
        _evidence(_packetHash(id), fresh);
        _classify(_packetHash(id), fresh, 0, keccak256("e-round"));
        vm.prank(alice);
        (uint256 claimed, , ) = _claim().claimInteractionRewards();
        (uint256 received0, uint256 paid0) = _ledger();
        _reclassify(0, true, fresh, keccak256("r-out"));
        _reclassify(0, false, fresh, keccak256("r-back"));
        (uint256 received1, uint256 paid1) = _ledger();
        assertEq(received1, received0, "received restored");
        assertEq(paid1, paid0, "paid restored");
        assertEq(_live(), fresh - claimed, "the unspent part is live again");
        assertEq(_bucket(), 0);
        RewardReconciliationFacet.Spent memory sp = _spentOf(0);
        assertEq(sp.freshSpent, claimed, "the original spent-ness, not double");
        assertEq(sp.recycledSpent, 0);
        (, uint256 freshUnspent, uint256 freshSpent, , , ) = _queue();
        (, uint256 recycledUnspent, uint256 recycledSpent, , ) = _rqueue();
        assertEq(freshUnspent, fresh - claimed);
        assertEq(freshSpent, claimed, "the fresh record restored");
        assertEq(recycledUnspent + recycledSpent, 0, "nothing left on the recycled side");
    }

    /// Codex #2206 r1 — credit that left by surplus REPATRIATION is spent
    /// but not inheritable: what consumption took of the classified credit
    /// is recorded at the outflow, and only that much (plus what was
    /// inherited) may move to fresh as a debit.
    function test_Reclassify_RepatriatedCreditIsNotInheritable() public {
        _activatedMirror();
        _seedDiamond(10e18);
        bytes32 id = keccak256("legacy-repat");
        _untyped(10e18, 51, id);
        _evidence(_packetHash(id), 10e18);
        _classify(_packetHash(id), 0, 10e18, keccak256("e-repat"));
        _mut().debitRepatriationSurplusRaw(6e18); // left for Base: spent, not consumption
        RewardReconciliationFacet.Spent memory sp = _spentOf(0);
        assertEq(sp.recycledSpent, 6e18, "spent by the repatriation");
        assertEq(sp.recycledInheritable, 0, "none of it is consumption");
        (, , , uint256 consumed, ) = _rqueue();
        assertEq(consumed, 0, "the repatriation recorded no consumption");
        _mut().consumeRecycleRaw(2e18); // 2 more spent, and those 2 are consumption, first in order
        (, , , consumed, ) = _rqueue();
        assertEq(consumed, 2e18);
        sp = _spentOf(0);
        assertEq(sp.recycledSpent, 8e18);
        assertEq(sp.recycledInheritable, 2e18, "consumption attributed first in queue order");
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(ReconciliationSpentRecycledNotInheritable.selector, 0, 8e18, 2e18));
        _recon().reclassifyReconciliationEntry(0, false, 10e18, keccak256("r-repat"));
        _admin().unpause();
        (uint256 received0, uint256 paid0) = _ledger();
        _reclassify(0, false, 4e18, keccak256("r-repat-4")); // 2 unspent with tokens + 2 consumption inherited
        assertEq(_live(), 2e18, "the unspent part moved with its tokens");
        assertEq(_bucket(), 0);
        (uint256 received1, uint256 paid1) = _ledger();
        assertEq(received1 - received0, 4e18);
        assertEq(paid1 - paid0, 2e18, "the fresh side inherited the consumption");
        assertEq(_paidOutRecycled(), 0, "which the recycled consumption gave back");
        sp = _spentOf(0);
        assertEq(sp.recycledSpent, 6e18, "what remains is the repatriated part");
        assertEq(sp.recycledInheritable, 0, "and consumption already passed on is not offered again");
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(ReconciliationSpentRecycledNotInheritable.selector, 0, 1e18, 0));
        _recon().reclassifyReconciliationEntry(0, false, 1e18, keccak256("r-repat-1"));
        _admin().unpause();
    }

    /// Codex #2206 r3 (P2) — consumption made while NOTHING is queued is
    /// nobody's classified credit: the recycled queue empties (A lifted to
    /// fresh whole), unrelated backing is consumed, a later entry B is
    /// classified and then leaves by repatriation — B is spent and none of
    /// it is inheritable, because the outflow that took B's credit recorded
    /// no consumption, and the earlier consumption found nothing queued to
    /// take (a counter of all consumption read against the queue's opening
    /// base would have offered it to B).
    function test_Reclassify_ConsumptionWhileNothingIsQueuedIsNotInheritable() public {
        _activatedMirror();
        _seedDiamond(20e18);
        bytes32 hA = _packetHash(keccak256("A"));
        _untyped(10e18, 60, keccak256("A"));
        _evidence(hA, 10e18);
        _classify(hA, 0, 10e18, keccak256("e-A"));
        _reclassify(0, false, 10e18, keccak256("r-A")); // A whole to fresh, with its tokens: nothing queued
        (, uint256 recycledUnspent, , uint256 consumed, ) = _rqueue();
        assertEq(recycledUnspent, 0, "the recycled queue is empty");
        assertEq(_bucket(), 0);
        _feeInflow(10e18); // unrelated backing
        _mut().consumeRecycleRaw(10e18); // consumed whole while nothing is queued
        (, , , consumed, ) = _rqueue();
        assertEq(consumed, 0, "consumption while nothing is queued took no classified credit");
        bytes32 hB = _packetHash(keccak256("B"));
        _untyped(10e18, 61, keccak256("B"));
        _evidence(hB, 10e18);
        _classify(hB, 0, 10e18, keccak256("e-B"));
        _mut().debitRepatriationSurplusRaw(10e18); // B's credit leaves by repatriation
        RewardReconciliationFacet.Spent memory sp = _spentOf(1);
        assertEq(sp.recycledSpent, 10e18, "B is spent");
        assertEq(sp.recycledInheritable, 0, "and none of it is consumption");
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(ReconciliationSpentRecycledNotInheritable.selector, 1, 10e18, 0));
        _recon().reclassifyReconciliationEntry(1, false, 10e18, keccak256("r-B"));
        _admin().unpause();
    }

    /// Codex #2206 r3 (P2) — a REVERSED payout is consumption that paid
    /// nobody: after the released-remit restore reverses it, the entry is
    /// still spent (its tokens are in the transport pool, not the bucket)
    /// but that part is not inheritable, so the fresh side cannot claim a
    /// `paid` for a payout that did not happen and the recycled payout
    /// counter is never debited for it. A later real consumption is
    /// inheritable again, exactly it.
    function test_Reclassify_AReversedPayoutIsNotInheritable() public {
        _activatedMirror();
        _seedDiamond(10e18);
        bytes32 id = keccak256("legacy-reversed");
        _untyped(10e18, 62, id);
        _evidence(_packetHash(id), 10e18);
        _classify(_packetHash(id), 0, 10e18, keccak256("e-rev"));
        uint256 took = _mut().consumeRecycleRawAsRemit(4e18, 901); // a remit's consumption
        assertEq(took, 4e18, "the remit's take of the classified queue");
        assertEq(_spentOf(0).recycledInheritable, 4e18);
        _mut().restoreReleasedRemitRaw(4e18, 4e18, 901); // the remit released: it paid nobody
        _mut().setOutstandingCommitRaw(0, 0); // the restored commitment is the re-remit's; not under test here
        (, , uint256 recycledSpent, uint256 consumed, ) = _rqueue();
        assertEq(recycledSpent, 4e18, "the spend stands recorded");
        assertEq(consumed, 0, "and the reversal is netted out of the consumption");
        assertEq(_paidOutRecycled(), 0, "the payout counter was reversed");
        RewardReconciliationFacet.Spent memory sp = _spentOf(0);
        assertEq(sp.recycledSpent, 4e18, "still spent: the bucket no longer holds it");
        assertEq(sp.recycledInheritable, 0, "not consumption the fresh side may inherit");
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(ReconciliationSpentRecycledNotInheritable.selector, 0, 4e18, 0));
        _recon().reclassifyReconciliationEntry(0, false, 10e18, keccak256("r-rev-10"));
        _admin().unpause();
        _mut().consumeRecycleRaw(2e18); // a later, real consumption
        sp = _spentOf(0);
        assertEq(sp.recycledSpent, 6e18);
        assertEq(sp.recycledInheritable, 2e18, "inheritable again: exactly the real consumption");
        (uint256 received0, uint256 paid0) = _ledger();
        _reclassify(0, false, 6e18, keccak256("r-rev-6")); // 4 unspent with tokens + the 2 inherited
        (uint256 received1, uint256 paid1) = _ledger();
        assertEq(received1 - received0, 6e18);
        assertEq(paid1 - paid0, 2e18, "paid inherited only the real consumption");
        assertEq(_paidOutRecycled(), 0, "which the recycled payout counter gave back");
        assertEq(_live(), 4e18);
    }

    /// Codex #2206 r1/r2 — spent-ness reads the pool: a consumption before
    /// any recycled classification (an empty bucket, nothing queued) records
    /// no classified consumption, and a fresh outflow covered by delivered
    /// fresh backing reads no classified credit as spent.
    function test_Reclassify_OutflowCoveredByOtherBackingIsNotAttributed() public {
        _activatedMirror();
        (, uint256 expected) = _seedPayable(alice);
        _seedDiamond(expected + 30e18);
        _mut().consumeRecycleRaw(1e18); // consumption before any recycled entry
        _untyped(10e18, 52, keccak256("R"));
        _classify(_packetHash(keccak256("R")), 0, 10e18, keccak256("e-R")); // recycled only
        (, , , uint256 consumed, ) = _rqueue();
        assertEq(consumed, 0, "nothing classified was consumed");
        assertEq(_spentOf(0).recycledInheritable, 0);
        // A fresh outflow, covered by delivered fresh backing, before any
        // fresh classification exists.
        _deliverStamped(expected + 1e18, expected + 1e18, 0, 53, keccak256("D")); // counted: live backing
        vm.prank(alice);
        (uint256 claimed, , ) = _claim().claimInteractionRewards();
        assertGt(claimed, 0);
        _untyped(10e18, 54, keccak256("F"));
        _evidence(_packetHash(keccak256("F")), 10e18);
        _classify(_packetHash(keccak256("F")), 10e18, 0, keccak256("e-F")); // the first fresh credit
        assertEq(_spentOf(1).freshSpent, 0, "the live row still backs the classified credit whole");
        assertEq(_spentOf(1).freshUnspent, 10e18);
    }

    /// Codex #2206 r1/r2 — the pool's other backing is consumed before the
    /// classified credits (the pool is read as it stands): classify A for
    /// 10, absorb a fee for 10, classify B for 10, consume 15 — the bucket
    /// still backs 15 of the 20 queued, so A reads 5 spent and B none, and
    /// the outflow recorded exactly those 5 as classified consumption.
    function test_Reclassify_OtherBackingIsConsumedBeforeTheClassifiedCredits() public {
        _activatedMirror();
        _seedDiamond(20e18);
        _untyped(10e18, 55, keccak256("A"));
        _classify(_packetHash(keccak256("A")), 0, 10e18, keccak256("e-A"));
        _feeInflow(10e18); // a fee, in between
        _untyped(10e18, 56, keccak256("B"));
        _classify(_packetHash(keccak256("B")), 0, 10e18, keccak256("e-B"));
        (uint256 rf, , , , ) = _rqueue();
        assertEq(rf, 0, "the frontier at A: B sits behind it");
        _mut().consumeRecycleRaw(15e18);
        (, , , uint256 consumed, ) = _rqueue();
        assertEq(consumed, 5e18, "the outflow took 5 of the classified credit: the shortfall's growth");
        assertEq(_spentOf(0).recycledSpent, 5e18, "A, first in the queue, carries the shortfall");
        assertEq(_spentOf(1).recycledSpent, 0, "B untouched");
        assertEq(_spentOf(0).recycledInheritable, 5e18, "and it is consumption");
    }

    /// Codex #2206 r2 (P1) — the part of a fresh credit the standing deficit
    /// absorbed into restitution is neither queued nor movable by a
    /// correction for as long as the restitution row holds it.
    function test_Reclassify_RestitutionAbsorbedPartIsNotMovable() public {
        _activatedMirrorWithDeficit(6e18);
        _seedDiamond(10e18);
        _untyped(10e18, 58, keccak256("legacy-abs-r"));
        _evidence(_packetHash(keccak256("legacy-abs-r")), 10e18);
        _classify(_packetHash(keccak256("legacy-abs-r")), 10e18, 0, keccak256("e-abs-r"));
        RewardReconciliationFacet.Spent memory sp = _spentOf(0);
        assertEq(sp.freshAbsorbed, 6e18, "the absorbed part, held by the row");
        assertEq(sp.freshUnspent, 4e18, "only the live part is queued");
        (, uint256 freshUnspent, , , , ) = _queue();
        (, uint256 unreleased, uint256 released, ) = _aqueue();
        assertEq(freshUnspent, 4e18);
        assertEq(unreleased, 6e18);
        assertEq(released, 0, "the row holds every absorbed record");
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(ReconciliationRestitutionNotMovable.selector, 0, 5e18, 4e18));
        _recon().reclassifyReconciliationEntry(0, true, 5e18, keccak256("r-abs-5"));
        _admin().unpause();
        _reclassify(0, true, 4e18, keccak256("r-abs-4"));
        assertEq(_live(), 0);
        assertEq(_bucket(), 4e18);
        assertEq(_row(LibVaipakam.RewardCustodyRow.Restitution), 6e18, "restitution untouched");
        assertEq(_spentOf(0).freshAbsorbed, 6e18, "the record is untouched too");
        assertEq(_entry(0).freshCredit, 6e18, "what the entry keeps is exactly the absorbed part");
    }

    /// Codex #2206 r3 (P2) — absorbed credit is not absorbed forever: the
    /// paid-correction moves restitution custody into live, and what the
    /// restitution row no longer holds of the absorbed records re-enters
    /// the queue, live-backed and movable — first partly, then whole.
    function test_Reclassify_ReleasedAbsorptionRequeues_OnThePaidCorrection() public {
        _activatedMirrorWithDeficit(6e18);
        _seedDiamond(10e18);
        bytes32 h = _packetHash(keccak256("legacy-pc"));
        _untyped(10e18, 63, keccak256("legacy-pc"));
        _evidence(h, 10e18);
        _classify(h, 10e18, 0, keccak256("e-pc"));
        _admin().pause();
        _custody().releaseRestitutionAsPaidCorrection(3e18, keccak256("pc-3")); // 3 of the 6 back to live
        _admin().unpause();
        assertEq(_row(LibVaipakam.RewardCustodyRow.Restitution), 3e18);
        assertEq(_live(), 7e18);
        RewardReconciliationFacet.Spent memory sp = _spentOf(0);
        assertEq(sp.freshAbsorbed, 3e18, "what the row still holds");
        assertEq(sp.freshUnspent, 7e18, "the released part is live-backed and queued");
        assertEq(sp.freshSpent, 0);
        (, uint256 freshUnspent, , , , ) = _queue();
        (, , uint256 released, ) = _aqueue();
        assertEq(freshUnspent, 7e18);
        assertEq(released, 3e18, "what the row released");
        (uint256 fa, uint256 fs, , , , , , ) = _records(0);
        assertEq(fa, 7e18, "the released part re-entered the entry's own fresh record");
        assertEq(fs, 0);
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(ReconciliationRestitutionNotMovable.selector, 0, 8e18, 7e18));
        _recon().reclassifyReconciliationEntry(0, true, 8e18, keccak256("r-pc-8"));
        _admin().unpause();
        _reclassify(0, true, 7e18, keccak256("r-pc-7"));
        assertEq(_live(), 0);
        assertEq(_bucket(), 7e18);
        assertEq(_row(LibVaipakam.RewardCustodyRow.Restitution), 3e18, "untouched");
        LibVaipakam.ReconciliationEntry memory e = _entry(0);
        assertEq(e.freshCredit, 3e18);
        assertEq(_spentOf(0).freshAbsorbed, 3e18, "what the row still holds");
        (, freshUnspent, , , , ) = _queue();
        assertEq(freshUnspent, 0);
        _admin().pause();
        _custody().releaseRestitutionAsPaidCorrection(3e18, keccak256("pc-6")); // the rest back to live
        _admin().unpause();
        sp = _spentOf(0);
        assertEq(sp.freshAbsorbed, 0, "nothing held any more");
        assertEq(sp.freshUnspent, 3e18, "fully live-backed, fully movable");
        _reclassify(0, true, 3e18, keccak256("r-pc-3"));
        assertEq(_live(), 0);
        assertEq(_bucket(), 10e18);
        e = _entry(0);
        assertEq(e.freshCredit, 0);
        assertEq(_spentOf(0).freshAbsorbed, 0);
    }

    /// Codex #2206 r3 (P2) — the release is attributed FIFO by log order: A
    /// (absorbed 6) then B (all live); a paid-correction of 4 releases A's
    /// first, and B queues behind A's released part too.
    function test_Reclassify_ReleasedAbsorptionIsAttributedFIFO() public {
        _activatedMirrorWithDeficit(6e18);
        _seedDiamond(20e18);
        bytes32 hA = _packetHash(keccak256("A"));
        bytes32 hB = _packetHash(keccak256("B"));
        _untyped(10e18, 64, keccak256("A"));
        _untyped(10e18, 65, keccak256("B"));
        _evidence(hA, 10e18);
        _evidence(hB, 10e18);
        _classify(hA, 10e18, 0, keccak256("e-A")); // absorbed 6, live 4: the deficit is now covered
        _classify(hB, 10e18, 0, keccak256("e-B")); // all live
        assertEq(_spentOf(1).freshAbsorbed, 0);
        (uint256 fr, , , , , ) = _queue();
        assertEq(fr, 0, "the frontier at A; B behind it");
        _admin().pause();
        _custody().releaseRestitutionAsPaidCorrection(4e18, keccak256("pc-4"));
        _admin().unpause();
        assertEq(_spentOf(0).freshAbsorbed, 2e18, "A's record released first");
        assertEq(_spentOf(0).freshUnspent, 8e18);
        assertEq(_spentOf(1).freshAbsorbed, 0);
        (uint256 fa, , , , , , , ) = _records(0);
        assertEq(fa, 8e18, "A's released part re-entered A's own record, at A's position");
        assertEq(_spentOf(1).freshUnspent, 10e18);
    }

    /// Codex #2206 r3 (P2) — released by the OTHER disposition: the treasury
    /// release pays the deficit with the restitution custody, so what the
    /// row no longer holds re-enters the queue as SPENT (the live row did
    /// not grow), and a correction moves it as the inherited debit.
    function test_Reclassify_ReleasedAbsorptionReadsSpent_WhenTheDeficitWasPaid() public {
        _activatedMirrorWithDeficit(6e18);
        _seedDiamond(10e18);
        bytes32 h = _packetHash(keccak256("legacy-tr"));
        _untyped(10e18, 66, keccak256("legacy-tr"));
        _evidence(h, 10e18);
        _classify(h, 10e18, 0, keccak256("e-tr"));
        _admin().setTreasury(makeAddr("treasury"));
        _admin().pause();
        _custody().releaseRestitutionToTreasury(6e18, keccak256("tr-6"));
        _admin().unpause();
        assertEq(_row(LibVaipakam.RewardCustodyRow.Restitution), 0);
        assertEq(_live(), 4e18, "the live row did not grow");
        (uint256 received0, uint256 paid0) = _ledger();
        assertEq(paid0, 6e18, "paid retained: a genuine deficit");
        RewardReconciliationFacet.Spent memory sp = _spentOf(0);
        assertEq(sp.freshAbsorbed, 0, "nothing held");
        assertEq(sp.freshSpent, 6e18, "the released part reads spent: the live row does not back it");
        assertEq(sp.freshUnspent, 4e18);
        _reclassify(0, true, 10e18, keccak256("r-tr"));
        (uint256 received1, uint256 paid1) = _ledger();
        assertEq(received0 - received1, 10e18);
        assertEq(paid0 - paid1, 6e18, "the debit moved: the payment happened, on the other side's account");
        assertEq(_bucket(), 4e18, "the unspent part with its tokens");
        assertEq(_paidOutRecycled(), 6e18, "the spent part as inherited consumption");
        assertEq(_spentOf(0).freshAbsorbed, 0);
    }

    /// A packet-backed entry's correction moves the packet's component
    /// counters with it, and the evidence stands: after ten fresh corrected
    /// to recycled, the remainder can still classify fresh up to the
    /// authenticated ten — cumulatively, so lifting the first entry back is
    /// then refused.
    function test_Reclassify_MovesThePacketsCounters_TheEvidenceStands() public {
        _activatedMirror();
        _seedDiamond(20e18);
        bytes32 id = keccak256("legacy-counters");
        _untyped(20e18, 67, id);
        bytes32 h = _packetHash(id);
        _evidence(h, 10e18);
        _classify(h, 10e18, 0, keccak256("e-cm"));
        _reclassify(0, true, 10e18, keccak256("r-cm"));
        (, , uint256 cf, uint256 cr, ) = _packet(h);
        assertEq(cf, 0, "the fresh counter followed");
        assertEq(cr, 10e18, "into the recycled counter");
        assertEq(_authenticated(h), 10e18, "the evidence is the evidence");
        _classify(h, 10e18, 0, keccak256("e-cm-2")); // the remainder, within the evidence
        (, uint256 unclassifiedAfter, uint256 cfAfter, uint256 crAfter, ) = _packet(h);
        assertEq(unclassifiedAfter, 0);
        assertEq(cfAfter, 10e18);
        assertEq(crAfter, 10e18);
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(ReconciliationFreshUnevidenced.selector, h, 11e18, 10e18));
        _recon().reclassifyReconciliationEntry(0, false, 1e18, keccak256("r-cm-2"));
        _admin().unpause();
    }

    /// Codex #2206 r1 (P1) — a reattribution is not absorption: on a chain
    /// whose stored cumulative is unseeded because its bucket is relocated
    /// custody only, moving credit into and out of the bucket leaves the
    /// reported cumulative exactly where it was.
    function test_Reclassify_DoesNotMoveTheReportedAbsorption() public {
        _activatedMirror();
        _seedDiamond(10e18);
        _untyped(10e18, 57, keccak256("legacy-abs"));
        _evidence(_packetHash(keccak256("legacy-abs")), 10e18);
        _classify(_packetHash(keccak256("legacy-abs")), 10e18, 0, keccak256("e-abs"));
        uint256 reported0 = _cfg().getRecycleCreditedCumulative();
        _reclassify(0, true, 6e18, keccak256("r-abs-in")); // unspent, with tokens: bucket 6
        assertEq(_bucket(), 6e18);
        assertEq(_cfg().getRecycleCreditedCumulative(), reported0, "nothing absorbed");
        _reclassify(0, false, 6e18, keccak256("r-abs-out"));
        assertEq(_cfg().getRecycleCreditedCumulative(), reported0, "still nothing");
    }

    /// The envelope: the inventory that arrived BEFORE the activation
    /// (Diamond-side, no stamp in the row) is imported whole and once — read
    /// on chain, relocated measured as RECYCLED (it has no evidence source),
    /// entered into the same log; its fresh side is bounded by what was
    /// replacement-funded, here nothing.
    function test_Envelope_ImportsPreStampInventory_Relocated() public {
        _becomeMirror();
        _seedDiamond(10e18);
        _untyped(10e18, 46, keccak256("pre")); // not activated: Diamond-side
        assertEq(_uncountedAggregate(), 10e18);
        activateRewardCustodyForTest(address(vpfi), 0);
        (uint256 net, uint256 raw, uint256 holderUncounted, uint256 diamondReserved, uint256 returned) =
            _recon().previewLegacyEnvelope();
        assertEq(net, 10e18, "the envelope");
        assertEq(raw, 10e18);
        assertEq(holderUncounted + diamondReserved + returned, 0);
        uint256 diamondBefore = vpfi.balanceOf(address(diamond));
        _admin().pause();
        _recon().importLegacyEnvelope(keccak256("snap-1"), 10e18, 0, 0, 0);
        _admin().unpause();
        assertEq(_live(), 0, "nothing fresh without replacement custody");
        assertEq(_recycledRow(), 10e18);
        assertEq(_bucket(), 10e18);
        assertEq(diamondBefore - vpfi.balanceOf(address(diamond)), 10e18, "relocated out of the Diamond");
        assertEq(_held(), 10e18, "into the holder");
        assertEq(_uncountedAggregate(), 0, "the aggregate emptied");
        (net, , , , ) = _recon().previewLegacyEnvelope();
        assertEq(net, 0);
        LibVaipakam.LegacyEnvelope memory env = _recon().getLegacyEnvelope(keccak256("snap-1"));
        assertGt(env.importedAt, 0);
        assertEq(env.netTotal, 10e18);
        assertEq(env.relocatedRecycled, 10e18);
        assertEq(env.replacedFresh, 0);
        LibVaipakam.ReconciliationEntry memory e = _entry(env.entryIndex);
        assertEq(e.key, keccak256("snap-1"));
        assertTrue(e.envelope);
        assertEq(e.freshCredit, 0);
        assertEq(e.recycledCredit, 10e18);
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(LegacyEnvelopeAlreadyImported.selector, keccak256("snap-1")));
        _recon().importLegacyEnvelope(keccak256("snap-1"), 0, 0, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(LegacyEnvelopeEmpty.selector, keccak256("snap-2")));
        _recon().importLegacyEnvelope(keccak256("snap-2"), 0, 0, 0, 0);
        // The envelope's error path is the same reclassification, under the
        // same evidence rule: nothing of it may be lifted to fresh.
        vm.expectRevert(
            abi.encodeWithSelector(ReconciliationFreshUnevidenced.selector, keccak256("snap-1"), 2e18, 0)
        );
        _recon().reclassifyReconciliationEntry(env.entryIndex, false, 2e18, keccak256("r-env"));
        _admin().unpause();
    }

    /// What the holder already holds of the aggregate (post-stamp
    /// remainders, protected at ingress) is not the envelope's.
    function test_Envelope_NetsWhatTheHolderAlreadyHolds() public {
        _activatedMirror();
        _seedDiamond(10e18);
        _untyped(10e18, 47, keccak256("post")); // activated: protected, in the row
        (uint256 net, uint256 raw, uint256 holderUncounted, , ) = _recon().previewLegacyEnvelope();
        assertEq(raw, 10e18);
        assertEq(holderUncounted, 10e18);
        assertEq(net, 0, "nothing pre-stamp");
    }

    /// Every unit of the envelope is resolved, exactly: relocated where the
    /// tokens are still here, replacement-funded (delta-checked from the
    /// caller) or written down where pre-holder outflows spent them. The
    /// replacement-funded fresh is the envelope's evidence: its fresh side
    /// can be corrected down and back up to it, never beyond.
    function test_Envelope_ReplacementAndWriteDown_ResolveExactly() public {
        _becomeMirror();
        _seedDiamond(10e18);
        _untyped(10e18, 48, keccak256("pre-2"));
        vm.prank(address(diamond));
        vpfi.transfer(address(0xdead), 10e18); // a pre-holder outflow spent it
        activateRewardCustodyForTest(address(vpfi), 0);
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(LegacyEnvelopeMismatch.selector, keccak256("snap-3"), 9e18, 10e18));
        _recon().importLegacyEnvelope(keccak256("snap-3"), 0, 3e18, 2e18, 4e18);
        vpfi.mint(address(this), 5e18);
        vpfi.approve(address(diamond), 5e18);
        _recon().importLegacyEnvelope(keccak256("snap-3"), 0, 3e18, 2e18, 5e18);
        _admin().unpause();
        assertEq(_held(), 5e18, "the replacement was pulled into the holder");
        assertEq(_live(), 3e18);
        assertEq(_recycledRow(), 2e18);
        assertEq(_bucket(), 2e18);
        assertEq(_uncountedAggregate(), 0, "the written-down part left the aggregate too");
        LibVaipakam.LegacyEnvelope memory env = _recon().getLegacyEnvelope(keccak256("snap-3"));
        assertEq(env.replacedFresh, 3e18);
        assertEq(env.replacedRecycled, 2e18);
        assertEq(env.writtenDown, 5e18);
        _reclassify(env.entryIndex, true, 2e18, keccak256("r-env-down"));
        assertEq(_live(), 1e18);
        assertEq(_bucket(), 4e18);
        _reclassify(env.entryIndex, false, 2e18, keccak256("r-env-up")); // back up to what was funded
        assertEq(_live(), 3e18);
        _admin().pause();
        vm.expectRevert(
            abi.encodeWithSelector(ReconciliationFreshUnevidenced.selector, keccak256("snap-3"), 4e18, 3e18)
        );
        _recon().reclassifyReconciliationEntry(env.entryIndex, false, 1e18, keccak256("r-env-over"));
        _admin().unpause();
    }

    /// Codex #2206 r4 (P1) — spent-ness is RECORDED, never read from the
    /// balance: a later fresh credit backs its own place in the pool and
    /// un-spends nothing. A classified fresh and paid out whole; an
    /// unrelated delivery credits the live row after — A still reads spent,
    /// and correcting A moves its debit, never the later credit's tokens.
    function test_Reclassify_ALaterCreditDoesNotUnspendAnEarlierEntry() public {
        _activatedMirror();
        (, uint256 expected) = _seedPayable(alice);
        _seedDiamond(expected);
        bytes32 h = _packetHash(keccak256("legacy-later"));
        _untyped(expected, 70, keccak256("legacy-later"));
        _evidence(h, expected);
        _classify(h, expected, 0, keccak256("e-later"));
        vm.prank(alice);
        (uint256 claimed, , ) = _claim().claimInteractionRewards();
        assertGt(claimed, 0, "paid out");
        uint256 dust = expected - claimed; // the claim rounds a few wei below the quote
        assertEq(_live(), dust);
        _seedDiamond(10e18);
        _deliverStamped(10e18, 10e18, 0, 71, keccak256("D-later")); // an unrelated later credit, counted
        assertEq(_live(), 10e18 + dust);
        RewardReconciliationFacet.Spent memory sp = _spentOf(0);
        assertEq(sp.freshSpent, claimed, "still spent: the record does not read the balance");
        assertEq(sp.freshUnspent, dust);
        assertEq(sp.freshInheritable, claimed, "and it was paid");
        (, , uint256 freshSpent, uint256 freshPaid, , ) = _queue();
        assertEq(freshSpent, claimed);
        assertEq(freshPaid, claimed);
        (uint256 received0, uint256 paid0) = _ledger();
        _reclassify(0, true, expected, keccak256("r-later"));
        (uint256 received1, uint256 paid1) = _ledger();
        assertEq(received0 - received1, expected, "the whole credit left");
        assertEq(paid0 - paid1, claimed, "the debit moved");
        assertEq(_live(), 10e18, "the later credit stays where it is");
        assertEq(_bucket(), dust, "only the dust moved as tokens");
        assertEq(_paidOutRecycled(), claimed, "inherited as recycled consumption");
        (, , freshSpent, freshPaid, , ) = _queue();
        assertEq(freshSpent + freshPaid, 0, "the records left with the units they described");
    }

    /// Codex #2206 r4 (P1) — a refill is consumed ONCE: A classified 10
    /// recycled and consumed whole; a fee of 10 refills the bucket and is
    /// consumed too — A stays spent (no un-spend) and the consumption
    /// record stays at 10 (no recount), so nothing stale is left for a
    /// later entry whose credit leaves by repatriation.
    function test_Reclassify_ARefillIsConsumedOnce_AndUnspendsNothing() public {
        _activatedMirror();
        _seedDiamond(20e18);
        bytes32 hA = _packetHash(keccak256("A"));
        _untyped(10e18, 72, keccak256("A"));
        _evidence(hA, 10e18);
        _classify(hA, 0, 10e18, keccak256("e-A"));
        _mut().consumeRecycleRaw(10e18);
        RewardReconciliationFacet.Spent memory sp = _spentOf(0);
        assertEq(sp.recycledSpent, 10e18);
        assertEq(sp.recycledInheritable, 10e18);
        _feeInflow(10e18);
        sp = _spentOf(0);
        assertEq(sp.recycledSpent, 10e18, "a refill un-spends nothing");
        assertEq(sp.recycledUnspent, 0);
        _mut().consumeRecycleRaw(10e18); // the refill consumed: other backing, nothing classified left
        (, , uint256 recycledSpent, uint256 consumed, ) = _rqueue();
        assertEq(consumed, 10e18, "consumed once, not twice");
        assertEq(recycledSpent, 10e18);
        _reclassify(0, false, 10e18, keccak256("r-A")); // A whole to fresh: 10 of inherited consumption
        (, , recycledSpent, consumed, ) = _rqueue();
        assertEq(consumed, 0, "the record left with the units it described");
        assertEq(recycledSpent, 0);
        bytes32 hB = _packetHash(keccak256("B"));
        _untyped(10e18, 73, keccak256("B"));
        _evidence(hB, 10e18);
        _classify(hB, 0, 10e18, keccak256("e-B"));
        _mut().debitRepatriationSurplusRaw(10e18);
        sp = _spentOf(1);
        assertEq(sp.recycledSpent, 10e18);
        assertEq(sp.recycledInheritable, 0, "nothing stale to inherit");
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(ReconciliationSpentRecycledNotInheritable.selector, 1, 10e18, 0));
        _recon().reclassifyReconciliationEntry(1, false, 10e18, keccak256("r-B"));
        _admin().unpause();
    }

    /// Codex #2206 r4 (P2) — a released record stays released: A's absorbed
    /// 6 paid to the treasury; a new deficit and an unrelated fresh credit
    /// put 6 back into restitution — A's record is still released and still
    /// spent, and the paid-correction that later moves that restitution to
    /// live releases nothing of A (it was never A's).
    function test_Reclassify_AReleasedRecordStaysReleased_WhenRestitutionRefills() public {
        _activatedMirrorWithDeficit(6e18);
        _seedDiamond(10e18);
        bytes32 h = _packetHash(keccak256("legacy-refill"));
        _untyped(10e18, 74, keccak256("legacy-refill"));
        _evidence(h, 10e18);
        _classify(h, 10e18, 0, keccak256("e-refill"));
        _admin().setTreasury(makeAddr("treasury"));
        _admin().pause();
        _custody().releaseRestitutionToTreasury(6e18, keccak256("tr"));
        _admin().unpause();
        assertEq(_spentOf(0).freshAbsorbed, 0, "released");
        assertEq(_spentOf(0).freshSpent, 6e18, "and spent");
        // A new deficit, then an unrelated counted delivery the split sends
        // to restitution whole.
        (uint256 received, ) = _ledger();
        _mut().setArmedFreshLedgerRaw(received, received + 6e18);
        _seedDiamond(6e18);
        _deliverStamped(6e18, 6e18, 0, 75, keccak256("D-refill"));
        assertEq(_row(LibVaipakam.RewardCustodyRow.Restitution), 6e18, "the row refilled by another credit");
        RewardReconciliationFacet.Spent memory sp = _spentOf(0);
        assertEq(sp.freshAbsorbed, 0, "the released record is not re-absorbed");
        assertEq(sp.freshSpent, 6e18, "and still spent");
        assertEq(sp.freshUnspent, 4e18);
        (, , uint256 releasedTotal, ) = _aqueue();
        assertEq(releasedTotal, 6e18);
        _admin().pause();
        _custody().releaseRestitutionAsPaidCorrection(6e18, keccak256("pc")); // the other credit's custody
        _admin().unpause();
        assertEq(_live(), 10e18);
        sp = _spentOf(0);
        assertEq(sp.freshSpent, 6e18, "the later inflow un-spends nothing");
        assertEq(sp.freshUnspent, 4e18);
        (, , releasedTotal, ) = _aqueue();
        assertEq(releasedTotal, 6e18, "nothing more released of the records");
    }

    /// Codex #2206 r4 (P2) — the packet view says whether the hash is
    /// recorded: an unrecorded hash reads `arrivedAt == 0`, never as a
    /// recorded packet with nothing to reconcile.
    function test_View_AnUnrecordedHashReadsUnrecorded() public {
        _activatedMirror();
        _seedDiamond(10e18);
        _untyped(10e18, 76, keccak256("legacy-view"));
        (uint64 arrivedAt, uint256 protectedIn, , , , , ) =
            _recon().getPacketReconciliation(_packetHash(keccak256("legacy-view")));
        assertGt(arrivedAt, 0, "recorded");
        assertEq(protectedIn, 10e18);
        (arrivedAt, protectedIn, , , , , ) = _recon().getPacketReconciliation(keccak256("nope"));
        assertEq(arrivedAt, 0, "unrecorded");
        assertEq(protectedIn, 0);
    }

    /// Codex #2206 r5 (P2) — consumption is attributed to the entry it was
    /// taken from, not to the earliest spent entry: A's credit leaves by
    /// repatriation, B's is consumed — A stays uninheritable, B is
    /// inheritable, because each outflow wrote its kind into the segments
    /// it took from.
    function test_Reclassify_ConsumptionIsAttributedToTheEntryConsumed() public {
        _activatedMirror();
        _seedDiamond(20e18);
        bytes32 hA = _packetHash(keccak256("A"));
        bytes32 hB = _packetHash(keccak256("B"));
        _untyped(10e18, 77, keccak256("A"));
        _evidence(hA, 10e18);
        _classify(hA, 0, 10e18, keccak256("e-A"));
        _mut().debitRepatriationSurplusRaw(10e18); // A's credit leaves for Base
        _untyped(10e18, 78, keccak256("B"));
        _evidence(hB, 10e18);
        _classify(hB, 0, 10e18, keccak256("e-B"));
        _mut().consumeRecycleRaw(10e18); // B's credit is consumed
        RewardReconciliationFacet.Spent memory a = _spentOf(0);
        RewardReconciliationFacet.Spent memory b = _spentOf(1);
        assertEq(a.recycledSpent, 10e18);
        assertEq(a.recycledInheritable, 0, "A left by repatriation");
        assertEq(b.recycledSpent, 10e18);
        assertEq(b.recycledInheritable, 10e18, "B was consumed");
        (, , uint256 spentR, uint256 consumed, ) = _rqueue();
        assertEq(spentR, 20e18);
        assertEq(consumed, 10e18);
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(ReconciliationSpentRecycledNotInheritable.selector, 0, 10e18, 0));
        _recon().reclassifyReconciliationEntry(0, false, 10e18, keccak256("r-A"));
        _admin().unpause();
        (uint256 received0, uint256 paid0) = _ledger();
        _reclassify(1, false, 10e18, keccak256("r-B"));
        (uint256 received1, uint256 paid1) = _ledger();
        assertEq(received1 - received0, 10e18);
        assertEq(paid1 - paid0, 10e18, "B's consumption inherited as a fresh debit");
        assertEq(_paidOutRecycled(), 0, "given back");
    }

    /// Codex #2206 r5 (P2) — a released remit reverses exactly its OWN take
    /// of the classified queue: R1 consumed A's 10, a fee refilled the
    /// bucket, R2 consumed that other backing (its take is zero) — releasing
    /// R2 changes nothing of A; releasing R1 makes A uninheritable. With two
    /// classified remits, releasing the first leaves the second's entry
    /// inheritable.
    function test_Reclassify_AReleasedRemitReversesOnlyItsOwnTake() public {
        _activatedMirror();
        _seedDiamond(30e18);
        bytes32 hA = _packetHash(keccak256("A"));
        _untyped(10e18, 79, keccak256("A"));
        _evidence(hA, 10e18);
        _classify(hA, 0, 10e18, keccak256("e-A"));
        uint256 took1 = _mut().consumeRecycleRawAsRemit(10e18, 911); // R1: A's 10
        assertEq(took1, 10e18);
        _feeInflow(10e18);
        uint256 took2 = _mut().consumeRecycleRawAsRemit(10e18, 912); // R2: the other backing
        assertEq(took2, 0, "R2 took nothing of the classified queue");
        _mut().restoreReleasedRemitRaw(10e18, 10e18, 912); // R2 released
        _mut().setOutstandingCommitRaw(0, 0);
        assertEq(_spentOf(0).recycledInheritable, 10e18, "A untouched: R2's payout was not A's");
        _mut().restoreReleasedRemitRaw(10e18, 10e18, 911); // R1 released
        _mut().setOutstandingCommitRaw(0, 0);
        RewardReconciliationFacet.Spent memory a = _spentOf(0);
        assertEq(a.recycledSpent, 10e18, "still spent");
        assertEq(a.recycledInheritable, 0, "R1's payout never happened");
        // Two classified remits: releasing the first leaves the second's entry alone.
        bytes32 hB = _packetHash(keccak256("B"));
        bytes32 hC = _packetHash(keccak256("C"));
        _untyped(10e18, 80, keccak256("B"));
        _untyped(10e18, 81, keccak256("C"));
        _evidence(hB, 10e18);
        _evidence(hC, 10e18);
        _classify(hB, 0, 10e18, keccak256("e-B"));
        _classify(hC, 0, 10e18, keccak256("e-C"));
        uint256 took3 = _mut().consumeRecycleRawAsRemit(10e18, 913); // R3: B
        uint256 took4 = _mut().consumeRecycleRawAsRemit(10e18, 914); // R4: C
        assertEq(took3 + took4, 20e18);
        _mut().restoreReleasedRemitRaw(10e18, 10e18, 913); // R3 released
        _mut().setOutstandingCommitRaw(0, 0);
        assertEq(_spentOf(1).recycledInheritable, 0, "B: its remit's payout never happened");
        assertEq(_spentOf(2).recycledInheritable, 10e18, "C: its remit stands");
    }

    /// Codex #2206 r6 (P1) — a released remit whose consumption a correction
    /// had already moved to the fresh ledger reverses nothing of another
    /// remit's units: R1 consumed A; A was lifted to fresh (the debit
    /// inherited, the bucket's payout figure given back); B was consumed by
    /// R2. Releasing R1 finds nothing in [A, A], strands the inherited part
    /// on the fresh ledger (`received` and `paid` fall together, no
    /// headroom), leaves the bucket's payout figure — R2's — alone, and B
    /// stays inheritable.
    function test_Reclassify_AReleasedRemitStrandsItsInheritedPartOnFresh() public {
        _activatedMirror();
        _seedDiamond(20e18);
        bytes32 hA = _packetHash(keccak256("A"));
        bytes32 hB = _packetHash(keccak256("B"));
        _untyped(10e18, 82, keccak256("A"));
        _evidence(hA, 10e18);
        _classify(hA, 0, 10e18, keccak256("e-A"));
        uint256 took1 = _mut().consumeRecycleRawAsRemit(10e18, 921); // R1: A's 10
        assertEq(took1, 10e18);
        _reclassify(0, false, 10e18, keccak256("r-A")); // A lifted to fresh: 10 inherited
        assertEq(_spentOf(0).freshInheritable, 10e18, "on A's fresh record, charged");
        assertEq(_paidOutRecycled(), 0, "the bucket's payout figure gave R1's payout back");
        (uint256 received0, uint256 paid0) = _ledger();
        _untyped(10e18, 83, keccak256("B"));
        _evidence(hB, 10e18);
        _classify(hB, 0, 10e18, keccak256("e-B"));
        _mut().consumeRecycleRawAsRemit(10e18, 922); // R2: B's 10
        assertEq(_paidOutRecycled(), 10e18, "R2's payout");
        _mut().restoreReleasedRemitRaw(10e18, 10e18, 921); // R1 released
        _mut().setOutstandingCommitRaw(0, 0);
        assertEq(_spentOf(1).recycledInheritable, 10e18, "B untouched: its consumption is R2's");
        assertEq(_paidOutRecycled(), 10e18, "R2's payout figure untouched: R1's was given back already");
        (uint256 received1, uint256 paid1) = _ledger();
        assertEq(received0 - received1, 10e18, "stranded on the fresh side: received fell");
        assertEq(paid0 - paid1, 10e18, "and paid with it: no headroom created");
        (, , , , , , , , , , uint256 stranded) = _recon().getFreshQueueState(0);
        assertEq(stranded, 10e18, "recorded");
        assertEq(_spentOf(0).freshSpent, 10e18, "A's inherited debit stands on its fresh record, spent");
        assertEq(_spentOf(0).freshInheritable, 0, "but no longer charged: the payout never happened");
        (, , , uint256 freshPaid, , ) = _queue();
        assertEq(freshPaid, 0, "the fresh paid figure fell with it");
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(ReconciliationSpentFreshNotInheritable.selector, 0, 10e18, 0));
        _recon().reclassifyReconciliationEntry(0, true, 10e18, keccak256("r-A-back"));
        _admin().unpause();
    }

    /// Codex #2206 r6 (P1) — what an armed day reserved stays in the live
    /// row for its claims: the unspent fresh credit a correction may move
    /// with its tokens is bounded by the live row net of the outstanding
    /// fresh commitments, the twin of the uncommitted-bucket bound.
    function test_Reclassify_UnspentFreshIsBoundedByTheUncommittedLive() public {
        _activatedMirror();
        _seedDiamond(10e18);
        bytes32 h = _packetHash(keccak256("legacy-commit"));
        _untyped(10e18, 84, keccak256("legacy-commit"));
        _evidence(h, 10e18);
        _classify(h, 10e18, 0, keccak256("e-commit"));
        _mut().setOutstandingCommitRaw(4e18, 0); // an armed day's fresh commitment
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(ReconciliationExceedsUncommittedLive.selector, 7e18, 6e18));
        _recon().reclassifyReconciliationEntry(0, true, 7e18, keccak256("r-commit-7"));
        _admin().unpause();
        _reclassify(0, true, 6e18, keccak256("r-commit-6"));
        assertEq(_live(), 4e18, "the commitment's backing stays");
        assertEq(_bucket(), 6e18);
    }

    /// Codex #2206 r6 (P1) — credit a correction moves keeps its ORIGINAL
    /// order: A (index 0) classified fresh, B (index 1) classified recycled,
    /// A corrected to recycled before any outflow — the next consumption
    /// takes A first, not B, because A re-entered the recycled queue at its
    /// own position and the frontier moved back to it.
    function test_Reclassify_MovedCreditKeepsItsOriginalOrder() public {
        _activatedMirror();
        _seedDiamond(20e18);
        bytes32 hA = _packetHash(keccak256("A"));
        bytes32 hB = _packetHash(keccak256("B"));
        _untyped(10e18, 85, keccak256("A"));
        _untyped(10e18, 86, keccak256("B"));
        _evidence(hA, 10e18);
        _classify(hA, 10e18, 0, keccak256("e-A")); // index 0, fresh
        _classify(hB, 0, 10e18, keccak256("e-B")); // index 1, recycled
        (uint256 rf, , , , ) = _rqueue();
        assertEq(rf, 0, "the recycled frontier starts at the first index");
        _mut().consumeRecycleRaw(0);
        _reclassify(0, true, 10e18, keccak256("r-A")); // A to recycled, unspent, at index 0
        (rf, , , , ) = _rqueue();
        assertEq(rf, 0, "the frontier is at A");
        _mut().consumeRecycleRaw(10e18);
        assertEq(_spentOf(0).recycledSpent, 10e18, "A, first in classification order, was consumed");
        assertEq(_spentOf(1).recycledSpent, 0, "B untouched");
        assertEq(_spentOf(1).recycledUnspent, 10e18);
    }

    /// Codex #2206 r6 (P1) — a hot outflow's walk is bounded: forty entries
    /// classified recycled and lifted to fresh leave forty exhausted records
    /// ahead of the frontier; a claim-like consumption writes what it can
    /// within the bound and leaves the rest pending — the totals exact at
    /// once, no payout ever wedged — a correction waits for the queue,
    /// anyone may advance it, and an operator path drains it as part of its
    /// own take. A side that does not exist is refused.
    function test_Reclassify_AHotOutflowWalksABoundedNumberOfEntries() public {
        _activatedMirror();
        _seedDiamond(60e18);
        for (uint256 i = 0; i < 40; ++i) {
            bytes32 id = keccak256(abi.encode("bulk", i));
            _untyped(1e18, 100 + i, id);
            _evidence(_packetHash(id), 1e18);
            _classify(_packetHash(id), 0, 1e18, keccak256(abi.encode("e-bulk", i)));
            _reclassify(i, false, 1e18, keccak256(abi.encode("r-bulk", i))); // lifted whole: the record exhausted
        }
        bytes32 hLast = _packetHash(keccak256("last"));
        _untyped(10e18, 200, keccak256("last"));
        _evidence(hLast, 10e18);
        _classify(hLast, 0, 10e18, keccak256("e-last")); // index 40
        (uint256 rf, uint256 unspent0, , , ) = _rqueue();
        assertEq(rf, 0, "the frontier still at the first, exhausted record");
        assertEq(unspent0, 10e18);
        _mut().consumeRecycleRawBounded(5e18); // a claim: bounded walk
        uint256 unspent1;
        uint256 spent1;
        uint256 pending;
        (rf, unspent1, spent1, , pending) = _rqueue();
        assertEq(unspent1, 5e18, "the totals are exact at once");
        assertEq(spent1, 5e18);
        assertGt(pending, 0, "the walk stopped within its bound: the take is pending");
        assertLt(rf, 40, "the frontier advanced, but not to the last entry yet");
        assertEq(_spentOf(40).recycledSpent, 0, "the record lags the totals by the pending take");
        _admin().pause();
        vm.expectRevert(abi.encodeWithSelector(ReconciliationQueueBehind.selector, uint8(1)));
        _recon().reclassifyReconciliationEntry(40, false, 1e18, keccak256("r-behind"));
        vm.expectRevert(abi.encodeWithSelector(ReconciliationUnknownSide.selector, uint8(2)));
        _recon().advanceReconciliationQueue(2, 1);
        _admin().unpause();
        vm.prank(alice);
        _recon().advanceReconciliationQueue(1, 100); // anyone may drain it
        (rf, , , , pending) = _rqueue();
        assertEq(pending, 0, "drained");
        assertEq(rf, 40);
        assertEq(_spentOf(40).recycledSpent, 5e18, "the take landed on the entry it was for");
        _mut().consumeRecycleRawBounded(1e18); // frontier at a live record: written at once
        (, , , , pending) = _rqueue();
        assertEq(pending, 0);
        // An operator path drains a backlog as part of its own take.
        _reclassify(40, false, 4e18, keccak256("r-last")); // 4 unspent to fresh
        _reclassify(40, true, 4e18, keccak256("r-last-back")); // and back, at index 40
        (, , , , pending) = _rqueue();
        assertEq(pending, 0);
        uint256 took = _mut().consumeRecycleRaw(2e18);
        assertEq(took, 2e18);
    }

    /// Codex #2206 r7 (P1) — a remit's reversal touches exactly the records
    /// its own take wrote, and by exactly what it wrote there: a bounded
    /// claim leaves a charged take pending on entry 40; the remit drains it
    /// first (the claim's 5 land on entry 40), then writes its own 5 on
    /// entry 40 and 5 on entry 41. Releasing the remit lowers entry 40's
    /// charge by 5 — the claim's 5 stay inheritable — and entry 41's by 5.
    function test_Reclassify_ARemitsReversalTouchesOnlyItsOwnWrites() public {
        _activatedMirror();
        _seedDiamond(70e18);
        for (uint256 i = 0; i < 40; ++i) {
            bytes32 id = keccak256(abi.encode("bulk", i));
            _untyped(1e18, 300 + i, id);
            _evidence(_packetHash(id), 1e18);
            _classify(_packetHash(id), 0, 1e18, keccak256(abi.encode("e-bulk", i)));
            _reclassify(i, false, 1e18, keccak256(abi.encode("r-bulk", i)));
        }
        bytes32 h40 = _packetHash(keccak256("e40"));
        bytes32 h41 = _packetHash(keccak256("e41"));
        _untyped(10e18, 400, keccak256("e40"));
        _classify(h40, 0, 10e18, keccak256("e-40")); // index 40
        _mut().consumeRecycleRawBounded(5e18); // a claim: its take stays pending behind the exhausted forty
        (, , , , uint256 pending) = _rqueue();
        assertGt(pending, 0);
        _untyped(10e18, 401, keccak256("e41"));
        _classify(h41, 0, 10e18, keccak256("e-41")); // index 41
        uint256 took = _mut().consumeRecycleRawAsRemit(10e18, 931); // the remit: drains the claim's take, then writes its own
        assertEq(took, 10e18);
        (, , , , pending) = _rqueue();
        assertEq(pending, 0);
        assertEq(_spentOf(40).recycledInheritable, 10e18, "entry 40: the claim's 5 and the remit's 5");
        assertEq(_spentOf(41).recycledInheritable, 5e18, "entry 41: the remit's 5");
        _mut().restoreReleasedRemitRaw(10e18, 10e18, 931); // the remit released
        _mut().setOutstandingCommitRaw(0, 0);
        assertEq(_spentOf(40).recycledInheritable, 5e18, "entry 40 keeps the claim's 5");
        assertEq(_spentOf(41).recycledInheritable, 0, "entry 41's 5 were the remit's");
        assertEq(_spentOf(40).recycledSpent + _spentOf(41).recycledSpent, 15e18, "all still spent");
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
    /// portion first, then the restitution portion (Codex #2186 r1 P1) —
    /// and since closure 2's cutover PR 1 it does so IN-HOLDER: the
    /// remainder is re-attributed into `Unclassified`, where the stranded
    /// record and the reservation now describe it; nothing is released to
    /// the Diamond, and only what was already paid out stays out.
    function test_UncreditFresh_MovesLiveThenRestitution_IntoUnclassified() public {
        _becomeMirror();
        _admin().pause();
        _custody().bindRewardCustodyHolder();
        uint64 epoch = _epoch();
        _custody().rebaseArmedFreshPaid(6e18, epoch); // deficit 6
        _custody().activateRewardCustody(epoch, false);
        _admin().unpause();
        fundRewardPoolForTest(address(vpfi), 10e18); // restitution 6, live 4
        uint256 diamondBefore = vpfi.balanceOf(address(diamond));
        uint256 holderBefore = _held();
        bytes32 key = keccak256(abi.encode(REMITTER, uint256(99)));

        vm.prank(address(diamond)); // the Diamond-internal entry, as the demotion reaches it
        _custody().custodyUnclassifiedQuarantine(bytes32(0), key, 0, 9e18);
        assertEq(_live(), 0, "live gave back all 4");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Restitution), 1e18, "restitution gave back 5 of 6");
        assertEq(_unclassified(), 9e18, "the whole unwound credit is re-attributed into Unclassified");
        assertEq(vpfi.balanceOf(address(diamond)), diamondBefore, "nothing was released to the Diamond");
        assertEq(_held(), holderBefore, "the holder's balance did not move");
        assertEq(_rlens().getStrandedRecovery(REMITTER, 99).held, 9e18, "the record knows the holder backs it");
        (uint256 uncountedHeld, , uint256 reservedHeld) = _rlens().getUnclassifiedPosition();
        assertEq(uncountedHeld, 9e18);
        assertEq(reservedHeld, 9e18);
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
