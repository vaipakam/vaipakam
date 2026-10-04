// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {RewardEraFacet} from "../src/facets/RewardEraFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardReconciliationFacet} from "../src/facets/RewardReconciliationFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {RewardClosureFacet} from "../src/facets/RewardClosureFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../src/libraries/LibInteractionRewards.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/// @title RewardCustodyEraTest — slice 4 PR C-1 (#1566): the custody era
///        registry and the carry-forward at a role change.
/// @notice A role change on an activated custody retires the live era (the
///         live-fresh row moves into the era's holder row, the baseline is
///         levelled, a deficit is carried as the opening deficit) and opens the
///         next; the era rows stay attributed; the two writers that move value
///         out of a retired era are dark until the backfill and then release
///         under the deficit split — to the live baseline on an active role,
///         into PENDING SURPLUS while Detached, drained once reattached.
contract RewardCustodyEraTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    uint256 internal launch;
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;

    event CustodyEraRetired(uint64 indexed era, uint256 carried, uint256 openingDeficit, uint64 boundaryDay);
    event CustodyEraOpened(uint64 indexed era, uint64 boundaryDay);

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
        launch = block.timestamp;
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(launch);
        vm.warp(block.timestamp + 5 days);
        _becomeMirror();
    }

    // ─── accessors ───
    function _custody() internal view returns (RewardCustodyFacet) { return RewardCustodyFacet(address(diamond)); }
    function _era() internal view returns (RewardEraFacet) { return RewardEraFacet(address(diamond)); }
    function _clo() internal view returns (RewardClosureFacet) { return RewardClosureFacet(address(diamond)); }
    /// @dev Era 0's span once a transition opened era 1: its boundary day.
    function _span0() internal view returns (uint256) { return _era().getCustodyEra(1).boundaryDay; }
    /// @dev Stand era 0 as liability-free: every day of its span proven closed (raw).
    function _closeEra0Days() internal { _mut().setCustodyEraCountersRaw(0, _span0(), 0); }
    function _rep() internal view returns (RewardReporterFacet) { return RewardReporterFacet(address(diamond)); }
    function _mut() internal view returns (TestMutatorFacet) { return TestMutatorFacet(address(diamond)); }
    function _row(LibVaipakam.RewardCustodyRow r) internal view returns (uint256) { return _custody().rewardCustodyRow(r); }
    function _live() internal view returns (uint256) { return _row(LibVaipakam.RewardCustodyRow.LiveFresh); }
    function _ledger() internal view returns (uint256 received, uint256 paid) { (received, paid) = _custody().armedFreshLedger(); }
    function _attributed() internal view returns (uint256 a) { (, , , , a) = _custody().rewardCustodySnapshot(); }
    function _held() internal view returns (uint256 h) { (, , , h, ) = _custody().rewardCustodySnapshot(); }

    function _becomeMirror() internal {
        vm.chainId(CHAIN_ARB);
        _rep().setIsCanonicalRewardChain(false);
        _rep().setBaseChainId(CHAIN_BASE);
        RewardRemittanceFacet(address(diamond)).setRewardRemittanceReceiver(address(this));
    }

    /// @dev Every custody credit re-arms the freeze (by design until PR C-5), so a
    ///      transition in a test lifts it raw first.
    function _detach() internal {
        _mut().setRewardRoleChangesFrozenRaw(false);
        _rep().setBaseChainId(0);
    }

    function _reattach() internal {
        _mut().setRewardRoleChangesFrozenRaw(false);
        _rep().setBaseChainId(CHAIN_BASE);
    }

    /// @dev The Diamond's reward day, computed as the library does from the launch
    ///      this fixture set (the library helper read from this contract would see
    ///      an empty storage and answer zero).
    function _today() internal view returns (uint64 d) {
        d = uint64((block.timestamp - launch) / 1 days);
    }

    // ─── cells ───

    /// @dev The carry-forward: the live row moves into the retiring era's row,
    ///      the headroom is levelled to zero, the attributed total is unchanged,
    ///      and the next era opens on today's day.
    function test_ARoleChange_RetiresTheLiveEra_AndCarriesTheLiveRow() public {
        activateRewardCustodyForTest(address(vpfi), 7e18);
        assertEq(_live(), 7e18, "fixture: live custody");
        uint256 attributedBefore = _attributed();
        uint256 heldBefore = _held();
        assertEq(_era().getCustodyEraCurrent(), 0, "the pre-registry era is live");

        // The expectation binds to the NEXT call: lift the freeze first, then
        // expect the two era events of the role change itself.
        _mut().setRewardRoleChangesFrozenRaw(false);
        vm.expectEmit(true, false, false, true, address(diamond));
        emit CustodyEraRetired(0, 7e18, 0, _today());
        vm.expectEmit(true, false, false, true, address(diamond));
        emit CustodyEraOpened(1, _today());
        _rep().setBaseChainId(0);

        assertEq(uint8(LibVaipakam.RewardRole.Detached), 3, "fixture: the role ordinal this suite assumes");
        assertEq(_era().getCustodyEraCurrent(), 1, "the next era is live");
        LibVaipakam.CustodyEra memory retired = _era().getCustodyEra(0);
        assertEq(retired.holderRow, 7e18, "the live custody was carried into era 0's row");
        assertFalse(retired.terminal, "retired is not terminal");
        LibVaipakam.CustodyEra memory opened = _era().getCustodyEra(1);
        assertEq(opened.boundaryDay, _today(), "era 1 opens today");
        assertEq(opened.openingDeficit, 0, "no deficit was owed");
        assertGt(opened.openedAt, 0);
        assertEq(_live(), 0, "the live row is empty");
        (uint256 received, uint256 paid) = _ledger();
        assertEq(received, 7e18, "received is not erased");
        assertEq(paid, 7e18, "paid is levelled: no headroom carries across");
        assertEq(_era().getCustodyEraRowsTotal(), 7e18, "the era rows total follows");
        assertEq(_attributed(), attributedBefore, "the attributed total is unchanged: an in-holder move");
        assertEq(_held(), heldBefore, "no tokens moved");
    }

    /// @dev A `paid > received` deficit is not erased by the change: the new era
    ///      opens owing it, and the first credit of the new era covers it first.
    function test_ADeficit_IsCarriedAsTheOpeningDeficit() public {
        activateRewardCustodyForTest(address(vpfi), 0);
        _mut().setArmedFreshLedgerRaw(0, 6e18); // paid 6, received 0: a 6 deficit, no live custody
        _detach();
        LibVaipakam.CustodyEra memory opened = _era().getCustodyEra(1);
        assertEq(opened.openingDeficit, 6e18, "the deficit is the new era's opening deficit");
        assertEq(_era().getCustodyEra(0).holderRow, 0, "nothing to carry");
        (uint256 received, uint256 paid) = _ledger();
        assertEq(paid - received, 6e18, "and it is still owed on the baseline");
        _reattach();
        fundRewardPoolForTest(address(vpfi), 10e18);
        assertEq(_row(LibVaipakam.RewardCustodyRow.Restitution), 6e18, "the first credit covers the deficit");
        assertEq(_live(), 4e18, "only the excess is headroom");
    }

    /// @dev Writer 2 is dark until the backfill; then a retired, obligation-free
    ///      era releases its row — into PENDING SURPLUS while Detached — and the
    ///      drain (writer 3) credits the live baseline under the split once
    ///      reattached.
    function test_Finalize_IsDarkUntilTheBackfill_ThenReleasesUnderTheSplit() public {
        activateRewardCustodyForTest(address(vpfi), 7e18);
        _detach();
        vm.expectRevert(CustodyEraBackfillPending.selector);
        _era().finalizeCustodyEra(0);
        _mut().setCustodyEraBackfillCompleteRaw(true);
        _closeEra0Days();
        vm.expectRevert(abi.encodeWithSelector(CustodyEraLive.selector, uint64(1)));
        _era().finalizeCustodyEra(1);
        vm.expectRevert(abi.encodeWithSelector(CustodyEraUnknown.selector, uint64(2)));
        _era().finalizeCustodyEra(2);

        uint256 attributedBefore = _attributed();
        (uint256 released, bool toPending) = _era().finalizeCustodyEra(0);
        assertEq(released, 7e18);
        assertTrue(toPending, "Detached: the surplus waits for an active era");
        assertEq(_row(LibVaipakam.RewardCustodyRow.PendingSurplus), 7e18);
        assertEq(_row(LibVaipakam.RewardCustodyRow.Recovery), 0, "never into recovery");
        assertEq(_era().getCustodyEra(0).holderRow, 0);
        assertEq(_era().getCustodyEraRowsTotal(), 0);
        assertTrue(_era().getCustodyEra(0).terminal);
        assertEq(_attributed(), attributedBefore, "an in-holder move");
        vm.expectRevert(abi.encodeWithSelector(CustodyEraAlreadyFinalized.selector, uint64(0)));
        _era().finalizeCustodyEra(0);

        vm.expectRevert(abi.encodeWithSelector(CustodyPendingSurplusNeedsActiveRole.selector, uint8(3)));
        _era().drainPendingSurplus(7e18);

        _reattach(); // era 2 opens; nothing carried (the live row is empty)
        assertEq(_era().getCustodyEraCurrent(), 2);
        (uint256 receivedBefore, uint256 paidBefore) = _ledger();
        assertEq(receivedBefore, paidBefore, "no deficit on the new baseline");
        _era().drainPendingSurplus(7e18);
        assertEq(_row(LibVaipakam.RewardCustodyRow.PendingSurplus), 0);
        assertEq(_live(), 7e18, "no deficit: the whole drain is headroom");
        (uint256 received, ) = _ledger();
        assertEq(received - receivedBefore, 7e18, "received rises with the credit");
        vm.expectRevert(abi.encodeWithSelector(RewardCustodyRowShort.selector, uint8(LibVaipakam.RewardCustodyRow.PendingSurplus), 1, 0));
        _era().drainPendingSurplus(1);
    }

    /// @dev An era with obligations standing (the counters PR C-3/C-5 will write)
    ///      is not terminal, by name.
    function test_Finalize_RefusesWhileObligationsStand() public {
        activateRewardCustodyForTest(address(vpfi), 1e18);
        _detach();
        _mut().setCustodyEraBackfillCompleteRaw(true);
        uint256 span = _span0();
        assertGt(span, 0, "fixture: era 0 spans the days before the change");
        _mut().setCustodyEraCountersRaw(0, span - 1, 0); // one day short of proven closed
        vm.expectRevert(abi.encodeWithSelector(CustodyEraNotTerminal.selector, uint64(0), span - 1, span, uint256(0)));
        _era().finalizeCustodyEra(0);
        _mut().setCustodyEraCountersRaw(0, span, 2); // every day closed, packets still open
        vm.expectRevert(abi.encodeWithSelector(CustodyEraNotTerminal.selector, uint64(0), span, span, uint256(2)));
        _era().finalizeCustodyEra(0);
        _mut().setCustodyEraCountersRaw(0, span, 0);
        (uint256 released, ) = _era().finalizeCustodyEra(0);
        assertEq(released, 1e18, "every day proven closed and nothing open: terminal");
    }

    /// @dev A finalized era on an ACTIVE role credits the live baseline under the
    ///      deficit split, not PENDING SURPLUS.
    function test_Finalize_OnAnActiveRole_CreditsTheBaselineUnderTheSplit() public {
        activateRewardCustodyForTest(address(vpfi), 5e18);
        _detach();
        _reattach();
        _mut().setArmedFreshLedgerRaw(0, 2e18); // a 2 deficit on the new baseline
        _mut().setCustodyEraBackfillCompleteRaw(true);
        _closeEra0Days();
        (uint256 released, bool toPending) = _era().finalizeCustodyEra(0);
        assertEq(released, 5e18);
        assertFalse(toPending, "active role: to the baseline");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Restitution), 2e18, "the deficit's cover first");
        assertEq(_live(), 3e18, "the excess is headroom");
        assertEq(_row(LibVaipakam.RewardCustodyRow.PendingSurplus), 0);
    }

    /// @dev The per-day closure proof is what counts an era's days closed: a day
    ///      with no obligation closes at the start of its walk, and the era the
    ///      day was live in gains one — a retired era's day counts into it still.
    function test_AClosureProof_CountsTheDayIntoItsEra() public {
        activateRewardCustodyForTest(address(vpfi), 1e18);
        MockRewardMessenger messenger = new MockRewardMessenger(address(diamond));
        _rep().setRewardMessenger(address(messenger));
        _rep().closeDay(1);
        (, , bool closed) = _clo().startDayClosure(1);
        assertTrue(closed, "no obligation on day 1: closes at start");
        assertEq(_era().getCustodyEra(0).daysClosed, 1, "era 0 has one day proven closed");
        // Retire era 0 and come back: a detached chain has no base to report a day
        // to, so the proof of a retired era's day runs once the chain is active
        // again. Day 2 still belongs to era 0 (era 1 opened and retired today).
        _detach();
        _reattach();
        _rep().closeDay(2);
        _clo().startDayClosure(2);
        assertEq(_era().getCustodyEra(0).daysClosed, 2, "a day of a RETIRED era counts into that era");
        assertEq(_era().getCustodyEra(1).daysClosed, 0, "the empty era between gained nothing");
    }

    /// @dev The known-era guard follows the registry.
    function test_KnownEra_FollowsTheRegistry() public {
        activateRewardCustodyForTest(address(vpfi), 1e18);
        RewardReconciliationFacet recon = RewardReconciliationFacet(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(ReconciliationUnknownEra.selector, uint64(1)));
        recon.getFreshQueueState(1);
        _detach();
        recon.getFreshQueueState(1); // known now
        vm.expectRevert(abi.encodeWithSelector(ReconciliationUnknownEra.selector, uint64(2)));
        recon.getFreshQueueState(2);
    }

    /// @dev Before activation the holder has no rows: the counters are levelled as
    ///      before and the registry is untouched, so the backfill finds every
    ///      pre-activation figure in era 0.
    function test_PreActivation_RoleChange_LevelsTheCountersAndTouchesNoRegistry() public {
        _mut().setArmedFreshLedgerRaw(3e18, 1e18);
        _rep().setBaseChainId(0);
        (uint256 received, uint256 paid) = _ledger();
        assertEq(received, 3e18);
        assertEq(paid, 3e18, "levelled as before");
        assertEq(_era().getCustodyEraCurrent(), 0, "no era opened");
        assertEq(_era().getCustodyEraRowsTotal(), 0);
    }
}
