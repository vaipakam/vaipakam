// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {RewardEpochViewFacet} from "../src/facets/RewardEpochViewFacet.sol";
import {RewardEpochFacet} from "../src/facets/RewardEpochFacet.sol";
import {RewardIngressFacet} from "../src/facets/RewardIngressFacet.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardStagingFacet} from "../src/facets/RewardStagingFacet.sol";
import {RewardStagingSettleFacet} from "../src/facets/RewardStagingSettleFacet.sol";
import {RewardStagingDomainFacet} from "../src/facets/RewardStagingDomainFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {Vm} from "forge-std/Vm.sol";

/// @title RewardStagingDomainTest
/// @notice 3b-ii-A2-ii (#2305) — a claim whose pending armed days exceed one
///         settlement chunk decides as a DOMAIN: prepared day by day and paid
///         nothing until every day of its extent is reserved; then resolved in
///         day order; or unwound past its deadline, on the claimant's cancel,
///         or on a stale commitment.
contract RewardStagingDomainTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    address internal alice;
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    address internal constant REMITTER = address(0xBA5E);
    uint256 internal constant SEED = 1_000_000 ether;
    uint64 internal constant LOAN = 77;
    uint256 internal constant NEED = 0.4e18;
    uint32 internal constant DAYS = 40; // > MAX_INTERACTION_CLAIM_DAYS (30): two chunks

    event StagingDomainOpened(bytes32 indexed domainKey, address indexed user, uint8 side, uint64 firstDay, uint64 lastDay, uint256 chunks);
    event StagingDomainReserveStopped(bytes32 indexed domainKey, uint64 day);
    event StagingDomainCleared(bytes32 indexed domainKey, bool paid);
    event StagingRecordStale(bytes32 indexed key, uint256 indexed entryId);

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
        alice = makeAddr("domain-alice");
    }

    // ───────────────────────── fixtures ─────────────────────────

    function _view() internal view returns (RewardEpochViewFacet) { return RewardEpochViewFacet(address(diamond)); }
    function _staging() internal view returns (RewardStagingFacet) { return RewardStagingFacet(address(diamond)); }
    function _settle() internal view returns (RewardStagingSettleFacet) { return RewardStagingSettleFacet(address(diamond)); }
    function _domain() internal view returns (RewardStagingDomainFacet) { return RewardStagingDomainFacet(address(diamond)); }
    function _ingress() internal view returns (RewardIngressFacet) { return RewardIngressFacet(address(diamond)); }
    function _mut() internal view returns (TestMutatorFacet) { return TestMutatorFacet(address(diamond)); }

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

    function _one(uint256 d) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = d;
    }

    /// @dev Live fresh in custody plus a delivered ledger that can pay it.
    function _liveFresh(uint256 amount) internal {
        // One receipt per amount: the ingress refuses a repeated receipt id.
        _ingress().onRewardBudgetReceived(
            address(vpfi), amount, _one(1), CHAIN_BASE, 1000 + amount / 1e17, REMITTER, 0, amount, keccak256(abi.encode("live", amount)), true
        );
        _mut().setArmedFreshLedgerRaw(amount, 0);
    }

    /// @dev `days_` armed days from day 1, one lender entry over all of them.
    function _longScene(uint32 days_) internal returns (uint256 id) {
        for (uint256 d = 1; d <= days_; ++d) _armedDay(d, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(days_);
        id = _mut().pushRewardEntry(alice, LOAN, LibVaipakam.RewardSide.Lender, 1e18, 1);
        _mut().closeRewardEntryRaw(id, days_ + 1);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
    }

    function _claim() internal returns (uint256 paid) {
        vm.prank(alice);
        (paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewards();
    }

    function _dk() internal view returns (bytes32) {
        return keccak256(abi.encode(alice, LibVaipakam.RewardSide.Lender));
    }

    function _key(uint256 d) internal view returns (bytes32) {
        return keccak256(abi.encode(alice, LibVaipakam.RewardSide.Lender, d));
    }

    function _dom() internal view returns (uint8 phase, uint64 preparedThrough, uint64 lastDay, uint32 live, uint64 deadline) {
        (, phase, , lastDay, preparedThrough, , , , live, , deadline, , ) = _domain().getStagingDomain(alice, LibVaipakam.RewardSide.Lender);
    }

    function _reserveAll() internal returns (uint256 calls) {
        while (!_domain().reserveDomainPage(_dk())) { ++calls; if (calls > 64) fail(); }
        ++calls;
    }

    function _resolveAll() internal {
        uint256 n;
        while (!_domain().resolveDomainPage(_dk())) { if (++n > 128) fail(); }
    }

    // ───────────────────────── cells ─────────────────────────

    /// @dev A claim over more days than one chunk pays NOTHING and prepares:
    ///      one day record per day, up to a chunk per call, the preparation
    ///      cursor carrying over; once the extent is prepared the claim has
    ///      nothing further to do and reports an empty claim.
    function test_AMultiChunkClaim_PreparesADomain_AndPaysNothing() public {
        _longScene(DAYS);
        _liveFresh(20e18);
        vm.expectEmit(true, true, false, true, address(diamond));
        emit StagingDomainOpened(_dk(), alice, uint8(LibVaipakam.RewardSide.Lender), 1, DAYS, 2);
        assertEq(_claim(), 0, "nothing paid: the side is a domain");
        (uint8 phase, uint64 prepared, uint64 last, uint32 live, uint64 deadline) = _dom();
        assertEq(phase, uint8(LibVaipakam.DomainPhase.Staging));
        assertEq(prepared, 30, "one chunk of days prepared");
        assertEq(last, DAYS);
        assertEq(live, 30, "a record per prepared day");
        assertEq(_view().getStagingRecord(_key(1)).phase, uint8(LibVaipakam.StagingPhase.Staging));
        assertEq(_view().getStagingRecord(_key(30)).phase, uint8(LibVaipakam.StagingPhase.Staging));
        assertEq(_view().getStagingRecord(_key(31)).phase, uint8(LibVaipakam.StagingPhase.None), "not yet");
        assertGt(deadline, block.timestamp + 2 days, "two chunks' cadences plus the grace");
        assertEq(_claim(), 0, "the second call prepares the rest");
        (, prepared, , live, ) = _dom();
        assertEq(prepared, DAYS); assertEq(live, DAYS);
        vm.prank(alice);
        (bool ok, ) = address(diamond).call(abi.encodeWithSelector(RewardClaimFacet.claimInteractionRewards.selector));
        assertFalse(ok, "prepared: the claim has nothing to do until the domain settles");
        assertEq(vpfi.balanceOf(alice), 0, "and still nothing paid");
    }

    /// @dev The domain reserves day by day, pays nothing until every day is
    ///      reserved, then resolves in day order and clears; the claimant
    ///      receives every day's reward exactly once.
    function test_TheDomain_ReservesEveryDay_ThenResolvesInOrder_AndClears() public {
        _longScene(DAYS);
        _liveFresh(20e18);
        _claim(); _claim();
        uint256 before = vpfi.balanceOf(alice);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.StagingDomainPhaseInvalid.selector, _dk(), uint8(LibVaipakam.DomainPhase.Staging)));
        _domain().resolveDomainPage(_dk()); // not before every day is reserved
        _reserveAll();
        (uint8 phase, , , , ) = _dom();
        assertEq(phase, uint8(LibVaipakam.DomainPhase.Resolving), "every day reserved: irrevocable");
        assertEq(vpfi.balanceOf(alice), before, "and still nothing paid");
        assertEq(_view().getStagingRecord(_key(DAYS)).phase, uint8(LibVaipakam.StagingPhase.Reserved));
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.StagingRecordInDomain.selector, _key(1), _dk()));
        _settle().resolveStagedDayPage(_key(1)); // a domain record resolves through the domain
        _resolveAll();
        assertEq(vpfi.balanceOf(alice) - before, uint256(DAYS) * NEED, "every day paid, once");
        uint32 live;
        (phase, , , live, ) = _dom();
        assertEq(phase, uint8(LibVaipakam.DomainPhase.None), "cleared");
        assertEq(live, 0);
        assertEq(_view().getStagingRecord(_key(1)).phase, uint8(LibVaipakam.StagingPhase.None));
        assertEq(_view().getStagingRecord(_key(DAYS)).phase, uint8(LibVaipakam.StagingPhase.None));
    }

    /// @dev #1566 PR 1 re-review (B-N4) — a domain day record whose day list GREW past
    ///      what it tracks after it was staged: the domain's reserve refuses an
    ///      unsettled scan, the permissionless preparation (the only way to settle it)
    ///      then passes more pending epochs than the record tracks — and before, every
    ///      reserve page reverted `StagingPendingOverflow` for good (a domain record is
    ///      not unwound alone; the domain's unwind would reopen and overflow again).
    ///      It now RESERVES ON WHAT IT HOLDS: its passed pending epochs stay theirs,
    ///      the live sources bear the day, and every day is paid once.
    function test_AnOverflowingDayRecord_ReservesOnWhatItHolds_TheDomainSettles() public {
        _longScene(DAYS);
        _liveFresh(20e18);
        _claim(); _claim(); // the domain is prepared: a record per day, staged from the claim's plan
        for (uint256 i; i < 140; ++i) { // then day 1's list grows: untyped, unattested, pending
            vm.warp(vm.getBlockTimestamp() + 10);
            bytes32 pid = keccak256(abi.encode("domain-pending", i));
            _ingress().onRewardBudgetReceived(address(vpfi), 1e12, _one(1), CHAIN_BASE, 900 + i, REMITTER, 0, 0, pid, false);
            RewardEpochFacet(address(diamond)).materializeTransportBatchPage(
                keccak256(abi.encode(uint256(CHAIN_BASE), pid)), _one(1)
            );
        }
        // The domain cannot reserve day 1 on an unsettled scan; the permissionless
        // preparation settles it — and passes more pending epochs than it tracks.
        for (uint256 k; k < 8 && !_view().getStagingRecord(_key(1)).pendingOverflow; ++k) {
            _staging().prepareStagedDay(_key(1));
        }
        assertTrue(
            _view().getStagingRecord(_key(1)).pendingOverflow,
            "fixture-live: day 1's record passed more pending epochs than it tracks"
        );
        uint256 before = vpfi.balanceOf(alice);
        _reserveAll();
        _resolveAll();
        assertEq(vpfi.balanceOf(alice) - before, uint256(DAYS) * NEED, "every day paid, once");
    }

    /// @dev A day the live sources cannot bear STOPS the reservation cursor:
    ///      the days before stand reserved, nothing is paid, and more funding
    ///      lets the cursor continue to resolution.
    function test_AShortDay_StopsTheDomainInReserving_WithNothingPaid() public {
        _longScene(DAYS);
        _liveFresh(5e18); // 12 days' worth of 0.4
        _claim(); _claim();
        uint256 before = vpfi.balanceOf(alice);
        uint256 calls;
        bool done;
        while (!done && calls < 64) {
            ++calls;
            (bool ok, bytes memory ret) = address(diamond).call(abi.encodeWithSelector(RewardStagingDomainFacet.reserveDomainPage.selector, _dk()));
            assertTrue(ok);
            done = abi.decode(ret, (bool));
            (, , , , uint64 dl) = _dom();
            dl;
            if (_view().getStagingRecord(_key(13)).phase == uint8(LibVaipakam.StagingPhase.Staging) && _view().getStagingRecord(_key(12)).phase == uint8(LibVaipakam.StagingPhase.Reserved)) break;
        }
        (uint8 phase, , , , ) = _dom();
        assertEq(phase, uint8(LibVaipakam.DomainPhase.Reserving), "stopped in reserving");
        assertEq(_view().getStagingRecord(_key(12)).phase, uint8(LibVaipakam.StagingPhase.Reserved), "the days before stand reserved");
        assertEq(_view().getStagingRecord(_key(13)).phase, uint8(LibVaipakam.StagingPhase.Staging), "the short day waits");
        assertEq(vpfi.balanceOf(alice), before, "nothing paid while a day is short");
        _liveFresh(20e18);
        _reserveAll();
        _resolveAll();
        assertEq(vpfi.balanceOf(alice) - before, uint256(DAYS) * NEED, "funded: every day paid");
    }

    /// @dev A lifecycle change after the commit — the entry's window closed
    ///      before the extent's end — makes the records past it stale: the
    ///      revalidation at the reservation finds one and the whole domain
    ///      unwinds, anyone completing it, nothing paid.
    function test_ALifecycleChangeAfterCommit_SendsTheDomainToUnwind() public {
        uint256 id = _longScene(DAYS);
        _liveFresh(20e18);
        _claim(); _claim();
        _mut().closeRewardEntryRaw(id, 10); // closed before the extent's end: days 10.. are no longer the entry's
        // The revalidation is PAGED (a bounded number of days per call): the
        // stale record at day 10 is met on the second page.
        bytes32 staleTopic = keccak256("StagingRecordStale(bytes32,uint256)");
        bool announced;
        uint8 phase;
        for (uint256 k; k < 8 && phase != uint8(LibVaipakam.DomainPhase.Unwinding); ++k) {
            vm.recordLogs();
            assertFalse(_domain().reserveDomainPage(_dk()), "never reaches resolving");
            Vm.Log[] memory logs = vm.getRecordedLogs();
            for (uint256 i; i < logs.length; ++i) {
                if (logs[i].topics[0] == staleTopic && logs[i].topics[1] == _key(10)) announced = true;
            }
            (phase, , , , ) = _dom();
        }
        assertTrue(announced, "the first record past the shortened window is announced stale");
        assertEq(phase, uint8(LibVaipakam.DomainPhase.Unwinding), "stale: the domain unwinds");
        address anyone = makeAddr("anyone");
        uint256 n;
        bool done;
        while (!done) { vm.prank(anyone); done = _domain().unwindDomainPage(_dk()); if (++n > 128) fail(); }
        uint32 live;
        (phase, , , live, ) = _dom();
        assertEq(phase, uint8(LibVaipakam.DomainPhase.None), "cleared");
        assertEq(live, 0);
        assertEq(vpfi.balanceOf(alice), 0, "nothing paid");
        assertEq(_view().getStagingRecord(_key(5)).phase, uint8(LibVaipakam.StagingPhase.None), "every record gone");
    }

    /// @dev #1566 PR 1 review (P2-1) — EVERY lifecycle change is revalidated, not only the first.
    ///      An ordinary change (another of the claimant's entries closes; nothing in the domain
    ///      goes stale) passes a full revalidation, re-anchors, and the reservation proceeds; a
    ///      LATER change that does stale a record must still unwind the domain. Before the fix the
    ///      finished pass re-anchored on the second change without walking, and the domain went on
    ///      to Resolving with a stale record.
    function test_ASecondLifecycleChange_IsRevalidatedToo() public {
        uint256 id = _longScene(DAYS);
        _liveFresh(20e18);
        _claim(); _claim();
        uint256 other = _mut().pushRewardEntry(alice, LOAN + 1, LibVaipakam.RewardSide.Lender, 1e18, 1);
        _mut().closeRewardEntryRaw(other, 2); // an ordinary change: nothing in the domain goes stale
        uint8 phase;
        for (uint256 k; k < 16 && _view().getStagingRecord(_key(1)).phase != uint8(LibVaipakam.StagingPhase.Reserved); ++k) {
            _domain().reserveDomainPage(_dk());
        }
        (phase, , , , ) = _dom();
        assertEq(phase, uint8(LibVaipakam.DomainPhase.Reserving), "fixture-live: the first pass finished, reservation began");
        assertEq(_view().getStagingRecord(_key(1)).phase, uint8(LibVaipakam.StagingPhase.Reserved));
        _mut().closeRewardEntryRaw(id, 10); // the second change stales the record at day 10
        for (uint256 k; k < 16 && phase != uint8(LibVaipakam.DomainPhase.Unwinding); ++k) {
            _domain().reserveDomainPage(_dk());
            (phase, , , , ) = _dom();
            assertTrue(phase != uint8(LibVaipakam.DomainPhase.Resolving), "never resolves on a stale record");
        }
        assertEq(phase, uint8(LibVaipakam.DomainPhase.Unwinding), "the second change unwinds the domain");
    }

    /// @dev Past the domain's deadline anyone unwinds it across calls; before
    ///      it only the claimant may; a domain record's own unwind entry is
    ///      refused; and once cleared the claimant's next claim opens a fresh
    ///      domain.
    function test_TheDeadline_LetsAnyoneUnwind_AndTheExtentClears() public {
        _longScene(DAYS);
        _liveFresh(20e18);
        _claim(); _claim();
        (, , , , uint64 deadline) = _dom();
        address anyone = makeAddr("anyone");
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.StagingDomainNotExpired.selector, _dk(), deadline));
        _domain().unwindDomainPage(_dk());
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.StagingRecordInDomain.selector, _key(1), _dk()));
        _settle().unwindStagedDayPage(_key(1));
        vm.warp(uint256(deadline) + 1);
        uint256 n;
        bool done;
        while (!done) { vm.prank(anyone); done = _domain().unwindDomainPage(_dk()); if (++n > 128) fail(); }
        assertGt(n, 1, "across calls");
        (uint8 phase, , , uint32 live, ) = _dom();
        assertEq(phase, uint8(LibVaipakam.DomainPhase.None)); assertEq(live, 0);
        assertEq(_claim(), 0, "the next claim opens a fresh domain");
        (phase, , , live, ) = _dom();
        assertEq(phase, uint8(LibVaipakam.DomainPhase.Staging)); assertEq(live, 30);
    }

    /// @dev #1566 PR 1 review (P2-6) — a day no epoch lists has nothing to scan, so its record adds
    ///      no page to the domain's lease; a listed day's record still adds its page. The deadline
    ///      is the opening, one cadence per chunk, ONE page for the one listed day, and the grace.
    ///      (Every record used to add at least one cadence: here 40 days for 40 days, and a 300-day
    ///      live-only extent held the domain's encumbrance for 300.)
    function test_UnlistedDays_AddNoLease_AListedDayAddsItsPage() public {
        _longScene(DAYS);
        _liveFresh(20e18);
        // An attested epoch lists day 3 alone: that day's record has a page to scan.
        bytes32 pid = keccak256("domain-lease-epoch");
        _ingress().onRewardBudgetReceived(address(vpfi), 0.1e18, _one(3), CHAIN_BASE, 77, REMITTER, 0, 0, pid, false);
        RewardEpochFacet(address(diamond)).materializeTransportBatchPage(keccak256(abi.encode(uint256(CHAIN_BASE), pid)), _one(3));
        _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, 77, 0.1e18, 0);
        uint256 t0 = block.timestamp;
        _claim();
        _claim();
        (, uint64 prepared, , uint32 live, uint64 deadline) = _dom();
        assertEq(prepared, DAYS, "fixture-live: the whole extent prepared");
        assertEq(live, DAYS, "fixture-live: a record per day");
        assertEq(deadline, t0 + 2 days + 1 days + 3 days, "two chunks, one listed day's page, the grace: nothing per unlisted day");
    }

    /// @dev #1566 PR 1 review (P3) — a claim's explicit venue binds the DOMAIN: Alice has a vault, so
    ///      her default is the vault; she claims to her WALLET, and every day of the domain pays the
    ///      wallet. No day record announces a venue of its own (the payout reads the domain's).
    function test_AClaimsNamedVenue_BindsTheDomain_AndEveryDayPaysThere() public {
        _longScene(DAYS);
        _liveFresh(20e18);
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(alice);
        vm.prank(alice);
        RewardClaimFacet(address(diamond)).claimInteractionRewardsTo(LibVaipakam.RewardDelivery.Wallet);
        vm.prank(alice);
        RewardClaimFacet(address(diamond)).claimInteractionRewardsTo(LibVaipakam.RewardDelivery.Wallet);
        (, uint64 prepared, , , ) = _dom();
        assertEq(prepared, DAYS, "fixture-live: the whole extent prepared");
        assertFalse(_view().getStagingRecord(_key(1)).venueSet, "a domain record binds no venue of its own");
        uint256 walletBefore = vpfi.balanceOf(alice);
        uint256 vaultBefore = vpfi.balanceOf(vault);
        _reserveAll();
        _resolveAll();
        assertEq(vpfi.balanceOf(alice) - walletBefore, uint256(DAYS) * NEED, "every day paid to the wallet the claim named");
        assertEq(vpfi.balanceOf(vault), vaultBefore, "not to the vault the default would have chosen");
    }

    /// @dev Two entries with a gap between them: [1, 11) and [31, 41) — one 40-day extent whose
    ///      days 11..30 hold no domain record.
    function _gapScene() internal {
        for (uint256 d = 1; d <= DAYS; ++d) _armedDay(d, NEED);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(10);
        uint256 a = _mut().pushRewardEntry(alice, LOAN, LibVaipakam.RewardSide.Lender, 1e18, 1);
        _mut().closeRewardEntryRaw(a, 11);
        _mut().setFeeEntitlementRaw(
            LOAN + 1,
            LibVaipakam.FeeEntitlement({
                borrowerMode: LibVaipakam.FeeEntitlementMode.None,
                lenderMode: LibVaipakam.FeeEntitlementMode.None,
                openDays: 10,
                rewardHaircutBpsAtOpen: 0,
                borrowerTariffPaid: 0,
                lenderTariffPaid: 0,
                cStarOpen: 0,
                loanSideRewardCapOpen: type(uint128).max
            })
        );
        uint256 b = _mut().pushRewardEntry(alice, LOAN + 1, LibVaipakam.RewardSide.Lender, 1e18, 31);
        _mut().closeRewardEntryRaw(b, 41);
        _mut().setArmedFreshLedgerRaw(0, 0);
        _mut().userClaimFundingNeedRaw(alice);
        _liveFresh(20e18);
        _claim();
        _claim();
        (, uint64 prepared, uint64 last, uint32 live, ) = _dom();
        assertEq(last, DAYS, "fixture-live: one extent over the gap");
        assertEq(prepared, DAYS);
        assertEq(live, 20, "fixture-live: a record per covered day, none on the gap");
        // A sweep's record of an entry outside the snapshot, on a gap day.
        _mut().plantForeignStagingRecordRaw(alice, uint8(LibVaipakam.RewardSide.Lender), 20);
    }

    /// @dev #1566 PR 1 review (P3) — a foreign record on a gap day of the extent is not the domain's:
    ///      the reservation and the resolution walk past it, the domain pays its own days and clears,
    ///      and the foreign record is left exactly as it stood.
    function test_AForeignRecordOnAGapDay_IsWalkedPast_ReserveAndResolve() public {
        _gapScene();
        uint256 before = vpfi.balanceOf(alice);
        _reserveAll();
        _resolveAll();
        assertEq(vpfi.balanceOf(alice) - before, 20 * NEED, "the domain's own days, paid once");
        (uint8 phase, , , , ) = _dom();
        assertEq(phase, uint8(LibVaipakam.DomainPhase.None), "cleared");
        assertEq(_view().getStagingRecord(_key(20)).phase, uint8(LibVaipakam.StagingPhase.Staging), "the foreign record untouched");
    }

    /// @dev …and the claimant's unwind walks past it too.
    function test_AForeignRecordOnAGapDay_IsWalkedPast_Unwind() public {
        _gapScene();
        uint256 n;
        bool done;
        while (!done) { vm.prank(alice); done = _domain().unwindDomainPage(_dk()); if (++n > 128) fail(); }
        (uint8 phase, , , uint32 live, ) = _dom();
        assertEq(phase, uint8(LibVaipakam.DomainPhase.None), "cleared");
        assertEq(live, 0);
        assertEq(_view().getStagingRecord(_key(20)).phase, uint8(LibVaipakam.StagingPhase.Staging), "the foreign record untouched");
    }

    /// @dev An attested, fully fresh epoch listing day `d` alone.
    function _attestedEpochOn(uint256 d, uint256 remitId) internal {
        bytes32 pid = keccak256(abi.encode("domain-epoch", d, remitId));
        _ingress().onRewardBudgetReceived(address(vpfi), 0.1e18, _one(d), CHAIN_BASE, remitId, REMITTER, 0, 0, pid, false);
        RewardEpochFacet(address(diamond)).materializeTransportBatchPage(keccak256(abi.encode(uint256(CHAIN_BASE), pid)), _one(d));
        _ingress().onRemitSplitAttested(CHAIN_BASE, REMITTER, remitId, 0.1e18, 0);
    }

    function _resolveCursor() internal view returns (uint64 c) {
        (, , , , , , c, , , , , , ) = _domain().getStagingDomain(alice, LibVaipakam.RewardSide.Lender);
    }

    /// @dev #1566 PR 1 review (P3) — a resolution call's WORK is bounded: a record that walks batches
    ///      ends the call (its pages already run up to a page of batches), while batch-less days ride
    ///      along. Days 2, 3 and 4 each hold an epoch's batch: the first call resolves day 1 (live
    ///      only) and day 2, and stops; the domain still resolves whole across calls.
    function test_AResolutionCall_StopsAfterOneBatchBearingRecord() public {
        _longScene(DAYS);
        _attestedEpochOn(2, 101);
        _attestedEpochOn(3, 102);
        _attestedEpochOn(4, 103);
        _liveFresh(20e18);
        _claim();
        _claim();
        for (uint256 d = 2; d <= 4; ++d) _staging().prepareStagedDay(_key(d));
        assertGt(_view().getStagingRecord(_key(2)).batchCount, 0, "fixture-live: day 2 holds a batch");
        uint256 before = vpfi.balanceOf(alice);
        _reserveAll();
        assertFalse(_domain().resolveDomainPage(_dk()));
        assertEq(_resolveCursor(), 3, "day 1 rode along; day 2's batches were the call's budget");
        _resolveAll();
        assertEq(vpfi.balanceOf(alice) - before, uint256(DAYS) * NEED, "every day paid, once");
    }

    /// @dev A one-chunk claim is unchanged: it pays its days directly.
    function test_AOneChunkClaim_PaysDirectly() public {
        _longScene(30);
        _liveFresh(13e18);
        assertEq(_claim(), 30 * NEED, "paid in one call, no domain");
        (uint8 phase, , , , ) = _dom();
        assertEq(phase, uint8(LibVaipakam.DomainPhase.None));
    }
}
