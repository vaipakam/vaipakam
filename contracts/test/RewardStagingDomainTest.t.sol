// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {RewardEpochViewFacet} from "../src/facets/RewardEpochViewFacet.sol";
import {RewardIngressFacet} from "../src/facets/RewardIngressFacet.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardStagingFacet} from "../src/facets/RewardStagingFacet.sol";
import {RewardStagingSettleFacet} from "../src/facets/RewardStagingSettleFacet.sol";
import {RewardStagingDomainFacet} from "../src/facets/RewardStagingDomainFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
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

    /// @dev A one-chunk claim is unchanged: it pays its days directly.
    function test_AOneChunkClaim_PaysDirectly() public {
        _longScene(30);
        _liveFresh(13e18);
        assertEq(_claim(), 30 * NEED, "paid in one call, no domain");
        (uint8 phase, , , , ) = _dom();
        assertEq(phase, uint8(LibVaipakam.DomainPhase.None));
    }
}
