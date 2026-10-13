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
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {RewardBroadcastV2} from "../src/interfaces/IRewardMessenger.sol";
import {RewardIngressFacet} from "../src/facets/RewardIngressFacet.sol";
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
import {LibPausable} from "../src/libraries/LibPausable.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
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
///         out of a retired era release it once the era is final — no manual
///         step — under the deficit split — to the live baseline on an active role,
///         into PENDING SURPLUS while Detached, drained once reattached.
contract RewardCustodyEraTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    uint256 internal launch;
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;

    event CustodyEraRetired(uint64 indexed era, uint256 carried, uint256 openingDeficit, uint64 boundaryDay);
    event CustodyEraOpened(uint64 indexed era, uint64 boundaryDay);
    event CustodyEraDrawn(uint64 indexed era, uint256 indexed dayId, uint256 amount);

    address internal alice;
    uint64 internal constant LOAN = 77;
    uint256 internal constant NEED = 0.4e18;

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
    function _rlens() internal view returns (RewardRemittanceLensFacet) { return RewardRemittanceLensFacet(address(diamond)); }
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

    /// @dev A role change needs no lift: with the carry-forward in place nothing
    ///      freezes it (#1566 PR C revision).
    function _detach() internal {
        _rep().setBaseChainId(0);
    }

    function _reattach() internal {
        _rep().setBaseChainId(CHAIN_BASE);
    }

    /// @dev The Diamond's reward day, computed as the library does from the launch
    ///      this fixture set (the library helper read from this contract would see
    ///      an empty storage and answer zero).
    function _today() internal view returns (uint64 d) {
        d = uint64((block.timestamp - launch) / 1 days);
    }

    // ─── PR C-2: the draw suite's armed-day scene, on day `d` ───
    function _armedDay(uint256 d, uint256 cap) internal {
        _mut().setDayPoolStampRaw(d, uint128(2e18), 0);
        _mut().setKnownGlobalDailyInterest(d, 1e18, 0, true);
        _mut().setDayCapThreshold18(d, type(uint256).max);
        _mut().setDayCapModeRaw(d, 1);
        _mut().setDayUserSideCapRaw(d, cap);
    }

    function _scene(uint256 d, uint256 cap) internal returns (uint256 id) {
        if (alice == address(0)) alice = makeAddr("era-alice");
        _armedDay(d, cap);
        _mut().setGovernorCommitArmedFromDayRaw(1);
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
                loanSideRewardCapOpen: type(uint128).max
            })
        );
        id = _mut().pushRewardEntry(alice, LOAN, LibVaipakam.RewardSide.Lender, 1e18, uint32(d));
        _mut().closeRewardEntryRaw(id, uint32(d + 1));
        _mut().userClaimFundingNeedRaw(alice);
    }

    function _claim() internal returns (uint256 paid) {
        vm.prank(alice);
        (paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewards();
    }

    /// @dev Activate with `fund` live, then retire the live era and come back: the
    ///      chain is a mirror again, era 0 holds `fund`, the live row is empty and
    ///      the baseline has no headroom.
    function _retireIntoEraZero(uint256 fund) internal {
        activateRewardCustodyForTest(address(vpfi), fund);
        _detach();
        _reattach();
        assertEq(_era().getCustodyEraCurrent(), 2, "fixture: two transitions");
        assertEq(_era().getCustodyEra(0).holderRow, fund, "fixture: era 0 holds the carry");
        assertEq(_live(), 0, "fixture: no live custody");
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

        // The expectation binds to the NEXT call: the two era events of the
        // role change itself.
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

    /// @dev #1566 PR C revision — writer 2 waits on the closure proof ALONE: before
    ///      every day of the span is proven closed it refuses by name; then the
    ///      retired era releases its row — into PENDING SURPLUS while Detached —
    ///      and the drain (writer 3) credits the live baseline under the split
    ///      once reattached. No backfill, no manual step.
    function test_Finalize_OnTheClosureProofAlone_ThenReleasesUnderTheSplit() public {
        activateRewardCustodyForTest(address(vpfi), 7e18);
        _detach();
        uint256 span = _span0();
        if (span != 0) {
            vm.expectRevert(abi.encodeWithSelector(CustodyEraNotTerminal.selector, uint64(0), uint256(0), span, uint256(0)));
            _era().finalizeCustodyEra(0);
        }
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
        (uint256 countedBefore, ) = _rlens().getDeliveredFreshPosition();
        _era().drainPendingSurplus(7e18);
        assertEq(_row(LibVaipakam.RewardCustodyRow.PendingSurplus), 0);
        assertEq(_live(), 7e18, "no deficit: the whole drain is headroom");
        (uint256 received, ) = _ledger();
        assertEq(received - receivedBefore, 7e18, "received rises with the credit");
        (uint256 countedAfter, ) = _rlens().getDeliveredFreshPosition();
        assertEq(countedAfter, countedBefore, "a re-credit is no delivery: the funding Base is reconciled against stands");
        vm.expectRevert(abi.encodeWithSelector(RewardCustodyRowShort.selector, uint8(LibVaipakam.RewardCustodyRow.PendingSurplus), 1, 0));
        _era().drainPendingSurplus(1);
    }

    /// @dev An era with a day of its span not yet proven closed is not final, by
    ///      name; once every day is, it is final — whatever its packets still hold
    ///      unclassified (#1566 PR C revision: a closed era owes nothing, and a
    ///      packet's later exit routes by the era rule).
    function test_Finalize_WaitsOnTheClosedDaysOnly() public {
        activateRewardCustodyForTest(address(vpfi), 1e18);
        _detach();
        uint256 span = _span0();
        assertGt(span, 0, "fixture: era 0 spans the days before the change");
        _mut().setCustodyEraCountersRaw(0, span - 1, 0); // one day short of proven closed
        vm.expectRevert(abi.encodeWithSelector(CustodyEraNotTerminal.selector, uint64(0), span - 1, span, uint256(0)));
        _era().finalizeCustodyEra(0);
        _mut().setCustodyEraCountersRaw(0, span, 2); // every day closed; the retired count says two packets open
        (uint256 released, ) = _era().finalizeCustodyEra(0);
        assertEq(released, 1e18, "every day proven closed: final, open packets or not");
    }

    /// @dev A finalized era on an ACTIVE role credits the live baseline under the
    ///      deficit split, not PENDING SURPLUS.
    function test_Finalize_OnAnActiveRole_CreditsTheBaselineUnderTheSplit() public {
        activateRewardCustodyForTest(address(vpfi), 5e18);
        _detach();
        _reattach();
        _mut().setArmedFreshLedgerRaw(0, 2e18); // a 2 deficit on the new baseline
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

    /// @dev #1566 PR 1 review (P3) — the day→era lookup is a binary search, so a registry deeper
    ///      than the old 64-step scan cap still resolves: an old day's closure counts into era 0.
    function test_ADeepRegistry_StillResolvesAnOldDaysEra() public {
        activateRewardCustodyForTest(address(vpfi), 1e18);
        MockRewardMessenger messenger = new MockRewardMessenger(address(diamond));
        _rep().setRewardMessenger(address(messenger));
        for (uint256 i; i < 35; ++i) {
            _detach();
            _reattach();
        }
        assertEq(_era().getCustodyEraCurrent(), 70, "fixture-live: deeper than the old scan cap");
        _rep().closeDay(1);
        (, , bool closed) = _clo().startDayClosure(1);
        assertTrue(closed, "no obligation on day 1: closes at start");
        assertEq(_era().getCustodyEra(0).daysClosed, 1, "the old day counts into era 0");
        assertEq(_era().getCustodyEra(70).daysClosed, 0);
    }

    /// @dev #1566 PR 1 review (P2-1) — the known-era guard stays at era 0 while the
    ///      reconciliation queues are keyed by it alone: a registry era opened by a role change is
    ///      real, but it has no queue, and answering it would pair an empty queue with the global rows.
    function test_KnownEra_StaysEraZero_UntilTheQueuesAreEraKeyed() public {
        activateRewardCustodyForTest(address(vpfi), 1e18);
        RewardReconciliationFacet recon = RewardReconciliationFacet(address(diamond));
        recon.getFreshQueueState(0);
        vm.expectRevert(abi.encodeWithSelector(ReconciliationUnknownEra.selector, uint64(1)));
        recon.getFreshQueueState(1);
        _detach();
        assertEq(_era().getCustodyEra(1).openedAt, block.timestamp, "fixture-live: the registry opened era 1");
        vm.expectRevert(abi.encodeWithSelector(ReconciliationUnknownEra.selector, uint64(1)));
        recon.getFreshQueueState(1); // a registry era, with no queue of its own
        recon.getFreshQueueState(0);
    }

    /// @dev Before activation the holder has no rows: the counters are levelled as
    ///      before and the registry is untouched, so every pre-activation figure
    ///      is era 0's.
    function test_PreActivation_RoleChange_LevelsTheCountersAndTouchesNoRegistry() public {
        _mut().setArmedFreshLedgerRaw(3e18, 1e18);
        _rep().setBaseChainId(0);
        (uint256 received, uint256 paid) = _ledger();
        assertEq(received, 3e18);
        assertEq(paid, 3e18, "levelled as before");
        assertEq(_era().getCustodyEraCurrent(), 0, "no era opened");
        assertEq(_era().getCustodyEraRowsTotal(), 0);
    }

    // ─── #1566 PR C revision — no manual era step; stamping; the B4 report; era routing ───
    address internal constant REMITTER_BF = address(0xBA5E);

    /// @dev An untyped delivery: its value lands unclassified under its packet.
    function _untypedDelivery(uint256 amount, uint256 remitId, bytes32 id) internal returns (bytes32 h) {
        h = _untypedDeliveryOn(amount, remitId, id, 1);
    }

    /// @dev An untyped delivery listing one day, `day` — which places it: a day
    ///      before the live era's boundary belongs to a retired era.
    function _untypedDeliveryOn(uint256 amount, uint256 remitId, bytes32 id, uint256 day)
        internal
        returns (bytes32 h)
    {
        uint256[] memory one = new uint256[](1);
        one[0] = day;
        RewardRemittanceFacet(address(diamond)).setRewardRemittanceReceiver(address(this));
        vpfi.mint(address(this), amount);
        vpfi.transfer(address(diamond), amount);
        RewardIngressFacet(address(diamond)).onRewardBudgetReceived(
            address(vpfi), amount, one, CHAIN_BASE, remitId, REMITTER_BF, 0, 0, id, false
        );
        h = keccak256(abi.encode(uint256(CHAIN_BASE), id));
    }

    /// @dev Custody activation freezes nothing: a role change right after it
    ///      carries the live row into era 0 and opens era 1.
    function test_AnActivation_FreezesNoRoleChange() public {
        activateRewardCustodyForTest(address(vpfi), 3e18);
        _rep().setBaseChainId(0);
        assertEq(_era().getCustodyEraCurrent(), 1, "the change went through");
        assertEq(_era().getCustodyEra(0).holderRow, 3e18, "and carried the live row");
    }

    /// @dev Every packet is stamped with the era live at its arrival.
    function test_APacket_IsStampedWithTheLiveEra() public {
        activateRewardCustodyForTest(address(vpfi), 0);
        bytes32 h0 = _untypedDelivery(1e18, 41, keccak256("st-0"));
        assertEq(_rlens().getIngressPacket(h0).custodyEra, 0);
        _detach();
        _reattach();
        // A day of the live era (its boundary is today): a delivery listing an
        // earlier day is placed by that day instead (the D6 suite pins that).
        bytes32 h2 = _untypedDeliveryOn(1e18, 42, keccak256("st-2"), _today());
        assertEq(_rlens().getIngressPacket(h2).custodyEra, 2, "the live era at its arrival");
        assertEq(_rlens().getIngressPacket(h0).custodyEra, 0, "an earlier packet keeps its own");
    }

    /// @dev The mirror's day report carries its live custody era (B4), and a
    ///      messenger without the B4 send downgrades the report to B3.
    function test_TheDayReport_CarriesTheLiveEra_AndDowngrades() public {
        activateRewardCustodyForTest(address(vpfi), 0);
        MockRewardMessenger messenger = new MockRewardMessenger(address(diamond));
        _rep().setRewardMessenger(address(messenger));
        _detach();
        _reattach();
        _rep().closeDay(1);
        assertEq(messenger.lastSendArity(), 9, "the B4 shape");
        assertEq(messenger.lastSendCustodyEra(), 2, "carrying the live era");
        messenger.setB4Unsupported(true);
        _rep().closeDay(2);
        assertEq(messenger.lastSendArity(), 8, "downgraded to B3 on a messenger without B4");
    }

    /// @dev The era rule for a packet's fresh: a retired, unfinalized era BOOKS it
    ///      to its row — counted as delivered and levelled at once, so the live
    ///      baseline gains no headroom — and a demotion takes it back from there.
    function test_AFreshCreditForARetiredEra_IsBookedToItsRow_AndADemotionTakesItBack() public {
        activateRewardCustodyForTest(address(vpfi), 0);
        bytes32 h = _untypedDelivery(5e18, 43, keccak256("route-0")); // era 0's packet
        _detach();
        _reattach(); // era 2 live; eras 0 and 1 retired, neither final
        (uint256 receivedBefore, uint256 paidBefore) = _ledger();
        uint256 liveBefore = _live();
        uint256 attributedBefore = _attributed();
        (uint256 toLive, uint256 toRestitution) =
            _mut().creditFreshToEraFromRowRaw(uint8(LibVaipakam.RewardCustodyRow.Unclassified), 4e18, 0);
        assertEq(toLive + toRestitution, 0, "nothing reached the live baseline");
        assertEq(_live(), liveBefore);
        assertEq(_era().getCustodyEra(0).holderRow, 4e18, "booked to era 0's row");
        (uint256 received, uint256 paid) = _ledger();
        assertEq(received - receivedBefore, 4e18, "counted as delivered");
        assertEq(paid - paidBefore, 4e18, "and levelled at once");
        assertEq(_attributed(), attributedBefore, "an in-holder move");
        // A demotion follows the DEMOTABLE credit's recorded booking (#2459 r4) —
        // the packet's compensation-shaped credit, booked to the same retired row —
        // and takes it back from there; the classification above records none.
        _bookPacket(h, 4e18);
        assertEq(_era().getCustodyEra(0).holderRow, 8e18, "fixture-live: the packet's credit is in the row too");
        (receivedBefore, paidBefore) = _ledger();
        assertEq(_mut().uncreditFreshForPacketRaw(h, 3e18), 3e18, "the demotion takes back from the era's row");
        assertEq(_era().getCustodyEra(0).holderRow, 5e18);
        (received, paid) = _ledger();
        assertEq(receivedBefore - received, 3e18, "both sides unwound by what it took");
        assertEq(paidBefore - paid, 3e18);
        // Straddle: the LIVE era's packet credit reaches the live baseline under the split.
        (toLive, toRestitution) =
            _mut().creditFreshToEraFromRowRaw(uint8(LibVaipakam.RewardCustodyRow.Unclassified), 1e18, 2);
        assertEq(toLive + toRestitution, 1e18, "the live era: the live baseline");
    }

    /// @dev A FINAL era's late value goes where its release went: the live baseline
    ///      while a role is active, pending surplus while Detached.
    function test_AFreshCreditForAFinalEra_GoesWhereItsReleaseWent() public {
        activateRewardCustodyForTest(address(vpfi), 0);
        _untypedDelivery(5e18, 44, keccak256("route-f"));
        _detach(); // era 1 live, Detached
        _closeEra0Days();
        _era().finalizeCustodyEra(0);
        uint256 pendingBefore = _row(LibVaipakam.RewardCustodyRow.PendingSurplus);
        _mut().creditFreshToEraFromRowRaw(uint8(LibVaipakam.RewardCustodyRow.Unclassified), 2e18, 0);
        assertEq(_row(LibVaipakam.RewardCustodyRow.PendingSurplus) - pendingBefore, 2e18, "Detached: pending surplus");
        assertEq(_era().getCustodyEra(0).holderRow, 0, "never back into a final era's row");
        _reattach();
        uint256 liveBefore = _live();
        (uint256 toLive, uint256 toRestitution) =
            _mut().creditFreshToEraFromRowRaw(uint8(LibVaipakam.RewardCustodyRow.Unclassified), 1e18, 0);
        assertEq(toLive + toRestitution, 1e18, "active: the live baseline under the split");
        assertEq(_live() - liveBefore, toLive);
    }

    // ─── #2459 r4 — a demotion follows the credit's recorded booking ───

    event IngressPacketCreditBooked(bytes32 indexed packetHash, uint8 booking, uint64 indexed era, uint256 amount);

    function _pending() internal view returns (uint256) { return _row(LibVaipakam.RewardCustodyRow.PendingSurplus); }

    /// @dev Book `amount` of packet `h`'s fresh as the compensation credit does: the
    ///      tokens at the Diamond, then the credit with its booking recorded.
    function _bookPacket(bytes32 h, uint256 amount) internal {
        vpfi.mint(address(diamond), amount);
        _mut().relocatePacketFreshRaw(h, amount);
    }

    /// @dev Unrelated live custody: a live-era delivery classified into the live baseline.
    function _seedLive(uint256 amount, uint256 remitId, bytes32 id) internal {
        _untypedDelivery(amount, remitId, id);
        _mut().creditFreshToEraFromRowRaw(
            uint8(LibVaipakam.RewardCustodyRow.Unclassified), amount, _era().getCustodyEraCurrent()
        );
    }

    /// @dev Codex #2459 r4, the scenario as found, through the real ingress: a
    ///      PROVISIONAL compensation for a retired era's day is booked to that era's
    ///      row; the era is finalized while Detached (its row → pending surplus); the
    ///      chain reattaches; the delayed broadcast demotes the credit. The demotion
    ///      follows the recorded booking and release into pending surplus, and the
    ///      unrelated live custody is untouched — derived from the role it found
    ///      (active), the demotion took the live rows instead.
    function test_ADemotion_AfterADetachedFinalizationAndAReattach_TakesFromPendingSurplus() public {
        activateRewardCustodyForTest(address(vpfi), 0);
        _detach();
        _reattach(); // era 2 live; day 3 is era 0's, retired and not final
        bytes32 id = keccak256("comp-r4");
        bytes32 h = keccak256(abi.encode(uint256(CHAIN_BASE), id));
        vpfi.mint(address(diamond), 5e18);
        vm.expectEmit(true, true, false, true, address(diamond));
        emit IngressPacketCreditBooked(h, 1, 0, 5e18);
        RewardIngressFacet(address(diamond)).onCompensationBudgetReceived(
            address(vpfi), 5e18, 3, CHAIN_BASE, 31, REMITTER_BF, 2.5e18, 2.5e18, uint64(block.timestamp), 1,
            uint64(7 days), uint64(24 hours), id
        );
        assertEq(_era().getCustodyEra(0).holderRow, 5e18, "booked to era 0's row, provisionally");
        _detach();
        _closeEra0Days();
        _era().finalizeCustodyEra(0);
        LibVaipakam.CustodyEra memory e0 = _era().getCustodyEra(0);
        assertTrue(e0.releasedToPending, "the release is recorded: to pending surplus");
        assertEq(e0.released, 5e18, "with what it carried");
        assertEq(_pending(), 5e18, "fixture-live: the credit sits in pending surplus");
        _reattach(); // an active role again
        _seedLive(3e18, 32, keccak256("unrelated-live"));
        uint256 liveBefore = _live();
        assertEq(liveBefore, 3e18, "fixture-live: unrelated live custody to take wrongly");
        uint256 unclassifiedBefore = _row(LibVaipakam.RewardCustodyRow.Unclassified);
        vm.prank(address(diamond)); // the broadcast hook is Diamond-internal
        RewardIngressFacet(address(diamond)).onCompensationDayBroadcastArrived(3, address(0xDD), false); // demote
        assertEq(_pending(), 0, "taken from pending surplus, where the credit is");
        assertEq(_live(), liveBefore, "the unrelated live custody is untouched");
        assertEq(_row(LibVaipakam.RewardCustodyRow.Unclassified) - unclassifiedBefore, 5e18, "the whole credit returned");
        assertEq(_era().getCustodyEra(0).releaseDemoted, 5e18, "the release is charged with what was followed out");
    }

    /// @dev Pending surplus is drained, by anyone, into the live baseline — so what
    ///      pending no longer holds of a credit is followed there: pending first, then
    ///      the live baseline the drain credited. (The role-derived route took the live
    ///      rows alone and left the credit's own pending part behind.)
    function test_ADemotion_FollowsADrainedPendingSurplus_IntoTheLiveBaseline() public {
        activateRewardCustodyForTest(address(vpfi), 0);
        bytes32 h = _untypedDelivery(1e18, 41, keccak256("b-0")); // era 0's packet
        _detach(); // era 1 live, Detached; era 0 retired
        _bookPacket(h, 4e18); // to era 0's row
        _closeEra0Days();
        _era().finalizeCustodyEra(0); // Detached: into pending surplus
        _reattach();
        _era().drainPendingSurplus(3e18); // 3 of the 4 move on into the live baseline
        assertEq(_pending(), 1e18);
        assertEq(_live(), 3e18, "fixture-live: the drain credited the live baseline");
        assertEq(_mut().uncreditFreshForPacketRaw(h, 4e18), 4e18, "the whole credit is still at the address");
        assertEq(_pending(), 0, "pending surplus first");
        assertEq(_live(), 0, "then the live baseline the drain credited");
    }

    /// @dev A demotion through a release never takes more than the release CARRIED:
    ///      what was drawn from the era's row before it paid the era's obligations and
    ///      is no longer at the address — while pending surplus holds another packet's
    ///      value that the demotion must not take (straddle: that packet's own
    ///      demotion takes it whole). (The role-derived route took 4 from pending.)
    function test_ADemotion_ThroughARelease_NeverTakesMoreThanTheReleaseCarried() public {
        activateRewardCustodyForTest(address(vpfi), 0);
        bytes32 h = _untypedDelivery(1e18, 51, keccak256("c-0"));
        bytes32 h2 = _untypedDelivery(1e18, 52, keccak256("c-1"));
        _detach(); // era 0 retired; Detached
        _bookPacket(h, 4e18); // era 0's row: 4
        vm.prank(address(diamond));
        _era().eraDrawForDay(0, 2, 3e18); // 3 of it DRAWN for a day of the era
        _closeEra0Days();
        _era().finalizeCustodyEra(0);
        assertEq(_era().getCustodyEra(0).released, 1e18, "the release carried what the draw left");
        _bookPacket(h2, 5e18); // another packet's late credit for the final era, Detached: pending surplus
        assertEq(_pending(), 6e18, "fixture-live: pending holds more than the release carried");
        assertEq(_mut().uncreditFreshForPacketRaw(h, 4e18), 1e18, "only what the release carried");
        assertEq(_pending(), 5e18, "the other packet's surplus is untouched");
        assertEq(_era().getCustodyEra(0).releaseDemoted, 1e18, "the release is charged");
        assertEq(_mut().uncreditFreshForPacketRaw(h, 1e18), 0, "and never followed out twice");
        assertEq(_mut().uncreditFreshForPacketRaw(h2, 5e18), 5e18, "a pending booking takes its own");
    }

    /// @dev A FINAL era's credit on an active role is booked to the LIVE era's books;
    ///      when that era retires, its live row — the credit — is carried into its
    ///      row, and the demotion follows it there. (The role-derived route read the
    ///      packet's final era while Detached and took pending surplus instead.)
    function test_ADemotion_FollowsALiveBooking_IntoTheRowItsEraRetiredInto() public {
        activateRewardCustodyForTest(address(vpfi), 0);
        bytes32 h = _untypedDelivery(1e18, 61, keccak256("d-0")); // era 0's packet
        bytes32 h3 = _untypedDelivery(1e18, 62, keccak256("d-1")); // another of era 0's
        _detach();
        _closeEra0Days();
        _era().finalizeCustodyEra(0); // era 0 final, Detached
        _reattach(); // era 2 live, active
        vpfi.mint(address(diamond), 4e18);
        vm.expectEmit(true, true, false, true, address(diamond));
        emit IngressPacketCreditBooked(h, 1, 2, 4e18);
        _mut().relocatePacketFreshRaw(h, 4e18); // booked to the LIVE era's books: era 2
        assertEq(_live(), 4e18);
        _detach(); // era 2 retires, carrying its live row into its own
        assertEq(_era().getCustodyEra(2).holderRow, 4e18, "fixture-live: the credit was carried");
        _bookPacket(h3, 2e18); // pending surplus the role-derived route would take
        assertEq(_pending(), 2e18);
        assertEq(_mut().uncreditFreshForPacketRaw(h, 4e18), 4e18);
        assertEq(_era().getCustodyEra(2).holderRow, 0, "taken back from the row its era retired into");
        assertEq(_pending(), 2e18, "pending surplus untouched");
    }

    /// @dev An ACTIVE finalization records the era its release went into, and a
    ///      demotion follows it there — into that era's row once it retires in turn.
    function test_ADemotion_FollowsAnActiveRelease_IntoTheEraItWentInto() public {
        activateRewardCustodyForTest(address(vpfi), 0);
        bytes32 h = _untypedDelivery(1e18, 71, keccak256("e-0"));
        bytes32 h3 = _untypedDelivery(1e18, 72, keccak256("e-1"));
        _detach();
        _reattach(); // era 2 live, active; era 0 retired
        _bookPacket(h, 4e18); // era 0's row
        _closeEra0Days();
        _era().finalizeCustodyEra(0); // active: into era 2's live baseline
        LibVaipakam.CustodyEra memory e0 = _era().getCustodyEra(0);
        assertFalse(e0.releasedToPending);
        assertEq(e0.releasedInto, 2, "recorded: into the live era at the release");
        _detach(); // era 2 retires, carrying the release into its row
        _bookPacket(h3, 2e18); // pending surplus the role-derived route would take
        assertEq(_mut().uncreditFreshForPacketRaw(h, 4e18), 4e18);
        assertEq(_era().getCustodyEra(2).holderRow, 0, "followed into era 2's row");
        assertEq(_pending(), 2e18, "pending surplus untouched");
    }

    // ─── PR C-4: the parked-message lane ───

    /// @dev Rotate the canonical deployment this mirror reports to (allowed only
    ///      while Detached), which retires every era-less wire; then reattach.
    ///      Also makes this contract the reward messenger so it can deliver.
    function _rotateDeployment() internal {
        _rep().setBaseRewardDeployment(address(0xA11CE));
        _detach();
        _rep().setBaseRewardDeployment(address(0xB0B));
        _reattach();
        _rep().setRewardMessenger(address(this));
    }

    function _parkKind2(uint256 day) internal returns (uint256 id) {
        uint256 before = _era().getCustodyEraParkedOpen(_era().getCustodyEraCurrent());
        _rep().onRewardBroadcastReceived(day, 10e18, 5e18, type(uint256).max, 1e18, 0, 0);
        id = 1;
        while (_era().getParkedBroadcast(id + 1).receivedAt != 0) ++id;
        assertEq(_era().getCustodyEraParkedOpen(_era().getCustodyEraCurrent()) - before, 1, "fixture: parked once");
    }

    /// @dev A legacy kind-2 broadcast after a rotation is PARKED — recorded, counted
    ///      against the live era, no day state installed — not reverted; a retry is
    ///      refused by name while the gate holds; the operator tombstones it.
    function test_ALegacyBroadcastAfterRotation_IsParked_RetryRefused_ThenTombstoned() public {
        activateRewardCustodyForTest(address(vpfi), 1e18);
        _rotateDeployment();
        uint64 live = _era().getCustodyEraCurrent();
        uint256 id = _parkKind2(3);
        LibVaipakam.ParkedBroadcast memory pb = _era().getParkedBroadcast(id);
        assertEq(pb.kind, 2);
        assertEq(pb.status, 0, "parked");
        assertEq(pb.dayId, 3);
        assertEq(pb.custodyEraAtReceipt, live, "counted against the live era");
        assertTrue(pb.quarantineOnly, "received after era 0: tombstone-only");
        assertGt(pb.receivedAt, 0);
        (, , bool isSet) = _rep().getKnownGlobalInterestNumeraire18(3);
        assertFalse(isSet, "no day state was installed");

        vm.expectRevert(abi.encodeWithSelector(ParkedBroadcastQuarantineOnly.selector, id));
        _rep().retryParkedBroadcastV1(id, 3, 10e18, 5e18, type(uint256).max, 1e18, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(ParkedBroadcastDigestMismatch.selector, id));
        _rep().retryParkedBroadcastV1(id, 3, 11e18, 5e18, type(uint256).max, 1e18, 0, 0);

        _era().tombstoneParkedBroadcast(id, bytes32("retired-era-broadcast"));
        assertEq(_era().getParkedBroadcast(id).status, 1, "tombstoned");
        assertEq(_era().getCustodyEraParkedOpen(live), 0, "the era's open count fell");
        vm.expectRevert(abi.encodeWithSelector(ParkedBroadcastNotParked.selector, id, uint8(1)));
        _era().tombstoneParkedBroadcast(id, bytes32("again"));
        vm.expectRevert(abi.encodeWithSelector(ParkedBroadcastUnknown.selector, id + 1));
        _era().tombstoneParkedBroadcast(id + 1, bytes32("none"));
    }

    /// @dev #1566 PR 1 review (P3) — a retryable kind-2 entry whose day has since landed by another
    ///      route retires as APPLIED when the copy carries the same consensus (the kind-5 retry's
    ///      replay always did), and is refused, staying parked, when it diverges.
    function test_AParkedV1Entry_WhoseDayLandedIdentically_RetiresAsApplied() public {
        _rotateDeployment(); // before activation: no era opens, so the entry is era 0's and retryable
        activateRewardCustodyForTest(address(vpfi), 1e18);
        uint256 id = _parkKind2(3);
        assertFalse(_era().getParkedBroadcast(id).quarantineOnly, "fixture-live: a retryable entry");
        _mut().setDayCapThreshold18(3, type(uint256).max);
        _mut().setKnownGlobalDailyInterest(3, 11e18, 5e18, true); // landed DIVERGENT
        vm.expectRevert(KnownGlobalAlreadySet.selector);
        _rep().retryParkedBroadcastV1(id, 3, 10e18, 5e18, type(uint256).max, 1e18, 0, 0);
        assertEq(_era().getParkedBroadcast(id).status, 0, "a divergent copy stays parked");
        _mut().setKnownGlobalDailyInterest(3, 10e18, 5e18, true); // landed IDENTICAL
        uint64 era = _era().getParkedBroadcast(id).custodyEraAtReceipt;
        uint256 openBefore = _era().getCustodyEraParkedOpen(era);
        _rep().retryParkedBroadcastV1(id, 3, 10e18, 5e18, type(uint256).max, 1e18, 0, 0);
        assertEq(_era().getParkedBroadcast(id).status, 2, "a moot copy retires as applied");
        assertEq(_era().getCustodyEraParkedOpen(era), openBefore - 1, "and leaves its era's open count");
    }

    /// @dev #1566 PR C revision — an era's finality does not wait on a broadcast
    ///      parked in it (a parked copy of a closed day's broadcast installs nothing
    ///      that prices an obligation), nor on its tombstone.
    function test_Finalize_DoesNotWaitOnAParkedBroadcast() public {
        activateRewardCustodyForTest(address(vpfi), 1e18);
        _rotateDeployment();
        uint64 era = _era().getCustodyEraCurrent();
        _parkKind2(4);
        _detach(); // the era with the parked entry is retired
        assertEq(_era().getCustodyEraParkedOpen(era), 1, "fixture-live: the entry stands parked");
        (uint256 released, ) = _era().finalizeCustodyEra(era);
        assertEq(released, 0, "that era carried no custody; it finalizes clean");
        assertTrue(_era().getCustodyEra(era).terminal);
    }

    /// @dev The kind-5 wire parks the same way, with its own digest.
    function test_ALegacyV2BroadcastAfterRotation_IsParked() public {
        activateRewardCustodyForTest(address(vpfi), 1e18);
        _rotateDeployment();
        RewardBroadcastV2 memory b;
        b.dayId = 5;
        b.globalLenderNumeraire18 = 10e18;
        b.globalBorrowerNumeraire18 = 5e18;
        b.destChainId = block.chainid;
        uint256 before = _era().getParkedBroadcast(1).receivedAt == 0 ? 0 : 1;
        _rep().onRewardBroadcastV2Received(b);
        uint256 id = before + 1;
        LibVaipakam.ParkedBroadcast memory pb = _era().getParkedBroadcast(id);
        assertEq(pb.kind, 5);
        assertEq(pb.dayId, 5);
        assertEq(pb.digest, keccak256(abi.encode(uint8(5), b)), "the broadcast's digest");
        vm.expectRevert(abi.encodeWithSelector(ParkedBroadcastQuarantineOnly.selector, id));
        _rep().retryParkedBroadcastV2(id, b);
    }

    // ─── PR C-2: the era term of a day's fresh ───

    /// @dev An obligation accrued in a retired era is paid from that era's row —
    ///      drawn into the live row for the payout — and the live bound is charged
    ///      nothing: the era delivered it before.
    function test_AClaimOnAnOldEraDay_DrawsTheEraRow_NotTheLiveBound() public {
        _scene(1, NEED);
        _retireIntoEraZero(7e18);
        (uint256 receivedBefore, uint256 paidBefore) = _ledger();
        uint256 aliceBefore = vpfi.balanceOf(alice);
        uint256 attributedBefore = _attributed();

        vm.expectEmit(true, true, false, true, address(diamond));
        emit CustodyEraDrawn(0, 1, NEED);
        assertEq(_claim(), NEED, "paid in full from the retired era");

        assertEq(vpfi.balanceOf(alice) - aliceBefore, NEED, "delivered");
        assertEq(_era().getCustodyEra(0).holderRow, 7e18 - NEED, "era 0 fell by the draw");
        assertEq(_era().getCustodyEraRowsTotal(), 7e18 - NEED);
        assertEq(_live(), 0, "the live row only passed it through");
        (uint256 received, uint256 paid) = _ledger();
        assertEq(received, receivedBefore, "received untouched");
        assertEq(paid, paidBefore, "the delivered bound is NOT charged for era-funded fresh");
        assertEq(attributedBefore - _attributed(), NEED, "attributed custody fell by exactly the payout");
    }

    /// @dev An obligation on a day AFTER the boundary belongs to the live era, whose
    ///      custody is the live row: with no live headroom it defers, and the retired
    ///      era's row is not touched; fund the live row and it pays.
    function test_AnObligationAfterTheBoundary_CannotDrawTheRetiredEra() public {
        _retireIntoEraZero(7e18);
        uint64 boundary = _era().getCustodyEra(2).boundaryDay;
        vm.warp(block.timestamp + 1 days); // the boundary day has passed: claimable
        // Every day before the boundary is an ordinary armed day with no entry
        // of the claimant's: the side cursor advances only through stamped,
        // finalized days, and it must reach the boundary day to price it.
        for (uint256 g = 1; g < boundary; ++g) _armedDay(g, NEED);
        _scene(boundary, NEED);
        // No live headroom and no retired era for this day: the claim DEFERS,
        // which with nothing else moving surfaces as the empty-claim revert.
        vm.prank(alice);
        vm.expectRevert(IVaipakamErrors.NoInteractionRewardsToClaim.selector);
        RewardClaimFacet(address(diamond)).claimInteractionRewards();
        assertEq(_era().getCustodyEra(0).holderRow, 7e18, "era 0 untouched");
        fundRewardPoolForTest(address(vpfi), 1e18);
        assertEq(_claim(), NEED, "funded live: pays");
        assertEq(_era().getCustodyEra(0).holderRow, 7e18, "still untouched");
    }

    /// @dev A forfeited old-era entry is swept into the bucket as ERA-funded: the
    ///      era row funds it, the bucket grows, the delivered bound is not charged,
    ///      and the absorption is counted apart.
    function test_AForfeitedOldEraEntry_IsAbsorbedAsEraFunded() public {
        uint256 id = _scene(1, NEED);
        _retireIntoEraZero(7e18);
        _mut().setRewardEntryForfeitedRaw(id);
        _mut().setLoanActiveLenderEntryId(LOAN, id); // the sweep enumerates the loan's active entries
        (, uint256 paidBefore) = _ledger();
        uint256 bucketBefore = ConfigFacet(address(diamond)).getRecycleBucket();
        uint256 swept = InteractionRewardsFacet(address(diamond)).sweepForfeitedInteractionRewards(LOAN);
        assertGt(swept, 0, "swept");
        assertEq(ConfigFacet(address(diamond)).getRecycleBucket() - bucketBefore, swept, "the bucket grew by the sweep");
        assertEq(7e18 - _era().getCustodyEra(0).holderRow, swept, "era 0 funded it");
        (, uint256 paid) = _ledger();
        assertEq(paid, paidBefore, "no live bound charge for era-funded absorption");
        assertEq(_live(), 0, "the live row only passed it through");
    }
}

/// @title  RewardCustodyFirstRoleTest
/// @notice #1566 PR 1 review (P2-2) — a FIRST configuration (Unconfigured → Mirror) opens no era
///         but still LEVELS the delivered residual: deliveries received while unconfigured raised
///         `received` and nothing charged `paid` in that role, so the first role must not inherit
///         the gap as headroom. Its own contract, because the era suite's setUp configures the role.
contract RewardCustodyFirstRoleTest is SetupTest {
    function test_AFirstConfiguration_LevelsTheResidual_OpensNoEra() public {
        setupHelper();
        TestMutatorFacet(address(diamond)).setArmedFreshLedgerRaw(3e18, 1e18);
        vm.chainId(42161);
        RewardReporterFacet(address(diamond)).setBaseChainId(8453); // Unconfigured -> Mirror
        (uint256 received, uint256 paid) = RewardCustodyFacet(address(diamond)).armedFreshLedger();
        assertEq(received, 3e18, "fixture-live: the unconfigured chain received");
        assertEq(paid, 3e18, "the first role inherits no delivered headroom");
        assertEq(RewardEraFacet(address(diamond)).getCustodyEraCurrent(), 0, "no era opened");
    }
}
